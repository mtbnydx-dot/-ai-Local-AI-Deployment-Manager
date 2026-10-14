const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("../../manager-core");
const { createEntrySecurity, normalizeRequireApiKeyMode } = require("../lib/security");

const SWITCH_ENV = [
  "SERVICE_ENTRY_REQUIRE_API_KEY",
  "SERVICE_ENTRY_ALLOW_LAN_ADMIN",
  "SERVICE_ENTRY_ALLOWED_ORIGINS",
  "SERVICE_ENTRY_ALLOWED_HOSTS",
  "SERVICE_ENTRY_PUBLIC_BASE_URL",
  "SERVICE_ENTRY_TRUSTED_PROXIES",
];

function withCleanEnv(t) {
  const saved = Object.fromEntries(SWITCH_ENV.map((name) => [name, process.env[name]]));
  for (const name of SWITCH_ENV) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function tempRoot(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function makeManager(root, id, { exposure, clients } = {}) {
  const logs = path.join(root, id, "logs");
  await fsp.mkdir(logs, { recursive: true });
  if (exposure !== undefined) {
    await fsp.writeFile(path.join(logs, "service-exposure-settings.json"), typeof exposure === "string" ? exposure : JSON.stringify(exposure), "utf8");
  }
  if (clients !== undefined) {
    await fsp.writeFile(path.join(logs, "service-clients.json"), typeof clients === "string" ? clients : JSON.stringify(clients), "utf8");
  }
  return { id, name: `${id} manager`, root: path.join(root, id), port: 5177 };
}

// Access settings from an empty temp AI root, so this machine's platform.json
// never leaks into a test.
function defaultAccessReader(t, env = {}) {
  const aiRoot = tempRoot(t, "security-access-");
  return (name) => core.platform.readSection(name, { aiRoot, env });
}

function req(remoteAddress, headers = {}, method = "POST") {
  return { method, headers, socket: { remoteAddress } };
}

// Gateway error text must not tell a caller where files live, which port a
// component uses, or which env switch to flip (P0-26).
function assertPublicMessage(message, label = "message") {
  const text = String(message || "");
  assert.equal(text.includes(":\\"), false, `${label} has a Windows path: ${text}`);
  assert.doesNotMatch(text, /(?:^|[\s"'(])\/[\w.-]+\/[\w./-]*/, `${label} has a path: ${text}`);
  assert.equal(text.includes("5177"), false, `${label} has a port: ${text}`);
  assert.doesNotMatch(text, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, `${label} names an env var: ${text}`);
}

test("requireApiKey switch: auto follows the bind address, 1 and 0 are explicit", (t) => {
  withCleanEnv(t);
  const local = createEntrySecurity({ host: "127.0.0.1", managers: [] });
  const lan = createEntrySecurity({ host: "0.0.0.0", managers: [] });

  // auto: zero-config on loopback, enforced once reachable off-box.
  assert.equal(local.policy().requireApiKey, false);
  assert.equal(lan.policy().requireApiKey, true);

  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "1";
  assert.equal(local.policy().requireApiKey, true);

  // The documented escape hatch for a trusted LAN.
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "0";
  assert.equal(lan.policy().requireApiKey, false);
  assert.equal(lan.policy().requireApiKeyMode, "off");

  assert.equal(normalizeRequireApiKeyMode("yes"), "on");
  assert.equal(normalizeRequireApiKeyMode("off"), "off");
  assert.equal(normalizeRequireApiKeyMode("anything-else"), "auto");
});

test("client policy survives entry auth while open local compatibility is preserved", async (t) => {
  withCleanEnv(t);
  const root = tempRoot(t, "entry-client-policy-");
  const record = core.createServiceClientRecord({}, { name: "TTS client", rateLimitRpm: 1, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutSeconds: 15, requestTimeoutSeconds: 30 });
  const manager = await makeManager(root, "vllm", { exposure: {}, clients: record.ledger });
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [manager] });
  const auth = await security.authorizeGatewayRequest(req("127.0.0.1", { authorization: `Bearer ${record.apiKey}` }));
  assert.equal(auth.client.rateLimitRpm, 1);
  assert.equal(auth.client.maxConcurrentRequests, 1);
  assert.equal(auth.client.maxQueuedRequests, 0);
  assert.equal(auth.client.requestTimeoutSeconds, 30);
  assert.equal((await security.authorizeGatewayRequest(req("127.0.0.1", { authorization: "Bearer local-placeholder" }))).ok, true);
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "1";
  assert.equal((await security.authorizeGatewayRequest(req("127.0.0.1", { authorization: "Bearer local-placeholder" }))).status, 401);
});

test("management endpoints are local-only until the LAN admin switch is set", (t) => {
  withCleanEnv(t);
  const security = createEntrySecurity({ host: "0.0.0.0", managers: [] });

  assert.equal(security.checkManagementAccess(req("127.0.0.1")).ok, true);
  const denied = security.checkManagementAccess(req("192.168.0.44"));
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "management_local_only");

  process.env.SERVICE_ENTRY_ALLOW_LAN_ADMIN = "1";
  assert.equal(security.checkManagementAccess(req("192.168.0.44")).ok, true);
});

test("proxied requests are never management-eligible, even from loopback or with LAN admin on", (t) => {
  withCleanEnv(t);
  const security = createEntrySecurity({ host: "0.0.0.0", managers: [] });

  // deploy/public 拓扑：Caddy 从 127.0.0.1 转发公网请求，并带上 X-Forwarded-For。
  for (const header of ["x-forwarded-for", "forwarded", "x-forwarded-host", "x-real-ip"]) {
    const denied = security.checkManagementAccess(req("127.0.0.1", { [header]: "203.0.113.9" }));
    assert.equal(denied.ok, false, `header ${header} must demote the request`);
    assert.equal(denied.status, 403);
    assert.equal(denied.code, "management_local_only");
  }

  process.env.SERVICE_ENTRY_ALLOW_LAN_ADMIN = "1";
  const stillDenied = security.checkManagementAccess(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }));
  assert.equal(stillDenied.ok, false);

  // 没有转发头的本机请求不受影响。
  assert.equal(security.checkManagementAccess(req("127.0.0.1")).ok, true);
  assert.equal(security.isProxiedRequest(req("127.0.0.1")), false);
  assert.equal(security.isProxiedRequest(req("127.0.0.1", { "x-forwarded-for": "1.2.3.4" })), true);
});

