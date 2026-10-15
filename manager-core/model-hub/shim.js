"use strict";

// The managers' legacy download routes as forwarding shims (03 §15). HUB-13a
// covers the job routes and the SSE `jobs` relay:
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

const compat = require("./compat");
const { HubClientError } = require("./client");
const { isPlainObject, nonEmpty } = require("./hub-util");

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

/**
 * registerHubShimRoutes(app, { managerId, client, isLocalRequest, ... }) →
 * { jobsSnapshot, refreshJobs, startRelay, close }.
 *
 * Manager hooks: listLocalJobs() (newest first), getLocalJob(id),
 * beforeReadJobs(), summarizeJob(job), onSnapshot() (re-broadcast the jobs
 * event), hasListeners() (skip relay re-reads while nobody listens).
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

  return { jobsSnapshot, refreshJobs, startRelay, close, isHubJobId };
}

module.exports = {
  HUB_JOB_ID_RE,
  RELAY_THROTTLE_MS,
  isHubJobId,
  localJobsToKeep,
  registerHubShimRoutes,
};
