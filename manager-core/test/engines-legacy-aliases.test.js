"use strict";

// Legacy alias table (01-engines §9.5): every builtin profile config survives
// legacyConfig → values → legacyConfig unchanged, the codecs read the legacy
// fields the way the managers do, and a legacy /api/start body becomes a v2
// request without coercing the engine. The builtin configs come from the
// managers' own normalizeLaunchConfig, loaded through the golden harness.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const harness = require("./helpers/engine-golden-stubs");
const { legacyFormDefaults } = require("./helpers/legacy-form-defaults");

harness.prepareGoldenEnvironment();
const core = require("../index");
const { createVllmDefaultLaunchProfiles } = require("../../vllm-manager/lib/default-profiles");
const { createLlamaDefaultLaunchProfiles } = require("../../llama-manager/lib/default-profiles");

const aliases = core.engines.legacyAliases;
const FAKE_API_KEY = "fake-legacy-alias-key-0001";

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function catalogs(t) {
  return core.engines.createParamCatalog({ overrideDir: tempDir(t, "launch-params-") });
}

function registry(t) {
  return core.engines.createEngineRegistry({ overrideDir: tempDir(t, "engines-override-"), env: {} });
}

// Every builtin profile with the engine its config launches.
function builtinProfiles() {
  const vllm = harness.loadServer("vllm");
  const llama = harness.loadServer("llama");
  return [
    ...createVllmDefaultLaunchProfiles(vllm.internals.normalizeLaunchConfig).map((profile) => ({ manager: "vllm", engineId: profile.config.engine, profile })),
    ...createLlamaDefaultLaunchProfiles(llama.server.normalizeLaunchConfig).map((profile) => ({ manager: "llama", engineId: "llamacpp", profile })),
  ];
}

test("legacyConfig → values → legacyConfig is the identity for every builtin profile config", (t) => {
  const loader = catalogs(t);
  const profiles = builtinProfiles();
  assert.equal(profiles.length, 15);
  assert.deepEqual([...new Set(profiles.map((item) => item.engineId))].sort(), ["llamacpp", "sglang", "vllm"]);
  for (const { engineId, profile } of profiles) {
    const catalog = loader.loadCatalog(engineId);
    const config = profile.config;
    const values = aliases.legacyConfigToValues(config, engineId, { catalog });
    for (const id of Object.keys(values)) assert.ok(catalog.byId.has(id), `${profile.id}: ${id} is not a ${engineId} param`);

    const back = aliases.valuesToLegacyConfig(values, engineId, { catalog, base: config });
    assert.deepEqual(back, config, profile.id);
    // Same keys in the same order: the stored file is byte-identical too.
    assert.equal(JSON.stringify(back), JSON.stringify(config), profile.id);

    // Without a base the values give back exactly the config's param fields.
    const owned = aliases.legacyFieldSet(catalog);
    const paramFields = Object.fromEntries(Object.entries(config).filter(([key]) => owned.has(key)));
    assert.deepEqual(aliases.valuesToLegacyConfig(values, engineId, { catalog }), paramFields, profile.id);

    // The values are valid catalog values for that engine.
    const checked = core.engines.validateValues(values, catalog, { legacy: true });
    assert.deepEqual(checked.errors, [], profile.id);
  }
});

