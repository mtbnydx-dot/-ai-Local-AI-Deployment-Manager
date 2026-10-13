"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const core = require("..");

const DAY_MS = 24 * 60 * 60 * 1000;

// Export trees live under the OS temp folder (rule 1.8).
async function auditRootFor(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "audit-retention-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeExport(root, auditId, { mode, chatCount = 1, ageDays = 0, now = Date.now() }) {
  const dir = path.join(root, auditId);
  await fsp.mkdir(dir, { recursive: true });
  const manifest = {
    ok: true,
    auditId,
    createdAt: new Date(now - ageDays * DAY_MS).toISOString(),
    mode,
    summary: { chat_count: chatCount, incremental: mode === "incremental" },
  };
  await fsp.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  return dir;
}

function createStore(root, extra = {}) {
  return core.createAuditStore({
    auditRoot: root,
    auditPasswordFile: path.join(root, "audit-admin-password.txt"),
    openWebuiContainer: "open-webui",
    serviceContainer: "runtime",
    getContainerStatus: async () => ({ exists: true }),
    docker: async () => ({ stdout: "", stderr: "" }),
    ...extra,
  });
}

async function remainingIds(store) {
  return (await store.listAuditExports()).map((item) => item.auditId);
}

test("pruning keeps the newest full export and every newer export beyond the count", async (t) => {
  const root = await auditRootFor(t);
  const now = Date.now();
  await writeExport(root, "e0-full", { mode: "full", ageDays: 6, now });
  await writeExport(root, "e1-inc", { mode: "incremental", ageDays: 5, now });
  await writeExport(root, "e2-full", { mode: "full", ageDays: 4, now });
  await writeExport(root, "e3-inc", { mode: "incremental", ageDays: 3, now });
  await writeExport(root, "e4-inc", { mode: "incremental", ageDays: 2, now });
  await writeExport(root, "e5-inc", { mode: "incremental", ageDays: 1, now });
  const store = createStore(root);
  const result = await store.pruneAuditExports({ auditMaxExports: 2, auditMaxAgeDays: 0, now });
  assert.deepEqual(await remainingIds(store), ["e5-inc", "e4-inc", "e3-inc", "e2-full"]);
  assert.deepEqual(result.removed.map((item) => [item.auditId, item.reason]), [["e1-inc", "max-exports"], ["e0-full", "max-exports"]]);
});

test("exports older than the newest full are pruned by age, the chain never is", async (t) => {
  const root = await auditRootFor(t);
  const now = Date.now();
  await writeExport(root, "old-full", { mode: "full", ageDays: 200, now });
  await writeExport(root, "chain-full", { mode: "full", ageDays: 120, now });
  await writeExport(root, "chain-inc", { mode: "incremental", ageDays: 100, now });
  const store = createStore(root);
  await store.pruneAuditExports({ auditMaxExports: 30, auditMaxAgeDays: 90, now });
  assert.deepEqual(await remainingIds(store), ["chain-inc", "chain-full"]);
});

test("without a full export incrementals are never pruned, but empty ones are", async (t) => {
  const root = await auditRootFor(t);
  const now = Date.now();
  await writeExport(root, "i1", { mode: "incremental", ageDays: 300, now });
  await writeExport(root, "i2-empty", { mode: "incremental", chatCount: 0, ageDays: 200, now });
  await writeExport(root, "i3", { mode: "incremental", ageDays: 100, now });
  await writeExport(root, "i4-empty-newest", { mode: "incremental", chatCount: 0, ageDays: 1, now });
  const store = createStore(root);
  const result = await store.pruneAuditExports({ auditMaxExports: 1, auditMaxAgeDays: 1, now });
  assert.deepEqual(await remainingIds(store), ["i4-empty-newest", "i3", "i1"]);
  assert.deepEqual(result.removed, [{ auditId: "i2-empty", reason: "empty-incremental" }]);
});

test("an empty incremental older than the newest full is pruned within the limits", async (t) => {
  const root = await auditRootFor(t);
  const now = Date.now();
  await writeExport(root, "a-inc", { mode: "incremental", ageDays: 3, now });
  await writeExport(root, "b-empty", { mode: "incremental", chatCount: 0, ageDays: 2, now });
  await writeExport(root, "c-full", { mode: "full", ageDays: 1, now });
  const store = createStore(root);
  await store.pruneAuditExports({ auditMaxExports: 30, auditMaxAgeDays: 90, now });
  assert.deepEqual(await remainingIds(store), ["c-full", "a-inc"]);
});

