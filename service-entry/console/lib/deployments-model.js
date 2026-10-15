// The pure parts of the Deployments pages (07 §6.2): the list rows, the
// filters, the lifecycle steps, the metrics tiles, the endpoints, the wake
// refusals, the exact routing request bodies and the log-append rule. They
// take API payloads and return plain data, so Node tests drive them with the
// real i18n and formatters; routes/deployments*.js and
// routes/deployment-detail.js only render them.

import { tk } from "./i18n.js";
import { fleetInstanceLifecycle } from "./readiness.js";

/** 00 §4.1 lifecycle phases in launch order. */
export const PHASES = Object.freeze(["pull", "admission", "container", "weights", "kv", "graphs", "api", "probe", "ready"]);
/** The fleet modes the classic console offered (POST /api/fleet/settings {mode}). */
export const FLEET_MODES = Object.freeze(["balanced", "throughput", "multimodal"]);
/** The capabilities a route preview can ask for. */
export const PREVIEW_CAPABILITIES = Object.freeze(["text", "vision", "audio", "embedding", "rerank", "tools"]);
export const STATE_IDS = Object.freeze(["ready", "loading", "degraded", "crashed", "stopped", "sleeping"]);
export const STATE_STATUS = Object.freeze({ ready: "ok", loading: "loading", degraded: "warn", crashed: "error", stopped: "neutral", sleeping: "info" });
/** The detail page's tabs in order (07 §6.2). */
export const DETAIL_TABS = Object.freeze(["overview", "metrics", "logs", "config", "requests", "events"]);
/** Bounds of the VRAM policy form, as the classic console's inputs had them. */
export const POLICY_LIMITS = Object.freeze({ pctMin: 10, pctMax: 99, reserveMin: 0, reserveMax: 256 });
/** The last lines compared when a reply repeats what the buffer already ends with. */
export const LOG_DEDUPE_LINES = 200;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(n) ? n : null;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function list(value, ...keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

// ---------------------------------------------------------------------------
// Ids

/** `vllm:primary` → { managerId: "vllm", instanceId: "primary" } (00 §3 fleetId). */
export function splitFleetId(fleetId) {
  const id = String(fleetId ?? "");
  const colon = id.indexOf(":");
  return colon > 0 ? { managerId: id.slice(0, colon), instanceId: id.slice(colon + 1) } : { managerId: "", instanceId: id };
}

function idsOf(instance, fallbackManager = "") {
  const id = String(instance?.instanceId ?? instance?.id ?? "");
  const colon = id.indexOf(":");
  const managerId = String(instance?.managerId || instance?.manager_engine || fallbackManager || instance?.engine || (colon > 0 ? id.slice(0, colon) : "") || "");
  const instanceId = colon > 0 ? id.slice(colon + 1) : id;
  return { managerId, instanceId, fleetId: String(instance?.fleetId || (managerId ? `${managerId}:${instanceId}` : instanceId)) };
}

// ---------------------------------------------------------------------------
// List rows

function isSleepingInstance(item) {
  return Boolean(text(item?.sleep?.id)) || item?.status === "sleeping" || item?.lifecycle?.state === "sleeping";
}

function modelsOf(...sources) {
  for (const source of sources) {
    const models = list(source, "models").filter((model) => model && typeof model === "object" && model.id);
    if (models.length) return models;
  }
  return [];
}

function contextOf(instance, models) {
  const first = models[0] || {};
  return finite(first.contextLength ?? first.maxModelLen ?? first.max_model_len ?? first.context_length ?? first.contextWindow)
    ?? finite(instance?.capabilities?.maxContext);
}

function runtimeVersion(instance) {
  const direct = text(instance?.runtime?.version);
  if (direct) return direct;
  const id = text(instance?.runtime?.id) || text(instance?.runtimeId);
  const at = id.indexOf("@");
  return at > 0 ? id.slice(at + 1) : "";
}

function stateOf(fleetItem, managerItem) {
  if (isSleepingInstance(managerItem) || isSleepingInstance(fleetItem)) return "sleeping";
  const lifecycleState = managerItem?.lifecycle?.state;
  if (lifecycleState === "crashed" || lifecycleState === "loading") return lifecycleState;
  return fleetInstanceLifecycle({ ...fleetItem, ...managerItem }).key;
}

function gpusOf(instance) {
  return (Array.isArray(instance?.gpuIds) ? instance.gpuIds : []).map(String).filter(Boolean);
}

function rowOf({ fleetItem, managerItem, ids, live, requests, now }) {
  const merged = { ...fleetItem, ...managerItem };
  const models = modelsOf(fleetItem, managerItem);
  const state = stateOf(fleetItem, managerItem);
  const lifecycle = isPlainObject(managerItem?.lifecycle) ? managerItem.lifecycle : isPlainObject(fleetItem?.lifecycle) ? fleetItem.lifecycle : {};
  const version = runtimeVersion(merged);
  const engineId = text(merged.engineId) || text(merged.engineFamily) || ids.managerId || "";
  const since = Date.parse(lifecycle.since);
  const liveItem = live.get(ids.fleetId);
  const percent = state === "loading" ? finite(lifecycle.percent) : null;
  return {
    key: ids.fleetId,
    ...ids,
    state,
    percent,
    phase: text(lifecycle.phase) || null,
    model: String(models[0]?.id || merged.containerName || ids.instanceId),
    extraModels: Math.max(0, models.length - 1),
    engineId,
    engine: `${engineId || "—"}${version ? `@${version}` : ""}`,
    recipeId: text(merged.recipeId) || null,
    launchId: text(merged.launchId) || null,
    port: finite(merged.port),
    context: contextOf(merged, models),
    vramMb: finite(merged.vramReservationMb) ?? finite(liveItem?.vramReservationMb),
    gpus: gpusOf(merged),
    tps: finite(liveItem?.outputTps),
    requests1h: requests.has(ids.fleetId) ? requests.get(ids.fleetId) : null,
    uptimeMs: state === "ready" && Number.isFinite(since) ? Math.max(0, now - since) : null,
    sleepId: null,
    instance: merged,
  };
}

function sleepingRowOf(item, managerId, now) {
  const sleepId = text(item?.sleep?.id) || text(item?.id);
  const models = modelsOf(item);
  const sleptAt = Date.parse(item?.sleep?.since ?? item?.sleptAt ?? item?.lifecycle?.since);
  const version = runtimeVersion(item);
  const engineId = text(item.engineId) || text(item.engineFamily) || text(item.engine) || managerId;
  return {
    key: `${managerId}:${sleepId}`,
    managerId,
    instanceId: sleepId,
    fleetId: `${managerId}:${sleepId}`,
    state: "sleeping",
    percent: null,
    phase: null,
    model: String(models[0]?.id || item.model || item.name || sleepId),
    extraModels: 0,
    engineId,
    engine: `${engineId || "—"}${version ? `@${version}` : ""}`,
    recipeId: text(item.recipeId) || null,
    launchId: text(item.launchId) || null,
    port: finite(item.port),
    context: contextOf(item, models),
    vramMb: finite(item.vramReservationMb ?? item.vramMb),
    gpus: gpusOf(item),
    tps: null,
    requests1h: null,
    uptimeMs: null,
    sleepId,
    sleptAt: Number.isFinite(sleptAt) ? new Date(sleptAt).toISOString() : null,
    sleptForMs: Number.isFinite(sleptAt) ? Math.max(0, now - sleptAt) : null,
    wakeable: item?.sleep?.wakeable !== false && item?.hasConfig !== false,
    instance: item,
  };
}

/**
 * The Deployments list: one row per instance of the fleet, merged with the
 * managers' typed instances, and one sleeping row per sleeping record.
 * @param inputs.fleet GET /api/fleet
 * @param inputs.managers [{ managerId, instances?, idle? }]: GET /api/m/:id/instances?include=sleeping, and GET /api/m/:id/idle-unload before 01
 * @param inputs.live GET /api/telemetry/live (outputTps, vramReservationMb per fleetId)
 * @param inputs.requests Map fleetId → requests in the last hour (04 breakdown)
 * @returns {{ rows: object[], sleeping: object[] }}
 */
export function buildDeployments({ fleet = null, managers = [], live = null, requests = null, now = Date.now() } = {}) {
  const liveBy = new Map(list(live, "instances").filter((item) => item?.fleetId).map((item) => [item.fleetId, item]));
  const requestsBy = requests instanceof Map ? requests : new Map();
  const entries = new Map();
  for (const item of list(fleet, "instances")) {
    if (!isPlainObject(item)) continue;
    const ids = idsOf(item);
    entries.set(ids.fleetId, { fleetItem: item, managerItem: null, ids });
  }
  const sleeping = [];
  const sleepSeen = new Set();
  for (const entry of managers) {
    const managerId = String(entry?.managerId || "");
    for (const item of list(entry?.instances, "instances")) {
      if (!isPlainObject(item)) continue;
      if (isSleepingInstance(item)) {
        const row = sleepingRowOf(item, managerId, now);
        sleeping.push(row);
        sleepSeen.add(row.key);
        continue;
      }
      const ids = idsOf(item, managerId);
      const key = ids.fleetId;
      const current = entries.get(key);
      entries.set(key, { fleetItem: current?.fleetItem || null, managerItem: item, ids: current?.ids || ids });
    }
    for (const record of list(entry?.idle, "sleeping")) {
      if (!isPlainObject(record)) continue;
      const row = sleepingRowOf(record, managerId, now);
      if (!sleepSeen.has(row.key)) sleeping.push(row);
    }
  }
  const rows = [...entries.values()].map(({ fleetItem, managerItem, ids }) => rowOf({ fleetItem, managerItem, ids, live: liveBy, requests: requestsBy, now }));
  return { rows, sleeping };
}

/** fleetId → requests from a 04 breakdown reply (`dim=fleet`). */
export function requestsByFleet(breakdown) {
  const map = new Map();
  for (const row of list(breakdown, "rows")) {
    const key = text(row?.key);
    const requests = finite(row?.requests);
    if (key && requests !== null) map.set(key, requests);
  }
  return map;
}

/** Rows that pass the engine, manager and state filters ("" or "all" lets everything through). */
export function filterRows(rows, { engine = "", manager = "", state = "" } = {}) {
  const pass = (value, wanted) => !wanted || wanted === "all" || value === wanted;
  return rows.filter((row) => pass(row.engineId, engine) && pass(row.managerId, manager) && pass(row.state, state));
}

/** The values the filter selects offer, sorted. */
export function filterOptions(rows, managers = []) {
  const engines = [...new Set(rows.map((row) => row.engineId).filter(Boolean))].sort();
  const known = managers.map((item) => item?.id).filter(Boolean);
  const managerIds = [...new Set([...known, ...rows.map((row) => row.managerId).filter(Boolean)])];
  const states = STATE_IDS.filter((id) => rows.some((row) => row.state === id));
  return { engines, managers: managerIds, states };
}

/** A filter value from the URL, only when it is one the list can show. */
export function cleanFilter(value, allowed) {
  const wanted = text(value);
  return wanted && allowed.includes(wanted) ? wanted : "";
}

// ---------------------------------------------------------------------------
// Detail: lifecycle, endpoints, capabilities, memory

/**
 * The Stepper steps of an instance (00 §4.1 phases). Durations come from
 * `lifecycle.phaseHistory` when present. Without a history there is nothing
 * to show for a ready instance, so the result is empty.
 * @returns {Array<{ id, state, durationMs?, at? }>}
 */
export function lifecycleSteps(instance) {
  const lifecycle = isPlainObject(instance?.lifecycle) ? instance.lifecycle : {};
  const history = list(lifecycle, "phaseHistory").filter((entry) => isPlainObject(entry) && PHASES.includes(entry.phase));
  const state = text(lifecycle.state);
  if (!history.length && state !== "loading") return [];
  const seen = new Map(history.map((entry) => [entry.phase, entry]));
  const current = PHASES.indexOf(text(lifecycle.phase));
  const last = history.length ? PHASES.indexOf(history[history.length - 1].phase) : -1;
  return PHASES.map((id, index) => {
    const entry = seen.get(id);
    const durationMs = finite(entry?.durationMs);
    const base = { id, ...(durationMs !== null ? { durationMs } : {}), ...(entry?.at ? { at: entry.at } : {}) };
    if (state === "loading") {
      if (current >= 0 && index === current) return { ...base, state: "active" };
      if (current >= 0 && index > current) return { ...base, state: "pending" };
      if (current < 0 && !entry) return { ...base, state: "pending" };
      return { ...base, state: entry ? "done" : "skipped" };
    }
    if (state === "crashed") {
      if (entry && index === last) return { ...base, state: "error" };
      return { ...base, state: entry ? "done" : index < last ? "skipped" : "pending" };
    }
    if (state === "ready") return { ...base, state: entry ? "done" : index < last ? "skipped" : index === PHASES.length - 1 ? "done" : "skipped" };
    return { ...base, state: entry ? "done" : "pending" };
  });
}

/**
 * Local, LAN and gateway endpoints of an instance (07 §6.2). A missing URL is
 * left out; the gateway URL is host-relative to `origin`.
 * @returns {Array<{ id: "local"|"lan"|"gateway"|"auto", url }>}
 */
export function endpointsOf(instance, { managerId = "", origin = "", autoPath = "" } = {}) {
  const out = [];
  const local = text(instance?.localBaseUrl);
  const lan = text(instance?.lanBaseUrl);
  if (local) out.push({ id: "local", url: local });
  if (lan) out.push({ id: "lan", url: lan });
  if (managerId && origin) out.push({ id: "gateway", url: `${origin}/gateway/${encodeURIComponent(managerId)}/openai/v1` });
  if (autoPath && origin) out.push({ id: "auto", url: `${origin}${autoPath}` });
  return out;
}

const CAPABILITY_ORDER = Object.freeze(["text", "vision", "audio", "embedding", "rerank", "tools", "reasoning"]);

/** The capability ids an instance declares: 00 §4.1 `capabilities`, else its models' capability lists. */
export function capabilityIds(instance) {
  const declared = isPlainObject(instance?.capabilities) ? instance.capabilities : null;
  const found = new Set();
  if (declared) for (const id of CAPABILITY_ORDER) if (declared[id] === true) found.add(id);
  if (!found.size) {
    for (const model of list(instance, "models")) {
      for (const id of Array.isArray(model?.capabilities) ? model.capabilities : []) if (CAPABILITY_ORDER.includes(id)) found.add(id);
    }
  }
  return CAPABILITY_ORDER.filter((id) => found.has(id));
}

/**
 * The inputs of the GpuMemoryBar for one deployment: its reservation as one
 * segment, everything else on the GPU as other tenants.
 * @returns {{ gpu, segments, otherTenantsMb, admissionMb } | null}
 */
export function memoryOf(row, fleet, launch = null, label = undefined) {
  const total = finite(fleet?.gpuMemory?.totalMb);
  const reserved = finite(row?.vramMb);
  if (total === null || total <= 0) return null;
  const used = finite(fleet?.gpuMemory?.usedMb);
  const own = reserved ?? 0;
  return {
    gpu: { id: row?.gpus?.join(",") || "gpu", name: undefined, totalMb: total },
    segments: own > 0 ? [{ kind: "deployment", mb: own, label }] : [],
    otherTenantsMb: used === null ? 0 : Math.max(0, used - own),
    admissionMb: finite(launch?.resolved?.memory?.admissionRequestMb),
  };
}

// ---------------------------------------------------------------------------
// Metrics tiles

const FAMILY_OF = Object.freeze({ kvUsageRatio: "gauges", requestsRunning: "gauges", requestsWaiting: "gauges", ttftSeconds: "histograms" });

function unsupportedHas(unsupported, key) {
  const family = FAMILY_OF[key];
  return list(unsupported).some((path) => path === key || (family && path === `${family}.${key}`));
}

/**
 * The Metrics tab tiles (07 §6.2, §3.9). A key in `unsupported[]` is "not
 * reported"; a key that is just absent is "—". Neither is ever 0.
 * @param response GET /api/m/:id/instances/:iid/metrics
 * @returns {Array<{ id, label, value, unit, note, span, state: "value"|"unsupported"|"missing" }>}
 */
export function metricsTiles(response, { t, fmt }) {
  const metrics = isPlainObject(response?.metrics) ? response.metrics : null;
  const noSample = response?.scrapeOk === false || !metrics;
  const histogram = (key) => (isPlainObject(metrics?.[key]) ? metrics[key] : null);
  const seconds = (value) => finite(value);
  const defs = [
    { id: "kv", key: "kvUsageRatio", span: "now", read: () => finite(metrics?.kvUsageRatio), show: (v) => fmt.percent(v, 1), unit: "" },
    { id: "running", key: "requestsRunning", span: "now", read: () => finite(metrics?.requestsRunning), show: (v) => fmt.integer(v), unit: "" },
    { id: "waiting", key: "requestsWaiting", span: "now", read: () => finite(metrics?.requestsWaiting), show: (v) => fmt.integer(v), unit: "" },
    { id: "ttftP50", key: "ttftSeconds", span: "sinceStart", read: () => seconds(histogram("ttftSeconds")?.p50), show: (v) => fmt.integer(Math.round(v * 1000)), unit: "ms", count: () => finite(histogram("ttftSeconds")?.count) },
    { id: "ttftP95", key: "ttftSeconds", span: "sinceStart", read: () => seconds(histogram("ttftSeconds")?.p95), show: (v) => fmt.integer(Math.round(v * 1000)), unit: "ms", count: () => finite(histogram("ttftSeconds")?.count) },
  ];
  return defs.map((def) => {
    const label = t(tk("deploy.metrics.tile.", def.id));
    const span = t(tk("deploy.metrics.span.", def.span));
    if (unsupportedHas(response?.unsupported, def.key)) {
      return { id: def.id, label, value: null, unit: "", note: t("deploy.metrics.unsupported"), span, state: "unsupported" };
    }
    const value = noSample ? null : def.read();
    if (value === null) {
      return { id: def.id, label, value: null, unit: "", note: noSample ? t("deploy.metrics.noSample") : t("deploy.metrics.missing"), span, state: "missing" };
    }
    const count = def.count ? def.count() : null;
    return { id: def.id, label, value: def.show(value), unit: def.unit, note: count !== null ? t("deploy.metrics.requests", { count: fmt.integer(count) }) : "", span, state: "value" };
  });
}

/** The key facts of the Overview tab from the metrics `facts` object: [{ id, value }] for the facts that are numbers or text. */
export function factsOf(response) {
  const facts = isPlainObject(response?.facts) ? response.facts : {};
  return Object.entries(facts)
    .filter(([, value]) => (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value))
    .map(([id, value]) => ({ id, value }));
}

/**
 * Telemetry series for TimeSeriesChart: `points` [[ms, value]] per series
 * become one shared x axis (epoch seconds) with null gaps.
 * @returns {{ x: number[], series: Array<{ id, label, unit, values }> }}
 */
export function chartSeries(response, labelOf = (item) => item.metric) {
  const items = list(response, "series").filter((item) => isPlainObject(item) && Array.isArray(item.points));
  const stamps = new Set();
  for (const item of items) for (const point of item.points) if (Array.isArray(point) && Number.isFinite(Number(point[0]))) stamps.add(Number(point[0]));
  const axis = [...stamps].sort((a, b) => a - b);
  const series = items.map((item) => {
    const byStamp = new Map(item.points.filter(Array.isArray).map((point) => [Number(point[0]), finite(point[1])]));
    return { id: item.metric, label: labelOf(item), unit: text(item.unit), values: axis.map((stamp) => (byStamp.has(stamp) ? byStamp.get(stamp) : null)) };
  });
  return { x: axis.map((stamp) => Math.round(stamp / 1000)), series };
}

// ---------------------------------------------------------------------------
// Wake

/**
 * What a failed wake means (08 P0-RT-2): `replace` asks first, `key` points at
 * Relaunch, anything else is an ordinary error.
 * @returns {{ kind: "replace"|"key"|"other", model: string }}
 */
export function wakeProblem(error) {
  const code = error?.code;
  if (error?.status === 409 && code === "wake_would_replace_running") return { kind: "replace", model: text(error?.details?.runningModel) };
  if (error?.status === 409 && code === "wake_api_key_missing") return { kind: "key", model: "" };
  return { kind: "other", model: "" };
}

/** The request path of a wake: the sleep record id (`slp_…`), never the instance id. */
export function wakePath(managerId, sleepId) {
  return `/api/m/${encodeURIComponent(managerId)}/idle-unload/${encodeURIComponent(sleepId)}/wake`;
}

/** The page that reviews a relaunch of a deployment; the wizard's Review step does the launching (07 §6.2). */
export function relaunchHref({ managerId, launchId, instanceId }) {
  const params = new URLSearchParams();
  if (launchId) params.set("clone", launchId);
  params.set("manager", managerId);
  params.set("step", "review");
  params.set("from", "relaunch");
  if (instanceId) params.set("instance", instanceId);
  return `/deployments/new?${params.toString()}`;
}

/** `Clone as new` opens the wizard on the stored launch (07 §6.3 quick paths). */
export function cloneHref({ managerId, launchId }) {
  const params = new URLSearchParams();
  if (launchId) params.set("clone", launchId);
  params.set("manager", managerId);
  return `/deployments/new?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Routing (the old fleet behaviour and request bodies, exactly)

/** The `POST /api/fleet/settings` body of a mode button. */
export function modeBody(mode) {
  return FLEET_MODES.includes(mode) ? { mode } : null;
}

/**
 * The `POST /api/fleet/settings` body of the VRAM policy form, or null when a
 * value is out of range. The reserve is entered in GiB and sent in MiB.
 */
export function policyBody({ maxUtilizationPct, reserveGiB }) {
  const pct = finite(maxUtilizationPct);
  const reserve = finite(reserveGiB);
  if (pct === null || reserve === null) return null;
  if (pct < POLICY_LIMITS.pctMin || pct > POLICY_LIMITS.pctMax || reserve < POLICY_LIMITS.reserveMin || reserve > POLICY_LIMITS.reserveMax) return null;
  return { maxUtilizationPct: pct, reserveMb: Math.round(reserve * 1024) };
}

/** The `POST /api/fleet/route-preview` body: capability, engine, protocol and an optional model name. Never message content. */
export function previewBody({ capability, model }) {
  const name = text(model);
  return { capability: PREVIEW_CAPABILITIES.includes(capability) ? capability : "text", engine: "auto", protocol: "openai", ...(name ? { model: name } : {}) };
}

/** "16.7 GiB" from MiB with the active formatters; a dash for no figure. */
export function gibText(fmt, mb) {
  const n = finite(mb);
  return n === null ? "—" : fmt.bytes(n * 1024 * 1024, { unit: "GiB" });
}

/** GiB with one fraction digit from MiB, as the policy input shows it. */
export function gibOfMb(mb) {
  const n = finite(mb);
  return n === null ? "" : String(Math.round((n / 1024) * 10) / 10);
}

/**
 * A route-preview reply as the page shows it: routable with its target, or
 * not routable with the server's code and reason. The entry answers 200 with
 * `ok:false`; an ApiError (a proxy in between) is read the same way.
 * @returns {{ ok: true, model, manager, instance, capability, reason, policy } | { ok: false, code, message, capability }}
 */
export function previewOutcome(result, { capability = "" } = {}) {
  if (result instanceof Error) {
    const details = isPlainObject(result.details) ? result.details : {};
    const code = text(result.code).startsWith("http_") ? text(result.message) : text(result.code);
    return { ok: false, code: code || "unknown_error", message: text(details.reason) || text(details.message) || text(result.message), capability: text(details.capability) || capability };
  }
  const body = isPlainObject(result) ? result : {};
  if (body.ok === true && isPlainObject(body.manager) && isPlainObject(body.instance) && isPlainObject(body.model)) {
    return {
      ok: true,
      model: String(body.model.id || ""),
      manager: String(body.manager.name || body.manager.id || ""),
      instance: String(body.instance.instanceId || body.instance.id || ""),
      capability: text(body.capability) || capability,
      reason: text(body.reason),
      policy: text(body.policy?.mode),
    };
  }
  return {
    ok: false,
    code: text(body.error) || (body.status ? `HTTP ${body.status}` : "no_route"),
    message: text(body.message) || text(body.reason),
    capability: text(body.capability) || capability,
  };
}

/** The model names the preview input suggests: every model id of the fleet, once. */
export function previewModels(fleet) {
  const names = new Set();
  for (const instance of list(fleet, "instances")) for (const model of list(instance, "models")) if (model?.id) names.add(String(model.id));
  return [...names];
}

/**
 * The GPU memory figures of the fleet snapshot, with the headroom inside the
 * protect line (the VRAM policy's max utilization) next to what the API says
 * can be allocated. The recommendation is the smaller of the two.
 * @returns {{ totalMb, usedMb, freeMb, reserveMb, allocatableMb, protectPct, protectHeadroomMb, recommendedMb } | null}
 */
export function gpuHeadroom(fleet) {
  const memory = isPlainObject(fleet?.gpuMemory) ? fleet.gpuMemory : null;
  const totalMb = finite(memory?.totalMb);
  if (!memory || totalMb === null) return null;
  const usedMb = finite(memory.usedMb);
  const protectPct = finite(fleet?.settings?.maxUtilizationPct ?? memory.warningThresholdPct);
  const allocatableMb = finite(memory.allocatableMb ?? memory.availableMb);
  const protectHeadroomMb = usedMb !== null && protectPct !== null ? Math.max(0, Math.floor((totalMb * protectPct) / 100) - usedMb) : null;
  const candidates = [allocatableMb, protectHeadroomMb].filter((value) => value !== null);
  return {
    totalMb,
    usedMb,
    freeMb: finite(memory.freeMb) ?? (usedMb === null ? null : Math.max(0, totalMb - usedMb)),
    reserveMb: finite(memory.reserveMb ?? fleet?.settings?.reserveMb),
    allocatableMb,
    protectPct,
    protectHeadroomMb,
    recommendedMb: candidates.length ? Math.min(...candidates) : null,
  };
}

/** How many fleet instances can take traffic: { routable, other, total }. */
export function routableCounts(fleet) {
  const instances = list(fleet, "instances").filter(isPlainObject);
  const routable = instances.filter((item) => fleetInstanceLifecycle(item).routable).length;
  return { routable, other: instances.length - routable, total: instances.length };
}

// ---------------------------------------------------------------------------
// Logs

/**
 * Appends a log poll to what is shown without repeating lines (07 §3.9). The
 * poll asks for `since` the previous poll started, so a reply normally holds
 * only new lines; a reply that starts by repeating the end of the buffer (the
 * boundary line, or a manager that ignores `since`) has that repeat dropped.
 * A single repeated line is kept: engines print identical health lines.
 * @returns {string[]} the lines to append
 */
export function newLogLines(existing, incoming, { maxCompare = LOG_DEDUPE_LINES } = {}) {
  const have = Array.isArray(existing) ? existing : [];
  const next = Array.isArray(incoming) ? incoming : [];
  const limit = Math.min(maxCompare, have.length, next.length);
  for (let size = limit; size >= 2; size -= 1) {
    let same = true;
    for (let index = 0; index < size; index += 1) {
      if (have[have.length - size + index] !== next[index]) {
        same = false;
        break;
      }
    }
    if (same) return next.slice(size);
  }
  return next;
}

/** The lines of a manager's log reply, newest last. */
export function logLinesOf(payload) {
  const raw = isPlainObject(payload) ? payload.text ?? payload.lines ?? payload.logs ?? "" : payload;
  const lines = Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// Recent launches and profiles

/** The entries of a recent-launches reply as { key, model, name, launchedAt, launchId? }. */
export function recentEntries(data) {
  return list(data, "launches", "items").filter(isPlainObject).map((item, index) => ({
    key: item.launchId || `${item.model || "launch"}::${item.name || index}`,
    launchId: text(item.launchId) || null,
    model: String(item.name || item.model || ""),
    path: String(item.model || ""),
    launchedAt: text(item.launchedAt) || null,
  })).filter((item) => item.model);
}

/** The profiles of a tools/profiles reply (user profiles first, then built-in ones) as { id, name, builtin }. */
export function profileEntries(data) {
  const pick = (value) => (typeof value === "string" ? value : isPlainObject(value) ? text(value["zh-CN"]) || text(value.zh) || text(value.en) : "");
  const mapped = (items, builtin) => list(items).filter(isPlainObject).map((item) => ({
    id: String(item.id || ""), name: pick(item.name) || pick(item.label) || String(item.id || ""), builtin,
  })).filter((item) => item.id);
  return [...mapped(data?.profiles, false), ...mapped(data?.builtin, true)];
}
