"use strict";

// Log phases, log facts and descriptor error signatures (docs/overhaul/01-engines.md
// §16.2-§16.3, ENG-24). Recorded-format log fixtures drive the descriptor data;
// the supervisor is a fake host with a spy on afterReady. No docker, port or
// platform data is touched.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("..");
const { inferStartupProgress } = require("../runtime-wait");
const { createRuntimeSupervisor } = require("../engines/runtime-supervisor");
const { createKnowledgeLoader } = require("../model-inspector/knowledge");

const FIXTURES = path.join(__dirname, "fixtures", "engines", "log-samples");
const logPhases = core.engines.logPhases;

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, `${name}.log.fixture`), "utf8");
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-log-phases-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function registryFor(t) {
  return core.engines.createEngineRegistry({ overrideDir: path.join(tempDir(t), "engines"), env: {} });
}

function descriptorOf(t, id) {
  return registryFor(t).get(id);
}

// ----- phases

test("vllm and sglang phases reproduce today's three-stage regexes and strings", (t) => {
  const legacyWindows = [
    "INFO: Application startup complete.",
    "INFO:     Uvicorn running on http://0.0.0.0:8000",
    "Capturing CUDA graphs (mixed prefill-decode): 10%",
    "Capture cuda graph begin. This can take up to several minutes.",
    "INFO Loading weights took 0.01 seconds",
    "Starting to load model weights",
    "Load weight begin. avail mem=79.2 GB",
    "Loading base model Example",
    // a graph line beside a weights line: graphs outranks weights, api outranks both
    "Loading weights\nCapturing CUDA graphs\n",
    "Loading weights\nCapturing CUDA graphs\nApplication startup complete\n",
    // noise lines are not evidence
    "server_args=ServerArgs(cuda_graph_max_bs=64, capture cuda graphs)",
    "WARNING CUDA graph disabled for the draft model",
  ];
  for (const id of ["vllm", "sglang"]) {
    const infer = logPhases.createProgressInferer(descriptorOf(t, id));
    for (const text of legacyWindows) {
      const expected = inferStartupProgress(text, 1000, 60_000);
      const got = infer(text, 1000, 60_000);
      if (got === null) {
        assert.equal(expected.stage, "等待模型加载", `${id}: no phase matched, legacy keeps its elapsed-time stage for ${JSON.stringify(text)}`);
        continue;
      }
      assert.deepEqual({ percent: got.percent, stage: got.stage, detail: got.detail }, expected, `${id}: ${JSON.stringify(text)}`);
    }
  }
});

test("refinements raise the stage as the log advances and never lower it", (t) => {
  const expectations = {
    vllm: { fixtureName: "vllm-startup", phases: ["weights", "kv", "graphs", "api"] },
    sglang: { fixtureName: "sglang-startup", phases: ["weights", "kv", "graphs", "api"] },
    llamacpp: { fixtureName: "llamacpp-startup", phases: ["weights", "kv", "api"] },
  };
  for (const [id, { fixtureName, phases }] of Object.entries(expectations)) {
    const infer = logPhases.createProgressInferer(descriptorOf(t, id));
    const lines = fixture(fixtureName).split("\n");
    let previous = 0;
    const seen = [];
    for (let end = 1; end <= lines.length; end += 1) {
      const result = infer(lines.slice(0, end).join("\n"), 0, 1);
      if (!result) continue;
      assert.ok(result.percent >= previous, `${id}: percent fell at line ${end}`);
      previous = result.percent;
      if (seen[seen.length - 1] !== result.phase) seen.push(result.phase);
    }
    assert.deepEqual(seen, phases, `${id}: phases in order`);
    assert.equal(previous, 92, `${id}: ends at the api stage`);
  }
});

