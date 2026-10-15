"use strict";

// Pure legacy mappers for the manager shims (03 §15). The managers' legacy
// routes and their SSE `jobs` event keep their old shapes while the hub owns
// the downloads; these functions turn hub objects into those shapes. Nothing
// here does I/O, and nothing here reads or returns a credential: the hub's
// vault ref never leaves the hub (`meta.transfer.tokenRef` is always null).

const { listGgufVariants } = require("../gguf-variants");
const { groupPrecisionVariants } = require("../precision-variants");
const remoteUtils = require("../remote-model-utils");
const { safeOutputName } = require("../settings-stores");
const { describeHubError } = require("./errors");
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

// --- download, discovery, settings, auth and storage (HUB-13b, 03 §15) --------
//
// The remaining rows of the shim table. Every function is pure: the shim does
// the I/O and these turn hub objects into the legacy response shapes.

const GIB = 1024 ** 3;
const PROVIDER_URLS = Object.freeze({
  huggingface: (id) => `https://huggingface.co/${id}`,
  modelscope: (id) => `https://modelscope.cn/models/${id}`,
});
const LEGACY_PROBE_IDS = Object.freeze({ huggingface: "official", "hf-mirror": "mirror", modelscope: "modelscope" });
const PROBE_LABELS = Object.freeze({ official: "huggingface.co", mirror: "hf-mirror.com", modelscope: "modelscope.cn" });
const GATED_BLOCKING = Object.freeze({
  hf_login_required: "login_required",
  hf_approval_required: "approval_required",
  gated_official_required: "official_required",
});
// The engines each manager can run (03 §13.2 engine badges, 00 §3 ids).
const MANAGER_ENGINES = Object.freeze({ vllm: ["vllm", "sglang"], llama: ["llamacpp"] });
// The one format a manager's engines load (null: not restricted to one); the
// llama.cpp manager loads GGUF only, which the former " GGUF" query suffix asked for.
const MANAGER_FORMATS = Object.freeze({ vllm: null, llama: "gguf" });
const FEATURE_TERMS = Object.freeze({ distilled: "distill", uncensored: "uncensored", reasoning: "reasoning" });
const NATIVE_QUANT_FACETS = Object.freeze({ GGUF: "gguf", FP8: "fp8", NVFP4: "nvfp4", MXFP4: "mxfp4", AWQ: "awq", GPTQ: "gptq" });

function unique(values) {
  return Array.from(new Set(values));
}

function repoUrl(provider, repo) {
  return (PROVIDER_URLS[provider] || PROVIDER_URLS.huggingface)(repo);
}

function bilingualHint(code) {
  const { hint } = describeHubError(code);
  return `${hint.zh} / ${hint.en}`;
}

function formatGb(bytes) {
  return `${(Number(bytes) / GIB).toFixed(1)} GB`;
}

/** "Q4_K_M 4.4 GB, Q8_0 8.1 GB": language-neutral, so an English page shows no Han text from it. */
function suggestionText(suggestions) {
  return (Array.isArray(suggestions) ? suggestions : []).slice(0, 8).map((item) => {
    const label = String(item?.label || item?.quant || item?.artifactKey || "").trim();
    return Number(item?.bytes) > 0 ? `${label} ${formatGb(item.bytes)}` : label;
  }).filter(Boolean).join(", ");
}

function blockingToLegacy(item, { repo = "", access = null } = {}) {
  const blocking = isPlainObject(item) ? item : {};
  const code = String(blocking.code || "plan_blocked");
  if (GATED_BLOCKING[code]) {
    // The legacy gated error (createHfAccessError): 409 with the access status
    // and the model page to request access on.
    const url = access?.authorizationUrl || (repo ? `https://huggingface.co/${repo.split("/").map(encodeURIComponent).join("/")}` : null);
    return {
      status: 409,
      body: { error: code === "gated_official_required" ? String(blocking.message || bilingualHint("hf_login_required")) : bilingualHint(code), code, accessStatus: access?.status || GATED_BLOCKING[code], authorizationUrl: url },
    };
  }
  if (code === "disk_full") {
    return { status: 400, body: { error: String(blocking.message || bilingualHint("disk_full")), code: "download_disk_full" } };
  }
  const body = { error: String(blocking.message || "The download is blocked."), code };
  if (nonEmpty(blocking.hint)) body.hint = blocking.hint;
  if (nonEmpty(blocking.existingJobId)) body.existingJobId = blocking.existingJobId;
  return { status: code === "already_downloading" ? 409 : 422, body };
}

