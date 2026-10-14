// Entry event stream client and cache wiring (07 §3.6, server side §2.8).
//
// One EventSource per tab. After repeated errors, or when the server refuses
// the stream, the client switches to `polling`: it reads /api/events/recent
// every 5 s from the last id it saw and retries SSE every 60 s. If /recent
// fails as well the state is `offline`, and only then do the per-key
// refetch timers of ui/hooks.js run. applyEvent() maps one envelope onto the
// query cache and is pure apart from the cache calls.

import { check } from "./guards.js";
import { EventEnvelopeGuard } from "./schemas.js";

export const EVENT_TYPES = Object.freeze([
  "status", "instances", "jobs", "downloads", "library", "alerts", "telemetry.live", "notification", "platform", "security", "access",
]);
export const VIEWER_EVENT_TYPES = Object.freeze(["status", "instances"]);
const RESYNC = "resync";

/** Every cache prefix an event keeps fresh; `resync` and `gap` invalidate them all. */
export const EVENTED_PREFIXES = Object.freeze([
  ["status"], ["platform"], ["fleet"], ["m"], ["hub", "downloads"], ["hub", "library"],
  ["telemetry", "live"], ["alerts"], ["security"], ["access"],
]);

const POLL_MS = 5000;
const SSE_RETRY_MS = 60000;
const ERROR_WINDOW_MS = 60000;
const MAX_ERRORS = 3;
const HIDDEN_CLOSE_MS = 5 * 60000;
const EVENT_SOURCE_CLOSED = 2;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Replaces items by id, puts unknown ids first and drops `removed`.
function mergeById(list, changed, removed) {
  const gone = new Set(Array.isArray(removed) ? removed.map(String) : []);
  const updates = new Map();
  for (const item of Array.isArray(changed) ? changed : []) {
    if (isPlainObject(item) && item.id !== undefined) updates.set(String(item.id), item);
  }
  const out = [];
  for (const item of list) {
    const id = isPlainObject(item) ? String(item.id) : "";
    if (gone.has(id)) continue;
    if (updates.has(id)) {
      out.push(updates.get(id));
      updates.delete(id);
    } else {
      out.push(item);
    }
  }
  return [...[...updates.values()].filter((item) => !gone.has(String(item.id))), ...out];
}

function invalidateAll(cache) {
  for (const prefix of EVENTED_PREFIXES) cache.invalidate(prefix);
}

function mergeJobs(cache, managerId, data) {
  const key = ["m", managerId, "jobs"];
  const current = cache.get(key);
  if (current.status !== "success") return;
  cache.set(key, (previous) => {
    if (Array.isArray(previous)) return mergeById(previous, data.jobs, data.removed);
    if (isPlainObject(previous) && Array.isArray(previous.jobs)) return { ...previous, jobs: mergeById(previous.jobs, data.jobs, data.removed) };
    return previous;
  });
}

// Downloads lists are filtered by their query, so a job id a list does not
// hold yet is not inserted: that list is refetched instead.
function mergeDownloads(cache, data) {
  const jobs = Array.isArray(data.jobs) ? data.jobs.filter((job) => isPlainObject(job) && job.id !== undefined) : [];
  for (const key of cache.keys(["hub", "downloads"])) {
    const current = cache.get(key);
    if (current.status !== "success" || !isPlainObject(current.data) || !Array.isArray(current.data.jobs)) {
      cache.invalidate(key, { exact: true });
      continue;
    }
    const known = new Set(current.data.jobs.map((job) => String(job?.id)));
    if (jobs.some((job) => !known.has(String(job.id)))) {
      cache.invalidate(key, { exact: true });
      continue;
    }
    cache.set(key, (previous) => ({
      ...previous,
      jobs: mergeById(previous.jobs, jobs, []),
      ...(isPlainObject(data.aggregate) ? { aggregate: data.aggregate } : {}),
    }));
  }
}

/**
 * Applies one §2.8 envelope to the cache (§3.6 table). Returns true when the
 * envelope changed or invalidated something; unknown types are ignored.
 */
