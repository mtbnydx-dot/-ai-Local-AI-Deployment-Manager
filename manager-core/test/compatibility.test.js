"use strict";

// Compatibility matrix (docs/overhaul/02-models.md section 9, 21.2, MOD-11):
// rows per (engine, runtime) for a ModelCard, the rules R1-R13, the support
// evidence that `ok` needs, and the legacy lookup llama-manager uses for P0-15.
// Cards are synthetic or expanded from the library fixtures; descriptors,
// runtimes and runtime facts are injected, so no Docker, engine or live data is
// touched.

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The process-wide registry and knowledge loaders read bundled data only.
const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "compat-reference-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_DIR;
test.after(() => fs.rmSync(EMPTY_DIR, { recursive: true, force: true }));

const models = require("../model-inspector");
const knowledgeModule = require("../model-inspector/knowledge");
const { resetInspector } = require("../model-inspector/inspect");
const { listFixtures, materializeFixture } = require("./helpers/fixture-materialize");

const { evaluateCompatibility, ggufArchitectureSupport } = models.compatibility;
const DIGEST = `sha256:${"a".repeat(64)}`;
const GIB = 1024 ** 3;

const DESCRIPTORS = [
  { id: "vllm", artifactFormats: ["safetensors", "fp8", "nvfp4", "awq", "gptq", "gguf"], capabilities: { roles: ["chat", "embedding", "rerank"], autoParsers: { tool: null, reasoning: null } } },
  { id: "sglang", artifactFormats: ["safetensors", "fp8", "nvfp4", "awq", "gptq"], capabilities: { roles: ["chat", "embedding"], autoParsers: { tool: null, reasoning: null } } },
  { id: "llamacpp", artifactFormats: ["gguf"], capabilities: { roles: ["chat", "embedding", "rerank"], autoParsers: { tool: "auto", reasoning: "auto" } } },
  { id: "external", artifactFormats: [], capabilities: { roles: ["chat"], autoParsers: { tool: null, reasoning: null } } },
];

function runtime(engineId, version, release = {}, extra = {}) {
  return { engineId, runtimeId: `${engineId}@${version}`, version, status: "pinned", release, ...extra };
}

const RUNTIMES = [
  runtime("vllm", "0.28.0", { transformersVersion: "5.15.1", minimumComputeCapability: "7.5" }),
  runtime("sglang", "0.5.17"),
  runtime("llamacpp", "b10630", { build: 10630 }),
];

function synth(extra = {}) {
  return {
    schema: "modelcard/v1",
    cardId: "mc_synthetic",
    contentDigest: DIGEST,
    ref: { kind: "hf", repo: "org/model" },
    format: { kind: "safetensors", weightFiles: 2 },
    role: { value: "main", runnable: true },
    identity: { modelType: "qwen3", textModelType: null, architectures: ["Qwen3ForCausalLM"], ggufArchitecture: null, transformersVersion: "4.51.0", displayName: "model" },
    quant: { method: "none", algo: null },
    customCode: { autoMap: null, files: [], trustRemoteCodeRequired: false },
    context: { native: 32768 },
    ...extra,
  };
}

function ggufCard(architecture, extra = {}) {
  return synth({
    format: { kind: "gguf", weightFiles: 1 },
    identity: { modelType: null, textModelType: null, architectures: [], ggufArchitecture: architecture, transformersVersion: null, displayName: "model" },
    quant: { method: "gguf", algo: "Q4_K_M" },
    ...extra,
  });
}

function rowsFor(card, options = {}) {
  return evaluateCompatibility(card, { descriptors: DESCRIPTORS, runtimes: RUNTIMES, env: {}, host: { platform: "linux" }, ...options });
}

function rowOf(rows, engineId, runtimeId = null) {
  const found = rows.find((row) => row.engineId === engineId && (!runtimeId || row.runtimeId === runtimeId));
  assert.ok(found, `row ${engineId} ${runtimeId || ""}`);
  return found;
}

function codes(row) {
  return row.reasons.map((reason) => reason.code);
}

function reasonOf(row, code) {
  return row.reasons.find((reason) => reason.code === code);
}

function facts(registries) {
  return { schemaVersion: 1, flags: null, registries };
}

function gpu(id, computeCap, totalMb = 97887) {
  return { id: String(id), name: `GPU ${id}`, totalMb, freeMb: totalMb - 600, usedMb: 600, computeCap };
}

// ----- shape and the unknown rule

test("an unlisted GGUF architecture is unknown with the probe and override actions, never ok", () => {
  const rows = rowsFor(ggufCard("deepseek4"));
  const llama = rowOf(rows, "llamacpp");
  assert.equal(llama.verdict, "unknown");
  assert.deepEqual(llama.supportEvidence, []);
  assert.ok(codes(llama).includes("arch_not_in_knowledge"));
  assert.equal(reasonOf(llama, "arch_not_in_knowledge").evidence, "/identity/ggufArchitecture");
  assert.deepEqual(llama.actions.map((action) => action.kind), ["probe", "override"]);
  for (const action of llama.actions) assert.ok(action.label.zh && action.label.en);
  for (const reason of llama.reasons) assert.ok(reason.message.zh && reason.message.en, reason.code);
  assert.notEqual(rowOf(rows, "vllm").verdict, "ok");
  // SGLang has no GGUF loader in its descriptor, so the format blocks.
  assert.equal(rowOf(rows, "sglang").verdict, "block");
  assert.ok(codes(rowOf(rows, "sglang")).includes("format_not_supported"));
});