/**
 * A hub failure of a download route as the legacy { status, body }
 * (`{ error, code, existingJobId?, authorizationUrl?, accessStatus?,
 * suggestions?, details? }`). `context` carries what only the shim knows: the
 * requested `precision`, the manifest's `totalFiles`, the repo and the plan's
 * access block.
 */
function toLegacyDownloadError(status, body, context = {}) {
  const envelope = isPlainObject(body?.error) ? body.error : {};
  const details = isPlainObject(envelope.details) ? envelope.details : {};
  const code = nonEmpty(envelope.code) ? envelope.code : "hub_error";
  if (code === "plan_blocked" && Array.isArray(details.blocking) && details.blocking.length) {
    return blockingToLegacy(details.blocking[0], context);
  }
  if (code === "filter_no_match") {
    const suggestions = Array.isArray(details.suggestions) ? details.suggestions : [];
    const list = suggestionText(suggestions);
    // The P0-RT-6 shape; the quant list rides in the text because the legacy
    // pages show the message only.
    return {
      status: 422,
      body: {
        error: `${bilingualHint("filter_no_match")}${list ? ` (${list})` : ""}`,
        code,
        details: { precision: String(context.precision ?? details.precision ?? ""), totalFiles: Number.isInteger(context.totalFiles) ? context.totalFiles : null },
        suggestions,
      },
    };
  }
  const legacy = toLegacyError(body);
  if (nonEmpty(details.existingJobId)) legacy.existingJobId = details.existingJobId;
  if (nonEmpty(details.authorizationUrl)) legacy.authorizationUrl = details.authorizationUrl;
  if (nonEmpty(details.accessStatus)) legacy.accessStatus = details.accessStatus;
  return { status: Number.isInteger(status) && status >= 400 ? status : 502, body: legacy };
}

/** Hub plan problems → the first blocking item as the legacy { status, body }, or null. */
function planBlockingToLegacy(plan, repo) {
  const first = Array.isArray(plan?.blocking) ? plan.blocking[0] : null;
  return first ? blockingToLegacy(first, { repo, access: plan.access }) : null;
}

/**
 * GET /api/download/estimate. `plan` is the hub plan body, `totalFiles` the
 * repo's file count and `compiled` the include patterns of the plan's files.
 */
function toLegacyEstimate({ source, model, precision = "", plan, totalFiles = null, compiled = { mode: "all" }, diskFreeBytes = null }) {
  const files = Array.isArray(plan?.artifact?.files) ? plan.artifact.files : [];
  const access = isPlainObject(plan?.access) ? plan.access : {};
  const gated = Boolean(access.gated);
  const bytes = finiteOr(plan?.artifact?.totalBytes, 0);
  return {
    source,
    model,
    precision,
    bytes: bytes || null,
    fileCount: files.length,
    includePatterns: compiled.mode === "include" ? [...compiled.patterns] : [],
    filtered: compiled.mode === "include",
    matchedFiles: files.length,
    totalFiles: Number.isInteger(totalFiles) ? totalFiles : files.length,
    gated,
    gateMode: gated,
    authorizationUrl: access.authorizationUrl || (source === "huggingface" ? repoUrl("huggingface", model) : null),
    supported: true,
    diskFreeBytes: diskFreeBytes === null || diskFreeBytes === undefined ? finiteOr(plan?.target?.freeBytes, null) : diskFreeBytes,
  };
}

/** The estimate of a selection that matched nothing (the legacy "filtered, 0 matched" answer). */
function emptyLegacyEstimate({ source, model, precision = "", totalFiles = null, diskFreeBytes = null }) {
  return {
    source,
    model,
    precision,
    bytes: null,
    fileCount: 0,
    includePatterns: [],
    filtered: true,
    matchedFiles: 0,
    totalFiles,
    gated: false,
    gateMode: false,
    authorizationUrl: source === "huggingface" ? repoUrl("huggingface", model) : null,
    supported: true,
    diskFreeBytes,
  };
}

// --- remote models ------------------------------------------------------------

