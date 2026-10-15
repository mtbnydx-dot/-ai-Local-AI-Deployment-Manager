"use strict";

// Manager middleware modes (docs/overhaul/05-public.md §7.2, PUB-10): a valid
// hop v2 is trusted in every mode, a valid v1 hop keeps the legacy path, and
// a direct call is served (off), served with a deprecation notice (warn) or
// refused (enforce). On a v2 hop billing uses the principal.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const core = require("..");
const gateway = require("../gateway-utils");

const TOKEN = "fake-trust-token-for-middleware-tests";
const LEGACY_KEY = "sk-vllm-fake-legacy-client-key-000000000000";
const PLATFORM_KEY = "sk-plat-fake-platform-key-0000000000000000";
const REQUEST_ID = "req_mnopqrstuvwxyz234567";
const PRINCIPAL = Object.freeze({ k: "vllm.egg", b: "vllm-manager", c: "egg", t: "vllm:egg", l: "public", p: "key", mo: 8192, mc: 2 });
const CONSOLE_PRINCIPAL = Object.freeze({ k: "console", b: null, c: "console", t: "", l: "admin", p: "console-session" });
const PATH = "/serve/v1/chat/completions";

test.before(() => core.configureGatewayTrust(() => TOKEN));
test.after(() => core.configureGatewayTrust(null));

function makeResponse() {
  const emitter = new EventEmitter();
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) {
      this.body = value;
      this.headersSent = true;
      this.writableEnded = true;
      this.writableFinished = true;
      emitter.emit("finish");
      return this;
    },
    end() {
      this.headersSent = true;
      this.writableEnded = true;
      this.writableFinished = true;
      emitter.emit("finish");
      return this;
    },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    setTimeout() { return this; },
    once(name, listener) { emitter.once(name, listener); return this; },
    off(name, listener) { emitter.off(name, listener); return this; },
    removeListener(name, listener) { emitter.removeListener(name, listener); return this; },
  };
  return res;
}

function request({ headers = {}, socket = "127.0.0.1", path = PATH, method = "POST" } = {}) {
  return { method, originalUrl: path, url: path, path, headers, socket: { remoteAddress: socket }, body: { model: "qwen-chat" } };
}

function v2Hop(principal = PRINCIPAL, clientIp = "203.0.113.9", extra = {}) {
  return core.buildEntryHeaders(TOKEN, { method: "POST", pathname: PATH, clientIp, requestId: REQUEST_ID, principal, ...extra });
}

function harness(options = {}) {
  let mode = options.mode || "off";
  const settings = core.normalizeServiceExposureSettings({
    enabled: true,
    exposureMode: "lan",
    requireApiKey: true,
    rateLimitRpm: options.rateLimitRpm || 480,
    ...(options.settings || {}),
  });
  const ledger = { clients: [{ id: "laptop", name: "Laptop", enabled: true, keyHash: core.hashServiceApiKey(LEGACY_KEY) }] };
  const verifyCalls = [];
  const accessLog = [];
  const directCalls = [];
  const middleware = core.createServiceGatewayMiddleware({
    gatewayName: "vllm-manager",
    supportedKinds: ["openai", "claude", "opencode"],
    getServiceExposureSettings: async () => settings,
    getServiceClientsLedger: async () => core.normalizeServiceClientsLedger(ledger),
    resolveServiceClientForApiKey: async (key) => core.resolveServiceClientForApiKey(core.normalizeServiceClientsLedger(ledger), key),
    rateBuckets: new Map(),
    concurrencyBuckets: options.concurrencyBuckets || new Map(),
    appendAccessLog: async (entry) => accessLog.push(entry),
    acceptRawAuthorization: true,
    getGatewayOnlyMode: () => mode,
    verifyAccessKey: options.verifyAccessKey === null ? null : async (keyHash, verifyOptions) => {
      verifyCalls.push({ keyHash, ...verifyOptions });
      if (options.verifyAccessKey) return options.verifyAccessKey(keyHash);
      if (keyHash === core.hashServiceApiKey(PLATFORM_KEY)) {
        return {
          ok: true,
          keyId: "k_abcdefghijklmnopqrst",
          principal: { k: "k_abcdefghijklmnopqrst", b: "platform", c: "k_abcdefghijklmnopqrst", t: "platform:k_abcdefghijklmnopqrst", l: "direct", p: "key" },
          models: ["*"],
          fleetAllow: ["vllm:*"],
          limits: { rpm: 30, maxConcurrent: 2, maxOutputTokens: 4096 },
          expiresAt: null,
        };
      }
      return { ok: false, code: "invalid_api_key" };
    },
    backstopConcurrency: options.backstopConcurrency,
    onDirectGatewayCall: (event) => directCalls.push(event),
  });
  async function run(req) {
    const res = makeResponse();
    let passed = false;
    await middleware(req, res, () => { passed = true; });
    if (passed && !res.writableEnded) res.end();
    return { req, res, passed };
  }
  return { run, setMode: (next) => { mode = next; }, verifyCalls, accessLog, directCalls, settings };
}

