"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ADMIN_ONLY_SCOPES,
  SCOPES,
  checkWildcardOrigin,
  evaluateKey,
  fleetAllowed,
  ipAllowed,
  isLoopbackIp,
  matchPattern,
  modelAllowed,
  normalizeIp,
  normalizeIpRule,
  normalizeOrigin,
  originAllowed,
  wildcardOriginAllowed,
} = require("../lib/key-policy");

const NOW = new Date("2026-10-14T12:00:00.000Z");

function key(overrides = {}) {
  return {
    id: "k_aaaaaaaaaaaaaaaaaaaa",
    status: "active",
    class: "friend",
    scopes: ["models.read", "chat", "messages", "self.read"],
    models: ["qwen3.8-*"],
    fleetAllow: [],
    listeners: ["public", "admin"],
    allowedOrigins: [],
    allowedIps: [],
    expiresAt: null,
    ...overrides,
  };
}

test("matchPattern is a case-insensitive glob where only * is special", () => {
  const cases = [
    ["qwen3.8-*", "Qwen3.8-35B-A3B", true],
    ["qwen3.8-*", "qwen3.8-", true],
    ["qwen3.8-*", "qwen3.8", false],
    ["*-a3b", "qwen3.8-35b-A3B", true],
    ["*", "anything", true],
    ["*", "", true],
    ["a*b*c", "abc", true],
    ["a*b*c", "a-b-b-c", true],
    ["a*b*c", "ac", false],
    ["ab*ba", "aba", false],
    ["ab*ba", "abba", true],
    ["qwen**", "qwen", true],
    // Regex metacharacters are literal.
    ["a.b", "axb", false],
    ["a.b", "A.B", true],
    ["model+(1)", "model+(1)", true],
    ["[x]*", "[x]y", true],
    ["vllm:*", "vllm:inst-1", true],
    ["vllm:*", "llama:inst-1", false],
    ["", "", false],
  ];
  for (const [pattern, value, expected] of cases) {
    assert.equal(matchPattern(pattern, value), expected, `${pattern} vs ${value}`);
  }
  // No backtracking blow-up on a hostile pattern.
  const started = Date.now();
  assert.equal(matchPattern(`${"*a".repeat(50)}b`, "a".repeat(5000)), false);
  assert.ok(Date.now() - started < 1000);
});

test("modelAllowed: exact names, globs, excludes last, [] none and [*] all", () => {
  const model = { id: "qwen3.8-35b-a3b", root: "Qwen/Qwen3.8-35B-A3B", aliases: ["qwen3.8"] };
  const cases = [
    [[], false],
    [["*"], true],
    [["qwen3.8-35b-a3b"], true],
    [["QWEN3.8-35B-A3B"], true],
    [["qwen/qwen3.8-35b-a3b"], true],
    [["qwen3.8"], true],
    [["qwen3.8-*"], true],
    [["*-a3b"], true],
    [["llama-*"], false],
    [["qwen3"], false],
    [["*", "!qwen3.8-35b-a3b"], false],
    [["*", "!qwen3.8"], false],
    [["*", "!*-a3b"], false],
    [["qwen3.8-*", "!*-7b"], true],
    [["qwen3.8-35b-a3b", "!qwen3.8-*"], false],
    [["!qwen3.8-35b-a3b"], false],
    [["!llama-*"], false],
    [["llama-*", "qwen3.8"], true],
    [["", "  "], false],
  ];
  for (const [patterns, expected] of cases) {
    assert.equal(modelAllowed(key({ models: patterns }), model), expected, JSON.stringify(patterns));
  }
  assert.equal(modelAllowed(key({ models: ["qwen3.8-*"] }), "qwen3.8-7b"), true);
  assert.equal(modelAllowed(key({ models: ["*"] }), {}), false);
  assert.equal(modelAllowed(key({ models: "qwen3.8-*" }), model), false);
  assert.equal(modelAllowed(null, model), false);
});

