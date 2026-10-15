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
//        calibrationFor?(card, engineId, runtimeId, paramsKey) → calibration | null,
//        modelFacts?(model, { engineId, runtimeId, hostFacts }) → Promise<02 planFacts | null> }
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
const memoryModels = require("./memory-models");
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
const INSTANCE_MODES = Object.freeze(["replace", "parallel", "add"]);
// The placeholder model path of a prospective plan without model.ref (01 §11).
const PENDING_MODEL_PATH = "/models/<pending>";
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

// Fills an SGLang admission request's empty KV pool cap from the resolved
// values (recipe or preset defaults). Only a request that already has the
// poolCappedTokens field (the fraction-of-free policy) is touched, and only
// when nothing set a cap.
function capPoolFromResolvedValues(admissionRequest, values) {
  if (!isPlainObject(admissionRequest) || !Object.hasOwn(admissionRequest, "poolCappedTokens")) return;
  if (Number(admissionRequest.poolCappedTokens) > 0) return;
  const resolved = Math.floor(Number(plainValues(values)["sglang.maxTotalTokens"]));
  if (Number.isFinite(resolved) && resolved > 0) admissionRequest.poolCappedTokens = resolved;
}

function plainValues(values) {
  const out = {};
  for (const [id, entry] of Object.entries(isPlainObject(values) ? values : {})) {
    out[id] = isSourcedValue(entry) ? entry.value : entry;
  }
  return out;
}

