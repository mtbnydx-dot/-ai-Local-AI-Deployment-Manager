const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const { spawnSync } = require("node:child_process");
const harness = require("./helpers/engine-golden-stubs");

// 01-engines §8.3: the capture harness. The goldens themselves are asserted by
// the engines-golden-legacy tests of both managers.
const SCRIPT = path.join(harness.REPO_ROOT, "scripts", "capture-engine-goldens.js");
const FIXTURES_DIR = path.dirname(harness.GOLDEN_DIR);

function capture(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: harness.REPO_ROOT, encoding: "utf8", timeout: 5 * 60 * 1000 });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-golden-capture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readTree(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name)).toString("base64")]));
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function withoutHistory({ history: _history, ...rest }) {
  return rest;
}

function managerModule(file) {
  return require(path.join(harness.REPO_ROOT, ...file.split("/")));
}

// Replacement modules that run the real builders and then apply one mutation,
// the way a faulty adapter would; runGoldenFixture takes them as overrides.
function builderOverrides(mutate) {
  const vllm = managerModule("vllm-manager/lib/runtime-command.js");
  const llama = managerModule("llama-manager/lib/runtime-command.js");
  return {
    vllmRuntimeCommand: {
      ...vllm,
      createVllmRuntimeCommandBuilder(deps) {
        const builder = vllm.createVllmRuntimeCommandBuilder(deps);
        return { ...builder, buildVllmRuntimeCommand: (job, opts) => mutate(builder.buildVllmRuntimeCommand(job, opts)) };
      },
    },
    llamaRuntimeCommand: {
      ...llama,
      createLlamaRuntimeCommandBuilder(deps) {
        const builder = llama.createLlamaRuntimeCommandBuilder(deps);
        return { ...builder, buildLlamaRuntimeCommand: (job, opts) => mutate(builder.buildLlamaRuntimeCommand(job, opts)) };
      },
    },
  };
}

// The same for the launch requests: the run options reach runStartJob mutated.
function requestOverrides(mutateOptions) {
  const vllm = managerModule("vllm-manager/lib/launch-request.js");
  const llama = managerModule("llama-manager/lib/launch-request.js");
  const wrap = (deps) => ({ ...deps, runStartJob: (job, options) => deps.runStartJob(job, mutateOptions(options)) });
  return {
    vllmLaunchRequest: { ...vllm, createVllmStartRuntimeRequest: (deps) => vllm.createVllmStartRuntimeRequest(wrap(deps)) },
    llamaLaunchRequest: { ...llama, createLlamaStartRuntimeRequest: (deps) => llama.createLlamaStartRuntimeRequest(wrap(deps)) },
  };
}

// True when the fixture still passes with these modules; a harness error (for
// example a secretEnv value that is no fixture secret) counts as caught.
async function reproduces(fixture, overrides = {}) {
  try {
    return util.isDeepStrictEqual(await harness.runGoldenFixture(fixture, overrides), fixture.expect);
  } catch {
    return false;
  }
}

function goldenByCode() {
  return new Map(harness.loadGoldenFixtures().map((fixture) => [fixture.id.split("-").slice(0, 2).join("-"), fixture]));
}

