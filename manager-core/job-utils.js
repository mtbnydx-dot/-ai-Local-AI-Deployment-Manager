function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function normalizePersistedJob(value, options = {}) {
  const maxLogLines = Number(options.maxLogLines || 500);
  if (!value || typeof value !== "object") return null;
  return {
    id: String(value.id || ""),
    type: String(value.type || "job"),
    title: String(value.title || value.type || "job"),
    status: String(value.status || "unknown"),
    logs: Array.isArray(value.logs) ? value.logs.map(String).slice(-maxLogLines) : [],
    meta: value.meta && typeof value.meta === "object" ? value.meta : {},
    progress: value.progress && typeof value.progress === "object" ? value.progress : null,
    pid: value.pid || null,
    exitCode: value.exitCode ?? null,
    error: value.error || null,
    createdAt: value.createdAt || new Date().toISOString(),
    updatedAt: value.updatedAt || value.createdAt || new Date().toISOString(),
    finishedAt: value.finishedAt || null,
  };
}

function createJobRecord(type, title, meta = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const id = options.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    type: String(type || "job"),
    title: String(title || type || "job"),
    status: "running",
    logs: [],
    meta: meta && typeof meta === "object" ? meta : {},
    createdAt: now,
    updatedAt: now,
  };
}

function isActiveJob(job) {
  return ["running", "queued"].includes(String(job?.status || ""));
}

function markInterruptedJob(job, options = {}) {
  const maxLogLines = Number(options.maxLogLines || 500);
  const now = options.now || new Date().toISOString();
  if (!job || job.status !== "running") return job;
  job.status = "interrupted";
  job.error = options.error || "Manager restarted while this job was running.";
  job.finishedAt = job.finishedAt || now;
  job.updatedAt = now;
  job.logs = [...(job.logs || []), options.message || "Manager restarted; live process tracking was interrupted."].slice(-maxLogLines);
  return job;
}

function appendJobLog(job, data, options = {}) {
  if (!Array.isArray(job.logs)) job.logs = [];
  const maxLogLines = Number(options.maxLogLines || 500);
  const text = String(data || "").replace(/\r/g, "");
  let added = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    job.logs.push(line);
    added += 1;
  }
  if (job.logs.length > maxLogLines) job.logs.splice(0, job.logs.length - maxLogLines);
  job.updatedAt = options.now || new Date().toISOString();
  return added;
}

function applyJobProgress(job, progress = {}, options = {}) {
  if (!job || typeof job !== "object") return null;
  const updatedAt = options.now || new Date().toISOString();
  job.progress = {
    kind: job.type,
    percent: progress.percent ?? job.progress?.percent ?? null,
    stage: progress.stage || job.progress?.stage || "",
    detail: progress.detail || job.progress?.detail || "",
    state: progress.state || job.progress?.state || "running",
    issues: progress.issues || job.progress?.issues || [],
    updatedAt,
  };
  job.updatedAt = updatedAt;
  return job.progress;
}

function markProcessJobStarted(job, options = {}) {
  if (!job || typeof job !== "object") return null;
  const now = options.now || new Date().toISOString();
  job.status = "running";
  job.error = null;
  job.finishedAt = null;
  job.updatedAt = now;
  if (options.pid !== undefined) job.pid = options.pid;
  return job;
}

function markJobSuccess(job, options = {}) {
  if (!isActiveJob(job)) return false;
  const now = options.now || new Date().toISOString();
  job.status = "success";
  job.updatedAt = now;
  job.finishedAt = now;
  job.meta = { ...(job.meta || {}), ...(options.meta || {}) };
  if (job.type === "serve") {
    applyJobProgress(job, {
      percent: 100,
      stage: options.serveStage || "服务已就绪",
      detail: options.serveDetail || "API 已返回模型列表。",
      state: "ok",
    }, { now });
  } else if (job.progress) {
    const totalBytes = Number(job.progress.totalBytes || job.meta.expectedBytes || 0);
    job.progress = {
      ...job.progress,
      downloadedBytes: Math.max(Number(job.progress.downloadedBytes || 0), totalBytes || 0),
      percent: totalBytes ? 100 : null,
      speedBytesPerSec: 0,
      etaSeconds: null,
      updatedAt: now,
    };
  }
  return true;
}

