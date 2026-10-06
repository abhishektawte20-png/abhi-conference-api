import { analyzeSheet, extractCompanies, normalizeWebsite } from './lib/mapping.js';
import { evaluateCompany, matchCompany, scrubTagged } from './lib/match.js';
import { eventIdFromUrl, findRtsTab, rtsApi } from './lib/rts-client.js';

const $ = (id) => document.getElementById(id);
const BATCH = 10;
const CONCURRENCY = 2;

let workbook = null;
let rows = [];
let companies = [];
let stopRequested = false;
let scrub = [];
let taggedTotal = 0;
let evaluation = null;

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
  $('rtsSection').hidden = false;
  detectEventId();
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
  persist();
};

const summary = () => {
  const n = (s) => companies.filter((c) => c.status === s).length;
  const qa = (v) => companies.filter((c) => c.qa?.verdict === v).length;
  return `${n('given')} given · ${n('found')} found · ${n('low')} need review · ${n('none')} not found · ${n('error')} errors · QA: ${qa('verified')} verified, ${qa('review')} review`;
};

function renderResults() {
  $('results').innerHTML =
    '<tr><th>Company</th><th>Website</th><th>Status</th><th>QA</th><th>RTS</th></tr>' +
    companies
      .map(
        (c, i) =>
          `<tr><td>${esc(c.name)}<br><small>${esc(c.country)}</small></td>` +
          `<td><input data-i="${i}" value="${esc(c.website)}"></td>` +
          `<td class="${c.status}" title="${esc(c.reason)}">${c.status}${c.status === 'found' || c.status === 'low' ? ` ${Math.round(c.confidence * 100)}%` : ''}</td>` +
          `<td class="${c.qa?.verdict ?? ''}" title="${esc(c.qa?.reasons.join('; ') ?? '')}">${esc(c.qa?.verdict ?? '')}</td>` +
          `<td class="${c.rts?.status ?? ''}" title="${esc(rtsTitle(c.rts))}">${c.rts ? `${c.rts.status.replace('_', ' ')}${c.rts.entityName ? `: ${esc(c.rts.entityName)}` : ''}` : ''}</td></tr>`,
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

// ---- RTS (read-only) ----
async function detectEventId() {
  if ($('eventId').value) return;
  const tab = await findRtsTab();
  if (tab) $('eventId').value = eventIdFromUrl(tab.url);
}

async function connect() {
  const eventId = $('eventId').value.trim();
  const tab = await findRtsTab();
  if (!tab) throw new Error('Open the event page in RTS in this browser first.');
  if (!/^\d+$/.test(eventId)) throw new Error('Enter the numeric conference event ID.');
  return { eventId, api: rtsApi(tab.id, eventId) };
}

const rtsTitle = (r) => (r ? `${r.reasons?.join('; ') ?? ''}${r.score ? ` (score ${r.score})` : ''}` : '');
const rtsStatus = (msg) => ($('rtsStatus').textContent = msg);

$('scrub').onclick = async () => {
  try {
    const { api } = await connect();
    rtsStatus('Reading the event\'s tagged list…');
    const tagged = await api.allTagged();
    taggedTotal = tagged.totalCount;
    scrub = scrubTagged(tagged.entries, companies);
    renderRtsSummary();
    rtsStatus(`Scrubbed ${scrub.length} tagged entities.`);
    persist();
  } catch (err) {
    rtsStatus(err.message);
  }
};

$('stopRts').onclick = () => (stopRequested = true);

$('match').onclick = async () => {
  try {
    const { api } = await connect();
    rtsStatus('Reading the event\'s tagged list…');
    const tagged = (await api.allTagged()).entries;
    const todo = companies.filter((c) => !c.rts && c.name);
    stopRequested = false;
    $('match').disabled = true;
    $('stopRts').hidden = false;
    let done = 0;
    const queue = [...todo];
    const worker = async () => {
      while (queue.length && !stopRequested) {
        const c = queue.shift();
        try {
          c.rts = await matchCompany(c, tagged, api);
        } catch (err) {
          rtsStatus(err.message);
          stopRequested = true; // an RTS error (logged out, rate limit) should stop the run, not mislabel companies
          return;
        }
        rtsStatus(`Matched ${++done} of ${todo.length}…`);
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    renderResults();
    renderRtsSummary();
    persist();
  } catch (err) {
    rtsStatus(err.message);
  } finally {
    $('match').disabled = false;
    $('stopRts').hidden = true;
  }
};

// Phase 0: compare matching through the tagged list vs through search, on an event that is already tagged.
$('evalRun').onclick = async () => {
  try {
    const { eventId, api } = await connect();
    rtsStatus('Reading the event\'s tagged list…');
    const tagged = await api.allTagged();
    const todo = companies.filter((c) => c.name);
    const rows = [];
    stopRequested = false;
    $('stopRts').hidden = false;
    const queue = [...todo];
    const worker = async () => {
      while (queue.length && !stopRequested) {
        const c = queue.shift();
        try {
          rows.push({ name: c.name, country: c.country, website: c.website, sourceSheet: c.source, enrichStatus: c.status, qaVerdict: c.qa?.verdict ?? '', ...(await evaluateCompany(c, tagged.entries, api)) });
        } catch (err) {
          rtsStatus(err.message);
          stopRequested = true;
          return;
        }
        rtsStatus(`Evaluated ${rows.length} of ${todo.length}…`);
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    $('stopRts').hidden = true;
    evaluation = {
      version: 1,
      kind: 'phase0-evaluation',
      eventId,
      completed: !stopRequested,
      tagged: tagged.entries.map(({ attendeeEntityId, formalName, nameVariations, url, exhibitor, sponsor }) => ({ attendeeEntityId, formalName, nameVariations, url, exhibitor, sponsor })),
      companies: rows,
    };
    rtsStatus(`Evaluation ${evaluation.completed ? 'finished' : 'stopped early'}: ${rows.length} companies. Export it and run eval/report.mjs.`);
  } catch (err) {
    rtsStatus(err.message);
  }
};
$('evalExport').onclick = () => {
  if (!evaluation) return rtsStatus('Run the evaluation first.');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([JSON.stringify(evaluation, null, 2)], { type: 'application/json' })),
    download: `eval-event-${evaluation.eventId}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
};

function renderRtsSummary() {
  const n = (s) => companies.filter((c) => c.rts?.status === s).length;
  const k = (s) => scrub.filter((x) => x.status === s).length;
  const rows = [
    ['Source companies', companies.length],
    ['Already tagged in RTS', n('already_tagged')],
    ['Safe to tag (domain + name agree)', n('tag')],
    ['Needs your review', n('review')],
    ['No RTS profile found (activity log)', n('create_log')],
    ['Not matched yet', companies.filter((c) => !c.rts).length],
  ];
  if (scrub.length) rows.push([`Tagged in RTS (${taggedTotal}): still in source`, k('still_listed')], ['…verify manually', k('verify')], ['…not in source list', k('not_in_source')]);
  $('rtsSummary').innerHTML = rows.map(([label, v]) => `<tr><td>${label}</td><td>${v}</td></tr>`).join('');
}

// ---- cache: the last run is kept in the browser and can be exported / re-imported as JSON ----
const snapshot = () => ({ version: 1, savedAt: new Date().toISOString(), eventId: $('eventId').value.trim(), taggedTotal, companies, scrub });

function persist() {
  chrome.storage.local.set({ lastSession: snapshot() });
}

function restore(data) {
  if (data?.version !== 1) return;
  companies = data.companies;
  scrub = data.scrub ?? [];
  taggedTotal = data.taggedTotal ?? 0;
  $('eventId').value = data.eventId ?? '';
  $('resultsSection').hidden = false;
  $('rtsSection').hidden = false;
  renderResults();
  renderRtsSummary();
}

chrome.storage.local.get('lastSession').then(({ lastSession }) => lastSession && restore(lastSession));

$('saveCache').onclick = () => {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' })),
    download: `exhibitor-tagger-event-${$('eventId').value || 'unknown'}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
};
$('loadCache').onchange = async (e) => {
  const file = e.target.files[0];
  if (file) restore(JSON.parse(await file.text()));
};

// ---- export ----
$('export').onclick = () => {
  const head = ['Company', 'Country', 'Website', 'Status', 'Confidence', 'Reason', 'QA verdict', 'QA score', 'QA notes', 'RTS status', 'RTS entity', 'RTS entity ID', 'RTS score', 'Source'];
  const csv = [head, ...companies.map((c) => [c.name, c.country, c.website, c.status, c.confidence.toFixed(2), c.reason, c.qa?.verdict ?? '', c.qa?.score ?? '', c.qa?.reasons.join('; ') ?? '', c.rts?.status ?? '', c.rts?.entityName ?? '', c.rts?.entityId ?? '', c.rts?.score ?? '', c.source])]
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
