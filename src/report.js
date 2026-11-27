/*
 * The report the page receives (pure). Claude's submit_report input is tidied, every listing and
 * supplier is checked against the evidence (verify.js), and the service adds what only it knows:
 * the sources, the cost and how the run went.
 *
 * {
 *   schema: 1, id, created_at, request: { name, details, depth, model, search_id },
 *   search_id,           the saved search this is a version of (set when it's saved)
 *   interpreted, kind (item | service), category, unit, currency, summary, assumptions: [text],
 *   warnings: [{ from: "model" | "service", text }],
 *   listings: [{ id, url, host, title, seller, seller_type, price_text, price, regular_price, currency,
 *     units_in_price, price_basis, vat, condition, match, availability, page_date, notes,
 *     image,               the product photo the listing's page names (images.js), else ""
 *     unit_price,          price / units_in_price (null when it can't be converted)
 *     comparable_price,    unit_price with VAT added when the page says VAT is excluded (null when
 *                          not comparable: another currency, or no unit price)
 *     verification: { status: "checked" | "link" | "unverified", via, evidence: [{ url, excerpt }] } }],
 *   suppliers: [{ id, name, type, website, host, phone, email, city, offers, source_url,
 *     contact: { status: "checked" | "unconfirmed" | "none", via } }],
 *   sources: { queries: [{ query, results, error }],
 *              pages: [{ url, host, title, page_age, searched, fetched, retrieved_at, error }] },
 *   meta: { service, version, runtime, model, models_used, effort, depth, duration_ms, requests,
 *     continuations, ended, usage, cost_usd: { tokens, searches, total }, priced, fallback }
 * }
 */
import { CATEGORIES, SELLER_TYPES, SUPPLIER_TYPES, CURRENCIES, DEPTHS, MARKET } from "./request.js";
import { normUrl, hostOf } from "./evidence.js";
import { index, verifyListing, verifySupplier } from "./verify.js";

export const SCHEMA = 1;
export const MAX_LISTINGS = 30;
export const MAX_SUPPLIERS = 15;
export const MAX_PAGES = 80;

const str = (v, max) => String(v === undefined || v === null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const num = (v) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };
const pick = (v, allowed, def) => { const x = String(v || "").toLowerCase(); return allowed.find((a) => a.toLowerCase() === x) || def; };
const round2 = (v) => Math.round(v * 100) / 100;
/** http(s) addresses only (anything else, such as javascript:, becomes ""). */
export const webUrl = (u) => { const s = str(u, 2000); try { const x = new URL(s); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch (_) { return ""; } };

export function cleanListing(l = {}) {
  return {
    url: webUrl(l.url),
    title: str(l.title, 200),
    seller: str(l.seller, 120),
    seller_type: pick(l.seller_type, SELLER_TYPES, "other"),
    price_text: str(l.price_text, 60),
    price: num(l.price),
    regular_price: num(l.regular_price),
    currency: pick(l.currency, CURRENCIES, "OTHER"),
    units_in_price: num(l.units_in_price),
    price_basis: str(l.price_basis, 80),
    vat: pick(l.vat, ["included", "excluded", "not_stated"], "not_stated"),
    condition: pick(l.condition, ["new", "used", "refurbished", "not_applicable"], "new"),
    match: pick(l.match, ["exact", "close", "substitute"], "close"),
    availability: pick(l.availability, ["in_stock", "out_of_stock", "made_to_order", "unknown"], "unknown"),
    page_date: str(l.page_date, 10),
    notes: str(l.notes, 300),
  };
}

export function cleanSupplier(s = {}) {
  return {
    name: str(s.name, 120),
    type: pick(s.type, SUPPLIER_TYPES, "other"),
    website: webUrl(s.website),
    phone: str(s.phone, 60),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(s.email, 120)) ? str(s.email, 120) : "",
    city: str(s.city, 80),
    offers: str(s.offers, 200),
    source_url: webUrl(s.source_url),
  };
}

/** Build the report. raw: submit_report's input; ev: collectEvidence(); run: the run loop's result. */
/** A search result's page_age ("2026-11-01", "March 3, 2021", "3 years ago", "1910 days ago") as
 *  YYYY-MM-DD, or "". */
export function pageAgeDate(age, now = Date.now()) {
  const s = String(age || "").trim();
  if (!s) return "";
  const rel = s.match(/^(\d+)\s*(day|week|month|year)s?\s*ago$/i);
  if (rel) {
    const n = Number(rel[1]), unit = rel[2].toLowerCase();
    const days = unit === "day" ? n : unit === "week" ? n * 7 : unit === "month" ? n * 30.44 : n * 365.25;
    return new Date(now - days * 86400000).toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}(-\d{2})?/.test(s)) return s.slice(0, 10);
  const utc = Date.parse(`${s} UTC`);   // a written date ("March 3, 2021") is read as that day, not shifted by the time zone
  const t = Number.isFinite(utc) ? utc : Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

