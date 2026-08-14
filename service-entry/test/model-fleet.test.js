"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fleet = require("../lib/model-fleet");

const vllm = { id: "vllm", name: "vLLM Manager" };
const llama = { id: "llama", name: "llama.cpp Manager" };

test("fleet settings default to multimodal with a bounded safety reserve", () => {
  assert.deepEqual(fleet.normalizeFleetSettings({}), {
    mode: "multimodal",
    reserveMb: 8192,
    maxUtilizationPct: 85,
    preferEngine: "auto",
  });
  assert.deepEqual(fleet.normalizeFleetSettings({ mode: "throughput", reserveMb: 999999, maxUtilizationPct: 0.92 }), {
    mode: "throughput",
    reserveMb: 262144,
    maxUtilizationPct: 92,
    preferEngine: "auto",
  });
  assert.equal(fleet.normalizeFleetSettings({ reserveMb: 0, maxUtilizationPct: 5 }).reserveMb, 0);
  assert.equal(fleet.normalizeFleetSettings({ maxUtilizationPct: 5 }).maxUtilizationPct, 10);
  assert.equal(fleet.normalizeFleetMode("unknown"), "multimodal");
});

test("model capabilities distinguish language, vision, embedding, rerank and audio", () => {
  assert.deepEqual(fleet.inferModelCapabilities({ id: "nvidia-Qwen3.6-27B-NVFP4" }), ["text", "tools"]);
  assert.deepEqual(fleet.inferModelCapabilities({ id: "Qwen3-VL-8B-Instruct" }), ["text", "vision", "tools"]);
  assert.deepEqual(fleet.inferModelCapabilities({ id: "BAAI/bge-m3" }), ["embedding"]);
  assert.deepEqual(fleet.inferModelCapabilities({ id: "BAAI/bge-reranker-v2" }), ["rerank"]);
  assert.deepEqual(fleet.inferModelCapabilities({ id: "openai/whisper-large-v3" }), ["audio"]);
});

