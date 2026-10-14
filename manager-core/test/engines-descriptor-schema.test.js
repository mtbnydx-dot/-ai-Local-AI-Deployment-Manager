"use strict";

// EngineDescriptor validation and override merging (docs/overhaul/01-engines.md
// §4, §25). Overrides are written to temp directories only; the registry never
// reads <AI_ROOT>/config here.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Point the reference-data override directory (runtime manifest, engines) at an
// empty temp dir so no installed <AI_ROOT>/config file can leak into a test.
const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");
const manifest = require("../runtime-manifest");

const { validateDescriptor } = core.engines;
const BUNDLED_DIR = path.join(__dirname, "..", "data", "engines");

function readBundled(id) {
  return JSON.parse(fs.readFileSync(path.join(BUNDLED_DIR, `${id}.json`), "utf8"));
}

function makeOverrideDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-override-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

// A runtime-manifest override under a temp AI_REFERENCE_DATA_DIR, restored
// after the test.
function withManifestOverride(t, runtimes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-manifest-"));
  fs.writeFileSync(path.join(dir, manifest.RUNTIME_MANIFEST_FILE), JSON.stringify({ asOf: "2026-10-14", runtimes }));
  process.env.AI_REFERENCE_DATA_DIR = dir;
  manifest.clearRuntimeManifestCache();
  t.after(() => {
    process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
    manifest.clearRuntimeManifestCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function codesAt(result, pathName) {
  return result.errors.filter((item) => item.path === pathName).map((item) => item.code);
}

// A complete docker-template descriptor, the shape the console's custom-engine
// builder produces (01 §19).
function templateDraft(overrides = {}) {
  return {
    schemaVersion: 1,
    asOf: "2026-10-14",
    staleAfterDays: 120,
    id: "lmdeploy-lab",
    label: { zh: "LMDeploy 实验", en: "LMDeploy lab" },
    family: "openai-server",
    adapter: "docker-template",
    tier: 2,
    status: "experimental",
    hostManager: "vllm",
    artifactFormats: ["safetensors", "awq"],
    runtimes: { default: "lmdeployLab", allowed: ["lmdeployLab"] },
    host: { kinds: ["docker"], default: "docker", containerPort: 23333, gpus: "required", allowLan: false },
    api: { openaiBase: "/v1", models: "/v1/models", health: "/health", ready: { kind: "models-list" } },
    memoryModel: { kind: "free-fraction-after-weights", fractionParam: "lmdeploy.cacheMaxEntryCount" },
    capabilities: {
      parallelInstances: true,
      tensorParallel: true,
      pipelineParallel: false,
      dataParallel: false,
      expertParallel: false,
      speculative: [],
      autoParsers: { tool: null, reasoning: null },
      lora: false,
      multiModel: false,
      hotLoad: false,
      sleepWake: false,
      roles: ["chat"],
    },
    secrets: { apiKey: { mode: "flag", flag: "--api-keys" } },
    template: { entrypoint: "lmdeploy", args: ["serve", "api_server", "{{model.containerPath}}"] },
    ...overrides,
  };
}

test("every bundled descriptor validates and is named after its id", () => {
  const files = fs.readdirSync(BUNDLED_DIR).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(files, ["external.json", "llamacpp.json", "sglang.json", "vllm.json"]);
  for (const file of files) {
    const descriptor = JSON.parse(fs.readFileSync(path.join(BUNDLED_DIR, file), "utf8"));
    const result = validateDescriptor(descriptor, { mode: "bundled" });
    assert.deepEqual(result.errors, [], file);
    assert.equal(result.ok, true);
    assert.equal(`${descriptor.id}.json`, file);
    assert.equal(descriptor.schemaVersion, 1);
    assert.match(descriptor.asOf, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(descriptor.staleAfterDays > 0);
    assert.equal(descriptor.tier, descriptor.adapter === "external" ? 3 : 1);
    assert.equal(descriptor.status, "stable");
  }
});

test("capabilities.autoParsers is exactly {tool, reasoning} with a parser name, auto or null", () => {
  assert.deepEqual(readBundled("llamacpp").capabilities.autoParsers, { tool: "auto", reasoning: "auto" });
  assert.deepEqual(readBundled("vllm").capabilities.autoParsers, { tool: null, reasoning: null });
  assert.deepEqual(readBundled("sglang").capabilities.autoParsers, { tool: null, reasoning: null });

  const missing = readBundled("sglang");
  delete missing.capabilities.autoParsers.tool;
  assert.deepEqual(codesAt(validateDescriptor(missing), "capabilities.autoParsers.tool"), ["required"]);

  const extra = readBundled("sglang");
  extra.capabilities.autoParsers.chat = "qwen3";
  assert.deepEqual(codesAt(validateDescriptor(extra), "capabilities.autoParsers.chat"), ["unknown_field"]);

  const wrongType = readBundled("vllm");
  wrongType.capabilities.autoParsers.reasoning = true;
  assert.deepEqual(codesAt(validateDescriptor(wrongType), "capabilities.autoParsers.reasoning"), ["type"]);

  const flat = readBundled("llamacpp");
  flat.capabilities.autoParsers = "auto";
  assert.deepEqual(codesAt(validateDescriptor(flat), "capabilities.autoParsers"), ["type"]);

  const absent = readBundled("llamacpp");
  delete absent.capabilities.autoParsers;
  assert.deepEqual(codesAt(validateDescriptor(absent), "capabilities.autoParsers"), ["required"]);

  const named = readBundled("vllm");
  named.capabilities.autoParsers = { tool: "hermes", reasoning: "qwen3" };
  assert.equal(validateDescriptor(named).ok, true);
});

test("metricsMap source kinds are counter, gauge or histogram and nothing else", () => {
  const valid = readBundled("sglang");
  valid.metricsMap.map = {
    kvUsageRatio: [{ name: "sglang:token_usage", kind: "gauge" }, { name: "sglang:full_token_usage", kind: "gauge" }],
    promptTokensTotal: [{ name: "sglang:prompt_tokens_total", kind: "counter" }],
    ttftSeconds: [{ name: "sglang:time_to_first_token_seconds", kind: "histogram" }],
  };
  assert.deepEqual(validateDescriptor(valid).errors, []);

  for (const kind of ["histograms", "summary", "Histogram"]) {
    const bad = readBundled("sglang");
    bad.metricsMap.map = { ttftSeconds: [{ name: "sglang:time_to_first_token_seconds", kind }] };
    assert.deepEqual(codesAt(validateDescriptor(bad), "metricsMap.map.ttftSeconds[0].kind"), ["enum"], kind);
  }

  const noKind = readBundled("vllm");
  noKind.metricsMap.map = { kvUsageRatio: [{ name: "vllm:kv_cache_usage_perc" }] };
  assert.deepEqual(codesAt(validateDescriptor(noKind), "metricsMap.map.kvUsageRatio[0].kind"), ["required"]);

  const derived = readBundled("llamacpp");
  derived.metricsMap.map = { kvUsageRatio: [{ name: "llamacpp:kv_cache_usage_ratio", kind: "gauge" }, { derive: "busySlots/nSlots" }] };
  assert.equal(validateDescriptor(derived).ok, true);

  // An override is checked by the same rules.
  const override = validateDescriptor({ id: "vllm", metricsMap: { path: "/metrics", format: "prometheus", map: { ttftSeconds: [{ name: "x", kind: "summary" }] } } }, { mode: "override" });
  assert.equal(override.kind, "override");
  assert.deepEqual(codesAt(override, "metricsMap.map.ttftSeconds[0].kind"), ["enum"]);
});

test("an override merges by id: objects merge, arrays replace, everything else is kept", (t) => {
  const overrideDir = makeOverrideDir(t, {
    "sglang-lab.json": {
      id: "sglang",
      status: "experimental",
      label: { en: "SGLang (lab)" },
      runtimes: { default: "sglangFlashNext", allowed: ["sglang", "sglangFlashNext"] },
    },
  });
  const registry = core.engines.createEngineRegistry({ overrideDir, env: {} });
  assert.deepEqual(registry.errors(), []);
  const sglang = registry.get("sglang");
  assert.equal(sglang.status, "experimental");
  assert.deepEqual(sglang.label, { zh: "SGLang", en: "SGLang (lab)" });
  assert.deepEqual(sglang.runtimes.allowed, ["sglang", "sglangFlashNext"]);
  assert.equal(sglang.runtimes.default, "sglangFlashNext");
  assert.deepEqual(sglang.runtimes.envOverride, readBundled("sglang").runtimes.envOverride, "fields the override does not name stay");
  assert.deepEqual(sglang.capabilities, readBundled("sglang").capabilities);
  assert.deepEqual(registry.runtimesFor("sglang").map((ref) => ref.runtimeId), ["sglang@0.5.17", "sglang@qwen38flashnext-sm120-dac5523d"]);
  assert.equal(registry.runtimesFor("sglang").find((ref) => ref.default).manifestKey, "sglangFlashNext");
  assert.deepEqual(registry.status().overrides.map((item) => [path.basename(item.file), item.engineId, item.applied]), [["sglang-lab.json", "sglang", true]]);
  assert.ok(Object.isFrozen(sglang.capabilities), "registry descriptors are frozen");
});

test("an invalid override is reported with its file and the bundled descriptor stays", (t) => {
  const overrideDir = makeOverrideDir(t, {
    "a-bad-status.json": { id: "vllm", status: "retired" },
    "b-broken.json": "{ not json",
    "c-bad-default.json": { id: "sglang", runtimes: { default: "sglangNowhere" } },
  });
  const registry = core.engines.createEngineRegistry({ overrideDir, env: {} });
  assert.deepEqual(registry.list().map((descriptor) => descriptor.id), ["vllm", "sglang", "llamacpp", "external"]);
  assert.equal(registry.get("vllm").status, "stable");
  assert.equal(registry.get("sglang").runtimes.default, "sglang");

  const errors = registry.errors();
  const byFile = (name) => errors.filter((item) => item.file && path.basename(item.file) === name);
  assert.deepEqual(byFile("a-bad-status.json").map((item) => [item.source, item.engineId, item.path, item.code]), [["override", "vllm", "status", "enum"]]);
  assert.deepEqual(byFile("b-broken.json").map((item) => [item.source, item.code]), [["override", "invalid_json"]]);
  assert.deepEqual(byFile("c-bad-default.json").map((item) => [item.engineId, item.path, item.code]), [["sglang", "runtimes.default", "not_allowed"]]);
  assert.equal(registry.status().ok, false);
  assert.ok(registry.status().overrides.every((item) => item.applied === false));
});

test("tier-1 engines cannot be added or redefined through an override", (t) => {
  const overrideDir = makeOverrideDir(t, {
    "redefine-vllm.json": { ...readBundled("vllm"), adapter: "docker-template", tier: 2 },
    "second-vllm.json": templateDraft({ id: "myvllm", adapter: "vllm", tier: 1, family: "vllm" }),
    "tier1-claim.json": templateDraft({ id: "fast-engine", tier: 1 }),
  });
  const registry = core.engines.createEngineRegistry({ overrideDir, env: {} });
  assert.equal(registry.get("vllm").adapter, "vllm");
  assert.equal(registry.has("myvllm"), false);
  assert.equal(registry.has("fast-engine"), false);
  const codes = (name) => registry.errors()
    .filter((item) => item.file && path.basename(item.file) === name)
    .map((item) => `${item.path}:${item.code}`);
  // Redefining a built-in touches fields an override may not change.
  for (const field of ["adapter", "tier", "host", "secrets", "capabilities"]) {
    assert.ok(codes("redefine-vllm.json").includes(`${field}:override_field_forbidden`), field);
  }
  assert.ok(codes("second-vllm.json").includes("adapter:adapter_not_allowed"));
  assert.ok(codes("tier1-claim.json").includes("tier:tier_mismatch"));
});

test("an override can add a data-driven engine whose runtime is in the manifest", (t) => {
  withManifestOverride(t, { lmdeployLab: { engineId: "lmdeploy-lab", version: "0.10.2", image: "openmmlab/lmdeploy:v0.10.2" } });
  const overrideDir = makeOverrideDir(t, { "lmdeploy-lab.json": templateDraft() });
  const registry = core.engines.createEngineRegistry({ overrideDir, env: {} });
  assert.deepEqual(registry.errors(), []);
  assert.equal(registry.get("lmdeploy-lab").adapter, "docker-template");
  assert.deepEqual(registry.hostedBy("vllm"), ["vllm", "sglang", "lmdeploy-lab"]);
  assert.deepEqual(registry.runtimesFor("lmdeploy-lab").map((ref) => [ref.runtimeId, ref.status, ref.default, ref.pullPolicy]), [
    ["lmdeploy-lab@0.10.2", "unpinned", true, "explicit"],
  ]);
  assert.deepEqual(registry.status().overrides.map((item) => [item.engineId, item.applied, item.kind]), [["lmdeploy-lab", true, "descriptor"]]);
});

test("a new engine whose runtimes do not resolve is dropped and reported, not fatal", (t) => {
  const overrideDir = makeOverrideDir(t, { "lmdeploy-lab.json": templateDraft() });
  const registry = core.engines.createEngineRegistry({ overrideDir, env: {} });
  assert.equal(registry.has("lmdeploy-lab"), false);
  assert.deepEqual(registry.hostedBy("vllm"), ["vllm", "sglang"]);
  const expected = [
    ["override", "lmdeploy-lab", "runtimes.allowed[0]", "unknown_runtime"],
    ["override", "lmdeploy-lab", "runtimes.default", "default_runtime_unresolved"],
  ];
  assert.deepEqual(registry.errors().map((item) => [item.source, item.engineId, item.path, item.code]), expected);
  assert.ok(registry.errors().every((item) => path.basename(item.file) === "lmdeploy-lab.json"));
  assert.deepEqual(registry.status().overrides.map((item) => [item.engineId, item.applied]), [["lmdeploy-lab", false]]);
  // The console's draft check gives the same verdict as loading the file.
  const draft = core.engines.validateDraftRequest(registry, { descriptor: templateDraft() }).payload;
  assert.equal(draft.ok, false);
  assert.deepEqual(draft.errors.map((item) => ["override", "lmdeploy-lab", item.path, item.code]), expected);
});

test("an override that points runtimes at a missing or foreign key is dropped and the descriptor stays", (t) => {
  const files = {
    // Another engine's runtime, as default and only allowed entry.
    "a-foreign.json": { id: "llamacpp", runtimes: { allowed: ["vllmGemma"], default: "vllmGemma" } },
    // A typo in the default, which is also listed.
    "b-typo.json": { id: "sglang", runtimes: { allowed: ["sglang", "sglangX"], default: "sglangX" } },
    // The default resolves, but one allowed key does not.
    "c-extra.json": [{ id: "vllm", runtimes: { allowed: ["vllm", "vllmNowhere"] } }],
  };
  const registry = core.engines.createEngineRegistry({ overrideDir: makeOverrideDir(t, files), env: {} });
  const rows = registry.errors().map((item) => [path.basename(item.file), item.index ?? null, item.source, item.engineId, item.path, item.code]);
  assert.deepEqual(rows, [
    ["a-foreign.json", null, "override", "llamacpp", "runtimes.allowed[0]", "runtime_engine_mismatch"],
    ["a-foreign.json", null, "override", "llamacpp", "runtimes.default", "default_runtime_unresolved"],
    ["b-typo.json", null, "override", "sglang", "runtimes.allowed[1]", "unknown_runtime"],
    ["b-typo.json", null, "override", "sglang", "runtimes.default", "default_runtime_unresolved"],
    ["c-extra.json", 0, "override", "vllm", "runtimes.allowed[1]", "unknown_runtime"],
  ]);
  assert.deepEqual(registry.status().overrides.map((item) => [path.basename(item.file), item.engineId, item.applied]), [
    ["a-foreign.json", "llamacpp", false],
    ["b-typo.json", "sglang", false],
    ["c-extra.json", "vllm", false],
  ]);

  // The bundled descriptors stay in force with every runtime and their defaults.
  for (const engineId of ["vllm", "sglang", "llamacpp"]) {
    assert.deepEqual(registry.get(engineId).runtimes, readBundled(engineId).runtimes, engineId);
  }
  assert.equal(registry.defaultRuntime("llamacpp").runtimeId, "llamacpp@b10630");
  assert.equal(registry.defaultRuntime("sglang").runtimeId, "sglang@0.5.17");
  assert.equal(registry.resolveRuntime("sglang").runtimeId, "sglang@0.5.17", "a legacy launch still resolves its runtime");
  assert.equal(registry.runtimesFor("sglang").length, 4);
  assert.equal(registry.runtimesFor("vllm").length, 3);

  // The draft check rejects each of them with the errors the load reported.
  for (const [file, content] of Object.entries(files)) {
    const entry = Array.isArray(content) ? content[0] : content;
    const draft = core.engines.validateDraftRequest(registry, { descriptor: entry }).payload;
    assert.equal(draft.ok, false, file);
    assert.equal(draft.kind, "override", file);
    assert.deepEqual(
      draft.errors.map((item) => `${item.path}:${item.code}`),
      registry.errors().filter((item) => path.basename(item.file) === file).map((item) => `${item.path}:${item.code}`),
      file,
    );
  }
});

test("the draft verdict always equals the load verdict for the same entry", (t) => {
  const entries = [
    { id: "sglang", status: "experimental" },
    { id: "sglang", runtimes: { allowed: ["sglangFlashNext", "sglang"], default: "sglangFlashNext" } },
    { id: "sglang", runtimes: { allowed: ["sglangFlashNext"] } },
    { id: "sglang", runtimes: { default: "sglangPennyroyal" } },
    { id: "sglang", runtimes: { default: "llama" } },
    { id: "llamacpp", runtimes: { allowed: ["llama", "sglang"] } },
    { id: "vllm", runtimes: { allowed: ["vllm"], default: "vllm" }, label: { en: "vLLM (pinned)" } },
    { id: "vllm", host: { containerPort: 9000 } },
    templateDraft(),
    templateDraft({ id: "unknown" }),
    templateDraft({ id: "external" }),
    templateDraft({ adapter: "sglang" }),
  ];
  for (const entry of entries) {
    const registry = core.engines.createEngineRegistry({ overrideDir: makeOverrideDir(t, { "entry.json": entry }), env: {} });
    const [loaded] = registry.status().overrides;
    const loadErrors = registry.errors().filter((item) => item.source === "override").map((item) => `${item.path}:${item.code}`);
    const pristine = core.engines.createEngineRegistry({ overrideDir: makeOverrideDir(t), env: {} });
    const draft = core.engines.validateDraftRequest(pristine, { descriptor: entry }).payload;
    const label = JSON.stringify(entry).slice(0, 120);
    assert.equal(draft.ok, loaded.applied, label);
    assert.deepEqual(draft.errors.map((item) => `${item.path}:${item.code}`), loadErrors, label);
    assert.deepEqual(registry.errors().filter((item) => item.source !== "override"), [], label);
  }
});

test("draft mode applies the override rules and writes nothing", (t) => {
  withManifestOverride(t, { lmdeployLab: { engineId: "lmdeploy-lab", version: "0.10.2", image: "openmmlab/lmdeploy:v0.10.2" } });
  const overrideDir = makeOverrideDir(t);
  const registry = core.engines.createEngineRegistry({ overrideDir, env: {} });
  const before = JSON.stringify(registry.list());

  const writes = [];
  const patched = [];
  const spy = (target, name, label) => {
    if (typeof target[name] !== "function") return;
    const original = target[name];
    target[name] = function spied(...args) {
      writes.push(`${label}.${name}`);
      return original.apply(this, args);
    };
    patched.push(() => { target[name] = original; });
  };
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "rmSync", "unlinkSync", "copyFileSync", "writeFile", "appendFile", "mkdir", "rename", "rm", "unlink"]) {
    spy(fs, name, "fs");
  }
  for (const name of ["writeFile", "appendFile", "mkdir", "rename", "rm", "unlink", "copyFile"]) spy(fs.promises, name, "fs.promises");
  let results;
  try {
    results = {
      bad: core.engines.validateDraftRequest(registry, { descriptor: templateDraft({ adapter: "vllm", host: { kinds: ["docker"] } }) }),
      good: core.engines.validateDraftRequest(registry, { descriptor: templateDraft() }),
      overrideOk: core.engines.validateDraftRequest(registry, { descriptor: { id: "sglang", status: "experimental" } }),
      overrideForbidden: core.engines.validateDraftRequest(registry, { descriptor: { id: "sglang", adapter: "docker-template" } }),
      overrideBadMerge: core.engines.validateDraftRequest(registry, { descriptor: { id: "sglang", runtimes: { allowed: ["sglangFlashNext"] } } }),
    };
  } finally {
    for (const restore of patched.reverse()) restore();
  }
  assert.deepEqual(writes, [], "validation must not write");
  assert.deepEqual(fs.readdirSync(overrideDir), []);
  assert.equal(JSON.stringify(registry.list()), before, "the registry is unchanged");

  assert.equal(results.bad.status, 200);
  assert.equal(results.bad.payload.ok, false);
  assert.ok(results.bad.payload.errors.some((item) => item.path === "adapter" && item.code === "adapter_not_allowed"));
  assert.ok(results.bad.payload.errors.some((item) => item.path === "host.default" && item.code === "required"));
  assert.ok(results.bad.payload.errors.every((item) => item.path !== undefined && item.code && item.message));
  assert.deepEqual(results.good.payload, { ok: true, kind: "descriptor", errors: [] });
  assert.deepEqual(results.overrideOk.payload, { ok: true, kind: "override", errors: [] });
  assert.deepEqual(results.overrideForbidden.payload.errors.map((item) => `${item.path}:${item.code}`), ["adapter:override_field_forbidden"]);
  // The patch itself is well-formed, but the merged descriptor would lose its default runtime.
  assert.deepEqual(results.overrideBadMerge.payload.errors.map((item) => `${item.path}:${item.code}`), ["runtimes.default:not_allowed"]);
  assert.equal(registry.get("sglang").status, "stable");
});

test("structural problems carry a path and a code", () => {
  const typo = readBundled("vllm");
  typo.autoParser = { tool: null };
  assert.deepEqual(codesAt(validateDescriptor(typo), "autoParser"), ["unknown_field"]);

  assert.deepEqual(codesAt(validateDescriptor(templateDraft({ id: "Bad_Id" }), { mode: "draft" }), "id"), ["pattern"]);
  assert.deepEqual(codesAt(validateDescriptor(templateDraft({ runtimes: { default: "other", allowed: ["lmdeployLab"] } }), { mode: "draft" }), "runtimes.default"), ["not_allowed"]);

  const regex = readBundled("vllm");
  regex.logPhases = [{ match: "Model loading took ([\\d.]+ GiB", phase: "weights", percent: 50, stageText: { zh: "加载权重", en: "Loading weights" } }];
  assert.deepEqual(codesAt(validateDescriptor(regex), "logPhases[0].match"), ["invalid_regex"]);

  const phase = readBundled("vllm");
  phase.logPhases = [{ match: "Application startup complete", phase: "serving", percent: 94 }];
  assert.deepEqual(codesAt(validateDescriptor(phase), "logPhases[0].phase"), ["enum"]);

  const hostManager = readBundled("llamacpp");
  hostManager.hostManager = "vllm";
  assert.deepEqual(codesAt(validateDescriptor(hostManager), "hostManager"), ["host_manager_mismatch"]);

  const secrets = readBundled("vllm");
  delete secrets.secrets.apiKey.env;
  assert.deepEqual(codesAt(validateDescriptor(secrets), "secrets.apiKey.env"), ["required"]);

  const template = readBundled("sglang");
  template.template = { args: [] };
  assert.deepEqual(codesAt(validateDescriptor(template), "template"), ["field_not_applicable"]);

  assert.deepEqual(validateDescriptor(null).errors.map((item) => `${item.path}:${item.code}`), [":type"]);
  assert.deepEqual(validateDescriptor([]).errors.map((item) => item.code), ["type"]);
  assert.throws(() => validateDescriptor({}, { mode: "write" }), TypeError);
});

test("an envOverride entry is one variable or a precedence list, with templates for partial values", () => {
  // The bundled data spells out today's precedence: VLLM_IMAGE, then
  // VLLM_IMAGE_VERSION as a tag; LLAMA_IMAGE, then LLAMA_IMAGE_DIGEST.
  assert.deepEqual(readBundled("vllm").runtimes.envOverride.vllm, ["VLLM_IMAGE", { env: "VLLM_IMAGE_VERSION", template: "vllm/vllm-openai:{value}" }]);
  assert.deepEqual(readBundled("llamacpp").runtimes.envOverride.llama, ["LLAMA_IMAGE", "LLAMA_IMAGE_DIGEST"]);

  const cases = [
    ["lowercase-name", "sglang_image", "runtimes.envOverride.sglang", "pattern"],
    ["empty list", [], "runtimes.envOverride.sglang", "type"],
    ["number", 7, "runtimes.envOverride.sglang", "type"],
    ["duplicate", ["SGLANG_IMAGE", { env: "SGLANG_IMAGE", template: "lmsysorg/sglang:{value}" }], "runtimes.envOverride.sglang[1]", "duplicate"],
    ["template without placeholder", [{ env: "SGLANG_IMAGE_VERSION", template: "lmsysorg/sglang:latest" }], "runtimes.envOverride.sglang[0].template", "pattern"],
    ["template with a space", [{ env: "SGLANG_IMAGE_VERSION", template: "lmsysorg/sglang:{value} --privileged" }], "runtimes.envOverride.sglang[0].template", "pattern"],
    ["template missing", [{ env: "SGLANG_IMAGE_VERSION" }], "runtimes.envOverride.sglang[0].template", "required"],
    ["unknown item field", [{ env: "SGLANG_IMAGE_VERSION", template: "lmsysorg/sglang:{value}", shell: true }], "runtimes.envOverride.sglang[0].shell", "unknown_field"],
  ];
  for (const [label, spec, pathName, code] of cases) {
    const descriptor = readBundled("sglang");
    descriptor.runtimes.envOverride.sglang = spec;
    assert.deepEqual(codesAt(validateDescriptor(descriptor), pathName), [code], label);
  }
  const list = readBundled("sglang");
  list.runtimes.envOverride.sglang = ["SGLANG_IMAGE", { env: "SGLANG_IMAGE_VERSION", template: "lmsysorg/sglang:{value}" }];
  assert.deepEqual(validateDescriptor(list).errors, []);

  // envOverride is not an override field: the env names stay what the code reads.
  const override = validateDescriptor({ id: "vllm", runtimes: { envOverride: { vllm: "MY_IMAGE" } } }, { mode: "override" });
  assert.deepEqual(override.errors.map((item) => `${item.path}:${item.code}`), ["runtimes.envOverride:override_field_forbidden"]);
});

test("envOverride may name only image variables, never one that can hold a secret", (t) => {
  const { isImageEnvName } = core.engines.descriptorSchema;
  // Every variable the managers read for an image today.
  for (const name of [
    "VLLM_IMAGE", "VLLM_IMAGE_VERSION", "VLLM_QWEN_MOE_IMAGE", "VLLM_GEMMA_IMAGE", "SGLANG_IMAGE",
    "SGLANG_FLASH_NEXT_IMAGE", "LLAMA_IMAGE", "LLAMA_IMAGE_DIGEST", "LLAMA_MUSE_IMAGE", "LMDEPLOY_IMAGE_TAG",
  ]) {
    assert.equal(isImageEnvName(name), true, name);
  }
  for (const name of ["HF_TOKEN", "VLLM_API_KEY", "OPENAI_API_KEY", "PATH", "IMAGE", "MY_KEY_IMAGE", "HF_TOKEN_IMAGE", "SECRET_IMAGE_TAG", "vllm_image", "", null]) {
    assert.equal(isImageEnvName(name), false, String(name));
  }

  const cases = [
    ["secret name", "HF_TOKEN", "runtimes.envOverride.sglang"],
    ["API key", "VLLM_API_KEY", "runtimes.envOverride.sglang"],
    ["secret word in an image name", "SGLANG_API_KEY_IMAGE", "runtimes.envOverride.sglang"],
    ["list item", ["SGLANG_IMAGE", "HF_TOKEN"], "runtimes.envOverride.sglang[1]"],
    ["template item", [{ env: "OPENAI_API_KEY", template: "lmsysorg/sglang:{value}" }], "runtimes.envOverride.sglang[0].env"],
  ];
  for (const [label, spec, pathName] of cases) {
    const descriptor = readBundled("sglang");
    descriptor.runtimes.envOverride.sglang = spec;
    const result = validateDescriptor(descriptor);
    assert.equal(result.ok, false, label);
    assert.deepEqual(codesAt(result, pathName), ["env_not_allowed"], label);
  }

  // A custom engine cannot name a secret either: the draft check and the load
  // both reject it, and nothing of the engine is applied.
  withManifestOverride(t, { lmdeployLab: { engineId: "lmdeploy-lab", version: "0.10.2", image: "openmmlab/lmdeploy:v0.10.2" } });
  const draft = templateDraft({ runtimes: { default: "lmdeployLab", allowed: ["lmdeployLab"], envOverride: { lmdeployLab: "HF_TOKEN" } } });
  const registry = core.engines.createEngineRegistry({
    overrideDir: makeOverrideDir(t, { "lmdeploy-lab.json": draft }),
    env: { HF_TOKEN: "hf_FAKEFAKEFAKEFAKEFAKE" },
  });
  const loadErrors = registry.errors().map((item) => [item.source, item.engineId, item.path, item.code]);
  assert.deepEqual(loadErrors, [["override", "lmdeploy-lab", "runtimes.envOverride.lmdeployLab", "env_not_allowed"]]);
  assert.equal(registry.has("lmdeploy-lab"), false);
  const verdict = core.engines.validateDraftRequest(registry, { descriptor: draft }).payload;
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.errors.map((item) => `${item.path}:${item.code}`), ["runtimes.envOverride.lmdeployLab:env_not_allowed"]);
  assert.ok(!JSON.stringify([registry.errors(), verdict]).includes("hf_FAKE"), "the variable's value is never read into a message");
});

test("unknown and external are reserved engine ids", () => {
  for (const mode of ["bundled", "override", "draft"]) {
    const unknown = validateDescriptor(templateDraft({ id: "unknown" }), { mode });
    assert.ok(codesAt(unknown, "id").includes("reserved_engine_id"), mode);
  }
  assert.deepEqual(codesAt(validateDescriptor(templateDraft({ id: "external" }), { mode: "draft" }), "id"), ["reserved_engine_id"]);
  const external = templateDraft({
    id: "external",
    adapter: "external",
    tier: 3,
    hostManager: "entry",
    artifactFormats: [],
    runtimes: undefined,
    api: undefined,
    secrets: undefined,
    template: undefined,
    external: {},
    host: { kinds: ["external"], default: "external" },
  });
  assert.deepEqual(validateDescriptor(JSON.parse(JSON.stringify(external)), { mode: "draft" }).errors, []);
});
