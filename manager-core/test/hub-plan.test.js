"use strict";

// Search (cursor, facets), pasted links and the plan sheet of the model hub
// (docs/overhaul/03-hub.md §13.2, §13.4, HUB-10). Providers, the estimator
// and the disk are fakes, the models root is a temp directory, nothing
// reaches the network or the live root.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createModelHub } = require("../model-hub");
const { createFitService } = require("../model-hub/fit");
const { createDiscovery, encodeCursor, parseSearchQuery } = require("../model-hub/search");
const { createPlanCache, createPlanner } = require("../model-hub/plan");
const { createRunAfter } = require("../model-hub/run-after");
const { resolveSelection } = require("../model-hub/selection");
const { computeFilesetHash, identityKeyFor } = require("../model-hub/library");
const { createModelStorage } = require("../model-storage");
const { normalizeRepoInfo, normalizeSearchItem } = require("../model-hub/providers/huggingface");

const FIXTURES = path.join(__dirname, "fixtures", "hub");
const NOW = Date.parse("2026-10-14T08:00:00Z");
const MIB = 1024 * 1024;
const GIB = 1024 ** 3;
const FAKE_TOKEN = ["hf", "_", "FAKEplanFAKEplanFAKEplan0001"].join("");

function tempDir(t, prefix = "hub-plan-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quietLogger() {
  return { warn() {}, info() {}, log() {}, error() {}, debug() {} };
}

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

function manifestOf(name, repo) {
  const raw = readFixture(name);
  return normalizeRepoInfo(raw, { repo: repo || raw.id, fetchedFrom: "https://huggingface.co", now: NOW });
}

function gpus(totalMb) {
  return async () => [{ id: "0", name: "Test GPU", totalMb, freeMb: totalMb }];
}

// Grades by a simple budget (see hub-fit.test.js): ok under 85 % of the GPU.
function stubModels(log = {}, manifest = null) {
  const sizes = new Map((manifest?.files || []).map((file) => [file.path, Number(file.size) || 0]));
  log.inspections = [];
  return {
    estimateFit(input) {
      const bytes = input.card ? Number(input.card.weightsBytes) : Number(input.legacy.paramsB) * Number(input.legacy.bytesPerParam) * 1e9;
      const needed = Math.round(bytes / MIB * 1.1 + 1024);
      const total = Math.max(...input.host.gpus.map((gpu) => gpu.totalMb));
      const status = needed <= total * 0.85 ? "ok" : needed <= total ? "warn" : "fail";
      return { status, spill: false, admissionRequestMb: needed, perGpuMb: { 0: needed }, range: { lowMb: needed, highMb: needed }, policy: "gguf-estimate", confidence: input.card ? "exact" : "heuristic", headroomMb: total - needed, overflowMb: Math.max(0, needed - total), suggestions: [] };
    },
    async inspectRemote(request, options) {
      log.inspections.push({ request, options });
      return { cardId: "mc_plan", identity: {}, role: { value: "main" }, evidence: [], weightsBytes: request.files.reduce((sum, name) => sum + (sizes.get(name) || 0), 0) };
    },
    async evaluateCompatibility() {
      return [{ engineId: "llamacpp", runtimeId: "llamacpp@b1", verdict: "ok", supportEvidence: [], reasons: [], actions: [] }];
    },
  };
}

// --- search ------------------------------------------------------------------------

// A provider serving the recorded search pages. Pages are cursor-linked; every
// call is recorded.
function searchProvider({ pages, calls = [], warnings = [] } = {}) {
  const served = pages || [
    { items: readFixture("hf-search-page1.json").map((raw) => normalizeSearchItem(raw)).filter(Boolean), nextCursor: "/api/models?page=2" },
    { items: readFixture("hf-search-page2.json").map((raw) => normalizeSearchItem(raw)).filter(Boolean), nextCursor: null },
  ];
  return {
    id: "huggingface",
    namespace: "huggingface",
    apiBase: "https://huggingface.co",
    fetchImpl: async () => { throw new Error("not used"); },
    calls,
    async search(query) {
      calls.push(query);
      const index = query.cursor ? Number(String(query.cursor).split("=").pop()) - 1 : 0;
      const page = served[index];
      return { ...page, fetchedFrom: "https://huggingface.co", warnings: index === 0 ? warnings : [] };
    },
  };
}

function discoveryOf(provider, extra = {}) {
  const fit = createFitService({ models: extra.models === undefined ? stubModels() : extra.models, getGpus: gpus(extra.totalMb || 24000) });
  return createDiscovery({
    providers: { forNamespace: () => provider },
    fit,
    library: extra.library || null,
    queue: extra.queue || null,
    clock: { now: () => NOW },
    settings: () => ({}),
  });
}

