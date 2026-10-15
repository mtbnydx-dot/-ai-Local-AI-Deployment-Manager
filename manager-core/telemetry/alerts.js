"use strict";

// Alert engine (docs/overhaul/04-telemetry.md §13.1, §13.2, §13.4).
//
// Two halves live in this file:
//
// - The engine (createAlertEngine) runs in the entry. Every 15 s it reads the
//   enabled rules, measures each rule's metric per scope key, drives the
//   state machine of every (rule, scopeKey), writes alert.* events and hands
//   the notifier (notify.js) what to say. It never runs SQL itself.
// - WORKER_CALLS run inside the store worker through store.call(), next to
//   the DatabaseSync handle (the same pattern as importers.js): seeding, rule
//   and state persistence, the alert list and the SQL-backed metric
//   measurements. Names are never interpolated into SQL; a metric id selects a
//   fixed query.
//
// Metrics are a closed catalog (ALERT_METRICS); there is no user SQL. SQL
// metrics (requests, runtime and GPU samples, events) are measured in the
// worker. Metrics that need live process state (instance and manager health,
// disk space, the audit schedule, collector freshness) come from the `sources`
// the entry injects, so this module stays testable without a platform.
//
// State machine per (rule, scopeKey):
//   ok -> pending when the condition holds, pending -> firing once it has held
//   for for_s; firing -> ok when the value no longer satisfies the condition
//   against clear_threshold (default: threshold). Every transition to firing
//   or back to ok writes an alert.* event and calls notify; a firing alert
//   re-notifies every cooldown_s. Ack suppresses re-notifications, not the
//   resolution; silence suppresses notifications without touching the state.

const { ERROR_CLASSES } = require("./error-class");
const { maskAddress } = require("../auth-failure-guard");
const { redactSecrets } = require("../secret-redactor");

const DEFAULT_INTERVAL_MS = 15_000;
const MEMORY_REFRESH_MS = 60_000;
const SEED_STATE = "alerts.seed";
const SEED_VERSION = 1;
const MAX_CUSTOM_RULES = 50;
const MAX_SILENCE_MS = 30 * 86_400_000;
const FAILURES_BEFORE_DOWN = 3;
// A recorder that dropped rows since the last evaluation counts as stale for
// this many seconds, which is above any sensible telemetry_stale threshold.
const RECORDER_DROP_SECONDS = 3600;
const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 500;

const SEVERITIES = Object.freeze(["info", "warning", "critical"]);
const SEVERITY_RANK = Object.freeze({ info: 1, warning: 2, critical: 3 });
const CHANNELS = Object.freeze(["inapp", "toast", "webhook"]);
const OPS = Object.freeze([">", ">=", "<", "<="]);
const UPSTREAM_ERROR_CLASSES = Object.freeze(["upstream_5xx", "upstream_timeout", "upstream_unreachable", "stream_error"]);
const DEFAULT_ERROR_COUNT_CLASSES = Object.freeze([...UPSTREAM_ERROR_CLASSES, "internal"]);
const THROTTLE_HARDWARE = Object.freeze(["hw_slowdown", "hw_thermal", "hw_power_brake"]);
// Fields a builtin rule lets the owner change (§13.4).
const BUILTIN_EDITABLE = Object.freeze(["enabled", "threshold", "clearThreshold", "forS", "windowS", "severity", "channels", "cooldownS"]);
const RULE_FIELDS = Object.freeze([
  "enabled", "metric", "scope", "op", "threshold", "clearThreshold", "windowS", "forS", "minSamples",
  "severity", "channels", "cooldownS", "titleZh", "titleEn",
]);

// --- the metric catalog (§13.1) ------------------------------------------------------

function metric(id, unit, scopes, zh, en, source, filters = []) {
  return Object.freeze({ id, unit, scopes: Object.freeze(scopes), label: Object.freeze({ zh, en }), source, filters: Object.freeze(filters) });
}

const ALERT_METRICS = Object.freeze([
  metric("instance.down", "bool", ["fleet:<fleetId>"], "实例无响应", "Instance down", "memory", ["fleetId"]),
  metric("manager.down", "bool", ["manager:<id>"], "管理器无响应", "Manager down", "memory", ["managerId"]),
  metric("req.upstream_error_rate", "ratio", ["*", "fleet:*"], "上游错误率", "Upstream error rate", "sql", ["fleetId", "perFleet"]),
  metric("req.error_count", "count", ["*"], "指定错误数量", "Error count", "sql", ["errorClasses", "fleetId"]),
  metric("req.auth_failures", "count", ["*"], "认证失败次数", "Authentication failures", "sql"),
  metric("rt.waiting", "count", ["fleet:*"], "排队请求数", "Waiting requests", "sql", ["fleetId"]),
  metric("rt.kv_usage", "ratio", ["fleet:*"], "缓存占用率", "KV cache usage", "sql", ["fleetId"]),
  metric("gpu.temp_c", "celsius", ["gpu:<i>"], "GPU 温度", "GPU temperature", "sql", ["gpu"]),
  metric("gpu.power_ratio", "ratio", ["gpu:<i>"], "GPU 功耗占比", "GPU power ratio", "sql", ["gpu"]),
  metric("gpu.hw_throttle_share", "ratio", ["gpu:<i>"], "GPU 硬件降频占比", "GPU hardware throttle share", "sql", ["gpu"]),
  metric("disk.free_ratio", "ratio", ["disk:<root-label>"], "磁盘剩余比例", "Disk free ratio", "memory", ["root"]),
  metric("audit.export_failed", "bool", ["*"], "审计导出失败", "Audit export failed", "memory"),
  metric("audit.chain_risk", "bool", ["*"], "审计导出链风险", "Audit chain risk", "memory"),
  metric("billing.unavailable", "count", ["*"], "计费不可用次数", "Billing unavailable", "sql"),
  metric("telemetry.stale_seconds", "seconds", ["collector:<name>"], "采集停滞秒数", "Collector stale seconds", "memory", ["collector"]),
  metric("security.bans", "count", ["*"], "封禁次数", "Bans issued", "sql"),
]);
const METRIC_BY_ID = new Map(ALERT_METRICS.map((item) => [item.id, item]));

// --- default rules (§13.2) -----------------------------------------------------------

function defaultRule(ruleId, spec) {
  return Object.freeze({
    ruleId,
    builtin: true,
    enabled: true,
    scope: Object.freeze({}),
    clearThreshold: null,
    minSamples: 0,
    cooldownS: 1800,
    ...spec,
    channels: Object.freeze([...spec.channels]),
  });
}

