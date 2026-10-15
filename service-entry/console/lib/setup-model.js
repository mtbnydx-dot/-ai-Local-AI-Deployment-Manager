// First-run setup, the pure parts (07 §6.14, CON-25; 06 §8, §11).
//
//   normalizeSetup(raw)            GET /api/platform/setup, made safe to render
//   setupIncomplete(setup)         whether the owner still has work (completedAt unset, some step open)
//   stepPlan(step)                 the one primary action of a step: post | link | mark | commands
//   stepRequest(id, options)       the POST /api/platform/setup/:step request of a step
//   skipRequest(id) / doneRequest(id) / skipAllRequest()
//   setupHref(path)                a console path that returns to /setup (adds ?from=setup)
//   firstModelHref(entries)        /deployments/new seeded with a library model
//   imagePullJobs(jobs)            the running image-pull jobs of a manager job list
//   buildChecklist(inputs)         the pre-06 five-item checklist from /api/status, /api/fleet, the library and /api/keys
//   firstRunTarget(...)            boot step 8: "/setup" or null
//
// No DOM and no network except through the `api` passed to firstRunTarget, so
// Node tests import this module directly.

import { legacyClients } from "./access-model.js";
import { isFleetRoutableInstance } from "./readiness.js";

export const SETUP_STEP_IDS = Object.freeze(["prereq", "deps", "download-cli", "storage", "images", "tts", "exposure", "ops", "start", "first-model"]);
export const SETUP_STATUSES = Object.freeze(["todo", "done", "blocked", "skipped", "failed"]);
export const SETUP_ENGINES = Object.freeze(["vllm", "llama", "sglang"]);
export const DEFAULT_ENGINES = Object.freeze(["vllm"]);
export const SETUP_FROM = "setup";
export const SETUP_QUERY_KEY = ["platform-setup"];
export const SETUP_PATH = "/api/platform/setup";

const SETTLED = new Set(["done", "skipped"]);
// Where the hosting manager of an engine lives (06 setup.js MANAGER_OF).
const MANAGER_OF = Object.freeze({ vllm: "vllm", sglang: "vllm", llama: "llama" });

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function bilingual(value) {
  if (typeof value === "string") return { "zh-CN": value, "en-US": value };
  return isObject(value) ? { "zh-CN": text(value["zh-CN"]), "en-US": text(value["en-US"]) } : { "zh-CN": "", "en-US": "" };
}

function normalizeFix(fix) {
  if (!isObject(fix)) return null;
  return { id: text(fix.id), risk: text(fix.risk), command: text(fix.command), docs: text(fix.docs) };
}

function normalizeData(id, data) {
  if (!isObject(data)) return {};
  switch (id) {
    case "prereq":
      return { blocking: list(data.blocking).filter(isObject).map((item) => ({ id: text(item.id), detail: text(item.detail), fix: normalizeFix(item.fix) })) };
    case "storage":
      return { freeBytes: Number.isFinite(Number(data.freeBytes)) && data.freeBytes !== null ? Number(data.freeBytes) : null };
    case "images":
      return { runtimes: list(data.runtimes).filter(isObject).map((item) => ({ runtimeId: text(item.runtimeId), engineId: text(item.engineId), present: item.present === true, localBuild: item.localBuild === true })) };
    case "exposure":
      return { mode: data.mode === "lan" ? "lan" : "local", firewall: normalizeFix(data.firewall) };
    case "ops":
      return { commands: list(data.commands).filter((item) => typeof item === "string" && item) };
    default:
      return {};
  }
}

/**
 * GET /api/platform/setup → { steps: [{ id, index, title, optional, status, detail, recorded, data }], completedAt, current }.
 * A step the console does not know is kept (it reads as a plain todo); a status it does not know is a todo.
 */
export function normalizeSetup(raw) {
  const body = isObject(raw?.setup) ? raw.setup : isObject(raw) ? raw : {};
  const steps = list(body.steps).filter((step) => isObject(step) && typeof step.id === "string").map((step, index) => ({
    id: step.id,
    index: Number.isInteger(step.index) ? step.index : index + 1,
    title: bilingual(step.title),
    optional: step.optional === true,
    status: SETUP_STATUSES.includes(step.status) ? step.status : "todo",
    detail: text(step.detail),
    recorded: isObject(step.recorded) ? { state: text(step.recorded.state), at: text(step.recorded.at) } : null,
    data: normalizeData(step.id, step.data),
  }));
  const current = typeof body.current === "string" && steps.some((step) => step.id === body.current) ? body.current : (steps.find((step) => !SETTLED.has(step.status))?.id ?? null);
  return { steps, completedAt: text(body.completedAt) || null, current };
}

