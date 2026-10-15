"use strict";

// Root-cause classification (docs/overhaul/02-models.md §14, MOD-12). Ledger-derived
// log snippets (test/fixtures/root-cause-samples/*.log.fixture, scrubbed) map to
// error-signature ids and to the 00 §9.11 job error object. No docker, no network.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const core = require("..");
const knowledge = require("../model-inspector/knowledge");
const rootCause = require("../model-inspector/root-cause");

const FIXTURES = path.join(__dirname, "fixtures", "root-cause-samples");
const SAMPLES = JSON.parse(fs.readFileSync(path.join(FIXTURES, "samples.json"), "utf8")).samples;
const readSample = (sample) => fs.readFileSync(path.join(FIXTURES, sample.file), "utf8");
const sampleById = (id) => SAMPLES.find((item) => item.id === id);

// Bundled knowledge plus the descriptors' additions, exactly as the managers load them.
const merged = (engineId) => knowledge.errorSignatures(engineId);

test("every ledger-derived sample maps to its signature id and the 00 §9.11 object", () => {
  for (const sample of SAMPLES) {
    const result = rootCause.classifyFailure(readSample(sample), { engineId: sample.engineId, phase: sample.phase });
    assert.ok(result, sample.id);
    assert.equal(result.code, sample.expected.code, sample.id);
    assert.equal(result.signatureId, sample.expected.signatureId, sample.id);
    assert.equal(result.phase, sample.phase, sample.id);
    assert.ok(result.logExcerpt.length > 0, sample.id);
    assert.ok(result.logExcerpt.split("\n").length <= 40, sample.id);
    assert.ok(Buffer.byteLength(result.logExcerpt, "utf8") <= 4096, sample.id);
    if (sample.expected.signatureId) {
      assert.ok(result.hint.zh && result.hint.en, `${sample.id}: bilingual hint`);
      assert.ok(result.title.zh && result.title.en, `${sample.id}: bilingual title`);
      assert.ok(Array.isArray(result.suggestions), sample.id);
    } else {
      assert.equal(result.hint, null, sample.id);
    }
    if (sample.expected.capture) assert.ok(result.title.en.includes(sample.expected.capture), `${sample.id}: capture interpolated`);
    if (sample.expected.logExcerptIncludes) assert.ok(result.logExcerpt.includes(sample.expected.logExcerptIncludes), sample.id);
  }
});

test("the matched line is in the excerpt with limited context, not the raw tail", () => {
  const sample = sampleById("vllm-transformers-unknown-arch");
  const result = rootCause.classifyFailure(readSample(sample), { engineId: "vllm", phase: "weights" });
  assert.match(result.logExcerpt, /does not recognize this architecture/);
  assert.ok(result.logExcerpt.split("\n").length <= 6);
  assert.equal(result.exceptionType, "ValueError");
  assert.equal(result.signatureId, "transformers-unknown-arch");
  assert.deepEqual(result.suggestions.map((item) => item.kind), ["probe", "param", "runtime"]);
  assert.equal(result.suggestions[1].security, true);
  assert.ok(!/pid=\d+|\x1b/.test(result.logExcerpt), "process prefixes and ANSI are stripped");
});

test("the llama.cpp descriptor addition (mmproj) is found in the merged signatures and in a stub", () => {
  const sample = sampleById("llama-mmproj-missing");
  const stub = [{
    id: "llama-mmproj-missing", code: "mmproj_missing", engines: ["llamacpp"], phase: "container", rootCause: true, severity: "error",
    regex: "Multimodal mode requires an mmproj", title: { zh: "缺少 mmproj", en: "mmproj missing" }, hint: { zh: "放置 mmproj", en: "Add the mmproj" },
  }];
  const stubbed = rootCause.classifyFailure(readSample(sample), { engineId: "llamacpp", phase: "container", signatures: stub });
  assert.equal(stubbed.signatureId, "llama-mmproj-missing");
  assert.equal(stubbed.hint.en, "Add the mmproj");
  const loaded = rootCause.classifyFailure(readSample(sample), { engineId: "llamacpp", phase: "container", signatures: merged });
  assert.equal(loaded.signatureId, "llama-mmproj-missing");
  assert.equal(rootCause.classifyFailure(readSample(sample), { engineId: "llamacpp", signatures: [] }).code, "engine_start_failed");
});

