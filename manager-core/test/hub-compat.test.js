"use strict";

// HUB-13a (03 §15, §20): the pure legacy mappers the manager shims use. The
// toLegacyJob golden is regenerated only with UPDATE_GOLDEN=1.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const compat = require("../model-hub/compat");
const { JOB_STATES } = require("../model-hub/queue");
const { summarizeJob } = require("../job-routes");

const FIXTURES = path.join(__dirname, "fixtures", "hub");
const GOLDEN = path.join(FIXTURES, "hub-legacy-jobs.golden.json");
const { jobs: HUB_JOBS } = JSON.parse(fs.readFileSync(path.join(FIXTURES, "hub-jobs.json"), "utf8"));
const LOG_LINES = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);

// What platform-mcp's listJobs reads from /api/jobs?fields=summary (F9).
const MCP_KEYS = ["id", "type", "title", "status", "createdAt", "updatedAt", "finishedAt", "progress", "error"];
// 08 C2: the failure-card fields of a legacy download job's meta.
const P0_META_KEYS = ["errorCode", "errorRetryable", "errorHint", "transfer"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("toLegacyJob summary golden", () => {
  const actual = HUB_JOBS.map((job) => compat.toLegacyJob(job, { summary: true, logs: LOG_LINES, logCount: 40 }));
  if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(GOLDEN, "utf8")));
});

test("the legacy key set is what platform-mcp reads plus 08 C2's meta, and the vault ref never leaves", () => {
  for (const job of HUB_JOBS) {
    const legacy = compat.toLegacyJob(job, { summary: true });
    for (const key of MCP_KEYS) assert.ok(Object.hasOwn(legacy, key), key);
    for (const key of P0_META_KEYS) assert.ok(Object.hasOwn(legacy.meta, key), `meta.${key}`);
    assert.deepEqual(Object.keys(legacy).sort(), [...MCP_KEYS, "exitCode", "logCount", "logs", "logsTruncated", "meta"].sort());
    assert.deepEqual(Object.keys(legacy.meta.transfer).sort(), ["gated", "hfEndpoint", "hfMirror", "hfTransfer", "tokenRef"]);
    assert.equal(legacy.meta.transfer.tokenRef, null);
    assert.equal(legacy.type, "download");
    assert.equal(typeof legacy.progress.percent, "number");
    assert.equal(legacy.meta.hubJobId, job.id);
    assert.equal(legacy.meta.phase, job.state);
  }
  // The first fixture's hub options hold a tokenRef; nothing of it survives.
  assert.equal(HUB_JOBS[0].transfer.options.tokenRef.startsWith("dlt_"), true);
  assert.equal(JSON.stringify(HUB_JOBS.map((job) => compat.toLegacyJob(job))).includes("dlt_"), false);
});

test("the summary keeps the legacy summarizeJob window and the detail keeps 200 lines", () => {
  const job = HUB_JOBS[0];
  const lines = Array.from({ length: 250 }, (_, index) => `l${index}`);
  const summary = compat.toLegacyJob(job, { summary: true, logs: lines });
  assert.deepEqual(summary.logs, lines.slice(-8));
  assert.equal(summary.logCount, 250);
  assert.equal(summary.logsTruncated, true);
  const detail = compat.toLegacyJob(job, { logs: lines });
  assert.equal(detail.logs.length, 200);
  assert.equal(detail.logsTruncated, true);
  // Without a log tail the list rows carry none, like a summarized job without logs.
  const bare = compat.toLegacyJob(job, { summary: true });
  assert.deepEqual([bare.logs, bare.logCount, bare.logsTruncated], [[], 0, false]);
  const { logs, logCount, logsTruncated } = summarizeJob({ id: "x", logs: lines });
  assert.deepEqual([summary.logs, summary.logCount, summary.logsTruncated], [logs, logCount, logsTruncated]);
});

test("the status table covers every hub state (03 §7.1)", () => {
  assert.deepEqual(Object.keys(compat.LEGACY_STATUS).sort(), [...JOB_STATES].sort());
  assert.deepEqual(compat.LEGACY_STATUS, {
    queued: "queued", waiting: "queued", resolving: "running", downloading: "running", materializing: "running", verifying: "running",
    ready: "success", retrying: "queued", paused: "paused", interrupted: "interrupted", failed: "failed", cancelled: "cancelled",
  });
  for (const state of JOB_STATES) {
    const job = { ...clone(HUB_JOBS[0]), state };
    const legacy = compat.toLegacyJob(job);
    assert.equal(legacy.status, compat.LEGACY_STATUS[state], state);
    assert.ok(legacy.progress.stage.zh && legacy.progress.stage.en, state);
    assert.equal(/[㐀-鿿]/.test(legacy.progress.stage.en), false, state);
  }
});

