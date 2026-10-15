"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const exposure = require("../lib/exposure-scan");
const { createAccessRoutes } = require("../lib/access-routes");
const { createPublicListener } = require("../lib/public-listener");
const { createSecurityOverview, detectAnomalies } = require("../lib/security-overview");
const { loadAccessConfig } = require("../lib/public-config");
const { createRequestAuth } = require("../lib/request-auth");
const { cookiePair, fakeRequest, makeAdminAuth, reply } = require("./helpers/admin-auth-fixture");
const { loadEntry, quietLogger, request, serveEntry } = require("./helpers/entry-harness");

// Exposure scan, probe and legacy detection (05 §13.2, §13.3, PUB-19). The
// parsers are checked against goldens built from fixtures; the scan runs over
// a fake exec, fetch, resolver and a temp AI root, so nothing here touches the
// machine, Docker or the network.

const FIXTURES = path.join(__dirname, "fixtures", "exposure-scan");
const GOLDEN = path.join(__dirname, "golden", "exposure-scan");
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const DAY = 86_400_000;

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function goldenFile(fixtureName) {
  return path.join(GOLDEN, fixtureName.endsWith(".json") ? fixtureName : `${fixtureName}.json`);
}

function checkGolden(name, value) {
  const file = goldenFile(name);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  assert.deepEqual(JSON.parse(text), JSON.parse(fs.readFileSync(file, "utf8")), `golden ${name}`);
}

// ---- parser goldens ---------------------------------------------------------

const PARSER_CASES = {
  "listeners.json": exposure.parseListeners,
  "listeners-single.json": exposure.parseListeners,
  "listeners-empty.txt": exposure.parseListeners,
  "firewall.json": exposure.parseFirewall,
  "firewall-numeric.json": exposure.parseFirewall,
  "portproxy.txt": exposure.parsePortProxy,
  "portproxy-empty.txt": exposure.parsePortProxy,
  "portproxy-zh.txt": exposure.parsePortProxy,
  "docker-ps.lines.txt": exposure.parseDockerPs,
  "processes.json": exposure.parseProcesses,
  "Caddyfile.legacy": exposure.parseTunnelTargets,
  "Caddyfile.current": exposure.parseTunnelTargets,
  "cloudflared-config.legacy.yml": exposure.parseTunnelTargets,
  "cloudflared-config.current.yml": exposure.parseTunnelTargets,
};

for (const [name, parse] of Object.entries(PARSER_CASES)) {
  test(`the parser matches its golden for fixture ${name}`, () => {
    checkGolden(name, parse(fixture(name)));
  });
}

test("every fixture has a parser case and every golden has a fixture or a report scenario", () => {
  const fixtures = fs.readdirSync(FIXTURES).sort();
  assert.deepEqual(fixtures, Object.keys(PARSER_CASES).sort(), "a new fixture needs a parser case");
  const known = new Set([...Object.keys(PARSER_CASES).map(goldenFile), ...["report-legacy", "report-healthy", "report-unsupported", "legacy-findings"].map(goldenFile)]);
  for (const name of fs.readdirSync(GOLDEN)) assert.ok(known.has(path.join(GOLDEN, name)), `unexpected golden ${name}`);
});

test("parser edge cases: loopback, wildcard and zone ids; numeric firewall states; netsh rows; docker ports", () => {
  const listeners = exposure.parseListeners(fixture("listeners.json"));
  assert.equal(listeners.filter((row) => row.port === 5177).length, 1, "duplicates are dropped");
  assert.equal(listeners.find((row) => row.port === 139).address, "fe80::1c2d:3e4f:5a6b:7c8d", "the zone id is cut");
  assert.deepEqual(listeners.filter((row) => row.scope === "wildcard").map((row) => row.port), [5177, 5190, 55177]);
  assert.equal(exposure.parseListeners(fixture("listeners-single.json")).length, 1, "a single object is one row");
  assert.deepEqual(exposure.parseListeners(""), []);
  assert.deepEqual(exposure.parseListeners("\uFEFF[]"), []);
  assert.deepEqual(exposure.parseFirewall(fixture("firewall-numeric.json")).map((row) => row.enabled), [true, false, null]);
  assert.equal(exposure.parsePortProxy(fixture("portproxy.txt")).find((row) => row.listenPort === 55178).family, "ipv6");
  assert.equal(exposure.parsePortProxy(fixture("portproxy-zh.txt"))[0].connectPort, 5176, "localized headers do not matter");
  const docker = exposure.parseDockerPs(fixture("docker-ps.lines.txt"));
  assert.deepEqual(docker.map((row) => row.managed), [false, true, true]);
  assert.equal(docker[0].image, "cloudflare/cloudflared:2026.9.0", "the digest is cut");
  assert.deepEqual(docker[2].ports.map((port) => port.hostPort), [30000, 30001], "a published range is expanded");
  assert.deepEqual(docker[1].ports.map((port) => `${port.hostIp}|${port.hostPort}`), ["0.0.0.0|8000", "::|8000"], "IPv4 and IPv6 publications");
});

test("parsers throw ExposureParseError on output they do not understand and never invent rows", () => {
  assert.throws(() => exposure.parseListeners("not json"), exposure.ExposureParseError);
  assert.throws(() => exposure.parseFirewall("{oops"), exposure.ExposureParseError);
  assert.throws(() => exposure.parseDockerPs("warning: something\n"), exposure.ExposureParseError);
  assert.deepEqual(exposure.parseListeners([{ LocalAddress: "127.0.0.1", LocalPort: "nope", OwningProcess: 1 }]), []);
  assert.deepEqual(exposure.parsePortProxy("garbage\nmore garbage"), []);
});

test("classifyProcess matches signatures on file names and never keeps the command line", () => {
  const cases = [
    ["node.exe", "node.exe <AI_ROOT>\\vllm-manager\\manager-public-proxy.js --key FAKE-KEY", "manager-public-proxy"],
    ["node.exe", "\"node.exe\" \"<AI_ROOT>/vllm-manager/public-port-proxy.js\"", "public-port-proxy"],
    ["node.exe", "node upnp-port-map.js", "upnp-port-map"],
    ["node.exe", "node <AI_ROOT>\\service-entry\\server.js", "service-entry"],
    ["node.exe", "node <AI_ROOT>\\vllm-manager\\server.js", "vllm-manager"],
    ["node.exe", "node <AI_ROOT>\\llama-manager\\server.js", "llama-manager"],
    ["cloudflared.exe", "", "cloudflared"],
    ["caddy.exe", null, "caddy"],
    ["wslrelay.exe", "", "docker-backend"],
    ["node.exe", "node my-manager-public-proxy.js.bak", null],
    ["node.exe", "node other-script.js", null],
    ["python.exe", null, null],
  ];
  for (const [name, cmdline, expected] of cases) assert.equal(exposure.classifyProcess(name, cmdline), expected, `${name} ${cmdline}`);
  const parsed = exposure.parseProcesses(fixture("processes.json"));
  assert.equal(JSON.stringify(parsed).includes("FAKE-"), false, "no command line text survives parsing");
  assert.deepEqual(parsed.map((row) => Object.keys(row).sort().join()), parsed.map(() => "name,pid,signature"));
});

// ---- harness ------------------------------------------------------------------

function makeConfig(values = {}) {
  const sections = { listeners: { public: { baseUrl: "https://api.example.invalid" } }, ...values };
  return loadAccessConfig({
    readSection: (name) => ({ values: sections[name] || {}, sources: {}, etag: "e1", errors: [], warnings: [] }),
  });
}

function keyOf(file, args) {
  if (file === "powershell.exe") {
    const script = String(args[3] || "");
    if (script.startsWith("Get-NetTCPConnection")) return "listeners";
    if (script.startsWith("Get-CimInstance")) return "processes";
    if (script.startsWith("Get-NetFirewallProfile")) return "firewall";
  }
  if (file === "netsh") return "portproxy";
  if (file === "docker") return "docker";
  return `other:${file}`;
}

