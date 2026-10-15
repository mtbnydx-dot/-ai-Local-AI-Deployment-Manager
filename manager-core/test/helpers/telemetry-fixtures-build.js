"use strict";

// Builds the console fixtures of docs/overhaul/04-telemetry.md section 19
// (tests/fixtures/telemetry/*.json) from REAL answers: a small deterministic
// dataset goes into a store in a temp folder and the answers come from the
// entry's own route handlers (telemetry-routes.js, audit-http.js) called in
// process with fakes for auth and the response. Nothing listens on a port and
// nothing touches the live root.
//
// telemetry-fixtures.test.js compares the committed files with this output.
// Regenerate them after an intended API change with:
//   UPDATE_TELEMETRY_FIXTURES=1 node --test manager-core/test/telemetry-fixtures.test.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../..");
const { openTelemetryStore } = require("../../telemetry/store");
const { openAuditIndex } = require("../../telemetry/audit-index");
const { createAuditScheduler } = require("../../telemetry/audit-scheduler");
const { createAlertRoutes, createQueryRoutes } = require("../../../service-entry/lib/telemetry-routes");
const { createAuditHttp, createAuditSessions } = require("../../../service-entry/lib/audit-http");

const MINUTE_MS = 60_000;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const FROM = NOW - 60 * MINUTE_MS;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const MODELS = ["model-a", "model-b"];

const FIXTURE_NAMES = Object.freeze([
  "live", "summary", "timeseries", "breakdown", "requests", "request-detail", "alerts", "audit-status", "audit-chats",
]);

function requestId(index, prefix = "req_") {
  let value = index;
  let text = "";
  for (let position = 0; position < 20; position += 1) {
    text = BASE32[value % 32] + text;
    value = Math.floor(value / 32);
  }
  return `${prefix}${text}`;
}

function request(index, receivedAt) {
  const failed = index % 10 === 9;
  const aborted = index % 7 === 6;
  const status = failed ? 500 : aborted ? 499 : 200;
  const ok = status === 200;
  const vllm = index % 2 === 1;
  return {
    requestId: requestId(index),
    managerRequestId: requestId(index, "mgr_"),
    ingress: "entry",
    receivedAt,
    endedAt: receivedAt + 800,
    managerId: vllm ? "vllm" : "llama",
    fleetId: vllm ? "vllm:primary" : "llama:primary",
    engineId: vllm ? "sglang" : "llamacpp",
    runtimeId: vllm ? "sglang@0.5.17" : "llamacpp@b10630",
    launchId: vllm ? "lch_aaaaaaaaaaaaaaaaaaaa" : null,
    protocol: "openai",
    op: "chat",
    method: "POST",
    path: "/gateway/auto/openai/v1/chat/completions",
    modelRequested: "auto",
    modelResolved: MODELS[index % 2],
    stream: index % 3 !== 0,
    keyId: `k_${index % 3}`,
    customerId: null,
    sourceProgram: vllm ? "openwebui" : "curl",
    clientIp: "192.0.2.10",
    userAgent: "fixture-agent",
    status,
    terminalState: failed ? "failed" : aborted ? "client_abort" : "completed",
    errorClass: failed ? "upstream_5xx" : aborted ? "client_abort" : "none",
    queueMs: 3,
    upstreamHeadersMs: 140,
    ttftMs: ok ? 100 + (index % 5) * 20 : null,
    durationMs: 800,
    decodeTps: ok ? 20 + (index % 7) : null,
    promptTokens: 100 + index,
    cachedTokens: 20,
    outputTokens: ok ? 50 + index : 0,
    usageSource: "reported",
    finishReason: "stop",
    extra: { toolSchemaCount: 0 },
  };
}

function runtimeSample(at, step) {
  return {
    at,
    fleetId: "vllm:primary",
    model: "model-a",
    managerId: "vllm",
    engineId: "sglang",
    runtimeKey: "k_vllm:primary",
    intervalMs: 10_000,
    scrapeOk: 1,
    idle: 0,
    latencySource: "engine_histogram",
    running: step % 3,
    waiting: 0,
    kvUsage: (20 + (step % 10)) / 100,
    dPromptTokens: 500,
    dCachedTokens: 100,
    dOutputTokens: 100,
    dRequests: 1,
    outputTps: 10,
    energyWh: 0.5,
    hist: { ttft: { le: [0.1, 0.5, 1, "+Inf"], d: [2, 5, 6, 6] } },
  };
}

