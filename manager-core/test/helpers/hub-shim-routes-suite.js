"use strict";

// The model-route half of the manager hub-shim tests (03 §15, §20, HUB-13b).
// Every row of the shim table gets a forwarding test against a fake hub that
// verifies every signature with internal-auth.js (fake-hub.js): the test
// checks which hub calls the legacy request made and compares the legacy
// answer with a golden. The goldens live in
// fixtures/hub/hub-legacy-routes.golden.json, one section per manager, and
// are regenerated only with UPDATE_GOLDEN=1. The AI root, the trust token and
// every port are temporary; no real service is called and nothing is spawned.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { startFakeHub } = require("./fake-hub");
const { createHubClient } = require("../../model-hub/client");
const { registerHubShimRoutes } = require("../../model-hub/shim");
const { resolveSelection } = require("../../model-hub/selection");
const hubSettings = require("../../model-hub/settings");

const GOLDEN = path.join(__dirname, "..", "fixtures", "hub", "hub-legacy-routes.golden.json");
const MANIFEST = require("../fixtures/hub/hf-gguf-multiquant.json");

const REPO = "example-org/Example-8B-GGUF";
const FILES = MANIFEST.siblings.map((sibling) => ({
  path: sibling.rfilename,
  size: sibling.size ?? sibling.lfs?.size ?? null,
  sha256: sibling.lfs?.sha256 || null,
  lfs: Boolean(sibling.lfs),
}));
const REVISION_SHA = "c9cb71132e91c418ab146bdbefd9af2760a6340b";
const FAKE_TOKEN = "hf_fake_token_for_tests_only";

const SEARCH_ITEMS = [
  { provider: "huggingface", repo: REPO, author: "example-org", task: "text-generation", formats: ["gguf"], quants: ["Q4_K_M", "Q8_0"], paramsB: 8.19, downloads: 120000, likes: 300, lastModified: "2026-09-18T10:21:34.000Z", gated: false, tags: ["gguf", "text-generation"], baseModel: "Example-Org/Example-8B", familyKey: "example-org/example-8b", fitHint: { label: "fits", status: "ok", neededMb: 6100, basis: "params" }, engines: ["llamacpp"], library: { state: "absent", entryId: null } },
  { provider: "huggingface", repo: "example-org/Example-8B-FP8", author: "example-org", task: "image-text-to-text", formats: ["safetensors", "fp8"], quants: [], paramsB: 8.19, downloads: 4000, likes: 20, lastModified: "2026-09-10T08:00:00.000Z", gated: true, tags: ["fp8", "vision"], baseModel: "Example-Org/Example-8B", familyKey: "example-org/example-8b", fitHint: { label: "tight", status: "warn", neededMb: 9000, basis: "params" }, engines: ["vllm", "sglang"], library: { state: "absent", entryId: null } },
  { provider: "huggingface", repo: "other-org/Big-70B-AWQ", author: "other-org", task: "text-generation", formats: ["safetensors", "awq"], quants: [], paramsB: 70, downloads: 900, likes: 5, lastModified: "2026-08-01T00:00:00.000Z", gated: false, tags: ["awq"], baseModel: null, familyKey: "other-org/big-70b", fitHint: { label: "wont-fit", status: "fail", neededMb: 42000, basis: "params" }, engines: ["vllm", "sglang"], library: { state: "absent", entryId: null } },
];

const ARTIFACT_FITS = {
  Q2_K: { label: "fits", status: "ok", spill: false, neededMb: 5000, headroomMb: 19000, overflowMb: null },
  Q4_K_M: { label: "fits", status: "ok", spill: false, neededMb: 7400, headroomMb: 16600, overflowMb: null },
  Q5_K_M: { label: "tight", status: "warn", spill: false, neededMb: 22000, headroomMb: 1800, overflowMb: null },
  Q8_0: { label: "spills", status: "warn", spill: true, neededMb: 26000, headroomMb: 0, overflowMb: 2000 },
  BF16: { label: "wont-fit", status: "fail", spill: false, neededMb: 40000, headroomMb: null, overflowMb: 16000 },
};

const LIB_ROOT = "X:/hub-fake/lib";
const LIBRARY_ENTRIES = [
  { id: "lib_1111111111111111", kind: "folder", path: `${LIB_ROOT}/example-org-Example-8B-GGUF`, rootId: "r_main", rootLabel: "Library", displayName: "example-org-Example-8B-GGUF", relativePath: "example-org-Example-8B-GGUF", aliases: [], provenance: { provider: "huggingface", transport: "huggingface", repo: REPO, revision: "main", revisionSha: REVISION_SHA, downloadedAt: "2026-10-01T00:00:00.000Z", source: "hub-job", confidence: "declared" } },
  { id: "lib_2222222222222222", kind: "folder", path: `${LIB_ROOT}/mystery-model`, rootId: "r_main", rootLabel: "Library", displayName: "mystery-model", relativePath: "mystery-model", aliases: [], provenance: { provider: null, repo: null, revisionSha: null, confidence: "unknown" } },
  { id: "lib_3333333333333333", kind: "hf-cache-repo", path: "X:/hub-fake/hf/hub/models--x--y", rootId: null, displayName: "x/y", relativePath: "", aliases: [], provenance: { provider: "huggingface", repo: "x/y", confidence: "detected" } },
];
const LIBRARY_ROOTS = [
  { id: "r_main", label: "Library", path: LIB_ROOT, mode: "library", default: true, legacy: false },
  { id: "legacy", label: "Legacy", path: "X:/hub-fake/legacy", mode: "library", default: false, legacy: true },
];

