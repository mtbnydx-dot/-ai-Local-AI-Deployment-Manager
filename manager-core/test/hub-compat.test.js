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
