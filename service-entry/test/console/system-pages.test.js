// CON-24b (07 §6.13, 06 §7, §10.2, §11): the pure parts of /system/doctor,
// /system/settings, /system/updates and /system/ops, run in Node with the real
// catalogs and the real describeEffectiveConfig(). Rendering, the fix flows,
// Save and Apply are covered in a browser by
// tests/frontend/console/console-system.spec.js (part 2).

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { mergeI18nAreas } = require("../../lib/console-routes.js");
const platformConfig = require("../../../manager-core/platform/config.js");
const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);

const catalogs = mergeI18nAreas(path.join(CONSOLE_DIR, "i18n")).catalogs;
const doctor = await load("routes/system/doctor-model.js");
const settings = await load("routes/system/settings-model.js");
const updates = await load("routes/system/updates-model.js");
const operation = await load("routes/system/operation.js");
const { buildFormModel, flattenFields } = await load("lib/schema-form-model.js");
const { createI18n } = await load("lib/i18n.js");

const pick = (value) => value["en-US"];
const label = (en, zh) => ({ "en-US": en, "zh-CN": zh });

// ---------------------------------------------------------------------------
// Doctor

function check(overrides = {}) {
  return { id: "runtime.docker-daemon", group: "runtime", status: "fail", title: label("Docker engine", "Docker 引擎"), detail: "not running", data: {}, durationMs: 412, fix: null, ...overrides };
}

test("doctor: a check is normalised, a group falls back to the id's first segment and an unknown status reads as info", () => {
  const row = doctor.normalizeCheck(check({ group: undefined, id: "net.ports", status: "from-the-future" }), pick);
  assert.equal(row.group, "network");
  assert.equal(row.status, "info");
  assert.equal(row.title, "Docker engine");
  assert.equal(doctor.normalizeCheck({ id: "sec.public" }, pick).group, "security");
  assert.equal(doctor.normalizeCheck({ id: "ops.nightly", title: "plain" }, pick).title, "plain");
  assert.equal(doctor.statusTone("fail"), "error");
  assert.equal(doctor.statusTone("skip"), "neutral");
  assert.equal(doctor.statusTone("???"), "unknown");
});

test("doctor: a fix that is not exactly auto or confirm is manual, so the console never runs what it does not understand", () => {
  assert.equal(doctor.fixRisk("auto"), "auto");
  assert.equal(doctor.fixRisk("confirm"), "confirm");
  assert.equal(doctor.fixRisk("manual"), "manual");
  assert.equal(doctor.fixRisk("dangerous"), "manual");
  assert.equal(doctor.fixRisk(undefined), "manual");
  const fix = (risk) => doctor.normalizeCheck(check({ fix: { id: "start-docker", risk, label: label("Start Docker Desktop", "启动 Docker Desktop"), command: "platform doctor --fix=runtime.docker-daemon", docs: "/docs/troubleshooting.md#docker" } }), pick);
  assert.equal(fix("whatever").fix.risk, "manual");
  assert.equal(fix("auto").fix.label, "Start Docker Desktop");
});

test("doctor: fixRequest sends nothing for a manual fix, asks for a confirmation on a confirm fix and sends confirm:true only then", () => {
  const withFix = (risk) => doctor.normalizeCheck(check({ fix: { id: "start-docker", risk, label: label("Fix", "修复") } }), pick);
  assert.equal(doctor.fixRequest(withFix("manual")), null);
  assert.equal(doctor.fixRequest(withFix("manual"), true), null);
  assert.equal(doctor.fixRequest(withFix("confirm"), false), null);
  assert.deepEqual(doctor.fixRequest(withFix("confirm"), true), { path: "/api/platform/doctor/fix", body: { checkId: "runtime.docker-daemon", fixId: "start-docker", confirm: true } });
  assert.deepEqual(doctor.fixRequest(withFix("auto")), { path: "/api/platform/doctor/fix", body: { checkId: "runtime.docker-daemon", fixId: "start-docker" } });
  assert.equal(doctor.fixRequest(check()), null);
});

