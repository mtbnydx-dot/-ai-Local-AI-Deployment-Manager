"use strict";

// Model-card, compatibility, probe, recommend and fit-grid routes at the entry
// (02 §17, MOD-15) through the real entry: the 05 guard, the viewer registry,
// the central sendJson redaction and the management proxy. The two managers
// are fake HTTP servers on ephemeral ports (they record what they were asked
// and answer launch plans and probes); the model folders are materialized
// fixtures in temp directories; remote inspection is a stub, so nothing
// leaves the process.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("../../manager-core");
const { resetInspector } = require("../../manager-core/model-inspector/inspect");
const { materializeFixture } = require("../../manager-core/test/helpers/fixture-materialize");
const modelCardRoutes = require("../lib/model-card-routes");
const { loadEntry, ownerSession, quietLogger, request, serveEntry } = require("./helpers/entry-harness");

const FAKE_GPU = Object.freeze({ id: "0", name: "Test GPU", totalMb: 97887, freeMb: 97000, usedMb: 600, computeCap: "12.0" });
const REMOTE_ID = "mc_aaaaaaaaaaaaaaaaaaaa";
const MODULES = ["./lib/mgmt-proxy", "./lib/model-card-routes"];

// Materializing a fixture is the slow part of a test; one copy per fixture serves the whole file.
const sharedParents = [];
const sharedFixtures = new Map();

test.after(async () => {
  await resetInspector();
  for (const parent of sharedParents) fs.rmSync(parent, { recursive: true, force: true });
});

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// A fake manager: records every request and answers from `answers[<METHOD> <path>]`
// (a function of the parsed body, returning [status, body]).
async function startFakeManager(t, answers = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      const pathname = req.url.split("?")[0];
      seen.push({ method: req.method, path: pathname, url: req.url, body, headers: req.headers });
      const answer = answers[`${req.method} ${pathname}`];
      const [status, payload] = answer ? answer(body, req) : [404, { ok: false, error: { code: "not_found", message: "no such route" } }];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return { port, seen };
}

function planAnswer(overrides = {}) {
  return () => [200, {
    ok: true,
    engineId: "vllm",
    planHash: "plan-hash-1",
    errors: [],
    warnings: [],
    admission: { verdict: "ok", message: "fits" },
    command: { argv: ["docker", "run", "<redacted>"], env: { VLLM_API_KEY: "<redacted>" }, labels: {} },
    ...overrides,
  }];
}

async function mountApp(t, { vllm = {}, llama = {}, vllmDown = false, llamaDown = false, models = {}, hostRecords = null, gpus = [FAKE_GPU], roots = null } = {}) {
  const { entry } = await loadEntry();
  const root = tempDir(t, "model-card-routes-");
  const library = path.join(root, "library");
  fs.mkdirSync(library, { recursive: true });
  const cacheDir = path.join(root, "cards");
  const probeDir = path.join(root, "probes");
  const hostRecordsFile = path.join(root, "model-host-records.json");
  if (hostRecords) fs.writeFileSync(hostRecordsFile, JSON.stringify({ schemaVersion: 1, records: hostRecords }));
  const vllmManager = vllmDown ? null : await startFakeManager(t, vllm);
  const llamaManager = llamaDown ? null : await startFakeManager(t, llama);
  const managers = [
    { id: "vllm", port: vllmManager ? vllmManager.port : await unusedPort() },
    { id: "llama", port: llamaManager ? llamaManager.port : await unusedPort() },
  ];
  const ctx = entry.createRouteContext({
    logger: quietLogger(),
    managers,
    getGpus: async () => gpus,
    modelCards: {
      cacheDir,
      probeDir,
      hostRecordsFile,
      roots: roots || (() => [library, ...sharedParents]),
      inspectLocalOptions: { inProcess: true },
      models: { ...core.models, ...models },
    },
  });
  const routes = await entry.mountRouteModules({ ctx, modules: MODULES });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  const owner = await ownerSession(entry, port);
  return { entry, ctx, port, owner, library, cacheDir, hostRecordsFile, vllm: vllmManager, llama: llamaManager, registry: ctx.auth.viewerRegistry };
}

async function fixtureIn(t, app, id) {
  if (!sharedFixtures.has(id)) {
    sharedFixtures.set(id, (async () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "model-card-library-"));
      sharedParents.push(parent);
      return (await materializeFixture(id, { parent })).dir;
    })());
  }
  return sharedFixtures.get(id);
}

async function inspectOwned(app, dir, extra = {}) {
  return request(app.port, "/api/models/inspect", { method: "POST", owner: app.owner, body: { path: dir, ...extra } });
}

function remoteCardOf(id = "qwen38-27b-fp8") {
  const card = structuredClone(require(path.join(__dirname, "..", "..", "manager-core", "test", "fixtures", "model-cards", id, "expected-card.json")));
  card.cardId = REMOTE_ID;
  card.ref = { kind: "hf", repo: "example-org/example-model", revision: "main" };
  return card;
}

function inspectError(code, status, message = "stub failure") {
  return Object.assign(new core.models.InspectError(code, message), { status });
}

// --- inspect --------------------------------------------------------------------------------

