"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { BillingStoreError, createBillingStore, monthPeriod } = require("../lib/billing-store");

const NOW = new Date("2026-08-11T00:00:00.000Z");

function makeStore(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "service-entry-billing-"));
  const file = path.join(dir, "billing.sqlite");
  const store = createBillingStore({
    file,
    DatabaseSync,
    clock: () => new Date(NOW),
    ...options,
  });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, file };
}

function request(overrides = {}) {
  return {
    requestId: crypto.randomUUID(),
    externalRequestId: "public-request-reference",
    managerId: "vllm-manager",
    clientId: "client-1",
    model: "model-a",
    endpoint: "/v1/chat/completions",
    stream: true,
    estimatedInputTokens: 100,
    maxOutputTokens: 100,
    ...overrides,
  };
}

function settlement(authorization, overrides = {}) {
  return {
    requestId: authorization.requestId,
    externalRequestId: authorization.externalRequestId,
    managerId: "vllm-manager",
    clientId: "client-1",
    model: "model-a",
    status: 200,
    ok: true,
    terminalState: "completed",
    usageSource: "reported",
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cachedInputTokens: 0,
    ...overrides,
  };
}

function provision(store, { mode = "hard", balance = "1000000", plan = {}, customer = {}, price = {} } = {}) {
  const createdPlan = store.createPlan({
    code: `plan-${crypto.randomUUID().slice(0, 8)}`,
    name: "Test plan",
    currency: "CREDITS",
    enforcementMode: mode,
    includedMicrocredits: "1000000",
    monthlyTokenLimit: "100000",
    monthlyRequestLimit: "100",
    ...plan,
  });
  const createdCustomer = store.createCustomer({ name: "Test customer", planId: createdPlan.planId, ...customer });
  store.bindCredential({
    customerId: createdCustomer.customerId,
    managerId: "vllm-manager",
    serviceClientId: "client-1",
    label: "public client",
  });
  if (balance !== null) {
    store.adjustBalance({
      customerId: createdCustomer.customerId,
      deltaMicrocredits: balance,
      reason: "Test funding",
      idempotencyKey: crypto.randomUUID(),
    });
  }
  const createdPrice = store.upsertPrice({
    planId: createdPlan.planId,
    managerId: "vllm-manager",
    model: "model-a",
    inputPerMillionMicrocredits: "1000000",
    outputPerMillionMicrocredits: "2000000",
    cachedInputPerMillionMicrocredits: "500000",
    ...price,
  });
  return { plan: createdPlan, customer: createdCustomer, price: createdPrice };
}

test("SQLite is configured as the durable source of truth and admin CRUD uses decimal strings", (t) => {
  const { store } = makeStore(t);
  assert.deepEqual(store.getPragmas(), {
    journalMode: "wal",
    foreignKeys: 1,
    busyTimeoutMs: 5000,
    synchronous: 2,
  });

  const { plan, customer } = provision(store);
  assert.equal(plan.monthlyPriceMicrocredits, "0");
  assert.equal(plan.includedMicrocredits, "1000000");
  assert.equal(customer.balanceMicrocredits, "0");
  assert.equal(store.listPlans({ limit: 10 })[0].planId, plan.planId);
  assert.equal(store.listCustomers({ limit: 10 })[0].customerId, customer.customerId);
  assert.equal(store.listCredentialBindings({ limit: 200 })[0].serviceClientId, "client-1");
  assert.equal(store.listPrices({ planId: plan.planId, active: true })[0].managerId, "vllm-manager");
  const overview = store.getOverview();
  assert.equal(overview.summary.customers, 1);
  assert.equal(overview.summary.activeCustomers, 1);
  assert.equal(overview.availableMicrocredits, overview.wallet.availableMicrocredits);

  const changed = store.updateCustomerPolicy(customer.customerId, {
    enforcementMode: "shadow",
    creditLimitMicrocredits: "900000",
  });
  assert.equal(changed.enforcementMode, "shadow");
  assert.equal(changed.creditLimitMicrocredits, "900000");
  assert.ok(store.listAuditEvents({ customerId: customer.customerId }).length >= 3);
});

