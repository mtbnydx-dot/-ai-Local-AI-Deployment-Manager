// The rules behind the Models Downloads page (07 §6.4, 03 §7-§8, §13.1): which
// tab a job belongs to, the phase Stepper of a job, the classified failure
// card and its fixes, the queue reorder, the throughput sparkline, the history
// merge and the global settings form. Pure, so it can be tested without a DOM.

function list(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function bytesOf(value) {
  const number = Number(value);
  return number > 0 ? number : 0;
}

/** 03 §7.1 phases in order; `ready` is the last. */
export const PHASES = Object.freeze(["queued", "resolving", "downloading", "materializing", "verifying", "ready"]);
export const IN_PROCESS = Object.freeze(["resolving", "downloading", "materializing", "verifying"]);
export const TERMINAL = Object.freeze(["ready", "failed", "cancelled"]);
export const QUEUED_STATES = Object.freeze(["queued", "waiting"]);
const PRIORITY_RANK = Object.freeze({ high: 0, normal: 1, low: 2 });
export const PRIORITIES = Object.freeze(["high", "normal", "low"]);

/** The repository (and quant) a job downloads, else its folder name. */
export function jobTitle(job) {
  const artifact = isObject(job?.artifact) ? job.artifact : {};
  const repo = text(artifact.repo) || text(job?.target?.outputName) || text(job?.id);
  return text(artifact.quant) ? `${repo} · ${artifact.quant}` : repo;
}

/** Splits the list into the three tabs. Failed jobs stay in Active until they are dismissed; ready and cancelled go to History. */
export function splitJobs(jobs) {
  const active = [];
  const queued = [];
  const finished = [];
  for (const job of list(jobs)) {
    if (!isObject(job) || !text(job.id)) continue;
    if (job.state === "ready" || job.state === "cancelled") finished.push(job);
    else if (QUEUED_STATES.includes(job.state)) queued.push(job);
    else active.push(job);
  }
  // In-process first, then the ones waiting on a retry, a pause or a failure; the server order is kept inside each group.
  const rank = (job) => (IN_PROCESS.includes(job.state) ? 0 : job.state === "retrying" ? 1 : job.state === "failed" ? 3 : 2);
  active.sort((a, b) => rank(a) - rank(b));
  queued.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) || (Number(a.queueOrder) || 0) - (Number(b.queueOrder) || 0));
  finished.sort((a, b) => text(b.finishedAt).localeCompare(text(a.finishedAt)));
  return { active, queued, finished };
}

/** 0-100 of a job, or null while the total is unknown. */
export function percentOf(job) {
  const progress = isObject(job?.progress) ? job.progress : {};
  if (Number.isFinite(Number(progress.percent)) && progress.percent !== null) return Math.max(0, Math.min(100, Number(progress.percent)));
  const total = bytesOf(progress.bytesTotal) || bytesOf(job?.artifact?.totalBytes);
  return total > 0 ? Math.max(0, Math.min(100, (bytesOf(progress.bytesDone) / total) * 100)) : null;
}

/** The last 03 §7.1 phase a job reached, from its phase history (`queued` when none). */
export function lastPhase(job) {
  const reached = list(job?.phaseHistory).map((entry) => text(entry?.phase)).filter((phase) => PHASES.includes(phase));
  const current = PHASES.includes(job?.state) ? job.state : null;
  return current || reached[reached.length - 1] || "queued";
}

/**
 * The Stepper steps of a job: phases before the current one are done, the
 * current one is active, a failed job marks its last phase as an error, a
 * cancelled one as skipped. `ready` completes every step.
 */
export function phaseSteps(job) {
  const phase = lastPhase(job);
  const index = PHASES.indexOf(phase);
  return PHASES.map((id, at) => {
    let state = at < index ? "done" : at > index ? "pending" : "active";
    if (job?.state === "ready") state = "done";
    else if (at === index && job?.state === "failed") state = "error";
    else if (at === index && job?.state === "cancelled") state = "skipped";
    else if (at === index && ["paused", "interrupted", "retrying", "waiting"].includes(job?.state)) state = "active";
    return { id, state };
  });
}

