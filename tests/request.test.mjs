// What goes to Claude: the request checks, the tools per depth, the body, the strict schema. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readInput, guessRequest, modelFor, buildTools, buildBody, userText, caps, REPORT_SCHEMA, REPORT_TOOL, DEPTHS, InputError } from "../src/request.js";

const base = readInput({ name: "Monoblock chair", details: "white", depth: "standard" });

test("readInput tidies a good request and fills defaults: Quick, the Philippines, the depth's model", () => {
  const i = readInput({ name: "  Monoblock   chair ", quantity: 200, market: "SG", city: "Manila", condition: "new", suppliers: false });
  assert.deepEqual(i, { name: "Monoblock chair", details: "", depth: "quick", model: "claude-haiku-5-5", kind: "item", unit: "", search_id: "" });
  assert.equal(readInput({ name: "Chair", depth: "check" }).depth, "quick", "the old Quick web check is Quick");
  assert.equal(readInput({ name: "Chair", depth: "standard" }).model, "claude-sonnet-5-5");
  assert.equal(readInput({ name: "Chair", depth: "thorough" }).model, "claude-opus-5-5");
  assert.equal(readInput({ name: "Chair", search_id: "psmh3x9k2a1b" }).search_id, "psmh3x9k2a1b");
});

test("readInput refuses what can't be researched", () => {
  assert.throws(() => readInput({ name: "x" }), InputError);
  assert.throws(() => readInput(null), InputError);
  assert.throws(() => readInput({ name: "chair", search_id: "../../etc" }), /saved search/);
});

test("the depth's model, unless the service doesn't offer it", () => {
  assert.equal(modelFor("quick"), "claude-haiku-5-5");
  assert.equal(modelFor("quick", ["claude-opus-5-5", "claude-sonnet-5-5"], "claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(modelFor("thorough", ["claude-sonnet-5-5"], "claude-opus-5-5"), "claude-sonnet-5-5");
  assert.equal(readInput({ name: "Chair" }, { models: ["claude-sonnet-5-5"], defaultModel: "claude-sonnet-5-5" }).model, "claude-sonnet-5-5");
});

test("a first guess at item or service, and the unit when it's written", () => {
  assert.deepEqual(guessRequest("Monoblock chair"), { kind: "item", unit: "" });
  assert.deepEqual(guessRequest("Event emcee", "4 hours"), { kind: "service", unit: "" });
  assert.deepEqual(guessRequest("LED wall rental", "P10, per sqm per day"), { kind: "item", unit: "sqm per day" });
  assert.deepEqual(guessRequest("Ushers", "per head"), { kind: "service", unit: "pax" });
  assert.deepEqual(guessRequest("Chairs", "price/pcs"), { kind: "item", unit: "piece" });
  assert.equal(readInput({ name: "Tarpaulin printing" }).kind, "service");
  assert.equal(readInput({ name: "Chair", kind: "service", unit: "day" }).unit, "day", "hints are kept");
});

test("the tools follow the depth; Quick is Haiku's plain tools with marketplaces skipped", () => {
  for (const [depth, d] of Object.entries(DEPTHS)) {
    const input = readInput({ name: "Chair", depth });
    const [search, fetch, report] = buildTools(input);
    const plain = input.model === "claude-haiku-5-5";
    assert.equal(search.type, plain ? "web_search_20250305" : "web_search_20260318");
    assert.equal(fetch.type, plain ? "web_fetch_20250910" : "web_fetch_20260318");
    assert.equal(search.max_uses, d.searches);
    assert.equal(fetch.max_uses, d.fetches);
    assert.equal(fetch.max_content_tokens, d.contentTokens || 6000);
    assert.deepEqual(search.user_location, { type: "approximate", country: "PH", timezone: "Asia/Manila" });
    assert.equal(report, REPORT_TOOL);
    assert.equal(!!search.blocked_domains, !!d.focused);
    assert.deepEqual(caps(input), { searches: d.searches, fetches: d.fetches, continuations: d.continuations });
  }
  const [qs, qf] = buildTools(readInput({ name: "Chair" }));
  assert.ok(qs.blocked_domains.includes("lazada.com.ph") && qf.blocked_domains.includes("shopee.ph"));
  assert.equal(qf.max_content_tokens, 4000);
  assert.equal(DEPTHS.quick.maxUsd, 0.2);
});

test("the body: effort per depth, fallbacks for Opus and Sonnet only, caching, container", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "x" }] }];
  const b = buildBody(base, { system: "SYSTEM", messages });
  assert.equal(b.model, "claude-sonnet-5-5");
  assert.equal(b.output_config.effort, "medium");
  assert.equal(b.fallbacks, "default");
  assert.deepEqual(b.cache_control, { type: "ephemeral" });
  assert.deepEqual(b.system, [{ type: "text", text: "SYSTEM" }]);
  assert.deepEqual(b.tool_choice, { type: "auto" });
  assert.equal(b.thinking, undefined, "thinking stays adaptive (the default)");
  assert.equal(b.container, undefined);
  const thorough = readInput({ name: "Chair", depth: "thorough" });
  assert.equal(buildBody(thorough, { system: "S", messages }).output_config.effort, "high");
  assert.equal(buildBody(thorough, { system: "S", messages }).fallbacks, "default");
  assert.equal(buildBody(readInput({ name: "Chair" }), { system: "S", messages }).fallbacks, undefined, "Haiku has no fallback");
  assert.equal(buildBody(base, { system: "S", messages, fallback: false }).fallbacks, undefined);
  assert.equal(buildBody(base, { system: "S", messages, container: "cont_1" }).container, "cont_1");
});

