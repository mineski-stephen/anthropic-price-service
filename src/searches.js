/*
 * Saved searches: every finished search is kept in a Lark Base table that everyone it's shared
 * with can open (default: the procurement Base's "Price searches" table, tblYUSBGnqwDp0PN). One
 * record per run; the runs of the same search share a Search ID, and their dates are its versions.
 * Everything is read and written as the signed-in person (their Lark token), so Lark's own sharing
 * decides who can see the list and who can add to it.
 *
 * Columns (by name; their types are read from the table, so a price column may be Number or
 * Currency, and Confidence or Depth Text or Single option):
 *   Item, Details             what was asked (text; Item is the table's first column)
 *   Typical price, Low price, High price   the price the page shows (number, pesos)
 *   Unit, Confidence, Depth, Summary       (text or single option)
 *   Search ID                 the search this run is a version of (text)
 *   Report                    the whole report as JSON (text; a Lark text cell holds 100,000 characters)
 *   Cost (USD)                what the run cost (number)
 *   Searched by, Searched on  Lark's own Created by and Created time (optional: the API's automatic
 *                             fields carry the same)
 * Item, Search ID and Report must be there; the others are filled when they are.
 *
 *   createSearches({ fetch, baseToken, tableId })
 *     .save(token, report)              -> the new record, light (no report)
 *     .list(token)                      -> every record, light, newest first
 *     .get(token, recordId)             -> one record with its report
 *     .update(token, recordId, { included })  -> the record with the price worked out again
 */
import { LARK_API } from "./lark-auth.js";
import { priceOf } from "./stats.js";

export const COLUMNS = {
  item: "Item", details: "Details", typical: "Typical price", low: "Low price", high: "High price", unit: "Unit",
  confidence: "Confidence", depth: "Depth", summary: "Summary", searchId: "Search ID", report: "Report", cost: "Cost (USD)",
};
const REQUIRED = ["item", "searchId", "report"];
const LIGHT = ["item", "details", "typical", "low", "high", "unit", "confidence", "depth", "searchId", "cost"];
export const MAX_REPORT_CHARS = 95000;
export const MAX_LIST = 2000;
const PAGE = 500;
const FIELDS_TTL_MS = 600000;
const TIMEOUT_MS = 15000;

export const CONFIDENCE = { high: "High", medium: "Medium", low: "Low", none: "No price" };
export const DEPTH_LABELS = { quick: "Quick", standard: "Standard", thorough: "Thorough" };

const options = (labels) => ({ options: Object.values(labels).map((name) => ({ name })) });
const peso = (name) => ({ field_name: name, type: 2, ui_type: "Currency", property: { formatter: "0.00", currency_code: "PHP" },
  fallback: { field_name: name, type: 2, property: { formatter: "0.00" } } });
/** The columns setup() adds when they're missing, in the order they should appear, as Lark's field
 *  API takes them (`fallback`: the plainer column to add if Lark refuses the first). */
export const SETUP = [
  { field_name: "Item", type: 1 },
  peso("Typical price"), peso("Low price"), peso("High price"),
  { field_name: "Unit", type: 1 },
  { field_name: "Confidence", type: 3, property: options(CONFIDENCE) },
  { field_name: "Details", type: 1 },
  { field_name: "Summary", type: 1 },
  { field_name: "Depth", type: 3, property: options(DEPTH_LABELS) },
  { field_name: "Searched by", type: 1003 },
  { field_name: "Searched on", type: 1001, property: { date_formatter: "yyyy/MM/dd HH:mm" } },
  { field_name: "Cost (USD)", type: 2, property: { formatter: "0.0000" }, fallback: { field_name: "Cost (USD)", type: 2 } },
  { field_name: "Search ID", type: 1 },
  { field_name: "Report", type: 1 },
];
const keyOf = (labels, v) => Object.keys(labels).find((k) => labels[k].toLowerCase() === String(v || "").trim().toLowerCase()) || "";

// Lark field types: 1 text, 2 number, 3 single option, 99003 currency (numbers), 99002 progress, 99004 rating.
const NUMBER = new Set([2, 99002, 99003, 99004]);
const TEXTISH = new Set([1, 3]);
const DEAD_TOKEN = new Set([20005, 99991661, 99991663, 99991668, 99991677, 99991671]);
const NO_ACCESS = new Set([91402, 91403, 1254302, 1254003, 1254004, 1254040, 1254041, 99991672, 99991679]);

