/*
 * Cloudflare Workers entry (wrangler.toml: main = "src/worker.js"). Everything the service does is
 * in service.js, the same file Node runs through server.js; this only hands it the prompt and the
 * Worker's settings. prompt.md is bundled as text by the [[rules]] in wrangler.toml.
 *
 * Needs Workers Paid: a research stream is several megabytes of search results and page text, more
 * than the free plan's 10 ms of CPU per request.
 */
import { createService } from "./service.js";
import prompt from "../prompt.md";

const services = new WeakMap();
export default {
  async fetch(request, env, ctx) {
    let handle = services.get(env);
    if (!handle) {
      handle = createService(env, { prompt, runtime: "cloudflare-workers" });
      services.set(env, handle);
    }
    return handle(request, { waitUntil: (p) => ctx.waitUntil(p), signal: request.signal || null });
  },
};
