"use strict";

// Telemetry import routes (docs/overhaul/04-telemetry.md §11.7, §11.8, §18,
// TEL-18) through the real entry: the 05 guard, the viewer registry and the
// event bus. The AI root and the telemetry store live in a temp folder, so
// nothing of the running platform is read.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openTelemetryStore } = require("../../manager-core/telemetry/store");
const importers = require("../../manager-core/telemetry/importers");
const telemetryRoutes = require("../lib/telemetry-routes");
const harness = require("./helpers/entry-harness");
const { loadEntry, ownerSession, quietLogger, serveEntry } = harness;

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "manager-core", "test", "fixtures", "telemetry", "importers", "import-sources.json"), "utf8"));
const LAN = "192.168.1.50";

// Loopback without a session is only a viewer since PUB-5, so a request acts as
// the paired owner of its entry unless it names a peer or an owner itself.
const owners = new Map();
function request(port, pathname, options = {}) {
  const owner = options.owner || (options.peer ? undefined : owners.get(port));
  return harness.request(port, pathname, { ...options, owner });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

async function startTelemetry(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-routes-"));
  const root = path.join(base, "ai-root");
  writeJson(path.join(root, "vllm-manager", "logs", "stats-ledger.json"), FIXTURE.statsLedger.vllm);
  writeJson(path.join(root, "llama-manager", "logs", "stats-ledger.json"), FIXTURE.statsLedger.llama);
  writeJson(path.join(root, "vllm-manager", "logs", "benchmark-history.json"), FIXTURE.benchmarks.vllm);
  const dbFile = path.join(base, "db", "telemetry.sqlite");
  const store = await openTelemetryStore({ file: dbFile, inProcess: true, logger: null });
  t.after(async () => {
    await store.close({ flushMs: 0 });
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { base, root, store, dbFile };
}

async function mountEntry(t, { root, store }, overrides = {}) {
  const { entry } = await loadEntry();
  const { telemetry, ...rest } = overrides;
  const logger = quietLogger();
  const ctx = entry.createRouteContext({
    logger,
    aiRoot: root,
    rootDir: path.join(root, "service-entry"),
    managers: [{ id: "vllm", port: 1 }, { id: "llama", port: 2 }],
    telemetry: { store, ...telemetry },
    ...rest,
  });
  const notifications = [];
  ctx.bus.subscribe((envelope) => notifications.push(envelope), { types: ["notification"] });
  const routes = await entry.mountRouteModules({ ctx });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  owners.set(port, await ownerSession(entry, port));
  return { entry, ctx, port, notifications, logger };
}

async function finished(port, runId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(port, `/api/telemetry/import/${runId}`);
    assert.equal(response.status, 200);
    if (response.json.state !== "running") return response.json;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the import did not finish");
}

function rowCount(dbFile, table) {
  const sqlite = require("node:sqlite");
  const db = new sqlite.DatabaseSync(dbFile);
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } finally {
    db.close();
  }
}

// --- through the entry -----------------------------------------------------------

test("the first run is a dry run: it reports, writes nothing and publishes one notification", async (t) => {
  const telemetry = await startTelemetry(t);
  const { port, notifications } = await mountEntry(t, telemetry);

  const started = await request(port, "/api/telemetry/import", { method: "POST", body: { sources: ["stats-ledger", "benchmarks"] } });
  assert.equal(started.status, 200);
  assert.equal(started.json.ok, true);
  assert.match(started.json.runId, /^run_[0-9a-f]{16}$/);

  const run = await finished(port, started.json.runId);
  assert.equal(run.state, "done");
  assert.equal(run.dryRun, true, "dryRun defaults to true");
  assert.deepEqual(run.sources, ["stats-ledger", "benchmarks"]);
  assert.equal(run.report.ok, true);
  assert.equal(run.report.dryRun, true);
  assert.deepEqual(run.report.reports.map((report) => [report.source, report.rowsIn, report.rowsWritten]), [["stats-ledger", 3, 2], ["benchmarks", 2, 2]]);
  assert.equal(run.report.reports[0].rowsSkipped.empty_counters, 1, "the report lists skipped reasons");
  assert.equal(run.progress, null);
  assert.ok(run.startedAt && run.finishedAt);
  assert.equal(JSON.stringify(run).includes(telemetry.root), false, "no host path in the report");

  assert.equal(rowCount(telemetry.dbFile, "lifetime_baseline"), 0);
  assert.equal(rowCount(telemetry.dbFile, "events"), 0);
  assert.equal(rowCount(telemetry.dbFile, "import_runs"), 0);

  assert.equal(notifications.length, 1, "completion publishes exactly one notification");
  const envelope = notifications[0];
  assert.equal(envelope.type, "notification");
  assert.equal(envelope.data.kind, "telemetry.import");
  assert.equal(envelope.data.severity, "success");
  assert.deepEqual(envelope.data.title, { zh: "导入完成", en: "Import finished" });
  assert.match(envelope.data.body.en, /^Dry run, nothing was written\. Read 5 rows, would write 4, skipped 1\.$/);
  assert.deepEqual(envelope.data.action.apiCall, { method: "GET", path: `/api/telemetry/import/${started.json.runId}` });
});

test("a real run writes, the next run writes 0 rows, and each completion publishes one notification", async (t) => {
  const telemetry = await startTelemetry(t);
  const { port, notifications } = await mountEntry(t, telemetry);

  const first = await request(port, "/api/telemetry/import", { method: "POST", body: { sources: ["stats-ledger", "benchmarks"], dryRun: false } });
  const firstRun = await finished(port, first.json.runId);
  assert.equal(firstRun.dryRun, false);
  assert.equal(firstRun.report.rowsWritten, 4);
  assert.equal(rowCount(telemetry.dbFile, "lifetime_baseline"), 2);
  assert.equal(rowCount(telemetry.dbFile, "events"), 2);

  const second = await request(port, "/api/telemetry/import", { method: "POST", body: { dryRun: false } });
  const secondRun = await finished(port, second.json.runId);
  assert.equal(secondRun.report.sources.length, importers.IMPORT_SOURCES.length, "no sources means all of them");
  assert.equal(secondRun.report.rowsWritten, 0);
  assert.equal(rowCount(telemetry.dbFile, "events"), 2);

  assert.equal(notifications.length, 2);
  assert.match(notifications[0].data.body.en, /^Read 5 rows, wrote 4, skipped 1\.$/);
  assert.equal(notifications[0].data.severity, "success");
});

test("invalid requests are refused with 400 and start nothing", async (t) => {
  const telemetry = await startTelemetry(t);
  const { port, notifications } = await mountEntry(t, telemetry);
  const cases = [
    [{ sources: [] }, "invalid_import_sources"],
    [{ sources: "stats-ledger" }, "invalid_import_sources"],
    [{ sources: ["nope"] }, "unknown_import_source"],
    [{ dryRun: "yes" }, "invalid_value"],
  ];
  for (const [body, code] of cases) {
    const response = await request(port, "/api/telemetry/import", { method: "POST", body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.json.error.code, "invalid_request");
    assert.equal(response.json.errors[0].code, code);
  }
  const torn = await request(port, "/api/telemetry/import", { method: "POST", body: "{ nope" });
  assert.equal(torn.status, 400);
  assert.equal(torn.json.error.code, "invalid_json");
  assert.equal((await request(port, "/api/telemetry/import/run_missing")).status, 404);
  assert.equal((await request(port, "/api/telemetry/import/run_missing")).json.error.code, "import_run_not_found");
  assert.equal((await request(port, "/api/telemetry/import")).status, 405);
  assert.equal((await request(port, "/api/telemetry/import/run_x", { method: "POST", body: {} })).status, 405);
  assert.equal(notifications.length, 0);
});

test("a viewer on the LAN cannot start or read an import; the routes are declared admin-only", async (t) => {
  const telemetry = await startTelemetry(t);
  const { port, ctx, notifications } = await mountEntry(t, telemetry);
  const started = await request(port, "/api/telemetry/import", { method: "POST", body: { sources: ["benchmarks"] } });
  const run = await finished(port, started.json.runId);
  assert.equal(run.state, "done");

  for (const [method, target, body] of [
    ["POST", "/api/telemetry/import", { sources: ["benchmarks"], dryRun: false }],
    ["GET", `/api/telemetry/import/${started.json.runId}`, undefined],
  ]) {
    const response = await request(port, target, { method, peer: LAN, ...(body ? { body } : {}) });
    assert.ok([401, 403, 404].includes(response.status), `${method} ${target} answered ${response.status}`);
    assert.equal(response.text.includes("rowsIn"), false);
  }
  assert.equal(rowCount(telemetry.dbFile, "events"), 0);
  assert.equal(notifications.length, 1, "only the owner's run notified");

  const registry = ctx.auth.viewerRegistry;
  assert.equal(registry.match("POST", "/api/telemetry/import").access, "admin");
  const read = registry.match("GET", `/api/telemetry/import/${started.json.runId}`);
  assert.equal(read.access, "admin");
  assert.equal(read.params.runId, started.json.runId);
});

test("without a telemetry store the import answers 503", async (t) => {
  const telemetry = await startTelemetry(t);
  const { port, ctx } = await mountEntry(t, telemetry);
  ctx.telemetry = null;
  const response = await request(port, "/api/telemetry/import", { method: "POST", body: {} });
  assert.equal(response.status, 503);
  assert.equal(response.json.error.code, "telemetry_unavailable");
});

// --- the routes with a controllable run ------------------------------------------

function fakeAuth({ role = "owner", principal = "owner", writeOk = true } = {}) {
  return {
    principal: () => ({ role, principal }),
    checkWrite: () => (writeOk ? { ok: true } : { ok: false, status: 403, code: "management_local_only" }),
    viewerRegistry: { registerAdminOnly() {} },
  };
}

function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    text: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(text) {
      this.text = text || "";
    },
  };
  Object.defineProperty(res, "json", { get() { return JSON.parse(this.text); } });
  return res;
}

function fakeReq(method, body) {
  return { method, body, resume() {} };
}

function routesWith(extra = {}) {
  const published = [];
  const routes = telemetryRoutes.createImportRoutes({
    auth: fakeAuth(),
    readJsonObjectBody: async (req) => req.body || {},
    getStore: () => ({ state: "ready" }),
    getBus: () => ({ publish: (type, data) => { published.push({ type, data }); return { type }; } }),
    aiRoot: os.tmpdir(),
    readSettings: () => ({}),
    logger: { warn() {} },
    ...extra,
  });
  return { routes, published };
}

test("only one import runs at a time: a second start answers 409 with the active run id", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { routes, published } = routesWith({
    runImport: async (options) => {
      options.onProgress({ source: "stats-ledger", rowsIn: 1 });
      await gate;
      return { ok: true, dryRun: options.dryRun, sources: options.sources, reports: [], rowsIn: 3, rowsWritten: 2, rowsSkipped: { x: 1 }, warnings: [], errors: [] };
    },
  });
  const start = async (body) => {
    const res = fakeRes();
    await routes.handle(fakeReq("POST", body), res, new URL("http://x/api/telemetry/import"));
    return res;
  };
  const first = await start({ sources: ["stats-ledger"], dryRun: false });
  assert.equal(first.status, 200);
  const runId = first.json.runId;

  const second = await start({});
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, "import_in_progress");
  assert.equal(second.json.error.details.runId, runId);

  const polling = fakeRes();
  await routes.handle(fakeReq("GET"), polling, new URL(`http://x/api/telemetry/import/${runId}`));
  assert.equal(polling.json.state, "running");
  assert.deepEqual(polling.json.progress, { source: "stats-ledger", rowsIn: 1 });
  assert.equal(published.length, 0, "nothing is published while the run is active");

  release();
  await routes.idle();
  const done = fakeRes();
  await routes.handle(fakeReq("GET"), done, new URL(`http://x/api/telemetry/import/${runId}`));
  assert.equal(done.json.state, "done");
  assert.equal(done.json.dryRun, false);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, "notification");
  assert.match(published[0].data.body.zh, /读取 3 行，写入 2 行，跳过 1 行/);

  const third = await start({});
  assert.equal(third.status, 200, "a new run may start once the last one is done");
  await routes.idle();
});