export class SearchError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

/** A new search's id: every version of it shares this. */
export const newSearchId = (now = Date.now()) => `ps${now.toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;

/** A Lark text cell as one string: its pieces joined as they are (a web address inside the text
 *  comes back as a piece of its own, and must not gain spaces). */
export function cellString(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? String(x.text ?? x.link ?? x.name ?? "") : "")).join("");
  if (typeof v === "object") return String(v.text ?? v.value ?? v.name ?? "");
  return "";
}
const cellNum = (v) => {
  const x = typeof v === "number" ? v : Number(cellString(v).replace(/,/g, ""));
  return cellString(v).trim() !== "" && Number.isFinite(x) ? x : null;
};

/** The report as it's sent to the page and kept: no evidence excerpts (page text stays on the
 *  server), and no copies of the past-costings rows inside listings. */
export function slimReport(report) {
  const r = { ...report };
  r.listings = (report.listings || []).map(({ verification, costing, po, ...l }) => ({ ...l,
    verification: { status: (verification && verification.status) || "link", via: (verification && verification.via) || "" } }));
  r.suppliers = (report.suppliers || []).map(({ contact, ...s }) => ({ ...s,
    contact: { status: (contact && contact.status) || "none", via: (contact && contact.via) || "" } }));
  return r;
}

/** The report as JSON that fits one Lark text cell, trimming what matters least first. */
export function packReport(report, max = MAX_REPORT_CHARS) {
  const r = slimReport(report);
  let text = JSON.stringify(r);
  const steps = [
    (x) => { x.sources = { ...x.sources, pages: ((x.sources && x.sources.pages) || []).slice(0, 30).map((p) => ({ ...p, title: String(p.title || "").slice(0, 80) })) }; },
    (x) => { if (x.costings) x.costings = { ...x.costings, lines: (x.costings.lines || []).slice(0, 12), pos: (x.costings.pos || []).slice(0, 10) }; },
    (x) => { x.sources = { queries: ((x.sources && x.sources.queries) || []).slice(0, 20), pages: [] }; },
    (x) => {
      x.listings = x.listings.map((l) => ({ ...l, notes: String(l.notes || "").slice(0, 80), title: String(l.title || "").slice(0, 120) }));
      x.suppliers = x.suppliers.map((s) => ({ ...s, offers: String(s.offers || "").slice(0, 80) }));
    },
  ];
  for (const step of steps) {
    if (text.length <= max) break;
    step(r);
    r.trimmed = true;
    text = JSON.stringify(r);
  }
  if (text.length > max) throw new SearchError(413, "too_large", "This search's report is too large to save.");
  return text;
}

/** A value as the column's type wants it; undefined when the column can't take it. */
function coerce(value, type) {
  if (NUMBER.has(type)) return typeof value === "number" && Number.isFinite(value) ? value : null;
  if (type === 3) return value ? String(value) : null;
  if (type === 1) return value === null || value === undefined ? "" : String(value);
  return undefined;
}

/** The record's cells for a report and its price, for the columns the table has. */
export function recordFields(report, types) {
  const p = report.price || priceOf(report);
  const want = {
    item: report.request.name, details: report.request.details || "", typical: p.typical, low: p.low, high: p.high, unit: report.unit || "",
    confidence: CONFIDENCE[p.confidence] || "", depth: DEPTH_LABELS[report.request.depth] || report.request.depth || "",
    summary: String(report.summary || "").slice(0, 2000), searchId: report.search_id, report: packReport(report),
    cost: report.meta && report.meta.cost_usd ? Math.round(report.meta.cost_usd.total * 10000) / 10000 : null,
  };
  const out = {};
  for (const [key, value] of Object.entries(want)) {
    const name = COLUMNS[key];
    if (!types.has(name)) continue;
    const v = coerce(value, types.get(name));
    if (v !== undefined) out[name] = v;
  }
  return out;
}

const person = (p) => (p && (p.id || p.name) ? { id: String(p.id || ""), name: String(p.name || p.en_name || "") } : null);
const iso = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : "");

/** A record as the page lists it (no report). */
export function fromRecord(rec = {}) {
  const f = rec.fields || {};
  const get = (k) => f[COLUMNS[k]];
  return {
    record_id: String(rec.record_id || rec.id || ""),
    search_id: cellString(get("searchId")).trim(),
    item: cellString(get("item")).trim(),
    details: cellString(get("details")).trim(),
    typical: cellNum(get("typical")), low: cellNum(get("low")), high: cellNum(get("high")),
    unit: cellString(get("unit")).trim(),
    confidence: keyOf(CONFIDENCE, cellString(get("confidence"))),
    depth: keyOf(DEPTH_LABELS, cellString(get("depth"))),
    cost: cellNum(get("cost")),
    created_at: iso(rec.created_time),
    by: person(rec.created_by),
    updated_at: iso(rec.last_modified_time),
    updated_by: person(rec.last_modified_by),
  };
}

/** The report kept in a record, or null when it's missing or unreadable. */
export function reportOf(rec = {}) {
  const text = cellString((rec.fields || {})[COLUMNS.report]);
  if (!text) return null;
  try {
    const r = JSON.parse(text);
    return r && typeof r === "object" && Array.isArray(r.listings) && r.request ? r : null;
  } catch (_) { return null; }
}

/** Is this something the page may ask to save (a report this service made)? */
export function isReport(r) {
  return !!(r && typeof r === "object" && r.schema === 1 && typeof r.id === "string" && Array.isArray(r.listings) && Array.isArray(r.suppliers)
    && r.request && typeof r.request.name === "string" && r.request.name.trim().length >= 2 && r.meta && typeof r.meta === "object");
}

export function createSearches({ fetch: f = (...a) => globalThis.fetch(...a), baseToken, tableId, api = LARK_API, log = () => {} } = {}) {
  const base = `${api}/bitable/v1/apps/${encodeURIComponent(baseToken || "")}/tables/${encodeURIComponent(tableId || "")}`;
  let fields = null;   // { types: Map(name -> type), until }

  async function call(method, url, token, body) {
    let res, j = null;
    try {
      res = await f(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
      j = await res.json().catch(() => null);
    } catch (e) {
      throw new SearchError(503, "lark_unavailable", "Lark didn't answer. Try again in a minute.");
    }
    const code = j ? Number(j.code) : -1;
    if (j && code === 0) return j.data || {};
    const msg = String((j && j.msg) || `HTTP ${res.status}`).slice(0, 160);
    if (DEAD_TOKEN.has(code)) throw new SearchError(401, "login_expired", "Your Lark login has ended. Log in again.");
    if (NO_ACCESS.has(code)) throw new SearchError(403, "not_authorized", "Your Lark account can't open the saved searches table (or can't add to it). Ask the Base owner to share it with you.");
    if (code === 1254043 || code === 1254006) throw new SearchError(404, "not_found", "That saved search isn't in the table any more.");
    if (code === 1254045 || (code >= 1254060 && code <= 1254069)) { fields = null; throw new SearchError(502, "table_changed", `The saved searches table has changed (${msg}). Ask the admin to check its columns.`); }
    log(`searches lark ${method} code=${code} status=${res && res.status}: ${msg}`);
    throw new SearchError(502, "lark_error", `Lark refused that (code ${code}). Try again in a minute.`);
  }

  /** Every column of the table, as Lark lists them ({ field_id, field_name, type, is_primary }). */
  async function columns(token) {
    if (!baseToken || !tableId) throw new SearchError(503, "not_configured", "The saved searches table isn't set on this service.");
    const items = [];
    let pageToken = "";
    for (let i = 0; i < 5; i++) {
      const d = await call("GET", `${base}/fields?page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`, token);
      items.push(...(d.items || []));
      if (!d.has_more || !d.page_token) break;
      pageToken = d.page_token;
    }
    return items;
  }

  /** The table's columns: name -> type (cached for 10 minutes). Throws when a required one is missing. */
  async function types(token) {
    if (!fields || fields.until < Date.now()) {
      const map = new Map((await columns(token)).map((it) => [String(it.field_name), Number(it.type)]));
      fields = { types: map, until: Date.now() + FIELDS_TTL_MS };
    }
    const missing = REQUIRED.map((k) => COLUMNS[k]).filter((n) => !fields.types.has(n));
    if (missing.length) throw new SearchError(502, "table_changed", `The saved searches table has no ${missing.join(", ")} column. Ask the admin to add ${missing.length === 1 ? "it" : "them"}.`);
    const wrong = REQUIRED.map((k) => COLUMNS[k]).filter((n) => !TEXTISH.has(fields.types.get(n)));
    if (wrong.length) throw new SearchError(502, "table_changed", `The ${wrong.join(", ")} column must be text. Ask the admin to change it.`);
    return fields.types;
  }

  return {
    /** Which of the setup's columns the table has: { ready, missing: [names] }. */
    async status(token) {
      const have = new Set((await columns(token)).map((c) => String(c.field_name)));
      const missing = SETUP.map((c) => c.field_name).filter((n) => !have.has(n));
      return { ready: REQUIRED.every((k) => have.has(COLUMNS[k])) && !missing.length, missing };
    },

    /** Add the columns the table is missing (as the person, who must be able to edit the table's
     *  columns). When the table's first column is still empty in every record (a new Lark table
     *  comes with a few blank rows), it's renamed to "Item" instead of adding one. Nothing is ever
     *  removed or changed otherwise. -> { added, renamed, missing } */
    async setup(token) {
      const cols = await columns(token);
      const have = new Set(cols.map((c) => String(c.field_name)));
      const added = [];
      let renamed = "";
      const primary = cols.find((c) => c.is_primary);
      if (!have.has("Item") && primary && Number(primary.type) === 1) {
        const name = String(primary.field_name);
        const d = await call("POST", `${base}/records/search?page_size=100`, token, { field_names: [name] });
        const blank = (d.items || []).every((r) => !cellString((r.fields || {})[name]).trim());
        if (blank && !d.has_more) {
          await call("PUT", `${base}/fields/${encodeURIComponent(primary.field_id)}`, token, { field_name: "Item", type: 1 });
          renamed = String(primary.field_name);
          have.add("Item");
        }
      }
      for (const { fallback, ...field } of SETUP) {
        if (have.has(field.field_name)) continue;
        try {
          await call("POST", `${base}/fields`, token, field);
        } catch (e) {
          if (!fallback || !(e instanceof SearchError) || e.code !== "lark_error") throw e;
          await call("POST", `${base}/fields`, token, fallback);
        }
        added.push(field.field_name);
        have.add(field.field_name);
      }
      fields = null;
      log(`searches setup: added ${added.length}${renamed ? `, renamed "${renamed}" to Item` : ""}`);
      return { added, renamed, ...(await this.status(token)) };
    },

    async save(token, report, { user = null } = {}) {
      const t = await types(token);
      const cells = recordFields(report, t);
      const d = await call("POST", `${base}/records?user_id_type=open_id`, token, { fields: cells });
      const rec = d.record || {};
      return { ...fromRecord({ ...rec, fields: { ...(rec.fields || {}), ...cells }, created_time: Date.now(),
        created_by: user ? { id: user.open_id, name: user.name } : null }), record_id: String(rec.record_id || rec.id || "") };
    },

    async list(token, { max = MAX_LIST } = {}) {
      const t = await types(token);
      const names = LIGHT.map((k) => COLUMNS[k]).filter((n) => t.has(n));
      const out = [];
      let pageToken = "";
      while (out.length < max) {
        const d = await call("POST", `${base}/records/search?page_size=${PAGE}&user_id_type=open_id${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`, token,
          { field_names: names, automatic_fields: true });
        for (const it of d.items || []) out.push(fromRecord(it));
        if (!d.has_more || !d.page_token) break;
        pageToken = d.page_token;
      }
      return out.filter((r) => r.record_id && r.item).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, max);
    },

    async get(token, recordId) {
      await types(token);
      const d = await call("GET", `${base}/records/${encodeURIComponent(recordId)}?user_id_type=open_id&automatic_fields=true`, token);
      const rec = d.record || {};
      return { ...fromRecord(rec), record_id: String(rec.record_id || rec.id || recordId), report: reportOf(rec) };
    },

    async update(token, recordId, { included }) {
      const t = await types(token);
      const now = await this.get(token, recordId);
      if (!now.report) throw new SearchError(409, "no_report", "This saved search has no report to work the price out from.");
      const report = { ...now.report, price: priceOf(now.report, included) };
      const all = recordFields(report, t);
      const cells = Object.fromEntries(["typical", "low", "high", "confidence", "report"].map((k) => COLUMNS[k]).filter((n) => n in all).map((n) => [n, all[n]]));
      await call("PUT", `${base}/records/${encodeURIComponent(recordId)}?user_id_type=open_id`, token, { fields: cells });
      const p = report.price;
      return { ...now, typical: p.typical, low: p.low, high: p.high, confidence: p.confidence, updated_at: new Date().toISOString(), report };
    },
  };
}
