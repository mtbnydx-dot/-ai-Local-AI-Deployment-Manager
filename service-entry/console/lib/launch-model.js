// Review and Launch rules of the deployment wizard (07 §6.3 steps 6 and 7), the
// pure half of routes/deploy-wizard/step-review.js and step-launch.js:
//
//   gate        when Launch is blocked (errors, blockers, a `block` verdict, a prospective plan)
//   image step  what plan.steps[] {kind:"pull"} says: present, auto, explicit or a local build
//   command     the redacted argv and env of the plan for CommandPreview, with a second
//               redaction of anything that still looks like a secret
//   diffs       overrides with reasons, the diff against the last launch, what a 409
//               `plan_changed` or a suggestion changed
//   job         the 00 §4.1 phases of a launch job, its failure object (00 §9.11) and the
//               signature lookup behind the RootCausePanel
//   storage     the launch the tab started, so a reload finds its job again
//
// Nothing here touches the DOM, storage or the network.

import { diffValues } from "./wizard-state.js";

export const LAUNCH_PHASES = Object.freeze(["pull", "admission", "container", "weights", "kv", "graphs", "api", "probe", "ready"]);
export const LAUNCH_STORAGE_KEY = "console.wizard.launch";
/** Blocker codes the image step handles itself (01 §23). */
export const PULL_BLOCKERS = Object.freeze(["image_pull_required", "runtime_local_build_missing"]);

const SECRET_NAME = /(?:api[-_]?key|token|secret|password|passwd)$/i;
const REDACTED = "<redacted>";
const HAN = /\p{Script=Han}/u;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value) {
  const n = Number(value);
  return value !== null && value !== "" && Number.isFinite(n) ? n : null;
}

function unwrap(entry) {
  if (isObject(entry) && Object.hasOwn(entry, "value") && typeof entry.source === "string") return entry.value;
  return entry;
}

/** Plan values as { value, source } only: a `reason` next to them is the plan's own text, not part of the value. */
function slim(values) {
  const out = {};
  for (const [id, entry] of Object.entries(isObject(values) ? values : {})) {
    out[id] = isObject(entry) && Object.hasOwn(entry, "value") ? { value: entry.value, source: typeof entry.source === "string" ? entry.source : "user" } : entry;
  }
  return out;
}

function show(value) {
  const plain = unwrap(value);
  if (plain === undefined || plain === null) return "";
  return typeof plain === "string" ? plain : JSON.stringify(plain);
}

// ---------------------------------------------------------------------------
// Bilingual text

/**
 * The part of a text in `locale`. A {zh,en} object is picked; a plain string
 * of the form "中文 / English" (the shape 01 gives plan reasons) is split when
 * the halves are in different scripts; any other string stays as it is.
 */
export function localizedText(value, locale = "en-US") {
  const short = String(locale).startsWith("zh") ? "zh" : "en";
  if (isObject(value)) return text(value[locale]) || text(value[short]) || text(value.en) || text(value.zh);
  if (typeof value !== "string") return "";
  const at = value.indexOf(" / ");
  if (at > 0) {
    const first = value.slice(0, at).trim();
    const rest = value.slice(at + 3).trim();
    if (HAN.test(first) && !HAN.test(rest)) return short === "zh" ? first : rest;
  }
  return value.trim();
}

// ---------------------------------------------------------------------------
// Image step and launch gate

/** The pull step of a plan (00 §9.2), or null. */
export function pullStepOf(plan) {
  return list(plan?.steps).find((step) => isObject(step) && step.kind === "pull") || null;
}

/**
 * What to say about the image: { state: none|present|auto|explicit|local-build, image, runtimeId, policy, required }.
 * `explicit` carries the `image_pull_required` blocker (an experimental image is never pulled by a launch).
 */
export function imageStepOf(plan) {
  const step = pullStepOf(plan);
  const codes = list(plan?.blockers).map((blocker) => text(blocker?.code));
  const image = text(step?.image) || text(plan?.runtime?.image);
  const runtimeId = text(step?.runtimeId) || text(plan?.runtime?.runtimeId) || text(plan?.runtime?.id);
  const policy = step?.policy === "explicit" ? "explicit" : "auto";
  const required = step ? step.required !== false : false;
  let state = "none";
  if (codes.includes("runtime_local_build_missing")) state = "local-build";
  else if (codes.includes("image_pull_required") || (step && required && policy === "explicit")) state = "explicit";
  else if (step && required) state = "auto";
  else if (step) state = "present";
  return { state, image, runtimeId, policy, required };
}

