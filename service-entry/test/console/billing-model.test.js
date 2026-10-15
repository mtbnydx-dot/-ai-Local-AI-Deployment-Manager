// CON-27 (07 §6.11): the pure billing model behind the native page: exact
// decimal and integer text (money never goes through Number), hostile text,
// the usage/summary reshaping and the checks every form runs before it sends.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CONSOLE_DIR } = await import("./loader.mjs");
const model = await import(pathToFileURL(path.join(CONSOLE_DIR, "lib", "billing-model.js")).href);

const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const PLAN = "11111111-1111-4111-8111-111111111111";
const customers = [{ id: CUSTOMER }];
const plans = [{ id: PLAN, active: true }, { id: "retired", active: false }];

test("microcredits become exact credit decimals without Number", () => {
  assert.equal(model.microcreditsToCredits("1750000", ""), "1.75");
  assert.equal(model.microcreditsToCredits("9007199254740993", ""), "9007199254.740993");
  assert.equal(model.microcreditsToCredits("-1", "", true), "-0.000001");
  assert.equal(model.microcreditsToCredits("-0", "", true), "0");
  assert.equal(model.microcreditsToCredits("1.5", "n/a"), "n/a");
  assert.equal(model.microcreditsToCredits("-5", "n/a"), "n/a");
  assert.equal(model.creditsFromApi("2.50", "999", ""), "2.5");
  assert.equal(model.creditsFromApi(undefined, "2500000", ""), "2.5");
  assert.equal(model.normalizeDecimal("-00.500"), "-0.5");
  assert.equal(model.normalizeDecimal("-0.000"), "0");
});

test("formatting groups digits by locale and keeps the fraction as sent", () => {
  assert.equal(model.formatInteger("1234567", "en-US"), "1,234,567");
  assert.equal(model.formatInteger("not a number", "en-US"), "0");
  assert.equal(model.formatDecimal("-9007199254.740993", "en-US"), "-9,007,199,254.740993");
  assert.equal(model.formatSignedDecimal("12.5", "en-US"), "+12.5");
  assert.equal(model.formatSignedDecimal("-12.5", "en-US"), "-12.5");
  assert.equal(model.formatSignedDecimal("0", "en-US"), "0");
});

test("sums stay exact at 6 fraction digits", () => {
  assert.equal(model.sumIntegers(["9007199254740993", "1", "bad"]), "9007199254740994");
  assert.equal(model.sumDecimals(["0.1", "0.2", "-0.000001"]), "0.299999");
});

test("hostile text is cut to plain text and secret-shaped runs are replaced", () => {
  const hostile = "<img src=x onerror=\"window.__billingXss=1\">\u0007name";
  assert.equal(model.safeText(hostile, 500), "<img src=x onerror=\"window.__billingXss=1\">name");
  assert.equal(model.safeText("x".repeat(20), 5), "xxxxx");
  assert.equal(model.safeNarrative("key sk-API_SECRET_SENTINEL and Bearer abcdefgh12345 end", 500, "[r]"), "key [r] and [r] end");
  assert.equal(model.safeNarrative("token=abc123", 500, "[r]"), "[r]");
  assert.equal(model.safeId("<b>"), "");
  assert.equal(model.safeId("cust_1.a:b-c"), "cust_1.a:b-c");
  assert.equal(model.safeKeyPreview("sk-ab…yz"), "sk-ab…yz");
  assert.equal(model.safeKeyPreview("has space"), "");
  assert.equal(model.safeHttpUrl("javascript:alert(1)"), "");
  assert.equal(model.safeHttpUrl("https://example.com/a"), "https://example.com/a");
});

test("lists are rebuilt record by record, capped, and say when they were cut", () => {
  const rows = Array.from({ length: model.MAX_ITEMS + 3 }, (_, index) => ({ n: index }));
  const list = model.normalizeList({ items: rows, total: 900 }, "items", (item) => ({ n: item.n }));
  assert.equal(list.items.length, model.MAX_ITEMS);
  assert.equal(list.total, 900);
  assert.equal(list.truncated, true);
  assert.deepEqual(model.normalizeList({ data: { customers: [{ n: 1 }] } }, "customers", (item) => item).items, [{ n: 1 }]);
  assert.deepEqual(model.normalizeList("garbage", "items", (item) => item), { items: [], total: 0, truncated: false, count: 0 });
});

