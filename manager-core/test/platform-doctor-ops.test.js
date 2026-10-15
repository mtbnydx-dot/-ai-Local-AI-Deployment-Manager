"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runDoctor, runFix } = require("../platform/doctor");
const { createFixRunner, collectFixes } = require("../platform/doctor-fix");
const { runDoctorCommand, parseDoctorArgs } = require("../platform/doctor-cli");
const { readNightly, readBackup } = require("../platform/schedules");
const { aclWide, dateIso } = require("../platform/doctor-probes-ops");
const { fixture, writeNightlyFixtures, AT, EXPERIMENTAL_IMAGE, LOCAL_IMAGE } = require("./helpers/doctor-fixture");
const { createWorld } = require("./fixtures/platform/supervisor-world");

function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-doctor-ops-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
async function one(t, id, mutate, extra = {}) {
  const root = temporary(t), options = fixture(root);
  if (mutate) mutate(options, root);
  const report = await runDoctor({ ...options, ids: [id], ...extra });
  assert.equal(report.checks.length, 1, id);
  return { check: report.checks[0], options, root, report };
}
// The fixture world misses only the pinned image; these tests need the others missing.
const missingOthers = (options) => { options.probes.images = (rows) => rows.map((row) => ({ image: row.image, present: ![EXPERIMENTAL_IMAGE, LOCAL_IMAGE].includes(row.image) })); };
const fixIds = (check) => collectFixes(check).map((fix) => fix.id);

// ---- schedules -------------------------------------------------------------------------------

test("nightly streak computes 30 from 30 BOM-prefixed CRLF reports", (t) => {
  const root = temporary(t);
  writeNightlyFixtures(root);
  const raw = fs.readFileSync(path.join(root, "artifacts", "nightly", "latest.json"));
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(raw.includes("\r\n"));
  const nightly = readNightly(root, { now: () => new Date(AT) });
  assert.equal(nightly.available, true);
  assert.equal(nightly.streak, 30);
  assert.equal(nightly.since, "2026-09-15");
  assert.equal(nightly.ok, false);
  assert.equal(nightly.passed, 5);
  assert.equal(nightly.failed, 2);
  assert.equal(nightly.trend.length, 30);
  assert.ok(nightly.trend[0].at < nightly.trend[29].at, "trend is oldest first");
  assert.equal(nightly.ageHours, 4.9);
});

test("nightly streak stops at the newest passing night and ignores corrupt files", (t) => {
  const root = temporary(t);
  writeNightlyFixtures(root, { nights: 5 });
  const directory = path.join(root, "artifacts", "nightly");
  // Make the 3rd newest night pass and plant a corrupt report between them.
  const names = fs.readdirSync(directory).filter((name) => /^\d{8}-\d{4}\.json$/.test(name)).sort().reverse();
  const third = path.join(directory, names[2]);
  fs.writeFileSync(third, `\uFEFF${JSON.stringify({ startedAt: "2026-10-12T03:00:00+00:00", finishedAt: "2026-10-12T03:05:00+00:00", ok: true, passed: 7, failed: 0 })}`);
  fs.writeFileSync(path.join(directory, "20261013-0359.json"), "{ not json");
  const nightly = readNightly(root, { now: () => new Date(AT) });
  assert.equal(nightly.streak, 2);
  assert.equal(nightly.since, "2026-10-13");
  assert.equal(readNightly(path.join(root, "missing")).available, false);
});