export function buildReport({ input, raw = {}, ev, run, id, createdAt, service, startedAt, costings = null }) {
  const market = MARKET;
  // When Claude leaves a listing undated, its search result's age stands in (so old prices show as old).
  const ageOf = new Map(ev.pages.filter((p) => p.page_age).map((p) => [normUrl(p.url), p.page_age]));
  const now = Date.parse(createdAt) || Date.now();
  const ix = index(ev);
  const seen = new Set();
  const listings = [];
  for (const l of Array.isArray(raw.listings) ? raw.listings : []) {
    const c = cleanListing(l);
    if (!c.title && !c.url) continue;
    if (!c.page_date && ageOf.has(normUrl(c.url))) c.page_date = pageAgeDate(ageOf.get(normUrl(c.url)), now);
    const dedupe = `${normUrl(c.url) || c.title.toLowerCase()}|${c.price}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const unit = c.units_in_price > 0 && c.price > 0 ? round2(c.price / c.units_in_price) : null;
    const sameCurrency = c.currency === market.currency;
    const comparable = unit !== null && sameCurrency ? round2(unit * (c.vat === "excluded" && market.vat ? 1 + market.vat : 1)) : null;
    listings.push({ id: `l${listings.length + 1}`, ...c, image: "", host: hostOf(c.url), unit_price: unit, comparable_price: comparable,
      verification: verifyListing(c, ix) });
    if (listings.length >= MAX_LISTINGS) break;
  }
  const suppliers = (Array.isArray(raw.suppliers) ? raw.suppliers : []).map(cleanSupplier).filter((s) => s.name).slice(0, MAX_SUPPLIERS)
    .map((s, i) => ({ id: `s${i + 1}`, ...s, host: hostOf(s.website || s.source_url), contact: verifySupplier(s, ix) }));

  const warnings = (Array.isArray(raw.warnings) ? raw.warnings : []).map((w) => str(w, 300)).filter(Boolean).slice(0, 12)
    .map((text) => ({ from: "model", text }));
  const unverified = listings.filter((l) => l.verification.status === "unverified").length;
  if (unverified) warnings.push({ from: "service", text: `${unverified} listing${unverified === 1 ? " links" : "s link"} to a page the research never saw, so ${unverified === 1 ? "it's" : "they're"} left out of the price.` });
  const unreadable = ev.pages.filter((p) => p.error).length;
  if (unreadable) warnings.push({ from: "service", text: `${unreadable} page${unreadable === 1 ? "" : "s"} couldn't be opened (usually marketplaces that block page readers).` });
  if (run.ended === "wrapped_up") warnings.push({ from: "service", text: "The research reached its limit and was asked to stop early, so it may have missed offers." });
  const failedSearches = ev.queries.filter((q) => q.error).length;
  if (failedSearches) warnings.push({ from: "service", text: `${failedSearches} search${failedSearches === 1 ? "" : "es"} failed.` });

  const usedModels = [...new Set(run.models)];
  return {
    schema: SCHEMA,
    id,
    created_at: createdAt,
    request: { name: input.name, details: input.details, depth: input.depth, model: input.model, search_id: input.search_id || "" },
    search_id: input.search_id || "",
    interpreted: str(raw.interpreted, 200) || input.name,
    kind: pick(raw.kind, ["item", "service"], input.kind || "item"),
    category: pick(raw.category, CATEGORIES, "Other"),
    unit: str(raw.unit, 60) || input.unit || "piece",
    currency: market.currency,
    summary: str(raw.summary, 800),
    assumptions: (Array.isArray(raw.assumptions) ? raw.assumptions : []).map((a) => str(a, 300)).filter(Boolean).slice(0, 10),
    warnings,
    listings,
    suppliers,
    costings,
    sources: {
      queries: ev.queries.slice(0, 40).map((q) => ({ query: str(q.query, 200), results: q.results, error: q.error })),
      pages: ev.pages.slice(0, MAX_PAGES).map((p) => ({ url: webUrl(p.url), host: p.host, title: str(p.title, 200), page_age: str(p.page_age, 40),
        searched: p.searched, fetched: p.fetched, retrieved_at: str(p.retrieved_at, 40), error: p.error })).filter((p) => p.url),
    },
    meta: {
      service: service.name, version: service.version, runtime: service.runtime, source: "web",
      model: input.model, models_used: usedModels, fallback: usedModels.some((m) => m && !m.startsWith(input.model)),
      effort: DEPTHS[input.depth].effort, depth: input.depth, duration_ms: Date.now() - startedAt,
      requests: run.requests, continuations: run.continuations, ended: run.ended,
      usage: { ...run.tally.usage }, cost_usd: { ...run.tally.cost }, priced: run.tally.priced,
    },
  };
}