test("usage rows never carry unknown fields and hostile ids are blanked", () => {
  const usage = model.normalizeUsage({
    usageId: "u1", customerId: "<x>", model: "m", inputTokens: "1.5", outputTokens: "7", totalTokens: "9",
    debitedMicrocredits: "2500000", apiKey: "sk-should-not-survive", ok: false,
  });
  assert.equal(usage.customerId, "");
  assert.equal(usage.inputTokens, "0");
  assert.equal(usage.debited, "2.5");
  assert.equal(usage.ok, false);
  assert.equal("apiKey" in usage, false);
  assert.deepEqual(model.usageState(usage), { state: "failure", tone: "fail" });
  assert.deepEqual(model.usageState({ terminalState: "timeout" }), { state: "timeout", tone: "fail" });
  assert.deepEqual(model.usageState({ ok: null }), { state: "unknown", tone: "" });
});

test("usage/summary needs rows and groupBy arrays, or the panel stays hidden", () => {
  assert.equal(model.normalizeUsageSummary(null), null);
  assert.equal(model.normalizeUsageSummary({ ok: false }), null);
  assert.equal(model.normalizeUsageSummary({ ok: true, items: [{}] }), null);
  assert.equal(model.normalizeUsageSummary({ rows: [] }), null);
  const summary = model.normalizeUsageSummary({
    from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z", tzOffsetMinutes: 480, groupBy: ["customer", "model", "month"],
    rows: [{ customerId: CUSTOMER, customerName: "A", model: "m", month: "2026-08", requests: "3", ok: "2", totalTokens: "3600", projectedMicrocredits: "600", chargedMicrocredits: "900" }, { month: "bad", requests: "x" }],
    totals: { requests: "3", totalTokens: "3600" },
  });
  assert.equal(summary.tzOffsetMinutes, 480);
  assert.equal(summary.rows[0].month, "2026-08");
  assert.equal(summary.rows[0].chargedMicrocredits, "900");
  assert.equal(summary.rows[1].month, "");
  assert.equal(summary.rows[1].requests, "0");
  assert.equal(summary.totals.totalTokens, "3600");
  assert.equal(model.normalizeUsageSummary({ rows: [], groupBy: [], tzOffsetMinutes: 99999 }).tzOffsetMinutes, 0);
});