test("backup reader finds the newest manifest, strips the BOM and flags other formats", (t) => {
  const root = temporary(t);
  for (const [stamp, format] of [["20261012-0200", "local-ai-platform-backup-v2"], ["20261013-0200", "old-format"]]) {
    fs.mkdirSync(path.join(root, "backups", stamp), { recursive: true });
    fs.writeFileSync(path.join(root, "backups", stamp, "backup-manifest.json"), `\uFEFF${JSON.stringify({ format, at: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T02:00:00.0000000+00:00`, files: [1, 2], warnings: [] })}`);
  }
  const backup = readBackup(root, { now: () => new Date(AT) });
  assert.equal(backup.stamp, "20261013-0200");
  assert.equal(backup.formatOk, false);
  assert.equal(backup.ageHours, 30);
  assert.equal(backup.files, 2);
  assert.equal(readBackup(path.join(root, "nothing")).available, false);
});

test("PowerShell 5.1 and 7 date forms parse and icacls output is classified", () => {
  assert.equal(dateIso("\\/Date(1791947100000)\\/"), "2026-10-14T03:05:00.000Z");
  assert.equal(dateIso("2026-10-14T03:05:00.0000000+00:00"), "2026-10-14T03:05:00.000Z");
  assert.equal(dateIso(null), null);
  assert.equal(aclWide("file DESKTOP\\owner:(F)\n     NT AUTHORITY\\SYSTEM:(F)"), false);
  assert.equal(aclWide("file DESKTOP\\owner:(F)\n     BUILTIN\\Users:(RX)"), true);
  assert.equal(aclWide("file Everyone:(R)"), true);
});

// ---- ops checks ------------------------------------------------------------------------------

test("ops.nightly: fail at streak 30, warn when failing under 3, warn when stale, ok when passing", async (t) => {
  const failing = await one(t, "ops.nightly");
  assert.equal(failing.check.status, "fail");
  assert.equal(failing.check.data.streak, 30);
  assert.equal(failing.check.data.since, "2026-09-15");
  assert.equal(failing.check.fix.risk, "manual");
  assert.equal((await one(t, "ops.nightly", (o) => { o.probes.nightly = { available: true, ok: false, passed: 5, failed: 1, ageHours: 3, streak: 2, since: "2026-10-13", trend: [] }; })).check.status, "warn");
  assert.equal((await one(t, "ops.nightly", (o) => { o.probes.nightly = { available: true, ok: true, passed: 7, failed: 0, ageHours: 40, streak: 0, since: null, trend: [] }; })).check.status, "warn");
  const passing = await one(t, "ops.nightly", (o) => { o.probes.nightly = { available: true, ok: true, passed: 7, failed: 0, ageHours: 3, streak: 0, since: null, trend: [] }; });
  assert.equal(passing.check.status, "ok");
  assert.equal((await one(t, "ops.nightly", (o) => { o.probes.nightly = { available: false }; })).check.status, "info");
});

test("ops checks: backup, drift, version, updates, config, shadowing and logs", async (t) => {
  assert.equal((await one(t, "ops.backup")).check.status, "ok");
  assert.equal((await one(t, "ops.backup", (o) => { o.probes.backup = { available: true, ageHours: 40, formatOk: true }; })).check.status, "warn");
  assert.equal((await one(t, "ops.backup", (o) => { o.probes.backup = { available: true, ageHours: 2, formatOk: false }; })).check.status, "warn");
  const drift = await one(t, "ops.deploy-drift");
  assert.equal(drift.check.status, "warn");
  assert.equal(drift.check.data.count, 1);
  assert.equal(drift.check.fix.risk, "manual");
  assert.equal((await one(t, "ops.deploy-drift", (o) => { o.isWorktree = true; })).check.status, "skip");
  assert.equal((await one(t, "ops.deploy-drift", (o) => { o.probes.drift = []; })).check.status, "ok");
  assert.equal((await one(t, "ops.version", (o) => { o.probes.version = { source: "git" }; })).check.status, "info");
  assert.equal((await one(t, "ops.updates")).check.data.behind, 2);
  assert.equal((await one(t, "ops.updates", (o) => { o.probes.newerCommits = { available: false, behind: 0 }; })).check.status, "ok");
  assert.equal((await one(t, "ops.updates", (o) => { o.probes.newerCommits = { available: false, behind: null, error: { code: "repo_missing" } }; })).check.status, "info");
  const bad = await one(t, "ops.config", (o) => { o.config = { ...o.config, errors: [{ field: "$file", code: "parse_error" }] }; });
  assert.equal(bad.check.status, "fail");
  const shadow = await one(t, "ops.config-shadowed", (o) => { o.config = { ...o.config, sources: { "listeners.admin.port": "env" }, envSet: { "listeners.admin.port": ["SERVICE_ENTRY_PORT"] } }; o.probes.userEnvNames = ["service_entry_port"]; });
  assert.equal(shadow.check.status, "warn");
  assert.equal(shadow.check.data.shadowed[0].inUserEnvironment, true);
  assert.equal(shadow.check.fix.risk, "confirm");
  const logs = await one(t, "ops.logs-size", (o) => { o.probes.logsSize = { bytes: 3 * 1024 ** 3, files: 9 }; });
  assert.equal(logs.check.status, "warn");
  assert.equal(logs.check.fix.id, "prune-rotated-logs");
  assert.equal(logs.check.fix.risk, "auto");
});

test("ops.supervisor and ops.autostart show commands and never register anything", async (t) => {
  const stopped = await one(t, "ops.supervisor");
  assert.equal(stopped.check.status, "info");
  assert.equal(stopped.check.fix.command, "platform start");
  assert.equal((await one(t, "ops.supervisor", (o) => { o.probes.supervisor = { running: true }; })).check.status, "ok");
  const none = await one(t, "ops.autostart");
  assert.equal(none.check.status, "info");
  assert.equal(none.check.fix.command, "platform autostart enable");
  assert.equal(none.check.fix.risk, "manual");
  const matching = await one(t, "ops.autostart", (o, root) => { o.probes.tasks = [{ name: "LocalAIPlatform", state: "Ready", actions: [{ execute: "conhost.exe", arguments: `--headless node "${root}\\scripts\\platformctl.js" supervise` }] }]; });
  assert.equal(matching.check.status, "ok");
  const stale = await one(t, "ops.autostart", (o) => { o.probes.tasks = [{ name: "LocalAIPlatform", state: "Ready", actions: [{ execute: "conhost.exe", arguments: "--headless node \"D:\\Elsewhere\\scripts\\platformctl.js\"" }] }]; });
  assert.equal(stale.check.status, "warn");
  const viaRunKey = await one(t, "ops.autostart", (o, root) => { o.probes.runKeys = { LocalAIPlatform: `node "${root}/scripts/platformctl.js"` }; });
  assert.equal(viaRunKey.check.data.method, "run-key");
});

// ---- network checks --------------------------------------------------------------------------

test("net.manager-bind: stale wildcard warns with an idle restart, chosen wildcard is info", async (t) => {
  const bound = await one(t, "net.manager-bind");
  assert.equal(bound.check.status, "ok");
  const stale = await one(t, "net.manager-bind", (o) => { o.probes.listeners = [{ protocol: "tcp", address: "0.0.0.0", port: 5177, pid: 4101 }, { protocol: "tcp", address: "127.0.0.1", port: 5178, pid: 4102 }]; });
  assert.equal(stale.check.status, "warn");
  assert.equal(stale.check.fix.id, "restart:vllm-manager");
  assert.equal(stale.check.fix.risk, "confirm");
  assert.equal(stale.check.fix.when, "idle");
  assert.deepEqual(fixIds(stale.check), ["restart:vllm-manager"]);
  const chosen = await one(t, "net.manager-bind", (o) => {
    o.config = { ...o.config, values: { ...o.config.values, "managers.vllm.host": "0.0.0.0" } };
    o.probes.listeners = [{ protocol: "tcp", address: "::", port: 5177, pid: 4101 }];
  });
  assert.equal(chosen.check.status, "info");
  const none = await one(t, "net.manager-bind", (o) => { o.probes.listeners = []; });
  assert.equal(none.check.status, "skip");
});

test("net.search-upstream follows the hook order and probes the container only when deep", async (t) => {
  const calls = [];
  const setting = await one(t, "net.search-upstream", (o) => { o.probes.searchUpstream = (request) => { calls.push(request); return { reachable: true }; }; });
  assert.equal(setting.check.status, "ok");
  assert.equal(setting.check.data.source, "setting");
  assert.equal(calls.length, 0, "no container probe in a non-deep run");
  const clear = (o) => { o.config = { ...o.config, values: { ...o.config.values, "search.upstreamBaseUrl": "" } }; };
  const none = await one(t, "net.search-upstream", clear);
  assert.equal(none.check.status, "warn");
  assert.equal(none.check.data.reason, "search-upstream-unreachable");
  assert.equal(none.check.fix.risk, "manual");
  const viaAdmin = await one(t, "net.search-upstream", (o) => { clear(o); o.config.values["listeners.admin.lan"] = true; });
  assert.equal(viaAdmin.check.data.source, "admin-lan");
  const viaPublic = await one(t, "net.search-upstream", (o) => { clear(o); o.config.values["listeners.public.enabled"] = true; o.probes.secretNames = [{ namespace: "platform", name: "search.upstreamApiKey" }]; });
  assert.equal(viaPublic.check.data.source, "public");
  assert.match(viaPublic.check.data.url, /host\.docker\.internal:5186\/v1$/);
  const viaManager = await one(t, "net.search-upstream", (o) => { clear(o); o.config.values["managers.vllm.host"] = "0.0.0.0"; });
  assert.equal(viaManager.check.data.source, "vllm-manager");
  const deepOk = await one(t, "net.search-upstream", (o) => { o.deep = true; o.probes.searchUpstream = (request) => { calls.push(request); return { reachable: true }; }; });
  assert.equal(deepOk.check.status, "ok");
  assert.deepEqual(calls, [{ host: "host.docker.internal", port: 5186 }]);
  const unreachable = await one(t, "net.search-upstream", (o) => { o.deep = true; o.probes.searchUpstream = { reachable: false }; });
  assert.equal(unreachable.check.status, "warn");
  const missing = await one(t, "net.search-upstream", (o) => { o.deep = true; o.probes.searchUpstream = { reachable: null, reason: "container_not_running" }; });
  assert.equal(missing.check.status, "info");
});

test("net.ports tells the component's own socket from a stale platform process and a foreign program", async (t) => {
  const stalePlatform = await one(t, "net.ports", (o, root) => {
    o.probes.listeners = [{ protocol: "tcp", address: "127.0.0.1", port: 5177, pid: 4999 }];
    o.probes.processes = [{ pid: 4999, exe: "C:/node/node.exe", commandLine: `node.exe ${root}/old-launcher/run.js`, processCreatedAt: "2026-10-13T06:00:00.000Z" }];
  });
  assert.equal(stalePlatform.check.status, "fail");
  assert.equal(stalePlatform.check.fix.id, "stop-orphan:5177");
  assert.equal(stalePlatform.check.fix.risk, "confirm");
  assert.equal(stalePlatform.check.fix.target.pid, 4999);
  const foreign = await one(t, "net.ports", (o) => {
    o.probes.listeners = [{ protocol: "tcp", address: "127.0.0.1", port: 5178, pid: 777 }];
    o.probes.processes = [{ pid: 777, exe: "C:/Games/server.exe", commandLine: "server.exe --port 5178", processCreatedAt: null }];
  });
  assert.equal(foreign.check.status, "fail");
  assert.equal(foreign.check.fix.risk, "manual");
  assert.equal((await one(t, "net.ports", (o) => { o.platform = "linux"; })).check.status, "skip");
});

test("net.ports does not fail a listener, a docker-owned port or a legacy launcher's process", async (t) => {
  const node = "C:/Program Files/nodejs/node.exe";
  const ok = await one(t, "net.ports", (o, root) => {
    o.probes.listeners = [
      { protocol: "tcp", address: "127.0.0.1", port: 5176, pid: 4100 }, { protocol: "tcp", address: "127.0.0.1", port: 5186, pid: 4100 },
      { protocol: "tcp", address: "127.0.0.1", port: 5177, pid: 4101 }, { protocol: "tcp", address: "127.0.0.1", port: 5178, pid: 4102 },
      { protocol: "tcp", address: "127.0.0.1", port: 5180, pid: 5000 },
    ];
    o.probes.identityRecords = [{ id: "entry", pid: 4100 }];
    o.probes.processes = [
      { pid: 4100, exe: node, commandLine: "node.exe server.js", processCreatedAt: null },
      // A legacy launcher: no identity record, relative script, same executable.
      { pid: 4101, exe: node, commandLine: "node.exe server.js", processCreatedAt: null },
      { pid: 4102, exe: node, commandLine: `"${node}" ${root}/llama-manager/server.js`, processCreatedAt: null },
      { pid: 5000, exe: "C:/Program Files/Docker/Docker/resources/com.docker.backend.exe", commandLine: "com.docker.backend.exe", processCreatedAt: null },
    ];
  });
  assert.equal(ok.check.status, "ok");
  assert.deepEqual(ok.check.data.ports.map((item) => item.owner), ["expected", "expected", "expected", "expected"]);
});

test("net.orphans, net.legacy-proxy and net.firewall", async (t) => {
  const orphan = await one(t, "net.orphans", (o, root) => {
    o.probes.processes = [...o.probes.processes, { pid: 6001, exe: "C:/node/node.exe", commandLine: `node.exe ${root}/scripts/old-job.js`, processCreatedAt: "2026-10-13T01:00:00.000Z" }, { pid: 6002, exe: "C:/python/python.exe", commandLine: "python other.py", processCreatedAt: null }];
  });
  assert.equal(orphan.check.status, "warn");
  assert.deepEqual(orphan.check.data.orphans.map((item) => item.pid), [6001]);
  assert.equal(orphan.check.fix.targets[0].pid, 6001);
  const stale = await one(t, "net.orphans", (o) => { o.probes.identityRecords = [...o.probes.identityRecords, { id: "entry", pid: 9999 }]; });
  assert.deepEqual(stale.check.data.stalePidFiles, [{ id: "entry", pid: 9999 }]);
  const proxy = await one(t, "net.legacy-proxy", (o) => {
    o.probes.listeners = [{ protocol: "tcp", address: "127.0.0.1", port: 8001, pid: 8800 }];
    o.probes.processes = [{ pid: 8800, exe: "C:/python/python.exe", commandLine: "python claude-vllm-anthropic-proxy.py", processCreatedAt: null }];
    o.probes.runKeys = { ClaudeVllmProxy: "python x" };
  });
  assert.equal(proxy.check.status, "warn");
  assert.equal(proxy.check.fix.risk, "manual");
  assert.match(proxy.check.fix.command, /^reg delete .*\\Run \/v ClaudeVllmProxy$/);
  const lanOn = (o) => { o.config = { ...o.config, values: { ...o.config.values, "listeners.admin.lan": true } }; };
  assert.equal((await one(t, "net.firewall")).check.status, "skip");
  const missing = await one(t, "net.firewall", lanOn);
  assert.equal(missing.check.status, "warn");
  assert.match(missing.check.fix.command, /New-NetFirewallRule .*-LocalPort 5176 .*-Profile Private/);
  const allowed = await one(t, "net.firewall", (o) => { lanOn(o); o.probes.firewall = [{ name: "x", profile: "Private", protocol: "TCP", localPort: "5176", program: "" }]; });
  assert.equal(allowed.check.status, "ok");
  const byProgram = await one(t, "net.firewall", (o) => { lanOn(o); o.probes.firewall = [{ name: "node", profile: "Any", protocol: "Any", localPort: "Any", program: "C:\\Program Files\\nodejs\\node.exe" }]; });
  assert.equal(byProgram.check.status, "ok");
});

// ---- security checks -------------------------------------------------------------------------

test("sec.secret-store: ok, acl-only warns, wide ACL fails with an auto fix, unreadable fails manual", async (t) => {
  const store = (extra) => [{ namespace: "runtime.vllm", file: ".runtime/secrets/runtime.vllm.json", protection: "dpapi-user", entries: 2, parse: "ok", unprotect: "ok", acl: { checked: true, wide: false }, ...extra }];
  assert.equal((await one(t, "sec.secret-store")).check.status, "ok");
  assert.equal((await one(t, "sec.secret-store", (o) => { o.probes.secretStores = []; })).check.status, "ok");
  const aclOnly = await one(t, "sec.secret-store", (o) => { o.probes.secretStores = store({ protection: "acl-only" }); });
  assert.equal(aclOnly.check.status, "warn");
  assert.equal(aclOnly.check.fix.risk, "manual");
  const wide = await one(t, "sec.secret-store", (o) => { o.probes.secretStores = store({ acl: { checked: true, wide: true } }); });
  assert.equal(wide.check.status, "fail");
  assert.equal(wide.check.fix.id, "secure-secret-files");
  assert.equal(wide.check.fix.risk, "auto");
  for (const broken of [{ parse: "error" }, { unprotect: "error" }]) {
    const unreadable = await one(t, "sec.secret-store", (o) => { o.probes.secretStores = store(broken); });
    assert.equal(unreadable.check.status, "fail");
    assert.equal(unreadable.check.fix.risk, "manual");
  }
  assert.ok(!JSON.stringify(wide.report).includes("value"), "no secret values in the report");
});

test("sec.plaintext-secrets: migratable files offer a confirm fix, the rest are manual", async (t) => {
  assert.equal((await one(t, "sec.plaintext-secrets", (o) => { o.probes.plaintextSecrets = []; })).check.status, "ok");
  const migratable = await one(t, "sec.plaintext-secrets");
  assert.equal(migratable.check.status, "warn");
  assert.equal(migratable.check.fix.id, "secrets-migrate");
  assert.equal(migratable.check.fix.risk, "confirm");
  const manual = await one(t, "sec.plaintext-secrets", (o) => { o.probes.plaintextSecrets = [{ path: "vllm-manager/logs/.last-public-service-key.txt", kind: "public-service-key", migratable: false }]; });
  assert.equal(manual.check.fix.risk, "manual");
});

test("sec.plaintext-secrets default scan finds the known files without reading their content", async (t) => {
  const root = temporary(t), { createDefaultProbes } = require("../platform/doctor");
  const write = (relative, text) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), text); };
  write("vllm-manager/logs/.last-public-service-key.txt", "sk-fake-not-a-real-key");
  write("llama-manager/logs/audit-admin-password.txt", "fake-password");
  write("vllm-manager/logs/runtime-api-keys.json", JSON.stringify({ version: 1, secrets: { "aaaaaaaa-1111": { secret: "fake-secret-value", createdAt: "2026-01-01" } } }));
  write("llama-manager/logs/runtime-api-keys.json", JSON.stringify({ version: 1, secrets: {}, migratedTo: "secret-store:runtime.llama" }));
  write(".runtime/platform-mcp/server.env", "PLATFORM_MCP_API_KEY=fake-key-value\r\n");
  write("config/custom-secrets.json", "{}");
  const probes = createDefaultProbes({ aiRoot: root, env: {}, platform: "win32", value: () => undefined });
  const found = await probes.plaintextSecrets();
  assert.deepEqual(found.map((item) => `${item.path}|${item.kind}|${item.migratable}`).sort(), [
    ".runtime/platform-mcp/server.env|env-file-key|true",
    "config/custom-secrets.json|secrets-file|false",
    "llama-manager/logs/audit-admin-password.txt|audit-admin-password|false",
    "vllm-manager/logs/.last-public-service-key.txt|public-service-key|false",
    "vllm-manager/logs/runtime-api-keys.json|runtime-keys|true",
  ]);
  assert.ok(!JSON.stringify(found).includes("fake-"));
});

test("sec.lan-keys and sec.public need keys and https", async (t) => {
  const lan = (o) => { o.config = { ...o.config, values: { ...o.config.values, "listeners.admin.lan": true } }; };
  assert.equal((await one(t, "sec.lan-keys")).check.status, "skip");
  assert.equal((await one(t, "sec.lan-keys", lan)).check.status, "ok");
  const noKey = await one(t, "sec.lan-keys", (o) => { lan(o); o.probes.keySummary = { available: true, active: 0, total: 1 }; });
  assert.equal(noKey.check.status, "fail");
  assert.equal(noKey.check.fix.link, "/c/keys");
  const off = await one(t, "sec.lan-keys", (o) => { lan(o); o.config.values["exposure.requireApiKey"] = "off"; });
  assert.equal(off.check.status, "fail");
  const publicOn = (url) => (o) => { o.config = { ...o.config, values: { ...o.config.values, "listeners.public.baseUrl": url } }; };
  assert.equal((await one(t, "sec.public")).check.status, "skip");
  assert.equal((await one(t, "sec.public", publicOn("https://api.example.test"))).check.status, "ok");
  const http1 = await one(t, "sec.public", publicOn("http://api.example.test"));
  assert.equal(http1.check.status, "fail");
  assert.match(http1.check.detail, /not https/);
});

// ---- fix runner ------------------------------------------------------------------------------

function spyChildProcess(t) {
  const calls = [];
  for (const name of ["execFile", "spawn", "exec", "execFileSync", "execSync", "spawnSync"]) {
    t.mock.method(childProcess, name, (...args) => { calls.push({ name, args }); throw new Error(`unexpected ${name}`); });
  }
  return calls;
}

function fakeManager(t, { jobSteps } = {}) {
  const requests = [];
  const steps = jobSteps || [{ status: "running", progress: 40 }, { status: "running", progress: 80 }, { status: "success", progress: 100 }];
  let polls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      if (req.method === "GET" && req.url === "/api/manager/health") return send(200, { ok: true });
      if (req.method === "POST" && /^\/api\/runtimes\/[^/]+\/pull$/.test(req.url)) return send(202, { ok: true, existing: false, job: { id: "dl_fake0001", status: "running", progress: 0 } });
      if (req.method === "GET" && req.url === "/api/jobs/dl_fake0001") { const step = steps[Math.min(polls, steps.length - 1)]; polls += 1; return send(200, { id: "dl_fake0001", logs: [{ message: `step ${polls}` }], ...step }); }
      return send(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    t.after(() => new Promise((done) => server.close(done)));
    resolve({ url: `http://127.0.0.1:${server.address().port}`, requests });
  }));
}