// The values a request set for parameters the adapters emit through the generic
// catalog block (emit.mode "catalog"); null when there are none.
function catalogEmittedValues(catalog, values) {
  const out = {};
  for (const param of catalog.params) {
    if (param.emit?.mode !== "catalog" || ["none", "env"].includes(param.emit.kind)) continue;
    const value = values[param.id];
    if (value !== undefined && value !== null) out[param.id] = clone(value);
  }
  return Object.keys(out).length ? out : null;
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
  return isPlainObject(body) && (typeof body.engineId === "string" || typeof body.fromLaunchId === "string"
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
function isPrimaryId(id) {
  return String(id ?? "").trim().toLowerCase() === "primary";
}

function synthesizeLegacyBody(request, { engineId, registry, catalog, runtime, explicitRuntime, values, prospective = false }) {
  const body = legacyAliases.valuesToLegacyConfig(values, engineId, { catalog });
  const model = isPlainObject(request.model) ? request.model : {};
  const instance = isPlainObject(request.instance) ? request.instance : {};
  body.model = String(model.ref ?? "").trim() || (prospective ? PENDING_MODEL_PATH : "");
  if (!isBlank(model.servedName)) body.name = String(model.servedName).trim();
  body.engine = registry.toLegacy(engineId);
  // "add" starts on the primary slot (the replace naming) or on a parallel slot
  // named by instance.id; the resolver marks the run options launchMode "add".
  if (instance.mode === "add") body.instanceMode = isBlank(instance.id) || isPrimaryId(instance.id) ? "replace" : "parallel";
  else if (!isBlank(instance.mode)) body.instanceMode = instance.mode;
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

/**
 * The running managed container that holds the slot an add would start on (its
 * container name or its published port), as { instanceId, containerName, model },
 * or null. A container that is not running does not hold a slot here; the
 * supervisor still refuses a name that exists.
 */
async function findSlotConflict(runOptions, ctx) {
  if (typeof ctx.listContainers !== "function") return null;
  let containers;
  try {
    containers = await ctx.listContainers();
  } catch {
    return null;
  }
  const port = Number(runOptions.port);
  const holder = (Array.isArray(containers) ? containers : []).find((item) => {
    if (!item?.running) return false;
    if (item.name === runOptions.containerName) return true;
    if (!Number.isInteger(port)) return false;
    return [...String(item.ports || "").matchAll(/:(\d+)->/g)].some((match) => Number(match[1]) === port);
  });
  if (!holder) return null;
  return {
    instanceId: holder.name === runOptions.containerName
      ? (runOptions.instanceMode === "replace" ? "primary" : String(runOptions.instanceId || holder.name))
      : String(holder.labels?.["ai.manager.instance"] || holder.name),
    containerName: holder.name,
    model: String(holder.labels?.["ai.manager.model"] || holder.model || ""),
  };
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

// A generated launch file is mounted from a directory named after the launch id
// (`.../launch-files/lch_xxx/config.yml`); a plan and its launch differ only in that id.
const LAUNCH_FILES_DIR = /([\\/]launch-files[\\/])lch_[A-Za-z0-9]+/g;

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
    out.push(typeof argv[index] === "string" ? argv[index].replace(LAUNCH_FILES_DIR, "$1<launch-id>") : argv[index]);
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
  // Generated files are listed by name and target; their content is never shown (a secret file holds the key).
  const files = (Array.isArray(command.files) ? command.files : []).map((file) => ({ id: file.id, target: file.target, secret: file.secret === true }));
  return {
    view: { argv, env, labels, ...(files.length ? { files } : {}) },
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

// 02's artifact side of the plan's memory (MOD-9b, 02 §3.1, §10.1): when the
// manager wires ctx.modelFacts and the model has a card (supplied, or read from
// the folder model.ref names), the estimate is 01's memoryModels.estimate over
// MemoryInputs.artifact, exactly the call estimateFit makes, so the plan and a
// fit of the same card and values report the same perGpuMb, policy and
// admissionRequestMb. Plan mode only; null (the legacy memory stands) when
// there is no card or anything fails. The admission request the launch makes
// stays the manager's.
async function artifactMemory(ctx, { request, legacyBody, origin, engineId, descriptor, runtime, plan, runOptions, hostGpus, recipe, calibrationFor }) {
  if (typeof ctx.modelFacts !== "function") return null;
  if (plan.legacy.memory?.policy === "measured") return null;
  try {
    const model = origin === "v2" ? request.model : { ref: legacyBody?.model };
    const runtimeId = runtime?.runtimeId || null;
    const facts = await ctx.modelFacts(model, { engineId, runtimeId, hostFacts: { gpus: Array.isArray(hostGpus) ? hostGpus : [] } });
    if (!facts || typeof facts.memoryInputs !== "function") return null;
    const gpuIds = Array.isArray(runOptions?.gpuDeviceIds) && runOptions.gpuDeviceIds.length
      ? runOptions.gpuDeviceIds.map(String)
      : Array.isArray(request.instance?.gpuIds) ? request.instance.gpuIds.map(String) : [];
    const recipeMemory = isPlainObject(recipe?.memory) ? recipe.memory : null;
    const prepared = facts.memoryInputs(plainValues(plan.values), {
      gpuIds,
      instanceMode: runOptions?.instanceMode || request.instance?.mode,
      recipeMemory,
    });
    const inputs = { ...prepared.inputs, calibration: (await calibrationFor(prepared.paramsKey)) || prepared.inputs.calibration || null };
    const estimate = memoryModels.estimate(engineId, inputs, { descriptor });
    return isPlainObject(estimate) ? { estimate, facts, artifact: prepared.artifact } : null;
  } catch {
    return null;
  }
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
  const prospective = origin === "v2" && request.prospective === true;
  const addMode = origin === "v2" && instance.mode === "add";
  if (origin === "v2") {
    if (prospective) {
      // A plan from the model card alone (00 §9.2); it can never be launched.
      plan.prospective = true;
      if (mode === "launch") {
        errors.push(fieldError("prospective", "prospective_not_launchable", "模型文件尚未就绪，只能预览计划，不能启动", "The model files are not in place yet; the plan is a preview and cannot be launched"));
      } else if (!isPlainObject(request.model?.card)) {
        errors.push(fieldError("model.card", "required", "预览计划需要提供模型卡（model.card）", "A prospective plan needs the model card (model.card)"));
      }
      warnings.push(fieldError("prospective", "plan_prospective", "计划基于模型卡生成；文件下载完成后会重新计算。", "Planned from the model card; it is recomputed once the files exist."));
    }
    if (instance.mode !== undefined && !INSTANCE_MODES.includes(instance.mode)) {
      errors.push(fieldError("instance.mode", "instance_mode_unsupported", `不支持的实例模式“${String(instance.mode).slice(0, 32)}”；可选 replace、parallel、add`, `Unsupported instance mode "${String(instance.mode).slice(0, 32)}"; use replace, parallel or add`));
    }
    if (request.onConflict !== undefined && request.onConflict !== null) {
      if (!["fail", "skip"].includes(request.onConflict)) {
        errors.push(fieldError("onConflict", "invalid_value", "onConflict 只能是 fail 或 skip", "onConflict must be fail or skip"));
      } else if (!addMode) {
        errors.push(fieldError("onConflict", "on_conflict_requires_add", "onConflict 只能和 instance.mode \"add\" 一起使用", "onConflict only applies with instance.mode \"add\""));
      }
    }
    if (!prospective && isBlank(request.model?.ref)) errors.push(fieldError("model.ref", "required", "请选择模型", "Choose a model"));
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
  const body = legacyBody || synthesizeLegacyBody(request, { engineId, registry, catalog, runtime, explicitRuntime, values: merged, prospective });
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
    normalized = await ctx.normalize(body, { mode, calibrationFor, prospective, card });
  } catch (error) {
    recordFailure(plan, error);
    return finish(plan);
  }
  if (ctx.deferredError) {
    recordFailure(plan, ctx.deferredError);
    return finish(plan);
  }
  const runOptions = normalized.runOptions;
  if (origin === "v2" && typeof request.source === "string" && request.source.trim()) runOptions.launchSource = request.source.trim().slice(0, 32);
  if (addMode) {
    // 00 §9.3: an add never stops anything. The slot is checked here, before
    // any job, lease or Docker action; the supervisor checks it again.
    runOptions.launchMode = "add";
    runOptions.onConflict = request.onConflict === "skip" ? "skip" : "fail";
    const conflict = await findSlotConflict(runOptions, ctx);
    if (conflict) {
      blockers.push(blocker("instance_conflict",
        `实例 ${conflict.instanceId} 正在运行“${conflict.model}”，未做任何改动`,
        `Instance ${conflict.instanceId} is already running "${conflict.model}"; nothing was changed`,
        { conflict }));
      if (mode === "launch") {
        if (runOptions.onConflict === "skip" && errors.length === 0) plan.legacy.skip = { conflict };
        return finish(plan);
      }
    }
  }
  // Notes the manager's normalisation wants shown (an API key an engine cannot use, LAN publishing it cannot offer).
  for (const note of Array.isArray(normalized.warnings) ? normalized.warnings : []) warnings.push(clone(note));
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
  // Catalog parameters the legacy run options have no field for (01 §9.4) ride
  // along in runOptions.catalogValues, so the launch builds the command the
  // plan showed. Only a v2 request carries them, and only when it set some.
  const catalogValues = origin === "v2" ? catalogEmittedValues(catalog, merged) : null;
  if (catalogValues && isPlainObject(runOptions)) runOptions.catalogValues = catalogValues;
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
      prepared = await ctx.prepareCommand({ ...runOptions, runtimeApiKeyRef: keyRef, hostGpus: hostGpus || [] }, { jobId: PLAN_JOB_ID, launchId: PLAN_LAUNCH_ID, prospective, card });
      command = prepared.adapter.buildLaunch(prepared.plan, prepared.ctx);
    } catch (error) {
      if (error?.code === "blocked") {
        blockers.push({
          code: "recipe_blocked",
          message: splitBilingual(error.message),
          ...(Array.isArray(error.findings) ? { findings: clone(error.findings) } : {}),
        });
      } else if (error?.status === 400 && typeof error.code === "string") {
        // A value the engine's command template refuses (a path outside the model
        // storage, a value that would become a flag, a missing key) is the
        // request's fault, in plan and in launch alike (01 §19.1).
        plan.legacy.failure = error;
        errors.push({ field: String(error.field || "command"), code: error.code, message: String(error.message || error) });
      } else if (mode === "plan") {
        blockers.push(blocker("command_unavailable", `无法生成启动命令：${error?.message || error}`, `The launch command cannot be built: ${error?.message || error}`));
      } else {
        // The job reports this failure the way it always did.
        warnings.push(fieldError("command", "plan_command_unavailable", "启动前无法预览命令", `The command could not be previewed: ${error?.message || error}`));
      }
    }
  }
  plan.legacy.preset = prepared?.preset || null;
  // Findings of an adapter that has something to say about this launch (the
  // docker-template engines: experimental, unverified GPU, no LAN key): a fail
  // blocks, a warn is shown (01 §6 validate).
  if (command && typeof prepared?.adapter?.validate === "function") {
    try {
      for (const item of prepared.adapter.validate(prepared.plan, prepared.ctx) || []) {
        const message = item.detail || item.title || bilingual(item.code, item.code);
        if (item.severity === "fail") blockers.push({ code: String(item.code), message: clone(message) });
        else if (item.severity === "warn") warnings.push({ field: String(item.field || "engine"), code: String(item.code), message: joinBilingual(message) });
      }
    } catch {
      // A finding that cannot be computed never blocks the launch.
    }
  }
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
  if (mode === "plan" && runOptions.instanceMode === "replace" && !addMode && typeof ctx.listContainers === "function") {
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
  // A preset may cap the KV pool the user left blank (the Flash-Next NVFP4
  // recipe sets --max-total-tokens from the context length). The engine then
  // really runs capped, so admission may clamp to it; the request body alone
  // would say "uncapped" and refuse a launch that fits.
  capPoolFromResolvedValues(plan.legacy.admissionRequest, plan.values);
  plan.memory = memoryView(plan.legacy.admissionRequest, plan.legacy.memory);
  if (mode === "plan") {
    const artifact = await artifactMemory(ctx, { request, legacyBody, origin, engineId, descriptor, runtime, plan, runOptions, hostGpus, recipe: executedRecipe, calibrationFor });
    if (artifact) {
      const { estimate } = artifact;
      plan.memory = memoryView(estimate.admissionRequest || plan.legacy.admissionRequest, estimate);
      if (isPlainObject(estimate.perGpuMb)) plan.memory.perGpuMb = clone(estimate.perGpuMb);
      if (Number.isFinite(estimate.admissionRequestMb)) plan.memory.admissionRequestMb = estimate.admissionRequestMb;
      plan.memory.artifact = {
        cardId: artifact.artifact.cardId ?? null,
        contentDigest: artifact.artifact.contentDigest ?? null,
        confidence: artifact.artifact.confidence,
      };
    }
  }
  if (mode === "plan" && plan.legacy.admissionRequest && typeof ctx.admissionPreview === "function") {
    let preview;
    try {
      preview = await ctx.admissionPreview(plan.legacy.admissionRequest, { mode: addMode ? "parallel" : runOptions.instanceMode, releasedMbByGpu: releasedMemory(slot) });
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
 * {fromLaunchId, instance?, onConflict?, expectedPlanHash?, source?} → the
 * LaunchRequestV2 of the stored LaunchStore spec (01 §11): restore and
 * relaunch replay what ran, with the given placement. Any other body is
 * returned as it is. The stored API key is never replayed (the spec only holds
 * a reference); the replayed instance runs as the spec's own settings say.
 */
function expandLaunchRequest(body, ctx = {}) {
  if (!isPlainObject(body) || body.fromLaunchId === undefined || body.fromLaunchId === null) return body;
  if (typeof ctx.getLaunchSpec !== "function") {
    const error = new Error("The launch store is not available on this manager.");
    error.status = 501;
    error.code = "launch_store_unavailable";
    throw error;
  }
  const record = ctx.getLaunchSpec(body.fromLaunchId);
  const spec = isPlainObject(record?.spec) ? record.spec : null;
  if (!spec) {
    const error = new Error(`No stored launch ${String(body.fromLaunchId).slice(0, 64)}.`);
    error.status = 404;
    error.code = "unknown_launch";
    throw error;
  }
  const stored = isPlainObject(spec.instance) ? spec.instance : {};
  const override = isPlainObject(body.instance) ? body.instance : {};
  const instance = {};
  for (const [key, value] of Object.entries({ ...stored, ...override })) {
    if (value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && !value.length)) instance[key] = clone(value);
  }
  // A replace-mode launch always ran on the primary slot; its stored id is only
  // the name it was derived from, so a new placement keeps no such id.
  if (stored.mode !== "parallel" && instance.mode !== "parallel" && (isBlank(override.id) || override.id === stored.id)) delete instance.id;
  const request = {
    engineId: spec.engineId,
    ...(spec.runtimeId ? { runtimeId: spec.runtimeId } : {}),
    ...(spec.recipeId ? { recipeId: spec.recipeId } : {}),
    ...(spec.runtimeImage && !spec.runtimeId ? { runtime: { imageOverride: spec.runtimeImage } } : {}),
    model: { ref: spec.model?.ref || "", ...(spec.model?.servedName ? { servedName: spec.model.servedName } : {}) },
    instance,
    values: clone(spec.values || {}),
    ...(Array.isArray(spec.extraArgs) && spec.extraArgs.length ? { extraArgs: clone(spec.extraArgs) } : {}),
    ...(isPlainObject(spec.extraEnv) && Object.keys(spec.extraEnv).length ? { extraEnv: clone(spec.extraEnv) } : {}),
    ...(body.onConflict !== undefined ? { onConflict: body.onConflict } : {}),
    ...(body.expectedPlanHash !== undefined ? { expectedPlanHash: body.expectedPlanHash } : {}),
    ...(body.source !== undefined ? { source: body.source } : {}),
  };
  const malformed = checkLaunchBody(request);
  if (malformed) throw malformed;
  return request;
}

/**
 * body + ctx → LaunchPlan: the plan route and the launch both start here.
 * Throws 400 for a malformed body and for an unknown engine; every other
 * problem is in the plan (ok:false with errors[] and blockers[]).
 */
async function planLaunch(body, ctx = {}) {
  const malformed = checkLaunchBody(body);
  if (malformed) throw malformed;
  if (ctx.v2Only && !isV2Request(body)) {
    throw badRequest("v2_body_required", "POST /api/launch takes a LaunchRequestV2 or {fromLaunchId}; send a legacy body to /api/start.");
  }
  body = expandLaunchRequest(body, ctx);
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

/** The 409 a launch throws when expectedPlanHash no longer matches (01 §11): before any job, lease or container action. */
function planChangedError(plan) {
  const error = new Error("The launch plan changed after it was reviewed; review it again before starting. / 启动配置在你确认后发生了变化，请重新检查后再启动。");
  error.status = 409;
  error.code = "plan_changed";
  error.planView = publicPlan(plan);
  return error;
}

/** The 200 body of an add that skipped an occupied slot (01 §11, 00 §9.3). */
function skippedResult(plan) {
  return { ok: true, skipped: true, reason: "instance_running", conflict: clone(plan.legacy.skip.conflict) };
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
 * listContainers?, calibrationFor?, modelFacts? }) → { plan(body), launch(body), runOptions(plan), summary(plan) }.
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
      getLaunchSpec: hook("getLaunchSpec"),
      modelFacts: hook("modelFacts"),
    };
  }
  return {
    plan: (body) => planLaunch(body, context("plan")),
    /**
     * Resolves the plan in launch mode. Returns the plan to run, or the plan
     * of an add that skipped (plan.legacy.skip = { conflict }: no job, no
     * lease). Throws plan_changed when expectedPlanHash no longer matches,
     * and planLaunchError for a plan with problems. options.v2Only is
     * POST /api/launch: a legacy body is 400 v2_body_required.
     */
    async launch(body, { v2Only = false } = {}) {
      const plan = await planLaunch(body, { ...context("launch"), v2Only });
      if (plan.legacy?.skip) return plan;
      const expected = isPlainObject(body) ? (body.expectedPlanHash ?? null) : null;
      if (typeof expected === "string" && expected && plan.planHash && expected !== plan.planHash) throw planChangedError(plan);
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
  expandLaunchRequest,
  isV2Request,
  launchSummary,
  planChangedError,
  planLaunch,
  planLaunchError,
  publicPlan,
  requestToLegacyRunOptions: legacyAliases.requestToLegacyRunOptions,
  resolveLaunchPlan,
  skippedResult,
  splitBilingual,
  toLaunchRequest,
};
