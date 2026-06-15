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
  const saveDelayMs = Number(options.saveDelayMs || 600);
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  let writeQueue = Promise.resolve();
  let saveTimer = null;

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
    scheduleJobsSave();
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
    applyJobProgress(job, progress);
    scheduleJobsSave();
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
