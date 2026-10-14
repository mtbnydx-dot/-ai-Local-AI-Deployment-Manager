"use strict";

// The P0 flag additions (docs/overhaul/01-engines.md §9.4, ENG-17): every
// listed parameter is in its engine's catalog with zh/en copy, the three
// tier-1 adapters append the ones that are set (and only those) after the
// legacy engine args in catalog order, and the catalog rules answer with field
// errors. The byte-for-byte argv of every golden (new parameters unset) is
// asserted by engines-golden.test.js.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// No installed <AI_ROOT>/config file may leak into these assertions.
const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");
const catalogEmit = require("../engines/adapters/_catalog-emit");
const paramCatalog = require("../engines/param-catalog");

const engines = core.engines;
const registry = engines.createEngineRegistry({ env: {}, overrideDir: EMPTY_CONFIG_DIR });

// --- the §9.4 inventory --------------------------------------------------------

const P0_PARAMS = Object.freeze({
  llamacpp: [
    "llamacpp.nCpuMoe", "llamacpp.cpuMoe", "llamacpp.overrideTensor", "llamacpp.threads", "llamacpp.threadsBatch",
    "chatTemplate", "llamacpp.chatTemplateName", "llamacpp.kvUnified", "llamacpp.swaFull", "lora.adapters",
    "rope.scaling", "rope.scale", "rope.freqBase", "rope.yarnOrigCtx", "speculative.method",
  ],
  vllm: [
    "vllm.enforceEager", "hfOverrides", "chatTemplate", "chatTemplateKwargs", "generationConfig", "lora.adapters",
    "vllm.lora.maxLoras", "vllm.lora.maxRank", "speculative.method", "role",
  ],
  sglang: [
    "dataParallel", "pipelineParallel", "sglang.epSize", "sglang.maxPrefillTokens", "sglang.cudaGraphMaxBs",
    "speculative.method", "sglang.speculativeNumSteps", "sglang.speculativeEagleTopk", "speculative.numTokens",
    "speculative.draftModel", "sglang.hicache.enable", "sglang.hicache.ratio", "role", "hfOverrides",
  ],
});

