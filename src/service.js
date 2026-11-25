/*
 * price-research: the price check demo's service. One JavaScript file for two hosts.
 *
 * Why this exists
 * ---------------
 * The page can't hold the Anthropic API key: anything shipped to a browser is public. This service
 * keeps it server-side and exposes ONE narrow operation, "research the market price of this item or
 * service", not a general Claude relay. The prompt, the tools, the report schema and the checks
 * against what the research saw all live here.
 *
 *     browser ──POST /research (JSON)──▶ this service ──Messages API + web search──▶ Claude
 *             ◀── NDJSON stream: progress lines, then the checked report ◀
 *
 * Where it runs (same code; GET / says which answered in "runtime")
 *   Node        server.js: on this computer for the demo (127.0.0.1:8003), or Render (Docker).
 *   Cloudflare  src/worker.js (wrangler.toml). Past costings come from anthropic-ce's D1 database
 *               (bound as DB); only here, and only with the Lark login check on.
 *
 * Endpoints
 *   GET  /           version, runtime, models, depths, limits, CORS headers. Open to any origin,
 *                    never cached; the page calls it to wake and check the service.
 *   GET  /health     {"status":"ok"}
 *   POST /research   Authorization: Bearer <Lark user_access_token> (unless REQUIRE_LARK_LOGIN=false)
 *                    JSON: { source: "costings"|"web", kind, name, details, quantity, unit, market,
 *                            city, condition, depth, suppliers, model, sites: { mode, list } }
 *                    source "costings" (costings.js): Mineski's past CE lines only, free, a second.
 *                    "web" (the default): research with web search on the chosen model (Haiku +
 *                    Quick is the page's "Quick web check"), with past costings added alongside.
 *                    -> 200 application/x-ndjson (see ndjson.js), or a JSON error before streaming.
 *   OPTIONS *        CORS preflight
 *
 * Research only reads the web and writes nothing anywhere.
 */
import { LarkAuth, AuthError, httpGetWith } from "./lark-auth.js";
import { Client, ClaudeError, FALLBACK_BETA } from "./claude.js";
import { MODELS, DEFAULT_MODEL, DEPTHS, MARKETS, LIMITS, readInput, InputError } from "./request.js";
import { runResearch, RunError, ESTIMATE_MS, caps } from "./research.js";
import { collectEvidence } from "./evidence.js";
import { buildReport } from "./report.js";
import { createWriter, CONTENT_TYPE } from "./ndjson.js";
import { findCostings, costingsReport, referenceText, searchTerms } from "./costings.js";
import { findPOs } from "./pos.js";
import { bearer } from "./lark-auth.js";

export const SERVICE = "price-research";
export const VERSION = "0.5.0";
export const API_VERSION = 1;
export const ALLOW_HEADERS = ["Content-Type", "Authorization"];
export const KEY_ENV_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"];
const MAX_BODY = 16384;
const PING_MS = 15000;
const COSTINGS_ESTIMATE_MS = 3000;

