# price-research

The price check's service (`tech/price-check`). It researches today's price of an item or service in the Philippines with Claude and web search, checks every listing against what the research actually saw, finds product photos, adds Mineski's own past prices alongside, and streams progress and the report back to the page. Every finished search is saved to a shared Lark table (Saved searches), as the person who ran it.

It holds the Anthropic key, so the page never does. It does one narrow job ("research this price"), not a general Claude relay. It's built the same way as `tech/anthropic-ce`, with no npm dependencies and no build step: one `src/service.js` runs on Node (`server.js`) and on Cloudflare Workers (`src/worker.js`).

**Deployed as:** the Cloudflare Worker `anthropic-price-service` (https://anthropic-price-service.stephen-lin.workers.dev), with the Lark login check on. `npx wrangler deploy` in this folder.

```
page ──POST /research──▶ checks (origin → Lark login → JSON body → rate limit → a free slot)
     ◀── NDJSON stream ── past prices (D1 CE lines, Lark purchase requests) as Claude's reference
                          run: Messages API (stream) ⇄ pause_turn / wrap-up / nudge
                          tools: web_search + web_fetch + submit_report (strict)
                          then: evidence → verify each listing → photos → price (stats.js) → report
                          then: save to the Lark table as the person → "saved"
page ──GET/PATCH /searches…──▶ the same table: the list, one search with its report, a changed price
```

## Endpoints

| Method and path | What it does |
| --------------- | ------------ |
| `GET /` | Service, version, runtime, depths (each with its model), market, limits, `cors.allow_headers`, login, whether saved searches and past costings are available. Open to any origin and never cached; the page calls it to wake and check the service. |
| `GET /health` | `{"status":"ok"}` |
| `POST /research` | Runs one search (below). |
| `GET /searches` | Every saved search, light (no report), newest first: `{ searches: [{ record_id, search_id, item, details, typical, low, high, unit, confidence, depth, cost, created_at, by, updated_at, updated_by }], count }`. Up to 2,000. |
| `GET /searches/<record_id>` | One saved search (one version) with its `report`. |
| `PATCH /searches/<record_id>` | `{ included: ["l1", …] }`: the listings that count changed. The price is worked out again (`stats.js`) and Typical, Low, High, Confidence and the report are saved. |
| `POST /searches` | `{ report }`: save a report whose automatic save failed (only a report this service made). |
| `GET /searches/setup` | Whether the table has every column this service writes: `{ table: { ready, missing } }`. |
| `POST /searches/setup` | Adds the missing columns through the Lark API, as the person (who must be able to edit the table). When the table's first column is empty in every record (a new table's blank rows), it's renamed to Item instead. Nothing is removed. `{ table: { added, renamed, ready, missing } }`. |
| `OPTIONS *` | CORS preflight (GET, POST, PATCH) |

Every route but `GET /` and `/health` needs `Authorization: Bearer <Lark user_access_token>` unless `REQUIRE_LARK_LOGIN=false`; the `/searches` routes always need it (they read and write Lark as the person), and answer `503 searches_unavailable` with the login check off.

`POST /research`:

```json
{ "name": "Monoblock chair", "details": "white, with backrest", "depth": "quick", "search_id": "" }
```

- `depth`: `quick` (the default), `standard` or `thorough`. The depth picks the model (below). `check`, the old Quick web check, is read as `quick`.
- `search_id`: run a saved search again; the new record joins that search as its newest version.
- `kind` (`item` or `service`) and `unit` may be given as hints; otherwise Claude decides them, and the service guesses first from the words only to match past prices.

Every search is for the Philippines in pesos, new or used, with suppliers and past costings.

A refusal before the run starts is plain JSON, `{ "error": { "code", "message" } }`. The codes:

