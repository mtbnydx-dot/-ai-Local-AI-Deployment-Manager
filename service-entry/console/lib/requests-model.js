// The pure part of the Requests explorer and the request detail (07 §6.7, 04
// §11.5, §11.6, §19): the request-only filters in the URL, the parameters of
// GET /api/telemetry/requests and of the export, the facets, and the timeline
// waterfall. Nothing here touches the DOM or the clock; `now` and the search
// string are always passed in, so the tests run in Node.
//
// URL state: the Observability view state (range, common filters, refresh;
// lib/observability-model.js) plus the filters only the request list takes:
// status_class, error_class, terminal_state, q, min_duration_ms, min_ttft_ms,
// min_output_tokens and client_ip.

import { FILTER_IDS, patchObsSearch, queryFor } from "./observability-model.js";

/** The request-list filters that are not common filters (04 §11.5), in the order the form shows them. */
export const REQUEST_FILTER_IDS = Object.freeze(["status_class", "error_class", "terminal_state", "q", "min_duration_ms", "min_ttft_ms", "min_output_tokens", "client_ip"]);
export const STATUS_CLASSES = Object.freeze(["2xx", "3xx", "4xx", "5xx", "none"]);
export const TERMINAL_STATES = Object.freeze(["completed", "failed", "client_abort", "timeout", "rejected"]);
/** The facets of 04 §11.5 and where each one lands: a request-only filter or a common one. */
export const FACETS = Object.freeze([
  Object.freeze({ id: "status_class", target: "extra" }),
  Object.freeze({ id: "error_class", target: "extra" }),
  Object.freeze({ id: "model", target: "common" }),
  Object.freeze({ id: "source_program", target: "common" }),
]);
export const PAGE_SIZE = 100;
export const MIN_ID_QUERY = 6;
const NUMERIC = Object.freeze(["min_duration_ms", "min_ttft_ms", "min_output_tokens"]);
const MAX_LIST_VALUES = 20;
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);

// ---------------------------------------------------------------------------
// URL state

