const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("../../manager-core");
const { FORWARDED_HEADERS, createEntrySecurity } = require("../lib/security");
const {
  FORWARDING_HEADERS,
  hasForwardingHeaders,
  ipInCidrs,
  parseCidrList,
  resolveClientIdentity,
} = require("../lib/trusted-proxy");
const { strictLocalBillingAdmin } = require("../lib/billing-http");

const SWITCH_ENV = [
  "SERVICE_ENTRY_REQUIRE_API_KEY",
  "SERVICE_ENTRY_ALLOW_LAN_ADMIN",
  "SERVICE_ENTRY_ALLOWED_ORIGINS",
  "SERVICE_ENTRY_ALLOWED_HOSTS",
  "SERVICE_ENTRY_PUBLIC_BASE_URL",
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

// An empty temp AI root and an explicit env object: the access settings come
// from OPS-3's readSection and never from this machine's platform.json.
function makeSecurity(t, { env = {}, host = "127.0.0.1", ...rest } = {}) {
  const aiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-proxy-"));
  t.after(() => fs.rmSync(aiRoot, { recursive: true, force: true }));
  const readSection = (name) => core.platform.readSection(name, { aiRoot, env });
  return createEntrySecurity({ host, managers: [], readSection, ...rest });
}

const PUBLIC = Object.freeze({ kind: "public", lanBound: false });
const ADMIN = Object.freeze({ kind: "admin", lanBound: false });

function req(remoteAddress, headers = {}, method = "GET", listener = undefined) {
  return { method, headers, socket: { remoteAddress }, ...(listener ? { listener } : {}) };
}

const billingDeps = { isLocalAddress: core.isLocalAddress, extractHostname: core.extractHostname };
const LOOPBACK_CIDRS = parseCidrList(["127.0.0.1/32", "::1/128"]).cidrs;

test("a LAN peer's forwarded headers are ignored for identity", (t) => {
  withCleanEnv(t);
  for (const listener of [PUBLIC, ADMIN, undefined]) {
    const security = makeSecurity(t, { host: "0.0.0.0" });
    const lan = (address, headers) => req(address, headers, "GET", listener);

    assert.equal(security.resolveClientAddress(lan("192.168.0.44", { "x-forwarded-for": "203.0.113.9" })), "192.168.0.44");
    assert.equal(security.resolveClientAddress(lan("192.168.0.44", { "x-real-ip": "203.0.113.10" })), "192.168.0.44");
    assert.equal(security.resolveClientAddress(lan("192.168.0.44", { "cf-connecting-ip": "203.0.113.11" })), "192.168.0.44");
    assert.equal(security.resolveClientAddress(lan("::ffff:192.168.0.44", { "true-client-ip": "203.0.113.12" })), "192.168.0.44");

    // The spoof that mattered: a LAN device claiming to be loopback must not be
    // vouched to the managers as a local caller.
    for (const header of ["x-forwarded-for", "cf-connecting-ip", "x-real-ip"]) {
      const spoof = lan("192.168.0.44", { [header]: "127.0.0.1" });
      assert.equal(security.resolveClientAddress(spoof), "192.168.0.44", `${listener?.kind} ${header}`);
      const headers = security.trustHeaders(spoof);
      assert.equal(headers["x-service-entry-client"], "192.168.0.44");
      assert.equal(Object.values(headers).includes("127.0.0.1"), false);
    }
  }
});

test("ADMIN never honours forwarded headers, even from a trusted loopback peer", (t) => {
  withCleanEnv(t);
  const security = makeSecurity(t);
  const headers = {
    "x-forwarded-for": "203.0.113.9",
    "cf-connecting-ip": "203.0.113.11",
    "x-real-ip": "203.0.113.10",
    "cf-ipcountry": "DE",
    "x-forwarded-proto": "https",
  };
  for (const listener of [ADMIN, { kind: "admin", lanBound: true }, undefined, { kind: "weird" }, "nonsense"]) {
    const identity = resolveClientIdentity(req("127.0.0.1", headers, "GET", undefined), { listener, cidrs: LOOPBACK_CIDRS });
    assert.equal(identity.ip, "127.0.0.1");
    assert.equal(identity.viaProxy, false);
    assert.equal(identity.headerUsed, "");
    assert.equal(identity.country, "");
    assert.equal(identity.proto, "http");
    assert.equal(identity.forwardedOnUntrusted, true);
    assert.equal(security.resolveClientAddress(req("127.0.0.1", headers, "GET", typeof listener === "object" ? listener : undefined)), "127.0.0.1");
  }
  // Without forwarding headers the flag stays down.
  assert.equal(resolveClientIdentity(req("127.0.0.1"), { listener: ADMIN, cidrs: LOOPBACK_CIDRS }).forwardedOnUntrusted, false);
});

test("PUBLIC from a trusted peer believes exactly the configured header", (t) => {
  withCleanEnv(t);
  const security = makeSecurity(t);

  for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const identity = security.identifyClient(req(peer, { "cf-connecting-ip": "203.0.113.9", "cf-ipcountry": "DE", "x-forwarded-proto": "https" }, "GET", PUBLIC));
    assert.equal(identity.ip, "203.0.113.9", peer);
    assert.equal(identity.viaProxy, true);
    assert.equal(identity.headerUsed, "cf-connecting-ip");
    assert.equal(identity.country, "DE");
    assert.equal(identity.proto, "https");
    assert.equal(identity.missingHeader, false);
    assert.equal(identity.forwardedOnUntrusted, false);
  }
  // Other client headers are not consulted when cf-connecting-ip is configured.
  assert.equal(security.resolveClientAddress(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.10" }, "GET", PUBLIC)), "127.0.0.1");
  // A local tool calling the public port directly names no client.
  const direct = security.identifyClient(req("127.0.0.1", {}, "GET", PUBLIC));
  assert.equal(direct.ip, "127.0.0.1");
  assert.equal(direct.missingHeader, true);
  assert.equal(direct.viaProxy, false);
  // A malformed value, a list in a single-address header and a bad country are ignored.
  for (const value of ["not-an-ip", "203.0.113.9, 203.0.113.10", "", "999.1.1.1"]) {
    const identity = security.identifyClient(req("127.0.0.1", { "cf-connecting-ip": value, "cf-ipcountry": "de" }, "GET", PUBLIC));
    assert.equal(identity.ip, "127.0.0.1", value);
    assert.equal(identity.missingHeader, true, value);
    assert.equal(identity.country, "", value);
  }
  // IPv6 clients and ports are accepted in canonical form.
  assert.equal(security.resolveClientAddress(req("127.0.0.1", { "cf-connecting-ip": "2001:db8::7" }, "GET", PUBLIC)), "2001:db8::7");
  assert.equal(security.resolveClientAddress(req("127.0.0.1", { "cf-connecting-ip": "::ffff:203.0.113.9" }, "GET", PUBLIC)), "203.0.113.9");
});

test("x-forwarded-for is walked right to left past trusted proxies", (t) => {
  withCleanEnv(t);
  const options = { listener: PUBLIC, clientIpHeader: "x-forwarded-for" };
  const cidrs = parseCidrList(["127.0.0.1/32", "::1/128", "10.0.0.0/8"]).cidrs;
  const resolve = (peer, value) => resolveClientIdentity(req(peer, { "x-forwarded-for": value }), { ...options, cidrs });

  // The client-written left part is skipped once a non-trusted hop is found.
  assert.equal(resolve("127.0.0.1", "198.51.100.1, 203.0.113.9").ip, "203.0.113.9");
  assert.equal(resolve("127.0.0.1", "203.0.113.9, 10.1.1.1, 10.2.2.2").ip, "203.0.113.9");
  assert.equal(resolve("127.0.0.1", "1.1.1.1, 203.0.113.9, 127.0.0.1").ip, "203.0.113.9");
  // Every hop trusted: the leftmost wins.
  assert.equal(resolve("127.0.0.1", "10.9.9.9, 10.1.1.1").ip, "10.9.9.9");
  assert.equal(resolve("127.0.0.1", "10.9.9.9, 10.1.1.1").headerUsed, "x-forwarded-for");
  // A garbage hop stops the walk: what is left of it was not written by a proxy.
  const garbage = resolve("127.0.0.1", "203.0.113.9, oops, 10.1.1.1");
  assert.equal(garbage.ip, "127.0.0.1");
  assert.equal(garbage.missingHeader, true);
  // IPv6 hops and bracketed ports.
  assert.equal(resolve("127.0.0.1", "2001:db8::5").ip, "2001:db8::5");
  assert.equal(resolve("127.0.0.1", "[2001:db8::5]:4433").ip, "2001:db8::5");
  assert.equal(resolve("127.0.0.1", "203.0.113.9:5555").ip, "203.0.113.9");
  // An untrusted peer's chain is never walked.
  const spoofed = resolve("192.168.0.44", "127.0.0.1, 203.0.113.9");
  assert.equal(spoofed.ip, "192.168.0.44");
  assert.equal(spoofed.forwardedOnUntrusted, true);
  assert.equal(spoofed.viaProxy, false);
});

test("x-real-ip works as the configured header and the country header is optional", () => {
  const cidrs = LOOPBACK_CIDRS;
  const identity = resolveClientIdentity(
    req("::1", { "x-real-ip": "203.0.113.20", "cf-connecting-ip": "203.0.113.21", "x-country": "US" }),
    { listener: PUBLIC, cidrs, clientIpHeader: "X-Real-IP", countryHeader: "x-country" },
  );
  assert.equal(identity.ip, "203.0.113.20");
  assert.equal(identity.headerUsed, "x-real-ip");
  assert.equal(identity.country, "US");
  // An unusable header name falls back to the socket.
  const odd = resolveClientIdentity(req("::1", { "x-real-ip": "203.0.113.20" }), { listener: PUBLIC, cidrs, clientIpHeader: "bad name!" });
  assert.equal(odd.ip, "::1");
  assert.equal(odd.missingHeader, true);
  // proto comes from cf-visitor when x-forwarded-proto is absent.
  const visitor = resolveClientIdentity(req("::1", { "cf-connecting-ip": "203.0.113.20", "cf-visitor": "{\"scheme\":\"https\"}" }), { listener: PUBLIC, cidrs });
  assert.equal(visitor.proto, "https");
  // Array-valued headers (duplicate header lines) are joined, not crashed on.
  const dup = resolveClientIdentity(req("::1", { "x-forwarded-for": ["198.51.100.1", "203.0.113.9"] }), { listener: PUBLIC, cidrs, clientIpHeader: "x-forwarded-for" });
  assert.equal(dup.ip, "203.0.113.9");
});

test("any forwarded header demotes management and billing admin, from any peer", (t) => {
  withCleanEnv(t);
  const security = makeSecurity(t, { host: "0.0.0.0" });

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

test("the forwarding-header list is one frozen list shared by every gate", () => {
  for (const name of [
    "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
    "x-real-ip", "cf-connecting-ip", "true-client-ip", "cf-ray", "x-service-entry-gateway",
  ]) {
    assert.ok(FORWARDING_HEADERS.includes(name), name);
  }
  assert.equal(Object.isFrozen(FORWARDING_HEADERS), true);
  assert.equal(FORWARDED_HEADERS, FORWARDING_HEADERS);
  assert.equal(hasForwardingHeaders({ "cf-ray": "abc" }), true);
  assert.equal(hasForwardingHeaders({ "x-forwarded-for": "  " }), false);
  assert.equal(hasForwardingHeaders({}), false);
  assert.equal(hasForwardingHeaders(undefined), false);
  // billing-http.js keeps no copy of its own.
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "billing-http.js"), "utf8");
  assert.match(source, /\{\s*FORWARDED_HEADERS\s*\}\s*=\s*require\("\.\/security"\)/);
  assert.doesNotMatch(source, /FORWARDED_HEADERS\s*=\s*\[/);
});

test("trusted proxy CIDRs parse IPv4, IPv6 and IPv4-mapped forms", () => {
  const parsed = parseCidrList(["10.0.0.0/8", "fd00::/8", "192.168.1.7", "::ffff:172.16.0.0/108", "[::1]/128"]);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.cidrs.length, 5);
  assert.equal(Object.isFrozen(parsed.cidrs[0]), true);

  const { cidrs } = parsed;
  assert.equal(ipInCidrs("10.1.2.3", cidrs), true);
  assert.equal(ipInCidrs("::ffff:10.1.2.3", cidrs), true);
  assert.equal(ipInCidrs("11.0.0.1", cidrs), false);
  assert.equal(ipInCidrs("fd12:3456::1", cidrs), true);
  assert.equal(ipInCidrs("fe80::1", cidrs), false);
  assert.equal(ipInCidrs("192.168.1.7", cidrs), true);
  assert.equal(ipInCidrs("192.168.1.8", cidrs), false);
  assert.equal(ipInCidrs("172.16.5.5", cidrs), true);
  assert.equal(ipInCidrs("172.32.0.1", cidrs), false);
  assert.equal(ipInCidrs("not-an-address", cidrs), false);
  assert.equal(ipInCidrs("", cidrs), false);
  assert.equal(ipInCidrs("10.1.2.3", undefined), false);

  // A comma or semicolon separated string is accepted, duplicates collapse.
  assert.equal(parseCidrList("10.0.0.0/8; 10.0.0.0/8, 192.168.0.0/16").cidrs.length, 2);

  // The default covers exactly the loopback peers, plain and mapped.
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(ipInCidrs(address, LOOPBACK_CIDRS), true, address);
  for (const address of ["127.0.0.2", "192.168.0.44", "::2"]) assert.equal(ipInCidrs(address, LOOPBACK_CIDRS), false, address);

  // Invalid entries are reported, never thrown.
  const bad = parseCidrList(["nope", "1.2.3.4/33", "::1/129", "192.168.9.9/", "10.20.0.0/16"]);
  assert.deepEqual(bad.cidrs.map((cidr) => cidr.text), ["10.20.0.0/16"]);
  assert.equal(bad.issues.length, 4);
  for (const entry of ["nope", "1.2.3.4/33", "::1/129", "192.168.9.9/"]) assert.ok(bad.issues.some((issue) => issue.includes(entry)), entry);
});

test("a configured LAN proxy is trusted on PUBLIC and loopback stops being trusted", (t) => {
  withCleanEnv(t);
  const security = makeSecurity(t, { host: "0.0.0.0", env: { SERVICE_ENTRY_TRUSTED_PROXIES: "192.168.0.0/24", SERVICE_ENTRY_CLIENT_IP_HEADER: "X-Forwarded-For" } });
  const pub = (peer, headers, method) => req(peer, headers, method, PUBLIC);

  assert.equal(security.resolveClientAddress(pub("192.168.0.2", { "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
  assert.equal(security.resolveClientAddress(pub("::ffff:192.168.0.2", { "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
  assert.equal(security.resolveClientAddress(pub("127.0.0.1", { "x-forwarded-for": "203.0.113.9" })), "127.0.0.1");
  // The same proxy on ADMIN is just a LAN socket.
  assert.equal(security.resolveClientAddress(req("192.168.0.2", { "x-forwarded-for": "203.0.113.9" }, "GET", ADMIN)), "192.168.0.2");
  // Trust only affects identity: the proxied request is still not management-eligible.
  assert.equal(security.checkManagementAccess(req("192.168.0.2", { "x-forwarded-for": "203.0.113.9" }, "POST")).ok, false);
});

test("an invalid trusted-proxy value falls back to the default with one warning", async (t) => {
  withCleanEnv(t);
  const warnings = [];
  const security = makeSecurity(t, {
    host: "0.0.0.0",
    env: { SERVICE_ENTRY_TRUSTED_PROXIES: "10.20.0.0/16, nope, 1.2.3.4/33" },
    warn: (message) => warnings.push(message),
  });

  for (let index = 0; index < 5; index += 1) {
    // The whole bad value is replaced, so neither the typo list nor anything but loopback is trusted.
    assert.equal(security.resolveClientAddress(req("10.20.3.4", { "cf-connecting-ip": "203.0.113.9" }, "GET", PUBLIC)), "10.20.3.4");
    assert.equal(security.resolveClientAddress(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.9" }, "GET", PUBLIC)), "203.0.113.9");
  }
  const state = await security.describe();
  assert.deepEqual(state.trustedProxies, ["127.0.0.1/32", "::1/128"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SERVICE_ENTRY_TRUSTED_PROXIES/);
});
