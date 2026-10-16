"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createLauncher } = require("../platform/launcher");
const { verifyMachineSignature } = require("../internal-auth");

const PROCESS = { pid: 4100, processCreatedAt: "2026-10-14T01:02:03.123Z", exe: "C:\\fixture\\bin\\node.exe", commandLine: "node server.js" };

function world(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], operations = [];
  let current = { ...PROCESS }, clock = Date.parse("2026-10-14T01:02:03.123Z");
  const defaults = {
    aiRoot: root, getSecrets: () => [], pollMs: 25,
    now: () => clock,
    sleep: async (ms) => { calls.push(["sleep", ms]); clock += ms; },
    appendLog: (line) => operations.push(line),
    winproc: {
      processInfo: async (pid) => { calls.push(["info", pid]); return current; },
      killTree: async (pid, options) => { calls.push(["kill", pid, options]); current = null; return { ok: true }; },
    },
    spawn(command, args, options) {
      calls.push(["spawn", command, args, options]);
      const child = new EventEmitter(); child.pid = PROCESS.pid;
      child.unref = () => calls.push(["unref"]);
      fs.writeSync(options.stdio[1], "fake startup\n");
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    execFile(command, args, options, callback) { calls.push(["exec", command, args, options]); callback(null, "", ""); },
  };
  const launcher = createLauncher({ ...defaults, ...changes });
  const component = {
    id: "entry", kind: "node", cwd: root, command: "node", args: ["server.js"], env: { FIXTURE: "yes" },
    stop: { strategy: "kill" }, logDir: path.join(root, "logs", "entry"),
  };
  const record = { schemaVersion: 1, id: component.id, ...PROCESS };
  return { root, calls, operations, launcher, component, record, setCurrent: (value) => { current = value; } };
}

test("core.platform exposes launcher, logs and winproc without flat core exports", () => {
  const core = require("..");
  assert.equal(core.platform.launcher.createLauncher, createLauncher);
  assert.equal(typeof core.platform.logs.followLog, "function");
  assert.equal(typeof core.platform.winproc.processInfo, "function");
  assert.equal(core.createLauncher, undefined);
});

test("start detaches with hidden windows and append FDs, then writes the full redacted identity", async (t) => {
  const secret = "opaque-fixture-secret-012345";
  const fixture = world(t, { getSecrets: () => [secret] });
  fixture.component.env.PRIVATE_TOKEN = secret;
  fixture.setCurrent({ ...PROCESS, commandLine: `node server.js --api-key ${secret}` });
  const result = await fixture.launcher.start(fixture.component, { buildCommit: "abcdef0" });
  assert.equal(result.ok, true);
  const spawned = fixture.calls.find((call) => call[0] === "spawn");
  assert.equal(spawned[3].detached, true);
  assert.equal(spawned[3].windowsHide, true);
  assert.equal(spawned[3].stdio[0], "ignore");
  assert.equal(spawned[3].env.PRIVATE_TOKEN, secret);
  assert.ok(fixture.calls.some((call) => call[0] === "unref"));
  for (const fd of spawned[3].stdio.slice(1)) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  const record = fixture.launcher.readIdentity("entry");
  assert.deepEqual(Object.keys(record).sort(), ["schemaVersion", "id", "pid", "processCreatedAt", "exe", "commandLine", "spawnedBy", "startedAt", "configHash", "buildCommit", "logFiles"].sort());
  assert.equal(record.commandLine, "node server.js --api-key <redacted>");
  assert.equal(record.buildCommit, "abcdef0");
  assert.match(record.configHash, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(record.logFiles.out, "utf8"), "fake startup\n");
  const stateFile = path.join(fixture.root, ".runtime", "platform", "state", "entry.json");
  assert.ok(!fs.readFileSync(stateFile, "utf8").includes(secret));
  assert.ok(!JSON.stringify(fixture.operations).includes(secret));
});

const WINDOWS_POWERSHELL_COMMANDS = [
  "powershell.exe",
  "PWSH.EXE",
  "pwsh.exe",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
];

