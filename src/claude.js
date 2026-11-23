/*
 * The Anthropic Messages API, called with plain fetch (the Mineski services take no npm
 * dependencies and have no build step; see mineski-systems-design section 7.1). Adapted from
 * tech/anthropic-ce/src/claude.js: the same Client, errors and classify(), but every answer is
 * rebuilt block by block (sse.js), so a paused web-search turn can be continued exactly and the
 * service can read the search results, fetched pages and code output.
 *
 *   createMessage(body, { signal, timeoutMs, onEvent })
 *       POST /v1/messages with "stream": true and read it to the end. onEvent(event, block) is
 *       called for every event as it arrives (the run loop turns them into progress lines).
 *       Resolves the rebuilt message plus `resumable` (false if anything in it couldn't be rebuilt).
 *
 * Errors are ClaudeError(message, kind, status) with kind:
 *   "config"     the key was refused (401/403)
 *   "quota"      rate or spend limit (429)
 *   "retryable"  overloaded or a network/5xx failure (529, 500-504)
 *   "content"    the request itself was refused (400, too large)
 *   "cancelled"  the person cancelled (the caller's signal fired)
 *   "timeout"    no complete answer in time
 *   "fatal"      anything else
 */
import { MessageAccumulator, splitEvents } from "./sse.js";

export const API = "https://api.anthropic.com/v1";
export const API_VERSION_HEADER = "2026-10-21";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class ClaudeError extends Error {
  constructor(message, kind = "fatal", status = null) {
    super(message);
    Object.assign(this, { kind, status });
  }
}

export function classify(status, payload) {
  const err = (payload && payload.error) || {};
  const msg = err.message || `HTTP ${status}`;
  const type = err.type || "";
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") return new ClaudeError(msg, "config", status);
  if (status === 429 || type === "rate_limit_error") return new ClaudeError(msg, "quota", status);
  if (status === 529 || type === "overloaded_error" || [500, 502, 503, 504].includes(status)) return new ClaudeError(msg, "retryable", status);
  if (status === 400 || status === 413 || type === "invalid_request_error" || type === "request_too_large") return new ClaudeError(msg, "content", status);
  return new ClaudeError(msg, "fatal", status);
}

/** Read a Server-Sent Events body and rebuild the message. */
export async function readStream(body, { onEvent } = {}) {
  const acc = new MessageAccumulator();
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const handle = ({ event, data }) => {
    if (!data) return;
    let ev;
    try { ev = JSON.parse(data); } catch (_) { return; }
    if (!ev.type && event) ev.type = event;
    if (ev.type === "error") {
      const e = ev.error || {};
      const status = e.type === "overloaded_error" ? 529 : e.type === "rate_limit_error" ? 429 : e.type === "invalid_request_error" ? 400 : 500;
      throw classify(status, ev);
    }
    const block = acc.add(ev);
    if (onEvent) {
      try { onEvent(ev, block, acc); } catch (_) { /* progress reporting never stops the read */ }
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += value;
      const [events, rest] = splitEvents(buf);
      buf = rest;
      events.forEach(handle);
      if (done) break;
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
  if (!acc.msg.stop_reason) throw new ClaudeError("The answer from Anthropic stopped part-way.", "retryable");
  const msg = acc.message();
  msg.resumable = acc.resumable;
  msg.problem = acc.problem;
  return msg;
}

export class Client {
  constructor(apiKey, { fetch: f = (...a) => globalThis.fetch(...a), betas = [] } = {}) {
    this.apiKey = apiKey;
    this.fetch = f;
    this.betas = betas;
  }

  headers(extra = {}) {
    const h = new Headers({ "x-api-key": this.apiKey, "anthropic-version": API_VERSION_HEADER, ...extra });
    if (this.betas.length) h.set("anthropic-beta", this.betas.join(","));
    return h;
  }

  async createMessage(body, { signal = null, timeoutMs = 300000, onEvent = null } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const all = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const why = (e) => {
      if (signal && signal.aborted) return new ClaudeError("Cancelled.", "cancelled");
      if (timeout.aborted) return new ClaudeError("Anthropic didn't finish answering in time.", "timeout");
      if (e instanceof ClaudeError) return e;
      return null;
    };
    let res;
    try {
      res = await this.fetch(`${API}/messages`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ ...body, stream: true }),
        signal: all,
      });
    } catch (e) {
      throw why(e) || new ClaudeError(`Couldn't reach Anthropic (${(e && e.message) || e}).`, "retryable");
    }
    if (!res.ok) {
      let payload = {};
      try { payload = await res.json(); } catch (_) { /* not JSON */ }
      throw classify(res.status, payload);
    }
    try {
      return await readStream(res.body, { onEvent });
    } catch (e) {
      throw why(e) || new ClaudeError(`The answer from Anthropic was cut off (${(e && e.message) || e}).`, "retryable");
    }
  }
}