test("present-but-unset fields stay null in values and come back in their legacy spelling", (t) => {
  const loader = catalogs(t);
  const sglang = loader.loadCatalog("sglang");
  const config = { sglangMaxTotalTokens: 0, sglangChunkedPrefillSize: 0, sglangAttentionBackend: "", quantization: "", name: "", reasoningParser: "", toolCallParser: "auto" };
  const values = aliases.legacyConfigToValues(config, "sglang", { catalog: sglang });
  assert.deepEqual(values, {
    "sglang.maxTotalTokens": null,
    "sglang.chunkedPrefillSize": null,
    "sglang.attentionBackend": null,
    quantization: null,
    servedName: null,
    reasoningParser: null,
    // "auto" asks the platform to infer the parser from the model; it is a choice, not unset.
    toolCallParser: "auto",
  });
  assert.deepEqual(aliases.valuesToLegacyConfig(values, "sglang", { catalog: sglang }), config);
  // A v2 value maps to the legacy field; unset numbers go back to the legacy 0.
  assert.deepEqual(aliases.valuesToLegacyConfig({ "sglang.maxTotalTokens": 262144, "sglang.pageSize": null }, "sglang", { catalog: sglang }),
    { sglangMaxTotalTokens: 262144, sglangPageSize: 0 });
  // Planner entries carry their value inside.
  assert.deepEqual(aliases.valuesToLegacyConfig({ contextLength: { value: 131072, source: "planner" } }, "sglang", { catalog: sglang }), { maxModelLen: 131072 });
  // Form strings are numbers first: "0" is the legacy unset too, as boundedNonNegativeInteger reads it.
  const strings = aliases.legacyConfigToValues({ sglangMaxTotalTokens: "0", sglangPageSize: " 0 ", sglangChunkedPrefillSize: "8192", sglangMambaTrackInterval: "0", sglangMaxMambaCacheSize: "0" }, "sglang", { catalog: sglang });
  assert.deepEqual(strings, { "sglang.maxTotalTokens": null, "sglang.pageSize": null, "sglang.chunkedPrefillSize": 8192, "sglang.mambaTrackInterval": null, "sglang.maxMambaCacheSize": null });
  assert.deepEqual(core.engines.validateValues(strings, sglang, { legacy: true }).errors, []);
  const vllm = loader.loadCatalog("vllm");
  assert.deepEqual(aliases.legacyConfigToValues({ maxNumBatchedTokens: "0" }, "vllm", { catalog: vllm }), { "vllm.maxNumBatchedTokens": null });
});

test("legacy values today's managers accept validate: Pennyroyal's load format and free-text tensor splits", (t) => {
  const loader = catalogs(t);
  const sglang = loader.loadCatalog("sglang");
  const llama = loader.loadCatalog("llamacpp");
  // The one SGLang recipe that sets --load-format passes safetensors.
  const { PENNYROYAL_DEFAULTS } = require("../../vllm-manager/lib/pennyroyal");
  const pennyroyal = aliases.legacyConfigToValues(PENNYROYAL_DEFAULTS, "sglang", { catalog: sglang });
  assert.equal(pennyroyal["vllm.loadFormat"], "safetensors");
  assert.deepEqual(core.engines.validateValues(pennyroyal, sglang, { legacy: true }).errors, []);
  // llama.cpp splits --tensor-split on commas or slashes and skips spaces; the form passes the text through.
  for (const split of ["24,8", "24, 8", "24/8", " 24 , 8 ", "0.75,0.25", ".5,1"]) {
    const values = aliases.legacyConfigToValues({ tensorSplit: split }, "llamacpp", { catalog: llama });
    assert.deepEqual(core.engines.validateValues(values, llama, {}).errors, [], split);
  }
  for (const split of ["24,,8", "a,b", "24;8", "-1,2"]) {
    const values = aliases.legacyConfigToValues({ tensorSplit: split }, "llamacpp", { catalog: llama });
    assert.deepEqual(core.engines.validateValues(values, llama, {}).errors.map((item) => item.code), ["invalid_choice"], split);
  }
});

test("prefix caching reads the enable/disable pair the way the launch path does", (t) => {
  const vllm = catalogs(t).loadCatalog("vllm");
  const decode = (config) => aliases.legacyConfigToValues(config, "vllm", { catalog: vllm }).prefixCaching;
  assert.equal(decode({ enablePrefixCaching: true, disablePrefixCaching: false }), true);
  assert.equal(decode({ enablePrefixCaching: false, disablePrefixCaching: false }), null);
  assert.equal(decode({ enablePrefixCaching: false, disablePrefixCaching: true }), false);
  assert.equal(decode({ enablePrefixCaching: true, disablePrefixCaching: true }), false);
  // The form sends only the disable box; not disabled means the explicit flag.
  assert.equal(decode({ disablePrefixCaching: false }), true);
  assert.equal(decode({ disablePrefixCaching: true }), false);
  assert.equal(decode({}), undefined);
  const encode = (value) => aliases.valuesToLegacyConfig({ prefixCaching: value }, "vllm", { catalog: vllm });
  assert.deepEqual(encode(true), { enablePrefixCaching: true, disablePrefixCaching: false });
  assert.deepEqual(encode(false), { enablePrefixCaching: false, disablePrefixCaching: true });
  assert.deepEqual(encode(null), { enablePrefixCaching: false, disablePrefixCaching: false });
});

