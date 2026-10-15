"use strict";

// Capabilities v1 -> families v2 (docs/overhaul/02-models.md section 8.5, MOD-6):
// the converter round trip, the generated bundled families.json, shim
// equivalence for every v1 entry and engine, the capability id alias table, and
// a user's own v1 file loading as layer 2. Every directory is a temp directory.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The process-wide knowledge loader (behind the shim) reads this config dir.
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-migration-"));
process.env.AI_REFERENCE_DATA_DIR = CONFIG_DIR;
test.after(() => fs.rmSync(CONFIG_DIR, { recursive: true, force: true }));

const matrix = require("../model-capability-matrix");
const knowledgeModule = require("../model-inspector/knowledge");
const { convertCapabilitiesV1, familyToV1Entry } = require("../model-inspector/migrate-v1");
const { generateFamilies, run: runMigrationScript } = require("../../scripts/migrate-capabilities-v1");

const DATA_DIR = path.join(__dirname, "..", "data");
// MOD-21 retired the bundled v1 matrix; its last version is this fixture.
const V1_FILE = path.join(__dirname, "fixtures", "model-capabilities-v1.json");
const FAMILIES_FILE = path.join(DATA_DIR, "knowledge", "families.json");
const QWEN38_SIGNATURE = "qwen38-xml-effort";
const ENGINES = ["vllm", "sglang", "llama"];
const QUANT_CONTEXTS = [
  { quantMethod: "", model: "" },
  { quantMethod: "modelopt", model: "org/some-model-NVFP4" },
  { quantMethod: "modelopt_fp4", model: "" },
  { quantMethod: "fp8", model: "org/plain" },
  { quantMethod: "awq", model: "" },
];

