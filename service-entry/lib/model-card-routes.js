"use strict";

// Model-card, compatibility, probe, recommend and fit-grid routes at the entry
// (02 §17, MOD-15), mounted by one line in the entry's route-mount table.
//
//   POST /api/models/inspect              path | {source, repo, revision?, files?} -> ModelCard
//   GET  /api/models/:id/card             ?view=summary|full&include=template
//   GET  /api/models/:id/compatibility    ?gpus=0,1&engines=vllm,sglang,llamacpp
//   GET  /api/models/:id/qualifications   host records of the card's contentDigest (read side only)
//   POST /api/models/:id/probe            starts the dry probe on the manager that hosts the engine
//   POST /api/launch/recommend            ranked plans per GPU set, validated by the managers
//   POST /api/models/:id/fit-grid         KV dtype x concurrency -> largest context (side-effect free)
//
// The qualify, import and save-recipe routes belong to MOD-16 and MOD-17; they
// add their handlers to this file. Every non-GET needs an owner session plus
// CSRF, or a tool token (auth.checkWrite, 05 PUB-5). A GET is readable by a
// viewer only through the rows registered below, each with its redaction
// (02 §17); the central sendJson applies it, so no handler has to remember
// it. Errors use the 00 §4.2 envelope. Nothing here starts a container or
// pulls an image: the probe and the plan validation go to the managers.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const core = require("../../manager-core");
const { redactSecrets } = require("../../manager-core/secret-redactor");
const { REQUEST_ID_RE, newRequestId, redactManagerReadForViewer } = require("./mgmt-proxy");
const { resolvePrincipal } = require("./engine-routes");

const OWNER = "02";
const MAX_BODY_BYTES = 256 * 1024;
const PLAN_TIMEOUT_MS = 5000;
const PLAN_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 60000;
const MAX_GPU_SETS = 8;
const MAX_GPU_IDS = 16;
const MAX_REMOTE_FILES = 64;
const CARD_PATH = /^mc_[a-z2-7]{20}$/;
const READ_METHODS = new Set(["GET", "HEAD"]);
const REMOTE_SOURCES = new Set(["huggingface", "hf", "modelscope"]);
const KV_DTYPE_PATTERN = /^[A-Za-z0-9_.-]{1,24}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bilingual(zh, en) {
  return { zh, en };
}

// --- redaction (02 §17) ------------------------------------------------------------

// A string that names a place on this machine: a drive or UNC path, a
// backslash path, a climb out of the model folder, a file URL or an absolute
// path below a host directory. JSON pointers ("/identity/modelType") and
// registry references ("families/qwen3#vllm") are not paths.
const HOST_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:home|Users|root|mnt|media|wsl|var|opt|srv|tmp|etc|models|model-storage)\/)/;

function isHostPath(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return HOST_PATH_RE.test(text) || text.includes("\\") || /(?:^|\/)\.\.(?:\/|#|$)/.test(text);
}

function isFullCard(card) {
  return isPlainObject(card) && card.schema === "modelcard/v1" && "evidence" in card;
}

/** GET /api/models/:id/card for a viewer: the summary projection, paths redacted. */
function redactCardBodyForViewer(body) {
  if (!isPlainObject(body) || !isPlainObject(body.card)) return body;
  const card = isFullCard(body.card)
    ? core.models.projectCard(body.card, { view: "summary", redactPaths: true })
    : body.card;
  return { ...body, card };
}

/** GET /api/m/:managerId/models/card for a viewer: the same summary, then the proxy's scrub. */
function redactManagerCardForViewer(body) {
  return redactManagerReadForViewer(redactCardBodyForViewer(body));
}

function redactRowForViewer(row) {
  if (!isPlainObject(row)) return row;
  const out = { ...row };
  if (Array.isArray(row.supportEvidence)) {
    out.supportEvidence = row.supportEvidence.map((item) => {
      if (!isPlainObject(item) || !isHostPath(item.ref)) return item;
      const { ref: _ref, ...rest } = item;
      return rest;
    });
  }
  if (Array.isArray(row.reasons)) {
    out.reasons = row.reasons.map((reason) => (isPlainObject(reason) && isHostPath(reason.evidence) ? { ...reason, evidence: null } : reason));
  }
  return out;
}

/** GET /api/models/:id/compatibility for a viewer: rows unchanged except path-valued evidence references. */
function redactCompatibilityForViewer(body) {
  if (!isPlainObject(body) || !Array.isArray(body.rows)) return body;
  return { ...body, rows: body.rows.map(redactRowForViewer) };
}

function redactRecordForViewer(record) {
  if (!isPlainObject(record)) return record;
  const { launchId: _launchId, ...rest } = record;
  if (isPlainObject(rest.host)) {
    const { driver: _driver, ...host } = rest.host;
    rest.host = host;
  }
  if (Array.isArray(rest.results)) {
    rest.results = rest.results.map((result) => {
      if (!isPlainObject(result)) return result;
      const { detail: _detail, ...kept } = result;
      return kept;
    });
  }
  if (isPlainObject(rest.observed)) {
    const { engineFacts: _facts, ...observed } = rest.observed;
    rest.observed = observed;
  }
  return rest;
}

/** GET /api/models/:id/qualifications for a viewer: no driver, launch id, detail previews or engine facts. */
function redactQualificationsForViewer(body) {
  if (!isPlainObject(body) || !Array.isArray(body.records)) return body;
  return { ...body, records: body.records.map(redactRecordForViewer) };
}

// 02 §17. The viewer GET rows of this module; everything else is owner-only.
const viewerRoutes = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/models/:id/card", redact: redactCardBodyForViewer }),
  Object.freeze({ method: "GET", path: "/api/models/:id/compatibility", redact: redactCompatibilityForViewer }),
  Object.freeze({ method: "GET", path: "/api/models/:id/qualifications", redact: redactQualificationsForViewer }),
  Object.freeze({ method: "GET", path: "/api/m/:managerId/models/card", redact: redactManagerCardForViewer }),
]);

