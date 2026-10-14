"use strict";

// CLI transfer engine (docs/overhaul/03-hub.md §6.2, §17, HUB-5): the env
// matrix, the argv, batching, the model-storage lock, secret redaction of log
// and file output, stop, and orphan detection. No real process is spawned:
// spawnImpl is a fake, and every file lives in a temp directory.

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { createCliTransferEngine, commandLineMatches } = require("../model-hub/transfer");
const { createTokenVault } = require("../model-hub/tokens");
const { HubError, classifyTransferFailure } = require("../model-hub/errors");
const { compileIncludePatterns } = require("../model-hub/selection");
const { createSecretRedactor } = require("../secret-redactor");

const FAKE_TOKEN = "hf_FAKEtokenFAKEtokenFAKEtoken1234";
const PLAIN_TOKEN = "fake-plain-token-0123456789";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function tempDir(t, prefix = "hub-transfer-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake child process. `handler(call)` decides what it does; it runs on the
// next tick so the engine has attached its listeners.
function createFakeSpawn(handler) {
  const calls = [];
  let nextPid = 4100;
  function spawnImpl(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = nextPid++;
    const call = { command, args, options, child };
    calls.push(call);
    setImmediate(() => handler(call, calls));
    return child;
  }
  return { spawnImpl, calls };
}

function exitChild(child, code = 0, { stdout = "", stderr = "", signal = null } = {}) {
  if (stdout) child.stdout.write(stdout);
  if (stderr) child.stderr.write(stderr);
  child.stdout.end();
  child.stderr.end();
  setImmediate(() => child.emit("close", code, signal));
}

function fakeStorage() {
  const events = [];
  return {
    events,
    acquireOperation(targets, kind) {
      events.push(["acquire", targets.map((target) => path.resolve(target)), kind]);
      return "abcdef01-2345-6789-abcd-ef0123456789";
    },
    trackChild(id, pid) {
      events.push(["track", id, pid]);
    },
    releaseOperation(id) {
      events.push(["release", id]);
    },
  };
}

function makeJob(root, overrides = {}) {
  return {
    id: "dl_7k2m4q9x3c5vb8np",
    state: "downloading",
    artifact: {
      provider: "huggingface",
      repo: "unsloth/Qwen3-8B-GGUF",
      revision: "main",
      revisionSha: SHA,
      files: [{ path: "Qwen3-8B-Q4_K_M.gguf", size: 10 }, { path: "config.json", size: 1 }],
    },
    target: { localDir: path.join(root, "models", "unsloth-Qwen3-8B-GGUF") },
    transfer: {
      engine: "cli",
      cli: "hf",
      batches: 1,
      batchIndex: 0,
      options: { source: "huggingface", endpoint: "https://huggingface.co", xet: "default", credentialMode: "cached-login", tokenRef: null, remember: false },
      optionsHistory: [],
      include: { mode: "include", patterns: ["*Q4_K_M*.gguf", "config.json"], batches: [["*Q4_K_M*.gguf", "config.json"]] },
    },
    ...overrides,
  };
}

function withOptions(job, options, extra = {}) {
  return { ...job, transfer: { ...job.transfer, ...extra, options: { ...job.transfer.options, ...options } } };
}

function makeEngine(t, extra = {}) {
  const root = tempDir(t);
  const hfHome = path.join(root, "hf-home");
  const dataDir = path.join(root, "data");
  const tokens = extra.tokens || createTokenVault({});
  const engine = createCliTransferEngine({
    hfCli: "hf",
    modelScopeCli: "modelscope",
    hfHome,
    dataDir,
    platform: "win32",
    env: { PATH: "fake-path" },
    tokens,
    ...extra,
  });
  return { root, hfHome, dataDir, tokens, engine };
}

function baseEnv(hfHome) {
  return {
    PATH: "fake-path",
    HF_HOME: hfHome,
    HUGGINGFACE_HUB_CACHE: path.join(hfHome, "hub"),
    MODELSCOPE_CACHE: path.join(hfHome, "modelscope"),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    NO_COLOR: "1",
    CLICOLOR: "0",
    CLICOLOR_FORCE: "0",
    TERM: "dumb",
    HF_HUB_DISABLE_PROGRESS_BARS: "1",
    TQDM_DISABLE: "1",
  };
}

function runToExit(engine, job, hooks = {}) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let handle;
    try {
      handle = engine.start(job, {
        ...hooks,
        onLine: (stream, text) => {
          lines.push([stream, text]);
          hooks.onLine?.(stream, text);
        },
        onExit: (exit) => {
          hooks.onExit?.(exit);
          resolve({ exit, lines, handle });
        },
      });
    } catch (error) {
      reject(error);
    }
  });
}

