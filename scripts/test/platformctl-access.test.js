"use strict";

// The access commands of the `platform` CLI (06 §6.2, OPS-7c, 05 C7): admin
// pair, keys migrate and exposure scan, plus the pairing in open and start.
// A fake entry on an ephemeral port judges the machine signatures with 05's
// verifyMachineSignature; the exposure scan runs over 05's fixture probes.
// Nothing here touches the machine, Docker or a real service.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const { run, COMMANDS, PLANNED } = require("../platformctl.js");
const { verifyMachineSignature, bodySha256Hex } = require("../../manager-core/internal-auth");
const { createFakeDpapi } = require("../../manager-core/test/fixtures/secrets/fake-dpapi");

const crypto = require("node:crypto");

const KEY = "fixture-internal-key-0123456789abcdefghijklmnop";
const CODE = "ABCDEFGHJK";
const FIXTURES = path.join(ROOT, "service-entry", "test", "fixtures", "exposure-scan");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platformctl-access-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sink() {
  const chunks = [];
  return { write(text) { chunks.push(String(text)); return true; }, text: () => chunks.join(""), isTTY: false };
}

function allFileText(dir) {
  const parts = [];
  (function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else parts.push(fs.readFileSync(full, "latin1"));
    }
  })(dir);
  return parts.join("\n");
}

