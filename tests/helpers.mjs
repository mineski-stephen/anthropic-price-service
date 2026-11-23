// Test helpers: made-up Messages API answers (no real data), streamed the way Anthropic streams them.

/** The SSE text for a list of events. */
export const sseText = (events) => events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join("");

/** A Response whose body streams `text` in small pieces (so events are split across chunks). */
export function sseResponse(events, { chunk = 37, signal = null } = {}) {
  const bytes = new TextEncoder().encode(sseText(events));
  let at = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (signal && signal.aborted) { controller.error(new DOMException("aborted", "AbortError")); return; }
      if (at >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const half = (s) => [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))];

/** The events that stream a message whose final content is `blocks`. Tool calls stream their input
 *  as JSON deltas (unless `whole: true` on the call, as nested calls may arrive); results arrive whole. */
export function eventsFor(blocks, { stop = "end_turn", model = "claude-opus-5-5", id = "msg_1", container = null,
  usage = { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, out = { output_tokens: 500 }, searches = 0, fetches = 0 } = {}) {
  const ev = [{ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], usage } }];
  blocks.forEach((b, index) => {
    const { whole, ...block } = b;
    if (block.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const part of half(block.text)) ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
      for (const c of block.citations || []) ev.push({ type: "content_block_delta", index, delta: { type: "citations_delta", citation: c } });
    } else if (block.type === "thinking") {
      ev.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      if (block.thinking) ev.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      ev.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else if ((block.type === "server_tool_use" || block.type === "tool_use") && !whole) {
      ev.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      for (const part of half(JSON.stringify(block.input))) ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: part } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: block });
    }
    ev.push({ type: "content_block_stop", index });
  });
  const delta = { stop_reason: stop, stop_sequence: null };
  if (container) delta.container = container;
  ev.push({ type: "message_delta", delta, usage: { ...out, server_tool_use: { web_search_requests: searches, web_fetch_requests: fetches } } });
  ev.push({ type: "message_stop" });
  return ev;
}

// ---- a made-up research answer -------------------------------------------------------------
const CALLER = { type: "code_execution_20260120", tool_id: "srvtoolu_code1" };

export const PAGE_TEXT = "ACE Hardware | Monoblock Chair, White, with backrest. Regular price ₱1,450.00 Sale ₱ 1,299.00 per piece. " +
  "In stock. Bulk orders: call (02) 8123-4567 or email sales@ace-example.ph. Free delivery in Metro Manila.";

export const REPORT = {
  interpreted: "White plastic monoblock chair with backrest",
  category: "Equipment & Furniture",
  unit: "piece",
  summary: "Most local sellers ask about ₱650 to ₱1,300 per chair. Hardware chains cost more than marketplace sellers.",
  listings: [
    { url: "https://www.ace-example.ph/products/monoblock-chair", title: "Monoblock Chair White", seller: "ACE Hardware", seller_type: "retailer",
      price_text: "₱1,299.00", price: 1299, regular_price: 1450, currency: "PHP", units_in_price: 1, price_basis: "per piece",
      vat: "included", condition: "new", match: "exact", availability: "in_stock", page_date: "2026-11", notes: "Sale price." },
    { url: "https://www.lazada.com.ph/products/chair-i123-s456.html?spm=a2o4l.searchlist", title: "Plastic monoblock chair white", seller: "ChairPH",
      seller_type: "marketplace_seller", price_text: "₱899", price: 899, regular_price: 0, currency: "PHP", units_in_price: 1,
      price_basis: "per piece", vat: "not_stated", condition: "new", match: "exact", availability: "in_stock", page_date: "", notes: "" },
    { url: "https://shopee.ph/monoblock-chair-i.11.22", title: "Monoblock chair", seller: "Shop22", seller_type: "marketplace_seller",
      price_text: "₱650", price: 650, regular_price: 0, currency: "PHP", units_in_price: 1, price_basis: "per piece", vat: "not_stated",
      condition: "new", match: "close", availability: "unknown", page_date: "", notes: "" },
    { url: "https://www.wilcon-example.ph/chair", title: "Chair 4-pack", seller: "Wilcon", seller_type: "retailer", price_text: "₱4,800",
      price: 4800, regular_price: 0, currency: "PHP", units_in_price: 4, price_basis: "per pack of 4", vat: "excluded", condition: "new",
      match: "exact", availability: "unknown", page_date: "2026-09-01", notes: "" },
    { url: "https://www.made-up-shop.ph/chair", title: "Invented chair", seller: "Nobody", seller_type: "retailer", price_text: "₱100",
      price: 100, regular_price: 0, currency: "PHP", units_in_price: 1, price_basis: "per piece", vat: "not_stated", condition: "new",
      match: "exact", availability: "unknown", page_date: "", notes: "" },
  ],
  suppliers: [
    { name: "ACE Hardware", type: "retailer", website: "https://www.ace-example.ph", phone: "(02) 8123 4567", email: "sales@ace-example.ph",
      city: "Manila", offers: "Monoblock chairs in bulk", source_url: "https://www.ace-example.ph/products/monoblock-chair" },
    { name: "Furniture Hub", type: "distributor", website: "https://furniturehub-example.ph", phone: "0917 000 1111", email: "",
      city: "Quezon City", offers: "Plastic chairs", source_url: "https://furniturehub-example.ph/contact" },
  ],
  assumptions: ["Priced the standard adult size."],
  warnings: [],
};

