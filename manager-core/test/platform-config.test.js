"use strict";

// Platform config (docs/overhaul/06-ops.md §4, §14): the schema and its
// fragments, the env map, precedence, sections and the only writer of
// platform.json. Every case works on a temp AI root and passes its env
// explicitly, so neither this machine's environment nor a real
// <AI_ROOT>/config/platform.json can leak in. Secret values are fake.

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("..");
const config = require("../platform/config");

const CONFIG_MODULE = path.join(__dirname, "..", "platform", "config.js");
const CORE_SCHEMA = path.join(__dirname, "..", "data", "platform-config.schema.json");
const BUNDLED_FRAGMENTS = path.join(__dirname, "..", "data", "platform-config.d");
const NO_ENV = Object.freeze({});

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A temp AI root, optionally with config/platform.json (an object, a string
// or raw bytes).
function tempRoot(t, platformJson) {
  const root = tempDir(t, "platform-config-");
  if (platformJson !== undefined) writePlatformJson(root, platformJson);
  return root;
}

function configFile(root) {
  return path.join(root, "config", "platform.json");
}

function writePlatformJson(root, value) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  const content = Buffer.isBuffer(value) || typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(configFile(root), content);
}

function readPlatformJson(root) {
  return JSON.parse(fs.readFileSync(configFile(root), "utf8"));
}

