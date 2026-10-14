"use strict";

// Parameter catalogs (01-engines §9): the bundled data covers every launch
// field of both legacy manager forms, carries zh+en copy, parses its rules and
// appliesWhen, reports bad overrides without dropping the bundled definition,
// and answers availability, choices and value checks per runtime.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const expr = require("../engines/expr");
const legacyAliases = require("../engines/legacy-aliases");
const paramCatalog = require("../engines/param-catalog");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ENGINES_DATA_DIR = path.join(__dirname, "..", "data", "engines");
const CJK = /[㐀-鿿]/;

// The legacy forms and the engines whose catalogs bind their fields.
const MANAGER_FORMS = [
  { manager: "vllm-manager", html: path.join(REPO_ROOT, "vllm-manager", "public", "index.html"), engines: ["vllm", "sglang"] },
  { manager: "llama-manager", html: path.join(REPO_ROOT, "llama-manager", "public", "index.html"), engines: ["llamacpp"] },
];

// Form fields that are not launch params (01 §9.3), excluded by name.
const EXCLUDED_FIELDS = {
  // Download, search and filter forms.
  from: "download/search form", to: "download/search form", kind: "download/search form", keyword: "download/search form",
  source: "download/search form", status: "download/search form", priority: "download/search form", precision: "download/search form",
  modelVersion: "download/search form", outputName: "download/search form", storageId: "download/search form", spec: "download/search form",
  developer: "download/search form", external: "download/search form", hfToken: "download/search form", viewport: "page meta tag",
  // LaunchRequest top-level fields rather than params.
  ...Object.fromEntries(legacyAliases.REQUEST_FIELDS.map((field) => [field, "LaunchRequest top-level field"])),
};
// vllm-manager's multi-GPU layout selector: it picks which of the TP/PP/DP
// sizes the legacy launch keeps (legacy-aliases applies it); llama-manager
// binds the same name to llamacpp.splitMode.
const EXCLUDED_BY_MANAGER = { "vllm-manager": { multiGpuMode: "layout helper for the parallel sizes" } };

// Recipe-only flags that became expert params (01 §9.3, last paragraph).
const RECIPE_ONLY_PARAMS = {
  vllm: ["vllm.enforceEager", "vllm.asyncScheduling", "vllm.attentionBackend", "vllm.moeBackend", "vllm.linearBackend", "generationConfig",
    "vllm.overrideGenerationConfig", "chatTemplateKwargs", "vllm.safetensorsLoadStrategy", "vllm.reasoningParserPlugin"],
  sglang: ["chatTemplateKwargs", "sglang.mambaSchedulerStrategy", "sglang.disablePrefillCudaGraph", "sglang.mmFeatureTransport",
    "sglang.draftModelQuantization", "sglang.sleepOnIdle", "sglang.enableMetrics"],
};

