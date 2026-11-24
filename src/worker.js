/*
 * Cloudflare Workers entry (wrangler.toml: main = "src/worker.js"). Everything the service does is
 * in service.js, the same file Node runs through server.js; this only hands it the prompt and the
 * Worker's settings. prompt.md is bundled as text by the [[rules]] in wrangler.toml.
 *
 * env.DB is anthropic-ce's D1 database "ce-data" (past costings), bound in wrangler.toml.
 * Web research on Opus or Sonnet reads large streams and may need more CPU than the free plan's
 * 10 ms; the Quick web check (Haiku, plain search tools) and past costings are much lighter.
 */
import { createService } from "./service.js";
import prompt from "../prompt.md";

const services = new WeakMap();
export default {
  async fetch(request, env, ctx) {
    let handle = services.get(env);
    if (!handle) {
      handle = createService(env, { prompt, runtime: "cloudflare-workers", db: env.DB || null });
      services.set(env, handle);
    }
    return handle(request, { waitUntil: (p) => ctx.waitUntil(p), signal: request.signal || null });
  },
};
