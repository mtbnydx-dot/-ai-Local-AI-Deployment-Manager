"use strict";

// Component registry (docs/overhaul/06-ops.md §3, §14): the bundled file, the
// override rules, placeholder expansion, ordering, profiles, path mapping and
// the resolved golden. Hooks and messages are in platform-component-hooks.test.js.
// Every case uses a temp AI root, passes its env explicitly and uses obviously
// fake keys.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("..");
const components = require("../platform/components");
const config = require("../platform/config");
const messages = require("../platform/messages");

const GOLDEN = path.join(__dirname, "fixtures", "platform", "registry-resolved.json");
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-components-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function loadedConfig(root, overrides, env = {}) {
  if (overrides !== undefined) {
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(path.join(root, "config", "platform.json"), JSON.stringify({ components: overrides }));
  }
  return config.loadPlatformConfig({ aiRoot: root, env });
}

function registryFor(root, overrides, env) {
  return components.loadComponentRegistry({ aiRoot: root, config: loadedConfig(root, overrides, env) });
}

// An in-memory vault with the secret store's sync get/has and async set.
function fakeVault(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: (namespace, name) => map.get(`${namespace}/${name}`) || "",
    has: (namespace, name) => map.has(`${namespace}/${name}`),
    set: async (namespace, name, value) => { map.set(`${namespace}/${name}`, value); },
  };
}

function spec(registry, id) {
  const found = registry.components.find((component) => component.id === id);
  assert.ok(found, `component ${id}`);
  return found;
}

function codes(registry) {
  return registry.errors.map((error) => `${error.id}:${error.code}`).sort();
}

test("the bundled file validates and carries schemaVersion, asOf and staleAfterDays", (t) => {
  const registry = registryFor(tempDir(t));
  assert.deepEqual(registry.errors, []);
  assert.equal(registry.schemaVersion, 1);
  assert.match(registry.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(registry.staleAfterDays, 365);
  const raw = JSON.parse(fs.readFileSync(components.BUNDLED_FILE, "utf8"));
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.staleAfterDays, 365);
  assert.equal(raw.asOf, registry.asOf);
  assert.deepEqual(registry.components.map((component) => component.id), [
    "docker", "entry", "service-entry-public", "vllm-manager", "llama-manager",
    "platform-mcp", "tts-gateway", "tts-workers", "search-gateway", "legacy-claude-proxy",
  ]);
  for (const component of registry.components) {
    assert.ok(component.label["zh-CN"] && component.label["en-US"], `${component.id} label`);
    assert.ok(component.description["zh-CN"] && component.description["en-US"], `${component.id} description`);
  }
  assert.equal(spec(registry, "service-entry-public").kind, "listener");
  assert.equal(spec(registry, "service-entry-public").parent, "entry");
  assert.deepEqual(components.LEGACY_IDS, { vllm: "vllm-manager", llama: "llama-manager", tts: "tts-gateway", mcp: "platform-mcp", search: "search-gateway" });
  for (const [legacy, id] of Object.entries(components.LEGACY_IDS)) assert.equal(spec(registry, id).legacyId, legacy);
});

test("every hook named in the registry exists and exports prepare", (t) => {
  const registry = registryFor(tempDir(t));
  const hooked = registry.components.filter((candidate) => candidate.hook);
  assert.deepEqual(hooked.map((component) => component.hook).sort(), ["platform-mcp", "search-gateway"]);
  for (const component of hooked) {
    assert.ok(fs.existsSync(path.join(HOOKS_DIR, `${component.hook}.js`)), component.hook);
    assert.equal(typeof components.loadHook(component.hook).prepare, "function");
  }
  assert.throws(() => components.loadHook("../config"), { code: "E_INVALID_HOOK" });
});

test("core.platform exposes the registry and the messages", () => {
  assert.equal(typeof core.platform.loadComponentRegistry, "function");
  assert.equal(core.platform.components, components);
  assert.equal(core.platform.messages, messages);
});