test("doctor: checks group in the catalogue's order with failures first, and the summary counts every status", () => {
  const report = doctor.normalizeReport({
    at: "2026-10-16T01:00:00.000Z", durationMs: 800,
    checks: [
      check({ id: "ops.backup", group: "ops", status: "ok" }),
      check({ id: "env.node-version", group: "env", status: "ok" }),
      check({ id: "env.git", group: "env", status: "info" }),
      check({ id: "env.deps.vllm-manager", group: "env", status: "fail" }),
      check({ id: "x.odd", group: "zzz", status: "warn" }),
    ],
  }, pick);
  const groups = doctor.groupChecks(report.checks);
  assert.deepEqual(groups.map((group) => group.id), ["env", "ops", "zzz"]);
  assert.deepEqual(groups[0].checks.map((item) => item.status), ["fail", "ok", "info"].sort((a, b) => doctor.STATUSES.indexOf(a) - doctor.STATUSES.indexOf(b)));
  assert.deepEqual(report.summary, { fail: 1, warn: 1, ok: 2, info: 1, skip: 0 });
  assert.equal(report.durationMs, 800);
});

test("doctor degrade: a manager's tools/health keeps only the allowlisted request and copyable commands", () => {
  const rows = doctor.legacyChecks({
    ok: false,
    checks: [
      {
        id: "docker", label: "Docker", status: "fail", detail: "down", actions: ["start-docker", "evil"],
        actionDetails: [
          { id: "start-docker", kind: "api", method: "POST", path: "/api/docker/start", label: { zh: "启动 Docker", en: "Start Docker" } },
          { id: "evil", kind: "api", method: "POST", path: "/api/instances/x/stop", label: { zh: "x", en: "x" } },
          { id: "pull-image", kind: "command", command: "docker pull example/image:1", label: { zh: "复制拉取命令", en: "Copy pull command" } },
          { id: "odd", kind: "script", command: "rm -rf /", label: { zh: "x", en: "x" } },
        ],
      },
      { id: "gpu", label: "GPU", status: "ok", detail: "ok" },
    ],
  }, (value) => value.en);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tone, "error");
  assert.deepEqual(rows[0].actions.map((action) => [action.id, action.kind, action.path || action.command, action.label]), [
    ["start-docker", "api", "/docker/start", "Start Docker"],
    ["pull-image", "command", "docker pull example/image:1", "Copy pull command"],
  ]);
  assert.deepEqual(rows[1].actions, []);
});

// ---------------------------------------------------------------------------
// Settings

