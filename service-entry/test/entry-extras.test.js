"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const { createEntrySecurity } = require("../lib/security");
const { summarizeServiceKeys, redactKeySummary, classifyClient } = require("../lib/key-overview");
const { parseAuxGatewayRoute, buildAuxUpstreamPath, parseEnvFileValue } = require("../lib/aux-gateway");

const SWITCH_ENV = ["SERVICE_ENTRY_REQUIRE_API_KEY", "SERVICE_ENTRY_ALLOW_LAN_ADMIN", "SERVICE_ENTRY_ALLOWED_ORIGINS", "SERVICE_ENTRY_PUBLIC_BASE_URL"];

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

test("public checklist fails the key item when a public deployment has no enforced key", async (t) => {
  withCleanEnv(t);
  process.env.SERVICE_ENTRY_PUBLIC_BASE_URL = "http://models.example.com";
  process.env.SERVICE_ENTRY_ALLOW_LAN_ADMIN = "1";
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [] });
  const state = await security.describe();
  assert.equal(state.publicMode, true);
  assert.equal(state.exposure, "public");
  const byId = Object.fromEntries(state.publicChecklist.map((item) => [item.id, item]));
  assert.equal(byId["api-key"].state, "fail");
  assert.equal(byId["lan-admin"].state, "warn", "open LAN admin is information, a warning only in a public deployment, never a failure");
  assert.equal(byId.https.state, "fail", "http:// public base URL is flagged");
  // SERVICE_ENTRY_ALLOW_LAN_ADMIN maps to listeners.admin.lan (OPS-3), so
  // ADMIN is LAN-bound here even though the constructor host is loopback.
  assert.equal(byId["loopback-bind"].state, "warn");
  assert.equal(byId["caddy-paths"], undefined, "caddy-paths is now proxy-target (05 §13.1)");
  assert.equal(byId["proxy-target"].state, "manual", "without a scan the item stays manual");
  assert.equal(byId.firewall.state, "manual");
  assert.equal(security.describePublic(state).exposure, "public");
  assert.equal(security.describePublic(state).publicChecklist, undefined, "LAN callers do not get the checklist");
});

test("public checklist maps proxy-target and firewall from the exposure scan and keeps every other id", async (t) => {
  withCleanEnv(t);
  process.env.SERVICE_ENTRY_PUBLIC_BASE_URL = "https://models.example.com";
  const check = (id, state, evidence = "") => ({ id, state, title: `access.check.${id}`, evidence, fix: `access.fix.${id}` });
  let report = {
    at: "2026-10-15T00:00:00.000Z",
    checks: [
      check("tunnel_target", "fail", "legacy_tunnel_bypasses_entry"),
      check("legacy_proxy", "ok"),
      check("firewall_profiles", "ok"),
      check("wildcard_listeners", "warn", "5190 listens on all interfaces"),
    ],
  };
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [], exposureReport: () => report });
  const ids = (state) => state.publicChecklist.map((item) => item.id);
  let state = await security.describe();
  assert.deepEqual(ids(state), ["api-key", "lan-admin", "cors", "https", "loopback-bind", "rate-limit", "proxy-target", "firewall"]);
  let byId = Object.fromEntries(state.publicChecklist.map((item) => [item.id, item]));
  assert.equal(byId["proxy-target"].state, "fail");
  assert.equal(byId["proxy-target"].detail, "legacy_tunnel_bypasses_entry");
  assert.equal(byId.firewall.state, "warn", "the worst of the firewall and wildcard checks");
  assert.equal(byId.firewall.detail, "5190 listens on all interfaces");

  report = { checks: [check("tunnel_target", "ok"), check("firewall_profiles", "unknown"), check("wildcard_listeners", "unknown")] };
  state = await security.describe();
  byId = Object.fromEntries(state.publicChecklist.map((item) => [item.id, item]));
  assert.equal(byId["proxy-target"].state, "ok");
  assert.equal(byId.firewall.state, "manual", "unknown checks stay manual");

  // A scan that throws or returns nothing never breaks the security view.
  security.setExposureReport(() => { throw new Error("scan failed"); });
  state = await security.describe();
  assert.equal(state.publicChecklist.find((item) => item.id === "proxy-target").state, "manual");
  security.setExposureReport(null);
  assert.equal((await security.describe()).publicChecklist.find((item) => item.id === "firewall").state, "manual");
});

