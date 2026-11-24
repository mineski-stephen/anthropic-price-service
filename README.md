# price-research

The price check demo's service. It prices an item or service in one of two ways, and streams progress and the report back to the page:

- **Past costings** (`"source": "costings"`): Mineski's own CE lines from anthropic-ce's D1 database. Free, about a second. See [Past costings](#past-costings).
- **Web research** (`"source": "web"`, the default): Claude with web search, then every listing is checked against what the research actually saw, with past costings added alongside. On Haiku 5.5 at Quick depth (the page's "Quick web check") under a minute and a few cents; on Opus one to four minutes, US$0.15-3.

It holds the Anthropic key, so the page never does. It does one narrow job ("research this price"), not a general Claude relay. It's built the same way as `tech/anthropic-ce`, with no npm dependencies and no build step: one `src/service.js` runs on Node (`server.js`) and on Cloudflare Workers (`src/worker.js`).

**Deployed from:** not deployed. It runs on this computer for the demo, at http://127.0.0.1:8003.

```
page ──POST /research──▶ checks (origin → Lark login → JSON body → rate limit → a free slot)
     ◀── NDJSON stream ── run: Messages API (stream) ⇄ pause_turn / wrap-up / nudge
                          tools: web_search_20260318 + web_fetch_20260318 + submit_report (strict)
                          then: evidence (pages, code output, citations) → verify each listing → report
```

## Endpoints

| Method and path | What it does |
| --------------- | ------------ |
| `GET /` | Service, version, runtime, models, depths, markets, limits, `cors.allow_headers`, login. Open to any origin and never cached; the page calls it to wake and check the service. |
| `GET /health` | `{"status":"ok"}` |
| `POST /research` | Runs one check (below). |
| `OPTIONS *` | CORS preflight |

`POST /research` needs `Authorization: Bearer <Lark user_access_token>` unless `REQUIRE_LARK_LOGIN=false`.

```json
{ "source": "web", "kind": "item", "name": "Monoblock chair", "details": "white, with backrest", "quantity": 200, "unit": "piece",
  "market": "PH", "city": "Manila", "condition": "new", "depth": "standard", "suppliers": true,
  "model": "claude-opus-5-5", "sites": { "mode": "none", "list": [] } }
```

A refusal before the run starts is plain JSON, `{ "error": { "code", "message" } }`. The codes:

| Status | Codes |
| ------ | ----- |
| 400 | `bad_request`, `bad_input` |
| 401 | `login_required`, `login_expired`, `login_invalid` |
| 403 | `forbidden_origin`, `not_authorized` |
| 413 | `too_large` |
| 415 | `bad_request` |
| 429 | `rate_limited`, with `Retry-After` |
| 503 | `busy`, `auth_unavailable`, `misconfigured` |

After that, the answer is `200 application/x-ndjson`: one JSON object per line.

| Line | When |
| ---- | ---- |
| `{"type":"start","id","model","depth","caps":{searches,fetches},"estimate_ms","max_run_usd"}` | first |
| `{"type":"activity","kind":"search","query"}`, `"search_done"`, `"fetch"`, `"fetch_done"`, `"filter"`, `"writing"`, `"checking"`, `"wrap_up"`, `"retry"` | as they happen |
| `{"type":"usage","cost_usd","searches","fetches"}` | after each request to Anthropic |
| `{"type":"ping"}` | every 15 s |
| `{"type":"report","report":{…}}` or `{"type":"error","error":{code,message}}` | exactly one, last |

A stream that ends without a `report` or `error` line was cut off.

Run error codes:

- `refused`
- `too_long`
- `budget`
- `timeout`
- `no_report`
- `cancelled`
- `not_configured`
- `quota_exceeded`
- `upstream_unavailable`
- `content_rejected` (Anthropic's own message, for example web search not enabled)
- `upstream_error`
- `internal`

The report's shape is described at the top of `src/report.js`. Each listing carries `verification.status`, which is one of:

| Status | Meaning |
| ------ | ------- |
| `checked` | The price was found in that page's text, a citation, or the filtering code's output near its address. |
| `link` | The page was seen, but its price wasn't confirmed. |
| `unverified` | The address never came back from anything. |

## Past costings

`src/costings.js`. The CE line items anthropic-ce keeps for Suppliers' Line Items tab (one row per distinct CE line per workbook) live in the D1 database `ce-data`, bound here as `DB` too (`wrangler.toml`, read only). They hold internal costs, markups and client names, so:

- they're read **only with the Lark login check on** (the procurement table's readers, the same people who see the Line Items tab); with `REQUIRE_LARK_LOGIN=false` a past-costings check is refused (`costings_unavailable`) and web reports carry `costings.available: false`;
- Node has no D1, so on this computer they're "not available" (`GET /` says `costings.available: false`).

**Search:** the name's telling words (3+ letters; "chairs" becomes "chair"; everyday words like rental, service, per, day dropped; at most five) must all appear in the line's item name, description or remarks. Inactive, waived, free and contingency lines are skipped. Newest first, up to 40.

**Each line:** project, client, item and description, qty × frq per unit, unit cost (budgeted), markup, client price per unit, and the price actually paid per unit where a purchase order matched (`actual_php` ÷ qty × frq).

- `"source": "costings"`: the lines become the report's listings (`verification.via: "costings"`, no links), so the page works out the typical price from them. Lines in another unit than the request aren't counted, unless none match. `meta.source: "costings"`, no cost.
- `"source": "web"`: the search runs alongside the research, and the report carries `costings: { available, reason, terms, lines }`.

The stream adds `activity` `costings` (`count`, `available`).

## Quick web check (Haiku)

Claude Haiku 5.5 has no dynamic filtering, so with Haiku the service sends the plain tools, `web_search_20250305` and `web_fetch_20250910`; Opus and Sonnet keep `web_search_20260318` / `web_fetch_20260318`. Everything else is the same run.

The page's Quick web check is `model: "claude-haiku-5-5"`, `depth: "check"`, `suppliers: false`. The `check` depth:

| | |
| - | - |
| Effort | medium |
| Searches / page reads | 3 / 5, each page read up to 4,000 tokens |
| Spending cap | US$0.15 (below `MAX_RUN_USD`) |
| Sites | Lazada, Shopee, Carousell, Facebook, TikTok and Instagram skipped (`SKIP_SITES`), unless the request has its own site list |
| Instructions | open the most useful offers' pages before reporting; for items in the Philippines, prefer retailers that publish prices (`PH_RETAILERS`) |

Undated listings take their search result's age, so the page leaves offers over 12 months old out of the typical price.

## How a web research run works

- **Request:** `src/request.js` builds it:
  - model;
  - effort by depth (Quick low, Standard medium, Thorough high);
  - `max_tokens` 64000, streaming, top-level `cache_control`;
  - for Opus and Sonnet, `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta.
- **Tools:**
  - `web_search_20260318`:
    - `max_uses` 3 / 6 / 10 by depth, +2 with suppliers;
    - `user_location` set to the market and city;
    - dynamic filtering: Claude filters the results in code.
  - `web_fetch_20260318`: `max_uses` 2 / 4 / 8, +2 with suppliers; `max_content_tokens` 6000.
  - `submit_report`: a strict client tool. Every key is required and there are no unions, so it stays within the strict-schema limits (`tests/request.test.mjs`).
- **System prompt:** `prompt.md`. It never changes, so it stays cached; today's date and the request go in the user turn.
- **The loop** (`src/research.js`):
  - The conversation is append-only.
  - On `pause_turn` the answer goes back unchanged, with the same tools and the code container's id.
  - The run counts searches and cost itself. Past the depth's continuations (1 / 2 / 4), or at 70% of `MAX_RUN_USD`, a system message asks Claude to stop and report.
  - An answer that ends without a report gets one nudge.
  - One retry for an overloaded or dropped answer.
- **The stream reader** (`src/sse.js`) rebuilds every block type exactly (thinking signatures, tool inputs, citations, results that arrive whole), so a paused turn can be sent back as received.
- **Checking** (`src/evidence.js`, `src/verify.js`): every URL, page text, code output (including the `EVIDENCE` lines the prompt asks for) and citation in the answers. Prices are normalised (₱, PHP, Php, P; commas, decimals, ranges) and compared as numbers to the centavo.

## Settings

| Setting | Default | |
| ------- | ------- | - |
| `ANTHROPIC_API_KEY` | (none) | Required. In `.env` here, or the host's secrets. |
| `REQUIRE_LARK_LOGIN` | `true` | `false` only on 127.0.0.1 (`server.js` refuses to listen anywhere else). |
| `LARK_BASE_TOKEN`, `LARK_TABLE_ID` | the procurement table | People who can open this table may use it. |
| `ALLOWED_ORIGINS` | `http://127.0.0.1:9128` | The page(s) allowed to call it. Never `*` on a host. |
| `MODELS` | all three | Which models people may pick. |
| `DEFAULT_MODEL` | `claude-opus-5-5` | |
| `REFUSAL_FALLBACK` | `default` | `off` to drop the server-side refusal fallback. |
| `MAX_RUN_USD` | `2` | One run's spending limit (it's asked to wrap up at 70%). |
| `MAX_OUTPUT_TOKENS` | `64000` | |
| `RATE_LIMIT_PER_HOUR` | `10` | Runs per person (per copy on Workers). |
| `MAX_CONCURRENT` | `2` | Runs at once. |
| `COSTINGS_RATE_LIMIT_PER_HOUR` | `120` | Past-costings-only checks per person (per copy on Workers). |
| `REQUEST_TIMEOUT`, `RUN_TIMEOUT` | `300`, `480` | Seconds per Anthropic request, and per run. |
| `TZ_OFFSET_HOURS` | `8` | For "today's date" and log times. |
| `HOST`, `PORT` | `127.0.0.1`, `8003` | Node only. |
| `RECORD_RUNS` | off | Node only: `1` keeps each run's requests and answers in `runs/` (git-ignored). |

## Running locally

```
cp .env.example .env     # then add the key
npm start                # http://127.0.0.1:8003
```

`npm test` runs the offline tests, with Anthropic and Lark faked: stream rebuilding, request building, the strict schema, price checking, the report, the run loop (pause, wrap-up, nudge, refusal, retry, cancel) and the Node server's streaming.

## Deploying (not done yet)

1. **Choose a host.**
   - **Render:** `render.yaml` and the `Dockerfile`, Node, no CPU limit. The free plan sleeps, and the page wakes it.
   - **Cloudflare Workers:** `wrangler.toml` (deployed as `anthropic-price-service`, with the `DB` binding to anthropic-ce's `ce-data`). Past costings and the Haiku quick check are light; web research on Opus reads larger streams and may exceed the free plan's 10 ms of CPU (on Workers Paid add `[limits] cpu_ms = 30000`).
   - If you deploy from the dashboard rather than `wrangler deploy`, add the D1 binding there: Settings > Bindings > D1 database, variable name `DB`, database `ce-data`.
2. **Set the settings:** `ANTHROPIC_API_KEY` as a secret, `REQUIRE_LARK_LOGIN` true, and `ALLOWED_ORIGINS` set to the hosted page's origin.
3. **Deploy the service first, then the page.** Add the service's address to `SERVICES.price.urls` and to the CSP's `connect-src` in `index.html`.
4. **Check it:** `GET /` answers with `service: "price-research"` and the new version. Then raise `SERVICES.price.min` in the page.
5. **Every change:** bump `VERSION` (`src/service.js`) and `package.json`, and add a dated `CHANGELOG.md` entry.

## Cost

**Past costings:** free (one D1 query; D1's free plan allows 5 million reads a day).

**Quick web check:** up to 3 searches (US$0.03) plus Haiku tokens: measured at US$0.025-0.036 a check on the Worker, with 29-40 ms of CPU (above the free plan's stated 10 ms, but both runs finished).

**Web research:** web search is US$10 per 1,000 searches, plus tokens. Web fetch and the filtering code cost only tokens. Each report's `meta.cost_usd` says what it cost (`src/cost.js` holds the prices), and the log line for each run has the tokens and the total.
