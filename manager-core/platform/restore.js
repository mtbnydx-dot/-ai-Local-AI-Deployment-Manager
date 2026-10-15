"use strict";

// Working set and restore models (06 §5.12, 00 §9.3). Restore is an automatic
// action, so it only ever adds: every launch it posts carries
// instance.mode "add" and onConflict "skip", it never sends "replace", and it
// never calls the legacy /api/start. A conflict becomes a notification with a
// manual action, an admission block ends the manager's restore, and a manager
// without POST /api/launch (or a legacy entry) degrades to an offer.

const fs = require("node:fs");
const path = require("node:path");

const WORKING_SET_MS = 5 * 60 * 1000;
const JOB_POLL_MS = 2000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;
const LAUNCH_TIMEOUT_MS = 120 * 1000;
const CONFLICT_CODES = new Set(["instance_conflict", "wake_would_replace_running"]);
const OFFER_ACTION = Object.freeze({
  label: { zh: "启动上次的模型", en: "Start last used model" },
  apiCall: { method: "POST", path: "/api/platform/restore-models", body: {} },
});

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return fallback; }
}

function listOf(body, key) {
  return Array.isArray(body) ? body : Array.isArray(body?.[key]) ? body[key] : [];
}

function instanceId(instance) {
  return String(instance?.id || instance?.instanceId || instance?.containerName || instance?.name || "");
}
function instanceName(instance) {
  return String(instance?.name || instance?.containerName || instance?.servedName || "");
}
function instanceLaunchId(instance) {
  return instance?.launchId || instance?.labels?.["ai.manager.launch-id"] || instance?.lifecycle?.launchId || null;
}
function instanceModel(instance) {
  const model = instance?.model;
  return String(typeof model === "object" && model ? model.ref || model.path || model.servedName || "" : model || "");
}
function isReady(instance) {
  if (instance?.running === false) return false;
  const state = instance?.lifecycle?.state;
  return state ? state === "ready" : instance?.ready !== false && instance?.status !== "loading";
}

/** The recent-launches entry that best matches a container that carries no launchId. */
function matchRecent(recent, instance) {
  const model = instanceModel(instance);
  const name = instanceName(instance);
  const hit = (item) => {
    const itemModel = String(item?.model ?? item?.config?.model ?? item?.spec?.model?.ref ?? "");
    const itemName = String(item?.name ?? item?.config?.name ?? item?.config?.servedModelName ?? item?.spec?.model?.servedName ?? "");
    return itemModel === model && (!name || !itemName || itemName === name);
  };
  const matches = recent.filter(hit);
  matches.sort((left, right) => String(right?.at || right?.createdAt || right?.updatedAt || "").localeCompare(String(left?.at || left?.createdAt || left?.updatedAt || "")));
  return matches[0] || null;
}

/** Strip anything that could make a restore replace a running container. */
function restoreBody(spec) {
  const copy = JSON.parse(JSON.stringify(spec || {}));
  const { mode: _mode, ...instance } = copy.instance && typeof copy.instance === "object" ? copy.instance : {};
  return { ...copy, instance: { ...instance, mode: "add" }, onConflict: "skip", source: "restore" };
}

/**
 * createRestorer({ workingSetFile, managers(), fetch, now, sleep, notify,
 * log, jobPollMs, jobTimeoutMs })
 * managers() -> [{ managerId: "vllm"|"llama", componentId, origin, live }].
 * notify(kind, severity, key, params, extra) raises a supervisor notification.
 */
