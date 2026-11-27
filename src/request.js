/*
 * What the service sends to Claude (pure: no network). The page sends a short research request;
 * this module checks it and turns it into the Messages API body.
 *
 *   readInput(raw)            the page's JSON ({ name, details, depth, search_id }), checked and tidied
 *                             (throws InputError). Whether it's an item or a service, and its unit,
 *                             are Claude's call (the report's kind and unit); guessRequest() only
 *                             guesses them first, for matching Mineski's own past prices.
 *   buildBody(input, opts)    the request body: model, effort, the three tools, system, messages
 *   userText(input, today)    the user turn: the request in plain words (the system prompt never
 *                             changes, so it stays cached between runs)
 *
 * Every search is for the Philippines, priced in pesos, new or used, with suppliers. The depth picks
 * the model: Quick is Claude Haiku 5.5 (the old "Quick web check"), Standard Sonnet 5.5, Thorough
 * Opus 5.5.
 *
 * Tools (identical for the whole run: a paused turn must be continued with the same tools)
 *   web_search_20260318   search, filtered in code ("dynamic filtering"), localised to the Philippines
 *   web_fetch_20260318    open pages found by search (it can't open a URL nobody has seen)
 *                         Claude Haiku 5.5 has no dynamic filtering: it gets web_search_20250305 and
 *                         web_fetch_20250910, the plain versions.
 *   submit_report         a strict client tool: the report. Not output_config.format, because web
 *                         search citations are always on and the API refuses citations with it.
 */

export const MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5", fallback: true, filtering: true },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", fallback: true, filtering: true },
  // Haiku has no server-side refusal fallback and no dynamic filtering (the plain search tools).
  "claude-haiku-5-5": { label: "Claude Haiku 5.5", fallback: false, filtering: false },
};
export const DEFAULT_MODEL = "claude-opus-5-5";

/* Per depth: the model, effort, the most searches and page reads per request (suppliers included),
   and how many times a paused turn may be continued. contentTokens: how much of each opened page
   Claude reads. maxUsd: this depth's own spending cap (below MAX_RUN_USD).
   Quick is the old Quick web check on Haiku: few searches, but the sellers' pages opened, so prices
   are confirmed on the page; marketplaces skipped and price-listing retailers suggested. */
export const DEPTHS = {
  quick: { label: "Quick", model: "claude-haiku-5-5", effort: "medium", searches: 4, fetches: 6, continuations: 1, contentTokens: 4000, maxUsd: 0.2, focused: true },
  standard: { label: "Standard", model: "claude-sonnet-5-5", effort: "medium", searches: 8, fetches: 6, continuations: 2 },
  thorough: { label: "Thorough", model: "claude-opus-5-5", effort: "high", searches: 12, fetches: 10, continuations: 4 },
};
export const DEFAULT_DEPTH = "quick";
/* Skipped by focused checks: marketplaces and social sites refuse page readers or list one-off
   sellers, so their prices can't be confirmed. */
export const SKIP_SITES = ["lazada.com.ph", "shopee.ph", "carousell.ph", "facebook.com", "tiktok.com", "instagram.com"];
/* Philippine retailers that publish prices on their own pages (named for the search, not enforced). */
export const PH_RETAILERS = "ACE Hardware, Wilcon Depot, Handyman, CW Home Depot, AllHome, Office Warehouse, National Book Store, PC Express, DynaQuest, Villman, Abenson, Anson's, SM Appliance";

/** The one market: the Philippines, in pesos (12% VAT). */
export const MARKET = { country: "PH", name: "the Philippines", currency: "PHP", timezone: "Asia/Manila", vat: 0.12 };

// Suppliers' cost categories (appraisal/internal/pipeline/config/categories.csv), plus Other.
export const CATEGORIES = ["Manpower", "Talent/KOL", "Equipment & Furniture", "Stage Technicals", "Fabrication & Collateral",
  "Operations & Logistics", "Consumables & Supplies", "Food & Beverage", "Service", "ISP", "Venue Rental", "Permits & Licenses",
  "Hospitality & Accommodation", "Other"];
