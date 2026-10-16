"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runDoctor, createDefaultProbes, CHECK_IDS } = require("../platform/doctor");
const { hashBuildInputs, parseWsl, parseWslConfig, parseGpuCsv } = require("../platform/doctor-probes");
const { fixture, normalized, PINNED_IMAGE, AT } = require("./helpers/doctor-fixture");

function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-doctor-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function check(report, id) { const found = report.checks.find((row) => row.id === id); assert.ok(found, id); return found; }

test("runDoctor emits the report contract and fixed fixture world matches golden", async (t) => {
  const root = temporary(t), options = fixture(root), report = await runDoctor(options);
  assert.equal(report.schemaVersion, 1); assert.equal(report.at, AT); assert.equal(report.durationMs, 0);
  assert.equal(report.checks.length, 41);
  assert.deepEqual(report.summary, { ok: 25, warn: 4, fail: 2, info: 6, skip: 4 });
  for (const row of report.checks) {
    assert.deepEqual(Object.keys(row), ["id", "group", "status", "title", "detail", "data", "durationMs", "fix", "actions"]);
    assert.ok(row.title["zh-CN"] && row.title["en-US"]);
    assert.equal(row.durationMs, 0);
  }
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "platform", "doctor-golden.json"), "utf8"));
  assert.deepEqual(normalized(report, root), golden);
  assert.equal(require("..").platform.doctor.runDoctor, runDoctor);
  assert.equal(require("..").runDoctor, undefined);
  assert.ok(CHECK_IDS.includes("env.deps.*"));
});

test("group and exact/dynamic id filters invoke only selected probes", async (t) => {
  const options = fixture(temporary(t)), calls = [];
  options.probes = new Proxy(options.probes, { get(target, name) { const value = target[name]; return (...args) => { calls.push(name); return typeof value === "function" ? value(...args) : value; }; } });
  options.ids = ["env.git"]; options.isWorktree = false;
  assert.deepEqual((await runDoctor(options)).checks.map((row) => row.id), ["env.git"]);
  assert.deepEqual(calls, ["tool"]);
  options.ids = ["env.deps.*"]; calls.length = 0;
  assert.equal((await runDoctor(options)).checks.length, 2);
  assert.deepEqual(calls, ["dependencyState", "dependencyState"]);
  options.ids = undefined; options.groups = ["storage"]; calls.length = 0;
  assert.equal((await runDoctor(options)).checks.length, 5);
  assert.ok(calls.every((name) => ["diskSpace", "modelRoots", "dockerData", "writable"].includes(name)));
});

test("probe exceptions become redacted check failures and other checks continue", async (t) => {
  const options = fixture(temporary(t)), secret = "opaque-fixture-doctor-secret-01234";
  options.probes.dockerCli = () => { throw Object.assign(new Error(`fixture ${secret} ${"sk-" + "fixture0123456789abcdef"}`), { code: "fixture_probe_error" }); };
  options.getSecrets = () => [secret];
  const report = await runDoctor(options), failed = check(report, "runtime.docker-cli");
  assert.equal(failed.status, "fail"); assert.equal(failed.data.code, "fixture_probe_error");
  assert.ok(failed.detail.includes("<redacted>"));
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.equal(check(report, "env.node-version").status, "ok");
});

test("non-deep run skips GPU execution; deep needs a present pinned image and --pull never", async (t) => {
  const options = fixture(temporary(t)); options.ids = ["runtime.gpu-in-docker"];
  let calls = 0, command;
  options.probes.gpuDocker = (request) => { calls += 1; command = request; return { ok: true }; };
  assert.equal((await runDoctor(options)).checks[0].status, "skip"); assert.equal(calls, 0);
  options.deep = true;
  assert.equal((await runDoctor(options)).checks[0].status, "skip"); assert.equal(calls, 0);
  options.probes.images = (rows) => rows.map((row) => ({ image: row.image, present: true }));
  assert.equal((await runDoctor(options)).checks[0].status, "ok"); assert.equal(calls, 1);
  assert.equal(command.image, PINNED_IMAGE);
  assert.deepEqual(command.argv.slice(0, 8), ["run", "--rm", "--pull", "never", "--network", "none", "--gpus", "all"]);
  assert.ok(!command.argv.some((arg) => ["pull", "rm", "-v", "--mount", "--label"].includes(arg)));
  options.probes.gpuDocker = { ok: false };
  assert.equal((await runDoctor(options)).checks[0].status, "fail");
});

