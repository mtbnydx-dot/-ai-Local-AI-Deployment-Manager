"use strict";

// Engine routes at the entry (01 §20, §21.2, §21.3), mounted for /api/engines
// by one line in the entry's route-mount table.
//
//   GET    /api/engines                                       both managers' /api/engines + external endpoints
//   GET    /api/engines/external/endpoints                    redacted for viewers, full (no key) for the owner
//   POST   /api/engines/external/endpoints                    register; apiKey is write-only
//   PATCH  /api/engines/external/endpoints/:endpointId        partial update
//   DELETE /api/engines/external/endpoints/:endpointId?confirm=1
//   POST   /api/engines/external/endpoints/:endpointId/test   GET-only probe
//
// The registry is service-entry/data/external-endpoints.json (runtime state,
// not released). A key never reaches that file: it lives in the secret store
// namespace engines.external under the endpointId. Writes are owner-only
// (auth.checkWrite); 05's guard already holds viewers to registered GET rows.
// This module also registers 01's viewer rows for the proxied manager reads
// (/api/m/:managerId/engines...) and declares logs and launch records
// owner-only (§21.3). Errors use the 00 §4.2 envelope.

const fs = require("node:fs");
const path = require("node:path");

const { redactSecrets } = require("../../manager-core/secret-redactor");
const adapter = require("../../manager-core/engines/adapters/external");
const { createExternalHost } = require("../../manager-core/engines/hosts/external");
const { redactManagerReadForViewer } = require("./mgmt-proxy");

const OWNER = "01";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ENDPOINTS = 64;
const MANAGER_TIMEOUT_MS = 2000;
const READ_METHODS = new Set(["GET", "HEAD"]);
const ENDPOINTS_PATH = "/api/engines/external/endpoints";
const STORE_SCHEMA_VERSION = 1;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// --- redaction (01 §21.3) -------------------------------------------------------

// A path in a value: a drive path, a UNC path or an absolute POSIX path of two or more segments.
const PATH_VALUE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/[^/\s]+\/)/;
const PATH_KEY_RE = /(?:^|[a-z0-9])(?:path|paths|dir|dirs|directory|root|roots|file|files|folder)$/i;

function isPathValue(value) {
  return typeof value === "string" && PATH_VALUE_RE.test(value.trim());
}

// Removes path-valued entries and path-named keys, at any depth. A list keeps
// its non-path items.
function stripPaths(value, depth = 0) {
  if (depth > 32) return null;
  if (Array.isArray(value)) return value.filter((item) => !isPathValue(item)).map((item) => stripPaths(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || PATH_KEY_RE.test(key) || isPathValue(item)) continue;
    out[key] = stripPaths(item, depth + 1);
  }
  return out;
}

function dropErrorFiles(errors) {
  if (!Array.isArray(errors)) return errors;
  return errors.map((item) => {
    if (!isPlainObject(item)) return item;
    const { file, ...rest } = item;
    return rest;
  });
}

// The viewer's health: a state and timing, nothing about the endpoint's answers.
function reduceHealth(health) {
  if (!isPlainObject(health)) return { state: "unknown" };
  return {
    state: typeof health.state === "string" ? health.state : "unknown",
    latencyMs: Number.isFinite(health.latencyMs) ? health.latencyMs : null,
    checkedAt: typeof health.checkedAt === "string" ? health.checkedAt : null,
  };
}

/**
 * One endpoint as a viewer sees it: {endpointId, label, kind, enabled,
 * hostClass: "loopback"|"lan"|"remote", health}. No baseUrl, no apiKeyRef.
 * Idempotent: an already reduced endpoint keeps its hostClass.
 */
function redactEndpointForViewer(endpoint) {
  if (!isPlainObject(endpoint)) return endpoint;
  const hostClass = typeof endpoint.baseUrl === "string" ? adapter.hostClassOf(endpoint) : ["loopback", "lan", "remote"].includes(endpoint.hostClass) ? endpoint.hostClass : "remote";
  return {
    endpointId: endpoint.endpointId,
    label: endpoint.label,
    kind: endpoint.kind,
    enabled: endpoint.enabled !== false,
    hostClass,
    health: reduceHealth(endpoint.health),
  };
}