// §9.3 seed rows: param id → the engines that bind it ("—" elsewhere).
const SEED_PARAMS = {
  contextLength: ["vllm", "sglang", "llamacpp"],
  concurrency: ["vllm", "sglang", "llamacpp"],
  servedName: ["vllm", "sglang", "llamacpp"],
  dtype: ["vllm", "sglang"],
  quantization: ["vllm", "sglang"],
  tokenizer: ["vllm", "sglang"],
  trustRemoteCode: ["vllm", "sglang"],
  kvCacheDtype: ["vllm", "sglang"],
  prefixCaching: ["vllm", "sglang"],
  tensorParallel: ["vllm", "sglang"],
  pipelineParallel: ["vllm", "sglang"],
  dataParallel: ["vllm", "sglang"],
  expertParallel: ["vllm", "sglang"],
  reasoningParser: ["vllm", "sglang"],
  toolCallParser: ["vllm", "sglang"],
  autoToolChoice: ["vllm", "sglang"],
  "reasoning.defaultEnabled": ["vllm", "sglang"],
  "speculative.method": ["vllm", "sglang", "llamacpp"],
  "speculative.numTokens": ["vllm", "sglang", "llamacpp"],
  "speculative.draftModel": ["vllm", "sglang", "llamacpp"],
  clientPreset: ["vllm", "sglang", "llamacpp"],
  apiKey: ["vllm", "sglang", "llamacpp"],
  "vllm.gpuMemoryUtilization": ["vllm"],
  "sglang.memFractionStatic": ["sglang"],
  "llamacpp.planningUtilization": ["llamacpp"],
  "vllm.maxNumBatchedTokens": ["vllm"],
  "vllm.cpuOffloadGb": ["vllm"],
  "vllm.kvOffloadingSize": ["vllm"],
  "vllm.mmProcessorCacheGb": ["vllm"],
  "vllm.loadFormat": ["vllm", "sglang"],
  "vllm.hfConfigPath": ["vllm"],
  "vllm.languageModelOnly": ["vllm"],
  "vllm.distributedExecutorBackend": ["vllm"],
  "sglang.maxTotalTokens": ["sglang"],
  "sglang.pageSize": ["sglang"],
  "sglang.chunkedPrefillSize": ["sglang"],
  "sglang.attentionBackend": ["sglang"],
  "sglang.fp4GemmBackend": ["sglang"],
  "sglang.pleOffloadEmbedding": ["sglang"],
  "sglang.linearAttnPrefillBackend": ["sglang"],
  "sglang.linearAttnDecodeBackend": ["sglang"],
  "sglang.mambaSsmDtype": ["sglang"],
  "sglang.mambaRadixCacheStrategy": ["sglang"],
  "sglang.mambaTrackInterval": ["sglang"],
  "sglang.maxMambaCacheSize": ["sglang"],
  "sglang.dsparkBlockSize": ["sglang"],
  "llamacpp.gpuLayers": ["llamacpp"],
  "llamacpp.fitTargetMb": ["llamacpp"],
  "llamacpp.fitCtx": ["llamacpp"],
  "llamacpp.batchSize": ["llamacpp"],
  "llamacpp.ubatchSize": ["llamacpp"],
  "llamacpp.cacheTypeK": ["llamacpp"],
  "llamacpp.cacheTypeV": ["llamacpp"],
  "llamacpp.flashAttention": ["llamacpp"],
  "llamacpp.cacheReuse": ["llamacpp"],
  "llamacpp.splitMode": ["llamacpp"],
  "llamacpp.tensorSplit": ["llamacpp"],
  "llamacpp.mainGpu": ["llamacpp"],
  "llamacpp.noMmap": ["llamacpp"],
  "llamacpp.noRepack": ["llamacpp"],
  "llamacpp.reasoning": ["llamacpp"],
  "llamacpp.reasoningFormat": ["llamacpp"],
  "llamacpp.reasoningEffort": ["llamacpp"],
  "llamacpp.reasoningBudget": ["llamacpp"],
  "llamacpp.textOnly": ["llamacpp"],
  "llamacpp.mmproj": ["llamacpp"],
  "llamacpp.mmprojDevice": ["llamacpp"],
  temperature: ["vllm", "llamacpp"],
  topP: ["vllm", "llamacpp"],
  topK: ["vllm", "llamacpp"],
};

const ENGINES = ["vllm", "sglang", "llamacpp"];

function emptyDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-params-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function bundledLoader(t) {
  return paramCatalog.createParamCatalog({ overrideDir: emptyDir(t) });
}

function overrideLoader(t, files) {
  const dir = emptyDir(t);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return paramCatalog.createParamCatalog({ overrideDir: dir });
}

function formAttributes(file, attribute) {
  const html = fs.readFileSync(file, "utf8");
  return new Set([...html.matchAll(new RegExp(`\\b${attribute}="([^"]+)"`, "g"))].map((match) => match[1]));
}

function i18nTexts(param) {
  return [
    ["label", param.label],
    ["summary", param.summary],
    ["help.what", param.help.what],
    ["help.whenToChange", param.help.whenToChange],
    ["help.tradeoffs", param.help.tradeoffs],
    ...(param.choices || []).filter((choice) => choice.label).map((choice) => [`choices.${choice.value}`, choice.label]),
    ...param.rules.map((rule) => [`rules.${rule.code}`, rule.message]),
  ];
}

