const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const manager = require("../server");
const core = require("../../manager-core");

// Obviously fake values; nothing here talks to Hugging Face.
const FAKE_TOKEN = "hf_FAKEdownloadTOKENforTESTS000000";
const FAKE_ENV_TOKEN = "hf_FAKEenvironmentTOKEN0000000000";

async function makeHarness(t, overrides = {}) {
  const base = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), "p0-rt-download-")));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const legacyRoot = path.join(base, "library-a");
  const otherRoot = path.join(base, "library-b");
  const hfCache = path.join(base, "hf-home");
  fs.mkdirSync(legacyRoot, { recursive: true });
  const realStorage = core.createModelStorage({ modelsRoot: legacyRoot, file: path.join(base, "state", "model-storage.json") });
  const other = realStorage.registerRoot({ path: otherRoot, create: true, label: "Library B" });
  const prepared = [];
  const storage = {
    ...realStorage,
    prepareDownload: (target, metadata) => {
      prepared.push([target, metadata]);
      return realStorage.prepareDownload(target, metadata);
    },
  };
  const calls = { estimate: [], access: [], enqueue: [], ensure: [], modelInfo: [], statfs: [] };
  const tokenChanges = [];
  const downloadTokens = manager.createDownloadTokenStore({ onChange: () => tokenChanges.push("change") });
  const jobs = new Map();
  const commandBuilder = core.createDownloadCommandBuilder({ hfCli: "hf", modelScopeCli: "modelscope", hfCache, modelsRoot: legacyRoot });
  const settings = { hfMirror: false, hfTransfer: false, ...(overrides.settings || {}) };
  const handlers = manager.createDownloadRequestHandlers({
    modelsRoot: legacyRoot,
    hfCache,
    modelStorage: storage,
    remoteModelService: {
      getHuggingFaceDownloadEstimate: async (...args) => {
        calls.estimate.push(args);
        if (overrides.estimate instanceof Error) throw overrides.estimate;
        return overrides.estimate || { bytes: 4096, fileCount: 2, filtered: false, matchedFiles: 2, totalFiles: 2, fileManifest: [] };
      },
      getHuggingFaceModelInfo: async (repo) => {
        calls.modelInfo.push(repo);
        return { url: `https://huggingface.co/${repo}`, lastModified: "2026-01-02T00:00:00.000Z" };
      },
    },
    hfAuthService: {
      checkRepoAccess: async (...args) => {
        calls.access.push(args);
        return overrides.access || { granted: true, status: "granted" };
      },
    },
    downloadTokens,
    getJobs: () => jobs.values(),
    getDownloadSettings: () => settings,
    enqueueOrStartDownload: (command, args, options) => {
      calls.enqueue.push({ command, args, options });
      if (overrides.enqueueError) throw overrides.enqueueError;
      const job = { id: `dl-${calls.enqueue.length}`, type: "download", status: "running", meta: options.meta, logs: [] };
      jobs.set(job.id, job);
      return job;
    },
    buildDownloadCommand: commandBuilder.buildDownloadCommand,
    getDiskFreeBytes: async () => null,
    cleanupIncompleteFiles: (target) => core.createModelFilesystemStore({ storage, modelsRoot: legacyRoot, hfCache }).cleanupIncompleteFiles(target),
    appendLog: (job, line) => job.logs.push(line),
    redact: core.createSecretRedactor({ getSecrets: () => [FAKE_ENV_TOKEN, ...downloadTokens.values()] }).redact,
    ensureDirectories: async (...dirs) => calls.ensure.push(dirs),
    statfs: async (target) => {
      calls.statfs.push(target);
      return { bavail: 1000, bsize: 4096 };
    },
    env: { PATH: "fake-path", HF_TOKEN: FAKE_ENV_TOKEN },
  });
  return { base, legacyRoot, otherRoot, other, hfCache, storage, realStorage, handlers, calls, prepared, jobs, downloadTokens, tokenChanges, settings };
}

function treeContains(dir, needle) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (treeContains(full, needle)) return true;
    } else if (fs.readFileSync(full, "utf8").includes(needle)) {
      return true;
    }
  }
  return false;
}

