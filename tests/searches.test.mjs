// Saved searches (searches.js) and product photos (images.js), offline. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { cellString, slimReport, packReport, recordFields, fromRecord, reportOf, isReport, newSearchId, COLUMNS, MAX_REPORT_CHARS } from "../src/searches.js";
import { imageIn, openable, findImages } from "../src/images.js";
import { priceOf } from "../src/stats.js";

const listing = (id, price, extra = {}) => ({ id, url: `https://shop-${id}.example.ph/p`, title: `Chair ${id}`, seller: "Shop", seller_type: "retailer",
  price_text: `₱${price}`, price, regular_price: 0, currency: "PHP", units_in_price: 1, price_basis: "per piece", vat: "included", condition: "new",
  match: "exact", availability: "in_stock", page_date: "2026-11", notes: "", image: "", host: `shop-${id}.example.ph`, unit_price: price,
  comparable_price: price, verification: { status: "checked", via: "page_text", evidence: [{ url: "x", excerpt: "secret page text" }] }, ...extra });
const REPORT = {
  schema: 1, id: "r1", created_at: "2026-11-27T01:00:00Z", request: { name: "Monoblock chair", details: "white", depth: "quick", model: "claude-haiku-5-5", search_id: "" },
  search_id: "psabc12345", interpreted: "Monoblock chair", kind: "item", category: "Equipment & Furniture", unit: "piece", currency: "PHP",
  summary: "About PHP 900.", assumptions: [], warnings: [],
  listings: [listing("l1", 800), listing("l2", 900), listing("l3", 1000, { condition: "used" }), listing("l4", 950)],
  suppliers: [{ id: "s1", name: "Shop", type: "retailer", website: "", phone: "", email: "", city: "", offers: "Chairs", source_url: "", host: "", contact: { status: "none", via: "" } }],
  costings: null, sources: { queries: [{ query: "chair price", results: 5, error: null }], pages: [] },
  meta: { service: "price-research", version: "0.7.0", runtime: "node", source: "web", model: "claude-haiku-5-5", models_used: ["claude-haiku-5-5"], fallback: false,
    effort: "medium", depth: "quick", duration_ms: 1000, requests: 1, continuations: 0, ended: "submitted",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 2, web_fetch_requests: 1 },
    cost_usd: { tokens: 0.01, searches: 0.02, total: 0.03 }, priced: true },
};
const TYPES = new Map([["Item", 1], ["Details", 1], ["Typical price", 99003], ["Low price", 2], ["High price", 2], ["Unit", 1], ["Confidence", 3],
  ["Depth", 3], ["Summary", 1], ["Search ID", 1], ["Report", 1], ["Cost (USD)", 2], ["Searched by", 1003]]);

test("a Lark text cell reads back exactly, web addresses and all", () => {
  const json = '{"url":"https://a.ph/x","n":1}';
  // Lark hands text back in pieces, a web address as a piece of its own.
  const cell = [{ type: "text", text: '{"url":"' }, { type: "url", text: "https://a.ph/x", link: "https://a.ph/x" }, { type: "text", text: '","n":1}' }];
  assert.equal(cellString(cell), json);
  assert.equal(cellString("plain"), "plain");
  assert.equal(cellString(12.5), "12.5");
  assert.equal(cellString(null), "");
  assert.deepEqual(reportOf({ fields: { Report: [{ type: "text", text: JSON.stringify(REPORT) }] } }).listings.length, 4);
  assert.equal(reportOf({ fields: { Report: "not json" } }), null);
});

test("the report the page gets and Lark keeps has no page text", () => {
  const slim = slimReport(REPORT);
  assert.ok(slim.listings.every((l) => !("evidence" in l.verification) && l.verification.status === "checked"));
  assert.ok(!JSON.stringify(slim).includes("secret page text"));
  assert.equal(REPORT.listings[0].verification.evidence.length, 1, "the original isn't changed");
});

test("a report too big for one Lark cell is trimmed, least useful first", () => {
  const pages = Array.from({ length: 80 }, (_, i) => ({ url: `https://p${i}.example.ph/${"x".repeat(300)}`, host: "p.example.ph", title: "t".repeat(200), fetched: true }));
  const lines = Array.from({ length: 40 }, () => ({ particular: "x".repeat(2000), unit_cost: 1 }));
  const big = { ...REPORT, sources: { queries: REPORT.sources.queries, pages }, costings: { available: true, lines, pos: [] } };
  const text = packReport(big);
  assert.ok(text.length <= MAX_REPORT_CHARS);
  const back = JSON.parse(text);
  assert.equal(back.trimmed, true);
  assert.equal(back.listings.length, 4, "listings are never dropped");
  assert.equal(JSON.parse(packReport(REPORT)).trimmed, undefined, "a normal report isn't touched");
});