test("fleetAllowed: [] means every fleet member; globs and excludes narrow it", () => {
  const cases = [
    [[], "vllm:inst-1", true],
    [[], "external:ollama", true],
    [["vllm:*"], "vllm:inst-1", true],
    [["vllm:*"], "llama:inst-1", false],
    [["VLLM:*"], "vllm:Inst-1", true],
    [["vllm:*", "llama:*"], "llama:inst-2", true],
    [["external:*"], "external:lmstudio", true],
    [["external:*"], "vllm:inst-1", false],
    [["!llama:*"], "llama:inst-1", false],
    [["!llama:*"], "vllm:inst-1", true],
    [["vllm:*", "!vllm:inst-2"], "vllm:inst-2", false],
    [["vllm:*", "!vllm:inst-2"], "vllm:inst-1", true],
    [["vllm:inst-1"], "vllm:inst-10", false],
  ];
  for (const [patterns, fleetId, expected] of cases) {
    assert.equal(fleetAllowed(key({ fleetAllow: patterns }), fleetId), expected, `${JSON.stringify(patterns)} ${fleetId}`);
  }
  assert.equal(fleetAllowed(key({ fleetAllow: [] }), ""), true);
  assert.equal(fleetAllowed(key({ fleetAllow: ["vllm:*"] }), ""), false);
  assert.equal(fleetAllowed(key({ fleetAllow: undefined }), "vllm:x"), true);
});

