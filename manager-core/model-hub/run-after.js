"use strict";

// Download & Run (03 §11, HUB-14). The hub plans a launch before the download
// (advisory, from the remote ModelCard) and, once the files are verified,
// plans it again from the folder on disk and starts it through the hosting
// manager. Both plans and the start are loopback calls to the manager
// (POST /api/launch/plan, POST /api/start) carrying an x-request-id.
//
// Hard rules: this module never calls a stop endpoint and never removes a
// container. A launch that would replace a running instance waits for an
// explicit confirmation (POST /api/hub/downloads/:id/run). Every failure
// stays in job.runAfter and leaves the download in `ready`.

const crypto = require("node:crypto");
const { HubError } = require("./errors");
const { isPlainObject, nonEmpty } = require("./hub-util");

const REQUEST_TIMEOUT_MS = 15_000;
const ENGINES_TIMEOUT_MS = 2_500;
// "No prospective support" is remembered per manager for this long, so a
// manager that was upgraded in the meantime is asked again.
const UNAVAILABLE_TTL_MS = 5 * 60 * 1000;
const RUN_AFTER_STATES = Object.freeze(["planning", "needs-confirmation", "started", "failed"]);
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;

function bilingual(zh, en) {
  return { zh, en };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function newRequestId() {
  return `hub-run-${crypto.randomBytes(6).toString("hex")}`;
}

function invalidField(field, message) {
  return new HubError("invalid_request", message, { status: 400, details: { field } });
}

/**
 * The runAfter request of a plan or a download (03 §11), checked and reduced
 * to its documented fields. null stays null.
 */
function normalizeRunAfterRequest(input) {
  if (input === undefined || input === null) return null;
  if (!isPlainObject(input)) throw invalidField("runAfter", "runAfter must be an object.");
  const out = {};
  if (!nonEmpty(input.engineId) || String(input.engineId).length > 80) throw invalidField("runAfter.engineId", "runAfter.engineId is required.");
  out.engineId = String(input.engineId).trim();
  for (const field of ["managerId", "recipeId"]) {
    const value = input[field];
    if (value === undefined || value === null) {
      out[field] = null;
    } else if (typeof value !== "string" || value.length > 120) {
      throw invalidField(`runAfter.${field}`, `runAfter.${field} must be a string or null.`);
    } else {
      out[field] = value;
    }
  }
  if (input.values !== undefined && input.values !== null && !isPlainObject(input.values)) throw invalidField("runAfter.values", "runAfter.values must be an object.");
  out.values = isPlainObject(input.values) ? clone(input.values) : {};
  for (const field of ["acceptWarnings", "allowReplace"]) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") throw invalidField(`runAfter.${field}`, `runAfter.${field} must be true or false.`);
    out[field] = input[field] === true;
  }
  return out;
}

/**
 * createRunAfter({ managers, fetchImpl, getEngines, clock, logger,
 *   timeoutMs }) → { normalize, resolveManager, advise, start, confirm, isUnavailable }
 *
 * managers: [{ id, port }] (the entry's managers, loopback). getEngines() may
 * return the aggregated engine list (01 ENG-19) as an array or { engines };
 * without it each manager's own /api/engines is read.
 */