test("public checklist is informational on a loopback-only install", async (t) => {
  withCleanEnv(t);
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [] });
  const state = await security.describe();
  assert.equal(state.exposure, "local");
  const keyItem = state.publicChecklist.find((item) => item.id === "api-key");
  assert.equal(keyItem.state, "info");
  assert.equal(state.publicChecklist.some((item) => item.id === "https"), false);
});

test("key overview classifies clients and flags expired, unused and expiring keys", () => {
  const nowMs = Date.parse("2026-09-03T00:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  const managers = [{
    id: "vllm",
    name: "vLLM Manager",
    baseUrl: "http://127.0.0.1:5177",
    servicePageUrl: "http://127.0.0.1:5177/#exposure",
    process: { portListening: true },
    exposure: { settings: { hasApiKey: true } },
    clients: {
      clients: [
        { id: "a", name: "laptop", enabled: true, createdAt: new Date(nowMs - 100 * day).toISOString(), lastUsedAt: new Date(nowMs - 40 * day).toISOString() },
        { id: "b", name: "old", enabled: true, expiresAt: new Date(nowMs - day).toISOString() },
        { id: "c", name: "soon", enabled: true, createdAt: new Date(nowMs - day).toISOString(), lastUsedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 3 * day).toISOString() },
        { id: "d", name: "off", enabled: false },
      ],
    },
  }, {
    id: "llama",
    name: "llama.cpp Manager",
    process: { portListening: false },
    clients: null,
  }];
  const summary = summarizeServiceKeys(managers, { nowMs });
  assert.equal(summary.total, 4);
  assert.equal(summary.active, 2);
  assert.equal(summary.expired, 1);
  assert.equal(summary.disabled, 1);
  assert.equal(summary.unused, 1);
  assert.equal(summary.expiringSoon, 1);
  assert.deepEqual(summary.globalKeys, ["vllm"]);
  assert.equal(summary.perManager[1].total, 0);
  assert.equal(summary.perManager[1].online, false);
  const reasons = summary.attention.map((item) => `${item.client.id}:${item.level}`);
  assert.deepEqual(reasons.sort(), ["a:info", "b:warn", "c:warn"]);
  assert.equal(summary.clients[0].managePageUrl, "http://127.0.0.1:5177/#exposure");
  assert.equal(classifyClient({ enabled: true }, nowMs), "active");
  const redacted = redactKeySummary(summary);
  assert.equal(redacted.clients, undefined);
  assert.equal(redacted.attention, undefined);
  assert.equal(redacted.total, 4);
});

test("auxiliary gateway routes map search and MCP paths and reject the rest", () => {
  assert.deepEqual(parseAuxGatewayRoute("/gateway/search/v1/chat/completions"), { service: "search", engine: "search", protocol: "search", rest: "v1/chat/completions" });
  assert.equal(buildAuxUpstreamPath(parseAuxGatewayRoute("/gateway/search/v1/chat/completions")), "/v1/chat/completions");
  assert.equal(buildAuxUpstreamPath(parseAuxGatewayRoute("/gateway/search/search")), "/search");
  assert.equal(buildAuxUpstreamPath(parseAuxGatewayRoute("/gateway/mcp")), "/mcp");
  assert.equal(buildAuxUpstreamPath(parseAuxGatewayRoute("/gateway/mcp/info")), "/info");
  assert.equal(parseAuxGatewayRoute("/gateway/auto/openai/v1/models"), null);
  assert.throws(() => buildAuxUpstreamPath(parseAuxGatewayRoute("/gateway/search/%2e%2e/etc")), (error) => error.status === 400);
  assert.throws(() => buildAuxUpstreamPath(parseAuxGatewayRoute("/gateway/search/admin")), (error) => error.status === 404);
  assert.throws(() => buildAuxUpstreamPath(parseAuxGatewayRoute("/gateway/mcp/tools")), (error) => error.status === 404);
  assert.equal(parseEnvFileValue("A=1\nPLATFORM_MCP_API_KEY=abc def \nB=2", "PLATFORM_MCP_API_KEY"), "abc def");
  assert.equal(parseEnvFileValue("", "PLATFORM_MCP_API_KEY"), "");
});