function describe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "con24b-"));
  try {
    const loaded = platformConfig.loadPlatformConfig({ aiRoot: dir, env: {} });
    return JSON.parse(JSON.stringify(platformConfig.describeEffectiveConfig(loaded, { includeSecrets: true })));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const description = describe();
const find = (key) => settings.itemsOf(description).find((item) => item.key === key);

test("settings: the real description becomes a catalog with one param per leaf and the right widgets", () => {
  const items = settings.itemsOf(description);
  assert.ok(items.length > 50);
  const catalog = settings.buildCatalog(description);
  assert.equal(catalog.params.length, items.length);
  assert.equal(new Set(catalog.params.map((param) => param.id)).size, items.length);
  const type = (key) => catalog.params.find((param) => param.id === key).type;
  assert.equal(type("listeners.admin.port"), "int");
  assert.equal(type("admin.legacyProxyGateway"), "enum");
  assert.equal(type("admin.extraHosts"), "list");
  assert.equal(type("components"), "json");
  const secret = items.find((item) => item.secret);
  assert.ok(secret, "the schema has a secret leaf");
  assert.equal(catalog.params.find((param) => param.id === secret.key).secret, true);
  assert.equal(settings.paramType({ type: ["integer", "null"] }), "int");
  assert.equal(settings.paramType({ type: "number" }), "float");
  assert.equal(settings.paramType({ type: "boolean" }), "bool");
});

test("settings: config mode shows every leaf with its source badge and never a secret value", async () => {
  const catalog = settings.buildCatalog(description);
  const plan = settings.buildPlan(description);
  const values = settings.overlayValues(description, {});
  const model = buildFormModel({ catalog, plan, values, mode: "config", locale: "en-US", level: "basic" });
  const fields = flattenFields(model);
  assert.equal(fields.length, catalog.params.length, "every leaf is visible at the basic level");
  assert.equal(model.counts.changed, 0, "the saved values are not edits");
  const port = fields.find((field) => field.id === "listeners.admin.port");
  assert.equal(port.effective.source, "default");
  assert.equal(port.changed, false);
  assert.equal(port.userValue, 5176);
  const secret = fields.find((field) => field.secret);
  assert.equal(secret.userValue, null);
  assert.equal(secret.effective.value, null);
  assert.equal(secret.secretState, "unchanged");
  for (const field of fields) assert.ok(field.effective.source === null || settings.SOURCES.includes(field.effective.source), `${field.id}: ${field.effective.source}`);
});

test("settings: an edit marks the field changed, keeps the saved value's badge and a null edit is not an edit", () => {
  const catalog = settings.buildCatalog(description);
  const plan = settings.buildPlan(description);
  const model = (edits) => buildFormModel({ catalog, plan, values: settings.overlayValues(description, edits), mode: "config", locale: "en-US", level: "basic" });
  const edited = flattenFields(model({ "listeners.admin.port": 6001 })).find((field) => field.id === "listeners.admin.port");
  assert.equal(edited.changed, true);
  assert.equal(edited.userValue, 6001);
  assert.equal(edited.effective.source, "default", "the badge names where the saved value came from");
  const same = flattenFields(model({ "listeners.admin.port": 5176 })).find((field) => field.id === "listeners.admin.port");
  assert.equal(same.changed, false);
  const cleared = flattenFields(model({ "listeners.admin.port": null })).find((field) => field.id === "listeners.admin.port");
  assert.equal(cleared.changed, false);
  assert.equal(cleared.userValue, null);
});

test("settings: only changed leaves are sent, secrets travel in their own map and null on a file leaf unsets it", () => {
  const withFile = { ...description, groups: description.groups.map((group) => ({ ...group, items: group.items.map((item) => (item.key === "listeners.admin.port" ? { ...item, source: "file", value: 5176 } : item)) })) };
  const secretKey = settings.itemsOf(description).find((item) => item.secret).key;
  const none = settings.collectChanges(withFile, { "listeners.admin.port": 5176 });
  assert.equal(none.count, 0);
  assert.equal(none.body, null);
  const changes = settings.collectChanges(withFile, {
    "listeners.admin.port": 6001,
    "admin.legacyProxyGateway": "serve",
    [secretKey]: "fake-secret-value",
    "no.such.leaf": 1,
  });
  assert.deepEqual(changes.body, { set: { "listeners.admin.port": 6001 }, secrets: { [secretKey]: "fake-secret-value" } });
  assert.equal(changes.count, 2);
  assert.deepEqual(settings.collectChanges(withFile, { [secretKey]: null }).body, { secrets: { [secretKey]: null } });
  assert.deepEqual(settings.collectChanges(withFile, { "listeners.admin.port": null }).body, { unset: ["listeners.admin.port"] });
  assert.equal(settings.collectChanges(description, { "listeners.admin.port": null }).body, null, "nothing to unset when the value is not from the file");
  assert.equal(settings.collectChanges(withFile, { [secretKey]: "" }).body, null, "an empty secret is nothing");
});

test("settings: a conflict lists the person's edits against the reloaded values and what changed elsewhere", () => {
  const bump = (source, key, value) => ({ ...source, groups: source.groups.map((group) => ({ ...group, items: group.items.map((item) => (item.key === key ? { ...item, value } : item)) })) });
  const base = description;
  const fresh = bump(bump(description, "listeners.admin.port", 5200), "admin.legacyProxyGateway", "reject");
  const rows = settings.conflictRows({ set: { "listeners.admin.port": 6001 }, unset: [] }, base, fresh, { pick, mineLabel: "Your edit", theirsLabel: "Changed elsewhere" });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.deepEqual([byKey["listeners.admin.port"].from, byKey["listeners.admin.port"].to, byKey["listeners.admin.port"].source], ["5200", "6001", "Your edit"]);
  assert.deepEqual([byKey["admin.legacyProxyGateway"].from, byKey["admin.legacyProxyGateway"].to, byKey["admin.legacyProxyGateway"].source], ["serve", "reject", "Changed elsewhere"]);
  assert.equal(rows.length, 2);
});

test("settings: restart targets expand '*' to the running components and merge without duplicates", () => {
  assert.deepEqual(settings.expandRestart(["entry", "*", "entry"], ["entry", "vllm-manager"]), ["entry", "vllm-manager"]);
  assert.deepEqual(settings.expandRestart(["*"], []), ["entry"]);
  assert.deepEqual(settings.runningIds([{ id: "a", state: "ready" }, { id: "b", state: "stopped" }, { id: "c", state: "backoff" }]), ["a", "c"]);
  assert.deepEqual(settings.mergePending(["entry"], ["entry", "tts"]), ["entry", "tts"]);
});

// ---------------------------------------------------------------------------
// Updates and ops

test("updates: newer commits read from the object or from a bare number, and a failed count says why", () => {
  assert.deepEqual(updates.newerCommits({ available: true, behind: 3, head: "a".repeat(40), deployed: "b".repeat(40) }), { behind: 3, available: true, head: "a".repeat(12), deployed: "b".repeat(12), error: "" });
  assert.equal(updates.newerCommits(0).available, false);
  assert.equal(updates.newerCommits(0).behind, 0);
  assert.equal(updates.newerCommits(2).available, true);
  const failed = updates.newerCommits({ available: false, behind: null, error: { code: "repo_missing", message: "x" } });
  assert.equal(failed.behind, null);
  assert.equal(failed.error, "repo_missing");
  assert.equal(updates.newerCommits(undefined).behind, null);
});

test("updates: the version document keeps commit, contentHash, newer commits and drift; deploys and pending restarts are lists", () => {
  const info = updates.normalizeVersion({
    version: "0.2.0", build: { commit: "2ad10e5ffe68abc", contentHash: "3f9c2a1b7d0e" }, node: "v24.1.0",
    packages: [{ dir: "service-entry", version: "1.0.0" }, { dir: "", version: "x" }],
    newerCommits: { available: true, behind: 4 }, drift: { count: 2, checkedAt: "2026-10-16T00:00:00.000Z" },
  });
  assert.equal(info.commit, "2ad10e5ffe68");
  assert.equal(info.contentHash, "3f9c2a1b7d0e");
  assert.equal(info.newer.behind, 4);
  assert.equal(info.drift.count, 2);
  assert.equal(info.packages.length, 1);
  const deploys = updates.normalizeDeploys({ deployments: [{ stamp: "20261015-1", commit: "abc", branch: "main", deployedAt: "2026-10-15T10:00:00.000Z", counts: { created: 1, updated: 2, unchanged: 3, pruned: 4 } }, "junk"] });
  assert.deepEqual(deploys.map((row) => [row.stamp, row.updated, row.pruned]), [["20261015-1", 2, 4]]);
  const pending = updates.normalizePending({ pendingRestarts: [{ id: "search", reason: "deploy", queuedAt: "2026-10-16T00:00:00.000Z", deadline: null }, { reason: "no id" }] });
  assert.deepEqual(pending.map((row) => row.id), ["search"]);
});

test("ops: the nightly trend is exactly 30 slots, oldest first, with missing days in front", () => {
  const trend = Array.from({ length: 12 }, (_, index) => ({ at: `2026-10-${String(index + 1).padStart(2, "0")}T02:00:00.000Z`, ok: index !== 5, passed: index !== 5 ? 20 : 17, failed: index !== 5 ? 0 : 3 }));
  const bars = updates.trendBars(trend);
  assert.equal(bars.length, 30);
  assert.equal(bars.filter((bar) => bar.state === "missing").length, 18);
  assert.equal(bars[18].state, "pass");
  assert.equal(bars[18 + 5].state, "fail");
  assert.equal(bars.at(-1).at, "2026-10-12T02:00:00.000Z");
  assert.equal(updates.trendBars(Array.from({ length: 45 }, () => ({ ok: true, passed: 1, failed: 0 }))).length, 30);
  assert.equal(updates.trendBars(undefined).length, 30);
  const heights = updates.barHeights(bars);
  assert.equal(heights.length, 30);
  assert.ok(heights.every((value) => value > 0 && value <= 100));
});

test("ops: schedules and the autostart status are read defensively", () => {
  const plan = updates.normalizeSchedules({
    nightly: { latest: { ok: false, passed: 17, failed: 3, at: "2026-10-12T02:00:00.000Z", ageHours: 5 }, trend: [], streak: 3, since: "2026-10-10" },
    backup: { latest: { stamp: "20261015", at: "2026-10-15T03:00:00.000Z", format: "backup/v1", formatOk: true, warnings: 0 }, ageHours: 21, files: 12 },
    tasks: { autostart: { method: "task", registered: true, pathMatches: true, state: "Ready" }, nightly: null },
  });
  assert.equal(plan.nightly.streak, 3);
  assert.equal(plan.nightly.since, "2026-10-10");
  assert.equal(plan.nightly.bars.length, 30);
  assert.equal(plan.backup.ageHours, 21);
  assert.equal(plan.backup.files, 12);
  assert.equal(updates.normalizeSchedules(null).nightly.latest, null);
  assert.equal(updates.normalizeAutostart(plan.tasks.autostart).status, "registered");
  assert.equal(updates.normalizeAutostart({ registered: true, pathMatches: false, method: "run-key" }).status, "stale");
  assert.equal(updates.normalizeAutostart(undefined).status, "none");
  assert.equal(updates.normalizeTask({ state: "Ready", lastTaskResult: 0, lastRunTime: "2026-10-15T00:00:00.000Z" }).lastResult, 0);
  assert.equal(updates.normalizeTask(null), null);
});

test("operation: the supervisor's operation is normalised and an unknown state keeps running", () => {
  const op = operation.normalizeOperation({ opId: "op_1", kind: "doctor-fix", state: "ok", progress: 1, log: ["a", "b"], result: { code: "x", message: "m" } });
  assert.equal(op.state, "ok");
  assert.equal(op.progress, 1);
  assert.deepEqual(op.log, ["a", "b"]);
  assert.equal(operation.normalizeOperation({ opId: "op_2", state: "weird", progress: 7 }).state, "running");
  assert.equal(operation.normalizeOperation({ opId: "op_2", progress: 7 }).progress, 1);
  assert.equal(operation.normalizeOperation({ operation: { opId: "op_3", state: "failed" } }).opId, "op_3");
  assert.equal(operation.normalizeOperation(null).state, "running");
  assert.equal(operation.normalizeOperation({ log: Array.from({ length: 30 }, (_, index) => String(index)) }).log.length, 8);
});

// ---------------------------------------------------------------------------
// Copy and modules

test("06 §11 copy: the keys the pages carry read as the contract says, in both languages", () => {
  const en = catalogs["en-US"];
  const zh = catalogs["zh-CN"];
  assert.equal(en["platform.updates.newer"], "{n} newer commits have not been deployed.");
  assert.equal(zh["platform.updates.newer"], "有 {n} 个新提交尚未部署。");
  assert.equal(en["platform.drift.found"], "{n} live files were edited by hand. The next deploy will refuse until they are ported.");
  assert.equal(en["platform.nightly.failing"], "The nightly check has failed {n} nights in a row (since {date}).");
  assert.equal(en["platform.settings.restartRequired"], "Restart required after saving: {components}");
  assert.equal(zh["platform.settings.restartRequired"], "保存后需重启：{components}");
  assert.equal(en["platform.fix.manual"], "Run this yourself on this machine. Copy the command below:");
  assert.equal(en["platform.autostart.howto"], "To start the platform at logon, run this on this machine: platform autostart enable");
  assert.equal(zh["platform.autostart.howto"], "开机自启需在本机终端运行：platform autostart enable");
  assert.equal(en["platform.p6.title"], "Requires backend component P6");
  assert.equal(zh["platform.p6.title"], "该功能需要后端组件 P6");
  assert.deepEqual(["env", "file", "default", "derived", "runtime"].map((id) => en[`platform.source.${id}`]), ["Environment", "Config file", "Default", "Derived", "This run"]);
  assert.deepEqual(["env", "file", "default", "derived", "runtime"].map((id) => zh[`platform.source.${id}`]), ["环境变量", "配置文件", "默认值", "推导", "本次运行"]);
  const i18n = createI18n({ locale: "en-US", catalog: en });
  assert.equal(i18n.t("platform.settings.changes", { count: 1 }), "1 unsaved change");
  assert.equal(i18n.t("platform.settings.changes", { count: 3 }), "3 unsaved changes");
});

test("the four pages are modules with a default component, and every backend source badge has copy", async () => {
  for (const file of ["doctor", "settings", "updates", "ops"]) {
    const module = await load(`routes/system/${file}.js`);
    assert.equal(typeof module.default, "function", file);
  }
  const form = await load("routes/system/settings-form.js");
  assert.equal(typeof form.SettingsForm, "function");
  for (const item of settings.itemsOf(description)) {
    const source = item.secret ? item.secret.source : item.source;
    if (settings.knownSource(source)) assert.ok(catalogs["en-US"][`platform.source.${source}`] && catalogs["zh-CN"][`platform.source.${source}`], source);
  }
});
