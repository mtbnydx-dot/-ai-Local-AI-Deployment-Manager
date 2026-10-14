const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("../../manager-core");
const {
  ACCESS_DEFAULTS,
  ACCESS_SCHEMA_LEAVES,
  CORE_LEAF_SPECS,
  READ_SECTIONS,
  createAccessConfigSource,
  loadAccessConfig,
  updateAccessSection,
} = require("../lib/public-config");

const platform = core.platform;
const FRAGMENT_FILE = path.join(platform.FRAGMENT_DIR, "public.schema.json");

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// readSection / writeSection over a temp AI root and an explicit env object.
function platformIo(t, env = {}) {
  const aiRoot = tempRoot(t);
  return {
    aiRoot,
    readSection: (name) => platform.readSection(name, { aiRoot, env }),
    writeSection: (name, patch, options) => platform.writeSection(name, patch, { ...options, aiRoot, env }),
  };
}

// A readSection with a fixed set of effective values, for pure adapter tests.
function fakeReader(values = {}, { etag = "etag-1", errors = {} } = {}) {
  const calls = [];
  const readSection = (name) => {
    calls.push(name);
    return { values: values[name] || {}, sources: {}, etag, errors: errors[name] || [], warnings: [] };
  };
  readSection.calls = calls;
  return readSection;
}

test("defaults match the 05 section 3.4 table", () => {
  const config = loadAccessConfig({ readSection: fakeReader() });
  assert.deepEqual(config.listeners, {
    admin: { host: "127.0.0.1", port: 5176, lan: false },
    public: { enabled: true, host: "127.0.0.1", port: 5186, lan: false, baseUrl: "" },
  });
  assert.deepEqual(config.admin, {
    firstRunAutoPair: true, firstRunWindowMinutes: 30, sessionDays: 180, loopbackViewer: true,
    lanAnonymousViewer: true, allowLanOwner: false, legacyProxyGateway: "serve", gatewayRpm: 600, extraHosts: [],
  });
  assert.deepEqual(config.trustedProxies, { cidrs: ["127.0.0.1/32", "::1/128"], clientIpHeader: "cf-connecting-ip", countryHeader: "cf-ipcountry" });
  assert.deepEqual(config.exposure, { requireApiKey: "auto", allowedOrigins: [] });
  assert.deepEqual(config.public, {
    extraHosts: [], brand: { "zh-CN": "本地模型服务", "en-US": "Local Model Service" },
    catalog: { publish: ["*"], showPrices: true, allowColdStart: false },
    defaults: { rpm: 60, tpm: 200000, maxConcurrent: 2, maxQueued: 4, queueTimeoutSeconds: 30, maxOutputTokens: 8192 },
    share: { maxConcurrent: 4, maxQueued: 16, queueTimeoutSeconds: 30, ownerActiveMaxConcurrent: 2 },
    preAuth: { rpm: 120, burst: 30 },
    authFailure: { limit: 20, windowSeconds: 60, banSeconds: 600, maxBanSeconds: 86400 },
    maxBodyBytes: 16777216, exposeSearch: false, exposeTts: true, quotaTzOffsetMinutes: null, managersGatewayOnly: "warn",
  });
  assert.deepEqual(config.issues, []);
  assert.equal(config.adminLanBound, false);
  assert.equal(config.publicLanBound, false);
  assert.equal(config.publicOrigin, "");
  assert.equal(config.trustedCidrs.length, 2);
  // ACCESS_DEFAULTS is the same table, and everything is frozen.
  assert.deepEqual(ACCESS_DEFAULTS.public, config.public);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.public.brand), true);
  assert.equal(Object.isFrozen(config.trustedProxies.cidrs), true);
  assert.equal(Object.isFrozen(ACCESS_DEFAULTS.listeners), true);
});

