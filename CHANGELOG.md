# Changelog

Newest first. Each entry's number is `VERSION` in `src/service.js` and `version` in `package.json`.

## 0.1.0 · Nov 23, 2026

- First version: `POST /research` researches the current market price of an item or service with Claude (Opus 5.5 by default; Sonnet 5.5 and Haiku 5.5 allowed) using web search (localised to the market, filtered in code) and web fetch, and answers with a stream of JSON lines: progress, then the report.
- The report comes from a strict `submit_report` tool. Every listing is checked against what the research saw (page text, citations, the filtering code's EVIDENCE lines): `checked`, `link` or `unverified`. Supplier contacts are checked against the supplier's own pages.
- Paused turns are continued exactly (same tools, the code container's id, the answer sent back unchanged). The run keeps its own count: past the depth's continuations or 70% of `MAX_RUN_USD` it asks Claude to wrap up; an answer without a report gets one nudge.
- Cancel reaches Anthropic: when the page goes away the run's request is aborted.
- Lark login check (copied from anthropic-ce), on by default; `REQUIRE_LARK_LOGIN=false` only on 127.0.0.1. Per-person rate limit, two runs at once, one run's cost cap, the refusal fallback for Opus and Sonnet.
- Node (`server.js`, reads `.env`, listens on 127.0.0.1:8003) and Cloudflare Workers (`src/worker.js`) from the same code. Not deployed.
