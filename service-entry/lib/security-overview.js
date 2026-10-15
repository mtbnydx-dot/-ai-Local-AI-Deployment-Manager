"use strict";
// The data behind GET /api/security/overview and /api/security/events
// (05 §13.3, PUB-19): auth failures, bans, top keys, anomalies and the admin
// trail for the console's "Security & audit" page.
//
// Sources, best first, and each answer says which one it used:
//   - the telemetry query layer (04), injected as `telemetry` once TEL-11
//     lands: auth failures over time and by IP, per-key hourly tokens, the
//     countries a key was seen from, `security.*` events. Every method is
//     optional; a missing or failing one leaves that part empty and marks it
//     unavailable, never an error.
//   - the access store: active bans, the admin audit trail and, as the
//     fallback of "top keys", the per-key daily counters.
//   - the in-process event ring (events.js): `security.*` events since this
//     process started, which is also where the `admin_via_proxy` and
//     `direct_manager_gateway` counts of the exposure scan come from.
//
// The anomaly rules (detectAnomalies) are pure and deliberately simple:
//   tpm_spike           a key's tokens in the last hour exceed 5 x its 7-day
//                       hourly p95, and at least 50k;
//   new_country         a country not seen for the key in 30 days;
//   auth_storm          more than 100 401s in 10 minutes across IPs;
//   direct_manager_calls  unsigned direct manager calls in `warn` mode.

const { KeysStoreError } = require("./keys-store");

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 90;
const TPM_SPIKE_FACTOR = 5;
const TPM_SPIKE_MIN_TOKENS = 50_000;
const NEW_COUNTRY_DAYS = 30;
const AUTH_STORM_LIMIT = 100;
const TOP_KEYS = 10;
const TOP_IPS = 20;
const ADMIN_EVENTS = 50;

// A bad query parameter; access-routes answers it like any key store field error.
class SecurityQueryError extends KeysStoreError {
  constructor(field, message) {
    super("invalid_field", message, 400, [{ field, code: "invalid", message }]);
    this.name = "SecurityQueryError";
  }
}

function isoOrNull(value) {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : null;
}

/** parseRange({ from, to }, nowMs) -> { fromMs, toMs, from, to }. Defaults to the last 24 hours. */
function parseRange(query = {}, nowMs = Date.now()) {
  const toMs = query.to ? isoOrNull(query.to) : nowMs;
  const fromMs = query.from ? isoOrNull(query.from) : toMs === null ? null : toMs - DAY_MS;
  if (query.to && toMs === null) throw new SecurityQueryError("to", "to must be an ISO date.");
  if (query.from && fromMs === null) throw new SecurityQueryError("from", "from must be an ISO date.");
  if (fromMs >= toMs) throw new SecurityQueryError("from", "from must be before to.");
  if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) throw new SecurityQueryError("from", `The range is at most ${MAX_RANGE_DAYS} days.`);
  return { fromMs, toMs, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

/**
 * detectAnomalies({ nowMs, keyHourly, newCountries, authFailures10m, directManagerCalls, names })
 *   keyHourly:   [{ keyId, lastHourTokens, hourlyP95 }]
 *   newCountries:[{ keyId, country, lastSeenBefore }]  countries seen in the last hour (lastSeenBefore: ms or null)
 * -> [{ rule, severity, keyId?, detail }], most severe first.
 */
function detectAnomalies({ nowMs = Date.now(), keyHourly = [], newCountries = [], authFailures10m = null, directManagerCalls = null, names = {} } = {}) {
  const out = [];
  for (const row of Array.isArray(keyHourly) ? keyHourly : []) {
    const tokens = Number(row?.lastHourTokens);
    const p95 = Number(row?.hourlyP95) || 0;
    if (!row?.keyId || !Number.isFinite(tokens)) continue;
    if (tokens >= TPM_SPIKE_MIN_TOKENS && tokens > TPM_SPIKE_FACTOR * p95) {
      out.push({
        rule: "tpm_spike",
        severity: "warning",
        keyId: row.keyId,
        name: names[row.keyId] || null,
        detail: { lastHourTokens: tokens, hourlyP95: p95, factor: p95 > 0 ? Math.round((tokens / p95) * 10) / 10 : null },
      });
    }
  }
  for (const row of Array.isArray(newCountries) ? newCountries : []) {
    if (!row?.keyId || !/^[A-Z]{2}$/.test(String(row.country || ""))) continue;
    const before = Number(row.lastSeenBefore);
    if (Number.isFinite(before) && nowMs - before < NEW_COUNTRY_DAYS * DAY_MS) continue;
    out.push({
      rule: "new_country",
      severity: "warning",
      keyId: row.keyId,
      name: names[row.keyId] || null,
      detail: { country: row.country, lastSeenBefore: Number.isFinite(before) ? new Date(before).toISOString() : null },
    });
  }
  if (Number.isFinite(authFailures10m) && authFailures10m > AUTH_STORM_LIMIT) {
    out.push({ rule: "auth_storm", severity: "critical", detail: { failures: authFailures10m, windowMinutes: 10 } });
  }
  if (Number.isFinite(directManagerCalls) && directManagerCalls > 0) {
    out.push({ rule: "direct_manager_calls", severity: "warning", detail: { calls24h: directManagerCalls } });
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule));
}