test("env matrix: official with the cached login", (t) => {
  const { engine, hfHome } = makeEngine(t);
  const job = withOptions(makeJob(hfHome), { xet: "high-performance" });
  assert.deepEqual(engine.buildEnv(job), {
    ...baseEnv(hfHome),
    HF_ENDPOINT: "https://huggingface.co",
    HF_XET_HIGH_PERFORMANCE: "1",
  });
});

test("env matrix: official with a temporary token puts it in HF_TOKEN only", async (t) => {
  const { engine, hfHome, tokens } = makeEngine(t);
  const tokenRef = await tokens.put(FAKE_TOKEN);
  const job = withOptions(makeJob(hfHome), { credentialMode: "temp-token", tokenRef });
  assert.deepEqual(engine.buildEnv(job), {
    ...baseEnv(hfHome),
    HF_ENDPOINT: "https://huggingface.co",
    HF_TOKEN: FAKE_TOKEN,
  });
  assert.equal(engine.buildCommand(job).args.join(" ").includes(FAKE_TOKEN), false);
});

test("env matrix: credential mode none disables the implicit token", (t) => {
  const { engine, hfHome } = makeEngine(t);
  const job = withOptions(makeJob(hfHome), { credentialMode: "none", xet: "off" });
  assert.deepEqual(engine.buildEnv(job), {
    ...baseEnv(hfHome),
    HF_ENDPOINT: "https://huggingface.co",
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
    HF_HUB_DISABLE_XET: "1",
  });
});

test("env matrix: the mirror gets no token and a token path that never exists", (t) => {
  const { engine, hfHome, dataDir } = makeEngine(t, { env: { PATH: "fake-path", HF_TOKEN: "hf_inheritedinheritedinherited1", HUGGING_FACE_HUB_TOKEN: "hf_inheritedinheritedinherited2" } });
  const job = withOptions(makeJob(hfHome), { source: "hf-mirror", endpoint: "https://hf-mirror.example.test/", credentialMode: "none" });
  const env = engine.buildEnv(job);
  assert.deepEqual(env, {
    ...baseEnv(hfHome),
    HF_ENDPOINT: "https://hf-mirror.example.test",
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
    HF_TOKEN_PATH: path.join(dataDir, "no-token"),
  });
  assert.equal(fs.existsSync(env.HF_TOKEN_PATH), false);
});

test("env matrix: ModelScope strips proxies and uses direct DNS", (t) => {
  const { engine, hfHome } = makeEngine(t, {
    env: { PATH: "fake-path", HTTP_PROXY: "http://proxy.invalid", https_proxy: "http://proxy.invalid", HF_ENDPOINT: "https://other.invalid", HF_TOKEN: "hf_inheritedinheritedinherited1" },
  });
  const env = engine.buildEnv(withOptions(makeJob(hfHome), { source: "modelscope", endpoint: null, credentialMode: "none" }));
  assert.equal(env.NO_PROXY, "*");
  assert.equal(env.MODELSCOPE_DIRECT_DNS, "1");
  assert.ok(env.PYTHONPATH.split(path.delimiter).some((entry) => entry.endsWith("python-direct-dns")));
  for (const key of ["HTTP_PROXY", "https_proxy", "HF_ENDPOINT", "HF_TOKEN", "HF_HUB_DISABLE_IMPLICIT_TOKEN"]) {
    assert.equal(key in env, false, key);
  }
});