export function stepSettled(step) {
  return SETTLED.has(step?.status);
}

/** True while the owner has setup to do: no completedAt and at least one step neither done nor skipped. */
export function setupIncomplete(setup) {
  if (!setup || setup.completedAt) return false;
  return list(setup.steps).some((step) => !stepSettled(step));
}

/** Progress of the whole wizard: { settled, total }. */
export function setupProgress(setup) {
  const steps = list(setup?.steps);
  return { settled: steps.filter(stepSettled).length, total: steps.length };
}

/** `/path?from=setup` (keeps an existing query), so the page it opens shows the way back. */
export function setupHref(path) {
  const [base, query = ""] = String(path).split("?");
  const params = new URLSearchParams(query);
  params.set("from", SETUP_FROM);
  return `${base}?${params.toString()}`;
}

export function isFromSetup(query) {
  return query?.from === SETUP_FROM;
}

/**
 * What a step's primary button does.
 *   post      POST /api/platform/setup/:step (stepRequest) and follow the operation
 *   link      open a console page with ?from=setup
 *   mark      only record the step as done (the work happens outside the console)
 */
export function stepPlan(step) {
  const id = typeof step === "string" ? step : step?.id;
  switch (id) {
    case "storage": return { kind: "link", href: setupHref("/models/storage") };
    case "first-model": return { kind: "link", href: setupHref("/deployments/new"), seeded: true };
    case "ops": return { kind: "mark", commands: true };
    case "images": return { kind: "post", engines: true };
    case "exposure": return { kind: "post", mode: true };
    default: return { kind: "post" };
  }
}

/** The console never runs the ops commands: the step shows them. */
export function stepRunsOperation(id) {
  return stepPlan(id).kind === "post";
}

/**
 * The request of a step's POST.
 * @param options { engines?: string[], mode?: "local"|"lan" }
 */
export function stepRequest(id, options = {}) {
  const path = `${SETUP_PATH}/${encodeURIComponent(id)}`;
  if (id === "images") {
    const engines = SETUP_ENGINES.filter((engine) => list(options.engines).includes(engine));
    return { path, body: { engines: engines.length ? engines : [...DEFAULT_ENGINES] } };
  }
  if (id === "exposure") return { path, body: { mode: options.mode === "lan" ? "lan" : "local" } };
  return { path, body: {} };
}

export const skipRequest = (id) => ({ path: `${SETUP_PATH}/${encodeURIComponent(id)}`, body: { skip: true } });
export const doneRequest = (id) => ({ path: `${SETUP_PATH}/${encodeURIComponent(id)}`, body: { done: true } });
/** "Skip setup": every step still open is skipped and completedAt is set. */
export const skipAllRequest = () => ({ path: `${SETUP_PATH}/all`, body: { skip: true } });

/** Whether a failed POST is the supervisor being absent (the step cannot run, the owner starts it first). */
export function needsSupervisor(error) {
  return error?.code === "supervisor_unavailable" || error?.status === 503;
}

/** The managers whose image-pull jobs a pull of `engines` runs on. */
export function pullManagers(engines) {
  const wanted = list(engines).length ? engines : DEFAULT_ENGINES;
  return [...new Set(wanted.map((engine) => MANAGER_OF[engine]).filter(Boolean))];
}

/**
 * The image-pull jobs still running in a manager's job list, for the `images`
 * step's byte progress: [{ id, label, percent|null, bytesDone|null, bytesTotal|null }].
 */
