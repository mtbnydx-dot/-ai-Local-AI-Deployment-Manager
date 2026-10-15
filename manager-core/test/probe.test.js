"use strict";

// Pre-launch dry probe (docs/overhaul/02-models.md section 12, MOD-13): the
// sandbox argv, the fake-docker parsing of both probe shapes, the single
// registries write through engines.runtimeFacts.put, the 409 for a missing
// image (never a pull), timeouts and the stored results that compatibility.js
// reads as support evidence. Docker is a fake runner; nothing here starts a
// container, pulls an image or touches the live data (temp roots only).

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The process-wide registry reads bundled data only.
const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "probe-reference-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_DIR;
test.after(() => fs.rmSync(EMPTY_DIR, { recursive: true, force: true }));

const core = require("..");
const { createEngineRegistry } = require("../engines/registry");
const { createRuntimeFacts } = require("../engines/runtime-facts");
const { registerModelInspectorRoutes } = require("../model-inspector-routes");
const probe = require("../model-inspector/probe");

const { buildProbeCommand, runProbe, parseProbeOutput, PROBE_MARKER } = probe;
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const DIGEST = `sha256:${"a".repeat(64)}`;
const NAME = "ai-probe-abcd2345";
const MODEL_DIR = path.join(os.tmpdir(), "probe-models", "example-model");

// ----- helpers