// A fake entry that signs nothing itself: it verifies the CLI's signature and
// answers pair-codes for system:cli only, like 05 PUB-5.
async function fakeEntry(t, { refuse = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const verified = verifyMachineSignature(req, KEY);
      const signed = verified.ok && verified.bodySha256 === bodySha256Hex(body.length ? body : undefined);
      const principal = signed ? verified.principal : null;
      seen.push({ method: req.method, url: req.url, principal, body: body.toString("utf8") });
      const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      if (!principal) return send(401, { ok: false, error: { code: "unauthorized" } });
      if (refuse) return send(403, { ok: false, error: { code: "lan_owner_disabled" } });
      if (req.method === "POST" && req.url === "/api/session/pair-codes") {
        const port = server.address().port;
        return send(200, { ok: true, code: CODE, url: `http://127.0.0.1:${port}/#pair=${CODE}`, expiresAt: "2026-10-14T08:02:00.000Z" });
      }
      if (req.method === "GET" && req.url === "/api/access/migration") {
        return send(200, { ok: true, report: { version: 1, at: "2026-10-14T08:00:00.000Z", complete: true, counts: { planned: 1, inserted: 1, skipped: 0, warnings: 0 }, keys: [{ keyId: "vllm.global", name: "Global key (vllm)", source: "service-exposure", warnings: [] }], skipped: [], warnings: [] } });
      }
      return send(404, { ok: false });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return { port: server.address().port, seen };
}

function makeWorld(t, { port = null } = {}) {
  const root = tempRoot(t);
  if (port) {
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(path.join(root, "config", "platform.json"), JSON.stringify({ listeners: { admin: { port } } }));
  }
  return {
    root,
    opened: [],
    async cli(argv, options = {}) {
      const stdout = sink();
      const stderr = sink();
      const code = await run(argv, {
        aiRoot: root,
        env: { PLATFORM_LANG: "en-US", ...(options.env || {}) },
        stdout,
        stderr,
        stdin: Readable.from([]),
        stdinIsTTY: false,
        dpapi: createFakeDpapi(),
        acl: { secure: async () => {} },
        listListeners: async () => [],
        fetch: (...args) => fetch(...args),
        internalReadKey: () => KEY,
        openUrl: async (url) => { this.opened.push(url); },
        ...options.ctx,
      });
      return { code, out: stdout.text(), err: stderr.text() };
    },
  };
}

test("the access commands are registered and no longer planned", () => {
  for (const name of ["admin", "keys", "exposure"]) {
    assert.ok(COMMANDS[name], `${name} is implemented`);
    assert.ok(!PLANNED[name], `${name} left PLANNED`);
  }
});

// ---- admin pair --------------------------------------------------------------

test("admin pair prints the #pair= URL to the terminal only, logs nothing and signs as system:cli", async (t) => {
  const entry = await fakeEntry(t);
  const world = makeWorld(t, { port: entry.port });
  const result = await world.cli(["admin", "pair", "--ttl", "90"]);
  assert.equal(result.code, 0);
  assert.equal(result.out, `http://127.0.0.1:${entry.port}/#pair=${CODE}\n`);
  assert.equal(result.err, "");
  assert.deepEqual(entry.seen.map((item) => [item.method, item.url, item.principal, JSON.parse(item.body)]), [
    ["POST", "/api/session/pair-codes", "system:cli", { ttlSeconds: 90 }],
  ]);
  assert.deepEqual(world.opened, []);
  assert.ok(!allFileText(world.root).includes(CODE), "the code is not written anywhere under the root");
});

test("admin pair --open opens the paired URL and does not print it", async (t) => {
  const entry = await fakeEntry(t);
  const world = makeWorld(t, { port: entry.port });
  const result = await world.cli(["admin", "pair", "--open"]);
  assert.equal(result.code, 0);
  assert.deepEqual(world.opened, [`http://127.0.0.1:${entry.port}/#pair=${CODE}`]);
  assert.ok(!result.out.includes(CODE) && !result.err.includes(CODE));
  assert.deepEqual(entry.seen.map((item) => JSON.parse(item.body)), [{ ttlSeconds: 120 }]);
});

test("admin pair exit codes: 4 entry down, 1 refused or no key, 2 bad ttl", async (t) => {
  const down = makeWorld(t, { port: 1 });
  const offline = await down.cli(["admin", "pair"]);
  assert.equal(offline.code, 4);
  assert.match(offline.err, /not answering/);

  const entry = await fakeEntry(t, { refuse: true });
  const refused = await makeWorld(t, { port: entry.port }).cli(["admin", "pair"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /lan_owner_disabled/);

  const open = await fakeEntry(t);
  const noKey = await makeWorld(t, { port: open.port }).cli(["admin", "pair"], { ctx: { internalReadKey: () => "" } });
  assert.equal(noKey.code, 1);
  assert.match(noKey.err, /no pairing link can be minted/);
  assert.match(noKey.err, /Run platform admin pair/);
  assert.deepEqual(open.seen, [], "no unsigned call is made");

  for (const bad of ["0", "601", "abc", "1.5"]) {
    const usage = await makeWorld(t, { port: open.port }).cli(["admin", "pair", "--ttl", bad]);
    assert.equal(usage.code, 2, `--ttl ${bad}`);
  }
  assert.equal((await makeWorld(t).cli(["admin", "nope"])).code, 2);
});

// ---- open and start ----------------------------------------------------------

test("open console and billing open the paired URL and never print it; without the key they open the plain URL with the hint", async (t) => {
  const entry = await fakeEntry(t);
  const world = makeWorld(t, { port: entry.port });
  const console_ = await world.cli(["open"]);
  assert.equal(console_.code, 0);
  assert.deepEqual(world.opened, [`http://127.0.0.1:${entry.port}/#pair=${CODE}`]);
  assert.ok(!console_.out.includes(CODE) && !console_.err.includes(CODE));
  assert.equal(console_.err, "");
  const billing = await world.cli(["open", "billing"]);
  assert.equal(billing.code, 0);
  assert.equal(world.opened.length, 2);
  assert.ok(world.opened[1].includes(`#pair=${CODE}`));

  const plain = makeWorld(t, { port: entry.port });
  const result = await plain.cli(["open"], { ctx: { internalReadKey: () => "" } });
  assert.equal(result.code, 0);
  assert.deepEqual(plain.opened, [`http://127.0.0.1:${entry.port}/`]);
  assert.match(result.err, /Run platform admin pair in a terminal on this machine/);

  const printed = await world.cli(["open", "--print"]);
  assert.equal(printed.out, `http://127.0.0.1:${entry.port}/\n`);
  assert.equal(world.opened.length, 2, "--print mints no code");
});

test("open vllm stays a plain URL and calls no entry", async (t) => {
  const entry = await fakeEntry(t);
  const world = makeWorld(t, { port: entry.port });
  const result = await world.cli(["open", "vllm"]);
  assert.equal(result.code, 0);
  assert.ok(!world.opened[0].includes("#pair="));
  assert.deepEqual(entry.seen, []);
});

// ---- keys migrate ------------------------------------------------------------

function writeLegacy(root) {
  const logs = path.join(root, "vllm-manager", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const secret = "sk-fixture-legacy-secret-0000000000000000";
  fs.writeFileSync(path.join(logs, "service-exposure-settings.json"), JSON.stringify({ apiKey: secret, apiKeyPreview: "sk-fi…0000" }));
  fs.writeFileSync(path.join(logs, "service-clients.json"), JSON.stringify([
    { id: "friend-a", name: "Friend A", keyHash: crypto.createHash("sha256").update("sk-fixture-legacy-client-1111111111111111").digest("hex"), keyPreview: "fa…1234", enabled: true },
  ]));
  return secret;
}

test("keys migrate --dry-run prints planner rows with previews only, never a hash or a key", async (t) => {
  const world = makeWorld(t);
  const secret = writeLegacy(world.root);
  for (const argv of [["keys", "migrate"], ["keys", "migrate", "--dry-run"], ["keys", "migrate", "--dry-run", "--json"]]) {
    const result = await world.cli(argv);
    assert.equal(result.code, 0, argv.join(" "));
    const text = result.out + result.err;
    assert.match(text, /vllm\.global/);
    assert.match(text, /vllm\.friend-a/);
    assert.match(text, /sk-fi…0000/);
    assert.ok(!text.includes(secret), "no plaintext key");
    assert.ok(!/[0-9a-f]{32,}/i.test(text), "no hash");
  }
  const json = JSON.parse((await world.cli(["keys", "migrate", "--json"])).out);
  assert.equal(json.dryRun, true);
  assert.ok(!JSON.stringify(json).match(/"[A-Za-z]*hash[A-Za-z]*"\s*:/i), "no hash field in the JSON");
  assert.deepEqual(json.inserts.map((row) => row.keyId).sort(), ["vllm.friend-a", "vllm.global"]);
  assert.ok(!allFileText(world.root).includes("migration"), "nothing is written (no store, no report)");
});

test("keys migrate with no legacy files says so; --dry-run and --report conflict", async (t) => {
  const world = makeWorld(t);
  const none = await world.cli(["keys", "migrate"]);
  assert.equal(none.code, 0);
  assert.match(none.out, /No legacy keys to migrate/);
  assert.equal((await world.cli(["keys", "migrate", "--dry-run", "--report"])).code, 2);
  assert.equal((await world.cli(["keys", "apply"])).code, 2);
});

test("keys migrate --report reads the entry's report signed as system:cli", async (t) => {
  const entry = await fakeEntry(t);
  const world = makeWorld(t, { port: entry.port });
  const result = await world.cli(["keys", "migrate", "--report"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /1 imported, 0 skipped/);
  assert.match(result.out, /vllm\.global/);
  assert.deepEqual(entry.seen.map((item) => [item.method, item.url, item.principal]), [["GET", "/api/access/migration", "system:cli"]]);
  const json = JSON.parse((await world.cli(["keys", "migrate", "--report", "--json"])).out);
  assert.equal(json.report.counts.inserted, 1);
});

// ---- exposure scan -----------------------------------------------------------

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function fakeExec(answers) {
  return async (file, args) => {
    let key = `other:${file}`;
    if (file === "powershell.exe") {
      const script = String(args[3] || "");
      if (script.startsWith("Get-NetTCPConnection")) key = "listeners";
      else if (script.startsWith("Get-CimInstance")) key = "processes";
      else if (script.startsWith("Get-NetFirewallProfile")) key = "firewall";
    } else if (file === "netsh") key = "portproxy";
    else if (file === "docker") key = "docker";
    if (answers[key] === undefined) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    return { stdout: answers[key] };
  };
}

const BAD = () => ({
  listeners: fixture("listeners.json"),
  processes: fixture("processes.json"),
  firewall: fixture("firewall.json"),
  portproxy: fixture("portproxy.txt"),
  docker: fixture("docker-ps.lines.txt"),
});

const scanOptions = (answers, extra = {}) => ({
  exec: fakeExec(answers),
  fetch: async () => ({ status: 200, body: { cancel: async () => {} } }),
  lookup: async () => [{ address: "203.0.113.7", family: 4 }],
  platform: "win32",
  signals: {},
  timeoutMs: 2000,
  ...extra,
});

test("exposure scan --json returns 05's report shape from fixture probes and exits 1 on a fail", async (t) => {
  const world = makeWorld(t);
  const result = await world.cli(["exposure", "scan", "--json"], { ctx: { exposureOptions: scanOptions(BAD()) } });
  const report = JSON.parse(result.out);
  assert.deepEqual(Object.keys(report).slice(0, 5), ["at", "status", "platform", "summary", "checks"]);
  for (const key of ["checks", "legacy", "map", "probe"]) assert.ok(key in report, `report.${key}`);
  assert.ok(report.checks.length >= 5);
  for (const check of report.checks) {
    assert.match(check.state, /^(ok|warn|fail|unknown|manual)$/);
    assert.equal(check.title, `access.check.${check.id}`);
    assert.equal(check.fix, `access.fix.${check.id}`);
  }
  assert.ok(report.checks.some((check) => check.state === "fail"), "the bad machine has a fail");
  assert.equal(result.code, 1);

  const text = await world.cli(["exposure", "scan"], { ctx: { exposureOptions: scanOptions(BAD()) } });
  assert.equal(text.code, 1);
  assert.match(text.out, /\bfail\b/);
  assert.match(text.out, /Exposure scan/);
});

test("exposure scan exits 0 when nothing fails (an unsupported platform reports unknown checks)", async (t) => {
  const world = makeWorld(t);
  const result = await world.cli(["exposure", "scan", "--json"], { ctx: { exposureOptions: scanOptions({}, { platform: "linux" }) } });
  assert.equal(result.code, 0);
  assert.ok(!JSON.parse(result.out).checks.some((check) => check.state === "fail"));
  assert.equal((await world.cli(["exposure", "nope"])).code, 2);
  assert.equal((await world.cli(["exposure", "setup"])).code, 1);
});