const v1 = JSON.parse(fs.readFileSync(V1_FILE, "utf8"));
const bundled = JSON.parse(fs.readFileSync(FAMILIES_FILE, "utf8"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freshMatrix() {
  matrix.clearModelCapabilityMatrixCache();
  return matrix.loadModelCapabilityMatrix({ force: true });
}

// The v1 entry as the shim must answer it. Qwen3.8 is the one documented
// rekey: the llama.cpp architectures moved into match.ggufArchitectures and the
// family also claims the qwen3_5 types (guarded by the template signature).
// Muse Glimmer's name pattern accepts the separators of its repository names
// (MOD-21), which the vLLM capability module used to normalise away in code.
function expectedV1(entry) {
  const expected = clone(entry);
  if (entry.id === "qwen3.8") {
    expected.match.ggufArchitectures = entry.llama.ggufArchitectures;
    expected.match.modelTypes = [...entry.match.modelTypes, "qwen3_5", "qwen3_5_moe"];
    delete expected.llama.ggufArchitectures;
  }
  if (entry.id === "muse-glimmer") expected.match.namePatterns = ["muse[-_. ]?glimmer"];
  return expected;
}

// ----- the v1 resolution algorithm, kept here as the reference for resolution equivalence

function legacyResolve(data, subject) {
  const normalize = (value) => String(value || "").trim().toLowerCase();
  const normalizeArch = (value) => normalize(value).replace(/[^a-z0-9_]/g, "");
  const regexes = (list) => (list || []).map((source) => new RegExp(source, "i"));
  const identity = matrix.configIdentity(subject.config || {});
  const gguf = normalize(subject.ggufArchitecture);
  const kindOf = (entry) => {
    const match = entry.match || {};
    if (identity.modelTypes.some((type) => (match.modelTypes || []).map(normalize).includes(type))) return "modelType";
    if (identity.architectures.some((arch) => (match.architectures || []).map(normalizeArch).includes(arch))) return "architecture";
    if (identity.architectures.some((arch) => regexes(match.architecturePatterns).some((pattern) => pattern.test(arch)))) return "architecture";
    if (gguf && (match.ggufArchitectures || []).map(normalize).includes(gguf)) return "gguf";
    const declared = identity.modelTypes.length || identity.architectures.length || gguf;
    if (declared && subject.allowNameFallback === false) return "";
    if (matrix.modelNameCandidates(subject.model).some((name) => regexes(match.namePatterns).some((pattern) => pattern.test(name)))) return "name";
    return "";
  };
  let nameMatch = null;
  for (const entry of data.entries) {
    const kind = kindOf(entry);
    if (!kind) continue;
    if (kind === "name") {
      nameMatch ||= entry;
      continue;
    }
    return { id: entry.id, matchedBy: kind };
  }
  return nameMatch ? { id: nameMatch.id, matchedBy: "name" } : { id: "", matchedBy: "" };
}

// ----- converter

test("convertCapabilitiesV1 and familyToV1Entry round-trip every field of every v1 entry", () => {
  const converted = convertCapabilitiesV1(v1);
  assert.deepEqual(converted.warnings, []);
  assert.equal(converted.families.kind, "families");
  assert.equal(converted.families.schemaVersion, 2);
  assert.equal(converted.families.entries.length, v1.entries.length);
  for (const [index, entry] of v1.entries.entries()) {
    const family = converted.families.entries[index];
    assert.equal(family.id, entry.id);
    const back = familyToV1Entry(family);
    const expected = clone(entry);
    if (entry.id === "qwen3.8") {
      expected.match.ggufArchitectures = entry.llama.ggufArchitectures;
      delete expected.llama.ggufArchitectures;
    }
    assert.deepEqual(back, expected, entry.id);
  }
});

test("v1 fields land where section 8.5 says", () => {
  const { families } = convertCapabilitiesV1(v1);
  const byId = Object.fromEntries(families.entries.map((entry) => [entry.id, entry]));
  const muse = byId["muse-glimmer"];
  assert.equal(muse.engines.vllm.support, "blocked");
  assert.equal(muse.engines.llamacpp.support, "blocked");
  assert.equal(muse.download.level, "block");
  assert.equal(muse.download.bypass, false);
  const q36 = byId["qwen3.5-3.6"];
  assert.deepEqual(q36.engines.vllm.parsers, { reasoning: "qwen3", tool: "qwen3_coder" });
  assert.deepEqual(q36.engines.vllm.parsersByQuant, { "nvfp4|modelopt": { tool: "qwen3_xml" } });
  assert.equal(q36.speculative.auto.vllm, "mtp");
  assert.equal(q36.speculative.auto.llamacpp, "dflash");
  assert.equal(q36.speculative.autoOffForQuant, "nvfp4|modelopt");
  assert.equal(byId["nemotron-3-nano"].engines.vllm.trustRemoteCode, true);
  assert.equal(byId["nemotron-3-nano"].engines.vllm.requiredPluginFile, "nano_v3_reasoning_parser.py");
  assert.deepEqual(byId.qwen3.engines.vllm.parsers, { reasoning: "qwen3", tool: "hermes" });
  // llama.ggufArchitectures moves to match.ggufArchitectures
  assert.deepEqual(byId["qwen3.8"].match.ggufArchitectures, ["qwen3_8", "qwen38"]);
  assert.equal(byId["qwen3.8"].engines.llamacpp.ggufArchitectures, undefined);
  // the legacy requires.runtime manifest key becomes a runtimeId
  assert.match(byId["qwen3.8-flash-next"].requires.runtimeId, /^sglang@/);
  assert.equal(byId["qwen3.8-flash-next"].requires.runtime, undefined);
  assert.equal(byId["qwen3.8-flash-next"].requires.minimumComputeCapability, "12.0");
  // the SGLang image is a recipe concern; the family keeps a legacy pointer for the shim only
  assert.deepEqual(byId["qwen3.8-flash-next"].engines.sglang.legacyImage, { image: "sglangFlashNext", requiresQuant: "nvfp4|modelopt_fp4|fp4" });
});

test("convertCapabilitiesV1 reports instead of guessing: bad input throws, bad entries are skipped with warnings", () => {
  assert.throws(() => convertCapabilitiesV1(null), /entries array/);
  assert.throws(() => convertCapabilitiesV1({ entries: "nope" }), /entries array/);
  const result = convertCapabilitiesV1({
    asOf: "2026-01-02",
    entries: [
      { id: "alpha", label: "Alpha", match: { modelTypes: ["alpha"] }, vllm: { toolCallParser: "hermes" }, surprise: true },
      { id: "alpha", match: { modelTypes: ["again"] } },
      { label: "No id" },
      { id: "bad id!", match: { modelTypes: ["x"] } },
      { id: "beta", match: { namePatterns: ["beta"] }, requires: { runtime: "notInTheManifest" } },
    ],
  }, { runtimeIdForKey: () => null });
  assert.deepEqual(result.families.entries.map((entry) => entry.id), ["alpha", "beta"]);
  assert.deepEqual(result.capabilityIdAliases, { alpha: "alpha", beta: "beta" });
  assert.equal(result.families.asOf, "2026-01-02");
  const codes = result.warnings.map((warning) => warning.code).sort();
  assert.deepEqual(codes, ["duplicate_id", "invalid_entry", "invalid_entry", "runtime_unresolved", "unknown_key"]);
  assert.equal(result.families.entries[1].requires.runtime, "notInTheManifest");
});

// ----- the generated bundled file

test("the bundled families.json is generated from the last v1 matrix and is up to date", () => {
  const { families } = generateFamilies({ v1, existing: bundled });
  assert.deepEqual(families, bundled);
  const out = [];
  const code = runMigrationScript(["--check", "--input", V1_FILE], { log: (line) => out.push(line), error: (line) => out.push(line) });
  assert.equal(code, 0, out.join("\n"));
  assert.equal(runMigrationScript(["--bogus"], { log() {}, error() {} }), 1);
  assert.equal(runMigrationScript(["--check"], { log() {}, error() {} }), 1, "the retired default input is not read");
});

test("--check fails on a stale file and --dry-run writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-migration-script-"));
  try {
    const output = path.join(dir, "families.json");
    const quiet = { log() {}, error() {} };
    assert.equal(runMigrationScript(["--check", "--input", V1_FILE, "--output", output], quiet), 2);
    assert.equal(runMigrationScript(["--dry-run", "--input", V1_FILE, "--output", output], quiet), 0);
    assert.equal(fs.existsSync(output), false);
    assert.equal(runMigrationScript(["--input", V1_FILE, "--output", output], quiet), 0);
    assert.equal(runMigrationScript(["--check", "--input", V1_FILE, "--output", output], quiet), 0);
    const written = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(written.entries.length, 14);
    fs.writeFileSync(output, JSON.stringify({ ...written, asOf: "2020-01-01", entries: [] }));
    assert.equal(runMigrationScript(["--check", "--input", V1_FILE, "--output", output], quiet), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the bundled families load cleanly through the knowledge loader with identity aliases for the 14 v1 ids", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-migration-empty-"));
  try {
    const loader = knowledgeModule.createKnowledgeLoader({ configDir: empty, cacheDir: empty, registry: null, paramIds: null });
    const status = loader.status();
    assert.deepEqual(status.errors, []);
    const knowledge = loader.load();
    assert.equal(knowledge.records.families.length, 14);
    assert.equal(v1.entries.length, 14);
    assert.deepEqual(knowledge.capabilityIdAliases, Object.fromEntries(v1.entries.map((entry) => [entry.id, entry.id])));
    assert.deepEqual(bundled.tensorClasses.map((item) => item.class), knowledge.tensorClasses.map((item) => item.class));
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// ----- shim equivalence

test("shim equivalence: every v1 entry, every engine, every quantization context", () => {
  const shim = freshMatrix();
  assert.equal(shim.entries.length, v1.entries.length);
  for (const entry of v1.entries) {
    const projected = shim.byId.get(entry.id);
    assert.ok(projected, entry.id);
    const expected = expectedV1(entry);
    for (const key of ["id", "label", "confidence", "match", "contextMax", "vllm", "sglang", "llama", "download", "requires", "notes"]) {
      assert.deepEqual(projected[key], expected[key], `${entry.id}.${key}`);
    }
    for (const engine of ENGINES) {
      for (const context of QUANT_CONTEXTS) {
        assert.deepEqual(
          matrix.resolveEngineCapabilities(projected, engine, context),
          matrix.resolveEngineCapabilities(expected, engine, context),
          `${entry.id} ${engine} ${context.quantMethod || "-"}`,
        );
      }
    }
  }
});

test("shim equivalence: resolution by declared identity, GGUF architecture and name matches the v1 algorithm", () => {
  freshMatrix();
  const subjects = [];
  for (const entry of v1.entries) {
    const match = entry.match || {};
    for (const type of match.modelTypes || []) subjects.push({ model: "org/unrelated", config: { model_type: type } });
    for (const arch of match.architectures || []) subjects.push({ model: "org/unrelated", config: { architectures: [arch] } });
    for (const arch of ["Qwen3_5ForConditionalGeneration", "Qwen4ExpForCausalLM", "NemotronHForCausalLM", "MuseGlimmerForCausalLM", "DeepseekV3ForCausalLM", "Gemma4ForConditionalGeneration"]) {
      subjects.push({ model: "org/unrelated", config: { architectures: [arch] } });
    }
    for (const arch of match.ggufArchitectures || []) subjects.push({ ggufArchitecture: arch, allowNameFallback: false });
  }
  const names = [
    "Qwen/Qwen3.8-27B", "Qwen/Qwen3.8-Flash-Next-NVFP4", "Qwen/Qwen3-8B", "Qwen/Qwen3.5-27B", "nvidia/Qwen3.6-35B-A3B-NVFP4",
    "Qwen/Qwen2.5-7B-Instruct", "deepseek-ai/DeepSeek-R1", "deepseek-ai/DeepSeek-R1-Distill-Qwen3-8B", "museglimmer-x", "nvidia/Nemotron-3-Nano-30B",
    "google/gemma-4-31b", "google/diffusiongemma-x", "zai-org/GLM-4.6", "openai/gpt-oss-20b", "meta-llama/Llama-3.1-8B", "mistralai/Mixtral-8x7B",
    "moonshotai/Kimi-K2-Instruct", "/models/Qwen3.8-Flash-Next", "acme/totally-new-arch",
  ];
  for (const model of names) {
    subjects.push({ model });
    subjects.push({ model, config: { model_type: "acme_v1" } });
    subjects.push({ model, config: { model_type: "acme_v1" }, allowNameFallback: false });
  }
  // "Declared type plus conflicting name" cases of the v1 suite.
  subjects.push({ model: "someone/qwen3-flash-next-awq", config: { model_type: "qwen2", architectures: ["Qwen2ForCausalLM"] } });
  // Only the documented rekey differs: GGUF architectures that were listed under llama.* now match the family.
  const rekeyed = new Set(["qwen3_8", "qwen38"]);
  assert.ok(subjects.length > 100);
  for (const subject of subjects) {
    const actual = matrix.resolveModelCapabilityEntry(clone(subject));
    const expected = legacyResolve(v1, subject);
    if (subject.ggufArchitecture && rekeyed.has(subject.ggufArchitecture)) {
      assert.equal(actual.id, "qwen3.8", JSON.stringify(subject));
      assert.equal(actual.matchedBy, "gguf");
      continue;
    }
    assert.deepEqual({ id: actual.id, matchedBy: actual.matchedBy }, expected, JSON.stringify(subject));
  }
});

test("the matrix description keeps the shape /api/capability-data and the UI read", () => {
  matrix.clearModelCapabilityMatrixCache();
  const described = matrix.describeModelCapabilityMatrix({ force: true });
  assert.deepEqual(Object.keys(described).sort(), ["asOf", "entries", "error", "freshness", "nameHeuristicHits", "source", "userPath"]);
  assert.equal(described.source, "bundled");
  assert.equal(described.error, "");
  assert.equal(path.basename(described.userPath), "model-capabilities.json");
  assert.deepEqual(Object.keys(described.freshness).sort(), ["ageDays", "asOf", "notice", "stale", "staleAfterDays"]);
  assert.equal(described.entries.length, 14);
  for (const item of described.entries) {
    assert.deepEqual(Object.keys(item).sort(), ["confidence", "contextMax", "download", "id", "label", "llama", "match", "notes", "sglang", "vllm"]);
    const original = expectedV1(v1.entries.find((entry) => entry.id === item.id));
    if (item.id === "qwen3.8") continue;
    assert.deepEqual(item.match, original.match);
    assert.deepEqual(item.vllm, original.vllm || null);
    assert.deepEqual(item.sglang, original.sglang || null);
    assert.deepEqual(item.llama, original.llama || null);
    assert.deepEqual(item.download, original.download || null);
    assert.equal(item.contextMax, original.contextMax || null);
    assert.deepEqual(item.notes, original.notes || []);
    assert.equal(item.label, original.label);
  }
});

test("the shim exports of the v1 matrix are all still there", () => {
  for (const name of [
    "MODEL_CAPABILITY_MATRIX_FILE", "clearModelCapabilityMatrixCache", "configIdentity", "describeModelCapabilityMatrix", "getCapabilityEntry",
    "getNameHeuristicStats", "loadModelCapabilityMatrix", "matchesCapabilityEntry", "modelNameCandidates", "resolveEngineCapabilities", "resolveModelCapabilityEntry",
  ]) {
    assert.ok(name in matrix, name);
  }
  assert.equal(matrix.MODEL_CAPABILITY_MATRIX_FILE, "model-capabilities.json");
});

test("download precheck still reads download rules and engine flags through the shim", () => {
  const { assessDownloadCompatibility } = require("../download-precheck");
  const runtime = { version: "v0.28.0", bitsAndBytesPlugin: false, cudaVersion: "13.0.2", minimumBlackwellCudaVersion: "12.8" };
  const flashNext = assessDownloadCompatibility({
    engine: "vllm",
    model: "Qwen/Qwen3.8-Flash-Next-NVFP4",
    config: { model_type: "qwen4_exp", quantization_config: { quant_method: "modelopt_fp4" } },
    siblings: [{ name: "config.json", size: 1 }, { name: "model.safetensors", size: 8.5e10 }],
    runtime,
    gpu: { computeCap: "12.0", totalMb: 97887 },
    bytes: 8.5e10,
  });
  assert.equal(flashNext.capability.id, "qwen3.8-flash-next");
  const codes = flashNext.findings.map((item) => item.code);
  assert.ok(codes.includes("matrix_download_rule"));
  assert.ok(codes.includes("trust_remote_code"));
  assert.equal(flashNext.findings.find((item) => item.code === "matrix_download_rule").severity, "info");
  const muse = assessDownloadCompatibility({ engine: "llama", model: "x/muse", ggufArchitecture: "muse-glimmer", config: null, runtime });
  assert.equal(muse.level, "block");
});

// ----- aliases

function collectRecipeCapabilityIds(dir, found = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) {
      collectRecipeCapabilityIds(file, found);
    } else if (item.name.endsWith(".json")) {
      let value;
      try {
        value = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const walk = (node) => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === "object") {
          if (node.match && Array.isArray(node.match.capabilityIds)) found.push(...node.match.capabilityIds);
          Object.values(node).forEach(walk);
        }
      };
      walk(value);
    }
  }
  return found;
}

