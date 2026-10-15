"use strict";

// The managers' legacy download routes as forwarding shims (03 §15). HUB-13a
// covers the job routes and the SSE `jobs` relay, HUB-13b every other row of
// the table (download, estimate, catalogue, settings, probe, link, login,
// storage and the model list). The job part:
//
//   GET  /api/jobs[?fields=summary]   local jobs + this manager's hub downloads
//   GET  /api/jobs/:id[/logs|/resume-check], POST /api/jobs/:id/pause|resume|cancel
//        dl_* ids, and ids the hub knows as legacyIds, go to the hub; every
//        other id falls through to the manager's own job routes
//   SSE  /api/events `jobs`           re-read on each upstream `downloads` event
//
// The manager registers these routes before core.registerJobRoutes, and its
// managerSecurityGuard has already authorized the caller (00 §5). Every hub
// call goes through the signed client (client.js). The hub's answers are
// mapped to the legacy shapes by compat.js, so the legacy UIs and
// platform-mcp read hub jobs unchanged.
//
// Hub down: the job list answers with the local jobs only and the header
// x-hub-unavailable: 1; a hub job route answers 503 { error, code } with
// hub_unavailable or hub_auth_failed. There is no fallback to a legacy queue.
//
// HUB-13b routes (the managers register the shim before core.registerModelRoutes,
// so these win over the legacy handlers). A caller the manager judged not local
// (isLocalRequest false) never gets a token forwarded and never opens the
// Hugging Face login: the shim drops the token and answers the login with the
// legacy 403 without calling the hub (03 §12, §15).

const path = require("node:path");
const { cleanRequired } = require("../common-utils");
const { cleanDownloadSource, normalizeDownloadModelReference, normalizeExtraIncludePatterns, normalizeRemoteQuantFilter } = require("../download-utils");
const { safeOutputName } = require("../settings-stores");
const compat = require("./compat");
const { HubClientError } = require("./client");
const { HubError } = require("./errors");
const { isPlainObject, nonEmpty } = require("./hub-util");
const { compileIncludePatterns, resolveSelection, selectionFromLegacy } = require("./selection");
const hubSettings = require("./settings");

// dl_ plus 16 base32 characters (00 §3); digits are accepted as well.
const HUB_JOB_ID_RE = /^dl_[a-z0-9]{16}$/;
const RELAY_THROTTLE_MS = 700;
const LOCAL_TERMINAL_STATUSES = new Set(["success", "failed", "cancelled"]);
const JOB_ACTIONS = Object.freeze(["pause", "resume", "cancel"]);
// The legacy log route returned the whole job log; the hub serves at most 2000.
const LEGACY_LOG_TAIL = 2000;

function isHubJobId(id) {
  return HUB_JOB_ID_RE.test(String(id || ""));
}

