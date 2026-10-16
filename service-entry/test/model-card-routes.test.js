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

async function mountApp(t, { vllm = {}, llama = {}, vllmDown = false, llamaDown = false, models = {}, hostRecords = null, gpus = [FAKE_GPU], roots = null, cards = {} } = {}) {
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
      ...cards,
    },
  });
  const routes = await entry.mountRouteModules({ ctx, modules: MODULES });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  const owner = await ownerSession(entry, port);
  return { entry, ctx, routes, port, owner, library, cacheDir, hostRecordsFile, vllm: vllmManager, llama: llamaManager, registry: ctx.auth.viewerRegistry };
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
  for (const [route, body] of [["/api/launch/recommend", { path: dir }], ["/api/models/mc_aaaaaaaaaaaaaaaaaaaa/probe", { engineId: "vllm" }], ["/api/models/mc_aaaaaaaaaaaaaaaaaaaa/fit-grid", { engineId: "vllm" }], ["/api/models/mc_aaaaaaaaaaaaaaaaaaaa/qualify", { fleetId: "vllm:primary" }], ["/api/models/mc_aaaaaaaaaaaaaaaaaaaa/qualifications/import", { managerId: "vllm", jobId: "j1" }]]) {
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
    "POST /api/launches/:launchId/save-recipe admin",
    "POST /api/models/:id/fit-grid admin",
    "POST /api/models/:id/probe admin",
    "POST /api/models/:id/qualifications/import admin",
    "POST /api/models/:id/qualify admin",
    "POST /api/models/inspect admin",
  ].sort());
  for (const item of modelCardRoutes.viewerRoutes) {
    const found = app.registry.match("GET", item.path.replace(":managerId", "vllm").replace(":id", "mc_aaaaaaaaaaaaaaaaaaaa"));
    assert.equal(found.access, "viewer", item.path);
    assert.equal(typeof found.entry.redact, "function", item.path);
  }
  for (const item of modelCardRoutes.adminOnlyRoutes) {
    const found = app.registry.match(item.method, item.path.replace(":id", "mc_aaaaaaaaaaaaaaaaaaaa").replace(":launchId", "lch_aaaaaaaaaaaaaaaaaaaa"));
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

// --- MOD-16: qualify, host records, auto-qualify --------------------------------------------

const internalAuth = require("../../manager-core/internal-auth");

const HOST_RECORDS_URL = "/internal/models/host-records";

function recordFor(card, extra = {}) {
  return {
    id: `qr_${"a".repeat(20)}`,
    contentDigest: card.contentDigest,
    cardId: card.cardId,
    engineId: "vllm",
    runtimeId: "vllm@0.28.0",
    recipeId: null,
    paramsKey: "8192|4|auto|0",
    launchId: null,
    fleetId: "vllm:primary",
    host: { gpu: "Test GPU", computeCap: "12.0", driver: null },
    at: "2026-10-15T00:00:00.000Z",
    durationMs: 61000,
    results: [
      { check: "chat", status: "pass", detail: { zh: "回答：pong", en: "Answer: pong" }, metrics: {} },
      { check: "tool-call", status: "pass", detail: { zh: "工具调用往返成功。", en: "Tool round trip works." }, metrics: {} },
      { check: "vision", status: "fail", detail: { zh: "没有认出红色图片。", en: "The red image was not recognised." }, metrics: {} },
    ],
    observed: { peakMb: { 0: 4096 }, engineFacts: { servedModel: "m" } },
    ...extra,
  };
}

// A signed manager push (the same signing the managers use) over loopback.
function pushRecord(app, body, { token, managerId = "vllm-manager", peer, signature = true } = {}) {
  const text = JSON.stringify(body);
  const secret = token || app.ctx.security.getTrustToken();
  return request(app.port, HOST_RECORDS_URL, {
    method: "POST",
    body: text,
    peer,
    headers: signature ? internalAuth.buildInternalRequestHeaders(secret, "POST", HOST_RECORDS_URL, managerId, text) : {},
  });
}

function startQualification(app, card, extra = {}) {
  return request(app.port, `/api/models/${card.cardId}/qualify`, { method: "POST", owner: app.owner, body: { fleetId: "vllm:primary", ...extra } });
}

function libraryEvents(app) {
  const seen = [];
  const stop = app.ctx.bus.subscribe((envelope) => seen.push(envelope), { types: ["library"] });
  return { seen, stop };
}

test("POST /api/models/:id/qualify starts the suite on the manager that hosts the instance and relays its errors", async (t) => {
  let answer = () => [202, { ok: true, jobId: "job_q1", managerId: "vllm" }];
  const app = await mountApp(t, { vllm: { "POST /api/qualify": (body) => answer(body) } });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const card = (await inspectOwned(app, dir)).json.card;
  const started = await startQualification(app, card, { checks: ["chat", "tool-call"], needle: false });
  assert.equal(started.status, 202, started.text);
  assert.deepEqual({ ok: started.json.ok, jobId: started.json.jobId, managerId: started.json.managerId }, { ok: true, jobId: "job_q1", managerId: "vllm" });
  const sent = app.vllm.seen.find((item) => item.path === "/api/qualify");
  assert.deepEqual(sent.body, { instanceId: "primary", cardId: card.cardId, checks: ["chat", "tool-call"], needle: false });
  assert.match(sent.headers["x-request-id"], /^req_/);
  assert.equal(app.llama.seen.length, 0);

  // Defaults: no checks (the manager's default set); llama instances go to the llama manager.
  await request(app.port, `/api/models/${card.cardId}/qualify`, { method: "POST", owner: app.owner, body: { fleetId: "llama:inst-2", needle: true } });
  assert.ok(app.llama.seen.some((item) => item.path === "/api/qualify" && item.body.instanceId === "inst-2" && item.body.needle === true && !("checks" in item.body)));

  answer = () => [404, { ok: false, error: { code: "instance_not_found", message: "This manager has no such instance." } }];
  const gone = await startQualification(app, card);
  assert.equal(gone.status, 404);
  assert.equal(gone.json.error.code, "instance_not_found");
  answer = () => [409, { ok: false, error: { code: "instance_busy", message: "Another qualification or benchmark is running on this instance." }, jobId: "job_other" }];
  const busy = await startQualification(app, card);
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error.code, "instance_busy");
  assert.equal(busy.json.jobId, "job_other");

  const bad = await startQualification(app, card, { fleetId: "elsewhere", checks: ["nope"], needle: "yes" });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json.errors.map((item) => item.field).sort(), ["checks", "fleetId", "needle"]);
  const noCard = await request(app.port, "/api/models/mc_bbbbbbbbbbbbbbbbbbbb/qualify", { method: "POST", owner: app.owner, body: { fleetId: "vllm:primary" } });
  assert.equal(noCard.status, 404);
  assert.equal(noCard.json.error.code, "card_not_found");
});

