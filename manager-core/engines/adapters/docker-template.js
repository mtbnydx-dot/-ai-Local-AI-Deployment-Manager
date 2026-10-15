"use strict";

// The generic docker-template adapter (docs/overhaul/01-engines.md §6.1, §19,
// ENG-18): tier 2, fully data-driven. One module launches every engine whose
// descriptor says `adapter: "docker-template"`; the shipped ones are the
// experimental lmdeploy, trtllm and tabbyapi, and a custom engine in
// <AI_ROOT>/config/engines/ uses the same code. What the engine's command line,
// environment and config files look like is the descriptor's `template`
// (grammar and validation in ../template-grammar.js).
//
// Safety rules, all enforced here at render time:
//   - a value is exactly one argv token: nothing is split, joined or shell-parsed;
//   - a token that comes from a placeholder never starts with "-" unless the
//     value is a number or the flag uses format "equals" (template_value_flag_injection);
//   - NUL, CR and LF never reach an argv token or an environment value;
//   - a path-typed value must resolve under the model storage roots
//     (ctx.toContainerPath throws outside them) and becomes a container path;
//   - the API key reaches the engine only the way descriptor.secrets.apiKey says:
//     a flag (redacted everywhere), an env var passed by name, a secret file, or
//     not at all, in which case the port is published on loopback only.
//
// The docker flags follow the legacy vLLM order (01 §19.1): platform, --pull
// never, --name, --restart, the ai.manager.* labels, --gpus, --ipc, --init,
// --ulimit, the health check, publish, mounts (cache, model, generated files),
// env, then the launch identity labels, --entrypoint and the image.
//
// Pure and synchronous: the generated files are returned in LaunchCommand.files
// and written by the supervisor (../launch-files.js) just before the container
// is created.

const path = require("node:path");
const crypto = require("node:crypto");
const expr = require("../expr");
const grammar = require("../template-grammar");
const memoryModels = require("../memory-models");
const paramCatalog = require("../param-catalog");
const { CANONICAL_METRIC_KEYS } = require("../metrics");
const { launchFileName } = require("../launch-files");
const { applyExtra, envAssignmentFlags, labelFlags, labelsFromFlags, launchLabelFlags } = require("./_docker-segments");
const { buildWithPartialEffects, effectivePlan } = require("./_vllm-manager");

const ADAPTER_ID = "docker-template";
const DEFAULT_HEALTH_START_MINUTES = 60;
const CONTROL_PATTERN = /[\u0000\r\n]/;
const UNSET = Symbol("template.unset");
const DROP = Symbol("template.drop");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function templateError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  Object.assign(error, extra);
  return error;
}

function isUnsetValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function positiveInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function startPeriodMinutes(timeoutMs) {
  const configured = Number(timeoutMs || DEFAULT_HEALTH_START_MINUTES * 60 * 1000);
  return Math.min(60, Math.max(5, Math.round(Math.max(5 * 60 * 1000, configured) / 60000)));
}

// ---------------------------------------------------------------------------
// Values and scope
// ---------------------------------------------------------------------------

/**
 * The effective values of a launch: the catalog's literal platform default for
 * every parameter the plan leaves unset, under the plan's own values. Defaults
 * that are expressions are left to the engine.
 */
function valuesWithDefaults(values, catalog) {
  const out = { ...values };
  for (const param of catalog?.params || []) {
    if (!isUnsetValue(out[param.id]) || out[param.id] === false || out[param.id] === 0) continue;
    const fallback = param.platformDefault;
    if (fallback !== undefined && fallback !== null && !isPlainObject(fallback)) out[param.id] = fallback;
  }
  return out;
}

function catalogFor(ctx, descriptor) {
  if (ctx.catalog) return ctx.catalog;
  try {
    return paramCatalog.getParamCatalog().loadCatalog(descriptor.id, ctx.runtime ? { runtime: ctx.runtime } : {});
  } catch {
    return null;
  }
}

/**
 * The scope a template renders in. resolve(name) gives a raw value (undefined
 * when unset); isPath(name) says whether it is a model-storage path that must be
 * confined; the rest is what the grammar's reserved names read.
 */