test("the bundled catalogs load without errors, one per tier-1 engine descriptor", (t) => {
  const loader = bundledLoader(t);
  assert.deepEqual(loader.status().errors, []);
  assert.deepEqual(loader.engineIds(), [...ENGINES].sort());
  const common = JSON.parse(fs.readFileSync(path.join(paramCatalog.BUNDLED_PARAMS_DIR, "common.json"), "utf8"));
  for (const engineId of ENGINES) {
    const descriptor = JSON.parse(fs.readFileSync(path.join(ENGINES_DATA_DIR, `${engineId}.json`), "utf8"));
    assert.equal(descriptor.catalog, `launch-params/${engineId}.json`);
    const file = JSON.parse(fs.readFileSync(path.join(paramCatalog.BUNDLED_PARAMS_DIR, `${engineId}.json`), "utf8"));
    assert.equal(file.engineId, engineId);
    // Rule 7.5: data files carry schemaVersion, asOf and staleAfterDays.
    for (const data of [file, common]) {
      assert.equal(data.schemaVersion, 1);
      assert.match(data.asOf, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Number.isInteger(data.staleAfterDays) && data.staleAfterDays > 0);
    }
    const catalog = loader.loadCatalog(engineId);
    assert.deepEqual(catalog.errors, [], engineId);
    assert.equal(catalog.catalogVersion, `${file.asOf}+${common.asOf}`);
    assert.ok(catalog.params.length > 20, engineId);
    assert.equal(catalog.byId.size, catalog.params.length);
  }
});

test("every name=\"…\" field of both manager forms is mapped to a param or explicitly excluded", (t) => {
  const loader = bundledLoader(t);
  for (const form of MANAGER_FORMS) {
    const mapped = new Map();
    for (const engineId of form.engines) {
      const catalog = loader.loadCatalog(engineId);
      for (const [field, ids] of Object.entries(catalog.byLegacyField)) mapped.set(field, [...(mapped.get(field) || []), ...ids]);
      for (const item of catalog.legacyIgnored) mapped.set(item.field, [...(mapped.get(item.field) || []), `ignored:${item.code}`]);
    }
    const excluded = { ...EXCLUDED_FIELDS, ...(EXCLUDED_BY_MANAGER[form.manager] || {}) };
    const unaccounted = [...formAttributes(form.html, "name")].filter((name) => !mapped.has(name) && !Object.hasOwn(excluded, name));
    assert.deepEqual(unaccounted, [], `${form.manager}: form fields with neither a param nor an exclusion`);
    // An exclusion never hides a field that is in fact a param.
    for (const name of Object.keys(excluded)) assert.equal(mapped.has(name), false, `${form.manager}: ${name} is excluded but mapped to ${mapped.get(name)}`);
  }
});

test("legacy domIds are unique per catalog and name real elements of the manager's form", (t) => {
  const loader = bundledLoader(t);
  for (const form of MANAGER_FORMS) {
    const ids = formAttributes(form.html, "id");
    for (const engineId of form.engines) {
      const catalog = loader.loadCatalog(engineId);
      const seen = new Map();
      for (const param of catalog.params) {
        const domId = param.legacy?.domId;
        if (!domId) continue;
        assert.equal(seen.has(domId), false, `${engineId}: domId ${domId} used by ${seen.get(domId)} and ${param.id}`);
        seen.set(domId, param.id);
        assert.ok(ids.has(domId), `${engineId}: ${param.id} names #${domId}, which ${form.manager}/public/index.html does not have`);
      }
      for (const item of catalog.legacyIgnored) {
        if (item.domId) assert.ok(ids.has(item.domId), `${engineId}: ignored ${item.field} names #${item.domId}`);
      }
      assert.ok(seen.size > 10, engineId);
    }
  }
});