test("a qualify of a manager that is not running answers 503 manager_unreachable", async (t) => {
  const app = await mountApp(t, { vllmDown: true });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const card = (await inspectOwned(app, dir)).json.card;
  const down = await startQualification(app, card);
  assert.equal(down.status, 503);
  assert.equal(down.json.error.code, "manager_unreachable");
});

test("POST /internal/models/host-records: signed, loopback, for a job the entry started; atomic write, library event, evidence", async (t) => {
  const app = await mountApp(t, { vllm: { "POST /api/qualify": () => [202, { ok: true, jobId: "job_q1", managerId: "vllm" }] } });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const card = (await inspectOwned(app, dir)).json.card;
  const events = libraryEvents(app);
  t.after(events.stop);
  const record = recordFor(card);

  // Before any qualification was started: an unknown job is refused and nothing is written.
  const unknown = await pushRecord(app, { ...record, jobId: "job_q1" });
  assert.equal(unknown.status, 409);
  assert.equal(unknown.json.error.code, "job_mismatch");
  assert.equal(fs.existsSync(app.hostRecordsFile), false);

  assert.equal((await startQualification(app, card)).status, 202);

  // Authentication: no signature, a bad HMAC, a manager that is not one of ours, a non-loopback socket.
  const unsigned = await pushRecord(app, { ...record, jobId: "job_q1" }, { signature: false });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.json.error.code, "internal_auth_failed");
  const forged = await pushRecord(app, { ...record, jobId: "job_q1" }, { token: "not-the-trust-token" });
  assert.equal(forged.status, 401);
  assert.equal(forged.json.error.code, "internal_auth_failed");
  const stranger = await pushRecord(app, { ...record, jobId: "job_q1" }, { managerId: "other-manager" });
  assert.equal(stranger.status, 401);
  const remote = await pushRecord(app, { ...record, jobId: "job_q1" }, { peer: "192.168.1.50" });
  assert.ok([401, 403].includes(remote.status), `a LAN peer is refused (${remote.status})`);
  assert.equal(fs.existsSync(app.hostRecordsFile), false, "nothing is written by a refused caller");
  assert.equal(events.seen.length, 0);

  // The record must match the job: manager, fleet, digest, card.
  const wrong = [
    ["another manager", { ...record, fleetId: "llama:primary", jobId: "job_q1" }],
    ["another instance", { ...record, fleetId: "vllm:other", jobId: "job_q1" }],
    ["another model", { ...record, contentDigest: `sha256:${"f".repeat(64)}`, jobId: "job_q1" }],
    ["another card", { ...record, cardId: "mc_bbbbbbbbbbbbbbbbbbbb", jobId: "job_q1" }],
    ["another job", { ...record, jobId: "job_zzz" }],
  ];
  for (const [label, body] of wrong) {
    const refused = await pushRecord(app, body);
    assert.equal(refused.status, 409, label);
    assert.equal(refused.json.error.code, "job_mismatch", label);
  }
  const llama = await pushRecord(app, { ...record, jobId: "job_q1" }, { managerId: "llama-manager" });
  assert.equal(llama.status, 409, "the llama manager cannot report the vllm job");

  const invalid = await pushRecord(app, { ...record, runtimeId: "", results: [], jobId: "job_q1" });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.json.error.code, "invalid_record");
  assert.ok(invalid.json.errors.some((item) => item.field === "runtimeId"));
  assert.ok(invalid.json.errors.some((item) => item.field === "results"));
  assert.equal((await pushRecord(app, { ...record })).status, 422, "a record without its jobId");

  const stored = await pushRecord(app, { ...record, jobId: "job_q1" });
  assert.equal(stored.status, 200, stored.text);
  assert.deepEqual(stored.json, { ok: true, id: record.id });
  const file = JSON.parse(fs.readFileSync(app.hostRecordsFile, "utf8"));
  assert.equal(file.schemaVersion, 1);
  assert.equal(file.records.length, 1);
  assert.equal(file.records[0].id, record.id);
  assert.deepEqual(fs.readdirSync(path.dirname(app.hostRecordsFile)).filter((name) => name.endsWith(".tmp")), []);

  // One library event {kind: "qualification", ...} per stored record.
  assert.equal(events.seen.length, 1);
  assert.equal(events.seen[0].type, "library");
  const { summary, ...data } = events.seen[0].data;
  assert.deepEqual(data, { kind: "qualification", cardId: card.cardId, contentDigest: card.contentDigest, recordId: record.id });
  assert.deepEqual(summary, { pass: 2, warn: 0, fail: 1, skip: 0, total: 3, runtimeId: "vllm@0.28.0" });

  // A re-push of the same record (lost response) is idempotent; another record for the job is not accepted.
  const again = await pushRecord(app, { ...record, jobId: "job_q1" });
  assert.deepEqual(again.json, { ok: true, id: record.id, duplicate: true });
  assert.equal(events.seen.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(app.hostRecordsFile, "utf8")).records.length, 1);
  const second = await pushRecord(app, { ...recordFor(card, { id: `qr_${"b".repeat(20)}` }), jobId: "job_q1" });
  assert.equal(second.status, 409);

  // The records are listed (viewers without detail), and passes are verified-on-host evidence on the card.
  const listed = await request(app.port, `/api/models/${card.cardId}/qualifications`, { owner: app.owner });
  assert.equal(listed.json.records.length, 1);
  assert.equal(listed.json.records[0].results[0].detail.en, "Answer: pong");
  const viewer = await request(app.port, `/api/models/${card.cardId}/qualifications`);
  assert.equal(viewer.status, 200);
  assert.ok(!("detail" in viewer.json.records[0].results[0]));
  assert.ok(!("driver" in viewer.json.records[0].host));
  const full = await request(app.port, `/api/models/${card.cardId}/card?view=full`, { owner: app.owner });
  const verified = full.json.card.evidence.filter((entry) => entry.confidence === "verified-on-host");
  assert.deepEqual(verified.map((entry) => entry.fact).sort(), ["/capabilities/tools", "/identity"]);
  assert.ok(verified.every((entry) => entry.source.kind === "qualification" && entry.source.ref === record.id));
  const cached = await request(app.port, `/api/models/${card.cardId}/card?view=full`, { owner: app.owner });
  assert.equal(cached.json.card.evidence.filter((entry) => entry.confidence === "verified-on-host").length, 2, "evidence is attached per read, never accumulated in the cache");
  // The passing checks make the engine row verified-on-host support in the compatibility matrix.
  const compat = await request(app.port, `/api/models/${card.cardId}/compatibility?engines=vllm`, { owner: app.owner });
  assert.ok(compat.json.rows.some((row) => row.runtimeId === "vllm@0.28.0" && row.supportEvidence.some((item) => item.kind === "verified-on-host")));
});

