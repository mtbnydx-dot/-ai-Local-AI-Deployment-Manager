"use strict";

// The external adapter and ExternalHost (01-engines §20): validation and the
// SSRF guard, the upstream header allowlist, health parsing including
// Ollama's /api/ps, model rules, and the key living only in the secret store
// namespace engines.external. No request leaves the process: fetch and DNS are fakes.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("..");
const external = require("../engines/adapters/external");
const { createExternalHost, applyModelRules } = require("../engines/hosts/external");
const { createSecretVault } = require("../secret-store");
const { createFakeDpapi } = require("./fixtures/secrets/fake-dpapi");
const { validateDescriptor } = require("../engines/descriptor-schema");

const FAKE_KEY = "sk-test-fake-0000";

function endpointOf(overrides = {}) {
  const result = external.validateEndpoint({
    endpointId: "ollama-local",
    label: "Ollama (this PC)",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    ...overrides,
  });
  assert.deepEqual(result.errors, [], "the fixture endpoint must validate");
  return result.endpoint;
}

function codesOf(input, options) {
  return external.validateEndpoint(input, options).errors.map((item) => `${item.path}:${item.code}`);
}

function fakeResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? null);
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

// A fetch that answers from a table of URL -> response and records every call.
function fakeFetch(table) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const key = String(url);
    calls.push({ url: key, init });
    const entry = table[key];
    if (entry instanceof Error) throw entry;
    if (!entry) throw new Error(`unexpected request ${key}`);
    return typeof entry === "function" ? entry(init) : entry;
  };
  fn.calls = calls;
  return fn;
}

function memorySecrets(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { get: (namespace, name) => values.get(`${namespace}/${name}`) ?? null, set: (namespace, name, value) => values.set(`${namespace}/${name}`, value) };
}

test("a valid endpoint is normalised with the spec defaults", () => {
  const { ok, endpoint } = external.validateEndpoint({ endpointId: "lmstudio", baseUrl: "http://192.168.1.20:1234/v1/", kind: "lmstudio" }, { now: () => Date.parse("2026-10-20T10:00:00Z") });
  assert.equal(ok, true);
  assert.equal(endpoint.baseUrl, "http://192.168.1.20:1234/v1");
  assert.equal(endpoint.label, "lmstudio");
  assert.equal(endpoint.enabled, true);
  assert.equal(endpoint.apiKeyRef, "");
  assert.deepEqual(endpoint.models, { discover: true, allow: [], aliases: {} });
  assert.equal(endpoint.capabilities.text, true);
  assert.equal(endpoint.capabilities.maxContext, null);
  assert.equal(endpoint.routing.includeInAuto, false);
  assert.equal(endpoint.localGpu, false);
  assert.equal(endpoint.createdAt, "2026-10-20T10:00:00.000Z");
});

test("endpointId, kind, flags and unknown fields are checked", () => {
  assert.ok(codesOf({ endpointId: "A", baseUrl: "http://127.0.0.1:1/v1" }).includes("endpointId:invalid_endpoint_id"));
  assert.ok(codesOf({ endpointId: "1abc", baseUrl: "http://127.0.0.1:1/v1" }).includes("endpointId:invalid_endpoint_id"));
  assert.ok(codesOf({ endpointId: "a".repeat(33), baseUrl: "http://127.0.0.1:1/v1" }).includes("endpointId:invalid_endpoint_id"));
  assert.ok(codesOf({ endpointId: "ok-id", kind: "nope", baseUrl: "http://127.0.0.1:1/v1" }).includes("kind:invalid_kind"));
  assert.ok(codesOf({ endpointId: "ok-id", baseUrl: "http://127.0.0.1:1/v1", enabled: "yes" }).includes("enabled:type"));
  assert.ok(codesOf({ endpointId: "ok-id", baseUrl: "http://127.0.0.1:1/v1", surprise: 1 }).includes("surprise:unknown_field"));
  assert.ok(codesOf({ endpointId: "ok-id", baseUrl: "http://127.0.0.1:1/v1", models: { aliases: { "bad alias": "x" } } }).includes("models.aliases.bad alias:invalid_alias"));
  assert.ok(codesOf({ endpointId: "ok-id", baseUrl: "http://127.0.0.1:1/v1", capabilities: { maxContext: 0 } }).includes("capabilities.maxContext:range"));
  assert.ok(codesOf({ endpointId: "ok-id", baseUrl: "http://127.0.0.1:1/v1", apiKeyRef: "elsewhere:other" }).includes("apiKeyRef:invalid_api_key_ref"));
  assert.ok(codesOf({ endpointId: "ok-id", baseUrl: "http://127.0.0.1:1/v1", acknowledge: ["whatever"] }).includes("acknowledge:invalid_acknowledge"));
});