test("the adapter reads the five sections through readSection and nothing else", () => {
  const readSection = fakeReader();
  loadAccessConfig({ readSection });
  assert.deepEqual([...readSection.calls].sort(), [...READ_SECTIONS].sort());
  assert.deepEqual([...READ_SECTIONS].sort(), ["admin", "exposure", "listeners", "public", "trustedProxies"]);
  assert.throws(() => loadAccessConfig({}), TypeError);

  // The module itself carries no config-file code.
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "public-config.js"), "utf8");
  assert.doesNotMatch(source, /require\(["'](?:node:)?fs(?:\/promises)?["']\)/);
  assert.doesNotMatch(source, /["`]platform.json/);
});

test("an fs spy proves loadAccessConfig and updateAccessSection do no file I/O", async (t) => {
  const fsp = require("node:fs/promises");
  const names = ["readFileSync", "writeFileSync", "readdirSync", "statSync", "existsSync", "openSync", "renameSync", "appendFileSync", "mkdirSync", "unlinkSync", "readFile", "writeFile", "open", "rename", "appendFile", "mkdir"];
  const spied = [];
  for (const [label, target] of [["fs", fs], ["fsp", fsp]]) {
    for (const name of names) {
      if (typeof target[name] !== "function") continue;
      const original = target[name];
      target[name] = function spy(...args) {
        spied.push(`${label}.${name}`);
        return original.apply(this, args);
      };
      t.after(() => { target[name] = original; });
    }
  }
  const writes = [];
  const writeSection = async (name, patch, options) => {
    writes.push({ name, patch, options });
    return { ok: true, etag: "etag-2", changed: ["admin.sessionDays"], restartRequired: [], errors: [] };
  };
  const readSection = fakeReader();
  const source = createAccessConfigSource({ readSection });
  source.get();
  source.refresh();
  const result = await updateAccessSection("admin", { sessionDays: 30 }, { etag: "etag-1", actor: "tester", writeSection, readSection, source });
  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(spied, []);
});

test("every 05 env name resolves to exactly its key", (t) => {
  const schema = platform.loadPlatformSchema();
  const index = platform.envNameIndex(schema);
  const expected = {
    SERVICE_ENTRY_HOST: "listeners.admin.host",
    SERVICE_ENTRY_PORT: "listeners.admin.port",
    SERVICE_ENTRY_PUBLIC_LISTENER: "listeners.public.enabled",
    SERVICE_ENTRY_PUBLIC_HOST: "listeners.public.host",
    SERVICE_ENTRY_PUBLIC_PORT: "listeners.public.port",
    SERVICE_ENTRY_PUBLIC_BASE_URL: "listeners.public.baseUrl",
    SERVICE_ENTRY_ALLOW_LAN_ADMIN: "listeners.admin.lan",
    SERVICE_ENTRY_RATE_LIMIT_RPM: "admin.gatewayRpm",
    SERVICE_ENTRY_TRUSTED_PROXIES: "trustedProxies.cidrs",
    SERVICE_ENTRY_CLIENT_IP_HEADER: "trustedProxies.clientIpHeader",
    SERVICE_ENTRY_ALLOWED_HOSTS: "public.extraHosts",
    SERVICE_ENTRY_AUTH_FAIL_LIMIT: "public.authFailure.limit",
    SERVICE_ENTRY_AUTH_FAIL_WINDOW_SECONDS: "public.authFailure.windowSeconds",
    SERVICE_ENTRY_AUTH_BAN_SECONDS: "public.authFailure.banSeconds",
    SERVICE_ENTRY_ALLOWED_ORIGINS: "exposure.allowedOrigins",
    SERVICE_ENTRY_REQUIRE_API_KEY: "exposure.requireApiKey",
    MANAGER_GATEWAY_ONLY: "public.managersGatewayOnly",
  };
  for (const [env, key] of Object.entries(expected)) {
    const hit = index.get(env);
    assert.ok(hit, `${env} is not in the env index`);
    assert.equal(hit.key ?? hit, key, env);
  }

  // And the adapter sees the values the env carries.
  const io = platformIo(t, {
    SERVICE_ENTRY_PUBLIC_LISTENER: "0",
    SERVICE_ENTRY_PUBLIC_PORT: "6001",
    SERVICE_ENTRY_PUBLIC_BASE_URL: "https://ai.example.test/path",
    SERVICE_ENTRY_RATE_LIMIT_RPM: "42",
    SERVICE_ENTRY_TRUSTED_PROXIES: "10.0.0.0/8, 192.168.1.5",
    SERVICE_ENTRY_CLIENT_IP_HEADER: "X-Real-IP",
    SERVICE_ENTRY_ALLOWED_HOSTS: "a.example.test, b.example.test",
    SERVICE_ENTRY_AUTH_FAIL_LIMIT: "7",
    SERVICE_ENTRY_AUTH_FAIL_WINDOW_SECONDS: "90",
    SERVICE_ENTRY_AUTH_BAN_SECONDS: "120",
    SERVICE_ENTRY_ALLOWED_ORIGINS: "https://app.example.test",
    SERVICE_ENTRY_REQUIRE_API_KEY: "on",
    MANAGER_GATEWAY_ONLY: "enforce",
  });
  const config = loadAccessConfig({ readSection: io.readSection });
  assert.deepEqual(config.issues, []);
  assert.equal(config.listeners.public.enabled, false);
  assert.equal(config.listeners.public.port, 6001);
  assert.equal(config.publicOrigin, "https://ai.example.test");
  assert.equal(config.publicHost, "ai.example.test");
  assert.equal(config.admin.gatewayRpm, 42);
  assert.deepEqual(config.trustedProxies.cidrs, ["10.0.0.0/8", "192.168.1.5"]);
  assert.equal(config.trustedProxies.clientIpHeader, "x-real-ip");
  assert.deepEqual(config.trustedCidrs.map((cidr) => cidr.text), ["10.0.0.0/8", "192.168.1.5"]);
  assert.deepEqual(config.public.extraHosts, ["a.example.test", "b.example.test"]);
  assert.deepEqual(config.public.authFailure, { limit: 7, windowSeconds: 90, banSeconds: 120, maxBanSeconds: 86400 });
  assert.deepEqual(config.exposure.allowedOrigins, ["https://app.example.test"]);
  assert.equal(config.exposure.requireApiKey, "on");
  assert.equal(config.public.managersGatewayOnly, "enforce");
  assert.equal(config.sources["admin.gatewayRpm"], "env");
});

test("a wildcard bind or the lan switch makes the listeners LAN-bound", (t) => {
  const wildcard = loadAccessConfig({ readSection: platformIo(t, { SERVICE_ENTRY_HOST: "0.0.0.0", SERVICE_ENTRY_PUBLIC_HOST: "0.0.0.0" }).readSection });
  assert.equal(wildcard.adminLanBound, true);
  assert.equal(wildcard.publicLanBound, true);
  const lanSwitch = loadAccessConfig({ readSection: platformIo(t, { SERVICE_ENTRY_ALLOW_LAN_ADMIN: "1" }).readSection });
  assert.equal(lanSwitch.listeners.admin.lan, true);
  assert.equal(lanSwitch.adminLanBound, true);
  assert.equal(lanSwitch.publicLanBound, false);
  // A disabled public listener is never LAN-bound.
  const off = loadAccessConfig({ readSection: platformIo(t, { SERVICE_ENTRY_PUBLIC_HOST: "0.0.0.0", SERVICE_ENTRY_PUBLIC_LISTENER: "0" }).readSection });
  assert.equal(off.publicLanBound, false);
  // Loopback spellings stay loopback-bound.
  const localhost = loadAccessConfig({ readSection: fakeReader({ listeners: { admin: { host: "localhost" }, public: { host: "::1" } } }) });
  assert.equal(localhost.adminLanBound, false);
  assert.equal(localhost.publicLanBound, false);
});

test("invalid values become issues[] and fall back to defaults", () => {
  const config = loadAccessConfig({
    readSection: fakeReader({
      listeners: { public: { baseUrl: "http://plain.example.test", port: 70000 } },
      admin: { legacyProxyGateway: "maybe", extraHosts: ["ok.example.test", "*"], sessionDays: 0 },
      trustedProxies: { cidrs: ["10.0.0.0/8", "nope"], clientIpHeader: "bad header!" },
      exposure: { requireApiKey: "sometimes" },
      public: {
        brand: { "en-US": "" },
        defaults: { rpm: "fast", maxQueued: -1 },
        share: { maxConcurrent: 2, ownerActiveMaxConcurrent: 3 },
        authFailure: { banSeconds: 5000, maxBanSeconds: 100 },
        managersGatewayOnly: "block",
        quotaTzOffsetMinutes: 5000,
      },
    }, { errors: { exposure: [{ field: "exposure.allowedOrigins", code: "invalid_format", message: "bad origin", source: "env", env: "SERVICE_ENTRY_ALLOWED_ORIGINS" }] } }),
  });
  const fields = config.issues.map((issue) => issue.field);
  for (const field of [
    "listeners.public.baseUrl", "listeners.public.port", "admin.legacyProxyGateway", "admin.extraHosts", "admin.sessionDays",
    "trustedProxies.cidrs", "trustedProxies.clientIpHeader", "exposure.requireApiKey", "public.brand.en-US",
    "public.defaults.rpm", "public.defaults.maxQueued", "public.share.ownerActiveMaxConcurrent", "public.authFailure.banSeconds",
    "public.managersGatewayOnly", "public.quotaTzOffsetMinutes", "exposure.allowedOrigins",
  ]) assert.ok(fields.includes(field), `${field} missing from ${fields.join(", ")}`);
  assert.equal(config.issues.find((issue) => issue.field === "exposure.allowedOrigins").env, "SERVICE_ENTRY_ALLOWED_ORIGINS");
  // Defaults are in force for every refused value.
  assert.equal(config.listeners.public.baseUrl, "");
  assert.equal(config.listeners.public.port, 5186);
  assert.equal(config.admin.legacyProxyGateway, "serve");
  assert.deepEqual(config.admin.extraHosts, []);
  assert.deepEqual(config.trustedProxies.cidrs, ["127.0.0.1/32", "::1/128"]);
  assert.equal(config.trustedProxies.clientIpHeader, "cf-connecting-ip");
  assert.equal(config.exposure.requireApiKey, "auto");
  assert.equal(config.public.brand["en-US"], "Local Model Service");
  assert.equal(config.public.defaults.rpm, 60);
  assert.equal(config.public.share.ownerActiveMaxConcurrent, 2);
  assert.equal(config.public.authFailure.banSeconds, 600);
  assert.equal(config.public.managersGatewayOnly, "warn");
  assert.equal(config.public.quotaTzOffsetMinutes, null);
  for (const issue of config.issues) {
    assert.equal(typeof issue.code, "string");
    assert.ok(issue.message.length > 0 && issue.message.length <= 300);
  }
});

test("a reader that throws or answers nothing leaves the defaults and one issue", () => {
  const config = loadAccessConfig({ readSection: () => { throw new Error("disk on fire at <secret path>"); } });
  assert.deepEqual(config.public, ACCESS_DEFAULTS.public);
  assert.ok(config.issues.length >= 1);
  assert.equal(config.issues[0].code, "config_unreadable");
  assert.doesNotMatch(JSON.stringify(config.issues), /disk on fire/);
  const empty = loadAccessConfig({ readSection: () => null });
  assert.deepEqual(empty.listeners, ACCESS_DEFAULTS.listeners);
});

test("the source re-reads on its ttl and keeps the object while nothing changed", () => {
  let clock = 1000;
  let sessionDays = 180;
  let reads = 0;
  const readSection = (name) => {
    reads += 1;
    return { values: name === "admin" ? { sessionDays } : {}, sources: {}, etag: `e-${sessionDays}`, errors: [], warnings: [] };
  };
  const source = createAccessConfigSource({ readSection, ttlMs: 2000, now: () => clock });
  const first = source.get();
  const readsAfterFirst = reads;
  assert.equal(source.get(), first);
  assert.equal(reads, readsAfterFirst, "inside the ttl nothing is re-read");
  sessionDays = 30;
  clock += 1999;
  assert.equal(source.get().admin.sessionDays, 180);
  clock += 2;
  const second = source.get();
  assert.equal(second.admin.sessionDays, 30);
  assert.equal(second.etag, "e-30");
  assert.notEqual(second, first);
  // Unchanged settings keep the very same frozen object.
  clock += 5000;
  assert.equal(source.get(), second);
  sessionDays = 7;
  assert.equal(source.refresh().admin.sessionDays, 7);
  assert.throws(() => createAccessConfigSource({}), TypeError);
});

test("the public fragment equals ACCESS_SCHEMA_LEAVES and the 05 leaves pass OPS-3's checks", () => {
  const onDisk = JSON.parse(fs.readFileSync(FRAGMENT_FILE, "utf8"));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(ACCESS_SCHEMA_LEAVES)));

  const schema = platform.loadPlatformSchema();
  assert.deepEqual(schema.errors || [], []);
  const envOwners = new Map();
  const leaves = [];
  const visit = (node, key) => {
    if (node.properties) for (const [name, child] of Object.entries(node.properties)) visit(child, key ? `${key}.${name}` : name);
    else leaves.push([key, node]);
  };
  visit({ properties: ACCESS_SCHEMA_LEAVES.properties }, "public");
  assert.ok(leaves.length >= 27);
  for (const [key, leaf] of leaves) {
    for (const locale of ["zh-CN", "en-US"]) {
      assert.ok(String(leaf.title?.[locale] || "").trim(), `${key} title ${locale}`);
      assert.ok(String(leaf.description?.[locale] || "").trim(), `${key} description ${locale}`);
    }
    assert.equal(leaf.group, "access", key);
    assert.equal(typeof leaf.restartRequired, "boolean", key);
    assert.ok(schema.leaves.has(key), `${key} is not loaded by OPS-3`);
    for (const env of leaf.env || []) {
      assert.equal(envOwners.has(env), false, `${env} is claimed twice`);
      envOwners.set(env, key);
    }
  }
  // Every env name in the whole merged schema maps to exactly one key.
  const index = platform.envNameIndex(schema);
  for (const [env, key] of envOwners) assert.ok(index.has(env), `${env} (${key})`);

  // The core leaves the adapter reads agree with OPS-3's schema on defaults and types.
  for (const [key, spec] of Object.entries(CORE_LEAF_SPECS)) {
    const leaf = schema.leaves.get(key);
    assert.ok(leaf, `${key} is missing from the core schema`);
    assert.deepEqual(leaf.default, spec.default, `${key} default`);
    assert.deepEqual([].concat(leaf.type), [].concat(spec.type), `${key} type`);
  }
});

test("OPS-3 reads the merged schema's defaults to the same values as the adapter", (t) => {
  const io = platformIo(t);
  for (const name of READ_SECTIONS) {
    const section = io.readSection(name);
    assert.deepEqual(section.errors, [], name);
    assert.deepEqual(section.values, ACCESS_DEFAULTS[name], name);
  }
});

test("updateAccessSection validates, writes through writeSection with the etag, audits and publishes", async () => {
  const writes = [];
  const audits = [];
  const events = [];
  const readSection = fakeReader();
  const source = createAccessConfigSource({ readSection });
  const writeSection = async (name, patch, options) => {
    writes.push({ name, patch, options });
    return { ok: true, etag: "etag-2", changed: ["public.defaults.rpm", "public.exposeSearch"], restartRequired: [], errors: [] };
  };
  const store = { appendAudit: (row) => { audits.push(row); return row; } };
  const bus = { publish: (channel, event) => events.push({ channel, event }) };

  const result = await updateAccessSection(
    "public",
    { defaults: { rpm: 90 }, exposeSearch: true },
    { etag: "etag-1", actor: "session:ab12cd34", actorIp: "127.0.0.1", writeSection, readSection, source, store, bus },
  );
  assert.equal(result.ok, true);
  assert.equal(result.etag, "etag-2");
  assert.deepEqual(result.changed, ["public.defaults.rpm", "public.exposeSearch"]);
  assert.ok(result.config && typeof result.config === "object");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, "public");
  assert.deepEqual(writes[0].patch, { defaults: { rpm: 90 }, exposeSearch: true });
  assert.equal(writes[0].options.etag, "etag-1");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, "session:ab12cd34");
  assert.equal(audits[0].actorIp, "127.0.0.1");
  assert.equal(audits[0].targetId, "public");
  assert.deepEqual(audits[0].details, { fields: ["public.defaults.rpm", "public.exposeSearch"] });
  // Key names only, never values.
  assert.doesNotMatch(JSON.stringify(audits[0]), /\b90\b/);
  assert.deepEqual(events, [{ channel: "access", event: { kind: "settings_changed", section: "public", changed: ["public.defaults.rpm", "public.exposeSearch"], restartRequired: [] } }]);
});