// --- /api/gateway-access and /api/status entry.gatewayAccess facade (04 TEL-12) ---

const ACCESS_KEYS = ["ok", "updatedAt", "logPath", "privacy", "totals", "external", "local", "clients", "paths", "models", "authSources", "kinds", "statuses", "timeline", "recent"];

// The key skeleton of a payload: plain objects recurse to a fixed depth, a list stands
// for the keys of its first element (group items carry data-keyed maps below that).
function keySkeleton(value, depth = 0) {
  if (Array.isArray(value)) return value.length ? { item: Object.keys(value[0]).sort() } : [];
  if (value && typeof value === "object") {
    if (depth >= 2) return "object";
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, keySkeleton(value[key], depth + 1)]));
  }
  return typeof value;
}

function accessRow(index, receivedAt, extra = {}) {
  return {
    requestId: `req_${String(index).padStart(20, "0")}`,
    ingress: "entry",
    receivedAt,
    endedAt: receivedAt + 500,
    protocol: "openai",
    op: "chat",
    method: "POST",
    path: "/gateway/auto/openai/v1/chat/completions",
    modelRequested: "auto",
    modelResolved: "model-a",
    stream: false,
    keyId: "key_test",
    authSource: "bearer",
    clientIp: "127.0.0.1",
    userAgent: "test-agent",
    sourceProgram: "curl",
    status: 200,
    terminalState: "completed",
    errorClass: "none",
    durationMs: 500,
    promptTokens: 10,
    outputTokens: 20,
    usageSource: "reported",
    ...extra,
  };
}

async function withAccessStore(t, rows) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { openTelemetryStore } = require("../../manager-core/telemetry/store");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "entry-access-"));
  const store = await openTelemetryStore({ file: path.join(base, "telemetry.sqlite"), inProcess: true, logger: null });
  t.after(async () => {
    await store.close({ flushMs: 0 });
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  assert.equal((await store.insertRequests(rows)).rejected, 0);
  return store;
}

function loadEntryForAccess() {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  if (!process.env.AI_BILLING_DB) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-access-billing-"));
    process.env.AI_BILLING_DB = path.join(dir, "billing.sqlite");
    process.env.SERVICE_ENTRY_DATA_DIR = path.join(dir, "data");
  }
  return require("../server");
}