test("pull-image posts to the manager's pull endpoint, follows its job and never execs docker", async (t) => {
  const spies = spyChildProcess(t);
  const manager = await fakeManager(t);
  const root = temporary(t), options = fixture(root), lines = [], progress = [];
  missingOthers(options);
  const report = await runDoctor({ ...options, ids: ["runtime.images"] });
  const pull = collectFixes(report.checks[0]).find((fix) => fix.id === "pull-image:sglang@experimental");
  assert.equal(pull.risk, "confirm");
  assert.deepEqual(pull.apiCall, { method: "POST", path: "/api/runtimes/sglang%40experimental/pull", body: { confirm: true } });
  const result = await runFix({ checkId: "runtime.images", fixId: pull.id, confirm: true }, { ...options, managerUrl: () => manager.url, pollMs: 1, line: (text) => lines.push(text), progress: (value) => progress.push(value) });
  assert.equal(result.result.status, "success");
  assert.equal(result.result.jobId, "dl_fake0001");
  const post = manager.requests.find((request) => request.method === "POST");
  assert.equal(post.url, "/api/runtimes/sglang%40experimental/pull");
  assert.deepEqual(post.body, { confirm: true });
  assert.ok(manager.requests.filter((request) => request.url === "/api/jobs/dl_fake0001").length >= 3);
  assert.ok(lines.some((line) => line.startsWith("dl_fake0001: running 40%")));
  assert.deepEqual(progress.slice(-1), [1]);
  assert.equal(spies.length, 0, "no process was spawned: no `docker pull`");
});