test("§7.2 matrix: a valid v2 hop is trusted in off, warn and enforce", async () => {
  for (const mode of ["off", "warn", "enforce"]) {
    const h = harness({ mode });
    const { req, res, passed } = await h.run(request({ headers: v2Hop() }));
    assert.equal(passed, true, `${mode}: served`);
    assert.equal(res.headers.deprecation, undefined, `${mode}: no deprecation notice for the entry`);
    assert.equal(req.serviceGateway.entryHop, 2);
    assert.equal(req.serviceGateway.client, null, "the key check is skipped");
    assert.deepEqual(req.serviceGateway.principal, PRINCIPAL);
    assert.equal(req.serviceGateway.clientId, "egg");
    assert.equal(req.serviceGateway.credentialManagerId, "vllm-manager");
    assert.equal(req.serviceGateway.settings.maxConcurrentRequests, core.DEFAULT_GATEWAY_BACKSTOP_CONCURRENCY);
    assert.equal(h.verifyCalls.length, 0, "the entry already verified the key");
  }
});

test("§7.2 matrix: a valid v1 hop keeps the legacy path in every mode", async () => {
  // The key is the migrated legacy client in the store (05 §6.7).
  const migrated = async (keyHash) => (keyHash === core.hashServiceApiKey(LEGACY_KEY)
    ? { ok: true, keyId: "vllm.laptop", principal: { k: "vllm.laptop", b: "vllm-manager", c: "laptop", t: "vllm:laptop", l: "direct", p: "key" }, models: ["*"], limits: {} }
    : { ok: false, code: "invalid_api_key" });
  for (const mode of ["off", "warn", "enforce"]) {
    const h = harness({ mode, verifyAccessKey: migrated });
    const headers = { ...core.buildGatewayTrustHeaders(TOKEN, "192.168.1.50"), authorization: `Bearer ${LEGACY_KEY}` };
    const ok = await h.run(request({ headers }));
    assert.equal(ok.passed, true, `${mode}: served`);
    assert.equal(ok.res.headers.deprecation, undefined);
    assert.equal(ok.req.serviceGateway.entryHop, undefined);
    // The legacy key check still runs (through the store, by hash).
    assert.equal(h.verifyCalls.length, 1);
    assert.equal(ok.req.serviceGateway.client.id, "laptop");
    assert.equal(ok.req.serviceGateway.clientId, "laptop");
    assert.equal(ok.req.serviceGateway.credentialManagerId, "vllm-manager");
    const missing = await h.run(request({ headers: core.buildGatewayTrustHeaders(TOKEN, "192.168.1.50") }));
    assert.deepEqual([missing.passed, missing.res.statusCode, missing.res.body.error.code], [false, 401, "unauthorized"], `${mode}: v1 needs the key`);
  }
});

