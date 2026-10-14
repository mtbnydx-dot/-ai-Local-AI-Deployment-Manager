"use strict";

// resolveLaunchPlan (docs/overhaul/01-engines.md §11, 00 §4.3 and §9.2). One
// function behind POST /api/launch/plan and POST /api/start, so a plan is what
// the launch executes:
//
//   body → alias table (legacy-aliases.js) → LaunchRequestV2
//        → resolveLaunchPlan(request, ctx) → LaunchPlan
//        → requestToLegacyRunOptions(plan) → today's runStartJob options
//
// The managers keep the parts that are still theirs and hand them in through
// ctx: their launch-request normalisation (the R-* goldens pin its run
// options, job.meta and admission request), the legacy builder's
// prepareLaunch (the same adapter input runStartJob builds from those run
// options), GPU telemetry, image presence, gpu-admission evaluate() and the
// container listing. A v2 request becomes a legacy body through
// valuesToLegacyConfig, so both kinds of body run the one normalisation.
//
//   planLaunch(body, ctx)          → LaunchPlan (throws 400 only for a malformed body or unknown engine)
//   resolveLaunchPlan(request, ctx) → LaunchPlan
//   planLaunchError(plan)          → the Error a launch throws for a plan with problems
//   publicPlan(plan)               → the JSON body of a plan (secrets were never in it)
//
// ctx: { mode: "plan"|"launch", managerId, registry, paramCatalog?, recipeStore?,
//        normalize(legacyBody, { mode, calibrationFor }) → { runOptions, jobMeta, admissionRequest, extras?, memory? },
//        prepareCommand?(runOptions, { jobId, launchId }) → { adapter, plan, ctx, recipe?, preset? },
//        getHostGpus?() → gpus[] | null, imagePresence?(image) → true|false|null,
//        admissionPreview?(admissionRequest, { mode, releasedMbByGpu }) → gpu-admission evaluate() result,
//        listContainers?() → [{ name, running, labels }], platform?,
//        getIntrospection?(runtime) → { flags[] } | null, modelStorage? (resolvePath, toContainerPath),
//        calibrationFor?(card, engineId, runtimeId, paramsKey) → calibration | null }
//
// calibrationFor is 02's calibration lookup (MOD-10) and defaults to
// () => null. normalize gets it bound to this request's card, engine and
// runtime as calibrationFor(paramsKey), so the manager's memory model
// (memory-models.js, 01 §12) builds the admission request from it; memory is
// that MemoryEstimate and fills the plan's memory block.
//
// Plan mode is side-effect free: it reads files, telemetry, leases and the
// container list and never takes a lock, creates a job or touches a container.
// Launch mode skips the reads the launch does itself (the admission preview,
// the container list) and only probes the image when the pull policy is
// explicit or the runtime is a local build, so a legacy launch makes the same
// calls in the same order as before.

const crypto = require("crypto");
const expr = require("./expr");
const extraArgs = require("./extra-args");
const legacyAliases = require("./legacy-aliases");
const paramCatalog = require("./param-catalog");
const recipes = require("./recipes");
const registryModule = require("./registry");
const { normalizeManagerId, unknownEngineError } = registryModule;
const { renderRunArgs } = require("./adapters/_docker-segments");
const { REDACTED, redactSecrets } = require("../secret-redactor");

// 02 calibrationFor() until MOD-10 wires the calibration store (01 §12).
const NO_CALIBRATION = () => null;

// The job id, launch id and key reference a plan builds with (01 §11 step 7).
// Labels whose value is minted per launch stay out of planHash: the job and
// launch ids, and the admission lease, reservation and key reference that
// only exist once the launch has admitted and stored its key. A plan and the
// launch it becomes therefore hash the same unless the GPUs change.
const PLAN_JOB_ID = "plan";
const PLAN_LAUNCH_ID = "lch_pending";
const PLAN_KEY_REF = "pending";
const HASH_EXCLUDED_LABELS = new Set([
  "ai.manager.job",
  "ai.manager.launch-id",
  "ai.manager.gpu-admission-lease",
  "ai.manager.vram-reservation-mb",
  "ai.manager.api-key-ref",
]);
// Run-option fields that carry a launch's API key (vllm-manager, llama-manager).
const API_KEY_OPTIONS = Object.freeze(["vllmApiKey", "llamaApiKey", "apiKey"]);
const MAX_BODY_BYTES = 1024 * 1024;
// Flags whose next argv token is a secret value (SGLang still takes --api-key, 08 O1).
const SECRET_VALUE_FLAGS = new Set(["--api-key", "--hf-token", "--token", "--admin-api-key"]);
const MIN_REDACTION_LENGTH = 4;
// today's normalizeRuntimeImage (01 §9.5)
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/:@-]{0,511}$/i;
// Launch status per blocker (01 §11); anything else is a 409.
const BLOCKER_STATUS = Object.freeze({
  recipe_blocked: 422,
  image_pull_required: 409,
  runtime_local_build_missing: 409,
  experimental_ack_required: 400,
  instance_conflict: 409,
  insufficient_vram: 409,
});
// LaunchRequestV2 top-level fields and their JSON types (a wrong type is a malformed body).
const V2_FIELD_TYPES = Object.freeze({
  engineId: "string",
  runtimeId: "string",
  recipeId: "string",
  runtime: "object",
  model: "object",
  prospective: "boolean",
  instance: "object",
  onConflict: "string",
  values: "object",
  extraArgs: "array",
  extraEnv: "object",
  apiKey: "string",
  acknowledge: "array",
  expectedPlanHash: "string",
  fromLaunchId: "string",
  source: "string",
});
const NESTED_FIELD_TYPES = Object.freeze({
  model: { ref: "string", servedName: "string", card: "object" },
  instance: { mode: "string", id: "string", port: "port", networkAccess: "string", gpuIds: "array" },
  runtime: { imageOverride: "string" },
});
// gpu-admission request fields the plan shows unchanged (00 §9.1, 01 §27 C1b).
const ADMISSION_REQUEST_FIELDS = Object.freeze([
  "requestedFraction", "requestedFractionOfFree", "requestedMb", "requestedMbByGpu",
  "poolCappedTokens", "minClampMb", "estimatePolicy", "gpuIds", "useAllGpus",
]);
const EMPTY_BREAKDOWN = Object.freeze({ weights: 0, kv: 0, activations: 0, draft: 0, mmproj: 0, overhead: 0 });

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function bilingual(zh, en) {
  return { zh, en };
}

