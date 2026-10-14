"use strict";

// The single secret store (06 OPS-3b, §4.5 and §14). Most cases run against a
// fake DPAPI that speaks the PowerShell helper's stdin protocol; the last ones
// use the real DPAPI and ACL and run on Windows only.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("..");
const secretStore = require("../secret-store");
const { createFakeDpapi, createFakeDpapiExec } = require("./fixtures/secrets/fake-dpapi");

const { createSecretStore, createDpapi, createSecretVault, listSecretNamespaces, allSecretValues } = secretStore;
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const noAcl = { async secure() {} };

async function tempRoot(t, prefix = "secret-store-") {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

function encodings(value) {
  return [
    Buffer.from(value, "utf8"),
    Buffer.from(value, "utf16le"),
    Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8"),
  ];
}

function containsValue(bytes, value) {
  return encodings(value).some((needle) => bytes.includes(needle));
}

function filesUnder(root) {
  const out = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else out.push(full);
    }
  }
  return out;
}

function isUnavailable(error) {
  return error?.code === "SECRET_STORE_UNAVAILABLE" && error?.status === 503;
}

test("set, get, has, list, values and remove round-trip through the DPAPI protocol", async (t) => {
  const aiRoot = await tempRoot(t);
  let clock = Date.parse("2026-10-14T08:00:00.000Z");
  const store = createSecretStore({ aiRoot, namespace: "platform", dpapi: createFakeDpapi(), now: () => clock });
  assert.equal(store.file, path.join(aiRoot, ".runtime", "secrets", "platform.json"));
  assert.equal(store.namespace, "platform");
  assert.deepEqual(store.values(), []);
  assert.equal(store.get("exposure.apiKey"), "");
  assert.equal(store.has("exposure.apiKey"), false);
  assert.equal(fs.existsSync(store.file), false, "reads never create the file");

  await store.set("exposure.apiKey", "fixture-platform-key-0001");
  clock += 1000;
  await store.set("admin:token", "fixture-admin-token-0002");
  assert.equal(store.get("exposure.apiKey"), "fixture-platform-key-0001");
  assert.equal(store.has("admin:token"), true);
  assert.deepEqual(store.values().sort(), ["fixture-admin-token-0002", "fixture-platform-key-0001"]);
  assert.deepEqual(store.list(), [
    { name: "admin:token", createdAt: "2026-10-14T08:00:01.000Z", updatedAt: "2026-10-14T08:00:01.000Z" },
    { name: "exposure.apiKey", createdAt: "2026-10-14T08:00:00.000Z", updatedAt: "2026-10-14T08:00:00.000Z" },
  ]);
  assert.equal(store.protection, "dpapi-user");

  clock += 1000;
  await store.set("exposure.apiKey", "fixture-platform-key-0003");
  const updated = store.list().find((entry) => entry.name === "exposure.apiKey");
  assert.equal(updated.createdAt, "2026-10-14T08:00:00.000Z", "an update keeps createdAt");
  assert.equal(updated.updatedAt, "2026-10-14T08:00:02.000Z");

  const document = JSON.parse(await fsp.readFile(store.file, "utf8"));
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.namespace, "platform");
  assert.equal(document.protection, "dpapi-user");
  assert.deepEqual(Object.keys(document.entries).sort(), ["admin:token", "exposure.apiKey"]);
  for (const entry of Object.values(document.entries)) {
    assert.equal(typeof entry.blob, "string");
    assert.equal(Object.hasOwn(entry, "value"), false);
  }

  // A fresh instance (a restarted process) reads the same values back.
  const reopened = createSecretStore({ aiRoot, namespace: "platform", dpapi: createFakeDpapi() });
  assert.equal(reopened.get("exposure.apiKey"), "fixture-platform-key-0003");

  assert.equal(await store.remove("admin:token"), true);
  assert.equal(await store.remove("admin:token"), false);
  assert.equal(store.get("admin:token"), "");
  assert.deepEqual(store.values(), ["fixture-platform-key-0003"]);
  assert.equal(reopened.get("admin:token"), "", "the other instance reloads after the change");
});

