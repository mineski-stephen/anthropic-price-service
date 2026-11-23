// The HTTP service with Anthropic and Lark faked: checks, the stream, pauses, nudges, cancel. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createService, readConfig, VERSION, ALLOW_HEADERS, today } from "../src/service.js";
import { parseLines } from "../src/ndjson.js";
import { NUDGE, WRAP_UP } from "../src/request.js";
import { eventsFor, sseResponse, researchBlocks, REPORT, strip } from "./helpers.mjs";

const PROMPT = readFileSync(new URL("../prompt.md", import.meta.url), "utf8");
const GOOD = "u-good-token-0123456789abcdef";
const OUTSIDER = "u-outsider-token-0123456789abc";
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-0123456789", REQUIRE_LARK_LOGIN: "false" };
const ORIGIN = "http://127.0.0.1:9128";
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

/** A fake world: `answers` are what Anthropic says to each request in turn (event lists or functions). */
function world({ env = {}, answers = [] } = {}) {
  const w = { bodies: [], headers: [], signals: [], logs: [], records: [] };
  let n = 0;
  const fetch = async (url, init = {}) => {
    url = String(url);
    const h = new Headers(init.headers);
    if (url.startsWith("https://open.larksuite.com/")) {
      const token = (h.get("Authorization") || "").slice(7);
      if (url.includes("/authen/v1/user_info")) return json(200, { code: 0, data: { open_id: `ou_${token.slice(2, 10)}`, name: "Test User" } });
      if (token === OUTSIDER) return json(403, { code: 91403, msg: "Forbidden" });
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
    throw new Error(`unexpected call ${url}`);
  };
  w.handle = createService({ ...ENV, ...env }, { prompt: PROMPT, fetch, log: (l) => w.logs.push(l), record: (name, data) => w.records.push(name) });
  w.post = async (body = { name: "Monoblock chair", quantity: 200, city: "Manila" }, { origin = ORIGIN, token = "", raw } = {}) => {
    const h = new Headers({ "Content-Type": "application/json" });
    if (origin) h.set("Origin", origin);
    if (token) h.set("Authorization", `Bearer ${token}`);
    const res = await w.handle(new Request("http://svc/research", { method: "POST", headers: h, body: raw !== undefined ? raw : JSON.stringify(body) }));
    if (!(res.headers.get("Content-Type") || "").includes("ndjson")) return { status: res.status, body: await res.json(), res };
    const [lines] = parseLines(`${await res.text()}\n`);
    return { status: res.status, lines, res, last: lines[lines.length - 1] };
  };
  return w;
}

const submitted = (opts = {}) => eventsFor(researchBlocks(), { stop: "tool_use", searches: 1, fetches: 2, ...opts });

test("GET / reports the service, version, models, depths and allowed headers, never the key", async () => {
  const res = await world().handle(new Request("http://svc/"));
  const info = await res.json();
  assert.equal(res.status, 200);
  assert.equal(info.service, "price-research");
  assert.equal(info.version, VERSION);
  assert.deepEqual(info.cors.allow_headers, ALLOW_HEADERS);
  assert.deepEqual(info.models.map((m) => m.id), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  assert.equal(info.models.find((m) => m.default).id, "claude-opus-5-5");
  assert.deepEqual(info.depths.map((d) => d.id), ["quick", "standard", "thorough"]);
  assert.equal(info.login.required, false);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.ok(!JSON.stringify(info).includes(ENV.ANTHROPIC_API_KEY));
});

test("settings: a missing key makes every route answer 503; login is on unless switched off", async () => {
  const res = await world({ env: { ANTHROPIC_API_KEY: "" } }).handle(new Request("http://svc/"));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "misconfigured");
  assert.equal(readConfig({ ANTHROPIC_API_KEY: "k" }).lark.required, true);
  assert.equal(readConfig({ ANTHROPIC_API_KEY: "k", TZ_OFFSET_HOURS: "nope" }).tzOffsetHours, 8);
  assert.equal(today(8, Date.UTC(2026, 10, 22, 17, 0)), "2026-11-23", "Manila is already on the 23rd");
});

test("a research run streams start, progress, usage, then the checked report", async () => {
  const w = world({ answers: [submitted()] });
  const r = await w.post();
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get("Content-Type"), /application\/x-ndjson/);
  assert.equal(r.res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const types = r.lines.map((l) => l.type);
  assert.equal(types[0], "start");
  assert.equal(r.lines[0].estimate_ms, 120000);
  assert.deepEqual(r.lines[0].caps, { searches: 8, fetches: 6 });
  const kinds = r.lines.filter((l) => l.type === "activity").map((l) => l.kind);
  for (const k of ["filter", "search", "search_done", "fetch", "fetch_done", "writing", "checking"]) assert.ok(kinds.includes(k), `activity ${k}`);
  assert.ok(types.includes("usage"));
  assert.equal(r.last.type, "report");
  const rep = r.last.report;
  assert.deepEqual(rep.listings.map((l) => l.verification.status), ["checked", "checked", "checked", "link", "unverified"]);
  assert.equal(rep.meta.ended, "submitted");
  assert.equal(rep.meta.requests, 1);
  assert.equal(w.bodies.length, 1);
  assert.equal(w.bodies[0].stream, true);
  assert.equal(w.headers[0].get("anthropic-beta"), "server-side-fallback-2026-07-01");
  assert.equal(w.headers[0].get("anthropic-version"), "2026-10-21");
  assert.equal(w.headers[0].get("x-api-key"), ENV.ANTHROPIC_API_KEY);
  assert.deepEqual(w.records, [`${rep.id}-1`]);
  assert.ok(w.logs.some((l) => /^research 200 .*checked=3/.test(l)), w.logs.join("\n"));
});

test("a paused turn is continued with the answer sent back verbatim, the same tools and the container", async () => {
  const first = researchBlocks().slice(0, 4);   // thinking, code, a nested search and its results
  const w = world({ answers: [eventsFor(first, { stop: "pause_turn", container: { id: "cont_1", expires_at: "x" } }), submitted()] });
  const r = await w.post();
  assert.equal(r.last.type, "report");
  assert.equal(w.bodies.length, 2);
  const [a, b] = w.bodies;
  assert.deepEqual(b.messages.slice(0, 1), a.messages);
  assert.deepEqual(b.messages[1], { role: "assistant", content: strip(first) });
  assert.equal(b.messages.length, 2);
  assert.equal(b.container, "cont_1");
  assert.equal(a.container, undefined);
  assert.deepEqual(b.tools, a.tools);
  assert.deepEqual(b.system, a.system);
  assert.equal(r.last.report.meta.continuations, 1);
});

test("past the depth's continuations, a system message asks for the report", async () => {
  const pause = () => eventsFor([{ type: "text", text: "still looking" }], { stop: "pause_turn" });
  const w = world({ answers: [pause(), pause(), submitted()] });
  const r = await w.post({ name: "Monoblock chair", depth: "quick" });
  assert.equal(r.last.type, "report");
  const last = w.bodies[2].messages;
  assert.deepEqual(last[last.length - 1], { role: "system", content: WRAP_UP });
  assert.equal(r.last.report.meta.ended, "wrapped_up");
  assert.ok(r.lines.some((l) => l.type === "activity" && l.kind === "wrap_up"));
  assert.ok(r.last.report.warnings.some((x) => /asked to stop early/.test(x.text)));
});

test("an answer that ends without a report gets one nudge", async () => {
  const w = world({ answers: [eventsFor([{ type: "text", text: "Here are prices…" }], { stop: "end_turn" }), submitted()] });
  const r = await w.post();
  assert.equal(r.last.type, "report");
  const m = w.bodies[1].messages;
  assert.equal(m[1].role, "assistant");
  assert.deepEqual(m[2], { role: "user", content: [{ type: "text", text: NUDGE }] });
  assert.equal(r.last.report.meta.ended, "nudged");
});

test("two answers without a report end the run with a clear error", async () => {
  const endTurn = () => eventsFor([{ type: "text", text: "Done." }], { stop: "end_turn" });
  const r = await world({ answers: [endTurn(), endTurn()] }).post();
  assert.deepEqual(r.last, { type: "error", error: { code: "no_report", message: r.last.error.message } });
});

test("a refusal and an overloaded API become plain errors in the stream", async () => {
  const refused = await world({ answers: [eventsFor([{ type: "text", text: "" }], { stop: "refusal" })] }).post();
  assert.equal(refused.last.error.code, "refused");
  const overloaded = () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529 });
  const r = await world({ answers: [overloaded, overloaded] }).post();
  assert.equal(r.last.error.code, "upstream_unavailable");
  assert.ok(r.lines.some((l) => l.type === "activity" && l.kind === "retry"), "it retried once first");
});

test("Haiku runs without the refusal fallback", async () => {
  const w = world({ answers: [submitted({ model: "claude-haiku-5-5" })] });
  await w.post({ name: "Monoblock chair", model: "claude-haiku-5-5" });
  assert.equal(w.bodies[0].fallbacks, undefined);
  assert.equal(w.headers[0].get("anthropic-beta"), null);
});

test("checks before anything streams: origin, login, body, input, rate limit, busy", async () => {
  assert.equal((await world().post(undefined, { origin: "https://evil.example" })).status, 403);
  const locked = world({ env: { REQUIRE_LARK_LOGIN: "true" }, answers: [submitted()] });
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