test("pull-image starts a stopped manager first and reports a failed job", async (t) => {
  spyChildProcess(t);
  const manager = await fakeManager(t, { jobSteps: [{ status: "failed", progress: 10 }] });
  const root = temporary(t), options = fixture(root), started = [];
  missingOthers(options);
  let alive = false;
  const supervisor = { async startComponent(id) { started.push(id); alive = true; return { opId: "op_x" }; } };
  const realFetch = globalThis.fetch;
  const fetch = (url, init) => (!alive && String(url).endsWith("/api/manager/health") ? Promise.reject(new Error("ECONNREFUSED")) : realFetch(url, init));
  await assert.rejects(
    runFix({ checkId: "runtime.images", fixId: "pull-image:sglang@experimental", confirm: true }, { ...options, supervisor, fetch, managerUrl: () => manager.url, pollMs: 1 }),
    (error) => error.code === "pull_failed",
  );
  assert.deepEqual(started, ["vllm-manager"]);
});

test("manual fixes are never executed, even with confirm, yes and a prompt", async (t) => {
  const root = temporary(t), options = fixture(root);
  missingOthers(options);
  const spy = t.mock.fn(async () => ({}));
  const executors = new Proxy({}, { get: () => spy, has: () => true });
  const prompt = t.mock.fn(async () => true);
  for (const [checkId, fixId] of [["runtime.images", "rebuild-image:sglang@local"], ["ops.deploy-drift", "deploy-drift-docs"], ["ops.nightly", "nightly-docs"]]) {
    await assert.rejects(
      runFix({ checkId, fixId, confirm: true, yes: true }, { ...options, executors, prompt }),
      (error) => error.code === "fix_manual_only" && error.status === 400 && "docs" in error.extra && "command" in error.extra,
    );
  }
  const proxyOptions = { ...options, probes: { ...options.probes, runKeys: { ClaudeVllmProxy: "x" } } };
  await assert.rejects(runFix({ checkId: "net.legacy-proxy", confirm: true }, { ...proxyOptions, executors }), (error) => error.code === "fix_manual_only" && /^reg delete/.test(error.extra.command));
  assert.equal(spy.mock.callCount(), 0);
  assert.equal(prompt.mock.callCount(), 0);
});