// Declared owner-only so 05's inventory lists them. /api/m/:managerId/model/config,
// /download/precheck and /knowledge/status stay owner-only under the proxy's wildcard.
const adminOnlyRoutes = Object.freeze([
  Object.freeze({ method: "POST", path: "/api/models/inspect" }),
  Object.freeze({ method: "POST", path: "/api/models/:id/probe" }),
  Object.freeze({ method: "POST", path: "/api/models/:id/fit-grid" }),
  Object.freeze({ method: "POST", path: "/api/launch/recommend" }),
]);

/**
 * Registers viewerRoutes and adminOnlyRoutes in 05's registry. A row another
 * owner already registered is left alone; a row that cannot be registered
 * stays owner-only (deny by default) and is logged.
 */
function registerModelCardRoutes(registry, warn = () => {}) {
  let existing = [];
  try {
    existing = registry.inventory();
  } catch {
    existing = [];
  }
  const taken = (method, routePath) => existing.some((item) => item.method === method && item.path === routePath && item.access === "viewer");
  const registrations = [
    ...viewerRoutes.filter((route) => !taken(route.method, route.path)).map((route) => () => registry.registerRoute({
      owner: OWNER,
      method: route.method,
      path: route.path,
      redact: route.redact,
    })),
    ...adminOnlyRoutes.map((route) => () => registry.registerAdminOnly({ owner: OWNER, method: route.method, path: route.path })),
  ];
  for (const register of registrations) {
    try {
      register();
    } catch (error) {
      warn(`model-card-routes: a viewer registry entry was not registered and stays owner-only: ${error?.message || error}`);
    }
  }
}

// --- shared request helpers ------------------------------------------------------------

function errorBody(code, message, extra = {}) {
  const { hint, details, errors, action } = extra;
  return {
    ok: false,
    error: { code, message, ...(hint ? { hint } : {}), ...(details ? { details } : {}) },
    ...(action ? { action } : {}),
    ...(Array.isArray(errors) && errors.length ? { errors } : {}),
  };
}

function defaultSendJson(res, data, status = 200, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(JSON.stringify(data));
}

async function defaultReadJsonObjectBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Request body too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = null;
  }
  if (!isPlainObject(data)) {
    const error = new Error("Request body must be a JSON object.");
    error.status = 400;
    throw error;
  }
  return data;
}

function fieldError(field, code, message) {
  return { field, code, message };
}

// The caller's x-request-id when it is one of ours, else a fresh one.
function requestIdOf(req) {
  const given = String(req?.headers?.["x-request-id"] || "");
  return REQUEST_ID_RE.test(given) ? given : newRequestId();
}

function stringList(value, limit) {
  if (!Array.isArray(value)) return null;
  const out = value.map((item) => (typeof item === "number" ? String(item) : item));
  if (out.length > limit || out.some((item) => typeof item !== "string" || !item.trim() || item.length > 128)) return null;
  return out.map((item) => item.trim());
}

function csvList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

// --- host facts and the model library ------------------------------------------------------

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeGpu(gpu) {
  const totalMb = number(gpu.totalMb);
  const freeMb = Number.isFinite(Number(gpu.freeMb)) ? Number(gpu.freeMb) : null;
  const usedMb = Number.isFinite(Number(gpu.usedMb)) ? Number(gpu.usedMb) : freeMb === null ? 0 : Math.max(0, totalMb - freeMb);
  return {
    id: String(gpu.id ?? gpu.index ?? ""),
    name: String(gpu.name || ""),
    totalMb,
    freeMb: freeMb === null ? Math.max(0, totalMb - usedMb) : freeMb,
    usedMb,
    ...(gpu.computeCap ? { computeCap: String(gpu.computeCap) } : {}),
  };
}

// --- the routes ---------------------------------------------------------------------------------

// One pattern per route, so the inventory scan of the viewer-allowlist test sees each path.
const ID_ROUTES = Object.freeze([
  Object.freeze({ name: "card", methods: ["GET"], re: /^\/api\/models\/([^/]+)\/card$/ }),
  Object.freeze({ name: "compatibility", methods: ["GET"], re: /^\/api\/models\/([^/]+)\/compatibility$/ }),
  Object.freeze({ name: "qualifications", methods: ["GET"], re: /^\/api\/models\/([^/]+)\/qualifications$/ }),
  Object.freeze({ name: "probe", methods: ["POST"], re: /^\/api\/models\/([^/]+)\/probe$/ }),
  Object.freeze({ name: "fitGrid", methods: ["POST"], re: /^\/api\/models\/([^/]+)\/fit-grid$/ }),
]);

function match(pathname) {
  if (pathname === "/api/models/inspect") return { name: "inspect", methods: ["POST"] };
  if (pathname === "/api/launch/recommend") return { name: "recommend", methods: ["POST"] };
  for (const route of ID_ROUTES) {
    const found = route.re.exec(pathname);
    if (!found) continue;
    let id = found[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      // an undecodable id is not a card id; the handler answers 404
    }
    return { name: route.name, id, methods: route.methods };
  }
  return null;
}

/**
 * createModelCardRoutes({ auth, sendJson, readJsonObjectBody, managerClient, models, getGpus,
 *   getHost, storage, modelsRoot, cacheDir, probeDir, hostRecordsFile, registry, remote,
 *   inspectLocalOptions, logger }) -> { handle(req, res, url) -> Promise<boolean> }.
 * `models` is core.models (tests pass stubs for the parts they replace);
 * `managerClient` is the entry's shared client or a function returning it;
 * `remote` is extra inspectRemote options (a token provider, mirrors, fetchImpl).
 */