test("a stale, corrupt or missing registry file never throws", (t) => {
  const root = tempDir(t);
  const stale = path.join(root, "stale.json");
  fs.writeFileSync(stale, JSON.stringify({ schemaVersion: 1, asOf: "2020-01-01", staleAfterDays: 30, components: [] }));
  assert.equal(components.loadComponentRegistry({ aiRoot: root, bundledFile: stale }).freshness.stale, true);
  const bad = path.join(root, "bad.json");
  fs.writeFileSync(bad, "{ not json");
  assert.equal(components.loadComponentRegistry({ aiRoot: root, bundledFile: bad }).errors[0].code, "registry_corrupt");
  assert.equal(components.loadComponentRegistry({ aiRoot: root, bundledFile: path.join(root, "none.json") }).errors[0].code, "registry_unreadable");
  const bom = path.join(root, "bom.json");
  fs.writeFileSync(bom, `\uFEFF${fs.readFileSync(components.BUNDLED_FILE, "utf8")}`);
  assert.deepEqual(components.loadComponentRegistry({ aiRoot: root, bundledFile: bom }).errors, []);
  const undated = path.join(root, "undated.json");
  fs.writeFileSync(undated, JSON.stringify({ schemaVersion: 1, components: [] }));
  assert.deepEqual(codes(components.loadComponentRegistry({ aiRoot: root, bundledFile: undated })), ["$registry:missing_field", "$registry:missing_field"]);
});

test("validation reports bad entries, references and placeholders", (t) => {
  const root = tempDir(t);
  const file = path.join(root, "components.json");
  const good = { id: "demo-one", kind: "node", profile: "core", autostart: true, label: { "zh-CN": "一", "en-US": "One" }, cwd: "x", command: "${NODE}", args: ["a"] };
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    asOf: "2026-10-14",
    staleAfterDays: 365,
    components: [
      good,
      { ...good, id: "demo-two", after: ["ghost"], args: ["${nope}", "${port:missing}", "${config:no.such.key}"] },
      { ...good, id: "demo-three", command: "", label: { "zh-CN": "三" } },
      { ...good, id: "Bad_Id" },
      { ...good, id: "demo-one" },
      { ...good, id: "demo-docker", args: ["x${DOCKER}"] },
    ],
  }));
  const registry = components.loadComponentRegistry({ aiRoot: root, bundledFile: file });
  const found = codes(registry);
  assert.ok(found.includes("demo-two:unknown_reference"));
  assert.equal(found.filter((code) => code === "demo-two:unknown_placeholder").length, 3);
  assert.ok(found.includes("demo-three:missing_field"));
  assert.ok(found.includes("demo-three:invalid_copy"));
  assert.ok(found.includes(":invalid_id") || found.some((code) => code.endsWith("Bad_Id:invalid_id")));
  assert.ok(found.includes("demo-one:duplicate_id"));
  assert.ok(found.includes("demo-docker:placeholder_position"));
  assert.equal(registry.components.filter((component) => component.id === "demo-one").length, 1);
});

test("overrides merge by id: autostart, profile, disabled, restartPolicy, liveness.onFailure, additive env, replaced args", (t) => {
  const registry = registryFor(tempDir(t), {
    "tts-workers": { autostart: true },
    "vllm-manager": { env: { MY_FLAG: "1" }, args: ["server.js", "--quiet"], restartPolicy: { maxRestarts: 2 }, liveness: { onFailure: "restart" } },
    "platform-mcp": { disabled: true, profile: "core" },
    llama: { autostart: false },
  });
  assert.deepEqual(codes(registry), ["llama:unknown_component"]);
  assert.deepEqual(registry.overridden.slice().sort(), ["platform-mcp", "tts-workers", "vllm-manager"]);
  assert.equal(spec(registry, "tts-workers").autostart, true);
  const vllm = spec(registry, "vllm-manager");
  assert.deepEqual(vllm.args, ["server.js", "--quiet"]);
  assert.equal(vllm.env.MY_FLAG, "1");
  assert.equal(vllm.env.AI_ROOT, "${AI_ROOT}");
  assert.equal(vllm.env.VLLM_MANAGER_ALLOW_REMOTE, "0");
  assert.equal(vllm.restartPolicy.maxRestarts, 2);
  assert.equal(vllm.liveness.onFailure, "restart");
  assert.equal(vllm.liveness.intervalSec, 10);
  assert.equal(spec(registry, "platform-mcp").disabled, true);
  assert.equal(spec(registry, "platform-mcp").profile, "core");
  // Disabled entries leave the profile, and an enabled on-demand one joins it.
  assert.ok(components.selectProfile(registry, "full").includes("tts-workers"));
  assert.ok(!components.selectProfile(registry, "full").includes("platform-mcp"));
});