test("POST /api/models/inspect returns the full card, then the cached one", async (t) => {
  const app = await mountApp(t);
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const first = await inspectOwned(app, dir);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.cached, false);
  assert.equal(typeof first.json.durationMs, "number");
  const card = first.json.card;
  assert.equal(card.schema, "modelcard/v1");
  assert.match(card.cardId, /^mc_[a-z2-7]{20}$/);
  assert.ok(Array.isArray(card.evidence) && card.evidence.length > 0);
  assert.ok(!("text" in (card.template || {})), "the chat template text is not part of the inspect answer");
  assert.match(first.headers["x-request-id"], /^req_[a-z2-7]{20}$/);
  const second = await inspectOwned(app, dir);
  assert.equal(second.json.cached, true);
  assert.equal(second.json.card.cardId, card.cardId);
  // The caller's own x-request-id travels back.
  const mine = await request(app.port, "/api/models/inspect", {
    method: "POST", owner: app.owner, body: { path: dir }, headers: { "x-request-id": "req_abcdefghijklmnopqrst" },
  });
  assert.equal(mine.headers["x-request-id"], "req_abcdefghijklmnopqrst");
});

test("inspect validates the body and refuses paths outside the model library", async (t) => {
  const app = await mountApp(t);
  const outside = tempDir(t, "outside-library-");
  const empty = path.join(app.library, "empty-folder");
  fs.mkdirSync(empty);

  const none = await request(app.port, "/api/models/inspect", { method: "POST", owner: app.owner, body: {} });
  assert.equal(none.status, 400);
  assert.equal(none.json.ok, false);
  assert.equal(none.json.error.code, "invalid_request");
  assert.equal(none.json.errors[0].field, "path");

  const both = await request(app.port, "/api/models/inspect", { method: "POST", owner: app.owner, body: { path: empty, source: "huggingface", repo: "a/b" } });
  assert.equal(both.status, 400);
  assert.equal(both.json.error.code, "invalid_request");

  const badSource = await request(app.port, "/api/models/inspect", { method: "POST", owner: app.owner, body: { source: "ftp", repo: "a/b" } });
  assert.equal(badSource.json.errors[0].field, "source");

  const badDepth = await request(app.port, "/api/models/inspect", { method: "POST", owner: app.owner, body: { path: empty, depth: "deep" } });
  assert.equal(badDepth.json.errors[0].field, "depth");

  const escaped = await inspectOwned(app, outside);
  assert.equal(escaped.status, 400);
  assert.equal(escaped.json.error.code, "path_outside_storage");
  assert.ok(escaped.json.error.hint);

  const sibling = path.join(app.library, "..", "sibling-folder");
  fs.mkdirSync(sibling);
  const traversal = await inspectOwned(app, path.join(app.library, "..", "sibling-folder"));
  assert.equal(traversal.json.error.code, "path_outside_storage");

  const unc = await inspectOwned(app, "\\\\server\\share\\model");
  assert.equal(unc.status, 400);
  assert.equal(unc.json.error.code, "path_not_allowed");

  const missing = await inspectOwned(app, path.join(app.library, "does-not-exist"));
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "not_found");

  const notAModel = await inspectOwned(app, empty);
  assert.equal(notAModel.status, 422);
  assert.equal(notAModel.json.error.code, "not_a_model");

  // A relative name resolves below the first library root.
  const inside = await materializeFixture("qwen38-27b-fp8", { parent: app.library });
  t.after(() => inside.cleanup());
  const relative = await inspectOwned(app, path.basename(inside.dir));
  assert.equal(relative.status, 200, relative.text);
});

test("an entry without library roots refuses every path instead of inspecting anywhere", async (t) => {
  const app = await mountApp(t, { roots: [] });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const refused = await inspectOwned(app, dir);
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, "path_outside_storage");
});

test("writes need an owner session and a CSRF token", async (t) => {
  const app = await mountApp(t);
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const anonymous = await request(app.port, "/api/models/inspect", { method: "POST", body: { path: dir } });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error.code, "admin_session_required");
  const noCsrf = await request(app.port, "/api/models/inspect", { method: "POST", body: { path: dir }, headers: { cookie: app.owner.cookie } });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error.code, "csrf_invalid");
  for (const [route, body] of [["/api/launch/recommend", { path: dir }], ["/api/models/mc_aaaaaaaaaaaaaaaaaaaa/probe", { engineId: "vllm" }], ["/api/models/mc_aaaaaaaaaaaaaaaaaaaa/fit-grid", { engineId: "vllm" }]]) {
    const denied = await request(app.port, route, { method: "POST", body });
    assert.equal(denied.status, 401, route);
  }
  const wrongMethod = await request(app.port, "/api/models/inspect", { owner: app.owner });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "POST");
  const tooBig = await request(app.port, "/api/models/inspect", { method: "POST", owner: app.owner, body: JSON.stringify({ path: "x".repeat(300 * 1024) }) });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.json.error.code, "request_too_large");
  const notJson = await request(app.port, "/api/models/inspect", { method: "POST", owner: app.owner, body: "[1]" });
  assert.equal(notJson.status, 400);
  assert.equal(notJson.json.error.code, "invalid_json");
});