test("the internal endpoint takes POST only and a bounded body", async (t) => {
  const app = await mountApp(t);
  const get = await request(app.port, HOST_RECORDS_URL);
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, "POST");
  const big = await pushRecord(app, { junk: "x".repeat(200 * 1024) });
  assert.equal(big.status, 413);
  assert.equal(fs.existsSync(app.hostRecordsFile), false);
});

test("POST /api/models/:id/qualifications/import pulls the record a manager could not push", async (t) => {
  const state = { job: null };
  const app = await mountApp(t, { vllm: { "GET /api/jobs/job_q2": () => (state.job ? [200, state.job] : [404, { error: "Job not found" }]) } });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const card = (await inspectOwned(app, dir)).json.card;
  const events = libraryEvents(app);
  t.after(events.stop);
  const url = `/api/models/${card.cardId}/qualifications/import`;
  const post = (body) => request(app.port, url, { method: "POST", owner: app.owner, body });

  assert.equal((await post({ managerId: "vllm", jobId: "job_q2" })).json.error.code, "job_not_found");
  assert.equal((await post({ managerId: "nope", jobId: "bad id" })).status, 400);
  state.job = { id: "job_q2", type: "model-probe", meta: {}, result: {} };
  assert.equal((await post({ managerId: "vllm", jobId: "job_q2" })).json.error.code, "job_not_found", "only a qualification job");
  state.job = { id: "job_q2", type: "model-qualify", status: "running", meta: { instanceId: "primary", contentDigest: card.contentDigest } };
  const early = await post({ managerId: "vllm", jobId: "job_q2" });
  assert.equal(early.status, 409);
  assert.equal(early.json.error.code, "no_host_record");

  const record = recordFor(card);
  state.job = { id: "job_q2", type: "model-qualify", status: "success", meta: { instanceId: "primary", contentDigest: card.contentDigest }, result: { hostRecord: { ...record, contentDigest: `sha256:${"e".repeat(64)}` } } };
  assert.equal((await post({ managerId: "vllm", jobId: "job_q2" })).json.error.code, "job_mismatch", "another model's record");
  state.job.result.hostRecord = { ...record, fleetId: "vllm:other" };
  assert.equal((await post({ managerId: "vllm", jobId: "job_q2" })).json.error.code, "job_mismatch", "another instance's record");
  state.job.result.hostRecord = { ...record, runtimeId: "" };
  assert.equal((await post({ managerId: "vllm", jobId: "job_q2" })).status, 422);

  state.job.result.hostRecord = record;
  const imported = await post({ managerId: "vllm", jobId: "job_q2" });
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.json.record.id, record.id);
  assert.equal(JSON.parse(fs.readFileSync(app.hostRecordsFile, "utf8")).records.length, 1);
  assert.equal(events.seen.length, 1);
  const again = await post({ managerId: "vllm", jobId: "job_q2" });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "already_recorded");
  // Admin only: no session, no import.
  assert.equal((await request(app.port, url, { method: "POST", body: { managerId: "vllm", jobId: "job_q2" } })).status, 401);
});

