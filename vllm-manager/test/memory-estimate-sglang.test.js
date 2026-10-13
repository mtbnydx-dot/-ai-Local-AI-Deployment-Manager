const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildVllmMemoryEstimate } = require("../lib/memory-estimate");
const { createVllmDefaultLaunchProfiles } = require("../lib/default-profiles");

const POLICY = { reserveMb: 8192, maxUtilizationPct: 95, startupMarginMb: 1024 };
const GPU = { id: "0", name: "RTX PRO 6000", totalMb: 97887, usedMb: 600, freeMb: 97287 };

function flashNextBody(overrides = {}) {
  const profile = createVllmDefaultLaunchProfiles((config) => ({ ...config }))
    .find((item) => item.id === "qwen38-flash-next-sglang-262k");
  return {
    ...profile.config,
    paramsB: 80,
    contextTokens: profile.config.maxModelLen,
    bytesPerParam: 0.5,
    kvBytes: 2,
    selectedGpus: [GPU],
    ...overrides,
  };
}

function keysOf(value) {
  return Object.keys(value || {}).sort();
}

test("SGLang memory estimate previews the clamped admission of the Flash-Next 262K profile", () => {
  const result = buildVllmMemoryEstimate(flashNextBody({ admissionPolicy: POLICY }));
  assert.equal(result.ok, true);
  assert.equal(result.engine, "sglang");
  assert.equal(result.plan.policy, "static-fraction-of-free");
  assert.equal(result.plan.estimatePolicy, "sglang_mem_fraction_static_of_free");
  assert.deepEqual(result.plan.admissionPreview, {
    verdict: "warn",
    requestedMb: 96801,
    availableMb: 89095,
    reservedMb: 89095,
    clamped: true,
    maxFraction: 0.915,
    poolCappedTokens: 262144,
    basis: "policy-snapshot",
  });
  assert.equal(result.plan.status, "warn");
  assert.equal(result.recommendations.status, "warn");
  assert.match(result.recommendations.suggestions[0], /^SGLang 静态显存比例按空闲显存折算需要 96801 MiB/);
});

test("SGLang memory estimate previews the refusal of an uncapped pool with maxFraction", () => {
  const result = buildVllmMemoryEstimate(flashNextBody({ sglangMaxTotalTokens: "", admissionPolicy: POLICY }));
  assert.equal(result.engine, "sglang");
  assert.equal(result.plan.admissionPreview.verdict, "block");
  assert.equal(result.plan.admissionPreview.clamped, false);
  assert.equal(result.plan.admissionPreview.maxFraction, 0.915);
  assert.equal(result.plan.admissionPreview.poolCappedTokens, 0);
  assert.equal(result.plan.status, "fail");
  assert.equal(result.recommendations.status, "fail");
  assert.equal(result.recommendations.summary, "预计会显存不足");
  const [first] = result.recommendations.suggestions;
  assert.match(first, /^替换启动需要 96801 MiB，安全预算只有 89095 MiB。请把「静态显存比例（mem-fraction-static）」降到 0\.915 以下/);
  assert.match(first, /Replacement launch needs 96801 MiB/);
  assert.doesNotMatch(first, /Parallel|并行/);
});

test("SGLang memory estimate keeps every legacy response key of the vLLM estimate", () => {
  const body = flashNextBody({ admissionPolicy: POLICY });
  const sglang = buildVllmMemoryEstimate(body);
  const vllm = buildVllmMemoryEstimate({ ...body, engine: "vllm" });
  assert.equal(vllm.engine, "vllm");
  assert.deepEqual(keysOf(sglang), keysOf(vllm));
  for (const key of keysOf(vllm.plan)) assert.ok(Object.hasOwn(sglang.plan, key), `plan.${key}`);
  assert.deepEqual(keysOf(sglang.recommendations), keysOf(vllm.recommendations));
  // The estimator math is shared; only the admission-derived fields differ.
  assert.equal(sglang.plan.perGpuGb, vllm.plan.perGpuGb);
  assert.equal(Object.hasOwn(vllm.plan, "admissionPreview"), false);
  assert.equal(Object.hasOwn(vllm.plan, "policy"), false);
});