test("rows come per engine runtime, plus one unknown row for external endpoints", () => {
  const rows = rowsFor(synth());
  assert.deepEqual(rows.map((row) => `${row.engineId}:${row.runtimeId}`), [
    "vllm:vllm@0.28.0", "sglang:sglang@0.5.17", "llamacpp:llamacpp@b10630", "external:external",
  ]);
  const external = rowOf(rows, "external");
  assert.equal(external.verdict, "unknown");
  assert.deepEqual(codes(external), ["external_not_inspected"]);
  assert.deepEqual(Object.keys(rowOf(rows, "vllm")).sort(), ["actions", "engineId", "fitPreview", "reasons", "runtimeId", "supportEvidence", "verdict"]);
  assert.deepEqual(evaluateCompatibility(null), []);
});

test("rows default to the engine registry's runtimes and descriptors", () => {
  const rows = evaluateCompatibility(synth(), { env: {}, host: { platform: "linux" } });
  const engines = new Set(rows.map((row) => row.engineId));
  assert.ok(["vllm", "sglang", "llamacpp", "external"].every((id) => engines.has(id)));
  assert.ok(rows.filter((row) => row.engineId === "vllm").length >= 2, "every vLLM runtime has a row");
  assert.ok(rows.some((row) => row.runtimeId === "llamacpp@b10630"));
  // The qwen3 family documents vLLM and llama.cpp support; a safetensors card still cannot run on llama.cpp.
  assert.equal(rowOf(rows, "vllm", "vllm@0.28.0").verdict, "ok");
  assert.equal(rowOf(rows, "llamacpp", "llamacpp@b10630").verdict, "block");
});

test("a documented family matched by declared identity is the only support a bare card needs", () => {
  const vllm = rowOf(rowsFor(synth()), "vllm");
  assert.equal(vllm.verdict, "ok");
  assert.equal(vllm.supportEvidence.length, 1);
  assert.equal(vllm.supportEvidence[0].kind, "knowledge");
  assert.equal(vllm.supportEvidence[0].confidence, "documented");
  assert.match(vllm.supportEvidence[0].ref, /^families\/qwen3#vllm$/);
  assert.deepEqual(vllm.actions, []);
  // SGLang is not in the qwen3 family: declared identity without engine support is unknown.
  const sglang = rowOf(rowsFor(synth()), "sglang");
  assert.equal(sglang.verdict, "unknown");
  assert.ok(codes(sglang).includes("support_unverified"));
});

test("a family matched only by the name is not support evidence", () => {
  const nameOnly = synth({
    ref: { kind: "hf", repo: "someone/Qwen3-8B" },
    identity: { modelType: null, textModelType: null, architectures: [], ggufArchitecture: null, transformersVersion: null, displayName: "Qwen3-8B" },
    format: { kind: "safetensors" },
  });
  assert.equal(knowledgeModule.matchFamily(nameOnly, knowledgeModule.loadKnowledge()).confidence, "name-heuristic");
  for (const row of rowsFor(nameOnly)) {
    assert.notEqual(row.verdict, "ok", `${row.engineId} must not be ok from a name`);
    assert.ok(!row.supportEvidence.some((item) => item.kind === "knowledge"));
  }
  const vllm = rowOf(rowsFor(nameOnly), "vllm");
  assert.ok(codes(vllm).includes("arch_not_in_knowledge"));
});

// ----- the property: no ok without evidence

let cacheDir;
const fixtures = new Map();

test.before(async () => {
  cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "compat-cards-"));
});

test.after(async () => {
  await resetInspector();
  for (const model of fixtures.values()) await model.cleanup();
  await fsp.rm(cacheDir, { recursive: true, force: true });
});

async function fixtureCard(id) {
  if (!fixtures.has(id)) fixtures.set(id, await materializeFixture(id, { sizes: "header" }));
  const model = fixtures.get(id);
  const file = fs.readdirSync(model.dir).find((name) => name.endsWith(".gguf"));
  return models.inspectLocal(file ? path.join(model.dir, file) : model.dir, { cacheDir });
}

function archFacts(card) {
  const names = [...(card.identity.architectures || []), card.identity.ggufArchitecture].filter(Boolean);
  return facts({ architectures: names, quantMethods: ["fp8", "modelopt", "mxfp4", "awq", "gptq", "compressed-tensors", "gguf"], toolParsers: [], reasoningParsers: [], plugins: { gguf: true, bnb: true } });
}

