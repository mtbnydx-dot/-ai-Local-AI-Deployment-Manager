"use strict";

// llama-manager starts through the shared runtime-supervisor (docs/overhaul/
// 01-engines.md §14, ENG-10): the runtime gate in warn mode, fresh container
// and served-model getters, and the llama run context. Nothing is started.

const assert = require("node:assert/strict");
const test = require("node:test");
const manager = require("../server");

test("llama runs the supervisor with the runtime gate in warn mode", () => {
  const { config } = manager.runtimeSupervisor;
  assert.equal(config.managerId, manager.CONFIG.managerId);
  assert.equal(config.runtimeGatePolicy, "warn");
  assert.equal(config.hostKind, "docker");
});

test("the llama start waits with fresh container and served-model getters", () => {
  const { getters } = manager.runtimeSupervisor.config;
  assert.equal(getters.containerStatus, manager.getContainerStatusFresh);
  assert.equal(getters.servedModels, manager.getServedModelsFresh);
});

test("the llama run context keeps lease and key-ref cleanup with launch-request and refuses to pull local builds", async () => {
  const prepareGpuAdmission = async (prepare) => prepare();
  const run = manager.llamaRunContext({
    instanceMode: "replace",
    containerName: manager.CONFIG.containerName,
    port: 18080,
    gpuDeviceIds: ["0"],
    runtimeApiKeyRef: "rk-fixture",
    networkAccess: "local",
    prepareGpuAdmission,
  });
  assert.equal(run.cleanup, "caller");
  assert.equal(run.engineId, "llamacpp");
  assert.equal(run.instanceId, "primary");
  assert.equal(run.apiKeyRef, "rk-fixture");
  assert.equal(run.prepareAdmission, prepareGpuAdmission);
  assert.equal(run.imagePolicy, "auto");
  assert.throws(() => run.onMissingImage({ image: "local/llama.cpp:fixture" }), /本地运行时镜像不存在/);
  assert.doesNotThrow(() => run.onMissingImage({ image: "ghcr.io/fixture/llama:tag" }));
  const parallel = manager.llamaRunContext({ instanceMode: "parallel", containerName: "llama-local-fixture", instanceId: "fixture", port: 18081 });
  assert.equal(parallel.instanceId, "fixture");
});
