"use strict";

// Viewer redactions of the telemetry API (docs/overhaul/04-telemetry.md §11.8).
//
// A viewer is a LAN device, or a loopback caller without an owner session.
// It reaches only the GET routes registered here and gets each body through
// that route's redaction, which sendJson applies centrally (05 §5.4). Every
// function builds its answer from an allowlist of fields, so a field added to
// an API later does not leak to viewers until someone lists it here.
//
// Owner-only, never registered: /api/telemetry/requests[/:id], /export,
// /settings, /import[/:runId], every /api/audit/* route, the billing summary
// and the event type `notification`.
//
// The two query pre-checks (redactSeriesQuery, redactBreakdownQuery) look at
// the request parameters before any SQL runs: a viewer that asks for a
// dimension or a filter that names a key, a customer or an address gets
// 403 owner_required.

const OWNER = "04";
const COLLECTOR_NAMES = Object.freeze(["recorder", "runtime", "gpu", "events", "store"]);
const VIEWER_ANNOTATION_FIELDS = Object.freeze(["type", "at", "title"]);
const VIEWER_EVENT_FIELDS = Object.freeze(["id", "at", "type", "severity", "source", "managerId", "title"]);
const OWNER_ONLY_GROUPS = Object.freeze(["key", "customer"]);
const OWNER_ONLY_FILTERS = Object.freeze(["key_id", "customer_id"]);
const OWNER_ONLY_DIMS = Object.freeze(["client_ip", "customer", "key"]);
const ALERT_STRIPPED_KEYS = new Set(["channels", "webhookId", "webhookIds", "webhooks"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pick(source, keys) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function identity(body) {
  return body;
}

// ok or degraded; anything that is not plainly fine reads as degraded.
function collectorState(value) {
  const state = isPlainObject(value) ? value.state : value;
  return state === "ok" || state === "idle" ? "ok" : "degraded";
}

function viewerCollectors(collectors) {
  const out = {};
  if (!isPlainObject(collectors)) return out;
  for (const [name, value] of Object.entries(collectors)) out[name] = collectorState(value);
  return out;
}

// --- /api/telemetry/live and the telemetry.live event -------------------------

const LIVE_GATEWAY = Object.freeze(["inflight", "requestsPerMin", "outputTokensPerSec", "errorRate5m", "ttftP95Ms5m", "clientAborts5m"]);
const LIVE_INSTANCE = Object.freeze(["fleetId", "engineId", "model", "state", "idle", "running", "waiting", "kvUsage", "outputTps", "vramReservationMb", "sampleAt"]);
const LIVE_GPU = Object.freeze(["index", "util", "memUsedMb", "memTotalMb", "tempC", "powerW", "powerLimitW", "throttle"]);

function redactLive(body) {
  if (!isPlainObject(body)) return body;
  return {
    ...pick(body, ["ok", "at", "windowSeconds"]),
    gateway: pick(body.gateway, LIVE_GATEWAY),
    instances: Array.isArray(body.instances) ? body.instances.map((item) => pick(item, LIVE_INSTANCE)) : [],
    gpus: Array.isArray(body.gpus) ? body.gpus.map((item) => ({ ...pick(item, LIVE_GPU), throttle: Array.isArray(item && item.throttle) ? item.throttle.map(String) : [] })) : [],
    alerts: pick(body.alerts, ["firing", "critical"]),
    collectors: viewerCollectors(body.collectors),
  };
}

// --- /api/telemetry/summary ---------------------------------------------------

// The summary has no key or customer breakdown, but its filters would still
// let a viewer read one key's or one customer's totals.
function redactSummaryQuery(input) {
  const params = paramsOf(input);
  const filter = OWNER_ONLY_FILTERS.find((name) => params.get(name) !== null && params.get(name) !== undefined);
  return filter ? ownerRequired("Filtering by key or customer needs the owner.") : null;
}

function redactSummary(body) {
  if (!isPlainObject(body)) return body;
  const out = clone(body);
  for (const name of ["current", "previous"]) {
    if (isPlainObject(out[name])) {
      delete out[name].billedMicrocredits;
      delete out[name].activeKeys;
    }
  }
  out.viewer = true;
  return out;
}

// --- /api/telemetry/timeseries ------------------------------------------------

function paramsOf(input) {
  if (input && typeof input.get === "function") return input;
  const map = new Map(Object.entries(isPlainObject(input) ? input : {}));
  return { get: (name) => (map.has(name) ? String(map.get(name)) : null), has: (name) => map.has(name) };
}

function ownerRequired(message) {
  return {
    status: 403,
    code: "owner_required",
    message,
    hint: "Open the console on this machine as its owner to see per-key and per-customer data.",
  };
}

// null when the viewer may run the query, else the 403 to answer with.
function redactSeriesQuery(input) {
  const params = paramsOf(input);
  const groupBy = params.get("groupBy");
  if (groupBy && OWNER_ONLY_GROUPS.includes(groupBy)) return ownerRequired("Grouping by key or customer needs the owner.");
  const filter = OWNER_ONLY_FILTERS.find((name) => params.get(name) !== null && params.get(name) !== undefined);
  if (filter) return ownerRequired("Filtering by key or customer needs the owner.");
  return null;
}

function redactSeries(body) {
  if (!isPlainObject(body)) return body;
  const out = clone(body);
  if (Array.isArray(out.series)) {
    out.series = out.series.filter((item) => !(isPlainObject(item) && isPlainObject(item.group) && OWNER_ONLY_GROUPS.some((name) => name in item.group)));
  }
  if (Array.isArray(out.annotations)) out.annotations = out.annotations.map((item) => pick(item, VIEWER_ANNOTATION_FIELDS));
  return out;
}

// --- /api/telemetry/breakdown -------------------------------------------------

function redactBreakdownQuery(input) {
  const params = paramsOf(input);
  const dim = params.get("dim");
  if (dim && OWNER_ONLY_DIMS.includes(dim)) return ownerRequired("This breakdown needs the owner.");
  const filter = OWNER_ONLY_FILTERS.find((name) => params.get(name) !== null && params.get(name) !== undefined);
  if (filter) return ownerRequired("Filtering by key or customer needs the owner.");
  return null;
}

function redactBreakdown(body) {
  if (!isPlainObject(body)) return body;
  const out = clone(body);
  if (Array.isArray(out.rows)) {
    out.rows = out.rows.map((row) => {
      if (!isPlainObject(row)) return row;
      const { sampleRequestIds, ...rest } = row;
      return rest;
    });
  }
  return out;
}

// --- /api/telemetry/events ----------------------------------------------------

function redactEvents(body) {
  if (!isPlainObject(body)) return body;
  const out = clone(body);
  if (Array.isArray(out.rows)) {
    out.rows = out.rows.map((row) => {
      const kept = pick(row, VIEWER_EVENT_FIELDS);
      // The one detail a viewer keeps: the masked address of a ban.
      if (isPlainObject(row) && row.type === "security.ban" && isPlainObject(row.data) && typeof row.data.ipMasked === "string") {
        kept.data = { ipMasked: row.data.ipMasked };
      }
      return kept;
    });
  }
  return out;
}

// --- alerts, alert rules and the alerts event ----------------------------------

function stripAlertKeys(value) {
  if (Array.isArray(value)) return value.map(stripAlertKeys);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ALERT_STRIPPED_KEYS.has(key)) out[key] = stripAlertKeys(item);
  }
  return out;
}