function tempRoot(t, prefix = "probe-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function walk(dir) {
  const files = [];
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

/** A docker runner that records every call; handlers answer by the first argument. */
function fakeDocker(handlers = {}) {
  const calls = [];
  const runner = async (args, options) => {
    calls.push({ args: [...args], options });
    const handler = handlers[args[0]];
    if (!handler) return { stdout: "", stderr: "", error: null };
    const answer = typeof handler === "function" ? await handler(args, options, calls.length) : handler;
    return { stdout: "", stderr: "", error: null, ...answer };
  };
  runner.calls = calls;
  runner.verbs = () => calls.map((call) => call.args[0]);
  return runner;
}

function markerLine(overrides = {}) {
  const facts = {
    engineVersion: "0.28.0",
    transformersVersion: "5.15.1",
    python: "3.12.3",
    config: { ok: true, modelType: "qwen3", architectures: ["Qwen3ForCausalLM"], error: null },
    archSupported: true,
    needsRemoteCode: false,
    registryArchitectures: ["LlamaForCausalLM", "Qwen3ForCausalLM"],
    modelTypes: ["llama", "qwen3"],
    toolParsers: ["hermes", "qwen3_coder"],
    reasoningParsers: ["deepseek_r1", "qwen3"],
    quantMethods: ["awq", "fp8"],
    kvCacheDtypes: ["auto", "fp8"],
    plugins: { gguf: true, bnb: false },
    errors: [],
    ...overrides,
  };
  // library banners precede the marker on stdout
  return `INFO 10-14 loading registry\nWARNING something noisy\n${PROBE_MARKER} ${JSON.stringify(facts)}\n`;
}

function pythonCommand(extra = {}) {
  return buildProbeCommand({
    engineId: "vllm",
    runtime: { runtimeId: "vllm@0.28.0", image: "vllm/vllm-openai:example", imageId: IMAGE_ID },
    modelDir: MODEL_DIR,
    name: NAME,
    ...extra,
  });
}

function llamaCommand(extra = {}) {
  return buildProbeCommand({
    engineId: "llamacpp",
    runtime: { runtimeId: "llamacpp@b10630", image: "ghcr.io/example/llama.cpp:server-cuda", imageId: IMAGE_ID },
    modelDir: MODEL_DIR,
    modelFile: "model-Q4_K_M.gguf",
    name: NAME,
    ...extra,
  });
}

function runtimeFactsStore(t, { imageId = IMAGE_ID } = {}) {
  const root = tempRoot(t, "probe-facts-");
  const registry = createEngineRegistry({ overrideDir: path.join(root, "config"), env: {} });
  const facts = createRuntimeFacts({ aiRoot: root, registry, resolveImageId: async () => imageId });
  return { root, registry, facts };
}

function flagValues(argv, flag) {
  const values = [];
  argv.forEach((item, index) => { if (item === flag) values.push(argv[index + 1]); });
  return values;
}

/** A fake clock: sleep advances it, so the llama loop runs in no time. */
function fakeClock() {
  let time = 1_000_000;
  return { now: () => time, sleep: async (ms) => { time += ms; }, advance: (ms) => { time += ms; } };
}

// ----- the container command

test("the python probe argv is a sandbox: no network, read-only mounts, no GPU, no pull, one probe label", () => {
  const { argv, name, timeoutMs, kind } = pythonCommand();
  assert.equal(kind, "registry");
  assert.equal(name, NAME);
  assert.equal(timeoutMs, 90_000);
  assert.equal(argv[0], "run");
  assert.ok(argv.includes("--rm"));
  assert.deepEqual(flagValues(argv, "--network"), ["none"]);
  assert.deepEqual(flagValues(argv, "--pull"), ["never"]);
  assert.ok(argv.includes("--read-only"));
  assert.deepEqual(flagValues(argv, "--cap-drop"), ["ALL"]);
  assert.deepEqual(flagValues(argv, "--security-opt"), ["no-new-privileges"]);
  assert.deepEqual(flagValues(argv, "--memory"), ["8g"]);
  assert.deepEqual(flagValues(argv, "--pids-limit"), ["256"]);
  assert.deepEqual(flagValues(argv, "--tmpfs"), ["/tmp:rw,size=256m"]);
  assert.deepEqual(flagValues(argv, "--label"), ["ai.probe=model-inspector"]);
  assert.deepEqual(flagValues(argv, "--entrypoint"), ["python3"]);
  for (const forbidden of ["--gpus", "--privileged", "--runtime", "--network=host", "--ipc=host", "-p", "--publish", "--device", "--user"]) {
    assert.ok(!argv.includes(forbidden), forbidden);
  }
  assert.ok(!argv.join(" ").includes("ai.manager"), "no ai.manager label");
  for (const env of ["HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1", "PYTHONDONTWRITEBYTECODE=1"]) assert.ok(flagValues(argv, "-e").includes(env), env);
  const mounts = flagValues(argv, "-v");
  assert.equal(mounts.length, 2);
  for (const mount of mounts) assert.match(mount, /:ro$/);
  assert.equal(mounts[0], `${MODEL_DIR}:/probe/model:ro`);
  assert.equal(mounts[1], `${path.resolve(__dirname, "..", "model-inspector", "probe-scripts")}:/probe/bin:ro`);
  // The immutable image ID runs, then the isolated interpreter and the fixed script.
  const imageIndex = argv.indexOf(IMAGE_ID);
  assert.ok(imageIndex > 0);
  assert.deepEqual(argv.slice(imageIndex + 1), ["-I", "/probe/bin/hf_probe.py", "--model", "/probe/model", "--engine", "vllm"]);
  assert.ok(fs.existsSync(path.join(__dirname, "..", "model-inspector", "probe-scripts", "hf_probe.py")));
});

test("the remote-code flag exists only with explicit consent (exactly true)", () => {
  assert.ok(!pythonCommand().argv.includes("--trust-remote-code"));
  assert.ok(!pythonCommand({ allowRemoteCode: false }).argv.includes("--trust-remote-code"));
  for (const loose of ["true", 1, "yes", {}, []]) {
    assert.ok(!pythonCommand({ allowRemoteCode: loose }).argv.includes("--trust-remote-code"), String(loose));
  }
  const consented = pythonCommand({ allowRemoteCode: true });
  assert.equal(consented.argv.at(-1), "--trust-remote-code");
  assert.equal(consented.allowRemoteCode, true);
  // Remote code is a Python concept: the llama.cpp header load has no such flag.
  assert.ok(!llamaCommand({ allowRemoteCode: true }).argv.includes("--trust-remote-code"));
});

test("the llama.cpp header-load argv matches section 12.2 and carries the same sandbox", () => {
  const { argv, timeoutMs, kind, modelFile } = llamaCommand();
  assert.equal(kind, "header");
  assert.equal(timeoutMs, 30_000);
  assert.equal(modelFile, "model-Q4_K_M.gguf");
  assert.deepEqual(flagValues(argv, "--network"), ["none"]);
  assert.deepEqual(flagValues(argv, "--pull"), ["never"]);
  assert.ok(argv.includes("--read-only"));
  assert.deepEqual(flagValues(argv, "--cap-drop"), ["ALL"]);
  assert.deepEqual(flagValues(argv, "--security-opt"), ["no-new-privileges"]);
  assert.deepEqual(flagValues(argv, "--memory"), ["4g"]);
  assert.deepEqual(flagValues(argv, "--tmpfs"), ["/tmp:rw,size=64m"]);
  assert.deepEqual(flagValues(argv, "--label"), ["ai.probe=model-inspector"]);
  assert.ok(!argv.includes("--gpus"));
  assert.ok(!argv.join(" ").includes("ai.manager"));
  assert.deepEqual(flagValues(argv, "-v"), [`${MODEL_DIR}:/probe/model:ro`]);
  assert.ok(!argv.includes("--entrypoint"), "the llama image keeps its own entrypoint");
  const imageIndex = argv.indexOf(IMAGE_ID);
  assert.deepEqual(argv.slice(imageIndex + 1), [
    "-m", "/probe/model/model-Q4_K_M.gguf", "--ctx-size", "256", "-ngl", "0", "--no-warmup", "--no-repack",
    "-t", "2", "--host", "127.0.0.1", "--port", "18080",
  ]);
  // Detached so the log can be read: the container is removed explicitly, never --rm.
  assert.equal(argv[1], "-d");
  assert.ok(!argv.includes("--rm"));
});

test("the builder refuses names, paths, files and images that could change the sandbox", () => {
  const reject = (extra, code) => assert.throws(() => pythonCommand(extra), (error) => error.code === code && error.status === 400, code);
  reject({ name: "model-container" }, "invalid_probe_name");
  reject({ name: "ai-probe-ABCDEFGH" }, "invalid_probe_name");
  reject({ modelDir: "relative/dir" }, "invalid_probe_path");
  reject({ modelDir: "" }, "invalid_probe_path");
  reject({ modelDir: `${MODEL_DIR}:rw` }, "invalid_probe_path");
  reject({ modelDir: `${MODEL_DIR}\nrm` }, "invalid_probe_path");
  reject({ image: "--privileged" }, "invalid_probe_image");
  reject({ runtime: { runtimeId: "vllm@0.28.0", image: "img with space" } }, "invalid_probe_image");
  reject({ runtime: { runtimeId: "../../x", image: "img" } }, "invalid_runtime");
  assert.throws(() => buildProbeCommand({ engineId: "Not An Engine", runtime: { image: "img" }, modelDir: MODEL_DIR }), (error) => error.code === "unknown_engine");
  for (const bad of ["../model.gguf", "-m.gguf", "dir/model.gguf", "model.bin", "", "a:b.gguf"]) {
    assert.throws(() => llamaCommand({ modelFile: bad }), (error) => error.code === "invalid_model_file", bad);
  }
  // A Windows drive path is a valid bind-mount source.
  assert.equal(pythonCommand({ modelDir: "D:\\models\\example" }).argv.includes("D:\\models\\example:/probe/model:ro"), true);
  // A generated name matches the pattern the removal guard enforces.
  assert.match(probe.probeName(), /^ai-probe-[a-z2-7]{8}$/);
  assert.match(buildProbeCommand({ engineId: "vllm", runtime: { image: "img" }, modelDir: MODEL_DIR }).name, /^ai-probe-[a-z2-7]{8}$/);
});

test("the image that runs is the inspected ID, else the image reference", () => {
  const byTag = buildProbeCommand({ engineId: "sglang", runtime: { runtimeId: "sglang@0.5.17", image: "lmsysorg/sglang:example" }, modelDir: MODEL_DIR, name: NAME });
  assert.ok(byTag.argv.includes("lmsysorg/sglang:example"));
  assert.equal(byTag.imageId, null);
  assert.equal(pythonCommand().imageId, IMAGE_ID);
});

// ----- the python probe against a fake docker

test("parseProbeOutput reads the last marker line, ignores banners and rejects a damaged line", () => {
  const facts = parseProbeOutput(markerLine());
  assert.equal(facts.config.modelType, "qwen3");
  assert.equal(facts.archSupported, true);
  assert.deepEqual(facts.plugins, { gguf: true, bnb: false });
  assert.deepEqual(facts.registryArchitectures, ["LlamaForCausalLM", "Qwen3ForCausalLM"]);
  assert.equal(parseProbeOutput(`${PROBE_MARKER} {broken`), null);
  assert.equal(parseProbeOutput("no marker here"), null);
  assert.equal(parseProbeOutput(`${PROBE_MARKER} [1,2]`), null);
  const lists = parseProbeOutput(markerLine({ registryArchitectures: "nope", toolParsers: [1, "ok"], plugins: { gguf: "yes" } }));
  assert.equal(lists.registryArchitectures, null);
  assert.deepEqual(lists.toolParsers, ["ok"]);
  assert.equal(lists.plugins.gguf, null);
  // The first of two markers loses to the last.
  assert.equal(parseProbeOutput(`${markerLine({ python: "3.10" })}${markerLine({ python: "3.12" })}`).python, "3.12");
});

test("a python probe parses the marker, writes the registries once through runtimeFacts.put and removes nothing it did not leave", async () => {
  const puts = [];
  const docker = fakeDocker({ run: { stdout: markerLine() } });
  const result = await runProbe(pythonCommand(), {
    docker,
    runtimeFacts: { put: async (...args) => { puts.push(args); } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "supported");
  assert.equal(result.kind, "registry");
  assert.equal(result.engineId, "vllm");
  assert.equal(result.runtimeId, "vllm@0.28.0");
  assert.equal(result.facts.matchedArchitecture, "Qwen3ForCausalLM");
  assert.equal(result.facts.archSupported, true);
  assert.deepEqual(result.facts.registryCounts, { registryArchitectures: 2, modelTypes: 2, toolParsers: 2, reasoningParsers: 2, quantMethods: 2, kvCacheDtypes: 2 });
  assert.equal(result.rootCause, null);
  assert.deepEqual(result.container, { name: NAME, removed: true });
  assert.ok(result.durationMs >= 0 && !Number.isNaN(Date.parse(result.at)));
  // The model result carries no host path and no argv.
  assert.ok(!JSON.stringify(result).includes(MODEL_DIR));
  // One run; --rm cleans up after a normal exit, so no extra docker call.
  assert.deepEqual(docker.verbs(), ["run"]);
  assert.ok(docker.calls[0].options.timeout <= 90_000);
  assert.equal(docker.calls[0].options.rejectOnError, false);
  // Registries: exactly one put, with the section 12.3 shape and the inspected image ID.
  assert.equal(puts.length, 1);
  const [runtimeId, section, data, options] = puts[0];
  assert.equal(runtimeId, "vllm@0.28.0");
  assert.equal(section, "registries");
  assert.deepEqual(Object.keys(data).sort(), ["architectures", "capturedAt", "engineVersion", "kvCacheDtypes", "modelTypes", "plugins", "quantMethods", "reasoningParsers", "toolParsers", "transformersVersion"]);
  assert.deepEqual(data.architectures, ["LlamaForCausalLM", "Qwen3ForCausalLM"]);
  assert.deepEqual(data.toolParsers, ["hermes", "qwen3_coder"]);
  assert.deepEqual(data.plugins, { gguf: true, bnb: false });
  assert.equal(data.engineVersion, "0.28.0");
  assert.equal(data.transformersVersion, "5.15.1");
  assert.ok(!Number.isNaN(Date.parse(data.capturedAt)));
  assert.deepEqual(options, { imageId: IMAGE_ID });
});

test("with the real runtime-facts store the registries land in the one engine-flags file and no other facts file exists", async (t) => {
  const { root, facts } = runtimeFactsStore(t);
  const result = await runProbe(pythonCommand(), { docker: fakeDocker({ run: { stdout: markerLine() } }), runtimeFacts: facts });
  assert.equal(result.verdict, "supported");
  assert.equal(result.warnings, undefined);
  const files = walk(root).map((file) => path.relative(root, file).split(path.sep).join("/"));
  assert.deepEqual(files, [`.runtime/engine-flags/vllm/${"c".repeat(16)}.json`]);
  const stored = await facts.get("vllm@0.28.0");
  assert.equal(stored.imageId, IMAGE_ID);
  assert.equal(stored.flags, null);
  assert.deepEqual(stored.registries.architectures, ["LlamaForCausalLM", "Qwen3ForCausalLM"]);
  assert.equal(stored.registries.transformersVersion, "5.15.1");
  // The probe's own result is kept apart in the model-probes cache, never in a facts file.
  assert.ok(!fs.existsSync(path.join(root, "cache")));
});

test("a flags section already captured by introspection survives the registries write", async (t) => {
  const { facts } = runtimeFactsStore(t);
  const flags = { capturedAt: "2026-10-14T00:00:00Z", argv: ["--help"], rawSha256: "d".repeat(64), flags: [{ flag: "--model", aliases: [], choices: [] }] };
  await facts.put("vllm@0.28.0", "flags", flags);
  await runProbe(pythonCommand(), { docker: fakeDocker({ run: { stdout: markerLine() } }), runtimeFacts: facts });
  const stored = await facts.get("vllm@0.28.0");
  assert.deepEqual(stored.flags, flags);
  assert.ok(stored.registries.architectures.length);
});

test("verdicts: an architecture missing from the registry is unsupported, remote code needs consent, an unknown registry is inconclusive", async () => {
  const run = (overrides, command = pythonCommand()) => runProbe(command, { docker: fakeDocker({ run: { stdout: markerLine(overrides) } }), runtimeFacts: { put: async () => {} } });

  const missing = await run({ archSupported: false, config: { ok: true, modelType: "novel", architectures: ["NovelForCausalLM"], error: null } });
  assert.equal(missing.verdict, "unsupported");
  assert.equal(missing.ok, false);
  assert.equal(missing.rootCause.code, "arch_not_in_registry");
  assert.ok(missing.rootCause.hint.zh && missing.rootCause.hint.en);
  assert.match(missing.rootCause.hint.en, /NovelForCausalLM/);

  const custom = { archSupported: null, needsRemoteCode: true, config: { ok: false, modelType: "novel", architectures: ["NovelForCausalLM"], error: "ValueError: requires trust_remote_code" } };
  const needs = await run(custom);
  assert.equal(needs.verdict, "needs-remote-code");
  assert.equal(needs.rootCause.signatureId, "trust-remote-code");
  assert.deepEqual(needs.rootCause.suggestions, [{ kind: "param", param: "trustRemoteCode", to: true, security: true }]);

  // With consent the remote code ran in the sandbox: the registry decides.
  const allowed = await run({ ...custom, archSupported: true, config: { ok: true, modelType: "novel", architectures: ["Qwen3ForCausalLM"], error: null } }, pythonCommand({ allowRemoteCode: true }));
  assert.equal(allowed.verdict, "supported");

  const unknownRegistry = await run({ archSupported: null, registryArchitectures: null });
  assert.equal(unknownRegistry.verdict, "inconclusive");
  assert.equal(unknownRegistry.rootCause.code, "registry_unavailable");

  const noConfig = await run({ archSupported: null, config: { ok: false, modelType: null, architectures: [], error: "config.json is missing" } });
  assert.equal(noConfig.verdict, "inconclusive");
  assert.equal(noConfig.rootCause.code, "config_missing");

  const unrecognised = await run({
    archSupported: null,
    config: { ok: false, modelType: "deepseek4", architectures: ["DeepseekV4ForCausalLM"], error: "ValueError: model type `deepseek4` but Transformers does not recognize this architecture." },
  });
  assert.equal(unrecognised.verdict, "unsupported");
  assert.equal(unrecognised.rootCause.signatureId, "transformers-unknown-arch");
});

test("a probe that printed no marker, or whose image has no python, is inconclusive with a root cause", async () => {
  const empty = await runProbe(pythonCommand(), {
    docker: fakeDocker({ run: { stdout: "", stderr: "Traceback (most recent call last):\n  File \"x\", line 1\nValueError: boom\n", error: Object.assign(new Error("exit 1"), { code: 1 }) } }),
    runtimeFacts: { put: async () => { throw new Error("must not write registries"); } },
  });
  assert.equal(empty.verdict, "inconclusive");
  assert.equal(empty.ok, false);
  assert.ok(empty.rootCause.code);

  const noPython = await runProbe(pythonCommand(), {
    docker: fakeDocker({ run: { stderr: "docker: Error response from daemon: OCI runtime create failed: exec: \"python3\": executable file not found in $PATH", error: new Error("exit 127") } }),
    runtimeFacts: { put: async () => {} },
  });
  assert.equal(noPython.verdict, "inconclusive");
  assert.equal(noPython.rootCause.code, "probe_image_unsupported");
});

test("a failed registries write is a warning on the result, not a failed probe", async () => {
  const result = await runProbe(pythonCommand(), {
    docker: fakeDocker({ run: { stdout: markerLine() } }),
    runtimeFacts: { put: async () => { throw Object.assign(new Error("Runtime image changed during the probe; introspect it again."), { code: "runtime_image_changed" }); } },
  });
  assert.equal(result.verdict, "supported");
  assert.equal(result.warnings[0].code, "runtime_image_changed");
});

test("an image that returns no architecture list leaves the runtime facts alone", async () => {
  let writes = 0;
  const result = await runProbe(pythonCommand({ engineId: "tabbyapi" }), {
    docker: fakeDocker({ run: { stdout: markerLine({ registryArchitectures: null, archSupported: null }) } }),
    runtimeFacts: { put: async () => { writes += 1; } },
  });
  assert.equal(writes, 0);
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.warnings[0].code, "registries_unavailable");
});

test("a timeout is inconclusive and the probe container is force-removed", async () => {
  const docker = fakeDocker({
    run: { error: Object.assign(new Error("Command failed: timed out"), { killed: true, signal: "SIGTERM" }), stderr: "loading..." },
  });
  const result = await runProbe(pythonCommand({ timeoutMs: 50 }), { docker, runtimeFacts: { put: async () => { throw new Error("no write on timeout"); } } });
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.ok, false);
  assert.equal(result.rootCause.code, "probe_timeout");
  assert.deepEqual(docker.verbs(), ["run", "rm"]);
  assert.deepEqual(docker.calls[1].args, ["rm", "-f", NAME]);
  assert.deepEqual(result.container, { name: NAME, removed: true });
});

test("a docker call that never answers is cut off by the guard timer and the container is still removed", async () => {
  const docker = fakeDocker({ run: () => new Promise(() => {}) });
  const started = Date.now();
  const result = await runProbe(pythonCommand({ timeoutMs: 40 }), { docker, guardMs: 30, runtimeFacts: { put: async () => {} } });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.rootCause.code, "probe_timeout");
  assert.deepEqual(docker.calls.at(-1).args, ["rm", "-f", NAME]);
  assert.equal(result.container.removed, true);
});

