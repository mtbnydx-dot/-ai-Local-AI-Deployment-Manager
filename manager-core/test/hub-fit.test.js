"use strict";

// The hub's fit and compatibility adapter and the repository detail built on
// it (docs/overhaul/03-hub.md §10, §13.3, HUB-10). 02's core.models is a stub
// here (plus one run against the real estimator); every provider is a fake
// and nothing reaches the network, the disk or the live root.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const core = require("..");
const { createFitService, labelOf } = require("../model-hub/fit");
const { createDiscovery } = require("../model-hub/search");
const { normalizeRepoInfo } = require("../model-hub/providers/huggingface");

const FIXTURES = path.join(__dirname, "fixtures", "hub");
const MIB = 1024 * 1024;

function manifestOf(name, repo, extra = {}) {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
  return { ...normalizeRepoInfo(raw, { repo: repo || raw.id, fetchedFrom: "https://huggingface.co", now: Date.parse("2026-10-14T08:00:00Z") }), ...extra };
}

function gpus(totalMb, freeMb = totalMb) {
  return async () => [{ id: "0", name: "Test GPU", totalMb, freeMb, computeCap: "8.9" }];
}

// A stand-in for core.models. estimateFit grades by a simple budget so the
// labels are predictable: ok under 85 % of the GPU, warn up to 100 %, else
// fail. A card carries `weightsBytes`; legacy input carries paramsB x bytesPerParam.
function stubModels(log = {}, manifest = null) {
  const sizes = new Map((manifest?.files || []).map((file) => [file.path, Number(file.size) || 0]));
  log.estimates = [];
  log.inspections = [];
  log.compat = [];
  return {
    estimateFit(input) {
      log.estimates.push(input);
      const bytes = input.card ? Number(input.card.weightsBytes) : Number(input.legacy.paramsB) * Number(input.legacy.bytesPerParam) * 1e9;
      const needed = Math.round(bytes / MIB * 1.1 + 1024);
      const total = Math.max(...input.host.gpus.map((gpu) => gpu.totalMb));
      const status = needed <= total * 0.85 ? "ok" : needed <= total ? "warn" : "fail";
      return {
        status,
        spill: status === "warn" && input.engineId === "llamacpp" && needed > total * 0.95,
        admissionRequestMb: needed,
        perGpuMb: { 0: needed },
        range: { lowMb: needed, highMb: needed },
        policy: input.card ? "gguf-estimate" : "weights-plus-kv",
        confidence: input.card ? "exact" : "heuristic",
        headroomMb: total - needed,
        overflowMb: Math.max(0, needed - total),
        suggestions: [],
      };
    },
    async inspectRemote(request, options) {
      log.inspections.push({ request, options });
      const bytes = request.files.reduce((sum, name) => sum + (sizes.get(name) || 0), 0);
      return { cardId: "mc_stub", identity: { architecture: "qwen3" }, role: { value: "main", runnable: true }, evidence: [], weightsBytes: log.cardBytes?.(request) ?? bytes };
    },
    async evaluateCompatibility(card, context) {
      log.compat.push({ card, context });
      return [{ engineId: "llamacpp", runtimeId: "llamacpp@b1", verdict: "ok", supportEvidence: [], reasons: [], actions: [] }];
    },
  };
}

test("labelOf is the one mapping from 02's status (03 §10 table)", () => {
  assert.equal(labelOf(null), "unknown");
  assert.equal(labelOf({}), "unknown");
  assert.equal(labelOf({ status: "ok", spill: false }), "fits");
  assert.equal(labelOf({ status: "ok", spill: true }), "fits");
  assert.equal(labelOf({ status: "warn", spill: false }), "tight");
  assert.equal(labelOf({ status: "warn", spill: true }), "spills");
  assert.equal(labelOf({ status: "fail", spill: false }), "wont-fit");
  assert.equal(labelOf({ status: "fail", spill: true }), "wont-fit");
  const service = createFitService({ models: stubModels() });
  assert.equal(service.labelOf({ status: "warn", spill: true }), "spills");
});