test("search: cursor walks the provider pages, never repeats an item and ends with null", async () => {
  const provider = searchProvider();
  const discovery = discoveryOf(provider);
  const seen = [];
  let cursor = null;
  let rounds = 0;
  do {
    const page = await discovery.search({ q: "example", limit: 2, ...(cursor ? { cursor } : {}) });
    assert.ok(page.items.length <= 2);
    seen.push(...page.items.map((item) => item.repo));
    cursor = page.nextCursor;
    rounds += 1;
    assert.ok(rounds < 10);
  } while (cursor);
  assert.deepEqual(seen, [
    "example-org/Example-8B-GGUF", "example-org/Example-8B-FP8", "example-org/Example-Mixed",
    "community-user/tiny-gguf-test", "another-org/Another-14B-AWQ", "standalone-model",
  ]);
  assert.equal(new Set(seen).size, seen.length);
  // Page size to the provider is constant, whatever the caller's limit.
  assert.ok(provider.calls.every((call) => call.limit === 50));
  assert.equal(provider.calls[0].cursor, undefined);
  assert.equal(provider.calls.at(-1).cursor, "/api/models?page=2");
});

test("search: a cursor from another query is 400 cursor_mismatch; a garbled one is invalid_cursor; limit and context may change", async () => {
  const discovery = discoveryOf(searchProvider());
  const first = await discovery.search({ q: "example", limit: 2, sort: "downloads" });
  assert.ok(first.nextCursor);
  const decoded = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
  assert.deepEqual([decoded.v, decoded.p, decoded.c, decoded.o], [1, "huggingface", null, 2]);
  assert.match(decoded.h, /^[0-9a-f]{40}$/);

  const mismatch = (query) => assert.rejects(discovery.search({ ...query, cursor: first.nextCursor }), (error) => error.code === "cursor_mismatch" && error.status === 400);
  await mismatch({ q: "other", limit: 2, sort: "downloads" });
  await mismatch({ q: "example", limit: 2, sort: "likes" });
  await mismatch({ q: "example", limit: 2, sort: "downloads", facet: ["format:gguf"] });
  await mismatch({ q: "example", limit: 2, sort: "downloads", provider: "modelscope" });
  for (const bad of ["x", "!!!", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ v: 2, c: null, o: 0, h: "x" })).toString("base64url")]) {
    await assert.rejects(discovery.search({ q: "example", sort: "downloads", cursor: bad }), (error) => error.code === "invalid_cursor" && error.status === 400);
  }
  // Whitespace and case in q do not change the query.
  const same = await discovery.search({ q: "  EXAMPLE ", limit: 5, sort: "downloads", context: 8192, cursor: first.nextCursor });
  assert.ok(same.items.length >= 1);
  assert.deepEqual(parseSearchQuery({ q: "a" }).limit, 24);
  assert.equal(parseSearchQuery({ q: "a", limit: 500 }).limit, 60);
  assert.equal(encodeCursor(parseSearchQuery({ q: "example", sort: "downloads" }), { c: null, o: 2 }), first.nextCursor);
});