test("env matrix: the three Xet modes", (t) => {
  const { engine, hfHome } = makeEngine(t, { env: { PATH: "fake-path", HF_XET_HIGH_PERFORMANCE: "1", HF_HUB_DISABLE_XET: "1" } });
  const job = makeJob(hfHome);
  const xetKeys = (xet) => {
    const env = engine.buildEnv(withOptions(job, { xet }));
    return Object.keys(env).filter((key) => key.includes("XET")).sort();
  };
  assert.deepEqual(xetKeys("default"), []);
  assert.deepEqual(xetKeys("high-performance"), ["HF_XET_HIGH_PERFORMANCE"]);
  assert.deepEqual(xetKeys("off"), ["HF_HUB_DISABLE_XET"]);
});

test("inherited token and endpoint variables are never passed on, whatever their case", (t) => {
  const { engine, hfHome } = makeEngine(t, {
    env: { PATH: "fake-path", hf_token: "hf_inheritedinheritedinherited1", Hf_Endpoint: "https://other.invalid" },
  });
  const env = engine.buildEnv(makeJob(hfHome));
  assert.equal(Object.keys(env).some((key) => key.toLowerCase() === "hf_token"), false);
  assert.equal(env.HF_ENDPOINT, "https://huggingface.co");
});

test("a mirror job with a token reference is refused", async (t) => {
  const { engine, hfHome, tokens } = makeEngine(t);
  const tokenRef = await tokens.put(FAKE_TOKEN);
  for (const options of [{ tokenRef }, { credentialMode: "temp-token" }]) {
    const job = withOptions(makeJob(hfHome), { source: "hf-mirror", endpoint: "https://hf-mirror.com", ...options });
    assert.throws(() => engine.buildEnv(job), (error) => error instanceof HubError && error.code === "token_not_allowed_on_mirror" && error.status === 422);
  }
});

test("a credential never goes to a host that is not huggingface.co", async (t) => {
  const { engine, hfHome, tokens } = makeEngine(t);
  const tokenRef = await tokens.put(FAKE_TOKEN);
  const custom = withOptions(makeJob(hfHome), { endpoint: "https://hub.example.test", credentialMode: "temp-token", tokenRef });
  assert.throws(() => engine.buildEnv(custom), (error) => error.code === "credential_host_violation");
  const login = withOptions(makeJob(hfHome), { endpoint: "https://hub.example.test", credentialMode: "cached-login" });
  assert.throws(() => engine.buildEnv(login), (error) => error.code === "credential_host_violation");
  const anonymous = withOptions(makeJob(hfHome), { endpoint: "https://hub.example.test", credentialMode: "none" });
  assert.equal(engine.buildEnv(anonymous).HF_ENDPOINT, "https://hub.example.test");
});

test("an unresolvable tokenRef is never spawned and takes no lock", async (t) => {
  const storage = fakeStorage();
  const fake = createFakeSpawn(() => assert.fail("nothing may be spawned"));
  const { engine, hfHome } = makeEngine(t, { spawnImpl: fake.spawnImpl, modelStorage: storage });
  for (const tokenRef of ["dlt_aaaaaaaaaaaaaaaa", null]) {
    const job = withOptions(makeJob(hfHome), { credentialMode: "temp-token", tokenRef });
    assert.throws(() => engine.start(job, {}), (error) => error instanceof HubError && error.code === "hf_token_expired" && error.status === 409);
  }
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(storage.events, []);
});

test("resume and retry use the persisted options, not the current settings", (t) => {
  const { engine, hfHome } = makeEngine(t);
  const job = withOptions(makeJob(hfHome), { xet: "off", credentialMode: "none" });
  const persisted = JSON.parse(JSON.stringify(job));
  const settings = { transfer: { xet: "high-performance" }, sources: { policy: "mirror" } };
  settings.transfer.xet = "default";
  assert.deepEqual(engine.buildEnv(persisted), engine.buildEnv(job));
  assert.equal(engine.buildEnv(persisted).HF_HUB_DISABLE_XET, "1");
  assert.equal(engine.buildEnv(persisted).HF_ENDPOINT, "https://huggingface.co");
});