function guard(fn) {
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ ok: true, value }), () => ({ ok: false, value: null }));
}

// `security.*` events of the in-process ring, newest first.
function ringEvents(bus, { type, limit = 100, sinceMs = 0 } = {}) {
  if (!bus || typeof bus.recent !== "function") return [];
  let recent;
  try {
    recent = bus.recent({ types: "security", limit: 500 });
  } catch {
    return [];
  }
  const items = [];
  for (const event of Array.isArray(recent?.events) ? recent.events : []) {
    const kind = String(event?.data?.kind || "event");
    const name = `security.${kind}`;
    const at = Date.parse(event?.at || "");
    if (type && name !== type) continue;
    if (sinceMs && !(at >= sinceMs)) continue;
    items.push({ id: event.id, at: event.at, type: name, severity: event.data?.severity || "info", source: "ring", data: event.data || {} });
  }
  return items.reverse().slice(0, limit);
}

/** Counts `security.<kind>` events in the in-process ring over the last `windowMs`; null without a bus. */
function countRingEvents(bus, kind, windowMs, nowMs = Date.now()) {
  if (!bus || typeof bus.recent !== "function") return null;
  return ringEvents(bus, { type: `security.${kind}`, limit: 500, sinceMs: nowMs - windowMs }).length;
}

/**
 * createSecurityOverview({ getStore, getBus, getConfig, telemetry, now })
 *   -> { overview(query), events(query), signals() }
 * getStore() returns the access store or throws; telemetry is the optional
 * provider described in the header.
 */
