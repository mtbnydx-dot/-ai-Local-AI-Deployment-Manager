"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BILLING_MANAGER_HEADER,
  buildBillingRequestHeaders,
  createBillingClient,
  normalizeBillingBaseUrl,
  verifyBillingRequest,
} = require("..");

function request(headers, body, options = {}) {
  return {
    method: "POST",
    url: options.url || "/internal/billing/authorize",
    headers,
    socket: { remoteAddress: options.remoteAddress || "127.0.0.1" },
    body,
  };
}

test("billing internal request signatures bind method, path, manager and exact body", () => {
  const token = "billing-test-token";
  const body = JSON.stringify({ requestId: "req-1", managerId: "vllm-manager" });
  const now = 1_800_000_000_000;
  const headers = buildBillingRequestHeaders(
    token,
    "POST",
    "/internal/billing/authorize",
    "vllm-manager",
    body,
    now,
  );
  assert.equal(headers[BILLING_MANAGER_HEADER], "vllm-manager");
  assert.deepEqual(
    verifyBillingRequest(request(headers, body), Buffer.from(body), token, { now }),
    { ok: true, managerId: "vllm-manager" },
  );
  assert.equal(verifyBillingRequest(request(headers, `${body} `), Buffer.from(`${body} `), token, { now }).ok, false);
  assert.equal(verifyBillingRequest(request(headers, body, { remoteAddress: "192.168.1.50" }), body, token, { now }).code, "billing_loopback_required");
  assert.equal(verifyBillingRequest(request(headers, body), body, token, { now: now + 61_000 }).code, "billing_signature_expired");
  assert.equal(verifyBillingRequest(request(headers, body, { url: "/internal/billing/settle" }), body, token, { now }).code, "billing_signature_invalid");
});

test("billing client signs loopback requests and never lets payload replace manager identity", async () => {
  const calls = [];
  const client = createBillingClient({
    managerId: "llama-manager",
    readToken: () => "billing-test-token",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      const verified = verifyBillingRequest(
        request(options.headers, options.body, { url: new URL(url).pathname }),
        Buffer.from(options.body),
        "billing-test-token",
      );
      assert.equal(verified.ok, true);
      return new Response(JSON.stringify({ ok: true, allowed: true, bound: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await client.authorize({ requestId: "req-2", managerId: "forged-manager" });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(calls[0].options.body).managerId, "llama-manager");
  assert.match(calls[0].url, /\/internal\/billing\/authorize$/);
});

test("billing settlement retries transient failures and stays idempotency-friendly", async () => {
  let attempts = 0;
  const client = createBillingClient({
    managerId: "vllm-manager",
    readToken: () => "billing-test-token",
    fetchFn: async () => {
      attempts += 1;
      if (attempts < 3) return new Response(JSON.stringify({ ok: false }), { status: 503 });
      return new Response(JSON.stringify({ ok: true, settled: true }), { status: 200 });
    },
  });
  const result = await client.settle({ requestId: "req-idempotent" });
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
});

test("billing client fails closed without trust and rejects non-loopback endpoints", async () => {
  const client = createBillingClient({
    managerId: "vllm-manager",
    readToken: () => "",
    fetchFn: async () => { throw new Error("must not be called"); },
  });
  const result = await client.authorize({ requestId: "req-3" });
  assert.equal(result.ok, false);
  assert.equal(result.allowed, false);
  assert.equal(result.code, "billing_unavailable");
  assert.throws(() => normalizeBillingBaseUrl("https://billing.example.com"), /loopback/i);
  assert.throws(() => normalizeBillingBaseUrl("http://127.0.0.1:5176/admin"), /must not contain/i);
});
