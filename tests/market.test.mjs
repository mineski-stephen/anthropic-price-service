// Marketplace checks (market.js): Lazada's search data read and sorted, with Lazada and Anthropic faked.
// The Lazada answer below is made up, in the shape Lazada's /catalog/?ajax=true returns. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nameListings, parseSold, itemLink, readListings, searchUrl, sortBody, SORT_SCHEMA, readSorted, buildMarketReport, MARKET_MODEL } from "../src/market.js";
import { readInput } from "../src/request.js";
import { createTally } from "../src/cost.js";
import { createService } from "../src/service.js";
import { parseLines } from "../src/ndjson.js";
import { eventsFor, sseResponse } from "./helpers.mjs";

const PROMPT = readFileSync(new URL("../prompt.md", import.meta.url), "utf8");
const ORIGIN = "http://127.0.0.1:9128";

const item = (over) => ({ name: "Plastic chair", itemId: "1001", itemUrl: "//www.lazada.com.ph/products/plastic-chair-i1001.html?spm=x&search=1",
  price: "300", priceShow: "₱300.00", originalPrice: "", sellerName: "Shop One", brandName: "No Brand", itemSoldCntShow: "6.7K sold",
  ratingScore: "4.93", review: "120", location: "Cavite", inStock: true, isSponsored: false, adFlag: "0", ...over });
