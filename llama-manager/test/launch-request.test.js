const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  LLAMA_CONTEXT_ESTIMATE_MAX_MB,
  createLlamaStartRuntimeRequest,
  estimateLlamaParallelVram,
} = require("../lib/launch-request");

function testU32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(Number(value));
  return buffer;
}

function testU64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function testGgufString(value) {
  const content = Buffer.from(String(value));
  return Buffer.concat([testU64(content.length), content]);
}

function testGguf(metadata, tensorElements = 1000, padding = 0) {
  const kv = [];
  for (const [key, value] of Object.entries(metadata)) {
    let type;
    let encoded;
    if (typeof value === "string") {
      type = 8;
      encoded = testGgufString(value);
    } else if (Array.isArray(value)) {
      type = 9;
      encoded = Buffer.concat([testU32(7), testU64(value.length), ...value.map((item) => Buffer.from([item ? 1 : 0]))]);
    } else {
      type = 4;
      encoded = testU32(value);
    }
    kv.push(testGgufString(key), testU32(type), encoded);
  }
  return Buffer.concat([
    Buffer.from("GGUF"), testU32(3), testU64(1), testU64(Object.keys(metadata).length),
    ...kv,
    testGgufString("weight"), testU32(1), testU64(tensorElements), testU32(0), testU64(0),
    Buffer.alloc(padding),
  ]);
}

function testMuseMetadata(architecture = "muse-glimmer") {
  if (architecture !== "muse-glimmer") return { "general.architecture": architecture, "general.type": architecture === "clip" ? "projector" : "model" };
  return {
    "general.architecture": architecture,
    "general.type": "model",
    "muse-glimmer.block_count": 52,
    "muse-glimmer.context_length": 131072,
    "muse-glimmer.embedding_length": 6656,
    "muse-glimmer.attention.head_count": 32,
    "muse-glimmer.attention.head_count_kv": 2,
    "muse-glimmer.attention.key_length": 128,
    "muse-glimmer.attention.value_length": 128,
    "muse-glimmer.attention.sliding_window": 2048,
    "muse-glimmer.attention.sliding_window_pattern": Array.from({ length: 52 }, (_, index) => index % 4 !== 3),
  };
}