/**
 * One hub search item as the legacy catalogue summary (every key the legacy
 * pages read; keys the hub does not know are null or empty). `context` has the
 * manager's `managerId`, `precisionOrder` and `quantKeywords`.
 */
function toLegacyRemoteModel(item, context = {}) {
  const source = isPlainObject(item) ? item : {};
  const id = String(source.repo || "");
  const provider = source.provider === "modelscope" ? "modelscope" : "huggingface";
  const author = String(source.author || id.split("/")[0] || "");
  const tags = Array.isArray(source.tags) ? source.tags.map(String) : [];
  const formats = Array.isArray(source.formats) ? source.formats.map((value) => String(value).toLowerCase()) : [];
  const hasGguf = formats.includes("gguf");
  const hasSafetensors = formats.some((value) => value !== "gguf");
  const hubQuants = Array.isArray(source.quants) ? source.quants.map(String) : [];
  const inferred = remoteUtils.inferRemoteQuantFormats({ id, tags, keywords: context.quantKeywords });
  const quantFormats = unique([
    ...inferred,
    ...formats.filter((value) => !["gguf", "safetensors"].includes(value)).map((value) => value.toUpperCase()),
    ...(hasGguf ? ["GGUF"] : []),
    ...hubQuants.map((value) => value.toUpperCase()),
  ]);
  const paramsB = Number(source.paramsB) > 0 ? Number(source.paramsB) : null;
  const lower = `${id} ${tags.join(" ")}`.toLowerCase();
  const task = String(source.task || "");
  const badges = [];
  if (lower.includes("distill")) badges.push("distilled");
  if (remoteUtils.isUncensoredText(lower)) badges.push("uncensored");
  if (["image-text-to-text", "visual-question-answering", "image-to-text", "any-to-any"].includes(task.toLowerCase()) || /\b(vl|vision|multimodal|omni|image|video)\b/i.test(lower)) badges.push("multimodal");
  badges.push(...quantFormats.slice(0, 5));
  if (source.gated) badges.push("gated");
  const engines = (Array.isArray(source.engines) ? source.engines : []).map((engine) => (typeof engine === "string" ? engine : engine?.engineId));
  const wanted = MANAGER_ENGINES[context.managerId] || [];
  const selection = remoteUtils.inferModelSelection({
    id,
    author,
    tags,
    source: provider,
    quantFormats,
    ...(context.precisionOrder ? { precisionOrder: context.precisionOrder } : {}),
  });
  return {
    source: provider,
    model: id,
    id,
    label: id,
    author,
    url: repoUrl(provider, id),
    tags,
    badges,
    downloads: finiteOr(source.downloads, 0),
    likes: finiteOr(source.likes, 0),
    gated: Boolean(source.gated),
    pipelineTag: task,
    libraryName: "",
    lastModified: source.lastModified || "",
    createdAt: "",
    hasConfig: hasSafetensors,
    hasSafetensors,
    hasGguf,
    hasQuantizedFiles: remoteUtils.hasQuantizedRemoteFiles(quantFormats),
    quantFormats,
    paramsB,
    sizeClass: remoteUtils.remoteSizeClass(paramsB),
    fileSizeBytes: null,
    largestFileBytes: null,
    fileCount: 0,
    summary: "",
    selection,
    outputName: safeOutputName(id.replace(/[\\/]/g, "-")),
    runnable: engines.length ? engines.some((engine) => wanted.includes(engine)) : hasGguf === (MANAGER_FORMATS[context.managerId] === "gguf"),
  };
}

/** The GET /search query (a URLSearchParams) of a normalized legacy catalogue request (03 §15). */
function toHubSearchQuery(request = {}, { managerId = "" } = {}) {
  const params = new URLSearchParams();
  const terms = [String(request.search || "").trim(), FEATURE_TERMS[request.feature] || ""].filter(Boolean);
  if (terms.length) params.set("q", terms.join(" "));
  params.set("provider", request.source === "modelscope" ? "modelscope" : "huggingface");
  params.set("sort", request.sort === "lastModified" ? "updated" : (request.sort || "trending"));
  // The llama shim's former " GGUF" query suffix.
  const managerFormat = MANAGER_FORMATS[managerId] || null;
  if (managerFormat) params.append("facet", `format:${managerFormat}`);
  if (request.task === "text") params.append("facet", "task:text-generation");
  if (request.task === "vision") params.append("facet", "modality:vision");
  if (request.feature === "moe") params.append("facet", "moe:true");
  const native = NATIVE_QUANT_FACETS[String(request.quant || "")];
  if (native && native !== managerFormat) params.append("facet", `format:${native}`);
  if (["2026", "2025"].includes(String(request.freshness || ""))) params.append("facet", "updated:365d");
  return params;
}