test("hf argv pins the revision SHA and uses --include=PAT", (t) => {
  const { engine, hfHome } = makeEngine(t);
  const job = makeJob(hfHome);
  const command = engine.buildCommand(job);
  assert.equal(command.command, "hf");
  assert.deepEqual(command.args, [
    "download", "unsloth/Qwen3-8B-GGUF", "--revision", SHA,
    "--include=*Q4_K_M*.gguf", "--include=config.json",
    "--local-dir", job.target.localDir,
  ]);
  assert.match(command.display, /^hf download unsloth\/Qwen3-8B-GGUF --revision /);
  // No SHA: the branch name is used.
  const branch = { ...job, artifact: { ...job.artifact, revisionSha: null } };
  assert.deepEqual(engine.buildCommand(branch).args.slice(2, 4), ["--revision", "main"]);
});

test("a whole-repo selection has no --include", (t) => {
  const { engine, hfHome } = makeEngine(t);
  const job = makeJob(hfHome);
  job.transfer.include = { mode: "all" };
  assert.deepEqual(engine.buildCommand(job).args, ["download", "unsloth/Qwen3-8B-GGUF", "--revision", SHA, "--local-dir", job.target.localDir]);
});

test("a job without compiled patterns downloads exactly its files, escaped", (t) => {
  const { engine, hfHome } = makeEngine(t);
  const job = makeJob(hfHome);
  delete job.transfer.include;
  job.artifact.files = [{ path: "a[1].gguf" }, { path: "b*.json" }];
  assert.deepEqual(engine.buildCommand(job).args.filter((arg) => arg.startsWith("--include=")), ["--include=a[[]1].gguf", "--include=b[*].json"]);
});

test("ModelScope argv uses separate --include items and the pinned revision", (t) => {
  const { engine, hfHome } = makeEngine(t);
  const job = withOptions(makeJob(hfHome), { source: "modelscope", credentialMode: "none" });
  const command = engine.buildCommand(job);
  assert.equal(command.command, "modelscope");
  assert.deepEqual(command.args, [
    "download", "--model", "unsloth/Qwen3-8B-GGUF", "--revision", SHA, "--local_dir", job.target.localDir,
    "--include", "*Q4_K_M*.gguf", "--include", "config.json",
  ]);
});

test("unsafe repo ids, revisions and a missing CLI are refused", (t) => {
  const { engine, hfHome } = makeEngine(t);
  const job = makeJob(hfHome);
  assert.throws(() => engine.buildCommand({ ...job, artifact: { ...job.artifact, repo: "--evil" } }), (error) => error.code === "invalid_transfer_options");
  assert.throws(() => engine.buildCommand({ ...job, artifact: { ...job.artifact, revisionSha: "-x" } }), (error) => error.code === "invalid_transfer_options");
  assert.throws(() => engine.buildCommand({ ...job, target: { localDir: "relative/dir" } }), (error) => error.code === "invalid_transfer_options");
  const none = createCliTransferEngine({ hfCli: "", hfHome, dataDir: path.join(hfHome, "d"), tokens: createTokenVault({}) });
  assert.throws(() => none.buildCommand(job), (error) => error.code === "cli_missing");
});

test("supports() takes cli jobs of the three sources only", (t) => {
  const { engine, hfHome } = makeEngine(t);
  const job = makeJob(hfHome);
  assert.equal(engine.id, "cli");
  assert.equal(engine.supports(job), true);
  assert.equal(engine.supports(withOptions(job, { source: "modelscope" })), true);
  assert.equal(engine.supports(withOptions(job, { source: "ftp" })), false);
  assert.equal(engine.supports({ ...job, transfer: { ...job.transfer, engine: "native" } }), false);
});