test("a container that could not be removed is reported, and an already-gone container counts as removed", async () => {
  const stuck = fakeDocker({
    run: { error: Object.assign(new Error("timed out"), { killed: true }) },
    rm: { error: new Error("rm failed"), stderr: "Error response from daemon: removal of container is already in progress" },
  });
  const failed = await runProbe(pythonCommand({ timeoutMs: 10 }), { docker: stuck, runtimeFacts: { put: async () => {} } });
  assert.equal(failed.container.removed, false);
  assert.equal(failed.warnings[0].code, "container_not_removed");

  const gone = fakeDocker({
    run: { error: Object.assign(new Error("timed out"), { killed: true }) },
    rm: { error: new Error("rm failed"), stderr: "Error response from daemon: No such container: ai-probe-abcd2345" },
  });
  assert.equal((await runProbe(pythonCommand({ timeoutMs: 10 }), { docker: gone, runtimeFacts: { put: async () => {} } })).container.removed, true);
});

test("Docker being unavailable during the probe is inconclusive with docker_unavailable", async () => {
  for (const failure of [
    { error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) },
    { error: new Error("exit 1"), stderr: "error during connect: Head \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/_ping\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified." },
    { error: new Error("exit 1"), stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" },
  ]) {
    const docker = fakeDocker({ run: failure });
    const result = await runProbe(pythonCommand(), { docker, runtimeFacts: { put: async () => {} } });
    assert.equal(result.verdict, "inconclusive");
    assert.equal(result.rootCause.code, "docker_unavailable");
    assert.ok(result.rootCause.hint.zh && result.rootCause.hint.en);
    // No container was created, and nothing else is run against a dead daemon.
    assert.deepEqual(docker.verbs(), ["run"]);
  }
});

