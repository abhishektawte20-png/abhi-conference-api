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

Websites with confidence under 70% show as "low" so you can review them; the website cell is editable.

## Tests

```
cd extension && node --test test/
cd server && node --test test/
```
