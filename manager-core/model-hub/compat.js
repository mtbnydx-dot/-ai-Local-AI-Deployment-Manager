"use strict";

// Pure legacy mappers for the manager shims (03 §15). The managers' legacy
// routes and their SSE `jobs` event keep their old shapes while the hub owns
// the downloads; these functions turn hub objects into those shapes. Nothing
// here does I/O, and nothing here reads or returns a credential: the hub's
// vault ref never leaves the hub (`meta.transfer.tokenRef` is always null).

const { isPlainObject, nonEmpty } = require("./hub-util");

// Hub state → the legacy job status (03 §7.1 table).
const LEGACY_STATUS = Object.freeze({
  queued: "queued",
  waiting: "queued",
  resolving: "running",
  downloading: "running",
  materializing: "running",
  verifying: "running",
  ready: "success",
  retrying: "queued",
  paused: "paused",
  interrupted: "interrupted",
  failed: "failed",
  cancelled: "cancelled",
});

// The legacy views keep their own log windows: 8 lines in a summary, 200 in
// a detail (manager-core/job-routes.js summarizeJob, the legacy ledger cap).
const SUMMARY_LOG_LINES = 8;
const DETAIL_LOG_LINES = 200;

// progress.stage for the legacy job renderer (03 §19 hub.state.* copy). It is
// bilingual like meta.errorHint, so the renderer's language pick applies.
const STAGE_COPY = Object.freeze({
  queued: { zh: "排队中", en: "Queued" },
  waiting: { zh: "等待中", en: "Waiting" },
  resolving: { zh: "正在解析文件清单", en: "Resolving files" },
  downloading: { zh: "下载中", en: "Downloading" },
  materializing: { zh: "正在组装文件（Xet）", en: "Assembling files (Xet)" },
  verifying: { zh: "正在校验", en: "Verifying" },
  ready: { zh: "已就绪，已加入模型库", en: "Ready, added to library" },
  retrying: { zh: "等待自动重试", en: "Waiting to retry" },
  paused: { zh: "已暂停", en: "Paused" },
  interrupted: { zh: "已中断，将自动继续", en: "Interrupted, will resume automatically" },
  failed: { zh: "失败", en: "Failed" },
  cancelled: { zh: "已取消", en: "Cancelled" },
});

const FINALIZED_FILE_STATES = new Set(["done", "verified"]);

