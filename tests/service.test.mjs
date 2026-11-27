// The HTTP service with Anthropic, Lark and the listings' pages faked: checks, the stream, pauses,
// nudges, cancel, the automatic save and the saved-search routes. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createService, readConfig, VERSION, ALLOW_HEADERS, today } from "../src/service.js";
import { parseLines } from "../src/ndjson.js";
import { NUDGE, WRAP_UP } from "../src/request.js";
import { eventsFor, sseResponse, researchBlocks, strip } from "./helpers.mjs";

const PROMPT = readFileSync(new URL("../prompt.md", import.meta.url), "utf8");
const GOOD = "u-good-token-0123456789abcdef";
const OUTSIDER = "u-outsider-token-0123456789abc";
const READER = "u-reader-only-token-0123456789";
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-0123456789", REQUIRE_LARK_LOGIN: "false" };
const ORIGIN = "http://127.0.0.1:9128";
const TABLE = "https://open.larksuite.com/open-apis/bitable/v1/apps/NP7TbjwHNaTyLOsWafelN9wNgEd/tables/tblYUSBGnqwDp0PN";
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
// The saved searches table's columns, as Lark lists them (type 1 text, 2 number, 3 single option, 99003 currency).
const COLUMNS = [["Item", 1], ["Details", 1], ["Typical price", 99003], ["Low price", 99003], ["High price", 99003], ["Unit", 1],
  ["Confidence", 3], ["Depth", 3], ["Summary", 1], ["Search ID", 1], ["Report", 1], ["Cost (USD)", 2], ["Searched by", 1003], ["Searched on", 1001]];
const PAGE_HTML = '<html><head><title>Chair</title><meta property="og:image" content="https://cdn.ace-example.ph/chair.jpg?w=600&amp;h=600"></head><body>...</body></html>';

/** A fake world: `answers` are what Anthropic says to each request in turn (event lists or functions).
 *  Lark keeps the saved searches in `w.rows`. */
