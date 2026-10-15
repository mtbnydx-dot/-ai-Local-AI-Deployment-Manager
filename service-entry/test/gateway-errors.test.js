const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Upstream-down bodies on /gateway/* (P0-26). Every upstream port points at a
// port nothing listens on (or at a fake manager this file controls), so no
// request can reach a real local service. The entry reads its ports when it
// is loaded, which is why setup() runs before require("../server").
const CLEARED_ENV = [
  "SERVICE_ENTRY_HOST",
  "SERVICE_ENTRY_REQUIRE_API_KEY",
  "SERVICE_ENTRY_ALLOW_LAN_ADMIN",
  "SERVICE_ENTRY_ALLOWED_ORIGINS",
  "SERVICE_ENTRY_ALLOWED_HOSTS",
  "SERVICE_ENTRY_PUBLIC_BASE_URL",
  "SERVICE_ENTRY_TRUSTED_PROXIES",
  "SERVICE_ENTRY_RATE_LIMIT_RPM",
];

// What a public caller must never learn from an error body.
const LEAKS = [
  [/[A-Za-z]:[\\/]|\\/, "a Windows path"],
  [/(?:^|[\s"'(])\/[\w.-]+\/[\w./-]*/, "a POSIX path"],
  [/\b(?:5176|5177|5178|5180|5186|5190|7000)\b|\bport\s+\d+|:\d{2,5}\b/i, "a port"],
  [/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, "an env var name"],
];

function assertNoLeak(text, label) {
  for (const [pattern, what] of LEAKS) {
    assert.doesNotMatch(String(text), pattern, `${label} leaks ${what}: ${text}`);
  }
}

let entry = null;
let entryServer = null;
let entryPort = 0;
let manager = null;
let tempDir = "";
const captured = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function setup() {
  if (entry) return;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-gateway-errors-"));
  for (const name of CLEARED_ENV) delete process.env[name];
  manager = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ instances: [{ id: "primary", primary: true, running: true, models: [{ id: "fake-model" }] }] }));
  });
  process.env.VLLM_MANAGER_PORT = String(await listen(manager));
  process.env.LLAMA_MANAGER_PORT = String(await unusedPort());
  process.env.TTS_GATEWAY_PORT = String(await unusedPort());
  process.env.SEARCH_GATEWAY_PORT = String(await unusedPort());
  process.env.PLATFORM_MCP_PORT = String(await unusedPort());
  // Long catalog cache, short port probe: the manager goes down after its
  // catalog was read, which is the "manager is not listening" branch.
  process.env.SERVICE_ENTRY_MODEL_CACHE_MS = "60000";
  process.env.SERVICE_ENTRY_PORT_PROBE_CACHE_MS = "250";
  process.env.AI_BILLING_DB = path.join(tempDir, "billing.sqlite");
  process.env.SERVICE_ENTRY_DATA_DIR = path.join(tempDir, "data");
  entry = require("../server");
  entry.setEntryGatewayAccessSink(async (event) => { captured.push(event); });
  entryServer = entry.createServiceEntryServer();
  entryPort = await listen(entryServer);
}

test.after(async () => {
  for (const server of [entryServer, manager]) {
    if (!server?.listening) continue;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  // Gateway auth opens the access store beside the ledger (PUB-8).
  entry?.closeAccessStore();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function call(pathname, { method = "GET", body } = {}) {
  const response = await fetch(`http://127.0.0.1:${entryPort}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, text: await response.text() };
}

test("an offline model manager answers with a generic service_unavailable body", async () => {
  await setup();
  // First call reads the catalog while the manager is up; the fake manager
  // has no /serve route, so whatever it answers is irrelevant here.
  await entry.getManagerModelCatalog(entry.findManager("vllm"), { force: true });
  manager.closeAllConnections?.();
  await new Promise((resolve) => manager.close(resolve));
  await delay(400);

  const { status, text } = await call("/gateway/vllm/openai/v1/chat/completions", {
    method: "POST",
    body: { model: "fake-model", messages: [] },
  });
  assert.equal(status, 503);
  const body = JSON.parse(text);
  assert.equal(body.error.code, "service_unavailable");
  assert.equal(body.error.message, "上游服务未运行 / Upstream service is not running");
  assertNoLeak(text, "manager offline body");
  assert.equal(text.includes(process.env.VLLM_MANAGER_PORT), false);

  // The operator still gets the detail, in the access log.
  await delay(50);
  const logged = captured.find((event) => event.path === "/gateway/vllm/openai/v1/chat/completions" && event.status === 503);
  assert.ok(logged, "the offline request is logged");
  assert.match(logged.error, /not listening on port/);
});

test("offline TTS, search and MCP upstreams answer generically", async () => {
  await setup();
  for (const pathname of ["/gateway/tts/api/jobs", "/gateway/search/v1/models", "/gateway/mcp/health"]) {
    const { status, text } = await call(pathname);
    assert.equal(status, 503, pathname);
    const body = JSON.parse(text);
    const code = body.error?.code || body.code;
    const message = body.error?.message || body.detail;
    assert.equal(code, "service_unavailable", pathname);
    assert.equal(message, "上游服务未运行 / Upstream service is not running", pathname);
    assertNoLeak(text, pathname);
  }
  await delay(50);
  for (const pathname of ["/gateway/tts/api/jobs", "/gateway/search/v1/models", "/gateway/mcp/health"]) {
    const logged = captured.find((event) => event.path === pathname && event.status === 503);
    assert.ok(logged, `${pathname} is logged`);
    assert.match(logged.error, /not listening on port \d+/);
  }
});

test("access-log error details pass through the redactor", async () => {
  await setup();
  const fakeKey = "sk-fakeAccessKey001";
  const event = entry.buildEntryGatewayAccessEntry(
    { method: "POST", url: "/gateway/auto/openai/v1/chat/completions", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    entry.parseGatewayRoute("/gateway/auto/openai/v1/chat/completions"),
    null,
    502,
    Date.now(),
    null,
    `upstream said: Authorization: Bearer ${fakeKey}`,
  );
  assert.equal(event.error.includes(fakeKey), false);
  assert.match(event.error, /<redacted>/);
});