// A fake vllm manager that knows one launch (served from the instance list and its launch record).
function launchManager(dir, { qualifyAnswer = () => [202, { ok: true, jobId: "job_auto", managerId: "vllm" }] } = {}) {
  const launchId = "lch_aaaaaaaaaaaaaaaaaaaa";
  const record = { launchId, spec: { engineId: "vllm", runtimeId: "vllm@0.28.0", recipeId: null, model: { ref: dir } }, resolved: { paramsKey: "8192|4|auto|0" } };
  return {
    launchId,
    answers: {
      "GET /api/instances": () => [200, { ok: true, instances: [{ id: "primary", launchId, runtime: { id: "vllm@0.28.0" }, recipeId: null }] }],
      "GET /api/instances/primary/launch": () => [200, { ok: true, launch: record }],
      "POST /api/qualify": (body) => qualifyAnswer(body),
    },
  };
}

function serveJob(id, launchId, extra = {}) {
  return { id, type: "serve", status: "success", finishedAt: new Date().toISOString(), meta: { launchId }, ...extra };
}

function publishJobs(app, managerId, jobs) {
  app.ctx.bus.publish("jobs", { managerId, jobs, removed: [] });
}

function moduleApi(app) {
  return app.routes.modules.find((item) => item.name === "model-cards").api;
}

test("auto-qualify: a serve job that became ready starts the light suite once, only when models.autoQualify allows", async (t) => {
  let mode = "first-launch";
  const answers = {};
  const app = await mountApp(t, { vllm: answers, cards: { getAutoQualify: () => mode } });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const launch = launchManager(dir);
  Object.assign(answers, launch.answers);
  const card = (await inspectOwned(app, dir)).json.card;
  const launchId = launch.launchId;
  const qualifyCalls = () => app.vllm.seen.filter((item) => item.method === "POST" && item.path === "/api/qualify");

  // A non-serve job, a running serve job, a failed one, a stale one and one without a launch start nothing.
  publishJobs(app, "vllm", [
    { id: "dl1", type: "download", status: "success", finishedAt: new Date().toISOString(), meta: { launchId } },
    serveJob("s0", launchId, { status: "running" }),
    serveJob("s0b", launchId, { status: "failed" }),
    serveJob("s0c", launchId, { finishedAt: "2026-01-01T00:00:00.000Z" }),
    serveJob("s0d", ""),
  ]);
  await moduleApi(app).settle();
  assert.equal(qualifyCalls().length, 0);

  // mode off: nothing.
  mode = "off";
  publishJobs(app, "vllm", [serveJob("s1", launchId)]);
  await moduleApi(app).settle();
  assert.equal(qualifyCalls().length, 0);

  // first-launch: the light set, one request for throughput (light), on the instance of the launch.
  mode = "first-launch";
  publishJobs(app, "vllm", [serveJob("s2", launchId)]);
  await moduleApi(app).settle();
  assert.equal(qualifyCalls().length, 1);
  assert.deepEqual(qualifyCalls()[0].body, {
    instanceId: "primary",
    cardId: card.cardId,
    checks: ["models", "chat", "reasoning-split", "tool-call", "json-output", "vision", "throughput"],
    needle: false,
    light: true,
  });

  // The same job again, or a stream update of the same job, does nothing.
  publishJobs(app, "vllm", [serveJob("s2", launchId)]);
  await moduleApi(app).settle();
  assert.equal(qualifyCalls().length, 1);

  // While the first run is unreported, the same instance is not started again.
  publishJobs(app, "vllm", [serveJob("s3", launchId)]);
  await moduleApi(app).settle();
  assert.equal(qualifyCalls().length, 1);

  // The report arrives: the host record exists, so first-launch skips; "always" qualifies again.
  const record = recordFor(card);
  assert.equal((await pushRecord(app, { ...record, jobId: "job_auto" })).status, 200);
  publishJobs(app, "vllm", [serveJob("s4", launchId)]);
  await moduleApi(app).settle();
  assert.equal(qualifyCalls().length, 1, "a covered (digest, runtime, params) is not qualified again");
  mode = "always";
  publishJobs(app, "vllm", [serveJob("s5", launchId)]);
  await moduleApi(app).settle();
  assert.equal(qualifyCalls().length, 2);

  // The llama manager's jobs are relayed too, but this launch is not known there: nothing happens.
  mode = "first-launch";
  publishJobs(app, "llama", [serveJob("l1", launchId)]);
  await moduleApi(app).settle();
  assert.equal(qualifyCalls().length, 2);
});

test("auto-qualify never retries a launch whose instance is busy (a benchmark or another qualification runs)", async (t) => {
  const answers = {};
  const app = await mountApp(t, { vllm: answers, cards: { getAutoQualify: () => "first-launch" } });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const launch = launchManager(dir, { qualifyAnswer: () => [409, { ok: false, error: { code: "instance_busy", message: "busy" } }] });
  Object.assign(answers, launch.answers);
  const calls = () => app.vllm.seen.filter((item) => item.method === "POST" && item.path === "/api/qualify").length;
  publishJobs(app, "vllm", [serveJob("b1", launch.launchId)]);
  await moduleApi(app).settle();
  assert.equal(calls(), 1);
  publishJobs(app, "vllm", [serveJob("b2", launch.launchId)]);
  await moduleApi(app).settle();
  assert.equal(calls(), 1, "the 409 is final for this launch");
  assert.equal(fs.existsSync(app.hostRecordsFile), false);
});