function createModelCardRoutes(options = {}) {
  const auth = options.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function") {
    throw new TypeError("createModelCardRoutes needs the request-auth seam");
  }
  const sendJson = typeof options.sendJson === "function" ? options.sendJson : defaultSendJson;
  const readJsonObjectBody = typeof options.readJsonObjectBody === "function" ? options.readJsonObjectBody : defaultReadJsonObjectBody;
  const logger = options.logger || console;
  const models = options.models || core.models;
  const cacheDir = options.cacheDir || undefined;
  const remoteOptions = isPlainObject(options.remote) ? options.remote : {};
  const localOptions = isPlainObject(options.inspectLocalOptions) ? options.inspectLocalOptions : {};

  function warn(line) {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks a request.
    }
  }

  function send(res, status, body, requestId) {
    sendJson(res, body, status, requestId ? { "x-request-id": requestId } : {});
  }

  function sendError(res, status, code, message, extra, requestId) {
    send(res, status, errorBody(code, message, extra), requestId);
  }

  function sendInternal(res, error, what, requestId) {
    warn(`model-card-routes: ${what} failed: ${error?.stack || error?.message || error}`);
    sendError(res, 500, "internal_error", "Service entry error.", undefined, requestId);
  }

  // --- host and storage

  let gpuRuntime = null;
  async function defaultGetGpus() {
    if (!gpuRuntime) gpuRuntime = core.createGpuRuntime({ execFileAsync: promisify(execFile) });
    const status = await gpuRuntime.getGpuStatus().catch(() => ({ gpus: [] }));
    return Array.isArray(status?.gpus) ? status.gpus : [];
  }

  /** {gpus, ramBytes, ramFreeBytes, platform}: every GPU, or only the ids in `only`. */
  async function readHost(only = null) {
    let host;
    if (typeof options.getHost === "function") {
      host = (await options.getHost()) || {};
    } else {
      let gpus = [];
      try {
        gpus = await (typeof options.getGpus === "function" ? options.getGpus() : defaultGetGpus());
      } catch {
        gpus = [];
      }
      host = { gpus, ramBytes: os.totalmem(), ramFreeBytes: os.freemem(), platform: process.platform };
    }
    const all = (Array.isArray(host.gpus) ? host.gpus : []).filter(isPlainObject).map(normalizeGpu);
    return {
      gpus: only ? all.filter((gpu) => only.includes(gpu.id)) : all,
      ramBytes: number(host.ramBytes, os.totalmem()),
      ramFreeBytes: Number.isFinite(Number(host.ramFreeBytes)) ? Number(host.ramFreeBytes) : os.freemem(),
      platform: String(host.platform || process.platform),
      all,
    };
  }

  let storage = options.storage || null;
  let modelsRoot = options.modelsRoot || null;
  function modelStorage() {
    if (!storage && typeof core.createModelStorage === "function") {
      modelsRoot = modelsRoot || process.env.VLLM_MODELS_ROOT || path.join(options.aiRoot || path.resolve(__dirname, "..", ".."), "models");
      storage = core.createModelStorage({
        modelsRoot,
        file: process.env.MODEL_STORAGE_FILE || path.join(options.rootDir || path.resolve(__dirname, ".."), "data", "model-storage.json"),
      });
    }
    return storage;
  }

  /** The model library roots (model-storage.json plus the legacy models folder). */
  function libraryRoots() {
    if (Array.isArray(options.roots)) return options.roots;
    if (typeof options.roots === "function") return options.roots();
    try {
      return (modelStorage()?.roots() || []).map((root) => root?.path).filter((item) => typeof item === "string" && item);
    } catch {
      return [];
    }
  }

  /** Maps a container path or a library-relative name to a host path; anything else stays as given. */
  function resolveLibraryPath(input) {
    const text = String(input);
    try {
      const store = modelStorage();
      const mapped = store && typeof store.fromContainerPath === "function" ? store.fromContainerPath(text) : text;
      if (path.isAbsolute(mapped)) return store && typeof store.resolvePath === "function" ? store.resolvePath(mapped) : mapped;
      if (/^[\\/]{2}/.test(mapped)) return mapped;
      const root = libraryRoots()[0];
      return root ? path.resolve(root, mapped) : mapped;
    } catch {
      return text;
    }
  }

  // --- cards

  function loadCard(id, { includeTemplate = false } = {}) {
    if (!CARD_PATH.test(String(id))) return null;
    try {
      return models.getCard(id, { cacheDir, includeTemplate }) || null;
    } catch {
      return null;
    }
  }

  function cardNotFound(res, requestId) {
    sendError(res, 404, "card_not_found", "No model card is known under this id.", { hint: "Call POST /api/models/inspect for the model first." }, requestId);
  }

  // InspectError (and the other coded errors the model APIs throw) -> the envelope.
  function sendCodedError(res, error, requestId) {
    const code = String(error?.code || "");
    const status = Number(error?.status);
    if (code && Number.isInteger(status) && status >= 400 && status < 600) {
      const mapped = code === "repo_not_found" || code === "revision_not_found" ? "not_found" : code;
      const extra = {};
      if (code === "path_outside_storage") extra.hint = "Register the folder as a model library, or pick a model inside one.";
      else if (code === "gated") extra.hint = "Accept the model's terms on the hub and sign in, then inspect again.";
      else if (code === "inspect_timeout") extra.hint = "Try again; a cached result is returned once an inspection completes.";
      if (mapped !== code) extra.details = { reason: code };
      sendError(res, status, mapped, redactSecrets(String(error.message || "The request failed.")), extra, requestId);
      return true;
    }
    return false;
  }

  async function inspectLocalCard(target, body, signal) {
    const roots = libraryRoots();
    if (!roots.length) {
      const error = new Error("The model path is outside the model library roots.");
      error.code = "path_outside_storage";
      error.status = 400;
      throw error;
    }
    return models.inspectLocalDetailed(resolveLibraryPath(target), {
      ...localOptions,
      roots,
      cacheDir,
      depth: body.depth,
      refresh: body.refresh === true,
      signal,
    });
  }

  function remoteRequestOf(body) {
    return {
      source: body.source === "hf" ? "huggingface" : body.source,
      repo: body.repo,
      revision: typeof body.revision === "string" && body.revision.trim() ? body.revision.trim() : "main",
      ...(Array.isArray(body.files) && body.files.length ? { files: body.files } : {}),
    };
  }

  async function inspectRemoteCard(body, signal) {
    return models.inspectRemoteDetailed(remoteRequestOf(body), { ...remoteOptions, cacheDir, refresh: body.refresh === true, signal });
  }

  // The abort signal of a request: the client going away aborts the inspection.
  function requestSignal(res) {
    const controller = new AbortController();
    res.on?.("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    return controller.signal;
  }

  // --- POST /api/models/inspect

  function validateInspectBody(body) {
    const errors = [];
    const hasPath = body.path !== undefined && body.path !== null;
    const hasRemote = body.source !== undefined || body.repo !== undefined;
    if (hasPath && hasRemote) errors.push(fieldError("path", "conflict", "Give either path or source with repo, not both."));
    else if (!hasPath && !hasRemote) errors.push(fieldError("path", "required", "path, or source with repo, is required."));
    if (hasPath && (typeof body.path !== "string" || !body.path.trim() || body.path.length > 1024 || body.path.includes("\0"))) {
      errors.push(fieldError("path", "invalid", "path must be a non-empty string."));
    }
    if (hasRemote) {
      if (typeof body.source !== "string" || !REMOTE_SOURCES.has(body.source)) errors.push(fieldError("source", "invalid", "source must be huggingface or modelscope."));
      if (typeof body.repo !== "string" || !body.repo.trim() || body.repo.length > 200) errors.push(fieldError("repo", "invalid", "repo must be owner/name."));
      if (body.revision !== undefined && (typeof body.revision !== "string" || body.revision.length > 200)) errors.push(fieldError("revision", "invalid", "revision must be a string."));
      if (body.files !== undefined && !stringList(body.files, MAX_REMOTE_FILES)) errors.push(fieldError("files", "invalid", `files must be a list of at most ${MAX_REMOTE_FILES} file names.`));
    }
    if (body.refresh !== undefined && typeof body.refresh !== "boolean") errors.push(fieldError("refresh", "invalid", "refresh must be true or false."));
    if (body.depth !== undefined && !["full", "quick"].includes(body.depth)) errors.push(fieldError("depth", "invalid", "depth must be full or quick."));
    return errors;
  }

  // A folder with no weights and no declared identity (no config.json, no GGUF) holds no model.
  function holdsNoModel(card) {
    const identity = isPlainObject(card?.identity) ? card.identity : {};
    const declared = Boolean(identity.modelType || identity.ggufArchitecture || (Array.isArray(identity.architectures) && identity.architectures.length));
    return card?.format?.kind === "none" && !declared && !card?.weights;
  }

  async function inspect(req, res, requestId) {
    const body = await readBody(req, res, requestId);
    if (!body) return;
    const errors = validateInspectBody(body);
    if (errors.length) {
      sendError(res, 400, "invalid_request", "The inspect request is not valid.", { errors }, requestId);
      return;
    }
    const signal = requestSignal(res);
    try {
      const result = body.path !== undefined
        ? await inspectLocalCard(body.path, body, signal)
        : await inspectRemoteCard(body, signal);
      if (holdsNoModel(result.card)) {
        sendError(res, 422, "not_a_model", "The folder holds no model files.", { hint: "Pick the folder that contains config.json and the weights, or a .gguf file." }, requestId);
        return;
      }
      send(res, 200, {
        ok: true,
        card: models.projectCard(result.card, { view: "full" }),
        cached: result.cached === true,
        durationMs: result.durationMs,
      }, requestId);
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "aborted") {
        if (!res.headersSent && !res.writableEnded) sendError(res, 499, "aborted", "The request was cancelled.", undefined, requestId);
        return;
      }
      if (!sendCodedError(res, error, requestId)) sendInternal(res, error, "inspect", requestId);
    }
  }

  // --- GET /api/models/:id/card

  function getCardRoute(res, url, id, who, requestId) {
    const view = url.searchParams.get("view") || "summary";
    const includeTemplate = csvList(url.searchParams.get("include")).includes("template");
    if (!["summary", "full"].includes(view)) {
      sendError(res, 400, "invalid_request", "view must be summary or full.", { errors: [fieldError("view", "invalid", "view must be summary or full.")] }, requestId);
      return;
    }
    if ((view === "full" || includeTemplate) && who.kind !== "owner") {
      sendError(res, 403, "owner_required", "The full card and the chat template are only available to the console owner.", { hint: "Open the console on this machine." }, requestId);
      return;
    }
    const card = loadCard(id, { includeTemplate });
    if (!card) {
      cardNotFound(res, requestId);
      return;
    }
    const projected = models.projectCard(card, view === "full" || includeTemplate ? { view: "full", includeTemplate } : { view: "summary" });
    send(res, 200, { ok: true, card: projected }, requestId);
  }

  // --- GET /api/models/:id/compatibility

  async function loadHostRecords(contentDigest) {
    if (!contentDigest) return [];
    const file = options.hostRecordsFile;
    if (!file) return [];
    try {
      const data = JSON.parse(await fs.promises.readFile(file, "utf8"));
      const list = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : [];
      return list.filter((record) => isPlainObject(record) && record.contentDigest === contentDigest);
    } catch {
      return [];
    }
  }

  async function loadProbes(contentDigest) {
    if (!contentDigest || typeof models.probe?.listProbeResults !== "function") return [];
    try {
      return await models.probe.listProbeResults({ ...(options.probeDir ? { dir: options.probeDir } : {}), contentDigest });
    } catch {
      return [];
    }
  }

  function engineRegistry() {
    if (options.registry) return options.registry;
    try {
      return core.engines.getEngineRegistry();
    } catch {
      return null;
    }
  }

  async function compatibility(res, url, id, requestId) {
    const card = loadCard(id);
    if (!card) {
      cardNotFound(res, requestId);
      return;
    }
    const wantedGpus = csvList(url.searchParams.get("gpus"));
    const wantedEngines = csvList(url.searchParams.get("engines"));
    const registry = engineRegistry();
    if (wantedEngines.length && registry) {
      const unknown = wantedEngines.find((engineId) => !registry.has(engineId));
      if (unknown) {
        sendError(res, 400, "unknown_engine", `Unknown engine: ${unknown.slice(0, 64)}.`, undefined, requestId);
        return;
      }
    }
    const host = await readHost(wantedGpus.length ? wantedGpus : null);
    if (wantedGpus.length) {
      const missing = wantedGpus.find((gpuId) => !host.all.some((gpu) => gpu.id === gpuId));
      if (missing !== undefined) {
        sendError(res, 400, "unknown_gpu", `This host has no GPU ${missing.slice(0, 16)}.`, undefined, requestId);
        return;
      }
    }
    try {
      const [hostRecords, probes] = await Promise.all([loadHostRecords(card.contentDigest), loadProbes(card.contentDigest)]);
      let rows = models.compatibility.evaluateCompatibility(card, {
        host: { gpus: host.gpus, ramBytes: host.ramBytes, ramFreeBytes: host.ramFreeBytes, platform: host.platform },
        hostRecords,
        probes,
        ...(registry ? { registry } : {}),
      });
      if (wantedEngines.length) rows = rows.filter((row) => wantedEngines.includes(row.engineId));
      send(res, 200, {
        ok: true,
        cardId: card.cardId,
        host: { gpus: host.gpus, ramBytes: host.ramBytes, platform: host.platform },
        rows,
      }, requestId);
    } catch (error) {
      sendInternal(res, error, "compatibility", requestId);
    }
  }

  // --- GET /api/models/:id/qualifications (the read side; MOD-16 writes the records)

  async function qualifications(res, id, requestId) {
    const card = loadCard(id);
    if (!card) {
      cardNotFound(res, requestId);
      return;
    }
    send(res, 200, { ok: true, records: await loadHostRecords(card.contentDigest) }, requestId);
  }

  // --- the managers

  function client() {
    return typeof options.managerClient === "function" ? options.managerClient() : options.managerClient;
  }

  function hostManagerOf(registry, engineId) {
    try {
      const managerId = registry?.get(engineId)?.hostManager;
      return managerId === "vllm" || managerId === "llama" ? managerId : "";
    } catch {
      return "";
    }
  }

  // The manager's own error answer, passed on with its status; a missing answer becomes 503/504.
  function relayManagerFailure(res, result, managerId, requestId) {
    if (result.status > 0 && isPlainObject(result.data) && isPlainObject(result.data.error)) {
      send(res, result.status, { ...result.data, managerId }, requestId);
      return;
    }
    if (result.status > 0) {
      sendError(res, result.status >= 400 ? result.status : 502, String(result.code || "manager_error"), String(result.message || `The ${managerId} manager refused the request.`), undefined, requestId);
      return;
    }
    if (result.code === "manager_timeout") {
      sendError(res, 504, "manager_timeout", `The ${managerId} manager did not answer in time.`, undefined, requestId);
      return;
    }
    sendError(res, 503, "manager_unreachable", `The ${managerId} manager is not running or not answering.`, { hint: "Start the manager, then try again." }, requestId);
  }

  // --- POST /api/models/:id/probe

  async function probe(req, res, id, requestId) {
    const body = await readBody(req, res, requestId);
    if (!body) return;
    const errors = [];
    if (typeof body.engineId !== "string" || !body.engineId.trim()) errors.push(fieldError("engineId", "required", "engineId is required."));
    if (body.runtimeId !== undefined && (typeof body.runtimeId !== "string" || body.runtimeId.length > 128)) errors.push(fieldError("runtimeId", "invalid", "runtimeId must be a string."));
    if (body.allowRemoteCode !== undefined && typeof body.allowRemoteCode !== "boolean") errors.push(fieldError("allowRemoteCode", "invalid", "allowRemoteCode must be true or false."));
    if (errors.length) {
      sendError(res, 400, "invalid_request", "The probe request is not valid.", { errors }, requestId);
      return;
    }
    const card = loadCard(id);
    if (!card) {
      cardNotFound(res, requestId);
      return;
    }
    const engineId = body.engineId.trim();
    const registry = engineRegistry();
    const managerId = hostManagerOf(registry, engineId);
    if (!managerId) {
      sendError(res, 400, "unknown_engine", `No manager hosts the engine "${engineId.slice(0, 64)}".`, undefined, requestId);
      return;
    }
    if (card.ref?.kind !== "local" || typeof card.ref.path !== "string") {
      sendError(res, 400, "model_not_local", "The dry probe runs against model files on this machine.", { hint: "Download the model first; the probe never fetches files." }, requestId);
      return;
    }
    const target = card.ref.file ? path.join(card.ref.path, card.ref.file) : card.ref.path;
    const managerClient = client();
    if (!managerClient) {
      sendError(res, 503, "manager_unreachable", "The manager client is not available.", undefined, requestId);
      return;
    }
    const result = await managerClient.post(managerId, "models/probe", {
      model: target,
      engineId,
      ...(body.runtimeId ? { runtimeId: body.runtimeId.trim() } : {}),
      allowRemoteCode: body.allowRemoteCode === true,
    }, { timeoutMs: PROBE_TIMEOUT_MS, requestId });
    if (!result.ok) {
      relayManagerFailure(res, result, managerId, requestId);
      return;
    }
    send(res, 202, { ok: true, jobId: result.data?.jobId ?? null, managerId: result.data?.managerId || managerId }, requestId);
  }

  // --- POST /api/launch/recommend

  async function recommendCard(body, signal) {
    if (typeof body.cardId === "string" && body.cardId) return { card: loadCard(body.cardId), notFound: true };
    if (typeof body.path === "string" && body.path.trim()) {
      const { card } = await inspectLocalCard(body.path, {}, signal);
      if (holdsNoModel(card)) throw Object.assign(new Error("The folder holds no model files."), { code: "not_a_model", status: 422 });
      return { card };
    }
    return { card: (await inspectRemoteCard({ source: body.source || "huggingface", repo: body.repo, revision: body.revision, files: body.files }, signal)).card };
  }

  function validateRecommendBody(body) {
    const errors = [];
    const sources = ["cardId", "path", "repo"].filter((name) => body[name] !== undefined && body[name] !== null);
    if (!sources.length) errors.push(fieldError("cardId", "required", "cardId, path or repo is required."));
    for (const name of sources) {
      if (typeof body[name] !== "string" || !body[name].trim() || body[name].length > 1024) errors.push(fieldError(name, "invalid", `${name} must be a non-empty string.`));
    }
    if (body.source !== undefined && (typeof body.source !== "string" || !REMOTE_SOURCES.has(body.source))) errors.push(fieldError("source", "invalid", "source must be huggingface or modelscope."));
    if (body.gpuSets !== undefined) {
      const sets = Array.isArray(body.gpuSets) ? body.gpuSets : null;
      if (!sets || sets.length > MAX_GPU_SETS || sets.some((set) => !stringList(set, MAX_GPU_IDS) || !set.length)) {
        errors.push(fieldError("gpuSets", "invalid", `gpuSets is a list of at most ${MAX_GPU_SETS} non-empty lists of GPU ids.`));
      }
    }
    if (body.constraints !== undefined && !isPlainObject(body.constraints)) errors.push(fieldError("constraints", "invalid", "constraints must be an object."));
    return errors;
  }

  // The body the manager's POST /api/launch/plan takes for one plan (00 §4.3, 01 §11).
  function planRequestFor(item, card) {
    const local = card.ref?.kind === "local" && typeof card.ref.path === "string";
    const ref = local ? (card.ref.file ? path.join(card.ref.path, card.ref.file) : card.ref.path) : "";
    return {
      engineId: item.engineId,
      ...(item.runtimeId ? { runtimeId: item.runtimeId } : {}),
      ...(item.recipeId ? { recipeId: item.recipeId } : {}),
      ...(local ? { model: { ref } } : { prospective: true, model: { card } }),
      instance: { gpuIds: item.gpuIds },
      values: item.values,
    };
  }

  function notValidated(item, reason) {
    item.validated = null;
    item.warnings = [...(Array.isArray(item.warnings) ? item.warnings : []), {
      code: "plan_not_validated",
      message: bilingual("没有经管理器校验这个方案。", "The manager did not validate this plan."),
      ...(reason ? { reason } : {}),
    }];
  }

  // Attaches `validated` to every plan, at most PLAN_CONCURRENCY at a time. A manager
  // that cannot be reached once is not asked again for the rest of the request.
  async function validatePlans(sets, card, requestId) {
    const registry = engineRegistry();
    const managerClient = client();
    const down = new Map();
    const queue = sets.flatMap((set) => set.plans);
    async function validateOne(item) {
      const managerId = hostManagerOf(registry, item.engineId);
      if (!managerId || !managerClient) {
        notValidated(item, !managerId ? "no_manager" : "manager_client_unavailable");
        return;
      }
      if (down.has(managerId)) {
        notValidated(item, down.get(managerId));
        return;
      }
      let result;
      try {
        result = await managerClient.post(managerId, "launch/plan", planRequestFor(item, card), { timeoutMs: PLAN_TIMEOUT_MS, requestId });
      } catch (error) {
        result = { ok: false, status: 0, code: "manager_unreachable" };
      }
      if (!result?.ok || !isPlainObject(result.data)) {
        const reason = String(result?.code || "manager_unreachable");
        if (!result?.status) down.set(managerId, reason);
        notValidated(item, reason);
        return;
      }
      const plan = result.data;
      item.validated = {
        ok: plan.ok === true,
        errors: Array.isArray(plan.errors) ? plan.errors : [],
        warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
        admission: plan.admission ?? null,
        planHash: plan.planHash ?? null,
        commandPreview: plan.command ?? null,
      };
    }
    const workers = Array.from({ length: Math.min(PLAN_CONCURRENCY, queue.length) }, async () => {
      while (queue.length) await validateOne(queue.shift());
    });
    await Promise.all(workers);
  }

  async function recommend(req, res, requestId) {
    const body = await readBody(req, res, requestId);
    if (!body) return;
    const goal = body.goal === undefined || body.goal === null ? "balanced" : body.goal;
    const errors = validateRecommendBody(body);
    if (typeof goal !== "string" || !models.planner.GOALS.includes(goal)) {
      sendError(res, 400, "invalid_goal", `goal must be one of ${models.planner.GOALS.join(", ")}.`, { errors: [fieldError("goal", "invalid", `goal must be one of ${models.planner.GOALS.join(", ")}.`)] }, requestId);
      return;
    }
    if (errors.length) {
      sendError(res, 400, "invalid_request", "The recommend request is not valid.", { errors }, requestId);
      return;
    }
    const signal = requestSignal(res);
    try {
      const resolved = await recommendCard(body, signal);
      if (!resolved.card) {
        cardNotFound(res, requestId);
        return;
      }
      const card = resolved.card;
      const host = await readHost();
      const sets = models.planner.planLaunches({
        card,
        host: { gpus: host.gpus, ramBytes: host.ramBytes, ramFreeBytes: host.ramFreeBytes, platform: host.platform },
        goal,
        ...(body.gpuSets ? { gpuSets: body.gpuSets.map((set) => set.map(String)) } : {}),
        ...(body.constraints ? { constraints: body.constraints } : {}),
      }, { ...(options.plannerOptions || {}) });
      await validatePlans(sets, card, requestId);
      const notes = [];
      const seen = new Set();
      for (const set of sets) {
        for (const note of Array.isArray(set.notes) ? set.notes : []) {
          const key = JSON.stringify(note);
          if (!seen.has(key)) {
            seen.add(key);
            notes.push(note);
          }
        }
      }
      send(res, 200, {
        ok: true,
        cardId: card.cardId,
        goal,
        gpuSets: sets.map((set) => ({ gpuIds: set.gpuIds, plans: set.plans, notes: set.notes || [] })),
        notes,
      }, requestId);
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "aborted") return;
      if (error?.code === "invalid_value" || error?.code === "planner_input_invalid") {
        sendError(res, 400, error.code === "invalid_value" ? "invalid_request" : error.code, redactSecrets(String(error.message)), undefined, requestId);
        return;
      }
      if (!sendCodedError(res, error, requestId)) sendInternal(res, error, "recommend", requestId);
    }
  }

  // --- POST /api/models/:id/fit-grid

  function recipeFor(engineId, recipeId, host, card) {
    const recipes = core.engines;
    const store = recipes.getRecipeStore();
    const recipe = store.get(recipeId);
    if (!recipe || recipe.engineId !== engineId || recipe.kind === "scenario") return null;
    const selected = host.gpus;
    let hostFacts = {};
    try {
      hostFacts = require("../../manager-core/engines/param-catalog").hostFactsFromGpus(selected, host.platform);
    } catch {
      hostFacts = {};
    }
    const model = { contentDigest: card.contentDigest || null, familyId: card.identity?.familyId || null, quantMethod: card.quant?.method || null };
    const applied = recipes.applyRecipe(recipe, {}, { hostFacts, model, runtime: {} });
    return { values: applied.values || {}, memory: applied.memory || null };
  }

  async function fitGrid(req, res, id, requestId) {
    const body = await readBody(req, res, requestId);
    if (!body) return;
    const errors = [];
    if (typeof body.engineId !== "string" || !body.engineId.trim()) errors.push(fieldError("engineId", "required", "engineId is required."));
    for (const name of ["runtimeId", "recipeId"]) {
      if (body[name] !== undefined && body[name] !== null && (typeof body[name] !== "string" || body[name].length > 128)) errors.push(fieldError(name, "invalid", `${name} must be a string.`));
    }
    if (body.gpuIds !== undefined && !stringList(body.gpuIds, MAX_GPU_IDS)) errors.push(fieldError("gpuIds", "invalid", `gpuIds is a list of at most ${MAX_GPU_IDS} GPU ids.`));
    if (body.kvDtypes !== undefined && (!Array.isArray(body.kvDtypes) || body.kvDtypes.some((item) => typeof item !== "string" || !KV_DTYPE_PATTERN.test(item)))) errors.push(fieldError("kvDtypes", "invalid", "kvDtypes is a list of KV dtype names."));
    for (const name of ["concurrency", "contexts"]) {
      if (body[name] !== undefined && (!Array.isArray(body[name]) || body[name].some((item) => !Number.isInteger(item) || item < 1))) errors.push(fieldError(name, "invalid", `${name} is a list of positive integers.`));
    }
    if (body.values !== undefined && !isPlainObject(body.values)) errors.push(fieldError("values", "invalid", "values must be an object of catalog ids."));
    if (errors.length) {
      sendError(res, 400, "invalid_request", "The fit-grid request is not valid.", { errors }, requestId);
      return;
    }
    // The grid limits are checked before anything else is computed.
    const limits = models.fit.fitGrid.LIMITS || {};
    if ((body.kvDtypes?.length || 0) > (limits.kvDtypes || 4) || (body.concurrency?.length || 0) > (limits.concurrency || 8) || (body.contexts?.length || 0) > (limits.contexts || 16)) {
      sendError(res, 400, "grid_too_large", `A fit grid takes at most ${limits.kvDtypes || 4} KV dtypes, ${limits.concurrency || 8} concurrency values and ${limits.contexts || 16} contexts.`, undefined, requestId);
      return;
    }
    const engineId = body.engineId.trim();
    const registry = engineRegistry();
    if (!registry || !registry.has(engineId)) {
      sendError(res, 400, "unknown_engine", `Unknown engine: ${engineId.slice(0, 64)}.`, undefined, requestId);
      return;
    }
    const card = loadCard(id);
    if (!card) {
      cardNotFound(res, requestId);
      return;
    }
    const host = await readHost();
    const gpuIds = body.gpuIds && body.gpuIds.length ? stringList(body.gpuIds, MAX_GPU_IDS) : host.gpus.map((gpu) => gpu.id);
    try {
      let recipe = null;
      if (body.recipeId) {
        recipe = recipeFor(engineId, body.recipeId, { gpus: host.gpus.filter((gpu) => gpuIds.includes(gpu.id)), platform: host.platform }, card);
        if (!recipe) {
          sendError(res, 404, "recipe_not_found", `${engineId} has no recipe "${String(body.recipeId).slice(0, 64)}".`, undefined, requestId);
          return;
        }
      }
      const fitInput = {
        card,
        engineId,
        runtimeId: body.runtimeId || null,
        gpuIds,
        values: { ...(recipe?.values || {}), ...(isPlainObject(body.values) ? body.values : {}) },
        host: { gpus: host.gpus, ramBytes: host.ramBytes, ramFreeBytes: host.ramFreeBytes, platform: host.platform },
        budgetBasis: "empty-gpu",
        instanceMode: "parallel",
        ...(recipe?.memory ? { recipeMemory: recipe.memory } : {}),
      };
      const grid = models.fit.fitGrid(fitInput, {
        ...(body.kvDtypes ? { kvDtypes: body.kvDtypes } : {}),
        ...(body.concurrency ? { concurrency: body.concurrency } : {}),
        ...(body.contexts ? { contexts: body.contexts } : {}),
      }, { ...(options.fitOptions || {}) });
      const { stats: _stats, ...answer } = grid;
      send(res, 200, answer, requestId);
    } catch (error) {
      if (!sendCodedError(res, error, requestId)) sendInternal(res, error, "fit-grid", requestId);
    }
  }

  // --- dispatch

  async function readBody(req, res, requestId) {
    try {
      return await readJsonObjectBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (Number(error?.status) === 413) sendError(res, 413, "request_too_large", `The request body may be at most ${MAX_BODY_BYTES} bytes.`, undefined, requestId);
      else sendError(res, 400, "invalid_json", "The request body must be a JSON object.", undefined, requestId);
      return null;
    }
  }

  // null when the owner may write, otherwise [status, code, message].
  function writeRefusal(req, who) {
    if (who.kind === "none") return [401, "admin_session_required", "This needs the console owner. Open the console on this machine."];
    if (who.kind !== "owner") return [403, "principal_route_forbidden", `${who.principal || "This caller"} may not change models.`];
    let allowed;
    try {
      allowed = auth.checkWrite(req) || {};
    } catch {
      allowed = { ok: false, status: 401, code: "admin_session_required" };
    }
    if (allowed.ok) return null;
    return [Number(allowed.status) || 403, String(allowed.code || "management_local_only"), String(allowed.message || "This action needs the console owner.")];
  }

  async function handle(req, res, url) {
    const pathname = String(url?.pathname || "");
    if (!pathname.startsWith("/api/models/") && pathname !== "/api/launch/recommend") return false;
    const route = match(pathname);
    if (!route) return false;
    const requested = String(req.method || "GET").toUpperCase();
    const method = requested === "HEAD" ? "GET" : requested;
    const requestId = requestIdOf(req);
    if (!route.methods.includes(method)) {
      req.resume?.();
      sendJson(res, errorBody("method_not_allowed", `${requested} is not supported on ${pathname}.`), 405, { allow: route.methods.join(", "), "x-request-id": requestId });
      return true;
    }
    const who = resolvePrincipal(auth, req);
    try {
      if (READ_METHODS.has(requested)) {
        if (who.kind === "none" || who.kind === "machine") {
          req.resume?.();
          if (who.kind === "machine") sendError(res, 403, "principal_route_forbidden", `${who.principal || "This principal"} may not call ${requested} ${pathname}.`, undefined, requestId);
          else sendError(res, 401, "admin_session_required", "This needs the console owner. Open the console on this machine.", { hint: "pair" }, requestId);
          return true;
        }
        if (route.name === "card") getCardRoute(res, url, route.id, who, requestId);
        else if (route.name === "compatibility") await compatibility(res, url, route.id, requestId);
        else await qualifications(res, route.id, requestId);
        return true;
      }
      const refused = writeRefusal(req, who);
      if (refused) {
        req.resume?.();
        sendError(res, refused[0], refused[1], refused[2], undefined, requestId);
        return true;
      }
      if (route.name === "inspect") await inspect(req, res, requestId);
      else if (route.name === "recommend") await recommend(req, res, requestId);
      else if (route.name === "probe") await probe(req, res, route.id, requestId);
      else await fitGrid(req, res, route.id, requestId);
    } catch (error) {
      sendInternal(res, error, `${requested} ${pathname}`, requestId);
    }
    return true;
  }

  return { handle };
}