/** GET /api/engines/external/endpoints for a viewer. */
function redactEndpointsBodyForViewer(body) {
  if (!isPlainObject(body)) return body;
  return { ...body, endpoints: Array.isArray(body.endpoints) ? body.endpoints.map(redactEndpointForViewer) : body.endpoints };
}

/** GET /api/engines (the aggregate) for a viewer: no errors[].file, external endpoints reduced. */
function redactEnginesForViewer(body) {
  if (!isPlainObject(body)) return body;
  const out = { ...body };
  if ("errors" in out) out.errors = dropErrorFiles(out.errors);
  if (isPlainObject(out.external)) out.external = redactEndpointsBodyForViewer(out.external);
  if (Array.isArray(out.managers)) out.managers = out.managers.map((item) => (isPlainObject(item) ? { ...item, ...(item.errors ? { errors: dropErrorFiles(item.errors) } : {}) } : item));
  return out;
}

/** GET /api/m/:managerId/engines for a viewer: no errors[].file. */
function redactManagerEnginesForViewer(body) {
  if (!isPlainObject(body)) return body;
  return "errors" in body ? { ...body, errors: dropErrorFiles(body.errors) } : { ...body };
}

/** GET /api/m/:managerId/engines/:engineId/schema for a viewer: no profile.modelDir, no path-valued model facts. */
function redactEngineSchemaForViewer(body) {
  if (!isPlainObject(body)) return body;
  const out = { ...body };
  if (Array.isArray(out.recipes)) {
    out.recipes = out.recipes.map((recipe) => {
      if (!isPlainObject(recipe) || !isPlainObject(recipe.profile)) return recipe;
      const { modelDir, ...profile } = recipe.profile;
      return { ...recipe, profile };
    });
  }
  if (isPlainObject(out.facts)) {
    const facts = {};
    for (const [key, value] of Object.entries(out.facts)) {
      if (key === "__proto__") continue;
      if (key === "model" && isPlainObject(value)) facts[key] = stripPaths(value);
      else if (key.startsWith("model.") && (isPathValue(value) || (Array.isArray(value) && value.some(isPathValue)))) continue;
      else facts[key] = value;
    }
    out.facts = facts;
  }
  return out;
}

/** GET /api/m/:managerId/instances/:id/metrics for a viewer: no path-valued facts. */
function redactInstanceMetricsForViewer(body) {
  if (!isPlainObject(body)) return body;
  const out = { ...body };
  if ("facts" in out) out.facts = stripPaths(out.facts);
  return out;
}

/** GET /api/m/:managerId/instances for a viewer: the existing fleet redaction, applied to the new fields too. */
function redactInstancesForViewer(body) {
  return redactManagerReadForViewer(body);
}

// 01 §21.3. The viewer GET rows; everything else of 01 is owner-only.
const viewerRoutes = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/engines", redact: redactEnginesForViewer }),
  Object.freeze({ method: "GET", path: ENDPOINTS_PATH, redact: redactEndpointsBodyForViewer }),
  Object.freeze({ method: "GET", path: "/api/m/:managerId/engines", redact: redactManagerEnginesForViewer }),
  Object.freeze({ method: "GET", path: "/api/m/:managerId/engines/:engineId/schema", redact: redactEngineSchemaForViewer }),
  Object.freeze({ method: "GET", path: "/api/m/:managerId/engines/:engineId/runtimes/:runtimeId/flags", redact: null }),
  Object.freeze({ method: "GET", path: "/api/m/:managerId/instances", redact: redactInstancesForViewer }),
  Object.freeze({ method: "GET", path: "/api/m/:managerId/instances/:id/metrics", redact: redactInstanceMetricsForViewer }),
]);