test("llama launch request keeps hetero GPU plan and tensor split in sync", async () => {
  const runCalls = [];
  const admissionEvents = [];
  const secretEvents = [];
  const failedJobs = [];
  let runtimeError = null;
  const request = createLlamaStartRuntimeRequest({
    CONFIG: { defaultPort: 8080, containerName: "llama-local", managerId: "llama-manager" },
    cleanRequired: (value, name) => {
      if (!value) throw new Error(`${name} required`);
      return String(value);
    },
    deriveName: (model) => model.split(/[\\/]/).pop(),
    positiveInt: (value, fallback) => Number(value || fallback),
    normalizeGpuLayers: (value) => value === "auto" ? "auto" : (value == null || value === "" ? -1 : Number(value)),
    normalizeLlamaCacheType: (value) => value || "q8_0",
    normalizeOnOffAuto: (value) => value || "auto",
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: ["hetero"] }),
    normalizeGpuIds: (value) => String(value || "").split(",").filter(Boolean),
    normalizeLlamaSplitMode: (value) => value || "layer",
    cleanOptionalLaunchArg: (value) => String(value || "").trim(),
    normalizeClientPreset: (value) => value || "openai",
    normalizeLlamaReasoningFormat: (value) => value || "none",
    normalizeDefaultTrueBoolean: (value) => value !== false,
    normalizeNetworkAccess: (value) => value || "local",
    getLanAddress: () => "192.168.1.27",
    getGpuStatus: async () => ({ gpus: [{ id: "0" }, { id: "1" }] }),
    buildLlamaGpuPlan: () => ({ mainGpu: "0", mainGpuHostId: "host-0" }),
    suggestTensorSplit: () => "2,1",
    createJob: (type, title, meta) => ({ id: "serve-llama", type, title, meta }),
    runStartJob: (job, options) => {
      runCalls.push(options);
      if (runtimeError) return Promise.reject(runtimeError);
      job.status = "success";
      return Promise.resolve();
    },
    failJob: (job, error) => failedJobs.push([job, error]),
    saveRuntimeApiKey: async (secret) => { secretEvents.push(["save", secret]); return `ref-${secret}`; },
    deleteRuntimeApiKey: async (reference) => secretEvents.push(["delete", reference]),
    estimateParallelVram: async () => ({
      requestedMb: 10000,
      requestedMbByGpu: { "0": 5000, "1": 5000 },
      estimatePolicy: "test_local_gguf_estimate",
    }),
    acquireGpuAdmission: async (input) => {
      admissionEvents.push(["acquire", input]);
      return {
        summary: { id: "lease-llama", requestedTotalMb: 10000, reservations: [{ gpuId: "GPU-A", gpuIndex: "0", requestedMb: 5000 }, { gpuId: "GPU-B", gpuIndex: "1", requestedMb: 5000 }] },
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
      model: "D:/AI/models/model.gguf",
      instanceMode: "parallel",
      instanceId: "vision",
      port: "8180",
      gpuDeviceIds: "0,1",
      multiGpuMode: "layer",
      networkAccess: "lan",
      reasoning: "on",
      reasoningEffort: "high",
      reasoningBudget: "2048",
      mmproj: "D:/AI/models/mmproj.gguf",
      mmprojDevice: "CUDA0",
      speculativeMode: "draft-mtp",
      numSpeculativeTokens: "4",
      gpuLayers: "auto",
      fitTargetMb: 4096,
      fitCtx: 8192,
      apiKey: "llama-key",
    },
  });

  assert.equal(result.job.id, "serve-llama");
  assert.equal(result.job.meta.tensorSplit, "2,1");
  assert.equal(result.job.meta.port, 8180);
  assert.equal(result.job.meta.mainGpu, "0");
  assert.equal(result.job.meta.mainGpuHostId, "host-0");
  assert.equal(result.job.meta.serviceUrl, "http://192.168.1.27:8180/v1");
  assert.equal(runCalls[0].tensorSplit, "2,1");
  assert.equal(runCalls[0].reasoning, "on");
  assert.equal(runCalls[0].reasoningEffort, "high");
  assert.equal(runCalls[0].reasoningBudget, 2048);
  assert.equal(runCalls[0].cacheReuse, 512);
  assert.equal(result.job.meta.cacheReuse, 512);
  assert.equal(runCalls[0].mmproj, "D:/AI/models/mmproj.gguf");
  assert.equal(runCalls[0].mmprojDevice, "CUDA0");
  assert.equal(runCalls[0].speculativeMode, "draft-mtp");
  assert.equal(runCalls[0].numSpeculativeTokens, 4);
  assert.equal(runCalls[0].llamaApiKey, "llama-key");
  assert.equal(runCalls[0].runtimeApiKeyRef, "ref-llama-key");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admissionEvents[0][0], "acquire");
  assert.deepEqual(admissionEvents[0][1].gpuIds, ["0", "1"]);
  assert.deepEqual(admissionEvents[0][1].requestedMbByGpu, { "0": 5000, "1": 5000 });
  assert.equal(admissionEvents[0][1].requestedFraction, null);
  assert.equal(admissionEvents[0][1].estimatePolicy, "test_local_gguf_estimate");
  assert.equal(runCalls[0].gpuLayers, "auto");
  assert.equal(runCalls[0].fitTargetMb, 4096);
  assert.equal(runCalls[0].fitCtx, 8192);
  assert.equal(result.job.meta.gpuAdmission.id, "lease-llama");
  assert.equal(runCalls[0].vramReservationMb, 10000);
  assert.ok(admissionEvents.some(([event]) => event === "commit"));
  assert.ok(!admissionEvents.some(([event]) => event === "release"));
  assert.deepEqual(secretEvents, [["save", "llama-key"]]);
  await assert.rejects(
    () => request({ body: { model: "D:/AI/models/model.gguf", port: 80 } }),
    (error) => error.status === 400 && /port|端口/i.test(error.message),
  );
  await assert.rejects(
    () => request({ body: { model: "D:/AI/models/model.gguf", port: 8182, batchSize: 128, ubatchSize: 256 } }),
    (error) => error.status === 400 && /ubatchSize/.test(error.message),
  );
  runtimeError = new Error("runtime failed before ready");
  await request({ body: { model: "D:/AI/models/model.gguf", instanceMode: "parallel", instanceId: "failed", port: 8181, gpuDeviceIds: "0", apiKey: "failed-key" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(admissionEvents.some(([event, reason]) => event === "release" && reason === "start-failed"));
  assert.equal(failedJobs.at(-1)[1], runtimeError);
  assert.ok(secretEvents.some(([event, reference]) => event === "delete" && reference === "ref-failed-key"));
});

test("llama parallel VRAM estimate uses local GGUF size and fails closed for remote references", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "llama-vram-estimate-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const model = path.join(root, "model.gguf");
  await fsp.writeFile(model, Buffer.alloc(2 * 1024 * 1024));
  const estimate = await estimateLlamaParallelVram({
    model,
    maxModelLen: 8192,
    maxNumSeqs: 1,
    gpuDeviceIds: ["0", "1"],
    tensorSplit: "2,1",
  });
  assert.equal(estimate.estimatePolicy, "llama_local_gguf_size_plus_bounded_context");
  assert.ok(estimate.requestedMbByGpu["0"] > estimate.requestedMbByGpu["1"]);
  assert.ok(estimate.requestedMbByGpu["1"] >= 4096);
  const largeContext = await estimateLlamaParallelVram({
    model,
    maxModelLen: 131_072,
    maxNumSeqs: 1,
    gpuDeviceIds: ["0"],
  });
  const hugeContext = await estimateLlamaParallelVram({
    model,
    maxModelLen: 4_194_304,
    maxNumSeqs: 1024,
    gpuDeviceIds: ["0"],
  });
  assert.ok(hugeContext.requestedMb > largeContext.requestedMb);
  assert.ok(hugeContext.requestedMb <= LLAMA_CONTEXT_ESTIMATE_MAX_MB + 2050);
  const autoFit = await estimateLlamaParallelVram({
    model,
    maxModelLen: 131_072,
    maxNumSeqs: 1,
    gpuLayers: "auto",
    fitTargetMb: 4096,
    gpuDeviceIds: ["0"],
    gpuPlan: { selected: [{ id: "0", freeMb: 20_000 }] },
  });
  assert.equal(autoFit.estimatePolicy, "llama_auto_fit_free_minus_target");
  assert.deepEqual(autoFit.requestedMbByGpu, { "0": 15_904 });
  assert.equal(autoFit.requestedMb, 15_904);
  await assert.rejects(
    () => estimateLlamaParallelVram({ model: "org/remote-model", maxModelLen: 8192, maxNumSeqs: 1 }),
    (error) => error.code === "vram_estimate_unavailable" && error.status === 422,
  );
});