function changeLogLines(root) {
  const file = path.join(root, "logs", "platform", "config-changes.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function load(root, extra = {}) {
  return config.loadPlatformConfig({ aiRoot: root, env: NO_ENV, ...extra });
}

function fragmentDir(t, fragments) {
  const dir = tempDir(t, "platform-config-d-");
  for (const [name, content] of Object.entries(fragments)) {
    fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function leaf(extra) {
  return {
    title: { "zh-CN": "测试设置", "en-US": "Test setting" },
    description: { "zh-CN": "仅用于测试的设置。", "en-US": "A setting used by the tests only." },
    restartRequired: false,
    secret: false,
    ...extra,
  };
}

// A trimmed 04 §20 telemetry fragment, as TEL would ship it.
function telemetryFragment(extra = {}) {
  return {
    schemaVersion: 1,
    namespace: "telemetry",
    owner: "04-telemetry",
    asOf: "2026-10-14",
    staleAfterDays: 365,
    title: { "zh-CN": "遥测", "en-US": "Telemetry" },
    properties: {
      enabled: leaf({ type: "boolean", default: true, env: ["TELEMETRY_ENABLED"], consumers: ["entry"], restartRequired: ["entry"] }),
      sampleIntervalMs: leaf({ type: "integer", minimum: 5000, maximum: 60000, default: 10000, env: ["TELEMETRY_SAMPLE_INTERVAL_MS"], consumers: ["entry"] }),
      timezoneOffsetMinutes: leaf({ type: "integer", minimum: -720, maximum: 840, default: 480 }),
      retention: {
        type: "object",
        properties: {
          requestsDays: leaf({ type: "integer", minimum: 1, maximum: 3650, default: 30 }),
          ipDays: leaf({ type: "integer", minimum: 1, maximum: 3650, default: 30 }),
        },
      },
      energy: {
        type: "object",
        properties: {
          pricePerKwh: leaf({ type: ["number", "null"], minimum: 0, default: null }),
          tariffs: leaf({
            type: "array",
            default: [],
            items: { type: "object", additionalProperties: false, properties: { from: { type: "string", pattern: "^\\d{2}:\\d{2}$" }, to: { type: "string", pattern: "^\\d{2}:\\d{2}$" }, pricePerKwh: { type: "number", minimum: 0 } } },
          }),
        },
      },
      ...extra,
    },
  };
}

function fakeVault() {
  const entries = new Map();
  const calls = [];
  const id = (namespace, name) => `${namespace}/${name}`;
  return {
    calls,
    has: (namespace, name) => entries.has(id(namespace, name)),
    get: (namespace, name) => entries.get(id(namespace, name))?.value || "",
    list: (namespace) => Array.from(entries)
      .filter(([key]) => key.startsWith(`${namespace}/`))
      .map(([key, entry]) => ({ name: key.slice(namespace.length + 1), updatedAt: entry.updatedAt })),
    async set(namespace, name, value) {
      calls.push(["set", namespace, name]);
      entries.set(id(namespace, name), { value, updatedAt: "2026-10-14T00:00:00.000Z" });
    },
    async clear(namespace, name) {
      calls.push(["clear", namespace, name]);
      return entries.delete(id(namespace, name));
    },
  };
}

function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else files.push(full);
  }
  return files;
}

// --- schema ---------------------------------------------------------------

test("the bundled schema loads cleanly, carries its data-file fields and every leaf has bilingual copy", () => {
  const raw = JSON.parse(fs.readFileSync(CORE_SCHEMA, "utf8"));
  assert.equal(raw.schemaVersion, 1);
  assert.match(raw.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(raw.staleAfterDays > 0);

  const schema = config.loadPlatformSchema();
  assert.deepEqual(schema.errors, []);
  assert.ok(fs.existsSync(path.join(BUNDLED_FRAGMENTS, ".gitkeep")), "the fragment directory ships with a .gitkeep");
  const groupIds = new Set(schema.groups.map((group) => group.id));
  const defaults = load(path.join(os.tmpdir(), "platform-config-root-that-is-never-created")).values;
  for (const item of schema.leaves.values()) {
    for (const locale of ["zh-CN", "en-US"]) {
      assert.ok(String(item.title?.[locale] || "").trim(), `${item.key} needs a ${locale} title`);
      assert.ok(String(item.description?.[locale] || "").trim(), `${item.key} needs a ${locale} description`);
    }
    assert.ok(groupIds.has(item.group), `${item.key} names a declared group (${item.group})`);
    if (!item.secret) assert.deepEqual(config.validateLeafValue(item, defaults[item.key]), [], `${item.key} default validates`);
  }
  // The namespaces 00 §9.5 gives OPS-3, and the rest of §4.3, live in the core file.
  for (const key of [
    "listeners.admin.host", "listeners.admin.port", "listeners.admin.lan",
    "listeners.public.enabled", "listeners.public.host", "listeners.public.port", "listeners.public.lan", "listeners.public.baseUrl",
    "admin.sessionDays", "admin.legacyProxyGateway", "trustedProxies.cidrs", "trustedProxies.clientIpHeader",
    "exposure.requireApiKey", "exposure.allowedOrigins", "managers.bindHost", "console.defaultUi",
    "docker.waitTimeoutSec", "platformMcp.apiKey", "search.apiKey", "hf.token", "supervisor.restoreModels", "components",
  ]) {
    assert.ok(schema.leaves.has(key), `${key} is in the core schema`);
  }
  // There is no entry.* and no exposure.lan / exposure.public.* key (§4.1).
  assert.equal(Array.from(schema.leaves.keys()).some((key) => /^entry\.|^exposure\.(?:lan|public)/.test(key)), false);
});

test("defaults: managers bind 127.0.0.1, the classic console is the default UI and a missing file is valid", (t) => {
  const root = tempRoot(t);
  const loaded = load(root);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.exists, false);
  assert.equal(loaded.etag, "none");
  assert.equal(loaded.values["managers.bindHost"], "127.0.0.1");
  assert.equal(loaded.sources["managers.bindHost"], "default");
  assert.equal(loaded.values["console.defaultUi"], "classic");
  assert.equal(loaded.sources["console.defaultUi"], "default");
  assert.equal(loaded.values["managers.vllm.host"], "127.0.0.1");
  assert.equal(loaded.sources["managers.vllm.host"], "derived");
  assert.equal(loaded.values["listeners.admin.host"], "127.0.0.1");
  assert.equal(loaded.values["listeners.admin.port"], 5176);
  assert.equal(loaded.values["listeners.public.port"], 5186);
  assert.equal(loaded.values["docker.waitTimeoutSec"], 120);
  assert.equal(loaded.values["exposure.requireApiKey"], "auto");
  assert.deepEqual(loaded.values["trustedProxies.cidrs"], ["127.0.0.1/32", "::1/128"]);
  assert.equal(loaded.values["paths.hfHome"], path.join(root, "cache", "huggingface"));
  assert.equal(loaded.get("admin.sessionDays"), 180);

  const managers = config.readSection("managers", { aiRoot: root, env: NO_ENV });
  assert.deepEqual(managers.values, { bindHost: "127.0.0.1", vllm: { host: "127.0.0.1", port: 5177 }, llama: { host: "127.0.0.1", port: 5178 } });
  assert.deepEqual(config.readSection("console", { aiRoot: root, env: NO_ENV }).values, { defaultUi: "classic" });
  assert.equal(fs.existsSync(path.join(root, "config")), false, "reading never creates files");
});

// --- precedence -----------------------------------------------------------

test("precedence is runtime > env > file > derived > default", async (t) => {
  const cases = [
    { name: "default", key: "listeners.admin.port", value: 5176, source: "default" },
    { name: "file", file: { listeners: { admin: { port: 6101 } } }, key: "listeners.admin.port", value: 6101, source: "file" },
    { name: "env over file", file: { listeners: { admin: { port: 6101 } } }, env: { SERVICE_ENTRY_PORT: "6102" }, key: "listeners.admin.port", value: 6102, source: "env" },
    {
      name: "runtime over env",
      file: { listeners: { admin: { port: 6101 } } },
      env: { SERVICE_ENTRY_PORT: "6102" },
      runtime: { "listeners.admin.port": 6103 },
      key: "listeners.admin.port",
      value: 6103,
      source: "runtime",
    },
    { name: "derived host from lan", file: { listeners: { admin: { lan: true } } }, key: "listeners.admin.host", value: "0.0.0.0", source: "derived" },
    { name: "file host over derived", file: { listeners: { admin: { lan: true, host: "192.0.2.10" } } }, key: "listeners.admin.host", value: "192.0.2.10", source: "file" },
    { name: "runtime lan derives host", runtime: { "listeners.admin.lan": true }, key: "listeners.admin.host", value: "0.0.0.0", source: "derived" },
    { name: "public host from public lan", file: { listeners: { public: { lan: true } } }, key: "listeners.public.host", value: "0.0.0.0", source: "derived" },
    { name: "manager host from bindHost", file: { managers: { bindHost: "0.0.0.0" } }, key: "managers.llama.host", value: "0.0.0.0", source: "derived" },
    { name: "manager host env over derived", file: { managers: { bindHost: "0.0.0.0" } }, env: { LLAMA_MANAGER_HOST: "127.0.0.1" }, key: "managers.llama.host", value: "127.0.0.1", source: "env" },
    { name: "flag env", env: { SERVICE_ENTRY_ALLOW_LAN_ADMIN: "1" }, key: "listeners.admin.lan", value: true, source: "env" },
    { name: "inverted flag env", env: { SERVICE_ENTRY_NO_BROWSER: "1" }, key: "cli.openBrowser", value: false, source: "env" },
    { name: "env value alias", env: { SERVICE_ENTRY_REQUIRE_API_KEY: "1" }, key: "exposure.requireApiKey", value: "on", source: "env" },
    { name: "csv env", env: { SERVICE_ENTRY_TRUSTED_PROXIES: "10.0.0.0/8; 127.0.0.1" }, key: "trustedProxies.cidrs", value: ["10.0.0.0/8", "127.0.0.1"], source: "env" },
  ];
  for (const item of cases) {
    await t.test(item.name, (tt) => {
      const root = tempRoot(tt, item.file);
      const loaded = config.loadPlatformConfig({ aiRoot: root, env: item.env || {}, runtimeOverrides: item.runtime });
      assert.deepEqual(loaded.values[item.key], item.value);
      assert.equal(loaded.sources[item.key], item.source);
      assert.deepEqual(loaded.errors, []);
    });
  }
});

test("an invalid value falls back to the next source and is reported", (t) => {
  const root = tempRoot(t, { listeners: { admin: { port: 6111 } }, admin: { sessionDays: 0 }, console: { defaultUi: "fancy" } });
  const loaded = load(root, { env: { SERVICE_ENTRY_PORT: "not-a-port" }, runtimeOverrides: { "admin.sessionDays": "long" } });
  assert.equal(loaded.values["listeners.admin.port"], 6111);
  assert.equal(loaded.sources["listeners.admin.port"], "file");
  assert.equal(loaded.values["admin.sessionDays"], 180);
  assert.equal(loaded.sources["admin.sessionDays"], "default");
  assert.equal(loaded.values["console.defaultUi"], "classic");
  const byField = (field) => loaded.errors.filter((error) => error.field === field).map((error) => `${error.source}:${error.code}`);
  assert.deepEqual(byField("listeners.admin.port"), ["env:invalid_type"]);
  assert.deepEqual(byField("admin.sessionDays"), ["runtime:invalid_type", "file:out_of_range"]);
  assert.deepEqual(byField("console.defaultUi"), ["file:invalid_value"]);
});

test("aliased env names: the first one set wins and differing values warn", (t) => {
  const root = tempRoot(t);
  const loaded = load(root, { env: { SEARCH_GATEWAY_API_KEY: "fake-search-key-one", SERVICE_ENTRY_SEARCH_GATEWAY_KEY: "fake-search-key-two" } });
  assert.deepEqual(loaded.values["search.apiKey"], { set: true });
  assert.equal(loaded.sources["search.apiKey"], "env");
  const describedText = JSON.stringify([loaded, config.describeEffectiveConfig(loaded, { includeSecrets: true })]);
  assert.equal(describedText.includes("fake-search-key"), false);

  const root2 = tempRoot(t);
  const schema = config.loadPlatformSchema({ fragmentDir: fragmentDir(t, {
    "public.schema.json": {
      schemaVersion: 1, namespace: "public", owner: "05-public", asOf: "2026-10-14", staleAfterDays: 365,
      properties: { managersGatewayOnly: leaf({ type: "string", enum: ["off", "warn", "enforce"], default: "warn", env: ["MANAGER_GATEWAY_ONLY", "MANAGER_GATEWAY_MODE"] }) },
    },
  }) });
  const aliased = config.loadPlatformConfig({ aiRoot: root2, schema, env: { MANAGER_GATEWAY_ONLY: "enforce", MANAGER_GATEWAY_MODE: "off" } });
  assert.equal(aliased.values["public.managersGatewayOnly"], "enforce");
  assert.ok(aliased.warnings.some((warning) => warning.code === "env_alias_conflict" && warning.field === "public.managersGatewayOnly"));
});

test("PLATFORM_CONFIG_ENV_KEYS demotes injected env, so a child reports file or default", (t) => {
  const root = tempRoot(t, { listeners: { admin: { port: 6201 } }, console: { defaultUi: "new" } });
  const parent = load(root);
  const { env: injected, injectedKeys } = config.childEnv(parent, "entry");
  assert.equal(injected.SERVICE_ENTRY_PORT, "6201");
  assert.equal(injected.SERVICE_ENTRY_CONSOLE_DEFAULT, "new");
  assert.equal(injected.SERVICE_ENTRY_HOST, "127.0.0.1");
  assert.equal(injected.SERVICE_ENTRY_ALLOW_LAN_ADMIN, "0");
  assert.equal(injected.PLATFORM_CONFIG_FILE, configFile(root));
  assert.deepEqual(injected.PLATFORM_CONFIG_ENV_KEYS.split(","), injectedKeys);
  assert.ok(injectedKeys.includes("SERVICE_ENTRY_PORT"));
  assert.equal("VLLM_MANAGER_PORT" in injected, true, "the entry reads the manager ports too");
  assert.equal("PLATFORM_MCP_API_KEY" in injected, false, "secrets are injected only with a store");

  // The child sees the injected values as file/default/derived, never env.
  const child = config.loadPlatformConfig({ aiRoot: root, env: injected });
  assert.equal(child.values["listeners.admin.port"], 6201);
  assert.equal(child.sources["listeners.admin.port"], "file");
  assert.equal(child.sources["console.defaultUi"], "file");
  assert.equal(child.sources["listeners.admin.lan"], "default");
  assert.equal(child.sources["listeners.admin.host"], "derived");
  for (const key of child.envSet ? Object.keys(child.envSet) : []) assert.deepEqual(child.envSet[key], [], `${key} is not reported as env`);

  // A real env value (not listed) stays env and is not overwritten.
  const shell = config.loadPlatformConfig({ aiRoot: root, env: { ...injected, SERVICE_ENTRY_PORT: "6202", PLATFORM_CONFIG_ENV_KEYS: "SERVICE_ENTRY_CONSOLE_DEFAULT" } });
  assert.equal(shell.values["listeners.admin.port"], 6202);
  assert.equal(shell.sources["listeners.admin.port"], "env");
  assert.equal("SERVICE_ENTRY_PORT" in config.childEnv(shell, "entry").env, false);

  // With an empty platform.json both managers get *_MANAGER_HOST=127.0.0.1,
  // and MCP gets its URLs from the configured ports.
  const empty = load(tempRoot(t, { schemaVersion: 1 }));
  assert.equal(config.childEnv(empty, "vllm-manager").env.VLLM_MANAGER_HOST, "127.0.0.1");
  assert.equal(config.childEnv(empty, "llama-manager").env.LLAMA_MANAGER_HOST, "127.0.0.1");
  const mcp = config.childEnv(load(root), "platform-mcp").env;
  assert.equal(mcp.PLATFORM_MCP_SERVICE_ENTRY_URL, "http://127.0.0.1:6201");
  assert.equal(mcp.PLATFORM_MCP_VLLM_MANAGER_URL, "http://127.0.0.1:5177");
  assert.equal(mcp.PLATFORM_MCP_PORT, "5190");
  // A legacy id resolves through the registry.
  assert.equal(config.childEnv(empty, "vllm", { components: [{ id: "vllm-manager", legacyId: "vllm" }] }).env.VLLM_MANAGER_HOST, "127.0.0.1");
});

test("childEnv injects secrets from the store only into their consumers, through env", async (t) => {
  const root = tempRoot(t);
  const vault = fakeVault();
  await vault.set("platform", "platformMcp.apiKey", "fake-mcp-key-for-tests-0000000000000000");
  await vault.set("platform", "search.apiKey", "fake-search-key-for-tests");
  const loaded = load(root, { secrets: vault });
  assert.deepEqual(loaded.values["platformMcp.apiKey"], { set: true });
  assert.equal(loaded.sources["platformMcp.apiKey"], "store");
  const mcp = config.childEnv(loaded, "platform-mcp", null, { secrets: vault });
  assert.equal(mcp.env.PLATFORM_MCP_API_KEY, "fake-mcp-key-for-tests-0000000000000000");
  assert.equal(mcp.env.PLATFORM_MCP_SEARCH_GATEWAY_API_KEY, "fake-search-key-for-tests");
  assert.equal(mcp.env.PLATFORM_CONFIG_ENV_KEYS.includes("fake"), false, "the key list carries names only");
  const entry = config.childEnv(loaded, "entry", null, { secrets: vault }).env;
  assert.equal("PLATFORM_MCP_API_KEY" in entry, false);
  assert.equal(entry.SERVICE_ENTRY_SEARCH_GATEWAY_KEY, "fake-search-key-for-tests");
  assert.equal("SEARCH_GATEWAY_API_KEY" in entry, false);
});

// --- file handling ----------------------------------------------------------

test("a BOM-prefixed file is read, and corrupt or unreadable files never throw", async (t) => {
  const bom = tempRoot(t, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ console: { defaultUi: "new" } }))]));
  const fromBom = load(bom);
  assert.deepEqual(fromBom.errors, []);
  assert.equal(fromBom.values["console.defaultUi"], "new");
  assert.equal(fromBom.sources["console.defaultUi"], "file");

  for (const [name, content] of [["corrupt", "{ not json"], ["array", "[1, 2]"], ["empty", ""], ["number", "42"]]) {
    const root = tempRoot(t, content);
    const loaded = load(root);
    assert.equal(loaded.errors[0].code, "parse_error", name);
    assert.equal(loaded.errors[0].field, "$file", name);
    assert.equal(loaded.values["listeners.admin.port"], 5176, name);
    assert.equal(loaded.sources["listeners.admin.port"], "default", name);
    const section = config.readSection("listeners", { aiRoot: root, env: NO_ENV });
    assert.equal(section.values.admin.port, 5176);
    assert.equal(section.errors[0].code, "parse_error");
    assert.ok(config.describeEffectiveConfig(loaded).groups.length > 0);
    // The writer refuses to replace a file it cannot read.
    const before = fs.readFileSync(configFile(root));
    const result = await config.writeSection("console", { defaultUi: "new" }, { aiRoot: root, actor: "test" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "config_invalid");
    assert.deepEqual(fs.readFileSync(configFile(root)), before, `${name} stays byte-identical`);
  }

  const dirRoot = tempRoot(t);
  fs.mkdirSync(configFile(dirRoot), { recursive: true });
  const fromDir = load(dirRoot);
  assert.equal(fromDir.errors[0].code, "read_error");
  assert.equal(fromDir.values["console.defaultUi"], "classic");
});