test("a run that throws is reported as failed with a code and still notifies once", async () => {
  const { routes, published } = routesWith({
    runImport: async () => {
      throw Object.assign(new Error("failed at /some/private/path"), { code: "telemetry_store_unavailable" });
    },
  });
  const res = fakeRes();
  await routes.handle(fakeReq("POST", { sources: ["benchmarks"] }), res, new URL("http://x/api/telemetry/import"));
  await routes.idle();
  const read = fakeRes();
  await routes.handle(fakeReq("GET"), read, new URL(`http://x/api/telemetry/import/${res.json.runId}`));
  assert.equal(read.json.state, "failed");
  assert.deepEqual(read.json.error, { code: "telemetry_store_unavailable" });
  assert.equal(read.text.includes("/some/private/path"), false);
  assert.equal(published.length, 1);
  assert.equal(published[0].data.severity, "error");
  assert.deepEqual(published[0].data.title, { zh: "导入失败", en: "Import failed" });
});

test("callers other than the owner are refused before anything is read", async () => {
  for (const [role, principal, status, code] of [
    ["viewer", "viewer", 403, "owner_required"],
    ["system", "system:mcp", 403, "owner_required"],
    ["none", "", 401, "admin_session_required"],
  ]) {
    const { routes } = routesWith({ auth: fakeAuth({ role, principal }), readJsonObjectBody: async () => { throw new Error("body was read"); } });
    const res = fakeRes();
    await routes.handle(fakeReq("POST", {}), res, new URL("http://x/api/telemetry/import"));
    assert.equal(res.status, status, role);
    assert.equal(res.json.error.code, code);
  }
  const { routes } = routesWith({ auth: fakeAuth({ role: "system", principal: "system:cli" }) });
  const res = fakeRes();
  await routes.handle(fakeReq("POST", { sources: ["benchmarks"] }), res, new URL("http://x/api/telemetry/import"));
  assert.equal(res.status, 200, "system:cli is owner-equivalent (05)");
  await routes.idle();

  const blocked = routesWith({ auth: fakeAuth({ writeOk: false }) });
  const refused = fakeRes();
  await blocked.routes.handle(fakeReq("POST", {}), refused, new URL("http://x/api/telemetry/import"));
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, "management_local_only");
});