test("fitFor passes card or legacy facts to core.models and shapes the hub fit object", async () => {
  const log = {};
  const service = createFitService({ models: stubModels(log), getGpus: gpus(24000, 23000) });
  assert.equal(service.hasModels, true);

  const params = await service.fitFor({ legacy: { paramsB: 8, bytesPerParam: 0.5625 }, format: "gguf", contextTokens: 8192 });
  assert.deepEqual(Object.keys(params).sort(), ["basis", "confidence", "headroomMb", "label", "neededMb", "overflowMb", "perGpuMb", "policy", "range", "spill", "status", "suggestions"]);
  assert.equal(params.label, "fits");
  assert.equal(params.basis, "params");
  assert.equal(params.neededMb, log.estimates[0] && Math.round(8 * 0.5625 * 1e9 / MIB * 1.1 + 1024));
  assert.equal(log.estimates[0].engineId, "llamacpp", "a GGUF is graded for llama.cpp");
  assert.equal(log.estimates[0].values.contextLength, 8192);
  assert.deepEqual(log.estimates[0].host.gpus.map((gpu) => [gpu.id, gpu.totalMb, gpu.freeMb, gpu.usedMb]), [["0", 24000, 23000, 1000]]);
  assert.equal(log.estimates[0].card, null);

  const viaCard = await service.fitFor({ card: { weightsBytes: 30e9 }, format: "safetensors" });
  assert.equal(viaCard.basis, "card");
  assert.equal(viaCard.label, "wont-fit");
  assert.equal(log.estimates[1].engineId, "vllm");
  assert.equal(log.estimates[1].legacy, null);
  assert.equal(log.estimates[1].values.contextLength, 32768, "the default context is 32768");

  const noFacts = await service.fitFor({ format: "gguf" });
  assert.equal(noFacts.label, "unknown");
  const noGpu = await createFitService({ models: stubModels(), getGpus: async () => [] }).fitFor({ legacy: { paramsB: 8, bytesPerParam: 2 } });
  assert.equal(noGpu.label, "unknown");
  assert.equal(noGpu.reason, "gpu_unavailable");

  // The namespaced shape of the real core.models works too.
  const real = stubModels();
  const nested = createFitService({ models: { fit: { estimateFit: real.estimateFit }, compatibility: { evaluateCompatibility: real.evaluateCompatibility } }, getGpus: gpus(24000) });
  assert.equal((await nested.fitFor({ legacy: { paramsB: 8, bytesPerParam: 0.5625 } })).label, "fits");
});

test("fitFor with the real estimator grades a legacy model without throwing", async () => {
  const service = createFitService({ models: core.models, getGpus: gpus(98304) });
  const fit = await service.fitFor({ legacy: { paramsB: 8, bytesPerParam: 0.5625 }, format: "gguf" });
  assert.ok(["fits", "tight", "spills", "wont-fit"].includes(fit.label), fit.label);
  assert.equal(fit.basis, "params");
  assert.ok(fit.neededMb > 0);
  assert.equal(typeof fit.policy, "string");
});

test("inspect hands core.models the provider's fetch and endpoint and never a token", async () => {
  const log = {};
  const service = createFitService({ models: stubModels(log) });
  const fetchImpl = async () => { throw new Error("not called"); };
  const provider = { apiBase: "https://huggingface.co", fetchImpl, token: "should-never-be-read", getToken: () => "hf_never" };
  const card = await service.inspect({ provider, namespace: "huggingface", repo: "example-org/Example-8B-GGUF", revision: "main", revisionSha: "a".repeat(40), files: ["Example-8B-Q4_K_M.gguf"] });
  assert.equal(card.cardId, "mc_stub");
  const { request, options } = log.inspections[0];
  assert.deepEqual(request, { source: "huggingface", repo: "example-org/Example-8B-GGUF", revision: "a".repeat(40), files: ["Example-8B-Q4_K_M.gguf"] });
  assert.equal(options.fetchImpl, fetchImpl);
  assert.equal(options.endpoint, "https://huggingface.co");
  const keys = [];
  (function walk(value, prefix) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) { keys.push(`${prefix}${key}`); walk(child, `${prefix}${key}.`); }
  })({ request, options }, "");
  assert.deepEqual(keys.filter((key) => /token|authorization|credential|secret/i.test(key)), [], "no credential key is passed");

  // ModelScope is its own namespace; a failing inspector gives null, not a throw.
  await service.inspect({ provider, namespace: "modelscope", repo: "example-org/Example-8B-GGUF" });
  assert.equal(log.inspections[1].request.source, "modelscope");
  assert.equal(log.inspections[1].request.revision, "main");
  const failing = createFitService({ models: { ...stubModels(), inspectRemote: async () => { throw new Error("gated"); } } });
  assert.equal(await failing.inspect({ provider, namespace: "huggingface", repo: "example-org/Example-8B-GGUF" }), null);
});

