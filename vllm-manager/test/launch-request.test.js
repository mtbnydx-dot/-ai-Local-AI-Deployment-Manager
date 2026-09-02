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
