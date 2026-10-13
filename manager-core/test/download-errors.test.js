const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("..");
const {
  DOWNLOAD_ERROR_CODES,
  classifyDownloadFailure,
  describeDownloadError,
  isDownloadErrorCode,
} = require("../model-hub/errors");

// One or more lines per code, shaped like real hf CLI / huggingface_hub output
// and the managers' own messages. No tokens and no local paths.
const CORPUS = [
  { code: "stall", input: { meta: { stalled: true }, text: "下载进度长时间无增长，已终止下载进程。" } },
  { code: "verify_failed", input: { meta: { verifyFailed: true }, text: "Process exited with code 0" } },
  { code: "verify_failed", input: { text: "Download verification failed: 权重文件不完整: model-00002-of-00002.safetensors" } },
  { code: "checksum_mismatch", input: { text: "sha256 mismatch for model-00001-of-00002.safetensors" } },
  { code: "checksum_mismatch", input: { text: "SHA256 校验失败：1 个文件与 Hugging Face 清单不一致，已删除损坏文件；继续下载会只重新获取这些文件。" } },
  { code: "checksum_mismatch", input: { text: "OSError: Consistency check failed: file should be of size 4976698672 but has size 1048576 (model-00001-of-00004.safetensors)." } },
  { code: "cli_missing", input: { text: "'hf' is not recognized as an internal or external command,\noperable program or batch file." } },
  { code: "cli_missing", input: { text: "/bin/sh: 1: hf: command not found" } },
  { code: "cli_missing", input: { error: Object.assign(new Error("spawn hf ENOENT"), { code: "ENOENT", syscall: "spawn hf" }) } },
  { code: "cli_missing", input: { text: "hf CLI 未安装或无法执行（spawn hf ENOENT）。" } },
  { code: "disk_full", input: { text: "OSError: [Errno 28] No space left on device" } },
  { code: "disk_full", input: { text: "There is not enough space on the disk." } },
  {
    code: "hf_approval_required",
    input: {
      text: [
        "huggingface_hub.errors.GatedRepoError: 403 Client Error. (Request ID: Root=1-0000)",
        "Cannot access gated repo for url https://huggingface.co/org/model/resolve/main/config.json.",
        "Access to model org/model is restricted and you are not in the authorized list. Visit https://huggingface.co/org/model to ask for access.",
      ].join("\n"),
    },
  },
  { code: "hf_approval_required", input: { text: "Your request to access model org/model is awaiting a review from the repo authors." } },
  {
    code: "hf_auth_invalid",
    input: {
      text: [
        "huggingface_hub.errors.HfHubHTTPError: 401 Client Error: Unauthorized for url: https://huggingface.co/api/whoami-v2 (Request ID: Root=1-0000)",
        "Invalid credentials in Authorization header",
      ].join("\n"),
    },
  },
  { code: "hf_auth_invalid", input: { text: "ValueError: Invalid user token." } },
  { code: "hf_token_expired", input: { error: Object.assign(new Error("下载 Token 已失效 / Download token expired"), { code: "hf_token_expired" }) } },
  {
    code: "repo_not_found",
    input: {
      text: [
        "huggingface_hub.errors.RepositoryNotFoundError: 404 Client Error. (Request ID: Root=1-0000)",
        "Repository Not Found for url: https://huggingface.co/api/models/org/missing/revision/main.",
        "Please make sure you specified the correct `repo_id` and `repo_type`.",
        "If you are trying to access a private or gated repo, make sure you are authenticated.",
      ].join("\n"),
    },
  },
  {
    code: "revision_not_found",
    input: {
      text: [
        "huggingface_hub.errors.RevisionNotFoundError: 404 Client Error. (Request ID: Root=1-0000)",
        "Revision Not Found for url: https://huggingface.co/api/models/org/model/revision/v9.",
        "Invalid rev id: v9",
      ].join("\n"),
    },
  },
  { code: "filter_no_match", input: { meta: { errorCode: "filter_no_match" } } },
  { code: "rate_limited", input: { text: "huggingface_hub.errors.HfHubHTTPError: 429 Client Error: Too Many Requests for url: https://huggingface.co/api/models/org/model/revision/main" } },
  { code: "rate_limited", input: { text: "HTTP status client error (429 Too Many Requests) for url (reconstruction request)" } },
  {
    code: "network_unreachable",
    input: {
      text: "requests.exceptions.ConnectionError: HTTPSConnectionPool(host='huggingface.co', port=443): Max retries exceeded with url: /api/models/org/model/revision/main (Caused by NameResolutionError(\"Failed to resolve 'huggingface.co' ([Errno 11001] getaddrinfo failed)\"))",
    },
  },
  { code: "network_unreachable", input: { text: "httpx.ConnectTimeout: timed out" } },
  { code: "network_unreachable", input: { text: "requests.exceptions.ReadTimeout: HTTPSConnectionPool(host='hf-mirror.com', port=443): Read timed out. (read timeout=10)" } },
  { code: "unknown", input: { text: "Process exited with code 1" } },
  { code: "unknown", input: {} },
];

