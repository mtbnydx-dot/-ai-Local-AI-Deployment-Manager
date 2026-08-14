"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../../manager-core");
const {
  adaptAdjustmentInput,
  adaptCustomerInput,
  adaptPlanInput,
  adaptPriceInput,
  createBillingHttpHandler,
  creditsToMicrocredits,
  localAdminInput,
  priceOptions,
  templateFilters,
  strictLocalBillingAdmin,
} = require("../lib/billing-http");

function responseState() {
  const state = { status: 0, data: null };
  return {
    state,
    res: {
      writeHead(status) { state.status = status; },
      end(body) { state.data = body ? JSON.parse(body) : null; },
    },
  };
}

function request(method, pathname, body = null, headers = {}, remoteAddress = "127.0.0.1") {
  const raw = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return {
    method,
    url: pathname,
    raw,
    headers: { host: "127.0.0.1:5176", ...(body === null ? {} : { "content-type": "application/json" }), ...headers },
    socket: { remoteAddress },
  };
}

function createHandler(store, token = "billing-http-test-token") {
  return createBillingHttpHandler({
    getStore: () => store,
    readRequestBody: async (req) => req.raw,
    sendJson(res, data, status = 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    },
    verifyBillingRequest: core.verifyBillingRequest,
    getTrustToken: () => token,
    isLocalAddress: core.isLocalAddress,
    extractHostname: core.extractHostname,
  });
}

test("billing admin requires a direct localhost request, not a forwarded loopback hop", () => {
  const deps = { isLocalAddress: core.isLocalAddress, extractHostname: core.extractHostname };
  assert.equal(strictLocalBillingAdmin(request("GET", "/api/billing/overview"), deps), true);
  assert.equal(strictLocalBillingAdmin(request("GET", "/api/billing/overview", null, { host: "192.168.1.26:5176" }), deps), false);
  assert.equal(strictLocalBillingAdmin(request("GET", "/api/billing/overview", null, { "x-forwarded-for": "203.0.113.5" }), deps), false);
  assert.equal(strictLocalBillingAdmin(request("GET", "/api/billing/overview", null, {}, "192.168.1.50"), deps), false);
});

test("signed manager requests reach billing authorize and tampering is rejected", async () => {
  const token = "billing-http-test-token";
  const calls = [];
  const store = {
    authorizeRequest(data) {
      calls.push(data);
      return { ok: true, allowed: true, bound: false };
    },
  };
  const handler = createHandler(store, token);
  const payload = { requestId: "req-1", managerId: "vllm-manager", clientId: "public-client" };
  const raw = JSON.stringify(payload);
  const headers = core.buildBillingRequestHeaders(token, "POST", "/internal/billing/authorize", "vllm-manager", raw);
  const req = request("POST", "/internal/billing/authorize", payload, headers);
  const ok = responseState();
  assert.equal(await handler(req, ok.res, new URL("http://127.0.0.1/internal/billing/authorize")), true);
  assert.equal(ok.state.status, 200);
  assert.equal(calls.length, 1);

  const tampered = request("POST", "/internal/billing/authorize", { ...payload, clientId: "other" }, headers);
  const denied = responseState();
  await handler(tampered, denied.res, new URL("http://127.0.0.1/internal/billing/authorize"));
  assert.equal(denied.state.status, 401);
  assert.equal(calls.length, 1);
});

test("billing admin routes dispatch lists and bounded JSON mutations", async () => {
  const calls = [];
  const store = {
    listCustomers(options) { calls.push(["list", options]); return [{ customerId: "customer-1" }]; },
    createCustomer(input) { calls.push(["create", input]); return { ok: true, customer: { id: "customer-1" } }; },
  };
  const handler = createHandler(store);
  const listed = responseState();
  await handler(
    request("GET", "/api/billing/customers?limit=25"),
    listed.res,
    new URL("http://127.0.0.1/api/billing/customers?limit=25"),
  );
  assert.equal(listed.state.status, 200);
  assert.deepEqual(calls[0], ["list", { limit: 25, offset: 0 }]);
  assert.deepEqual(listed.state.data, { ok: true, items: [{ customerId: "customer-1" }] });

  const created = responseState();
  await handler(
    request("POST", "/api/billing/customers", { name: "Customer" }),
    created.res,
    new URL("http://127.0.0.1/api/billing/customers"),
  );
  assert.equal(created.state.status, 200);
  assert.deepEqual(calls[1], ["create", { name: "Customer", actorId: "local-admin" }]);

  const invalid = responseState();
  await handler(
    request("GET", "/api/billing/customers?limit=lots"),
    invalid.res,
    new URL("http://127.0.0.1/api/billing/customers?limit=lots"),
  );
  assert.equal(invalid.state.status, 400);
  assert.equal(invalid.state.data.code, "invalid_limit");

  assert.deepEqual(priceOptions(new URL("http://127.0.0.1/api/billing/prices?planId=&active=true&limit=12")), {
    limit: 12,
    offset: 0,
    planId: null,
    active: true,
  });
  assert.throws(
    () => priceOptions(new URL("http://127.0.0.1/api/billing/prices?active=maybe")),
    /active must be true or false/i,
  );
});

