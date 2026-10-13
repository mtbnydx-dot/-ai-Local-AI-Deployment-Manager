const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { probeHfMirrorSpeed, pickFaster, probeUrl } = require("../mirror-probe");
const { suggestModelScopeRepo } = require("../repo-mirrors");
const { createThroughputAdvisor, formatSlowDownloadHint } = require("../download-throughput");
const { inspectDownloadResume } = require("../download-resume-check");
const { groupPrecisionVariants, detectPrecision, baseNameOf } = require("../precision-variants");
const { fetchRemoteModelConfig, remoteConfigUrl } = require("../remote-model-config");

function fakeResponse({ status = 200, bytes = 2 * 1024 * 1024, delayMs = 0, body = null } = {}) {
  return async () => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => new ArrayBuffer(bytes),
      text: async () => (body === null ? "" : body),
    };
  };
}

test("repository mirrors map Hugging Face organisations to ModelScope candidates", () => {
  assert.deepEqual(suggestModelScopeRepo("zai-org/GLM-4.6").candidates, ["ZhipuAI/GLM-4.6", "zai-org/GLM-4.6"]);
  assert.equal(suggestModelScopeRepo("Qwen/Qwen3-8B").candidates[0], "Qwen/Qwen3-8B");
  assert.equal(suggestModelScopeRepo("unknown-org/model").confidence, "same-name");
  assert.deepEqual(suggestModelScopeRepo("no-slash").candidates, []);
});

test("three-source probe tries ModelScope candidates and recommends the clearly faster source", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("hf-mirror.com")) return fakeResponse({ delayMs: 5 })();
    if (url.includes("modelscope.cn/models/ZhipuAI/")) return fakeResponse({ status: 404 })();
    if (url.includes("modelscope.cn")) return fakeResponse({ delayMs: 1 })();
    return fakeResponse({ delayMs: 60 })();
  };
  const result = await probeHfMirrorSpeed({ model: "zai-org/GLM-4.6", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.modelscope.ok, true);
  assert.equal(result.modelScopeRepo, "zai-org/GLM-4.6");
  assert.ok(calls.some((url) => url.includes("modelscope.cn/models/ZhipuAI/GLM-4.6")), "mapped candidate was tried first");
  assert.equal(result.sources.length, 3);
  assert.ok(["mirror", "modelscope"].includes(result.recommended));
  assert.equal(probeUrl("modelscope", "Qwen/Qwen3-8B", "config.json"), "https://www.modelscope.cn/models/Qwen/Qwen3-8B/resolve/master/config.json");
});

test("the mirror probe sends a Hugging Face token to huggingface.co only", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, authorization: init.headers?.authorization });
    return fakeResponse()();
  };
  await probeHfMirrorSpeed({ model: "Qwen/Qwen3-8B", token: "fake-probe-token-for-tests", fetchImpl });
  const official = seen.filter((item) => item.url.startsWith("https://huggingface.co/"));
  const others = seen.filter((item) => !item.url.startsWith("https://huggingface.co/"));
  assert.equal(official.length, 1);
  assert.equal(official[0].authorization, "Bearer fake-probe-token-for-tests");
  assert.ok(others.some((item) => item.url.startsWith("https://hf-mirror.com/")), "the mirror was probed");
  assert.ok(others.length >= 2);
  for (const item of others) assert.equal(item.authorization, undefined, `${new URL(item.url).host} receives no Authorization`);
});

test("the official source keeps the recommendation unless another source is clearly faster", () => {
  const official = { source: "official", ok: true, bytes: 2 * 1024 * 1024, bytesPerSec: 10_000_000, ms: 200 };
  const mirror = { source: "mirror", ok: true, bytes: 2 * 1024 * 1024, bytesPerSec: 10_800_000, ms: 190 };
  assert.equal(pickFaster([official, mirror]).source, "official");
  const fastMirror = { ...mirror, bytesPerSec: 30_000_000 };
  assert.equal(pickFaster([official, fastMirror]).source, "mirror");
  assert.equal(pickFaster([{ source: "official", ok: false }]), null);
});

test("throughput advisor raises one slow-download hint after the sampling window", () => {
  let clock = 0;
  const advisor = createThroughputAdvisor({ minSampleMs: 60_000, slowBytesPerSec: 1_000_000, now: () => clock });
  assert.equal(advisor.observe(0), null);
  clock = 30_000;
  assert.equal(advisor.observe(10_000_000), null, "not enough elapsed time");
  clock = 61_000;
  assert.equal(advisor.observe(100_000_000), null, "fast enough");
  advisor.reset();
  clock = 0;
  advisor.observe(0);
  clock = 61_000;
  const advice = advisor.observe(30_000_000);
  assert.equal(advice.kind, "slow");
  assert.ok(advice.averageBytesPerSec < 1_000_000);
  assert.equal(advisor.observe(31_000_000, 120_000), null, "only advised once");
  const hint = formatSlowDownloadHint(advice, { source: "huggingface", hfMirror: false, modelScopeRepo: "Qwen/X" });
  assert.match(hint, /hf-mirror/);
  assert.match(hint, /ModelScope 同源仓 Qwen\/X/);
});