const cleanKey = (v) => String(v || "").trim().replace(/^["']+|["']+$/g, "").trim();
/* A setting as text. Workers hands over JSON-typed variables as booleans and numbers, and people
   paste values with quotes ("false"): both are read as the plain text they mean. */
const str = (env, name, def = "") => {
  const v = env[name];
  if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return String(v);
  if (typeof v !== "string") return def;
  return v.trim().replace(/^(["'])(.*)\1$/, "$2");
};
function int(env, name, def) {
  const raw = str(env, name, "").trim();
  return /^-?\d+$/.test(raw) ? parseInt(raw, 10) : def;
}
function dec(env, name, def) {
  const v = Number(str(env, name, "").trim());
  return str(env, name, "").trim() && Number.isFinite(v) ? v : def;
}
const truthy = (v) => !["0", "false", "no", "off"].includes(String(v).trim().toLowerCase());

/** The shared Anthropic key from the environment or a Render Secret File; source never holds the key. */
export function loadKey(env = {}, files = {}) {
  const byUpper = new Map(Object.keys(env).filter((k) => typeof env[k] === "string").map((k) => [k.toUpperCase(), k]));
  for (const wanted of KEY_ENV_NAMES) {
    const name = byUpper.get(wanted);
    if (name && cleanKey(env[name])) return { key: cleanKey(env[name]), source: `environment variable ${name}` };
  }
  for (const [path, text] of Object.entries(files)) if (cleanKey(text)) return { key: cleanKey(text), source: `secret file ${path}` };
  return { key: "", source: "" };
}

/**
 * Settings (a .env file next to server.js on this computer; environment variables on Render;
 * Variables and Secrets on the Worker):
 *   ANTHROPIC_API_KEY     REQUIRED, as a secret
 *   REQUIRE_LARK_LOGIN    default true. false only on this computer (server.js refuses otherwise)
 *   LARK_BASE_TOKEN       the Base whose table grants access (default: Suppliers' procurement Base)
 *   LARK_TABLE_ID         that table (default: the procurement table)
 *   ALLOWED_ORIGINS       comma list (default http://127.0.0.1:9128, the demo page)
 *   MODELS                the models people may pick, comma list (default all three)
 *   DEFAULT_MODEL         default claude-opus-5-5
 *   REFUSAL_FALLBACK      "default" (Anthropic retries a refusal on another model) or "off"
 *   MAX_RUN_USD           one run's spending limit in USD (default 2; it's asked to wrap up at 70%)
 *   MAX_OUTPUT_TOKENS     default 64000
 *   RATE_LIMIT_PER_HOUR   runs per person (default 10; per copy on Workers)
 *   MAX_CONCURRENT        runs at once (default 2)
 *   COSTINGS_RATE_LIMIT_PER_HOUR  past-costings-only checks per person (default 120)
 *   REQUEST_TIMEOUT       seconds per Anthropic request (default 300)
 *   RUN_TIMEOUT           seconds per run (default 480)
 *   TZ_OFFSET_HOURS       for "today's date" and log times (default 8, Manila)
 */
export function readConfig(env = {}, { runtime = "node", secretFiles = {} } = {}) {
  const workers = runtime === "cloudflare-workers";
  const { key, source } = loadKey(env, secretFiles);
  const origins = new Set(str(env, "ALLOWED_ORIGINS", "http://127.0.0.1:9128").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean));
  const allowed = str(env, "MODELS", Object.keys(MODELS).join(",")).split(",").map((m) => m.trim()).filter((m) => MODELS[m]);
  const models = allowed.length ? allowed : Object.keys(MODELS);
  const wantedDefault = str(env, "DEFAULT_MODEL", DEFAULT_MODEL).trim();
  const cfg = {
    runtime,
    apiKey: key,
    keySource: source,
    models,
    defaultModel: models.includes(wantedDefault) ? wantedDefault : models[0],
    fallback: str(env, "REFUSAL_FALLBACK", "default").trim().toLowerCase() !== "off",
    maxRunUsd: Math.max(0.1, dec(env, "MAX_RUN_USD", 2)),
    maxTokens: Math.max(4000, int(env, "MAX_OUTPUT_TOKENS", 64000)),
    origins: origins.size ? origins : new Set(["http://127.0.0.1:9128"]),
    rateLimitPerHour: int(env, "RATE_LIMIT_PER_HOUR", 10),
    maxConcurrent: Math.max(1, int(env, "MAX_CONCURRENT", 2)),
    costingsRateLimitPerHour: int(env, "COSTINGS_RATE_LIMIT_PER_HOUR", 120),
    requestTimeoutMs: Math.max(30, int(env, "REQUEST_TIMEOUT", 300)) * 1000,
    runTimeoutMs: Math.max(60, int(env, "RUN_TIMEOUT", 480)) * 1000,
    tzOffsetHours: dec(env, "TZ_OFFSET_HOURS", 8),
    commit: (str(env, "RENDER_GIT_COMMIT") || str(env, "COMMIT")).slice(0, 7) || null,
    lark: {
      baseToken: str(env, "LARK_BASE_TOKEN", "NP7TbjwHNaTyLOsWafelN9wNgEd").trim(),
      tableId: str(env, "LARK_TABLE_ID", "tbl3ki9aAQsWCJuR").trim(),
      required: truthy(str(env, "REQUIRE_LARK_LOGIN", "true")),
      ttlSeconds: int(env, "LARK_AUTH_CACHE_S", 300),
      tool: "price research",
      tableLabel: str(env, "LARK_TABLE_LABEL", "the procurement table").trim(),
    },
    problems: [],
  };
  if (!Number.isFinite(cfg.tzOffsetHours) || Math.abs(cfg.tzOffsetHours) > 14) cfg.tzOffsetHours = 8;
  const where = workers ? "Add it under the Worker > Settings > Variables and Secrets, then deploy again."
    : runtime === "node" ? "Add it to the .env file next to server.js (or the environment), then start it again." : "";
  if (!cfg.apiKey) cfg.problems.push(`ANTHROPIC_API_KEY must be set. ${where}`);
  if (cfg.lark.required && (!cfg.lark.baseToken || !cfg.lark.tableId)) cfg.problems.push(`LARK_BASE_TOKEN and LARK_TABLE_ID must be set when REQUIRE_LARK_LOGIN is on. ${where}`);
  return cfg;
}

/** "YYYY-MM-DD" in the service's time zone. */
export const today = (offsetHours = 8, now = Date.now()) => new Date(now + offsetHours * 3600000).toISOString().slice(0, 10);

export class ApiError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    Object.assign(this, { status, code, headers });
  }
}

export class RateLimiter {
  constructor(perHour) { this.perHour = perHour; this.hits = new Map(); }
  check(key, now = Date.now()) {
    if (this.perHour <= 0) return 0;
    const q = (this.hits.get(key) || []).filter((t) => now - t <= 3600000);
    if (q.length >= this.perHour) { this.hits.set(key, q); return Math.floor((3600000 - (now - q[0])) / 1000) + 1; }
    q.push(now);
    this.hits.set(key, q);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => now - t <= 3600000)) this.hits.delete(k);
    return 0;
  }
}