test("an estimate failure no longer blocks the download and leaves a redacted log line", async (t) => {
  const h = await makeHarness(t, {
    estimate: new Error(`getaddrinfo ENOTFOUND huggingface.co (Authorization: Bearer ${FAKE_ENV_TOKEN})`),
    settings: { hfMirror: true },
  });
  const { job } = await h.handlers.startDownload({ model: "org/gated-or-not" });
  assert.equal(h.calls.enqueue.length, 1);
  // The gated check needs the estimate, so it is skipped rather than blocking.
  assert.equal(h.calls.access.length, 0);
  assert.equal(job.meta.expectedFiles, null);
  assert.equal(job.meta.expectedBytes, null);
  const line = job.logs.find((item) => item.startsWith("Download size estimate unavailable: "));
  assert.ok(line, job.logs.join("\n"));
  assert.match(line, /ENOTFOUND/);
  assert.ok(!line.includes(FAKE_ENV_TOKEN));
  // A mirror download still goes through the mirror, without any token.
  const env = h.calls.enqueue[0].options.env;
  assert.equal(env.HF_ENDPOINT, "https://hf-mirror.com");
  assert.equal(env.HF_TOKEN, undefined);
  assert.equal(env.HF_HUB_DISABLE_IMPLICIT_TOKEN, "1");
  assert.deepEqual(job.meta.transfer, { hfMirror: true, hfEndpoint: "https://hf-mirror.com", hfTransfer: false, tokenRef: null, gated: false });
});

test("a gated repository whose estimate fails is still enqueued", async (t) => {
  const h = await makeHarness(t, { estimate: new Error("HTTP 503 from huggingface.co") });
  const { job } = await h.handlers.startDownload({ model: "org/gated-model", hfToken: FAKE_TOKEN });
  assert.equal(h.calls.enqueue.length, 1);
  assert.equal(h.calls.access.length, 0);
  assert.equal(job.status, "running");
  assert.match(job.meta.transfer.tokenRef, /^dlt_[0-9a-f]{32}$/);
});

test("a gated repository with a known estimate still checks access before anything is prepared", async (t) => {
  const h = await makeHarness(t, {
    estimate: { bytes: 4096, fileCount: 2, filtered: false, matchedFiles: 2, totalFiles: 2, gated: true, probeFile: "config.json" },
    access: { granted: false, status: "approval_required" },
  });
  await assert.rejects(
    () => h.handlers.startDownload({ model: "org/gated", hfToken: FAKE_TOKEN }),
    (error) => error.status === 409 && error.code === "hf_approval_required",
  );
  assert.equal(h.calls.access.length, 1);
  assert.equal(h.calls.access[0][1].token, FAKE_TOKEN);
  assert.equal(h.prepared.length, 0);
  assert.equal(h.downloadTokens.size, 0);
});

test("a zero-match filter returns 422 filter_no_match and prepares no directory", async (t) => {
  const h = await makeHarness(t, {
    estimate: { bytes: null, fileCount: 0, filtered: true, matchedFiles: 0, totalFiles: 37, includePatterns: ["*Q4_K_M*.gguf"] },
  });
  await assert.rejects(
    () => h.handlers.startDownload({ model: "org/safetensors-only", precision: "q4_k_m" }),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, "filter_no_match");
      assert.deepEqual(error.details, { precision: "Q4_K_M", totalFiles: 37 });
      assert.match(error.message, /所选精度没有匹配的文件.* \/ No files match the selected precision/);
      return true;
    },
  );
  assert.equal(h.prepared.length, 0);
  assert.equal(h.calls.enqueue.length, 0);
  assert.equal(h.calls.ensure.length, 0);
  assert.deepEqual(fs.readdirSync(h.legacyRoot), []);
});