export function imagePullJobs(jobs) {
  const rows = Array.isArray(jobs) ? jobs : list(jobs?.jobs);
  const finished = new Set(["success", "succeeded", "completed", "done", "failed", "error", "interrupted", "cancelled", "canceled"]);
  return rows.filter((job) => isObject(job) && job.type === "image-pull" && !finished.has(String(job.state ?? job.status ?? "").toLowerCase())).map((job) => {
    const progress = isObject(job.progress) ? job.progress : {};
    const percent = progress.percent === null || progress.percent === undefined || !Number.isFinite(Number(progress.percent)) ? null : Math.max(0, Math.min(100, Number(progress.percent)));
    const bytes = (value) => (Number.isFinite(Number(value)) && value !== null && value !== undefined ? Number(value) : null);
    const done = bytes(progress.bytesDone ?? progress.completedBytes);
    const total = bytes(progress.bytesTotal ?? progress.totalBytes);
    return {
      id: text(job.id),
      label: text(job.meta?.runtimeId) || text(job.meta?.image) || text(job.title) || text(job.id),
      percent,
      bytesDone: total ? done : null,
      bytesTotal: total || null,
      speedBps: bytes(progress.speedBps ?? progress.bytesPerSecond),
    };
  });
}

/**
 * A library entry to open the Deploy wizard with: the first folder with a path.
 * @returns the entry or null
 */
export function pickLibraryModel(entries) {
  return list(entries).find((entry) => isObject(entry) && entry.kind !== "file" && text(entry.path)) || null;
}

/** /deployments/new for the first model: seeded with `?model=<path>` when the library has one; the wizard runs its own balanced recommendation. */
export function firstModelHref(entries) {
  const entry = pickLibraryModel(entries);
  if (!entry) return setupHref("/deployments/new");
  const params = new URLSearchParams({ model: entry.path, from: SETUP_FROM });
  return `/deployments/new?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Before 06: the five-item checklist (07 §6.14)

export const CHECKLIST_ITEMS = Object.freeze(["docker", "gpu", "model", "serving", "key"]);
const CHECKLIST_LINK = Object.freeze({
  docker: "/engines",
  gpu: "/overview",
  model: setupHref("/models/discover"),
  serving: setupHref("/deployments/new"),
  key: setupHref("/access"),
});

/**
 * @param inputs { status, fleet, library, keys }: each answer or null when the call failed (the item then reads "unknown")
 * @returns Array<{ id, state: "ok"|"todo"|"unknown", href }>
 */
export function buildChecklist({ status = null, fleet = null, library = null, keys = null } = {}) {
  const item = (id, state) => ({ id, state, href: CHECKLIST_LINK[id] });
  const managers = list(status?.managers);
  const gpuTotal = Number(fleet?.gpuMemory?.totalMb);
  const instances = list(fleet?.instances);
  const entries = list(library?.entries);
  const clients = legacyClients(keys);
  const modernKeys = list(keys?.items);
  return [
    item("docker", !status ? "unknown" : managers.some((manager) => manager?.ok === true) ? "ok" : "todo"),
    item("gpu", !fleet ? "unknown" : Number.isFinite(gpuTotal) && gpuTotal > 0 ? "ok" : "todo"),
    item("model", !library ? "unknown" : entries.length || Number(library.total) > 0 ? "ok" : "todo"),
    item("serving", !fleet ? "unknown" : instances.some(isFleetRoutableInstance) ? "ok" : "todo"),
    item("key", !keys ? "unknown" : clients.some((client) => client.state === "active") || modernKeys.some((key) => key?.status === "active") ? "ok" : "todo"),
  ];
}

// ---------------------------------------------------------------------------
// Boot step 8

/** The pages an owner lands on at start: only there does the first-run routing apply. */
export function isLandingPath(pathname) {
  return pathname === "/" || pathname === "/overview";
}

/**
 * Boot step 8 (07 §3.2): "/setup" when the owner has setup to do, else null.
 * Reads GET /api/platform/setup through the query cache, so the page shows the
 * same answer without a second request. Any failure means "do not route".
 * @param services { api, cache, role, bootstrap, prefs }
 */
export async function firstRunTarget({ api, cache, role, bootstrap, prefs }) {
  if (role !== "owner" || !bootstrap?.features?.setup || prefs?.get?.("dismissedSetup")) return null;
  try {
    const fetchSetup = () => api.get(SETUP_PATH);
    const raw = cache ? await cache.fetch(SETUP_QUERY_KEY, fetchSetup, { ttlMs: 5000 }) : await fetchSetup();
    return setupIncomplete(normalizeSetup(raw)) ? "/setup" : null;
  } catch {
    return null;
  }
}
