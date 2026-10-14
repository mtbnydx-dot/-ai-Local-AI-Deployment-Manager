// The five 06 readiness layers derived from /api/status and /api/fleet
// (07 §4.4 StatusStrip), used until 06's GET /api/platform/status exists.
//
// The result has the 06 §5.15 `readiness` shape, so the StatusStrip renders
// one model either way. Serving counts instances with the classic console's
// `isFleetRoutableInstance` rule (index.html), so overall green still needs
// at least one serving model. Layer text comes from the `platform` area
// (`platform.layer.*`, `platform.serving.none`); this module returns codes.

export const LAYER_IDS = Object.freeze(["environment", "runtime", "components", "serving", "exposure"]);

const CRASHED = /crash|failed|failure|\berror\b|\bdead\b|out[ -]?of[ -]?memory|\boom\b/;
const CRASHED_EXIT = /exited\s*\(\s*(?!0\s*\))\d+\s*\)/;
const LOADING = /loading|starting|pending|initializ|warming|restarting|creat/;
const DEGRADED = /degraded|unhealthy|health:?[ -]?fail/;
const RUNNING_WORD = /(^|\s)(ready|running|healthy|serving)(\s|$)/;

/**
 * The classic console's lifecycle reading of one fleet instance
 * (`fleetInstanceLifecycle`, service-entry/index.html), without the copy.
 * @returns {{ key: "crashed"|"loading"|"degraded"|"stopped"|"ready", routable: boolean }}
 */
export function fleetInstanceLifecycle(instance = {}) {
  const lifecycleState = String(instance?.lifecycleState || instance?.state || "").trim();
  const rawStatus = String(instance?.status || instance?.container?.status || lifecycleState || "").trim();
  const stateText = `${lifecycleState} ${rawStatus}`.toLowerCase();
  const models = Array.isArray(instance?.models) ? instance.models.filter((model) => model?.id) : [];
  const explicitlyRunning = instance?.running === true
    || RUNNING_WORD.test(lifecycleState.toLowerCase())
    || RUNNING_WORD.test(rawStatus.toLowerCase())
    || /(^|\s)up(?:\s|$)/.test(rawStatus.toLowerCase());
  if (CRASHED.test(stateText) || CRASHED_EXIT.test(stateText)) return { key: "crashed", routable: false };
  if (LOADING.test(stateText)) return { key: "loading", routable: false };
  if (DEGRADED.test(stateText)) return { key: "degraded", routable: false };
  if (!explicitlyRunning || /stopped|exited\s*\(\s*0\s*\)/.test(stateText)) return { key: "stopped", routable: false };
  if (!models.length) return { key: "degraded", routable: false };
  return { key: "ready", routable: true };
}

export function isFleetRoutableInstance(instance) {
  return fleetInstanceLifecycle(instance).routable;
}

function layer(id, status, extra = {}) {
  return { id, status, ...extra };
}

/**
 * @param status GET /api/status, or null when the entry did not answer
 * @param fleet GET /api/fleet, or null
 * @returns {{ overall: "ok"|"degraded"|"down", layers: Array<{ id, status, code?, mode?, counts? }>, serving: number, source: "derived" }}
 */
export function deriveReadiness({ status = null, fleet = null } = {}) {
  if (!status || status.ok !== true) {
    return {
      overall: "down",
      layers: LAYER_IDS.map((id) => layer(id, id === "environment" ? "fail" : "unknown", id === "environment" ? { code: "entry_unreachable" } : {})),
      serving: 0,
      source: "derived",
    };
  }
  const layers = [layer("environment", "ok")];

  const managers = Array.isArray(status.managers) ? status.managers : [];
  const healthyManagers = managers.filter((manager) => manager?.ok === true).length;
  layers.push(managers.length && !healthyManagers
    ? layer("runtime", "warn", { code: "managers_unreachable", counts: { ready: 0, total: managers.length } })
    : layer("runtime", "ok", { counts: { ready: healthyManagers, total: managers.length } }));

  const components = status.components || {};
  const total = Number.isInteger(components.total) ? components.total : (Array.isArray(components.items) ? components.items.length : 0);
  const offline = Array.isArray(components.offline) ? components.offline.length : 0;
  const unhealthy = Array.isArray(components.unhealthy) ? components.unhealthy.length : 0;
  const ready = Math.max(0, total - offline - unhealthy);
  let componentStatus = "ok";
  if (total && offline >= total) componentStatus = "fail";
  else if (offline || unhealthy) componentStatus = "warn";
  layers.push(layer("components", componentStatus, {
    counts: { ready, total },
    ...(componentStatus === "ok" ? {} : { code: "components_offline", offline: [...(components.offline || [])] }),
  }));

  const instances = Array.isArray(fleet?.instances) ? fleet.instances : [];
  const serving = instances.filter(isFleetRoutableInstance).length;
  if (!fleet) layers.push(layer("serving", "unknown", { code: "fleet_unavailable" }));
  else layers.push(serving ? layer("serving", "ok", { counts: { ready: serving, total: instances.length } }) : layer("serving", "warn", { code: "no_model_serving", counts: { ready: 0, total: instances.length } }));

  const security = status.security || {};
  const mode = security.exposure === "public" || security.exposure === "lan" ? security.exposure : "local";
  const keys = Array.isArray(security.keyStore?.managersWithKeys) ? security.keyStore.managersWithKeys.length : 0;
  layers.push(mode !== "local" && !keys
    ? layer("exposure", "fail", { mode, code: "no_active_key" })
    : layer("exposure", "ok", { mode }));

  const overall = layers.some((item) => item.status === "warn" || item.status === "fail" || item.status === "unknown") ? "degraded" : "ok";
  return { overall, layers, serving, source: "derived" };
}

/**
 * The readiness to show: 06's PlatformStatus when present, else the derived one.
 * @returns the 06 `readiness` object plus `source: "platform"|"derived"`
 */
export function readinessFrom({ platform = null, status = null, fleet = null } = {}) {
  if (platform?.readiness && Array.isArray(platform.readiness.layers)) {
    return { ...platform.readiness, source: "platform" };
  }
  return deriveReadiness({ status, fleet });
}