test("paths of other telemetry packages fall through", async () => {
  const { routes } = routesWith();
  for (const target of ["/api/telemetry/summary", "/api/telemetry/imports", "/api/telemetry/import/a/b", "/api/other"]) {
    assert.equal(await routes.handle(fakeReq("GET"), fakeRes(), new URL(`http://x${target}`)), false, target);
  }
});

// --- the query endpoints (TEL-11, §11.1-11.7) ------------------------------------
//
// A seeded store behind the real entry: the 05 guard decides who may ask, the
// worker-side query module answers, and every body is checked against
// schemas.js. Time is fixed, so the default windows are reproducible.

const { assertValid, validate } = require("../../manager-core/telemetry/schemas");
const viewerRedaction = require("../lib/telemetry-viewer");

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DAY0 = Date.UTC(2026, 9, 14);
const NOW = DAY0 + 2 * DAY_MS;
const START = DAY0 + 2 * HOUR_MS;
const SPAN = `from=${START}&to=${START + HOUR_MS}`;
const ROW_COUNT = 90;
const SECRET_KEY = "k_viewer_must_not_see_1";
const SECRET_CUSTOMER = "cust_viewer_must_not_see";
const SECRET_IP = "192.0.2.77";
const WEBHOOK_SECRET = "fake-webhook-signing-secret-0001";

function rid(index, prefix = "req_") {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let value = index;
  let text = "";
  for (let position = 0; position < 20; position += 1) {
    text = alphabet[value % 32] + text;
    value = Math.floor(value / 32);
  }
  return `${prefix}${text}`;
}

function requestRow(index, receivedAt, extra = {}) {
  const failed = index % 10 === 9;
  return {
    requestId: rid(index),
    managerRequestId: rid(index, "mgr_"),
    ingress: "entry",
    receivedAt,
    endedAt: receivedAt + 800,
    managerId: "vllm",
    fleetId: "vllm:primary",
    engineId: "sglang",
    runtimeId: "sglang@0.5.17",
    launchId: "lch_aaaaaaaaaaaaaaaaaaaa",
    protocol: "openai",
    op: "chat",
    method: "POST",
    path: "/gateway/auto/openai/v1/chat/completions",
    modelRequested: "auto",
    modelResolved: index % 2 ? "model-a" : "model-b",
    stream: true,
    keyId: SECRET_KEY,
    customerId: SECRET_CUSTOMER,
    sourceProgram: index % 3 ? "openwebui" : "curl",
    clientIp: SECRET_IP,
    userAgent: "test-agent",
    status: failed ? 500 : 200,
    terminalState: failed ? "failed" : "completed",
    errorClass: failed ? "upstream_5xx" : "none",
    queueMs: 3,
    upstreamHeadersMs: 140,
    ttftMs: failed ? null : 200 + (index % 20) * 10,
    durationMs: 800,
    decodeTps: failed ? null : 30 + (index % 10),
    promptTokens: 100,
    cachedTokens: 20,
    outputTokens: failed ? 0 : 60,
    usageSource: "reported",
    finishReason: "stop",
    ...extra,
  };
}

async function seedQueryData(store) {
  const rows = [];
  for (let index = 1; index <= ROW_COUNT; index += 1) {
    // Equal timestamps in pairs, so a keyset cursor has to break ties.
    rows.push(requestRow(index, START + Math.floor((index - 1) / 2) * 20_000));
  }
  rows.push(requestRow(500, START + 5 * MINUTE_MS, {
    sourceProgram: "openwebui",
    userAgent: "=cmd|' /C calc'!A0",
  }));
  assert.equal((await store.insertRequests(rows)).rejected, 0);
  const coverage = [];
  for (let bucket = START; bucket < START + 2 * HOUR_MS; bucket += MINUTE_MS) coverage.push({ bucket, component: "recorder" });
  await store.recordCoverage(coverage);
  const runtime = [];
  const gpu = [];
  for (let step = 0; step < 30; step += 1) {
    const at = START + step * 10_000;
    runtime.push({
      at, fleetId: "vllm:primary", model: "model-a", managerId: "vllm", engineId: "sglang", runtimeKey: "k1", intervalMs: 10_000, scrapeOk: 1,
      idle: 0, latencySource: "engine_histogram", running: 1, waiting: 0, kvUsage: 0.3, dPromptTokens: 500, dCachedTokens: 100, dOutputTokens: 100, dRequests: 1,
      outputTps: 10, energyWh: 0.5,
    });
    gpu.push({ at, gpuIndex: 0, gpuUuid: "GPU-00000000", name: "Test GPU", utilPct: 50, memUsedMb: 40_000, memTotalMb: 80_000, tempC: 60, powerW: 300, powerLimitW: 600, smClockMhz: 1800, energyWh: 0.8, throttle: "" });
  }
  await store.insertRuntimeSamples(runtime);
  await store.insertGpuSamples(gpu);
  await store.insertEvents([
    { at: START + 1000, type: "launch.ready", severity: "info", source: "vllm", managerId: "vllm", fleetId: "vllm:primary", launchId: "lch_aaaaaaaaaaaaaaaaaaaa", title: "Launch ready: model-a", data: { model: "model-a", engineId: "sglang", durationMs: 60_000, summary: { contextLength: 262144, argv: ["--do-not-show"] } }, dedupeKey: "t1" },
    { at: START + 2000, type: "security.ban", severity: "warning", source: "entry", title: "Client address banned", data: { ip: "203.0.113.9", ipMasked: "203.0.113.x" }, dedupeKey: "t2" },
    { at: START + 3000, type: "alert.firing", severity: "critical", source: "telemetry", requestId: rid(5), title: "GPU hot", data: { ruleId: "gpu_temp_high" }, dedupeKey: "t3" },
  ]);
  await store.runRollups(NOW, { timezoneOffsetMinutes: 480 });
}

function fakeBilling(calls = []) {
  return {
    calls,
    getUsageByExternalRequestId(ids) {
      calls.push(["usage", ids]);
      if (!ids.includes(rid(3))) return null;
      return {
        usage: { usageId: "use_1", chargedMicrocredits: "0", projectedMicrocredits: "1834", usageSource: "reported", terminalState: "completed", decisionCode: "billing_shadow_allowed" },
        reservation: { enforcementMode: "shadow", decisionCode: "billing_shadow_allowed", reservationMicrocredits: "4096" },
      };
    },
    summarizeUsage(options) {
      calls.push(["summary", options]);
      return { totals: { chargedMicrocredits: "1234000" } };
    },
  };
}

const SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,
  sampleIntervalMs: 10_000,
  timezoneOffsetMinutes: 480,
  keepJsonlAccessLog: true,
  maxDbMb: 2048,
  exportMaxRows: 200_000,
  retention: { requestsDays: 30, ipDays: 30, samplesHours: 48, minuteDays: 14, hourDays: 400, eventsDays: 400 },
  energy: { pricePerKwh: null, currency: "CNY", tariffs: [], hostBaselineWatts: 0 },
  alerts: { webhooks: [] },
});

