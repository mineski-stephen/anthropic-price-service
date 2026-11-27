// Past costings (costings.js) with a stand-in D1 database and MADE-UP CE lines. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchTerms, sameUnit, findCostings, cleanLine, usualUnit, referenceText, markRentals } from "../src/costings.js";
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

test("without a unit in the request, the CE lines' usual unit is the one compared", () => {
  const lines = markRentals({ lines: ROWS.map(cleanLine), pos: [] }, readInput({ name: "Monoblock chair" })).lines;
  assert.equal(usualUnit(lines), "pcs", "the per-day line is a rental, so it doesn't count");
  const text = referenceText({ lines, pos: [] }, readInput({ name: "Monoblock chair" }));
  assert.match(text, /Budgeted on 1 past CE line at PHP 280\.00 per pcs/);
  assert.equal(usualUnit([]), "");
});

test("Quick is Haiku's plain search tools; Standard and Thorough get the filtering ones", () => {
  const h = buildTools(readInput({ name: "Chair", depth: "quick" }));
  assert.deepEqual(h.slice(0, 2).map((t) => t.type), ["web_search_20250305", "web_fetch_20250910"]);
  assert.equal(h[0].max_uses, 4);
  const o = buildTools(readInput({ name: "Chair", depth: "thorough" }));
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
  w.handle = createService({ ANTHROPIC_API_KEY: "sk-ant-test-0123456789", ...env }, { prompt: PROMPT, fetch, db, images: false, log: (l) => w.logs.push(l) });
  w.post = async (body, { token = "u-good-token-0123456789abcdef" } = {}) => {
    const res = await w.handle(new Request("http://svc/research", { method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:9128", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
    if (!(res.headers.get("Content-Type") || "").includes("ndjson")) return { status: res.status, body: await res.json() };
    const [lines] = parseLines(`${await res.text()}\n`);
    return { status: res.status, lines, last: lines[lines.length - 1], report: (lines.find((l) => l.type === "report") || {}).report };
  };
  return w;
}

test("past costings need the login check on; without the database, purchase requests still come", async () => {
  const off = world({ env: { REQUIRE_LARK_LOGIN: "false" }, answers: [eventsFor(researchBlocks(), { stop: "tool_use", searches: 1, fetches: 2 })] });
  const r = await off.post({ name: "Monoblock chair" });
  assert.equal(r.report.costings.available, false);
  assert.match(r.report.costings.reason, /Lark login/);
  const nodb = world({ db: null, answers: [eventsFor(researchBlocks(), { stop: "tool_use", searches: 1, fetches: 2 })] });
  const n = await nodb.post({ name: "Monoblock chair" });
  assert.equal(n.report.costings.ce_available, false);
  assert.equal(n.report.costings.pos_available, true);
  const info = await (await world({ env: { REQUIRE_LARK_LOGIN: "false" } }).handle(new Request("http://svc/"))).json();
  assert.equal(info.costings.available, false);
});

test("a web check carries the past costings alongside", async () => {
  const w = world({ answers: [eventsFor(researchBlocks(), { stop: "tool_use", searches: 1, fetches: 2 })] });
  const r = await w.post({ name: "Monoblock chair", unit: "piece", depth: "quick" });
  assert.equal(r.report.meta.source, "web");
  assert.equal(r.report.costings.lines.length, 2);
  assert.ok(r.lines.some((l) => l.kind === "costings" && l.count === 2));
  assert.equal(w.bodies[0].tools[0].type, "web_search_20250305");
  const sent = w.bodies[0].messages[0].content[0].text;
  assert.match(sent, /Mineski's own records for this/, "the past figures go to Claude as reference");
  assert.match(sent, /Budgeted on 1 past CE line at PHP 280\.00 per piece.*too few to compare with/);
  assert.ok(!/Example Client/.test(sent), "client names stay out");
  assert.deepEqual(r.lines.slice(0, 2).map((l) => l.kind || l.type), ["start", "costings"]);
});

test("the quick depth: Haiku with 6 page reads of 4,000 tokens, marketplaces skipped, retailers suggested", async () => {
  const { userText, buildBody, DEPTHS } = await import("../src/request.js");
  const input = readInput({ name: "Monoblock chair", depth: "quick" });
  const [search, fetch] = buildTools(input);
  assert.equal(search.type, "web_search_20250305");
  assert.equal(search.max_uses, 4);
  assert.equal(fetch.max_uses, 6);
  assert.equal(fetch.max_content_tokens, 4000);
  assert.ok(search.blocked_domains.includes("lazada.com.ph") && fetch.blocked_domains.includes("shopee.ph"));
  assert.equal(buildBody(input, { system: "x", messages: [] }).output_config.effort, "medium");
  const text = userText(input, "2026-11-24");
  assert.match(text, /open the pages of the most useful offers/);
  assert.match(text, /ACE Hardware, Wilcon Depot/);
  assert.equal(DEPTHS.quick.maxUsd, 0.2);
});