test("every label, summary, help text, choice label and rule message is zh+en", (t) => {
  const loader = bundledLoader(t);
  for (const engineId of ENGINES) {
    const catalog = loader.loadCatalog(engineId);
    for (const group of catalog.groups) {
      assert.ok(group.label.zh.trim() && group.label.en.trim(), `group ${group.id}`);
      assert.match(group.label.zh, CJK, `group ${group.id}`);
    }
    for (const param of catalog.params) {
      for (const [where, text] of i18nTexts(param)) {
        assert.equal(typeof text.zh, "string", `${engineId} ${param.id} ${where}.zh`);
        assert.equal(typeof text.en, "string", `${engineId} ${param.id} ${where}.en`);
        assert.ok(text.zh.trim() && text.en.trim(), `${engineId} ${param.id} ${where}`);
        assert.doesNotMatch(text.en, CJK, `${engineId} ${param.id} ${where}.en is not English`);
        // Labels may be product names (Flash Attention); explanations are written in Chinese.
        if (where !== "label" && !where.startsWith("choices.")) assert.match(text.zh, CJK, `${engineId} ${param.id} ${where}.zh is not Chinese`);
      }
      // Rule 7.6: a raw flag is never the label.
      for (const lang of ["zh", "en"]) {
        assert.doesNotMatch(param.label[lang], /^-{1,2}[a-z]/i, `${engineId} ${param.id} label.${lang}`);
        for (const flag of paramCatalog.candidateFlags(param, null)) assert.notEqual(param.label[lang], flag);
      }
    }
    for (const item of catalog.legacyIgnored) {
      assert.match(item.reason.zh, CJK);
      assert.doesNotMatch(item.reason.en, CJK);
    }
  }
});

test("rules, appliesWhen and expression defaults parse and only read known params and facts", (t) => {
  const loader = bundledLoader(t);
  let expressions = 0;
  for (const engineId of ENGINES) {
    const catalog = loader.loadCatalog(engineId);
    const knownIds = new Set([...catalog.byId.keys(), ...catalog.notApplicable]);
    for (const param of catalog.params) {
      const asts = [
        ["appliesWhen", param.appliesWhen],
        ...param.rules.map((rule) => [`rules.${rule.code}`, rule.when]),
        ["platformDefault", param.platformDefault?.expr],
      ].filter(([, ast]) => ast !== null && ast !== undefined);
      for (const [where, ast] of asts) {
        const result = expr.validateExpr(ast, { envAllowlist: [], paramIds: knownIds });
        assert.deepEqual(result.errors, [], `${engineId} ${param.id} ${where}`);
        for (const fact of result.refs.facts) assert.ok(catalog.factNames.includes(fact), `${engineId} ${param.id} reads ${fact}`);
        expressions += 1;
      }
      for (const rule of param.rules) assert.ok(paramCatalog.RULE_KINDS.includes(rule.kind));
    }
  }
  assert.ok(expressions >= 10, `only ${expressions} expressions found`);
});

test("the §9.3 seed params are bound exactly on the engines that support them", (t) => {
  const loader = bundledLoader(t);
  const catalogs = Object.fromEntries(ENGINES.map((engineId) => [engineId, loader.loadCatalog(engineId)]));
  for (const [id, engines] of Object.entries(SEED_PARAMS)) {
    for (const engineId of ENGINES) {
      assert.equal(catalogs[engineId].byId.has(id), engines.includes(engineId), `${id} on ${engineId}`);
    }
  }
  for (const [engineId, ids] of Object.entries(RECIPE_ONLY_PARAMS)) {
    for (const id of ids) {
      const param = catalogs[engineId].byId.get(id);
      assert.ok(param, `${engineId} ${id}`);
      assert.equal(param.emit.mode, "adapter", `${engineId} ${id}`);
      if (id !== "chatTemplateKwargs") assert.equal(param.level, "expert", `${engineId} ${id}`);
    }
  }
  assert.equal(catalogs.sglang.byId.get("sglang.enableMetrics").managed, true);
  assert.equal(catalogs.sglang.byId.get("sglang.sleepOnIdle").platformDefault, true);
  assert.equal(catalogs.sglang.byId.get("sglang.chunkedPrefillSize").platformDefault, 8192);
  for (const engineId of ENGINES) {
    const apiKey = catalogs[engineId].byId.get("apiKey");
    assert.equal(apiKey.secret, true, engineId);
    assert.equal(apiKey.type, "string", engineId);
  }
  // The API key reaches vLLM and llama.cpp only through the environment (P0-RT-1).
  assert.deepEqual([catalogs.vllm.byId.get("apiKey").emit.kind, catalogs.vllm.byId.get("apiKey").emit.env], ["env", "VLLM_API_KEY"]);
  assert.deepEqual([catalogs.llamacpp.byId.get("apiKey").emit.kind, catalogs.llamacpp.byId.get("apiKey").emit.env], ["env", "LLAMA_API_KEY"]);
  // gpuMemoryUtilization means a different thing on each engine (01 §9.5).
  assert.deepEqual(ENGINES.map((engineId) => catalogs[engineId].byLegacyField.gpuMemoryUtilization),
    [["vllm.gpuMemoryUtilization"], ["sglang.memFractionStatic"], ["llamacpp.planningUtilization"]]);
  assert.deepEqual(catalogs.llamacpp.byLegacyField.kvCacheDtype, ["llamacpp.cacheTypeK", "llamacpp.cacheTypeV"]);
  for (const alias of ["top_p", "top_k", "fitTargetMib", "specDraftModel", "splitMode"]) {
    assert.ok(catalogs.llamacpp.byLegacyField[alias], alias);
  }
  assert.deepEqual(catalogs.llamacpp.legacyIgnored.map((item) => [item.field, item.code]), [["loadFormat", "param_ignored"]]);
});