test("official price templates apply atomically with fixed local-admin audit identity", (t) => {
  const { store } = makeStore(t);
  const plan = store.createPlan({ code: "template-plan", name: "Template plan" });
  const result = store.applyPriceTemplates({
    effectiveAt: NOW.toISOString(),
    creditsPerUsd: "1",
    markupBps: "11000",
    items: [
      { templateId: "openai:gpt-5.6-terra:standard:le-272k", managerId: "VLLM-MANAGER", modelPattern: "local-terra-*", planId: plan.planId },
      { templateId: "deepseek:deepseek-v4-pro:standard:current", managerId: "llama-manager", modelPattern: "local-deepseek-v4", planId: null },
    ],
  });
  assert.equal(result.actorId, "local-admin");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].price.managerId, "vllm-manager");
  assert.equal(result.items[0].price.inputPerMillionMicrocredits, "2200000");
  assert.equal(result.items[0].price.cachedInputPerMillionMicrocredits, "220000");
  assert.equal(result.items[0].price.outputPerMillionMicrocredits, "13200000");
  assert.equal(result.items[0].price.sourceTemplateId, "openai:gpt-5.6-terra:standard:le-272k");
  assert.equal(result.items[0].price.sourceCatalogVersion, "2026-08-11.1");
  assert.equal(result.items[0].price.sourceSnapshotDate, "2026-08-11");
  assert.match(result.items[0].price.sourceUrl, /^https:\/\/developers\.openai\.com\//);
  assert.equal(result.items[1].price.inputPerMillionMicrocredits, "478500");
  const listedPrices = store.listPrices({ active: true });
  assert.equal(listedPrices.length, 2);
  assert.ok(listedPrices.every((price) => price.sourceTemplateId));
  const audit = store.listAuditEvents({ limit: 20 });
  const batchAudit = audit.find((entry) => entry.action === "price_template.apply");
  assert.ok(batchAudit);
  assert.equal(batchAudit.actorId, "local-admin");
  assert.equal(batchAudit.details.catalogVersion, "2026-08-11.1");
  assert.equal(batchAudit.details.count, 2);
  assert.deepEqual(batchAudit.details.templateIds, ["openai:gpt-5.6-terra:standard:le-272k", "deepseek:deepseek-v4-pro:standard:current"]);
  assert.ok(audit.filter((entry) => entry.action === "price.create").every((entry) => entry.actorId === "local-admin"));
});

test("price template batch rolls back every price when any mapped plan is invalid", (t) => {
  const { store } = makeStore(t);
  const plan = store.createPlan({ code: "rollback-plan", name: "Rollback plan" });
  assert.throws(
    () => store.applyPriceTemplates({
      effectiveAt: NOW.toISOString(),
      items: [
        { templateId: "google:gemini-3.5-flash:standard:current", managerId: "vllm-manager", modelPattern: "would-have-been-written", planId: plan.planId },
        { templateId: "deepseek:deepseek-v4-flash:standard:current", managerId: "llama-manager", modelPattern: "invalid-plan", planId: "00000000-0000-4000-8000-000000000099" },
      ],
    }),
    (error) => error instanceof BillingStoreError && error.code === "billing_plan_not_found",
  );
  assert.equal(store.listPrices({ active: true }).length, 0);
  assert.equal(store.listAuditEvents({ limit: 20 }).filter((entry) => entry.action.startsWith("price.") || entry.action === "price_template.apply").length, 0);
  assert.throws(
    () => store.applyPriceTemplates({
      actorId: "remote-user",
      items: [{ templateId: "google:gemini-3.5-flash:standard:current", managerId: "vllm-manager", modelPattern: "forbidden-actor", planId: null }],
    }),
    (error) => error.code === "billing_template_unknown_field",
  );
});

test("first-version customer tables migrate in place before new customer fields are used", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "service-entry-billing-migrate-"));
  const file = path.join(dir, "billing.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE billing_customers (
      customer_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_id TEXT,
      enforcement_mode TEXT,
      credit_limit_microcredits INTEGER,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  old.close();
  const store = createBillingStore({ file, DatabaseSync, clock: () => new Date(NOW) });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const customer = store.createCustomer({
    externalRef: "legacy-migrated",
    name: "Migrated customer",
    monthlyTokenLimit: "10",
    monthlyRequestLimit: "2",
  });
  assert.equal(customer.externalRef, "legacy-migrated");
  assert.equal(customer.monthlyTokenLimit, "10");
  assert.equal(customer.monthlyRequestLimit, "2");
});

