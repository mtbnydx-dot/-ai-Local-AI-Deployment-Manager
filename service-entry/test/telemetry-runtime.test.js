"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildTailFiles, createTelemetryRuntime, mcpAuditLogFile, resolveTelemetryConfig } = require("../lib/telemetry-runtime");

// The runtime wires the EventCollector to the entry. Every dependency is a
// fake: the bus, the store and the docker source; no process starts.

function fakeBus() {
  const calls = [];
  let handler = null;
  return {
    calls,
    subscribe(fn, options) {
      calls.push({ fn: typeof fn, types: options?.types });
      handler = fn;
      return () => {
        handler = null;
        calls.push({ unsubscribed: true });
      };
    },
    deliver(type, data) {
      if (handler) handler({ id: 1, type, at: new Date().toISOString(), data });
    },
    publish() {
      throw new Error("the telemetry runtime must not publish");
    },
  };
}

function fakeStore() {
  const rows = [];
  const state = new Map();
  return {
    rows,
    state: "ok",
    async insertEvents(batch) {
      rows.push(...batch);
      return { accepted: batch.length, duplicates: 0, rejected: 0, dropped: 0, errors: [] };
    },
    async getState(name) {
      return state.get(name) ?? null;
    },
    async setState(name, value) {
      state.set(name, JSON.parse(JSON.stringify(value)));
    },
    async close() {
      this.closed = true;
    },
  };
}

test("the runtime subscribes once through events.subscribe and records config changes", async () => {
  const bus = fakeBus();
  const store = fakeStore();
  const runtime = createTelemetryRuntime({
    aiRoot: os.tmpdir(),
    dataDir: os.tmpdir(),
    managers: [],
    events: bus,
    env: {},
    docker: false,
    logger: null,
    openStore: async () => store,
    config: {},
  });
  await runtime.start();
  assert.equal(bus.calls.length, 1);
  assert.deepEqual(bus.calls[0].types, ["jobs", "instances", "status", "downloads", "security", "access", "platform"]);

  runtime.recordConfigChange("fleet", { before: { a: 1, b: { c: 2 } }, after: { a: 1, b: { c: 3 } } });
  assert.equal(runtime.recordConfigChange("nonsense", ["x"]), null);
  await runtime.collectors.events.flush();
  const row = store.rows.find((item) => item.type === "config.fleet");
  assert.ok(row);
  assert.deepEqual(row.data.changed, ["b.c"]);
  assert.equal(JSON.stringify(row).includes('"3"'), false);
  assert.equal(runtime.status().collectors.events.docker.state, "disabled");

  await runtime.stop();
  assert.equal(store.closed, true);
  assert.ok(bus.calls.some((call) => call.unsubscribed));
});

test("TELEMETRY_ENABLED=0 runs nothing, and a store that cannot open never throws", async () => {
  let opened = 0;
  const off = createTelemetryRuntime({
    aiRoot: os.tmpdir(), dataDir: os.tmpdir(), events: fakeBus(), env: { TELEMETRY_ENABLED: "0" }, docker: false, logger: null, config: {},
    openStore: async () => { opened += 1; return fakeStore(); },
  });
  await off.start();
  assert.equal(opened, 0);
  assert.equal(off.status().store, "disabled");
  assert.equal(off.recordConfigChange("fleet", ["x"]), null);

  const broken = createTelemetryRuntime({
    aiRoot: os.tmpdir(), dataDir: os.tmpdir(), events: fakeBus(), env: {}, docker: false, logger: null, config: {},
    openStore: async () => { throw new Error("disk is read-only"); },
  });
  await broken.start();
  assert.match(broken.status().lastError, /read-only/);
  assert.equal(broken.recordConfigChange("fleet", ["x"]), null);
  await broken.stop();
});

test("tail files cover the entry, each manager and the MCP audit log inside the AI root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-runtime-"));
  try {
    const tails = buildTailFiles({
      aiRoot: root,
      managers: [{ id: "vllm", root: path.join(root, "vllm-manager") }, { id: "llama", root: path.join(root, "llama-manager") }, { id: "", root: "" }],
      processExitLog: path.join(root, "service-entry", "logs", "process-exit.log"),
      env: {},
    });
    assert.deepEqual(tails.map((item) => item.id), ["process-exit:entry", "process-exit:vllm", "process-exit:llama", "mcp"]);
    assert.equal(tails[1].file, path.join(root, "vllm-manager", "logs", "process-exit.log"));
    assert.equal(tails[3].file, path.join(root, "audit-logs", "platform-mcp.jsonl"));
    assert.equal(mcpAuditLogFile(root, { PLATFORM_MCP_AUDIT_LOG: path.join(os.tmpdir(), "elsewhere", "x.jsonl") }), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings: env beats the section, and the default database sits in the data directory", () => {
  const dataDir = path.join(os.tmpdir(), "telemetry-data");
  assert.equal(resolveTelemetryConfig({ config: {}, env: {}, dataDir }).dbPath, path.join(dataDir, "telemetry.sqlite"));
  assert.equal(resolveTelemetryConfig({ config: { enabled: false }, env: {}, dataDir }).enabled, false);
  assert.equal(resolveTelemetryConfig({ config: { enabled: false }, env: { TELEMETRY_ENABLED: "1" }, dataDir }).enabled, true);
});