function errorToMessage(error) {
  return error?.message || String(error || "Unknown error");
}

function markJobFailed(job, error, options = {}) {
  if (!isActiveJob(job)) return false;
  const now = options.now || new Date().toISOString();
  job.status = "failed";
  job.updatedAt = now;
  job.finishedAt = now;
  job.error = errorToMessage(error);
  if (job.type === "serve") {
    const existingIssues = Array.isArray(job.progress?.issues) ? job.progress.issues : [];
    applyJobProgress(job, {
      percent: job.progress?.percent || 100,
      stage: job.progress?.stage || options.serveFailedStage || "启动失败",
      detail: job.progress?.detail || job.error,
      state: "fail",
      issues: existingIssues.length ? existingIssues : extractLogIssues(job.error),
    }, { now });
  }
  return true;
}

function markJobCancelRequested(job, action = "cancel", options = {}) {
  if (!job || typeof job !== "object") return null;
  job.meta = { ...(job.meta || {}), cancelRequested: true, cancelAction: action };
  job.updatedAt = options.now || new Date().toISOString();
  return job;
}

function clearJobCancelRequest(job, options = {}) {
  if (!job || typeof job !== "object") return null;
  job.meta = {
    ...(job.meta || {}),
    cancelRequested: false,
    cancelAction: null,
  };
  job.updatedAt = options.now || new Date().toISOString();
  return job;
}

function freezeDownloadProgress(job, now) {
  if (!job.progress) return;
  job.progress = {
    ...job.progress,
    speedBytesPerSec: 0,
    etaSeconds: null,
    updatedAt: now,
  };
}

function markDownloadPaused(job, options = {}) {
  if (!isActiveJob(job)) return false;
  const now = options.now || new Date().toISOString();
  job.status = "paused";
  job.pid = null;
  job.updatedAt = now;
  job.finishedAt = null;
  job.error = null;
  clearJobCancelRequest(job, { now });
  freezeDownloadProgress(job, now);
  return true;
}

function markDownloadCancelled(job, options = {}) {
  if (!job || typeof job !== "object") return false;
  const now = options.now || new Date().toISOString();
  job.status = "cancelled";
  job.pid = null;
  job.updatedAt = now;
  job.finishedAt = now;
  job.error = null;
  clearJobCancelRequest(job, { now });
  freezeDownloadProgress(job, now);
  return true;
}

function prepareDownloadResume(job, meta = {}, options = {}) {
  if (!job || typeof job !== "object") return null;
  const now = options.now || new Date().toISOString();
  job.meta = {
    ...(job.meta || {}),
    ...(meta || {}),
    cancelRequested: false,
    cancelAction: null,
  };
  job.error = null;
  job.finishedAt = null;
  job.updatedAt = now;
  return job;
}

function serializeJobs(jobs, options = {}) {
  const maxPersistedJobs = Number(options.maxPersistedJobs || 100);
  const maxLogLines = Number(options.maxLogLines || 500);
  return Array.from(jobs || [])
    .map((job) => normalizePersistedJob(job, { maxLogLines }))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(-maxPersistedJobs);
}

function extractLogIssues(text, options = {}) {
  const limit = Number(options.limit || 8);
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /(^|\s)(error|exception|traceback|failed|fatal)\b|out of memory|no such|cannot|not found|runtimeerror|valueerror|typeerror|validationerror|invalid repository|configuration file|config\.json|params\.json|enginedeaderror|device-side assert|scattergatherkernel|uva is not available/i.test(line))
    .slice(-limit);
}

module.exports = {
  formatBytes,
  normalizePersistedJob,
  createJobRecord,
  isActiveJob,
  markInterruptedJob,
  appendJobLog,
  applyJobProgress,
  markProcessJobStarted,
  markJobSuccess,
  markJobFailed,
  markJobCancelRequested,
  clearJobCancelRequest,
  markDownloadPaused,
  markDownloadCancelled,
  prepareDownloadResume,
  serializeJobs,
  extractLogIssues,
};