test("llama VRAM estimate resolves one model variant from a mixed Muse directory", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "llama-muse-estimate-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dynamic = path.join(root, "muse-glimmer-30B-kquant-dynamic.gguf");
  const compact = path.join(root, "muse-glimmer-30B-kquant-17gb.gguf");
  await fsp.writeFile(dynamic, testGguf(testMuseMetadata(), 2_000_000, 4 * 1024 * 1024));
  await fsp.writeFile(compact, testGguf(testMuseMetadata(), 2_000_000, 2 * 1024 * 1024));
  await fsp.writeFile(path.join(root, "mmproj-kquant.gguf"), testGguf(testMuseMetadata("clip"), 20_000, 512));
  await fsp.writeFile(path.join(root, "dflash-kquant.gguf"), testGguf(testMuseMetadata("dflash"), 30_000, 768));

  const full = await estimateLlamaParallelVram({
    model: root,
    maxModelLen: 131072,
    maxNumSeqs: 1,
    cacheTypeK: "f16",
    cacheTypeV: "f16",
    gpuLayers: "all",
    textOnlyMode: false,
    speculativeMode: "draft-dflash",
    gpuDeviceIds: ["0"],
  });
  assert.equal(full.estimatePolicy, "llama_gguf_metadata_layers_kv_sliding_window");
  assert.equal(full.resolvedModel, dynamic);
  assert.ok(full.mmprojMb > 0);
  assert.ok(full.draftMb > 0);
  assert.ok(full.contextMb > 0);

  const halfLayers = await estimateLlamaParallelVram({
    model: compact,
    maxModelLen: 131072,
    maxNumSeqs: 1,
    cacheTypeK: "q8_0",
    cacheTypeV: "q8_0",
    gpuLayers: 26,
    textOnlyMode: true,
    speculativeMode: "off",
  });
  assert.equal(halfLayers.resolvedModel, compact);
  assert.equal(halfLayers.gpuLayerFraction, 0.5);
  assert.equal(halfLayers.mmprojMb, 0);
  assert.equal(halfLayers.draftMb, 0);
  assert.ok(halfLayers.contextMb < full.contextMb);
  assert.ok(halfLayers.modelMb < full.modelMb);
});