// 06's readSection/writeSection, in memory: the etag changes on every write
// and a stale etag is refused the way the real writer refuses it.
function fakeConfig(initial = {}) {
  let values = JSON.parse(JSON.stringify({ ...SETTINGS_DEFAULTS, ...initial }));
  let version = 1;
  const writes = [];
  return {
    writes,
    readSection(name) {
      assert.equal(name, "telemetry");
      return { values: JSON.parse(JSON.stringify(values)), etag: `etag-${version}`, errors: [], warnings: [] };
    },
    async writeSection(name, patch, options = {}) {
      assert.equal(name, "telemetry");
      writes.push({ patch: JSON.parse(JSON.stringify(patch)), options: { ...options } });
      if (options.etag !== `etag-${version}`) {
        return { ok: false, status: 409, code: "config_conflict", error: { code: "config_conflict", message: "The settings changed since you loaded them." }, etag: `etag-${version}`, changed: [], restartRequired: [], errors: [] };
      }
      const changed = [];
      for (const [key, value] of Object.entries(patch)) {
        if (JSON.stringify(values[key]) !== JSON.stringify(value)) changed.push(`telemetry.${key}`);
        values = { ...values, [key]: JSON.parse(JSON.stringify(value)) };
      }
      if (changed.length) version += 1;
      return { ok: true, etag: `etag-${version}`, changed, restartRequired: [], errors: [] };
    },
  };
}

function fakeSecrets({ failSet = false } = {}) {
  const map = new Map();
  return {
    map,
    async has(ns, key) { return map.has(`${ns}/${key}`); },
    async set(ns, key, value) {
      if (failSet) throw Object.assign(new Error("dpapi child failed"), { code: "secret_store_unavailable" });
      map.set(`${ns}/${key}`, value);
    },
    async clear(ns, key) { map.delete(`${ns}/${key}`); },
  };
}

async function queryEntry(t, overrides = {}) {
  const telemetry = await startTelemetry(t);
  await seedQueryData(telemetry.store);
  const mounted = await mountEntry(t, telemetry, { now: () => NOW, ...overrides });
  return { ...telemetry, ...mounted };
}

// A loopback caller without a session is a viewer since PUB-5.
function asViewer(port, pathname, options = {}) {
  return harness.request(port, pathname, { ...options });
}

test("every owner endpoint answers its documented shape, validated by schemas.js", async (t) => {
  const billing = fakeBilling();
  const { port } = await queryEntry(t, { getBillingStore: () => billing, telemetryConfig: fakeConfig() });
  const targets = [
    ["live", "/api/telemetry/live"],
    ["summary", `/api/telemetry/summary?${SPAN}&compare=previous`],
    ["timeseries", `/api/telemetry/timeseries?metrics=req.count,lat.ttft_p95,tok.output_per_s&${SPAN}&groupBy=model&annotate=launch,alert`],
    ["timeseries", `/api/telemetry/timeseries?metrics=rt.output_tps,rt.kv_usage,gpu.util,gpu.power_w&${SPAN}`],
    ["timeseries", `/api/telemetry/timeseries?metrics=lat.ttft_hist&${SPAN}`],
    ["breakdown", `/api/telemetry/breakdown?dim=error_class&${SPAN}&spark=1`],
    ["breakdown", `/api/telemetry/breakdown?dim=client_ip&${SPAN}`],
    ["requests", `/api/telemetry/requests?${SPAN}&limit=5&facets=1`],
    ["events", `/api/telemetry/events?${SPAN}&type=launch.,alert.`],
    ["energy", `/api/telemetry/energy?${SPAN}&groupBy=model`],
    ["lifecycle", `/api/telemetry/lifecycle?${SPAN}`],
    ["launches", `/api/telemetry/launches?${SPAN}&groupBy=model`],
    ["baseline", "/api/telemetry/baseline"],
    ["status", "/api/telemetry/status"],
  ];
  for (const [schema, target] of targets) {
    const response = await request(port, target);
    assert.equal(response.status, 200, `${target}: ${response.text.slice(0, 200)}`);
    const result = validate(schema, response.json);
    assert.deepEqual(result.errors, [], target);
  }
  const summary = (await request(port, `/api/telemetry/summary?${SPAN}`)).json;
  assert.equal(summary.current.requests, ROW_COUNT + 1);
  assert.equal(summary.current.billedMicrocredits, "1234000", "the owner gets the billing total");
  assert.equal(summary.previous.requests, 0);
  const live = (await request(port, "/api/telemetry/live")).json;
  assert.equal(live.windowSeconds, 60);
  assert.deepEqual(Object.keys(live.collectors).sort(), ["events", "gpu", "recorder", "runtime", "store"]);
  const series = (await request(port, `/api/telemetry/timeseries?metrics=req.count&${SPAN}&step=60`)).json;
  assert.equal(series.series[0].points.length, 60);
  assert.ok(series.series[0].points.every(([, value]) => value === null || Number.isFinite(value)));
});

test("a long range answers at most 600 points per series on every family", async (t) => {
  const { port } = await queryEntry(t);
  for (const [metrics, range] of [
    ["req.count,lat.ttft_p95", `from=${NOW - 30 * DAY_MS}&to=${NOW}`],
    ["req.count", `from=${NOW - 399 * DAY_MS}&to=${NOW}`],
    ["rt.output_tps,gpu.util", `from=${NOW - 7 * DAY_MS}&to=${NOW}`],
    ["req.count", `from=${START}&to=${START + 2 * HOUR_MS}&step=10`],
  ]) {
    const response = await request(port, `/api/telemetry/timeseries?metrics=${metrics}&${range}`);
    assert.equal(response.status, 200, response.text.slice(0, 200));
    assert.deepEqual(validate("timeseries", response.json).errors, []);
    for (const series of response.json.series) assert.ok(series.points.length <= 600, `${metrics}: ${series.points.length} points`);
  }
});

test("unknown, repeated and malformed parameters answer 400 with the error envelope", async (t) => {
  const { port } = await queryEntry(t);
  const targets = [
    "/api/telemetry/live?from=1",
    "/api/telemetry/status?x=1",
    "/api/telemetry/baseline?x=1",
    `/api/telemetry/summary?${SPAN}&bogus=1`,
    "/api/telemetry/summary?sql=1%3Bdrop",
    "/api/telemetry/timeseries?metrics=req.count&sql=1",
    "/api/telemetry/timeseries?metrics=nope",
    "/api/telemetry/timeseries",
    "/api/telemetry/timeseries?metrics=req.count&groupBy=gpu",
    "/api/telemetry/breakdown?dim=password",
    "/api/telemetry/breakdown?dim=model&sort=-secret",
    "/api/telemetry/requests?limit=0",
    "/api/telemetry/requests?cursor=not-a-cursor",
    `/api/telemetry/requests/${rid(1)}?extra=1`,
    "/api/telemetry/events?type=Bad%20Type",
    "/api/telemetry/energy?groupBy=week",
    "/api/telemetry/export?kind=secrets",
    "/api/telemetry/summary?from=yesterday",
    "/api/telemetry/summary?from=2020-01-01T00:00:00Z",
  ];
  for (const target of targets) {
    const response = await request(port, target);
    assert.equal(response.status, 400, `${target} answered ${response.status}`);
    assert.deepEqual(validate("error", response.json).errors, [], target);
  }
  const unknown = await request(port, `/api/telemetry/summary?${SPAN}&bogus=1`);
  assert.equal(unknown.json.error.code, "unknown_parameter");
  const repeated = await request(port, `/api/telemetry/summary?from=${START}&from=${START + 1}`);
  assert.equal(repeated.json.error.code, "duplicate_parameter");
});