// Titles carry {id} (the part of the scope key after the first colon), so one
// rule reads "GPU 0 温度过高 / GPU 0 temperature high" for gpu:0.
const DEFAULT_ALERT_RULES = Object.freeze([
  defaultRule("instance_down", { metric: "instance.down", op: ">=", threshold: 1, forS: 30, windowS: 30, severity: "critical", channels: ["inapp", "toast", "webhook"], titleZh: "实例 {id} 无响应", titleEn: "Instance {id} is down" }),
  defaultRule("manager_down", { metric: "manager.down", op: ">=", threshold: 1, forS: 60, windowS: 30, severity: "critical", channels: ["inapp", "toast", "webhook"], titleZh: "管理器 {id} 无响应", titleEn: "Manager {id} is down" }),
  defaultRule("upstream_errors", { metric: "req.upstream_error_rate", op: ">", threshold: 0.05, forS: 300, windowS: 300, minSamples: 20, severity: "warning", channels: ["inapp", "webhook"], titleZh: "上游错误率偏高", titleEn: "Upstream error rate is high" }),
  defaultRule("auth_storm", { metric: "req.auth_failures", op: ">", threshold: 30, forS: 0, windowS: 300, severity: "warning", channels: ["inapp", "toast"], titleZh: "认证失败次数激增", titleEn: "Authentication failures are surging" }),
  defaultRule("billing_unavailable", { metric: "billing.unavailable", op: ">", threshold: 0, forS: 0, windowS: 300, severity: "critical", channels: ["inapp", "toast", "webhook"], titleZh: "计费服务不可用", titleEn: "Billing is unavailable" }),
  defaultRule("queue_saturation", { metric: "rt.waiting", op: ">", threshold: 0, forS: 120, windowS: 120, severity: "warning", channels: ["inapp"], titleZh: "实例 {id} 请求排队", titleEn: "Requests are queuing on {id}" }),
  defaultRule("kv_saturation", { metric: "rt.kv_usage", op: ">", threshold: 0.95, forS: 300, windowS: 300, severity: "warning", channels: ["inapp"], titleZh: "实例 {id} 缓存接近占满", titleEn: "KV cache is nearly full on {id}" }),
  defaultRule("gpu_temp_high", { metric: "gpu.temp_c", op: ">", threshold: 85, forS: 120, windowS: 60, severity: "warning", channels: ["inapp", "toast"], titleZh: "GPU {id} 温度过高", titleEn: "GPU {id} temperature high" }),
  defaultRule("gpu_temp_critical", { metric: "gpu.temp_c", op: ">", threshold: 90, forS: 120, windowS: 60, severity: "critical", channels: ["inapp", "toast"], titleZh: "GPU {id} 温度严重过高", titleEn: "GPU {id} temperature critical" }),
  defaultRule("gpu_power_cap", { metric: "gpu.power_ratio", op: ">", threshold: 0.98, forS: 300, windowS: 300, severity: "info", channels: ["inapp"], titleZh: "GPU {id} 贴近功耗墙", titleEn: "GPU {id} is at its power cap" }),
  defaultRule("gpu_hw_throttle", { metric: "gpu.hw_throttle_share", op: ">", threshold: 0.5, forS: 60, windowS: 60, severity: "warning", channels: ["inapp"], titleZh: "GPU {id} 硬件降频", titleEn: "GPU {id} is throttled by hardware" }),
  defaultRule("disk_low", { metric: "disk.free_ratio", op: "<", threshold: 0.1, clearThreshold: 0.12, forS: 600, windowS: 60, severity: "warning", channels: ["inapp", "toast", "webhook"], titleZh: "磁盘 {id} 空间不足", titleEn: "Disk {id} is low on space" }),
  defaultRule("audit_export_failed", { metric: "audit.export_failed", op: ">=", threshold: 1, forS: 0, windowS: 60, severity: "warning", channels: ["inapp", "webhook"], titleZh: "审计导出失败", titleEn: "Audit export failed" }),
  defaultRule("audit_chain_risk", { metric: "audit.chain_risk", op: ">=", threshold: 1, forS: 0, windowS: 60, severity: "critical", channels: ["inapp", "toast"], titleZh: "审计导出链有风险", titleEn: "Audit export chain is at risk" }),
  defaultRule("telemetry_stale", { metric: "telemetry.stale_seconds", op: ">", threshold: 60, forS: 0, windowS: 60, severity: "warning", channels: ["inapp"], titleZh: "采集器 {id} 停止更新", titleEn: "Collector {id} stopped updating" }),
  defaultRule("ban_issued", { metric: "security.bans", op: ">", threshold: 0, forS: 0, windowS: 300, severity: "info", channels: ["inapp"], titleZh: "已封禁异常客户端地址", titleEn: "A client address was banned" }),
]);

// --- small helpers -------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isoOrNull(ms) {
  return finite(ms) ? new Date(ms).toISOString() : null;
}

function compare(value, op, threshold) {
  switch (op) {
    case ">": return value > threshold;
    case ">=": return value >= threshold;
    case "<": return value < threshold;
    case "<=": return value <= threshold;
    default: return false;
  }
}

function scopeParts(scopeKey) {
  const text = String(scopeKey || "*");
  const index = text.indexOf(":");
  return index < 0 ? { kind: text, id: "" } : { kind: text.slice(0, index), id: text.slice(index + 1) };
}

// A title that renders to nothing (only {id}, on a scope without one) falls
// back to `fallback`, so an event is never published with an empty title.
function renderTitle(template, scopeKey, fallback = "") {
  const parts = scopeParts(scopeKey);
  const text = String(template || "")
    .replace(/\{id\}/g, parts.id)
    .replace(/\{scope\}/g, String(scopeKey || "*"))
    .replace(/\s{2,}/g, " ")
    .trim();
  return text || String(fallback || "");
}

function alertLink(ruleId) {
  return `/#/observability/alerts?rule=${encodeURIComponent(String(ruleId))}`;
}

function fleetOf(scopeKey) {
  const parts = scopeParts(scopeKey);
  return parts.kind === "fleet" && parts.id ? parts.id : null;
}

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(String(text));
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function resultError(status, code, message, errors) {
  return { ok: false, status, code, message, ...(errors && errors.length ? { errors } : {}) };
}

// --- rule validation (§13.4) -----------------------------------------------------------

const STRING_FILTER = /^[A-Za-z0-9._:/@-]{1,128}$/;

function validateScope(metricId, scope, errors) {
  const info = METRIC_BY_ID.get(metricId);
  const out = {};
  if (scope === undefined || scope === null) return out;
  if (!isPlainObject(scope)) {
    errors.push({ field: "scope", code: "invalid_type", message: "scope must be an object." });
    return out;
  }
  const allowed = info ? info.filters : [];
  for (const [key, value] of Object.entries(scope)) {
    const field = `scope.${key}`;
    if (!allowed.includes(key)) {
      errors.push({ field, code: "unknown_key", message: `${metricId} does not take the scope filter ${key}.` });
    } else if (key === "errorClasses") {
      const valid = Array.isArray(value) && value.length > 0 && value.length <= ERROR_CLASSES.length
        && value.every((item) => typeof item === "string" && ERROR_CLASSES.includes(item) && item !== "none");
      if (!valid) errors.push({ field, code: "invalid_value", message: "errorClasses must list known error classes." });
      else out[key] = [...new Set(value)];
    } else if (key === "perFleet") {
      if (typeof value !== "boolean") errors.push({ field, code: "invalid_type", message: "perFleet must be true or false." });
      else out[key] = value;
    } else if (key === "gpu") {
      if (!Number.isInteger(value) || value < 0 || value > 63) errors.push({ field, code: "out_of_range", message: "gpu must be a GPU index." });
      else out[key] = value;
    } else if (typeof value !== "string" || !STRING_FILTER.test(value)) {
      errors.push({ field, code: "invalid_format", message: `${key} is not a valid identifier.` });
    } else {
      out[key] = value;
    }
  }
  return out;
}

function checkNumber(errors, field, value, { min, max, integer = false }) {
  if (!finite(value) || (integer && !Number.isInteger(value))) {
    errors.push({ field, code: "invalid_type", message: `${field} must be ${integer ? "an integer" : "a number"}.` });
    return false;
  }
  if (value < min || value > max) {
    errors.push({ field, code: "out_of_range", message: `${field} must be between ${min} and ${max}.` });
    return false;
  }
  return true;
}

function checkText(errors, field, value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
    errors.push({ field, code: "invalid_value", message: `${field} must be 1 to 120 characters.` });
    return false;
  }
  return true;
}

/**
 * validateRuleInput(input, { partial, builtin, current }) →
 *   { ok:true, rule } | { ok:false, errors:[{field, code, message}] }
 * Create (partial false) needs metric, op, threshold, windowS, forS, severity,
 * channels, titleZh and titleEn. An update (partial true) merges the supplied
 * fields over `current`; for a builtin rule only BUILTIN_EDITABLE may appear.
 */
