// CON-11 (07 §6.3, 02 §18 R-UI-1, R-UI-2, R-UI-9): the rules behind the model
// card, the evidence chips and the compatibility matrix, run in Node. Drawing
// and interaction are covered in a browser by tests/frontend/console/console-wizard.spec.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);
const evidence = await load("components/evidence-chip.js");
const card = await load("components/model-card.js");
const compat = await load("components/compat-matrix.js");
const model = await load("lib/compat-model.js");

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(CONSOLE_DIR, "i18n", "models", file), "utf8"));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

const CARD = {
  schema: "modelcard/v1",
  cardId: "mc_abcdefghijklmnopqrst",
  role: { value: "main", runnable: true },
  identity: { displayName: "Example-7B", modelType: "example", architectures: ["ExampleForCausalLM"], familyId: "example", familyLabel: { zh: "示例", en: "Example" } },
  format: { kind: "safetensors" },
  weights: { totalBytes: 15 * 1024 ** 3 },
  topology: { paramsTotal: 7.6e9, layers: 28 },
  context: { native: 131072 },
  quant: { method: "none" },
  modalities: { input: ["text", "image"] },
  template: { toolFormat: "hermes-json", reasoningFormat: "none" },
  customCode: { autoMap: null, files: [], trustRemoteCodeRequired: false },
  evidence: [
    { fact: "/identity/modelType", confidence: "declared", source: { kind: "file", ref: "config.json#/model_type" } },
    { fact: "/identity/modelType", confidence: "name-heuristic", source: { kind: "name", ref: "folder" } },
    { fact: "/identity/architectures", confidence: "detected", source: { kind: "tensor-table", ref: "model.safetensors.index.json" } },
    { fact: "/identity/familyId", confidence: "name-heuristic" },
    { fact: "/weights/totalBytes", confidence: "verified-on-host" },
    { fact: "/weights/totalBytes", confidence: "declared" },
    { fact: "/topology/layers", confidence: "declared" },
  ],
};

test("the four confidences rank verified-on-host > declared > detected > name-heuristic; no evidence is unknown", () => {
  assert.deepEqual([...evidence.CONFIDENCES].sort(), ["declared", "detected", "name-heuristic", "verified-on-host"]);
  assert.equal(evidence.confidenceOf(CARD, "/identity/modelType"), "declared", "declared beats a name guess");
  assert.equal(evidence.confidenceOf(CARD, "/weights/totalBytes"), "verified-on-host");
  assert.equal(evidence.confidenceOf(CARD, "/identity/architectures"), "detected");
  assert.equal(evidence.confidenceOf(CARD, "/identity/familyId"), "name-heuristic");
  assert.equal(evidence.confidenceOf(CARD, "/context/native"), "unknown");
  assert.equal(evidence.confidenceOf(null, "/x"), "unknown");
  assert.equal(evidence.confidenceOf({ evidence: [{ fact: "/a/b", confidence: "weird" }] }, "/a/b"), "unknown", "an unrecognised confidence is not trusted");
  assert.equal(evidence.confidenceOf({ evidence: [{ fact: "/topology/layers", confidence: "declared" }] }, "/topology"), "declared", "evidence for a part covers the whole");
  assert.equal(evidence.confidenceOf({ evidence: [{ fact: "/topology2", confidence: "declared" }] }, "/topology"), "unknown", "a pointer prefix is not a substring match");
  assert.equal(evidence.evidenceTitle(evidence.evidenceFor(CARD, "/identity/modelType")), "config.json#/model_type");
  assert.equal(evidence.evidenceTitle(null), "");
});

test("every fact row has one of the four confidences or unknown (R-UI-1)", () => {
  const rows = card.cardFacts(CARD, {
    fmt: { bytes: (n) => `${n} B`, tokens: (n) => String(n) },
    pick: (text) => text?.en || "",
    t: (key) => key,
  });
  assert.ok(rows.length >= 8);
  for (const row of rows) {
    assert.ok([...evidence.CONFIDENCES, "unknown"].includes(row.confidence), `${row.id}: ${row.confidence}`);
    assert.ok(row.value, `${row.id} has a value`);
  }
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.family.confidence, "name-heuristic");
  assert.equal(byId.family.value, "Example");
  assert.equal(byId.modelType.confidence, "declared");
  assert.equal(byId.size.confidence, "verified-on-host");
  assert.equal(byId.context.confidence, "unknown", "a fact nothing vouches for is unknown, not blank");
  assert.equal(byId.format.value, "safetensors");
  assert.equal(byId.params.value, "7.6B");
  assert.equal(byId.quant, undefined, "quant none is not shown");
  assert.equal(byId.reasoningFormat, undefined, "template none is not shown");
  assert.equal(byId.customCode, undefined);
  assert.equal(card.cardFacts(null).length, 0);
});