test("the period label and zone come from the summary's own offset", () => {
  const period = model.summaryPeriod({ from: "2026-07-31T16:00:00.000Z", to: "2026-08-31T16:00:00.000Z", tzOffsetMinutes: 480 });
  assert.deepEqual(period, { from: "2026-08-01", to: "2026-08-31", tz: "UTC+08:00" });
  assert.equal(model.summaryPeriod({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z", tzOffsetMinutes: -330 }).tz, "UTC-05:30");
});

test("the daily chart scales bars by exact ratios and labels three days", () => {
  assert.equal(model.dailyChart(null), null);
  const daily = {
    from: "2026-08-01T00:00:00.000Z", to: "2026-08-06T00:00:00.000Z", tzOffsetMinutes: 0,
    rows: [{ day: "2026-08-02", totalTokens: "1000" }, { day: "2026-08-04", totalTokens: "250" }, { day: "2026-08-05", totalTokens: "1" }],
  };
  const chart = model.dailyChart(daily);
  assert.equal(chart.days.length, 5);
  assert.equal(chart.width, 50);
  assert.equal(chart.peak, "1000");
  assert.deepEqual(chart.bars.map((bar) => [bar.day, bar.height]), [["2026-08-02", 100], ["2026-08-04", 25], ["2026-08-05", 1]]);
  assert.deepEqual(chart.ticks, ["2026-08-01", "2026-08-03", "2026-08-05"]);
});

test("customer and price filters match case-insensitively", () => {
  const list = [
    { name: "Alpha", externalRef: "CRM-1", id: "c1", planId: PLAN, enforcementMode: "hard", status: "active" },
    { name: "Beta", externalRef: "", id: "c2", planId: "", enforcementMode: "shadow", status: "suspended" },
  ];
  assert.deepEqual(model.filterCustomers(list, { query: "crm-1" }).map((item) => item.id), ["c1"]);
  assert.deepEqual(model.filterCustomers(list, { status: "suspended" }).map((item) => item.id), ["c2"]);
  assert.deepEqual(model.filterCustomers(list, { mode: "hard", planId: PLAN }).map((item) => item.id), ["c1"]);
  const prices = [{ modelPattern: "Local/Base-7B", managerId: "vllm-manager", planId: "", templateProvider: "" }];
  assert.equal(model.filterPrices(prices, { query: "base-7b", managerId: "vllm-manager" }).length, 1);
  assert.equal(model.filterPrices(prices, { managerId: "llama-manager" }).length, 0);
});

test("template availability follows its window and active flag", () => {
  const now = Date.parse("2026-08-11T02:00:00.000Z");
  assert.deepEqual(model.templateAvailability({ active: false }, now), { selectable: false, code: "inactive" });
  assert.equal(model.templateAvailability({ active: true, effectiveFrom: "2026-09-01T00:00:00Z" }, now).code, "future");
  assert.equal(model.templateAvailability({ active: true, effectiveTo: "2026-08-11T02:00:00Z" }, now).code, "expired");
  assert.equal(model.templateAvailability({ active: true, effectiveFrom: "2026-08-01T00:00:00Z" }, now).selectable, true);
});

test("service clients come from the manager's own list, with the global client first", () => {
  const managers = [{ id: "vllm", clients: { clients: [{ id: "c1", name: "Client One", keyPreview: "sk-ab…yz" }, { id: "c2", enabled: false }] }, exposure: { settings: { billingClientId: "global", hasApiKey: true, apiKeyPreview: "sk-gl…ob" } } }];
  const clients = model.availableClients(managers, "vllm-manager");
  assert.deepEqual(clients.map((item) => [item.id, item.global, item.enabled]), [["global", true, true], ["c1", false, true], ["c2", false, false]]);
  assert.deepEqual(model.availableClients(managers, "llama-manager"), []);
  assert.deepEqual(model.availableClients(managers, "../x"), []);
});

test("a customer form sends canonical values or names the fields that are wrong", () => {
  const ok = model.validateCustomer({ name: " Alpha ", externalRef: "", planId: PLAN, enforcementMode: "hard", creditLimit: "10.5", monthlyTokenLimit: "0", monthlyRequestLimit: "100" }, { plans });
  assert.deepEqual(ok, { ok: true, value: { name: "Alpha", externalRef: "", planId: PLAN, enforcementMode: "hard", creditLimit: "10.5", monthlyTokenLimit: "0", monthlyRequestLimit: "100" } });
  const invalid = model.validateCustomer({ name: "A", externalRef: "has space", planId: "retired", enforcementMode: "x", creditLimit: "1.1234567", monthlyTokenLimit: "-1", monthlyRequestLimit: "01" }, { plans });
  assert.equal(invalid.ok, false);
  assert.deepEqual(Object.keys(invalid.errors).sort(), ["creditLimit", "enforcementMode", "externalRef", "monthlyRequestLimit", "monthlyTokenLimit", "name", "planId"]);
  assert.equal(invalid.errors.name.code, "min");
  assert.equal(invalid.errors.planId.code, "plan");
});

test("the policy form splits the customer id from the PATCH body", () => {
  const result = model.validatePolicy({ customerId: CUSTOMER, planId: "", enforcementMode: "shadow", creditLimit: "0", monthlyTokenLimit: "0", monthlyRequestLimit: "0" }, { customers, plans });
  assert.equal(result.ok, true);
  assert.equal(result.value.customerId, CUSTOMER);
  assert.equal(result.value.body.planId, null);
  assert.equal("customerId" in result.value.body, false);
  assert.equal(model.validatePolicy({ customerId: "nobody" }, { customers, plans }).errors.customerId.code, "customer");
});

test("a credential needs an enabled client of the chosen manager", () => {
  const managers = [{ id: "vllm", clients: { clients: [{ id: "c1" }, { id: "c2", enabled: false }] } }];
  const base = { customerId: CUSTOMER, managerId: "vllm-manager" };
  assert.equal(model.validateCredential({ ...base, serviceClientId: "c1" }, { customers, managers }).ok, true);
  assert.equal(model.validateCredential({ ...base, serviceClientId: "c2" }, { customers, managers }).errors.serviceClientId.code, "clientDisabled");
  assert.equal(model.validateCredential({ ...base, serviceClientId: "zz" }, { customers, managers }).errors.serviceClientId.code, "client");
  assert.equal(model.validateCredential({ ...base, managerId: "other", serviceClientId: "c1" }, { customers, managers }).errors.managerId.code, "enum");
});

test("an adjustment is a non-zero signed decimal with at most 6 fraction digits and a reason", () => {
  assert.equal(model.validateAdjustment({ customerId: CUSTOMER, amountCredits: "-10.5", reason: "refund" }, { customers }).ok, true);
  const codes = (values) => Object.fromEntries(Object.entries(model.validateAdjustment({ customerId: CUSTOMER, reason: "refund", ...values }, { customers }).errors || {}).map(([name, error]) => [name, error.code]));
  assert.deepEqual(codes({ amountCredits: "0" }), { amountCredits: "zero" });
  assert.deepEqual(codes({ amountCredits: "0.0" }), { amountCredits: "zero" });
  assert.deepEqual(codes({ amountCredits: "1.2345678" }), { amountCredits: "decimal" });
  assert.deepEqual(codes({ amountCredits: "1e3" }), { amountCredits: "decimal" });
  assert.deepEqual(codes({ amountCredits: "5", reason: "x" }), { reason: "min" });
  assert.deepEqual(codes({ amountCredits: "5", reason: "bad\u0000" }), { reason: "control" });
});

test("plan and price forms bound their integers to what the ledger stores", () => {
  const plan = model.validatePlan({ code: "PRO", name: "Pro", currency: "USD", monthlyPrice: "25", includedCredits: "100", enforcementMode: "shadow", monthlyTokenLimit: "0", monthlyRequestLimit: "0" });
  assert.equal(plan.ok, true);
  assert.equal(plan.value.active, true);
  assert.equal(model.validatePlan({ code: "p", name: "Pro", currency: "usd" }).ok, false);
  const price = { planId: "", managerId: "vllm-manager", modelPattern: "local/*", inputMicrocreditsPerMillion: "1", cachedInputMicrocreditsPerMillion: "0", outputMicrocreditsPerMillion: "9223372036854775807", active: "true" };
  assert.equal(model.validatePrice(price, { plans }).ok, true);
  assert.equal(model.validatePrice({ ...price, outputMicrocreditsPerMillion: "9223372036854775808" }, { plans }).errors.outputMicrocreditsPerMillion.code, "maxValue");
  assert.equal(model.validatePrice({ ...price, modelPattern: "<script>" }, { plans }).errors.modelPattern.code, "pattern");
});

test("a template apply body is built from the form and ties a preview to its exact body", () => {
  const now = Date.parse("2026-08-11T02:00:00.000Z");
  const template = { id: "t1", active: true, effectiveFrom: "2026-08-01T00:00:00Z" };
  const form = { managerId: "vllm-manager", planId: PLAN, modelPattern: "local/x", creditsPerUsd: "1000", markupBps: "2500" };
  const result = model.validateTemplateApply(form, { template, plans, now });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { items: [{ templateId: "t1", managerId: "vllm-manager", modelPattern: "local/x", planId: PLAN }], creditsPerUsd: "1000", markupBps: "2500" });
  const other = model.validateTemplateApply({ ...form, markupBps: "2501" }, { template, plans, now });
  assert.notEqual(model.templateSignature(result.value), model.templateSignature(other.value));
  assert.equal(model.validateTemplateApply({ ...form, creditsPerUsd: "0" }, { template, plans, now }).errors.creditsPerUsd.code, "zero");
  assert.equal(model.validateTemplateApply({ ...form, markupBps: "0" }, { template, plans, now }).errors.markupBps.code, "markup");
  assert.equal(model.validateTemplateApply(form, { template: { ...template, effectiveFrom: "2026-09-01T00:00:00Z" }, plans, now }).errors.template.vars.reason, "future");
  assert.equal(model.validateTemplateApply(form, { plans, now }).errors.template.code, "template");
});

test("a preview answer shows the server's integer rates", () => {
  const item = model.previewItem({ items: [{ modelPattern: "local/x", price: { inputPerMillionMicrocredits: "1250000", cachedInputPerMillionMicrocredits: "125000", outputPerMillionMicrocredits: "10000000" }, effectiveAt: "2026-08-11T02:00:00.000Z" }] });
  assert.deepEqual([item.input, item.cachedInput, item.output], ["1250000", "125000", "10000000"]);
  assert.equal(item.modelPattern, "local/x");
  assert.equal(model.previewItem(null).input, "");
});

test("idempotency keys are fresh per attempt and carry the manual prefix", () => {
  const first = model.createIdempotencyKey();
  assert.match(first, /^manual-[0-9a-f-]{16,}$/);
  assert.notEqual(first, model.createIdempotencyKey());
});

test("manager names are product names", () => {
  assert.equal(model.managerName("vllm"), "vLLM Manager");
  assert.equal(model.managerName("llama-manager"), "llama.cpp Manager");
  assert.equal(model.managerName("<b>x"), "<b>x");
});
