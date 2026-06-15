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
    appendLog: (_job, line) => logs.push(line),
    dockerGpuArg: () => "all",
    dockerPublishArgs: (port, _networkAccess, host) => [`${host || "127.0.0.1"}:${port}:8080`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    normalizeGpuIds: (value) => value,
    normalizeDefaultTrueBoolean: (value, fallback) => value ?? fallback,
    resolveLaunchModel: () => ({
      modelArg: "/models/qwen/model.gguf",
      effectiveLoadFormat: "gguf",
      selectedGgufFile: "",
      ggufFiles: [],
    }),
  });

  const { runArgs, activePublishArgs } = buildLlamaRuntimeCommand({}, {
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
    gpuLayers: -1,
    cacheTypeK: "q8_0",
    cacheTypeV: "q8_0",
    flashAttention: "auto",
    reasoning: "auto",
    reasoningFormat: "none",
    noMmap: true,
  });

  assert.deepEqual(activePublishArgs, ["192.168.1.27:8080:8080"]);
  assert.ok(runArgs.includes("--hf-repo"));
  assert.ok(!runArgs.includes("--model"));
  assert.ok(runArgs.includes("NVIDIA_VISIBLE_DEVICES=0,1"));
  assert.ok(runArgs.includes("CUDA_VISIBLE_DEVICES=0,1"));
  assert.ok(runArgs.includes("--tensor-split"));
  assert.ok(runArgs.includes("2,1"));
  assert.ok(runArgs.includes("--no-mmap"));
  assert.ok(logs.some((line) => line.includes("Remote GGUF repo mode")));
  assert.ok(logs.some((line) => line.includes("Heterogeneous GPU split")));
});