test("a failed hub job maps to the 08 failure-card fields", () => {
  const legacy = compat.toLegacyJob(HUB_JOBS[1]);
  assert.equal(legacy.status, "failed");
  assert.equal(legacy.error, "需要登录 Hugging Face / Hugging Face login required");
  assert.equal(legacy.meta.errorCode, "hf_login_required");
  assert.equal(legacy.meta.errorBaseCode, "hf_auth_invalid");
  assert.equal(legacy.meta.errorRetryable, false);
  assert.deepEqual(legacy.meta.errorHint, { zh: "先登录 Hugging Face 再重试。", en: "Sign in to Hugging Face, then retry." });
  assert.equal(legacy.exitCode, 1);
  assert.equal(legacy.title, "Download Qwen/Qwen3-8B (ModelScope)");
  assert.equal(JSON.stringify(legacy).includes("401 Client Error"), false, "error.detail stays in the hub");
  const running = compat.toLegacyJob(HUB_JOBS[0]);
  assert.deepEqual([running.error, running.meta.errorCode, running.meta.errorHint], [null, null, null]);
  assert.deepEqual(running.meta.transfer, { hfMirror: true, hfEndpoint: "https://hf-mirror.com", hfTransfer: true, tokenRef: null, gated: false });
  assert.deepEqual([running.progress.finalizedBytes, running.progress.partialBytes, running.progress.incompleteFiles], [21043, 2070000000, 2]);
});

test("job actions, logs, resume checks and errors keep the legacy shapes", () => {
  assert.deepEqual(compat.toLegacyJobAction({ id: "dl_7k2m4q9x3c5vb8np", state: "paused" }), { ok: true, id: "dl_7k2m4q9x3c5vb8np", status: "paused" });
  assert.deepEqual(compat.toLegacyJobLogs("job-legacy-1", { ok: true, lines: ["a", "b"], total: 9 }), { id: "job-legacy-1", logs: ["a", "b"], logCount: 9 });
  assert.deepEqual(
    compat.toLegacyResumeCheck({ ok: true, jobId: "dl_7k2m4q9x3c5vb8np", state: "interrupted", complete: false, bytesRemaining: 10, diskFreeBytes: 99 }),
    { ok: true, id: "dl_7k2m4q9x3c5vb8np", status: "interrupted", complete: false, bytesRemaining: 10, diskFreeBytes: 99 },
  );
  assert.deepEqual(
    compat.toLegacyError({ ok: false, error: { code: "invalid_state", message: "The download is not paused.", hint: "Pause it first." } }),
    { error: "The download is not paused.", code: "invalid_state", hint: "Pause it first." },
  );
  assert.deepEqual(compat.toLegacyError(null), { error: "Model hub request failed.", code: "hub_error" });
});

// --- HUB-13b: download, catalogue, settings, auth and storage mappers ---------

const os = require("node:os");
const { createModelFilesystemStore } = require("../model-filesystem-store");
const hubSettings = require("../model-hub/settings");

function hubStorageUsage(roots, models) {
  return {
    ok: true,
    roots: roots.map((root) => ({
      ...root,
      volume: "X:", available: true, pendingBytes: 0, reserveBytes: 10, projectedFreeBytes: 1, hidden: false,
    })),
    models: models.map((model) => ({ ...model, entryId: "lib_1111111111111111" })),
    hfCache: { path: "X:/hf", volume: "X:", freeBytes: 5, hubBytes: 1, xetBytes: 2, modelscopeBytes: 3 },
    residues: [{ entryId: "lib_1111111111111111", rootId: "main", incompleteFiles: 1, incompleteBytes: 1024, busy: false }],
    orphanPartials: [],
    duplicates: [],
    updatedAt: "2026-10-14T08:00:00.000Z",
  };
}