// Declared owner-only so 05's inventory lists them: logs, argv and launch
// records carry paths and prompts, and every write is owner-only.
const adminOnlyRoutes = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/m/:managerId/instances/:id/logs" }),
  Object.freeze({ method: "GET", path: "/api/m/:managerId/instances/:id/launch" }),
  Object.freeze({ method: "GET", path: "/api/m/:managerId/launches" }),
  Object.freeze({ method: "GET", path: "/api/m/:managerId/launches/:launchId" }),
  Object.freeze({ method: "POST", path: ENDPOINTS_PATH }),
  Object.freeze({ method: "PATCH", path: `${ENDPOINTS_PATH}/:endpointId` }),
  Object.freeze({ method: "DELETE", path: `${ENDPOINTS_PATH}/:endpointId` }),
  Object.freeze({ method: "POST", path: `${ENDPOINTS_PATH}/:endpointId/test` }),
]);

/**
 * Registers viewerRoutes and adminOnlyRoutes in 05's registry. A row another
 * owner already registered (07 registers /api/m/:managerId/instances with the
 * same fleet redaction) is left alone; a row that cannot be registered stays
 * owner-only (deny by default) and is logged.
 */
function registerEngineRoutes(registry, warn = () => {}) {
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
      ...(route.redact ? { redact: route.redact } : {}),
    })),
    ...adminOnlyRoutes.map((route) => () => registry.registerAdminOnly({ owner: OWNER, method: route.method, path: route.path })),
  ];
  for (const register of registrations) {
    try {
      register();
    } catch (error) {
      warn(`engine-routes: a viewer registry entry was not registered and stays owner-only: ${error?.message || error}`);
    }
  }
}

// --- endpoint registry file --------------------------------------------------------

function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The registry file {schemaVersion:1, endpoints:[…]}. Writes are serialised and
 * atomic (temp file + rename). A file that cannot be parsed is never
 * overwritten: every call fails with endpoint_store_corrupt until it is fixed.
 */
