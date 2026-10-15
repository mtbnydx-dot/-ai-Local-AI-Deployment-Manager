const test = require("node:test");
const assert = require("node:assert/strict");

const { assessDownloadCompatibility } = require("../download-precheck");
const { listGgufVariants, buildVariantDownloadPlan, quantTagOf } = require("../gguf-variants");

const VLLM_RUNTIME = { version: "v0.28.0", bitsAndBytesPlugin: false, cudaVersion: "13.0.2", minimumBlackwellCudaVersion: "12.8" };
const GPU = { computeCap: "12.0", totalMb: 97887 };

test("BNB checkpoints are blocked for vLLM before any download job exists", () => {
  const result = assessDownloadCompatibility({
    engine: "vllm",
    model: "unsloth/Qwen3-32B-bnb-4bit",
    config: { model_type: "qwen3", architectures: ["Qwen3ForCausalLM"], quantization_config: { quant_method: "bitsandbytes" } },
    siblings: [{ name: "config.json", size: 900 }, { name: "model-00001-of-00002.safetensors", size: 5e9 }],
    runtime: VLLM_RUNTIME,
    gpu: GPU,
  });
  assert.equal(result.ok, false);
  assert.equal(result.level, "block");
  assert.ok(result.findings.some((item) => item.code === "bitsandbytes_plugin_missing"));
  assert.equal(result.capability.id, "qwen3");
  assert.equal(result.capability.matchedBy, "modelType");
});

test("a BNB repository is still blocked from the name when config.json is unavailable", () => {
  const result = assessDownloadCompatibility({ engine: "vllm", model: "someone/Llama-3-8B-bnb-4bit", config: null, siblings: [], runtime: VLLM_RUNTIME });
  assert.equal(result.level, "block");
  assert.ok(result.findings.some((item) => item.code === "identity_unknown"));
});

test("llama.cpp refuses safetensors-only repositories and vLLM refuses sharded GGUF", () => {
  const llama = assessDownloadCompatibility({
    engine: "llama",
    model: "Qwen/Qwen3-8B",
    config: { model_type: "qwen3" },
    siblings: [{ name: "model.safetensors", size: 1e9 }, { name: "config.json", size: 1 }],
  });
  assert.ok(llama.findings.some((item) => item.code === "llama_requires_gguf" && item.severity === "block"));

  const sharded = assessDownloadCompatibility({
    engine: "vllm",
    model: "unsloth/Qwen3-235B-GGUF",
    precision: "Q4_K_M",
    config: null,
    siblings: [
      { name: "Q4_K_M/Qwen3-235B-Q4_K_M-00001-of-00003.gguf", size: 4e10 },
      { name: "Q4_K_M/Qwen3-235B-Q4_K_M-00002-of-00003.gguf", size: 4e10 },
      { name: "Q4_K_M/Qwen3-235B-Q4_K_M-00003-of-00003.gguf", size: 4e10 },
    ],
    runtime: VLLM_RUNTIME,
  });
  assert.ok(sharded.findings.some((item) => item.code === "vllm_gguf_sharded" && item.severity === "block"));

  const single = assessDownloadCompatibility({
    engine: "vllm",
    model: "unsloth/Qwen3-8B-GGUF",
    precision: "Q8_0",
    config: null,
    siblings: [{ name: "Qwen3-8B-Q8_0.gguf", size: 8e9 }, { name: "Qwen3-8B-Q4_K_M.gguf", size: 5e9 }],
    runtime: VLLM_RUNTIME,
  });
  assert.equal(single.level, "warn");
  assert.ok(single.findings.some((item) => item.code === "vllm_gguf_experimental"));
});