test("one Windows facts batch is shared across concurrent default consumers", async (t) => {
  const root = temporary(t), calls = [];
  const ctx = { aiRoot: root, env: {}, platform: "win32" };
  const defaults = createDefaultProbes(ctx, { execFile(command, args, options, callback) { calls.push({ command, args, options }); callback(null, JSON.stringify({ pwsh: { present: true, version: "7.5.0" }, powershell: { present: true, version: "5.1.0" }, totalMemoryBytes: 128 * 1024 ** 3, processes: [] }), ""); } });
  ctx.probe = (name, ...args) => defaults[name](...args);
  await Promise.all([defaults.windowsFacts(), defaults.windowsFacts(), defaults.tool("pwsh"), defaults.wslConfig(), defaults.mcpBuild({ dir: "platform-mcp", build: { stamp: "dist/.build-stamp.json", inputs: ["src/**/*.ts"] } })]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].options.windowsHide, true);
  assert.match(calls[0].args.at(-1), /Get-CimInstance/);
  assert.match(calls[0].args.at(-1), /Get-ScheduledTask/);
  assert.match(calls[0].args.at(-1), /Get-NetFirewallPortFilter/);
});

test("default external probes render read-only commands and only explicit deep run uses a GPU container", async (t) => {
  const calls = [], ctx = { aiRoot: temporary(t), env: { DOCKER_WSL_DISTRO: "fixture-distro" }, platform: "win32", value: () => "" };
  const defaults = createDefaultProbes(ctx, { execFile(command, args, options, callback) {
    calls.push({ command, args, options });
    const text = command === "nvidia-smi" ? "581.15, Fixture GPU, 12.0, 98304" : command === "wsl.exe" && args[0] === "-l" ? Buffer.from("  NAME STATE VERSION\r\n* fixture-distro Running 2\r\n", "utf16le") : "fixture-response";
    callback(null, text, "");
  } });
  await Promise.all([defaults.dockerCli(), defaults.dockerDaemon(), defaults.wsl(), defaults.nvidia(), defaults.images([{ image: PINNED_IMAGE }])]);
  assert.ok(calls.every((call) => call.options.windowsHide === true));
  const dockerCalls = calls.filter((call) => call.args.includes("--exec"));
  assert.equal(dockerCalls.length, 3);
  assert.ok(dockerCalls.every((call) => call.args.slice(0, 4).join(" ") === "-d fixture-distro --exec docker"));
  assert.ok(!calls.some((call) => call.args.some((arg) => ["pull", "rm", "run", "start", "stop"].includes(arg))));
  await assert.rejects(defaults.gpuDocker({ image: "fixture:tag", argv: ["run", "--pull", "never"] }), { code: "unsafe_gpu_probe" });
  const argv = ["run", "--rm", "--pull", "never", "--gpus", "all", "--entrypoint", "nvidia-smi", PINNED_IMAGE];
  await defaults.gpuDocker({ image: PINNED_IMAGE, argv });
  const deep = calls.at(-1).args.slice(4);
  assert.deepEqual(deep.slice(0, -3), argv.slice(0, -1));
  assert.equal(deep.at(-3), "--name"); assert.match(deep.at(-2), /^ai-doctor-gpu-[a-f0-9]{24}$/); assert.equal(deep.at(-1), PINNED_IMAGE);
});

test("secret-store failures suppress opaque diagnostic data and return a complete failed report", async (t) => {
  const root = temporary(t), options = fixture(root), opaque = "opaque-fixture-unavailable-vault-01234";
  options.ids = ["runtime.docker-cli"];
  options.probes.dockerCli = { present: true, version: opaque, extra: { token: opaque } };
  options.getSecrets = () => { throw new Error(`unavailable ${opaque}`); };
  const report = await runDoctor(options);
  assert.equal(report.checks[0].status, "fail");
  assert.equal(report.checks[0].data.code, "secret_redaction_unavailable");
  assert.ok(!JSON.stringify(report).includes(opaque));
  delete options.getSecrets;
  fs.mkdirSync(path.join(root, ".runtime", "secrets"), { recursive: true });
  fs.writeFileSync(path.join(root, ".runtime", "secrets", "platform.json"), "not valid JSON");
  assert.equal((await runDoctor(options)).checks[0].data.code, "secret_redaction_unavailable");
});