test("batching: patterns over the argv budget run as sequential commands in one job", async (t) => {
  const files = Array.from({ length: 40 }, (_, index) => `shards/model-${String(index).padStart(5, "0")}-of-00040.safetensors`);
  const all = [...files, "other/readme.txt", "other/extra.json"];
  // Selecting every second shard forces exact names; a small budget splits them.
  const selected = files.filter((_, index) => index % 2 === 0);
  const include = compileIncludePatterns(selected, all, { argvBudget: 400 });
  assert.equal(include.mode, "include");
  assert.ok(include.batches.length > 1, "the fixture must need several batches");

  const storage = fakeStorage();
  const fake = createFakeSpawn(({ child }) => exitChild(child, 0));
  const { engine, hfHome } = makeEngine(t, { spawnImpl: fake.spawnImpl, modelStorage: storage });
  const job = makeJob(hfHome);
  job.transfer.include = include;
  const batchEvents = [];
  const spawnEvents = [];
  const { exit } = await runToExit(engine, job, {
    onBatch: (event) => batchEvents.push(event.batchIndex),
    onSpawn: (event) => spawnEvents.push([event.batchIndex, event.pid]),
  });
  assert.equal(exit.code, 0);
  assert.equal(fake.calls.length, include.batches.length);
  assert.deepEqual(batchEvents, include.batches.slice(1).map((_, index) => index + 1));
  const sent = fake.calls.flatMap((call) => call.args.filter((arg) => arg.startsWith("--include=")).map((arg) => arg.slice(10)));
  assert.deepEqual(sent, include.patterns);
  for (const call of fake.calls) assert.ok(call.args.join(" ").length < 400 + 200);
  // One lock for the whole job, tracked per process, released once at the end.
  assert.deepEqual(storage.events.map((event) => event[0]), ["acquire", ...include.batches.map(() => "track"), "release"]);
  assert.deepEqual(spawnEvents.map((event) => event[0]), include.batches.map((_, index) => index));
});

test("a persisted batchIndex resumes at that batch, and a failing batch ends the job", async (t) => {
  const fake = createFakeSpawn(({ child }, calls) => exitChild(child, calls.length === 1 ? 1 : 0, { stderr: "boom" }));
  const { engine, hfHome } = makeEngine(t, { spawnImpl: fake.spawnImpl });
  const job = makeJob(hfHome);
  job.transfer.include = { mode: "include", patterns: ["a", "b", "c"], batches: [["a"], ["b"], ["c"]] };
  job.transfer.batchIndex = 1;
  const { exit } = await runToExit(engine, job);
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.calls[0].args.includes("--include=b"));
  assert.equal(exit.code, 1);
  assert.equal(exit.batchIndex, 1);
  assert.deepEqual(exit.stderrTail, ["boom"]);
});

test("the model-storage lock is acquired before spawn, tracked after it and released on exit", async (t) => {
  const storage = fakeStorage();
  const order = [];
  const originalAcquire = storage.acquireOperation;
  storage.acquireOperation = (...args) => { order.push("acquire"); return originalAcquire(...args); };
  const fake = createFakeSpawn(({ child }) => exitChild(child, 0, { stdout: "done\n" }));
  const spawnImpl = (...args) => { order.push("spawn"); return fake.spawnImpl(...args); };
  const { engine, hfHome } = makeEngine(t, { spawnImpl, modelStorage: storage });
  const job = makeJob(hfHome);
  const { exit } = await runToExit(engine, job, { onSpawn: () => order.push("onSpawn") });
  assert.equal(exit.code, 0);
  assert.deepEqual(order.slice(0, 3), ["acquire", "spawn", "onSpawn"]);
  assert.deepEqual(storage.events[0], ["acquire", [path.resolve(job.target.localDir)], "download"]);
  assert.equal(storage.events[1][0], "track");
  assert.equal(storage.events[1][2], fake.calls[0].child.pid);
  assert.deepEqual(storage.events.at(-1), ["release", "abcdef01-2345-6789-abcd-ef0123456789"]);
});

test("a busy target propagates the lock error before any spawn", (t) => {
  const storage = fakeStorage();
  storage.acquireOperation = () => { throw Object.assign(new Error("busy"), { status: 409 }); };
  const fake = createFakeSpawn(() => assert.fail("must not spawn"));
  const { engine, hfHome } = makeEngine(t, { spawnImpl: fake.spawnImpl, modelStorage: storage });
  assert.throws(() => engine.start(makeJob(hfHome), {}), /busy/);
  assert.equal(fake.calls.length, 0);
});