function world({ env = {}, answers = [], images = false, rows = [] } = {}) {
  const w = { bodies: [], headers: [], signals: [], logs: [], records: [], lark: [], rows: [...rows], pages: [] };
  let n = 0;
  const fetch = async (url, init = {}) => {
    url = String(url);
    const h = new Headers(init.headers);
    if (url.startsWith("https://open.larksuite.com/")) {
      const token = (h.get("Authorization") || "").slice(7);
      const method = init.method || "GET";
      w.lark.push({ method, url, body: init.body ? JSON.parse(init.body) : null });
      if (url.includes("/authen/v1/user_info")) return json(200, { code: 0, data: { open_id: `ou_${token.slice(2, 10)}`, name: "Test User" } });
      if (token === OUTSIDER) return json(403, { code: 91403, msg: "Forbidden" });
      if (url.startsWith(TABLE)) {
        if (url.includes("/fields")) return json(200, { code: 0, data: { items: COLUMNS.map(([field_name, type]) => ({ field_name, type })), has_more: false } });
        if (token === READER && method !== "GET" && !url.includes("/records/search")) return json(403, { code: 1254302, msg: "RolePermNotAllow" });
        if (url.includes("/records/search")) return json(200, { code: 0, data: { items: w.rows, has_more: false, total: w.rows.length } });
        const one = url.match(/\/records\/(rec\w+)/);
        if (one && method === "GET") {
          const rec = w.rows.find((r) => r.record_id === one[1]);
          return rec ? json(200, { code: 0, data: { record: rec } }) : json(200, { code: 1254043, msg: "RecordIdNotFound" });
        }
        if (one && method === "PUT") {
          const rec = w.rows.find((r) => r.record_id === one[1]);
          Object.assign(rec.fields, JSON.parse(init.body).fields);
          return json(200, { code: 0, data: { record: rec } });
        }
        if (/\/records\?/.test(url) && method === "POST") {
          const rec = { record_id: `recNew${w.rows.length + 1}`, fields: JSON.parse(init.body).fields, created_time: Date.now(), created_by: { id: "ou_x", name: "Test User" } };
          w.rows.push(rec);
          return json(200, { code: 0, data: { record: { record_id: rec.record_id, fields: rec.fields } } });
        }
      }
      return json(200, { code: 0, data: { items: [] } });
    }
    if (url === "https://api.anthropic.com/v1/messages") {
      w.bodies.push(JSON.parse(init.body));
      w.headers.push(h);
      w.signals.push(init.signal);
      const a = answers[n++];
      if (!a) throw new Error("no more answers");
      return typeof a === "function" ? a(init) : sseResponse(a, { signal: init.signal });
    }
    if (/^https:\/\/(www\.)?(ace-example|wilcon-example|lazada|shopee|made-up-shop)/.test(url)) {
      w.pages.push(url);
      if (url.includes("ace-example.ph")) return new Response(PAGE_HTML, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
      return new Response("blocked", { status: 403 });
    }
    throw new Error(`unexpected call ${url}`);
  };
  w.handle = createService({ ...ENV, ...env }, { prompt: PROMPT, fetch, images, log: (l) => w.logs.push(l), record: (name) => w.records.push(name) });
  w.post = async (body = { name: "Monoblock chair", depth: "thorough" }, { origin = ORIGIN, token = "", raw } = {}) => {
    const h = new Headers({ "Content-Type": "application/json" });
    if (origin) h.set("Origin", origin);
    if (token) h.set("Authorization", `Bearer ${token}`);
    const res = await w.handle(new Request("http://svc/research", { method: "POST", headers: h, body: raw !== undefined ? raw : JSON.stringify(body) }));
    if (!(res.headers.get("Content-Type") || "").includes("ndjson")) return { status: res.status, body: await res.json(), res };
    const [lines] = parseLines(`${await res.text()}\n`);
    return { status: res.status, lines, res, last: lines[lines.length - 1], report: (lines.find((l) => l.type === "report") || {}).report };
  };
  w.call = async (method, path, { token = GOOD, body } = {}) => {
    const h = new Headers({ Origin: ORIGIN });
    if (token) h.set("Authorization", `Bearer ${token}`);
    if (body !== undefined) h.set("Content-Type", "application/json");
    const res = await w.handle(new Request(`http://svc${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: res.status, body: await res.json(), res };
  };
  return w;
}

const submitted = (opts = {}) => eventsFor(researchBlocks(), { stop: "tool_use", searches: 1, fetches: 2, ...opts });
const LOGIN = { REQUIRE_LARK_LOGIN: "true" };

test("GET / reports the service, version, depths with their models and allowed headers, never the key", async () => {
  const res = await world().handle(new Request("http://svc/"));
  const info = await res.json();
  assert.equal(res.status, 200);
  assert.equal(info.service, "price-research");
  assert.equal(info.version, VERSION);
  assert.deepEqual(info.cors.allow_headers, ALLOW_HEADERS);
  assert.deepEqual(info.depths.map((d) => [d.id, d.model]), [["quick", "claude-haiku-5-5"], ["standard", "claude-sonnet-5-5"], ["thorough", "claude-opus-5-5"]]);
  assert.equal(info.depths.find((d) => d.default).id, "quick");
  assert.equal(info.market.currency, "PHP");
  assert.equal(info.login.required, false);
  assert.equal(info.searches.available, false, "saved searches need the login");
  assert.ok(info.endpoints.includes("PATCH /searches/{record_id}"));
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /PATCH/);
  assert.ok(!JSON.stringify(info).includes(ENV.ANTHROPIC_API_KEY));
  const on = await (await world({ env: LOGIN }).handle(new Request("http://svc/"))).json();
  assert.equal(on.searches.available, true);
  assert.ok(on.features.includes("saved-searches"));
});

test("settings given as JSON values or in quotes read as the text they mean", () => {
  const base = { ANTHROPIC_API_KEY: "sk-ant-test-0123456789" };
  assert.equal(readConfig({ ...base, REQUIRE_LARK_LOGIN: false }).lark.required, false);
  assert.equal(readConfig({ ...base, REQUIRE_LARK_LOGIN: '"false"' }).lark.required, false);
  assert.equal(readConfig({ ...base, REQUIRE_LARK_LOGIN: " 'off' " }).lark.required, false);
  assert.equal(readConfig({ ...base, REQUIRE_LARK_LOGIN: true }).lark.required, true);
  assert.equal(readConfig({ ...base, RATE_LIMIT_PER_HOUR: 2 }).rateLimitPerHour, 2);
  assert.equal(readConfig({ ...base, MAX_RUN_USD: "0.5" }).maxRunUsd, 0.5);
  assert.deepEqual(readConfig(base).searches, { baseToken: "NP7TbjwHNaTyLOsWafelN9wNgEd", tableId: "tblYUSBGnqwDp0PN" });
  assert.equal(readConfig({ ...base, SEARCHES_TABLE_ID: "tblOther" }).searches.tableId, "tblOther");
});

test("settings: a missing key makes every route answer 503; login is on unless switched off", async () => {
  const res = await world({ env: { ANTHROPIC_API_KEY: "" } }).handle(new Request("http://svc/"));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "misconfigured");
  assert.equal(readConfig({ ANTHROPIC_API_KEY: "k" }).lark.required, true);
  assert.equal(readConfig({ ANTHROPIC_API_KEY: "k", TZ_OFFSET_HOURS: "nope" }).tzOffsetHours, 8);
  assert.equal(today(8, Date.UTC(2026, 10, 22, 17, 0)), "2026-11-23", "Manila is already on the 23rd");
});

test("a search streams start, progress, usage, the checked report with its price, then whether it was saved", async () => {
  const w = world({ answers: [submitted()] });
  const r = await w.post();
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get("Content-Type"), /application\/x-ndjson/);
  assert.equal(r.res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const types = r.lines.map((l) => l.type);
  assert.equal(types[0], "start");
  assert.equal(r.lines[0].estimate_ms, 240000);
  assert.deepEqual(r.lines[0].caps, { searches: 12, fetches: 10 });
  assert.match(r.lines[0].search_id, /^ps[a-z0-9]{6,30}$/);
  const kinds = r.lines.filter((l) => l.type === "activity").map((l) => l.kind);
  for (const k of ["filter", "search", "search_done", "fetch", "fetch_done", "writing", "checking"]) assert.ok(kinds.includes(k), `activity ${k}`);
  assert.ok(types.includes("usage"));
  assert.deepEqual(types.slice(-2), ["report", "saved"]);
  const rep = r.report;
  assert.deepEqual(rep.listings.map((l) => l.verification.status), ["checked", "checked", "checked", "link", "unverified"]);
  assert.ok(rep.listings.every((l) => !("evidence" in l.verification)), "page excerpts stay on the server");
  assert.equal(rep.search_id, r.lines[0].search_id);
  assert.equal(rep.price.n, 4);
  assert.equal(rep.price.typical, 1099, "the middle of 650, 899, 1,299 and 1,344 (the 4-pack, VAT added)");
  assert.deepEqual(rep.price.included, ["l1", "l2", "l3", "l4"]);
  assert.equal(rep.meta.ended, "submitted");
  assert.equal(rep.meta.requests, 1);
  assert.deepEqual(r.last, { type: "saved", saved: null, error: { code: "not_saved", message: "Not saved: saved searches need the Lark login." } });
  assert.equal(w.bodies.length, 1);
  assert.equal(w.bodies[0].stream, true);
  assert.equal(w.bodies[0].model, "claude-opus-5-5");
  assert.equal(w.headers[0].get("anthropic-beta"), "server-side-fallback-2026-07-01");
  assert.equal(w.headers[0].get("anthropic-version"), "2026-10-21");
  assert.equal(w.headers[0].get("x-api-key"), ENV.ANTHROPIC_API_KEY);
  assert.deepEqual(w.records, [`${rep.id}-1`]);
  assert.ok(w.logs.some((l) => /^research 200 .*checked=3/.test(l)), w.logs.join("\n"));
});

test("a signed-in search is saved to the Lark table as the person, with its price and the report", async () => {
  const w = world({ env: LOGIN, answers: [submitted()] });
  const r = await w.post(undefined, { token: GOOD });
  assert.equal(r.last.type, "saved");
  assert.equal(r.last.error, null);
  assert.equal(r.last.saved.record_id, "recNew1");
  assert.equal(r.last.saved.search_id, r.report.search_id);
  assert.equal(r.last.saved.typical, 1099);
  assert.equal(r.last.saved.by.name, "Test User");
  const create = w.lark.find((c) => c.method === "POST" && /\/records\?/.test(c.url));
  assert.match(create.url, /user_id_type=open_id/);
  const f = create.body.fields;
  assert.equal(f.Item, "Monoblock chair");
  assert.equal(f["Typical price"], 1099);
  assert.equal(f["Low price"], 650);
  assert.equal(f["High price"], 1344);
  assert.equal(f.Unit, "piece");
  assert.equal(f.Depth, "Thorough");
  assert.equal(f.Confidence, "Medium");
  assert.equal(f["Search ID"], r.report.search_id);
  assert.equal(typeof f["Cost (USD)"], "number");
  assert.ok(!("Searched by" in f) && !("Searched on" in f), "Lark fills its own columns");
  assert.deepEqual(JSON.parse(f.Report).listings.map((l) => l.id), r.report.listings.map((l) => l.id));
  const again = world({ env: LOGIN, answers: [submitted()] });
  const v2 = await again.post({ name: "Monoblock chair", depth: "thorough", search_id: "psmh3x9k2a1b" }, { token: GOOD });
  assert.equal(v2.report.search_id, "psmh3x9k2a1b", "a new version keeps the search's id");
});

test("the save still happens when the page has gone after the report", async () => {
  const w = world({ env: LOGIN, answers: [submitted()] });
  const res = await w.handle(new Request("http://svc/research", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Authorization: `Bearer ${GOOD}` }, body: JSON.stringify({ name: "Monoblock chair", depth: "thorough" }) }));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (!text.includes('"type":"report"')) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); }
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.rows.length, 1, "the search is in the table");
  assert.ok(w.logs.some((l) => /^saved .*record=recNew1/.test(l)), w.logs.join("\n"));
});

test("a failed save is said plainly in the last line; the report still came", async () => {
  const w = world({ env: LOGIN, answers: [submitted()] });
  const r = await w.post(undefined, { token: READER });
  assert.ok(r.report);
  assert.equal(r.last.saved, null);
  assert.equal(r.last.error.code, "not_authorized");
});

test("a paused turn is continued with the answer sent back verbatim, the same tools and the container", async () => {
  const first = researchBlocks().slice(0, 4);   // thinking, code, a nested search and its results
  const w = world({ answers: [eventsFor(first, { stop: "pause_turn", container: { id: "cont_1", expires_at: "x" } }), submitted()] });
  const r = await w.post();
  assert.ok(r.report);
  assert.equal(w.bodies.length, 2);
  const [a, b] = w.bodies;
  assert.deepEqual(b.messages.slice(0, 1), a.messages);
  assert.deepEqual(b.messages[1], { role: "assistant", content: strip(first) });
  assert.equal(b.messages.length, 2);
  assert.equal(b.container, "cont_1");
  assert.equal(a.container, undefined);
  assert.deepEqual(b.tools, a.tools);
  assert.deepEqual(b.system, a.system);
  assert.equal(r.report.meta.continuations, 1);
});

test("past the depth's continuations, a system message asks for the report", async () => {
  const pause = () => eventsFor([{ type: "text", text: "still looking" }], { stop: "pause_turn", model: "claude-haiku-5-5" });
  const w = world({ answers: [pause(), pause(), submitted({ model: "claude-haiku-5-5" })] });
  const r = await w.post({ name: "Monoblock chair", depth: "quick" });
  assert.ok(r.report);
  const last = w.bodies[2].messages;
  assert.deepEqual(last[last.length - 1], { role: "system", content: WRAP_UP });
  assert.equal(r.report.meta.ended, "wrapped_up");
  assert.ok(r.lines.some((l) => l.type === "activity" && l.kind === "wrap_up"));
  assert.ok(r.report.warnings.some((x) => /asked to stop early/.test(x.text)));
});

test("an answer that ends without a report gets one nudge", async () => {
  const w = world({ answers: [eventsFor([{ type: "text", text: "Here are prices…" }], { stop: "end_turn" }), submitted()] });
  const r = await w.post();
  assert.ok(r.report);
  const m = w.bodies[1].messages;
  assert.equal(m[1].role, "assistant");
  assert.deepEqual(m[2], { role: "user", content: [{ type: "text", text: NUDGE }] });
  assert.equal(r.report.meta.ended, "nudged");
});

test("two answers without a report end the run with a clear error, and nothing is saved", async () => {
  const endTurn = () => eventsFor([{ type: "text", text: "Done." }], { stop: "end_turn" });
  const w = world({ env: LOGIN, answers: [endTurn(), endTurn()] });
  const r = await w.post(undefined, { token: GOOD });
  assert.deepEqual(r.last, { type: "error", error: { code: "no_report", message: r.last.error.message } });
  assert.equal(w.rows.length, 0);
});

test("a refusal and an overloaded API become plain errors in the stream", async () => {
  const refused = await world({ answers: [eventsFor([{ type: "text", text: "" }], { stop: "refusal" })] }).post();
  assert.equal(refused.last.error.code, "refused");
  const overloaded = () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529 });
  const r = await world({ answers: [overloaded, overloaded] }).post();
  assert.equal(r.last.error.code, "upstream_unavailable");
  assert.ok(r.lines.some((l) => l.type === "activity" && l.kind === "retry"), "it retried once first");
});

test("Quick runs on Haiku, without the refusal fallback", async () => {
  const w = world({ answers: [submitted({ model: "claude-haiku-5-5" })] });
  await w.post({ name: "Monoblock chair" });
  assert.equal(w.bodies[0].model, "claude-haiku-5-5");
  assert.equal(w.bodies[0].fallbacks, undefined);
  assert.equal(w.headers[0].get("anthropic-beta"), null);
});

test("product photos come from the listings' own pages; a page that refuses gets none", async () => {
  const w = world({ images: true, answers: [submitted()] });
  const r = await w.post();
  assert.ok(r.lines.some((l) => l.type === "activity" && l.kind === "images"));
  assert.equal(r.report.listings[0].image, "https://cdn.ace-example.ph/chair.jpg?w=600&h=600");
  assert.ok(r.report.listings.slice(1).every((l) => l.image === ""));
  assert.ok(w.pages.length >= 4 && w.pages.length <= 5);
});

test("checks before anything streams: origin, login, body, input, rate limit, busy", async () => {
  assert.equal((await world().post(undefined, { origin: "https://evil.example" })).status, 403);
  const locked = world({ env: LOGIN, answers: [submitted()] });
  assert.equal((await locked.post()).status, 401);
  assert.equal((await locked.post(undefined, { token: OUTSIDER })).status, 403);
  assert.equal((await locked.post(undefined, { token: GOOD })).status, 200);
  assert.equal((await world().post(undefined, { raw: "{not json" })).status, 400);
  const bad = await world().post({ name: "x" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "bad_input");
  assert.equal((await world().post(undefined, { raw: JSON.stringify({ name: "chair", details: "x".repeat(20000) }) })).status, 413);
  const limited = world({ env: { RATE_LIMIT_PER_HOUR: "1" }, answers: [submitted(), submitted()] });
  assert.equal((await limited.post()).status, 200);
  const second = await limited.post();
  assert.equal(second.status, 429);
  assert.ok(Number(second.res.headers.get("Retry-After")) > 0);
});

test("a run in progress holds a slot; a second one is told the service is busy", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async (init) => { await gate; return sseResponse(submitted(), { signal: init.signal }); };
  const w = world({ env: { MAX_CONCURRENT: "1" }, answers: [slow, submitted()] });
  const h = { "Content-Type": "application/json", Origin: ORIGIN };
  const first = await w.handle(new Request("http://svc/research", { method: "POST", headers: h, body: JSON.stringify({ name: "Chair one" }) }));
  const busy = await w.handle(new Request("http://svc/research", { method: "POST", headers: h, body: JSON.stringify({ name: "Chair two" }) }));
  assert.equal(busy.status, 503);
  assert.equal((await busy.json()).error.code, "busy");
  release();
  await first.text();
  const after = await w.handle(new Request("http://svc/research", { method: "POST", headers: h, body: JSON.stringify({ name: "Chair three" }) }));
  assert.equal(after.status, 200, "the slot is free again once the stream ends");
  await after.text();
});

test("cancelling the stream aborts the Anthropic request", async () => {
  let aborted = null;
  const hang = (init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
  });
  const w = world({ answers: [hang] });
  const res = await w.handle(new Request("http://svc/research", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ name: "Monoblock chair" }) }));
  const reader = res.body.getReader();
  await reader.read();   // the start line
  await new Promise((r) => setTimeout(r, 20));
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(aborted, true);
  assert.ok(w.logs.some((l) => /^research cancelled/.test(l)), w.logs.join("\n"));
});

// ---- the saved searches --------------------------------------------------------------------------
const savedRow = async () => {
  const w = world({ env: LOGIN, answers: [submitted()] });
  const r = await w.post(undefined, { token: GOOD });
  return { w, r, id: r.last.saved.record_id };
};

test("GET /searches lists the table as the person, light and newest first", async () => {
  const { w } = await savedRow();
  w.rows.push({ record_id: "recOlder1", created_time: Date.UTC(2026, 10, 1), created_by: { id: "ou_a", name: "Ana" },
    fields: { Item: [{ type: "text", text: "AA batteries" }], "Search ID": [{ type: "text", text: "psolder0001" }], "Typical price": 56, Unit: "piece", Depth: "Quick", Confidence: "Low" } });
  const res = await w.call("GET", "/searches");
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 2);
  assert.deepEqual(res.body.searches.map((s) => s.item), ["Monoblock chair", "AA batteries"]);
  const old = res.body.searches[1];
  assert.deepEqual([old.search_id, old.typical, old.depth, old.confidence, old.by.name], ["psolder0001", 56, "quick", "low", "Ana"]);
  assert.ok(!("report" in res.body.searches[0]), "the list carries no reports");
  const search = w.lark.find((c) => c.url.startsWith(TABLE) && c.url.includes("/records/search"));
  assert.equal(search.body.automatic_fields, true);
  assert.ok(!search.body.field_names.includes("Report"));
});

test("GET /searches/<id> brings the report back; PATCH works the price out again and saves it", async () => {
  const { w, r, id } = await savedRow();
  const one = await w.call("GET", `/searches/${id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.search.report.listings.map((l) => l.id), r.report.listings.map((l) => l.id));
  const patched = await w.call("PATCH", `/searches/${id}`, { body: { included: ["l1", "l4"] } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.search.typical, 1321.5);
  assert.deepEqual(patched.body.search.report.price.included, ["l1", "l4"]);
  const put = w.lark.find((c) => c.method === "PUT");
  assert.equal(put.body.fields["Typical price"], 1321.5);
  assert.deepEqual(JSON.parse(put.body.fields.Report).price.included, ["l1", "l4"]);
  assert.ok(!("Item" in put.body.fields), "only the price and the report change");
  assert.equal((await w.call("GET", "/searches/recMissing9")).status, 404);
  assert.equal((await w.call("GET", "/searches/not-a-record")).status, 404);
  assert.equal((await w.call("PATCH", `/searches/${id}`, { body: { nope: 1 } })).status, 400);
});

test("POST /searches saves a report whose automatic save failed", async () => {
  const { w, r } = await savedRow();
  const res = await w.call("POST", "/searches", { body: { report: { ...r.report, search_id: "" } } });
  assert.equal(res.status, 201);
  assert.equal(res.body.search.record_id, "recNew2");
  assert.match(res.body.search.search_id, /^ps/);
  assert.equal((await w.call("POST", "/searches", { body: { report: { nope: true } } })).status, 400);
});

test("the /searches routes need the login, and the table's own sharing decides", async () => {
  const { w } = await savedRow();
  assert.equal((await w.call("GET", "/searches", { token: "" })).status, 401);
  assert.equal((await w.call("GET", "/searches", { token: OUTSIDER })).status, 403);
  const off = world();
  const res = await off.call("GET", "/searches", { token: "" });
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, "searches_unavailable");
});
