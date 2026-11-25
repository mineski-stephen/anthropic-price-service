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
 *   costingListings(lines, input) the lines as report listings (a "Past costings" check prices from them)
 *
 * Search: the item's words (3+ letters, a trailing "s" dropped, everyday words like "rental" left
 * out) must all appear in the CE line's item name, description or remarks. Lines that were
 * inactive, waived, free or contingency are skipped. Newest first, final versions first.
 */

export const MAX_LINES = 40;
const STOP = new Set(["the", "and", "for", "with", "per", "pcs", "pc", "piece", "pieces", "set", "sets", "new", "rental", "rent", "rentals",
  "service", "services", "unit", "units", "day", "days", "hour", "hours", "event", "events", "package", "inch"]);

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
    const s = String(u || "").toLowerCase().replace(/\s*\/\s*/g, " per ").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim()
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
  };
}

/**
 * The lines as report listings (report.js's listing shape), for a "Past costings" check. Lines in
 * another unit than the request can't be compared, unless none match (then all count, with a
 * warning from the caller).
 */
export function costingListings(lines, input) {
  const anySame = lines.some((l) => sameUnit(l.per, input.unit));
  return lines.map((l, i) => {
    const comparable = !anySame || sameUnit(l.per, input.unit);
    const facts = [l.project_code && l.project_name ? `${l.project_code} ${l.project_name}` : l.project_name || l.project_code, l.client,
      `${l.qty} × ${l.frq || 1} ${l.per || ""}`.trim(), l.markup !== null ? `markup ${Math.round(l.markup * 100)}%` : "",
      l.client_unit !== null ? `client price PHP ${l.client_unit.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "",
      l.actual_unit !== null ? `paid PHP ${l.actual_unit.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (PO)` : "",
      l.final ? "" : "not the final version", l.package ? "a package" : ""].filter(Boolean);
    return {
      id: `l${i + 1}`, url: "", host: "",
      title: l.particular || l.item || "CE line",
      seller: l.project_code || l.project_name || "Past CE",
      seller_type: "other",
      price_text: `PHP ${l.unit_cost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      price: l.unit_cost, regular_price: 0, currency: "PHP",
      units_in_price: comparable ? 1 : 0,
      price_basis: l.per ? `per ${l.per}` : "",
      vat: "not_stated", condition: "not_applicable", match: "close", availability: "unknown",
      page_date: l.date, notes: facts.join(" · "),
      unit_price: comparable ? l.unit_cost : null, comparable_price: comparable ? l.unit_cost : null,
      verification: { status: "checked", via: "costings", evidence: [] },
      costing: l,
    };
  });
}

/** The report (report.js's shape) for a "Past costings" check: listings are the CE lines. */
export function costingsReport({ input, costings, id, createdAt, service, startedAt }) {
  const ce = costingListings(costings.lines, input);
  const pos = costings.pos || [];
  const listings = [...poListings(pos, input), ...ce].map((l, i) => ({ ...l, id: `l${i + 1}` }));
  const warnings = [];
  if (!costings.lines.length && !pos.length) {
    warnings.push({ from: "service", text: costings.terms.length
      ? `No past CE line or approved purchase request mentions ${costings.terms.map((t) => `“${t}”`).join(" and ")}. Try fewer or more common words, or a web check.`
      : "Type a more specific name: the words searched for were all everyday words." });
  } else {
    const other = ce.filter((l) => l.comparable_price === null).length;
    if (other) warnings.push({ from: "service", text: `${other} CE line${other === 1 ? " is" : "s are"} costed per another unit than ${input.unit}, so ${other === 1 ? "it isn't" : "they aren't"} counted.` });
    if (listings.some((l) => l.verification.via === "po" && l.comparable_price === null)) warnings.push({ from: "service", text: "Purchase requests don't record a unit, so they only count for things priced per piece (or set, pack, lot…). The others are listed for reference." });
    if (!ce.some((l) => l.comparable_price === null) && costings.lines.some((l) => !sameUnit(l.per, input.unit))) {
      warnings.push({ from: "service", text: `None of these lines is costed per ${input.unit}; they're counted as they are. Check the units.` });
    }
    if (costings.lines.length >= MAX_LINES) warnings.push({ from: "service", text: `Only the newest ${MAX_LINES} matching lines are shown. Add a word to narrow it down.` });
    if (costings.pos_available === false && costings.pos_reason) warnings.push({ from: "service", text: `Purchase requests aren't included: ${costings.pos_reason}` });
    warnings.push({ from: "service", text: "These are Mineski's own figures: prices paid on approved purchase requests and budgeted unit costs from past CEs (internal: don't share them with clients). Untick lines that aren't the same thing." });
  }
  return {
    schema: 1, id, created_at: createdAt,
    request: { ...input, sites: { ...input.sites, list: [...input.sites.list] } },
    interpreted: input.name, category: "Other", unit: input.unit, currency: "PHP",
    summary: costings.lines.length || pos.length ? `${[pos.length ? `${pos.length} approved purchase request line${pos.length === 1 ? "" : "s"}` : "", costings.lines.length ? `${costings.lines.length} past CE line${costings.lines.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")} mention ${costings.terms.join(", ")}.` : "",
    assumptions: [], warnings, listings, suppliers: [],
    costings: null,
    sources: { queries: [{ query: `Past CEs: ${costings.terms.join(" + ")}`, results: costings.lines.length, error: null },
      { query: `Purchase requests: ${costings.terms.join(" + ")}`, results: pos.length, error: costings.pos_available === false ? costings.pos_reason || "not available" : null }], pages: [] },
    meta: {
      service: service.name, version: service.version, runtime: service.runtime, source: "costings",
      model: "", models_used: [], fallback: false, effort: "", depth: "costings",
      duration_ms: Date.now() - startedAt, requests: 0, continuations: 0, ended: "submitted",
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 },
      cost_usd: { tokens: 0, searches: 0, total: 0 }, priced: true,
    },
  };
}

// ---- purchase requests (pos.js) next to the CE lines ------------------------------------------
/** Units a purchase request's unit price can be compared in (POs record no unit). */
const PIECE_LIKE = new Set(["piece", "set", "pair", "pack", "box", "ream", "roll", "unit", "lot", "service", "event"]);
const fmt = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Purchase-request lines as report listings (verification.via "po"). */
export function poListings(pos, input, start = 0) {
  const comparableUnit = PIECE_LIKE.has(String(input.unit || "").toLowerCase().replace(/s$/, ""));
  return pos.map((p, i) => {
    const comparable = comparableUnit && p.currency === "PHP";
    return {
      id: `l${start + i + 1}`, url: "", host: "",
      title: p.item || "Purchase request",
      seller: p.supplier || "Supplier not recorded",
      seller_type: "other",
      price_text: `${p.currency} ${fmt(p.unit_price)}`,
      price: p.unit_price, regular_price: 0, currency: p.currency,
      units_in_price: comparable ? 1 : 0, price_basis: "per unit (the request doesn't record the unit)",
      vat: "not_stated", condition: "not_applicable", match: "close", availability: "unknown",
      page_date: p.date,
      notes: [p.request_no, p.project_code && p.project_name ? `${p.project_code} ${p.project_name}` : p.project_name || p.project_code,
        p.quantity ? `qty ${p.quantity}` : "", p.total ? `total ${p.currency} ${fmt(p.total)}` : ""].filter(Boolean).join(" · "),
      unit_price: comparable ? p.unit_price : null, comparable_price: comparable ? p.unit_price : null,
      verification: { status: "checked", via: "po", evidence: [] },
      po: p,
    };
  });
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const month = (d) => { const t = Date.parse(String(d || "").length === 7 ? `${d}-01` : d); return Number.isFinite(t) ? new Date(t).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : ""; };

/**
 * Mineski's own prices, in a few lines for Claude's request: what was paid (approved purchase
 * requests, with the supplier) and what was budgeted (CE lines). Client names are left out. ""
 * when there's nothing to say.
 */
export function referenceText(costings, input) {
  const pos = (costings && costings.pos) || [];
  const lines = ((costings && costings.lines) || []).filter((l) => l.unit_cost > 0 && sameUnit(l.per, input.unit));
  if (!pos.length && !lines.length) return "";
  const out = ["Mineski's own records for this, as reference (internal figures: never report them as listings, and don't quote the amounts in the report):"];
  for (const p of pos.slice(0, 6)) {
    out.push(`- Paid ${p.currency} ${fmt(p.unit_price)} per unit${p.quantity ? ` for ${p.quantity}` : ""} to ${p.supplier || "a supplier"}${p.date ? ` (${month(p.date)})` : ""}: ${p.item.slice(0, 80)}`);
  }
  if (lines.length) {
    const dates = lines.map((l) => l.date).filter(Boolean).sort();
    out.push(`- Budgeted on ${lines.length} past CE line${lines.length === 1 ? "" : "s"}: middle PHP ${fmt(median(lines.map((l) => l.unit_cost)))} per ${input.unit}${dates.length ? ` (${month(dates[0])} to ${month(dates[dates.length - 1])})` : ""}.`);
  }
  const suppliers = [...new Set(pos.map((p) => p.supplier).filter(Boolean))].slice(0, 5);
  if (suppliers.length) out.push(`Mineski has bought this from: ${suppliers.join(", ")}. If they publish prices online, check them first.`);
  out.push("In the summary, say in one sentence whether today's market prices are higher, lower or about the same as what Mineski paid or budgeted, and by roughly what percentage, without quoting the internal amounts. Put a big difference (over 30%) in warnings.");
  return out.join("\n");
}
