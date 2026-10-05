// QA layer: independently check a candidate website by looking at the site itself.
// Deterministic on purpose, so it does not share the first-pass model's blind spots.

const LEGAL = /\b(sdn\.?\s*bhd\.?|bhd|gmbh|ag|kg|ug|inc\.?|incorporated|llc|ltd\.?|limited|plc|corp\.?|corporation|co\.?|company|s\.?a\.?s?|s\.?r\.?l\.?|s\.?r\.?o\.?|b\.?v\.?|n\.?v\.?|pte|pty|e\.?v\.?|oy|ab|as|a\/s)\b/gi;
const GENERIC = new Set([
  'solutions', 'solution', 'systems', 'system', 'technologies', 'technology', 'tech', 'machinery', 'industries', 'industrial',
  'international', 'group', 'holdings', 'services', 'engineering', 'trading', 'enterprise', 'enterprises', 'global', 'the', 'and', 'malaysia',
]);
const PARKED = /domain (is )?for sale|buy this domain|this domain (may be|is) for sale|domain parking|parked (free|domain)|sedo\.com|hugedomains|godaddy\.com\/domainsearch|coming soon.{0,40}(under construction)/i;
const TLD_COUNTRY = { my: 'malaysia', de: 'germany', fr: 'france', uk: 'united kingdom', nl: 'netherlands', it: 'italy', es: 'spain', sg: 'singapore', cn: 'china', jp: 'japan', in: 'india', au: 'australia', at: 'austria', ch: 'switzerland', pl: 'poland', se: 'sweden', tr: 'turkey' };

const strip = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function nameTokens(name) {
  const base = strip(name).replace(/\(.*?\)/g, ' ').replace(LEGAL, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const all = base.split(' ').filter((t) => t.length >= 2);
  const distinctive = all.filter((t) => !GENERIC.has(t));
  return distinctive.length ? distinctive : all;
}

function pageFacts(html) {
  const pick = (re) => (html.match(re)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const body = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
  return {
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    siteName: pick(/property=["']og:site_name["'][^>]*content=["']([^"']*)/i),
    h1: pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, ' '),
    text: body.replace(/\s+/g, ' ').slice(0, 4000),
  };
}

/**
 * Returns { verdict, score, reasons }.
 * verdict: 'verified' | 'review' | 'rejected'. Only a dead domain or a parked page is rejected;
 * bot-blocking (403, timeouts) is merely unverifiable and goes to review.
 */
export async function verifyWebsite(company, website, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const reasons = [];
  const host = new URL(website).hostname.replace(/^www\./, '');
  const label = strip(host.split('.').slice(0, -1).join('')).replace(/[^a-z0-9]/g, '');
  const tokens = nameTokens(company.name);
  const compact = tokens.join('');

  let html = '';
  let finalHost = host;
  try {
    const res = await fetchImpl(website, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ExhibitorTagger/0.1)' },
    });
    finalHost = new URL(res.url || website).hostname.replace(/^www\./, '');
    if (!res.ok) {
      reasons.push(`site answered ${res.status} (may block bots)`);
    } else {
      html = (await res.text()).slice(0, 200_000);
    }
  } catch (err) {
    const dead = /ENOTFOUND|EAI_AGAIN/.test(`${err.cause?.code ?? ''} ${err.message}`);
    if (dead) return { verdict: 'rejected', score: 0, reasons: ['domain does not resolve'] };
    reasons.push('could not load the site');
  }

  if (html && PARKED.test(html.slice(0, 20000)) && html.length < 30000) {
    return { verdict: 'rejected', score: 0, reasons: ['parked or for-sale page'] };
  }

  // Evidence 1: company name on the page, or in the domain.
  const facts = html ? pageFacts(html) : { title: '', siteName: '', h1: '', text: '' };
  const head = strip(`${facts.title} ${facts.siteName} ${facts.h1}`);
  const full = strip(`${head} ${facts.text}`);
  const inHead = tokens.length ? tokens.filter((t) => head.includes(t)).length / tokens.length : 0;
  const inBody = tokens.length ? tokens.filter((t) => full.includes(t)).length / tokens.length : 0;
  const domainMatch = compact.length >= 3 && label.length >= 3 && (label.includes(compact) || compact.includes(label));
  const tokenInDomain = tokens.length > 0 && tokens.some((t) => t.length >= 4 && label.includes(t));

  let score = Math.max(inHead, inBody * 0.8, domainMatch ? 0.9 : 0, tokenInDomain ? 0.6 : 0);
  if (domainMatch) reasons.push('domain matches company name');
  if (inHead >= 0.99) reasons.push('name in page title/heading');
  else if (inBody >= 0.99) reasons.push('name found in page text');
  else if (!html) reasons.push('no page text to confirm the name');
  else reasons.push('company name not clearly on the page');

  // Evidence 2: country. Only a contradiction counts against; absence is neutral.
  const tld = host.split('.').pop();
  const country = strip(company.country || '');
  if (country && TLD_COUNTRY[tld] && TLD_COUNTRY[tld] !== country && !['com', 'net', 'org'].includes(tld)) {
    score *= 0.7;
    reasons.push(`.${tld} domain but company is in ${company.country}`);
  } else if (country && html && full.includes(country)) {
    score = Math.min(1, score + 0.1);
    reasons.push('country mentioned on the page');
  }

  // Evidence 3: redirected to an unrelated domain.
  if (finalHost !== host && !finalHost.endsWith(host) && !host.endsWith(finalHost)) {
    score *= 0.8;
    reasons.push(`redirects to ${finalHost}`);
  }

  score = Math.round(score * 100) / 100;
  return { verdict: score >= 0.6 ? 'verified' : 'review', score, reasons };
}