| Status | Codes |
| ------ | ----- |
| 400 | `bad_request`, `bad_input` |
| 401 | `login_required`, `login_expired`, `login_invalid` |
| 403 | `forbidden_origin`, `not_authorized` |
| 404 | `not_found` (a saved search that isn't in the table) |
| 413 | `too_large` |
| 415 | `bad_request` |
| 429 | `rate_limited`, with `Retry-After` |
| 502 | `table_changed` (a column is missing or of another type), `lark_error` |
| 503 | `busy`, `auth_unavailable`, `misconfigured`, `searches_unavailable`, `lark_unavailable` |

After that, the answer is `200 application/x-ndjson`: one JSON object per line.

| Line | When |
| ---- | ---- |
| `{"type":"start","id","search_id","model","depth","caps":{searches,fetches},"estimate_ms","max_run_usd"}` | first |
| `{"type":"activity","kind":"costings","count","pos","available"}` | when the past prices are in |
| `{"type":"activity","kind":"search","query"}`, `"search_done"`, `"fetch"`, `"fetch_done"`, `"filter"`, `"writing"`, `"checking"`, `"images"`, `"wrap_up"`, `"retry"` | as they happen |
| `{"type":"usage","cost_usd","searches","fetches"}` | after each request to Anthropic |
| `{"type":"ping"}` | every 15 s |
| `{"type":"report","report":{…}}` or `{"type":"error","error":{code,message}}` | exactly one |
| `{"type":"saved","saved":{…record}|null,"error":{code,message}|null}` | last, after a report |

A stream that ends without a `report` or `error` line was cut off. The save runs on its own clock after the report, so it finishes even if the page has gone (on Workers, `waitUntil` keeps it alive); a cancelled or failed run is never saved.

Run error codes: `refused`, `too_long`, `budget`, `timeout`, `no_report`, `cancelled`, `not_configured`, `quota_exceeded`, `upstream_unavailable`, `content_rejected` (Anthropic's own message, for example web search not enabled), `upstream_error`, `internal`. Save error codes (in `saved.error`): `not_saved` (no login), `login_expired`, `not_authorized`, `table_changed`, `too_large`, `lark_unavailable`, `lark_error`.

The report's shape is described at the top of `src/report.js`. It carries Claude's `kind` and `unit`, the `price` (`{ typical, low, high, q1, q3, n, confidence, included }`), and each listing's `image` and `verification.status`, which is one of:

| Status | Meaning |
| ------ | ------- |
| `checked` | The price was found in that page's text, a citation, or the filtering code's output near its address. |
| `link` | The page was seen, but its price wasn't confirmed. |
| `unverified` | The address never came back from anything. |

The evidence excerpts behind each check stay on the server: the page and the table get only the status.

## Saved searches

`src/searches.js`. A Lark Base table (default: the procurement Base's **Price searches**, `SEARCHES_TABLE_ID=tblYUSBGnqwDp0PN`), read and written with the person's own token, so Lark's sharing decides who sees the list and who can add to it.

| Column | Type | What |
| ------ | ---- | ---- |
| Item | text (first column) | what was asked |
| Typical price, Low price, High price | currency (PHP) or number | the price the page shows (empty when nothing counts) |
| Unit | text | Claude's unit |
| Confidence | single option | High, Medium, Low, No price |
| Details | text | |
| Summary | text | Claude's summary |
| Depth | single option | Quick, Standard, Thorough |
| Searched by, Searched on | Created by, Created time | Lark's own |
| Cost (USD) | number | what the run cost |
| Search ID | text | every version of a search shares it |
| Report | text | the whole report as JSON (a cell holds 100,000 characters; long reports lose their page list first, then old past-costings rows, then long notes) |

Item, Search ID and Report must be there; the others are filled when they are, as their type wants (the column types are read from the table and cached for 10 minutes). `POST /searches/setup` adds whichever are missing (`SETUP` lists them, in order).

**The price** is worked out with `src/stats.js`, the page's own file (`npm run check:shell` in the page checks they're identical): listings that count by default (seen in the research, pesos, comparable per unit, the same product, not a rental when buying, not over 12 months old, and new while there are at least 2 new ones), outliers set aside from 5 listings up, the median.

## Product photos

`src/images.js`. After the report is written, each listing's page (https, public hosts only, up to 12, 5 seconds in all) is read up to its `</head>` (400 KB at most) for the picture it names: `og:image`, `twitter:image`, a JSON-LD image, or `<link rel="image_src">`; https pictures only. Pages that refuse servers (Lazada, Shopee) get none, and the page shows a placeholder. The page loads the pictures itself, without a referrer.

## Past costings

`src/costings.js`. The CE line items anthropic-ce keeps for Suppliers' Line Items tab (one row per distinct CE line per workbook) live in the D1 database `ce-data`, bound here as `DB` too (`wrangler.toml`, read only). They hold internal costs, markups and client names, so:

- they're read **only with the Lark login check on** (the procurement table's readers, the same people who see the Line Items tab); with `REQUIRE_LARK_LOGIN=false` reports carry `costings.available: false`;
- Node has no D1, so on this computer they're "not available" (`GET /` says `costings.available: false`).

**Search:** the name's telling words (3+ letters; "chairs" becomes "chair"; everyday words like rental, service, per, day dropped; at most five) must all appear in the line's item name, description or remarks. Inactive, waived, free and contingency lines are skipped. Newest first, up to 40.

**Each line:** project, client, item and description, qty × frq per unit, unit cost (budgeted), markup, client price per unit, and the price actually paid per unit where a purchase order matched (`actual_php` ÷ qty × frq).

**Approved purchase requests** (`src/pos.js`): the Lark Procurement table (`LARK_BASE_TOKEN` / `LARK_TABLE_ID`, the same table the login check uses), searched as the signed-in person with Lark's `records/search`: `Status is Approved` and `Particulars_Item contains <each word>`, newest first, up to 30 lines. Only these columns are read: Request No., Status, Project Code, Project Name, Particulars_Item, Particulars_Quantity, Particulars_Unit Price, Particulars_Unit Price-Currency, Particulars_Price, Supplier Details_Supplier Name, Submitted at, Completed at; never the supplier bank details.

**As Claude's reference:** both are looked up before the research starts, and a short summary goes into Claude's request: up to six prices paid (with supplier, quantity and month), the middle budgeted cost from CE lines in the request's unit (the unit written in the request, else the CE lines' usual one; only when there are 3 or more and they roughly agree, otherwise their range with a note not to compare), and the suppliers' names. No client names.

