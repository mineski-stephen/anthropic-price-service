// Past costings (costings.js) with a stand-in D1 database and MADE-UP CE lines. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchTerms, sameUnit, findCostings, cleanLine, costingListings, costingsReport } from "../src/costings.js";
import { readInput, buildTools } from "../src/request.js";
import { createService } from "../src/service.js";
import { parseLines } from "../src/ndjson.js";
import { eventsFor, sseResponse, researchBlocks } from "./helpers.mjs";

const PROMPT = readFileSync(new URL("../prompt.md", import.meta.url), "utf8");

const ROWS = [
  { project_code: "P0001", project_name: "Example Cup", client: "Example Client", outcome: "won", item: "Monoblock chair", particular: "Monoblock chairs (white)",
    remarks: "", qty: 200, frq: 1, per: "pcs", unit_price_php: 280, markup: 0.2, client_price_php: 67200, price_date: "2026-08-01", in_final: 1,
    actual_php: 54000, po_count: 1, category: "Equipment & Furniture", is_package: 0, inactive: 0, waived: 0, free: 0, contingency: 0 },
  { project_code: "P0002", project_name: "Example Fest", client: "Other Client", outcome: "won", item: "Monoblock chair", particular: "Chairs, monoblock",
    remarks: "with backrest", qty: 100, frq: 2, per: "day", unit_price_php: 35, markup: 0.15, client_price_php: 8050, price_date: "2025-03-01", in_final: 0,
    actual_php: null, po_count: 0, category: "Equipment & Furniture", is_package: 0, inactive: 0, waived: 0, free: 0, contingency: 0 },
];

/** A stand-in D1: runs the WHERE terms as plain substring checks, and records the SQL. */
function fakeDb(rows = ROWS, { fail = false } = {}) {
  const db = { calls: [] };
  db.prepare = (sql) => ({
    bind: (...args) => ({
      all: async () => {
        db.calls.push({ sql, args });
        if (fail) throw new Error("D1_ERROR: no such table: lines");
        const terms = args.map((a) => a.slice(1, -1));
        const results = rows.filter((r) => !r.inactive && !r.waived && !r.free && !r.contingency && r.unit_price_php > 0)
          .filter((r) => terms.every((t) => [r.item, r.particular, r.remarks].some((x) => String(x || "").toLowerCase().includes(t))));
        return { results };
      },
    }),
  });
  return db;
}

test("searchTerms keeps the telling words, longest first", () => {
  assert.deepEqual(searchTerms("Monoblock chairs"), ["monoblock", "chair"]);
  assert.deepEqual(searchTerms("LED wall rental per day"), ["wall", "led"]);
  assert.deepEqual(searchTerms("27 inch 144Hz monitor"), ["monitor", "144hz", "27"]);
  assert.deepEqual(searchTerms("the service"), []);
});

test("sameUnit compares units loosely", () => {
  assert.ok(sameUnit("pcs", "piece"));
  assert.ok(sameUnit("Days", "day"));
  assert.ok(sameUnit("sqm/day", "sqm per day"));
  assert.ok(!sameUnit("day", "piece"));
});

test("findCostings: every word must match; skipped lines and unknown databases are handled", async () => {
  const input = readInput({ name: "Monoblock chairs", unit: "piece" });
  const db = fakeDb();
  const c = await findCostings(db, input);
  assert.equal(c.available, true);
  assert.equal(c.lines.length, 2);
  assert.match(db.calls[0].sql, /LIKE \?1 .* AND .*LIKE \?2/);
  assert.deepEqual(db.calls[0].args, ["%monoblock%", "%chair%"]);
  assert.match(db.calls[0].sql, /coalesce\(inactive,0\)=0/);
  assert.equal((await findCostings(null, input)).available, false);
  assert.match((await findCostings(db, input, { loginRequired: false })).reason, /Lark login/);
  const broken = await findCostings(fakeDb(ROWS, { fail: true }), input);
  assert.equal(broken.available, false);
  assert.match(broken.error, /no such table/);
});

