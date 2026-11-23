// What goes to Claude: the request checks, the tools per depth, the body, the strict schema. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readInput, cleanDomains, buildTools, buildBody, userText, REPORT_SCHEMA, REPORT_TOOL, DEPTHS, InputError } from "../src/request.js";

const base = { kind: "item", name: "Monoblock chair", details: "white", quantity: 200, unit: "piece", market: "PH", city: "Manila",
  condition: "new", depth: "standard", suppliers: true, model: "claude-opus-5-5", sites: { mode: "none", list: [] } };

test("readInput tidies a good request and fills defaults", () => {
  const i = readInput({ name: "  Monoblock   chair " });
  assert.equal(i.name, "Monoblock chair");
  assert.equal(i.kind, "item");
  assert.equal(i.market, "PH");
  assert.equal(i.depth, "standard");
  assert.equal(i.model, "claude-opus-5-5");
  assert.equal(i.quantity, 1);
  assert.equal(i.unit, "piece");
  assert.equal(i.suppliers, true);
  assert.deepEqual(i.sites, { mode: "none", list: [] });
});

test("readInput refuses what can't be researched", () => {
  assert.throws(() => readInput({ name: "x" }), InputError);
  assert.throws(() => readInput({ name: "chair", market: "XX" }), /market/);
  assert.throws(() => readInput({ name: "chair", model: "gpt-9" }), /model/);
  assert.throws(() => readInput({ name: "chair", model: "claude-haiku-5-5" }, { models: ["claude-opus-5-5"] }), /model/);
  assert.throws(() => readInput({ name: "chair", sites: { mode: "only", list: [] } }), /at least one site/);
  assert.throws(() => readInput({ name: "chair", sites: { mode: "skip", list: ["not a site"] } }), /isn't a web address/);
});

test("a service is always priced new, whatever the condition says", () => {
  assert.equal(readInput({ kind: "service", name: "LED wall rental", condition: "any" }).condition, "new");
  assert.equal(readInput({ kind: "item", name: "Monitor", condition: "any" }).condition, "any");
});

test("cleanDomains keeps plain ASCII host names only", () => {
  const { list, rejected } = cleanDomains(["https://www.Lazada.com.ph/catalog?q=x", "shopee.ph", "shopee.ph", "192.168.1.1", "аmazon.com", "localhost", "ace.com.ph/"]);
  assert.deepEqual(list, ["lazada.com.ph", "shopee.ph", "ace.com.ph"]);
  assert.deepEqual(rejected, ["192.168.1.1", "аmazon.com", "localhost"]);
  assert.deepEqual(cleanDomains("a.ph, b.ph; c.ph").list, ["a.ph", "b.ph", "c.ph"]);
});

test("the tools follow the depth, the suppliers option, the market and the site lists", () => {
  for (const [depth, d] of Object.entries(DEPTHS)) {
    const [search, fetch, report] = buildTools({ ...base, depth, suppliers: false });
    assert.equal(search.type, "web_search_20260318");
    assert.equal(search.max_uses, d.searches);
    assert.equal(fetch.type, "web_fetch_20260318");
    assert.equal(fetch.max_uses, d.fetches);
    assert.equal(fetch.max_content_tokens, 6000);
    assert.equal(report, REPORT_TOOL);
  }
  const [s, f] = buildTools(base);
  assert.equal(s.max_uses, DEPTHS.standard.searches + 2);
  assert.equal(f.max_uses, DEPTHS.standard.fetches + 2);
  assert.deepEqual(s.user_location, { type: "approximate", country: "PH", timezone: "Asia/Manila", city: "Manila" });
  assert.equal(s.allowed_domains, undefined);
  const only = buildTools({ ...base, sites: { mode: "only", list: ["ace.com.ph"] } });
  assert.deepEqual(only[0].allowed_domains, ["ace.com.ph"]);
  assert.deepEqual(only[1].allowed_domains, ["ace.com.ph"]);
  assert.equal(only[0].blocked_domains, undefined);
  const skip = buildTools({ ...base, sites: { mode: "skip", list: ["shopee.ph"] } });
  assert.deepEqual(skip[0].blocked_domains, ["shopee.ph"]);
  assert.equal(skip[0].allowed_domains, undefined);
});

test("the body: effort per depth, fallbacks for Opus and Sonnet only, caching, container", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "x" }] }];
  const b = buildBody(base, { system: "SYSTEM", messages });
  assert.equal(b.model, "claude-opus-5-5");
  assert.equal(b.output_config.effort, "medium");
  assert.equal(b.fallbacks, "default");
  assert.deepEqual(b.cache_control, { type: "ephemeral" });
  assert.deepEqual(b.system, [{ type: "text", text: "SYSTEM" }]);
  assert.deepEqual(b.tool_choice, { type: "auto" });
  assert.equal(b.thinking, undefined, "thinking stays adaptive (the default); it can't be turned off on Opus 5.5");
  assert.equal(b.container, undefined);
  assert.equal(buildBody({ ...base, depth: "quick" }, { system: "S", messages }).output_config.effort, "low");
  assert.equal(buildBody({ ...base, depth: "thorough" }, { system: "S", messages }).output_config.effort, "high");
  assert.equal(buildBody({ ...base, model: "claude-sonnet-5-5" }, { system: "S", messages }).fallbacks, "default");
  assert.equal(buildBody({ ...base, model: "claude-haiku-5-5" }, { system: "S", messages }).fallbacks, undefined);
  assert.equal(buildBody(base, { system: "S", messages, fallback: false }).fallbacks, undefined);
  assert.equal(buildBody(base, { system: "S", messages, container: "cont_1" }).container, "cont_1");
});

test("the report schema meets the strict-tool rules", () => {
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
  assert.equal(REPORT_TOOL.strict, true);
});

test("the user turn says what to research, where, how deep, and today's date", () => {
  const t = userText({ ...base, sites: { mode: "skip", list: ["shopee.ph"] } }, "2026-11-23");
  assert.match(t, /Today's date: 2026-11-23/);
  assert.match(t, /Item: Monoblock chair/);
  assert.match(t, /Details: white/);
  assert.match(t, /Quantity needed: 200 \(unit: piece\)/);
  assert.match(t, /the Philippines, prices in PHP\. The buyer is in Manila\./);
  assert.match(t, /up to 8 web searches and 6 page reads/);
  assert.match(t, /Don't use these sites: shopee\.ph/);
  assert.match(t, /submit_report/);
  const s = userText({ ...base, kind: "service", name: "Event emcee", suppliers: false }, "2026-11-23");
  assert.match(s, /Service: Event emcee/);
  assert.doesNotMatch(s, /Condition:/);
  assert.match(s, /Suppliers: not needed/);
});