test("IP normalization and rules handle v4, v6, CIDR and IPv4-mapped forms", () => {
  assert.equal(normalizeIp("10.0.0.5"), "10.0.0.5");
  assert.equal(normalizeIp("::ffff:10.0.0.5"), "10.0.0.5");
  assert.equal(normalizeIp("::FFFF:a00:5"), "10.0.0.5");
  assert.equal(normalizeIp("[::1]"), "::1");
  assert.equal(normalizeIp("fe80::1%eth0"), "fe80::1");
  assert.equal(normalizeIp("2001:0DB8:0:0:0:0:2:1"), "2001:db8::2:1");
  assert.equal(normalizeIp("2001:db8:0:1:0:0:0:1"), "2001:db8:0:1::1");
  assert.equal(normalizeIp("not-an-ip"), "");
  assert.equal(normalizeIp("10.0.0.256"), "");
  assert.equal(normalizeIp(""), "");

  assert.equal(normalizeIpRule("10.1.2.3/8"), "10.0.0.0/8");
  assert.equal(normalizeIpRule("192.168.1.7"), "192.168.1.7");
  assert.equal(normalizeIpRule("192.168.1.7/32"), "192.168.1.7");
  assert.equal(normalizeIpRule("2001:db8::1/32"), "2001:db8::/32");
  assert.equal(normalizeIpRule("::ffff:10.0.0.0/104"), "10.0.0.0/8");
  assert.equal(normalizeIpRule("0.0.0.0/0"), "0.0.0.0/0");
  for (const bad of ["10.0.0.0/33", "2001:db8::/129", "1.2.3.4/", "/8", "::ffff:10.0.0.0/90", "10.0.0.0/-1", "10.0.0.0/8/8", "x/8"]) {
    assert.equal(normalizeIpRule(bad), "", bad);
  }

  assert.equal(isLoopbackIp("127.0.0.1"), true);
  assert.equal(isLoopbackIp("127.9.8.7"), true);
  assert.equal(isLoopbackIp("::1"), true);
  assert.equal(isLoopbackIp("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackIp("10.0.0.1"), false);
});

test("ipAllowed matrix: [] allows all; rules match v4, v6, CIDR and mapped addresses", () => {
  const rules = ["10.0.0.0/8", "192.168.1.7", "2001:db8::/32", "::ffff:172.16.0.0/108"];
  const cases = [
    ["10.20.30.40", true],
    ["::ffff:10.20.30.40", true],
    ["11.0.0.1", false],
    ["192.168.1.7", true],
    ["192.168.1.8", false],
    ["2001:db8:1234::5", true],
    ["2001:db9::5", false],
    ["172.16.5.5", true],
    ["172.32.0.1", false],
    ["", false],
    [undefined, false],
    ["garbage", false],
  ];
  for (const [ip, expected] of cases) {
    assert.equal(ipAllowed(key({ allowedIps: rules }), ip), expected, String(ip));
  }
  assert.equal(ipAllowed(key({ allowedIps: [] }), undefined), true);
  assert.equal(ipAllowed(key({ allowedIps: [] }), "203.0.113.9"), true);
});

test("origin normalization and matching are exact on scheme, host and port", () => {
  assert.equal(normalizeOrigin("https://App.Example.com"), "https://app.example.com");
  assert.equal(normalizeOrigin("https://app.example.com/"), "https://app.example.com");
  assert.equal(normalizeOrigin("https://app.example.com:443"), "https://app.example.com");
  assert.equal(normalizeOrigin("http://localhost:5173"), "http://localhost:5173");
  assert.equal(normalizeOrigin("*"), "*");
  for (const bad of ["https://app.example.com/path", "https://u:p@app.example.com", "ftp://app.example.com", "app.example.com", "https://app.example.com?x=1", "https://app.example.com#x", "null", ""]) {
    assert.equal(normalizeOrigin(bad), "", bad);
  }

  const restricted = key({ allowedOrigins: ["https://app.example.com", "http://localhost:5173"] });
  const cases = [
    [undefined, true],
    ["", true],
    ["https://app.example.com", true],
    ["https://APP.example.com", true],
    ["https://app.example.com:443", true],
    ["http://app.example.com", false],
    ["https://app.example.com:8443", false],
    ["http://localhost:5173", true],
    ["http://localhost:5174", false],
    ["https://evil.example.com", false],
    ["null", false],
  ];
  for (const [origin, expected] of cases) {
    assert.equal(originAllowed(restricted, origin), expected, String(origin));
  }
  assert.equal(originAllowed(key({ allowedOrigins: [] }), "https://app.example.com"), false);
  assert.equal(originAllowed(key({ allowedOrigins: ["*"] }), "https://anything.example.net"), true);
  assert.equal(originAllowed(key({ allowedOrigins: ["*"] }), "null"), true);
});

test("the wildcard-origin rule admits only friend or trial keys with chat-only scopes", () => {
  const chatOnly = ["models.read", "chat", "messages", "completions", "self.read"];
  assert.equal(wildcardOriginAllowed({ class: "friend", scopes: chatOnly }), true);
  assert.equal(wildcardOriginAllowed({ class: "trial", scopes: ["chat"] }), true);
  assert.equal(wildcardOriginAllowed({ class: "trial", scopes: [] }), true);
  for (const keyClass of ["owner", "internal", "customer"]) {
    assert.equal(wildcardOriginAllowed({ class: keyClass, scopes: ["chat"] }), false, keyClass);
  }
  for (const scope of SCOPES.filter((item) => !chatOnly.includes(item))) {
    assert.equal(wildcardOriginAllowed({ class: "friend", scopes: ["chat", scope] }), false, scope);
  }
  assert.equal(checkWildcardOrigin({ class: "owner", scopes: ["chat"], allowedOrigins: ["https://a.example"] }), null);
  assert.equal(checkWildcardOrigin({ class: "friend", scopes: ["chat"], allowedOrigins: ["*"] }), null);
  assert.equal(
    checkWildcardOrigin({ class: "friend", scopes: ["chat", "embeddings"], allowedOrigins: ["*"] }),
    "wildcard_origin_requires_restricted_key",
  );
  assert.equal(
    checkWildcardOrigin({ class: "customer", scopes: ["chat"], allowedOrigins: ["*"] }),
    "wildcard_origin_requires_restricted_key",
  );
});

test("evaluateKey checks status, expiry, listener, ip, scope and origin", () => {
  const base = { now: NOW, listener: "public", ip: "203.0.113.9", origin: "", scope: "chat" };
  const cases = [
    ["active key", key(), {}, { ok: true }],
    ["disabled", key({ status: "disabled" }), {}, { ok: false, code: "key_disabled", reason: "key_disabled" }],
    ["revoked", key({ status: "revoked" }), {}, { ok: false, code: "key_disabled", reason: "key_revoked" }],
    ["unknown status", key({ status: "paused" }), {}, { ok: false, code: "key_disabled", reason: "key_disabled" }],
    ["expired", key({ expiresAt: "2026-10-14T11:59:59.999Z" }), {}, { ok: false, code: "key_expired", reason: "key_expired" }],
    ["expires exactly now", key({ expiresAt: NOW.toISOString() }), {}, { ok: false, code: "key_expired", reason: "key_expired" }],
    ["unparseable expiry fails closed", key({ expiresAt: "soon" }), {}, { ok: false, code: "key_expired", reason: "key_expired" }],
    ["not yet expired", key({ expiresAt: "2026-10-14T12:00:00.001Z" }), {}, { ok: true }],
    ["admin-only key on public", key({ listeners: ["admin"] }), {}, { ok: false, code: "scope_denied", reason: "listener_not_allowed", param: "listener" }],
    ["public-only key on admin", key({ listeners: ["public"] }), { listener: "admin" }, { ok: false, code: "scope_denied", reason: "listener_not_allowed", param: "listener" }],
    ["ip outside rules", key({ allowedIps: ["10.0.0.0/8"] }), {}, { ok: false, code: "ip_not_allowed", reason: "ip_not_allowed" }],
    ["ip inside rules", key({ allowedIps: ["203.0.113.0/24"] }), {}, { ok: true }],
    ["missing scope", key(), { scope: "embeddings" }, { ok: false, code: "scope_denied", reason: "scope_missing", param: "embeddings" }],
    ["no scope requested", key({ scopes: [] }), { scope: undefined }, { ok: true }],
    ["unlisted origin", key(), { origin: "https://evil.example.com" }, { ok: false, code: "origin_not_allowed", reason: "origin_not_allowed" }],
    ["listed origin", key({ allowedOrigins: ["https://app.example.com"] }), { origin: "https://app.example.com" }, { ok: true }],
    ["no key", null, {}, { ok: false, code: "invalid_api_key", reason: "key_missing" }],
  ];
  for (const [name, record, overrides, expected] of cases) {
    assert.deepEqual(evaluateKey(record, { ...base, ...overrides }), expected, name);
  }
});

test("evaluateKey keeps admin-only scopes and unexposed search off the PUBLIC listener", () => {
  const owner = key({ class: "owner", scopes: [...SCOPES] });
  for (const scope of ADMIN_ONLY_SCOPES) {
    assert.deepEqual(evaluateKey(owner, { now: NOW, listener: "public", scope }), {
      ok: false, code: "scope_denied", reason: "scope_admin_only", param: scope,
    });
    assert.deepEqual(evaluateKey(owner, { now: NOW, listener: "admin", scope }), { ok: true });
  }
  assert.deepEqual(evaluateKey(owner, { now: NOW, listener: "public", scope: "search" }), {
    ok: false, code: "scope_denied", reason: "search_not_exposed", param: "search",
  });
  assert.deepEqual(evaluateKey(owner, { now: NOW, listener: "public", scope: "search", exposeSearch: true }), { ok: true });
  assert.deepEqual(evaluateKey(owner, { now: NOW, listener: "admin", scope: "search" }), { ok: true });
});

test("evaluateKey reports the first failing check in the documented order", () => {
  const all = key({
    status: "disabled",
    expiresAt: "2026-01-01T00:00:00.000Z",
    listeners: ["admin"],
    allowedIps: ["10.0.0.0/8"],
    scopes: [],
    allowedOrigins: [],
  });
  const context = { now: NOW, listener: "public", ip: "203.0.113.9", origin: "https://evil.example.com", scope: "chat" };
  let current = { ...all };
  const fixes = [
    ["key_disabled", { status: "active" }],
    ["key_expired", { expiresAt: null }],
    ["scope_denied", { listeners: ["public"] }],
    ["ip_not_allowed", { allowedIps: [] }],
    ["scope_denied", { scopes: ["chat"] }],
    ["origin_not_allowed", { allowedOrigins: ["https://evil.example.com"] }],
  ];
  // Fixing one failure at a time reveals the next check in line.
  for (const [expected, fix] of fixes) {
    assert.equal(evaluateKey(current, context).code, expected);
    current = { ...current, ...fix };
  }
  assert.deepEqual(evaluateKey(current, context), { ok: true });
});

test("evaluateKey defaults to the wall clock and accepts numeric and string times", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(evaluateKey(key({ expiresAt: future }), { listener: "public", scope: "chat" }), { ok: true });
  assert.equal(evaluateKey(key({ expiresAt: "2026-10-14T13:00:00.000Z" }), { now: Date.parse("2026-10-14T13:00:00.000Z") }).code, "key_expired");
  assert.deepEqual(evaluateKey(key({ expiresAt: "2026-10-14T13:00:00.000Z" }), { now: "2026-10-14T12:59:59.000Z" }), { ok: true });
});