export class Slots {
  constructor(n) { this.free = n; }
  take() { if (this.free <= 0) return false; this.free--; return true; }
  release() { this.free++; }
}

/** Anthropic's failure as the sentence the page shows. */
export function describeClaudeError(e) {
  if (e.kind === "config") return { code: "not_configured", message: "The service's Anthropic key was refused. Ask the admin to check it." };
  if (e.kind === "quota") return { code: "quota_exceeded", message: "The Anthropic account has hit its usage limit for now. Try again in a few minutes." };
  if (e.kind === "retryable") return { code: "upstream_unavailable", message: "Claude is overloaded or the connection dropped. Try again in a minute." };
  if (e.kind === "cancelled") return { code: "cancelled", message: "Cancelled." };
  if (e.kind === "timeout") return { code: "timeout", message: "The research took too long and was stopped. Try Quick, or a more specific name." };
  if (e.kind === "content") return { code: "content_rejected", message: `Anthropic refused the request: ${String(e.message || "").slice(0, 300)}` };
  return { code: "upstream_error", message: "Claude couldn't finish this research. Try again." };
}

let seq = 0;
const newId = () => `r${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, "0")}`;

/**
 * The service.
 *   opts.prompt     prompt.md's text (required)
 *   opts.fetch      the fetch for Anthropic and Lark (tests pass a fake)
 *   opts.log, opts.runtime ("node" | "cloudflare-workers"), opts.secretFiles
 *   opts.db         anthropic-ce's D1 database with the CE line items (Workers: env.DB), or null
 *   opts.record     (name, data) => void: keeps each Anthropic request and answer of a run (Node's
 *                   RECORD_RUNS=1 writes them to runs/, to check the answers' real shapes)
 */