test("updateAccessSection refuses bad input before anything is written", async () => {
  const writes = [];
  const writeSection = async (...args) => { writes.push(args); return { ok: true, etag: "x", changed: [], restartRequired: [], errors: [] }; };
  const readSection = fakeReader();
  const options = { etag: "etag-1", actor: "tester", writeSection, readSection };
  const refused = async (section, patch, code, status, extra = {}) => {
    const result = await updateAccessSection(section, patch, { ...options, ...extra });
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.code, code, JSON.stringify(patch));
    assert.equal(result.status, status, JSON.stringify(patch));
    return result;
  };

  await refused("exposure", { requireApiKey: "on" }, "unknown_section", 400);
  await refused("nope", {}, "unknown_section", 400);
  await refused("public", { exposeSearch: true }, "etag_required", 428, { etag: "" });
  await refused("public", "text", "config_invalid", 400);
  const base = await refused("listeners", { public: { baseUrl: "http://plain.example.test" } }, "config_invalid", 400);
  assert.equal(base.errors[0].field, "listeners.public.baseUrl");
  const cidr = await refused("trustedProxies", { cidrs: ["10.0.0.0/8", "garbage"] }, "config_invalid", 400);
  assert.equal(cidr.errors[0].field, "trustedProxies.cidrs");
  await refused("trustedProxies", { cidrs: ["1.2.3.4/33"] }, "config_invalid", 400);
  await refused("admin", { legacyProxyGateway: "maybe" }, "config_invalid", 400);
  await refused("admin", { extraHosts: ["*"] }, "config_invalid", 400);
  await refused("public", { managersGatewayOnly: "block" }, "config_invalid", 400);
  await refused("public", { defaults: { rpm: 0 } }, "config_invalid", 400);
  const order = await refused("public", { share: { ownerActiveMaxConcurrent: 9 } }, "config_invalid", 400);
  assert.equal(order.errors[0].code, "share_order");
  await refused("public", { authFailure: { banSeconds: 90000 } }, "config_invalid", 400);
  assert.equal(writes.length, 0);

  // null unsets a key and is not judged by the 05 checks.
  const unset = await updateAccessSection("public", { exposeSearch: null }, options);
  assert.equal(unset.ok, true);
  assert.equal(writes.length, 1);
});