for (const command of WINDOWS_POWERSHELL_COMMANDS) {
  test(`Windows ${command} starts without detaching and retains log, identity and tree-stop behavior`, async (t) => {
    const fixture = world(t, { platform: "win32" });
    const processInfo = { ...PROCESS, exe: command.includes("\\") ? command : `C:\\fixture\\bin\\${command}`, commandLine: `${command} -NoProfile -File fixture-start.ps1` };
    fixture.setCurrent(processInfo);
    const component = {
      ...fixture.component,
      id: "tts-gateway", kind: "process", command,
      args: ["-NoProfile", "-File", "fixture-start.ps1"],
      logs: { out: path.join(fixture.root, "append-out.log"), err: path.join(fixture.root, "append-err.log") },
      stop: { strategy: "script-then-kill", script: [command, "-NoProfile", "-File", "fixture-stop.ps1"], tree: true, graceSec: 0 },
    };
    fs.writeFileSync(component.logs.out, "earlier stdout\n");
    fs.writeFileSync(component.logs.err, "earlier stderr\n");
    const started = await fixture.launcher.start(component);
    assert.equal(started.ok, true);
    const spawned = fixture.calls.find((call) => call[0] === "spawn");
    assert.equal(spawned[1], command);
    assert.deepEqual(spawned[2], component.args);
    assert.equal(spawned[3].detached, false, "Windows PowerShell must keep its console association to execute the script");
    assert.equal(spawned[3].windowsHide, true);
    assert.equal(spawned[3].stdio[0], "ignore");
    assert.equal(spawned[3].stdio.length, 3);
    for (const fd of spawned[3].stdio.slice(1)) {
      assert.equal(Number.isInteger(fd), true);
      assert.throws(() => fs.fstatSync(fd), { code: "EBADF" }, "the parent closes its append handles after spawn");
    }
    assert.equal(fs.readFileSync(component.logs.out, "utf8"), "earlier stdout\nfake startup\n");
    assert.equal(fs.readFileSync(component.logs.err, "utf8"), "earlier stderr\n");
    assert.equal(fixture.calls.filter((call) => call[0] === "unref").length, 1);
    const identity = fixture.launcher.readIdentity(component.id);
    assert.equal(identity.pid, PROCESS.pid);
    assert.equal(identity.exe, processInfo.exe);
    assert.equal(identity.processCreatedAt, PROCESS.processCreatedAt);
    assert.deepEqual(identity.logFiles, component.logs);
    assert.deepEqual(started.identity, identity);

    const stopped = await fixture.launcher.stop(component);
    assert.equal(stopped.reason, "killed-by-supervisor");
    const script = fixture.calls.find((call) => call[0] === "exec");
    assert.equal(script[1], command);
    assert.deepEqual(script[2], component.stop.script.slice(1));
    assert.equal(script[3].windowsHide, true);
    const killed = fixture.calls.find((call) => call[0] === "kill");
    assert.equal(killed[1], PROCESS.pid);
    assert.equal(killed[2].tree, true, "stopping the PowerShell wrapper must still include its Python child");
    assert.deepEqual(killed[2].identity, identity);
  });
}

test("non-Windows PowerShell names and Windows Node, Python and other executables remain detached", async (t) => {
  const cases = [
    ...["linux", "darwin"].flatMap((platform) => WINDOWS_POWERSHELL_COMMANDS.map((command) => ({ platform, command }))),
    ...["node.exe", "C:\\fixture\\bin\\node.exe", "python.exe", "C:\\Python312\\python.exe", "pwsh-helper.exe", "powershell.exe.wrapper"].map((command) => ({ platform: "win32", command })),
  ];
  for (const { platform, command } of cases) {
    const fixture = world(t, { platform });
    const started = await fixture.launcher.start({ ...fixture.component, command });
    assert.equal(started.ok, true);
    const spawned = fixture.calls.find((call) => call[0] === "spawn");
    assert.equal(spawned[3].detached, true, `${platform} ${command} keeps detached launching`);
    assert.equal(spawned[3].windowsHide, true);
  }
});

test("start returns existing for a matching live identity and refuses a recycled PID", async (t) => {
  const fixture = world(t);
  fixture.launcher.writeIdentity(fixture.record);
  assert.equal((await fixture.launcher.start(fixture.component)).existing, true);
  fixture.setCurrent({ ...PROCESS, processCreatedAt: "2026-10-14T01:02:05.123Z" });
  assert.equal((await fixture.launcher.start(fixture.component)).reason, "identity-mismatch");
  assert.equal(fixture.calls.some((call) => call[0] === "spawn"), false);
});

