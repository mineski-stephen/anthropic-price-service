/*
 * One research run: the conversation with Claude, from the request to submit_report.
 *
 * The conversation is append-only (one `messages` array, never edited):
 *   - pause_turn: the server-side loop paused a long turn. The answer goes back unchanged as an
 *     assistant message, with the same tools and the code container's id, and the turn continues.
 *     Searches made inside code don't count toward max_uses across requests, so the run keeps its
 *     own count: after the depth's continuations, or at 70% of MAX_RUN_USD, a system message asks
 *     Claude to stop and report (system messages may follow an assistant turn that ends in a
 *     server tool call).
 *   - end_turn without a report: one user message asks for submit_report.
 *   - submit_report: done, even if a search was called beside it (that search never runs).
 * Progress (searches, pages, code) is passed to `emit` as it streams.
 */
import { ClaudeError } from "./claude.js";
import { DEPTHS, SUPPLIER_EXTRA, buildBody, buildTools, userText, WRAP_UP, NUDGE } from "./request.js";
import { createTally } from "./cost.js";
import { hostOf } from "./evidence.js";

export class RunError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Typical run length per depth, before the page has timings of its own (ms). */
export const ESTIMATE_MS = { check: 45000, quick: 60000, standard: 120000, thorough: 240000 };

export const caps = (input) => {
  const d = DEPTHS[input.depth];
  const x = input.suppliers ? SUPPLIER_EXTRA : { searches: 0, fetches: 0 };
  return { searches: d.searches + x.searches, fetches: d.fetches + x.fetches, continuations: d.continuations };
};

/** Turn stream events into progress lines. */
export function progress(ev, block, emit) {
  if (!block || !ev) return;
  if (ev.type === "content_block_stop" && block.type === "server_tool_use") {
    const input = block.input || {};
    if (block.name === "web_search") emit({ type: "activity", kind: "search", query: String(input.query || "").slice(0, 200) });
    else if (block.name === "web_fetch") emit({ type: "activity", kind: "fetch", url: String(input.url || "").slice(0, 500), host: hostOf(input.url) });
    else if (/code_execution/.test(block.name || "")) emit({ type: "activity", kind: "filter" });
  } else if (ev.type === "content_block_start") {
    if (block.type === "web_search_tool_result") {
      const ok = Array.isArray(block.content);
      emit({ type: "activity", kind: "search_done", results: ok ? block.content.length : 0, error: ok ? "" : String((block.content && block.content.error_code) || "error") });
    } else if (block.type === "web_fetch_tool_result") {
      const c = block.content || {};
      const ok = c.type === "web_fetch_result";
      emit({ type: "activity", kind: "fetch_done", ok, host: hostOf(c.url), error: ok ? "" : String(c.error_code || "error") });
    } else if (block.type === "tool_use" && block.name === "submit_report") {
      emit({ type: "activity", kind: "writing" });
    }
  }
}

/** Run the research. Resolves { report (submit_report's input), run }; throws RunError or ClaudeError. */
export async function runResearch({ client, input, system, today, cfg, signal = null, emit = () => {}, log = () => {}, onResponse = null }) {
  const cap = Math.min(cfg.maxRunUsd, DEPTHS[input.depth].maxUsd || Infinity);   // a depth may have its own, lower cap
  const tools = buildTools(input);
  const limits = caps(input);
  const messages = [{ role: "user", content: [{ type: "text", text: userText(input, today) }] }];
  const run = { requests: 0, continuations: 0, models: [], blocks: [], ended: "", container: null, nudged: false, wrapped: false,
    retried: false, tally: createTally() };
  const deadline = Date.now() + cfg.runTimeoutMs;

  for (;;) {
    if (run.requests >= limits.continuations + 4) throw new RunError("no_report", "The research went on too long without a report. Try again, or try Quick.");
    const left = deadline - Date.now();
    if (left < 15000) throw new RunError("timeout", "The research took too long and was stopped. Try Quick, or a more specific name.");
    const body = buildBody(input, { system, messages, tools, fallback: cfg.fallback, container: run.container, maxTokens: cfg.maxTokens });
    run.requests++;
    let msg;
    try {
      msg = await client.createMessage(body, { signal, timeoutMs: Math.min(cfg.requestTimeoutMs, left), onEvent: (ev, block) => progress(ev, block, emit) });
    } catch (e) {
      // One retry per run for an overloaded or dropped answer. Nothing from it was kept, so the
      // same conversation is sent again.
      if (e instanceof ClaudeError && e.kind === "retryable" && !run.retried && deadline - Date.now() > 60000) {
        run.retried = true;
        log(`claude retryable (${e.status || "-"}: ${String(e.message).slice(0, 120)}); retrying once`);
        emit({ type: "activity", kind: "retry" });
        await new Promise((r) => setTimeout(r, 3000));
        run.requests--;
        continue;
      }
      throw e;
    }
    if (onResponse) { try { onResponse({ n: run.requests, body, msg }); } catch (_) { /* recording never stops a run */ } }
    run.models.push(msg.model || input.model);
    run.tally.add(msg.model || input.model, msg.usage || {});
    emit({ type: "usage", cost_usd: run.tally.cost.total, searches: run.tally.usage.web_search_requests, fetches: run.tally.usage.web_fetch_requests });
    run.blocks.push(...msg.content);
    if (msg.container && msg.container.id) run.container = msg.container.id;

    const submit = [...msg.content].reverse().find((b) => b.type === "tool_use" && b.name === "submit_report");
    if (submit) {
      run.ended = run.wrapped ? "wrapped_up" : run.nudged ? "nudged" : "submitted";
      return { report: submit.input && typeof submit.input === "object" ? submit.input : {}, run };
    }
    const stop = msg.stop_reason;
    if (stop === "refusal") throw new RunError("refused", "Claude declined this request. Rephrase the item or service and try again.");
    if (stop === "max_tokens") throw new RunError("too_long", "The report came out too long. Try a more specific name, or Quick.");
    if (run.tally.cost.total >= cap) throw new RunError("budget", `This run reached its spending limit (US$${cap}) before it finished. Try a more specific name.`);

    if (stop === "pause_turn") {
      if (!msg.resumable) throw new RunError("upstream_error", `Claude's answer couldn't be continued (${msg.problem || "unknown block"}).`);
      messages.push({ role: "assistant", content: msg.content });
      run.continuations++;
      const over = run.continuations > limits.continuations || run.tally.cost.total >= cap * 0.7;
      if (over && !run.wrapped) {
        messages.push({ role: "system", content: WRAP_UP });
        run.wrapped = true;
        emit({ type: "activity", kind: "wrap_up" });
      }
      continue;
    }
    if (stop === "end_turn" || stop === "stop_sequence") {
      if (run.nudged) throw new RunError("no_report", "The research finished without a report. Try again, or describe the item differently.");
      messages.push({ role: "assistant", content: msg.content });
      messages.push({ role: "user", content: [{ type: "text", text: NUDGE }] });
      run.nudged = true;
      continue;
    }
    throw new RunError("upstream_error", `Claude stopped unexpectedly (${stop || "no reason given"}).`);
  }
}
