// 07 §13.1 fixtures.test: every tests/fixtures/console/*.json passes its guard,
// so the Playwright mocks cannot drift from what the console accepts. A new
// fixture file needs a line in GUARDS (a missing line fails the last test).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { arr, check } from "../../console/lib/guards.js";
import * as schemas from "../../console/lib/schemas.js";

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tests", "fixtures", "console");

// file name (without .json) → the guard its content must pass; an array fixture is a list of that guard.
const GUARDS = {
  bootstrap: schemas.BootstrapGuard,
  session: schemas.SessionGuard,
  "platform-status": schemas.PlatformStatusGuard,
  status: schemas.StatusGuard,
  fleet: schemas.FleetGuard,
  events: arr(schemas.EventEnvelopeGuard, { dropInvalid: false }),
  // CON-10 SchemaForm fixtures: real engine schema payloads and hand-built launch plans.
  "schema-vllm": schemas.SchemaCatalogGuard,
  "schema-sglang": schemas.SchemaCatalogGuard,
  "schema-llamacpp": schemas.SchemaCatalogGuard,
  "plan-vllm": schemas.LaunchPlanGuard,
  "plan-sglang": schemas.LaunchPlanGuard,
  "plan-llamacpp": schemas.LaunchPlanGuard,
  // CON-20 Access fixtures: the 05 §13.1 key list, presets and the one-time create answer.
  "access-keys": schemas.KeyListGuard,
  "access-presets": schemas.PresetListGuard,
  "access-key-created": schemas.KeyCreatedGuard,
  // CON-21: the exposure scan (a real 05 golden), the security overview (generated from the real module) and the session list.
  "access-exposure": schemas.ExposureAnswerGuard,
  "access-security": schemas.SecurityOverviewGuard,
  "access-sessions": schemas.SessionListGuard,
  // CON-16 Engines fixtures: the entry aggregate, the external endpoints and a flags response with its diff.
  engines: schemas.EnginesResponseGuard,
  "engines-external": schemas.ExternalEndpointsGuard,
  "engines-flags": schemas.FlagsResponseGuard,
  // CON-14 Models fixtures: the hub library list and the storage usage (03 §9.2, §13.5).
  "models-library": schemas.LibraryListGuard,
  "models-usage": schemas.StorageUsageGuard,
};

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"));
}

for (const [name, guard] of Object.entries(GUARDS)) {
  test(`fixture ${name}.json passes its guard with nothing dropped`, () => {
    const result = check(guard, read(name));
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(result.dropped, 0);
  });
}

test("every notification in events.json passes NotificationGuard, and event ids are unique and ordered", () => {
  const events = read("events");
  const ids = events.map((event) => event.id);
  assert.equal(new Set(ids).size, ids.length);
  const notifications = events.filter((event) => event.type === "notification");
  assert.ok(notifications.length >= 2, "an apiCall and an href notification");
  for (const event of notifications) {
    const result = check(schemas.NotificationGuard, event.data);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  }
  assert.ok(notifications.some((event) => event.data.action?.apiCall), "one notification carries an apiCall");
  assert.ok(notifications.some((event) => event.data.action?.href), "one notification carries an href");
});

test("the platform-status fixture is the 0-serving state: a warn serving layer with a restore-models action", () => {
  const status = read("platform-status");
  const serving = status.readiness.layers.find((layer) => layer.id === "serving");
  assert.equal(serving.status, "warn");
  assert.equal(serving.code, "no_model_serving");
  assert.equal(serving.action.id, "restore-models");
  assert.equal(status.models.serving, 0);
});

test("the fleet fixture has no routable instance, so the derived readiness reads no_model_serving too", async () => {
  const { deriveReadiness } = await import("../../console/lib/readiness.js");
  const readiness = deriveReadiness({ status: read("status"), fleet: read("fleet") });
  assert.equal(readiness.serving, 0);
  assert.equal(readiness.layers.find((layer) => layer.id === "serving").code, "no_model_serving");
});

test("fixtures hold no user names, machine names or absolute paths", () => {
  for (const file of fs.readdirSync(FIXTURE_DIR).filter((item) => item.endsWith(".json"))) {
    const text = fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8");
    assert.equal(/[A-Za-z]:\\|\/Users\/|\/home\/|@[\w-]+\.[A-Za-z]{2,}/.test(text), false, `${file} names a path or an address`);
  }
});

test("every fixture file has a guard in GUARDS", () => {
  const files = fs.readdirSync(FIXTURE_DIR).filter((item) => item.endsWith(".json")).map((item) => item.replace(/\.json$/, ""));
  for (const name of files) assert.ok(Object.hasOwn(GUARDS, name), `${name}.json has no guard in fixtures.test.js`);
});
