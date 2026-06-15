const fsp = require("node:fs/promises");
const {
  markDownloadCancelled,
  markDownloadPaused,
  markJobCancelRequested,
  markJobFailed,
  prepareDownloadResume,
} = require("./job-utils");

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

  function hasRunningDownload() {
    return Array.from(jobs.values()).some((job) => job.type === "download" && job.status === "running");
  }

  function isDownloadFinished(status) {
    return ["success", "cancelled"].includes(String(status || ""));
  }

  function enqueueOrStartDownload(command, args, jobOptions = {}) {
    healDownloadQueue();
    const shouldQueue = Boolean(getQueueMode()) && hasRunningDownload();
    const job = options.createJob("download", jobOptions.title || "download", jobOptions.meta || {});
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
    const queueMode = Boolean(body.queueMode);
    setQueueMode(queueMode);
    await saveQueueMode(queueMode);
    if (!queueMode) startQueuedDownloadsNow();
    return { queueMode };
  }

  function drainDownloadQueue() {
    healDownloadQueue({ skipDrain: true });
    if (hasRunningDownload()) return;
    const next = Array.from(jobs.values())
      .filter((job) => job.type === "download" && job.status === "queued" && downloadSpecs.has(job.id))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
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
    return { queueMode: Boolean(getQueueMode()) };
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
    drainDownloadQueue,
    healDownloadQueue,
    startQueuedDownloadsNow,
  };
}

module.exports = {
  createDownloadJobController,
};