function validateRuleInput(input, { partial = false, builtin = false, current = null } = {}) {
  const errors = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ field: "", code: "invalid_type", message: "The body must be a JSON object." }] };
  for (const key of Object.keys(input)) {
    if (!RULE_FIELDS.includes(key)) errors.push({ field: key, code: "unknown_key", message: `Unknown field ${key}.` });
    else if (builtin && !BUILTIN_EDITABLE.includes(key)) errors.push({ field: key, code: "not_editable", message: `${key} of a builtin rule cannot be changed.` });
  }
  const base = partial && current ? current : {};
  const merged = { ...base };
  for (const key of RULE_FIELDS) if (input[key] !== undefined) merged[key] = input[key];
  if (!partial) {
    for (const key of ["metric", "op", "threshold", "windowS", "forS", "severity", "channels", "titleZh", "titleEn"]) {
      if (merged[key] === undefined) errors.push({ field: key, code: "required", message: `${key} is required.` });
    }
  }
  const info = typeof merged.metric === "string" ? METRIC_BY_ID.get(merged.metric) : null;
  if (merged.metric !== undefined && !info) errors.push({ field: "metric", code: "unknown_metric", message: "Unknown metric." });
  if (merged.op !== undefined && !OPS.includes(merged.op)) errors.push({ field: "op", code: "invalid_value", message: "op must be one of > >= < <=." });
  if (merged.severity !== undefined && !SEVERITIES.includes(merged.severity)) errors.push({ field: "severity", code: "invalid_value", message: "severity must be info, warning or critical." });
  if (merged.enabled !== undefined && typeof merged.enabled !== "boolean") errors.push({ field: "enabled", code: "invalid_type", message: "enabled must be true or false." });
  if (merged.threshold !== undefined) checkNumber(errors, "threshold", merged.threshold, { min: -1e12, max: 1e12 });
  if (merged.clearThreshold !== undefined && merged.clearThreshold !== null) checkNumber(errors, "clearThreshold", merged.clearThreshold, { min: -1e12, max: 1e12 });
  if (merged.windowS !== undefined) checkNumber(errors, "windowS", merged.windowS, { min: 10, max: 86_400, integer: true });
  if (merged.forS !== undefined) checkNumber(errors, "forS", merged.forS, { min: 0, max: 86_400, integer: true });
  if (merged.minSamples !== undefined) checkNumber(errors, "minSamples", merged.minSamples, { min: 0, max: 1_000_000, integer: true });
  if (merged.cooldownS !== undefined) checkNumber(errors, "cooldownS", merged.cooldownS, { min: 60, max: 7 * 86_400, integer: true });
  if (merged.channels !== undefined) {
    const valid = Array.isArray(merged.channels) && merged.channels.length <= CHANNELS.length
      && merged.channels.every((item) => CHANNELS.includes(item)) && new Set(merged.channels).size === merged.channels.length;
    if (!valid) errors.push({ field: "channels", code: "invalid_value", message: "channels must list each of inapp, toast and webhook at most once." });
  }
  if (merged.titleZh !== undefined) checkText(errors, "titleZh", merged.titleZh);
  if (merged.titleEn !== undefined) checkText(errors, "titleEn", merged.titleEn);
  // A metric change makes the old scope filters meaningless, so they are checked afresh.
  const scopeInput = input.scope !== undefined ? input.scope : (input.metric !== undefined && input.metric !== base.metric ? {} : base.scope);
  const scope = validateScope(info ? info.id : "", scopeInput, errors);
  if (finite(merged.threshold) && finite(merged.clearThreshold) && OPS.includes(merged.op)) {
    // The clear threshold sits on the safe side of the threshold (hysteresis).
    const upward = merged.op === ">" || merged.op === ">=";
    if ((upward && merged.clearThreshold > merged.threshold) || (!upward && merged.clearThreshold < merged.threshold)) {
      errors.push({ field: "clearThreshold", code: "invalid_value", message: "clearThreshold must be on the recovered side of threshold." });
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    rule: {
      enabled: merged.enabled === undefined ? true : merged.enabled,
      metric: merged.metric,
      scope,
      op: merged.op,
      threshold: merged.threshold,
      clearThreshold: finite(merged.clearThreshold) ? merged.clearThreshold : null,
      windowS: merged.windowS,
      forS: merged.forS,
      minSamples: merged.minSamples === undefined ? 0 : merged.minSamples,
      severity: merged.severity,
      channels: [...merged.channels],
      cooldownS: merged.cooldownS === undefined ? 1800 : merged.cooldownS,
      titleZh: merged.titleZh.trim(),
      titleEn: merged.titleEn.trim(),
    },
  };
}

// --- worker half: rules and state ------------------------------------------------------

function rowToRule(row) {
  return {
    ruleId: row.rule_id,
    builtin: Boolean(row.builtin),
    enabled: Boolean(row.enabled),
    metric: row.metric,
    scope: parseJson(row.scope, {}),
    op: row.op,
    threshold: row.threshold,
    clearThreshold: row.clear_threshold === null || row.clear_threshold === undefined ? null : row.clear_threshold,
    windowS: row.window_s,
    forS: row.for_s,
    minSamples: row.min_samples,
    severity: row.severity,
    channels: parseJson(row.channels, []),
    cooldownS: row.cooldown_s,
    titleZh: row.title_zh,
    titleEn: row.title_en,
    updatedAt: isoOrNull(row.updated_at),
    updatedBy: row.updated_by || null,
  };
}

function rowToState(row) {
  return {
    ruleId: row.rule_id,
    scopeKey: row.scope_key,
    state: row.state,
    since: row.since,
    lastEvalAt: row.last_eval_at,
    lastValue: row.last_value === undefined ? null : row.last_value,
    firedAt: row.fired_at === undefined ? null : row.fired_at,
    resolvedAt: row.resolved_at === undefined ? null : row.resolved_at,
    lastNotifiedAt: row.last_notified_at === undefined ? null : row.last_notified_at,
    fireCount: row.fire_count,
    ackedAt: row.acked_at === undefined ? null : row.acked_at,
    ackedBy: row.acked_by === undefined ? null : row.acked_by,
    silencedUntil: row.silenced_until === undefined ? null : row.silenced_until,
  };
}

const RULE_COLUMNS = "rule_id, builtin, enabled, metric, scope, op, threshold, clear_threshold, window_s, for_s, min_samples, severity, channels, cooldown_s, title_zh, title_en, updated_at, updated_by";

function insertRuleRow(db, rule, now, actor, { ignore = false } = {}) {
  db.prepare(`INSERT ${ignore ? "OR IGNORE " : ""}INTO alert_rules (${RULE_COLUMNS}) VALUES (${new Array(18).fill("?").join(", ")})`).run(
    rule.ruleId,
    rule.builtin ? 1 : 0,
    rule.enabled === false ? 0 : 1,
    rule.metric,
    JSON.stringify(rule.scope || {}),
    rule.op,
    rule.threshold,
    rule.clearThreshold === null || rule.clearThreshold === undefined ? null : rule.clearThreshold,
    rule.windowS,
    rule.forS,
    rule.minSamples || 0,
    rule.severity,
    JSON.stringify(rule.channels),
    rule.cooldownS || 1800,
    rule.titleZh,
    rule.titleEn,
    now,
    actor,
  );
}

function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = action();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original error is the one worth reporting.
    }
    throw error;
  }
}

function readSeedMarker(db) {
  const row = db.prepare("SELECT value FROM collector_state WHERE name = ?").get(SEED_STATE);
  const value = row ? parseJson(row.value, null) : null;
  return isPlainObject(value) ? value : null;
}

