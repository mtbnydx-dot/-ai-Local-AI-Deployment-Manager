"use strict";

// The portal's pure browser modules (service-entry/portal/lib/*.js), loaded as
// ES modules in Node. Modules that import Preact (pages, components) are covered
// by tests/public-portal.spec.cjs; everything here has no DOM dependency except
// the storage and fetch seams, which the tests replace.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const LIB = path.join(__dirname, "..", "portal", "lib");
const load = (name) => import(pathToFileURL(path.join(LIB, name)).href);

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function withWindow(t, props) {
  const previous = globalThis.window;
  globalThis.window = props;
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
}

test("format: token counts, percents, durations", async () => {
  const f = await load("format.js");
  assert.equal(f.formatTokenCount(262144), "256K");
  assert.equal(f.formatTokenCount(131072), "128K");
  assert.equal(f.formatTokenCount(8192), "8K");
  assert.equal(f.formatTokenCount(1_048_576), "1M");
  assert.equal(f.formatTokenCount(1536), "1.5K");
  assert.equal(f.formatTokenCount(900), "900");
  for (const bad of [0, -1, null, undefined, "x", NaN]) assert.equal(f.formatTokenCount(bad), null);
  assert.equal(f.formatPercent(99.3, "en-US"), "99.3%");
  assert.equal(f.formatPercent(100, "zh-CN"), "100%");
  assert.equal(f.formatPercent(null), null);
  assert.equal(f.formatMilliseconds(350), "350 ms");
  assert.equal(f.formatMilliseconds(1200), "1.2 s");
  assert.equal(f.formatMilliseconds(-1), null);
  assert.equal(f.formatInteger(1234567, "en-US"), "1,234,567");
  assert.equal(f.formatInteger("nope"), "");
});

test("format: relative and absolute times", async () => {
  const f = await load("format.js");
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(f.formatRelative("2026-10-14T11:59:50Z", now, "en-US"), "now");
  assert.equal(f.formatRelative("2026-10-14T11:55:00Z", now, "en-US"), "5 minutes ago");
  assert.equal(f.formatRelative("2026-10-14T14:00:00Z", now, "en-US"), "in 2 hours");
  assert.equal(f.formatRelative("2026-10-12T12:00:00Z", now, "en-US"), "2 days ago");
  assert.match(f.formatRelative("2026-10-14T11:55:00Z", now, "zh-CN"), /5\s*分钟前/);
  assert.equal(f.formatRelative("not a date", now), "");
  assert.equal(f.formatDateTime("nope"), "");
  assert.match(f.formatDateTime("2026-10-14T12:00:00Z", "en-US"), /2026/);
});

test("format: pricing, search and model paths", async () => {
  const f = await load("format.js");
  assert.deepEqual(f.readPricing({ unit: "credits_per_million_tokens", input: "0.50", cached_input: "0.05", output: "2.00" }), { unit: "credits_per_million_tokens", input: "0.50", cachedInput: "0.05", output: "2.00" });
  assert.deepEqual(f.readPricing({ input: 1, output: 2 }), { unit: "credits_per_million_tokens", input: "1", cachedInput: null, output: "2" });
  assert.equal(f.readPricing(null), null);
  assert.equal(f.readPricing({}), null);
  assert.equal(f.readPricing({ unit: "x" }), null);
  const model = { id: "qwen3.8-35b", display_name: { "zh-CN": "通义", "en-US": "Qwen" }, aliases: ["qwen3.8"], family: "qwen", parameters: "35B", quantization: "FP8" };
  for (const query of ["", "  ", "QWEN", "通义", "3.8", "fp8", "35b"]) assert.equal(f.modelMatches(model, query), true, query);
  assert.equal(f.modelMatches(model, "llama"), false);
  assert.equal(f.modelPath("a/b c"), "/models/a%2Fb%20c");
});

