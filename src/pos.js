/*
 * Past purchase requests: what Mineski actually paid, and to whom. Read from the Lark Procurement
 * table (the one Suppliers reads, and the one the login check uses), as the signed-in person, so
 * Lark's own permissions decide what comes back. Only approved requests, and only the columns
 * below: never the supplier bank details that also live in that table.
 *
 *   findPOs({ fetch, token, baseToken, tableId, terms })  -> { available, reason, lines: [...] }
 *
 * Search: Lark's records/search with every term as "Particulars_Item contains <term>" and Status
 * "Approved", newest first, at most MAX_POS. If Lark refuses the filter (a column renamed, a
 * different field type), it's tried once with the item terms only and the status checked here.
 *
 * Requests record no unit, and the unit price is sometimes the whole line ("30 PCS ... " at the
 * lot's price, quantity 1). lotUnit() spots that and divides; such lines carry a `lot` note.
 */
import { LARK_API } from "./lark-auth.js";
import { isRental, RENTAL } from "./costings.js";

export const MAX_POS = 30;
export const PO_FIELDS = ["Request No.", "Status", "Project Code", "Project Name", "Particulars_Item", "Particulars_Quantity",
  "Particulars_Unit Price", "Particulars_Unit Price-Currency", "Particulars_Price", "Supplier Details_Supplier Name", "Submitted at", "Completed at"];
const TIMEOUT_MS = 10000;