test("the public base URL hostname is admitted by the host whitelist", (t) => {
  withCleanEnv(t);
  process.env.SERVICE_ENTRY_PUBLIC_BASE_URL = "https://models.example.com";
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [] });
  assert.equal(security.allowedHostnames().has("models.example.com"), true);
});

test("declaring a public base URL makes auto require an API key even on a loopback bind", (t) => {
  withCleanEnv(t);
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [] });
  assert.equal(security.policy().requireApiKey, false);

  process.env.SERVICE_ENTRY_PUBLIC_BASE_URL = "https://models.example.com";
  assert.equal(security.policy().publicMode, true);
  assert.equal(security.policy().requireApiKey, true);

  // 显式关闭仍然是允许的逃生门。
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "0";
  assert.equal(security.policy().requireApiKey, false);
});

test("resolveClientAddress and trustHeaders vouch the resolved client, not the proxy socket", (t) => {
  withCleanEnv(t);
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [], readSection: defaultAccessReader(t) });
  const pub = (peer, headers) => ({ ...req(peer, headers), listener: { kind: "public", lanBound: false } });

  // 直连：用 socket 地址。
  assert.equal(security.resolveClientAddress(req("192.168.0.44")), "192.168.0.44");
  // PUBLIC 经 Caddy/cloudflared：可信回环对端带来的 cf-connecting-ip 才被采信。
  assert.equal(security.resolveClientAddress(pub("127.0.0.1", { "cf-connecting-ip": "203.0.113.9" })), "203.0.113.9");
  // 局域网设备伪造的转发头一律忽略（V2）。
  assert.equal(security.resolveClientAddress(pub("192.168.0.44", { "cf-connecting-ip": "127.0.0.1", "x-forwarded-for": "127.0.0.1" })), "192.168.0.44");
  // ADMIN（含未标记的请求）永远不采信任何转发头。
  assert.equal(security.resolveClientAddress(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9" })), "127.0.0.1");
  assert.equal(security.resolveClientAddress({ ...req("127.0.0.1", { "cf-connecting-ip": "203.0.113.9" }), listener: { kind: "admin", lanBound: true } }), "127.0.0.1");

  // trustHeaders 担保的地址必须是解析后的客户端，否则管理器会把公网请求当成本机、
  // local-only 暴露模式随之失效。
  const vouched = security.trustHeaders(pub("127.0.0.1", { "cf-connecting-ip": "203.0.113.9" }));
  assert.equal(Object.values(vouched).includes("203.0.113.9"), true);
  assert.equal(Object.values(vouched).includes("127.0.0.1"), false);
  const lan = security.trustHeaders(pub("192.168.0.44", { "cf-connecting-ip": "127.0.0.1" }));
  assert.equal(Object.values(lan).includes("192.168.0.44"), true);
  assert.equal(Object.values(lan).includes("127.0.0.1"), false);
});

