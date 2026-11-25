// Past purchase requests (pos.js) and the reference for Claude (costings.js), with Lark faked and
// MADE-UP records. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { cellText, cellList, cellNumber, poLines, findPOs, PO_FIELDS } from "../src/pos.js";
import { cleanLine, referenceText, poListings, costingsReport } from "../src/costings.js";
import { readInput, userText } from "../src/request.js";

const rec = (fields) => ({ record_id: "rec1", fields });
const CHAIRS = rec({
  "Request No.": [{ text: "PR-0001", type: "text" }], "Status": "Approved", "Project Code": "P9001", "Project Name": [{ text: "Example Cup", type: "text" }],
  "Particulars_Item": [{ text: "Monoblock chair, white", type: "text" }], "Particulars_Quantity": 300, "Particulars_Unit Price": 270,
  "Particulars_Unit Price-Currency": "PHP", "Particulars_Price": 81000, "Supplier Details_Supplier Name": [{ text: "Example Plastics Inc.", type: "text" }],
  "Submitted at": Date.UTC(2026, 8, 1), "Completed at": Date.UTC(2026, 8, 3),
});

test("Lark cells read as text, lists and numbers", () => {
  assert.equal(cellText([{ text: "a", type: "text" }, { text: "b", type: "text" }]), "a b");
  assert.equal(cellText({ type: 1, value: [{ text: "x" }] }), "x");
  assert.equal(cellText([{ name: "Jane" }]), "Jane");
  assert.deepEqual(cellList({ type: 1, value: ["Chair", "Table"] }), ["Chair", "Table"]);
  assert.deepEqual(cellList("Chair\nTable"), ["Chair", "Table"]);
  assert.equal(cellNumber("₱1,234.50"), 1234.5);
  assert.equal(cellNumber(""), null);
});

test("poLines: one line per matching particular, with dates and PHP", () => {
  const [l] = poLines(CHAIRS, ["monoblock", "chair"]);
  assert.equal(l.request_no, "PR-0001");
  assert.equal(l.supplier, "Example Plastics Inc.");
  assert.equal(l.unit_price, 270);
  assert.equal(l.quantity, 300);
  assert.equal(l.currency, "PHP");
  assert.equal(l.date, "2026-09-03");
  const multi = rec({ ...CHAIRS.fields, "Particulars_Item": { type: 1, value: ["Monoblock chair", "Folding table"] },
    "Particulars_Unit Price": { type: 1, value: [280, 1500] }, "Particulars_Quantity": { type: 1, value: [100, 10] } });
  const lines = poLines(multi, ["chair"]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].unit_price, 280);
  const usd = poLines(rec({ ...CHAIRS.fields, "Particulars_Unit Price-Currency": "USD" }), ["chair"]);
  assert.equal(usd[0].currency, "USD");
  assert.deepEqual(poLines(rec({ ...CHAIRS.fields, "Particulars_Unit Price": null, "Particulars_Price": null }), ["chair"]), []);
});

test("findPOs asks Lark for approved requests, only the allowed columns, as the person", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ code: 0, data: { items: [CHAIRS, rec({ ...CHAIRS.fields, Status: "Rejected" })] } }), { status: 200 });
  };
  const r = await findPOs({ fetch, token: "u-token", baseToken: "BASE", tableId: "TBL", terms: ["monoblock", "chair"] });
  assert.equal(r.available, true);
  assert.equal(r.lines.length, 1, "rejected requests are dropped");
  assert.match(calls[0].url, /\/bitable\/v1\/apps\/BASE\/tables\/TBL\/records\/search\?page_size=60$/);
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "Bearer u-token");
  assert.deepEqual(calls[0].body.field_names, PO_FIELDS);
  assert.ok(!PO_FIELDS.some((f) => /Account|Bank|Address/.test(f)), "never the bank details");
  assert.deepEqual(calls[0].body.filter.conditions.map((c) => `${c.field_name} ${c.operator} ${c.value[0]}`),
    ["Status is Approved", "Particulars_Item contains monoblock", "Particulars_Item contains chair"]);
});

test("findPOs: a refused filter is tried once more without the status; failures and no login are 'not available'", async () => {
  let n = 0;
  const once = async () => (n++ === 0
    ? new Response(JSON.stringify({ code: 1254018, msg: "InvalidFilter" }), { status: 400 })
    : new Response(JSON.stringify({ code: 0, data: { items: [CHAIRS] } }), { status: 200 }));
  const logs = [];
  const r = await findPOs({ fetch: once, token: "t", baseToken: "B", tableId: "T", terms: ["chair"], log: (l) => logs.push(l) });
  assert.equal(r.lines.length, 1);
  const down = await findPOs({ fetch: async () => { throw new Error("offline"); }, token: "t", baseToken: "B", tableId: "T", terms: ["chair"], log: (l) => logs.push(l) });
  assert.equal(down.available, false);
  assert.ok(logs.some((l) => /pos search failed: offline/.test(l)));
  assert.equal((await findPOs({ token: "", baseToken: "B", tableId: "T", terms: ["chair"] })).available, false);
});

test("the reference for Claude: paid and budgeted prices and suppliers, no client names", () => {
  const input = readInput({ name: "Monoblock chair", unit: "piece" });
  const pos = poLines(CHAIRS, ["chair"]);
  const lines = [cleanLine({ project_code: "P9", project_name: "Cup", client: "Secret Client", item: "Monoblock chair", particular: "Chairs",
    qty: 100, frq: 1, per: "pcs", unit_price_php: 300, markup: 0.2, client_price_php: 36000, price_date: "2026-05-01", in_final: 1 })];
  const text = referenceText({ lines, pos }, input);
  assert.match(text, /Paid PHP 270\.00 per unit for 300 to Example Plastics Inc\. \(Sep 2026\)/);
  assert.match(text, /Budgeted on 1 past CE line: middle PHP 300\.00 per piece/);
  assert.match(text, /Mineski has bought this from: Example Plastics Inc\./);
  assert.ok(!/Secret Client/.test(text), "client names stay out");
  assert.equal(referenceText({ lines: [], pos: [] }, input), "");
  assert.match(userText(input, "2026-11-25", text), /Mineski's own records for this[\s\S]*When you're done, call submit_report\./);
});

test("purchase requests count only for piece-like units; in a past-costings report they come first", () => {
  const pos = poLines(CHAIRS, ["chair"]);
  assert.equal(poListings(pos, readInput({ name: "Chair", unit: "piece" }))[0].comparable_price, 270);
  assert.equal(poListings(pos, readInput({ name: "LED wall", unit: "sqm per day" }))[0].comparable_price, null);
  const r = costingsReport({ input: readInput({ source: "costings", name: "Monoblock chair", unit: "piece" }),
    costings: { available: true, terms: ["monoblock", "chair"], lines: [], pos, pos_available: true },
    id: "r", createdAt: "2026-11-25T00:00:00Z", service: { name: "p", version: "x", runtime: "node" }, startedAt: Date.now() });
  assert.equal(r.listings[0].verification.via, "po");
  assert.equal(r.listings[0].seller, "Example Plastics Inc.");
  assert.match(r.summary, /^1 approved purchase request line mention monoblock, chair\.$/);
});