test("UI customer and plan payload fields round-trip without turning zero/unset allowances into hard caps", (t) => {
  const { store } = makeStore(t);
  const plan = store.createPlan({
    code: "ui-plan",
    name: "UI plan",
    currency: "CREDITS",
    monthlyPriceMicrocredits: "0",
    includedMicrocredits: "100",
    monthlyTokenLimit: null,
    monthlyRequestLimit: null,
    enforcementMode: "hard",
    active: true,
  });
  const customer = store.createCustomer({
    externalRef: "crm-customer-42",
    name: "UI customer",
    planId: plan.planId,
    creditLimitMicrocredits: null,
    monthlyTokenLimit: "500",
    monthlyRequestLimit: "10",
  });
  assert.equal(customer.externalRef, "crm-customer-42");
  assert.equal(customer.monthlyTokenLimit, "500");
  assert.equal(customer.monthlyRequestLimit, "10");
  assert.equal(plan.monthlyTokenLimit, null);
  assert.equal(plan.monthlyRequestLimit, null);

  store.bindCredential({ customerId: customer.customerId, managerId: "vllm-manager", serviceClientId: "client-1" });
  store.adjustBalance({ customerId: customer.customerId, amountMicrocredits: "1000", reason: "fund", idempotencyKey: crypto.randomUUID() });
  store.upsertPrice({ planId: plan.planId, managerId: "vllm-manager", model: "model-a", inputMicrocreditsPerMillion: "1000000", outputMicrocreditsPerMillion: "2000000" });
  // includedMicrocredits is an allowance, not a hard usage cap; 300 > 100 remains allowed.
  assert.equal(store.authorizeRequest(request()).allowed, true);
});

test("unbound authorization defaults to shadow allow and explicit hard mode denies idempotently", (t) => {
  const shadow = makeStore(t).store;
  const input = request();
  const first = shadow.authorizeRequest(input);
  const replay = shadow.authorizeRequest(input);
  assert.equal(first.allowed, true);
  assert.equal(first.bound, false);
  assert.equal(first.enforcementMode, "shadow");
  assert.equal(first.code, "billing_unbound_shadow");
  assert.equal(replay.replayed, true);
  assert.equal(replay.requestId, first.requestId);

  const hardFixture = makeStore(t, { defaultEnforcementMode: "hard" });
  const denied = hardFixture.store.authorizeRequest(request());
  assert.equal(denied.allowed, false);
  assert.equal(denied.bound, false);
  assert.equal(denied.code, "billing_credential_unbound");
});

test("hard mode reserves balance, settles exactly once, and charges actual overage", (t) => {
  const { store } = makeStore(t);
  const { customer } = provision(store, { balance: "1000" });
  const input = request({ estimatedInputTokens: 100, maxOutputTokens: 100 });
  const authorized = store.authorizeRequest(input);
  // ceil((100*1 + 100*2)) at per-million rates = 300 microcredits.
  assert.equal(authorized.reservationMicrocredits, "300");
  assert.equal(authorized.allowed, true);
  assert.equal(store.getCustomer(customer.customerId).availableMicrocredits, "700");

  const settled = store.settleRequest(settlement(authorized, {
    inputTokens: 100,
    outputTokens: 600,
    totalTokens: 700,
  }));
  assert.equal(settled.projectedMicrocredits, "1300");
  assert.equal(settled.chargedMicrocredits, "1300");
  assert.equal(store.getCustomer(customer.customerId).balanceMicrocredits, "-300");

  const replay = store.settleRequest(settlement(authorized, {
    inputTokens: 100,
    outputTokens: 600,
    totalTokens: 700,
  }));
  assert.equal(replay.replayed, true);
  assert.equal(store.listLedger({ customerId: customer.customerId }).filter((row) => row.entryType === "usage_debit").length, 1);

  const next = store.authorizeRequest(request());
  assert.equal(next.allowed, false);
  assert.equal(next.code, "billing_insufficient_balance");
});