test("property: over all fixtures and synthetic runtimes, ok implies support evidence and never a name-heuristic family", async () => {
  const knowledge = knowledgeModule.loadKnowledge();
  const hosts = [
    { gpus: [], platform: "linux" },
    { gpus: [gpu(0, "12.0")], ramBytes: 256 * GIB, ramFreeBytes: 200 * GIB, platform: "linux" },
    { gpus: [gpu(0, "8.0", 24000), gpu(1, "7.5", 16000)], ramBytes: 32 * GIB, ramFreeBytes: 16 * GIB, platform: "wsl" },
  ];
  let okRows = 0;
  let checked = 0;
  for (const id of listFixtures()) {
    const card = await fixtureCard(id);
    const variants = [
      card,
      // Declared identity removed: only the name is left to match on.
      { ...card, identity: { ...card.identity, modelType: null, textModelType: null, architectures: [], ggufArchitecture: null, displayName: "Qwen3-8B" }, ref: { kind: "hf", repo: "x/Qwen3-8B" } },
    ];
    for (const variant of variants) {
      const match = knowledgeModule.matchFamily(variant, knowledge);
      for (const host of hosts) {
        for (const runtimeFacts of [undefined, { "vllm@0.28.0": archFacts(variant), "sglang@0.5.17": archFacts(variant) }, { "vllm@0.28.0": facts({ architectures: [] }) }]) {
          for (const row of rowsFor(variant, { host, runtimeFacts, knowledge })) {
            checked += 1;
            if (row.verdict === "ok") {
              okRows += 1;
              assert.ok(row.supportEvidence.length > 0, `${id} ${row.runtimeId}: ok without evidence`);
            }
            if (row.supportEvidence.some((item) => item.kind === "knowledge")) {
              assert.notEqual(match.confidence, "name-heuristic", `${id}: a name-heuristic family counted as support`);
            }
            const worstReason = ["block", "warn", "unknown"].find((level) => row.reasons.some((reason) => reason.level === level));
            assert.equal(row.verdict, worstReason || (row.supportEvidence.length ? "ok" : "unknown"), `${id} ${row.runtimeId}: verdict is the worst level`);
            // External endpoints are never inspected and have no probe to offer.
            if (row.verdict === "unknown" && row.engineId !== "external") assert.deepEqual(row.actions.map((action) => action.kind), ["probe", "override"]);
          }
        }
      }
    }
  }
  assert.ok(checked > 500);
  assert.ok(okRows > 0, "the property is not vacuous");
});

test("the DeepSeek-V4 GGUF fixture is unknown on llama.cpp (P0-15's unlisted architecture)", async () => {
  const card = await fixtureCard("deepseek-v4-flash-q2k-gguf");
  assert.equal(card.identity.ggufArchitecture, "deepseek4");
  const rows = rowsFor(card);
  const llama = rowOf(rows, "llamacpp");
  assert.equal(llama.verdict, "unknown");
  assert.ok(rows.every((row) => row.verdict !== "ok"));
  // With a 96 GB GPU the offload warning outranks unknown, but the architecture stays unlisted.
  const sized = rowOf(rowsFor(card, { host: { gpus: [gpu(0, "12.0")], ramBytes: 256 * GIB, ramFreeBytes: 200 * GIB, platform: "linux" } }), "llamacpp");
  assert.equal(sized.verdict, "warn");
  assert.ok(codes(sized).includes("arch_not_in_knowledge"));
});

// ----- R1-R3

test("Muse Glimmer is blocked on every engine, whatever VLLM_ALLOW_MUSE_GLIMMER says", () => {
  const gguf = ggufCard("muse-glimmer");
  const hf = synth({ identity: { modelType: "muse_glimmer", architectures: [], ggufArchitecture: null, transformersVersion: null, displayName: "muse" } });
  for (const env of [{}, { VLLM_ALLOW_MUSE_GLIMMER: "1" }]) {
    assert.equal(reasonOf(rowOf(rowsFor(gguf, { env }), "llamacpp"), "family_blocked").level, "block");
    assert.equal(rowOf(rowsFor(gguf, { env }), "llamacpp").verdict, "block");
    const vllm = rowOf(rowsFor(hf, { env }), "vllm");
    assert.equal(vllm.verdict, "block");
    assert.match(reasonOf(vllm, "family_blocked").message.en, /retired from this local stack/);
    assert.match(reasonOf(rowOf(rowsFor(gguf, { env }), "llamacpp"), "family_blocked").message.zh, /已从本地栈弃用/);
    assert.equal(vllm.supportEvidence.length, 0);
  }
});

