"use strict";

// Manager event relay (07 §2.11, 00 §9.6).
//
// Each manager pushes `event: jobs` (its full summarised job list, throttled
// to 700 ms) on its own /api/events hub. The relay holds one GET to that hub
// per manager and republishes what changed on the entry bus:
//
//   jobs       { managerId, jobs: [changed JobSummary], removed: [jobId] }
//   instances  { managerId, changed: [instanceId], removed: [instanceId], native }
//   status     { reason: "manager_up" | "manager_down", managerId }
//
// The relay keeps the last summary per job id, so a snapshot that repeats
// what was already relayed publishes nothing. Every (re)connect reads
// /api/jobs?fields=summary once: the first read only seeds the map, a later
// one is diffed against it, so neither a fresh entry nor a reconnect floods
// the stream with the whole job history.
//
// Managers do not emit `instances` yet (01 ENG-10/ENG-13 add it). Until a
// manager does, the relay synthesises the event: while anyone subscribes to
// `instances` it reads /api/instances every 10 s, at once on poke() (the
// management proxy calls it after a successful write) and when a relayed job
// changes state, and publishes only when an instance fingerprint changed.
// Each (re)connect reads /api/instances once as the baseline, so the first
// poke after a subscriber appears already has something to compare with. The
// first native `instances` event switches synthesis off for that manager.
//
// The relay only ever issues GETs and never writes to a manager. A dropped
// stream reconnects with a 1 s → 30 s jittered backoff; only the up and down
// transitions are logged and published, never each retry.

const http = require("node:http");
const { redactSecrets, redactValue } = require("../../manager-core/secret-redactor");
const { newRequestId } = require("../../manager-core/telemetry/ids");
const { EVENT_SOURCES } = require("./events");

const UPSTREAM_HOST = "127.0.0.1";
const EVENTS_PATH = "/api/events";
const JOBS_TARGET = "jobs?fields=summary";
const INSTANCES_TARGET = "instances";
const DEFAULT_MIN_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30000;
const DEFAULT_INSTANCES_POLL_MS = 10000;
// A connection that stayed up this long starts the next backoff from the
// bottom again; a flapping manager keeps doubling.
const DEFAULT_RESET_AFTER_MS = 60000;
const DEFAULT_JITTER = 0.2;
// Managers send a heartbeat comment every 15 s, so a socket silent for three
// of them is half-open and is replaced.
const DEFAULT_IDLE_TIMEOUT_MS = 45000;
const DEFAULT_FETCH_TIMEOUT_MS = 15000;
// One frame carries the whole job list; anything above this is not a manager.
const DEFAULT_MAX_FRAME_CHARS = 16 << 20;
const FETCH_LIMIT_BYTES = 16 << 20;
const SOURCE_SET = new Set(EVENT_SOURCES);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
}

function managerList(managers) {
  const list = [];
  const seen = new Set();
  for (const item of Array.isArray(managers) ? managers : []) {
    const id = String(item?.id || "").trim();
    const port = Number(item?.port);
    if (!id || seen.has(id) || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    seen.add(id);
    list.push({ id, port });
  }
  return list;
}

// Key order never decides whether a job changed.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function jobId(job) {
  const id = job?.id;
  if (typeof id === "string" && id) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return "";
}

// Manager jobs carry `status` today; a later `state` wins when present.
function jobState(job) {
  if (typeof job?.state === "string") return job.state;
  return typeof job?.status === "string" ? job.status : "";
}

function instanceId(instance) {
  const id = instance?.id ?? instance?.instanceId ?? instance?.containerName;
  return id === undefined || id === null ? "" : String(id);
}

function instanceModel(instance) {
  if (typeof instance?.model === "string") return instance.model;
  if (typeof instance?.model?.id === "string") return instance.model.id;
  const models = Array.isArray(instance?.models) ? instance.models : Array.isArray(instance?.servedModels) ? instance.servedModels : [];
  return models.map((item) => (typeof item === "string" ? item : String(item?.id ?? ""))).join(",");
}

