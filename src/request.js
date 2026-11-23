/*
 * What the service sends to Claude (pure: no network). The page sends a short research request;
 * this module checks it and turns it into the Messages API body.
 *
 *   readInput(raw)            the page's JSON, checked and tidied (throws InputError)
 *   buildBody(input, opts)    the request body: model, effort, the three tools, system, messages
 *   userText(input, today)    the user turn: the request in plain words (the system prompt never
 *                             changes, so it stays cached between runs)
 *
 * Tools (identical for the whole run: a paused turn must be continued with the same tools)
 *   web_search_20260318   search, filtered in code ("dynamic filtering"), localised to the market
 *   web_fetch_20260318    open pages found by search (it can't open a URL nobody has seen)
 *   submit_report         a strict client tool: the report. Not output_config.format, because web
 *                         search citations are always on and the API refuses citations with it.
 */

export const MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5", fallback: true },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", fallback: true },
  "claude-haiku-5-5": { label: "Claude Haiku 5.5", fallback: false },   // Haiku has no server-side refusal fallback
};
export const DEFAULT_MODEL = "claude-opus-5-5";

/* Per depth: effort, the most searches and page reads per request, and how many times a paused
   turn may be continued. "Find suppliers too" adds SUPPLIER_EXTRA. */
export const DEPTHS = {
  quick: { label: "Quick", effort: "low", searches: 3, fetches: 2, continuations: 1 },
  standard: { label: "Standard", effort: "medium", searches: 6, fetches: 4, continuations: 2 },
  thorough: { label: "Thorough", effort: "high", searches: 10, fetches: 8, continuations: 4 },
};
export const SUPPLIER_EXTRA = { searches: 2, fetches: 2 };

export const MARKETS = {
  PH: { name: "the Philippines", currency: "PHP", timezone: "Asia/Manila", vat: 0.12 },
  SG: { name: "Singapore", currency: "SGD", timezone: "Asia/Singapore", vat: 0 },
  MY: { name: "Malaysia", currency: "MYR", timezone: "Asia/Kuala_Lumpur", vat: 0 },
  US: { name: "the United States", currency: "USD", timezone: "America/New_York", vat: 0 },
  GB: { name: "the United Kingdom", currency: "GBP", timezone: "Europe/London", vat: 0 },
};

// Suppliers' cost categories (appraisal/internal/pipeline/config/categories.csv), plus Other.
export const CATEGORIES = ["Manpower", "Talent/KOL", "Equipment & Furniture", "Stage Technicals", "Fabrication & Collateral",
  "Operations & Logistics", "Consumables & Supplies", "Food & Beverage", "Service", "ISP", "Venue Rental", "Permits & Licenses",
  "Hospitality & Accommodation", "Other"];
export const SELLER_TYPES = ["official_store", "retailer", "marketplace_seller", "distributor", "manufacturer", "service_provider",
  "rental", "classified", "other"];
export const SUPPLIER_TYPES = ["manufacturer", "distributor", "retailer", "service_provider", "rental", "marketplace_seller", "other"];
export const CURRENCIES = ["PHP", "USD", "SGD", "MYR", "GBP", "OTHER"];

export const LIMITS = { name: 200, details: 1000, unit: 40, city: 80, sites: 20, quantity: 10000000 };

export class InputError extends Error {}

const text = (v, max) => String(v === undefined || v === null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

/** Web addresses for the "only these sites" / "skip these sites" lists: plain ASCII host names
 *  (paths dropped: web fetch matches whole domains only). Returns { list, rejected }. */
export function cleanDomains(items) {
  const list = [], rejected = [];
  for (const raw of Array.isArray(items) ? items : String(items || "").split(/[\s,;]+/)) {
    const s = String(raw || "").trim();
    if (!s) continue;
    const host = s.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !/^\d+(\.\d+)+$/.test(host) && !host.split(".").some((p) => p.startsWith("-") || p.endsWith("-"))) {
      if (!list.includes(host)) list.push(host);
    } else rejected.push(s);
  }
  return { list, rejected };
}

