// The smaller CON-4 libraries the 07 §13.1 table does not give a file of
// their own: preferences and storage (§3.8), URLs (§10), readiness
// (§4.4 StatusStrip), fuzzy matching (CommandPalette) and the audit unlock.

import assert from "node:assert/strict";
import test from "node:test";

import { createAuditSession } from "../../console/lib/audit-session.js";
import { fuzzyFilter, fuzzyScore } from "../../console/lib/fuzzy.js";
import { applyDensity, applyTheme, createPrefsStore, DEFAULT_PREFS, migrateLegacyPrefs, PREFS_KEY, prefsCookieValue, readPrefs, writePref } from "../../console/lib/prefs.js";
import { deriveReadiness, fleetInstanceLifecycle, isFleetRoutableInstance, LAYER_IDS, readinessFrom } from "../../console/lib/readiness.js";
import { createStorage } from "../../console/lib/storage.js";
import { buildQuery, isApiPath, isSameOriginPath, legacyUiHref, safeUrl, withQuery } from "../../console/lib/url.js";

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (name) => (data.has(name) ? data.get(name) : null),
    setItem: (name, value) => data.set(name, String(value)),
    removeItem: (name) => data.delete(name),
  };
}

function cookieDoc() {
  const doc = { written: [], cookie: "" };
  return new Proxy(doc, {
    set(target, name, value) {
      if (name === "cookie") {
        target.written.push(value);
        const [pair] = String(value).split(";");
        target.cookie = pair;
        return true;
      }
      target[name] = value;
      return true;
    },
  });
}

test("storage wraps every access: throwing or missing stores read as empty", () => {
  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); }, removeItem() { throw new Error("x"); } };
  const storage = createStorage({ local: throwing, session: () => {
    throw new Error("blocked");
  }, doc: { get cookie() { throw new Error("no cookies"); } } });
  assert.equal(storage.get("a"), null);
  assert.equal(storage.set("a", "1"), false);
  assert.equal(storage.remove("a"), false);
  assert.equal(storage.sessionGet("a"), null);
  assert.equal(storage.readCookie("x"), null);
  assert.equal(createStorage({ local: null, session: null, doc: null }).set("a", 1), false);

  const local = memoryStorage();
  const reader = createStorage({ local, doc: { cookie: "a=1; console_prefs=theme%3Adark" } });
  assert.equal(reader.readCookie("console_prefs"), "theme:dark");
  assert.equal(reader.readCookie("missing"), null);
  const doc = cookieDoc();
  const ok = createStorage({ local, session: memoryStorage(), doc });
  assert.equal(ok.set("k", "v"), true);
  assert.equal(ok.get("k"), "v");
  assert.equal(ok.writeCookie("n", "v", "Path=/"), true);
  assert.equal(doc.written.at(-1), "n=v; Path=/");
});

test("readPrefs validates every field and falls back to defaults", () => {
  const local = memoryStorage();
  const storage = createStorage({ local, doc: cookieDoc() });
  assert.deepEqual(readPrefs(storage), DEFAULT_PREFS);
  local.setItem(PREFS_KEY, JSON.stringify({ theme: "dark", locale: "fr", density: "compact", notifyBrowser: "yes", tableColumns: { fleet: ["name", "<x>"] }, notificationsReadAt: "2026-10-14T08:00:00Z", extra: 1 }));
  const prefs = readPrefs(storage);
  assert.equal(prefs.theme, "dark");
  assert.equal(prefs.locale, "auto");
  assert.equal(prefs.density, "compact");
  assert.equal(prefs.notifyBrowser, false);
  assert.deepEqual(prefs.tableColumns, {});
  assert.equal(prefs.notificationsReadAt, "2026-10-14T08:00:00Z");
  assert.equal("extra" in prefs, false);
  local.setItem(PREFS_KEY, "{not json");
  assert.deepEqual(readPrefs(storage), DEFAULT_PREFS);
});

test("writePref stores JSON and mirrors theme, locale and density into the server's cookie", () => {
  const local = memoryStorage();
  const doc = cookieDoc();
  const storage = createStorage({ local, doc });
  assert.equal(writePref(storage, "theme", "purple"), null);
  const prefs = writePref(storage, "locale", "en-US");
  assert.equal(prefs.locale, "en-US");
  assert.equal(JSON.parse(local.getItem(PREFS_KEY)).locale, "en-US");
  assert.equal(doc.written.at(-1), "console_prefs=theme:auto|locale:en-US|density:comfortable; Path=/; SameSite=Strict; Max-Age=31536000");
  writePref(storage, "tableColumns", { fleet: ["name", "state"] });
  assert.deepEqual(readPrefs(storage).tableColumns, { fleet: ["name", "state"] });
  assert.equal(prefsCookieValue({ theme: "dark", locale: "zh-CN", density: "x" }), "theme:dark|locale:zh-CN|density:comfortable");
});

