"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const internalAuth = require("../internal-auth");
const billing = require("../billing-client");
const core = require("..");
const golden = require("./golden/internal-auth.json");

const {
  INTERNAL_PATH_PREFIXES,
  MACHINE_PRINCIPAL_RE,
  bodySha256Hex,
  signInternal,
  buildInternalRequestHeaders,
  verifyInternalRequest,
  buildMachineHeaders,
  verifyMachineSignature,
  readInternalKey,
  createInternalClient,
} = internalAuth;

const TOKEN = "fake-internal-auth-token-for-tests";

function fixtureBody(fixture) {
  return fixture.bodyBase64 !== undefined ? Buffer.from(fixture.bodyBase64, "base64") : fixture.body;
}

function fakeRequest({ method = "POST", url, headers = {}, remoteAddress = "127.0.0.1" }) {
  return { method, url, headers, socket: { remoteAddress } };
}

// Signs the manager form by hand, the way a token holder could for any path,
// so the path allowlist is tested on its own rather than through the builder.
function manualManagerHeaders(token, { method = "POST", pathname, managerId = "vllm-manager", ts, body = "" }) {
  return {
    "x-ai-billing-manager": managerId,
    "x-ai-billing-ts": String(ts),
    "x-ai-billing-signature": signInternal(token, {
      method,
      path: pathname,
      principal: managerId,
      ts: String(ts),
      bodySha256: bodySha256Hex(body),
    }),
    "x-ai-billing-version": "1",
  };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "internal-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

let mtimeSeq = 0;
function writeTrustFile(root, token, { mtimeSeconds } = {}) {
  const file = path.join(root, ".gateway-trust.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, token, pid: 0, issuedAt: new Date(0).toISOString() }));
  // Explicit, strictly increasing mtimes keep the reader's mtime check deterministic.
  mtimeSeq += 1;
  const stamp = mtimeSeconds ?? (Math.floor(Date.now() / 1000) + mtimeSeq * 10);
  fs.utimesSync(file, stamp, stamp);
  return stamp;
}

async function startServer(t, handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      await handler(req, res, Buffer.concat(chunks));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "test_handler_failed", message: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function captureConsole(t) {
  const lines = [];
  const methods = ["log", "info", "warn", "error", "debug"];
  const originals = Object.fromEntries(methods.map((name) => [name, console[name]]));
  for (const name of methods) console[name] = (...args) => { lines.push(args.map(String).join(" ")); };
  const originalWarning = process.emitWarning;
  process.emitWarning = (...args) => { lines.push(args.map(String).join(" ")); };
  t.after(() => {
    for (const name of methods) console[name] = originals[name];
    process.emitWarning = originalWarning;
  });
  return lines;
}

function errorText(error) {
  return [String(error?.message || ""), String(error?.stack || ""), JSON.stringify(error ?? null)].join("\n");
}

test("golden: billing-form signatures are byte-identical to the pre-overhaul billing signer", () => {
  assert.equal(golden.billing.length, 5);
  for (const fixture of golden.billing) {
    const body = fixtureBody(fixture);
    const expected = fixture.expected;
    assert.equal(bodySha256Hex(body), expected.bodySha256, fixture.name);
    assert.equal(billing.billingBodyHash(body), expected.bodySha256, fixture.name);
    // The billing names still produce the captured bytes.
    assert.equal(
      billing.signBillingRequest(fixture.token, fixture.method, fixture.path, fixture.managerId, String(fixture.ts), body),
      expected.signature,
      fixture.name,
    );
    const billingHeaders = billing.buildBillingRequestHeaders(fixture.token, fixture.method, fixture.path, fixture.managerId, body, fixture.ts);
    assert.equal(JSON.stringify(billingHeaders), JSON.stringify(expected.headers), fixture.name);
    // The generic manager form is the same wire format.
    const internalHeaders = buildInternalRequestHeaders(fixture.token, fixture.method, fixture.path, fixture.managerId, body, fixture.ts);
    assert.equal(JSON.stringify(internalHeaders), JSON.stringify(expected.headers), fixture.name);
    assert.equal(signInternal(fixture.token, {
      method: fixture.method || "POST",
      path: fixture.path.split("?")[0],
      principal: fixture.managerId.trim().toLowerCase(),
      ts: String(fixture.ts),
      bodySha256: expected.bodySha256,
    }), expected.signature, fixture.name);
    // And both verifiers accept the captured headers.
    const req = fakeRequest({ method: String(fixture.method || "POST").toUpperCase(), url: fixture.path, headers: expected.headers });
    const options = { now: fixture.ts, allowedManagers: [fixture.managerId] };
    const managerId = fixture.managerId.trim().toLowerCase();
    assert.deepEqual(verifyInternalRequest(req, body, fixture.token, options), { ok: true, managerId }, fixture.name);
    assert.deepEqual(billing.verifyBillingRequest(req, body, fixture.token, options), { ok: true, managerId }, fixture.name);
  }
});

test("golden: machine-form headers follow the section 5.7 formula", () => {
  assert.ok(golden.machine.length >= 3);
  for (const fixture of golden.machine) {
    const headers = buildMachineHeaders(fixture.token, {
      method: fixture.method,
      pathWithQuery: fixture.pathWithQuery,
      principal: fixture.principal,
      body: fixture.body,
      now: fixture.ts,
    });
    assert.equal(JSON.stringify(headers), JSON.stringify(fixture.expected.headers), fixture.name);
    const req = fakeRequest({ method: fixture.method, url: fixture.pathWithQuery, headers });
    assert.deepEqual(
      verifyMachineSignature(req, fixture.token, { now: fixture.ts }),
      { ok: true, principal: fixture.principal, bodySha256: fixture.expected.bodySha256 },
      fixture.name,
    );
  }
});

test("verifyInternalRequest accepts exactly the four internal prefixes", () => {
  const now = 1_800_000_000_000;
  assert.deepEqual([...INTERNAL_PATH_PREFIXES], [
    "/internal/billing/",
    "/internal/access/",
    "/internal/telemetry/",
    "/internal/models/",
  ]);
  assert.ok(Object.isFrozen(INTERNAL_PATH_PREFIXES));
  for (const prefix of INTERNAL_PATH_PREFIXES) {
    const pathname = `${prefix}probe`;
    const body = JSON.stringify({ probe: prefix });
    const headers = buildInternalRequestHeaders(TOKEN, "POST", pathname, "vllm-manager", body, now);
    assert.ok(headers["x-ai-billing-signature"], pathname);
    assert.deepEqual(
      verifyInternalRequest(fakeRequest({ url: pathname, headers }), body, TOKEN, { now }),
      { ok: true, managerId: "vllm-manager" },
      pathname,
    );
  }
  const rejected = [
    "/internal/other/probe",
    "/internal/billing",
    "/internal/",
    "/api/status",
    "/api/hub/downloads",
    "/gateway/auto/openai/v1/models",
    "/internal/telemetry/../billing/authorize",
    "/internal/models/%2e%2e/x",
    "/internal/access\\x",
    "internal/billing/authorize",
  ];
  for (const pathname of rejected) {
    // The builder refuses to sign these at all...
    assert.deepEqual(buildInternalRequestHeaders(TOKEN, "POST", pathname, "vllm-manager", "", now), {}, pathname);
    // ...and a hand-signed request is still refused by the path gate.
    const headers = manualManagerHeaders(TOKEN, { pathname, ts: now });
    assert.deepEqual(
      verifyInternalRequest(fakeRequest({ url: pathname, headers }), "", TOKEN, { now }),
      { ok: false, code: "internal_path_not_allowed" },
      pathname,
    );
  }
});

test("caller prefixes narrow the allowlist but can never widen it", () => {
  const now = 1_800_000_000_000;
  const telemetry = "/internal/telemetry/requests";
  const billingPath = "/internal/billing/authorize";
  const narrowed = { now, pathPrefixes: ["/internal/telemetry/"] };
  const telemetryHeaders = buildInternalRequestHeaders(TOKEN, "POST", telemetry, "llama-manager", "{}", now);
  assert.equal(verifyInternalRequest(fakeRequest({ url: telemetry, headers: telemetryHeaders }), "{}", TOKEN, narrowed).ok, true);
  const billingHeaders = buildInternalRequestHeaders(TOKEN, "POST", billingPath, "llama-manager", "{}", now);
  assert.equal(
    verifyInternalRequest(fakeRequest({ url: billingPath, headers: billingHeaders }), "{}", TOKEN, narrowed).code,
    "internal_path_not_allowed",
  );
  const hubPath = "/api/hub/downloads";
  const hubHeaders = manualManagerHeaders(TOKEN, { pathname: hubPath, ts: now });
  assert.equal(
    verifyInternalRequest(fakeRequest({ url: hubPath, headers: hubHeaders }), "", TOKEN, { now, pathPrefixes: ["/api/hub/"] }).code,
    "internal_path_not_allowed",
  );
});

test("manager form rejects tampered method, path, manager, ts or body and enforces a 60 s window", () => {
  const now = 1_800_000_000_000;
  const pathname = "/internal/telemetry/requests";
  const body = JSON.stringify({ rows: [{ requestId: "req_aaaaaaaaaaaaaaaaaaaa" }] });
  const headers = buildInternalRequestHeaders(TOKEN, "POST", pathname, "vllm-manager", body, now);
  const verify = (overrides = {}, options = {}) => verifyInternalRequest(
    fakeRequest({ url: pathname, headers, ...overrides }),
    overrides.body ?? body,
    options.token ?? TOKEN,
    { now, ...options },
  );
  assert.deepEqual(verify(), { ok: true, managerId: "vllm-manager" });
  // The manager form signs the pathname only; the query is not part of it.
  assert.equal(verify({ url: `${pathname}?page=2` }).ok, true);
  assert.equal(verify({ method: "PUT" }).code, "internal_signature_invalid");
  assert.equal(verify({ url: "/internal/telemetry/events" }).code, "internal_signature_invalid");
  assert.equal(verify({ body: `${body} ` }).code, "internal_signature_invalid");
  assert.equal(verify({ headers: { ...headers, "x-ai-billing-manager": "llama-manager" } }).code, "internal_signature_invalid");
  assert.equal(verify({ headers: { ...headers, "x-ai-billing-manager": "forged-manager" } }).code, "internal_manager_not_allowed");
  assert.equal(verify({ headers: { ...headers, "x-ai-billing-ts": String(now + 1) } }).code, "internal_signature_invalid");
  assert.equal(verify({}, { token: "fake-other-token" }).code, "internal_signature_invalid");
  assert.equal(verify({ headers: { ...headers, "x-ai-billing-version": "2" } }).code, "internal_signature_missing");
  assert.equal(verify({ headers: {} }).code, "internal_manager_not_allowed");
  assert.equal(verify({ remoteAddress: "192.168.1.50" }).code, "internal_loopback_required");
  assert.equal(verify({}, { now: now + 60_000 }).ok, true);
  assert.equal(verify({}, { now: now + 60_001 }).code, "internal_signature_expired");
  assert.equal(verify({}, { now: now - 61_000 }).code, "internal_signature_expired");
  // Billing paths keep the billing_* codes through the same verifier.
  const billingPath = "/internal/billing/settle";
  const billingHeaders = buildInternalRequestHeaders(TOKEN, "POST", billingPath, "vllm-manager", body, now);
  const billingReq = fakeRequest({ url: billingPath, headers: billingHeaders });
  assert.equal(verifyInternalRequest(billingReq, body, TOKEN, { now: now + 61_000 }).code, "billing_signature_expired");
  assert.equal(verifyInternalRequest(billingReq, `${body}x`, TOKEN, { now }).code, "billing_signature_invalid");
  assert.equal(
    verifyInternalRequest({ ...billingReq, socket: { remoteAddress: "10.0.0.8" } }, body, TOKEN, { now }).code,
    "billing_loopback_required",
  );
});

test("verifyBillingRequest keeps its historical codes on top of internal-auth", () => {
  const now = 1_800_000_000_000;
  const body = JSON.stringify({ requestId: "req-1", managerId: "vllm-manager" });
  const headers = billing.buildBillingRequestHeaders(TOKEN, "POST", "/internal/billing/authorize", "vllm-manager", body, now);
  const verify = (overrides = {}, options = {}) => billing.verifyBillingRequest(
    fakeRequest({ url: "/internal/billing/authorize", headers, ...overrides }),
    body,
    TOKEN,
    { now, ...options },
  );
  assert.deepEqual(verify(), { ok: true, managerId: "vllm-manager" });
  assert.equal(verify({ remoteAddress: "192.168.1.50" }).code, "billing_loopback_required");
  assert.equal(verify({ headers: { ...headers, "x-ai-billing-manager": "other" } }).code, "billing_manager_not_allowed");
  assert.equal(verify({ url: "/internal/telemetry/requests" }).code, "billing_signature_missing");
  assert.equal(verify({}, { now: now + 61_000 }).code, "billing_signature_expired");
  assert.equal(verify({ url: "/internal/billing/settle" }).code, "billing_signature_invalid");
  assert.deepEqual(billing.buildBillingRequestHeaders(TOKEN, "POST", "/internal/telemetry/requests", "vllm-manager", body, now), {});
});

test("machine form binds the query and rejects tampered method, path, principal, ts or body digest", () => {
  const now = 1_800_000_000_000;
  const pathWithQuery = "/api/events?types=downloads,library,jobs";
  const headers = buildMachineHeaders(TOKEN, { method: "GET", pathWithQuery, principal: "system:hub-shim:vllm", now });
  const verify = (overrides = {}, options = {}) => verifyMachineSignature(
    fakeRequest({ method: "GET", url: pathWithQuery, headers, ...overrides }),
    options.token ?? TOKEN,
    { now, ...options },
  );
  assert.deepEqual(verify(), { ok: true, principal: "system:hub-shim:vllm", bodySha256: bodySha256Hex("") });
  // Query binding: adding, removing or changing a parameter breaks the signature.
  assert.equal(verify({ url: "/api/events?types=downloads,library,jobs,status" }).code, "internal_signature_invalid");
  assert.equal(verify({ url: "/api/events" }).code, "internal_signature_invalid");
  assert.equal(verify({ url: "/api/events?types=jobs,library,downloads" }).code, "internal_signature_invalid");
  assert.equal(verify({ method: "POST" }).code, "internal_signature_invalid");
  assert.equal(verify({ url: "/api/hub/downloads?types=downloads,library,jobs" }).code, "internal_signature_invalid");
  assert.equal(verify({ headers: { ...headers, "x-ai-internal-principal": "system:hub-shim:llama" } }).code, "internal_signature_invalid");
  assert.equal(verify({ headers: { ...headers, "x-ai-internal-principal": "system:cli" } }).code, "internal_signature_invalid");
  assert.equal(verify({ headers: { ...headers, "x-ai-internal-principal": "system:root" } }).code, "internal_principal_not_allowed");
  assert.equal(verify({ headers: { ...headers, "x-ai-internal-ts": String(now - 1) } }).code, "internal_signature_invalid");
  assert.equal(verify({ headers: { ...headers, "x-ai-internal-body-sha256": bodySha256Hex("{}") } }).code, "internal_signature_invalid");
  assert.equal(verify({ headers: { ...headers, "x-ai-internal-body-sha256": "not-a-digest" } }).code, "internal_signature_invalid");
  assert.equal(verify({ headers: { ...headers, "x-ai-internal-version": "2" } }).code, "internal_signature_invalid");
  assert.equal(verify({}, { token: "fake-other-token" }).code, "internal_signature_invalid");
  assert.equal(verify({ remoteAddress: "192.168.1.50" }).code, "internal_loopback_required");
  assert.equal(verify({}, { now: now + 60_000 }).ok, true);
  assert.equal(verify({}, { now: now + 61_000 }).code, "internal_signature_expired");
  assert.equal(verify({}, { now: now - 61_000 }).code, "internal_signature_expired");
  // No machine header at all is "missing", so the caller judges other credentials.
  assert.equal(verify({ headers: {} }).code, "internal_signature_missing");
  assert.equal(verify({ headers: { "x-hub-shim": "1" } }).code, "internal_signature_missing");
  // An absolute-form request target is reduced to pathname + search.
  assert.equal(verify({ url: `http://127.0.0.1:5176${pathWithQuery}` }).ok, true);
});

test("machine form carries the body digest for the caller to check before a route runs", () => {
  const now = 1_800_000_000_000;
  const body = JSON.stringify({ repo: "example/demo-model" });
  const headers = buildMachineHeaders(TOKEN, { method: "POST", pathWithQuery: "/api/hub/downloads", principal: "system:hub-shim:llama", body, now });
  const verified = verifyMachineSignature(fakeRequest({ url: "/api/hub/downloads", headers }), TOKEN, { now });
  assert.equal(verified.ok, true);
  assert.equal(verified.bodySha256, bodySha256Hex(body));
  assert.equal(verified.bodySha256, bodySha256Hex(Buffer.from(body)));
  assert.notEqual(verified.bodySha256, bodySha256Hex(`${body} `));
});

test("machine principals are exactly the section 5.7 set", () => {
  for (const principal of ["system:hub-shim:vllm", "system:hub-shim:llama", "system:supervisor", "system:cli", "system:mcp"]) {
    assert.match(principal, MACHINE_PRINCIPAL_RE);
    assert.ok(buildMachineHeaders(TOKEN, { method: "GET", pathWithQuery: "/api/status", principal })["x-ai-internal-signature"]);
  }
  for (const principal of ["system:hub-shim", "system:hub-shim:other", "system:supervisor ", "user:cli", "system:cli:extra", "SYSTEM:CLI", ""]) {
    assert.doesNotMatch(principal, MACHINE_PRINCIPAL_RE);
    assert.deepEqual(buildMachineHeaders(TOKEN, { method: "GET", pathWithQuery: "/api/status", principal }), {});
  }
  assert.deepEqual(buildMachineHeaders("", { method: "GET", pathWithQuery: "/api/status", principal: "system:cli" }), {});
  assert.deepEqual(buildMachineHeaders(TOKEN, { method: "GET", pathWithQuery: "//elsewhere/api", principal: "system:cli" }), {});
});

test("readInternalKey follows the trust file and has no stale cache across rotations", { timeout: 15000 }, (t) => {
  const root = tempRoot(t);
  const readKey = readInternalKey({ aiRoot: root, envName: "INTERNAL_AUTH_TEST_UNSET_TOKEN" });
  assert.equal(readKey(), "");
  writeTrustFile(root, "fake-token-one");
  assert.equal(readKey(), "fake-token-one");
  writeTrustFile(root, "fake-token-two");
  assert.equal(readKey(), "fake-token-two");
});

test("createInternalClient signs in the manager form and follows a rotated trust file", { timeout: 15000 }, async (t) => {
  const root = tempRoot(t);
  let serverToken = "fake-token-a";
  writeTrustFile(root, serverToken);
  const hits = [];
  const baseUrl = await startServer(t, (req, res, raw) => {
    const verified = verifyInternalRequest(req, raw, serverToken, { pathPrefixes: ["/internal/telemetry/"] });
    hits.push({ url: req.url, ok: verified.ok, code: verified.code });
    if (!verified.ok) return sendJson(res, 401, { ok: false, code: verified.code });
    return sendJson(res, 200, { ok: true, managerId: verified.managerId, received: JSON.parse(raw.toString("utf8")) });
  });
  const client = createInternalClient({ managerId: "vllm-manager", aiRoot: root, baseUrl });
  assert.equal(client.managerId, "vllm-manager");
  const first = await client.request("POST", "/internal/telemetry/requests", { rows: [1] });
  assert.deepEqual(first, { status: 200, json: { ok: true, managerId: "vllm-manager", received: { rows: [1] } } });

  // The entry restarts with a new token: the next call reads it, with no 401 round trip.
  serverToken = "fake-token-b";
  writeTrustFile(root, serverToken);
  const second = await client.request("POST", "/internal/telemetry/events", { rows: [2] });
  assert.equal(second.status, 200);
  assert.deepEqual(hits.map((hit) => hit.ok), [true, true]);

  // Paths outside the allowlist never leave the client.
  await assert.rejects(client.request("POST", "/internal/other/x", {}), { code: "internal_path_not_allowed" });
  await assert.rejects(client.request("GET", "/api/status"), { code: "internal_path_not_allowed" });
  await assert.rejects(client.request("GET", "//elsewhere.example/internal/telemetry/x"), { code: "internal_path_not_allowed" });
  assert.equal(hits.length, 2);
});

test("createInternalClient re-reads the key and retries exactly once on 401", { timeout: 15000 }, async (t) => {
  const root = tempRoot(t);
  let serverToken = "fake-token-old";
  const stamp = writeTrustFile(root, serverToken);
  const hits = [];
  const baseUrl = await startServer(t, (req, res, raw) => {
    const verified = verifyInternalRequest(req, raw, serverToken, { allowedManagers: ["llama-manager"] });
    hits.push(verified.ok);
    if (!verified.ok) return sendJson(res, 401, { ok: false, code: verified.code });
    return sendJson(res, 200, { ok: true });
  });
  const client = createInternalClient({ managerId: "llama-manager", aiRoot: root, baseUrl });
  assert.equal((await client.request("POST", "/internal/models/host-records", { a: 1 })).status, 200);

  // Rotate behind the client's back with an unchanged mtime, so only a fresh
  // read after the 401 can see the new token.
  serverToken = "fake-token-new";
  writeTrustFile(root, serverToken, { mtimeSeconds: stamp });
  const retried = await client.request("POST", "/internal/models/host-records", { a: 2 });
  assert.equal(retried.status, 200);
  assert.deepEqual(hits, [true, false, true]);

  // A rejection that a fresh key does not cure is retried once, then returned.
  serverToken = "fake-token-the-client-never-sees";
  const denied = await client.request("POST", "/internal/models/host-records", { a: 3 });
  assert.deepEqual(denied, { status: 401, json: { ok: false, code: "internal_signature_invalid" } });
  assert.deepEqual(hits, [true, false, true, false, false]);
});

test("createInternalClient signs machine principals with the query bound", { timeout: 15000 }, async (t) => {
  const root = tempRoot(t);
  writeTrustFile(root, TOKEN);
  const seen = [];
  const baseUrl = await startServer(t, (req, res, raw) => {
    const verified = verifyMachineSignature(req, TOKEN);
    const bodyOk = verified.ok && verified.bodySha256 === bodySha256Hex(raw);
    seen.push({ method: req.method, url: req.url, principal: verified.principal, bodyOk, accept: req.headers.accept, requestId: req.headers["x-request-id"] });
    if (!verified.ok || !bodyOk) return sendJson(res, 401, { ok: false, code: verified.code || "internal_body_mismatch" });
    return sendJson(res, 200, { ok: true });
  });
  const client = createInternalClient({ principal: "system:supervisor", aiRoot: root, baseUrl });
  assert.equal(client.principal, "system:supervisor");
  assert.equal((await client.request("GET", "/api/status?verbose=1")).status, 200);
  assert.equal((await client.request("POST", "/api/manager/shutdown", { reason: "test" }, {
    headers: { "x-request-id": "mgr_test", "x-ai-internal-principal": "system:cli" },
  })).status, 200);
  assert.deepEqual(seen, [
    { method: "GET", url: "/api/status?verbose=1", principal: "system:supervisor", bodyOk: true, accept: "application/json", requestId: undefined },
    { method: "POST", url: "/api/manager/shutdown", principal: "system:supervisor", bodyOk: true, accept: "application/json", requestId: "mgr_test" },
  ]);
});

test("createInternalClient validates its identity and base URL", () => {
  assert.throws(() => createInternalClient({}), /principal or manager id/i);
  assert.throws(() => createInternalClient({ principal: "system:root" }), /known machine principal/i);
  assert.throws(() => createInternalClient({ principal: "system:cli", managerId: "vllm-manager" }), /not both/i);
  assert.throws(() => createInternalClient({ managerId: "vllm-manager", baseUrl: "https://entry.example.com" }), /loopback/i);
  assert.throws(() => createInternalClient({ managerId: "vllm-manager", baseUrl: "http://127.0.0.1:5176/api" }), /must not contain/i);
  const client = createInternalClient({ managerId: "vllm-manager", readKey: () => TOKEN, fetchFn: async () => new Response("{}") });
  assert.equal(client.baseUrl, "http://127.0.0.1:5176");
});

test("sse holds a signed stream, retries once on 401 and resumes with Last-Event-ID", { timeout: 15000 }, async (t) => {
  const root = tempRoot(t);
  let serverToken = "fake-sse-token-old";
  const stamp = writeTrustFile(root, serverToken);
  const connections = [];
  const baseUrl = await startServer(t, (req, res) => {
    const verified = verifyMachineSignature(req, serverToken);
    connections.push({ ok: verified.ok, url: req.url, lastEventId: req.headers["last-event-id"] || "", accept: req.headers.accept });
    if (!verified.ok) return sendJson(res, 401, { ok: false, code: verified.code });
    if (!req.url.startsWith("/api/events")) return sendJson(res, 200, { ok: true });
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (connections.filter((item) => item.ok && item.url.startsWith("/api/events")).length === 1) {
      res.write(": keep-alive\n\n");
      res.write("id: 1\nevent: status\ndata: {\"type\":\"status\",\"data\":{\"ok\":true}}\n\n");
      res.write("id: 2\r\nevent: notification\r\ndata: {\"type\":\"notification\",");
      res.write("\"data\":{\"title\":\"x\"}}\r");
      res.write("\n\r\n");
      res.end();
      return undefined;
    }
    res.write("id: 3\ndata: plain text\ndata: second line\n\n");
    return undefined;
  });

  const client = createInternalClient({ principal: "system:supervisor", aiRoot: root, baseUrl });
  // A first call caches the old token in the client's reader.
  assert.equal((await client.request("GET", "/api/status")).status, 200);
  // The entry then rotates its token without moving the file mtime, so the
  // first stream connect is refused and only the 401 re-read can recover.
  serverToken = "fake-sse-token-new";
  writeTrustFile(root, serverToken, { mtimeSeconds: stamp });

  const events = [];
  const errors = [];
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const stream = client.sse("/api/events?client=supervisor&types=status,notification", (event) => {
    events.push(event);
    if (events.length === 3) resolveDone();
  }, { retryMs: 20, onError: (error) => errors.push(error) });
  t.after(() => stream.close());
  await done;
  stream.close();

  assert.deepEqual(events, [
    { id: "1", event: "status", data: { type: "status", data: { ok: true } } },
    { id: "2", event: "notification", data: { type: "notification", data: { title: "x" } } },
    { id: "3", event: "message", data: "plain text\nsecond line" },
  ]);
  const sseConnections = connections.filter((item) => item.url.startsWith("/api/events"));
  assert.deepEqual(sseConnections.map((item) => [item.ok, item.lastEventId]), [
    [false, ""],
    [true, ""],
    [true, "2"],
  ]);
  assert.ok(sseConnections.every((item) => item.accept === "text/event-stream"));
  assert.ok(sseConnections.every((item) => item.url === "/api/events?client=supervisor&types=status,notification"));
  // The end of the first stream was reported, without any token.
  assert.ok(errors.some((error) => error.code === "internal_sse_closed"));
  for (const error of errors) {
    assert.ok(!errorText(error).includes("fake-sse-token"), errorText(error));
  }
});

test("sse treats a scope refusal as final and close() stops reconnecting", { timeout: 15000 }, async (t) => {
  let calls = 0;
  const errors = [];
  const client = createInternalClient({
    principal: "system:hub-shim:vllm",
    readKey: () => TOKEN,
    fetchFn: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: false, code: "principal_scope_denied" }), { status: 403 });
    },
  });
  await new Promise((resolve) => {
    client.sse("/api/events?types=downloads", () => {}, { retryMs: 10, onError: (error) => { errors.push(error); resolve(); } });
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, 1);
  assert.equal(errors[0].code, "internal_sse_rejected");
  assert.equal(errors[0].status, 403);

  let reconnects = 0;
  const flaky = createInternalClient({
    principal: "system:supervisor",
    readKey: () => TOKEN,
    fetchFn: async () => {
      reconnects += 1;
      throw new Error("connection refused");
    },
  });
  const stream = flaky.sse("/api/events", () => {}, { retryMs: 10, maxRetryMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  stream.close();
  const settled = reconnects;
  assert.ok(settled >= 2, `expected reconnect attempts, saw ${settled}`);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(reconnects, settled);
  assert.throws(() => flaky.sse("/api/events"), /onEvent/);
  t.diagnostic(`reconnect attempts before close: ${settled}`);
});

test("no token appears in any thrown message, result or log line", { timeout: 15000 }, async (t) => {
  const lines = captureConsole(t);
  const secret = "fake-secret-token-must-not-leak";
  const outcomes = [];

  // Transport failure whose own message embeds the request headers.
  const leaky = createInternalClient({
    managerId: "vllm-manager",
    readKey: () => secret,
    fetchFn: async (url, options) => {
      throw new Error(`socket hang up ${secret} ${JSON.stringify(options.headers)}`);
    },
  });
  await assert.rejects(leaky.request("POST", "/internal/telemetry/requests", { a: 1 }), (error) => {
    outcomes.push(errorText(error));
    return error.code === "internal_unavailable";
  });

  // Timeout.
  const slow = createInternalClient({
    principal: "system:cli",
    readKey: () => secret,
    timeoutMs: 250,
    fetchFn: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason));
    }),
  });
  await assert.rejects(slow.request("GET", "/api/status"), (error) => {
    outcomes.push(errorText(error));
    return error.code === "internal_timeout";
  });

  // Missing key.
  const keyless = createInternalClient({ managerId: "vllm-manager", aiRoot: tempRoot(t), envName: "INTERNAL_AUTH_TEST_UNSET_TOKEN" });
  await assert.rejects(keyless.request("POST", "/internal/access/verify", {}), (error) => {
    outcomes.push(errorText(error));
    return error.code === "internal_key_unavailable";
  });

  // Path refusals and constructor errors.
  await assert.rejects(leaky.request("POST", `/internal/other/${secret}`, {}), (error) => {
    outcomes.push(errorText(error));
    return error.code === "internal_path_not_allowed";
  });

  // SSE errors.
  const sseErrors = [];
  const stream = leaky.sse("/internal/telemetry/stream", () => {}, { retryMs: 10, onError: (error) => sseErrors.push(error) });
  await new Promise((resolve) => setTimeout(resolve, 40));
  stream.close();
  assert.ok(sseErrors.length >= 1);
  outcomes.push(...sseErrors.map(errorText));

  // Verifier results.
  const now = 1_800_000_000_000;
  const headers = buildMachineHeaders(secret, { method: "GET", pathWithQuery: "/api/status", principal: "system:cli", now });
  outcomes.push(JSON.stringify(verifyMachineSignature(fakeRequest({ method: "GET", url: "/api/status?x", headers }), secret, { now })));
  outcomes.push(JSON.stringify(verifyInternalRequest(fakeRequest({ url: "/internal/billing/authorize", headers: {} }), "", secret, { now })));

  // Billing client failures.
  const billingClient = billing.createBillingClient({
    managerId: "vllm-manager",
    readToken: () => secret,
    fetchFn: async () => { throw new Error(`refused ${secret}`); },
  });
  outcomes.push(JSON.stringify(await billingClient.authorize({ requestId: "req-leak" })));

  assert.ok(outcomes.length >= 8);
  for (const text of [...outcomes, ...lines]) {
    assert.ok(!text.includes(secret), text);
  }
});

