const fsp = require("node:fs/promises");
const {
  markDownloadCancelled,
  markDownloadPaused,
  markJobCancelRequested,
  markJobFailed,
  prepareDownloadResume,
} = require("./job-utils");

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
    cancelStarting: "正在取消下载，完成后会删除本地部分文件。",
    cancelled: "下载已取消。",
    partialDeleted: "已删除部分下载目录",
    resumeQueued: "继续下载已加入队列。",
    resumeStarting: "继续下载，尝试复用本地已有文件。",
    queueDisabledStart: "下载队列已关闭，立即开始本任务。",
    queueNextStart: "前一个下载已结束，开始本任务。",
    queueExpiredError: "下载队列状态已过期，请重新提交下载任务。",
    queueExpiredLog: "下载队列状态已过期：管理器重启或队列参数丢失，请重新提交下载任务。",
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
  const failJob = typeof options.failJob === "function"
    ? options.failJob
    : (job, error) => markJobFailed(job, error);
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

  function applyDownloadSettings(input = {}) {
    if (input.queueMode !== undefined) setQueueMode(Boolean(input.queueMode));
    if (input.autoRetryCount !== undefined) autoRetryCount = clampInteger(input.autoRetryCount, 0, 10, autoRetryCount);
    if (input.autoRetryDelaySeconds !== undefined) autoRetryDelaySeconds = clampInteger(input.autoRetryDelaySeconds, 1, 3600, autoRetryDelaySeconds);
    return getDownloadSettings();
  }

  function hasRunningDownload() {
    return Array.from(jobs.values()).some((job) => job.type === "download" && job.status === "running");
  }

  function isDownloadFinished(status) {
    return ["success", "cancelled"].includes(String(status || ""));
  }

  function enqueueOrStartDownload(command, args, jobOptions = {}) {
    healDownloadQueue();
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
      options.spawnJobProcess(job, command, args, jobOptions);
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
      await finalizeDownloadCancel(job, { deletePartial: true });
      return job;
    }
    if (job.status === "running") {
      if (typeof job.cancel !== "function") throw new Error("当前下载任务无法取消。");
      options.appendLog(job, messages.cancelStarting);
      job.cancel("cancel");
      return job;
    }
    if (job.type !== "download" || isDownloadFinished(job.status)) throw new Error("该下载任务已结束。");
    await finalizeDownloadCancel(job, { deletePartial: true });
    return job;
  }

  async function finalizeDownloadCancel(job, finalizeOptions = {}) {
    options.stopProgressTracker(job);
    markDownloadCancelled(job);
    options.appendLog(job, messages.cancelled);
    if (finalizeOptions.deletePartial !== false) await deletePartialDownload(job);
    scheduleSave(0);
  }

  async function deletePartialDownload(job) {
    const localDir = job.meta?.localDir;
    if (!localDir) return;
    const resolved = resolvePartialPath(localDir);
    await removePartialPath(resolved);
    options.appendLog(job, `${messages.partialDeleted}: ${resolved}`);
  }

  function resumeDownloadJob(job) {
    if (job.status === "running" || job.status === "queued") return job;
    if (job.status === "success") throw new Error("该下载任务已完成，不需要继续。");
    clearAutoRetry(job);
    const spec = options.buildDownloadSpecFromJob(job);
    prepareDownloadResume(job, spec.options.meta || {});
    if (Boolean(getQueueMode()) && hasRunningDownload()) {
      job.status = "queued";
      job.updatedAt = new Date().toISOString();
      downloadSpecs.set(job.id, spec);
      options.appendLog(job, messages.resumeQueued);
      scheduleSave(0);
    } else {
      options.appendLog(job, messages.resumeStarting);
      options.spawnJobProcess(job, spec.command, spec.args, spec.options);
    }
    return job;
  }

  function startQueuedDownloadsNow() {
    for (const job of Array.from(jobs.values())) {
      if (job.type !== "download" || job.status !== "queued" || !downloadSpecs.has(job.id)) continue;
      const spec = downloadSpecs.get(job.id);
      downloadSpecs.delete(job.id);
      options.appendLog(job, messages.queueDisabledStart);
      options.spawnJobProcess(job, spec.command, spec.args, spec.options);
    }
  }

  async function saveDownloadSettings(body = {}) {
    const previousQueueMode = Boolean(getQueueMode());
    const settings = applyDownloadSettings({
      queueMode: body.queueMode !== undefined ? Boolean(body.queueMode) : previousQueueMode,
      autoRetryCount: body.autoRetryCount !== undefined ? body.autoRetryCount : autoRetryCount,
      autoRetryDelaySeconds: body.autoRetryDelaySeconds !== undefined ? body.autoRetryDelaySeconds : autoRetryDelaySeconds,
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
    const spec = downloadSpecs.get(next.id);
    downloadSpecs.delete(next.id);
    options.appendLog(next, messages.queueNextStart);
    options.spawnJobProcess(next, spec.command, spec.args, spec.options);
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
      const retries = clampInteger(job.meta?.retryCount, 0, 10, 0);
      const maxRetries = clampInteger(job.meta?.maxRetries, 0, 10, autoRetryCount);
      if (retries >= maxRetries || retryTimers.has(job.id)) continue;
      const delaySeconds = autoRetryDelaySeconds;
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
    resumeDownloadJob,
    saveDownloadSettings,
    getDownloadSettings,
    applyDownloadSettings,
    drainDownloadQueue,
    healDownloadQueue,
    startQueuedDownloadsNow,
  };
}

module.exports = {
  createDownloadJobController,
  normalizeDownloadPriority,
  downloadPriorityScore,
};