test("phase stages are readable by the supervisor's phase mapping (zh strings kept)", (t) => {
  const infer = logPhases.createProgressInferer(descriptorOf(t, "vllm"));
  assert.equal(infer("Available KV cache memory: 12.0 GiB").stage, "分配 KV cache");
  assert.equal(infer("Model loading took 1.0 GiB and 2.0 seconds").stage, "加载权重");
  assert.equal(infer("Application startup complete").stage, "启动收尾");
  assert.equal(infer("nothing relevant yet"), null);
  assert.equal(infer(""), null);
  assert.equal(logPhases.createProgressInferer({ logPhases: [] })("Application startup complete"), null);
});

// ----- facts

test("vllm facts cover the 02 observation inputs", (t) => {
  const facts = logPhases.extractLogFacts(descriptorOf(t, "vllm"), fixture("vllm-startup"));
  assert.equal(facts.weightsGiB, 14.9);
  assert.equal(facts.kvGiB, 52.34);
  assert.equal(facts.kvTokens, 428800);
  assert.equal(facts.maxConcurrency, 13.09);
  assert.equal(facts.maxContextTokens, 32768);
  assert.equal(facts.modelLoadSeconds, 12.3);
  assert.equal(facts.graphCaptureGiB, 0.65);
  assert.equal(facts.torchCompileSeconds, 21.5);
  assert.equal(facts.warmupSeconds, 4.2);
  assert.equal(facts.engineInitSeconds, 35.4);
});

test("sglang facts", (t) => {
  const facts = logPhases.extractLogFacts(descriptorOf(t, "sglang"), fixture("sglang-startup"));
  assert.deepEqual(facts, { weightsGiB: 14.89, kvTokens: 524288, kvGiB: 63 });
});

test("llama.cpp facts are per-device buffers and layer counts, with no vLLM facts", (t) => {
  const descriptor = descriptorOf(t, "llamacpp");
  const facts = logPhases.extractLogFacts(descriptor, fixture("llamacpp-startup"));
  assert.deepEqual(facts, {
    layersOnGpu: 33,
    layersTotal: 33,
    modelBufferMiB: { CUDA0: 2410.55, CUDA1: 2210.25 },
    kvBufferMiB: { CUDA0: 1024, CUDA1: 1024 },
    computeBufferMiB: { CUDA0: 300.25, CUDA1: 310.5 },
  });
  assert.deepEqual(logPhases.extractLogFacts(descriptor, fixture("vllm-startup")), {}, "vLLM log lines produce no llama facts");
  const ids = descriptor.logFacts.map((entry) => entry.id);
  for (const vllmId of ["weightsGiB", "kvGiB", "kvTokens", "maxConcurrency"]) assert.ok(!ids.includes(vllmId), vllmId);
});

test("the last occurrence wins, per device", () => {
  const descriptor = {
    logFacts: [
      { id: "weightsGiB", match: "took ([\\d,.]+) GiB", type: "number" },
      { id: "bufMiB", match: "(GPU\\d) buf = ([\\d.]+) MiB", key: 1, group: 2 },
      { id: "tokens", match: "n=(\\d+)", type: "int" },
    ],
  };
  const facts = logPhases.extractLogFacts(descriptor, "took 1,000.5 GiB\ntook 2.5 GiB\nGPU0 buf = 1 MiB\nGPU0 buf = 2 MiB\nGPU1 buf = 5 MiB\nn=7\n");
  assert.deepEqual(facts, { weightsGiB: 2.5, bufMiB: { GPU0: 2, GPU1: 5 }, tokens: 7 });
  assert.deepEqual(logPhases.extractLogFacts(descriptor, ""), {});
  assert.deepEqual(logPhases.extractLogFacts(null, "x"), {});
  assert.deepEqual(logPhases.mergeLogFacts({ a: 1, b: { x: 1 } }, { a: 2, b: { y: 2 } }), { a: 2, b: { x: 1, y: 2 } });
});