test("Flash-Next reports its special runtime and hardware floor; Muse is blocked by the matrix rule", () => {
  const flashNext = assessDownloadCompatibility({
    engine: "vllm",
    model: "Qwen/Qwen3.8-Flash-Next-NVFP4",
    config: { model_type: "qwen4_exp", quantization_config: { quant_method: "modelopt_fp4" } },
    siblings: [{ name: "config.json", size: 1 }, { name: "model.safetensors", size: 8.5e10 }],
    runtime: VLLM_RUNTIME,
    gpu: GPU,
    bytes: 8.5e10,
  });
  assert.equal(flashNext.ok, true);
  assert.ok(flashNext.findings.some((item) => item.code === "trust_remote_code"));
  // Launch enables trust-remote-code only from the option; the copy must not promise it.
  const trust = flashNext.findings.find((item) => item.code === "trust_remote_code");
  assert.equal(trust.detail, "需要在启动参数中勾选 trust-remote-code（会执行仓库内的 Python 代码）。");
  assert.doesNotMatch(trust.detail, /自动开启/);
  assert.ok(flashNext.findings.some((item) => item.code === "vram_tight"));
  const olderGpu = assessDownloadCompatibility({
    engine: "vllm",
    model: "Qwen/Qwen3.8-Flash-Next-NVFP4",
    config: { model_type: "qwen4_exp" },
    runtime: VLLM_RUNTIME,
    gpu: { computeCap: "8.9", totalMb: 24000 },
  });
  assert.ok(olderGpu.findings.some((item) => item.code === "compute_capability" && item.severity === "block"));
  const muse = assessDownloadCompatibility({ engine: "vllm", model: "x/muse", config: { model_type: "muse_glimmer" }, runtime: VLLM_RUNTIME });
  assert.equal(muse.level, "block");
});

test("a name-only match reads as inferred and unverified instead of the matrix confidence", () => {
  const byName = assessDownloadCompatibility({
    engine: "vllm",
    model: "Qwen/Qwen3-8B",
    config: { hidden_size: 4096 },
    siblings: [{ name: "config.json", size: 1 }, { name: "model.safetensors", size: 1e9 }],
    runtime: VLLM_RUNTIME,
  });
  assert.equal(byName.capability.matchedBy, "name");
  const identity = byName.findings.find((item) => item.code === "identity");
  assert.ok(identity, "finding code is unchanged");
  assert.match(identity.detail, /按名称推断（未验证）/);
  assert.doesNotMatch(identity.detail, /矩阵置信度/);
  assert.doesNotMatch(identity.detail, new RegExp(byName.capability.confidence));

  const declared = assessDownloadCompatibility({ engine: "vllm", model: "Qwen/Qwen3-8B", config: { model_type: "qwen3" }, runtime: VLLM_RUNTIME });
  const declaredIdentity = declared.findings.find((item) => item.code === "identity");
  assert.equal(declared.capability.matchedBy, "modelType");
  assert.match(declaredIdentity.detail, /按声明识别，矩阵置信度：/);
});

test("GGUF variants are grouped by quant with shard totals, companions and VRAM fit", () => {
  const listing = listGgufVariants([
    { rfilename: "Qwen3-30B-A3B-Q4_K_M.gguf", size: 18e9 },
    { rfilename: "Qwen3-30B-A3B-Q8_0.gguf", size: 32e9 },
    { rfilename: "BF16/Qwen3-30B-A3B-BF16-00001-of-00002.gguf", size: 30e9 },
    { rfilename: "BF16/Qwen3-30B-A3B-BF16-00002-of-00002.gguf", size: 31e9 },
    { rfilename: "mmproj-BF16.gguf", size: 1e9 },
    { rfilename: "Qwen3-30B-A3B-dflash-Q8_0.gguf", size: 2e9 },
    { rfilename: "README.md", size: 10 },
  ], { gpuTotalMb: 24576 });
  assert.deepEqual(listing.variants.map((item) => item.quant), ["Q4_K_M", "Q8_0", "BF16"]);
  const bf16 = listing.variants.find((item) => item.quant === "BF16");
  assert.equal(bf16.multiPart, true);
  assert.equal(bf16.complete, true);
  assert.equal(bf16.bytes, 61e9);
  assert.equal(bf16.vllmLoadable, false);
  assert.equal(listing.variants[0].fit.status, "tight");
  assert.equal(bf16.fit.status, "exceeds");
  assert.equal(listing.mmproj.length, 1);
  assert.equal(listing.drafts.length, 1);
  assert.equal(quantTagOf("model-IQ4_XS.gguf"), "IQ4_XS");
  const plan = buildVariantDownloadPlan("unsloth/Qwen3-30B-A3B-GGUF", listing.variants[0], { includeMmproj: true, includeDraft: true });
  assert.equal(plan.model, "unsloth/Qwen3-30B-A3B-GGUF:Q4_K_M");
  assert.ok(plan.includeExtras.includes("*mmproj*.gguf"));
});

// ----- MOD-11: rows for every engine runtime and every selected GPU (02 section 9)

const BNB_CONFIG = { model_type: "qwen3", architectures: ["Qwen3ForCausalLM"], quantization_config: { quant_method: "bitsandbytes" } };
const BNB_SIBLINGS = [{ name: "config.json", size: 900 }, { name: "model.safetensors", size: 5e9 }];