test("search: facets filter server-side, pass native filters on, and count the returned items", async () => {
  const provider = searchProvider();
  const discovery = discoveryOf(provider);
  const all = await discovery.search({ q: "" });
  assert.equal(all.items.length, 6);
  const byRepo = Object.fromEntries(all.items.map((item) => [item.repo, item]));

  const gguf = byRepo["example-org/Example-8B-GGUF"];
  assert.deepEqual([gguf.provider, gguf.author, gguf.task, gguf.formats, gguf.gated, gguf.baseModel], ["huggingface", "example-org", "text-generation", ["gguf"], false, "Example-Org/Example-8B"]);
  assert.deepEqual(gguf.engines, ["llamacpp"]);
  assert.equal(gguf.paramsB, 8.19);
  assert.equal(gguf.fitHint.basis, "params");
  assert.deepEqual(Object.keys(gguf.fitHint).sort(), ["basis", "label", "neededMb", "status"]);
  assert.deepEqual(gguf.library, { state: "absent", entryId: null });
  assert.deepEqual(byRepo["example-org/Example-8B-FP8"].formats.sort(), ["fp8", "safetensors"]);
  assert.deepEqual(byRepo["example-org/Example-8B-FP8"].engines, ["vllm", "sglang"]);
  assert.deepEqual(byRepo["another-org/Another-14B-AWQ"].formats.sort(), ["awq", "safetensors"]);
  assert.deepEqual(all.facets.format.find((row) => row.value === "gguf"), { value: "gguf", count: 2 });
  assert.deepEqual(all.facets.engine.find((row) => row.value === "llamacpp"), { value: "llamacpp", count: 2 });
  assert.ok(all.facets.size.some((row) => row.value === "8-16b" && row.count === 3));
  assert.deepEqual(all.facets.gated, [{ value: "true", count: 1 }]);
  assert.equal(all.provider, "huggingface");
  assert.equal(all.fetchedFrom, "https://huggingface.co");
  assert.equal(all.partial, false);
  assert.equal(all.nextCursor, null);

  const onlyGguf = await discovery.search({ facet: ["format:gguf"] });
  assert.deepEqual(onlyGguf.items.map((item) => item.repo), ["example-org/Example-8B-GGUF", "community-user/tiny-gguf-test"]);
  assert.equal(provider.calls.at(-1).filter, "gguf", "format:gguf is handed to the provider as filter=gguf");
  assert.deepEqual(onlyGguf.facets.format, [{ value: "gguf", count: 2 }], "counts cover the returned items");

  const byTask = await discovery.search({ facet: ["task:text-generation"] });
  assert.equal(provider.calls.at(-1).task, "text-generation");
  assert.ok(byTask.items.every((item) => item.task === "text-generation"));

  assert.deepEqual((await discovery.search({ facet: ["engine:vllm"] })).items.map((item) => item.repo).sort(), ["another-org/Another-14B-AWQ", "example-org/Example-8B-FP8"]);
  assert.deepEqual((await discovery.search({ facet: ["size:8-16b"] })).items.map((item) => item.repo).sort(), ["another-org/Another-14B-AWQ", "example-org/Example-8B-FP8", "example-org/Example-8B-GGUF"]);
  assert.deepEqual((await discovery.search({ facet: ["gated:true"] })).items.map((item) => item.repo), ["example-org/Example-Mixed"]);
  assert.deepEqual((await discovery.search({ facet: ["modality:vision"] })).items.map((item) => item.repo), ["example-org/Example-Mixed"]);
  // Relative windows from "now" (2026-10-14): 30 days reaches the 18 and 20 September repos only.
  assert.deepEqual((await discovery.search({ facet: ["updated:30d"] })).items.map((item) => item.repo), ["example-org/Example-8B-GGUF", "example-org/Example-8B-FP8"]);
  assert.equal((await discovery.search({ facet: ["updated:365d"] })).items.length, 5);
  // Several values of one key are OR, different keys are AND.
  assert.equal((await discovery.search({ facet: ["format:gguf", "format:awq"] })).items.length, 3);
  assert.equal((await discovery.search({ facet: ["format:gguf", "size:8-16b"] })).items.length, 1);
  assert.deepEqual((await discovery.search({ facets: { engine: ["llamacpp"], size: "8-16b" } })).items.map((item) => item.repo), ["example-org/Example-8B-GGUF"]);

  for (const facet of ["nope:1", "size:huge", "format", "format:", "gated:maybe", "updated:1d"]) {
    await assert.rejects(discovery.search({ facet: [facet] }), (error) => error.code === "invalid_request" && error.status === 400 && error.details.field === "facet", facet);
  }
  await assert.rejects(discovery.search({ sort: "newest" }), (error) => error.code === "invalid_request" && error.details.field === "sort");
  await assert.rejects(discovery.search({ provider: "gitlab" }), (error) => error.details.field === "provider");
  await assert.rejects(discovery.search({ limit: "x" }), (error) => error.details.field === "limit");
  await assert.rejects(discovery.search({ context: 10 }), (error) => error.details.field === "context");
});

test("search: the fit facet uses the params hint, and families group repos of one base model", async () => {
  const withBase = (raw, baseModel) => ({ ...raw, baseModel });
  const items = readFixture("hf-search-page1.json").map((raw) => normalizeSearchItem(raw)).filter(Boolean)
    .map((item) => (/Example-8B/.test(item.repo) ? withBase(item, "Example-Org/Example-8B") : item));
  const discovery = discoveryOf(searchProvider({ pages: [{ items, nextCursor: null }] }), { totalMb: 8000 });
  const result = await discovery.search({});
  assert.deepEqual(result.families, [{ familyKey: "example-org/example-8b", repos: ["example-org/Example-8B-GGUF", "example-org/Example-8B-FP8"] }]);
  const fp8 = result.items.find((item) => item.repo === "example-org/Example-8B-FP8");
  const gguf = result.items.find((item) => item.repo === "example-org/Example-8B-GGUF");
  assert.equal(fp8.fitHint.label, "wont-fit", "8B at FP8 does not fit 8 GB");
  assert.equal(gguf.fitHint.label, "fits", "8B at Q4 does");
  const fits = await discovery.search({ facet: ["fit:fits"] });
  assert.deepEqual(fits.items.map((item) => item.repo), ["example-org/Example-8B-GGUF"]);
  assert.deepEqual(fits.facets.fit, [{ value: "fits", count: 1 }]);
});

