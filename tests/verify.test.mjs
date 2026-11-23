// Checking prices and links against what the research saw. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { normUrl, looseKey, hostOf, collectEvidence, evidenceLines } from "../src/evidence.js";
import { numbersIn, findPrice, verifyListing, verifySupplier, index } from "../src/verify.js";
import { researchBlocks, REPORT, PAGE_TEXT, strip } from "./helpers.mjs";

test("addresses compare without tracking, www., case or a trailing slash", () => {
  assert.equal(normUrl("https://WWW.Ace-Example.ph/products/chair/?utm_source=google&gclid=1"), "ace-example.ph/products/chair");
  assert.equal(normUrl("https://www.lazada.com.ph/products/x-i1.html?spm=a2o4l&color=red"), "lazada.com.ph/products/x-i1.html?color=red");
  assert.equal(normUrl("javascript:alert(1)"), "");
  assert.equal(normUrl("not a url"), "");
  assert.equal(looseKey("a.ph/x?y=1"), "a.ph/x");
  assert.equal(hostOf("https://www.shopee.ph/x"), "shopee.ph");
});

// Prices as pages write them -> the number it must find (null: must not count as that price).
const FORMATS = [
  ["₱1,299.00", 1299], ["PHP 1299", 1299], ["Php1,299", 1299], ["P 899", 899], ["P899.50", 899.5], ["1,299 PHP", 1299],
  ["Price: ₱ 1,299.00", 1299], ["₱１,２９９", 1299], ["₱1,299 - ₱1,599", 1599], ["from ₱12,500 per day", 12500],
  ["SGD 45.90", 45.9], ["RM 120", 120], ["$1,050.00", 1050], ["£19.99", 19.99],
];
for (const [text, value] of FORMATS) {
  test(`finds ${value} in "${text}"`, () => {
    assert.ok(findPrice(text, value), `expected ${value}`);
  });
}

test("a bare number without a currency mark doesn't count as the price", () => {
  assert.equal(findPrice("Model 1299X, 1299 sold", 1299), null);
  assert.equal(findPrice("P3.9 LED panel", 3.9) !== null, true, "P before a number reads as pesos (harmless: it must also equal the price)");
  assert.equal(findPrice("₱1,2999", 1299), null, "a longer number is not the price");
});

test("price_text found verbatim counts even when the mark is far away", () => {
  assert.ok(findPrice("Our rate: 25,000 / day (VAT-ex)", 25000, { priceText: "25,000 / day" }));
});

test("the match nearest the title is used for the excerpt", () => {
  const text = "Desk ₱1,299.00. " + "x".repeat(400) + " Monoblock Chair White ₱1,299.00 per piece";
  const hit = findPrice(text, 1299, { title: "Monoblock Chair" });
  assert.match(hit.excerpt, /Monoblock Chair White ₱1,299\.00/);
});

test("numbersIn marks numbers that sit beside a currency", () => {
  const n = numbersIn("₱1,299.00 and 45 pcs and 899 PHP");
  assert.deepEqual(n.map((x) => [x.value, x.marked]), [[1299, true], [45, false], [899, true]]);
});

test("EVIDENCE lines are read from the code's output", () => {
  const lines = evidenceLines("noise\nEVIDENCE\thttps://a.ph/x\t₱1,000\tnear text\nEVIDENCE | https://b.ph/y | P 50 | other\nEVIDENCE\tnot-a-url\t₱1\n");
  assert.deepEqual(lines, [{ url: "https://a.ph/x", price: "₱1,000", context: "near text" }, { url: "https://b.ph/y", price: "P 50", context: "other" }]);
});

test("collectEvidence gathers searches, pages, page text, code output and citations", () => {
  const ev = collectEvidence(strip(researchBlocks()));
  assert.deepEqual(ev.queries, [{ query: "monoblock chair price philippines", results: 4, error: "" }]);
  const ace = ev.pages.find((p) => p.host === "ace-example.ph");
  assert.equal(ace.fetched, true);
  assert.equal(ace.searched, true);
  assert.equal(ace.text, PAGE_TEXT);
  assert.equal(ace.retrieved_at, "2026-11-23T01:00:00Z");
  const shopee = ev.pages.find((p) => p.host === "shopee.ph");
  assert.equal(shopee.error, "url_not_accessible");
  assert.equal(ev.evidence.length, 1);
  assert.deepEqual(ev.citations.get("shopee.ph/monoblock-chair-i.11.22"), ["Monoblock chair ₱650 · 230 sold"]);
});

test("each listing gets the right status, and the evidence behind it", () => {
  const ix = index(collectEvidence(strip(researchBlocks())));
  const [ace, lazada, shopee, wilcon, madeUp] = REPORT.listings.map((l) => verifyListing(l, ix));
  assert.equal(ace.status, "checked");
  assert.equal(ace.via, "page_text");
  assert.match(ace.evidence[0].excerpt, /1,299\.00/);
  assert.equal(lazada.status, "checked");
  assert.equal(lazada.via, "filter_output");
  assert.equal(shopee.status, "checked");
  assert.equal(shopee.via, "citation");
  assert.equal(wilcon.status, "link");
  assert.equal(wilcon.via, "search_result");
  assert.equal(madeUp.status, "unverified");
  assert.equal(madeUp.via, null);
});

test("a price that isn't on the page it points to is only a link", () => {
  const ix = index(collectEvidence(strip(researchBlocks())));
  const wrong = { ...REPORT.listings[0], price: 999, price_text: "₱999" };
  assert.deepEqual(verifyListing(wrong, ix), { status: "link", via: "page_opened", evidence: [] });
  const regularOnly = { ...REPORT.listings[0], price: 1450, price_text: "₱1,450.00" };
  assert.equal(verifyListing(regularOnly, ix).status, "checked", "the regular price is on the page too");
});

test("supplier contacts count only when they appear on the supplier's own pages", () => {
  const ix = index(collectEvidence(strip(researchBlocks())));
  assert.deepEqual(verifySupplier(REPORT.suppliers[0], ix), { status: "checked", via: "page_text" });
  assert.deepEqual(verifySupplier(REPORT.suppliers[1], ix), { status: "unconfirmed", via: null });
  assert.deepEqual(verifySupplier({ name: "X", phone: "", email: "" }, ix), { status: "none", via: null });
});