test("a valid override is merged by id; a broken one is reported and the bundled definition stays", (t) => {
  const loader = overrideLoader(t, {
    "a-common.json": { kind: "common", params: [{ id: "contextLength", label: { en: "Context window" } }] },
    "b-sglang.json": {
      kind: "engine",
      engineId: "sglang",
      params: [
        { id: "sglang.pageSize", range: { min: 1, max: 256, step: 1 } },
        { id: "sglang.maxTotalTokens", range: { min: 10, max: 1 } },
        { id: "apiKey", secret: false },
      ],
    },
    "c-broken.json": "{ not json",
    "d-unknown.json": { kind: "engine", engineId: "nope", params: [] },
  });
  const catalog = loader.loadCatalog("sglang");
  assert.equal(catalog.byId.get("contextLength").label.en, "Context window");
  assert.equal(catalog.byId.get("contextLength").label.zh, "上下文长度（每请求）");
  assert.deepEqual(catalog.byId.get("sglang.pageSize").range, { min: 1, max: 256, step: 1 });
  // The broken range override is dropped whole; the bundled range stays.
  assert.deepEqual(catalog.byId.get("sglang.maxTotalTokens").range, { min: 1, max: 4194304, step: 1 });
  assert.equal(catalog.byId.get("apiKey").secret, true);
  const codes = catalog.errors.map((item) => `${item.source}:${item.code}`);
  assert.ok(codes.includes("override:invalid_value"), codes.join(","));
  assert.ok(codes.includes("override:override_locked_field"), codes.join(","));
  assert.ok(codes.includes("override:invalid_json"), codes.join(","));
  // A file for an engine without a bundled catalog is reported once, in the status.
  assert.ok(loader.status().errors.some((item) => item.source === "override" && item.code === "unknown_engine"));
  assert.equal(loader.status().ok, false);
  // Other engines keep their bundled catalogs and see only the shared problems.
  assert.equal(loader.loadCatalog("vllm").byId.get("contextLength").label.en, "Context window");
  assert.ok(loader.loadCatalog("vllm").errors.every((item) => item.engineId !== "sglang"));
});

