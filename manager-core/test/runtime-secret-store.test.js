"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("..");

test("runtime API keys are stored behind opaque references instead of Docker labels", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "runtime-secrets-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "runtime-api-keys.json");
  const store = core.createRuntimeSecretStore({ file });
  const reference = await store.set("sk-runtime-private");
  assert.match(reference, /^[a-f0-9-]{36}$/i);
  assert.equal(store.get(reference), "sk-runtime-private");
  assert.equal(store.get("../../escape"), "");
  const payload = JSON.parse(await fsp.readFile(file, "utf8"));
  assert.equal(payload.secrets[reference].secret, "sk-runtime-private");
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
