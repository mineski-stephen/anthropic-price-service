/*
 * What a run cost, from the usage Anthropic reports (pure). Adapted from anthropic-ce's
 * appraise.js PRICES / costUsd, plus the web search fee. Prices in USD (platform.claude.com
 * pricing, Nov 2026). Web fetch and the code that filters results cost only their tokens.
 */

/** USD per million tokens: input, output, cache read, cache write (5-minute). */
export const PRICES = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};
// Claude Haiku 5.5 costs more for prompts over 100,000 tokens.
const HAIKU_LONG = [0.5, 2.5, 0.05, 0.625];
export const SEARCH_USD = 0.01;   // $10 per 1,000 searches

const priceOf = (model) => Object.keys(PRICES).find((m) => String(model || "").startsWith(m));

/** The token cost of one request (null for a model without a known price). */
export function tokenCost(model, u = {}) {
  const key = priceOf(model);
  if (!key) return null;
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const [i, o, cr, cw] = key === "claude-haiku-5-5" && prompt > 100000 ? HAIKU_LONG : PRICES[key];
  return ((u.input_tokens || 0) * i + (u.output_tokens || 0) * o + (u.cache_read_input_tokens || 0) * cr
    + (u.cache_creation_input_tokens || 0) * cw) / 1e6;
}

export const searchesIn = (u = {}) => Number((u.server_tool_use && u.server_tool_use.web_search_requests) || 0);
export const fetchesIn = (u = {}) => Number((u.server_tool_use && u.server_tool_use.web_fetch_requests) || 0);

const round = (v) => Math.round(v * 10000) / 10000;

/** A running total over a run's requests. add(model, usage) after each one. */
export function createTally() {
  const t = {
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 },
    cost: { tokens: 0, searches: 0, total: 0 },
    priced: true,
    add(model, u = {}) {
      for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) t.usage[k] += Number(u[k] || 0);
      t.usage.web_search_requests += searchesIn(u);
      t.usage.web_fetch_requests += fetchesIn(u);
      const tc = tokenCost(model, u);
      if (tc === null) t.priced = false;
      t.cost.tokens = round(t.cost.tokens + (tc || 0));
      t.cost.searches = round(t.usage.web_search_requests * SEARCH_USD);
      t.cost.total = round(t.cost.tokens + t.cost.searches);
      return t;
    },
  };
  return t;
}
