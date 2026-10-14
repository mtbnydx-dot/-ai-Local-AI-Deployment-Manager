"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("..");
const { createDpapi } = require("../secret-store");
const { createFakeDpapi, createFakeDpapiExec } = require("./fixtures/secrets/fake-dpapi");

test("runtime API keys are stored behind opaque references instead of Docker labels", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "runtime-secrets-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "runtime-api-keys.json");
  const store = core.createRuntimeSecretStore({ file });
  const reference = await store.set("sk-runtime-private");
  assert.match(reference, /^[a-f0-9-]{36}$/i);
  assert.equal(store.get(reference), "sk-runtime-private");
  assert.equal(store.get("../../escape"), "");
  // 06 OPS-3b: the value lives DPAPI-wrapped in the secret store, so neither
  // the legacy file nor the store file contains it. A host without DPAPI
  // keeps an acl-only store by design (06 §4.5).
  for (const target of process.platform === "win32" ? [file, store.file] : [file]) {
    const bytes = await fsp.readFile(target).catch((error) => (error.code === "ENOENT" ? Buffer.alloc(0) : Promise.reject(error)));
    assert.equal(bytes.includes(Buffer.from("sk-runtime-private")), false, target);
  }
  assert.deepEqual(store.values(), ["sk-runtime-private"]);
  assert.equal(await store.remove(reference), true);
  assert.equal(store.get(reference), "");
});

test("runtime API-key store treats missing files as empty but fails closed on corruption", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "runtime-secrets-corrupt-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "runtime-api-keys.json");
  const store = core.createRuntimeSecretStore({ file });
  assert.deepEqual(store.values(), []);
  await fsp.writeFile(file, "{broken", "utf8");
  assert.throws(() => store.values(), (error) => error?.code === "RUNTIME_SECRET_STORE_UNAVAILABLE" && error?.status === 503);
  await assert.rejects(() => store.set("test-key-will-not-overwrite-corruption"), (error) => error?.code === "RUNTIME_SECRET_STORE_UNAVAILABLE");
  assert.equal(await fsp.readFile(file, "utf8"), "{broken");
});

test("manager status redaction removes plaintext secrets but keeps capability booleans", () => {
  const redacted = core.redactManagerSecrets({
    vllmApiKey: "sk-runtime-private",
    apiKeyRequired: true,
    hasApiKey: true,
    tokenizer: "QwenTokenizer",
    container: {
      labels: {
        "ai.manager.api-key": "sk-runtime-private",
        "ai.manager.api-key-ref": "safe-reference",
      },
    },
  });
  assert.equal(Object.hasOwn(redacted, "vllmApiKey"), false);
  assert.equal(redacted.apiKeyRequired, true);
  assert.equal(redacted.hasApiKey, true);
  assert.equal(redacted.tokenizer, "QwenTokenizer");
  assert.equal(Object.hasOwn(redacted.container.labels, "ai.manager.api-key"), false);
  assert.equal(redacted.container.labels["ai.manager.api-key-ref"], "safe-reference");
});

test("manager redaction removes known secrets embedded inside logs", () => {
  const redacted = core.redactManagerSecrets({
    logs: ["docker run -e HF_TOKEN=hf_private_token_value image"],
  }, ["hf_private_token_value"]);
  assert.deepEqual(redacted.logs, ["docker run -e HF_TOKEN=<redacted> image"]);
});

test("manager API redaction fails closed when secret enumeration is unavailable", () => {
  const middleware = core.createManagerApiSecretRedactionMiddleware({
    getSecrets: () => { throw new Error("corrupt store"); },
  });
  let statusCode = 200;
  let payload = null;
  const response = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
  };
  middleware({ path: "/api/status" }, response, () => {});
  response.json({ logs: ["secret that must not escape"] });
  assert.equal(statusCode, 503);
  assert.equal(payload.error, "runtime_secret_store_unavailable");
  assert.equal(JSON.stringify(payload).includes("must not escape"), false);
});