// 07 §2.11: id|lifecycle.state|lifecycle.phase|running|port|model. Request
// counters and the Docker "Up 5 minutes" status move on their own and are
// deliberately left out.
function instanceFingerprint(instance) {
  return [
    instanceId(instance),
    String(instance?.lifecycle?.state ?? ""),
    String(instance?.lifecycle?.phase ?? ""),
    instance?.running === undefined ? "" : String(Boolean(instance.running)),
    String(instance?.port ?? ""),
    instanceModel(instance),
  ].join("|");
}

// The instance list of a manager answer or event payload, or null when the
// value does not carry one.
function instanceList(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.instances) ? value.instances : null;
  return list ? list.filter(isPlainObject) : null;
}

// Incremental text/event-stream parser (WHATWG rules: LF, CR or CRLF line
// ends, `:` comments, multi-line data, `id`/`retry` ignored here). onEvent
// receives (eventName, dataText) for each frame that has data. push() returns
// false once a single frame grows past maxChars.
function createSseParser({ onEvent, maxChars = DEFAULT_MAX_FRAME_CHARS } = {}) {
  let buffer = "";
  let eventName = "";
  let dataLines = [];
  let dataChars = 0;
  let skipLeadingLf = false;

  function dispatch() {
    const name = eventName || "message";
    const data = dataLines.join("\n");
    const hasData = dataLines.length > 0;
    eventName = "";
    dataLines = [];
    dataChars = 0;
    if (hasData) onEvent(name, data);
  }

  function line(text) {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
      dataChars += value.length + 1;
    }
  }

  function push(chunk) {
    let text = String(chunk ?? "");
    if (skipLeadingLf) {
      skipLeadingLf = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }
    // Only the new text is scanned; the buffer never holds a line end.
    let index = buffer.length;
    buffer += text;
    let start = 0;
    for (; index < buffer.length; index += 1) {
      const code = buffer.charCodeAt(index);
      if (code !== 10 && code !== 13) continue;
      line(buffer.slice(start, index));
      if (code === 13) {
        if (index + 1 < buffer.length) {
          if (buffer.charCodeAt(index + 1) === 10) index += 1;
        } else {
          skipLeadingLf = true;
        }
      }
      start = index + 1;
    }
    buffer = buffer.slice(start);
    return buffer.length + dataChars <= maxChars;
  }

  return { push };
}

function loggerFor(logger) {
  const write = (method, line) => {
    try {
      const target = typeof logger?.[method] === "function" ? logger : console;
      target[method].call(target, redactSecrets(String(line)));
    } catch {
      // Logging must never break the relay.
    }
  };
  return { info: (line) => write("log", line), warn: (line) => write("warn", line) };
}

// GET http://127.0.0.1:<port>/api/<target> as buffered JSON, in the shape of
// the entry's manager client: { ok, status, data } and never a rejection.
function createDefaultFetchJson({ ports, httpGet, timeoutMs }) {
  return (managerId, target) => new Promise((resolve) => {
    const port = ports.get(managerId);
    if (!port) {
      resolve({ ok: false, status: 0, code: "unknown_manager", data: null });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let request;
    try {
      request = httpGet({
        host: UPSTREAM_HOST,
        port,
        method: "GET",
        path: `/api/${String(target).replace(/^\/+/, "")}`,
        headers: { accept: "application/json", "x-request-id": newRequestId() },
        agent: false,
      }, (response) => {
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > FETCH_LIMIT_BYTES) {
            request.destroy();
            finish({ ok: false, status: 0, code: "response_too_large", data: null });
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            data = null;
          }
          const status = response.statusCode || 0;
          finish({ ok: status >= 200 && status < 300, status, data });
        });
        response.on("error", () => finish({ ok: false, status: 0, code: "manager_unreachable", data: null }));
      });
    } catch {
      finish({ ok: false, status: 0, code: "manager_unreachable", data: null });
      return;
    }
    request.on("error", () => finish({ ok: false, status: 0, code: "manager_unreachable", data: null }));
    request.on("close", () => finish({ ok: false, status: 0, code: "manager_unreachable", data: null }));
    request.setTimeout?.(timeoutMs, () => {
      finish({ ok: false, status: 0, code: "manager_timeout", data: null });
      request.destroy();
    });
  });
}

