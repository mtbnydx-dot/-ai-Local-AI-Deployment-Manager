const {
  appendJobLog,
  applyJobProgress,
  createJobRecord,
  markInterruptedJob,
  markJobFailed,
  markJobSuccess,
  normalizeJobLogText,
  normalizePersistedJob,
  serializeJobs,
} = require("./job-utils");
const { REDACTED, redactSecrets, redactValue } = require("./secret-redactor");

// Accepts a text function (redactSecrets-style) or a bound redactor from
// createSecretRedactor. The default is the patterns-only redactor. A failing
// custom redactor falls back to the patterns, so logging never breaks.
function resolveJobRedactor(input) {
  let text = (item) => redactSecrets(item);
  let value = (item) => redactValue(item);
  if (input && typeof input === "object" && typeof input.redact === "function") {
    text = (item) => input.redact(item);
    value = typeof input.redactValue === "function"
      ? (item) => input.redactValue(item)
      : (item) => mapStrings(item, text);
  } else if (typeof input === "function") {
    text = input;
    value = (item) => mapStrings(item, input);
  }
  return {
    text(item) {
      if (typeof item !== "string" || !item) return item;
      try {
        return text(item);
      } catch {
        return redactSecrets(item);
      }
    },
    value(item) {
      try {
        return value(item);
      } catch {
        return redactValue(item);
      }
    },
  };
}

function mapStrings(value, redact) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((item) => {
      const next = mapStrings(item, redact);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? output : value;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  let changed = false;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = mapStrings(item, redact);
    if (output[key] !== item) changed = true;
  }
  return changed ? output : value;
}

function countMarkers(value) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return 0;
  }
  if (!text) return 0;
  return text.split(REDACTED).length - 1;
}

// At least one per changed string, so a custom marker still counts.
function countRedactions(before, after) {
  if (after === before) return 0;
  return Math.max(1, countMarkers(after) - countMarkers(before));
}

function createJobsLedgerStore(options = {}) {
  const jobs = options.jobs || new Map();
  const file = options.file;
  const readJsonFile = options.readJsonFile;
  const writeJsonFile = options.writeJsonFile;
  const maxLogLines = Number(options.maxLogLines || 500);
  const maxPersistedJobs = Number(options.maxPersistedJobs || 100);
  const saveDelayMs = Number(options.saveDelayMs || 1500);
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  // Informational lines with counts only, never content (redact-on-load).
  const onLog = typeof options.onLog === "function" ? options.onLog : (message) => console.log(message);
  // 任意任务状态变化的通知钩子（例如 SSE 推送）；与磁盘保存的节流互相独立。
  const onJobsChanged = typeof options.onJobsChanged === "function" ? options.onJobsChanged : () => {};
  // Every log line, failure text and persisted meta passes through this
  // redactor (docs/overhaul/08 P0-5). The servers pass a createSecretRedactor
  // that also knows the exact runtime keys and tokens.
  const redactor = resolveJobRedactor(options.redact);
  let writeQueue = Promise.resolve();
  let saveTimer = null;

  function notifyJobsChanged() {
    try {
      onJobsChanged();
    } catch {
      // 推送失败不能影响任务处理路径。
    }
  }

  // Redacts one persisted record before it is normalised and counts the
  // secret-like strings it replaced. Ledgers written before redaction existed
  // heal on their first load.
  function redactPersistedJob(item) {
    let count = 0;
    const record = { ...item };
    if (Array.isArray(item.logs)) {
      record.logs = item.logs.map((line) => {
        const base = normalizeJobLogText(line);
        const next = redactor.text(base);
        count += countRedactions(base, next);
        return next;
      });
    }
    if (typeof item.error === "string") {
      record.error = redactor.text(item.error);
      count += countRedactions(item.error, record.error);
    }
    for (const field of ["meta", "progress"]) {
      if (!item[field] || typeof item[field] !== "object") continue;
      record[field] = redactor.value(item[field]);
      count += countRedactions(item[field], record[field]);
    }
    return { record, count };
  }

  async function loadJobsLedgerIntoMemory() {
    try {
      const parsed = await readJsonFile(file, { jobs: [] });
      const loaded = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
      const kept = loaded.slice(-maxPersistedJobs);
      // The ledger is rewritten only when loading changed it: secrets were
      // redacted, running jobs were interrupted or old jobs were trimmed.
      let dirty = kept.length !== loaded.length;
      let redactedCount = 0;
      for (const item of kept) {
        if (!item || typeof item !== "object") continue;
        const { record, count } = redactPersistedJob(item);
        redactedCount += count;
        const job = normalizePersistedJob(record, { maxLogLines });
        if (!job?.id) continue;
        if (job.status === "running") dirty = true;
        markInterruptedJob(job, { maxLogLines });
        jobs.set(job.id, job);
      }
      if (redactedCount > 0) {
        dirty = true;
        try {
          onLog(`jobs-ledger: redacted ${redactedCount} secret-like strings on load`);
        } catch {
          // Logging must not stop the ledger from loading.
        }
      }
      if (dirty) await saveJobsLedgerNow();
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

  // Failure text, meta and progress are redacted again on every write, so a
  // path that sets job.error directly still never persists a secret. Log
  // lines were already redacted by appendLog or on load.
  function redactSerializedJob(job) {
    const error = redactor.text(job.error);
    const meta = redactor.value(job.meta);
    const progress = redactor.value(job.progress);
    if (error === job.error && meta === job.meta && progress === job.progress) return job;
    return { ...job, error, meta, progress };
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
        jobs: serializeJobs(jobs.values(), { maxPersistedJobs, maxLogLines }).map(redactSerializedJob),
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
    appendJobLog(job, redactor.text(String(data || "")), { maxLogLines });
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
    // The message is redacted before it becomes job.error, so the serve
    // progress detail and issues derived from it are clean as well. Docker
    // failures carry the whole "docker run" argv in this text.
    const message = error?.message || String(error || "Unknown error");
    if (!markJobFailed(job, redactor.text(message))) return;
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
