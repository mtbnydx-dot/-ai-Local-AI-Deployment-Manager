const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const core = require("../../manager-core");
const {
  DEFAULT_TRUSTED_PROXIES,
  FORWARDED_HEADERS,
  createEntrySecurity,
  isTrustedProxy,
  parseTrustedProxies,
} = require("../lib/security");
const { strictLocalBillingAdmin } = require("../lib/billing-http");

const SWITCH_ENV = [
  "SERVICE_ENTRY_REQUIRE_API_KEY",
  "SERVICE_ENTRY_ALLOW_LAN_ADMIN",
  "SERVICE_ENTRY_ALLOWED_ORIGINS",
  "SERVICE_ENTRY_ALLOWED_HOSTS",
  "SERVICE_ENTRY_PUBLIC_BASE_URL",
  "SERVICE_ENTRY_TRUSTED_PROXIES",
];

function withCleanEnv(t) {
  const saved = Object.fromEntries(SWITCH_ENV.map((name) => [name, process.env[name]]));
  for (const name of SWITCH_ENV) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function req(remoteAddress, headers = {}, method = "GET") {
  return { method, headers, socket: { remoteAddress } };
}

const billingDeps = { isLocalAddress: core.isLocalAddress, extractHostname: core.extractHostname };

test("a LAN peer's forwarded headers are ignored for identity", (t) => {
  withCleanEnv(t);
  const security = createEntrySecurity({ host: "0.0.0.0", managers: [] });

  assert.equal(security.resolveClientAddress(req("192.168.0.44", { "x-forwarded-for": "203.0.113.9" })), "192.168.0.44");
  assert.equal(security.resolveClientAddress(req("192.168.0.44", { "x-real-ip": "203.0.113.10" })), "192.168.0.44");
  assert.equal(security.resolveClientAddress(req("192.168.0.44", { "cf-connecting-ip": "203.0.113.11" })), "192.168.0.44");
  assert.equal(security.resolveClientAddress(req("::ffff:192.168.0.44", { "true-client-ip": "203.0.113.12" })), "::ffff:192.168.0.44");

  // The spoof that mattered: a LAN device claiming to be loopback must not be
  // vouched to the managers as a local caller.
  const spoof = req("192.168.0.44", { "x-forwarded-for": "127.0.0.1" });
  assert.equal(security.resolveClientAddress(spoof), "192.168.0.44");
  const headers = security.trustHeaders(spoof);
  assert.equal(headers["x-service-entry-client"], "192.168.0.44");
  assert.equal(Object.values(headers).includes("127.0.0.1"), false);
});

test("a loopback peer's forwarded headers are honoured, last XFF hop first", (t) => {
  withCleanEnv(t);
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [] });

  for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(security.resolveClientAddress(req(peer, { "x-forwarded-for": "10.0.0.5, 203.0.113.9" })), "203.0.113.9", peer);
  }
  // XFF wins over the single-address headers.
  assert.equal(security.resolveClientAddress(req("127.0.0.1", {
    "x-forwarded-for": "203.0.113.9",
    "x-real-ip": "203.0.113.10",
    "cf-connecting-ip": "203.0.113.11",
  })), "203.0.113.9");
  // Then X-Real-IP, CF-Connecting-IP, True-Client-IP, in that order.
  assert.equal(security.resolveClientAddress(req("127.0.0.1", {
    "x-real-ip": "203.0.113.10",
    "cf-connecting-ip": "203.0.113.11",
    "true-client-ip": "203.0.113.12",
  })), "203.0.113.10");
  assert.equal(security.resolveClientAddress(req("127.0.0.1", {
    "cf-connecting-ip": "203.0.113.11",
    "true-client-ip": "203.0.113.12",
  })), "203.0.113.11");
  assert.equal(security.resolveClientAddress(req("127.0.0.1", { "true-client-ip": "203.0.113.12" })), "203.0.113.12");
  // A marker-only header names no client, so the socket stays the answer.
  assert.equal(security.resolveClientAddress(req("127.0.0.1", { "x-forwarded-proto": "https" })), "127.0.0.1");
  // Only the exact loopback addresses are trusted by default.
  assert.equal(security.resolveClientAddress(req("127.0.0.2", { "x-forwarded-for": "203.0.113.9" })), "127.0.0.2");
});