/** The page's request, checked. Throws InputError with a sentence the page can show. */
export function readInput(raw = {}, { models = Object.keys(MODELS), defaultModel = DEFAULT_MODEL } = {}) {
  if (!raw || typeof raw !== "object") throw new InputError("The request couldn't be read.");
  const kind = raw.kind === "service" ? "service" : "item";
  const name = text(raw.name, LIMITS.name);
  if (name.length < 2) throw new InputError(`Type the ${kind} you want priced.`);
  const quantity = Number(raw.quantity);
  const market = MARKETS[String(raw.market || "PH").toUpperCase()] ? String(raw.market || "PH").toUpperCase() : null;
  if (!market) throw new InputError("Pick a market from the list.");
  const depth = DEPTHS[raw.depth] ? raw.depth : "standard";
  const model = raw.model ? String(raw.model) : defaultModel;
  if (!models.includes(model) || !MODELS[model]) throw new InputError("That model isn't available on this service.");
  const sites = raw.sites && typeof raw.sites === "object" ? raw.sites : {};
  const mode = ["only", "skip"].includes(sites.mode) ? sites.mode : "none";
  const domains = mode === "none" ? { list: [], rejected: [] } : cleanDomains(sites.list);
  if (domains.rejected.length) throw new InputError(`“${domains.rejected[0].slice(0, 60)}” isn't a web address. Use names like lazada.com.ph.`);
  if (domains.list.length > LIMITS.sites) throw new InputError(`List at most ${LIMITS.sites} sites.`);
  if (mode === "only" && !domains.list.length) throw new InputError("Add at least one site to search, or choose “Any site”.");
  return {
    kind,
    name,
    details: text(raw.details, LIMITS.details),
    quantity: Number.isFinite(quantity) && quantity > 0 ? Math.min(quantity, LIMITS.quantity) : 1,
    unit: text(raw.unit, LIMITS.unit) || (kind === "service" ? "service" : "piece"),
    market,
    city: text(raw.city, LIMITS.city),
    condition: kind === "item" && raw.condition === "any" ? "any" : "new",
    depth,
    suppliers: raw.suppliers !== false,
    model,
    sites: { mode: domains.list.length ? mode : "none", list: domains.list },
  };
}

// ---- the report tool ----------------------------------------------------------------------
const s = (description) => ({ type: "string", description });
const n = (description) => ({ type: "number", description });
const e = (values, description) => ({ type: "string", enum: values, description });
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const list = (items, description) => ({ type: "array", items, description });

/* Strict schema rules: every key required (no optional parameters), no union types, no number or
   length limits, additionalProperties false on every object. tests/request.test.mjs checks them. */
export const REPORT_SCHEMA = obj({
  interpreted: s("What exactly you priced, in one short line (brand, model or spec, size)."),
  category: e(CATEGORIES, "The cost category this belongs to."),
  unit: s("The unit every unit price is for, for example: piece, pack of 4, day, sqm per day, pax."),
  summary: s("Two or three plain sentences: the typical price, the spread and what drives it."),
  listings: list(obj({
    url: s("The listing's page, copied exactly from a search result or a page you opened."),
    title: s("The product or package name as the page shows it."),
    seller: s("The shop, brand or company selling it."),
    seller_type: e(SELLER_TYPES, "What kind of seller this is."),
    price_text: s("The price exactly as the page writes it, for example ₱1,299.00."),
    price: n("The price a buyer pays today, as a plain number in the listing's currency."),
    regular_price: n("The crossed-out regular price when there is a sale, else 0."),
    currency: e(CURRENCIES, "The price's currency."),
    units_in_price: n("How many of the requested unit the price buys (4 for a 4-pack priced per piece). 1 when it matches, 0 when it can't be converted."),
    price_basis: s("What the price is for, as the page says: per piece, per box of 12, per day, per sqm per day."),
    vat: e(["included", "excluded", "not_stated"], "Whether the price includes VAT."),
    condition: e(["new", "used", "refurbished", "not_applicable"], "The item's condition (not_applicable for services)."),
    match: e(["exact", "close", "substitute"], "How well it matches the request."),
    availability: e(["in_stock", "out_of_stock", "made_to_order", "unknown"], "Whether it can be bought now."),
    page_date: s("When the page or offer is dated (YYYY-MM-DD or YYYY-MM), else empty."),
    notes: s("Short notes: what's included, minimum order, quantity tiers, shipping, promo end date. Empty if none."),
  }), "The offers found, one per seller and offer."),
  suppliers: list(obj({
    name: s("The business's name."),
    type: e(SUPPLIER_TYPES, "What kind of supplier this is."),
    website: s("Its own website or official page, else empty."),
    phone: s("A phone number shown on its own site or official page, else empty."),
    email: s("An email shown on its own site or official page, else empty."),
    city: s("Where it is based, else empty."),
    offers: s("What it sells or provides that fits the request, in a few words."),
    source_url: s("The page where you saw these details."),
  }), "Businesses procurement could contact for this."),
  assumptions: list({ type: "string" }, "Assumptions you made about the request, short sentences."),
  warnings: list({ type: "string" }, "Anything the reader should know: thin results, unreadable sites, old pages, odd prices."),
});