test("a docker runner that rejects instead of resolving is handled the same way", async () => {
  const docker = async () => { throw Object.assign(new Error("Command failed"), { stdout: markerLine(), stderr: "" }); };
  const result = await runProbe(pythonCommand(), { docker, runtimeFacts: { put: async () => {} } });
  assert.equal(result.verdict, "supported");
});

test("runProbe refuses to remove anything that is not a probe container", async () => {
  const docker = fakeDocker();
  const cmd = { ...pythonCommand(), name: "vllm-qwen-main" };
  await assert.rejects(() => runProbe(cmd, { docker }), TypeError);
  assert.deepEqual(docker.calls, []);
  await assert.rejects(() => runProbe(pythonCommand(), {}), TypeError);
});

// ----- the llama.cpp header load

const LLAMA_SUCCESS = [
  "main: build = 10630",
  "llama_model_loader: loaded meta data with 40 key-value pairs",
  "print_info: arch             = deepseek2",
  "print_info: n_ctx_train      = 131072",
  "print_info: n_layer          = 61",
  "print_info: n_expert         = 256",
  "print_info: model type       = 671B",
  "load_tensors: loading model tensors, this can take a while... (mmap = true)",
].join("\n");

function llamaDocker({ logs, exited = () => false, start = {} }) {
  let reads = 0;
  return fakeDocker({
    run: start,
    logs: () => { reads += 1; return { stdout: typeof logs === "function" ? logs(reads) : logs, stderr: "" }; },
    inspect: () => ({ stdout: exited() ? "exited\n" : "running\n" }),
  });
}