export function applyEvent(cache, envelope) {
  if (!isPlainObject(envelope)) return false;
  if (envelope.type === RESYNC) {
    invalidateAll(cache);
    return true;
  }
  const checked = check(EventEnvelopeGuard, envelope);
  if (!checked.ok) return false;
  const { type, data } = checked.value;
  const managerId = typeof data.managerId === "string" ? data.managerId : null;
  switch (type) {
    case "status":
      cache.invalidate(["status"], { exact: true });
      cache.invalidate(["platform"], { exact: true });
      return true;
    case "platform":
      if (data.kind === "status" && data.full === true && isPlainObject(data.status)) {
        cache.set(["platform"], data.status);
      } else if (data.kind === "component") {
        cache.invalidate(["platform"], { exact: true });
        cache.invalidate(["platform", "components"]);
      } else if (data.kind === "operation" && typeof data.opId === "string") {
        cache.set(["platform", "op", data.opId], {
          opId: data.opId, kind: data.opKind ?? data.kind, state: data.state, progress: data.progress, line: data.line,
        });
      } else {
        cache.invalidate(["platform"], { exact: true });
      }
      return true;
    case "instances":
      cache.invalidate(["fleet"]);
      if (managerId) cache.invalidate(["m", managerId, "instances"]);
      else cache.invalidate(["m"]);
      return true;
    case "jobs":
      if (!managerId) return false;
      if (data.truncated === true) cache.invalidate(["m", managerId, "jobs"]);
      else mergeJobs(cache, managerId, data);
      return true;
    case "downloads":
      if (data.truncated === true) cache.invalidate(["hub", "downloads"]);
      else mergeDownloads(cache, data);
      return true;
    case "library":
      cache.invalidate(["hub", "library"]);
      return true;
    case "alerts":
      cache.invalidate(["alerts"]);
      return true;
    case "telemetry.live":
      if (data.truncated === true) cache.invalidate(["telemetry", "live"]);
      else cache.set(["telemetry", "live"], data);
      return true;
    case "security":
      cache.invalidate(["security"]);
      return true;
    case "access":
      cache.invalidate(["access"]);
      return true;
    default:
      // notification goes to the NotificationCenter through stream.on(); others are unknown.
      return false;
  }
}

