"use strict";

// Query layer of the telemetry store (docs/overhaul/04-telemetry.md §3, §11).
//
// Everything below the "parse" section runs inside the store worker, next to
// the DatabaseSync handle: store.call("timeseries", q) hands the already
// normalised query object `q` to the function of that name. The entry never
// builds SQL. parseQuery() turns the HTTP parameters into `q` on the entry
// side and rejects what the API does not document (400 unknown_parameter), so
// the worker functions only ever see whitelisted values.
//
// - Dimension, metric, sort and column names map to fixed SQL fragments or
//   JS accessors; request input only ever travels as bound parameters.
// - Aggregate reads cover [from, to) with tiers (planTiers): the coarsest
//   rollup grain that fits the step for the closed part of the range, finer
//   grains for the edges and raw rows for the live tail that no rollup has
//   closed yet, so a total never depends on how the range was cut.
// - A query that runs past its step budget (2 s) is interrupted with
//   500 query_timeout between statements and row batches (§21).
// - Request counts are 0 only for a covered bucket and null for a collection
//   gap (rollups.requestCounts semantics, §6.4).

const histogram = require("./histogram");
const rollups = require("./rollups");
const energyModule = require("./energy");
const { ERROR_CLASSES, TERMINAL_STATES } = require("./error-class");
const { SOURCE_PROGRAM_LABELS } = require("./source-program");

const { GATEWAY_MS_BUCKETS, DECODE_TPS_BUCKETS, mergeHist, quantile } = histogram;

const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_RANGE_MS = 400 * DAY_MS;
const DEFAULT_RANGE_MS = HOUR_MS;
const MAX_POINTS = 600;
const NICE_STEPS = Object.freeze([10, 30, 60, 300, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400, 604_800]);
const DEFAULT_BUDGET_MS = 2000;
const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;
const DEFAULT_MINUTE_DAYS = 14;
const RAW_FILTER_MAX_RANGE_MS = 14 * DAY_MS;
const FACET_ROW_CAP = 50_000;
const SAMPLE_REQUEST_ROWS = 25;
const ANNOTATION_LIMIT = 200;
const EXPORT_PAGE_ROWS = 1000;
const MAX_FILTER_VALUES = 20;
const MAX_VALUE_CHARS = 200;
const OTHER = "other";

// ---------------------------------------------------------------- errors

class QueryError extends Error {
  constructor(code, message, { status = 400, field, hint } = {}) {
    super(message);
    this.name = "QueryError";
    this.code = code;
    this.status = status;
    if (field) this.field = field;
    if (hint) this.hint = hint;
  }
}

function queryError(code, message, extra) {
  return new QueryError(code, message, extra);
}

// ---------------------------------------------------------------- catalogs

// groupBy / dim names -> the column of the rollup tables (and the alias the
// raw readers give the same expression).
const DIMENSIONS = Object.freeze({
  manager: "manager_id",
  fleet: "fleet_id",
  engine: "engine_id",
  model: "model",
  key: "key_id",
  customer: "customer_id",
  source: "source_program",
  protocol: "protocol",
  status_class: "status_class",
  error_class: "error_class",
});
const OWNER_ONLY_DIMENSIONS = Object.freeze(["key", "customer", "client_ip"]);

// Common filters (§11): name -> kind. Lists are comma separated.
const FILTER_PARAMS = Object.freeze({
  manager_id: "list",
  fleet_id: "list",
  engine_id: "list",
  model: "list",
  key_id: "list",
  customer_id: "list",
  source_program: "list",
  protocol: "list",
  status_class: "list",
  error_class: "list",
  ingress: "list",
  stream: "bool",
});
const RAW_ONLY_FILTERS = Object.freeze(["ingress", "stream"]);
const RUNTIME_FILTERS = Object.freeze(["manager_id", "fleet_id", "engine_id", "model"]);
const STATUS_CLASSES = Object.freeze(["2xx", "3xx", "4xx", "5xx", "none"]);
const PROTOCOLS = Object.freeze(["openai", "claude", "opencode", "tts", "search", "mcp", "external"]);
const INGRESS_VALUES = Object.freeze(["entry", "public", "direct", "import:entry", "import:manager"]);
const SEVERITIES = Object.freeze(["info", "warning", "critical"]);
const ANNOTATION_KINDS = Object.freeze(["launch", "instance", "container", "manager", "config", "benchmark", "alert"]);
const EXPORT_KINDS = Object.freeze(["requests", "rollup", "events"]);
const GRAINS = Object.freeze(["1m", "1h", "1d"]);
const GRAIN_MS = Object.freeze({ "1m": MINUTE_MS, "1h": HOUR_MS, "1d": DAY_MS });

const GROUP_BY_BY_FAMILY = Object.freeze({
  req: Object.freeze(Object.keys(DIMENSIONS)),
  rt: Object.freeze(["fleet", "model"]),
  gpu: Object.freeze(["gpu", "reason"]),
});

const REQ_UNITS = Object.freeze({ count: "requests", tokens: "tokens", ratio: "ratio", ms: "ms" });
const ERROR_CLASS_LABELS = Object.freeze({
  none: { zh: "成功", en: "Succeeded" },
  client_abort: { zh: "客户端中止", en: "Client aborted" },
  upstream_timeout: { zh: "上游超时", en: "Upstream timeout" },
  auth_failed: { zh: "鉴权失败", en: "Authentication failed" },
  auth_banned: { zh: "鉴权失败被封禁", en: "Banned after failed authentication" },
  forbidden: { zh: "无权访问", en: "Forbidden" },
  rate_limited: { zh: "触发限流", en: "Rate limited" },
  quota_denied: { zh: "额度不足", en: "Quota denied" },
  billing_unavailable: { zh: "计费不可用", en: "Billing unavailable" },
  no_runtime: { zh: "没有可用的模型实例", en: "No runtime available" },
  config_error: { zh: "配置错误", en: "Configuration error" },
  context_overflow: { zh: "上下文超长", en: "Context too long" },
  bad_request: { zh: "请求不合法", en: "Bad request" },
  upstream_unreachable: { zh: "上游不可达", en: "Upstream unreachable" },
  upstream_5xx: { zh: "上游报错", en: "Upstream error" },
  stream_error: { zh: "流式输出中断", en: "Stream interrupted" },
  internal: { zh: "入口内部错误", en: "Entry internal error" },
});
const NON_ERROR_CLASSES = new Set(["none", "client_abort"]);

// ---------------------------------------------------------------- helpers

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function iso(ms) {
  const number = numberOrNull(ms);
  return number === null ? null : new Date(number).toISOString();
}

function snakeToCamel(name) {
  return String(name).replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase());
}

function parseJson(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(text, keys) {
  if (text === undefined || text === null || text === "") return null;
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(String(text), "base64url").toString("utf8"));
  } catch {
    parsed = null;
  }
  if (!isPlainObject(parsed) || keys.some((key) => !Number.isFinite(Number(parsed[key])))) {
    throw queryError("invalid_cursor", "The cursor is not valid.", { field: "cursor" });
  }
  return Object.fromEntries(keys.map((key) => [key, Number(parsed[key])]));
}