test("unknown and retired keys are warnings, so an older build reads a newer file", (t) => {
  const root = tempRoot(t, {
    schemaVersion: 1,
    console: { defaultUi: "new", theme: "dark" },
    futureNamespace: { enabled: true },
    entry: { port: 5176 },
    exposure: { lan: true },
  });
  const loaded = load(root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.values["console.defaultUi"], "new");
  const warnings = Object.fromEntries(loaded.warnings.map((warning) => [warning.field, warning]));
  assert.equal(warnings["console.theme"].code, "unknown_key");
  assert.equal(warnings.futureNamespace.code, "unknown_key");
  assert.equal(warnings.entry.movedTo, "listeners.admin");
  assert.equal(warnings["exposure.lan"].movedTo, "listeners.admin.lan");
});

test("unknown keys survive a write by this build", async (t) => {
  const root = tempRoot(t, { schemaVersion: 1, futureNamespace: { enabled: true } });
  const result = await config.writeSection("console", { defaultUi: "new" }, { aiRoot: root, actor: "test" });
  assert.equal(result.ok, true);
  assert.deepEqual(readPlatformJson(root), { schemaVersion: 1, futureNamespace: { enabled: true }, console: { defaultUi: "new" } });
});

// --- cross-field rules ------------------------------------------------------

