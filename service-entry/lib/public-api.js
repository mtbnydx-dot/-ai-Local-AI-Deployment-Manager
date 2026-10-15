"use strict";

// The public API surface (docs/overhaul/05-public.md §8, PUB-12).
//
// public-listener.js classifies a PUBLIC request with mapPublicRoute() (the
// §8.1 route mapping table); the entry's gateway code then runs the request
// through the shared pipeline (gateway-pipeline.js). This module owns what
// is specific to the public surface:
//
//   mapPublicRoute / gatewayPathFor / parseGatewayRoute   the route table
//   applyOutputCap                      §8.2 step 10 (max_tokens inject/reject)
//   buildModelEntries / modelsDocument  §8.3 the enriched /v1/models
//   createPublicApi                     dispatch, the model lists and alias
//                                       resolution, wired by server.js
//
// Nothing here may leak internals: the model documents carry no engine,
// manager, instance, container, port or path.

const modelFleet = require("./model-fleet");
const { displayNames, instanceState, modelFacts, publicId } = require("./status-sampler");
const { pickLanguage, sendPublicError } = require("./public-errors");

const PROTOCOLS = new Set(["openai", "claude", "opencode"]);
// tts, mcp and search are gateway namespaces of their own, never engine ids.
const RESERVED_GATEWAY_SEGMENTS = new Set(["tts", "mcp", "search", "health", "status", "me"]);
const ENGINE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

// Endpoint -> scope (05 §6.3).
const OPENAI_POST_ENDPOINTS = Object.freeze({
  "chat/completions": "chat",
  completions: "completions",
  responses: "responses",
  embeddings: "embeddings",
  rerank: "embeddings",
  score: "embeddings",
});
const ME_ROUTES = Object.freeze({
  "": { methods: ["GET"], scope: "self.read" },
  usage: { methods: ["GET"], scope: "self.read" },
  "usage.csv": { methods: ["GET"], scope: "self.read" },
  requests: { methods: ["GET"], scope: "self.read" },
  rotate: { methods: ["POST"], scope: "self.rotate" },
  origins: { methods: ["PUT"], scope: "self.origins" },
});
// The three OpenAI-form prefixes and the engine filter of each (§8.1). The
// Anthropic prefix is the claude protocol on auto.
const OPENAI_PREFIXES = Object.freeze([
  { prefix: "/vllm/v1", engine: "vllm", base: "/gateway/vllm" },
  { prefix: "/llama/v1", engine: "llama", base: "/gateway/llama" },
  { prefix: "/v1", engine: "auto", base: "/gateway/auto" },
]);
const ANTHROPIC_PREFIX = "/anthropic/v1";

const OUTPUT_FIELDS = Object.freeze(["max_completion_tokens", "max_output_tokens", "max_tokens"]);
// Scopes whose requests produce tokens, so a per-key output cap applies.
const OUTPUT_SCOPES = new Set(["chat", "completions", "responses", "messages"]);

