import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainLabel, normName, pairScore, classify, searchTerms, scrubTagged, matchCompany } from '../lib/match.js';

const ent = (id, formalName, url, extra = {}) => ({ attendeeEntityId: id, formalName, url, nameVariations: [], exhibitor: false, sponsor: false, ...extra });

test('normName drops legal suffixes, diacritics and RTS disambiguators', () => {
  assert.equal(normName('Akamai Technologies, Inc.'), 'akamai technologies');
  assert.equal(normName('Reliance (Phoenix)'), 'reliance');
  assert.equal(normName('ACME Sdn Bhd'), 'acme');
  assert.equal(normName('Müller & Söhne GmbH'), 'muller and sohne');
});

test('domain + name is a match; name alone is never a match', () => {
  const e = ent(1, 'Akamai Technologies', 'www.akamai.com', { nameVariations: ['Akamai'] });
  assert.equal(pairScore({ name: 'Akamai', website: 'https://akamai.com' }, e).tier, 'match');
  const nameOnly = pairScore({ name: 'Akamai', website: '' }, e);
  assert.equal(nameOnly.tier, 'review');
  assert.ok(nameOnly.score < 0.9);
});

test('same domain but different name is review (rebrand or subsidiary)', () => {
  const e = ent(1, 'Old Brand Ltd', 'www.acme.com');
  assert.equal(pairScore({ name: 'Acme Global', website: 'https://acme.com' }, e).tier, 'review');
});

test('different company with a shared alias does not match', () => {
  const e = ent(5839413, 'Reliance Compost', 'www.reliance.co.za', { nameVariations: ['Reliance'] });
  const r = pairScore({ name: 'Reliance Industries', website: 'https://ril.com' }, e);
  assert.notEqual(r.tier, 'match');
});

test('many entities sharing an exact alias are flagged as ambiguous', () => {
  const pool = ['a', 'b', 'c'].map((x, i) => ent(i, `Reliance ${x}`, `www.rel-${x}.com`, { nameVariations: ['Reliance'] }));
  const r = classify({ name: 'Reliance', website: '' }, pool);
  assert.equal(r.tier, 'review');
  assert.match(r.reasons.join(' '), /share this exact name/);
});

test('two entities with the same domain => duplicate profiles => review', () => {
  const pool = [ent(1, 'Acme', 'www.acme.com'), ent(2, 'Acme Inc', 'acme.com')];
  const r = classify({ name: 'Acme', website: 'https://acme.com' }, pool);
  assert.equal(r.tier, 'review');
  assert.match(r.reasons.join(' '), /share this domain/);
});

test('searchTerms: name, domain label, short form, deduped', () => {
  assert.deepEqual(searchTerms({ name: 'AC MECA (M) SDN BHD', website: 'https://acmeca.com.my' }), ['ac meca', 'acmeca']);
});

test('domainLabel handles two-part suffixes and subdomains', () => {
  assert.equal(domainLabel('acmeca.com.my'), 'acmeca');
  assert.equal(domainLabel('shop.acme.co.uk'), 'acme');
  assert.equal(domainLabel('axonius.com'), 'axonius');
});

test('scrubTagged flags tagged entities missing from the source list', () => {
  const tagged = [ent(1, 'Akamai Technologies', 'www.akamai.com'), ent(2, 'Ghost Corp', 'www.ghost.io')];
  const out = scrubTagged(tagged, [{ name: 'Akamai', website: 'https://akamai.com' }]);
  assert.deepEqual(out.map((o) => o.status), ['still_listed', 'not_in_source']);
});

test('matchCompany: tag / already_tagged / create_log only after all searches come back empty', async () => {
  const db = [ent(10, 'Axonius', 'www.axonius.com', { nameVariations: ['Axonius Inc'] }), ent(11, 'Cisco Systems', 'www.cisco.com', { sponsor: true })];
  const searched = [];
  const api = { search: async (t) => { searched.push(t); return db.filter((e) => normName(e.formalName).includes(t.split(' ')[0])); } };

  assert.equal((await matchCompany({ name: 'Axonius Inc.', website: 'https://axonius.com' }, [], api)).status, 'tag');
  assert.equal((await matchCompany({ name: 'Cisco Systems', website: 'https://cisco.com' }, [], api)).status, 'already_tagged');

  searched.length = 0;
  const none = await matchCompany({ name: 'Zorblax Dynamics Sdn Bhd', website: 'https://zorblax.my' }, [], api);
  assert.equal(none.status, 'create_log');
  assert.ok(searched.length >= 2, 'tried several search variants before concluding none');
});

test('already in the tagged list is found without searching', async () => {
  const tagged = [ent(1, 'Akamai Technologies', 'www.akamai.com', { sponsor: true })];
  const api = { search: async () => { throw new Error('should not search'); } };
  const r = await matchCompany({ name: 'Akamai Technologies Inc', website: 'https://akamai.com' }, tagged, api);
  assert.equal(r.status, 'already_tagged');
});
