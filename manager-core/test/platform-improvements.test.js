"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = require("..");

function makeJsonResponse() {
  const state = { status: 200, json: null, sent: "", type: "" };
  return {
    state,
    res: {
      headersSent: false,
      writableEnded: false,
      status(code) {
        state.status = code;
        return this;
      },
      json(value) {
        state.json = value;
        this.headersSent = true;
        return value;
      },
      type(value) {
        state.type = value;
        return this;
      },
      send(value) {
        state.sent = value;
        this.headersSent = true;
        return value;
      },
      once() { return this; },
      off() { return this; },
    },
  };
}

test("service policy persists queue controls and requires HTTPS for reverse proxy mode", () => {
  const settings = core.normalizeServiceExposureSettings({
    enabled: true,
    exposureMode: "reverse-proxy",
    publicBaseUrl: "http://llm.example.test",
    maxConcurrentRequests: 4,
    maxQueuedRequests: 64,
    queueTimeoutSeconds: 45,
  });
  assert.equal(settings.maxConcurrentRequests, 4);
  assert.equal(settings.maxQueuedRequests, 64);
  assert.equal(settings.queueTimeoutSeconds, 45);

  const checks = core.buildServiceExposureChecks(settings, {
    docker: { ok: true },
    container: { running: true },
    endpoint: { lanUrl: "http://192.168.1.2:8000", lanHost: "192.168.1.2" },
    clientsLedger: { clients: [] },
  });
  assert.equal(checks.find((item) => item.title === "公网 HTTPS")?.status, "fail");
  assert.match(checks.find((item) => item.title === "网关限流")?.detail || "", /排队 64 个请求、等待 45 秒/);

  const https = core.buildServiceExposureChecks({ ...settings, publicBaseUrl: "https://llm.example.test" }, {
    docker: { ok: true },
    container: { running: true },
    endpoint: { lanUrl: "http://192.168.1.2:8000", lanHost: "192.168.1.2" },
    clientsLedger: { clients: [] },
  });
  assert.equal(https.find((item) => item.title === "公网 HTTPS")?.status, "ok");
});

test("access log search spans rotated files and exports filtered CSV and JSONL", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manager-access-search-"));
  const file = path.join(dir, "access.jsonl");
  await fs.writeFile(`${file}.1`, `${JSON.stringify({
    at: "2026-07-15T10:00:00.000Z",
    remoteAddress: "192.168.1.9",
    status: 200,
    kind: "openai",
    path: "/serve/v1/chat/completions",
    model: "model-old",
    userAgent: "OpenWebUI/1.0",
  })}\n`, "utf8");
  await fs.writeFile(file, `${JSON.stringify({
    at: "2026-07-16T10:00:00.000Z",
    remoteAddress: "192.168.1.10",
    status: 503,
    kind: "openai",
    path: "/serve/v1/chat/completions",
    model: "model-new",
    queuedMs: 321,
    error: "=HYPERLINK(\"bad\") boom",
  })}\n`, "utf8");

  const store = core.createServiceGatewayAccessLogStore({
    file,
    maxFiles: 2,
    exportPrefix: "test-manager",
    getLanAddress: () => "192.168.1.2",
  });
  const all = await store.readServiceGatewayAccessEvents(100);
  assert.equal(all.length, 2);

  const result = await store.searchServiceGatewayAccessLogs({ keyword: "boom", status: "5xx", limit: 20 });
  assert.equal(result.total, 1);
  assert.equal(result.events[0].model, "model-new");
  assert.equal(result.events[0].queuedMs, 321);

  const csv = await store.exportServiceGatewayAccessLogs({ keyword: "boom", format: "csv" });
  assert.equal(csv.count, 1);
  assert.match(csv.filename, /^test-manager-access-.*\.csv$/);
  assert.match(csv.text, /'\=HYPERLINK/);

  const jsonl = await store.exportServiceGatewayAccessLogs({ source: "OpenWebUI", format: "jsonl" });
  assert.equal(jsonl.count, 1);
  assert.match(jsonl.text, /model-old/);
});