test("a missing CLI releases the lock and classifies as cli_missing", async (t) => {
  const storage = fakeStorage();
  const fake = createFakeSpawn(({ child }) => child.emit("error", Object.assign(new Error("spawn hf ENOENT"), { code: "ENOENT" })));
  const { engine, hfHome } = makeEngine(t, { spawnImpl: fake.spawnImpl, modelStorage: storage });
  const { exit } = await runToExit(engine, makeJob(hfHome));
  assert.equal(exit.code, null);
  assert.equal(exit.error.code, "ENOENT");
  assert.equal(storage.events.at(-1)[0], "release");
  const failure = classifyTransferFailure({ exitCode: exit.code, stderrTail: exit.stderrTail, spawnError: exit.error, source: "huggingface" });
  assert.equal(failure.code, "cli_missing");
});

test("a spawn that throws still reports an exit and releases the lock", async (t) => {
  const storage = fakeStorage();
  const { engine, hfHome } = makeEngine(t, { spawnImpl: () => { throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }); }, modelStorage: storage });
  const { exit } = await runToExit(engine, makeJob(hfHome));
  assert.equal(exit.error.code, "EINVAL");
  assert.equal(storage.events.at(-1)[0], "release");
});

test("spawn gets windowsHide, the job env and no token in argv", async (t) => {
  const { engine, hfHome, tokens } = makeEngine(t);
  const fake = createFakeSpawn(({ child }) => exitChild(child, 0));
  const withSpawn = createCliTransferEngine({ hfCli: "hf", modelScopeCli: "modelscope", hfHome, dataDir: path.join(hfHome, "data"), spawnImpl: fake.spawnImpl, platform: "win32", env: { PATH: "x" }, tokens });
  const tokenRef = await tokens.put(FAKE_TOKEN);
  const job = withOptions(makeJob(hfHome), { credentialMode: "temp-token", tokenRef });
  await runToExit(withSpawn, job);
  const call = fake.calls[0];
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.HF_TOKEN, FAKE_TOKEN);
  assert.equal(call.args.some((arg) => arg.includes(FAKE_TOKEN)), false);
  assert.equal(engine.id, "cli");
});

test("redactor: lines, the stderr ring and the log file never hold a token", async (t) => {
  const { engine, hfHome, dataDir, tokens } = makeEngine(t, {});
  const tokenRef = await tokens.put(PLAIN_TOKEN);
  await tokens.put(FAKE_TOKEN);
  const fake = createFakeSpawn(({ child }) => exitChild(child, 1, {
    stdout: `Authorization: Bearer ${PLAIN_TOKEN}\nplain ${PLAIN_TOKEN} here\nfine line\n`,
    stderr: `401 Client Error for token ${FAKE_TOKEN}\nHF_TOKEN=${PLAIN_TOKEN}\n`,
  }));
  const wired = createCliTransferEngine({
    hfCli: "hf", modelScopeCli: "modelscope", hfHome, dataDir, spawnImpl: fake.spawnImpl, platform: "win32", env: { PATH: "x" }, tokens,
  });
  const job = withOptions(makeJob(hfHome), { credentialMode: "temp-token", tokenRef });
  const { exit, lines } = await runToExit(wired, job);
  const everything = JSON.stringify([lines, exit.stderrTail]);
  assert.equal(everything.includes(PLAIN_TOKEN), false);
  assert.equal(everything.includes(FAKE_TOKEN), false);
  assert.ok(lines.some(([, text]) => text.includes("<redacted>")));
  assert.ok(lines.some(([stream, text]) => stream === "stdout" && text === "fine line"));
  assert.ok(exit.stderrTail.every((line) => !line.includes(PLAIN_TOKEN)));

  const logFile = path.join(dataDir, "logs", `${job.id}.log`);
  const log = fs.readFileSync(logFile, "utf8");
  assert.equal(log.includes(PLAIN_TOKEN), false);
  assert.equal(log.includes(FAKE_TOKEN), false);
  assert.match(log, /<redacted>/);
  assert.match(log, /^> hf download unsloth\/Qwen3-8B-GGUF --revision /);

  // The same redactor, built by hand from the vault's values, gives the same marker.
  const hand = createSecretRedactor({ getSecrets: tokens.values });
  assert.equal(hand.redact(`x ${PLAIN_TOKEN} y`), "x <redacted> y");
  assert.equal(hand.redact("clean"), "clean");
});