test("migrateLegacyPrefs takes billingThemeMode once and ?theme=&lang= every time", () => {
  const local = memoryStorage();
  local.setItem("billingThemeMode", "dark");
  const storage = createStorage({ local, doc: cookieDoc() });
  assert.equal(migrateLegacyPrefs(storage, new URLSearchParams()).theme, "dark");
  writePref(storage, "theme", "light");
  assert.equal(migrateLegacyPrefs(storage, {}).theme, "light", "the legacy value is read once only");
  const fromBanner = migrateLegacyPrefs(storage, new URLSearchParams("theme=dark&lang=en"));
  assert.equal(fromBanner.theme, "dark");
  assert.equal(fromBanner.locale, "en-US");
  assert.equal(migrateLegacyPrefs(storage, { theme: "neon", lang: "xx" }).theme, "dark", "bad values are ignored");
});

test("createPrefsStore notifies on accepted changes only", () => {
  const store = createPrefsStore(createStorage({ local: memoryStorage(), doc: cookieDoc() }));
  const seen = [];
  const off = store.subscribe((all, name) => seen.push(`${name}=${all[name]}`));
  assert.equal(store.set("density", "compact"), true);
  assert.equal(store.set("density", "tiny"), false);
  off();
  store.set("sidebar", "collapsed");
  assert.deepEqual(seen, ["density=compact"]);
  assert.equal(store.get("sidebar"), "collapsed");
});

test("applyTheme sets or removes html[data-theme]; applyDensity allowlists", () => {
  const attrs = new Map();
  const doc = { documentElement: { setAttribute: (name, value) => attrs.set(name, value), removeAttribute: (name) => attrs.delete(name) } };
  applyTheme(doc, "dark");
  assert.equal(attrs.get("data-theme"), "dark");
  applyTheme(doc, "auto");
  assert.equal(attrs.has("data-theme"), false);
  applyDensity(doc, "huge");
  assert.equal(attrs.get("data-density"), "comfortable");
  applyTheme(null, "dark");
});

test("safeUrl allows http(s), relative and fragments only", () => {
  for (const ok of ["https://example.test/a", "/docs/x", "./a", "a/b", "#top", "?q=1", "HTTPS://example.test"]) assert.equal(safeUrl(ok), ok, ok);
  for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.test", "/\\evil", "java\nscript:x", "", null, 7]) {
    assert.equal(safeUrl(bad), null, String(bad));
  }
  assert.equal(isSameOriginPath("/a?b"), true);
  assert.equal(isSameOriginPath("//a"), false);
  assert.equal(isApiPath("/api/platform/restore?x=1"), true);
  assert.equal(isApiPath("/api/../gateway"), false);
  assert.equal(isApiPath("/apis/x"), false);
  assert.equal(buildQuery({ b: [1, 2], a: "x y", n: null }), "?a=x+y&b=1&b=2");
  assert.equal(withQuery("/a?z=1", { b: 2 }), "/a?z=1&b=2");
  assert.equal(withQuery("/a", {}), "/a");
});

test("legacyUiHref uses the page's own host, never a loopback literal", () => {
  assert.equal(legacyUiHref({ protocol: "http:", hostname: "192.0.2.10" }, 5177), "http" + "://192.0.2.10:5177/");
  assert.equal(legacyUiHref({ protocol: "https:", hostname: "box.test" }, 5178), "https://box.test:5178/");
  assert.equal(legacyUiHref({ protocol: "http:", hostname: "::1" }, 5177), "http" + "://[::1]:5177/");
  assert.equal(legacyUiHref({ protocol: "http:", hostname: "x" }, 70000), null);
});

test("fleetInstanceLifecycle mirrors the classic console rule", () => {
  assert.deepEqual(fleetInstanceLifecycle({ running: true, models: [{ id: "m" }] }), { key: "ready", routable: true });
  assert.equal(fleetInstanceLifecycle({ status: "Up 3 hours", models: [{ id: "m" }] }).key, "ready");
  assert.equal(fleetInstanceLifecycle({ running: true, models: [] }).key, "degraded");
  assert.equal(fleetInstanceLifecycle({ lifecycleState: "loading", running: true, models: [{ id: "m" }] }).key, "loading");
  assert.equal(fleetInstanceLifecycle({ status: "Exited (137) 2 minutes ago" }).key, "crashed");
  assert.equal(fleetInstanceLifecycle({ status: "Exited (0) 2 minutes ago" }).key, "stopped");
  assert.equal(fleetInstanceLifecycle({ status: "Up 1 hour (unhealthy)", models: [{ id: "m" }] }).key, "degraded");
  assert.equal(isFleetRoutableInstance({}), false);
});