test("remote code consent lists the auto_map files (R-UI-9)", () => {
  assert.equal(card.needsRemoteCode(CARD), false);
  const dspark = { customCode: { autoMap: { AutoModel: "dspark.DSparkDraftModel" }, files: ["dspark.py", "dflash.py"], trustRemoteCodeRequired: true } };
  assert.deepEqual(card.remoteCodeFiles(dspark), ["dspark.py", "dflash.py"]);
  assert.equal(card.needsRemoteCode(dspark), true);
  const mapped = { customCode: { autoMap: { AutoModel: "modeling_x.XModel", AutoConfig: ["configuration_x.XConfig", "configuration_x.XConfigFast"], Tok: "org/repo--tok.Tok" }, files: [] } };
  assert.deepEqual(card.remoteCodeFiles(mapped), ["modeling_x.py", "configuration_x.py", "tok.py"]);
  assert.equal(card.needsRemoteCode(mapped), true, "auto_map entries alone need consent");
  assert.equal(card.needsRemoteCode({ customCode: { trustRemoteCodeRequired: true } }), true);
  assert.deepEqual(card.remoteCodeFiles({}), []);
  const facts = card.cardFacts(dspark, { t: (key) => key });
  assert.equal(facts.find((row) => row.id === "customCode").value, "dspark.py, dflash.py");
});

test("only main, embedding and reranker models can be the deployed model", () => {
  for (const role of ["main", "embedding", "reranker"]) assert.equal(card.isServableRole(role), true, role);
  for (const role of ["draft", "mtp-head", "mmproj", "adapter", "tooling-only", "", undefined]) assert.equal(card.isServableRole(role), false, String(role));
});

// ---- the compatibility matrix ------------------------------------------------------------

const ENGINES = {
  engines: [
    { engineId: "vllm", managerId: "vllm", label: { zh: "vLLM", en: "vLLM" }, status: "stable", tier: 1, runtimes: [{ runtimeId: "vllm@0.28.0", default: true, present: true, version: "v0.28.0" }] },
    { engineId: "sglang", managerId: "vllm", label: { zh: "SGLang", en: "SGLang" }, status: "stable", tier: 1, runtimes: [{ runtimeId: "sglang@0.5.17", default: true, present: false }] },
    { engineId: "llamacpp", managerId: "llama", label: { zh: "llama.cpp", en: "llama.cpp" }, status: "stable", tier: 1, runtimes: [{ runtimeId: "llamacpp@b10630", default: true, present: true }] },
    { engineId: "lmdeploy", managerId: "vllm", label: { zh: "LMDeploy", en: "LMDeploy" }, status: "experimental", tier: 2, runtimes: [{ runtimeId: "lmdeploy@0.9", default: true, present: true }] },
  ],
};
const ROWS = [
  { engineId: "llamacpp", runtimeId: "llamacpp@b10630", verdict: "block", supportEvidence: [], reasons: [{ code: "format_not_supported", level: "block", message: { zh: "不支持", en: "Not supported" } }], actions: [] },
  { engineId: "sglang", runtimeId: "sglang@0.5.17", verdict: "unknown", supportEvidence: [], reasons: [{ code: "arch_not_in_knowledge", level: "unknown" }], actions: [{ kind: "probe" }, { kind: "override" }] },
  { engineId: "vllm", runtimeId: "vllm@0.28.0", verdict: "ok", supportEvidence: [{ kind: "knowledge", ref: "families/x", confidence: "declared" }], reasons: [], actions: [], fitPreview: { status: "ok" } },
  { engineId: "lmdeploy", runtimeId: "lmdeploy@0.9", verdict: "ok", supportEvidence: [{ kind: "probe", ref: "p", confidence: "detected" }], reasons: [], actions: [], fitPreview: { status: "ok" } },
  { engineId: "external", runtimeId: "external", verdict: "unknown", supportEvidence: [], reasons: [], actions: [] },
];