test("compatibility rows pass through in 02's shape, with the entry's context", async () => {
  const log = {};
  const context = { host: { gpus: [{ id: "0" }] } };
  const service = createFitService({ models: stubModels(log), getCompatibilityContext: async () => context });
  const rows = await service.compatibilityFor({ cardId: "mc_x" });
  assert.deepEqual(rows.map((row) => [row.engineId, row.verdict]), [["llamacpp", "ok"]]);
  assert.equal(log.compat[0].context, context);
  // A throwing context or evaluator degrades to unknown rows.
  const broken = createFitService({ models: stubModels(), getCompatibilityContext: async () => { throw new Error("no context"); } });
  assert.equal((await broken.compatibilityFor({ cardId: "mc_x" })).length, 1);
  const bad = createFitService({ models: { ...stubModels(), evaluateCompatibility: async () => { throw new Error("boom"); } } });
  assert.ok((await bad.compatibilityFor({ cardId: "mc_x" })).every((row) => row.verdict === "unknown" && row.reasons[0].code === "inspector_unavailable"));
});

test("without models the bytes fallback applies: wont-fit or fits only, never tight or spills", async () => {
  const service = createFitService({ models: null, getGpus: gpus(12000) });
  assert.equal(service.hasModels, false);
  const big = await service.fitFor({ bytes: 40e9, format: "safetensors", legacy: { paramsB: 20, bytesPerParam: 2 } });
  assert.equal(big.label, "wont-fit");
  assert.deepEqual([big.status, big.basis, big.policy, big.confidence, big.spill], ["fail", "bytes", "bytes-heuristic", "name-heuristic", false]);
  const small = await service.fitFor({ bytes: 4e9 });
  assert.equal(small.label, "fits");
  // 9.5 GB would be "tight" in the legacy heuristic; the hub maps it to fits.
  const edge = await service.fitFor({ bytes: 9.2e9 });
  assert.ok(["fits", "wont-fit"].includes(edge.label), edge.label);
  for (const bytes of [1e9, 3e9, 6e9, 9e9, 11e9, 20e9, 80e9]) {
    const label = (await service.fitFor({ bytes })).label;
    assert.ok(label === "fits" || label === "wont-fit", `${bytes}: ${label}`);
  }
  const noGpu = await createFitService({ models: null, getGpus: async () => [] }).fitFor({ bytes: 4e9 });
  assert.equal(noGpu.label, "unknown");
  assert.equal(await service.inspect({ provider: {}, namespace: "huggingface", repo: "a/b" }), null);
  const rows = await service.compatibilityFor({ cardId: "mc_x" });
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row) => row.verdict === "unknown" && row.reasons.some((reason) => reason.code === "inspector_unavailable")));
});

// --- repository detail ---------------------------------------------------------

function detailProvider(manifest, options = {}) {
  const fetchImpl = async () => { throw new Error("detail never fetches directly"); };
  return {
    id: "huggingface",
    namespace: "huggingface",
    apiBase: "https://huggingface.co",
    fetchImpl,
    getRepo: async (repo, opts) => { options.calls?.push(["getRepo", repo, opts.revision]); return manifest; },
    getReadme: async () => ({ markdown: "# readme", truncated: false }),
    search: async () => ({ items: [], nextCursor: null, fetchedFrom: "https://huggingface.co", warnings: [] }),
  };
}

function discoveryFor(provider, { models, totalMb = 12000, library = null, auth = null, settings = {} } = {}) {
  const fit = createFitService({ models, getGpus: gpus(totalMb) });
  return createDiscovery({
    providers: { forNamespace: () => provider },
    fit,
    library,
    auth,
    settings: () => settings,
  });
}