test("keyset pagination over HTTP is stable: no row twice, none skipped, newest first", async (t) => {
  const { port } = await queryEntry(t);
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 40; page += 1) {
    const response = await request(port, `/api/telemetry/requests?${SPAN}&limit=7${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(response.status, 200);
    assert.deepEqual(validate("requests", response.json).errors, []);
    assert.ok(response.json.rows.length <= 7);
    seen.push(...response.json.rows.map((row) => ({ id: row.id, at: row.receivedAt })));
    cursor = response.json.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, ROW_COUNT + 1);
  assert.equal(new Set(seen.map((row) => row.id)).size, seen.length, "no duplicates");
  for (let index = 1; index < seen.length; index += 1) {
    const [a, b] = [seen[index - 1], seen[index]];
    assert.ok(a.at > b.at || (a.at === b.at && a.id > b.id), "received_at DESC, id DESC");
  }
  const first = await request(port, `/api/telemetry/requests?${SPAN}&limit=7`);
  const again = await request(port, `/api/telemetry/requests?${SPAN}&limit=7`);
  assert.deepEqual(first.json.rows.map((row) => row.id), again.json.rows.map((row) => row.id));
  const search = await request(port, `/api/telemetry/requests?${SPAN}&q=${rid(12)}`);
  assert.equal(search.json.rows.length, 1);
  assert.equal(search.json.rows[0].requestId, rid(12));
});

test("request detail joins billing, the launch summary without argv, nearby events and the audit lock", async (t) => {
  const billing = fakeBilling();
  const { port } = await queryEntry(t, { getBillingStore: () => billing });
  const response = await request(port, `/api/telemetry/requests/${rid(3)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(validate("requestDetail", response.json).errors, []);
  assert.equal(response.json.request.requestId, rid(3));
  assert.deepEqual(response.json.billing.usage, { usageId: "use_1", chargedMicrocredits: "0", projectedMicrocredits: "1834", usageSource: "reported", terminalState: "completed", decisionCode: "billing_shadow_allowed" });
  assert.deepEqual(response.json.billing.reservation, { enforcementMode: "shadow", decisionCode: "billing_shadow_allowed", reservationMicrocredits: "4096" });
  const lookup = billing.calls.find(([name]) => name === "usage");
  assert.deepEqual(lookup[1], [rid(3), rid(3, "mgr_")], "both ids are tried");
  assert.deepEqual(response.json.instance.launch.summary, { contextLength: 262144 });
  assert.equal(response.text.includes("do-not-show"), false, "argv is never included");
  assert.deepEqual(response.json.audit, { unlocked: false, linkable: false, chatId: null, candidates: [] }, "a curl request has no chat to link");
  const withAlert = await request(port, `/api/telemetry/requests/${rid(5)}`);
  assert.ok(withAlert.json.events.some((event) => event.type === "alert.firing"));
  assert.equal(withAlert.json.billing, null, "a request without a usage row has no billing block");
  const missing = await request(port, "/api/telemetry/requests/req_missing");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "request_not_found");
});

test("the audit link is resolved only with an audit session, and every candidate lookup is logged", async (t) => {
  const logged = [];
  const chat = { chatId: "chat-1", auditId: "audit-1", title: "A chat" };
  const audit = {
    checkSession: (req) => (req.headers["x-audit-session"] === "valid" ? { id: "s1" } : null),
    logAccess: async (req, entry) => { logged.push(entry); },
    index: {
      async searchChats(options) {
        assert.equal(options.model, "model-a");
        return { rows: [chat] };
      },
      async getChat(chatId) {
        assert.equal(chatId, "chat-1");
        return { messages: [{ id: "m1", role: "user", timestamp: START + 5_000 }, { id: "m2", role: "user", timestamp: START + 3 * HOUR_MS }] };
      },
    },
  };
  const { port } = await queryEntry(t, { audit });
  const locked = await request(port, `/api/telemetry/requests/${rid(1)}`);
  assert.equal(locked.json.audit.unlocked, false);
  assert.deepEqual(locked.json.audit.candidates, []);
  assert.equal(logged.length, 0);
  const opened = await request(port, `/api/telemetry/requests/${rid(1)}`, { headers: { "x-audit-session": "valid" } });
  assert.equal(opened.json.audit.unlocked, true);
  assert.equal(opened.json.audit.candidates.length, 1);
  assert.equal(opened.json.audit.candidates[0].chatId, "chat-1");
  assert.equal(opened.json.audit.candidates[0].messageId, "m1");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, "link_lookup");
  assert.equal(logged[0].target, rid(1));
});

test("a LAN viewer gets the redacted output of the registered routes, and owner_required where a key or customer would show", async (t) => {
  const { port } = await queryEntry(t, { getBillingStore: () => fakeBilling() });
  const redactedPairs = [
    ["/api/telemetry/live", viewerRedaction.redactLive],
    [`/api/telemetry/summary?${SPAN}`, viewerRedaction.redactSummary],
    [`/api/telemetry/timeseries?metrics=req.count&${SPAN}&groupBy=model&annotate=launch,alert`, viewerRedaction.redactSeries],
    [`/api/telemetry/breakdown?dim=error_class&${SPAN}`, viewerRedaction.redactBreakdown],
    [`/api/telemetry/events?${SPAN}`, viewerRedaction.redactEvents],
    [`/api/telemetry/energy?${SPAN}`, viewerRedaction.identity],
    [`/api/telemetry/lifecycle?${SPAN}`, viewerRedaction.identity],
    [`/api/telemetry/launches?${SPAN}`, viewerRedaction.identity],
    ["/api/telemetry/baseline", viewerRedaction.identity],
    ["/api/telemetry/status", viewerRedaction.redactStatus],
  ];
  for (const [target, redact] of redactedPairs) {
    const owner = await request(port, target);
    const viewer = await request(port, target, { peer: LAN });
    assert.equal(owner.status, 200, target);
    assert.equal(viewer.status, 200, `${target}: ${viewer.text.slice(0, 160)}`);
    assert.deepEqual(viewer.json, JSON.parse(JSON.stringify(redact(owner.json))), `${target} is the owner body through its redaction`);
    for (const secret of [SECRET_KEY, SECRET_CUSTOMER, SECRET_IP, "billedMicrocredits", "activeKeys", "sampleRequestIds", "203.0.113.9", rid(5)]) {
      assert.equal(viewer.text.includes(secret), false, `${target} leaks ${secret}`);
    }
  }
  const ban = (await request(port, `/api/telemetry/events?${SPAN}&type=security.ban`, { peer: LAN })).json.rows[0];
  assert.deepEqual(ban.data, { ipMasked: "203.0.113.x" });
  assert.equal("requestId" in ban, false);
  const summary = (await request(port, `/api/telemetry/summary?${SPAN}`, { peer: LAN })).json;
  assert.equal(summary.viewer, true);

  for (const target of [
    `/api/telemetry/timeseries?metrics=req.count&${SPAN}&groupBy=key`,
    `/api/telemetry/timeseries?metrics=req.count&${SPAN}&groupBy=customer`,
    `/api/telemetry/timeseries?metrics=req.count&${SPAN}&key_id=${SECRET_KEY}`,
    `/api/telemetry/timeseries?metrics=req.count&${SPAN}&customer_id=${SECRET_CUSTOMER}`,
    `/api/telemetry/breakdown?dim=client_ip&${SPAN}`,
    `/api/telemetry/breakdown?dim=customer&${SPAN}`,
    `/api/telemetry/breakdown?dim=key&${SPAN}`,
    `/api/telemetry/breakdown?dim=model&${SPAN}&key_id=${SECRET_KEY}`,
  ]) {
    const viewer = await request(port, target, { peer: LAN });
    assert.equal(viewer.status, 403, target);
    assert.equal(viewer.json.error.code, "owner_required", target);
    assert.equal((await request(port, target)).status, 200, `${target} is fine for the owner`);
  }
});

