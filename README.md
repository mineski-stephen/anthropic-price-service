# price-research

The price check demo's service. It prices an item or service in one of two ways, and streams progress and the report back to the page:

- **Lazada** (`"source": "marketplace"`): Lazada's own search data, sorted by Claude Haiku 5.5. A few seconds, about US$0.002 a check. See [Lazada checks](#lazada-checks).
- **Web research** (`"source": "web"`, the default): Claude with web search, then every listing is checked against what the research actually saw. One to four minutes, US$0.15-3.

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

## Lazada checks

`src/market.js`, for `"source": "marketplace"` (markets PH, SG and MY; others are refused with `bad_input`):

1. **Lazada's search data.** `GET https://www.lazada.com.ph/catalog/?ajax=true&page=1&q=<name>` answers with JSON: 40 listings with the exact price, crossed-out price, seller, brand, units sold, rating, location, stock and whether it's sponsored. The name is searched alone; the details go to Claude.
   - This is not an official interface. Lazada may change it, or refuse a server (it answers with a check page instead of data).
   - When refused, the service warms up once like a browser: it opens the ordinary search page (keeping the `hng` session cookies Lazada sets, through any redirects) and asks again. If that's refused too, the error is `marketplace_blocked`, and nothing is sent to Anthropic. The log line says what Lazada sent.
   - It worked from this computer on Nov 24, 2026 (40 listings in 0.3 to 0.5 s; reading them took 0.7 ms of CPU). **From Cloudflare Workers it was refused** the same day: Lazada answered the deployed Worker with a check page (HTTP 200, no listing data), so the check ended with `marketplace_blocked` at no cost. Lazada checks need a host whose address Lazada accepts.
2. **Claude Haiku 5.5 sorts them.** One request, no tools, `output_config.format` (structured output) with `effort: "low"`: for each listing, the match (exact, close, substitute, different), how many units the price buys ("4pcs" = 4), and the condition. It only labels listings; it never supplies a price.
3. **The report** has web research's shape, with `meta.source: "lazada"` and `meta.depth: "marketplace"`. Listings marked different, or not new when new was asked, are left out and counted in a warning. Every kept listing is `checked` with `via: "marketplace"`. Suppliers are empty.
4. **If Claude fails** (overloaded, unreadable answer), every listing comes back unsorted with a warning. A refused key, a usage limit or a cancel still stops the run.

The stream: `start` (with `source`), `activity` `market_search`, `market_results` (count), `sorting`, `usage`, `activity` `checking`, then `report` or `error`.

**CPU:** reading about 200 KB of JSON and a short Claude answer takes a few milliseconds, so Lazada checks should fit the Cloudflare Workers free plan (10 ms of CPU per request; waiting on the network doesn't count). Not measured on Cloudflare yet.

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
| `MARKET_MODEL` | `claude-haiku-5-5` | The model that sorts Lazada listings. |
| `MARKET_RATE_LIMIT_PER_HOUR` | `60` | Lazada checks per person (per copy on Workers). |
| `MARKET_THINKING` | `true` | `false`: the sorting model answers without thinking first (faster, about as good in tests). |
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
   - **Cloudflare Workers:** `wrangler.toml`. Lazada checks should fit the free plan. Web research reads large streams and will probably exceed the free plan's 10 ms of CPU; on Workers Paid add `[limits] cpu_ms = 30000`.
   - After deploying, run one Lazada check first. If it answers `marketplace_blocked`, Lazada is refusing Cloudflare's servers: use Render instead.
2. **Set the settings:** `ANTHROPIC_API_KEY` as a secret, `REQUIRE_LARK_LOGIN` true, and `ALLOWED_ORIGINS` set to the hosted page's origin.
3. **Deploy the service first, then the page.** Add the service's address to `SERVICES.price.urls` and to the CSP's `connect-src` in `index.html`.
4. **Check it:** `GET /` answers with `service: "price-research"` and the new version. Then raise `SERVICES.price.min` in the page.
5. **Every change:** bump `VERSION` (`src/service.js`) and `package.json`, and add a dated `CHANGELOG.md` entry.

## Cost

**Lazada checks:** tokens only on Haiku 5.5 (US$0.10 / US$0.50 per million). Measured on Nov 24, 2026: about 5,000 tokens in and 2,200 to 5,800 out, so US$0.0016 to US$0.0034 a check (see the page's README for the test set).

**Web research:** web search is US$10 per 1,000 searches, plus tokens. Web fetch and the filtering code cost only tokens. Each report's `meta.cost_usd` says what it cost (`src/cost.js` holds the prices), and the log line for each run has the tokens and the total.
