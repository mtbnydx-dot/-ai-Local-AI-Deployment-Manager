"use strict";

// Real secret-store reloads and the real MCP migration hook, with fake DPAPI,
// temp files and random loopback upstreams. No host keys or services are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const secretApi = require("../../manager-core/secret-store");
const mcpHook = require("../../manager-core/platform/hooks/platform-mcp");
const { createFakeDpapi } = require("../../manager-core/test/fixtures/secrets/fake-dpapi");
const { listen, request, unusedPort } = require("./helpers/entry-harness");

const ROOT = path.resolve(__dirname, "..", "..");
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "entry-aux-secrets-"));
const MCP_ENV = path.join(TEST_ROOT, ".runtime", "platform-mcp", "server.env");
const LEGACY_SEARCH = path.join(TEST_ROOT, "legacy-search.txt");
const ORIGINAL_SEARCH = path.join(ROOT, "vllm-manager", "logs", ".last-public-service-key.txt");
const MCP_KEY = "TESTONLY_MCP_MIGRATION_0123456789_ABCDEFGHIJ";
const SEARCH_KEY = "TESTONLY_SEARCH_VAULT_0123456789_ABCDEFGHIJ";
const ROTATED_SEARCH = "TESTONLY_SEARCH_ROTATED_0123456789_ABCDEFGHIJ";
const EXPLICIT_KEY = "TESTONLY_EXPLICIT_OVERRIDE_0123456789_ABCDEFGHIJ";
const LEGACY_KEY = "TESTONLY_LEGACY_COMPAT_0123456789_ABCDEFGHIJ";
const SECRET_ENV = ["PLATFORM_MCP_API_KEY", "SERVICE_ENTRY_SEARCH_GATEWAY_KEY", "SEARCH_GATEWAY_API_KEY"];
const ENV_NAMES = [...SECRET_ENV,
  "AI_ROOT", "AI_BILLING_DB", "SERVICE_ENTRY_DATA_DIR", "PLATFORM_MCP_ENV_FILE", "PLATFORM_CONFIG_ENV_KEYS",
  "PLATFORM_MCP_PORT", "SEARCH_GATEWAY_PORT", "TTS_GATEWAY_PORT", "VLLM_MANAGER_PORT", "LLAMA_MANAGER_PORT",
  "SERVICE_ENTRY_HOST", "SERVICE_ENTRY_REQUIRE_API_KEY", "SERVICE_ENTRY_ALLOW_LAN_ADMIN", "SERVICE_ENTRY_REQUIRE_PAIRING",
  "SERVICE_ENTRY_ALLOWED_HOSTS", "SERVICE_ENTRY_ALLOWED_ORIGINS", "SERVICE_ENTRY_PUBLIC_BASE_URL", "SERVICE_ENTRY_TRUSTED_PROXIES",
];
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const noAcl = { async secure() {} };
const dpapi = createFakeDpapi();
const realFactory = secretApi.createSecretStore;
const writer = realFactory({ aiRoot: TEST_ROOT, namespace: "platform", dpapi, acl: noAcl });
const vault = secretApi.createSecretVault({ aiRoot: TEST_ROOT, dpapi, acl: noAcl });
const servers = [];
const observations = [];
const legacyReads = { mcp: 0, search: 0 };
const expected = { mcp: "", search: "" };
let entry;
let entryPort;
let mcpPort;
let callerKey;

function fakeUpstream(service) {
  return http.createServer((req, res) => {
    req.resume();
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const authorized = Boolean(expected[service]) && req.headers.authorization === `Bearer ${expected[service]}`;
    observations.push({ service, pathname, authorized, callerForwarded: Boolean(callerKey) && req.headers.authorization === `Bearer ${callerKey}` });
    res.setHeader("content-type", "application/json");
    if (service === "mcp" && pathname === "/health") return res.end(JSON.stringify({ ok: true, service: "local-ai-platform-mcp", auth_required: true, read_only: true }));
    if (!authorized) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { code: "upstream_unauthorized", message: "Upstream authentication required." } }));
    }
    if (service === "mcp" && pathname === "/info") return res.end(JSON.stringify({ tools: ["fixture_tool_one", "fixture_tool_two"], policy: { read_only: true } }));
    return res.end(JSON.stringify({ ok: true }));
  });
}