function redactAlerts(body) {
  return isPlainObject(body) || Array.isArray(body) ? stripAlertKeys(body) : body;
}

// --- /api/telemetry/status ----------------------------------------------------

function redactStatus(body) {
  if (!isPlainObject(body)) return body;
  return {
    ...pick(body, ["ok", "schemaVersion"]),
    collectors: viewerCollectors(body.collectors),
    degraded: Array.isArray(body.degraded) ? body.degraded.filter((item) => typeof item === "string").map((item) => item.slice(0, 80)) : [],
  };
}

// --- the §11.8 tables -----------------------------------------------------------

const TELEMETRY_VIEWER_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/telemetry/live", redact: redactLive }),
  Object.freeze({ method: "GET", path: "/api/telemetry/summary", redact: redactSummary, precheck: redactSummaryQuery, endpoint: "summary" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/timeseries", redact: redactSeries, precheck: redactSeriesQuery, endpoint: "timeseries" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/breakdown", redact: redactBreakdown, precheck: redactBreakdownQuery, endpoint: "breakdown" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/events", redact: redactEvents, endpoint: "events" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/alerts", redact: redactAlerts, endpoint: "alerts" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/alert-rules", redact: redactAlerts, endpoint: "alert-rules" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/energy", redact: identity, endpoint: "energy" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/lifecycle", redact: identity, endpoint: "lifecycle" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/launches", redact: identity, endpoint: "launches" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/baseline", redact: identity, endpoint: "baseline" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/status", redact: redactStatus, endpoint: "status" }),
]);