test("a viewer reaches nothing that is owner only, on the LAN and on loopback without a session", async (t) => {
  const { port } = await queryEntry(t, { telemetryConfig: fakeConfig() });
  const ownerOnly = [
    ["GET", `/api/telemetry/requests?${SPAN}`],
    ["GET", `/api/telemetry/requests/${rid(1)}`],
    ["GET", `/api/telemetry/export?${SPAN}`],
    ["GET", "/api/telemetry/settings"],
    ["PUT", "/api/telemetry/settings"],
    ["POST", "/api/telemetry/import"],
  ];
  for (const [method, target] of ownerOnly) {
    for (const response of [
      await request(port, target, { method, peer: LAN, ...(method === "GET" ? {} : { body: {} }) }),
      await asViewer(port, target, { method, ...(method === "GET" ? {} : { body: {} }) }),
    ]) {
      assert.equal(response.status, 401, `${method} ${target} answered ${response.status}`);
      assert.equal(response.json.error.code, "admin_session_required", `${method} ${target}`);
      for (const secret of [SECRET_KEY, SECRET_CUSTOMER, SECRET_IP, "requestId"]) assert.equal(response.text.includes(secret), false);
    }
  }
  // Loopback without a session is a viewer too: the same redacted bodies.
  const lanBody = (await request(port, `/api/telemetry/summary?${SPAN}`, { peer: LAN })).json;
  const loopback = await asViewer(port, `/api/telemetry/summary?${SPAN}`);
  assert.equal(loopback.status, 200);
  assert.deepEqual(loopback.json, lanBody);
});

test("settings GET returns the section with an etag header and masked webhooks; secrets are never echoed", async (t) => {
  const config = fakeConfig({ alerts: { webhooks: [{ id: "ops", url: "https://hooks.example.test/services/T000/B000/XXXX", format: "slack", minSeverity: "warning" }] } });
  const secrets = fakeSecrets();
  await secrets.set("webhooks", "ops", WEBHOOK_SECRET);
  const { port } = await queryEntry(t, { telemetryConfig: config, secretStore: secrets });
  const response = await request(port, "/api/telemetry/settings");
  assert.equal(response.status, 200);
  assert.deepEqual(validate("settings", response.json).errors, []);
  assert.equal(response.headers.etag, '"etag-1"');
  assert.equal(response.json.etag, "etag-1");
  assert.deepEqual(response.json.alerts.webhooks, [{ id: "ops", format: "slack", url: "https://hooks.example.test/…", minSeverity: "warning", secret: { set: true } }]);
  assert.equal(response.text.includes("XXXX"), false);
  assert.equal(response.text.includes(WEBHOOK_SECRET), false);
  assert.equal(response.json.retention.requestsDays, 30);
});

test("settings PUT goes through writeSection with the etag; a stale etag is 409 and nothing is written to platform.json", async (t) => {
  const config = fakeConfig();
  const secrets = fakeSecrets();
  const { port, root, logger } = await queryEntry(t, { telemetryConfig: config, secretStore: secrets });
  const send = (body, headers = {}) => request(port, "/api/telemetry/settings", { method: "PUT", body, headers });

  assert.equal((await send({ sampleIntervalMs: 15_000 })).status, 428, "If-Match is required");
  const bad = await send({ nonsense: 1 }, { "if-match": '"etag-1"' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json.errors.map((entry) => entry.field), ["nonsense"]);
  assert.equal(config.writes.length, 0, "an invalid patch never reaches the writer");

  const ok = await send({ sampleIntervalMs: 15_000, energy: { pricePerKwh: 0.6, currency: "CNY", tariffs: [], hostBaselineWatts: 0 } }, { "if-match": '"etag-1"' });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(validate("settingsWrite", ok.json).errors, []);
  assert.deepEqual(ok.json.changed, ["telemetry.sampleIntervalMs", "telemetry.energy"]);
  assert.equal(ok.json.etag, "etag-2");
  assert.equal(config.writes.length, 1);
  assert.equal(config.writes[0].options.etag, "etag-1");

  const stale = await send({ sampleIntervalMs: 20_000 }, { "if-match": '"etag-1"' });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "etag_mismatch");
  assert.equal(stale.json.etag, "etag-2");
  assert.equal(config.readSection("telemetry").values.sampleIntervalMs, 15_000, "the stale write changed nothing");
  assert.equal(fs.existsSync(path.join(root, "config", "platform.json")), false, "telemetry-routes never writes platform.json itself");
  assert.equal(logger.lines.some((line) => line.includes("sampleIntervalMs")), false);
});

test("webhook secrets go only to the secret store, never into the patch, the response, platform.json or the logs", async (t) => {
  const config = fakeConfig();
  const secrets = fakeSecrets();
  const { port, root, logger } = await queryEntry(t, { telemetryConfig: config, secretStore: secrets });
  const hook = { id: "ops", url: "https://hooks.example.test/services/T000/B000/XXXX", format: "slack", minSeverity: "critical", secret: WEBHOOK_SECRET };
  const saved = await request(port, "/api/telemetry/settings", { method: "PUT", body: { alerts: { webhooks: [hook] } }, headers: { "if-match": '"etag-1"' } });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(config.writes[0].patch.alerts.webhooks, [{ id: "ops", url: hook.url, format: "slack", minSeverity: "critical" }]);
  assert.equal(JSON.stringify(config.writes).includes(WEBHOOK_SECRET), false);
  assert.equal(secrets.map.get("webhooks/ops"), WEBHOOK_SECRET);
  assert.equal(saved.text.includes(WEBHOOK_SECRET), false);

  const read = await request(port, "/api/telemetry/settings");
  assert.deepEqual(read.json.alerts.webhooks[0].secret, { set: true });
  assert.equal(read.text.includes(WEBHOOK_SECRET), false);
  assert.equal(read.text.includes("XXXX"), false);

  // The masked URL read back is accepted as "unchanged"; an explicit null clears the secret.
  const masked = read.json.alerts.webhooks[0];
  const again = await request(port, "/api/telemetry/settings", { method: "PUT", body: { alerts: { webhooks: [{ id: "ops", url: masked.url, format: "slack", minSeverity: "critical", secret: null }] } }, headers: { "if-match": `"${read.json.etag}"` } });
  assert.equal(again.status, 200, again.text);
  assert.equal(config.writes[1].patch.alerts.webhooks[0].url, hook.url, "the stored URL is kept");
  assert.equal(secrets.map.has("webhooks/ops"), false);

  // Removing a webhook removes its secret.
  await secrets.set("webhooks", "ops", WEBHOOK_SECRET);
  const etag = (await request(port, "/api/telemetry/settings")).json.etag;
  const removed = await request(port, "/api/telemetry/settings", { method: "PUT", body: { alerts: { webhooks: [] } }, headers: { "if-match": `"${etag}"` } });
  assert.equal(removed.status, 200);
  assert.equal(secrets.map.has("webhooks/ops"), false);

  assert.equal(fs.existsSync(path.join(root, "config", "platform.json")), false);
  assert.equal(logger.lines.some((line) => line.includes(WEBHOOK_SECRET)), false, "no log line carries the secret");
});