**Rentals and lots:** a line that says rent, rental, hire or lease (or a CE line costed per day, hour, week or month) is a rental. When an item is priced to buy, rentals get `mismatch: "rental"` (the other way round for a rental request; never for services): they're shown but not counted, and Claude is told to leave them out of its comparison. Before the research the service guesses item or service from the words; after it, the past prices are marked again with Claude's `kind`. A purchase request whose unit price is really the whole lot (quantity 1 and "30 PCS" in the item, or a unit price equal to the line total) is divided to a unit price, with a `lot` note.

## Depths

| Depth | Model | Tools | Searches / page reads | Effort | Continuations | Notes |
| ----- | ----- | ----- | --------------------- | ------ | ------------- | ----- |
| `quick` | Claude Haiku 5.5 | `web_search_20250305`, `web_fetch_20250910` (Haiku has no dynamic filtering) | 4 / 6, 4,000 tokens a page | medium | 1 | the old Quick web check: marketplaces and social sites skipped (`SKIP_SITES`), retailers that publish prices suggested (`PH_RETAILERS`), the sellers' pages opened before reporting; capped at US$0.20 |
| `standard` | Claude Sonnet 5.5 | `web_search_20260318`, `web_fetch_20260318` (filtered in code) | 8 / 6 | medium | 2 | |
| `thorough` | Claude Opus 5.5 | the same | 12 / 10 | high | 4 | |

A depth's model that isn't in `MODELS` falls back to `DEFAULT_MODEL`. The counts include a search and a page read or two for suppliers, which every search lists.

## How a run works

- **Request:** `src/request.js` builds it: the depth's model and effort; `max_tokens` 64000, streaming, top-level `cache_control`; for Opus and Sonnet, `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta.
- **Tools:** web search localised to the Philippines (`user_location`), web fetch (`max_content_tokens` 6000, 4000 on Quick), and `submit_report`, a strict client tool. Every key is required and there are no unions, so it stays within the strict-schema limits (`tests/request.test.mjs`).
- **System prompt:** `prompt.md`. It never changes, so it stays cached; today's date and the request go in the user turn.
- **The loop** (`src/research.js`):
  - The conversation is append-only.
  - On `pause_turn` the answer goes back unchanged, with the same tools and the code container's id.
  - The run counts searches and cost itself. Past the depth's continuations, or at 70% of its spending cap, a system message asks Claude to stop and report.
  - An answer that ends without a report gets one nudge.
  - One retry for an overloaded or dropped answer.
- **The stream reader** (`src/sse.js`) rebuilds every block type exactly (thinking signatures, tool inputs, citations, results that arrive whole), so a paused turn can be sent back as received.
- **Checking** (`src/evidence.js`, `src/verify.js`): every URL, page text, code output (including the `EVIDENCE` lines the prompt asks for) and citation in the answers. Prices are normalised (₱, PHP, Php, P; commas, decimals, ranges) and compared as numbers to the centavo.

## Settings