test("familyIdForCapabilityId covers every v1 id and every capabilityIds value in the bundled recipes", () => {
  knowledgeModule.clearKnowledgeCache();
  for (const entry of v1.entries) {
    assert.equal(knowledgeModule.familyIdForCapabilityId(entry.id), entry.id, entry.id);
    assert.equal(bundled.capabilityIdAliases[entry.id], entry.id);
  }
  const recipeIds = collectRecipeCapabilityIds(DATA_DIR);
  for (const id of recipeIds) {
    assert.notEqual(knowledgeModule.familyIdForCapabilityId(id), null, `recipe capabilityId ${id}`);
  }
  assert.equal(knowledgeModule.familyIdForCapabilityId("no-such-capability"), null);
  assert.equal(knowledgeModule.familyIdForCapabilityId(""), null);
});

test("MOD-21: the bundled v1 matrix is gone; recipes match by familyId and a capabilityIds model still matches through the alias table", () => {
  assert.equal(fs.existsSync(path.join(DATA_DIR, "model-capabilities.json")), false);
  const recipes = require("../engines/recipes");
  recipes.clearRecipeStoreCache();
  const models = recipes.getRecipeStore().list({ kind: "model" });
  assert.ok(models.length > 0);
  for (const recipe of models) assert.equal(recipe.match?.capabilityIds, undefined, recipe.id);
  for (const familyId of new Set(models.map((recipe) => recipe.match?.familyId).filter(Boolean))) {
    assert.ok(bundled.entries.some((entry) => entry.id === familyId), familyId);
    assert.equal(knowledgeModule.familyIdForCapabilityId(familyId), familyId);
  }
  for (const model of [{ familyId: "qwen3.8" }, { capabilityIds: ["qwen3.8"] }, { capabilityId: "qwen3.8" }]) {
    const hit = recipes.matchRecipes({ engineId: "sglang", model }).find((item) => item.recipe.id === "qwen38-sglang");
    assert.equal(hit.eligible, true, JSON.stringify(model));
    assert.ok(hit.reasons.includes("family"), JSON.stringify(model));
  }
});

