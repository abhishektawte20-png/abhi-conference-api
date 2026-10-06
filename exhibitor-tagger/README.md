# Exhibitor Tagger

Chrome extension + small proxy that takes an exhibitor/sponsor spreadsheet, maps its columns,
and finds missing company websites (web search, then Claude picks the official site).

**RTS (read-only):** the extension reads the event's tagged list and searches RTS from inside your logged-in RTS tab
(a content script makes same-origin calls, so cookies are never read or forwarded). It never writes to RTS.
Per company it reports `already_tagged`, `tag` (domain + name both agree), `review`, or `create_log` (nothing convincing
after several search variants). Exact name alone is never enough for `tag`. The last run is cached in the browser and can be
exported/imported as JSON. Tagging and activity-log creation are not built yet.

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
3. Open the event in RTS in the same browser (keep that tab active), then in the panel: upload a sheet → check the column mapping → Load companies → Find missing websites → Export CSV.

**QA layer:** after the model picks a site, the proxy fetches it and checks it independently: the domain resolves, it isn't a parked/for-sale page, the company name appears in the title/headings/domain, and the country doesn't contradict. A site is only "found" if the model is 70%+ confident *and* QA verifies it. Parked or dead domains are rejected; unverifiable ones (bot-blocking) go to review. Set `QA=off` in `.env` to disable.

Websites with confidence under 70% show as "low" so you can review them; the website cell is editable.

## Phase 0: measure accuracy on a finished event (read-only)

1. Open a past event in RTS whose tagged list you trust. Load the source sheet it was built from in the side panel
   (optionally run "Find missing websites" first: enrichment is part of what is being measured).
2. **Run evaluation (read-only)**. For every company it runs two independent routes: matching against the event's
   tagged list, and matching through RTS search as if the event were untagged. **Export evaluation JSON.**
3. `node eval/report.mjs eval-event-<id>.json` writes `eval/out/report.md`, `disagreements.csv` and `label_sample.csv`.
   Exports contain PitchBook data: keep them local (`eval/data/` and `eval/out/` are git-ignored).
4. Fill `human_label` (correct / incorrect) in `label_sample.csv` for the rows where search says "match" but the event
   does not have the entity, plus any conflicts. Re-run with `--labels label_sample.csv` to get precision.
5. Thresholds are untuned defaults. Tune only on the report's "tune half" and confirm on the "held-out half".

The two routes share the matcher's own name/domain logic, so agreement is a consistency check, not proof. Precision
numbers come from the human labels.

## Guardrails (apply to every phase)

Read-only until tagging is built. When it is: never replay the raw event `PUT` (use the page's own checkboxes and Save),
additive only (never un-tag), two independent signals to auto-tag, idempotent reruns, dry run + per-batch approval,
batches of 5 followed by a re-read and diff of the tagged list (halt on any surprise), hard cap and Stop button,
stop on any RTS error, at most 3 concurrent RTS requests, and a persisted audit log. No cookies, tokens or PitchBook
data in the repo, logs or fixtures.

## Cache format

`chrome.storage.local.lastSession` and the exported JSON: `{ version: 1, savedAt, eventId, taggedTotal, companies[], scrub[] }`.
Each company carries `name, country, website, source, status/confidence/reason` (enrichment), `qa`, and `rts`
(`status, entityId, entityName, score, reasons, candidates[]`). The audit log will be added with the first write feature.

## Tests

```
cd extension && node --test test/*.test.mjs
cd server && node --test test/*.test.mjs
node --test eval/report.test.mjs
```
