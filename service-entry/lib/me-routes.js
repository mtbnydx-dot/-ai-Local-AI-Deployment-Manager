"use strict";

// The /v1/me family (docs/overhaul/05-public.md §8.5, PUB-13): what a key
// holder sees about their own key, usage and requests, and the two writes they
// may do themselves (rotate the key, edit the allowed origins).
//
//   GET  /v1/me                  the key, its limits, rate state, usage, quota
//   GET  /v1/me/usage[.csv]      daily usage (telemetry, else the counters)
//   GET  /v1/me/requests         recent requests, never IP or content
//   POST /v1/me/rotate           self.rotate, same-origin, 3/hour
//   PUT  /v1/me/origins          self.origins, same-origin, 20/hour
//
// The same handler answers /gateway/me on ADMIN. Authentication, the scope and
// the 401-storm bookkeeping are the shared pipeline's (authorize); the rate
// limit is a per-key "meta" bucket of the limiter (30/min) that is separate
// from rpm and tpm, so reading this page never costs inference quota.
//
// Everything this file reads from outside is injected, so the tests run on
// fakes:
//   pipeline     { authorize, checkBan, sendRefusal, listenerOf }
//   limiter      { describeLimits, peekRate, takeSelf, quotaTzOffset }
//   keysStore    object or getter: getKey, getUsage, listDailyUsage, rotateKey,
//                updateKey, appendAudit, listAnnouncements
//   config       AccessConfig (object or getter): publicOrigin
//   billing      object or getter: getCustomerSummary, lookupCustomerForCredential
//   telemetry    object, getter or null: timeseries(params, { tzOffsetMinutes })
//                and requests(params), both resolving to the 04 query result
//   listModels   async (req, caller) -> [{ id }] the models the key may use
//   sendJson     (res, body, status, headers)
//   corsHeaders  (req, caller|null) -> headers
//   record       (req) -> the telemetry record or null (reject() on refusals)
//   clientIp     (req) -> the resolved client address, for the audit rows
//   onKeyChanged () after a write that changes what other requests see

const { accessLogCsvCell } = require("../../manager-core/access-log");
const { quotaPeriods } = require("./keys-store");
const keyPolicy = require("./key-policy");
const { ME_ROUTES, formatCredits } = require("./public-api");
const { newRequestId, pickLanguage } = require("./public-errors");

const MAX_USAGE_DAYS = 92;
const DEFAULT_USAGE_DAYS = 30;
const MAX_REQUESTS_LIMIT = 100;
const DEFAULT_REQUESTS_LIMIT = 50;
const REQUESTS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ORIGINS = 10;
const MAX_BODY_BYTES = 4096;
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USAGE_COLUMNS = Object.freeze(["date", "model", "requests", "input_tokens", "cached_input_tokens", "output_tokens", "errors"]);
const USAGE_METRICS = Object.freeze({
  "req.count": "requests",
  "req.errors": "errors",
  "tok.prompt": "input_tokens",
  "tok.cached": "cached_input_tokens",
  "tok.output": "output_tokens",
});