test("billing client gains the rotation retry without changing its result shapes", { timeout: 15000 }, async (t) => {
  const root = tempRoot(t);
  let serverToken = "fake-billing-token-old";
  const stamp = writeTrustFile(root, serverToken);
  const hits = [];
  const baseUrl = await startServer(t, (req, res, raw) => {
    const verified = billing.verifyBillingRequest(req, raw, serverToken);
    hits.push(verified.ok);
    if (!verified.ok) return sendJson(res, 401, { ok: false, allowed: false, code: "billing_unauthorized" });
    return sendJson(res, 200, { ok: true, allowed: true, managerId: JSON.parse(raw.toString("utf8")).managerId });
  });
  const client = billing.createBillingClient({ managerId: "vllm-manager", root, baseUrl });
  const first = await client.authorize({ requestId: "req-a" });
  assert.equal(first.ok, true);
  assert.equal(first.status, 200);

  serverToken = "fake-billing-token-new";
  writeTrustFile(root, serverToken, { mtimeSeconds: stamp });
  const second = await client.settle({ requestId: "req-b" });
  assert.equal(second.ok, true);
  assert.equal(second.managerId, "vllm-manager");
  assert.deepEqual(hits, [true, false, true]);

  serverToken = "fake-billing-token-unknown";
  const denied = await client.authorize({ requestId: "req-c" });
  assert.equal(denied.ok, false);
  assert.equal(denied.allowed, false);
  assert.equal(denied.status, 401);
  assert.equal(denied.code, "billing_unauthorized");
});

test("manager-core exposes internal auth as a namespace", () => {
  assert.equal(core.internalAuth, internalAuth);
  assert.equal(core.internalAuth.createInternalClient, createInternalClient);
  // The billing names stay flat and keep working through the index.
  assert.equal(typeof core.verifyBillingRequest, "function");
  assert.equal(core.BILLING_MANAGER_HEADER, "x-ai-billing-manager");
});