/**
 * Whether Launch is allowed, and why not: reasons are { kind, count? } for
 * the page to word. A plan problem, an image still to pull and a `block`
 * verdict all stop it; so does a plan that is only a preview (prospective), a
 * plan that is being refreshed, and no plan at all.
 */
export function launchGate(plan, { updating = false, running = false } = {}) {
  const reasons = [];
  if (!isObject(plan)) {
    reasons.push({ kind: "no-plan" });
    return { allowed: false, reasons };
  }
  const errors = list(plan.errors).length;
  const blockers = list(plan.blockers).length;
  if (errors) reasons.push({ kind: "errors", count: errors });
  if (blockers) reasons.push({ kind: "blockers", count: blockers });
  if (plan.admission?.verdict === "block") reasons.push({ kind: "admission" });
  if (plan.prospective === true) reasons.push({ kind: "prospective" });
  if (plan.ok === false && !errors && !blockers) reasons.push({ kind: "not-ok" });
  if (updating) reasons.push({ kind: "updating" });
  if (running) reasons.push({ kind: "running" });
  return { allowed: reasons.length === 0, reasons };
}

/** The running step that replaces a model (plan.steps[] kind replace), else the draft's target in the instance rows. */
export function replaceTargetOf(plan, draft, rows = []) {
  const step = list(plan?.steps).find((item) => isObject(item) && item.kind === "replace");
  if (step) return { instance: text(step.containerName) || text(draft?.instance?.targetInstanceId), model: text(step.model) };
  if (draft?.instance?.mode !== "replace") return null;
  const row = list(rows).find((item) => item && item.instanceId === draft.instance.targetInstanceId);
  return row ? { instance: row.instanceId, model: text(row.model) } : null;
}

// ---------------------------------------------------------------------------
// Command preview

function secretName(name) {
  return SECRET_NAME.test(String(name || ""));
}

