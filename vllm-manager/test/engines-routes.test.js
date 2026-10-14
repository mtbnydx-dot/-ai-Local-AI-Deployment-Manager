"use strict";

// vllm-manager wiring of the engine registry (docs/overhaul/01-engines.md ENG-2):
// the routes are registered on the real app, the manifest reproduces what
// knownRuntimeImageMetadata derives from the configured images, and the routes
// answer over HTTP. Docker is a fake; no docker process is spawned.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");

// The manifest and engine overrides come from bundled data only.
const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vllm-engines-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const manager = require("../server");
const core = require("../../manager-core");

function registeredRoutes(app) {
  return app.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`));
}

test("the vLLM manager registers the engine routes and hosts vllm and sglang", () => {
  const routes = registeredRoutes(manager.app);
  assert.ok(routes.includes("GET /api/engines"));
  assert.ok(routes.includes("POST /api/engines/descriptors/validate"));
  assert.deepEqual(manager.engineRegistry.hostedBy("vllm"), ["vllm", "sglang"]);
  assert.deepEqual(manager.engineRegistry.errors(), []);
});

test("runtimeForImage reproduces knownRuntimeImageMetadata for every configured image", (t) => {
  const cases = [
    ["image", "vllm", ["VLLM_IMAGE", "VLLM_IMAGE_VERSION"]],
    ["sglangImage", "sglang", ["SGLANG_IMAGE"]],
    ["sglangFlashNextImage", "sglangFlashNext", ["SGLANG_FLASH_NEXT_IMAGE"]],
    ["qwenMoeImage", "vllmQwenMoe", ["VLLM_QWEN_MOE_IMAGE"]],
    ["gemmaImage", "vllmGemma", ["VLLM_GEMMA_IMAGE"]],
  ];
  for (const [field, manifestKey, envNames] of cases) {
    if (envNames.some((name) => process.env[name])) {
      t.diagnostic(`${field} is overridden by the environment; skipped`);
      continue;
    }
    const image = manager.CONFIG[field];
    const legacy = manager.knownRuntimeImageMetadata(image);
    const ref = core.runtimeForImage(image);
    assert.ok(legacy, field);
    assert.equal(ref?.manifestKey, manifestKey, field);
    for (const name of ["repository", "manifestDigest", "platformDigest", "platform", "cudaVersion", "torchVersion", "transformersVersion", "minimumComputeCapability", "minimumBlackwellCudaVersion", "minimumDriverVersions"]) {
      assert.deepEqual(ref.release[name], legacy[name], `${field}.${name}`);
    }
    // Commit builds carry a short version plus the full revision the old literal spelled out.
    if (ref.release.revision) assert.ok(legacy.version.endsWith(ref.release.revision), field);
    else assert.equal(ref.release.version, legacy.version, field);
  }
});

test("GET /api/engines and the descriptor validator answer over HTTP", async (t) => {
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "vllm-engines-override-"));
  t.after(() => fs.rmSync(overrideDir, { recursive: true, force: true }));
  const registry = core.engines.createEngineRegistry({ overrideDir, env: {} });
  const inspected = [];
  const app = express();
  app.use(express.json());
  core.engines.registerEngineRoutes(app, {
    registry,
    managerId: "vllm",
    ownerLabelValue: "vllm-manager",
    isLocalRequest: core.isLocalRequest,
    getImageStatus: async (image) => {
      inspected.push(image);
      return image.startsWith("local/") ? { ok: true, text: image } : { ok: false, reason: "missing-image", text: image };
    },
    listManagedContainers: async () => [{ name: "vllm-local", manager: "vllm-manager", engine: "sglang", running: true, labels: {} }],
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const listing = await fetch(`${base}/api/engines`);
  assert.equal(listing.status, 200);
  const body = await listing.json();
  assert.equal(body.managerId, "vllm");
  assert.deepEqual(body.engines.map((engine) => engine.engineId), ["vllm", "sglang"]);
  const sglang = body.engines.find((engine) => engine.engineId === "sglang");
  assert.deepEqual(sglang.runtimes.map((runtime) => runtime.runtimeId), [
    "sglang@0.5.17",
    "sglang@qwen38flashnext-sm120-dac5523d",
    "sglang@pennyroyal-v2.5.1",
    "sglang@flashnext-nvme-ple-20260831",
  ]);
  assert.deepEqual(sglang.runtimes.map((runtime) => runtime.present), [false, true, false, false]);
  assert.equal(sglang.health.instances, 1);
  assert.deepEqual(sglang.capabilities.autoParsers, { tool: null, reasoning: null });
  assert.ok(inspected.length > 0);

  const bad = await fetch(`${base}/api/engines/descriptors/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ descriptor: { id: "vllm", adapter: "docker-template" } }),
  });
  assert.equal(bad.status, 200);
  const verdict = await bad.json();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.kind, "override");
  assert.deepEqual(verdict.errors.map((item) => `${item.path}:${item.code}`), ["adapter:override_field_forbidden"]);
  assert.match(verdict.errors[0].message, /override may change only/);
  assert.deepEqual(fs.readdirSync(overrideDir), [], "validation writes nothing");
});