test("confirm fixes need confirm:true, --yes or an interactive yes; unknown fixes are rejected", async (t) => {
  const root = temporary(t), options = fixture(root);
  const calls = [];
  const executors = { "start-docker": async () => { calls.push("start-docker"); return { ready: true }; } };
  const body = { checkId: "runtime.docker-daemon", fixId: "start-docker" };
  await assert.rejects(runFix(body, { ...options, executors }), (error) => error.code === "confirm_required" && error.status === 400);
  assert.deepEqual(calls, []);
  const declined = t.mock.fn(async () => false);
  await assert.rejects(runFix(body, { ...options, executors, prompt: declined }), (error) => error.code === "confirm_required");
  assert.equal(declined.mock.callCount(), 1);
  assert.deepEqual(calls, []);
  await runFix({ ...body, confirm: true }, { ...options, executors });
  await runFix({ ...body, yes: true }, { ...options, executors });
  await runFix(body, { ...options, executors, prompt: async () => true });
  assert.equal(calls.length, 3);
  await assert.rejects(runFix({ checkId: "runtime.docker-daemon", fixId: "nope", confirm: true }, { ...options, executors }), (error) => error.code === "fix_unknown");
  await assert.rejects(runFix({ checkId: "env.node-version", confirm: true }, { ...options, executors }), (error) => error.code === "fix_unknown");
  await assert.rejects(runFix({ checkId: "no.such-check" }, { ...options, executors }), (error) => error.code === "check_unknown");
  await assert.rejects(runFix({}, { ...options, executors }), (error) => error.code === "invalid_check");
});

