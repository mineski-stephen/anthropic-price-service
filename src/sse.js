/*
 * Rebuilds a streamed Messages API answer block by block (pure: no network).
 *
 * anthropic-ce's reader keeps only text. Price research needs every block, exactly as sent:
 *   - a paused turn (stop_reason "pause_turn") is continued by sending the answer back unchanged,
 *     thinking signatures and search results' encrypted_content included;
 *   - the service checks each reported price against the pages and code output in the answer.
 *
 * Event handling:
 *   content_block_start   the block as given (tool results arrive whole here, with `caller` when
 *                         code made the call)
 *   text_delta            appended to text          citations_delta  pushed to citations
 *   thinking_delta        appended to thinking      signature_delta  appended to signature
 *   input_json_delta      collected, parsed into `input` at content_block_stop
 *   message_delta         stop_reason, stop_details, container, usage (cumulative)
 * An unknown delta type makes the answer "not resumable": the service then won't send it back.
 */

const TOOL_CALLS = new Set(["server_tool_use", "tool_use", "mcp_tool_use"]);

export class MessageAccumulator {
  constructor() {
    this.msg = { id: "", type: "message", role: "assistant", model: "", content: [], stop_reason: null,
      stop_details: null, container: null, usage: {} };
    this.blocks = [];
    this.json = new Map();     // index -> partial JSON of a tool call's input
    this.resumable = true;
    this.problem = "";
  }

  /** Apply one parsed event; returns the block it touched (or null). */
  add(ev) {
    switch (ev && ev.type) {
      case "message_start": {
        const m = ev.message || {};
        this.msg.id = m.id || "";
        this.msg.model = m.model || "";
        if (m.container) this.msg.container = m.container;
        Object.assign(this.msg.usage, m.usage || {});
        return null;
      }
      case "content_block_start": {
        const b = structuredClone(ev.content_block || {});
        this.blocks[ev.index] = b;
        if (TOOL_CALLS.has(b.type)) this.json.set(ev.index, "");
        return b;
      }
      case "content_block_delta": {
        const b = this.blocks[ev.index];
        const d = ev.delta || {};
        if (!b) { this.notResumable(`a delta for a block that never started (${d.type})`); return null; }
        switch (d.type) {
          case "text_delta": b.text = (b.text || "") + (d.text || ""); break;
          case "citations_delta": if (!Array.isArray(b.citations)) b.citations = []; b.citations.push(d.citation); break;
          case "thinking_delta": b.thinking = (b.thinking || "") + (d.thinking || ""); break;
          case "signature_delta": b.signature = (b.signature || "") + (d.signature || ""); break;
          case "input_json_delta": this.json.set(ev.index, (this.json.get(ev.index) || "") + (d.partial_json || "")); break;
          default: this.notResumable(`an unknown delta type "${d.type}"`);
        }
        return b;
      }
      case "content_block_stop": {
        const b = this.blocks[ev.index];
        if (b && this.json.has(ev.index)) {
          const raw = this.json.get(ev.index);
          this.json.delete(ev.index);
          if (raw) {
            try { b.input = JSON.parse(raw); } catch (_) { b.input = {}; this.notResumable("a tool call whose input isn't valid JSON"); }
          } else if (b.input === undefined) b.input = {};
        }
        return b || null;
      }
      case "message_delta": {
        const d = ev.delta || {};
        if (d.stop_reason) this.msg.stop_reason = d.stop_reason;
        if (d.stop_details) this.msg.stop_details = d.stop_details;
        if (d.container) this.msg.container = d.container;
        if (ev.container) this.msg.container = ev.container;
        Object.assign(this.msg.usage, ev.usage || {});
        return null;
      }
      default:
        return null;   // message_stop, ping
    }
  }

  notResumable(why) {
    this.resumable = false;
    if (!this.problem) this.problem = why;
  }

  /** The rebuilt message (blocks in index order). */
  message() {
    this.msg.content = this.blocks.filter(Boolean);
    return this.msg;
  }
}

/**
 * Split a Server-Sent Events text buffer into complete events. Returns [events, rest], where rest
 * is the unfinished tail to keep for the next chunk. Each event is { event, data }.
 */
export function splitEvents(buf) {
  const out = [];
  const text = buf.replace(/\r\n/g, "\n");
  let start = 0, cut;
  while ((cut = text.indexOf("\n\n", start)) >= 0) {
    const chunk = text.slice(start, cut);
    start = cut + 2;
    let event = "", data = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
    }
    if (event || data) out.push({ event, data });
  }
  return [out, text.slice(start)];
}