function joinBilingual(message) {
  return isPlainObject(message) ? `${message.zh} / ${message.en}` : String(message ?? "");
}

// "中文 / English" (the managers' bilingual text) → { zh, en }.
function splitBilingual(text) {
  if (isPlainObject(text)) return { zh: String(text.zh ?? ""), en: String(text.en ?? text.zh ?? "") };
  const value = String(text ?? "");
  const index = value.indexOf(" / ");
  return index > 0 ? { zh: value.slice(0, index), en: value.slice(index + 3) } : { zh: value, en: value };
}

function fieldError(field, code, zh, en, extra = {}) {
  return { field, code, message: `${zh} / ${en}`, ...extra };
}

function blocker(code, zh, en, extra = {}) {
  return { code, message: bilingual(zh, en), ...extra };
}

function badRequest(code, message, details) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function hasType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isPlainObject(value);
  if (type === "port") return typeof value === "number" || typeof value === "string";
  return typeof value === type;
}

function isBlank(value) {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

// A {value, source} entry (02 planner output) carries its value and source.
function isSourcedValue(entry) {
  return isPlainObject(entry) && Object.hasOwn(entry, "value") && (Object.keys(entry).length === 1 || Object.hasOwn(entry, "source"));
}

function plainValues(values) {
  const out = {};
  for (const [id, entry] of Object.entries(isPlainObject(values) ? values : {})) {
    out[id] = isSourcedValue(entry) ? entry.value : entry;
  }
  return out;
}

// Provenance of a request value: "planner" for {value, source:"planner"} (00 §9.10), else "user".
function requestSource(entry) {
  return isSourcedValue(entry) && entry.source === "planner" ? "planner" : "user";
}

// Form text and numbers compare by value ("8192" and 8192 are the same setting).
function sameValue(a, b) {
  if (expr.deepEqual(a, b)) return true;
  const scalar = (value) => typeof value === "number" || typeof value === "string" || typeof value === "boolean";
  return scalar(a) && scalar(b) && String(a).trim() === String(b).trim();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

/** A LaunchRequestV2 rather than a legacy /api/start body (whose model is a string). */
function isV2Request(body) {
  return isPlainObject(body) && (typeof body.engineId === "string"
    || isPlainObject(body.model) || isPlainObject(body.values) || isPlainObject(body.instance));
}

/**
 * The 400 for a malformed body (01 §11: not an object, wrong top-level types,
 * more than 1 MiB), or null. Everything else about a request is a plan problem.
 */
function checkLaunchBody(body) {
  if (!isPlainObject(body)) return badRequest("invalid_body", "The launch request body must be a JSON object.");
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(body), "utf8");
  } catch {
    return badRequest("invalid_body", "The launch request body must be plain JSON.");
  }
  if (size > MAX_BODY_BYTES) return badRequest("body_too_large", `The launch request body is larger than ${MAX_BODY_BYTES} bytes.`);
  if (!isV2Request(body)) return null;
  for (const [field, type] of Object.entries(V2_FIELD_TYPES)) {
    if (body[field] === undefined || body[field] === null) continue;
    if (!hasType(body[field], type)) return badRequest("invalid_request", `${field} must be ${type === "array" ? "an array" : `a ${type}`}.`, { field });
    for (const [key, nestedType] of Object.entries(NESTED_FIELD_TYPES[field] || {})) {
      const value = body[field][key];
      if (value === undefined || value === null) continue;
      if (!hasType(value, nestedType)) return badRequest("invalid_request", `${field}.${key} has the wrong type.`, { field: `${field}.${key}` });
    }
  }
  return null;
}

/**
 * body → { request, warnings, deferredError }. A legacy body goes through the
 * alias table (an unknown engine is 400 unknown_engine there) and keeps the
 * body itself as request.legacy.body, because today's normalisation reads the
 * body as sent. An alias error other than the engine is deferred: the
 * normalisation rejects the same input first with its own message.
 */
function toLaunchRequest(body, { managerId, registry, paramCatalog: loader }) {
  if (isV2Request(body)) {
    const { legacy: _ignored, ...request } = body;
    return { request: clone(request), warnings: [], deferredError: null };
  }
  try {
    const { request, warnings } = legacyAliases.legacyBodyToRequest(body, { managerId, registry, paramCatalog: loader });
    request.legacy = { ...(request.legacy || {}), body };
    return { request, warnings, deferredError: null };
  } catch (error) {
    if (error?.code === "unknown_engine" || error?.code === "invalid_body") throw error;
    return {
      request: {
        engineId: registry.fromLegacy(body.engine, managerId),
        model: { ref: String(body.model ?? "").trim() },
        instance: {},
        values: {},
        legacy: { body },
      },
      warnings: [],
      deferredError: error,
    };
  }
}

function requireHostedEngine(registry, managerId, engineId) {
  const descriptor = registry.require(engineId);
  // No coercion (01 §3): an engine another manager hosts is unknown here.
  if (managerId && !registry.hostedBy(managerId).includes(descriptor.id)) throw unknownEngineError(engineId);
  return descriptor;
}

// ---------------------------------------------------------------------------
// Runtime, recipe and legacy body
// ---------------------------------------------------------------------------

