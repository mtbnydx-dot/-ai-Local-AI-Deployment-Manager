// CON-24 (07 §6.13, 06 §11): the pure parts of the System pages and the copy
// they carry, run in Node with the real catalogs. Rendering, the row actions,
// the Danger zone and the preferences are covered in a browser by
// tests/frontend/console/console-system.spec.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { mergeI18nAreas } = require("../../lib/console-routes.js");
const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);

const catalogs = mergeI18nAreas(path.join(CONSOLE_DIR, "i18n")).catalogs;
const model = await load("routes/system/model.js");
const nav = await load("routes/system/subnav.js");
const prefsPage = await load("routes/system/preferences.js");
const { createI18n } = await load("lib/i18n.js");
const { DEFAULT_PREFS, isValidPref } = await load("lib/prefs.js");
const { PlatformStatusGuard } = await load("lib/schemas.js");
const { check } = await load("lib/guards.js");

const pick = (value) => value["en-US"];
const STATES = ["ready", "starting", "unhealthy", "stopped", "failed", "backoff", "blocked", "not-installed", "external", "unknown", "disabled"];

function component(overrides = {}) {
  return {
    id: "vllm-manager", kind: "node", label: { "zh-CN": "vLLM 管理器", "en-US": "vLLM manager" }, desired: "running", state: "ready", owner: "supervisor",
    ports: [{ name: "admin", port: 5177, bind: "127.0.0.1" }], uptimeSec: 120, restarts: { count: 2, windowCount: 0 }, lastExit: null, pendingRestart: null,
    ...overrides,
  };
}

test("every 06 component state has a zh label, an en label and a badge tone", () => {
  for (const state of STATES) {
    assert.ok(catalogs["zh-CN"][`platform.state.${state}`], `zh ${state}`);
    assert.ok(catalogs["en-US"][`platform.state.${state}`], `en ${state}`);
    assert.ok(model.stateTone(state), state);
  }
  assert.equal(catalogs["en-US"]["platform.state.unknown"], "Unidentified");
  assert.equal(catalogs["en-US"]["platform.state.disabled"], "Off");
  assert.equal(model.knownState("surprising"), "unknown", "a state the catalog lacks never reads as healthy");
  assert.equal(model.stateTone("surprising"), "warn");
});

test("06 §11 copy: the Danger zone text, the busy refusal and the supervisor banner", () => {
  const zh = createI18n({ locale: "zh-CN", catalog: catalogs["zh-CN"] });
  const en = createI18n({ locale: "en-US", catalog: catalogs["en-US"] });
  assert.match(zh.t("platform.stopAll.confirm"), /输入 stop 确认。$/);
  assert.match(en.t("platform.stopAll.confirm"), /Type stop to confirm\.$/);
  assert.equal(en.t("platform.busy.refuse", { n: 2 }), "2 downloads or launches are in progress. Restarting now would interrupt them.");
  assert.equal(en.t("platform.action.restartWhenIdle"), "Restart when idle");
  assert.equal(zh.t("platform.action.restartWhenIdle"), "空闲后重启");
  assert.equal(en.t("platform.supervisor.missing"), "The supervisor is not running, so crashed components will not be restarted.");
  assert.equal(en.t("platform.portConflict", { port: "5177", image: "node.exe", pid: "41" }), "Port 5177 is in use by node.exe (PID 41).");
  assert.equal(en.t("platform.pending.restart", { component: "Entry" }), "Update deployed. Entry will restart when idle.");
});

test("the platform and prefs copy has no Han in en-US and the same keys in both locales", () => {
  const han = /\p{Script=Han}/u;
  for (const key of Object.keys(catalogs["en-US"])) {
    if (!/^(platform|prefs)\./.test(key)) continue;
    assert.equal(han.test(JSON.stringify(catalogs["en-US"][key])), false, key);
    assert.ok(key in catalogs["zh-CN"], `zh is missing ${key}`);
  }
  for (const key of Object.keys(catalogs["zh-CN"])) {
    if (/^(platform|prefs)\./.test(key)) assert.ok(key in catalogs["en-US"], `en is missing ${key}`);
  }
});