function timeOf(job) {
  const value = Date.parse(job?.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

// Newest first; a stable sort keeps the local order among equal times.
function newestFirst(jobs) {
  return jobs
    .map((job, index) => ({ job, index }))
    .sort((a, b) => (timeOf(b.job) - timeOf(a.job)) || (a.index - b.index))
    .map((item) => item.job);
}

function claimsOf(hubJobs) {
  const claims = new Set();
  for (const job of hubJobs || []) {
    if (!isPlainObject(job)) continue;
    if (job.id) claims.add(String(job.id));
    for (const legacyId of Array.isArray(job.legacyIds) ? job.legacyIds : []) claims.add(String(legacyId));
  }
  return claims;
}

/**
 * The local jobs the merged list keeps. Non-download jobs always stay. A local
 * download record stays only while it is still active and the hub has not
 * claimed its id: HUB-12 imported the ledgers into the hub (legacyIds), so a
 * finished or claimed legacy record would otherwise be listed twice.
 */
function localJobsToKeep(localJobs, claims) {
  return localJobs.filter((job) => {
    if (!isPlainObject(job)) return false;
    if (job.type !== "download") return true;
    if (claims.has(String(job.id))) return false;
    return !LOCAL_TERMINAL_STATUSES.has(job.status);
  });
}

function sendLegacyError(res, status, body) {
  return res.status(status).json(body);
}

// --- HUB-13b: download, catalogue, settings, auth and storage rows ------------

const MANIFEST_PAGE_LIMIT = 2000;
const MANIFEST_MAX_PAGES = 5;
const SEARCH_PAGE_LIMIT = 60;
const SEARCH_MAX_PAGES = 3;
const LIBRARY_PAGE_LIMIT = 500;
const LIBRARY_MAX_PAGES = 4;
const LIBRARY_CACHE_MS = 5000;
const MODELS_DECORATE_TIMEOUT_MS = 1000;
const TASK_POLL_MS = 300;
const TASK_WAIT_MS = 120 * 1000;

const LOCAL_ONLY_COPY = Object.freeze({
  status: "Hugging Face 账号状态仅允许从本机查看。",
  login: "Hugging Face 登录仅允许从本机发起。",
  access: "Hugging Face 授权复检仅允许从本机发起。",
});

// A legacy answer ready to send: raised inside a handler, sent by legacy().
class LegacyReply extends Error {
  constructor(status, body) {
    super(String(body?.error || "Model hub request failed."));
    this.name = "LegacyReply";
    this.status = status;
    this.body = body;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function lowerPath(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function containsPath(parent, child) {
  const relative = path.relative(lowerPath(parent), lowerPath(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The library entry for an absolute path: the entry itself, an alias, or a path inside it (library.findByPath). */
function findEntryByPath(entries, value) {
  if (!path.isAbsolute(String(value || ""))) return null;
  return (entries || [])
    .filter((entry) => entry && entry.rootId && typeof entry.path === "string"
      && (containsPath(entry.path, value) || (Array.isArray(entry.aliases) && entry.aliases.some((alias) => containsPath(alias, value)))))
    .sort((a, b) => b.path.length - a.path.length)[0] || null;
}

function repoPathOf(provider, repo) {
  return `/api/hub/repos/${provider}/${String(repo).split("/").map(encodeURIComponent).join("/")}`;
}

function normalizeRemoteRequest(query, remote = {}) {
  const input = isPlainObject(query) ? query : {};
  const legacy = typeof remote.legacyRemoteCategoryParams === "function" ? remote.legacyRemoteCategoryParams(String(input.category || "")) : {};
  const pick = (fn, value, fallback) => (typeof fn === "function" ? fn(value) : fallback(value));
  const limit = pick(remote.normalizeRemoteLimit, input.limit, (value) => {
    const number = Number(value || 48);
    return Number.isFinite(number) ? Math.min(120, Math.max(12, Math.floor(number))) : 48;
  });
  return {
    source: cleanDownloadSource(input.source || "huggingface"),
    sort: pick(remote.normalizeRemoteSort, input.sort || legacy.sort, (value) => {
      const sort = String(value || "trending").trim().toLowerCase();
      if (["downloads", "likes"].includes(sort)) return sort;
      return ["lastmodified", "latest", "updated"].includes(sort) ? "lastModified" : "trending";
    }),
    task: pick(remote.normalizeRemoteTask, input.task || legacy.task, (value) => (["text", "vision"].includes(String(value || "").toLowerCase()) ? String(value).toLowerCase() : "all")),
    feature: pick(remote.normalizeRemoteFeature, input.feature || legacy.feature, (value) => (["distilled", "uncensored", "moe", "reasoning"].includes(String(value || "").toLowerCase()) ? String(value).toLowerCase() : "all")),
    search: String(input.search || "").trim(),
    limit,
    size: String(input.size || "").trim(),
    freshness: String(input.freshness || "auto").trim(),
    quant: normalizeRemoteQuantFilter(input.quant || legacy.quant),
  };
}

function legacyBodyOf(req) {
  return isPlainObject(req.body) ? req.body : {};
}

/**
 * The model-route half of registerHubShimRoutes. `ctx` carries the closure of
 * the job half: managerId, client, isLocalRequest, originOf, requestIdOf and
 * refreshJobs; `options` the manager hooks (listModels, precheckDownload,
 * remote, precisionOrder, quantKeywords, vllmRuntime, deleteLocalModel).
 */
function registerModelShims(app, ctx) {
  const { managerId, client, isLocalRequest, originOf, requestIdOf, refreshJobs, options } = ctx;
  const clock = options.clock || Date;
  let libraryCache = null;

  const mapperContext = () => ({
    managerId,
    precisionOrder: options.precisionOrder,
    quantKeywords: options.quantKeywords,
  });

  // --- the hub calls --------------------------------------------------------

  async function hubCall(req, method, pathWithQuery, body) {
    const result = await client.request(method, pathWithQuery, body, { requestId: requestIdOf(req) });
    if (result.status === 503 && result.json?.error?.code === "hub_unavailable") throw new HubClientError("hub_unavailable");
    return result;
  }

  // The JSON of a successful call; any hub failure becomes the legacy answer.
  async function hubOk(req, method, pathWithQuery, body, context = {}) {
    const result = await hubCall(req, method, pathWithQuery, body);
    if (result.status >= 400 || !isPlainObject(result.json)) {
      const mapped = compat.toLegacyDownloadError(result.status >= 400 ? result.status : 502, result.json, context);
      throw new LegacyReply(mapped.status, mapped.body);
    }
    return result.json;
  }

  function sendFailure(res, error) {
    if (error instanceof LegacyReply) return res.status(error.status).json(error.body);
    if (error instanceof HubClientError) return sendLegacyError(res, error.status, { error: error.message, code: error.code });
    if (error instanceof HubError) {
      const mapped = compat.toLegacyDownloadError(error.status, { error: { code: error.code, message: error.message, hint: error.hint, details: error.details } }, error.legacyContext);
      return res.status(mapped.status).json(mapped.body);
    }
    const body = { error: String(error?.message || "Model hub request failed.") };
    if (error?.code) body.code = error.code;
    return res.status(Number.isInteger(error?.status) ? error.status : 500).json(body);
  }

  // Wraps a handler so every failure leaves as a legacy { error, code } answer.
  function legacy(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        sendFailure(res, error);
      }
    };
  }

  function requireModel(value, precision) {
    const reference = normalizeDownloadModelReference(value, precision);
    if (!reference.model) {
      const error = new Error("model is required");
      error.status = 400;
      throw error;
    }
    return reference;
  }

  // --- manifest and selection -------------------------------------------------

  async function readManifest(req, provider, repo) {
    const files = [];
    let cursor = null;
    let total = 0;
    let revisionSha = null;
    for (let page = 0; page < MANIFEST_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(MANIFEST_PAGE_LIMIT) });
      if (cursor) query.set("cursor", cursor);
      const json = await hubOk(req, "GET", `${repoPathOf(provider, repo)}/files?${query}`);
      files.push(...(Array.isArray(json.files) ? json.files : []));
      total = Number.isInteger(json.total) ? json.total : files.length;
      revisionSha = json.revisionSha || revisionSha;
      cursor = json.nextCursor || null;
      if (!cursor) break;
    }
    return { repo, files, total, revisionSha };
  }

  // The hub selection of a legacy { precision, includeExtras } (03 §5); a
  // selection that matches nothing raises the 422 filter_no_match legacy error.
  function legacySelection(manifest, { precision, includeExtras }) {
    try {
      return selectionFromLegacy({ precision, includeExtras, repo: manifest.repo }, manifest);
    } catch (error) {
      if (error instanceof HubError) error.legacyContext = { precision, totalFiles: manifest.total };
      throw error;
    }
  }

  async function planFor(req, input, context) {
    const result = await hubCall(req, "POST", "/api/hub/plan", input);
    if (result.status >= 400 || !isPlainObject(result.json)) {
      const mapped = compat.toLegacyDownloadError(result.status >= 400 ? result.status : 502, result.json, context);
      throw new LegacyReply(mapped.status, mapped.body);
    }
    return result.json;
  }

  // --- POST /api/download, GET /api/download/estimate, /precheck --------------

  const startDownload = legacy(async (req, res) => {
    const body = legacyBodyOf(req);
    const requestedModel = cleanRequired(body.model, "model");
    const source = cleanDownloadSource(body.source || "huggingface");
    const reference = normalizeDownloadModelReference(requestedModel, body.precision);
    const includeExtras = normalizeExtraIncludePatterns(body.includeExtras);
    const provider = source === "modelscope" ? "modelscope" : "huggingface";
    const clientLocal = isLocalRequest(req) === true;
    // A token goes upstream only for a caller the manager judged local; the
    // entry checks the signed origin again (03 §12).
    const hfToken = provider === "huggingface" && clientLocal && nonEmpty(body.hfToken) ? String(body.hfToken) : "";
    const manifest = await readManifest(req, provider, reference.model);
    const selection = legacySelection(manifest, { precision: reference.precision, includeExtras });
    const context = { precision: reference.precision, totalFiles: manifest.total, repo: reference.model };
    const target = { rootId: nonEmpty(body.storageId) ? String(body.storageId) : null };
    if (nonEmpty(body.outputName)) target.outputName = safeOutputName(body.outputName);
    const priority = ["high", "normal", "low"].includes(body.priority) ? body.priority : "normal";
    const plan = await planFor(req, {
      provider,
      repo: reference.model,
      revision: "main",
      selection,
      target,
      // A token is only for the official endpoint (03 §12).
      source: hfToken ? "huggingface" : "auto",
      priority,
      ...(hfToken ? { credential: { hfToken } } : {}),
      origin: originOf(req),
    }, context);
    const blocked = compat.planBlockingToLegacy(plan, reference.model);
    if (blocked) throw new LegacyReply(blocked.status, blocked.body);
    const created = await hubOk(req, "POST", "/api/hub/downloads", { planId: plan.planId, origin: originOf(req) }, context);
    refreshJobs();
    res.json({ job: compat.toLegacyJob(created.job) });
  });

  const estimateDownload = legacy(async (req, res) => {
    const query = isPlainObject(req.query) ? req.query : {};
    const source = cleanDownloadSource(query.source || "huggingface");
    const reference = requireModel(query.model, query.precision);
    const provider = source === "modelscope" ? "modelscope" : "huggingface";
    const includeExtras = normalizeExtraIncludePatterns(query.includeExtras);
    const manifest = await readManifest(req, provider, reference.model);
    const target = { rootId: nonEmpty(query.storageId) ? String(query.storageId) : null };
    let selection;
    try {
      selection = legacySelection(manifest, { precision: reference.precision, includeExtras });
    } catch (error) {
      // The legacy estimate answered "filtered, nothing matched" instead of failing.
      if (!(error instanceof HubError) || error.code !== "filter_no_match") throw error;
      let diskFreeBytes = null;
      try {
        diskFreeBytes = compat.toLegacyDiskUsage(await hubOk(req, "GET", "/api/hub/storage/usage")).disk?.freeBytes ?? null;
      } catch {
        // The free space is a courtesy here.
      }
      res.json(compat.emptyLegacyEstimate({ source, model: reference.model, precision: reference.precision, totalFiles: manifest.total, diskFreeBytes }));
      return;
    }
    const plan = await planFor(req, {
      provider,
      repo: reference.model,
      revision: "main",
      selection,
      target,
      source: "auto",
      origin: originOf(req),
    }, { precision: reference.precision, totalFiles: manifest.total, repo: reference.model });
    const compiled = compileIncludePatterns(plan.artifact?.files || [], manifest.files);
    res.json(compat.toLegacyEstimate({ source, model: reference.model, precision: reference.precision, plan, totalFiles: manifest.total, compiled }));
  });

  // Local assessment, but the file list (mirror-aware) and the gated flag come
  // from the hub; the manager hook does the capability matrix and GPU part.
  const precheckDownload = typeof options.precheckDownload === "function"
    ? legacy(async (req, res) => {
      const query = isPlainObject(req.query) ? req.query : {};
      const source = cleanDownloadSource(query.source || "huggingface");
      const reference = requireModel(query.model, query.precision);
      let estimate = null;
      if (source === "huggingface") {
        try {
          const manifest = await readManifest(req, "huggingface", reference.model);
          let selected = manifest.files;
          let bytes = null;
          try {
            const resolved = resolveSelection(manifest, selectionFromLegacy({ precision: reference.precision, includeExtras: [], repo: reference.model }, manifest));
            const names = new Set(resolved.files.map((file) => file.path));
            selected = manifest.files.filter((file) => names.has(file.path));
            bytes = selected.reduce((sum, file) => sum + (Number(file.size) || 0), 0) || null;
          } catch {
            // An unmatched precision leaves the whole listing, as the estimate did.
          }
          let gated = false;
          try {
            const detail = await hubOk(req, "GET", repoPathOf("huggingface", reference.model));
            gated = Boolean(detail.access?.gated);
          } catch {
            // Gated is an informational finding only.
          }
          estimate = {
            bytes,
            fileCount: selected.length,
            siblings: manifest.files.map((file) => ({ name: file.path, size: Number(file.size) || 0 })),
            gated,
            totalFiles: manifest.total,
          };
        } catch (error) {
          estimate = { error: String(error?.message || error) };
        }
      }
      res.json(await options.precheckDownload(query, { estimate }));
    })
    : null;

  app.post("/api/download", startDownload);
  app.get("/api/download/estimate", estimateDownload);
  if (precheckDownload) app.get("/api/download/precheck", precheckDownload);

  // --- the catalogue ------------------------------------------------------------

  app.get("/api/remote-models", legacy(async (req, res) => {
    const request = normalizeRemoteRequest(req.query, options.remote);
    const base = compat.toHubSearchQuery(request, { managerId });
    const items = [];
    let cursor = null;
    for (let page = 0; page < SEARCH_MAX_PAGES && items.length < request.limit; page += 1) {
      const query = new URLSearchParams(base);
      query.set("limit", String(Math.min(SEARCH_PAGE_LIMIT, request.limit - items.length)));
      if (cursor) query.set("cursor", cursor);
      const json = await hubOk(req, "GET", `/api/hub/search?${query}`);
      items.push(...(Array.isArray(json.items) ? json.items : []));
      cursor = json.nextCursor || null;
      if (!cursor) break;
    }
    res.json(compat.toLegacyRemoteSearch(request, items, mapperContext()));
  }));

  app.get("/api/remote-models/gguf-variants", legacy(async (req, res) => {
    const query = isPlainObject(req.query) ? req.query : {};
    const source = cleanDownloadSource(query.source || "huggingface");
    const reference = requireModel(query.model, query.precision);
    if (source !== "huggingface") {
      res.json({ model: reference.model, source, supported: false, variants: [], mmproj: [], drafts: [] });
      return;
    }
    const manifest = await readManifest(req, "huggingface", reference.model);
    // The fits and the gated flag; the variant table is still useful without them.
    const detail = await hubOk(req, "GET", repoPathOf("huggingface", reference.model)).catch((error) => {
      if (error instanceof HubClientError) throw error;
      return null;
    });
    res.json(compat.toLegacyGgufVariants({
      model: reference.model,
      source,
      selected: reference.precision,
      files: manifest.files.map((file) => ({ name: file.path, size: Number(file.size) || 0 })),
      detail,
    }));
  }));

  app.get("/api/remote-models/precision-variants", legacy(async (req, res) => {
    const query = isPlainObject(req.query) ? req.query : {};
    const reference = requireModel(query.model, query.precision);
    const detail = await hubOk(req, "GET", repoPathOf("huggingface", reference.model)).catch((error) => {
      if (error instanceof HubClientError) throw error;
      return null;
    });
    res.json(compat.toLegacyPrecisionVariants(reference.model, detail?.siblingRepos, { vllmRuntime: options.vllmRuntime }));
  }));

  app.post("/api/resolve-model-link", legacy(async (req, res) => {
    const input = cleanRequired(legacyBodyOf(req).url, "url");
    const link = await hubOk(req, "POST", "/api/hub/resolve-link", { url: input });
    let item = null;
    if (link.provider !== "modelscope") {
      // The catalogue summary the legacy answer carried; best effort.
      try {
        const found = await hubOk(req, "GET", `/api/hub/search?${new URLSearchParams({ q: link.repo, provider: "huggingface", limit: "10" })}`);
        item = (found.items || []).find((candidate) => String(candidate.repo).toLowerCase() === String(link.repo).toLowerCase()) || null;
      } catch (error) {
        if (error instanceof HubClientError) throw error;
      }
    }
    res.json(compat.toLegacyResolvedLink(link, item, mapperContext()));
  }));

  // --- settings, probe ------------------------------------------------------------

  app.get("/api/download/settings", legacy(async (req, res) => {
    const json = await hubOk(req, "GET", "/api/hub/settings");
    res.json(hubSettings.toLegacy(json.settings));
  }));

  app.post("/api/download/settings", legacy(async (req, res) => {
    const current = await hubOk(req, "GET", "/api/hub/settings");
    const patch = hubSettings.fromLegacy(legacyBodyOf(req), { current: current.settings });
    let settings = current.settings;
    if (Object.keys(patch).length) {
      // The signed body also carries origin; the entry treats it as metadata.
      const updated = await hubOk(req, "PUT", "/api/hub/settings", { settings: patch, origin: originOf(req) });
      settings = updated.settings;
    }
    res.json(hubSettings.toLegacy(settings));
  }));

  app.post("/api/download/mirror-probe", legacy(async (req, res) => {
    const model = String(legacyBodyOf(req).model || "").trim();
    // Informational: the hub never persists settings for a probe (P0-UI-3).
    const json = await hubOk(req, "POST", "/api/hub/sources/probe", { ...(model.includes("/") ? { repo: model } : {}), origin: originOf(req) });
    res.json(compat.toLegacyProbe(json));
  }));

  // --- Hugging Face login -----------------------------------------------------------

  app.get("/api/huggingface/auth/status", legacy(async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: LOCAL_ONLY_COPY.status });
    res.json(compat.toLegacyAuthStatus(await hubOk(req, "GET", "/api/hub/auth/huggingface")));
    return undefined;
  }));

  app.post("/api/huggingface/auth/login", legacy(async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: LOCAL_ONLY_COPY.login });
    const json = await hubOk(req, "POST", "/api/hub/auth/huggingface/login", { origin: originOf(req) });
    res.json({ launched: Boolean(json.launched), tokenUrl: json.tokenUrl || "https://huggingface.co/settings/tokens" });
    return undefined;
  }));

  app.get("/api/huggingface/access", legacy(async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: LOCAL_ONLY_COPY.access });
    const query = isPlainObject(req.query) ? req.query : {};
    const reference = requireModel(query.model, query.precision);
    const access = await hubOk(req, "GET", `/api/hub/auth/huggingface/access?${new URLSearchParams({ repo: reference.model })}`);
    // Whether the repository is gated at all; unknown when the detail cannot be read.
    const detail = await hubOk(req, "GET", repoPathOf("huggingface", reference.model)).catch(() => null);
    res.json(compat.toLegacyAccess({ model: reference.model, access, detail }));
    return undefined;
  }));

  // --- storage and the library ------------------------------------------------------

  async function readLibrary(req, { fresh = false } = {}) {
    if (!fresh && libraryCache && clock.now() - libraryCache.at < LIBRARY_CACHE_MS) return libraryCache.value;
    const entries = [];
    let roots = [];
    let cursor = null;
    for (let page = 0; page < LIBRARY_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(LIBRARY_PAGE_LIMIT) });
      if (cursor) query.set("cursor", cursor);
      const json = await hubOk(req, "GET", `/api/hub/library?${query}`);
      entries.push(...(Array.isArray(json.entries) ? json.entries : []));
      roots = Array.isArray(json.roots) ? json.roots : roots;
      cursor = json.nextCursor || null;
      if (!cursor) break;
    }
    const value = { entries, roots };
    libraryCache = { at: clock.now(), value };
    return value;
  }

  // The model directory named by `path` (inside a registered root) or `name`
  // (a folder of a library), as the legacy resolveModelDirectory did. A path
  // outside every root, or a root itself, is 400 path_outside_roots.
  async function resolveEntry(req, input) {
    const { entries, roots } = await readLibrary(req, { fresh: true });
    const libraryRoots = roots.filter((root) => root && root.mode !== "cache" && typeof root.path === "string");
    let entry = null;
    let target = nonEmpty(input.path) ? String(input.path).trim() : "";
    if (target) {
      const inside = libraryRoots.some((root) => containsPath(root.path, target) && lowerPath(root.path) !== lowerPath(target));
      if (!path.isAbsolute(target) || !inside) {
        throw new LegacyReply(400, { error: "路径必须位于已登记的模型库内，且不能是模型库本身。 / The path must be inside a configured model library and must not be the library itself.", code: "path_outside_roots" });
      }
      entry = findEntryByPath(entries, target);
    } else {
      const name = cleanRequired(input.name, "name");
      if (path.isAbsolute(name)) {
        target = name;
        entry = findEntryByPath(entries, name);
      } else {
        const wanted = new Set([name, safeOutputName(name)].map((value) => value.toLowerCase()));
        const matches = entries.filter((candidate) => candidate.rootId && ["folder", "single-file"].includes(candidate.kind)
          && [candidate.displayName, candidate.relativePath, path.basename(candidate.path || "")].some((value) => wanted.has(String(value || "").toLowerCase())));
        const defaultRoot = roots.find((root) => root.default)?.id;
        entry = matches.find((candidate) => candidate.rootId === defaultRoot) || matches[0] || null;
        target = entry?.path || name;
      }
    }
    if (!entry) throw new LegacyReply(404, { error: "本地模型目录不存在，可能已被删除。 / The model folder does not exist; it may have been deleted.", code: "library_entry_not_found" });
    return { entry, target };
  }

  app.get("/api/models/disk-usage", legacy(async (req, res) => {
    res.json(compat.toLegacyDiskUsage(await hubOk(req, "GET", "/api/hub/storage/usage")));
  }));

  app.post("/api/models/cleanup-incomplete", legacy(async (req, res) => {
    const { entry } = await resolveEntry(req, legacyBodyOf(req));
    const json = await hubOk(req, "POST", `/api/hub/library/${encodeURIComponent(entry.id)}/cleanup-residue`, { origin: originOf(req) });
    libraryCache = null;
    res.json(compat.toLegacyCleanup(entry.path, json));
  }));

  app.get("/api/models/upstream-status", legacy(async (req, res) => {
    const query = isPlainObject(req.query) ? req.query : {};
    const { entry } = await resolveEntry(req, query);
    const name = nonEmpty(query.name) ? String(query.name).trim() : path.basename(entry.path);
    const json = await hubOk(req, "POST", `/api/hub/library/${encodeURIComponent(entry.id)}/check-update`, { origin: originOf(req) });
    // An explicit ?model= names the repo when the folder has no record, as before.
    res.json(compat.toLegacyUpstreamStatus({ name, entry, update: json.update }));
  }));

  async function waitForTask(req, taskId) {
    const deadline = clock.now() + TASK_WAIT_MS;
    for (;;) {
      const json = await hubOk(req, "GET", `/api/hub/tasks/${encodeURIComponent(taskId)}`);
      const task = isPlainObject(json.task) ? json.task : {};
      if (task.state === "succeeded" || task.state === "failed") return task;
      if (clock.now() >= deadline) return task;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, TASK_POLL_MS);
        timer.unref?.();
      });
    }
  }

  if (options.deleteLocalModel !== false) {
    app.post("/api/models/delete-local", legacy(async (req, res) => {
      const input = legacyBodyOf(req);
      const name = cleanRequired(input.name, "name");
      const { entry, target } = await resolveEntry(req, { name });
      // The legacy route took the folder name as the confirmation; the entry
      // asks for its display name, which is what the caller just named.
      const started = await hubOk(req, "DELETE", `/api/hub/library/${encodeURIComponent(entry.id)}`, { confirm: entry.displayName, origin: originOf(req) });
      libraryCache = null;
      const task = await waitForTask(req, started.taskId);
      if (task.state === "failed") {
        const code = task.error?.code === "storage_busy" || /busy|download|mount/i.test(String(task.error?.message || "")) ? 409 : 500;
        throw new LegacyReply(code, { error: String(task.error?.message || "Delete failed."), code: String(task.error?.code || "task_failed") });
      }
      res.json({ ok: true, name, path: target, ...(task.state === "succeeded" ? {} : { taskId: started.taskId, pending: true }) });
    }));
  }

  // GET /api/models: the manager's own listing, plus the library entry and the
  // provenance of each local model (best effort, 1 s).
  if (typeof options.listModels === "function") {
    app.get("/api/models", async (req, res) => {
      try {
        const collections = await options.listModels();
        let decorated = collections;
        try {
          const { entries } = await withTimeout(readLibrary(req), MODELS_DECORATE_TIMEOUT_MS);
          if (Array.isArray(collections?.local)) {
            decorated = {
              ...collections,
              local: collections.local.map((model) => {
                const entry = findEntryByPath(entries, model?.path);
                if (!entry) return model;
                const provenance = isPlainObject(entry.provenance) ? entry.provenance : {};
                return {
                  ...model,
                  libraryEntryId: entry.id,
                  provenance: {
                    provider: provenance.provider || null,
                    repo: provenance.repo || null,
                    revisionSha: provenance.revisionSha || null,
                    confidence: provenance.confidence || null,
                  },
                };
              }),
            };
          }
        } catch {
          // The listing stays unchanged when the hub is slow or down.
        }
        res.json(decorated);
      } catch (error) {
        sendFailure(res, error);
      }
    });
  }
}