export const REPORT_TOOL = {
  name: "submit_report",
  description: "Hand in the price research report. Call it exactly once, when the research is done (or when told to stop). Nothing written outside it is shown to anyone.",
  strict: true,
  input_schema: REPORT_SCHEMA,
};

export const WRAP_UP = "Stop researching now. Call submit_report with what you have found so far, and say in warnings that the research was cut short.";
export const NUDGE = "Please call submit_report now with your findings. If you found nothing usable, submit empty lists and explain why in warnings.";

/** The tools for this request (identical for every request of one run). */
export function buildTools(input) {
  const d = DEPTHS[input.depth];
  const extra = input.suppliers ? SUPPLIER_EXTRA : { searches: 0, fetches: 0 };
  const m = MARKETS[input.market];
  const where = { type: "approximate", country: input.market, timezone: m.timezone };
  if (input.city) where.city = input.city;
  const search = { type: "web_search_20260318", name: "web_search", max_uses: d.searches + extra.searches, user_location: where };
  const fetch = { type: "web_fetch_20260318", name: "web_fetch", max_uses: d.fetches + extra.fetches, max_content_tokens: 6000 };
  if (input.sites.mode === "only") { search.allowed_domains = [...input.sites.list]; fetch.allowed_domains = [...input.sites.list]; }
  if (input.sites.mode === "skip") { search.blocked_domains = [...input.sites.list]; fetch.blocked_domains = [...input.sites.list]; }
  return [search, fetch, REPORT_TOOL];
}

/** The request body. `messages` is the run's whole conversation so far. */
export function buildBody(input, { system, messages, tools = buildTools(input), fallback = true, container = null, maxTokens = 64000 }) {
  const body = {
    model: input.model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system }],
    messages,
    tools,
    tool_choice: { type: "auto" },
    output_config: { effort: DEPTHS[input.depth].effort },
    cache_control: { type: "ephemeral" },
  };
  if (fallback && MODELS[input.model].fallback) body.fallbacks = "default";
  if (container) body.container = container;
  return body;
}

/** The user turn: the request in plain words. */
export function userText(input, today) {
  const m = MARKETS[input.market];
  const d = DEPTHS[input.depth];
  const extra = input.suppliers ? SUPPLIER_EXTRA : { searches: 0, fetches: 0 };
  const thing = input.kind === "service" ? "Service" : "Item";
  const lines = [
    `Today's date: ${today}.`,
    "",
    `Research the current market price of this ${input.kind} for Mineski's procurement team.`,
    "",
    `${thing}: ${input.name}`,
    `Details: ${input.details || "none given"}`,
    `Quantity needed: ${input.quantity} (unit: ${input.unit})`,
    `Market: ${m.name}, prices in ${m.currency}.${input.city ? ` The buyer is in ${input.city}.` : ""}`,
  ];
  if (input.kind === "item") lines.push(`Condition: ${input.condition === "any" ? "new or used" : "new only"}`);
  lines.push(`Depth: ${d.label.toLowerCase()}. You have up to ${d.searches + extra.searches} web searches and ${d.fetches + extra.fetches} page reads.`);
  lines.push(input.suppliers ? "Suppliers: also list 3 to 6 suppliers procurement could contact." : "Suppliers: not needed; leave the suppliers list empty unless a seller is clearly worth contacting.");
  if (input.sites.mode === "only") lines.push(`Only use these sites: ${input.sites.list.join(", ")}`);
  if (input.sites.mode === "skip") lines.push(`Don't use these sites: ${input.sites.list.join(", ")}`);
  lines.push("", "When you're done, call submit_report.");
  return lines.join("\n");
}