test("resume check classifies manifest files and estimates remaining bytes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-check-"));
  fs.writeFileSync(path.join(dir, "config.json"), "{}");
  fs.writeFileSync(path.join(dir, "model-00001-of-00002.safetensors"), Buffer.alloc(1000));
  fs.mkdirSync(path.join(dir, ".cache", "huggingface", "download"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".cache", "huggingface", "download", "model-00002-of-00002.safetensors.abc123.incomplete"), Buffer.alloc(400));
  const result = await inspectDownloadResume({
    localDir: dir,
    fileManifest: [
      { name: "model-00001-of-00002.safetensors", size: 1000 },
      { name: "model-00002-of-00002.safetensors", size: 1000 },
      { name: "model-00003-of-00003.safetensors", size: 500 },
    ],
    diskFreeBytes: 50 * 1024 ** 3,
  });
  assert.equal(result.complete.length, 1);
  assert.equal(result.partial.length, 1);
  assert.equal(result.partial[0].actual, 400);
  assert.equal(result.missing.length, 1);
  assert.equal(result.remainingBytes, 2500 - 1000 - 400);
  assert.equal(result.diskOk, true);
  assert.equal(result.resumable, true);
  assert.equal(result.incompleteFiles, 1);
  fs.rmSync(dir, { recursive: true, force: true });
  const gone = await inspectDownloadResume({ localDir: dir, fileManifest: [] });
  assert.equal(gone.exists, false);
  assert.equal(gone.resumable, false);
});

test("precision variants group same-model repositories and rate engine support", () => {
  assert.equal(detectPrecision("RedHatAI/Qwen3-32B-NVFP4"), "NVFP4");
  assert.equal(detectPrecision("Qwen/Qwen3-32B-FP8"), "FP8");
  assert.equal(detectPrecision("unsloth/Qwen3-32B-bnb-4bit"), "BNB-4bit");
  assert.equal(baseNameOf("unsloth/Qwen3-32B-GGUF"), "qwen3-32b");
  assert.equal(baseNameOf("Qwen/Qwen3-32B"), "qwen3-32b");
  const grouped = groupPrecisionVariants("Qwen/Qwen3-32B", [
    { id: "Qwen/Qwen3-32B", downloads: 100 },
    { id: "Qwen/Qwen3-32B-FP8", downloads: 50 },
    { id: "RedHatAI/Qwen3-32B-NVFP4", downloads: 20 },
    { id: "unsloth/Qwen3-32B-GGUF", downloads: 80, hasGguf: true },
    { id: "unsloth/Qwen3-32B-bnb-4bit", downloads: 10 },
    { id: "mlx-community/Qwen3-32B-4bit-MLX", downloads: 5 },
    { id: "Qwen/Qwen3-8B", downloads: 999 },
  ], { vllmRuntime: { bitsAndBytesPlugin: false } });
  assert.deepEqual(grouped.variants.map((item) => item.precision), ["BASE", "NVFP4", "FP8", "GGUF", "BNB-4bit", "MLX"]);
  const gguf = grouped.variants.find((item) => item.precision === "GGUF");
  assert.equal(gguf.support.llama, "ok");
  assert.equal(gguf.recommendedEngine, "vllm" === gguf.support.vllm ? "vllm" : "llama");
  assert.equal(grouped.variants.find((item) => item.precision === "BNB-4bit").support.vllm, "block");
  assert.equal(grouped.variants.find((item) => item.precision === "MLX").recommendedEngine, "");
  assert.equal(grouped.variants[0].isCurrent, true);
});

test("remote config fetch distinguishes missing, gated and valid config.json", async () => {
  assert.equal(remoteConfigUrl("modelscope", "Qwen/Qwen3-8B"), "https://www.modelscope.cn/models/Qwen/Qwen3-8B/resolve/master/config.json");
  const missing = await fetchRemoteModelConfig({ model: "x/y", fetchImpl: fakeResponse({ status: 404 }) });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  const gated = await fetchRemoteModelConfig({ model: "x/y", fetchImpl: fakeResponse({ status: 403 }) });
  assert.equal(gated.gated, true);
  const valid = await fetchRemoteModelConfig({ model: "x/y", token: "t", fetchImpl: fakeResponse({ body: JSON.stringify({ model_type: "qwen3" }) }) });
  assert.equal(valid.ok, true);
  assert.equal(valid.config.model_type, "qwen3");
  const bad = await fetchRemoteModelConfig({ model: "x/y", fetchImpl: fakeResponse({ body: "not json" }) });
  assert.match(bad.reason, /JSON/);
});