test("shadow computes projected cost without debiting and missing or unmeasured failures release reservations", (t) => {
  const shadowFixture = makeStore(t);
  const shadowProvision = provision(shadowFixture.store, { mode: "shadow", balance: null });
  const shadowAuth = shadowFixture.store.authorizeRequest(request());
  assert.equal(shadowAuth.allowed, true);
  const shadowSettle = shadowFixture.store.settleRequest(settlement(shadowAuth));
  assert.equal(shadowSettle.projectedMicrocredits, "200");
  assert.equal(shadowSettle.chargedMicrocredits, "0");
  assert.equal(shadowFixture.store.getCustomer(shadowProvision.customer.customerId).balanceMicrocredits, "0");

  const hardFixture = makeStore(t);
  const hardProvision = provision(hardFixture.store, { balance: "1000" });
  const missingAuth = hardFixture.store.authorizeRequest(request());
  assert.equal(hardFixture.store.getCustomer(hardProvision.customer.customerId).reservedMicrocredits, "300");
  const missing = hardFixture.store.settleRequest(settlement(missingAuth, {
    usageSource: "missing",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }));
  assert.equal(missing.terminalState, "ambiguous");
  assert.equal(missing.projectedMicrocredits, "0");
  assert.equal(missing.chargedMicrocredits, "0");
  assert.equal(hardFixture.store.getCustomer(hardProvision.customer.customerId).reservedMicrocredits, "0");

  const failedAuth = hardFixture.store.authorizeRequest(request());
  const failed = hardFixture.store.settleRequest(settlement(failedAuth, {
    status: 500,
    ok: false,
    terminalState: "failed",
    usageSource: "missing",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }));
  assert.equal(failed.code, "billing_usage_missing");
  assert.equal(failed.chargedMicrocredits, "0");
});

test("measured partial usage is charged after disconnect so streaming cannot evade Hard billing", (t) => {
  const { store } = makeStore(t);
  const { customer } = provision(store, { balance: "1000" });
  const authorization = store.authorizeRequest(request());
  const settled = store.settleRequest(settlement(authorization, {
    status: 499,
    ok: false,
    terminalState: "aborted",
    usageSource: "estimated",
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  }));
  assert.equal(settled.terminalState, "cancelled");
  assert.equal(settled.code, "billing_partial_usage_settled");
  assert.equal(settled.chargedMicrocredits, "200");
  assert.equal(store.getCustomer(customer.customerId).balanceMicrocredits, "800");
  assert.equal(store.getCustomer(customer.customerId).reservedMicrocredits, "0");
});

test("measured partial usage consumes Hard period credit, token, and request quotas", (t) => {
  const cases = [
    {
      name: "credit",
      provision: { customer: { creditLimitMicrocredits: "400" } },
      expectedCode: "billing_period_credit_limit",
    },
    {
      name: "token",
      provision: { plan: { monthlyTokenLimit: "300" } },
      expectedCode: "billing_period_token_limit",
    },
    {
      name: "request",
      provision: { plan: { monthlyRequestLimit: "1" } },
      expectedCode: "billing_period_request_limit",
    },
  ];

  for (const item of cases) {
    const { store } = makeStore(t);
    provision(store, { balance: "100000", ...item.provision });
    const authorization = store.authorizeRequest(request());
    const partial = store.settleRequest(settlement(authorization, {
      status: 499,
      ok: false,
      terminalState: "aborted",
      usageSource: "estimated",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    }));
    assert.equal(partial.projectedMicrocredits, "200", item.name);
    const next = store.authorizeRequest(request());
    assert.equal(next.allowed, false, item.name);
    assert.equal(next.code, item.expectedCode, item.name);
  }
});

test("measured partial Shadow usage projects period request exhaustion without blocking", (t) => {
  const { store } = makeStore(t);
  provision(store, {
    mode: "shadow",
    balance: "100000",
    plan: { monthlyRequestLimit: "1" },
  });
  const authorization = store.authorizeRequest(request());
  const partial = store.settleRequest(settlement(authorization, {
    status: 499,
    ok: false,
    terminalState: "aborted",
    usageSource: "estimated",
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  }));
  assert.equal(partial.projectedMicrocredits, "200");
  assert.equal(partial.chargedMicrocredits, "0");

  const next = store.authorizeRequest(request());
  assert.equal(next.allowed, true);
  assert.equal(next.code, "billing_period_request_limit_shadow");
});