test("auto fixes run: mkdirs creates the platform folders, prune removes only old rotated logs", async (t) => {
  const root = temporary(t), options = fixture(root);
  options.probes.writable = (directories) => directories.map((directory) => ({ path: directory, writable: false, code: "ENOENT" }));
  await runFix({ checkId: "storage.writable", fixId: "mkdirs" }, options);
  for (const name of ["config", "logs", ".runtime"]) assert.ok(fs.statSync(path.join(root, name)).isDirectory());
  const stale = (AT_MS) => new Date(AT_MS);
  const atMs = Date.parse(AT), day = 86400000;
  const put = (relative, ageDays) => { const file = path.join(root, "logs", relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "x".repeat(10)); fs.utimesSync(file, stale(atMs - ageDays * day), stale(atMs - ageDays * day)); return file; };
  const oldRotated = put("platform/entry.out.1.log", 20), oldRotatedDeep = put("vllm/manager.2.log", 30), freshRotated = put("platform/entry.out.2.log", 1), current = put("platform/entry.out.log", 90), other = put("notes.txt", 90);
  options.probes.logsSize = { bytes: 3 * 1024 ** 3, files: 5 };
  const result = await runFix({ checkId: "ops.logs-size" }, options);
  assert.deepEqual(result.result, { deleted: 2, bytes: 20 });
  assert.ok(!fs.existsSync(oldRotated) && !fs.existsSync(oldRotatedDeep));
  for (const kept of [freshRotated, current, other]) assert.ok(fs.existsSync(kept), kept);
});