function gpuSample(at) {
  return {
    at,
    gpuIndex: 0,
    gpuUuid: "GPU-00000000",
    name: "Test GPU",
    utilPct: 50,
    memUsedMb: 40_000,
    memTotalMb: 80_000,
    tempC: 60,
    powerW: 300,
    powerLimitW: 600,
    smClockMhz: 1800,
    energyWh: (300 * 10) / 3600,
    throttle: "",
  };
}

function events() {
  return [
    { at: FROM + 1000, type: "launch.started", severity: "info", source: "vllm", managerId: "vllm", fleetId: "vllm:primary", launchId: "lch_aaaaaaaaaaaaaaaaaaaa", title: "Launch started: model-a", data: { model: "model-a", engineId: "sglang", recipeId: "recipe-one" }, dedupeKey: "e1" },
    { at: FROM + 61_000, type: "launch.ready", severity: "info", source: "vllm", managerId: "vllm", fleetId: "vllm:primary", launchId: "lch_aaaaaaaaaaaaaaaaaaaa", title: "Launch ready: model-a", data: { model: "model-a", engineId: "sglang", recipeId: "recipe-one", durationMs: 60_000, summary: { contextLength: 262144, kvCacheDtype: "fp8" } }, dedupeKey: "e2" },
    { at: FROM + 20 * MINUTE_MS, type: "instance.state", severity: "info", source: "vllm", managerId: "vllm", fleetId: "vllm:primary", launchId: "lch_aaaaaaaaaaaaaaaaaaaa", title: "Instance ready", data: { state: "ready", model: "model-a" }, dedupeKey: "e3" },
  ];
}

function sampleHistory() {
  return [
    { auditId: "20261001-full", mode: "full", createdAt: "2026-10-01T04:00:00.000Z", chatCount: 5, messageCount: 20 },
    { auditId: "20261013-inc", mode: "incremental", createdAt: "2026-10-13T09:00:00.000Z", chatCount: 2, messageCount: 6 },
  ];
}

// Open WebUI exports carry an e-mail per user; the fixtures leave it out so
// the privacy scan has nothing to flag.
function exportChats() {
  return [
    {
      id: "chat-1", title: "Planning notes", user_id: "user-1", user_name: "Fixture User", user_role: "user",
      created_at: "2026-10-13T08:00:00.000Z", updated_at: "2026-10-13T08:05:00.000Z",
      messages: [
        { id: "m1", role: "user", timestamp: "2026-10-13T08:00:00.000Z", content: "Hello" },
        { id: "m2", parent_id: "m1", role: "assistant", model: "model-a", timestamp: "2026-10-13T08:00:05.000Z", content: "Hi there" },
      ],
    },
    {
      id: "chat-2", title: "Translation help", user_id: "user-1", user_name: "Fixture User", user_role: "user",
      created_at: "2026-10-13T08:30:00.000Z", updated_at: "2026-10-13T08:40:00.000Z",
      messages: [
        { id: "n1", role: "user", timestamp: "2026-10-13T08:30:00.000Z", content: "Translate this" },
        { id: "n2", parent_id: "n1", role: "assistant", model: "model-b", timestamp: "2026-10-13T08:30:09.000Z", content: "Done" },
      ],
    },
  ];
}

function writeAuditTree(auditRoot) {
  for (const item of sampleHistory()) {
    const dir = path.join(auditRoot, item.auditId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      auditId: item.auditId, mode: item.mode, createdAt: item.createdAt, summary: { chat_count: item.chatCount, message_count: item.messageCount, incremental: item.mode === "incremental" },
    }));
    fs.writeFileSync(path.join(dir, "openwebui-chats-full.md"), `# Export ${item.auditId}\n`);
  }
  fs.writeFileSync(path.join(auditRoot, "20261013-inc", "openwebui-chats-full.json"), JSON.stringify({ exported_at_utc: "2026-10-13T09:00:00.000Z", chats: exportChats() }));
}

