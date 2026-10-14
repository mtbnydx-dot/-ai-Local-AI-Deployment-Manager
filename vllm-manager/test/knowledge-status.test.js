"use strict";

// GET /api/knowledge/status on the real vllm-manager app (docs/overhaul/02-models.md
// MOD-5): registered once through core.registerModelInspectorRoutes, answers 200 over
// HTTP with the models, engines and launch-params domains. Configuration comes from
// an empty temp directory; nothing touches Docker or live data.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vllm-knowledge-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const manager = require("../server");

function registeredRoutes(app) {
  return app.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`));
}

test("the vLLM manager registers GET /api/knowledge/status", () => {
  assert.ok(registeredRoutes(manager.app).includes("GET /api/knowledge/status"));
});

test("GET /api/knowledge/status returns 200 with the bundled knowledge, engines and launch parameters", async (t) => {
  const server = manager.app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/knowledge/status`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.managerId, "vllm");
  assert.match(body.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(body.domains.map((domain) => domain.domain), ["models", "engines", "launch-params"]);
  const models = body.domains[0];
  assert.deepEqual(models.errors, []);
  assert.deepEqual(models.layers.map((layer) => layer.layer), ["bundled", "legacy-v1", "pack", "user", "model"]);
  const escapedDir = JSON.stringify(EMPTY_CONFIG_DIR.toLowerCase()).slice(1, -1);
  assert.ok(!JSON.stringify(body).toLowerCase().includes(escapedDir), "no absolute path in the answer");
});
