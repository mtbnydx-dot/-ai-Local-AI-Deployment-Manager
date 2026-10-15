// The Engines pages' model (07 §6.5, CON-16): pure functions over the 01 §21
// payloads, so the card list, the runtime actions, the flag diff, the custom
// engine builder and the external endpoint forms are unit-tested without a DOM.
//
// Nothing here fetches. The route modules (routes/engines/*) own the requests;
// this file owns what a response means and which body a form sends.

import { check } from "./guards.js";
import { EngineDescriptorGuard } from "./schemas.js";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);

// ---------------------------------------------------------------------------
// Engine cards

const TIER1_ADAPTERS = Object.freeze(["vllm", "sglang", "llamacpp"]);

/**
 * "builtin" | "experimental" | "custom" | "external" (07 §6.5). Tier 1 is the
 * three built-in adapters, tier 3 is a descriptor the owner wrote (the builder
 * emits it), the shipped docker-template descriptors are tier 2.
 */
export function engineTier(engine) {
  if (engine?.adapter === "external" || engine?.engineId === "external") return "external";
  if (engine?.tier === 1 || (engine?.tier === undefined && TIER1_ADAPTERS.includes(engine?.adapter))) return "builtin";
  if (engine?.tier === 3) return "custom";
  return "experimental";
}

/**
 * The aggregate `GET /api/engines` (01 §21.2) as the page needs it: the engine
 * records (each with its managerId), the managers that did not answer, the
 * descriptor problems and the external endpoints.
 */
export function summarizeEngines(body) {
  const engines = list(body?.engines).filter(isObject).map((engine) => ({ ...engine, managerId: String(engine.managerId || "") }));
  const offline = new Map();
  for (const item of list(body?.managers)) {
    if (isObject(item) && item.ok === false && item.managerId) offline.set(String(item.managerId), String(item.code || "manager_unreachable"));
  }
  const problems = [];
  for (const item of list(body?.errors).filter(isObject)) {
    if (item.source === "manager" && item.managerId) {
      if (!offline.has(String(item.managerId))) offline.set(String(item.managerId), String(item.code || "manager_unreachable"));
    } else {
      problems.push({
        managerId: String(item.managerId || ""),
        engineId: String(item.engineId || ""),
        source: String(item.source || ""),
        path: String(item.path || ""),
        code: String(item.code || "invalid"),
        message: String(item.message || ""),
      });
    }
  }
  return {
    engines,
    offline: [...offline].map(([managerId, code]) => ({ managerId, code })),
    problems,
    endpoints: list(body?.external?.endpoints).filter(isObject),
  };
}

const CAPABILITY_FLAGS = Object.freeze([
  "tensorParallel", "pipelineParallel", "dataParallel", "expertParallel", "parallelInstances", "lora", "multiModel", "hotLoad", "sleepWake",
]);

/** The capability chips of a card: ids under `engines.page.cap.`, in a stable order. */
export function capabilityChips(engine) {
  const capabilities = isObject(engine?.capabilities) ? engine.capabilities : {};
  const chips = CAPABILITY_FLAGS.filter((id) => capabilities[id] === true);
  if (list(capabilities.speculative).length) chips.push("speculative");
  const parsers = isObject(capabilities.autoParsers) ? capabilities.autoParsers : {};
  if (parsers.tool) chips.push("toolParser");
  if (parsers.reasoning) chips.push("reasoningParser");
  for (const role of list(capabilities.roles)) if (role === "embedding" || role === "rerank") chips.push(`role-${role}`);
  return chips;
}

/** "ok" | "error" | "unknown": the card's health from the host check (null = Docker did not answer in time). */
export function engineHealth(engine) {
  const ready = engine?.health?.hostReady;
  if (ready === true) return "ok";
  if (ready === false) return "error";
  return "unknown";
}

export function defaultRuntime(engine) {
  const runtimes = list(engine?.runtimes);
  return runtimes.find((runtime) => runtime?.default) || runtimes[0] || null;
}

// ---------------------------------------------------------------------------
// Runtimes

/** "present" | "missing" | "unknown" (`present` is null while Docker is down). */
export function runtimeState(runtime) {
  if (runtime?.present === true) return "present";
  if (runtime?.present === false) return "missing";
  return "unknown";
}

/** Pull is offered for a missing registry image; a local build is rebuilt, never pulled (01 §21.1 `runtime_local_build`). */
export function pullAllowed(runtime) {
  return runtime?.present === false && !runtime.localBuild;
}