function likePrefix(text) {
  return `${String(text).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// ---------------------------------------------------------------- parse (entry side)

const FILTER_NAMES = Object.keys(FILTER_PARAMS);
const RANGE_PARAMS = ["from", "to"];

const ENDPOINTS = {
  live: { allowed: [], parse: () => ({}) },
  status: { allowed: [], parse: () => ({}) },
  baseline: { allowed: [], parse: () => ({}) },
  summary: {
    allowed: [...RANGE_PARAMS, "compare", ...FILTER_NAMES],
    parse(params, ctx) {
      const compare = params.compare === undefined ? "previous" : params.compare;
      if (compare !== "previous" && compare !== "none") throw badValue("compare", "compare must be previous or none.");
      const range = parseRange(params, ctx);
      const filters = parseFilters(params);
      assertRawFilterRange(filters, range, true);
      return { ...range, compare, filters, ...contextOf(ctx) };
    },
  },
  timeseries: {
    allowed: [...RANGE_PARAMS, "metrics", "step", "groupBy", "top", "annotate", ...FILTER_NAMES],
    parse(params, ctx) {
      const range = parseRange(params, ctx);
      const metrics = parseList(params.metrics, "metrics", { required: true, max: 6, unique: true });
      for (const id of metrics) {
        if (!Object.prototype.hasOwnProperty.call(METRICS, id)) throw badValue("metrics", `Unknown metric: ${shortText(id)}.`, "unknown_metric");
      }
      let groupBy = null;
      if (params.groupBy !== undefined) {
        groupBy = String(params.groupBy);
        const allowedEverywhere = metrics.every((id) => GROUP_BY_BY_FAMILY[METRICS[id].family].includes(groupBy));
        const reasonOnly = groupBy !== "reason" || metrics.every((id) => id === "gpu.throttle_seconds");
        if (!allowedEverywhere || !reasonOnly) throw badValue("groupBy", `groupBy=${shortText(groupBy)} is not available for these metrics.`, "group_by_not_allowed");
      }
      const top = params.top === undefined ? 8 : parseInteger(params.top, "top", 1, 20);
      const annotate = parseList(params.annotate, "annotate", { max: ANNOTATION_KINDS.length, unique: true });
      for (const kind of annotate) {
        if (!ANNOTATION_KINDS.includes(kind)) throw badValue("annotate", `Unknown annotation kind: ${shortText(kind)}.`, "unknown_annotation");
      }
      const stepSec = params.step === undefined ? null : parseInteger(params.step, "step", 1, 7 * 86_400);
      const filters = parseFilters(params);
      const families = new Set(metrics.map((id) => METRICS[id].family));
      assertRawFilterRange(filters, range, families.has("req"));
      return { ...range, metrics, groupBy, top, annotate, stepSec, filters, ...contextOf(ctx) };
    },
  },
  breakdown: {
    allowed: [...RANGE_PARAMS, "dim", "metrics", "sort", "limit", "spark", ...FILTER_NAMES],
    parse(params, ctx) {
      const range = parseRange(params, ctx);
      const dim = params.dim === undefined ? "" : String(params.dim);
      if (!dim) throw badValue("dim", "dim is required.", "missing_parameter");
      if (dim !== "client_ip" && !Object.prototype.hasOwnProperty.call(DIMENSIONS, dim)) throw badValue("dim", `Unknown dimension: ${shortText(dim)}.`, "unknown_dimension");
      const metrics = params.metrics === undefined ? DEFAULT_BREAKDOWN_METRICS.slice() : parseList(params.metrics, "metrics", { max: 12, unique: true });
      for (const id of metrics) {
        if (!Object.prototype.hasOwnProperty.call(BREAKDOWN_METRICS, id)) throw badValue("metrics", `Unknown breakdown metric: ${shortText(id)}.`, "unknown_metric");
      }
      let sort = "-requests";
      if (params.sort !== undefined) {
        const text = String(params.sort);
        const id = text.startsWith("-") ? text.slice(1) : text;
        if (!Object.prototype.hasOwnProperty.call(BREAKDOWN_METRICS, id)) throw badValue("sort", `Unknown sort: ${shortText(text)}.`, "unknown_sort");
        sort = text.startsWith("-") ? text : id;
      }
      const limit = params.limit === undefined ? 50 : parseInteger(params.limit, "limit", 1, 200);
      const spark = params.spark === undefined ? false : parseBool(params.spark, "spark");
      const filters = parseFilters(params);
      if (dim === "client_ip" && range.to - range.from > RAW_FILTER_MAX_RANGE_MS) {
        throw badValue("from", "dim=client_ip reads request rows, which are kept for a limited time; use a range of at most 14 days.", "range_too_large");
      }
      assertRawFilterRange(filters, range, true);
      return { ...range, dim, metrics, sort, limit, spark, filters, ...contextOf(ctx) };
    },
  },
  requests: {
    allowed: [...RANGE_PARAMS, ...FILTER_NAMES, "terminal_state", "client_ip", "min_duration_ms", "min_ttft_ms", "min_output_tokens", "q", "limit", "cursor", "facets"],
    parse(params, ctx) {
      const range = parseRange(params, ctx);
      const filters = parseFilters(params);
      let terminalState = [];
      if (params.terminal_state !== undefined) {
        terminalState = parseList(params.terminal_state, "terminal_state", { max: TERMINAL_STATES.length, unique: true });
        for (const value of terminalState) {
          if (!TERMINAL_STATES.includes(value)) throw badValue("terminal_state", `Unknown terminal state: ${shortText(value)}.`, "invalid_value");
        }
      }
      const out = { ...range, rangeExplicit: params.from !== undefined || params.to !== undefined, filters, terminalState, ...contextOf(ctx) };
      if (params.client_ip !== undefined) out.clientIp = parseText(params.client_ip, "client_ip", 64);
      for (const [name, field] of [["min_duration_ms", "minDurationMs"], ["min_ttft_ms", "minTtftMs"], ["min_output_tokens", "minOutputTokens"]]) {
        if (params[name] !== undefined) out[field] = parseInteger(params[name], name, 0, 2 ** 40);
      }
      if (params.q !== undefined) {
        const text = parseText(params.q, "q", 128);
        if (!/^[A-Za-z0-9._:/-]+$/.test(text)) throw badValue("q", "q must be a request id, or a prefix of one.", "invalid_value");
        out.q = text;
      }
      out.limit = params.limit === undefined ? 100 : parseInteger(params.limit, "limit", 1, 500);
      out.cursor = decodeCursor(params.cursor, ["t", "id"]);
      out.facets = params.facets === undefined ? false : parseBool(params.facets, "facets");
      return out;
    },
  },
  events: {
    allowed: [...RANGE_PARAMS, "type", "severity", "fleet_id", "limit", "cursor"],
    parse(params, ctx) {
      const range = parseRange(params, ctx);
      const types = parseList(params.type, "type", { max: 20, unique: true });
      for (const type of types) {
        if (!/^[a-z][a-z0-9_.]{0,63}$/.test(type)) throw badValue("type", `Invalid event type prefix: ${shortText(type)}.`, "invalid_value");
      }
      const severity = parseList(params.severity, "severity", { max: 3, unique: true });
      for (const value of severity) {
        if (!SEVERITIES.includes(value)) throw badValue("severity", `Unknown severity: ${shortText(value)}.`, "invalid_value");
      }
      const fleetId = parseList(params.fleet_id, "fleet_id", { max: MAX_FILTER_VALUES, unique: true });
      return {
        ...range,
        types,
        severity,
        fleetId,
        limit: params.limit === undefined ? 100 : parseInteger(params.limit, "limit", 1, 500),
        cursor: decodeCursor(params.cursor, ["t", "id"]),
        ...contextOf(ctx),
      };
    },
  },
  energy: {
    allowed: [...RANGE_PARAMS, "groupBy"],
    parse(params, ctx) {
      const groupBy = params.groupBy === undefined ? "hour" : String(params.groupBy);
      if (!["hour", "day", "fleet", "model", "gpu"].includes(groupBy)) throw badValue("groupBy", `Unknown groupBy: ${shortText(groupBy)}.`, "invalid_value");
      return { ...parseRange(params, ctx), groupBy, ...contextOf(ctx) };
    },
  },
  lifecycle: { allowed: RANGE_PARAMS, parse: (params, ctx) => ({ ...parseRange(params, ctx), ...contextOf(ctx) }) },
  launches: {
    allowed: [...RANGE_PARAMS, "groupBy"],
    parse(params, ctx) {
      const groupBy = params.groupBy === undefined ? "model" : String(params.groupBy);
      if (!["model", "recipe", "engine"].includes(groupBy)) throw badValue("groupBy", `Unknown groupBy: ${shortText(groupBy)}.`, "invalid_value");
      return { ...parseRange(params, ctx), groupBy, ...contextOf(ctx) };
    },
  },
  export: {
    allowed: [...RANGE_PARAMS, "kind", "grain", "format", ...FILTER_NAMES],
    parse(params, ctx) {
      const kind = params.kind === undefined ? "requests" : String(params.kind);
      if (!EXPORT_KINDS.includes(kind)) throw badValue("kind", `Unknown export kind: ${shortText(kind)}.`, "invalid_value");
      const grain = params.grain === undefined ? "1h" : String(params.grain);
      if (!GRAINS.includes(grain)) throw badValue("grain", `Unknown grain: ${shortText(grain)}.`, "invalid_value");
      const format = params.format === undefined ? "csv" : String(params.format);
      if (format !== "csv" && format !== "jsonl") throw badValue("format", "format must be csv or jsonl.", "invalid_value");
      const filters = parseFilters(params);
      if (kind === "rollup") {
        const raw = RAW_ONLY_FILTERS.find((name) => filters[name] !== undefined);
        if (raw) throw badValue(raw, `${raw} cannot filter rollups; export kind=requests instead.`, "filter_not_available");
      }
      return { ...parseRange(params, ctx), kind, grain, format, filters, maxRows: ctx.exportMaxRows, ...contextOf(ctx) };
    },
  },
};

function shortText(value) {
  return String(value).replace(/[^\x20-\x7e]/g, "?").slice(0, 60);
}

function badValue(field, message, code = "invalid_value") {
  return queryError(code, message, { field });
}

function contextOf(ctx) {
  return {
    now: ctx.now,
    tzOffsetMinutes: ctx.tzOffsetMinutes,
    sampleIntervalMs: ctx.sampleIntervalMs,
    minuteDays: ctx.minuteDays,
    energy: ctx.energy,
    budgetMs: ctx.budgetMs,
  };
}

function parseInteger(value, field, min, max) {
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) throw badValue(field, `${field} must be an integer.`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw badValue(field, `${field} must be between ${min} and ${max}.`, "out_of_range");
  return number;
}

function parseBool(value, field) {
  const text = String(value).trim().toLowerCase();
  if (text === "1" || text === "true") return true;
  if (text === "0" || text === "false") return false;
  throw badValue(field, `${field} must be 1 or 0.`);
}

function parseText(value, field, max) {
  const text = String(value).trim();
  if (!text || text.length > max || /[\u0000-\u001f]/.test(text)) throw badValue(field, `${field} is not valid.`);
  return text;
}

function parseList(value, field, { required = false, max = MAX_FILTER_VALUES, unique = false } = {}) {
  if (value === undefined) {
    if (required) throw badValue(field, `${field} is required.`, "missing_parameter");
    return [];
  }
  const items = String(value).split(",").map((item) => item.trim());
  if (items.some((item) => item.length > MAX_VALUE_CHARS || /[\u0000-\u001f]/.test(item))) throw badValue(field, `${field} has an invalid value.`);
  const kept = items.filter(Boolean);
  if (required && !kept.length) throw badValue(field, `${field} is required.`, "missing_parameter");
  if (kept.length > max) throw badValue(field, `${field} takes at most ${max} values.`, "out_of_range");
  return unique ? [...new Set(kept)] : kept;
}

function parseTimeValue(value, field, now) {
  const text = String(value).trim();
  let ms = null;
  if (/^\d{10,16}$/.test(text)) ms = Number(text);
  else if (/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/.test(text)) {
    // A bare date or a time without an offset is UTC, like the rollup buckets.
    const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(text.slice(10)) ? text : `${text.length === 10 ? `${text}T00:00:00` : text.replace(" ", "T")}Z`;
    ms = Date.parse(normalized);
  }
  if (ms === null || !Number.isFinite(ms)) throw badValue(field, `${field} must be an ISO 8601 time or epoch milliseconds.`);
  if (ms < 0 || ms > now + 366 * DAY_MS) throw badValue(field, `${field} is out of range.`, "out_of_range");
  return ms;
}

function parseRange(params, ctx) {
  const now = ctx.now;
  const to = params.to === undefined ? now : parseTimeValue(params.to, "to", now);
  const from = params.from === undefined ? to - DEFAULT_RANGE_MS : parseTimeValue(params.from, "from", now);
  if (from >= to) throw badValue("from", "from must be before to.", "invalid_range");
  if (to - from > MAX_RANGE_MS) throw badValue("from", "The range may be at most 400 days.", "range_too_large");
  return { from, to };
}

function parseFilters(params) {
  const filters = {};
  for (const [name, kind] of Object.entries(FILTER_PARAMS)) {
    if (params[name] === undefined) continue;
    if (kind === "bool") {
      filters[name] = parseBool(params[name], name) ? 1 : 0;
      continue;
    }
    const values = parseList(params[name], name, { unique: true });
    if (!values.length) continue;
    if (name === "status_class") {
      for (const value of values) if (!STATUS_CLASSES.includes(value)) throw badValue(name, `Unknown status class: ${shortText(value)}.`);
    } else if (name === "error_class") {
      for (const value of values) if (!ERROR_CLASSES.includes(value)) throw badValue(name, `Unknown error class: ${shortText(value)}.`);
    } else if (name === "protocol") {
      for (const value of values) if (!PROTOCOLS.includes(value)) throw badValue(name, `Unknown protocol: ${shortText(value)}.`);
    } else if (name === "ingress") {
      for (const value of values) if (!INGRESS_VALUES.includes(value)) throw badValue(name, `Unknown ingress: ${shortText(value)}.`);
    }
    filters[name] = values;
  }
  return filters;
}

// ingress and stream are not rollup dimensions, so they read request rows,
// which are kept for a limited time.
function assertRawFilterRange(filters, range, usesRequests) {
  if (!usesRequests) return;
  if (RAW_ONLY_FILTERS.some((name) => filters[name] !== undefined) && range.to - range.from > RAW_FILTER_MAX_RANGE_MS) {
    throw badValue("from", "The ingress and stream filters read request rows; use a range of at most 14 days.", "range_too_large");
  }
}

// Turns URLSearchParams (or a plain object) into the normalised query of an
// endpoint. options: {now, tzOffsetMinutes, sampleIntervalMs, minuteDays,
// energy, exportMaxRows, budgetMs}.
function parseQuery(endpoint, searchParams, options = {}) {
  const spec = ENDPOINTS[endpoint];
  if (!spec) throw queryError("unknown_endpoint", "Unknown telemetry endpoint.", { status: 404 });
  const entries = searchParams && typeof searchParams.entries === "function" ? [...searchParams.entries()] : Object.entries(searchParams || {});
  const params = {};
  for (const [key, value] of entries) {
    if (!spec.allowed.includes(key)) throw queryError("unknown_parameter", `Unknown parameter: ${shortText(key)}.`, { field: shortText(key) });
    if (Object.prototype.hasOwnProperty.call(params, key)) throw queryError("duplicate_parameter", `Parameter given twice: ${key}.`, { field: key });
    params[key] = String(value);
  }
  const now = numberOrNull(options.now) ?? Date.now();
  const tz = options.tzOffsetMinutes === undefined || options.tzOffsetMinutes === null
    ? rollups.hostTimezoneOffsetMinutes()
    : rollups.normalizeTimezoneOffset(options.tzOffsetMinutes);
  const ctx = {
    now,
    tzOffsetMinutes: tz,
    sampleIntervalMs: numberOrNull(options.sampleIntervalMs) || DEFAULT_SAMPLE_INTERVAL_MS,
    minuteDays: numberOrNull(options.minuteDays) || DEFAULT_MINUTE_DAYS,
    energy: isPlainObject(options.energy) ? options.energy : {},
    exportMaxRows: numberOrNull(options.exportMaxRows) || 200_000,
    budgetMs: numberOrNull(options.budgetMs) || DEFAULT_BUDGET_MS,
  };
  return spec.parse(params, ctx);
}

// ---------------------------------------------------------------- db helpers

const STATEMENTS = new WeakMap();

function prepare(db, sql) {
  let cache = STATEMENTS.get(db);
  if (!cache) {
    cache = new Map();
    STATEMENTS.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    // The cache is bounded by the fixed set of fragments; filter value lists
    // change the placeholder count only, so cap it anyway.
    if (cache.size > 400) cache.clear();
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

function createBudget(ms) {
  const limit = numberOrNull(ms) || DEFAULT_BUDGET_MS;
  const deadline = Date.now() + limit;
  let ticks = 0;
  function expire() {
    throw queryError("query_timeout", "The query took too long and was stopped.", {
      status: 500,
      hint: "Use a shorter time range or add a filter.",
    });
  }
  return {
    // Cheap: looks at the clock every 256th call.
    tick() {
      ticks += 1;
      if ((ticks & 255) === 0 && Date.now() > deadline) expire();
    },
    check() {
      if (Date.now() > deadline) expire();
    },
  };
}

function readState(db, name) {
  const row = prepare(db, "SELECT value FROM collector_state WHERE name = ?").get(name);
  return row ? parseJson(row.value) : null;
}

function readWatermarks(db) {
  const marks = {};
  for (const grain of GRAINS) {
    const state = readState(db, `rollup.${grain}`);
    const value = Number(state && state.watermark);
    marks[grain] = state && Number.isFinite(value) ? value : null;
  }
  return marks;
}

function inClause(expression, values) {
  const list = values.filter((value) => value !== "");
  const wantsEmpty = list.length !== values.length;
  const parts = [];
  const params = [];
  if (list.length) {
    parts.push(`${expression} IN (${list.map(() => "?").join(", ")})`);
    params.push(...list);
  }
  if (wantsEmpty) parts.push(`(${expression} IS NULL OR ${expression} = '')`);
  return { sql: parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0], params };
}

// ---------------------------------------------------------------- tiers

function alignDown(grain, at, calendar) {
  if (grain === "1d") return calendar.dayOf(at);
  const size = GRAIN_MS[grain];
  return Math.floor(at / size) * size;
}

function alignUp(grain, at, calendar) {
  const down = alignDown(grain, at, calendar);
  if (down === at) return at;
  return grain === "1d" ? calendar.dayEnd(down) : down + GRAIN_MS[grain];
}

// Splits [from, to) into segments that read the coarsest closed rollup grain
// first and finer grains, then raw rows, for what is left over.
function planTiers(from, to, grains, marks, calendar) {
  function split(start, end, rest) {
    if (start >= end) return [];
    if (!rest.length) return [{ source: "raw", from: start, to: end }];
    const grain = rest[0];
    const closed = marks[grain];
    const limit = closed === null || closed === undefined ? Number.NEGATIVE_INFINITY : Math.min(end, closed);
    const innerStart = alignUp(grain, start, calendar);
    const innerEnd = alignDown(grain, limit, calendar);
    const next = rest.slice(1);
    if (!(innerEnd > innerStart)) return split(start, end, next);
    return [
      ...split(start, innerStart, next),
      { source: grain, from: innerStart, to: innerEnd },
      ...split(innerEnd, end, next),
    ];
  }
  return split(from, to, grains);
}

function eligibleGrains(stepMs) {
  const grains = [];
  for (const grain of ["1d", "1h", "1m"]) {
    if (stepMs >= GRAIN_MS[grain] && stepMs % GRAIN_MS[grain] === 0) grains.push(grain);
  }
  return grains;
}

function stepOrigin(from, stepMs, tzMs) {
  return Math.floor((from + tzMs) / stepMs) * stepMs - tzMs;
}

function pointCount(from, to, stepMs, tzMs) {
  return Math.ceil((to - stepOrigin(from, stepMs, tzMs)) / stepMs);
}

function resolveStep(q) {
  const tzMs = q.tzOffsetMinutes * MINUTE_MS;
  const minSeconds = Math.max(1, Math.ceil((q.to - q.from) / SECOND_MS / MAX_POINTS));
  let step = q.stepSec ? Math.max(q.stepSec, minSeconds) : NICE_STEPS.find((candidate) => candidate >= minSeconds) || NICE_STEPS[NICE_STEPS.length - 1];
  if (step >= 60 && step % 60) step = Math.ceil(step / 60) * 60;
  // Minute rows are pruned after minuteDays; older data exists hourly only.
  if (q.from < q.now - (q.minuteDays || DEFAULT_MINUTE_DAYS) * DAY_MS && step % 3600) step = Math.max(3600, Math.ceil(step / 3600) * 3600);
  while (pointCount(q.from, q.to, step * SECOND_MS, tzMs) > MAX_POINTS) {
    const bigger = NICE_STEPS.find((candidate) => candidate > step && candidate % (step >= 3600 ? 3600 : step >= 60 ? 60 : 1) === 0);
    step = bigger || step * 2;
  }
  return step;
}

// ---------------------------------------------------------------- accumulators

function boundIndex(bounds, value) {
  for (let index = 0; index < bounds.length; index += 1) {
    const bound = bounds[index];
    if (bound === "+Inf" || value <= bound) return index;
  }
  return bounds.length - 1;
}

// Cumulative counts, like the rollup histogram columns.
function observeCounts(counts, bounds, value) {
  const number = numberOrNull(value);
  if (number === null) return counts;
  const out = counts || new Array(bounds.length).fill(0);
  for (let index = boundIndex(bounds, number); index < out.length; index += 1) out[index] += 1;
  return out;
}

function addCounts(target, counts, length) {
  if (!Array.isArray(counts) || counts.length !== length) return target;
  const out = target || new Array(length).fill(0);
  for (let index = 0; index < length; index += 1) out[index] += Number(counts[index]) || 0;
  return out;
}

function countsQuantile(counts, bounds, q) {
  if (!counts) return null;
  return round(quantile({ le: bounds, counts }, q));
}

function minOf(current, value) {
  const number = numberOrNull(value);
  if (number === null) return current;
  return current === null || number < current ? number : current;
}

function maxOf(current, value) {
  const number = numberOrNull(value);
  if (number === null) return current;
  return current === null || number > current ? number : current;
}

function sumHistCounts(a, b, length) {
  return addCounts(a ? a.slice() : null, b, length);
}

// requests family -----------------------------------------------------------

function newReq() {
  return {
    requests: 0, errors: 0, aborts: 0, prompt: 0, cached: 0, output: 0, estimated: 0, finLen: 0,
    durSum: 0, ttftSum: 0, ttftN: 0, decSum: 0, decN: 0,
    ttft: null, dur: null, dec: null, first: null, last: null,
  };
}

function addReqRaw(acc, row, ctx) {
  acc.requests += 1;
  if (!NON_ERROR_CLASSES.has(row.error_class)) acc.errors += 1;
  if (row.terminal_state === "client_abort") acc.aborts += 1;
  acc.prompt += numberOrNull(row.prompt_tokens) || 0;
  acc.cached += numberOrNull(row.cached_tokens) || 0;
  acc.output += numberOrNull(row.output_tokens) || 0;
  if (row.usage_source === "estimated") acc.estimated += 1;
  if (row.finish_reason === "length") acc.finLen += 1;
  acc.durSum += numberOrNull(row.duration_ms) || 0;
  const ttft = numberOrNull(row.ttft_ms);
  if (ttft !== null) {
    acc.ttftSum += ttft;
    acc.ttftN += 1;
  }
  const decode = numberOrNull(row.decode_tps);
  if (decode !== null) {
    acc.decSum += decode;
    acc.decN += 1;
  }
  if (ctx.needHist) {
    acc.dur = observeCounts(acc.dur, GATEWAY_MS_BUCKETS, row.duration_ms);
    acc.ttft = observeCounts(acc.ttft, GATEWAY_MS_BUCKETS, ttft);
    acc.dec = observeCounts(acc.dec, DECODE_TPS_BUCKETS, decode);
  }
  acc.first = minOf(acc.first, row.t);
  acc.last = maxOf(acc.last, row.t);
}

function addReqRollup(acc, row, ctx) {
  const requests = Number(row.requests) || 0;
  acc.requests += requests;
  if (!NON_ERROR_CLASSES.has(row.error_class)) acc.errors += requests;
  acc.aborts += Number(row.client_aborts) || 0;
  acc.prompt += Number(row.prompt_tokens) || 0;
  acc.cached += Number(row.cached_tokens) || 0;
  acc.output += Number(row.output_tokens) || 0;
  acc.estimated += Number(row.estimated_usage) || 0;
  acc.finLen += Number(row.finish_length) || 0;
  acc.durSum += Number(row.duration_ms_sum) || 0;
  acc.ttftSum += Number(row.ttft_ms_sum) || 0;
  acc.ttftN += Number(row.ttft_n) || 0;
  acc.decSum += Number(row.decode_tps_sum) || 0;
  acc.decN += Number(row.decode_tps_n) || 0;
  if (ctx.needHist) {
    acc.dur = addCounts(acc.dur, parseJson(row.duration_hist), GATEWAY_MS_BUCKETS.length);
    acc.ttft = addCounts(acc.ttft, parseJson(row.ttft_hist), GATEWAY_MS_BUCKETS.length);
    acc.dec = addCounts(acc.dec, parseJson(row.decode_hist), DECODE_TPS_BUCKETS.length);
  }
  if (requests > 0) {
    acc.first = minOf(acc.first, row.bucket);
    acc.last = maxOf(acc.last, row.bucket);
  }
}

function mergeReq(a, b) {
  const out = newReq();
  for (const name of Object.keys(out)) {
    if (name === "first") out.first = minOf(minOf(null, a.first), b.first);
    else if (name === "last") out.last = maxOf(maxOf(null, a.last), b.last);
    else if (name === "ttft" || name === "dur" || name === "dec") {
      const length = name === "dec" ? DECODE_TPS_BUCKETS.length : GATEWAY_MS_BUCKETS.length;
      out[name] = sumHistCounts(sumHistCounts(null, a[name], length), b[name], length);
    } else out[name] = a[name] + b[name];
  }
  return out;
}

const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);

// Per-bucket (not cumulative) counts for the heatmap.
function perBucket(counts) {
  if (!counts) return null;
  return counts.map((value, index) => value - (index ? counts[index - 1] : 0));
}

// runtime family -----------------------------------------------------------

const RT_KINDS = Object.freeze(["ttft", "e2e", "itl", "tpot", "queue"]);
const RT_PCT_COLUMNS = Object.freeze({
  ttft_p50: "ttft_p50_ms", ttft_p95: "ttft_p95_ms", ttft_p99: "ttft_p99_ms",
  e2e_p50: "e2e_p50_ms", e2e_p95: "e2e_p95_ms",
  itl_p50: "itl_p50_ms", itl_p95: "itl_p95_ms",
  tpot_p50: "tpot_p50_ms", queue_p95: "queue_p95_ms",
});

function newRt() {
  return {
    n: 0, failures: 0, intervalMs: 0, rateMs: 0, idleMs: 0,
    dReq: 0, dPrompt: 0, dCached: 0, dOutput: 0, dDraft: 0, dAccept: 0,
    rate: { prompt: [0, 0], output: [0, 0], rpm: [0, 0] },
    run: [0, 0], runMax: null, wait: [0, 0], waitMax: null, kv: [0, 0], kvMax: null,
    pct: {}, hists: {}, energy: 0, idleEnergy: 0,
  };
}

function addWeighted(pair, value, weight) {
  const number = numberOrNull(value);
  if (number === null || !(weight > 0)) return;
  pair[0] += number * weight;
  pair[1] += weight;
}

function addPct(acc, key, value, weight) {
  const number = numberOrNull(value);
  if (number === null || !(weight > 0)) return;
  const pair = acc.pct[key] || (acc.pct[key] = [0, 0]);
  pair[0] += number * weight;
  pair[1] += weight;
}

function addRtHist(acc, kind, hist, unit) {
  if (!hist) return;
  let parsed = null;
  try {
    parsed = mergeHist(null, hist);
  } catch {
    return;
  }
  if (!parsed) return;
  const slots = acc.hists[kind] || (acc.hists[kind] = {});
  const key = `${hist.unit === "ms" || hist.unit === "s" ? hist.unit : unit}|${JSON.stringify(parsed.le)}`;
  slots[key] = slots[key] ? mergeHist(slots[key], parsed) : parsed;
}

function addRtRaw(acc, row, ctx) {
  acc.n += 1;
  if (!row.scrape_ok) {
    acc.failures += 1;
    return;
  }
  const interval = numberOrNull(row.interval_ms) ?? ctx.sampleIntervalMs;
  acc.intervalMs += interval;
  if (row.idle) acc.idleMs += interval;
  if (numberOrNull(row.d_output_tokens) !== null) {
    acc.rateMs += interval;
    acc.dReq += numberOrNull(row.d_requests) || 0;
    acc.dPrompt += numberOrNull(row.d_prompt_tokens) || 0;
    acc.dCached += numberOrNull(row.d_cached_tokens) || 0;
    acc.dOutput += numberOrNull(row.d_output_tokens) || 0;
  } else {
    addWeighted(acc.rate.prompt, row.prompt_tps, interval);
    addWeighted(acc.rate.output, row.output_tps, interval);
    addWeighted(acc.rate.rpm, row.rpm, interval);
  }
  acc.dDraft += numberOrNull(row.d_spec_draft_tokens) || 0;
  acc.dAccept += numberOrNull(row.d_spec_accepted_tokens) || 0;
  addWeighted(acc.run, row.running, 1);
  acc.runMax = maxOf(acc.runMax, row.running);
  addWeighted(acc.wait, row.waiting, 1);
  acc.waitMax = maxOf(acc.waitMax, row.waiting);
  addWeighted(acc.kv, row.kv_usage, 1);
  acc.kvMax = maxOf(acc.kvMax, row.kv_usage);
  const energy = numberOrNull(row.energy_wh) || 0;
  acc.energy += energy;
  if (row.idle) acc.idleEnergy += energy;
  if (ctx.needHist) {
    for (const [key, column] of Object.entries(RT_PCT_COLUMNS)) addPct(acc, key, row[column], 1);
    const hist = parseJson(row.hist);
    const unit = row.latency_source === "gateway" ? "ms" : "s";
    if (isPlainObject(hist)) for (const kind of RT_KINDS) addRtHist(acc, kind, hist[kind], unit);
  }
}

function addRtRollup(acc, row, ctx) {
  const samples = Number(row.sample_count) || 0;
  acc.n += samples;
  acc.failures += Number(row.scrape_failures) || 0;
  const interval = Number(row.interval_ms_sum) || 0;
  acc.intervalMs += interval;
  acc.idleMs += (Number(row.idle_seconds) || 0) * 1000;
  if (numberOrNull(row.d_output_tokens) !== null) {
    acc.rateMs += interval;
    acc.dReq += numberOrNull(row.d_requests) || 0;
    acc.dPrompt += numberOrNull(row.d_prompt_tokens) || 0;
    acc.dCached += numberOrNull(row.d_cached_tokens) || 0;
    acc.dOutput += numberOrNull(row.d_output_tokens) || 0;
  }
  acc.dDraft += numberOrNull(row.d_spec_draft_tokens) || 0;
  acc.dAccept += numberOrNull(row.d_spec_accepted_tokens) || 0;
  addWeighted(acc.run, row.running_avg, samples);
  acc.runMax = maxOf(acc.runMax, row.running_max);
  addWeighted(acc.wait, row.waiting_avg, samples);
  acc.waitMax = maxOf(acc.waitMax, row.waiting_max);
  addWeighted(acc.kv, row.kv_usage_avg, samples);
  acc.kvMax = maxOf(acc.kvMax, row.kv_usage_max);
  const energy = numberOrNull(row.energy_wh) || 0;
  acc.energy += energy;
  // Rollups keep the idle time, not the idle energy: split the energy by it.
  if (interval > 0) acc.idleEnergy += energy * Math.min(1, ((Number(row.idle_seconds) || 0) * 1000) / interval);
  if (ctx.needHist) {
    for (const [key, column] of Object.entries(RT_PCT_COLUMNS)) addPct(acc, key, row[column], samples);
    const hist = parseJson(row.hist);
    const unit = row.latency_source === "gateway" ? "ms" : "s";
    if (isPlainObject(hist)) for (const kind of RT_KINDS) addRtHist(acc, kind, hist[kind], unit);
  }
}

function mergePairs(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function mergeRt(a, b) {
  const out = newRt();
  for (const name of ["n", "failures", "intervalMs", "rateMs", "idleMs", "dReq", "dPrompt", "dCached", "dOutput", "dDraft", "dAccept", "energy", "idleEnergy"]) out[name] = a[name] + b[name];
  for (const name of ["prompt", "output", "rpm"]) out.rate[name] = mergePairs(a.rate[name], b.rate[name]);
  for (const name of ["run", "wait", "kv"]) out[name] = mergePairs(a[name], b[name]);
  for (const name of ["runMax", "waitMax", "kvMax"]) out[name] = maxOf(maxOf(null, a[name]), b[name]);
  for (const side of [a, b]) {
    for (const [key, pair] of Object.entries(side.pct)) out.pct[key] = out.pct[key] ? mergePairs(out.pct[key], pair) : pair.slice();
    for (const [kind, slots] of Object.entries(side.hists)) {
      const target = out.hists[kind] || (out.hists[kind] = {});
      for (const [key, hist] of Object.entries(slots)) target[key] = target[key] ? mergeHist(target[key], hist) : hist;
    }
  }
  return out;
}

const avgPair = (pair) => (pair[1] > 0 ? pair[0] / pair[1] : null);

function rtPercentile(acc, kind, q) {
  const slots = acc.hists[kind];
  let best = null;
  let bestKey = "";
  if (slots) {
    for (const [key, hist] of Object.entries(slots)) {
      if (!best || hist.count > best.count) {
        best = hist;
        bestKey = key;
      }
    }
  }
  if (best && best.count > 0) {
    const value = quantile(best, q);
    if (value !== null && Number.isFinite(value)) return round(bestKey.startsWith("ms|") ? value : value * 1000);
  }
  const fallback = acc.pct[`${kind}_p${Math.round(q * 100)}`];
  return fallback ? round(avgPair(fallback)) : null;
}

// gpu family ---------------------------------------------------------------

function newGpu() {
  return {
    n: 0, util: [0, 0], utilMax: null, mem: [0, 0], memMax: null, memTotal: null,
    temp: [0, 0], tempMax: null, power: [0, 0], powerMax: null, limit: [0, 0],
    clock: [0, 0], energy: 0, idleEnergy: 0, throttle: {}, buckets: {},
  };
}

function addEnergyBucket(acc, size, start, wh) {
  if (!wh) return;
  const key = `${size}:${start}`;
  acc.buckets[key] = (acc.buckets[key] || 0) + wh;
}

function reasonsOf(text) {
  return String(text || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function addGpuRaw(acc, row, ctx) {
  acc.n += 1;
  addWeighted(acc.util, row.util_pct, 1);
  acc.utilMax = maxOf(acc.utilMax, row.util_pct);
  addWeighted(acc.mem, row.mem_used_mb, 1);
  acc.memMax = maxOf(acc.memMax, row.mem_used_mb);
  acc.memTotal = maxOf(acc.memTotal, row.mem_total_mb);
  addWeighted(acc.temp, row.temp_c, 1);
  acc.tempMax = maxOf(acc.tempMax, row.temp_c);
  addWeighted(acc.power, row.power_w, 1);
  acc.powerMax = maxOf(acc.powerMax, row.power_w);
  addWeighted(acc.limit, row.power_limit_w, 1);
  addWeighted(acc.clock, row.sm_clock_mhz, 1);
  const energy = numberOrNull(row.energy_wh) || 0;
  acc.energy += energy;
  const reasons = reasonsOf(row.throttle);
  if (numberOrNull(row.util_pct) === 0 || reasons.includes("gpu_idle")) acc.idleEnergy += energy;
  for (const reason of reasons) acc.throttle[reason] = (acc.throttle[reason] || 0) + ctx.sampleIntervalMs / 1000;
  addEnergyBucket(acc, HOUR_MS, Math.floor(row.t / HOUR_MS) * HOUR_MS, energy);
}

function addGpuRollup(acc, row, ctx, tier) {
  const samples = Math.max(1, Number(row.sample_count) || 0);
  acc.n += Number(row.sample_count) || 0;
  addWeighted(acc.util, row.util_pct_avg, samples);
  acc.utilMax = maxOf(acc.utilMax, row.util_pct_max);
  // Rollups keep the maximum used memory only, so the average reads it.
  addWeighted(acc.mem, row.mem_used_mb_max, samples);
  acc.memMax = maxOf(acc.memMax, row.mem_used_mb_max);
  acc.memTotal = maxOf(acc.memTotal, row.mem_total_mb);
  addWeighted(acc.temp, row.temp_c_avg, samples);
  acc.tempMax = maxOf(acc.tempMax, row.temp_c_max);
  addWeighted(acc.power, row.power_w_avg, samples);
  acc.powerMax = maxOf(acc.powerMax, row.power_w_max);
  const limit = ctx.powerLimits ? ctx.powerLimits.get(Number(row.gpu_index)) : null;
  addWeighted(acc.limit, limit, samples);
  const energy = numberOrNull(row.energy_wh) || 0;
  acc.energy += energy;
  acc.idleEnergy += numberOrNull(row.idle_energy_wh) || 0;
  const throttle = parseJson(row.throttle_seconds);
  if (isPlainObject(throttle)) for (const [reason, seconds] of Object.entries(throttle)) acc.throttle[reason] = (acc.throttle[reason] || 0) + (Number(seconds) || 0);
  const size = GRAIN_MS[tier.source];
  const start = size >= DAY_MS ? row.bucket : Math.floor(row.bucket / HOUR_MS) * HOUR_MS;
  addEnergyBucket(acc, size >= DAY_MS ? size : HOUR_MS, start, energy);
}

function mergeGpu(a, b) {
  const out = newGpu();
  out.n = a.n + b.n;
  for (const name of ["util", "mem", "temp", "power", "limit", "clock"]) out[name] = mergePairs(a[name], b[name]);
  for (const name of ["utilMax", "memMax", "memTotal", "tempMax", "powerMax"]) out[name] = maxOf(maxOf(null, a[name]), b[name]);
  out.energy = a.energy + b.energy;
  out.idleEnergy = a.idleEnergy + b.idleEnergy;
  for (const side of [a, b]) {
    for (const [reason, seconds] of Object.entries(side.throttle)) out.throttle[reason] = (out.throttle[reason] || 0) + seconds;
    for (const [key, wh] of Object.entries(side.buckets)) out.buckets[key] = (out.buckets[key] || 0) + wh;
  }
  return out;
}

// Cost of the energy buckets of one accumulator at the current tariff.
function energyCostOf(acc, ctx) {
  const bySize = new Map();
  for (const [key, wh] of Object.entries(acc.buckets)) {
    const [size, start] = key.split(":");
    if (!bySize.has(size)) bySize.set(size, []);
    bySize.get(size).push([Number(start), wh]);
  }
  let cost = null;
  for (const [size, entries] of bySize) {
    const result = energyModule.costOf(entries, ctx.energy, { timezoneOffsetMinutes: ctx.tzOffsetMinutes, bucketMs: Number(size) });
    if (result.cost !== null) cost = (cost || 0) + result.cost;
  }
  return cost === null ? null : round(cost, 6);
}

// ---------------------------------------------------------------- metric catalogs

const METRICS = Object.freeze({
  "req.count": { family: "req", unit: "requests", kind: "count", value: (a) => a.requests },
  "req.rate_per_min": { family: "req", unit: "requests/min", kind: "count", value: (a, c) => a.requests / (c.stepSec / 60) },
  "req.error_rate": { family: "req", unit: "ratio", kind: "ratio", value: (a) => ratio(a.errors, a.requests) },
  "req.errors": { family: "req", unit: "requests", kind: "count", value: (a) => a.errors },
  "req.client_abort_rate": { family: "req", unit: "ratio", kind: "ratio", value: (a) => ratio(a.aborts, a.requests) },
  "tok.prompt": { family: "req", unit: "tokens", kind: "count", value: (a) => a.prompt },
  "tok.cached": { family: "req", unit: "tokens", kind: "count", value: (a) => a.cached },
  "tok.output": { family: "req", unit: "tokens", kind: "count", value: (a) => a.output },
  "tok.output_per_s": { family: "req", unit: "tokens/s", kind: "count", value: (a, c) => a.output / c.stepSec },
  "tok.cached_share": { family: "req", unit: "ratio", kind: "ratio", value: (a) => ratio(a.cached, a.prompt) },
  "lat.ttft_p50": { family: "req", unit: "ms", kind: "ratio", hist: true, value: (a) => countsQuantile(a.ttft, GATEWAY_MS_BUCKETS, 0.5) },
  "lat.ttft_p95": { family: "req", unit: "ms", kind: "ratio", hist: true, value: (a) => countsQuantile(a.ttft, GATEWAY_MS_BUCKETS, 0.95) },
  "lat.ttft_p99": { family: "req", unit: "ms", kind: "ratio", hist: true, value: (a) => countsQuantile(a.ttft, GATEWAY_MS_BUCKETS, 0.99) },
  "lat.duration_p50": { family: "req", unit: "ms", kind: "ratio", hist: true, value: (a) => countsQuantile(a.dur, GATEWAY_MS_BUCKETS, 0.5) },
  "lat.duration_p95": { family: "req", unit: "ms", kind: "ratio", hist: true, value: (a) => countsQuantile(a.dur, GATEWAY_MS_BUCKETS, 0.95) },
  "lat.duration_p99": { family: "req", unit: "ms", kind: "ratio", hist: true, value: (a) => countsQuantile(a.dur, GATEWAY_MS_BUCKETS, 0.99) },
  "lat.decode_tps_p50": { family: "req", unit: "tokens/s", kind: "ratio", hist: true, value: (a) => countsQuantile(a.dec, DECODE_TPS_BUCKETS, 0.5) },
  "lat.decode_tps_p10": { family: "req", unit: "tokens/s", kind: "ratio", hist: true, value: (a) => countsQuantile(a.dec, DECODE_TPS_BUCKETS, 0.1) },
  "req.length_share": { family: "req", unit: "ratio", kind: "ratio", value: (a) => ratio(a.finLen, a.requests) },
  "usage.estimated_share": { family: "req", unit: "ratio", kind: "ratio", value: (a) => ratio(a.estimated, a.requests) },
  "lat.ttft_hist": { family: "req", unit: "requests", kind: "heatmap", hist: true, value: (a) => perBucket(a.ttft) },

  "rt.prompt_tps": { family: "rt", unit: "tokens/s", kind: "ratio", value: (a) => round(a.rateMs > 0 ? a.dPrompt / (a.rateMs / 1000) : avgPair(a.rate.prompt)) },
  "rt.output_tps": { family: "rt", unit: "tokens/s", kind: "ratio", value: (a) => round(a.rateMs > 0 ? a.dOutput / (a.rateMs / 1000) : avgPair(a.rate.output)) },
  "rt.rpm": { family: "rt", unit: "requests/min", kind: "ratio", value: (a) => round(a.rateMs > 0 ? a.dReq / (a.rateMs / 60_000) : avgPair(a.rate.rpm)) },
  "rt.running": { family: "rt", unit: "requests", kind: "ratio", value: (a) => round(avgPair(a.run)) },
  "rt.running_max": { family: "rt", unit: "requests", kind: "ratio", value: (a) => a.runMax },
  "rt.waiting": { family: "rt", unit: "requests", kind: "ratio", value: (a) => round(avgPair(a.wait)) },
  "rt.waiting_max": { family: "rt", unit: "requests", kind: "ratio", value: (a) => a.waitMax },
  "rt.kv_usage": { family: "rt", unit: "ratio", kind: "ratio", value: (a) => round(avgPair(a.kv)) },
  "rt.kv_usage_max": { family: "rt", unit: "ratio", kind: "ratio", value: (a) => a.kvMax },
  "rt.prefix_hit": { family: "rt", unit: "ratio", kind: "ratio", value: (a) => round(ratio(a.dCached, a.dPrompt)) },
  "rt.spec_accept": { family: "rt", unit: "ratio", kind: "ratio", value: (a) => round(ratio(a.dAccept, a.dDraft)) },
  "rt.ttft_p50": { family: "rt", unit: "ms", kind: "ratio", hist: true, value: (a) => rtPercentile(a, "ttft", 0.5) },
  "rt.ttft_p95": { family: "rt", unit: "ms", kind: "ratio", hist: true, value: (a) => rtPercentile(a, "ttft", 0.95) },
  "rt.ttft_p99": { family: "rt", unit: "ms", kind: "ratio", hist: true, value: (a) => rtPercentile(a, "ttft", 0.99) },
  "rt.e2e_p50": { family: "rt", unit: "ms", kind: "ratio", hist: true, value: (a) => rtPercentile(a, "e2e", 0.5) },
  "rt.e2e_p95": { family: "rt", unit: "ms", kind: "ratio", hist: true, value: (a) => rtPercentile(a, "e2e", 0.95) },
  "rt.itl_p50": { family: "rt", unit: "ms", kind: "ratio", hist: true, value: (a) => rtPercentile(a, "itl", 0.5) },
  "rt.itl_p95": { family: "rt", unit: "ms", kind: "ratio", hist: true, value: (a) => rtPercentile(a, "itl", 0.95) },
  "rt.tpot_p50": { family: "rt", unit: "ms", kind: "ratio", hist: true, value: (a) => rtPercentile(a, "tpot", 0.5) },
  "rt.queue_p95": { family: "rt", unit: "ms", kind: "ratio", hist: true, value: (a) => rtPercentile(a, "queue", 0.95) },
  "rt.idle_share": { family: "rt", unit: "ratio", kind: "ratio", value: (a) => round(ratio(a.idleMs, a.intervalMs)) },

  "gpu.util": { family: "gpu", unit: "percent", kind: "ratio", value: (a) => round(avgPair(a.util)) },
  "gpu.util_max": { family: "gpu", unit: "percent", kind: "ratio", value: (a) => a.utilMax },
  "gpu.mem_used_mb": { family: "gpu", unit: "mb", kind: "ratio", value: (a) => round(avgPair(a.mem)) },
  "gpu.mem_used_pct": { family: "gpu", unit: "percent", kind: "ratio", value: (a) => round(a.memTotal > 0 && avgPair(a.mem) !== null ? (avgPair(a.mem) / a.memTotal) * 100 : null) },
  "gpu.temp_c": { family: "gpu", unit: "celsius", kind: "ratio", value: (a) => round(avgPair(a.temp)) },
  "gpu.temp_max": { family: "gpu", unit: "celsius", kind: "ratio", value: (a) => a.tempMax },
  "gpu.power_w": { family: "gpu", unit: "watts", kind: "ratio", value: (a) => round(avgPair(a.power)) },
  "gpu.power_ratio": { family: "gpu", unit: "ratio", kind: "ratio", value: (a) => round(avgPair(a.limit) > 0 && avgPair(a.power) !== null ? avgPair(a.power) / avgPair(a.limit) : null) },
  "gpu.sm_clock_mhz": { family: "gpu", unit: "mhz", kind: "ratio", value: (a) => round(avgPair(a.clock)) },
  "gpu.throttle_seconds": { family: "gpu", unit: "seconds", kind: "throttle", value: (a) => Object.values(a.throttle).reduce((sum, seconds) => sum + seconds, 0) },
  "gpu.energy_wh": { family: "gpu", unit: "wh", kind: "sum", value: (a) => round(a.energy, 6) },
  "energy.cost": { family: "gpu", unit: "currency", kind: "cost", value: (a, c) => energyCostOf(a, c) },
});

const FAMILIES = Object.freeze({
  req: Object.freeze({
    name: "req",
    rawTable: "requests",
    tables: Object.freeze({ "1m": "rollup_1m", "1h": "rollup_1h", "1d": "rollup_1d" }),
    sourceNames: Object.freeze({ raw: "requests", "1m": "rollup_1m", "1h": "rollup_1h", "1d": "rollup_1d" }),
    create: newReq,
    merge: mergeReq,
    weight: (acc) => acc.requests,
    addRaw: addReqRaw,
    addRollup: addReqRollup,
  }),
  rt: Object.freeze({
    name: "rt",
    rawTable: "runtime_samples",
    tables: Object.freeze({ "1m": "runtime_rollup_1m", "1h": "runtime_rollup_1h", "1d": "runtime_rollup_1d" }),
    sourceNames: Object.freeze({ raw: "runtime_samples", "1m": "runtime_rollup_1m", "1h": "runtime_rollup_1h", "1d": "runtime_rollup_1d" }),
    create: newRt,
    merge: mergeRt,
    weight: (acc) => acc.n,
    addRaw: addRtRaw,
    addRollup: addRtRollup,
  }),
  gpu: Object.freeze({
    name: "gpu",
    rawTable: "gpu_samples",
    tables: Object.freeze({ "1m": "gpu_rollup_1m", "1h": "gpu_rollup_1h", "1d": "gpu_rollup_1d" }),
    sourceNames: Object.freeze({ raw: "gpu_samples", "1m": "gpu_rollup_1m", "1h": "gpu_rollup_1h", "1d": "gpu_rollup_1d" }),
    create: newGpu,
    merge: mergeGpu,
    weight: (acc) => acc.n,
    addRaw: addGpuRaw,
    addRollup: addGpuRollup,
  }),
});

// breakdown metrics (camelCase, over the request accumulator)
const DEFAULT_BREAKDOWN_METRICS = Object.freeze(["requests", "errorRate", "promptTokens", "cachedTokens", "outputTokens", "ttftP95Ms", "durationP95Ms", "decodeTpsP50"]);
const BREAKDOWN_METRICS = Object.freeze({
  requests: { value: (a) => a.requests },
  errorRate: { value: (a) => round(ratio(a.errors, a.requests)) },
  clientAbortRate: { value: (a) => round(ratio(a.aborts, a.requests)) },
  promptTokens: { value: (a) => a.prompt },
  cachedTokens: { value: (a) => a.cached },
  outputTokens: { value: (a) => a.output },
  ttftP50Ms: { hist: true, value: (a) => countsQuantile(a.ttft, GATEWAY_MS_BUCKETS, 0.5) },
  ttftP95Ms: { hist: true, value: (a) => countsQuantile(a.ttft, GATEWAY_MS_BUCKETS, 0.95) },
  ttftP99Ms: { hist: true, value: (a) => countsQuantile(a.ttft, GATEWAY_MS_BUCKETS, 0.99) },
  durationP50Ms: { hist: true, value: (a) => countsQuantile(a.dur, GATEWAY_MS_BUCKETS, 0.5) },
  durationP95Ms: { hist: true, value: (a) => countsQuantile(a.dur, GATEWAY_MS_BUCKETS, 0.95) },
  durationP99Ms: { hist: true, value: (a) => countsQuantile(a.dur, GATEWAY_MS_BUCKETS, 0.99) },
  decodeTpsP50: { hist: true, value: (a) => countsQuantile(a.dec, DECODE_TPS_BUCKETS, 0.5) },
  decodeTpsP10: { hist: true, value: (a) => countsQuantile(a.dec, DECODE_TPS_BUCKETS, 0.1) },
});

// ---------------------------------------------------------------- readers

const MODEL_EXPR = "COALESCE(NULLIF(model_resolved, ''), model_requested, '')";
const STATUS_CLASS_EXPR = "CASE WHEN status BETWEEN 200 AND 599 THEN (status / 100) || 'xx' ELSE 'none' END";

// filter name -> expression, for the raw request rows
const REQUEST_FILTER_EXPR = Object.freeze({
  manager_id: "manager_id",
  fleet_id: "fleet_id",
  engine_id: "engine_id",
  model: MODEL_EXPR,
  key_id: "key_id",
  customer_id: "customer_id",
  source_program: "source_program",
  protocol: "protocol",
  status_class: STATUS_CLASS_EXPR,
  error_class: "error_class",
  ingress: "ingress",
});
// ... and for the request rollup tables (the dimension columns)
const ROLLUP_FILTER_COLUMNS = Object.freeze(["manager_id", "fleet_id", "engine_id", "model", "key_id", "customer_id", "source_program", "protocol", "status_class", "error_class"]);

const RAW_REQUEST_SELECT = [
  "received_at AS t",
  "COALESCE(manager_id, '') AS manager_id",
  "COALESCE(fleet_id, '') AS fleet_id",
  "COALESCE(engine_id, '') AS engine_id",
  `${MODEL_EXPR} AS model`,
  "COALESCE(key_id, '') AS key_id",
  "COALESCE(customer_id, '') AS customer_id",
  "source_program",
  "protocol",
  `${STATUS_CLASS_EXPR} AS status_class`,
  "error_class",
  "COALESCE(client_ip, '') AS client_ip",
  "terminal_state", "stream", "prompt_tokens", "cached_tokens", "output_tokens", "usage_source", "finish_reason",
  "duration_ms", "ttft_ms", "decode_tps",
].join(", ");

function filterClause(familyName, tier, filters) {
  const parts = [];
  const params = [];
  const push = (clause) => {
    parts.push(clause.sql);
    params.push(...clause.params);
  };
  if (familyName === "req") {
    for (const name of ROLLUP_FILTER_COLUMNS) {
      if (!filters[name]) continue;
      push(inClause(tier === "raw" ? REQUEST_FILTER_EXPR[name] : name, filters[name]));
    }
    if (tier === "raw") {
      if (filters.ingress) push(inClause("ingress", filters.ingress));
      if (filters.stream !== undefined) {
        parts.push("stream = ?");
        params.push(filters.stream);
      }
    }
  } else if (familyName === "rt") {
    for (const name of RUNTIME_FILTERS) {
      if (!filters[name]) continue;
      push(inClause(name, filters[name]));
    }
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}

// Calls handle(tier, row, t) for each row of the plan. `t` is the row time
// (raw) or bucket start (rollup).
function readTiers(db, familyName, tiers, filters, budget, handle) {
  const family = FAMILIES[familyName];
  for (const tier of tiers) {
    budget.check();
    const where = filterClause(familyName, tier.source, filters || {});
    let statement;
    if (tier.source === "raw") {
      if (familyName === "req") {
        statement = prepare(db, `SELECT ${RAW_REQUEST_SELECT} FROM requests WHERE received_at >= ? AND received_at < ?${where.sql} AND (extra IS NULL OR extra NOT LIKE '%dupOf%')`);
      } else {
        statement = prepare(db, `SELECT at AS t, * FROM ${family.rawTable} WHERE at >= ? AND at < ?${where.sql}`);
      }
    } else {
      const extra = familyName === "req" ? " AND source <> 'coverage'" : "";
      statement = prepare(db, `SELECT * FROM ${family.tables[tier.source]} WHERE bucket >= ? AND bucket < ?${extra}${where.sql}`);
    }
    for (const row of statement.iterate(tier.from, tier.to, ...where.params)) {
      budget.tick();
      handle(tier, row, tier.source === "raw" ? row.t : row.bucket);
    }
  }
}

// Covered bucket starts of the request family in the plan (§6.4).
function readCoverage(db, tiers, budget) {
  const covered = [];
  for (const tier of tiers) {
    budget.check();
    if (tier.source === "raw") {
      for (const row of prepare(db, "SELECT bucket FROM coverage_1m WHERE component = 'recorder' AND bucket >= ? AND bucket < ?").iterate(tier.from, tier.to)) {
        covered.push(row.bucket);
      }
    } else {
      const table = FAMILIES.req.tables[tier.source];
      for (const row of prepare(db, `SELECT DISTINCT bucket FROM ${table} WHERE source = 'coverage' AND bucket >= ? AND bucket < ?`).iterate(tier.from, tier.to)) {
        covered.push(row.bucket);
      }
    }
  }
  return covered;
}

function coarsestSource(familyName, tiers) {
  const rank = { "1d": 3, "1h": 2, "1m": 1, raw: 0 };
  let best = null;
  for (const tier of tiers) if (best === null || rank[tier.source] > rank[best]) best = tier.source;
  return FAMILIES[familyName].sourceNames[best === null ? "raw" : best];
}

function loadPowerLimits(db) {
  const map = new Map();
  for (const row of prepare(db, "SELECT gpu_index, power_limit_w FROM gpu_samples g WHERE power_limit_w IS NOT NULL AND at = (SELECT MAX(at) FROM gpu_samples WHERE gpu_index = g.gpu_index AND power_limit_w IS NOT NULL)").iterate()) {
    map.set(Number(row.gpu_index), Number(row.power_limit_w));
  }
  return map;
}

// ---------------------------------------------------------------- shared steps

function groupKey(familyName, groupBy, row) {
  if (!groupBy) return "";
  if (familyName === "req") return String(row[DIMENSIONS[groupBy]] ?? "");
  if (familyName === "rt") return String((groupBy === "fleet" ? row.fleet_id : row.model) ?? "");
  return groupBy === "gpu" ? String(row.gpu_index) : "";
}

function planFor(db, q, grains) {
  return {
    marks: readWatermarks(db),
    calendar: rollups.calendarFromState(db, q.tzOffsetMinutes),
    grains,
  };
}

function usesRawOnly(familyName, filters) {
  return familyName === "req" && RAW_ONLY_FILTERS.some((name) => filters[name] !== undefined);
}

function foldGroups(familyName, groups, top, groupBy) {
  const family = FAMILIES[familyName];
  const list = [...groups.values()];
  for (const group of list) {
    group.weight = 0;
    for (const acc of group.buckets.values()) group.weight += family.weight(acc);
  }
  list.sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (!groupBy || list.length <= top) return { groups: list, otherGroups: 0 };
  const kept = list.slice(0, top);
  const other = { key: OTHER, other: true, buckets: new Map(), weight: 0 };
  for (const group of list.slice(top)) {
    other.weight += group.weight;
    for (const [index, acc] of group.buckets) {
      other.buckets.set(index, other.buckets.has(index) ? family.merge(other.buckets.get(index), acc) : acc);
    }
  }
  return { groups: [...kept, other], otherGroups: list.length - top };
}

function annotationRows(db, q, budget) {
  if (!q.annotate || !q.annotate.length) return [];
  const patterns = q.annotate.map((kind) => `${kind}.%`);
  const filters = q.filters || {};
  const params = [q.from, q.to, ...patterns];
  let sql = `SELECT id, at, type, fleet_id, title FROM events WHERE at >= ? AND at < ? AND type <> 'launch.phase' AND (${patterns.map(() => "type LIKE ?").join(" OR ")})`;
  for (const name of ["manager_id", "fleet_id"]) {
    if (!filters[name]) continue;
    const clause = inClause(name, filters[name]);
    sql += ` AND ${clause.sql}`;
    params.push(...clause.params);
  }
  sql += ` ORDER BY at, id LIMIT ${ANNOTATION_LIMIT}`;
  budget.check();
  return prepare(db, sql).all(...params).map((row) => ({
    at: row.at,
    type: row.type,
    ...(row.fleet_id ? { fleetId: row.fleet_id } : {}),
    title: row.title,
    eventId: row.id,
  }));
}

// ---------------------------------------------------------------- timeseries

function timeseries(db, q) {
  const budget = createBudget(q.budgetMs);
  const stepSec = resolveStep(q);
  const stepMs = stepSec * SECOND_MS;
  const tzMs = q.tzOffsetMinutes * MINUTE_MS;
  const origin = stepOrigin(q.from, stepMs, tzMs);
  const count = pointCount(q.from, q.to, stepMs, tzMs);
  const plan = planFor(db, q, eligibleGrains(stepMs));
  const byFamily = { req: [], rt: [], gpu: [] };
  for (const id of q.metrics) byFamily[METRICS[id].family].push(id);
  const series = [];
  let source = null;
  let otherGroups = 0;
  let heatmap = false;
  const valueCtx = { stepSec, energy: q.energy || {}, tzOffsetMinutes: q.tzOffsetMinutes };

  for (const familyName of ["req", "rt", "gpu"]) {
    const ids = byFamily[familyName];
    if (!ids.length) continue;
    const family = FAMILIES[familyName];
    const grains = usesRawOnly(familyName, q.filters) ? [] : plan.grains;
    const tiers = planTiers(q.from, q.to, grains, plan.marks, plan.calendar);
    if (source === null) source = coarsestSource(familyName, tiers);
    const ctx = {
      needHist: ids.some((id) => METRICS[id].hist),
      sampleIntervalMs: q.sampleIntervalMs || DEFAULT_SAMPLE_INTERVAL_MS,
      powerLimits: familyName === "gpu" && ids.includes("gpu.power_ratio") ? loadPowerLimits(db) : null,
    };
    // throttle seconds split by reason when not grouped by gpu
    const groupBy = familyName === "gpu" && q.groupBy === "reason" ? null : q.groupBy;
    const groups = new Map();
    readTiers(db, familyName, tiers, q.filters, budget, (tier, row, t) => {
      const index = Math.floor((t - origin) / stepMs);
      if (index < 0 || index >= count) return;
      const key = groupKey(familyName, groupBy, row);
      let group = groups.get(key);
      if (!group) {
        group = { key, buckets: new Map() };
        groups.set(key, group);
      }
      let acc = group.buckets.get(index);
      if (!acc) {
        acc = family.create();
        group.buckets.set(index, acc);
      }
      if (tier.source === "raw") family.addRaw(acc, row, ctx);
      else family.addRollup(acc, row, ctx, tier);
    });
    const covered = new Set();
    if (familyName === "req") {
      for (const bucket of readCoverage(db, tiers, budget)) covered.add(Math.floor((bucket - origin) / stepMs));
    }
    const folded = foldGroups(familyName, groups, q.top, groupBy);
    otherGroups = Math.max(otherGroups, folded.otherGroups);
    for (const id of ids) {
      const metric = METRICS[id];
      if (metric.kind === "heatmap") heatmap = true;
      for (const group of folded.groups) {
        const groupObject = group.other ? { other: true } : groupBy ? { [groupBy]: group.key } : {};
        if (metric.kind === "throttle" && (!q.groupBy || q.groupBy === "reason")) {
          series.push(...throttleSeries(id, metric, group, count, origin, stepMs, groupObject));
          continue;
        }
        const points = [];
        for (let index = 0; index < count; index += 1) {
          const acc = group.buckets.get(index);
          let value = null;
          if (acc) {
            const raw = metric.value(acc, valueCtx);
            value = Array.isArray(raw) ? raw : round(raw, metric.kind === "sum" || metric.kind === "cost" ? 6 : 4);
          } else if (familyName === "req" && metric.kind === "count" && covered.has(index)) value = 0;
          points.push([origin + index * stepMs, value]);
        }
        series.push({ metric: id, unit: metric.unit, group: groupObject, points });
      }
    }
  }
  const out = {
    ok: true,
    from: iso(q.from),
    to: iso(q.to),
    step: stepSec,
    source: source || "requests",
    tzOffsetMinutes: q.tzOffsetMinutes,
    series,
    annotations: annotationRows(db, q, budget),
    otherGroups,
  };
  if (heatmap) out.le = GATEWAY_MS_BUCKETS.slice();
  return out;
}

function throttleSeries(id, metric, group, count, origin, stepMs, groupObject) {
  const reasons = new Set();
  for (const acc of group.buckets.values()) for (const reason of Object.keys(acc.throttle)) reasons.add(reason);
  const list = reasons.size ? [...reasons].sort() : [null];
  return list.map((reason) => {
    const points = [];
    for (let index = 0; index < count; index += 1) {
      const acc = group.buckets.get(index);
      const value = !acc ? null : reason === null ? 0 : round(acc.throttle[reason] || 0);
      points.push([origin + index * stepMs, value]);
    }
    return { metric: id, unit: metric.unit, group: reason === null ? groupObject : { ...groupObject, reason }, points };
  });
}

// ---------------------------------------------------------------- summary

function energyTotals(acc, ctx) {
  if (!acc || !acc.n) return { kwh: null, cost: null };
  return { kwh: round(acc.energy / 1000, 4), cost: energyCostOf(acc, ctx) };
}

function summaryPeriod(db, q, from, to, plan, budget) {
  const tiers = planTiers(from, to, usesRawOnly("req", q.filters) ? [] : ["1d", "1h", "1m"], plan.marks, plan.calendar);
  const acc = newReq();
  const keys = new Set();
  const reqCtx = { needHist: true };
  readTiers(db, "req", tiers, q.filters, budget, (tier, row) => {
    if (tier.source === "raw") {
      addReqRaw(acc, row, reqCtx);
      if (row.key_id) keys.add(row.key_id);
    } else {
      addReqRollup(acc, row, reqCtx);
      if (row.key_id && Number(row.requests) > 0) keys.add(row.key_id);
    }
  });
  const gpuTiers = planTiers(from, to, ["1d", "1h", "1m"], plan.marks, plan.calendar);
  const gpu = newGpu();
  const gpuCtx = { sampleIntervalMs: q.sampleIntervalMs || DEFAULT_SAMPLE_INTERVAL_MS, powerLimits: null };
  readTiers(db, "gpu", gpuTiers, {}, budget, (tier, row) => {
    if (tier.source === "raw") addGpuRaw(gpu, row, gpuCtx);
    else addGpuRollup(gpu, row, gpuCtx, tier);
  });
  const costCtx = { energy: q.energy || {}, tzOffsetMinutes: q.tzOffsetMinutes };
  const energy = energyTotals(gpu, costCtx);
  const current = {
    requests: acc.requests,
    errorRate: round(ratio(acc.errors, acc.requests)),
    clientAbortRate: round(ratio(acc.aborts, acc.requests)),
    ttftP95Ms: countsQuantile(acc.ttft, GATEWAY_MS_BUCKETS, 0.95),
    durationP95Ms: countsQuantile(acc.dur, GATEWAY_MS_BUCKETS, 0.95),
    decodeTpsP50: countsQuantile(acc.dec, DECODE_TPS_BUCKETS, 0.5),
    promptTokens: acc.prompt,
    cachedTokens: acc.cached,
    outputTokens: acc.output,
    activeKeys: keys.size,
    gpuUtilAvg: round(avgPair(gpu.util)),
    vramPeakMb: gpu.memMax,
    energyKwh: energy.kwh,
    energyCost: energy.cost,
    currency: energyModule.costOf([], q.energy || {}, { timezoneOffsetMinutes: q.tzOffsetMinutes }).currency,
  };
  return { current, source: coarsestSource("req", tiers) };
}

// The share of [from, to) in which the recorder was collecting: whole closed
// hours from rollup_1h (markers and data), the rest from the minute markers.
function coverageRatio(db, from, to, plan, budget) {
  const total = to - from;
  if (!(total > 0)) return 0;
  budget.check();
  const closed = plan.marks["1h"];
  const hourFrom = alignUp("1h", from, plan.calendar);
  const hourTo = closed === null ? hourFrom : alignDown("1h", Math.min(to, closed), plan.calendar);
  let coveredMs = 0;
  let hourSpan = 0;
  if (hourTo > hourFrom) {
    hourSpan = hourTo - hourFrom;
    const row = prepare(db, "SELECT COUNT(DISTINCT bucket) AS n FROM rollup_1h WHERE bucket >= ? AND bucket < ?").get(hourFrom, hourTo);
    coveredMs += Number(row.n) * HOUR_MS;
  }
  const spans = hourSpan ? [[from, hourFrom], [hourTo, to]] : [[from, to]];
  for (const [start, end] of spans) {
    if (!(end > start)) continue;
    const row = prepare(db, "SELECT COUNT(*) AS n FROM coverage_1m WHERE component = 'recorder' AND bucket >= ? AND bucket < ?").get(Math.floor(start / MINUTE_MS) * MINUTE_MS, end);
    coveredMs += Number(row.n) * MINUTE_MS;
  }
  return round(Math.min(1, coveredMs / total));
}

function summary(db, q) {
  const budget = createBudget(q.budgetMs);
  const plan = planFor(db, q, ["1d", "1h", "1m"]);
  const current = summaryPeriod(db, q, q.from, q.to, plan, budget);
  const out = {
    ok: true,
    from: iso(q.from),
    to: iso(q.to),
    current: current.current,
    coverage: coverageRatio(db, q.from, q.to, plan, budget),
    source: current.source,
  };
  if (q.compare !== "none") {
    const span = q.to - q.from;
    out.previous = summaryPeriod(db, q, q.from - span, q.from, plan, budget).current;
  }
  return out;
}

// ---------------------------------------------------------------- breakdown

function labelFor(dim, key) {
  if (dim === "error_class" && ERROR_CLASS_LABELS[key]) return ERROR_CLASS_LABELS[key];
  if (dim === "source" && SOURCE_PROGRAM_LABELS[key]) return SOURCE_PROGRAM_LABELS[key];
  if (!key) return { zh: "（无）", en: "(none)" };
  return { zh: key, en: key };
}

function breakdownExpression(dim) {
  if (dim === "client_ip") return "client_ip";
  return REQUEST_FILTER_EXPR[DIMENSIONS[dim]];
}

function compareNullsLast(a, b, descending) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

function breakdown(db, q) {
  const budget = createBudget(q.budgetMs);
  const plan = planFor(db, q, ["1d", "1h", "1m"]);
  const span = q.to - q.from;
  const width = span / 24;
  const column = q.dim === "client_ip" ? "client_ip" : DIMENSIONS[q.dim];
  const rawOnly = q.dim === "client_ip" || usesRawOnly("req", q.filters);
  const grains = rawOnly ? [] : q.spark ? ["1d", "1h", "1m"].filter((grain) => GRAIN_MS[grain] <= width) : ["1d", "1h", "1m"];
  const tiers = planTiers(q.from, q.to, grains, plan.marks, plan.calendar);
  const sortId = q.sort.startsWith("-") ? q.sort.slice(1) : q.sort;
  const needHist = [...q.metrics, sortId].some((id) => BREAKDOWN_METRICS[id].hist);
  const ctx = { needHist };
  const groups = new Map();
  readTiers(db, "req", tiers, q.filters, budget, (tier, row, t) => {
    const key = String(row[column] ?? "");
    let group = groups.get(key);
    if (!group) {
      group = { key, acc: newReq(), spark: q.spark ? new Array(24).fill(0) : null };
      groups.set(key, group);
    }
    if (tier.source === "raw") addReqRaw(group.acc, row, ctx);
    else addReqRollup(group.acc, row, ctx);
    if (group.spark) {
      const index = Math.min(23, Math.max(0, Math.floor((t - q.from) / width)));
      group.spark[index] += tier.source === "raw" ? 1 : Number(row.requests) || 0;
    }
  });
  let total = 0;
  for (const group of groups.values()) total += group.acc.requests;
  const descending = q.sort.startsWith("-");
  const sortValue = BREAKDOWN_METRICS[sortId].value;
  const ordered = [...groups.values()]
    .sort((a, b) => compareNullsLast(sortValue(a.acc), sortValue(b.acc), descending) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, q.limit);
  const expression = breakdownExpression(q.dim);
  const rows = ordered.map((group, position) => {
    const row = { key: group.key, label: labelFor(q.dim, group.key), requests: group.acc.requests, share: round(total > 0 ? group.acc.requests / total : 0) };
    for (const id of q.metrics) if (id !== "requests") row[id] = BREAKDOWN_METRICS[id].value(group.acc);
    row.firstSeen = iso(group.acc.first);
    row.lastSeen = iso(group.acc.last);
    row.sampleRequestIds = position < SAMPLE_REQUEST_ROWS ? sampleRequestIds(db, q, expression, group.key, budget) : [];
    if (group.spark) row.spark = group.spark;
    return row;
  });
  return { ok: true, dim: q.dim, rows, total: { requests: total } };
}

function sampleRequestIds(db, q, expression, key, budget) {
  budget.check();
  const filters = q.filters || {};
  const params = [q.from, q.to];
  const clause = inClause(expression, [key]);
  let sql = `SELECT request_id FROM requests WHERE received_at >= ? AND received_at < ? AND ${clause.sql}`;
  params.push(...clause.params);
  for (const name of ROLLUP_FILTER_COLUMNS) {
    if (!filters[name]) continue;
    const part = inClause(REQUEST_FILTER_EXPR[name], filters[name]);
    sql += ` AND ${part.sql}`;
    params.push(...part.params);
  }
  if (filters.ingress) {
    const part = inClause("ingress", filters.ingress);
    sql += ` AND ${part.sql}`;
    params.push(...part.params);
  }
  if (filters.stream !== undefined) {
    sql += " AND stream = ?";
    params.push(filters.stream);
  }
  sql += " ORDER BY received_at DESC LIMIT 3";
  return prepare(db, sql).all(...params).map((row) => row.request_id);
}

// ---------------------------------------------------------------- requests

const REQUEST_COLUMNS = Object.freeze([
  "id", "request_id", "client_request_id", "manager_request_id", "ingress", "received_at", "ended_at",
  "manager_id", "fleet_id", "engine_id", "runtime_id", "launch_id", "protocol", "op", "route", "method", "path",
  "model_requested", "model_resolved", "stream", "key_id", "customer_id", "auth_source", "client_ip", "client_country",
  "user_agent", "origin_host", "source_program", "owui_user_id", "owui_chat_id", "status", "terminal_state",
  "error_class", "error_code", "queue_ms", "upstream_headers_ms", "ttft_ms", "duration_ms", "decode_tps",
  "prompt_tokens", "cached_tokens", "output_tokens", "reasoning_tokens", "usage_source", "finish_reason", "bytes_out",
  "engine_prompt_ms", "engine_decode_tps", "engine_cached_tokens", "extra",
]);
const TIME_COLUMNS = new Set(["received_at", "ended_at"]);

// The public projection of a requests row: camelCase, ISO times, parsed extra.
function rowToRequest(row) {
  const out = {};
  for (const column of REQUEST_COLUMNS) {
    const value = row[column];
    const name = snakeToCamel(column);
    if (TIME_COLUMNS.has(column)) out[name] = iso(value);
    else if (column === "stream") out[name] = Number(value) === 1;
    else if (column === "extra") out[name] = parseJson(value) || {};
    else out[name] = value === undefined ? null : value;
  }
  return out;
}

function requestWhere(q, { keyset = true } = {}) {
  const parts = [];
  const params = [];
  const push = (clause) => {
    parts.push(clause.sql);
    params.push(...clause.params);
  };
  const searching = Boolean(q.q) && q.rangeExplicit === false;
  if (!searching) {
    parts.push("received_at >= ? AND received_at < ?");
    params.push(q.from, q.to);
  }
  const filters = q.filters || {};
  for (const name of ROLLUP_FILTER_COLUMNS) if (filters[name]) push(inClause(REQUEST_FILTER_EXPR[name], filters[name]));
  if (filters.ingress) push(inClause("ingress", filters.ingress));
  if (filters.stream !== undefined) {
    parts.push("stream = ?");
    params.push(filters.stream);
  }
  if (q.terminalState && q.terminalState.length) push(inClause("terminal_state", q.terminalState));
  if (q.clientIp) {
    parts.push("client_ip = ?");
    params.push(q.clientIp);
  }
  if (q.minDurationMs !== undefined) {
    parts.push("duration_ms >= ?");
    params.push(q.minDurationMs);
  }
  if (q.minTtftMs !== undefined) {
    parts.push("ttft_ms >= ?");
    params.push(q.minTtftMs);
  }
  if (q.minOutputTokens !== undefined) {
    parts.push("output_tokens >= ?");
    params.push(q.minOutputTokens);
  }
  if (q.q) {
    if (q.q.length >= 6) {
      parts.push("(request_id LIKE ? ESCAPE '\\' OR manager_request_id LIKE ? ESCAPE '\\' OR client_request_id = ?)");
      params.push(likePrefix(q.q), likePrefix(q.q), q.q);
    } else {
      parts.push("client_request_id = ?");
      params.push(q.q);
    }
  }
  if (keyset && q.cursor) {
    parts.push("(received_at < ? OR (received_at = ? AND id < ?))");
    params.push(q.cursor.t, q.cursor.t, q.cursor.id);
  }
  return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", params };
}

function listRequests(db, q) {
  const budget = createBudget(q.budgetMs);
  const where = requestWhere(q);
  const limit = q.limit || 100;
  const rows = prepare(db, `SELECT * FROM requests${where.sql} ORDER BY received_at DESC, id DESC LIMIT ${limit + 1}`).all(...where.params);
  budget.check();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const out = {
    ok: true,
    rows: page.map(rowToRequest),
    nextCursor: rows.length > limit && last ? encodeCursor({ t: last.received_at, id: last.id }) : null,
  };
  if (q.facets) Object.assign(out, requestFacets(db, q, budget));
  return out;
}

function requestFacets(db, q, budget) {
  const where = requestWhere(q, { keyset: false });
  const facets = { status_class: new Map(), error_class: new Map(), model: new Map(), source_program: new Map() };
  const statement = prepare(db, `SELECT ${STATUS_CLASS_EXPR} AS status_class, error_class, ${MODEL_EXPR} AS model, source_program FROM requests${where.sql} ORDER BY received_at DESC LIMIT ${FACET_ROW_CAP + 1}`);
  let seen = 0;
  for (const row of statement.iterate(...where.params)) {
    budget.tick();
    seen += 1;
    if (seen > FACET_ROW_CAP) break;
    for (const name of Object.keys(facets)) {
      const key = String(row[name] ?? "");
      facets[name].set(key, (facets[name].get(key) || 0) + 1);
    }
  }
  const out = {};
  for (const [name, map] of Object.entries(facets)) {
    out[name] = Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  }
  return seen > FACET_ROW_CAP ? { facets: out, facetsTruncated: true } : { facets: out };
}

// ---------------------------------------------------------------- request detail

const LAUNCH_SUMMARY_KEYS = Object.freeze([
  "contextLength", "kvCacheDtype", "maxNumSeqs", "maxNumBatchedTokens", "tensorParallelSize", "quantization",
  "dtype", "gpuMemoryUtilization", "concurrency", "speculative",
]);

function launchSummary(data) {
  const source = isPlainObject(data && data.summary) ? data.summary : isPlainObject(data && data.launch) ? data.launch : {};
  const out = {};
  for (const key of LAUNCH_SUMMARY_KEYS) {
    const value = source[key];
    if (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= 80)) out[key] = value;
  }
  return out;
}

function requestTimeline(row) {
  const marks = [{ at: iso(row.received_at), mark: "received" }];
  const add = (mark, offset) => {
    const value = numberOrNull(offset);
    if (value !== null) marks.push({ mark, offsetMs: value });
  };
  add("dispatched", row.queue_ms);
  add("headers", row.upstream_headers_ms);
  add("first_token", row.ttft_ms);
  add("done", row.duration_ms);
  return [marks[0], ...marks.slice(1).sort((a, b) => a.offsetMs - b.offsetMs)];
}

function getRequest(db, q) {
  const budget = createBudget(q.budgetMs);
  const id = String(q.requestId || "");
  const row = prepare(db, "SELECT * FROM requests WHERE request_id = ?").get(id)
    || prepare(db, "SELECT * FROM requests WHERE manager_request_id = ? ORDER BY received_at DESC, id DESC LIMIT 1").get(id);
  if (!row) throw queryError("request_not_found", "No request has this id.", { status: 404, hint: "Requests are kept for a limited time." });
  budget.check();
  const request = rowToRequest(row);
  let instance = null;
  if (row.fleet_id || row.engine_id || row.launch_id) {
    instance = {
      fleetId: row.fleet_id,
      engineId: row.engine_id,
      runtimeId: row.runtime_id,
      launchId: row.launch_id,
      recipeId: null,
      launch: null,
      nearestSample: null,
    };
    if (row.launch_id) {
      const ready = prepare(db, "SELECT at, data FROM events WHERE type = 'launch.ready' AND launch_id = ? ORDER BY at DESC, id DESC LIMIT 1").get(row.launch_id);
      if (ready) {
        const data = parseJson(ready.data) || {};
        instance.recipeId = typeof data.recipeId === "string" ? data.recipeId : null;
        instance.launch = { readyAt: iso(ready.at), summary: launchSummary(data) };
      }
    }
    if (row.fleet_id) {
      const middle = row.received_at + Math.floor((row.duration_ms || 0) / 2);
      const sample = prepare(db, "SELECT at, running, waiting, kv_usage FROM runtime_samples WHERE fleet_id = ? AND scrape_ok = 1 AND at BETWEEN ? AND ? ORDER BY ABS(at - ?) LIMIT 1")
        .get(row.fleet_id, middle - MINUTE_MS, middle + MINUTE_MS, middle);
      if (sample) instance.nearestSample = { at: iso(sample.at), running: sample.running, waiting: sample.waiting, kvUsage: sample.kv_usage };
    }
  }
  const window = 60_000;
  const eventsSql = row.fleet_id
    ? "SELECT id, type, at, severity, title FROM events WHERE request_id = ? OR (fleet_id = ? AND at BETWEEN ? AND ?) ORDER BY at, id LIMIT 50"
    : "SELECT id, type, at, severity, title FROM events WHERE request_id = ? ORDER BY at, id LIMIT 50";
  const eventParams = row.fleet_id ? [row.request_id, row.fleet_id, row.received_at - window, row.ended_at + window] : [row.request_id];
  const events = prepare(db, eventsSql).all(...eventParams).map((event) => ({ id: event.id, type: event.type, at: iso(event.at), severity: event.severity, title: event.title }));
  return { ok: true, request, timeline: requestTimeline(row), instance, events };
}

// ---------------------------------------------------------------- events

function eventRow(row) {
  return {
    id: row.id,
    at: iso(row.at),
    type: row.type,
    severity: row.severity,
    source: row.source,
    managerId: row.manager_id,
    fleetId: row.fleet_id,
    launchId: row.launch_id,
    requestId: row.request_id,
    title: row.title,
    data: parseJson(row.data),
  };
}

function listEvents(db, q) {
  const budget = createBudget(q.budgetMs);
  const parts = ["at >= ? AND at < ?"];
  const params = [q.from, q.to];
  if (q.types && q.types.length) {
    parts.push(`(${q.types.map(() => "type LIKE ? ESCAPE '\\'").join(" OR ")})`);
    params.push(...q.types.map(likePrefix));
  }
  if (q.severity && q.severity.length) {
    const clause = inClause("severity", q.severity);
    parts.push(clause.sql);
    params.push(...clause.params);
  }
  if (q.fleetId && q.fleetId.length) {
    const clause = inClause("fleet_id", q.fleetId);
    parts.push(clause.sql);
    params.push(...clause.params);
  }
  if (q.cursor) {
    parts.push("(at < ? OR (at = ? AND id < ?))");
    params.push(q.cursor.t, q.cursor.t, q.cursor.id);
  }
  const limit = q.limit || 100;
  const rows = prepare(db, `SELECT * FROM events WHERE ${parts.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ${limit + 1}`).all(...params);
  budget.check();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    ok: true,
    rows: page.map(eventRow),
    nextCursor: rows.length > limit && last ? encodeCursor({ t: last.at, id: last.id }) : null,
  };
}

// ---------------------------------------------------------------- export

const ROLLUP_EXPORT_KEY = Object.freeze(["bucket", ...ROLLUP_FILTER_COLUMNS, "source"]);
const ROLLUP_EXPORT_COLUMNS = Object.freeze([
  ...ROLLUP_EXPORT_KEY,
  "requests", "completed", "client_aborts", "streams", "prompt_tokens", "cached_tokens", "output_tokens", "estimated_usage",
  "finish_length", "finish_tool", "duration_ms_sum", "ttft_ms_sum", "ttft_n", "decode_tps_sum", "decode_tps_n",
]);
const EVENT_EXPORT_COLUMNS = Object.freeze(["id", "at", "type", "severity", "source", "manager_id", "fleet_id", "launch_id", "request_id", "title", "data"]);

const EXPORT_COLUMNS = Object.freeze({
  requests: Object.freeze(REQUEST_COLUMNS.map(snakeToCamel)),
  rollup: Object.freeze(ROLLUP_EXPORT_COLUMNS.map(snakeToCamel)),
  events: Object.freeze(EVENT_EXPORT_COLUMNS.map(snakeToCamel)),
});

function exportWhere(q) {
  const filters = q.filters || {};
  const parts = [];
  const params = [];
  const push = (clause) => {
    parts.push(clause.sql);
    params.push(...clause.params);
  };
  if (q.kind === "requests") {
    parts.push("received_at >= ? AND received_at < ?");
    params.push(q.from, q.to);
    for (const name of ROLLUP_FILTER_COLUMNS) if (filters[name]) push(inClause(REQUEST_FILTER_EXPR[name], filters[name]));
    if (filters.ingress) push(inClause("ingress", filters.ingress));
    if (filters.stream !== undefined) {
      parts.push("stream = ?");
      params.push(filters.stream);
    }
    if (q.after) {
      parts.push("(received_at > ? OR (received_at = ? AND id > ?))");
      params.push(q.after.t, q.after.t, q.after.id);
    }
  } else if (q.kind === "rollup") {
    parts.push("bucket >= ? AND bucket < ? AND source <> 'coverage'");
    params.push(q.from, q.to);
    for (const name of ROLLUP_FILTER_COLUMNS) if (filters[name]) push(inClause(name, filters[name]));
    if (Array.isArray(q.after) && q.after.length === ROLLUP_EXPORT_KEY.length) {
      parts.push(`(${ROLLUP_EXPORT_KEY.join(", ")}) > (${ROLLUP_EXPORT_KEY.map(() => "?").join(", ")})`);
      params.push(...q.after);
    }
  } else {
    parts.push("at >= ? AND at < ?");
    params.push(q.from, q.to);
    for (const name of ["manager_id", "fleet_id"]) if (filters[name]) push(inClause(name, filters[name]));
    if (q.after) {
      parts.push("id > ?");
      params.push(q.after.id);
    }
  }
  return { sql: ` WHERE ${parts.join(" AND ")}`, params };
}

function exportTable(q) {
  if (q.kind === "requests") return "requests";
  if (q.kind === "events") return "events";
  return FAMILIES.req.tables[q.grain];
}

function exportCount(db, q) {
  const budget = createBudget(q.budgetMs);
  const where = exportWhere({ ...q, after: null });
  const row = prepare(db, `SELECT COUNT(*) AS n FROM ${exportTable(q)}${where.sql}`).get(...where.params);
  budget.check();
  return { ok: true, total: Number(row.n) };
}

function exportCell(kind, column, value) {
  if (value === null || value === undefined) return null;
  if (kind === "requests" && TIME_COLUMNS.has(column)) return iso(value);
  if (kind === "rollup" && column === "bucket") return iso(value);
  if (kind === "events" && column === "at") return iso(value);
  return value;
}

// One page of an export: {columns, rows: [[…]], next} where `next` is the
// keyset to pass as q.after (null at the end). Pages are ordered oldest first.
function exportPage(db, q) {
  const budget = createBudget(q.budgetMs);
  const limit = Math.max(1, Math.min(Number(q.pageRows) || EXPORT_PAGE_ROWS, 5000));
  const where = exportWhere(q);
  const table = exportTable(q);
  const sourceColumns = q.kind === "requests" ? REQUEST_COLUMNS : q.kind === "rollup" ? ROLLUP_EXPORT_COLUMNS : EVENT_EXPORT_COLUMNS;
  const order = q.kind === "requests" ? "received_at, id" : q.kind === "rollup" ? ROLLUP_EXPORT_KEY.join(", ") : "id";
  const rows = prepare(db, `SELECT ${sourceColumns.join(", ")} FROM ${table}${where.sql} ORDER BY ${order} LIMIT ${limit}`).all(...where.params);
  budget.check();
  const values = rows.map((row) => sourceColumns.map((column) => exportCell(q.kind, column, row[column])));
  const last = rows[rows.length - 1];
  let next = null;
  if (rows.length === limit && last) {
    if (q.kind === "requests") next = { t: last.received_at, id: last.id };
    else if (q.kind === "rollup") next = ROLLUP_EXPORT_KEY.map((column) => last[column]);
    else next = { id: last.id };
  }
  return { ok: true, columns: EXPORT_COLUMNS[q.kind].slice(), rows: values, next };
}

// Streams an export through sink(columns, rows) in pages, up to q.maxRows.
// Returns {rows, truncated}. The entry pages with exportPage itself (one
// worker call per page); this is for callers that run inside the worker.
function exportRows(db, q, sink) {
  const cap = Math.max(1, Number(q.maxRows) || 200_000);
  let written = 0;
  let after = null;
  for (;;) {
    const page = exportPage(db, { ...q, after, pageRows: Math.min(EXPORT_PAGE_ROWS, cap - written) });
    if (page.rows.length) sink(page.columns, page.rows);
    written += page.rows.length;
    if (!page.next) return { rows: written, truncated: false };
    if (written >= cap) return { rows: written, truncated: true };
    after = page.next;
  }
}

// ---------------------------------------------------------------- energy

function dayKey(at, tzMs) {
  return new Date(at + tzMs).toISOString().slice(0, 10);
}

function energy(db, q) {
  const budget = createBudget(q.budgetMs);
  const plan = planFor(db, q, ["1h", "1m"]);
  const tzMs = q.tzOffsetMinutes * MINUTE_MS;
  const config = q.energy || {};
  const gpuGroups = q.groupBy === "hour" || q.groupBy === "day" || q.groupBy === "gpu";
  const keyOfTime = (t) => (q.groupBy === "hour" ? iso(Math.floor(t / HOUR_MS) * HOUR_MS) : dayKey(t, tzMs));
  const groups = new Map();
  const touch = (key, family) => {
    let group = groups.get(key);
    if (!group) {
      group = { key, acc: FAMILIES[family].create(), tokens: null };
      groups.set(key, group);
    }
    return group;
  };
  const ctx = { sampleIntervalMs: q.sampleIntervalMs || DEFAULT_SAMPLE_INTERVAL_MS, needHist: false };
  if (gpuGroups) {
    const tiers = planTiers(q.from, q.to, plan.grains, plan.marks, plan.calendar);
    readTiers(db, "gpu", tiers, {}, budget, (tier, row, t) => {
      const key = q.groupBy === "gpu" ? String(row.gpu_index) : keyOfTime(t);
      const group = touch(key, "gpu");
      if (tier.source === "raw") addGpuRaw(group.acc, row, ctx);
      else addGpuRollup(group.acc, row, ctx, tier);
    });
    if (q.groupBy !== "gpu") {
      const reqTiers = planTiers(q.from, q.to, plan.grains, plan.marks, plan.calendar);
      readTiers(db, "req", reqTiers, {}, budget, (tier, row, t) => {
        const key = keyOfTime(t);
        const tokens = tier.source === "raw" ? numberOrNull(row.output_tokens) || 0 : Number(row.output_tokens) || 0;
        const group = groups.get(key);
        if (group) group.tokens = (group.tokens || 0) + tokens;
      });
    }
  } else {
    const tiers = planTiers(q.from, q.to, plan.grains, plan.marks, plan.calendar);
    readTiers(db, "rt", tiers, {}, budget, (tier, row) => {
      const key = String((q.groupBy === "fleet" ? row.fleet_id : row.model) ?? "");
      const group = touch(key, "rt");
      if (tier.source === "raw") addRtRaw(group.acc, row, ctx);
      else addRtRollup(group.acc, row, ctx);
      group.tokens = (group.tokens || 0) + (tier.source === "raw" ? numberOrNull(row.d_output_tokens) || 0 : numberOrNull(row.d_output_tokens) || 0);
    });
  }
  const costCtx = { energy: config, tzOffsetMinutes: q.tzOffsetMinutes };
  const rows = [];
  let totalWh = 0;
  let totalIdle = 0;
  let totalTokens = null;
  let totalCost = null;
  for (const group of groups.values()) {
    const acc = group.acc;
    if (!(acc.energy > 0) && !(acc.n > 0)) continue;
    let cost = null;
    if (gpuGroups) cost = energyCostOf(acc, costCtx);
    else if (acc.energy > 0) {
      // Runtime rows carry no hourly buckets; price them from the range average.
      const result = energyModule.costOf([[q.from, acc.energy]], config, { timezoneOffsetMinutes: q.tzOffsetMinutes, bucketMs: q.to - q.from });
      cost = result.cost;
    }
    const tokens = group.tokens;
    rows.push({
      key: group.key,
      energyWh: round(acc.energy, 4),
      idleWh: round(acc.idleEnergy, 4),
      cost,
      outputTokens: tokens,
      costPerMOutputTokens: cost !== null && tokens > 0 ? round(cost / (tokens / 1e6), 4) : null,
    });
    totalWh += acc.energy;
    totalIdle += acc.idleEnergy;
    if (tokens !== null) totalTokens = (totalTokens || 0) + tokens;
    if (cost !== null) totalCost = (totalCost || 0) + cost;
  }
  rows.sort((a, b) => {
    if (q.groupBy === "fleet" || q.groupBy === "model") return b.energyWh - a.energyWh || (a.key < b.key ? -1 : 1);
    return q.groupBy === "gpu" ? Number(a.key) - Number(b.key) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const plain = energyModule.costOf([], config, { timezoneOffsetMinutes: q.tzOffsetMinutes });
  const baselineWh = (Number(config.hostBaselineWatts) || 0) * ((q.to - q.from) / HOUR_MS);
  return {
    ok: true,
    from: iso(q.from),
    to: iso(q.to),
    groupBy: q.groupBy,
    rows,
    totals: {
      energyWh: round(totalWh, 4),
      idleWh: round(totalIdle, 4),
      hostBaselineWh: round(baselineWh, 4),
      cost: totalCost === null ? null : round(totalCost, 6),
      outputTokens: totalTokens,
      costPerMOutputTokens: totalCost !== null && totalTokens > 0 ? round(totalCost / (totalTokens / 1e6), 4) : null,
    },
    currency: plain.currency,
    tariffApplied: "current",
    priceConfigured: plain.priceConfigured,
  };
}

// ---------------------------------------------------------------- lifecycle and launches

const LIFECYCLE_TYPES = Object.freeze(["instance.state", "instance.removed", "launch.started", "launch.ready", "launch.failed", "container.exit", "container.oom"]);
const STATE_ALIASES = Object.freeze({
  loading: "loading", starting: "loading", pulling: "loading", launching: "loading",
  ready: "ready", running: "ready", serving: "ready",
  sleeping: "sleeping", sleep: "sleeping",
  crashed: "crashed", failed: "crashed", error: "crashed",
});

// The lifecycle state an event moves its instance to; null ends the interval.
function stateAfter(event, data) {
  switch (event.type) {
    case "launch.started": return "loading";
    case "launch.ready": return "ready";
    case "launch.failed": return "crashed";
    case "container.oom": return "crashed";
    case "container.exit": return Number(data.exitCode) || data.oomKilled === true ? "crashed" : null;
    case "instance.removed": return null;
    default: return STATE_ALIASES[String(data.state || "").toLowerCase()] || null;
  }
}

function lifecycle(db, q) {
  const budget = createBudget(q.budgetMs);
  const now = numberOrNull(q.now) ?? Date.now();
  const types = LIFECYCLE_TYPES;
  const marks = types.map(() => "?").join(", ");
  const seeds = prepare(db, `SELECT * FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE at < ? AND fleet_id IS NOT NULL AND type IN (${marks}) GROUP BY fleet_id)`).all(q.from, ...types);
  const inRange = prepare(db, `SELECT * FROM events WHERE at >= ? AND at < ? AND fleet_id IS NOT NULL AND type IN (${marks}) ORDER BY at, id LIMIT 20000`).all(q.from, q.to, ...types);
  budget.check();
  const fleets = new Map();
  const open = (fleetId) => {
    let fleet = fleets.get(fleetId);
    if (!fleet) {
      fleet = { fleetId, model: null, engineId: null, intervals: [], current: null };
      fleets.set(fleetId, fleet);
    }
    return fleet;
  };
  const close = (fleet, end) => {
    const current = fleet.current;
    if (!current) return;
    const from = Math.max(current.since, q.from);
    const to = Math.min(end, q.to);
    if (to > from) fleet.intervals.push({ from: iso(from), to: iso(to), state: current.state, launchId: current.launchId });
    fleet.current = null;
  };
  const apply = (event, seed) => {
    const fleet = open(event.fleet_id);
    const data = parseJson(event.data) || {};
    if (typeof data.model === "string" && data.model) fleet.model = data.model;
    if (typeof data.engineId === "string" && data.engineId) fleet.engineId = data.engineId;
    const state = stateAfter(event, data);
    const launchId = event.launch_id || null;
    if (fleet.current && fleet.current.state === state) {
      if (!fleet.current.launchId && launchId) fleet.current.launchId = launchId;
      return;
    }
    close(fleet, event.at);
    if (state) fleet.current = { state, since: seed ? Math.min(event.at, q.from) : event.at, launchId };
  };
  for (const event of seeds) apply(event, true);
  for (const event of inRange) apply(event, false);
  const end = Math.min(q.to, now);
  const instances = [];
  for (const fleet of fleets.values()) {
    close(fleet, end);
    if (fleet.intervals.length) {
      instances.push({ fleetId: fleet.fleetId, model: fleet.model, engineId: fleet.engineId, intervals: fleet.intervals });
    }
  }
  instances.sort((a, b) => (a.fleetId < b.fleetId ? -1 : 1));
  return { ok: true, from: iso(q.from), to: iso(q.to), instances };
}

function percentileOf(sorted, fraction) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function launches(db, q) {
  const budget = createBudget(q.budgetMs);
  const rows = prepare(db, "SELECT type, data FROM events WHERE at >= ? AND at < ? AND type IN ('launch.started', 'launch.ready', 'launch.failed') ORDER BY at, id LIMIT 50000").all(q.from, q.to);
  budget.check();
  const field = q.groupBy === "recipe" ? "recipeId" : q.groupBy === "engine" ? "engineId" : "model";
  const groups = new Map();
  for (const row of rows) {
    const data = parseJson(row.data) || {};
    const key = typeof data[field] === "string" && data[field] ? data[field] : "unknown";
    let group = groups.get(key);
    if (!group) {
      group = { key, started: 0, ready: 0, failed: 0, seconds: [], failures: new Map() };
      groups.set(key, group);
    }
    if (row.type === "launch.started") group.started += 1;
    else if (row.type === "launch.ready") {
      group.ready += 1;
      const durationMs = numberOrNull(data.durationMs);
      if (durationMs !== null) group.seconds.push(durationMs / 1000);
    } else {
      group.failed += 1;
      const signature = String(data.errorSignature || data.phase || "unknown").slice(0, 80);
      group.failures.set(signature, (group.failures.get(signature) || 0) + 1);
    }
  }
  const out = [...groups.values()].map((group) => {
    group.seconds.sort((a, b) => a - b);
    return {
      key: group.key,
      started: group.started,
      ready: group.ready,
      failed: group.failed,
      readyP50Seconds: round(percentileOf(group.seconds, 0.5), 1),
      readyP95Seconds: round(percentileOf(group.seconds, 0.95), 1),
      topFailures: [...group.failures.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 5)
        .map(([signature, count]) => ({ signature, count })),
    };
  });
  out.sort((a, b) => b.started - a.started || (a.key < b.key ? -1 : 1));
  return { ok: true, rows: out };
}

function baseline(db, q) {
  const budget = createBudget(q && q.budgetMs);
  const rows = prepare(db, "SELECT * FROM lifetime_baseline ORDER BY manager_id, model, source").all();
  budget.check();
  return {
    ok: true,
    rows: rows.map((row) => ({
      managerId: row.manager_id,
      model: row.model,
      firstSeen: iso(row.first_seen),
      lastSeen: iso(row.last_seen),
      promptTokens: row.prompt_tokens,
      outputTokens: row.output_tokens,
      requests: row.requests,
      source: row.source,
    })),
  };
}

// ---------------------------------------------------------------- live

function nearestRank(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

// The §11.1 snapshot. `mem` carries what only the entry knows: {now,
// inflight, collectors, instances}. The SQL is limited to the last minutes
// and primary-key reads.
function live(db, mem = {}) {
  const now = numberOrNull(mem.now) ?? Date.now();
  const budget = createBudget(mem.budgetMs);
  let perMinute = 0;
  let outputInWindow = 0;
  let total5 = 0;
  let errors5 = 0;
  let aborts5 = 0;
  const ttfts = [];
  const recent = prepare(db, "SELECT received_at, ended_at, output_tokens, error_class, terminal_state, ttft_ms FROM requests WHERE received_at >= ? ORDER BY received_at DESC LIMIT 50000");
  for (const row of recent.iterate(now - 5 * MINUTE_MS)) {
    budget.tick();
    total5 += 1;
    if (!NON_ERROR_CLASSES.has(row.error_class)) errors5 += 1;
    if (row.terminal_state === "client_abort") aborts5 += 1;
    if (row.received_at >= now - MINUTE_MS) perMinute += 1;
    if (row.ended_at >= now - MINUTE_MS) outputInWindow += numberOrNull(row.output_tokens) || 0;
    const ttft = numberOrNull(row.ttft_ms);
    if (ttft !== null) ttfts.push(ttft);
  }
  const catalog = new Map((Array.isArray(mem.instances) ? mem.instances : []).filter(isPlainObject).map((item) => [String(item.fleetId || ""), item]));
  const instances = [];
  const seen = new Set();
  for (const row of prepare(db, "SELECT * FROM runtime_samples WHERE at >= ? ORDER BY at DESC").iterate(now - 3 * MINUTE_MS)) {
    budget.tick();
    if (seen.has(row.fleet_id)) continue;
    seen.add(row.fleet_id);
    const known = catalog.get(row.fleet_id) || {};
    const stateRow = prepare(db, "SELECT data FROM events WHERE fleet_id = ? AND type = 'instance.state' ORDER BY at DESC, id DESC LIMIT 1").get(row.fleet_id);
    const stateData = stateRow ? parseJson(stateRow.data) || {} : {};
    instances.push({
      fleetId: row.fleet_id,
      engineId: known.engineId || row.engine_id || null,
      model: known.model || row.model || "",
      state: known.state || STATE_ALIASES[String(stateData.state || "").toLowerCase()] || "ready",
      idle: Boolean(row.idle),
      running: row.running,
      waiting: row.waiting,
      kvUsage: row.kv_usage,
      outputTps: round(row.output_tps),
      vramReservationMb: numberOrNull(known.vramReservationMb),
      sampleAt: iso(row.at),
    });
  }
  const gpus = [];
  const seenGpu = new Set();
  for (const row of prepare(db, "SELECT * FROM gpu_samples WHERE at >= ? ORDER BY at DESC").iterate(now - 3 * MINUTE_MS)) {
    if (seenGpu.has(row.gpu_index)) continue;
    seenGpu.add(row.gpu_index);
    gpus.push({
      index: row.gpu_index,
      util: row.util_pct,
      memUsedMb: row.mem_used_mb,
      memTotalMb: row.mem_total_mb,
      tempC: row.temp_c,
      powerW: row.power_w,
      powerLimitW: row.power_limit_w,
      throttle: reasonsOf(row.throttle),
    });
  }
  gpus.sort((a, b) => a.index - b.index);
  const alerts = prepare(db, "SELECT COUNT(*) AS firing, COALESCE(SUM(CASE WHEN r.severity = 'critical' THEN 1 ELSE 0 END), 0) AS critical FROM alert_state s LEFT JOIN alert_rules r ON r.rule_id = s.rule_id WHERE s.state = 'firing'").get();
  const states = { recorder: "ok", runtime: "ok", gpu: "ok", events: "ok", store: "ok" };
  if (isPlainObject(mem.collectors)) for (const [name, value] of Object.entries(mem.collectors)) if (name in states && typeof value === "string") states[name] = value;
  return {
    ok: true,
    at: iso(now),
    windowSeconds: 60,
    gateway: {
      inflight: numberOrNull(mem.inflight) ?? 0,
      requestsPerMin: perMinute,
      outputTokensPerSec: round(outputInWindow / 60, 1),
      errorRate5m: round(ratio(errors5, total5)),
      ttftP95Ms5m: round(nearestRank(ttfts, 0.95), 1),
      clientAborts5m: aborts5,
    },
    instances,
    gpus,
    alerts: { firing: Number(alerts.firing) || 0, critical: Number(alerts.critical) || 0 },
    collectors: states,
  };
}

// ---------------------------------------------------------------- status helpers

function rollupStatus(db) {
  const marks = readWatermarks(db);
  const dirty = prepare(db, "SELECT COUNT(*) AS n FROM rollup_dirty").get();
  return { ok: true, watermark1m: marks["1m"], watermark1h: marks["1h"], watermark1d: marks["1d"], dirty: Number(dirty.n) };
}

function importRuns(db) {
  const rows = prepare(db, "SELECT source, started_at, finished_at, rows_in, rows_written, rows_skipped, status FROM import_runs ORDER BY id DESC LIMIT 20").all();
  return {
    ok: true,
    runs: rows.map((row) => ({
      source: row.source,
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      rowsIn: row.rows_in,
      rowsWritten: row.rows_written,
      rowsSkipped: row.rows_skipped,
      status: row.status,
    })),
  };
}

module.exports = {
  ANNOTATION_KINDS,
  BREAKDOWN_METRICS,
  DEFAULT_BREAKDOWN_METRICS,
  DIMENSIONS,
  ERROR_CLASS_LABELS,
  EXPORT_COLUMNS,
  EXPORT_KINDS,
  FILTER_PARAMS,
  GROUP_BY_BY_FAMILY,
  MAX_POINTS,
  METRICS,
  OWNER_ONLY_DIMENSIONS,
  QueryError,
  baseline,
  breakdown,
  decodeCursor,
  encodeCursor,
  energy,
  exportCount,
  exportPage,
  exportRows,
  getRequest,
  importRuns,
  launches,
  lifecycle,
  listEvents,
  listRequests,
  live,
  parseQuery,
  rollupStatus,
  summary,
  timeseries,
};