test("a row is never green without supportEvidence (R-UI-2)", () => {
  assert.equal(model.displayVerdict({ verdict: "ok", supportEvidence: [] }), "unknown");
  assert.equal(model.displayVerdict({ verdict: "ok" }), "unknown");
  assert.equal(model.displayVerdict({ verdict: "ok", supportEvidence: [{ kind: "probe" }] }), "ok");
  assert.equal(model.displayVerdict({ verdict: "warn", supportEvidence: [] }), "warn");
  assert.equal(model.displayVerdict({ verdict: "block" }), "block");
  assert.equal(model.displayVerdict({ verdict: "great" }), "unknown");
  assert.equal(model.displayVerdict(null), "unknown");
  // Property: whatever the server sends, an ok view has evidence and an ok-without-evidence row is selectable only as unknown.
  const verdicts = ["ok", "warn", "block", "unknown", "bogus", undefined];
  const evidences = [undefined, [], [{ kind: "probe" }]];
  const rows = [];
  for (const verdict of verdicts) for (const supportEvidence of evidences) rows.push({ engineId: "vllm", runtimeId: `r-${rows.length}`, verdict, supportEvidence });
  for (const view of model.viewRows(rows, ENGINES)) {
    if (view.verdict === "ok") assert.ok(view.evidence.length > 0, `${view.runtimeId} is ok without evidence`);
    if (view.verdict === "unknown") assert.equal(view.selectable, false, "an unknown row is chosen only through Override");
  }
});

test("viewRows: best verdict first, blocked disabled, unknown offers probe and override, external left out", () => {
  const views = compat.viewRows(ROWS, ENGINES);
  assert.deepEqual(views.map((view) => view.engineId), ["vllm", "lmdeploy", "sglang", "llamacpp"]);
  const byEngine = Object.fromEntries(views.map((view) => [view.engineId, view]));
  assert.equal(byEngine.vllm.selectable, true);
  assert.equal(byEngine.vllm.managerId, "vllm");
  assert.equal(byEngine.llamacpp.verdict, "block");
  assert.equal(byEngine.llamacpp.selectable, false);
  assert.equal(byEngine.sglang.verdict, "unknown");
  assert.equal(byEngine.sglang.canOverride, true);
  assert.equal(byEngine.sglang.runtime.present, false);
  assert.equal(byEngine.lmdeploy.experimental, true);
  assert.equal(byEngine.vllm.experimental, false);
  assert.equal(compat.viewRows(ROWS, null).every((view) => view.selectable === false), true, "without the engine list no row can be chosen");
  assert.deepEqual(compat.viewRows(null, ENGINES), []);
});

test("recommendedKey picks the runnable, best-fitting, stable, default row and never an unknown or blocked one", () => {
  const views = compat.viewRows(ROWS, ENGINES);
  assert.equal(compat.recommendedKey(views), "vllm::vllm@0.28.0", "stable beats experimental at equal fit");
  assert.equal(compat.recommendedKey(compat.viewRows([ROWS[0], ROWS[1]], ENGINES)), null);
  const spill = compat.viewRows([
    { ...ROWS[2], fitPreview: { status: "warn" } },
    { engineId: "lmdeploy", runtimeId: "lmdeploy@0.9", verdict: "ok", supportEvidence: [{ kind: "probe" }], fitPreview: { status: "ok" } },
  ], ENGINES);
  assert.equal(compat.recommendedKey(spill), "lmdeploy::lmdeploy@0.9", "a better fit outranks stability");
  assert.deepEqual(compat.whyReasons(views[0]), ["verdict.ok", "evidence", "fit.ok", "stable", "defaultRuntime"]);
  assert.deepEqual(compat.whyReasons(null), []);
});

test("fitBadgeFor reads one GPU's rows: ok, warn, fail or unknown", () => {
  assert.equal(compat.fitBadgeFor([{ fitPreview: { status: "fail" } }, { fitPreview: { status: "ok" } }]), "ok");
  assert.equal(compat.fitBadgeFor([{ fitPreview: { status: "fail" } }, { fitPreview: { status: "warn" } }]), "warn");
  assert.equal(compat.fitBadgeFor([{ fitPreview: { status: "fail" } }]), "fail");
  assert.equal(compat.fitBadgeFor([{ fitPreview: null }, {}]), "unknown");
  assert.equal(compat.fitBadgeFor(undefined), "unknown");
});