/** A token with the value of a secret-looking `NAME=value` or the value after a secret-looking flag hidden. */
export function redactToken(token, previous = "") {
  const value = String(token ?? "");
  const pair = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(value);
  if (pair && secretName(pair[1]) && pair[2] !== REDACTED) return `${pair[1]}=${REDACTED}`;
  const flag = /^(--[A-Za-z0-9][A-Za-z0-9_.-]*)=([\s\S]*)$/.exec(value);
  if (flag && secretName(flag[1].replace(/^-+/, "")) && flag[2] !== REDACTED) return `${flag[1]}=${REDACTED}`;
  if (/^--[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(String(previous)) && secretName(String(previous).replace(/^-+/, "")) && value !== REDACTED && !value.startsWith("-")) return REDACTED;
  return value;
}

/**
 * The plan's command for CommandPreview: one line per argv token (a second
 * redaction on top of the server's), custom extra args marked, and the env as
 * name/value rows. -> { lines: [{ text, custom, redacted }], env: [{ name, value, redacted }], labels, empty }
 */
export function commandView(command, { extraArgs = [] } = {}) {
  const argv = list(command?.argv).map(String);
  const custom = new Set(list(extraArgs).map(String));
  const lines = argv.map((token, index) => {
    const shown = redactToken(token, argv[index - 1] || "");
    return { text: shown, custom: custom.has(token), redacted: shown.includes(REDACTED) };
  });
  const env = isObject(command?.env) ? Object.entries(command.env).map(([name, raw]) => {
    const hide = secretName(name) && String(raw) !== REDACTED;
    const value = hide ? REDACTED : String(raw ?? "");
    return { name, value, redacted: value === REDACTED };
  }) : [];
  const labels = isObject(command?.labels) ? Object.entries(command.labels).map(([name, value]) => ({ name, value: String(value ?? "") })) : [];
  return { lines, env, labels, empty: lines.length === 0 };
}

// ---------------------------------------------------------------------------
// Values, overrides and diffs

/** Effective values by param id: the plan's, then what the draft sets explicitly. */
export function effectiveValues(plan, draft) {
  const out = {};
  for (const [id, entry] of Object.entries(isObject(plan?.values) ? plan.values : {})) out[id] = entry;
  for (const [id, entry] of Object.entries(isObject(draft?.values) ? draft.values : {})) {
    if (entry !== null && entry !== undefined && entry !== "" && !secretName(id)) out[id] = entry;
  }
  return out;
}

function labelOf(catalog, id, locale) {
  const param = list(catalog?.params).find((item) => item?.id === id);
  return localizedText(param?.label, locale) || id;
}

/**
 * `plan.overrides[]` as DiffTable rows with reasons (07 §6.3 step 6):
 * { id, label, from, to, source, reason }. An override that changes nothing is dropped.
 */
export function overrideRows(plan, catalog, locale = "en-US") {
  return list(plan?.overrides).filter(isObject).map((item) => ({
    id: text(item.param),
    label: labelOf(catalog, text(item.param), locale),
    from: show(item.from),
    to: show(item.to),
    source: text(item.source),
    reason: localizedText(item.reason, locale),
  })).filter((row) => row.id && row.from !== row.to);
}

/** What changed between two plans of the same draft: DiffTable rows over their effective values. */
export function planChangeRows(before, after, catalog, locale = "en-US") {
  return diffValues(slim(before?.values), slim(after?.values), catalog, { locale });
}

/** The rows an override list of a start answer shows (`plan.overrides`, no values). */
export function startOverrideRows(start, catalog, locale = "en-US") {
  return overrideRows({ overrides: list(start?.plan?.overrides ?? start?.overrides) }, catalog, locale);
}

/** The difference an applied suggestion makes: DiffTable rows from the current effective value to the new one. */
export function suggestionRows(draft, plan, suggestion, catalog, locale = "en-US") {
  const param = text(suggestion?.param);
  if (!param) return [];
  const before = slim(effectiveValues(plan, draft));
  const after = { ...before, [param]: suggestion.value };
  return diffValues(before, after, catalog, { locale });
}

const DONE_STATES = new Set(["running", "stopped", "sleeping", "ready"]);

/**
 * The launch to compare with: the newest stored launch of the same model that
 * reached a working state (01 §15 LaunchStore records, newest first as served).
 */
export function lastLaunchOf(launches, modelPath) {
  const path = text(modelPath);
  return list(launches).filter(isObject).find((record) => {
    const ref = text(record.spec?.model?.ref);
    return ref && ref === path && !record.partial && DONE_STATES.has(String(record.status || "ready"));
  }) || null;
}

/** DiffTable rows of the draft's plan against a stored launch (effective values on both sides). */
export function lastLaunchRows(record, plan, catalog, locale = "en-US") {
  if (!isObject(record)) return [];
  const before = isObject(record.resolved?.values) ? record.resolved.values : isObject(record.spec?.values) ? record.spec.values : {};
  return diffValues(slim(before), slim(plan?.values), catalog, { locale });
}

// ---------------------------------------------------------------------------
// Start request and answer

/** The new plan in a 409 `plan_changed` answer ({ok:false, code, error, plan}); null when the error is something else. */
export function planChangedOf(error) {
  if (error?.code !== "plan_changed") return null;
  return isObject(error.details?.plan) ? error.details.plan : {};
}

/** The Apply chips of an admission failure: `details.knobs` of an error or a job failure, { param, suggestion }. */
export function knobsOf(...sources) {
  for (const source of sources) {
    const knobs = isObject(source) ? source.details?.knobs ?? source.knobs : null;
    const found = list(knobs).filter((knob) => isObject(knob) && text(knob.param) && knob.suggestion !== undefined && knob.suggestion !== null);
    if (found.length) return found.map((knob) => ({ param: text(knob.param), suggestion: knob.suggestion }));
  }
  return [];
}

/**
 * The answer of POST /api/m/:id/start (01 §21.1): the job to follow, the
 * launch id and whether the manager launched a plan other than the reviewed
 * one. Before ENG-2 a manager does not refuse a changed plan; it only returns
 * the hash it used, so a differing hash is shown as a non-blocking notice.
 */
export function startOutcome(body, reviewedHash = "") {
  const job = isObject(body?.job) ? body.job : null;
  const jobId = text(job?.id) || text(body?.jobId);
  const launched = isObject(body?.plan) ? body.plan : {};
  const hash = text(launched.planHash);
  const reviewed = text(reviewedHash);
  return {
    jobId,
    launchId: text(body?.launchId),
    instanceId: text(body?.instanceId) || text(job?.meta?.instanceId),
    planHash: hash,
    changedAtLaunch: Boolean(hash && reviewed && hash !== reviewed),
    overrides: list(launched.overrides),
    warnings: list(launched.warnings),
  };
}

// ---------------------------------------------------------------------------
// Job: phases, failure, signatures

function phaseOf(job) {
  const phase = text(job?.lifecycle?.phase) || text(job?.progress?.phase);
  return LAUNCH_PHASES.includes(phase) ? phase : "";
}

/** { state: running|success|failed, ... } of a manager job (statuses of manager-core/job-utils.js). */
export function jobState(job) {
  const raw = String(job?.status ?? job?.state ?? "").toLowerCase();
  if (["success", "succeeded", "completed", "done"].includes(raw)) return "success";
  if (["failed", "error", "interrupted", "cancelled", "canceled"].includes(raw)) return "failed";
  return "running";
}

/**
 * The 00 §4.1 phases of a launch job as Stepper steps (ids only; the page words
 * them): { id, state: pending|active|done|error|skipped, durationMs|null }.
 * `pull` is skipped when the plan's pull step found the image present.
 */
export function jobPhases(job, { pullStep = null, failedPhase = "" } = {}) {
  const state = jobState(job);
  const history = list(job?.lifecycle?.phaseHistory).filter(isObject);
  const duration = (phase) => {
    const entry = [...history].reverse().find((item) => item.phase === phase);
    return entry && entry.durationMs !== null && Number.isFinite(Number(entry.durationMs)) ? Number(entry.durationMs) : null;
  };
  const ran = (phase) => history.some((item) => item.phase === phase);
  const current = phaseOf(job);
  const failed = state === "failed" ? text(failedPhase) || current : "";
  const at = LAUNCH_PHASES.indexOf(state === "failed" ? failed || current : current);
  const imagePresent = Boolean(pullStep) && pullStep.required === false;
  return LAUNCH_PHASES.map((id, index) => {
    let phaseState;
    if (state === "success") phaseState = "done";
    else if (at < 0) phaseState = state === "failed" ? "pending" : index === 0 ? "active" : "pending";
    else if (index < at) phaseState = "done";
    else if (index === at) phaseState = state === "failed" ? "error" : "active";
    else phaseState = "pending";
    if (id === "pull" && imagePresent && !ran("pull") && phaseState !== "error") phaseState = "skipped";
    return { id, state: phaseState, durationMs: duration(id) };
  });
}

/** What the live detail line shows: a known stageKey names a phase, anything else shows the server's stageText. */
export function stageDetail(job) {
  const progress = isObject(job?.progress) ? job.progress : {};
  const key = text(progress.stageKey);
  if (LAUNCH_PHASES.includes(key)) return { phaseKey: key, text: null };
  const stageText = progress.stageText ?? progress.stage ?? progress.detail;
  return { phaseKey: null, text: stageText === undefined ? null : stageText };
}

/**
 * The 00 §9.11 error of a failed job: { code, signatureId, phase, hint, logExcerpt, title?, explanation?, suggestions }.
 * A job from before the supervisor (only a legacy `error` string) yields a minimal object; a job that did not fail yields null.
 */
export function jobFailure(job) {
  if (!isObject(job)) return null;
  const failure = isObject(job.failure) ? job.failure : null;
  if (!failure && jobState(job) !== "failed") return null;
  const message = typeof job.error === "string" ? job.error : text(job.error?.message);
  return {
    code: text(failure?.code) || text(job.meta?.errorCode) || "start_failed",
    signatureId: text(failure?.signatureId) || null,
    phase: text(failure?.phase) || phaseOf(job) || null,
    hint: failure?.hint ?? null,
    logExcerpt: typeof failure?.logExcerpt === "string" ? failure.logExcerpt : "",
    title: failure?.title ?? null,
    explanation: failure?.explanation ?? null,
    exceptionType: text(failure?.exceptionType) || null,
    suggestions: list(failure?.suggestions),
    message,
  };
}

/** The signature map of GET /api/knowledge?kind=error-signatures: id → entry. */
export function signatureMap(body) {
  const map = new Map();
  for (const entry of list(body?.entries)) if (isObject(entry) && text(entry.id)) map.set(text(entry.id), entry);
  return map;
}

/** Suggestions (02 §8.4) kept to the kinds the console acts on: param, probe, runtime. */
export function normalizeSuggestions(raw) {
  const out = [];
  for (const item of list(raw)) {
    if (!isObject(item)) continue;
    if (item.kind === "param" && text(item.param)) out.push({ kind: "param", param: text(item.param), to: item.to, security: item.security === true });
    else if (item.kind === "probe") out.push({ kind: "probe" });
    else if (item.kind === "runtime") out.push({ kind: "runtime", action: text(item.action) });
  }
  return out;
}

/** Unresolved `{1}` capture placeholders of a signature title (the error's own title is already filled in). */
function fillTitle(value) {
  return typeof value === "string" ? value.replace(/\{\d+\}/g, "…") : value;
}

/**
 * What the RootCausePanel shows (07 §4.4): `title` and `suggestions` come from
 * the error when present, else from the signature looked up by `signatureId`.
 */
export function failureView(error, signature = null, locale = "en-US") {
  const source = isObject(error) ? error : {};
  const sig = isObject(signature) ? signature : {};
  const fromError = Array.isArray(source.suggestions) && source.suggestions.length;
  const title = source.title ?? (sig.title ? (isObject(sig.title) ? { zh: fillTitle(sig.title.zh), en: fillTitle(sig.title.en) } : fillTitle(sig.title)) : null);
  return {
    code: text(source.code),
    signatureId: text(source.signatureId) || text(sig.id) || null,
    phase: text(source.phase) || text(sig.phase) || null,
    title: localizedText(title, locale),
    hint: localizedText(source.hint ?? sig.hint, locale),
    explanation: localizedText(source.explanation ?? sig.explanation, locale),
    logExcerpt: typeof source.logExcerpt === "string" ? source.logExcerpt : "",
    suggestions: normalizeSuggestions(fromError ? source.suggestions : sig.suggestions),
    message: text(source.message),
  };
}

// ---------------------------------------------------------------------------
// Stored launch

/** The launch this tab started, as stored: { draftId, managerId, jobId, launchId, instanceId, planHash, pull }. */
export function serializeLaunch(launch) {
  return JSON.stringify({
    v: 1,
    draftId: text(launch?.draftId),
    managerId: text(launch?.managerId),
    jobId: text(launch?.jobId),
    launchId: text(launch?.launchId),
    instanceId: text(launch?.instanceId),
    planHash: text(launch?.planHash),
    pull: isObject(launch?.pull) ? { required: launch.pull.required !== false, policy: launch.pull.policy === "explicit" ? "explicit" : "auto", image: text(launch.pull.image) } : null,
    changedAtLaunch: launch?.changedAtLaunch === true,
  });
}

export function parseLaunch(textValue, draftId = "") {
  if (typeof textValue !== "string" || !textValue) return null;
  try {
    const raw = JSON.parse(textValue);
    if (!isObject(raw) || raw.v !== 1 || !text(raw.jobId) || !text(raw.managerId)) return null;
    if (draftId && raw.draftId !== draftId) return null;
    return {
      draftId: text(raw.draftId),
      managerId: text(raw.managerId),
      jobId: text(raw.jobId),
      launchId: text(raw.launchId),
      instanceId: text(raw.instanceId),
      planHash: text(raw.planHash),
      pull: isObject(raw.pull) ? raw.pull : null,
      changedAtLaunch: raw.changedAtLaunch === true,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Success actions and profile

/** The deployment's fleet id (00 §3): `<managerId>:<instanceId>`; the primary slot when the launch named none. */
export function fleetIdOf(managerId, instanceId) {
  return `${managerId}:${instanceId || "primary"}`;
}

/** Links of a launch that reached ready (07 §6.3 step 7). */
export function successLinks({ managerId, instanceId, servedName, modelName }) {
  const fleetId = fleetIdOf(managerId, instanceId);
  const model = text(servedName) || text(modelName);
  return {
    fleetId,
    playground: model ? `/playground?model=${encodeURIComponent(model)}` : "/playground",
    deployment: `/deployments/${encodeURIComponent(fleetId)}`,
    qualify: `/deployments/${encodeURIComponent(fleetId)}?qualify=1`,
  };
}

/** The runtime tab of an engine (a `runtime` suggestion). */
export function runtimesHref(engineId) {
  return `/engines/${encodeURIComponent(engineId)}?tab=runtimes`;
}

/**
 * The body of POST /api/m/:id/tools/profiles (07 §6.3 step 6): the sparse
 * values the user set, never a secret, with the catalog version they were made
 * against, from the current engine's schema catalog. `config` keeps the entry
 * readable by managers that only know the flat shape.
 */
export function profileBody(draft, catalog, name, { description = "" } = {}) {
  const values = {};
  for (const [id, raw] of Object.entries(isObject(draft?.values) ? draft.values : {})) {
    const value = unwrap(raw);
    if (value === undefined || value === null || value === "" || secretName(id)) continue;
    values[id] = value;
  }
  const model = draft?.modelRef?.kind === "local" ? text(draft.modelRef.path) : "";
  const engineId = text(draft?.engineId);
  return {
    name: text(name),
    description: text(description),
    schemaVersion: 2,
    engineId,
    ...(text(draft?.recipeId) ? { recipeId: text(draft.recipeId) } : {}),
    values,
    // Queries may retain the previous engine's catalog while the next one loads.
    catalogVersion: engineId && text(catalog?.engineId) === engineId ? text(catalog?.catalogVersion) : "",
    config: {
      model,
      engine: draft?.engineId === "llamacpp" ? "llama.cpp" : text(draft?.engineId),
      name: text(draft?.instance?.servedName),
      ...(finite(draft?.instance?.port) !== null ? { port: finite(draft.instance.port) } : {}),
    },
  };
}
