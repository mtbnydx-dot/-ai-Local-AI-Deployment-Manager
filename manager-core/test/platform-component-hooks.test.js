"use strict";

// The two component hooks (docs/overhaul/06-ops.md §3.4) and the zh/en strings.
// Temp AI roots, injected vaults and fake keys only.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const components = require("../platform/components");
const config = require("../platform/config");
const mcpHook = require("../platform/hooks/platform-mcp");
const searchHook = require("../platform/hooks/search-gateway");
const messages = require("../platform/messages");

const HOOKS_DIR = path.join(__dirname, "..", "platform", "hooks");
const FAKE_KEY_MCP = "fake-mcp-key-0123456789abcdef0123456789abcdef";
const FAKE_KEY_SEARCH = "fake-search-key-0123456789";
const FAKE_KEY_UPSTREAM = "fake-upstream-key-0123456789";
const STORE_KEYS = {
  "platform/platformMcp.apiKey": FAKE_KEY_MCP,
  "platform/search.apiKey": FAKE_KEY_SEARCH,
  "platform/search.upstreamApiKey": FAKE_KEY_UPSTREAM,
};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-hooks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeVault(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: (namespace, name) => map.get(`${namespace}/${name}`) || "",
    has: (namespace, name) => map.has(`${namespace}/${name}`),
    set: async (namespace, name, value) => { map.set(`${namespace}/${name}`, value); },
  };
}

function mcpDir(root) {
  const dir = path.join(root, ".runtime", "platform-mcp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("platform-mcp hook imports a legacy server.env key into the store and rewrites the file without it", async (t) => {
  const root = tempDir(t);
  const dir = mcpDir(root);
  const file = path.join(dir, "server.env");
  fs.writeFileSync(file, `# Generated locally. Do not share or commit this file.\r\nPLATFORM_MCP_API_KEY=${FAKE_KEY_MCP}\r\nPLATFORM_MCP_EXTRA=keep-me\r\n`);
  const vault = fakeVault();
  const result = await mcpHook.prepare({ aiRoot: root, secrets: vault });
  assert.equal(result.imported, true);
  assert.equal(result.scrubbed, true);
  assert.equal(result.env.PLATFORM_MCP_API_KEY, FAKE_KEY_MCP);
  assert.equal(vault.get("platform", "platformMcp.apiKey"), FAKE_KEY_MCP);
  const rewritten = fs.readFileSync(file, "utf8");
  assert.equal(rewritten.includes(FAKE_KEY_MCP), false);
  assert.equal(rewritten.includes("PLATFORM_MCP_API_KEY"), false);
  assert.match(rewritten, /PLATFORM_MCP_EXTRA=keep-me/);
  // A second run changes nothing and reads the key from the store.
  const again = await mcpHook.prepare({ aiRoot: root, secrets: vault });
  assert.equal(again.imported, false);
  assert.equal(again.scrubbed, false);
  assert.equal(again.env.PLATFORM_MCP_API_KEY, FAKE_KEY_MCP);
  assert.deepEqual(fs.readdirSync(dir), ["server.env"]);
});

test("platform-mcp hook keeps the file when the store cannot hold the key", async (t) => {
  const root = tempDir(t);
  const file = path.join(mcpDir(root), "server.env");
  const original = `PLATFORM_MCP_API_KEY=${FAKE_KEY_MCP}\r\n`;
  fs.writeFileSync(file, original);
  const lossy = { get: () => "", has: () => false, set: async () => {} };
  assert.equal((await mcpHook.prepare({ aiRoot: root, secrets: lossy })).blocked.reason, "secret-store-unavailable");
  assert.equal(fs.readFileSync(file, "utf8"), original);
  const throwing = { get: () => "", has: () => false, set: async () => { throw Object.assign(new Error("store down"), { code: "SECRET_STORE_UNAVAILABLE" }); } };
  const failed = await mcpHook.prepare({ aiRoot: root, secrets: throwing });
  assert.deepEqual(failed.blocked, { reason: "secret-store-unavailable", code: "SECRET_STORE_UNAVAILABLE" });
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal((await mcpHook.prepare({ aiRoot: root })).blocked.reason, "secret-store-unavailable");
});

