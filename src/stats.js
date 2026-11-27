/*
 * The price, worked out from the listings that count (pure: no DOM). The page and the price
 * research service run this same file (tech/price-check/js/stats.js and
 * tech/anthropic-price-service/src/stats.js are identical; npm run check:shell checks it): the page
 * so ticking a listing in or out changes the numbers at once, the service so a saved search's
 * price is the one the page shows.
 *
 * A listing counts by default when its page came up in the research (not "unverified"), it's in
 * pesos, it has a per-unit price, it's the same thing (not a substitute, not a rental when the
 * request is to buy), it's not more than 12 months old, and it's new when there are new ones to go
 * by (used ones are left out then). Everything left out for a reason can be ticked back in, except
 * a page the research never saw or a price that can't be compared.
 * Prices are compared per unit, VAT included (the service adds 12% where a page says VAT-ex).
 * From 5 listings up, unusually high or low prices (outside 1.5 x the middle half's spread) are set
 * aside. The typical price is the median of the rest.
 */

export const REASONS = {
  unverified: "Its page never came up in the research",
  currency: "In another currency",
  unit: "Can't be compared per unit",
  zero: "No price",
  substitute: "A different product",
  rental: "A rental, not a purchase",
  purchase: "A purchase, not a rental",
  used: "Used, and there are new ones",
  old: "Older than 12 months",
};

/** Why a listing is left out when the report opens ("" when it counts). preferNew: leave out used
 *  and refurbished listings (prefersNew() says when). */
export function excludedReason(l, currency, { now = Date.now(), months = 12, preferNew = false } = {}) {
  if (l.verification && l.verification.status === "unverified") return REASONS.unverified;
  if (l.currency !== currency) return REASONS.currency;
  if (!(l.comparable_price > 0)) return l.price > 0 ? REASONS.unit : REASONS.zero;
  if (l.mismatch === "rental") return REASONS.rental;
  if (l.mismatch === "purchase") return REASONS.purchase;
  if (l.match === "substitute") return REASONS.substitute;
  if (preferNew && (l.condition === "used" || l.condition === "refurbished")) return REASONS.used;
  // Old offers can be ticked back in. Past CE lines aren't offers: their age shows, but they count.
  if (!(l.verification && (l.verification.via === "costings" || l.verification.via === "po")) && isOld(l.page_date, { now, months })) return REASONS.old;
  return "";
}

/** Can the person count it? Everything but an unseen page or a price that can't be compared. */
export function canInclude(l, currency) {
  const r = excludedReason(l, currency);
  return !r || [REASONS.substitute, REASONS.old, REASONS.rental, REASONS.purchase, REASONS.used].includes(r);
}

/** Are there enough new listings (2) that used ones shouldn't set the price? */
export const prefersNew = (report) => report.listings.filter((l) => l.condition === "new" && !excludedReason(l, report.currency)).length >= 2;

/** Why a listing is left out of this report when it opens ("" when it counts). */
export const reasonIn = (report, l, opts = {}) => excludedReason(l, report.currency, { ...opts, preferNew: prefersNew(report) });

/** The ids counted when the report opens. */
export const defaultIncluded = (report) => {
  const preferNew = prefersNew(report);
  return report.listings.filter((l) => !excludedReason(l, report.currency, { preferNew })).map((l) => l.id);
};

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Statistics over the included listings' comparable prices. */
export function analyse(listings, included, { outliersFrom = 5 } = {}) {
  const inc = listings.filter((l) => included.has(l.id) && l.comparable_price > 0);
  const all = inc.map((l) => l.comparable_price).sort((a, b) => a - b);
  if (!all.length) return { n: 0, kept: [], outliers: new Set(), checked: 0 };
  let lo = -Infinity, hi = Infinity;
  if (all.length >= outliersFrom) {
    const q1 = quantile(all, 0.25), q3 = quantile(all, 0.75), iqr = q3 - q1;
    lo = q1 - 1.5 * iqr;
    hi = q3 + 1.5 * iqr;
  }
  const kept = inc.filter((l) => l.comparable_price >= lo && l.comparable_price <= hi);
  const outliers = new Set(inc.filter((l) => !kept.includes(l)).map((l) => l.id));
  const k = kept.map((l) => l.comparable_price).sort((a, b) => a - b);
  return {
    n: k.length, kept, outliers, lo, hi,
    min: k[0], max: k[k.length - 1], q1: quantile(k, 0.25), median: quantile(k, 0.5), q3: quantile(k, 0.75),
    mean: k.reduce((t, v) => t + v, 0) / k.length,
    checked: kept.filter((l) => l.verification && l.verification.status === "checked").length,
    allMin: all[0], allMax: all[all.length - 1],
  };
}

/** "2026-11-01" or "2026-11" -> ms (UTC), or NaN. */
export function parseDay(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] || 1));
}

/** Is an offer dated more than `months` ago? (an unknown date isn't old) */
export function isOld(pageDate, { now = Date.now(), months = 12 } = {}) {
  const t = parseDay(pageDate);
  return Number.isFinite(t) && now - t > months * 30.44 * 864e5;
}

/** How far to trust the typical price: { level: high | medium | low | none, label, reason }. */
export function confidence(st, { now = Date.now(), months = 12, costings = false } = {}) {
  if (!st.n) return { level: "none", label: "No price yet", reason: "None of the listings can be compared." };
  const spread = st.q1 > 0 ? st.q3 / st.q1 : Infinity;
  const old = st.kept.filter((l) => isOld(l.page_date, { now, months })).length;
  // Past costings come from Mineski's own records, so "seen on its page" says nothing there.
  const parts = [`${st.n} price${st.n === 1 ? "" : "s"}`, costings ? "from Mineski's own records" : `${st.checked} seen on ${st.checked === 1 ? "its page" : "their pages"}`];
  if (st.n >= 3) parts.push(spread <= 1.25 ? "close together" : spread <= 1.6 ? "fairly close together" : "widely spread");
  if (old) parts.push(`${old} older than ${months} months`);
  let level = "low";
  if (st.n >= 5 && st.checked >= 3 && spread <= 1.6 && old <= st.n / 3) level = "high";
  else if (st.n >= 3 && st.checked >= 1 && spread <= 2.5) level = "medium";
  const label = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" }[level];
  return { level, label, reason: `${parts.join(", ")}.` };
}

const round2 = (v) => Math.round(v * 100) / 100;

/** The price a saved search keeps: { typical, low, high, q1, q3, n, confidence, included }
 *  (numbers null when nothing counts). `included` defaults to what counts when the report opens. */
export function priceOf(report, included = defaultIncluded(report), opts = {}) {
  const valid = new Set(report.listings.map((l) => l.id));
  const ids = [...new Set(included)].filter((id) => valid.has(id));
  const st = analyse(report.listings, new Set(ids), opts);
  const c = confidence(st, opts);
  const n = (v) => (st.n ? round2(v) : null);
  return { typical: n(st.median), low: n(st.min), high: n(st.max), q1: n(st.q1), q3: n(st.q3), n: st.n, confidence: c.level, included: ids };
}