test("i18n: language detection order and the translator", async () => {
  const i = await load("i18n.js");
  assert.equal(i.normalizeLang("zh"), "zh-CN");
  assert.equal(i.normalizeLang("zh-Hans-CN"), "zh-CN");
  assert.equal(i.normalizeLang("en-GB"), "en-US");
  assert.equal(i.normalizeLang("fr"), null);
  assert.equal(i.normalizeLang(""), null);
  // ?lang= > stored > navigator > default
  assert.equal(i.detectLang({ search: "?lang=en", stored: "zh-CN", languages: ["zh-CN"] }), "en-US");
  assert.equal(i.detectLang({ search: "?lang=xx", stored: "en-US", languages: ["zh-CN"] }), "en-US");
  assert.equal(i.detectLang({ search: "", stored: "bogus", languages: ["fr", "en-GB"] }), "en-US");
  assert.equal(i.detectLang({ search: "", stored: null, languages: ["fr"] }), "zh-CN");
  assert.equal(i.detectLang(), "zh-CN");
  const t = i.createTranslator({ a: "Hello {name}", b: "{count} items" }, { c: "fallback" });
  assert.equal(t("a", { name: "Ada" }), "Hello Ada");
  assert.equal(t("b", { count: 0 }), "0 items");
  assert.equal(t("a", {}), "Hello {name}", "a missing parameter stays visible");
  assert.equal(t("c"), "fallback");
  assert.equal(t("missing.key"), "missing.key");
  assert.equal(t("toString"), "toString", "prototype names are not keys");
  assert.equal(t.has("a"), true);
  assert.equal(t.has("c"), false);
  assert.equal(i.pickText({ "zh-CN": "中", "en-US": "en" }, "en-US"), "en");
  assert.equal(i.pickText({ "zh-CN": "中", "en-US": "" }, "en-US"), "中");
  assert.equal(i.pickText("plain", "en-US"), "plain");
  assert.equal(i.pickText(null, "en-US"), "");
});

test("router: the route table and the links it takes over", async () => {
  const r = await load("router.js");
  assert.deepEqual(r.matchRoute("/"), { name: "home", params: {}, page: "status" });
  assert.equal(r.matchRoute("/status").page, "status");
  assert.equal(r.matchRoute("/models/").name, "models");
  assert.deepEqual(r.matchRoute("/models/a%2Fb%20c"), { name: "model", params: { id: "a/b c" }, page: "model" });
  assert.deepEqual(r.matchRoute("/docs/quickstart"), { name: "doc", params: { slug: "quickstart" }, page: "docs" });
  assert.equal(r.matchRoute("/docs/Quick").name, "not-found");
  assert.equal(r.matchRoute("/models/%E0%A4%A").name, "not-found", "a bad escape is not a route");
  assert.equal(r.matchRoute("/models/a/b").name, "not-found");
  assert.equal(r.matchRoute("/api/status").name, "not-found");
  for (const name of ["me", "playground", "announcements", "docs"]) assert.equal(r.matchRoute(`/${name}`).page, name);
  assert.equal(r.navGroup("home"), "status");
  assert.equal(r.navGroup("model"), "models");
  assert.equal(r.navGroup("doc"), "docs");
  const anchor = (href, extra = {}) => ({ target: "", getAttribute: () => href, hasAttribute: (name) => name in extra, ...extra });
  const origin = "https://portal.example";
  assert.equal(r.internalHref(anchor("/models?x=1#top"), origin), "/models?x=1#top");
  assert.equal(r.internalHref(anchor("https://portal.example/status"), origin), "/status");
  assert.equal(r.internalHref(anchor("https://other.example/status"), origin), null);
  assert.equal(r.internalHref(anchor("#main"), origin), null);
  assert.equal(r.internalHref(anchor("/catalog.json"), origin), null);
  assert.equal(r.internalHref(anchor("/assets/x/app.js"), origin), null);
  assert.equal(r.internalHref(anchor("/healthz"), origin), null);
  assert.equal(r.internalHref(anchor("/v1/models"), origin), null);
  assert.equal(r.internalHref(anchor("/docs/quickstart#a"), origin), "/docs/quickstart#a");
  assert.equal(r.internalHref(anchor("/models/a%2Fb"), origin), "/models/a%2Fb");
  assert.equal(r.internalHref(anchor("/status", { target: "_blank" }), origin), null);
  assert.equal(r.internalHref(anchor("/status", { download: "" }), origin), null);
  assert.equal(r.internalHref(anchor("mailto:a@b"), origin), null);
});