test("llama.cpp: a rejected architecture stops at the first failure marker, is unsupported and the container is removed", async () => {
  const clock = fakeClock();
  const docker = llamaDocker({
    logs: (read) => (read < 3 ? "llama_model_loader: loaded meta data\n" : "llama_model_loader: loaded meta data\nllama_model_load: error loading model: error loading model architecture: unknown model architecture: 'deepseek4'\n"),
  });
  const result = await runProbe(llamaCommand(), { docker, ...clock });
  assert.equal(result.verdict, "unsupported");
  assert.equal(result.ok, false);
  assert.equal(result.kind, "header");
  assert.equal(result.rootCause.signatureId, "llama-unknown-arch");
  assert.equal(result.rootCause.code, "llama_unknown_arch");
  assert.match(result.rootCause.logExcerpt, /deepseek4/);
  assert.deepEqual(docker.verbs().filter((verb) => verb === "run" || verb === "rm"), ["run", "rm"]);
  assert.deepEqual(docker.calls.at(-1).args, ["rm", "-f", NAME]);
  assert.equal(docker.calls[0].args[1], "-d");
  assert.equal(result.container.removed, true);
});

test("llama.cpp: the tensor buffer lines are a strong success marker and the hyper-parameters are kept", async () => {
  const clock = fakeClock();
  const docker = llamaDocker({
    logs: (read) => (read < 2 ? LLAMA_SUCCESS : `${LLAMA_SUCCESS}\nload_tensors:   CPU_Mapped model buffer size = 41233.50 MiB\n`),
  });
  const result = await runProbe(llamaCommand(), { docker, ...clock });
  assert.equal(result.verdict, "supported");
  assert.equal(result.ok, true);
  assert.equal(result.facts.hparams.architecture, "deepseek2");
  assert.equal(result.facts.hparams.nLayer, "61");
  assert.equal(result.facts.hparams.nCtxTrain, "131072");
  assert.equal(result.facts.hparams.nExpert, "256");
  assert.equal(result.facts.markers.tensors, true);
  assert.deepEqual(docker.calls.at(-1).args, ["rm", "-f", NAME]);
});

test("llama.cpp: an accepted architecture line without a later failure becomes supported after the grace period", async () => {
  const clock = fakeClock();
  const docker = llamaDocker({ logs: LLAMA_SUCCESS });
  const result = await runProbe(llamaCommand(), { docker, ...clock, weakGraceMs: 2000, pollMs: 500 });
  assert.equal(result.verdict, "supported");
  assert.ok(docker.verbs().filter((verb) => verb === "logs").length >= 4, "kept polling during the grace period");
  assert.equal(result.durationMs >= 2000, true);
});

test("llama.cpp: a failure that follows the architecture line still wins", async () => {
  const clock = fakeClock();
  const docker = llamaDocker({
    logs: (read) => (read < 3 ? LLAMA_SUCCESS : `${LLAMA_SUCCESS}\nllama_model_load: error loading model: done_getting_tensors: wrong number of tensors; expected 1100, got 1098\n`),
  });
  const result = await runProbe(llamaCommand(), { docker, ...clock, weakGraceMs: 60_000 });
  assert.equal(result.verdict, "unsupported");
  assert.ok(result.rootCause.logExcerpt.includes("wrong number of tensors"));
});

test("llama.cpp: no marker before the deadline is inconclusive and the container is removed", async () => {
  const clock = fakeClock();
  const docker = llamaDocker({ logs: "ggml_cuda_init: failed to initialize CUDA\nllama_model_loader: loaded meta data\n" });
  const result = await runProbe(llamaCommand({ timeoutMs: 3000 }), { docker, ...clock });
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.rootCause.code, "probe_timeout");
  assert.deepEqual(docker.calls.at(-1).args, ["rm", "-f", NAME]);
  assert.equal(result.container.removed, true);
});

test("llama.cpp: an image that rejects the probe flags is inconclusive, never unsupported", async () => {
  const clock = fakeClock();
  const docker = llamaDocker({ logs: "error: invalid argument: --no-repack\n", exited: () => true });
  const result = await runProbe(llamaCommand(), { docker, ...clock });
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.rootCause.code, "probe_flags_unsupported");
});

test("llama.cpp: a container that exits without markers is inconclusive; one that fails to start says why", async () => {
  const clock = fakeClock();
  const exited = await runProbe(llamaCommand(), { docker: llamaDocker({ logs: "main: starting\n", exited: () => true }), ...clock });
  assert.equal(exited.verdict, "inconclusive");

  const missing = fakeDocker({ run: { error: new Error("exit 125"), stderr: "Unable to find image 'ghcr.io/example/llama.cpp:server-cuda' locally" } });
  const noImage = await runProbe(llamaCommand(), { docker: missing, ...clock });
  assert.equal(noImage.rootCause.code, "runtime_image_missing");
  assert.deepEqual(missing.verbs(), ["run"], "no container exists, nothing to remove, and nothing is pulled");

  const down = fakeDocker({ run: { error: new Error("exit 1"), stderr: "Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine" } });
  assert.equal((await runProbe(llamaCommand(), { docker: down, ...clock })).rootCause.code, "docker_unavailable");
});

// ----- stored results and compatibility evidence

test("results round-trip by <contentDigest12>@<runtimeId> and corrupt files are skipped", async (t) => {
  const dir = path.join(tempRoot(t), "model-probes");
  const result = await runProbe(pythonCommand(), { docker: fakeDocker({ run: { stdout: markerLine() } }), runtimeFacts: { put: async () => {} } });
  const key = await probe.writeProbeResult(result, { contentDigest: DIGEST, dir });
  assert.equal(key, `${"a".repeat(12)}@vllm@0.28.0`);
  assert.deepEqual(fs.readdirSync(dir), [`${key}.json`]);
  const stored = await probe.readProbeResult(DIGEST, "vllm@0.28.0", { dir });
  assert.equal(stored.verdict, "supported");
  assert.equal(stored.contentDigest, DIGEST);
  assert.equal(stored.key, key);
  assert.equal(await probe.readProbeResult(DIGEST, "sglang@0.5.17", { dir }), null);
  fs.writeFileSync(path.join(dir, `${"b".repeat(12)}@vllm@0.28.0.json`), "{ broken");
  const all = await probe.listProbeResults({ dir });
  assert.deepEqual(all.map((item) => item.key), [key]);
  assert.deepEqual((await probe.listProbeResults({ dir, contentDigest: `sha256:${"b".repeat(64)}` })), []);
  assert.deepEqual(await probe.listProbeResults({ dir: path.join(dir, "missing") }), []);
  assert.throws(() => probe.probeKey("sha256:short", "vllm@0.28.0"), (error) => error.code === "invalid_content_digest");
  assert.throws(() => probe.probeKey(DIGEST, "../escape"), (error) => error.code === "invalid_runtime");
});