test("any forwarded header demotes management and billing admin, from any peer", (t) => {
  withCleanEnv(t);
  const security = createEntrySecurity({ host: "0.0.0.0", managers: [] });

  // A tunnel that sends only cf-connecting-ip used to slip through as "local".
  const cfOnly = security.checkManagementAccess(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.9" }, "POST"));
  assert.equal(cfOnly.ok, false);
  assert.equal(cfOnly.status, 403);
  assert.equal(cfOnly.code, "management_local_only");

  for (const header of FORWARDED_HEADERS) {
    const headers = { [header]: header === "x-forwarded-proto" ? "https" : "203.0.113.9" };
    assert.equal(security.isProxiedRequest(req("127.0.0.1", headers)), true, header);
    assert.equal(security.checkManagementAccess(req("127.0.0.1", headers, "POST")).ok, false, header);
    assert.equal(strictLocalBillingAdmin(req("127.0.0.1", { host: "127.0.0.1:5176", ...headers }), billingDeps), false, header);
  }

  // Untrusted peers are demoted too, even with the LAN-admin switch on.
  process.env.SERVICE_ENTRY_ALLOW_LAN_ADMIN = "1";
  assert.equal(security.checkManagementAccess(req("192.168.0.44", { "cf-connecting-ip": "203.0.113.9" }, "POST")).ok, false);
  assert.equal(security.checkManagementAccess(req("192.168.0.44", {}, "POST")).ok, true);
  assert.equal(strictLocalBillingAdmin(req("127.0.0.1", { host: "127.0.0.1:5176" }), billingDeps), true);
});

test("the forwarded-header list is the union both gates used to keep", () => {
  for (const name of [
    "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
    "x-real-ip", "cf-connecting-ip", "true-client-ip", "x-service-entry-gateway",
  ]) {
    assert.ok(FORWARDED_HEADERS.includes(name), name);
  }
  assert.equal(Object.isFrozen(FORWARDED_HEADERS), true);
  // billing-http.js keeps no copy of its own.
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "billing-http.js"), "utf8");
  assert.match(source, /\{\s*FORWARDED_HEADERS\s*\}\s*=\s*require\("\.\/security"\)/);
  assert.doesNotMatch(source, /FORWARDED_HEADERS\s*=\s*\[/);
});

test("trusted proxy CIDRs parse IPv4, IPv6 and IPv4-mapped forms", () => {
  const parsed = parseTrustedProxies("10.0.0.0/8, fd00::/8 ; 192.168.1.7, ::ffff:172.16.0.0/108, [::1]/128");
  assert.deepEqual(parsed.invalid, []);
  assert.deepEqual(parsed.entries, ["10.0.0.0/8", "fd00::/8", "192.168.1.7/32", "::ffff:172.16.0.0/108", "::1/128"]);

  const value = "10.0.0.0/8,fd00::/8,192.168.1.7,::ffff:172.16.0.0/108";
  assert.equal(isTrustedProxy("10.1.2.3", { value }), true);
  assert.equal(isTrustedProxy("::ffff:10.1.2.3", { value }), true);
  assert.equal(isTrustedProxy("11.0.0.1", { value }), false);
  assert.equal(isTrustedProxy("fd12:3456::1", { value }), true);
  assert.equal(isTrustedProxy("fe80::1", { value }), false);
  assert.equal(isTrustedProxy("192.168.1.7", { value }), true);
  assert.equal(isTrustedProxy("192.168.1.8", { value }), false);
  assert.equal(isTrustedProxy("172.16.5.5", { value }), true);
  assert.equal(isTrustedProxy("172.32.0.1", { value }), false);
  assert.equal(isTrustedProxy("not-an-address", { value }), false);
  assert.equal(isTrustedProxy("", { value }), false);

  // The default covers exactly the loopback peers, plain and mapped.
  const defaults = parseTrustedProxies(DEFAULT_TRUSTED_PROXIES);
  assert.deepEqual(defaults.invalid, []);
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isTrustedProxy(address, { value: "" }), true, address);
  }
  for (const address of ["127.0.0.2", "192.168.0.44", "::2"]) {
    assert.equal(isTrustedProxy(address, { value: "" }), false, address);
  }
});

test("a configured LAN proxy is trusted and loopback stops being trusted", (t) => {
  withCleanEnv(t);
  process.env.SERVICE_ENTRY_TRUSTED_PROXIES = "192.168.0.0/24";
  const security = createEntrySecurity({ host: "0.0.0.0", managers: [] });

  assert.equal(security.resolveClientAddress(req("192.168.0.2", { "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
  assert.equal(security.resolveClientAddress(req("::ffff:192.168.0.2", { "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
  assert.equal(security.resolveClientAddress(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" })), "127.0.0.1");
  // Trust only affects identity: the proxied request is still not management-eligible.
  assert.equal(security.checkManagementAccess(req("192.168.0.2", { "x-forwarded-for": "203.0.113.9" }, "POST")).ok, false);
});

test("an invalid trusted-proxy entry is ignored with one warning", async (t) => {
  withCleanEnv(t);
  process.env.SERVICE_ENTRY_TRUSTED_PROXIES = "10.20.0.0/16, nope, 1.2.3.4/33, ::1/129, 192.168.9.9/";
  const warnings = [];
  const security = createEntrySecurity({ host: "0.0.0.0", managers: [], warn: (message) => warnings.push(message) });

  for (let index = 0; index < 5; index += 1) {
    assert.equal(security.resolveClientAddress(req("10.20.3.4", { "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
    assert.equal(security.resolveClientAddress(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" })), "127.0.0.1");
  }
  const state = await security.describe();
  assert.deepEqual(state.trustedProxies, ["10.20.0.0/16"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SERVICE_ENTRY_TRUSTED_PROXIES/);
  for (const entry of ["nope", "1.2.3.4/33", "::1/129", "192.168.9.9/"]) assert.ok(warnings[0].includes(entry), entry);

  assert.deepEqual(parseTrustedProxies("nope, 1.2.3.4/33").entries, []);
  assert.deepEqual(parseTrustedProxies("nope, 1.2.3.4/33").invalid, ["nope", "1.2.3.4/33"]);
});