function writeSeedMarker(db, marker, now) {
  db.prepare(
    "INSERT INTO collector_state (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(SEED_STATE, JSON.stringify(marker), now);
}

// The legacy GPU guards (gpu-guard.js) are warn-only automation settings per
// manager. When one is enabled, its limit seeds the matching builtin rule once.
// `guard` is { tempGuardEnabled, tempLimitC, powerGuardEnabled, powerLimitPct }.
function guardThresholds(guard) {
  const out = {};
  if (!isPlainObject(guard)) return out;
  if (guard.tempGuardEnabled && finite(Number(guard.tempLimitC)) && Number(guard.tempLimitC) >= 30 && Number(guard.tempLimitC) <= 120) {
    out.gpu_temp_high = Number(guard.tempLimitC);
  }
  const powerEnabled = guard.powerGuardEnabled ?? guard.tempGuardEnabled;
  if (powerEnabled) {
    const pct = Number(guard.powerLimitPct) > 0 ? Number(guard.powerLimitPct) : 97;
    if (pct >= 50 && pct <= 100) out.gpu_power_cap = Math.round(pct) / 100;
  }
  return out;
}

/**
 * alertSeed(db, { now, guard }): inserts the default rules that are missing
 * (INSERT OR IGNORE, so an edited rule is never overwritten and a rule that
 * is already there is never duplicated) and, on the first run that knows the
 * manager settings (`guard` is an object, possibly empty), migrates the GPU
 * guard limits once. Returns { seeded, migrated:{ruleId:value} }.
 */
function alertSeed(db, params = {}) {
  const now = finite(params.now) ? params.now : Date.now();
  return transaction(db, () => {
    const marker = readSeedMarker(db) || {};
    let seeded = 0;
    for (const rule of DEFAULT_ALERT_RULES) {
      const before = db.prepare("SELECT 1 AS present FROM alert_rules WHERE rule_id = ?").get(rule.ruleId);
      if (before) continue;
      insertRuleRow(db, rule, now, "system", { ignore: true });
      seeded += 1;
    }
    const migrated = {};
    let guardMigrated = marker.guardMigrated === true;
    if (!guardMigrated && isPlainObject(params.guard)) {
      const thresholds = guardThresholds(params.guard);
      for (const [ruleId, threshold] of Object.entries(thresholds)) {
        // Only a rule nobody has edited is migrated.
        const outcome = db.prepare("UPDATE alert_rules SET threshold = ?, updated_at = ?, updated_by = 'migration' WHERE rule_id = ? AND updated_by = 'system'").run(threshold, now, ruleId);
        if (Number(outcome.changes) > 0) migrated[ruleId] = threshold;
      }
      guardMigrated = true;
    }
    writeSeedMarker(db, { version: SEED_VERSION, seededAt: marker.seededAt || now, guardMigrated, migrated: { ...(marker.migrated || {}), ...migrated } }, now);
    return { seeded, migrated };
  });
}

function alertRuleList(db) {
  const rows = db.prepare(`SELECT ${RULE_COLUMNS} FROM alert_rules ORDER BY builtin DESC, rule_id`).all();
  return { rules: rows.map(rowToRule) };
}

function loadRule(db, ruleId) {
  const row = db.prepare(`SELECT ${RULE_COLUMNS} FROM alert_rules WHERE rule_id = ?`).get(String(ruleId));
  return row ? rowToRule(row) : null;
}

function alertRuleGet(db, params = {}) {
  const rule = loadRule(db, params.ruleId);
  return rule ? { ok: true, rule } : resultError(404, "rule_not_found", "No such alert rule.");
}

function alertRuleCreate(db, params = {}) {
  const now = finite(params.now) ? params.now : Date.now();
  const checked = validateRuleInput(params.rule, { partial: false });
  if (!checked.ok) return resultError(400, "invalid_request", "The rule was not saved because some values are not valid.", checked.errors);
  const ruleId = String(params.ruleId || "");
  if (!/^[a-z][a-z0-9_]{2,47}$/.test(ruleId)) return resultError(400, "invalid_request", "The rule id is not valid.");
  return transaction(db, () => {
    const custom = db.prepare("SELECT COUNT(*) AS n FROM alert_rules WHERE builtin = 0").get().n;
    if (custom >= MAX_CUSTOM_RULES) return resultError(409, "too_many_rules", `At most ${MAX_CUSTOM_RULES} custom rules are allowed.`);
    if (db.prepare("SELECT 1 AS present FROM alert_rules WHERE rule_id = ?").get(ruleId)) return resultError(409, "rule_exists", "A rule with this id exists.");
    insertRuleRow(db, { ...checked.rule, ruleId, builtin: false }, now, String(params.actor || "owner").slice(0, 80));
    return { ok: true, rule: loadRule(db, ruleId) };
  });
}

function alertRuleUpdate(db, params = {}) {
  const now = finite(params.now) ? params.now : Date.now();
  return transaction(db, () => {
    const current = loadRule(db, params.ruleId);
    if (!current) return resultError(404, "rule_not_found", "No such alert rule.");
    const checked = validateRuleInput(params.patch, { partial: true, builtin: current.builtin, current });
    if (!checked.ok) return resultError(400, "invalid_request", "The rule was not saved because some values are not valid.", checked.errors);
    const next = checked.rule;
    db.prepare(
      "UPDATE alert_rules SET enabled = ?, metric = ?, scope = ?, op = ?, threshold = ?, clear_threshold = ?, window_s = ?, for_s = ?, min_samples = ?, severity = ?, channels = ?, cooldown_s = ?, title_zh = ?, title_en = ?, updated_at = ?, updated_by = ? WHERE rule_id = ?",
    ).run(
      next.enabled ? 1 : 0, next.metric, JSON.stringify(next.scope), next.op, next.threshold, next.clearThreshold,
      next.windowS, next.forS, next.minSamples, next.severity, JSON.stringify(next.channels), next.cooldownS,
      next.titleZh, next.titleEn, now, String(params.actor || "owner").slice(0, 80), current.ruleId,
    );
    return { ok: true, rule: loadRule(db, current.ruleId), changed: Object.keys(params.patch).filter((key) => RULE_FIELDS.includes(key)) };
  });
}

function alertRuleDelete(db, params = {}) {
  return transaction(db, () => {
    const current = loadRule(db, params.ruleId);
    if (!current) return resultError(404, "rule_not_found", "No such alert rule.");
    if (current.builtin) return resultError(409, "builtin_rule", "Builtin rules can be disabled but not deleted.");
    db.prepare("DELETE FROM alert_state WHERE rule_id = ?").run(current.ruleId);
    db.prepare("DELETE FROM alert_rules WHERE rule_id = ?").run(current.ruleId);
    return { ok: true, ruleId: current.ruleId };
  });
}

function alertStateLoad(db) {
  return { states: db.prepare("SELECT * FROM alert_state").all().map(rowToState) };
}

// states: full rows to upsert; remove: [{ruleId, scopeKey}] (scopeKey omitted
// removes every state of the rule).
function alertStateApply(db, params = {}) {
  const states = Array.isArray(params.states) ? params.states : [];
  const remove = Array.isArray(params.remove) ? params.remove : [];
  return transaction(db, () => {
    const upsert = db.prepare(
      "INSERT INTO alert_state (rule_id, scope_key, state, since, last_eval_at, last_value, fired_at, resolved_at, last_notified_at, fire_count, acked_at, acked_by, silenced_until) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(rule_id, scope_key) DO UPDATE SET state = excluded.state, since = excluded.since, "
      + "last_eval_at = excluded.last_eval_at, last_value = excluded.last_value, fired_at = excluded.fired_at, resolved_at = excluded.resolved_at, "
      + "last_notified_at = excluded.last_notified_at, fire_count = excluded.fire_count, acked_at = excluded.acked_at, acked_by = excluded.acked_by, silenced_until = excluded.silenced_until",
    );
    for (const item of states) {
      upsert.run(
        String(item.ruleId), String(item.scopeKey), item.state, item.since, item.lastEvalAt, finite(item.lastValue) ? item.lastValue : null,
        finite(item.firedAt) ? item.firedAt : null, finite(item.resolvedAt) ? item.resolvedAt : null, finite(item.lastNotifiedAt) ? item.lastNotifiedAt : null,
        item.fireCount || 0, finite(item.ackedAt) ? item.ackedAt : null, item.ackedBy ? String(item.ackedBy).slice(0, 80) : null,
        finite(item.silencedUntil) ? item.silencedUntil : null,
      );
    }
    for (const item of remove) {
      if (item.scopeKey === undefined) db.prepare("DELETE FROM alert_state WHERE rule_id = ?").run(String(item.ruleId));
      else db.prepare("DELETE FROM alert_state WHERE rule_id = ? AND scope_key = ?").run(String(item.ruleId), String(item.scopeKey));
    }
    return { ok: true, written: states.length, removed: remove.length };
  });
}

// GET /api/telemetry/alerts (§13.4): firing first (critical before warning),
// then the newest.
function alertList(db, params = {}) {
  const wantAll = params.state === "all";
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Math.floor(Number(params.limit)) || LIST_LIMIT_DEFAULT));
  const rows = db.prepare(
    "SELECT s.*, r.severity AS severity, r.threshold AS threshold, r.title_zh AS title_zh, r.title_en AS title_en FROM alert_state s "
    + `JOIN alert_rules r ON r.rule_id = s.rule_id ${wantAll ? "" : "WHERE s.state = 'firing'"} `
    + "ORDER BY CASE s.state WHEN 'firing' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, "
    + "CASE r.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, s.since DESC, s.rule_id, s.scope_key LIMIT ?",
  ).all(limit);
  return {
    rows: rows.map((row) => ({
      ruleId: row.rule_id,
      scopeKey: row.scope_key,
      state: row.state,
      severity: row.severity,
      title: { zh: renderTitle(row.title_zh, row.scope_key, row.rule_id), en: renderTitle(row.title_en, row.scope_key, row.rule_id) },
      value: row.last_value === undefined ? null : row.last_value,
      threshold: row.threshold,
      since: isoOrNull(row.since),
      firedAt: isoOrNull(row.fired_at),
      resolvedAt: isoOrNull(row.resolved_at),
      ackedAt: isoOrNull(row.acked_at),
      silencedUntil: isoOrNull(row.silenced_until),
    })),
  };
}

// --- worker half: SQL metrics ------------------------------------------------------------

function placeholders(count) {
  return new Array(count).fill("?").join(", ");
}

function requestFilter(scope, from, to) {
  const clauses = ["received_at >= ?", "received_at <= ?", "ingress NOT LIKE 'import:%'"];
  const params = [from, to];
  if (scope.fleetId) {
    clauses.push("fleet_id = ?");
    params.push(scope.fleetId);
  }
  return { where: clauses.join(" AND "), params };
}

function measureUpstreamErrorRate(db, scope, from, to) {
  const { where, params } = requestFilter(scope, from, to);
  const errors = `COALESCE(SUM(CASE WHEN error_class IN (${placeholders(UPSTREAM_ERROR_CLASSES.length)}) THEN 1 ELSE 0 END), 0)`;
  if (scope.perFleet && !scope.fleetId) {
    const rows = db.prepare(`SELECT fleet_id, COUNT(*) AS n, ${errors} AS e FROM requests WHERE ${where} AND fleet_id IS NOT NULL AND fleet_id <> '' GROUP BY fleet_id ORDER BY fleet_id`).all(...UPSTREAM_ERROR_CLASSES, ...params);
    return rows.map((row) => ({ scopeKey: `fleet:${row.fleet_id}`, value: row.n ? row.e / row.n : 0, samples: row.n }));
  }
  const row = db.prepare(`SELECT COUNT(*) AS n, ${errors} AS e FROM requests WHERE ${where}`).get(...UPSTREAM_ERROR_CLASSES, ...params);
  return [{ scopeKey: scope.fleetId ? `fleet:${scope.fleetId}` : "*", value: row.n ? row.e / row.n : 0, samples: row.n }];
}