function runtimeView(ref, image = null) {
  if (!ref) return image ? { id: null, image } : null;
  return {
    id: ref.runtimeId || null,
    manifestKey: ref.manifestKey || null,
    image: image || ref.image || null,
    version: ref.version || null,
    status: ref.status || null,
    localBuild: Boolean(ref.localBuild),
    pullPolicy: ref.pullPolicy || "explicit",
  };
}

/**
 * The runtime a request asks for: runtimeId, runtime.imageOverride, the
 * recipe's runtime, else the engine default. Throws unknown_runtime.
 */
function requestedRuntime(registry, engineId, request, recipe) {
  if (request.runtimeId) return registry.resolveRuntime(engineId, { runtimeId: request.runtimeId });
  const image = String(request.runtime?.imageOverride || "").trim();
  if (image) {
    if (!IMAGE_PATTERN.test(image)) {
      const error = new Error("runtime.imageOverride must be a valid Docker image reference without spaces or command options.");
      error.code = "invalid_runtime_image";
      throw error;
    }
    return registry.resolveRuntime(engineId, { image });
  }
  if (recipe?.runtime?.ref) return registry.resolveRuntime(engineId, { manifestKey: recipe.runtime.ref });
  return registry.defaultRuntime(engineId);
}

function lockMessage(lock) {
  return isPlainObject(lock?.reason) ? lock.reason : { zh: String(lock?.reason || ""), en: String(lock?.reason || "") };
}

function recipeView(recipe) {
  if (!recipe) return null;
  return {
    id: recipe.id,
    status: recipe.status || null,
    label: clone(recipe.label || null),
    locks: (recipe.locks || []).map((lock) => ({ param: lock.param, value: clone(lock.value), reason: clone(lockMessage(lock)) })),
  };
}

/**
 * Recipe lock conflicts (01 §11 step 4): a v2 user value is field error
 * recipe_locked; a planner value or a legacy body is overridden (warning
 * recipe_locked_override), which is what the legacy preset always did.
 */
function lockConflicts(applied, { values, origin, errors, warnings }) {
  for (const item of applied?.overrides || []) {
    if (item.code !== "recipe_locked") continue;
    const reason = lockMessage({ reason: item.reason });
    const shown = JSON.stringify(item.value);
    if (origin === "v2" && requestSource(values[item.param]) === "user") {
      errors.push(fieldError(item.param, "recipe_locked",
        `配方锁定了这个参数（${shown}）：${reason.zh}`,
        `The recipe locks this parameter to ${shown}: ${reason.en}`,
        { suggestion: { value: clone(item.value), why: `${reason.zh} / ${reason.en}` } }));
    } else if (!warnings.some((warning) => warning.code === "recipe_locked_override" && warning.field === item.param)) {
      warnings.push(fieldError(item.param, "recipe_locked_override",
        `配方锁定了这个参数，已改用 ${shown}：${reason.zh}`,
        `The recipe locks this parameter; ${shown} is used instead: ${reason.en}`));
    }
  }
}

function safeApplyRecipe(recipe, values, facts) {
  if (!recipe) return null;
  try {
    return recipes.applyRecipe(recipe, values, { facts });
  } catch {
    return null;
  }
}

/**
 * A v2 request as the legacy body today's normalisation reads: param values
 * through the alias table, the request fields as the old form fields, and
 * vllm-manager's multiGpuMode from the parallel sizes.
 */
function synthesizeLegacyBody(request, { engineId, registry, catalog, runtime, explicitRuntime, values }) {
  const body = legacyAliases.valuesToLegacyConfig(values, engineId, { catalog });
  const model = isPlainObject(request.model) ? request.model : {};
  const instance = isPlainObject(request.instance) ? request.instance : {};
  body.model = String(model.ref ?? "").trim();
  if (!isBlank(model.servedName)) body.name = String(model.servedName).trim();
  body.engine = registry.toLegacy(engineId);
  if (!isBlank(instance.mode)) body.instanceMode = instance.mode;
  if (!isBlank(instance.id)) body.instanceId = instance.id;
  if (!isBlank(instance.port)) body.port = instance.port;
  if (!isBlank(instance.networkAccess)) body.networkAccess = instance.networkAccess;
  if (Array.isArray(instance.gpuIds)) body.gpuDeviceIds = instance.gpuIds.map(String).join(",");
  if (explicitRuntime && runtime?.image) body.runtimeImage = runtime.image;
  if (!isBlank(request.apiKey)) body.apiKey = String(request.apiKey);
  if (!catalog.byLegacyField?.multiGpuMode) {
    let layout = "single";
    for (const [mode, paramId] of Object.entries(legacyAliases.LAYOUT_PARAMS)) {
      const param = catalog.byId.get(paramId);
      if (param?.legacy && Number(values[paramId]) > 1) {
        layout = mode;
        break;
      }
    }
    body.multiGpuMode = layout;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Command, hash, steps and memory
// ---------------------------------------------------------------------------

function redactArgv(argv, redactions) {
  const secrets = (redactions || []).map(String).filter((value) => value.length >= MIN_REDACTION_LENGTH);
  return argv.map((token, index) => {
    if (index > 0 && SECRET_VALUE_FLAGS.has(String(argv[index - 1]))) return REDACTED;
    return redactSecrets(String(token), { secrets, patterns: false, minSecretLength: MIN_REDACTION_LENGTH });
  });
}

// "-e NAME" and "-e NAME=value" → [[NAME, value|null]] in argv order.
function envFlags(flags) {
  const out = [];
  for (let index = 0; index < flags.length - 1; index += 1) {
    if (flags[index] !== "-e") continue;
    const text = String(flags[index + 1]);
    const split = text.indexOf("=");
    out.push(split > 0 ? [text.slice(0, split), text.slice(split + 1)] : [text, null]);
    index += 1;
  }
  return out;
}

function withoutHashExcludedLabels(argv) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--label" && index + 1 < argv.length) {
      const key = String(argv[index + 1]).split("=", 1)[0];
      if (HASH_EXCLUDED_LABELS.has(key)) {
        index += 1;
        continue;
      }
    }
    out.push(argv[index]);
  }
  return out;
}

