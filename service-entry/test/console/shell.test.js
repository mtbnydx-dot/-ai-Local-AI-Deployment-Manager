// CON-6 (07 §4.4, §5, §3.3): the pure parts of the shell, run in Node. Rendering,
// focus, pairing and the event stream are covered in a browser by
// tests/frontend/console/console-shell.spec.js; here are the data tables and
// the helpers that decide behaviour (navigation, routes, notification store,
// strip model, palette commands, link interception).

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

const FIXTURES = path.resolve(CONSOLE_DIR, "..", "..", "tests", "fixtures", "console");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
const catalogs = mergeI18nAreas(path.join(CONSOLE_DIR, "i18n")).catalogs;

const nav = await load("data/nav.js");
const routesModule = await load("routes.js");
const { matchRoute } = await load("lib/router.js");
const { createI18n } = await load("lib/i18n.js");

// ---------------------------------------------------------------------------
// data/nav.js

test("nav has the four 07 §5 groups and twelve entries whose labels exist in both languages", () => {
  assert.deepEqual(nav.NAV_GROUPS.map((group) => group.id), ["operate", "insight", "serve", "platform"]);
  assert.deepEqual(nav.NAV_GROUPS.map((group) => group.items.length), [5, 3, 3, 1]);
  assert.equal(nav.NAV_ITEMS.length, 12);
  assert.equal(new Set(nav.NAV_ITEMS.map((item) => item.id)).size, 12);
  for (const locale of ["zh-CN", "en-US"]) {
    for (const group of nav.NAV_GROUPS) assert.ok(catalogs[locale][group.labelKey], `${locale} ${group.labelKey}`);
    for (const item of nav.NAV_ITEMS) {
      assert.ok(catalogs[locale][item.labelKey], `${locale} ${item.labelKey}`);
      assert.equal(item.labelKey, `shell.nav.${item.id}`);
    }
  }
  assert.deepEqual(nav.NAV_ITEMS.map((item) => item.path), [
    "/overview", "/deployments", "/models", "/engines", "/playground", "/observability", "/audit", "/alerts", "/access", "/billing", "/voice", "/system",
  ]);
});

test("nav locks owner-only entries for a viewer and sends a viewer to the readable sub-page", () => {
  const byId = (id) => nav.navItem(id);
  for (const id of ["models", "engines", "observability", "audit", "alerts", "billing"]) {
    assert.equal(nav.isLockedFor(byId(id), "viewer"), true, id);
    assert.equal(nav.isLockedFor(byId(id), "owner"), false, id);
  }
  for (const id of ["overview", "deployments", "playground", "voice", "system", "access"]) assert.equal(nav.isLockedFor(byId(id), "viewer"), false, id);
  assert.equal(nav.navHref(byId("access"), "viewer"), "/access/clients");
  assert.equal(nav.navHref(byId("access"), "owner"), "/access");
  assert.equal(nav.navHref(byId("system"), "viewer"), "/system");
  assert.equal(nav.navItem("nope"), null);
});

// ---------------------------------------------------------------------------
// routes.js

const { ROUTES, NOT_FOUND_ROUTE, FORBIDDEN_ROUTE } = routesModule;