test("the last rootCause hit before the terminal marker wins; rootCause entries beat weaker ones", () => {
  const sample = sampleById("llama-cuda-buffer-alloc");
  // The log also says "out of memory" (generic cuda-oom) earlier; the buffer allocation is the later, more specific hit.
  assert.match(readSample(sample), /out of memory/);
  assert.equal(rootCause.classifyFailure(readSample(sample), { engineId: "llamacpp" }).signatureId, "cuda-buffer-alloc");
  const text = "ERROR address already in use\nERROR CUDA out of memory\nRuntimeError: Engine core initialization failed.\nERROR address already in use after the marker";
  assert.equal(rootCause.classifyFailure(text, { engineId: "vllm" }).signatureId, "cuda-oom");
  const weak = [
    { id: "weak", code: "weak_one", engines: ["*"], rootCause: false, severity: "error", regex: "weak thing" },
    { id: "strong", code: "strong_one", engines: ["*"], rootCause: true, severity: "error", regex: "strong thing" },
  ];
  assert.equal(rootCause.classifyFailure("strong thing\nweak thing\n", { signatures: weak }).signatureId, "strong");
  assert.equal(rootCause.classifyFailure("weak thing\n", { signatures: weak }).signatureId, "weak");
  const warn = [{ id: "advice", code: "advice_only", engines: ["*"], rootCause: true, severity: "warn", regex: "cuda" }];
  assert.equal(rootCause.classifyFailure("cuda here\n", { signatures: warn }).signatureId, null, "warn entries only feed hints");
});

test("no signature: the last traceback block, or the last llama.cpp error line, with code engine_start_failed", () => {
  const traceback = rootCause.classifyFailure(readSample(sampleById("sglang-traceback-fallback")), { engineId: "sglang", phase: "kv" });
  assert.equal(traceback.code, "engine_start_failed");
  assert.equal(traceback.signatureId, null);
  assert.equal(traceback.phase, "kv");
  assert.equal(traceback.exceptionType, "AssertionError");
  assert.match(traceback.logExcerpt, /^Scheduler hit an exception: Traceback/m);
  assert.match(traceback.logExcerpt, /AssertionError: \(48, \[\]\)$/);
  assert.ok(!traceback.logExcerpt.includes("Received sigquit"), "the block ends at its final exception line");

  const llama = rootCause.classifyFailure("srv load_model: loading\nllama_model_load: error loading tensor foo\nsome unrelated line\nmain: warming up\n", { engineId: "llamacpp", signatures: [] });
  assert.equal(llama.code, "engine_start_failed");
  assert.match(llama.logExcerpt, /llama_model_load: error loading tensor foo$/);

  assert.equal(rootCause.classifyFailure("", { engineId: "vllm" }), null);
  assert.equal(rootCause.classifyFailure("\n  \n", { engineId: "vllm" }), null);
  assert.equal(rootCause.classifyFailure(undefined, {}), null);
});

test("secrets become <redacted> (secret-redactor), host paths shrink to base names, ANSI and prefixes go", () => {
  const sample = sampleById("vllm-port-in-use-with-secrets");
  const withSecrets = rootCause.classifyFailure(readSample(sample), { engineId: "vllm", secrets: sample.expected.redactedWithSecrets });
  assert.equal(withSecrets.signatureId, "port-in-use");
  for (const secret of sample.expected.redactedWithSecrets) assert.equal(withSecrets.logExcerpt.includes(secret), false);
  // A secret and a host path next to the matching line end up in the excerpt, redacted.
  const noisy = [
    "Readiness probe: GET /v1/models with Authorization: Bearer fake-root-cause-bearer-0003 failed",
    "loading E:\\hostdir\\models\\Qwen-Qwen3.8-27B-FP8\\model.safetensors and <AI_ROOT>\\models\\x\\y.gguf",
    "--api-key fake-root-cause-api-key-0001 --hf-token=fake-root-cause-hf-token-0002",
    "\u001b[1;36m(APIServer pid=1)\u001b[0;0m ERROR 10-14 03:11:20 [launcher.py:122] OSError: address already in use",
  ].join("\n");
  const result = rootCause.classifyFailure(noisy, { engineId: "vllm" });
  assert.equal(result.signatureId, "port-in-use");
  assert.match(result.logExcerpt, /<redacted>/);
  for (const secret of ["fake-root-cause-bearer-0003", "fake-root-cause-api-key-0001", "fake-root-cause-hf-token-0002"]) assert.equal(result.logExcerpt.includes(secret), false, secret);
  assert.ok(!result.logExcerpt.includes("hostdir") && !result.logExcerpt.includes("E:\\"), "drive paths reduced");
  assert.match(result.logExcerpt, /model\.safetensors/);
  assert.match(result.logExcerpt, /OSError: address already in use$/);
  assert.equal(result.exceptionType, "OSError");
});

