"use strict";

// Hop v2 (docs/overhaul/05-public.md §7.1, PUB-10): the one signed
// entry -> manager hop. The signature covers method, path, ip, ts, request
// id, principal and the sha256 of the context header.

const test = require("node:test");
const assert = require("node:assert/strict");
const trust = require("../gateway-trust");
const core = require("..");

const TOKEN = "fake-trust-token-for-hop-v2-tests";
const NOW = 1_800_000_000_000;
const REQUEST_ID = "req_abcdefghijklmnopqrst";
const PRINCIPAL = Object.freeze({ k: "vllm.egg", b: "vllm-manager", c: "egg", t: "vllm:egg", l: "public", p: "key", mo: 8192, mc: 2 });

// The context 04 TEL-2 attaches (rid, cid, src, cc, ing). It goes through
// buildEntryHeaders({ context }) as a plain object; gateway-trust.js does not
// know its fields, so 04 adds them without editing the module.
const TEL2_CONTEXT_FIXTURE = Object.freeze({
  rid: REQUEST_ID,
  cid: "client-supplied-17",
  src: "public",
  cc: "DE",
  ing: "entry",
});

function hop(input = {}, now = NOW) {
  return trust.buildEntryHeaders(TOKEN, {
    method: "POST",
    pathname: "/serve/v1/chat/completions",
    clientIp: "203.0.113.9",
    requestId: REQUEST_ID,
    principal: PRINCIPAL,
    context: TEL2_CONTEXT_FIXTURE,
    ...input,
  }, now);
}

function managerRequest(headers, overrides = {}) {
  return {
    method: "POST",
    originalUrl: "/serve/v1/chat/completions?stream=1",
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    ...overrides,
  };
}

function verify(req, options = {}) {
  return trust.verifyEntryRequest(req, { token: TOKEN, now: NOW, ...options });
}

test("hop v2 signs and verifies: principal, context, request id and the vouched ip", () => {
  const headers = hop();
  // v1 travels unchanged next to v2, so an older manager keeps working.
  assert.equal(headers[trust.GATEWAY_MARKER_HEADER], "1");
  assert.ok(headers[trust.GATEWAY_SIGNATURE_HEADER]);
  assert.equal(headers["x-request-id"], REQUEST_ID);
  assert.match(headers[trust.GATEWAY_CONTEXT_HEADER], /^v1\.[A-Za-z0-9_-]+$/);
  assert.ok(headers[trust.GATEWAY_CONTEXT_HEADER].length <= 512);

  const result = verify(managerRequest(headers));
  assert.equal(result.ok, true);
  assert.equal(result.version, 2);
  assert.equal(result.clientAddress, "203.0.113.9");
  assert.equal(result.requestId, REQUEST_ID);
  assert.deepEqual(result.principal, PRINCIPAL);
  assert.deepEqual(result.context, TEL2_CONTEXT_FIXTURE, "04's context arrives as it was attached");
  assert.equal(result.reason, "v2");
  // The core namespace exports the same functions.
  assert.equal(core.buildEntryHeaders, trust.buildEntryHeaders);
  assert.equal(core.verifyEntryRequest, trust.verifyEntryRequest);
});

test("tampering with the path, method, principal, context, ts, request id or ip is rejected", () => {
  const headers = hop();
  const rejected = (req, label) => {
    const result = verify(req);
    assert.equal(result.ok, false, label);
    assert.equal(result.principal, null, `${label}: no principal on a failed hop`);
    assert.equal(result.context, null, `${label}: no context on a failed hop`);
  };
  rejected(managerRequest(headers, { originalUrl: "/claude/v1/messages" }), "another route");
  rejected(managerRequest(headers, { method: "GET" }), "another method");
  const otherPrincipal = Buffer.from(JSON.stringify({ ...PRINCIPAL, b: null }), "utf8").toString("base64url");
  rejected(managerRequest({ ...headers, [trust.GATEWAY_PRINCIPAL_HEADER]: otherPrincipal }), "principal");
  const withoutPrincipal = { ...headers };
  delete withoutPrincipal[trust.GATEWAY_PRINCIPAL_HEADER];
  rejected(managerRequest(withoutPrincipal), "principal removed");
  const otherContext = trust.encodeEntryContext({ ...TEL2_CONTEXT_FIXTURE, src: "admin" });
  rejected(managerRequest({ ...headers, [trust.GATEWAY_CONTEXT_HEADER]: otherContext }), "context");
  rejected(managerRequest({ ...headers, [trust.GATEWAY_TIMESTAMP_HEADER]: String(NOW + 1) }), "ts");
  rejected(managerRequest({ ...headers, "x-request-id": "req_bbbbbbbbbbbbbbbbbbbb" }), "request id");
  rejected(managerRequest({ ...headers, [trust.GATEWAY_CLIENT_HEADER]: "127.0.0.1" }), "vouched ip");
  rejected(managerRequest({ ...headers, [trust.GATEWAY_SIGNATURE_V2_HEADER]: "forged" }), "signature");
  // The untouched hop still verifies, so each rejection above is the tamper.
  assert.equal(verify(managerRequest(headers)).ok, true);
});

test("a context swap between two hops is rejected", () => {
  const first = hop({ context: { ...TEL2_CONTEXT_FIXTURE, cid: "first" } });
  const second = hop({ context: { ...TEL2_CONTEXT_FIXTURE, cid: "second" } });
  assert.equal(verify(managerRequest(first)).ok, true);
  assert.equal(verify(managerRequest(second)).ok, true);
  const swapped = { ...first, [trust.GATEWAY_CONTEXT_HEADER]: second[trust.GATEWAY_CONTEXT_HEADER] };
  assert.equal(verify(managerRequest(swapped)).ok, false);
  const dropped = { ...first };
  delete dropped[trust.GATEWAY_CONTEXT_HEADER];
  assert.equal(verify(managerRequest(dropped)).ok, false, "removing the context breaks the signature too");
});