test("inverted and default-true booleans, aliases and engine-specific gpuMemoryUtilization", (t) => {
  const loader = catalogs(t);
  const sglang = loader.loadCatalog("sglang");
  const llama = loader.loadCatalog("llamacpp");
  const vllm = loader.loadCatalog("vllm");

  // sglangDisableThinkingByDefault → reasoning.defaultEnabled (false = off by default, null = unset).
  assert.equal(aliases.legacyConfigToValues({ sglangDisableThinkingByDefault: true }, "sglang", { catalog: sglang })["reasoning.defaultEnabled"], false);
  assert.equal(aliases.legacyConfigToValues({ sglangDisableThinkingByDefault: false }, "sglang", { catalog: sglang })["reasoning.defaultEnabled"], null);
  assert.deepEqual(aliases.valuesToLegacyConfig({ "reasoning.defaultEnabled": false }, "sglang", { catalog: sglang }), { sglangDisableThinkingByDefault: true });

  // textOnlyMode / languageModelOnly: true unless one says false; both written back.
  const textOnly = (config) => aliases.legacyConfigToValues(config, "llamacpp", { catalog: llama })["llamacpp.textOnly"];
  assert.equal(textOnly({ textOnlyMode: true }), true);
  assert.equal(textOnly({ languageModelOnly: "off" }), false);
  assert.equal(textOnly({ textOnlyMode: true, languageModelOnly: false }), false);
  assert.deepEqual(aliases.valuesToLegacyConfig({ "llamacpp.textOnly": false }, "llamacpp", { catalog: llama }), { textOnlyMode: false, languageModelOnly: false });

  // Aliases: the first field holding a value wins; only the canonical field is written.
  const llamaValues = aliases.legacyConfigToValues({ kvCacheDtype: "q8_0", top_p: 0.95, top_k: 64, fitTargetMib: 2048, specDraftModel: "C:/fixture/models/draft.gguf", splitMode: "row" }, "llamacpp", { catalog: llama });
  assert.equal(llamaValues["llamacpp.cacheTypeK"], "q8_0");
  assert.equal(llamaValues["llamacpp.cacheTypeV"], "q8_0");
  assert.equal(llamaValues.topP, 0.95);
  assert.equal(llamaValues.topK, 64);
  assert.equal(llamaValues["llamacpp.fitTargetMb"], 2048);
  assert.equal(llamaValues["speculative.draftModel"], "C:/fixture/models/draft.gguf");
  assert.equal(llamaValues["llamacpp.splitMode"], "row");
  assert.equal(aliases.legacyConfigToValues({ cacheTypeK: "q4_0", kvCacheDtype: "q8_0" }, "llamacpp", { catalog: llama })["llamacpp.cacheTypeK"], "q4_0");
  assert.equal(aliases.legacyConfigToValues({ cacheTypeK: "", kvCacheDtype: "q8_0" }, "llamacpp", { catalog: llama })["llamacpp.cacheTypeK"], "q8_0");
  assert.deepEqual(aliases.valuesToLegacyConfig({ topP: 0.9, "llamacpp.fitTargetMb": 1024 }, "llamacpp", { catalog: llama }), { topP: 0.9, fitTargetMb: 1024 });

  // gpuMemoryUtilization lands on each engine's own memory param.
  assert.deepEqual(aliases.legacyConfigToValues({ gpuMemoryUtilization: 0.9 }, "vllm", { catalog: vllm }), { "vllm.gpuMemoryUtilization": 0.9 });
  assert.deepEqual(aliases.legacyConfigToValues({ gpuMemoryUtilization: 0.9 }, "sglang", { catalog: sglang }), { "sglang.memFractionStatic": 0.9 });
  assert.deepEqual(aliases.legacyConfigToValues({ gpuMemoryUtilization: 0.9 }, "llamacpp", { catalog: llama }), { "llamacpp.planningUtilization": 0.9 });
  // Form strings for numbers become numbers.
  assert.equal(aliases.legacyConfigToValues({ maxModelLen: "32768" }, "vllm", { catalog: vllm }).contextLength, 32768);
});

