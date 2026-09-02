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
  assert.equal(byId["lan-admin"].state, "fail");
  assert.equal(byId.https.state, "fail", "http:// public base URL is flagged");
  assert.equal(byId["loopback-bind"].state, "ok");
  assert.equal(byId["caddy-paths"].state, "manual");
  assert.equal(security.describePublic(state).exposure, "public");
  assert.equal(security.describePublic(state).publicChecklist, undefined, "LAN callers do not get the checklist");
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
