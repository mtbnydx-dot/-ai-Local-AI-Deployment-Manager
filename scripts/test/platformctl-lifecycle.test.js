"use strict";

// The `platform` lifecycle commands (06 §6.2, OPS-7b): start, stop, restart,
// supervise and supervisor. Two kinds of test:
//   - fast ones against a fake supervisor behind the real control server on a
//     unique pipe, with injected fetch and no process spawned;
//   - one end-to-end test with the real supervisor (in this process), the real
//     launcher and stub node components on random ports in a temp root.
// Nothing here touches the live root, Docker or a real service.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const STUB = path.join(__dirname, "fixtures", "stub-component.js");
const { run, EXIT } = require("../platformctl.js");
const { createFakeDpapi } = require("../../manager-core/test/fixtures/secrets/fake-dpapi");
const { createSecretStore } = require("../../manager-core/secret-store");
const control = require("../../manager-core/platform/control");
const componentsApi = require("../../manager-core/platform/components");

function sink() {
  const chunks = [];
  return { write(text) { chunks.push(String(text)); return true; }, text: () => chunks.join(""), isTTY: false };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platformctl-life-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

function makeWorld(t, extra = {}) {
  const root = extra.root || tempRoot(t);
  return {
    root,
    dpapi: createFakeDpapi(),
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
        openUrl: async (url) => { this.opened.push(url); },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
        lanAddress: "192.0.2.10",
        ...extra.ctx,
        ...options.ctx,
      });
      return { code, out: stdout.text(), err: stderr.text() };
    },
  };
}

// A fake supervisor behind the real control server; `calls` records requests.
async function serveFake(t, world, overrides = {}) {
  const calls = [];
  const ops = new Map();
  const finish = (kind, log = [], result = null) => {
    const opId = `op_${ops.size + 1}`;
    ops.set(opId, { opId, kind, state: "ok", progress: 1, log, result });
    return { opId };
  };
  const supervisor = {
    async status() {
      return {
        supervisor: { running: true, pid: 4242, startedAt: "2026-10-14T08:00:00.000Z", profile: "core" },
        components: [],
        ...(overrides.status || {}),
      };
    },
    async startProfile(name, options) { calls.push(["startProfile", name, options]); return finish("start", ["Service entry: starting", "Service entry: ready"]); },
    async startComponent(id) { calls.push(["startComponent", id]); return finish("start", [`${id}: ready`]); },
    async stopComponent(id, options) { calls.push(["stopComponent", id, options]); return {}; },
    async stopScope(options) { calls.push(["stopScope", options]); return finish("stop", ["entry: stopping"]); },
    async restart(ids, options) {
      calls.push(["restart", ids, options]);
      if (overrides.busy && !options.force && options.when !== "idle") throw control.controlError(409, "component_busy", "busy", { blockers: overrides.busy });
      if (options.when === "idle") return { queued: ids, blockers: overrides.busy || [] };
      return finish("restart", ids.map((id) => `${id}: stopping`));
    },
    async operation(opId) { return ops.get(opId); },
    async shutdown(options) { calls.push(["shutdown", options]); return {}; },
    ...overrides.supervisor,
  };
  const token = control.createControlToken();
  await createSecretStore({ aiRoot: world.root, namespace: "platform-control", dpapi: world.dpapi }).set("token", token);
  const server = await control.startControlServer({ endpoint: control.controlEndpoint(world.root), token, supervisor });
  t.after(() => server.close());
  return { calls, supervisor, server };
}

// Makes the packages of the real registry look installed, so preflight passes.
function installFakePackages(root) {
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "manager-core", "data", "platform-components.json"), "utf8"));
  for (const pkg of registry.packages) fs.mkdirSync(path.join(root, pkg.dir, "node_modules"), { recursive: true });
}