test("host whitelist and Origin check reject cross-site mutations", (t) => {
  withCleanEnv(t);
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [], getLanAddress: () => "192.168.0.10" });
  const url = new URL("http://127.0.0.1:5176/api/stop-all");

  assert.equal(security.checkRequest(req("127.0.0.1", { host: "127.0.0.1:5176" }), url).ok, true);
  assert.equal(security.checkRequest(req("127.0.0.1", { host: "192.168.0.10:5176" }), url).ok, true);

  // DNS rebinding lands on an unexpected Host.
  const badHost = security.checkRequest(req("127.0.0.1", { host: "evil.example.com" }), url);
  assert.equal(badHost.ok, false);
  assert.equal(badHost.code, "host_not_allowed");

  // A page the user has open must not be able to drive the entry.
  const crossSite = security.checkRequest(
    req("127.0.0.1", { host: "127.0.0.1:5176", origin: "https://evil.example.com" }),
    url,
  );
  assert.equal(crossSite.ok, false);
  assert.equal(crossSite.code, "origin_not_allowed");

  assert.equal(security.checkRequest(req("127.0.0.1", { host: "127.0.0.1:5176", origin: "null" }), url).ok, false);
  assert.equal(security.checkRequest(req("127.0.0.1", { host: "127.0.0.1:5176", origin: "http://127.0.0.1:5176" }), url).ok, true);

  // Reads are not Origin-gated.
  assert.equal(security.checkRequest(req("127.0.0.1", { host: "127.0.0.1:5176", origin: "https://evil.example.com" }, "GET"), url).ok, true);

  process.env.SERVICE_ENTRY_ALLOWED_HOSTS = "llm.example.com";
  assert.equal(security.checkRequest(req("127.0.0.1", { host: "llm.example.com" }), url).ok, true);
});

test("CORS does not reflect arbitrary origins", (t) => {
  withCleanEnv(t);
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [] });

  const denied = security.corsHeaders(req("127.0.0.1", { origin: "https://evil.example.com" }));
  assert.equal(denied["access-control-allow-origin"], undefined);
  assert.equal(denied.vary, "Origin");

  process.env.SERVICE_ENTRY_ALLOWED_ORIGINS = "https://chat.example.com";
  const allowed = security.corsHeaders(req("127.0.0.1", { origin: "https://chat.example.com" }));
  assert.equal(allowed["access-control-allow-origin"], "https://chat.example.com");
  assert.equal(
    security.corsHeaders(req("127.0.0.1", { origin: "https://evil.example.com" }))["access-control-allow-origin"],
    undefined,
  );
});

