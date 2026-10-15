const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createTelemetryRuntime } = require("../lib/telemetry-runtime");

// The recorder side of the entry's telemetry runtime (04 TEL-5). The
// EventCollector wiring is covered by telemetry-runtime.test.js.
const QUIET = { log() {}, warn() {}, error() {} };

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-telemetry-runtime-"));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });
  return dir;
}

function runtimeFor(root, extra = {}) {
  return createTelemetryRuntime({
    aiRoot: root,
    dataDir: path.join(root, "data"),
    logger: QUIET,
    inProcess: true,
    docker: false,
    jobs: { enabled: false },
    flushMs: 30,
    ...extra,
  });
}

test("TELEMETRY_ENABLED=0 disables the recorder and creates no store", async (t) => {
  const root = tempRoot(t);
  for (const off of ["0", "false", "off"]) {
    const runtime = runtimeFor(root, { env: { TELEMETRY_ENABLED: off } });
    assert.equal(runtime.enabled, false, off);
    assert.equal(runtime.recorder, null);
    await runtime.start();
    const status = runtime.status();
    assert.equal(status.store, "disabled");
    assert.equal(status.recorder, null);
    assert.equal((await runtime.stop()).ok, true);
    assert.equal(await runtime.recordSecurityBan({ ip: "203.0.113.1" }), null);
  }
  assert.equal(fs.existsSync(path.join(root, "data")), false, "nothing was created");
});

test("settings come from the environment while platform.json has no telemetry section, and from config when given", async (t) => {
  const root = tempRoot(t);
  const fromEnv = runtimeFor(root, { env: { AI_TELEMETRY_DB: path.join(root, "elsewhere", "t.sqlite"), TELEMETRY_ENABLED: "1" } });
  await fromEnv.start();
  assert.equal(fromEnv.status().store, "ready");
  assert.equal(fs.existsSync(path.join(root, "elsewhere", "t.sqlite")), true);
  await fromEnv.stop();

  const defaults = runtimeFor(root, { env: {} });
  await defaults.start();
  assert.equal(fs.existsSync(path.join(root, "data", "telemetry.sqlite")), true, "the default is service-entry/data/telemetry.sqlite");
  await defaults.stop();

  const configured = runtimeFor(root, { config: () => ({ enabled: true, dbPath: "relative/t2.sqlite" }), env: {} });
  assert.equal(configured.enabled, true);
  await configured.start();
  assert.equal(fs.existsSync(path.join(root, "relative", "t2.sqlite")), true, "a relative path is under the platform root");
  await configured.stop();
});

test("start and stop are idempotent, and the runtime serves no query routes yet", async (t) => {
  const root = tempRoot(t);
  const runtime = runtimeFor(root, { env: {} });
  assert.equal(runtime.status().started, false);
  await runtime.start();
  await runtime.start();
  await runtime.start();
  assert.equal(runtime.status().started, true);
  assert.equal(runtime.recorder.stats().running, true);
  assert.equal(await runtime.handleHttp({}, {}, new URL("http://127.0.0.1/api/telemetry/status")), false);
  // TEL-6: /internal/telemetry/* is served (telemetry-ingest.test.js); any other path is left alone.
  assert.equal(await runtime.handleInternal({}, {}, new URL("http://127.0.0.1/internal/billing/usage")), false);
  const first = await runtime.stop();
  assert.equal(first.ok, true);
  assert.equal(first.timedOut, false);
  assert.equal((await runtime.stop()).ok, true);
  assert.equal(runtime.status().stopped, true);
});

test("keepJsonlAccessLog is a live setting, re-read at most every few seconds", async (t) => {
  const root = tempRoot(t);
  let clock = 1_000_000;
  let keep = true;
  const runtime = runtimeFor(root, { now: () => clock, config: () => ({ enabled: true, keepJsonlAccessLog: keep }) });
  assert.equal(runtime.keepJsonlAccessLog(), true);
  keep = false;
  clock += 1000;
  assert.equal(runtime.keepJsonlAccessLog(), true, "still the cached value");
  clock += 6000;
  assert.equal(runtime.keepJsonlAccessLog(), false);
});

test("a ban is recorded as a security.ban event once the store is open, keyed by address and expiry", async (t) => {
  const root = tempRoot(t);
  const runtime = runtimeFor(root, { env: {} });
  assert.equal(await runtime.recordSecurityBan({ ip: "203.0.113.5", ipMasked: "203.0.113.x", until: "2026-10-14T08:10:00.000Z", failures: 20 }), null, "before start there is nowhere to write");
  await runtime.start();
  const ban = { ip: "203.0.113.5", ipMasked: "203.0.113.x", until: "2026-10-14T08:10:00.000Z", failures: 20 };
  await runtime.recordSecurityBan(ban);
  await runtime.recordSecurityBan(ban);
  await runtime.stop();
  const db = new DatabaseSync(path.join(root, "data", "telemetry.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT type, severity, source, dedupe_key, data FROM events WHERE type = 'security.ban'").all();
    assert.equal(rows.length, 1, "the dedupe key makes a replay idempotent");
    assert.equal(rows[0].dedupe_key, "security.ban:203.0.113.5:2026-10-14T08:10:00.000Z");
    assert.deepEqual(JSON.parse(rows[0].data), { ...ban, i18nKey: "obs.event.securityBan" });
  } finally {
    db.close();
  }
});
