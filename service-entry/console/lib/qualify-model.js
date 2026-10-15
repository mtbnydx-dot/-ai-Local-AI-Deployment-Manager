// The rules behind qualification and Save as recipe (07 §6.2, 02 §13 and §15,
// R-UI-5 and R-UI-7), kept apart from drawing so Node can test them:
//
//   - which manager job a deployment's checklist follows (the one the page
//     started, else the newest running `model-qualify` job of the fleetId),
//   - the checklist rows, from the relayed job while it runs and from the stored
//     host record once it is written (the record carries each check's detail),
//   - whether Save as recipe is allowed (a passing `chat` check),
//   - the Save as recipe form: the draft, the client-side checks, the request
//     body, the lock candidates and the mapping of 400/422 field errors.

export const QUALIFY_JOB_TYPE = "model-qualify";

/** 02 §13 check ids in the order the suite runs them. */
export const CHECK_IDS = Object.freeze(["models", "chat", "reasoning-split", "tool-call", "json-output", "vision", "needle", "speculative", "throughput"]);

/** The settled statuses a check can end in; `running`, `pending` and `done` only exist while a job is live. */
export const SETTLED = Object.freeze(["pass", "warn", "fail", "skip"]);

/** Same pattern as the entry's save-recipe route (kebab-case, starts with a letter, at most 64 characters). */
export const RECIPE_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const RECIPE_SCOPES = Object.freeze(["family", "this-model"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === "string" ? value.trim() : "");

const CHECK_LINE = /(?:^|[\s\]])([a-z][a-z-]*): (pass|warn|fail|skip)\s*$/;
const STAGE_CHECK = /Qualify:\s*([a-z][a-z-]*)\s*$/;

export const isQualifyJob = (job) => isObject(job) && job.type === QUALIFY_JOB_TYPE;

const stateOf = (job) => {
  const raw = String(job?.status ?? job?.state ?? "").toLowerCase();
  if (["success", "succeeded", "completed", "done"].includes(raw)) return "success";
  if (["failed", "error", "interrupted", "cancelled", "canceled"].includes(raw)) return "failed";
  return "running";
};

/** The `model-qualify` jobs of one fleetId, newest first. `jobs` is the manager's list (array or { jobs }). */
export function qualifyJobsOf(jobs, fleetId) {
  const rows = Array.isArray(jobs) ? jobs : list(jobs?.jobs);
  return rows
    .filter((job) => isQualifyJob(job) && (!fleetId || job.meta?.fleetId === fleetId))
    .sort((a, b) => String(b.createdAt || b.startedAt || "").localeCompare(String(a.createdAt || a.startedAt || "")));
}

/**
 * The job the checklist shows: the one with `jobId` (started here), else the
 * newest qualification of the fleetId that still runs (a reload, or the
 * auto-qualify the entry started). Null when there is none.
 */
export function followedJob(jobs, { jobId = "", fleetId = "" } = {}) {
  const rows = Array.isArray(jobs) ? jobs : list(jobs?.jobs);
  if (jobId) return rows.find((job) => isObject(job) && String(job.id) === String(jobId)) || null;
  return qualifyJobsOf(rows, fleetId).find((job) => stateOf(job) === "running") || null;
}

/** { state, planned, current, observed, percent } of a live or finished qualification job. */
export function jobProgress(job) {
  if (!isObject(job)) return { state: "running", planned: [], current: "", observed: {}, percent: null };
  const planned = list(job.meta?.checks).filter((id) => typeof id === "string");
  const observed = {};
  for (const line of list(job.logs)) {
    const match = CHECK_LINE.exec(String(line));
    if (match) observed[match[1]] = match[2];
  }
  const stage = STAGE_CHECK.exec(String(job.progress?.stage || ""));
  const current = stage ? stage[1] : "";
  const status = String(job.progress?.detail || "");
  if (current && SETTLED.includes(status)) observed[current] = status;
  const percent = Number(job.progress?.percent);
  return { state: stateOf(job), planned, current, observed, percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null };
}

/**
 * Checklist rows: { id, status: pending|running|done|pass|warn|fail|skip, detail: {zh,en}|null, metrics }.
 * A host record (stored once the run is over) wins because it has each check's detail; before
 * that the rows come from the job: the planned checks, the ones already reported, the one running.
 */
export function checkRows({ job = null, record = null } = {}) {
  if (isObject(record) && Array.isArray(record.results) && record.results.length) {
    return record.results.filter((item) => isObject(item) && typeof item.check === "string").map((item) => ({
      id: item.check,
      status: SETTLED.includes(item.status) ? item.status : "done",
      detail: isObject(item.detail) ? item.detail : null,
      metrics: isObject(item.metrics) ? item.metrics : {},
    }));
  }
  const live = jobProgress(job);
  const ids = live.planned.length ? live.planned : CHECK_IDS.filter((id) => id in live.observed || id === live.current);
  const currentIndex = ids.indexOf(live.current);
  return ids.map((id, index) => {
    let status = "pending";
    if (SETTLED.includes(live.observed[id])) status = live.observed[id];
    else if (id === live.current && live.state === "running") status = "running";
    else if (currentIndex > index || (live.state === "success" && !live.current)) status = "done";
    return { id, status, detail: null, metrics: {} };
  });
}