test("gateway access facade keeps its shape, uses a 1 h window and drops TTS polling", async (t) => {
  const core = require("../../manager-core");
  const entry = loadEntryForAccess();
  const now = Date.now();
  const MIN = 60_000;
  const store = await withAccessStore(t, [
    accessRow(1, now - 5 * MIN),
    accessRow(2, now - 4 * MIN, { clientIp: "203.0.113.9", status: 500, terminalState: "failed", errorClass: "upstream_5xx", modelResolved: "model-b" }),
    accessRow(3, now - 3 * MIN, { ingress: "public", clientIp: "127.0.0.1", authSource: "x-api-key" }),
    // Older than the window: only a wider window sees it.
    accessRow(4, now - 90 * MIN, { path: "/gateway/auto/openai/v1/embeddings", op: "embeddings" }),
    // A stray TTS poll row must not reach paths or recent.
    accessRow(5, now - 2 * MIN, { method: "GET", path: "/gateway/tts/api/jobs/job_1", protocol: "tts", op: "other", route: "tts" }),
    accessRow(6, now - 1 * MIN, { method: "POST", path: "/gateway/tts/openai/v1/audio/speech", protocol: "tts", op: "speech", route: "tts" }),
  ]);

  const result = await entry.collectEntryGatewayAccessStats({ store, now, limit: 50, maxLines: 5 });
  assert.deepEqual(Object.keys(result), ACCESS_KEYS);
  assert.equal(result.ok, true);
  assert.equal(result.logPath, "telemetry.sqlite");
  assert.equal(result.totals.requests.total, 4);
  assert.equal(result.external.requests.total, 2, "a non-local client address or public ingress is external");
  assert.equal(result.local.requests.total, 2);
  const paths = result.paths.map((item) => item.key || item.name || item.label || item.value || Object.values(item)[0]);
  assert.ok(!paths.some((value) => String(value).includes("/gateway/tts/api/jobs")), "TTS polling is not listed in paths");
  assert.ok(paths.some((value) => String(value).includes("audio/speech")), "TTS synthesis is");
  assert.ok(!paths.some((value) => String(value).includes("embeddings")), "outside the 1 h window");
  assert.ok(!result.recent.some((event) => event.path.includes("/gateway/tts/api/jobs")));
  assert.equal(result.recent.length, 4);
  assert.ok(result.recent[0].atMs >= result.recent[1].atMs, "newest first");

  // Deep key comparison with what the log-based computation produced.
  const lan = core.getLanAddress();
  const legacyEvents = [
    { at: new Date(now - MIN).toISOString(), remoteAddress: "203.0.113.9", method: "POST", path: "/x", kind: "openai", status: 200, model: "m", authSource: "bearer", inputTokens: 1, outputTokens: 2 },
    { at: new Date(now - 2 * MIN).toISOString(), remoteAddress: "127.0.0.1", method: "POST", path: "/y", kind: "openai", status: 500, model: "m", authSource: "bearer" },
  ].map((entryRow) => core.normalizeAccessEvent(entryRow, lan));
  const legacy = {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    logPath: "x",
    privacy: "x",
    totals: core.summarizeAccessEvents(legacyEvents, now),
    external: core.summarizeAccessEvents(legacyEvents.filter((e) => e.external), now),
    local: core.summarizeAccessEvents(legacyEvents.filter((e) => !e.external), now),
    clients: core.groupAccessEvents(legacyEvents.filter((e) => e.external), (e) => e.remoteAddress || "unknown", { limit: 40 }),
    paths: core.groupAccessEvents(legacyEvents, (e) => e.path || "-", { limit: 30 }),
    models: core.groupAccessEvents(legacyEvents, (e) => e.model || "-", { limit: 30 }),
    authSources: core.groupAccessEvents(legacyEvents, (e) => e.authSource || "none", { limit: 20 }),
    kinds: core.groupAccessEvents(legacyEvents, (e) => e.kind || "-", { limit: 10 }),
    statuses: core.groupAccessEvents(legacyEvents, (e) => String(e.status || 0), { limit: 20 }),
    timeline: core.buildAccessTimeline(legacyEvents, now),
    recent: legacyEvents.slice().reverse(),
  };
  const skeleton = keySkeleton(result);
  const expected = keySkeleton(legacy);
  for (const key of ACCESS_KEYS) {
    assert.deepEqual(skeleton[key], expected[key], `shape of ${key}`);
  }

  // A wider window sees the older row.
  const wide = await entry.collectEntryGatewayAccessStats({ store, now, window: "3h" });
  assert.equal(wide.totals.requests.total, 5);
  assert.ok(wide.paths.some((item) => JSON.stringify(item).includes("embeddings")));
});