const CATALOG_ENTRY = {
  id: "qwen3.8-35b-a3b", display_name: { "zh-CN": "通义", "en-US": "Qwen" }, description: { "zh-CN": "描述", "en-US": "Desc" },
  family: "qwen3.8", parameters: "35B", quantization: "FP8", modalities: ["text", "vision", "bogus"], tools: true, reasoning: false,
  context: 262144, max_output: 8192, limits: { rpm: 30, tpm: 100000, concurrency: 2, max_output_tokens: 8192 }, recommended: true,
  aliases: ["qwen3.8", 5], state: "ready", prices: { input: "0.5", output: "2" },
};
const KEY_ENTRY = {
  id: "Qwen3.8-35B-A3B", display_name: "Qwen", context_length: 100000, max_output_tokens: 4096, state: "starting",
  capabilities: { chat: true, vision: true, tools: true, reasoning: true }, pricing: { input: "0.25", output: "1" }, limits: { rpm: 12, tpm: 40000, max_output_tokens: 4096 },
};

test("models: catalog and key shapes become one view model", async () => {
  const m = await load("models.js");
  const fromCatalog = m.fromCatalog(CATALOG_ENTRY, "en-US");
  assert.equal(fromCatalog.name, "Qwen");
  assert.equal(fromCatalog.description, "Desc");
  assert.equal(m.fromCatalog(CATALOG_ENTRY, "zh-CN").name, "通义");
  assert.deepEqual(fromCatalog.modalities, ["text", "vision"]);
  assert.deepEqual(fromCatalog.aliases, ["qwen3.8"]);
  assert.equal(fromCatalog.context, 262144);
  assert.deepEqual(fromCatalog.limits, { rpm: 30, tpm: 100000, concurrency: 2, maxOutput: 8192 });
  assert.equal(fromCatalog.pricing.input, "0.5");
  assert.equal(fromCatalog.available, null);
  const bare = m.fromCatalog({ id: "x", display_name: "", modalities: [], limits: null }, "en-US");
  assert.equal(bare.name, "x");
  assert.deepEqual(bare.modalities, ["text"]);
  assert.deepEqual(bare.limits, { rpm: null, tpm: null, concurrency: null, maxOutput: null });
  assert.equal(bare.state, "unknown");
  const keyed = m.fromKeyModel(KEY_ENTRY);
  assert.deepEqual(keyed.modalities, ["text", "vision"]);
  assert.equal(keyed.tools, true);
  assert.equal(keyed.available, true);
  assert.equal(keyed.perKey, true);
  assert.equal(m.fromKeyModel({ id: "emb", capabilities: { embeddings: true } }).modalities.join(), "embedding");
  assert.equal(m.fromKeyModel({ id: "tts", capabilities: { audio_speech: true } }).modalities.join(), "audio");
});

test("models: a key marks what it can use and brings its own limits and prices", async () => {
  const m = await load("models.js");
  const catalog = [m.fromCatalog(CATALOG_ENTRY, "en-US"), m.fromCatalog({ id: "other", display_name: "Other", limits: { rpm: 5 } }, "en-US")];
  assert.equal(m.mergeModels(catalog, null), catalog, "no key: the catalog as is");
  const merged = m.mergeModels(catalog, [m.fromKeyModel(KEY_ENTRY), m.fromKeyModel({ id: "key-only", display_name: "Key only" })]);
  assert.equal(merged.length, 3);
  const first = merged[0];
  assert.equal(first.available, true);
  assert.equal(first.perKey, true);
  assert.equal(first.name, "Qwen");
  assert.equal(first.description, "Desc", "the catalog keeps the description");
  assert.deepEqual(first.limits, { rpm: 12, tpm: 40000, concurrency: null, maxOutput: 4096 });
  assert.equal(first.context, 100000);
  assert.equal(first.pricing.input, "0.25");
  assert.equal(first.state, "starting");
  assert.equal(merged[1].available, false);
  assert.equal(merged[1].limits.rpm, 5, "a model the key cannot use keeps the default limits");
  assert.equal(merged[2].id, "key-only");
  assert.equal(merged[2].available, true);
  assert.equal(m.findModel(merged, "QWEN3.8-35B-A3B").id, "qwen3.8-35b-a3b");
  assert.equal(m.findModel(merged, "qwen3.8").id, "qwen3.8-35b-a3b", "an alias finds the model");
  assert.equal(m.findModel(merged, "nothing"), null);
  assert.equal(m.passesFilters(first, { vision: true, tools: true }), true);
  assert.equal(m.passesFilters(first, { reasoning: true }), false, "the catalog says this model does not reason");
  assert.equal(m.passesFilters(merged[1], { available: true }), false);
  assert.equal(m.passesFilters(merged[1], {}), true);
});