// ----- Qwen3.8 rekey at the card level

function qwen38Card(extra = {}) {
  return {
    ref: { kind: "local", path: "<MODEL_DIR>/Qwen3.8-27B-FP8" },
    identity: { modelType: "qwen3_5", textModelType: "qwen3_5_text", architectures: ["Qwen3_5ForConditionalGeneration"] },
    template: { signatureId: QWEN38_SIGNATURE },
    ...extra,
  };
}

test("matchFamily: a real Qwen3.8 card (qwen3_5 plus its template signature) is qwen3.8, a signature-less one is qwen3.5-3.6", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-migration-card-"));
  try {
    const loader = knowledgeModule.createKnowledgeLoader({ configDir: empty, cacheDir: empty, registry: null, paramIds: null });
    const hit = loader.matchFamily(qwen38Card());
    assert.equal(hit.entry.id, "qwen3.8");
    assert.ok(hit.matchedBy.includes("templateSignature"), hit.matchedByText);
    assert.ok(!hit.matchedBy.includes("forModelTypes"));
    assert.equal(hit.confidence, "detected");
    assert.equal(hit.knowledgeConfidence, "verified");
    const plain = loader.matchFamily(qwen38Card({ template: { signatureId: null } }));
    assert.equal(plain.entry.id, "qwen3.5-3.6");
    const moe = loader.matchFamily({ identity: { modelType: "qwen3_5_moe", architectures: ["Qwen3_5MoeForConditionalGeneration"] }, template: { signatureId: null } });
    assert.equal(moe.entry.id, "qwen3.5-3.6");
    // The fictional qwen3_8 types and a name-only card need no template proof: forModelTypes limits it to the shared types.
    assert.equal(loader.matchFamily({ identity: { modelType: "qwen3_8", architectures: [] } }).entry.id, "qwen3.8");
    assert.equal(loader.matchFamily({ ref: { kind: "remote", repo: "Qwen/Qwen3.8-27B" } }).entry.id, "qwen3.8");
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// ----- a user's own v1 file is layer 2

test("a user v1 file loads as layer 2, joins the shim and the alias table, and is never rewritten", () => {
  const userV1 = {
    schemaVersion: 1,
    asOf: "2026-08-01",
    staleAfterDays: 400,
    entries: [
      { id: "acme-x", label: "Acme X", confidence: "documented", match: { modelTypes: ["acme_x"], namePatterns: ["acme[-_]?x"] }, vllm: { toolCallParser: "hermes", reasoningParser: "acme" } },
      { id: "mistral", label: "Mistral (owner)", confidence: "verified", match: { modelTypes: ["mistral"] }, vllm: { toolCallParser: "mistral_owner", enableAutoToolChoice: true } },
    ],
  };
  const file = path.join(CONFIG_DIR, "model-capabilities.json");
  const text = JSON.stringify(userV1, null, 2);
  fs.writeFileSync(file, text);
  try {
    // Loader level: layer 2, merged over the bundled layer by id.
    const loader = knowledgeModule.createKnowledgeLoader({ configDir: CONFIG_DIR, cacheDir: CONFIG_DIR, registry: null, paramIds: null });
    const status = loader.status();
    assert.deepEqual(status.errors, []);
    const layer = status.layers.find((item) => item.layer === "legacy-v1");
    assert.equal(layer.files.length, 1);
    assert.equal(layer.files[0].name, "model-capabilities.json");
    assert.equal(layer.files[0].kind, "families");
    assert.equal(layer.files[0].entries, 2);
    const owner = loader.matchFamily({ identity: { modelType: "mistral", architectures: ["MistralForCausalLM"] } });
    assert.equal(owner.entry.id, "mistral");
    assert.equal(owner.layer, "legacy-v1");
    assert.equal(owner.entry.engines.vllm.parsers.tool, "mistral_owner");
    assert.equal(loader.matchFamily({ identity: { modelType: "acme_x" } }).entry.id, "acme-x");
    assert.equal(loader.familyIdForCapabilityId("acme-x"), "acme-x");

    // Shim level: the same file now answers for the managers and the console.
    matrix.clearModelCapabilityMatrixCache();
    const described = matrix.describeModelCapabilityMatrix({ force: true });
    assert.equal(described.source, "user");
    assert.equal(described.asOf, "2026-08-01");
    assert.equal(described.error, "");
    assert.equal(described.entries.length, 15);
    const acme = matrix.resolveModelCapabilityEntry({ model: "org/model", config: { model_type: "acme_x" } });
    assert.equal(acme.id, "acme-x");
    assert.equal(matrix.resolveEngineCapabilities(acme.entry, "vllm", {}).reasoningParser, "acme");
    const mistral = matrix.resolveModelCapabilityEntry({ config: { model_type: "mistral" } });
    assert.equal(mistral.entry.vllm.toolCallParser, "mistral_owner");
    assert.equal(knowledgeModule.familyIdForCapabilityId("acme-x"), "acme-x");
    assert.equal(fs.readFileSync(file, "utf8"), text);
  } finally {
    fs.rmSync(file, { force: true });
    matrix.clearModelCapabilityMatrixCache();
  }
  assert.equal(matrix.describeModelCapabilityMatrix({ force: true }).source, "bundled");
});

test("a broken user v1 file is reported by the shim and the bundled families keep answering", () => {
  const file = path.join(CONFIG_DIR, "model-capabilities.json");
  fs.writeFileSync(file, "{ not json");
  try {
    matrix.clearModelCapabilityMatrixCache();
    const described = matrix.describeModelCapabilityMatrix({ force: true });
    assert.equal(described.source, "bundled");
    assert.notEqual(described.error, "");
    assert.equal(described.entries.length, 14);
    assert.equal(matrix.resolveModelCapabilityEntry({ config: { model_type: "mistral" } }).id, "mistral");
  } finally {
    fs.rmSync(file, { force: true });
    matrix.clearModelCapabilityMatrixCache();
  }
});