// A fake exec over named answers: a string, an Error, "hang" or a function.
function makeExec(answers) {
  const calls = [];
  let running = 0;
  const state = { maxRunning: 0 };
  async function exec(file, args, options) {
    calls.push({ file, args: args.slice(), timeout: options?.timeout, key: keyOf(file, args) });
    running += 1;
    state.maxRunning = Math.max(state.maxRunning, running);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const answer = answers[keyOf(file, args)];
      if (answer === "hang") return await new Promise(() => {});
      if (answer instanceof Error) throw answer;
      if (typeof answer === "function") return answer(args);
      if (answer === undefined) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return { stdout: answer };
    } finally {
      running -= 1;
    }
  }
  return { exec, calls, state };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exposure-scan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(root, rel, content = "") {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tree(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${path.relative(root, full)}:${fs.statSync(full).size}:${fs.statSync(full).mtimeMs}`);
    }
  };
  walk(root);
  return out;
}

// A fs that only allows reads and records every call.
function spyFs() {
  const calls = [];
  const allowed = new Set(["existsSync", "statSync", "readdirSync", "readFileSync"]);
  const spy = new Proxy({}, {
    get(_target, name) {
      if (typeof fs[name] !== "function") return undefined;
      return (...args) => {
        calls.push({ name: String(name), path: String(args[0]) });
        if (!allowed.has(name)) throw new Error(`write-capable fs call: ${String(name)}`);
        return fs[name](...args);
      };
    },
  });
  return { spy, calls };
}

function scrub(value, root) {
  const variants = [root, root.replace(/\\/g, "\\\\"), root.replace(/\\/g, "/")];
  const walk = (item) => {
    if (typeof item === "string") return variants.reduce((text, variant) => text.split(variant).join("<AI_ROOT>"), item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    return item;
  };
  return walk(value);
}

const ids = (report) => report.checks.map((check) => check.id);
const byId = (report) => Object.fromEntries(report.checks.map((check) => [check.id, check]));

function legacyRoot(t) {
  const root = tempRoot(t);
  put(root, "vllm-manager/manager-public-proxy.js", "// legacy proxy\n");
  put(root, "vllm-manager/public-port-proxy.js", "// legacy port proxy\n");
  put(root, "vllm-manager/upnp-port-map.js", "// legacy upnp\n");
  put(root, "vllm-manager/start-manager-public-proxy.cmd", "@echo off\r\n");
  put(root, "vllm-manager/stop-manager-public-proxy.cmd", "@echo off\r\n");
  put(root, "vllm-manager/logs/manager-public-proxy-access.log", "GET /vllm/v1/models 200\nGET /llama/v1/models 200\nPOST /vllm/v1/chat 401\n");
  put(root, "vllm-manager/logs/.last-public-service-key.txt", "FAKE-PLAINTEXT-KEY-DO-NOT-USE");
  put(root, "deploy/cloudflare/Caddyfile", fixture("Caddyfile.legacy"));
  put(root, "deploy/cloudflare/secrets/tunnel-token.txt", "FAKE-SECRET-CONTENT-DO-NOT-USE");
  put(root, "router-192-168-1-1.html", "<html><a href=\"/;stok=FAKE-STOK-VALUE-ONE/x\">a</a><a href=\"/;stok=FAKE-STOK-VALUE-TWO/y\">b</a></html>");
  return root;
}

const BAD_PROBE = {
  url: "https://api.example.invalid/status.json?probe=FAKEnonce0123456789",
  at: "2026-10-15T11:59:00.000Z",
  status: 200,
  latencyMs: 142,
  nonceObserved: true,
  observed: { viaProxy: false, headerUsed: "", socketIp: "172.18.0.1", country: "", forwardedOnUntrusted: true },
  tls: { validTo: new Date(NOW + 5 * DAY).toISOString(), authorized: true },
  error: null,
};

const GOOD_PROBE = {
  ...BAD_PROBE,
  observed: { viaProxy: true, headerUsed: "cf-connecting-ip", socketIp: "127.0.0.1", country: "DE", forwardedOnUntrusted: false },
  tls: { validTo: new Date(NOW + 90 * DAY).toISOString(), authorized: true },
};

function key(id, extra = {}) {
  return { id, name: id, status: "active", class: "friend", listeners: ["public"], allowedOrigins: [], expiresAt: new Date(NOW + 30 * DAY).toISOString(), createdAt: new Date(NOW - 5 * DAY).toISOString(), lastUsedAt: new Date(NOW - DAY).toISOString(), ...extra };
}

function fetchFor(handler) {
  return async (url, init) => ({ status: 200, body: { cancel: async () => {} }, ...(await handler(String(url), init)) });
}

async function scan(t, answers, { root, config = makeConfig(), probe = null, signals = {}, fsImpl, ...rest } = {}) {
  const fake = makeExec(answers);
  const aiRoot = root || tempRoot(t);
  const report = await exposure.runExposureScan({
    aiRoot,
    config,
    exec: fake.exec,
    fetch: fetchFor(() => ({ status: 200 })),
    lookup: async () => [{ address: "203.0.113.7", family: 4 }],
    now: () => NOW,
    platform: "win32",
    probe,
    signals,
    fs: fsImpl,
    timeoutMs: 2000,
    ...rest,
  });
  return { report, fake, aiRoot };
}

const BAD_ANSWERS = () => ({
  listeners: fixture("listeners.json"),
  processes: fixture("processes.json"),
  firewall: fixture("firewall.json"),
  portproxy: fixture("portproxy.txt"),
  docker: fixture("docker-ps.lines.txt"),
});

// ---- scan ---------------------------------------------------------------------

test("a bad machine produces every check with the expected states and matches its golden", async (t) => {
  const root = legacyRoot(t);
  const { report, fake } = await scan(t, BAD_ANSWERS(), {
    root,
    probe: BAD_PROBE,
    signals: {
      keys: [key("k_aaaaaaaaaaaaaaaaaaaa", { allowedOrigins: ["*"] }), key("k_bbbbbbbbbbbbbbbbbbbb", { expiresAt: null }), key("k_cccccccccccccccccccc", { lastUsedAt: null, createdAt: new Date(NOW - 40 * DAY).toISOString() })],
      adminViaProxy24h: 3,
      directManagerCalls24h: 7,
    },
  });
  assert.deepEqual(ids(report), exposure.CHECK_IDS, "every check of 05 §13.2, in order");
  for (const check of report.checks) {
    assert.ok(exposure.STATES.includes(check.state), check.id);
    assert.equal(check.title, `access.check.${check.id}`);
    assert.equal(check.fix, `access.fix.${check.id}`);
    assert.equal(typeof check.evidence, "string");
  }
  const states = Object.fromEntries(report.checks.map((check) => [check.id, check.state]));
  assert.deepEqual(states, {
    public_listener: "ok",
    admin_bind: "ok",
    wildcard_listeners: "fail",
    firewall_profiles: "fail",
    legacy_proxy: "fail",
    tunnel_running: "ok",
    tunnel_ready: "ok",
    tunnel_target: "fail",
    external_probe: "fail",
    tls: "warn",
    dns: "ok",
    trusted_proxy_match: "fail",
    managers_gateway_only: "warn",
    admin_via_proxy: "fail",
    keys_hygiene: "warn",
    plaintext_key_files: "fail",
    router_snapshots: "warn",
    upnp: "manual",
  });
  const checks = byId(report);
  assert.match(checks.tunnel_target.evidence, /^legacy_tunnel_bypasses_entry/);
  assert.deepEqual(checks.trusted_proxy_match.offer, { kind: "trust_cidr", cidr: "172.18.0.1/32", section: "trustedProxies", field: "cidrs" });
  assert.match(checks.legacy_proxy.evidence, /process manager-public-proxy \(pid 6660\)/);
  assert.match(checks.legacy_proxy.evidence, /port 55177 is listening/);
  assert.match(checks.legacy_proxy.evidence, /portproxy 0\.0\.0\.0:55177 -> 127\.0\.0\.1:5177/);
  assert.match(checks.router_snapshots.evidence, /1 router-\*\.html file\(s\) with 2 stok= occurrence\(s\)/);
  assert.match(checks.keys_hygiene.evidence, /1 key\(s\) allow any origin, 1 public key\(s\) never expire, 1 key\(s\) unused for 30 days/);
  assert.deepEqual(report.summary, { ok: 5, warn: 4, fail: 8, unknown: 0, manual: 1 });
  assert.equal(report.status, "ok");
  assert.deepEqual(report.probe, BAD_PROBE);
  assert.ok(report.map.nodes.length >= 6 && report.map.edges.every((edge) => exposure.STATES.includes(edge.state) || edge.state === "unknown"));
  assert.equal(report.map.edges.find((edge) => edge.from === "edge" && edge.to === "managers").state, "fail");

  // The probes: fixed argument arrays, one at a time, 10 s timeout each by default.
  assert.deepEqual(fake.calls.map((call) => call.key), ["listeners", "processes", "firewall", "portproxy", "docker"]);
  assert.equal(fake.state.maxRunning, 1);
  assert.deepEqual(fake.calls[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(fake.calls[0].args[3], "Get-NetTCPConnection -State Listen | Select LocalAddress,LocalPort,OwningProcess | ConvertTo-Json");
  assert.match(fake.calls[1].args[3], /^Get-CimInstance Win32_Process -Filter 'ProcessId=\d+( OR ProcessId=\d+)*' \| Select ProcessId,Name,CommandLine \| ConvertTo-Json$/);
  assert.equal(fake.calls[2].args[3], "Get-NetFirewallProfile | Select Name,Enabled | ConvertTo-Json");
  assert.deepEqual([fake.calls[3].file, fake.calls[3].args], ["netsh", ["interface", "portproxy", "show", "all"]]);
  assert.deepEqual([fake.calls[4].file, fake.calls[4].args], ["docker", ["ps", "--format", "{{json .}}"]]);
  assert.equal(fake.calls[0].file, "powershell.exe");

  checkGolden("report-legacy", scrub(report, root));
});

test("command lines, tokens and file contents never appear in a report", async (t) => {
  const root = legacyRoot(t);
  const { report } = await scan(t, BAD_ANSWERS(), { root, probe: BAD_PROBE });
  const text = JSON.stringify(report);
  for (const secret of ["FAKE-", "--token", "--key", "--upstream", "server.js", "FAKE-TUNNEL", "FAKE-ENGINE"]) {
    assert.equal(text.includes(secret), false, `${secret} leaked`);
  }
  assert.equal(/stok=FAKE/.test(text), false);
});

test("a healthy machine is all ok, with UPnP left manual", async (t) => {
  const root = tempRoot(t);
  put(root, "config/public/config.yml", fixture("cloudflared-config.current.yml"));
  const answers = {
    listeners: JSON.stringify([
      { LocalAddress: "127.0.0.1", LocalPort: 5186, OwningProcess: 100 },
      { LocalAddress: "127.0.0.1", LocalPort: 5176, OwningProcess: 100 },
      { LocalAddress: "127.0.0.1", LocalPort: 5177, OwningProcess: 200 },
      { LocalAddress: "127.0.0.1", LocalPort: 5190, OwningProcess: 300 },
    ]),
    processes: JSON.stringify([{ ProcessId: 100, Name: "node.exe", CommandLine: "node <AI_ROOT>\\service-entry\\server.js" }]),
    firewall: JSON.stringify([{ Name: "Domain", Enabled: true }, { Name: "Private", Enabled: true }, { Name: "Public", Enabled: true }]),
    portproxy: "\r\n",
    docker: fixture("docker-ps.lines.txt").split("\n").filter((line) => line.includes("cloudflared")).join("\n"),
  };
  const { report } = await scan(t, answers, {
    root,
    probe: GOOD_PROBE,
    config: makeConfig({ public: { managersGatewayOnly: "enforce" } }),
    signals: { keys: [key("k_aaaaaaaaaaaaaaaaaaaa")], adminViaProxy24h: 0, directManagerCalls24h: 0 },
  });
  assert.deepEqual(ids(report), exposure.CHECK_IDS);
  const notOk = report.checks.filter((check) => check.state !== "ok").map((check) => `${check.id}=${check.state}: ${check.evidence}`);
  assert.deepEqual(notOk, [`upnp=manual: ${byId(report).upnp.evidence}`]);
  assert.deepEqual(report.legacy, []);
  checkGolden("report-healthy", scrub(report, root));
});

test("public_listener and admin_bind: not listening, a wildcard behind a loopback setting, LAN binds by setting", async (t) => {
  const rows = (...list) => JSON.stringify(list.map(([address, port, pid]) => ({ LocalAddress: address, LocalPort: port, OwningProcess: pid })));
  const run = (listeners, config) => scan(t, { listeners, firewall: "[]", portproxy: "", docker: "" }, { config }).then(({ report }) => byId(report));

  let checks = await run(rows(["127.0.0.1", 5176, 1]));
  assert.equal(checks.public_listener.state, "fail");
  assert.match(checks.public_listener.evidence, /Port 5186 is not listening/);

  checks = await run(rows(["0.0.0.0", 5186, 9], ["127.0.0.1", 5176, 1]));
  assert.equal(checks.public_listener.state, "fail", "a wildcard bind while listeners.public.host is loopback");
  assert.match(checks.public_listener.evidence, /wildcard/);

  checks = await run(rows(["0.0.0.0", 5186, 9], ["127.0.0.1", 5176, 1]), makeConfig({ listeners: { public: { host: "0.0.0.0", baseUrl: "https://api.example.invalid" } } }));
  assert.equal(checks.public_listener.state, "ok", "a LAN-bound PUBLIC listener is what the settings ask for");

  checks = await run(rows(["127.0.0.1", 5186, 1], ["0.0.0.0", 5176, 1]));
  assert.equal(checks.admin_bind.state, "fail", "ADMIN on a wildcard without a LAN setting");
  checks = await run(rows(["127.0.0.1", 5186, 1], ["0.0.0.0", 5176, 1]), makeConfig({ listeners: { admin: { lan: true }, public: { baseUrl: "https://api.example.invalid" } } }));
  assert.equal(checks.admin_bind.state, "ok");

  checks = await run(rows(["127.0.0.1", 5186, 1], ["127.0.0.1", 5176, 1]), makeConfig({ listeners: { public: { enabled: false } } }));
  assert.equal(checks.public_listener.state, "ok", "a disabled PUBLIC listener exposes nothing");
});

test("wildcard listeners are a warning with the firewall on and a failure with it off; engine ports come from the managed containers", async (t) => {
  const listeners = JSON.stringify([
    { LocalAddress: "127.0.0.1", LocalPort: 5186, OwningProcess: 1 },
    { LocalAddress: "127.0.0.1", LocalPort: 5176, OwningProcess: 1 },
    { LocalAddress: "0.0.0.0", LocalPort: 8000, OwningProcess: 7 },
    { LocalAddress: "0.0.0.0", LocalPort: 9999, OwningProcess: 7 },
  ]);
  const docker = fixture("docker-ps.lines.txt");
  const on = JSON.stringify([{ Name: "Public", Enabled: true }]);
  const off = JSON.stringify([{ Name: "Public", Enabled: false }]);
  let { report } = await scan(t, { listeners, processes: "[]", firewall: on, portproxy: "", docker });
  let checks = byId(report);
  assert.equal(checks.wildcard_listeners.state, "warn");
  assert.match(checks.wildcard_listeners.evidence, /Ports 8000 listen on all interfaces; the firewall is on/, "8000 is a managed engine port, 9999 is not watched");
  assert.equal(checks.firewall_profiles.state, "ok");
  ({ report } = await scan(t, { listeners, processes: "[]", firewall: off, portproxy: "", docker }));
  checks = byId(report);
  assert.equal(checks.wildcard_listeners.state, "fail");
  assert.equal(checks.firewall_profiles.state, "fail", "a disabled profile combined with wildcard listeners");
  ({ report } = await scan(t, { listeners: JSON.stringify([{ LocalAddress: "127.0.0.1", LocalPort: 5186, OwningProcess: 1 }, { LocalAddress: "127.0.0.1", LocalPort: 5176, OwningProcess: 1 }]), processes: "[]", firewall: off, portproxy: "", docker: "" }));
  assert.equal(byId(report).firewall_profiles.state, "warn", "a disabled profile alone is a warning");
});

test("tunnel checks: a stopped container fails, /ready decides, no container is unknown", async (t) => {
  const base = { listeners: "[]", processes: "[]", firewall: "[]", portproxy: "" };
  const tunnelLine = fixture("docker-ps.lines.txt").split("\n")[0];
  let { report } = await scan(t, { ...base, docker: "" });
  assert.equal(byId(report).tunnel_running.state, "unknown");
  assert.equal(byId(report).tunnel_ready.state, "unknown");
  ({ report } = await scan(t, { ...base, docker: tunnelLine.replace('"State":"running"', '"State":"exited"') }));
  assert.equal(byId(report).tunnel_running.state, "fail");
  assert.equal(byId(report).tunnel_ready.state, "unknown");

  const ports = [];
  const answer = (handler) => scan(t, { ...base, docker: tunnelLine }, { fetch: fetchFor((url) => { ports.push(url); return handler(); }) });
  ({ report } = await answer(() => ({ status: 503 })));
  assert.equal(byId(report).tunnel_ready.state, "fail");
  assert.match(byId(report).tunnel_ready.evidence, /HTTP 503/);
  assert.deepEqual(ports, ["http://127.0.0.1:20241/ready"]);
  ({ report } = await scan(t, { ...base, docker: tunnelLine }, { fetch: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } }));
  assert.equal(byId(report).tunnel_ready.state, "fail");
  ({ report } = await scan(t, { ...base, docker: tunnelLine }, { fetch: () => new Promise(() => {}), timeoutMs: 80 }));
  assert.equal(byId(report).tunnel_ready.state, "unknown", "a timeout is unknown, not a failure");
  ({ report } = await scan(t, { ...base, docker: tunnelLine }, { cloudflaredMetricsPort: 31999, fetch: fetchFor((url) => { ports.push(url); return { status: 200 }; }) }));
  assert.equal(ports.at(-1), "http://127.0.0.1:31999/ready");
  assert.equal(byId(report).tunnel_ready.state, "ok");
});

test("tunnel_target reads the generated config and the legacy Caddyfile; secrets are never opened", async (t) => {
  const root = tempRoot(t);
  const empty = { listeners: "[]", processes: "[]", firewall: "[]", portproxy: "", docker: "" };
  assert.equal(byId((await scan(t, empty, { root })).report).tunnel_target.state, "unknown", "a token tunnel has no local config");
  put(root, "config/public/Caddyfile", fixture("Caddyfile.current"));
  put(root, "config/public/config.yml", fixture("cloudflared-config.current.yml"));
  const { spy, calls } = spyFs();
  let checks = byId((await scan(t, empty, { root, fsImpl: spy })).report);
  assert.equal(checks.tunnel_target.state, "ok");
  assert.match(checks.tunnel_target.evidence, /:5186 only/);
  put(root, "config/public/legacy.yml", fixture("cloudflared-config.legacy.yml"));
  put(root, "deploy/cloudflare/secrets/token.txt", "FAKE-SECRET-CONTENT");
  checks = byId((await scan(t, empty, { root, fsImpl: spy })).report);
  assert.equal(checks.tunnel_target.state, "fail");
  assert.match(checks.tunnel_target.evidence, /^legacy_tunnel_bypasses_entry: config\/public\/legacy\.yml -> :5177/);
  assert.equal(calls.some((call) => /secrets/.test(call.path) && call.name !== "readdirSync" && call.name !== "statSync"), false);
  assert.equal(calls.some((call) => /secrets[\\/]token/.test(call.path)), false, "the secrets directory is never read");
  fs.rmSync(path.join(root, "config", "public", "legacy.yml"));

  // A tunnel pointed at the ADMIN listener is its own failure.
  put(root, "config/public/admin.yml", "ingress:\n  - service: http://127.0.0.1:5176\n");
  checks = byId((await scan(t, empty, { root })).report);
  assert.match(checks.tunnel_target.evidence, /^tunnel_targets_admin_listener/);
});

test("external_probe, tls and trusted_proxy_match follow the probe result", async (t) => {
  const answers = { listeners: "[]", processes: "[]", firewall: "[]", portproxy: "", docker: "" };
  const run = async (probe) => byId((await scan(t, answers, { probe })).report);
  let checks = await run(null);
  assert.deepEqual([checks.external_probe.state, checks.tls.state, checks.trusted_proxy_match.state], ["unknown", "unknown", "unknown"]);
  checks = await run(GOOD_PROBE);
  assert.deepEqual([checks.external_probe.state, checks.tls.state, checks.trusted_proxy_match.state], ["ok", "ok", "ok"]);
  assert.match(checks.external_probe.evidence, /header cf-connecting-ip, country DE/);
  checks = await run({ ...GOOD_PROBE, nonceObserved: false });
  assert.equal(checks.external_probe.state, "fail");
  assert.match(checks.external_probe.evidence, /never saw the probe nonce/);
  checks = await run({ ...GOOD_PROBE, status: 530 });
  assert.equal(checks.external_probe.state, "fail");
  checks = await run({ ...GOOD_PROBE, error: { code: "ETIMEDOUT", hairpin: true }, nonceObserved: false });
  assert.equal(checks.external_probe.state, "unknown", "a hairpin failure is unknown");
  checks = await run({ ...GOOD_PROBE, error: { code: "CERT_HAS_EXPIRED", hairpin: false } });
  assert.equal(checks.external_probe.state, "fail");
  checks = await run({ ...GOOD_PROBE, tls: { validTo: new Date(NOW - DAY).toISOString() } });
  assert.equal(checks.tls.state, "fail");
  checks = await run({ ...GOOD_PROBE, tls: { validTo: new Date(NOW + 13 * DAY).toISOString() } });
  assert.equal(checks.tls.state, "warn");
  checks = await run({ ...GOOD_PROBE, tls: { validTo: new Date(NOW + 14 * DAY + 1000).toISOString() } });
  assert.equal(checks.tls.state, "ok");
  // A public (non-private) socket address fails without a one-click offer.
  checks = await run({ ...GOOD_PROBE, observed: { ...GOOD_PROBE.observed, socketIp: "198.51.100.4" } });
  assert.equal(checks.trusted_proxy_match.state, "fail");
  assert.equal(checks.trusted_proxy_match.offer, undefined);
  // IPv6 socket in the default ::1 range is fine; a ULA address gets a /128 offer.
  checks = await run({ ...GOOD_PROBE, observed: { ...GOOD_PROBE.observed, socketIp: "::1" } });
  assert.equal(checks.trusted_proxy_match.state, "ok");
  checks = await run({ ...GOOD_PROBE, observed: { ...GOOD_PROBE.observed, socketIp: "fd00::5" } });
  assert.equal(checks.trusted_proxy_match.offer.cidr, "fd00::5/128");
});

test("dns: unresolved fails, resolved is ok, no base URL or a timeout is unknown", async (t) => {
  const answers = { listeners: "[]", processes: "[]", firewall: "[]", portproxy: "", docker: "" };
  let checks = byId((await scan(t, answers, { lookup: async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); } })).report);
  assert.equal(checks.dns.state, "fail");
  assert.match(checks.dns.evidence, /api\.example\.invalid does not resolve/);
  checks = byId((await scan(t, answers, { config: makeConfig({ listeners: { public: { baseUrl: "" } } }) })).report);
  assert.equal(checks.dns.state, "unknown");
  assert.match(checks.dns.evidence, /LAN only/);
  checks = byId((await scan(t, answers, { lookup: () => new Promise(() => {}), timeoutMs: 80 })).report);
  assert.equal(checks.dns.state, "unknown");
});

test("managers_gateway_only, admin_via_proxy and keys_hygiene", async (t) => {
  const answers = { listeners: "[]", processes: "[]", firewall: "[]", portproxy: "", docker: "" };
  const run = async (mode, signals) => byId((await scan(t, answers, { config: makeConfig({ public: { managersGatewayOnly: mode } }), signals })).report);
  assert.equal((await run("off", {})).managers_gateway_only.state, "fail");
  assert.equal((await run("enforce", {})).managers_gateway_only.state, "ok");
  const warn = await run("warn", { directManagerCalls24h: 12 });
  assert.equal(warn.managers_gateway_only.state, "warn");
  assert.match(warn.managers_gateway_only.evidence, /12 in the last 24 h/);
  assert.equal(warn.admin_via_proxy.state, "unknown");
  assert.equal(warn.keys_hygiene.state, "unknown");
  assert.equal((await run("warn", { adminViaProxy24h: 0 })).admin_via_proxy.state, "ok");
  const tidy = await run("warn", { keys: [key("k_aaaaaaaaaaaaaaaaaaaa"), key("k_bbbbbbbbbbbbbbbbbbbb", { class: "internal", expiresAt: null, listeners: ["public", "admin"] }), key("k_cccccccccccccccccccc", { status: "revoked", allowedOrigins: ["*"] })] });
  assert.equal(tidy.keys_hygiene.state, "ok", "internal keys never expire by design and revoked keys do not count");
  const messy = await run("warn", { keys: [key("k_aaaaaaaaaaaaaaaaaaaa", { allowedOrigins: ["https://app.example.invalid", "*"] })] });
  assert.equal(messy.keys_hygiene.state, "warn");
  assert.deepEqual(messy.keys_hygiene.keys.wildcardOrigins, ["k_aaaaaaaaaaaaaaaaaaaa"]);
});

test("a probe that times out, fails or is garbled makes its checks unknown, never a guess", async (t) => {
  const good = BAD_ANSWERS();
  // A hung listeners probe: the process lookup depends on it.
  const hung = await scan(t, { ...good, listeners: "hang" }, { timeoutMs: 80 });
  assert.deepEqual(ids(hung.report), exposure.CHECK_IDS);
  const checks = byId(hung.report);
  for (const id of ["public_listener", "admin_bind", "wildcard_listeners"]) {
    assert.equal(checks[id].state, "unknown", id);
    assert.match(checks[id].evidence, /timed out/);
  }
  assert.equal(checks.legacy_proxy.state, "fail", "a portproxy rule to a manager is evidence on its own");
  assert.equal(checks.firewall_profiles.state, "warn", "the firewall probe still runs; without listener data it cannot be combined into a failure");
  assert.equal(hung.fake.calls.some((call) => call.key === "processes"), false, "no process lookup without listeners");

  // Docker missing, netsh garbled, firewall hangs.
  const mixed = await scan(t, { ...good, docker: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }), portproxy: undefined, firewall: "hang" }, { timeoutMs: 80 });
  const mixedChecks = byId(mixed.report);
  assert.equal(mixedChecks.tunnel_running.state, "unknown");
  assert.equal(mixedChecks.firewall_profiles.state, "unknown");
  assert.equal(mixedChecks.legacy_proxy.state, "fail", "a legacy process is still found without portproxy data");
  const garbled = await scan(t, { ...good, listeners: "this is not json" });
  assert.equal(byId(garbled.report).public_listener.state, "unknown");
  assert.match(byId(garbled.report).public_listener.evidence, /not understood/);

  // Everything hangs: nothing to say but unknown, and the scan still returns.
  const all = await scan(t, { listeners: "hang", firewall: "hang", portproxy: "hang", docker: "hang" }, { timeoutMs: 40 });
  assert.deepEqual(ids(all.report), exposure.CHECK_IDS);
  const osChecks = ["public_listener", "admin_bind", "wildcard_listeners", "firewall_profiles", "legacy_proxy", "tunnel_running", "tunnel_ready"];
  for (const id of osChecks) assert.equal(byId(all.report)[id].state, "unknown", id);
  assert.equal(byId(all.report).upnp.state, "manual");
});

test("the default probe timeout is 10 seconds", async (t) => {
  const fake = makeExec({ listeners: "[]", processes: "[]", firewall: "[]", portproxy: "", docker: "" });
  await exposure.runExposureScan({ aiRoot: tempRoot(t), config: makeConfig(), exec: fake.exec, now: () => NOW, platform: "win32", lookup: async () => [{}], signals: {} });
  assert.equal(exposure.PROBE_TIMEOUT_MS, 10_000);
  assert.ok(fake.calls.length >= 4);
  assert.ok(fake.calls.every((call) => call.timeout === 10_000));
});

test("off Windows the scan is unsupported, runs nothing and does not throw", async (t) => {
  const fake = makeExec({});
  const root = legacyRoot(t);
  for (const platform of ["linux", "darwin"]) {
    const report = await exposure.runExposureScan({ aiRoot: root, config: makeConfig(), exec: fake.exec, now: () => NOW, platform });
    assert.equal(report.status, "unsupported");
    assert.equal(report.platform, platform);
    assert.deepEqual(ids(report), exposure.CHECK_IDS);
    assert.deepEqual(report.checks.filter((check) => check.state !== "unknown").map((check) => check.id), ["upnp"]);
    assert.deepEqual(report.legacy, []);
  }
  assert.equal(fake.calls.length, 0, "nothing was executed");
  checkGolden("report-unsupported", scrub(await exposure.runExposureScan({ aiRoot: root, config: makeConfig(), exec: fake.exec, now: () => NOW, platform: "linux" }), root));
});

test("the scan never throws, whatever the dependencies do", async (t) => {
  const report = await exposure.runExposureScan({
    aiRoot: path.join(os.tmpdir(), "exposure-scan-missing-root"),
    config: {},
    exec: () => { throw new Error("boom"); },
    fetch: () => { throw new Error("boom"); },
    lookup: () => { throw new Error("boom"); },
    now: () => NOW,
    platform: "win32",
    timeoutMs: 100,
  });
  assert.deepEqual(ids(report), exposure.CHECK_IDS);
  assert.equal(byId(report).plaintext_key_files.state, "ok");
});

// ---- legacy artifacts -------------------------------------------------------------

test("legacy findings are relative, read-only and never include contents; the golden pins them", (t) => {
  const root = legacyRoot(t);
  const before = tree(root);
  const { spy, calls } = spyFs();
  const findings = exposure.detectLegacyArtifacts(root, spy);
  assert.deepEqual(tree(root), before, "nothing was created, changed or removed");
  assert.deepEqual([...new Set(calls.map((call) => call.name))].sort(), ["existsSync", "readFileSync", "readdirSync", "statSync"].filter((name) => calls.some((call) => call.name === name)).sort());
  assert.ok(calls.every((call) => ["existsSync", "readFileSync", "readdirSync", "statSync"].includes(call.name)), "only read operations");
  assert.equal(calls.some((call) => /last-public-service-key|secrets/.test(call.path) && call.name === "readFileSync"), false, "the key file and the secrets are never read");
  assert.equal(calls.some((call) => /secrets[\\/]/.test(call.path)), false);

  assert.deepEqual(findings.map((item) => item.relPath), [
    "deploy/cloudflare",
    "deploy/cloudflare/secrets",
    "router-192-168-1-1.html",
    "vllm-manager/logs/.last-public-service-key.txt",
    "vllm-manager/logs/manager-public-proxy-access.log",
    "vllm-manager/manager-public-proxy.js",
    "vllm-manager/public-port-proxy.js",
    "vllm-manager/start-manager-public-proxy.cmd",
    "vllm-manager/stop-manager-public-proxy.cmd",
    "vllm-manager/upnp-port-map.js",
  ]);
  for (const finding of findings) {
    assert.ok(!path.isAbsolute(finding.relPath) && !/[\\:]/.test(finding.relPath), `${finding.relPath} is relative to the AI root`);
    assert.ok(["script", "config", "log", "snapshot", "secret-file"].includes(finding.kind));
    assert.ok(["high", "medium"].includes(finding.risk));
    assert.match(finding.recommendation, /^access\.legacy\./);
    assert.match(finding.suggestedCommand, /Move-Item -LiteralPath/);
    assert.match(finding.suggestedCommand, /ai-exposure-archive/);
  }
  const text = JSON.stringify(findings);
  for (const hidden of ["FAKE-PLAINTEXT-KEY", "FAKE-SECRET-CONTENT", "FAKE-STOK-VALUE", "GET /vllm/v1/models"]) assert.equal(text.includes(hidden), false, hidden);
  assert.match(findings.find((item) => item.kind === "log").evidence, /3 lines/);
  assert.match(findings.find((item) => item.kind === "snapshot").evidence, /2 stok= occurrence\(s\)/);
  assert.equal(findings.find((item) => item.relPath === "deploy/cloudflare").kind, "config");
  assert.equal(findings.find((item) => item.relPath === "deploy/cloudflare/secrets").kind, "secret-file");
  checkGolden("legacy-findings", scrub(findings, root));
});

test("deploy/cloudflare counts as legacy only for untracked files; PUB-20's tracked templates are not findings", (t) => {
  const root = tempRoot(t);
  assert.deepEqual(exposure.detectLegacyArtifacts(root, fs), []);
  for (const name of ["README.md", "compose.yaml", "config.yml.template", "cloudflared.env.example"]) put(root, `deploy/cloudflare/${name}`, "x");
  assert.deepEqual(exposure.detectLegacyArtifacts(root, fs), []);
  put(root, "deploy/cloudflare/Caddyfile", "x");
  const findings = exposure.detectLegacyArtifacts(root, fs);
  assert.deepEqual(findings.map((item) => item.relPath), ["deploy/cloudflare"]);
  assert.match(findings[0].evidence, /Caddyfile/);
  assert.equal(findings[0].evidence.includes("README.md"), false);
});

test("the legacy command doubles single quotes in the root so it stays copyable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exposure-it's-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  put(root, "router-x.html", "stok=a");
  const [finding] = exposure.detectLegacyArtifacts(root, fs);
  assert.ok(finding.suggestedCommand.startsWith(`$root = '${root.replace(/'/g, "''")}'`));
  assert.ok(finding.suggestedCommand.includes("it''s"));
  assert.ok(finding.suggestedCommand.includes("Move-Item -LiteralPath (Join-Path $root 'router-x.html')"));
});