test("detail: each artifact carries fit label and basis, engines and library state; only the recommended one is graded from a card", async () => {
  const log = {};
  const manifest = manifestOf("hf-gguf-multiquant.json", "example-org/Example-8B-GGUF");
  const provider = detailProvider(manifest);
  const library = {
    list: async () => ({
      entries: [{ id: "lib_aaaaaaaaaaaaaaaa", path: "X:/models/a", provenance: { provider: "huggingface", repo: "example-org/Example-8B-GGUF", artifactKey: "gguf:|Q4_K_M", revisionSha: manifest.revisionSha }, verification: { status: "ok" }, residue: { incompleteFiles: 0 }, update: { status: "current" } }],
      nextCursor: null,
    }),
  };
  const discovery = discoveryFor(provider, { models: stubModels(log, manifest), library, totalMb: 13000 });
  const detail = await discovery.getRepo({ provider: "huggingface", repo: "example-org/Example-8B-GGUF" }, {});

  assert.equal(detail.revisionSha, manifest.revisionSha);
  assert.equal(detail.fetchedFrom, "https://huggingface.co");
  assert.deepEqual(detail.artifacts.map((artifact) => artifact.artifactKey), ["gguf:|Q2_K", "gguf:|Q4_K_M", "gguf:|Q5_K_M", "gguf:|Q8_0", "gguf:BF16|BF16"]);
  const byKey = Object.fromEntries(detail.artifacts.map((artifact) => [artifact.artifactKey, artifact]));
  assert.deepEqual(detail.artifacts.filter((artifact) => artifact.recommended).map((artifact) => artifact.artifactKey), ["gguf:|Q8_0"], "the largest artifact that fits, and only one");
  assert.equal(byKey["gguf:|Q8_0"].fit.basis, "card");
  for (const key of ["gguf:|Q2_K", "gguf:|Q4_K_M", "gguf:|Q5_K_M", "gguf:BF16|BF16"]) assert.equal(byKey[key].fit.basis, "params", key);
  assert.equal(byKey["gguf:BF16|BF16"].fit.label, "wont-fit");
  assert.equal(byKey["gguf:|Q2_K"].fit.label, "fits");
  for (const artifact of detail.artifacts) {
    assert.deepEqual(artifact.engines, [{ engineId: "llamacpp", basis: "format" }]);
    assert.equal(typeof artifact.fit.label, "string");
    assert.equal(typeof artifact.fit.basis, "string");
  }
  assert.deepEqual(byKey["gguf:|Q4_K_M"].library, { state: "present", entryId: "lib_aaaaaaaaaaaaaaaa" });
  assert.deepEqual(byKey["gguf:|Q8_0"].library, { state: "absent", entryId: null });

  // One inspection, of the recommended artifact's files, on the pinned SHA.
  assert.equal(log.inspections.length, 1);
  assert.equal(log.inspections[0].request.revision, manifest.revisionSha);
  assert.ok(log.inspections[0].request.files.some((file) => /Q8_0/.test(file)));
  assert.equal(log.inspections[0].options.fetchImpl, provider.fetchImpl);
  assert.equal(detail.card.cardId, "mc_stub");
  assert.deepEqual(detail.compatibility.map((row) => row.engineId), ["llamacpp"]);
  assert.deepEqual(detail.access, { gated: false, status: "not_required", authorizationUrl: null });
  assert.equal(detail.summary.paramsB, 8.19);
  assert.equal(detail.summary.contextLength, 40960);
});

test("detail: a recommended candidate that no longer fits from its card is passed over; an inspector failure keeps the params grade", async () => {
  const manifest = manifestOf("hf-gguf-multiquant.json", "example-org/Example-8B-GGUF");
  // The card says Q8_0 is far bigger than the parameter estimate: it drops out and Q5_K_M is graded next.
  const log = { cardBytes: (request) => (request.files.some((file) => /Q8_0/.test(file)) ? 40e9 : 5.8e9) };
  const discovery = discoveryFor(detailProvider(manifest), { models: stubModels(log, manifest), totalMb: 13000 });
  const detail = await discovery.getRepo({ provider: "huggingface", repo: "example-org/Example-8B-GGUF" });
  const byKey = Object.fromEntries(detail.artifacts.map((artifact) => [artifact.artifactKey, artifact]));
  assert.deepEqual(detail.artifacts.filter((artifact) => artifact.recommended).map((artifact) => artifact.artifactKey), ["gguf:|Q5_K_M"]);
  assert.equal(byKey["gguf:|Q8_0"].fit.basis, "card");
  assert.equal(byKey["gguf:|Q8_0"].fit.label, "wont-fit");
  assert.equal(byKey["gguf:|Q5_K_M"].fit.basis, "card");
  assert.equal(log.inspections.length, 2, "at most two inspections");

  const failing = { ...stubModels(), inspectRemote: async () => { throw new Error("offline"); } };
  const offline = await discoveryFor(detailProvider(manifest), { models: failing }).getRepo({ provider: "huggingface", repo: "example-org/Example-8B-GGUF" });
  assert.equal(offline.card, null);
  assert.ok(offline.warnings.some((warning) => warning.code === "inspect_unavailable"));
  assert.deepEqual(offline.artifacts.filter((artifact) => artifact.recommended).map((artifact) => artifact.artifactKey), ["gguf:|Q8_0"]);
  assert.ok(offline.artifacts.every((artifact) => artifact.fit.basis === "params"));
  assert.ok(offline.compatibility.every((row) => row.reasons.some((reason) => reason.code === "inspector_unavailable")));
});