test("secure-secret-files re-applies the owner-only ACL to each namespace file", async (t) => {
  const root = temporary(t), options = fixture(root), secured = [];
  options.probes.secretStores = [{ namespace: "runtime.vllm", protection: "dpapi-user", entries: 1, parse: "ok", unprotect: "ok", acl: { checked: true, wide: true } }];
  const directory = path.join(root, ".runtime", "secrets");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "runtime.vllm.json"), "{}");
  fs.writeFileSync(path.join(directory, "hf.json"), "{}");
  const result = await runFix({ checkId: "sec.secret-store", fixId: "secure-secret-files" }, { ...options, secureFile: async (target, opts) => { secured.push([path.basename(target), opts.directory]); } });
  assert.equal(result.result.secured, 2);
  assert.deepEqual(secured.sort(), [["hf.json", false], ["runtime.vllm.json", false], ["secrets", true]]);
});

test("restart:<id> goes through the supervisor with when:idle; busy restarts queue", async (t) => {
  const root = temporary(t), options = fixture(root), calls = [];
  options.probes.listeners = [{ protocol: "tcp", address: "0.0.0.0", port: 5177, pid: 4101 }];
  const supervisor = { async restart(ids, opts) { calls.push({ ids, opts }); return { queued: ids, blockers: [{ kind: "launch" }] }; } };
  await assert.rejects(runFix({ checkId: "net.manager-bind", fixId: "restart:vllm-manager" }, { ...options, supervisor }), (error) => error.code === "confirm_required");
  assert.equal(calls.length, 0);
  const result = await runFix({ checkId: "net.manager-bind", fixId: "restart:vllm-manager", confirm: true }, { ...options, supervisor });
  assert.deepEqual(calls, [{ ids: ["vllm-manager"], opts: { when: "idle", reason: "doctor", wait: true } }]);
  assert.deepEqual(result.result.queued, ["vllm-manager"]);
  await assert.rejects(runFix({ checkId: "net.manager-bind", fixId: "restart:vllm-manager", confirm: true }, options), (error) => error.code === "supervisor_unavailable");
});

test("mcp-build on a running MCP is refused while busy and otherwise stops, builds and restarts it", async (t) => {
  const root = temporary(t), options = fixture(root), order = [];
  options.probes.mcpBuild = { exists: true, currentHash: "new", stampHash: "old", running: true };
  const gate = { idle: false, blockers: [{ kind: "requests", source: "entry" }] };
  const supervisor = {
    async describeComponent() { return { component: { state: "ready" } }; },
    async idle() { return gate; },
    async stopComponent(id) { order.push(`stop:${id}`); },
    async startComponent(id) { order.push(`start:${id}`); },
  };
  const execFile = (command, args, opts, callback) => { order.push(`exec:${args.at(-1)}`); fs.mkdirSync(path.join(root, "platform-mcp", "dist"), { recursive: true }); callback(null, "", ""); };
  const body = { checkId: "env.mcp-dist", fixId: "mcp-build", confirm: true };
  await assert.rejects(runFix(body, { ...options, supervisor, execFile }), (error) => error.code === "component_busy" && error.extra.blockers.length === 1);
  assert.deepEqual(order, [], "nothing was stopped or built while busy");
  gate.idle = true; gate.blockers = [];
  const result = await runFix(body, { ...options, supervisor, execFile });
  assert.equal(result.result.built, true);
  assert.deepEqual(order, ["stop:platform-mcp", "exec:npm run build", "start:platform-mcp"]);
  const stamp = JSON.parse(fs.readFileSync(path.join(root, "platform-mcp", "dist", ".build-stamp.json"), "utf8"));
  assert.match(stamp.srcSha256, /^[0-9a-f]{64}$/);
});

test("mcp-build on a stopped MCP needs no supervisor and does not start it", async (t) => {
  const root = temporary(t), options = fixture(root), order = [];
  options.probes.mcpBuild = { exists: true, currentHash: "new", stampHash: "old", running: false };
  const supervisor = {
    async describeComponent() { return { component: { state: "stopped" } }; },
    async idle() { order.push("idle"); return { idle: true, blockers: [] }; },
    async stopComponent() { order.push("stop"); },
    async startComponent() { order.push("start"); },
  };
  const execFile = (command, args, opts, callback) => { order.push("exec"); callback(null, "", ""); };
  await runFix({ checkId: "env.mcp-dist", fixId: "mcp-build" }, { ...options, supervisor, execFile });
  assert.deepEqual(order, ["exec"]);
});

test("stop-orphan kills only through an identity check", async (t) => {
  const root = temporary(t), options = fixture(root), killed = [];
  options.probes.listeners = [{ protocol: "tcp", address: "127.0.0.1", port: 5177, pid: 4999 }];
  options.probes.processes = [{ pid: 4999, exe: "C:/node/node.exe", commandLine: `node.exe ${root}/old/run.js`, processCreatedAt: "2026-10-13T06:00:00.000Z" }];
  const winproc = { async killTree(pid, { identity }) { killed.push({ pid, identity }); return identity.processCreatedAt ? { ok: true, stopped: true, reason: "killed-by-supervisor" } : { ok: false, reason: "identity-mismatch" }; } };
  const result = await runFix({ checkId: "net.ports", fixId: "stop-orphan:5177", confirm: true }, { ...options, winproc });
  assert.deepEqual(killed, [{ pid: 4999, identity: { pid: 4999, processCreatedAt: "2026-10-13T06:00:00.000Z", exe: "C:/node/node.exe" } }]);
  assert.equal(result.result.stopped.length, 1);
});