test("a safetensors card is blocked on llama.cpp and a GGUF card on SGLang, from the descriptor's artifactFormats", () => {
  const rows = rowsFor(synth());
  assert.equal(rowOf(rows, "llamacpp").verdict, "block");
  assert.equal(reasonOf(rowOf(rows, "llamacpp"), "format_not_supported").evidence, "/format/kind");
  assert.equal(rowOf(rowsFor(ggufCard("qwen3")), "sglang").verdict, "block");
  // A mixed repository loads wherever either format does.
  const mixed = rowsFor(synth({ format: { kind: "mixed" } }));
  assert.ok(!codes(rowOf(mixed, "llamacpp")).includes("format_not_supported"));
  assert.ok(!codes(rowOf(mixed, "vllm")).includes("format_not_supported"));
  // A descriptor that lists no HF-style format refuses safetensors.
  const onlyGguf = [{ ...DESCRIPTORS[0], artifactFormats: ["gguf"] }];
  assert.equal(rowOf(rowsFor(synth(), { descriptors: onlyGguf }), "vllm").verdict, "block");
});

test("GGUF on vLLM is blocked when the image's registries say the gguf plugin is missing", () => {
  const card = ggufCard("qwen3");
  const missing = rowOf(rowsFor(card, { runtimeFacts: { "vllm@0.28.0": facts({ plugins: { gguf: false } }) } }), "vllm");
  assert.equal(missing.verdict, "block");
  assert.ok(codes(missing).includes("gguf_plugin_missing"));
  const present = rowOf(rowsFor(card, { runtimeFacts: { "vllm@0.28.0": facts({ plugins: { gguf: true } }) } }), "vllm");
  assert.ok(!codes(present).includes("gguf_plugin_missing"));
});

test("an embedding card is blocked on an engine whose capabilities.roles lacks embedding", () => {
  const card = synth({ role: { value: "embedding", runnable: true } });
  const chatOnly = DESCRIPTORS.map((descriptor) => (descriptor.id === "vllm" ? { ...descriptor, capabilities: { ...descriptor.capabilities, roles: ["chat"] } } : descriptor));
  const blocked = rowOf(rowsFor(card, { descriptors: chatOnly }), "vllm");
  assert.equal(blocked.verdict, "block");
  assert.equal(reasonOf(blocked, "role_unsupported").evidence, "/role/value");
  assert.equal(rowOf(rowsFor(card), "vllm").verdict, "ok");
  // Reranker maps to rerank, which SGLang's descriptor does not list.
  assert.equal(rowOf(rowsFor(synth({ role: { value: "reranker", runnable: true } })), "sglang").verdict, "block");
});

test("draft, mmproj, adapter, mtp-head and tooling-only cards are never standalone-servable", () => {
  for (const value of ["draft", "mtp-head", "mmproj", "adapter", "tooling-only"]) {
    for (const row of rowsFor(synth({ role: { value, runnable: false } })).filter((item) => item.engineId !== "external")) {
      assert.equal(row.verdict, "block", `${value} on ${row.engineId}`);
      assert.ok(codes(row).includes("role_not_servable"));
    }
  }
  assert.ok(codes(rowOf(rowsFor(synth({ role: { value: "main", runnable: false } })), "vllm")).includes("role_not_servable"));
});

// ----- R2: policy blocks as data

test("DiffusionGemma is blocked on vLLM under WSL and a Windows host, with the env bypass, not on Linux or other Gemma", () => {
  const diffusion = synth({
    identity: { modelType: "diffusiongemma", architectures: ["DiffusionGemmaForBlockDiffusion"], ggufArchitecture: null, transformersVersion: null, displayName: "dg" },
  });
  const wsl = rowOf(rowsFor(diffusion, { host: { platform: "wsl" } }), "vllm");
  assert.equal(wsl.verdict, "block");
  assert.equal(reasonOf(wsl, "diffusion_gemma_windows").level, "block");
  assert.match(reasonOf(wsl, "diffusion_gemma_windows").message.zh, /VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA/);
  assert.equal(rowOf(rowsFor(diffusion, { host: { platform: "win32" } }), "vllm").verdict, "block");
  for (const value of ["1", "true", "yes", "on"]) {
    const bypassed = rowOf(rowsFor(diffusion, { host: { platform: "wsl" }, env: { VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA: value } }), "vllm");
    assert.ok(!codes(bypassed).includes("diffusion_gemma_windows"), value);
  }
  assert.ok(codes(rowOf(rowsFor(diffusion, { host: { platform: "wsl" }, env: { VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA: "0" } }), "vllm")).includes("diffusion_gemma_windows"));
  assert.ok(!codes(rowOf(rowsFor(diffusion, { host: { platform: "linux" } }), "vllm")).includes("diffusion_gemma_windows"));
  const gemma = synth({ identity: { modelType: "gemma4", architectures: ["Gemma4ForConditionalGeneration"], ggufArchitecture: null, transformersVersion: null, displayName: "g" } });
  assert.ok(!codes(rowOf(rowsFor(gemma, { host: { platform: "wsl" } }), "vllm")).includes("diffusion_gemma_windows"));
  // The block names vllm only.
  assert.ok(!codes(rowOf(rowsFor(diffusion, { host: { platform: "wsl" } }), "sglang")).includes("diffusion_gemma_windows"));
});

