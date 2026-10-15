// The pure parts of the Alerts page (07 §6.9, 04 §13.4): silence times, the
// ack and silence bodies (always with the row's scopeKey), the rule form's
// draft and request body, the writer's field errors and the webhook list sent
// back to settings. Rendering is routes/alerts.js and routes/alerts/*.

export const TABS = Object.freeze(["firing", "history", "rules", "channels"]);
export const SILENCE_PRESETS = Object.freeze([{ id: "1h", ms: 3_600_000 }, { id: "8h", ms: 28_800_000 }, { id: "24h", ms: 86_400_000 }]);
/** The fields of a builtin rule an owner may change (04 §13.2). */
export const BUILTIN_EDITABLE = Object.freeze(["enabled", "threshold", "clearThreshold", "forS", "windowS", "severity", "channels", "cooldownS"]);
export const CHANNELS = Object.freeze(["inapp", "toast", "webhook"]);
export const SEVERITIES = Object.freeze(["info", "warning", "critical"]);
export const OPS = Object.freeze([">", ">=", "<", "<="]);
export const WEBHOOK_FORMATS = Object.freeze(["generic", "feishu", "dingtalk", "wecom", "slack"]);
export const SEVERITY_BADGE = Object.freeze({ critical: "error", warning: "warn", info: "info" });
export const NUMBER_FIELDS = Object.freeze(["threshold", "clearThreshold", "windowS", "forS", "minSamples", "cooldownS"]);
export const SCOPE_NUMBER = new Set(["gpu"]);
export const SCOPE_BOOL = new Set(["perFleet"]);
export const SCOPE_LIST = new Set(["errorClasses"]);

/** The ISO time a silence ends: a preset id, or "custom" with a local date-time text. */
export function silenceUntil(choice, custom, now = Date.now()) {
  const preset = SILENCE_PRESETS.find((item) => item.id === choice);
  if (preset) return { until: new Date(now + preset.ms).toISOString() };
  const ms = typeof custom === "string" && custom.trim() ? new Date(custom).getTime() : NaN;
  if (!Number.isFinite(ms)) return { problem: "invalid" };
  if (ms <= now) return { problem: "past" };
  return { until: new Date(ms).toISOString() };
}

/** POST /api/telemetry/alerts/:ruleId/ack body: the row's scope, never just the rule. */
export function ackBody(row) {
  return { scopeKey: row.scopeKey };
}

/** POST …/silence body; `until` null clears the silence. */
export function silenceBody(row, until) {
  return { scopeKey: row.scopeKey, until };
}

export function alertPath(ruleId, action) {
  return `/api/telemetry/alerts/${encodeURIComponent(ruleId)}/${action}`;
}

/** Firing rows first (critical first, then the oldest), the order the page lists them in. */
export function sortFiring(rows) {
  const rank = { critical: 0, warning: 1, info: 2 };
  return (Array.isArray(rows) ? rows : []).filter((row) => row && row.state === "firing")
    .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || String(a.since ?? "").localeCompare(String(b.since ?? "")));
}

export function rowKey(row) {
  return `${row.ruleId}:${row.scopeKey}`;
}

/** The scope filter inputs a metric takes (`metrics[]` of GET /alert-rules). */
export function scopeFilters(metric) {
  return Array.isArray(metric?.filters) ? metric.filters : [];
}

export function scopeText(value) {
  return Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? value : value === undefined || value === null ? "" : String(value);
}

/** A rule as form text; a new rule starts from the first metric. */
export function ruleDraft(rule, metrics = []) {
  const base = rule || { metric: metrics[0]?.id || "", op: ">", threshold: "", clearThreshold: null, windowS: 300, forS: 0, minSamples: 0, cooldownS: 1800, severity: "warning", channels: ["inapp"], enabled: true, titleZh: "", titleEn: "", scope: {} };
  const text = (value) => (value === null || value === undefined ? "" : String(value));
  const scope = {};
  for (const [key, value] of Object.entries(base.scope || {})) scope[key] = scopeText(value);
  return {
    metric: base.metric, op: base.op, threshold: text(base.threshold), clearThreshold: text(base.clearThreshold), windowS: text(base.windowS), forS: text(base.forS),
    minSamples: text(base.minSamples), cooldownS: text(base.cooldownS), severity: base.severity, channels: [...(base.channels || [])], enabled: base.enabled !== false,
    titleZh: text(base.titleZh), titleEn: text(base.titleEn), scope,
  };
}

export function scopeBody(draft) {
  const out = {};
  for (const [key, value] of Object.entries(draft.scope || {})) {
    if (SCOPE_BOOL.has(key)) {
      if (value === true || value === "true") out[key] = true;
    } else if (SCOPE_LIST.has(key)) {
      const list = String(value).split(",").map((item) => item.trim()).filter(Boolean);
      if (list.length) out[key] = list;
    } else if (String(value).trim()) {
      out[key] = SCOPE_NUMBER.has(key) ? Number(value) : String(value).trim();
    }
  }
  return out;
}

export function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The request body of a rule form and the number fields that do not parse.
 * A new rule sends everything; an edit sends the changed fields only, and a
 * builtin rule only BUILTIN_EDITABLE. → { body, local: { field: "invalid_type" }, changed }
 */
export function ruleBody(draft, original = null) {
  const builtin = Boolean(original?.builtin);
  const current = {};
  const local = {};
  for (const name of NUMBER_FIELDS) {
    const raw = String(draft[name] ?? "").trim();
    if (!raw) current[name] = name === "clearThreshold" ? null : undefined;
    else if (Number.isFinite(Number(raw))) current[name] = Number(raw);
    else local[name] = "invalid_type";
  }
  Object.assign(current, {
    enabled: Boolean(draft.enabled), severity: draft.severity, channels: [...draft.channels], metric: draft.metric, op: draft.op,
    titleZh: String(draft.titleZh).trim(), titleEn: String(draft.titleEn).trim(), scope: scopeBody(draft),
  });
  const keys = original ? (builtin ? BUILTIN_EDITABLE : Object.keys(current)) : Object.keys(current);
  const body = {};
  for (const key of keys) {
    const value = current[key];
    if (value === undefined && !original) continue;
    if (original) {
      if (value === undefined) continue;
      if (sameJson(value, original[key] ?? (key === "clearThreshold" ? null : undefined))) continue;
    }
    body[key] = value;
  }
  return { body, local, changed: Object.keys(body).length > 0 };
}

/** Splits a writer's `errors[]` into messages by field and the ones without a field of the form. */
export function splitErrors(errors, known = []) {
  const byField = {};
  const other = [];
  for (const item of Array.isArray(errors) ? errors : []) {
    const field = typeof item?.field === "string" ? item.field : "";
    const root = field.split(/[.[]/)[0];
    if (field && (known.includes(field) || known.includes(root))) {
      if (!byField[field]) byField[field] = item;
    } else {
      other.push(item);
    }
  }
  return { byField, other };
}

/** The webhook list as sent back: existing ones keep their masked URL, which the server maps to the stored one. */
export function webhookBody(hooks, edited, drafted) {
  const next = hooks.map((hook) => (hook.id === edited ? drafted : { id: hook.id, url: hook.url, format: hook.format, minSeverity: hook.minSeverity }));
  if (!hooks.some((hook) => hook.id === edited)) next.push(drafted);
  return { alerts: { webhooks: next } };
}

export function newWebhookId(now = Date.now()) {
  return `wh_${now.toString(36)}`;
}