test("manager API redaction preserves only one-time service client keys", () => {
  const invoke = (method, path, value) => {
    const middleware = core.createManagerApiSecretRedactionMiddleware({ getSecrets: () => [] });
    let payload = null;
    const response = {
      status() { return this; },
      json(next) { payload = next; return next; },
    };
    middleware({ method, path }, response, () => {});
    response.json(value);
    return payload;
  };
  const oneTimeKey = "test-key-vllm-one-time-client";
  const source = {
    ok: true,
    apiKey: oneTimeKey,
    client: { id: "edge-client", keyHash: "must-not-escape" },
  };

  const created = invoke("POST", "/api/service-clients", source);
  assert.equal(created.apiKey, oneTimeKey);
  assert.equal(Object.hasOwn(created.client, "keyHash"), false);

  const rotated = invoke("POST", "/api/service-clients/edge-client/rotate", source);
  assert.equal(rotated.apiKey, oneTimeKey);

  const listed = invoke("GET", "/api/service-clients", source);
  assert.equal(Object.hasOwn(listed, "apiKey"), false);

  const unrelated = invoke("POST", "/api/service-exposure", source);
  assert.equal(Object.hasOwn(unrelated, "apiKey"), false);
});

test("cached secret list reads the store at most once per window and set/remove invalidate it", async () => {
  const secrets = new Map([["ref-existing-01", "fixture-runtime-key-existing"]]);
  let reads = 0;
  let clock = 1000;
  const store = {
    file: "unused",
    get: (reference) => secrets.get(reference) || "",
    values: () => {
      reads += 1;
      return Array.from(secrets.values());
    },
    set: async (secret) => {
      const reference = `ref-${secrets.size + 1}-generated`;
      secrets.set(reference, secret);
      return reference;
    },
    remove: async (reference) => secrets.delete(reference),
  };
  let extra = "fixture-extra-token-value";
  const list = core.createCachedSecretList({ store, sources: [() => extra, () => "", () => undefined], refreshMs: 1000, now: () => clock });

  assert.deepEqual(list.getSecrets(), ["fixture-runtime-key-existing", "fixture-extra-token-value"]);
  list.getSecrets();
  list.getSecrets();
  assert.equal(reads, 1, "repeated redactions inside the window reuse the cached list");

  const reference = await list.store.set("fixture-runtime-key-added");
  assert.equal(list.store.get(reference), "fixture-runtime-key-added");
  assert.ok(list.getSecrets().includes("fixture-runtime-key-added"), "set() invalidates the cache");
  assert.equal(reads, 2);

  await list.store.remove(reference);
  assert.ok(!list.getSecrets().includes("fixture-runtime-key-added"), "remove() invalidates the cache");
  assert.equal(reads, 3);

  extra = "fixture-extra-token-rotated";
  assert.ok(!list.getSecrets().includes(extra), "other sources refresh on the window, not per call");
  clock += 1000;
  assert.ok(list.getSecrets().includes(extra));
  assert.equal(reads, 4);

  list.invalidate();
  list.getSecrets();
  assert.equal(reads, 5);
});

test("cached secret list feeds the bound redactor and does not cache a failing store", () => {
  let broken = true;
  const store = {
    values: () => {
      if (broken) throw new Error("corrupt store");
      return ["fixture-runtime-key-recovered"];
    },
    set: async () => "",
    remove: async () => false,
  };
  const list = core.createCachedSecretList({ store, now: () => 0 });
  const redactor = core.createSecretRedactor({ getSecrets: list.getSecrets });
  // A failing store leaves the patterns-only fallback in place.
  assert.equal(redactor.redact("--api-key fixture-runtime-key-recovered"), "--api-key <redacted>");
  assert.equal(redactor.redact("plain fixture-runtime-key-recovered"), "plain fixture-runtime-key-recovered");
  broken = false;
  assert.equal(redactor.redact("plain fixture-runtime-key-recovered"), "plain <redacted>");
});

// --- 06 OPS-3b: the facade over the single secret store --------------------