function createRestorer(options = {}) {
  const fetchImpl = options.fetch;
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = typeof options.log === "function" ? options.log : () => {};
  const file = options.workingSetFile;
  const jobPollMs = options.jobPollMs ?? JOB_POLL_MS;
  const jobTimeoutMs = options.jobTimeoutMs ?? JOB_TIMEOUT_MS;

  async function call(origin, method, route, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    const response = await fetchImpl(`${origin}${route}`, {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, json };
  }

  async function instancesOf(origin) {
    const result = await call(origin, "GET", "/api/instances");
    if (result.status !== 200) throw new Error(`instances_${result.status}`);
    return listOf(result.json, "instances");
  }

  function readWorkingSet() {
    const set = readJson(file, null);
    return set && typeof set === "object" && set.managers && typeof set.managers === "object" ? set : null;
  }

  /**
   * Writes working-set.json from the ready instances of every live manager. A
   * manager with nothing ready (or an unreachable one) keeps its previous
   * entries, and nothing is written when no manager has anything ready.
   */
  async function writeWorkingSet() {
    const previous = readWorkingSet();
    const next = { at: new Date(now()).toISOString(), managers: { vllm: [...(previous?.managers?.vllm || [])], llama: [...(previous?.managers?.llama || [])] } };
    let any = false;
    for (const manager of options.managers().filter((item) => item.live)) {
      let instances;
      try { instances = (await instancesOf(manager.origin)).filter(isReady); } catch { continue; }
      if (!instances.length) continue;
      let recent = null;
      const entries = [];
      for (const instance of instances) {
        let launchId = instanceLaunchId(instance);
        let legacy = false;
        if (!launchId) {
          legacy = true;
          if (recent === null) {
            try { recent = listOf((await call(manager.origin, "GET", "/api/recent-launches")).json, "launches"); } catch { recent = []; }
          }
          launchId = matchRecent(recent, instance)?.launchId || null;
        }
        entries.push({ launchId, instanceId: instanceId(instance), model: instanceModel(instance), name: instanceName(instance), ...(legacy ? { legacy: true } : {}) });
      }
      next.managers[manager.managerId] = entries;
      any = true;
    }
    if (!any) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(temporary, file);
    return next;
  }

  /** [{managerId, launchId, model, name, action: "launch" | "skip-running" | "offer-only"}] with no side effects. */
  async function plan({ only } = {}) {
    const set = readWorkingSet();
    const out = [];
    if (!set) return out;
    for (const manager of options.managers().filter((item) => !only || item.managerId === only)) {
      const entries = Array.isArray(set.managers[manager.managerId]) ? set.managers[manager.managerId] : [];
      if (!entries.length) continue;
      let running = [];
      if (manager.live) { try { running = await instancesOf(manager.origin); } catch { running = []; } }
      for (const entry of entries) {
        const isRunning = running.some((instance) => (entry.launchId && instanceLaunchId(instance) === entry.launchId)
          || (instanceId(instance) === entry.instanceId && entry.instanceId)
          || (instanceModel(instance) === entry.model && instanceName(instance) === entry.name));
        const action = isRunning ? "skip-running" : entry.legacy || !entry.launchId ? "offer-only" : "launch";
        out.push({ managerId: manager.managerId, componentId: manager.componentId, launchId: entry.launchId || null, model: entry.model || "", name: entry.name || "", action });
      }
    }
    return out;
  }

  function offer(count) {
    options.notify("restore.offer", "info", "restore.offer", { count }, { action: OFFER_ACTION, dedupeKey: "restore.offer" });
  }

  async function waitForJob(origin, jobId) {
    const deadline = now() + jobTimeoutMs;
    for (;;) {
      let job = null;
      try { job = (await call(origin, "GET", `/api/jobs/${encodeURIComponent(jobId)}`)).json; } catch {}
      job = job?.job || job;
      if (job && !["running", "queued", "pending", "starting"].includes(String(job.status || job.state || ""))) return job;
      if (now() >= deadline) return null;
      await sleep(jobPollMs);
    }
  }

  function conflict(manager, item) {
    options.notify("restore.conflict", "warn", "restore.conflict", { model: item.name || item.model || item.launchId }, {
      action: { label: { zh: "去部署页手动替换", en: "Replace manually" }, href: `/deployments?manager=${manager.managerId}` },
      dedupeKey: `restore.conflict:${manager.managerId}:${item.launchId}`,
    });
  }

  /**
   * Restores what the plan says "launch", one entry at a time, add-only.
   * Anything the plan says "offer-only" (legacy entries, a manager without
   * POST /api/launch) is offered once at the end. Returns a summary.
   */
  async function run({ line = () => {}, only } = {}) {
    const entries = await plan({ only });
    const result = { launched: 0, skipped: 0, conflicts: 0, blocked: 0, offered: 0 };
    let offerCount = entries.filter((item) => item.action === "offer-only").length;
    for (const manager of options.managers().filter((item) => !only || item.managerId === only)) {
      if (!manager.live) continue;
      const mine = entries.filter((item) => item.managerId === manager.managerId && item.action === "launch");
      for (let index = 0; index < mine.length; index += 1) {
        const item = mine[index];
        line(`${manager.managerId}: restoring ${item.name || item.model}`);
        let record;
        try { record = await call(manager.origin, "GET", `/api/launches/${encodeURIComponent(item.launchId)}`); } catch { record = { status: 0 }; }
        const spec = record.json?.spec || record.json?.launch?.spec;
        if (record.status !== 200 || !spec) { offerCount += 1; continue; }
        let answer;
        try { answer = await call(manager.origin, "POST", "/api/launch", restoreBody(spec), LAUNCH_TIMEOUT_MS); } catch (error) {
          log({ code: "restore_launch_failed", managerId: manager.managerId, message: String(error?.message || error) });
          continue;
        }
        const code = answer.json?.code || answer.json?.error?.code || answer.json?.error;
        if (answer.status === 404) {
          // A pre-ENG-26 manager has no POST /api/launch: the rest of its entries become an offer.
          offerCount += mine.length - index;
          break;
        }
        if ((answer.json?.skipped === true && answer.json?.conflict) || (answer.status === 409 && CONFLICT_CODES.has(code))) {
          conflict(manager, item);
          result.conflicts += 1;
          continue;
        }
        if (answer.json?.verdict === "block" || (answer.status === 409 && code === "admission_blocked")) {
          options.notify("restore.blocked", "warn", "restore.blocked", {}, { dedupeKey: `restore.blocked:${manager.managerId}` });
          result.blocked += 1;
          break;
        }
        if (answer.status < 200 || answer.status >= 300) {
          log({ code: "restore_launch_refused", managerId: manager.managerId, status: answer.status });
          continue;
        }
        const jobId = answer.json?.jobId || answer.json?.job?.id || answer.json?.job?.jobId;
        if (jobId) await waitForJob(manager.origin, jobId);
        result.launched += 1;
      }
    }
    result.skipped = entries.filter((item) => item.action === "skip-running").length;
    if (offerCount > 0) { offer(offerCount); result.offered = offerCount; }
    return result;
  }

  return { WORKING_SET_MS, readWorkingSet, writeWorkingSet, plan, run, offer };
}

module.exports = { WORKING_SET_MS, OFFER_ACTION, createRestorer, restoreBody };
