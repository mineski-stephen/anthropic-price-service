// The stream reader rebuilds answers exactly (a paused turn is sent back as it came). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { MessageAccumulator, splitEvents } from "../src/sse.js";
import { readStream, ClaudeError } from "../src/claude.js";
import { eventsFor, sseText, sseResponse, researchBlocks, strip } from "./helpers.mjs";

test("every block of a research answer comes back exactly as sent", () => {
  const blocks = researchBlocks();
  const acc = new MessageAccumulator();
  for (const ev of eventsFor(blocks, { stop: "tool_use", searches: 1, fetches: 2 })) acc.add(ev);
  const msg = acc.message();
  assert.deepEqual(msg.content, strip(blocks));
  assert.equal(msg.stop_reason, "tool_use");
  assert.equal(acc.resumable, true);
  assert.equal(msg.usage.server_tool_use.web_search_requests, 1);
  assert.equal(msg.usage.input_tokens, 1000);
  assert.equal(msg.usage.output_tokens, 500);
});

test("the container and stop details are kept", () => {
  const acc = new MessageAccumulator();
  for (const ev of eventsFor([{ type: "text", text: "Searching." }], { stop: "pause_turn", container: { id: "cont_1", expires_at: "2026-11-23T02:00:00Z" } })) acc.add(ev);
  assert.deepEqual(acc.message().container, { id: "cont_1", expires_at: "2026-11-23T02:00:00Z" });
  assert.equal(acc.message().stop_reason, "pause_turn");
});

test("an unknown delta type makes the answer not resumable", () => {
  const acc = new MessageAccumulator();
  acc.add({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  acc.add({ type: "content_block_delta", index: 0, delta: { type: "brand_new_delta", x: 1 } });
  assert.equal(acc.resumable, false);
  assert.match(acc.problem, /brand_new_delta/);
});

test("a tool call with broken JSON input is not resumable", () => {
  const acc = new MessageAccumulator();
  acc.add({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "s", name: "web_search", input: {} } });
  acc.add({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\": \"x" } });
  acc.add({ type: "content_block_stop", index: 0 });
  assert.equal(acc.resumable, false);
});

test("events split across chunk boundaries (and CRLF line ends) are read whole", () => {
  const text = sseText(eventsFor([{ type: "text", text: "hello" }])).replace(/\n/g, "\r\n");
  let rest = "", got = [];
  for (let i = 0; i < text.length; i += 7) {
    const [events, r] = splitEvents(rest + text.slice(i, i + 7));
    rest = r;
    got = got.concat(events);
  }
  assert.equal(got.length, eventsFor([{ type: "text", text: "hello" }]).length);
  assert.equal(JSON.parse(got[0].data).type, "message_start");
});

test("readStream rebuilds a streamed response and reports each event", async () => {
  const seen = [];
  const msg = await readStream(sseResponse(eventsFor(researchBlocks(), { stop: "tool_use" })).body, { onEvent: (ev) => seen.push(ev.type) });
  assert.deepEqual(msg.content, strip(researchBlocks()));
  assert.equal(msg.resumable, true);
  assert.ok(seen.includes("content_block_start") && seen.includes("message_delta"));
});

test("an error event in the stream becomes a ClaudeError of the right kind", async () => {
  const events = [{ type: "message_start", message: { id: "m", model: "claude-opus-5-5", usage: {} } },
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }];
  await assert.rejects(readStream(sseResponse(events).body), (e) => e instanceof ClaudeError && e.kind === "retryable");
});

test("a stream that stops without a stop reason is retryable, not a silent success", async () => {
  const events = eventsFor([{ type: "text", text: "partial" }]).slice(0, 3);
  await assert.rejects(readStream(sseResponse(events).body), (e) => e instanceof ClaudeError && e.kind === "retryable");
});