test("request capability follows endpoint and structured multimodal content", () => {
  assert.equal(fleet.inferRequestCapability({ route: { rest: "v1/embeddings" }, body: {} }), "embedding");
  assert.equal(fleet.inferRequestCapability({ route: { rest: "v1/rerank" }, body: {} }), "rerank");
  assert.equal(fleet.inferRequestCapability({
    route: { rest: "v1/chat/completions" },
    body: { messages: [{ content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] },
  }), "vision");
  assert.equal(fleet.inferRequestCapability({ route: { rest: "v1/chat/completions" }, body: { tools: [{}] } }), "tools");
});

test("manager instance normalization retains lifecycle state while routing only running models", () => {
  const instances = fleet.normalizeManagerInstances(llama, {
    instances: [
      { id: "primary", primary: true, running: false, status: "Exited (255) 4 weeks ago", models: [{ id: "old" }] },
      { id: "vision", primary: false, running: true, port: 8002, localBaseUrl: "http://127.0.0.1:8002/v1", models: [{ id: "Qwen3-VL-8B" }] },
    ],
  });
  assert.equal(instances.length, 2);
  assert.equal(instances[0].id, "primary");
  assert.equal(instances[0].running, false);
  assert.equal(instances[0].lifecycleState, "crashed");
  assert.equal(instances[1].id, "vision");
  assert.equal(instances[1].fleetId, "llama:vision");
  assert.equal(instances[1].lifecycleState, "ready");
  assert.equal(instances[1].models[0].manager_engine, "llama");
  assert.equal(instances[1].models[0].instance_id, "vision");
  assert.ok(instances[1].models[0].capabilities.includes("vision"));
  assert.deepEqual(fleet.flattenCatalogModels(instances).map((model) => model.id), ["Qwen3-VL-8B"]);
});

test("loading, degraded and stopped instances never leak through a stale catalog model list", () => {
  for (const lifecycleState of ["loading", "degraded", "stopped"]) {
    const instance = {
      id: `vllm:${lifecycleState}`,
      instanceId: lifecycleState,
      running: lifecycleState !== "stopped",
      lifecycleState,
      models: [{ id: `${lifecycleState}-model`, capabilities: ["text"] }],
    };
    assert.deepEqual(fleet.flattenCatalogModels([instance]), []);
    const staleCatalog = {
      manager: vllm,
      listening: true,
      running: true,
      instances: [instance],
      models: [{ id: `${lifecycleState}-model`, instance_id: lifecycleState, capabilities: ["text"] }],
    };
    const target = fleet.selectFleetTarget([staleCatalog], {
      engine: "auto",
      protocol: "openai",
      path: "v1/chat/completions",
      body: { model: `${lifecycleState}-model` },
    });
    assert.equal(target.error, "model_not_available", lifecycleState);
    assert.equal(target.status, 404, lifecycleState);
  }
});

test("last-known model labels never make an undiscovered runtime ready or routable", () => {
  const [lastKnownOnly] = fleet.normalizeManagerInstances(vllm, {
    instances: [{
      id: "warming",
      running: true,
      status: "Up 20 seconds",
      models: [{ id: "still-loading", lastKnown: true, capabilities: ["text"] }],
    }],
  });
  assert.equal(lastKnownOnly.lifecycleState, "loading");
  assert.equal(fleet.isRoutableInstance(lastKnownOnly), false);
  assert.deepEqual(fleet.flattenCatalogModels([lastKnownOnly]), []);

  const [mixed] = fleet.normalizeManagerInstances(vllm, {
    instances: [{
      id: "mixed",
      running: true,
      status: "Up 2 minutes",
      models: [
        { id: "live-model", capabilities: ["text"] },
        { id: "stale-model", lastKnown: true, capabilities: ["text"] },
      ],
    }],
  });
  assert.equal(mixed.lifecycleState, "ready");
  assert.deepEqual(fleet.flattenCatalogModels([mixed]).map((model) => model.id), ["live-model"]);
  const target = fleet.selectFleetTarget([{
    manager: vllm,
    listening: true,
    running: true,
    instances: [mixed],
    models: [
      { id: "live-model", instance_id: "mixed", capabilities: ["text"] },
      { id: "stale-model", instance_id: "mixed", lastKnown: true, capabilities: ["text"] },
    ],
  }], {
    engine: "auto",
    protocol: "openai",
    path: "v1/chat/completions",
    body: { model: "stale-model" },
  });
  assert.equal(target.error, "model_not_available");
  assert.equal(target.status, 404);
});

test("auto routing finds a model that exists only in a parallel llama instance", () => {
  const catalogs = [
    catalog(vllm, [{ id: "vllm:primary", instanceId: "primary", primary: true, running: true, models: [{ id: "text-model", capabilities: ["language"] }] }]),
    catalog(llama, [{ id: "llama:vision", instanceId: "vision", primary: false, running: true, models: [{ id: "vision-model", capabilities: ["language", "vision"] }] }]),
  ];
  const target = fleet.selectFleetTarget(catalogs, {
    engine: "auto",
    protocol: "openai",
    path: "v1/chat/completions",
    body: { model: "vision-model" },
  });
  assert.equal(target.error, null);
  assert.equal(target.manager.id, "llama");
  assert.equal(target.instance.instanceId, "vision");
  assert.equal(target.model.id, "vision-model");
});

test("generic image and embedding requests select matching resident capabilities", () => {
  const catalogs = [
    catalog(vllm, [
      { id: "vllm:primary", instanceId: "primary", primary: true, running: true, models: [{ id: "chat", capabilities: ["language"] }] },
      { id: "vllm:vision", instanceId: "vision", primary: false, running: true, models: [{ id: "vision", capabilities: ["language", "vision"] }] },
      { id: "vllm:embed", instanceId: "embed", primary: false, running: true, models: [{ id: "embed", capabilities: ["embedding"] }] },
    ]),
  ];
  const vision = fleet.selectFleetTarget(catalogs, {
    engine: "auto",
    protocol: "openai",
    path: "v1/chat/completions",
    body: { model: "local-current", messages: [{ content: [{ type: "image_url", image_url: { url: "x" } }] }] },
  });
  assert.equal(vision.model.id, "vision");
  assert.equal(vision.reason, "generic_vision");

  const embedding = fleet.selectFleetTarget(catalogs, {
    engine: "auto",
    protocol: "openai",
    path: "v1/embeddings",
    body: { model: "auto", input: "hello" },
  });
  assert.equal(embedding.model.id, "embed");
});

test("fleet modes apply distinct and predictable generic text preferences", () => {
  const catalogs = [
    catalog(vllm, [{
      id: "vllm:parallel", instanceId: "parallel", primary: false, running: true,
      models: [{ id: "vllm-text", capabilities: ["text"] }],
    }]),
    catalog(llama, [{
      id: "llama:primary", instanceId: "primary", primary: true, running: true,
      models: [{ id: "llama-text", capabilities: ["text"] }],
    }]),
  ];
  const request = {
    engine: "auto", protocol: "openai", path: "v1/chat/completions", body: { model: "auto" },
  };
  const throughput = fleet.selectFleetTarget(catalogs, { ...request, mode: "throughput" });
  assert.equal(throughput.model.id, "vllm-text");
  assert.deepEqual(throughput.policy, { mode: "throughput", preferEngine: "auto" });

  const balanced = fleet.selectFleetTarget(catalogs, { ...request, mode: "balanced" });
  assert.equal(balanced.model.id, "llama-text");
  assert.deepEqual(balanced.policy, { mode: "balanced", preferEngine: "auto" });
});

test("unknown explicit models fail closed for every engine and protocol while explicit Claude aliases remain compatible", () => {
  const catalogs = [catalog(vllm, [{
    id: "vllm:primary", instanceId: "primary", primary: true, running: true,
    models: [{ id: "chat", capabilities: ["language"] }],
  }])];
  for (const engine of ["auto", "vllm", "llama"]) {
    for (const protocol of ["openai", "opencode", "claude"]) {
      const unknown = fleet.selectFleetTarget(catalogs, {
        engine, protocol, path: "v1/chat/completions", body: { model: "typo-model" },
      });
      assert.equal(unknown.error, "model_not_available", `${engine}/${protocol}`);
      assert.equal(unknown.status, 404, `${engine}/${protocol}`);
    }
  }

  const claudeAlias = fleet.selectFleetTarget(catalogs, {
    engine: "auto", protocol: "claude", path: "v1/messages", body: { model: "claude-sonnet-4-6" },
  });
  assert.equal(claudeAlias.error, null);
  assert.equal(claudeAlias.model.id, "chat");
  assert.equal(claudeAlias.reason, "claude_compat_alias");

  const typoClaude = fleet.selectFleetTarget(catalogs, {
    engine: "auto", protocol: "claude", path: "v1/messages", body: { model: "claude-made-up-typo" },
  });
  assert.equal(typoClaude.error, "model_not_available");

  const vision = fleet.selectFleetTarget(catalogs, {
    engine: "auto",
    protocol: "openai",
    path: "v1/chat/completions",
    body: { model: "auto", messages: [{ content: [{ type: "input_image", image_url: "x" }] }] },
  });
  assert.equal(vision.error, "capability_not_available");
  assert.equal(vision.status, 503);
});

test("request body rewrite changes only the model field", () => {
  const body = Buffer.from(JSON.stringify({ model: "local-current", messages: [{ role: "user", content: "private" }] }));
  const rewritten = JSON.parse(fleet.rewriteRequestModelBody(body, "vision-model").toString("utf8"));
  assert.equal(rewritten.model, "vision-model");
  assert.equal(rewritten.messages[0].content, "private");
});

test("fleet snapshot uses the maximum shared GPU reading instead of summing managers", () => {
  const catalogs = [catalog(vllm, [{
    id: "vllm:primary", instanceId: "primary", primary: true, running: true,
    models: [{ id: "chat", capabilities: ["language"] }],
  }])];
  const snapshot = fleet.buildFleetSnapshot({
    catalogs,
    resources: [
      { gpuMemory: { totalMb: 97887, usedMb: 72000, source: "nvidia-smi" } },
      { gpuMemory: { totalMb: 97887, usedMb: 72500, source: "nvidia-smi" } },
    ],
    settings: { mode: "multimodal", reserveMb: 8192, maxUtilizationPct: 85 },
    gatewayBase: "http://127.0.0.1:5176/gateway/auto/openai/v1",
  });
  assert.equal(snapshot.gpuMemory.totalMb, 97887);
  assert.equal(snapshot.gpuMemory.usedMb, 72500);
  assert.equal(snapshot.gpuMemory.allocatableMb, 10703);
  assert.equal(snapshot.gpuMemory.gpus[0].warningLimitMb, 83203);
  assert.equal(snapshot.gpuMemory.gpus[0].allocatableMb, 10703);
  assert.equal(snapshot.instances.length, 1);
  assert.deepEqual(snapshot.slots.map((slot) => slot.state), ["empty", "empty"]);
});

test("fleet snapshot retains stopped instances and computes warning-limited VRAM per GPU", () => {
  const instances = fleet.normalizeManagerInstances(llama, {
    instances: [
      { id: "primary", primary: true, running: false, status: "Exited (255)", models: [] },
      { id: "embed", primary: false, running: true, status: "Up (healthy)", models: [{ id: "bge-embed" }] },
    ],
  });
  const snapshot = fleet.buildFleetSnapshot({
    catalogs: [catalog(llama, instances)],
    resources: [{
      gpuMemory: {
        gpus: [
          { id: "0", totalMb: 10000, usedMb: 7000 },
          { id: "1", totalMb: 20000, usedMb: 10000 },
        ],
      },
    }],
    settings: { reserveMb: 1024, maxUtilizationPct: 90 },
  });
  assert.equal(snapshot.instances.length, 2);
  assert.equal(snapshot.instances[0].lifecycleState, "crashed");
  assert.equal(snapshot.instances[1].lifecycleState, "ready");
  assert.equal(snapshot.gpuMemory.warningThresholdPct, 90);
  assert.deepEqual(snapshot.gpuMemory.gpus.map((gpu) => gpu.allocatableMb), [1976, 8000]);
  assert.equal(snapshot.gpuMemory.allocatableMb, 9976);
});

test("fleet snapshot does not merge different GPUs that share id 0", () => {
  const snapshot = fleet.buildFleetSnapshot({
    catalogs: [],
    resources: [
      { manager_engine: "vllm", gpuMemory: { gpus: [{ id: "0", totalMb: 10000, usedMb: 1000 }] } },
      { manager_engine: "llama", gpuMemory: { gpus: [{ id: "0", totalMb: 20000, usedMb: 2000 }] } },
    ],
    settings: { reserveMb: 1024, maxUtilizationPct: 90 },
  });
  assert.equal(snapshot.gpuMemory.gpus.length, 2);
  assert.equal(snapshot.gpuMemory.totalMb, 30000);
  assert.equal(snapshot.gpuMemory.usedMb, 3000);
});

function catalog(manager, instances) {
  return {
    manager,
    listening: true,
    running: true,
    instances,
    models: fleet.flattenCatalogModels(instances),
    aliases: new Set(["local-current", "auto"]),
  };
}