test("billing HTTP boundary converts credits exactly without floating point", () => {
  assert.equal(creditsToMicrocredits("12.345678", "amount", { allowZero: true }), "12345678");
  assert.equal(creditsToMicrocredits("-0.000001", "amount", { allowNegative: true }), "-1");
  assert.throws(() => creditsToMicrocredits("0.0000001", "amount", { allowZero: true }), /at most 6/i);
  assert.deepEqual(adaptPlanInput({ monthlyPrice: "9.5", includedCredits: "20", name: "Plan" }), {
    monthlyPriceMicrocredits: "9500000",
    includedMicrocredits: "20000000",
    name: "Plan",
  });
  assert.deepEqual(adaptPlanInput({ monthlyPrice: "0", includedCredits: "0", monthlyTokenLimit: "0", monthlyRequestLimit: "0" }), {
    monthlyPriceMicrocredits: "0",
    includedMicrocredits: null,
    monthlyTokenLimit: null,
    monthlyRequestLimit: null,
  });
  assert.deepEqual(adaptCustomerInput({ creditLimit: "0", monthlyTokenLimit: "0", monthlyRequestLimit: "100" }), {
    creditLimitMicrocredits: null,
    monthlyTokenLimit: null,
    monthlyRequestLimit: "100",
  });
  assert.deepEqual(adaptAdjustmentInput({ customerId: "c1", amountCredits: "-1.25" }), {
    customerId: "c1",
    deltaMicrocredits: "-1250000",
  });
  assert.deepEqual(adaptPriceInput({
    managerId: "vllm-manager",
    modelPattern: "Qwen/*",
    inputMicrocreditsPerMillion: "1000",
    outputMicrocreditsPerMillion: "2000",
  }), {
    managerId: "vllm-manager",
    modelPattern: "Qwen/*",
    inputMicrocreditsPerMillion: "1000",
    outputMicrocreditsPerMillion: "2000",
    model: "Qwen/*",
    inputPerMillionMicrocredits: "1000",
    outputPerMillionMicrocredits: "2000",
  });
  assert.throws(() => adaptPriceInput({ modelPattern: "*", inputPerMillionMicrocredits: "1", outputPerMillionMicrocredits: "1" }), /managerId is required/i);
  assert.deepEqual(localAdminInput({ actorId: "forged", name: "Customer" }), { actorId: "local-admin", name: "Customer" });
  assert.deepEqual(templateFilters(new URL("http://127.0.0.1/api/billing/templates?provider=OpenAI&tier=standard")), {
    provider: "OpenAI",
    tier: "standard",
  });
});

test("template HTTP routes list, preview, and dispatch confirmed atomic apply", async () => {
  const calls = [];
  const store = {
    applyPriceTemplates(input) {
      calls.push(input);
      return { catalogVersion: "2026-08-11.1", appliedAt: "2026-08-11T00:00:00.000Z", items: [] };
    },
  };
  const handler = createHandler(store);
  const listed = responseState();
  await handler(
    request("GET", "/api/billing/templates?provider=openai"),
    listed.res,
    new URL("http://127.0.0.1/api/billing/templates?provider=openai"),
  );
  assert.equal(listed.state.status, 200);
  assert.equal(listed.state.data.ok, true);
  assert.equal(listed.state.data.catalogVersion, "2026-08-11.1");
  assert.ok(listed.state.data.items.length >= 3);
  assert.ok(listed.state.data.items.every((item) => item.provider === "openai"));

  const body = {
    items: [{ templateId: "openai:gpt-5.6-sol:standard:le-272k", managerId: "vllm-manager", modelPattern: "local-sol", planId: null }],
    creditsPerUsd: "1",
    markupBps: "10000",
  };
  const previewed = responseState();
  await handler(
    request("POST", "/api/billing/templates/preview", body),
    previewed.res,
    new URL("http://127.0.0.1/api/billing/templates/preview"),
  );
  assert.equal(previewed.state.status, 200);
  assert.equal(previewed.state.data.items[0].inputPerMillionMicrocredits, "5000000");

  const applied = responseState();
  await handler(
    request("POST", "/api/billing/templates/apply", body),
    applied.res,
    new URL("http://127.0.0.1/api/billing/templates/apply"),
  );
  assert.equal(applied.state.status, 200);
  assert.deepEqual(calls, [body]);
});

test("billing POST with empty JSON body returns 400 instead of 500", async () => {
  const handler = createHandler({
    createCustomer() {
      throw new Error("should not create a customer from an empty body");
    },
  });
  const req = request("POST", "/api/billing/customers", null, { "content-type": "application/json" });
  req.raw = undefined;
  const res = responseState();
  await handler(req, res.res, new URL("http://127.0.0.1/api/billing/customers"));
  assert.equal(res.state.status, 400);
  assert.notEqual(res.state.status, 500);
  assert.equal(res.state.data.code, "invalid_json");
});