function createScope({ descriptor, plan, ctx, values, catalog, targets, secrets }) {
  const model = ctx.model || {};
  const instance = plan.instance || {};
  const host = ctx.host || {};
  const gpuIds = (typeof ctx.normalizeGpuIds === "function" ? ctx.normalizeGpuIds(instance.gpuIds) : instance.gpuIds) || [];
  const reserved = {
    "model.containerPath": () => model.containerPath ?? model.modelArg,
    "model.ref": () => model.ref ?? plan.model?.ref,
    servedName: () => values.servedName,
    "host.containerPort": () => host.containerPort ?? descriptor.host?.containerPort,
    "gpu.ids": () => (gpuIds.length ? gpuIds.map(String).join(",") : undefined),
    "gpu.count": () => (gpuIds.length || undefined),
    "instance.id": () => instance.id || "primary",
  };
  const byId = catalog?.byId || new Map();
  return {
    values,
    toContainerPath: ctx.toContainerPath,
    resolve(name, item) {
      const canonical = grammar.canonicalName(name);
      const kind = grammar.classifyName(name);
      if (kind === "reserved") return reserved[canonical]();
      if (kind === "file") return targets.get(name.slice("file.".length));
      if (kind === "item") {
        if (name === "item") return item;
        return isPlainObject(item) ? item[name.slice("item.".length)] : undefined;
      }
      if (kind === "secret") return name === "secrets.apiKey" ? secrets.apiKey() : secrets.adminKey();
      return values[name];
    },
    isPath(name) {
      const kind = grammar.classifyName(name);
      if (kind === "item") return name === "item.path";
      if (kind !== "param") return false;
      const param = byId.get(name);
      return param?.type === "path" || param?.emit?.transform === "containerPath";
    },
    param(id) {
      return Object.hasOwn(values, id) && values[id] !== undefined ? values[id] : null;
    },
  };
}

function absolutePath(text) {
  return path.isAbsolute(text) || path.posix.isAbsolute(text) || path.win32.isAbsolute(text);
}

// One placeholder's value as the template uses it, UNSET when it has none.
function placeholderValue(part, scope, item) {
  let value = scope.resolve(part.name, item);
  if (isUnsetValue(value)) return UNSET;
  if (scope.isPath(part.name)) {
    const text = String(value);
    if (CONTROL_PATTERN.test(text)) throw templateError("template_value_invalid", `The value of {{${part.name}}} contains a control character.`);
    if (!absolutePath(text)) throw templateError("template_path_outside_storage", `The path for {{${part.name}}} must be absolute and inside a registered model storage root.`, { field: part.name });
    try {
      value = String(scope.toContainerPath(text));
    } catch {
      throw templateError("template_path_outside_storage", `The path for {{${part.name}}} must be inside a registered model storage root.`, { field: part.name });
    }
  }
  if (part.filter) {
    if (typeof value !== "string") throw templateError("template_value_invalid", `{{${part.name}|${part.filter}}} needs a path.`);
    value = part.filter === "dir" ? path.posix.dirname(value) : path.posix.basename(value);
  }
  return value;
}

function scalarText(value, name) {
  if (value !== null && typeof value === "object") {
    throw templateError("template_value_invalid", `{{${name}}} is a list or an object and cannot become one argument.`, { field: name });
  }
  const text = String(value);
  if (CONTROL_PATTERN.test(text)) throw templateError("template_value_invalid", `The value of {{${name}}} contains a control character.`, { field: name });
  return text;
}

/**
 * A template string → one argv token, or UNSET when a placeholder has no value.
 * checkDash: the token must not start with "-" when a placeholder made it
 * (numbers excepted), so a user value can never become a flag.
 */
function renderToken(parsed, scope, item, { checkDash = true } = {}) {
  let out = "";
  let sole = null;
  let placeholders = 0;
  for (const part of parsed.parts) {
    if (!part.name) {
      out += part.text;
      continue;
    }
    placeholders += 1;
    const value = placeholderValue(part, scope, item);
    if (value === UNSET) return UNSET;
    sole = parsed.parts.length === 1 ? value : null;
    out += scalarText(value, part.name);
  }
  if (CONTROL_PATTERN.test(out)) throw templateError("template_value_invalid", "A template token contains a control character.");
  if (checkDash && placeholders && out.startsWith("-") && typeof sole !== "number") {
    throw templateError("template_value_flag_injection", `The value "${out.slice(0, 48)}" starts with "-" and would be read as a flag; refused.`, { value: out.slice(0, 48) });
  }
  return out;
}

