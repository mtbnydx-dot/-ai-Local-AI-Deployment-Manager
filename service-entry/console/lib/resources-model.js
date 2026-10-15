// Resources model (07 §6.3 step 3): the pure half of the wizard's Resources
// step. Nothing here touches the DOM, so Node tests pin it. The step draws it
// (routes/deploy-wizard/step-resources.js and its resources-*.js parts).
//
//   hostGpus(host)               the GPUs of the compatibility answer
//   admissionOf(plan)            the plan's admission verdict row
//   fitOf(memory, gpus)          LaunchPlan.memory as a FitBar input
//   gpuSegments(memory, gpuId)   one GPU's GpuMemoryBar segments
//   currentValues(plan, draft)   the values a plan's diff starts from
//   planValues(plan)             a recommended plan's values, by catalog id, as the planner's
//   planDraft(draft, plan, ...)  the draft with a plan applied (provenance `planner`)
//   engineRows(draft, plan, ..)  the engine / recipe rows of the diff
//   recommendBody(...)           the POST /api/launch/recommend body

import { GOALS, patchDraft } from "./wizard-state.js";

const ENGINE_NAMESPACES = Object.freeze(["vllm", "sglang", "llamacpp"]);
const SEGMENT_ORDER = Object.freeze(["weights", "kv", "activations", "draft", "mmproj", "overhead"]);
const VERDICTS = Object.freeze({
  ok: { status: "ok", key: "models.fit.verdict.ok" },
  warn: { status: "warn", key: "models.fit.verdict.warn" },
  block: { status: "error", key: "models.fit.verdict.block" },
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The host's GPUs from the compatibility answer: [{ id, name, totalMb, freeMb, usedMb }]. */
export function hostGpus(host) {
  return list(host?.gpus).filter((gpu) => isObject(gpu) && gpu.id !== undefined && gpu.id !== null).slice(0, 16).map((gpu) => ({
    id: String(gpu.id),
    name: typeof gpu.name === "string" ? gpu.name : "",
    totalMb: finite(gpu.totalMb),
    freeMb: finite(gpu.freeMb),
    usedMb: finite(gpu.usedMb),
  }));
}

/** The admission verdict row of a plan: { verdict, status, key, message }, or null without an admission. */
export function admissionOf(plan) {
  const admission = plan?.admission;
  if (!isObject(admission) || !Object.hasOwn(VERDICTS, admission.verdict)) return null;
  return { verdict: admission.verdict, ...VERDICTS[admission.verdict], message: typeof admission.message === "string" ? admission.message : "" };
}

/**
 * The plan's memory as a FitBar input. LaunchPlan.memory has no headroom of its
 * own; when it carries neither `headroomMb` nor `budgetMb`, the budget of each
 * GPU it uses is what is free on that GPU now.
 */
export function fitOf(memory, gpus = []) {
  if (!isObject(memory) || !isObject(memory.breakdown)) return null;
  if (finite(memory.headroomMb) !== null || memory.budgetMb !== undefined) return memory;
  const budgetMb = {};
  for (const id of Object.keys(isObject(memory.perGpuMb) ? memory.perGpuMb : {})) {
    const gpu = gpus.find((item) => item.id === id);
    if (gpu && gpu.freeMb !== null) budgetMb[id] = gpu.freeMb;
  }
  return Object.keys(budgetMb).length ? { ...memory, budgetMb } : memory;
}

/** One GPU's segments for the GpuMemoryBar: the plan's breakdown scaled to that GPU's share of the per-GPU memory. */
export function gpuSegments(memory, gpuId) {
  const breakdown = isObject(memory?.breakdown) ? memory.breakdown : {};
  const per = isObject(memory?.perGpuMb) ? memory.perGpuMb : {};
  const ids = Object.keys(per);
  const total = ids.reduce((sum, id) => sum + (finite(per[id]) || 0), 0);
  const mine = finite(per[gpuId]);
  const share = total > 0 && mine !== null ? mine / total : 1 / Math.max(1, ids.length);
  return SEGMENT_ORDER.map((kind) => ({ kind, mb: Math.round((finite(breakdown[kind]) || 0) * share) })).filter((segment) => segment.mb > 0);
}

/** The effective values the diff starts from: the plan's values under the draft's explicit ones. */
export function currentValues(plan, draft) {
  const out = {};
  for (const [id, entry] of Object.entries(isObject(plan?.values) ? plan.values : {})) {
    const value = isObject(entry) && Object.hasOwn(entry, "value") ? entry.value : entry;
    out[id] = { value, source: isObject(entry) && typeof entry.source === "string" ? entry.source : "engine-default" };
  }
  return { ...out, ...draft.values };
}

/**
 * A recommended plan's values as the wizard stores an applied plan:
 * { catalogId: { value, source: "planner" } }. Ids and values are untouched;
 * the planner's `reason` is dropped here (the card shows it), because a stored
 * value must be exactly { value, source } for the launch request to read it.
 */
export function planValues(plan) {
  const out = {};
  if (!isObject(plan?.values)) return out;
  for (const [id, entry] of Object.entries(plan.values)) {
    const value = isObject(entry) && Object.hasOwn(entry, "value") ? entry.value : entry;
    if (value === undefined) continue;
    out[id] = { value, source: "planner" };
  }
  return out;
}

/** The values left after an engine change: ids of another engine's namespace are dropped, the rest stay. */
export function carriedValues(values, engineId) {
  const out = {};
  for (const [id, value] of Object.entries(values)) {
    const dot = id.indexOf(".");
    const namespace = dot > 0 ? id.slice(0, dot) : "";
    if (ENGINE_NAMESPACES.includes(namespace) && namespace !== engineId) continue;
    out[id] = value;
  }
  return out;
}

/**
 * The draft with a planner plan applied: its GPU set, engine, runtime and
 * recipe, and its values by catalog id under the `planner` provenance. A plan
 * of another engine drops the old engine's own settings. Nothing in here
 * renames an id. `managerId` is the manager of the plan's engine and
 * `experimental` whether that engine needs the experimental acknowledgement.
 */
export function planDraft(draft, plan, { managerId = "", experimental = false } = {}) {
  const changed = plan.engineId !== draft.engineId;
  const base = changed ? carriedValues(draft.values, plan.engineId) : draft.values;
  const rest = draft.acknowledge.filter((item) => item !== "experimental-engine");
  return patchDraft({ ...draft, values: { ...base, ...planValues(plan) } }, {
    goal: GOALS.includes(plan.goal) ? plan.goal : draft.goal,
    gpus: list(plan.gpuIds).length ? list(plan.gpuIds).map(String) : draft.gpus,
    engineId: plan.engineId,
    managerId: changed ? managerId || draft.managerId : draft.managerId,
    runtimeId: plan.runtimeId || (changed ? "" : draft.runtimeId),
    recipeId: plan.recipeId || "",
    acknowledge: experimental ? [...rest, "experimental-engine"] : rest,
  });
}

/** The engine and recipe rows a plan changes, ahead of its value rows in the DiffTable. */
export function engineRows(draft, plan, labels) {
  const rows = [];
  const from = draft.runtimeId || draft.engineId || "";
  const to = plan.runtimeId || plan.engineId || "";
  if (plan.engineId !== draft.engineId || (plan.runtimeId && plan.runtimeId !== draft.runtimeId)) rows.push({ id: "engine", label: labels.engine, from, to });
  if ((plan.recipeId || "") !== (draft.recipeId || "")) rows.push({ id: "recipe", label: labels.recipe, from: draft.recipeId || "", to: plan.recipeId || "" });
  return rows;
}

/** The body of POST /api/launch/recommend; without a chosen GPU the planner takes its default sets. */
export function recommendBody(cardId, goal, gpus) {
  return { cardId, goal, ...(gpus.length ? { gpuSets: [[...gpus]] } : {}) };
}

/** Whether an error says the endpoint is not served here (404 route, 405, 501). */
export function missingEndpoint(error) {
  return error?.status === 404 || error?.status === 405 || error?.status === 501 || error?.code === "endpoint_unavailable" || error?.code === "feature_unavailable";
}