function assertNoLeak(answer) {
  const text = typeof answer === "string" ? answer : JSON.stringify(answer);
  const privateValues = [MCP_KEY, SEARCH_KEY, ROTATED_SEARCH, EXPLICIT_KEY, LEGACY_KEY, callerKey, TEST_ROOT, ROOT].filter(Boolean);
  assert.equal(privateValues.some((value) => text.includes(value)), false, "responses must not contain a credential or private path");
}

async function call(pathname, options = {}) {
  entry.resetEntryRateLimitBuckets();
  return request(entryPort, pathname, { ...options, headers: { authorization: `Bearer ${callerKey}`, ...options.headers } });
}

test.before(async () => {
  for (const name of ENV_NAMES) delete process.env[name];
  process.env.AI_ROOT = TEST_ROOT;
  process.env.AI_BILLING_DB = path.join(TEST_ROOT, "billing.sqlite");
  process.env.SERVICE_ENTRY_DATA_DIR = path.join(TEST_ROOT, "data");
  process.env.PLATFORM_MCP_ENV_FILE = MCP_ENV;
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "1";
  process.env.SERVICE_ENTRY_HOST = "127.0.0.1";
  test.mock.method(secretApi, "createSecretStore", (options) => realFactory({ ...options, aiRoot: TEST_ROOT, dpapi, acl: noAcl }));
  const readFile = fsp.readFile;
  test.mock.method(fsp, "readFile", (file, ...args) => {
    const resolved = path.resolve(String(file));
    if (resolved === ORIGINAL_SEARCH) {
      legacyReads.search += 1;
      return readFile(LEGACY_SEARCH, ...args);
    }
    if (resolved === MCP_ENV) legacyReads.mcp += 1;
    return readFile(file, ...args);
  });
  const mcp = fakeUpstream("mcp");
  const search = fakeUpstream("search");
  servers.push(mcp, search);
  mcpPort = await listen(mcp);
  process.env.PLATFORM_MCP_PORT = String(mcpPort);
  process.env.SEARCH_GATEWAY_PORT = String(await listen(search));
  for (const name of ["VLLM_MANAGER_PORT", "LLAMA_MANAGER_PORT", "TTS_GATEWAY_PORT"]) process.env[name] = String(await unusedPort());
  entry = require("../server");
  entry.setEntryGatewayAccessSink(async () => {});
  callerKey = entry.getAccessStore().createKey({ name: "fixture auxiliary caller", class: "owner", models: ["*"], scopes: ["mcp", "search"], listeners: ["admin"] }, { actor: "test" }).secret;
  const server = entry.createServiceEntryServer();
  servers.push(server);
  entryPort = await listen(server);
});

test.beforeEach(async () => {
  for (const name of SECRET_ENV) delete process.env[name];
  delete process.env.PLATFORM_CONFIG_ENV_KEYS;
  for (const { name } of writer.list()) await writer.remove(name);
  await fsp.rm(MCP_ENV, { force: true });
  await fsp.rm(LEGACY_SEARCH, { force: true });
  expected.mcp = "";
  expected.search = "";
  observations.length = 0;
  legacyReads.mcp = 0;
  legacyReads.search = 0;
});