test("gateway terminal aliases release reservations and expired reservations stop consuming hard limits", (t) => {
  let current = new Date(NOW);
  const { store } = makeStore(t, {
    reservationTtlSeconds: 60,
    clock: () => new Date(current),
  });
  const { customer } = provision(store, { balance: "1000" });

  const abortedAuth = store.authorizeRequest(request());
  const aborted = store.settleRequest(settlement(abortedAuth, {
    status: 499,
    ok: false,
    terminalState: "aborted",
    usageSource: "missing",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }));
  assert.equal(aborted.terminalState, "cancelled");
  assert.equal(aborted.code, "billing_usage_missing");
  assert.equal(store.getCustomer(customer.customerId).reservedMicrocredits, "0");

  const timedOutAuth = store.authorizeRequest(request());
  const timedOut = store.settleRequest(settlement(timedOutAuth, {
    status: 504,
    ok: false,
    terminalState: "timed_out",
    usageSource: "missing",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }));
  assert.equal(timedOut.terminalState, "timeout");
  assert.equal(store.getCustomer(customer.customerId).reservedMicrocredits, "0");

  store.authorizeRequest(request());
  assert.equal(store.getCustomer(customer.customerId).reservedMicrocredits, "300");
  current = new Date(NOW.getTime() + 61_000);
  assert.equal(store.getCustomer(customer.customerId).reservedMicrocredits, "0");
  assert.equal(store.getOverview().reservedMicrocredits, "0");
  assert.equal(store.authorizeRequest(request()).allowed, true);
});

test("price matching separates managers and prefers plan-specific prices over global fallbacks", (t) => {
  const { store } = makeStore(t);
  const { plan } = provision(store, { balance: "100000" });
  store.upsertPrice({
    managerId: "*",
    modelPattern: "*",
    inputMicrocreditsPerMillion: "9000000",
    outputMicrocreditsPerMillion: "9000000",
  });
  store.upsertPrice({
    planId: plan.planId,
    managerId: "llama-manager",
    modelPattern: "model-a",
    inputMicrocreditsPerMillion: "7000000",
    outputMicrocreditsPerMillion: "8000000",
  });

  // Existing vLLM plan+manager+model price remains the most specific.
  assert.equal(store.authorizeRequest(request()).reservationMicrocredits, "300");

  const customer = store.listCustomers({ limit: 1 })[0];
  store.bindCredential({ customerId: customer.customerId, managerId: "llama-manager", serviceClientId: "llama-client" });
  const llama = store.authorizeRequest(request({ managerId: "llama-manager", clientId: "llama-client" }));
  assert.equal(llama.reservationMicrocredits, "1500");
});

test("model price globs match safely, rank below exact prices, and can be deactivated", (t) => {
  const { store } = makeStore(t);
  const { plan, customer } = provision(store, { balance: "100000" });
  store.bindCredential({ customerId: customer.customerId, managerId: "llama-manager", serviceClientId: "llama-client" });
  const glob = store.upsertPrice({
    planId: plan.planId,
    managerId: "llama-manager",
    modelPattern: "Qwen/*",
    inputMicrocreditsPerMillion: "3000000",
    outputMicrocreditsPerMillion: "4000000",
  });
  store.upsertPrice({
    planId: plan.planId,
    managerId: "llama-manager",
    modelPattern: "Qwen/Exact",
    inputMicrocreditsPerMillion: "1000000",
    outputMicrocreditsPerMillion: "1000000",
  });
  const exact = store.authorizeRequest(request({ managerId: "llama-manager", clientId: "llama-client", model: "Qwen/Exact" }));
  assert.equal(exact.reservationMicrocredits, "200");
  const wildcard = store.authorizeRequest(request({ managerId: "llama-manager", clientId: "llama-client", model: "Qwen/Other" }));
  assert.equal(wildcard.reservationMicrocredits, "700");

  const closed = store.upsertPrice({
    planId: plan.planId,
    managerId: "llama-manager",
    modelPattern: "Qwen/*",
    inputMicrocreditsPerMillion: "3000000",
    outputMicrocreditsPerMillion: "4000000",
    active: false,
  });
  assert.equal(closed.priceId, glob.priceId);
  assert.equal(closed.active, false);
  assert.equal(store.listPrices({ planId: plan.planId, active: false }).some((item) => item.priceId === glob.priceId), true);
});