export function dockerPullCommand(runtime) {
  return runtime?.image ? `docker pull ${runtime.image}` : "";
}

/** Introspection runs a short-lived container from a local image, so the image must be present. */
export function introspectAllowed(runtime) {
  return runtime?.present !== false;
}

// ---------------------------------------------------------------------------
// Jobs (introspect, image-pull)

const JOB_OK = new Set(["success", "succeeded", "completed", "done"]);
const JOB_BAD = new Set(["failed", "error", "interrupted", "cancelled", "canceled"]);

export function findJob(jobs, id) {
  if (!id) return null;
  const rows = Array.isArray(jobs) ? jobs : list(jobs?.jobs);
  return rows.find((job) => isObject(job) && String(job.id) === String(id)) || null;
}

/**
 * One manager job for display: { id, type, state: running|paused|success|failed,
 * done, percent|null, stage, error, code }. `stage` and `error` are backend text.
 */
export function jobView(job) {
  if (!isObject(job)) return null;
  const raw = String(job.state ?? job.status ?? "").toLowerCase();
  const state = JOB_OK.has(raw) ? "success" : JOB_BAD.has(raw) ? "failed" : raw === "paused" ? "paused" : "running";
  const progress = isObject(job.progress) ? job.progress : {};
  const percent = progress.percent === null || progress.percent === undefined || !Number.isFinite(Number(progress.percent))
    ? null
    : Math.max(0, Math.min(100, Number(progress.percent)));
  const failure = isObject(job.failure) ? job.failure : {};
  const errorObject = isObject(job.error) ? job.error : {};
  const error = typeof job.error === "string" ? job.error : String(errorObject.message || failure.message || "");
  return {
    id: String(job.id),
    type: String(job.type || ""),
    state,
    done: state === "success" || state === "failed",
    percent,
    stage: String(progress.stage || progress.detail || ""),
    error: state === "failed" ? error : "",
    code: String(job.meta?.errorCode || failure.code || errorObject.code || ""),
  };
}

// ---------------------------------------------------------------------------
// Flag diff (01 §17 `diffFlagSets`)

const flagText = (value) => (value === null || value === undefined || value === "" ? "" : typeof value === "string" ? value : JSON.stringify(value));

/**
 * The report as table rows. `added` and `removed` are flags only in the viewed
 * or only in the compared runtime; `changed` covers renamed flags, choices
 * and defaults. Rows are { kind, flag, change?, ... } sorted by flag within a kind.
 */
export function flagDiffRows(diff) {
  const source = isObject(diff) ? diff : {};
  const rows = [];
  const names = (value) => list(value).map(String).sort();
  for (const flag of names(source.added)) rows.push({ kind: "added", flag });
  for (const flag of names(source.removed)) rows.push({ kind: "removed", flag });
  const changed = [];
  for (const item of list(source.renamed).filter(isObject)) {
    changed.push({ kind: "changed", change: "renamed", flag: String(item.from), to: String(item.to), evidence: item.evidence === "alias" ? "" : flagText(item.evidence) });
  }
  for (const item of list(source.choicesChanged).filter(isObject)) {
    changed.push({ kind: "changed", change: "choices", flag: String(item.flag), addedChoices: names(item.added), removedChoices: names(item.removed) });
  }
  for (const item of list(source.defaultsChanged).filter(isObject)) {
    changed.push({ kind: "changed", change: "default", flag: String(item.flag), from: flagText(item.from), to: flagText(item.to) });
  }
  changed.sort((a, b) => a.flag.localeCompare(b.flag) || a.change.localeCompare(b.change));
  rows.push(...changed);
  return {
    rows,
    counts: { added: names(source.added).length, removed: names(source.removed).length, changed: changed.length },
    catalogMissing: names(source.catalogMissing),
    catalogUnmapped: names(source.catalogUnmapped),
  };
}

/** The flags response (`{snapshot|flags, diff}`): the code serves `flags`, the spec said `snapshot`. */
export function flagsSnapshot(body) {
  const snapshot = isObject(body?.snapshot) ? body.snapshot : isObject(body?.flags) ? body.flags : null;
  return snapshot ? { capturedAt: typeof snapshot.capturedAt === "string" ? snapshot.capturedAt : null, count: list(snapshot.flags).length } : null;
}

// ---------------------------------------------------------------------------
// Recipes

export const RECIPE_STATUSES = Object.freeze(["verified", "experimental", "blocked"]);