const NON_RETRYABLE = [
  "cli_missing",
  "disk_full",
  "hf_approval_required",
  "hf_auth_invalid",
  "hf_token_expired",
  "repo_not_found",
  "revision_not_found",
  "filter_no_match",
];

test("download error codes are the fourteen table codes in table order", () => {
  assert.deepEqual(DOWNLOAD_ERROR_CODES, [
    "stall",
    "verify_failed",
    "checksum_mismatch",
    "cli_missing",
    "disk_full",
    "hf_approval_required",
    "hf_auth_invalid",
    "hf_token_expired",
    "repo_not_found",
    "revision_not_found",
    "filter_no_match",
    "rate_limited",
    "network_unreachable",
    "unknown",
  ]);
  assert.equal(Object.isFrozen(DOWNLOAD_ERROR_CODES), true);
  assert.equal(isDownloadErrorCode("hf_token_expired"), true);
  assert.equal(isDownloadErrorCode("unknown_error"), false);
  for (const code of ["classifyTransferFailure", "stall_no_progress", "hf_token_invalid", "unknown_error"]) {
    assert.equal(DOWNLOAD_ERROR_CODES.includes(code), false, `${code} is not part of the vocabulary`);
  }
});

test("each corpus line classifies to its code with a bilingual title and hint", () => {
  const seen = new Set();
  for (const { code, input } of CORPUS) {
    const result = classifyDownloadFailure(input);
    assert.equal(result.code, code, `expected ${code} for ${JSON.stringify(input).slice(0, 120)}`);
    assert.equal(result.baseCode, result.code);
    assert.equal(result.retryable, !NON_RETRYABLE.includes(code));
    assert.ok(result.title.zh && result.title.en, `${code} has a bilingual title`);
    assert.ok(result.hint.zh && result.hint.en, `${code} has a bilingual hint`);
    assert.equal(result.retryDelayFactor, code === "rate_limited" ? 4 : 1);
    seen.add(code);
  }
  assert.deepEqual([...seen].sort(), [...DOWNLOAD_ERROR_CODES].sort(), "every code has a corpus line");
});

test("classification precedence follows the table, with the specific hub exception winning", () => {
  const forbiddenWithConnection = [
    "huggingface_hub.errors.GatedRepoError: 403 Client Error. (Request ID: Root=1-0000)",
    "Cannot access gated repo for url https://huggingface.co/org/model/resolve/main/config.json.",
    "requests.exceptions.ConnectionError: (ProtocolError('Connection aborted.', ConnectionResetError(10054)))",
  ].join("\n");
  assert.equal(classifyDownloadFailure({ text: forbiddenWithConnection }).code, "hf_approval_required");
  assert.equal(classifyDownloadFailure({ text: "403 Client Error: Forbidden for url\nMax retries exceeded with url" }).code, "hf_approval_required");

  // Anonymous requests to a missing repo come back as 401; the exception class decides.
  const anonymousMissing = [
    "huggingface_hub.errors.RepositoryNotFoundError: 401 Client Error. (Request ID: Root=1-0000)",
    "Repository Not Found for url: https://huggingface.co/api/models/org/missing/revision/main.",
    "Invalid username or password.",
  ].join("\n");
  assert.equal(classifyDownloadFailure({ text: anonymousMissing }).code, "repo_not_found");
  assert.equal(classifyDownloadFailure({ text: "No space left on device\n429 Client Error: Too Many Requests" }).code, "disk_full");
  assert.equal(classifyDownloadFailure({ meta: { stalled: true }, text: "ConnectionError" }).code, "stall");

  // Sizes in the managers' own lines are not rate limits; a file ENOENT is not a missing CLI.
  assert.equal(classifyDownloadFailure({ text: "Estimated download size: 429 MB across 4290 files." }).code, "unknown");
  assert.equal(classifyDownloadFailure({ error: Object.assign(new Error("ENOENT: no such file or directory, open 'x.json'"), { code: "ENOENT", syscall: "open" }) }).code, "unknown");
  assert.equal(classifyDownloadFailure({ text: "sk-learn hf_hub_download ok" }).code, "unknown");
});