test("usage windows use the store clock and UTC day/month boundaries", (t) => {
  let current = new Date("2026-08-10T12:00:00.000Z");
  const { store } = makeStore(t, { clock: () => new Date(current) });
  provision(store, { balance: "100000" });
  const first = store.authorizeRequest(request());
  store.settleRequest(settlement(first));
  current = new Date("2026-08-11T12:00:00.000Z");
  const second = store.authorizeRequest(request());
  store.settleRequest(settlement(second));
  assert.equal(store.listUsage({ window: "day" }).length, 1);
  assert.equal(store.listUsage({ window: "month" }).length, 2);
  assert.equal(store.listUsage({ window: "all" }).length, 2);
});

test("hard monthly request/token/credit limits are enforced with outstanding reservations", (t) => {
  const { store } = makeStore(t);
  provision(store, {
    balance: "100000",
    plan: {
      includedMicrocredits: "500",
      monthlyTokenLimit: "300",
      monthlyRequestLimit: "1",
    },
  });
  assert.equal(store.authorizeRequest(request()).allowed, true);
  const second = store.authorizeRequest(request());
  assert.equal(second.allowed, false);
  assert.ok(["billing_period_credit_limit", "billing_period_token_limit", "billing_period_request_limit"].includes(second.code));
});

test("strict validation, immutable ledgers, and audit secret rejection fail safely", (t) => {
  const { store, file } = makeStore(t);
  const { customer } = provision(store);

  assert.throws(
    () => store.authorizeRequest(request({ estimatedInputTokens: "1.5" })),
    (error) => error instanceof BillingStoreError && error.code === "billing_invalid_integer",
  );
  assert.throws(
    () => store.writeAdminAudit({
      actorId: "admin",
      action: "customer.note",
      targetType: "customer",
      targetId: customer.customerId,
      customerId: customer.customerId,
      details: { apiKey: "must-not-be-stored" },
    }),
    (error) => error instanceof BillingStoreError && error.code === "billing_sensitive_audit_field",
  );
  assert.throws(
    () => store.writeAdminAudit({
      actorId: "admin",
      action: "customer.note",
      targetType: "customer",
      targetId: customer.customerId,
      customerId: customer.customerId,
      details: { apiKeyHash: "must-not-be-stored" },
    }),
    (error) => error instanceof BillingStoreError && error.code === "billing_sensitive_audit_field",
  );
  assert.doesNotThrow(() => store.writeAdminAudit({
    actorId: "admin",
    action: "customer.quota",
    targetType: "customer",
    targetId: customer.customerId,
    customerId: customer.customerId,
    details: { monthlyTokenLimit: "1000", totalTokens: "10" },
  }));

  // Quotes remain data because every dynamic value is bound, not interpolated.
  const quoted = store.createCustomer({ name: "Robert'); DROP TABLE billing_customers;--" });
  assert.equal(store.getCustomer(quoted.customerId).name.includes("DROP TABLE"), true);
  store.createCustomer({ name: "External one", externalRef: "crm-unique" });
  assert.throws(
    () => store.createCustomer({ name: "External duplicate", externalRef: "crm-unique" }),
    (error) => error instanceof BillingStoreError && error.code === "billing_customer_conflict" && error.status === 409,
  );

  const entry = store.adjustBalance({
    customerId: customer.customerId,
    amountMicrocredits: "5",
    reason: "immutable test",
    idempotencyKey: crypto.randomUUID(),
  });
  store.close();
  const db = new DatabaseSync(file);
  assert.throws(() => db.prepare("UPDATE billing_wallet_ledger SET reason='changed' WHERE entry_id=?").run(entry.entryId), /immutable/i);
  assert.throws(() => db.prepare("DELETE FROM billing_admin_audit").run(), /immutable/i);
  db.close();
});

test("month period uses tzOffsetMinutes and keeps UTC when offset is 0", () => {
  const utc = monthPeriod(new Date("2026-08-31T17:00:00.000Z"), 0);
  assert.equal(utc.key, "2026-08");
  const cst = monthPeriod(new Date("2026-08-31T17:00:00.000Z"), 480);
  assert.equal(cst.key, "2026-09");
});
