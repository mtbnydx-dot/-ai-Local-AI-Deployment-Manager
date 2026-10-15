"use strict";

// Search, repository detail, link resolution and the plan sheet on the hub
// routes (docs/overhaul/03-hub.md §13.1-13.4, HUB-10), through the real entry.
// Providers, the estimator and the disk are fakes; the hub lives in a temp
// directory and nothing reaches the network.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createModelHub } = require("../../manager-core/model-hub");
const { createModelStorage } = require("../../manager-core/model-storage");
const { normalizeRepoInfo, normalizeSearchItem } = require("../../manager-core/model-hub/providers/huggingface");
const hubRoutes = require("../lib/hub-routes");
const { loadEntry, ownerSession, quietLogger, request, serveEntry } = require("./helpers/entry-harness");

const FIXTURES = path.join(__dirname, "..", "..", "manager-core", "test", "fixtures", "hub");
const LAN = "192.168.1.50";
const GIB = 1024 ** 3;
const MIB = 1024 * 1024;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-discovery-routes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

const MODELS = {
  estimateFit(input) {
    const bytes = input.card ? Number(input.card.weightsBytes) : Number(input.legacy.paramsB) * Number(input.legacy.bytesPerParam) * 1e9;
    const needed = Math.round(bytes / MIB * 1.1 + 1024);
    const total = Math.max(...input.host.gpus.map((gpu) => gpu.totalMb));
    const status = needed <= total * 0.85 ? "ok" : needed <= total ? "warn" : "fail";
    return { status, spill: false, admissionRequestMb: needed, perGpuMb: { 0: needed }, range: { lowMb: needed, highMb: needed }, policy: "gguf-estimate", confidence: "heuristic", headroomMb: total - needed, overflowMb: 0, suggestions: [] };
  },
  async inspectRemote(request) {
    return { cardId: "mc_routes", identity: {}, role: { value: "main" }, evidence: [], weightsBytes: request.files.length * 1e9 };
  },
  async evaluateCompatibility() {
    return [{ engineId: "llamacpp", runtimeId: "llamacpp@b1", verdict: "unknown", supportEvidence: [], reasons: [], actions: [] }];
  },
};

async function startHub(t, { free = 2000 * GIB } = {}) {
  const root = tempDir(t);
  const models = path.join(root, "models");
  fs.mkdirSync(models, { recursive: true });
  const manifest = normalizeRepoInfo(fixture("hf-gguf-multiquant.json"), { repo: "example-org/Example-8B-GGUF", fetchedFrom: "https://huggingface.co" });
  const pages = [
    { items: fixture("hf-search-page1.json").map((raw) => normalizeSearchItem(raw)).filter(Boolean), nextCursor: "/api/models?page=2" },
    { items: fixture("hf-search-page2.json").map((raw) => normalizeSearchItem(raw)).filter(Boolean), nextCursor: null },
  ];
  const warnings = [{ code: "mirror_fallback", message: { zh: "镜像", en: "mirror" }, detail: "timeout (HTTP 504)", from: "https://huggingface.co", to: "https://mirror.example" }];
  const provider = {
    id: "huggingface",
    namespace: "huggingface",
    apiBase: "https://huggingface.co",
    fetchImpl: async () => { throw new Error("not used"); },
    async search(query) {
      const index = query.cursor ? Number(String(query.cursor).split("=").pop()) - 1 : 0;
      return { ...pages[index], fetchedFrom: "https://huggingface.co", warnings: index === 0 ? warnings : [] };
    },
    async getRepo() { return manifest; },
    async getReadme() { return { markdown: "# Example", truncated: false }; },
  };
  const hub = createModelHub({
    aiRoot: root,
    dataDir: path.join(root, "hub"),
    env: {},
    logger: quietLogger(),
    heartbeatMs: 3_600_000,
    providers: { forNamespace: () => provider, get: () => provider },
    modelStorage: createModelStorage({ modelsRoot: models, file: path.join(root, "service-entry", "data", "model-storage.json") }),
    disk: { volumeOf: () => "X:", freeBytes: async () => free, reserveBytes: () => 10 * GIB },
    models: MODELS,
    getGpus: async () => [{ id: "0", name: "Test GPU", totalMb: 24000, freeMb: 24000 }],
    transferEngine: { id: "cli", start(job, hooks) { hooks.onSpawn({ pid: 1, startedAt: new Date().toISOString() }); return { jobId: job.id, stop: () => Promise.resolve(), stderrTail: () => [] }; }, async findOrphans() { return []; } },
    verifier: { verifyArtifact: async () => ({ ok: true }) },
    libraryOptions: { watch: false },
  });
  await hub.start();
  t.after(() => hub.stop());
  return { hub, root, models };
}

async function mountEntry(t, { hub }) {
  const { entry } = await loadEntry();
  const ctx = entry.createRouteContext({ logger: quietLogger(), hub });
  const routes = await entry.mountRouteModules({ ctx });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  const owner = await ownerSession(entry, port);
  return { entry, ctx, port, owner };
}