class MeError extends Error {
  constructor(status, code, message, param = null, retryAfterSeconds = null) {
    super(message);
    this.name = "MeError";
    this.status = status;
    this.code = code;
    this.param = param;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// ---- pure helpers (exported for the tests) --------------------------------------

/**
 * paceOf({ limit, used, start, end, now }) -> { remaining, pace, projectedExhaustionAt } | null
 * `pace` compares used with limit x elapsed fraction of the period: ok (at or
 * below), ahead (above) or exhausted (nothing left). The projection is linear
 * from the period start and is null when it would land after the period, when
 * nothing was used yet or when the quota is already spent.
 */
function paceOf({ limit, used, start, end, now }) {
  const cap = positive(limit);
  if (cap === null) return null;
  const spent = Math.max(0, Number(used) || 0);
  const span = Math.max(0, end - start);
  const elapsed = Math.min(span, Math.max(0, now - start));
  const fraction = span > 0 ? elapsed / span : 1;
  const remaining = Math.max(0, cap - spent);
  let pace = "ok";
  if (remaining === 0) pace = "exhausted";
  else if (spent > cap * fraction + 1e-9) pace = "ahead";
  let projectedExhaustionAt = null;
  if (remaining > 0 && spent > 0 && elapsed > 0) {
    const at = now + (remaining * elapsed) / spent;
    if (at < end) projectedExhaustionAt = new Date(Math.round(at)).toISOString();
  }
  return { remaining, pace, projectedExhaustionAt };
}

function quotaView(limit, used, period, now) {
  const cap = positive(limit);
  if (cap === null) return null;
  const verdict = paceOf({ limit: cap, used, start: Date.parse(period.start), end: Date.parse(period.end), now });
  return { limit: cap, used, remaining: verdict.remaining, pace: verdict.pace, projected_exhaustion_at: verdict.projectedExhaustionAt };
}

// Decimal credits from microcredits with exactly six decimals ("12.500000").
function credits6(micro) {
  const text = formatCredits(micro);
  if (text === null) return null;
  const [whole, fraction = ""] = text.split(".");
  return `${whole}.${fraction.padEnd(6, "0")}`;
}

function dateKey(ms, tzOffsetMinutes) {
  return new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function dateStart(date, tzOffsetMinutes) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) - tzOffsetMinutes * 60_000;
}

function validDate(text) {
  if (!DATE_RE.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

/**
 * parseUsageQuery(searchParams, { today }) -> { from, to, byModel }
 * Dates are quota-timezone days. Defaults to the last 30 days; at most 92 days.
 */
function parseUsageQuery(searchParams, { today }) {
  const to = searchParams.has("to") ? String(searchParams.get("to")) : today;
  if (!validDate(to)) throw new MeError(400, "invalid_request", "to must be a date as YYYY-MM-DD.", "to");
  const from = searchParams.has("from") ? String(searchParams.get("from")) : addDays(to, -(DEFAULT_USAGE_DAYS - 1));
  if (!validDate(from)) throw new MeError(400, "invalid_request", "from must be a date as YYYY-MM-DD.", "from");
  if (from > to) throw new MeError(400, "invalid_request", "from must not be after to.", "from");
  if (daysBetween(from, to) + 1 > MAX_USAGE_DAYS) throw new MeError(400, "invalid_request", `The range may be at most ${MAX_USAGE_DAYS} days.`, "from");
  let byModel = false;
  if (searchParams.has("group_by")) {
    const parts = String(searchParams.get("group_by")).split(",").map((item) => item.trim()).filter(Boolean);
    if (!parts.includes("day") || parts.some((item) => item !== "day" && item !== "model") || new Set(parts).size !== parts.length) {
      throw new MeError(400, "invalid_request", "group_by is day or day,model.", "group_by");
    }
    byModel = parts.includes("model");
  }
  return { from, to, byModel };
}

function emptyRow(date, model) {
  const row = { date };
  if (model !== undefined) row.model = model;
  return Object.assign(row, { requests: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, errors: 0 });
}

/**
 * usageRowsFromSeries(body, { from, to, byModel, tzOffsetMinutes }) -> rows
 * Folds a 04 timeseries result (one series per metric and group, day steps)
 * into the §8.5 day rows. Without model grouping every day of the range is
 * present, with zeros where nothing was recorded.
 */
function usageRowsFromSeries(body, { from, to, byModel, tzOffsetMinutes }) {
  const rows = new Map();
  if (!byModel) {
    for (let date = from; date <= to; date = addDays(date, 1)) rows.set(date, emptyRow(date));
  }
  for (const series of Array.isArray(body?.series) ? body.series : []) {
    const field = USAGE_METRICS[series.metric];
    if (!field) continue;
    const model = byModel ? (series.group?.other ? "other" : String(series.group?.model ?? "")) : undefined;
    for (const [at, value] of Array.isArray(series.points) ? series.points : []) {
      const date = dateKey(Number(at), tzOffsetMinutes);
      if (date < from || date > to) continue;
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount === 0) continue;
      const key = byModel ? `${date}\n${model}` : date;
      if (!rows.has(key)) rows.set(key, emptyRow(date, model));
      rows.get(key)[field] += Math.round(amount);
    }
  }
  return [...rows.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.model || "") < String(b.model || "") ? -1 : 1));
}