test("remote inspection passes the request on and maps the inspector's errors", async (t) => {
  const calls = [];
  let failure = null;
  const card = remoteCardOf();
  const app = await mountApp(t, {
    models: {
      inspectRemoteDetailed: async (requestBody, options) => {
        calls.push({ request: requestBody, options });
        if (failure) throw failure;
        return { card, cached: false, durationMs: 12, key: "k" };
      },
    },
  });
  const ok = await request(app.port, "/api/models/inspect", {
    method: "POST", owner: app.owner, body: { source: "huggingface", repo: "example-org/example-model", files: ["model-Q4.gguf"], refresh: true },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.card.cardId, REMOTE_ID);
  assert.deepEqual(calls[0].request, { source: "huggingface", repo: "example-org/example-model", revision: "main", files: ["model-Q4.gguf"] });
  assert.equal(calls[0].options.refresh, true);
  for (const [code, status, expectedCode] of [
    ["gated", 403, "gated"],
    ["invalid_repo", 400, "invalid_repo"],
    ["inspect_timeout", 504, "inspect_timeout"],
    ["repo_not_found", 404, "not_found"],
    ["revision_not_found", 404, "not_found"],
    ["rate_limited", 429, "rate_limited"],
  ]) {
    failure = inspectError(code, status);
    const response = await request(app.port, "/api/models/inspect", { method: "POST", owner: app.owner, body: { source: "modelscope", repo: "example-org/example-model", revision: "v1" } });
    assert.equal(response.status, status, code);
    assert.equal(response.json.error.code, expectedCode, code);
    if (expectedCode !== code) assert.equal(response.json.error.details.reason, code);
  }
  failure = new Error("boom: sk-test-fake-0000 leaked");
  const crashed = await request(app.port, "/api/models/inspect", { method: "POST", owner: app.owner, body: { source: "huggingface", repo: "example-org/example-model" } });
  assert.equal(crashed.status, 500);
  assert.equal(crashed.json.error.code, "internal_error");
  assert.ok(!crashed.text.includes("sk-test-fake"), "an internal failure never reaches the caller");
});

// --- card -------------------------------------------------------------------------------------

test("GET /api/models/:id/card: owner views, viewer summary, owner-only full and template", async (t) => {
  const app = await mountApp(t);
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const { json: inspected } = await inspectOwned(app, dir);
  const id = inspected.card.cardId;

  const missing = await request(app.port, "/api/models/mc_bbbbbbbbbbbbbbbbbbbb/card", { owner: app.owner });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "card_not_found");
  assert.match(missing.json.error.hint, /inspect/);
  const malformed = await request(app.port, "/api/models/not-a-card/card", { owner: app.owner });
  assert.equal(malformed.status, 404);
  assert.equal(malformed.json.error.code, "card_not_found");

  const summary = await request(app.port, `/api/models/${id}/card`, { owner: app.owner });
  assert.equal(summary.status, 200);
  assert.equal(summary.json.card.cardId, id);
  assert.ok(!("evidence" in summary.json.card), "the default view is the summary");
  assert.ok("support" in summary.json.card && "confidence" in summary.json.card);

  const full = await request(app.port, `/api/models/${id}/card?view=full`, { owner: app.owner });
  assert.equal(full.status, 200);
  assert.equal(full.json.card.schema, "modelcard/v1");
  assert.equal(full.json.card.ref.path, dir, "the owner sees the real path");
  const withTemplate = await request(app.port, `/api/models/${id}/card?include=template`, { owner: app.owner });
  assert.equal(withTemplate.status, 200);
  assert.equal(withTemplate.json.card.schema, "modelcard/v1");
  const badView = await request(app.port, `/api/models/${id}/card?view=everything`, { owner: app.owner });
  assert.equal(badView.status, 400);

  // A viewer (loopback without a session) reads the summary; full and template are owner-only.
  const viewer = await request(app.port, `/api/models/${id}/card`);
  assert.equal(viewer.status, 200, viewer.text);
  assert.equal(viewer.json.card.cardId, id);
  assert.ok(!viewer.text.includes(app.library), "no library path reaches a viewer");
  for (const query of ["view=full", "include=template", "view=full&include=template"]) {
    const refused = await request(app.port, `/api/models/${id}/card?${query}`);
    assert.equal(refused.status, 403, query);
    assert.equal(refused.json.error.code, "owner_required");
  }
  const lan = await request(app.port, `/api/models/${id}/card`, { peer: "192.168.1.50" });
  assert.equal(lan.status, 200, lan.text);
  assert.ok(!lan.text.includes(app.library));
  const head = await request(app.port, `/api/models/${id}/card`, { method: "HEAD", owner: app.owner });
  assert.equal(head.status, 200);
});

// --- compatibility ------------------------------------------------------------------------------