function fakeAuth() {
  return {
    principal: () => ({ role: "owner", principal: "owner" }),
    checkWrite: () => ({ ok: true }),
    viewerRegistry: { registerAdminOnly() {} },
  };
}

function fakeRes() {
  return {
    status: 0,
    text: "",
    writeHead(status) {
      this.status = status;
    },
    end(text) {
      this.text = text || "";
    },
    on() {},
  };
}

async function get(handler, target, headers = {}) {
  const res = fakeRes();
  const handled = await handler.handle({ method: "GET", headers, url: target, resume() {} }, res, new URL(target, "http://127.0.0.1"));
  if (!handled || res.status !== 200) throw new Error(`fixture request ${target} answered ${res.status}: ${res.text.slice(0, 200)}`);
  return JSON.parse(res.text);
}

function fakeConfig(name, values) {
  return {
    readSection(section) {
      if (section !== name) throw new Error(`unexpected section ${section}`);
      return { values: JSON.parse(JSON.stringify(values)), etag: "etag-1", errors: [], warnings: [] };
    },
    async writeSection() {
      throw new Error("the fixture builder never writes settings");
    },
  };
}

/**
 * Seeds a store in `dir` and returns { fixtures, close } where fixtures maps
 * each name of FIXTURE_NAMES to the body the route answered.
 */
async function buildFixtures(dir) {
  // The audit schedule's next-run times follow the local clock, so the build
  // runs in UTC whatever the machine's zone is.
  const savedZone = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    return await buildInZone(dir);
  } finally {
    if (savedZone === undefined) delete process.env.TZ;
    else process.env.TZ = savedZone;
  }
}