function createEndpointStore(options = {}) {
  const file = path.resolve(String(options.file || ""));
  let queue = Promise.resolve();

  async function load() {
    let text;
    try {
      text = await fs.promises.readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw storeError("endpoint_store_unreadable", "The external endpoint registry could not be read.");
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw storeError("endpoint_store_corrupt", "The external endpoint registry is not valid JSON.");
    }
    if (!isPlainObject(data) || !Array.isArray(data.endpoints)) throw storeError("endpoint_store_corrupt", "The external endpoint registry has an unexpected shape.");
    return data.endpoints.filter(isPlainObject);
  }

  async function save(endpoints) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temp, `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, endpoints }, null, 2)}\n`, "utf8");
    try {
      await fs.promises.rename(temp, file);
    } catch (error) {
      await fs.promises.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  // Runs fn(endpoints) → { endpoints?, result } serially; a returned list is saved.
  function mutate(fn) {
    const run = queue.then(async () => {
      const current = await load();
      const outcome = await fn(current);
      if (outcome && Array.isArray(outcome.endpoints)) await save(outcome.endpoints);
      return outcome ? outcome.result : undefined;
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    file,
    list: () => queue.then(load),
    async get(endpointId) {
      return (await this.list()).find((item) => item.endpointId === endpointId) || null;
    },
    mutate,
  };
}

// --- the routes ----------------------------------------------------------------------

function errorBody(code, message, extra = {}) {
  const { hint, details, errors } = extra;
  return {
    ok: false,
    error: { code, message, ...(hint ? { hint } : {}), ...(details ? { details } : {}) },
    ...(Array.isArray(errors) && errors.length ? { errors } : {}),
  };
}

function defaultSendJson(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
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

// Who is calling: "owner" (the console owner and system:cli), "reader"
// (system:mcp), "viewer", or "none". Anything but the owner gets the viewer copy.
function resolvePrincipal(auth, req) {
  let who = {};
  try {
    who = auth.principal(req) || {};
  } catch {
    who = {};
  }
  const principal = String(who.principal || "");
  if (who.role === "owner") return { kind: "owner", principal };
  if (who.role === "system") {
    if (principal === "system:cli") return { kind: "owner", principal };
    if (principal === "system:mcp") return { kind: "reader", principal };
    return { kind: "machine", principal };
  }
  if (who.role === "viewer") return { kind: "viewer", principal };
  return { kind: "none", principal };
}

function mergeEndpoint(existing, patch) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (["models", "capabilities", "apiSurface", "routing"].includes(key) && isPlainObject(value) && isPlainObject(existing[key])) {
      merged[key] = { ...existing[key], ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * createEngineRoutes({ auth, sendJson, readJsonObjectBody, managers, managerClient, store, host,
 *   secrets, logger, now }) → { handle(req, res, url) → Promise<boolean>, host, store, close() }.
 * `managers` is [{ id, port }]; `managerClient` is the entry's shared client
 * (get(managerId, "engines", { timeoutMs })). `secrets` is a vault with
 * get/set/remove(namespace, name).
 */
function createEngineRoutes(options = {}) {
  const auth = options.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function") {
    throw new TypeError("createEngineRoutes needs the request-auth seam");
  }
  const sendJson = typeof options.sendJson === "function" ? options.sendJson : defaultSendJson;
  const readJsonObjectBody = typeof options.readJsonObjectBody === "function" ? options.readJsonObjectBody : defaultReadJsonObjectBody;
  const logger = options.logger || console;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const managers = Array.isArray(options.managers) ? options.managers : [];
  const store = options.store;
  const secrets = options.secrets;
  const host = options.host || createExternalHost({ secrets, now });
  const ownsHost = !options.host;

  function warn(line) {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks a request.
    }
  }

  function sendError(res, status, code, message, extra) {
    sendJson(res, errorBody(code, message, extra), status);
  }

  function sendStoreFailure(res, error, what) {
    if (error?.code === "secret_store_unavailable" || error?.status === 503) {
      sendError(res, 503, "secret_store_unavailable", "The secret store is not available.", { hint: "Run the platform doctor to check the secret store." });
      return;
    }
    if (error?.code === "endpoint_store_corrupt" || error?.code === "endpoint_store_unreadable") {
      sendError(res, 503, error.code, error.message, { hint: "Fix or remove service-entry/data/external-endpoints.json, then try again." });
      return;
    }
    warn(`engine-routes: ${what} failed: ${error?.message || error}`);
    sendError(res, 500, "internal_error", "Service entry error.");
  }

  // The owner copy of a record: no key (there is none in the record), with the cached health.
  function ownerView(record) {
    return { ...record, hostClass: adapter.hostClassOf(record), health: host.healthOf(record.endpointId) };
  }

  async function readBody(req, res) {
    try {
      return await readJsonObjectBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (Number(error?.status) === 413) sendError(res, 413, "request_too_large", `The request body may be at most ${MAX_BODY_BYTES} bytes.`);
      else sendError(res, 400, "invalid_json", "The request body must be a JSON object.");
      return null;
    }
  }

  // null when the owner may write, otherwise [status, code, message].
  function writeRefusal(req, who) {
    if (who.kind === "none") return [401, "admin_session_required", "This needs the console owner. Open the console on this machine."];
    if (who.kind !== "owner") return [403, "principal_route_forbidden", `${who.principal || "This caller"} may not change external endpoints.`];
    let allowed;
    try {
      allowed = auth.checkWrite(req) || {};
    } catch {
      allowed = { ok: false, status: 401, code: "admin_session_required" };
    }
    if (allowed.ok) return null;
    return [Number(allowed.status) || 403, String(allowed.code || "management_local_only"), String(allowed.message || "This action needs the console owner.")];
  }

  // The aggregate (§21.2): each manager's /api/engines through the manager
  // client; an offline manager becomes an errors[] row, the rest still answers.
  async function aggregate(who) {
    const client = typeof options.managerClient === "function" ? options.managerClient() : options.managerClient;
    const results = await Promise.all(managers.map(async (manager) => {
      try {
        if (!client || typeof client.get !== "function") return { manager, failure: { code: "manager_unreachable", message: "The manager client is not available." } };
        const result = await client.get(manager.id, "engines", { timeoutMs: MANAGER_TIMEOUT_MS });
        if (result?.ok && isPlainObject(result.data)) return { manager, data: result.data };
        return { manager, failure: { code: String(result?.code || "manager_unreachable"), message: String(result?.message || `The ${manager.id} manager did not answer.`) } };
      } catch (error) {
        return { manager, failure: { code: "manager_unreachable", message: `The ${manager.id} manager did not answer.` } };
      }
    }));
    const engines = [];
    const errors = [];
    const summary = [];
    for (const { manager, data, failure } of results) {
      if (failure) {
        errors.push({ managerId: manager.id, source: "manager", engineId: "", path: "", code: failure.code, message: failure.message });
        summary.push({ managerId: manager.id, ok: false, code: failure.code });
        continue;
      }
      for (const engine of Array.isArray(data.engines) ? data.engines : []) engines.push({ ...engine, managerId: manager.id });
      for (const item of Array.isArray(data.errors) ? data.errors : []) errors.push({ ...item, managerId: manager.id });
      summary.push({ managerId: manager.id, ok: true, generatedAt: data.generatedAt || null });
    }
    let endpoints = [];
    try {
      endpoints = (await store.list()).map(ownerView);
    } catch (error) {
      errors.push({ managerId: "entry", source: "external", engineId: "external", path: "", code: String(error?.code || "endpoint_store_unreadable"), message: String(error?.message || "The external endpoint registry could not be read.") });
    }
    const body = {
      ok: true,
      generatedAt: new Date(now()).toISOString(),
      managers: summary,
      engines,
      external: { engineId: adapter.ENGINE_ID, endpoints },
      errors,
    };
    return who.kind === "owner" ? body : redactEnginesForViewer(body);
  }

  async function listEndpoints(who) {
    const endpoints = (await store.list()).map(ownerView);
    const body = { ok: true, engineId: adapter.ENGINE_ID, endpoints };
    return who.kind === "owner" ? body : redactEndpointsBodyForViewer(body);
  }

  // Rejects a baseUrl whose host name now resolves to a blocked address. A
  // name that does not resolve yet is accepted: the service may not be up.
  async function checkTarget(baseUrl) {
    try {
      await host.assertAllowedTarget(baseUrl);
      return null;
    } catch (error) {
      if (error?.code === "dns_failed") return null;
      return { path: "baseUrl", code: String(error?.code || "blocked_address"), message: String(error?.message || "baseUrl is not allowed.") };
    }
  }

  async function createEndpoint(req, res) {
    const body = await readBody(req, res);
    if (!body) return;
    const { apiKey, ...input } = body;
    const problems = [];
    if (apiKey !== undefined && apiKey !== null && apiKey !== "") {
      const checked = adapter.validateApiKey(apiKey);
      if (!checked.ok) problems.push(checked.error);
    }
    const validated = adapter.validateEndpoint(input, { now });
    problems.push(...validated.errors);
    if (!problems.length) {
      const blocked = await checkTarget(validated.endpoint.baseUrl);
      if (blocked) problems.push(blocked);
    }
    if (problems.length) {
      sendError(res, 400, "endpoint_invalid", "The external endpoint is not valid; nothing was saved.", { errors: problems });
      return;
    }
    const record = validated.endpoint;
    const hasKey = typeof apiKey === "string" && apiKey !== "";
    if (hasKey) record.apiKeyRef = `${adapter.SECRET_NAMESPACE}:${record.endpointId}`;
    try {
      const outcome = await store.mutate(async (current) => {
        if (current.some((item) => item.endpointId === record.endpointId)) return { result: { conflict: true } };
        if (current.length >= MAX_ENDPOINTS) return { result: { full: true } };
        // The key first: if the registry write fails the key is removed again.
        if (hasKey) await secrets.set(adapter.SECRET_NAMESPACE, record.endpointId, apiKey);
        return { endpoints: [...current, record], result: { created: true } };
      });
      if (outcome.conflict) {
        sendError(res, 409, "endpoint_exists", `An external endpoint named ${record.endpointId} already exists.`, { hint: "Choose another endpointId or PATCH the existing one." });
        return;
      }
      if (outcome.full) {
        sendError(res, 409, "too_many_endpoints", `At most ${MAX_ENDPOINTS} external endpoints can be registered.`);
        return;
      }
    } catch (error) {
      if (hasKey) await Promise.resolve(secrets.remove(adapter.SECRET_NAMESPACE, record.endpointId)).catch(() => {});
      sendStoreFailure(res, error, "registering an external endpoint");
      return;
    }
    host.checkNow(record).catch(() => {});
    sendJson(res, { ok: true, endpoint: ownerView(record) }, 201);
  }

  async function patchEndpoint(req, res, endpointId) {
    const body = await readBody(req, res);
    if (!body) return;
    const { apiKey, ...patch } = body;
    const problems = [];
    if (patch.endpointId !== undefined && patch.endpointId !== endpointId) {
      problems.push({ path: "endpointId", code: "immutable", message: "endpointId cannot be changed; register a new endpoint instead." });
    }
    if (patch.createdAt !== undefined) problems.push({ path: "createdAt", code: "immutable", message: "createdAt cannot be changed." });
    if (patch.apiKeyRef !== undefined) problems.push({ path: "apiKeyRef", code: "invalid_api_key_ref", message: "apiKeyRef is set by the platform; send the key as the write-only apiKey field." });
    const setKey = typeof apiKey === "string" && apiKey !== "";
    const clearKey = apiKey === null || apiKey === "";
    if (apiKey !== undefined && !setKey && !clearKey) problems.push({ path: "apiKey", code: "invalid_api_key", message: "apiKey must be a string, or null to remove the stored key." });
    if (setKey) {
      const checked = adapter.validateApiKey(apiKey);
      if (!checked.ok) problems.push(checked.error);
    }
    let outcome;
    try {
      outcome = await store.mutate(async (current) => {
        const index = current.findIndex((item) => item.endpointId === endpointId);
        if (index < 0) return { result: { missing: true } };
        const existing = current[index];
        if (problems.length) return { result: { problems } };
        const { endpointId: ignoredId, createdAt: ignoredAt, apiKeyRef: ignoredRef, ...changes } = patch;
        const merged = mergeEndpoint(existing, changes);
        // A plaintext-remote acknowledgement belongs to the address it was given for.
        const sameAddress = changes.baseUrl === undefined || String(changes.baseUrl).trim().replace(/\/+$/, "") === existing.baseUrl;
        const validated = adapter.validateEndpoint(merged, { now, acknowledged: sameAddress ? existing.acknowledged : [] });
        const found = [...validated.errors];
        if (!found.length && changes.baseUrl !== undefined) {
          const blocked = await checkTarget(validated.endpoint.baseUrl);
          if (blocked) found.push(blocked);
        }
        if (found.length) return { result: { problems: found } };
        const record = { ...validated.endpoint, createdAt: existing.createdAt };
        const hadKey = Boolean(existing.apiKeyRef);
        if (setKey) {
          await secrets.set(adapter.SECRET_NAMESPACE, endpointId, apiKey);
          record.apiKeyRef = `${adapter.SECRET_NAMESPACE}:${endpointId}`;
        } else if (clearKey) {
          if (hadKey) await secrets.remove(adapter.SECRET_NAMESPACE, endpointId);
          record.apiKeyRef = "";
        } else {
          record.apiKeyRef = existing.apiKeyRef || "";
        }
        const next = [...current];
        next[index] = record;
        return { endpoints: next, result: { record } };
      });
    } catch (error) {
      sendStoreFailure(res, error, "updating an external endpoint");
      return;
    }
    if (outcome.missing) {
      sendError(res, 404, "endpoint_not_found", `There is no external endpoint named ${endpointId}.`);
      return;
    }
    if (outcome.problems) {
      sendError(res, 400, "endpoint_invalid", "The external endpoint is not valid; nothing was saved.", { errors: outcome.problems });
      return;
    }
    host.checkNow(outcome.record).catch(() => {});
    sendJson(res, { ok: true, endpoint: ownerView(outcome.record) });
  }

  async function deleteEndpoint(req, res, url, endpointId) {
    if (url.searchParams.get("confirm") !== "1") {
      req.resume?.();
      sendError(res, 400, "confirm_required", "Removing an external endpoint deletes its stored key; add ?confirm=1 to confirm.");
      return;
    }
    let outcome;
    try {
      outcome = await store.mutate(async (current) => {
        const existing = current.find((item) => item.endpointId === endpointId);
        if (!existing) return { result: { missing: true } };
        if (existing.apiKeyRef) await secrets.remove(adapter.SECRET_NAMESPACE, endpointId);
        return { endpoints: current.filter((item) => item.endpointId !== endpointId), result: { removed: true } };
      });
    } catch (error) {
      sendStoreFailure(res, error, "removing an external endpoint");
      return;
    }
    if (outcome.missing) {
      sendError(res, 404, "endpoint_not_found", `There is no external endpoint named ${endpointId}.`);
      return;
    }
    host.forget(endpointId);
    sendJson(res, { ok: true, removed: endpointId });
  }

  // A GET-only probe: GET {base}/models (and Ollama's /api/ps). It tries a
  // disabled endpoint too, so a registration can be checked before enabling.
  async function testEndpoint(req, res, endpointId) {
    req.resume?.();
    let endpoint;
    try {
      endpoint = await store.get(endpointId);
    } catch (error) {
      sendStoreFailure(res, error, "reading the external endpoints");
      return;
    }
    if (!endpoint) {
      sendError(res, 404, "endpoint_not_found", `There is no external endpoint named ${endpointId}.`);
      return;
    }
    const result = await host.checkNow(endpoint);
    let models = [];
    let failure = result.ok ? null : { code: result.error || result.state, message: `The endpoint is ${result.state}.` };
    if (result.ok) {
      try {
        models = (await host.listModels(endpoint)).map((item) => item.id);
      } catch (error) {
        failure = { code: String(error?.code || "error"), message: String(error?.message || "The model list could not be read.") };
      }
    }
    sendJson(res, {
      ok: !failure,
      endpointId,
      latencyMs: result.latencyMs,
      state: result.state,
      models,
      ...(result.ollama ? { ollama: result.ollama } : {}),
      ...(failure ? { error: failure } : {}),
    });
  }

  function match(pathname) {
    if (pathname === "/api/engines") return { name: "aggregate", methods: ["GET"] };
    if (pathname === ENDPOINTS_PATH) return { name: "endpoints", methods: ["GET", "POST"] };
    if (!pathname.startsWith(`${ENDPOINTS_PATH}/`)) return null;
    const rest = pathname.slice(ENDPOINTS_PATH.length + 1).split("/");
    let endpointId;
    try {
      endpointId = decodeURIComponent(rest[0]);
    } catch {
      return null;
    }
    if (!endpointId) return null;
    if (rest.length === 1) return { name: "endpoint", endpointId, methods: ["PATCH", "DELETE"] };
    if (rest.length === 2 && rest[1] === "test") return { name: "test", endpointId, methods: ["POST"] };
    return null;
  }

  async function handle(req, res, url) {
    const pathname = String(url?.pathname || "");
    if (!pathname.startsWith("/api/engines")) return false;
    const route = match(pathname);
    if (!route) return false;
    const requested = String(req.method || "GET").toUpperCase();
    const method = requested === "HEAD" ? "GET" : requested;
    if (!route.methods.includes(method)) {
      req.resume?.();
      sendJson(res, errorBody("method_not_allowed", `${requested} is not supported on ${pathname}.`), 405, { allow: route.methods.join(", ") });
      return true;
    }
    const who = resolvePrincipal(auth, req);
    try {
      if (READ_METHODS.has(requested)) {
        if (who.kind === "none" || who.kind === "machine") {
          req.resume?.();
          if (who.kind === "machine") sendError(res, 403, "principal_route_forbidden", `${who.principal || "This principal"} may not call ${requested} ${pathname}.`);
          else sendError(res, 401, "admin_session_required", "This needs the console owner. Open the console on this machine.", { hint: "pair" });
          return true;
        }
        sendJson(res, route.name === "aggregate" ? await aggregate(who) : await listEndpoints(who));
        return true;
      }
      const refused = writeRefusal(req, who);
      if (refused) {
        req.resume?.();
        sendError(res, ...refused);
        return true;
      }
      if (route.name === "endpoints") await createEndpoint(req, res);
      else if (route.name === "endpoint" && method === "PATCH") await patchEndpoint(req, res, route.endpointId);
      else if (route.name === "endpoint") await deleteEndpoint(req, res, url, route.endpointId);
      else await testEndpoint(req, res, route.endpointId);
    } catch (error) {
      sendStoreFailure(res, error, `${requested} ${pathname}`);
    }
    return true;
  }

  return {
    handle,
    host,
    store,
    close() {
      if (ownsHost) host.stopMonitor();
    },
  };
}

// Route module (07 §2.7). The vault, the registry file and the host can be
// supplied on ctx (tests); by default the vault is the platform's single
// secret store and the file is service-entry/data/external-endpoints.json.
function mount(ctx) {
  const auth = ctx?.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function" || !auth.viewerRegistry) {
    throw new Error("engine-routes: ctx.auth is missing");
  }
  const logger = ctx.logger || console;
  const warn = (line) => {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks the mount.
    }
  };
  registerEngineRoutes(auth.viewerRegistry, warn);
  let vault = ctx.engineSecrets || null;
  // The vault opens its files lazily; nothing is read until a key is used.
  const secrets = {
    get: (namespace, name) => (vault || (vault = require("../../manager-core/secret-store").createSecretVault({ aiRoot: ctx.aiRoot }))).get(namespace, name),
    set: (namespace, name, value) => (vault || (vault = require("../../manager-core/secret-store").createSecretVault({ aiRoot: ctx.aiRoot }))).set(namespace, name, value),
    remove: (namespace, name) => (vault || (vault = require("../../manager-core/secret-store").createSecretVault({ aiRoot: ctx.aiRoot }))).remove(namespace, name),
  };
  const file = ctx.externalEndpointsFile || path.join(ctx.dataDir || path.join(ctx.rootDir || path.resolve(__dirname, ".."), "data"), "external-endpoints.json");
  const store = createEndpointStore({ file });
  const host = ctx.externalHost || createExternalHost({ secrets, now: ctx.now });
  const routes = createEngineRoutes({
    auth,
    sendJson: ctx.sendJson,
    readJsonObjectBody: ctx.readJsonObjectBody,
    managers: Array.isArray(ctx.managers) ? ctx.managers : [],
    managerClient: () => ctx.managerClient,
    store,
    host,
    secrets,
    logger,
    now: typeof ctx.now === "function" ? ctx.now : Date.now,
  });
  if (ctx.externalHealthMonitor !== false) host.startMonitor(async () => (await store.list().catch(() => [])));
  return {
    handle: routes.handle,
    close() {
      host.stopMonitor();
    },
  };
}

module.exports = {
  ENDPOINTS_PATH,
  MAX_ENDPOINTS,
  adminOnlyRoutes,
  createEndpointStore,
  createEngineRoutes,
  mount,
  name: "engines",
  redactEndpointForViewer,
  redactEndpointsBodyForViewer,
  redactEngineSchemaForViewer,
  redactEnginesForViewer,
  redactInstanceMetricsForViewer,
  redactInstancesForViewer,
  redactManagerEnginesForViewer,
  registerEngineRoutes,
  resolvePrincipal,
  viewerRoutes,
};