test("an API key never enters values and is never copied back from a base config", (t) => {
  const vllm = catalogs(t).loadCatalog("vllm");
  const config = { model: "C:/fixture/models/demo", apiKey: FAKE_API_KEY, maxModelLen: 8192 };
  const values = aliases.legacyConfigToValues(config, "vllm", { catalog: vllm });
  assert.deepEqual(values, { contextLength: 8192 });
  const back = aliases.valuesToLegacyConfig({ ...values, apiKey: FAKE_API_KEY }, "vllm", { catalog: vllm, base: config });
  assert.deepEqual(back, { model: "C:/fixture/models/demo", maxModelLen: 8192 });
  assert.doesNotMatch(JSON.stringify(back), new RegExp(FAKE_API_KEY));
});

test("legacyBodyToRequest maps a vllm-manager form body to a v2 request", (t) => {
  const engines = registry(t);
  const loader = catalogs(t);
  const flashNext = engines.runtimesFor("sglang").find((ref) => ref.manifestKey === "sglangFlashNext");
  const { request, warnings } = aliases.legacyBodyToRequest({
    engine: "sglang",
    model: "C:/fixture/models/RadixArk-Qwen3.8-Flash-Next-NVFP4",
    name: "qwen3.8-flash-next",
    port: "8001",
    instanceMode: "parallel",
    instanceId: "second",
    networkAccess: "lan",
    gpuDeviceIds: "0,1",
    runtimeImage: flashNext.image,
    apiKey: FAKE_API_KEY,
    maxModelLen: 262144,
    maxNumSeqs: 1,
    gpuMemoryUtilization: 0.995,
    multiGpuMode: "single",
    tensorParallelSize: 2,
    sglangMaxTotalTokens: 262144,
    maxNumBatchedTokens: 8192,
  }, { managerId: "vllm", registry: engines, paramCatalog: loader });
  assert.equal(request.engineId, "sglang");
  assert.equal(request.runtimeId, "sglang@qwen38flashnext-sm120-dac5523d");
  assert.equal(request.recipeId, undefined);
  assert.deepEqual(request.model, { ref: "C:/fixture/models/RadixArk-Qwen3.8-Flash-Next-NVFP4", servedName: "qwen3.8-flash-next" });
  assert.deepEqual(request.instance, { mode: "parallel", networkAccess: "lan", gpuIds: ["0", "1"], id: "second", port: 8001 });
  assert.equal(request.apiKey, FAKE_API_KEY);
  assert.equal(Object.hasOwn(request.values, "apiKey"), false);
  assert.equal(request.values.contextLength, 262144);
  assert.equal(request.values["sglang.memFractionStatic"], 0.995);
  assert.equal(request.values["sglang.maxTotalTokens"], 262144);
  // "single" keeps every parallel size at 1, as today's launch request does.
  assert.equal(request.values.tensorParallel, 1);
  assert.deepEqual(request.legacy, { multiGpuMode: "single" });
  // maxNumBatchedTokens is vLLM-only: accepted with a warning (01 §25).
  assert.deepEqual(warnings.map((item) => [item.field, item.code, item.param]), [["maxNumBatchedTokens", "param_not_applicable", "vllm.maxNumBatchedTokens"]]);
  assert.match(warnings[0].message, /SGLang/);
});