function createRunAfter(options = {}) {
  const managers = (Array.isArray(options.managers) ? options.managers : [])
    .map((item) => ({ id: String(item?.id || ""), port: Number(item?.port) }))
    .filter((item) => item.id && Number.isInteger(item.port) && item.port > 0);
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : (typeof fetch === "function" ? fetch : null);
  const getEngines = typeof options.getEngines === "function" ? options.getEngines : null;
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const logger = options.logger || console;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : REQUEST_TIMEOUT_MS;
  const unavailableUntil = new Map();

  function nowIso() {
    return new Date(clock.now()).toISOString();
  }

  function managerById(id) {
    return managers.find((item) => item.id === id) || null;
  }

  function isUnavailable(managerId) {
    const until = unavailableUntil.get(managerId);
    if (until === undefined) return false;
    if (until > clock.now()) return true;
    unavailableUntil.delete(managerId);
    return false;
  }

  function markUnavailable(managerId) {
    unavailableUntil.set(managerId, clock.now() + UNAVAILABLE_TTL_MS);
  }

  // --- loopback calls ---------------------------------------------------------

  async function call(manager, method, route, body, requestId, ms = timeoutMs) {
    if (!fetchImpl) throw Object.assign(new Error("fetch is not available"), { code: "manager_unreachable" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    timer.unref?.();
    try {
      const response = await fetchImpl(`http://127.0.0.1:${manager.port}${route}`, {
        method,
        headers: { "content-type": "application/json", "x-request-id": requestId },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      let text = "";
      try {
        text = await response.text();
      } catch {
        text = "";
      }
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: Number(response.status) || 0, json, text };
    } catch (error) {
      throw Object.assign(new Error(String(error?.name === "AbortError" ? "The manager did not answer in time." : error?.message || error)), { code: "manager_unreachable" });
    } finally {
      clearTimeout(timer);
    }
  }

  function envelopeMessage(result) {
    const json = result.json;
    const raw = json?.error?.message ?? json?.message ?? (typeof json?.error === "string" ? json.error : "") ?? "";
    return String(raw || result.text || "").slice(0, 300);
  }

  // The manager cannot plan a model that is not on disk yet (01 §11): a 404
  // on the route, a 400 naming `prospective`, or ENG-7's plan error.
  function lacksProspective(result) {
    if (result.status === 404) return true;
    if (result.status === 400 && /prospective/i.test(`${result.text}`)) return true;
    const errors = Array.isArray(result.json?.errors) ? result.json.errors : [];
    return errors.some((item) => /^prospective_unsupported$/i.test(String(item?.code || "")));
  }

  // --- manager resolution -----------------------------------------------------

  async function readEngines() {
    if (getEngines) {
      try {
        const data = await getEngines();
        const list = Array.isArray(data) ? data : data?.engines;
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    }
    const list = [];
    await Promise.all(managers.map(async (manager) => {
      try {
        const result = await call(manager, "GET", "/api/engines", undefined, newRequestId(), ENGINES_TIMEOUT_MS);
        const engines = Array.isArray(result.json) ? result.json : result.json?.engines;
        if (result.status === 200 && Array.isArray(engines)) for (const engine of engines) list.push({ ...engine, managerId: manager.id });
      } catch {
        // An offline manager contributes nothing.
      }
    }));
    return list;
  }

  /** The manager that hosts the engine: the request's managerId, the engine list (ENG-19), then gguf → llama, else vllm. */
  async function resolveManager(request) {
    if (nonEmpty(request.managerId)) {
      const manager = managerById(request.managerId);
      if (!manager) throw new HubError("run_after_unavailable", `Manager "${request.managerId}" is not known to the hub.`, { status: 422, details: { reason: "unknown_manager", managerId: request.managerId } });
      return manager;
    }
    const engines = await readEngines();
    const hosted = engines.find((engine) => engine?.id === request.engineId && nonEmpty(engine.managerId) && managerById(engine.managerId));
    if (hosted) return managerById(hosted.managerId);
    const fallback = /llama|gguf/i.test(request.engineId) ? "llama" : "vllm";
    const manager = managerById(fallback);
    if (!manager) throw new HubError("run_after_unavailable", `No manager hosts engine "${request.engineId}".`, { status: 422, details: { reason: "unknown_manager" } });
    return manager;
  }

  function launchBody(request, model, { prospective = false } = {}) {
    return {
      engineId: request.engineId,
      recipeId: request.recipeId || null,
      ...(prospective ? { prospective: true } : {}),
      model,
      instance: { mode: "replace" },
      values: clone(request.values || {}),
    };
  }

  function planSummary(plan) {
    const errors = (Array.isArray(plan?.errors) ? plan.errors : []).concat(Array.isArray(plan?.blockers) ? plan.blockers : []);
    return {
      ok: plan?.ok !== false && errors.length === 0,
      verdict: plan?.admission?.verdict || null,
      message: plan?.admission?.message || null,
      errors: errors.slice(0, 20).map((item) => clone(item)),
      warnings: (Array.isArray(plan?.warnings) ? plan.warnings : []).slice(0, 20).map((item) => clone(item)),
      planHash: nonEmpty(plan?.planHash) ? plan.planHash : null,
      steps: (Array.isArray(plan?.steps) ? plan.steps : []).map((step) => ({ kind: step?.kind, ...(step?.containerName ? { containerName: step.containerName } : {}), ...(step?.model ? { model: step.model } : {}) })),
    };
  }

  // --- plan time (advisory) ---------------------------------------------------

  /**
   * advise({ request, card, requestId }) → { ...request, managerId, advice }.
   * Sends the prospective plan (model.card, no model.ref). Throws 422
   * run_after_unavailable when the manager cannot plan a prospective model;
   * a manager that is down or a plan that blocks is reported in `advice`
   * (Download alone stays available).
   */
  async function advise({ request: rawRequest, card, requestId } = {}) {
    const request = normalizeRunAfterRequest(rawRequest);
    if (!request) return null;
    const manager = await resolveManager(request);
    const unavailable = (reason) => new HubError("run_after_unavailable", "Download & Run needs a manager that can plan a model before it is downloaded.", { status: 422, details: { reason, managerId: manager.id } });
    if (!isPlainObject(card)) throw unavailable("model_card_unavailable");
    if (isUnavailable(manager.id)) throw unavailable("prospective_unsupported");
    const id = REQUEST_ID_RE.test(String(requestId || "")) ? String(requestId) : newRequestId();
    let result;
    try {
      result = await call(manager, "POST", "/api/launch/plan", launchBody(request, { card }, { prospective: true }), id);
    } catch (error) {
      return { ...request, managerId: manager.id, advice: { available: false, ok: false, verdict: null, errors: [{ code: "manager_unreachable", message: error.message }], planHash: null, requestId: id } };
    }
    if (lacksProspective(result)) {
      markUnavailable(manager.id);
      throw unavailable("prospective_unsupported");
    }
    if (!isPlainObject(result.json) || result.status >= 500 || (result.status >= 400 && result.status !== 422)) {
      return {
        ...request,
        managerId: manager.id,
        advice: { available: false, ok: false, verdict: null, errors: [{ code: "plan_failed", status: result.status, message: envelopeMessage(result) }], planHash: null, requestId: id },
      };
    }
    const summary = planSummary(result.json);
    return { ...request, managerId: manager.id, advice: { available: summary.ok && summary.verdict !== "block", ...summary, requestId: id } };
  }

  // --- completion (authoritative) -------------------------------------------

  function failure(code, message, extra = {}) {
    return { code, message: String(message || code).slice(0, 400), at: nowIso(), ...extra };
  }

  /**
   * run(job, hooks, { confirmedInstance }) plans from the folder on disk and
   * starts the launch. hooks.update(patch) merges into job.runAfter (and
   * persists); hooks.notify(kind, severity, title, body, action) raises a
   * notification.
   */
  async function run(job, hooks, { confirmedInstance = null } = {}) {
    const base = normalizeRunAfterRequest(job.runAfter);
    if (!base) return null;
    const requestId = newRequestId();
    const localDir = job.target?.localDir;
    const label = String(job.artifact?.repo || job.id);
    const fail = async (error) => {
      await hooks.update({ state: "failed", error, pending: null, updatedAt: nowIso() });
      hooks.notify("hub.runAfter.failed", "warning",
        bilingual(`无法自动启动：${label}`, `Could not start automatically: ${label}`),
        bilingual("下载已完成并可用；启动没有执行。", "The download is ready; the launch was not started."), undefined);
      return null;
    };
    if (!nonEmpty(localDir)) return fail(failure("run_after_failed", "The download has no local folder."));
    await hooks.update({ state: "planning", managerId: base.managerId, error: null, pending: null, updatedAt: nowIso() });

    let manager;
    try {
      manager = await resolveManager(base);
    } catch (error) {
      return fail(failure(error.code || "run_after_unavailable", error.message));
    }
    await hooks.update({ managerId: manager.id });
    const body = launchBody(base, { ref: localDir });

    let planned;
    try {
      planned = await call(manager, "POST", "/api/launch/plan", body, requestId);
    } catch (error) {
      return fail(failure("manager_unreachable", error.message, { managerId: manager.id }));
    }
    if (!isPlainObject(planned.json) || planned.status >= 400) {
      return fail(failure("plan_failed", envelopeMessage(planned) || `The manager answered ${planned.status}.`, { status: planned.status }));
    }
    const summary = planSummary(planned.json);
    const planInfo = { verdict: summary.verdict, planHash: summary.planHash, errors: summary.errors, warnings: summary.warnings };
    if (!summary.ok || summary.verdict === "block") {
      return fail(failure("plan_blocked", summary.message || summary.errors[0]?.message || "The launch plan is blocked.", { plan: planInfo }));
    }
    if (summary.verdict === "warn" && base.acceptWarnings !== true) {
      return fail(failure("plan_warning", summary.message || "The launch plan has warnings that were not accepted.", { plan: planInfo }));
    }

    const replaceStep = summary.steps.find((step) => step.kind === "replace");
    if (replaceStep) {
      const named = replaceStep.containerName || "";
      // Nothing confirmed yet: only allowReplace lets a replace through. After a
      // confirmation, only the instance the user was shown may be replaced.
      const proceed = confirmedInstance === null ? base.allowReplace === true : confirmedInstance === named;
      if (!proceed) {
        const changed = confirmedInstance !== null;
        await hooks.update({
          state: "needs-confirmation",
          error: null,
          plan: planInfo,
          pending: { reason: changed ? "instance_changed" : "replace", containerName: named, model: replaceStep.model || null },
          updatedAt: nowIso(),
        });
        hooks.notify("hub.runAfter.confirm", "warning",
          bilingual(`需要确认：${label}`, `Confirmation needed: ${label}`),
          bilingual(
            changed ? "要替换的实例已变化，请重新确认后再启动。" : "启动会替换正在运行的实例，请确认。",
            changed ? "The instance to replace has changed; confirm again to start." : "Starting would replace a running instance; confirm to continue."),
          { label: bilingual("确认并运行", "Confirm and run"), href: `/models/downloads?job=${encodeURIComponent(job.id)}`, apiCall: { method: "POST", path: `/api/hub/downloads/${encodeURIComponent(job.id)}/run`, body: { confirmReplace: true } } });
        return null;
      }
    }

    let started;
    try {
      started = await call(manager, "POST", "/api/start", body, requestId);
    } catch (error) {
      return fail(failure("manager_unreachable", error.message, { managerId: manager.id, plan: planInfo }));
    }
    if (started.status >= 400 || !isPlainObject(started.json)) {
      return fail(failure("start_failed", envelopeMessage(started) || `The manager answered ${started.status}.`, { status: started.status, plan: planInfo }));
    }
    const launchJobId = started.json.job?.id ?? started.json.jobId ?? null;
    const launchId = started.json.launchId ?? started.json.job?.meta?.launchId ?? null;
    const planHash = started.json.plan?.planHash ?? summary.planHash;
    await hooks.update({
      state: "started",
      error: null,
      pending: null,
      plan: planInfo,
      managerId: manager.id,
      launchJobId: launchJobId === null ? null : String(launchJobId),
      launchId: launchId === null ? null : String(launchId),
      planHash: planHash || null,
      startedAt: nowIso(),
      updatedAt: nowIso(),
    });
    hooks.notify("hub.runAfter.started", "success",
      bilingual(`已开始启动：${label}`, `Launch started: ${label}`),
      bilingual("模型正在加载，可在引擎页查看进度。", "The model is loading; follow it on the engine page."), undefined);
    return null;
  }

  /** Called by the queue when a download with runAfter is ready. Never throws. */
  async function start(job, hooks) {
    try {
      await run(job, hooks);
    } catch (error) {
      logger.warn?.(`model hub: run-after failed for ${job.id}: ${error?.message || error}`);
      try {
        await hooks.update({ state: "failed", error: failure("run_after_failed", error?.message || error), pending: null, updatedAt: nowIso() });
      } catch {
        // The job record is best effort here.
      }
    }
  }

  /** POST /downloads/:id/run { confirmReplace: true }: re-plans and starts. */
  async function confirm(job, hooks) {
    const current = job.runAfter;
    if (!isPlainObject(current) || current.state !== "needs-confirmation") {
      throw new HubError("invalid_state", "This download has no launch waiting for confirmation.", { status: 409, details: { id: job.id, state: current?.state ?? null } });
    }
    await run(job, hooks, { confirmedInstance: String(current.pending?.containerName || "") });
  }

  return { normalize: normalizeRunAfterRequest, resolveManager, advise, start, confirm, isUnavailable };
}

module.exports = { RUN_AFTER_STATES, UNAVAILABLE_TTL_MS, createRunAfter, normalizeRunAfterRequest };
