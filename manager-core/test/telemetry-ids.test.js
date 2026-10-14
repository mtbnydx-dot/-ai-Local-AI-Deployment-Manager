"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const ids = require("../telemetry/ids");
const gateway = require("../gateway-utils");

const REQ_PATTERN = /^req_[a-z2-7]{20}$/;
const MGR_PATTERN = /^mgr_[a-z2-7]{20}$/;

test("newRequestId and newDirectRequestId use the 00 §3 format", () => {
  for (let index = 0; index < 200; index += 1) {
    const requestId = ids.newRequestId();
    const directId = ids.newDirectRequestId();
    assert.match(requestId, REQ_PATTERN);
    assert.match(directId, MGR_PATTERN);
    assert.equal(requestId.length, 24);
    assert.equal(ids.isTelemetryRequestId(requestId), true);
    assert.equal(ids.isTelemetryRequestId(directId), true);
  }
});

test("ids carry 100 random bits: unique, and every base32 symbol appears at every position", () => {
  const samples = 20000;
  const seen = new Set();
  const counts = Array.from({ length: 20 }, () => new Map());
  for (let index = 0; index < samples; index += 1) {
    const body = ids.newRequestId().slice(4);
    seen.add(body);
    for (let position = 0; position < body.length; position += 1) {
      const symbol = body[position];
      counts[position].set(symbol, (counts[position].get(symbol) || 0) + 1);
    }
  }
  assert.equal(seen.size, samples, "no collisions");
  const expected = samples / 32;
  for (let position = 0; position < 20; position += 1) {
    // The last position holds 5 bits like every other one, so it is not
    // constrained to a subset of the alphabet.
    assert.equal(counts[position].size, 32, `all 32 symbols at position ${position}`);
    for (const [symbol, count] of counts[position]) {
      assert.ok(ids.BASE32_ALPHABET.includes(symbol));
      // About 25 standard deviations either side; only a broken generator fails.
      assert.ok(count > expected * 0.6 && count < expected * 1.4, `symbol ${symbol} at ${position}: ${count}`);
    }
  }
});

test("isTelemetryRequestId rejects anything outside the two prefixes and the base32 alphabet", () => {
  for (const value of [
    "",
    "req_",
    "req_abcdefghijklmnopqrs",
    "req_abcdefghijklmnopqrstu",
    "REQ_abcdefghijklmnopqrst",
    "req_ABCDEFGHIJKLMNOPQRST",
    "req_abcdefghijklmnopqrs0",
    "req_abcdefghijklmnopqrs1",
    "imp_abcdefghijklmnopqrst",
    "lch_abcdefghijklmnopqrst",
    "3f1c7e4a-9b2d-4c8e-a1f0-5d6b7c8e9f00",
    null,
    42,
  ]) {
    assert.equal(ids.isTelemetryRequestId(value), false, String(value));
  }
  assert.equal(ids.isTelemetryRequestId("req_abcdefghijklmnopqrst"), true);
  assert.equal(ids.isTelemetryRequestId("mgr_234567abcdefghijklmn"), true);
});

test("the unchanged manager normaliser accepts req_ and mgr_ ids (F6 withdrawn)", () => {
  // The example from 04 §5.2 and freshly minted ids pass through unchanged.
  for (const requestId of ["req_k3m9q2x7p4a8c5d1h6j0", ids.newRequestId(), ids.newDirectRequestId()]) {
    assert.equal(gateway.normalizeOpenAiGatewayRequestId(requestId), requestId);
    const req = { headers: { "x-request-id": requestId } };
    assert.equal(gateway.ensureOpenAiGatewayRequestId(req), requestId);
    assert.equal(req.serviceGateway.requestId, requestId);
  }
});

test("normalizeClientRequestId keeps valid client ids and drops the rest", () => {
  assert.equal(ids.normalizeClientRequestId("client-request-1"), "client-request-1");
  assert.equal(ids.normalizeClientRequestId("  trace:abc/def.1_2-3  "), "trace:abc/def.1_2-3");
  assert.equal(ids.normalizeClientRequestId(["first-id", "second-id"]), "first-id");
  assert.equal(ids.normalizeClientRequestId("a".repeat(128)), "a".repeat(128));
  assert.equal(ids.normalizeClientRequestId("a".repeat(129)), "");
  assert.equal(ids.normalizeClientRequestId("has space"), "");
  assert.equal(ids.normalizeClientRequestId("semi;colon"), "");
  assert.equal(ids.normalizeClientRequestId("中文"), "");
  assert.equal(ids.normalizeClientRequestId(""), "");
  assert.equal(ids.normalizeClientRequestId(undefined), "");
  assert.equal(ids.normalizeClientRequestId(null), "");
});

test("normalizeClientRequestId agrees with the manager normaliser on every input", () => {
  const inputs = [
    "client-request-1", " padded ", "a".repeat(128), "a".repeat(129), "é".repeat(64), "é".repeat(65),
    "x\ny", "tab\there", "colon:slash/dot.under_score-dash", "", "   ", ["array-value"], [], 12345,
    "req_k3m9q2x7p4a8c5d1h6j0", "<script>", "%41", "trailing/",
  ];
  for (const input of inputs) {
    assert.equal(ids.normalizeClientRequestId(input), gateway.normalizeOpenAiGatewayRequestId(input), JSON.stringify(input));
  }
});
