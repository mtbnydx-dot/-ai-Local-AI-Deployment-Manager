const test = require("node:test");
const assert = require("node:assert/strict");
const { createLlamaRuntimeCommandBuilder } = require("../lib/runtime-command");

test("llama runtime command builds remote GGUF and hetero GPU args", () => {
  const logs = [];
  const { buildLlamaRuntimeCommand } = createLlamaRuntimeCommandBuilder({
    CONFIG: {
      containerName: "llama-local",
      managerId: "llama-manager",
      hfCache: "D:/AI/cache/huggingface",
      modelsRoot: "D:/AI/models",
      image: "ghcr.io/ggml-org/llama.cpp@sha256:test",
    },
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: (_job, line) => logs.push(line),
    dockerGpuArg: () => "all",
    dockerPublishArgs: (port, _networkAccess, host) => [`${host || "127.0.0.1"}:${port}:8080`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    normalizeGpuIds: (value) => value,
    normalizeDefaultTrueBoolean: (value, fallback) => value ?? fallback,
    windowsPathToContainerPath: (value) => String(value).replace("D:/AI/models", "/models").replaceAll("\\", "/"),
    resolveLaunchModel: () => ({
      modelArg: "/models/qwen/model.gguf",
      effectiveLoadFormat: "gguf",
      selectedGgufFile: "",
      ggufFiles: [],
    }),
  });

  const { runArgs, activePublishArgs } = buildLlamaRuntimeCommand({ id: "serve-test" }, {
    model: "user/qwen-gguf",
    port: 8080,
    networkAccess: "lan",
    serviceHost: "192.168.1.27",
    gpuDeviceIds: ["0", "1"],
    textOnlyMode: true,
    languageModelOnly: true,
    multiGpuMode: "layer",
    tensorSplit: "2,1",
    mainGpu: 0,
    gpuPlan: { summary: "2:1 split", mainGpuHostId: "0" },
    name: "qwen-gguf",
    maxModelLen: 131072,
    maxNumSeqs: 1,
    batchSize: 4096,
    ubatchSize: 1024,
    gpuLayers: "auto",
    fitTargetMb: 8192,
    fitCtx: 131072,
    gpuMemoryUtilization: 0.5,
    vramReservationMb: 10000,
    gpuAdmissionLeaseId: "lease-llama",
    cacheTypeK: "q8_0",
    cacheTypeV: "q8_0",
    flashAttention: "auto",
    reasoning: "auto",
    reasoningFormat: "none",
    reasoningEffort: "high",
    reasoningBudget: 2048,
    mmprojDevice: "auto",
    noMmap: true,
    noRepack: true,
  });

  assert.deepEqual(activePublishArgs, ["192.168.1.27:8080:8080"]);
  assert.ok(runArgs.includes("--hf-repo"));
  assert.ok(!runArgs.includes("--model"));
  assert.ok(runArgs.includes("--no-mmproj"));
  assert.ok(runArgs.includes("NVIDIA_VISIBLE_DEVICES=0,1"));
  assert.ok(runArgs.includes("CUDA_VISIBLE_DEVICES=0,1"));
  assert.ok(runArgs.includes("--tensor-split"));
  assert.ok(runArgs.includes("2,1"));
  assert.ok(runArgs.includes("--no-mmap"));
  assert.ok(runArgs.includes("--no-repack"));
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--fit"), runArgs.indexOf("--fit") + 4), ["--fit", "on", "--fit-target", "8192"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--fit-ctx"), runArgs.indexOf("--fit-ctx") + 2), ["--fit-ctx", "131072"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--n-gpu-layers"), runArgs.indexOf("--n-gpu-layers") + 2), ["--n-gpu-layers", "auto"]);
  assert.ok(runArgs.includes("ai.manager.gpu-ids=0,1"));
  assert.ok(runArgs.includes("ai.manager.vram-reservation-mb=10000"));
  assert.ok(runArgs.includes("ai.manager.gpu-admission-lease=lease-llama"));
  assert.ok(runArgs.includes("ai.manager.job=serve-test"));
  assert.ok(runArgs.includes("ai.manager.text-only=true"));
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--reasoning-effort"), runArgs.indexOf("--reasoning-effort") + 2), ["--reasoning-effort", "high"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--reasoning-budget"), runArgs.indexOf("--reasoning-budget") + 2), ["--reasoning-budget", "2048"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--ctx-size"), runArgs.indexOf("--ctx-size") + 2), ["--ctx-size", "131072"]);
  assert.ok(logs.some((line) => line.includes("Remote GGUF repo mode")));
  assert.ok(logs.some((line) => line.includes("Heterogeneous GPU split")));
});