test("a custom redactor is used for lines and the file", async (t) => {
  const { hfHome, dataDir } = makeEngine(t);
  const fake = createFakeSpawn(({ child }) => exitChild(child, 0, { stdout: "secret-word appears\n" }));
  const engine = createCliTransferEngine({
    hfCli: "hf", modelScopeCli: "modelscope", hfHome, dataDir, spawnImpl: fake.spawnImpl, platform: "win32", env: { PATH: "x" },
    tokens: createTokenVault({}), redactor: { redact: (text) => text.replace("secret-word", "<redacted>") },
  });
  const job = makeJob(hfHome);
  const { lines } = await runToExit(engine, job);
  assert.ok(lines.some(([, text]) => text === "<redacted> appears"));
  assert.equal(fs.readFileSync(path.join(dataDir, "logs", `${job.id}.log`), "utf8").includes("secret-word"), false);
});

test("the job log rotates at 2 MB", async (t) => {
  const { hfHome, dataDir } = makeEngine(t);
  const chunk = `${"x".repeat(3000)}\n`;
  const fake = createFakeSpawn(({ child }) => {
    // Several write bursts so the buffered writer flushes more than once.
    let burst = 0;
    const timer = setInterval(() => {
      child.stdout.write(chunk.repeat(400));
      burst += 1;
      if (burst === 3) { clearInterval(timer); exitChild(child, 0); }
    }, 300);
  });
  const engine = createCliTransferEngine({ hfCli: "hf", modelScopeCli: "modelscope", hfHome, dataDir, spawnImpl: fake.spawnImpl, platform: "win32", env: { PATH: "x" }, tokens: createTokenVault({}) });
  const job = makeJob(hfHome);
  await runToExit(engine, job);
  const logFile = path.join(dataDir, "logs", `${job.id}.log`);
  assert.ok(fs.existsSync(`${logFile}.1`), "a rotated generation exists");
  assert.ok(fs.statSync(logFile).size <= 2 * 1024 * 1024 + 4000 * 400);
});