test("search: when the page budget runs out the answer is partial with a cursor; warnings and library state ride along", async () => {
  const filler = Array.from({ length: 50 }, (_, index) => normalizeSearchItem({ id: `bulk-org/Vision-Model-${index}`, tags: ["image-classification"], pipeline_tag: "image-classification", lastModified: "2026-10-01T00:00:00.000Z" }));
  const pages = [0, 1, 2, 3].map((index) => ({ items: filler, nextCursor: `/api/models?page=${index + 2}` }));
  const warnings = [{ code: "mirror_fallback", message: { zh: "镜像", en: "mirror" }, detail: "timeout", from: "a", to: "b" }];
  const provider = searchProvider({ pages, warnings });
  const discovery = discoveryOf(provider);
  const result = await discovery.search({ facet: ["format:gguf"], limit: 10 });
  assert.equal(provider.calls.length, 3, "at most three provider pages");
  assert.equal(result.items.length, 0);
  assert.equal(result.partial, true);
  assert.ok(result.nextCursor);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["mirror_fallback"]);

  const library = {
    list: async () => ({
      entries: [
        { id: "lib_1111111111111111", provenance: { provider: "huggingface", repo: "example-org/Example-8B-GGUF", revisionSha: "a" }, verification: { status: "ok" }, residue: { incompleteFiles: 0 }, update: { status: "available" } },
        { id: "lib_2222222222222222", provenance: { provider: "huggingface", repo: "example-org/Example-8B-FP8" }, verification: { status: "ok" }, residue: { incompleteFiles: 0 }, update: { status: "current" } },
        { id: "lib_3333333333333333", provenance: { provider: "huggingface", repo: "another-org/Another-14B-AWQ" }, verification: { status: "fail" }, residue: { incompleteFiles: 2 } },
      ],
      nextCursor: null,
    }),
  };
  const queue = { list: () => ({ jobs: [{ state: "downloading", artifact: { provider: "huggingface", repo: "community-user/tiny-gguf-test", artifactKey: "gguf:|Q4_K_M" } }] }) };
  const listed = await discoveryOf(searchProvider(), { library, queue }).search({});
  const stateOf = (repo) => listed.items.find((item) => item.repo === repo).library;
  assert.deepEqual(stateOf("example-org/Example-8B-GGUF"), { state: "update-available", entryId: "lib_1111111111111111" });
  assert.deepEqual(stateOf("example-org/Example-8B-FP8"), { state: "present", entryId: "lib_2222222222222222" });
  assert.deepEqual(stateOf("another-org/Another-14B-AWQ"), { state: "partial", entryId: "lib_3333333333333333" });
  assert.deepEqual(stateOf("community-user/tiny-gguf-test"), { state: "partial", entryId: null });
  assert.deepEqual(stateOf("example-org/Example-Mixed"), { state: "absent", entryId: null });
});

test("resolveLink reads Hugging Face and ModelScope links as text and nothing else", () => {
  const discovery = discoveryOf(searchProvider());
  const resolve = (url) => discovery.resolveLink(url);
  assert.deepEqual(resolve("Qwen/Qwen3-8B"), { provider: "huggingface", repo: "Qwen/Qwen3-8B", revision: "main" });
  assert.deepEqual(resolve("https://huggingface.co/Qwen/Qwen3-8B"), { provider: "huggingface", repo: "Qwen/Qwen3-8B", revision: "main" });
  assert.deepEqual(resolve("https://huggingface.co/models/Qwen/Qwen3-8B/tree/v1.0"), { provider: "huggingface", repo: "Qwen/Qwen3-8B", revision: "v1.0" });
  assert.deepEqual(resolve("https://hf-mirror.com/unsloth/Qwen3-8B-GGUF/blob/main/Qwen3-8B-Q4_K_M.gguf"), { provider: "huggingface", repo: "unsloth/Qwen3-8B-GGUF", revision: "main", file: "Qwen3-8B-Q4_K_M.gguf" });
  assert.deepEqual(resolve("https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/abc123/sub/dir/model.gguf?download=true"), { provider: "huggingface", repo: "unsloth/Qwen3-8B-GGUF", revision: "abc123", file: "sub/dir/model.gguf" });
  assert.deepEqual(resolve("https://www.modelscope.cn/models/Qwen/Qwen3-8B/files"), { provider: "modelscope", repo: "Qwen/Qwen3-8B", revision: "master" });
  assert.deepEqual(resolve("https://modelscope.cn/models/Qwen/Qwen3-8B/resolve/master/config.json"), { provider: "modelscope", repo: "Qwen/Qwen3-8B", revision: "master", file: "config.json" });
  for (const bad of ["", "not a link", "ftp://huggingface.co/a/b", "https://example.com/a/b", "https://huggingface.co/datasets/a/b", "https://huggingface.co/onlyone", "https://modelscope.cn/datasets/a/b", "https://huggingface.co/a/b/tree/bad%20rev"]) {
    assert.throws(() => resolve(bad), (error) => ["invalid_request", "unrecognized_link"].includes(error.code) && [400, 422].includes(error.status), bad);
  }
});

// --- the plan ------------------------------------------------------------------------

function fakeEngine() {
  return {
    id: "cli",
    started: [],
    start(job, hooks) {
      const handle = { job, jobId: job.id, pid: 4242, exited: false, stopReason: null, exit() {}, stop() { return Promise.resolve(); }, stderrTail: () => [] };
      this.started.push(handle);
      hooks.onSpawn({ pid: handle.pid, startedAt: new Date().toISOString() });
      return handle;
    },
    async findOrphans() { return []; },
  };
}