test("legacyBodyToRequest stays quiet about untouched form defaults and keeps the chosen parallel size", (t) => {
  const engines = registry(t);
  const loader = catalogs(t);
  // The body each shipped form posts untouched, read from its index.html.
  const vllmForm = legacyFormDefaults("vllm");
  // The PLE box is checked by default and posted for every engine.
  assert.equal(vllmForm.sglangPleOffloadEmbedding, true);
  for (const engine of ["sglang", "vllm", ""]) {
    const { request, warnings } = aliases.legacyBodyToRequest({ ...vllmForm, model: "C:/fixture/models/demo", engine }, { managerId: "vllm", registry: engines, paramCatalog: loader });
    assert.equal(request.engineId, engine || "vllm");
    assert.deepEqual(warnings, [], engine || "(default)");
    assert.deepEqual(request.legacy, { multiGpuMode: "single" });
    // validateValues has nothing to say about the defaults either.
    assert.deepEqual(core.engines.validateValues(request.values, loader.loadCatalog(request.engineId), { legacy: true }), { errors: [], warnings: [] }, engine || "(default)");
  }
  const llamaForm = legacyFormDefaults("llama");
  llamaForm.languageModelOnly = llamaForm.textOnlyMode;
  const llama = aliases.legacyBodyToRequest({ ...llamaForm, model: "C:/fixture/models/demo.gguf" }, { managerId: "llama", registry: engines, paramCatalog: loader });
  assert.deepEqual(llama.warnings, []);
  assert.deepEqual(core.engines.validateValues(llama.request.values, loader.loadCatalog("llamacpp"), { legacy: true }), { errors: [], warnings: [] });

  // A value the user changed still warns.
  const changed = aliases.legacyBodyToRequest({ ...vllmForm, engine: "vllm", sglangPleOffloadEmbedding: false, sglangMaxTotalTokens: 4096 }, { managerId: "vllm", registry: engines, paramCatalog: loader });
  assert.deepEqual(changed.warnings.map((item) => [item.field, item.code]), [["sglangMaxTotalTokens", "param_not_applicable"]]);
  const tensor = aliases.legacyBodyToRequest({ model: "m", multiGpuMode: "tensor", tensorParallelSize: 2, pipelineParallelSize: 4 }, { managerId: "vllm", registry: engines, paramCatalog: loader }).request;
  assert.deepEqual([tensor.values.tensorParallel, tensor.values.pipelineParallel, tensor.values.dataParallel], [2, 1, 1]);
  // Without a size for the chosen mode the resolver fills it from the GPU count.
  const pipeline = aliases.legacyBodyToRequest({ model: "m", multiGpuMode: "pipeline" }, { managerId: "vllm", registry: engines, paramCatalog: loader }).request;
  assert.deepEqual([pipeline.values.tensorParallel, Object.hasOwn(pipeline.values, "pipelineParallel"), pipeline.values.dataParallel], [1, false, 1]);
});