// Real processes, but without PowerShell/CIM (several seconds per call on a
// loaded machine): identity is the pid plus the time it was first seen.
function createTestWinproc() {
  const seen = new Map();
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  return {
    async listListeners() { return []; },
    async processInfo(pid) {
      if (!alive(pid)) return null;
      if (!seen.has(pid)) seen.set(pid, new Date().toISOString());
      return { pid, processCreatedAt: seen.get(pid), exe: process.execPath, commandLine: `node ${STUB}` };
    },
    async imageNames(pids) { return Object.fromEntries(pids.map((pid) => [pid, "node.exe"])); },
    async killTree(pid) { try { process.kill(pid); } catch {} return { ok: true, stopped: true, reason: "killed-by-supervisor" }; },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, message, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

// ---------------------------------------------------------------------------
// Fast tests (fake supervisor)

test("start core: preflight blocks with exit 5 and one next step when packages are not installed", async (t) => {
  const world = makeWorld(t);
  const result = await world.cli(["start", "core"]);
  assert.equal(result.code, EXIT.PREFLIGHT);
  assert.match(result.err, /Preflight blocked: Dependencies of .* are not installed\. Next step: install-all\.cmd/);
});

test("start core --lan sends the runtime override listeners.admin.lan and summarises only the profile", async (t) => {
  const world = makeWorld(t);
  installFakePackages(world.root);
  const row = (id, state, extra = {}) => ({ id, kind: "node", state, pid: 100, ports: [], ...extra });
  const fake = await serveFake(t, world, {
    status: {
      components: [
        row("docker", "ready", { kind: "external" }), row("entry", "ready"), row("vllm-manager", "ready"), row("llama-manager", "ready"),
        row("service-entry-public", "disabled", { kind: "listener" }),
        row("platform-mcp", "stopped"),
      ],
    },
  });
  const result = await world.cli(["start", "core", "--lan", "--no-browser"]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(fake.calls, [["startProfile", "core", { runtimeOverrides: { "listeners.admin.lan": true }, restoreModels: false }]]);
  assert.match(result.out, /Selected components:/);
  assert.match(result.out, /vllm-manager/);
  assert.doesNotMatch(result.out, /platform-mcp/, "only the selected profile is summarised");
  assert.match(result.out, /http:\/\/192\.0\.2\.10:\d+/, "the LAN address is listed when the admin listener is on the LAN");
  assert.match(result.err, /\[\d\/\d+\] Service entry … ready \(\d+\.\d s\)/);
  assert.deepEqual(world.opened, []);
});

test("start returns 1 when a selected component is not ready, and --open opens the console once the entry is ready", async (t) => {
  const world = makeWorld(t);
  installFakePackages(world.root);
  await serveFake(t, world, { status: { components: [{ id: "entry", kind: "node", state: "ready" }, { id: "vllm-manager", kind: "node", state: "failed", reason: "max-restarts" }] } });
  const result = await world.cli(["start", "entry", "vllm-manager", "--open"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /vllm-manager: failed \(max-restarts\)/);
  assert.equal(world.opened.length, 1);
  assert.match(world.opened[0], /^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test("start --open opens the paired URL without printing it, and the plain URL plus the hint without the internal key", async (t) => {
  const world = makeWorld(t);
  installFakePackages(world.root);
  await serveFake(t, world, { status: { components: [{ id: "entry", kind: "node", state: "ready" }] } });
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push([String(url), init.method, init.headers["x-ai-principal"] || init.headers["X-AI-Principal"] || null]);
    return new Response(JSON.stringify({ ok: true, code: "ABCDEFGHJK", url: "http://127.0.0.1:5176/#pair=ABCDEFGHJK", expiresAt: "2026-10-14T08:02:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const paired = await world.cli(["start", "entry", "--open"], { ctx: { fetch: fetchStub, internalReadKey: () => "fixture-internal-key-0123456789abcdefghijklmnop" } });
  assert.equal(paired.code, 0, paired.err);
  assert.deepEqual(world.opened, ["http://127.0.0.1:5176/#pair=ABCDEFGHJK"]);
  assert.ok(!paired.out.includes("ABCDEFGHJK") && !paired.err.includes("ABCDEFGHJK"), "the code is never printed");
  assert.ok(calls.some(([url, method]) => url.endsWith("/api/session/pair-codes") && method === "POST"));

  world.opened.length = 0;
  const plain = await world.cli(["start", "entry", "--open"], { ctx: { fetch: fetchStub, internalReadKey: () => "" } });
  assert.equal(plain.code, 0, plain.err);
  assert.match(world.opened[0], /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.match(plain.err, /Run platform admin pair in a terminal on this machine/);
});

test("start without a supervisor and --no-supervisor exits 4; unknown ids are usage errors", async (t) => {
  const world = makeWorld(t);
  installFakePackages(world.root);
  const none = await world.cli(["start", "--no-supervisor"]);
  assert.equal(none.code, EXIT.SUPERVISOR_UNAVAILABLE);
  const unknown = await world.cli(["start", "nope"]);
  assert.equal(unknown.code, EXIT.USAGE);
});

test("start spawns the supervisor with --profile none when none answers, then waits for the pipe", async (t) => {
  const world = makeWorld(t);
  installFakePackages(world.root);
  const spawned = [];
  let fake = null;
  const result = await world.cli(["start", "core", "--no-browser"], {
    ctx: {
      spawnSupervisor: async (argv) => { spawned.push(argv); fake = await serveFake(t, world); },
    },
  });
  assert.deepEqual(spawned, [["supervise", "--profile", "none"]]);
  assert.equal(fake.calls[0][0], "startProfile");
  assert.equal(result.code, 1, "the fake reports no component rows, so nothing is ready");
});

test("restart --if-idle returns 3 with the blockers and restarts nothing", async (t) => {
  const world = makeWorld(t);
  const busy = [{ kind: "download", source: "vllm-manager", title: "fixture model" }];
  const fake = await serveFake(t, world, { busy });
  const result = await world.cli(["restart", "vllm-manager", "--if-idle"]);
  assert.equal(result.code, EXIT.BUSY);
  assert.match(result.err, /vllm-manager is busy/);
  assert.match(result.err, /download \(vllm-manager\): fixture model/);
  assert.equal(fake.calls.filter((call) => call[0] === "restart").length, 1);
  assert.equal(fake.calls[0][2].force, false);
});

test("restart without a flag refuses in a non-TTY, --force restarts, a TTY prompt can confirm, --when-idle queues", async (t) => {
  const world = makeWorld(t);
  const busy = [{ kind: "launch", source: "llama-manager", title: "serve" }];
  const fake = await serveFake(t, world, { busy });
  const refused = await world.cli(["restart", "llama-manager"]);
  assert.equal(refused.code, EXIT.BUSY);
  assert.match(refused.err, /--when-idle.*--force/);

  const forced = await world.cli(["restart", "llama-manager", "--force"]);
  assert.equal(forced.code, 0, forced.err);
  assert.match(forced.out, /Restarted llama-manager/);

  const declined = await world.cli(["restart", "llama-manager"], { tty: true, ctx: { prompt: async () => "no" } });
  assert.equal(declined.code, EXIT.BUSY);
  const confirmed = await world.cli(["restart", "llama-manager"], { tty: true, ctx: { prompt: async () => "yes" } });
  assert.equal(confirmed.code, 0, confirmed.err);

  const queued = await world.cli(["restart", "llama-manager", "--when-idle"]);
  assert.equal(queued.code, 0);
  assert.match(queued.out, /llama-manager is queued/);
  assert.deepEqual(fake.calls.filter((call) => call[0] === "restart").pop()[2], { when: "idle", force: false });
});

test("restart needs ids and a supervisor", async (t) => {
  const world = makeWorld(t);
  assert.equal((await world.cli(["restart"])).code, EXIT.USAGE);
  assert.equal((await world.cli(["restart", "entry"])).code, EXIT.SUPERVISOR_UNAVAILABLE);
});

test("stop --models without --yes in a non-TTY refuses before anything is stopped", async (t) => {
  const world = makeWorld(t);
  const fake = await serveFake(t, world);
  const posts = [];
  const fetchStub = async (url, init = {}) => {
    if (init.method === "POST") { posts.push(String(url)); return new Response("{}", { status: 200 }); }
    if (String(url).includes("/api/instances")) return new Response(JSON.stringify({ instances: [{ id: "qwen-1", status: "running", servedModels: ["qwen"] }] }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const refused = await world.cli(["stop", "core", "--models"], { ctx: { fetch: fetchStub } });
  assert.equal(refused.code, EXIT.BUSY);
  assert.match(refused.err, /qwen-1/);
  assert.match(refused.err, /needs --yes/);
  assert.deepEqual(posts, []);
  assert.deepEqual(fake.calls, []);

  const typed = await world.cli(["stop", "core", "--models"], { tty: true, ctx: { fetch: fetchStub, prompt: async () => "stop" } });
  assert.equal(typed.code, 0, typed.err);
  assert.ok(posts.length >= 1 && posts.every((url) => /\/api\/instances\/qwen-1\/stop$/.test(url)));
  assert.equal(fake.calls[0][0], "stopScope");
  assert.equal(fake.calls[0][1].scope, "core");

  const wrong = await world.cli(["stop", "core", "--models"], { tty: true, ctx: { fetch: fetchStub, prompt: async () => "yes" } });
  assert.equal(wrong.code, EXIT.BUSY);
  assert.equal(fake.calls.filter((call) => call[0] === "stopScope").length, 1);
});

test("--legacy-args maps the old launcher words: lan is --lan, no profile is core, and all is the full profile", async (t) => {
  const world = makeWorld(t);
  installFakePackages(world.root);
  const fake = await serveFake(t, world);
  for (const args of [["lan"], []]) {
    await world.cli(["start", ...args, "--legacy-args", "--no-browser"]);
  }
  assert.deepEqual(fake.calls.map((call) => [call[1], call[2].runtimeOverrides]), [
    ["core", { "listeners.admin.lan": true }],
    ["core", {}],
  ]);
  // The full profile includes the MCP server, which the fake root has not built.
  const full = await world.cli(["start", "all", "lan", "--legacy-args", "--no-browser"]);
  assert.equal(full.code, EXIT.PREFLIGHT);
  assert.match(full.err, /MCP server is not built/);
});

test("stop --legacy-args with no word stops core, like the old stop-platform.cmd", async (t) => {
  const world = makeWorld(t);
  const fake = await serveFake(t, world);
  assert.equal((await world.cli(["stop", "--legacy-args"])).code, 0);
  assert.deepEqual(fake.calls.filter((call) => call[0] === "stopScope").map((call) => call[1].scope), ["core"]);
});

test("stop without --models says that model containers keep running; named ids stop in reverse order", async (t) => {
  const world = makeWorld(t);
  const fake = await serveFake(t, world);
  const fetchStub = async (url) => (String(url).includes("/api/instances")
    ? new Response(JSON.stringify([{ id: "gemma-2", status: "running", servedModels: ["gemma"] }]), { status: 200 })
    : new Response("{}", { status: 404 }));
  const result = await world.cli(["stop", "entry", "vllm-manager"], { ctx: { fetch: fetchStub } });
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /Model containers keep running: gemma-2/);
  assert.deepEqual(fake.calls.map((call) => call[1]), ["vllm-manager", "entry"], "dependants stop first");
});

test("stop all asks the supervisor to exit and waits for the pipe to go away", async (t) => {
  const world = makeWorld(t);
  const token = control.createControlToken();
  await createSecretStore({ aiRoot: world.root, namespace: "platform-control", dpapi: world.dpapi }).set("token", token);
  let server = null;
  const calls = [];
  const supervisor = {
    async status() { return { components: [] }; },
    async stopScope(options) {
      calls.push(options);
      setTimeout(() => { server.close(); }, 50);
      return { opId: "op_1" };
    },
    async operation() { return { opId: "op_1", state: "ok", progress: 1, log: [], result: null }; },
  };
  server = await control.startControlServer({ endpoint: control.controlEndpoint(world.root), token, supervisor });
  t.after(() => server.close());
  const result = await world.cli(["stop", "all"]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(calls, [{ scope: "all", models: false, confirm: false, exitSupervisor: true }]);
  assert.equal(await world.cli(["supervisor", "status"]).then((value) => value.code), EXIT.SUPERVISOR_UNAVAILABLE);
});

test("supervisor status prints the supervisor and exits 4 without one", async (t) => {
  const world = makeWorld(t);
  assert.equal((await world.cli(["supervisor", "status"])).code, EXIT.SUPERVISOR_UNAVAILABLE);
  const fake = await serveFake(t, world);
  const status = await world.cli(["supervisor", "status"]);
  assert.equal(status.code, 0);
  assert.match(status.out, /Supervisor running · pid 4242 · profile core/);
  const json = await world.cli(["supervisor", "status", "--json"]);
  assert.equal(JSON.parse(json.out).pid, 4242);
  fake.supervisor.shutdown = async (options) => {
    fake.calls.push(["shutdown", options]);
    setTimeout(() => fake.server.close(), 50);
    return {};
  };
  const stop = await world.cli(["supervisor", "stop"]);
  assert.equal(stop.code, 0, stop.err);
  assert.deepEqual(fake.calls.at(-1), ["shutdown", { leaveChildren: true }], "children are left running");
  assert.equal((await world.cli(["supervisor", "status"])).code, EXIT.SUPERVISOR_UNAVAILABLE);
});

test("supervise --profile is validated and the commands are bilingual in --help", async (t) => {
  const world = makeWorld(t);
  assert.equal((await world.cli(["supervise", "--profile", "bogus"])).code, EXIT.USAGE);
  for (const name of ["start", "stop", "restart", "supervise", "supervisor"]) {
    const help = await world.cli([name, "--help"]);
    assert.equal(help.code, 0);
    assert.match(help.out, /[一-鿿]/, `${name} has a Chinese summary`);
  }
});

// ---------------------------------------------------------------------------
// End to end: the real supervisor and launcher with stub components

function stubRegistry(root, ports) {
  const stubDir = path.join(root, "stub-flags");
  fs.mkdirSync(stubDir, { recursive: true });
  const make = (id, port, extra = {}) => ({
    id,
    kind: "node",
    profile: "core",
    autostart: true,
    label: { "zh-CN": `桩 ${id}`, "en-US": `Stub ${id}` },
    description: { "zh-CN": "测试桩", "en-US": "Test stub" },
    cwd: ".",
    command: "${NODE}",
    args: [STUB],
    env: { STUB_PORT: String(port), STUB_ID: id, STUB_DIR: stubDir },
    ports: [{ name: "api", port, bind: "127.0.0.1" }],
    readiness: { http: `http://127.0.0.1:${port}/health`, expectJson: { ok: true }, timeoutSec: 20, intervalMs: 100 },
    liveness: { http: `http://127.0.0.1:${port}/health`, intervalSec: 1, failureThreshold: 3, onFailure: "report" },
    stop: { strategy: "http-then-kill", http: `http://127.0.0.1:${port}/shutdown`, graceSec: 5 },
    busy: { http: `http://127.0.0.1:${port}/api/jobs?fields=summary`, parser: "manager-jobs" },
    logDir: `logs/${id}`,
    ...extra,
  });
  const file = path.join(root, "stub-components.json");
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    asOf: "2026-10-14",
    staleAfterDays: 365,
    requirements: {},
    packages: [],
    components: [make("entry", ports[0]), make("vllm-manager", ports[1], { after: ["entry"] }), make("llama-manager", ports[2], { after: ["entry"] })],
  }));
  return { file, stubDir };
}

test("end to end: start spawns the supervisor, restarts a killed stub with backoff, and stop all leaves nothing running", async (t) => {
  const world = makeWorld(t);
  const ports = [await freePort(), await freePort(), await freePort()];
  const { file, stubDir } = stubRegistry(world.root, ports);
  const loadRegistry = (config) => componentsApi.loadComponentRegistry({ aiRoot: world.root, config, bundledFile: file });
  let supervisorRun = null;
  const supervisorOut = sink();
  const supervisorErr = sink();
  const ctx = {
    registryFile: file,
    handleSignals: false,
    spawnSupervisor: (argv) => {
      supervisorRun = run(argv, {
        aiRoot: world.root, env: { PLATFORM_LANG: "en-US" }, stdout: supervisorOut, stderr: supervisorErr, stdin: Readable.from([]),
        dpapi: world.dpapi, acl: { secure: async () => {} }, registryFile: file, handleSignals: false,
        superviseOptions: { runDoctor: false, loadRegistry, winproc: createTestWinproc() },
      });
      supervisorRun.then((code) => supervisorErr.write(`supervise returned ${code}
`), (error) => supervisorErr.write(`supervise threw ${error?.stack}
`));
    },
  };
  const pids = [];
  t.after(async () => {
    // Whatever happened, no stub may outlive the test.
    await world.cli(["stop", "all"], { ctx }).catch(() => {});
    for (const pid of pids) { try { process.kill(pid); } catch {} }
    if (supervisorRun) await Promise.race([supervisorRun, new Promise((resolve) => setTimeout(resolve, 3000))]);
  });
  const rows = async () => {
    const result = await world.cli(["status", "--json"], { ctx });
    return JSON.parse(result.out).components || [];
  };

  // start core: spawns the supervisor, starts in order, summarises only the profile.
  const started = await world.cli(["start", "core", "--no-browser", "--timeout", "60"], { ctx, env: { PLATFORM_DEBUG: "1" } });
  assert.equal(started.code, 0, `${started.err}\n${started.out}`);
  assert.match(started.out, /Selected components:/);
  for (const id of ["entry", "vllm-manager", "llama-manager"]) assert.match(started.out, new RegExp(id));
  assert.ok(started.err.indexOf("entry") < started.err.indexOf("vllm-manager"), "entry starts before the managers");
  assert.match(started.err, /\[1\/3\] Stub entry … ready/);
  for (const port of ports) {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
  }
  const first = (await rows()).find((row) => row.id === "vllm-manager");
  assert.equal(first.state, "ready");
  pids.push(...(await rows()).map((row) => row.pid).filter(Boolean));

  // A killed stub restarts with backoff.
  process.kill(first.pid);
  const restarted = await waitFor(async () => {
    const row = (await rows()).find((item) => item.id === "vllm-manager");
    return row && row.state === "ready" && row.pid !== first.pid ? row : null;
  }, "the killed stub was not restarted");
  assert.notEqual(restarted.pid, first.pid);
  pids.push(restarted.pid);
  assert.ok(restarted.restarts.count >= 1);

  // restart --if-idle returns 3 with blockers while a download runs.
  fs.writeFileSync(path.join(stubDir, "busy"), "1");
  const busy = await world.cli(["restart", "vllm-manager", "--if-idle"], { ctx });
  assert.equal(busy.code, EXIT.BUSY, busy.err);
  assert.match(busy.err, /download \(vllm-manager\): fixture model/);
  fs.rmSync(path.join(stubDir, "busy"));
  const idle = await world.cli(["restart", "vllm-manager", "--if-idle"], { ctx });
  assert.equal(idle.code, 0, idle.err);
  pids.push(...(await rows()).map((row) => row.pid).filter(Boolean));

  // stop all exits the supervisor and leaves no stub running.
  const stopped = await world.cli(["stop", "all"], { ctx });
  assert.equal(stopped.code, 0, stopped.err);
  assert.equal(await supervisorRun, 0, "supervise returned after the shutdown");
  assert.equal((await world.cli(["supervisor", "status"], { ctx })).code, EXIT.SUPERVISOR_UNAVAILABLE);
  for (const port of ports) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }), `port ${port} is closed`);
  }
});