test("metrics history preserves missing telemetry and coalesces samples inside the interval", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manager-metrics-history-"));
  const file = path.join(dir, "history.json");
  const store = core.createMetricsHistoryStore({
    file,
    engine: "vllm",
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
    minIntervalMs: 60_000,
  });
  const firstAt = Date.now() - 120_000;
  const summary = {
    container: { name: "vllm-local", running: true },
    models: [{
      name: "model-a",
      latency: { avgQueueSeconds: 0.25 },
      requests: { running: 1, waiting: 2 },
      speculative: { enabled: true, draftTokens: 2, acceptanceRate: 0.75 },
    }],
    totals: {
      latency: { avgE2eSeconds: 1.5, avgTtftSeconds: 0.2, avgTimePerOutputTokenSeconds: 0.03 },
      speed: { recentOutputTokensPerSecond: 42, recentRequestsPerMinute: 3 },
      requests: { total: 10 },
    },
    gpu: { usedMb: 1000, totalMb: 2000, temp: null, powerWatts: null, fanPercent: "" },
  };
  await store.recordMetricsHistory(summary, { at: new Date(firstAt).toISOString() });
  await store.recordMetricsHistory({ ...summary, totals: { ...summary.totals, requests: { total: 11 } } }, {
    at: new Date(firstAt + 30_000).toISOString(),
  });
  await store.recordMetricsHistory(summary, { at: new Date(firstAt + 90_000).toISOString() });

  const history = await store.getMetricsHistory({ hours: 1 });
  assert.equal(history.samples.length, 2);
  assert.equal(history.samples[0].requests.total, 11);
  assert.equal(history.samples[0].latency.queueMs, 250);
  assert.equal(history.samples[0].gpu.temperatureC, null);
  assert.equal(history.samples[0].gpu.powerWatts, null);
  assert.equal(history.samples[0].gpu.fanPercent, null);
});

test("manager backups verify checksum and restore only configured manager files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manager-backup-"));
  const backupDir = path.join(dir, "backups");
  const settingsFile = path.join(dir, "settings.json");
  const profilesFile = path.join(dir, "profiles.json");
  await core.writeJsonFile(settingsFile, { theme: "dark", queue: 64 });
  await core.writeJsonFile(profilesFile, { profiles: [{ id: "p1" }] });
  const store = core.createManagerBackupStore({
    managerId: "test-manager",
    backupDir,
    files: { settings: settingsFile, profiles: profilesFile },
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
  });

  const created = await store.createManagerBackup();
  assert.equal(created.valid, true);
  assert.equal(created.entryCount, 2);
  await core.writeJsonFile(settingsFile, { theme: "light" });
  const restored = await store.restoreManagerBackup(created.id);
  assert.deepEqual(restored.restored.sort(), ["profiles", "settings"]);
  assert.equal((await core.readJsonFile(settingsFile, {})).queue, 64);

  const backupPath = path.join(backupDir, created.id);
  const tampered = await core.readJsonFile(backupPath, {});
  tampered.entries[0].data = { changed: true };
  await core.writeJsonFile(backupPath, tampered);
  await assert.rejects(() => store.getManagerBackup(created.id), /checksum verification failed/i);
  await assert.rejects(() => store.getManagerBackup("../settings.json"), /Invalid backup id/);
});

test("GPU telemetry parser handles power, limit, fan, and unsupported fields", () => {
  const telemetry = core.parseNvidiaSmiGpuCsv([
    "0, GPU A, 12.0, 100, 10, 50, 65, 400.5, 600, 30",
    "1, GPU B, 12.0, 100, 5, 0, 40, N/A, N/A, N/A",
  ].join("\n"));
  assert.equal(telemetry.ok, true);
  assert.equal(telemetry.powerWatts, 400.5);
  assert.equal(telemetry.powerLimitWatts, 600);
  assert.equal(telemetry.fanPercent, 30);
  assert.equal(telemetry.gpus[1].powerWatts, null);
  assert.equal(telemetry.gpus[1].fanPercent, null);

  const blank = core.parseNvidiaSmiGpuCsv("0, GPU C, 12.0, 100, 5, 0, 40, , , ");
  assert.equal(blank.gpus[0].powerWatts, null);
  assert.equal(blank.gpus[0].fanPercent, null);
});

test("runtime instance ids are stable and parallel names never alter the primary name", () => {
  assert.equal(core.normalizeRuntimeInstanceMode("PARALLEL"), "parallel");
  assert.equal(core.normalizeRuntimeInstanceMode("anything"), "replace");
  assert.equal(core.normalizeRuntimeInstanceId(" Qwen 3.6 / Code "), "qwen-3-6-code");
  assert.equal(core.buildRuntimeContainerName("vllm-local", "replace", "code"), "vllm-local");
  assert.equal(core.buildRuntimeContainerName("vllm-local", "parallel", "Code Model"), "vllm-local-code-model");
});