test("gateway auth accepts manager keys and rejects missing or wrong ones", async (t) => {
  withCleanEnv(t);
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "1";
  const root = tempRoot(t, "entry-auth-");
  const globalKey = "sk-global-key-value";
  const clientKey = "sk-client-key-value";

  const managers = [
    await makeManager(root, "vllm", {
      exposure: {
        version: 1, enabled: true, exposureMode: "lan", requireApiKey: true,
        apiKey: "", apiKeyHash: core.hashServiceApiKey(globalKey), apiKeyPreview: "sk-glob...alue",
      },
      clients: { version: 1, clients: [] },
    }),
    await makeManager(root, "llama", {
      exposure: { version: 1, enabled: true, exposureMode: "local", requireApiKey: false },
      clients: {
        version: 1,
        clients: [{
          id: "opencode", name: "OpenCode", enabled: true,
          keyHash: core.hashServiceApiKey(clientKey), keyPreview: "sk-clie...alue",
          allowedModels: ["allowed-model"],
          createdAt: new Date().toISOString(),
        }],
      },
    }),
  ];
  const security = createEntrySecurity({ host: "0.0.0.0", aiRoot: root, managers });

  assert.equal((await security.authorizeGatewayRequest(req("192.168.0.5", {}))).ok, false);
  assert.equal((await security.authorizeGatewayRequest(req("192.168.0.5", {}))).status, 401);

  const withGlobal = await security.authorizeGatewayRequest(req("192.168.0.5", { authorization: `Bearer ${globalKey}` }));
  assert.equal(withGlobal.ok, true);
  assert.equal(withGlobal.matchedManager, "vllm");

  // A per-client key from either manager is accepted, and the client is identified.
  const withClient = await security.authorizeGatewayRequest(req("192.168.0.5", { "x-api-key": clientKey }));
  assert.equal(withClient.ok, true);
  assert.equal(withClient.clientId, "opencode");
  assert.deepEqual(withClient.client.allowedModels, ["allowed-model"]);
  assert.equal(Object.hasOwn(withClient.client, "keyHash"), false);

  const wrong = await security.authorizeGatewayRequest(req("192.168.0.5", { authorization: "Bearer sk-nope" }));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, 401);

  // The switch turns enforcement off wholesale.
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "0";
  security.invalidateKeyStores();
  assert.equal((await security.authorizeGatewayRequest(req("192.168.0.5", {}))).ok, true);
});

test("gateway auth fails closed when a key store is unreadable or empty", async (t) => {
  withCleanEnv(t);
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "1";
  const root = tempRoot(t, "entry-auth-bad-");

  const corrupt = [await makeManager(root, "vllm", { exposure: '{"enabled":true,"requi', clients: { clients: [] } })];
  const corruptSecurity = createEntrySecurity({ host: "0.0.0.0", aiRoot: root, managers: corrupt, logError: () => {} });
  const denied = await corruptSecurity.authorizeGatewayRequest(req("192.168.0.5", { authorization: "Bearer sk-anything" }));
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 503);
  assert.equal(denied.code, "key_store_unreadable");
  assertPublicMessage(denied.message, "key_store_unreadable");
  assert.equal(denied.message.includes(root), false);
  assert.equal(denied.message, "服务暂时不可用 / Service temporarily unavailable");

  // Requiring a key with none configured must refuse rather than wave traffic through.
  const empty = [await makeManager(root, "llama", {
    exposure: { version: 1, enabled: true, requireApiKey: true },
    clients: { version: 1, clients: [] },
  })];
  const emptySecurity = createEntrySecurity({ host: "0.0.0.0", aiRoot: root, managers: empty });
  const noKeys = await emptySecurity.authorizeGatewayRequest(req("192.168.0.5", {}));
  assert.equal(noKeys.ok, false);
  assert.equal(noKeys.status, 503);
  assert.equal(noKeys.code, "api_key_not_configured");
  assertPublicMessage(noKeys.message, "api_key_not_configured");
});

