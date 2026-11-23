// The Node server: streams answers as they're written, and a client that leaves aborts the run.
import test from "node:test";
import assert from "node:assert/strict";
import { serve, parseDotEnv } from "../server.js";

test(".env files: comments, quotes, export", () => {
  assert.deepEqual(parseDotEnv("# c\nA=1\nexport B = two words \nC=\"quoted # not a comment\"\nD=x # comment\nbad line\n"),
    { A: "1", B: "two words", C: "quoted # not a comment", D: "x" });
});

test("the server streams lines as they come and aborts the handler's signal when the client leaves", async () => {
  let signal = null, aborted = false;
  const handle = async (request, opts) => {
    signal = opts.signal;
    signal.addEventListener("abort", () => { aborted = true; });
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    (async () => {
      await w.write(enc.encode('{"type":"start"}\n')).catch(() => {});
      for (let i = 0; i < 50 && !aborted; i++) {
        await new Promise((r) => setTimeout(r, 20));
        await w.write(enc.encode('{"type":"ping"}\n')).catch(() => {});
      }
      await w.close().catch(() => {});
    })();
    return new Response(readable, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  };
  const server = serve(handle, { port: 0 });
  await new Promise((r) => server.on("listening", r));
  const { port } = server.address();
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/research`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" }, signal: ctl.signal });
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"start"/, "the first line arrives before the answer is finished");
  ctl.abort();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(aborted, true);
  await new Promise((r) => server.close(r));
});

test("the server listens on 127.0.0.1 by default", async () => {
  const server = serve(async () => new Response("{}"), { port: 0 });
  await new Promise((r) => server.on("listening", r));
  assert.equal(server.address().address, "127.0.0.1");
  await new Promise((r) => server.close(r));
});