function withParams(url, params) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(name, String(value));
  }
  const text = search.toString();
  if (!text) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${text}`;
}

/**
 * @param options.recent ({ since, types }) → Promise<{ events, lastId, gap }>, normally
 *   api.get("/api/events/recent", { query }). Without it /recent counts as failing.
 * @param options.visibility { hidden(): boolean, onChange(fn) → off }, the page visibility.
 * @returns {{ on(type, handler) → off, close(), reconnect(), readonly state, readonly lastId, needsTimers() }}
 */
export function createEventStream({
  url = "/api/events",
  types = EVENT_TYPES,
  EventSourceImpl,
  now = Date.now,
  onState,
  recent,
  visibility,
  client = "console",
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (id) => globalThis.clearTimeout(id),
} = {}) {
  const wanted = [...new Set((Array.isArray(types) ? types : EVENT_TYPES).filter((type) => EVENT_TYPES.includes(type)))];
  const handlers = new Map();
  const ESImpl = EventSourceImpl || globalThis.EventSource;
  let state = "connecting";
  let source = null;
  let lastId = null;
  let errors = [];
  let pollTimer = null;
  let retryTimer = null;
  let hiddenTimer = null;
  let hiddenClosed = false;
  let closed = false;
  let polling = false;
  let offVisibility = null;

  function setState(next) {
    if (state === next) return;
    state = next;
    if (typeof onState === "function") {
      try {
        onState(next);
      } catch {
        // The banner callback must not break the stream.
      }
    }
  }

  function dispatch(envelope) {
    if (!isPlainObject(envelope) || typeof envelope.type !== "string") return;
    if (typeof envelope.id === "string" && envelope.id) lastId = envelope.id;
    for (const key of [envelope.type, "*"]) {
      for (const handler of [...(handlers.get(key) || [])]) {
        try {
          handler(envelope);
        } catch {
          // A failing view handler must not stop delivery to the others.
        }
      }
    }
  }

  function onMessage(event, fallbackType) {
    let envelope;
    try {
      envelope = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isPlainObject(envelope)) return;
    if (typeof envelope.type !== "string") envelope.type = fallbackType;
    if (typeof envelope.id !== "string" && typeof event.lastEventId === "string" && event.lastEventId) envelope.id = event.lastEventId;
    dispatch(envelope);
  }

  function closeSource() {
    if (!source) return;
    try {
      source.close();
    } catch {
      // Already closed.
    }
    source = null;
  }

  function streamUrl(withLastId) {
    return withParams(url, { types: wanted.join(","), client, lastEventId: withLastId ? lastId : null });
  }

  function open(withLastId) {
    closeSource();
    if (closed || typeof ESImpl !== "function") {
      if (!closed) startPolling();
      return;
    }
    let es;
    try {
      es = new ESImpl(streamUrl(withLastId));
    } catch {
      startPolling();
      return;
    }
    source = es;
    if (!polling) setState("connecting");
    es.onopen = () => {
      if (source !== es) return;
      errors = [];
      stopPolling();
      setState("open");
    };
    es.onerror = () => {
      if (source !== es) return;
      const at = now();
      errors = errors.filter((time) => at - time < ERROR_WINDOW_MS);
      errors.push(at);
      // CLOSED means the server refused the stream (4xx/5xx, 503 too_many_streams):
      // EventSource will not retry on its own.
      if (es.readyState === EVENT_SOURCE_CLOSED || errors.length > MAX_ERRORS) {
        closeSource();
        startPolling();
      } else if (!polling) {
        setState("connecting");
      }
    };
    es.onmessage = (event) => onMessage(event, "message");
    for (const type of [...wanted, RESYNC]) {
      es.addEventListener(type, (event) => {
        if (source === es) onMessage(event, type);
      });
    }
  }

  async function pollOnce() {
    pollTimer = null;
    if (closed || !polling) return;
    let ok = false;
    if (typeof recent === "function") {
      try {
        const answer = await recent({ since: lastId, types: wanted.join(",") });
        if (closed || !polling) return;
        if (isPlainObject(answer)) {
          ok = true;
          if (answer.gap === true) dispatch({ type: RESYNC, at: new Date(now()).toISOString(), source: "entry", data: { reason: "gap" } });
          for (const envelope of Array.isArray(answer.events) ? answer.events : []) dispatch(envelope);
          if (typeof answer.lastId === "string" && answer.lastId) lastId = answer.lastId;
        }
      } catch {
        ok = false;
      }
    }
    if (closed || !polling) return;
    setState(ok ? "polling" : "offline");
    pollTimer = setTimer(pollOnce, POLL_MS);
  }

  function startPolling() {
    if (closed) return;
    if (!polling) {
      polling = true;
      setState("polling");
      pollOnce();
    }
    if (retryTimer === null) {
      retryTimer = setTimer(() => {
        retryTimer = null;
        if (closed || !polling) return;
        open(true);
        // A refused stream calls startPolling() again, which re-arms the retry.
        if (polling && retryTimer === null) startPolling();
      }, SSE_RETRY_MS);
    }
  }

  function stopPolling() {
    polling = false;
    if (pollTimer !== null) clearTimer(pollTimer);
    if (retryTimer !== null) clearTimer(retryTimer);
    pollTimer = null;
    retryTimer = null;
  }

  function onVisibilityChange() {
    const hidden = Boolean(visibility?.hidden?.());
    if (hidden) {
      if (hiddenTimer === null && !hiddenClosed) {
        hiddenTimer = setTimer(() => {
          hiddenTimer = null;
          if (closed) return;
          hiddenClosed = true;
          stopPolling();
          closeSource();
        }, HIDDEN_CLOSE_MS);
      }
      return;
    }
    if (hiddenTimer !== null) clearTimer(hiddenTimer);
    hiddenTimer = null;
    if (hiddenClosed && !closed) {
      hiddenClosed = false;
      open(true);
    }
  }

  if (visibility && typeof visibility.onChange === "function") {
    offVisibility = visibility.onChange(onVisibilityChange);
  }
  open(false);

  return {
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
      return () => handlers.get(type)?.delete(handler);
    },
    close() {
      closed = true;
      stopPolling();
      if (hiddenTimer !== null) clearTimer(hiddenTimer);
      hiddenTimer = null;
      closeSource();
      if (typeof offVisibility === "function") offVisibility();
      setState("offline");
    },
    /** Opens a new EventSource now, resuming from the last id (ConnectionBanner retry). */
    reconnect() {
      if (closed) return;
      errors = [];
      open(true);
    },
    get state() {
      return state;
    },
    get lastId() {
      return lastId;
    },
    /** True while neither SSE nor /recent works: the per-key refetch timers run (§3.5). */
    needsTimers() {
      return state === "offline";
    },
  };
}