test("webhook validation: unsafe URLs, bad formats and unknown fields are 400, and an unavailable secret store is 503", async (t) => {
  const config = fakeConfig();
  const { port } = await queryEntry(t, { telemetryConfig: config, secretStore: fakeSecrets({ failSet: true }) });
  const put = (webhooks) => request(port, "/api/telemetry/settings", { method: "PUT", body: { alerts: { webhooks } }, headers: { "if-match": '"etag-1"' } });
  const base = { id: "ops", url: "https://hooks.example.test/x", format: "generic", minSeverity: "warning" };
  for (const bad of [
    { ...base, url: "http://127.0.0.1:8080/x" },
    { ...base, url: "http://localhost/x" },
    { ...base, url: "ftp://hooks.example.test/x" },
    { ...base, url: "https://user:pass@hooks.example.test/x" },
    { ...base, url: "http://169.254.169.254/latest" },
    { ...base, format: "carrier-pigeon" },
    { ...base, minSeverity: "loud" },
    { ...base, id: "Bad Id" },
    { ...base, extra: true },
  ]) {
    const response = await put([bad]);
    assert.equal(response.status, 400, JSON.stringify(bad));
  }
  assert.equal(config.writes.length, 0);
  const failing = await put([{ ...base, secret: WEBHOOK_SECRET }]);
  assert.equal(failing.status, 503);
  assert.equal(failing.json.error.code, "secret_store_unavailable");
  assert.equal(failing.text.includes(WEBHOOK_SECRET), false);
});

test("export streams CSV with a BOM, formula escaping and the documented headers", async (t) => {
  const { port } = await queryEntry(t, { telemetryConfig: fakeConfig() });
  const response = await request(port, `/api/telemetry/export?kind=requests&${SPAN}&format=csv`);
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /text\/csv/);
  assert.match(response.headers["content-disposition"], /^attachment; filename="telemetry-requests-\d{8}T\d{6}Z\.csv"$/);
  assert.equal(response.headers["x-telemetry-total"], String(ROW_COUNT + 1));
  assert.equal(response.text.charCodeAt(0), 0xfeff, "UTF-8 BOM");
  const lines = response.text.trim().split("\r\n");
  assert.equal(lines.length, ROW_COUNT + 2);
  const formula = lines.find((line) => line.includes("calc"));
  assert.ok(formula, "the planted user agent is exported");
  assert.equal(formula.includes(",=cmd"), false, "a formula cell is escaped, not exported raw");

  const jsonl = await request(port, `/api/telemetry/export?kind=events&${SPAN}&format=jsonl`);
  assert.equal(jsonl.status, 200);
  assert.match(jsonl.headers["content-disposition"], /\.jsonl"$/);
  const rows = jsonl.text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 3);
  assert.equal(rows.some((row) => row._truncated), false);

  const rollup = await request(port, `/api/telemetry/export?kind=rollup&grain=1m&${SPAN}&format=csv`);
  assert.equal(rollup.status, 200);
  assert.ok(rollup.text.split("\r\n").length > 2);
});

test("an export over the row cap ends with the truncation marker and reports the full total", async (t) => {
  const { port } = await queryEntry(t, { telemetryConfig: fakeConfig({ exportMaxRows: 25 }) });
  const response = await request(port, `/api/telemetry/export?kind=requests&${SPAN}&format=jsonl`);
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-telemetry-total"], String(ROW_COUNT + 1));
  const lines = response.text.trim().split("\n");
  assert.equal(lines.length, 26);
  assert.deepEqual(JSON.parse(lines[25]), { _truncated: true });
  const csv = await request(port, `/api/telemetry/export?kind=requests&${SPAN}`);
  assert.equal(csv.text.trim().split("\r\n").length, 26, "header plus 25 rows");
});

test("a 200000-row export streams without holding the rows in memory", async (t) => {
  const { port, dbFile } = await queryEntry(t, { telemetryConfig: fakeConfig() });
  const total = 200_000;
  const sqlite = require("node:sqlite");
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec(`PRAGMA busy_timeout = 5000; PRAGMA synchronous = OFF; PRAGMA cache_size = -200000;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${total})
    INSERT INTO requests (request_id, ingress, received_at, ended_at, protocol, op, method, path, source_program, status, terminal_state, error_class, duration_ms, user_agent)
    SELECT 'req_bulk' || i, 'entry', ${START + 10 * MINUTE_MS} + (i % 1000), ${START + 10 * MINUTE_MS} + (i % 1000) + 5, 'openai', 'chat', 'POST',
      '/gateway/auto/openai/v1/chat/completions', 'curl', 200, 'completed', 'none', 5, 'bulk-export-agent-0123456789-0123456789' FROM n;`);
  db.close();

  // A forced collection makes heapUsed the live set, not the garbage.
  require("node:v8").setFlagsFromString("--expose-gc");
  const gc = require("node:vm").runInNewContext("gc");
  gc();
  const before = process.memoryUsage().heapUsed;
  let peak = 0;
  const sampler = setInterval(() => {
    gc();
    peak = Math.max(peak, process.memoryUsage().heapUsed - before);
  }, 400);
  const http = require("node:http");
  const result = await new Promise((resolve, reject) => {
    const call = http.request({ host: "127.0.0.1", port, path: `/api/telemetry/export?kind=requests&from=${START}&to=${START + HOUR_MS}&format=csv`, method: "GET", headers: { host: "127.0.0.1:5176", ...owners.get(port).headers("GET") }, agent: false }, (response) => {
      let bytes = 0;
      let newlines = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        for (let index = 0; index < chunk.length; index += 1) if (chunk[index] === 10) newlines += 1;
      });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, bytes, newlines }));
      response.on("error", reject);
    });
    call.on("error", reject);
    call.end();
  }).finally(() => clearInterval(sampler));
  assert.equal(result.status, 200);
  assert.equal(result.headers["x-telemetry-total"], String(total + ROW_COUNT + 1));
  assert.equal(result.newlines, 200_001, "the header plus 200000 rows, then the cap");
  assert.ok(result.bytes > 20_000_000, `the export is large (${result.bytes} bytes)`);
  // The CSV is far bigger than the allowance: holding it, or its rows, would show here.
  assert.ok(peak < 16 * 1024 * 1024, `live heap grew by ${Math.round(peak / 1024 / 1024)} MiB while streaming ${Math.round(result.bytes / 1024 / 1024)} MiB`);
});