test.after(async () => {
  for (const server of servers) {
    if (!server.listening) continue;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  await entry?.stopTelemetry();
  entry?.closeAccessStore();
  test.mock.restoreAll();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
});

test("MCP hook migration is visible to an already loaded entry without injecting the child env", async () => {
  expected.mcp = MCP_KEY;
  const before = await call("/gateway/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "initialize" } });
  assert.equal(before.status, 401, "the upstream initially has no credential from the entry");
  await fsp.mkdir(path.dirname(MCP_ENV), { recursive: true });
  await fsp.writeFile(MCP_ENV, `PLATFORM_MCP_API_KEY=${MCP_KEY}\nPLATFORM_MCP_EXTRA=keep\n`, "utf8");
  const migrated = await mcpHook.prepare({ aiRoot: TEST_ROOT, secrets: vault });
  assert.equal(migrated.imported, true);
  assert.equal(migrated.scrubbed, true);
  assert.equal(vault.get("platform", "platformMcp.apiKey") === MCP_KEY, true, "the real vault contains the migrated credential");
  assert.equal((await fsp.readFile(MCP_ENV, "utf8")).includes(MCP_KEY), false);
  assert.equal(process.env.PLATFORM_MCP_API_KEY, undefined, "the MCP child env was never copied into entry");
  const info = await call("/gateway/mcp/info");
  assert.equal(info.status, 200, "the entry must read the migrated vault credential");
  assert.equal(info.json.tools.length, 2);
  const rpc = await call("/gateway/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 2, method: "initialize" } });
  assert.equal(rpc.status, 200);
  const status = await entry.buildPlatformMcpStatus({ port: mcpPort });
  assert.equal(status.healthy, true);
  assert.equal(status.toolCount, 2, "status must authenticate its separate /info request");
  assert.equal(observations.some((hit) => hit.callerForwarded), false);
  assertNoLeak(info.text);
  assertNoLeak(rpc.text);
  assertNoLeak(status);
});

test("search sees late vault writes and rotations despite an injected env snapshot", async () => {
  expected.search = SEARCH_KEY;
  const before = await call("/gateway/search/v1/models");
  assert.equal(before.status, 401, "the initial empty vault has no upstream credential");
  await writer.set("search.apiKey", SEARCH_KEY);
  const available = await call("/gateway/search/v1/models");
  assert.equal(available.status, 200, "an already loaded entry must see another writer's new vault entry");
  assertNoLeak(available.text);

  // childEnv injects a snapshot; its marker means it is not an owner override.
  process.env.SERVICE_ENTRY_SEARCH_GATEWAY_KEY = SEARCH_KEY;
  await writer.set("search.apiKey", ROTATED_SEARCH);
  expected.search = ROTATED_SEARCH;
  for (const delimiter of [",", ";"]) {
    process.env.PLATFORM_CONFIG_ENV_KEYS = `UNRELATED${delimiter}SERVICE_ENTRY_SEARCH_GATEWAY_KEY`;
    const rotated = await call("/gateway/search/v1/models");
    assert.equal(rotated.status, 200, "a marked injected credential must not hide vault rotation");
    assertNoLeak(rotated.text);
  }
  assert.equal(observations.filter((hit) => hit.service === "search" && hit.authorized).length, 3);
  assert.equal(observations.some((hit) => hit.callerForwarded), false);
});

test("explicit env overrides vault while an empty vault retains legacy file compatibility", async () => {
  await writer.set("platformMcp.apiKey", MCP_KEY);
  await writer.set("search.apiKey", SEARCH_KEY);
  await fsp.mkdir(path.dirname(MCP_ENV), { recursive: true });
  await fsp.writeFile(MCP_ENV, `PLATFORM_MCP_API_KEY=${LEGACY_KEY}\n`, "utf8");
  await fsp.writeFile(LEGACY_SEARCH, LEGACY_KEY, "utf8");
  expected.mcp = MCP_KEY;
  expected.search = SEARCH_KEY;
  assert.equal((await call("/gateway/mcp/info")).status, 200, "the vault takes precedence over a legacy MCP file");
  assert.equal((await call("/gateway/search/v1/models")).status, 200, "the vault takes precedence over a legacy search file");

  process.env.PLATFORM_MCP_API_KEY = EXPLICIT_KEY;
  process.env.SERVICE_ENTRY_SEARCH_GATEWAY_KEY = EXPLICIT_KEY;
  process.env.SEARCH_GATEWAY_API_KEY = LEGACY_KEY;
  expected.mcp = EXPLICIT_KEY;
  expected.search = EXPLICIT_KEY;
  const explicitMcp = await call("/gateway/mcp/info");
  const explicitSearch = await call("/gateway/search/v1/models");
  assert.equal(explicitMcp.status, 200);
  assert.equal(explicitSearch.status, 200, "the explicit entry-specific search env wins over the alias");
  assertNoLeak(explicitMcp.text);
  assertNoLeak(explicitSearch.text);
  delete process.env.SERVICE_ENTRY_SEARCH_GATEWAY_KEY;
  expected.search = LEGACY_KEY;
  assert.equal((await call("/gateway/search/v1/models")).status, 200, "the unmarked search env alias remains an explicit override");

  for (const name of SECRET_ENV) delete process.env[name];
  await writer.remove("platformMcp.apiKey");
  await writer.remove("search.apiKey");
  expected.mcp = LEGACY_KEY;
  expected.search = LEGACY_KEY;
  const legacyMcp = await call("/gateway/mcp/info");
  const legacySearch = await call("/gateway/search/v1/models");
  assert.equal(legacyMcp.status, 200, "an empty vault may still read the old MCP file");
  assert.equal(legacySearch.status, 200, "an empty vault may still read the old search file");
  assert.equal((await fsp.readFile(MCP_ENV, "utf8")).includes(LEGACY_KEY), true, "reading a legacy credential does not migrate it");
  assert.equal((await fsp.readFile(LEGACY_SEARCH, "utf8")) === LEGACY_KEY, true);
  assertNoLeak(legacyMcp.text);
  assertNoLeak(legacySearch.text);
});

test("corrupt vault credentials fail closed without stale file fallback or private error details", async () => {
  await writer.set("platformMcp.apiKey", MCP_KEY);
  await writer.set("search.apiKey", SEARCH_KEY);
  expected.mcp = MCP_KEY;
  expected.search = SEARCH_KEY;
  assert.equal((await call("/gateway/mcp/info")).status, 200);
  assert.equal((await call("/gateway/search/v1/models")).status, 200);
  await fsp.mkdir(path.dirname(MCP_ENV), { recursive: true });
  await fsp.writeFile(MCP_ENV, `PLATFORM_MCP_API_KEY=${LEGACY_KEY}\n`, "utf8");
  await fsp.writeFile(LEGACY_SEARCH, LEGACY_KEY, "utf8");
  await fsp.writeFile(writer.file, `{invalid ${MCP_KEY} ${SEARCH_KEY}`, "utf8");
  const before = observations.length;
  legacyReads.mcp = 0;
  legacyReads.search = 0;
  for (const pathname of ["/gateway/mcp/info", "/gateway/search/v1/models"]) {
    const answer = await call(pathname);
    assert.equal(answer.status, 503, "a corrupt credential store must not use cached or legacy credentials");
    assert.equal(answer.json?.error?.code, "service_unavailable");
    assert.equal(answer.json?.detail, undefined);
    assert.equal(/SECRET_STORE|platform\.json|DPAPI|[A-Za-z]:[\\/]/.test(answer.text), false, "credential errors remain generic");
    assertNoLeak(answer.text);
  }
  assert.equal(observations.length, before, "neither request reaches its upstream when the vault is corrupt");
  assert.deepEqual(legacyReads, { mcp: 0, search: 0 }, "corrupt stores never fall back to stale plaintext files");
  const status = await entry.buildPlatformMcpStatus({ port: mcpPort });
  assert.equal(status.healthy, false);
  assert.equal(status.toolCount || 0, 0);
  assertNoLeak(status);
});