/** The final content of a one-request research answer. */
export function researchBlocks(report = REPORT) {
  return [
    { type: "thinking", thinking: "", signature: "sig-abc" },
    { type: "server_tool_use", id: "srvtoolu_code1", name: "code_execution", input: { code: "r = web_search('monoblock chair price philippines')\nprint(r)" } },
    { type: "server_tool_use", id: "srvtoolu_s1", name: "web_search", input: { query: "monoblock chair price philippines" }, caller: CALLER, whole: true },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_s1", caller: CALLER, content: [
      { type: "web_search_result", url: "https://www.ace-example.ph/products/monoblock-chair?utm_source=google", title: "Monoblock Chair | ACE", page_age: "2026-11-01", encrypted_content: "enc-1" },
      { type: "web_search_result", url: "https://www.lazada.com.ph/products/chair-i123-s456.html", title: "Plastic monoblock chair", page_age: "", encrypted_content: "enc-2" },
      { type: "web_search_result", url: "https://shopee.ph/monoblock-chair-i.11.22", title: "Monoblock chair", page_age: "", encrypted_content: "enc-3" },
      { type: "web_search_result", url: "https://www.wilcon-example.ph/chair/", title: "Chairs | Wilcon", page_age: "2026-09-01", encrypted_content: "enc-4" },
    ] },
    { type: "server_tool_use", id: "srvtoolu_f1", name: "web_fetch", input: { url: "https://www.ace-example.ph/products/monoblock-chair" }, caller: CALLER, whole: true },
    { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_f1", caller: CALLER, content: { type: "web_fetch_result",
      url: "https://www.ace-example.ph/products/monoblock-chair", retrieved_at: "2026-11-23T01:00:00Z",
      content: { type: "document", title: "Monoblock Chair", source: { type: "text", media_type: "text/plain", data: PAGE_TEXT } } } },
    { type: "server_tool_use", id: "srvtoolu_f2", name: "web_fetch", input: { url: "https://shopee.ph/monoblock-chair-i.11.22" }, caller: CALLER, whole: true },
    { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_f2", caller: CALLER, content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } },
    { type: "bash_code_execution_tool_result", tool_use_id: "srvtoolu_code1", content: { type: "bash_code_execution_result",
      stdout: "found 4 results\nEVIDENCE\thttps://www.lazada.com.ph/products/chair-i123-s456.html\t₱899\tPlastic monoblock chair white ₱899 1k sold\n", stderr: "", return_code: 0 } },
    { type: "text", text: "Shopee lists one for ₱650.", citations: [
      { type: "web_search_result_location", url: "https://shopee.ph/monoblock-chair-i.11.22", title: "Monoblock chair", encrypted_index: "ei-1", cited_text: "Monoblock chair ₱650 · 230 sold" },
    ] },
    { type: "tool_use", id: "toolu_report1", name: "submit_report", input: report },
  ];
}

export const strip = (blocks) => blocks.map(({ whole, ...b }) => b);