test("an unknown id or a forbidden field goes to errors and the bundled entry is kept", (t) => {
  const bundled = registryFor(tempDir(t));
  const registry = registryFor(tempDir(t), {
    entry: { command: "evil.exe", autostart: false },
    "vllm-manager": { cwd: "..", kind: "external" },
    "llama-manager": { shell: true },
    "no-such": { autostart: true },
    "bad-shape": "text",
  });
  assert.deepEqual(codes(registry), [
    "bad-shape:invalid_type",
    "entry:forbidden_override_field",
    "llama-manager:unknown_override_field",
    "no-such:unknown_component",
    "vllm-manager:forbidden_override_field",
    "vllm-manager:forbidden_override_field",
  ]);
  assert.deepEqual(registry.overridden, []);
  for (const id of ["entry", "vllm-manager", "llama-manager"]) assert.deepEqual(spec(registry, id), spec(bundled, id));
  assert.equal(spec(registry, "entry").autostart, true);
});

test("an override cannot make an invalid component; new ids only as external or compose", (t) => {
  const registry = registryFor(tempDir(t), {
    "vllm-manager": { args: "not-a-list", liveness: { onFailure: "explode" } },
    "my-tunnel": { kind: "external", label: { "zh-CN": "隧道", "en-US": "Tunnel" }, ports: [{ name: "http", port: 8123, bind: "127.0.0.1" }], stop: { strategy: "never" } },
    "my-node": { kind: "node", label: { "zh-CN": "节", "en-US": "Node" }, command: "x" },
  });
  const found = codes(registry);
  assert.ok(found.includes("vllm-manager:invalid_type"));
  assert.ok(found.includes("vllm-manager:invalid_value"));
  assert.ok(found.includes("my-node:unknown_component"));
  assert.deepEqual(registry.overridden, ["my-tunnel"]);
  const tunnel = spec(registry, "my-tunnel");
  assert.equal(tunnel.profile, "none");
  assert.equal(tunnel.autostart, false);
  assert.deepEqual(spec(registry, "vllm-manager").args, ["server.js"]);
});

test("env overrides written as NAME=value lists work, and a credential planted in the file never reaches the registry", (t) => {
  const registry = registryFor(tempDir(t), { entry: { env: ["EXTRA_FLAG=2", "MY_API_KEY=planted"] } });
  assert.equal(spec(registry, "entry").env.EXTRA_FLAG, "2");
  assert.equal(spec(registry, "entry").env.MY_API_KEY, undefined);
  assert.ok(!JSON.stringify(registry).includes("planted"));
});

test("placeholder expansion: root, node, pwsh, config, port, TTS root and relative paths", (t) => {
  const root = tempDir(t);
  const registry = registryFor(root);
  const runtime = { registry, nodeExe: "node.exe", pwsh: "pwsh.exe", secrets: fakeVault(STORE_KEYS) };
  const loaded = loadedConfig(root, undefined, { SERVICE_ENTRY_PORT: "5999" });
  const entry = components.resolveComponent(spec(registry, "entry"), { aiRoot: root, config: loaded, runtime });
  assert.equal(entry.cwd, path.join(root, "service-entry"));
  assert.deepEqual(entry.argv, ["node.exe", "server.js"]);
  assert.equal(entry.env.AI_ROOT, root);
  assert.deepEqual(entry.ports, [{ name: "admin", port: 5999, bind: "127.0.0.1", enabled: true }]);
  assert.equal(entry.readiness.http, "http://127.0.0.1:5999/gateway/health");
  assert.equal(entry.stop.http, "http://127.0.0.1:5999/api/manager/shutdown");
  assert.equal(entry.logs.out, path.join(root, "logs", "entry", "entry.out.log"));
  const tts = components.resolveComponent(spec(registry, "tts-gateway"), { aiRoot: root, config: loaded, runtime });
  assert.deepEqual(tts.argv.slice(0, 2), ["pwsh.exe", "-NoProfile"]);
  assert.deepEqual(tts.requires.files, [path.join(root, "tts-runtime", "envs", "gateway", "Scripts", "python.exe")]);
  assert.equal(tts.cwd, root);
  const mcp = components.resolveComponent(spec(registry, "platform-mcp"), { aiRoot: root, config: loaded, runtime });
  assert.equal(mcp.env.PLATFORM_MCP_AUDIT_LOG, path.join(root, "audit-logs", "platform-mcp.jsonl"));
  assert.equal(mcp.env.PLATFORM_MCP_SERVICE_ENTRY_URL, "http://127.0.0.1:5999");
  const elsewhere = path.join(root, "elsewhere");
  const custom = components.resolveComponent(spec(registry, "tts-gateway"), { aiRoot: root, config: loaded, runtime: { ...runtime, ttsRuntimeRoot: elsewhere } });
  assert.deepEqual(custom.requires.files, [path.join(elsewhere, "envs", "gateway", "Scripts", "python.exe")]);
});

