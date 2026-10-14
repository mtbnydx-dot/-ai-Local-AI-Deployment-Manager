"use strict";

// Entry event bus (07 §2.8, 00 §4.5 and §9.6).
//
// One in-process stream of typed envelopes. Entry backends publish into it
// (hub downloads, telemetry, the platform bridge, the manager relay); the
// console, the supervisor and in-process collectors read from it. Every
// envelope carries an id `<bootId>-<seq>`, so a reconnecting EventSource
// resumes gap-free from a bounded ring instead of refetching every view. An
// id from another process start, or one the ring has already evicted, starts
// the stream with a `resync` control event and the client refetches.
//
// publish() validates every payload and never throws into the caller's path:
// a broken event is counted, logged once per type and reason, and dropped.

const crypto = require("node:crypto");
const { redactSecrets } = require("../../manager-core/secret-redactor");

const EVENT_TYPES = Object.freeze({
  status: "status",
  instances: "instances",
  jobs: "jobs",
  downloads: "downloads",
  library: "library",
  alerts: "alerts",
  "telemetry.live": "telemetry.live",
  notification: "notification",
  platform: "platform",
  security: "security",
  access: "access",
});
const EVENT_TYPE_NAMES = Object.freeze(Object.keys(EVENT_TYPES));
const EVENT_TYPE_SET = new Set(EVENT_TYPE_NAMES);
const EVENT_SOURCES = Object.freeze(["entry", "vllm", "llama", "hub", "telemetry", "platform"]);
const EVENT_SOURCE_SET = new Set(EVENT_SOURCES);
const DEFAULT_SOURCES = Object.freeze({
  status: "entry",
  instances: "entry",
  jobs: "entry",
  downloads: "hub",
  library: "hub",
  alerts: "telemetry",
  "telemetry.live": "telemetry",
  notification: "entry",
  platform: "platform",
  security: "entry",
  access: "entry",
});
// Control type written by the stream itself; it is never published.
const RESYNC_TYPE = "resync";
const NOTIFICATION_SEVERITIES = new Set(["info", "success", "warn", "error"]);
const API_CALL_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ALERT_ACTIONS = new Set(["firing", "resolved", "acked"]);
const EVENT_ID_RE = /^([0-9a-z]{6})-(\d{1,15})$/;
const BOOT_ID_RE = /^[0-9a-z]{6}$/;
const CLIENT_LABEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const RECENT_LIMIT_DEFAULT = 100;
const RECENT_LIMIT_MAX = 500;
const SSE_HEADERS = Object.freeze({
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
  // An ended stream closes its socket, so server.close() never waits on an
  // idle keep-alive connection left behind by a closed EventSource.
  connection: "close",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isBilingual(value) {
  return isPlainObject(value) && nonEmptyString(value.zh) && nonEmptyString(value.en);
}

// Same-origin relative only: "/x", never "//host" or "/\host" (browsers read
// a backslash as a slash), and no whitespace or control characters, which
// browsers strip before resolving and could turn "/\t/host" into "//host".
function isSameOriginPath(value) {
  return typeof value === "string"
    && value.length <= 2048
    && value.startsWith("/")
    && !value.startsWith("//")
    && !/[\\\s\u0000-\u001f\u007f]/.test(value);
}

// An apiCall must stay under /api/ after the browser normalises it, so dot
// segments and encoded separators are refused outright.
function isApiPath(value) {
  return isSameOriginPath(value)
    && value.startsWith("/api/")
    && !/(^|\/)\.{1,2}(\/|$|\?|#)/.test(value)
    && !/%(2e|2f|5c)/i.test(value);
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// 00 §9.6: {kind, severity, title{zh,en}, body?{zh,en}, action?{label{zh,en}, href | apiCall{method, path, body?}}}.
// Extra keys (04's dedupeKey and channels) pass through untouched.
function checkNotification(data) {
  if (!nonEmptyString(data.kind) || data.kind.length > 80) return "notification_kind";
  if (!NOTIFICATION_SEVERITIES.has(data.severity)) return "notification_severity";
  if (!isBilingual(data.title)) return "notification_title";
  if (data.body !== undefined && !isBilingual(data.body)) return "notification_body";
  if (data.action !== undefined) {
    const action = data.action;
    if (!isPlainObject(action) || !isBilingual(action.label)) return "notification_action_label";
    const hasHref = action.href !== undefined;
    const hasApiCall = action.apiCall !== undefined;
    if (hasHref === hasApiCall) return "notification_action_target";
    if (hasHref && !isSameOriginPath(action.href)) return "notification_action_href";
    if (hasApiCall) {
      const call = action.apiCall;
      if (!isPlainObject(call)) return "notification_action_api_call";
      if (!API_CALL_METHODS.has(String(call.method || "").toUpperCase())) return "notification_action_method";
      if (!isApiPath(call.path)) return "notification_action_path";
    }
  }
  return "";
}

// Payload shapes per type (07 §3.6 and §15.2). Only what consumers rely on is
// checked; additive fields always pass.
const PAYLOAD_CHECKS = {
  status(data) {
    if (!nonEmptyString(data.reason)) return "status_reason";
    if (data.managerId !== undefined && !nonEmptyString(data.managerId)) return "status_manager_id";
    if (data.ok !== undefined && typeof data.ok !== "boolean") return "status_ok";
    if (data.offline !== undefined && !stringArray(data.offline)) return "status_offline";
    return "";
  },
  instances(data) {
    if (!nonEmptyString(data.managerId)) return "instances_manager_id";
    if (!stringArray(data.changed)) return "instances_changed";
    if (!stringArray(data.removed)) return "instances_removed";
    if (data.native !== undefined && typeof data.native !== "boolean") return "instances_native";
    return "";
  },
  jobs(data) {
    if (!nonEmptyString(data.managerId)) return "jobs_manager_id";
    if (!Array.isArray(data.jobs) || !data.jobs.every(isPlainObject)) return "jobs_jobs";
    if (data.removed !== undefined && !stringArray(data.removed)) return "jobs_removed";
    return "";
  },
  downloads(data) {
    if (data.kind !== undefined && !nonEmptyString(data.kind)) return "downloads_kind";
    if (data.jobs !== undefined && (!Array.isArray(data.jobs) || !data.jobs.every(isPlainObject))) return "downloads_jobs";
    return "";
  },
  library: () => "",
  alerts(data) {
    if (data.action !== undefined && !ALERT_ACTIONS.has(data.action)) return "alerts_action";
    if (data.alert !== undefined && !isPlainObject(data.alert)) return "alerts_alert";
    return "";
  },
  "telemetry.live": () => "",
  notification: checkNotification,
  platform(data) {
    return nonEmptyString(data.kind) ? "" : "platform_kind";
  },
  security: () => "",
  access: () => "",
};

// Returns "" when the event may be published, otherwise the rejection reason.
function validateEvent(type, data, options = {}) {
  if (!EVENT_TYPE_SET.has(type)) return "unknown_type";
  if (!isPlainObject(data)) return "data_not_object";
  const source = options.source === undefined ? DEFAULT_SOURCES[type] : options.source;
  if (!EVENT_SOURCE_SET.has(source)) return "invalid_source";
  return PAYLOAD_CHECKS[type](data);
}

function parseEventId(value) {
  const match = EVENT_ID_RE.exec(String(value || "").trim());
  if (!match) return null;
  const seq = Number(match[2]);
  return Number.isSafeInteger(seq) ? { bootId: match[1], seq } : null;
}

function newBootId() {
  return crypto.randomInt(0, 36 ** 6).toString(36).padStart(6, "0");
}

function parseTypeList(value) {
  if (value === undefined || value === null || value === "") return null;
  const items = Array.isArray(value) ? value : String(value).split(",");
  return items.map((item) => String(item || "").trim()).filter((item) => EVENT_TYPE_SET.has(item));
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return RECENT_LIMIT_DEFAULT;
  return Math.min(RECENT_LIMIT_MAX, Math.floor(parsed));
}

function normalizeIp(value) {
  return String(value || "").replace(/^::ffff:/i, "").toLowerCase() || "unknown";
}

function frameFor(id, type, json) {
  return `id: ${id}\nevent: ${type}\ndata: ${json}\n\n`;
}

function errorBody(code, message, hint = "") {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
}

function writeJsonError(res, status, code, message, hint) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(errorBody(code, message, hint)));
}

function createEventBus(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const ringSize = Math.max(1, Math.floor(Number(options.ringSize ?? 500)));
  const ringBytes = Math.max(1024, Math.floor(Number(options.ringBytes ?? 4 << 20)));
  const storeCapBytes = Math.max(256, Math.floor(Number(options.storeCapBytes ?? 64 << 10)));
  const heartbeatMs = Math.max(10, Math.floor(Number(options.heartbeatMs ?? 15000)));
  const maxClients = Math.max(1, Math.floor(Number(options.maxClients ?? 64)));
  const maxClientsPerIp = Math.max(1, Math.floor(Number(options.maxClientsPerIp ?? 8)));
  const maxBufferedBytes = Math.max(1024, Math.floor(Number(options.maxBufferedBytes ?? 1 << 20)));
  const auth = options.auth || null;
  const logger = options.logger || console;
  const bootId = BOOT_ID_RE.test(String(options.bootId || "")) ? String(options.bootId) : newBootId();

  let seq = 0;
  // Ascending and contiguous: every delivered envelope is stored, and only
  // the oldest are evicted, so ring[i].seq === ring[0].seq + i.
  const ring = [];
  let ringBytesUsed = 0;
  const subscribers = new Set();
  const clients = new Set();
  const counters = { published: {}, rejected: {}, droppedSlow: 0, droppedError: 0, refusedCapacity: 0, truncated: 0 };
  const loggedRejections = new Set();
  // Envelopes published from inside a subscriber wait here, so every consumer
  // and the ring see them in seq order.
  const queue = [];
  let draining = false;
  let closed = false;
  let heartbeatTimer = null;

  // Subscriber errors can quote anything, so every line is redacted first.
  function warn(line) {
    try {
      (typeof logger.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging must never break the publisher.
    }
  }

  function bump(map, key) {
    map[key] = (map[key] || 0) + 1;
  }

  function reject(type, reason) {
    const key = EVENT_TYPE_SET.has(type) ? type : "(unknown)";
    bump(counters.rejected, key);
    const logKey = `${key}:${reason}`;
    if (loggedRejections.has(logKey)) return null;
    loggedRejections.add(logKey);
    warn(`events: rejected a ${key} event (${reason}); later ones with the same reason are counted, not logged`);
    return null;
  }

  function cursorId() {
    return `${bootId}-${seq}`;
  }

  function publish(type, data, publishOptions = {}) {
    try {
      if (closed) return null;
      const typeName = typeof type === "string" ? type : "";
      const opts = isPlainObject(publishOptions) ? publishOptions : {};
      const reason = validateEvent(typeName, data, opts);
      if (reason) return reject(typeName, reason);
      let dataJson;
      try {
        dataJson = JSON.stringify(data);
      } catch {
        return reject(typeName, "not_serialisable");
      }
      // toJSON() may turn an object into something else.
      if (typeof dataJson !== "string" || !dataJson.startsWith("{")) return reject(typeName, "not_serialisable");
      const source = opts.source === undefined ? DEFAULT_SOURCES[typeName] : opts.source;
      seq += 1;
      const id = `${bootId}-${seq}`;
      const at = new Date(Number(now())).toISOString();
      const json = `{"id":"${id}","type":${JSON.stringify(typeName)},"at":"${at}","source":"${source}","data":${dataJson}}`;
      // A parsed copy: consumers see JSON semantics and the publisher's later
      // mutations cannot reach the ring.
      const envelope = { id, type: typeName, at, source, data: JSON.parse(dataJson) };
      bump(counters.published, typeName);
      queue.push({ seq, envelope, json, frame: "" });
      drain();
      return envelope;
    } catch (error) {
      return reject(typeof type === "string" ? type : "", `internal: ${error?.message || error}`);
    }
  }

  function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        deliverToSubscribers(item.envelope);
        deliverToClients(item);
        store(item);
      }
    } finally {
      draining = false;
    }
  }

  function deliverToSubscribers(envelope) {
    for (const subscriber of [...subscribers]) {
      if (subscriber.types && !subscriber.types.has(envelope.type)) continue;
      try {
        subscriber.fn(envelope);
      } catch (error) {
        warn(`events: a ${envelope.type} subscriber threw: ${error?.message || error}`);
      }
    }
  }

  function ownerFrame(item) {
    if (!item.frame) item.frame = frameFor(item.envelope.id, item.envelope.type, item.json);
    return item.frame;
  }

  // A viewer's copy of an envelope, or null when its type's redaction drops
  // it. Without a registry nothing is shown (fail closed).
  function redactedEnvelope(principal, envelope) {
    let data = null;
    try {
      const registry = auth?.viewerRegistry;
      data = registry && typeof registry.redactEvent === "function"
        ? registry.redactEvent(envelope.type, envelope.data, { via: principal.via || "" })
        : null;
    } catch {
      data = null;
    }
    return isPlainObject(data) ? { ...envelope, data } : null;
  }

  function viewerFrame(client, envelope) {
    const redacted = redactedEnvelope(client.principal, envelope);
    return redacted ? frameFor(envelope.id, envelope.type, JSON.stringify(redacted)) : "";
  }

  function deliverToClients(item) {
    for (const client of [...clients]) {
      if (!client.accepts(item.envelope.type)) continue;
      const frame = client.redact ? viewerFrame(client, item.envelope) : ownerFrame(item);
      if (frame) writeTo(client, frame);
    }
  }

  function store(item) {
    let stored = { seq: item.seq, envelope: item.envelope, json: item.json, bytes: Buffer.byteLength(item.json), frame: item.frame };
    if (stored.bytes > storeCapBytes) {
      // Delivered live in full; a replaying client sees the marker and refetches.
      const envelope = { ...item.envelope, data: { truncated: true } };
      const json = JSON.stringify(envelope);
      stored = { seq: item.seq, envelope, json, bytes: Buffer.byteLength(json), frame: "" };
      counters.truncated += 1;
    }
    ring.push(stored);
    ringBytesUsed += stored.bytes;
    while (ring.length && (ring.length > ringSize || ringBytesUsed > ringBytes)) {
      ringBytesUsed -= ring.shift().bytes;
    }
  }

  // Where a client that last saw `lastEventId` resumes, or why it cannot.
  function locate(lastEventId) {
    const parsed = parseEventId(lastEventId);
    if (!parsed) return { gap: true, reason: "gap", items: [] };
    if (parsed.bootId !== bootId) return { gap: true, reason: "restart", items: [] };
    const firstSeq = ring.length ? ring[0].seq : seq + 1;
    if (parsed.seq > seq || parsed.seq < firstSeq - 1) return { gap: true, reason: "gap", items: [] };
    return { gap: false, reason: "", items: ring.slice(parsed.seq - firstSeq + 1) };
  }

  function resolvePrincipal(req, opts) {
    if (isPlainObject(opts.principal)) return normalizePrincipal(opts.principal);
    if (nonEmptyString(opts.role)) {
      return normalizePrincipal({ role: opts.role, via: opts.via || "", redact: opts.role === "viewer" });
    }
    if (auth && typeof auth.principal === "function") return normalizePrincipal(auth.principal(req));
    // Without the request-auth seam nobody is known to be an owner.
    return { role: "viewer", principal: "", via: "", redact: true };
  }

  function normalizePrincipal(value) {
    const role = ["owner", "system", "viewer", "none"].includes(value?.role) ? value.role : "none";
    return {
      ...value,
      role,
      principal: typeof value?.principal === "string" ? value.principal : "",
      via: typeof value?.via === "string" ? value.via : "",
      redact: Boolean(value?.redact),
    };
  }

  // The principal's allowed types, narrowed to the requested ones. Unknown
  // requested names are ignored.
  function allowedTypes(principal, requested) {
    let allowed;
    if (auth && typeof auth.eventTypesFor === "function") {
      allowed = auth.eventTypesFor(principal);
    } else {
      allowed = principal.role === "owner" ? "*" : new Set();
    }
    const base = allowed === "*"
      ? new Set(EVENT_TYPE_NAMES)
      : new Set([...(allowed instanceof Set || Array.isArray(allowed) ? allowed : [])].filter((type) => EVENT_TYPE_SET.has(type)));
    const wanted = parseTypeList(requested);
    if (!wanted) return base;
    return new Set(wanted.filter((type) => base.has(type)));
  }

  function writeTo(client, chunk) {
    if (client.gone) return;
    try {
      client.res.write(chunk);
    } catch {
      dropClient(client, "error");
      return;
    }
    if (Number(client.res.writableLength || 0) > client.bufferLimit) dropClient(client, "slow");
  }

  function dropClient(client, reason) {
    if (client.gone) return;
    client.gone = true;
    clients.delete(client);
    if (reason === "slow") counters.droppedSlow += 1;
    if (reason === "error") counters.droppedError += 1;
    if (reason === "slow" || reason === "error") {
      // A slow reader reconnects with Last-Event-ID and replays from the ring.
      try {
        client.res.destroy();
      } catch {
        // Already gone.
      }
    }
    stopHeartbeatWhenIdle();
  }

  function ensureHeartbeat() {
    if (heartbeatTimer || !clients.size) return;
    heartbeatTimer = setInterval(() => {
      if (!clients.size) {
        stopHeartbeatWhenIdle();
        return;
      }
      const ping = `: ping ${Number(now())}\n\n`;
      for (const client of [...clients]) writeTo(client, ping);
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeatWhenIdle() {
    if (clients.size || !heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function handleSse(req, res, sseOptions = {}) {
    const opts = isPlainObject(sseOptions) ? sseOptions : {};
    const principal = resolvePrincipal(req, opts);
    if (principal.role === "none") {
      writeJsonError(res, 401, "admin_session_required", "Sign in to the console to receive events.", "pair");
      return null;
    }
    if (closed) {
      writeJsonError(res, 503, "events_closed", "The event stream is shutting down.", "reconnect");
      return null;
    }
    const ip = normalizeIp(req?.socket?.remoteAddress);
    let fromIp = 0;
    for (const client of clients) if (client.ip === ip) fromIp += 1;
    if (clients.size >= maxClients || fromIp >= maxClientsPerIp) {
      counters.refusedCapacity += 1;
      writeJsonError(res, 503, "too_many_streams", "Too many open event streams.", "Close other console tabs, or poll /api/events/recent.");
      return null;
    }
    const types = allowedTypes(principal, opts.types);
    const label = CLIENT_LABEL_RE.test(String(opts.client || "")) ? String(opts.client) : "";
    const client = {
      res,
      ip,
      label,
      principal,
      redact: principal.redact,
      types,
      bufferLimit: maxBufferedBytes,
      gone: false,
      accepts: (type) => types.has(type),
    };
    res.writeHead(200, SSE_HEADERS);
    res.write("retry: 3000\n\n");
    const lastEventId = String(opts.lastEventId || "").trim();
    if (lastEventId) {
      const position = locate(lastEventId);
      if (position.gap) {
        const envelope = { id: cursorId(), type: RESYNC_TYPE, at: new Date(Number(now())).toISOString(), source: "entry", data: { reason: position.reason } };
        res.write(frameFor(envelope.id, RESYNC_TYPE, JSON.stringify(envelope)));
      } else {
        for (const item of position.items) {
          if (!client.accepts(item.envelope.type)) continue;
          const frame = client.redact ? viewerFrame(client, item.envelope) : ownerFrame(item);
          if (frame) res.write(frame);
        }
      }
    }
    // The replay is bounded by the ring, so it may sit above the live limit
    // until the socket drains once.
    const buffered = Number(res.writableLength || 0);
    if (buffered > maxBufferedBytes) {
      client.bufferLimit = buffered + maxBufferedBytes;
      res.once?.("drain", () => { client.bufferLimit = maxBufferedBytes; });
    }
    clients.add(client);
    ensureHeartbeat();
    const drop = () => dropClient(client, "closed");
    req?.on?.("close", drop);
    res.on?.("close", drop);
    res.on?.("error", drop);
    return client;
  }

  function recent(recentOptions = {}) {
    const opts = isPlainObject(recentOptions) ? recentOptions : {};
    const limit = clampLimit(opts.limit ?? RECENT_LIMIT_DEFAULT);
    let filter = null;
    if (isPlainObject(opts.principal) || nonEmptyString(opts.role)) {
      const principal = isPlainObject(opts.principal)
        ? normalizePrincipal(opts.principal)
        : normalizePrincipal({ role: opts.role, via: opts.via || "", redact: opts.role === "viewer" });
      filter = { principal, types: allowedTypes(principal, opts.types), redact: principal.redact };
    } else {
      // In-process callers read everything, optionally narrowed by type.
      const wanted = parseTypeList(opts.types);
      filter = { principal: null, types: wanted ? new Set(wanted) : new Set(EVENT_TYPE_NAMES), redact: false };
    }
    const since = String(opts.since || "").trim();
    let gap = false;
    let items = ring;
    if (since) {
      const position = locate(since);
      gap = position.gap;
      items = position.gap ? ring : position.items;
    }
    const visible = [];
    for (const item of items) {
      if (!filter.types.has(item.envelope.type)) continue;
      const envelope = filter.redact ? redactedEnvelope(filter.principal, item.envelope) : item.envelope;
      if (envelope) visible.push(envelope);
    }
    // Paging forward from `since` returns the oldest events first and points
    // lastId at the last one returned; otherwise the newest `limit` events.
    if (since && !gap && visible.length > limit) {
      const page = visible.slice(0, limit);
      return { events: page, lastId: page[page.length - 1].id, gap };
    }
    return { events: visible.slice(-limit), lastId: cursorId(), gap };
  }

  function subscribe(fn, subscribeOptions = {}) {
    if (typeof fn !== "function") throw new TypeError("events.subscribe needs a function");
    const wanted = parseTypeList(isPlainObject(subscribeOptions) ? subscribeOptions.types : null);
    const subscriber = { fn, types: wanted ? new Set(wanted) : null };
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  }

  // SSE clients plus in-process subscribers that would receive any of
  // `types`. A `client` label or `principal` id narrows to SSE clients.
  function subscriberCount(countOptions = {}) {
    const opts = isPlainObject(countOptions) ? countOptions : {};
    const wanted = parseTypeList(opts.types);
    const matchesTypes = (has) => !wanted || wanted.some((type) => has(type));
    let count = 0;
    for (const client of clients) {
      if (opts.client !== undefined && client.label !== String(opts.client)) continue;
      if (opts.principal !== undefined && client.principal.principal !== String(opts.principal)) continue;
      if (matchesTypes(client.accepts)) count += 1;
    }
    if (opts.client === undefined && opts.principal === undefined) {
      for (const subscriber of subscribers) {
        if (matchesTypes((type) => !subscriber.types || subscriber.types.has(type))) count += 1;
      }
    }
    return count;
  }

  function stats() {
    return {
      bootId,
      lastId: cursorId(),
      clients: clients.size,
      subscribers: subscribers.size,
      ring: { count: ring.length, bytes: ringBytesUsed, oldestId: ring.length ? ring[0].envelope.id : null },
      published: { ...counters.published },
      rejected: { ...counters.rejected },
      truncated: counters.truncated,
      dropped: { slow: counters.droppedSlow, error: counters.droppedError },
      refused: { capacity: counters.refusedCapacity },
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    for (const client of [...clients]) {
      client.gone = true;
      try {
        client.res.end();
      } catch {
        // Already gone.
      }
    }
    clients.clear();
    subscribers.clear();
    queue.length = 0;
  }

  return {
    bootId,
    publish,
    subscribe,
    subscriberCount,
    recent,
    handleSse,
    stats,
    close,
  };
}

// Route module (07 §2.7): serves the bus that startServiceEntry() put on ctx.
function mount(ctx) {
  const bus = ctx?.bus;
  const auth = ctx?.auth;
  if (!bus || typeof bus.handleSse !== "function") throw new Error("events: ctx.bus is missing");
  if (!auth || typeof auth.principal !== "function") throw new Error("events: ctx.auth is missing");
  // Both routes filter per principal themselves, so a viewer may call them.
  auth.viewerRegistry.registerRoute({ owner: "07", method: "GET", path: "/api/events" });
  auth.viewerRegistry.registerRoute({ owner: "07", method: "GET", path: "/api/events/recent" });
  const sendJson = typeof ctx.sendJson === "function"
    ? ctx.sendJson
    : (res, data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    };
  return {
    async handle(req, res, url) {
      if (req.method !== "GET") return false;
      if (url.pathname === "/api/events") {
        // EventSource sends the header on auto-reconnect while keeping the
        // original URL, so the header is newer than any ?lastEventId=.
        const header = req.headers?.["last-event-id"];
        bus.handleSse(req, res, {
          types: url.searchParams.get("types"),
          client: url.searchParams.get("client") || "",
          lastEventId: String(header || "").trim() || url.searchParams.get("lastEventId") || "",
        });
        return true;
      }
      if (url.pathname === "/api/events/recent") {
        const principal = auth.principal(req);
        if (principal.role === "none") {
          sendJson(res, errorBody("admin_session_required", "Sign in to the console to read events.", "pair"), 401);
          return true;
        }
        const result = bus.recent({
          since: url.searchParams.get("since") || "",
          types: url.searchParams.get("types"),
          limit: url.searchParams.get("limit"),
          principal,
        });
        sendJson(res, { ok: true, bootId: bus.bootId, ...result });
        return true;
      }
      return false;
    },
    close() {
      // The bus belongs to the server and is closed with it.
    },
  };
}

module.exports = {
  EVENT_SOURCES,
  EVENT_TYPES,
  RESYNC_TYPE,
  createEventBus,
  feature: "events",
  isApiPath,
  isSameOriginPath,
  mount,
  name: "events",
  parseEventId,
  validateEvent,
};