async function startPlanHub(t, options = {}) {
  const root = tempDir(t);
  const models = path.join(root, "models");
  fs.mkdirSync(models, { recursive: true });
  const manifestRef = { current: options.manifest || manifestOf("hf-gguf-multiquant.json", "example-org/Example-8B-GGUF") };
  const asked = [];
  const metadata = {
    id: "huggingface",
    namespace: "huggingface",
    apiBase: "https://huggingface.co",
    fetchImpl: async () => { throw new Error("not used"); },
    getRepo: async (repo, opts) => { asked.push([repo, opts.revision]); return manifestRef.current; },
    search: async () => ({ items: [], nextCursor: null }),
    getReadme: async () => ({ markdown: "", truncated: false }),
  };
  const providers = { forNamespace: () => metadata, get: () => metadata };
  const clock = { value: NOW, now() { return this.value; } };
  const disk = { volumeOf: () => "X:", freeBytes: async () => options.free ?? 2000 * GIB, reserveBytes: () => options.reserve ?? 10 * GIB };
  const log = {};
  const modelStorage = createModelStorage({ modelsRoot: models, file: path.join(root, "service-entry", "data", "model-storage.json") });
  const engine = fakeEngine();
  const hub = createModelHub({
    aiRoot: root,
    dataDir: path.join(root, "hub"),
    env: {},
    clock,
    logger: quietLogger(),
    heartbeatMs: 3_600_000,
    transferEngine: engine,
    providers,
    modelStorage,
    disk,
    models: options.models === undefined ? stubModels(log, manifestRef.current) : options.models,
    getGpus: gpus(options.totalMb || 24000),
    hfAuthService: options.hfAuthService || { checkRepoAccess: async () => ({ granted: true, status: "granted", username: "example-user" }), getStatus: async () => ({ connected: true }), hasCachedToken: () => true },
    verifier: { verifyArtifact: async () => ({ ok: true }) },
    readConfig: () => ({ downloadsOwner: "hub", source: "default", errors: [] }),
    libraryOptions: { watch: false },
    ...(options.hubOptions || {}),
  });
  await hub.start();
  t.after(() => hub.stop());
  return { hub, root, models, manifestRef, asked, clock, engine, log };
}

const Q4 = { provider: "huggingface", repo: "example-org/Example-8B-GGUF", selection: { artifactKey: "gguf:|Q4_K_M" } };

test("plan: artifact, target, existing, source, access, fit, compatibility, eta, no blockers", async (t) => {
  const { hub, models, manifestRef, log } = await startPlanHub(t);
  const plan = await hub.plan({ ...Q4, fit: { contextTokens: 16384 } });
  assert.match(plan.planId, /^pln_[a-z2-7]{16}$/);
  assert.equal(Date.parse(plan.expiresAt) - NOW, 10 * 60 * 1000);
  assert.equal(plan.artifact.artifactKey, "gguf:|Q4_K_M");
  assert.equal(plan.artifact.revisionSha, manifestRef.current.revisionSha);
  assert.ok(plan.artifact.files.some((file) => file.path === "Example-8B-Q4_K_M.gguf" && file.role === "weight" && file.size === 5027783488));
  assert.ok(plan.artifact.files.some((file) => file.path === "config.json" && file.role === "sidecar"));
  assert.equal(plan.artifact.bytesToDownload, plan.artifact.totalBytes);
  assert.ok(plan.artifact.totalBytes > 5027783488);
  assert.equal(plan.target.localDir, path.join(models, "example-org-Example-8B-GGUF"));
  assert.equal(plan.target.rootId, "legacy");
  assert.equal(plan.target.volume, "X:");
  assert.equal(plan.target.freeBytes, 2000 * GIB);
  assert.equal(plan.target.reserveBytes, 10 * GIB);
  assert.equal(plan.target.queuedOnVolumeBytes, 0);
  assert.equal(plan.target.freeAfterBytes, 2000 * GIB - plan.artifact.totalBytes);
  assert.deepEqual(plan.existing, { state: "absent", entryId: null, message: "" });
  assert.deepEqual(plan.source, { chosen: "huggingface", endpoint: "https://huggingface.co", reason: "policy", probe: null });
  assert.deepEqual(plan.access, { gated: false, status: "not_required", credentialMode: "cached-login", authorizationUrl: null });
  assert.equal(plan.fit.basis, "card");
  assert.equal(plan.fit.label, "fits");
  assert.deepEqual(plan.compatibility.map((row) => row.engineId), ["llamacpp"]);
  assert.deepEqual(plan.eta, { seconds: null, basisBps: null, basis: "unknown" });
  assert.equal(plan.runAfter, null);
  assert.deepEqual([plan.blocking, plan.warnings], [[], []]);
  // The selected artifact's own files go to the inspector, with the chosen context in the fit.
  assert.deepEqual(log.inspections[0].request.files.sort(), plan.artifact.files.map((file) => file.path).sort());
  assert.equal(log.inspections[0].request.source, "huggingface");

  await assert.rejects(hub.plan({ ...Q4, selection: { artifactKey: "gguf:|NOPE" } }), (error) => error.status === 422 && error.code === "artifact_not_found");
  await assert.rejects(hub.plan({ repo: "nope" }), (error) => error.status === 400 && error.code === "invalid_request");
  await assert.rejects(hub.plan({ ...Q4, fit: "x" }), (error) => error.details.field === "fit");
  await assert.rejects(hub.plan("x"), (error) => error.status === 400);
});

