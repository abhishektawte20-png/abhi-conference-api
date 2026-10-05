// Pure helpers: turn a sheet (array of rows) into a list of companies.
// No DOM / chrome.* / XLSX dependencies so it can be unit-tested in Node.

const URL_RE = /^(https?:\/\/|www\.)/i;
// Booth / stand codes such as "A36", "O63 P63", "3270".
const BOOTH_RE = /^[a-z]{0,2}\d+[a-z]?(\s+[a-z]{0,2}\d+[a-z]?)*$/i;
const HEADER_WORDS = /name|company|exhibitor|sponsor|country|website|url|booth|stand/i;

const text = (v) => (v == null ? '' : String(v).trim());

export function hostOf(value) {
  const v = text(value);
  if (!URL_RE.test(v)) return '';
  try {
    return new URL(/^www\./i.test(v) ? `https://${v}` : v).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function normalizeWebsite(value) {
  const host = hostOf(value);
  return host ? `https://${host}` : '';
}

// Row 1 of some exports is random IDs like "kjgw2r" — short, space-free, alphanumeric.
function isJunkRow(row) {
  const cells = row.map(text).filter(Boolean);
  return cells.length >= 2 && cells.every((c) => c.length <= 8 && /^[a-z0-9]+$/i.test(c));
}

function isHeaderRow(row) {
  const cells = row.map(text).filter(Boolean);
  return (
    cells.length >= 2 &&
    cells.every((c) => c.length < 40 && !URL_RE.test(c)) &&
    cells.some((c) => HEADER_WORDS.test(c))
  );
}

function columnStats(rows, index) {
  const values = rows.map((r) => text(r[index])).filter(Boolean);
  const distinct = new Set(values.map((v) => v.toLowerCase()));
  const urls = values.filter((v) => URL_RE.test(v));
  const hosts = new Set(urls.map(hostOf).filter(Boolean));
  return {
    filled: values.length,
    distinct: distinct.size,
    distinctRatio: values.length ? distinct.size / values.length : 0,
    avgLen: values.length ? values.reduce((n, v) => n + v.length, 0) / values.length : 0,
    urlRatio: values.length ? urls.length / values.length : 0,
    hostRatio: urls.length ? hosts.size / urls.length : 0,
    codeRatio: values.length ? values.filter((v) => BOOTH_RE.test(v)).length / values.length : 0,
    digitRatio: values.length ? values.filter((v) => /\d/.test(v)).length / values.length : 0,
    labelRatio: values.length ? values.filter((v) => v.endsWith(':')).length / values.length : 0,
    rowFill: rows.length ? values.length / rows.length : 0,
  };
}

/**
 * Inspect a sheet and suggest where the data starts and which column is which.
 * Returns { startRow, columns: [{ index, header, sample }], guess: { name, website, country, description } }
 * where guess values are column indexes or -1.
 */
export function analyzeSheet(rows) {
  let headerRow = -1;
  let startRow = 0;
  if (rows.length && isJunkRow(rows[0])) startRow = 1;
  if (rows[startRow] && isHeaderRow(rows[startRow])) {
    headerRow = startRow;
    startRow += 1;
  }

  const data = rows.slice(startRow, startRow + 300);
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const stats = Array.from({ length: width }, (_, i) => columnStats(data, i));

  const columns = stats.map((_, index) => ({
    index,
    header: headerRow >= 0 ? text(rows[headerRow][index]) : '',
    sample: text(data.find((r) => text(r[index]))?.[index]).slice(0, 60),
  }));

  const headerMatch = (re) => columns.findIndex((c) => re.test(c.header));
  const pick = (test) => stats.findIndex((s, i) => s.filled > 0 && test(s, i));

  // Website: URL-like values pointing to many different hosts (a column where every
  // value shares one host is a link back to the source site, not the company's site).
  let website = headerMatch(/web|url|domain/i);
  if (website < 0) website = pick((s) => s.urlRatio >= 0.5 && s.hostRatio > 0.5);

  const isTextual = (s) => s.urlRatio < 0.5 && s.labelRatio < 0.5 && s.distinct >= 2;

  let name = headerMatch(/company|exhibitor|sponsor|organi[sz]ation|^name$/i);
  if (name < 0) {
    name = pick(
      (s, i) => i !== website && isTextual(s) && s.distinctRatio > 0.8 && s.avgLen >= 6 && s.codeRatio < 0.5 && s.avgLen < 80,
    );
  }

  let country = headerMatch(/country|nation/i);
  if (country < 0) {
    country = pick(
      (s, i) =>
        i !== name && i !== website && isTextual(s) && s.distinctRatio <= 0.5 && s.avgLen < 25 && s.digitRatio < 0.1 && s.rowFill > 0.8,
    );
  }

  let description = headerMatch(/descr|about|profile/i);
  if (description < 0) {
    const best = stats.reduce((b, s, i) => (s.avgLen > (stats[b]?.avgLen ?? 0) ? i : b), -1);
    description = best >= 0 && stats[best].avgLen > 80 ? best : -1;
  }

  return { startRow, columns, guess: { name, website, country, description } };
}

/** Build the company list from rows using a column map. Skips blanks and duplicate names. */
export function extractCompanies(rows, { startRow, map }, source = '') {
  const get = (row, i) => (i >= 0 ? text(row[i]) : '');
  const seen = new Set();
  const out = [];
  for (const row of rows.slice(startRow)) {
    const name = get(row, map.name);
    const key = name.toLowerCase().replace(/\s+/g, ' ');
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `${source}:${out.length}`,
      name,
      country: get(row, map.country),
      description: get(row, map.description).slice(0, 600),
      website: normalizeWebsite(get(row, map.website)),
      source,
    });
  }
  return out;
}