test("the owner searches with a cursor and facets; a foreign cursor is 400 cursor_mismatch", async (t) => {
  const { hub } = await startHub(t);
  const { port, owner } = await mountEntry(t, { hub });

  const first = await request(port, "/api/hub/search?q=example&limit=2&sort=downloads", { owner });
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.provider, "huggingface");
  assert.equal(first.json.items.length, 2);
  assert.ok(first.json.nextCursor);
  assert.deepEqual(Object.keys(first.json.facets).sort(), ["engine", "fit", "format", "gated", "modality", "moe", "size", "task", "updated"]);
  assert.equal(first.json.warnings[0].detail, "timeout (HTTP 504)", "the owner keeps the warning detail");

  const next = await request(port, `/api/hub/search?q=example&limit=2&sort=downloads&cursor=${encodeURIComponent(first.json.nextCursor)}`, { owner });
  assert.equal(next.status, 200);
  assert.ok(!next.json.items.some((item) => first.json.items.some((seen) => seen.repo === item.repo)));

  const mismatch = await request(port, `/api/hub/search?q=other&limit=2&sort=downloads&cursor=${encodeURIComponent(first.json.nextCursor)}`, { owner });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.ok, false);
  assert.equal(mismatch.json.error.code, "cursor_mismatch");

  const faceted = await request(port, "/api/hub/search?facet=format:gguf&facet=size:8-16b", { owner });
  assert.deepEqual(faceted.json.items.map((item) => item.repo), ["example-org/Example-8B-GGUF"]);
  const bad = await request(port, "/api/hub/search?facet=bogus:1", { owner });
  assert.deepEqual([bad.status, bad.json.error.code], [400, "invalid_request"]);
});

test("a viewer reads search, detail, readme and files without warning details; every write is refused", async (t) => {
  const { hub } = await startHub(t);
  const { port } = await mountEntry(t, { hub });

  const search = await request(port, "/api/hub/search?q=example", { peer: LAN });
  assert.equal(search.status, 200);
  assert.equal(search.json.fetchedFrom, "https://huggingface.co", "fetchedFrom is kept");
  assert.equal(search.json.warnings[0].code, "mirror_fallback");
  assert.equal("detail" in search.json.warnings[0], false, "warnings[].detail is dropped");

  const detail = await request(port, "/api/hub/repos/huggingface/example-org/Example-8B-GGUF", { peer: LAN });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.artifacts.length, 5);
  const readme = await request(port, "/api/hub/repos/huggingface/example-org/Example-8B-GGUF/readme", { peer: LAN });
  assert.deepEqual([readme.status, readme.json.markdown, readme.json.truncated], [200, "# Example", false]);
  const files = await request(port, "/api/hub/repos/huggingface/example-org/Example-8B-GGUF/files?limit=3", { peer: LAN });
  assert.equal(files.status, 200);
  assert.equal(files.json.files.length, 3);
  assert.ok(files.json.nextCursor);

  for (const target of ["/api/hub/plan", "/api/hub/resolve-link"]) {
    const refused = await request(port, target, { method: "POST", peer: LAN, body: { url: "a/b" } });
    assert.equal(refused.status, 401, target);
    assert.equal(refused.json.error.code, "admin_session_required");
  }
});

test("repository detail: the recommended artifact, fit labels with their basis, engines and library state", async (t) => {
  const { hub } = await startHub(t);
  const { port, owner } = await mountEntry(t, { hub });
  const response = await request(port, "/api/hub/repos/huggingface/example-org/Example-8B-GGUF?context=16384&gpuIds=0&engineId=llamacpp", { owner });
  assert.equal(response.status, 200);
  const body = response.json;
  assert.equal(body.ok, true);
  assert.equal(body.provider, "huggingface");
  assert.equal(body.repo, "example-org/Example-8B-GGUF");
  assert.equal(body.revisionSha.length, 40);
  assert.equal(body.artifacts.filter((artifact) => artifact.recommended).length, 1);
  const recommended = body.artifacts.find((artifact) => artifact.recommended);
  assert.equal(recommended.fit.basis, "card");
  assert.equal(recommended.fit.label, "fits");
  for (const artifact of body.artifacts.filter((item) => !item.recommended)) assert.equal(artifact.fit.basis, "params");
  for (const artifact of body.artifacts) {
    assert.deepEqual(artifact.library, { state: "absent", entryId: null });
    assert.deepEqual(artifact.engines, [{ engineId: "llamacpp", basis: "format" }]);
  }
  assert.equal(body.card.cardId, "mc_routes");
  assert.equal(body.compatibility[0].engineId, "llamacpp");

  const bad = await request(port, "/api/hub/repos/huggingface/not/a/repo/extra", { owner });
  assert.equal(bad.status, 404);
  const wrongProvider = await request(port, "/api/hub/repos/gitlab/example-org/Example-8B-GGUF", { owner });
  assert.deepEqual([wrongProvider.status, wrongProvider.json.error.code], [400, "invalid_request"]);
  const wrongRevision = await request(port, "/api/hub/repos/huggingface/example-org/Example-8B-GGUF?revision=%20bad", { owner });
  assert.equal(wrongRevision.status, 400);
});

