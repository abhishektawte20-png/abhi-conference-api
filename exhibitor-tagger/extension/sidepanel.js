import { analyzeSheet, extractCompanies, normalizeWebsite } from './lib/mapping.js';

const $ = (id) => document.getElementById(id);
const BATCH = 10;
const CONCURRENCY = 2;

let workbook = null;
let rows = [];
let companies = [];
let stopRequested = false;

// ---- settings ----
chrome.storage.local.get(['proxyUrl', 'proxyToken']).then(({ proxyUrl, proxyToken }) => {
  $('proxyUrl').value = proxyUrl || 'http://localhost:8787';
  $('proxyToken').value = proxyToken || '';
});
$('saveSettings').onclick = async () => {
  await chrome.storage.local.set({ proxyUrl: $('proxyUrl').value.trim().replace(/\/$/, ''), proxyToken: $('proxyToken').value });
  $('settings').open = false;
};

// ---- upload ----
$('file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  $('sheet').innerHTML = workbook.SheetNames.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join('');
  $('sheetRow').hidden = workbook.SheetNames.length < 2;
  loadSheet();
};
$('sheet').onchange = loadSheet;

function loadSheet() {
  const name = workbook.SheetNames[$('sheet').value || 0];
  rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', raw: false });
  const { startRow, columns, guess } = analyzeSheet(rows);

  $('startRow').value = startRow + 1;
  const opts = (none) =>
    (none ? '<option value="-1">(none)</option>' : '') +
    columns.map((c) => `<option value="${c.index}">${colLabel(c.index)}${c.header ? ` – ${esc(c.header)}` : ''}: ${esc(c.sample)}</option>`).join('');
  for (const [key, optional] of [['Name', false], ['Website', true], ['Country', true], ['Description', true]]) {
    $(`map${key}`).innerHTML = opts(optional);
    $(`map${key}`).value = String(guess[key.toLowerCase()]);
  }
  $('mapSection').hidden = false;
  $('resultsSection').hidden = true;
  renderPreview();
}

for (const id of ['startRow', 'mapName', 'mapWebsite', 'mapCountry', 'mapDescription']) $(id).onchange = renderPreview;

const currentMap = () => ({
  startRow: Math.max(0, Number($('startRow').value) - 1),
  map: {
    name: Number($('mapName').value),
    website: Number($('mapWebsite').value),
    country: Number($('mapCountry').value),
    description: Number($('mapDescription').value),
  },
});

function renderPreview() {
  const sample = extractCompanies(rows, currentMap(), 'preview').slice(0, 4);
  $('preview').innerHTML =
    '<tr><th>Name</th><th>Country</th><th>Website</th></tr>' +
    sample.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.country)}</td><td>${esc(c.website)}</td></tr>`).join('');
}

$('load').onclick = () => {
  const sheetName = workbook.SheetNames[$('sheet').value || 0];
  companies = extractCompanies(rows, currentMap(), sheetName).map((c) => ({ ...c, status: c.website ? 'given' : 'pending', confidence: c.website ? 1 : 0, reason: '' }));
  $('resultsSection').hidden = false;
  renderResults();
};

// ---- enrich ----
$('stop').onclick = () => (stopRequested = true);

$('enrich').onclick = async () => {
  const { proxyUrl, proxyToken } = await chrome.storage.local.get(['proxyUrl', 'proxyToken']);
  if (!proxyUrl || !proxyToken) {
    $('settings').open = true;
    return setStatus('Set the proxy URL and token first.');
  }
  const todo = companies.filter((c) => !c.website && c.status !== 'none');
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

  stopRequested = false;
  $('enrich').disabled = true;
  $('stop').hidden = false;
  let done = 0;
  const worker = async () => {
    while (batches.length && !stopRequested) {
      const batch = batches.shift();
      try {
        const res = await fetch(`${proxyUrl}/enrich`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Proxy-Token': proxyToken },
          body: JSON.stringify({ companies: batch.map(({ id, name, country, description }) => ({ id, name, country, description })) }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        for (const r of (await res.json()).results) Object.assign(companies.find((c) => c.id === r.id), r);
      } catch (err) {
        for (const c of batch) Object.assign(c, { status: 'error', reason: err.message });
      }
      done += batch.length;
      setStatus(`Enriched ${done} of ${todo.length}…`);
      renderResults();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  $('enrich').disabled = false;
  $('stop').hidden = true;
  setStatus(stopRequested ? `Stopped at ${done} of ${todo.length}.` : `Done. ${summary()}`);
};

const summary = () => {
  const n = (s) => companies.filter((c) => c.status === s).length;
  const qa = (v) => companies.filter((c) => c.qa?.verdict === v).length;
  return `${n('given')} given · ${n('found')} found · ${n('low')} need review · ${n('none')} not found · ${n('error')} errors · QA: ${qa('verified')} verified, ${qa('review')} review`;
};

function renderResults() {
  $('results').innerHTML =
    '<tr><th>Company</th><th>Website</th><th>Status</th><th>QA</th></tr>' +
    companies
      .map(
        (c, i) =>
          `<tr><td>${esc(c.name)}<br><small>${esc(c.country)}</small></td>` +
          `<td><input data-i="${i}" value="${esc(c.website)}"></td>` +
          `<td class="${c.status}" title="${esc(c.reason)}">${c.status}${c.status === 'found' || c.status === 'low' ? ` ${Math.round(c.confidence * 100)}%` : ''}</td>` +
          `<td class="${c.qa?.verdict ?? ''}" title="${esc(c.qa?.reasons.join('; ') ?? '')}">${esc(c.qa?.verdict ?? '')}</td></tr>`,
      )
      .join('');
  $('results').querySelectorAll('input').forEach((input) => {
    input.onchange = () => {
      const c = companies[input.dataset.i];
      c.website = normalizeWebsite(input.value) || input.value.trim();
      c.status = c.website ? 'given' : 'pending';
      c.confidence = c.website ? 1 : 0;
      renderResults();
    };
  });
  setStatus(summary());
}

// ---- export ----
$('export').onclick = () => {
  const head = ['Company', 'Country', 'Website', 'Status', 'Confidence', 'Reason', 'QA verdict', 'QA score', 'QA notes', 'Source'];
  const csv = [head, ...companies.map((c) => [c.name, c.country, c.website, c.status, c.confidence.toFixed(2), c.reason, c.qa?.verdict ?? '', c.qa?.score ?? '', c.qa?.reasons.join('; ') ?? '', c.source])]
    .map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })),
    download: 'exhibitors-enriched.csv',
  });
  a.click();
  URL.revokeObjectURL(a.href);
};

// ---- helpers ----
function setStatus(msg) {
  $('status').textContent = msg;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function colLabel(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