test("secrets-migrate imports runtime key files into the store and leaves the stub", async (t) => {
  const root = temporary(t), options = fixture(root);
  const legacy = path.join(root, "vllm-manager", "logs", "runtime-api-keys.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, secrets: { "aaaaaaaa-1111-2222": { secret: "fake-runtime-secret-value", createdAt: "2026-01-01T00:00:00Z" } } }));
  // A fake DPAPI keeps the test off Windows facilities: acl-only protection.
  const secretStore = require("../secret-store");
  const originalCreate = secretStore.createSecretStore;
  t.mock.method(secretStore, "createSecretStore", (opts) => originalCreate({ ...opts, dpapi: secretStore.createDpapi({ platform: "linux" }), acl: { async secure() {} } }));
  const result = await runFix({ checkId: "sec.plaintext-secrets", fixId: "secrets-migrate", confirm: true }, options);
  const stub = JSON.parse(fs.readFileSync(legacy, "utf8"));
  assert.deepEqual(result.result.migrated, ["vllm-manager/logs/runtime-api-keys.json"]);
  assert.equal(stub.migratedTo, "secret-store:runtime.vllm");
  assert.deepEqual(stub.secrets, {});
});

test("npm-ci reports itself unavailable until the deploy steps provide it", async (t) => {
  const root = temporary(t), options = fixture(root);
  options.probes.dependencyState = () => ({ installed: false, lockHash: "x", recordedHash: "y", versionsMatch: false });
  await assert.rejects(runFix({ checkId: "env.deps.vllm-manager", fixId: "npm-ci", confirm: true }, options), (error) => error.code === "fix_unavailable" && error.status === 501);
  let called = 0;
  await runFix({ checkId: "env.deps.vllm-manager", fixId: "npm-ci", confirm: true }, { ...options, executors: { "npm-ci": async () => { called += 1; } } });
  assert.equal(called, 1);
});

test("the supervisor's runFix validates before it starts an operation and streams the fix", async (t) => {
  const world = createWorld(t);
  const root = temporary(t), options = fixture(root);
  missingOthers(options);
  const supervisor = world.create({ createFixRunner: (runnerOptions) => createFixRunner({ ...options, ...runnerOptions, aiRoot: options.aiRoot, env: options.env, config: options.config, registry: options.registry, executors: { "start-docker": async (_ctx, io) => { io.line("fixture docker started"); return { ready: true }; } } }) });
  await assert.rejects(supervisor.runFix({ checkId: "runtime.docker-daemon", fixId: "start-docker" }), (error) => error.code === "confirm_required");
  await assert.rejects(supervisor.runFix({ checkId: "runtime.images", fixId: "rebuild-image:sglang@local", confirm: true }), (error) => error.code === "fix_manual_only");
  assert.deepEqual(await supervisor.operations(), []);
  const { opId } = await supervisor.runFix({ checkId: "runtime.docker-daemon", fixId: "start-docker", confirm: true });
  for (let i = 0; i < 50 && (await supervisor.operation(opId)).state === "running"; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const operation = await supervisor.operation(opId);
  assert.equal(operation.kind, "doctor-fix");
  assert.equal(operation.state, "ok");
  assert.ok(operation.log.includes("fixture docker started"));
});

// ---- CLI -------------------------------------------------------------------------------------

test("doctor CLI parses flags, prints manual fixes without running them and honours --yes", async (t) => {
  assert.equal(parseDoctorArgs(["--group", "ops,net"]).errors.length, 1);
  assert.deepEqual(parseDoctorArgs(["--group", "ops,network"]).groups, ["ops", "network"]);
  const parsed = parseDoctorArgs(["--fix=ops.logs-size", "--yes", "--deep", "--json"]);
  assert.deepEqual([parsed.fix, parsed.checkId, parsed.yes, parsed.deep, parsed.json], [true, "ops.logs-size", true, true, true]);
  const lines = [], errors = [];
  const io = { out: (text) => lines.push(text), err: (text) => errors.push(text) };
  assert.equal(await runDoctorCommand(["--bogus"], io), 2);
  const root = temporary(t), options = fixture(root), fixed = [];
  options.ids = ["ops.nightly", "sec.plaintext-secrets", "ops.deploy-drift"];
  const fixer = async (body) => { fixed.push(body); if (!body.confirm) throw Object.assign(new Error("x"), { code: "confirm_required" }); };
  const code = await runDoctorCommand(["--fix"], io, { options, fixer });
  assert.equal(code, 1, "the nightly streak still fails");
  assert.deepEqual(fixed, [{ checkId: "sec.plaintext-secrets", fixId: "secrets-migrate", confirm: false }]);
  assert.ok(lines.some((line) => line.startsWith("ops.deploy-drift: manual")));
  fixed.length = 0;
  await runDoctorCommand(["--fix", "--yes", "--json"], io, { options, fixer });
  assert.deepEqual(fixed, [{ checkId: "sec.plaintext-secrets", fixId: "secrets-migrate", confirm: true }]);
  const json = JSON.parse(lines.at(-1));
  assert.equal(json.schemaVersion, 1);
  assert.ok(json.fixes.some((entry) => entry.outcome === "manual"));
});