/** Recipe rows for the Recipes tab; `reasons` are 01 §10 codes, `locks` the locked parameter ids. */
export function recipeRows(schema) {
  return list(schema?.recipes).filter(isObject).map((recipe) => ({
    id: String(recipe.id),
    label: recipe.label ?? null,
    status: RECIPE_STATUSES.includes(recipe.status) ? recipe.status : "experimental",
    eligible: recipe.eligible === true ? true : recipe.eligible === false ? false : null,
    score: Number.isFinite(recipe.score) ? recipe.score : null,
    reasons: list(recipe.reasons).map(String),
    locks: list(recipe.locks).filter(isObject).map((lock) => ({ param: String(lock.param), value: lock.value, reason: lock.reason ?? null })),
  }));
}

// ---------------------------------------------------------------------------
// Custom Docker engine builder (07 §6.5, 01 §4 and §19)

export const BUILDER_STEPS = Object.freeze(["basics", "mapping", "memory", "review"]);
export const BUILDER_MANAGERS = Object.freeze(["vllm", "llama"]);
export const BUILDER_ARTIFACT_FORMATS = Object.freeze(["safetensors", "gguf", "exl3", "awq", "gptq", "fp8", "nvfp4"]);
export const BUILDER_MEMORY_KINDS = Object.freeze(["device-fraction", "static-fraction-of-free", "free-fraction-after-weights", "weights-plus-kv", "measured"]);
/** The placeholders a template may read without a parameter catalog (01 §19.1), plus the GPUStack aliases. */
export const TEMPLATE_PLACEHOLDERS = Object.freeze([
  "model.containerPath", "model.ref", "servedName", "host.containerPort", "gpu.ids", "gpu.count", "instance.id",
]);
const PLACEHOLDER_ALIASES = Object.freeze(["model_path", "model_name", "port", "gpu_ids", "gpu_count"]);
const RESERVED_ENGINE_IDS = Object.freeze(["vllm", "sglang", "llamacpp", "external", "unknown"]);

export const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const FLAG_PATTERN = /^--?[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// A Docker image reference: [host[:port]/]path[:tag][@algorithm:hex] (the manager's own pattern, descriptor-schema.js).
const IMAGE_PATH_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const IMAGE_DOMAIN_COMPONENT = "(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])";
const IMAGE_PATTERN = new RegExp(
  `^(?:${IMAGE_DOMAIN_COMPONENT}(?:\.${IMAGE_DOMAIN_COMPONENT})*(?::\d{1,5})?/)?`
  + `${IMAGE_PATH_COMPONENT}(?:/${IMAGE_PATH_COMPONENT})*`
  + "(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?"
  + "(?:@[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9A-Fa-f]{32,})?$",
);
const PLACEHOLDER_TOKEN = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/;
const MAX_LABEL = 80;

/** Which builder step shows each field, so a review error can send the person back. */
export function fieldStep(field) {
  if (field === "args" || field.startsWith("args.") || field === "entrypoint") return "mapping";
  if (field === "memoryKind") return "memory";
  return "basics";
}

export function defaultDraft() {
  return {
    id: "",
    labelZh: "",
    labelEn: "",
    hostManager: "vllm",
    image: "",
    port: "8000",
    healthPath: "/health",
    artifactFormats: ["safetensors"],
    entrypoint: "",
    args: [
      { flag: "", value: "{{model.containerPath}}" },
      { flag: "--host", value: "0.0.0.0" },
      { flag: "--port", value: "{{host.containerPort}}" },
      { flag: "--served-model-name", value: "{{servedName}}" },
    ],
    memoryKind: "free-fraction-after-weights",
  };
}

function problem(field, code, params) {
  return params ? { field, code, params } : { field, code };
}

/**
 * Browser-side checks of the form (the same rules the manager enforces, so most
 * mistakes never reach the server). `knownIds` are the engine ids already
 * registered. -> { ok, errors: [{ field, code, params? }] }.
 */
export function validateDraft(draft, { knownIds = [] } = {}) {
  const errors = [];
  const id = String(draft?.id ?? "");
  if (!id) errors.push(problem("id", "required"));
  else if (!ENGINE_ID_PATTERN.test(id)) errors.push(problem("id", "id_pattern"));
  else if (RESERVED_ENGINE_IDS.includes(id)) errors.push(problem("id", "id_reserved"));
  else if (knownIds.includes(id)) errors.push(problem("id", "id_in_use"));

  for (const [field, value] of [["labelZh", draft?.labelZh], ["labelEn", draft?.labelEn]]) {
    const text = String(value ?? "").trim();
    if (!text) errors.push(problem(field, "required"));
    else if (text.length > MAX_LABEL) errors.push(problem(field, "too_long", { max: MAX_LABEL }));
  }
  if (!BUILDER_MANAGERS.includes(draft?.hostManager)) errors.push(problem("hostManager", "manager_invalid"));

  const image = String(draft?.image ?? "").trim();
  if (!image) errors.push(problem("image", "required"));
  else if (image.length > 512 || !IMAGE_PATTERN.test(image)) errors.push(problem("image", "image_invalid"));

  const port = String(draft?.port ?? "").trim();
  if (!port) errors.push(problem("port", "required"));
  else if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) errors.push(problem("port", "port_invalid"));

  const healthPath = String(draft?.healthPath ?? "").trim();
  if (healthPath && (!healthPath.startsWith("/") || /\s/.test(healthPath))) errors.push(problem("healthPath", "path_invalid"));

  const formats = list(draft?.artifactFormats);
  if (!formats.length || formats.some((format) => !BUILDER_ARTIFACT_FORMATS.includes(format))) errors.push(problem("artifactFormats", "formats_required"));

  const entrypoint = String(draft?.entrypoint ?? "").trim();
  if (entrypoint && /\s/.test(entrypoint)) errors.push(problem("entrypoint", "entrypoint_invalid"));

  const args = list(draft?.args);
  if (!args.length) errors.push(problem("args", "args_required"));
  args.forEach((row, index) => {
    const flag = String(row?.flag ?? "").trim();
    const value = String(row?.value ?? "").trim();
    if (flag && !FLAG_PATTERN.test(flag)) errors.push(problem(`args.${index}.flag`, "flag_invalid"));
    if (!value) {
      errors.push(problem(`args.${index}.value`, "value_required"));
      return;
    }
    if (value.includes("{{") || value.includes("}}")) {
      const match = PLACEHOLDER_TOKEN.exec(value);
      if (!match) errors.push(problem(`args.${index}.value`, "placeholder_shape"));
      else if (!TEMPLATE_PLACEHOLDERS.includes(match[1]) && !PLACEHOLDER_ALIASES.includes(match[1])) errors.push(problem(`args.${index}.value`, "placeholder_unknown", { name: `{{${match[1]}}}` }));
    } else if (flag && value.startsWith("-")) {
      errors.push(problem(`args.${index}.value`, "value_flag_like"));
    }
  });

  if (!BUILDER_MEMORY_KINDS.includes(draft?.memoryKind)) errors.push(problem("memoryKind", "kind_invalid"));
  return { ok: errors.length === 0, errors };
}