test("the module has no write-capable file system calls", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "exposure-scan.js"), "utf8");
  assert.equal(/\b(?:writeFile|appendFile|unlink|rename|rmSync|rmdir|mkdir|copyFile|truncate|createWriteStream|symlink|chmod|chown|utimes)(?:Sync)?\s*\(/.test(source), false);
  assert.equal(/child_process/.test(source) && /\bexec\s*\(\s*["'`]/.test(source), false, "no shell string execution");
});

// ---- scanner: cache, serialisation ---------------------------------------------------

test("the scanner serialises scans, caches a snapshot for 60 s, and cached() never scans", async (t) => {
  const fake = makeExec({ listeners: "[]", processes: "[]", firewall: "[]", portproxy: "", docker: "" });
  const clock = { now: NOW };
  let signals = { adminViaProxy24h: 0 };
  const scanner = exposure.createExposureScanner({
    aiRoot: tempRoot(t),
    getConfig: () => makeConfig(),
    getSignals: () => signals,
    exec: fake.exec,
    fetch: fetchFor(() => ({ status: 200 })),
    lookup: async () => [{}],
    now: () => clock.now,
    platform: "win32",
    timeoutMs: 1000,
  });
  assert.equal(scanner.cached(), null);
  assert.equal(fake.calls.length, 0, "cached() ran nothing");
  const [a, b] = await Promise.all([scanner.report(), scanner.report()]);
  assert.equal(fake.calls.length, 4, "two concurrent callers share one scan (listeners, firewall, portproxy, docker)");
  assert.equal(fake.state.maxRunning, 1);
  assert.deepEqual(a, b);
  clock.now += 59_000;
  await scanner.report();
  assert.equal(fake.calls.length, 4, "cached for 60 s");
  signals = { adminViaProxy24h: 5 };
  assert.equal(byId(await scanner.report()).admin_via_proxy.state, "fail", "signals are read fresh from the cached snapshot");
  assert.equal(fake.calls.length, 4);
  await scanner.report({ force: true });
  assert.equal(fake.calls.length, 8, "force scans again");
  clock.now += 61_000;
  await scanner.report();
  assert.equal(fake.calls.length, 12, "an expired snapshot scans again");
  assert.equal(byId(scanner.cached()).admin_via_proxy.state, "fail", "cached() uses the last signals");
  assert.equal(fake.calls.length, 12);
});

// ---- probe recorder and probe ------------------------------------------------------------

test("the recorder only keeps nonces the probe registered, first arrival wins, and entries expire after 60 s", () => {
  const clock = { now: NOW };
  const recorder = exposure.createProbeRecorder({ now: () => clock.now, maxEntries: 3 });
  const nonce = "AAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(recorder.observe(nonce, { socketIp: "10.0.0.1" }), false, "never registered");
  assert.equal(recorder.get(nonce), null);
  assert.equal(recorder.expect("short"), false, "a nonce has a fixed shape");
  assert.equal(recorder.expect(nonce), true);
  assert.equal(recorder.observe("bad nonce!", {}), false);
  assert.equal(recorder.observe(nonce, { socketIp: "172.18.0.1", viaProxy: true, headerUsed: "cf-connecting-ip", country: "DE" }), true);
  assert.equal(recorder.observe(nonce, { socketIp: "6.6.6.6", viaProxy: false }), false, "the first arrival wins");
  assert.deepEqual(recorder.get(nonce), { at: new Date(NOW).toISOString(), socketIp: "172.18.0.1", viaProxy: true, headerUsed: "cf-connecting-ip", country: "DE", forwardedOnUntrusted: false });
  clock.now += 59_000;
  assert.ok(recorder.get(nonce));
  clock.now += 2_000;
  assert.equal(recorder.get(nonce), null, "forgotten after 60 s");
  assert.equal(recorder.size(), 0);
  for (const letter of "BCDE") recorder.expect(letter.repeat(22));
  assert.equal(recorder.size(), 3, "the table is bounded");
});

test("runProbe records viaProxy and headerUsed as the PUBLIC side saw them", async () => {
  const recorder = exposure.createProbeRecorder({ now: () => NOW });
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, redirect: init.redirect });
    const target = new URL(url);
    recorder.observe(target.searchParams.get("probe"), { socketIp: "172.18.0.1", viaProxy: true, headerUsed: "cf-connecting-ip", country: "DE" });
    return { status: 200, body: { cancel: async () => {} } };
  };
  const probe = await exposure.runProbe({
    baseUrl: "https://api.example.invalid/some/path",
    recorder,
    fetch: fetchFn,
    tlsProbe: async ({ host, port }) => ({ validTo: `${host}:${port}`.length ? "2027-01-01T00:00:00.000Z" : null, authorized: true }),
    now: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, 7),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].redirect, "manual");
  assert.match(seen[0].url, /^https:\/\/api\.example\.invalid\/status\.json\?probe=[A-Za-z0-9_-]{22}$/, "only the origin of the base URL is used");
  assert.equal(probe.url, seen[0].url);
  assert.equal(probe.status, 200);
  assert.equal(probe.nonceObserved, true);
  assert.deepEqual(probe.observed, { viaProxy: true, headerUsed: "cf-connecting-ip", socketIp: "172.18.0.1", country: "DE", forwardedOnUntrusted: false });
  assert.deepEqual(probe.tls, { validTo: "2027-01-01T00:00:00.000Z", authorized: true });
  assert.equal(probe.error, null);
});