test("the disk-usage shim has exactly 08's shape: same keys at every level, hub-only fields stripped", async (t) => {
  // 08 P0-DL-3's own producer over a temp tree, then the same tree as the hub reports it.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hub-compat-usage-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const legacy = path.join(base, "lib-legacy");
  const main = path.join(base, "lib-main");
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(path.join(main, "org__alpha"), { recursive: true });
  fs.writeFileSync(path.join(main, "org__alpha", "model.safetensors"), Buffer.alloc(4096));
  fs.mkdirSync(path.join(main, "org__beta", ".cache", "huggingface", "download"), { recursive: true });
  fs.writeFileSync(path.join(main, "org__beta", ".cache", "huggingface", "download", "m.safetensors.abc.incomplete"), Buffer.alloc(1024));
  const store = createModelFilesystemStore({
    modelsRoot: legacy,
    hfCache: path.join(base, "hf-home"),
    listRoots: () => [
      { id: "legacy", path: legacy, label: "Legacy", default: false, legacy: true },
      { id: "main", path: main, label: "Main", default: true, legacy: false },
    ],
  });
  const expected = await store.getDiskUsage();

  const pickRoot = ({ id, path: rootPath, label, default: isDefault, legacy: isLegacy, mode, available, freeBytes, totalBytes, usedByModelsBytes, modelCount, incompleteBytes, incompleteFiles }) => (
    { id, path: rootPath, label, default: isDefault, legacy: isLegacy, mode, available, freeBytes, totalBytes, usedByModelsBytes, modelCount, incompleteBytes, incompleteFiles });
  const hub = hubStorageUsage(expected.roots.map(pickRoot), expected.models.map((model) => ({ ...model })));
  const actual = compat.toLegacyDiskUsage(hub);
  const keys = (value) => Object.keys(value).sort();
  assert.deepEqual(keys(actual), keys(expected));
  assert.deepEqual(keys(actual.roots[0]), keys(expected.roots[0]));
  assert.deepEqual(keys(actual.models[0]), keys(expected.models[0]));
  assert.deepEqual(keys(actual.hfCache), keys(expected.hfCache));
  assert.deepEqual(keys(actual.disk), keys(expected.disk));
  // The default root fills the legacy top-level fields, as the legacy store did.
  assert.equal(actual.root, expected.root);
  assert.equal(actual.modelsBytes, expected.modelsBytes);
  assert.equal(actual.incompleteFiles, expected.incompleteFiles);
  assert.equal(actual.incompleteBytes, expected.incompleteBytes);
  assert.deepEqual(actual.roots.map((root) => root.id), ["main", "legacy"]);
  assert.deepEqual(actual.models.map((model) => model.rootId), expected.models.map((model) => model.rootId));
  const text = JSON.stringify(actual);
  for (const hubOnly of ["volume", "pendingBytes", "reserveBytes", "projectedFreeBytes", "hidden", "entryId", "residues", "orphanPartials", "duplicates"]) assert.equal(text.includes(`"${hubOnly}"`), false, hubOnly);
});

test("the legacy fit maps the hub labels (wont-fit becomes exceeds, spills stays tight)", () => {
  const cases = [["fits", "fits"], ["tight", "tight"], ["spills", "tight"], ["wont-fit", "exceeds"], ["unknown", "unknown"], [undefined, "unknown"]];
  for (const [label, status] of cases) {
    assert.equal(compat.toLegacyFit({ label, neededMb: 8000, headroomMb: 8000, overflowMb: 4000 }).status, status, String(label));
  }
  assert.deepEqual(compat.toLegacyFit({ label: "fits", neededMb: 6000, headroomMb: 18000 }), { status: "fits", ratio: 0.25, note: "约占显存 25%，可以整模型放进 GPU。", spill: false, source: "hub" });
  assert.deepEqual(compat.toLegacyFit(null), { status: "unknown", ratio: null, note: "未读取到显存信息。" });
});

test("download failures keep the legacy error fields", () => {
  const envelope = (code, message, details) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
  const noMatch = compat.toLegacyDownloadError(422, envelope("filter_no_match", "x", { suggestions: [{ label: "Q4_K_M", bytes: 4 * 1024 ** 3 }, { label: "BF16", bytes: 0 }] }), { precision: "Q9", totalFiles: 7 });
  assert.equal(noMatch.status, 422);
  assert.equal(noMatch.body.code, "filter_no_match");
  assert.deepEqual(noMatch.body.details, { precision: "Q9", totalFiles: 7 });
  assert.match(noMatch.body.error, /Q4_K_M 4\.0 GB, BF16\)$/);
  assert.equal(/\p{Script=Han}/u.test(noMatch.body.error.split(" / ")[1]), false, "the English half has no Han text");
  const duplicate = compat.toLegacyDownloadError(409, envelope("already_downloading", "busy", { existingJobId: "dl_a" }));
  assert.deepEqual([duplicate.status, duplicate.body.existingJobId, duplicate.body.code], [409, "dl_a", "already_downloading"]);
  const race = compat.toLegacyDownloadError(422, envelope("plan_blocked", "blocked", { blocking: [{ code: "hf_approval_required", message: "m" }] }), { repo: "o/n", access: { status: "approval_required", authorizationUrl: "https://huggingface.co/o/n" } });
  assert.deepEqual([race.status, race.body.code, race.body.accessStatus, race.body.authorizationUrl], [409, "hf_approval_required", "approval_required", "https://huggingface.co/o/n"]);
  const disk = compat.planBlockingToLegacy({ blocking: [{ code: "disk_full", message: "full" }] }, "o/n");
  assert.deepEqual([disk.status, disk.body.code], [400, "download_disk_full"]);
  assert.equal(compat.planBlockingToLegacy({ blocking: [] }, "o/n"), null);
  const official = compat.planBlockingToLegacy({ blocking: [{ code: "gated_official_required", message: "Use the official endpoint." }], access: { status: "official_required" } }, "o/n");
  assert.deepEqual([official.status, official.body.error, official.body.accessStatus], [409, "Use the official endpoint.", "official_required"]);
});

