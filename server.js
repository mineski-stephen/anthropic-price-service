#!/usr/bin/env node
/*
 * The price research service as a Node web server: what runs on this computer for the demo (and
 * what Render would run: Dockerfile CMD ["node", "server.js"]). Everything the service does is in
 * src/service.js, the same file Cloudflare Workers runs; this file only turns Node's HTTP requests
 * into web-standard Requests and the answers back, streaming included.
 *
 *   node server.js          # http://127.0.0.1:8003
 *   node server.js 9000     # another port
 *
 * Settings come from the environment, and from a .env file next to this one (git-ignored; copy
 * .env.example). Values already in the environment win over the file.
 *
 * Safeguards:
 * - It refuses to start (exit 1, with the reason) when a required setting is missing.
 * - It listens on 127.0.0.1 unless HOST says otherwise, and refuses to listen anywhere else with
 *   the Lark login switched off (REQUIRE_LARK_LOGIN=false): anyone who could reach it could spend
 *   the API key.
 * - When the page cancels (or the browser closes), the run's Anthropic request is aborted too.
 */
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createService, readConfig, VERSION } from "./src/service.js";

const BODYLESS = new Set(["GET", "HEAD", "OPTIONS"]);
// Render "Secret Files" are mounted here; the key may be in one of them.
const KEY_FILES = ["/etc/secrets/ANTHROPIC_API_KEY", "/etc/secrets/anthropic_api_key"];
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** KEY=value lines of a .env file (# comments, optional quotes). Missing file: {}. */
export function parseDotEnv(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

export function readDotEnv(path = fileURLToPath(new URL("./.env", import.meta.url))) {
  try { return parseDotEnv(readFileSync(path, "utf8")); } catch (_) { return {}; }
}

/** The secret files that exist, as { path: text }. */
function readSecretFiles(paths = KEY_FILES) {
  const out = {};
  for (const p of paths) { try { out[p] = readFileSync(p, "utf8"); } catch (_) { /* not there */ } }
  return out;
}

/** prompt.md's text (Workers bundles it instead; see src/worker.js). */
export const readPrompt = () => readFileSync(fileURLToPath(new URL("./prompt.md", import.meta.url)), "utf8");

/** Node's request as a web Request. The body is only read if the service asks for it. */
function toRequest(req, holder, signal) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const init = { method: req.method, headers, signal };
  if (!BODYLESS.has(req.method)) {
    init.body = new ReadableStream({
      async pull(controller) {
        holder.it ??= req[Symbol.asyncIterator]();
        const { value, done } = await holder.it.next();
        if (done) controller.close(); else controller.enqueue(new Uint8Array(value));
      },
      cancel() { /* the server drains what's left (see drain) */ },
    });
    init.duplex = "half";
  }
  return new Request(`http://${req.headers.host || "localhost"}${req.url}`, init);
}

/** Read and drop a body the service didn't read (a refused request), up to `limit` bytes, so the
 *  client sees the answer instead of a reset. Past that, close the connection. */
function drain(req, holder, limit) {
  if (req.readableEnded) return;
  (async () => {
    let left = limit;
    try {
      const it = holder.it || req[Symbol.asyncIterator]();
      for (;;) {
        const { value, done } = await it.next();
        if (done) return;
        left -= value.length;
        if (left < 0) { req.destroy(); return; }
      }
    } catch (_) { /* the client went away */ }
  })();
}

/** Start the server. Returns the http.Server (tests use port 0 for a free one). The answer is
 *  streamed as it's written; a client that goes away aborts `signal` (and so the run). */
export function serve(handle, { port = 8003, host = "127.0.0.1", maxBody = 65536 } = {}) {
  const server = http.createServer(async (req, res) => {
    const holder = { it: null };
    const gone = new AbortController();
    res.on("close", () => { if (!res.writableFinished) gone.abort(); });
    let response;
    try {
      response = await handle(toRequest(req, holder, gone.signal), { socketIp: req.socket.remoteAddress || "", signal: gone.signal });
    } catch (e) {
      response = new Response(JSON.stringify({ error: { code: "bad_request", message: "Bad request." } }),
        { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const headers = {};
    response.headers.forEach((value, name) => { headers[name] = value; });
    const unread = !BODYLESS.has(req.method) && !req.readableEnded;
    if (unread) headers.connection = "close";   // the rest of the body is drained and dropped
    res.writeHead(response.status, headers);
    res.flushHeaders();
    if (response.body) {
      const body = Readable.fromWeb(response.body);
      body.on("error", () => res.destroy());
      res.on("close", () => { if (!res.writableFinished) body.destroy(); });
      body.pipe(res);
    } else res.end();
    if (unread) drain(req, holder, 4 * maxBody);
  });
  server.requestTimeout = 0;   // a run takes minutes; RUN_TIMEOUT bounds it
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  return server.listen(port, host);
}

function main() {
  const env = { ...readDotEnv(), ...process.env };
  const secretFiles = readSecretFiles();
  const cfg = readConfig(env, { runtime: "node", secretFiles });
  if (cfg.problems.length) {
    cfg.problems.forEach((p) => console.error(`Cannot start: ${p}`));
    process.exit(1);
  }
  const host = String(env.HOST || "127.0.0.1").trim();
  if (!cfg.lark.required && !LOCAL_HOSTS.has(host)) {
    console.error(`Cannot start: REQUIRE_LARK_LOGIN is off, so it may only listen on 127.0.0.1 (HOST is ${host}). Turn the login on, or remove HOST.`);
    process.exit(1);
  }
  const stamp = () => new Date(Date.now() + cfg.tzOffsetHours * 3600000).toISOString().replace("T", " ").slice(0, 19);
  const runsDir = fileURLToPath(new URL("./runs/", import.meta.url));
  const record = /^(1|true|yes|on)$/i.test(String(env.RECORD_RUNS || "").trim())
    ? (name, data) => { mkdirSync(runsDir, { recursive: true }); writeFileSync(`${runsDir}${name.replace(/[^\w.-]/g, "_")}.json`, JSON.stringify(data, null, 1)); }
    : null;
  const handle = createService(env, { prompt: readPrompt(), runtime: "node", secretFiles, record, log: (line) => console.log(`[${stamp()}] ${line}`) });
  const port = Number(env.PORT || process.argv[2] || 8003);
  const server = serve(handle, { port, host });
  server.on("listening", () => {
    console.log(`price-research ${VERSION} listening on http://${host}:${port}  (Ctrl+C to stop)`);
    console.log(`  models=${cfg.models.join(",")} default=${cfg.defaultModel}  origins=${[...cfg.origins].sort().join(",")}`);
    console.log(`  Lark login ${cfg.lark.required ? "required" : "OFF (this computer only)"}  max per run US$${cfg.maxRunUsd}`);
    console.log(`  Anthropic key: found in ${cfg.keySource} (${cfg.apiKey.length} characters)`);
    if (record) console.log(`  Recording each run's requests and answers in ${runsDir} (RECORD_RUNS)`);
  });
  server.on("error", (e) => { console.error(`Couldn't start: ${e.message}`); process.exit(1); });
  const stop = () => {
    console.log("Shutting down…");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