test("${DOCKER} expands to docker.exe, or to wsl.exe -d <distro> --exec docker", (t) => {
  const root = tempDir(t);
  const registry = registryFor(root);
  const runtime = { registry, nodeExe: "node.exe", pwsh: "pwsh.exe" };
  const resolve = (env) => components.resolveComponent(spec(registry, "docker"), { aiRoot: root, config: loadedConfig(root, undefined, env), runtime });
  const plain = resolve({});
  assert.deepEqual(plain.readiness.command, ["docker.exe", "info", "--format", "{{.ServerVersion}}"]);
  assert.equal(plain.ensure.mode, "start");
  const wsl = resolve({ DOCKER_WSL_DISTRO: "Ubuntu-24.04" });
  assert.deepEqual(wsl.readiness.command, ["wsl.exe", "-d", "Ubuntu-24.04", "--exec", "docker", "info", "--format", "{{.ServerVersion}}"]);
  // config rejects a bad distro, but a registry caller can still hand one in.
  const loaded = loadedConfig(root, undefined);
  const bad = components.resolveComponent(spec(registry, "docker"), { aiRoot: root, config: { ...loaded, values: { ...loaded.values, "docker.wslDistro": "bad distro;" } }, runtime });
  assert.equal(bad.blocked?.reason, "registry-invalid");
});

test("an unknown placeholder at resolve time blocks the component instead of throwing", (t) => {
  const root = tempDir(t);
  const resolved = components.resolveComponent(
    { id: "demo-one", kind: "node", profile: "core", autostart: true, label: { "zh-CN": "一", "en-US": "One" }, command: "${NODE}", args: ["${mystery}"] },
    { aiRoot: root, config: loadedConfig(root, undefined), runtime: { nodeExe: "node.exe" } },
  );
  assert.equal(resolved.blocked.reason, "registry-invalid");
  assert.equal(resolved.problems[0].code, "unknown_placeholder");
});

test("a listener is never spawned and resolves as disabled when its when is false", (t) => {
  const root = tempDir(t);
  const registry = registryFor(root);
  const runtime = { registry, nodeExe: "node.exe", pwsh: "pwsh.exe" };
  const resolve = (env) => components.resolveComponent(spec(registry, "service-entry-public"), { aiRoot: root, config: loadedConfig(root, undefined, env), runtime });
  const on = resolve({});
  assert.equal(on.enabled, true);
  assert.deepEqual(on.ports, [{ name: "public", port: 5186, bind: "127.0.0.1", enabled: true }]);
  const off = resolve({ SERVICE_ENTRY_PUBLIC_LISTENER: "0" });
  assert.equal(off.enabled, false);
  assert.deepEqual(off.urls, {});
  assert.equal(off.kind, "listener");
  assert.equal(off.argv, undefined);
  assert.equal(off.env, undefined);
});

