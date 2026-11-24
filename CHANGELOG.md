# Changelog

Newest first. Each entry's number is `VERSION` in `src/service.js` and `version` in `package.json`.

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