test("runProbe: a nonce nobody saw, a hairpin failure and a plain-http base URL", async () => {
  const recorder = exposure.createProbeRecorder({ now: () => NOW });
  let probe = await exposure.runProbe({ baseUrl: "http://192.168.1.20:5186", recorder, fetch: async () => ({ status: 200, body: null }), now: () => NOW });
  assert.equal(probe.nonceObserved, false);
  assert.equal(probe.observed.viaProxy, false);
  assert.equal(probe.observed.socketIp, null);
  assert.equal(probe.tls, null, "no TLS probe for http");
  probe = await exposure.runProbe({
    baseUrl: "https://api.example.invalid",
    recorder,
    fetch: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } }); },
    now: () => NOW,
  });
  assert.deepEqual(probe.error, { code: "ETIMEDOUT", hairpin: true });
  assert.equal(probe.tls, null);
  probe = await exposure.runProbe({ baseUrl: "https://api.example.invalid", recorder, fetch: () => new Promise(() => {}), now: () => NOW, timeoutMs: 40 });
  assert.deepEqual(probe.error, { code: "timeout", hairpin: true });
  probe = await exposure.runProbe({
    baseUrl: "https://api.example.invalid",
    recorder,
    fetch: async () => { throw Object.assign(new Error("certificate"), { code: "CERT_HAS_EXPIRED" }); },
    now: () => NOW,
  });
  assert.deepEqual(probe.error, { code: "CERT_HAS_EXPIRED", hairpin: false });
  await assert.rejects(() => exposure.runProbe({ baseUrl: "ftp://example.invalid", recorder }), TypeError);
  await assert.rejects(() => exposure.runProbe({ baseUrl: "", recorder }));
});