/**
 * registerHubShimRoutes(app, { managerId, client, isLocalRequest, ... }) →
 * { jobsSnapshot, refreshJobs, startRelay, close }.
 *
 * Manager hooks: listLocalJobs() (newest first), getLocalJob(id),
 * beforeReadJobs(), summarizeJob(job), onSnapshot() (re-broadcast the jobs
 * event), hasListeners() (skip relay re-reads while nobody listens).
 * HUB-13b hooks: listModels() (the manager's own /api/models listing, which the
 * shim decorates), precheckDownload(query, { estimate }) (the local assessment
 * over the hub's file list), remote (the manager's catalogue normalizers),
 * precisionOrder, quantKeywords, vllmRuntime (mapper inputs) and
 * deleteLocalModel: false (llama has no delete-local route).
 */
function registerHubShimRoutes(app, options = {}) {
  const managerId = String(options.managerId || "");
  const client = options.client;
  if (!client || typeof client.request !== "function" || typeof client.listJobs !== "function") {
    throw new Error("registerHubShimRoutes needs a hub client.");
  }
  const isLocalRequest = typeof options.isLocalRequest === "function" ? options.isLocalRequest : () => false;
  const listLocalJobs = typeof options.listLocalJobs === "function" ? options.listLocalJobs : () => [];
  const getLocalJob = typeof options.getLocalJob === "function" ? options.getLocalJob : () => undefined;
  const beforeReadJobs = typeof options.beforeReadJobs === "function" ? options.beforeReadJobs : () => {};
  const summarizeJob = typeof options.summarizeJob === "function" ? options.summarizeJob : (job) => job;
  const onSnapshot = typeof options.onSnapshot === "function" ? options.onSnapshot : () => {};
  const hasListeners = typeof options.hasListeners === "function" ? options.hasListeners : () => true;
  const clock = options.clock || Date;
  const timers = options.timers || { setTimeout, clearTimeout };
  const throttleMs = Math.max(0, Number(options.relayThrottleMs ?? RELAY_THROTTLE_MS));

  // The last hub list this manager read (API shape, owner = this manager).
  // The SSE snapshot uses it between re-reads.
  let hubJobs = [];
  let subscription = null;
  let relayTimer = null;
  let relayInFlight = false;
  let relayPending = false;
  let lastReadAt = -Infinity;
  let closed = false;

  function requestIdOf(req) {
    return req?.headers?.["x-request-id"];
  }

  function originOf(req) {
    return { kind: "manager-shim", managerId, clientLocal: isLocalRequest(req) === true };
  }

  async function readHubJobs(requestId) {
    try {
      const result = await client.listJobs({ requestId });
      if (result.status === 200 && Array.isArray(result.json?.jobs)) {
        hubJobs = result.json.jobs.filter(isPlainObject);
        return { ok: true, jobs: hubJobs };
      }
    } catch (error) {
      if (!(error instanceof HubClientError)) throw error;
    }
    return { ok: false, jobs: [] };
  }

  function mergedJobs(local, hub, { summary }) {
    const kept = localJobsToKeep(local, claimsOf(hub)).map((job) => (summary ? summarizeJob(job) : job));
    const mapped = hub.map((job) => compat.toLegacyJob(job, { summary }));
    return newestFirst([...kept, ...mapped]);
  }

  /** The SSE `jobs` payload: local summaries plus the last hub list. */
  function jobsSnapshot() {
    return mergedJobs(Array.from(listLocalJobs() || []), hubJobs, { summary: true });
  }

  // --- the jobs relay ---------------------------------------------------------

  async function relayRead() {
    relayTimer = null;
    if (closed) return;
    if (relayInFlight) {
      relayPending = true;
      return;
    }
    relayInFlight = true;
    try {
      const read = await readHubJobs();
      if (read.ok && !closed) onSnapshot();
    } catch {
      // A relay read never breaks the manager.
    } finally {
      relayInFlight = false;
      lastReadAt = clock.now();
    }
    if (relayPending && !closed) {
      relayPending = false;
      refreshJobs();
    }
  }

  /** A `downloads` trigger: one signed re-read, at most every 700 ms. */
  function refreshJobs() {
    if (closed) return;
    if (!hasListeners()) return;
    if (relayInFlight) {
      relayPending = true;
      return;
    }
    if (relayTimer) return;
    const wait = Math.max(0, lastReadAt + throttleMs - clock.now());
    if (wait === 0) {
      relayRead();
      return;
    }
    relayTimer = timers.setTimeout(relayRead, wait);
    relayTimer?.unref?.();
  }

  function startRelay() {
    if (closed || subscription || typeof client.subscribeDownloads !== "function") return;
    subscription = client.subscribeDownloads((event) => {
      // Only the type matters: the snapshot is re-read, never taken from the
      // event payload (whose redaction belongs to the entry).
      if (event?.event === "downloads") refreshJobs();
    }, {
      // A (re)connect may have missed events.
      onOpen: () => refreshJobs(),
      onError: () => {},
    });
  }

  function close() {
    closed = true;
    if (relayTimer) timers.clearTimeout(relayTimer);
    relayTimer = null;
    try { subscription?.close(); } catch {}
    subscription = null;
  }

  // --- routes -----------------------------------------------------------------

  app.get("/api/jobs", async (req, res) => {
    await beforeReadJobs();
    const summary = String(req.query?.fields || "").trim().toLowerCase() === "summary";
    const read = await readHubJobs(requestIdOf(req));
    const local = Array.from(listLocalJobs() || []);
    if (!read.ok) {
      res.set("x-hub-unavailable", "1");
      return res.json(mergedJobs(local, [], { summary }));
    }
    return res.json(mergedJobs(local, read.jobs, { summary }));
  });

  // Is :id a hub job? dl_ ids always are. A local non-download job never is.
  // A local download record or an unknown id is asked of the hub, which also
  // matches its legacyIds; a 404 there, or an unreachable hub, leaves it to the
  // manager's own routes.
  function routeOf(id) {
    if (isHubJobId(id)) return "hub";
    const local = getLocalJob(id);
    if (local && local.type !== "download") return "local";
    return "probe";
  }

  function sendHubFailure(res, error) {
    if (error instanceof HubClientError) {
      return sendLegacyError(res, error.status, { error: error.message, code: error.code });
    }
    return sendLegacyError(res, 500, { error: "Model hub request failed.", code: "hub_error" });
  }

  // Runs a hub call for a job route and returns its successful JSON body,
  // or null when this route already answered (a mapped error) or handed the
  // request on to the local job routes.
  async function forward(req, res, next, call) {
    const id = String(req.params.id || "");
    const route = routeOf(id);
    if (route === "local") {
      next();
      return null;
    }
    let result;
    try {
      result = await call(id);
    } catch (error) {
      if (route === "probe" && error instanceof HubClientError) next();
      else sendHubFailure(res, error);
      return null;
    }
    const { status, json } = result;
    const hubDown = status === 503 && json?.error?.code === "hub_unavailable";
    if (route === "probe" && (status === 404 || hubDown)) {
      next();
      return null;
    }
    if (hubDown) {
      sendHubFailure(res, new HubClientError("hub_unavailable"));
      return null;
    }
    if (status >= 400 || !isPlainObject(json)) {
      sendLegacyError(res, status >= 400 ? status : 502, compat.toLegacyError(json));
      return null;
    }
    return json;
  }

  const hubPath = (id, suffix = "") => `/api/hub/downloads/${encodeURIComponent(id)}${suffix}`;

  app.get("/api/jobs/:id/logs", async (req, res, next) => {
    try {
      const json = await forward(req, res, next, (id) => client.request("GET", hubPath(id, `/logs?tail=${LEGACY_LOG_TAIL}`), undefined, { requestId: requestIdOf(req) }));
      if (!json) return undefined;
      return res.json(compat.toLegacyJobLogs(req.params.id, json));
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/jobs/:id/resume-check", async (req, res, next) => {
    try {
      const json = await forward(req, res, next, (id) => client.request("GET", hubPath(id, "/resume-check"), undefined, { requestId: requestIdOf(req) }));
      if (!json) return undefined;
      return res.json(compat.toLegacyResumeCheck(json));
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/jobs/:id", async (req, res, next) => {
    try {
      const requestId = requestIdOf(req);
      const json = await forward(req, res, next, (id) => client.request("GET", hubPath(id), undefined, { requestId }));
      if (!json) return undefined;
      const job = isPlainObject(json.job) ? json.job : {};
      let logs = [];
      let logCount = 0;
      try {
        const tail = await client.request("GET", hubPath(job.id, `/logs?tail=${compat.DETAIL_LOG_LINES}`), undefined, { requestId });
        if (tail.status === 200 && Array.isArray(tail.json?.lines)) {
          logs = tail.json.lines;
          logCount = Number.isInteger(tail.json.total) ? tail.json.total : logs.length;
        }
      } catch {
        // The job without its log tail is still the job.
      }
      return res.json(compat.toLegacyJob(job, { logs, logCount }));
    } catch (error) {
      return next(error);
    }
  });

  for (const action of JOB_ACTIONS) {
    app.post(`/api/jobs/:id/${action}`, async (req, res, next) => {
      try {
        const input = isPlainObject(req.body) ? req.body : {};
        const body = { origin: originOf(req) };
        if (action === "cancel") {
          if (typeof input.deletePartial === "boolean") body.deletePartial = input.deletePartial;
          if (nonEmpty(input.confirm)) body.confirm = input.confirm;
        }
        if (action === "resume") {
          if (typeof input.refreshTransferOptions === "boolean") body.refreshTransferOptions = input.refreshTransferOptions;
          if (nonEmpty(input.source)) body.source = input.source;
          // A token goes upstream only for a caller the manager itself
          // judged local (03 §12); the entry checks the signed origin again.
          if (body.origin.clientLocal && isPlainObject(input.credential) && nonEmpty(input.credential.hfToken)) {
            body.credential = { hfToken: input.credential.hfToken, remember: input.credential.remember === true };
          }
        }
        const json = await forward(req, res, next, (id) => client.request("POST", hubPath(id, `/${action}`), body, { requestId: requestIdOf(req) }));
        if (!json) return undefined;
        refreshJobs();
        return res.json(compat.toLegacyJobAction(json.job));
      } catch (error) {
        return next(error);
      }
    });
  }

  registerModelShims(app, { managerId, client, isLocalRequest, originOf, requestIdOf, refreshJobs, options });

  return { jobsSnapshot, refreshJobs, startRelay, close, isHubJobId, findEntryByPath };
}

module.exports = {
  HUB_JOB_ID_RE,
  RELAY_THROTTLE_MS,
  isHubJobId,
  localJobsToKeep,
  registerHubShimRoutes,
};