test("a record's cells follow the table's column types, and only the columns it has", () => {
  const report = { ...REPORT, price: priceOf(REPORT) };
  const f = recordFields(report, TYPES);
  assert.equal(f.Item, "Monoblock chair");
  assert.equal(f["Typical price"], 900, "the used one is left out while there are new ones");
  assert.equal(f["Low price"], 800);
  assert.equal(f.Depth, "Quick");
  assert.equal(f.Confidence, "Medium");
  assert.equal(f["Cost (USD)"], 0.03);
  assert.equal(typeof f.Report, "string");
  assert.ok(!("Searched by" in f));
  const none = recordFields({ ...report, price: priceOf(report, []) }, TYPES);
  assert.equal(none["Typical price"], null, "no price clears the number");
  assert.equal(none.Confidence, "No price");
  const few = recordFields(report, new Map([["Item", 1], ["Search ID", 1], ["Report", 1]]));
  assert.deepEqual(Object.keys(few).sort(), ["Item", "Report", "Search ID"]);
});

test("a record reads back light: numbers, labels as keys, who and when", () => {
  const r = fromRecord({ record_id: "recA1", created_time: Date.UTC(2026, 10, 27, 3), created_by: { id: "ou_1", name: "Ana", email: "a@example.com" },
    fields: { [COLUMNS.item]: [{ type: "text", text: "AA batteries" }], [COLUMNS.typical]: 56.5, [COLUMNS.low]: "50", [COLUMNS.depth]: "Standard",
      [COLUMNS.confidence]: "High", [COLUMNS.searchId]: [{ type: "text", text: "psxyz98765" }] } });
  assert.deepEqual([r.record_id, r.item, r.typical, r.low, r.high, r.depth, r.confidence, r.search_id], ["recA1", "AA batteries", 56.5, 50, null, "standard", "high", "psxyz98765"]);
  assert.equal(r.created_at, "2026-11-27T03:00:00.000Z");
  assert.deepEqual(r.by, { id: "ou_1", name: "Ana" }, "no email kept");
});

test("only a report this service made may be saved; new search ids look right", () => {
  assert.ok(isReport(REPORT));
  assert.ok(!isReport({ ...REPORT, schema: 2 }));
  assert.ok(!isReport({ ...REPORT, request: { name: "x" } }));
  assert.ok(!isReport(null));
  assert.match(newSearchId(), /^ps[a-z0-9]{10,}$/);
});

test("a page's photo: og:image first, then twitter:image, JSON-LD, or image_src; https only", () => {
  const page = "https://www.shop.example.ph/p/chair";
  assert.equal(imageIn('<meta property="og:image" content="https://cdn.example.ph/a.jpg?x=1&amp;y=2">', page), "https://cdn.example.ph/a.jpg?x=1&y=2");
  assert.equal(imageIn("<meta content='/img/b.png' property='og:image'>", page), "https://www.shop.example.ph/img/b.png", "relative, resolved");
  assert.equal(imageIn('<meta name="twitter:image" content="//cdn.example.ph/c.webp">', page), "https://cdn.example.ph/c.webp");
  assert.equal(imageIn('<script type="application/ld+json">{"@type":"Product","image":["https:\\/\\/cdn.example.ph\\/d.jpg"]}</script>', page), "https://cdn.example.ph/d.jpg");
  assert.equal(imageIn('<link rel="image_src" href="https://cdn.example.ph/e.jpg">', page), "https://cdn.example.ph/e.jpg");
  assert.equal(imageIn('<meta property="og:image" content="http://cdn.example.ph/f.jpg">', page), "", "plain http isn't kept");
  assert.equal(imageIn('<meta property="og:image" content="javascript:alert(1)">', page), "");
  assert.equal(imageIn("<html><head></head></html>", page), "");
});

test("only public https pages are opened for photos", async () => {
  assert.ok(openable("https://www.acehardware.ph/p/1"));
  for (const bad of ["http://a.ph/x", "https://127.0.0.1/x", "https://localhost/x", "https://router.local/x", "https://[::1]/x", "https://user:pw@a.ph/x", "ftp://a.ph", "nonsense"]) {
    assert.equal(openable(bad), false, bad);
  }
  const seen = [];
  const fake = async (url) => {
    seen.push(url);
    if (url.includes("slow")) return new Promise(() => {});   // never answers, and ignores the abort
    return new Response('<head><meta property="og:image" content="https://cdn.example.ph/p.jpg"></head>', { headers: { "Content-Type": "text/html" } });
  };
  const started = Date.now();
  const got = await findImages([{ url: "https://a.example.ph/p" }, { url: "https://a.example.ph/p" }, { url: "https://slow.example.ph/p" }, { url: "http://b.example.ph/p" }],
    { fetch: fake, timeoutMs: 200 });
  assert.ok(Date.now() - started < 2000, "a page that never answers doesn't hold the report up");
  assert.deepEqual([...got], [["https://a.example.ph/p", "https://cdn.example.ph/p.jpg"]]);
  assert.deepEqual(seen.sort(), ["https://a.example.ph/p", "https://slow.example.ph/p"], "each page once; plain http never");
});