test("SSRF guard: credentials, schemes and link-local, metadata and unspecified addresses are rejected", () => {
  const bad = (baseUrl) => codesOf({ endpointId: "probe", baseUrl });
  assert.ok(bad("http://user:pass@127.0.0.1:11434/v1").includes("baseUrl:credentials_in_url"));
  assert.ok(bad("http://:secret@127.0.0.1:11434/v1").includes("baseUrl:credentials_in_url"));
  assert.ok(bad("ftp://127.0.0.1/v1").includes("baseUrl:invalid_base_url"));
  assert.ok(bad("file:///etc/passwd").includes("baseUrl:invalid_base_url"));
  assert.ok(bad("not a url").includes("baseUrl:invalid_base_url"));
  assert.ok(bad("http://127.0.0.1:11434/v1?x=1").includes("baseUrl:invalid_base_url"));
  for (const blocked of [
    "http://169.254.169.254/latest",
    "http://169.254.0.1/v1",
    "http://0.0.0.0:8000/v1",
    "http://0.1.2.3/v1",
    "http://[fe80::1]/v1",
    "http://[febf::1]/v1",
    "http://[::]/v1",
    "http://[::ffff:169.254.169.254]/v1",
    "http://[::ffff:0.0.0.0]/v1",
    "http://[fd00:ec2::254]/v1",
    "http://2852039166/v1", // 169.254.169.254 as one decimal number
    "http://0xa9fea9fe/v1",
    "http://metadata.google.internal/v1",
    "http://100.100.100.200/v1",
  ]) {
    assert.ok(bad(blocked).includes("baseUrl:blocked_address"), blocked);
  }
  // Neighbouring ranges are not caught by the guard.
  assert.deepEqual(bad("http://169.253.1.1:80/v1").filter((code) => code.includes("blocked")), []);
  assert.deepEqual(bad("http://[fec0::1]/v1").filter((code) => code.includes("blocked")), []);
  assert.deepEqual(bad("http://127.0.0.1:11434/v1"), []);
  assert.deepEqual(bad("http://[::1]:11434/v1"), []);
});

test("remote http:// needs acknowledge:[plaintext-remote]; https, loopback and private ranges do not", () => {
  const remote = { endpointId: "cloud", baseUrl: "http://api.example.com/v1" };
  assert.ok(codesOf(remote).includes("baseUrl:plaintext_remote"));
  assert.deepEqual(codesOf({ ...remote, acknowledge: ["plaintext-remote"] }), []);
  assert.deepEqual(codesOf({ endpointId: "cloud", baseUrl: "https://api.example.com/v1" }), []);
  for (const url of ["http://localhost:11434/v1", "http://10.1.2.3/v1", "http://172.16.0.9/v1", "http://172.31.255.1/v1", "http://192.168.0.5/v1", "http://gpu-box/v1", "http://box.local/v1"]) {
    assert.deepEqual(codesOf({ endpointId: "lan-box", baseUrl: url }), [], url);
  }
  assert.ok(codesOf({ endpointId: "cloud", baseUrl: "http://172.32.0.1/v1" }).includes("baseUrl:plaintext_remote"));
  assert.ok(codesOf({ endpointId: "cloud", baseUrl: "http://8.8.8.8/v1" }).includes("baseUrl:plaintext_remote"));
  // The acknowledgement is kept on the record for later patches.
  assert.deepEqual(external.validateEndpoint({ ...remote, acknowledge: ["plaintext-remote"] }).endpoint.acknowledged, ["plaintext-remote"]);
});

