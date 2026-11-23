/*
 * Checking the report against what the research saw (pure: no network). This is what makes the
 * prices trustworthy: Claude writes the report, but a listing only counts if its page really came
 * back from a search or was opened, and its price is confirmed if the figure appears there.
 *
 * A listing's status:
 *   checked      its price appears on its page (opened), in a citation of it, or in the filtering
 *                code's output next to its address. Shown as "Price seen on page".
 *   link         its page came back from a search or was opened, but the price couldn't be
 *                confirmed (marketplaces usually: their pages can't be opened and search snippets
 *                can't be read). Shown as "Link found".
 *   unverified   its address never came back from anything. Left out of the price, shown without a link.
 */
import { normUrl, looseKey, hostOf, tidy } from "./evidence.js";

// A currency mark just before or after a number: ₱ PHP Php P, $ USD, S$ SGD, RM MYR, £ GBP.
const MARK_BEFORE = /(?:₱|\bphp|\bp|\$|\busd|\bsgd|\brm|\bmyr|£|\bgbp)\s?$/i;
const MARK_AFTER = /^\s?(?:php|pesos?|usd|sgd|myr|gbp)\b/i;
const NUMBER = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d,]*\d)/g;

/** Every number in a text: { value, index, end, marked } (marked: a currency mark beside it). */
export function numbersIn(text) {
  const t = String(text || "");
  const out = [];
  for (const m of t.matchAll(NUMBER)) {
    const value = Number(m[1].replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""));
    if (!Number.isFinite(value)) continue;
    const before = t.slice(Math.max(0, m.index - 5), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 7);
    out.push({ value, index: m.index, end: m.index + m[0].length, marked: MARK_BEFORE.test(before) || MARK_AFTER.test(after) });
  }
  return out;
}

export const samePrice = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b > 0 && Math.abs(a - b) < 0.006;

/** A short excerpt around position i. */
export function excerpt(text, i, end = i, width = 110) {
  const t = String(text || "");
  const from = Math.max(0, i - width), to = Math.min(t.length, end + width);
  return `${from > 0 ? "…" : ""}${t.slice(from, to).trim()}${to < t.length ? "…" : ""}`.slice(0, 240);
}

/** The best place in `text` where `price` is written with a currency mark (or exactly as
 *  `priceText`), nearest the title's words. Null if it isn't there. */
export function findPrice(text, price, { title = "", priceText = "" } = {}) {
  const t = tidy(text);
  if (!t || !(price > 0)) return null;
  const hits = numbersIn(t).filter((x) => x.marked && samePrice(x.value, price));
  const pt = tidy(priceText).trim();
  if (pt && /\d/.test(pt) && numbersIn(pt).some((x) => samePrice(x.value, price))) {
    let at = t.indexOf(pt);
    while (at >= 0) { hits.push({ index: at, end: at + pt.length }); at = t.indexOf(pt, at + 1); }
  }
  if (!hits.length) return null;
  const words = tidy(title).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4).slice(0, 4);
  const lower = t.toLowerCase();
  const spots = words.flatMap((w) => { const s = []; let at = lower.indexOf(w); while (at >= 0 && s.length < 50) { s.push(at); at = lower.indexOf(w, at + 1); } return s; });
  const dist = (h) => (spots.length ? Math.min(...spots.map((p) => Math.abs(p - h.index))) : 0);
  const best = hits.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  return { index: best.index, excerpt: excerpt(t, best.index, best.end) };
}

/** Does any marked number in `text` equal `price`? (for short texts: citations, EVIDENCE prices) */
export const mentions = (text, price, { anyNumber = false } = {}) =>
  numbersIn(tidy(text)).some((x) => (anyNumber || x.marked) && samePrice(x.value, price));

/** Lookup tables for one run's evidence (build once, check every listing against it). */
export function index(ev) {
  const byKey = new Map(), byLoose = new Map();
  for (const p of ev.pages || []) {
    byKey.set(p.key, p);
    if (!byLoose.has(p.loose) || (p.text && !byLoose.get(p.loose).text)) byLoose.set(p.loose, p);
  }
  return { ...ev, byKey, byLoose, stdoutLower: String(ev.stdout || "").toLowerCase() };
}

