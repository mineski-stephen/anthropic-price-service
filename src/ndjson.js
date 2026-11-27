/*
 * The research answer is a stream of JSON lines (application/x-ndjson), so the page can show real
 * progress during a run of a minute or more:
 *
 *   {"type":"start", "id", "search_id", "model", "depth", "caps": {searches, fetches}, "estimate_ms"}
 *   {"type":"activity", "kind": "costings"|"search"|"search_done"|"fetch"|"fetch_done"|"filter"|"writing"|"checking"|"images"|"wrap_up"|"retry", ...}
 *   {"type":"usage", "cost_usd", "searches", "fetches"}
 *   {"type":"ping"}                                  every 15 s, so nothing between closes the line
 *   {"type":"report", "report": {...}}               the search is done
 *   {"type":"saved", "saved": {...} | null, "error": {"code", "message"} | null}
 *                                                    the last line after a report: the record in the
 *                                                    saved searches table, or why it isn't there
 *   {"type":"error", "error": {"code", "message"}}   the last line on failure
 *
 * Exactly one "report" or "error" line comes; a report is followed by one "saved" line. A stream
 * that ends without a report or an error was cut off.
 */

export const CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

/** A writer over a TransformStream: line(obj) queues one JSON line; close() ends it. Writes after
 *  the reader went away are dropped (the run is cancelled through `onGone`). */
export function createWriter({ onGone = () => {} } = {}) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let gone = false;
  const lost = () => { if (!gone) { gone = true; onGone(); } };
  writer.closed.catch(lost);
  return {
    readable,
    get gone() { return gone; },
    line(obj) {
      if (gone) return Promise.resolve();
      return writer.write(enc.encode(`${JSON.stringify(obj)}\n`)).catch(lost);
    },
    close() { return gone ? Promise.resolve() : writer.close().catch(lost); },
  };
}

/** Split NDJSON text into objects. Returns [objects, rest]; rest is an unfinished last line. */
export function parseLines(buf) {
  const out = [];
  const parts = String(buf).split("\n");
  const rest = parts.pop();
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* a broken line is skipped */ }
  }
  return [out, rest];
}