function deepseekCard() {
  return {
    schema: "modelcard/v1",
    cardId: "mc_synthetic",
    contentDigest: DIGEST,
    ref: { kind: "local", name: "example" },
    format: { kind: "gguf", weightFiles: 1 },
    role: { value: "main", runnable: true },
    identity: { modelType: null, textModelType: null, architectures: [], ggufArchitecture: "deepseek4", transformersVersion: null, displayName: "example" },
    quant: { method: "gguf", algo: "Q4_K_M" },
    customCode: { autoMap: null, files: [], trustRemoteCode: false },
    context: { native: 131072 },
  };
}

const COMPAT_DESCRIPTORS = [
  { id: "llamacpp", artifactFormats: ["gguf"], capabilities: { roles: ["chat"], autoParsers: { tool: "auto", reasoning: "auto" } } },
];
const COMPAT_RUNTIMES = [{ engineId: "llamacpp", runtimeId: "llamacpp@b10630", version: "b10630", status: "pinned", release: { build: 10630 } }];

test("a probe upgrades an unknown row only through supportEvidence; inconclusive never does", async (t) => {
  const dir = path.join(tempRoot(t), "model-probes");
  const clock = fakeClock();
  const evaluate = (probes) => core.models.compatibility.evaluateCompatibility(deepseekCard(), {
    descriptors: COMPAT_DESCRIPTORS, runtimes: COMPAT_RUNTIMES, env: {}, host: { platform: "linux" }, probes,
  }).find((row) => row.engineId === "llamacpp");

  const before = evaluate([]);
  assert.equal(before.verdict, "unknown");
  assert.deepEqual(before.supportEvidence, []);

  // inconclusive (timeout): stored, read back, still unknown, still no evidence
  const timedOut = await runProbe(llamaCommand({ timeoutMs: 2000 }), { docker: llamaDocker({ logs: "starting\n" }), ...clock });
  assert.equal(timedOut.verdict, "inconclusive");
  await probe.writeProbeResult(timedOut, { contentDigest: DIGEST, dir });
  const inconclusive = evaluate(await probe.listProbeResults({ dir }));
  assert.equal(inconclusive.verdict, "unknown");
  assert.deepEqual(inconclusive.supportEvidence, []);

  // supported: the same row becomes ok, and the evidence is a detected probe item
  const supported = await runProbe(llamaCommand(), { docker: llamaDocker({ logs: `${LLAMA_SUCCESS}\nload_tensors:   CPU_Mapped model buffer size = 1.0 MiB\n` }), ...clock });
  await probe.writeProbeResult(supported, { contentDigest: DIGEST, dir });
  const after = evaluate(await probe.listProbeResults({ dir }));
  assert.equal(after.verdict, "ok");
  assert.deepEqual(after.supportEvidence, [{ kind: "probe", ref: `${"a".repeat(12)}@llamacpp@b10630`, confidence: "detected" }]);

  // a rejected architecture blocks
  const rejected = await runProbe(llamaCommand(), { docker: llamaDocker({ logs: "llama_model_load: error loading model: unknown model architecture: 'deepseek4'\n" }), ...clock });
  await probe.writeProbeResult(rejected, { contentDigest: DIGEST, dir });
  assert.equal(evaluate(await probe.listProbeResults({ dir })).verdict, "block");
});

// ----- the Python script itself (only when a python3 is on the PATH)

let pythonCommandCache;
function findPython() {
  if (pythonCommandCache !== undefined) return pythonCommandCache;
  pythonCommandCache = null;
  for (const command of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const run = childProcess.spawnSync(command, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8", windowsHide: true });
    if (run.status === 0 && run.stdout.trim() === "3") {
      pythonCommandCache = command;
      break;
    }
  }
  return pythonCommandCache;
}

test("hf_probe.py prints exactly one marker line and never fails when the image lacks a registry", { skip: findPython() ? false : "python3 is not installed" }, (t) => {
  const model = tempRoot(t, "probe-model-");
  fs.writeFileSync(path.join(model, "config.json"), JSON.stringify({ model_type: "example", architectures: ["ExampleForCausalLM"], auto_map: { AutoConfig: "configuration_example.ExampleConfig" } }));
  const script = path.join(__dirname, "..", "model-inspector", "probe-scripts", "hf_probe.py");
  const run = childProcess.spawnSync(findPython(), ["-I", script, "--model", model, "--engine", "vllm"], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(run.status, 0, run.stderr);
  const markers = run.stdout.split(/\r?\n/).filter((line) => line.startsWith(PROBE_MARKER));
  assert.equal(markers.length, 1);
  const facts = parseProbeOutput(run.stdout);
  assert.ok(facts, "the marker line parses");
  assert.equal(facts.config.modelType, "example");
  assert.deepEqual(facts.config.architectures, ["ExampleForCausalLM"]);
  assert.equal(facts.needsRemoteCode, true, "auto_map flags custom code");
  assert.equal(facts.python.split(".")[0], "3");
  // A host without vllm/transformers yields unknown (null), not a failure.
  if (facts.registryArchitectures === null) assert.equal(facts.archSupported, null);
  assert.ok(Array.isArray(facts.errors));
  // Nothing may be written next to the model by the read-only probe.
  assert.deepEqual(fs.readdirSync(model), ["config.json"]);
});

test("hf_probe.py reports a missing config.json instead of crashing", { skip: findPython() ? false : "python3 is not installed" }, (t) => {
  const model = tempRoot(t, "probe-model-");
  const script = path.join(__dirname, "..", "model-inspector", "probe-scripts", "hf_probe.py");
  const run = childProcess.spawnSync(findPython(), ["-I", script, "--model", model, "--engine", "sglang"], { encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const facts = parseProbeOutput(run.stdout);
  assert.equal(facts.config.ok, false);
  assert.match(facts.config.error, /config\.json is missing/);
});

// ----- POST /api/models/probe

function recordingApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; },
  };
}

function jobsLedger() {
  const jobs = [];
  return {
    jobs,
    createJob: (type, title, meta = {}) => {
      const job = { id: `job-${jobs.length + 1}`, type, title, status: "running", meta: { ...meta }, logs: [] };
      jobs.push(job);
      return job;
    },
    appendLog: (job, data) => { job.logs.push(String(data)); },
    finishJob: (job, meta = {}) => { job.status = "success"; job.meta = { ...job.meta, ...meta }; },
    failJob: (job, error) => { job.status = "failed"; job.error = error.message; },
    setJobProgress: () => {},
  };
}

/** A manager-shaped fixture: real engine registry and runtime-facts store, fake docker, temp dirs. */
function routeFixture(t, { managerId = "vllm", docker, local = true, engineFiles = {}, imageId = IMAGE_ID } = {}) {
  const root = tempRoot(t, "probe-route-");
  const registry = createEngineRegistry({ overrideDir: path.join(root, "config"), env: {} });
  const facts = createRuntimeFacts({ aiRoot: root, registry, resolveImageId: async () => imageId });
  const modelDir = path.join(root, "models", "example-model");
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, "config.json"), JSON.stringify({ model_type: "qwen3", architectures: ["Qwen3ForCausalLM"] }));
  fs.writeFileSync(path.join(modelDir, "model-Q4_K_M.gguf"), "GGUF");
  fs.writeFileSync(path.join(modelDir, "mmproj-F16.gguf"), "GGUF");
  for (const [name, body] of Object.entries(engineFiles)) fs.writeFileSync(path.join(modelDir, name), body);
  const ledger = jobsLedger();
  const dockerRunner = docker || fakeDocker({ info: { stdout: "27.0.0\n" }, run: { stdout: markerLine() } });
  const probeDir = path.join(root, "cache", "model-probes");
  const app = recordingApp();
  const context = registerModelInspectorRoutes(app, {
    managerId,
    isLocalRequest: () => local,
    jobs: ledger,
    docker: dockerRunner,
    registry,
    resolveModelPath: (ref) => (ref === "example-model" ? modelDir : null),
    probe: {
      runtimeFacts: facts,
      probeDir,
      inspect: async () => ({ cardId: "mc_synthetic", contentDigest: DIGEST }),
      containerName: NAME,
      pollMs: 1,
    },
  });
  async function post(body) {
    const res = fakeResponse();
    await app.routes.get("POST /api/models/probe")({ headers: {}, body }, res);
    await Promise.all([...context.probeRuns]);
    return res;
  }
  return { root, registry, facts, ledger, docker: dockerRunner, probeDir, modelDir, app, context, post };
}