test("describeDownloadError returns table entries and falls back to unknown", () => {
  const rate = describeDownloadError("rate_limited");
  assert.equal(rate.retryDelayFactor, 4);
  assert.equal(rate.minRetryDelaySeconds, 120);
  assert.equal(describeDownloadError("not-a-code").code, "unknown");
  const first = describeDownloadError("disk_full");
  first.hint.zh = "mutated";
  assert.notEqual(describeDownloadError("disk_full").hint.zh, "mutated", "results are fresh copies");
});

function buildController(overrides = {}) {
  const jobs = new Map();
  const spawned = [];
  const retryTimers = [];
  const createJob = (type, title, meta = {}) => {
    const job = core.createJobRecord(type, title, meta, { id: `job-${jobs.size + 1}` });
    jobs.set(job.id, job);
    return job;
  };
  const controller = core.createDownloadJobController({
    jobs,
    downloadSpecs: new Map(),
    createJob,
    processStartedAt: Date.now() - 60_000,
    autoRetryCount: 2,
    autoRetryDelaySeconds: 10,
    spawnJobProcess: (job) => {
      job.status = "running";
      spawned.push(job.id);
    },
    buildDownloadSpecFromJob: (job) => ({
      command: "hf",
      args: ["download", job.meta.model],
      options: { meta: { ...job.meta }, title: job.title },
    }),
    appendLog: (job, data) => core.appendJobLog(job, data),
    stopProgressTracker: () => {},
    setRetryTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      retryTimers.push(timer);
      return timer;
    },
    clearRetryTimeout: () => {},
    ...overrides,
  });
  return { jobs, spawned, retryTimers, createJob, controller };
}

function failedDownload(createJob, { lines = [], error = "Process exited with code 1", meta = {} } = {}) {
  const job = createJob("download", "Download org/model", { model: "org/model", localDir: `partial-${Math.random()}`, ...meta });
  job.logs = ["> hf download org/model --local-dir partial", ...lines, `Error: ${error}`];
  job.status = "failed";
  job.error = error;
  job.exitCode = 1;
  job.meta.failedAt = Date.now();
  return job;
}

function corpusLines(code) {
  const entry = CORPUS.find((item) => item.code === code && item.input.text);
  return entry ? entry.input.text.split("\n") : [];
}

test("the controller never auto-retries non-retryable codes and logs one bilingual line", () => {
  for (const code of NON_RETRYABLE) {
    const { retryTimers, createJob, controller } = buildController();
    const meta = code === "filter_no_match" ? { errorCode: "filter_no_match" } : {};
    const job = failedDownload(createJob, { lines: corpusLines(code), meta });
    if (code === "hf_token_expired") {
      job.meta.errorCode = "hf_token_expired";
    }
    controller.drainDownloadQueue();
    controller.drainDownloadQueue();
    assert.equal(retryTimers.length, 0, `${code} must not schedule a retry`);
    assert.equal(job.meta.errorCode, code);
    assert.equal(job.meta.errorRetryable, false);
    assert.ok(job.meta.errorHint.zh && job.meta.errorHint.en);
    const info = describeDownloadError(code);
    assert.equal(job.error, `${info.title.zh} / ${info.title.en}`, "job.error becomes the bilingual title");
    const skipLines = job.logs.filter((line) => line.includes("此错误不会自动重试") && line.includes("Not retried automatically"));
    assert.equal(skipLines.length, 1, `${code} logs the skip line once`);
    assert.ok(job.logs.some((line) => line.includes("Process exited with code 1") && line.includes(code)), "raw error stays in the log");
  }
});

