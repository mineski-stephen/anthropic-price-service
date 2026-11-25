# Changelog

Newest first. Each entry's number is `VERSION` in `src/service.js` and `version` in `package.json`.

## 0.6.1 · Nov 25, 2026

From the second signed-in test: two chair lines ("30 PCS MONOBLOCK CHAIR WITH BLACK COVER (NOVEMBER 4-6, 2026)", from a "Party Needs Rental" supplier) were still counted as purchases.

- A hire period in the item ("(3 days)", "NOVEMBER 4-6", "Nov. 12 to 23") marks it a rental, and so does a supplier whose name says rental. One request is one hire: if any of its lines is a rental, all of them are.
- The "costed per another unit" warning no longer counts rentals a second time.

## 0.6.0 · Nov 25, 2026

From the first signed-in test (monoblock chairs ×100): every past chair line was a rental, so the past price and Claude's comparison with "what Mineski paid" were wrong.

- **Rentals:** a purchase request or CE line that says rent, rental, hire or lease, or a CE line costed per day (hour, week, month), is a rental (`rental: true`). For an item to buy, rentals get `mismatch: "rental"` (and purchases get `mismatch: "purchase"` when the request is itself a rental): they're listed but not counted, with a warning, and Claude is told they're rental rates and to leave them out of the comparison. When Mineski has no past price of the same kind, Claude is told not to compare at all. Services aren't affected (a day rate isn't a rental).
- **Lot prices on purchase requests:** when the quantity is 1 and the item says "30 PCS", or the unit price equals the line total, the price is divided to a real unit price and the line carries a `lot` note.
- Units: "per day" and "day" are now the same unit, so a CE line's `per` of "per unit" matches a request per piece. The listing's basis no longer reads "per per day".

## 0.5.0 · Nov 25, 2026

- **Past purchase requests:** the service also searches the Lark Procurement table (the table the login check already uses) for approved requests that mention the item, as the signed-in person (`src/pos.js`). It reads only the item, quantity, unit price, currency, total, supplier, project, request number, status and dates, never the supplier bank details. Newest first, up to 30 lines. If Lark refuses the filter, it's tried once without the status condition.
- **Mineski's records as Claude's reference:** a web check now looks up past purchases and CE lines first, and gives Claude a short summary (prices paid with suppliers, the middle budgeted cost, no client names). Claude is asked to check those suppliers first, never to report the internal figures as listings, and to say in the summary how today's market compares; a difference over 30% goes in warnings. The prompt has a new "Mineski's own records" section.
- `report.costings` gains `pos`, `pos_available`, `pos_reason`, `ce_available` and `ce_reason`; it's available when either source answers. A past-costings check lists purchase requests (`verification.via: "po"`) before CE lines; they count toward the price only for piece-like units, since requests record no unit.
- The stream's `costings` activity adds `pos` (the count). `start` now always comes first.

## 0.4.1 · Nov 24, 2026

- The `check` depth's time estimate is now 32 seconds, as measured on the Worker (was 45).

## 0.4.0 · Nov 24, 2026

- New depth **`check`** for the page's Quick web check on Haiku: medium effort, 3 searches, **5 page reads** of 4,000 tokens each, its own US$0.15 cap. The request asks Claude to open the most useful offers' pages before reporting, suggests Philippine retailers that publish prices (for items in the Philippines), and skips Lazada, Shopee, Carousell and social sites (`SKIP_SITES`) unless the person chose their own site list.
- Sizes are converted to the requested unit (a 3 m × 4 m LED wall is 12 sqm), so per-wall or per-set service prices can count.
- A listing Claude left undated takes its search result's age ("1910 days ago", "March 3, 2021"), so old prices show as old.
- A depth may now cap its own spending below `MAX_RUN_USD`.

## 0.3.0 · Nov 24, 2026