const LAZADA_JSON = {
  mainInfo: { totalResults: "4080", pageSize: "40" },
  mods: { listItems: [
    item(),
    item({ itemId: "1002", itemUrl: "//www.lazada.com.ph/products/chair-4pcs-i1002.html", name: "4pcs Monoblock chair set", price: "1299", priceShow: "₱1,299.00",
      originalPrice: "4000", sellerName: "Shop Two", brandName: "Uratex", itemSoldCntShow: "413 sold" }),
    item({ itemId: "1003", itemUrl: "//www.lazada.com.ph/products/chair-cover-i1003.html", name: "Chair cover spandex", price: "89", priceShow: "₱89.00",
      sellerName: "Shop Three", itemSoldCntShow: "", isSponsored: true }),
    item({ itemId: "1001" }),                                                 // a duplicate
    item({ itemId: "1004", price: "", priceShow: "" }),                       // no price
    item({ itemId: "1005", itemUrl: "https://evil.example/x", name: "Elsewhere chair", price: "250", priceShow: "₱250.00" }),
  ] },
};
const SORTED = {
  interpreted: "Plastic monoblock chair", category: "Equipment & Furniture", unit: "piece",
  summary: "Single chairs sell for about ₱300; a 4-piece set works out cheaper per chair.",
  listings: [
    { n: 1, match: "exact", units_in_price: 1, condition: "new", note: "" },
    { n: 2, match: "exact", units_in_price: 4, condition: "new", note: "Set of 4" },
    { n: 3, match: "different", units_in_price: 0, condition: "new", note: "A cover, not a chair" },
    { n: 4, match: "close", units_in_price: 1, condition: "new", note: "" },
  ],
  assumptions: ["Adult size."], warnings: [],
};
const sortedAnswer = (obj = SORTED) => eventsFor([{ type: "text", text: JSON.stringify(obj) }],
  { model: MARKET_MODEL, usage: { input_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, out: { output_tokens: 600 } });

test("nameListings puts product names where Claude wrote listing numbers", () => {
  const l = [{ n: 3, title: "Chair A" }, { n: 5, title: "Chair B" }, { n: 11, title: "A very long product title that goes on and on and on" }];
  assert.equal(nameListings("Listing 3 is odd.", l), "Listing “Chair A” is odd.");
  assert.equal(nameListings("Listings 3, 5 and 11 differ.", l), "Listings “Chair A”, “Chair B” and “A very long product title that goes on…” differ.");
  assert.equal(nameListings("listing 99 and 2024 prices", l), "listing 99 and 2024 prices");
  assert.equal(nameListings("Pack of 4 listings", l), "Pack of 4 listings");
});

test("parseSold reads Lazada's sold counts", () => {
  assert.equal(parseSold("6.7K sold"), 6700);
  assert.equal(parseSold("1.2M sold"), 1200000);
  assert.equal(parseSold("90 sold"), 90);
  assert.equal(parseSold("1,234 sold"), 1234);
  assert.equal(parseSold(""), 0);
});

test("itemLink keeps Lazada product pages only, without tracking", () => {
  assert.equal(itemLink("//www.lazada.com.ph/products/a-i1.html?spm=1", "PH"), "https://www.lazada.com.ph/products/a-i1.html");
  assert.equal(itemLink("/products/a-i1.html", "SG"), "https://www.lazada.sg/products/a-i1.html");
  assert.equal(itemLink("https://evil.example/x", "PH"), "");
  assert.equal(itemLink("https://lazada.com.ph.evil.example/x", "PH"), "");
  assert.equal(itemLink("javascript:alert(1)", "PH"), "");
});

test("searchUrl asks for the data, or the page a person would open", () => {
  assert.equal(searchUrl("PH", "monoblock chair"), "https://www.lazada.com.ph/catalog/?ajax=true&page=1&q=monoblock+chair");
  assert.equal(searchUrl("PH", "a&b", { ajax: false }), "https://www.lazada.com.ph/catalog/?q=a%26b");
  assert.equal(searchUrl("US", "x"), "");
});

test("readListings keeps priced listings once each, with numbers parsed", () => {
  const l = readListings(LAZADA_JSON, "PH");
  assert.deepEqual(l.map((x) => x.n), [1, 2, 3, 4]);
  assert.deepEqual(l.map((x) => x.item_id), ["1001", "1002", "1003", "1005"]);
  assert.equal(l[0].sold, 6700);
  assert.equal(l[0].brand, "");                 // "No Brand" dropped
  assert.equal(l[0].rating, 4.9);
  assert.equal(l[1].regular_price, 4000);
  assert.equal(l[2].sponsored, true);
  assert.equal(l[3].url, "");                   // not a Lazada link
  assert.deepEqual(readListings({}, "PH"), []);
});

test("sortBody: Haiku, structured output, no tools, no fallbacks; the schema is strict", () => {
  const input = readInput({ source: "marketplace", name: "Plastic chair", quantity: 200 });
  const b = sortBody(input, readListings(LAZADA_JSON, "PH"), "2026-11-24");
  assert.equal(b.model, "claude-haiku-5-5");
  assert.equal(b.output_config.format.type, "json_schema");
  assert.equal(b.output_config.effort, "low");
  assert.equal(b.tools, undefined);
  assert.equal(b.fallbacks, undefined);
  assert.match(b.messages[0].content, /1 \| Plastic chair \| PHP 300 \| - \| Shop One \| 6\.7K sold \| 4\.9 \(120\)/);
  assert.match(b.messages[0].content, /PHP 1299 \(was 4000\)/);
  const walk = (s) => {
    if (s.type === "object") {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === "array") walk(s.items);
  };
  walk(SORT_SCHEMA);
});

test("readSorted takes the JSON text, or null", () => {
  assert.deepEqual(readSorted({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"a":1}' }] }), { a: 1 });
  assert.equal(readSorted({ content: [{ type: "text", text: "not json" }] }), null);
});

function report(sorted = SORTED, input = readInput({ source: "marketplace", name: "Plastic chair", quantity: 200 })) {
  const tally = createTally();
  if (sorted) tally.add(MARKET_MODEL, { input_tokens: 3000, output_tokens: 600 });
  return buildMarketReport({ input, listings: readListings(LAZADA_JSON, "PH"), total: 4080, searchPage: searchUrl("PH", input.name, { ajax: false }),
    sorted, tally, model: MARKET_MODEL, id: "r1", createdAt: "2026-11-24T01:00:00Z", service: { name: "price-research", version: "0.2.0", runtime: "node" },
    startedAt: Date.now(), today: "2026-11-24" });
}

test("the report drops different things, prices per unit, and marks prices as Lazada's own", () => {
  const r = report();
  assert.equal(r.listings.length, 3);
  const set = r.listings.find((l) => l.title.startsWith("4pcs"));
  assert.equal(set.units_in_price, 4);
  assert.equal(set.unit_price, 324.75);
  assert.equal(set.comparable_price, 324.75);
  assert.equal(set.regular_price, 4000);
  assert.ok(r.listings.every((l) => l.verification.status === "checked" && l.verification.via === "marketplace"));
  assert.match(r.listings[0].verification.evidence[0].excerpt, /Lazada lists it at ₱300\.00 · 6\.7K sold/);
  assert.equal(r.meta.source, "lazada");
  assert.equal(r.meta.depth, "marketplace");
  assert.equal(r.meta.listings_seen, 4);
  assert.equal(r.meta.cost_usd.total, 0.0006);
  assert.equal(r.category, "Equipment & Furniture");
  assert.equal(r.sources.queries[0].results, 4080);
  assert.ok(r.warnings.some((w) => /1 of Lazada's 4 listings weren't the same thing/.test(w.text)));
  assert.ok(r.warnings.some((w) => /Lazada prices only/.test(w.text)));
  assert.deepEqual(r.suppliers, []);
});

test("without Claude's labels every listing is shown, with a warning", () => {
  const r = report(null);
  assert.equal(r.listings.length, 4);
  assert.equal(r.meta.ended, "unsorted");
  assert.ok(r.warnings.some((w) => /couldn't be sorted/.test(w.text)));
});

test("used listings are left out when new only was asked", () => {
  const sorted = { ...SORTED, listings: SORTED.listings.map((x) => (x.n === 4 ? { ...x, condition: "used" } : x)) };
  assert.equal(report(sorted).listings.length, 2);
  assert.equal(report(sorted, readInput({ source: "marketplace", name: "Plastic chair", condition: "any" })).listings.length, 3);
});

test("readInput: marketplace uses the market model and only Lazada's markets", () => {
  const i = readInput({ source: "marketplace", name: "Chair", model: "claude-opus-5-5" });
  assert.equal(i.source, "marketplace");
  assert.equal(i.model, "claude-haiku-5-5");
  assert.equal(readInput({ name: "Chair" }).source, "web");
  assert.throws(() => readInput({ source: "marketplace", name: "Chair", market: "US" }), /only for the Philippines/);
});

// ---- the service end to end ------------------------------------------------------------------
function world({ lazada = () => new Response(JSON.stringify(LAZADA_JSON), { status: 200, headers: { "Content-Type": "application/json" } }), answers = [sortedAnswer()] } = {}) {
  const w = { bodies: [], urls: [], logs: [] };
  let n = 0;
  const fetch = async (url, init = {}) => {
    url = String(url);
    w.urls.push(url);
    if (url.startsWith("https://www.lazada.com.ph/")) return lazada(url, init);
    if (url === "https://api.anthropic.com/v1/messages") {
      w.bodies.push(JSON.parse(init.body));
      const a = answers[n++];
      if (!a) throw new Error("no more answers");
      return typeof a === "function" ? a(init) : sseResponse(a, { signal: init.signal });
    }
    throw new Error(`unexpected call ${url}`);
  };
  w.handle = createService({ ANTHROPIC_API_KEY: "sk-ant-test-0123456789", REQUIRE_LARK_LOGIN: "false" }, { prompt: PROMPT, fetch, log: (l) => w.logs.push(l) });
  w.post = async (body = { source: "marketplace", name: "Plastic chair", quantity: 200 }) => {
    const res = await w.handle(new Request("http://svc/research", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(body) }));
    if (!(res.headers.get("Content-Type") || "").includes("ndjson")) return { status: res.status, body: await res.json() };
    const [lines] = parseLines(`${await res.text()}\n`);
    return { status: res.status, lines, last: lines[lines.length - 1] };
  };
  return w;
}

test("POST /research with source marketplace: Lazada, then Haiku, then the report", async () => {
  const w = world();
  const r = await w.post();
  assert.equal(r.status, 200);
  assert.deepEqual(r.lines.map((l) => l.kind || l.type), ["start", "market_search", "market_results", "sorting", "usage", "checking", "report"]);
  assert.equal(r.lines[0].source, "marketplace");
  assert.equal(w.urls[0], "https://www.lazada.com.ph/catalog/?ajax=true&page=1&q=Plastic+chair");
  assert.equal(w.bodies.length, 1);
  assert.equal(w.bodies[0].model, "claude-haiku-5-5");
  assert.equal(r.last.report.listings.length, 3);
  assert.ok(w.logs.some((l) => /^market 200 .*kept=3/.test(l)));
});

test("Lazada refusing the server is a plain error, and nothing is sent to Anthropic", async () => {
  const w = world({ lazada: () => new Response("<html>slide to verify</html>", { status: 200, headers: { "Content-Type": "text/html" } }) });
  const r = await w.post();
  assert.equal(r.last.type, "error");
  assert.equal(r.last.error.code, "marketplace_blocked");
  assert.match(r.last.error.message, /Lazada didn't send its listings/);
  assert.equal(w.bodies.length, 0);
});

test("refused at first, Lazada is warmed up like a browser: cookies from every redirect, then the data", async () => {
  const seen = [];
  const lazada = (url, init) => {
    const cookie = new Headers(init.headers).get("Cookie") || "";
    seen.push({ url, cookie, redirect: init.redirect });
    if (url.includes("ajax=true")) {
      return cookie.includes("hng=PH") && cookie.includes("sig=ok")
        ? new Response(JSON.stringify(LAZADA_JSON), { status: 200 })
        : new Response("<html><title>Slide to verify</title>punish</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    }
    if (url.includes("/catalog/?q=")) {
      const h = new Headers({ Location: "/landing/?q=Plastic+chair" });
      h.append("Set-Cookie", "hng=PH|en-PH|PHP|608; Path=/; Domain=.lazada.com.ph");
      return new Response("", { status: 302, headers: h });
    }
    const h = new Headers({ "Content-Type": "text/html" });
    h.append("Set-Cookie", "sig=ok; Path=/");
    return new Response("<html>search page</html>", { status: 200, headers: h });
  };
  const w = world({ lazada });
  const r = await w.post();
  assert.equal(r.last.type, "report");
  assert.equal(r.last.report.listings.length, 3);
  assert.equal(seen.length, 4);                                   // data, page, redirected page, data again
  assert.equal(seen[1].redirect, "manual");
  assert.match(seen[3].cookie, /hng=PH\|en-PH\|PHP\|608; sig=ok/);
  assert.ok(w.logs.some((l) => /lazada refused the data request: HTTP 200 text\/html .*title="Slide to verify" \(a bot check\)/.test(l)));
  assert.ok(w.logs.some((l) => /lazada answered after the warm-up \(cookies: hng,sig\)/.test(l)));
});

test("if Claude fails, the listings still come back unsorted; a refused key stops it", async () => {
  const down = () => new Response(JSON.stringify({ error: { type: "api_error", message: "boom" } }), { status: 500 });
  const r = await world({ answers: [down] }).post();
  assert.equal(r.last.type, "report");
  assert.equal(r.last.report.meta.ended, "unsorted");
  assert.equal(r.last.report.listings.length, 4);
  const bad = () => new Response(JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 });
  const r2 = await world({ answers: [bad] }).post();
  assert.equal(r2.last.type, "error");
  assert.equal(r2.last.error.code, "not_configured");
});

test("nothing found on Lazada: an empty report, no Claude call", async () => {
  const w = world({ lazada: () => new Response(JSON.stringify({ mods: { listItems: [] }, mainInfo: { totalResults: "0" } }), { status: 200 }) });
  const r = await w.post();
  assert.equal(r.last.type, "report");
  assert.equal(r.last.report.listings.length, 0);
  assert.ok(r.last.report.warnings.some((w) => /found nothing/.test(w.text)));
  assert.equal(w.bodies.length, 0);
});

test("a market Lazada doesn't sell in is refused before anything runs", async () => {
  const r = await world().post({ source: "marketplace", name: "Chair", market: "US" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "bad_input");
});
