// The report the page receives, and what a run costs. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, cleanListing, webUrl } from "../src/report.js";
import { collectEvidence } from "../src/evidence.js";
import { readInput } from "../src/request.js";
import { createTally, tokenCost } from "../src/cost.js";
import { researchBlocks, REPORT, strip } from "./helpers.mjs";

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} is not ${b}`);

const input = readInput({ name: "Monoblock chair", quantity: 200, city: "Manila" });
const run = (extra = {}) => {
  const tally = createTally();
  tally.add("claude-opus-5-5", { input_tokens: 20000, output_tokens: 4000, cache_read_input_tokens: 10000, server_tool_use: { web_search_requests: 5, web_fetch_requests: 3 } });
  return { requests: 1, continuations: 0, models: ["claude-opus-5-5"], ended: "submitted", tally, ...extra };
};
const build = (raw = REPORT, r = run()) => buildReport({ input, raw, ev: collectEvidence(strip(researchBlocks())), run: r, id: "r1",
  createdAt: "2026-11-23T01:00:00.000Z", service: { name: "price-research", version: "0.1.0", runtime: "node" }, startedAt: Date.now() - 1000 });

test("the report carries checked listings with unit and comparable prices", () => {
  const r = build();
  assert.equal(r.schema, 1);
  assert.equal(r.currency, "PHP");
  assert.equal(r.category, "Equipment & Furniture");
  assert.deepEqual(r.listings.map((l) => l.verification.status), ["checked", "checked", "checked", "link", "unverified"]);
  const pack = r.listings[3];
  assert.equal(pack.unit_price, 1200, "₱4,800 for 4");
  assert.equal(pack.comparable_price, 1344, "VAT excluded, so 12% is added to compare");
  assert.equal(r.listings[0].comparable_price, 1299);
  assert.equal(r.listings[0].host, "ace-example.ph");
  assert.equal(r.suppliers[0].contact.status, "checked");
  assert.equal(r.request.name, "Monoblock chair");
});

test("the service adds its own warnings: unseen links, unreadable pages", () => {
  const r = build();
  const service = r.warnings.filter((w) => w.from === "service").map((w) => w.text).join(" ");
  assert.match(service, /1 listing links to a page the research never saw/);
  assert.match(service, /1 page couldn't be opened/);
});

test("sources list the searches and the pages, without page text", () => {
  const r = build();
  assert.equal(r.sources.queries[0].query, "monoblock chair price philippines");
  assert.ok(r.sources.pages.some((p) => p.host === "ace-example.ph" && p.fetched));
  assert.ok(!JSON.stringify(r.sources).includes("Bulk orders"), "page text stays on the server");
});

test("meta has the cost, usage and how the run ended", () => {
  const r = build();
  assert.equal(r.meta.usage.web_search_requests, 5);
  assert.equal(r.meta.cost_usd.searches, 0.05);
  near(r.meta.cost_usd.total, 0.212);
  assert.equal(r.meta.ended, "submitted");
  assert.equal(r.meta.depth, "standard");
  assert.equal(r.meta.effort, "medium");
  assert.equal(r.meta.fallback, false);
});

test("listings are tidied: odd values fixed, unsafe links dropped, duplicates removed", () => {
  const c = cleanListing({ url: "javascript:alert(1)", title: "  A   chair ", price: "-5", currency: "php", vat: "VAT-EX", seller_type: "Retailer" });
  assert.equal(c.url, "");
  assert.equal(c.title, "A chair");
  assert.equal(c.price, 0);
  assert.equal(c.currency, "PHP");
  assert.equal(c.vat, "not_stated");
  assert.equal(c.seller_type, "retailer");
  assert.equal(webUrl("https://a.ph/x"), "https://a.ph/x");
  const dup = { ...REPORT, listings: [REPORT.listings[0], { ...REPORT.listings[0], url: "https://www.ace-example.ph/products/monoblock-chair/?utm_source=x" }] };
  assert.equal(build(dup).listings.length, 1);
});

test("a listing in another currency has no comparable price", () => {
  const r = build({ ...REPORT, listings: [{ ...REPORT.listings[0], currency: "USD" }] });
  assert.equal(r.listings[0].comparable_price, null);
});

test("a report with nothing in it still builds", () => {
  const r = build({});
  assert.deepEqual(r.listings, []);
  assert.deepEqual(r.suppliers, []);
  assert.equal(r.interpreted, "Monoblock chair");
});

test("costs: tokens per model, the search fee, Haiku's long-prompt price", () => {
  assert.equal(tokenCost("claude-opus-5-5", { input_tokens: 1e6 }), 4);
  assert.equal(tokenCost("claude-sonnet-5-5", { output_tokens: 1e6 }), 10);
  near(tokenCost("claude-haiku-5-5", { input_tokens: 50000 }), 0.005);
  near(tokenCost("claude-haiku-5-5", { input_tokens: 200000 }), 0.1, "over 100,000 prompt tokens Haiku costs $0.50 per million");
  assert.equal(tokenCost("some-other-model", { input_tokens: 1 }), null);
  const t = createTally();
  t.add("claude-opus-5-5", { input_tokens: 1000, server_tool_use: { web_search_requests: 3 } });
  t.add("claude-opus-5-5", { output_tokens: 1000, server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } });
  assert.equal(t.usage.web_search_requests, 5);
  assert.equal(t.usage.web_fetch_requests, 1);
  near(t.cost.searches, 0.05);
  near(t.cost.total, 0.074);
});

test("pageAgeDate reads a search result's age", async () => {
  const { pageAgeDate } = await import("../src/report.js");
  const now = Date.parse("2026-11-24T00:00:00Z");
  assert.equal(pageAgeDate("2026-11-01", now), "2026-11-01");
  assert.equal(pageAgeDate("1910 days ago", now), "2021-09-01");
  assert.equal(pageAgeDate("3 years ago", now).slice(0, 4), "2023");
  assert.equal(pageAgeDate("March 3, 2021", now), "2021-03-03");
  assert.equal(pageAgeDate("", now), "");
  assert.equal(pageAgeDate("recently", now), "");
});