function fakeExporterDocker(state) {
  return async (args) => {
    state.calls.push(args);
    if (args[0] === "exec" && args[2] === "python") {
      if (state.fail) return { stdout: "", stderr: "boom", error: new Error("exit 1") };
      const since = args[5];
      const rows = state.rows.filter((row) => since === undefined || row > Number(since));
      return {
        stdout: JSON.stringify({
          ok: true,
          incremental: since !== undefined,
          since_updated_at: since === undefined ? null : Number(since),
          chat_count: rows.length,
          total_chat_count: state.rows.length,
          message_count: rows.length,
          max_updated_at: rows.length ? Math.max(...rows) : (since === undefined ? null : Number(since)),
          files: [],
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
}

test("an incremental run with no new chats writes no folder and records a heartbeat", async (t) => {
  const root = await auditRootFor(t);
  const state = { calls: [], rows: [100, 200] };
  const store = createStore(root, { docker: fakeExporterDocker(state) });
  const full = await store.exportOpenWebuiAudit("manual", {});
  assert.equal(full.mode, "full");
  const cursorBefore = await store.readAuditCursor();
  assert.equal(cursorBefore.maxUpdatedAt, 200);

  const callsBefore = state.calls.length;
  const empty = await store.exportOpenWebuiAudit("model-stop", {});
  assert.equal(empty.ok, true);
  assert.equal(empty.skipped, true);
  assert.equal(empty.empty, true);
  assert.equal(empty.chatCount, 0);
  assert.equal(empty.auditId, undefined);
  assert.equal(state.calls.slice(callsBefore).some((args) => args[0] === "cp" && String(args[1]).startsWith("open-webui:")), false, "nothing is copied back");
  assert.deepEqual(await remainingIds(store), [full.auditId], "no folder was written");
  const dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.deepEqual(dirs, [full.auditId]);
  const cursor = await store.readAuditCursor();
  assert.equal(cursor.maxUpdatedAt, 200);
  assert.equal(cursor.lastAuditId, full.auditId);
  assert.ok(Number.isFinite(Date.parse(cursor.lastHeartbeatAt)));

  state.rows.push(300);
  const incremental = await store.exportOpenWebuiAudit("model-unload", {});
  assert.equal(incremental.mode, "incremental");
  assert.equal(incremental.chatCount, 1);
  assert.equal((await store.readAuditCursor()).maxUpdatedAt, 300);
  assert.equal((await store.readAuditCursor()).lastHeartbeatAt, cursor.lastHeartbeatAt, "the heartbeat field is kept");
});

test("an automatic export rebaselines once the newest full is older than AI_AUDIT_REBASELINE_DAYS", async (t) => {
  const root = await auditRootFor(t);
  const state = { calls: [], rows: [100] };
  const store = createStore(root, { docker: fakeExporterDocker(state) });
  const first = await store.exportOpenWebuiAudit("manual", {});
  const manifestFile = path.join(first.auditDir, "manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestFile, "utf8"));
  manifest.createdAt = new Date(Date.now() - 8 * DAY_MS).toISOString();
  await fsp.writeFile(manifestFile, JSON.stringify(manifest), "utf8");

  state.rows.push(200);
  const rebased = await store.exportOpenWebuiAudit("model-stop", {});
  assert.equal(rebased.mode, "full");
  assert.equal(rebased.rebaseline, true);
  const pythonCalls = state.calls.filter((args) => args[0] === "exec" && args[2] === "python");
  assert.equal(pythonCalls.at(-1).length, 5, "a rebaseline passes no cursor");

  // Fresh full: the next automatic run is incremental again.
  state.rows.push(300);
  const next = await store.exportOpenWebuiAudit("model-unload", {});
  assert.equal(next.mode, "incremental");
  assert.equal(next.rebaseline, false);

  // 0 disables rebaselining, through the option or the environment variable.
  const disabledRoot = await auditRootFor(t);
  const disabledState = { calls: [], rows: [100] };
  const previous = process.env.AI_AUDIT_REBASELINE_DAYS;
  process.env.AI_AUDIT_REBASELINE_DAYS = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.AI_AUDIT_REBASELINE_DAYS;
    else process.env.AI_AUDIT_REBASELINE_DAYS = previous;
  });
  const disabled = createStore(disabledRoot, { docker: fakeExporterDocker(disabledState) });
  await disabled.writeAuditCursor({ version: 1, maxUpdatedAt: 50 });
  disabledState.rows.push(150);
  const noFull = await disabled.exportOpenWebuiAudit("model-stop", {});
  assert.equal(noFull.mode, "incremental", "no rebaseline even without any full export");
  const enabled = createStore(disabledRoot, { docker: fakeExporterDocker(disabledState), auditRebaselineDays: 7 });
  disabledState.rows.push(250);
  assert.equal((await enabled.exportOpenWebuiAudit("model-unload", {})).mode, "full", "a missing full export triggers a rebaseline");
});

test("a failed export run leaves no folder behind", async (t) => {
  const root = await auditRootFor(t);
  const state = { calls: [], rows: [100], fail: true };
  const store = createStore(root, { docker: fakeExporterDocker(state) });
  await assert.rejects(store.exportOpenWebuiAudit("manual", {}), /audit export failed/);
  assert.deepEqual(await remainingIds(store), []);
});

function findPython() {
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["-c", "import sqlite3, sys; print(sys.version_info[0])"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    if (probe.status === 0 && String(probe.stdout).trim() === "3") return candidate;
  }
  return "";
}

test("the exporter cursor is the max updated_at of the fetched rows", async (t) => {
  const python = findPython();
  if (!python) {
    t.skip("python 3 with sqlite3 is not available");
    return;
  }
  const { DatabaseSync } = require("node:sqlite");
  const root = await auditRootFor(t);
  const dbFile = path.join(root, "webui.db");
  const db = new DatabaseSync(dbFile);
  db.exec(`
    create table user (id text, name text, email text, role text, created_at integer, updated_at integer, last_active_at integer);
    create table chat (id text, user_id text, title text, share_id text, archived integer, created_at integer, updated_at integer,
      chat text, pinned integer, meta text, folder_id text, tasks text, summary text, last_read_at integer);
    insert into user values ('u1', 'Tester', 'tester@example.invalid', 'user', 1, 1, 1);
  `);
  const insert = db.prepare("insert into chat values (?, 'u1', ?, null, 0, 1, ?, ?, 0, '{}', null, null, null, null)");
  const chat = JSON.stringify({ messages: [{ id: "m1", role: "user", content: "hello" }] });
  for (const [id, updatedAt] of [["c1", 100], ["c2", 200], ["c3", 300], ["c4", null]]) insert.run(id, `chat ${id}`, updatedAt, chat);
  db.close();

  const script = path.join(root, "exporter.py");
  await fsp.writeFile(script, core.OPENWEBUI_AUDIT_EXPORTER, "utf8");
  const run = (since) => {
    const out = path.join(root, `out-${since ?? "full"}`);
    const args = ["-I", script, out];
    if (since !== undefined) args.push(String(since));
    const result = spawnSync(python, args, {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      env: { ...process.env, OPENWEBUI_AUDIT_DB: dbFile, PYTHONIOENCODING: "utf-8" },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));
  };

  const full = run();
  assert.equal(full.chat_count, 4);
  assert.equal(full.max_updated_at, 300);
  const partial = run(150);
  assert.equal(partial.chat_count, 2);
  assert.equal(partial.max_updated_at, 300);
  const none = run(300);
  assert.equal(none.chat_count, 0);
  assert.equal(none.max_updated_at, 300, "with no rows the cursor stays at SINCE");
  assert.equal(fs.existsSync(path.join(root, "out-full", "openwebui-db-hashes.json")), true);
});

test("a missing export file returns 404 JSON and nothing throws", async () => {
  const routes = new Map();
  core.registerAuditRoutes({
    get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
    post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
  }, {
    requireAuditAuth: () => ({ ok: true }),
    getAuditMarkdownPath: async () => path.join(os.tmpdir(), `audit-missing-${process.pid}-${Date.now()}.md`),
  });
  const handler = routes.get("GET /api/audit/exports/:auditId/markdown");

  function makeResponse() {
    const res = new PassThrough();
    res.headersSent = false;
    res.statusCode = 200;
    res.headers = {};
    res.status = (code) => { res.statusCode = code; return res; };
    res.type = (value) => { res.headers["content-type"] = value; return res; };
    res.json = (value) => { res.headersSent = true; res.body = value; res.emit("json"); return res; };
    return res;
  }

  const res = makeResponse();
  const answered = new Promise((resolve) => res.once("json", resolve));
  await handler({ params: { auditId: "x" } }, res);
  await answered;
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers["content-type"], "application/json");
  assert.match(res.body.error, /not found/);

  // Once headers were sent, a read error ends the connection instead.
  const sent = makeResponse();
  sent.headersSent = true;
  const destroyed = new Promise((resolve) => { sent.destroy = () => resolve(true); });
  await handler({ params: { auditId: "y" } }, sent);
  assert.equal(await destroyed, true);
  assert.equal(sent.body, undefined);
});