test("key store failures reach the server log with details, redacted and rate-limited", async (t) => {
  withCleanEnv(t);
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "1";
  const root = tempRoot(t, "entry-auth-log-");
  // A manager directory whose name looks like a key stands in for any secret
  // that a file-system error message might echo.
  const fakeKey = "sk-fakeStoreKey0001";
  const managers = [await makeManager(root, fakeKey, { exposure: '{"enabled":true,"requi', clients: { clients: [] } })];
  const logged = [];
  const security = createEntrySecurity({ host: "0.0.0.0", aiRoot: root, managers, logError: (line) => logged.push(line) });

  for (let index = 0; index < 3; index += 1) {
    const denied = await security.authorizeGatewayRequest(req("192.168.0.5", { authorization: "Bearer sk-anything" }));
    assert.equal(denied.code, "key_store_unreadable");
    assert.equal(denied.message.includes(fakeKey), false);
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /service-exposure-settings\.json/);
  assert.match(logged[0], /not valid JSON/);
  assert.match(logged[0], /<redacted>/);
  assert.equal(logged[0].includes(fakeKey), false);

  // The admin view keeps the paths it always had, minus anything secret.
  const state = await security.describe();
  assert.equal(state.keyStore.readable, false);
  assert.ok(state.keyStore.issues.every((item) => !item.message.includes(fakeKey)));
});

test("the startup hint goes to stdout and the off-loopback warning stays on stderr", (t) => {
  const entry = require("../server");
  const stdout = t.mock.method(console, "log", () => {});
  const stderr = t.mock.method(console, "warn", () => {});
  const base = { requireApiKeyMode: "auto", allowLanAdmin: false, corsMode: "deny", allowedOrigins: [] };

  entry.logStartupSummary({ ...base, lanMode: true, requireApiKey: false });
  const out = stdout.mock.calls.map((call) => String(call.arguments[0]));
  const err = stderr.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(out.some((line) => line.includes("HINT:")), "HINT is printed with console.log");
  assert.equal(err.some((line) => line.includes("HINT:")), false);
  assert.deepEqual(err.filter((line) => line.includes("WARNING:")).length, 1);

  stdout.mock.resetCalls();
  stderr.mock.resetCalls();
  entry.logStartupSummary({ ...base, lanMode: false, requireApiKey: false });
  assert.ok(stdout.mock.calls.some((call) => String(call.arguments[0]).includes("HINT:")));
  assert.equal(stderr.mock.callCount(), 0);

  stdout.mock.resetCalls();
  entry.logStartupSummary({ ...base, lanMode: true, requireApiKey: true });
  assert.equal(stdout.mock.calls.some((call) => String(call.arguments[0]).includes("HINT:")), false);
});

test("describe() reports what is actually enforced, not just what is configured", async (t) => {
  withCleanEnv(t);
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "1";
  const root = tempRoot(t, "entry-desc-");
  const managers = [await makeManager(root, "vllm", {
    exposure: { version: 1, enabled: true, requireApiKey: true },
    clients: { version: 1, clients: [] },
  })];
  const security = createEntrySecurity({ host: "0.0.0.0", aiRoot: root, managers });

  const state = await security.describe();
  assert.equal(state.requireApiKey, true);
  // Required but unusable: the distinction the exposure page needs to surface.
  assert.equal(state.apiKeyEnforced, false);
  assert.ok(state.warnings.some((item) => item.level === "fail"));
  assert.ok(state.switches.SERVICE_ENTRY_REQUIRE_API_KEY);

  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "0";
  security.invalidateKeyStores();
  const off = await security.describe();
  assert.equal(off.requireApiKey, false);
  // Off-loopback with auth disabled is the configuration worth shouting about.
  assert.ok(off.warnings.some((item) => item.level === "fail" && item.title.includes("局域网")));
});