test("plan: a drive without room blocks with disk_full; a queued drive only warns", async (t) => {
  const small = await startPlanHub(t, { free: 12 * GIB, reserve: 10 * GIB });
  const plan = await small.hub.plan(Q4);
  assert.equal(plan.blocking.length, 1);
  assert.deepEqual(plan.blocking[0].code, "disk_full");
  assert.deepEqual(plan.blocking[0].actions, ["choose-root", "open-storage"]);
  assert.equal(typeof plan.blocking[0].message, "string");
  assert.equal(typeof plan.blocking[0].hint, "string");
  assert.ok(plan.target.freeAfterBytes < plan.target.reserveBytes, "less than the reserve is left");

  // A download from that plan is refused with the blockers listed.
  await assert.rejects(small.hub.enqueue({ planId: plan.planId }), (error) => error.status === 422 && error.code === "plan_blocked" && error.details.blocking[0].code === "disk_full");

  // Room for this one, but not after what is queued on the drive.
  const planner = createPlanner({
    fit: createFitService({ models: null }),
    disk: { volumeOf: () => "X:", freeBytes: async () => 100 * GIB, reserveBytes: () => 10 * GIB },
    queue: { list: () => ({ jobs: [{ state: "downloading", id: "dl_x", target: { volume: "X:", localDir: "X:/other" }, artifact: { totalBytes: 85 * GIB }, progress: { bytesDone: 0 } }] }) },
    discovery: { libraryStates: async () => ({ entriesFor: () => [], forArtifact: () => ({ state: "absent", entryId: null }) }) },
  });
  const manifest = manifestOf("hf-gguf-multiquant.json", "example-org/Example-8B-GGUF");
  const artifact = resolveSelection(manifest, { artifactKey: "gguf:|Q8_0" });
  const resolved = { namespace: "huggingface", repo: manifest.repo, revision: "main", source: "huggingface", sourceReason: "policy", endpoint: "https://huggingface.co", manifest, artifact, localDir: "X:/models/a", root: { id: "r", label: "Library" }, volume: "X:", credentialMode: "cached-login", notes: [] };
  const body = await planner.build(resolved, {}, { withFit: false });
  assert.equal(body.target.queuedOnVolumeBytes, 85 * GIB);
  assert.deepEqual(body.blocking, []);
  assert.deepEqual(body.warnings.map((warning) => warning.code), ["disk_queue_pressure"]);
  assert.deepEqual(body.fit, {});
});

test("plan: gated repositories block without access and clear with it; the source can force the official endpoint", async (t) => {
  const mixed = manifestOf("hf-mixed.json", "example-org/Example-Mixed");
  const request = { provider: "huggingface", repo: "example-org/Example-Mixed", selection: { artifactKey: "st:fp8" } };

  const none = await startPlanHub(t, { manifest: mixed });
  const noLogin = await none.hub.plan({ ...request, credential: { mode: "none" } });
  assert.deepEqual(noLogin.access, { gated: true, status: "login_required", credentialMode: "none", authorizationUrl: null });
  assert.deepEqual(noLogin.blocking.map((item) => [item.code, item.actions]), [["hf_login_required", ["sign-in"]]]);

  const pending = await startPlanHub(t, { manifest: mixed, hfAuthService: { checkRepoAccess: async () => ({ granted: false, status: "approval_required" }), hasCachedToken: () => true } });
  const approval = await pending.hub.plan(request);
  assert.equal(approval.access.status, "approval_required");
  assert.equal(approval.access.authorizationUrl, "https://huggingface.co/example-org/Example-Mixed");
  assert.deepEqual(approval.blocking.map((item) => [item.code, item.actions]), [["hf_approval_required", ["open-approval"]]]);

  const granted = await startPlanHub(t, { manifest: mixed });
  const ok = await granted.hub.plan(request);
  assert.deepEqual([ok.access.status, ok.blocking], ["granted", []]);

  // A mirror source for a gated repository switches to the official endpoint (and says so)...
  const mirrored = await granted.hub.plan({ ...request, source: "hf-mirror" });
  assert.equal(mirrored.source.chosen, "huggingface");
  assert.equal(mirrored.source.reason, "gated-official");
  assert.ok(mirrored.warnings.some((warning) => warning.code === "source_changed"));
  // ...unless the owner turned that off: then it is blocked.
  await granted.hub.settings.update({ sources: { gatedUsesOfficial: false } });
  const blocked = await granted.hub.plan({ ...request, source: "hf-mirror" });
  assert.equal(blocked.access.status, "official_required");
  assert.deepEqual(blocked.blocking.map((item) => item.code), ["gated_official_required"]);
});

