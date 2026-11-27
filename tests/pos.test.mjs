// Past purchase requests (pos.js) and the reference for Claude (costings.js), with Lark faked and
// MADE-UP records. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { cellText, cellList, cellNumber, poLines, findPOs, PO_FIELDS } from "../src/pos.js";
import { cleanLine, referenceText } from "../src/costings.js";
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
  assert.match(text, /Budgeted on 1 past CE line at PHP 300\.00 per piece \(May 2026 to May 2026\): too few to compare with/);
  assert.match(text, /Mineski has bought this from: Example Plastics Inc\./);
  assert.ok(!/Secret Client/.test(text), "client names stay out");
  assert.equal(referenceText({ lines: [], pos: [] }, input), "");
  assert.match(userText(input, "2026-11-25", text), /Mineski's own records for this[\s\S]*When you're done, call submit_report\./);
});

// ---- rentals and lot prices (0.6.0), in the shapes the live Procurement table returned ------------
import { lotUnit, countInText } from "../src/pos.js";
import { markRentals, wantsRental, mismatch } from "../src/costings.js";

const line = (item, qty, price, total) => rec({ "Request No.": [{ text: "PR-0100" }], Status: "Approved",
  "Particulars_Item": [{ text: item }], "Particulars_Quantity": qty, "Particulars_Unit Price": price, "Particulars_Price": total,
  "Supplier Details_Supplier Name": [{ text: "Example Supplies Trading" }], "Completed at": Date.UTC(2026, 10, 1) });

test("a lot priced as one unit is divided by the count in its name, or by the quantity", () => {
  assert.equal(countInText("30 PCS MONOBLOCK CHAIR WITH BLACK COVER (NOVEMBER 4-6, 2026)"), 30);
  assert.equal(countInText("Monoblock chair (3 days)"), 0);
  assert.equal(countInText("1 pc chair"), 0);
  const [a] = poLines(line("30 PCS MONOBLOCK CHAIR WITH BLACK COVER", 1, 2520, 2520), ["monoblock", "chair"]);
  assert.equal(a.unit_price, 84);
  assert.equal(a.quantity, 30);
  assert.match(a.lot, /2,520\.00 for 30, divided/);
  const [b] = poLines(line("Monoblock chair", 25, 1260, 1260), ["monoblock", "chair"]);
  assert.equal(b.unit_price, 50.4);
  assert.match(b.lot, /line total for 25/);
  const [c] = poLines(line("Monoblock chair", 300, 270, 81000), ["monoblock", "chair"]);
  assert.equal(c.unit_price, 270);
  assert.equal(c.lot, "");
  assert.equal(lotUnit({ item: "chair", price: 0, qty: 1 }), null);
});

test("rentals don't count toward a price to buy, nor in Claude's comparison", () => {
  const buy = readInput({ name: "monoblock chair", unit: "piece", quantity: 100 });
  const rent = readInput({ name: "monoblock chair rental", unit: "day" });
  assert.equal(wantsRental(buy), false);
  assert.equal(wantsRental(rent), true);
  assert.equal(mismatch(true, buy), "rental");
  assert.equal(mismatch(false, rent), "purchase");
  assert.equal(mismatch(true, readInput({ kind: "service", name: "emcee", unit: "day" })), "");

  const pos = [line("Rental of Monoblock Chairs (3 days)", 20, 45, 900), line("Monoblock chair, white", 300, 270, 81000)].flatMap((r) => poLines(r, ["monoblock", "chair"]));
  assert.deepEqual(pos.map((p) => p.rental), [true, false]);
  const ce = cleanLine({ item: "Monoblock Chairs", particular: "Black Monoblock Chairs with cover", qty: 150, frq: 3, per: "per day", unit_price_php: 20, in_final: 1 });
  assert.equal(ce.rental, true);
  const costings = markRentals({ available: true, terms: ["monoblock", "chair"], lines: [ce], pos }, buy);

  assert.deepEqual(costings.pos.map((p) => p.mismatch), ["rental", ""]);
  assert.equal(costings.lines[0].mismatch, "rental");
  // Claude says it's a service: a service's day rate isn't a rental, so nothing is left out.
  const asService = markRentals({ lines: [{ ...ce }], pos: pos.map((p) => ({ ...p })) }, { ...buy, kind: "service" });
  assert.ok([...asService.lines, ...asService.pos].every((x) => x.mismatch === ""));

  const ref = referenceText(costings, buy);
  assert.match(ref, /Paid PHP 270\.00 per unit for 300/);
  assert.doesNotMatch(ref, /Paid PHP 45/);
  assert.match(ref, /2 past lines were rentals .*leave them out of any comparison/);
  assert.match(ref, /higher, lower or about the same/);

  const onlyRent = markRentals({ available: true, terms: ["monoblock", "chair"], lines: [ce], pos: [pos[0]] }, buy);
  const ref2 = referenceText(onlyRent, buy);
  assert.match(ref2, /no past purchase price for this that can be compared, so don't compare/);
  assert.doesNotMatch(ref2, /higher, lower or about the same/);
});

test("a hire period, or a rental company as supplier, marks a purchase request as a rental", () => {
  const [a] = poLines(line("30 PCS MONOBLOCK CHAIR WITH BLACK COVER (NOVEMBER 4-6, 2026)", 1, 2520, 2520), ["monoblock", "chair"]);
  assert.equal(a.rental, true);
  const [b] = poLines(rec({ Status: "Approved", "Particulars_Item": [{ text: "25 PCS monoblock chair no cover" }], "Particulars_Quantity": 1,
    "Particulars_Unit Price": 1260, "Supplier Details_Supplier Name": [{ text: "Example Party Needs Rental" }] }), ["monoblock", "chair"]);
  assert.equal(b.rental, true);
  const [c] = poLines(rec({ Status: "Approved", "Particulars_Item": [{ text: "Monoblock chair, white" }], "Particulars_Quantity": 300,
    "Particulars_Unit Price": 270, "Supplier Details_Supplier Name": [{ text: "Example Plastics Trading" }] }), ["monoblock", "chair"]);
  assert.equal(c.rental, false);
});

test("CE budgets are compared only when there are 3 or more that roughly agree", async () => {
  const { budgetAgrees } = await import("../src/costings.js");
  const ce = (v, d = "2026-05-01") => cleanLine({ item: "Monoblock chair", qty: 100, frq: 1, per: "pcs", unit_price_php: v, price_date: d, in_final: 1 });
  const input = readInput({ name: "monoblock chair", unit: "piece" });
  assert.equal(budgetAgrees([ce(280), ce(300), ce(320)]), true);
  assert.equal(budgetAgrees([ce(70), ce(650)]), false);
  assert.equal(budgetAgrees([ce(70), ce(300), ce(650)]), false);
  const agree = referenceText({ lines: [ce(280), ce(300), ce(320)], pos: [] }, input);
  assert.match(agree, /Budgeted on 3 past CE lines: middle PHP 300\.00 per piece/);
  assert.match(agree, /higher, lower or about the same/);
  const spread = referenceText({ lines: [ce(70, "2026-03-01"), ce(650, "2026-09-01")], pos: [] }, input);
  assert.match(spread, /Budgeted on 2 past CE lines from PHP 70\.00 to PHP 650\.00 per piece \(Mar 2026 to Sep 2026\): too few to compare with/);
  assert.match(spread, /nothing comparable/);
  assert.doesNotMatch(spread, /higher, lower or about the same/);
});