const STORAGE_USAGE = {
  ok: true,
  roots: [
    { id: "r_main", label: "Library", path: LIB_ROOT, mode: "library", default: true, legacy: false, volume: "X:", available: true, freeBytes: 400000000000, totalBytes: 1000000000000, usedByModelsBytes: 5000000000, modelCount: 1, incompleteFiles: 1, incompleteBytes: 1024, pendingBytes: 0, reserveBytes: 10000000000, projectedFreeBytes: 400000000000, hidden: false },
    { id: "legacy", label: "Legacy", path: "X:/hub-fake/legacy", mode: "library", default: false, legacy: true, volume: "X:", available: true, freeBytes: 400000000000, totalBytes: 1000000000000, usedByModelsBytes: 0, modelCount: 0, incompleteFiles: 0, incompleteBytes: 0, pendingBytes: 0, reserveBytes: 10000000000, projectedFreeBytes: 400000000000, hidden: true },
  ],
  models: [
    { name: "example-org-Example-8B-GGUF", path: `${LIB_ROOT}/example-org-Example-8B-GGUF`, rootId: "r_main", sizeBytes: 5000000000, bytes: 5000000000, incomplete: true, incompleteFiles: 1, incompleteBytes: 1024, modified: "2026-10-01T00:00:00.000Z", entryId: "lib_1111111111111111" },
  ],
  hfCache: { path: "X:/hub-fake/hf", volume: "X:", freeBytes: 400000000000, hubBytes: 100, xetBytes: 0, modelscopeBytes: 0 },
  residues: [{ entryId: "lib_1111111111111111", rootId: "r_main", incompleteFiles: 1, incompleteBytes: 1024, busy: false }],
  orphanPartials: [],
  duplicates: [],
  updatedAt: "2026-10-14T08:00:00.000Z",
};

function envelope(code, message, details) {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

function hubJobFor(id, managerId, repo) {
  return {
    schemaVersion: 1,
    id,
    legacyIds: [],
    createdAt: "2026-10-14T08:00:00.000Z",
    updatedAt: "2026-10-14T08:00:00.000Z",
    finishedAt: null,
    origin: { kind: "manager-shim", managerId },
    ownerManagerId: managerId,
    state: "queued",
    priority: "normal",
    artifact: { provider: "huggingface", repo, quant: "Q4_K_M", companions: [], files: [{ path: "m.gguf", size: 100 }], totalBytes: 100 },
    target: { rootId: "r_main", rootLabel: "Library", outputName: "example-org-Example-8B-GGUF", localDir: `${LIB_ROOT}/example-org-Example-8B-GGUF`, volume: "X:" },
    transfer: { engine: "cli", options: { source: "huggingface", endpoint: "https://huggingface.co", xet: "default", tokenRef: "dlt_abcdefghijklmnop" } },
    progress: { bytesDone: 0, bytesTotal: 100, percent: 0, speedBps: 0, speedEmaBps: 0, etaSeconds: null, filesDone: 0, filesTotal: 1, files: [], updatedAt: "2026-10-14T08:00:00.000Z" },
    retry: { count: 0, max: 3, nextAt: null },
    error: null,
  };
}

function mergeInto(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) mergeInto((target[key] = target[key] || {}), value);
    else target[key] = value;
  }
  return target;
}

/**
 * The hub routes the model shims call, as fake-hub handlers. `world` is the
 * mutable state a test steers: settings, the library task result, and the
 * managerId of created jobs.
 */