test("--check is clean on the committed goldens", () => {
  const result = capture(["--check"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /51 fixture\(s\) match the current builders/);
});

test("a write without --reason is refused and writes nothing", (t) => {
  const dir = tempDir(t);
  const result = capture(["--write", "all", "--out", dir]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /without --reason/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("two captures are byte-identical and equal the committed goldens", (t) => {
  const committed = harness.loadGoldenFixtures();
  const [initial] = committed[0].history;
  const first = tempDir(t);
  const second = tempDir(t);
  for (const dir of [first, second]) {
    const result = capture(["--write", "all", "--reason", initial.reason, "--at", initial.at, "--out", dir]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  assert.deepEqual(readTree(first), readTree(second));
  assert.equal(Object.keys(readTree(first)).length, committed.length);
  for (const fixture of committed) {
    const fresh = JSON.parse(fs.readFileSync(path.join(first, `${fixture.id}.json`), "utf8"));
    assert.deepEqual(withoutHistory(fresh), withoutHistory(fixture), fixture.id);
  }
});

test("a rewrite leaves unchanged fixtures alone and appends history to a changed one", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "G-V4-vllm-qwen38-positional.json");
  assert.equal(capture(["--write", "G-V4,R-V2", "--reason", "first capture", "--at", "2026-01-01", "--out", dir]).status, 0);
  const before = readTree(dir);
  assert.equal(capture(["--write", "G-V4,R-V2", "--reason", "nothing changed", "--at", "2026-01-02", "--out", dir]).status, 0);
  assert.deepEqual(readTree(dir), before);

  const tampered = JSON.parse(fs.readFileSync(file, "utf8"));
  tampered.expect.runArgs[tampered.expect.runArgs.indexOf("--max-num-seqs") + 1] = "64";
  fs.writeFileSync(file, `${JSON.stringify(tampered, null, 2)}\n`);
  const check = capture(["--check", "G-V4", "--out", dir]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /--- expect\.runArgs \(fixture\)/);
  assert.match(check.stderr, /^-"64"$/m);
  assert.match(check.stderr, /^\+"4"$/m);

  assert.equal(capture(["--write", "G-V4", "--reason", "restore", "--at", "2026-01-03", "--out", dir]).status, 0);
  const restored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(restored.history, [{ at: "2026-01-01", reason: "first capture" }, { at: "2026-01-03", reason: "restore" }]);
  assert.equal(capture(["--check", "G-V4,R-V2", "--out", dir]).status, 0);
});

test("fixtures carry no machine data or secret and nothing under fixtures/engines is git-ignored", (t) => {
  const files = listFiles(FIXTURES_DIR);
  assert.ok(files.length >= 51);
  for (const file of files) {
    assert.deepEqual(harness.findMachineData(fs.readFileSync(file, "utf8")), [], path.relative(FIXTURES_DIR, file));
  }
  const inside = spawnSync("git", ["-C", harness.REPO_ROOT, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    t.diagnostic("not a git work tree; the ignore check is skipped");
    return;
  }
  const relative = files.map((file) => path.relative(harness.REPO_ROOT, file).split(path.sep).join("/"));
  const ignored = spawnSync("git", ["-C", harness.REPO_ROOT, "check-ignore", "--no-index", "--stdin"], { input: relative.join("\n"), encoding: "utf8" });
  assert.equal(ignored.stdout.trim(), "", "git check-ignore matched fixture files");
});

test("model samples materialise their checkpoint files under the fixture model library", () => {
  const environment = harness.prepareGoldenEnvironment();
  harness.materializeModelSample("qwen38-27b-fp8-mtp", environment);
  const index = JSON.parse(fs.readFileSync(path.join(environment.modelsRoot, "Qwen-Qwen3.8-27B-FP8", "model.safetensors.index.json"), "utf8"));
  assert.ok(Object.keys(index.weight_map).some((name) => name.startsWith("mtp.")));
  harness.materializeModelSample("gguf-qwen3-8b", environment);
  const { inspectGgufFileSync } = require("../gguf-metadata");
  const inspected = inspectGgufFileSync(path.join(environment.modelsRoot, "Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf"), { cache: false });
  assert.equal(inspected.metadataError, "");
  assert.equal(inspected.architecture, "qwen3");
  assert.equal(inspected.role, "model");
});

test("fixture values reach the code with their declared separators and come back unchanged", () => {
  const environment = harness.prepareGoldenEnvironment();
  const forwardRoot = environment.root.replaceAll("\\", "/");
  const backslashRoot = environment.root.replaceAll("/", "\\");
  const { apiKey, hfToken } = harness.FAKE_SECRETS;
  assert.equal(harness.materializeValue("C:/fixture/models/X", environment), `${forwardRoot}/models/X`);
  assert.equal(harness.materializeValue("C:\\fixture\\models\\X", environment), `${backslashRoot}\\models\\X`);
  assert.equal(harness.materializeValue("C:/fixture", environment), forwardRoot);
  assert.equal(harness.materializeValue("<secret:apiKey>", environment), apiKey);
  for (const bad of ["C:/fixturex/models", "-v C:/fixture/models", "C:/fixture\\models", "<secret:password>"]) {
    assert.throws(() => harness.materializeValue(bad, environment), Error, bad);
  }
  for (const value of ["C:/fixture/models/X", "C:\\fixture\\models\\X", "C:/fixture", "<secret:apiKey>", "<secret:hfToken>"]) {
    assert.equal(harness.canonicalizeValue(harness.materializeValue(value, environment), environment), value);
  }
  const nativeRoot = process.platform === "win32" ? harness.CANONICAL_ROOT_BACKSLASH : harness.CANONICAL_ROOT;
  const nativeSeparator = process.platform === "win32" ? "\\" : "/";
  assert.equal(harness.canonicalizeValue(`${path.join(environment.root, "models", "X")}:/models`, environment), `${nativeRoot}${nativeSeparator}models${nativeSeparator}X:/models`);
  assert.equal(harness.canonicalizeValue(`${forwardRoot}/models\\X`, environment), "C:/fixture/models\\X");
  assert.deepEqual(harness.canonicalizeValue(["--api-key", apiKey, `ref-${apiKey}`, `Bearer ${hfToken}`, harness.REDACTED], environment), [
    "--api-key", "<secret:apiKey>", "ref-<secret:apiKey>", "Bearer <secret:hfToken>", harness.REDACTED,
  ]);
});

test("a key replaced by the redaction marker fails the goldens that carry it", async () => {
  const byCode = goldenByCode();
  const key = harness.FAKE_SECRETS.apiKey;
  const marker = harness.REDACTED;
  for (const code of ["G-S3", "G-V1", "G-L2", "R-V1", "R-V3", "R-L1"]) {
    assert.equal(await reproduces(byCode.get(code)), true, `${code} passes unmutated`);
  }
  // SGLang delivers the key in argv (08 O1).
  const argvMarker = builderOverrides((result) => ({ ...result, runArgs: result.runArgs.map((arg) => String(arg).split(key).join(marker)) }));
  assert.equal(await reproduces(byCode.get("G-S3"), argvMarker), false, "G-S3 with --api-key <redacted>");
  // vLLM and llama.cpp deliver it through secretEnv.
  const envMarker = builderOverrides((result) => ({
    ...result,
    secretEnv: Object.fromEntries(Object.entries(result.secretEnv || {}).map(([name, value]) => [name, value === key ? marker : value])),
  }));
  for (const code of ["G-V1", "G-L2"]) assert.equal(await reproduces(byCode.get(code), envMarker), false, `${code} with a marker in secretEnv`);
  // The launch requests hand the key to the start job.
  const optionsMarker = requestOverrides((options) => ({
    ...options,
    ...(options.vllmApiKey ? { vllmApiKey: marker } : {}),
    ...(options.llamaApiKey ? { llamaApiKey: marker } : {}),
  }));
  for (const code of ["R-V1", "R-V3", "R-L1"]) assert.equal(await reproduces(byCode.get(code), optionsMarker), false, `${code} with a marker in runOptions`);
});

test("swapped secret env values fail the goldens that carry both secrets", async () => {
  const byCode = goldenByCode();
  const swapped = builderOverrides((result) => {
    const names = Object.keys(result.secretEnv || {}).sort();
    if (names.length !== 2) return result;
    return { ...result, secretEnv: { [names[0]]: result.secretEnv[names[1]], [names[1]]: result.secretEnv[names[0]] } };
  });
  for (const code of ["G-V1", "G-L2"]) {
    assert.deepEqual(byCode.get(code).expect.secretEnvNames.length, 2, code);
    assert.equal(await reproduces(byCode.get(code), swapped), false, code);
  }
});

test("a separator change in the docker arguments fails every profile golden", { skip: process.platform !== "win32" && "the goldens are captured on Windows" }, async () => {
  const profiles = harness.loadGoldenFixtures().filter((fixture) => fixture.kind === "profile");
  assert.equal(profiles.length, 15);
  assert.equal(await reproduces(profiles[0]), true, `${profiles[0].id} passes unmutated`);
  const forwardSlashes = builderOverrides((result) => ({ ...result, runArgs: result.runArgs.map((arg) => String(arg).replaceAll("\\", "/")) }));
  for (const fixture of profiles) assert.equal(await reproduces(fixture, forwardSlashes), false, fixture.id);
});
