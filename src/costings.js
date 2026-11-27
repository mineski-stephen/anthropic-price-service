/*
 * Past costings: what Mineski budgeted (and, where purchase orders matched, actually paid) for the
 * same thing before. Free, and the best guide for a client quotation, especially for services.
 *
 * The data is anthropic-ce's CE line items (one row per distinct CE line per workbook), in the
 * Cloudflare D1 database "ce-data", bound here as DB too (wrangler.toml). It holds internal costs,
 * markups and client names, so it's only read when the Lark login check is on (the procurement
 * table's readers, the same people who see Suppliers' Line Items tab). Node has no D1: there past
 * costings are simply "not available".
 *
 *   findCostings(db, input)      -> { available, reason, terms, lines: [...] }
 *   referenceText(costings, input) Mineski's own prices, in a few lines for Claude's request
 *
 * Search: the item's words (3+ letters, a trailing "s" dropped, everyday words like "rental" left
 * out) must all appear in the CE line's item name, description or remarks. Lines that were
 * inactive, waived, free or contingency are skipped. Newest first, final versions first.
 *
 * Rentals: a line that says rent / rental / hire / lease, or a CE line costed per day (or hour,
 * week, month), is a rental. For an item, a rental price isn't a purchase price (and the other way
 * round when the request is itself a rental), so such lines get `mismatch` ("rental" or "purchase")
 * and don't count toward the price or Claude's comparison; they're still listed.
 */

export const MAX_LINES = 40;
const STOP = new Set(["the", "and", "for", "with", "per", "pcs", "pc", "piece", "pieces", "set", "sets", "new", "rental", "rent", "rentals",
  "service", "services", "unit", "units", "day", "days", "hour", "hours", "event", "events", "package", "inch"]);

export const RENTAL = /\b(rent|rents|rental|rentals|rented|renting|hire|hired|for hire|lease|leased|leasing)\b/i;
const PER_TIME = /\b(hour|hr|day|night|week|month)s?\b/i;
// A hire period in the item: "(3 days)", "for 2 days", "(NOVEMBER 4-6, 2026)", "Nov. 12 to 23".
const PERIOD = /\b\d+\s*days?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{1,2}\s*(-|–|to)\s*\d{1,2}\b/i;
/** Does this text describe a rental (the words, or a hire period)? */
export const isRental = (text) => RENTAL.test(String(text || "")) || PERIOD.test(String(text || ""));
/** Is the request itself for a rental (the name or details say so, or it's priced per day…)? */
export const wantsRental = (input = {}) => isRental(`${input.name || ""} ${input.details || ""}`) || PER_TIME.test(String(input.unit || ""));
/** "rental" when the line is a rental but the request is to buy, "purchase" the other way, else "".
 *  Only for items: a service's day rate isn't a rental. */
export function mismatch(rental, input = {}) {
  if (input.kind === "service") return "";
  const want = wantsRental(input);
  return rental && !want ? "rental" : !rental && want ? "purchase" : "";
}
/** Mark each CE line and purchase request with `mismatch` for this request (in place; returns it). */
export function markRentals(costings, input) {
  if (!costings) return costings;
  for (const l of costings.lines || []) l.mismatch = mismatch(l.rental, input);
  for (const p of costings.pos || []) p.mismatch = mismatch(p.rental, input);
  return costings;
}

const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const str = (v, max) => String(v === undefined || v === null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const round2 = (v) => Math.round(v * 100) / 100;

/** The words to search for: up to five, longest first. */
export function searchTerms(name) {
  const words = String(name || "").toLowerCase().normalize("NFKC").split(/[^a-z0-9]+/).filter(Boolean)
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 5);
}

/** Units, compared loosely: "pcs" = "piece", "days" = "day", "sqm/day" = "sqm per day". */
export function sameUnit(a, b) {
  const n = (u) => {
    const s = String(u || "").toLowerCase().replace(/\s*\/\s*/g, " per ").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim().replace(/^per /, "")
      .split(" ").map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)).join(" ");
    return { pc: "piece", pcs: "piece", piece: "piece", unit: "piece", ea: "piece", each: "piece", lot: "lot", "": "" }[s] ?? s;
  };
  return n(a) === n(b);
}

