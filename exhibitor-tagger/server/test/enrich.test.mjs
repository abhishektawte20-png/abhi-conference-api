import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichCompany } from '../enrich.js';
import { createServer } from '../server.js';

const env = { SERPER_API_KEY: 's', ANTHROPIC_API_KEY: 'a', PROXY_TOKEN: 'tok' };
const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

// Fake Serper + Anthropic. `answer` is what Claude "returns".
const fakeFetch = (organic, answer) => async (url) =>
  url.includes('serper')
    ? json({ organic })
    : json({ content: [{ type: 'tool_use', input: answer }] });

const organic = [
  { title: 'Acme on LinkedIn', link: 'https://www.linkedin.com/company/acme', snippet: '' },
  { title: 'Acme Ltd', link: 'https://www.acme.com/about', snippet: 'Official site' },
];

test('picks official site and drops social results', async () => {
  const r = await enrichCompany({ name: 'Acme Ltd', country: 'UK' }, { env, fetchImpl: fakeFetch(organic, { domain: 'acme.com', confidence: 0.95, reason: 'own domain' }) });
  assert.deepEqual([r.website, r.status], ['https://acme.com', 'found']);
});

test('rejects a domain that was not in the search results', async () => {
  const r = await enrichCompany({ name: 'Acme Ltd' }, { env, fetchImpl: fakeFetch(organic, { domain: 'made-up.com', confidence: 0.99, reason: '' }) });
  assert.deepEqual([r.website, r.status], ['', 'none']);
});

test('low confidence is flagged for review', async () => {
  const r = await enrichCompany({ name: 'Acme Ltd' }, { env, fetchImpl: fakeFetch(organic, { domain: 'acme.com', confidence: 0.4, reason: 'guess' }) });
  assert.deepEqual([r.website, r.status], ['https://acme.com', 'low']);
});

test('null answer and blocked-only results give none', async () => {
  const a = await enrichCompany({ name: 'X' }, { env, fetchImpl: fakeFetch(organic, { domain: null, confidence: 0, reason: 'no' }) });
  assert.equal(a.status, 'none');
  const b = await enrichCompany({ name: 'X' }, { env, fetchImpl: fakeFetch([organic[0]], {}) });
  assert.equal(b.status, 'none');
});

test('upstream failure becomes an error result, not a throw', async () => {
  const r = await enrichCompany({ name: 'X' }, { env, fetchImpl: async () => json({}, false, 500) });
  assert.equal(r.status, 'error');
});

test('server enforces token and batch size, and enriches', async () => {
  const server = createServer({ env, enrich: async (c) => ({ website: `https://${c.name}.com`, confidence: 1, reason: '', status: 'found' }) });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, token) => fetch(`${base}/enrich`, { method: 'POST', headers: { 'X-Proxy-Token': token ?? '' }, body: JSON.stringify(body) });

  assert.equal((await post({ companies: [{ id: '1', name: 'a' }] })).status, 401);
  assert.equal((await post({ companies: [] }, 'tok')).status, 400);
  assert.equal((await post({ companies: Array(21).fill({ name: 'a' }) }, 'tok')).status, 400);
  const ok = await post({ companies: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] }, 'tok');
  assert.deepEqual((await ok.json()).results.map((r) => [r.id, r.website]), [['1', 'https://a.com'], ['2', 'https://b.com']]);
  server.close();
});