test("every engine runtime is judged: BNB is blocked only when no runtime can run it", () => {
  const without = { engineId: "vllm", runtimeId: "vllm@0.28.0", version: "0.28.0", status: "pinned", release: { version: "v0.28.0", bitsAndBytesPlugin: false } };
  const withPlugin = { engineId: "vllm", runtimeId: "vllm@0.29.0", version: "0.29.0", status: "pinned", release: { version: "v0.29.0", bitsAndBytesPlugin: true } };
  const base = { engine: "vllm", model: "unsloth/Qwen3-32B-bnb-4bit", config: BNB_CONFIG, siblings: BNB_SIBLINGS };

  const blocked = assessDownloadCompatibility({ ...base, runtimes: [without] });
  const blockedFinding = blocked.findings.find((item) => item.code === "bitsandbytes_plugin_missing");
  assert.equal(blocked.level, "block");
  assert.equal(blockedFinding.severity, "block");
  assert.deepEqual(blocked.runtimes, ["vllm@0.28.0"]);

  const some = assessDownloadCompatibility({ ...base, runtimes: [without, withPlugin] });
  assert.equal(some.ok, true, "one runtime with the plugin is enough to download");
  const warned = some.findings.find((item) => item.code === "bitsandbytes_plugin_missing");
  assert.equal(warned.severity, "warn");
  assert.deepEqual(warned.runtimes, ["vllm@0.28.0"]);
  assert.match(warned.detail, /vllm@0\.28\.0/);
  assert.deepEqual(some.runtimes, ["vllm@0.28.0", "vllm@0.29.0"]);

  // The runtime the caller names is judged together with the registry's own runtimes.
  const named = assessDownloadCompatibility({ ...base, runtime: { version: "v9.9.9", bitsAndBytesPlugin: true } });
  assert.equal(named.ok, true);
  assert.ok(named.runtimes.includes("vllm@9.9.9"));
  assert.ok(named.runtimes.length > 1, "registry runtimes of the engine are included");
});

test("every selected GPU is judged, not only the first", () => {
  const flashNext = { engine: "vllm", model: "Qwen/Qwen3.8-Flash-Next-NVFP4", config: { model_type: "qwen4_exp" }, runtime: VLLM_RUNTIME };
  const both = assessDownloadCompatibility({ ...flashNext, gpus: [{ id: "0", computeCap: "12.0", totalMb: 97887 }, { id: "1", computeCap: "12.0", totalMb: 97887 }] });
  assert.ok(!both.findings.some((item) => item.code === "compute_capability"));
  const mixed = assessDownloadCompatibility({ ...flashNext, gpus: [{ id: "0", computeCap: "12.0", totalMb: 97887 }, { id: "1", computeCap: "8.9", totalMb: 24000 }] });
  const finding = mixed.findings.find((item) => item.code === "compute_capability");
  assert.equal(finding.severity, "block");
  assert.match(finding.detail, /GPU 1（SM 8\.9）/);
  assert.equal(mixed.ok, false);
  // The legacy single gpu field still works.
  const legacy = assessDownloadCompatibility({ ...flashNext, gpu: { computeCap: "8.9", totalMb: 24000 } });
  assert.ok(legacy.findings.some((item) => item.code === "compute_capability" && item.severity === "block"));

  // Weights are spread over the selected GPUs: the VRAM check uses their sum.
  const model = { engine: "vllm", model: "org/model", config: { model_type: "qwen3" }, runtime: VLLM_RUNTIME, bytes: 60 * 1024 ** 3 };
  assert.ok(assessDownloadCompatibility({ ...model, gpus: [{ id: "0", computeCap: "12.0", totalMb: 49152 }] }).findings.some((item) => item.code === "vram_exceeded"));
  const spread = assessDownloadCompatibility({ ...model, gpus: [{ id: "0", computeCap: "12.0", totalMb: 49152 }, { id: "1", computeCap: "12.0", totalMb: 49152 }] });
  assert.ok(!spread.findings.some((item) => item.code === "vram_exceeded"));
});

