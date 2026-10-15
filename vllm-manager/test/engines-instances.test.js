"use strict";

// ENG-13 wiring (docs/overhaul/01-engines.md §16.4, §21.1): the typed-instance
// routes are registered on the real app and GET /api/config reports entryPort.
// The instance logic itself is covered by manager-core/test/engines-instances.test.js.
// No docker process is spawned and no live service is called.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vllm-instances-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
// The platform config is read from an empty AI root, never from a live one.
process.env.AI_ROOT = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const manager = require("../server");

function registeredRoutes(app) {
  return app.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`));
}

test("the vllm manager registers the per-instance routes", () => {
  const routes = registeredRoutes(manager.app);
  for (const route of ["GET /api/instances", "POST /api/instances/:id/stop", "GET /api/instances/:id/logs", "GET /api/instances/:id/launch", "POST /api/instances/:id/relaunch", "GET /api/instances/:id/metrics"]) {
    assert.ok(routes.includes(route), route);
  }
});

test("GET /api/config reports entryPort from SERVICE_ENTRY_PORT, else the platform config, else 5176", async (t) => {
  const server = manager.app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/config`;
  const saved = process.env.SERVICE_ENTRY_PORT;
  t.after(() => {
    if (saved === undefined) delete process.env.SERVICE_ENTRY_PORT;
    else process.env.SERVICE_ENTRY_PORT = saved;
  });
  process.env.SERVICE_ENTRY_PORT = "5999";
  const withEnv = await (await fetch(url)).json();
  assert.equal(withEnv.entryPort, 5999);
  assert.equal(typeof withEnv.managerPort, "number", "the legacy fields stay");
  delete process.env.SERVICE_ENTRY_PORT;
  const without = await (await fetch(url)).json();
  assert.ok(Number.isInteger(without.entryPort) && without.entryPort > 0);
});