function createManagerEventRelay(options = {}) {
  const bus = options.bus;
  if (!bus || typeof bus.publish !== "function") throw new TypeError("createManagerEventRelay needs the event bus");
  const now = typeof options.now === "function" ? options.now : Date.now;
  const httpGet = typeof options.httpGet === "function" ? options.httpGet : http.get;
  const minBackoffMs = positiveInt(options.minBackoffMs, DEFAULT_MIN_BACKOFF_MS);
  const maxBackoffMs = Math.max(minBackoffMs, positiveInt(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS));
  const instancesPollMs = positiveInt(options.instancesPollMs, DEFAULT_INSTANCES_POLL_MS);
  const resetAfterMs = positiveInt(options.resetAfterMs, DEFAULT_RESET_AFTER_MS);
  const idleTimeoutMs = positiveInt(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
  const fetchTimeoutMs = positiveInt(options.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
  const maxFrameChars = positiveInt(options.maxFrameChars, DEFAULT_MAX_FRAME_CHARS);
  const jitter = Number.isFinite(Number(options.jitter)) ? Math.min(1, Math.max(0, Number(options.jitter))) : DEFAULT_JITTER;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const timers = {
    setTimeout: typeof options.timers?.setTimeout === "function" ? options.timers.setTimeout : setTimeout,
    clearTimeout: typeof options.timers?.clearTimeout === "function" ? options.timers.clearTimeout : clearTimeout,
  };
  const log = loggerFor(options.logger || console);
  const managers = managerList(options.managers);
  const ports = new Map(managers.map(({ id, port }) => [id, port]));
  const fetchJson = typeof options.fetchJson === "function"
    ? options.fetchJson
    : createDefaultFetchJson({ ports, httpGet, timeoutMs: fetchTimeoutMs });
  const warnedOnce = new Set();
  const links = new Map();
  let running = false;

  for (const { id, port } of managers) {
    links.set(id, {
      id,
      port,
      source: SOURCE_SET.has(id) ? id : "entry",
      state: "connecting",
      sinceMs: clockMs(),
      lastEventAtMs: 0,
      reconnects: 0,
      nativeInstances: false,
      everConnected: false,
      failures: 0,
      connectedAtMs: 0,
      // Bumped on every attempt and on stop(); a callback from an older
      // connection sees a different number and does nothing.
      generation: 0,
      request: null,
      retryTimer: null,
      pollTimer: null,
      // null until the first read: there is nothing to diff against yet.
      jobs: null,
      instances: null,
      seeding: false,
      pendingJobs: null,
      snapshotSinceConnect: false,
      // { generation, again, promise } while an instances read runs.
      reading: null,
      readProblem: false,
    });
  }

  function clockMs() {
    try {
      const value = Number(now());
      if (Number.isFinite(value)) return value;
    } catch {
      // Fall through.
    }
    return Date.now();
  }

  function iso(ms) {
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  function warnOnce(key, line) {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    log.warn(line);
  }

  function schedule(fn, ms) {
    const handle = timers.setTimeout(fn, ms);
    handle?.unref?.();
    return handle;
  }

  function cancel(handle) {
    if (handle) timers.clearTimeout(handle);
  }

  function publish(type, data, source) {
    try {
      return bus.publish(type, data, { source });
    } catch {
      // The bus never throws; this only guards a stand-in.
      return null;
    }
  }

  function hasInstanceSubscribers() {
    try {
      return Number(bus.subscriberCount?.({ types: ["instances"] }) || 0) > 0;
    } catch {
      return false;
    }
  }

  // 1 s doubling to the cap, ±jitter, never above maxBackoffMs.
  function backoffDelay(failures) {
    const exponent = Math.min(Math.max(0, failures), 30);
    const base = Math.min(maxBackoffMs, minBackoffMs * 2 ** exponent);
    let draw = 0.5;
    try {
      draw = Math.min(1, Math.max(0, Number(random()) || 0));
    } catch {
      draw = 0.5;
    }
    const factor = 1 + (draw * 2 - 1) * jitter;
    return Math.max(1, Math.min(maxBackoffMs, Math.round(base * factor)));
  }

  // --- connection --------------------------------------------------------

  function connect(link) {
    if (!running) return;
    link.generation += 1;
    const generation = link.generation;
    let ended = false;
    const lose = (reason) => {
      if (ended || generation !== link.generation) return;
      ended = true;
      disconnected(link, reason);
    };
    let request;
    try {
      request = httpGet({
        host: UPSTREAM_HOST,
        port: link.port,
        method: "GET",
        path: EVENTS_PATH,
        headers: { accept: "text/event-stream", "x-request-id": newRequestId() },
        agent: false,
      }, (response) => {
        if (generation !== link.generation) {
          response.destroy?.();
          return;
        }
        const type = String(response.headers?.["content-type"] || "").toLowerCase();
        if (response.statusCode !== 200 || !type.startsWith("text/event-stream")) {
          lose(response.statusCode !== 200 ? `http_${response.statusCode}` : "not_event_stream");
          response.resume?.();
          request.destroy?.();
          return;
        }
        const parser = createSseParser({
          maxChars: maxFrameChars,
          onEvent: (event, data) => {
            if (!ended && generation === link.generation) managerEvent(link, event, data);
          },
        });
        response.setEncoding?.("utf8");
        response.on("data", (chunk) => {
          if (ended || generation !== link.generation) return;
          if (!parser.push(chunk)) {
            lose("frame_too_large");
            request.destroy?.();
          }
        });
        response.on("end", () => lose("ended"));
        response.on("close", () => lose("closed"));
        response.on("error", (error) => lose(error?.code || "stream_error"));
        connected(link, generation);
      });
    } catch (error) {
      lose(error?.code || "request_failed");
      return;
    }
    link.request = request;
    request.on("error", (error) => lose(error?.code || error?.message || "error"));
    request.on("close", () => lose("closed"));
    request.setTimeout?.(idleTimeoutMs, () => {
      lose("idle_timeout");
      request.destroy?.();
    });
  }

  function connected(link, generation) {
    const at = clockMs();
    const wasDown = link.state === "down";
    const downForMs = wasDown ? at - link.sinceMs : 0;
    if (link.everConnected) link.reconnects += 1;
    link.everConnected = true;
    link.connectedAtMs = at;
    link.state = "connected";
    link.sinceMs = at;
    // A manager that came back may run an older build without native
    // `instances`; synthesis resumes until it proves otherwise.
    link.nativeInstances = false;
    link.snapshotSinceConnect = false;
    link.pendingJobs = null;
    if (wasDown) {
      log.info(`manager-event-relay: the ${link.id} manager event stream is back after ${Math.max(0, Math.round(downForMs / 1000))} s`);
    } else {
      log.info(`manager-event-relay: relaying jobs and instances from the ${link.id} manager`);
    }
    publish("status", { reason: "manager_up", managerId: link.id }, "entry");
    seedJobs(link, generation);
    readInstances(link, { native: false });
    schedulePoll(link);
  }

  function disconnected(link, reason) {
    const at = clockMs();
    link.request = null;
    cancel(link.pollTimer);
    link.pollTimer = null;
    link.seeding = false;
    link.pendingJobs = null;
    if (link.state === "connected" && at - link.connectedAtMs >= resetAfterMs) link.failures = 0;
    const delay = backoffDelay(link.failures);
    link.failures += 1;
    if (link.state !== "down") {
      const seen = link.state === "connected";
      link.state = "down";
      link.sinceMs = at;
      log.warn(seen
        ? `manager-event-relay: lost the ${link.id} manager event stream (${reason}); reconnecting with backoff up to ${Math.round(maxBackoffMs / 1000)} s, and later attempts are not logged until it is back`
        : `manager-event-relay: cannot reach the ${link.id} manager event stream (${reason}); retrying with backoff up to ${Math.round(maxBackoffMs / 1000)} s, and later attempts are not logged until it answers`);
      publish("status", { reason: "manager_down", managerId: link.id }, "entry");
    }
    if (!running) return;
    cancel(link.retryTimer);
    link.retryTimer = schedule(() => {
      link.retryTimer = null;
      connect(link);
    }, delay);
  }

  // --- manager events ----------------------------------------------------

  function malformed(link, event) {
    warnOnce(`malformed:${link.id}:${event}`, `manager-event-relay: skipped a malformed ${event} frame from the ${link.id} manager; later ones are skipped without a log line`);
  }

  function managerEvent(link, event, dataText) {
    if (event !== "jobs" && event !== "instances") return;
    link.lastEventAtMs = clockMs();
    let data = null;
    if (dataText.trim()) {
      try {
        data = JSON.parse(dataText);
      } catch {
        malformed(link, event);
        return;
      }
    }
    if (event === "jobs") jobsEvent(link, data);
    else nativeInstancesEvent(link, data);
  }

  // A bare array is today's full snapshot. An object with `jobs` is a delta
  // (01's supervisor may send one job at a time) unless it says `full: true`;
  // a delta removes only the ids it lists in `removed`.
  function jobsSnapshot(data) {
    if (Array.isArray(data)) return { jobs: data.filter(isPlainObject), full: true, removed: [] };
    if (isPlainObject(data) && Array.isArray(data.jobs)) {
      return { jobs: data.jobs.filter(isPlainObject), full: data.full === true, removed: stringList(data.removed) };
    }
    return null;
  }

  function jobsEvent(link, data) {
    const snapshot = jobsSnapshot(data);
    if (!snapshot) {
      malformed(link, "jobs");
      return;
    }
    // Without a map yet, the seed read decides what is new; until it answers
    // only the latest snapshot is kept.
    if (link.seeding && link.jobs === null) {
      link.pendingJobs = snapshot.full || !link.pendingJobs ? snapshot : mergeDelta(link.pendingJobs, snapshot);
      return;
    }
    link.snapshotSinceConnect = true;
    applyJobs(link, snapshot, { publish: true });
  }

  function mergeDelta(base, delta) {
    const byId = new Map(base.jobs.map((job) => [jobId(job), job]));
    for (const job of delta.jobs) byId.set(jobId(job), job);
    for (const id of delta.removed) byId.delete(id);
    return { jobs: [...byId.values()], full: base.full, removed: [...new Set([...base.removed, ...delta.removed])] };
  }

  function applyJobs(link, snapshot, { publish: shouldPublish }) {
    const previous = link.jobs || new Map();
    const next = snapshot.full ? new Map() : new Map(previous);
    const changed = [];
    let stateChanged = false;
    for (const job of snapshot.jobs) {
      const id = jobId(job);
      if (!id) continue;
      const fingerprint = stableStringify(job);
      const state = jobState(job);
      const before = previous.get(id);
      next.set(id, { fingerprint, state });
      if (!before || before.fingerprint !== fingerprint) changed.push(job);
      if (before && before.state !== state) stateChanged = true;
    }
    const removed = [];
    if (snapshot.full) {
      for (const id of previous.keys()) if (!next.has(id)) removed.push(id);
    }
    for (const id of snapshot.removed) {
      if (previous.has(id) && !removed.includes(id)) removed.push(id);
      next.delete(id);
    }
    link.jobs = next;
    if (shouldPublish && (changed.length || removed.length)) {
      publish("jobs", { managerId: link.id, jobs: changed.map((job) => redactValue(job)), removed }, link.source);
    }
    if (shouldPublish && stateChanged) triggerInstances(link);
  }

  function seedJobs(link, generation) {
    link.seeding = true;
    Promise.resolve()
      .then(() => fetchJson(link.id, JOBS_TARGET, { timeoutMs: fetchTimeoutMs }))
      .catch(() => null)
      .then((result) => {
        if (generation !== link.generation || !running) return;
        link.seeding = false;
        const list = result?.ok && Array.isArray(result.data) ? result.data : null;
        if (list && !link.snapshotSinceConnect) {
          // The first map is silent; after a reconnect, what changed while
          // the stream was down is relayed.
          applyJobs(link, { jobs: list.filter(isPlainObject), full: true, removed: [] }, { publish: link.jobs !== null });
        }
        // When the seed read failed, the held snapshot is relayed in full
        // rather than losing the change that caused it.
        const pending = link.pendingJobs;
        link.pendingJobs = null;
        if (pending) {
          link.snapshotSinceConnect = true;
          applyJobs(link, pending, { publish: true });
        }
      });
  }

  // --- instances ---------------------------------------------------------

  function nativeInstancesEvent(link, data) {
    if (data !== null && !isPlainObject(data) && !Array.isArray(data)) {
      malformed(link, "instances");
      return;
    }
    link.nativeInstances = true;
    cancel(link.pollTimer);
    link.pollTimer = null;
    const explicit = { changed: stringList(data?.changed), removed: stringList(data?.removed) };
    const list = instanceList(data);
    if (list) applyInstances(link, list, { native: true, explicit });
    else readInstances(link, { native: true, explicit });
  }

  function readingNow(link) {
    return Boolean(link.reading && link.reading.generation === link.generation);
  }

  function mergeReadRequests(queued, request) {
    if (!queued) return { native: Boolean(request.native), explicit: { changed: [...(request.explicit?.changed || [])], removed: [...(request.explicit?.removed || [])] } };
    return {
      native: queued.native || Boolean(request.native),
      explicit: {
        changed: [...queued.explicit.changed, ...(request.explicit?.changed || [])],
        removed: [...queued.explicit.removed, ...(request.explicit?.removed || [])],
      },
    };
  }

  // One read at a time per manager connection; a request that arrives
  // meanwhile runs once more afterwards, with its flags merged. A read left
  // over from an older connection is ignored, never waited on.
  function readInstances(link, request) {
    if (readingNow(link)) {
      link.reading.again = mergeReadRequests(link.reading.again, request);
      return link.reading.promise;
    }
    const token = { generation: link.generation, again: null, promise: null };
    link.reading = token;
    token.promise = (async () => {
      let current = request;
      while (current) {
        token.again = null;
        let result = null;
        try {
          result = await fetchJson(link.id, INSTANCES_TARGET, { timeoutMs: fetchTimeoutMs });
        } catch {
          result = null;
        }
        if (token.generation !== link.generation || !running) return;
        const list = result?.ok ? instanceList(result.data) : null;
        if (list) {
          link.readProblem = false;
          applyInstances(link, list, current);
        } else if (!link.readProblem) {
          link.readProblem = true;
          log.warn(`manager-event-relay: could not read instances from the ${link.id} manager (${result?.code || (result ? `http_${result.status}` : "error")}); later failures are not logged until a read succeeds`);
        }
        current = token.again;
      }
    })().finally(() => {
      if (link.reading === token) link.reading = null;
    });
    return token.promise;
  }

  function applyInstances(link, list, { native = false, explicit = {} } = {}) {
    const previous = link.instances;
    const next = new Map();
    for (const instance of list) {
      const id = instanceId(instance);
      if (id) next.set(id, instanceFingerprint(instance));
    }
    link.instances = next;
    const changed = [];
    const removed = [];
    if (previous) {
      for (const [id, fingerprint] of next) if (previous.get(id) !== fingerprint) changed.push(id);
      for (const id of previous.keys()) if (!next.has(id)) removed.push(id);
    } else if (native) {
      // The manager says something changed but there is no map to compare.
      changed.push(...next.keys());
    }
    for (const id of explicit.changed || []) if (!changed.includes(id)) changed.push(id);
    for (const id of explicit.removed || []) if (!removed.includes(id)) removed.push(id);
    if (!changed.length && !removed.length) return;
    if (native) {
      publish("instances", { managerId: link.id, changed, removed, native: true }, link.source);
      return;
    }
    // The first read only builds the map; synthesis needs a listener.
    if (!previous || link.nativeInstances || !hasInstanceSubscribers()) return;
    publish("instances", { managerId: link.id, changed, removed, native: false }, link.source);
  }

  function synthesising(link) {
    return running && link.state === "connected" && !link.nativeInstances && hasInstanceSubscribers();
  }

  function triggerInstances(link) {
    if (!synthesising(link)) return Promise.resolve();
    return readInstances(link, { native: false });
  }

  function schedulePoll(link) {
    cancel(link.pollTimer);
    link.pollTimer = null;
    if (!running || link.state !== "connected" || link.nativeInstances) return;
    link.pollTimer = schedule(() => {
      link.pollTimer = null;
      if (synthesising(link) && !readingNow(link)) readInstances(link, { native: false });
      schedulePoll(link);
    }, instancesPollMs);
  }

  // --- public API --------------------------------------------------------

  function start() {
    if (running) return api;
    running = true;
    for (const link of links.values()) {
      link.state = "connecting";
      link.sinceMs = clockMs();
      link.failures = 0;
      connect(link);
    }
    return api;
  }

  // Silent: the bus closes with the server, and a stop is not an outage.
  function stop() {
    if (!running) return;
    running = false;
    const at = clockMs();
    for (const link of links.values()) {
      link.generation += 1;
      link.state = "down";
      link.sinceMs = at;
      cancel(link.retryTimer);
      cancel(link.pollTimer);
      link.retryTimer = null;
      link.pollTimer = null;
      link.seeding = false;
      link.pendingJobs = null;
      link.reading = null;
      const request = link.request;
      link.request = null;
      try {
        request?.destroy?.();
      } catch {
        // Already gone.
      }
    }
  }

  // Called by the management proxy after a successful write: read instances
  // now instead of at the next 10 s tick. Resolves when that read is done.
  function poke(managerId) {
    const link = links.get(String(managerId ?? ""));
    if (!link) return Promise.resolve();
    return triggerInstances(link).catch(() => {});
  }

  function status() {
    return [...links.values()].map((link) => ({
      managerId: link.id,
      state: link.state,
      since: iso(link.sinceMs),
      lastEventAt: link.lastEventAtMs ? iso(link.lastEventAtMs) : null,
      reconnects: link.reconnects,
      nativeInstances: link.nativeInstances,
    }));
  }

  const api = { start, stop, poke, status };
  return api;
}

// Route module (07 §2.7). It answers no route: mounting starts the relay and
// publishes it as ctx.relay, which the management proxy pokes after a write.
// Smoke runs (AI_FRONTEND_SMOKE=1) spawn the entry next to whatever manager
// listens on the default ports, so the relay is created but never started.
function mount(ctx) {
  const bus = ctx?.bus;
  if (!bus || typeof bus.publish !== "function") throw new Error("manager-event-relay: ctx.bus is missing");
  const client = ctx.managerClient;
  const relay = createManagerEventRelay({
    bus,
    managers: Array.isArray(ctx.managers) ? ctx.managers : [],
    logger: ctx.logger || console,
    now: ctx.now,
    // The entry's shared manager client (mgmt-proxy) when it is mounted.
    fetchJson: client && typeof client.get === "function"
      ? (managerId, target, options) => client.get(managerId, target, options)
      : undefined,
  });
  ctx.relay = relay;
  if (process.env.AI_FRONTEND_SMOKE !== "1") relay.start();
  return {
    handle: async () => false,
    close() {
      relay.stop();
    },
  };
}

module.exports = {
  createManagerEventRelay,
  createSseParser,
  instanceFingerprint,
  mount,
  name: "manager-event-relay",
};