test("the PUBLIC listener records a registered probe nonce with the socket and header it saw, and nothing else", async (t) => {
  const recorder = exposure.createProbeRecorder();
  let identity = { socketIp: "172.18.0.1", ip: "203.0.113.9", viaProxy: true, headerUsed: "cf-connecting-ip", country: "DE", forwardedOnUntrusted: false };
  const security = { publicHostnames: () => new Set(["127.0.0.1"]), identifyClient: () => identity };
  const data = { respond: async () => ({ status: "operational" }) };
  const listener = createPublicListener({ security, data, probeRecorder: recorder, logger: quietLogger() });
  const server = http.createServer((req, res) => {
    req.listener = { kind: "public", lanBound: false };
    listener.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  const port = server.address().port;
  const get = (pathname) => request(port, pathname);
  const nonce = "Zz09_-Zz09_-Zz09_-Zz09_-";

  assert.equal((await get(`/status.json?probe=${nonce}`)).status, 200);
  assert.equal(recorder.get(nonce), null, "a nonce the probe did not register is ignored");
  recorder.expect(nonce);
  const answered = await get(`/status.json?probe=${nonce}`);
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.json, { status: "operational" }, "the response is the normal status document");
  assert.deepEqual(Object.keys(recorder.get(nonce)).sort(), ["at", "country", "forwardedOnUntrusted", "headerUsed", "socketIp", "viaProxy"]);
  assert.equal(recorder.get(nonce).headerUsed, "cf-connecting-ip");
  assert.equal(recorder.get(nonce).socketIp, "172.18.0.1");
  assert.equal(recorder.get(nonce).country, "DE");

  // Direct, untrusted: a forwarded header from a socket outside trustedProxies is flagged, not believed.
  const second = "Yy09_-Yy09_-Yy09_-Yy09_-";
  recorder.expect(second);
  identity = { socketIp: "192.168.1.77", ip: "192.168.1.77", viaProxy: false, headerUsed: "", country: "", forwardedOnUntrusted: true };
  await get(`/status.json?probe=${second}`);
  assert.deepEqual(
    { viaProxy: recorder.get(second).viaProxy, forwarded: recorder.get(second).forwardedOnUntrusted, ip: recorder.get(second).socketIp },
    { viaProxy: false, forwarded: true, ip: "192.168.1.77" },
  );
  // Other paths and a missing parameter record nothing.
  const third = "Xx09_-Xx09_-Xx09_-Xx09_-";
  recorder.expect(third);
  await get(`/catalog.json?probe=${third}`);
  await get("/status.json");
  assert.equal(recorder.get(third), null);
  // A throwing identity never breaks the response.
  security.identifyClient = () => { throw new Error("boom"); };
  recorder.expect("Ww09_-Ww09_-Ww09_-Ww09_-");
  assert.equal((await get("/status.json?probe=Ww09_-Ww09_-Ww09_-Ww09_-")).status, 200);
});

test("the real PUBLIC server sees a trusted proxy header and reports it through the probe", async (t) => {
  const { entry } = await loadEntry();
  const recorder = exposure.createProbeRecorder();
  const server = entry.createPublicServer({ probeRecorder: recorder, data: { respond: async () => ({ status: "operational" }) }, preAuth: null, logger: quietLogger() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const viaProxy = await exposure.runProbe({
    baseUrl: base,
    recorder,
    fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, "cf-connecting-ip": "203.0.113.9", "cf-ipcountry": "DE" } }),
  });
  assert.equal(viaProxy.status, 200);
  assert.equal(viaProxy.nonceObserved, true);
  assert.deepEqual(viaProxy.observed, { viaProxy: true, headerUsed: "cf-connecting-ip", socketIp: "127.0.0.1", country: "DE", forwardedOnUntrusted: false });
  const direct = await exposure.runProbe({ baseUrl: base, recorder });
  assert.equal(direct.nonceObserved, true);
  assert.deepEqual([direct.observed.viaProxy, direct.observed.headerUsed], [false, ""], "a direct call carries no trusted header");
});

