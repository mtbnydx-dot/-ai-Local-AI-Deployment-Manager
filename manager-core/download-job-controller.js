const path = require("node:path");
const fsp = require("node:fs/promises");
const {
  markDownloadCancelled,
  markDownloadPaused,
  markJobCancelRequested,
  markJobFailed,
  prepareDownloadResume,
} = require("./job-utils");
const {
  classifyDownloadFailure,
  describeDownloadError,
  formatDownloadErrorTitle,
  isDownloadErrorCode,
} = require("./model-hub/errors");

// Fields one classification writes onto job.meta; cleared again when the job
// is resumed so the next failure is classified on its own evidence.
const FAILURE_CLASSIFICATION_KEYS = ["errorCode", "errorRetryable", "errorHint", "stalled", "verifyFailed"];
const FAILURE_LOG_TAIL_LINES = 60;

// The failing attempt's output starts after the runner's "> command" echo;
// older attempts' lines (an earlier checksum or 403 line) must not decide
// this failure.
function collectDownloadFailureText(job) {
  const logs = Array.isArray(job?.logs) ? job.logs.map((line) => String(line || "")) : [];
  let start = 0;
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    if (logs[index].startsWith("> ")) {
      start = index + 1;
      break;
    }
  }
  const tail = logs.slice(start).slice(-FAILURE_LOG_TAIL_LINES);
  if (job?.error) tail.push(String(job.error));
  return tail.join("\n");
}

function clearDownloadFailureClassification(job) {
  if (!job?.meta) return;
  for (const key of FAILURE_CLASSIFICATION_KEYS) delete job.meta[key];
}

function normalizeLocalDirKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return path.resolve(text).toLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

