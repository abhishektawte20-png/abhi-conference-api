// Runs inside rts.pitchbook.com tabs. Requests are same-origin, so the browser attaches the
// logged-in session by itself; this script never reads or forwards cookies.
// READ-ONLY: only the two lookup endpoints are called. Nothing here writes to RTS.

const BASE = '/web-api/conference-data-rts-bff';
const HEADERS = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin', headers: HEADERS, ...init });
  if (!res.ok) throw new Error(`RTS ${res.status} on ${path.split('?')[0]}`);
  return res.json();
}

const handlers = {
  // One page of entities already tagged to the event.
  tagged: ({ eventId, limit, offset }) =>
    call(`/v2/attendees?conferenceEventId=${encodeURIComponent(eventId)}&limit=${limit}&offset=${offset}`),
  // The "Search for entities to tag or un-tag" lookup (a POST with no body; the term is in the query).
  search: ({ eventId, term }) =>
    call(`/attendees/search?conferenceEventId=${encodeURIComponent(eventId)}&searchTerm=${encodeURIComponent(term)}`, { method: 'POST' }),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'rts' || !handlers[msg.op]) return false;
  handlers[msg.op](msg.args).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: err.message }),
  );
  return true; // async response
});