test("the hub probe maps to the legacy official/mirror/modelscope fields", () => {
  const probe = compat.toLegacyProbe({
    ok: true, repo: "o/n", file: "config.json", recommended: "hf-mirror", at: "T",
    sources: [
      { source: "huggingface", ok: true, ms: 9, bytesPerSec: 1 },
      { source: "hf-mirror", ok: true, ms: 2, bytesPerSec: 9 },
      { source: "modelscope", ok: true, ms: 5, bytesPerSec: 3, repo: "ms/n" },
    ],
  });
  assert.equal(probe.recommended, "mirror");
  assert.equal(probe.recommendedLabel, "hf-mirror.com");
  assert.equal(probe.official.source, "official");
  assert.equal(probe.modelscope.ok, true);
  assert.equal(probe.modelScopeRepo, "ms/n");
  assert.deepEqual(probe.sources.map((row) => row.source), ["official", "mirror", "modelscope"]);
  assert.equal(compat.toLegacyProbe({ ok: true, sources: [], recommended: "huggingface" }).recommended, "official");
});

test("upstream status, cleanup and access answers keep the legacy fields", () => {
  const entry = { path: "X:/lib/m", provenance: { provider: "huggingface", repo: "o/n", revisionSha: "a".repeat(40), downloadedAt: "T", source: "hub-job" } };
  const current = compat.toLegacyUpstreamStatus({ name: "m", entry, update: { status: "current", remoteSha: "a".repeat(40) } });
  assert.deepEqual([current.ok, current.updateAvailable, current.localSha, current.remoteSha], [true, false, "a".repeat(40), "a".repeat(40)]);
  const unknownDate = compat.toLegacyUpstreamStatus({ name: "m", entry, update: { status: "unknown" } });
  assert.equal(unknownDate.updateAvailable, null);
  assert.equal(compat.toLegacyUpstreamStatus({ name: "m", entry: { path: "X:/m", provenance: {} }, update: { status: "unsupported" } }).reason, "unknown_source");
  assert.deepEqual(compat.toLegacyCleanup("X:/lib/m", { removed: ["a"], removedBytes: 5 }), { ok: true, path: "X:/lib/m", removed: ["a"], removedBytes: 5 });
  assert.equal(compat.toLegacyAccess({ model: "o/n", access: { granted: true, status: "granted" }, detail: { access: { gated: false } } }).status, "public");
  assert.deepEqual(compat.toLegacyAccess({ model: "o/n", access: { granted: false, status: "login_required" }, detail: null }), { model: "o/n", gated: true, granted: false, status: "login_required", username: null, authorizationUrl: "https://huggingface.co/o/n" });
  assert.deepEqual(compat.toLegacyAuthStatus({ ok: true, connected: false, username: null, orgs: [], source: null, reason: "invalid_token" }), { connected: false, username: null, orgs: [], source: null, reason: "invalid_token" });
});

test("settings round-trip through the legacy seven keys", () => {
  const settings = hubSettings.defaultSettings();
  const legacy = hubSettings.toLegacy(settings);
  const patch = hubSettings.fromLegacy({ ...legacy, hfMirror: true, queueMode: false }, { current: settings });
  assert.equal(patch.sources.policy, "hf-mirror");
  assert.equal(patch.transfer.maxConcurrent, 3);
  assert.deepEqual(hubSettings.toLegacy(Object.assign(settings, { sources: { ...settings.sources, policy: "hf-mirror" } })).hfMirror, true);
});