- **Lazada removed** (`src/market.js`, `"source": "marketplace"`, the `MARKET_*` settings): Lazada answers Cloudflare's servers with its slider bot check, so it can't run where the service runs.
- **Past costings:** `"source": "costings"` searches anthropic-ce's CE line items (the D1 database `ce-data`, bound as `DB`) for the name's words and returns them as the report's listings: budgeted unit cost, markup, client price and, where a purchase order matched, what was actually paid. Free. Web reports carry them too, in `report.costings`. Only read with the Lark login check on, since they're internal; Node has no D1.
- **Haiku gets the plain web tools** (`web_search_20250305`, `web_fetch_20250910`): it has no dynamic filtering, so the filtering versions would be refused. This is the page's new Quick web check.
- The prompt's EVIDENCE lines now apply only when Claude filters results with code.
- New setting `COSTINGS_RATE_LIMIT_PER_HOUR` (default 120). `wrangler.toml` names the Worker `anthropic-price-service`, as deployed, and binds `DB`.

## 0.2.3 · Nov 24, 2026

- Lazada warm-up: when Lazada answers the data request with a bot check (as it did for the Cloudflare Worker), the service opens the ordinary search page first like a browser, following redirects by hand and keeping every cookie Lazada sets (`hng`, `hng.sig`), then asks for the data again with them. Tried once per check.
- The log says what Lazada sent when it refused (status, type, size, page title, whether it looks like a bot check) and whether the warm-up worked, without page text or cookie values.

## 0.2.2 · Nov 24, 2026

- Settings given as JSON values (Cloudflare's "JSON" variable type hands over `false`, `2`) or wrapped in quotes (`"false"`) are now read as the text they mean. Before, they were ignored and the default used: `REQUIRE_LARK_LOGIN` set to JSON `false` left login on.

## 0.2.1 · Nov 24, 2026

- After the first live Lazada checks: where Claude's summary, notes or warnings name a listing by its number ("Listing 22"), the product's name is put in its place, since the reader never sees the numbers. The prompt now asks for names and at most three warnings, and the service keeps at most four.
- New setting `MARKET_THINKING` (default true). `false` sends `thinking: {type: "disabled"}`: in live tests it sorted about as well and was up to twice as fast on long lists.

## 0.2.0 · Nov 24, 2026

- Lazada checks: `POST /research` with `"source": "marketplace"` reads Lazada's own search data (40 listings with exact prices, units sold, ratings) and has Claude Haiku 5.5 sort them (same thing or not, units per price, new or used) with structured output. About US$0.002 and a few seconds a check, no web search. Philippines, Singapore and Malaysia only.
- Prices come straight from Lazada, so every kept listing is `checked` with `via: "marketplace"`. Listings that aren't the same thing (or aren't new, when new was asked) are left out and counted in a warning. If Claude can't sort them, every listing is returned with a warning; a refused key or a cancel still stops the run.
- Lazada refusing the server (a check page instead of data) is the error `marketplace_blocked`, and nothing is sent to Anthropic.
- New settings `MARKET_MODEL` (default `claude-haiku-5-5`) and `MARKET_RATE_LIMIT_PER_HOUR` (default 60). `GET /` lists `marketplace`.
- `wrangler.toml` no longer asks for 30 s of CPU, so it deploys on the Workers free plan. Lazada checks fit it; web research probably doesn't.
- Requests without `source` are web research, as before.

## 0.1.0 · Nov 23, 2026

- First version: `POST /research` researches the current market price of an item or service with Claude (Opus 5.5 by default; Sonnet 5.5 and Haiku 5.5 allowed) using web search (localised to the market, filtered in code) and web fetch, and answers with a stream of JSON lines: progress, then the report.
- The report comes from a strict `submit_report` tool. Every listing is checked against what the research saw (page text, citations, the filtering code's EVIDENCE lines): `checked`, `link` or `unverified`. Supplier contacts are checked against the supplier's own pages.
- Paused turns are continued exactly (same tools, the code container's id, the answer sent back unchanged). The run keeps its own count: past the depth's continuations or 70% of `MAX_RUN_USD` it asks Claude to wrap up; an answer without a report gets one nudge.
- Cancel reaches Anthropic: when the page goes away the run's request is aborted.
- Lark login check (copied from anthropic-ce), on by default; `REQUIRE_LARK_LOGIN=false` only on 127.0.0.1. Per-person rate limit, two runs at once, one run's cost cap, the refusal fallback for Opus and Sonnet.
- Node (`server.js`, reads `.env`, listens on 127.0.0.1:8003) and Cloudflare Workers (`src/worker.js`) from the same code. Not deployed.
