/*
 * What the research actually saw (pure: no network). Built from every block of every answer in a
 * run, so the service can check the report against it (verify.js):
 *
 *   queries    each web search: the query, how many results, or its error code
 *   pages      every URL that came back from a search or was opened, with the page text when it
 *              was opened (web fetch), its title and age
 *   stdout     everything the filtering code printed (dynamic filtering reads pages in code; the
 *              prompt asks it to print an EVIDENCE line for every price it reports)
 *   evidence   those EVIDENCE lines, parsed: { url, price, context }
 *   citations  cited text per page, from text blocks
 *
 * Search results' own text (encrypted_content) can't be read, so a price that only appeared in a
 * search snippet can be confirmed only through the code's output or a citation.
 */

// Query parameters that only track the visit; dropped when comparing addresses.
const TRACKING = /^(utm_.*|gclid|fbclid|gad_source|gbraid|wbraid|mc_.*|ref|ref_.*|spm|scm|clicktrackinfo|from|_branch_.*|igshid|yclid|msclkid|srsltid|sp_atk|xptdk|trackingid|abt|search|keyword|source|share.*)$/i;

/** A comparable form of a web address: host (lowercase, no www.) + path (no trailing slash) +
 *  the non-tracking query parameters, sorted. "" when it isn't an http(s) address. */
export function normUrl(u) {
  let x;
  try { x = new URL(String(u || "").trim()); } catch (_) { return ""; }
  if (x.protocol !== "http:" && x.protocol !== "https:") return "";
  const host = x.hostname.toLowerCase().replace(/^www\./, "");
  const path = decodeSafe(x.pathname).replace(/\/+$/, "") || "";
  const params = [...x.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return host + path + (params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "");
}
const decodeSafe = (p) => { try { return decodeURI(p); } catch (_) { return p; } };

/** Host + path only: the fallback when query strings differ. */
export const looseKey = (key) => String(key || "").split("?")[0];

/** The host of a web address without www. ("" if it isn't one). */
export function hostOf(u) {
  try { const x = new URL(String(u || "").trim()); return /^https?:$/.test(x.protocol) ? x.hostname.toLowerCase().replace(/^www\./, "") : ""; } catch (_) { return ""; }
}

/** Text tidied for matching: compatibility forms (NFKC turns non-breaking and thin spaces into
 *  spaces, full-width digits into digits), runs of whitespace into one space. */
export const tidy = (t) => String(t || "").normalize("NFKC").replace(/\s+/g, " ");

/** EVIDENCE lines printed by the filtering code: EVIDENCE<TAB>url<TAB>price<TAB>context
 *  (a " | " separator is accepted too). */
export function evidenceLines(stdout) {
  const out = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = line.match(/^\s*EVIDENCE\s*(?:\t|\s\|\s)(.*)$/);
    if (!m) continue;
    const parts = m[1].split(/\t|\s\|\s/).map((p) => p.trim());
    const url = parts[0] || "";
    if (!normUrl(url)) continue;
    out.push({ url, price: parts[1] || "", context: parts.slice(2).join(" ").slice(0, 300) });
  }
  return out;
}

/** Collect everything the research saw from the answers' blocks. */
export function collectEvidence(blocks) {
  const calls = new Map();   // server_tool_use id -> the call
  const queries = [];
  const pages = new Map();   // normUrl -> page
  const stdout = [];
  const citations = new Map();   // looseKey -> [cited text]

  const page = (url, patch = {}) => {
    const key = normUrl(url);
    if (!key) return null;
    let p = pages.get(key);
    if (!p) {
      p = { url: String(url), key, loose: looseKey(key), host: hostOf(url), title: "", page_age: "", searched: false,
        fetched: false, text: "", retrieved_at: "", error: "" };
      pages.set(key, p);
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === "") continue;
      if (k === "text" && p.text) continue;   // keep the first full copy
      p[k] = v;
    }
    return p;
  };

  for (const b of blocks || []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "server_tool_use") { calls.set(b.id, b); continue; }
    if (b.type === "web_search_tool_result") {
      const call = calls.get(b.tool_use_id);
      const query = String((call && call.input && call.input.query) || "");
      if (Array.isArray(b.content)) {
        queries.push({ query, results: b.content.length, error: "" });
        for (const r of b.content) if (r && r.type === "web_search_result") page(r.url, { title: r.title, page_age: r.page_age, searched: true });
      } else {
        queries.push({ query, results: 0, error: String((b.content && b.content.error_code) || "error") });
      }
      continue;
    }
    if (b.type === "web_fetch_tool_result") {
      const call = calls.get(b.tool_use_id);
      const asked = String((call && call.input && call.input.url) || "");
      const c = b.content || {};
      if (c.type === "web_fetch_result") {
        const doc = c.content || {};
        const src = doc.source || {};
        const text = src.type === "text" && typeof src.data === "string" ? src.data : "";
        const patch = { title: doc.title, fetched: true, text, retrieved_at: c.retrieved_at, error: "" };
        page(c.url || asked, patch);
        if (asked && normUrl(asked) !== normUrl(c.url)) page(asked, patch);   // the address asked for, when it redirected
      } else if (asked) {
        page(asked, { error: String(c.error_code || "error") });
      }
      continue;
    }
    if (/_tool_result$/.test(String(b.type)) && b.content && typeof b.content.stdout === "string") {
      if (b.content.stdout) stdout.push(b.content.stdout);
      continue;
    }
    if (b.type === "text" && Array.isArray(b.citations)) {
      for (const c of b.citations) {
        if (!c || !c.url || !c.cited_text) continue;
        const key = looseKey(normUrl(c.url));
        if (!key) continue;
        if (!citations.has(key)) citations.set(key, []);
        citations.get(key).push(String(c.cited_text));
        page(c.url, { title: c.title });
      }
    }
  }
  const out = stdout.join("\n");
  return { queries, pages: [...pages.values()], stdout: out, evidence: evidenceLines(out), citations };
}