function countRequests(db, scope, from, to, classes) {
  const { where, params } = requestFilter(scope, from, to);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE ${where}`).get(...params).n;
  const hits = db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE ${where} AND error_class IN (${placeholders(classes.length)})`).get(...params, ...classes).n;
  return { total, hits, where, params };
}

function measureErrorCount(db, scope, from, to) {
  const classes = Array.isArray(scope.errorClasses) && scope.errorClasses.length ? scope.errorClasses : DEFAULT_ERROR_COUNT_CLASSES;
  const counted = countRequests(db, scope, from, to, classes);
  return [{ scopeKey: scope.fleetId ? `fleet:${scope.fleetId}` : "*", value: counted.hits, samples: counted.total }];
}

function measureAuthFailures(db, scope, from, to) {
  const counted = countRequests(db, scope, from, to, ["auth_failed"]);
  const detail = {};
  if (counted.hits > 0) {
    const rows = db.prepare(
      `SELECT client_ip, COUNT(*) AS c FROM requests WHERE ${counted.where} AND error_class = 'auth_failed' AND client_ip IS NOT NULL AND client_ip <> '' GROUP BY client_ip ORDER BY c DESC, client_ip LIMIT 5`,
    ).all(...counted.params);
    // Masked at the source: the raw address never leaves the worker.
    const merged = new Map();
    for (const row of rows) {
      const key = maskAddress(row.client_ip);
      merged.set(key, (merged.get(key) || 0) + row.c);
    }
    detail.topIps = [...merged].map(([ipMasked, count]) => ({ ipMasked, count }));
  }
  return [{ scopeKey: "*", value: counted.hits, samples: counted.total, detail }];
}

function measureBillingUnavailable(db, scope, from, to) {
  const counted = countRequests(db, scope, from, to, ["billing_unavailable"]);
  return [{ scopeKey: "*", value: counted.hits, samples: counted.total }];
}

function measureRuntime(db, column, scope, from, to) {
  const fleet = scope.fleetId ? " AND fleet_id = ?" : "";
  const rows = db.prepare(
    `SELECT fleet_id, AVG(${column}) AS value, COUNT(*) AS n FROM runtime_samples WHERE at >= ? AND at <= ? AND scrape_ok = 1 AND ${column} IS NOT NULL${fleet} GROUP BY fleet_id ORDER BY fleet_id`,
  ).all(from, to, ...(scope.fleetId ? [scope.fleetId] : []));
  return rows.map((row) => ({ scopeKey: `fleet:${row.fleet_id}`, value: row.value, samples: row.n }));
}

function measureGpu(db, expression, where, scope, from, to) {
  const gpu = Number.isInteger(scope.gpu) ? " AND gpu_index = ?" : "";
  const rows = db.prepare(
    `SELECT gpu_index, ${expression} AS value, COUNT(*) AS n FROM gpu_samples WHERE at >= ? AND at <= ? AND ${where}${gpu} GROUP BY gpu_index ORDER BY gpu_index`,
  ).all(from, to, ...(Number.isInteger(scope.gpu) ? [scope.gpu] : []));
  return rows.filter((row) => row.value !== null && row.value !== undefined).map((row) => ({ scopeKey: `gpu:${row.gpu_index}`, value: row.value, samples: row.n }));
}

function throttleMatch() {
  return `(${THROTTLE_HARDWARE.map((slug) => `instr(',' || throttle || ',', ',${slug},') > 0`).join(" OR ")})`;
}

function measureBans(db, scope, from, to) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'security.ban' AND at >= ? AND at <= ?").get(from, to);
  return [{ scopeKey: "*", value: row.n, samples: row.n }];
}

const SQL_MEASURES = Object.freeze({
  "req.upstream_error_rate": (db, scope, from, to) => measureUpstreamErrorRate(db, scope, from, to),
  "req.error_count": (db, scope, from, to) => measureErrorCount(db, scope, from, to),
  "req.auth_failures": (db, scope, from, to) => measureAuthFailures(db, scope, from, to),
  "billing.unavailable": (db, scope, from, to) => measureBillingUnavailable(db, scope, from, to),
  "rt.waiting": (db, scope, from, to) => measureRuntime(db, "waiting", scope, from, to),
  "rt.kv_usage": (db, scope, from, to) => measureRuntime(db, "kv_usage", scope, from, to),
  "gpu.temp_c": (db, scope, from, to) => measureGpu(db, "MAX(temp_c)", "temp_c IS NOT NULL", scope, from, to),
  "gpu.power_ratio": (db, scope, from, to) => measureGpu(db, "AVG(power_w / power_limit_w)", "power_w IS NOT NULL AND power_limit_w IS NOT NULL AND power_limit_w > 0", scope, from, to),
  "gpu.hw_throttle_share": (db, scope, from, to) => measureGpu(db, `AVG(CASE WHEN ${throttleMatch()} THEN 1.0 ELSE 0.0 END)`, "throttle IS NOT NULL", scope, from, to),
  "security.bans": (db, scope, from, to) => measureBans(db, scope, from, to),
});

/**
 * alertMeasure(db, { now, queries:[{id, metric, windowS, scope}] }) →
 *   { results: { [id]: [{scopeKey, value, samples, detail?}] | {error} } }
 * One query failing never fails the others.
 */
function alertMeasure(db, params = {}) {
  const now = finite(params.now) ? params.now : Date.now();
  const results = {};
  for (const query of Array.isArray(params.queries) ? params.queries : []) {
    const id = String(query.id);
    const measure = SQL_MEASURES[query.metric];
    if (!measure) {
      results[id] = { error: "unknown_metric" };
      continue;
    }
    try {
      const scope = isPlainObject(query.scope) ? query.scope : {};
      const windowMs = Math.max(1, Number(query.windowS) || 60) * 1000;
      results[id] = measure(db, scope, now - windowMs, now);
    } catch (error) {
      results[id] = { error: String((error && error.code) || "measure_failed") };
    }
  }
  return { results };
}

const WORKER_CALLS = Object.freeze({
  alertSeed,
  alertRuleList,
  alertRuleGet,
  alertRuleCreate,
  alertRuleUpdate,
  alertRuleDelete,
  alertStateLoad,
  alertStateApply,
  alertList,
  alertMeasure,
});

// --- entry half: memory-backed metrics -----------------------------------------------------

/**
 * createManagerHealthSource({ managers, get, timeoutMs }) → { poll(), snapshot() }.
 * `get(managerId, path, {timeoutMs})` is the entry's manager client; a manager
 * answers /api/manager/health or counts as failed. The failure streak resets
 * on the first answer.
 */
function createManagerHealthSource(options = {}) {
  const ids = (Array.isArray(options.managers) ? options.managers : []).map((item) => (typeof item === "string" ? item : String(item && item.id || ""))).filter(Boolean);
  const get = typeof options.get === "function" ? options.get : null;
  const timeoutMs = finite(options.timeoutMs) ? options.timeoutMs : 3000;
  const failures = new Map(ids.map((id) => [id, 0]));
  async function poll() {
    await Promise.all(ids.map(async (id) => {
      let ok = false;
      try {
        const result = get ? await get(id, "/api/manager/health", { timeoutMs }) : null;
        ok = Boolean(result && (result.ok === true || (Number(result.status) >= 200 && Number(result.status) < 300)));
      } catch {
        ok = false;
      }
      failures.set(id, ok ? 0 : (failures.get(id) || 0) + 1);
    }));
    return snapshot();
  }
  function snapshot() {
    return ids.map((id) => ({ id, failures: failures.get(id) || 0 }));
  }
  return { poll, snapshot };
}

/**
 * The model-storage roots as { label, path } for the disk source: the platform
 * root, plus each root registered in model-storage.json. Labels are ids, never
 * paths, so a scope key does not reveal a folder.
 */