test("llama runtime command loads mmproj, protects API keys, and enables checkpoint MTP", () => {
  const { buildLlamaRuntimeCommand, redactDockerArgs } = createLlamaRuntimeCommandBuilder({
    CONFIG: { containerName: "llama-local", managerId: "llama-manager", hfCache: "D:/cache", modelsRoot: "D:/AI/models", image: "llama:pinned" },
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: () => {},
    dockerGpuArg: () => "device=0",
    dockerPublishArgs: () => ["127.0.0.1:8080:8080"],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    normalizeGpuIds: (value) => value,
    normalizeDefaultTrueBoolean: (value, fallback) => value ?? fallback,
    windowsPathToContainerPath: (value) => String(value).replace("D:/AI/models", "/models").replaceAll("\\", "/"),
    resolveLaunchModel: () => ({
      modelArg: "/models/qwen/model.gguf",
      effectiveLoadFormat: "gguf",
      selectedGgufFile: "D:/AI/models/qwen/model.gguf",
      ggufFiles: [
        { path: "D:/AI/models/qwen/model.gguf", size: 1000 },
        { path: "D:/AI/models/qwen/mmproj-F16.gguf", size: 100 },
      ],
    }),
  });
  const opts = {
    model: "D:/AI/models/qwen/model-MTP.gguf",
    port: 8080,
    networkAccess: "local",
    serviceHost: "127.0.0.1",
    gpuDeviceIds: ["0"],
    textOnlyMode: false,
    languageModelOnly: false,
    multiGpuMode: "none",
    mainGpu: 0,
    name: "qwen-mtp",
    maxModelLen: 32768,
    maxNumSeqs: 4,
    batchSize: 2048,
    ubatchSize: 512,
    gpuLayers: -1,
    cacheTypeK: "q8_0",
    cacheTypeV: "q8_0",
    flashAttention: "auto",
    reasoning: "auto",
    reasoningFormat: "auto",
    reasoningEffort: "medium",
    reasoningBudget: 4096,
    mmprojDevice: "CUDA0",
    speculativeMode: "auto",
    numSpeculativeTokens: 5,
    llamaApiKey: "llama-secret",
    runtimeApiKeyRef: "runtime-secret-ref",
  };
  const { runArgs } = buildLlamaRuntimeCommand({}, opts);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--ctx-size"), runArgs.indexOf("--ctx-size") + 2), ["--ctx-size", "131072"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--mmproj"), runArgs.indexOf("--mmproj") + 2), ["--mmproj", "/models/qwen/mmproj-F16.gguf"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--mmproj-device"), runArgs.indexOf("--mmproj-device") + 2), ["--mmproj-device", "CUDA0"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--spec-type"), runArgs.indexOf("--spec-type") + 2), ["--spec-type", "draft-mtp"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--spec-draft-n-max"), runArgs.indexOf("--spec-draft-n-max") + 2), ["--spec-draft-n-max", "5"]);
  assert.ok(redactDockerArgs(runArgs, opts).join(" ").includes("***"));
  assert.ok(!redactDockerArgs(runArgs, opts).join(" ").includes("llama-secret"));
  assert.ok(runArgs.includes("ai.manager.api-key-ref=runtime-secret-ref"));
  assert.ok(!runArgs.some((arg) => String(arg).startsWith("ai.manager.api-key=llama-secret")));
});