test("cross-field rules: lan_implied_by_host, insecure_combination, port_conflict, invalid_format", async (t) => {
  const implied = load(tempRoot(t), { env: { SERVICE_ENTRY_HOST: "0.0.0.0" } });
  assert.equal(implied.values["listeners.admin.lan"], true);
  assert.equal(implied.sources["listeners.admin.lan"], "derived");
  assert.ok(implied.warnings.some((warning) => warning.code === "lan_implied_by_host"));

  const insecure = load(tempRoot(t, { listeners: { admin: { lan: true } }, exposure: { requireApiKey: "off" } }));
  assert.equal(insecure.errors.find((error) => error.code === "insecure_combination")?.field, "exposure.requireApiKey");
  const lanRoot = tempRoot(t, { listeners: { admin: { lan: true } } });
  const refused = await config.writeSection("exposure", { requireApiKey: "off" }, { aiRoot: lanRoot, actor: "test" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "config_invalid");
  assert.equal(refused.status, 400);
  assert.equal(refused.errors[0].code, "insecure_combination");
  assert.deepEqual(readPlatformJson(lanRoot), { listeners: { admin: { lan: true } } });

  const conflict = load(tempRoot(t, { listeners: { public: { port: 5176 } } }));
  assert.deepEqual(conflict.errors.map((error) => error.code), ["port_conflict"]);
  assert.deepEqual(conflict.errors[0].fields, ["listeners.admin.port", "listeners.public.port"]);
  const reserved = load(tempRoot(t), { reservedPorts: [{ name: "searxng", port: 5190 }] });
  assert.equal(reserved.errors[0].code, "port_conflict");
  const portRoot = tempRoot(t);
  const portRefused = await config.writeSection("listeners", { public: { port: 5177 } }, { aiRoot: portRoot, actor: "test" });
  assert.equal(portRefused.code, "config_invalid");
  assert.equal(portRefused.errors[0].code, "port_conflict");
  assert.equal(fs.existsSync(configFile(portRoot)), false);

  const formats = load(tempRoot(t, { listeners: { public: { baseUrl: "http://models.example.test" } }, trustedProxies: { cidrs: ["10.0.0.0/33"] } }));
  assert.deepEqual(formats.errors.map((error) => `${error.field}:${error.code}`).sort(), ["listeners.public.baseUrl:invalid_format", "trustedProxies.cidrs:invalid_format"]);
  assert.equal(formats.values["listeners.public.baseUrl"], "");
  const formatRefused = await config.writeSection("listeners", { public: { baseUrl: "ftp://models.example.test" } }, { aiRoot: tempRoot(t), actor: "test" });
  assert.equal(formatRefused.errors[0].code, "invalid_format");
  const ok = await config.writeSection("listeners", { public: { baseUrl: "https://models.example.test" } }, { aiRoot: tempRoot(t), actor: "test" });
  assert.equal(ok.ok, true);

  // A problem already in the file does not block an unrelated write.
  const existing = tempRoot(t, { listeners: { public: { port: 5176 } } });
  const unrelated = await config.writeSection("console", { defaultUi: "new" }, { aiRoot: existing, actor: "test" });
  assert.equal(unrelated.ok, true);
});

// --- the writer --------------------------------------------------------------

test("writes are atomic, keep a .bak and log the changed keys without values", async (t) => {
  const root = tempRoot(t, { listeners: { admin: { port: 6301 } } });
  const original = fs.readFileSync(configFile(root));
  const { etag } = config.readSection("listeners", { aiRoot: root, env: NO_ENV });
  const result = await config.writePlatformConfig({
    aiRoot: root,
    set: { "listeners.admin.port": 6302, "console.defaultUi": "new" },
    etag,
    actor: "test-suite",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, ["console.defaultUi", "listeners.admin.port"]);
  assert.deepEqual(result.restartRequired, ["entry", "platform-mcp", "search-gateway"]);
  assert.deepEqual(readPlatformJson(root), { listeners: { admin: { port: 6302 } }, schemaVersion: 1, console: { defaultUi: "new" } });
  assert.deepEqual(fs.readFileSync(`${configFile(root)}.bak`), original);
  assert.deepEqual(fs.readdirSync(path.join(root, "config")).sort(), ["platform.json", "platform.json.bak"], "no tmp or lock file is left");
  assert.equal(result.etag, config.readSection("console", { aiRoot: root, env: NO_ENV }).etag);
  assert.match(result.etag, /^sha256:[0-9a-f]{16}$/);

  const lines = changeLogLines(root);
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), ["actor", "at", "changed"]);
  assert.equal(lines[0].actor, "test-suite");
  assert.deepEqual(lines[0].changed, ["console.defaultUi", "listeners.admin.port"]);
  assert.equal(JSON.stringify(lines[0]).includes("6302"), false);

  // A default value is not stored, and a write that changes nothing writes nothing.
  const reset = await config.writeSection("listeners", { admin: { port: 5176 } }, { aiRoot: root, actor: "test-suite" });
  assert.deepEqual(reset.changed, ["listeners.admin.port"]);
  assert.deepEqual(readPlatformJson(root), { schemaVersion: 1, console: { defaultUi: "new" } });
  const noop = await config.writeSection("console", { defaultUi: "new" }, { aiRoot: root, actor: "test-suite" });
  assert.equal(noop.ok, true);
  assert.deepEqual(noop.changed, []);
  assert.equal(changeLogLines(root).length, 2);
  // A derived key keeps an explicit value, which pins it.
  const pinned = await config.writeSection("listeners", { admin: { host: "127.0.0.1" } }, { aiRoot: root, actor: "test-suite" });
  assert.deepEqual(pinned.changed, ["listeners.admin.host"]);
  assert.equal(readPlatformJson(root).listeners.admin.host, "127.0.0.1");
});

test("a stale etag is config_conflict and a held lock is config_locked", async (t) => {
  const root = tempRoot(t);
  const first = config.readSection("console", { aiRoot: root, env: NO_ENV });
  assert.equal(first.etag, "none");
  const written = await config.writeSection("console", { defaultUi: "new" }, { aiRoot: root, etag: first.etag, actor: "tab-1" });
  assert.equal(written.ok, true);
  const stale = await config.writeSection("console", { defaultUi: "classic" }, { aiRoot: root, etag: first.etag, actor: "tab-2" });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "config_conflict");
  assert.equal(stale.status, 409);
  assert.equal(stale.etag, written.etag);
  assert.equal(readPlatformJson(root).console.defaultUi, "new");

  const lockFile = `${configFile(root)}.lock`;
  fs.writeFileSync(lockFile, "{}");
  const before = fs.readFileSync(configFile(root));
  const locked = await config.writeSection("console", { defaultUi: "classic" }, { aiRoot: root, actor: "test", lockWaitMs: 50 });
  assert.equal(locked.ok, false);
  assert.equal(locked.code, "config_locked");
  assert.equal(locked.status, 409);
  assert.deepEqual(fs.readFileSync(configFile(root)), before);
  assert.equal(fs.existsSync(lockFile), true, "someone else's lock is left alone");

  // A lock older than 10 s is stale and taken over.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, old, old);
  const recovered = await config.writeSection("console", { defaultUi: "classic" }, { aiRoot: root, actor: "test", lockWaitMs: 50 });
  assert.equal(recovered.ok, true);
  assert.equal(fs.existsSync(lockFile), false);
});

const CONCURRENT_WRITER = `
const config = require(process.argv[1]);
const [root, actor, rounds] = [process.argv[2], process.argv[3], Number(process.argv[4])];
(async () => {
  let done = 0;
  let retries = 0;
  while (done < rounds) {
    const read = config.readSection("admin", { aiRoot: root, env: {} });
    const result = await config.writeSection("admin", { sessionDays: read.values.sessionDays + 1 }, { aiRoot: root, etag: read.etag, actor });
    if (result.ok) { done += 1; continue; }
    if (result.code !== "config_conflict" && result.code !== "config_locked") throw new Error(result.code);
    retries += 1;
    if (retries > 2000) throw new Error("too many retries");
  }
  process.stdout.write(JSON.stringify({ done, retries }));
})().catch((error) => { process.stderr.write(String(error && error.stack || error)); process.exit(1); });
`;

