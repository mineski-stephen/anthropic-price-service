/*
 * price-research: the price check's service. One JavaScript file for two hosts.
 *
 * Why this exists
 * ---------------
 * The page can't hold the Anthropic API key: anything shipped to a browser is public. This service
 * keeps it server-side and exposes ONE narrow operation, "research the market price of this", not a
 * general Claude relay. The prompt, the tools, the report schema and the checks against what the
 * research saw all live here, and so does the shared list of saved searches (a Lark table).
 *
 *     browser ──POST /research (JSON)──▶ this service ──Messages API + web search──▶ Claude
 *             ◀── NDJSON stream: progress lines, the checked report, then "saved" ◀
 *                                        └──▶ Lark: the search is added to the saved searches
 *
 * Where it runs (same code; GET / says which answered in "runtime")
 *   Node        server.js: on this computer (127.0.0.1:8003), or Render (Docker).
 *   Cloudflare  src/worker.js (wrangler.toml). Past CE lines come from anthropic-ce's D1 database
 *               (bound as DB); only there, and only with the Lark login check on.
 *
 * Endpoints
 *   GET  /           version, runtime, depths, limits, CORS headers. Open to any origin, never
 *                    cached; the page calls it to wake and check the service.
 *   GET  /health     {"status":"ok"}
 *   POST /research   Authorization: Bearer <Lark user_access_token> (unless REQUIRE_LARK_LOGIN=false)
 *                    JSON: { name, details, depth: "quick"|"standard"|"thorough", search_id? }
 *                    (search_id: run it again as a new version of that saved search)
 *                    -> 200 application/x-ndjson (see ndjson.js), or a JSON error before streaming.
 *                    A finished search is saved to the Lark table as the person, even when the page
 *                    has gone by then; the "saved" line says how that went.
 *   GET  /searches                 every saved search (light: no report), newest first
 *   GET  /searches/<record_id>     one saved search, with its report
 *   PATCH /searches/<record_id>    { included: [listing ids] }: the listings that count changed;
 *                                  the price is worked out again and saved
 *   POST /searches                 { report }: save a report whose automatic save failed
 *   GET  /searches/setup           whether the table has every column this service writes
 *   POST /searches/setup           add the missing columns (once, by someone who can edit the table)
 *                    The /searches routes need the Lark login (they read and write Lark as the person).
 *   OPTIONS *        CORS preflight
 */
import { LarkAuth, AuthError, httpGetWith, bearer } from "./lark-auth.js";
import { Client, ClaudeError, FALLBACK_BETA } from "./claude.js";
import { MODELS, DEPTHS, DEFAULT_DEPTH, LIMITS, MARKET, readInput, modelFor, InputError } from "./request.js";
import { runResearch, RunError, ESTIMATE_MS, caps } from "./research.js";
import { collectEvidence } from "./evidence.js";
import { buildReport } from "./report.js";
import { createWriter, CONTENT_TYPE } from "./ndjson.js";
import { findCostings, referenceText, searchTerms, markRentals } from "./costings.js";
import { findPOs } from "./pos.js";
import { findImages } from "./images.js";
import { priceOf } from "./stats.js";
import { createSearches, SearchError, newSearchId, slimReport, isReport } from "./searches.js";

