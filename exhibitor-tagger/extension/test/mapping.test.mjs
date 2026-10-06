import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSheet, extractCompanies, normalizeWebsite } from '../lib/mapping.js';

const informa = [
  ['kjgw2r', '87m5bq', 'c4qz1x', 'gfd9kd', 'eklv35', 'eklvn6', 'fdqxue', 'an9eq0', 'frd0k0'],
  ...['AC MECA (M) SDN BHD', 'Acculinks Systems (M) Sdn Bhd', 'ADVENXUS SOLUTIONS SDN BHD', 'Airgens Machinery Sdn Bhd'].map((n, i) => [
    n,
    `https://exhibitors.informamarkets-info.com/event/2026MTM/en-US/exhibitor/${i}/x`,
    'Booth No.\t:',
    String(3000 + i),
    'Country/Region:',
    i < 3 ? 'MALAYSIA' : 'SINGAPORE',
    'Category:',
    'A long description of the company. '.repeat(6),
    'https://exhibitors.informamarkets-info.com/img.png',
  ]),
];

const expocad = [
  ['825j0y', '825j1t'],
  ['A36', '3A Glove Sdn Bhd'],
  ['K51', '3H Smart USA, Inc.'],
  ['S70', '3J Medical Supplies Inc.'],
  ['B34', '12 Panel Now'],
];

const interschutz = [
  ['825j0y', '825j1t', '82fsd1t', '82sdf', '82sfra', '83r65a', '83hbjh', '84dgds', '84dfg', '84sfgh'],
  ['Exhibitor', '2 GARENI INDUSTRIE SAS', 'France', '47600', 'Calignac', '', '', 'http://www.2gareni-industrie.com', 'Hall 27, Stand H14', 'https://www.interschutz.de/exhibitor/a/N1'],
  ['Exhibitor', '3creative GmbH', 'Germany', '56154', 'Boppard', 'RP', '', 'http://www.einsatzsoftware.de', 'Hall 17, Stand H13', 'https://www.interschutz.de/exhibitor/b/N2'],
  ['Exhibitor', '3FFF Limited', 'United Kingdom', '', 'Corby', '', '', 'http://www.3fff.co.uk', 'Hall 13, Stand C01', 'https://www.interschutz.de/exhibitor/c/N3'],
  ['Exhibitor', '5Elem Hi-Tech', 'Germany', '225510', 'Taizhou', '', '', 'http://www.5elem.com', 'Hall 13, Stand G50', 'https://www.interschutz.de/exhibitor/d/N4'],
  ...Array.from({ length: 8 }, (_, i) => ['Exhibitor', `Firma ${i} GmbH`, 'Germany', '5000', 'Köln', '', '', `http://www.firma${i}.de`, 'Hall 1', `https://www.interschutz.de/exhibitor/f${i}/N${i}`]),
];

test('informa layout: skips junk row, name+country+description, no website', () => {
  const a = analyzeSheet(informa);
  assert.equal(a.startRow, 1);
  assert.deepEqual(a.guess, { name: 0, website: -1, country: 5, description: 7 });
});

test('expocad layout: name is column 2, not the booth code', () => {
  const a = analyzeSheet(expocad);
  assert.equal(a.startRow, 1);
  assert.equal(a.guess.name, 1);
});

test('interschutz layout: finds website column, ignores source-link column', () => {
  const a = analyzeSheet(interschutz);
  assert.equal(a.guess.name, 1);
  assert.equal(a.guess.website, 7);
  assert.equal(a.guess.country, 2);
});

test('header row is detected and skipped', () => {
  const rows = [['Company Name', 'Country', 'Website'], ['Acme Ltd', 'UK', 'https://www.acme.com/about'], ['Beta Inc', 'US', '']];
  const a = analyzeSheet(rows);
  assert.equal(a.startRow, 1);
  assert.deepEqual(a.guess, { name: 0, website: 2, country: 1, description: -1 });
  const c = extractCompanies(rows, { startRow: a.startRow, map: a.guess }, 's');
  assert.equal(c[0].website, 'https://acme.com');
  assert.equal(c[1].website, '');
});

test('extractCompanies drops blanks and duplicate names', () => {
  const rows = [['Acme'], ['acme '], [''], ['Beta']];
  const c = extractCompanies(rows, { startRow: 0, map: { name: 0, country: -1, website: -1, description: -1 } });
  assert.deepEqual(c.map((x) => x.name), ['Acme', 'Beta']);
});

test('normalizeWebsite', () => {
  assert.equal(normalizeWebsite('http://www.3fff.co.uk/x?y=1'), 'https://3fff.co.uk');
  assert.equal(normalizeWebsite('www.foo.com'), 'https://foo.com');
  assert.equal(normalizeWebsite('not a url'), '');
});