test("SGLang memory estimate without GPU data has no preview and keeps the estimator status", () => {
  const result = buildVllmMemoryEstimate(flashNextBody({ selectedGpus: [], admissionPolicy: POLICY }));
  assert.equal(result.engine, "sglang");
  assert.equal(result.plan.admissionPreview, null);
  assert.equal(result.plan.policy, "static-fraction-of-free");
  assert.equal(result.plan.status, "warn");
  assert.equal(result.recommendations.status, "warn");
});

test("SGLang memory estimate defaults to the gpu-admission policy defaults", () => {
  // 8192 MiB reserve, 85 % ceiling and 1024 MiB margin: a 0.9 fraction of
  // 97287 MiB free needs 87559 MiB, above floor(97887 x 0.85) - 600 - 1024.
  const result = buildVllmMemoryEstimate(flashNextBody({ gpuMemoryUtilization: 0.9 }));
  assert.equal(result.plan.admissionPreview.requestedMb, 87559);
  assert.equal(result.plan.admissionPreview.availableMb, 81579);
  assert.equal(result.plan.admissionPreview.verdict, "warn");
});

test("a request without an engine still reports vLLM", () => {
  const result = buildVllmMemoryEstimate({ paramsB: 7, selectedGpus: [GPU] });
  assert.equal(result.engine, "vllm");
  assert.equal(Object.hasOwn(result.plan, "admissionPreview"), false);
});

test("server memory-estimate wiring uses the live admission policy and ignores a body policy", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "vllm-memory-estimate-"));
  const policyFile = path.join(root, "fleet-settings.json");
  await fsp.writeFile(policyFile, JSON.stringify({ reserveMb: 8192, maxUtilizationPct: 95 }), "utf8");
  const previous = {
    policyFile: process.env.MODEL_GPU_ADMISSION_POLICY_FILE,
    admissionRoot: process.env.MODEL_GPU_ADMISSION_ROOT,
    startupMargin: process.env.MODEL_GPU_ADMISSION_STARTUP_MARGIN_MB,
  };
  process.env.MODEL_GPU_ADMISSION_POLICY_FILE = policyFile;
  process.env.MODEL_GPU_ADMISSION_ROOT = path.join(root, "admission");
  process.env.MODEL_GPU_ADMISSION_STARTUP_MARGIN_MB = "1024";
  try {
    const manager = require("../server");
    const core = require("../../manager-core");
    // A permissive body policy would admit far more; the server must replace it.
    const bodyPolicy = { reserveMb: 0, maxUtilizationPct: 99, startupMarginMb: 0 };
    const capped = await manager.buildServerMemoryEstimate(flashNextBody({ admissionPolicy: bodyPolicy }));
    assert.equal(capped.plan.admissionPreview.availableMb, 89095);
    assert.equal(capped.plan.admissionPreview.verdict, "warn");

    const routes = new Map();
    const app = {
      get(route, handler) { routes.set(`GET ${route}`, handler); },
      post(route, handler) { routes.set(`POST ${route}`, handler); },
      delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
    };
    core.registerManagerRoutes(app, { config: {}, buildMemoryEstimate: manager.buildServerMemoryEstimate });
    const response = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };
    await routes.get("POST /api/memory-estimate")({
      body: flashNextBody({ sglangMaxTotalTokens: 0, admissionPolicy: bodyPolicy }),
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.engine, "sglang");
    assert.equal(response.payload.plan.policy, "static-fraction-of-free");
    assert.equal(response.payload.plan.admissionPreview.verdict, "block");
    assert.equal(response.payload.plan.admissionPreview.maxFraction, 0.915);
    assert.equal(response.payload.plan.status, "fail");
    assert.equal(response.payload.recommendations.status, "fail");
  } finally {
    for (const [name, value] of [
      ["MODEL_GPU_ADMISSION_POLICY_FILE", previous.policyFile],
      ["MODEL_GPU_ADMISSION_ROOT", previous.admissionRoot],
      ["MODEL_GPU_ADMISSION_STARTUP_MARGIN_MB", previous.startupMargin],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fsp.rm(root, { recursive: true, force: true });
  }
});