/** The descriptor the form describes (01 §4.1): a data-driven docker-template engine, experimental until the owner pins an image. */
export function buildDescriptor(draft, { today } = {}) {
  const id = String(draft?.id ?? "").trim();
  const healthPath = String(draft?.healthPath ?? "").trim();
  const entrypoint = String(draft?.entrypoint ?? "").trim();
  const args = list(draft?.args).map((row) => {
    const flag = String(row?.flag ?? "").trim();
    const value = String(row?.value ?? "").trim();
    return flag ? { flag, value } : value;
  });
  return {
    schemaVersion: 1,
    asOf: today || new Date().toISOString().slice(0, 10),
    staleAfterDays: 90,
    id,
    label: { zh: String(draft?.labelZh ?? "").trim(), en: String(draft?.labelEn ?? "").trim() },
    family: "openai-server",
    adapter: "docker-template",
    tier: 3,
    status: "experimental",
    hostManager: draft?.hostManager === "llama" ? "llama" : "vllm",
    artifactFormats: [...list(draft?.artifactFormats)],
    runtimes: { default: id, allowed: [id] },
    host: { kinds: ["docker"], default: "docker", containerPort: Number(draft?.port), gpus: "required" },
    api: {
      openaiBase: "/v1",
      models: "/v1/models",
      health: healthPath || null,
      ready: { kind: healthPath ? "health-200" : "models-list" },
    },
    apiSurface: { chat: true, completions: true, responses: false, messages: false, embeddings: false, rerank: false },
    memoryModel: { kind: String(draft?.memoryKind ?? "") },
    capabilities: {
      parallelInstances: false, tensorParallel: false, pipelineParallel: false, dataParallel: false, expertParallel: false,
      lora: false, multiModel: false, hotLoad: false, sleepWake: false,
      speculative: [], roles: ["chat"], autoParsers: { tool: null, reasoning: null },
    },
    secrets: { apiKey: { mode: "unsupported" } },
    template: { ...(entrypoint ? { entrypoint } : {}), args, env: {}, files: [], flagFormat: "space" },
  };
}