function createSecurityOverview(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const getBus = typeof options.getBus === "function" ? options.getBus : () => null;
  const getConfig = typeof options.getConfig === "function" ? options.getConfig : () => ({});
  const getTelemetry = typeof options.telemetry === "function" ? options.telemetry : () => options.telemetry || null;

  function store() {
    return options.getStore();
  }

  function allKeys(target) {
    const items = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const result = target.listKeys({ limit: 200, ...(cursor ? { cursor } : {}) });
      items.push(...result.items);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return items;
  }

  // Top keys from the daily counters when telemetry cannot answer.
  function topKeysFromCounters(target, range) {
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const rows = [];
    for (const key of allKeys(target)) {
      let requests = 0;
      let tokens = 0;
      for (const usage of target.listDailyUsage(key.id, { from: day(range.fromMs), to: day(range.toMs) })) {
        requests += usage.requests;
        tokens += usage.inputTokens + usage.outputTokens;
      }
      if (requests || tokens) rows.push({ keyId: key.id, name: key.name, requests, tokens });
    }
    return rows.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests).slice(0, TOP_KEYS);
  }

  async function overview(query = {}) {
    const nowMs = now();
    const range = parseRange(query, nowMs);
    const target = store();
    const provider = getTelemetry();
    const sources = {};

    const failures = provider?.authFailures ? await guard(() => provider.authFailures({ fromMs: range.fromMs, toMs: range.toMs })) : { ok: false, value: null };
    sources.authFailures = failures.ok && failures.value ? "telemetry" : "unavailable";
    const series = failures.ok && Array.isArray(failures.value?.series) ? failures.value.series : [];
    const topIps = (failures.ok && Array.isArray(failures.value?.topIps) ? failures.value.topIps : []).slice(0, TOP_IPS).map((row) => ({
      ip: String(row.ip),
      country: row.country || "",
      count: Number(row.count) || 0,
      banned: Boolean(safe(() => target.activeBanFor(String(row.ip), nowMs))),
    }));

    const keys = allKeys(target);
    const names = Object.fromEntries(keys.map((key) => [key.id, key.name]));
    const traffic = provider?.keyTraffic ? await guard(() => provider.keyTraffic({ fromMs: range.fromMs, toMs: range.toMs })) : { ok: false, value: null };
    let topKeys;
    if (traffic.ok && Array.isArray(traffic.value)) {
      sources.topKeys = "telemetry";
      topKeys = traffic.value.map((row) => ({ keyId: row.keyId, name: names[row.keyId] || row.name || null, requests: Number(row.requests) || 0, tokens: Number(row.tokens) || 0 })).slice(0, TOP_KEYS);
    } else {
      sources.topKeys = "counters";
      topKeys = topKeysFromCounters(target, range);
    }

    const [hourly, countries, storm, direct] = await Promise.all([
      provider?.keyHourlyTokens ? guard(() => provider.keyHourlyTokens({ nowMs })) : { ok: false },
      provider?.newCountries ? guard(() => provider.newCountries({ nowMs })) : { ok: false },
      provider?.authFailures10m ? guard(() => provider.authFailures10m({ nowMs })) : { ok: false },
      provider?.directManagerCalls ? guard(() => provider.directManagerCalls({ nowMs })) : { ok: false },
    ]);
    const mode = getConfig()?.public?.managersGatewayOnly || "warn";
    const directCalls = mode === "warn" ? (direct.ok && Number.isFinite(direct.value) ? direct.value : countRingEvents(getBus(), "direct_manager_gateway", DAY_MS, nowMs)) : null;
    const anomalies = detectAnomalies({
      nowMs,
      keyHourly: hourly.ok ? hourly.value : [],
      newCountries: countries.ok ? countries.value : [],
      authFailures10m: storm.ok ? storm.value : null,
      directManagerCalls: directCalls,
      names,
    });
    sources.anomalies = [hourly, countries, storm, direct].some((item) => item.ok) ? "telemetry" : directCalls === null ? "unavailable" : "ring";

    const adminEvents = target.listAudit({ limit: 200 }).items
      .filter((item) => {
        const at = Date.parse(item.at);
        return at >= range.fromMs && at <= range.toMs;
      })
      .slice(0, ADMIN_EVENTS);

    return {
      ok: true,
      from: range.from,
      to: range.to,
      authFailures: { available: sources.authFailures === "telemetry", series, topIps },
      bans: target.listBans({}),
      topKeys,
      anomalies,
      adminEvents,
      sources,
    };
  }

  /** events({ type, cursor, limit }) -> { ok, items, nextCursor, source } */
  async function events(query = {}) {
    const limit = Number.isInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, 200) : 100;
    let type = query.type ? String(query.type).trim() : "";
    if (type && !type.startsWith("security.")) type = `security.${type}`;
    if (type && !/^security\.[a-z][a-z0-9_]{0,63}$/.test(type)) throw new SecurityQueryError("type", "type must be a security.* event type.");
    const provider = getTelemetry();
    if (provider?.events) {
      const found = await guard(() => provider.events({ type: type || null, cursor: query.cursor || null, limit }));
      if (found.ok && found.value) {
        return { ok: true, items: Array.isArray(found.value.items) ? found.value.items : [], nextCursor: found.value.nextCursor || null, source: "telemetry" };
      }
    }
    return { ok: true, items: ringEvents(getBus(), { type, limit }), nextCursor: null, source: "ring" };
  }

  /** The facts the exposure scan cannot read from the OS: keys and 24 h event counts. */
  async function signals() {
    const nowMs = now();
    const bus = getBus();
    const provider = getTelemetry();
    const out = {};
    try {
      out.keys = allKeys(store());
    } catch {
      out.keys = null;
    }
    const direct = provider?.directManagerCalls ? await guard(() => provider.directManagerCalls({ nowMs })) : { ok: false };
    out.directManagerCalls24h = direct.ok && Number.isFinite(direct.value) ? direct.value : countRingEvents(bus, "direct_manager_gateway", DAY_MS, nowMs);
    const proxied = provider?.adminViaProxy ? await guard(() => provider.adminViaProxy({ nowMs })) : { ok: false };
    out.adminViaProxy24h = proxied.ok && Number.isFinite(proxied.value) ? proxied.value : countRingEvents(bus, "admin_via_proxy", DAY_MS, nowMs);
    return out;
  }

  return { overview, events, signals };
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

module.exports = {
  AUTH_STORM_LIMIT,
  SecurityQueryError,
  TPM_SPIKE_FACTOR,
  TPM_SPIKE_MIN_TOKENS,
  countRingEvents,
  createSecurityOverview,
  detectAnomalies,
  parseRange,
  ringEvents,
};