/**
 * planHash (01 §11 step 7): sha256 over the canonical JSON of
 * {image, argvRedacted, secretEnvNames, envNames, labels} without the job and
 * launch-id labels. Identical inputs and host facts give an identical hash.
 */
function computePlanHash({ image, argvRedacted, secretEnvNames, envNames, labels }) {
  const material = {
    image: image || null,
    argvRedacted: withoutHashExcludedLabels(argvRedacted || []),
    secretEnvNames: [...(secretEnvNames || [])].sort(),
    envNames: [...(envNames || [])].sort(),
    labels: Object.fromEntries(Object.entries(labels || {}).filter(([key]) => !HASH_EXCLUDED_LABELS.has(key))),
  };
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(material)).digest("hex")}`;
}

/** LaunchCommand → { view: { argv, env, labels } (redacted), planHash }. */
function commandView(command) {
  const argv = redactArgv(["docker", ...renderRunArgs(command)], command.redactions);
  const secretEnvNames = Object.keys(command.secretEnv || {});
  const env = {};
  for (const name of secretEnvNames) env[name] = REDACTED;
  const flags = Array.isArray(command.docker?.flags) ? command.docker.flags : [];
  for (const [name, value] of envFlags(flags)) {
    if (!Object.hasOwn(env, name)) env[name] = value === null ? REDACTED : redactArgv([value], command.redactions)[0];
  }
  const labels = { ...(command.labels || {}) };
  return {
    view: { argv, env, labels },
    planHash: computePlanHash({
      image: command.docker?.image,
      argvRedacted: argv,
      secretEnvNames,
      envNames: Object.keys(env),
      labels,
    }),
  };
}

function memoryPolicy(request) {
  const policy = String(request?.estimatePolicy || "");
  if (Number(request?.requestedFractionOfFree) > 0) return "static-fraction-of-free";
  if (/measured/.test(policy)) return "measured";
  if (/gguf|llama/.test(policy)) return "gguf-estimate";
  if (Number(request?.requestedFraction) > 0) return "device-fraction";
  return policy ? "gguf-estimate" : null;
}

function memoryView(admissionRequest, estimate = null) {
  if (!admissionRequest) return null;
  const request = {};
  for (const field of ADMISSION_REQUEST_FIELDS) {
    if (admissionRequest[field] !== undefined && admissionRequest[field] !== null) request[field] = clone(admissionRequest[field]);
  }
  const requestedMb = Number(admissionRequest.requestedMb);
  const pool = Number(admissionRequest.poolCappedTokens);
  const view = {
    perGpuMb: {},
    breakdown: { ...EMPTY_BREAKDOWN },
    admissionRequestMb: Number.isFinite(requestedMb) && requestedMb > 0 ? requestedMb : null,
    kvPoolTokens: Number.isFinite(pool) && pool > 0 ? pool : null,
    maxFullLengthRequests: null,
    policy: memoryPolicy(admissionRequest),
    admissionRequest: request,
  };
  // The memory model's estimate (01 §12) adds its breakdown, policy and
  // findings; the request shown stays the one admission gets.
  if (isPlainObject(estimate)) {
    if (isPlainObject(estimate.breakdown)) view.breakdown = { ...EMPTY_BREAKDOWN, ...clone(estimate.breakdown) };
    if (estimate.kvPoolTokens > 0) view.kvPoolTokens = estimate.kvPoolTokens;
    if (Number.isFinite(estimate.maxFullLengthRequests)) view.maxFullLengthRequests = estimate.maxFullLengthRequests;
    if (estimate.policy) view.policy = estimate.policy;
    if (estimate.confidence) view.confidence = estimate.confidence;
    for (const field of ["notes", "warnings", "errors"]) {
      if (Array.isArray(estimate[field]) && estimate[field].length) view[field] = clone(estimate[field]);
    }
  }
  return view;
}

// What the running container in the replace slot holds now, by GPU, from its labels.
function releasedMemory(container) {
  const labels = container?.labels || {};
  const totalMb = Number(labels["ai.manager.vram-reservation-mb"]);
  const gpuIds = String(labels["ai.manager.gpu-ids"] || "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!(totalMb > 0) || !gpuIds.length) return null;
  return Object.fromEntries(gpuIds.map((id) => [id, Math.round(totalMb / gpuIds.length)]));
}

async function readHostGpus(ctx) {
  if (typeof ctx.getHostGpus !== "function") return null;
  try {
    const gpus = await ctx.getHostGpus();
    return Array.isArray(gpus) ? gpus : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

function provenance(id, value, { applied, recipe, user, rawValues, catalog, facts, model }) {
  const lock = (recipe?.locks || []).find((item) => item.param === id);
  const recipeSource = applied?.provenance?.[id];
  if (recipeSource && recipeSource !== "user" && sameValue(applied.values?.[id], value)) {
    const reason = lock ? lockMessage(lock) : recipe?.label || null;
    return { source: "recipe", reason: reason ? joinBilingual(reason) : `recipe ${recipe.id}` };
  }
  if (Object.hasOwn(user, id) && user[id] !== null && sameValue(user[id], value)) return { source: requestSource(rawValues[id]) };
  const param = catalog.byId.get(id);
  if (param?.fromModel && model?.quantMethod && sameValue(model.quantMethod, value)) {
    return { source: "model", reason: "config.json quantization_config.quant_method" };
  }
  if (param && sameValue(paramCatalog.platformDefaultValue(param, catalog, { facts }), value)) return { source: "platform-default" };
  if (recipe) return { source: "recipe", reason: `recipe ${recipe.id}` };
  return { source: "platform-default" };
}

function collectValues(plan, finalValues, context) {
  const { catalog, user } = context;
  for (const [id, value] of Object.entries(finalValues || {})) {
    const param = catalog.byId.get(id);
    if (!param || param.secret || value === null || value === undefined || value === "") continue;
    plan.values[id] = { value: clone(value), ...provenance(id, value, context) };
  }
  // overrides[]: every final value that differs from an explicit user or planner value.
  for (const [id, wanted] of Object.entries(user)) {
    if (wanted === null || wanted === undefined || wanted === "") continue;
    const entry = plan.values[id];
    if (!entry || sameValue(wanted, entry.value)) continue;
    plan.overrides.push({ param: id, from: clone(wanted), to: clone(entry.value), source: entry.source, ...(entry.reason ? { reason: entry.reason } : {}) });
  }
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

/**
 * A legacy normalisation error as a plan problem: 400s are field errors, any
 * other refusal (422 compatibility, 409 unsupported architecture, VRAM
 * estimate) a blocker. The error itself is kept for the launch to rethrow.
 */
function recordFailure(plan, error) {
  plan.legacy.failure = error;
  const status = Number(error?.status) || 0;
  if (status === 400) {
    plan.errors.push({
      field: String(error.field || error.details?.field || "request"),
      code: String(error.code || "invalid_value"),
      message: String(error.message || error),
    });
    return;
  }
  plan.blockers.push({
    code: String(error?.code || (status === 422 ? "launch_validation_failed" : "launch_rejected")),
    message: splitBilingual(error?.message || error),
    ...(Array.isArray(error?.findings) ? { findings: clone(error.findings) } : {}),
  });
}

function finish(plan) {
  plan.ok = plan.errors.length === 0 && plan.blockers.length === 0;
  return plan;
}

/**
 * request (LaunchRequestV2, or one the alias table made with request.legacy.body)
 * + ctx → LaunchPlan (00 §4.3 + §9.2). Throws only unknown_engine (400).
 */
async function resolveLaunchPlan(request, ctx = {}) {
  const mode = ctx.mode === "launch" ? "launch" : "plan";
  const registry = ctx.registry;
  if (!registry || typeof registry.require !== "function") throw new TypeError("resolveLaunchPlan needs an engine registry.");
  if (typeof ctx.normalize !== "function") throw new TypeError("resolveLaunchPlan needs the manager's normalize hook.");
  const managerId = normalizeManagerId(ctx.managerId);
  const legacyBody = isPlainObject(request?.legacy?.body) ? request.legacy.body : null;
  const origin = legacyBody ? "legacy" : "v2";

  // 1. Engine (unknown → 400), runtime and the request's own fields.
  const descriptor = requireHostedEngine(registry, managerId, request?.engineId);
  const engineId = descriptor.id;
  const loader = ctx.paramCatalog || paramCatalog.getParamCatalog();
  const store = ctx.recipeStore || recipes.getRecipeStore();
  const plan = {
    ok: false,
    engineId,
    prospective: false,
    catalogVersion: "",
    planHash: null,
    runtime: null,
    recipe: null,
    values: {},
    overrides: [],
    errors: [],
    warnings: [...(ctx.warnings || [])],
    blockers: [],
    steps: [],
    command: null,
    memory: null,
    admission: null,
  };
  // In-process only (never serialized): what the launch executes.
  Object.defineProperty(plan, "legacy", {
    value: { runOptions: null, jobMeta: null, admissionRequest: null, extras: null, memory: null, preset: null, failure: null },
    enumerable: false,
    writable: true,
  });
  const { errors, warnings, blockers } = plan;
  const instance = isPlainObject(request.instance) ? request.instance : {};
  const rawValues = isPlainObject(request.values) ? request.values : {};
  const user = plainValues(rawValues);

  let requestedRecipe = null;
  if (!isBlank(request.recipeId)) {
    const found = store.get(String(request.recipeId));
    if (found && found.engineId === engineId && found.kind !== "scenario") requestedRecipe = found;
    else {
      errors.push(fieldError("recipeId", "unknown_recipe",
        `${descriptor.label?.zh || engineId} 没有配方“${String(request.recipeId).slice(0, 64)}”`,
        `${descriptor.label?.en || engineId} has no recipe "${String(request.recipeId).slice(0, 64)}"`));
    }
  }
  const explicitRuntime = Boolean(request.runtimeId || request.runtime?.imageOverride || requestedRecipe?.runtime?.ref);
  let runtime = null;
  try {
    runtime = requestedRuntime(registry, engineId, request, requestedRecipe);
  } catch (error) {
    if (!["unknown_runtime", "invalid_runtime_image"].includes(error?.code)) throw error;
    const field = request.runtimeId ? "runtimeId" : "runtime.imageOverride";
    // A legacy runtimeImage is simply what runs, as today; the plan only notes it.
    (origin === "legacy" ? warnings : errors).push(fieldError(field, error.code,
      `${descriptor.label?.zh || engineId} 没有这个运行时`, error.message));
  }
  plan.runtime = runtimeView(runtime);
  const acknowledge = Array.isArray(request.acknowledge) ? request.acknowledge.map(String) : [];
  if (descriptor.status === "experimental" && !acknowledge.includes("experimental-engine")) {
    blockers.push(blocker("experimental_ack_required",
      "这是实验性引擎，启动前需要确认（acknowledge: experimental-engine）",
      "This is an experimental engine; acknowledge it before launching (acknowledge: experimental-engine)"));
  }
  if (origin === "v2") {
    // Parts of LaunchRequestV2 the resolver does not launch yet (ENG-26).
    if (request.prospective === true) {
      errors.push(fieldError("prospective", "prospective_unsupported", "这个管理器还不能为未下载的模型生成计划", "This manager cannot plan a model that is not on disk yet"));
    }
    if (instance.mode !== undefined && !["replace", "parallel"].includes(instance.mode)) {
      errors.push(fieldError("instance.mode", "instance_mode_unsupported", `不支持的实例模式“${String(instance.mode).slice(0, 32)}”；可选 replace、parallel`, `Unsupported instance mode "${String(instance.mode).slice(0, 32)}"; use replace or parallel`));
    }
    if (isBlank(request.model?.ref)) errors.push(fieldError("model.ref", "required", "请选择模型", "Choose a model"));
  }

  // 2. Catalog and values (a legacy body is checked by its own normalisation).
  const catalog = loader.loadCatalog(engineId, runtime ? { runtime } : {});
  plan.catalogVersion = catalog.catalogVersion || "";
  const hostGpus = mode === "plan" || typeof ctx.prepareCommand === "function" ? await readHostGpus(ctx) : null;
  const facts = paramCatalog.buildFacts({
    host: paramCatalog.hostFactsFromGpus(hostGpus, ctx.platform || process.platform),
    runtime,
    instanceMode: instance.mode || null,
  });
  if (origin === "v2") {
    const checked = paramCatalog.validateValues(rawValues, catalog, { facts });
    errors.push(...checked.errors);
    warnings.push(...checked.warnings);
  }

  // 3-4. An explicit recipe: blockIf, locks, then its values under the user's.
  // A legacy body's recipe (the Pennyroyal image) is checked by the preset the
  // builder renders from it, which is what blocks the launch today.
  const requestedApplied = safeApplyRecipe(requestedRecipe, rawValues, facts);
  if (requestedApplied) {
    lockConflicts(requestedApplied, { values: rawValues, origin, errors, warnings });
    for (const block of origin === "v2" ? requestedApplied.blocks || [] : []) {
      blockers.push({ code: "recipe_blocked", message: splitBilingual(block.message), recipeId: requestedRecipe.id });
    }
  }
  // 5b. Free-form extraArgs/extraEnv (01 §18). Only a v2 request carries them.
  const custom = { args: [], env: {} };
  if (origin === "v2" && (request.extraArgs !== undefined || request.extraEnv !== undefined)) {
    let introspected = null;
    if (runtime && typeof ctx.getIntrospection === "function") {
      try {
        introspected = (await ctx.getIntrospection(runtime)) || null;
      } catch {
        introspected = null;
      }
    }
    const checkedArgs = extraArgs.validateExtraArgs(request.extraArgs, {
      catalog,
      introspected,
      descriptor,
      storage: ctx.modelStorage || null,
      values: requestedApplied ? { ...user, ...requestedApplied.values } : user,
    });
    const checkedEnv = extraArgs.validateExtraEnv(request.extraEnv, { descriptor });
    errors.push(...checkedArgs.errors, ...checkedEnv.errors);
    warnings.push(...checkedArgs.warnings, ...checkedEnv.warnings);
    custom.args = checkedArgs.args;
    custom.env = checkedEnv.env;
  }
  // A launch with a known blocker stops here; a plan goes on to show the rest.
  if (errors.length || (mode === "launch" && blockers.length)) return finish(plan);

  // The legacy run options: the manager's own normalisation of the body.
  const merged = requestedApplied ? { ...user, ...requestedApplied.values } : user;
  const body = legacyBody || synthesizeLegacyBody(request, { engineId, registry, catalog, runtime, explicitRuntime, values: merged });
  // 02's calibration for this card, engine, runtime and paramsKey (01 §12);
  // a failing lookup only means no calibration.
  const lookupCalibration = typeof ctx.calibrationFor === "function" ? ctx.calibrationFor : NO_CALIBRATION;
  const card = isPlainObject(request.model?.card) ? request.model.card : null;
  const calibrationFor = async (key) => {
    try {
      return (await lookupCalibration(card, engineId, runtime?.runtimeId || null, key)) || null;
    } catch {
      return null;
    }
  };
  let normalized;
  try {
    normalized = await ctx.normalize(body, { mode, calibrationFor });
  } catch (error) {
    recordFailure(plan, error);
    return finish(plan);
  }
  if (ctx.deferredError) {
    recordFailure(plan, ctx.deferredError);
    return finish(plan);
  }
  const runOptions = normalized.runOptions;
  // Validated extraArgs/extraEnv ride on the run options (the adapters append
  // them last) and are recorded in job meta (01 §18). Absent when not given.
  const hasCustom = custom.args.length > 0 || Object.keys(custom.env).length > 0;
  let jobMeta = normalized.jobMeta || null;
  if (hasCustom) {
    if (custom.args.length) runOptions.extraArgs = [...custom.args];
    if (Object.keys(custom.env).length) runOptions.extraEnv = { ...custom.env };
    jobMeta = { ...(jobMeta || {}), ...(custom.args.length ? { extraArgs: [...custom.args] } : {}), ...(Object.keys(custom.env).length ? { extraEnv: { ...custom.env } } : {}) };
    plan.custom = { extraArgs: [...custom.args], extraEnv: { ...custom.env } };
  }
  Object.assign(plan.legacy, {
    runOptions,
    jobMeta,
    admissionRequest: normalized.admissionRequest || null,
    extras: normalized.extras || null,
    memory: normalized.memory || null,
  });

  // 5-7. The command, built by the adapter from exactly these run options.
  let prepared = null;
  let command = null;
  if (typeof ctx.prepareCommand === "function") {
    try {
      // A keyed launch stores its key first; the plan shows the label it will get.
      const keyed = API_KEY_OPTIONS.some((field) => !isBlank(runOptions[field]));
      const keyRef = runOptions.runtimeApiKeyRef || (keyed ? PLAN_KEY_REF : "");
      prepared = await ctx.prepareCommand({ ...runOptions, runtimeApiKeyRef: keyRef, hostGpus: hostGpus || [] }, { jobId: PLAN_JOB_ID, launchId: PLAN_LAUNCH_ID });
      command = prepared.adapter.buildLaunch(prepared.plan, prepared.ctx);
    } catch (error) {
      if (error?.code === "blocked") {
        blockers.push({
          code: "recipe_blocked",
          message: splitBilingual(error.message),
          ...(Array.isArray(error.findings) ? { findings: clone(error.findings) } : {}),
        });
      } else if (mode === "plan") {
        blockers.push(blocker("command_unavailable", `无法生成启动命令：${error?.message || error}`, `The launch command cannot be built: ${error?.message || error}`));
      } else {
        // The job reports this failure the way it always did.
        warnings.push(fieldError("command", "plan_command_unavailable", "启动前无法预览命令", `The command could not be previewed: ${error?.message || error}`));
      }
    }
  }
  plan.legacy.preset = prepared?.preset || null;
  const executedRecipe = prepared ? prepared.recipe || prepared.plan?.recipe || null : requestedRecipe;
  if (origin === "v2" && requestedRecipe && prepared && executedRecipe?.id !== requestedRecipe.id) {
    errors.push(fieldError("recipeId", "recipe_not_applicable",
      `这个模型和运行时不会使用配方“${requestedRecipe.id}”`,
      `This model and runtime do not run recipe "${requestedRecipe.id}"`,
      { executedRecipe: executedRecipe?.id || null }));
  }
  const applied = executedRecipe === requestedRecipe ? requestedApplied : safeApplyRecipe(executedRecipe, rawValues, facts);
  // The builder's preset already applied the executed recipe's blocks.
  if (executedRecipe !== requestedRecipe) lockConflicts(applied, { values: rawValues, origin, errors, warnings });
  plan.recipe = recipeView(executedRecipe);
  collectValues(plan, prepared?.plan?.values || (applied ? { ...user, ...applied.values } : user), {
    applied,
    recipe: executedRecipe,
    user,
    rawValues,
    catalog,
    facts,
    model: prepared?.ctx?.model || null,
  });
  if (command) {
    const { view, planHash } = commandView(command);
    plan.command = view;
    plan.planHash = planHash;
  }

  // 8. Steps, in execution order: pull, replace, start.
  const image = command?.docker?.image || runtime?.image || null;
  let executedRuntime = null;
  if (image) {
    try {
      executedRuntime = registry.resolveRuntime(engineId, { image });
    } catch {
      executedRuntime = null;
    }
  }
  if (command) plan.runtime = runtimeView(executedRuntime, image);
  // An image no manifest entry names runs as it always did on a stable tier-1
  // engine: pulled before the checkpoint (01 §5).
  const policy = executedRuntime?.pullPolicy || (descriptor.tier === 1 && descriptor.status === "stable" ? "auto" : "explicit");
  const localBuild = Boolean(executedRuntime?.localBuild);
  let required = null;
  if (image && typeof ctx.imagePresence === "function" && (mode === "plan" || policy === "explicit" || localBuild)) {
    try {
      const present = await ctx.imagePresence(image);
      required = typeof present === "boolean" ? !present : null;
    } catch {
      required = null;
    }
  }
  const runtimeId = executedRuntime?.runtimeId || null;
  plan.steps.push({ kind: "pull", runtimeId, image, required, policy });
  if (required === true && localBuild) {
    blockers.push(blocker("runtime_local_build_missing",
      `本地构建的运行时镜像 ${image} 不存在，无法拉取；请先按运行时说明重新构建`,
      `The locally built runtime image ${image} is missing and cannot be pulled; rebuild it first`));
  } else if (required === true && policy === "explicit") {
    blockers.push(blocker("image_pull_required",
      `需要先拉取运行时镜像 ${image}`,
      `Pull the runtime image ${image} first`,
      {
        action: {
          label: bilingual("拉取镜像", "Pull image"),
          apiCall: { method: "POST", path: `/api/runtimes/${encodeURIComponent(runtimeId || "")}/pull`, body: { confirm: true } },
        },
      }));
  }
  let slot = null;
  if (mode === "plan" && runOptions.instanceMode === "replace" && typeof ctx.listContainers === "function") {
    try {
      const containers = await ctx.listContainers();
      slot = (Array.isArray(containers) ? containers : []).find((item) => item?.running && item.name === runOptions.containerName) || null;
    } catch {
      slot = null;
    }
    if (slot) plan.steps.push({ kind: "replace", containerName: slot.name, model: String(slot.labels?.["ai.manager.model"] || slot.model || "") });
  }
  plan.steps.push({
    kind: "start",
    containerName: runOptions.containerName,
    port: runOptions.port,
    gpuIds: Array.isArray(runOptions.gpuDeviceIds) ? [...runOptions.gpuDeviceIds] : [],
  });

  // 9. Memory and the admission preview (the launch admits for itself).
  plan.memory = memoryView(plan.legacy.admissionRequest, plan.legacy.memory);
  if (mode === "plan" && plan.legacy.admissionRequest && typeof ctx.admissionPreview === "function") {
    let preview;
    try {
      preview = await ctx.admissionPreview(plan.legacy.admissionRequest, { mode: runOptions.instanceMode, releasedMbByGpu: releasedMemory(slot) });
    } catch (error) {
      preview = { verdict: "unknown", code: error?.code || "vram_admission_unavailable", message: String(error?.message || error) };
    }
    plan.admission = {
      verdict: preview?.verdict || "unknown",
      message: String(preview?.message || ""),
      ...(preview?.code ? { code: preview.code } : {}),
      ...(preview?.clamped ? { clamped: true } : {}),
      ...(Number.isFinite(preview?.requestedMb) ? { requestedMb: preview.requestedMb } : {}),
      ...(Number.isFinite(preview?.reservedMb) ? { reservedMb: preview.reservedMb } : {}),
    };
    if (Array.isArray(preview?.gpus) && preview.gpus.length && plan.memory) {
      plan.memory.perGpuMb = Object.fromEntries(preview.gpus.map((gpu) => [String(gpu.gpuIndex ?? gpu.gpuId), gpu.reservedMb]));
      plan.memory.admissionRequestMb = preview.reservedMb;
    }
    if (plan.admission.verdict === "block") {
      blockers.push({ code: "insufficient_vram", message: splitBilingual(plan.admission.message) });
    }
  }
  return finish(plan);
}

/**
 * body + ctx → LaunchPlan: the plan route and the launch both start here.
 * Throws 400 for a malformed body and for an unknown engine; every other
 * problem is in the plan (ok:false with errors[] and blockers[]).
 */
async function planLaunch(body, ctx = {}) {
  const malformed = checkLaunchBody(body);
  if (malformed) throw malformed;
  const registry = ctx.registry;
  const managerId = normalizeManagerId(ctx.managerId);
  const loader = ctx.paramCatalog || paramCatalog.getParamCatalog();
  const { request, warnings, deferredError } = toLaunchRequest(body, { managerId, registry, paramCatalog: loader });
  return resolveLaunchPlan(request, { ...ctx, warnings: [...(ctx.warnings || []), ...warnings], deferredError });
}

/**
 * The error a launch throws for a plan with problems (01 §11, §21.1): today's
 * normalisation error unchanged, or field errors as 400 (recipe_locked first),
 * or the first blocker with its legacy status. Every one carries errors[] so
 * the start route can answer the legacy shape plus ok:false and errors[].
 */
function planLaunchError(plan) {
  const failure = plan.legacy?.failure;
  let error;
  if (failure && typeof failure === "object") {
    error = failure;
  } else if (plan.errors.length) {
    const first = plan.errors.find((item) => item.code === "recipe_locked") || plan.errors[0];
    error = new Error(plan.errors.map((item) => item.message).join("; "));
    error.status = 400;
    error.code = first.code;
  } else {
    const first = plan.blockers[0] || { code: "launch_rejected", message: bilingual("启动被拒绝", "The launch was refused") };
    error = new Error(joinBilingual(first.message));
    error.status = BLOCKER_STATUS[first.code] || 409;
    error.code = first.code;
    error.details = { blockers: clone(plan.blockers) };
    const action = first.action?.apiCall;
    if (action) error.hint = `${first.action.label.en}: ${action.method} ${action.path}`;
  }
  if (Object.isExtensible(error)) {
    error.errors = clone(plan.errors);
    if (!error.plan) Object.defineProperty(error, "plan", { value: plan, enumerable: false, writable: true });
  }
  return error;
}

/** The JSON body of a plan (00 §4.3): its enumerable fields, which hold no secret. */
function publicPlan(plan) {
  return clone(plan);
}

/** The plan summary POST /api/start answers next to the job (01 §21.1). */
function launchSummary(plan) {
  return {
    planHash: plan.planHash,
    verdict: plan.admission?.verdict ?? null,
    warnings: clone(plan.warnings),
    overrides: clone(plan.overrides),
  };
}

/**
 * The managers' launch-request wiring: createLaunchPlanner({ managerId,
 * normalize, getEngineRegistry?, getRecipeStore?, paramCatalog?,
 * prepareLaunchCommand?, getHostGpus?, imagePresence?, admissionPreview?,
 * listContainers?, calibrationFor? }) → { plan(body), launch(body), runOptions(plan), summary(plan) }.
 * plan() is the POST /api/launch/plan body; launch() resolves the same plan
 * in launch mode and throws planLaunchError for a plan with problems.
 * The registry and recipe getters are read per request, so a manager can wire
 * them before it creates them.
 */
function createLaunchPlanner(options = {}) {
  if (typeof options.normalize !== "function") throw new TypeError("createLaunchPlanner needs a normalize hook.");
  const hook = (name) => (typeof options[name] === "function" ? options[name] : null);
  function context(mode) {
    return {
      mode,
      managerId: options.managerId,
      registry: (hook("getEngineRegistry") && options.getEngineRegistry()) || registryModule.getEngineRegistry(),
      paramCatalog: options.paramCatalog || paramCatalog.getParamCatalog(),
      recipeStore: (hook("getRecipeStore") && options.getRecipeStore()) || recipes.getRecipeStore(),
      normalize: options.normalize,
      prepareCommand: hook("prepareLaunchCommand"),
      getHostGpus: hook("getHostGpus"),
      imagePresence: hook("imagePresence"),
      admissionPreview: hook("admissionPreview"),
      listContainers: hook("listContainers"),
      getIntrospection: hook("getIntrospection"),
      modelStorage: options.modelStorage || null,
      calibrationFor: hook("calibrationFor") || NO_CALIBRATION,
    };
  }
  return {
    plan: (body) => planLaunch(body, context("plan")),
    async launch(body) {
      const plan = await planLaunch(body, context("launch"));
      if (!plan.ok) throw planLaunchError(plan);
      return plan;
    },
    runOptions: legacyAliases.requestToLegacyRunOptions,
    summary: launchSummary,
  };
}

module.exports = {
  BLOCKER_STATUS,
  MAX_BODY_BYTES,
  PLAN_JOB_ID,
  PLAN_LAUNCH_ID,
  checkLaunchBody,
  commandView,
  computePlanHash,
  createLaunchPlanner,
  isV2Request,
  launchSummary,
  planLaunch,
  planLaunchError,
  publicPlan,
  requestToLegacyRunOptions: legacyAliases.requestToLegacyRunOptions,
  resolveLaunchPlan,
  splitBilingual,
  toLaunchRequest,
};