test("hostClass is loopback, lan or remote", () => {
  const cls = (url) => external.classifyHost(url);
  assert.equal(cls("http://127.0.0.1:1/v1"), "loopback");
  assert.equal(cls("http://127.8.8.8/v1"), "loopback");
  assert.equal(cls("http://localhost:1/v1"), "loopback");
  assert.equal(cls("http://[::1]:1/v1"), "loopback");
  assert.equal(cls("http://10.0.0.2/v1"), "lan");
  assert.equal(cls("http://192.168.1.2/v1"), "lan");
  assert.equal(cls("http://172.20.1.1/v1"), "lan");
  assert.equal(cls("http://gpu-box:8000/v1"), "lan");
  assert.equal(cls("https://api.openai.com/v1"), "remote");
  assert.equal(cls("http://8.8.4.4/v1"), "remote");
  assert.equal(external.hostClassOf(endpointOf()), "loopback");
});

test("an apiKey must be a single header-safe token", () => {
  assert.equal(external.validateApiKey(FAKE_KEY).ok, true);
  for (const value of ["", " x", "a b", "line\nbreak", 12, null, "x".repeat(5000)]) assert.equal(external.validateApiKey(value).ok, false);
});

test("resolveUpstream forwards only the allowlisted client headers and adds the stored key as Bearer", () => {
  const secrets = memorySecrets({ "engines.external/ollama-local": FAKE_KEY });
  const host = createExternalHost({ secrets });
  const endpoint = endpointOf({ apiKeyRef: "engines.external:ollama-local" });
  const upstream = host.resolveUpstream(endpoint, "/chat/completions?stream=true", {
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Request-Id": "req_abc",
      Authorization: "Bearer client-key",
      Cookie: "lai_admin=1",
      "x-api-key": "client-key",
      "x-forwarded-for": "10.0.0.9",
      host: "evil.example",
      "anthropic-version": "2023-06-01",
    },
  });
  assert.equal(upstream.url, "http://127.0.0.1:11434/v1/chat/completions?stream=true");
  assert.deepEqual(upstream.headers, {
    "content-type": "application/json",
    accept: "text/event-stream",
    "x-request-id": "req_abc",
    authorization: `Bearer ${FAKE_KEY}`,
  });
  // A client Authorization header is dropped even when the endpoint has no key.
  const keyless = createExternalHost({ secrets }).resolveUpstream(endpointOf({ endpointId: "plain" }), "/models", { headers: { authorization: "Bearer client-key" } });
  assert.deepEqual(keyless.headers, {});
  // Header values that could split the request are dropped.
  const split = host.resolveUpstream(endpoint, "/models", { headers: { accept: "a\r\nx-evil: 1" } });
  assert.equal(split.headers.accept, undefined);
});

test("resolveUpstream keeps the path below the endpoint", () => {
  const host = createExternalHost({ secrets: memorySecrets() });
  const endpoint = endpointOf({ baseUrl: "https://gateway.example.com/team/v1" });
  assert.equal(host.resolveUpstream(endpoint, "/models").url, "https://gateway.example.com/team/v1/models");
  for (const bad of ["models", "//evil.example/x", "/../admin", "/a/%2e%2e/b", "/a/./b", "/a\\b", "/a b", "/a#frag", "http://evil.example/x", "/a/%2e%2E/b"]) {
    assert.throws(() => host.resolveUpstream(endpoint, bad), (error) => error.code === "invalid_path", bad);
  }
});