test("llama parallel launch never invents a port", async () => {
  const request = createLlamaStartRuntimeRequest({
    CONFIG: { defaultPort: 8080, containerName: "llama-local" },
    cleanRequired: (value) => String(value || "model"),
    deriveName: () => "model",
  });
  await assert.rejects(
    () => request({ body: { model: "model", instanceMode: "parallel", instanceId: "chat" } }),
    (error) => error.status === 400 && /不会自动修改端口/.test(error.message),
  );
});

test("llama replace launch acquires after preparation and deletes its key even if lease release fails", async () => {
  const events = [];
  let finishCleanup;
  const cleanupFinished = new Promise((resolve) => { finishCleanup = resolve; });
  const request = createLlamaStartRuntimeRequest({
    CONFIG: { defaultPort: 8080, containerName: "llama-local", managerId: "llama-manager" },
    cleanRequired: (value) => String(value || "model.gguf"),
    deriveName: () => "model",
    positiveInt: (value, fallback) => Number(value || fallback),
    normalizeGpuLayers: () => -1,
    normalizeLlamaCacheType: () => "q8_0",
    normalizeOnOffAuto: () => "auto",
    normalizeLaunchGpuSelection: async () => ({ gpuDeviceIds: ["0"], selectedCount: 1, warnings: [] }),
    normalizeGpuIds: () => ["0"],
    normalizeLlamaSplitMode: () => "none",
    cleanOptionalLaunchArg: () => "",
    normalizeClientPreset: () => "openai",
    normalizeLlamaReasoningFormat: () => "none",
    normalizeDefaultTrueBoolean: (_value, fallback) => fallback,
    normalizeNetworkAccess: () => "local",
    getLanAddress: () => "127.0.0.1",
    getGpuStatus: async () => ({ gpus: [{ id: "0", totalMb: 24_000, usedMb: 0 }] }),
    buildLlamaGpuPlan: () => ({ mainGpu: 0, mainGpuHostId: "0", selectedGpuIds: ["0"] }),
    suggestTensorSplit: () => "",
    estimateParallelVram: async () => ({
      requestedMb: 9000,
      requestedMbByGpu: { "0": 9000 },
      estimatePolicy: "test-estimate",
    }),
    createJob: (type, title, meta) => ({ id: "replace-job", type, title, meta, status: "running" }),
    runStartJob: async (job, options) => {
      const context = await options.prepareGpuAdmission(async (admissionRequest) => {
        events.push(["prepare", admissionRequest.instanceMode, admissionRequest.requestedFraction, admissionRequest.requestedMb]);
        admissionRequest.retireLeaseIds = ["old-lease"];
        return { marker: "prepared" };
      });
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

  const result = await request({ body: { model: "model.gguf", instanceMode: "replace", apiKey: "secret" } });
  await cleanupFinished;
  assert.equal(result.job.meta.gpuAdmission.id, "new-lease");
  assert.ok(events.some(([event]) => event === "acquire-after-prepare"));
  assert.deepEqual(events.find(([event]) => event === "prepare").slice(1), ["replace", null, 9000]);
  assert.ok(events.some(([event, message]) => event === "warning" && message === "release failed"));
  assert.ok(events.some(([event, reference]) => event === "delete" && reference === "ref-replace"));
});