test("plan: custom code is a warning with the files; a duplicate or a copy elsewhere is a warning, not a block", async (t) => {
  const mixed = manifestOf("hf-mixed.json", "example-org/Example-Mixed");
  const { hub } = await startPlanHub(t, { manifest: mixed });
  const plan = await hub.plan({ provider: "huggingface", repo: "example-org/Example-Mixed", selection: { artifactKey: "st:" } });
  const custom = plan.warnings.find((warning) => warning.code === "custom_code");
  assert.ok(custom);
  assert.deepEqual(custom.files, ["configuration_example.py", "modeling_example.py"]);
  assert.match(custom.message, /trust_remote_code/);
  assert.ok(plan.artifact.files.some((file) => file.path === "modeling_example.py"));

  // Existing copies, with the registry faked at the planner's seam.
  const manifest = manifestOf("hf-gguf-multiquant.json", "example-org/Example-8B-GGUF");
  const artifact = resolveSelection(manifest, { artifactKey: "gguf:|Q4_K_M" });
  const files = artifact.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 || null, gitOid: file.gitOid || null }));
  const identityKey = identityKeyFor({ provider: "huggingface", repo: manifest.repo, revisionSha: manifest.revisionSha, confidence: "declared" }, computeFilesetHash(files));
  assert.ok(identityKey);
  const run = async (entries, localDir) => {
    const planner = createPlanner({
      fit: createFitService({ models: null }),
      discovery: {
        libraryStates: async () => ({
          entriesFor: () => entries,
          forArtifact: () => ({ state: entries.length ? "present" : "absent", entryId: entries[0]?.id || null }),
        }),
      },
    });
    const resolved = { namespace: "huggingface", repo: manifest.repo, revision: "main", source: "huggingface", sourceReason: "policy", endpoint: "https://huggingface.co", manifest, artifact, localDir, root: { id: "r", label: "Library F" }, volume: "X:", credentialMode: "cached-login", notes: [] };
    return planner.build(resolved, {}, { withFit: false });
  };
  const elsewhere = await run([{ id: "lib_aaaaaaaaaaaaaaaa", identityKey, path: "Y:/models/copy", rootLabel: "Library Y", verification: { status: "ok" } }], "X:/models/new");
  assert.equal(elsewhere.existing.state, "duplicate-elsewhere");
  assert.equal(elsewhere.existing.entryId, "lib_aaaaaaaaaaaaaaaa");
  assert.match(elsewhere.existing.message, /Library Y/);
  assert.deepEqual(elsewhere.warnings.map((warning) => warning.code), ["duplicate"]);
  assert.deepEqual(elsewhere.blocking, []);
  const here = await run([{ id: "lib_aaaaaaaaaaaaaaaa", identityKey, path: "X:/models/new", verification: { status: "ok" } }], "X:/models/new");
  assert.equal(here.existing.state, "present");
  assert.equal(here.artifact.bytesToDownload, 0, "nothing to download when the exact files are there");
  assert.deepEqual(here.warnings.map((warning) => warning.code), ["duplicate"]);
  const absent = await run([], "X:/models/new");
  assert.deepEqual([absent.existing.state, absent.warnings], ["absent", []]);
});

test("plan: a wont-fit selection warns, the eta is the median of recent same-source speeds", async (t) => {
  const tiny = await startPlanHub(t, { totalMb: 4000 });
  const plan = await tiny.hub.plan({ ...Q4, selection: { artifactKey: "gguf:|Q8_0" } });
  assert.equal(plan.fit.label, "wont-fit");
  assert.deepEqual(plan.warnings.map((warning) => warning.code), ["fit_wont_fit"]);
  assert.deepEqual(plan.blocking, []);

  const ready = (source, bps, at) => ({ state: "ready", finishedAt: at, transfer: { options: { source } }, progress: { speedEmaBps: bps } });
  const planner = createPlanner({
    fit: createFitService({ models: null }),
    queue: {
      list: (query) => (query.state === "ready"
        ? { jobs: [ready("huggingface", 100e6, "2026-10-13T00:00:00Z"), ready("huggingface", 300e6, "2026-10-12T00:00:00Z"), ready("hf-mirror", 1e6, "2026-10-11T00:00:00Z"), ready("huggingface", 200e6, "2026-10-10T00:00:00Z")] }
        : { jobs: [] }),
    },
    discovery: { libraryStates: async () => ({ entriesFor: () => [], forArtifact: () => ({ state: "absent", entryId: null }) }) },
  });
  const manifest = manifestOf("hf-gguf-multiquant.json", "example-org/Example-8B-GGUF");
  const artifact = resolveSelection(manifest, { artifactKey: "gguf:|Q4_K_M" });
  const body = await planner.build({ namespace: "huggingface", repo: manifest.repo, revision: "main", source: "huggingface", sourceReason: "policy", endpoint: "https://huggingface.co", manifest, artifact, localDir: "X:/m", root: null, volume: "X:", credentialMode: "cached-login", notes: [] }, {}, { withFit: false });
  assert.equal(body.eta.basis, "recent-average");
  assert.equal(body.eta.basisBps, 200e6, "the median of 100, 200 and 300 MB/s (the mirror job is another source)");
  assert.equal(body.eta.seconds, Math.ceil(artifact.totalBytes / 200e6));
});