test("every 07 §5 path is a route, names and paths are unique, and each page maps to its spec'd module file", () => {
  assert.equal(new Set(ROUTES.map((route) => route.name)).size, ROUTES.length);
  assert.equal(new Set(ROUTES.map((route) => route.path)).size, ROUTES.length);
  const expected = [
    "/overview", "/deployments", "/deployments/new", "/deployments/routing", "/deployments/vllm%3Aprimary",
    "/models", "/models/discover", "/models/downloads", "/models/storage", "/models/knowledge", "/models/library/e1", "/models/hub/hf/org/name",
    "/engines", "/engines/new", "/engines/external", "/engines/sglang", "/playground",
    "/observability", "/observability/performance", "/observability/traffic", "/observability/errors", "/observability/gpu", "/observability/models",
    "/observability/requests", "/observability/requests/req_1", "/observability/settings",
    "/audit", "/audit/conversations", "/audit/exports", "/audit/access-log", "/audit/settings", "/alerts",
    "/access", "/access/keys", "/access/keys/k_1", "/access/public", "/access/security", "/access/portal", "/access/clients", "/access/sessions",
    "/billing", "/voice", "/system", "/system/doctor", "/system/settings", "/system/updates", "/system/ops", "/system/preferences", "/system/ui-kit", "/setup",
  ];
  for (const pathname of expected) assert.ok(matchRoute(ROUTES, pathname), `${pathname} has a route`);
  assert.equal(matchRoute(ROUTES, "/deployments/new").route.name, "deployments.new", "static beats :fleetId");
  assert.equal(matchRoute(ROUTES, "/deployments/vllm%3Aprimary").params.fleetId, "vllm:primary");
  assert.equal(matchRoute(ROUTES, "/models/hub/hf/org/name").params.name, "name");
  assert.equal(matchRoute(ROUTES, "/overview/missing"), null);
  assert.equal(matchRoute(ROUTES, "/").route.redirect, "/overview");
  for (const route of ROUTES.filter((item) => !item.redirect)) {
    const source = route.load.toString();
    const file = /import\("\.\/(routes\/[\w\-/]+\.js)"\)/.exec(source)?.[1];
    assert.ok(file, `${route.name} loads a module under routes/`);
  }
});

test("routes name a sidebar section and a title that exist in the catalogs, and guard owner-only pages", () => {
  const sections = new Set(nav.NAV_ITEMS.map((item) => item.id));
  for (const route of ROUTES) {
    assert.ok(sections.has(route.section), `${route.name} section ${route.section}`);
    for (const locale of ["zh-CN", "en-US"]) assert.ok(catalogs[locale][route.titleKey], `${locale} ${route.titleKey} (${route.name})`);
  }
  const open = ROUTES.filter((route) => route.viewerReadable).map((route) => route.name).sort();
  assert.deepEqual(open, ["access.clients", "deployments", "deployments.detail", "overview", "playground", "system", "system.preferences", "system.ui-kit", "voice"]);
  for (const name of ["deployments.new", "models", "engines", "billing", "alerts", "audit", "observability", "access", "access.sessions", "setup", "system.doctor"]) {
    assert.equal(ROUTES.find((route) => route.name === name).ownerOnly, true, name);
  }
  for (const route of [NOT_FOUND_ROUTE, FORBIDDEN_ROUTE]) {
    assert.ok(catalogs["en-US"][route.titleKey]);
    assert.ok(fs.existsSync(path.join(CONSOLE_DIR, /import\("\.\/(routes\/[\w-]+\.js)"\)/.exec(route.load.toString())[1])));
  }
});

test("the shell's own pages are delivered and export a component", async () => {
  for (const file of ["routes/not-found.js", "routes/forbidden.js"]) assert.equal(typeof (await load(file)).default, "function", file);
  for (const [file, name] of Object.entries({
    "components/app-shell.js": "AppShell", "components/sidebar.js": "Sidebar", "components/topbar.js": "Topbar", "components/status-strip.js": "StatusStrip",
    "components/notification-center.js": "NotificationCenter", "components/command-palette.js": "CommandPalette", "components/connection-banner.js": "ConnectionBanner",
    "components/pairing-screen.js": "PairingScreen",
  })) assert.equal(typeof (await load(file))[name], "function", `${file} exports ${name}`);
});

// ---------------------------------------------------------------------------
// notification store

const { createNotificationStore, unreadCount, MAX_NOTIFICATIONS } = await load("components/notification-center.js");

function note(overrides = {}) {
  return { kind: "restore.offer", severity: "info", title: { zh: "标题", en: "Title" }, body: { zh: "正文", en: "Body" }, ...overrides };
}