test("llama runtime command auto-loads Muse mmproj and DFlash draft together", () => {
  const logs = [];
  const launch = {
    modelArg: "/models/muse/muse-glimmer-dynamic.gguf",
    effectiveLoadFormat: "gguf",
    selectedGgufFile: "D:/AI/models/muse/muse-glimmer-dynamic.gguf",
    selectedModel: { path: "D:/AI/models/muse/muse-glimmer-dynamic.gguf", architecture: "muse-glimmer" },
    ggufFiles: [],
    ggufInventory: { models: [{}, {}] },
    mmprojFiles: [{ path: "D:/AI/models/muse/mmproj-kquant.gguf", architecture: "clip" }],
    draftFiles: [{ path: "D:/AI/models/muse/dflash-kquant.gguf", architecture: "dflash" }],
  };
  const { buildLlamaRuntimeCommand } = createLlamaRuntimeCommandBuilder({
    CONFIG: {
      containerName: "llama-local",
      managerId: "llama-manager",
      hfCache: "D:/cache",
      modelsRoot: "D:/AI/models",
      image: "llama:regular",
      museImage: "local/llama.cpp:server-cuda-muse-62bf73d",
    },
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: (_job, line) => logs.push(line),
    dockerGpuArg: () => "device=0",
    dockerPublishArgs: () => ["127.0.0.1:8080:8080"],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    normalizeGpuIds: (value) => value,
    normalizeDefaultTrueBoolean: (value, fallback) => value ?? fallback,
    windowsPathToContainerPath: (value) => String(value).replace("D:/AI/models", "/models").replaceAll("\\", "/"),
    resolveLaunchModel: () => launch,
  });
  const { runArgs, runtimeImage } = buildLlamaRuntimeCommand({}, {
    model: "D:/AI/models/muse",
    launch,
    port: 8080,
    networkAccess: "local",
    serviceHost: "127.0.0.1",
    gpuDeviceIds: ["0"],
    textOnlyMode: false,
    languageModelOnly: false,
    multiGpuMode: "none",
    mainGpu: 0,
    name: "muse-glimmer",
    maxModelLen: 131072,
    maxNumSeqs: 1,
    batchSize: 2048,
    ubatchSize: 512,
    gpuLayers: "all",
    cacheTypeK: "q8_0",
    cacheTypeV: "q8_0",
    flashAttention: "auto",
    reasoning: "auto",
    reasoningFormat: "auto",
    speculativeMode: "auto",
    numSpeculativeTokens: 3,
  });
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--mmproj"), runArgs.indexOf("--mmproj") + 2), ["--mmproj", "/models/muse/mmproj-kquant.gguf"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--spec-type"), runArgs.indexOf("--spec-type") + 2), ["--spec-type", "draft-dflash"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--model-draft"), runArgs.indexOf("--model-draft") + 2), ["--model-draft", "/models/muse/dflash-kquant.gguf"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--spec-draft-n-max"), runArgs.indexOf("--spec-draft-n-max") + 2), ["--spec-draft-n-max", "3"]);
  assert.equal(runtimeImage, "local/llama.cpp:server-cuda-muse-62bf73d");
  assert.ok(runArgs.includes("local/llama.cpp:server-cuda-muse-62bf73d"));
  assert.ok(!runArgs.includes("llama:regular"));
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--temp"), runArgs.indexOf("--temp") + 2), ["--temp", "1"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--top-p"), runArgs.indexOf("--top-p") + 2), ["--top-p", "0.95"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--top-k"), runArgs.indexOf("--top-k") + 2), ["--top-k", "64"]);
  assert.ok(runArgs.includes("ai.manager.cache-type-k=q8_0"));
  assert.ok(runArgs.includes("ai.manager.cache-type-v=q8_0"));
  assert.ok(runArgs.includes("ai.manager.speculative-mode=draft-dflash"));
  assert.ok(logs.some((line) => line.includes("DFlash draft model")));
  assert.ok(logs.some((line) => line.includes("Muse Glimmer runtime image")));
  assert.ok(logs.some((line) => line.includes("sampling defaults")));
});
