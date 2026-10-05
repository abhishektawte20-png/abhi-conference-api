// Side-panel end of the RTS bridge: forwards read-only lookups to the content script in an RTS tab.

const PAGE = 50;

export async function findRtsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://rts.pitchbook.com/*' });
  return tabs.find((t) => t.active) ?? tabs[0] ?? null;
}

export const eventIdFromUrl = (url) => new URL(url).searchParams.get('conferenceEventId') ?? '';

async function ask(tabId, op, args) {
  let reply;
  try {
    reply = await chrome.tabs.sendMessage(tabId, { target: 'rts', op, args });
  } catch {
    throw new Error('Cannot reach the RTS tab. Reload the RTS page once, then try again.');
  }
  if (!reply?.ok) throw new Error(reply?.error || 'RTS did not answer');
  return reply.data;
}

export function rtsApi(tabId, eventId) {
  return {
    async allTagged() {
      const all = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await ask(tabId, 'tagged', { eventId, limit: PAGE, offset });
        all.push(...page.entries);
        if (!page.hasMore || !page.entries.length) return { entries: all, totalCount: page.totalCount };
      }
    },
    async search(term) {
      return (await ask(tabId, 'search', { eventId, term })).entries ?? [];
    },
  };
}