test("policy blocks and a minimum build come from the knowledge layers", () => {
  const knowledge = knowledgeModule.loadKnowledge();
  const synthetic = {
    ...knowledge,
    records: {
      ...knowledge.records,
      families: [
        {
          ...knowledge.records.families[0],
          id: "synthetic-family",
          entry: {
            id: "synthetic-family",
            label: { zh: "合成家族", en: "Synthetic family" },
            confidence: "verified",
            priority: 99,
            match: { ggufArchitectures: ["synth-arch"], modelTypes: ["synth_type"] },
            engines: { llamacpp: { support: "verified", minimumBuild: 20000 }, vllm: { support: "verified", minimumVersion: "0.30.0" } },
          },
        },
        ...knowledge.records.families,
      ],
    },
  };
  const card = ggufCard("synth-arch");
  const old = rowOf(rowsFor(card, { knowledge: synthetic }), "llamacpp");
  assert.equal(old.verdict, "block");
  assert.ok(codes(old).includes("runtime_below_minimum"));
  assert.equal(old.supportEvidence.length, 0);
  const newer = rowOf(rowsFor(card, { knowledge: synthetic, runtimes: [runtime("llamacpp", "b20001", { build: 20001 })] }), "llamacpp");
  assert.equal(newer.verdict, "ok");
  assert.equal(newer.supportEvidence[0].kind, "knowledge");
  const unknownBuild = rowOf(rowsFor(card, { knowledge: synthetic, runtimes: [runtime("llamacpp", "custom", {})] }), "llamacpp");
  assert.equal(unknownBuild.verdict, "unknown");
  assert.ok(codes(unknownBuild).includes("runtime_version_unverified"));
  const hf = synth({ identity: { modelType: "synth_type", architectures: [], ggufArchitecture: null, transformersVersion: null, displayName: "s" } });
  assert.equal(rowOf(rowsFor(hf, { knowledge: synthetic }), "vllm").verdict, "block");
  assert.equal(rowOf(rowsFor(hf, { knowledge: synthetic, runtimes: [runtime("vllm", "0.30.1")] }), "vllm").verdict, "ok");
  assert.equal(rowOf(rowsFor(hf, { knowledge: synthetic, runtimes: [runtime("vllm", "nightly-abc")] }), "vllm").verdict, "unknown");
});

// ----- R4: every selected GPU

test("compute capability is checked on every selected GPU, family and runtime floors alike", () => {
  const flashNext = synth({ identity: { modelType: "qwen4_exp", architectures: [], ggufArchitecture: null, transformersVersion: null, displayName: "fn" } });
  const both = rowOf(rowsFor(flashNext, { host: { gpus: [gpu(0, "12.0"), gpu(1, "12.0")], platform: "linux" } }), "vllm");
  assert.ok(!codes(both).includes("compute_capability"));
  const mixed = rowOf(rowsFor(flashNext, { host: { gpus: [gpu(0, "12.0"), gpu(1, "8.9")], platform: "linux" } }), "vllm");
  assert.equal(mixed.verdict, "block");
  assert.match(reasonOf(mixed, "compute_capability").message.en, /GPU 1 \(SM 8\.9\)/);
  const old = rowOf(rowsFor(synth(), { host: { gpus: [gpu(0, "6.1")], platform: "linux" } }), "vllm");
  assert.equal(reasonOf(old, "compute_capability_runtime").level, "block");
  const cuda = rowOf(rowsFor(synth(), {
    host: { gpus: [gpu(0, "12.0")], platform: "linux" },
    runtimes: [runtime("vllm", "0.28.0", { cudaVersion: "12.4", minimumBlackwellCudaVersion: "12.8" })],
  }), "vllm");
  assert.equal(reasonOf(cuda, "blackwell_cuda").level, "block");
});

// ----- R5-R7

test("quantization methods are checked against the image's registries, unknown without them", () => {
  const nvfp4 = synth({ quant: { method: "modelopt", algo: "NVFP4" } });
  const awq = synth({ quant: { method: "awq", algo: null } });
  const mxfp4 = synth({ quant: { method: "mxfp4", algo: "MXFP4" } });
  const withFacts = (quantMethods) => ({ runtimeFacts: { "vllm@0.28.0": facts({ quantMethods }) } });
  assert.equal(reasonOf(rowOf(rowsFor(awq, withFacts(["fp8"])), "vllm"), "quant_not_in_runtime").level, "block");
  assert.ok(!codes(rowOf(rowsFor(awq, withFacts(["fp8", "awq"])), "vllm")).includes("quant_not_in_runtime"));
  assert.ok(!codes(rowOf(rowsFor(nvfp4, withFacts(["modelopt_fp4"])), "vllm")).includes("quant_not_in_runtime"));
  assert.ok(!codes(rowOf(rowsFor(nvfp4, withFacts(["modelopt"])), "vllm")).includes("quant_not_in_runtime"));
  // Without facts a quantization the descriptor lists is fine, one it does not list is unknown.
  assert.ok(!codes(rowOf(rowsFor(awq), "vllm")).some((code) => code.startsWith("quant_")));
  const unknown = rowOf(rowsFor(mxfp4), "vllm");
  assert.equal(reasonOf(unknown, "quant_unverified").level, "unknown");
  assert.equal(unknown.verdict, "unknown");
});