const str = (v, max) => String(v === undefined || v === null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const round2 = (v) => Math.round(v * 100) / 100;

/** A Lark cell as plain text: strings, numbers, rich-text runs, links, people, options, lookups. */
export function cellText(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(cellText).filter(Boolean).join(" ");
  if (typeof v === "object") {
    if (v.text !== undefined) return cellText(v.text);
    if (v.value !== undefined) return cellText(v.value);
    if (v.name !== undefined) return cellText(v.name);
    if (v.link !== undefined) return cellText(v.link);
  }
  return "";
}

/** A Lark cell as a list of values (a lookup or a multi-line cell may hold one per particular). */
export function cellList(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return v.map(String);
  if (typeof v === "object" && !Array.isArray(v) && Array.isArray(v.value)) return cellList(v.value);
  const t = cellText(v);
  return t ? t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}

export const cellNumber = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = cellText(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/** A Lark date cell (milliseconds) as YYYY-MM-DD. */
const cellDate = (v) => {
  const n = typeof v === "number" ? v : cellNumber(v);
  return n && n > 1e11 ? new Date(n).toISOString().slice(0, 10) : str(cellText(v), 10);
};

const fmt = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "30 PCS ...", "x 25 pieces", "(100 units)": the count the item text gives, else 0. */
export function countInText(text) {
  const m = String(text || "").match(/\b(\d{1,5})\s*(?:pcs?|pieces?|units?|sets?|pax|nos?\.?)(?![a-z])/i);
  const n = m ? Number(m[1]) : 0;
  return n > 1 ? n : 0;
}
/**
 * The real unit price when the unit price given is the whole line's: { unit, quantity, lot } or null.
 *   - quantity 1 (or none) and the item says "30 PCS": the price is for 30;
 *   - quantity 30 and the unit price equals the line total: the price is the total.
 */
export function lotUnit({ item, price, qty, total, currency = "PHP" }) {
  if (!(price > 0)) return null;
  const n = countInText(item);
  if (n && (!qty || qty === 1)) return { unit: price / n, quantity: n, lot: `${currency} ${fmt(price)} for ${n}, divided` };
  if (qty > 1 && total > 0 && Math.abs(price - total) <= total * 0.005) return { unit: total / qty, quantity: qty, lot: `${currency} ${fmt(price)} is the line total for ${qty}, divided` };
  return null;
}

/** One approved request as PO lines: one per particular that matches the terms. */
export function poLines(record, terms) {
  const f = (record && record.fields) || {};
  const items = cellList(f["Particulars_Item"]);
  const prices = cellList(f["Particulars_Unit Price"]).map(cellNumber);
  const qtys = cellList(f["Particulars_Quantity"]).map(cellNumber);
  const currencies = cellList(f["Particulars_Unit Price-Currency"]);
  const totals = cellList(f["Particulars_Price"]).map(cellNumber);
  const aligned = items.length > 1 && prices.length === items.length;
  const base = {
    request_no: str(cellText(f["Request No."]), 40),
    status: str(cellText(f["Status"]), 30),
    project_code: str(cellText(f["Project Code"]), 40),
    project_name: str(cellText(f["Project Name"]), 120),
    supplier: str(cellText(f["Supplier Details_Supplier Name"]), 120),
    date: cellDate(f["Completed at"]) || cellDate(f["Submitted at"]),
  };
  const out = [];
  const rows = aligned ? items.map((item, i) => ({ item, price: prices[i], qty: qtys[i], cur: currencies[i] || currencies[0], total: totals[i] }))
    : [{ item: items.join(" / "), price: prices[0] ?? null, qty: qtys[0] ?? null, cur: currencies[0], total: totals[0] ?? null }];
  for (const r of rows) {
    const text = r.item.toLowerCase();
    if (aligned && !terms.every((t) => text.includes(t))) continue;
    const currency = !r.cur || /php|₱|peso/i.test(r.cur) ? "PHP" : str(r.cur, 10).toUpperCase();
    let qty = r.qty && r.qty > 0 ? r.qty : null;
    let unit = r.price && r.price > 0 ? r.price : r.total && qty ? r.total / qty : null;
    if (!unit) continue;
    const lot = lotUnit({ item: r.item, price: r.price, qty, total: r.total, currency });
    const total = r.total ?? (lot ? r.price : qty ? round2(unit * qty) : null);
    if (lot) { unit = lot.unit; qty = lot.quantity; }
    out.push({ ...base, item: str(r.item, 200), quantity: qty, unit_price: round2(unit), currency, total, lot: lot ? lot.lot : "", rental: isRental(r.item) });
  }
  // One request is one hire: if the supplier is a rental company or any of its lines is a rental, all are.
  if (out.some((o) => o.rental) || RENTAL.test(base.supplier)) for (const o of out) o.rental = true;
  return out;
}

/** Search approved purchase requests for the terms. Never throws. */
export async function findPOs({ fetch: f = (...a) => globalThis.fetch(...a), token, baseToken, tableId, terms, signal = null, log = () => {} }) {
  if (!token) return { available: false, reason: "Past purchase requests need the Lark login.", lines: [] };
  if (!baseToken || !tableId) return { available: false, reason: "The Procurement table isn't set on this service.", lines: [] };
  if (!terms.length) return { available: true, reason: "", lines: [] };
  const url = `${LARK_API}/bitable/v1/apps/${encodeURIComponent(baseToken)}/tables/${encodeURIComponent(tableId)}/records/search?page_size=${MAX_POS * 2}`;
  const itemConditions = terms.map((t) => ({ field_name: "Particulars_Item", operator: "contains", value: [t] }));
  const attempts = [
    { field_names: PO_FIELDS, automatic_fields: false, sort: [{ field_name: "Submitted at", desc: true }],
      filter: { conjunction: "and", conditions: [{ field_name: "Status", operator: "is", value: ["Approved"] }, ...itemConditions] } },
    { field_names: PO_FIELDS, automatic_fields: false, filter: { conjunction: "and", conditions: itemConditions } },
  ];
  let lastProblem = "";
  for (const body of attempts) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const res = await f(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const j = await res.json().catch(() => null);
      if (!j || j.code !== 0) { lastProblem = `Lark code ${j ? j.code : res.status}: ${str(j && j.msg, 120)}`; continue; }
      const records = (j.data && Array.isArray(j.data.items) ? j.data.items : [])
        .filter((r) => /^approved$/i.test(cellText(r.fields && r.fields["Status"]).trim()));
      const lines = records.flatMap((r) => poLines(r, terms))
        .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, MAX_POS);
      return { available: true, reason: "", lines };
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastProblem = String((e && e.message) || e).slice(0, 160);
    }
  }
  log(`pos search failed: ${lastProblem}`);
  return { available: false, reason: "Past purchase requests couldn't be read just now.", lines: [] };
}