test("retryable failures keep retrying; rate limits wait at least 120 seconds", () => {
  const { retryTimers, createJob, controller } = buildController();
  const network = failedDownload(createJob, { lines: corpusLines("network_unreachable") });
  const limited = failedDownload(createJob, { lines: corpusLines("rate_limited") });
  const unknown = failedDownload(createJob);
  controller.drainDownloadQueue();
  assert.equal(network.meta.errorCode, "network_unreachable");
  assert.equal(limited.meta.errorCode, "rate_limited");
  assert.equal(unknown.meta.errorCode, "unknown");
  assert.equal(retryTimers.length, 3);
  const delays = Object.fromEntries(retryTimers.map((timer, index) => [[network.id, limited.id, unknown.id][index], timer.ms]));
  assert.equal(delays[network.id], 10_000);
  assert.ok(delays[limited.id] >= 120_000, "rate limit waits at least 120 s");
  assert.equal(delays[unknown.id], 10_000, "unknown keeps today's retry behaviour");
  assert.ok(limited.logs.some((line) => /将在 120 秒后自动续传/.test(line)));
});

test("rate limit delay multiplies a long configured delay", () => {
  const { retryTimers, createJob, controller } = buildController({ autoRetryDelaySeconds: 60 });
  failedDownload(createJob, { lines: corpusLines("rate_limited") });
  controller.drainDownloadQueue();
  assert.equal(retryTimers[0].ms, 240_000);
});

test("classification happens once per failure and is cleared on resume", () => {
  const { spawned, retryTimers, createJob, controller } = buildController();
  const job = failedDownload(createJob, { lines: corpusLines("repo_not_found") });
  controller.drainDownloadQueue();
  controller.drainDownloadQueue();
  assert.equal(job.logs.filter((line) => line.startsWith("原始错误 / Original error")).length, 1);
  assert.equal(job.meta.errorCode, "repo_not_found");

  // Manual resume is always allowed, even for a non-retryable code.
  controller.resumeDownloadJob(job);
  assert.equal(job.status, "running");
  assert.deepEqual(spawned, [job.id]);
  for (const key of ["errorCode", "errorRetryable", "errorHint"]) assert.equal(job.meta[key], undefined, `${key} cleared on resume`);

  // The next failure is judged on its own attempt's output only.
  job.logs.push("> hf download org/model --local-dir partial", ...corpusLines("network_unreachable"));
  job.status = "failed";
  job.error = "Process exited with code 1";
  job.meta.failedAt = Date.now();
  controller.drainDownloadQueue();
  assert.equal(job.meta.errorCode, "network_unreachable");
  assert.equal(retryTimers.length, 1);
});

test("a stalled download classifies as stall and is retried", async () => {
  const { retryTimers, controller } = buildController();
  const job = controller.enqueueOrStartDownload("hf", ["download", "org/model"], {
    title: "Download org/model",
    meta: { model: "org/model", localDir: "partial-stall" },
  });
  core.markJobCancelRequested(job, "stall");
  controller.handleDownloadStallAfterStop(job);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.meta.errorCode, "stall");
  assert.equal(job.meta.errorRetryable, true);
  assert.equal(retryTimers.length, 1);
  retryTimers[0].fn();
  assert.equal(job.status, "running");
  assert.equal(job.meta.stalled, undefined, "the stall flag does not outlive the attempt");
});

test("a resume that cannot be prepared fails with its own classified code and is not retried", () => {
  const { retryTimers, createJob, controller } = buildController({
    buildDownloadSpecFromJob: () => {
      throw Object.assign(new Error("下载所需的 Token 已失效 / The token for this download is gone"), { code: "hf_token_expired" });
    },
  });
  const job = createJob("download", "Download org/gated", { model: "org/gated", localDir: "partial-gated", stalled: true });
  job.status = "interrupted";
  job.logs = ["> hf download org/gated", ...corpusLines("hf_approval_required")];
  assert.throws(() => controller.resumeDownloadJob(job), (error) => error.code === "hf_token_expired");
  assert.equal(job.status, "failed");
  assert.equal(job.meta.errorCode, "hf_token_expired", "an earlier attempt's 403 or stall does not decide this failure");
  assert.equal(job.meta.errorRetryable, false);
  controller.drainDownloadQueue();
  assert.equal(retryTimers.length, 0);
});

test("a spawn failure on resume is classified from the error object", () => {
  const { createJob, controller } = buildController({
    spawnJobProcess: () => {
      throw Object.assign(new Error("spawn hf ENOENT"), { code: "ENOENT", syscall: "spawn hf" });
    },
  });
  const job = failedDownload(createJob);
  controller.drainDownloadQueue();
  controller.resumeDownloadJob(job);
  assert.equal(job.status, "failed");
  assert.equal(job.meta.errorCode, "cli_missing");
  assert.equal(job.meta.errorRetryable, false);
});