function runWriter(root, actor, rounds) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["-e", CONCURRENT_WRITER, CONFIG_MODULE, root, actor, String(rounds)], { timeout: 120_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${actor} failed: ${stderr || error.message}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

test("two processes writing concurrently through writeSection never lose an update", async (t) => {
  const root = tempRoot(t);
  const rounds = 12;
  const results = await Promise.all([runWriter(root, "writer-a", rounds), runWriter(root, "writer-b", rounds)]);
  assert.deepEqual(results.map((result) => result.done), [rounds, rounds]);
  assert.equal(readPlatformJson(root).admin.sessionDays, 180 + 2 * rounds);
  const lines = changeLogLines(root);
  assert.equal(lines.length, 2 * rounds);
  assert.deepEqual(new Set(lines.map((line) => line.actor)), new Set(["writer-a", "writer-b"]));
  assert.deepEqual(fs.readdirSync(path.join(root, "config")).sort(), ["platform.json", "platform.json.bak"]);
});

// --- secrets -----------------------------------------------------------------

test("secret leaves never reach platform.json or the description, and secret_via_store is enforced", async (t) => {
  const root = tempRoot(t);
  const direct = await config.writePlatformConfig({ aiRoot: root, set: { "platformMcp.apiKey": "fake-direct-value-0001" }, actor: "test" });
  assert.equal(direct.ok, false);
  assert.equal(direct.code, "secret_via_store");
  const viaSection = await config.writeSection("search", { apiKey: "fake-section-value-0002", port: 5181 }, { aiRoot: root, actor: "test" });
  assert.equal(viaSection.code, "secret_via_store");
  assert.equal(fs.existsSync(configFile(root)), false, "a refused write writes nothing");

  // A value planted by hand is ignored and never surfaces.
  writePlatformJson(root, { platformMcp: { apiKey: "fake-planted-value-0003", port: 5191 } });
  const planted = load(root, { env: { HF_TOKEN: "fake-env-value-0004" } });
  assert.ok(planted.errors.some((error) => error.field === "platformMcp.apiKey" && error.code === "secret_via_store"));
  assert.deepEqual(planted.values["platformMcp.apiKey"], { set: null });
  assert.deepEqual(planted.values["hf.token"], { set: true });
  assert.equal(planted.sources["hf.token"], "env");
  const surfaces = JSON.stringify([
    planted,
    config.describeEffectiveConfig(planted),
    config.describeEffectiveConfig(planted, { includeSecrets: true }),
    config.readSection("platformMcp", { aiRoot: root, env: { HF_TOKEN: "fake-env-value-0004" } }),
    config.readSection("hf", { aiRoot: root, env: { HF_TOKEN: "fake-env-value-0004" } }),
  ]);
  for (const value of ["fake-planted-value-0003", "fake-env-value-0004"]) assert.equal(surfaces.includes(value), false, value);
  const described = config.describeEffectiveConfig(planted, { includeSecrets: true });
  const hfItem = described.groups.flatMap((group) => group.items).find((item) => item.key === "hf.token");
  assert.deepEqual(hfItem.secret, { set: true, source: "env" });
  assert.equal("value" in hfItem, false);
  assert.equal(config.describeEffectiveConfig(planted).groups.flatMap((group) => group.items).some((item) => item.key === "hf.token"), false);

  // The planted value can be removed through the writer.
  const cleaned = await config.writePlatformConfig({ aiRoot: root, unset: ["platformMcp.apiKey"], actor: "test" });
  assert.equal(cleaned.ok, true);
  assert.deepEqual(readPlatformJson(root), { platformMcp: { port: 5191 }, schemaVersion: 1 });

  // Secrets go to the store through setSecretLeaf, and only the key is logged.
  const vault = fakeVault();
  const stored = await config.setSecretLeaf("platformMcp.apiKey", "fake-store-value-0005", { aiRoot: root, secrets: vault, actor: "owner" });
  assert.equal(stored.ok, true);
  assert.deepEqual(stored.restartRequired, ["platform-mcp"]);
  assert.deepEqual(vault.calls, [["set", "platform", "platformMcp.apiKey"]]);
  const section = config.readSection("platformMcp", { aiRoot: root, env: NO_ENV, secrets: vault });
  assert.deepEqual(section.values.apiKey, { set: true });
  assert.equal(section.sources["platformMcp.apiKey"], "store");
  const withStore = load(root, { secrets: vault });
  const mcpItem = config.describeEffectiveConfig(withStore, { includeSecrets: true }).groups.flatMap((group) => group.items).find((item) => item.key === "platformMcp.apiKey");
  assert.deepEqual(mcpItem.secret, { set: true, source: "store", updatedAt: "2026-10-14T00:00:00.000Z" });
  const cleared = await config.setSecretLeaf("platformMcp.apiKey", null, { aiRoot: root, secrets: vault, actor: "owner" });
  assert.equal(cleared.ok, true);
  assert.equal(vault.has("platform", "platformMcp.apiKey"), false);
  assert.equal((await config.setSecretLeaf("console.defaultUi", "new", { aiRoot: root, secrets: vault })).code, "not_secret");
  assert.equal((await config.setSecretLeaf("hf.token", "", { aiRoot: root, secrets: vault })).code, "config_invalid");
  const lastLines = changeLogLines(root).slice(-2);
  assert.deepEqual(lastLines.map((line) => [line.changed, line.secret]), [[["platformMcp.apiKey"], true], [["platformMcp.apiKey"], true]]);

  // No fake value is in any file under the root.
  for (const file of walkFiles(root)) {
    const text = fs.readFileSync(file, "utf8");
    for (const value of ["fake-direct-value-0001", "fake-section-value-0002", "fake-env-value-0004", "fake-store-value-0005"]) {
      assert.equal(text.includes(value), false, `${path.relative(root, file)} holds ${value}`);
    }
  }
});

// --- the env map ---------------------------------------------------------------

// Every legacy name of §4.3 (and the 05 §3.4 names of the core namespaces),
// with a sample value and what it reads as.
const LEGACY_ENV = [
  ["SERVICE_ENTRY_HOST", "listeners.admin.host", "0.0.0.0", "0.0.0.0"],
  ["SERVICE_ENTRY_PORT", "listeners.admin.port", "5276", 5276],
  ["SERVICE_ENTRY_ALLOW_LAN_ADMIN", "listeners.admin.lan", "1", true],
  ["SERVICE_ENTRY_PUBLIC_LISTENER", "listeners.public.enabled", "0", false],
  ["SERVICE_ENTRY_PUBLIC_HOST", "listeners.public.host", "0.0.0.0", "0.0.0.0"],
  ["SERVICE_ENTRY_PUBLIC_PORT", "listeners.public.port", "5286", 5286],
  ["SERVICE_ENTRY_PUBLIC_BASE_URL", "listeners.public.baseUrl", "https://models.example.test", "https://models.example.test"],
  ["SERVICE_ENTRY_RATE_LIMIT_RPM", "admin.gatewayRpm", "60", 60],
  ["SERVICE_ENTRY_TRUSTED_PROXIES", "trustedProxies.cidrs", "127.0.0.1/32,10.1.0.0/16", ["127.0.0.1/32", "10.1.0.0/16"]],
  ["SERVICE_ENTRY_CLIENT_IP_HEADER", "trustedProxies.clientIpHeader", "x-real-ip", "x-real-ip"],
  ["SERVICE_ENTRY_REQUIRE_API_KEY", "exposure.requireApiKey", "on", "on"],
  ["SERVICE_ENTRY_ALLOWED_ORIGINS", "exposure.allowedOrigins", "https://app.example.test", ["https://app.example.test"]],
  ["VLLM_MANAGER_HOST", "managers.vllm.host", "0.0.0.0", "0.0.0.0"],
  ["LLAMA_MANAGER_HOST", "managers.llama.host", "0.0.0.0", "0.0.0.0"],
  ["VLLM_MANAGER_PORT", "managers.vllm.port", "5277", 5277],
  ["LLAMA_MANAGER_PORT", "managers.llama.port", "5278", 5278],
  ["SERVICE_ENTRY_CONSOLE_DEFAULT", "console.defaultUi", "new", "new"],
  ["SERVICE_ENTRY_NO_BROWSER", "cli.openBrowser", "1", false],
  ["PLATFORM_LANG", "cli.lang", "en-US", "en-US"],
  ["PLATFORM_MCP_PORT", "platformMcp.port", "5290", 5290],
  ["PLATFORM_MCP_TOOL_PROFILE", "platformMcp.toolProfile", "ops", "ops"],
  ["PLATFORM_MCP_OUTPUT_SCHEMA", "platformMcp.outputSchema", "full", "full"],
  ["PLATFORM_MCP_SEARCH_RATE_LIMIT_PER_MINUTE", "platformMcp.searchRateLimitPerMinute", "10", 10],
  ["PLATFORM_MCP_LOCAL_RATE_LIMIT_PER_MINUTE", "platformMcp.localRateLimitPerMinute", "100", 100],
  ["PLATFORM_MCP_CACHE_TTL_MS", "platformMcp.cacheTtlMs", "0", 0],
  ["PLATFORM_MCP_API_KEY", "platformMcp.apiKey", "fake-mcp-env-key", { set: true }],
  ["TTS_GATEWAY_PORT", "tts.gatewayPort", "7100", 7100],
  ["TTS_UPSTREAM_API_KEY", "tts.upstreamApiKey", "fake-tts-env-key", { set: true }],
  ["SEARCH_GATEWAY_PORT", "search.port", "5280", 5280],
  ["UPSTREAM_BASE_URL", "search.upstreamBaseUrl", "http://host.docker.internal:5186/v1", "http://host.docker.internal:5186/v1"],
  ["SEARCH_GATEWAY_API_KEY", "search.apiKey", "fake-search-env-key", { set: true }],
  ["SERVICE_ENTRY_SEARCH_GATEWAY_KEY", "search.apiKey", "fake-search-env-key", { set: true }],
  ["PLATFORM_MCP_SEARCH_GATEWAY_API_KEY", "search.apiKey", "fake-search-env-key", { set: true }],
  ["UPSTREAM_API_KEY", "search.upstreamApiKey", "fake-upstream-env-key", { set: true }],
  ["HF_HOME", "paths.hfHome", "hf-cache", "hf-cache"],
  ["TTS_RUNTIME_ROOT", "paths.ttsRuntimeRoot", "tts-runtime", "tts-runtime"],
  ["HF_TOKEN", "hf.token", "fake-hf-env-token", { set: true }],
  ["DOCKER_DESKTOP_EXE", "docker.desktopExe", "Docker Desktop.exe", "Docker Desktop.exe"],
  ["DOCKER_WSL_DISTRO", "docker.wslDistro", "Ubuntu-24.04", "Ubuntu-24.04"],
  ["PLATFORM_DOCKER_WAIT_SECONDS", "docker.waitTimeoutSec", "90", 90],
];

test("every legacy env name lands on exactly one key", async (t) => {
  const schema = config.loadPlatformSchema();
  const index = config.envNameIndex(schema);
  for (const [name, key, sample, expected] of LEGACY_ENV) {
    await t.test(name, (tt) => {
      assert.equal(index.get(name), key);
      const owners = Array.from(schema.leaves.values()).filter((item) => item.env.some((entry) => entry.name === name));
      assert.deepEqual(owners.map((item) => item.key), [key]);
      const loaded = config.loadPlatformConfig({ aiRoot: tempRoot(tt), env: { [name]: sample } });
      assert.deepEqual(loaded.values[key], expected);
      assert.equal(loaded.sources[key], "env");
    });
  }
  // The table is the whole map: a new env name needs a row here.
  assert.deepEqual(Array.from(index.keys()).sort(), Array.from(new Set(LEGACY_ENV.map(([name]) => name))).sort());
  // Derived output names are not inputs.
  assert.equal(index.has("PLATFORM_MCP_SERVICE_ENTRY_URL"), false);
  assert.equal(schema.derivedEnvIndex.get("PLATFORM_MCP_SERVICE_ENTRY_URL"), "listeners.admin.port");
});

function rawEnvNames(node, key, out) {
  if (!node || typeof node !== "object") return;
  if (node.properties && typeof node.properties === "object") {
    for (const [name, child] of Object.entries(node.properties)) rawEnvNames(child, key ? `${key}.${name}` : name, out);
    return;
  }
  for (const entry of Array.isArray(node.env) ? node.env : []) out.push([typeof entry === "string" ? entry : entry.name, key]);
  for (const entry of Array.isArray(node.derivedEnv) ? node.derivedEnv : []) out.push([entry.name, key]);
}

test("no env name appears under two keys across the core file and every fragment", (t) => {
  const pairs = [];
  rawEnvNames(JSON.parse(fs.readFileSync(CORE_SCHEMA, "utf8")), "", pairs);
  for (const name of fs.readdirSync(BUNDLED_FRAGMENTS).filter((file) => file.endsWith(".schema.json"))) {
    const fragment = JSON.parse(fs.readFileSync(path.join(BUNDLED_FRAGMENTS, name), "utf8"));
    rawEnvNames({ properties: fragment.properties }, fragment.namespace, pairs);
  }
  const keysByName = new Map();
  for (const [name, key] of pairs) keysByName.set(name, [...(keysByName.get(name) || []), key]);
  for (const [name, keys] of keysByName) assert.equal(keys.length, 1, `${name} is mapped by ${keys.join(" and ")}`);
  assert.deepEqual(config.loadPlatformSchema().errors.filter((error) => error.code === "fragment_conflict"), []);

  // A planted fragment that maps an env name again is rejected whole.
  const dir = fragmentDir(t, {
    "telemetry.schema.json": telemetryFragment(),
    "audit.schema.json": {
      schemaVersion: 1, namespace: "audit", owner: "04-telemetry", asOf: "2026-10-14", staleAfterDays: 365,
      properties: {
        root: leaf({ type: "string", format: "path", default: "", env: ["AI_AUDIT_ROOT"] }),
        port: leaf({ type: "integer", format: "port", default: 5199, env: ["SERVICE_ENTRY_PORT"] }),
      },
    },
  });
  const schema = config.loadPlatformSchema({ fragmentDir: dir });
  const conflicts = schema.errors.filter((error) => error.code === "fragment_conflict");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].namespace, "audit");
  assert.match(conflicts[0].message, /SERVICE_ENTRY_PORT/);
  assert.equal(schema.leaves.has("audit.root"), false, "the whole fragment is rejected");
  assert.equal(schema.envIndex.has("AI_AUDIT_ROOT"), false);
  assert.equal(schema.leaves.has("telemetry.retention.requestsDays"), true, "other fragments still load");
  assert.deepEqual(schema.fragments.map((item) => [item.namespace, item.accepted]), [["audit", false], ["telemetry", true]]);
  // Its keys then load as unknown_key warnings, and startup never crashes.
  const loaded = config.loadPlatformConfig({ aiRoot: tempRoot(t, { audit: { root: "audit-out" } }), env: NO_ENV, schema });
  assert.deepEqual(loaded.warnings.map((warning) => `${warning.field}:${warning.code}`), ["audit:unknown_key"]);
  assert.deepEqual(loaded.errors, []);

  // Other conflicts: a core namespace, a file named for another namespace, an
  // env name twice in one fragment, a dotted key, a core key of a shared namespace.
  const cases = {
    "listeners.schema.json": { schemaVersion: 1, namespace: "listeners", owner: "x", properties: { extra: leaf({ type: "boolean", default: false }) } },
    "hub.schema.json": { schemaVersion: 1, namespace: "models", owner: "02-models", properties: { flag: leaf({ type: "boolean", default: false }) } },
    "engines.schema.json": { schemaVersion: 1, namespace: "engines", owner: "01-engines", properties: { a: leaf({ type: "string", default: "", env: ["ENGINES_SAMPLE"] }), b: leaf({ type: "string", default: "", env: ["ENGINES_SAMPLE"] }) } },
    "keys.schema.json": { schemaVersion: 1, namespace: "keys", owner: "05-public", properties: { "listeners.admin.port": leaf({ type: "integer", default: 1 }) } },
    "console.schema.json": { schemaVersion: 1, namespace: "console", owner: "07-console", properties: { defaultUi: leaf({ type: "string", default: "new" }) } },
  };
  const rejected = config.loadPlatformSchema({ fragmentDir: fragmentDir(t, cases) });
  const codes = Object.fromEntries(rejected.fragments.map((item) => [item.file.split("/").pop(), item.accepted]));
  assert.deepEqual(codes, { "console.schema.json": false, "engines.schema.json": false, "hub.schema.json": false, "keys.schema.json": false, "listeners.schema.json": false });
  assert.ok(rejected.errors.length >= 5);
  assert.ok(rejected.errors.every((error) => error.code === "fragment_conflict"), JSON.stringify(rejected.errors));
  assert.equal(rejected.leaves.get("console.defaultUi").owner, "06-ops");
});