test("every literal key the System pages use has a zh and an en text", () => {
  const dir = path.join(CONSOLE_DIR, "routes", "system");
  const missing = [];
  for (const file of ["index.js", "preferences.js", "subnav.js", "logs.js"]) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    for (const match of source.matchAll(/\bt\("([\w.]+)"/g)) {
      for (const locale of ["zh-CN", "en-US"]) if (!(match[1] in catalogs[locale])) missing.push(`${locale} ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("platformRows read 06's status, localized labels included, and keep unknown states honest", () => {
  const status = { readiness: { overall: "ok", layers: [] }, components: [component(), component({ id: "x", label: undefined, state: "weird", ports: [{ port: 1 }, { port: 1 }, 7] })] };
  assert.equal(check(PlatformStatusGuard, status).ok, true);
  const [a, b] = model.platformRows(status, pick);
  assert.equal(a.label, "vLLM manager");
  assert.deepEqual(a.ports, [5177]);
  assert.equal(a.restartCount, 2);
  assert.equal(a.owner, "supervisor");
  assert.equal(b.label, "x");
  assert.equal(b.state, "unknown");
  assert.deepEqual(b.ports, [1, 7]);
  assert.deepEqual(model.platformRows({ components: [{ label: "no id" }] }, pick), []);
  assert.deepEqual(model.platformRows(null, pick), []);
});

test("the viewer redaction (no owner, ports, exit or pid) still makes a row, and a viewer gets no actions", () => {
  const redacted = { id: "entry", label: { "zh-CN": "统一入口", "en-US": "Entry" }, state: "ready", desired: "running", profile: "core", uptimeSec: 9, restarts: { count: 0 } };
  const [row] = model.platformRows({ components: [redacted] }, pick);
  assert.equal(row.owner, null);
  assert.deepEqual(row.ports, []);
  assert.equal(row.lastExit, null);
  assert.deepEqual(model.actionsFor(row, { owner: false }), []);
  assert.deepEqual(model.actionsFor(null, { owner: true }), []);
});

test("row actions follow the state; the entry has no Stop; detect-only components have none", () => {
  const row = (overrides) => model.platformRow(component(overrides), pick);
  assert.deepEqual(model.actionsFor(row({ state: "ready" }), { owner: true }), ["restart", "restartIdle", "stop", "logs"]);
  assert.deepEqual(model.actionsFor(row({ state: "stopped" }), { owner: true }), ["start", "logs"]);
  assert.deepEqual(model.actionsFor(row({ state: "failed" }), { owner: true }), ["start", "logs"]);
  assert.deepEqual(model.actionsFor(row({ state: "blocked" }), { owner: true }), ["start", "logs"]);
  assert.deepEqual(model.actionsFor(row({ state: "backoff" }), { owner: true }), ["restart", "restartIdle", "stop", "logs"]);
  assert.deepEqual(model.actionsFor(row({ state: "starting" }), { owner: true }), ["stop", "logs"]);
  assert.deepEqual(model.actionsFor(row({ id: "entry", state: "ready" }), { owner: true }), ["restart", "restartIdle", "logs"]);
  assert.deepEqual(model.actionsFor(row({ state: "external" }), { owner: true }), []);
  assert.deepEqual(model.actionsFor(row({ state: "not-installed" }), { owner: true }), []);
  assert.deepEqual(model.actionsFor(row({ kind: "external", state: "ready" }), { owner: true }), []);
});

test("action requests: Restart is {when:now}, Restart when idle is {when:idle}, Stop confirms", () => {
  const row = model.platformRow(component(), pick);
  assert.deepEqual(model.actionRequest(row, "restart"), { path: "/api/platform/components/vllm-manager/restart", body: { when: "now" } });
  assert.deepEqual(model.actionRequest(row, "restartIdle"), { path: "/api/platform/components/vllm-manager/restart", body: { when: "idle" } });
  assert.deepEqual(model.actionRequest(row, "start"), { path: "/api/platform/components/vllm-manager/start", body: {} });
  assert.deepEqual(model.actionRequest(row, "stop"), { path: "/api/platform/components/vllm-manager/stop", body: { confirm: true } });
  assert.equal(model.actionRequest(row, "logs"), null);
  assert.equal(model.actionRequest({ ...row, id: "a/b" }, "start").path, "/api/platform/components/a%2Fb/start");
});

test("a 409 component_busy lists its blockers; an unknown kind reads as unknown", () => {
  const error = { code: "component_busy", details: { blockers: [{ kind: "download", title: "Qwen", source: "hub", id: "d1" }, { kind: "mystery", title: "?" }, "junk"] } };
  const blockers = model.blockersOf(error);
  assert.deepEqual(blockers.map((item) => [item.kind, item.title]), [["download", "Qwen"], ["unknown", "?"]]);
  assert.deepEqual(model.blockersOf({ details: null }), []);
  assert.deepEqual(model.blockersOf(null), []);
  for (const kind of ["launch", "download", "migration", "benchmark", "requests", "loading", "unknown"]) assert.ok(catalogs["en-US"][`platform.blocker.${kind}`], kind);
});

test("supervisorMissing: a stopped supervisor or a probe-only status", () => {
  assert.equal(model.supervisorMissing({ supervisor: { running: false } }), true);
  assert.equal(model.supervisorMissing({ mode: "probe" }), true);
  assert.equal(model.supervisorMissing({ mode: "supervised", supervisor: { running: true } }), false);
  assert.equal(model.supervisorMissing(undefined), false);
});

test("port conflicts and deploy restarts", () => {
  const conflict = model.platformRow(component({ state: "blocked", reason: "port-conflict", blocked: { port: 5177, pid: 41, imageName: "node.exe" } }), pick);
  assert.deepEqual(model.portConflictOf(conflict), { port: 5177, pid: 41, image: "node.exe" });
  assert.equal(model.portConflictOf(model.platformRow(component(), pick)), null);
  assert.equal(model.isDeployRestart({ reason: "deploy" }), true);
  assert.equal(model.isDeployRestart({ reason: "requested" }), false);
});

test("pre-P6 degrade: /api/status rows, manager start and stop only, the start command for the rest", () => {
  const status = {
    ok: false,
    components: { items: [
      { id: "vllm", name: "vLLM 管理器", kind: "manager", online: true, healthy: true, startable: true, startCommand: "platform start vllm-manager", error: "" },
      { id: "llama", name: "llama.cpp 管理器", kind: "manager", online: false, healthy: false, startable: true, startCommand: "platform start llama-manager", error: "" },
      { id: "tts", name: "TTS", kind: "tts", online: false, healthy: false, startable: false, startCommand: "platform start tts", error: "boom" },
      { id: "mcp", name: "MCP", kind: "mcp", online: true, healthy: false, startable: false, startCommand: "platform start mcp", error: "" },
      { name: "no id" },
    ] },
  };
  const rows = model.degradeRows(status);
  assert.deepEqual(rows.map((row) => [row.id, row.state, row.degraded]), [["vllm", "ready", true], ["llama", "stopped", true], ["tts", "stopped", true], ["mcp", "unhealthy", true]]);
  assert.deepEqual(model.actionsFor(rows[0], { owner: true }), ["stop"]);
  assert.deepEqual(model.actionsFor(rows[1], { owner: true }), ["start"]);
  assert.deepEqual(model.actionsFor(rows[2], { owner: true }), [], "a component the entry cannot start has no button");
  assert.equal(rows[2].startCommand, "platform start tts");
  assert.equal(rows[1].startCommand, null, "a startable manager shows its button, not a command");
  assert.equal(rows[2].message, "boom");
  assert.deepEqual(model.actionRequest(rows[1], "start"), { path: "/api/managers/llama/start", body: undefined });
  assert.deepEqual(model.actionRequest(rows[0], "stop"), { path: "/api/managers/vllm/stop", body: undefined });
  assert.deepEqual(model.degradeRows({}), []);
});

test("the sub navigation shows a viewer the table and the preferences only", () => {
  assert.deepEqual(nav.systemPages(false).map((page) => page.id), ["components", "preferences"]);
  assert.deepEqual(nav.systemPages(true).map((page) => page.id), ["components", "doctor", "settings", "updates", "ops", "preferences"]);
  for (const page of nav.systemPages(true)) assert.ok(catalogs["en-US"][page.key] && catalogs["zh-CN"][page.key], page.key);
});

test("preferences: Reset covers every stored preference, and each default is a valid value", () => {
  assert.equal(typeof prefsPage.default, "function");
  assert.equal(prefsPage.notificationSupport({ isSecureContext: false, Notification: function Notification() {} }).supported, false);
  assert.equal(prefsPage.notificationSupport({}).supported, false);
  assert.deepEqual(prefsPage.notificationSupport({ isSecureContext: true, Notification: Object.assign(function Notification() {}, { permission: "denied" }) }), { supported: true, denied: true });
  assert.deepEqual(prefsPage.notificationSupport({ isSecureContext: true, Notification: Object.assign(function Notification() {}, { permission: "default" }) }), { supported: true, denied: false });
  for (const name of ["theme", "density", "notifyBrowser", "sidebar", "tableColumns", "locale"]) assert.equal(isValidPref(name, DEFAULT_PREFS[name]), true, name);
});