/** `{ models, limit, source, sort, ... }` of GET /api/remote-models. */
function toLegacyRemoteSearch(request, items, context = {}) {
  const wanted = Math.max(1, finiteOr(request.limit, 48));
  const models = [];
  for (const item of Array.isArray(items) ? items : []) {
    const model = toLegacyRemoteModel(item, context);
    if (!model.id) continue;
    if (request.size && !remoteUtils.matchesRemoteSizeFilter(model, request.size)) continue;
    if (request.quant && !remoteUtils.matchesRemoteQuantFilter(model, request.quant)) continue;
    models.push(model);
    if (models.length >= wanted) break;
  }
  return {
    source: request.source,
    sort: request.sort,
    task: request.task,
    feature: request.feature,
    search: request.search,
    limit: request.limit,
    size: request.size,
    freshness: request.freshness,
    quant: request.quant,
    models,
  };
}

const LEGACY_FIT_STATUS = Object.freeze({ fits: "fits", tight: "tight", spills: "tight", "wont-fit": "exceeds", unknown: "unknown" });

/** The legacy gguf-variants `fit` ({ status, ratio, note }) from a hub fit object. */
function toLegacyFit(fit) {
  const source = isPlainObject(fit) ? fit : {};
  const status = LEGACY_FIT_STATUS[source.label] || "unknown";
  const needed = Number(source.neededMb);
  if (status === "unknown" || !(needed > 0)) return { status: "unknown", ratio: null, note: "未读取到显存信息。" };
  const headroom = Number(source.headroomMb);
  const overflow = Number(source.overflowMb);
  const total = status === "exceeds" && overflow > 0 ? needed - overflow : Number.isFinite(headroom) ? needed + headroom : 0;
  const ratio = total > 0 ? needed / total : null;
  const percent = ratio === null ? "" : `约占显存 ${(ratio * 100).toFixed(0)}%，`;
  const note = status === "fits"
    ? `${percent}可以整模型放进 GPU。`
    : status === "tight"
      ? `${percent}上下文需要保守，或放部分层到 CPU。`
      : `需要约 ${(needed / 1024).toFixed(1)} GB，超过显存，只能把部分层放到 CPU。`;
  return { status, ratio, note, spill: source.spill === true, source: "hub" };
}

/**
 * GET /api/remote-models/gguf-variants. `files` are the repo's { name, size }
 * rows (the hub file listing), `detail` the hub repo detail (artifact fits and
 * access). The variant groups come from the same listGgufVariants the hub's
 * artifacts are built with, so `artifactKey = gguf:<directory>|<quant>` joins
 * the two.
 */
function toLegacyGgufVariants({ model, source = "huggingface", selected = "", files = [], detail = null }) {
  const listing = listGgufVariants(files);
  const artifacts = new Map((Array.isArray(detail?.artifacts) ? detail.artifacts : []).map((artifact) => [artifact.artifactKey, artifact]));
  return {
    model,
    source,
    supported: true,
    gated: Boolean(detail?.access?.gated),
    selected: selected || "",
    ...listing,
    variants: listing.variants.map((variant) => {
      const artifact = artifacts.get(`gguf:${variant.directory}|${variant.quant}`);
      return {
        ...variant,
        files: variant.files.slice(0, 12),
        fit: artifact ? toLegacyFit(artifact.fit) : variant.fit,
      };
    }),
  };
}

/** GET /api/remote-models/precision-variants over the hub's sibling repos. */
function toLegacyPrecisionVariants(model, siblingRepos, options = {}) {
  const siblings = (Array.isArray(siblingRepos) ? siblingRepos : []).map((item) => ({ id: item?.repo })).filter((item) => item.id);
  return groupPrecisionVariants(model, [{ id: model }, ...siblings].map((item) => ({ ...item, hasGguf: /gguf/i.test(item.id) })), options);
}

