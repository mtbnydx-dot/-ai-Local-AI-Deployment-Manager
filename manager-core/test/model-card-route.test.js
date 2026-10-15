"use strict";

// MOD-15: the manager-side GET /api/models/card?model= (02 section 17, "Manager endpoints").

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "card-route-reference-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_DIR;
test.after(() => fs.rmSync(EMPTY_DIR, { recursive: true, force: true }));

const { registerModelInspectorRoutes } = require("../model-inspector-routes");

function recordingApp() {
  const routes = new Map();
  return { routes, get(route, handler) { routes.set(`GET ${route}`, handler); }, post(route, handler) { routes.set(`POST ${route}`, handler); } };
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; },
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "card-route-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelDir = path.join(root, "models", "example-model");
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, "config.json"), JSON.stringify({ model_type: "qwen3", architectures: ["Qwen3ForCausalLM"], hidden_size: 64, num_hidden_layers: 2, vocab_size: 1000 }));
  fs.writeFileSync(path.join(modelDir, "model.safetensors"), "x");
  const app = recordingApp();
  registerModelInspectorRoutes(app, {
    managerId: "vllm",
    resolveModelPath: (ref) => (ref === "example-model" ? modelDir : null),
  });
  const get = async (query) => {
    const res = fakeResponse();
    await app.routes.get("GET /api/models/card")({ headers: {}, query }, res);
    return res;
  };
  return { root, modelDir, get };
}

test("GET /api/models/card answers a path-free summary card", async (t) => {
  const f = fixture(t);
  const res = await f.get({ model: "example-model" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.card.cardId, /^mc_/);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(JSON.stringify(res.body).includes(f.root), false);
});

test("GET /api/models/card rejects a missing model and an unknown one", async (t) => {
  const f = fixture(t);
  const missing = await f.get({});
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.error.code, "invalid_request");
  const unknown = await f.get({ model: "nope" });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.error.code, "model_not_found");
});

test("GET /api/models/card answers 422 when the resolved path is not a model", async (t) => {
  const f = fixture(t);
  fs.rmSync(f.modelDir, { recursive: true, force: true });
  const res = await f.get({ model: "example-model" });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.error.code, "not_a_model");
  assert.equal(JSON.stringify(res.body).includes(f.root), false);
});
