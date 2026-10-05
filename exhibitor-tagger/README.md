# Exhibitor Tagger

Chrome extension + small proxy that takes an exhibitor/sponsor spreadsheet, maps its columns,
and finds missing company websites (web search, then Claude picks the official site).

Tagging in RTS and activity-log creation are not built yet.

## Run

1. Proxy (keeps the API keys out of the extension):
   ```
   cd server
   cp .env.example .env   # fill in ANTHROPIC_API_KEY, SERPER_API_KEY, PROXY_TOKEN
   node --env-file=.env server.js
   ```
   Serper (serper.dev) is the search API. Needs Node 20+.
2. Extension: `chrome://extensions` → Developer mode → Load unpacked → pick `extension/`.
   Click the toolbar icon, open Settings, enter the proxy URL and token.
3. Upload a sheet → check the column mapping → Load companies → Find missing websites → Export CSV.

**QA layer:** after the model picks a site, the proxy fetches it and checks it independently: the domain resolves, it isn't a parked/for-sale page, the company name appears in the title/headings/domain, and the country doesn't contradict. A site is only "found" if the model is 70%+ confident *and* QA verifies it. Parked or dead domains are rejected; unverifiable ones (bot-blocking) go to review. Set `QA=off` in `.env` to disable.

Websites with confidence under 70% show as "low" so you can review them; the website cell is editable.

## Tests

```
cd extension && node --test test/*.test.mjs
cd server && node --test test/*.test.mjs
```
