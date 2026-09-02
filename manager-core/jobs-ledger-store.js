const {
  appendJobLog,
  applyJobProgress,
  createJobRecord,
  markInterruptedJob,
  markJobFailed,
  markJobSuccess,
  normalizePersistedJob,
  serializeJobs,
} = require("./job-utils");

function createJobsLedgerStore(options = {}) {
  const jobs = options.jobs || new Map();
  const file = options.file;
  const readJsonFile = options.readJsonFile;
  const writeJsonFile = options.writeJsonFile;
  const maxLogLines = Number(options.maxLogLines || 500);
  const maxPersistedJobs = Number(options.maxPersistedJobs || 100);
  const saveDelayMs = Number(options.saveDelayMs || 1500);
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  // 任意任务状态变化的通知钩子（例如 SSE 推送）；与磁盘保存的节流互相独立。
  const onJobsChanged = typeof options.onJobsChanged === "function" ? options.onJobsChanged : () => {};
  let writeQueue = Promise.resolve();
  let saveTimer = null;

  function notifyJobsChanged() {
    try {
      onJobsChanged();
    } catch {
      // 推送失败不能影响任务处理路径。
    }
  }

  async function loadJobsLedgerIntoMemory() {
    try {
      const parsed = await readJsonFile(file, { jobs: [] });
      const loaded = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      for (const item of loaded.slice(-maxPersistedJobs)) {
        const job = normalizePersistedJob(item, { maxLogLines });
        if (!job?.id) continue;
        markInterruptedJob(job, { maxLogLines });
        jobs.set(job.id, job);
      }
      await saveJobsLedgerNow();
    } catch (error) {
      onError(`Unable to load jobs ledger: ${error.message}`, error);
    }
  }

  function scheduleJobsSave(delayMs = saveDelayMs) {
    notifyJobsChanged();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveJobsLedgerNow().catch((error) => onError(`Unable to save jobs ledger: ${error.message}`, error));
    }, delayMs);
    saveTimer.unref?.();
  }

  async function saveJobsLedgerNow() {
    const previous = writeQueue;
    let release;
    writeQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      await writeJsonFile(file, {
        version: 1,
        updatedAt: new Date().toISOString(),
        jobs: serializeJobs(jobs.values(), { maxPersistedJobs, maxLogLines }),
      });
    } finally {
      release();
    }
  }

  function createJob(type, title, meta = {}) {
    const job = createJobRecord(type, title, meta);
    jobs.set(job.id, job);
    scheduleJobsSave(0);
    return job;
  }

  function appendLog(job, data) {
    appendJobLog(job, data, { maxLogLines });
    notifyJobsChanged();
    const now = Date.now();
    const last = Number(job._lastLogSaveAt || 0);
    if (now - last >= 10_000) {
      job._lastLogSaveAt = now;
      scheduleJobsSave();
    }
  }

  function finishJob(job, meta = {}) {
    if (!markJobSuccess(job, {
      meta,
      serveDetail: options.serveDetail,
      serveStage: options.serveStage,
    })) return;
    options.stopProgressTracker?.(job);
    options.onJobSuccess?.(job, meta);
    scheduleJobsSave(0);
  }

  function failJob(job, error) {
    if (!markJobFailed(job, error)) return;
    options.stopProgressTracker?.(job);
    if (error?.stdout) appendLog(job, error.stdout);
    if (error?.stderr) appendLog(job, error.stderr);
    appendLog(job, `Error: ${job.error}`);
    scheduleJobsSave(0);
  }

  function setJobProgress(job, progress = {}) {
    const prevStage = job.progress?.stage;
    const prevPct = Number(job.progress?.percent || 0);
    applyJobProgress(job, progress);
    const nextStage = job.progress?.stage;
    const nextPct = Number(job.progress?.percent || 0);
    // 阶段切换时间线：启动结束后可以看出每个阶段各花了多久（拉镜像/加载权重/就绪检查…）。
    if (nextStage && nextStage !== prevStage) {
      const history = Array.isArray(job.meta?.stageHistory) ? job.meta.stageHistory : [];
      history.push({ stage: String(nextStage), at: new Date().toISOString() });
      job.meta = { ...(job.meta || {}), stageHistory: history.slice(-24) };
    }
    if (nextStage !== prevStage || Math.abs(nextPct - prevPct) >= 1) scheduleJobsSave();
    else notifyJobsChanged();
  }

  function clearJobsSaveTimer() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  }

  async function waitForJobsLedgerWrites() {
    await writeQueue.catch(() => {});
  }

  return {
    loadJobsLedgerIntoMemory,
    scheduleJobsSave,
    saveJobsLedgerNow,
    createJob,
    appendLog,
    finishJob,
    failJob,
    setJobProgress,
    clearJobsSaveTimer,
    waitForJobsLedgerWrites,
  };
}

module.exports = {
  createJobsLedgerStore,
};