test("a public fragment that declares baseUrl is rejected; one without it extends the schema", (t) => {
  const publicFragment = (properties) => ({ schemaVersion: 1, namespace: "public", owner: "05-public", asOf: "2026-10-14", staleAfterDays: 365, properties });
  const withBaseUrl = config.loadPlatformSchema({ fragmentDir: fragmentDir(t, {
    "public.schema.json": publicFragment({
      baseUrl: leaf({ type: "string", default: "" }),
      managersGatewayOnly: leaf({ type: "string", enum: ["off", "warn", "enforce"], default: "warn", env: ["MANAGER_GATEWAY_ONLY"] }),
    }),
  }) });
  const conflict = withBaseUrl.errors.find((error) => error.code === "fragment_conflict");
  assert.equal(conflict.field, "public.baseUrl");
  assert.match(conflict.message, /listeners\.public\.baseUrl/);
  assert.equal(withBaseUrl.leaves.has("public.managersGatewayOnly"), false);

  const clean = config.loadPlatformSchema({ fragmentDir: fragmentDir(t, {
    "public.schema.json": publicFragment({
      managersGatewayOnly: leaf({ type: "string", enum: ["off", "warn", "enforce"], default: "warn", env: ["MANAGER_GATEWAY_ONLY"], consumers: ["vllm-manager", "llama-manager"] }),
    }),
  }) });
  assert.deepEqual(clean.errors, []);
  assert.equal(clean.envIndex.get("MANAGER_GATEWAY_ONLY"), "public.managersGatewayOnly");
  // A shared namespace gains keys from its fragment.
  const consoleFragment = config.loadPlatformSchema({ fragmentDir: fragmentDir(t, {
    "console.schema.json": { schemaVersion: 1, namespace: "console", owner: "07-console", properties: { density: leaf({ type: "string", enum: ["comfortable", "compact"], default: "comfortable" }) } },
  }) });
  assert.deepEqual(consoleFragment.errors, []);
  assert.deepEqual(config.readSection("console", { aiRoot: tempRoot(t), env: NO_ENV, schema: consoleFragment }).values, { defaultUi: "classic", density: "comfortable" });
});