test("resolve-link, plan and a download from the planId", async (t) => {
  const { hub, models } = await startHub(t);
  const { port, owner } = await mountEntry(t, { hub });

  const link = await request(port, "/api/hub/resolve-link", { method: "POST", owner, body: { url: "https://huggingface.co/example-org/Example-8B-GGUF/blob/main/Example-8B-Q4_K_M.gguf" } });
  assert.deepEqual(link.json, { ok: true, provider: "huggingface", repo: "example-org/Example-8B-GGUF", revision: "main", file: "Example-8B-Q4_K_M.gguf" });
  const unknownHost = await request(port, "/api/hub/resolve-link", { method: "POST", owner, body: { url: "https://example.com/a/b" } });
  assert.deepEqual([unknownHost.status, unknownHost.json.error.code], [422, "unrecognized_link"]);
  const notString = await request(port, "/api/hub/resolve-link", { method: "POST", owner, body: { url: 3 } });
  assert.deepEqual([notString.status, notString.json.error.code], [400, "invalid_request"]);

  const planned = await request(port, "/api/hub/plan", { method: "POST", owner, body: { provider: "huggingface", repo: "example-org/Example-8B-GGUF", selection: { artifactKey: "gguf:|Q4_K_M" }, fit: { contextTokens: 8192 } } });
  assert.equal(planned.status, 200);
  assert.equal(planned.json.ok, true);
  assert.match(planned.json.planId, /^pln_/);
  assert.equal(planned.json.target.localDir, path.join(models, "example-org-Example-8B-GGUF"));
  assert.deepEqual(planned.json.blocking, []);
  assert.equal(planned.json.fit.basis, "card");

  const missing = await request(port, "/api/hub/plan", { method: "POST", owner, body: { provider: "huggingface", repo: "example-org/Example-8B-GGUF", selection: { artifactKey: "gguf:|NOPE" } } });
  assert.deepEqual([missing.status, missing.json.error.code], [422, "artifact_not_found"]);
  const noRepo = await request(port, "/api/hub/plan", { method: "POST", owner, body: {} });
  assert.deepEqual([noRepo.status, noRepo.json.error.code], [400, "invalid_request"]);
  // A token on a plan is for the local owner only, and never echoed.
  const lanToken = await request(port, "/api/hub/plan", { method: "POST", peer: LAN, body: { repo: "a/b", credential: { hfToken: "hf_x" } } });
  assert.ok([401, 403].includes(lanToken.status));

  const created = await request(port, "/api/hub/downloads", { method: "POST", owner, body: { planId: planned.json.planId } });
  assert.equal(created.status, 201);
  assert.equal(created.json.job.target.localDir, planned.json.target.localDir);
  assert.equal(created.json.job.artifact.artifactKey, "gguf:|Q4_K_M");
  const again = await request(port, "/api/hub/downloads", { method: "POST", owner, body: { planId: planned.json.planId } });
  assert.deepEqual([again.status, again.json.error.code], [404, "plan_not_found"]);
});

test("a blocked plan answers 200 with blocking[], and a download from it is 422 plan_blocked", async (t) => {
  const { hub } = await startHub(t, { free: 12 * GIB });
  const { port, owner } = await mountEntry(t, { hub });
  const planned = await request(port, "/api/hub/plan", { method: "POST", owner, body: { provider: "huggingface", repo: "example-org/Example-8B-GGUF", selection: { artifactKey: "gguf:|Q8_0" } } });
  assert.equal(planned.status, 200);
  assert.equal(planned.json.blocking[0].code, "disk_full");
  const refused = await request(port, "/api/hub/downloads", { method: "POST", owner, body: { planId: planned.json.planId } });
  assert.equal(refused.status, 422);
  assert.equal(refused.json.error.code, "plan_blocked");
  assert.equal(refused.json.error.details.blocking[0].code, "disk_full");
});

test("the route table names the new rows and the viewer registry covers the new GETs", () => {
  const key = (route) => `${route.method} ${route.path}`;
  const served = new Set(hubRoutes.HUB_ROUTES.map(key));
  for (const row of ["GET /api/hub/search", "GET /api/hub/repos/:provider/:owner/:name", "GET /api/hub/repos/:provider/:owner/:name/readme", "GET /api/hub/repos/:provider/:owner/:name/files", "POST /api/hub/resolve-link", "POST /api/hub/plan"]) {
    assert.ok(served.has(row), row);
  }
  const declared = new Set([...hubRoutes.HUB_VIEWER_ROUTES, ...hubRoutes.HUB_ADMIN_ONLY_ROUTES].map(key));
  for (const route of hubRoutes.HUB_ROUTES.filter((item) => item.method === "GET")) assert.ok(declared.has(key(route)), key(route));
  assert.deepEqual(hubRoutes.redactDiscoveryForViewer({ ok: true, warnings: [{ code: "x", detail: "d" }] }), { ok: true, warnings: [{ code: "x" }] });
  assert.deepEqual(hubRoutes.redactDiscoveryForViewer({ ok: true }), { ok: true });
});