// ---- setting the table up ---------------------------------------------------------------------
import { createSearches, SETUP } from "../src/searches.js";

/** A fake Lark table: `cols` its columns, `records` the first column's value in each record ("" blank). */
function table({ cols, records = [], refuseCurrency = false } = {}) {
  const t = { cols: cols.map((c) => ({ ...c })), calls: [] };
  t.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    t.calls.push({ method, url, body });
    const ok = (data) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    if (/\/fields\?/.test(url) && method === "GET") return ok({ items: t.cols, has_more: false });
    if (/\/records\/search/.test(url)) {
      const first = t.cols.find((c) => c.is_primary).field_name;
      return ok({ items: records.map((v, i) => ({ record_id: `rec${i}`, fields: v ? { [first]: [{ type: "text", text: v }] } : {} })), total: records.length, has_more: false });
    }
    const one = url.match(/\/fields\/(fld\w+)$/);
    if (one && method === "PUT") { Object.assign(t.cols.find((c) => c.field_id === one[1]), { field_name: body.field_name }); return ok({ field: body }); }
    if (/\/fields$/.test(url) && method === "POST") {
      if (refuseCurrency && body.ui_type === "Currency") return new Response(JSON.stringify({ code: 1254001, msg: "WrongRequestBody" }), { status: 400 });
      t.cols.push({ field_id: `fld${t.cols.length + 1}`, field_name: body.field_name, type: body.type, ui_type: body.ui_type });
      return ok({ field: body });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  t.searches = createSearches({ fetch: t.fetch, baseToken: "base1", tableId: "tbl1" });
  return t;
}
const FRESH = [{ field_id: "fld1", field_name: "Text", type: 1, is_primary: true }, { field_id: "fld2", field_name: "Single option", type: 3 }];

test("setting up a fresh table: its first column becomes Item, the rest are added in order, nothing removed", async () => {
  const t = table({ cols: FRESH });
  assert.deepEqual(await t.searches.status("u-token"), { ready: false, missing: SETUP.map((c) => c.field_name) });
  const r = await t.searches.setup("u-token");
  assert.equal(r.renamed, "Text");
  assert.deepEqual(r.added, SETUP.map((c) => c.field_name).filter((n) => n !== "Item"));
  assert.equal(r.ready, true);
  assert.deepEqual(r.missing, []);
  assert.ok(t.cols.some((c) => c.field_name === "Single option"), "the table's own columns stay");
  const price = t.calls.find((c) => c.method === "POST" && c.body && c.body.field_name === "Typical price");
  assert.deepEqual(price.body, { field_name: "Typical price", type: 2, ui_type: "Currency", property: { formatter: "0.00", currency_code: "PHP" } });
  const conf = t.calls.find((c) => c.body && c.body.field_name === "Confidence");
  assert.deepEqual(conf.body.property.options.map((o) => o.name), ["High", "Medium", "Low", "No price"]);
  assert.equal(t.calls.find((c) => c.body && c.body.field_name === "Searched by").body.type, 1003);
  const again = await t.searches.setup("u-token");
  assert.deepEqual([again.added, again.renamed], [[], ""], "a second run changes nothing");
});

test("a new Lark table's blank rows don't stop its first column becoming Item", async () => {
  const t = table({ cols: FRESH, records: ["", "", "", "", ""] });
  const r = await t.searches.setup("u-token");
  assert.equal(r.renamed, "Text");
  assert.equal(t.cols.find((c) => c.field_id === "fld1").field_name, "Item");
  assert.ok(!r.added.includes("Item"));
  const search = t.calls.find((c) => /\/records\/search/.test(c.url));
  assert.deepEqual(search.body.field_names, ["Text"], "only the first column is read");
});

test("setting up a table whose first column holds data adds Item instead of renaming; a refused currency column becomes a number", async () => {
  const t = table({ cols: FRESH, records: ["Chair", "", ""], refuseCurrency: true });
  const r = await t.searches.setup("u-token");
  assert.equal(r.renamed, "");
  assert.ok(r.added.includes("Item"));
  assert.equal(t.cols.find((c) => c.field_id === "fld1").field_name, "Text");
  assert.equal(t.cols.find((c) => c.field_name === "Typical price").ui_type, undefined, "a plain number column");
  assert.equal(r.ready, true);
});