test("legacyBodyToRequest resolves runtime images to runtimeIds, the Pennyroyal recipe or an image override", (t) => {
  const engines = registry(t);
  const loader = catalogs(t);
  const options = { managerId: "vllm", registry: engines, paramCatalog: loader };
  const pennyroyal = engines.runtimesFor("sglang").find((ref) => ref.manifestKey === "sglangPennyroyal");
  const pinned = aliases.legacyBodyToRequest({ engine: "sglang", model: "m", runtimeImage: pennyroyal.image }, options).request;
  assert.deepEqual([pinned.runtimeId, pinned.recipeId, pinned.runtime], ["sglang@pennyroyal-v2.5.1", "pennyroyal-v251", undefined]);
  const custom = aliases.legacyBodyToRequest({ engine: "vllm", model: "m", runtimeImage: "example.invalid/custom/vllm:dev" }, options).request;
  assert.deepEqual([custom.runtimeId, custom.runtime], [undefined, { imageOverride: "example.invalid/custom/vllm:dev" }]);
  const none = aliases.legacyBodyToRequest({ engine: "vllm", model: "m", runtimeImage: "" }, options).request;
  assert.deepEqual([none.runtimeId, none.runtime], [undefined, undefined]);
  // Validated by today's normalizeRuntimeImage: what it accepts still launches as an override.
  for (const image of ["Local/SGLang:Dev", "example.invalid/team/sglang@sha256:" + "a".repeat(64)]) {
    const accepted = aliases.legacyBodyToRequest({ engine: "sglang", model: "m", runtimeImage: image }, options);
    assert.deepEqual(accepted.request.runtime, { imageOverride: image }, image);
    assert.deepEqual(accepted.warnings, [], image);
  }
  for (const image of ["bad image; rm -rf", "--privileged", "-v/:/host", `a${"b".repeat(512)}`]) {
    assert.throws(() => aliases.legacyBodyToRequest({ engine: "vllm", model: "m", runtimeImage: image }, options),
      (error) => error.status === 400 && error.code === "invalid_runtime_image" && / \/ /.test(error.message), image);
  }
  // Another engine's manifest image is no 404: today it simply runs, so it becomes an override with a warning.
  const vllmImage = engines.defaultRuntime("vllm").image;
  const crossed = aliases.legacyBodyToRequest({ engine: "sglang", model: "m", runtimeImage: vllmImage }, options);
  assert.deepEqual([crossed.request.runtimeId, crossed.request.runtime], [undefined, { imageOverride: vllmImage }]);
  assert.deepEqual(crossed.warnings.map((item) => [item.field, item.code, item.engineId]), [["runtimeImage", "runtime_other_engine", "vllm"]]);
  assert.match(crossed.warnings[0].message, /vLLM/);
});

test("legacyBodyToRequest never coerces the engine (01 §3)", (t) => {
  const engines = registry(t);
  const loader = catalogs(t);
  const vllmOptions = { managerId: "vllm", registry: engines, paramCatalog: loader };
  const llamaOptions = { managerId: "llama", registry: engines, paramCatalog: loader };
  assert.equal(aliases.legacyBodyToRequest({ model: "m" }, vllmOptions).request.engineId, "vllm");
  assert.equal(aliases.legacyBodyToRequest({ model: "m", engine: "SGLang" }, vllmOptions).request.engineId, "sglang");
  assert.equal(aliases.legacyBodyToRequest({ model: "m" }, llamaOptions).request.engineId, "llamacpp");
  assert.equal(aliases.legacyBodyToRequest({ model: "m", engine: "llama" }, llamaOptions).request.engineId, "llamacpp");
  for (const [engine, options] of [["bogus", vllmOptions], ["llama", vllmOptions], ["sglang", llamaOptions], ["lmdeploy", vllmOptions]]) {
    assert.throws(() => aliases.legacyBodyToRequest({ model: "m", engine }, options), (error) => error.status === 400 && error.code === "unknown_engine", engine);
  }
  assert.throws(() => aliases.legacyBodyToRequest([], vllmOptions), (error) => error.status === 400 && error.code === "invalid_body");
  assert.throws(() => aliases.legacyBodyToRequest({}, { managerId: "nope", registry: engines }), TypeError);
});

test("llama-manager bodies: split mode is a param, and the dead loadFormat control warns only when changed", (t) => {
  const engines = registry(t);
  const loader = catalogs(t);
  const options = { managerId: "llama", registry: engines, paramCatalog: loader };
  const quiet = aliases.legacyBodyToRequest({ model: "m", multiGpuMode: "layer", tensorSplit: "22,8", loadFormat: "auto", top_p: 0.9 }, options);
  assert.deepEqual(quiet.warnings, []);
  assert.equal(quiet.request.legacy, undefined);
  assert.equal(quiet.request.values["llamacpp.splitMode"], "layer");
  assert.equal(quiet.request.values.topP, 0.9);
  const ignored = aliases.legacyBodyToRequest({ model: "m", loadFormat: "gguf" }, options);
  assert.deepEqual(ignored.warnings.map((item) => [item.field, item.code]), [["loadFormat", "param_ignored"]]);
});