const parsedCache = new Map();
function parse(text) {
  if (!parsedCache.has(text)) {
    const parsed = grammar.parseTemplateString(text);
    if (parsed.errors.length) throw templateError("template_placeholder_syntax", parsed.errors[0].message);
    if (parsedCache.size > 2048) parsedCache.clear();
    parsedCache.set(text, parsed);
  }
  return parsedCache.get(text);
}

const whenCache = new WeakMap();
function evaluateWhen(ast, scope) {
  let compiled = whenCache.get(ast);
  if (!compiled) {
    compiled = expr.compileExpr(ast, { envAllowlist: [] });
    whenCache.set(ast, compiled);
  }
  if (!compiled.ok) throw templateError("template_when_invalid", compiled.errors[0]?.message || "The when expression is invalid.");
  const result = compiled.run({ param: (id) => scope.param(id), user: (id) => scope.param(id), fact: () => undefined, env: () => undefined });
  return result === true;
}

// ---------------------------------------------------------------------------
// args and env
// ---------------------------------------------------------------------------

/** One args item → its tokens, [] when it renders nothing, or UNSET (a string item with no value, inside a group). */
function renderItem(item, scope, flagFormat, element) {
  if (typeof item === "string") {
    const token = renderToken(parse(item), scope, element);
    return token === UNSET ? UNSET : [token];
  }
  if (Object.hasOwn(item, "flag")) {
    const equals = (item.format || flagFormat) === "equals";
    const value = renderToken(parse(item.value), scope, element, { checkDash: !equals });
    if (value === UNSET) return [];
    return equals ? [`${item.flag}=${value}`] : [item.flag, value];
  }
  if (item.when !== undefined && !evaluateWhen(item.when, scope)) return [];
  if (item.repeat === undefined) return renderGroup(item.args, scope, flagFormat, element) || [];
  const list = placeholderValue(parse(item.repeat).parts[0], scope, element);
  if (list === UNSET || !Array.isArray(list)) return [];
  return list.flatMap((entry) => renderGroup(item.args, scope, flagFormat, entry) || []);
}

// A group renders as a unit: a string token without a value drops the whole instance.
function renderGroup(items, scope, flagFormat, element) {
  const tokens = [];
  for (const item of items) {
    const rendered = renderItem(item, scope, flagFormat, element);
    if (rendered === UNSET) return null;
    tokens.push(...rendered);
  }
  return tokens;
}

function renderArgs(template, scope) {
  const flagFormat = template.flagFormat || "space";
  const args = [];
  for (const item of template.args || []) {
    const rendered = renderItem(item, scope, flagFormat, undefined);
    if (rendered !== UNSET) args.push(...rendered);
  }
  return args;
}