/** Search the CE lines. Never throws: a missing database or a failed query is "not available". */
export async function findCostings(db, input, { loginRequired = true } = {}) {
  const terms = searchTerms(input.name);
  if (!db) return { available: false, reason: "Past costings are only on the Cloudflare copy of the service.", terms, lines: [] };
  if (!loginRequired) return { available: false, reason: "Past costings need the Lark login check on (they hold internal costs).", terms, lines: [] };
  if (!terms.length) return { available: true, reason: "", terms, lines: [] };
  const where = terms.map((_, i) => `(lower(coalesce(item,'')) LIKE ?${i + 1} OR lower(coalesce(particular,'')) LIKE ?${i + 1} OR lower(coalesce(remarks,'')) LIKE ?${i + 1})`).join(" AND ");
  const sql = "SELECT project_code, project_name, client, outcome, item, particular, remarks, qty, frq, per, unit_price_php, markup, " +
    "client_price_php, price_date, in_final, actual_php, po_count, category, is_package, source_tab " +
    `FROM lines WHERE ${where} AND coalesce(inactive,0)=0 AND coalesce(waived,0)=0 AND coalesce(free,0)=0 AND coalesce(contingency,0)=0 ` +
    `AND unit_price_php > 0 ORDER BY coalesce(price_date,'') DESC, in_final DESC LIMIT ${MAX_LINES}`;
  try {
    const res = await db.prepare(sql).bind(...terms.map((t) => `%${t}%`)).all();
    return { available: true, reason: "", terms, lines: (res.results || []).map(cleanLine) };
  } catch (e) {
    return { available: false, reason: "Past costings couldn't be read just now.", terms, lines: [], error: String((e && e.message) || e).slice(0, 200) };
  }
}

/** One CE line, tidied, with per-unit figures worked out. */
export function cleanLine(r = {}) {
  const qty = num(r.qty) || 0, frq = num(r.frq) || 0;
  const units = qty > 0 ? qty * (frq > 0 ? frq : 1) : 0;
  const cost = num(r.unit_price_php);
  const client = num(r.client_price_php);
  const actual = num(r.actual_php);
  return {
    project_code: str(r.project_code, 40),
    project_name: str(r.project_name, 120),
    client: str(r.client, 80),
    outcome: str(r.outcome, 30),
    item: str(r.item, 120),
    particular: str(r.particular, 200),
    remarks: str(r.remarks, 200),
    qty, frq,
    per: str(r.per, 40),
    unit_cost: cost !== null ? round2(cost) : null,
    markup: num(r.markup),
    client_unit: client !== null && units > 0 ? round2(client / units) : null,
    actual_unit: actual !== null && actual > 0 && units > 0 ? round2(actual / units) : null,
    po_count: num(r.po_count) || 0,
    date: str(r.price_date, 10),
    final: Number(r.in_final) === 1,
    category: str(r.category, 60),
    package: Number(r.is_package) === 1,
    rental: isRental(`${r.item || ""} ${r.particular || ""} ${r.remarks || ""}`) || PER_TIME.test(String(r.per || "")),
  };
}