test("excerpt bounds: at most 40 lines and 4 KiB even for huge logs and long lines", () => {
  const many = Array.from({ length: 5000 }, (_, index) => `line ${index} ${"x".repeat(200)}`);
  many.unshift("Traceback (most recent call last):");
  many.push("RuntimeError: boom");
  const result = rootCause.classifyFailure(many.join("\n"), { engineId: "vllm", signatures: [] });
  assert.ok(result.logExcerpt.split("\n").length <= 40);
  assert.ok(Buffer.byteLength(result.logExcerpt, "utf8") <= 4096);
  assert.match(result.logExcerpt, /RuntimeError: boom$/);
});

// ---- every old logIssueHint / buildLogSuggestions string is covered by the data ----

const H_MAMBA = "这是 Qwen3.6 混合/Mamba cache align 下的调度 token 上限过低；把 --max-num-batched-tokens 提高到 8192 后重试。";
const H_MODELOPT = "这是 Qwen3.6/NVFP4 的 ModelOpt 权重布局与当前 vLLM 加载器不匹配；优先换 vllm/vllm-openai:nightly 或模型卡指定的 vLLM 版本。";
const H_FLASHINFER = "这是 Qwen3.6/NVFP4 在 FlashInfer + FP8 KV prefill 路径上的 CUDA 崩溃风险；dense 模型改用 --attention-backend TRITON_ATTN，是否启用 thinking 由客户端请求决定。";
const H_THINKING = "这是 Qwen3.6/NVFP4 thinking 或生成退化循环；dense 模型使用 TRITON_ATTN，SM12x MoE 使用 flashinfer_b12x + generation-config vllm；thinking 由客户端按需传 chat_template_kwargs.enable_thinking 控制。";
const H_UVA = "这是 Windows Docker/WSL 的 pinned memory / UVA 限制；DiffusionGemma 的 V2 runner 需要 UVA，建议换原生 Linux 或使用非 DiffusionGemma 模型。";
const H_ASSERT = "这是推理期 CUDA kernel 断言，不是端口或显存占满；DiffusionGemma NVFP4 在 Windows Docker/WSL fallback 路径下可能无法稳定生成。";
const H_OOM = "降低 max_model_len / max_num_seqs，启用 FP8 KV cache，或降低 gpu-memory-utilization。";
const H_PATH = "检查模型路径、Docker 挂载目录和文件名。";
const H_TRUST = "该模型可能需要开启 trust_remote_code。";
const H_TOKEN = "检查 HF_TOKEN 和模型授权。";
const H_GGUF = "GGUF 优先用 llama.cpp；若坚持 vLLM，确认 tokenizer/hf-config-path。";
const H_DEFAULT = "打开日志页查看完整上下文，必要时用保守 Profile 重试。";

const OLD_HINTS = [
  ["Assertion mamba cache align failed", H_MAMBA],
  ["max_num_batched_tokens (2048) is smaller than block_size", H_MAMBA],
  ["block_size 1056 must be below batched_tokens", H_MAMBA],
  ["KeyError: w2_input_scale", H_MODELOPT],
  ["quant_method modelopt_mixed", H_MODELOPT],
  ["start (2048) + length (512) exceeds dimension size (2048).", H_MODELOPT],
  ["BatchPrefillWithPagedKVCache failed", H_FLASHINFER],
  ["CUDA error: an illegal memory access was encountered", H_FLASHINFER],
  ["Here's a thinking process: 1. analyse", H_THINKING],
  ["output: !!!!!!!!!!!!!!!!!!!!", H_THINKING],
  ["UVA is not available", H_UVA],
  ["ScatterGatherKernel.cu:367: Assertion", H_ASSERT],
  ["CUDA error: device-side assert triggered", H_ASSERT],
  ["torch.OutOfMemoryError: CUDA out of memory", H_OOM],
  ["cuda initialisation failed", H_OOM],
  ["No such file or directory: /models/x", H_PATH],
  ["config.json not found", H_PATH],
  ["ValueError: set trust_remote_code=True", H_TRUST],
  ["trust_remote_code is required here", H_TRUST],
  ["Invalid token for hub", H_TOKEN],
  ["Access to this gated repo is restricted", H_TOKEN],
  ["cannot read gguf header", H_GGUF],
  ["something entirely different happened", H_DEFAULT],
];

test("every old logIssueHint string is returned by the signature data for its old trigger", () => {
  for (const [message, expected] of OLD_HINTS) {
    assert.equal(rootCause.legacyHint(message, "vllm"), expected, message);
  }
  assert.equal(rootCause.DEFAULT_HINT.zh, H_DEFAULT);
});