test("stop() kills the process tree with taskkill, waits for the exit and does not start another batch", async (t) => {
  const storage = fakeStorage();
  let hfChild = null;
  const fake = createFakeSpawn(({ command, args, child }) => {
    if (command === "taskkill") {
      assert.deepEqual(args, ["/PID", String(hfChild.pid), "/T", "/F"]);
      exitChild(hfChild, 1);
      exitChild(child, 0);
    } else if (command === "hf") {
      hfChild = child;
    }
  });
  const { engine, hfHome } = makeEngine(t, { spawnImpl: fake.spawnImpl, modelStorage: storage });
  const job = makeJob(hfHome);
  job.transfer.include = { mode: "include", patterns: ["a", "b"], batches: [["a"], ["b"]] };
  const exits = [];
  const handle = engine.start(job, { onExit: (exit) => exits.push(exit) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handle.pid, fake.calls[0].child.pid);
  await handle.stop("pause");
  assert.equal(exits.length, 1);
  assert.equal(exits[0].stopReason, "pause");
  assert.equal(fake.calls.filter((call) => call.command === "hf").length, 1);
  assert.equal(storage.events.at(-1)[0], "release");
  await handle.stop("cancel"); // already finished: no-op
});

// ---- Orphans ---------------------------------------------------------------

function orphanFixture(t) {
  const root = tempDir(t);
  const dirOf = (name) => path.join(root, "models", name);
  const jobs = [
    { id: "dl_match", state: "downloading", target: { localDir: dirOf("match") }, transfer: { pid: 1111 } },
    { id: "dl_reused", state: "downloading", target: { localDir: dirOf("reused") }, transfer: { pid: 2222 } },
    { id: "dl_otherdir", state: "materializing", target: { localDir: dirOf("otherdir") }, transfer: { pid: 3333 } },
    { id: "dl_gone", state: "resolving", target: { localDir: dirOf("gone") }, transfer: { pid: 4444 } },
    { id: "dl_idle", state: "queued", target: { localDir: dirOf("idle") }, transfer: { pid: 5555 } },
    { id: "dl_nopid", state: "downloading", target: { localDir: dirOf("nopid") }, transfer: { pid: null } },
  ];
  const cim = {
    1111: { ProcessId: 1111, CreationDate: "2026-10-14T10:00:00", CommandLine: `"hf.exe" download org/match --revision ${SHA} --local-dir ${dirOf("match")}` },
    2222: { ProcessId: 2222, CreationDate: "2026-10-14T11:00:00", CommandLine: `notepad.exe ${dirOf("reused")}\\notes.txt` },
    3333: { ProcessId: 3333, CreationDate: "2026-10-14T11:00:00", CommandLine: `hf.exe download org/other --local-dir ${dirOf("somewhere-else")}` },
  };
  const killed = [];
  const queried = [];
  const fake = createFakeSpawn(({ command, args, child }) => {
    if (command === "powershell") {
      const pid = Number(/ProcessId=(\d+)/.exec(args.join(" "))[1]);
      queried.push({ pid, args });
      exitChild(child, 0, { stdout: cim[pid] ? JSON.stringify(cim[pid]) : "" });
    } else if (command === "taskkill") {
      killed.push(Number(args[1]));
      exitChild(child, 0);
    }
  });
  return { jobs, fake, killed, queried, root };
}

test("orphans: only a command line with `download` and the job's localDir matches", async (t) => {
  const { jobs, fake, killed, queried } = orphanFixture(t);
  const { engine } = makeEngine(t, { spawnImpl: fake.spawnImpl });
  const found = await engine.findOrphans(jobs);
  assert.deepEqual(found, [
    { jobId: "dl_match", pid: 1111, alive: true, matches: true },
    { jobId: "dl_reused", pid: 2222, alive: true, matches: false },
    { jobId: "dl_otherdir", pid: 3333, alive: true, matches: false },
  ]);
  // One CIM query per in-process job with a pid; nothing is killed without { kill: true }.
  assert.deepEqual(queried.map((entry) => entry.pid), [1111, 2222, 3333, 4444]);
  assert.match(queried[0].args.join(" "), /-NoProfile/);
  assert.match(queried[0].args.join(" "), /Get-CimInstance Win32_Process -Filter 'ProcessId=1111'/);
  assert.deepEqual(killed, []);
});

test("orphans: kill terminates exactly the matching process", async (t) => {
  const { jobs, fake, killed } = orphanFixture(t);
  const { engine } = makeEngine(t, { spawnImpl: fake.spawnImpl });
  const found = await engine.findOrphans(jobs, { kill: true });
  assert.deepEqual(killed, [1111]);
  assert.deepEqual(found.filter((entry) => entry.killed).map((entry) => entry.jobId), ["dl_match"]);
});

test("orphans: unparsable or array CIM output is handled", async (t) => {
  const root = tempDir(t);
  const localDir = path.join(root, "m");
  const outputs = ["not json", JSON.stringify([{ ProcessId: 9, CommandLine: `hf download x --local-dir ${localDir}` }])];
  const fake = createFakeSpawn(({ child }) => exitChild(child, 0, { stdout: outputs.shift() }));
  const { engine } = makeEngine(t, { spawnImpl: fake.spawnImpl });
  const jobs = [1, 2].map((pid) => ({ id: `dl_${pid}`, state: "downloading", target: { localDir }, transfer: { pid } }));
  const found = await engine.findOrphans(jobs);
  assert.deepEqual(found.map((entry) => [entry.jobId, entry.matches]), [["dl_2", true]]);
});

test("commandLineMatches ignores case and slash style", () => {
  assert.equal(commandLineMatches("HF.EXE Download org/x --local-dir D:/Models/X", "d:\\models\\x"), true);
  assert.equal(commandLineMatches("hf.exe upload org/x --local-dir D:\\models\\x", "D:\\models\\x"), false);
  assert.equal(commandLineMatches("hf.exe download org/x", ""), false);
  assert.equal(commandLineMatches("", "D:\\models\\x"), false);
});