/** One listing's status: { status, via, evidence: [{ url, excerpt }] }. */
export function verifyListing(listing, ix) {
  const key = normUrl(listing.url);
  if (!key) return { status: "unverified", via: null, evidence: [] };
  const loose = looseKey(key);
  const page = ix.byKey.get(key) || ix.byLoose.get(loose) || null;
  const inStdout = ix.stdoutLower.includes(loose);
  const cited = ix.citations && ix.citations.get(loose);
  if (!page && !inStdout && !cited) return { status: "unverified", via: null, evidence: [] };
  const price = Number(listing.price);
  const opts = { title: listing.title, priceText: listing.price_text };

  // 1. The page itself, when it was opened.
  for (const p of [page, page && ix.byLoose.get(loose)].filter((x) => x && x.text)) {
    const hit = findPrice(p.text, price, opts);
    if (hit) return { status: "checked", via: "page_text", evidence: [{ url: p.url, excerpt: hit.excerpt }] };
  }
  // 2. A citation of it.
  for (const c of cited || []) {
    if (mentions(c, price) || (listing.price_text && tidy(c).includes(tidy(listing.price_text).trim()) && mentions(listing.price_text, price, { anyNumber: true }))) {
      return { status: "checked", via: "citation", evidence: [{ url: listing.url, excerpt: tidy(c).slice(0, 240) }] };
    }
  }
  // 3. An EVIDENCE line the filtering code printed for it.
  for (const line of ix.evidence || []) {
    if (looseKey(normUrl(line.url)) !== loose) continue;
    if (mentions(line.price, price, { anyNumber: true })) {
      return { status: "checked", via: "filter_output", evidence: [{ url: line.url, excerpt: tidy(`${line.price} ${line.context}`).slice(0, 240) }] };
    }
  }
  // 4. The code's output, near the address.
  if (inStdout) {
    const out = String(ix.stdout || "");
    let at = ix.stdoutLower.indexOf(loose);
    while (at >= 0) {
      const from = Math.max(0, at - 300), to = Math.min(out.length, at + loose.length + 300);
      const near = out.slice(from, to);
      if (mentions(near, price) || numbersIn(tidy(near)).some((x) => samePrice(x.value, price) && listing.price_text && tidy(near).includes(tidy(listing.price_text).trim()))) {
        return { status: "checked", via: "filter_output", evidence: [{ url: listing.url, excerpt: tidy(near).slice(0, 240) }] };
      }
      at = ix.stdoutLower.indexOf(loose, at + 1);
    }
  }
  return { status: "link", via: page && page.text ? "page_opened" : page && page.error ? "page_unreadable" : "search_result", evidence: [] };
}

const digits = (s) => String(s || "").replace(/\D/g, "");

/** A supplier's contact details: "checked" when the phone or email appears on a page of its own
 *  site (or the page it was taken from), "unconfirmed" when not, "none" when it has neither. */
export function verifySupplier(sup, ix) {
  const phone = digits(sup.phone), email = String(sup.email || "").trim().toLowerCase();
  if (phone.length < 7 && !email) return { status: "none", via: null };
  const own = hostOf(sup.website), src = normUrl(sup.source_url);
  const pages = (ix.pages || []).filter((p) => p.text && ((own && (p.host === own || p.host.endsWith(`.${own}`) || own.endsWith(`.${p.host}`))) || (src && p.key === src)));
  const found = (t) => (email && t.toLowerCase().includes(email)) || (phone.length >= 7 && digits(t).includes(phone.slice(-7)));
  for (const p of pages) if (found(p.text)) return { status: "checked", via: "page_text" };
  if (own && ix.stdoutLower.includes(own) && found(ix.stdout)) return { status: "checked", via: "filter_output" };
  return { status: "unconfirmed", via: null };
}