test("health: /models answers ready; Ollama also reads /api/ps (size_vram, expires_at)", async () => {
  const fetch = fakeFetch({
    "http://127.0.0.1:11434/v1/models": fakeResponse(200, { data: [{ id: "qwen3:32b" }, { id: "llama3" }] }),
    "http://127.0.0.1:11434/api/ps": fakeResponse(200, {
      models: [
        { name: "qwen3:32b", size: 24_000_000_000, size_vram: 20_000_000_000, expires_at: "2026-10-20T10:05:00Z" },
        { name: "llama3", size: 5_000_000_000, size_vram: 5_000_000_000, expires_at: "2026-10-20T10:01:00Z" },
        { nothing: true },
      ],
    }),
  });
  const host = createExternalHost({ secrets: memorySecrets(), fetch, now: () => 1_000 });
  const health = await host.health(endpointOf());
  assert.equal(health.state, "ready");
  assert.equal(health.ok, true);
  assert.equal(health.status, 200);
  assert.equal(health.models, 2);
  assert.equal(health.latencyMs, 0);
  assert.deepEqual(health.ollama.models, [
    { name: "qwen3:32b", sizeBytes: 24_000_000_000, sizeVramBytes: 20_000_000_000, expiresAt: "2026-10-20T10:05:00Z" },
    { name: "llama3", sizeBytes: 5_000_000_000, sizeVramBytes: 5_000_000_000, expiresAt: "2026-10-20T10:01:00Z" },
  ]);
  assert.equal(health.ollama.totalVramBytes, 25_000_000_000);
  assert.deepEqual(fetch.calls.map((call) => call.url), ["http://127.0.0.1:11434/v1/models", "http://127.0.0.1:11434/api/ps"]);
  assert.ok(fetch.calls.every((call) => call.init.redirect === "manual" && call.init.signal));
});

test("health: non-Ollama kinds never call /api/ps; a failing /api/ps keeps the endpoint ready", async () => {
  const openai = fakeFetch({ "https://api.example.com/v1/models": fakeResponse(200, { data: [] }) });
  const host = createExternalHost({ secrets: memorySecrets(), fetch: openai, lookup: async () => [{ address: "93.184.216.34" }] });
  const result = await host.health(endpointOf({ endpointId: "cloud", kind: "openai", baseUrl: "https://api.example.com/v1" }));
  assert.equal(result.state, "ready");
  assert.equal(result.ollama, undefined);
  assert.equal(openai.calls.length, 1);

  const flaky = fakeFetch({
    "http://127.0.0.1:11434/v1/models": fakeResponse(200, { data: [] }),
    "http://127.0.0.1:11434/api/ps": fakeResponse(500, "boom"),
  });
  const again = await createExternalHost({ secrets: memorySecrets(), fetch: flaky }).health(endpointOf());
  assert.equal(again.state, "ready");
  assert.equal(again.ollama, undefined);
});