export function createService(env = {}, { prompt, fetch: upstream = (...a) => globalThis.fetch(...a),
  log = (line) => console.log(line), runtime = "node", secretFiles = {}, record = null, db = null } = {}) {
  if (!prompt) throw new Error("createService needs the prompt (prompt.md)");
  const cfg = readConfig(env, { runtime, secretFiles });
  cfg.problems.forEach((p) => log(`config problem: ${p}`));
  const auth = new LarkAuth(cfg.lark);
  const limiter = new RateLimiter(cfg.rateLimitPerHour);
  const costingsLimiter = new RateLimiter(cfg.costingsRateLimitPerHour);
  const slots = new Slots(cfg.maxConcurrent);
  const openCors = cfg.origins.has("*");
  const service = { name: SERVICE, version: VERSION, runtime };

  function corsHeaders(origin, open = false) {
    const h = new Headers();
    if (open || openCors) h.set("Access-Control-Allow-Origin", "*");
    else if (origin && cfg.origins.has(origin)) { h.set("Access-Control-Allow-Origin", origin); h.set("Vary", "Origin"); }
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", ALLOW_HEADERS.join(", "));
    h.set("Access-Control-Expose-Headers", "Retry-After");
    h.set("Access-Control-Max-Age", "7200");
    return h;
  }

  function info() {
    return {
      service: SERVICE, version: VERSION, api: API_VERSION, commit: cfg.commit, runtime,
      configured: !!cfg.apiKey,
      key: { configured: !!cfg.apiKey, source: cfg.keySource || null },
      models: cfg.models.map((id) => ({ id, label: MODELS[id].label, default: id === cfg.defaultModel })),
      depths: Object.entries(DEPTHS).map(([id, d]) => ({ id, label: d.label, effort: d.effort, searches: d.searches, fetches: d.fetches, estimate_ms: ESTIMATE_MS[id] })),
      markets: Object.entries(MARKETS).map(([id, m]) => ({ id, name: m.name, currency: m.currency })),
      refusal_fallback: cfg.fallback ? "default" : "off",
      endpoints: ["GET /", "GET /health", "POST /research"],
      features: ["web-search", "checked-prices", "suppliers", "ndjson-progress", ...(db && cfg.lark.required ? ["costings"] : [])],
      costings: db && cfg.lark.required ? { available: true } : { available: false, reason: db ? "needs the Lark login check on" : "only on the Cloudflare copy" },
      cors: { origins: openCors ? "*" : [...cfg.origins].sort(), allow_headers: [...ALLOW_HEADERS] },
      login: { provider: "lark", required: cfg.lark.required },
      limits: { max_run_usd: cfg.maxRunUsd, rate_limit_per_hour: cfg.rateLimitPerHour, costings_rate_limit_per_hour: cfg.costingsRateLimitPerHour,
        max_concurrent: cfg.maxConcurrent,
        run_timeout_s: Math.round(cfg.runTimeoutMs / 1000), max_body_bytes: MAX_BODY, ...LIMITS },
    };
  }

  /** Every check that can refuse a run, before anything streams. Resolves { input, user }. */
  async function admit(request, ip) {
    const origin = (request.headers.get("Origin") || "").replace(/\/+$/, "");
    if (origin && !openCors && !cfg.origins.has(origin)) throw new ApiError(403, "forbidden_origin", "This page isn't allowed to use the price research service.");
    let user = null;
    try {
      user = await auth.verify(request.headers.get("Authorization"), httpGetWith(upstream));
    } catch (e) {
      if (e instanceof AuthError) throw new ApiError(e.status, e.code, e.message);
      throw e;
    }
    const ctype = (request.headers.get("Content-Type") || "").toLowerCase();
    if (!ctype.startsWith("application/json")) throw new ApiError(415, "bad_request", "Send the request as JSON.");
    const length = Number(request.headers.get("Content-Length") || "");
    if (length > MAX_BODY) throw new ApiError(413, "too_large", "The request is too long. Shorten the details and try again.");
    let raw;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) throw new ApiError(413, "too_large", "The request is too long. Shorten the details and try again.");
      raw = JSON.parse(text);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(400, "bad_request", "The request couldn't be read.");
    }
    let input;
    try { input = readInput(raw, { models: cfg.models, defaultModel: cfg.defaultModel }); } catch (e) {
      if (e instanceof InputError) throw new ApiError(400, "bad_input", e.message);
      throw e;
    }
    const wait = (input.source === "costings" ? costingsLimiter : limiter).check(user && user.open_id ? `user:${user.open_id}` : `ip:${ip}`);
    if (wait) throw new ApiError(429, "rate_limited", `You've run a lot of price checks in the last hour. Try again in ${Math.ceil(wait / 60)} min.`, { "Retry-After": String(wait) });
    if (!slots.take()) throw new ApiError(503, "busy", "The service is busy with other price checks. Try again in a minute.", { "Retry-After": "30" });
    return { input, user, token: cfg.lark.required ? bearer(request.headers.get("Authorization")) : "" };
  }

  /** Stream one run: start, progress, then the report or an error. Frees the slot at the end. */
  function stream(input, user, { origin, signal, waitUntil, token = "" }) {
    const id = newId();
    const started = Date.now();
    const cancel = new AbortController();
    const out = createWriter({ onGone: () => cancel.abort() });
    const signals = [cancel.signal, signal].filter(Boolean);
    const runSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const who = user && user.open_id ? ` user=${user.open_id.slice(0, 12)}` : "";
    const lim = caps(input);

    const pump = (async () => {
      const ping = setInterval(() => { out.line({ type: "ping" }); }, PING_MS);
      try {
        // Mineski's own prices: CE lines (D1) and approved purchase requests (Lark, as this person).
        const past = async () => {
          const [c, p] = await Promise.all([
            findCostings(db, input, { loginRequired: cfg.lark.required }),
            findPOs({ fetch: upstream, token, baseToken: cfg.lark.baseToken, tableId: cfg.lark.tableId, terms: searchTerms(input.name), signal: runSignal, log }),
          ]);
          if (c.error) log(`costings error: ${c.error}`);
          const { error, ...rest } = c;
          const all = { ...rest, available: rest.available || p.available, reason: rest.available || p.available ? "" : rest.reason,
            ce_available: rest.available, ce_reason: rest.reason, pos: p.lines, pos_available: p.available, pos_reason: p.reason };
          out.line({ type: "activity", kind: "costings", count: rest.lines.length, pos: p.lines.length, available: all.available });
          return all;
        };
        if (input.source === "costings") {
          await out.line({ type: "start", id, source: "costings", estimate_ms: COSTINGS_ESTIMATE_MS });
          const costings = await past();
          if (!costings.available) throw new RunError("costings_unavailable", `${costings.reason} Use a web check instead.`);
          await out.line({ type: "activity", kind: "checking" });
          const report = costingsReport({ input, costings, id, createdAt: new Date().toISOString(), service, startedAt: started });
          await out.line({ type: "report", report });
          log(`costings 200${who} id=${id} terms=${costings.terms.join("+")} lines=${costings.lines.length} ms=${report.meta.duration_ms}`);
          return;
        }
        await out.line({ type: "start", id, source: "web", model: input.model, depth: input.depth, caps: { searches: lim.searches, fetches: lim.fetches },
          estimate_ms: ESTIMATE_MS[input.depth], max_run_usd: cfg.maxRunUsd });
        const known = await past().catch(() => null);   // before the research: it's Claude's reference
        const client = new Client(cfg.apiKey, { fetch: upstream, betas: cfg.fallback && MODELS[input.model].fallback ? [FALLBACK_BETA] : [] });
        const { report: raw, run } = await runResearch({ client, input, system: prompt, today: today(cfg.tzOffsetHours), cfg,
          signal: runSignal, emit: (obj) => { out.line(obj); }, log, reference: known ? referenceText(known, input) : "",
          onResponse: record ? ({ n, body, msg }) => record(`${id}-${n}`, { input, body, response: msg }) : null });
        await out.line({ type: "activity", kind: "checking" });
        const ev = collectEvidence(run.blocks);
        const report = buildReport({ input, raw, ev, run, id, createdAt: new Date().toISOString(), service, startedAt: started, costings: known });
        await out.line({ type: "report", report });
        const checked = report.listings.filter((l) => l.verification.status === "checked").length;
        const m = report.meta;
        log(`research 200${who} id=${id} model=${m.models_used.join("+")} depth=${input.depth} ms=${m.duration_ms} requests=${m.requests} ` +
          `searches=${m.usage.web_search_requests} fetches=${m.usage.web_fetch_requests} listings=${report.listings.length} checked=${checked} ` +
          `suppliers=${report.suppliers.length} ended=${m.ended} in=${m.usage.input_tokens} out=${m.usage.output_tokens} ` +
          `cache_read=${m.usage.cache_read_input_tokens} usd=${m.cost_usd.total}`);
      } catch (e) {
        const err = e instanceof RunError ? { code: e.code, message: e.message }
          : e instanceof ClaudeError ? describeClaudeError(e)
          : { code: "internal", message: "Something went wrong on the server. Try again." };
        if (e instanceof ClaudeError) log(`claude error kind=${e.kind} status=${e.status}: ${String(e.message).slice(0, 300)}`);
        else if (!(e instanceof RunError)) log(`research internal ${(e && e.name) || "Error"}: ${(e && e.stack) || e}`);
        log(`${input.source === "costings" ? "costings" : "research"} ${err.code}${who} id=${id} model=${input.model} depth=${input.depth} ms=${Date.now() - started}`);
        await out.line({ type: "error", error: err });
      } finally {
        clearInterval(ping);
        slots.release();
        await out.close();
      }
    })();
    if (waitUntil) waitUntil(pump);
    const h = corsHeaders(origin);
    h.set("Content-Type", CONTENT_TYPE);
    h.set("Cache-Control", "no-store, no-transform");
    h.set("X-Content-Type-Options", "nosniff");
    return new Response(out.readable, { status: 200, headers: h });
  }

  return async function handle(request, { socketIp = "", waitUntil = null, signal = null } = {}) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const origin = (request.headers.get("Origin") || "").replace(/\/+$/, "");
    const ip = (request.headers.get("CF-Connecting-IP") || (request.headers.get("X-Forwarded-For") || "").split(",")[0]).trim() || socketIp || "-";
    const json = (status, obj, { headers = {}, open = false } = {}) => {
      const h = corsHeaders(origin, open);
      for (const [k, v] of Object.entries(headers)) h.set(k, v);
      h.set("Content-Type", "application/json; charset=utf-8");
      h.set("Cache-Control", "no-store");
      return new Response(JSON.stringify(obj), { status, headers: h });
    };
    const error = (e) => json(e.status, { error: { code: e.code, message: e.message } }, { headers: e.headers });

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (cfg.problems.length) {
      log(`"${method} ${path}" 503 misconfigured`);
      return json(503, { error: { code: "misconfigured", message: "The price research service is missing a setting. Whoever runs it can see which in its log." } },
        { open: true, headers: { "Retry-After": "0" } });
    }
    if (method === "GET" && path === "/health") return json(200, { status: "ok" });
    if (method === "GET" && path === "/") return json(200, info(), { open: true });
    if (method === "POST" && path === "/research") {
      let admitted;
      try {
        admitted = await admit(request, ip);
      } catch (e) {
        if (e instanceof ApiError) { log(`research ${e.status} ${e.code}`); return error(e); }
        log(`research 500 internal ${(e && e.name) || "Error"}: ${(e && e.message) || e}`);
        return error(new ApiError(500, "internal", "Something went wrong on the server. Try again."));
      }
      return stream(admitted.input, admitted.user, { origin, signal, waitUntil, token: admitted.token });
    }
    if (method !== "GET" && method !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Use GET or POST." } });
    return json(404, { error: { code: "not_found", message: method === "POST" ? "Use POST /research." : "Not found." } });
  };
}