test("auto-qualify reads the launch from GET launches/:launchId when the manager serves it, and skips what it cannot resolve", async (t) => {
  const answers = {};
  const app = await mountApp(t, { vllm: answers, cards: { getAutoQualify: () => "always" } });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const launchId = "lch_bbbbbbbbbbbbbbbbbbbb";
  Object.assign(answers, {
    [`GET /api/launches/${launchId}`]: () => [200, { ok: true, launch: { launchId, spec: { engineId: "vllm", runtimeId: "vllm@0.28.0", model: { ref: dir }, instance: { id: "second" } }, resolved: {} } }],
    "GET /api/instances": () => [200, { ok: true, instances: [] }],
    "POST /api/qualify": () => [202, { ok: true, jobId: "job_x", managerId: "vllm" }],
  });
  const calls = () => app.vllm.seen.filter((item) => item.method === "POST" && item.path === "/api/qualify");
  publishJobs(app, "vllm", [serveJob("c1", launchId)]);
  await moduleApi(app).settle();
  assert.equal(calls().length, 1);
  assert.equal(calls()[0].body.instanceId, "second", "the launch's own instance id when the instance list does not show it");
  // An unknown launch (no record anywhere) and a model outside the library start nothing.
  publishJobs(app, "vllm", [serveJob("c2", "lch_cccccccccccccccccccc")]);
  await moduleApi(app).settle();
  assert.equal(calls().length, 1);
  Object.assign(answers, { "GET /api/launches/lch_dddddddddddddddddddd": () => [200, { ok: true, launch: { launchId: "lch_dddddddddddddddddddd", spec: { engineId: "vllm", model: { ref: "/nowhere/outside" } } } }] });
  publishJobs(app, "vllm", [serveJob("c3", "lch_dddddddddddddddddddd")]);
  await moduleApi(app).settle();
  assert.equal(calls().length, 1);
});

test("models.autoQualify is read from platform.json (first-launch by default), and the module stops listening when closed", async (t) => {
  const root = tempDir(t, "auto-qualify-config-");
  assert.equal(modelCardRoutes.readAutoQualify(root), "first-launch");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "platform.json"), JSON.stringify({ models: { autoQualify: "off" } }));
  assert.equal(modelCardRoutes.readAutoQualify(root), "off");
  fs.writeFileSync(path.join(root, "config", "platform.json"), JSON.stringify({ models: { autoQualify: "sometimes" } }));
  assert.equal(modelCardRoutes.readAutoQualify(root), "first-launch", "an invalid value falls back to the default");

  const answers = {};
  const app = await mountApp(t, { vllm: answers, cards: { getAutoQualify: () => "always" } });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const launch = launchManager(dir);
  Object.assign(answers, launch.answers);
  moduleApi(app).close();
  publishJobs(app, "vllm", [serveJob("z1", launch.launchId)]);
  await moduleApi(app).settle();
  assert.equal(app.vllm.seen.filter((item) => item.path === "/api/qualify").length, 0);
});

// --- MOD-17: save a working launch as a recipe ----------------------------------------------

const FAKE_SECRET = ("sk-" + "test-0123456789abcdefghijklmnop");
const SAVE_LAUNCH_ID = "lch_bbbbbbbbbbbbbbbbbbbb";

// The LaunchStore record of a working launch: effective values with provenance, plus the fields a recipe must not copy.
function savedLaunchRecord(dir, extra = {}) {
  return {
    launchId: SAVE_LAUNCH_ID,
    managerId: "vllm",
    status: "running",
    jobId: "job_serve1",
    spec: {
      engineId: "vllm",
      runtimeId: "vllm@0.28.0",
      recipeId: null,
      model: { ref: dir, servedName: "served-model", contentDigest: null },
      instance: { mode: "replace", id: "primary", port: 8000, networkAccess: "local", gpuIds: ["0"] },
      values: { contextLength: 8192, concurrency: 4 },
      extraArgs: ["--some-flag", "value"],
      extraEnv: { MY_TOKEN: FAKE_SECRET },
      secrets: { apiKeyRef: "ref-1" },
    },
    resolved: {
      paramsKey: "8192|4|auto|0",
      values: {
        contextLength: { value: 8192, source: "user" },
        concurrency: { value: 4, source: "planner" },
        trustRemoteCode: { value: true, source: "model" },
        kvCacheDtype: { value: "auto", source: "engine-default" },
        prefixCaching: { value: true, source: "platform-default" },
        servedName: { value: "served-model", source: "user" },
        tokenizer: { value: path.join(os.tmpdir(), "tokenizer-dir"), source: "user" },
        apiKey: { value: FAKE_SECRET, source: "user" },
      },
    },
    ...extra,
  };
}

// The fixtures carry no family; this wrapper gives the inspected model one.
function familyModels() {
  return {
    inspectLocalDetailed: async (...args) => {
      const result = await core.models.inspectLocalDetailed(...args);
      return { ...result, card: { ...result.card, identity: { ...result.card.identity, familyId: "qwen3.5" } } };
    },
  };
}