function upper(value) {
  return String(value || "GET").toUpperCase();
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// ---------------------------------------------------------------------------
// Route mapping (§8.1)

// The scope a model-gateway route needs (05 §6.3); the same rule as
// gateway-pipeline.js scopeForModelRoute, which a test holds this equal to.
function scopeForRest(protocol, method, rest) {
  const verb = upper(method);
  const clean = String(rest || "").replace(/^\/+|\/+$/g, "").toLowerCase();
  const listing = (verb === "GET" || verb === "HEAD") && (clean === "models" || clean === "v1/models" || clean.startsWith("v1/models/") || clean.startsWith("models/"));
  if (listing) return "models.read";
  if (protocol === "claude") return "messages";
  if (protocol === "opencode") return "chat";
  const tail = clean.replace(/^v1\//, "");
  if (tail === "completions") return "completions";
  if (tail === "responses" || tail.startsWith("responses/")) return "responses";
  if (tail === "embeddings" || tail === "rerank" || tail === "score") return "embeddings";
  if (tail === "messages" || tail.startsWith("messages/")) return "messages";
  return "chat";
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * parseGatewayRoute(pathname) -> { engine, protocol, rest, engineId?, externalId? } | null
 * /gateway/{auto|vllm|llama}/{openai|claude|opencode}/…, plus the 00 §5 forms
 * /gateway/<engineId>/… and /gateway/external/<endpointId>/…. For the two
 * new forms `engine` is "auto" and the filter rides in engineId/externalId.
 */
function parseGatewayRoute(pathname) {
  const parts = String(pathname || "").split("/");
  // ["", "gateway", first, ...]
  if (parts[0] !== "" || parts[1] !== "gateway" || parts.length < 4) return null;
  const first = parts[2];
  let engine = "auto";
  let engineId = "";
  let externalId = "";
  let protocolIndex = 3;
  if (["auto", "vllm", "llama"].includes(first)) {
    engine = first;
  } else if (first === "external") {
    if (parts.length < 5 || !ENGINE_SEGMENT.test(parts[3])) return null;
    externalId = parts[3];
    protocolIndex = 4;
  } else if (!RESERVED_GATEWAY_SEGMENTS.has(first.toLowerCase()) && ENGINE_SEGMENT.test(first)) {
    engineId = first;
  } else {
    return null;
  }
  const protocol = parts[protocolIndex];
  if (!PROTOCOLS.has(protocol)) return null;
  const route = { engine, protocol, rest: parts.slice(protocolIndex + 1).join("/") };
  if (engineId) route.engineId = engineId;
  if (externalId) route.externalId = externalId;
  return route;
}

function apiPrefixOf(path) {
  for (const item of OPENAI_PREFIXES) {
    if (path === item.prefix || path.startsWith(`${item.prefix}/`)) return { ...item, rest: path.slice(item.prefix.length) };
  }
  if (path === ANTHROPIC_PREFIX || path.startsWith(`${ANTHROPIC_PREFIX}/`)) {
    return { prefix: ANTHROPIC_PREFIX, engine: "auto", base: "/gateway/auto", anthropic: true, rest: path.slice(ANTHROPIC_PREFIX.length) };
  }
  return null;
}

// The route (without the method check) a path names, or null.
function describePath(path) {
  if (path === "/gateway/status" || path === "/gateway/status/") {
    return { family: "status", scope: "models.read", engine: "auto", protocol: null, errors: "openai", gatewayPath: "/gateway/status", methods: ["GET"] };
  }
  if (path === "/gateway/me") {
    return { family: "me", scope: "self.read", engine: "auto", protocol: null, errors: "openai", gatewayPath: "/gateway/me", methods: ["GET"], meRoute: "" };
  }
  if (path === "/gateway/tts/openai/v1/audio/speech") {
    return { family: "tts", scope: "audio.speech", engine: "auto", protocol: null, errors: "openai", gatewayPath: path, methods: ["POST"] };
  }
  if (path.startsWith("/gateway/")) {
    const route = parseGatewayRoute(path);
    if (!route) return null;
    return {
      family: "gateway",
      scope: null,
      engine: route.engine,
      ...(route.engineId ? { engineId: route.engineId } : {}),
      ...(route.externalId ? { externalId: route.externalId } : {}),
      protocol: route.protocol,
      errors: route.protocol === "claude" ? "anthropic" : "openai",
      gatewayPath: path,
      rest: route.rest,
      methods: null,
    };
  }
  const found = apiPrefixOf(path);
  if (!found) return null;
  const rest = found.rest.replace(/\/+$/, "");
  const model = rest.match(/^\/models\/(.+)$/);
  const common = { engine: found.engine, errors: "openai" };
  const openaiBase = `${found.base}/openai`;
  const claudeBase = `${found.base}/claude`;
  if (rest === "/models" || model) {
    const anthropic = Boolean(found.anthropic);
    return {
      ...common,
      family: model ? "model" : "models",
      scope: "models.read",
      protocol: anthropic ? "claude" : "openai",
      errors: anthropic ? "anthropic" : "openai",
      gatewayPath: `${anthropic ? claudeBase : openaiBase}/v1${rest}`,
      methods: ["GET"],
      ...(model ? { modelId: safeDecode(model[1]) } : {}),
    };
  }
  if (rest === "/messages" || rest === "/messages/count_tokens") {
    return { ...common, family: "messages", scope: "messages", protocol: "claude", errors: "anthropic", gatewayPath: `${claudeBase}/v1${rest}`, methods: ["POST"] };
  }
  if (found.anthropic) return null;
  const endpoint = rest.slice(1);
  if (Object.hasOwn(OPENAI_POST_ENDPOINTS, endpoint)) {
    return { ...common, family: "inference", scope: OPENAI_POST_ENDPOINTS[endpoint], protocol: "openai", gatewayPath: `${openaiBase}/v1${rest}`, methods: ["POST"], endpoint };
  }
  // Speech and /v1/me exist on the unified prefix only.
  if (found.prefix === "/v1") {
    if (rest === "/audio/speech") {
      return { ...common, family: "tts", scope: "audio.speech", protocol: null, gatewayPath: "/gateway/tts/openai/v1/audio/speech", methods: ["POST"] };
    }
    if (rest === "/me" || rest.startsWith("/me/")) {
      const key = rest === "/me" ? "" : rest.slice(4);
      const item = Object.hasOwn(ME_ROUTES, key) ? ME_ROUTES[key] : null;
      if (item) return { ...common, family: "me", scope: item.scope, protocol: null, gatewayPath: `/gateway/me${key ? `/${key}` : ""}`, methods: [...item.methods], meRoute: key };
    }
  }
  return null;
}

/**
 * mapPublicRoute(method, pathname) ->
 *   null                                         not a public API route
 *   { methodNotAllowed: true, allow, ... }       the path exists, the method does not
 *   { family, scope, engine, protocol, errors, gatewayPath, ... }
 * family: models | model | inference | messages | tts | status | me | gateway.
 * errors: the error shape (§10.1) of the route. gatewayPath is the ADMIN-form
 * path the shared pipeline understands. OPTIONS is allowed everywhere (the
 * preflight is answered by the pipeline), HEAD wherever GET is.
 */
function mapPublicRoute(method, pathname) {
  const path = String(pathname || "/");
  if (path.includes("..") || path.includes("\\") || path.includes("//")) return null;
  const route = describePath(path);
  if (!route) return null;
  const verb = upper(method);
  if (route.family === "gateway" && route.scope === null) route.scope = scopeForRest(route.protocol, verb, route.rest);
  if (!route.methods) return route;
  const allowed = new Set(route.methods);
  if (allowed.has("GET")) allowed.add("HEAD");
  allowed.add("OPTIONS");
  if (allowed.has(verb)) return route;
  return { ...route, methodNotAllowed: true, allow: [...allowed].join(", ") };
}

// The ADMIN-form path of a PUBLIC path, or the path itself.
function gatewayPathFor(path) {
  return mapPublicRoute("GET", path)?.gatewayPath || path;
}

// ---------------------------------------------------------------------------
// max_tokens (§8.2 step 10)

/**
 * applyOutputCap(body, { cap, scope, rest }) ->
 *   { ok: true, body, injected: field|null }       body is a new object when changed
 *   { ok: false, param, requested, cap }           an explicit value above the cap
 * With a cap and no max_tokens / max_completion_tokens / max_output_tokens,
 * the cap is injected (max_output_tokens for /responses, max_tokens
 * otherwise). An explicit value above the cap is refused with the field's
 * name as `param`. Non-token endpoints (embeddings, count_tokens) and bodies
 * that are not objects are left alone.
 */
function applyOutputCap(body, { cap = null, scope = "", rest = "" } = {}) {
  const limit = positive(cap);
  if (limit === null || !body || typeof body !== "object" || Array.isArray(body)) return { ok: true, body, injected: null };
  if (!OUTPUT_SCOPES.has(scope) || /(?:^|\/)count_tokens$/i.test(String(rest || ""))) return { ok: true, body, injected: null };
  let present = false;
  for (const field of OUTPUT_FIELDS) {
    if (body[field] === undefined || body[field] === null) continue;
    present = true;
    const value = Number(body[field]);
    if (Number.isFinite(value) && value > limit) return { ok: false, param: field, requested: value, cap: Math.floor(limit) };
  }
  if (present) return { ok: true, body, injected: null };
  const field = scope === "responses" ? "max_output_tokens" : "max_tokens";
  return { ok: true, body: { ...body, [field]: Math.floor(limit) }, injected: field };
}

// ---------------------------------------------------------------------------
// The enriched model list (§8.3)

const ROLE_RANK = Object.freeze({ ready: 3, starting: 2, sleeping: 1 });
const PRICING_UNIT = "credits_per_million_tokens";

function isSleeping(instance) {
  if (!instance || typeof instance !== "object") return false;
  return instance.sleeping === true
    || String(instance.lifecycle?.state || "").toLowerCase() === "sleeping"
    || String(instance.lifecycleState || "").toLowerCase() === "sleeping";
}

// The public state of an instance's models, or "" when they are not offered.
function publicState(catalog, instance) {
  if (isSleeping(instance)) return "sleeping";
  const state = catalog.running === false && instance?.running !== true ? "offline" : instanceState(instance);
  if (state === "ready") return "ready";
  if (state === "loading") return "starting";
  return "";
}

// Every model the catalogs offer, once per id with its best state:
// { id, source, state, managerId, instance }. `instanceOk(catalog, instance)`
// narrows by the route's engine filter.
function collectEntries(catalogs, { instanceOk = null, modelOk = null } = {}) {
  const byId = new Map();
  const take = (source, state, catalog, instance) => {
    if (!state) return;
    const model = typeof source === "string" ? { id: source } : (source && typeof source === "object" ? source : null);
    const id = model ? publicId(model.id) : "";
    if (!id) return;
    const managerId = String(catalog.manager?.id || catalog.id || "").toLowerCase();
    const lastKnown = modelFleet.isLastKnownModel(model);
    const effective = lastKnown && state === "ready" ? "starting" : state;
    if (modelOk && !modelOk(model, managerId, instance)) return;
    const previous = byId.get(id.toLowerCase());
    if (!previous || ROLE_RANK[effective] > ROLE_RANK[previous.state]) {
      byId.set(id.toLowerCase(), { id, source: model, state: effective, managerId, instance });
    }
  };
  for (const catalog of Array.isArray(catalogs) ? catalogs : []) {
    if (!catalog || typeof catalog !== "object") continue;
    if (Array.isArray(catalog.instances) && catalog.instances.length) {
      for (const instance of catalog.instances) {
        if (instanceOk && !instanceOk(catalog, instance)) continue;
        const state = publicState(catalog, instance);
        for (const model of Array.isArray(instance?.models) ? instance.models : []) take(model, state, catalog, instance);
      }
    } else if (Array.isArray(catalog.models)) {
      const state = catalog.running === false ? "" : "ready";
      for (const model of catalog.models) take(model, state, catalog, null);
    }
  }
  return [...byId.values()];
}

// Decimal credits from a microcredit amount (string or number), with at least
// two decimals and no more than six: "0.50", "2.00", "0.052".
function formatCredits(micro) {
  if (micro === null || micro === undefined || micro === "") return null;
  let value;
  try {
    value = BigInt(typeof micro === "number" ? Math.round(micro) : String(micro).trim());
  } catch {
    return null;
  }
  const negative = value < 0n;
  if (negative) value = -value;
  const whole = value / 1_000_000n;
  let fraction = String(value % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function pricingOf(price) {
  if (!price || typeof price !== "object") return null;
  const input = formatCredits(price.input ?? price.inputPerMillionMicrocredits);
  const output = formatCredits(price.output ?? price.outputPerMillionMicrocredits);
  const cached = formatCredits(price.cachedInput ?? price.cachedInputPerMillionMicrocredits);
  if (input === null && output === null) return null;
  return { unit: PRICING_UNIT, input: input ?? "0.00", cached_input: cached ?? input ?? "0.00", output: output ?? "0.00" };
}

function surfaceOf(source, instance, capabilities) {
  const surface = instance?.apiSurface && typeof instance.apiSurface === "object" ? instance.apiSurface : {};
  const text = capabilities.includes("text") || capabilities.includes("tools");
  const pick = (name, fallback) => (typeof surface[name] === "boolean" ? surface[name] : fallback);
  return {
    chat: pick("chat", text),
    completions: pick("completions", text),
    responses: pick("responses", text),
    messages: pick("messages", text),
    embeddings: pick("embeddings", capabilities.includes("embedding")),
  };
}

function reasoningControls(source, instance) {
  const toggle = source?.controls?.reasoningToggle
    || source?.card?.controls?.reasoningToggle
    || instance?.controls?.reasoningToggle
    || null;
  if (!toggle || typeof toggle !== "object" || !toggle.on || !toggle.off) return null;
  return { reasoning_toggle: { on: toggle.on, off: toggle.off } };
}

function createdOf(source, meta) {
  const created = Number(source?.created);
  if (Number.isFinite(created) && created > 0) return Math.floor(created);
  const updated = Date.parse(meta?.updatedAt || "");
  return Number.isFinite(updated) ? Math.floor(updated / 1000) : 0;
}

/**
 * buildModelEntries({ catalogs, metaList, limits, showPrices, getPrice,
 *   ttsModels, language, instanceOk, modelOk }) -> entry[]
 * One entry per distinct model id, in the §8.3 shape. `limits` is
 * { rpm, tpm, outputCap } of the caller; `modelOk(model, managerId, instance)`
 * applies the caller's key filters; `getPrice(model, managerId)` returns
 * { input, cachedInput, output } in microcredits per million tokens or null.
 */
function buildModelEntries({ catalogs = [], metaList = [], limits = {}, showPrices = true, getPrice = null, ttsModels = [], language = "en-US", instanceOk = null, modelOk = null } = {}) {
  const metaById = new Map((Array.isArray(metaList) ? metaList : []).map((meta) => [String(meta.modelId).toLowerCase(), meta]));
  const hiddenIds = new Set([...metaById.values()].filter((meta) => meta.hidden).map((meta) => String(meta.modelId).toLowerCase()));
  const outputCap = positive(limits.outputCap);
  const limitsView = { rpm: limits.rpm ?? null, tpm: limits.tpm ?? null, max_output_tokens: outputCap === null ? null : Math.floor(outputCap) };
  const entries = [];
  for (const item of collectEntries(catalogs, { instanceOk, modelOk })) {
    const lower = item.id.toLowerCase();
    if (hiddenIds.has(lower)) continue;
    const meta = metaById.get(lower) || null;
    const facts = modelFacts({ id: item.id, source: item.source });
    const declared = item.instance?.declaredCapabilities && typeof item.instance.declaredCapabilities === "object" ? item.instance.declaredCapabilities : {};
    const capabilityNames = modelFleet.inferModelCapabilities(item.source);
    const surface = surfaceOf(item.source, item.instance, capabilityNames);
    const names = displayNames({ id: item.id, meta });
    const context = positive(declared.maxContext) ?? facts.context;
    const modelMax = facts.maxOutput;
    const generates = surface.chat || surface.completions || surface.responses || surface.messages;
    const maxOutput = !generates ? null
      : modelMax !== null && outputCap !== null ? Math.min(modelMax, Math.floor(outputCap))
        : (modelMax ?? (outputCap === null ? null : Math.floor(outputCap)));
    const controls = reasoningControls(item.source, item.instance);
    const entry = {
      id: item.id,
      object: "model",
      created: createdOf(item.source, meta),
      owned_by: "local",
      display_name: language === "zh-CN" ? names["zh-CN"] : names["en-US"],
      aliases: Array.isArray(meta?.aliases) ? meta.aliases.slice(0, 20) : [],
      family: facts.family,
      parameters: facts.parameters,
      quantization: facts.quantization,
      context_length: context === null ? null : Math.floor(context),
      max_output_tokens: maxOutput,
      capabilities: {
        chat: surface.chat,
        completions: surface.completions,
        responses: surface.responses,
        messages: surface.messages,
        embeddings: surface.embeddings,
        vision: facts.modalities.includes("vision") || declared.vision === true,
        tools: facts.tools || declared.tools === true,
        reasoning: facts.reasoning || declared.reasoning === true,
        audio_speech: false,
      },
      ...(controls ? { controls } : {}),
      state: item.state,
    };
    if (showPrices && typeof getPrice === "function") {
      let pricing = null;
      try {
        pricing = pricingOf(getPrice({ id: item.id, source: item.source }, item.managerId));
      } catch {
        pricing = null;
      }
      if (pricing) entry.pricing = pricing;
    }
    entry.limits = { ...limitsView };
    entries.push(entry);
  }
  entries.sort((a, b) => ((metaById.get(a.id.toLowerCase())?.sort ?? 0) - (metaById.get(b.id.toLowerCase())?.sort ?? 0)) || a.id.localeCompare(b.id));
  const seen = new Set(entries.map((entry) => entry.id.toLowerCase()));
  for (const tts of Array.isArray(ttsModels) ? ttsModels : []) {
    const id = publicId(tts?.id);
    if (!id || seen.has(id.toLowerCase()) || hiddenIds.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    entries.push({
      id,
      object: "model",
      created: 0,
      owned_by: "local",
      display_name: String(tts.name || id),
      aliases: [],
      family: null,
      parameters: null,
      quantization: null,
      context_length: null,
      max_output_tokens: null,
      capabilities: { chat: false, completions: false, responses: false, messages: false, embeddings: false, vision: false, tools: false, reasoning: false, audio_speech: true },
      state: "ready",
      limits: { ...limitsView },
    });
  }
  return entries;
}

function openAiModelsDocument(entries) {
  return { object: "list", data: entries };
}

function anthropicModelsDocument(entries) {
  const data = entries.map((entry) => ({
    type: "model",
    id: entry.id,
    display_name: entry.display_name,
    created_at: new Date((entry.created || 0) * 1000).toISOString(),
    ...(entry.context_length ? { max_input_tokens: entry.context_length } : {}),
    ...(entry.max_output_tokens ? { max_tokens: entry.max_output_tokens } : {}),
  }));
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null };
}

function anthropicModelObject(entry) {
  return anthropicModelsDocument([entry]).data[0];
}

// What kind of model read a gateway route is, or null: { kind: "list" }
// or { kind: "one", id }. Both the OpenAI-form and (when `anthropic`) the
// claude-protocol forms; the caller decides which protocols it accepts.
function modelReadOf(method, route, { anthropic = false } = {}) {
  if (!["GET", "HEAD"].includes(upper(method))) return null;
  const protocols = anthropic ? ["openai", "opencode", "claude"] : ["openai", "opencode"];
  if (!protocols.includes(route?.protocol)) return null;
  const rest = String(route.rest || "").replace(/^\/+|\/+$/g, "");
  if (rest === "models" || rest === "v1/models") return { kind: "list" };
  const one = rest.match(/^(?:v1\/)?models\/(.+)$/);
  if (one) return { kind: "one", id: safeDecode(one[1]) };
  return null;
}

// The context JSON of hop v2 (04 §5.2): the source program and the trusted
// country. Never the key, the customer or the user agent.
function entryContextOf(req, identity, inferSourceProgram) {
  const headers = req?.headers || {};
  const first = (name) => {
    const value = headers[name];
    return String(Array.isArray(value) ? value[0] : value || "");
  };
  let src = "";
  try {
    src = String(inferSourceProgram({
      xTitle: first("x-title"),
      aiClient: first("x-ai-client"),
      userAgent: first("user-agent"),
      path: String(req?.url || "").split("?")[0],
      origin: first("origin"),
      referer: first("referer"),
    }) || "");
  } catch {
    src = "";
  }
  const context = { v: 1 };
  if (src) context.src = src.slice(0, 40);
  const country = String(identity?.country || "").toUpperCase();
  if (/^[A-Z]{2}$/.test(country)) context.cc = country;
  return context;
}

// ---------------------------------------------------------------------------
// The module wired by server.js

/**
 * createPublicApi({ pipeline, getCatalogs, store, config, limiter, getPrice,
 *   getTtsModels, sendJson, handlers, now, logger })
 *   pipeline     the gateway pipeline (object or getter)
 *   getCatalogs  (managers) -> Promise<catalog[]>
 *   store        the access store (object or getter): modelMeta.list()
 *   config       live AccessConfig (object or getter)
 *   limiter      createLimiter() result: describeLimits()
 *   getPrice     (caller, { id, source }, managerId) -> price|null
 *   getTtsModels () -> Promise<[{ id, name? }]>
 *   handlers     { gateway, status, tts, me }(req, res, url, route): the
 *                transport side, in server.js
 * -> { handle, sendModels, resolveAlias, buildModels }
 */
function createPublicApi(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const handlers = deps.handlers || {};
  let metaCache = { at: -Infinity, list: [] };

  const pipelineOf = () => (typeof deps.pipeline === "function" ? deps.pipeline() : deps.pipeline);
  const configOf = () => {
    const value = typeof deps.config === "function" ? deps.config() : deps.config;
    return value && typeof value === "object" ? value : {};
  };
  const storeOf = () => (typeof deps.store === "function" ? deps.store() : deps.store);

  // The public_model_meta rows, read at most every 2 s.
  function metaList() {
    const at = now();
    if (at - metaCache.at < 2000) return metaCache.list;
    let list = [];
    try {
      const store = storeOf();
      list = store?.modelMeta?.list ? store.modelMeta.list() : (typeof store?.listModelMeta === "function" ? store.listModelMeta() : []);
    } catch (error) {
      deps.logger?.warn?.(`public model meta: ${error?.code || error?.message || "unreadable"}`);
      list = [];
    }
    metaCache = { at, list: Array.isArray(list) ? list : [] };
    return metaCache.list;
  }

  // §8.1: a public alias becomes the model id it names before routing. A real
  // fleet model with that id wins, so an alias never hides a model.
  function resolveAlias(requested, { catalogs = [] } = {}) {
    const value = String(requested || "").trim().toLowerCase();
    if (!value || modelFleet.GENERIC_MODEL_IDS.includes(value)) return "";
    for (const catalog of catalogs) {
      for (const model of Array.isArray(catalog?.models) ? catalog.models : []) {
        const ids = [model?.id, model?.root, ...(Array.isArray(model?.aliases) ? model.aliases : [])].map((item) => String(item || "").toLowerCase());
        if (ids.includes(value)) return "";
      }
    }
    for (const meta of metaList()) {
      if ((Array.isArray(meta.aliases) ? meta.aliases : []).some((alias) => String(alias || "").trim().toLowerCase() === value)) {
        return String(meta.modelId || "");
      }
    }
    return "";
  }

  function canSpeak(caller) {
    if (!caller) return false;
    if (caller.kind === "key") return Array.isArray(caller.scopes) && caller.scopes.includes("audio.speech");
    return true;
  }

  async function buildModels({ req, caller, route, catalogs }) {
    const pipeline = pipelineOf();
    const cfg = configOf();
    const listener = pipeline.listenerOf ? pipeline.listenerOf(req) : "public";
    const engineId = String(route?.engineId || "").toLowerCase();
    const externalId = String(route?.externalId || "").toLowerCase();
    const instanceOk = engineId || externalId
      ? (catalog, instance) => {
        const candidate = { managerId: String(catalog.manager?.id || "").toLowerCase(), instance, model: {} };
        if (externalId) return modelFleet.candidateFleetId(candidate).toLowerCase() === `external:${externalId}`;
        return modelFleet.candidateEngineId(candidate) === engineId;
      }
      : null;
    const modelOk = (model, managerId, instance) => pipeline.modelVisible(caller, { ...model, instance_id: instance?.instanceId || instance?.id || model?.instance_id }, managerId);
    const showPrices = cfg.public?.catalog?.showPrices !== false;
    const language = pickLanguage(req?.headers?.["accept-language"]);
    const wantsTts = !engineId && !externalId && route?.engine === "auto" && route?.protocol !== "claude" && cfg.public?.exposeTts !== false && canSpeak(caller) && typeof deps.getTtsModels === "function";
    let ttsModels = [];
    if (wantsTts) {
      try {
        ttsModels = await deps.getTtsModels();
      } catch {
        ttsModels = [];
      }
    }
    const limits = deps.limiter?.describeLimits ? deps.limiter.describeLimits(caller, listener) : {};
    return buildModelEntries({
      catalogs,
      metaList: metaList(),
      limits,
      showPrices,
      getPrice: typeof deps.getPrice === "function" ? (model, managerId) => deps.getPrice(caller, model, managerId) : null,
      ttsModels,
      language,
      instanceOk,
      modelOk,
    });
  }

  // Answers a model list or retrieval (OpenAI or Anthropic shape). The
  // pipeline has already authenticated, rate-limited and scoped the caller.
  async function sendModels(req, res, { route, caller, managers, headers = {} }) {
    const pipeline = pipelineOf();
    const read = modelReadOf(req.method, route, { anthropic: true }) || { kind: "list" };
    const catalogs = await deps.getCatalogs(managers);
    const entries = await buildModels({ req, caller, route, catalogs });
    const anthropic = route?.protocol === "claude";
    if (read.kind === "one") {
      const wanted = String(read.id || "").toLowerCase();
      const found = entries.find((entry) => entry.id.toLowerCase() === wanted || entry.aliases.some((alias) => String(alias).toLowerCase() === wanted));
      if (!found) {
        return pipeline.sendRefusal(req, res, { status: 404, code: "model_not_found", param: "model", message: "The model does not exist or is not available to this key.", headers });
      }
      return deps.sendJson(res, anthropic ? anthropicModelObject(found) : found, 200, headers);
    }
    return deps.sendJson(res, anthropic ? anthropicModelsDocument(entries) : openAiModelsDocument(entries), 200, headers);
  }

  // The PUBLIC key routes (server.js passes the transport handlers). `route`
  // is the classifier's result with the mapping under route.api.
  async function handle(req, res, url, route) {
    const family = route?.api?.family || "gateway";
    if (family === "me") {
      if (typeof handlers.me === "function") return handlers.me(req, res, url, route);
      return sendPublicError(req, res, "not_found", {});
    }
    if (family === "status") return handlers.status(req, res, url, route);
    if (family === "tts") {
      if (configOf().public?.exposeTts === false) return sendPublicError(req, res, "not_found", {});
      return handlers.tts(req, res, url, route);
    }
    return handlers.gateway(req, res, url, route);
  }

  return { handle, sendModels, resolveAlias, buildModels, metaList };
}

module.exports = {
  OUTPUT_FIELDS,
  PRICING_UNIT,
  anthropicModelsDocument,
  applyOutputCap,
  buildModelEntries,
  createPublicApi,
  entryContextOf,
  formatCredits,
  gatewayPathFor,
  mapPublicRoute,
  modelReadOf,
  openAiModelsDocument,
  parseGatewayRoute,
  scopeForRest,
};