test("the notification store validates, merges repeats inside 10 minutes and keeps 50", () => {
  const store = createNotificationStore({ now: () => Date.parse("2026-10-14T08:00:00Z") });
  assert.equal(store.push({ kind: "x" }), null, "an invalid payload is rejected");
  assert.equal(store.push(note({ action: { label: { zh: "点", en: "Go" }, href: "https://evil.example/" } })), null, "a cross-origin href is rejected");
  assert.equal(store.push(note({ action: { label: { zh: "点", en: "Go" }, apiCall: { method: "POST", path: "/gateway/x" } } })), null, "a non-/api apiCall is rejected");
  assert.equal(store.push(note({ action: { label: { zh: "点", en: "Go" }, href: "//evil.example" } })), null);
  assert.equal(store.push(note({ action: { label: { zh: "点", en: "Go" }, href: "/deployments", apiCall: { method: "POST", path: "/api/x" } } })), null, "an action carries exactly one of href and apiCall");

  const first = store.push(note({ dedupeKey: "a" }), "2026-10-14T08:00:00Z");
  const again = store.push(note({ dedupeKey: "a", title: { zh: "新标题", en: "New title" } }), "2026-10-14T08:09:00Z");
  assert.equal(store.list().length, 1);
  assert.equal(again.id, first.id);
  assert.equal(again.count, 2);
  assert.equal(again.title.en, "New title");
  const later = store.push(note({ dedupeKey: "a" }), "2026-10-14T08:25:00Z");
  assert.equal(store.list().length, 2, "after 10 minutes it is a new entry");
  assert.notEqual(later.id, first.id);

  // Without a dedupeKey, kind + href decide.
  const link = { label: { zh: "去", en: "Go" }, href: "/deployments" };
  const one = store.push(note({ kind: "k", action: link }), "2026-10-14T09:00:00Z");
  const two = store.push(note({ kind: "k", action: link }), "2026-10-14T09:01:00Z");
  const other = store.push(note({ kind: "k", action: { ...link, href: "/models" } }), "2026-10-14T09:01:30Z");
  assert.equal(two.id, one.id);
  assert.notEqual(other.id, one.id);

  const seen = [];
  store.subscribe((items) => seen.push(items.length));
  for (let index = 0; index < MAX_NOTIFICATIONS + 10; index += 1) store.push(note({ dedupeKey: `d${index}` }), "2026-10-14T10:00:00Z");
  assert.equal(store.list().length, MAX_NOTIFICATIONS);
  assert.equal(store.list()[0].key, `d:d${MAX_NOTIFICATIONS + 9}`, "newest first");
  assert.ok(seen.length >= MAX_NOTIFICATIONS);
  store.clear();
  assert.deepEqual(store.list(), []);
});

test("unreadCount counts entries newer than readAt", () => {
  const store = createNotificationStore();
  store.push(note({ dedupeKey: "1" }), "2026-10-14T08:00:00Z");
  store.push(note({ dedupeKey: "2" }), "2026-10-14T08:05:00Z");
  assert.equal(unreadCount(store.list(), null), 2);
  assert.equal(unreadCount(store.list(), "2026-10-14T08:02:00Z"), 1);
  assert.equal(unreadCount(store.list(), "2026-10-14T08:05:00Z"), 0);
  assert.equal(unreadCount(undefined, null), 0);
});

test("the events fixture notifications go through the store as the shell would", () => {
  const store = createNotificationStore();
  for (const event of fixture("events").filter((item) => item.type === "notification")) assert.ok(store.push(event.data, event.at), event.id);
  assert.equal(store.list().length, 2);
  assert.equal(store.list().find((item) => item.kind === "restore.offer").action.apiCall.path, "/api/platform/restore-models");
});

// ---------------------------------------------------------------------------
// status strip model

const strip = await load("components/status-strip.js");

test("the strip model reads the PlatformStatus fixture: five layers, 0 serving, its action", () => {
  const model = strip.buildStripModel({ platform: fixture("platform-status") });
  assert.equal(model.source, "platform");
  assert.equal(model.overall, "degraded");
  assert.equal(model.tone, "warn");
  assert.deepEqual(model.layers.map((layer) => layer.id), ["environment", "runtime", "components", "serving", "exposure"]);
  const serving = model.layers.find((layer) => layer.id === "serving");
  assert.deepEqual(serving.value, { kind: "count", n: 0 });
  assert.equal(serving.code, "no_model_serving");
  assert.equal(serving.tone, "warn");
  assert.equal(serving.action.id, "restore-models");
  assert.deepEqual(model.layers.find((layer) => layer.id === "exposure").value, { kind: "mode", mode: "local" });
  assert.deepEqual(model.layers.find((layer) => layer.id === "components").value, { kind: "ratio", ready: 5, total: 5 });
  assert.equal(model.layers.find((layer) => layer.id === "runtime").detail.startsWith("Docker"), true);
  assert.deepEqual(model.problems, []);
});

