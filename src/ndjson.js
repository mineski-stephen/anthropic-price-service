/*
 * The research answer is a stream of JSON lines (application/x-ndjson), so the page can show real
 * progress during a run of a minute or more:
 *
 *   {"type":"start", "id", "model", "depth", "caps": {searches, fetches}, "estimate_ms"}
 *   {"type":"activity", "kind": "search"|"search_done"|"fetch"|"fetch_done"|"filter"|"writing"|"checking"|"wrap_up", ...}
 *   {"type":"usage", "cost_usd", "searches", "fetches"}
 *   {"type":"ping"}                                  every 15 s, so nothing between closes the line
 *   {"type":"report", "report": {...}}               the last line on success
 *   {"type":"error", "error": {"code", "message"}}   the last line on failure
 *
 * Exactly one "report" or "error" line ends a stream. A stream that ends without one was cut off.
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