test("cleanLine works out the client and paid price per unit", () => {
  const l = cleanLine(ROWS[0]);
  assert.equal(l.unit_cost, 280);
  assert.equal(l.client_unit, 336);
  assert.equal(l.actual_unit, 270);
  assert.equal(l.final, true);
  const d = cleanLine(ROWS[1]);
  assert.equal(d.client_unit, 40.25);     // 8050 / (100 x 2)
  assert.equal(d.actual_unit, null);
});

test("costing listings: only the requested unit counts, unless no line uses it", () => {
  const lines = ROWS.map(cleanLine);
  const perPiece = costingListings(lines, readInput({ name: "Monoblock chair", unit: "piece" }));
  assert.equal(perPiece[0].comparable_price, 280);
  assert.equal(perPiece[1].comparable_price, null);
  assert.equal(perPiece[0].verification.via, "costings");
  assert.equal(perPiece[0].url, "");
  assert.match(perPiece[0].notes, /P0001 Example Cup · Example Client · 200 × 1 pcs · markup 20% · client price PHP 336\.00 · paid PHP 270\.00 \(PO\)/);
  assert.match(perPiece[1].notes, /not the final version/);
  const perSqm = costingListings(lines, readInput({ name: "Monoblock chair", unit: "sqm" }));
  assert.ok(perSqm.every((l) => l.comparable_price > 0));
});