function findActiveDownloadJobByLocalDir(jobs, localDir, options = {}) {
  const key = normalizeLocalDirKey(localDir);
  if (!key || !jobs || typeof jobs.values !== "function") return null;
  const excludeJobId = String(options.excludeJobId || "");
  return Array.from(jobs.values()).find((job) => (
    job?.type === "download"
    && ["running", "queued"].includes(job.status)
    && job.id !== excludeJobId
    && normalizeLocalDirKey(job.meta?.localDir) === key
  )) || null;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function normalizeDownloadPriority(value) {
  const text = String(value || "normal").toLowerCase();
  return ["high", "normal", "low"].includes(text) ? text : "normal";
}

function downloadPriorityScore(value) {
  return { high: 2, normal: 1, low: 0 }[normalizeDownloadPriority(value)];
}

function createDownloadJobController(options = {}) {
  const jobs = options.jobs;
  const downloadSpecs = options.downloadSpecs || new Map();
  const messages = {
    queued: "下载队列已开启，已有下载在进行，本任务排队等待。",
    queuedCancel: "任务已被用户取消",
    pauseStarting: "正在暂停下载，已下载的部分会保留用于继续。",
    paused: "下载已暂停；点击继续会从本地已有文件续传。",
    cancelStarting: "正在取消下载，已下载的文件和续传数据会保留。",
    cancelled: "下载已取消，已有文件完整保留。",
    partialDeleted: "已删除部分下载目录",
    resumeQueued: "继续下载已加入队列。",
    resumeStarting: "继续下载，尝试复用本地已有文件。",
    stallFailed: "下载进度长时间无增长，已终止下载进程。",
    stallPreserved: "已下载的文件全部保留；将按自动重试策略从本地续传。",
    queueDisabledStart: "下载队列已关闭，立即开始本任务。",
    queueNextStart: "前一个下载已结束，开始本任务。",
    queueExpiredError: "下载队列状态已过期，请重新提交下载任务。",
    queueExpiredLog: "下载队列状态已过期：管理器重启或队列参数丢失，请重新提交下载任务。",
    originalError: (code, text) => `原始错误 / Original error [${code}]: ${text}`,
    notRetried: (title) => `此错误不会自动重试：${title.zh} / Not retried automatically: ${title.en}`,
    ...options.messages,
  };

  if (!jobs || typeof jobs.values !== "function") throw new Error("createDownloadJobController requires jobs.");
  for (const [name, fn] of Object.entries({
    createJob: options.createJob,
    spawnJobProcess: options.spawnJobProcess,
    buildDownloadSpecFromJob: options.buildDownloadSpecFromJob,
    appendLog: options.appendLog,
    stopProgressTracker: options.stopProgressTracker,
  })) {
    if (typeof fn !== "function") throw new Error(`createDownloadJobController requires ${name}.`);
  }

  const scheduleSave = typeof options.scheduleSave === "function" ? options.scheduleSave : () => {};
  const processStartedAt = Number(options.processStartedAt || Date.now());
  const delegatedFailJob = typeof options.failJob === "function"
    ? options.failJob
    : (job, error) => markJobFailed(job, error);
  const failJob = (job, error) => {
    if (job?.meta && job.meta.failedAt == null) job.meta.failedAt = Date.now();
    return delegatedFailJob(job, error);
  };
  const getQueueMode = typeof options.getQueueMode === "function" ? options.getQueueMode : () => false;
  const setQueueMode = typeof options.setQueueMode === "function" ? options.setQueueMode : () => {};
  const saveQueueMode = typeof options.saveQueueMode === "function" ? options.saveQueueMode : async () => {};
  const resolvePartialPath = typeof options.resolvePartialPath === "function"
    ? options.resolvePartialPath
    : (value) => value;
  const removePartialPath = typeof options.removePartialPath === "function"
    ? options.removePartialPath
    : (target) => fsp.rm(target, { recursive: true, force: true });
  const setRetryTimeout = typeof options.setRetryTimeout === "function" ? options.setRetryTimeout : setTimeout;
  const clearRetryTimeout = typeof options.clearRetryTimeout === "function" ? options.clearRetryTimeout : clearTimeout;
  const retryTimers = new Map();
  let autoRetryCount = clampInteger(options.autoRetryCount, 0, 10, 2);
  let autoRetryDelaySeconds = clampInteger(options.autoRetryDelaySeconds, 1, 3600, 10);
  let hfMirror = Boolean(options.hfMirror);
  let hfTransfer = Boolean(options.hfTransfer);
  let verifyChecksums = options.verifyChecksums !== false;
  let idleOnlyQueue = Boolean(options.idleOnlyQueue);

  function applyDownloadSettings(input = {}) {
    if (input.queueMode !== undefined) setQueueMode(Boolean(input.queueMode));
    if (input.autoRetryCount !== undefined) autoRetryCount = clampInteger(input.autoRetryCount, 0, 10, autoRetryCount);
    if (input.autoRetryDelaySeconds !== undefined) autoRetryDelaySeconds = clampInteger(input.autoRetryDelaySeconds, 1, 3600, autoRetryDelaySeconds);
    if (input.hfMirror !== undefined) hfMirror = Boolean(input.hfMirror);
    if (input.hfTransfer !== undefined) hfTransfer = Boolean(input.hfTransfer);
    if (input.verifyChecksums !== undefined) verifyChecksums = Boolean(input.verifyChecksums);
    if (input.idleOnlyQueue !== undefined) idleOnlyQueue = Boolean(input.idleOnlyQueue);
    return getDownloadSettings();
  }

  function hasRunningDownload() {
    return Array.from(jobs.values()).some((job) => job.type === "download" && job.status === "running");
  }

  function isDownloadFinished(status) {
    return ["success", "cancelled"].includes(String(status || ""));
  }

  function spawnDownload(job, command, args, opts) {
    try { return options.spawnJobProcess(job, command, args, opts); }
    catch (error) {
      failJob(job, error);
      options.appendLog(job, error.message);
      // A resumed job is still "failed" here, so mark it from the error itself.
      if (job.status === "failed") classifyFailedDownload(job, { error, text: error?.message || "" });
      scheduleSave(0);
      return job;
    }
  }

  // Classifies a failed download once: the first time the controller sees the
  // failure (or immediately, with `force`, for an error raised while preparing
  // a resume). job.error becomes the bilingual title; the original text goes
  // to the job log, which the ledger store redacts.
  function classifyFailedDownload(job, classifyOptions = {}) {
    if (!job || job.type !== "download") return null;
    if (!classifyOptions.force && typeof job.meta?.errorRetryable === "boolean") return null;
    if (classifyOptions.force) clearDownloadFailureClassification(job);
    const original = String(job.error || "").trim();
    const result = classifyDownloadFailure({
      text: classifyOptions.text !== undefined
        ? [classifyOptions.text, original].filter(Boolean).join("\n")
        : collectDownloadFailureText(job),
      exitCode: Number.isInteger(job.exitCode) ? job.exitCode : null,
      error: classifyOptions.error || null,
      meta: job.meta || {},
    });
    job.meta = {
      ...(job.meta || {}),
      errorCode: result.code,
      errorRetryable: result.retryable,
      errorHint: { ...result.hint },
    };
    job.error = formatDownloadErrorTitle(result);
    const originalText = original || String(classifyOptions.error?.message || "").trim();
    if (originalText && originalText !== job.error) options.appendLog(job, messages.originalError(result.code, originalText));
    if (!result.retryable) options.appendLog(job, messages.notRetried(result.title));
    scheduleSave(0);
    return result;
  }

  // A resume that cannot even be prepared (for example the download token is
  // gone after a restart) ends as a classified failure instead of leaving the
  // job paused or interrupted with no reason.
  function failDownloadResume(job, error) {
    if (job.status !== "failed") {
      const now = new Date().toISOString();
      job.status = "failed";
      job.pid = null;
      job.finishedAt = now;
      job.updatedAt = now;
      options.stopProgressTracker(job);
    }
    job.meta = { ...(job.meta || {}), cancelRequested: false, cancelAction: null, failedAt: Date.now() };
    job.error = null;
    classifyFailedDownload(job, { error, text: error?.message || "", force: true });
  }

  function computeRetryDelaySeconds(job) {
    const info = describeDownloadError(job.meta?.errorCode);
    return Math.max(info.minRetryDelaySeconds, autoRetryDelaySeconds * info.retryDelayFactor);
  }

  function enqueueOrStartDownload(command, args, jobOptions = {}) {
    healDownloadQueue();
    const busyJob = findActiveDownloadJobByLocalDir(jobs, jobOptions.meta?.localDir);
    if (busyJob) {
      const error = new Error(`该模型已有下载任务 ${busyJob.id} 正在进行，请勿重复提交。`);
      error.status = 409;
      error.existingJobId = busyJob.id;
      throw error;
    }
    const shouldQueue = Boolean(getQueueMode()) && hasRunningDownload();
    const meta = {
      ...(jobOptions.meta || {}),
      priority: normalizeDownloadPriority(jobOptions.meta?.priority || jobOptions.priority),
      retryCount: clampInteger(jobOptions.meta?.retryCount, 0, 10, 0),
      maxRetries: clampInteger(jobOptions.meta?.maxRetries, 0, 10, autoRetryCount),
    };
    const job = options.createJob("download", jobOptions.title || "download", meta);
    if (shouldQueue) {
      job.status = "queued";
      downloadSpecs.set(job.id, { command, args, options: jobOptions });
      options.appendLog(job, messages.queued);
      job.cancel = () => {
        downloadSpecs.delete(job.id);
        markJobCancelRequested(job, "cancel");
        failJob(job, new Error(messages.queuedCancel));
      };
      scheduleSave(0);
    } else {
      spawnDownload(job, command, args, jobOptions);
    }
    healDownloadQueue();
    return job;
  }

  function pauseDownloadJob(job) {
    if (job.status === "paused") return job;
    if (job.status === "queued") {
      downloadSpecs.delete(job.id);
      pauseDownloadJobAfterStop(job);
      return job;
    }
    if (job.status !== "running") throw new Error("只有运行中或排队中的下载可以暂停。");
    if (typeof job.cancel !== "function") throw new Error("当前下载任务无法暂停。");
    options.appendLog(job, messages.pauseStarting);
    job.cancel("pause");
    return job;
  }

  function pauseDownloadJobAfterStop(job) {
    if (job.status !== "running" && job.status !== "queued") return;
    options.stopProgressTracker(job);
    markDownloadPaused(job);
    options.appendLog(job, messages.paused);
    scheduleSave(0);
  }

  async function cancelDownloadJob(job) {
    clearAutoRetry(job);
    if (job.status === "queued") {
      downloadSpecs.delete(job.id);
      await finalizeDownloadCancel(job, { deletePartial: false });
      return job;
    }
    if (job.status === "running") {
      if (typeof job.cancel !== "function") throw new Error("当前下载任务无法取消。");
      options.appendLog(job, messages.cancelStarting);
      job.cancel("cancel");
      return job;
    }
    if (job.type !== "download" || isDownloadFinished(job.status)) throw new Error("该下载任务已结束。");
    await finalizeDownloadCancel(job, { deletePartial: false });
    return job;
  }

  async function finalizeDownloadCancel(job, finalizeOptions = {}) {
    options.stopProgressTracker(job);
    markDownloadCancelled(job);
    options.appendLog(job, messages.cancelled);
    if (finalizeOptions.deletePartial === true) await deletePartialDownload(job);
    scheduleSave(0);
  }

  async function deletePartialDownload(job) {
    const localDir = job.meta?.localDir;
    if (!localDir) return;
    const other = findActiveDownloadJobByLocalDir(jobs, localDir, { excludeJobId: job.id });
    if (other) {
      options.appendLog(job, `部分下载目录仍被任务 ${other.id} 使用，已跳过删除。`);
      return;
    }
    const resolved = resolvePartialPath(localDir);
    await removePartialPath(resolved);
    options.appendLog(job, `${messages.partialDeleted}: ${resolved}`);
  }

  // Stalls are transient by definition (network hiccups, HF throttling, Xet
  // staging, resume-time revalidation). Never delete the partial download for
  // one; convert it into an ordinary failure so the auto-retry scheduler can
  // resume from the bytes already on disk.
  function handleDownloadStallAfterStop(job) {
    if (!job || job.type !== "download") return job;
    options.stopProgressTracker(job);
    job.meta = {
      ...(job.meta || {}),
      cancelRequested: false,
      cancelAction: null,
      failedAt: Date.now(),
      stalled: true,
    };
    failJob(job, new Error(messages.stallFailed));
    options.appendLog(job, messages.stallPreserved);
    scheduleSave(0);
    setImmediate(drainDownloadQueue);
    return job;
  }

  function resumeDownloadJob(job) {
    if (job.status === "running" || job.status === "queued") return job;
    if (job.status === "success") throw new Error("该下载任务已完成，不需要继续。");
    clearAutoRetry(job);
    let spec;
    try {
      spec = options.buildDownloadSpecFromJob(job);
    } catch (error) {
      if (isDownloadErrorCode(error?.code)) failDownloadResume(job, error);
      throw error;
    }
    prepareDownloadResume(job, spec.options.meta || {});
    clearDownloadFailureClassification(job);
    if (Boolean(getQueueMode()) && hasRunningDownload()) {
      job.status = "queued";
      job.updatedAt = new Date().toISOString();
      downloadSpecs.set(job.id, spec);
      options.appendLog(job, messages.resumeQueued);
      scheduleSave(0);
    } else {
      options.appendLog(job, messages.resumeStarting);
      spawnDownload(job, spec.command, spec.args, spec.options);
    }
    return job;
  }

  function startQueuedDownloadsNow() {
    for (const job of Array.from(jobs.values())) {
      if (job.type !== "download" || job.status !== "queued" || !downloadSpecs.has(job.id)) continue;
      const spec = downloadSpecs.get(job.id);
      downloadSpecs.delete(job.id);
      options.appendLog(job, messages.queueDisabledStart);
      spawnDownload(job, spec.command, spec.args, spec.options);
    }
  }

  async function saveDownloadSettings(body = {}) {
    const previousQueueMode = Boolean(getQueueMode());
    const settings = applyDownloadSettings({
      queueMode: body.queueMode !== undefined ? Boolean(body.queueMode) : previousQueueMode,
      autoRetryCount: body.autoRetryCount !== undefined ? body.autoRetryCount : autoRetryCount,
      autoRetryDelaySeconds: body.autoRetryDelaySeconds !== undefined ? body.autoRetryDelaySeconds : autoRetryDelaySeconds,
      hfMirror: body.hfMirror !== undefined ? body.hfMirror : hfMirror,
      hfTransfer: body.hfTransfer !== undefined ? body.hfTransfer : hfTransfer,
      verifyChecksums: body.verifyChecksums !== undefined ? body.verifyChecksums : verifyChecksums,
      idleOnlyQueue: body.idleOnlyQueue !== undefined ? body.idleOnlyQueue : idleOnlyQueue,
    });
    await saveQueueMode(settings);
    if (previousQueueMode && !settings.queueMode) startQueuedDownloadsNow();
    return settings;
  }

  function drainDownloadQueue() {
    healDownloadQueue({ skipDrain: true });
    scheduleFailedDownloadRetries();
    if (hasRunningDownload()) return;
    const next = Array.from(jobs.values())
      .filter((job) => job.type === "download" && job.status === "queued" && downloadSpecs.has(job.id))
      .sort((a, b) => downloadPriorityScore(b.meta?.priority) - downloadPriorityScore(a.meta?.priority)
        || String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (!next) return;
    // 「模型空闲时才下载」：推理正忙时不抢带宽/磁盘，稍后重查。
    if (idleOnlyQueue && typeof options.isRuntimeBusy === "function") {
      Promise.resolve(options.isRuntimeBusy()).then((busy) => {
        if (!busy) {
          startQueuedJob(next);
          return;
        }
        if (next.meta && !next.meta.idleWaitLogged) {
          next.meta.idleWaitLogged = true;
          options.appendLog(next, "模型服务正忙，队列等待空闲后自动开始（每 60 秒重查一次）。");
          scheduleSave(0);
        }
        const timer = setRetryTimeout(() => drainDownloadQueue(), 60_000);
        timer.unref?.();
      }).catch(() => startQueuedJob(next));
      return;
    }
    startQueuedJob(next);
  }

  function startQueuedJob(job) {
    if (!job || job.status !== "queued" || !downloadSpecs.has(job.id) || hasRunningDownload()) return;
    const spec = downloadSpecs.get(job.id);
    downloadSpecs.delete(job.id);
    if (job.meta) delete job.meta.idleWaitLogged;
    options.appendLog(job, messages.queueNextStart);
    spawnDownload(job, spec.command, spec.args, spec.options);
  }

  function healDownloadQueue(healOptions = {}) {
    let changed = false;
    for (const job of jobs.values()) {
      if (job.type !== "download" || job.status !== "queued" || downloadSpecs.has(job.id)) continue;
      failJob(job, new Error(messages.queueExpiredError));
      options.appendLog(job, messages.queueExpiredLog);
      changed = true;
    }
    if (changed) scheduleSave(0);
    if (!healOptions.skipDrain && !hasRunningDownload()) {
      const hasQueuedWithSpec = Array.from(jobs.values()).some((job) => (
        job.type === "download" && job.status === "queued" && downloadSpecs.has(job.id)
      ));
      if (hasQueuedWithSpec) setImmediate(drainDownloadQueue);
    }
  }

  function getDownloadSettings() {
    return {
      queueMode: Boolean(getQueueMode()),
      autoRetryCount,
      autoRetryDelaySeconds,
      hfMirror,
      hfTransfer,
      verifyChecksums,
      idleOnlyQueue,
    };
  }

  function clearAutoRetry(job) {
    const timer = retryTimers.get(job?.id);
    if (timer) clearRetryTimeout(timer);
    retryTimers.delete(job?.id);
    if (job?.meta) delete job.meta.retryScheduledAt;
  }

  function scheduleFailedDownloadRetries() {
    for (const job of jobs.values()) {
      if (job.type !== "download" || job.status !== "failed" || job.meta?.cancelRequested) continue;
      // Gated, missing, disk-full and similar failures cannot heal by
      // retrying; only manual resume restarts them.
      classifyFailedDownload(job);
      if (job.meta?.errorRetryable === false) continue;
      const retries = clampInteger(job.meta?.retryCount, 0, 10, 0);
      const maxRetries = clampInteger(job.meta?.maxRetries, 0, 10, autoRetryCount);
      const failedAt = Number(job.meta?.failedAt || 0);
      if (!failedAt || failedAt < processStartedAt) {
        if (!job.meta?.staleRetrySkipped) {
          job.meta = { ...(job.meta || {}), staleRetrySkipped: true };
          options.appendLog(job, "重启前的失败任务不再自动续传，可手动点击继续。");
        }
        continue;
      }
      if (retries >= maxRetries || retryTimers.has(job.id)) continue;
      const delaySeconds = computeRetryDelaySeconds(job);
      job.meta = {
        ...(job.meta || {}),
        retryCount: retries,
        maxRetries,
        retryScheduledAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      };
      options.appendLog(job, `下载失败，将在 ${delaySeconds} 秒后自动续传（${retries + 1}/${maxRetries}）。`);
      scheduleSave(0);
      const timer = setRetryTimeout(() => {
        retryTimers.delete(job.id);
        if (job.status !== "failed") return;
        delete job.meta.retryScheduledAt;
        job.meta.retryCount = retries + 1;
        options.appendLog(job, `开始第 ${job.meta.retryCount}/${maxRetries} 次自动续传。`);
        try {
          resumeDownloadJob(job);
        } catch (error) {
          failJob(job, error);
          options.appendLog(job, `自动续传准备失败：${error.message}`);
          scheduleSave(0);
          setImmediate(scheduleFailedDownloadRetries);
        }
      }, delaySeconds * 1000);
      timer.unref?.();
      retryTimers.set(job.id, timer);
    }
  }

  return {
    downloadSpecs,
    hasRunningDownload,
    isDownloadFinished,
    enqueueOrStartDownload,
    pauseDownloadJob,
    pauseDownloadJobAfterStop,
    cancelDownloadJob,
    finalizeDownloadCancel,
    deletePartialDownload,
    handleDownloadStallAfterStop,
    resumeDownloadJob,
    saveDownloadSettings,
    getDownloadSettings,
    applyDownloadSettings,
    drainDownloadQueue,
    healDownloadQueue,
    startQueuedDownloadsNow,
    classifyFailedDownload,
    findActiveDownloadJobByLocalDir: (localDir, findOptions) => findActiveDownloadJobByLocalDir(jobs, localDir, findOptions),
    processStartedAt,
  };
}

module.exports = {
  createDownloadJobController,
  findActiveDownloadJobByLocalDir,
  normalizeLocalDirKey,
  normalizeDownloadPriority,
  downloadPriorityScore,
};