async function legacyFixture(t, entries, { manager = "vllm-manager" } = {}) {
  const aiRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "runtime-secrets-migrate-"));
  t.after(() => fsp.rm(aiRoot, { recursive: true, force: true }));
  const file = path.join(aiRoot, manager, "logs", "runtime-api-keys.json");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const secrets = {};
  for (const [reference, secret] of Object.entries(entries)) secrets[reference] = { secret, createdAt: "2026-09-01T00:00:00.000Z" };
  const text = `${JSON.stringify({ version: 1, secrets }, null, 2)}\n`;
  await fsp.writeFile(file, text, "utf8");
  return { aiRoot, file, text };
}

const LEGACY = {
  "3f0c8a5e-0b7e-4b55-9d6a-0d8f1c2b3a4e": "fixture-runtime-key-legacy-0001",
  "wake-slp_0001": "fixture-runtime-key-legacy-0002",
};

function failsClosed(error) {
  assert.equal(error?.code, "RUNTIME_SECRET_STORE_UNAVAILABLE");
  assert.equal(error?.status, 503);
  return true;
}

test("legacy import keeps references and replaces the old file with the stub", async (t) => {
  const { aiRoot, file } = await legacyFixture(t, LEGACY);
  const store = core.createRuntimeSecretStore({ file, namespace: "runtime.vllm", aiRoot, dpapi: createFakeDpapi() });
  assert.equal(store.namespace, "runtime.vllm");
  assert.equal(store.file, path.join(aiRoot, ".runtime", "secrets", "runtime.vllm.json"));
  // The first synchronous read already serves every reference while the
  // migration runs in the background.
  assert.equal(store.get("3f0c8a5e-0b7e-4b55-9d6a-0d8f1c2b3a4e"), "fixture-runtime-key-legacy-0001");
  assert.deepEqual(store.values().sort(), Object.values(LEGACY).sort());
  await store.load();

  assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")), { version: 1, secrets: {}, migratedTo: "secret-store:runtime.vllm" });
  const document = JSON.parse(await fsp.readFile(store.file, "utf8"));
  assert.deepEqual(Object.keys(document.entries).sort(), Object.keys(LEGACY).sort());
  assert.equal(document.entries["wake-slp_0001"].createdAt, "2026-09-01T00:00:00.000Z");
  for (const [reference, secret] of Object.entries(LEGACY)) assert.equal(store.get(reference), secret);
  assert.deepEqual(store.values().sort(), Object.values(LEGACY).sort());

  // Code that still reads the old file sees an empty store and fails closed.
  const oldShape = JSON.parse(await fsp.readFile(file, "utf8"));
  assert.deepEqual(oldShape.secrets, {});
  assert.equal(await store.remove("wake-slp_0001"), true);
  assert.equal(store.get("wake-slp_0001"), "");
});

test("a write waits for the migration and keeps old and new references", async (t) => {
  const { aiRoot, file } = await legacyFixture(t, LEGACY, { manager: "llama-manager" });
  const store = core.createRuntimeSecretStore({ file, namespace: "runtime.llama", aiRoot, dpapi: createFakeDpapi() });
  const reference = await store.set("fixture-runtime-key-new-0003");
  assert.equal(JSON.parse(await fsp.readFile(file, "utf8")).migratedTo, "secret-store:runtime.llama");
  assert.equal(store.get(reference), "fixture-runtime-key-new-0003");
  assert.equal(store.get("wake-slp_0001"), "fixture-runtime-key-legacy-0002");
  assert.deepEqual(store.values().sort(), [...Object.values(LEGACY), "fixture-runtime-key-new-0003"].sort());
});

test("the stub is written only after the store was read back and verified", async (t) => {
  const { aiRoot, file, text } = await legacyFixture(t, LEGACY);
  let readBack = 0;
  const dpapi = createDpapi({
    platform: "win32",
    exec: createFakeDpapiExec({
      transform(request, response) {
        if (request.op !== "unprotect") return response;
        readBack += 1;
        // The read-back happens while the old file still holds the keys...
        assert.equal(fs.readFileSync(file, "utf8"), text);
        // ...and here it returns values that differ from the import.
        return { ok: true, items: response.items.map(() => Buffer.from("fixture-tampered-value").toString("base64")) };
      },
    }),
  });
  const store = core.createRuntimeSecretStore({ file, namespace: "runtime.vllm", aiRoot, dpapi });
  await assert.rejects(() => store.load(), failsClosed);
  assert.ok(readBack >= 1, "the import was read back");
  assert.equal(await fsp.readFile(file, "utf8"), text, "the old file is untouched");
  // Reads keep working from the old file until a migration succeeds; writes fail closed.
  assert.equal(store.get("wake-slp_0001"), "fixture-runtime-key-legacy-0002");
  await assert.rejects(() => store.set("fixture-runtime-key-new-0003"), failsClosed);
  assert.equal(await fsp.readFile(file, "utf8"), text);
});