test("health states: unauthorized, http error, unreachable, timeout, redirect", async () => {
  const run = async (answer) => createExternalHost({ secrets: memorySecrets(), fetch: fakeFetch({ "http://127.0.0.1:11434/v1/models": answer }) }).health(endpointOf({ kind: "generic" }));
  assert.equal((await run(fakeResponse(401, {}))).state, "unauthorized");
  assert.equal((await run(fakeResponse(403, {}))).state, "unauthorized");
  const failed = await run(fakeResponse(500, "x"));
  assert.deepEqual([failed.state, failed.ok, failed.error], ["error", false, "http_500"]);
  const down = await run(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
  assert.deepEqual([down.state, down.error], ["unreachable", "unreachable"]);
  const slow = await run(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
  assert.deepEqual([slow.state, slow.error], ["unreachable", "timeout"]);
  const redirect = await run(fakeResponse(302, ""));
  assert.deepEqual([redirect.state, redirect.error], ["error", "redirect_blocked"]);
});

test("the upstream call carries the key and asks for JSON", async () => {
  const fetch = fakeFetch({ "http://127.0.0.1:11434/v1/models": fakeResponse(200, { data: [] }) });
  const secrets = memorySecrets({ "engines.external/ollama-local": FAKE_KEY });
  await createExternalHost({ secrets, fetch }).health(endpointOf({ kind: "generic", apiKeyRef: "engines.external:ollama-local" }));
  assert.equal(fetch.calls[0].init.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(fetch.calls[0].init.headers.accept, "application/json");
});

test("DNS: a host name that resolves to a link-local address is refused before any request", async () => {
  const fetch = fakeFetch({});
  const host = createExternalHost({ secrets: memorySecrets(), fetch, lookup: async () => [{ address: "93.184.216.34" }, { address: "169.254.169.254" }] });
  const result = await host.health(endpointOf({ endpointId: "rebind", kind: "generic", baseUrl: "https://models.example.com/v1" }));
  assert.equal(result.state, "error");
  assert.equal(result.error, "blocked_address");
  assert.equal(fetch.calls.length, 0);
  await assert.rejects(host.assertAllowedTarget("https://models.example.com/v1"), (error) => error.code === "blocked_address");
  const unresolved = createExternalHost({ secrets: memorySecrets(), fetch, lookup: async () => { throw new Error("ENOTFOUND"); } });
  await assert.rejects(unresolved.assertAllowedTarget("https://nowhere.example.com/v1"), (error) => error.code === "dns_failed");
  const literal = await createExternalHost({ secrets: memorySecrets(), fetch, lookup: async () => { throw new Error("must not be asked"); } }).assertAllowedTarget("http://10.0.0.5:8000/v1");
  assert.equal(literal.hostname, "10.0.0.5");
});

test("listModels applies the allow list and aliases", async () => {
  const table = { "http://127.0.0.1:11434/v1/models": fakeResponse(200, { data: [{ id: "qwen3:32b" }, { id: "llama3" }, { id: "gemma" }] }) };
  const list = async (models) => createExternalHost({ secrets: memorySecrets(), fetch: fakeFetch(table) }).listModels(endpointOf({ models }));
  assert.deepEqual((await list({ discover: true })).map((item) => item.id), ["qwen3:32b", "llama3", "gemma"]);
  assert.deepEqual((await list({ discover: true, allow: ["llama3", "missing"] })).map((item) => item.id), ["llama3"]);
  const aliased = await list({ discover: true, allow: ["qwen3:32b"], aliases: { qwen3: "qwen3:32b", ghost: "not-offered" } });
  assert.deepEqual(aliased, [
    { id: "qwen3:32b", upstreamId: "qwen3:32b", alias: false },
    { id: "qwen3", upstreamId: "qwen3:32b", alias: true },
  ]);
  const fixed = createExternalHost({ secrets: memorySecrets(), fetch: fakeFetch({}) });
  assert.deepEqual((await fixed.listModels(endpointOf({ models: { discover: false, allow: ["a", "b"], aliases: { c: "a" } } }))).map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(applyModelRules({ models: { discover: false } }, ["x"]), []);
  await assert.rejects(createExternalHost({ secrets: memorySecrets(), fetch: fakeFetch({ "http://127.0.0.1:11434/v1/models": fakeResponse(401, {}) }) }).listModels(endpointOf()), (error) => error.code === "unauthorized");
});

test("the key lives only in the secret store namespace engines.external", async (t) => {
  const aiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engines-external-"));
  t.after(() => fs.rmSync(aiRoot, { recursive: true, force: true }));
  const vault = createSecretVault({ aiRoot, dpapi: createFakeDpapi() });
  await vault.set("engines.external", "ollama-local", FAKE_KEY);
  const endpoint = endpointOf({ apiKeyRef: "engines.external:ollama-local" });
  assert.equal(JSON.stringify(endpoint).includes(FAKE_KEY), false);
  const host = createExternalHost({ secrets: vault });
  assert.equal(host.resolveUpstream(endpoint, "/models").headers.authorization, `Bearer ${FAKE_KEY}`);
  // No ref, no key: another endpoint's secret is never picked up.
  assert.equal(host.resolveUpstream({ ...endpoint, endpointId: "other", apiKeyRef: "" }, "/models").headers.authorization, undefined);
  assert.ok(fs.existsSync(path.join(aiRoot, ".runtime", "secrets", "engines.external.json")));
  // A broken store surfaces as secret_store_unavailable, never as a keyless request.
  const broken = createExternalHost({ secrets: { get() { throw new Error("DPAPI failed"); } } });
  assert.throws(() => broken.resolveUpstream(endpoint, "/models"), (error) => error.code === "secret_store_unavailable");
});

test("the host has no create and no stop; the instance is external:<endpointId> with the state from health", async () => {
  const host = createExternalHost({ secrets: memorySecrets() });
  assert.deepEqual([host.kind, host.id], ["external", "external"]);
  const stopped = await host.stop("external:ollama-local");
  assert.deepEqual([stopped.ok, stopped.status, stopped.code], [false, 405, "external_not_managed"]);
  assert.equal(host.create, undefined);
  assert.throws(() => external.buildLaunch({}, {}), (error) => error.status === 405 && error.code === "external_not_managed");
  const endpoint = endpointOf({ capabilities: { tools: true, maxContext: 32768 }, apiSurface: { embeddings: true } });
  const unknown = host.buildInstance(endpoint);
  assert.equal(unknown.fleetId, "external:ollama-local");
  assert.equal(unknown.engineId, "external");
  assert.equal(unknown.runtime.id, "external@ollama");
  assert.equal(unknown.lifecycle.state, "loading");
  assert.equal(unknown.capabilities.maxContext, 32768);
  assert.equal(unknown.apiSurface.embeddings, true);
  assert.equal(host.buildInstance(endpoint, { ok: true, checkedAt: "2026-10-20T10:00:00.000Z" }).lifecycle.state, "ready");
  assert.equal(host.buildInstance(endpoint, { ok: false, state: "unreachable" }).lifecycle.state, "stopped");
  assert.equal(await host.imagePresent(), null);
  assert.equal(external.estimateMemory().lease, false);
});

test("the monitor checks enabled endpoints and forgets removed ones", async () => {
  let endpoints = [endpointOf({ kind: "generic" }), endpointOf({ endpointId: "off", kind: "generic", enabled: false })];
  const fetch = fakeFetch({ "http://127.0.0.1:11434/v1/models": fakeResponse(200, { data: [] }) });
  const host = createExternalHost({ secrets: memorySecrets(), fetch, intervalMs: 20 });
  host.startMonitor(async () => endpoints);
  const until = async (check) => { for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); };
  await until(() => host.healthOf("ollama-local"));
  assert.equal(host.healthOf("ollama-local").state, "ready");
  assert.equal(host.healthOf("off"), null);
  endpoints = [];
  await until(() => host.healthOf("ollama-local") === null);
  host.stopMonitor();
  assert.equal(host.healthOf("ollama-local"), null);
});

test("external.json is a valid bundled descriptor hosted by the entry, not by a manager", () => {
  const file = path.join(__dirname, "..", "data", "engines", "external.json");
  const descriptor = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(validateDescriptor(descriptor, { mode: "bundled" }).errors, []);
  assert.deepEqual([descriptor.id, descriptor.adapter, descriptor.hostManager], ["external", "external", "entry"]);
  const registry = core.engines.createEngineRegistry();
  assert.ok(registry.has("external"));
  assert.equal(registry.hostedBy("vllm").includes("external"), false);
  assert.equal(registry.hostedBy("llama").includes("external"), false);
  assert.equal(core.engines.adapterFor(descriptor), external);
  assert.equal(core.engines.hosts.external.createExternalHost, createExternalHost);
});