test("deep GPU timeout removes only its own unique probe name through the configured Docker host", async (t) => {
  const calls = [], ctx = { aiRoot: temporary(t), env: { DOCKER_WSL_DISTRO: "fixture-distro" }, platform: "win32", value: () => "" };
  const defaults = createDefaultProbes(ctx, { execFile(command, args, options, callback) {
    calls.push({ command, args, options });
    if (args.includes("run")) callback(Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT", killed: true }));
    else callback(null, "removed fixture probe", "");
  } });
  const argv = ["run", "--rm", "--pull", "never", "--gpus", "all", "--entrypoint", "nvidia-smi", PINNED_IMAGE];
  await assert.rejects(defaults.gpuDocker({ image: PINNED_IMAGE, argv }), { code: "ETIMEDOUT" });
  assert.equal(calls.length, 2);
  const name = calls[0].args[calls[0].args.indexOf("--name") + 1];
  assert.match(name, /^ai-doctor-gpu-[a-f0-9]{24}$/);
  assert.deepEqual(calls[1].args, ["-d", "fixture-distro", "--exec", "docker", "rm", "-f", name]);
  assert.ok(!calls.some((call) => call.args.some((arg) => /^vllm-local|^llama-local/.test(arg))));
});

test("default writable probe creates/removes only its unique files in a temporary root", async (t) => {
  const root = temporary(t), defaults = createDefaultProbes({ aiRoot: root, env: {}, platform: "win32" });
  const directories = ["config", "logs", ".runtime"].map((name) => path.join(root, name));
  directories.forEach((dir) => fs.mkdirSync(dir));
  const preserved = path.join(directories[0], "existing.json"); fs.writeFileSync(preserved, "preserve");
  const before = directories.map((dir) => fs.readdirSync(dir));
  assert.ok((await defaults.writable(directories)).every((result) => result.writable));
  assert.deepEqual(directories.map((dir) => fs.readdirSync(dir)), before);
  const absent = path.join(root, "missing");
  assert.equal((await defaults.writable([absent]))[0].writable, false);
  assert.equal(fs.existsSync(absent), false);
  assert.equal(fs.readFileSync(preserved, "utf8"), "preserve");
});

test("default dependency probe uses lock hashes and installed package versions without npm", async (t) => {
  const root = temporary(t), directory = path.join(root, "fixture-package"); fs.mkdirSync(path.join(directory, "node_modules"), { recursive: true });
  const lock = { packages: { "": { version: "1" }, "node_modules/a": { version: "1.2.3" }, "node_modules/optional": { optional: true, version: "1" } } };
  fs.writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify(lock));
  fs.writeFileSync(path.join(directory, "node_modules", ".package-lock.json"), JSON.stringify({ packages: { "node_modules/a": { version: "1.2.3" } } }));
  const defaults = createDefaultProbes({ aiRoot: root, env: {}, platform: "linux" });
  const first = defaults.dependencyState({ dir: "fixture-package" });
  assert.equal(first.installed, true); assert.equal(first.recordedHash, null); assert.equal(first.versionsMatch, true);
  fs.mkdirSync(path.join(root, ".runtime", "platform"), { recursive: true });
  fs.writeFileSync(path.join(root, ".runtime", "platform", "deps-state.json"), JSON.stringify({ packages: { "fixture-package": { lockSha256: first.lockHash } } }));
  assert.equal(defaults.dependencyState({ dir: "fixture-package" }).recordedHash, first.lockHash);
  fs.writeFileSync(path.join(directory, "node_modules", ".package-lock.json"), JSON.stringify({ packages: { "node_modules/a": { version: "2" } } }));
  assert.equal(defaults.dependencyState({ dir: "fixture-package" }).versionsMatch, false);
});

test("build-input hashes include nested source edits and ignore generated/dependency files", (t) => {
  const directory = temporary(t); fs.mkdirSync(path.join(directory, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(directory, "src", "nested", "main.ts"), "fixture one");
  const first = hashBuildInputs(directory, ["src/**/*.ts"]);
  fs.mkdirSync(path.join(directory, "dist")); fs.writeFileSync(path.join(directory, "dist", "main.ts"), "ignored");
  assert.equal(hashBuildInputs(directory, ["src/**/*.ts"]), first);
  fs.writeFileSync(path.join(directory, "src", "nested", "main.ts"), "fixture two");
  assert.notEqual(hashBuildInputs(directory, ["src/**/*.ts"]), first);
});

test("WSL UTF-16 en/zh output, configuration units and NVIDIA fields parse without CUDA query fields", () => {
  assert.deepEqual(parseWsl(Buffer.from("\uFEFF  名称 状态 版本\r\n* docker-desktop 正在运行 2\r\n", "utf16le")), [{ name: "docker-desktop", state: "正在运行", version: 2 }]);
  assert.deepEqual(parseWsl(" NAME STATE VERSION\n docker-desktop Running 2"), [{ name: "docker-desktop", state: "Running", version: 2 }]);
  assert.deepEqual(parseWslConfig("[wsl2]\nmemory=49152MB\nswap=0\n[other]\nmemory=1GB"), { memoryGb: 48, swapGb: 0, invalid: [] });
  assert.deepEqual(parseWslConfig("[wsl2]\nmemory=wrong"), { memoryGb: null, swapGb: null, invalid: ["memory"] });
  assert.equal(parseGpuCsv("581.15, Fixture GPU, 12.0, 98304")[0].memoryMb, 98304);
  assert.throws(() => parseGpuCsv("not a GPU"), { code: "invalid_gpu_data" });
});
