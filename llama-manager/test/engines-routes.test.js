"use strict";

// llama-manager wiring of the engine registry (docs/overhaul/01-engines.md
// ENG-2). Docker is a fake; no docker process is spawned.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llama-engines-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const manager = require("../server");
const core = require("../../manager-core");

function registeredRoutes(app) {
  return app.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`));
}

test("the llama manager registers the engine routes and hosts llamacpp", () => {
  const routes = registeredRoutes(manager.app);
  assert.ok(routes.includes("GET /api/engines"));
  assert.ok(routes.includes("POST /api/engines/descriptors/validate"));
  assert.deepEqual(manager.engineRegistry.hostedBy("llama"), ["llamacpp"]);
  assert.equal(manager.engineRegistry.fromLegacy("llama", "llama"), "llamacpp");
  if (!process.env.LLAMA_IMAGE && !process.env.LLAMA_IMAGE_DIGEST) {
    assert.equal(core.runtimeForImage(manager.CONFIG.image)?.runtimeId, "llamacpp@b10630");
  }
  if (!process.env.LLAMA_MUSE_IMAGE) {
    assert.equal(core.runtimeForImage(manager.CONFIG.museImage)?.runtimeId, "llamacpp@muse-62bf73d");
  }
});

test("each registry runtime slot runs the image CONFIG runs, env overrides included", () => {
  // Both read process.env: LLAMA_IMAGE, then LLAMA_IMAGE_DIGEST, then the manifest.
  assert.equal(manager.engineRegistry.defaultRuntime("llamacpp").image, manager.CONFIG.image);
  assert.equal(manager.engineRegistry.resolveRuntime("llamacpp", { manifestKey: "llamaMuse" }).image, manager.CONFIG.museImage);
});

test("GET /api/engines lists llama.cpp with its runtimes over HTTP", async (t) => {
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-engines-override-"));
  t.after(() => fs.rmSync(overrideDir, { recursive: true, force: true }));
  const app = express();
  app.use(express.json());
  core.engines.registerEngineRoutes(app, {
    registry: core.engines.createEngineRegistry({ overrideDir, env: {} }),
    managerId: "llama",
    ownerLabelValue: "llama-manager",
    isLocalRequest: core.isLocalRequest,
    getImageStatus: async () => ({ ok: false, reason: "docker-daemon", text: "daemon down" }),
    listManagedContainers: async () => [],
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/engines`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.managerId, "llama");
  assert.equal(body.engines.length, 1);
  const [llama] = body.engines;
  assert.equal(llama.engineId, "llamacpp");
  assert.deepEqual(llama.capabilities.autoParsers, { tool: "auto", reasoning: "auto" });
  assert.deepEqual(llama.memoryModel, { kind: "gguf-estimate" });
  assert.deepEqual(llama.runtimes.map((runtime) => [runtime.runtimeId, runtime.default, runtime.present, runtime.pullPolicy]), [
    ["llamacpp@b10630", true, null, "auto"],
    ["llamacpp@muse-62bf73d", false, null, "explicit"],
  ]);
  assert.deepEqual(llama.health, { host: "docker", hostReady: false, instances: 0 });
});