test("platform-mcp hook generates a 32-byte key when there is none, and rejects short keys", async (t) => {
  const root = tempDir(t);
  const vault = fakeVault();
  let asked = 0;
  const randomBytes = (size) => { asked = size; return Buffer.alloc(size, 0xfb); };
  const result = await mcpHook.prepare({ aiRoot: root, secrets: vault, randomBytes });
  assert.equal(asked, 32);
  assert.equal(result.generated, true);
  assert.equal(result.env.PLATFORM_MCP_API_KEY.length, 43);
  assert.match(result.env.PLATFORM_MCP_API_KEY, /^[A-Za-z0-9_-]+$/);
  assert.equal(vault.get("platform", "platformMcp.apiKey"), result.env.PLATFORM_MCP_API_KEY);
  assert.equal(fs.existsSync(path.join(root, ".runtime", "platform-mcp", "server.env")), false);
  const short = fakeVault({ "platform/platformMcp.apiKey": "too-short" });
  assert.equal((await mcpHook.prepare({ aiRoot: root, secrets: short })).blocked.reason, "mcp-key-invalid");
  const tiny = await mcpHook.prepare({ aiRoot: root, secrets: vault, component: { env: { PLATFORM_MCP_SEARCH_GATEWAY_API_KEY: "short" } } });
  assert.equal(tiny.blocked.reason, "mcp-search-key-invalid");
  const legacyShort = mcpDir(root);
  fs.writeFileSync(path.join(legacyShort, "server.env"), "PLATFORM_MCP_API_KEY=short\r\n");
  assert.equal((await mcpHook.prepare({ aiRoot: root, secrets: fakeVault() })).blocked.reason, "mcp-key-invalid");
});

test("platform-mcp hook scrubs the file even when the store already holds a different key", async (t) => {
  const root = tempDir(t);
  const file = path.join(mcpDir(root), "server.env");
  fs.writeFileSync(file, "PLATFORM_MCP_API_KEY=fake-old-key-0123456789abcdef0123456789abcdef\r\n");
  const vault = fakeVault({ "platform/platformMcp.apiKey": FAKE_KEY_MCP });
  const result = await mcpHook.prepare({ aiRoot: root, secrets: vault });
  assert.equal(result.env.PLATFORM_MCP_API_KEY, FAKE_KEY_MCP);
  assert.equal(result.imported, false);
  assert.equal(result.scrubbed, true);
  assert.equal(fs.readFileSync(file, "utf8").includes("fake-old-key"), false);
});

test("platform-mcp afterReady writes server.pid and accepts loopback-only listeners", async (t) => {
  const root = tempDir(t);
  const listeners = [{ address: "127.0.0.1", port: 5190, pid: 4242 }, { address: "0.0.0.0", port: 9999, pid: 4242 }];
  assert.deepEqual(await mcpHook.afterReady({ aiRoot: root, pid: 4242, port: 5190, listeners }), { ok: true });
  assert.equal(fs.readFileSync(path.join(root, ".runtime", "platform-mcp", "server.pid"), "ascii"), "4242");
  const v6 = await mcpHook.afterReady({ aiRoot: root, pid: 4242, port: 5190, listListeners: async () => [{ address: "::1", port: 5190, pid: 4242 }] });
  assert.equal(v6.ok, true);
});