function textOf(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertBilingual(value, where) {
  assert.ok(value && textOf(value.zh) && textOf(value.en), `${where} needs zh and en text`);
  assert.match(value.zh, /[\u4e00-\u9fff]/, `${where}.zh is Chinese`);
  assert.match(value.en, /[A-Za-z]/, `${where}.en is English`);
}

// Field errors carry one string, "<zh> / <en>".
function assertBilingualText(message, where) {
  assert.equal(typeof message, "string", where);
  const [zh, en] = message.split(" / ");
  assertBilingual({ zh, en }, where);
}

for (const [engineId, ids] of Object.entries(P0_PARAMS)) {
  test(`${engineId}: every 9.4 parameter is in the catalog with zh and en copy`, () => {
    const catalog = paramCatalog.loadCatalog(engineId);
    assert.deepEqual(catalog.errors, []);
    for (const id of ids) {
      const param = catalog.byId.get(id);
      assert.ok(param, `${engineId} has ${id}`);
      assertBilingual(param.label, `${id}.label`);
      assertBilingual(param.summary, `${id}.summary`);
      for (const key of ["what", "whenToChange", "tradeoffs"]) assertBilingual(param.help?.[key], `${id}.help.${key}`);
    }
  });
}

test("the new parameters are unset by default: no platform default is a value an adapter would emit", () => {
  const added = {
    llamacpp: ["llamacpp.nCpuMoe", "llamacpp.cpuMoe", "llamacpp.overrideTensor", "llamacpp.threads", "llamacpp.threadsBatch", "chatTemplate", "llamacpp.chatTemplateName", "llamacpp.kvUnified", "llamacpp.swaFull", "lora.adapters", "rope.scaling", "rope.scale", "rope.freqBase", "rope.yarnOrigCtx"],
    vllm: ["hfOverrides", "chatTemplate", "lora.adapters", "vllm.lora.maxLoras", "vllm.lora.maxRank", "role"],
    sglang: ["sglang.epSize", "sglang.maxPrefillTokens", "sglang.cudaGraphMaxBs", "sglang.speculativeNumSteps", "sglang.speculativeEagleTopk", "sglang.hicache.enable", "sglang.hicache.ratio", "role", "hfOverrides"],
  };
  for (const [engineId, ids] of Object.entries(added)) {
    const catalog = paramCatalog.loadCatalog(engineId);
    for (const id of ids) {
      const param = catalog.byId.get(id);
      assert.equal(param.platformDefault, null, `${id} has no platform default`);
      assert.equal(param.emit.mode, "catalog", `${id} is emitted by the generic catalog block`);
    }
  }
});

// --- adapter fixtures ------------------------------------------------------------

const API_KEY = "fixture-api-key-0001";

function vllmPlan(extra = {}, overrides = {}) {
  return {
    engineId: "vllm",
    values: {
      servedName: "fixture-model", contextLength: 32768, concurrency: 4, dtype: "auto", quantization: "", kvCacheDtype: "auto",
      "vllm.gpuMemoryUtilization": 0.9, "sglang.memFractionStatic": 0.85,
      ...extra,
    },
    fixed: { args: [], env: {}, labels: [], dockerFlags: [], slots: {} },
    instance: { port: 8001, networkAccess: "local", serviceHost: "127.0.0.1", gpuIds: ["0"] },
    legacy: { preset: {}, runOptions: {}, quantization: {} },
    ...overrides,
  };
}

function managerCtx(engineId, overrides = {}) {
  return {
    descriptor: registry.get(engineId),
    runtime: { runtimeId: `${engineId}@fixture`, manifestKey: null, image: `fixture/${engineId}:pinned`, features: {}, compatVersion: null },
    host: {
      kind: "docker",
      containerPort: 8000,
      config: {
        modelsRoot: "C:/fixture/models", hfCache: "C:/fixture/cache/hf", vllmCache: "C:/fixture/cache/vllm",
        sglangCache: "C:/fixture/cache/sglang", containerName: "vllm-local", managerLabelValue: "vllm-manager",
      },
      labelKeys: { manager: "ai.manager", engine: "ai.manager.engine", apiKeyRef: "ai.manager.api-key-ref" },
      modelMountArgs: ["-v", "C:/fixture/models:/models"],
    },
    model: { modelArg: "/models/fixture-model", effectiveLoadFormat: "auto", localPath: "C:/fixture/models/fixture-model" },
    hostFacts: { platform: "linux", gpus: [], env: {} },
    secrets: {},
    jobId: "serve-fixture",
    admission: { leaseId: "lease-fixture", vramReservationMb: 1234 },
    launchId: null,
    toContainerPath: (value) => String(value).replace("C:/fixture/models", "/models"),
    dockerGpuArg: (ids) => `device=${ids.join(",")}`,
    dockerPublishArgs: (port, _access, host) => [`${host || "127.0.0.1"}:${port}:8000`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    normalizeGpuIds: (ids) => ids || [],
    lanAddress: () => "192.0.2.10",
    ...overrides,
  };
}

function llamaPlan(extra = {}) {
  return {
    engineId: "llamacpp",
    values: {
      servedName: "qwen-vision", contextLength: 32768, concurrency: 2, "llamacpp.planningUtilization": 0.9,
      "llamacpp.gpuLayers": 999, "llamacpp.batchSize": 2048, "llamacpp.ubatchSize": 512, "llamacpp.cacheTypeK": "q8_0",
      "llamacpp.cacheTypeV": "q8_0", "llamacpp.flashAttention": "auto", "llamacpp.splitMode": "none", "llamacpp.mainGpu": 0,
      "llamacpp.reasoning": "auto", "llamacpp.reasoningFormat": "auto", "llamacpp.reasoningEffort": "high",
      "llamacpp.reasoningBudget": 1024, "llamacpp.mmprojDevice": "CUDA0", "llamacpp.textOnly": false,
      ...extra,
    },
    instance: { mode: "replace", id: "primary", port: 8080, networkAccess: "local", serviceHost: "127.0.0.1", gpuIds: ["0"] },
    secrets: {},
    launch: { jobId: "serve-adapter" },
    recipe: null,
  };
}

function llamaCtx(overrides = {}) {
  return {
    runtime: { runtimeId: "llamacpp@b10630", manifestKey: "llama", image: "llama:pinned", features: { reasoningEffort: true, mmprojDevice: true }, default: true },
    host: { config: { containerName: "llama-local", managerLabelValue: "llama-manager", hfCache: "C:/fixture/cache", modelsRoot: "C:/fixture/models" } },
    model: {
      ref: "C:/fixture/models/qwen-vision/model.gguf",
      modelArg: "/models/qwen-vision/model.gguf",
      ggufFiles: [{ path: "C:/fixture/models/qwen-vision/model.gguf" }, { path: "C:/fixture/models/qwen-vision/mmproj-F16.gguf" }],
    },
    secrets: {},
    toContainerPath: (value) => String(value).replace("C:/fixture/models", "/models"),
    dockerGpuArg: (ids) => `device=${ids.join(",")}`,
    dockerPublishArgs: (port) => [`127.0.0.1:${port}:8080`],
    ...overrides,
  };
}

function build(engineId, plan, ctx) {
  return engines.adapters[engineId].buildLaunch(plan, ctx);
}

function valueAfter(list, flag) {
  const index = list.indexOf(flag);
  return index < 0 ? undefined : list[index + 1];
}

// The appended block: what the command adds over the same launch with none of
// the new parameters set. The legacy part must be a byte-identical prefix.
function appended(engineId, extra, makePlan, makeCtx, { before = null, baseExtra = {} } = {}) {
  const base = build(engineId, makePlan(baseExtra), makeCtx());
  const withNew = build(engineId, makePlan({ ...baseExtra, ...extra }), makeCtx());
  assert.deepEqual(withNew.docker.flags, base.docker.flags, "docker flags do not change");
  assert.equal(withNew.docker.image, base.docker.image);
  const baseArgs = base.docker.args;
  const stop = before ? baseArgs.indexOf(before) : -1;
  const head = stop >= 0 ? baseArgs.slice(0, stop) : baseArgs;
  assert.deepEqual(withNew.docker.args.slice(0, head.length), head, "legacy engine args keep their order");
  const tail = withNew.docker.args.slice(head.length);
  return { base, withNew, tail, rest: stop >= 0 ? baseArgs.slice(stop) : [] };
}

// --- unset means no argv change ------------------------------------------------

test("unset, empty and false values add nothing: the argv equals the launch without the new parameters", () => {
  const empties = {
    hfOverrides: {}, chatTemplate: "", role: "chat", "lora.adapters": [], "vllm.lora.maxLoras": null, "vllm.lora.maxRank": null,
    "speculative.method": "off", "vllm.enforceEager": false,
  };
  const vBase = build("vllm", vllmPlan(), managerCtx("vllm"));
  assert.deepEqual(build("vllm", vllmPlan(empties), managerCtx("vllm")).docker.args, vBase.docker.args);
  const sglangEmpties = {
    "sglang.epSize": null, "sglang.maxPrefillTokens": 0, "sglang.cudaGraphMaxBs": 0, "sglang.speculativeNumSteps": null,
    "sglang.hicache.enable": false, "sglang.hicache.ratio": null, role: "chat", hfOverrides: null, dataParallel: 1, pipelineParallel: 1,
  };
  const sBase = build("sglang", vllmPlan({}, { engineId: "sglang" }), managerCtx("sglang"));
  assert.deepEqual(build("sglang", vllmPlan(sglangEmpties, { engineId: "sglang" }), managerCtx("sglang")).docker.args, sBase.docker.args);
  const lEmpties = {
    "llamacpp.nCpuMoe": 0, "llamacpp.cpuMoe": false, "llamacpp.overrideTensor": [], "llamacpp.threads": null, "llamacpp.kvUnified": false,
    "llamacpp.swaFull": false, "lora.adapters": [], chatTemplate: "",
  };
  const lBase = build("llamacpp", llamaPlan(), llamaCtx());
  assert.deepEqual(build("llamacpp", llamaPlan(lEmpties), llamaCtx()).docker.args, lBase.docker.args);
});

// --- llama.cpp -----------------------------------------------------------------

const LLAMA_ALL = Object.freeze({
  "llamacpp.nCpuMoe": 12,
  "llamacpp.cpuMoe": false,
  "llamacpp.overrideTensor": [{ pattern: "blk.1.ffn_.*_exps", buffer: "CPU" }, { pattern: "blk.2.ffn_.*_exps", buffer: "CUDA1" }],
  "llamacpp.threads": 8,
  "llamacpp.threadsBatch": 16,
  chatTemplate: "C:/fixture/models/templates/chat.jinja",
  "llamacpp.chatTemplateName": "chatml",
  "llamacpp.kvUnified": true,
  "llamacpp.swaFull": true,
  "lora.adapters": [{ path: "C:/fixture/models/lora/a.gguf" }, { path: "C:/fixture/models/lora/b.gguf", scale: 0.5 }],
  "rope.scaling": "yarn",
  "rope.scale": 4,
  "rope.freqBase": 1000000,
  "rope.yarnOrigCtx": 32768,
});

test("llama.cpp: the appended block follows the legacy args in catalog order", () => {
  const { tail, withNew } = appended("llamacpp", LLAMA_ALL, llamaPlan, llamaCtx);
  assert.deepEqual(tail, [
    // model group
    "--chat-template-file", "/models/templates/chat.jinja",
    "--chat-template", "chatml",
    "--rope-scaling", "yarn",
    "--rope-scale", "4",
    "--rope-freq-base", "1000000",
    "--yarn-orig-ctx", "32768",
    // memory group
    "--n-cpu-moe", "12",
    "-ot", "blk.1.ffn_.*_exps=CPU",
    "-ot", "blk.2.ffn_.*_exps=CUDA1",
    "--kv-unified",
    "--swa-full",
    // lora group
    "--lora", "/models/lora/a.gguf",
    "--lora-scaled", "/models/lora/b.gguf", "0.5",
    // runtime-expert group
    "-t", "8",
    "-tb", "16",
  ]);
  // Nothing about the secret channel or the docker flags moved.
  assert.deepEqual(withNew.secretEnv, {});
});

test("llama.cpp: --cpu-moe alone, and each rope flag follows its own condition", () => {
  const { tail } = appended("llamacpp", { "llamacpp.cpuMoe": true, "rope.scaling": "linear", "rope.yarnOrigCtx": 4096 }, llamaPlan, llamaCtx);
  // yarnOrigCtx applies only with the yarn method, so it is left out here.
  assert.deepEqual(tail, ["--rope-scaling", "linear", "--cpu-moe"]);
});

test("llama.cpp: speculative.method accepts every mode the adapter knows and keeps its legacy emission", () => {
  const choices = paramCatalog.loadCatalog("llamacpp").byId.get("speculative.method").choices.map((choice) => choice.value);
  for (const mode of ["draft-simple", "ngram-map-k", "ngram-map-k4v", "ngram-mod", "ngram-cache"]) assert.ok(choices.includes(mode), mode);
  const command = build("llamacpp", llamaPlan({ "speculative.method": "ngram-map-k4v" }), llamaCtx());
  assert.equal(valueAfter(command.docker.args, "--spec-type"), "ngram-map-k4v");
  assert.equal(command.docker.args.filter((arg) => arg === "--spec-type").length, 1);
});

// --- vLLM ----------------------------------------------------------------------

const VLLM_ALL = Object.freeze({
  hfOverrides: { rope_scaling: { rope_type: "yarn", factor: 4, original_max_position_embeddings: 32768 } },
  chatTemplate: "C:/fixture/models/templates/chat.jinja",
  role: "rerank",
  "lora.adapters": [{ name: "sql", path: "C:/fixture/models/lora/sql" }, { name: "chat", path: "C:/fixture/models/lora/chat" }],
  "vllm.lora.maxLoras": 2,
  "vllm.lora.maxRank": 64,
  "speculative.method": "eagle3",
  "speculative.draftModel": "C:/fixture/models/draft",
  "speculative.numTokens": 4,
});

test("vLLM: the appended block follows the legacy args in catalog order", () => {
  const { tail } = appended("vllm", VLLM_ALL, vllmPlan, () => managerCtx("vllm"));
  assert.deepEqual(tail, [
    "--runner", "pooling", "--convert", "classify",
    "--chat-template", "/models/templates/chat.jinja",
    "--hf-overrides", JSON.stringify(VLLM_ALL.hfOverrides),
    "--speculative-config", JSON.stringify({ method: "eagle3", model: "/models/draft", num_speculative_tokens: 4 }),
    "--enable-lora", "--lora-modules", "sql=/models/lora/sql", "chat=/models/lora/chat",
    "--max-loras", "2",
    "--max-lora-rank", "64",
  ]);
});

test("vLLM: role embedding converts to embed, chat adds nothing, and enforceEager stays user-settable", () => {
  assert.deepEqual(appended("vllm", { role: "embedding" }, vllmPlan, () => managerCtx("vllm")).tail, ["--runner", "pooling", "--convert", "embed"]);
  assert.deepEqual(appended("vllm", { role: "chat" }, vllmPlan, () => managerCtx("vllm")).tail, []);
  const command = build("vllm", vllmPlan({ "vllm.enforceEager": true }), managerCtx("vllm"));
  assert.equal(command.docker.args.filter((arg) => arg === "--enforce-eager").length, 1);
});

test("vLLM: draft_model, ngram and mtp build the speculative config; a recipe's own config wins", () => {
  const draft = appended("vllm", { "speculative.method": "draft_model", "speculative.draftModel": "C:/fixture/models/draft" }, vllmPlan, () => managerCtx("vllm"));
  assert.deepEqual(draft.tail, ["--speculative-config", JSON.stringify({ method: "draft_model", model: "/models/draft", num_speculative_tokens: 3 })]);
  const ngram = appended("vllm", { "speculative.method": "ngram", "speculative.numTokens": 5 }, vllmPlan, () => managerCtx("vllm"));
  assert.deepEqual(ngram.tail, ["--speculative-config", JSON.stringify({ method: "ngram", num_speculative_tokens: 5 })]);
  // off, auto and dspark are not vLLM methods the generic block builds.
  for (const method of ["off", "auto", "dspark"]) assert.deepEqual(appended("vllm", { "speculative.method": method }, vllmPlan, () => managerCtx("vllm")).tail, []);
  // vllm.speculativeConfig (a recipe's) is emitted by the legacy block, and the generic block stays out.
  const recipe = build("vllm", vllmPlan({ "vllm.speculativeConfig": { method: "mtp", num_speculative_tokens: 2 }, "speculative.method": "eagle3", "speculative.draftModel": "C:/fixture/models/draft" }), managerCtx("vllm"));
  assert.equal(recipe.docker.args.filter((arg) => arg === "--speculative-config").length, 1);
  assert.equal(valueAfter(recipe.docker.args, "--speculative-config"), JSON.stringify({ method: "mtp", num_speculative_tokens: 2 }));
});

test("vLLM: LoRA sizing is inactive without adapters, so it adds nothing", () => {
  assert.deepEqual(appended("vllm", { "vllm.lora.maxLoras": 4, "vllm.lora.maxRank": 128 }, vllmPlan, () => managerCtx("vllm")).tail, []);
});

test("vLLM: --generation-config takes a host path through the container path converter and keeps the keywords", () => {
  assert.equal(valueAfter(build("vllm", vllmPlan({ generationConfig: "vllm" }), managerCtx("vllm")).docker.args, "--generation-config"), "vllm");
  assert.equal(valueAfter(build("vllm", vllmPlan({ generationConfig: "auto" }), managerCtx("vllm")).docker.args, "--generation-config"), "auto");
  assert.equal(valueAfter(build("vllm", vllmPlan({ generationConfig: "C:/fixture/models/gen-config" }), managerCtx("vllm")).docker.args, "--generation-config"), "/models/gen-config");
});

// --- SGLang --------------------------------------------------------------------

const sglangPlan = (extra = {}, overrides = {}) => vllmPlan(extra, { engineId: "sglang", ...overrides });

const SGLANG_ALL = Object.freeze({
  dataParallel: 2,
  pipelineParallel: 2,
  tensorParallel: 4,
  expertParallel: true,
  "sglang.epSize": 8,
  "sglang.maxPrefillTokens": 16384,
  "sglang.cudaGraphMaxBs": 64,
  "speculative.method": "eagle3",
  "speculative.numTokens": 4,
  "speculative.draftModel": "C:/fixture/models/draft",
  "sglang.speculativeNumSteps": 3,
  "sglang.speculativeEagleTopk": 2,
  "sglang.hicache.enable": true,
  "sglang.hicache.ratio": 2.5,
  role: "embedding",
  hfOverrides: { rope_scaling: { rope_type: "yarn", factor: 4 } },
});

test("SGLang: the appended block follows the legacy args in catalog order and ends before --api-key", () => {
  const withKey = () => managerCtx("sglang", { secrets: { apiKey: API_KEY } });
  const { tail: appendedArgs, rest, withNew } = appended("sglang", SGLANG_ALL, sglangPlan, withKey, { before: "--api-key", baseExtra: { tensorParallel: 4 } });
  // --api-key stays the last flag, exactly as before.
  assert.deepEqual(rest, ["--api-key", API_KEY]);
  assert.deepEqual(appendedArgs.slice(-2), rest);
  assert.deepEqual(appendedArgs.slice(0, -2), [
    "--is-embedding",
    "--json-model-override-args", JSON.stringify(SGLANG_ALL.hfOverrides),
    "--max-prefill-tokens", "16384",
    "--enable-hierarchical-cache",
    "--hicache-ratio", "2.5",
    "--pp-size", "2",
    "--dp-size", "2",
    // sglang.epSize comes before the expertParallel switch and wins the flag.
    "--ep-size", "8",
    "--speculative-algorithm", "EAGLE3",
    "--speculative-num-draft-tokens", "4",
    "--speculative-draft-model-path", "/models/draft",
    "--speculative-num-steps", "3",
    "--speculative-eagle-topk", "2",
    "--cuda-graph-max-bs", "64",
  ]);
  assert.deepEqual(withNew.redactions, [API_KEY]);
});

test("SGLang: expertParallel alone passes the tensor-parallel size, and tokenizer uses --tokenizer-path", () => {
  const { tail } = appended("sglang", { expertParallel: true, tokenizer: "C:/fixture/models/tok" }, sglangPlan, () => managerCtx("sglang"), { baseExtra: { tensorParallel: 4 } });
  assert.deepEqual(tail, ["--tokenizer-path", "/models/tok", "--ep-size", "4"]);
});

test("SGLang: the CUDA graph flag follows the runtime version and flag introspection", () => {
  const at = (compatVersion, introspected) => appended("sglang", { "sglang.cudaGraphMaxBs": 32 }, sglangPlan,
    () => managerCtx("sglang", { runtime: { runtimeId: "sglang@fixture", manifestKey: null, image: "fixture/sglang:pinned", features: {}, compatVersion }, introspected })).tail;
  assert.deepEqual(at("0.5.20"), ["--cuda-graph-max-bs", "32"]);
  assert.deepEqual(at("0.5.21"), ["--cuda-graph-max-bs-decode", "32"]);
  assert.deepEqual(at("0.5.20", { flags: [{ flag: "--cuda-graph-max-bs-decode" }] }), ["--cuda-graph-max-bs-decode", "32"]);
});

test("SGLang: algorithms map to their upper-case names and a speculative recipe or DSPARK keeps the group out", () => {
  for (const [method, name] of [["eagle", "EAGLE"], ["nextn", "NEXTN"], ["standalone", "STANDALONE"], ["ngram", "NGRAM"]]) {
    assert.deepEqual(appended("sglang", { "speculative.method": method }, sglangPlan, () => managerCtx("sglang")).tail, ["--speculative-algorithm", name]);
  }
  // A recipe's NEXTN tail (fixed args) is not repeated or contradicted.
  const recipe = build("sglang", sglangPlan({ "speculative.method": "eagle3", "speculative.draftModel": "C:/fixture/models/draft", "sglang.speculativeNumSteps": 5 }, {
    fixed: { args: ["--speculative-algorithm", "NEXTN", "--speculative-num-steps", "3"], env: {}, labels: [], dockerFlags: [], slots: {} },
  }), managerCtx("sglang"));
  assert.equal(recipe.docker.args.filter((arg) => arg === "--speculative-algorithm").length, 1);
  assert.equal(valueAfter(recipe.docker.args, "--speculative-algorithm"), "NEXTN");
  assert.equal(valueAfter(recipe.docker.args, "--speculative-num-steps"), "3");
  // DSPARK keeps its adapter emission, in either spelling.
  for (const method of ["DSPARK", "dspark"]) {
    const dspark = build("sglang", sglangPlan({ "speculative.method": method, "speculative.draftModel": "C:/fixture/models/draft", "sglang.speculativeNumSteps": 5 }), managerCtx("sglang"));
    assert.equal(dspark.docker.args.filter((arg) => arg === "--speculative-algorithm").length, 1);
    assert.equal(valueAfter(dspark.docker.args, "--speculative-algorithm"), "DSPARK");
    assert.equal(dspark.docker.args.filter((arg) => arg === "--speculative-draft-model-path").length, 1);
    assert.ok(!dspark.docker.args.includes("--speculative-num-steps"));
  }
});

test("SGLang: HiCache sizing and the EAGLE steps wait for the switch that makes them apply", () => {
  assert.deepEqual(appended("sglang", { "sglang.hicache.ratio": 3 }, sglangPlan, () => managerCtx("sglang")).tail, []);
  assert.deepEqual(appended("sglang", { "sglang.speculativeNumSteps": 3 }, sglangPlan, () => managerCtx("sglang")).tail, []);
});

// --- the emitter on its own ------------------------------------------------------

test("emitCatalogArgs: a flag already in the args is never emitted twice, and values may carry provenance", () => {
  const ctx = { toContainerPath: (value) => value };
  assert.deepEqual(catalogEmit.emitCatalogArgs({ engineId: "llamacpp", ctx, values: { "llamacpp.threads": { value: 4, source: "user" } } }), ["-t", "4"]);
  assert.deepEqual(catalogEmit.emitCatalogArgs({ engineId: "llamacpp", ctx, values: { "llamacpp.threads": 4 }, existingArgs: ["-t", "2"] }), []);
});

test("emitCatalogArgs: a parameter the runtime lacks is left out", () => {
  const introspected = { flags: [{ flag: "--ep-size" }] };
  const runtime = { runtimeId: "sglang@fixture", features: {}, compatVersion: "0.5.30" };
  const catalog = paramCatalog.loadCatalog("sglang", { runtime, introspected });
  const out = catalogEmit.emitCatalogArgs({ engineId: "sglang", ctx: { catalog, toContainerPath: (value) => value }, values: { "sglang.epSize": 2, "sglang.maxPrefillTokens": 2048 } });
  assert.deepEqual(out, ["--ep-size", "2"]);
});

// --- rules ---------------------------------------------------------------------

function errorsOf(engineId, values, ctx = {}) {
  const catalog = paramCatalog.loadCatalog(engineId);
  return paramCatalog.validateValues(values, catalog, ctx);
}

function codes(items) {
  return items.map((item) => `${item.field}:${item.code}`).sort();
}

test("llama.cpp rules: n-cpu-moe excludes cpu-moe", () => {
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.nCpuMoe": 8, "llamacpp.cpuMoe": true }).errors), ["llamacpp.nCpuMoe:cpu_moe_conflict"]);
  assert.deepEqual(errorsOf("llamacpp", { "llamacpp.nCpuMoe": 8, "llamacpp.cpuMoe": false }).errors, []);
  assert.deepEqual(errorsOf("llamacpp", { "llamacpp.cpuMoe": true }).errors, []);
  assert.deepEqual(errorsOf("llamacpp", { "llamacpp.nCpuMoe": 8 }).errors, []);
  const { errors } = errorsOf("llamacpp", { "llamacpp.nCpuMoe": 8, "llamacpp.cpuMoe": true });
  assertBilingualText(errors[0].message, "the rule message");
});

test("llama.cpp rules: a quantised V cache needs Flash Attention, and ubatch cannot exceed batch", () => {
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.cacheTypeV": "q8_0", "llamacpp.flashAttention": "off" }).errors), ["llamacpp.cacheTypeV:quantized_v_cache_needs_flash_attention"]);
  for (const flash of ["auto", "on"]) assert.deepEqual(errorsOf("llamacpp", { "llamacpp.cacheTypeV": "q4_0", "llamacpp.flashAttention": flash }).errors, []);
  assert.deepEqual(errorsOf("llamacpp", { "llamacpp.cacheTypeV": "f16", "llamacpp.flashAttention": "off" }).errors, []);
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.batchSize": 512, "llamacpp.ubatchSize": 1024 }).errors), ["llamacpp.ubatchSize:ubatch_exceeds_batch"]);
  assert.deepEqual(errorsOf("llamacpp", { "llamacpp.batchSize": 1024, "llamacpp.ubatchSize": 1024 }).errors, []);
  // The platform defaults (batch 2048, ubatch 512) satisfy the rule when only one side is given.
  assert.deepEqual(errorsOf("llamacpp", { "llamacpp.ubatchSize": 2048 }).errors, []);
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.batchSize": 256 }).errors), ["llamacpp.ubatchSize:ubatch_exceeds_batch"]);
});

test("vLLM and SGLang rules: draft-based speculative methods need a draft model", () => {
  for (const method of ["eagle3", "draft_model"]) {
    assert.deepEqual(codes(errorsOf("vllm", { "speculative.method": method }).errors), ["speculative.method:speculative_needs_draft_model"]);
    assert.deepEqual(codes(errorsOf("vllm", { "speculative.method": method, "speculative.draftModel": "" }).errors), ["speculative.method:speculative_needs_draft_model"]);
    assert.deepEqual(errorsOf("vllm", { "speculative.method": method, "speculative.draftModel": "C:/fixture/models/draft" }).errors, []);
  }
  for (const method of ["off", "ngram", "mtp"]) assert.deepEqual(errorsOf("vllm", { "speculative.method": method }).errors, []);
  for (const method of ["eagle", "eagle3", "standalone"]) {
    assert.deepEqual(codes(errorsOf("sglang", { "speculative.method": method }).errors), ["speculative.method:speculative_needs_draft_model"]);
    assert.deepEqual(errorsOf("sglang", { "speculative.method": method, "speculative.draftModel": "C:/fixture/models/draft" }).errors, []);
  }
  for (const method of ["nextn", "ngram"]) assert.deepEqual(errorsOf("sglang", { "speculative.method": method }).errors, []);
});

test("SGLang rules: CPU HiCache warns under Windows only when it is on", () => {
  const win = { facts: { "host.platform": "win32" } };
  assert.deepEqual(codes(errorsOf("sglang", { "sglang.hicache.enable": true }, win).warnings), ["sglang.hicache.enable:hicache_wsl_unverified"]);
  assert.deepEqual(errorsOf("sglang", { "sglang.hicache.enable": false }, win).warnings, []);
  assert.deepEqual(errorsOf("sglang", {}, win).warnings, []);
  assert.deepEqual(errorsOf("sglang", { "sglang.hicache.enable": true }, { facts: { "host.platform": "linux" } }).warnings, []);
  const warning = errorsOf("sglang", { "sglang.hicache.enable": true }, win).warnings[0];
  assert.equal(warning.message, "CPU HiCache 在 WSL 下未验证 / CPU HiCache is unverified under WSL");
});

test("ranges and choices: values outside the 9.4 limits are field errors", () => {
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.nCpuMoe": 513 }).errors), ["llamacpp.nCpuMoe:out_of_range"]);
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.nCpuMoe": -1 }).errors), ["llamacpp.nCpuMoe:out_of_range"]);
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.threads": 0 }).errors), ["llamacpp.threads:out_of_range"]);
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.threadsBatch": 257 }).errors), ["llamacpp.threadsBatch:out_of_range"]);
  assert.deepEqual(codes(errorsOf("llamacpp", { "rope.scaling": "ntk" }).errors), ["rope.scaling:invalid_choice"]);
  assert.deepEqual(codes(errorsOf("vllm", { "vllm.lora.maxRank": 513 }).errors), ["vllm.lora.maxRank:out_of_range"]);
  assert.deepEqual(codes(errorsOf("vllm", { role: "ranker" }).errors), ["role:invalid_choice"]);
  assert.deepEqual(codes(errorsOf("sglang", { role: "rerank" }).errors), ["role:invalid_choice"]);
  assert.deepEqual(errorsOf("llamacpp", { "llamacpp.nCpuMoe": 512, "llamacpp.threads": 256 }).errors, []);
});

test("json overrides are capped at 8 KiB", () => {
  for (const engineId of ["vllm", "sglang"]) {
    assert.deepEqual(errorsOf(engineId, { hfOverrides: { rope_scaling: { factor: 4 } } }).errors, []);
    assert.deepEqual(codes(errorsOf(engineId, { hfOverrides: { text: "x".repeat(9000) } }).errors), ["hfOverrides:too_long"]);
    assert.deepEqual(codes(errorsOf(engineId, { hfOverrides: "{}" }).errors), ["hfOverrides:invalid_type"]);
  }
});

test("list items: tensor overrides, LoRA adapters and their limits", () => {
  const ok = [{ pattern: "blk.[0-9]+.ffn_.*_exps", buffer: "CPU" }, { pattern: "output", buffer: "CUDA0" }];
  assert.deepEqual(errorsOf("llamacpp", { "llamacpp.overrideTensor": ok }).errors, []);
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.overrideTensor": [{ pattern: "a", buffer: "GPU0" }] }).errors), ["llamacpp.overrideTensor[0].buffer:invalid_item_value"]);
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.overrideTensor": [{ pattern: "x".repeat(201), buffer: "CPU" }] }).errors), ["llamacpp.overrideTensor[0].pattern:too_long"]);
  // "=" and "," would split the -ot argument in the wrong place.
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.overrideTensor": [{ pattern: "a=b", buffer: "CPU" }, { pattern: "a,b", buffer: "CPU" }] }).errors), ["llamacpp.overrideTensor[0].pattern:invalid_item_value", "llamacpp.overrideTensor[1].pattern:invalid_item_value"]);
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.overrideTensor": [{ pattern: "a" }] }).errors), ["llamacpp.overrideTensor[0].buffer:item_field_required"]);
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.overrideTensor": ["a=CPU"] }).errors), ["llamacpp.overrideTensor[0]:invalid_item"]);
  assert.deepEqual(codes(errorsOf("llamacpp", { "llamacpp.overrideTensor": [{ pattern: "a", buffer: "CPU", extra: 1 }] }).errors), ["llamacpp.overrideTensor[0].extra:unknown_item_field"]);

  const loras = (count) => Array.from({ length: count }, (_, index) => ({ path: `C:/fixture/models/lora/${index}.gguf` }));
  assert.deepEqual(errorsOf("llamacpp", { "lora.adapters": loras(8) }).errors, []);
  assert.deepEqual(codes(errorsOf("llamacpp", { "lora.adapters": loras(9) }).errors), ["lora.adapters:too_many_items"]);
  assert.deepEqual(codes(errorsOf("llamacpp", { "lora.adapters": [{ scale: 1 }] }).errors), ["lora.adapters[0].path:item_field_required"]);
  assert.deepEqual(codes(errorsOf("llamacpp", { "lora.adapters": [{ path: "a.gguf", scale: "big" }] }).errors), ["lora.adapters[0].scale:invalid_type"]);
  assert.deepEqual(codes(errorsOf("llamacpp", { "lora.adapters": [{ path: "a.gguf", scale: 99 }] }).errors), ["lora.adapters[0].scale:out_of_range"]);
  assert.deepEqual(errorsOf("vllm", { "lora.adapters": [{ name: "sql", path: "C:/fixture/models/lora/sql" }] }).errors, []);
  assert.deepEqual(codes(errorsOf("vllm", { "lora.adapters": [{ name: "bad name", path: "p" }] }).errors), ["lora.adapters[0].name:invalid_item_value"]);
  assert.deepEqual(codes(errorsOf("vllm", { "lora.adapters": loras(9).map((item, index) => ({ name: `a${index}`, path: item.path })) }).errors), ["lora.adapters:too_many_items"]);
  assert.deepEqual(errorsOf("vllm", { "lora.adapters": [] }).errors, []);
});

// --- the catalog format itself ---------------------------------------------------

function validParam(patch = {}) {
  return {
    id: "fixture.list", group: "lora", level: "expert", order: 1, type: "list",
    label: { zh: "测试", en: "Test" }, summary: { zh: "测试", en: "Test" },
    help: { what: { zh: "测试", en: "Test" }, whenToChange: { zh: "测试", en: "Test" }, tradeoffs: { zh: "测试", en: "Test" } },
    emit: { mode: "catalog", kind: "repeat", flag: "--fixture" },
    ...patch,
  };
}

test("validateParam: emit.format, emit.map and item are checked", () => {
  const groups = new Set(["lora"]);
  const problems = (patch) => paramCatalog.validateParam(validParam(patch), "params[0]", { groups }).map((item) => item.path);
  assert.deepEqual(problems({}), []);
  assert.deepEqual(problems({ emit: { mode: "catalog", kind: "repeat", flag: "--fixture", format: "lora-scaled" } }), []);
  assert.deepEqual(problems({ emit: { mode: "catalog", kind: "repeat", flag: "--fixture", format: "nope" } }), ["params[0].emit.format"]);
  assert.deepEqual(problems({ type: "enum", choices: ["a"], emit: { mode: "catalog", kind: "flag-value", flag: "--fixture", map: { a: ["--x"] } } }), []);
  assert.deepEqual(problems({ type: "enum", choices: ["a"], emit: { mode: "catalog", kind: "flag-value", flag: "--fixture", map: { a: "--x" } } }), ["params[0].emit.map"]);
  assert.deepEqual(problems({ type: "enum", choices: ["a"], emit: { mode: "catalog", kind: "flag-bool", flag: "--fixture", map: { a: ["--x"] } } }), ["params[0].emit.map"]);
  assert.deepEqual(problems({ item: { maxItems: 4, fields: { path: { type: "string", required: true } } } }), []);
  assert.deepEqual(problems({ item: { fields: {} } }), ["params[0].item.fields"]);
  assert.deepEqual(problems({ item: { fields: { path: { type: "boolean" } } } }), ["params[0].item.fields.path"]);
  assert.deepEqual(problems({ item: { maxItems: 0, fields: { path: { type: "string" } } } }), ["params[0].item.maxItems"]);
  assert.deepEqual(problems({ type: "string", item: { fields: { path: { type: "string" } } } }), ["params[0].item"]);
});

test("llama.cpp: catalogValues in the run options become plan values only where the legacy mapping left a gap", () => {
  const llamacpp = require("../engines/adapters/llamacpp");
  const plan = llamacpp.planFromRunOptions({ name: "x", threads: 4, catalogValues: { "llamacpp.nCpuMoe": 6, servedName: "ignored", "llamacpp.kvUnified": true } }, { jobId: "job" });
  assert.equal(plan.values["llamacpp.nCpuMoe"], 6);
  assert.equal(plan.values["llamacpp.kvUnified"], true);
  assert.equal(plan.values.servedName, "x");
  const command = build("llamacpp", llamaPlan(plan.values), llamaCtx());
  assert.equal(valueAfter(command.docker.args, "--n-cpu-moe"), "6");
  assert.ok(command.docker.args.includes("--kv-unified"));
});