// ---- routes -------------------------------------------------------------------------------------

function fakeScanner(overrides = {}) {
  const state = { reports: [], probes: 0 };
  const scanner = {
    state,
    recorder: exposure.createProbeRecorder(),
    async report({ force } = {}) {
      state.reports.push({ force: Boolean(force) });
      return { at: "2026-10-15T12:00:00.000Z", status: "ok", platform: "win32", summary: { ok: 1, warn: 0, fail: 0, unknown: 0, manual: 0 }, checks: [], legacy: [], map: { nodes: [], edges: [] }, probe: null };
    },
    async probe() {
      state.probes += 1;
      return GOOD_PROBE;
    },
    cached: () => null,
    ...overrides,
  };
  return scanner;
}

function makeHarness(options = {}) {
  const fixtureAuth = makeAdminAuth();
  const published = [];
  const auth = createRequestAuth({
    security: { checkManagementAccess: () => ({ ok: false }) },
    adminAuth: fixtureAuth.auth,
    logger: { warn() {}, error() {} },
  });
  const config = () => options.config || makeConfig();
  const bus = options.bus || { publish: (type, data) => published.push({ type, data }), recent: () => ({ events: [] }) };
  const getStore = () => fixtureAuth.store;
  const securityOverview = options.securityOverview === undefined
    ? createSecurityOverview({ getStore, getBus: () => bus, getConfig: config, telemetry: options.telemetry || null, now: () => fixtureAuth.clock.now })
    : options.securityOverview;
  const scanner = options.exposure === undefined ? fakeScanner() : options.exposure;
  const routes = createAccessRoutes({
    auth,
    sendJson: (res, data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    },
    readJsonObjectBody: async (req) => req.jsonBody || {},
    getStore,
    getSecurity: () => ({ accessConfig: config, refreshAccessConfig: () => {} }),
    getBus: () => bus,
    exposure: scanner,
    securityOverview,
    settings: {},
    logger: { warn() {}, error() {}, log() {} },
    now: () => fixtureAuth.clock.now,
  });
  const code = fixtureAuth.auth.mintPairCode({ actor: "test" }).code;
  const paired = fixtureAuth.auth.pairWithCode(fakeRequest({ method: "POST", url: "/api/session/pair" }), code);
  assert.equal(paired.ok, true);
  const session = { cookie: cookiePair(paired.setCookie), csrfToken: paired.csrfToken };

  async function call(method, pathname, { body, who = "owner", headers = {}, peer } = {}) {
    const req = fakeRequest({
      method,
      url: pathname,
      peer,
      headers: {
        ...(who === "owner" || who === "no-csrf" ? { cookie: session.cookie } : {}),
        ...(who === "owner" && method !== "GET" ? { "x-csrf-token": session.csrfToken } : {}),
        ...headers,
      },
    });
    if (who === "cli") fixtureAuth.machineAuth.remember(req, "system:cli");
    if (body !== undefined) req.jsonBody = body;
    const res = reply();
    const handled = await routes.handle(req, res, new URL(pathname, "http://127.0.0.1:5176"));
    return { handled, status: res.status, json: res.json };
  }
  return { fixture: fixtureAuth, store: fixtureAuth.store, call, published, scanner, bus };
}