/** The badge tone of a row status. */
export const STATUS_BADGE = Object.freeze({ pass: "ok", warn: "warn", fail: "error", skip: "neutral", running: "loading", pending: "neutral", done: "info" });

/** Counts of settled statuses, e.g. for the summary line. */
export function summarize(rows) {
  const out = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const row of list(rows)) if (row.status in out) out[row.status] += 1;
  return out;
}

/** The records of this deployment, newest first: its launchId when known, else its fleetId. */
export function recordsFor(records, { launchId = "", fleetId = "" } = {}) {
  return list(records)
    .filter((record) => isObject(record) && (launchId ? record.launchId === launchId : record.fleetId === fleetId))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}

export const hasPassingChat = (record) => list(record?.results).some((item) => item?.check === "chat" && item?.status === "pass");

/** Save as recipe is allowed after a passing `chat` check on this deployment's launch (R-UI-7). */
export function canSaveRecipe(records, scope) {
  return recordsFor(records, scope).some(hasPassingChat);
}

// ---- the Save as recipe form -----------------------------------------------------------------------------

/** Turns a model name into a suggested kebab-case recipe id ("Qwen3.8 32B" → "qwen3-8-32b-verified"). */
export function suggestRecipeId(name, suffix = "verified") {
  const base = String(name || "").toLowerCase().split(/[\\/]/).filter(Boolean).pop() || "";
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[0-9-]+/, "");
  const id = [slug, suffix].filter(Boolean).join("-").slice(0, 64).replace(/-+$/g, "");
  return RECIPE_ID_RE.test(id) ? id : "";
}

export function blankRecipeDraft(name = "") {
  return { recipeId: suggestRecipeId(name), titleZh: "", titleEn: String(name || "").split(/[\\/]/).filter(Boolean).pop() || "", scope: "family", locks: [], notes: "" };
}

/** Field → { code, message } for the form's own checks; empty when the draft can be sent. */
export function validateRecipeDraft(draft) {
  const errors = {};
  if (!RECIPE_ID_RE.test(draft.recipeId) || draft.recipeId.length > 64) errors.recipeId = { code: "invalid", message: "" };
  if (!text(draft.titleZh)) errors["title.zh"] = { code: "required", message: "" };
  if (!text(draft.titleEn)) errors["title.en"] = { code: "required", message: "" };
  if (!RECIPE_SCOPES.includes(draft.scope)) errors.scope = { code: "invalid", message: "" };
  return errors;
}

/** The body of POST /api/launches/:launchId/save-recipe. */
export function saveRecipeBody(draft, { overwrite = false } = {}) {
  const body = {
    recipeId: draft.recipeId,
    title: { zh: text(draft.titleZh), en: text(draft.titleEn) },
    scope: draft.scope,
  };
  if (draft.locks.length) body.locks = [...draft.locks];
  if (text(draft.notes)) body.notes = text(draft.notes);
  if (overwrite) body.overwrite = true;
  return body;
}

/**
 * The parameters an owner can lock: the values whose source was the user, the planner or the model
 * (the same ones the recipe keeps, 02 §15). `values` is the launch's resolved map { id: { value, source } }.
 */
export function lockCandidates(values) {
  if (!isObject(values)) return [];
  return Object.entries(values)
    .filter(([, entry]) => !isObject(entry) || !entry.source || ["user", "planner", "model"].includes(entry.source))
    .map(([id, entry]) => ({ id, value: isObject(entry) && Object.hasOwn(entry, "value") ? entry.value : entry }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const FIELD_ALIAS = Object.freeze({ "title.zh": "title.zh", "title.en": "title.en", title: "title.zh" });

/**
 * Maps an ApiError's field errors to the form: { fields: { recipeId|title.zh|title.en|scope|locks|notes: message },
 * other: [{ field, message }] }. A 422 recipe_invalid names paths of the built recipe ("match.familyId");
 * those have no input and are listed under the form.
 */
export function mapFieldErrors(error) {
  const fields = {};
  const other = [];
  for (const item of list(error?.fieldErrors)) {
    const field = text(item?.field);
    const message = text(item?.message) || text(item?.code);
    const mapped = FIELD_ALIAS[field] || field;
    if (["recipeId", "title.zh", "title.en", "scope", "locks", "notes", "overwrite"].includes(mapped)) {
      if (!fields[mapped]) fields[mapped] = message;
    } else other.push({ field, message });
  }
  return { fields, other };
}

/** Where the recipe a 409 `recipe_exists` names lives: "bundled" (cannot be replaced) or "user". */
export function existingRecipeSource(error) {
  if (error?.code !== "recipe_exists") return "";
  return text(error.details?.source) || text(error.details?.details?.source) || "user";
}

/** The link to the saved recipe on the engine's Recipes tab (07 §6.5). */
export function recipeHref(engineId, recipeId) {
  const params = new URLSearchParams({ tab: "recipes" });
  if (recipeId) params.set("recipe", recipeId);
  return `/engines/${encodeURIComponent(engineId || "")}?${params.toString()}`;
}

/** The inspect request for the launch's model, or null when the launch names none. */
export function modelRefOf(record) {
  const ref = text(record?.spec?.model?.ref);
  return ref ? { kind: "local", path: ref } : null;
}