test("detail without models: the bytes fallback grades every artifact", async () => {
  const manifest = manifestOf("hf-gguf-multiquant.json", "example-org/Example-8B-GGUF");
  const detail = await discoveryFor(detailProvider(manifest), { models: null, totalMb: 12000 }).getRepo({ provider: "huggingface", repo: "example-org/Example-8B-GGUF" });
  assert.ok(detail.artifacts.every((artifact) => artifact.fit.basis === "bytes" && ["fits", "wont-fit"].includes(artifact.fit.label)));
  assert.equal(detail.artifacts.find((artifact) => artifact.artifactKey === "gguf:|Q2_K").fit.label, "fits");
  assert.equal(detail.artifacts.find((artifact) => artifact.artifactKey === "gguf:BF16|BF16").fit.label, "wont-fit");
  assert.equal(detail.artifacts.filter((artifact) => artifact.recommended).length, 1);
  assert.equal(detail.card, null);
});

test("detail: gated access, incomplete shards, the file tree, the readme and sibling repositories", async () => {
  const mixed = manifestOf("hf-mixed.json", "example-org/Example-Mixed");
  assert.equal(mixed.gated, true);
  const asked = [];
  const auth = { access: async (request) => { asked.push(request); return { granted: false, status: "approval_required", authorizationUrl: "https://huggingface.co/example-org/Example-Mixed" }; } };
  const provider = detailProvider(mixed);
  provider.search = async () => ({
    items: [
      { repo: "example-org/Example-Mixed", downloads: 1, likes: 0, gated: true },
      { repo: "example-org/Example-Mixed-FP8", downloads: 5, likes: 1, gated: false },
      { repo: "other-org/Unrelated-7B", downloads: 9, likes: 2, gated: false },
    ],
    nextCursor: null,
  });
  const discovery = discoveryFor(provider, { models: stubModels(), auth });
  const detail = await discovery.getRepo({ provider: "huggingface", repo: "example-org/Example-Mixed" }, { revision: "main", gpuIds: "0", engineId: "vllm" });
  assert.deepEqual(detail.access, { gated: true, status: "approval_required", authorizationUrl: "https://huggingface.co/example-org/Example-Mixed" });
  assert.deepEqual(asked.map((item) => item.repo), ["example-org/Example-Mixed"]);
  assert.deepEqual(detail.siblingRepos, [{ repo: "example-org/Example-Mixed-FP8", precision: "FP8" }]);
  assert.ok(detail.artifacts.length >= 2);

  const files = await discovery.listFiles({ provider: "huggingface", repo: "example-org/Example-Mixed" }, { limit: 4 });
  assert.equal(files.files.length, 4);
  assert.equal(files.total, mixed.files.length);
  assert.ok(files.nextCursor);
  const again = await discovery.listFiles({ provider: "huggingface", repo: "example-org/Example-Mixed" }, { limit: 4, cursor: files.nextCursor });
  assert.notDeepEqual(again.files.map((file) => file.path), files.files.map((file) => file.path));
  await assert.rejects(discovery.listFiles({ provider: "huggingface", repo: "example-org/Example-Mixed" }, { cursor: "not-a-cursor" }), (error) => error.code === "invalid_cursor" && error.status === 400);

  const readme = await discovery.getReadme({ provider: "huggingface", repo: "example-org/Example-Mixed" });
  assert.deepEqual(readme, { markdown: "# readme", truncated: false, revisionSha: mixed.revisionSha });
  await assert.rejects(discovery.getRepo({ provider: "huggingface", repo: "not a repo" }), (error) => error.code === "invalid_request" && error.status === 400);
  await assert.rejects(discovery.getRepo({ provider: "other", repo: "a/b" }), (error) => error.code === "invalid_request");
});