test("BitsAndBytes is blocked when the registries or the manifest say the plugin is missing", () => {
  const bnb = synth({ quant: { method: "bitsandbytes", algo: null } });
  const blocked = rowOf(rowsFor(bnb, { runtimeFacts: { "vllm@0.28.0": facts({ plugins: { gguf: true, bnb: false } }) } }), "vllm");
  assert.equal(blocked.verdict, "block");
  assert.equal(reasonOf(blocked, "bitsandbytes_plugin_missing").evidence, "/quant/method");
  const present = rowOf(rowsFor(bnb, { runtimeFacts: { "vllm@0.28.0": facts({ plugins: { bnb: true } }) } }), "vllm");
  assert.ok(!codes(present).some((code) => code.startsWith("bitsandbytes")));
  // The manifest flag decides when there are no facts; facts win over it.
  const manifestSays = [runtime("vllm", "0.28.0", { bitsAndBytesPlugin: false })];
  assert.equal(rowOf(rowsFor(bnb, { runtimes: manifestSays }), "vllm").verdict, "block");
  assert.ok(!codes(rowOf(rowsFor(bnb, { runtimes: manifestSays, runtimeFacts: { "vllm@0.28.0": facts({ plugins: { bnb: true } }) } }), "vllm")).includes("bitsandbytes_plugin_missing"));
  const unknown = rowOf(rowsFor(bnb), "vllm");
  assert.equal(reasonOf(unknown, "bitsandbytes").level, "warn");
});

test("NVFP4 below SM 10 and FP8 below SM 8.9 are warnings about the emulated fallback", () => {
  const nvfp4 = synth({ quant: { method: "modelopt", algo: "NVFP4" } });
  const fp8 = synth({ quant: { method: "fp8", algo: "FP8" } });
  const on = (card, computeCap) => rowOf(rowsFor(card, { host: { gpus: [gpu(0, computeCap)], platform: "linux" } }), "vllm");
  assert.equal(reasonOf(on(nvfp4, "8.9"), "nvfp4_emulated").level, "warn");
  assert.match(reasonOf(on(nvfp4, "8.9"), "nvfp4_emulated").message.zh, /慢速回退/);
  assert.equal(on(nvfp4, "8.9").verdict, "warn");
  assert.ok(!codes(on(nvfp4, "12.0")).includes("nvfp4_emulated"));
  assert.equal(reasonOf(on(fp8, "8.0"), "fp8_emulated").level, "warn");
  assert.ok(!codes(on(fp8, "8.9")).includes("fp8_emulated"));
  assert.ok(!codes(on(fp8, "12.0")).includes("nvfp4_emulated"));
  // The lowest of the selected GPUs decides.
  assert.ok(codes(rowOf(rowsFor(nvfp4, { host: { gpus: [gpu(0, "12.0"), gpu(1, "8.9")], platform: "linux" } }), "vllm")).includes("nvfp4_emulated"));
});

// ----- R8-R10, evidence

