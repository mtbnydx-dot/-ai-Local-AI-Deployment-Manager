// /system model (06 §11, 07 §6.13): the pure parts of the component table.
//
// Two sources produce the same row shape. 06's PlatformStatus (`components[]`,
// owner view or the viewer redaction of platform-routes.js) is the real one.
// Before the platform backend is mounted, the rows come from the entry's own
// GET /api/status `components.items`, which only knows online and healthy;
// those rows are marked `degraded` and offer the manager start and stop that
// already exist. Nothing here touches the DOM, the cache or the network.

const KNOWN_STATES = new Set(["ready", "starting", "unhealthy", "stopped", "failed", "backoff", "blocked", "not-installed", "external", "unknown", "disabled", "stopping"]);
const STATE_TONE = Object.freeze({
  ready: "ok",
  starting: "info",
  stopping: "info",
  backoff: "warn",
  unhealthy: "warn",
  unknown: "warn",
  failed: "error",
  blocked: "error",
  stopped: "neutral",
  external: "neutral",
  disabled: "neutral",
  "not-installed": "neutral",
});
const STARTABLE = new Set(["stopped", "failed", "blocked"]);
const RUNNING = new Set(["ready", "unhealthy", "backoff"]);
const BLOCKER_KINDS = new Set(["launch", "download", "migration", "benchmark", "requests", "loading", "unknown"]);
const MANAGER_KIND = "manager";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** A state the catalog has a label for; anything else reads as `unknown` (never as healthy). */
export function knownState(state) {
  return KNOWN_STATES.has(state) ? state : "unknown";
}

/** The StatusBadge tone of a component state. */
export function stateTone(state) {
  return STATE_TONE[knownState(state)];
}

function portNumbers(ports) {
  if (!Array.isArray(ports)) return [];
  const seen = [];
  for (const port of ports) {
    const n = finite(isPlainObject(port) ? port.port : port);
    if (n !== null && !seen.includes(n)) seen.push(n);
  }
  return seen;
}

/** A row of 06's PlatformStatus (owner view or viewer redaction) as a table row. */
export function platformRow(component, pick = (value) => value) {
  const row = isPlainObject(component) ? component : {};
  const id = text(row.id);
  const label = isPlainObject(row.label) ? text(pick(row.label)) : text(row.label);
  return {
    id,
    label: label || id,
    kind: text(row.kind),
    state: knownState(row.state),
    desired: text(row.desired) || null,
    owner: text(row.owner) || null,
    ports: portNumbers(row.ports),
    uptimeSec: finite(row.uptimeSec),
    restartCount: finite(row.restarts?.count),
    lastExit: isPlainObject(row.lastExit) ? row.lastExit : null,
    pending: isPlainObject(row.pendingRestart) ? row.pendingRestart : null,
    reason: text(row.reason) || null,
    blocked: isPlainObject(row.blocked) ? row.blocked : null,
    message: null,
    startCommand: null,
    degraded: false,
    managerId: null,
  };
}

/** The table rows of a PlatformStatus; rows without an id are dropped. */
export function platformRows(status, pick) {
  const list = Array.isArray(status?.components) ? status.components : [];
  return list.map((component) => platformRow(component, pick)).filter((row) => row.id);
}

/**
 * The pre-platform rows: GET /api/status `components.items`
 * ({id, name, kind, online, healthy, startable, startCommand, error}).
 */
export function degradeRows(status) {
  const items = Array.isArray(status?.components?.items) ? status.components.items : [];
  return items.filter((item) => isPlainObject(item) && text(item.id)).map((item) => {
    const online = item.online === true;
    const manager = item.kind === MANAGER_KIND;
    return {
      id: text(item.id),
      label: text(item.name) || text(item.id),
      kind: text(item.kind),
      state: online ? (item.healthy === false ? "unhealthy" : "ready") : "stopped",
      desired: null,
      owner: null,
      ports: [],
      uptimeSec: null,
      restartCount: null,
      lastExit: null,
      pending: null,
      reason: null,
      blocked: null,
      message: text(item.error) || null,
      startCommand: !online && !(manager && item.startable === true) ? text(item.startCommand) || null : null,
      degraded: true,
      managerId: manager ? text(item.id) : null,
    };
  });
}

/**
 * The row actions an owner gets, in display order: start, restart,
 * restartIdle, stop, logs. A detect-only or unidentified component has none,
 * and the entry has no Stop (the Danger zone stops the platform).
 */
export function actionsFor(row, { owner = false } = {}) {
  if (!owner || !row) return [];
  if (row.degraded) {
    if (!row.managerId) return [];
    return row.state === "stopped" ? ["start"] : ["stop"];
  }
  if (row.kind === "external" || row.kind === "listener") return [];
  const actions = [];
  if (STARTABLE.has(row.state)) actions.push("start");
  if (RUNNING.has(row.state)) actions.push("restart", "restartIdle");
  if ((RUNNING.has(row.state) || row.state === "starting") && row.id !== "entry") actions.push("stop");
  if (row.state !== "external" && row.state !== "not-installed" && row.state !== "disabled") actions.push("logs");
  return actions;
}

/** The API request of an action on a component: { method, path, body }. */
export function actionRequest(row, action) {
  const id = encodeURIComponent(row.id);
  if (row.degraded) return { path: `/api/managers/${id}/${action === "stop" ? "stop" : "start"}`, body: undefined };
  switch (action) {
    case "start": return { path: `/api/platform/components/${id}/start`, body: {} };
    case "stop": return { path: `/api/platform/components/${id}/stop`, body: { confirm: true } };
    case "restart": return { path: `/api/platform/components/${id}/restart`, body: { when: "now" } };
    case "restartIdle": return { path: `/api/platform/components/${id}/restart`, body: { when: "idle" } };
    default: return null;
  }
}

/** The blockers of a 409 `component_busy` error: [{kind, title, source, id, since}]. */
export function blockersOf(error) {
  const list = error?.details?.blockers;
  if (!Array.isArray(list)) return [];
  return list.filter(isPlainObject).map((item) => ({
    kind: BLOCKER_KINDS.has(item.kind) ? item.kind : "unknown",
    title: text(item.title),
    source: text(item.source) || null,
    id: text(item.id) || null,
    since: text(item.since) || null,
  }));
}

/** True when the supervisor is known not to run: a probe-only status or `supervisor.running === false`. */
export function supervisorMissing(status) {
  if (!isPlainObject(status)) return false;
  if (status.supervisor && status.supervisor.running === false) return true;
  return status.mode === "probe";
}

/** The `{port, image, pid}` of a port-conflict row, or null. */
export function portConflictOf(row) {
  if (row?.state !== "blocked" || !isPlainObject(row.blocked)) return null;
  const port = finite(row.blocked.port);
  if (port === null) return null;
  return { port, pid: finite(row.blocked.pid), image: text(row.blocked.imageName) || null };
}

/** A pending restart that a deploy queued, as opposed to one the person asked for. */
export function isDeployRestart(pending) {
  return /deploy|update/i.test(String(pending?.reason || ""));
}