test("startOrder is topological over dependsOn and after; E_CYCLE names the cycle", (t) => {
  const registry = registryFor(tempDir(t));
  const everything = registry.components.map((component) => component.id);
  const order = components.startOrder(registry, everything);
  const before = (first, second) => assert.ok(order.indexOf(first) < order.indexOf(second), `${first} before ${second}`);
  before("docker", "entry");
  before("entry", "service-entry-public");
  before("entry", "vllm-manager");
  before("docker", "llama-manager");
  before("vllm-manager", "platform-mcp");
  before("llama-manager", "platform-mcp");
  before("entry", "tts-gateway");
  before("tts-gateway", "tts-workers");
  before("docker", "search-gateway");
  assert.deepEqual(components.startOrder(registry, ["llama", "docker"]), ["docker", "llama-manager"]);
  assert.deepEqual(components.startOrder(registry, ["docker", "docker"]), ["docker"]);
  assert.throws(() => components.startOrder(registry, ["nope"]), { code: "E_UNKNOWN_COMPONENT" });

  const cyclic = JSON.parse(JSON.stringify(registry));
  spec(cyclic, "docker").after = ["search-gateway"];
  assert.throws(() => components.startOrder(cyclic, everything), (error) => {
    assert.equal(error.code, "E_CYCLE");
    assert.equal(error.cycle[0], error.cycle[error.cycle.length - 1]);
    assert.ok(error.cycle.includes("docker") && error.cycle.includes("search-gateway"));
    assert.match(error.message, /->/);
    return true;
  });
  // The edge only matters when both ends are selected.
  assert.doesNotThrow(() => components.startOrder(cyclic, ["docker", "entry"]));
});

test("stopOrder reverses the start order and omits docker, listeners and detect-only entries", (t) => {
  const registry = registryFor(tempDir(t));
  const everything = registry.components.map((component) => component.id);
  const stop = components.stopOrder(registry, everything);
  const expected = components.startOrder(registry, everything).reverse().filter((id) => !["docker", "service-entry-public", "legacy-claude-proxy"].includes(id));
  assert.deepEqual(stop, expected);
  assert.equal(stop[stop.length - 1], "entry");
});

test("profiles: core, full, all alias, on-demand and unknown names", (t) => {
  const registry = registryFor(tempDir(t));
  const core = ["docker", "entry", "service-entry-public", "vllm-manager", "llama-manager"];
  assert.deepEqual(components.selectProfile(registry, "core"), core);
  const full = components.selectProfile(registry, "full");
  assert.deepEqual(full, [...core, "platform-mcp", "tts-gateway", "search-gateway"]);
  assert.deepEqual(components.selectProfile(registry, "all"), full);
  assert.ok(!full.includes("tts-workers"));
  assert.ok(components.selectProfile(registry, "all", { includeOnDemand: true }).includes("tts-workers"));
  assert.ok(!components.selectProfile(registry, "full", { includeOnDemand: true }).includes("legacy-claude-proxy"));
  assert.throws(() => components.selectProfile(registry, "bogus"), { code: "E_UNKNOWN_PROFILE" });
  assert.throws(() => components.selectProfile(registry, "none"), { code: "E_UNKNOWN_PROFILE" });
});

test("componentsForPaths maps changes to components, honours negation and adds the supervisor", (t) => {
  const registry = registryFor(tempDir(t));
  const map = (...paths) => Array.from(components.componentsForPaths(registry, paths)).sort();
  assert.deepEqual(map("service-entry/server.js"), ["entry"]);
  assert.deepEqual(map("manager-core/index.js"), ["entry", "llama-manager", "vllm-manager"]);
  // manager-core/platform/** is negated for the managers and the entry, and belongs to the supervisor.
  assert.deepEqual(map("manager-core/platform/config.js"), ["supervisor"]);
  assert.deepEqual(map("scripts/platformctl.js"), ["supervisor"]);
  assert.deepEqual(map("manager-core/data/platform-components.json"), ["entry", "llama-manager", "supervisor", "vllm-manager"]);
  assert.deepEqual(map("manager-core/data/platform-config.d/telemetry.schema.json"), ["entry", "llama-manager", "supervisor", "vllm-manager"]);
  assert.deepEqual(map("shared-public/vendor/x.js"), ["entry", "llama-manager", "vllm-manager"]);
  assert.deepEqual(map("platform-mcp/src/a.ts"), ["platform-mcp"]);
  assert.deepEqual(map("tts-platform/scripts/start_gateway.ps1"), ["tts-gateway"]);
  assert.deepEqual(map("search-gateway/app.py"), ["search-gateway"]);
  assert.deepEqual(map("docs/readme.md"), []);
  assert.deepEqual(map(".\\service-entry\\lib\\a.js"), ["entry"]);
  assert.deepEqual(map("README.md", "SERVICE-ENTRY/x.js"), ["entry"]);
});

