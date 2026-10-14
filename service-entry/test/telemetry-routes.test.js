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

async function mountEntry(t, { root, store }) {
  const { entry } = await loadEntry();
  const ctx = entry.createRouteContext({
    logger: quietLogger(),
    aiRoot: root,
    rootDir: path.join(root, "service-entry"),
    managers: [{ id: "vllm", port: 1 }, { id: "llama", port: 2 }],
    telemetry: { store },
  });
  const notifications = [];
  ctx.bus.subscribe((envelope) => notifications.push(envelope), { types: ["notification"] });
  const routes = await entry.mountRouteModules({ ctx });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  owners.set(port, await ownerSession(entry, port));
  return { entry, ctx, port, notifications };
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