test("the route is registered once, local-only, and answers 202 with the job id", async (t) => {
  const f = routeFixture(t);
  assert.ok(f.app.routes.has("POST /api/models/probe"));
  assert.ok(f.app.routes.has("GET /api/knowledge/status"), "the status route is untouched");
  const res = await f.post({ model: "example-model", engineId: "vllm", runtimeId: "vllm@0.28.0" });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true, jobId: "job-1", managerId: "vllm" });
  const job = f.ledger.jobs[0];
  assert.equal(job.type, "model-probe");
  assert.equal(job.status, "success");
  assert.equal(job.meta.verdict, "supported");
  assert.equal(job.meta.contentDigest, DIGEST);
  assert.equal(job.meta.runtimeId, "vllm@0.28.0");
  assert.ok(!JSON.stringify(job).includes(f.modelDir), "no host path in the ledger");
  assert.ok(job.logs.length >= 2);
  // The container ran the inspected image ID with the model mounted read-only.
  const run = f.docker.calls.find((call) => call.args[0] === "run");
  assert.ok(run.args.includes(IMAGE_ID));
  assert.ok(run.args.includes(`${f.modelDir}:/probe/model:ro`));
  assert.ok(!f.docker.verbs().includes("pull"));
  // The model result is stored for compatibility.js, and the registries went to the facts store.
  const stored = await probe.readProbeResult(DIGEST, "vllm@0.28.0", { dir: f.probeDir });
  assert.equal(stored.verdict, "supported");
  assert.deepEqual(walk(path.join(f.root, ".runtime")).map((file) => path.basename(file)), [`${"c".repeat(16)}.json`]);
  assert.ok((await f.facts.get("vllm@0.28.0")).registries.architectures.includes("Qwen3ForCausalLM"));
  // Nothing is left in flight: the same probe may run again.
  const again = await f.post({ model: "example-model", engineId: "vllm", runtimeId: "vllm@0.28.0" });
  assert.equal(again.statusCode, 202);
});

test("a remote client gets 403 and nothing runs", async (t) => {
  const f = routeFixture(t, { local: false });
  const res = await f.post({ model: "example-model", engineId: "vllm" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, "forbidden");
  assert.deepEqual(f.docker.calls, []);
  assert.deepEqual(f.ledger.jobs, []);
});

test("a missing runtime image is 409 runtime_image_missing with the Pull action and nothing is pulled or run", async (t) => {
  const f = routeFixture(t, { imageId: "" });
  const res = await f.post({ model: "example-model", engineId: "vllm", runtimeId: "vllm@0.28.0" });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, "runtime_image_missing");
  assert.equal(res.body.runtimeId, "vllm@0.28.0");
  assert.equal(res.body.action.kind, "pull-image");
  assert.equal(res.body.action.method, "POST");
  assert.equal(res.body.action.path, "/api/runtimes/vllm%400.28.0/pull");
  assert.equal(res.body.action.label.zh, "拉取镜像");
  assert.equal(res.body.action.label.en, "Pull image");
  // Only the daemon check ran: no pull, no run, no container, no job.
  assert.deepEqual(f.docker.verbs(), ["info"]);
  assert.deepEqual(f.ledger.jobs, []);
  assert.ok(!fs.existsSync(f.probeDir));
});

test("Docker not running is 503 docker_unavailable, checked before the image", async (t) => {
  const docker = fakeDocker({ info: { error: new Error("exit 1"), stderr: "Cannot connect to the Docker daemon. Is the docker daemon running?" } });
  const f = routeFixture(t, { docker, imageId: "" });
  const res = await f.post({ model: "example-model", engineId: "vllm" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, "docker_unavailable");
  assert.deepEqual(docker.verbs(), ["info"]);
  assert.deepEqual(f.ledger.jobs, []);
});

test("request validation: unknown engine, other manager's engine, unknown runtime, bad body, unknown model", async (t) => {
  const f = routeFixture(t);
  const cases = [
    [{ model: "example-model", engineId: "mystery" }, 400, "unknown_engine"],
    [{ model: "example-model", engineId: "Not An Engine" }, 400, "invalid_request"],
    [{ model: "example-model", engineId: "llamacpp" }, 400, "engine_not_hosted"],
    [{ model: "example-model", engineId: "vllm", runtimeId: "vllm@0.0.0-none" }, 404, "unknown_runtime"],
    [{ engineId: "vllm" }, 400, "invalid_request"],
    [{ model: "example-model", engineId: "vllm", allowRemoteCode: "yes" }, 400, "invalid_request"],
    [{ model: "elsewhere", engineId: "vllm" }, 404, "model_not_found"],
    [undefined, 400, "invalid_request"],
  ];
  for (const [body, status, code] of cases) {
    const res = await f.post(body);
    assert.equal(res.statusCode, status, JSON.stringify(body));
    assert.equal(res.body.error.code, code, JSON.stringify(body));
    assert.equal(res.body.ok, false);
  }
  assert.deepEqual(f.ledger.jobs, []);
  assert.deepEqual(f.docker.calls, []);
});

test("an identical probe in flight is 409 probe_running with the running job id", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const docker = fakeDocker({ info: { stdout: "27.0.0\n" }, run: async () => { await gate; return { stdout: markerLine() }; } });
  const f = routeFixture(t, { docker });
  const handler = f.app.routes.get("POST /api/models/probe");
  const first = fakeResponse();
  await handler({ headers: {}, body: { model: "example-model", engineId: "vllm", runtimeId: "vllm@0.28.0" } }, first);
  assert.equal(first.statusCode, 202);
  const second = fakeResponse();
  await handler({ headers: {}, body: { model: "example-model", engineId: "vllm", runtimeId: "vllm@0.28.0" } }, second);
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.error.code, "probe_running");
  assert.equal(second.body.jobId, first.body.jobId);
  // Another runtime of the same model is a different probe.
  const other = fakeResponse();
  await handler({ headers: {}, body: { model: "example-model", engineId: "sglang" } }, other);
  assert.equal(other.statusCode, 202);
  release();
  await Promise.all([...f.context.probeRuns]);
  assert.equal(f.ledger.jobs[0].status, "success");
});