test("platform-mcp afterReady kills and fails a process that listens beyond loopback", async (t) => {
  const root = tempDir(t);
  const killed = [];
  const cases = [
    [{ address: "0.0.0.0", port: 5190, pid: 7 }],
    [{ address: "127.0.0.1", port: 5190, pid: 7 }, { address: "192.168.1.5", port: 5190, pid: 7 }],
    [],
  ];
  for (const listeners of cases) {
    const result = await mcpHook.afterReady({ aiRoot: root, pid: 7, port: 5190, listeners, killTree: async (pid) => killed.push(pid) });
    assert.equal(result.ok, false);
    assert.equal(result.kill, true);
    assert.equal(result.error.code, "mcp_not_loopback");
    assert.equal(fs.existsSync(path.join(root, ".runtime", "platform-mcp", "server.pid")), false);
  }
  assert.deepEqual(killed, [7, 7, 7]);
});

function searchContext(root, env, { withUpstreamKey = true } = {}) {
  const loaded = config.loadPlatformConfig({ aiRoot: root, env });
  const secrets = fakeVault(withUpstreamKey ? STORE_KEYS : { "platform/search.apiKey": FAKE_KEY_SEARCH });
  const registry = components.loadComponentRegistry({ aiRoot: root, config: loaded });
  const spec = registry.components.find((component) => component.id === "search-gateway");
  const component = components.resolveComponent(spec, { aiRoot: root, config: loaded, runtime: { registry, secrets } });
  return { aiRoot: root, config: loaded, secrets, component };
}

test("search hook picks the upstream in the order of 06 §3.4", async (t) => {
  const root = tempDir(t);
  // 1. search.upstreamBaseUrl wins over everything.
  const explicit = await searchHook.prepare(searchContext(root, { UPSTREAM_BASE_URL: "http://example.test:9/v1", SERVICE_ENTRY_ALLOW_LAN_ADMIN: "1" }));
  assert.deepEqual(explicit, { env: { UPSTREAM_BASE_URL: "http://example.test:9/v1" }, upstream: { source: "setting" } });
  // 2. The PUBLIC listener, when it is enabled and an upstream key is set.
  const pub = await searchHook.prepare(searchContext(root, { SERVICE_ENTRY_ALLOW_LAN_ADMIN: "1" }));
  assert.deepEqual(pub.env, { UPSTREAM_BASE_URL: "http://host.docker.internal:5186/v1" });
  assert.equal(pub.upstream.source, "public");
  // 3. The entry admin route when LAN admin is on and no upstream key is set.
  const lan = await searchHook.prepare(searchContext(root, { SERVICE_ENTRY_ALLOW_LAN_ADMIN: "1" }, { withUpstreamKey: false }));
  assert.deepEqual(lan.env, { UPSTREAM_BASE_URL: "http://host.docker.internal:5176/gateway/auto/openai/v1" });
  assert.equal(lan.upstream.source, "admin-lan");
  // The public listener switched off falls through to the admin route.
  const noPublic = await searchHook.prepare(searchContext(root, { SERVICE_ENTRY_ALLOW_LAN_ADMIN: "1", SERVICE_ENTRY_PUBLIC_LISTENER: "0" }));
  assert.equal(noPublic.upstream.source, "admin-lan");
  // 4. The vLLM manager only for a wildcard host (the managers.bindHost default).
  const vllmDefault = await searchHook.prepare(searchContext(root, {}, { withUpstreamKey: false }));
  assert.equal(vllmDefault.upstream.source, "vllm-manager");
  const vllm = await searchHook.prepare(searchContext(root, { VLLM_MANAGER_HOST: "0.0.0.0" }, { withUpstreamKey: false }));
  assert.deepEqual(vllm.env, { UPSTREAM_BASE_URL: "http://host.docker.internal:5177/serve/v1" });
  assert.equal(vllm.upstream.source, "vllm-manager");
  // None applies: blocked with the documented reason and no env.
  const none = await searchHook.prepare(searchContext(root, { VLLM_MANAGER_HOST: "127.0.0.1" }, { withUpstreamKey: false }));
  assert.deepEqual(none, { env: {}, blocked: { reason: "search-upstream-unreachable" } });
  const loopbackOnly = await searchHook.prepare(searchContext(root, { SERVICE_ENTRY_PUBLIC_LISTENER: "0", VLLM_MANAGER_HOST: "127.0.0.1" }));
  assert.equal(loopbackOnly.blocked.reason, "search-upstream-unreachable");
});