/**
 * The entry for <AI_ROOT>/config/runtime-manifest.json that gives the descriptor
 * its runtime: `runtimes.allowed` names manifest keys, never an image (01 §5).
 */
export function buildRuntimeEntry(draft) {
  const id = String(draft?.id ?? "").trim();
  return { runtimes: { [id]: { label: String(draft?.labelEn ?? "").trim(), engineId: id, image: String(draft?.image ?? "").trim(), status: "unpinned" } } };
}

/** The structural check against `EngineDescriptorGuard` (07 §6.5) as { path, code } problems. */
export function guardDescriptor(descriptor) {
  const result = check(EngineDescriptorGuard, descriptor);
  return result.ok ? [] : result.errors.map((item) => ({ field: String(item.path || ""), code: "shape", params: { path: String(item.path || ""), expected: String(item.expected || "") } }));
}

/** Browser review: the form rules, then the descriptor guard. */
export function reviewDraft(draft, options = {}) {
  const form = validateDraft(draft, options);
  if (!form.ok) return { ok: false, errors: form.errors, descriptor: null };
  const descriptor = buildDescriptor(draft, options);
  const shape = guardDescriptor(descriptor);
  return { ok: shape.length === 0, errors: shape, descriptor };
}

export function descriptorFileName(draft) {
  return `${String(draft?.id ?? "").trim() || "engine"}.json`;
}

/** The server's `errors[]` from descriptors/validate, normalised ({ path, code, message }). */
export function serverDescriptorErrors(body) {
  return list(body?.errors).filter(isObject).map((item) => ({ path: String(item.path || ""), code: String(item.code || "invalid"), message: String(item.message || "") }));
}

/** True when the failure means this manager has no validate route (the browser-only path). */
export function validateUnavailable(error) {
  const code = String(error?.code || "");
  return error?.status === 404 || code === "endpoint_unavailable" || code === "not_found";
}

// ---------------------------------------------------------------------------
// External endpoints (01 §20, §21.2)

export const EXTERNAL_KINDS = Object.freeze(["ollama", "openai", "lmstudio", "generic"]);
const ENDPOINT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const MAX_KEY_LENGTH = 4096;

/** "loopback" | "lan" | "remote" for a base URL (the manager's classifyHost, simplified). */
export function hostClassOf(baseUrl) {
  let host;
  try {
    host = new URL(String(baseUrl ?? "")).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return "remote";
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host)) return "loopback";
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
    return "remote";
  }
  if (host.includes(":")) return /^f[cd]/.test(host) ? "lan" : "remote";
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return "lan";
  return "remote";
}

export function emptyEndpointDraft() {
  return { endpointId: "", label: "", kind: "generic", baseUrl: "", apiKey: "", keyAction: "keep", enabled: true, includeInAuto: false, acknowledgePlaintext: false };
}

/** The edit form's start: the key is never part of it (a stored key is only ever replaced or removed). */
export function draftFromEndpoint(endpoint) {
  return {
    endpointId: String(endpoint?.endpointId || ""),
    label: String(endpoint?.label || ""),
    kind: EXTERNAL_KINDS.includes(endpoint?.kind) ? endpoint.kind : "generic",
    baseUrl: String(endpoint?.baseUrl || ""),
    apiKey: "",
    keyAction: "keep",
    enabled: endpoint?.enabled !== false,
    includeInAuto: endpoint?.routing?.includeInAuto === true,
    acknowledgePlaintext: false,
    hasKey: Boolean(endpoint?.apiKeyRef),
  };
}

/** Whether the form needs the plaintext acknowledgement (a remote http:// address). */
export function needsPlaintextAck(baseUrl) {
  try {
    return new URL(String(baseUrl)).protocol === "http:" && hostClassOf(baseUrl) === "remote";
  } catch {
    return false;
  }
}