test("§7.2 matrix: unsigned direct calls are legacy (off), deprecated (warn) or refused (enforce)", async () => {
  const off = harness({ mode: "off" });
  const offResult = await off.run(request({ headers: { authorization: `Bearer ${PLATFORM_KEY}` }, socket: "192.168.1.60" }));
  assert.equal(offResult.passed, true);
  assert.equal(offResult.res.headers.deprecation, undefined);
  assert.equal(off.directCalls.length, 0);
  // The key was checked through the entry, by hash only.
  assert.deepEqual(off.verifyCalls, [{ keyHash: core.hashServiceApiKey(PLATFORM_KEY), kind: "openai" }]);
  assert.equal(JSON.stringify(off.verifyCalls).includes(PLATFORM_KEY), false, "the plaintext key never crosses");
  assert.equal(offResult.req.serviceGateway.clientId, "k_abcdefghijklmnopqrst");
  assert.equal(offResult.req.serviceGateway.credentialManagerId, "platform");
  assert.equal(offResult.req.serviceGateway.settings.rateLimitRpm, 30, "the key's own limits apply");

  const warn = harness({ mode: "warn" });
  const warnResult = await warn.run(request({ headers: { "x-api-key": PLATFORM_KEY }, socket: "192.168.1.61", path: "/claude/v1/messages" }));
  assert.equal(warnResult.passed, true);
  assert.equal(warnResult.res.headers.deprecation, "true");
  assert.equal(warnResult.res.headers.link, '</docs/migrate-public>; rel="deprecation"');
  assert.equal(warn.directCalls.length, 1);
  assert.deepEqual(
    { event: warn.directCalls[0].event, kind: warn.directCalls[0].kind, remoteAddress: warn.directCalls[0].remoteAddress },
    { event: "direct_manager_gateway", kind: "claude", remoteAddress: "192.168.1.61" },
  );
  // The store is authoritative: a key it does not know (here one that only
  // the legacy file still lists, as after a delete-to-revoke) is refused; the
  // file is not consulted behind the store's back.
  const revoked = await warn.run(request({ headers: { authorization: `Bearer ${LEGACY_KEY}` }, socket: "192.168.1.61" }));
  assert.deepEqual([revoked.passed, revoked.res.statusCode, revoked.res.body.error.code], [false, 401, "unauthorized"]);
  assert.equal(revoked.res.headers.deprecation, "true");
  // The second call inside the minute was counted, not logged again.
  assert.equal(warn.directCalls.length, 1);

  const enforce = harness({ mode: "enforce" });
  const refused = await enforce.run(request({ headers: { authorization: `Bearer ${PLATFORM_KEY}` }, socket: "127.0.0.1" }));
  assert.equal(refused.passed, false);
  assert.equal(refused.res.statusCode, 403);
  assert.deepEqual(refused.res.body.error.code, "gateway_only");
  assert.equal(refused.res.body.error.message, "Use the platform endpoint (port 5176 locally, 5186 public).");
  assert.equal(enforce.verifyCalls.length, 0);
});

test("§7.2 matrix: a forged marker or bad signature is untrusted in every mode", async () => {
  for (const mode of ["off", "warn", "enforce"]) {
    const h = harness({ mode, settings: { exposureMode: "local", requireApiKey: false } });
    const forged = { ...v2Hop(), [core.GATEWAY_SIGNATURE_V2_HEADER]: "forged-signature" };
    const result = await h.run(request({ headers: forged }));
    assert.equal(result.passed, false, `${mode}: never served as the entry`);
    assert.equal(result.req.serviceGateway, undefined);
    assert.equal(result.res.statusCode, 403);
    // enforce refuses it as a direct call; off and warn see a non-local caller.
    assert.equal(result.res.body.error.code, mode === "enforce" ? "gateway_only" : "local_only");
    const lan = await h.run(request({ headers: v2Hop(), socket: "192.168.1.70" }));
    assert.equal(lan.passed, false, `${mode}: the marker counts only from loopback`);
  }
});