test("the strip model derives the same shape before 06: 0 routable instances read as no_model_serving", () => {
  const model = strip.buildStripModel({ status: fixture("status"), fleet: fixture("fleet") });
  assert.equal(model.source, "derived");
  assert.equal(model.overall, "degraded");
  const serving = model.layers.find((layer) => layer.id === "serving");
  assert.deepEqual(serving.value, { kind: "count", n: 0 });
  assert.equal(serving.code, "no_model_serving");
  assert.equal(serving.action, null);
  const ready = strip.buildStripModel({
    status: fixture("status"),
    fleet: { instances: [{ id: "a", lifecycleState: "ready", running: true, models: [{ id: "m" }] }, { id: "b", lifecycleState: "stopped" }] },
  });
  assert.equal(ready.overall, "ok");
  assert.deepEqual(ready.layers.find((layer) => layer.id === "serving").value, { kind: "count", n: 1 });
});

test("the strip model: loading is neutral, an unreachable entry is down, problems list unhealthy components", () => {
  assert.equal(strip.buildStripModel({ loading: true }).overall, "loading");
  assert.equal(strip.buildStripModel({ loading: true }).tone, "neutral");
  const down = strip.buildStripModel({});
  assert.equal(down.overall, "down");
  assert.equal(down.tone, "error");
  assert.equal(down.layers[0].code, "entry_unreachable");
  const platform = fixture("platform-status");
  platform.components.push({ id: "tts", state: "failed" }, { id: "mcp", state: "external" });
  assert.deepEqual(strip.buildStripModel({ platform }).problems, [{ id: "tts", state: "failed" }]);
  const offline = strip.buildStripModel({ status: { ...fixture("status"), components: { total: 2, offline: ["tts"], unhealthy: [], items: [] } }, fleet: fixture("fleet") });
  assert.deepEqual(offline.problems, [{ id: "tts", state: "stopped" }]);
});

test("the strip model's GPU and version chips", () => {
  const gpu = strip.gpuSummary({ gpus: [{ index: 0, util: 80, memUsedMb: 1024, memTotalMb: 2048 }, { index: 1, util: 40, memUsedMb: 1024, memTotalMb: 2048 }] });
  assert.equal(gpu.util, 60);
  assert.equal(gpu.usedMb, 2048);
  assert.equal(gpu.totalMb, 4096);
  assert.equal(strip.gpuSummary({ gpus: [] }), null);
  assert.equal(strip.gpuSummary(null), null);
  assert.equal(strip.gpuSummary({ gpus: [{ memTotalMb: 100 }] }).util, null);
  const model = strip.buildStripModel({ platform: fixture("platform-status"), build: { version: "0.2.0-git-2ad10e5ffe68", commit: "2ad10e5ffe68" }, newerCommits: 3 });
  assert.deepEqual(model.version, { label: "v0.2.0", commit: "2ad10e5", newer: true, newerCommits: 3 });
  assert.equal(strip.buildStripModel({ platform: fixture("platform-status"), build: { commit: "c0146a7d2f1e" } }).version.label, "c0146a7");
  assert.equal(strip.buildStripModel({ platform: fixture("platform-status") }).version, null);
});

test("layer text: serving.none for the code, platform.code.* otherwise, the server's detail last; action keys are camel-cased", () => {
  const en = createI18n({ locale: "en-US", catalog: catalogs["en-US"] });
  assert.equal(strip.layerDetail({ code: "no_model_serving", detail: "ignored" }, en), "The platform is up, but no model is serving yet.");
  assert.equal(strip.layerDetail({ code: "entry_unreachable" }, en), "The entry service does not answer.");
  assert.equal(strip.layerDetail({ code: "unheard_of", detail: "Docker 28" }, en), "Docker 28");
  assert.equal(strip.layerDetail({ code: null, detail: null }, en), null);
  assert.equal(strip.actionKey("restore-models"), "platform.action.restoreModels");
  assert.equal(strip.actionKey("start-supervisor"), "platform.action.startSupervisor");
  for (const id of ["restore-models", "start-supervisor"]) assert.ok(catalogs["zh-CN"][strip.actionKey(id)] && catalogs["en-US"][strip.actionKey(id)]);
});

