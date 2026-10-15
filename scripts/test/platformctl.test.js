"use strict";

// The `platform` CLI (06 §6, OPS-7a): framework, exit codes and the read
// commands, run in-process against temp roots with a fake DPAPI, a fake
// control server on a unique pipe, injected fetch / netstat / clipboard /
// browser, and no real service, Docker or user data.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "scripts", "platformctl.js");
const { run, EXIT, COMMANDS, PLANNED } = require("../platformctl.js");
const { createFakeDpapi } = require("../../manager-core/test/fixtures/secrets/fake-dpapi");
const { createSecretStore } = require("../../manager-core/secret-store");
const control = require("../../manager-core/platform/control");
const logsApi = require("../../manager-core/platform/logs");
const { hashBuildInputs } = require("../../manager-core/platform/doctor-probes");

const FAKE_KEY = "fixture-platform-mcp-key-00000000000000000001";
const GOLDEN = path.join(ROOT, "manager-core", "test", "fixtures", "platform", "status-supervised.json");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platformctl-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sink() {
  const chunks = [];
  return { write(text) { chunks.push(String(text)); return true; }, text: () => chunks.join(""), isTTY: false };
}

// Every dependency of the CLI is injected, so nothing here touches the machine.
function makeWorld(t, extra = {}) {
  const root = extra.root || tempRoot(t);
  return {
    root,
    dpapi: extra.dpapi || createFakeDpapi(),
    clipboard: [],
    opened: [],
    async cli(argv, options = {}) {
      const stdout = sink();
      const stderr = sink();
      const code = await run(argv, {
        aiRoot: root,
        env: { PLATFORM_LANG: "en-US", ...(options.env || {}) },
        stdout,
        stderr,
        stdin: options.stdin || Readable.from([]),
        stdinIsTTY: options.tty === true,
        dpapi: this.dpapi,
        acl: { secure: async () => {} },
        listListeners: async () => [],
        fetch: async () => { throw new Error("offline"); },
        execFile: (file, args, opts, callback) => (typeof opts === "function" ? opts : callback)(new Error("not found")),
        openUrl: async (url) => { this.opened.push(url); },
        clipboard: async (value) => { this.clipboard.push(value); },
        ...options.ctx,
      });
      return { code, out: stdout.text(), err: stderr.text() };
    },
  };
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

async function waitFor(predicate, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(message);
}

// ---------------------------------------------------------------------------
// Framework

test("exit codes: usage errors are 2, a bare call prints help, planned commands answer 1", async (t) => {
  const world = makeWorld(t);
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.FAILURE, 1);
  assert.equal(EXIT.USAGE, 2);
  assert.equal(EXIT.BUSY, 3);
  assert.equal(EXIT.SUPERVISOR_UNAVAILABLE, 4);
  assert.equal(EXIT.PREFLIGHT, 5);
  assert.equal(EXIT.NODE_MISSING, 9009);

  const unknown = await world.cli(["frobnicate"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Unknown command "frobnicate"/);

  const option = await world.cli(["version", "--nope"]);
  assert.equal(option.code, 2);
  assert.match(option.err, /does not accept the option --nope/);

  const missing = await world.cli(["logs", "entry", "--tail"]);
  assert.equal(missing.code, 2);

  const bare = await world.cli([]);
  assert.equal(bare.code, 2);
  assert.match(bare.out, /Usage/);

  const planned = await world.cli(["update", "--check"]);
  assert.equal(planned.code, 1);
  assert.match(planned.err, /not available in this build yet/);
  for (const name of Object.keys(PLANNED)) assert.ok(!COMMANDS[name], `${name} is planned, not implemented`);
});

test("--help is bilingual whatever the language, and --lang picks the message language", async (t) => {
  const world = makeWorld(t);
  for (const lang of ["zh", "en"]) {
    const help = await world.cli(["--help", "--lang", lang]);
    assert.equal(help.code, 0);
    assert.match(help.out, /本地 AI 模型服务平台命令行/);
    assert.match(help.out, /command line of the local AI model-serving platform/);
    assert.match(help.out, /状态/);
    assert.match(help.out, /Show component state/);
    for (const name of [...Object.keys(COMMANDS), ...Object.keys(PLANNED)]) assert.ok(help.out.includes(name), `help lists ${name}`);
  }
  const one = await world.cli(["status", "--help"]);
  assert.match(one.out, /显示组件状态和就绪层级/);
  assert.match(one.out, /Show component state and readiness layers/);

  assert.match((await world.cli(["frobnicate", "--lang", "zh"])).err, /未知命令/);
  assert.match((await world.cli(["frobnicate", "--lang=en"])).err, /Unknown command/);
  assert.match((await world.cli(["frobnicate"], { env: { PLATFORM_LANG: "zh-CN" } })).err, /未知命令/);
});

test("platform.cmd is the spec shim: CRLF everywhere, no BOM, ASCII, calls platformctl.js; the manifest ships it", () => {
  const bytes = fs.readFileSync(path.join(ROOT, "platform.cmd"));
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "no BOM");
  assert.ok(bytes.every((byte) => byte < 0x80), "ASCII only");
  const text = bytes.toString("latin1");
  assert.equal(text.replace(/\r\n/g, "").includes("\n"), false, "no bare LF");
  assert.equal(text.replace(/\r\n/g, "").includes("\r"), false, "no bare CR");
  assert.ok(text.endsWith("\r\n"));
  assert.match(text, /^@echo off\r\nsetlocal\r\n/);
  assert.match(text, /scripts\\platformctl\.js" %\*/);
  assert.match(text, /exit \/b 9009/);
  assert.match(text, /exit \/b %ERRORLEVEL%/);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "release-manifest.json"), "utf8"));
  assert.ok(manifest.files.includes("platform.cmd"));
});