test("trust token is published, signs proxied requests, and is revoked", async (t) => {
  withCleanEnv(t);
  const root = tempRoot(t, "entry-trust-");
  const security = createEntrySecurity({ host: "127.0.0.1", aiRoot: root, managers: [] });

  const issued = await security.issueTrustToken();
  assert.ok(issued.token.length > 20);
  assert.equal(fs.existsSync(path.join(root, ".gateway-trust.json")), true);

  const headers = security.trustHeaders(req("192.168.0.60"));
  assert.equal(headers["x-service-entry-gateway"], "1");
  assert.equal(headers["x-service-entry-client"], "192.168.0.60");

  // A manager reading the published token must accept the signature and see the
  // real client, not the loopback proxy address.
  const read = core.createGatewayTrustReader({ root, cacheTtlMs: 0, envName: "TRUST_TOKEN_UNSET_FOR_TEST" });
  const origin = core.resolveRequestOrigin(req("127.0.0.1", headers), { readGatewayTrustToken: read });
  assert.equal(origin.trusted, true);
  assert.equal(origin.address, "192.168.0.60");
  assert.equal(core.isLocalRequester(req("127.0.0.1", headers), { readGatewayTrustToken: read }), false);

  await security.revokeTrustToken();
  assert.equal(fs.existsSync(path.join(root, ".gateway-trust.json")), false);
});

test("published trust token immediately overrides a stale bootstrap token after entry rotation with manager defaults", async (t) => {
  const root = tempRoot(t, "entry-trust-rotate-");
  const envName = "SERVICE_GATEWAY_TRUST_TOKEN_ROTATION_TEST";
  const previous = process.env[envName];
  process.env[envName] = "stale-bootstrap-token";
  t.after(() => {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  });

  const first = await core.issueGatewayTrustToken({ root, token: "first-published-token" });
  const reader = core.createGatewayTrustReader({ root, envName });
  assert.equal(reader(), first.token);
  const firstHeaders = core.buildGatewayTrustHeaders(first.token, "192.168.0.60");
  const second = await core.issueGatewayTrustToken({ root, token: "second-published-token" });
  assert.equal(reader(), second.token);
  assert.equal(core.resolveRequestOrigin(req("127.0.0.1", firstHeaders), { readGatewayTrustToken: reader }).trusted, false);
  const secondHeaders = core.buildGatewayTrustHeaders(second.token, "192.168.0.60");
  assert.equal(core.resolveRequestOrigin(req("127.0.0.1", secondHeaders), { readGatewayTrustToken: reader }).trusted, true);
});

test("proxy headers strip client-supplied trust headers before re-signing", (t) => {
  withCleanEnv(t);
  const entry = require("../server");
  const forged = {
    authorization: "Bearer sk-user",
    "x-service-entry-gateway": "1",
    "x-service-entry-client": "127.0.0.1",
    "x-service-entry-signature": "forged",
    "x-service-entry-ts": String(Date.now()),
    host: "127.0.0.1:5176",
  };
  const headers = entry.buildProxyHeaders(forged, req("192.168.0.99", forged));

  assert.equal(headers.authorization, "Bearer sk-user");
  assert.equal(headers.host, undefined);
  // The forged signature must not survive into the upstream request.
  assert.notEqual(headers["x-service-entry-signature"], "forged");
  assert.equal(headers["x-service-entry-client"], "192.168.0.99");
});