test("GET /api/models/:id/compatibility evaluates the engines on this host's GPUs", async (t) => {
  const app = await mountApp(t);
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const id = (await inspectOwned(app, dir)).json.card.cardId;

  const all = await request(app.port, `/api/models/${id}/compatibility`, { owner: app.owner });
  assert.equal(all.status, 200, all.text);
  assert.equal(all.json.ok, true);
  assert.equal(all.json.cardId, id);
  assert.equal(all.json.host.gpus.length, 1);
  assert.equal(all.json.host.gpus[0].id, "0");
  assert.equal(typeof all.json.host.ramBytes, "number");
  assert.ok(all.json.host.platform);
  assert.ok(all.json.rows.length >= 3);
  const engines = new Set(all.json.rows.map((row) => row.engineId));
  for (const engineId of ["vllm", "sglang", "llamacpp"]) assert.ok(engines.has(engineId), engineId);
  for (const row of all.json.rows) {
    assert.ok(["ok", "warn", "block", "unknown"].includes(row.verdict));
    assert.ok(Array.isArray(row.reasons) && Array.isArray(row.supportEvidence));
    if (row.verdict === "ok") assert.ok(row.supportEvidence.length > 0, "no ok without support evidence");
  }

  const only = await request(app.port, `/api/models/${id}/compatibility?engines=vllm&gpus=0`, { owner: app.owner });
  assert.equal(only.status, 200);
  assert.ok(only.json.rows.length >= 1 && only.json.rows.every((row) => row.engineId === "vllm"));
  const unknownEngine = await request(app.port, `/api/models/${id}/compatibility?engines=nope`, { owner: app.owner });
  assert.equal(unknownEngine.status, 400);
  assert.equal(unknownEngine.json.error.code, "unknown_engine");
  const unknownGpu = await request(app.port, `/api/models/${id}/compatibility?gpus=7`, { owner: app.owner });
  assert.equal(unknownGpu.status, 400);
  assert.equal(unknownGpu.json.error.code, "unknown_gpu");
  const missing = await request(app.port, "/api/models/mc_bbbbbbbbbbbbbbbbbbbb/compatibility", { owner: app.owner });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "card_not_found");
  const viewer = await request(app.port, `/api/models/${id}/compatibility`);
  assert.equal(viewer.status, 200);
  assert.equal(viewer.json.rows.length, all.json.rows.length);
});

test("a host record becomes verified-on-host evidence, and a viewer never sees a path-valued reference", async (t) => {
  const app = await mountApp(t);
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const card = (await inspectOwned(app, dir)).json.card;
  const first = await request(app.port, `/api/models/${card.cardId}/compatibility?engines=vllm`, { owner: app.owner });
  const runtimeId = first.json.rows[0].runtimeId;
  const secretRef = "D:\\records\\qr_1.json";
  fs.writeFileSync(app.hostRecordsFile, JSON.stringify({
    schemaVersion: 1,
    records: [{ id: secretRef, contentDigest: card.contentDigest, runtimeId, engineId: "vllm", results: [{ check: "chat", status: "pass" }] }],
  }));
  const owner = await request(app.port, `/api/models/${card.cardId}/compatibility?engines=vllm`, { owner: app.owner });
  const row = owner.json.rows.find((item) => item.runtimeId === runtimeId);
  const evidence = row.supportEvidence.find((item) => item.kind === "verified-on-host");
  assert.ok(evidence, "the record counts as support evidence");
  assert.equal(evidence.ref, secretRef, "the owner sees the reference");
  const viewer = await request(app.port, `/api/models/${card.cardId}/compatibility?engines=vllm`);
  assert.equal(viewer.status, 200);
  const viewerRow = viewer.json.rows.find((item) => item.runtimeId === runtimeId);
  const viewerEvidence = viewerRow.supportEvidence.find((item) => item.kind === "verified-on-host");
  assert.ok(viewerEvidence);
  assert.ok(!("ref" in viewerEvidence), "the path-valued reference is dropped");
  assert.ok(!viewer.text.includes("qr_1.json"));
  assert.equal(viewerRow.verdict, row.verdict, "the rest of the row is unchanged");
});

test("compatibility redaction drops path evidence and keeps JSON pointers and registry references", () => {
  const body = {
    ok: true,
    rows: [{
      engineId: "vllm",
      supportEvidence: [
        { kind: "knowledge", ref: "families/qwen3.8#vllm", confidence: "declared" },
        { kind: "probe", ref: "C:/models/probe.json", confidence: "detected" },
        { kind: "probe", ref: "/mnt/models/probe.json", confidence: "detected" },
      ],
      reasons: [
        { code: "a", evidence: "/identity/modelType" },
        { code: "b", evidence: "\\\\server\\share\\x" },
        { code: "c", evidence: null },
      ],
    }],
  };
  const out = modelCardRoutes.redactCompatibilityForViewer(body);
  assert.deepEqual(out.rows[0].supportEvidence.map((item) => item.ref), ["families/qwen3.8#vllm", undefined, undefined]);
  assert.deepEqual(out.rows[0].reasons.map((item) => item.evidence), ["/identity/modelType", null, null]);
  assert.equal(body.rows[0].supportEvidence[1].ref, "C:/models/probe.json", "the input is not modified");
  assert.equal(modelCardRoutes.isHostPath("/identity/modelType"), false);
  assert.equal(modelCardRoutes.isHostPath("config.json#/model_type"), false);
  assert.equal(modelCardRoutes.isHostPath("../outside/config.json"), true);
});

// --- qualifications (the read side) -----------------------------------------------------------------