async function buildInZone(dir) {
  const quiet = { log() {}, warn() {}, error() {} };
  const store = await openTelemetryStore({ file: path.join(dir, "telemetry.sqlite"), inProcess: true, logger: quiet });
  let index = null;
  try {
    const rows = [];
    let n = 0;
    for (let at = FROM + 2 * MINUTE_MS; at < NOW - 60_000; at += 4 * MINUTE_MS) {
      n += 1;
      rows.push(request(n, at));
    }
    // Two more inside the last minute so /live has a rate to show.
    rows.push(request(n + 1, NOW - 50_000), request(n + 2, NOW - 20_000));
    if ((await store.insertRequests(rows)).rejected) throw new Error("fixture requests were rejected");
    const coverage = [];
    for (let bucket = FROM; bucket < NOW; bucket += MINUTE_MS) coverage.push({ bucket, component: "recorder" });
    await store.recordCoverage(coverage);
    const runtime = [];
    const gpu = [];
    let step = 0;
    for (let at = FROM; at < NOW; at += 10_000) {
      step += 1;
      runtime.push(runtimeSample(at, step));
      gpu.push(gpuSample(at));
    }
    await store.insertRuntimeSamples(runtime);
    await store.insertGpuSamples(gpu);
    await store.insertEvents(events());
    await store.runRollups(NOW, { timezoneOffsetMinutes: 0 });
    await store.call("alertSeed", { now: NOW });
    await store.call("alertStateApply", {
      states: [
        { ruleId: "gpu_temp_high", scopeKey: "gpu:0", state: "firing", since: NOW - 10 * MINUTE_MS, lastEvalAt: NOW - 10_000, lastValue: 91, firedAt: NOW - 10 * MINUTE_MS, fireCount: 1 },
        { ruleId: "upstream_errors", scopeKey: "fleet:vllm:primary", state: "ok", since: NOW - 30 * MINUTE_MS, lastEvalAt: NOW - 10_000, lastValue: 0.01, firedAt: NOW - 40 * MINUTE_MS, resolvedAt: NOW - 30 * MINUTE_MS, fireCount: 1 },
      ],
    });

    const config = fakeConfig("telemetry", {
      enabled: true, sampleIntervalMs: 10_000, timezoneOffsetMinutes: 0, keepJsonlAccessLog: true, maxDbMb: 2048, exportMaxRows: 200_000,
      retention: { requestsDays: 30, ipDays: 30, samplesHours: 48, minuteDays: 14, hourDays: 400, eventsDays: 400 },
      energy: { pricePerKwh: null, currency: "CNY", tariffs: [], hostBaselineWatts: 0 },
      alerts: { webhooks: [] },
    });
    const runtimeView = {
      status: () => ({ recorder: { running: true }, collectors: { events: { state: "ok" }, runtime: { state: "ok" } } }),
      collectors: { gpu: { status: () => ({ state: "ok" }) } },
      recorder: { inflight: () => 0 },
    };
    const queries = createQueryRoutes({
      auth: fakeAuth(), getStore: () => store, getRuntime: () => runtimeView, config, aiRoot: dir, env: {}, logger: quiet, now: () => NOW,
    });
    const alertRoutes = createAlertRoutes({
      auth: fakeAuth(),
      getEngine: () => ({
        listAlerts: async (params) => (await store.call("alertList", params)).rows,
        toastChannel: () => "no_subscriber",
      }),
      getRuntime: () => runtimeView,
      logger: quiet,
      now: () => NOW,
    });

    const range = `from=${FROM}&to=${NOW}`;
    const list = await get(queries, `/api/telemetry/requests?facets=1&limit=5&${range}`);
    const okRow = list.rows.find((row) => row.status === 200 && row.sourceProgram === "openwebui") || list.rows[0];
    const fixtures = {
      live: await get(queries, "/api/telemetry/live"),
      summary: await get(queries, `/api/telemetry/summary?compare=previous&${range}`),
      timeseries: await get(queries, `/api/telemetry/timeseries?metrics=req.count,req.error_rate,lat.ttft_p95,tok.output_per_s&annotate=launch&step=600&${range}`),
      breakdown: await get(queries, `/api/telemetry/breakdown?dim=model&${range}`),
      requests: list,
      "request-detail": await get(queries, `/api/telemetry/requests/${okRow.requestId}`),
      alerts: await get(alertRoutes, "/api/telemetry/alerts?state=all"),
    };

    // --- audit: the real HTTP handler over a temp export tree and index ---
    const auditRoot = path.join(dir, "audit");
    writeAuditTree(auditRoot);
    index = openAuditIndex({ file: path.join(dir, "audit-index.sqlite"), inProcess: true, logger: quiet, now: () => NOW });
    const auditDir = path.join(auditRoot, "20261013-inc");
    await index.indexExport(auditDir, JSON.parse(fs.readFileSync(path.join(auditDir, "manifest.json"), "utf8")));
    const auditStore = core.createAuditStore({
      auditRoot,
      auditPasswordFile: path.join(auditRoot, "audit-admin-password.txt"),
      envPassword: "fixture-password",
      openWebuiContainer: "open-webui",
      serviceContainer: "service-entry",
      getContainerStatus: async () => ({ exists: true, running: true }),
      docker: async () => ({ stdout: "", stderr: "" }),
    });
    const auditConfig = fakeConfig("audit", {
      root: "",
      schedule: { enabled: true, incrementalEveryMinutes: 60, fullAtLocal: "04:00" },
      retention: { maxExports: 30, maxAgeDays: 90, rebaselineDays: 7, maxChains: 8 },
      logQueryText: false,
    });
    const now = () => NOW;
    const containerStatus = async () => ({ exists: true, running: true });
    const scheduler = createAuditScheduler({
      auditStore, store, config: () => auditConfig.readSection("audit").values, now, containerStatus, logger: quiet,
    });
    const sessions = createAuditSessions({ now });
    const session = sessions.create();
    const audit = createAuditHttp({
      auth: fakeAuth(), store, auditStore, scheduler, index, config: auditConfig, now, openWebuiContainer: "open-webui", containerStatus, logger: quiet, sessions,
    });
    fixtures["audit-status"] = await get(audit, "/api/audit/status");
    fixtures["audit-chats"] = await get(audit, "/api/audit/chats", { "x-audit-session": session.token });

    return {
      fixtures,
      async close() {
        try { await index.close(); } catch { /* already closed */ }
        try { await store.close({ flushMs: 0 }); } catch { /* already closed */ }
      },
    };
  } catch (error) {
    if (index) { try { await index.close(); } catch { /* ignore */ } }
    try { await store.close({ flushMs: 0 }); } catch { /* ignore */ }
    throw error;
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-fixtures-"));
}

module.exports = { FIXTURE_NAMES, NOW, buildFixtures, tempDir };