/** `{ key, vars }` of the catalog line that says what a job is doing (03 §19). */
export function stateLine(job, now = Date.now()) {
  const state = text(job?.state);
  if (state === "waiting") return { key: `hub.wait.${["runtime-busy", "disk", "concurrency", "auth"].includes(job.waitReason) ? job.waitReason : "concurrency"}` };
  if (state === "retrying") {
    const nextAt = Date.parse(job?.retry?.nextAt);
    return { key: "hub.state.retrying", vars: { seconds: Number.isFinite(nextAt) ? Math.max(0, Math.round((nextAt - now) / 1000)) : 0, n: Number(job?.retry?.count) || 1, max: Number(job?.retry?.max) || 1 } };
  }
  if (state === "verifying") {
    const verify = isObject(job?.progress?.verify) ? job.progress.verify : {};
    return { key: "hub.state.verifying", vars: { done: Number(verify.filesDone) || 0, total: Number(verify.filesTotal) || 0 } };
  }
  return { key: `hub.state.${state || "queued"}` };
}

/** The per-file rows of an active job: `[{ path, bytes, size, percent, state }]`. */
export function fileRows(job) {
  return list(job?.progress?.files).filter((file) => isObject(file) && text(file.path)).map((file) => {
    const size = bytesOf(file.size);
    const bytes = bytesOf(file.bytes);
    return { path: file.path, bytes, size, percent: size > 0 ? Math.min(100, (bytes / size) * 100) : null, state: text(file.state) || "partial" };
  });
}

/** Bytes per second of a job (the smoothed value when the hub has one). */
export function speedOf(job) {
  const progress = isObject(job?.progress) ? job.progress : {};
  const speed = Number(progress.speedEmaBps) > 0 ? Number(progress.speedEmaBps) : Number(progress.speedBps);
  return speed > 0 ? speed : null;
}

// ---- failure ---------------------------------------------------------------------------------

/**
 * The classified failure of a job (03 §6.3 / 08): the hub's title and hint
 * ({zh,en}, rendered through `pick`), the redacted detail, whether it is
 * retried automatically, and the actions it offers. Retry is always among them
 * for a failed or cancelled job. An error without a title falls back to the
 * catalog line (`hub.error.fallback`).
 */
export function failureView(job, pick) {
  const error = isObject(job?.error) ? job.error : null;
  const terminal = job?.state === "failed" || job?.state === "cancelled";
  if (!error && job?.state !== "failed") return null;
  const actions = list(error?.actions).map(text).filter(Boolean);
  if (terminal && !actions.includes("retry")) actions.push("retry");
  const title = isObject(error?.title) ? pick(error.title) : "";
  const hint = isObject(error?.hint) ? pick(error.hint) : "";
  return {
    code: text(error?.code) || "unknown",
    title,
    hint,
    detail: text(error?.detail),
    retryable: error?.retryable === true,
    class: text(error?.class),
    attempts: isObject(job?.retry) ? { count: Number(job.retry.count) || 0, max: Number(job.retry.max) || 0 } : null,
    actions: [...new Set(actions)],
  };
}

/** The source a "switch source" fix moves to: the mirror when on the official endpoint, else the official one. */
export function switchTarget(job) {
  const source = text(job?.transfer?.options?.source);
  if (job?.artifact?.provider === "modelscope") return "";
  return source === "hf-mirror" ? "huggingface" : "hf-mirror";
}

/** Whether a job can take the new source in place (`resume`), instead of a new plan: terminal jobs cannot be resumed (03 §8). */
export function canResumeInPlace(job) {
  return !TERMINAL.includes(job?.state);
}

/** The repository page a failure's "open approval" action goes to: where access to a gated repository is requested. */
export function approvalUrl(job) {
  const repo = text(job?.artifact?.repo);
  if (!repo) return "";
  return job?.artifact?.provider === "modelscope" ? `https://modelscope.cn/models/${repo}` : `https://huggingface.co/${repo}`;
}

/** What the cancel-and-delete dialog says it frees: the bytes on disk (resume check), else what the job downloaded. */
export function reclaimableBytes(job, resumeCheck) {
  return Math.max(bytesOf(resumeCheck?.onDiskBytes), bytesOf(job?.progress?.bytesDone));
}

// ---- queue reorder -------------------------------------------------------------------------------

