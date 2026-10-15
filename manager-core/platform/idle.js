"use strict";

// Busy blockers for the idle gate (06 §5.11). Each running component with a
// `busy` probe is asked what it is doing:
//   - managers (parser "manager-jobs"): GET /api/jobs?fields=summary, jobs
//     with status running|queued by type, plus GET /api/instances for
//     instances whose lifecycle.state is "loading"; both plain loopback;
//   - the entry (parser "entry-busy", auth "system"): GET /api/platform/busy
//     signed as system:supervisor through the entry client.
// The gate fails closed: an unreachable busy probe, or a 401/403 answer,
// becomes a blocker of kind "unknown".

const DEFAULT_TIMEOUT_MS = 3000;
const BUSY_JOB_STATES = new Set(["running", "queued"]);
const JOB_KINDS = Object.freeze({
  serve: "launch",
  launch: "launch",
  pull: "launch",
  download: "download",
  migration: "migration",
  migrate: "migration",
  benchmark: "benchmark",
});
const ENTRY_KINDS = new Set(["download", "requests", "launch", "loading", "migration", "benchmark"]);

function isoOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const time = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function unknownBlocker(source, reason, now) {
  return { kind: "unknown", source, id: `${source}:busy-probe`, title: `Busy probe ${reason}`, since: new Date(now()).toISOString(), reason };
}

async function getJson(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, json };
}

function jobBlockers(source, body) {
  const jobs = Array.isArray(body) ? body : Array.isArray(body?.jobs) ? body.jobs : [];
  const blockers = [];
  for (const job of jobs) {
    if (!job || !BUSY_JOB_STATES.has(String(job.status || ""))) continue;
    const kind = JOB_KINDS[String(job.type || "").toLowerCase()];
    if (!kind) continue;
    blockers.push({
      kind, source, id: String(job.id || ""), title: String(job.title || job.name || job.type),
      since: isoOrNull(job.startedAt || job.createdAt),
    });
  }
  return blockers;
}

function loadingBlockers(source, body) {
  const instances = Array.isArray(body) ? body : Array.isArray(body?.instances) ? body.instances : [];
  return instances
    .filter((instance) => instance?.lifecycle?.state === "loading")
    .map((instance) => ({
      kind: "loading", source, id: String(instance.id || instance.instanceId || ""),
      title: String(instance.name || instance.model || instance.id || "instance"),
      since: isoOrNull(instance.lifecycle?.since),
    }));
}

async function managerBlockers(component, { fetchImpl, timeoutMs, now }) {
  const source = component.id;
  let jobsUrl;
  try { jobsUrl = new URL(component.busy.http); } catch { return [unknownBlocker(source, "invalid", now)]; }
  try {
    const jobs = await getJson(fetchImpl, jobsUrl.href, timeoutMs);
    if (jobs.status === 401 || jobs.status === 403) return [unknownBlocker(source, `refused-${jobs.status}`, now)];
    if (jobs.status < 200 || jobs.status >= 300) return [unknownBlocker(source, `http-${jobs.status}`, now)];
    const blockers = jobBlockers(source, jobs.json);
    // Loading instances are informative: a manager without the route answers
    // 404 and adds nothing, but a network failure still fails closed.
    const instances = await getJson(fetchImpl, `${jobsUrl.origin}/api/instances`, timeoutMs);
    if (instances.status >= 200 && instances.status < 300) blockers.push(...loadingBlockers(source, instances.json));
    return blockers;
  } catch {
    return [unknownBlocker(source, "unreachable", now)];
  }
}

async function entryBlockers(component, { entryClient, fetchImpl, timeoutMs, now }) {
  const source = component.id;
  let target;
  try { target = new URL(component.busy.http); } catch { return [unknownBlocker(source, "invalid", now)]; }
  try {
    const result = component.busy.auth === "system" && entryClient
      ? await entryClient.request("GET", `${target.pathname}${target.search}`, { timeoutMs })
      : await getJson(fetchImpl, target.href, timeoutMs);
    if (result.status === 401 || result.status === 403) return [unknownBlocker(source, `refused-${result.status}`, now)];
    if (result.status < 200 || result.status >= 300 || !Array.isArray(result.json?.blockers)) return [unknownBlocker(source, `http-${result.status}`, now)];
    return result.json.blockers.map((blocker) => ({
      kind: ENTRY_KINDS.has(blocker?.kind) ? blocker.kind : "unknown",
      source,
      id: String(blocker?.id || ""),
      title: String(blocker?.title || blocker?.kind || "busy"),
      since: isoOrNull(blocker?.since),
    }));
  } catch {
    return [unknownBlocker(source, "unreachable", now)];
  }
}

/**
 * collectBlockers({ components, entryClient, fetch, timeoutMs, now })
 * components: the resolved specs of the components that are running.
 * -> [{kind, source, id, title, since}]
 */
async function collectBlockers(options = {}) {
  const components = (Array.isArray(options.components) ? options.components : []).filter((component) => component?.busy?.http);
  const context = {
    entryClient: options.entryClient || null,
    fetchImpl: options.fetch || ((...args) => fetch(...args)),
    timeoutMs: Math.max(100, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS),
    now: options.now || Date.now,
  };
  const results = await Promise.all(components.map((component) => (component.busy.parser === "entry-busy"
    ? entryBlockers(component, context)
    : managerBlockers(component, context))));
  return results.flat();
}

module.exports = { JOB_KINDS, collectBlockers };