test("a corrupt legacy file fails closed with 503 and stays untouched", async (t) => {
  const aiRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "runtime-secrets-corrupt-legacy-"));
  t.after(() => fsp.rm(aiRoot, { recursive: true, force: true }));
  const file = path.join(aiRoot, "llama-manager", "logs", "runtime-api-keys.json");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const corrupt = '{"version":1,"secrets":{"3f0c8a5e-0b7e-4b55":{"secret":"fixture-runtime-key-in-corrupt-file"';
  await fsp.writeFile(file, corrupt, "utf8");
  const calls = [];
  const store = core.createRuntimeSecretStore({
    file,
    namespace: "runtime.llama",
    aiRoot,
    dpapi: createDpapi({ exec: createFakeDpapiExec({ calls }), platform: "win32" }),
  });
  const closedWithoutLeak = (error) => {
    failsClosed(error);
    assert.equal(JSON.stringify({ message: error.message, cause: error.cause }).includes("fixture-runtime-key-in-corrupt-file"), false);
    return true;
  };
  assert.throws(() => store.values(), closedWithoutLeak);
  assert.throws(() => store.get("3f0c8a5e-0b7e-4b55"), closedWithoutLeak);
  await assert.rejects(() => store.load(), closedWithoutLeak);
  await assert.rejects(() => store.set("fixture-runtime-key-new-0001"), closedWithoutLeak);
  await assert.rejects(() => store.remove("3f0c8a5e-0b7e-4b55"), closedWithoutLeak);
  assert.equal(await fsp.readFile(file, "utf8"), corrupt);
  assert.equal(fs.existsSync(store.file), false, "nothing was imported");
  assert.equal(calls.length, 0);
});

test("the second load is a no-op", async (t) => {
  const { aiRoot, file } = await legacyFixture(t, LEGACY);
  await core.createRuntimeSecretStore({ file, namespace: "runtime.vllm", aiRoot, dpapi: createFakeDpapi() }).load();
  const storeFile = path.join(aiRoot, ".runtime", "secrets", "runtime.vllm.json");
  const snapshot = async (target) => ({ bytes: await fsp.readFile(target), mtimeMs: (await fsp.stat(target)).mtimeMs });
  const legacyBefore = await snapshot(file);
  const storeBefore = await snapshot(storeFile);

  const calls = [];
  const again = core.createRuntimeSecretStore({
    file,
    namespace: "runtime.vllm",
    aiRoot,
    dpapi: createDpapi({ exec: createFakeDpapiExec({ calls }), platform: "win32" }),
  });
  await again.load();
  await again.load();
  assert.deepEqual(again.values().sort(), Object.values(LEGACY).sort());
  assert.deepEqual(calls.map((call) => call.request.op), ["unprotect"], "one unwrap: no import, no protect");
  assert.deepEqual(await snapshot(file), legacyBefore);
  assert.deepEqual(await snapshot(storeFile), storeBefore);
  assert.equal(fs.existsSync(`${storeFile}.lock`), false);
});

test("a stored value inside a log line is redacted through the store's values()", async (t) => {
  const { aiRoot, file } = await legacyFixture(t, LEGACY);
  const store = core.createRuntimeSecretStore({ file, namespace: "runtime.vllm", aiRoot, dpapi: createFakeDpapi() });
  const reference = await store.set("fixture-runtime-key-new-0003");
  const redactor = core.createSecretRedactor({ getSecrets: store.values });
  const line = `vllm serve ready; client used fixture-runtime-key-new-0003 and fixture-runtime-key-legacy-0001 (ref ${reference})`;
  assert.equal(redactor.redact(line), `vllm serve ready; client used <redacted> and <redacted> (ref ${reference})`);
  // The managers feed the same values through the cached list.
  const list = core.createCachedSecretList({ store });
  assert.ok(list.getSecrets().includes("fixture-runtime-key-legacy-0002"));
});

