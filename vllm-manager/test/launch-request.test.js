const test = require("node:test");
const assert = require("node:assert/strict");
const { createVllmStartRuntimeRequest, normalizeRuntimeImage } = require("../lib/launch-request");

test("vLLM launch request builds serve job metadata and run options", async () => {
  const runCalls = [];
  const compatibilityCalls = [];
  const admissionEvents = [];
  const secretEvents = [];
  const failedJobs = [];
  let runtimeError = null;
  let cancelNext = false;
  let compatibilityOk = true;
  const request = createVllmStartRuntimeRequest({
    CONFIG: { defaultPort: 8000, containerName: "vllm-local", managerId: "vllm-manager" },
    cleanRequired: (value, name) => {
      if (!value) throw new Error(`${name} required`);
      return String(value);
    },
    deriveName: (model) => model.split("/").pop(),
    positiveInt: (value, fallback) => Number(value || fallback),
    nonNegativeNumber: (value, fallback) => Math.max(0, Number(value || fallback)),
    optionalNonNegativeNumber: (value) => (value == null || value === "" ? null : Math.max(0, Number(value))),
    normalizeDtype: (value) => value || "auto",
    normalizeQuantization: (value) => value || "",
    normalizeLoadFormat: (value) => value || "auto",
    cleanOptionalLaunchArg: (value) => String(value || "").trim(),
    normalizeKvCacheDtype: (value) => value || "auto",
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: ["mixed GPUs"] }),
    normalizeGpuIds: (value) => String(value || "").split(",").filter(Boolean),
    normalizeClientPreset: (value) => value || "openai",
    normalizeReasoningParser: (value) => value || "",
    normalizeToolCallParser: (value) => value || "",
    inferToolCallParser: () => "qwen3_coder",
    normalizeNetworkAccess: (value) => value || "local",
    normalizeSpeculativeMode: (value) => value || "off",
    checkModelCompatibility: async (input) => {
      compatibilityCalls.push(input);
      return compatibilityOk
        ? { ok: true, findings: [] }
        : { ok: false, findings: [{ severity: "fail", title: "Muse Glimmer 尚不支持 vLLM", detail: "Use llama-manager to launch the local GGUF variant instead." }] };
    },
    getLanAddress: () => "192.168.1.27",
    createJob: (type, title, meta) => ({ id: "serve-1", type, title, meta }),
    runStartJob: (job, options) => {
      runCalls.push(options);
      if (runtimeError) return Promise.reject(runtimeError);
      if (cancelNext) {
        job.status = "failed";
        return Promise.resolve();
      }
      job.status = "success";
      return Promise.resolve();
    },
    failJob: (job, error) => failedJobs.push([job, error]),
    saveRuntimeApiKey: async (secret) => { secretEvents.push(["save", secret]); return `ref-${secret}`; },
    deleteRuntimeApiKey: async (reference) => secretEvents.push(["delete", reference]),
    acquireGpuAdmission: async (input) => {
      admissionEvents.push(["acquire", input]);
      return {
        summary: { id: "lease-vllm", requestedTotalMb: 12000, reservations: [{ gpuId: "GPU-A", gpuIndex: "0", requestedMb: 6000 }, { gpuId: "GPU-B", gpuIndex: "1", requestedMb: 6000 }] },
        startHeartbeat: () => {
          admissionEvents.push(["heartbeat-start"]);
          return () => admissionEvents.push(["heartbeat-stop"]);
        },
        commit: async (metadata) => admissionEvents.push(["commit", metadata]),
        release: async (reason) => admissionEvents.push(["release", reason]),
      };
    },
  });

  const result = await request({
    body: {
      model: "Qwen/Qwen3.6-27B",
      instanceMode: "parallel",
      instanceId: "code",
      port: "8123",
      maxModelLen: "262144",
      maxNumSeqs: "4",
      maxNumBatchedTokens: "16384",
      gpuDeviceIds: "0,1",
      multiGpuMode: "tensor",
      tensorParallelSize: "2",
      toolCallParser: "auto",
      clientPreset: "claude",
      enableAutoToolChoice: true,
      networkAccess: "lan",
      apiKey: "sk-local",
      speculativeMode: "auto",
      numSpeculativeTokens: "2",
      engine: "sglang",
      runtimeImage: "lmsysorg/sglang@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      draftModel: "D:/AI/models/RadixArk-Qwen3.8-27B-DSpark",
      dsparkBlockSize: "9",
      sglangMaxTotalTokens: "262144",
      sglangPageSize: "64",
      sglangChunkedPrefillSize: "4096",
      sglangFp4GemmBackend: "flashinfer_cutlass",
      sglangAttentionBackend: "triton",
      sglangPleOffloadEmbedding: true,
      sglangLinearAttnPrefillBackend: "triton",
      sglangLinearAttnDecodeBackend: "flashinfer",
      sglangMambaSsmDtype: "bfloat16",
      sglangMambaRadixCacheStrategy: "extra_buffer",
      sglangMambaTrackInterval: "64",
      sglangMaxMambaCacheSize: "8",
      sglangDisableThinkingByDefault: true,
    },
  });

  assert.equal(result.job.id, "serve-1");
  assert.equal(result.job.meta.tensorParallelSize, 2);
  assert.equal(result.job.meta.port, 8123);
  assert.equal(result.job.meta.maxModelLen, 262144);
  assert.equal(result.job.meta.maxNumSeqs, 4);
  assert.equal(result.job.meta.maxNumBatchedTokens, 16384);
  assert.equal(result.job.meta.toolCallParser, "qwen3_coder");
  assert.equal(result.job.meta.enableAutoToolChoice, true);
  assert.equal(result.job.meta.hasApiKey, true);
  assert.equal(result.job.meta.serviceHost, "192.168.1.27");
  assert.equal(runCalls[0].vllmApiKey, "sk-local");
  assert.equal(runCalls[0].runtimeApiKeyRef, "ref-sk-local");
  assert.equal(runCalls[0].serviceUrl, "http://192.168.1.27:8123/v1");
  assert.equal(runCalls[0].speculativeMode, "auto");
  assert.equal(runCalls[0].numSpeculativeTokens, 2);
  assert.equal(runCalls[0].maxNumBatchedTokens, 16384);
  assert.equal(runCalls[0].engine, "sglang");
  assert.equal(runCalls[0].runtimeImage, "lmsysorg/sglang@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(runCalls[0].draftModel, "D:/AI/models/RadixArk-Qwen3.8-27B-DSpark");
  assert.equal(runCalls[0].dsparkBlockSize, 9);
  assert.equal(runCalls[0].sglangMaxTotalTokens, 262144);
  assert.equal(runCalls[0].sglangPageSize, 64);
  assert.equal(runCalls[0].sglangChunkedPrefillSize, 4096);
  assert.equal(runCalls[0].sglangFp4GemmBackend, "flashinfer_cutlass");
  assert.equal(runCalls[0].sglangAttentionBackend, "triton");
  assert.equal(runCalls[0].sglangPleOffloadEmbedding, true);
  assert.equal(runCalls[0].sglangLinearAttnPrefillBackend, "triton");
  assert.equal(runCalls[0].sglangLinearAttnDecodeBackend, "flashinfer");
  assert.equal(runCalls[0].sglangMambaSsmDtype, "bfloat16");
  assert.equal(runCalls[0].sglangMambaRadixCacheStrategy, "extra_buffer");
  assert.equal(runCalls[0].sglangMambaTrackInterval, 64);
  assert.equal(runCalls[0].sglangMaxMambaCacheSize, 8);
  assert.equal(runCalls[0].sglangDisableThinkingByDefault, true);
  assert.equal(result.job.meta.engine, "sglang");
  assert.equal(compatibilityCalls[0].remote, false);
  assert.equal(compatibilityCalls[0].model, "Qwen/Qwen3.6-27B");
  assert.equal(compatibilityCalls[0].engine, "sglang");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admissionEvents[0][0], "acquire");
  assert.deepEqual(admissionEvents[0][1].gpuIds, ["0", "1"]);
  assert.equal(result.job.meta.gpuAdmission.id, "lease-vllm");
  assert.equal(runCalls[0].vramReservationMb, 12000);
  assert.ok(admissionEvents.some(([event]) => event === "commit"));
  assert.ok(!admissionEvents.some(([event]) => event === "release"));
  assert.deepEqual(secretEvents, [["save", "sk-local"]]);
  runtimeError = new Error("runtime failed before ready");
  runtimeError.code = "VLLM_RUNTIME_INCOMPATIBLE";
  runtimeError.findings = [{ severity: "FAIL", title: "GPU 0", detail: "SM is unsupported" }];
  const failedResult = await request({ body: { model: "Qwen/Qwen3.6-27B", instanceMode: "parallel", instanceId: "failed", port: 8124, gpuDeviceIds: "0", apiKey: "failed-key" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(admissionEvents.some(([event, reason]) => event === "release" && reason === "start-failed"));
  assert.equal(failedJobs.at(-1)[1], runtimeError);
  assert.equal(failedResult.job.meta.errorCode, "vllm_runtime_incompatible");
  assert.deepEqual(failedResult.job.meta.findings, [{ severity: "fail", title: "GPU 0", detail: "SM is unsupported" }]);
  assert.ok(secretEvents.some(([event, reference]) => event === "delete" && reference === "ref-failed-key"));
  runtimeError = null;
  const { PENNYROYAL_DEFAULTS } = require("../lib/pennyroyal");
  await request({ body: { ...PENNYROYAL_DEFAULTS, model: "fixture-OrcaRouter-Qwen3.8-Flash-Next-NVFP4", instanceMode: "parallel", instanceId: "penny", port: 8126 } });
  await new Promise((resolve) => setImmediate(resolve));
  const pennyAdmission = admissionEvents.filter(([event]) => event === "acquire").at(-1)[1];
  assert.equal(pennyAdmission.requestedMb, 88000);
  assert.equal(pennyAdmission.requestedFraction, undefined);
  assert.equal(pennyAdmission.estimatePolicy, "pennyroyal_v251_sm120_tp1_524k_measured");
  cancelNext = true;
  await request({ body: { model: "Qwen/Qwen3.6-27B", instanceMode: "parallel", instanceId: "cancelled", port: 8125, gpuDeviceIds: "0" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(admissionEvents.some(([event, reason]) => event === "release" && reason === "job-failed"));
  cancelNext = false;
  compatibilityOk = false;
  await assert.rejects(
    () => request({ body: { model: "D:/models/muse-glimmer" } }),
    (error) => error.status === 422
      && error.code === "muse_glimmer_vllm_unsupported"
      && /Muse Glimmer/.test(error.message)
      && /llama-manager/.test(error.message),
  );
});

test("runtime image overrides accept Docker references and reject injected options", () => {
  assert.equal(normalizeRuntimeImage("vllm/vllm-openai@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "vllm/vllm-openai@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.throws(() => normalizeRuntimeImage("image:tag --privileged"), (error) => error.status === 400);
});

test("vLLM parallel launch never invents a port", async () => {
  const request = createVllmStartRuntimeRequest({
    CONFIG: { defaultPort: 8000, containerName: "vllm-local" },
    cleanRequired: (value) => String(value || "model"),
    deriveName: () => "model",
  });
  await assert.rejects(
    () => request({ body: { model: "model", instanceMode: "parallel", instanceId: "code" } }),
    (error) => error.status === 400 && /不会自动修改端口/.test(error.message),
  );
});

test("vLLM parallel launch binds an implicit GPU selection to the admitted device", async () => {
  let runOptions;
  const request = createVllmStartRuntimeRequest({
    CONFIG: { defaultPort: 8000, containerName: "vllm-local", managerId: "vllm-manager" },
    cleanRequired: (value) => String(value || "model"),
    deriveName: () => "model",
    positiveInt: (value, fallback) => Number(value || fallback),
    nonNegativeNumber: (value, fallback) => Number(value || fallback),
    optionalNonNegativeNumber: () => null,
    normalizeDtype: () => "auto",
    normalizeQuantization: () => "",
    normalizeLoadFormat: () => "auto",
    cleanOptionalLaunchArg: () => "",
    normalizeKvCacheDtype: () => "auto",
    normalizeLaunchGpuSelection: async () => ({ gpuDeviceIds: [], selectedCount: 2, warnings: [] }),
    normalizeGpuIds: () => [],
    normalizeClientPreset: () => "openai",
    normalizeReasoningParser: () => "",
    normalizeToolCallParser: () => "",
    inferToolCallParser: () => "",
    normalizeNetworkAccess: () => "local",
    getLanAddress: () => "127.0.0.1",
    createJob: (type, title, meta) => ({ id: "serve-implicit", type, title, meta }),
    runStartJob: async (job, options) => { runOptions = options; job.status = "success"; },
    failJob: () => {},
    acquireGpuAdmission: async () => ({
      summary: { id: "lease-implicit", requestedTotalMb: 8000, reservations: [{ gpuId: "GPU-A", gpuIndex: "0", requestedMb: 8000 }] },
      startHeartbeat: () => () => {},
      commit: async () => {},
      release: async () => {},
    }),
  });
  const result = await request({ body: { model: "model", instanceMode: "parallel", port: 8126 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(result.job.meta.gpuDeviceIds, ["0"]);
  assert.deepEqual(runOptions.gpuDeviceIds, ["0"]);
  assert.equal(result.job.meta.gpuMemoryUtilization, 0.7);
});

test("vLLM replace launch acquires after preparation and deletes its key even if lease release fails", async () => {
  const events = [];
  let finishCleanup;
  const cleanupFinished = new Promise((resolve) => { finishCleanup = resolve; });
  const request = createVllmStartRuntimeRequest({
    CONFIG: { defaultPort: 8000, containerName: "vllm-local", managerId: "vllm-manager" },
    cleanRequired: (value) => String(value || "model"),
    deriveName: () => "model",
    positiveInt: (value, fallback) => Number(value || fallback),
    nonNegativeNumber: (value, fallback) => Number(value || fallback),
    optionalNonNegativeNumber: () => null,
    normalizeDtype: () => "auto",
    normalizeQuantization: () => "",
    normalizeLoadFormat: () => "auto",
    cleanOptionalLaunchArg: () => "",
    normalizeKvCacheDtype: () => "auto",
    normalizeLaunchGpuSelection: async () => ({ gpuDeviceIds: ["0"], selectedCount: 1, warnings: [] }),
    normalizeGpuIds: () => ["0"],
    normalizeClientPreset: () => "openai",
    normalizeReasoningParser: () => "",
    normalizeToolCallParser: () => "",
    inferToolCallParser: () => "",
    normalizeNetworkAccess: () => "local",
    getLanAddress: () => "127.0.0.1",
    createJob: (type, title, meta) => ({ id: "replace-job", type, title, meta, status: "running" }),
    runStartJob: async (job, options) => {
      assert.equal(options.gpuAdmissionFinalized, false);
      const context = await options.prepareGpuAdmission(async (admissionRequest) => {
        events.push(["prepare", admissionRequest.instanceMode]);
        admissionRequest.retireLeaseIds = ["old-lease"];
        return { marker: "prepared" };
      });
      assert.equal(options.gpuAdmissionFinalized, true);
      assert.deepEqual(options.gpuDeviceIds, ["0"]);
      events.push(["context", context.marker]);
      job.status = "failed";
    },
    failJob: () => {},
    saveRuntimeApiKey: async () => "ref-replace",
    deleteRuntimeApiKey: async (reference) => {
      events.push(["delete", reference]);
      finishCleanup();
    },
    reportGpuAdmissionError: (_job, error) => events.push(["warning", error.message]),
    acquireGpuAdmission: async () => { throw new Error("replace must not acquire before preparation"); },
    acquireGpuAdmissionAfterPrepare: async (admissionRequest, prepare) => {
      const context = await prepare(admissionRequest);
      events.push(["acquire-after-prepare", admissionRequest.retireLeaseIds]);
      return {
        context,
        lease: {
          summary: { id: "new-lease", requestedTotalMb: 9000, reservations: [{ gpuId: "0", gpuIndex: "0", requestedMb: 9000 }] },
          startHeartbeat: () => () => events.push(["heartbeat-stop"]),
          commit: async () => events.push(["commit"]),
          release: async () => {
            events.push(["release"]);
            throw new Error("release failed");
          },
        },
      };
    },
  });

  const result = await request({ body: { model: "model", instanceMode: "replace", apiKey: "secret" } });
  await cleanupFinished;
  assert.equal(result.job.meta.gpuAdmission.id, "new-lease");
  assert.ok(events.some(([event]) => event === "acquire-after-prepare"));
  assert.ok(events.some(([event, message]) => event === "warning" && message === "release failed"));
  assert.ok(events.some(([event, reference]) => event === "delete" && reference === "ref-replace"));
});

test("vLLM launch request rejects unsafe numeric values before creating a job", async () => {
  const request = createVllmStartRuntimeRequest({
    CONFIG: { defaultPort: 8000, containerName: "vllm-local" },
    cleanRequired: (value) => String(value || "model"),
    deriveName: () => "model",
  });
  await assert.rejects(
    () => request({ body: { model: "model", maxModelLen: "NaN" } }),
    (error) => error.status === 400 && /maxModelLen/.test(error.message),
  );
  await assert.rejects(
    () => request({ body: { model: "model", gpuMemoryUtilization: "1.5" } }),
    (error) => error.status === 400 && /gpuMemoryUtilization/.test(error.message),
  );
  await assert.rejects(
    () => request({ body: { model: "model", port: 80 } }),
    (error) => error.status === 400 && /port|端口/i.test(error.message),
  );
  await assert.rejects(
    () => request({ body: { model: "model", maxNumSeqs: 2048 } }),
    (error) => error.status === 400 && /maxNumSeqs/.test(error.message),
  );
  await assert.rejects(
    () => request({ body: { model: "model", maxNumBatchedTokens: -1 } }),
    (error) => error.status === 400 && /maxNumBatchedTokens/.test(error.message),
  );
});

test("vLLM prefix caching defaults to enabled unless explicitly disabled", async () => {
  let runOptions;
  const request = createVllmStartRuntimeRequest({
    CONFIG: { defaultPort: 8000, containerName: "vllm-local", managerId: "vllm-manager" },
    cleanRequired: (value) => String(value || "model"),
    deriveName: () => "model",
    positiveInt: (value, fallback) => Number(value || fallback),
    nonNegativeNumber: (value, fallback) => Number(value || fallback),
    optionalNonNegativeNumber: () => null,
    normalizeDtype: () => "auto",
    normalizeQuantization: () => "",
    normalizeLoadFormat: () => "auto",
    cleanOptionalLaunchArg: () => "",
    normalizeKvCacheDtype: () => "auto",
    normalizeLaunchGpuSelection: async () => ({ gpuDeviceIds: ["0"], selectedCount: 1, warnings: [] }),
    normalizeGpuIds: () => ["0"],
    normalizeClientPreset: () => "openai",
    normalizeReasoningParser: () => "",
    normalizeToolCallParser: () => "",
    inferToolCallParser: () => "",
    normalizeNetworkAccess: () => "local",
    normalizeSpeculativeMode: () => "off",
    getLanAddress: () => "127.0.0.1",
    createJob: (type, title, meta) => ({ id: "serve-prefix", type, title, meta }),
    runStartJob: async (job, options) => { runOptions = options; job.status = "success"; },
    failJob: () => {},
    acquireGpuAdmission: async () => ({
      summary: { id: "lease", requestedTotalMb: 1000, reservations: [] },
      startHeartbeat: () => () => {},
      commit: async () => {},
      release: async () => {},
    }),
  });
  const enabled = await request({ body: { model: "model", instanceMode: "parallel", port: 8127 } });
  assert.equal(enabled.job.meta.enablePrefixCaching, true);
  assert.equal(runOptions.enablePrefixCaching, true);
  const disabled = await request({ body: { model: "model", instanceMode: "parallel", port: 8128, enablePrefixCaching: false } });
  assert.equal(disabled.job.meta.enablePrefixCaching, false);
});

function flashNextProfileConfig() {
  const { createVllmDefaultLaunchProfiles } = require("../lib/default-profiles");
  const profile = createVllmDefaultLaunchProfiles((config) => ({ ...config }))
    .find((item) => item.id === "qwen38-flash-next-sglang-262k");
  assert.ok(profile, "Flash-Next 262K default profile exists");
  return profile.config;
}

// Replace-mode launch against the real admission controller and a fake 97887
// MiB GPU: the old model holds most of it until prepare stops it (600 MiB left).
async function launchFlashNextReplacement(body) {
  const fsp = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const core = require("../../manager-core");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "vllm-sglang-admission-"));
  let usedMb = 90000;
  const controller = core.createGpuAdmissionController({
    root,
    reserveMb: 8192,
    maxUtilizationPct: 95,
    startupMarginMb: 1024,
    policyFile: false,
    getGpuStatus: async () => ({ ok: true, gpus: [{ id: "0", totalMb: 97887, usedMb }] }),
  });
  const admissionRequests = [];
  const warnings = [];
  const events = [];
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });
  const request = createVllmStartRuntimeRequest({
    CONFIG: { defaultPort: 8000, containerName: "vllm-local", managerId: "vllm-manager" },
    cleanRequired: (value) => String(value || ""),
    deriveName: () => "model",
    positiveInt: (value, fallback) => Number(value || fallback),
    nonNegativeNumber: (value, fallback) => Number(value || fallback),
    optionalNonNegativeNumber: () => null,
    normalizeDtype: () => "auto",
    normalizeQuantization: (value) => value || "",
    normalizeLoadFormat: () => "auto",
    cleanOptionalLaunchArg: () => "",
    normalizeKvCacheDtype: () => "auto",
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: [] }),
    normalizeGpuIds: (value) => (Array.isArray(value) ? value.map(String) : []),
    normalizeClientPreset: (value) => value || "openai",
    normalizeReasoningParser: (value) => value || "",
    normalizeToolCallParser: (value) => value || "",
    inferToolCallParser: () => "",
    normalizeNetworkAccess: () => "local",
    getLanAddress: () => "127.0.0.1",
    createJob: (type, title, meta) => ({ id: "flash-next", type, title, meta, status: "running" }),
    runStartJob: async (job, options) => {
      await options.prepareGpuAdmission(async () => {
        events.push("old-container-stopped");
        usedMb = 600;
        return {
          async rollback() {
            events.push("old-container-restored");
            usedMb = 90000;
          },
        };
      });
      job.status = "success";
    },
    failJob: (job, error) => {
      job.status = "failed";
      settle({ job, error });
    },
    reportGpuAdmissionError: (_job, error) => warnings.push(error.message),
    acquireGpuAdmission: controller.acquire,
    acquireGpuAdmissionAfterPrepare: async (admissionRequest, prepare) => {
      admissionRequests.push(JSON.parse(JSON.stringify(admissionRequest)));
      return controller.acquireAfterPrepare(admissionRequest, prepare);
    },
  });
  try {
    const { job } = await request({ body });
    const timer = setInterval(() => {
      if (job.status !== "running") settle({ job, error: null });
    }, 5);
    const result = await settled;
    clearInterval(timer);
    // Let the commit or release that follows the job finish before inspecting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { ...result, admissionRequests, warnings, events, state: await controller.inspect() };
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test("Flash-Next 262K default profile is admitted with a clamped warn reservation", async () => {
  const config = flashNextProfileConfig();
  const { job, error, admissionRequests, warnings, events, state } = await launchFlashNextReplacement(config);
  assert.equal(error, null);
  assert.equal(job.status, "success");
  assert.deepEqual(events, ["old-container-stopped"]);

  const [admissionRequest] = admissionRequests;
  assert.equal(admissionRequest.engine, "sglang");
  assert.equal(admissionRequest.instanceMode, "replace");
  assert.equal(admissionRequest.requestedFractionOfFree, 0.995);
  assert.equal(admissionRequest.poolCappedTokens, 262144);
  assert.equal(admissionRequest.minClampMb, 4096);
  assert.equal(admissionRequest.estimatePolicy, "sglang_mem_fraction_static_of_free");
  assert.equal(Object.hasOwn(admissionRequest, "requestedFraction"), false);
  const requestText = JSON.stringify(admissionRequest);
  for (const banned of ["free-fraction", "requestedMbCeiling", "requestedMbFloor", "sglang_bounded_up_to_budget"]) {
    assert.equal(requestText.includes(banned), false, banned);
  }

  assert.deepEqual(job.meta.admission, {
    verdict: "warn",
    requestedMb: 96801,
    reservedMb: 89095,
    availableMb: 89095,
    clamped: true,
    policy: "static-fraction-of-free",
  });
  assert.equal(job.meta.gpuAdmission.verdict, "warn");
  assert.equal(job.meta.gpuAdmission.clamped, true);
  assert.equal(job.meta.gpuAdmission.requestedTotalMb, 89095);
  assert.equal(job.meta.gpuAdmission.reservations[0].requestedMb, 89095);
  assert.equal(job.meta.gpuAdmission.reservations[0].estimateMb, 96801);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^SGLang 静态显存比例按空闲显存折算需要 96801 MiB，超过安全预算 89095 MiB/);
  assert.match(warnings[0], /The KV pool is capped at 262144 tokens/);

  const leases = Object.values(state.leases);
  assert.equal(leases.length, 1);
  assert.equal(leases[0].state, "committed");
  assert.equal(leases[0].reservations[0].requestedMb, 89095);
  assert.equal(leases[0].reservations[0].estimateMb, 96801);
});

test("Flash-Next 262K without a KV pool cap is refused in replace mode and keeps the old model", async () => {
  const { sglangMaxTotalTokens, ...config } = flashNextProfileConfig();
  assert.equal(sglangMaxTotalTokens, 262144);
  const { job, error, admissionRequests, events, state } = await launchFlashNextReplacement(config);
  assert.equal(job.status, "failed");
  assert.equal(admissionRequests[0].poolCappedTokens, 0);
  assert.equal(error.code, "insufficient_vram");
  assert.equal(error.status, 409);
  assert.equal(error.details.mode, "replace");
  assert.equal(error.details.maxFraction, 0.915);
  assert.match(error.message, /^替换启动需要 96801 MiB，安全预算只有 89095 MiB。请把「静态显存比例（mem-fraction-static）」降到 0\.915 以下/);
  assert.match(error.message, /Replacement launch needs 96801 MiB but the safe budget is 89095 MiB\. Lower the static memory fraction \(mem-fraction-static\) to 0\.915 or below/);
  assert.doesNotMatch(error.message, /Parallel|并行/);
  assert.deepEqual(events, ["old-container-stopped", "old-container-restored"]);
  assert.equal(Object.keys(state.leases).length, 0);
  assert.equal(job.meta.admission, undefined);
});