test("direct calls: with the entry down, off falls back to the legacy file and warn denies", async () => {
  const down = async () => ({ ok: false, code: "key_store_unavailable", unavailable: true });
  const off = harness({ mode: "off", verifyAccessKey: down });
  const offResult = await off.run(request({ headers: { authorization: `Bearer ${LEGACY_KEY}` } }));
  assert.equal(offResult.passed, true);
  assert.equal(offResult.req.serviceGateway.client.id, "laptop");
  const warn = harness({ mode: "warn", verifyAccessKey: down });
  const warnResult = await warn.run(request({ headers: { authorization: `Bearer ${LEGACY_KEY}` } }));
  assert.deepEqual([warnResult.passed, warnResult.res.statusCode, warnResult.res.body.error.code], [false, 503, "key_store_unavailable"]);
  // Without a verifier (an older wiring) the legacy file is the only source.
  const legacy = harness({ mode: "warn", verifyAccessKey: null });
  const legacyResult = await legacy.run(request({ headers: { authorization: `Bearer ${LEGACY_KEY}` } }));
  assert.equal(legacyResult.passed, true);
  assert.equal(legacyResult.req.serviceGateway.clientId, "laptop");
});

test("v2 hop: the backstop concurrency cap per manager applies", async () => {
  const buckets = new Map();
  const h = harness({ mode: "warn" });
  // Hold one slot open: run the middleware without finishing the response.
  const held = makeResponse();
  const first = request({ headers: v2Hop() });
  let firstPassed = false;
  const mw = core.createServiceGatewayMiddleware({
    getServiceExposureSettings: async () => h.settings,
    getServiceClientsLedger: async () => ({ clients: [] }),
    resolveServiceClientForApiKey: async () => null,
    rateBuckets: new Map(),
    concurrencyBuckets: buckets,
    backstopConcurrency: 1,
    getGatewayOnlyMode: () => "warn",
  });
  await mw(first, held, () => { firstPassed = true; });
  assert.equal(firstPassed, true);
  const queued = makeResponse();
  const second = request({ headers: v2Hop() });
  let secondPassed = false;
  const pending = mw(second, queued, () => { secondPassed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondPassed, false, "the second hop waits for the backstop slot");
  held.end();
  await pending;
  assert.equal(secondPassed, true, "and runs once the first finishes");
  queued.end();
});

test("v2 hop billing: the principal's clientId and credentialManagerId; b:null skips billing", async () => {
  const authorizations = [];
  const settlements = [];
  const handlers = gateway.createOpenAiGatewayHandlers({
    aliases: ["local-current"],
    getRunningModelSummary: async () => ({ container: { running: true }, endpoint: { port: 8000 }, servedModels: [{ id: "actual-model" }] }),
    getUpstreamHeaders: (_runtime, headers = {}) => ({ ...headers }),
    serviceClientAllowsModel: core.serviceClientAllowsModel,
    recordUsage: async () => {},
    setAccessUsage: () => {},
    isExpectedStreamDisconnect: gateway.isExpectedStreamDisconnect,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : "") },
      text: async () => JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    }),
    authorizeBilling: async (input) => {
      authorizations.push(input);
      return { ok: true, allowed: true, bound: true, enforcementMode: "hard" };
    },
    settleBilling: async (input) => {
      settlements.push(input);
      return { ok: true, settled: true };
    },
  });
  const h = harness({ mode: "enforce" });
  const billed = await h.run(request({ headers: v2Hop() }));
  assert.equal(billed.passed, true);
  const billedReq = { ...billed.req, body: { model: "local-current", messages: [{ role: "user", content: "hi" }], max_tokens: 16 } };
  await handlers.handleChatCompletions(billedReq, makeResponse());
  assert.equal(authorizations.length, 1);
  assert.equal(authorizations[0].clientId, "egg");
  assert.equal(authorizations[0].credentialManagerId, "vllm-manager");
  assert.equal(authorizations[0].externalRequestId, REQUEST_ID, "billing carries the entry's request id");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].clientId, "egg");
  assert.equal(settlements[0].credentialManagerId, "vllm-manager");

  for (const principal of [CONSOLE_PRINCIPAL, null]) {
    const unbilled = await h.run(request({ headers: v2Hop(principal) }));
    assert.equal(unbilled.passed, true);
    assert.equal(unbilled.req.serviceGateway.clientId, "");
    await handlers.handleChatCompletions({ ...unbilled.req, body: { model: "local-current", messages: [{ role: "user", content: "hi" }] } }, makeResponse());
  }
  assert.equal(authorizations.length, 1, "b:null and keyless callers are never billed");
  assert.equal(settlements.length, 1);

  // A legacy direct call keeps the legacy billing input: no credentialManagerId.
  const legacy = harness({ mode: "off", verifyAccessKey: null });
  const direct = await legacy.run(request({ headers: { authorization: `Bearer ${LEGACY_KEY}` } }));
  await handlers.handleChatCompletions({ ...direct.req, body: { model: "local-current", messages: [{ role: "user", content: "hi" }] } }, makeResponse());
  assert.equal(authorizations.length, 2);
  assert.equal(authorizations[1].clientId, "laptop");
  assert.equal(Object.hasOwn(authorizations[1], "credentialManagerId"), false);
});