test("GET /api/models/:id/qualifications lists the card's host records, redacted for viewers", async (t) => {
  const app = await mountApp(t);
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const card = (await inspectOwned(app, dir)).json.card;
  const empty = await request(app.port, `/api/models/${card.cardId}/qualifications`, { owner: app.owner });
  assert.deepEqual(empty.json, { ok: true, records: [] });
  fs.writeFileSync(app.hostRecordsFile, JSON.stringify({
    schemaVersion: 1,
    records: [
      {
        id: "qr_1", contentDigest: card.contentDigest, cardId: card.cardId, engineId: "vllm", runtimeId: "vllm@x", launchId: "lch_secret",
        host: { gpu: "Test GPU", computeCap: "12.0", driver: "999.99" },
        results: [{ check: "chat", status: "pass", detail: { zh: "输出 pong", en: "output pong" }, metrics: { ttftMs: 10 } }],
        observed: { peakMb: { 0: 100 }, engineFacts: { secret: true } },
      },
      { id: "qr_other", contentDigest: "sha256:" + "0".repeat(64), results: [] },
    ],
  }));
  const owner = await request(app.port, `/api/models/${card.cardId}/qualifications`, { owner: app.owner });
  assert.equal(owner.json.records.length, 1, "only this card's records");
  assert.equal(owner.json.records[0].launchId, "lch_secret");
  const viewer = await request(app.port, `/api/models/${card.cardId}/qualifications`);
  assert.equal(viewer.status, 200);
  const [record] = viewer.json.records;
  assert.equal(record.id, "qr_1");
  assert.ok(!("launchId" in record));
  assert.ok(!("driver" in record.host) && record.host.gpu === "Test GPU");
  assert.ok(!("detail" in record.results[0]) && record.results[0].metrics.ttftMs === 10);
  assert.ok(!("engineFacts" in record.observed) && record.observed.peakMb[0] === 100);
});

// --- fit-grid ----------------------------------------------------------------------------------------

test("POST /api/models/:id/fit-grid answers cells, a matrix and the bounds", async (t) => {
  const app = await mountApp(t);
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const id = (await inspectOwned(app, dir)).json.card.cardId;
  const url = `/api/models/${id}/fit-grid`;
  const grid = await request(app.port, url, {
    method: "POST", owner: app.owner, body: { engineId: "vllm", gpuIds: ["0"], kvDtypes: ["auto", "fp8"], concurrency: [1, 4], contexts: [8192, 65536] },
  });
  assert.equal(grid.status, 200, grid.text);
  assert.equal(grid.json.ok, true);
  assert.equal(grid.json.cardId, id);
  assert.equal(grid.json.engineId, "vllm");
  assert.equal(typeof grid.json.native, "number");
  assert.equal(grid.json.cells.length, 4);
  for (const cell of grid.json.cells) {
    assert.ok(["auto", "fp8"].includes(cell.kvDtype));
    assert.ok([1, 4].includes(cell.concurrency));
    assert.ok(["native", "vram", "ram", "engine"].includes(cell.limitedBy));
    assert.equal(typeof cell.maxContext, "number");
    assert.ok(["ok", "warn", "fail"].includes(cell.status));
    assert.equal(typeof cell.spill, "boolean");
  }
  assert.equal(grid.json.matrix.length, 8);
  assert.equal(typeof grid.json.durationMs, "number");
  assert.ok(!("stats" in grid.json), "internal counters stay inside");
  // On this GPU an 8K context at one request fits.
  const small = grid.json.cells.find((cell) => cell.kvDtype === "auto" && cell.concurrency === 1);
  assert.ok(small.maxContext >= 8192);

  const defaults = await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "vllm" } });
  assert.equal(defaults.status, 200);
  assert.ok(defaults.json.cells.length >= 1, "a request without gpuIds uses every GPU");

  const tooLarge = await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "vllm", concurrency: [1, 2, 3, 4, 5, 6, 7, 8, 9] } });
  assert.equal(tooLarge.status, 400);
  assert.equal(tooLarge.json.error.code, "grid_too_large");
  const tooManyDtypes = await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "vllm", kvDtypes: ["a", "b", "c", "d", "e"] } });
  assert.equal(tooManyDtypes.json.error.code, "grid_too_large");
  const unknownEngine = await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "nope" } });
  assert.equal(unknownEngine.status, 400);
  assert.equal(unknownEngine.json.error.code, "unknown_engine");
  const noEngine = await request(app.port, url, { method: "POST", owner: app.owner, body: {} });
  assert.equal(noEngine.status, 400);
  assert.equal(noEngine.json.errors[0].field, "engineId");
  const badConcurrency = await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "vllm", concurrency: [0] } });
  assert.equal(badConcurrency.json.errors[0].field, "concurrency");
  const unknownRecipe = await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "vllm", recipeId: "no-such-recipe" } });
  assert.equal(unknownRecipe.status, 404);
  assert.equal(unknownRecipe.json.error.code, "recipe_not_found");
  const missing = await request(app.port, "/api/models/mc_bbbbbbbbbbbbbbbbbbbb/fit-grid", { method: "POST", owner: app.owner, body: { engineId: "vllm" } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "card_not_found");
});

// --- probe ------------------------------------------------------------------------------------------