test("a remote GGUF repository is identified by its GGUF architecture (input or remote card)", () => {
  const siblings = [{ name: "model-Q4_K_M.gguf", size: 8e9 }];
  const listed = assessDownloadCompatibility({ engine: "llama", model: "unsloth/Qwen3-8B-GGUF", config: null, siblings, ggufArchitecture: "qwen3" });
  assert.equal(listed.capability.id, "qwen3");
  assert.equal(listed.capability.matchedBy, "gguf");
  assert.equal(listed.capability.confidence, "declared");
  assert.ok(listed.findings.some((item) => item.code === "identity" && /按声明识别/.test(item.detail)));
  assert.ok(!listed.findings.some((item) => item.code === "identity_unknown"));

  const unlisted = assessDownloadCompatibility({ engine: "llama", model: "org/DeepSeek-V4-Flash-GGUF", config: null, siblings, ggufArchitecture: "deepseek4" });
  const unlistedFinding = unlisted.findings.find((item) => item.code === "identity_unlisted");
  assert.equal(unlistedFinding.severity, "warn", "unlisted is a warning now, with the same code");
  assert.equal(unlisted.level, "warn");
  assert.equal(unlisted.ok, true);
  assert.equal(unlisted.capability.id, "");
  assert.equal(unlisted.capability.confidence, "");

  const remoteCard = { identity: { ggufArchitecture: "muse-glimmer", architectures: [] }, remote: { siblings } };
  const muse = assessDownloadCompatibility({ engine: "llama", model: "x/y", config: null, card: remoteCard });
  assert.equal(muse.level, "block");
  assert.ok(muse.findings.some((item) => item.severity === "block" && /Muse Glimmer/.test(item.detail)));
  assert.equal(muse.format.hasGguf, true, "the card's file list stands in for the siblings");

  const fromCard = assessDownloadCompatibility({ engine: "llama", model: "unsloth/Qwen3-8B-GGUF", config: null, siblings, card: { identity: { ggufArchitecture: "qwen3" } } });
  assert.equal(fromCard.capability.id, "qwen3");
});

test("capability.confidence is the fact confidence; the knowledge entry's own confidence is separate", () => {
  const declared = assessDownloadCompatibility({ engine: "vllm", model: "Qwen/Qwen3-8B", config: { model_type: "qwen3" }, runtime: VLLM_RUNTIME });
  assert.equal(declared.capability.confidence, "declared");
  assert.equal(declared.capability.knowledgeConfidence, "documented");
  const byName = assessDownloadCompatibility({ engine: "vllm", model: "Qwen/Qwen3-8B", config: { hidden_size: 4096 }, runtime: VLLM_RUNTIME });
  assert.equal(byName.capability.confidence, "name-heuristic");
  assert.match(byName.findings.find((item) => item.code === "identity").detail, /按名称推断（未验证）/);
  // The trust_remote_code copy and code are P0-14's.
  const remoteCode = assessDownloadCompatibility({ engine: "vllm", model: "org/Remote", config: { model_type: "nemotron_h", auto_map: { AutoModel: "m.M" } }, runtime: VLLM_RUNTIME });
  const trust = remoteCode.findings.find((item) => item.code === "trust_remote_code");
  assert.equal(trust.detail, "需要在启动参数中勾选 trust-remote-code（会执行仓库内的 Python 代码）。");
});

test("NVFP4 on an older GPU warns about the emulated fallback; DiffusionGemma follows the WSL block and its env bypass", () => {
  const nvfp4 = assessDownloadCompatibility({
    engine: "vllm",
    model: "org/Model-NVFP4",
    config: { model_type: "qwen3", quantization_config: { quant_method: "modelopt_fp4" } },
    runtime: VLLM_RUNTIME,
    gpu: { computeCap: "8.9", totalMb: 24000 },
  });
  assert.equal(nvfp4.findings.find((item) => item.code === "nvfp4_emulated").severity, "warn");
  assert.equal(nvfp4.ok, true);

  const diffusion = { engine: "vllm", model: "google/diffusiongemma", config: { model_type: "diffusiongemma", architectures: ["DiffusionGemmaForBlockDiffusion"] }, runtime: VLLM_RUNTIME, platform: "wsl" };
  const blocked = assessDownloadCompatibility({ ...diffusion, env: {} });
  assert.equal(blocked.findings.find((item) => item.code === "diffusion_gemma_windows").severity, "block");
  assert.equal(blocked.ok, false);
  const bypassed = assessDownloadCompatibility({ ...diffusion, env: { VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA: "1" } });
  assert.ok(!bypassed.findings.some((item) => item.code === "diffusion_gemma_windows"));
  assert.equal(bypassed.ok, true);
});