/** POST /api/resolve-model-link: the legacy reference, with the catalogue summary when the shim found one. */
function toLegacyResolvedLink(link, item = null, context = {}) {
  const provider = link?.provider === "modelscope" ? "modelscope" : "huggingface";
  const model = String(link?.repo || "");
  const reference = { source: provider, model, url: repoUrl(provider, model) };
  const outputName = safeOutputName(model.replace(/[\\/]/g, "-"));
  if (item) return { ...reference, ...toLegacyRemoteModel(item, context), url: reference.url, outputName };
  return {
    ...reference,
    label: model,
    tags: [],
    downloads: null,
    likes: null,
    lastModified: null,
    summary: provider === "modelscope" ? "已从 ModelScope 链接解析出模型 ID。下载时会使用 ModelScope 来源。" : "",
    selection: remoteUtils.inferModelSelection({ id: model, author: model.split("/")[0], source: provider, ...(context.precisionOrder ? { precisionOrder: context.precisionOrder } : {}) }),
    outputName,
  };
}

// --- settings, source probe, auth ---------------------------------------------

/** POST /api/download/mirror-probe: the hub's probe in the legacy shape. */
function toLegacyProbe(result) {
  const source = isPlainObject(result) ? result : {};
  const rows = (Array.isArray(source.sources) ? source.sources : []).map((row) => {
    const id = LEGACY_PROBE_IDS[row.source] || row.source;
    return { ...row, source: id, label: row.label || PROBE_LABELS[id] || null, repo: row.repo || source.repo || "" };
  });
  const byId = (id) => rows.find((row) => row.source === id) || { source: id, label: PROBE_LABELS[id], ok: false, error: "not probed" };
  const recommended = LEGACY_PROBE_IDS[source.recommended] || source.recommended || "official";
  const modelscope = byId("modelscope");
  return {
    ok: source.ok !== false,
    repo: source.repo || "",
    file: source.file || "",
    official: byId("official"),
    mirror: byId("mirror"),
    modelscope,
    modelScopeRepo: modelscope.ok ? modelscope.repo || "" : "",
    sources: rows,
    recommended,
    recommendedLabel: PROBE_LABELS[recommended] || recommended,
    at: source.at || new Date().toISOString(),
  };
}

/** GET /api/huggingface/auth/status (the vLLM shape). */
function toLegacyAuthStatus(result) {
  const source = isPlainObject(result) ? result : {};
  return {
    connected: Boolean(source.connected),
    username: source.username || null,
    orgs: Array.isArray(source.orgs) ? source.orgs : [],
    source: source.source || null,
    ...(source.reason ? { reason: source.reason } : {}),
  };
}

/** GET /api/huggingface/access: the legacy gated check over the hub's access result. */
function toLegacyAccess({ model, access, detail = null }) {
  const result = isPlainObject(access) ? access : {};
  const known = isPlainObject(detail?.access);
  const gated = known ? Boolean(detail.access.gated) : result.granted !== true;
  const authorizationUrl = result.authorizationUrl || detail?.access?.authorizationUrl || repoUrl("huggingface", model);
  if (!gated) return { model, gated: false, granted: true, status: "public", authorizationUrl };
  return { model, gated: true, granted: Boolean(result.granted), status: String(result.status || "check_failed"), username: result.username || null, authorizationUrl };
}

// --- storage ------------------------------------------------------------------

/**
 * GET /api/models/disk-usage: 08 P0-DL-3's shape. The top-level fields are the
 * default root's (as the legacy store computed them), `roots[]` keeps its
 * legacy keys and `models[].rootId`; every hub-only field (volume, pending and
 * reserve bytes, hidden, entryId, residues, orphan partials, duplicates) is
 * stripped.
 */