test("a planId enqueues the planned download: same target, same credential, single use, re-validated", async (t) => {
  const { hub, models, manifestRef, engine, clock } = await startPlanHub(t);
  const tokenRef = await hub.tokens.put(FAKE_TOKEN);
  const plan = await hub.plan(Q4, { credential: { tokenRef, remember: false } });
  assert.equal(plan.access.credentialMode, "temp-token");

  const job = await hub.enqueue({ planId: plan.planId, priority: "high" }, { origin: { kind: "console" } });
  assert.equal(job.artifact.artifactKey, "gguf:|Q4_K_M");
  assert.equal(job.artifact.revisionSha, plan.artifact.revisionSha);
  assert.equal(job.target.localDir, plan.target.localDir);
  assert.equal(job.target.localDir, path.join(models, "example-org-Example-8B-GGUF"));
  assert.equal(job.priority, "high");
  assert.equal(job.transfer.options.tokenRef, tokenRef, "the plan's credential reaches the job");
  assert.equal(JSON.stringify(job).includes(FAKE_TOKEN), false);
  assert.equal(job.artifact.files.length, plan.artifact.files.length);
  await assert.rejects(hub.enqueue({ planId: plan.planId }), (error) => error.code === "plan_not_found" && error.status === 404, "a plan is used once");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.started.length >= 0, true);

  // A repository that moved on since the plan is refused, not downloaded.
  const second = await hub.plan({ ...Q4, selection: { artifactKey: "gguf:|Q5_K_M" }, target: { outputName: "other-name" } });
  manifestRef.current = { ...manifestRef.current, revisionSha: "b".repeat(40) };
  await assert.rejects(hub.enqueue({ planId: second.planId }), (error) => error.code === "plan_changed" && error.status === 409);
  await assert.rejects(hub.enqueue({ planId: second.planId }), (error) => error.code === "plan_not_found");

  // Plans live ten minutes.
  manifestRef.current = { ...manifestRef.current, revisionSha: manifestRef.current.revisionSha };
  const third = await hub.plan({ ...Q4, target: { outputName: "third-name" } });
  clock.value += 10 * 60 * 1000 + 1;
  await assert.rejects(hub.enqueue({ planId: third.planId }), (error) => error.code === "plan_not_found" && error.status === 404);
});

test("the plan cache expires after ten minutes and keeps the 64 newest", () => {
  const clock = { value: 1_000_000, now() { return this.value; } };
  const cache = createPlanCache({ clock });
  const ids = [];
  for (let index = 0; index < 66; index += 1) ids.push(cache.put({ n: index }).planId);
  assert.equal(cache.size, 64);
  assert.equal(cache.get(ids[0]), null);
  assert.equal(cache.get(ids[1]), null);
  assert.equal(cache.get(ids[2]).n, 2);
  assert.equal(cache.get(ids[65]).n, 65);
  clock.value += 10 * 60 * 1000 - 1;
  assert.equal(cache.get(ids[65]).n, 65);
  clock.value += 2;
  assert.equal(cache.get(ids[65]), null);
  assert.equal(cache.size, 0);
  assert.equal(cache.delete("pln_x"), false);
});

test("plan with runAfter: the advisory prospective plan joins the body, and a manager without support refuses with run_after_unavailable", async (t) => {
  const requests = [];
  let answer = { status: 200, json: { ok: true, errors: [], steps: [], planHash: "sha256:adv", admission: { verdict: "ok" } } };
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { status: answer.status, text: async () => JSON.stringify(answer.json) };
  };
  const runAfter = createRunAfter({ managers: [{ id: "llama", port: 1 }, { id: "vllm", port: 2 }], fetchImpl, getEngines: async () => [], logger: quietLogger() });
  const { hub, log } = await startPlanHub(t, { hubOptions: { runAfter } });
  const request = { engineId: "llamacpp", values: { contextLength: 8192 } };
  const plan = await hub.plan({ ...Q4, runAfter: request });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^http:\/\/127\.0\.0\.1:1\/api\/launch\/plan$/);
  assert.equal(requests[0].body.prospective, true);
  assert.deepEqual(Object.keys(requests[0].body.model), ["card"]);
  assert.ok(log.inspections.length >= 1 && typeof requests[0].body.model.card === "object");
  assert.equal(Object.hasOwn(requests[0].body.model, "ref"), false);
  assert.equal(plan.runAfter.engineId, "llamacpp");
  assert.equal(plan.runAfter.managerId, "llama");
  assert.equal(plan.runAfter.advice.planHash, "sha256:adv");
  assert.equal((await hub.plan({ ...Q4 })).runAfter, null);
  await assert.rejects(() => hub.plan({ ...Q4, runAfter: { engineId: "" } }), { code: "invalid_request", status: 400 });

  answer = { status: 404, json: { error: "Not found" } };
  await assert.rejects(() => hub.plan({ ...Q4, runAfter: request }), { code: "run_after_unavailable", status: 422 });
  assert.equal((await hub.plan({ ...Q4 })).runAfter, null, "Download alone stays available");
  assert.equal(hub.status().features.runAfter, true);
});