test("a store named only by its file gets a legacy namespace next to that file", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "runtime-secrets-only-file-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "runtime-api-keys.json");
  const store = core.createRuntimeSecretStore({ file, dpapi: createFakeDpapi() });
  const digest = crypto.createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 8);
  assert.equal(store.namespace, `runtime.legacy-${digest}`);
  assert.equal(store.file, path.join(root, ".runtime", "secrets", `runtime.legacy-${digest}.json`));
  assert.equal(store.legacyFile, path.resolve(file));
});

test("no stored value appears under a fixture root except as a DPAPI blob", { timeout: 180000 }, async (t) => {
  const aiRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "runtime-secrets-fixture-root-"));
  t.after(() => fsp.rm(aiRoot, { recursive: true, force: true }));
  // The real DPAPI where it exists; elsewhere the fake stands in for it.
  const dpapi = process.platform === "win32" ? undefined : createFakeDpapi();
  const stored = [];
  const managers = {};
  for (const manager of ["vllm", "llama"]) {
    const file = path.join(aiRoot, `${manager}-manager`, "logs", "runtime-api-keys.json");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const legacyValue = `fixture-${manager}-legacy-runtime-key-0001`;
    stored.push(legacyValue);
    await fsp.writeFile(file, JSON.stringify({ version: 1, secrets: { [`legacy-${manager}-reference`]: { secret: legacyValue, createdAt: "" } } }), "utf8");
    // Wired the way both servers wire it.
    managers[manager] = core.createRuntimeSecretStore({ file, namespace: `runtime.${manager}`, aiRoot, dpapi });
  }
  for (const [manager, store] of Object.entries(managers)) {
    assert.equal(store.get(`legacy-${manager}-reference`), `fixture-${manager}-legacy-runtime-key-0001`);
    const running = `fixture-${manager}-running-key-0002`;
    const sleeping = `fixture-${manager}-wake-key-0003`;
    stored.push(running, sleeping);
    const reference = await store.set(running);
    await store.set(sleeping);
    await store.remove(reference);
    await store.set(running);
    await store.load();
  }
  const files = [];
  const pending = [aiRoot];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else files.push(full);
    }
  }
  const names = files.map((full) => path.relative(aiRoot, full).split(path.sep).join("/")).sort();
  assert.deepEqual(names, [
    ".runtime/secrets/runtime.llama.json",
    ".runtime/secrets/runtime.vllm.json",
    "llama-manager/logs/runtime-api-keys.json",
    "vllm-manager/logs/runtime-api-keys.json",
  ]);
  for (const full of files) {
    const bytes = await fsp.readFile(full);
    for (const value of stored) {
      for (const needle of [Buffer.from(value), Buffer.from(value, "utf16le"), Buffer.from(Buffer.from(value).toString("base64"))]) {
        assert.equal(bytes.includes(needle), false, `${path.relative(aiRoot, full)} holds ${value}`);
      }
    }
  }
  for (const manager of ["vllm", "llama"]) {
    const document = JSON.parse(await fsp.readFile(path.join(aiRoot, ".runtime", "secrets", `runtime.${manager}.json`), "utf8"));
    assert.equal(document.protection, "dpapi-user");
    assert.ok(Object.values(document.entries).every((entry) => typeof entry.blob === "string" && !Object.hasOwn(entry, "value")));
    const stub = JSON.parse(await fsp.readFile(path.join(aiRoot, `${manager}-manager`, "logs", "runtime-api-keys.json"), "utf8"));
    assert.equal(stub.migratedTo, `secret-store:runtime.${manager}`);
  }
  const forbidden = ["platform", "hub"].map((prefix) => `${prefix}-secrets.json`);
  assert.equal(names.some((name) => forbidden.includes(path.posix.basename(name))), false);
});
