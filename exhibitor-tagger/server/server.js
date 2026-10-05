import http from 'node:http';
import { enrichCompany } from './enrich.js';

const MAX_BATCH = 20;
const CONCURRENCY = 4;

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export function createServer({ env = process.env, enrich = enrichCompany } = {}) {
  const send = (res, status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Token',
    });
    res.end(JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/enrich') return send(res, 404, { error: 'not found' });

    if (!env.PROXY_TOKEN || req.headers['x-proxy-token'] !== env.PROXY_TOKEN) {
      return send(res, 401, { error: 'bad or missing proxy token' });
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) return send(res, 413, { error: 'body too large' });
    }
    let companies;
    try {
      companies = JSON.parse(body).companies;
    } catch {
      return send(res, 400, { error: 'invalid JSON' });
    }
    if (!Array.isArray(companies) || !companies.length || companies.length > MAX_BATCH) {
      return send(res, 400, { error: `send 1-${MAX_BATCH} companies` });
    }

    const results = await mapPool(companies, CONCURRENCY, async (c) => ({
      id: c.id,
      ...(await enrich({ name: String(c.name ?? ''), country: String(c.country ?? ''), description: String(c.description ?? '') }, { env })),
    }));
    send(res, 200, { results });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ANTHROPIC_API_KEY, SERPER_API_KEY, PROXY_TOKEN, PORT = 8787 } = process.env;
  const missing = Object.entries({ ANTHROPIC_API_KEY, SERPER_API_KEY, PROXY_TOKEN }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')} (see .env.example)`);
    process.exit(1);
  }
  createServer().listen(PORT, () => console.log(`enrichment proxy on http://localhost:${PORT}`));
}