test("the report schema meets the strict-tool rules, and asks for the kind", () => {
  let optional = 0, unions = 0, objects = 0;
  const walk = (node, path) => {
    assert.ok(node && typeof node === "object", `${path} is a schema`);
    for (const bad of ["minimum", "maximum", "minLength", "maxLength", "multipleOf", "oneOf", "not", "pattern"]) assert.ok(!(bad in node), `${path} uses ${bad}`);
    if (Array.isArray(node.type) || node.anyOf) unions++;
    if (node.type === "object") {
      objects++;
      assert.equal(node.additionalProperties, false, `${path} has additionalProperties false`);
      const keys = Object.keys(node.properties);
      optional += keys.filter((k) => !node.required.includes(k)).length;
      for (const k of keys) walk(node.properties[k], `${path}.${k}`);
    } else if (node.type === "array") {
      assert.ok(!("minItems" in node) || node.minItems <= 1, `${path} minItems is 0 or 1`);
      walk(node.items, `${path}[]`);
    } else {
      assert.ok(["string", "number", "integer", "boolean"].includes(node.type), `${path} has a plain type`);
    }
  };
  walk(REPORT_SCHEMA, "report");
  assert.equal(optional, 0, "no optional parameters (the limit is 24 per request)");
  assert.equal(unions, 0, "no union types (the limit is 16 per request)");
  assert.equal(objects, 3);
  assert.deepEqual(REPORT_SCHEMA.properties.kind.enum, ["item", "service"]);
  assert.equal(REPORT_TOOL.strict, true);
});

test("the user turn says what to research, that Claude decides the kind and unit, the market, and today's date", () => {
  const t = userText(base, "2026-11-27");
  assert.match(t, /Today's date: 2026-11-27/);
  assert.match(t, /What: Monoblock chair\nDetails: white/);
  assert.match(t, /item \(a thing to buy or rent\) or a service/);
  assert.match(t, /Choose the unit it's usually priced in/);
  assert.match(t, /the Philippines, prices in PHP\. Any seller is fine if it sells in the Philippines or ships there\./);
  assert.match(t, /New or used: both are fine/);
  assert.match(t, /up to 8 web searches and 6 page reads/);
  assert.match(t, /Suppliers: also list 3 to 6 suppliers/);
  assert.doesNotMatch(t, /Quantity|quotation/);
  assert.match(t, /submit_report/);
  const q = userText(readInput({ name: "Chair" }), "2026-11-27");
  assert.match(q, /open the pages of the most useful offers/);
  assert.match(q, /ACE Hardware, Wilcon Depot/);
  assert.match(userText(readInput({ name: "Chair", details: "" }), "2026-11-27"), /Details: none given/);
});
