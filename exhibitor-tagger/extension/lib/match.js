// Match source companies against RTS entities. Pure functions, no network.
//
// RTS entity shape (from the attendee search / tagged-list endpoints):
//   { attendeeEntityId, formalName, nameVariations[], url, exhibitor, sponsor, ... }
// Source company shape: { name, website }

const LEGAL = /\b(sdn\.?\s*bhd\.?|bhd|gmbh|ag|kg|ug|inc\.?|incorporated|incorporation|llc|ltd\.?|limited|plc|corp\.?|corporation|co\.?|company|s\.?a\.?s?|s\.?r\.?l\.?|s\.?r\.?o\.?|b\.?v\.?|n\.?v\.?|pte|pty|e\.?v\.?|oy|ab|as|llp|lp)\b/gi;

const strip = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function normName(name) {
  return strip(name)
    .replace(/\(.*?\)/g, ' ') // RTS disambiguators like "Reliance (Phoenix)"
    .replace(/&/g, ' and ')
    .replace(LEGAL, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function hostOf(url) {
  const v = String(url ?? '').trim();
  if (!v) return '';
  try {
    return new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

const sameHost = (a, b) => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));

const dice = (a, b) => {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  const shared = [...A].filter((t) => B.has(t)).length;
  return (2 * shared) / (A.size + B.size);
};

/** 1 for an exact (normalized) match on the formal name or any alias; otherwise the best token overlap. */
export function nameScore(name, entity) {
  const c = normName(name);
  if (!c) return 0;
  const names = [entity.formalName, ...(entity.nameVariations ?? [])].map(normName).filter(Boolean);
  if (names.includes(c)) return 1;
  return Math.max(0, ...names.map((n) => dice(c, n)));
}

/**
 * Score one RTS entity against one source company.
 * Tiers:
 *   match  - website domain equal AND the name is at least loosely compatible (two independent signals)
 *   review - domain equal but names differ (rebrand/subsidiary), or a strong name match with no domain evidence
 *   none   - nothing convincing
 * An exact name alone is never enough for "match": names like "Reliance" are shared by many RTS entities.
 */
export function pairScore(company, entity) {
  const ns = nameScore(company.name, entity);
  const domainEq = sameHost(hostOf(company.website), hostOf(entity.url));
  const reasons = [];
  let tier = 'none';
  let score = ns * 0.6;

  if (domainEq && ns >= 0.5) {
    tier = 'match';
    score = ns === 1 ? 0.99 : 0.9;
    reasons.push('website domain equal', ns === 1 ? 'name equal' : 'name similar');
  } else if (domainEq) {
    tier = 'review';
    score = 0.75;
    reasons.push('website domain equal but name differs');
  } else if (ns >= 0.7) {
    tier = 'review';
    score = ns === 1 ? 0.7 : 0.6;
    reasons.push(ns === 1 ? 'name equal, no domain evidence' : 'name similar, no domain evidence');
  }
  return { tier, score: Math.round(score * 100) / 100, nameScore: Math.round(ns * 100) / 100, domainEq, reasons };
}

const rank = { match: 2, review: 1, none: 0 };

/**
 * Pick the outcome for one company from a pool of RTS candidates.
 * Returns { tier, best, candidates, reasons }. Two different entities that both match by domain
 * mean RTS already holds duplicate profiles, so that is downgraded to review.
 */
export function classify(company, entities) {
  const scored = entities
    .map((e) => ({ entity: e, ...pairScore(company, e) }))
    .filter((s) => s.tier !== 'none')
    .sort((a, b) => rank[b.tier] - rank[a.tier] || b.score - a.score);

  if (!scored.length) return { tier: 'none', best: null, candidates: [], reasons: ['no RTS candidate'] };

  const top = scored[0];
  const domainMatches = scored.filter((s) => s.domainEq);
  const exactNameTies = scored.filter((s) => s.nameScore === 1 && !s.domainEq);
  let { tier } = top;
  const reasons = [...top.reasons];

  if (domainMatches.length > 1) {
    tier = 'review';
    reasons.push(`${domainMatches.length} RTS entities share this domain`);
  } else if (tier === 'review' && !top.domainEq && exactNameTies.length > 1) {
    reasons.push(`${exactNameTies.length} RTS entities share this exact name`);
  }
  return {
    tier,
    best: top.entity,
    score: top.score,
    candidates: scored.slice(0, 3).map((s) => ({ id: s.entity.attendeeEntityId, name: s.entity.formalName, url: s.entity.url, score: s.score })),
    reasons,
  };
}

// "acmeca.com.my" -> "acmeca", "shop.acme.co.uk" -> "acme"
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);
export function domainLabel(host) {
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return '';
  const drop = parts.length > 2 && SECOND_LEVEL.has(parts[parts.length - 2]) ? 2 : 1;
  return parts[parts.length - drop - 1] ?? '';
}

/** Search terms to try, most specific first. Several tries guard against missing an existing profile. */
export function searchTerms(company) {
  const name = normName(company.name);
  const host = hostOf(company.website);
  const label = domainLabel(host);
  const terms = [name, label, name.split(' ').slice(0, 2).join(' ')].filter((t) => t.length >= 3);
  return [...new Set(terms)];
}

/**
 * Step 1 of the workflow: for each entity already tagged to the event, is it still in the source list?
 * "not_in_source" is only a flag: a partial scrape does not prove an exhibitor withdrew.
 */
export function scrubTagged(tagged, companies) {
  return tagged.map((entity) => {
    const best = companies
      .map((c) => ({ company: c, ...pairScore(c, entity) }))
      .sort((a, b) => rank[b.tier] - rank[a.tier] || b.score - a.score)[0];
    const status = !best || best.tier === 'none' ? 'not_in_source' : best.tier === 'match' ? 'still_listed' : 'verify';
    return {
      entityId: entity.attendeeEntityId,
      name: entity.formalName,
      exhibitor: !!entity.exhibitor,
      sponsor: !!entity.sponsor,
      status,
      sourceName: status === 'not_in_source' ? '' : best.company.name,
      reasons: best?.reasons ?? [],
    };
  });
}

/**
 * Full matching run for one company: first against the already-tagged list, then against RTS search.
 * `api` = { search(term) -> entities[] }. Returns the status the review table shows.
 *   already_tagged | tag | review | create_log
 * A company only becomes create_log if EVERY search variant came back without a convincing candidate.
 */
export async function matchCompany(company, tagged, api) {
  const inTagged = classify(company, tagged);
  if (inTagged.tier === 'match') return { status: 'already_tagged', ...summary(inTagged) };
  if (inTagged.tier === 'review') return { status: 'review', note: 'possibly already tagged', ...summary(inTagged) };

  const pool = new Map();
  for (const term of searchTerms(company)) {
    for (const e of await api.search(term)) pool.set(e.attendeeEntityId, e);
  }
  const found = classify(company, [...pool.values()]);
  if (found.tier === 'match') {
    // An entity RTS search returns as already exhibitor/sponsor for this event counts as tagged.
    const already = found.best.exhibitor || found.best.sponsor;
    return { status: already ? 'already_tagged' : 'tag', ...summary(found) };
  }
  if (found.tier === 'review') return { status: 'review', ...summary(found) };
  return { status: 'create_log', best: null, candidates: [], reasons: [`no convincing RTS candidate after ${searchTerms(company).length} searches`] };
}

function summary(c) {
  return {
    entityId: c.best?.attendeeEntityId ?? null,
    entityName: c.best?.formalName ?? '',
    entityUrl: c.best?.url ?? '',
    entityFlags: { exhibitor: !!c.best?.exhibitor, sponsor: !!c.best?.sponsor },
    score: c.score ?? 0,
    candidates: c.candidates,
    reasons: c.reasons,
  };
}

const brief = (c) => ({ tier: c.tier, id: c.best?.attendeeEntityId ?? null, name: c.best?.formalName ?? '', score: c.score ?? 0, reasons: c.reasons });

/**
 * Phase 0 evaluation (read-only). Runs the two independent routes for one company:
 *   viaTagged - match against the event's tagged list
 *   viaSearch - match through RTS search, ignoring the tagged list (what "tag" would see on an untagged event)
 * Comparing them on an already-finished event shows how often the search route finds the right entity.
 */
export async function evaluateCompany(company, tagged, api) {
  const terms = searchTerms(company);
  const pool = new Map();
  for (const term of terms) for (const e of await api.search(term)) pool.set(e.attendeeEntityId, e);
  return {
    viaTagged: brief(classify(company, tagged)),
    viaSearch: { ...brief(classify(company, [...pool.values()])), searches: terms.length },
  };
}