test("with dpapi-user the store file never contains a stored value", async (t) => {
  const aiRoot = await tempRoot(t);
  const store = createSecretStore({ aiRoot, namespace: "webhooks", dpapi: createFakeDpapi() });
  const values = ["fixture-webhook-secret-alpha-0001", "fixture-webhook-secret-beta-0002", "fixture-non-ascii-密钥-0003"];
  for (const [index, value] of values.entries()) await store.set(`wh${index}`, value);
  await store.remove("wh0");
  await store.set("wh1", "fixture-webhook-secret-beta-rotated-0004");
  for (const file of filesUnder(aiRoot)) {
    const bytes = await fsp.readFile(file);
    for (const value of [...values, "fixture-webhook-secret-beta-rotated-0004"]) {
      assert.equal(containsValue(bytes, value), false, `${path.relative(aiRoot, file)} holds a stored value`);
    }
  }
  assert.equal(store.get("wh2"), "fixture-non-ascii-密钥-0003");
});

test("DPAPI requests carry values on stdin only, never in argv", async (t) => {
  const aiRoot = await tempRoot(t);
  const calls = [];
  const dpapi = createDpapi({ exec: createFakeDpapiExec({ calls }), platform: "win32" });
  const store = createSecretStore({ aiRoot, namespace: "internal", dpapi });
  const value = "fixture-internal-hmac-key-0001";
  await store.set("hmac", value);
  const fresh = createSecretStore({ aiRoot, namespace: "internal", dpapi });
  assert.equal(fresh.get("hmac"), value, "the first synchronous get unwraps through the sync variant");

  assert.deepEqual(calls.map((call) => `${call.request.op}:${call.sync ? "sync" : "async"}`), ["probe:async", "protect:async", "unprotect:sync"]);
  const firstArgs = JSON.stringify(calls[0].args);
  for (const call of calls) {
    assert.match(call.command, /powershell\.exe$/i);
    assert.equal(JSON.stringify(call.args), firstArgs, "argv is the same fixed script for every call");
    assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    for (const needle of encodings(value)) {
      assert.equal(call.args.some((arg) => arg.includes(needle.toString("utf8"))), false, "a value reached argv");
    }
  }
  const protect = calls.find((call) => call.request.op === "protect");
  assert.equal(protect.request.entropy, "local-ai-platform:internal");
  assert.deepEqual(protect.request.items, [Buffer.from(value).toString("base64")], "the value travels on stdin");
});

