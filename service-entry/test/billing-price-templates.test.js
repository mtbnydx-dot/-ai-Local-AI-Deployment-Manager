"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BillingPriceTemplateError,
  CATALOG_VERSION,
  MAX_BATCH_ITEMS,
  PRICE_TEMPLATE_CATALOG,
  convertUsdPerMillionToMicrocredits,
  getPriceTemplate,
  listPriceTemplates,
  previewPriceTemplateApplications,
} = require("../lib/billing-price-templates");

const PLAN_ID = "00000000-0000-4000-8000-000000000001";

function applicationItem(templateId, overrides = {}) {
  return {
    templateId,
    managerId: "vllm-manager",
    modelPattern: "local-model-*",
    planId: PLAN_ID,
    ...overrides,
  };
}

test("catalog is versioned, deeply read-only, and contains the verified mainstream model snapshots", () => {
  assert.equal(CATALOG_VERSION, "2026-08-11.1");
  assert.equal(PRICE_TEMPLATE_CATALOG.length, 14);
  assert.ok(Object.isFrozen(PRICE_TEMPLATE_CATALOG));
  assert.ok(Object.isFrozen(PRICE_TEMPLATE_CATALOG[0]));
  assert.ok(Object.isFrozen(PRICE_TEMPLATE_CATALOG[0].rates));

  const expected = new Map([
    ["openai:gpt-5.6-sol:standard:le-272k", ["5.00", "0.50", "30.00"]],
    ["openai:gpt-5.6-sol:standard:gt-272k", ["10.00", "1.00", "45.00"]],
    ["openai:gpt-5.6-terra:standard:le-272k", ["2.00", "0.20", "12.00"]],
    ["openai:gpt-5.6-terra:standard:gt-272k", ["4.00", "0.40", "18.00"]],
    ["openai:gpt-5.6-luna:standard:le-272k", ["0.20", "0.02", "1.20"]],
    ["openai:gpt-5.6-luna:standard:gt-272k", ["0.40", "0.04", "1.80"]],
    ["anthropic:claude-opus-5:standard:current", ["5.00", "0.50", "25.00"]],
    ["anthropic:claude-sonnet-5:standard:introductory", ["2.00", "0.20", "10.00"]],
    ["anthropic:claude-sonnet-5:standard:2026-09-01", ["3.00", "0.30", "15.00"]],
    ["anthropic:claude-haiku-4-5:standard:current", ["1.00", "0.10", "5.00"]],
    ["google:gemini-3.5-flash:standard:current", ["1.50", "0.15", "9.00"]],
    ["google:gemini-3.5-flash-lite:standard:current", ["0.30", "0.03", "2.50"]],
    ["deepseek:deepseek-v4-flash:standard:current", ["0.14", "0.0028", "0.28"]],
    ["deepseek:deepseek-v4-pro:standard:current", ["0.435", "0.003625", "0.87"]],
  ]);
  for (const [id, rates] of expected) {
    const template = getPriceTemplate(id);
    assert.ok(template, id);
    assert.deepEqual([
      template.rates.inputUsdPerMillion,
      template.rates.cachedInputUsdPerMillion,
      template.rates.outputUsdPerMillion,
    ], rates);
    assert.equal(template.snapshotDate, "2026-08-11");
    assert.match(template.sourceUrl, /^https:\/\//);
    assert.ok(template.cacheNotes);
    assert.ok(template.storageNotes);
  }

  assert.throws(() => { PRICE_TEMPLATE_CATALOG[0].rates.inputUsdPerMillion = "999"; }, TypeError);
});

test("strict catalog filters support provider, model, tier, id, and effective date", () => {
  assert.equal(listPriceTemplates({ provider: "OPENAI" }).length, 6);
  assert.equal(listPriceTemplates({ provider: "anthropic", modelId: "claude-sonnet-5" }).length, 2);
  assert.equal(listPriceTemplates({ tier: "STANDARD" }).length, 14);
  assert.equal(listPriceTemplates({ templateId: "google:gemini-3.5-flash:standard:current" }).length, 1);

  const august = listPriceTemplates({ provider: "anthropic", modelId: "claude-sonnet-5", effectiveAt: "2026-08-11" });
  assert.deepEqual(august.map((item) => item.id), ["anthropic:claude-sonnet-5:standard:introductory"]);
  const september = listPriceTemplates({ provider: "anthropic", modelId: "claude-sonnet-5", effectiveAt: "2026-09-01" });
  assert.deepEqual(september.map((item) => item.id), ["anthropic:claude-sonnet-5:standard:2026-09-01"]);

  assert.throws(
    () => listPriceTemplates({ search: "gpt" }),
    (error) => error instanceof BillingPriceTemplateError && error.code === "billing_template_unknown_field",
  );
  assert.throws(() => listPriceTemplates([]), /plain object/);
});

test("USD conversion uses decimal and BigInt arithmetic with ceiling, never floating point", () => {
  assert.equal(convertUsdPerMillionToMicrocredits("5.00"), "5000000");
  assert.equal(convertUsdPerMillionToMicrocredits("0.0028"), "2800");
  assert.equal(convertUsdPerMillionToMicrocredits("0.003625"), "3625");
  assert.equal(convertUsdPerMillionToMicrocredits("0.435", { creditsPerUsd: "7.5", markupBps: "12500" }), "4078125");
  assert.equal(convertUsdPerMillionToMicrocredits("0.000000001", { creditsPerUsd: "0.1" }), "1");
  assert.equal(convertUsdPerMillionToMicrocredits("0"), "0");

  for (const invalid of ["1e2", "-1", "1.0000000001", "01", 0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => convertUsdPerMillionToMicrocredits(invalid),
      (error) => error instanceof BillingPriceTemplateError && error.code === "billing_template_invalid_decimal",
    );
  }
  assert.throws(
    () => convertUsdPerMillionToMicrocredits("1000000", { creditsPerUsd: "1000000", markupBps: "1000000" }),
    (error) => error instanceof BillingPriceTemplateError && error.code === "billing_template_rate_overflow",
  );
});

test("preview requires explicit local scopes and generates compatible decimal-string price records", () => {
  const preview = previewPriceTemplateApplications({
    creditsPerUsd: "1",
    markupBps: "12000",
    effectiveAt: "2026-08-11T00:00:00.000Z",
    items: [applicationItem("openai:gpt-5.6-terra:standard:le-272k")],
  });
  assert.equal(preview.rounding, "ceil_to_microcredit");
  assert.equal(preview.items[0].inputPerMillionMicrocredits, "2400000");
  assert.equal(preview.items[0].cachedInputPerMillionMicrocredits, "240000");
  assert.equal(preview.items[0].outputPerMillionMicrocredits, "14400000");
  assert.equal(preview.items[0].fixedRequestMicrocredits, "0");
  assert.equal(preview.items[0].unmappedRates.cacheWriteUsdPerMillion, "2.50");
  assert.equal(preview.items[0].managerId, "vllm-manager");
  assert.equal(preview.items[0].modelPattern, "local-model-*");
  assert.equal(preview.items[0].planId, PLAN_ID);
  assert.ok(Object.isFrozen(preview.items));
  assert.ok(Object.isFrozen(preview.items[0].unmappedRates));

  assert.throws(
    () => previewPriceTemplateApplications({ items: [{ templateId: "openai:gpt-5.6-sol:standard:le-272k", managerId: "vllm-manager", modelPattern: "x" }] }),
    (error) => error.code === "billing_template_explicit_scope_required",
  );
  assert.throws(
    () => previewPriceTemplateApplications({ items: [applicationItem("missing")] }),
    (error) => error.code === "billing_template_not_found" && error.status === 404,
  );
  assert.throws(
    () => previewPriceTemplateApplications({ actorId: "attacker", items: [applicationItem("openai:gpt-5.6-sol:standard:le-272k")] }),
    (error) => error.code === "billing_template_unknown_field",
  );
});

test("preview enforces effective windows, unique scopes, and a fifty-item batch ceiling", () => {
  const future = applicationItem("anthropic:claude-sonnet-5:standard:2026-09-01");
  assert.throws(
    () => previewPriceTemplateApplications({ effectiveAt: "2026-08-31T23:59:59.999Z", items: [future] }),
    (error) => error.code === "billing_template_not_effective" && error.status === 409,
  );
  assert.equal(
    previewPriceTemplateApplications({ effectiveAt: "2026-09-01", items: [future] }).items[0].inputPerMillionMicrocredits,
    "3000000",
  );

  const template = "openai:gpt-5.6-luna:standard:le-272k";
  assert.throws(
    () => previewPriceTemplateApplications({ items: [applicationItem(template), applicationItem(template)] }),
    (error) => error.code === "billing_template_duplicate_scope",
  );
  const tooMany = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, index) => applicationItem(template, { modelPattern: `model-${index}` }));
  assert.throws(
    () => previewPriceTemplateApplications({ items: tooMany }),
    (error) => error.code === "billing_template_batch_size",
  );
});