| Setting | Default | |
| ------- | ------- | - |
| `ANTHROPIC_API_KEY` | (none) | Required. A Worker secret, or `.env` here. |
| `REQUIRE_LARK_LOGIN` | `true` | `false` only on 127.0.0.1 (`server.js` refuses to listen anywhere else). Saved searches and past costings need it on. |
| `LARK_BASE_TOKEN`, `LARK_TABLE_ID` | the procurement table | People who can open this table may use the service. |
| `SEARCHES_BASE_TOKEN`, `SEARCHES_TABLE_ID` | `LARK_BASE_TOKEN`, `tblYUSBGnqwDp0PN` | The saved searches table. |
| `ALLOWED_ORIGINS` | `http://127.0.0.1:9128` | The page(s) allowed to call it. Never `*` on a host. |
| `MODELS` | all three | The models the depths may use. |
| `DEFAULT_MODEL` | `claude-opus-5-5` | For a depth whose model isn't in `MODELS`. |
| `REFUSAL_FALLBACK` | `default` | `off` to drop the server-side refusal fallback. |
| `MAX_RUN_USD` | `2` | One run's spending limit (it's asked to wrap up at 70%). Quick has its own, US$0.20. |
| `MAX_OUTPUT_TOKENS` | `64000` | |
| `RATE_LIMIT_PER_HOUR` | `10` | Searches per person (per copy on Workers). |
| `READ_RATE_LIMIT_PER_HOUR` | `600` | Saved-search reads and changes per person. |
| `MAX_CONCURRENT` | `2` | Searches at once. |
| `REQUEST_TIMEOUT`, `RUN_TIMEOUT` | `300`, `480` | Seconds per Anthropic request, and per run. |
| `TZ_OFFSET_HOURS` | `8` | For "today's date" and log times. |
| `HOST`, `PORT` | `127.0.0.1`, `8003` | Node only. |
| `RECORD_RUNS` | off | Node only: `1` keeps each run's requests and answers in `runs/` (git-ignored). |

## Running locally

```
cp .env.example .env     # then add the key
npm start                # http://127.0.0.1:8003
```

Then open the page with `?svc=http://127.0.0.1:8003`. With the login check on (`REQUIRE_LARK_LOGIN=true` in `.env`), searches are saved to the real Lark table; past CE lines aren't available on Node.

`npm test` runs the offline tests, with Anthropic, Lark and the shops' pages faked: stream rebuilding, request building, the strict schema, price checking, the report, the run loop (pause, wrap-up, nudge, refusal, retry, cancel), the automatic save (also after the page has gone), the saved-search routes, the table setup, photos, and the Node server's streaming.

## Deploying

1. **Deploy:** `npx wrangler deploy` here (`wrangler.toml`: the Worker `anthropic-price-service`, with the `DB` binding to anthropic-ce's `ce-data`). If you deploy from the dashboard instead, add the D1 binding there: Settings > Bindings > D1 database, variable name `DB`, database `ce-data`. Render (`render.yaml`, `Dockerfile`) also works, without past CE lines.
2. **Settings:** `ANTHROPIC_API_KEY` as a secret, `REQUIRE_LARK_LOGIN` true, `ALLOWED_ORIGINS` set to the page's origin(s).
3. **The table, once:** log in on the page, then Settings > Saved searches table > **Add the missing columns** (as someone who can edit the table).
4. **Check it:** `GET /` answers with `service: "price-research"` and the new version. The page's `SERVICES.price.min` must not be newer.
5. **Every change:** bump `VERSION` (`src/service.js`) and `package.json`, and add a dated `CHANGELOG.md` entry.

Web research on Sonnet and Opus reads larger streams than Quick, and may exceed the Workers free plan's 10 ms of CPU (Quick measured 19-57 ms and finished every time). If Standard or Thorough fail with a CPU-limit error, move to Workers Paid and add `[limits] cpu_ms = 30000`.

## Cost

**Quick:** up to 4 searches (US$0.04) plus Haiku tokens: the old Quick web check measured US$0.025-0.09 a search; suppliers add a little.

**Standard and Thorough:** web search is US$10 per 1,000 searches, plus tokens (Sonnet 5.5 about half of Opus 5.5). Not measured yet.

Web fetch and the filtering code cost only tokens. Photos, past costings and saved searches cost nothing (D1 reads, Lark calls, a few page reads). Each report's `meta.cost_usd` says what it cost (`src/cost.js` holds the prices), the log line for each run has the tokens and the total, and the table keeps it.