/** The comma list "a,b" as an array without blanks or repeats. */
export function listValues(text) {
  const seen = new Set();
  for (const part of String(text ?? "").split(",")) {
    const value = part.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

function cleanValue(name, raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (name === "status_class") return listValues(text).filter((value) => STATUS_CLASSES.includes(value)).slice(0, MAX_LIST_VALUES).join(",");
  if (name === "terminal_state") return listValues(text).filter((value) => TERMINAL_STATES.includes(value)).join(",");
  if (name === "error_class") return listValues(text).filter((value) => /^[a-z][a-z0-9_]{0,63}$/.test(value)).slice(0, MAX_LIST_VALUES).join(",");
  if (name === "q") return /^[A-Za-z0-9._:/-]{1,128}$/.test(text) ? text : "";
  if (name === "client_ip") return /^[0-9A-Fa-f:.%]{1,64}$/.test(text) ? text : "";
  if (NUMERIC.includes(name)) return /^\d{1,12}$/.test(text) ? String(Number(text)) : "";
  return "";
}

/** The request-only filters of a search string; unusable values are dropped. */
export function parseRequestFilters(search) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const filters = {};
  for (const name of REQUEST_FILTER_IDS) {
    const value = cleanValue(name, params.get(name));
    if (value) filters[name] = value;
  }
  return filters;
}

/** The value a filter field would send: cleaned text, or null for "remove". */
export function cleanFilter(name, raw) {
  return cleanValue(name, raw) || null;
}

/** `current` (a comma list) with `value` added, or removed when it is already in. Null when nothing is left. */
export function toggleListValue(current, value) {
  const values = listValues(current);
  const next = values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
  return next.length ? next.slice(0, MAX_LIST_VALUES).join(",") : null;
}

/** The patchObsSearch patch of one filter change: common filters travel as `filters`, the rest as `extra`. */
export function filterPatch(name, value) {
  return FILTER_IDS.includes(name) ? { filters: { [name]: value } } : { extra: { [name]: cleanFilter(name, value) } };
}

/** The search string with every request-only filter removed (the "clear" action). */
export function clearRequestFilters(search) {
  return patchObsSearch(search, { extra: Object.fromEntries(REQUEST_FILTER_IDS.map((name) => [name, null])) });
}

/** How many request-only filters are set. */
export function activeFilterCount(state, filters) {
  return Object.keys(state.filters).length + Object.keys(filters).length;
}

// ---------------------------------------------------------------------------
// Parameters

/**
 * The query of GET /api/telemetry/requests. Searching by request id (`q`)
 * leaves the window out, so a request older than the chosen range is found
 * (04 §11.5: without `from` and `to` the id search covers everything kept).
 * @param state parseObsSearch(...)
 * @param filters parseRequestFilters(...)
 */
export function requestsQuery(state, filters, now, { cursor = null, facets = false, limit = PAGE_SIZE } = {}) {
  const query = queryFor("requests", state, now, {});
  if (filters.q) {
    delete query.from;
    delete query.to;
  }
  for (const [name, value] of Object.entries(filters)) query[name] = value;
  query.limit = limit;
  if (facets) query.facets = 1;
  if (cursor) query.cursor = cursor;
  return query;
}

/** The extra parameters of the chart above the list: what GET /api/telemetry/timeseries accepts (04 §11). */
export function seriesFilters(filters) {
  const extra = {};
  for (const name of ["status_class", "error_class"]) if (filters[name]) extra[name] = filters[name];
  return extra;
}

/**
 * The server-side export link (04 §11.7): the window and the common filters,
 * plus the two list filters the export also accepts. `terminal_state`, `q` and
 * the thresholds are not export parameters, so the link says so (`partial`).
 * @returns {{ href: string, partial: boolean }}
 */
export function exportLink(state, filters, now) {
  const query = queryFor("requests", state, now, {});
  const params = new URLSearchParams({ kind: "requests", format: "csv" });
  for (const name of ["from", "to"]) if (query[name]) params.set(name, query[name]);
  for (const [name, value] of Object.entries(state.filters)) params.set(name, value);
  for (const [name, value] of Object.entries(seriesFilters(filters))) params.set(name, value);
  const partial = REQUEST_FILTER_IDS.some((name) => !["status_class", "error_class"].includes(name) && filters[name]);
  return { href: `/api/telemetry/export?${params.toString()}`, partial };
}

// ---------------------------------------------------------------------------
// Answers

function numberOrNull(value) {
  return finite(value) ?? (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
}

/** One request row with its numbers as numbers and its text as text; null when it has no request id. */
export function normalizeRequest(row) {
  if (!isObject(row) || typeof row.requestId !== "string" || !row.requestId) return null;
  const text = (value) => (typeof value === "string" ? value : "");
  return {
    ...row,
    requestId: row.requestId,
    receivedAt: text(row.receivedAt),
    status: numberOrNull(row.status),
    ttftMs: numberOrNull(row.ttftMs),
    durationMs: numberOrNull(row.durationMs),
    decodeTps: numberOrNull(row.decodeTps),
    promptTokens: numberOrNull(row.promptTokens),
    cachedTokens: numberOrNull(row.cachedTokens),
    outputTokens: numberOrNull(row.outputTokens),
    terminalState: text(row.terminalState),
    errorClass: text(row.errorClass),
    model: text(row.modelResolved) || text(row.modelRequested),
    stream: row.stream === true,
  };
}

/** The usable rows, the next cursor and the facets of a GET /api/telemetry/requests answer. */
export function requestsPage(answer) {
  const rows = list(answer?.rows).map(normalizeRequest).filter(Boolean);
  const cursor = typeof answer?.nextCursor === "string" && answer.nextCursor ? answer.nextCursor : null;
  return { rows, cursor, facets: isObject(answer?.facets) ? answer.facets : null, facetsTruncated: answer?.facetsTruncated === true };
}

/** `existing` followed by the rows of `more` that are not in it yet (a refresh can overlap a loaded page). */
export function appendRows(existing, more) {
  const seen = new Set(existing.map((row) => row.requestId));
  return [...existing, ...more.filter((row) => !seen.has(row.requestId))];
}

/**
 * The facet groups for the sidebar: values with counts, most frequent first,
 * each marked active when it is already in the filter.
 * @returns {Array<{ id, target, items: Array<{ value, count, active }> }>}
 */
export function facetGroups(facets, state, filters) {
  return FACETS.map((facet) => {
    const current = listValues(facet.target === "common" ? state.filters[facet.id] : filters[facet.id]);
    const counts = isObject(facets?.[facet.id]) ? facets[facet.id] : {};
    const items = Object.entries(counts)
      .map(([value, count]) => ({ value, count: finite(count) ?? 0, active: current.includes(value) }))
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
    // A selected value stays visible even when the filtered answer no longer counts it.
    for (const value of current) if (!items.some((item) => item.value === value)) items.push({ value, count: 0, active: true });
    return { id: facet.id, target: facet.target, items };
  });
}

/** The patch that toggles one facet value. */
export function facetToggle(facet, value, state, filters) {
  const current = facet.target === "common" ? state.filters[facet.id] : filters[facet.id];
  return filterPatch(facet.id, toggleListValue(current, value));
}

const OK_TERMINAL = new Set(["completed"]);
const WARN_TERMINAL = new Set(["client_abort", "rejected"]);

/** How a terminal state reads as a badge: completed is ok, cancelled and rejected warn, the rest is an error. */
export function terminalTone(state) {
  if (!state) return "unknown";
  if (OK_TERMINAL.has(state)) return "ok";
  if (WARN_TERMINAL.has(state)) return "warn";
  return "error";
}

/** The status class of an HTTP status ("2xx"), or "none" without one. */
export function statusClass(status) {
  const n = finite(status);
  return n === null || n < 100 ? "none" : `${Math.floor(n / 100)}xx`;
}

// ---------------------------------------------------------------------------
// Request detail

/** The marks 04 §11.6 names, and the part of the request each interval ends. */
export const MARK_ORDER = Object.freeze(["received", "dispatched", "headers", "first_token", "done"]);

function segmentKind(from, to) {
  if (to === "dispatched") return "queue";
  if (to === "headers") return "upstream";
  if (to === "first_token") return "prefill";
  if (to === "done") return from === "first_token" ? "decode" : "response";
  return "other";
}

/**
 * The waterfall of a request: marks with their offset from "received", and one
 * segment between each two neighbouring marks, positioned in percent of the
 * total. Marks without an offset or a time are left out; a request that never
 * reached `done` ends at its last mark.
 * @param detail the GET /api/telemetry/requests/:id answer
 * @returns {{ totalMs, marks: Array<{ mark, offsetMs }>, segments: Array<{ kind, from, to, startMs, endMs, durationMs, leftPct, widthPct }> }}
 */
export function waterfallModel(detail) {
  const request = isObject(detail?.request) ? detail.request : {};
  const receivedMs = Date.parse(request.receivedAt || "");
  const marks = [];
  for (const [index, item] of list(detail?.timeline).entries()) {
    if (!isObject(item) || typeof item.mark !== "string" || !item.mark) continue;
    let offset = finite(item.offsetMs);
    if (offset === null && item.mark === "received") offset = 0;
    if (offset === null && typeof item.at === "string" && Number.isFinite(receivedMs)) {
      const at = Date.parse(item.at);
      if (Number.isFinite(at)) offset = at - receivedMs;
    }
    if (offset === null || offset < 0) continue;
    marks.push({ mark: item.mark, offsetMs: offset, index });
  }
  marks.sort((a, b) => a.offsetMs - b.offsetMs || rank(a.mark) - rank(b.mark) || a.index - b.index);
  const last = marks.length ? marks[marks.length - 1].offsetMs : 0;
  const totalMs = Math.max(last, finite(request.durationMs) ?? 0);
  const segments = [];
  for (let at = 1; at < marks.length; at += 1) {
    const from = marks[at - 1];
    const to = marks[at];
    const durationMs = to.offsetMs - from.offsetMs;
    segments.push({
      kind: segmentKind(from.mark, to.mark),
      from: from.mark,
      to: to.mark,
      startMs: from.offsetMs,
      endMs: to.offsetMs,
      durationMs,
      leftPct: totalMs > 0 ? round((from.offsetMs / totalMs) * 100) : 0,
      widthPct: totalMs > 0 ? round((durationMs / totalMs) * 100) : 0,
    });
  }
  return { totalMs, marks: marks.map(({ mark, offsetMs }) => ({ mark, offsetMs })), segments };
}

function rank(mark) {
  const at = MARK_ORDER.indexOf(mark);
  return at < 0 ? MARK_ORDER.length : at;
}

const round = (value) => Math.round(value * 100) / 100;

/** A microcredit integer string as a decimal credit amount ("1834" gives "0.001834"); null when it is not an integer string. */
export function creditsText(value) {
  const text = typeof value === "number" && Number.isInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^-?\d{1,30}$/.test(text)) return null;
  const negative = text.startsWith("-");
  const big = BigInt(negative ? text.slice(1) : text);
  const whole = big / 1000000n;
  const fraction = String(big % 1000000n).padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** The decision, usage and reservation lines of a detail's billing block; null when the request has no billing record. */
export function billingView(billing) {
  if (!isObject(billing) || (!isObject(billing.usage) && !isObject(billing.reservation))) return null;
  const usage = isObject(billing.usage) ? billing.usage : null;
  const reservation = isObject(billing.reservation) ? billing.reservation : null;
  return {
    usage: usage && {
      usageId: String(usage.usageId ?? ""),
      charged: creditsText(usage.chargedMicrocredits),
      projected: creditsText(usage.projectedMicrocredits),
      usageSource: String(usage.usageSource ?? ""),
      terminalState: String(usage.terminalState ?? ""),
      decisionCode: String(usage.decisionCode ?? ""),
    },
    reservation: reservation && {
      enforcementMode: String(reservation.enforcementMode ?? ""),
      decisionCode: String(reservation.decisionCode ?? ""),
      reserved: creditsText(reservation.reservationMicrocredits),
    },
  };
}

/** The audit block of a detail: whether the request can be linked, whether the audit is unlocked, and the conversations it may belong to. */
export function auditLink(audit) {
  const block = isObject(audit) ? audit : {};
  const candidates = list(block.candidates)
    .filter((item) => isObject(item) && typeof item.chatId === "string" && item.chatId)
    .map((item) => ({ chatId: item.chatId, auditId: typeof item.auditId === "string" ? item.auditId : "", title: String(item.title ?? ""), offsetSeconds: finite(item.offsetSeconds) }));
  return { unlocked: block.unlocked === true, linkable: block.linkable === true, chatId: typeof block.chatId === "string" && block.chatId ? block.chatId : null, candidates };
}

/** `/audit/conversations?chat=…` for a conversation the request belongs to. */
export function conversationHref(chatId, auditId) {
  const params = new URLSearchParams({ chat: chatId });
  if (auditId) params.set("auditId", auditId);
  return `/audit/conversations?${params.toString()}`;
}

/** The deployment page of a fleet (07 §6.2), optionally on one of its tabs. */
export function deploymentHref(fleetId, tab) {
  return `/deployments/${encodeURIComponent(String(fleetId))}${tab ? `?tab=${tab}` : ""}`;
}