function diskRootsFrom({ aiRoot, storageFile, fsImpl }) {
  const fs = fsImpl || require("node:fs");
  const path = require("node:path");
  const roots = [];
  if (aiRoot) {
    roots.push({ label: "ai-root", path: aiRoot });
    roots.push({ label: "legacy", path: path.join(aiRoot, "models") });
  }
  try {
    const document = JSON.parse(String(fs.readFileSync(storageFile, "utf8")).replace(/^﻿/, ""));
    for (const root of Array.isArray(document && document.roots) ? document.roots : []) {
      const label = String(root && root.id || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
      if (label && root.path && !roots.some((item) => item.label === label)) roots.push({ label, path: String(root.path) });
    }
  } catch {
    // No storage file or an unreadable one: the platform root alone is watched.
  }
  return roots;
}

// fs.statfsSync free/total of each root; a root that cannot be read is left out.
function readDiskFree(roots, fsImpl) {
  const fs = fsImpl || require("node:fs");
  const path = require("node:path");
  const out = [];
  const drives = new Set();
  for (const root of roots) {
    try {
      // Roots on one Windows drive are one volume: it is reported once, under the first label.
      const drive = process.platform === "win32" ? path.parse(path.resolve(root.path)).root.toLowerCase() : "";
      if (drive && drives.has(drive)) continue;
      if (typeof fs.existsSync === "function" && !fs.existsSync(root.path)) continue;
      const stat = fs.statfsSync(root.path);
      const total = Number(stat.blocks);
      const free = Number(stat.bavail);
      if (total > 0 && Number.isFinite(free)) {
        out.push({ label: root.label, freeRatio: free / total });
        if (drive) drives.add(drive);
      }
    } catch {
      // The root vanished or the volume is offline; disk_low is about space.
    }
  }
  return out;
}

// --- the engine ----------------------------------------------------------------------------

class AlertError extends Error {
  constructor(status, code, message, errors) {
    super(message);
    this.name = "AlertError";
    this.status = status;
    this.code = code;
    if (errors && errors.length) this.errors = errors;
  }
}

function toAlertError(result) {
  return new AlertError(Number(result.status) || 400, String(result.code || "invalid_request"), String(result.message || "The request failed."), result.errors);
}

function randomRuleId() {
  return `custom_${require("node:crypto").randomBytes(5).toString("hex")}`;
}

/**
 * createAlertEngine({ store, notify, now, intervalMs = 15000, sources,
 *   readGuard, timers, logger, consoleBase }) →
 *   { start(), stop(), tick(), ready(), status(), listRules(), createRule(),
 *     updateRule(), deleteRule(), listAlerts(), ack(), silence(), sendTest() }
 *
 * - store: the TelemetryStore (or a function returning it) whose call()
 *   reaches WORKER_CALLS and whose insertEvents() writes alert.* events.
 * - notify: the notifier of notify.js ({notify, flush, toastChannel, test}) or
 *   just a notify(alert, options) function.
 * - sources: { instances(), managers(), disks(), audit(), collectors(),
 *   recorder() }; each is optional, and a missing or failing source leaves its
 *   metric unmeasured, which changes no state.
 * - readGuard(): the legacy GPU guard settings for the one-time migration.
 */
function createAlertEngine(options = {}) {
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const intervalMs = finite(options.intervalMs) && options.intervalMs >= 10 ? options.intervalMs : DEFAULT_INTERVAL_MS;
  const sources = isPlainObject(options.sources) ? options.sources : {};
  const timers = options.timers && typeof options.timers.setTimeout === "function" ? options.timers : { setTimeout, clearTimeout };
  const logger = options.logger === undefined ? console : options.logger;
  const notifier = options.notify && typeof options.notify === "object" ? options.notify : null;
  const notifyFn = notifier ? (alert, notifyOptions) => notifier.notify(alert, notifyOptions) : (typeof options.notify === "function" ? options.notify : null);

  const states = new Map();
  let rules = [];
  let ruleMap = new Map();
  let timer = null;
  let running = false;
  let stopped = false;
  let seeded = null;
  let queue = Promise.resolve();
  let lastTickAt = null;
  let lastError = null;
  let firstTickAt = null;
  const counters = { ticks: 0, errors: 0, transitions: 0, notified: 0 };
  // Memory metrics that are expensive to read (disk, audit) are refreshed once a minute.
  const memoryCache = new Map();
  const collectorGood = new Map();
  let lastDropped = null;
  let lastDropAt = null;
  // State rows to delete at the end of the tick.
  let removals = [];

  function warn(line) {
    if (!logger) return;
    try {
      (typeof logger.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(`alerts: ${line}`));
    } catch {
      // Logging never breaks the engine.
    }
  }

  function getStore() {
    const store = typeof options.store === "function" ? options.store() : options.store;
    if (!store || typeof store.call !== "function") {
      throw new AlertError(503, "telemetry_unavailable", "Telemetry is not available right now.");
    }
    return store;
  }

  function call(name, params) {
    return getStore().call(name, params);
  }

  // Calls run one at a time so an API write never interleaves with a tick.
  function serial(action) {
    const run = queue.then(action, action);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  const stateKey = (ruleId, scopeKey) => `${ruleId}\u0000${scopeKey}`;

  function newState(rule, scopeKey, t) {
    return {
      ruleId: rule.ruleId, scopeKey, state: "ok", since: t, lastEvalAt: t, lastValue: null, firedAt: null, resolvedAt: null,
      lastNotifiedAt: null, fireCount: 0, ackedAt: null, ackedBy: null, silencedUntil: null, detail: null,
    };
  }

  function persistable(state) {
    const { detail, dirty, ...row } = state; // eslint-disable-line no-unused-vars
    return row;
  }

  // --- seeding and loading ---

  async function seed() {
    let guard = null;
    if (typeof options.readGuard === "function") {
      try {
        const value = await options.readGuard();
        guard = isPlainObject(value) ? value : null;
      } catch {
        guard = null;
      }
    }
    return call("alertSeed", { now: clock(), guard });
  }

  async function loadStates() {
    const { states: rows } = await call("alertStateLoad", {});
    states.clear();
    for (const row of rows) states.set(stateKey(row.ruleId, row.scopeKey), { ...row, detail: null });
  }

  function ready() {
    if (!seeded) {
      seeded = serial(async () => {
        await seed();
        await loadStates();
      }).catch((error) => {
        seeded = null;
        throw error;
      });
    }
    return seeded;
  }

  // --- measuring ---

  async function memoryValue(name, loader) {
    const t = clock();
    const cached = memoryCache.get(name);
    if (cached && t - cached.at < MEMORY_REFRESH_MS) return cached.value;
    const value = await loader();
    memoryCache.set(name, { at: t, value });
    return value;
  }

  function memoryMeasure(rule, t) {
    const scope = rule.scope || {};
    switch (rule.metric) {
      case "instance.down": {
        if (typeof sources.instances !== "function") return null;
        return Promise.resolve(sources.instances()).then((list) => (Array.isArray(list) ? list : [])
          .filter((item) => item && item.fleetId && (!scope.fleetId || item.fleetId === scope.fleetId))
          .filter((item) => item.expectedReady || item.lifecycleState === "crashed")
          .map((item) => ({
            scopeKey: `fleet:${item.fleetId}`,
            value: item.lifecycleState === "crashed" || Number(item.failures) >= FAILURES_BEFORE_DOWN ? 1 : 0,
            samples: 1,
          })));
      }
      case "manager.down": {
        if (typeof sources.managers !== "function") return null;
        return Promise.resolve(sources.managers()).then((list) => (Array.isArray(list) ? list : [])
          .filter((item) => item && item.id && (!scope.managerId || item.id === scope.managerId))
          .map((item) => ({ scopeKey: `manager:${item.id}`, value: Number(item.failures) >= FAILURES_BEFORE_DOWN ? 1 : 0, samples: 1 })));
      }
      case "disk.free_ratio": {
        if (typeof sources.disks !== "function") return null;
        return memoryValue("disks", () => Promise.resolve(sources.disks())).then((list) => (Array.isArray(list) ? list : [])
          .filter((item) => item && item.label && finite(item.freeRatio) && (!scope.root || item.label === scope.root))
          .map((item) => ({ scopeKey: `disk:${item.label}`, value: item.freeRatio, samples: 1 })));
      }
      case "audit.export_failed":
      case "audit.chain_risk": {
        if (typeof sources.audit !== "function") return null;
        return memoryValue("audit", () => Promise.resolve(sources.audit())).then((status) => {
          const flag = rule.metric === "audit.export_failed" ? status && status.exportFailed : status && status.chainRisk;
          // null means the schedule cannot say, which is not an alert.
          return typeof flag === "boolean" ? [{ scopeKey: "*", value: flag ? 1 : 0, samples: 1 }] : null;
        });
      }
      case "telemetry.stale_seconds":
        return staleMeasure(scope, t);
      default:
        return null;
    }
  }

  async function staleMeasure(scope, t) {
    if (typeof sources.collectors !== "function" && typeof sources.recorder !== "function") return null;
    const byScope = new Map();
    const put = (name, value) => {
      const key = `collector:${name}`;
      byScope.set(key, Math.max(byScope.get(key) ?? 0, value));
    };
    const list = typeof sources.collectors === "function" ? await sources.collectors() : [];
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || !item.name || (scope.collector && item.name !== scope.collector)) continue;
      const known = collectorGood.get(item.name);
      if (item.ok) collectorGood.set(item.name, t);
      else if (known === undefined) collectorGood.set(item.name, finite(item.lastOkAt) ? item.lastOkAt : t);
      else if (finite(item.lastOkAt) && item.lastOkAt > known) collectorGood.set(item.name, item.lastOkAt);
      put(item.name, Math.max(0, (t - collectorGood.get(item.name)) / 1000));
    }
    if (typeof sources.recorder === "function" && (!scope.collector || scope.collector === "recorder")) {
      const stats = await sources.recorder();
      const dropped = stats && finite(Number(stats.dropped)) ? Number(stats.dropped) : null;
      if (dropped !== null) {
        if (lastDropped !== null && dropped > lastDropped) lastDropAt = t;
        lastDropped = dropped;
        // Rows dropped in the last minute make the recorder stale while it keeps dropping.
        put("recorder", lastDropAt !== null && t - lastDropAt <= 60_000 ? RECORDER_DROP_SECONDS : 0);
      }
    }
    return [...byScope].map(([scopeKey, value]) => ({ scopeKey, value, samples: 1 }));
  }

  // Map ruleId -> measurements, or null when the rule could not be measured this round.
  async function measureRules(active, t) {
    const out = new Map();
    const sqlQueries = [];
    for (const rule of active) {
      const info = METRIC_BY_ID.get(rule.metric);
      if (!info) {
        out.set(rule.ruleId, null);
      } else if (info.source === "sql") {
        sqlQueries.push({ id: rule.ruleId, metric: rule.metric, windowS: rule.windowS, scope: rule.scope || {} });
      } else {
        try {
          const list = await memoryMeasure(rule, t);
          out.set(rule.ruleId, list === null ? null : list);
        } catch (error) {
          warn(`the source of ${rule.metric} failed (${(error && error.code) || "error"})`);
          out.set(rule.ruleId, null);
        }
      }
    }
    if (sqlQueries.length) {
      const { results } = await call("alertMeasure", { now: t, queries: sqlQueries });
      for (const query of sqlQueries) {
        const result = results[query.id];
        out.set(query.id, Array.isArray(result) ? result : null);
      }
    }
    return out;
  }

  // --- the state machine ---

  function isSilenced(state, t) {
    return finite(state.silencedUntil) && state.silencedUntil > t;
  }

  function alertOf(rule, state, value, t) {
    return {
      ruleId: rule.ruleId,
      scopeKey: state.scopeKey,
      severity: rule.severity,
      title: { zh: renderTitle(rule.titleZh, state.scopeKey, rule.ruleId), en: renderTitle(rule.titleEn, state.scopeKey, rule.ruleId) },
      value: finite(value) ? value : (finite(state.lastValue) ? state.lastValue : null),
      threshold: rule.threshold,
      since: state.since,
      firedAt: state.firedAt,
      at: t,
      link: alertLink(rule.ruleId),
      unit: (METRIC_BY_ID.get(rule.metric) || {}).unit || null,
      detail: state.detail || null,
    };
  }

  async function writeEvent(rule, state, type, severity, value, t, extra = {}) {
    const alert = alertOf(rule, state, value, t);
    const fleetId = fleetOf(state.scopeKey);
    try {
      await getStore().insertEvents([{
        at: t,
        source: "entry",
        type,
        severity,
        title: type === "alert.firing" ? `Alert firing: ${alert.title.en}` : type === "alert.resolved" ? `Alert resolved: ${alert.title.en}` : `${type}: ${alert.title.en}`,
        ...(fleetId ? { fleetId } : {}),
        data: {
          ruleId: rule.ruleId,
          scopeKey: state.scopeKey,
          severity: rule.severity,
          value: alert.value,
          threshold: rule.threshold,
          since: isoOrNull(state.since),
          title: alert.title,
          ...(state.detail ? { detail: state.detail } : {}),
          ...(type === "alert.firing" ? { i18nKey: "obs.alert.firing" } : type === "alert.resolved" ? { i18nKey: "obs.alert.resolved" } : {}),
          ...extra.data,
        },
        dedupeKey: extra.dedupeKey || `${type}:${rule.ruleId}:${state.scopeKey}:${state.firedAt || state.since}:${state.resolvedAt || ""}`,
      }]);
    } catch (error) {
      warn(`the ${type} event was not stored (${(error && error.code) || "error"})`);
    }
  }

  async function emit(rule, state, action, value, t, extra = {}) {
    if (!notifyFn) return null;
    try {
      return await notifyFn(alertOf(rule, state, value, t), {
        action,
        channels: rule.channels,
        silenced: Boolean(extra.silenced) || isSilenced(state, t),
        renotify: Boolean(extra.renotify),
      });
    } catch (error) {
      warn(`a notification failed (${(error && error.code) || "error"})`);
      return null;
    }
  }

  async function fire(rule, state, m, t) {
    state.state = "firing";
    state.firedAt = t;
    state.resolvedAt = null;
    state.fireCount += 1;
    state.ackedAt = null;
    state.ackedBy = null;
    state.lastValue = m.value;
    state.detail = m.detail && Object.keys(m.detail).length ? m.detail : null;
    state.lastNotifiedAt = isSilenced(state, t) ? null : t;
    state.dirty = true;
    counters.transitions += 1;
    await writeEvent(rule, state, "alert.firing", rule.severity, m.value, t);
    await emit(rule, state, "firing", m.value, t);
    if (!isSilenced(state, t)) counters.notified += 1;
  }

  async function resolve(rule, state, value, t, { quiet = false } = {}) {
    state.state = "ok";
    state.resolvedAt = t;
    state.lastValue = finite(value) ? value : state.lastValue;
    state.ackedAt = null;
    state.ackedBy = null;
    state.dirty = true;
    counters.transitions += 1;
    await writeEvent(rule, state, "alert.resolved", "info", value, t);
    await emit(rule, state, "resolved", value, t, { silenced: quiet });
    state.detail = null;
  }

  async function renotify(rule, state, value, t) {
    state.lastNotifiedAt = t;
    state.dirty = true;
    await emit(rule, state, "firing", value, t, { renotify: true });
  }

  async function apply(rule, m, t) {
    const key = stateKey(rule.ruleId, m.scopeKey);
    let state = states.get(key);
    const enough = finite(m.value) && (Number(m.samples) || 0) >= (rule.minSamples || 0);
    if (!state) {
      if (!enough || !compare(m.value, rule.op, rule.threshold)) return;
      state = newState(rule, m.scopeKey, t);
      states.set(key, state);
    }
    state.lastEvalAt = t;
    if (!enough) {
      // Not enough data to judge: pending goes back to ok; a firing alert that
      // can no longer be judged is resolved rather than left hanging.
      if (state.state === "firing") await resolve(rule, state, null, t);
      else if (state.state === "pending") toOk(state, key);
      return;
    }
    const holds = compare(m.value, rule.op, rule.threshold);
    if (state.state === "ok") {
      if (!holds) {
        if (!state.fireCount) {
          states.delete(key);
          removals.push({ ruleId: state.ruleId, scopeKey: state.scopeKey });
        }
        return;
      }
      state.state = "pending";
      state.since = t;
      state.lastValue = m.value;
      state.detail = m.detail && Object.keys(m.detail).length ? m.detail : null;
      state.dirty = true;
      if (rule.forS * 1000 <= 0) await fire(rule, state, m, t);
      return;
    }
    state.lastValue = m.value;
    state.dirty = true;
    if (m.detail && Object.keys(m.detail).length) state.detail = m.detail;
    if (state.state === "pending") {
      if (!holds) toOk(state, key);
      else if (t - state.since >= rule.forS * 1000) await fire(rule, state, m, t);
      return;
    }
    // firing
    const clearAt = finite(rule.clearThreshold) ? rule.clearThreshold : rule.threshold;
    if (!compare(m.value, rule.op, clearAt)) {
      await resolve(rule, state, m.value, t);
      return;
    }
    const cooledDown = t - (finite(state.lastNotifiedAt) ? state.lastNotifiedAt : state.firedAt) >= rule.cooldownS * 1000;
    if (cooledDown && !finite(state.ackedAt) && !isSilenced(state, t)) await renotify(rule, state, m.value, t);
  }

  function toOk(state, key) {
    if (state.fireCount > 0) {
      state.state = "ok";
      state.dirty = true;
    } else {
      states.delete(key);
      removals.push({ ruleId: state.ruleId, scopeKey: state.scopeKey });
    }
  }

  // A scope the measurement no longer reports (the GPU vanished, the instance
  // was stopped on purpose) cannot be judged: pending reverts, firing resolves.
  async function absent(rule, state, t) {
    if (state.state === "firing") await resolve(rule, state, null, t);
    else if (state.state === "pending") toOk(state, stateKey(rule.ruleId, state.scopeKey));
  }

  async function runTick() {
    const t = clock();
    if (firstTickAt === null) firstTickAt = t;
    removals = [];
    const { rules: list } = await call("alertRuleList", {});
    rules = list;
    ruleMap = new Map(list.map((rule) => [rule.ruleId, rule]));
    const active = list.filter((rule) => rule.enabled);
    const measured = await measureRules(active, t);
    for (const rule of active) {
      const list2 = measured.get(rule.ruleId);
      if (!list2) continue;
      const seen = new Set();
      for (const m of list2) {
        seen.add(m.scopeKey);
        await apply(rule, m, t);
      }
      for (const state of [...states.values()]) {
        if (state.ruleId === rule.ruleId && !seen.has(state.scopeKey)) await absent(rule, state, t);
      }
    }
    // A disabled or removed rule keeps no live alert.
    for (const state of [...states.values()]) {
      const rule = ruleMap.get(state.ruleId);
      if (rule && rule.enabled) continue;
      if (!rule) {
        states.delete(stateKey(state.ruleId, state.scopeKey));
        removals.push({ ruleId: state.ruleId, scopeKey: state.scopeKey });
        continue;
      }
      if (state.state === "firing") await resolve(rule, state, null, t, { quiet: true });
      else if (state.state === "pending") toOk(state, stateKey(state.ruleId, state.scopeKey));
    }
    const dirty = [...states.values()].filter((state) => state.dirty);
    if (dirty.length || removals.length) {
      await call("alertStateApply", { states: dirty.map(persistable), remove: removals });
      for (const state of dirty) state.dirty = false;
    }
    if (notifier && typeof notifier.flush === "function") {
      try {
        await notifier.flush();
      } catch {
        // A summary that cannot be sent is retried at the next tick.
      }
    }
    lastTickAt = t;
    lastError = null;
    counters.ticks += 1;
  }

  async function tick() {
    if (stopped) return { skipped: true };
    try {
      await ready();
      await serial(runTick);
      return { ok: true };
    } catch (error) {
      counters.errors += 1;
      lastError = String((error && (error.code || error.message)) || "error");
      warn(`an evaluation failed (${lastError})`);
      return { ok: false, error: lastError };
    }
  }

  function schedule() {
    if (!running || stopped) return;
    timer = timers.setTimeout(() => {
      timer = null;
      tick().finally(schedule);
    }, intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function start() {
    if (running) return;
    running = true;
    stopped = false;
    // The first evaluation runs right away; later ones every intervalMs.
    tick().finally(schedule);
  }

  async function stop() {
    running = false;
    stopped = true;
    if (timer) {
      timers.clearTimeout(timer);
      timer = null;
    }
    try {
      await queue;
    } catch {
      // Nothing to wait for.
    }
    return { ok: true };
  }

  // --- API for the routes ---

  async function listRules() {
    await ready();
    const { rules: list } = await call("alertRuleList", {});
    return list;
  }

  async function createRule(input, { actor = "owner" } = {}) {
    await ready();
    const result = await serial(() => call("alertRuleCreate", { rule: input, ruleId: randomRuleId(), now: clock(), actor }));
    if (!result.ok) throw toAlertError(result);
    return result.rule;
  }

  async function updateRule(ruleId, patch, { actor = "owner" } = {}) {
    await ready();
    const result = await serial(() => call("alertRuleUpdate", { ruleId, patch, now: clock(), actor }));
    if (!result.ok) throw toAlertError(result);
    return result;
  }

  async function deleteRule(ruleId) {
    await ready();
    return serial(async () => {
      const result = await call("alertRuleDelete", { ruleId });
      if (!result.ok) throw toAlertError(result);
      const before = [...states.values()].filter((state) => state.ruleId === ruleId);
      for (const state of before) states.delete(stateKey(state.ruleId, state.scopeKey));
      return result;
    });
  }

  async function listAlerts({ state = "firing", limit } = {}) {
    await ready();
    const out = await call("alertList", { state, limit });
    for (const row of out.rows) {
      const live = states.get(stateKey(row.ruleId, row.scopeKey));
      if (live && live.detail) row.detail = live.detail;
    }
    return out.rows;
  }

  function findState(ruleId, scopeKey) {
    const state = states.get(stateKey(ruleId, scopeKey));
    if (!state) throw new AlertError(404, "alert_not_found", "No such alert.");
    return state;
  }

  async function persistOne(state) {
    await call("alertStateApply", { states: [persistable(state)] });
    state.dirty = false;
  }

  function publicState(state) {
    return { ok: true, state: state.state, ackedAt: isoOrNull(state.ackedAt), silencedUntil: isoOrNull(state.silencedUntil) };
  }

  async function ack(ruleId, scopeKey = "*", { actor = "owner" } = {}) {
    await ready();
    return serial(async () => {
      const state = findState(ruleId, scopeKey);
      const rule = ruleMap.get(ruleId) || (await listRules()).find((item) => item.ruleId === ruleId);
      if (!rule) throw new AlertError(404, "rule_not_found", "No such alert rule.");
      if (state.state !== "firing") throw new AlertError(409, "not_firing", "Only a firing alert can be acknowledged.");
      const t = clock();
      state.ackedAt = t;
      state.ackedBy = actor;
      await persistOne(state);
      await writeEvent(rule, state, "alert.acked", "info", state.lastValue, t, { dedupeKey: `alert.acked:${ruleId}:${scopeKey}:${t}` });
      await emit(rule, state, "acked", state.lastValue, t, { silenced: true });
      return publicState(state);
    });
  }

  async function silence(ruleId, scopeKey = "*", until, { actor = "owner" } = {}) {
    await ready();
    return serial(async () => {
      const state = findState(ruleId, scopeKey);
      const t = clock();
      let untilMs = null;
      if (until !== null && until !== undefined) {
        untilMs = typeof until === "number" ? until : Date.parse(String(until));
        if (!finite(untilMs) || untilMs <= t) throw new AlertError(400, "invalid_request", "until must be a time in the future.", [{ field: "until", code: "invalid_value", message: "until must be a time in the future." }]);
        if (untilMs - t > MAX_SILENCE_MS) throw new AlertError(400, "invalid_request", "until may be at most 30 days away.", [{ field: "until", code: "out_of_range", message: "until may be at most 30 days away." }]);
      }
      state.silencedUntil = untilMs;
      await persistOne(state);
      const rule = ruleMap.get(ruleId);
      if (rule) {
        await writeEvent(rule, state, "alert.silenced", "info", state.lastValue, t, {
          dedupeKey: `alert.silenced:${ruleId}:${scopeKey}:${t}`,
          data: { silencedUntil: isoOrNull(untilMs), actor: String(actor).slice(0, 80) },
        });
      }
      return publicState(state);
    });
  }

  async function sendTest(request = {}) {
    if (!notifier || typeof notifier.test !== "function") throw new AlertError(503, "notifier_unavailable", "Notifications are not available right now.");
    return notifier.test(request);
  }

  function toastChannel() {
    return notifier && typeof notifier.toastChannel === "function" ? notifier.toastChannel() : "no_subscriber";
  }

  function status() {
    let firing = 0;
    for (const state of states.values()) if (state.state === "firing") firing += 1;
    return { running, lastTickAt: isoOrNull(lastTickAt), lastError, rules: rules.length, firing, toastChannel: toastChannel(), ...counters };
  }

  return {
    start,
    stop,
    tick,
    ready,
    status,
    toastChannel,
    listRules,
    createRule,
    updateRule,
    deleteRule,
    listAlerts,
    ack,
    silence,
    sendTest,
  };
}

module.exports = {
  ALERT_METRICS,
  AlertError,
  BUILTIN_EDITABLE,
  CHANNELS,
  DEFAULT_ALERT_RULES,
  DEFAULT_INTERVAL_MS,
  SEVERITIES,
  SEVERITY_RANK,
  WORKER_CALLS,
  alertLink,
  compare,
  createAlertEngine,
  createManagerHealthSource,
  diskRootsFrom,
  guardThresholds,
  readDiskFree,
  renderTitle,
  validateRuleInput,
};