function seedHostRecords(app, records) {
  fs.writeFileSync(app.hostRecordsFile, JSON.stringify({ schemaVersion: 1, records }));
}

// `holder.value` is the launch record the fake manager serves from GET /api/launches/:launchId.
async function mountSaveApp(t, holder, { vllm = {}, llama = {}, launchOn = "vllm", models = familyModels(), ...rest } = {}) {
  const recipesDir = path.join(tempDir(t, "save-recipe-"), "config", "recipes");
  const reload = () => [200, { ok: true, errors: [] }];
  const serve = { [`GET /api/launches/${SAVE_LAUNCH_ID}`]: () => [200, { ok: true, launch: holder.value }] };
  const app = await mountApp(t, {
    vllm: { "POST /api/recipes/reload": reload, ...(launchOn === "vllm" ? serve : {}), ...vllm },
    llama: { "POST /api/recipes/reload": reload, ...(launchOn === "llama" ? serve : {}), ...llama },
    models,
    cards: { recipesDir },
    ...rest,
  });
  const dir = await fixtureIn(t, app, "qwen38-27b-fp8");
  const card = (await inspectOwned(app, dir)).json.card;
  holder.value = savedLaunchRecord(dir);
  return { app, dir, card, recipesDir };
}

function saveRecipe(app, body, { launchId = SAVE_LAUNCH_ID, owner = app.owner } = {}) {
  return request(app.port, `/api/launches/${launchId}/save-recipe`, {
    method: "POST",
    owner,
    body: { recipeId: "my-verified-recipe", title: { zh: "我的配方", en: "My recipe" }, scope: "family", ...body },
  });
}

test("save-recipe writes a validated recipe from a qualified launch, reloads both managers and the planner matches it", async (t) => {
  const holder = {};
  const { app, card, recipesDir, dir } = await mountSaveApp(t, holder);
  seedHostRecords(app, [recordFor(card)]);

  const saved = await saveRecipe(app, { locks: ["contextLength"], notes: "Works well for chat." });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.recipeId, "my-verified-recipe");
  assert.equal(saved.json.path, "config/recipes/my-verified-recipe.json");
  assert.deepEqual(saved.json.reloaded, { vllm: true, llama: true });
  assert.deepEqual(saved.json.warnings, []);

  // The file is the recipe of the response and validates with 01's recipe schema.
  const file = path.join(recipesDir, "my-verified-recipe.json");
  const text = fs.readFileSync(file, "utf8");
  const recipe = JSON.parse(text);
  assert.deepEqual(recipe, saved.json.recipe);
  const verdict = core.engines.recipeSchema.validateRecipe(recipe, {
    catalogs: core.engines.getParamCatalog(),
    registry: core.engines.getEngineRegistry(),
    validateValues: core.engines.paramCatalog.validateValues,
    mode: "override",
  });
  assert.deepEqual(verdict.errors, []);
  assert.deepEqual(verdict.warnings, [], "no deprecated alias warning");

  // Identity is the family (never capability ids); an exact-model digest only for "this-model".
  assert.equal(recipe.kind, "model");
  assert.equal(recipe.status, "verified");
  assert.equal(recipe.engineId, "vllm");
  assert.deepEqual(recipe.runtime, { ref: "vllm", allowOverride: true });
  assert.equal(recipe.match.familyId, "qwen3.5");
  assert.equal(recipe.match.contentDigest, undefined);
  assert.equal(Object.hasOwn(recipe.match, "capabilityIds"), false);
  assert.equal(recipe.match.runtimeId, "vllm@0.28.0");
  assert.deepEqual(recipe.match.quant, ["fp8"]);
  assert.equal(recipe.match.minComputeCapability, "12.0");

  // Only what the owner, the planner or the model chose; locks and evidence are filled in.
  assert.deepEqual(recipe.values, { contextLength: 8192, concurrency: 4, trustRemoteCode: true });
  assert.deepEqual(recipe.locks.map((lock) => [lock.param, lock.value]), [["contextLength", 8192]]);
  assert.deepEqual(recipe.notes, [{ zh: "Works well for chat.", en: "Works well for chat." }]);
  assert.equal(recipe.label.en, "My recipe");
  assert.equal(recipe.evidence.gpu, "Test GPU");
  assert.equal(recipe.evidence.date, "2026-10-15");
  assert.equal(recipe.evidence.jobId, "job_serve1");
  assert.equal(recipe.evidence.launchId, SAVE_LAUNCH_ID);
  assert.equal(recipe.evidence.hostRecordId, `qr_${"a".repeat(20)}`);
  assert.equal(recipe.evidence.measuredPeakMb, 4096);

  // No secrets, host paths, extraArgs or extraEnv anywhere in the file.
  for (const forbidden of [FAKE_SECRET, "extraArgs", "extraEnv", "--some-flag", "MY_TOKEN", "apiKey", "tokenizer", "servedName", "ref-1", os.tmpdir(), dir]) {
    assert.equal(text.includes(forbidden), false, `${forbidden} is not written`);
  }

  // Both managers were asked to reload.
  for (const manager of [app.vllm, app.llama]) {
    assert.equal(manager.seen.filter((item) => item.method === "POST" && item.path === "/api/recipes/reload").length, 1);
  }

  // The planner (01 matchRecipes) picks the saved recipe up for that model on this runtime.
  const store = core.engines.createRecipeStore({ overrideDir: recipesDir });
  assert.equal(store.get("my-verified-recipe")?.status, "verified");
  const matches = core.engines.matchRecipes({
    engineId: "vllm",
    model: { familyId: "qwen3.5", contentDigest: card.contentDigest, quantMethod: "fp8" },
    hostFacts: { platform: "win32", maxComputeCap: "12.0", maxGpuMemoryGb: 96 },
    runtime: { runtimeId: "vllm@0.28.0", manifestKey: "vllm" },
  }, store);
  const mine = matches.find((item) => item.recipe.id === "my-verified-recipe");
  assert.ok(mine, "the saved recipe is a candidate");
  assert.equal(mine.eligible, true);
  assert.ok(mine.reasons.includes("family"));
  assert.equal(matches[0].recipe.id, "my-verified-recipe", "it ranks first for its model");
  const other = core.engines.matchRecipes({ engineId: "vllm", model: { familyId: "another-family" }, runtime: { runtimeId: "vllm@0.28.0", manifestKey: "vllm" } }, store);
  assert.equal(other.find((item) => item.recipe.id === "my-verified-recipe").eligible, false);
});