test("endpoints answer 405 for other methods, 503 without a store, and fall through for unknown names", async (t) => {
  const { port, ctx } = await queryEntry(t);
  const post = await request(port, "/api/telemetry/summary", { method: "POST", body: {} });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET");
  assert.equal((await request(port, "/api/telemetry/nothing-here")).status, 404);
  ctx.telemetry = null;
  const down = await request(port, `/api/telemetry/summary?${SPAN}`);
  assert.equal(down.status, 503);
  assert.equal(down.json.error.code, "telemetry_unavailable");
  const live = await request(port, "/api/telemetry/live");
  assert.equal(live.status, 200, "the live snapshot still answers, degraded");
  assert.deepEqual(validate("live", live.json).errors, []);
  assert.equal(live.json.collectors.store, "degraded");
  const status = await request(port, "/api/telemetry/status");
  assert.equal(status.status, 200);
  assert.ok(status.json.degraded.includes("store_unavailable"));
});

test("every 04 GET route the module serves is registered for viewers or declared owner-only", async (t) => {
  const { ctx } = await queryEntry(t);
  const inventory = ctx.auth.viewerRegistry.inventory().filter((item) => item.path.startsWith("/api/telemetry/") && item.method !== "EVENT");
  const viewerPaths = inventory.filter((item) => item.access === "viewer").map((item) => item.path.replace("/api/telemetry/", "")).sort();
  assert.deepEqual(viewerPaths, ["alert-rules", "alerts", "baseline", "breakdown", "energy", "events", "launches", "lifecycle", "live", "status", "summary", "timeseries"]);
  const ownerOnly = inventory.filter((item) => item.access === "admin").map((item) => `${item.method} ${item.path.replace("/api/telemetry/", "")}`).sort();
  assert.deepEqual(ownerOnly, ["DELETE alert-rules/:ruleId", "GET export", "GET import/:runId", "GET requests", "GET requests/:requestId", "GET settings", "POST alert-rules", "POST alerts/:ruleId/ack", "POST alerts/:ruleId/silence", "POST alerts/test", "POST import", "PUT alert-rules/:ruleId", "PUT settings"]);
});

test("the shape validators reject drifted bodies", () => {
  assert.equal(validate("summary", { ok: true }).ok, false);
  assert.match(validate("live", { ok: true, at: "yesterday" }).errors.join("\n"), /at: expected an ISO 8601/);
  const tooMany = { ok: true, from: "2026-10-14T00:00:00Z", to: "2026-10-14T01:00:00Z", step: 10, source: "requests", tzOffsetMinutes: 0, annotations: [], otherGroups: 0, series: [{ metric: "m", unit: "u", group: {}, points: Array.from({ length: 601 }, (_, index) => [index, 1]) }] };
  assert.match(validate("timeseries", tooMany).errors.join("\n"), /at most 600/);
  assert.throws(() => assertValid("error", { ok: true }), TypeError);
  assert.throws(() => validate("nope", {}), RangeError);
});

test("with the real platform config the PUT goes through the only writer: platform.json changes, a stale etag is 409", async (t) => {
  const secrets = fakeSecrets();
  const { port, root } = await queryEntry(t, { secretStore: secrets });
  const before = await request(port, "/api/telemetry/settings");
  assert.equal(before.status, 200, before.text);
  assert.equal(before.json.sampleIntervalMs, 10_000);
  assert.equal(before.json.timezoneOffsetMinutes, null, "empty means this machine's time zone");
  assert.deepEqual(before.json.alerts.webhooks, []);

  const saved = await request(port, "/api/telemetry/settings", { method: "PUT", body: { sampleIntervalMs: 20_000, retention: { requestsDays: 60 } }, headers: { "if-match": `"${before.json.etag}"` } });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.changed, ["telemetry.retention.requestsDays", "telemetry.sampleIntervalMs"]);
  const file = JSON.parse(fs.readFileSync(path.join(root, "config", "platform.json"), "utf8"));
  assert.equal(file.telemetry.sampleIntervalMs, 20_000);
  assert.equal(file.telemetry.retention.requestsDays, 60);

  const stale = await request(port, "/api/telemetry/settings", { method: "PUT", body: { sampleIntervalMs: 30_000 }, headers: { "if-match": `"${before.json.etag}"` } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "etag_mismatch");

  const invalid = await request(port, "/api/telemetry/settings", { method: "PUT", body: { sampleIntervalMs: 100 }, headers: { "if-match": `"${saved.json.etag}"` } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.errors[0].field, "telemetry.sampleIntervalMs");
  const read = await request(port, "/api/telemetry/settings");
  assert.equal(read.json.sampleIntervalMs, 20_000);
  assert.equal(read.json.retention.requestsDays, 60);
});

test("without the pre-dispatch guard a viewer is still pre-checked and redacted by the module itself", async () => {
  const calls = [];
  const store = {
    state: "ready",
    async call(name, params) {
      calls.push(name);
      if (name === "summary") return { ok: true, from: "2026-10-14T00:00:00.000Z", to: "2026-10-14T01:00:00.000Z", current: { requests: 3, activeKeys: 2, billedMicrocredits: "9" }, source: "rollup_1h" };
      if (name === "breakdown") return { ok: true, dim: "model", rows: [{ key: "m", requests: 1, sampleRequestIds: ["req_x"] }], total: { requests: 1 } };
      throw new Error(`unexpected ${name}`);
    },
  };
  const queries = telemetryRoutes.createQueryRoutes({
    auth: fakeAuth({ role: "viewer", principal: "viewer" }),
    readJsonObjectBody: async () => ({}),
    getStore: () => store,
    config: fakeConfig(),
    logger: { warn() {} },
    now: () => NOW,
  });
  const ask = async (target) => {
    const res = fakeRes();
    assert.equal(await queries.handle(fakeReq("GET"), res, new URL(`http://x${target}`)), true);
    return res;
  };
  const summary = await ask(`/api/telemetry/summary?${SPAN}`);
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.json.current, { requests: 3 });
  assert.equal(summary.json.viewer, true);
  const breakdown = await ask(`/api/telemetry/breakdown?dim=model&${SPAN}`);
  assert.equal("sampleRequestIds" in breakdown.json.rows[0], false);
  const before = calls.length;
  for (const target of [`/api/telemetry/timeseries?metrics=req.count&${SPAN}&groupBy=key`, `/api/telemetry/breakdown?dim=client_ip&${SPAN}`, `/api/telemetry/summary?${SPAN}&customer_id=c`]) {
    const refused = await ask(target);
    assert.equal(refused.status, 403, target);
    assert.equal(refused.json.error.code, "owner_required");
  }
  assert.equal(calls.length, before, "a refused query never reaches the store");
  for (const target of [`/api/telemetry/requests?${SPAN}`, "/api/telemetry/settings", `/api/telemetry/export?${SPAN}`, `/api/telemetry/requests/${rid(1)}`]) {
    const refused = await ask(target);
    assert.equal(refused.status, 401, target);
  }
});