test("the architecture is checked against the registries: a hit is support evidence, a miss blocks or warns", () => {
  const card = synth({ identity: { modelType: "newarch", architectures: ["NewArchForCausalLM"], ggufArchitecture: null, transformersVersion: "4.51.0", displayName: "n" } });
  const unknown = rowOf(rowsFor(card), "vllm");
  assert.equal(unknown.verdict, "unknown");
  const hit = rowOf(rowsFor(card, { runtimeFacts: { "vllm@0.28.0": facts({ architectures: ["NewArchForCausalLM"] }) } }), "vllm");
  assert.equal(hit.verdict, "ok");
  assert.equal(hit.supportEvidence[0].kind, "probe");
  assert.match(hit.supportEvidence[0].ref, /^registries\/vllm@0\.28\.0#NewArchForCausalLM$/);
  const miss = rowOf(rowsFor(card, { runtimeFacts: { "vllm@0.28.0": facts({ architectures: ["Qwen3ForCausalLM"] }) } }), "vllm");
  assert.equal(miss.verdict, "block");
  assert.equal(reasonOf(miss, "arch_not_in_runtime").evidence, "/identity/architectures");
  const remoteCode = synth({
    identity: card.identity,
    customCode: { autoMap: { AutoModel: "modeling_new.NewModel" }, files: ["modeling_new.py"], trustRemoteCodeRequired: true },
  });
  const warn = rowOf(rowsFor(remoteCode, { runtimeFacts: { "vllm@0.28.0": facts({ architectures: ["Qwen3ForCausalLM"] }) } }), "vllm");
  assert.equal(warn.verdict, "warn");
  assert.equal(reasonOf(warn, "needs_trust_remote_code").evidence, "/customCode/autoMap");
  // A GGUF architecture missing from a non-llama registry is unverifiable, not blocking.
  const gguf = rowOf(rowsFor(ggufCard("newarch"), { runtimeFacts: { "vllm@0.28.0": facts({ architectures: ["Qwen3ForCausalLM"] }) } }), "vllm");
  assert.equal(reasonOf(gguf, "arch_not_in_runtime").level, "unknown");
});

test("a newer Transformers version than the runtime ships warns unless the registry confirms the architecture", () => {
  const newer = synth({ identity: { modelType: "qwen3", architectures: ["Qwen3ForCausalLM"], ggufArchitecture: null, transformersVersion: "5.8.0.dev0", displayName: "q" } });
  const runtimes = [runtime("vllm", "0.28.0", { transformersVersion: "4.57.1" })];
  const row = rowOf(rowsFor(newer, { runtimes }), "vllm");
  assert.equal(reasonOf(row, "transformers_newer").level, "warn");
  assert.equal(row.verdict, "warn");
  const confirmed = rowOf(rowsFor(newer, { runtimes, runtimeFacts: { "vllm@0.28.0": facts({ architectures: ["Qwen3ForCausalLM"], transformersVersion: "4.57.1" }) } }), "vllm");
  assert.ok(!codes(confirmed).includes("transformers_newer"));
  assert.ok(!codes(rowOf(rowsFor(newer, { runtimes: [runtime("vllm", "0.28.0", { transformersVersion: "5.15.1" })] }), "vllm")).includes("transformers_newer"));
});

test("host records and probes are support evidence for the same (contentDigest, runtimeId), and a failed probe blocks", () => {
  const card = synth({ identity: { modelType: "newarch", architectures: ["NewArchForCausalLM"], ggufArchitecture: null, transformersVersion: null, displayName: "n" } });
  const record = { id: "qr_one", contentDigest: DIGEST, engineId: "vllm", runtimeId: "vllm@0.28.0", results: [{ check: "chat", status: "pass" }, { check: "tool-call", status: "fail" }] };
  const verified = rowOf(rowsFor(card, { hostRecords: [record] }), "vllm");
  assert.equal(verified.verdict, "ok");
  assert.deepEqual(verified.supportEvidence.map((item) => [item.kind, item.ref, item.confidence]), [["verified-on-host", "qr_one", "verified-on-host"]]);
  for (const other of [{ ...record, runtimeId: "vllm@0.29.0" }, { ...record, contentDigest: `sha256:${"b".repeat(64)}` }, { ...record, results: [{ check: "chat", status: "fail" }] }]) {
    assert.equal(rowOf(rowsFor(card, { hostRecords: [other] }), "vllm").verdict, "unknown");
  }
  const probe = { contentDigest: DIGEST, runtimeId: "vllm@0.28.0", ok: true, verdict: "supported" };
  const probed = rowOf(rowsFor(card, { probes: [probe] }), "vllm");
  assert.equal(probed.verdict, "ok");
  assert.equal(probed.supportEvidence[0].kind, "probe");
  assert.equal(probed.supportEvidence[0].ref, `${"a".repeat(12)}@vllm@0.28.0`);
  assert.equal(rowOf(rowsFor(card, { probes: [{ ...probe, verdict: "inconclusive", ok: false }] }), "vllm").verdict, "unknown");
  assert.equal(rowOf(rowsFor(card, { probes: [{ ...probe, verdict: "unsupported", ok: false }] }), "vllm").verdict, "block");
  assert.equal(rowOf(rowsFor(card, { probes: [{ ...probe, verdict: "needs-remote-code" }] }), "vllm").verdict, "warn");
  // Functions and Maps work as sources too.
  assert.equal(rowOf(rowsFor(card, { hostRecords: (digest) => (digest === DIGEST ? [record] : []) }), "vllm").verdict, "ok");
  assert.equal(rowOf(rowsFor(card, { probes: new Map([[`${"a".repeat(12)}@vllm@0.28.0`, probe]]) }), "vllm").verdict, "ok");
});

// ----- R11-R13

test("fit preview: a model that fits, one that fits only with offload, and one that does not fit", async () => {
  const qwen = await fixtureCard("qwen38-27b-fp8");
  const gguf = await fixtureCard("deepseek-v4-flash-q2k-gguf");
  const host = (gpus, ramGib = 256) => ({ gpus, ramBytes: ramGib * GIB, ramFreeBytes: ramGib * GIB * 0.8, platform: "linux" });
  const big = rowOf(rowsFor(qwen, { host: host([gpu(0, "12.0", 97887)]) }), "vllm");
  assert.equal(big.fitPreview.minimalFits, true);
  assert.equal(big.fitPreview.needsOffload, false);
  assert.ok(!codes(big).some((code) => ["does_not_fit", "fits_with_offload"].includes(code)));
  const small = rowOf(rowsFor(qwen, { host: host([gpu(0, "12.0", 8000)]) }), "vllm");
  assert.equal(small.fitPreview.minimalFits, false);
  assert.equal(small.verdict, "block");
  assert.equal(reasonOf(small, "does_not_fit").level, "block");
  assert.equal(reasonOf(small, "does_not_fit").evidence, "/weights/totalBytes");
  // The 91 GiB DeepSeek-V4 GGUF fits one 96 GB GPU only with expert layers in RAM.
  const spill = rowOf(rowsFor(gguf, { host: host([gpu(0, "12.0", 97887)]) }), "llamacpp");
  assert.deepEqual([spill.fitPreview.minimalFits, spill.fitPreview.needsOffload], [true, true]);
  assert.equal(reasonOf(spill, "fits_with_offload").level, "warn");
  assert.equal(spill.verdict, "warn");
  const noRam = rowOf(rowsFor(gguf, { host: host([gpu(0, "12.0", 12000)], 8) }), "llamacpp");
  assert.equal(noRam.verdict, "block");
  // No GPUs, no preview.
  assert.equal(rowOf(rowsFor(qwen, { host: { gpus: [], platform: "linux" } }), "vllm").fitPreview, null);
});

test("fit preview considers every selected GPU and the host RAM", async () => {
  const gguf = await fixtureCard("deepseek-v4-flash-q2k-gguf");
  const on = (gpus, ramGib) => rowOf(rowsFor(gguf, { host: { gpus, ramBytes: ramGib * GIB, ramFreeBytes: ramGib * GIB * 0.8, platform: "linux" } }), "llamacpp");
  assert.equal(on([gpu(0, "12.0", 97887)], 512).fitPreview.minimalFits, true);
  // One small GPU among the selected ones is enough to not fit.
  assert.equal(on([gpu(0, "12.0", 97887), gpu(1, "12.0", 8000)], 512).fitPreview.minimalFits, false);
  assert.equal(on([gpu(0, "12.0", 97887), gpu(1, "12.0", 97887)], 512).fitPreview.minimalFits, true);
  // The 91 GiB of weights have to go somewhere: not enough RAM is a no.
  assert.equal(on([gpu(0, "12.0", 97887)], 64).fitPreview.minimalFits, false);
});

test("a requested context beyond the native context is information only", () => {
  const row = rowOf(rowsFor(synth(), { goal: { contextLength: 65536 } }), "vllm");
  assert.equal(reasonOf(row, "context_exceeds_native").level, "info");
  assert.equal(row.verdict, "ok");
  assert.ok(!codes(rowOf(rowsFor(synth(), { goal: { contextLength: 4096 } }), "vllm")).includes("context_exceeds_native"));
});

test("a tool parser missing from the image warns (R13)", async () => {
  const card = await fixtureCard("qwen38-27b-fp8");
  const withTemplate = { ...card, template: { ...card.template, signatureId: "qwen38-xml-effort", toolFormat: "qwen-xml-function" } };
  const missing = rowOf(rowsFor(withTemplate, { runtimeFacts: { "vllm@0.28.0": facts({ toolParsers: ["hermes"], reasoningParsers: ["deepseek_r1"] }) } }), "vllm");
  assert.ok(missing.reasons.some((reason) => reason.code === "parser_not_in_image" && reason.level === "warn"));
  assert.equal(missing.verdict, "warn");
  const listed = rowOf(rowsFor(withTemplate, { runtimeFacts: { "vllm@0.28.0": facts({ toolParsers: ["qwen3_coder", "qwen3_xml", "hermes"], reasoningParsers: ["qwen3"] }) } }), "vllm");
  assert.ok(!codes(listed).includes("parser_not_in_image"));
});

// ----- the llama-manager lookup (P0-15)

test("ggufArchitectureSupport reads families v2 match.ggufArchitectures by declared identity only", () => {
  const qwen = ggufArchitectureSupport("Qwen3");
  assert.equal(qwen.architecture, "qwen3");
  assert.equal(qwen.id, "qwen3");
  assert.equal(qwen.matchedBy, "gguf");
  assert.equal(typeof qwen.label, "string");
  assert.equal(qwen.llamacpp.supported, undefined);
  const muse = ggufArchitectureSupport("muse-glimmer");
  assert.equal(muse.llamacpp.supported, false);
  assert.match(muse.llamacpp.unsupportedReason, /已从本地栈弃用/);
  const unlisted = ggufArchitectureSupport("deepseek4");
  assert.equal(unlisted.family, null);
  assert.equal(unlisted.llamacpp, null);
  // A name that matches a family's name pattern is not an identity.
  assert.equal(ggufArchitectureSupport("qwen3-flash-next").family, null);
  assert.equal(ggufArchitectureSupport("").family, null);
});

test("core.models exposes the compatibility namespace", () => {
  assert.equal(typeof models.compatibility.evaluateCompatibility, "function");
  assert.deepEqual(models.compatibility.ROLE_TO_DESCRIPTOR, { main: "chat", embedding: "embedding", reranker: "rerank" });
  assert.equal(require("..").models.compatibility.evaluateCompatibility, evaluateCompatibility);
});