test("a store reloads when another process changes its file", async (t) => {
  const aiRoot = await tempRoot(t);
  const store = createSecretStore({ aiRoot, namespace: "hf", dpapi: createFakeDpapi() });
  await store.set("remembered", "fixture-hf-token-first-0001");
  assert.equal(store.get("remembered"), "fixture-hf-token-first-0001");

  const child = [
    "const { createSecretStore } = require(process.env.SECRET_STORE_MODULE);",
    "const { createFakeDpapi } = require(process.env.FAKE_DPAPI_MODULE);",
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; }).on('end', async () => {",
    "  const job = JSON.parse(input);",
    "  const store = createSecretStore({ aiRoot: job.aiRoot, namespace: 'hf', dpapi: createFakeDpapi() });",
    "  await store.set('remembered', job.value);",
    "  await store.set('second', job.second);",
    "});",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", child], {
    input: JSON.stringify({ aiRoot, value: "fixture-hf-token-rotated-0002", second: "fixture-hf-token-second-0003" }),
    env: {
      ...process.env,
      SECRET_STORE_MODULE: path.join(__dirname, "..", "secret-store.js"),
      FAKE_DPAPI_MODULE: path.join(__dirname, "fixtures", "secrets", "fake-dpapi.js"),
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(store.get("remembered"), "fixture-hf-token-rotated-0002");
  assert.deepEqual(store.values().sort(), ["fixture-hf-token-rotated-0002", "fixture-hf-token-second-0003"]);
});

test("without DPAPI a new store is acl-only, and a later write upgrades it to DPAPI", async (t) => {
  const aiRoot = await tempRoot(t);
  const noDpapi = createFakeDpapi({ failProbe: true });
  const store = createSecretStore({ aiRoot, namespace: "admin", dpapi: noDpapi });
  await store.set("password", "fixture-admin-password-0001");
  assert.equal(store.protection, "acl-only");
  let document = JSON.parse(await fsp.readFile(store.file, "utf8"));
  assert.equal(document.protection, "acl-only");
  assert.equal(document.entries.password.value, "fixture-admin-password-0001");
  assert.equal(Object.hasOwn(document.entries.password, "blob"), false);
  assert.equal(store.get("password"), "fixture-admin-password-0001");

  // Another OS has no DPAPI at all: the probe answers without spawning.
  const calls = [];
  const linux = createDpapi({ exec: createFakeDpapiExec({ calls }), platform: "linux" });
  assert.equal(linux.supported, false);
  assert.equal(await linux.probe(), false);
  assert.equal(linux.probeSync(), false);
  assert.equal(calls.length, 0);
  const elsewhere = createSecretStore({ aiRoot: await tempRoot(t), namespace: "admin", dpapi: linux });
  assert.equal(elsewhere.protection, "acl-only");
  await elsewhere.set("password", "fixture-admin-password-0002");
  assert.equal(calls.length, 0);

  // Once DPAPI works, the next write wraps every value.
  const upgraded = createSecretStore({ aiRoot, namespace: "admin", dpapi: createFakeDpapi() });
  await upgraded.set("second", "fixture-admin-second-0003");
  document = JSON.parse(await fsp.readFile(store.file, "utf8"));
  assert.equal(document.protection, "dpapi-user");
  const bytes = await fsp.readFile(store.file);
  assert.equal(containsValue(bytes, "fixture-admin-password-0001"), false);
  assert.equal(upgraded.get("password"), "fixture-admin-password-0001");
  assert.equal(store.get("password"), "fixture-admin-password-0001", "the first instance reloads the wrapped file");
});

test("a DPAPI-wrapped store never falls back to plaintext", async (t) => {
  const aiRoot = await tempRoot(t);
  await createSecretStore({ aiRoot, namespace: "platform", dpapi: createFakeDpapi() }).set("a", "fixture-platform-a-0001");
  const before = await fsp.readFile(path.join(aiRoot, ".runtime", "secrets", "platform.json"));
  // The probe fails and protect fails: the write must not rewrite the file as acl-only.
  const broken = createSecretStore({
    aiRoot,
    namespace: "platform",
    dpapi: createFakeDpapi({ failProbe: true, fail: (request) => request.op === "protect" }),
  });
  await assert.rejects(() => broken.set("b", "fixture-platform-b-0002"), isUnavailable);
  assert.deepEqual(await fsp.readFile(broken.file), before);
  assert.equal(broken.get("a"), "fixture-platform-a-0001");
});

test("a corrupt file raises SECRET_STORE_UNAVAILABLE, never leaks its text and stays byte-identical", async (t) => {
  const aiRoot = await tempRoot(t);
  const store = createSecretStore({ aiRoot, namespace: "platform", dpapi: createFakeDpapi() });
  await fsp.mkdir(path.dirname(store.file), { recursive: true });
  const corrupt = '{"schemaVersion":1,"namespace":"platform","protection":"acl-only","entries":{"x":{"value":"fixture-leaked-plaintext-0001"';
  await fsp.writeFile(store.file, corrupt, "utf8");
  for (const read of [() => store.get("x"), () => store.values(), () => store.has("x"), () => store.list()]) {
    assert.throws(read, (error) => {
      assert.ok(isUnavailable(error));
      assert.equal(JSON.stringify({ message: error.message, cause: error.cause }).includes("fixture-leaked-plaintext"), false);
      return true;
    });
  }
  await assert.rejects(() => store.load(), isUnavailable);
  await assert.rejects(() => store.set("y", "fixture-would-overwrite-0002"), isUnavailable);
  await assert.rejects(() => store.remove("x"), isUnavailable);
  assert.equal(await fsp.readFile(store.file, "utf8"), corrupt);

  for (const shape of [
    "[]",
    '{"schemaVersion":2,"namespace":"platform","protection":"acl-only","entries":{}}',
    '{"schemaVersion":1,"namespace":"other","protection":"acl-only","entries":{}}',
    '{"schemaVersion":1,"namespace":"platform","protection":"none","entries":{}}',
    '{"schemaVersion":1,"namespace":"platform","protection":"dpapi-user","entries":{"x":{"value":"plain"}}}',
  ]) {
    await fsp.writeFile(store.file, shape, "utf8");
    assert.throws(() => store.values(), isUnavailable, shape);
    await assert.rejects(() => store.set("y", "fixture-would-overwrite-0003"), isUnavailable);
    assert.equal(await fsp.readFile(store.file, "utf8"), shape);
  }
});

test("a blob that fails to unprotect raises SECRET_STORE_UNAVAILABLE and the file stays byte-identical", async (t) => {
  const aiRoot = await tempRoot(t);
  const writer = createSecretStore({ aiRoot, namespace: "runtime.vllm", dpapi: createFakeDpapi() });
  await writer.set("ref-0001-abcdef", "fixture-runtime-key-0001");
  const document = JSON.parse(await fsp.readFile(writer.file, "utf8"));
  document.entries["ref-0001-abcdef"].blob = Buffer.from("not a dpapi blob").toString("base64");
  const tampered = `${JSON.stringify(document, null, 2)}\n`;
  await fsp.writeFile(writer.file, tampered, "utf8");

  const reader = createSecretStore({ aiRoot, namespace: "runtime.vllm", dpapi: createFakeDpapi() });
  assert.throws(() => reader.get("ref-0001-abcdef"), isUnavailable);
  assert.throws(() => reader.values(), isUnavailable, "the failure is remembered without another DPAPI call");
  await assert.rejects(() => reader.load(), isUnavailable);
  await assert.rejects(() => reader.set("ref-0002-abcdef", "fixture-runtime-key-0002"), isUnavailable);
  await assert.rejects(() => writer.remove("ref-0001-abcdef"), isUnavailable);
  assert.equal(await fsp.readFile(writer.file, "utf8"), tampered);

  // A failing DPAPI helper (not a bad blob) fails closed the same way.
  const failing = createSecretStore({ aiRoot, namespace: "runtime.llama", dpapi: createFakeDpapi() });
  await failing.set("ref-0003-abcdef", "fixture-runtime-key-0003");
  const before = await fsp.readFile(failing.file);
  const down = createSecretStore({ aiRoot, namespace: "runtime.llama", dpapi: createFakeDpapi({ fail: (request) => request.op === "unprotect" }) });
  assert.throws(() => down.values(), isUnavailable);
  await assert.rejects(() => down.set("ref-0004-abcdef", "fixture-runtime-key-0004"), isUnavailable);
  assert.deepEqual(await fsp.readFile(failing.file), before);
});

test("namespaces, names and values are validated", async (t) => {
  const aiRoot = await tempRoot(t);
  for (const namespace of ["", "a", "Platform", "1platform", "-platform", "plat/form", "../platform", "plat form", `p${"x".repeat(64)}`, undefined]) {
    assert.throws(() => createSecretStore({ aiRoot, namespace, dpapi: createFakeDpapi() }), (error) => {
      assert.equal(error.code, "SECRET_STORE_INVALID_NAMESPACE");
      assert.equal(error.status, 400);
      return true;
    }, String(namespace));
  }
  for (const namespace of ["platform", "platform-control", "runtime.vllm", "runtime.legacy-0a1b2c3d", "engines.external", `p${"x".repeat(63)}`]) {
    assert.equal(createSecretStore({ aiRoot, namespace, dpapi: createFakeDpapi() }).namespace, namespace);
  }
  const store = createSecretStore({ aiRoot, namespace: "platform", dpapi: createFakeDpapi() });
  for (const name of ["", "../escape", "a b", "a/b", "a\\b", "x".repeat(161), null, 42]) {
    assert.throws(() => store.get(name), (error) => error.code === "SECRET_STORE_INVALID_NAME" && error.status === 400);
    await assert.rejects(() => store.set(name, "fixture-value-0001"), (error) => error.code === "SECRET_STORE_INVALID_NAME");
    await assert.rejects(() => store.remove(name), (error) => error.code === "SECRET_STORE_INVALID_NAME");
  }
  for (const value of ["", null, undefined, 42]) {
    await assert.rejects(() => store.set("name", value), (error) => error.code === "SECRET_STORE_INVALID_VALUE" && error.status === 400);
  }
  for (const name of ["a", "x".repeat(160), "wake-slp_0001", "exposure.apiKey", "k:1.2_3-4", "3f0c8a5e-0b7e-4b55-9d6a-0d8f1c2b3a4e"]) {
    await store.set(name, `fixture-value-for-${name.length}`);
    assert.equal(store.has(name), true);
  }
  assert.equal(fs.existsSync(path.join(aiRoot, ".runtime", "secrets", "escape.json")), false);
});

test("a failed ACL leaves the write in place and reports secret_store_acl_failed", async (t) => {
  const aiRoot = await tempRoot(t);
  const targets = [];
  const acl = {
    async secure(target, options = {}) {
      targets.push({ target, directory: Boolean(options.directory) });
      if (!options.directory) throw new Error("icacls failed");
    },
  };
  const store = createSecretStore({ aiRoot, namespace: "platform", dpapi: createFakeDpapi(), acl });
  await assert.rejects(() => store.set("token", "fixture-platform-token-0001"), (error) => {
    assert.equal(error.code, "secret_store_acl_failed");
    return true;
  });
  assert.equal(store.get("token"), "fixture-platform-token-0001");
  assert.equal(createSecretStore({ aiRoot, namespace: "platform", dpapi: createFakeDpapi(), acl: noAcl }).get("token"), "fixture-platform-token-0001");
  assert.deepEqual(targets, [
    { target: path.join(aiRoot, ".runtime", "secrets"), directory: true },
    { target: store.file, directory: false },
  ], "the new directory and the file are both secured");
});

test("writers in two store instances never lose an update, and a stale lock is taken over", async (t) => {
  const aiRoot = await tempRoot(t);
  const first = createSecretStore({ aiRoot, namespace: "webhooks", dpapi: createFakeDpapi(), acl: noAcl });
  const second = createSecretStore({ aiRoot, namespace: "webhooks", dpapi: createFakeDpapi(), acl: noAcl });
  const writes = [];
  for (let index = 0; index < 6; index += 1) {
    writes.push((index % 2 ? first : second).set(`wh${index}`, `fixture-webhook-secret-${index}-0001`));
  }
  await Promise.all(writes);
  assert.deepEqual(first.list().map((entry) => entry.name), ["wh0", "wh1", "wh2", "wh3", "wh4", "wh5"]);
  assert.equal(fs.existsSync(`${first.file}.lock`), false, "the lock is released");

  // A lock older than 10 s is stale and is taken over.
  await fsp.writeFile(`${first.file}.lock`, '{"pid":1}', "utf8");
  const old = new Date(Date.now() - 60000);
  await fsp.utimes(`${first.file}.lock`, old, old);
  await first.set("wh6", "fixture-webhook-secret-6-0001");
  assert.equal(second.get("wh6"), "fixture-webhook-secret-6-0001");

  // A live lock makes the writer wait until it is released.
  await fsp.writeFile(`${first.file}.lock`, '{"pid":1}', "utf8");
  let settled = false;
  const waiting = first.set("wh7", "fixture-webhook-secret-7-0001").then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(settled, false);
  await fsp.rm(`${first.file}.lock`);
  await waiting;
  assert.equal(second.get("wh7"), "fixture-webhook-secret-7-0001");
});

test("importLegacy keeps names, verifies before it replaces the file, and is idempotent", async (t) => {
  const aiRoot = await tempRoot(t);
  const legacy = path.join(aiRoot, ".runtime", "platform-mcp", "server.env");
  await fsp.mkdir(path.dirname(legacy), { recursive: true });
  const original = "PLATFORM_MCP_PORT=5190\nPLATFORM_MCP_API_KEY=fixture-mcp-key-0001\n";
  await fsp.writeFile(legacy, original, "utf8");
  // An env-file map, the shape OPS-4's MCP hook passes: the key moves to the
  // store and the file is rewritten without it.
  const map = (text) => {
    const lines = String(text).split(/\r?\n/);
    const keyLine = lines.find((line) => line.startsWith("PLATFORM_MCP_API_KEY="));
    return {
      entries: keyLine ? [{ name: "mcp.apiKey", value: keyLine.slice("PLATFORM_MCP_API_KEY=".length) }] : [],
      replacement: lines.filter((line) => line !== keyLine).join("\n"),
    };
  };
  const calls = [];
  const dpapi = createDpapi({
    exec: createFakeDpapiExec({
      calls,
      transform(request, response) {
        // The legacy file still holds the key when the store is read back.
        if (request.op === "unprotect") assert.equal(fs.readFileSync(legacy, "utf8"), original);
        return response;
      },
    }),
    platform: "win32",
  });
  const store = createSecretStore({ aiRoot, namespace: "platform", dpapi });
  assert.deepEqual(await store.importLegacy({ file: legacy, map }), { imported: 1, skipped: 0, replaced: true });
  assert.equal(store.get("mcp.apiKey"), "fixture-mcp-key-0001");
  assert.equal(await fsp.readFile(legacy, "utf8"), "PLATFORM_MCP_PORT=5190\n");
  assert.ok(calls.some((call) => call.request.op === "unprotect"), "the import was read back through DPAPI");

  const protects = calls.filter((call) => call.request.op === "protect").length;
  assert.deepEqual(await store.importLegacy({ file: legacy, map }), { imported: 0, skipped: 0, replaced: false });
  assert.equal(calls.filter((call) => call.request.op === "protect").length, protects);
  assert.deepEqual(await store.importLegacy({ file: path.join(aiRoot, "missing.json") }), { imported: 0, skipped: 0, replaced: false });
});

test("namespaces are listed, values are collected across them, and the vault is namespace-first", async (t) => {
  const aiRoot = await tempRoot(t);
  const dpapi = createFakeDpapi();
  const vault = createSecretVault({ aiRoot, dpapi, acl: noAcl });
  assert.deepEqual(listSecretNamespaces(aiRoot), []);
  await vault.set("hf", "tok_0001", "fixture-hf-token-0001");
  await vault.set("webhooks", "wh_0001", "fixture-webhook-secret-0002");
  assert.equal(vault.has("hf", "tok_0001"), true);
  assert.equal(vault.get("webhooks", "wh_0001"), "fixture-webhook-secret-0002");
  assert.deepEqual(vault.list("hf").map((entry) => entry.name), ["tok_0001"]);
  assert.deepEqual(listSecretNamespaces(aiRoot), ["hf", "webhooks"]);
  assert.deepEqual(vault.values().sort(), ["fixture-hf-token-0001", "fixture-webhook-secret-0002"]);
  assert.deepEqual(allSecretValues(aiRoot, { dpapi }).sort(), ["fixture-hf-token-0001", "fixture-webhook-secret-0002"]);
  assert.deepEqual(allSecretValues(aiRoot, { dpapi, namespaces: ["hf"] }), ["fixture-hf-token-0001"]);

  // A namespace that cannot be read is reported and skipped; the rest still feed the redactor.
  await fsp.writeFile(path.join(aiRoot, ".runtime", "secrets", "admin.json"), "{broken", "utf8");
  const failed = [];
  assert.deepEqual(allSecretValues(aiRoot, { dpapi, onError: (namespace, error) => failed.push([namespace, error.code]) }).sort(),
    ["fixture-hf-token-0001", "fixture-webhook-secret-0002"]);
  assert.deepEqual(failed, [["admin", "SECRET_STORE_UNAVAILABLE"]]);

  const redactor = core.createSecretRedactor({ getSecrets: () => allSecretValues(aiRoot, { dpapi }) });
  assert.equal(redactor.redact("token fixture-hf-token-0001 sent"), "token <redacted> sent");

  assert.equal(await vault.clear("hf", "tok_0001"), true);
  assert.equal(vault.has("hf", "tok_0001"), false);
});

test("manager-core exposes the store as the core.secrets namespace", () => {
  assert.equal(core.secrets.createSecretStore, createSecretStore);
  assert.equal(core.secrets.createDpapi, createDpapi);
  assert.equal(typeof core.secrets.listSecretNamespaces, "function");
  assert.equal(typeof core.secrets.allSecretValues, "function");
  assert.ok(core.secrets.SECRET_NAMESPACES.includes("runtime.vllm"));
  assert.ok(core.secrets.SECRET_NAMESPACES.includes("platform-control"));
  assert.equal(Object.hasOwn(core, "createSecretStore"), false, "the store is a namespace, not flat names");
});

test("no code path creates platform-secrets.json or hub-secrets.json", (t) => {
  const listed = spawnSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], { encoding: "utf8", windowsHide: true });
  if (listed.error || listed.status !== 0 || !listed.stdout) return t.skip("not a git checkout");
  const forbidden = ["platform", "hub"].map((prefix) => `${prefix}-secrets.json`);
  const self = path.relative(REPO_ROOT, __filename).split(path.sep).join("/");
  const hits = listed.stdout.split("\0").filter(Boolean)
    .filter((file) => /\.(?:c?js|mjs|ts|ps1|cmd|py|json)$/i.test(file) && file !== self && !file.startsWith("docs/"))
    .filter((file) => {
      let text = "";
      try {
        text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      } catch {}
      return forbidden.some((name) => text.includes(name));
    });
  assert.deepEqual(hits, []);
});