test("availability: unverified without introspection, gated by introspected flags and runtime features", (t) => {
  const loader = bundledLoader(t);
  const runtime = { runtimeId: "sglang@0.5.17", compatVersion: "0.5.17", features: {} };
  const plain = loader.loadCatalog("sglang", { runtime });
  const maxTotal = plain.byId.get("sglang.maxTotalTokens");
  assert.equal(maxTotal.availability.state, "unverified");
  assert.equal(maxTotal.availability.flag, "--max-total-tokens");
  assert.ok(maxTotal.availability.reason.zh && maxTotal.availability.reason.en);
  // Not a runtime flag: available.
  assert.equal(plain.byId.get("clientPreset").availability.state, "available");

  const introspected = { capturedAt: "2026-10-14T00:00:00Z", flags: [{ flag: "--max-total-tokens", choices: [] }, { flag: "--kv-cache-dtype", choices: ["auto", "fp8_e5m2", "fp8_e4m3", "bf16"] }] };
  const checked = loader.loadCatalog("sglang", { runtime, introspected });
  assert.equal(checked.byId.get("sglang.maxTotalTokens").availability.state, "available");
  const pageSize = checked.byId.get("sglang.pageSize").availability;
  assert.deepEqual([pageSize.state, pageSize.code, pageSize.flag], ["unavailable", "flag_not_in_runtime", "--page-size"]);
  // Introspected choices replace the static list; platform values stay first.
  assert.deepEqual(checked.byId.get("kvCacheDtype").choices.map((choice) => choice.value), ["auto", "fp8_e5m2", "fp8_e4m3", "bf16"]);
  assert.equal(checked.byId.get("kvCacheDtype").choices[0].label.en, "Auto (same as compute)");

  // A feature the runtime lacks, or a custom image, makes the control unavailable.
  const ple = { ...plain.byId.get("sglang.pleOffloadEmbedding") };
  assert.equal(paramCatalog.paramAvailability(ple, { features: { pleOffload: false } }, null).state, "unavailable");
  assert.equal(paramCatalog.paramAvailability(ple, { custom: true, features: {} }, null).code, "feature_not_in_runtime");
  assert.equal(paramCatalog.paramAvailability(ple, { features: { pleOffload: true } }, null).state, "unverified");
  // Env-delivered params are unverified until introspection shows the variable.
  const vllmKey = loader.loadCatalog("vllm").byId.get("apiKey");
  assert.equal(paramCatalog.paramAvailability(vllmKey, null, null).state, "unverified");
  assert.equal(paramCatalog.paramAvailability(vllmKey, null, { flags: [{ flag: "--api-key", env: "VLLM_API_KEY" }] }).state, "available");
});

test("renamed flags choose by introspection first, then by compatVersion", () => {
  const param = {
    id: "sglang.cudaGraphMaxBs",
    emit: { mode: "catalog", kind: "flag-value" },
    flags: [{ flag: "--cuda-graph-max-bs", until: "0.5.20" }, { flag: "--cuda-graph-max-bs-decode", since: "0.5.21" }],
  };
  assert.deepEqual(paramCatalog.candidateFlags(param, { compatVersion: "0.5.17" }), ["--cuda-graph-max-bs"]);
  assert.deepEqual(paramCatalog.candidateFlags(param, { compatVersion: "0.5.21" }), ["--cuda-graph-max-bs-decode"]);
  assert.equal(paramCatalog.paramAvailability(param, { compatVersion: "0.5.17" }, null).flag, "--cuda-graph-max-bs");
  const renamed = paramCatalog.paramAvailability(param, { compatVersion: "0.5.17" }, { flags: [{ flag: "--cuda-graph-max-bs-decode" }] });
  assert.deepEqual([renamed.state, renamed.flag], ["available", "--cuda-graph-max-bs-decode"]);
});

test("validateValues: v2 errors, legacy warnings, ranges with suggestions, choices and rules", (t) => {
  const loader = bundledLoader(t);
  const vllm = loader.loadCatalog("vllm");
  const llama = loader.loadCatalog("llamacpp");

  const ok = paramCatalog.validateValues({ contextLength: 32768, concurrency: { value: 2, source: "planner" }, kvCacheDtype: "fp8" }, vllm, {});
  assert.deepEqual(ok, { errors: [], warnings: [] });

  const bad = paramCatalog.validateValues({
    contextLength: 0,
    kvCacheDtype: "fp4",
    concurrency: "four",
    nonsense: 1,
    "sglang.maxTotalTokens": 4096,
  }, vllm, {});
  const byField = Object.fromEntries(bad.errors.map((item) => [item.field, item]));
  assert.equal(byField.contextLength.code, "out_of_range");
  assert.ok(byField.contextLength.suggestion && Number.isFinite(byField.contextLength.suggestion.value));
  assert.equal(byField.kvCacheDtype.code, "invalid_choice");
  assert.equal(byField.concurrency.code, "invalid_type");
  assert.equal(byField.nonsense.code, "unknown_param");
  assert.equal(byField["sglang.maxTotalTokens"].code, "param_not_applicable");
  for (const item of bad.errors) assert.match(item.message, / \/ /);

  // A legacy body only gets warnings for what the engine ignores.
  const legacy = paramCatalog.validateValues({ kvCacheDtype: "fp8", "sglang.maxTotalTokens": 4096 }, llama, { legacy: true });
  assert.deepEqual(legacy.errors, []);
  assert.deepEqual(legacy.warnings.map((item) => [item.field, item.code]), [["kvCacheDtype", "param_not_applicable"], ["sglang.maxTotalTokens", "param_not_applicable"]]);

  // Managed params cannot be set.
  const sglang = loader.loadCatalog("sglang");
  assert.deepEqual(paramCatalog.validateValues({ "sglang.enableMetrics": false }, sglang, {}).errors.map((item) => item.code), ["param_managed"]);

  // Rules read params and facts: MTP on a checkpoint without MTP layers warns.
  const mtp = paramCatalog.validateValues({ "speculative.method": "mtp" }, vllm, { facts: { "model.nativeMtp.supported": false } });
  assert.deepEqual(mtp.warnings.map((item) => item.code), ["mtp_not_in_checkpoint"]);
  assert.deepEqual(paramCatalog.validateValues({ "speculative.method": "mtp" }, vllm, { facts: {} }).warnings, []);

  // appliesWhen: a value set where it has no effect is reported, not rejected.
  const inactive = paramCatalog.validateValues({ "speculative.method": "off", "speculative.numTokens": 3 }, vllm, {});
  assert.deepEqual(inactive.errors, []);
  assert.deepEqual(inactive.warnings.map((item) => [item.field, item.code]), [["speculative.numTokens", "param_inactive"]]);
});