const S_MAMBA = "Mamba cache align 断言：max_num_batched_tokens 太小，Qwen3.6 MoE/NVFP4 用 --max-num-batched-tokens 8192 后重试。";
const S_MODELOPT = "Qwen3.6/NVFP4 加载失败：当前 vLLM 镜像可能不支持该 ModelOpt 权重布局，换 vllm/vllm-openai:nightly 或模型卡指定版本后重试。";
const S_DEGRADED = "Qwen3.6/NVFP4 推理退化或 FlashInfer prefill 崩溃：dense 模型使用 TRITON_ATTN，SM12x MoE 使用 flashinfer_b12x + generation-config vllm；thinking 开关应由客户端通过 chat_template_kwargs.enable_thinking 控制。";
const S_DIFFUSION = "DiffusionGemma NVFP4 当前在 Windows Docker/WSL 路径不稳：优先换原生 Linux + V2 runner，或改跑常规 Qwen/Gemma 模型。";
const OLD_SUGGESTIONS = [
  ["mamba cache align", S_MAMBA],
  ["File qwen3_5.py line 612", S_MODELOPT],
  ["exceeds dimension size", S_MODELOPT],
  ["illegal memory access", S_DEGRADED],
  ["Here's a thinking process", S_DEGRADED],
  ["UVA is not available", S_DIFFUSION],
  ["device-side assert", S_DIFFUSION],
  ["CUDA out of memory", "显存错误：先切到低显存保守模式或把上下文减半。"],
  ["no such file", "路径错误：从模型库选择本地模型并自动填入启动表单。"],
  ["gated repo", "授权错误：配置 HF_TOKEN 后重新下载或启动。"],
];

test("every old buildLogSuggestions string is returned for its old trigger, with the old fallbacks", () => {
  for (const [message, expected] of OLD_SUGGESTIONS) {
    const suggestions = rootCause.legacySuggestions([{ message }], "error", "vllm");
    assert.ok(suggestions.includes(expected), message);
  }
  // Distinct explanations only: the FlashInfer and thinking-loop triggers share one text.
  const both = rootCause.legacySuggestions([{ message: "illegal memory access" }, { message: "Here's a thinking process" }], "error", "vllm");
  assert.equal(both.filter((item) => item === S_DEGRADED).length, 1);
  assert.deepEqual(rootCause.legacySuggestions([], "loading weights", "vllm"), ["如果长时间停在编译或 warmup，观察 GPU 利用率；首次启动慢通常正常。"]);
  assert.deepEqual(rootCause.legacySuggestions([], "API ready", "vllm"), ["当前日志没有明显错误。"]);
});

test("vllm-manager's log callbacks delegate to the signature data", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "vllm-manager", "server.js"), "utf8");
  const body = /function logIssueHint\(message\) \{([\s\S]*?)\n\}/.exec(source)[1];
  assert.match(body, /rootCause\.legacyHint/);
  assert.doesNotMatch(source, /text\.includes\("mamba cache align"\)/);
});

test("managerHooks().classifyFailure is the same function, never throws, and takes injected signatures", () => {
  const hooks = core.models.managerHooks({});
  const sample = sampleById("vllm-kv-too-small");
  const result = hooks.classifyFailure(readSample(sample), { engineId: "vllm", phase: "kv" });
  assert.equal(result.signatureId, "vllm-kv-too-small");
  assert.equal(hooks.classifyFailure("", { engineId: "vllm" }), null);
  assert.equal(hooks.classifyFailure(null), null);
  const injected = core.models.managerHooks({ errorSignatures: [{ id: "only", code: "only_one", engines: ["*"], rootCause: true, severity: "error", regex: "kv cache memory" }] });
  assert.equal(injected.classifyFailure(readSample(sample), { engineId: "vllm" }).signatureId, "only");
  assert.equal(typeof core.models.rootCause.classifyFailure, "function");
});

test("bundled signatures load without problems and are scoped by engine", () => {
  const vllm = merged("vllm").map((item) => item.id);
  for (const id of ["transformers-unknown-arch", "vllm-kv-too-small", "modelopt-layout-mismatch", "deepgemm-sf-transform", "port-in-use", "cuda-oom", "hf-gated-token"]) assert.ok(vllm.includes(id), id);
  assert.ok(!vllm.includes("llama-unknown-arch"));
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "knowledge", "error-signatures.json"), "utf8")).entries;
  const loaded = new Set(merged().map((item) => item.id));
  const generic = merged("vllm").concat(merged("llamacpp"), merged("sglang")).map((item) => item.id);
  for (const entry of bundled) assert.ok(generic.includes(entry.id) || loaded.has(entry.id), `${entry.id} was loaded`);
});