test("every exposure and security route is owner-only; writes need the CSRF token; system:cli needs neither", async () => {
  const h = makeHarness();
  const reads = ["/api/public/exposure", "/api/security/overview", "/api/security/events", "/api/security/bans"];
  for (const pathname of reads) {
    const viewer = await h.call("GET", pathname, { who: "viewer" });
    assert.equal(viewer.status, 403, pathname);
    assert.equal(viewer.json.error.code, "owner_required", pathname);
    assert.equal((await h.call("GET", pathname)).status, 200, pathname);
    assert.equal((await h.call("GET", pathname, { who: "cli" })).status, 200, pathname);
  }
  const writes = [
    ["POST", "/api/public/exposure/scan", {}],
    ["POST", "/api/public/probe", {}],
    ["POST", "/api/security/bans", { kind: "ip", subject: "203.0.113.50", reason: "test" }],
    ["DELETE", "/api/security/bans/203.0.113.50", undefined],
  ];
  for (const [method, pathname, body] of writes) {
    const viewer = await h.call(method, pathname, { body, who: "viewer" });
    assert.ok([401, 403].includes(viewer.status), `${method} ${pathname}`);
    const noCsrf = await h.call(method, pathname, { body, who: "no-csrf" });
    assert.equal(noCsrf.status, 403, `${method} ${pathname}`);
    assert.equal(noCsrf.json.error.code, "csrf_invalid", `${method} ${pathname}`);
  }
  assert.equal((await h.call("POST", "/api/public/exposure/scan", { body: {}, who: "cli" })).status, 200);
  assert.equal((await h.call("GET", "/api/security/nothing")).handled, false, "an unknown path falls through");
  assert.equal((await h.call("GET", "/api/public/templates")).handled, true, "PUB-20 serves the templates routes in this module now");
});

test("GET /api/public/exposure answers the cached report; POST scan forces a scan and is audited without the report", async () => {
  const h = makeHarness();
  const first = await h.call("GET", "/api/public/exposure");
  assert.equal(first.json.ok, true);
  assert.equal(first.json.report.status, "ok");
  assert.deepEqual(h.scanner.state.reports, [{ force: false }]);
  const forced = await h.call("POST", "/api/public/exposure/scan", { body: {} });
  assert.equal(forced.status, 200);
  assert.deepEqual(h.scanner.state.reports.at(-1), { force: true });
  const audit = h.store.listAudit({ action: "exposure.scan" }).items;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].targetType, "exposure");
  assert.equal(JSON.stringify(audit[0].details).includes("checks"), false);
  const missing = makeHarness({ exposure: null });
  assert.equal((await missing.call("GET", "/api/public/exposure")).json.error.code, "exposure_unavailable");
});

test("POST /api/public/probe returns the probe shape, needs a base URL and is audited", async () => {
  const h = makeHarness();
  const result = await h.call("POST", "/api/public/probe", { body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  const { probe } = result.json;
  assert.deepEqual(Object.keys(probe).sort(), ["at", "error", "latencyMs", "nonceObserved", "observed", "status", "tls", "url"]);
  assert.deepEqual(Object.keys(probe.observed).sort(), ["country", "forwardedOnUntrusted", "headerUsed", "socketIp", "viaProxy"]);
  assert.equal(probe.observed.viaProxy, true);
  assert.equal(probe.observed.headerUsed, "cf-connecting-ip");
  assert.deepEqual(Object.keys(probe.tls).sort(), ["authorized", "validTo"]);
  assert.equal(h.scanner.state.probes, 1);
  const audit = h.store.listAudit({ action: "exposure.probe" }).items;
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].details, { status: 200, nonceObserved: true, viaProxy: true, error: null });

  const lan = makeHarness({ config: makeConfig({ listeners: { public: { baseUrl: "" } } }) });
  const refused = await lan.call("POST", "/api/public/probe", { body: {} });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, "public_base_url_required");
  assert.equal(lan.scanner.state.probes, 0, "no probe without a base URL");
});