test("platform defaults reproduce today's server defaults, including fact-dependent ones", (t) => {
  const loader = bundledLoader(t);
  const vllm = loader.loadCatalog("vllm");
  const gmu = vllm.byId.get("vllm.gpuMemoryUtilization");
  assert.equal(paramCatalog.platformDefaultValue(gmu, vllm, { facts: { "instance.mode": "replace" } }), 0.92);
  assert.equal(paramCatalog.platformDefaultValue(gmu, vllm, { facts: { "instance.mode": "parallel" } }), 0.7);
  assert.equal(paramCatalog.platformDefaultValue(gmu, vllm, { facts: {} }), null);
  const llama = loader.loadCatalog("llamacpp");
  const fitTarget = llama.byId.get("llamacpp.fitTargetMb");
  assert.equal(paramCatalog.platformDefaultValue(fitTarget, llama, { param: (id) => (id === "llamacpp.gpuLayers" ? "auto" : null) }), 1024);
});

test("facts cover every fact a catalog reads, with null for what is unknown", (t) => {
  const loader = bundledLoader(t);
  for (const engineId of ENGINES) {
    const catalog = loader.loadCatalog(engineId);
    const facts = paramCatalog.buildFacts({ host: paramCatalog.hostFactsFromGpus(null, "win32"), factNames: catalog.factNames });
    for (const name of [...expr.FACT_NAMES, ...catalog.factNames]) assert.ok(Object.hasOwn(facts, name), `${engineId}: ${name}`);
    assert.equal(facts["host.platform"], "win32");
    assert.equal(facts["host.anySm12x"], null);
  }
  const sm120 = paramCatalog.hostFactsFromGpus([{ name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition", computeCap: "12.0" }, { name: "NVIDIA GeForce RTX 4090", computeCap: "8.9" }], "linux");
  assert.deepEqual(sm120, { platform: "linux", anySm12x: true, maxComputeCap: 12 });
  assert.deepEqual(paramCatalog.hostFactsFromGpus([{ name: "NVIDIA GeForce RTX 4090", computeCap: "8.9" }], "win32"), { platform: "win32", anySm12x: false, maxComputeCap: 8.9 });
  // A custom image assumes no feature; a manifest runtime that does not list one is unknown.
  const custom = paramCatalog.buildFacts({ runtime: { runtimeId: "sglang@custom", custom: true, features: {} }, factNames: ["runtime.features.pleOffload"] });
  assert.equal(custom["runtime.features.pleOffload"], false);
  const pinned = paramCatalog.buildFacts({ runtime: { runtimeId: "sglang@0.5.17", features: {} }, factNames: ["runtime.features.pleOffload"] });
  assert.equal(pinned["runtime.features.pleOffload"], null);
});