test("OpenAI gateway lists all reachable models, routes by model, and reports discovery failure", async () => {
  const runtimes = [
    { container: { running: true, name: "runtime-a" }, endpoint: { port: 8000 }, servedModels: [{ id: "model-a" }] },
    { container: { running: true, name: "runtime-b" }, endpoint: { port: 8001 }, servedModels: [{ id: "model-b" }] },
  ];
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, options });
    const isModels = url.endsWith("/v1/models");
    const model = url.includes(":8001/") ? "model-b" : "model-a";
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(isModels ? { data: [{ id: model }] } : { usage: { prompt_tokens: 2, completion_tokens: 3 } }),
    };
  };
  const handlers = core.createOpenAiGatewayHandlers({
    aliases: ["local-current"],
    getRunningModelSummary: async () => runtimes[0],
    listRunningModelSummaries: async () => runtimes,
    fetchFn,
  });

  let response = makeJsonResponse();
  await handlers.handleModels({}, response.res);
  assert.equal(response.state.status, 200);
  assert.ok(response.state.json.data.some((model) => model.id === "model-a"));
  assert.ok(response.state.json.data.some((model) => model.id === "model-b"));

  response = makeJsonResponse();
  await handlers.handleChatCompletions({ body: { model: "model-b" }, serviceGateway: {} }, response.res);
  assert.equal(response.state.status, 200);
  assert.ok(calls.some((call) => call.url === "http://127.0.0.1:8001/v1/chat/completions"));

  const unavailable = core.createOpenAiGatewayHandlers({
    getRunningModelSummary: async () => runtimes[0],
    listRunningModelSummaries: async () => runtimes,
    fetchFn: async () => { throw new Error("connection refused"); },
  });
  response = makeJsonResponse();
  await unavailable.handleModels({}, response.res);
  assert.equal(response.state.status, 503);
  assert.equal(response.state.json.error.code, "service_unavailable");
  assert.match(response.state.json.error.message, /connection refused/);
});

test("download queue honors priority and retries failed jobs without deleting partial files", () => {
  const jobs = new Map();
  const specs = new Map();
  const spawned = [];
  const removed = [];
  const retryCallbacks = [];
  let queueMode = true;
  const createJob = (type, title, meta = {}) => {
    const job = core.createJobRecord(type, title, meta, { id: `job-${jobs.size + 1}` });
    jobs.set(job.id, job);
    return job;
  };
  const controller = core.createDownloadJobController({
    jobs,
    downloadSpecs: specs,
    createJob,
    spawnJobProcess: (job) => {
      job.status = "running";
      spawned.push(job.id);
    },
    buildDownloadSpecFromJob: (job) => ({
      command: "hf",
      args: ["download", job.meta.model],
      options: { title: job.title, meta: { ...job.meta } },
    }),
    appendLog: () => {},
    stopProgressTracker: () => {},
    scheduleSave: () => {},
    getQueueMode: () => queueMode,
    setQueueMode: (value) => { queueMode = Boolean(value); },
    saveQueueMode: async () => {},
    resolvePartialPath: (value) => value,
    removePartialPath: async (value) => removed.push(value),
    autoRetryCount: 2,
    autoRetryDelaySeconds: 1,
    setRetryTimeout: (callback) => {
      retryCallbacks.push(callback);
      return { unref() {} };
    },
    clearRetryTimeout: () => {},
  });

  const first = controller.enqueueOrStartDownload("hf", ["download", "first"], { meta: { model: "first" } });
  const low = controller.enqueueOrStartDownload("hf", ["download", "low"], { meta: { model: "low", priority: "low" } });
  const high = controller.enqueueOrStartDownload("hf", ["download", "high"], { meta: { model: "high", priority: "high", localDir: "partial-high" } });
  assert.deepEqual(spawned, [first.id]);
  assert.equal(low.status, "queued");
  assert.equal(high.status, "queued");

  first.status = "success";
  controller.drainDownloadQueue();
  assert.deepEqual(spawned, [first.id, high.id]);

  high.status = "failed";
  controller.drainDownloadQueue();
  assert.equal(retryCallbacks.length, 1);
  assert.ok(high.meta.retryScheduledAt);
  assert.deepEqual(spawned, [first.id, high.id, low.id]);

  retryCallbacks[0]();
  assert.equal(high.meta.retryCount, 1);
  assert.equal(high.status, "queued");
  low.status = "success";
  controller.drainDownloadQueue();
  assert.deepEqual(spawned, [first.id, high.id, low.id, high.id]);
  assert.deepEqual(removed, []);
});