test("llama-manager no longer reads vLLM log patterns for its runtime facts", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "llama-manager", "server.js"), "utf8");
  for (const vllmPattern of ["GPU KV cache size", "Model loading took", "Maximum concurrency for", "Graph capturing finished"]) {
    assert.ok(!source.includes(vllmPattern), `llama-manager/server.js still matches ${vllmPattern}`);
  }
  assert.ok(source.includes("extractLogFacts(engineRegistry.get(\"llamacpp\")"));
});

// ----- descriptor data

test("bundled descriptors validate with the new logPhases/logFacts/errorSignatures data", (t) => {
  const registry = registryFor(t);
  assert.deepEqual(registry.errors(), []);
  for (const id of ["vllm", "sglang", "llamacpp"]) {
    const descriptor = registry.get(id);
    assert.ok(descriptor.logPhases.length > 0, `${id} logPhases`);
    assert.ok(descriptor.logFacts.length > 0, `${id} logFacts`);
    assert.equal(core.engines.validateDescriptor(JSON.parse(JSON.stringify(descriptor)), { mode: "bundled" }).ok, true, id);
  }
});

test("descriptor schema checks logFacts and errorSignatures entries", (t) => {
  const base = JSON.parse(JSON.stringify(descriptorOf(t, "vllm")));
  const codes = (mutate, pathPrefix) => {
    const copy = JSON.parse(JSON.stringify(base));
    mutate(copy);
    return core.engines.validateDescriptor(copy, { mode: "bundled" }).errors.filter((item) => item.path.startsWith(pathPrefix)).map((item) => item.code);
  };
  assert.deepEqual(codes((d) => { d.logFacts[0].id = "Bad_Id"; }, "logFacts[0].id"), ["pattern"]);
  assert.deepEqual(codes((d) => { d.logFacts[0].match = "(unclosed"; }, "logFacts[0].match"), ["invalid_regex"]);
  assert.deepEqual(codes((d) => { d.logFacts[0].type = "bigint"; }, "logFacts[0].type"), ["enum"]);
  assert.deepEqual(codes((d) => { d.logFacts.push({ ...d.logFacts[0] }); }, `logFacts[${base.logFacts.length}].id`), ["duplicate"]);
  assert.deepEqual(codes((d) => { d.errorSignatures[0].engines = ["*"]; }, "errorSignatures[0].engines"), ["generic_signature"]);
  assert.deepEqual(codes((d) => { d.errorSignatures[0].engines = ["sglang"]; }, "errorSignatures[0].engines"), ["generic_signature"]);
  assert.deepEqual(codes((d) => { d.errorSignatures[0].engines = ["vllm"]; }, "errorSignatures[0]"), []);
  assert.deepEqual(codes((d) => { delete d.errorSignatures[0].code; }, "errorSignatures[0].code"), ["required"]);
  assert.deepEqual(codes((d) => { d.errorSignatures[0].phase = "serving"; }, "errorSignatures[0].phase"), ["enum"]);
  assert.deepEqual(codes((d) => { d.errorSignatures[0].suggestions = [{ kind: "introspect" }]; }, "errorSignatures[0].suggestions[0].kind"), ["enum"]);
});

