const test = require("node:test");
const assert = require("node:assert/strict");
const { PENNYROYAL_DEFAULTS: defaults, PENNYROYAL_IMAGE, createPennyroyalPreset, pennyroyalOptionErrors } = require("../lib/pennyroyal");
const { createVllmRuntimeCommandBuilder } = require("../lib/runtime-command");
const { buildVllmMemoryEstimate } = require("../lib/memory-estimate");

test("Pennyroyal memory plan does not count RAM PLE as GPU weights or invent dense KV", () => {
  const result = buildVllmMemoryEstimate({ ...defaults, paramsB: 300, selectedGpus: [{ totalMb: 97887, freeMb: 94500 }] });
  assert.equal(result.engine, "sglang");
  assert.equal(result.plan.perGpuGb * 1024, 88000);
  assert.match(result.plan.estimatePolicy, /measured/);
  assert.equal(buildVllmMemoryEstimate({ ...defaults, selectedGpus: [{ totalMb: 97887, freeMb: 40000 }] }).plan.status, "fail");
  assert.equal(buildVllmMemoryEstimate({ paramsB: 7 }).engine, "vllm");
});

test("Pennyroyal profile is pinned and rejects unqualified capacity/backend changes", () => {
  assert.deepEqual(pennyroyalOptionErrors(defaults), []);
  for (const override of [
    { runtimeImage: "ghcr.io/jpezzulli/sglang-rtxpro6000:v2.5.1" },
    { kvCacheDtype: "auto" }, { speculativeMode: "dspark" }, { numSpeculativeTokens: 4 },
    { maxModelLen: 1048576 }, { maxNumSeqs: 8 }, { gpuMemoryUtilization: 0.99 },
    { sglangPleOffloadEmbedding: false }, { sglangLinearAttnPrefillBackend: "triton" },
    { sglangFp4GemmBackend: "marlin" }, { tensorParallelSize: 2 }, { kvOffloadingSize: 16 },
  ]) assert.ok(pennyroyalOptionErrors({ ...defaults, ...override }).length, JSON.stringify(override));
});

test("Pennyroyal Docker command retains the proven GPU-only recipe and manager lifecycle", () => {
  const preset = createPennyroyalPreset(defaults);
  const { buildVllmRuntimeCommand } = createVllmRuntimeCommandBuilder({
    CONFIG: { containerName: "vllm-local", managerId: "vllm-manager", hfCache: "D:/AI/cache/hf", modelsRoot: "D:/AI/models", sglangCache: "D:/AI/cache/old", image: "old" },
    MANAGER_LABEL_KEY: "ai.manager", MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine", MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: () => {}, scheduleJobsSave: () => {}, dockerGpuArg: () => "device=0",
    dockerPublishArgs: port => [`127.0.0.1:${port}:8000`], publishArgsToDockerRunArgs: args => args.flatMap(x => ["-p", x]),
    normalizeGpuIds: x => x, getLanAddress: () => "127.0.0.1", windowsPathToContainerPath: x => x,
    getModelMountArgs: () => ["-v", "F:/llm/model:/model-storage/f-models"],
    resolveLaunchModel: () => ({ modelArg: "/model-storage/f-models/OrcaRouter", localPath: "F:/llm/model/OrcaRouter", effectiveLoadFormat: "safetensors" }),
    effectiveLaunchQuantization: () => ({ value: "modelopt_fp4" }), resolveVllmRuntimePreset: () => preset,
  });
  const job = { id: "penny-test", meta: {} };
  const { runArgs } = buildVllmRuntimeCommand(job, { ...defaults, vllmApiKey: "fixture-key", tensorParallelSize: 1 });
  const value = flag => runArgs[runArgs.indexOf(flag) + 1];
  assert.equal(value("--name"), "vllm-local");
  assert.equal(value("--restart"), "no");
  assert.equal(value("--entrypoint"), "sglang");
  assert.ok(runArgs.includes(PENNYROYAL_IMAGE));
  assert.ok(runArgs.includes("ai.manager.engine=sglang"));
  assert.ok(runArgs.includes("ai.runtime.kv-dtype=fp8_e4m3"));
  assert.ok(runArgs.includes("SGLANG_NUMA_BIND_V2=true"));
  assert.ok(runArgs.includes("SGLANG_AUTO_NUMA_BIND=false"));
  assert.ok(runArgs.includes("SGLANG_SM120_ONLINE_MXFP8=true"));
  assert.ok(runArgs.includes("type=volume,source=pennyroyal-orcarouter-v251-compiler,target=/cache"));
  assert.ok(runArgs.includes("F:/llm/model:/model-storage/f-models:ro"));
  assert.equal(value("--port"), "8000");
  assert.equal(value("--context-length"), "524288");
  assert.equal(value("--max-total-tokens"), "524288");
  assert.equal(value("--max-running-requests"), "4");
  assert.equal(value("--kv-cache-dtype"), "fp8_e4m3");
  assert.equal(value("--speculative-algorithm"), "NEXTN");
  assert.equal(value("--speculative-num-steps"), "3");
  assert.equal(value("--speculative-num-draft-tokens"), "4");
  assert.equal(value("--api-key"), "fixture-key");
  assert.ok(runArgs.includes("--ple-offload-embedding"));
  assert.ok(runArgs.includes("--enable-request-time-stats-logging"));
  assert.ok(!runArgs.some(x => x.includes("--hicache") || x.includes("--enable-hierarchical-cache")));
  assert.ok(!runArgs.includes("--disable-radix-cache"));
  assert.equal(JSON.parse(value("--default-chat-template-kwargs")).enable_thinking, true);
  assert.equal(job.meta.engine, "sglang");
  assert.equal(job.meta.kvCacheDtype, "fp8_e4m3");
  assert.equal(job.meta.effectiveMaxRunningRequests, 4);
});

test("Pennyroyal metrics distinguish full KV from Mamba pressure, including zero", () => {
  const manager = require("../server");
  for (const usage of [0, 0.5]) {
    const metrics = manager.parsePrometheusMetrics([
      `sglang:token_usage{model_name="pennyroyal"} 0.95`,
      `sglang:full_token_usage{model_name="pennyroyal"} ${usage}`,
      `sglang:max_total_num_tokens{model_name="pennyroyal"} 524288`,
    ].join("\n"));
    const [model] = manager.buildModelStats(metrics, { pennyroyal: { id: "pennyroyal", max_model_len: 524288 } }, {}, 100, { engine: "sglang", updateSamples: false });
    assert.equal(model.context.kvUsagePercent, usage);
    assert.equal(model.context.activeTokens, Math.round(524288 * usage));
  }
});