test("the platform area carries 06 §11's strip copy in both languages", () => {
  const zh = catalogs["zh-CN"];
  const en = catalogs["en-US"];
  assert.equal(zh["platform.serving.none"], "平台已启动，但还没有模型在提供服务。");
  assert.equal(en["platform.serving.none"], "The platform is up, but no model is serving yet.");
  assert.deepEqual(["environment", "runtime", "components", "serving", "exposure"].map((id) => en[`platform.layer.${id}`]), ["Environment", "Runtime", "Components", "Model serving", "Exposure"]);
  assert.deepEqual(["environment", "runtime", "components", "serving", "exposure"].map((id) => zh[`platform.layer.${id}`]), ["环境", "运行时", "组件", "模型服务", "访问范围"]);
  const states = ["ready", "starting", "unhealthy", "stopped", "failed", "backoff", "blocked", "not-installed", "external", "unknown", "disabled"];
  assert.deepEqual(states.map((state) => en[`platform.state.${state}`]), ["Ready", "Starting", "Unhealthy", "Stopped", "Failed", "Retrying", "Blocked", "Not installed", "External", "Unidentified", "Off"]);
  assert.equal(zh["platform.action.restoreModels"], "启动上次的模型");
  assert.equal(en["platform.action.restoreModels"], "Start last used model");
});

test("the access area carries the 05 §5.2 pairing copy", () => {
  assert.equal(catalogs["zh-CN"]["pair.body"], "此浏览器尚未与本机控制台配对。请从平台启动器打开控制台（会自动配对），或在终端运行 {cmd}。");
  assert.equal(catalogs["en-US"]["pair.body"], "This browser is not paired with the console yet. Open the console from the platform launcher (pairs automatically) or run {cmd} in a terminal.");
  for (const key of ["pair.title", "pair.invalid", "pair.cmd", "pair.retry"]) assert.ok(catalogs["zh-CN"][key] && catalogs["en-US"][key], key);
});

// ---------------------------------------------------------------------------
// command palette

const palette = await load("components/command-palette.js");

function commandsFor(role, extra = {}) {
  const i18n = createI18n({ locale: "en-US", catalog: catalogs["en-US"] });
  const other = createI18n({ locale: "zh-CN", catalog: catalogs["zh-CN"] });
  return palette.buildCommands({ role, i18n, other, instances: fixture("fleet").instances, actions: { toggleTheme() {}, toggleLocale() {}, toggleDensity() {}, copyGateway() {}, ...extra } });
}

test("palette commands: an owner gets every page and the write actions, a viewer only what it may open", () => {
  const owner = commandsFor("owner");
  const viewer = commandsFor("viewer");
  const ids = (list) => list.map((command) => command.id);
  for (const id of ["page:overview", "page:models", "page:system", "page:sessions", "page:preferences", "action:new-deployment", "action:download-model", "action:doctor", "action:theme", "action:locale", "action:density", "action:copy-gateway", "deployment:vllm:primary"]) {
    assert.ok(ids(owner).includes(id), id);
  }
  assert.equal(owner.find((command) => command.id === "page:overview").href, "/overview");
  assert.equal(owner.find((command) => command.id === "deployment:vllm:primary").href, "/deployments/vllm%3Aprimary");
  for (const id of ["page:models", "page:engines", "page:billing", "page:sessions", "action:new-deployment", "action:download-model", "action:doctor"]) assert.equal(ids(viewer).includes(id), false, `viewer: ${id}`);
  for (const id of ["page:overview", "page:deployments", "page:access", "page:preferences", "action:theme"]) assert.ok(ids(viewer).includes(id), `viewer: ${id}`);
  assert.equal(viewer.find((command) => command.id === "page:access").href, "/access/clients");
  assert.equal(ids(commandsFor("owner", { copyGateway: null })).includes("action:copy-gateway"), false);
});