function usageRowsFromCounters(days, { from, to }) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const rows = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const day = byDate.get(date);
    rows.push(day
      ? { date, requests: day.requests, input_tokens: day.inputTokens, cached_input_tokens: day.cachedInputTokens, output_tokens: day.outputTokens, errors: day.errors }
      : emptyRow(date));
  }
  return rows;
}

// BOM-prefixed, formula-escaped, CRLF (the access-log export rules).
function usageCsv(rows) {
  const lines = [USAGE_COLUMNS.map(accessLogCsvCell).join(",")];
  for (const row of rows) lines.push(USAGE_COLUMNS.map((column) => accessLogCsvCell(row[column] ?? "")).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * normalizeOrigins(list) -> canonical origins (deduplicated)
 * Exact `https://host[:port]`, plus http for localhost and 127.0.0.1. `*` and
 * everything else is rejected; at most 10.
 */
function normalizeOrigins(list) {
  if (!Array.isArray(list)) throw new MeError(400, "invalid_request", "origins must be an array.", "origins");
  if (list.length > MAX_ORIGINS) throw new MeError(400, "invalid_request", `At most ${MAX_ORIGINS} origins are allowed.`, "origins");
  const out = [];
  for (const item of list) {
    const text = typeof item === "string" ? item.trim() : "";
    const origin = text === "*" ? "" : keyPolicy.normalizeOrigin(text);
    let ok = false;
    if (origin) {
      const url = new URL(origin);
      ok = url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
    }
    if (!ok) throw new MeError(400, "invalid_request", "Each origin must be https://host[:port], or http://localhost[:port] or http://127.0.0.1[:port].", "origins");
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

// ---- the routes -----------------------------------------------------------------

function createMeRoutes(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const logger = deps.logger || console;
  const resolve = (value) => (typeof value === "function" ? value() : value);
  const keysStoreOf = () => resolve(deps.keysStore);
  const configOf = () => {
    const value = resolve(deps.config);
    return value && typeof value === "object" ? value : {};
  };
  const pipeline = () => resolve(deps.pipeline);
  const limiter = () => resolve(deps.limiter);

  function warn(message) {
    try {
      logger?.warn?.(message);
    } catch {
      // Logging never breaks a request.
    }
  }

  function clientIpOf(req) {
    try {
      return (typeof deps.clientIp === "function" ? deps.clientIp(req) : "") || undefined;
    } catch {
      return undefined;
    }
  }

  function requestIdOf(req, res) {
    return req.requestId || (typeof res.getHeader === "function" && res.getHeader("x-request-id")) || (req.requestId = newRequestId());
  }

  function baseHeaders(req, res, caller) {
    const headers = { "cache-control": "no-store", "x-request-id": requestIdOf(req, res), ...(deps.corsHeaders ? deps.corsHeaders(req, caller) : {}) };
    return headers;
  }

  function refuse(req, res, caller, { status, code, message = "", param = null, retryAfterSeconds = null, headers = {} }) {
    deps.record?.(req)?.reject?.({ status, code });
    return pipeline().sendRefusal(req, res, { status, code, message, param, retryAfterSeconds, headers: { ...baseHeaders(req, res, caller), ...headers } });
  }

  function send(req, res, caller, body, status = 200) {
    return deps.sendJson(res, body, status, baseHeaders(req, res, caller));
  }

  // ---- same-origin (writes) ------------------------------------------------------

  // A write from a browser must come from the page itself: no Origin header
  // (curl, SDKs), the configured public origin, or the origin of the Host the
  // request was sent to. Anything else is a cross-site request.
  function sameOrigin(req) {
    const raw = String(req.headers?.origin || "").trim();
    if (!raw) return true;
    const origin = keyPolicy.normalizeOrigin(raw);
    if (!origin || origin === "*") return false;
    const configured = keyPolicy.normalizeOrigin(configOf().publicOrigin || "");
    if (configured && origin === configured) return true;
    const host = String(req.headers?.host || "").trim().toLowerCase();
    return Boolean(host) && new URL(origin).host.toLowerCase() === host;
  }

  async function readJsonBody(req) {
    const type = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") throw new MeError(415, "unsupported_media_type", "Send application/json.");
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new MeError(413, "request_too_large", "The body is too large.");
      chunks.push(chunk);
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new MeError(400, "invalid_json", "The body is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MeError(400, "invalid_request", "The body must be a JSON object.");
    return parsed;
  }

  // ---- data sources --------------------------------------------------------------

  function telemetryOf() {
    const value = resolve(deps.telemetry);
    return value && typeof value.timeseries === "function" ? value : null;
  }

  // Telemetry day rows for a key, or null when telemetry cannot answer.
  async function telemetryDays({ keyId, fromMs, toMs, byModel, tzOffsetMinutes, from, to }) {
    const telemetry = telemetryOf();
    if (!telemetry) return null;
    try {
      const params = {
        from: String(fromMs),
        to: String(Math.max(toMs, fromMs + 1)),
        metrics: Object.keys(USAGE_METRICS).join(","),
        step: String(DAY_MS / 1000),
        key_id: keyId,
      };
      if (byModel) Object.assign(params, { groupBy: "model", top: "20" });
      const body = await telemetry.timeseries(params, { tzOffsetMinutes });
      if (!body || !Array.isArray(body.series)) return null;
      return usageRowsFromSeries(body, { from, to, byModel, tzOffsetMinutes });
    } catch (error) {
      warn(`me usage: telemetry could not answer (${error?.code || "error"}); using the counters`);
      return null;
    }
  }

  function sumRows(rows) {
    const total = { requests: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    for (const row of rows) for (const field of Object.keys(total)) total[field] += row[field] || 0;
    return total;
  }

  function counterTotals(period) {
    return { requests: period.requests, input_tokens: period.inputTokens, cached_input_tokens: period.cachedInputTokens, output_tokens: period.outputTokens };
  }

  function billingView(key) {
    const billing = resolve(deps.billing);
    if (!billing) return null;
    try {
      let customerId = key.customerId || "";
      if (!customerId && key.billing?.scope && key.billing?.clientId && typeof billing.lookupCustomerForCredential === "function") {
        customerId = billing.lookupCustomerForCredential(key.billing.scope, key.billing.clientId)?.customerId || "";
      }
      if (!customerId) return null;
      const summary = billing.getCustomerSummary(customerId, { at: new Date(now()) });
      if (!summary) return null;
      return {
        bound: true,
        mode: summary.enforcementMode,
        balance_credits: credits6(summary.balanceMicrocredits),
        period_spend_credits: credits6(summary.periodSpendMicrocredits),
      };
    } catch (error) {
      warn(`me billing: the customer summary was skipped (${error?.code || "error"})`);
      return null;
    }
  }

  function announcementsView(store, language, at) {
    try {
      const rows = store.listAnnouncements({ published: true, limit: 50 });
      return rows
        .filter((row) => !row.endsAt || Date.parse(row.endsAt) > at)
        .map((row) => ({
          id: row.id,
          severity: row.severity,
          title: language === "zh-CN" ? row.title.zh : row.title.en,
          starts_at: row.startsAt,
          ends_at: row.endsAt ?? null,
        }));
    } catch {
      return [];
    }
  }

  async function availableModels(req, caller) {
    if (typeof deps.listModels !== "function") return [];
    try {
      return (await deps.listModels(req, caller)).map((entry) => String(entry.id));
    } catch (error) {
      warn(`me models: the model list was skipped (${error?.code || "error"})`);
      return [];
    }
  }

  // ---- GET /v1/me ----------------------------------------------------------------

  async function buildMe(req, res, caller) {
    const store = keysStoreOf();
    const at = now();
    const key = store.getKey(caller.key.id) || caller.key;
    const listener = pipeline().listenerOf(req);
    const limits = limiter().describeLimits(caller, listener);
    const tz = limiter().quotaTzOffset();
    const counters = store.getUsage(key.id, { at: new Date(at), tzOffsetMinutes: tz });
    const periods = quotaPeriods(at, counters.tzOffsetMinutes);
    const today = dateKey(at, counters.tzOffsetMinutes);
    const monthDays = await telemetryDays({
      keyId: key.id,
      fromMs: Date.parse(periods.month.start),
      toMs: at + 1,
      byModel: false,
      tzOffsetMinutes: counters.tzOffsetMinutes,
      from: dateKey(Date.parse(periods.month.start), counters.tzOffsetMinutes),
      to: today,
    });
    const dayTotals = monthDays ? sumRows(monthDays.filter((row) => row.date === today)) : counterTotals(counters.day);
    const monthTotals = monthDays ? sumRows(monthDays) : counterTotals(counters.month);
    const dayUsed = counters.day.inputTokens + counters.day.outputTokens;
    const monthUsed = counters.month.inputTokens + counters.month.outputTokens;
    const rate = limiter().peekRate(caller, listener, { at });
    const scopes = Array.isArray(key.scopes) ? key.scopes : [];
    return {
      object: "key",
      id: key.id,
      name: key.name,
      preview: key.preview,
      class: key.class,
      status: key.status,
      created_at: key.createdAt,
      expires_at: key.expiresAt ?? null,
      scopes,
      models: { patterns: Array.isArray(key.models) ? key.models : [], available: await availableModels(req, caller) },
      limits: {
        rpm: limits.rpm ?? null,
        tpm: limits.tpm ?? null,
        max_concurrent: limits.maxConcurrent ?? null,
        max_output_tokens: limits.outputCap ?? null,
        daily_tokens: positive(key.limits?.dailyTokens),
        monthly_tokens: positive(key.limits?.monthlyTokens),
      },
      rate_limit: rate,
      usage: {
        today: { ...dayTotals, resets_at: counters.dayResetsAt },
        month: { ...monthTotals, resets_at: counters.monthResetsAt },
      },
      quota: {
        daily_tokens: quotaView(key.limits?.dailyTokens, dayUsed, periods.day, at),
        monthly_tokens: quotaView(key.limits?.monthlyTokens, monthUsed, periods.month, at),
      },
      billing: billingView(key),
      allowed_origins: Array.isArray(key.allowedOrigins) ? key.allowedOrigins : [],
      self_service: { rotate: scopes.includes("self.rotate"), origins: scopes.includes("self.origins") },
      announcements: announcementsView(store, pickLanguage(req.headers?.["accept-language"]), at),
      request_id: requestIdOf(req, res),
    };
  }

  // ---- GET /v1/me/usage[.csv] ----------------------------------------------------

  async function buildUsage(req, url, caller) {
    const store = keysStoreOf();
    const at = now();
    const counters = store.getUsage(caller.key.id, { at: new Date(at), tzOffsetMinutes: limiter().quotaTzOffset() });
    const tz = counters.tzOffsetMinutes;
    const query = parseUsageQuery(url.searchParams, { today: dateKey(at, tz) });
    const fromMs = dateStart(query.from, tz);
    const toMs = dateStart(addDays(query.to, 1), tz);
    const telemetryRows = await telemetryDays({ keyId: caller.key.id, fromMs, toMs, byModel: query.byModel, tzOffsetMinutes: tz, from: query.from, to: query.to });
    if (telemetryRows) return { source: "telemetry", rows: telemetryRows, granularity: "day" };
    // The counters know days only; a model grouping falls back to plain days.
    const days = store.listDailyUsage(caller.key.id, { from: query.from, to: query.to });
    return { source: "counters", rows: usageRowsFromCounters(days, query), granularity: "day" };
  }

  async function serveUsage(req, res, url, caller, csv) {
    const usage = await buildUsage(req, url, caller);
    if (csv) {
      const text = usageCsv(usage.rows);
      const from = usage.rows[0]?.date || "usage";
      const to = usage.rows[usage.rows.length - 1]?.date || from;
      res.writeHead(200, {
        ...baseHeaders(req, res, caller),
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="usage-${from}_${to}.csv"`,
        "content-length": String(Buffer.byteLength(text)),
      });
      res.end(String(req.method).toUpperCase() === "HEAD" ? undefined : text);
      return undefined;
    }
    return send(req, res, caller, { object: "list", granularity: usage.granularity, data: usage.rows, source: usage.source });
  }

  // ---- GET /v1/me/requests -------------------------------------------------------

  function requestItem(row) {
    return {
      request_id: row.requestId,
      at: row.receivedAt,
      model: row.modelResolved || row.modelRequested || null,
      endpoint: row.op || row.route || row.path || null,
      stream: Boolean(row.stream),
      status: row.status ?? null,
      error_code: row.errorCode || row.errorClass || null,
      input_tokens: row.promptTokens ?? null,
      cached_input_tokens: row.cachedTokens ?? null,
      output_tokens: row.outputTokens ?? null,
      ttft_ms: row.ttftMs ?? null,
      duration_ms: row.durationMs ?? null,
    };
  }

  async function serveRequests(req, res, url, caller) {
    let limit = DEFAULT_REQUESTS_LIMIT;
    if (url.searchParams.has("limit")) {
      const text = String(url.searchParams.get("limit"));
      limit = /^\d{1,4}$/.test(text) ? Number(text) : 0;
      if (limit < 1 || limit > MAX_REQUESTS_LIMIT) throw new MeError(400, "invalid_request", `limit is 1 to ${MAX_REQUESTS_LIMIT}.`, "limit");
    }
    const cursor = url.searchParams.has("cursor") ? String(url.searchParams.get("cursor")) : "";
    if (cursor.length > 200) throw new MeError(400, "invalid_request", "The cursor is invalid.", "cursor");
    const telemetry = resolve(deps.telemetry);
    if (telemetry && typeof telemetry.requests === "function") {
      const at = now();
      const params = { key_id: caller.key.id, from: String(at - REQUESTS_WINDOW_MS), to: String(at + 1), limit: String(limit) };
      if (cursor) params.cursor = cursor;
      let body = null;
      try {
        body = await telemetry.requests(params);
      } catch (error) {
        if (error?.code === "invalid_cursor" || error?.name === "QueryError") throw new MeError(400, "invalid_request", "The cursor is invalid.", "cursor");
        warn(`me requests: telemetry could not answer (${error?.code || "error"})`);
      }
      if (body && Array.isArray(body.rows)) {
        return send(req, res, caller, { object: "list", data: body.rows.map(requestItem), next_cursor: body.nextCursor || null, source: "telemetry" });
      }
    }
    return send(req, res, caller, { object: "list", data: [], next_cursor: null, source: "counters" });
  }

  // The hourly bucket of a write, taken once the request is well-formed, so a
  // typo does not use up one of the three rotations.
  function chargeWrite(caller, kind) {
    const taken = limiter().takeSelf(caller.key.id, kind);
    if (!taken.ok) throw new MeError(429, "rate_limit_exceeded", `Rate limit exceeded. Retry after ${taken.retryAfterSeconds}s.`, null, taken.retryAfterSeconds);
  }

  // ---- POST /v1/me/rotate --------------------------------------------------------

  async function serveRotate(req, res, caller) {
    const body = await readJsonBody(req);
    if (body.confirm !== true) throw new MeError(400, "invalid_request", "Send {\"confirm\":true} to rotate the key.", "confirm");
    chargeWrite(caller, "rotate");
    const store = keysStoreOf();
    const ip = clientIpOf(req);
    let rotated;
    try {
      rotated = store.rotateKey(caller.key.id, { actor: `key:${caller.key.id}`, ip, overlapSeconds: 0, self: true });
    } catch (error) {
      throw storeFailure(error);
    }
    return send(req, res, caller, {
      key: rotated.secret,
      preview: rotated.key.preview,
      rotated_at: rotated.key.updatedAt,
      previous_valid_until: null,
    });
  }

  // ---- PUT /v1/me/origins --------------------------------------------------------

  async function serveOrigins(req, res, caller) {
    const body = await readJsonBody(req);
    const origins = normalizeOrigins(body.origins);
    chargeWrite(caller, "origins");
    const store = keysStoreOf();
    const ip = clientIpOf(req);
    let updated;
    try {
      updated = store.updateKey(caller.key.id, { allowedOrigins: origins }, { actor: `key:${caller.key.id}`, ip });
      store.appendAudit({
        actor: `key:${caller.key.id}`,
        actorIp: ip,
        action: "key.origins.self",
        targetType: "key",
        targetId: caller.key.id,
        details: { count: origins.length },
      });
    } catch (error) {
      throw storeFailure(error);
    }
    deps.onKeyChanged?.();
    return send(req, res, caller, { allowed_origins: updated.allowedOrigins });
  }

  function storeFailure(error) {
    if (error instanceof MeError) return error;
    if (error?.code === "invalid_field") return new MeError(400, "invalid_request", "The value is not valid for this key.");
    if (error?.code === "key_revoked") return new MeError(403, "key_disabled", "The key is disabled.");
    warn(`me: the key store failed (${error?.code || "error"})`);
    return new MeError(500, "internal_error", "The key store failed.");
  }

  // ---- dispatch ------------------------------------------------------------------

  function routeKeyOf(url) {
    return String(url.pathname || "").replace(/^\/gateway\/me\/?/, "").replace(/\/+$/, "");
  }

  async function handle(req, res, url) {
    const method = String(req.method || "GET").toUpperCase();
    const routeKey = routeKeyOf(url);
    const item = Object.prototype.hasOwnProperty.call(ME_ROUTES, routeKey) ? ME_ROUTES[routeKey] : null;
    if (method === "OPTIONS") {
      res.writeHead(204, { ...(deps.corsHeaders ? deps.corsHeaders(req, null) : {}), "x-request-id": requestIdOf(req, res) });
      return res.end();
    }
    if (!item) return refuse(req, res, null, { status: 404, code: "not_found" });
    const isRead = method === "GET" || method === "HEAD";
    if (!item.methods.includes(isRead ? "GET" : method)) {
      return refuse(req, res, null, { status: 405, code: "method_not_allowed", headers: { allow: item.methods.join(", ") } });
    }
    const p = pipeline();
    const ban = p.checkBan(req);
    if (ban) return refuse(req, res, null, { status: 429, code: "auth_banned", message: ban.message, retryAfterSeconds: ban.retryAfterSeconds });
    // The portal calls this API from its own origin. A key's allowed_origins
    // list is for other sites, so a same-origin Origin header is not judged
    // against it (it would refuse every portal write for a key with no list).
    // Other origins stay in the header and are judged as on every PUBLIC route.
    const ownOrigin = req.headers?.origin && sameOrigin(req) ? req.headers.origin : "";
    if (ownOrigin) delete req.headers.origin;
    let caller;
    try {
      caller = await p.authorize(req, { scope: item.scope });
    } finally {
      if (ownOrigin) req.headers.origin = ownOrigin;
    }
    if (!caller.ok) return refuse(req, res, null, caller);
    if (caller.kind !== "key" || !caller.key) {
      return refuse(req, res, caller, { status: 400, code: "invalid_request", message: "This route describes an API key; call it with a key." });
    }
    try {
      const meta = limiter().takeSelf(caller.key.id, "meta");
      if (!meta.ok) {
        return refuse(req, res, caller, { status: 429, code: "rate_limit_exceeded", message: `Rate limit exceeded. Retry after ${meta.retryAfterSeconds}s.`, retryAfterSeconds: meta.retryAfterSeconds });
      }
      if (!isRead) {
        if (!sameOrigin(req)) {
          return refuse(req, res, caller, { status: 403, code: "origin_not_allowed", message: "This route accepts same-origin requests only." });
        }
      }
      if (routeKey === "") return send(req, res, caller, await buildMe(req, res, caller));
      if (routeKey === "usage") return await serveUsage(req, res, url, caller, false);
      if (routeKey === "usage.csv") return await serveUsage(req, res, url, caller, true);
      if (routeKey === "requests") return await serveRequests(req, res, url, caller);
      if (routeKey === "rotate") return await serveRotate(req, res, caller);
      return await serveOrigins(req, res, caller);
    } catch (error) {
      const failure = error instanceof MeError ? error : storeFailure(error);
      return refuse(req, res, caller, { status: failure.status, code: failure.code, message: failure.message, param: failure.param, retryAfterSeconds: failure.retryAfterSeconds });
    }
  }

  return { handle, buildMe };
}

module.exports = {
  MeError,
  createMeRoutes,
  credits6,
  normalizeOrigins,
  paceOf,
  parseUsageQuery,
  usageCsv,
  usageRowsFromCounters,
  usageRowsFromSeries,
};