test("save-recipe for this exact model pins the content digest next to the family", async (t) => {
  const holder = {};
  const { app, card, recipesDir } = await mountSaveApp(t, holder);
  // Qualified through the launch id itself, with no paramsKey in common.
  seedHostRecords(app, [recordFor(card, { launchId: SAVE_LAUNCH_ID, paramsKey: "other" })]);
  const saved = await saveRecipe(app, { scope: "this-model", recipeId: "exact-model-recipe" });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const recipe = JSON.parse(fs.readFileSync(path.join(recipesDir, "exact-model-recipe.json"), "utf8"));
  assert.equal(recipe.match.contentDigest, card.contentDigest.replace(/^sha256:/, ""));
  assert.equal(Object.hasOwn(recipe.match, "capabilityIds"), false);
  const store = core.engines.createRecipeStore({ overrideDir: recipesDir });
  const hit = core.engines.matchRecipes({ engineId: "vllm", model: { contentDigest: card.contentDigest }, runtime: { runtimeId: "vllm@0.28.0", manifestKey: "vllm" } }, store)
    .find((item) => item.recipe.id === "exact-model-recipe");
  assert.equal(hit.eligible, true);
  assert.ok(hit.reasons.includes("content_digest"));
});

test("save-recipe refuses without a passing chat check on this launch", async (t) => {
  const holder = {};
  const { app, card, recipesDir } = await mountSaveApp(t, holder);
  const result = (check, status) => [{ check, status, detail: { zh: "x", en: "x" }, metrics: {} }];
  const refused = async (label) => {
    const answer = await saveRecipe(app, {});
    assert.equal(answer.status, 409, label);
    assert.equal(answer.json.error.code, "not_qualified", label);
    assert.match(answer.json.error.hint, /qualification first/i);
    assert.equal(fs.existsSync(recipesDir), false, `${label}: nothing written`);
  };
  await refused("no record at all");
  seedHostRecords(app, [recordFor(card, { results: result("chat", "fail") })]);
  await refused("chat failed");
  seedHostRecords(app, [recordFor(card, { results: result("tool-call", "pass") })]);
  await refused("no chat check");
  seedHostRecords(app, [recordFor(card, { paramsKey: "another|params" })]);
  await refused("a pass for different parameters");
  seedHostRecords(app, [recordFor(card, { runtimeId: "vllm@0.27.0" })]);
  await refused("a pass for another runtime");
  assert.equal(app.vllm.seen.filter((item) => item.path === "/api/recipes/reload").length, 0, "nothing reloaded");
});

test("save-recipe answers recipe_exists unless overwrite is sent, and never replaces a bundled recipe", async (t) => {
  const holder = {};
  const { app, card, recipesDir } = await mountSaveApp(t, holder);
  seedHostRecords(app, [recordFor(card)]);
  assert.equal((await saveRecipe(app, {})).status, 200);
  const file = path.join(recipesDir, "my-verified-recipe.json");
  const first = fs.readFileSync(file, "utf8");

  const again = await saveRecipe(app, { title: { zh: "新", en: "Newer" } });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "recipe_exists");
  assert.equal(fs.readFileSync(file, "utf8"), first, "the file is untouched");

  const replaced = await saveRecipe(app, { title: { zh: "新", en: "Newer" }, overwrite: true });
  assert.equal(replaced.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).label.en, "Newer");

  const bundledId = fs.readdirSync(core.engines.recipes.BUNDLED_RECIPES_DIR).find((name) => name.endsWith(".json")).replace(/\.json$/, "");
  const bundled = await saveRecipe(app, { recipeId: bundledId, overwrite: true });
  assert.equal(bundled.status, 409);
  assert.equal(bundled.json.error.code, "recipe_exists");
  assert.equal(fs.existsSync(path.join(recipesDir, `${bundledId}.json`)), false);
});

test("save-recipe warns recipe_reload_failed when a manager does not reload, and keeps the file", async (t) => {
  const holder = {};
  const { app, card, recipesDir } = await mountSaveApp(t, holder, {
    llama: { "POST /api/recipes/reload": () => [500, { ok: false, error: { code: "recipe_reload_failed", message: "boom" } }] },
  });
  seedHostRecords(app, [recordFor(card)]);
  const saved = await saveRecipe(app, {});
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.reloaded, { vllm: true, llama: false });
  assert.equal(saved.json.warnings.length, 1);
  assert.equal(saved.json.warnings[0].code, "recipe_reload_failed");
  assert.deepEqual(saved.json.warnings[0].managers, ["llama"]);
  assert.equal(fs.existsSync(path.join(recipesDir, "my-verified-recipe.json")), true);
});