test("palette matching is fuzzy over both languages and aliases, and an empty query lists pages first", () => {
  const owner = commandsFor("owner");
  const top = (query) => palette.filterCommands(owner, query)[0]?.id;
  assert.equal(top("overview"), "page:overview");
  assert.equal(top("总览"), "page:overview", "the Chinese label of the English UI");
  assert.equal(top("暗色"), undefined);
  assert.equal(top("doctor"), "action:doctor");
  assert.equal(top("language"), "action:locale", "an alias");
  assert.equal(palette.filterCommands(owner, "zzzzqqqq").length, 0);
  const empty = palette.filterCommands(owner, "");
  assert.ok(empty.length <= 12);
  assert.equal(empty[0].group, "pages");
  const groups = empty.map((command) => command.group);
  assert.deepEqual(groups, [...groups].sort((a, b) => palette.GROUP_ORDER.indexOf(a) - palette.GROUP_ORDER.indexOf(b)));
});

// ---------------------------------------------------------------------------
// link interception and preferences

const shell = await load("components/app-shell.js");
const app = await load("app.js");

function click(href, { target, button = 0, modifiers = {}, download = false, defaultPrevented = false } = {}) {
  const link = {
    href: new URL(href, "https://console.test").href,
    target: target || "",
    getAttribute: (name) => (name === "href" ? href : null),
    hasAttribute: (name) => name === "download" && download,
  };
  return { button, defaultPrevented, ...modifiers, target: { closest: () => link } };
}

test("link clicks navigate in place only for plain same-origin clicks on console routes", () => {
  const origin = "https://console.test";
  assert.equal(shell.navigationTarget(click("/deployments?manager=vllm#x"), origin), "/deployments?manager=vllm#x");
  assert.equal(shell.navigationTarget(click("https://console.test/overview"), origin), "/overview");
  assert.equal(shell.navigationTarget(click("/overview", { modifiers: { ctrlKey: true } }), origin), null);
  assert.equal(shell.navigationTarget(click("/overview", { modifiers: { metaKey: true } }), origin), null);
  assert.equal(shell.navigationTarget(click("/overview", { button: 1 }), origin), null);
  assert.equal(shell.navigationTarget(click("/overview", { target: "_blank" }), origin), null);
  assert.equal(shell.navigationTarget(click("/overview", { download: true }), origin), null);
  assert.equal(shell.navigationTarget(click("/overview", { defaultPrevented: true }), origin), null);
  assert.equal(shell.navigationTarget(click("#main"), origin), null, "the skip link is left to the browser");
  assert.equal(shell.navigationTarget(click("https://other.test/overview"), origin), null);
  assert.equal(shell.navigationTarget(click("/classic"), origin), null);
  assert.equal(shell.navigationTarget(click("/billing/classic"), origin), null);
  assert.equal(shell.navigationTarget(click("/gateway/auto/openai/v1"), origin), null);
  assert.equal(shell.navigationTarget(click("/overview/unknown"), origin), null);
  assert.equal(shell.navigationTarget({ button: 0, target: { closest: () => null } }, origin), null);
  assert.equal(shell.isConsolePath("/system/ui-kit"), true);
  assert.equal(shell.isConsolePath("/api/status"), false);
});

test("documentPrefs reads what the server rendered into <html>", () => {
  const doc = (attrs) => ({ documentElement: { lang: attrs.lang, getAttribute: (name) => attrs[name] ?? null } });
  assert.deepEqual(app.documentPrefs(doc({ lang: "en-US", "data-theme": "dark", "data-density": "compact" })), { theme: "dark", density: "compact", locale: "en-US" });
  assert.deepEqual(app.documentPrefs(doc({ lang: "zh-CN", "data-density": "comfortable" })), { theme: "auto", density: "comfortable", locale: "zh-CN" });
  assert.deepEqual(app.documentPrefs(doc({ lang: "fr", "data-theme": "purple", "data-density": "huge" })), { theme: "auto", density: "comfortable", locale: "zh-CN" });
});

test("boot needs a root element and returns nothing without one", async () => {
  const doc = { getElementById: () => null };
  assert.equal(await app.boot({ doc, fetchImpl() {}, base: "file:///x/" }), null);
});