test("errorSignatureAdditions() lists engine-specific entries in the 02 schema, none generic", (t) => {
  const registry = registryFor(t);
  const additions = registry.errorSignatureAdditions();
  assert.deepEqual(additions.map((entry) => [entry.id, entry.code, entry.engines]).sort(), [
    ["llama-mmproj-missing", "mmproj_missing", ["llamacpp"]],
    ["sglang-flag-unknown", "flag_unknown", ["sglang"]],
    ["vllm-flag-unknown", "flag_unknown", ["vllm"]],
  ]);
  for (const entry of additions) {
    assert.ok(!entry.engines.includes("*"), `${entry.id} is not generic`);
    for (const field of ["id", "code", "engines", "phase", "rootCause", "severity", "regex", "title", "hint", "explanation", "suggestions"]) {
      assert.ok(entry[field] !== undefined, `${entry.id}.${field}`);
    }
    assert.doesNotThrow(() => new RegExp(entry.regex), entry.id);
  }
  // A caller's copy never reaches back into the registry.
  additions[0].title.en = "changed";
  assert.notEqual(registry.errorSignatureAdditions()[0].title.en, "changed");
  const flag = additions.find((entry) => entry.id === "vllm-flag-unknown");
  assert.equal(new RegExp(flag.regex).exec("error: unrecognized arguments: --made-up-flag 3")[1], "--made-up-flag");
  assert.deepEqual(flag.suggestions, [{ kind: "action", action: "introspect" }]);
  const mmproj = additions.find((entry) => entry.id === "llama-mmproj-missing");
  const sample = fs.readFileSync(path.join(__dirname, "fixtures", "root-cause-samples", "llama-mmproj-missing.log.fixture"), "utf8");
  assert.ok(new RegExp(mmproj.regex).test(sample));
});

test("the 02 knowledge loader accepts the descriptor additions without reporting problems", (t) => {
  const root = tempDir(t);
  const loader = createKnowledgeLoader({
    configDir: path.join(root, "config"),
    cacheDir: path.join(root, "cache"),
    aiRoot: root,
    registry: registryFor(t),
    recheckMs: 0,
    flushIntervalMs: 0,
  });
  t.after(() => loader.close?.());
  // The descriptor additions sit beside the bundled 02 signatures (MOD-12).
  for (const [engineId, id] of [["vllm", "vllm-flag-unknown"], ["sglang", "sglang-flag-unknown"], ["llamacpp", "llama-mmproj-missing"]]) {
    assert.ok(loader.errorSignatures(engineId).some((entry) => entry.id === id && entry.layer === "bundled"), id);
  }
  const problems = loader.status().errors || [];
  assert.deepEqual(problems.filter((item) => item.severity === "error"), []);
});

// ----- supervisor capture

function supervisorHarness(t, { logsFor, afterReady, launchStatuses }) {
  const registry = registryFor(t);
  const logCalls = [];
  const host = {
    kind: "docker",
    async ready() { return { ok: true, version: "fixture", detail: "", started: false }; },
    async list() { return []; },
    async inspect() { return { exists: true, running: true, status: "running", labels: {} }; },
    async ensureImage(image) { return { ok: true, pulled: false, image }; },
    async checkpoint() { return { hadPrevious: false, async commit() { return { committed: true }; }, async rollback() { return {}; } }; },
    async create(cmd) { return { name: cmd.name, id: "cid", stdout: "cid\n", stderr: "" }; },
    async logs(name, options = {}) { logCalls.push(options.tail); return logsFor(options.tail); },
    async stop() { return { removed: true }; },
  };
  const api = {
    appendLog() {},
    setJobProgress(job, patch) { job.progress = { ...(job.progress || {}), ...patch }; },
    scheduleJobsSave() {},
    finishJob(job) { job.status = "success"; },
    failJob(job, error) { job.status = "error"; job.error = String(error?.message || error); },
    assertActive() {},
  };
  const supervisor = createRuntimeSupervisor({
    managerId: "llama",
    host,
    registry,
    jobs: api,
    events: { emit() {}, publish() {} },
    launchStore: {
      beginLaunch(job) { job.meta.launchId = "lch_TESTTESTTESTTESTTEST"; return job.meta.launchId; },
      recordCommand() {},
      markStatus(launchId, status, options) { launchStatuses.push({ launchId, status, patch: options?.patch }); },
    },
    getters: {
      containerStatus: async () => ({ exists: true, running: true, status: "Up" }),
      servedModels: async () => [{ id: "fixture-model" }],
    },
    hooks: { afterReady },
    delay: async () => {},
  });
  const job = { id: "job-1", status: "running", logs: [], meta: {} };
  const run = {
    options: { instanceMode: "replace", containerName: "llama-local", port: 18080 },
    engineId: "llamacpp",
    engineName: "llama.cpp",
    containerName: "llama-local",
    instanceId: "primary",
    port: 18080,
    gpuIds: [],
    buildCommand: () => ({
      runArgs: ["run", "-d", "--name", "llama-local", "--label", "ai.manager=llama", "fixture-image"],
      publish: ["-p", "127.0.0.1:18080:8080"],
      image: "fixture-image",
      secretEnv: {},
    }),
    wait: { serviceUrl: "http://127.0.0.1:18080/v1", probe: async () => ({ ok: true, detail: "fixture" }) },
  };
  return { supervisor, job, run, logCalls };
}