test("start refuses secrets in argv, invalid ids, blocked and detect-only components", async (t) => {
  const fixture = world(t);
  for (const args of [["--api-key", "a-plain-fixture-key"], ["--hf-token=hf_fixture12345678901234567890"]]) {
    assert.equal((await fixture.launcher.start({ ...fixture.component, args })).code, "secret_in_argv");
  }
  await assert.rejects(fixture.launcher.start({ ...fixture.component, id: "../entry" }), { code: "invalid_component_id" });
  assert.equal((await fixture.launcher.start({ ...fixture.component, kind: "listener" })).code, "detect_only_component");
  assert.equal((await fixture.launcher.start({ ...fixture.component, blocked: { reason: "fixture" } })).code, "component_blocked");
  assert.equal(fixture.calls.some((call) => call[0] === "spawn"), false);
});

test("a spawn failure closes FDs and writes no identity; unavailable CIM never triggers a guessed kill", async (t) => {
  let descriptors;
  const fixture = world(t, {
    spawn(command, args, options) {
      descriptors = options.stdio.slice(1);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", Object.assign(new Error("fixture missing executable"), { code: "ENOENT" })));
      return child;
    },
  });
  await assert.rejects(fixture.launcher.start(fixture.component), { code: "ENOENT" });
  assert.equal(fixture.launcher.readIdentity("entry"), null);
  for (const fd of descriptors) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  const unavailable = world(t);
  unavailable.setCurrent(null);
  assert.equal((await unavailable.launcher.start(unavailable.component, { identityTimeoutMs: 50 })).code, "process_identity_unavailable");
  assert.equal(unavailable.calls.some((call) => call[0] === "kill"), false);
});

test("direct kill checks identity and passes the original record to killTree", async (t) => {
  const fixture = world(t);
  fixture.launcher.writeIdentity(fixture.record);
  const result = await fixture.launcher.stop(fixture.component);
  assert.equal(result.reason, "killed-by-supervisor");
  const kill = fixture.calls.find((call) => call[0] === "kill");
  assert.equal(kill[1], PROCESS.pid);
  assert.deepEqual(kill[2].identity, fixture.record);
  assert.equal(fixture.calls.filter((call) => call[0] === "info").length, 2);
});

test("an identity mismatch prevents HTTP, scripts and kill; missing or vanished records do not kill", async (t) => {
  const fixture = world(t, { requestStop: () => { throw new Error("must not request"); } });
  fixture.launcher.writeIdentity(fixture.record);
  fixture.setCurrent({ ...PROCESS, exe: "python.exe" });
  for (const strategy of ["kill", "http-then-kill", "script-then-kill"]) {
    assert.equal((await fixture.launcher.stop({ ...fixture.component, stop: { strategy } })).reason, "identity-mismatch");
  }
  assert.equal(fixture.calls.some((call) => ["kill", "exec"].includes(call[0])), false);
  fixture.setCurrent(null);
  assert.equal((await fixture.launcher.stop(fixture.component)).reason, "vanished");
  assert.equal((await fixture.launcher.stop({ ...fixture.component, id: "missing" })).reason, "identity-mismatch");
});

test("an explicit identity for another component is refused before any process operation", async (t) => {
  const fixture = world(t);
  const result = await fixture.launcher.stop(fixture.component, { identity: { ...fixture.record, id: "llama-manager" } });
  assert.equal(result.reason, "identity-mismatch");
  assert.deepEqual(fixture.calls, []);
});

test("system HTTP shutdown uses the shared HMAC signer and stops gracefully with no kill", async (t) => {
  const key = "fake-trust-key-0123456789abcdef";
  let fixture, fetched = 0;
  fixture = world(t, {
    readInternalKey: () => key,
    async fetchFn(url, options) {
      fetched += 1;
      const target = new URL(url);
      const verified = verifyMachineSignature({ method: options.method, url: target.pathname + target.search, headers: options.headers, socket: { remoteAddress: "127.0.0.1" } }, key);
      assert.equal(verified.ok, true);
      assert.equal(verified.principal, "system:supervisor");
      assert.equal(options.signal instanceof AbortSignal, true);
      fixture.setCurrent(null);
      return { status: 200, text: async () => '{"ok":true}' };
    },
  });
  fixture.launcher.writeIdentity(fixture.record);
  const result = await fixture.launcher.stop({ ...fixture.component, stop: { strategy: "http-then-kill", auth: "system", http: "http://127.0.0.1:54321/api/manager/shutdown", graceSec: 1 } });
  assert.equal(result.reason, "requested");
  assert.equal(fetched, 1);
  assert.equal(fixture.calls.some((call) => call[0] === "kill"), false);
});