test("bans: create, list, remove; audited; loopback and the caller's own address are protected; events are published", async () => {
  const h = makeHarness();
  const created = await h.call("POST", "/api/security/bans", { body: { kind: "ip", subject: "203.0.113.50", reason: "scanner", expiresAt: new Date(h.fixture.clock.now + DAY).toISOString() } });
  assert.equal(created.status, 201);
  assert.equal(created.json.ban.subject, "203.0.113.50");
  assert.equal(created.json.ban.source, "admin");
  assert.equal(created.json.ban.active, true);
  const cidr = await h.call("POST", "/api/security/bans", { body: { kind: "cidr", subject: "198.51.100.0/24", reason: "range" } });
  assert.equal(cidr.status, 201);
  assert.equal(cidr.json.ban.expiresAt, null);
  const listed = await h.call("GET", "/api/security/bans");
  assert.deepEqual(listed.json.items.map((item) => item.subject).sort(), ["198.51.100.0/24", "203.0.113.50"]);

  for (const body of [{ kind: "ip", subject: "127.0.0.1", reason: "x" }, { kind: "cidr", subject: "0.0.0.0/0", reason: "x" }, { kind: "ip", subject: "not an ip", reason: "x" }, { kind: "nope", subject: "1.2.3.4", reason: "x" }]) {
    const refused = await h.call("POST", "/api/security/bans", { body });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.ok(refused.json.error.code, JSON.stringify(body));
  }
  const encoded = encodeURIComponent("198.51.100.0/24");
  const removed = await h.call("DELETE", `/api/security/bans/${encoded}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json, { ok: true, removed: true, subject: "198.51.100.0/24" });
  assert.equal((await h.call("DELETE", `/api/security/bans/${encoded}`)).json.error.code, "ban_not_found");

  const actions = h.store.listAudit({}).items.map((item) => item.action);
  assert.ok(actions.includes("ban.upsert") && actions.includes("ban.remove"));
  assert.deepEqual(h.published.map((event) => event.data.kind), ["ban", "ban", "unban"]);
  assert.ok(h.published.every((event) => event.type === "security"));
});

test("a ban covering the caller's own address is refused", async () => {
  const h = makeHarness();
  const self = await h.call("POST", "/api/security/bans", { body: { kind: "cidr", subject: "127.0.0.0/8", reason: "x" } });
  assert.equal(self.status, 400);
  assert.equal(self.json.error.code, "cannot_ban_self");
  const wide = await h.call("POST", "/api/security/bans", { body: { kind: "cidr", subject: "0.0.0.0/0", reason: "x" } });
  assert.equal(wide.json.error.code, "cannot_ban_self");
  const other = await h.call("POST", "/api/security/bans", { body: { kind: "cidr", subject: "192.168.2.0/24", reason: "x" } });
  assert.equal(other.status, 201);
  assert.deepEqual(h.published.map((event) => event.data.kind), ["ban"], "a refused ban publishes nothing");
});

// ---- security overview -------------------------------------------------------------------------------

test("anomaly rules: tpm_spike, new_country, auth_storm and direct_manager_calls with their thresholds", () => {
  const nowMs = NOW;
  const none = detectAnomalies({
    nowMs,
    keyHourly: [{ keyId: "k1", lastHourTokens: 49_999, hourlyP95: 1 }, { keyId: "k2", lastHourTokens: 100_000, hourlyP95: 20_000 }, { keyId: "k3", lastHourTokens: 60_000, hourlyP95: 12_000 }],
    newCountries: [{ keyId: "k1", country: "DE", lastSeenBefore: nowMs - 29 * DAY }],
    authFailures10m: 100,
    directManagerCalls: 0,
  });
  assert.deepEqual(none, [], "at 50k tokens, 5x p95 exactly, 29 days, 100 failures and no calls nothing fires");
  const fired = detectAnomalies({
    nowMs,
    keyHourly: [{ keyId: "k1", lastHourTokens: 50_000, hourlyP95: 9_999 }, { keyId: "k4", lastHourTokens: 80_000, hourlyP95: 0 }],
    newCountries: [{ keyId: "k1", country: "FR", lastSeenBefore: null }, { keyId: "k1", country: "JP", lastSeenBefore: nowMs - 31 * DAY }, { keyId: "k1", country: "xx", lastSeenBefore: null }],
    authFailures10m: 101,
    directManagerCalls: 3,
    names: { k1: "Alice" },
  });
  assert.deepEqual(fired.map((item) => item.rule), ["auth_storm", "direct_manager_calls", "new_country", "new_country", "tpm_spike", "tpm_spike"]);
  assert.equal(fired[0].severity, "critical");
  assert.equal(fired.find((item) => item.rule === "tpm_spike" && item.keyId === "k1").name, "Alice");
  assert.equal(fired.find((item) => item.rule === "tpm_spike" && item.keyId === "k4").detail.factor, null);
  assert.deepEqual(fired.filter((item) => item.rule === "new_country").map((item) => item.detail.country).sort(), ["FR", "JP"]);
});

test("GET /api/security/overview combines telemetry, bans, key counters, anomalies and the admin trail", async () => {
  const keyIdBox = {};
  const telemetry = {
    authFailures: async () => ({ series: [[NOW - 3600_000, 3], [NOW, 9]], topIps: [{ ip: "203.0.113.9", country: "DE", count: 40 }, { ip: "203.0.113.10", country: "US", count: 2 }] }),
    keyHourlyTokens: async () => [{ keyId: keyIdBox.id, lastHourTokens: 120_000, hourlyP95: 10_000 }],
    newCountries: async () => [{ keyId: keyIdBox.id, country: "FR", lastSeenBefore: null }],
    authFailures10m: async () => 250,
    directManagerCalls: async () => 4,
  };
  const h = makeHarness({ telemetry });
  const made = (await h.call("POST", "/api/access/keys", { body: { preset: "friend", name: "Alice laptop" } })).json;
  assert.equal(made.ok, true);
  keyIdBox.id = made.key.id;
  h.store.addUsage(made.key.id, { requests: 5, inputTokens: 1000, outputTokens: 500, at: new Date(h.fixture.clock.now) });
  h.store.upsertBan({ subject: "203.0.113.9", kind: "ip", reason: "noisy" }, { actor: "test" });

  const result = await h.call("GET", "/api/security/overview");
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const body = result.json;
  assert.equal(body.ok, true);
  assert.deepEqual(body.authFailures.series, [[NOW - 3600_000, 3], [NOW, 9]]);
  assert.deepEqual(body.authFailures.topIps.map((row) => [row.ip, row.country, row.count, row.banned]), [["203.0.113.9", "DE", 40, true], ["203.0.113.10", "US", 2, false]]);
  assert.deepEqual(body.bans.map((ban) => ban.subject), ["203.0.113.9"]);
  assert.deepEqual(body.topKeys, [{ keyId: made.key.id, name: "Alice laptop", requests: 5, tokens: 1500 }], "telemetry cannot answer, so the key counters do");
  assert.deepEqual(body.anomalies.map((item) => item.rule), ["auth_storm", "direct_manager_calls", "new_country", "tpm_spike"]);
  assert.ok(body.adminEvents.some((event) => event.action === "ban.upsert"));
  assert.equal(body.sources.authFailures, "telemetry");
  assert.equal(body.sources.topKeys, "counters");
  assert.equal(JSON.stringify(body).includes("sk-plat"), false);

  const range = await h.call("GET", `/api/security/overview?from=${encodeURIComponent("2026-10-15T00:00:00Z")}&to=${encodeURIComponent("2026-10-15T09:00:00Z")}`);
  assert.equal(range.json.from, "2026-10-15T00:00:00.000Z");
  for (const query of ["from=nope", "to=nope", "from=2026-10-16T00:00:00Z&to=2026-10-15T00:00:00Z", "from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z"]) {
    const bad = await h.call("GET", `/api/security/overview?${query}`);
    assert.equal(bad.status, 400, query);
    assert.equal(bad.json.error.code, "invalid_field", query);
  }
});

test("the overview works with no telemetry: empty series, counter fallback, ring-based anomaly", async () => {
  const ring = [{ id: "e1", type: "security", at: new Date(NOW - 3600_000).toISOString(), source: "entry", data: { kind: "direct_manager_gateway" } }];
  const h = makeHarness({ bus: { publish() {}, recent: () => ({ events: ring }) } });
  const body = (await h.call("GET", "/api/security/overview")).json;
  assert.deepEqual(body.authFailures, { available: false, series: [], topIps: [] });
  assert.deepEqual(body.topKeys, []);
  assert.deepEqual(body.anomalies.map((item) => item.rule), ["direct_manager_calls"]);
  assert.deepEqual([body.sources.authFailures, body.sources.anomalies], ["unavailable", "ring"]);
  const enforce = makeHarness({ config: makeConfig({ public: { managersGatewayOnly: "enforce" } }), bus: { publish() {}, recent: () => ({ events: ring }) } });
  assert.deepEqual((await enforce.call("GET", "/api/security/overview")).json.anomalies, [], "direct calls are an anomaly only in warn mode");
});

test("GET /api/security/events pages telemetry security events and falls back to the in-process ring", async () => {
  const seen = [];
  const telemetry = { events: async (query) => { seen.push(query); return { items: [{ id: 1, type: "security.ban", at: "2026-10-15T00:00:00.000Z" }], nextCursor: "c2" }; } };
  const h = makeHarness({ telemetry });
  const paged = await h.call("GET", "/api/security/events?type=ban&cursor=c1&limit=5");
  assert.equal(paged.status, 200);
  assert.deepEqual(paged.json, { ok: true, items: [{ id: 1, type: "security.ban", at: "2026-10-15T00:00:00.000Z" }], nextCursor: "c2", source: "telemetry" });
  assert.deepEqual(seen, [{ type: "security.ban", cursor: "c1", limit: 5 }]);
  assert.equal((await h.call("GET", "/api/security/events?type=bad%20type")).status, 400);
  assert.equal((await h.call("GET", "/api/security/events?limit=0")).status, 400);

  const events = [
    { id: "e1", type: "security", at: "2026-10-15T10:00:00.000Z", data: { kind: "admin_via_proxy" } },
    { id: "e2", type: "security", at: "2026-10-15T11:00:00.000Z", data: { kind: "ban", severity: "warning" } },
  ];
  const ring = makeHarness({ bus: { publish() {}, recent: () => ({ events }) } });
  const all = (await ring.call("GET", "/api/security/events")).json;
  assert.equal(all.source, "ring");
  assert.deepEqual(all.items.map((item) => item.type), ["security.ban", "security.admin_via_proxy"], "newest first");
  assert.deepEqual((await ring.call("GET", "/api/security/events?type=security.admin_via_proxy")).json.items.map((item) => item.id), ["e1"]);
  const failing = makeHarness({ telemetry: { events: async () => { throw new Error("down"); } }, bus: { publish() {}, recent: () => ({ events }) } });
  assert.equal((await failing.call("GET", "/api/security/events")).json.source, "ring", "a failing provider falls back");
});

test("signals feed the scan: keys and 24 h event counts from the ring, telemetry first", async () => {
  const events = [
    { id: "e1", type: "security", at: new Date(NOW - 2 * 3600_000).toISOString(), data: { kind: "admin_via_proxy" } },
    { id: "e2", type: "security", at: new Date(NOW - 3 * 3600_000).toISOString(), data: { kind: "admin_via_proxy" } },
    { id: "e3", type: "security", at: new Date(NOW - 30 * 3600_000).toISOString(), data: { kind: "admin_via_proxy" } },
    { id: "e4", type: "security", at: new Date(NOW - 3600_000).toISOString(), data: { kind: "direct_manager_gateway" } },
  ];
  const h = makeHarness();
  const make = (extra) => createSecurityOverview({ getStore: () => h.store, getBus: () => ({ recent: () => ({ events }) }), getConfig: () => makeConfig(), now: () => NOW, ...extra });
  await h.call("POST", "/api/access/keys", { body: { preset: "friend", name: "Alice laptop" } });
  const signals = await make({}).signals();
  assert.equal(signals.keys.length, 1);
  assert.equal(signals.adminViaProxy24h, 2, "events older than 24 h do not count");
  assert.equal(signals.directManagerCalls24h, 1);
  const withTelemetry = await make({ telemetry: { directManagerCalls: async () => 11, adminViaProxy: async () => 0 } }).signals();
  assert.deepEqual([withTelemetry.adminViaProxy24h, withTelemetry.directManagerCalls24h], [0, 11]);
  const noBus = await createSecurityOverview({ getStore: () => { throw new Error("closed"); }, getBus: () => null, now: () => NOW }).signals();
  assert.deepEqual(noBus, { keys: null, directManagerCalls24h: null, adminViaProxy24h: null });
});

// ---- mounted in the entry ----------------------------------------------------------------------------

test("mounted in the entry: the routes are registered admin-only, ctx carries the scanner, and /api/security maps the scan", async (t) => {
  const { entry } = await loadEntry();
  const fake = fakeScanner({
    cached: () => ({
      at: "2026-10-15T12:00:00.000Z",
      checks: [
        { id: "tunnel_target", state: "fail", title: "access.check.tunnel_target", evidence: "legacy_tunnel_bypasses_entry", fix: "access.fix.tunnel_target" },
        { id: "firewall_profiles", state: "ok", title: "access.check.firewall_profiles", evidence: "All 3 firewall profiles are enabled.", fix: "access.fix.firewall_profiles" },
        { id: "wildcard_listeners", state: "ok", title: "access.check.wildcard_listeners", evidence: "none", fix: "access.fix.wildcard_listeners" },
      ],
    }),
  });
  const ctx = entry.createRouteContext({ logger: quietLogger(), exposure: fake });
  assert.equal(ctx.exposure, fake);
  assert.equal(typeof ctx.securityOverview.overview, "function");
  const routes = await entry.mountRouteModules({ ctx });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const registry = ctx.auth.viewerRegistry;
  for (const [method, pathname] of [["POST", "/api/public/exposure/scan"], ["POST", "/api/public/probe"], ["POST", "/api/security/bans"], ["DELETE", "/api/security/bans/203.0.113.9"], ["GET", "/api/public/exposure"], ["GET", "/api/security/overview"], ["GET", "/api/security/events"], ["GET", "/api/security/bans"]]) {
    assert.equal(registry.match(method, pathname).access, "admin", `${method} ${pathname}`);
  }
  const port = await serveEntry(t, entry, routes);
  const anonymous = await request(port, "/api/public/exposure");
  assert.ok([401, 403].includes(anonymous.status), "a loopback viewer reads no exposure data");
  const posted = await request(port, "/api/public/exposure/scan", { method: "POST", body: {} });
  assert.ok([401, 403].includes(posted.status));
  assert.equal(fake.state.reports.length, 0, "nothing scanned for an unauthenticated caller");

  // The checklist of /api/security maps from the cached report (05 §13.1).
  const { ownerSession } = require("./helpers/entry-harness");
  const owner = await ownerSession(entry, port);
  const security = await request(port, "/api/security", { owner });
  const items = Object.fromEntries(security.json.security.publicChecklist.map((item) => [item.id, item]));
  assert.equal(items["proxy-target"].state, "fail");
  assert.equal(items["proxy-target"].detail, "legacy_tunnel_bypasses_entry");
  assert.equal(items.firewall.state, "ok");
  const report = await request(port, "/api/public/exposure", { owner });
  assert.equal(report.status, 200);
  assert.equal(report.json.ok, true);
  entry.security.setExposureReport(null);
});