test("session: a share link's key is stored for the session and the fragment is removed", async (t) => {
  const s = await load("session.js");
  assert.equal(s.keyFromHash("#key=sk-test-123"), "sk-test-123");
  assert.equal(s.keyFromHash("#key=sk%2Btest"), "sk+test");
  for (const hash of ["", "#", "#main", "#key=", "#key=a&b=c", "#other=key=x", "#key=%E0%A4%A"]) assert.equal(s.keyFromHash(hash), "", hash);
  const session = fakeStorage();
  const local = fakeStorage();
  withWindow(t, { sessionStorage: session, localStorage: local });
  const replaced = [];
  const history = { state: { n: 1 }, replaceState: (state, title, url) => replaced.push({ state, url }) };
  assert.equal(s.captureKeyFromLocation({ hash: "#key=sk-test-123", pathname: "/me", search: "?lang=en" }, history), "sk-test-123");
  assert.deepEqual(replaced, [{ state: { n: 1 }, url: "/me?lang=en" }]);
  assert.equal(session.map.get("portal.key"), "sk-test-123");
  assert.equal(local.map.size, 0, "the key never reaches localStorage");
  assert.equal(s.readKey(), "sk-test-123");
  assert.equal(s.captureKeyFromLocation({ hash: "#top", pathname: "/", search: "" }, history), "");
  assert.equal(replaced.length, 1, "other fragments are left alone");
  s.storeKey("");
  assert.equal(s.readKey(), "");
  assert.equal(s.previewKey("sk-abcdefghijklmnop"), "sk-ab…mnop");
  assert.ok(!s.previewKey("sk-abcdefghijklmnop").includes("fghij"));
});

test("storage never throws, even when the browser has none", async (t) => {
  const st = await load("storage.js");
  withWindow(t, {
    get sessionStorage() { throw new Error("blocked"); },
    get localStorage() { throw new Error("blocked"); },
  });
  assert.equal(st.readStorage("session", "k"), null);
  assert.equal(st.readStorage("local", "k"), null);
  assert.equal(st.writeStorage("session", "k", "v"), false);
  assert.equal(st.writeStorage("local", "k", null), false);
  const broken = { getItem() { throw new Error("quota"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("quota"); } };
  withWindow(t, { sessionStorage: broken, localStorage: broken });
  assert.equal(st.readStorage("local", "k"), null);
  assert.equal(st.writeStorage("local", "k", "v"), false);
});

test("api: requests are credential-free, the key rides in a header, errors keep their code", async (t) => {
  const api = await load("api.js");
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const respond = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === "/ok") return respond(200, { a: 1 });
    if (url === "/v1/models") return respond(401, { error: { code: "invalid_api_key", message: "bad" }, request_id: "req_1" }, { "retry-after": "7" });
    if (url === "/stale") return respond(410, { error: { code: "portal_stale", message: "old" } });
    if (url === "/html") return respond(502, "<html>bad gateway</html>");
    if (url === "/notjson") return respond(200, "plain");
    if (url === "/down") throw new TypeError("fetch failed");
    if (url === "/abort") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return respond(404, {});
  };
  assert.deepEqual(await api.fetchJson("/ok", { key: "sk-test-1" }), { a: 1 });
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-test-1");
  assert.ok(!calls[0].url.includes("sk-test"));
  await api.fetchJson("/ok");
  assert.equal(calls[1].init.headers.authorization, undefined);
  await assert.rejects(api.getKeyModels("sk-test-2"), (error) => error instanceof api.ApiError && error.status === 401 && error.code === "invalid_api_key" && error.requestId === "req_1" && error.retryAfter === 7);
  assert.equal(calls[2].init.headers.authorization, "Bearer sk-test-2");
  await assert.rejects(api.fetchJson("/stale"), (error) => api.isStaleError(error));
  await assert.rejects(api.fetchJson("/html"), (error) => error.status === 502 && error.code === "http_502" && !api.isStaleError(error));
  await assert.rejects(api.fetchJson("/notjson"), (error) => error.code === "invalid_response");
  await assert.rejects(api.fetchJson("/down"), (error) => error.status === 0 && error.code === "network_error");
  await assert.rejects(api.fetchJson("/abort"), (error) => error.name === "AbortError");
  await api.fetchJson("/ok", { method: "POST", body: { x: 1 } });
  const post = calls[calls.length - 1].init;
  assert.equal(post.body, '{"x":1}');
  assert.equal(post.headers["content-type"], "application/json");
});