function installRouteHandlers(hub, { managerId = "vllm" } = {}) {
  const world = hub.world = {
    settings: hubSettings.defaultSettings(),
    deleteTaskState: "succeeded",
    taskPolls: 0,
    checkUpdate: { status: "available", remoteSha: "f".repeat(40), changedFiles: 2, bytesToDownload: 10, checkedAt: "2026-10-14T08:00:00.000Z" },
  };
  const manifest = { repo: REPO, files: FILES };
  const handlers = [];
  const on = (method, match, handle) => handlers.push({ method, match, handle });

  on("GET", /\/files$/, ({ url }) => {
    const limit = Number(url.searchParams.get("limit")) || 500;
    const offset = url.searchParams.get("cursor") ? Number(url.searchParams.get("cursor").slice(1)) : 0;
    const page = FILES.slice(offset, offset + Math.min(limit, 6));
    const next = offset + page.length < FILES.length ? `o${offset + page.length}` : null;
    return { json: { ok: true, files: page, total: FILES.length, nextCursor: next, revisionSha: REVISION_SHA, truncated: false } };
  });

  on("GET", /^\/api\/hub\/repos\/[^/]+\/[^/]+\/[^/]+$/, ({ url }) => {
    if (url.pathname.endsWith("/missing-org/Missing-Model")) return { status: 404, json: envelope("repo_not_found", "The repository was not found.") };
    return {
      json: {
        ok: true,
        provider: "huggingface",
        repo: REPO,
        revision: "main",
        revisionSha: REVISION_SHA,
        access: { gated: url.pathname.includes("Locked") || url.pathname.includes("FP8"), status: "not_required", authorizationUrl: null },
        artifacts: Object.entries(ARTIFACT_FITS).map(([quant, fit]) => ({ artifactKey: `gguf:${quant === "BF16" ? "BF16" : ""}|${quant}`, kind: "gguf-quant", label: quant, format: "gguf", quant, fit })),
        siblingRepos: [{ repo: "example-org/Example-8B-FP8", precision: "FP8" }, { repo: "unsloth/Example-8B-GGUF", precision: "GGUF" }],
        warnings: [],
      },
    };
  });

  on("POST", "/api/hub/plan", ({ body }) => {
    const repo = String(body.repo);
    if (repo === "gated-org/Locked-8B") {
      return { json: { ok: true, planId: "pln_gated", expiresAt: "2026-10-14T08:10:00.000Z", artifact: { files: [], totalBytes: 0 }, access: { gated: true, status: "login_required", authorizationUrl: `https://huggingface.co/${repo}` }, target: { freeBytes: 1 }, blocking: [{ code: "hf_login_required", message: "login", hint: "sign in", actions: ["sign-in"] }], warnings: [] } };
    }
    if (repo === "full-org/Full-8B") {
      return { json: { ok: true, planId: "pln_full", artifact: { files: [], totalBytes: 9e12 }, access: { gated: false, status: "not_required" }, target: { freeBytes: 1 }, blocking: [{ code: "disk_full", message: "The target drive has too little free space.", hint: "free space", actions: ["choose-root"] }], warnings: [] } };
    }
    if (repo === "dup-org/Dup-8B") {
      return { json: { ok: true, planId: "pln_dup", artifact: { files: [], totalBytes: 1 }, access: { gated: false, status: "not_required" }, target: { freeBytes: 1 }, blocking: [{ code: "already_downloading", message: "This folder is already being downloaded.", hint: "wait", actions: ["open-downloads"], existingJobId: "dl_existing0000000000" }], warnings: [] } };
    }
    if (repo === "missing-org/Missing-Model") return { status: 404, json: envelope("repo_not_found", "The repository was not found.") };
    const resolved = resolveSelection(manifest, body.selection || {});
    return {
      json: {
        ok: true,
        planId: "pln_ok0000000000000",
        expiresAt: "2026-10-14T08:10:00.000Z",
        artifact: { artifactKey: resolved.artifactKey, files: resolved.files.map((file) => ({ path: file.path, size: file.size, role: file.role })), totalBytes: resolved.totalBytes, bytesToDownload: resolved.totalBytes, revisionSha: REVISION_SHA },
        target: { rootId: "r_main", rootLabel: "Library", freeBytes: 400000000000 },
        access: { gated: false, status: "not_required", credentialMode: body.credential?.hfToken ? "temp-token" : "cached-login", authorizationUrl: null },
        source: { chosen: body.source === "auto" ? "huggingface" : body.source },
        blocking: [],
        warnings: [],
      },
    };
  });

  on("POST", "/api/hub/downloads", ({ body }) => {
    if (body.planId === "pln_ok0000000000000") return { status: 201, json: { ok: true, job: hubJobFor("dl_newjob0000000000", managerId, REPO) } };
    if (body.planId === "pln_race") return { status: 422, json: envelope("plan_blocked", "The plan has blocking problems.", { blocking: [{ code: "disk_full", message: "The target drive has too little free space." }] }) };
    return { status: 404, json: envelope("plan_not_found", "The plan is unknown or has expired.") };
  });

  on("GET", "/api/hub/search", ({ url }) => {
    const offset = url.searchParams.get("cursor") ? Number(url.searchParams.get("cursor").slice(1)) : 0;
    const wantGguf = url.searchParams.getAll("facet").includes("format:gguf");
    const pool = SEARCH_ITEMS.filter((item) => !wantGguf || item.formats.includes("gguf"));
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const matching = q && q.includes("/") ? pool.filter((item) => item.repo.toLowerCase() === q) : pool;
    // The hub answers at most two items a page, so the shim has to follow the cursor.
    const page = matching.slice(offset, offset + 2);
    return { json: { ok: true, provider: "huggingface", items: page, families: [], facets: {}, nextCursor: offset + page.length < matching.length ? `o${offset + page.length}` : null, partial: false, warnings: [] } };
  });

  on("POST", "/api/hub/resolve-link", ({ body }) => {
    if (/modelscope/.test(String(body.url))) return { json: { ok: true, provider: "modelscope", repo: "ms-org/Ms-Model", revision: "master" } };
    if (/bad/.test(String(body.url))) return { status: 422, json: envelope("unrecognized_link", "That link is not a model page.") };
    return { json: { ok: true, provider: "huggingface", repo: REPO, revision: "main" } };
  });

  on("GET", "/api/hub/settings", () => ({ json: { ok: true, settings: world.settings } }));
  on("PUT", "/api/hub/settings", ({ body }) => {
    mergeInto(world.settings, body.settings || {});
    return { json: { ok: true, settings: world.settings } };
  });

  on("POST", "/api/hub/sources/probe", ({ body }) => ({
    json: {
      ok: true,
      reachable: true,
      repo: body.repo || "Qwen/Qwen2.5-0.5B-Instruct",
      file: "config.json",
      sources: [
        { source: "huggingface", label: "huggingface.co", ok: true, status: 206, ms: 900, bytes: 2097152, bytesPerSec: 100000, error: null, repo: body.repo || "Qwen/Qwen2.5-0.5B-Instruct" },
        { source: "hf-mirror", label: "hf-mirror.com", ok: true, status: 206, ms: 200, bytes: 2097152, bytesPerSec: 2000000, error: null, repo: body.repo || "Qwen/Qwen2.5-0.5B-Instruct" },
        { source: "modelscope", label: "modelscope.cn", ok: false, status: 404, ms: 100, bytes: 0, bytesPerSec: 0, error: "HTTP 404", repo: "qwen/Qwen2.5-0.5B-Instruct" },
      ],
      recommended: "hf-mirror",
      at: "2026-10-14T08:00:00.000Z",
    },
  }));

  on("GET", "/api/hub/auth/huggingface", () => ({ json: { ok: true, connected: true, username: "fake-user", orgs: ["fake-org"], source: "local-cli" } }));
  on("POST", "/api/hub/auth/huggingface/login", ({ body }) => (body.origin?.clientLocal === true
    ? { json: { ok: true, launched: true, tokenUrl: "https://huggingface.co/settings/tokens" } }
    : { status: 403, json: envelope("token_requires_local", "The Hugging Face login is only available from this machine.") }));
  on("GET", "/api/hub/auth/huggingface/access", ({ url }) => ({
    json: { ok: true, granted: url.searchParams.get("repo") !== "example-org/Example-8B-FP8", status: url.searchParams.get("repo") === "example-org/Example-8B-FP8" ? "approval_required" : "granted", username: "fake-user", authorizationUrl: null },
  }));

  on("GET", "/api/hub/storage/usage", () => ({ json: STORAGE_USAGE }));
  on("GET", "/api/hub/library", () => ({ json: { ok: true, entries: LIBRARY_ENTRIES, roots: LIBRARY_ROOTS, nextCursor: null, total: LIBRARY_ENTRIES.length } }));
  on("POST", /^\/api\/hub\/library\/[^/]+\/cleanup-residue$/, ({ url }) => {
    if (url.pathname.includes("lib_2222")) return { status: 409, json: envelope("library_entry_busy", "A download is still using this folder.") };
    return { json: { ok: true, removed: [".cache/huggingface/download/model.safetensors.abc.incomplete"], removedBytes: 1024 } };
  });
  on("POST", /^\/api\/hub\/library\/[^/]+\/check-update$/, ({ url }) => {
    if (url.pathname.includes("lib_2222")) return { json: { ok: true, update: { status: "unsupported", remoteSha: null, changedFiles: 0, bytesToDownload: 0, checkedAt: "2026-10-14T08:00:00.000Z", action: "identify" } } };
    return { json: { ok: true, update: world.checkUpdate } };
  });
  on("DELETE", /^\/api\/hub\/library\/[^/]+$/, ({ body }) => {
    if (body.confirm !== "example-org-Example-8B-GGUF") return { status: 400, json: envelope("confirm_required", "Type the model's name to delete it.") };
    return { status: 202, json: { ok: true, taskId: "tsk_delete0000000", task: { id: "tsk_delete0000000", state: "queued" } } };
  });
  on("GET", /^\/api\/hub\/tasks\/[^/]+$/, () => {
    world.taskPolls += 1;
    const state = world.taskPolls < 2 ? "running" : world.deleteTaskState;
    return { json: { ok: true, task: { id: "tsk_delete0000000", kind: "delete", state, error: state === "failed" ? { code: "library_entry_busy", message: "A download is still using this folder." } : null, result: state === "succeeded" ? { reclaimedBytes: 5000000000 } : null } } };
  });

  hub.state.handlers = handlers;
  return world;
}