function renderEnv(template, scope) {
  const env = {};
  for (const [name, text] of Object.entries(template.env || {})) {
    const value = renderToken(parse(text), scope, undefined, { checkDash: false });
    if (value !== UNSET) env[name] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

function renderContent(value, scope, state) {
  if (typeof value === "string") {
    const parsed = parse(value);
    if (!parsed.parts.some((part) => part.name)) return value;
    const sole = parsed.parts.length === 1 && parsed.parts[0].name ? parsed.parts[0] : null;
    if (sole) {
      const rendered = placeholderValue(sole, scope, undefined);
      if (rendered === UNSET) {
        state.dropped = true;
        return DROP;
      }
      return rendered;
    }
    const token = renderToken(parsed, scope, undefined, { checkDash: false });
    if (token === UNSET) {
      state.dropped = true;
      return DROP;
    }
    return token;
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderContent(item, scope, state)).filter((item) => item !== DROP);
  }
  if (isPlainObject(value)) {
    const out = {};
    let droppedHere = false;
    for (const [key, item] of Object.entries(value)) {
      const before = state.dropped;
      state.dropped = false;
      const rendered = renderContent(item, scope, state);
      if (rendered === DROP) droppedHere = true;
      else if (isPlainObject(rendered) && !Object.keys(rendered).length && state.dropped) droppedHere = true;
      else out[key] = rendered;
      state.dropped = before || state.dropped;
    }
    if (!Object.keys(out).length && droppedHere) {
      state.dropped = true;
      return DROP;
    }
    return out;
  }
  return value;
}

function usesSecret(value) {
  if (typeof value === "string") return parse(value).parts.some((part) => part.name && grammar.classifyName(part.name) === "secret");
  if (Array.isArray(value)) return value.some(usesSecret);
  if (isPlainObject(value)) return Object.values(value).some(usesSecret);
  return false;
}

function renderFiles(template, scope, ctx, descriptor, launchId) {
  const files = [];
  for (const file of template.files || []) {
    if (file.secret === true && usesSecret(file.content)) scope.requireKey();
    const state = { dropped: false };
    const rendered = renderContent(file.content, scope, state);
    const content = rendered === DROP ? (file.format === "text" ? "" : {}) : rendered;
    const launchFiles = ctx.host?.launchFiles;
    if (!launchFiles || typeof launchFiles.hostPathFor !== "function") {
      throw templateError("launch_files_unavailable", `${descriptor.id} writes launch files, but this manager has no launch-files directory.`);
    }
    files.push({
      id: file.id,
      target: file.target,
      format: file.format,
      content,
      secret: file.secret === true,
      hostPath: launchFiles.hostPathFor(launchId, { id: file.id, format: file.format }),
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// buildLaunch
// ---------------------------------------------------------------------------

function engineLabelOf(descriptor) {
  return descriptor.legacy?.engineLabel || descriptor.id;
}

/** Whether the engine may be published beyond loopback (01 §18: unsupported key mode forces loopback). */
function lanAllowed(descriptor) {
  return descriptor.host?.allowLan !== false && descriptor.secrets?.apiKey?.mode !== "unsupported";
}

/**
 * plan + ctx → LaunchCommand. plan: { values, fixed, instance, legacy, recipeId };
 * ctx: { descriptor, runtime, host: { containerPort, config, labelKeys, modelMountArgs,
 * launchFiles }, model, hostFacts, secrets: { apiKey, apiKeyRef }, extra, jobId,
 * admission, launchId, toContainerPath, dockerGpuArg, dockerPublishArgs(port, access,
 * host, containerPort), publishArgsToDockerRunArgs, normalizeGpuIds, lanAddress,
 * catalog? }. Throws { code, status: 400 } for a template or value problem, and
 * { code: "blocked" } never (an experimental engine has no recipes).
 */
function buildLaunch(input, ctx) {
  return buildWithPartialEffects((effects) => buildCommand(effectivePlan(input), ctx, effects));
}

function buildCommand(plan, ctx, effects) {
  const descriptor = ctx.descriptor;
  if (!descriptor || descriptor.adapter !== ADAPTER_ID || !isPlainObject(descriptor.template)) {
    throw templateError("template_missing", "The docker-template adapter needs a descriptor with a template.");
  }
  const template = descriptor.template;
  const catalog = catalogFor(ctx, descriptor);
  const values = valuesWithDefaults(plan.values || {}, catalog);
  const fixed = plan.fixed || {};
  const instance = plan.instance || {};
  const hostConfig = ctx.host?.config || {};
  const keys = ctx.host?.labelKeys || {};
  const secrets = ctx.secrets || {};
  const admission = ctx.admission || {};
  const logs = effects.logs;
  const image = ctx.runtime?.image;
  if (!image) throw templateError("runtime_image_missing", `${descriptor.id} has no runtime image to launch.`);
  const engineLabel = engineLabelOf(descriptor);
  const keyMode = descriptor.secrets?.apiKey?.mode || "unsupported";
  const apiKey = secrets.apiKey ? String(secrets.apiKey) : "";
  const containerPort = positiveInteger(ctx.host?.containerPort ?? descriptor.host?.containerPort) || 8000;
  const launchId = ctx.launchId || "";

  // Generated secrets exist only inside secret files and the redaction list.
  let adminKey = "";
  const secretValues = [];
  const secretAccess = {
    apiKey() {
      if (!apiKey) return undefined;
      if (!secretValues.includes(apiKey)) secretValues.push(apiKey);
      return apiKey;
    },
    adminKey() {
      if (!adminKey) adminKey = typeof ctx.randomToken === "function" ? String(ctx.randomToken()) : crypto.randomBytes(24).toString("hex");
      if (!secretValues.includes(adminKey)) secretValues.push(adminKey);
      return adminKey;
    },
  };
  const targets = new Map((template.files || []).map((file) => [file.id, file.target]));
  const scope = createScope({ descriptor, plan, ctx, values, catalog, targets, secrets: secretAccess });
  scope.requireKey = () => {
    if (!apiKey) {
      throw templateError("api_key_required", `${descriptor.label?.en || descriptor.id} needs an API key: it is the only way this engine authenticates requests.`, { field: "apiKey" });
    }
  };

  const args = renderArgs(template, scope);
  const templateEnv = renderEnv(template, scope);
  const files = renderFiles(template, scope, ctx, descriptor, launchId);
  const entrypoint = template.entrypoint ? String(template.entrypoint) : null;

  // API key: a flag after the template args (as SGLang's --api-key), an env var
  // passed by name, a secret file (rendered above), or unsupported.
  const secretEnv = {};
  const keyEnvFlags = [];
  if (apiKey && keyMode === "flag") {
    const flag = descriptor.secrets.apiKey.flag;
    args.push(...((descriptor.template.flagFormat === "equals") ? [`${flag}=${apiKey}`] : [flag, apiKey]));
    secretAccess.apiKey();
  } else if (apiKey && keyMode === "env") {
    keyEnvFlags.push("-e", descriptor.secrets.apiKey.env);
    secretEnv[descriptor.secrets.apiKey.env] = apiKey;
    secretAccess.apiKey();
  } else if (apiKey && keyMode === "unsupported") {
    logs.push(`${descriptor.label?.en || descriptor.id} cannot enforce an API key; the key was ignored. The port is published on loopback only: reach the model through the gateway.`);
  }
  if (keyMode === "file") scope.requireKey();

  // Loopback only when the engine cannot protect a LAN port itself.
  const wantsLan = instance.networkAccess === "lan";
  const access = wantsLan && !lanAllowed(descriptor) ? "local" : instance.networkAccess;
  if (wantsLan && access !== "lan") {
    logs.push(`${descriptor.label?.en || descriptor.id} has no API-key support, so LAN publishing is not offered; publishing on 127.0.0.1 only.`);
  }
  const publish = ctx.dockerPublishArgs(instance.port, access, instance.serviceHost, containerPort);
  logs.push(`Docker publish: ${publish.map((arg) => `-p ${arg}`).join(" ")}`);

  const selectedGpuIds = typeof ctx.normalizeGpuIds === "function" ? ctx.normalizeGpuIds(instance.gpuIds) : [];
  const vramReservationMb = Math.max(0, Math.round(Number(admission.vramReservationMb || 0)));
  const fractionParam = descriptor.memoryModel?.fractionParam;
  const fraction = (fractionParam && values[fractionParam]) ?? plan.legacy?.runOptions?.gpuMemoryUtilization ?? 0;
  const host = descriptor.host || {};
  const health = host.healthcheck || null;
  const gpuMode = host.gpus || "required";
  const flags = [
    ...(hostConfig.imagePlatform ? ["--platform", hostConfig.imagePlatform] : []),
    "--pull", "never",
    "--name", instance.containerName || hostConfig.containerName,
    "--restart", host.restart || "on-failure:3",
    "--label", `${keys.manager}=${hostConfig.managerLabelValue}`,
    "--label", `${keys.engine}=${engineLabel}`,
    "--label", `ai.manager.job=${ctx.jobId}`,
    "--label", `ai.manager.instance=${instance.id || "primary"}`,
    "--label", `ai.manager.instance-mode=${instance.mode || "replace"}`,
    "--label", `ai.manager.model=${values.servedName || ""}`,
    "--label", `ai.manager.port=${instance.port}`,
    "--label", `ai.manager.gpu-ids=${selectedGpuIds.join(",")}`,
    "--label", `ai.manager.vram-reservation-mb=${vramReservationMb}`,
    "--label", `ai.manager.max-model-len=${values.contextLength ?? ""}`,
    "--label", `ai.manager.max-num-seqs=${values.concurrency ?? ""}`,
    "--label", "ai.manager.max-num-batched-tokens=0",
    "--label", `ai.manager.gpu-memory-utilization=${fraction}`,
    "--label", `ai.manager.gpu-admission-lease=${admission.leaseId || ""}`,
    ...(gpuMode === "none" ? [] : ["--gpus", ctx.dockerGpuArg(instance.gpuIds || [])]),
    ...(host.ipc ? [`--ipc=${host.ipc}`] : []),
    ...(host.init ? ["--init"] : []),
    ...(host.ulimits || []).flatMap((limit) => ["--ulimit", limit]),
    ...(health ? [
      "--health-cmd", health.cmd,
      "--health-interval", health.interval,
      "--health-timeout", health.timeout,
      "--health-retries", String(health.retries),
      "--health-start-period", health.startPeriod || `${startPeriodMinutes(ctx.hostFacts?.env?.VLLM_START_TIMEOUT_MS)}m`,
    ] : []),
    ...ctx.publishArgsToDockerRunArgs(publish),
  ];
  for (const mount of host.cacheMounts || []) {
    if (hostConfig[mount.configKey]) flags.push("-v", `${hostConfig[mount.configKey]}:${mount.target}`);
  }
  // Experimental images only read the weights; the model library is read-only to them.
  flags.push(...(ctx.host?.modelMountArgs || []).map((arg, index) => (index % 2 === 1 ? `${arg}:ro` : arg)));
  for (const file of files) flags.push("-v", `${file.hostPath}:${file.target}:ro`);
  flags.push(...labelFlags(fixed.labels), ...(fixed.dockerFlags || []));
  if (secrets.apiKeyRef && keys.apiKeyRef) flags.push("--label", `${keys.apiKeyRef}=${secrets.apiKeyRef}`);
  if (access === "lan" && !apiKey) {
    logs.push(`安全警告：服务将通过 Docker 发布到 ${instance.serviceHost || (typeof ctx.lanAddress === "function" ? ctx.lanAddress() : "局域网")}（局域网可访问），但没有设置 API Key。同一网络内的任何设备都可以调用该模型。建议在启动参数中填写 API Key。`);
  }
  if (selectedGpuIds.length) logs.push(`GPU isolation: --gpus device=${selectedGpuIds.join(",")}`);
  flags.push(...keyEnvFlags);
  flags.push(...envAssignmentFlags(templateEnv), ...envAssignmentFlags(fixed.env));
  flags.push(...launchLabelFlags({
    launchId,
    engineId: descriptor.id,
    recipeId: plan.recipeId ?? plan.recipe?.id,
    runtimeId: ctx.runtime?.runtimeId,
  }));

  const metaPatch = { engine: engineLabel, runtimeImage: image, experimental: descriptor.status === "experimental", networkAccess: access || "local" };
  effects.metaPatch = metaPatch;
  const command = applyExtra({
    host: "docker",
    docker: { flags, entrypoint, image, args },
    publish,
    secretEnv,
    files,
    labels: labelsFromFlags(flags),
    metaPatch,
    logs,
    redactions: secretValues,
  }, ctx.extra);
  return command;
}

// ---------------------------------------------------------------------------
// The rest of the adapter interface (01 §6)
// ---------------------------------------------------------------------------

/** plan + ctx → MemoryEstimate (01 §12): the descriptor's memory model decides. */
function estimateMemory(plan, ctx = {}) {
  const input = effectivePlan(plan);
  const values = valuesWithDefaults(input.values, catalogFor(ctx, ctx.descriptor || {}));
  return memoryModels.estimate(ctx.descriptor.id, memoryModels.inputsFromPlan({ ...input, values }, ctx), { descriptor: ctx.descriptor });
}

function finding(severity, code, zh, en, extra = {}) {
  return { severity, code, title: { zh, en }, detail: { zh, en }, ...extra };
}

function versionParts(text) {
  return String(text || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function computeCapAbove(capability, limit) {
  const a = versionParts(capability);
  const b = versionParts(limit);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  }
  return false;
}

/** → Finding[]: what the plan should tell the user about this launch (01 §6). */
function validate(plan, ctx = {}) {
  const descriptor = ctx.descriptor || {};
  const label = descriptor.label || { zh: descriptor.id, en: descriptor.id };
  const findings = [];
  if (descriptor.status === "experimental") {
    findings.push(finding("warn", "experimental_engine",
      "实验性引擎：未在本机验证，启动前请确认。", "Experimental engine: not verified on this machine; confirm before starting."));
  }
  const verifiedMax = ctx.runtime?.release?.verifiedComputeCapabilityMax;
  const gpus = Array.isArray(ctx.hostFacts?.gpus) ? ctx.hostFacts.gpus : [];
  const selected = new Set((plan?.instance?.gpuIds || []).map(String));
  const relevant = gpus.filter((gpu) => !selected.size || selected.has(String(gpu.id ?? gpu.index)));
  if (verifiedMax && relevant.some((gpu) => computeCapAbove(gpu.computeCapability ?? gpu.computeCap, verifiedMax))) {
    findings.push(finding("warn", "engine_sm120_unverified",
      `${label.zh} 在 SM120（Blackwell 工作站）显卡上未验证，可能无法启动或性能异常。`,
      `${label.en} is not verified on SM120 (Blackwell workstation) GPUs; it may fail to start or run slowly.`));
  }
  if (descriptor.secrets?.apiKey?.mode === "unsupported" && plan?.instance?.networkAccess === "lan") {
    findings.push(finding("warn", "lan_unavailable",
      `${label.zh} 不支持 API Key，端口只发布到本机回环地址，请通过网关访问。`,
      `${label.en} has no API-key support; its port is published on loopback only and is reached through the gateway.`,
      { field: "networkAccess" }));
  }
  return findings;
}

/** The declared capabilities of the launched instance (00 §4.1). */
function declaredCapabilities(plan, ctx = {}) {
  const descriptor = ctx.descriptor || {};
  const roles = Array.isArray(descriptor.capabilities?.roles) ? descriptor.capabilities.roles : [];
  const parsers = descriptor.capabilities?.autoParsers || {};
  const values = effectivePlan(plan).values;
  return {
    text: roles.length ? roles.includes("chat") : true,
    vision: false,
    audio: false,
    embedding: roles.includes("embedding") && !roles.includes("chat"),
    rerank: roles.includes("rerank") && !roles.includes("chat"),
    tools: Boolean(parsers.tool) || Boolean(values.toolCallParser && values.toolCallParser !== "none"),
    reasoning: Boolean(parsers.reasoning) || Boolean(values.reasoningParser && values.reasoningParser !== "none"),
    maxContext: positiveInteger(values.contextLength) || null,
  };
}

// --- JSON metrics (descriptor.metricsMap.format "json", 01 §16.1) ------------

function readPath(source, dotted) {
  let current = source;
  for (const part of String(dotted).split(".")) {
    if (!isPlainObject(current) || !Object.hasOwn(current, part)) return null;
    current = current[part];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

/**
 * A JSON metrics payload → the models/unsupported shape metrics.js summarizes.
 * The payload is an object, or a list of snapshots whose last element is the
 * newest (TensorRT-LLM's iteration stats). The mapping is the descriptor's:
 * {pick: "a.b"} reads a number, {ratio: ["a", "b"]} divides two.
 */
function mapMetrics(payload, ctx = {}) {
  const map = isPlainObject(ctx.descriptor?.metricsMap?.map) ? ctx.descriptor.metricsMap.map : {};
  const snapshot = Array.isArray(payload) ? payload[payload.length - 1] : payload;
  const model = { model: ctx.defaultModel || null, counters: {}, gauges: {}, histograms: {} };
  const unsupported = [];
  for (const group of ["counters", "gauges", "histograms"]) {
    for (const key of CANONICAL_METRIC_KEYS[group]) {
      let value = null;
      for (const source of Array.isArray(map[key]) ? map[key] : []) {
        if (!isPlainObject(snapshot)) break;
        if (typeof source.pick === "string") value = readPath(snapshot, source.pick);
        else if (Array.isArray(source.ratio)) {
          const numerator = readPath(snapshot, source.ratio[0]);
          const denominator = readPath(snapshot, source.ratio[1]);
          value = numerator !== null && denominator ? numerator / denominator : null;
        }
        if (value !== null) break;
      }
      model[group][key] = value;
      if (value === null) unsupported.push(`${group}.${key}`);
    }
  }
  return { processStartSeconds: null, models: [model], unsupported };
}

/** async; GET the version endpoints the descriptor lists → { version, raw } or null. */
async function probeVersion(endpoint, fetchImpl = globalThis.fetch, descriptor = null) {
  const paths = descriptor?.api?.version || [];
  for (const versionPath of paths) {
    try {
      const response = await fetchImpl(`${String(endpoint).replace(/\/+$/, "")}${versionPath}`, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) continue;
      const text = await response.text();
      let raw = text;
      try { raw = JSON.parse(text); } catch { /* plain text version */ }
      const version = isPlainObject(raw) ? String(raw.version ?? raw.Version ?? "") : String(raw).trim().replace(/^"|"$/g, "");
      if (version) return { version, raw };
    } catch {
      // try the next path
    }
  }
  return null;
}

module.exports = {
  id: ADAPTER_ID,
  buildLaunch,
  declaredCapabilities,
  estimateMemory,
  lanAllowed,
  mapMetrics,
  probeVersion,
  validate,
  valuesWithDefaults,
};