function toLegacyDiskUsage(usage) {
  const source = isPlainObject(usage) ? usage : {};
  const roots = (Array.isArray(source.roots) ? source.roots : []).map((root) => ({
    id: root.id,
    path: root.path,
    label: root.label,
    default: Boolean(root.default),
    legacy: Boolean(root.legacy),
    mode: root.mode === "model" ? "model" : "library",
    available: root.available !== false,
    freeBytes: root.freeBytes ?? null,
    totalBytes: root.totalBytes ?? null,
    usedByModelsBytes: finiteOr(root.usedByModelsBytes, 0),
    modelCount: finiteOr(root.modelCount, 0),
    incompleteBytes: finiteOr(root.incompleteBytes, 0),
    incompleteFiles: finiteOr(root.incompleteFiles, 0),
  }));
  const primary = roots.find((root) => root.default) || roots[0] || null;
  const models = (Array.isArray(source.models) ? source.models : []).map((model) => ({
    name: model.name,
    path: model.path,
    rootId: model.rootId,
    bytes: finiteOr(model.bytes, finiteOr(model.sizeBytes, 0)),
    sizeBytes: finiteOr(model.sizeBytes, finiteOr(model.bytes, 0)),
    incompleteFiles: finiteOr(model.incompleteFiles, 0),
    incompleteBytes: finiteOr(model.incompleteBytes, 0),
    incomplete: Boolean(model.incomplete),
    modified: model.modified || null,
  }));
  const cache = isPlainObject(source.hfCache) ? source.hfCache : {};
  return {
    ok: true,
    root: primary ? primary.path : "",
    disk: primary ? { freeBytes: primary.freeBytes, totalBytes: primary.totalBytes } : null,
    modelsBytes: primary ? primary.usedByModelsBytes : 0,
    models,
    roots,
    hfCache: {
      path: cache.path || "",
      hubBytes: finiteOr(cache.hubBytes, 0),
      xetBytes: finiteOr(cache.xetBytes, 0),
      modelscopeBytes: finiteOr(cache.modelscopeBytes, 0),
    },
    incompleteBytes: primary ? primary.incompleteBytes : 0,
    incompleteFiles: primary ? primary.incompleteFiles : 0,
    updatedAt: source.updatedAt || new Date().toISOString(),
  };
}

/** POST /api/models/cleanup-incomplete: `{ ok, path, removed, removedBytes }`. */
function toLegacyCleanup(entryPath, result) {
  const source = isPlainObject(result) ? result : {};
  return {
    ok: true,
    path: entryPath,
    removed: Array.isArray(source.removed) ? source.removed.map(String) : [],
    removedBytes: finiteOr(source.removedBytes, 0),
  };
}

/** GET /api/models/upstream-status over a library entry and its update check. */
function toLegacyUpstreamStatus({ name, entry, update }) {
  const provenance = isPlainObject(entry?.provenance) ? entry.provenance : {};
  const repo = String(provenance.repo || "");
  const status = isPlainObject(update) ? update : {};
  const entryPath = entry?.path || "";
  if (!repo || status.status === "unsupported") {
    return { ok: false, name, path: entryPath, reason: "unknown_source", message: "没有找到该目录的下载记录，无法确定上游仓库；可在请求中显式提供 model。" };
  }
  const updateAvailable = status.status === "available" ? true : status.status === "current" ? false : null;
  const provider = provenance.provider === "modelscope" ? "modelscope" : "huggingface";
  return {
    ok: status.status !== "error",
    name,
    path: entryPath,
    repo,
    url: repoUrl(provider, repo),
    lastModified: null,
    downloadedAt: provenance.downloadedAt || null,
    recordSource: provenance.source || "request",
    updateAvailable,
    remoteSha: status.remoteSha || null,
    localSha: provenance.revisionSha || null,
    message: status.status === "error"
      ? "暂时无法读取上游仓库，请稍后重试。"
      : updateAvailable === null
        ? "缺少可比对的时间信息，仅显示上游最近更新时间。"
        : updateAvailable
          ? "上游仓库在本地下载之后有更新，可重新下载获取新版本。"
          : "本地已是最新：上游在下载之后没有更新。",
  };
}

module.exports = {
  DETAIL_LOG_LINES,
  LEGACY_STATUS,
  STAGE_COPY,
  SUMMARY_LOG_LINES,
  emptyLegacyEstimate,
  legacyStatusOf,
  planBlockingToLegacy,
  toHubSearchQuery,
  toLegacyAccess,
  toLegacyAuthStatus,
  toLegacyCleanup,
  toLegacyDiskUsage,
  toLegacyDownloadError,
  toLegacyError,
  toLegacyEstimate,
  toLegacyFit,
  toLegacyGgufVariants,
  toLegacyJob,
  toLegacyJobAction,
  toLegacyJobLogs,
  toLegacyPrecisionVariants,
  toLegacyProbe,
  toLegacyRemoteModel,
  toLegacyRemoteSearch,
  toLegacyResolvedLink,
  toLegacyResumeCheck,
  toLegacyUpstreamStatus,
};