test("POST /api/models/:id/probe goes to the manager that hosts the engine and relays its errors", async (t) => {
  let probeAnswer = () => [202, { ok: true, jobId: "job_probe_1", managerId: "vllm" }];
  const app = await mountApp(t, { vllm: { "POST /api/models/probe": (body) => probeAnswer(body) } });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const id = (await inspectOwned(app, dir)).json.card.cardId;
  const url = `/api/models/${id}/probe`;

  const started = await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "vllm", runtimeId: "vllm@x", allowRemoteCode: true } });
  assert.equal(started.status, 202, started.text);
  assert.deepEqual({ ok: started.json.ok, jobId: started.json.jobId, managerId: started.json.managerId }, { ok: true, jobId: "job_probe_1", managerId: "vllm" });
  const sent = app.vllm.seen.find((item) => item.path === "/api/models/probe");
  assert.deepEqual(sent.body, { model: dir, engineId: "vllm", runtimeId: "vllm@x", allowRemoteCode: true });
  assert.match(sent.headers["x-request-id"], /^req_/);
  assert.equal(app.llama.seen.length, 0, "the other manager is not asked");

  probeAnswer = () => [409, { ok: false, error: { code: "runtime_image_missing", message: "Pull the image first" }, action: { kind: "pull-image", path: "/api/runtimes/vllm%40x/pull" }, runtimeId: "vllm@x" }];
  const missingImage = await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "vllm" } });
  assert.equal(missingImage.status, 409);
  assert.equal(missingImage.json.error.code, "runtime_image_missing");
  assert.equal(missingImage.json.action.kind, "pull-image");
  probeAnswer = () => [409, { ok: false, error: { code: "probe_running", message: "already running" }, jobId: "job_probe_1" }];
  assert.equal((await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "vllm" } })).json.error.code, "probe_running");
  probeAnswer = () => [503, { ok: false, error: { code: "docker_unavailable", message: "Docker is not running." } }];
  const noDocker = await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "vllm" } });
  assert.equal(noDocker.status, 503);
  assert.equal(noDocker.json.error.code, "docker_unavailable");

  const unknown = await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "nope" } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, "unknown_engine");
  const external = await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "external" } });
  assert.equal(external.json.error.code, "unknown_engine");
  const noEngine = await request(app.port, url, { method: "POST", owner: app.owner, body: { allowRemoteCode: "yes" } });
  assert.equal(noEngine.status, 400);
  assert.deepEqual(noEngine.json.errors.map((item) => item.field).sort(), ["allowRemoteCode", "engineId"]);
  const missing = await request(app.port, "/api/models/mc_bbbbbbbbbbbbbbbbbbbb/probe", { method: "POST", owner: app.owner, body: { engineId: "vllm" } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "card_not_found");
  // llama.cpp probes go to the llama manager (this fake has no probe route and says so).
  const llamaProbe = await request(app.port, url, { method: "POST", owner: app.owner, body: { engineId: "llamacpp" } });
  assert.equal(llamaProbe.status, 404);
  assert.ok(app.llama.seen.some((item) => item.path === "/api/models/probe"));
});

test("a probe of a manager that is not running answers 503 manager_unreachable; a remote card has no files to probe", async (t) => {
  const remote = remoteCardOf();
  const app = await mountApp(t, {
    vllmDown: true,
    models: { getCard: (cardId, options) => (cardId === REMOTE_ID ? remote : core.models.getCard(cardId, options)) },
  });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const id = (await inspectOwned(app, dir)).json.card.cardId;
  const down = await request(app.port, `/api/models/${id}/probe`, { method: "POST", owner: app.owner, body: { engineId: "vllm" } });
  assert.equal(down.status, 503);
  assert.equal(down.json.error.code, "manager_unreachable");
  const remoteProbe = await request(app.port, `/api/models/${REMOTE_ID}/probe`, { method: "POST", owner: app.owner, body: { engineId: "vllm" } });
  assert.equal(remoteProbe.status, 400);
  assert.equal(remoteProbe.json.error.code, "model_not_local");
});

// --- recommend ------------------------------------------------------------------------------------------