export const SELLER_TYPES = ["official_store", "retailer", "marketplace_seller", "distributor", "manufacturer", "service_provider",
  "rental", "classified", "other"];
export const SUPPLIER_TYPES = ["manufacturer", "distributor", "retailer", "service_provider", "rental", "marketplace_seller", "other"];
export const CURRENCIES = ["PHP", "USD", "SGD", "MYR", "GBP", "OTHER"];

export const LIMITS = { name: 200, details: 1000, unit: 40 };

export class InputError extends Error {}

const text = (v, max) => String(v === undefined || v === null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

/* Words that mark a service (someone's work) rather than a thing to buy or rent. Only a first
   guess, for matching past CE lines before the research; Claude's report says what it really is. */
const SERVICE_WORDS = /\b(services?|emcees?|hosts?|hosting|photograph(er|ers|y)|videograph(er|ers|y)|video (coverage|production|editing)|editing|printing|catering|caterers?|transport(ation)?|trucking|deliver(y|ies)|shuttles?|logistics|installation|ingress|egress|manpower|staff(ing)?|crew|ushers?|usherettes?|marshals?|security|guards?|technicians?|operators?|cleaning|janitorial|designers?|livestream(ing)?|streaming|broadcast(ing)?|consult(ing|ancy|ants?)|training|workshops?|permits?|insurance|repairs?|maintenance|labou?r|talents?|performers?|dancers?|bands?|djs?|make-?up|hair|styling|accommodation|translation|interpret(er|ers|ation)|courier)\b/i;
/* A unit written in the request: "per sqm per day", "/day", "per pax". */
const UNIT_WRITTEN = /(?:\bper\s+|\/\s*)(sq\.?\s*m(?:eters?)?(?:\s+per\s+day)?|sqm(?:\s+per\s+day)?|square\s+meters?|pieces?|pcs?|units?|sets?|packs?|box(?:es)?|pairs?|reams?|rolls?|meters?|kgs?|liters?|days?|hours?|hrs?|nights?|weeks?|months?|events?|shows?|sessions?|pax|persons?|heads?|lots?)\b/i;

/** A first guess at what's being priced: { kind: "item" | "service", unit } ("" when not written). */
export function guessRequest(name, details = "") {
  const all = `${name} ${details}`;
  const u = all.match(UNIT_WRITTEN);
  let unit = u ? u[1].toLowerCase().replace(/\s+/g, " ") : "";
  unit = unit.replace(/^(sq\.? ?m(eters?)?|square meters?)/, "sqm").replace(/^(pcs?|pieces?)$/, "piece").replace(/^hrs?$/, "hour")
    .replace(/^box(es)?$/, "box").replace(/^(persons?|heads?)$/, "pax");
  if (unit !== "pax" && unit !== "box") unit = unit.replace(/s$/, "");
  return { kind: SERVICE_WORDS.test(all) ? "service" : "item", unit };
}

/** The model for a depth: the depth's own, unless the service doesn't offer it. */
export function modelFor(depth, models = Object.keys(MODELS), defaultModel = DEFAULT_MODEL) {
  const want = (DEPTHS[depth] || DEPTHS[DEFAULT_DEPTH]).model;
  return models.includes(want) ? want : models.includes(defaultModel) ? defaultModel : models[0];
}

/** A saved search's id ("ps" and letters): every version of one search shares it. */
export const SEARCH_ID = /^ps[a-z0-9]{6,30}$/;

/** The page's request, checked. Throws InputError with a sentence the page can show.
 *  `kind` and `unit` may be given as hints (tests, other callers); the page sends neither. */
export function readInput(raw = {}, { models = Object.keys(MODELS), defaultModel = DEFAULT_MODEL } = {}) {
  if (!raw || typeof raw !== "object") throw new InputError("The request couldn't be read.");
  const name = text(raw.name, LIMITS.name);
  if (name.length < 2) throw new InputError("Type what you want priced.");
  const details = text(raw.details, LIMITS.details);
  // "check" was the old Quick web check; it is Quick now.
  const depth = raw.depth === "check" ? "quick" : DEPTHS[raw.depth] ? raw.depth : DEFAULT_DEPTH;
  const searchId = String(raw.search_id || "").trim();
  if (searchId && !SEARCH_ID.test(searchId)) throw new InputError("That saved search couldn't be found. Open it again from Saved searches.");
  const guess = guessRequest(name, details);
  return {
    name,
    details,
    depth,
    model: modelFor(depth, models, defaultModel),
    kind: raw.kind === "service" || raw.kind === "item" ? raw.kind : guess.kind,
    unit: text(raw.unit, LIMITS.unit) || guess.unit,
    search_id: searchId,
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
  kind: e(["item", "service"], "item: a thing to buy or rent. service: someone's work (an emcee, printing, transport)."),
  category: e(CATEGORIES, "The cost category this belongs to."),
  unit: s("The unit every unit price is for, as it's usually priced: piece, pack, set, day, hour, event, sqm per day, pax."),
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

/** The searches and page reads a depth allows, and how often a paused turn may go on. */
export const caps = (input) => {
  const d = DEPTHS[input.depth] || DEPTHS[DEFAULT_DEPTH];
  return { searches: d.searches, fetches: d.fetches, continuations: d.continuations };
};

/** The tools for this request (identical for every request of one run). */
export function buildTools(input) {
  const d = DEPTHS[input.depth];
  const where = { type: "approximate", country: MARKET.country, timezone: MARKET.timezone };
  const filtering = MODELS[input.model] ? MODELS[input.model].filtering : true;
  const search = { type: filtering ? "web_search_20260318" : "web_search_20250305", name: "web_search", max_uses: d.searches, user_location: where };
  const fetch = { type: filtering ? "web_fetch_20260318" : "web_fetch_20250910", name: "web_fetch", max_uses: d.fetches, max_content_tokens: d.contentTokens || 6000 };
  if (d.focused) { search.blocked_domains = [...SKIP_SITES]; fetch.blocked_domains = [...SKIP_SITES]; }
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
export function userText(input, today, reference = "") {
  const d = DEPTHS[input.depth];
  const lines = [
    `Today's date: ${today}.`,
    "",
    "Research the current market price of this for Mineski's procurement team.",
    "",
    `What: ${input.name}`,
    `Details: ${input.details || "none given"}`,
    "",
    "- Decide whether it's an item (a thing to buy or rent) or a service (someone's work), and say which in kind. If the words could mean either, price what a buyer most likely means and say so in assumptions.",
    "- Choose the unit it's usually priced in (piece, pack, set, day, hour, event, sqm per day, pax) and give every listing's units_in_price for that unit.",
    `- Market: ${MARKET.name}, prices in ${MARKET.currency}. Any seller is fine if it sells in the Philippines or ships there.`,
    "- New or used: both are fine. Set condition on every listing.",
    `- Depth: ${d.label.toLowerCase()}. You have up to ${d.searches} web searches and ${d.fetches} page reads.`,
  ];
  if (d.focused) {
    lines.push("- Before reporting, open the pages of the most useful offers with web_fetch (up to your page reads), so each price is confirmed on its own page. Report only prices you saw on a page or in a search result.");
    lines.push(`- For things to buy, prefer sellers that publish prices on their own pages, for example: ${PH_RETAILERS}, and brand or distributor stores.`);
  }
  lines.push("- Suppliers: also list 3 to 6 suppliers procurement could contact (the sellers you found count).");
  if (reference) lines.push("", reference);
  lines.push("", "When you're done, call submit_report.");
  return lines.join("\n");
}
