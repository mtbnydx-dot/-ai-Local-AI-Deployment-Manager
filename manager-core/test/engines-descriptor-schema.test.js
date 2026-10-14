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
  assert.deepEqual(files, ["llamacpp.json", "sglang.json", "vllm.json"]);
  for (const file of files) {
    const descriptor = JSON.parse(fs.readFileSync(path.join(BUNDLED_DIR, file), "utf8"));
    const result = validateDescriptor(descriptor, { mode: "bundled" });
    assert.deepEqual(result.errors, [], file);
    assert.equal(result.ok, true);
    assert.equal(`${descriptor.id}.json`, file);
    assert.equal(descriptor.schemaVersion, 1);
    assert.match(descriptor.asOf, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(descriptor.staleAfterDays > 0);
    assert.equal(descriptor.tier, 1);
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
  assert.deepEqual(registry.list().map((descriptor) => descriptor.id), ["vllm", "sglang", "llamacpp"]);
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

test("an override can add a data-driven engine; its unknown runtime is reported, not fatal", (t) => {
  const overrideDir = makeOverrideDir(t, { "lmdeploy-lab.json": templateDraft() });
  const registry = core.engines.createEngineRegistry({ overrideDir, env: {} });
  assert.equal(registry.get("lmdeploy-lab").adapter, "docker-template");
  assert.deepEqual(registry.hostedBy("vllm"), ["vllm", "sglang", "lmdeploy-lab"]);
  assert.deepEqual(registry.runtimesFor("lmdeploy-lab"), []);
  assert.deepEqual(registry.errors().map((item) => [item.source, item.engineId, item.path, item.code]), [
    ["registry", "lmdeploy-lab", "runtimes.allowed[0]", "unknown_runtime"],
  ]);
});

test("draft mode applies the override rules and writes nothing", (t) => {
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