/** `ids` with the one at `from` moved to `to`; the same array when nothing moves. */
export function moveId(ids, from, to) {
  if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return ids;
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Applies the pending local order (a reorder the server has not echoed yet) to the queued jobs. */
export function applyOrder(jobs, order) {
  if (!list(order).length) return jobs;
  const rank = new Map(order.map((id, index) => [id, index]));
  return jobs.slice().sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

// ---- throughput sparkline ----------------------------------------------------------------------------

export const SPARK_SAMPLES = 60;

/** `samples` plus one more, keeping the newest SPARK_SAMPLES. */
export function pushSample(samples, value) {
  const next = [...samples, Math.max(0, Number(value) || 0)];
  return next.length > SPARK_SAMPLES ? next.slice(next.length - SPARK_SAMPLES) : next;
}

/** The SVG polyline points of the samples in a width x height box (the highest sample touches the top). */
export function sparkPoints(samples, width, height) {
  if (!samples.length) return "";
  const max = Math.max(...samples, 1);
  const step = samples.length > 1 ? width / (samples.length - 1) : 0;
  return samples.map((value, index) => `${(index * step).toFixed(1)},${(height - (value / max) * (height - 2) - 1).toFixed(1)}`).join(" ");
}

// ---- history ------------------------------------------------------------------------------------------

/**
 * The History rows: finished jobs the list still holds plus the compacted
 * records of the history endpoint, filtered by the search text, newest first.
 * An id in both keeps the live job.
 */
export function historyRows(finished, records, query = "") {
  const needle = text(query).trim().toLowerCase();
  const seen = new Set();
  const rows = [];
  for (const job of [...list(finished), ...list(records)]) {
    if (!isObject(job) || !text(job.id) || seen.has(job.id)) continue;
    seen.add(job.id);
    const haystack = [job.artifact?.repo, job.artifact?.quant, job.target?.outputName, job.id].map(text).join(" ").toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    rows.push(job);
  }
  return rows.sort((a, b) => text(b.finishedAt || b.updatedAt).localeCompare(text(a.finishedAt || a.updatedAt)));
}

// ---- settings --------------------------------------------------------------------------------------------

const RETRY_CLASSES = Object.freeze(["network", "server", "watchdog", "integrity", "tooling"]);

/**
 * The global settings form (03 §14) as data: `path` is the dotted setting,
 * `kind` the control. Option `value`s are strings; `retry.perClass.*` is
 * `true | false | "once"` in the settings and "on" | "off" | "once" in the
 * form (see formValue / settingValue).
 */
export const SETTINGS_FIELDS = Object.freeze([
  { path: "sources.policy", kind: "select", group: "sources", options: ["huggingface", "hf-mirror", "auto"] },
  { path: "sources.mirrorEndpoint", kind: "text", group: "sources" },
  { path: "sources.gatedUsesOfficial", kind: "checkbox", group: "sources" },
  { path: "transfer.xet", kind: "select", group: "transfer", options: ["high-performance", "default", "off"] },
  { path: "verify.sha256", kind: "checkbox", group: "transfer" },
  { path: "transfer.maxConcurrent", kind: "number", group: "queue", min: 1, max: 4 },
  { path: "queue.idleOnly", kind: "checkbox", group: "queue" },
  { path: "retry.maxAttempts", kind: "number", group: "retry", min: 0, max: 10 },
  ...RETRY_CLASSES.map((name) => ({ path: `retry.perClass.${name}`, kind: "select", group: "retry", options: ["on", "once", "off"], retryClass: name })),
  { path: "notifications.onReady", kind: "checkbox", group: "notify" },
  { path: "notifications.onFailure", kind: "checkbox", group: "notify" },
]);

export function getPath(object, path) {
  return path.split(".").reduce((value, key) => (isObject(value) ? value[key] : undefined), object);
}

function setPath(object, path, value) {
  const keys = path.split(".");
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

/** A setting as its form value (a string for selects, text and numbers, a boolean for checkboxes). */
export function formValue(field, settings) {
  const value = getPath(settings, field.path);
  if (field.kind === "checkbox") return value === true;
  if (field.retryClass) return value === "once" ? "once" : value === false ? "off" : "on";
  return value === undefined || value === null ? "" : String(value);
}

/** A form value as the setting the hub stores. */
export function settingValue(field, value) {
  if (field.kind === "checkbox") return value === true;
  if (field.kind === "number") return value === "" ? null : Number(value);
  if (field.retryClass) return value === "once" ? "once" : value !== "off";
  return value;
}

/** The PUT /api/hub/settings patch of the fields that differ from `settings` (nested, only changed leaves). */
export function settingsPatch(settings, form) {
  const patch = {};
  for (const field of SETTINGS_FIELDS) {
    if (!Object.hasOwn(form, field.path)) continue;
    if (form[field.path] === formValue(field, settings)) continue;
    setPath(patch, field.path, settingValue(field, form[field.path]));
  }
  return patch;
}

/** The form values of the settings. */
export function settingsForm(settings) {
  return Object.fromEntries(SETTINGS_FIELDS.map((field) => [field.path, formValue(field, settings)]));
}