test("the download route answers 422 with code and details", async (t) => {
  const h = await makeHarness(t, { estimate: { fileCount: 0, filtered: true, matchedFiles: 0, totalFiles: 5 } });
  const app = express();
  app.use(express.json());
  core.registerModelRoutes(app, {
    listModels: async () => ({ local: [], cached: [] }),
    searchRemoteModels: async () => ({ results: [] }),
    startDownload: (body) => h.handlers.startDownload(body),
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/download`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "org/repo", precision: "fp8" }),
  });
  assert.equal(response.status, 422);
  const payload = await response.json();
  assert.equal(payload.code, "filter_no_match");
  assert.deepEqual(payload.details, { precision: "FP8", totalFiles: 5 });
  assert.equal(h.prepared.length, 0);
});

test("download tokens live only in the in-memory map and are referenced by tokenRef", async (t) => {
  const h = await makeHarness(t, { settings: { hfMirror: true } });
  const secretList = core.createCachedSecretList({ sources: [() => h.downloadTokens.values()] });
  const { job } = await h.handlers.startDownload({ model: "org/private", hfToken: FAKE_TOKEN });
  const { options } = h.calls.enqueue[0];
  const ref = job.meta.transfer.tokenRef;
  assert.match(ref, /^dlt_[0-9a-f]{32}$/);
  // A token always uses the official endpoint, so the mirror never sees it.
  assert.equal(options.env.HF_TOKEN, FAKE_TOKEN);
  assert.equal(options.env.HF_ENDPOINT, undefined);
  assert.equal(job.meta.transfer.hfMirror, false);
  assert.equal(h.downloadTokens.resolve(ref), FAKE_TOKEN);
  assert.ok(!JSON.stringify(job.meta).includes(FAKE_TOKEN));
  assert.ok(job.logs.some((line) => /official endpoint/.test(line)));
  // Nothing under the storage roots, the storage state or the HF home holds it.
  assert.equal(treeContains(h.base, FAKE_TOKEN), false);
  assert.ok(secretList.getSecrets().includes(FAKE_TOKEN));
  assert.deepEqual(h.tokenChanges, ["change"]);

  // A resume resolves the token through the ref; after release it is gone.
  const spec = core.createDownloadCommandBuilder({ hfCli: "hf", hfCache: h.hfCache, modelsRoot: h.legacyRoot, env: {} })
    .buildDownloadSpecFromJob({ meta: job.meta }, { resolveSecret: (value) => h.downloadTokens.resolve(value) });
  assert.equal(spec.options.env.HF_TOKEN, FAKE_TOKEN);
  h.downloadTokens.release(ref);
  assert.equal(h.downloadTokens.resolve(ref), null);
  assert.deepEqual(h.tokenChanges, ["change", "change"]);
  assert.throws(
    () => core.createDownloadCommandBuilder({ hfCli: "hf", hfCache: h.hfCache, modelsRoot: h.legacyRoot, env: {} })
      .buildDownloadSpecFromJob({ meta: job.meta }, { resolveSecret: (value) => h.downloadTokens.resolve(value) }),
    (error) => error.code === "hf_token_expired",
  );
});

test("a token is released when the download cannot be enqueued", async (t) => {
  const conflict = Object.assign(new Error("duplicate"), { status: 409 });
  const h = await makeHarness(t, { enqueueError: conflict });
  await assert.rejects(() => h.handlers.startDownload({ model: "org/private", hfToken: FAKE_TOKEN }), (error) => error === conflict);
  assert.equal(h.downloadTokens.size, 0);
});

test("cleanup-incomplete accepts a path inside any root and rejects path_outside_roots", async (t) => {
  const h = await makeHarness(t);
  const target = path.join(h.otherRoot, "org__repo");
  fs.mkdirSync(path.join(target, "sub"), { recursive: true });
  fs.writeFileSync(path.join(target, "sub", "weights.safetensors.abc.incomplete"), "partial");
  fs.writeFileSync(path.join(target, "config.json"), "{}");
  const result = await h.handlers.cleanupIncomplete({ path: target });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, ["sub/weights.safetensors.abc.incomplete"]);
  assert.ok(fs.existsSync(path.join(target, "config.json")));

  for (const bad of [
    path.join(h.otherRoot, "..", "escaped"),
    h.otherRoot,
    h.legacyRoot,
    path.join(h.base, "elsewhere"),
    "relative/dir",
  ]) {
    await assert.rejects(
      () => h.handlers.cleanupIncomplete({ path: bad }),
      (error) => error.status === 400 && error.code === "path_outside_roots",
      bad,
    );
  }
  // The legacy name form still works under the legacy root.
  fs.mkdirSync(path.join(h.legacyRoot, "legacy-model"), { recursive: true });
  assert.equal((await h.handlers.cleanupIncomplete({ name: "legacy-model" })).ok, true);
});

test("cleanup-incomplete still refuses a directory a download may resume", async (t) => {
  const h = await makeHarness(t);
  const target = path.join(h.otherRoot, "busy");
  fs.mkdirSync(target, { recursive: true });
  h.jobs.set("busy-job", { id: "busy-job", type: "download", status: "paused", meta: { localDir: target } });
  await assert.rejects(() => h.handlers.cleanupIncomplete({ path: target }), (error) => error.status === 409);
});

test("upstream-status accepts path and falls back to the download marker", async (t) => {
  const h = await makeHarness(t);
  const target = path.join(h.otherRoot, "org__marker-repo");
  h.realStorage.prepareDownload(target, { model: "org/marker-repo", source: "huggingface", precision: "" });
  const marker = JSON.parse(fs.readFileSync(path.join(target, ".platform-download.json"), "utf8"));
  const result = await h.handlers.checkModelUpstream({ path: target });
  assert.equal(result.ok, true);
  assert.equal(result.repo, "org/marker-repo");
  assert.equal(result.recordSource, "marker");
  assert.equal(result.downloadedAt, marker.createdAt);
  assert.equal(result.name, "org__marker-repo");
  assert.equal(result.path, target);
  assert.deepEqual(h.calls.modelInfo, ["org/marker-repo"]);

  // A ledger entry wins over the marker.
  h.jobs.set("old", { id: "old", type: "download", status: "success", createdAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-03T00:00:00.000Z", meta: { localDir: target, model: "org/ledger-repo", source: "huggingface" } });
  const fromJob = await h.handlers.checkModelUpstream({ path: target });
  assert.equal(fromJob.repo, "org/ledger-repo");
  assert.equal(fromJob.recordSource, "job");
  assert.equal(fromJob.updateAvailable, false);

  const modelscope = path.join(h.otherRoot, "ms-repo");
  h.realStorage.prepareDownload(modelscope, { model: "org/ms-repo", source: "modelscope", precision: "" });
  assert.equal((await h.handlers.checkModelUpstream({ path: modelscope })).reason, "unsupported_source");
  await assert.rejects(
    () => h.handlers.checkModelUpstream({ path: path.join(h.otherRoot, "..") }),
    (error) => error.code === "path_outside_roots",
  );
});

test("the resume check measures the disk of the job's own directory", async (t) => {
  const h = await makeHarness(t);
  const localDir = path.join(h.otherRoot, "resume-me");
  fs.mkdirSync(localDir, { recursive: true });
  const result = await h.handlers.inspectDownloadResume({ meta: { localDir, fileManifest: [], expectedBytes: 1024 } });
  assert.equal(h.calls.statfs.length, 1);
  assert.ok(core.containsPath(h.otherRoot, h.calls.statfs[0]), h.calls.statfs[0]);
  assert.equal(result.diskFreeBytes, 1000 * 4096);
});

test("disk usage is wired with every configured root, default first", async (t) => {
  const h = await makeHarness(t);
  h.realStorage.setDefault(h.other.id);
  const roots = await manager.listModelStorageRoots(h.realStorage);
  assert.deepEqual(roots.map((root) => [root.id, root.default, root.legacy]), [["legacy", false, true], [h.other.id, true, false]]);
  fs.mkdirSync(path.join(h.otherRoot, "org__one"), { recursive: true });
  const usage = await core.createModelFilesystemStore({
    storage: h.realStorage,
    modelsRoot: h.legacyRoot,
    hfCache: h.hfCache,
    listRoots: () => manager.listModelStorageRoots(h.realStorage),
  }).getDiskUsage();
  assert.deepEqual(usage.roots.map((root) => root.id), [h.other.id, "legacy"]);
  assert.equal(usage.models.find((model) => model.name === "org__one").rootId, h.other.id);
});