test("search hook takes its keys from the store through env and never reads .last-public-service-key.txt", async (t) => {
  const root = tempDir(t);
  // A planted legacy key file must not matter.
  const legacy = path.join(root, "vllm-manager", "logs");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, ".last-public-service-key.txt"), "fake-legacy-service-key-0123456789\r\n");
  const context = searchContext(root, {});
  assert.equal(context.component.env.UPSTREAM_API_KEY, FAKE_KEY_UPSTREAM);
  assert.equal(context.component.env.SEARCH_GATEWAY_API_KEY, FAKE_KEY_SEARCH);
  const touched = [];
  const real = { readFileSync: fs.readFileSync, openSync: fs.openSync, readFile: fs.promises.readFile };
  fs.readFileSync = function spy(file, ...rest) { touched.push(String(file)); return real.readFileSync.call(this, file, ...rest); };
  fs.openSync = function spy(file, ...rest) { touched.push(String(file)); return real.openSync.call(this, file, ...rest); };
  fs.promises.readFile = function spy(file, ...rest) { touched.push(String(file)); return real.readFile.call(this, file, ...rest); };
  try {
    await searchHook.prepare(context);
  } finally {
    fs.readFileSync = real.readFileSync;
    fs.openSync = real.openSync;
    fs.promises.readFile = real.readFile;
  }
  assert.deepEqual(touched, []);
  const source = fs.readFileSync(path.join(HOOKS_DIR, "search-gateway.js"), "utf8");
  assert.equal(/require\(["'](?:node:)?fs/.test(source), false);
  assert.equal(source.includes("last-public-service-key"), false);
  assert.equal(JSON.stringify(context.component.env).includes("fake-legacy-service-key"), false);
});

test("messages: language order and bilingual copy", () => {
  assert.equal(messages.resolveLanguage({ lang: "zh", env: { PLATFORM_LANG: "en" }, locale: "en-US" }), "zh-CN");
  assert.equal(messages.resolveLanguage({ env: { PLATFORM_LANG: "zh_CN" }, locale: "en-US" }), "zh-CN");
  assert.equal(messages.resolveLanguage({ env: {}, locale: "zh-TW" }), "zh-CN");
  assert.equal(messages.resolveLanguage({ env: {}, locale: "de-DE" }), "en-US");
  assert.equal(messages.resolveLanguage({ lang: "en", env: { PLATFORM_LANG: "zh" }, locale: "zh-CN" }), "en-US");
  for (const [key, entry] of Object.entries(messages.MESSAGES)) {
    assert.ok(entry["zh-CN"] && entry["en-US"], key);
    assert.deepEqual(entry["zh-CN"].match(/\{\w+\}/g), entry["en-US"].match(/\{\w+\}/g), `${key} placeholders`);
  }
  assert.match(messages.message("registry.unknown_placeholder", "en-US", { id: "demo", detail: "${x}" }), /demo.*\$\{x\}/);
  assert.equal(messages.message("no.such.key", "zh-CN"), "no.such.key");
  assert.deepEqual(Object.keys(messages.bilingual("blocked.search-upstream-unreachable")), ["zh-CN", "en-US"]);
  // Every reason a hook can return has copy.
  for (const reason of ["search-upstream-unreachable", "mcp-key-invalid", "mcp-search-key-invalid", "secret-store-unavailable", "registry-invalid"]) {
    assert.notEqual(messages.message(`blocked.${reason}`, "en-US"), `blocked.${reason}`);
  }
  assert.notEqual(messages.message("failed.mcp-not-loopback", "en-US"), "failed.mcp-not-loopback");
});
