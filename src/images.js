/*
 * Product photos for the listings: the picture each listing's own page names for sharing
 * (og:image, twitter:image, or a product's JSON-LD image). Read once, after the report is written,
 * straight from the listing's page: a few seconds at most, and a listing simply goes without a photo
 * when its page won't open (Lazada and Shopee usually refuse servers) or names none. The page then
 * shows a placeholder.
 *
 *   findImages(listings, { fetch, signal })  -> Map(listing url -> https image url)
 *   imageIn(html, pageUrl)                   -> the image a page names, or ""
 *
 * Only public https pages are opened (no addresses by number, no local names), only the first
 * MAX_BYTES of each is read, and only https images are kept (the page loads them itself, without a
 * referrer).
 */

export const MAX_PAGES = 12;
export const MAX_BYTES = 400000;
export const TIMEOUT_MS = 5000;
const UA = "Mozilla/5.0 (compatible; MineskiPriceCheck/1.0; product photos for a price check)";

/** May this address be opened? https only, a named public host. */
export function openable(url) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || /(^|\.)(localhost|local|internal|lan|home|corp)$/.test(host)) return false;
  return true;
}

const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'", "#x2F": "/", "#47": "/" };
const decode = (s) => String(s || "").replace(/&(amp|quot|apos|lt|gt|#39|#x2F|#47);/gi, (m, k) => ENTITIES[k] || ENTITIES[k.toLowerCase()] || m).trim();

/** An https image address from what a page wrote (relative ones resolved against the page), or "". */
function absolute(src, pageUrl) {
  const s = decode(src);
  if (!s || s.startsWith("data:")) return "";
  try {
    const u = new URL(s.startsWith("//") ? `https:${s}` : s, pageUrl);
    return u.protocol === "https:" && s.length < 2000 ? u.href : "";
  } catch (_) { return ""; }
}

const ATTR = /([a-zA-Z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const attrs = (tag) => {
  const out = {};
  for (const m of tag.matchAll(ATTR)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
};
const NAMES = ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"];

/** The image a page names for itself: og:image first, then twitter:image, a JSON-LD image, or
 *  <link rel="image_src">. "" when none. */
export function imageIn(html, pageUrl) {
  const text = String(html || "");
  const found = new Map();
  for (const m of text.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = String(a.property || a.name || a.itemprop || "").toLowerCase();
    if (NAMES.includes(key) && a.content && !found.has(key)) found.set(key, a.content);
  }
  for (const key of NAMES) {
    const img = found.has(key) ? absolute(found.get(key), pageUrl) : "";
    if (img) return img;
  }
  const ld = text.match(/"image"\s*:\s*(?:\[\s*)?(?:\{\s*"@type"\s*:\s*"ImageObject"\s*,\s*"url"\s*:\s*)?"(https?:[^"]+)"/);
  if (ld) { const img = absolute(ld[1].replace(/\\\//g, "/"), pageUrl); if (img) return img; }
  for (const m of text.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (String(a.rel || "").toLowerCase() === "image_src" && a.href) { const img = absolute(a.href, pageUrl); if (img) return img; }
  }
  return "";
}

/** The start of a page: up to MAX_BYTES, stopping at </head> (the tags we want are in the head). */
async function headOf(res) {
  if (!res.body) return (await res.text()).slice(0, MAX_BYTES);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += dec.decode(value, { stream: true });
      if (bytes >= MAX_BYTES || /<\/head>/i.test(text.slice(-4096 - value.byteLength))) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

/** Find a photo for each listing's page. Never throws; resolves within about TIMEOUT_MS. */
export async function findImages(listings, { fetch: f = (...a) => globalThis.fetch(...a), signal = null, timeoutMs = TIMEOUT_MS, log = () => {} } = {}) {
  const urls = [...new Set(listings.map((l) => l.url).filter(openable))].slice(0, MAX_PAGES);
  const out = new Map();
  if (!urls.length) return out;
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let failed = 0, timer = null;
  // A hard stop too, in case a page's answer ignores the abort.
  const stop = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs + 300); });
  const work = Promise.all(urls.map(async (url) => {
    try {
      const res = await f(url, { headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": UA }, redirect: "follow", signal: sig });
      if (!res.ok || !/html/i.test(res.headers.get("content-type") || "text/html")) { failed++; res.body && res.body.cancel().catch(() => {}); return; }
      const img = imageIn(await headOf(res), res.url || url);
      if (img) out.set(url, img); else failed++;
    } catch (_) { failed++; }
  }));
  await Promise.race([work, stop]);
  clearTimeout(timer);
  if (failed) log(`images: ${out.size} of ${urls.length} pages named a photo`);
  return out;
}