const onWindows = process.platform === "win32";

test("a real DPAPI round trip leaves only a DPAPI blob behind an owner-only ACL", { skip: !onWindows && "DPAPI and icacls exist only on Windows", timeout: 120000 }, async (t) => {
  const aiRoot = await tempRoot(t, "secret-store-dpapi-");
  const value = "fixture-real-dpapi-value-0001";
  const store = createSecretStore({ aiRoot, namespace: "platform-control", dpapi: createDpapi() });
  await store.set("token", value);
  assert.equal(store.protection, "dpapi-user");
  const document = JSON.parse(await fsp.readFile(store.file, "utf8"));
  assert.ok(document.entries.token.blob.startsWith(secretStore.DPAPI_BLOB_HEADER), "a DPAPI blob");
  for (const file of filesUnder(aiRoot)) assert.equal(containsValue(await fsp.readFile(file), value), false, file);
  const reopened = createSecretStore({ aiRoot, namespace: "platform-control", dpapi: createDpapi() });
  assert.equal(reopened.get("token"), value);
  await reopened.load();

  // Owner plus SYSTEM, nothing inherited, on both the file and the directory.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "foreach ($target in @($env:SECRET_STORE_FILE, $env:SECRET_STORE_DIR)) {",
    "  $acl = Get-Acl -LiteralPath $target",
    "  $sids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)",
    "  $others = @($sids | Where-Object { $_ -ne $me -and $_ -ne 'S-1-5-18' })",
    "  Write-Output ('{0}|{1}|{2}' -f $acl.AreAccessRulesProtected, ($sids -contains $me), $others.Count)",
    "}",
  ].join("\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...env, SECRET_STORE_FILE: store.file, SECRET_STORE_DIR: path.dirname(store.file) },
    windowsHide: true,
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["True|True|0", "True|True|0"]);
});

test("the real DPAPI helper refuses a blob under another namespace's entropy", { skip: !onWindows && "DPAPI exists only on Windows", timeout: 120000 }, async () => {
  const dpapi = createDpapi();
  assert.equal(await dpapi.probe(), true);
  const [blob] = await dpapi.protect("local-ai-platform:platform", ["fixture-entropy-value-0001"]);
  assert.deepEqual(dpapi.unprotectSync("local-ai-platform:platform", [blob]), ["fixture-entropy-value-0001"]);
  await assert.rejects(() => dpapi.unprotect("local-ai-platform:admin", [blob]), (error) => {
    assert.equal(error.code, "DPAPI_FAILED");
    assert.equal(error.message.includes("fixture-entropy-value"), false);
    return true;
  });
});