// --- sections: 05 and 04 call these -------------------------------------------

test("05 example: listeners and exposure round-trip through readSection/writeSection with the etag", async (t) => {
  const root = tempRoot(t);
  // updateAccessSection("listeners", patch, { etag, writeSection }) per 05 §3.4.
  const listeners = config.readSection("listeners", { aiRoot: root, env: NO_ENV });
  assert.equal(listeners.values.public.baseUrl, "");
  const saved = await config.writeSection("listeners", { public: { baseUrl: "https://models.example.test" }, admin: { lan: true } }, { aiRoot: root, etag: listeners.etag, actor: "owner" });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.changed, ["listeners.admin.lan", "listeners.public.baseUrl"]);
  assert.deepEqual(saved.restartRequired, ["entry"]);
  const reread = config.readSection("listeners", { aiRoot: root, env: NO_ENV });
  assert.equal(reread.etag, saved.etag);
  assert.equal(reread.values.public.baseUrl, "https://models.example.test");
  assert.equal(reread.value.admin.host, "0.0.0.0", "value is an alias of values");
  assert.equal(reread.sources["listeners.admin.host"], "derived");
  assert.equal(reread.sources["listeners.public.baseUrl"], "file");
  // A dotted patch key works too, and the etag from before is now stale.
  const stale = await config.writeSection("listeners", { "public.port": 5286 }, { aiRoot: root, etag: listeners.etag, actor: "owner" });
  assert.equal(stale.code, "config_conflict");

  const exposure = config.readSection("exposure", { aiRoot: root, env: NO_ENV });
  assert.deepEqual(exposure.values, { requireApiKey: "auto", allowedOrigins: [] });
  const exposureSaved = await config.writeSection("exposure", { requireApiKey: "on", allowedOrigins: ["https://app.example.test"] }, { aiRoot: root, etag: exposure.etag, actor: "owner" });
  assert.equal(exposureSaved.ok, true);
  assert.deepEqual(exposureSaved.restartRequired, [], "exposure.* is applied live");
  assert.deepEqual(config.readSection("exposure", { aiRoot: root, env: NO_ENV }).values, { requireApiKey: "on", allowedOrigins: ["https://app.example.test"] });
  // An env value still wins over what was written (D9), and is reported as env.
  const shadowed = config.readSection("exposure", { aiRoot: root, env: { SERVICE_ENTRY_REQUIRE_API_KEY: "auto" } });
  assert.equal(shadowed.values.requireApiKey, "auto");
  assert.equal(shadowed.sources["exposure.requireApiKey"], "env");
});

test("console round-trips and null unsets a key back to its default", async (t) => {
  const root = tempRoot(t);
  const saved = await config.writeSection("console", { defaultUi: "new" }, { aiRoot: root, actor: "owner" });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.restartRequired, []);
  assert.deepEqual(config.readSection("console", { aiRoot: root, env: NO_ENV }).values, { defaultUi: "new" });
  const unset = await config.writeSection("console", { defaultUi: null }, { aiRoot: root, actor: "owner" });
  assert.deepEqual(unset.changed, ["console.defaultUi"]);
  const after = config.readSection("console", { aiRoot: root, env: NO_ENV });
  assert.deepEqual(after.values, { defaultUi: "classic" });
  assert.equal(after.sources["console.defaultUi"], "default");
  assert.deepEqual(readPlatformJson(root), { schemaVersion: 1 });
  // A nested section name works as well.
  assert.deepEqual(config.readSection("listeners.admin", { aiRoot: root, env: NO_ENV }).values, { host: "127.0.0.1", port: 5176, lan: false });
});