// `live` has no query parameters to pre-check; its endpoint name is "live".
const VIEWER_ENDPOINTS = Object.freeze(new Map([
  ["live", { redact: redactLive }],
  ...TELEMETRY_VIEWER_ROUTES.filter((route) => route.endpoint).map((route) => [route.endpoint, { redact: route.redact, precheck: route.precheck || null }]),
]));

const TELEMETRY_VIEWER_EVENTS = Object.freeze([
  Object.freeze({ type: "telemetry.live", redact: redactLive }),
  Object.freeze({ type: "alerts", redact: redactAlerts }),
]);

// Declared owner-only so 05's route inventory lists them (never viewer
// routes): everything else under /api/telemetry/ that 04 serves.
const TELEMETRY_OWNER_ONLY_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/telemetry/requests" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/requests/:requestId" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/export" }),
  Object.freeze({ method: "GET", path: "/api/telemetry/settings" }),
  Object.freeze({ method: "PUT", path: "/api/telemetry/settings" }),
]);

function attempt(label, warn, action) {
  try {
    action();
  } catch (error) {
    warn(`telemetry-viewer: ${label} was not registered and stays owner-only: ${error && error.message ? error.message : error}`);
  }
}

/**
 * registerTelemetryViewerRoutes(allowlist, warn): registers 04's viewer GET
 * routes and event types with 05's registry (viewer-allowlist.js, or the
 * request-auth seam in front of it). Runs at mount time, before the registry
 * freezes. A row that cannot be registered (taken, or the registry is
 * frozen) is logged and left owner-only; the others are still registered.
 */
function registerTelemetryViewerRoutes(allowlist, warn = () => {}) {
  for (const route of TELEMETRY_VIEWER_ROUTES) {
    attempt(`${route.method} ${route.path}`, warn, () => allowlist.registerRoute({ owner: OWNER, method: route.method, path: route.path, redact: route.redact }));
  }
  for (const route of TELEMETRY_OWNER_ONLY_ROUTES) {
    attempt(`${route.method} ${route.path}`, warn, () => allowlist.registerAdminOnly({ owner: OWNER, method: route.method, path: route.path }));
  }
  for (const event of TELEMETRY_VIEWER_EVENTS) {
    attempt(`event ${event.type}`, warn, () => allowlist.registerEventType({ owner: OWNER, type: event.type, redact: event.redact }));
  }
}

module.exports = {
  TELEMETRY_OWNER_ONLY_ROUTES,
  TELEMETRY_VIEWER_EVENTS,
  TELEMETRY_VIEWER_ROUTES,
  VIEWER_ENDPOINTS,
  collectorState,
  identity,
  redactAlerts,
  redactBreakdown,
  redactBreakdownQuery,
  redactEvents,
  redactLive,
  redactSeries,
  redactSeriesQuery,
  redactStatus,
  redactSummary,
  redactSummaryQuery,
  registerTelemetryViewerRoutes,
};