function readGolden() {
  try {
    return JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  } catch {
    return {};
  }
}

function runHubShimRoutesSuite({ managerId, express }) {
  let hub;
  let server;
  let base;
  let shim;
  let lan;
  let lanBase;
  const recorded = {};
  const golden = readGolden();
  const modelsSeen = [];
  const precheckSeen = [];

  function mount({ isLocal }) {
    const app = express();
    app.use(express.json());
    const client = createHubClient({ baseUrl: hub.baseUrl, managerId, readKey: () => hub.token });
    const registration = registerHubShimRoutes(app, {
      managerId,
      client,
      isLocalRequest: () => isLocal,
      listModels: async () => ({ local: [{ name: "example-org-Example-8B-GGUF", path: `${LIB_ROOT}/example-org-Example-8B-GGUF` }, { name: "unknown-model", path: `${LIB_ROOT}/unknown-model` }], cached: [] }),
      precheckDownload: async (query, hubInput) => {
        precheckSeen.push({ query, estimate: hubInput.estimate });
        return { ok: true, findings: [], source: query.source || "huggingface" };
      },
      precisionOrder: ["FP8", "AWQ"],
      relayThrottleMs: 0,
      // No SSE listener here, so a started download triggers no list re-read.
      hasListeners: () => false,
      deleteLocalModel: managerId === "vllm" ? undefined : false,
    });
    return new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve({ listening, registration, base: `http://127.0.0.1:${listening.address().port}` }));
    });
  }

  test.before(async () => {
    hub = await startFakeHub();
    installRouteHandlers(hub, { managerId });
    ({ listening: server, registration: shim, base } = await mount({ isLocal: true }));
    ({ listening: lan, base: lanBase } = await mount({ isLocal: false }));
  });

  test.after(async () => {
    shim?.close();
    for (const listening of [server, lan]) {
      listening?.closeAllConnections?.();
      await new Promise((resolve) => (listening ? listening.close(resolve) : resolve()));
    }
    await hub?.close();
    if (process.env.UPDATE_GOLDEN === "1") {
      const all = readGolden();
      all[managerId] = recorded;
      fs.writeFileSync(GOLDEN, `${JSON.stringify(all, null, 2)}\n`);
    }
  });

  test.beforeEach(() => {
    hub.state.mode = "ok";
    hub.world.taskPolls = 0;
    hub.world.deleteTaskState = "succeeded";
  });

  // One request to a shim, the hub calls it caused, and the legacy answer.
  async function exercise(label, request, { origin = base } = {}) {
    const start = hub.state.requests.length;
    const response = await fetch(`${origin}${request.path}`, {
      method: request.method || "GET",
      headers: request.body === undefined ? {} : { "content-type": "application/json" },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    const calls = hub.state.requests.slice(start).map((item) => ({ call: `${item.method} ${item.url}`, ...(item.body ? { body: item.body } : {}) }));
    assert.ok(hub.state.requests.slice(start).every((item) => item.principal === `system:hub-shim:${managerId}`), `${label}: every hub call was signed`);
    const entry = { status: response.status, body: json, hub: calls };
    recorded[label] = entry;
    if (process.env.UPDATE_GOLDEN !== "1") assert.deepEqual(entry, golden[managerId]?.[label], `${label} matches its golden`);
    return { ...entry, calls: hub.state.requests.slice(start) };
  }

  test("POST /api/download plans, enqueues the planId and answers { job } (local caller, token forwarded)", async () => {
    const result = await exercise("download", { method: "POST", path: "/api/download", body: { model: REPO, precision: "Q4_K_M", outputName: "my-copy", storageId: "r_main", source: "huggingface", priority: "high", hfToken: FAKE_TOKEN, expectedBytes: 1 } });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body), ["job"]);
    assert.equal(result.body.job.id, "dl_newjob0000000000");
    assert.equal(result.body.job.meta.transfer.tokenRef, null);
    const plan = result.calls.find((item) => item.url === "/api/hub/plan");
    assert.deepEqual(plan.body.selection, { artifactKey: "gguf:|Q4_K_M", companions: [], files: null, acceptIncomplete: false });
    assert.equal(plan.body.source, "huggingface", "a token forces the official endpoint");
    assert.deepEqual(plan.body.credential, { hfToken: FAKE_TOKEN });
    assert.deepEqual(plan.body.origin, { kind: "manager-shim", managerId, clientLocal: true });
    assert.deepEqual(plan.body.target, { rootId: "r_main", outputName: "my-copy" });
    assert.equal(plan.body.priority, "high");
    const enqueue = result.calls.find((item) => item.url === "/api/hub/downloads");
    assert.deepEqual(enqueue.body, { planId: "pln_ok0000000000000", origin: { kind: "manager-shim", managerId, clientLocal: true } });
    assert.ok(!JSON.stringify(enqueue.body).includes(FAKE_TOKEN), "the token goes to the plan only");
  });

  test("POST /api/download from a caller the manager judged not local never forwards the token", async () => {
    const result = await exercise("download-lan", { method: "POST", path: "/api/download", body: { model: REPO, precision: "Q4_K_M", hfToken: FAKE_TOKEN } }, { origin: lanBase });
    assert.equal(result.status, 200);
    const everything = JSON.stringify(result.calls.map((item) => item.body));
    assert.ok(!everything.includes(FAKE_TOKEN), "no hub call carries the token");
    const plan = result.calls.find((item) => item.url === "/api/hub/plan");
    assert.equal(Object.hasOwn(plan.body, "credential"), false);
    assert.equal(plan.body.source, "auto");
    assert.deepEqual(plan.body.origin, { kind: "manager-shim", managerId, clientLocal: false });
  });

  test("POST /api/download keeps the legacy error shapes: filter_no_match, duplicate, gated, disk, unknown repo", async () => {
    const noMatch = await exercise("download-filter-no-match", { method: "POST", path: "/api/download", body: { model: REPO, precision: "Q9_X" } });
    assert.equal(noMatch.status, 422);
    assert.equal(noMatch.body.code, "filter_no_match");
    assert.deepEqual(noMatch.body.details, { precision: "Q9_X", totalFiles: FILES.length });
    assert.ok(noMatch.body.suggestions.length > 0);
    assert.match(noMatch.body.error, /Q4_K_M 4\.7 GB/, "the quant list rides in the message the legacy pages show");
    assert.equal(noMatch.calls.some((item) => item.url === "/api/hub/plan"), false, "an empty selection never reaches the plan");

    const duplicate = await exercise("download-duplicate", { method: "POST", path: "/api/download", body: { model: "dup-org/Dup-8B", precision: "Q4_K_M" } });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.existingJobId, "dl_existing0000000000");

    const gated = await exercise("download-gated", { method: "POST", path: "/api/download", body: { model: "gated-org/Locked-8B", precision: "Q4_K_M" } });
    assert.equal(gated.status, 409);
    assert.equal(gated.body.code, "hf_login_required");
    assert.equal(gated.body.accessStatus, "login_required");
    assert.equal(gated.body.authorizationUrl, "https://huggingface.co/gated-org/Locked-8B");

    const disk = await exercise("download-disk-full", { method: "POST", path: "/api/download", body: { model: "full-org/Full-8B", precision: "Q4_K_M" } });
    assert.equal(disk.status, 400);
    assert.equal(disk.body.code, "download_disk_full");

    const missing = await exercise("download-repo-not-found", { method: "POST", path: "/api/download", body: { model: "missing-org/Missing-Model", precision: "Q4_K_M" } });
    assert.equal(missing.status, 404);
    assert.deepEqual(Object.keys(missing.body).sort(), ["code", "error"]);

    const empty = await exercise("download-no-model", { method: "POST", path: "/api/download", body: {} });
    assert.equal(empty.status, 400);
    assert.deepEqual(empty.body, { error: "model is required" });
  });

  test("GET /api/download/estimate answers the legacy fields from the plan, and ModelScope is supported", async () => {
    const result = await exercise("estimate", { path: `/api/download/estimate?${new URLSearchParams({ model: REPO, precision: "Q4_K_M", storageId: "r_main" })}` });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ["authorizationUrl", "bytes", "diskFreeBytes", "fileCount", "filtered", "gateMode", "gated", "includePatterns", "matchedFiles", "model", "precision", "source", "supported", "totalFiles"]);
    assert.equal(result.body.supported, true);
    assert.equal(result.body.filtered, true);
    assert.ok(result.body.includePatterns.length > 0);
    assert.equal(result.body.totalFiles, FILES.length);
    assert.equal(result.body.diskFreeBytes, 400000000000);
    const plan = result.calls.find((item) => item.url === "/api/hub/plan");
    assert.equal(plan.body.target.rootId, "r_main");

    const whole = await exercise("estimate-whole-repo", { path: `/api/download/estimate?${new URLSearchParams({ model: REPO })}` });
    assert.equal(whole.body.filtered, false);
    assert.deepEqual(whole.body.includePatterns, []);

    const noMatch = await exercise("estimate-no-match", { path: `/api/download/estimate?${new URLSearchParams({ model: REPO, precision: "Q9_X" })}` });
    assert.equal(noMatch.status, 200);
    assert.equal(noMatch.body.matchedFiles, 0);
    assert.equal(noMatch.body.filtered, true);

    const modelscope = await exercise("estimate-modelscope", { path: `/api/download/estimate?${new URLSearchParams({ model: "ms-org/Ms-Model", source: "modelscope" })}` });
    assert.equal(modelscope.body.supported, true);
    assert.equal(modelscope.body.source, "modelscope");
  });

  test("GET /api/download/precheck runs the manager's assessment over the hub's file list", async () => {
    precheckSeen.length = 0;
    const result = await exercise("precheck", { path: `/api/download/precheck?${new URLSearchParams({ model: REPO, precision: "Q4_K_M" })}` });
    assert.equal(result.status, 200);
    assert.equal(precheckSeen.length, 1);
    const { estimate } = precheckSeen[0];
    assert.equal(estimate.siblings.length, FILES.length);
    assert.deepEqual(Object.keys(estimate.siblings[0]).sort(), ["name", "size"]);
    assert.equal(estimate.bytes, resolveSelection({ repo: REPO, files: FILES }, { artifactKey: "gguf:|Q4_K_M" }).totalBytes, "the bytes of the selected precision, sidecars included");
    assert.ok(estimate.bytes < FILES.reduce((sum, file) => sum + file.size, 0));
    assert.equal(estimate.gated, false);
  });

  test("GET /api/remote-models follows the hub cursor, maps to the legacy summary and applies the legacy filters", async () => {
    const result = await exercise("remote-models", { path: `/api/remote-models?${new URLSearchParams({ source: "huggingface", sort: "trending", limit: "48", search: "example" })}` });
    assert.equal(result.status, 200);
    const searches = result.calls.filter((item) => item.url.startsWith("/api/hub/search"));
    assert.equal(searches.length, managerId === "llama" ? 1 : 2, "the second page is read from the cursor");
    if (managerId === "llama") assert.ok(searches[0].url.includes("facet=format%3Agguf"), "llama asks for GGUF repos by facet, not by a query suffix");
    assert.ok(!searches[0].url.includes("GGUF&") && !decodeURIComponent(searches[0].url).includes("q=example GGUF"));
    for (const model of result.body.models) {
      assert.equal(model.id, model.model);
      assert.equal(typeof model.outputName, "string");
      assert.ok(Array.isArray(model.quantFormats));
      assert.equal(typeof model.runnable, "boolean");
    }
    assert.deepEqual(Object.keys(result.body).sort(), ["feature", "freshness", "limit", "models", "quant", "search", "size", "sort", "source", "task"]);

    const filtered = await exercise("remote-models-filtered", { path: `/api/remote-models?${new URLSearchParams({ size: "xlarge", quant: "AWQ", limit: "12", sort: "lastModified" })}` });
    assert.deepEqual(filtered.body.models.map((model) => model.id), managerId === "llama" ? [] : ["other-org/Big-70B-AWQ"]);
    assert.ok(filtered.calls[0].url.includes("sort=updated"));
  });

  test("GET /api/remote-models/gguf-variants keeps the legacy table with the hub's fits", async () => {
    const result = await exercise("gguf-variants", { path: `/api/remote-models/gguf-variants?${new URLSearchParams({ model: REPO, precision: "Q4_K_M" })}` });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ["drafts", "gated", "mmproj", "model", "other", "selected", "source", "supported", "totalFiles", "variants"]);
    assert.deepEqual(result.body.variants.map((variant) => [variant.quant, variant.fit.status]), [["Q2_K", "fits"], ["Q4_K_M", "fits"], ["Q5_K_M", "tight"], ["Q8_0", "tight"], ["BF16", "exceeds"]]);
    for (const variant of result.body.variants) assert.deepEqual(Object.keys(variant).sort(), ["bytes", "complete", "directory", "files", "fileCount", "fit", "multiPart", "quant", "vllmLoadable"].sort());
    assert.equal(result.body.selected, "Q4_K_M");

    const modelscope = await exercise("gguf-variants-modelscope", { path: `/api/remote-models/gguf-variants?${new URLSearchParams({ model: "ms-org/Ms-Model", source: "modelscope" })}` });
    assert.deepEqual(modelscope.body, { model: "ms-org/Ms-Model", source: "modelscope", supported: false, variants: [], mmproj: [], drafts: [] });
    assert.deepEqual(modelscope.hub, []);
  });

  test("GET /api/remote-models/precision-variants groups the hub's sibling repos", async () => {
    const result = await exercise("precision-variants", { path: `/api/remote-models/precision-variants?${new URLSearchParams({ model: REPO })}` });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ["base", "model", "variants"]);
    assert.ok(result.body.variants.some((variant) => variant.isCurrent && variant.id === REPO));
    assert.ok(result.body.variants.some((variant) => variant.precision === "FP8"));
  });

  test("GET and POST /api/download/settings map the legacy seven keys onto the hub settings", async () => {
    const read = await exercise("settings-get", { path: "/api/download/settings" });
    assert.deepEqual(Object.keys(read.body).sort(), ["autoRetryCount", "autoRetryDelaySeconds", "hfMirror", "hfTransfer", "idleOnlyQueue", "queueMode", "verifyChecksums"]);
    const write = await exercise("settings-post", { method: "POST", path: "/api/download/settings", body: { hfMirror: true, autoRetryCount: 5, queueMode: false, idleOnlyQueue: true } });
    assert.deepEqual(write.body, { queueMode: false, autoRetryCount: 5, autoRetryDelaySeconds: 10, hfMirror: true, hfTransfer: true, verifyChecksums: true, idleOnlyQueue: true });
    const put = write.calls.find((item) => item.method === "PUT");
    assert.deepEqual(put.body.origin, { kind: "manager-shim", managerId, clientLocal: true });
    assert.equal(put.body.settings.sources.policy, "hf-mirror");
    assert.equal(put.body.settings.transfer.maxConcurrent, 3);
    // An empty body changes nothing and writes nothing.
    const unchanged = await exercise("settings-post-empty", { method: "POST", path: "/api/download/settings", body: {} });
    assert.equal(unchanged.calls.some((item) => item.method === "PUT"), false);
    hub.world.settings = hubSettings.defaultSettings();
  });

  test("POST /api/download/mirror-probe is informational and never writes settings", async () => {
    const result = await exercise("mirror-probe", { method: "POST", path: "/api/download/mirror-probe", body: { model: REPO } });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ["at", "file", "mirror", "modelScopeRepo", "modelscope", "official", "ok", "recommended", "recommendedLabel", "repo", "sources"]);
    assert.equal(result.body.recommended, "mirror");
    assert.equal(result.body.recommendedLabel, "hf-mirror.com");
    assert.equal(result.calls.some((item) => item.method === "PUT"), false);
    const bare = await exercise("mirror-probe-bare", { method: "POST", path: "/api/download/mirror-probe", body: {} });
    assert.equal(Object.hasOwn(bare.calls[0].body, "repo"), false);
  });

  test("POST /api/resolve-model-link keeps the existing shape for Hugging Face and ModelScope links", async () => {
    const hf = await exercise("resolve-link-hf", { method: "POST", path: "/api/resolve-model-link", body: { url: `https://huggingface.co/${REPO}` } });
    assert.equal(hf.status, 200);
    assert.equal(hf.body.source, "huggingface");
    assert.equal(hf.body.model, REPO);
    assert.equal(hf.body.outputName, "example-org-Example-8B-GGUF");
    assert.ok(hf.body.selection && hf.body.selection.options);
    const ms = await exercise("resolve-link-modelscope", { method: "POST", path: "/api/resolve-model-link", body: { url: "https://www.modelscope.cn/models/ms-org/Ms-Model" } });
    assert.equal(ms.body.source, "modelscope");
    assert.equal(ms.body.model, "ms-org/Ms-Model");
    const bad = await exercise("resolve-link-bad", { method: "POST", path: "/api/resolve-model-link", body: { url: "https://example.com/bad" } });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body, { error: "That link is not a model page.", code: "unrecognized_link" });
  });

  test("GET /api/models/disk-usage is 08's shape with every hub-only field stripped", async () => {
    const result = await exercise("disk-usage", { path: "/api/models/disk-usage" });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ["disk", "hfCache", "incompleteBytes", "incompleteFiles", "models", "modelsBytes", "ok", "root", "roots", "updatedAt"]);
    const text = JSON.stringify(result.body);
    for (const hubOnly of ["volume", "pendingBytes", "reserveBytes", "projectedFreeBytes", "hidden", "entryId", "residues", "orphanPartials", "duplicates"]) assert.ok(!text.includes(`"${hubOnly}"`), hubOnly);
    assert.deepEqual(result.body.roots.map((root) => root.id), ["r_main", "legacy"], "every root is listed, hidden or not, as 08 does");
    assert.equal(result.body.root, LIB_ROOT);
    assert.deepEqual(result.body.disk, { freeBytes: 400000000000, totalBytes: 1000000000000 });
    assert.equal(result.body.models[0].rootId, "r_main");
  });

  test("POST /api/models/cleanup-incomplete resolves a name or a path to the library entry", async () => {
    const byName = await exercise("cleanup-incomplete-name", { method: "POST", path: "/api/models/cleanup-incomplete", body: { name: "example-org-Example-8B-GGUF" } });
    assert.equal(byName.status, 200);
    assert.deepEqual(Object.keys(byName.body).sort(), ["ok", "path", "removed", "removedBytes"]);
    assert.ok(byName.hub.some((item) => item.call === "POST /api/hub/library/lib_1111111111111111/cleanup-residue"));
    const byPath = await exercise("cleanup-incomplete-path", { method: "POST", path: "/api/models/cleanup-incomplete", body: { path: `${LIB_ROOT}/example-org-Example-8B-GGUF/sub` } });
    assert.equal(byPath.status, 200);
    assert.equal(byPath.body.path, `${LIB_ROOT}/example-org-Example-8B-GGUF`);
    const outside = await exercise("cleanup-incomplete-outside", { method: "POST", path: "/api/models/cleanup-incomplete", body: { path: "X:/elsewhere/model" } });
    assert.equal(outside.status, 400);
    assert.equal(outside.body.code, "path_outside_roots");
    assert.equal(outside.calls.some((item) => item.url.includes("cleanup-residue")), false);
    const root = await exercise("cleanup-incomplete-root", { method: "POST", path: "/api/models/cleanup-incomplete", body: { path: LIB_ROOT } });
    assert.equal(root.body.code, "path_outside_roots", "a library root itself is refused");
    const busy = await exercise("cleanup-incomplete-busy", { method: "POST", path: "/api/models/cleanup-incomplete", body: { name: "mystery-model" } });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, "library_entry_busy");
  });

  test("GET /api/models/upstream-status maps the update check to the legacy fields", async () => {
    const result = await exercise("upstream-status", { path: `/api/models/upstream-status?${new URLSearchParams({ name: "example-org-Example-8B-GGUF" })}` });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.updateAvailable, true);
    assert.equal(result.body.repo, REPO);
    assert.equal(result.body.remoteSha, "f".repeat(40));
    assert.equal(result.body.localSha, REVISION_SHA);
    for (const key of ["name", "repo", "url", "lastModified", "downloadedAt", "updateAvailable", "message", "remoteSha", "localSha"]) assert.ok(Object.hasOwn(result.body, key), key);
    const unknown = await exercise("upstream-status-unknown", { path: `/api/models/upstream-status?${new URLSearchParams({ path: `${LIB_ROOT}/mystery-model` })}` });
    assert.equal(unknown.body.ok, false);
    assert.equal(unknown.body.reason, "unknown_source");
  });

  if (managerId === "vllm") {
    test("POST /api/models/delete-local deletes through the library entry and waits for the task", async () => {
      const result = await exercise("delete-local", { method: "POST", path: "/api/models/delete-local", body: { name: "example-org-Example-8B-GGUF" } });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { ok: true, name: "example-org-Example-8B-GGUF", path: `${LIB_ROOT}/example-org-Example-8B-GGUF` });
      const remove = result.calls.find((item) => item.method === "DELETE");
      assert.equal(remove.url, "/api/hub/library/lib_1111111111111111");
      assert.equal(remove.body.confirm, "example-org-Example-8B-GGUF");
      assert.ok(result.calls.filter((item) => item.url.startsWith("/api/hub/tasks/")).length >= 2, "the task is polled until it ends");

      hub.world.deleteTaskState = "failed";
      const busy = await exercise("delete-local-busy", { method: "POST", path: "/api/models/delete-local", body: { name: "example-org-Example-8B-GGUF" } });
      assert.equal(busy.status, 409);
      assert.equal(busy.body.code, "library_entry_busy");
      const missing = await exercise("delete-local-missing", { method: "POST", path: "/api/models/delete-local", body: { name: "no-such-model" } });
      assert.equal(missing.status, 404);
    });
  } else {
    test("the llama shim has no delete-local route, as before", async () => {
      const response = await fetch(`${base}/api/models/delete-local`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
      assert.equal(response.status, 404);
    });
  }

  test("/api/huggingface/auth/status|login and /access forward for a local caller and answer 403 for a LAN one", async () => {
    const status = await exercise("hf-auth-status", { path: "/api/huggingface/auth/status" });
    assert.deepEqual(status.body, { connected: true, username: "fake-user", orgs: ["fake-org"], source: "local-cli" });
    const login = await exercise("hf-auth-login", { method: "POST", path: "/api/huggingface/auth/login", body: {} });
    assert.deepEqual(login.body, { launched: true, tokenUrl: "https://huggingface.co/settings/tokens" });
    assert.deepEqual(login.calls[0].body, { origin: { kind: "manager-shim", managerId, clientLocal: true } });
    const open = await exercise("hf-access-public", { path: `/api/huggingface/access?${new URLSearchParams({ model: REPO })}` });
    assert.deepEqual(open.body, { model: REPO, gated: false, granted: true, status: "public", authorizationUrl: `https://huggingface.co/${REPO}` });
    const gated = await exercise("hf-access-gated", { path: `/api/huggingface/access?${new URLSearchParams({ model: "example-org/Example-8B-FP8" })}` });
    assert.equal(gated.body.gated, true);
    assert.equal(gated.body.granted, false);
    assert.equal(gated.body.status, "approval_required");

    // The manager judged this caller not local: no hub call, the legacy 403.
    const before = hub.state.requests.length;
    for (const [label, request] of [["status", { path: "/api/huggingface/auth/status" }], ["login", { method: "POST", path: "/api/huggingface/auth/login", body: {} }], ["access", { path: `/api/huggingface/access?model=${REPO}` }]]) {
      const denied = await exercise(`hf-auth-lan-${label}`, request, { origin: lanBase });
      assert.equal(denied.status, 403, label);
      assert.deepEqual(Object.keys(denied.body), ["error"]);
    }
    assert.equal(hub.state.requests.length, before, "a non-local caller never reaches the hub, so it never opens the login");
  });

  test("GET /api/models adds libraryEntryId and provenance from the library, best effort", async () => {
    const result = await exercise("models-decorated", { path: "/api/models" });
    assert.equal(result.status, 200);
    const [known, unknown] = result.body.local;
    assert.equal(known.libraryEntryId, "lib_1111111111111111");
    assert.deepEqual(known.provenance, { provider: "huggingface", repo: REPO, revisionSha: REVISION_SHA, confidence: "declared" });
    assert.equal(Object.hasOwn(unknown, "libraryEntryId"), false);
    assert.deepEqual(Object.keys(known).sort(), ["libraryEntryId", "name", "path", "provenance"]);
  });

  test("with the hub down the model routes answer 503 hub_unavailable and /api/models stays the plain listing", async () => {
    hub.state.mode = "hub-down";
    for (const request of [
      { method: "POST", path: "/api/download", body: { model: REPO, precision: "Q4_K_M" } },
      { path: `/api/remote-models?${new URLSearchParams({ limit: "12" })}` },
      { path: "/api/download/settings" },
      { path: "/api/models/disk-usage" },
    ]) {
      const response = await fetch(`${base}${request.path}`, { method: request.method || "GET", headers: request.body ? { "content-type": "application/json" } : {}, body: request.body ? JSON.stringify(request.body) : undefined });
      assert.equal(response.status, 503, request.path);
      const body = await response.json();
      assert.equal(body.code, "hub_unavailable", request.path);
      assert.match(body.error, /service-entry is not running/);
    }
    // The 5 s library cache of the earlier test would hide the outage; a fresh shim shows it.
    const fresh = await mount({ isLocal: true });
    try {
      const response = await fetch(`${fresh.base}/api/models`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.local.map((model) => Object.keys(model).sort()), [["name", "path"], ["name", "path"]]);
    } finally {
      fresh.registration.close();
      fresh.listening.closeAllConnections?.();
      await new Promise((resolve) => fresh.listening.close(resolve));
    }
  });

  test("a rejected signature is hub_auth_failed on the model routes", async () => {
    hub.state.mode = "reject";
    const response = await fetch(`${base}/api/download/settings`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "hub_auth_failed");
  });
}

module.exports = { FAKE_TOKEN, installRouteHandlers, runHubShimRoutesSuite };