test("04 example: a telemetry fragment round-trips through readSection/writeSection", async (t) => {
  const schema = config.loadPlatformSchema({ fragmentDir: fragmentDir(t, { "telemetry.schema.json": telemetryFragment() }) });
  assert.deepEqual(schema.errors, []);
  const root = tempRoot(t);
  // GET /api/telemetry/settings -> readSection("telemetry"); PUT -> writeSection with If-Match.
  const read = config.readSection("telemetry", { aiRoot: root, env: NO_ENV, schema });
  assert.deepEqual(read.values, { enabled: true, sampleIntervalMs: 10000, timezoneOffsetMinutes: 480, retention: { requestsDays: 30, ipDays: 30 }, energy: { pricePerKwh: null, tariffs: [] } });
  const put = await config.writeSection("telemetry", {
    retention: { requestsDays: 45 },
    energy: { pricePerKwh: 0.6, tariffs: [{ from: "22:00", to: "06:00", pricePerKwh: 0.3 }] },
  }, { aiRoot: root, etag: read.etag, actor: "owner", schema });
  assert.equal(put.ok, true);
  assert.deepEqual(put.changed, ["telemetry.energy.pricePerKwh", "telemetry.energy.tariffs", "telemetry.retention.requestsDays"]);
  assert.deepEqual(put.restartRequired, []);
  const reread = config.readSection("telemetry", { aiRoot: root, env: NO_ENV, schema });
  assert.equal(reread.values.retention.requestsDays, 45);
  assert.deepEqual(reread.values.energy.tariffs, [{ from: "22:00", to: "06:00", pricePerKwh: 0.3 }]);
  assert.equal(reread.sources["telemetry.retention.ipDays"], "default");
  // A conflicting second tab gets 409; an invalid value gets the field errors.
  assert.equal((await config.writeSection("telemetry", { enabled: false }, { aiRoot: root, etag: read.etag, actor: "owner", schema })).status, 409);
  const invalid = await config.writeSection("telemetry", { sampleIntervalMs: 10, energy: { tariffs: [{ from: "late", to: "06:00", extra: 1 }] } }, { aiRoot: root, actor: "owner", schema });
  assert.equal(invalid.code, "config_invalid");
  assert.deepEqual(invalid.errors.map((error) => `${error.field}:${error.code}`).sort(), ["telemetry.energy.tariffs[0].from:invalid_format", "telemetry.energy.tariffs[0].extra:unknown_key", "telemetry.sampleIntervalMs:out_of_range"].sort());
  // 04 §20 cross-field rules: ipDays <= requestsDays, whole-hour offsets, no overlapping tariffs.
  const longIp = await config.writeSection("telemetry", { retention: { ipDays: 60 } }, { aiRoot: root, actor: "owner", schema });
  assert.deepEqual(longIp.errors.map((error) => error.code), ["retention_order"]);
  const halfHour = await config.writeSection("telemetry", { timezoneOffsetMinutes: 330 }, { aiRoot: root, actor: "owner", schema });
  assert.deepEqual(halfHour.errors.map((error) => `${error.field}:${error.code}`), ["telemetry.timezoneOffsetMinutes:invalid_format"]);
  const overlapping = await config.writeSection("telemetry", { energy: { tariffs: [{ from: "22:00", to: "06:00", pricePerKwh: 0.3 }, { from: "05:00", to: "08:00", pricePerKwh: 0.5 }] } }, { aiRoot: root, actor: "owner", schema });
  assert.deepEqual(overlapping.errors.map((error) => error.code), ["tariff_overlap"]);
  const adjacent = await config.writeSection("telemetry", { energy: { tariffs: [{ from: "22:00", to: "06:00", pricePerKwh: 0.3 }, { from: "06:00", to: "22:00", pricePerKwh: 0.5 }] } }, { aiRoot: root, actor: "owner", schema });
  assert.equal(adjacent.ok, true);
  // Its env names map like the core ones.
  const fromEnv = config.readSection("telemetry", { aiRoot: root, env: { TELEMETRY_ENABLED: "0" }, schema });
  assert.equal(fromEnv.values.enabled, false);
  assert.equal(fromEnv.sources["telemetry.enabled"], "env");
  assert.deepEqual((await config.writeSection("telemetry", { enabled: false }, { aiRoot: root, actor: "owner", schema })).restartRequired, ["entry"]);
});

test("writeSection refuses keys outside its section with section_mismatch", async (t) => {
  const root = tempRoot(t);
  const nested = await config.writeSection("exposure", { listeners: { admin: { lan: true } } }, { aiRoot: root, actor: "test" });
  assert.equal(nested.ok, false);
  assert.equal(nested.code, "section_mismatch");
  assert.equal(nested.status, 400);
  const dotted = await config.writeSection("console", { "exposure.requireApiKey": "off" }, { aiRoot: root, actor: "test" });
  assert.equal(dotted.code, "section_mismatch");
  const absoluteInside = await config.writeSection("console", { "console.defaultUi": "new" }, { aiRoot: root, actor: "test" });
  assert.equal(absoluteInside.ok, true);
  const unknown = await config.writeSection("console", { nonsense: 1 }, { aiRoot: root, actor: "test" });
  assert.equal(unknown.code, "config_invalid");
  assert.equal(unknown.errors[0].code, "unknown_key");
  assert.equal((await config.writeSection("nowhere", {}, { aiRoot: root })).code, "unknown_section");
  assert.equal((await config.writeSection("console", "new", { aiRoot: root })).code, "config_invalid");
  assert.equal(config.readSection("nowhere", { aiRoot: root, env: NO_ENV }).errors[0].code, "unknown_section");
  assert.deepEqual(readPlatformJson(root), { schemaVersion: 1, console: { defaultUi: "new" } });
});

test("readSection is cached per file state and sees writes from elsewhere", async (t) => {
  const root = tempRoot(t, { console: { defaultUi: "new" } });
  const first = config.readSection("console", { aiRoot: root, env: NO_ENV });
  const again = config.readSection("console", { aiRoot: root, env: NO_ENV });
  assert.deepEqual(again, first);
  again.values.defaultUi = "mutated";
  assert.equal(config.readSection("console", { aiRoot: root, env: NO_ENV }).values.defaultUi, "new", "callers get copies");
  // Another process replaces the file (tmp + rename), so the cache must not serve the old state.
  const replacement = `${configFile(root)}.other.tmp`;
  fs.writeFileSync(replacement, JSON.stringify({ console: { defaultUi: "classic" } }));
  fs.renameSync(replacement, configFile(root));
  const fresh = config.readSection("console", { aiRoot: root, env: NO_ENV });
  assert.equal(fresh.values.defaultUi, "classic");
  assert.notEqual(fresh.etag, first.etag);
});

// --- description and namespace -----------------------------------------------

test("describeEffectiveConfig groups every leaf with value, default, source and copy", (t) => {
  const root = tempRoot(t, { managers: { bindHost: "0.0.0.0" } });
  const loaded = load(root);
  const described = config.describeEffectiveConfig(loaded);
  assert.equal(described.schemaVersion, 1);
  assert.equal(described.etag, loaded.etag);
  const items = described.groups.flatMap((group) => group.items);
  const schema = config.loadPlatformSchema();
  assert.equal(items.length, Array.from(schema.leaves.values()).filter((item) => !item.secret).length);
  const bindHost = items.find((item) => item.key === "managers.bindHost");
  assert.equal(bindHost.value, "0.0.0.0");
  assert.equal(bindHost.default, "127.0.0.1");
  assert.equal(bindHost.source, "file");
  assert.deepEqual(bindHost.restartRequired, ["vllm-manager", "llama-manager"]);
  assert.equal(bindHost.owner, "06-ops");
  assert.ok(bindHost.title["zh-CN"] && bindHost.description["en-US"]);
  const vllmHost = items.find((item) => item.key === "managers.vllm.host");
  assert.equal(vllmHost.source, "derived");
  assert.deepEqual(vllmHost.envNames, ["VLLM_MANAGER_HOST"]);
  assert.deepEqual(items.find((item) => item.key === "components").restartRequired, ["*"]);
  assert.deepEqual(described.groups.map((group) => group.id).slice(0, 2), ["access", "managers"]);
});

test("core.platform is a lazy namespace over the platform modules", async () => {
  assert.equal(core.platform.readSection, config.readSection);
  assert.equal(core.platform.writeSection, config.writeSection);
  assert.equal(core.platform.config, config);
  assert.equal(core.platform.semver.satisfies("24.16.0", "^22.22.2 || ^24.15.0 || >=26.0.0"), true);
  assert.equal(core.readSection, undefined, "no flat names on manager-core");
  // Loading manager-core alone does not load the platform modules.
  const probe = "const core = require(process.argv[1]); const loaded = () => Object.keys(require.cache).some((file) => /[\\\\/]platform[\\\\/]config\\.js$/.test(file)); const before = loaded(); void core.platform; process.stdout.write(JSON.stringify([before, loaded()]));";
  const output = await new Promise((resolve, reject) => {
    execFile(process.execPath, ["-e", probe, path.join(__dirname, "..")], { windowsHide: true }, (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
  });
  assert.deepEqual(JSON.parse(output), [false, true]);
});