test("run as a process: --json is one document on stdout, and the exit code is the process exit code", (t) => {
  const root = tempRoot(t);
  const env = { ...process.env, AI_ROOT: root, PLATFORM_LANG: "en-US" };
  const version = spawnSync(process.execPath, [CLI, "version", "--json"], { env, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  const parsed = JSON.parse(version.stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.node, process.version);
  const unknown = spawnSync(process.execPath, [CLI, "nope"], { env, encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
});

// ---------------------------------------------------------------------------
// status

test("status without a supervisor probes: listeners and readiness URLs, exit 1 while the core is not up", async (t) => {
  const world = makeWorld(t);
  const ctx = {
    listListeners: async () => [{ protocol: "tcp", port: 5176, pid: 4242, address: "127.0.0.1" }],
    fetch: async (url) => {
      if (String(url).endsWith("/gateway/health")) return { ok: true, status: 200, text: async () => JSON.stringify({ service: "local-ai-gateway" }) };
      throw new Error("offline");
    },
  };
  const json = await world.cli(["status", "--json"], { ctx });
  const status = JSON.parse(json.out);
  assert.equal(status.mode, "probe");
  assert.equal(status.supervisor.running, false);
  const entry = status.components.find((row) => row.id === "entry");
  assert.equal(entry.state, "ready");
  assert.equal(entry.pid, 4242);
  assert.equal(status.components.find((row) => row.id === "vllm-manager").state, "stopped");
  assert.equal(status.readiness.overall, "degraded");
  assert.equal(json.code, 1, "not every core component is ready");
  assert.equal(json.err, "", "--json keeps stderr quiet");

  const only = await world.cli(["status", "entry", "--json"], { ctx });
  assert.equal(only.code, 0, "the selected component is ready");
  assert.deepEqual(JSON.parse(only.out).components.map((row) => row.id), ["entry"]);

  const human = await world.cli(["status"], { ctx });
  assert.equal(human.code, 1);
  assert.match(human.out, /Platform status · no supervisor \(probe only\)/);
  assert.match(human.out, /entry\s+ready\s+4242\s+5176/);
  assert.match(human.out, /\[ok\]\s+Environment|\[warn\]\s+Components/);

  const zh = await world.cli(["status", "--lang", "zh"], { ctx });
  assert.match(zh.out, /平台状态/);

  const unknown = await world.cli(["status", "nope"], { ctx });
  assert.equal(unknown.code, 2);
  assert.equal((await world.cli(["status", "--watch", "--json"], { ctx })).code, 2);
});

test("status over the control pipe returns the supervisor's PlatformStatus unchanged (golden)", async (t) => {
  const world = makeWorld(t);
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  const token = control.createControlToken();
  await createSecretStore({ aiRoot: world.root, namespace: "platform-control", dpapi: world.dpapi }).set("token", token);
  const server = await control.startControlServer({
    endpoint: control.controlEndpoint(world.root),
    token,
    supervisor: { async status() { return golden; } },
  });
  t.after(() => server.close());
  const result = await world.cli(["status", "--json"]);
  assert.deepEqual(JSON.parse(result.out), golden);
  assert.equal(result.code, golden.readiness.layers.find((layer) => layer.id === "components").status === "ok" ? 0 : 1);
  const human = await world.cli(["status"]);
  assert.match(human.out, /supervised/);
  assert.match(human.out, /service-entry-public/);
});

test("status --watch refreshes until stopped", async (t) => {
  const world = makeWorld(t);
  let sleeps = 0;
  const result = await world.cli(["status", "--watch"], { ctx: { watchLimit: 2, sleep: async () => { sleeps += 1; } } });
  assert.equal(sleeps, 1);
  assert.equal((result.out.match(/Platform status/g) || []).length, 2);
});

// ---------------------------------------------------------------------------
// logs

function writeLog(world, id, stream, text) {
  const file = path.join(world.root, "logs", id, `${id}.${stream}.log`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test("logs reads the files directly, tails, selects streams and redacts store values and key patterns", async (t) => {
  const world = makeWorld(t);
  const secret = "fixture-stored-token-00000000000000000007";
  const pattern = "sk-fixtureplanted0000000000000000000000000001";
  assert.equal((await world.cli(["secrets", "set", "hf.token"], { stdin: Readable.from([`${secret}\n`]) })).code, 0);
  writeLog(world, "entry", "out", ["one", `token is ${secret}`, `key ${pattern}`, "four"].join("\n") + "\n");
  writeLog(world, "entry", "err", "boom\n");

  const all = await world.cli(["logs", "entry"]);
  assert.equal(all.code, 0);
  assert.ok(!all.out.includes(secret) && !all.out.includes(pattern), "both are redacted");
  assert.match(all.out, /<redacted>/);
  assert.match(all.out, /^one$/m);
  assert.match(all.out, /^\[err\] boom$/m, "err lines carry a prefix when both streams show");

  const tail = await world.cli(["logs", "entry", "--out", "--tail", "2"]);
  assert.equal(tail.out.trim().split("\n").length, 2);
  assert.match(tail.out, /four/);
  assert.ok(!tail.out.includes("boom"));
  assert.equal((await world.cli(["logs", "entry", "--err"])).out.trim(), "boom");

  const legacyDir = path.join(world.root, "vllm-manager", "logs");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "manager.out.log"), "old manager line\n");
  assert.match((await world.cli(["logs", "vllm-manager", "--legacy"])).out, /old manager line/);

  const missing = await world.cli(["logs", "tts-gateway"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /No log file yet/);
  assert.equal((await world.cli(["logs", "nope"])).code, 2);
  assert.equal((await world.cli(["logs", "entry", "--tail", "0"])).code, 2);
  assert.equal((await world.cli(["logs", "entry", "--since", "yesterday"])).code, 2);
  assert.equal((await world.cli(["logs"])).code, 2);
});

test("logs --since keeps timestamped lines in the window and reads into the rotated file for --tail", async (t) => {
  const world = makeWorld(t);
  const now = Date.parse("2026-10-14T12:00:00Z");
  const lines = [
    "2026-10-14T09:00:00Z too old",
    "    continuation of the old line",
    "2026-10-14T11:55:00Z recent",
    "2026-10-14T11:59:30Z newest",
  ];
  const file = writeLog(world, "entry", "out", `${lines.join("\n")}\n`);
  fs.utimesSync(file, new Date(now), new Date(now));
  const since = await world.cli(["logs", "entry", "--out", "--since", "10m"], { ctx: { now: () => now } });
  assert.deepEqual(since.out.trim().split("\n"), ["2026-10-14T11:55:00Z recent", "2026-10-14T11:59:30Z newest"]);

  const rotated = writeLog(world, "tts-gateway", "out", "a1\na2\na3\n");
  logsApi.maybeCopyTruncate(rotated, 1);
  fs.appendFileSync(rotated, "b1\n");
  const merged = await world.cli(["logs", "tts-gateway", "--out", "--tail", "3"]);
  assert.deepEqual(merged.out.trim().split("\n"), ["a2", "a3", "b1"]);
});

test("logs -f follows across a copy-truncate rotation and ends on the abort signal", async (t) => {
  const world = makeWorld(t);
  const file = writeLog(world, "entry", "out", `${"x".repeat(300)}\nfirst\n`);
  const controller = new AbortController();
  const stdout = sink();
  const finished = run(["logs", "entry", "--out", "-f", "--tail", "1"], {
    aiRoot: world.root, env: { PLATFORM_LANG: "en-US" }, stdout, stderr: sink(), stdin: Readable.from([]), dpapi: world.dpapi,
    acl: { secure: async () => {} }, signal: controller.signal, followIntervalMs: 20,
  });
  await waitFor(() => stdout.text().includes("first"), "the tail line shows first");
  fs.appendFileSync(file, "second\n");
  await waitFor(() => stdout.text().includes("second"), "a new line is followed");
  assert.equal(logsApi.maybeCopyTruncate(file, 10), true, "rotated in place");
  fs.appendFileSync(file, "third\n");
  await waitFor(() => stdout.text().includes("third"), "the follower reopens after the file shrank");
  controller.abort();
  assert.equal(await finished, 0);
  assert.ok(fs.existsSync(path.join(path.dirname(file), "entry.out.1.log")));
});

// ---------------------------------------------------------------------------
// version

test("version reports version.json, the build id, packages, drift and update state", async (t) => {
  const world = makeWorld(t);
  fs.writeFileSync(path.join(world.root, "version.json"), JSON.stringify({
    schemaVersion: 1, commit: "c0146a7d2f1e".padEnd(40, "0"), shortCommit: "c0146a7d2f1e", branch: "feature/x", version: "0.2.0-git-c0146a7d2f1e", deployedAt: "2026-10-14T00:00:00Z",
  }));
  fs.mkdirSync(path.join(world.root, "vllm-manager"), { recursive: true });
  fs.writeFileSync(path.join(world.root, "vllm-manager", "package.json"), JSON.stringify({ name: "vllm-manager", version: "1.2.3" }));
  const result = await world.cli(["version", "--json"]);
  assert.equal(result.code, 0);
  const info = JSON.parse(result.out);
  assert.equal(info.version.source, "version.json");
  assert.equal(info.version.shortCommit, "c0146a7d2f1e");
  assert.equal(info.node, process.version);
  assert.ok(info.packages.some((pkg) => pkg.dir === "vllm-manager" && pkg.version === "1.2.3"));
  assert.match(info.runtimeManifest.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(info.drift.count, 0);
  assert.equal(info.newerCommits.available, false);
  assert.equal(info.newerCommits.error.code, "repo_missing");
  assert.ok(info.build);

  const human = await world.cli(["version"]);
  assert.match(human.out, /0\.2\.0-git-c0146a7d2f1e \(version\.json\)/);
  assert.match(human.out, /vllm-manager 1\.2\.3/);
});

// ---------------------------------------------------------------------------
// open

test("open launches the plain host-relative URL from config", async (t) => {
  const world = makeWorld(t);
  assert.equal((await world.cli(["open"])).code, 0);
  assert.equal((await world.cli(["open", "billing"])).code, 0);
  assert.equal((await world.cli(["open", "vllm"])).code, 0);
  assert.equal((await world.cli(["open", "llama"])).code, 0);
  assert.equal((await world.cli(["open", "tts"])).code, 0);
  assert.deepEqual(world.opened, [
    "http://127.0.0.1:5176/", "http://127.0.0.1:5176/billing", "http://127.0.0.1:5177/", "http://127.0.0.1:5178/", "http://127.0.0.1:7000/",
  ]);
  assert.ok(world.opened.every((url) => !url.includes("pair")), "no pairing code in the plain URL");

  assert.equal((await world.cli(["config", "set", "listeners.admin.port", "5999"])).code, 0);
  world.opened.length = 0;
  assert.match((await world.cli(["open", "console"])).out, /Opened http:\/\/127\.0\.0\.1:5999\//);
  assert.deepEqual(world.opened, ["http://127.0.0.1:5999/"]);

  const printed = await world.cli(["open", "billing", "--print"]);
  assert.equal(printed.out.trim(), "http://127.0.0.1:5999/billing");
  assert.equal(world.opened.length, 1, "--print opens nothing");

  assert.equal((await world.cli(["open", "nowhere"])).code, 2);
  const broken = await world.cli(["open"], { ctx: { openUrl: async () => { throw new Error("no shell"); } } });
  assert.equal(broken.code, 1);
  assert.match(broken.err, /http:\/\/127\.0\.0\.1:5999\//);
});

// ---------------------------------------------------------------------------
// config

test("config list/get/set/unset/validate/path/init work through the only writer", async (t) => {
  const world = makeWorld(t);
  const file = (await world.cli(["config", "path"])).out.trim();
  assert.equal(file, path.join(world.root, "config", "platform.json"));

  const init = await world.cli(["config", "init"]);
  assert.equal(init.code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { schemaVersion: 1 });
  assert.match((await world.cli(["config", "init"])).out, /already exists/);

  const set = await world.cli(["config", "set", "listeners.admin.port", "5999"]);
  assert.equal(set.code, 0);
  assert.match(set.out, /Saved: listeners\.admin\.port/);
  assert.match(set.out, /Restart required: .*entry/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).listeners.admin.port, 5999, "typed by schema");
  assert.equal((await world.cli(["config", "get", "listeners.admin.port"])).out.trim(), "5999");
  const got = JSON.parse((await world.cli(["config", "get", "listeners.admin.port", "--json"])).out);
  assert.deepEqual([got.value, got.source], [5999, "file"]);

  assert.equal((await world.cli(["config", "set", "cli.openBrowser", "off"])).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).cli.openBrowser, false);
  assert.equal((await world.cli(["config", "set", "trustedProxies.cidrs", "10.0.0.0/8, 192.168.0.0/16"])).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).trustedProxies.cidrs, ["10.0.0.0/8", "192.168.0.0/16"]);

  const bad = await world.cli(["config", "set", "listeners.admin.port", "abc"]);
  assert.equal(bad.code, 2);
  const range = await world.cli(["config", "set", "listeners.admin.port", "99999"]);
  assert.equal(range.code, 1, "the schema rejects an out-of-range port");
  assert.equal((await world.cli(["config", "get", "no.such.key"])).code, 2);
  const unknownSet = await world.cli(["config", "set", "no.such.key", "1"]);
  assert.equal(unknownSet.code, 1);

  const insecure = await world.cli(["config", "set", "listeners.admin.lan", "true"]);
  assert.equal(insecure.code, 0);
  const combo = await world.cli(["config", "set", "exposure.requireApiKey", "off"]);
  assert.equal(combo.code, 1, "cross-field rules are enforced");
  assert.match(combo.err, /insecure_combination|LAN access/);

  assert.equal((await world.cli(["config", "unset", "listeners.admin.port"])).code, 0);
  assert.equal((await world.cli(["config", "get", "listeners.admin.port"])).out.trim(), "5176");

  const valid = await world.cli(["config", "validate"]);
  assert.equal(valid.code, 0);
  fs.writeFileSync(file, "{ not json");
  const invalid = await world.cli(["config", "validate"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.err, /problems/);

  const list = await world.cli(["config", "list"]);
  assert.match(list.out, /listeners\.admin\.port = /);
  assert.equal((await world.cli(["config", "wat"])).code, 2);
  assert.equal((await world.cli(["config", "import-env", "extra"])).code, 2, "import-env takes no positional argument");
});

test("config refuses secret keys and never shows a stored secret", async (t) => {
  const world = makeWorld(t);
  const refused = await world.cli(["config", "set", "platformMcp.apiKey", "should-not-land-anywhere-0001"]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /platform secrets set platformMcp\.apiKey/);
  assert.ok(!fs.existsSync(path.join(world.root, "config", "platform.json")), "nothing was written");
  assert.ok(!allFileText(world.root).includes("should-not-land-anywhere-0001"));

  assert.equal((await world.cli(["config", "unset", "platformMcp.apiKey"])).code, 2, "secret leaves go through the store, for unset too");
  assert.equal((await world.cli(["secrets", "set", "platformMcp.apiKey"], { stdin: Readable.from([`${FAKE_KEY}\n`]) })).code, 0);
  for (const argv of [["config", "list"], ["config", "list", "--json"], ["config", "get", "platformMcp.apiKey"], ["config", "get", "platformMcp.apiKey", "--json"]]) {
    const result = await world.cli(argv);
    assert.equal(result.code, 0, argv.join(" "));
    assert.ok(!result.out.includes(FAKE_KEY) && !result.err.includes(FAKE_KEY), `${argv.join(" ")} hides the value`);
  }
  assert.match((await world.cli(["config", "get", "platformMcp.apiKey"])).out, /\(set\)/);
});

// ---------------------------------------------------------------------------
// deps

test("deps reports lockfile, node_modules and MCP build state from a temp root", async (t) => {
  const world = makeWorld(t);
  const empty = await world.cli(["deps", "--json"]);
  assert.equal(empty.code, 1);
  assert.ok(JSON.parse(empty.out).packages.filter((row) => row.live).every((row) => row.status === "missing"));

  const registry = require("../../manager-core/platform/components").loadComponentRegistry({ aiRoot: world.root, config: null });
  const state = {};
  for (const pkg of registry.packages.filter((item) => item.live)) {
    const dir = path.join(world.root, pkg.dir);
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {} } });
    fs.writeFileSync(path.join(dir, "package-lock.json"), lock);
    state[pkg.dir] = { lockSha256: crypto.createHash("sha256").update(lock).digest("hex"), installedAt: "2026-10-14T00:00:00Z", node: process.version };
    if (pkg.build) {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "index.ts"), "export {};\n");
      fs.mkdirSync(path.join(dir, "dist", "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "dist", "src", "index.js"), "");
      fs.writeFileSync(path.join(dir, pkg.build.stamp), JSON.stringify({ srcSha256: hashBuildInputs(dir, pkg.build.inputs), builtAt: "2026-10-14T00:00:00Z" }));
    }
  }
  fs.mkdirSync(path.join(world.root, ".runtime", "platform"), { recursive: true });
  fs.writeFileSync(path.join(world.root, ".runtime", "platform", "deps-state.json"), JSON.stringify(state));

  const ok = await world.cli(["deps", "--json"]);
  const report = JSON.parse(ok.out);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(report.ok, true);
  assert.ok(report.packages.filter((row) => row.live).every((row) => row.status === "ok"));
  assert.equal(report.mcp.status, "ok");
  assert.match((await world.cli(["deps"])).out, /vllm-manager\s+ok/);

  fs.appendFileSync(path.join(world.root, "llama-manager", "package-lock.json"), " ");
  fs.appendFileSync(path.join(world.root, "platform-mcp", "src", "index.ts"), "// changed\n");
  const stale = await world.cli(["deps", "--json"]);
  assert.equal(stale.code, 1);
  const rows = JSON.parse(stale.out);
  assert.equal(rows.packages.find((row) => row.package === "llama-manager").status, "stale");
  assert.equal(rows.mcp.status, "stale");

  assert.equal((await world.cli(["deps", "--record"])).code, 1, "--record arrives with post-deploy");
});

// ---------------------------------------------------------------------------
// secrets

test("secrets set/list/clear/copy work against a fake DPAPI and never print or store a value", async (t) => {
  const world = makeWorld(t);
  const empty = await world.cli(["secrets", "list"]);
  assert.equal(empty.code, 0);
  assert.match(empty.out, /empty/);

  const set = await world.cli(["secrets", "set", "platformMcp.apiKey"], { stdin: Readable.from([`${FAKE_KEY}\r\n`]) });
  assert.equal(set.code, 0);
  assert.match(set.out, /Saved platformMcp\.apiKey/);
  assert.ok(!set.out.includes(FAKE_KEY) && !set.err.includes(FAKE_KEY));
  assert.ok(!allFileText(world.root).includes(FAKE_KEY), "only a DPAPI blob is on disk");

  const raw = await world.cli(["secrets", "set", "runtime.vllm/ref-0001"], { stdin: Readable.from(["raw-secret-value-000000000000000002"]) });
  assert.equal(raw.code, 0);

  const list = await world.cli(["secrets", "list"]);
  assert.match(list.out, /platform\s+platformMcp\.apiKey\s+dpapi-user/);
  assert.match(list.out, /runtime\.vllm\s+ref-0001/);
  const listed = JSON.parse((await world.cli(["secrets", "list", "--json"])).out);
  assert.equal(listed.secrets.length, 2);
  assert.ok(!JSON.stringify(listed).includes(FAKE_KEY));
  assert.ok(!list.out.includes("raw-secret-value"));

  const copy = await world.cli(["secrets", "copy", "platformMcp.apiKey"]);
  assert.equal(copy.code, 0);
  assert.deepEqual(world.clipboard, [FAKE_KEY], "the value only goes to the clipboard");
  assert.ok(!copy.out.includes(FAKE_KEY) && !copy.err.includes(FAKE_KEY), "copy never prints");
  const failedCopy = await world.cli(["secrets", "copy", "platformMcp.apiKey"], { ctx: { clipboard: async () => { throw new Error(FAKE_KEY); } } });
  assert.equal(failedCopy.code, 1);
  assert.ok(!failedCopy.err.includes(FAKE_KEY), "even a failing clipboard cannot leak it");

  const cleared = await world.cli(["secrets", "clear", "platformMcp.apiKey"]);
  assert.equal(cleared.code, 0);
  assert.equal((await world.cli(["secrets", "copy", "platformMcp.apiKey"])).code, 1);
  assert.ok(!(await world.cli(["secrets", "list"])).out.includes("platformMcp.apiKey"));
});

test("secrets set takes the value from stdin or a prompt, never argv", async (t) => {
  const world = makeWorld(t);
  const argv = await world.cli(["secrets", "set", "platformMcp.apiKey", FAKE_KEY]);
  assert.equal(argv.code, 2);
  assert.ok(!argv.err.includes(FAKE_KEY));
  assert.equal((await world.cli(["secrets", "set", "platformMcp.apiKey"], { stdin: Readable.from(["\n"]) })).code, 2, "empty input");
  assert.equal((await world.cli(["secrets", "set", "not.a.secret"], { stdin: Readable.from(["x\n"]) })).code, 2);
  assert.equal((await world.cli(["secrets", "set", "bad key"], { stdin: Readable.from(["x\n"]) })).code, 2);
  const prompted = await world.cli(["secrets", "set", "platformMcp.apiKey"], { tty: true, ctx: { readSecret: async () => FAKE_KEY } });
  assert.equal(prompted.code, 0);
  assert.equal(await createSecretStore({ aiRoot: world.root, namespace: "platform", dpapi: world.dpapi }).get("platformMcp.apiKey"), FAKE_KEY);
  assert.equal((await world.cli(["secrets"])).code, 2);
  assert.equal((await world.cli(["secrets", "wat"])).code, 2);
});

test("a broken store fails closed: no change, no value in the message", async (t) => {
  const world = makeWorld(t);
  assert.equal((await world.cli(["secrets", "set", "platformMcp.apiKey"], { stdin: Readable.from([`${FAKE_KEY}\n`]) })).code, 0);
  const file = path.join(world.root, ".runtime", "secrets", "platform.json");
  fs.writeFileSync(file, "{ corrupt");
  const before = fs.readFileSync(file);
  const list = await world.cli(["secrets", "list"]);
  assert.equal(list.code, 1);
  assert.match(list.err, /secret store is unavailable/);
  assert.equal((await world.cli(["secrets", "set", "platformMcp.apiKey"], { stdin: Readable.from(["another-value-000000000000000003\n"]) })).code, 1);
  assert.deepEqual(fs.readFileSync(file), before, "left byte-identical");
  fs.writeFileSync(path.join(world.root, "logs-entry.txt"), "");
  writeLog(world, "entry", "out", "a line\n");
  const logs = await world.cli(["logs", "entry"]);
  assert.equal(logs.code, 1, "logs refuse to print when redaction is unavailable");
  assert.ok(!logs.out.includes("a line"));
});

test("secrets migrate imports the plaintext runtime key files once and leaves stubs", async (t) => {
  const world = makeWorld(t);
  const secret = "runtime-key-value-0000000000000000000004";
  const file = path.join(world.root, "vllm-manager", "logs", "runtime-api-keys.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, secrets: { "ref-aaaa-0001": { secret, createdAt: "2026-10-01T00:00:00Z" } } }));
  const none = await makeWorld(t).cli(["secrets", "migrate"]);
  assert.match(none.out, /No plaintext secret files/);

  const first = await world.cli(["secrets", "migrate"]);
  assert.equal(first.code, 0);
  assert.match(first.out, /runtime-api-keys\.json → runtime\.vllm: imported 1, skipped 0, the plaintext file is now a stub/);
  assert.ok(!first.out.includes(secret));
  const stub = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(stub.secrets, {});
  assert.equal(stub.migratedTo, "secret-store:runtime.vllm");
  assert.equal(createSecretStore({ aiRoot: world.root, namespace: "runtime.vllm", dpapi: world.dpapi }).get("ref-aaaa-0001"), secret, "the reference is kept");
  assert.ok(!allFileText(world.root).includes(secret));
  const second = await world.cli(["secrets", "migrate"]);
  assert.equal(second.code, 0);
  assert.doesNotMatch(second.out, /imported/);

  const corrupt = path.join(world.root, "llama-manager", "logs", "runtime-api-keys.json");
  fs.mkdirSync(path.dirname(corrupt), { recursive: true });
  fs.writeFileSync(corrupt, "{ not json");
  const failed = await world.cli(["secrets", "migrate"]);
  assert.equal(failed.code, 1);
  assert.equal(fs.readFileSync(corrupt, "utf8"), "{ not json", "a corrupt legacy file is left untouched");
});

test("secrets export-legacy is the TTY-confirmed rollback and refuses scripts", async (t) => {
  const world = makeWorld(t);
  const secret = "runtime-key-value-0000000000000000000005";
  const file = path.join(world.root, "llama-manager", "logs", "runtime-api-keys.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, secrets: { "ref-bbbb-0002": { secret, createdAt: "2026-10-01T00:00:00Z" } } }));
  assert.equal((await world.cli(["secrets", "migrate"])).code, 0);
  assert.ok(!fs.readFileSync(file, "utf8").includes(secret));

  assert.equal((await world.cli(["secrets", "export-legacy"])).code, 2, "a namespace is required");
  assert.equal((await world.cli(["secrets", "export-legacy", "--namespace", "platform"])).code, 2);
  const piped = await world.cli(["secrets", "export-legacy", "--namespace", "runtime.llama", "--yes"]);
  assert.equal(piped.code, 1, "no TTY, no export, even with --yes");
  assert.match(piped.err, /interactive terminal/);
  assert.ok(!fs.readFileSync(file, "utf8").includes(secret));

  const declined = await world.cli(["secrets", "export-legacy", "--namespace", "runtime.llama"], { tty: true, ctx: { prompt: async () => "no" } });
  assert.equal(declined.code, 1);
  assert.ok(!fs.readFileSync(file, "utf8").includes(secret));

  const exported = await world.cli(["secrets", "export-legacy", "--namespace", "runtime.llama"], { tty: true, ctx: { prompt: async () => "export" } });
  assert.equal(exported.code, 0);
  assert.ok(!exported.out.includes(secret));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).secrets["ref-bbbb-0002"].secret, secret, "the plaintext file is back");

  const again = await world.cli(["secrets", "export-legacy", "--namespace", "runtime.llama", "--yes"], { tty: true });
  assert.equal(again.code, 1, "an existing plaintext file is not overwritten");
  assert.equal((await world.cli(["secrets", "export-legacy", "--namespace", "runtime.vllm", "--yes"], { tty: true })).code, 0, "nothing to export for an empty namespace");
});

// ---------------------------------------------------------------------------
// doctor

test("doctor prints the report, records doctor-last.json and fails only on a failed check", async (t) => {
  const world = makeWorld(t);
  const report = (fail) => ({
    schemaVersion: 1, at: "2026-10-14T00:00:00.000Z", durationMs: 5, summary: { ok: 1, warn: 0, fail, info: 0, skip: 0 },
    checks: [{ id: "env.node-version", group: "env", status: fail ? "fail" : "ok", title: { "zh-CN": "Node 版本", "en-US": "Node version" }, detail: "d", data: {}, fix: null, actions: [] }],
  });
  const seen = [];
  const ok = await world.cli(["doctor", "--group", "env,storage", "--deep"], { ctx: { runDoctor: async (options) => { seen.push(options); return report(0); } } });
  assert.equal(ok.code, 0);
  assert.deepEqual(seen[0].groups, ["env", "storage"]);
  assert.equal(seen[0].deep, true);
  assert.match(ok.out, /\[ok\]\s+env\.node-version\s+Node version/);
  assert.match(ok.out, /ok 1 · warn 0 · fail 0/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(world.root, ".runtime", "platform", "doctor-last.json"), "utf8")).summary.ok, 1);

  const failed = await world.cli(["doctor", "--json"], { ctx: { runDoctor: async () => report(1) } });
  assert.equal(failed.code, 1);
  assert.equal(JSON.parse(failed.out).summary.fail, 1);
  assert.equal((await world.cli(["doctor", "--group", "network"])).code, 2);
  assert.equal((await world.cli(["doctor", "--fix"])).code, 1, "--fix arrives with the fix runner");
});