test("deriveReadiness builds the five 06 layers from status and fleet", () => {
  const status = {
    ok: true,
    managers: [{ id: "vllm", ok: true }, { id: "llama", ok: false }],
    components: { total: 5, online: 4, offline: ["search"], unhealthy: [], items: [] },
    security: { exposure: "local", keyStore: { managersWithKeys: [] } },
  };
  const none = deriveReadiness({ status, fleet: { instances: [{ running: true, models: [] }] } });
  assert.deepEqual(none.layers.map((layer) => layer.id), LAYER_IDS);
  assert.equal(none.overall, "degraded");
  assert.equal(none.serving, 0);
  assert.deepEqual(none.layers.find((layer) => layer.id === "serving"), { id: "serving", status: "warn", code: "no_model_serving", counts: { ready: 0, total: 1 } });
  assert.equal(none.layers.find((layer) => layer.id === "components").status, "warn");

  const healthy = deriveReadiness({
    status: { ...status, components: { total: 5, offline: [], unhealthy: [] } },
    fleet: { instances: [{ running: true, models: [{ id: "m" }] }] },
  });
  assert.equal(healthy.overall, "ok");
  assert.equal(healthy.serving, 1);

  const lan = deriveReadiness({ status: { ...status, security: { exposure: "lan", keyStore: { managersWithKeys: [] } } }, fleet: { instances: [] } });
  assert.deepEqual(lan.layers.find((layer) => layer.id === "exposure"), { id: "exposure", status: "fail", mode: "lan", code: "no_active_key" });

  const down = deriveReadiness({ status: null });
  assert.equal(down.overall, "down");
  assert.equal(down.layers[0].status, "fail");

  const platform = { readiness: { overall: "ok", layers: [{ id: "environment", status: "ok" }] } };
  assert.equal(readinessFrom({ platform, status }).source, "platform");
  assert.equal(readinessFrom({ status, fleet: { instances: [] } }).source, "derived");
});

test("fuzzy matching ranks prefixes, then substrings, then scattered letters, over zh and en", () => {
  const commands = [
    { id: "deploy", labels: ["New deployment", "新建部署"], aliases: ["launch"] },
    { id: "download", labels: ["Download model", "下载模型"], aliases: [] },
    { id: "theme", labels: ["Toggle theme", "切换主题"], aliases: ["dark"] },
  ];
  const fields = (item) => [...item.labels, ...item.aliases];
  assert.deepEqual(fuzzyFilter(commands, "dep", { fields }).map(({ item }) => item.id), ["deploy"]);
  assert.deepEqual(fuzzyFilter(commands, "部署", { fields }).map(({ item }) => item.id), ["deploy"]);
  assert.deepEqual(fuzzyFilter(commands, "dark", { fields }).map(({ item }) => item.id), ["theme"]);
  assert.equal(fuzzyFilter(commands, "", { fields }).length, 3);
  assert.equal(fuzzyFilter(commands, "zzz", { fields }).length, 0);
  assert.ok(fuzzyScore("dm", "Download model") > fuzzyScore("dm", "random documents with m"));
  assert.ok(fuzzyScore("down", "Download") > fuzzyScore("down", "Markdown"));
  assert.equal(fuzzyScore("x", ""), null);
});

test("audit unlock: cookie mode keeps only the expiry, degrade mode keeps the token in memory until expiry or lock", () => {
  let now = Date.parse("2026-10-14T08:00:00Z");
  const session = createAuditSession({ now: () => now });
  assert.equal(session.mode(), "locked");
  assert.equal(session.unlock({ ok: true, expiresAt: "2026-10-14T08:30:00Z" }), true);
  assert.equal(session.mode(), "cookie");
  assert.deepEqual(session.headers(), {});
  assert.equal(session.unlock({ ok: true, expiresAt: "2026-10-14T08:30:00Z", token: "audit-fake" }), true);
  assert.deepEqual(session.headers(), { "x-audit-session": "audit-fake" });
  assert.deepEqual(JSON.parse(JSON.stringify(session)), { mode: "token", expiresAt: "2026-10-14T08:30:00.000Z" });
  now += 30 * 60000;
  assert.equal(session.active(), false);
  assert.deepEqual(session.headers(), {});
  session.unlock({ ok: true, expiresAt: "2026-10-14T09:00:00Z", token: "audit-fake" });
  session.lock();
  assert.equal(session.mode(), "locked");
  assert.equal(session.unlock({ ok: false }), false);
  assert.equal(session.unlock({ ok: true, expiresAt: "2026-10-14T07:00:00Z" }), false, "an expired answer does not unlock");
});