export const SERVICE = "price-research";
export const VERSION = "0.7.1";
export const API_VERSION = 1;
export const ALLOW_HEADERS = ["Content-Type", "Authorization"];
export const KEY_ENV_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"];
const MAX_BODY = 16384;
const MAX_SAVE_BODY = 300000;   // POST /searches carries a whole report
const PING_MS = 15000;
const RECORD_ID = /^rec[A-Za-z0-9]{4,40}$/;

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
 *   REQUIRE_LARK_LOGIN    default true. false only on this computer (server.js refuses otherwise);
 *                         saved searches and past prices need it on
 *   LARK_BASE_TOKEN       the Base whose table grants access (default: Suppliers' procurement Base)
 *   LARK_TABLE_ID         that table (default: the procurement table)
 *   SEARCHES_BASE_TOKEN   the saved searches' Base (default: LARK_BASE_TOKEN)
 *   SEARCHES_TABLE_ID     the saved searches' table (default: "Price searches", tblYUSBGnqwDp0PN)
 *   ALLOWED_ORIGINS       comma list (default http://127.0.0.1:9128, the page on this computer)
 *   MODELS                the models the depths may use, comma list (default all three)
 *   DEFAULT_MODEL         used when a depth's own model isn't in MODELS (default claude-opus-5-5)
 *   REFUSAL_FALLBACK      "default" (Anthropic retries a refusal on another model) or "off"
 *   MAX_RUN_USD           one run's spending limit in USD (default 2; it's asked to wrap up at 70%)
 *   MAX_OUTPUT_TOKENS     default 64000
 *   RATE_LIMIT_PER_HOUR   searches per person (default 10; per copy on Workers)
 *   READ_RATE_LIMIT_PER_HOUR  saved-search reads and changes per person (default 600)
 *   MAX_CONCURRENT        searches at once (default 2)
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
  const wantedDefault = str(env, "DEFAULT_MODEL", "claude-opus-5-5").trim();
  const baseToken = str(env, "LARK_BASE_TOKEN", "NP7TbjwHNaTyLOsWafelN9wNgEd").trim();
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
    readRateLimitPerHour: int(env, "READ_RATE_LIMIT_PER_HOUR", 600),
    maxConcurrent: Math.max(1, int(env, "MAX_CONCURRENT", 2)),
    requestTimeoutMs: Math.max(30, int(env, "REQUEST_TIMEOUT", 300)) * 1000,
    runTimeoutMs: Math.max(60, int(env, "RUN_TIMEOUT", 480)) * 1000,
    tzOffsetHours: dec(env, "TZ_OFFSET_HOURS", 8),
    commit: (str(env, "RENDER_GIT_COMMIT") || str(env, "COMMIT")).slice(0, 7) || null,
    lark: {
      baseToken,
      tableId: str(env, "LARK_TABLE_ID", "tbl3ki9aAQsWCJuR").trim(),
      required: truthy(str(env, "REQUIRE_LARK_LOGIN", "true")),
      ttlSeconds: int(env, "LARK_AUTH_CACHE_S", 300),
      tool: "price research",
      tableLabel: str(env, "LARK_TABLE_LABEL", "the procurement table").trim(),
    },
    searches: {
      baseToken: str(env, "SEARCHES_BASE_TOKEN", baseToken).trim(),
      tableId: str(env, "SEARCHES_TABLE_ID", "tblYUSBGnqwDp0PN").trim(),
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
  if (e.kind === "timeout") return { code: "timeout", message: "The search took too long and was stopped. Try Quick, or a more specific name." };
  if (e.kind === "content") return { code: "content_rejected", message: `Anthropic refused the request: ${String(e.message || "").slice(0, 300)}` };
  return { code: "upstream_error", message: "Claude couldn't finish this search. Try again." };
}

let seq = 0;
const newId = () => `r${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, "0")}`;

/**
 * The service.
 *   opts.prompt     prompt.md's text (required)
 *   opts.fetch      the fetch for Anthropic, Lark and the listings' pages (tests pass a fake)
 *   opts.log, opts.runtime ("node" | "cloudflare-workers"), opts.secretFiles
 *   opts.db         anthropic-ce's D1 database with the CE line items (Workers: env.DB), or null
 *   opts.record     (name, data) => void: keeps each Anthropic request and answer of a run (Node's
 *                   RECORD_RUNS=1 writes them to runs/, to check the answers' real shapes)
 *   opts.images     false: no product photos (tests)
 */
export function createService(env = {}, { prompt, fetch: upstream = (...a) => globalThis.fetch(...a),
  log = (line) => console.log(line), runtime = "node", secretFiles = {}, record = null, db = null, images = true } = {}) {
  if (!prompt) throw new Error("createService needs the prompt (prompt.md)");
  const cfg = readConfig(env, { runtime, secretFiles });
  cfg.problems.forEach((p) => log(`config problem: ${p}`));
  const auth = new LarkAuth(cfg.lark);
  const limiter = new RateLimiter(cfg.rateLimitPerHour);
  const readLimiter = new RateLimiter(cfg.readRateLimitPerHour);
  const slots = new Slots(cfg.maxConcurrent);
  const openCors = cfg.origins.has("*");
  const service = { name: SERVICE, version: VERSION, runtime };
  const searches = createSearches({ fetch: upstream, baseToken: cfg.searches.baseToken, tableId: cfg.searches.tableId, log });
  const saving = () => cfg.lark.required && !!cfg.searches.tableId;

  function corsHeaders(origin, open = false) {
    const h = new Headers();
    if (open || openCors) h.set("Access-Control-Allow-Origin", "*");
    else if (origin && cfg.origins.has(origin)) { h.set("Access-Control-Allow-Origin", origin); h.set("Vary", "Origin"); }
    h.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
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
      depths: Object.entries(DEPTHS).map(([id, d]) => {
        const model = modelFor(id, cfg.models, cfg.defaultModel);
        return { id, label: d.label, model, model_label: MODELS[model].label, effort: d.effort, searches: d.searches, fetches: d.fetches,
          estimate_ms: ESTIMATE_MS[id], default: id === DEFAULT_DEPTH };
      }),
      market: { country: MARKET.country, name: MARKET.name, currency: MARKET.currency },
      refusal_fallback: cfg.fallback ? "default" : "off",
      endpoints: ["GET /", "GET /health", "POST /research", "GET /searches", "GET /searches/{record_id}", "PATCH /searches/{record_id}", "POST /searches",
        "GET /searches/setup", "POST /searches/setup"],
      features: ["web-search", "checked-prices", "suppliers", "ndjson-progress", "images", ...(saving() ? ["saved-searches"] : []), ...(db && cfg.lark.required ? ["costings"] : [])],
      costings: db && cfg.lark.required ? { available: true } : { available: false, reason: db ? "needs the Lark login check on" : "only on the Cloudflare copy" },
      searches: saving() ? { available: true } : { available: false, reason: cfg.lark.required ? "no saved searches table is set" : "needs the Lark login check on" },
      cors: { origins: openCors ? "*" : [...cfg.origins].sort(), allow_headers: [...ALLOW_HEADERS] },
      login: { provider: "lark", required: cfg.lark.required },
      limits: { max_run_usd: cfg.maxRunUsd, rate_limit_per_hour: cfg.rateLimitPerHour, read_rate_limit_per_hour: cfg.readRateLimitPerHour,
        max_concurrent: cfg.maxConcurrent, run_timeout_s: Math.round(cfg.runTimeoutMs / 1000), max_body_bytes: MAX_BODY, ...LIMITS },
    };
  }

  /** Origin and login, for every POST and /searches route. Resolves { user, token }. */
  async function who(request) {
    const origin = (request.headers.get("Origin") || "").replace(/\/+$/, "");
    if (origin && !openCors && !cfg.origins.has(origin)) throw new ApiError(403, "forbidden_origin", "This page isn't allowed to use the price research service.");
    let user = null;
    try {
      user = await auth.verify(request.headers.get("Authorization"), httpGetWith(upstream));
    } catch (e) {
      if (e instanceof AuthError) throw new ApiError(e.status, e.code, e.message);
      throw e;
    }
    return { user, token: cfg.lark.required ? bearer(request.headers.get("Authorization")) : "" };
  }

  /** The JSON body, at most `max` bytes. */
  async function body(request, max) {
    const ctype = (request.headers.get("Content-Type") || "").toLowerCase();
    if (!ctype.startsWith("application/json")) throw new ApiError(415, "bad_request", "Send the request as JSON.");
    const length = Number(request.headers.get("Content-Length") || "");
    if (length > max) throw new ApiError(413, "too_large", "The request is too long. Shorten the details and try again.");
    try {
      const text = await request.text();
      if (text.length > max) throw new ApiError(413, "too_large", "The request is too long. Shorten the details and try again.");
      return JSON.parse(text);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(400, "bad_request", "The request couldn't be read.");
    }
  }

  const keyOf = (user, ip) => (user && user.open_id ? `user:${user.open_id}` : `ip:${ip}`);

  /** Every check that can refuse a run, before anything streams. Resolves { input, user, token }. */
  async function admit(request, ip) {
    const { user, token } = await who(request);
    const raw = await body(request, MAX_BODY);
    let input;
    try { input = readInput(raw, { models: cfg.models, defaultModel: cfg.defaultModel }); } catch (e) {
      if (e instanceof InputError) throw new ApiError(400, "bad_input", e.message);
      throw e;
    }
    const wait = limiter.check(keyOf(user, ip));
    if (wait) throw new ApiError(429, "rate_limited", `You've run a lot of searches in the last hour. Try again in ${Math.ceil(wait / 60)} min.`, { "Retry-After": String(wait) });
    if (!slots.take()) throw new ApiError(503, "busy", "The service is busy with other searches. Try again in a minute.", { "Retry-After": "30" });
    return { input, user, token };
  }

  /** The checks for the /searches routes. Resolves { user, token }. */
  async function admitSearches(request, ip) {
    if (!saving()) throw new ApiError(503, "searches_unavailable", cfg.lark.required ? "No saved searches table is set on this service." : "Saved searches need the Lark login, which is off on this service.");
    const { user, token } = await who(request);
    if (!token) throw new ApiError(401, "login_required", "Log in with Lark to see the saved searches.");
    const wait = readLimiter.check(keyOf(user, ip));
    if (wait) throw new ApiError(429, "rate_limited", `Too many requests in the last hour. Try again in ${Math.ceil(wait / 60)} min.`, { "Retry-After": String(wait) });
    return { user, token };
  }

  /** Stream one run: start, progress, the report, then whether it was saved. Frees the slot at the end. */
  function stream(input, user, { origin, signal, waitUntil, token = "" }) {
    const id = newId();
    const started = Date.now();
    const cancel = new AbortController();
    const out = createWriter({ onGone: () => cancel.abort() });
    const signals = [cancel.signal, signal].filter(Boolean);
    const runSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const who = user && user.open_id ? ` user=${user.open_id.slice(0, 12)}` : "";
    const lim = caps(input);
    const searchId = input.search_id || newSearchId();

    const pump = (async () => {
      const ping = setInterval(() => { out.line({ type: "ping" }); }, PING_MS);
      let report = null;
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
          return markRentals(all, input);
        };
        await out.line({ type: "start", id, search_id: searchId, model: input.model, depth: input.depth, caps: { searches: lim.searches, fetches: lim.fetches },
          estimate_ms: ESTIMATE_MS[input.depth], max_run_usd: cfg.maxRunUsd });
        const known = await past().catch(() => null);   // before the research: it's Claude's reference
        const client = new Client(cfg.apiKey, { fetch: upstream, betas: cfg.fallback && MODELS[input.model].fallback ? [FALLBACK_BETA] : [] });
        const { report: raw, run } = await runResearch({ client, input, system: prompt, today: today(cfg.tzOffsetHours), cfg,
          signal: runSignal, emit: (obj) => { out.line(obj); }, log, reference: known ? referenceText(known, input) : "",
          onResponse: record ? ({ n, body: b, msg }) => record(`${id}-${n}`, { input, body: b, response: msg }) : null });
        await out.line({ type: "activity", kind: "checking" });
        const ev = collectEvidence(run.blocks);
        const full = buildReport({ input: { ...input, search_id: searchId }, raw, ev, run, id, createdAt: new Date().toISOString(), service, startedAt: started, costings: known });
        // Claude has said what this is (item or service) and its unit: mark the past prices again with that.
        if (full.costings) markRentals(full.costings, { ...input, kind: full.kind, unit: full.unit });
        if (images) {
          await out.line({ type: "activity", kind: "images" });
          const photos = await findImages(full.listings, { fetch: upstream, signal: runSignal, log });
          for (const l of full.listings) l.image = photos.get(l.url) || "";
        }
        full.price = priceOf(full);
        full.meta.duration_ms = Date.now() - started;
        report = slimReport(full);
        await out.line({ type: "report", report });
        const checked = report.listings.filter((l) => l.verification.status === "checked").length;
        const m = report.meta;
        log(`research 200${who} id=${id} model=${m.models_used.join("+")} depth=${input.depth} ms=${m.duration_ms} requests=${m.requests} ` +
          `searches=${m.usage.web_search_requests} fetches=${m.usage.web_fetch_requests} listings=${report.listings.length} checked=${checked} ` +
          `photos=${report.listings.filter((l) => l.image).length} suppliers=${report.suppliers.length} ended=${m.ended} in=${m.usage.input_tokens} ` +
          `out=${m.usage.output_tokens} cache_read=${m.usage.cache_read_input_tokens} usd=${m.cost_usd.total}`);
      } catch (e) {
        const err = e instanceof RunError ? { code: e.code, message: e.message }
          : e instanceof ClaudeError ? describeClaudeError(e)
          : { code: "internal", message: "Something went wrong on the server. Try again." };
        if (e instanceof ClaudeError) log(`claude error kind=${e.kind} status=${e.status}: ${String(e.message).slice(0, 300)}`);
        else if (!(e instanceof RunError)) log(`research internal ${(e && e.name) || "Error"}: ${(e && e.stack) || e}`);
        log(`research ${err.code}${who} id=${id} model=${input.model} depth=${input.depth} ms=${Date.now() - started}`);
        await out.line({ type: "error", error: err });
      }
      // Saved no matter what: the save runs on its own clock, so it finishes even if the page has
      // gone (on Workers, waitUntil keeps it alive).
      try {
        if (report) {
          let saved = null, error = null;
          if (!token || !saving()) error = { code: "not_saved", message: "Not saved: saved searches need the Lark login." };
          else {
            try {
              saved = await searches.save(token, report, { user });
              log(`saved${who} id=${id} record=${saved.record_id} search=${report.search_id}`);
            } catch (e) {
              error = e instanceof SearchError ? { code: e.code, message: e.message } : { code: "internal", message: "It couldn't be saved. Try Save again." };
              log(`save failed${who} id=${id}: ${e instanceof SearchError ? e.code : (e && e.stack) || e}`);
            }
          }
          await out.line({ type: "saved", saved, error });
        }
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
    const path = url.pathname.replace(/\/+$/, "") || "/";
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
    const failed = (what, e) => {
      if (e instanceof ApiError || e instanceof SearchError) { log(`${what} ${e.status} ${e.code}`); return error(e); }
      log(`${what} 500 internal ${(e && e.name) || "Error"}: ${(e && e.message) || e}`);
      return error(new ApiError(500, "internal", "Something went wrong on the server. Try again."));
    };

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
      try { admitted = await admit(request, ip); } catch (e) { return failed("research", e); }
      return stream(admitted.input, admitted.user, { origin, signal, waitUntil, token: admitted.token });
    }

    // ---- saved searches -------------------------------------------------------------------
    if (path === "/searches" && method === "GET") {
      try {
        const { token } = await admitSearches(request, ip);
        const list = await searches.list(token);
        return json(200, { searches: list, count: list.length });
      } catch (e) { return failed("searches", e); }
    }
    if (path === "/searches" && method === "POST") {
      try {
        const { user, token } = await admitSearches(request, ip);
        const b = await body(request, MAX_SAVE_BODY);
        const r = b && b.report;
        if (!isReport(r)) throw new ApiError(400, "bad_input", "That isn't a search report this service made.");
        const report = slimReport({ ...r, search_id: /^ps[a-z0-9]{6,30}$/.test(String(r.search_id || "")) ? r.search_id : newSearchId() });
        report.price = priceOf(report, report.price && Array.isArray(report.price.included) ? report.price.included : undefined);
        const saved = await searches.save(token, report, { user });
        log(`saved again record=${saved.record_id} search=${report.search_id}`);
        return json(201, { search: saved });
      } catch (e) { return failed("save", e); }
    }
    if (path === "/searches/setup" && (method === "GET" || method === "POST")) {
      try {
        const { token } = await admitSearches(request, ip);
        return json(200, { table: method === "GET" ? await searches.status(token) : await searches.setup(token) });
      } catch (e) { return failed("setup", e); }
    }
    const m = path.match(/^\/searches\/([^/]+)$/);
    if (m && (method === "GET" || method === "PATCH")) {
      try {
        if (!RECORD_ID.test(m[1])) throw new ApiError(404, "not_found", "That saved search isn't in the table.");
        const { token } = await admitSearches(request, ip);
        if (method === "GET") return json(200, { search: await searches.get(token, m[1]) });
        const b = await body(request, MAX_BODY);
        const included = Array.isArray(b && b.included) ? b.included.filter((x) => typeof x === "string" && /^l\d{1,3}$/.test(x)).slice(0, 100) : null;
        if (!included) throw new ApiError(400, "bad_input", "Say which listings count (included).");
        return json(200, { search: await searches.update(token, m[1], { included }) });
      } catch (e) { return failed("search", e); }
    }

    if (!["GET", "POST", "PATCH"].includes(method)) return json(405, { error: { code: "method_not_allowed", message: "Use GET, POST or PATCH." } });
    return json(404, { error: { code: "not_found", message: "Not found." } });
  };
}