test("the supervisor stores resolved.logFacts and passes them to afterReady", async (t) => {
  const text = fixture("llamacpp-startup");
  const contexts = [];
  const statuses = [];
  const { supervisor, job, run, logCalls } = supervisorHarness(t, {
    logsFor: () => text,
    afterReady: async (context) => { contexts.push(context); },
    launchStatuses: statuses,
  });
  await supervisor.start({ job, run });
  assert.equal(job.status, "success", job.error);
  const expected = {
    layersOnGpu: 33,
    layersTotal: 33,
    modelBufferMiB: { CUDA0: 2410.55, CUDA1: 2210.25 },
    kvBufferMiB: { CUDA0: 1024, CUDA1: 1024 },
    computeBufferMiB: { CUDA0: 300.25, CUDA1: 310.5 },
  };
  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0].logFacts, expected);
  const running = statuses.find((item) => item.status === "running");
  assert.deepEqual(running.patch.resolved.logFacts, expected);
  assert.ok(logCalls.includes(2000), "one deeper read catches facts that scrolled out of the polling tail");
});

test("a failing log read never fails the launch and leaves empty facts", async (t) => {
  const contexts = [];
  const { supervisor, job, run } = supervisorHarness(t, {
    logsFor: () => { throw new Error("docker logs unavailable"); },
    afterReady: async (context) => { contexts.push(context); },
    launchStatuses: [],
  });
  await supervisor.start({ job, run });
  assert.equal(job.status, "success", job.error);
  assert.deepEqual(contexts[0].logFacts, {});
});

test("the supervisor builds inferProgress from the descriptor unless the run supplies one", async (t) => {
  const seen = [];
  for (const supplied of [false, true]) {
    const registry = registryFor(t);
    const own = () => ({ percent: 50, stage: "own", detail: "" });
    const { supervisor, job, run } = supervisorHarness(t, { logsFor: () => "", afterReady: async () => {}, launchStatuses: [] });
    void supervisor;
    const wrapped = createRuntimeSupervisor({
      managerId: "llama",
      host: { kind: "docker", async ready() { return { ok: true, version: "f", detail: "", started: false }; }, async list() { return []; },
        async inspect() { return { exists: true, running: true, status: "running", labels: {} }; }, async ensureImage(image) { return { ok: true, image }; },
        async checkpoint() { return { hadPrevious: false, async commit() { return {}; }, async rollback() { return {}; } }; },
        async create(cmd) { return { name: cmd.name, id: "cid", stdout: "", stderr: "" }; }, async logs() { return ""; }, async stop() { return {}; } },
      registry,
      jobs: { appendLog() {}, setJobProgress() {}, scheduleJobsSave() {}, finishJob(target) { target.status = "success"; }, failJob() {}, assertActive() {} },
      waitForRuntimeReady: async (options) => { seen.push(options.inferProgress); },
      probes: {},
    });
    await wrapped.start({ job, run: { ...run, wait: { ...run.wait, ...(supplied ? { inferProgress: own } : {}) } } });
    if (supplied) assert.equal(seen[seen.length - 1], own);
    else assert.equal(seen[seen.length - 1]("main: server is listening on http://0.0.0.0:8080").phase, "api");
  }
});