test("getComponent finds by id or legacy id", (t) => {
  const registry = registryFor(tempDir(t));
  assert.equal(components.getComponent(registry, "mcp").id, "platform-mcp");
  assert.equal(components.getComponent(registry, "entry").id, "entry");
  assert.equal(components.getComponent(registry, "missing"), null);
});

// The resolved registry with the temp root replaced and separators unified,
// so the golden holds no machine path.
function normalizeForGolden(value, root) {
  const text = JSON.stringify(value);
  const doubled = root.split("\\").join("\\\\");
  return JSON.parse(text.split(doubled).join("<AI_ROOT>").split(root).join("<AI_ROOT>").split("\\\\").join("/"));
}

test("golden: resolveComponent for every component under the default config", (t) => {
  const root = tempDir(t);
  const registry = registryFor(root);
  const loaded = loadedConfig(root, undefined);
  const runtime = { registry, nodeExe: "node.exe", pwsh: "pwsh.exe", dockerExe: "docker.exe", secrets: fakeVault(STORE_KEYS) };
  const resolved = {};
  for (const component of registry.components) resolved[component.id] = components.resolveComponent(component, { aiRoot: root, config: loaded, runtime });
  const actual = normalizeForGolden(resolved, root);
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  }
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(GOLDEN, "utf8")));
  // The golden's contract, spelled out: managers on loopback, the legacy remote switches off.
  assert.equal(actual["vllm-manager"].env.VLLM_MANAGER_HOST, "127.0.0.1");
  assert.equal(actual["vllm-manager"].env.VLLM_MANAGER_ALLOW_REMOTE, "0");
  assert.equal(actual["llama-manager"].env.LLAMA_MANAGER_HOST, "127.0.0.1");
  assert.equal(actual["llama-manager"].env.LLAMA_MANAGER_ALLOW_REMOTE, "0");
  assert.equal(actual.entry.urls.admin, "http://127.0.0.1:5176");
  assert.equal(actual["service-entry-public"].urls.public, "http://127.0.0.1:5186");
  assert.equal(actual["platform-mcp"].env.PLATFORM_MCP_API_KEY, FAKE_KEY_MCP);
  assert.equal(actual["platform-mcp"].env.PLATFORM_MCP_HOST, "127.0.0.1");
  const text = JSON.stringify(actual);
  assert.equal(text.includes(os.tmpdir().split("\\").join("/")), false);
  assert.equal(text.includes(os.userInfo().username), false);
  assert.equal(text.includes(root.split("\\").join("/")), false);
});

test("a secret reaches a component through env only, never through argv or a probe", (t) => {
  const root = tempDir(t);
  const registry = registryFor(root);
  const runtime = { registry, nodeExe: "node.exe", pwsh: "pwsh.exe", secrets: fakeVault(STORE_KEYS) };
  for (const component of registry.components) {
    const resolved = components.resolveComponent(component, { aiRoot: root, config: loadedConfig(root, undefined), runtime });
    const exposed = JSON.stringify([resolved.argv, resolved.args, resolved.readiness, resolved.liveness, resolved.stop, resolved.busy, resolved.members?.map((member) => member.argv)]);
    for (const key of [FAKE_KEY_MCP, FAKE_KEY_SEARCH, FAKE_KEY_UPSTREAM]) assert.equal(exposed.includes(key), false, `${component.id} must not carry a key outside env`);
  }
  const without = components.resolveComponent(spec(registry, "platform-mcp"), { aiRoot: root, config: loadedConfig(root, undefined), runtime: { registry, nodeExe: "node.exe" } });
  assert.equal(without.env.PLATFORM_MCP_API_KEY, undefined);
});