// Route module (07 §2.7). ctx.modelCards carries test seams and overrides
// (see createModelCardRoutes); by default everything is the live platform's.
function mount(ctx) {
  const auth = ctx?.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function" || !auth.viewerRegistry) {
    throw new Error("model-card-routes: ctx.auth is missing");
  }
  const logger = ctx.logger || console;
  const warn = (line) => {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks the mount.
    }
  };
  registerModelCardRoutes(auth.viewerRegistry, warn);
  const seams = isPlainObject(ctx.modelCards) ? ctx.modelCards : {};
  const rootDir = ctx.rootDir || path.resolve(__dirname, "..");
  const routes = createModelCardRoutes({
    getGpus: ctx.getGpus,
    hostRecordsFile: path.join(rootDir, "data", "model-host-records.json"),
    ...seams,
    aiRoot: ctx.aiRoot,
    rootDir,
    auth,
    sendJson: ctx.sendJson,
    readJsonObjectBody: ctx.readJsonObjectBody,
    managerClient: () => ctx.managerClient,
    logger,
  });
  return { handle: routes.handle };
}

module.exports = {
  adminOnlyRoutes,
  createModelCardRoutes,
  defaultReadJsonObjectBody,
  defaultSendJson,
  errorBody,
  fieldError,
  isHostPath,
  mount,
  name: "model-cards",
  redactCardBodyForViewer,
  redactCompatibilityForViewer,
  redactManagerCardForViewer,
  redactQualificationsForViewer,
  registerModelCardRoutes,
  requestIdOf,
  viewerRoutes,
};