test("save-recipe warns recipe_reload_failed when a manager is not running", async (t) => {
  const holder = {};
  const { app, card } = await mountSaveApp(t, holder, { llamaDown: true });
  seedHostRecords(app, [recordFor(card)]);
  const saved = await saveRecipe(app, {});
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.reloaded, { vllm: true, llama: false });
  assert.equal(saved.json.warnings[0].code, "recipe_reload_failed");
});

test("save-recipe reports field errors as 422 recipe_invalid and writes nothing", async (t) => {
  const holder = {};
  const { app, dir, card, recipesDir } = await mountSaveApp(t, holder);
  seedHostRecords(app, [recordFor(card)]);

  // A lock on a value the recipe does not pin.
  const lock = await saveRecipe(app, { locks: ["kvCacheDtype"] });
  assert.equal(lock.status, 422);
  assert.equal(lock.json.error.code, "recipe_invalid");
  assert.deepEqual(lock.json.errors.map((item) => [item.field, item.code]), [["locks[0]", "lock_not_in_values"]]);

  // A launch whose runtime is not a runtime of its engine.
  holder.value = savedLaunchRecord(dir, { spec: { ...savedLaunchRecord(dir).spec, runtimeId: "vllm@9.9.9" } });
  seedHostRecords(app, [recordFor(card, { runtimeId: "vllm@9.9.9" })]);
  const runtime = await saveRecipe(app, {});
  assert.equal(runtime.status, 422);
  assert.ok(runtime.json.errors.some((item) => item.field === "runtime.ref"));

  // A value that looks like a secret never reaches the file.
  holder.value = savedLaunchRecord(dir);
  holder.value.resolved.values.chatTemplateKwargs = { value: { note: FAKE_SECRET }, source: "user" };
  seedHostRecords(app, [recordFor(card)]);
  const secret = await saveRecipe(app, {});
  assert.equal(secret.status, 422);
  assert.ok(secret.json.errors.some((item) => item.code === "secret_in_recipe"));
  assert.equal(JSON.stringify(secret.json).includes(FAKE_SECRET), false);

  // A launch with nothing the owner, the planner or the model chose.
  holder.value = savedLaunchRecord(dir);
  holder.value.resolved.values = { kvCacheDtype: { value: "auto", source: "engine-default" } };
  const empty = await saveRecipe(app, {});
  assert.equal(empty.status, 422);
  assert.ok(empty.json.errors.some((item) => item.field === "values"));
  assert.equal(fs.existsSync(recipesDir), false);
});

test("save-recipe for a model of an unknown family needs the exact-model scope", async (t) => {
  const holder = {};
  const { app, card, recipesDir } = await mountSaveApp(t, holder, { models: {} });
  seedHostRecords(app, [recordFor(card)]);
  const family = await saveRecipe(app, {});
  assert.equal(family.status, 422);
  assert.deepEqual(family.json.errors.map((item) => item.code), ["family_unknown"]);
  const exact = await saveRecipe(app, { scope: "this-model" });
  assert.equal(exact.status, 200, JSON.stringify(exact.json));
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(recipesDir, "my-verified-recipe.json"), "utf8")).match, "familyId"), false);
});

test("save-recipe validates the body, finds the launch on either manager and needs the owner", async (t) => {
  const holder = {};
  const { app, card, recipesDir } = await mountSaveApp(t, holder, { launchOn: "llama" });
  holder.value.managerId = "llama";
  seedHostRecords(app, [recordFor(card)]);

  const bad = await saveRecipe(app, { recipeId: "Not Valid", scope: "everything", title: { zh: "", en: "x" }, locks: "contextLength", overwrite: "yes" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "invalid_request");
  assert.deepEqual(bad.json.errors.map((item) => item.field).sort(), ["locks", "overwrite", "recipeId", "scope", "title"]);

  assert.equal((await saveRecipe(app, {}, { launchId: "lch_zzzzzzzzzzzzzzzzzzzz" })).json.error.code, "launch_not_found");
  assert.equal((await saveRecipe(app, {}, { launchId: "not-a-launch" })).status, 404);

  const anonymous = await request(app.port, `/api/launches/${SAVE_LAUNCH_ID}/save-recipe`, { method: "POST", body: { recipeId: "x-y" } });
  assert.ok([401, 403].includes(anonymous.status), `an anonymous caller is refused (${anonymous.status})`);
  const getRead = await request(app.port, `/api/launches/${SAVE_LAUNCH_ID}/save-recipe`, { owner: app.owner });
  assert.equal(getRead.status, 405);

  // The launch is kept by the llama manager here (the vllm manager does not know it); the same recipe is written.
  const saved = await saveRecipe(app, {});
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(fs.existsSync(path.join(recipesDir, "my-verified-recipe.json")), true);
});

test("save-recipe answers 503 when no manager that could hold the launch answers", async (t) => {
  const { app } = await mountSaveApp(t, {}, { vllmDown: true, llamaDown: true, launchOn: "none" });
  const result = await saveRecipe(app, {});
  assert.equal(result.status, 503);
  assert.equal(result.json.error.code, "manager_unreachable");
});