test("OPS-3's refusals pass through unchanged and a failed audit does not undo the write", async () => {
  const conflict = { ok: false, status: 409, code: "config_conflict", error: { code: "config_conflict", message: "changed elsewhere" }, etag: "etag-9", changed: [], restartRequired: [], errors: [] };
  const audits = [];
  const refusedWrite = await updateAccessSection("admin", { sessionDays: 30 }, {
    etag: "stale", actor: "t", readSection: fakeReader(), store: { appendAudit: (row) => audits.push(row) },
    writeSection: async () => conflict,
  });
  assert.equal(refusedWrite.ok, false);
  assert.equal(refusedWrite.status, 409);
  assert.equal(refusedWrite.code, "config_conflict");
  assert.equal(refusedWrite.etag, "etag-9");
  assert.equal(audits.length, 0);

  const logged = [];
  const saved = await updateAccessSection("admin", { sessionDays: 30 }, {
    etag: "etag-1", actor: "t", readSection: fakeReader(),
    writeSection: async () => ({ ok: true, etag: "etag-3", changed: ["admin.sessionDays"], restartRequired: [], errors: [] }),
    store: { appendAudit: () => { throw new Error("db locked"); } },
    logger: { warn: (message) => logged.push(message) },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.warnings[0].code, "audit_failed");
  assert.equal(logged.length, 1);

  // A no-op write is neither audited nor published.
  const quiet = [];
  const noop = await updateAccessSection("admin", { sessionDays: 180 }, {
    etag: "etag-1", actor: "t", readSection: fakeReader(),
    writeSection: async () => ({ ok: true, etag: "etag-1", changed: [], restartRequired: [], errors: [] }),
    store: { appendAudit: (row) => quiet.push(row) }, bus: { publish: (...args) => quiet.push(args) },
  });
  assert.equal(noop.ok, true);
  assert.deepEqual(quiet, []);

  await assert.rejects(updateAccessSection("admin", {}, { etag: "e" }), TypeError);
});

test("a real round trip through OPS-3 stores only non-default values and reports restartRequired", async (t) => {
  const io = platformIo(t);
  const source = createAccessConfigSource({ readSection: io.readSection, ttlMs: 60000 });
  const before = source.get();
  assert.equal(before.etag, "none");

  const first = await updateAccessSection("trustedProxies", { cidrs: ["127.0.0.1/32", "::1/128", "10.9.0.0/16"] }, {
    etag: before.etag, actor: "tester", writeSection: io.writeSection, readSection: io.readSection, source,
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.restartRequired, ["entry"]);
  assert.deepEqual(first.config.trustedProxies.cidrs, ["127.0.0.1/32", "::1/128", "10.9.0.0/16"]);
  assert.notEqual(first.etag, "none");

  // A stale etag is a 409 and leaves the file alone.
  const stale = await updateAccessSection("public", { exposeSearch: true }, {
    etag: "none", actor: "tester", writeSection: io.writeSection, readSection: io.readSection, source,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "config_conflict");

  const second = await updateAccessSection("public", { exposeSearch: true, defaults: { rpm: 60 } }, {
    etag: first.etag, actor: "tester", writeSection: io.writeSection, readSection: io.readSection, source,
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.restartRequired, []);
  assert.equal(second.config.public.exposeSearch, true);

  const file = JSON.parse(fs.readFileSync(platform.platformConfigFile({ aiRoot: io.aiRoot, env: {} }), "utf8"));
  assert.equal(file.public.exposeSearch, true);
  assert.deepEqual(file.trustedProxies.cidrs, ["127.0.0.1/32", "::1/128", "10.9.0.0/16"]);
  // The default rpm was written as a no-op and is not stored.
  assert.equal(file.public.defaults?.rpm, undefined);
});
