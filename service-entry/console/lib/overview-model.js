// The pure parts of the Overview page (07 §6.1): the four tiles, the needs-
// attention list, the running-deployment rows and the recent-activity lines.
// They take the API payloads and return plain data, so Node tests drive them
// with the real i18n and formatters; routes/overview.js only renders them.
// Before 04 exists, the tiles fall back to the entry's gateway log and say so.

import { tk } from "./i18n.js";
import { fleetInstanceLifecycle } from "./readiness.js";

/** Tiles 1 and 2 read this many gateway log lines before telemetry exists; the window label says so. */
export const GATEWAY_LINES = 2000;
export const ATTENTION_MAX = 8;
export const ACTIVITY_MAX = 20;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const KEY_EXPIRY_DAYS = 7;
const FAILED_JOB = new Set(["failed", "error"]);
export const STATE_STATUS = Object.freeze({ ready: "ok", loading: "loading", degraded: "warn", crashed: "error" });
const JOB_STATUSES = new Set(["queued", "running", "paused", "success", "failed", "cancelled"]);

function finite(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
}

export function list(value, ...keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function timeOf(value) {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// A {zh,en} / {zh-CN,en-US} object through pick(), or a plain string as it is.
function textOf(value, i18n) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return i18n.pick(value) || "";
  return "";
}

// ---------------------------------------------------------------------------
// Tiles

/**
 * The four StatTile props (07 §6.1). Every tile has a window; a missing figure is null, which the tile shows as "—".
 * @param inputs { summary24, summary1h, live, gpu, gateway, fleet } — the 04 payloads, gpuSummary(live), the gateway-access payload and the fleet
 * @param ctx { t, fmt } — the i18n and formatters of the active locale
 * @returns {Array<{ id, label, value, unit?, denominator?, note, span, source }>} source: telemetry | gateway-log | none
 */
export function buildTiles({ summary24 = null, summary1h = null, live = null, gpu = null, gateway = null, fleet = null } = {}, { t, fmt }) {
  const day = summary24?.current && typeof summary24.current === "object" ? summary24.current : null;
  const hour = summary1h?.current && typeof summary1h.current === "object" ? summary1h.current : null;
  const log = gateway?.totals && typeof gateway.totals === "object" ? gateway.totals : null;
  const lineWindow = t("overview.span.gatewayLines", { count: fmt.integer(GATEWAY_LINES) });

  let requests = null;
  let errors = null;
  let errorRate = null;
  let outputTokens = null;
  let source = "none";
  if (day) {
    source = "telemetry";
    requests = finite(day.requests);
    errorRate = finite(day.errorRate);
    errors = requests !== null && errorRate !== null ? Math.round(requests * errorRate) : null;
    outputTokens = finite(day.outputTokens);
  } else if (log) {
    source = "gateway-log";
    requests = finite(log.requests?.total);
    errors = finite(log.requests?.error);
    errorRate = finite(log.requests?.errorRate);
    outputTokens = finite(log.tokens?.output);
  }
  const span = source === "gateway-log" ? lineWindow : t("overview.span.24h");

  const tps = finite(live?.gateway?.outputTokensPerSec);
  const ttft = hour ? finite(hour.ttftP95Ms) : null;
  const hourRequests = hour ? finite(hour.requests) : null;

  const fleetGpu = fleet?.gpuMemory && finite(fleet.gpuMemory.totalMb) ? { usedMb: finite(fleet.gpuMemory.usedMb), totalMb: finite(fleet.gpuMemory.totalMb), util: null } : null;
  const memory = gpu || fleetGpu;
  const hasMemory = Boolean(memory) && memory.usedMb !== null && memory.usedMb !== undefined;

  return [
    {
      id: "requests",
      label: t("overview.tile.requests"),
      value: requests === null ? null : fmt.integer(requests),
      note: requests !== null && errors !== null ? t("overview.tile.errors", { count: fmt.integer(errors), pct: fmt.percent(errorRate ?? (requests ? errors / requests : 0)) }) : null,
      span,
      source,
    },
    {
      id: "output",
      label: t("overview.tile.output"),
      value: outputTokens === null ? null : fmt.integer(outputTokens),
      note: outputTokens === null ? null : (tps === null ? t("overview.tile.tpsNone") : t("overview.tile.tps", { rate: fmt.rate(tps, "tok/s") })),
      span,
      source,
    },
    {
      id: "ttft",
      label: t("overview.tile.ttft"),
      value: ttft === null ? null : fmt.integer(ttft),
      unit: ttft === null ? undefined : "ms",
      note: !hour ? t("overview.tile.needsTelemetry") : hourRequests === null ? null : t("overview.tile.requestsN", { count: hourRequests }),
      span: t("overview.span.1h"),
      source: hour ? "telemetry" : "none",
    },
    {
      id: "gpu",
      label: t("overview.tile.gpu"),
      value: hasMemory ? fmt.number(memory.usedMb / 1024, 1) : null,
      denominator: hasMemory ? { value: fmt.number(memory.totalMb / 1024, 1), label: "GiB" } : undefined,
      note: hasMemory && finite(memory.util) !== null ? t("overview.tile.util", { pct: `${fmt.integer(Math.round(memory.util))}%` }) : null,
      span: t("overview.span.now"),
      source: gpu ? "telemetry" : hasMemory ? "fleet" : "none",
    },
  ];
}

// ---------------------------------------------------------------------------
// Needs attention

export function managerName(managers, id, i18n) {
  const found = (Array.isArray(managers) ? managers : []).find((item) => item?.id === id);
  return textOf(found?.label, i18n) || id;
}

/**
 * Firing alerts, failed jobs and downloads of the last 24 h, failing doctor checks and keys
 * expiring within 7 days, each with one action link (07 §6.1).
 * @param inputs { alerts, jobs: [{ managerId, data }], downloads, doctor, keys, managers, now }
 * @returns {{ items: Array<{ id, kind, tone, icon, text, detail, href, action }>, more: number }}
 */
export function buildAttention({ alerts = null, jobs = [], downloads = null, doctor = null, keys = null, managers = [], now = Date.now() } = {}, i18n, fmt) {
  const { t } = i18n;
  const items = [];

  for (const row of list(alerts, "rows", "alerts")) {
    if (!row || typeof row !== "object" || (row.state && row.state !== "firing")) continue;
    const since = row.since || row.firedAt;
    items.push({
      id: `alert:${row.ruleId}:${row.scopeKey}`,
      kind: "alert",
      tone: row.severity === "critical" || row.severity === "error" ? "danger" : "warn",
      icon: "bell-ring",
      text: textOf(row.title, i18n) || String(row.ruleId || ""),
      detail: since ? t("overview.attention.alertSince", { time: fmt.relative(since, now) }) : "",
      href: "/alerts",
      action: t("overview.action.viewAlert"),
    });
  }

  for (const entry of Array.isArray(jobs) ? jobs : []) {
    for (const job of list(entry?.data, "jobs")) {
      if (!job || !FAILED_JOB.has(String(job.status || job.state || "").toLowerCase())) continue;
      const at = timeOf(job.finishedAt) ?? timeOf(job.updatedAt) ?? timeOf(job.createdAt);
      if (at !== null && now - at > DAY_MS) continue;
      const reason = textOf(job.error?.title, i18n) || (typeof job.error === "string" ? job.error : textOf(job.error?.message, i18n));
      items.push({
        id: `job:${entry.managerId}:${job.id}`,
        kind: "job",
        tone: "danger",
        icon: "triangle-alert",
        text: t("overview.attention.job", { name: job.title || job.type || job.id }),
        detail: [managerName(managers, entry.managerId, i18n), reason].filter(Boolean).join(" · "),
        href: `/deployments?manager=${encodeURIComponent(entry.managerId)}`,
        action: t("overview.action.viewDeployment"),
      });
    }
  }

  for (const job of list(downloads, "jobs", "items", "rows")) {
    if (!job || String(job.state || job.status || "").toLowerCase() !== "failed") continue;
    const at = timeOf(job.finishedAt) ?? timeOf(job.updatedAt) ?? timeOf(job.createdAt);
    if (at !== null && now - at > DAY_MS) continue;
    items.push({
      id: `download:${job.id}`,
      kind: "download",
      tone: "danger",
      icon: "triangle-alert",
      text: t("overview.attention.download", { name: job.artifact?.repo || job.title || job.id }),
      detail: textOf(job.error?.title, i18n) || textOf(job.error?.message, i18n),
      href: "/models/downloads",
      action: t("overview.action.viewDownloads"),
    });
  }

  for (const check of list(doctor, "checks")) {
    if (!check || check.status !== "fail") continue;
    items.push({
      id: `doctor:${check.id}`,
      kind: "doctor",
      tone: "danger",
      icon: "triangle-alert",
      text: t("overview.attention.doctor", { name: textOf(check.title, i18n) || check.id }),
      detail: typeof check.detail === "string" ? check.detail : "",
      href: "/system/doctor",
      action: t("overview.action.viewDoctor"),
    });
  }

  for (const key of list(keys, "items", "keys")) {
    const at = timeOf(key?.expiresAt);
    if (!key || at === null || key.status === "revoked" || at - now > KEY_EXPIRY_DAYS * DAY_MS) continue;
    items.push({
      id: `key:${key.id}`,
      kind: "key",
      tone: at <= now ? "danger" : "warn",
      icon: "key-round",
      text: t("overview.attention.key", { name: key.name || key.id }),
      detail: t(at <= now ? "overview.attention.keyExpired" : "overview.attention.keyExpires", { time: fmt.relative(at, now) }),
      href: `/access/keys/${encodeURIComponent(key.id)}`,
      action: t("overview.action.viewKey"),
    });
  }

  return { items: items.slice(0, ATTENTION_MAX), more: Math.max(0, items.length - ATTENTION_MAX) };
}

// ---------------------------------------------------------------------------
// Running deployments

function splitFleetId(instance) {
  const id = String(instance.instanceId ?? instance.id ?? "");
  const colon = id.indexOf(":");
  const managerId = String(instance.managerId || instance.manager_engine || instance.engine || (colon > 0 ? id.slice(0, colon) : "") || "");
  const instanceId = colon > 0 ? id.slice(colon + 1) : id;
  return { managerId, instanceId, fleetId: String(instance.fleetId || (managerId ? `${managerId}:${instanceId}` : instanceId)) };
}

/**
 * One row per instance that is not stopped, in fleet order.
 * @returns {Array<{ key, fleetId, managerId, instanceId, state, percent, model, extraModels, engine, port, context, tps }>}
 */
export function deploymentRows(fleet, live = null) {
  const liveBy = new Map(list(live, "instances").filter((item) => item?.fleetId).map((item) => [item.fleetId, item]));
  const rows = [];
  for (const instance of list(fleet, "instances")) {
    if (!instance || typeof instance !== "object") continue;
    const lifecycle = fleetInstanceLifecycle(instance);
    if (lifecycle.key === "stopped") continue;
    const ids = splitFleetId(instance);
    const models = list(instance, "models").filter((model) => model?.id);
    const first = models[0] || {};
    const version = instance.runtime?.version ? `@${instance.runtime.version}` : "";
    const percent = lifecycle.key === "loading" ? finite(instance.lifecycle?.percent) : null;
    rows.push({
      key: ids.fleetId,
      ...ids,
      state: lifecycle.key,
      percent,
      model: String(first.id || instance.containerName || ids.instanceId),
      extraModels: Math.max(0, models.length - 1),
      engine: `${instance.engineId || instance.engineFamily || ids.managerId || "—"}${version}`,
      port: finite(instance.port),
      context: finite(first.contextLength ?? first.maxModelLen ?? first.max_model_len ?? first.context_length ?? first.contextWindow),
      tps: finite(liveBy.get(ids.fleetId)?.outputTps),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Recent activity

/**
 * The newest events as one line each. `events` are bus envelopes ({ id, type, at, data }) from
 * /api/events/recent, or 04 rows ({ id, at, type, severity, title }) from /api/telemetry/events.
 * @returns {Array<{ id, at, icon, tone, text }>}
 */
export function buildActivity(events, i18n, { managers = [] } = {}) {
  const { t, has } = i18n;
  const rows = [];
  for (const [index, event] of list(events, "events", "rows").entries()) {
    if (!event || typeof event !== "object" || !event.type) continue;
    const data = event.data && typeof event.data === "object" ? event.data : {};
    const manager = managerName(managers, data.managerId || event.managerId, i18n);
    let tone = "neutral";
    let icon = "activity";
    let text = "";
    if (event.type === "notification") {
      text = textOf(data.title, i18n);
      tone = data.severity === "error" ? "error" : data.severity === "warn" ? "warn" : data.severity === "success" ? "ok" : "info";
      icon = "bell";
    } else if (event.type === "jobs") {
      const job = list(data, "jobs")[0];
      const status = String(job?.status || job?.state || "");
      text = job ? t("overview.activity.job", {
        manager, title: job.title || job.type || job.id, status: JOB_STATUSES.has(status) ? t(tk("overview.jobStatus.", status)) : status,
      }) : "";
      tone = FAILED_JOB.has(status) ? "error" : status === "success" ? "ok" : "neutral";
      icon = "rocket";
    } else if (event.type === "instances") {
      text = t("overview.activity.instances", { manager, count: list(data, "changed").length + list(data, "removed").length });
      icon = "boxes";
    } else if (event.type === "status") {
      const reasonKey = tk("overview.reason.", data.reason || "");
      text = t("overview.activity.status", { manager, reason: has(reasonKey) ? t(reasonKey) : String(data.reason || "") });
      tone = data.reason === "manager_down" ? "warn" : "neutral";
    } else if (typeof event.title !== "undefined") {
      text = textOf(event.title, i18n);
      tone = event.severity === "critical" || event.severity === "error" ? "error" : event.severity === "warn" ? "warn" : "neutral";
    }
    rows.push({ id: String(event.id ?? `${event.type}:${event.at}:${index}`), at: event.at, ms: timeOf(event.at) ?? 0, order: index, icon, tone, text: text || String(event.type) });
  }
  return rows
    .sort((a, b) => b.ms - a.ms || b.order - a.order)
    .slice(0, ACTIVITY_MAX)
    .map(({ ms, order, ...row }) => row);
}