/** The unit most past CE lines are costed in (lines that aren't the other side of a rental), or "". */
export function usualUnit(lines = []) {
  const counts = new Map();
  for (const l of lines) {
    if (l.mismatch || !(l.unit_cost > 0) || !l.per) continue;
    const key = String(l.per).toLowerCase().replace(/^per\s+/, "").trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = "", n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return best;
}

const fmt = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const month = (d) => { const t = Date.parse(String(d || "").length === 7 ? `${d}-01` : d); return Number.isFinite(t) ? new Date(t).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : ""; };

/** CE budgets are compared with the market only when there are at least BUDGET_MIN lines and the
 *  middle half agrees (the upper quartile at most BUDGET_SPREAD times the lower): a couple of lines,
 *  or lines for different kinds of the thing, give a meaningless middle. */
export const BUDGET_MIN = 3, BUDGET_SPREAD = 2;
export function budgetAgrees(lines) {
  const costs = lines.map((l) => l.unit_cost).filter((v) => v > 0).sort((a, b) => a - b);
  if (costs.length < BUDGET_MIN) return false;
  const q = (p) => { const i = (costs.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return costs[lo] + (costs[hi] - costs[lo]) * (i - lo); };
  return q(0.75) <= q(0.25) * BUDGET_SPREAD;
}

/**
 * Mineski's own prices, in a few lines for Claude's request: what was paid (approved purchase
 * requests, with the supplier) and what was budgeted (CE lines). Client names are left out. ""
 * when there's nothing to say.
 */
export function referenceText(costings, input) {
  const all = (costings && costings.pos) || [];
  const miss = (x) => x.mismatch ?? mismatch(x.rental, input);
  const pos = all.filter((p) => !miss(p));
  const others = all.filter((p) => miss(p));
  // The request names no unit unless it says "per day" and the like: then the CE lines' usual one.
  const unit = input.unit || usualUnit(((costings && costings.lines) || []).filter((l) => !miss(l))) || "piece";
  const lines = ((costings && costings.lines) || []).filter((l) => l.unit_cost > 0 && !miss(l) && sameUnit(l.per, unit));
  const otherLines = ((costings && costings.lines) || []).filter((l) => miss(l)).length;
  if (!all.length && !lines.length && !otherLines) return "";
  const out = ["Mineski's own records for this, as reference (internal figures: never report them as listings, and don't quote the amounts in the report):"];
  for (const p of pos.slice(0, 6)) {
    out.push(`- Paid ${p.currency} ${fmt(p.unit_price)} per unit${p.quantity ? ` for ${p.quantity}` : ""} to ${p.supplier || "a supplier"}${p.date ? ` (${month(p.date)})` : ""}: ${p.item.slice(0, 80)}${p.lot ? ` (${p.lot})` : ""}`);
  }
  const rentWant = wantsRental(input);
  if (others.length || otherLines) {
    const n = others.length + otherLines;
    const who = [...new Set(others.map((p) => p.supplier).filter(Boolean))].slice(0, 3);
    out.push(rentWant
      ? `- ${n} past line${n === 1 ? " was a purchase" : "s were purchases"}, not rentals: not comparable with rental rates, so leave ${n === 1 ? "it" : "them"} out of any comparison.`
      : `- ${n} past line${n === 1 ? " was a rental" : "s were rentals"} (Mineski rented this${who.length ? `, from ${who.join(", ")}` : ""}): rental rates are not purchase prices, so leave ${n === 1 ? "it" : "them"} out of any comparison.`);
  }
  const budget = budgetAgrees(lines);
  if (lines.length) {
    const dates = lines.map((l) => l.date).filter(Boolean).sort();
    const costs = lines.map((l) => l.unit_cost).sort((x, y) => x - y);
    const when = dates.length ? ` (${month(dates[0])} to ${month(dates[dates.length - 1])})` : "";
    out.push(budget
      ? `- Budgeted on ${lines.length} past CE lines: middle PHP ${fmt(median(costs))} per ${unit}${when}.`
      : `- Budgeted on ${lines.length} past CE line${lines.length === 1 ? ` at PHP ${fmt(costs[0])}` : `s from PHP ${fmt(costs[0])} to PHP ${fmt(costs[costs.length - 1])}`} per ${unit}${when}: ${lines.length < BUDGET_MIN ? "too few" : "too far apart"} to compare with, so don't compare today's prices with these budgets.`);
  }
  const suppliers = [...new Set(pos.map((p) => p.supplier).filter(Boolean))].slice(0, 5);
  if (suppliers.length) out.push(`Mineski has bought this from: ${suppliers.join(", ")}. If they publish prices online, check them first.`);
  if (!pos.length && !budget) {
    out.push(`Mineski has no past ${rentWant ? "rental" : "purchase"} price for this that can be compared, so don't compare today's prices with these records; you may say in the summary that there's nothing comparable.`);
    return out.join("\n");
  }
  out.push("Each paid price is per unit as recorded on the request, which may cover several days of a rental or a lot; if a past price clearly isn't for the same thing or unit, say so instead of comparing.");
  out.push("In the summary, say in one sentence whether today's market prices are higher, lower or about the same as what Mineski paid or budgeted, and by roughly what percentage, without quoting the internal amounts. Put a big difference (over 30%) in warnings.");
  return out.join("\n");
}