test("missing system key makes one unsigned request, logs its code and falls back to verified kill", async (t) => {
  let fetched = 0;
  const fixture = world(t, {
    readInternalKey: () => "",
    async fetchFn(url, options) { fetched += 1; assert.equal(options.headers, undefined); return { status: 401, ok: false }; },
  });
  fixture.launcher.writeIdentity(fixture.record);
  const result = await fixture.launcher.stop({ ...fixture.component, stop: { strategy: "http-then-kill", auth: "system", http: "http://127.0.0.1:54321/api/manager/shutdown", graceSec: 0 } });
  assert.equal(result.reason, "killed-by-supervisor");
  assert.equal(fetched, 1);
  assert.equal(fixture.operations.some((line) => line.message === "entry_shutdown_unsigned"), true);
});

test("script-then-kill waits for the grace period, hides its window and redacts failure logs", async (t) => {
  const secret = "opaque-fixture-secret-012345";
  let fixture;
  fixture = world(t, {
    getSecrets: () => [secret],
    execFile(command, args, options, callback) {
      fixture.calls.push(["exec", command, args, options]);
      callback(new Error(`script failed ${secret}`));
    },
  });
  fixture.launcher.writeIdentity(fixture.record);
  const result = await fixture.launcher.stop({ ...fixture.component, stop: { strategy: "script-then-kill", script: ["powershell.exe", "-File", "fixture-stop.ps1"], tree: true, graceSec: 0.1 } });
  assert.equal(result.reason, "killed-by-supervisor");
  assert.equal(fixture.calls.find((call) => call[0] === "exec")[3].windowsHide, true);
  assert.equal(fixture.calls.filter((call) => call[0] === "sleep").reduce((sum, call) => sum + call[1], 0), 100);
  assert.ok(fixture.operations.some((line) => line.message.includes("<redacted>")));
  assert.ok(!JSON.stringify(fixture.operations).includes(secret));
});

test("a PID recycled during the grace period is never killed", async (t) => {
  let fixture;
  fixture = world(t, { requestStop: async () => { fixture.setCurrent({ ...PROCESS, processCreatedAt: "2026-10-14T01:02:05.123Z" }); } });
  fixture.launcher.writeIdentity(fixture.record);
  const result = await fixture.launcher.stop({ ...fixture.component, stop: { strategy: "http-then-kill", http: "http://127.0.0.1:54321/api/manager/shutdown", graceSec: 1 } });
  assert.equal(result.reason, "identity-mismatch");
  assert.equal(fixture.calls.some((call) => call[0] === "kill"), false);
});

test("compose requires an explicit stop and detect-only components always refuse", async (t) => {
  const fixture = world(t);
  const component = { ...fixture.component, kind: "compose", compose: { file: "fixture-compose.yml", project: "fixture-project" }, stop: { strategy: "compose", action: "down" } };
  assert.equal((await fixture.launcher.start(component)).ok, true);
  assert.equal((await fixture.launcher.stop(component)).code, "explicit_action_required");
  assert.equal((await fixture.launcher.stop(component, { explicit: true })).ok, true);
  assert.deepEqual(fixture.calls.filter((call) => call[0] === "exec").map((call) => call.slice(1, 3)), [
    ["docker", ["compose", "-f", "fixture-compose.yml", "-p", "fixture-project", "up", "-d"]],
    ["docker", ["compose", "-f", "fixture-compose.yml", "-p", "fixture-project", "down"]],
  ]);
  for (const blocked of [{ stop: { strategy: "never" } }, { detectOnly: true }, { kind: "listener" }, { kind: "external" }]) {
    assert.equal((await fixture.launcher.stop({ ...fixture.component, ...blocked })).code, "detect_only_component");
  }
});

test("adopt persists the same verifiable metadata and redacts command lines", async (t) => {
  const fixture = world(t);
  const adopted = await fixture.launcher.adopt(fixture.component, { ...PROCESS, commandLine: "node --api-key fixture-private-key" });
  assert.equal(adopted.ok, true);
  const stored = fixture.launcher.readIdentity("entry");
  assert.equal(stored.spawnedBy, "adopted");
  assert.equal(stored.commandLine, "node --api-key <redacted>");
  assert.equal((await fixture.launcher.verifyIdentity(stored)).ok, true);
});