test("access log rows carry the vouched ip and the entry's x-request-id", async () => {
  const h = harness({ mode: "warn" });
  await h.run(request({ headers: v2Hop(PRINCIPAL, "198.51.100.23") }));
  await h.run(request({ headers: { ...core.buildGatewayTrustHeaders(TOKEN, "192.168.1.80"), "x-request-id": "req_v1hopv1hopv1hopv1ho", authorization: `Bearer ${LEGACY_KEY}` } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.accessLog.length, 2);
  assert.deepEqual(
    [h.accessLog[0].remoteAddress, h.accessLog[0].socketAddress, h.accessLog[0].requestId, h.accessLog[0].clientId],
    ["198.51.100.23", "127.0.0.1", REQUEST_ID, "egg"],
  );
  assert.deepEqual([h.accessLog[1].remoteAddress, h.accessLog[1].requestId], ["192.168.1.80", "req_v1hopv1hopv1hopv1ho"]);
});

test("the gateway-only mode reader follows public.managersGatewayOnly at most every 10 s", () => {
  let clock = 0;
  let value = "enforce";
  let reads = 0;
  const reader = core.createGatewayOnlyModeReader({
    now: () => clock,
    readSection: (name) => {
      reads += 1;
      assert.equal(name, "public");
      if (value === "throw") throw new Error("unreadable");
      return { values: { managersGatewayOnly: value } };
    },
  });
  assert.equal(reader(), "enforce");
  value = "off";
  clock = 9_999;
  assert.equal(reader(), "enforce", "cached inside the window");
  clock = 10_000;
  assert.equal(reader(), "off");
  value = "throw";
  clock = 20_000;
  assert.equal(reader(), "off", "an unreadable config keeps the last mode");
  value = "bogus";
  clock = 30_000;
  assert.equal(reader(), "off");
  assert.equal(reads, 4);
  assert.equal(core.normalizeGatewayOnlyMode(undefined), "warn", "the default is warn");
});

test("GET /api/manager/health advertises gatewayTrust { version: 2, mode } (the entry's key-strip switch)", async () => {
  const os = require("node:os");
  const path = require("node:path");
  const lifecycle = core.createManagerLifecycle({
    app: {},
    host: "127.0.0.1",
    port: 0,
    pidFile: path.join(os.tmpdir(), `gateway-only-health-${process.pid}.pid`),
    engine: "vllm",
    managerId: "vllm-manager",
    getHealthExtras: () => ({ gatewayTrust: { version: core.GATEWAY_TRUST_VERSION, mode: "enforce" } }),
  });
  const health = await lifecycle.buildManagerHealth();
  assert.equal(health.ok, true);
  assert.deepEqual(health.gatewayTrust, { version: 2, mode: "enforce" });
  const broken = core.createManagerLifecycle({ app: {}, engine: "vllm", getHealthExtras: () => { throw new Error("config unreadable"); } });
  assert.equal((await broken.buildManagerHealth()).gatewayTrust, undefined, "a failing extra never fails the health answer");
});