test("a past-costings report: listings from the CE lines, internal-use warning, no cost", () => {
  const input = readInput({ source: "costings", name: "Monoblock chair", unit: "piece" });
  const r = costingsReport({ input, costings: { available: true, terms: ["monoblock", "chair"], lines: ROWS.map(cleanLine) }, id: "r1",
    createdAt: "2026-11-24T00:00:00Z", service: { name: "price-research", version: "x", runtime: "node" }, startedAt: Date.now() });
  assert.equal(r.meta.source, "costings");
  assert.equal(r.meta.cost_usd.total, 0);
  assert.equal(r.listings.length, 2);
  assert.ok(r.warnings.some((w) => /costed per another unit/.test(w.text)));
  assert.ok(r.warnings.some((w) => /don't share them with clients/.test(w.text)));
  const none = costingsReport({ input, costings: { available: true, terms: ["zzz"], lines: [] }, id: "r2", createdAt: "x",
    service: { name: "p", version: "x", runtime: "node" }, startedAt: Date.now() });
  assert.ok(none.warnings.some((w) => /No past CE line or approved purchase request mentions “zzz”/.test(w.text)));
});

test("Haiku gets the plain search tools; Opus and Sonnet the filtering ones", () => {
  const h = buildTools(readInput({ name: "Chair", model: "claude-haiku-5-5", depth: "quick", suppliers: false }));
  assert.deepEqual(h.slice(0, 2).map((t) => t.type), ["web_search_20250305", "web_fetch_20250910"]);
  assert.equal(h[0].max_uses, 3);
  const o = buildTools(readInput({ name: "Chair", model: "claude-opus-5-5" }));
  assert.deepEqual(o.slice(0, 2).map((t) => t.type), ["web_search_20260318", "web_fetch_20260318"]);
});

// ---- through the service ------------------------------------------------------------------------
function world({ env = {}, db = fakeDb(), answers = [] } = {}) {
  const w = { logs: [], bodies: [] };
  let n = 0;
  const fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith("https://open.larksuite.com/")) {
      if (url.includes("/authen/v1/user_info")) return new Response(JSON.stringify({ code: 0, data: { open_id: "ou_tester", name: "T" } }), { status: 200 });
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
    }
    if (url === "https://api.anthropic.com/v1/messages") { w.bodies.push(JSON.parse(init.body)); return sseResponse(answers[n++], { signal: init.signal }); }
    throw new Error(`unexpected call ${url}`);
  };
  w.handle = createService({ ANTHROPIC_API_KEY: "sk-ant-test-0123456789", ...env }, { prompt: PROMPT, fetch, db, log: (l) => w.logs.push(l) });
  w.post = async (body, { token = "u-good-token-0123456789abcdef" } = {}) => {
    const res = await w.handle(new Request("http://svc/research", { method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:9128", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
    if (!(res.headers.get("Content-Type") || "").includes("ndjson")) return { status: res.status, body: await res.json() };
    const [lines] = parseLines(`${await res.text()}\n`);
    return { status: res.status, lines, last: lines[lines.length - 1] };
  };
  return w;
}

test("source costings: no Claude call, the CE lines as the report", async () => {
  const w = world();
  const r = await w.post({ source: "costings", name: "Monoblock chair", unit: "piece" });
  assert.deepEqual(r.lines.map((l) => l.kind || l.type), ["start", "costings", "checking", "report"]);
  assert.equal(r.last.report.listings.length, 2);
  assert.equal(w.bodies.length, 0);
  assert.ok(w.logs.some((l) => /^costings 200 .*lines=2/.test(l)));
});

test("past costings are refused when the login check is off, or there's no database", async () => {
  const off = await world({ env: { REQUIRE_LARK_LOGIN: "false" } }).post({ source: "costings", name: "Monoblock chair" });
  assert.equal(off.last.type, "error");
  assert.equal(off.last.error.code, "costings_unavailable");
  assert.match(off.last.error.message, /Lark login/);
  // Without the database, approved purchase requests (Lark) still answer.
  const nodb = await world({ db: null }).post({ source: "costings", name: "Monoblock chair" });
  assert.equal(nodb.last.type, "report");
  assert.equal(nodb.last.report.costings, null);
  const info = await (await world({ env: { REQUIRE_LARK_LOGIN: "false" } }).handle(new Request("http://svc/"))).json();
  assert.equal(info.costings.available, false);
});

test("a web check carries the past costings alongside", async () => {
  const w = world({ answers: [eventsFor(researchBlocks(), { stop: "tool_use", searches: 1, fetches: 2 })] });
  const r = await w.post({ name: "Monoblock chair", unit: "piece", depth: "quick", model: "claude-haiku-5-5" });
  assert.equal(r.last.type, "report");
  assert.equal(r.last.report.meta.source, "web");
  assert.equal(r.last.report.costings.lines.length, 2);
  assert.ok(r.lines.some((l) => l.kind === "costings" && l.count === 2));
  assert.equal(w.bodies[0].tools[0].type, "web_search_20250305");
  const sent = w.bodies[0].messages[0].content[0].text;
  assert.match(sent, /Mineski's own records for this/, "the past figures go to Claude as reference");
  assert.match(sent, /Budgeted on 1 past CE line: middle PHP 280\.00 per piece/);
  assert.ok(!/Example Client/.test(sent), "client names stay out");
  assert.deepEqual(r.lines.slice(0, 2).map((l) => l.kind || l.type), ["start", "costings"]);
});

test("the check depth: Haiku with 5 page reads of 4,000 tokens, marketplaces skipped, retailers suggested", async () => {
  const { userText, buildBody, DEPTHS } = await import("../src/request.js");
  const input = readInput({ name: "Monoblock chair", model: "claude-haiku-5-5", depth: "check", suppliers: false });
  const [search, fetch] = buildTools(input);
  assert.equal(search.type, "web_search_20250305");
  assert.equal(search.max_uses, 3);
  assert.equal(fetch.max_uses, 5);
  assert.equal(fetch.max_content_tokens, 4000);
  assert.ok(search.blocked_domains.includes("lazada.com.ph") && fetch.blocked_domains.includes("shopee.ph"));
  assert.equal(buildBody(input, { system: "x", messages: [] }).output_config.effort, "medium");
  const text = userText(input, "2026-11-24");
  assert.match(text, /open the pages of the most useful offers/);
  assert.match(text, /ACE Hardware, Wilcon Depot/);
  assert.equal(DEPTHS.check.maxUsd, 0.15);
  const own = buildTools(readInput({ name: "Chair", model: "claude-haiku-5-5", depth: "check", sites: { mode: "only", list: ["acehardware.ph"] } }));
  assert.deepEqual(own[0].allowed_domains, ["acehardware.ph"]);
  assert.equal(own[0].blocked_domains, undefined);
});