test("verifyEntryRequest returns version 0, 1 or 2 with principal and context only on a verified v2 hop", () => {
  const direct = verify({ method: "POST", originalUrl: "/serve/v1/chat/completions", headers: {}, socket: { remoteAddress: "192.168.1.20" } });
  assert.deepEqual(
    [direct.ok, direct.version, direct.clientAddress, direct.principal, direct.context, direct.requestId],
    [true, 0, "192.168.1.20", null, null, ""],
  );

  const v1Only = verify(managerRequest(trust.buildGatewayTrustHeaders(TOKEN, "192.168.1.30", NOW)));
  assert.deepEqual([v1Only.ok, v1Only.version, v1Only.clientAddress, v1Only.principal, v1Only.context], [true, 1, "192.168.1.30", null, null]);

  // A keyless ADMIN caller: a v2 hop without a principal or a context.
  const keyless = verify(managerRequest(hop({ principal: null, context: null })));
  assert.deepEqual([keyless.ok, keyless.version, keyless.principal, keyless.context], [true, 2, null, null]);

  // A context that does not parse: the hop is valid, the context is null.
  const garbled = verify(managerRequest(hop({ context: "v1.@@not-base64@@" })));
  assert.deepEqual([garbled.ok, garbled.version, garbled.context, garbled.reason], [true, 2, null, "context_invalid"]);
  assert.deepEqual(garbled.principal, PRINCIPAL);

  // The marker counts only from a loopback socket.
  const forged = verify(managerRequest(hop(), { socket: { remoteAddress: "192.168.1.40" } }));
  assert.deepEqual([forged.ok, forged.principal, forged.clientAddress], [false, null, "192.168.1.40"]);
  // A wrong token is a bad signature, not a downgrade to v1.
  const wrongToken = trust.verifyEntryRequest(managerRequest(hop()), { token: "fake-other-token", now: NOW });
  assert.deepEqual([wrongToken.ok, wrongToken.version, wrongToken.principal], [false, 2, null]);
  // No token at all: untrusted.
  assert.equal(trust.verifyEntryRequest(managerRequest(hop()), { token: "", now: NOW }).ok, false);
});

test("v2 enforces a 60 s window while v1 keeps its 5 min window", () => {
  const headers = hop();
  assert.equal(verify(managerRequest(headers), { now: NOW + 59_000 }).ok, true);
  const late = verify(managerRequest(headers), { now: NOW + 61_000 });
  assert.deepEqual([late.ok, late.reason, late.principal], [false, "signature_expired", null]);
  assert.equal(verify(managerRequest(headers), { now: NOW - 61_000 }).ok, false, "a hop from the future is expired as well");

  const v1 = trust.buildGatewayTrustHeaders(TOKEN, "192.168.1.30", NOW);
  assert.equal(verify(managerRequest(v1), { now: NOW + 4 * 60_000 }).ok, true);
  assert.equal(verify(managerRequest(v1), { now: NOW + 6 * 60_000 }).ok, false);
});

test("buildEntryHeaders adds v2 only for an entry request id and drops an oversized context", () => {
  const clientId = hop({ requestId: "client-chosen-id" });
  assert.equal(clientId[trust.GATEWAY_SIGNATURE_V2_HEADER], undefined, "no req_ id, no v2 (and no principal)");
  assert.equal(clientId[trust.GATEWAY_PRINCIPAL_HEADER], undefined);
  assert.ok(clientId[trust.GATEWAY_SIGNATURE_HEADER], "v1 is still sent");
  assert.equal(verify(managerRequest(clientId)).version, 1);

  const oversized = hop({ context: { ...TEL2_CONTEXT_FIXTURE, cid: "x".repeat(600) } });
  assert.equal(oversized[trust.GATEWAY_CONTEXT_HEADER], undefined);
  const result = verify(managerRequest(oversized));
  assert.deepEqual([result.ok, result.context], [true, null]);

  // Without a token only the marker is sent, exactly as v1 did.
  assert.deepEqual(trust.buildEntryHeaders("", { requestId: REQUEST_ID, principal: PRINCIPAL }, NOW), { [trust.GATEWAY_MARKER_HEADER]: "1" });
});

test("resolveRequestOrigin uses verifyEntryRequest: the vouched address and the v2 principal", () => {
  const origin = trust.resolveRequestOrigin(managerRequest(hop()), { token: TOKEN, now: NOW });
  assert.deepEqual(
    [origin.viaGateway, origin.trusted, origin.address, origin.socketAddress, origin.version, origin.requestId],
    [true, true, "203.0.113.9", "127.0.0.1", 2, REQUEST_ID],
  );
  assert.deepEqual(origin.principal, PRINCIPAL);
  const tampered = trust.resolveRequestOrigin(managerRequest(hop(), { originalUrl: "/opencode/v1/chat/completions" }), { token: TOKEN, now: NOW });
  assert.deepEqual([tampered.trusted, tampered.address, tampered.principal], [false, "127.0.0.1", null]);
  const v1 = trust.resolveRequestOrigin(managerRequest(trust.buildGatewayTrustHeaders(TOKEN, "192.168.1.30", NOW)), { token: TOKEN, now: NOW + 4 * 60_000 });
  assert.deepEqual([v1.trusted, v1.address, v1.version, v1.principal], [true, "192.168.1.30", 1, null]);
  const direct = trust.resolveRequestOrigin({ headers: {}, socket: { remoteAddress: "::ffff:192.168.1.8" } }, { token: TOKEN });
  assert.deepEqual([direct.viaGateway, direct.trusted, direct.version], [false, true, 0]);
});