/** -> { ok, errors: [{ field, code, params? }] } for `mode` "create" or "edit". */
export function validateEndpointDraft(draft, { mode = "create", existingIds = [] } = {}) {
  const errors = [];
  if (mode === "create") {
    const id = String(draft?.endpointId ?? "");
    if (!id) errors.push(problem("endpointId", "required"));
    else if (!ENDPOINT_ID_PATTERN.test(id)) errors.push(problem("endpointId", "id_pattern"));
    else if (existingIds.includes(id)) errors.push(problem("endpointId", "id_in_use"));
  }
  const label = String(draft?.label ?? "").trim();
  if (label.length > MAX_LABEL) errors.push(problem("label", "too_long", { max: MAX_LABEL }));
  if (!EXTERNAL_KINDS.includes(draft?.kind)) errors.push(problem("kind", "kind_invalid"));

  const baseUrl = String(draft?.baseUrl ?? "").trim();
  if (!baseUrl) {
    errors.push(problem("baseUrl", "required"));
  } else {
    let url = null;
    try {
      url = new URL(baseUrl);
    } catch {
      errors.push(problem("baseUrl", "url_invalid"));
    }
    if (url) {
      if (url.protocol !== "http:" && url.protocol !== "https:") errors.push(problem("baseUrl", "url_scheme"));
      else if (url.username || url.password) errors.push(problem("baseUrl", "url_credentials"));
      else if (url.search || url.hash) errors.push(problem("baseUrl", "url_extras"));
      else if (needsPlaintextAck(baseUrl) && !draft?.acknowledgePlaintext) errors.push(problem("baseUrl", "plaintext_remote"));
    }
  }
  const key = String(draft?.apiKey ?? "");
  const typing = mode === "create" ? key !== "" : draft?.keyAction === "replace";
  if (typing && (!key || key.length > MAX_KEY_LENGTH || /[\s\u0000-\u001f\u007f]/.test(key))) errors.push(problem("apiKey", "key_invalid"));
  return { ok: errors.length === 0, errors };
}

/** POST body. The key is write-only: it is in this body and nowhere else. */
export function endpointCreateBody(draft) {
  const baseUrl = String(draft.baseUrl).trim();
  const body = {
    endpointId: String(draft.endpointId).trim(),
    kind: draft.kind,
    baseUrl,
    enabled: draft.enabled !== false,
    routing: { includeInAuto: draft.includeInAuto === true },
  };
  const label = String(draft.label ?? "").trim();
  if (label) body.label = label;
  if (draft.apiKey) body.apiKey = draft.apiKey;
  if (draft.acknowledgePlaintext && /^http:/i.test(baseUrl)) body.acknowledge = ["plaintext-remote"];
  return body;
}

/** PATCH body: only what changed from `endpoint`; a typed key replaces, `null` removes the stored one. */
export function endpointPatchBody(draft, endpoint) {
  const body = {};
  const label = String(draft.label ?? "").trim();
  if (label && label !== endpoint?.label) body.label = label;
  if (draft.kind !== endpoint?.kind) body.kind = draft.kind;
  const baseUrl = String(draft.baseUrl ?? "").trim();
  if (baseUrl && baseUrl !== endpoint?.baseUrl) {
    body.baseUrl = baseUrl;
    if (draft.acknowledgePlaintext && /^http:/i.test(baseUrl)) body.acknowledge = ["plaintext-remote"];
  }
  if ((draft.enabled !== false) !== (endpoint?.enabled !== false)) body.enabled = draft.enabled !== false;
  if ((draft.includeInAuto === true) !== (endpoint?.routing?.includeInAuto === true)) body.routing = { includeInAuto: draft.includeInAuto === true };
  if (draft.keyAction === "replace" && draft.apiKey) body.apiKey = draft.apiKey;
  else if (draft.keyAction === "remove") body.apiKey = null;
  return body;
}

/** Routable: enabled, and the last health check answered. */
export function endpointRoutable(endpoint) {
  if (endpoint?.enabled === false) return { routable: false, reason: "disabled" };
  const state = endpoint?.health?.state;
  if (state === "ready") return { routable: true, reason: endpoint?.routing?.includeInAuto ? "auto" : "direct" };
  return { routable: false, reason: state === "unauthorized" ? "unauthorized" : state ? "unreachable" : "unchecked" };
}

/** "ok" | "warn" | "error" | "unknown" for the health badge. */
export function endpointHealthStatus(endpoint) {
  if (endpoint?.enabled === false) return "neutral";
  const state = endpoint?.health?.state;
  if (state === "ready") return "ok";
  if (state === "unauthorized") return "warn";
  if (state === "unreachable" || state === "error") return "error";
  return "unknown";
}

/** The `/api/engines/external/endpoints/:id/test` answer as display fields. */
export function testResultView(body) {
  const models = list(body?.models).map(String);
  return {
    ok: body?.ok === true,
    latencyMs: Number.isFinite(body?.latencyMs) ? body.latencyMs : null,
    state: String(body?.state || ""),
    models,
    errorCode: String(body?.error?.code || ""),
  };
}
