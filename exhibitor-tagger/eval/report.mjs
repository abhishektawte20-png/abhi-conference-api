// Phase 0 report: how accurate is the matcher, measured on an event that is already tagged?
//
//   node eval/report.mjs eval-event-11957.json [--labels labeled.csv] [--out eval/out]
//
// Input is the JSON from the side panel's "Export evaluation JSON". It holds PitchBook data: keep it
// local (eval/data and eval/out are git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubTagged } from '../extension/lib/match.js';

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');

// Wilson 95% interval, so small samples are not over-read.
function wilson(k, n) {
  if (!n) return 'n/a';
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return `${(100 * p).toFixed(1)}% (95% CI ${(100 * Math.max(0, c - h)).toFixed(0)}-${(100 * Math.min(1, c + h)).toFixed(0)}%, n=${n})`;
}

// Deterministic 50/50 split by company name, so thresholds are only ever tuned on one half.
export function half(name) {
  let h = 2166136261;
  for (const ch of String(name).toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 2 === 0 ? 'tune' : 'heldout';
}

/** Compare the two routes for one company. */
export function classOf({ viaTagged: t, viaSearch: s }) {
  if (t.tier === 'match' && s.tier === 'match') return t.id === s.id ? 'confirmed' : 'conflict';
  if (t.tier === 'match') return 'search_miss';
  if (s.tier === 'match') return t.tier === 'review' ? 'tag_vs_review' : 'new_tag_candidate';
  if (t.tier === 'review' || s.tier === 'review') return 'review_only';
  return 'no_candidate';
}

const CLASSES = ['confirmed', 'conflict', 'search_miss', 'new_tag_candidate', 'tag_vs_review', 'review_only', 'no_candidate'];
const MEANING = {
  confirmed: 'both routes agree on the same RTS entity (strongest evidence of a correct match)',
  conflict: 'both routes say "match" but name different entities: at least one is WRONG',
  search_miss: 'the event already has this entity tagged, but search did not reach "match" (lost recall)',
  new_tag_candidate: 'search says "match" for an entity the event does NOT have: the only rows that would be auto-tagged. Needs human labels',
  tag_vs_review: 'search says match, tagged list only says review',
  review_only: 'neither route reached match; would go to human review',
  no_candidate: 'nothing found by either route; would become create_log',
};

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
export const toCsv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const keyOf = (c) => `${c.name}|${c.viaSearch.id ?? ''}`;

export function buildReport(data, labels = new Map()) {
  const rows = data.companies.map((c) => ({ ...c, cls: classOf(c), hasWebsite: !!c.website, half: half(c.name) }));
  const count = (list, cls) => list.filter((r) => r.cls === cls).length;
  const groups = {
    all: rows,
    'with website': rows.filter((r) => r.hasWebsite),
    'no website': rows.filter((r) => !r.hasWebsite),
    'tune half': rows.filter((r) => r.half === 'tune'),
    'held-out half': rows.filter((r) => r.half === 'heldout'),
  };

  const md = [];
  md.push(`# Phase 0 accuracy report: event ${data.eventId}`, '');
  if (!data.completed) md.push('> **The evaluation run was stopped early. Numbers cover only the companies processed.**', '');
  md.push(`Source companies: **${rows.length}** (${groups['with website'].length} with a website, ${groups['no website'].length} without). RTS tagged entities: **${data.tagged.length}**.`, '');
  md.push('Thresholds in this run are the defaults and have NOT been tuned. Any tuning must use the "tune half" only and be reported on the "held-out half".', '');

  md.push('## Outcome classes', '', `| Class | ${Object.keys(groups).join(' | ')} | Meaning |`, `|---|${Object.keys(groups).map(() => '---:').join('|')}|---|`);
  for (const cls of CLASSES) md.push(`| ${cls} | ${Object.values(groups).map((g) => count(g, cls)).join(' | ')} | ${MEANING[cls]} |`);

  md.push('', '## Key rates', '', '"Known" = companies where the tagged-list route reached match (so the event demonstrably has that entity). This ground truth shares the matcher\'s own name/domain logic, so treat it as a consistency check, not as proof.', '');
  md.push('| Group | Known entities | Search route recall (confirmed / known) | Conflict rate | Search-miss rate |', '|---|---:|---|---|---|');
  for (const [name, g] of Object.entries(groups)) {
    const known = g.filter((r) => r.viaTagged.tier === 'match');
    md.push(`| ${name} | ${known.length} | ${wilson(count(known, 'confirmed'), known.length)} | ${wilson(count(known, 'conflict'), known.length)} | ${wilson(count(known, 'search_miss'), known.length)} |`);
  }

  // Reverse direction: is every tagged entity traceable to a source company?
  const scrub = scrubTagged(data.tagged, rows.map((r) => ({ name: r.name, website: r.website })));
  const sc = (s) => scrub.filter((x) => x.status === s).length;
  md.push('', '## Tagged list vs source list (scrub)', '', `Still listed: **${sc('still_listed')}**, verify manually: **${sc('verify')}**, not in source: **${sc('not_in_source')}** of ${scrub.length}.`,
    'Entities "not in source" are either withdrawn exhibitors, names the source spells very differently, or tagged from another source.');

  // Enrichment effect.
  md.push('', '## Effect of website enrichment', '', `| Enrichment status | QA | ${CLASSES.join(' | ')} |`, `|---|---|${CLASSES.map(() => '---:').join('|')}|`);
  const combos = [...new Set(rows.map((r) => `${r.enrichStatus || '(none)'}|${r.qaVerdict || '-'}`))].sort();
  for (const combo of combos) {
    const [st, qa] = combo.split('|');
    const g = rows.filter((r) => `${r.enrichStatus || '(none)'}|${r.qaVerdict || '-'}` === combo);
    md.push(`| ${st} | ${qa} | ${CLASSES.map((c) => count(g, c)).join(' | ')} |`);
  }

  // Human labels.
  const labelled = rows.filter((r) => ['new_tag_candidate', 'conflict'].includes(r.cls) && labels.has(keyOf(r)));
  md.push('', '## Precision from human labels', '');
  if (!labels.size) md.push('No labels provided yet. Fill `human_label` (correct / incorrect) in `label_sample.csv` and re-run with `--labels`.');
  else {
    for (const cls of ['new_tag_candidate', 'conflict']) {
      const l = labelled.filter((r) => r.cls === cls);
      const ok = l.filter((r) => labels.get(keyOf(r)) === 'correct').length;
      md.push(`- **${cls}**: ${wilson(ok, l.length)} judged correct (search route's chosen entity).`);
    }
  }

  // Worst misses: wrong-looking matches first, then confident new-tag candidates, then lost recall.
  const worst = [
    ...rows.filter((r) => r.cls === 'conflict'),
    ...rows.filter((r) => r.cls === 'new_tag_candidate').sort((a, b) => b.viaSearch.score - a.viaSearch.score),
    ...rows.filter((r) => r.cls === 'search_miss'),
  ].slice(0, 10);
  md.push('', '## 10 worst cases', '', '| # | Company | Class | Search chose | Tagged list chose | Why |', '|---|---|---|---|---|---|');
  worst.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.cls} | ${r.viaSearch.name || '-'} (${r.viaSearch.tier}) | ${r.viaTagged.name || '-'} (${r.viaTagged.tier}) | ${[...r.viaSearch.reasons, ...r.viaTagged.reasons].join('; ')} |`));

  const disagreements = rows
    .filter((r) => !['confirmed', 'no_candidate'].includes(r.cls))
    .map((r) => ({ company: r.name, country: r.country, website: r.website, class: r.cls, search_entity: r.viaSearch.name, search_id: r.viaSearch.id, search_tier: r.viaSearch.tier, search_score: r.viaSearch.score, tagged_entity: r.viaTagged.name, tagged_id: r.viaTagged.id, tagged_tier: r.viaTagged.tier, reasons: [...r.viaSearch.reasons, ...r.viaTagged.reasons].join('; ') }));

  const labelSample = rows
    .filter((r) => ['new_tag_candidate', 'conflict'].includes(r.cls))
    .map((r) => ({ key: keyOf(r), company: r.name, website: r.website, class: r.cls, search_entity: r.viaSearch.name, search_url: '', search_id: r.viaSearch.id, human_label: '' }));

  return { markdown: md.join('\n'), disagreements, labelSample, rows };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const file = args.find((a) => !a.startsWith('--') && a !== opt('--labels') && a !== opt('--out'));
  if (!file) {
    console.error('usage: node eval/report.mjs <evaluation.json> [--labels labeled.csv] [--out dir]');
    process.exit(1);
  }
  const labels = new Map();
  if (opt('--labels')) for (const r of parseCsv(fs.readFileSync(opt('--labels'), 'utf8'))) if (r.human_label) labels.set(r.key, r.human_label.trim().toLowerCase());
  const out = opt('--out') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
  fs.mkdirSync(out, { recursive: true });
  const r = buildReport(JSON.parse(fs.readFileSync(file, 'utf8')), labels);
  fs.writeFileSync(path.join(out, 'report.md'), r.markdown);
  fs.writeFileSync(path.join(out, 'disagreements.csv'), toCsv(r.disagreements, Object.keys(r.disagreements[0] ?? { company: 1 })));
  fs.writeFileSync(path.join(out, 'label_sample.csv'), toCsv(r.labelSample, ['key', 'company', 'website', 'class', 'search_entity', 'search_url', 'search_id', 'human_label']));
  console.log(r.markdown);
  console.log(`\nWrote report.md, disagreements.csv, label_sample.csv to ${out}`);
}