test("a timed-out probe fails the job as inconclusive, removes the container and stores no upgrade", async (t) => {
  const docker = fakeDocker({
    info: { stdout: "27.0.0\n" },
    run: { error: Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }) },
  });
  const f = routeFixture(t, { docker });
  const res = await f.post({ model: "example-model", engineId: "vllm", runtimeId: "vllm@0.28.0" });
  assert.equal(res.statusCode, 202);
  const job = f.ledger.jobs[0];
  assert.equal(job.status, "failed");
  assert.match(job.error, /inconclusive: probe_timeout/);
  assert.equal(job.meta.verdict, "inconclusive");
  assert.equal(job.failure.code, "probe_timeout");
  assert.deepEqual(docker.calls.at(-1).args, ["rm", "-f", NAME]);
  // The inconclusive result is recorded for the UI but is no support evidence.
  const stored = await probe.readProbeResult(DIGEST, "vllm@0.28.0", { dir: f.probeDir });
  assert.equal(stored.verdict, "inconclusive");
  assert.equal(await f.facts.get("vllm@0.28.0"), null, "no registries were written");
});

test("an inconclusive probe never replaces an earlier conclusive result", async (t) => {
  const f = routeFixture(t);
  await f.post({ model: "example-model", engineId: "vllm", runtimeId: "vllm@0.28.0" });
  assert.equal((await probe.readProbeResult(DIGEST, "vllm@0.28.0", { dir: f.probeDir })).verdict, "supported");
  const failing = fakeDocker({ info: { stdout: "27.0.0\n" }, run: { error: Object.assign(new Error("timed out"), { killed: true }) } });
  const g = routeFixture(t, { docker: failing });
  fs.cpSync(f.probeDir, g.probeDir, { recursive: true });
  await g.post({ model: "example-model", engineId: "vllm", runtimeId: "vllm@0.28.0" });
  assert.equal(g.ledger.jobs[0].status, "failed");
  assert.equal((await probe.readProbeResult(DIGEST, "vllm@0.28.0", { dir: g.probeDir })).verdict, "supported");
});

test("a llama.cpp probe picks the model's .gguf (not the mmproj) and a folder without one is 422", async (t) => {
  const clock = fakeClock();
  const docker = llamaDocker({ logs: `${LLAMA_SUCCESS}\nload_tensors:   CPU_Mapped model buffer size = 1.0 MiB\n` });
  docker.calls.length = 0;
  const handlers = {
    info: { stdout: "27.0.0\n" },
    run: {},
    logs: { stdout: `${LLAMA_SUCCESS}\nload_tensors:   CPU_Mapped model buffer size = 1.0 MiB\n` },
    inspect: { stdout: "running\n" },
  };
  const f = routeFixture(t, { managerId: "llama", docker: fakeDocker(handlers) });
  const res = await f.post({ model: "example-model", engineId: "llamacpp", runtimeId: "llamacpp@b10630" });
  assert.equal(res.statusCode, 202);
  assert.equal(f.ledger.jobs[0].meta.verdict, "supported");
  const run = f.docker.calls.find((call) => call.args[0] === "run");
  assert.ok(run.args.includes("/probe/model/model-Q4_K_M.gguf"));
  assert.ok(!run.args.some((item) => /mmproj/.test(item)));
  assert.equal(run.args.at(-1), "18080");

  const empty = routeFixture(t, { managerId: "llama", docker: fakeDocker(handlers) });
  for (const file of fs.readdirSync(empty.modelDir)) if (file.endsWith(".gguf")) fs.rmSync(path.join(empty.modelDir, file));
  const none = await empty.post({ model: "example-model", engineId: "llamacpp" });
  assert.equal(none.statusCode, 422);
  assert.equal(none.body.error.code, "not_a_model");
});

test("remote code is requested only by the body flag and reaches the argv only when it is true", async (t) => {
  const f = routeFixture(t);
  await f.post({ model: "example-model", engineId: "vllm", runtimeId: "vllm@0.28.0" });
  assert.ok(!f.docker.calls.find((call) => call.args[0] === "run").args.includes("--trust-remote-code"));
  const g = routeFixture(t);
  await g.post({ model: "example-model", engineId: "vllm", runtimeId: "vllm@0.28.0", allowRemoteCode: true });
  assert.ok(g.docker.calls.find((call) => call.args[0] === "run").args.includes("--trust-remote-code"));
  assert.equal(g.ledger.jobs[0].meta.allowRemoteCode, true);
});

test("the probe never creates the ai.manager label, a GPU request or a pull, whatever the route is asked", async (t) => {
  const f = routeFixture(t);
  await f.post({ model: "example-model", engineId: "vllm", runtimeId: "vllm@0.28.0", allowRemoteCode: true });
  await f.post({ model: "example-model", engineId: "sglang" });
  for (const call of f.docker.calls) {
    const line = call.args.join(" ");
    assert.ok(!/ai\.manager|--gpus|--privileged|\bpull\b(?! never)/.test(line), line);
    assert.ok(!["stop", "kill", "restart", "pull", "image", "create", "start"].includes(call.args[0]), call.args[0]);
  }
});

test("core.models.probe exposes the builder and runner under the names the spec fixes", () => {
  assert.equal(core.models.probe.buildProbeCommand, buildProbeCommand);
  assert.equal(core.models.probe.runProbe, runProbe);
  assert.equal(core.models.probe.PROBE_LABEL, "ai.probe=model-inspector");
});