test("shutdown and status endpoints enforce the management gate", async (t) => {
  withCleanEnv(t);
  const entry = require("../server");
  const server = entry.createServiceEntryServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  // fetch() refuses to set Host, so drive these with the raw client. The guard
  // keys off the socket address, and a loopback test client is always "local";
  // Host and Origin are the reachable half of the same gate.
  const rawPost = (pathname, headers) => new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "POST", headers },
      (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body || "{}") }));
      },
    );
    request.on("error", reject);
    request.end();
  });

  const badHost = await rawPost("/api/shutdown", { host: "evil.example.com" });
  assert.equal(badHost.status, 403);
  assert.equal(badHost.body.code, "host_not_allowed");

  const crossSite = await rawPost("/api/stop-all", { origin: "https://evil.example.com" });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.body.code, "origin_not_allowed");

  const security = await fetch(`http://127.0.0.1:${port}/api/security`);
  assert.equal(security.status, 200);
  const payload = await security.json();
  assert.equal(payload.ok, true);
  assert.ok(payload.security.switches);
});

test("gateway rejects an unauthenticated request before proxying when a key is required", async (t) => {
  withCleanEnv(t);
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "1";
  const entry = require("../server");
  const server = entry.createServiceEntryServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/gateway/auto/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local-current", messages: [] }),
  });
  // Either "no key presented" or "no key configured" -- both refuse the request.
  assert.ok([401, 503].includes(response.status), `expected 401/503, got ${response.status}`);
  const body = await response.json();
  assert.ok(["unauthorized", "api_key_not_configured", "key_store_unreadable"].includes(body.error.code), body.error.code);
  assertPublicMessage(body.error.message, body.error.code);
});

test("gateway mutating requests with a foreign Origin are rejected", (t) => {
  withCleanEnv(t);
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [], getLanAddress: () => "192.168.0.10" });
  const url = new URL("http://127.0.0.1:5176/gateway/auto/openai/v1/chat/completions");
  const crossSite = security.checkRequest(
    req("127.0.0.1", { host: "127.0.0.1:5176", origin: "https://evil.example.com" }),
    url,
  );
  assert.equal(crossSite.ok, false);
  assert.equal(crossSite.code, "origin_not_allowed");
  assert.equal(security.checkRequest(req("127.0.0.1", { host: "127.0.0.1:5176", origin: "null" }), url).ok, false);
  assert.equal(security.checkRequest(req("127.0.0.1", { host: "127.0.0.1:5176" }), url).ok, true);
});

test("describePublic and remote status redaction hide paths and key-store details", async (t) => {
  withCleanEnv(t);
  const root = tempRoot(t, "entry-redact-");
  const security = createEntrySecurity({ host: "127.0.0.1", aiRoot: root, managers: [] });
  const full = await security.describe();
  const pub = security.describePublic(full);
  assert.equal(Object.hasOwn(pub, "keyStore"), false);
  assert.equal(Object.hasOwn(pub, "allowedOrigins"), false);
  assert.equal(Object.hasOwn(pub, "switches"), false);
  const entry = require("../server");
  const redacted = entry.redactStatusForRemote({
    ok: true,
    security: {
      ...full,
      keyStore: { issues: [{ file: "D:\\\\secret\\\\keys.json", message: "bad" }] },
    },
    entry: { pid: 12, gatewayAccess: { logPath: "D:\\\\logs\\\\access.log" } },
    managers: [{ root: "D:\\\\AI\\\\vllm-manager", process: { pid: 9, pidFile: "D:\\\\x.pid" } }],
  });
  const text = JSON.stringify(redacted);
  assert.equal(text.includes("D:\\\\"), false);
  assert.equal(Object.hasOwn(redacted.security, "keyStore"), false);
  assert.equal(Object.hasOwn(redacted.security, "allowedOrigins"), false);
});

test("shutdown still exits while an SSE connection is open", async () => {
  const http = require("node:http");
  const entry = require("../server");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: keep-alive\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const client = http.get({ host: "127.0.0.1", port, path: "/" });
  await new Promise((resolve) => client.once("response", resolve));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shutdown did not exit")), 2000);
    entry.shutdownSoon({
      server,
      graceMs: 200,
      delayMs: 10,
      exit: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
    });
  });
  assert.equal(code, 0);
  client.destroy();
});