test("engineIndex reads GET /api/engines, an array or nothing", () => {
  const index = model.engineIndex(ENGINES);
  assert.equal(index.get("sglang").managerId, "vllm");
  assert.equal(index.get("vllm").runtimes.get("vllm@0.28.0").version, "v0.28.0");
  assert.equal(model.engineIndex(ENGINES.engines).size, 4);
  assert.equal(model.engineIndex(null).size, 0);
  assert.equal(model.isExperimental(index.get("lmdeploy")), true);
  assert.equal(model.isExperimental(index.get("vllm")), false);
  assert.equal(model.isExperimental(null), false);
});

// ---- copy ----------------------------------------------------------------------------------

test("the models area carries the 02 §18 copy verbatim and both locales line up", () => {
  const zh = readJson("zh-CN.json");
  const en = readJson("en-US.json");
  assert.equal(zh["models.compat.unknownArch"], "未知（未验证）", "must-keep, 00 §9.13");
  assert.equal(en["models.compat.unknownArch"], "Unknown (unverified)");
  assert.equal(zh["models.confidence.name-heuristic"], "按名称推测");
  assert.equal(en["models.confidence.name-heuristic"], "Guessed from the name");
  assert.equal(en["models.remoteCode.confirm"], "This model runs its own Python code: {files}. Continue only if you trust the publisher.");
  for (const role of ["main", "draft", "mtp-head", "mmproj", "adapter", "embedding", "reranker", "tooling-only"]) {
    assert.ok(zh[`models.role.${role}`] && en[`models.role.${role}`], role);
  }
  for (const verdict of ["ok", "warn", "block", "unknown", "unknownHint"]) assert.ok(zh[`models.verdict.${verdict}`] && en[`models.verdict.${verdict}`], verdict);
  assert.equal(Object.keys(zh).length, Object.keys(en).length);
});

test("every models.* key the wizard files use exists in zh and en, and no label is a raw flag", () => {
  const zh = readJson("zh-CN.json");
  const en = readJson("en-US.json");
  const files = [
    "components/evidence-chip.js", "components/model-card.js", "components/compat-matrix.js", "lib/compat-model.js",
    ...fs.readdirSync(path.join(CONSOLE_DIR, "routes", "deploy-wizard")).map((name) => `routes/deploy-wizard/${name}`),
  ];
  const missing = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(CONSOLE_DIR, file), "utf8");
    for (const match of source.matchAll(/(?<![\w$])t\(\s*"(models\.[^"]+)"/g)) {
      if (!(match[1] in zh) || !(match[1] in en)) missing.push(`${file}: ${match[1]}`);
    }
    for (const match of source.matchAll(/(["'`])(--[a-z][a-z-]+)\1/g)) assert.fail(`${file} writes the raw flag ${match[2]}`);
  }
  assert.deepEqual(missing, []);
  // The dynamic families are complete for every id the pure code can produce.
  for (const id of ["declared", "detected", "name-heuristic", "verified-on-host", "unknown"]) assert.ok(`models.confidence.${id}` in en, id);
  for (const id of ["family", "modelType", "architectures", "format", "size", "params", "layers", "context", "quant", "modalities", "toolFormat", "reasoningFormat", "customCode"]) assert.ok(`models.card.fact.${id}` in en, id);
  for (const id of ["verdict.ok", "verdict.warn", "evidence", "fit.ok", "fit.warn", "stable", "defaultRuntime"]) assert.ok(`models.wizard.engine.why.${id}` in en, id);
  for (const id of ["ok", "warn", "fail", "unknown", "loading"]) assert.ok(`models.wizard.model.fit.${id}` in en, id);
  for (const id of ["model", "engine", "resources", "capabilities", "access", "review", "launch"]) assert.ok(`models.wizard.step.${id}` in en, id);
  for (const kind of ["verified-on-host", "probe", "knowledge"]) assert.ok(`models.compat.evidence.${kind}` in en, kind);
});

test("the wizard files follow the console rules: testid hooks, no inline style, the models folder is tracked", () => {
  for (const file of ["components/evidence-chip.js", "components/model-card.js", "components/compat-matrix.js"]) {
    const source = fs.readFileSync(path.join(CONSOLE_DIR, file), "utf8");
    assert.match(source, /testid/, `${file} carries testid hooks`);
    assert.equal(/\sstyle="/.test(source), false, `${file}: no style attribute`);
  }
  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /^!service-entry\/console\/i18n\/models\/$/m, "the models/ ignore rule must not hide the console's models catalogs");
});