test("POST /api/launch/recommend validates every plan through the manager's launch/plan", async (t) => {
  const answer = planAnswer();
  const app = await mountApp(t, {
    vllm: { "POST /api/launch/plan": answer },
    llama: { "POST /api/launch/plan": planAnswer({ engineId: "llamacpp", planHash: "plan-hash-llama" }) },
  });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const id = (await inspectOwned(app, dir)).json.card.cardId;
  const response = await request(app.port, "/api/launch/recommend", { method: "POST", owner: app.owner, body: { cardId: id, goal: "max-context" } });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.cardId, id);
  assert.equal(response.json.goal, "max-context");
  assert.ok(Array.isArray(response.json.notes));
  assert.ok(response.json.gpuSets.length >= 1);
  const set = response.json.gpuSets[0];
  assert.deepEqual(set.gpuIds, ["0"]);
  assert.ok(set.plans.length >= 1 && set.plans.length <= 3);
  for (const plan of set.plans) {
    assert.match(plan.planId, /^pl_\d+$/);
    assert.ok(plan.engineId && plan.title.zh && plan.title.en);
    for (const entry of Object.values(plan.values)) assert.equal(entry.source, "planner");
    assert.equal(plan.validated.ok, true);
    assert.equal(plan.validated.errors.length, 0);
    assert.equal(plan.validated.admission.verdict, "ok");
    assert.ok(plan.validated.planHash.startsWith("plan-hash"));
    assert.deepEqual(plan.validated.commandPreview.argv, ["docker", "run", "<redacted>"]);
  }
  // What the manager was asked: a LaunchRequestV2 with the model on disk and the planner's values.
  const asked = [...app.vllm.seen, ...app.llama.seen].filter((item) => item.path === "/api/launch/plan");
  assert.ok(asked.length >= 1);
  for (const item of asked) {
    assert.deepEqual(item.body.model, { ref: dir });
    assert.ok(!("prospective" in item.body));
    assert.deepEqual(item.body.instance, { gpuIds: ["0"] });
    assert.ok(item.body.engineId);
    assert.equal(item.body.values.contextLength.source, "planner");
  }

  const bad = await request(app.port, "/api/launch/recommend", { method: "POST", owner: app.owner, body: { cardId: id, goal: "fastest" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "invalid_goal");
  const none = await request(app.port, "/api/launch/recommend", { method: "POST", owner: app.owner, body: { goal: "balanced" } });
  assert.equal(none.status, 400);
  assert.equal(none.json.error.code, "invalid_request");
  const missing = await request(app.port, "/api/launch/recommend", { method: "POST", owner: app.owner, body: { cardId: "mc_bbbbbbbbbbbbbbbbbbbb" } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "card_not_found");
  const badSets = await request(app.port, "/api/launch/recommend", { method: "POST", owner: app.owner, body: { cardId: id, gpuSets: [[]] } });
  assert.equal(badSets.status, 400);
  assert.equal(badSets.json.errors[0].field, "gpuSets");
  const badConstraints = await request(app.port, "/api/launch/recommend", { method: "POST", owner: app.owner, body: { cardId: id, constraints: 3 } });
  assert.equal(badConstraints.json.errors[0].field, "constraints");

  // The path form inspects the folder first; constraints narrow the engines.
  const byPath = await request(app.port, "/api/launch/recommend", { method: "POST", owner: app.owner, body: { path: dir, constraints: { engines: ["vllm"] }, gpuSets: [["0"]] } });
  assert.equal(byPath.status, 200, byPath.text);
  assert.equal(byPath.json.goal, "balanced");
  assert.ok(byPath.json.gpuSets[0].plans.every((plan) => plan.engineId === "vllm"));
});

test("recommend leaves validated null with plan_not_validated when the manager is away or fails", async (t) => {
  const app = await mountApp(t, { vllmDown: true, llamaDown: true });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const id = (await inspectOwned(app, dir)).json.card.cardId;
  const response = await request(app.port, "/api/launch/recommend", { method: "POST", owner: app.owner, body: { cardId: id, goal: "balanced" } });
  assert.equal(response.status, 200, response.text);
  const plans = response.json.gpuSets.flatMap((set) => set.plans);
  assert.ok(plans.length >= 1);
  for (const plan of plans) {
    assert.equal(plan.validated, null);
    assert.ok(plan.warnings.some((warning) => warning.code === "plan_not_validated"));
  }

  const failing = await mountApp(t, { vllm: { "POST /api/launch/plan": () => [500, { ok: false, error: { code: "launch_plan_failed", message: "boom" } }] }, llamaDown: true });
  const dir2 = await fixtureIn(t, failing, "qwen38-27b-fp8");
  const id2 = (await inspectOwned(failing, dir2)).json.card.cardId;
  const second = await request(failing.port, "/api/launch/recommend", { method: "POST", owner: failing.owner, body: { cardId: id2 } });
  assert.equal(second.status, 200);
  for (const plan of second.json.gpuSets.flatMap((set) => set.plans)) {
    assert.equal(plan.validated, null);
    assert.equal(plan.warnings[0].reason, "launch_plan_failed");
  }

  // A plan the manager refuses is still validated: ok false with its errors.
  const refusing = await mountApp(t, { vllm: { "POST /api/launch/plan": planAnswer({ ok: false, errors: [{ field: "contextLength", code: "out_of_range" }] }) }, llamaDown: true });
  const dir3 = await fixtureIn(t, refusing, "qwen38-27b-fp8");
  const id3 = (await inspectOwned(refusing, dir3)).json.card.cardId;
  const third = await request(refusing.port, "/api/launch/recommend", { method: "POST", owner: refusing.owner, body: { cardId: id3, constraints: { engines: ["vllm"] } } });
  const plan = third.json.gpuSets[0].plans[0];
  assert.equal(plan.validated.ok, false);
  assert.equal(plan.validated.errors[0].code, "out_of_range");
});

test("a card that is not on disk is validated as a prospective plan with the card inline", async (t) => {
  const remote = remoteCardOf();
  let requested = null;
  const app = await mountApp(t, {
    vllm: { "POST /api/launch/plan": planAnswer() },
    llama: { "POST /api/launch/plan": planAnswer({ engineId: "llamacpp" }) },
    models: {
      inspectRemoteDetailed: async (body) => {
        requested = body;
        return { card: remote, cached: true, durationMs: 1, key: "k" };
      },
    },
  });
  const response = await request(app.port, "/api/launch/recommend", {
    method: "POST", owner: app.owner, body: { repo: "example-org/example-model", goal: "balanced", constraints: { engines: ["vllm"] } },
  });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(requested, { source: "huggingface", repo: "example-org/example-model", revision: "main" });
  assert.equal(response.json.cardId, REMOTE_ID);
  const asked = app.vllm.seen.filter((item) => item.path === "/api/launch/plan");
  assert.ok(asked.length >= 1);
  for (const item of asked) {
    assert.equal(item.body.prospective, true);
    assert.equal(item.body.model.card.cardId, REMOTE_ID);
    assert.ok(!("ref" in item.body.model));
  }
  assert.ok(response.json.gpuSets[0].plans.every((plan) => plan.validated?.ok === true));
  const failing = await mountApp(t, { models: { inspectRemoteDetailed: async () => { throw inspectError("gated", 403); } } });
  const gated = await request(failing.port, "/api/launch/recommend", { method: "POST", owner: failing.owner, body: { repo: "example-org/example-model" } });
  assert.equal(gated.status, 403);
  assert.equal(gated.json.error.code, "gated");
});

// --- the viewer registry ----------------------------------------------------------------------------------

test("the 05 registry holds every route of this module: viewer GETs with a redaction, everything else owner-only", async (t) => {
  const app = await mountApp(t);
  const entries = app.registry.inventory().filter((item) => item.owner === "02" && !item.path.startsWith("/api/knowledge"));
  const key = (item) => `${item.method} ${item.path} ${item.access}`;
  assert.deepEqual(entries.map(key).sort(), [
    "GET /api/m/:managerId/models/card viewer",
    "GET /api/models/:id/card viewer",
    "GET /api/models/:id/compatibility viewer",
    "GET /api/models/:id/qualifications viewer",
    "POST /api/launch/recommend admin",
    "POST /api/models/:id/fit-grid admin",
    "POST /api/models/:id/probe admin",
    "POST /api/models/inspect admin",
  ].sort());
  for (const item of modelCardRoutes.viewerRoutes) {
    const found = app.registry.match("GET", item.path.replace(":managerId", "vllm").replace(":id", "mc_aaaaaaaaaaaaaaaaaaaa"));
    assert.equal(found.access, "viewer", item.path);
    assert.equal(typeof found.entry.redact, "function", item.path);
  }
  for (const item of modelCardRoutes.adminOnlyRoutes) {
    const found = app.registry.match(item.method, item.path.replace(":id", "mc_aaaaaaaaaaaaaaaaaaaa"));
    assert.equal(found.access, "admin", `${item.method} ${item.path}`);
  }
  // 05 §5.4: the proxy's unregistered reads stay owner-only.
  for (const owned of ["/api/m/vllm/model/config", "/api/m/vllm/download/precheck", "/api/m/vllm/knowledge/status"]) {
    assert.equal(app.registry.match("GET", owned).access, "admin", owned);
  }
});

test("the proxied manager card is redacted for viewers by the registered redaction", async (t) => {
  const managerCard = {
    ok: true,
    card: { cardId: "mc_cccccccccccccccccccc", displayName: "Model", localPath: "D:\\models\\Model", modelDir: "D:\\models\\Model", support: "unknown", notes: "at C:\\models\\Model\\x" },
  };
  const app = await mountApp(t, { vllm: { "GET /api/models/card": () => [200, managerCard] } });
  const owner = await request(app.port, "/api/m/vllm/models/card?model=Model", { owner: app.owner });
  assert.equal(owner.status, 200);
  assert.equal(owner.json.card.localPath, "D:\\models\\Model");
  const viewer = await request(app.port, "/api/m/vllm/models/card?model=Model");
  assert.equal(viewer.status, 200, viewer.text);
  assert.equal(viewer.json.card.cardId, "mc_cccccccccccccccccccc");
  assert.ok(!("localPath" in viewer.json.card) && !("modelDir" in viewer.json.card));
  assert.ok(!viewer.text.includes("models\\\\Model"), viewer.text);
  // Other model reads of the proxy are unchanged.
  assert.equal((await request(app.port, "/api/m/vllm/model/config?model=Model")).status, 401);
});

test("redactCardBodyForViewer projects a full card to the summary and leaves error bodies alone", () => {
  const full = remoteCardOf();
  full.ref = { kind: "local", path: "C:\\models\\x", displayPath: "x" };
  const out = modelCardRoutes.redactCardBodyForViewer({ ok: true, card: full });
  assert.ok(!("evidence" in out.card) && !("ref" in out.card));
  assert.ok(!JSON.stringify(out).includes("C:\\\\models"));
  const failure = { ok: false, error: { code: "card_not_found" } };
  assert.equal(modelCardRoutes.redactCardBodyForViewer(failure), failure);
});

test("the module refuses to mount without the auth seam", () => {
  assert.throws(() => modelCardRoutes.mount({}), /ctx\.auth is missing/);
  assert.throws(() => modelCardRoutes.createModelCardRoutes({}), /request-auth seam/);
});