function legacyStatusOf(state) {
  return LEGACY_STATUS[state] || "queued";
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stageOf(job) {
  const state = String(job.state || "");
  const copy = STAGE_COPY[state] || STAGE_COPY.queued;
  const stage = { id: state || "queued", zh: copy.zh, en: copy.en };
  if (state === "verifying") {
    const verify = isPlainObject(job.progress?.verify) ? job.progress.verify : {};
    const done = finiteOr(verify.filesDone, 0);
    const total = finiteOr(verify.filesTotal, 0);
    if (total > 0) {
      stage.zh = `正在校验（${done}/${total} 个文件）`;
      stage.en = `Verifying (${done}/${total} files)`;
    }
  }
  return stage;
}

// Per-file bytes as the legacy tracker reported them: whole files count as
// finalized, everything else (partial or pending) as incomplete.
function fileTotalsOf(progress) {
  const files = Array.isArray(progress?.files) ? progress.files : [];
  let finalizedBytes = 0;
  let partialBytes = 0;
  let incompleteFiles = 0;
  for (const file of files) {
    if (!isPlainObject(file)) continue;
    const bytes = Math.max(0, finiteOr(file.bytes, 0));
    if (FINALIZED_FILE_STATES.has(file.state)) {
      finalizedBytes += bytes;
    } else {
      partialBytes += bytes;
      incompleteFiles += 1;
    }
  }
  if (!files.length) {
    // No per-file sample yet (queued, migrated): the totals still add up.
    const total = Math.max(0, finiteOr(progress?.filesTotal, 0));
    const done = Math.max(0, finiteOr(progress?.filesDone, 0));
    incompleteFiles = Math.max(0, total - done);
  }
  return { finalizedBytes, partialBytes, incompleteFiles };
}

function errorTitleOf(error) {
  if (!isPlainObject(error)) return null;
  const title = isPlainObject(error.title) ? error.title : null;
  if (title && (nonEmpty(title.zh) || nonEmpty(title.en))) {
    return `${title.zh || title.en} / ${title.en || title.zh}`;
  }
  return nonEmpty(error.code) ? String(error.code) : null;
}

function bilingualOrNull(value) {
  return isPlainObject(value) && (nonEmpty(value.zh) || nonEmpty(value.en))
    ? { zh: String(value.zh || value.en), en: String(value.en || value.zh) }
    : null;
}

/**
 * toLegacyJob(job, { summary, logs }) → the legacy download job (03 §15).
 * `job` is the hub API shape (DownloadJob without logs); `logs` are lines the
 * caller fetched from /downloads/:id/logs, if any. `summary` gives the
 * /api/jobs?fields=summary window (8 lines), otherwise 200.
 */
function toLegacyJob(job, options = {}) {
  const source = isPlainObject(job) ? job : {};
  const artifact = isPlainObject(source.artifact) ? source.artifact : {};
  const target = isPlainObject(source.target) ? source.target : {};
  const transfer = isPlainObject(source.transfer) ? source.transfer : {};
  const transferOptions = isPlainObject(transfer.options) ? transfer.options : {};
  const progress = isPlainObject(source.progress) ? source.progress : {};
  const retry = isPlainObject(source.retry) ? source.retry : {};
  const error = isPlainObject(source.error) ? source.error : null;
  const repo = String(artifact.repo || "");
  const provider = String(artifact.provider || transferOptions.source || "huggingface");
  const transport = transferOptions.source || provider;
  const files = Array.isArray(artifact.files) ? artifact.files : [];
  const totalBytes = finiteOr(progress.bytesTotal, finiteOr(artifact.totalBytes, 0));
  const lines = Array.isArray(options.logs) ? options.logs.map(String) : Array.isArray(source.logs) ? source.logs.map(String) : [];
  const logCount = Number.isInteger(options.logCount) && options.logCount >= lines.length ? options.logCount : lines.length;
  const window = options.summary ? SUMMARY_LOG_LINES : DETAIL_LOG_LINES;
  const logs = lines.slice(-window);
  const totals = fileTotalsOf(progress);
  const percent = progress.percent === null || progress.percent === undefined ? null : finiteOr(progress.percent, null);
  return {
    id: String(source.id || ""),
    type: "download",
    title: `Download ${repo} (${transport === "modelscope" ? "ModelScope" : "Hugging Face"})`,
    status: legacyStatusOf(source.state),
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
    finishedAt: source.finishedAt || null,
    exitCode: Number.isInteger(transfer.exitCode) ? transfer.exitCode : null,
    error: error ? errorTitleOf(error) : null,
    meta: {
      model: repo,
      source: provider,
      precision: artifact.quant ?? "",
      outputName: target.outputName || "",
      localDir: target.localDir || "",
      priority: source.priority || "normal",
      expectedBytes: finiteOr(artifact.totalBytes, totalBytes),
      expectedFiles: files.length,
      retryCount: finiteOr(retry.count, 0),
      maxRetries: finiteOr(retry.max, 0),
      retryScheduledAt: retry.nextAt || null,
      hubJobId: String(source.id || ""),
      phase: String(source.state || ""),
      includeExtras: Array.isArray(artifact.companions) ? artifact.companions.map(String) : [],
      errorCode: error && nonEmpty(error.code) ? error.code : null,
      errorBaseCode: error && nonEmpty(error.baseCode) ? error.baseCode : null,
      errorRetryable: error && typeof error.retryable === "boolean" ? error.retryable : null,
      errorHint: error ? bilingualOrNull(error.hint) : null,
      transfer: {
        hfMirror: transport === "hf-mirror",
        hfEndpoint: transferOptions.endpoint || null,
        hfTransfer: transferOptions.xet === "high-performance",
        tokenRef: null,
        gated: Boolean(artifact.gated),
      },
    },
    progress: {
      kind: "download",
      downloadedBytes: Math.max(0, finiteOr(progress.bytesDone, 0)),
      totalBytes,
      percent,
      speedBytesPerSec: Math.max(0, finiteOr(progress.speedEmaBps, finiteOr(progress.speedBps, 0))),
      etaSeconds: progress.etaSeconds === null || progress.etaSeconds === undefined ? null : finiteOr(progress.etaSeconds, null),
      finalizedBytes: totals.finalizedBytes,
      partialBytes: totals.partialBytes,
      incompleteFiles: totals.incompleteFiles,
      stage: stageOf(source),
      updatedAt: progress.updatedAt || source.updatedAt || null,
    },
    logs,
    logCount,
    logsTruncated: logCount > logs.length,
  };
}

/** The legacy `{ ok, id, status }` answer of a job action. */
function toLegacyJobAction(job) {
  const source = isPlainObject(job) ? job : {};
  return { ok: true, id: String(source.id || ""), status: legacyStatusOf(source.state) };
}

/** The legacy log view of GET /api/jobs/:id/logs. */
function toLegacyJobLogs(id, result) {
  const lines = Array.isArray(result?.lines) ? result.lines.map(String) : [];
  const total = Number.isInteger(result?.total) && result.total >= lines.length ? result.total : lines.length;
  return { id: String(id || ""), logs: lines, logCount: total };
}

/** The legacy resume check: `{ ok, id, status, ...inspection }`. */
function toLegacyResumeCheck(result) {
  const source = isPlainObject(result) ? result : {};
  const { ok: _ok, jobId, state, ...inspection } = source;
  return { ok: true, id: String(jobId || ""), status: legacyStatusOf(state), ...inspection };
}

/**
 * A hub error envelope (00 §4.2) as the legacy `{ error, code }` shape. Extra
 * structured details the legacy UIs read are carried over verbatim.
 */
function toLegacyError(body, fallbackMessage = "Model hub request failed.") {
  const envelope = isPlainObject(body?.error) ? body.error : null;
  const code = envelope && nonEmpty(envelope.code) ? envelope.code : nonEmpty(body?.code) ? body.code : "hub_error";
  const message = envelope && nonEmpty(envelope.message) ? envelope.message : nonEmpty(body?.error) ? body.error : fallbackMessage;
  const output = { error: message, code };
  if (envelope && nonEmpty(envelope.hint)) output.hint = envelope.hint;
  return output;
}

module.exports = {
  DETAIL_LOG_LINES,
  LEGACY_STATUS,
  STAGE_COPY,
  SUMMARY_LOG_LINES,
  legacyStatusOf,
  toLegacyError,
  toLegacyJob,
  toLegacyJobAction,
  toLegacyJobLogs,
  toLegacyResumeCheck,
};
