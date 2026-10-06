import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, classOf, half, parseCsv, toCsv } from './report.mjs';

const side = (tier, id = null, name = '', score = 0.9) => ({ tier, id, name, score, reasons: [tier] });
const co = (name, t, s, extra = {}) => ({ name, country: '', website: 'https://x.com', enrichStatus: 'given', qaVerdict: '', viaTagged: t, viaSearch: { ...s, searches: 2 }, ...extra });
const none = side('none');

test('classOf covers every combination', () => {
  assert.equal(classOf(co('a', side('match', 1), side('match', 1))), 'confirmed');
  assert.equal(classOf(co('a', side('match', 1), side('match', 2))), 'conflict');
  assert.equal(classOf(co('a', side('match', 1), side('review', 1))), 'search_miss');
  assert.equal(classOf(co('a', side('match', 1), none)), 'search_miss');
  assert.equal(classOf(co('a', none, side('match', 3))), 'new_tag_candidate');
  assert.equal(classOf(co('a', side('review', 3), side('match', 3))), 'tag_vs_review');
  assert.equal(classOf(co('a', none, side('review', 3))), 'review_only');
  assert.equal(classOf(co('a', none, none)), 'no_candidate');
});

test('half() is deterministic and roughly balanced', () => {
  assert.equal(half('Acme'), half('acme'));
  const names = Array.from({ length: 400 }, (_, i) => `Company ${i}`);
  const tune = names.filter((n) => half(n) === 'tune').length;
  assert.ok(tune > 150 && tune < 250, `tune=${tune}`);
});

const data = {
  eventId: '1', completed: true,
  tagged: [{ attendeeEntityId: 1, formalName: 'Alpha', nameVariations: [], url: 'alpha.com' }, { attendeeEntityId: 9, formalName: 'Ghost', nameVariations: [], url: 'ghost.io' }],
  companies: [
    co('Alpha', side('match', 1, 'Alpha'), side('match', 1, 'Alpha'), { website: 'https://alpha.com' }),
    co('Beta', side('match', 2, 'Beta'), side('match', 7, 'Beta Other')),
    co('Gamma', side('match', 3, 'Gamma'), side('none'), { website: '' }),
    co('Delta', none, side('match', 4, 'Delta Corp', 0.99)),
    co('Zed', none, none, { website: '' }),
  ],
};

test('report counts classes, splits by website and lists worst cases conflict-first', () => {
  const r = buildReport(data);
  assert.deepEqual(r.rows.map((x) => x.cls), ['confirmed', 'conflict', 'search_miss', 'new_tag_candidate', 'no_candidate']);
  assert.match(r.markdown, /\| conflict \| 1 \|/);
  const worst = r.markdown.split('## 10 worst cases')[1];
  assert.ok(worst.indexOf('Beta') < worst.indexOf('Delta'), 'conflict listed before new_tag_candidate');
  assert.match(r.markdown, /Source companies: \*\*5\*\*/);
  assert.match(r.markdown, /Still listed: \*\*1\*\*/);   // Alpha traced; Ghost not in source
  assert.match(r.markdown, /not in source: \*\*1\*\*/);
  assert.equal(r.disagreements.length, 3);               // conflict, search_miss, new_tag_candidate
  assert.equal(r.labelSample.length, 2);                 // conflict + new_tag_candidate
});

test('a stopped run is flagged loudly', () => {
  assert.match(buildReport({ ...data, completed: false }).markdown, /stopped early/);
});

test('labels turn into precision', () => {
  const r0 = buildReport(data);
  const labels = new Map(r0.labelSample.map((l) => [l.key, l.company === 'Delta' ? 'correct' : 'incorrect']));
  const md = buildReport(data, labels).markdown;
  assert.match(md, /new_tag_candidate\*\*: 100\.0%/);
  assert.match(md, /conflict\*\*: 0\.0%/);
});

test('csv round-trip survives quotes and commas', () => {
  const rows = [{ key: 'a,b', human_label: 'say "hi"' }];
  assert.deepEqual(parseCsv(toCsv(rows, ['key', 'human_label'])), rows);
});
