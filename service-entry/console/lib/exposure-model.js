// Pure helpers of the Public access wizard and the Security page (07 §6.10,
// 05 §13.2, §13.5, §13.6): the wizard's steps and topologies, the public base
// URL check, the settings patches, the exposure map layout, the clients that
// still bypass the entry, and the numbers the Security page draws. No DOM and
// no requests, so node:test covers all of it (test/console/exposure-model.test.js).

import { displayStatus } from "./access-model.js";

export const WIZARD_STEPS = Object.freeze(["topology", "baseUrl", "templates", "keys", "checks", "map", "golive"]);

/** The three topology cards (05 §13.5 step 1); `templates` are the `GET /api/public/templates?topology=` values each can ask for. */
export const TOPOLOGIES = Object.freeze([
  Object.freeze({ id: "cloudflared", templates: Object.freeze(["cloudflared-token", "cloudflared-config"]), recommended: true, needsBaseUrl: true }),
  Object.freeze({ id: "caddy", templates: Object.freeze(["caddy"]), recommended: false, needsBaseUrl: true }),
  Object.freeze({ id: "lan", templates: Object.freeze(["lan"]), recommended: false, needsBaseUrl: false }),
]);

export const CLOUDFLARE_MODES = Object.freeze(["token", "config"]);
export const DIRECT_CALLER_DAYS = 7;
export const BAN_DURATIONS = Object.freeze([
  { id: "1h", seconds: 3600 },
  { id: "24h", seconds: 86_400 },
  { id: "7d", seconds: 604_800 },
  { id: "forever", seconds: null },
]);
export const BAN_KINDS = Object.freeze(["ip", "cidr", "key"]);

/** The `topology` value the templates API takes for a card and (Cloudflare) its mode. */
export function templateTopology(topologyId, mode = "token") {
  if (topologyId === "cloudflared") return mode === "config" ? "cloudflared-config" : "cloudflared-token";
  return TOPOLOGIES.some((item) => item.id === topologyId) ? topologyId : "lan";
}

/**
 * The public base URL as 05 wants it: https only, a host, no credentials, no
 * path, query or fragment. Returns { ok: true, value } with the origin, or
 * { ok: false, code } where `code` is a public.baseUrl.err.* suffix.
 */
export function parseBaseUrl(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, code: "required" };
  if (!/^https:\/\//i.test(raw)) return { ok: false, code: "not_https" };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "invalid" };
  }
  const host = url.hostname.toLowerCase();
  if (!host || url.username || url.password) return { ok: false, code: "invalid" };
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return { ok: false, code: "has_path" };
  if (host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]") return { ok: false, code: "not_public" };
  return { ok: true, value: url.origin };
}

/** The PATCH /api/public/settings body that saves the public base URL. */
export function baseUrlPatch(value) {
  return { section: "listeners", patch: { public: { baseUrl: value } } };
}

/** The two go-live patches, in the order they are sent (each needs the etag the one before returned). */
export function goLivePatches() {
  return [
    { section: "public", patch: { managersGatewayOnly: "enforce" } },
    { section: "admin", patch: { legacyProxyGateway: "reject" } },
  ];
}

/** The PATCH body that adds `<ip>/32` (or /128) to the trusted proxy CIDRs; null when it is already there or the address is not an IP. */
export function trustPatch(current, ip) {
  const address = String(ip ?? "").trim();
  const v4 = /^(\d{1,3})(\.\d{1,3}){3}$/.test(address) && address.split(".").every((part) => Number(part) <= 255);
  const v6 = !v4 && /^[0-9a-f:]+$/i.test(address) && address.includes(":");
  if (!v4 && !v6) return null;
  const cidr = `${address}/${v4 ? 32 : 128}`;
  const cidrs = Array.isArray(current) ? current.filter((item) => typeof item === "string") : [];
  if (cidrs.includes(cidr)) return null;
  return { section: "trustedProxies", patch: { cidrs: [...cidrs, cidr] }, cidr };
}

/** What the wizard reads from GET /api/public/settings. */
export function readSettings(payload) {
  const config = payload?.config || {};
  return {
    etag: typeof payload?.etag === "string" ? payload.etag : "",
    baseUrl: String(config.listeners?.public?.baseUrl || ""),
    gatewayOnly: String(config.public?.managersGatewayOnly || "warn"),
    legacyGateway: String(config.admin?.legacyProxyGateway || "serve"),
    cidrs: Array.isArray(config.trustedProxies?.cidrs) ? config.trustedProxies.cidrs : [],
  };
}

export function isLive(settings) {
  return settings.gatewayOnly === "enforce" && settings.legacyGateway === "reject";
}

// ---- checks -----------------------------------------------------------------

const STATE_RANK = Object.freeze({ ok: 0, manual: 0, unknown: 1, warn: 2, fail: 3 });
const BADGE = Object.freeze({ ok: "ok", warn: "warn", fail: "error", unknown: "unknown", manual: "neutral" });

/** The StatusBadge status of a check or edge state. */
export function badgeFor(state) {
  return BADGE[state] || "unknown";
}

export function worseState(a, b) {
  return (STATE_RANK[b] ?? 1) > (STATE_RANK[a] ?? 1) ? b : a;
}

export function summarizeChecks(checks) {
  const summary = { ok: 0, warn: 0, fail: 0, unknown: 0, manual: 0 };
  for (const check of Array.isArray(checks) ? checks : []) summary[Object.hasOwn(summary, check?.state) ? check.state : "unknown"] += 1;
  return summary;
}

/** A key that can serve the public listener right now (05 §13.5 step 4). */
export function publicKeys(keys, now = Date.now()) {
  return (Array.isArray(keys) ? keys : []).filter((key) => displayStatus(key, now) === "active"
    && Array.isArray(key.listeners) && key.listeners.includes("public"));
}

/**
 * What each wizard step has achieved so far: "done", "error" (checks failing),
 * "skipped" (a LAN-only setup has no public address) or "open".
 */
export function stepOutcomes({ topology, settings, written = false, publicKeyCount = 0, report = null, mapSeen = false }) {
  const lan = topology === "lan";
  const failing = report ? summarizeChecks(report.checks).fail > 0 : false;
  return {
    topology: "done",
    baseUrl: lan ? "skipped" : settings?.baseUrl ? "done" : "open",
    templates: lan || written ? "done" : "open",
    keys: publicKeyCount > 0 ? "done" : "open",
    checks: !report ? "open" : failing ? "error" : "done",
    map: mapSeen ? "done" : "open",
    golive: settings && isLive(settings) ? "done" : "open",
  };
}

/** The Stepper state of every step: the current one is active; an open step before it was skipped, one after it is pending. */
export function stepperStates(current, outcomes) {
  const at = WIZARD_STEPS.indexOf(current);
  return WIZARD_STEPS.map((id, index) => {
    if (id === current) return { id, state: "active" };
    const outcome = outcomes[id] || "open";
    if (outcome === "done") return { id, state: "done" };
    if (outcome === "error") return { id, state: "error" };
    if (outcome === "skipped") return { id, state: "skipped" };
    return { id, state: index < at ? "skipped" : "pending" };
  });
}

// ---- exposure map -----------------------------------------------------------

export const MAP_WIDTH = 800;
export const MAP_HEIGHT = 430;
const NODE_W = 140;
const NODE_H = 46;
// Where 05's eight nodes sit (Internet and LAN on the left, engines at the back); a node the scanner adds later goes to an extra row.
const POSITIONS = Object.freeze({
  internet: [80, 70],
  lan: [80, 215],
  loopback: [80, 360],
  edge: [290, 70],
  public: [500, 70],
  admin: [500, 290],
  managers: [715, 150],
  engines: [715, 340],
});

/** The point where the line from the centre of `a` towards `b` leaves a's box. */
function clip(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!dx && !dy) return { x: a.x, y: a.y };
  const scale = Math.min(dx ? (NODE_W / 2) / Math.abs(dx) : Infinity, dy ? (NODE_H / 2) / Math.abs(dy) : Infinity);
  return { x: a.x + dx * scale, y: a.y + dy * scale };
}

/**
 * `report.map` ({ nodes, edges }) → drawable geometry. Edges naming a missing
 * node are dropped; a node is as bad as its worst edge.
 * @returns {{ width, height, nodes: [{ id, label, kind, x, y, w, h, state }], edges: [{ id, from, to, state, evidence, x1, y1, x2, y2, mx, my }] }}
 */
export function mapLayout(map) {
  const rawNodes = Array.isArray(map?.nodes) ? map.nodes.filter((node) => node && typeof node.id === "string") : [];
  let extra = 0;
  const nodes = rawNodes.map((node) => {
    const spot = POSITIONS[node.id] || [80 + (extra++ % 6) * 125, MAP_HEIGHT - 20];
    return { id: node.id, label: String(node.label || node.id), kind: String(node.kind || ""), x: spot[0], y: spot[1], w: NODE_W, h: NODE_H, state: "ok" };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = [];
  for (const raw of Array.isArray(map?.edges) ? map.edges : []) {
    const from = byId.get(raw?.from);
    const to = byId.get(raw?.to);
    if (!from || !to) continue;
    const state = Object.hasOwn(STATE_RANK, raw.state) ? raw.state : "unknown";
    const start = clip(from, to);
    const end = clip(to, from);
    edges.push({
      id: `${from.id}-${to.id}`,
      from: from.id,
      to: to.id,
      state,
      evidence: String(raw.evidence || ""),
      x1: Math.round(start.x),
      y1: Math.round(start.y),
      x2: Math.round(end.x),
      y2: Math.round(end.y),
      mx: Math.round((start.x + end.x) / 2),
      my: Math.round((start.y + end.y) / 2),
    });
    from.state = worseState(from.state, state);
    to.state = worseState(to.state, state);
  }
  return { width: MAP_WIDTH, height: nodes.some((node) => node.y > MAP_HEIGHT - 40) ? MAP_HEIGHT + 40 : MAP_HEIGHT, nodes, edges };
}

// ---- who bypasses the entry ---------------------------------------------------

function eventTime(event) {
  const at = Date.parse(event?.at ?? event?.ts ?? "");
  return Number.isFinite(at) ? at : null;
}

function eventData(event) {
  const data = event?.data ?? event?.payload;
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

/**
 * Groups the `security.direct_manager_gateway` events (managers called
 * without the entry) and `security.admin_via_proxy` events (ADMIN reached
 * through a proxy) of the last `days` days. An event stands for itself plus
 * the calls its throttle suppressed (`data.suppressed`).
 * @returns {{ direct: [{ id, address, kind, path, count, lastAt }], viaProxy: [{ id, pathClass, outcome, headers, count, lastAt }], total }}
 */
export function groupCallers({ direct = [], viaProxy = [] } = {}, { now = Date.now(), days = DIRECT_CALLER_DAYS } = {}) {
  const since = now - days * 86_400_000;
  const directRows = new Map();
  const proxyRows = new Map();
  const bump = (map, id, row, count, at) => {
    const found = map.get(id) || { id, ...row, count: 0, lastAt: 0 };
    found.count += count;
    found.lastAt = Math.max(found.lastAt, at);
    map.set(id, found);
  };
  for (const event of Array.isArray(direct) ? direct : []) {
    const at = eventTime(event);
    if (at === null || at < since) continue;
    const data = eventData(event);
    const address = String(data.remoteAddress || "");
    const kind = String(data.kind || "");
    const path = String(data.path || "");
    bump(directRows, `${address}|${kind}|${path}`, { address, kind, path }, 1 + (Number(data.suppressed) > 0 ? Number(data.suppressed) : 0), at);
  }
  for (const event of Array.isArray(viaProxy) ? viaProxy : []) {
    const at = eventTime(event);
    if (at === null || at < since) continue;
    const data = eventData(event);
    const pathClass = String(data.pathClass || "");
    const outcome = String(data.outcome || "");
    const headers = Array.isArray(data.headers) ? data.headers.map(String) : [];
    bump(proxyRows, `${pathClass}|${outcome}`, { pathClass, outcome, headers }, 1, at);
  }
  const rank = (a, b) => b.count - a.count || b.lastAt - a.lastAt;
  const directList = [...directRows.values()].sort(rank);
  const proxyList = [...proxyRows.values()].sort(rank);
  return { direct: directList, viaProxy: proxyList, total: directList.length + proxyList.length };
}

/** Reads every page of `GET /api/security/events?type=` (at most `maxPages`) with `get(path, { query })`. */
export async function fetchSecurityEvents(get, type, { maxPages = 5, limit = 200 } = {}) {
  const items = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const answer = await get("/api/security/events", { query: { type, limit, ...(cursor ? { cursor } : {}) } });
    items.push(...(Array.isArray(answer?.items) ? answer.items : []));
    cursor = answer?.nextCursor || null;
    if (!cursor) break;
  }
  return items;
}

// ---- security page ----------------------------------------------------------------

/** `[[ms, count], …]` (or `[{ t, count }]`; seconds are accepted) → one x axis in epoch seconds and one series. */
export function authSeries(series) {
  const rows = (Array.isArray(series) ? series : []).map((point) => {
    const time = Array.isArray(point) ? Number(point[0]) : Number(point?.t ?? point?.at);
    const value = Array.isArray(point) ? Number(point[1]) : Number(point?.count ?? point?.value);
    return Number.isFinite(time) && Number.isFinite(value) ? [time > 1e11 ? Math.floor(time / 1000) : Math.floor(time), value] : null;
  }).filter(Boolean).sort((a, b) => a[0] - b[0]);
  return { x: rows.map((row) => row[0]), values: rows.map((row) => row[1]), total: rows.reduce((sum, row) => sum + row[1], 0) };
}

/** The expiry a ban duration id stands for, as an ISO date, or undefined for "forever". */
export function banExpiry(durationId, now = Date.now()) {
  const found = BAN_DURATIONS.find((item) => item.id === durationId);
  return found && found.seconds ? new Date(now + found.seconds * 1000).toISOString() : undefined;
}

/** The POST /api/security/bans body for the ban form. */
export function banBody({ subject, kind, reason, duration }, now = Date.now()) {
  const expiresAt = banExpiry(duration, now);
  const text = String(reason ?? "").trim();
  return { subject: String(subject ?? "").trim(), kind, ...(text ? { reason: text } : {}), ...(expiresAt ? { expiresAt } : {}) };
}

/** A problem code (`required`, `invalid`) for a ban subject, or null; a light check, the server decides. */
export function banSubjectProblem(subject, kind) {
  const text = String(subject ?? "").trim();
  if (!text) return "required";
  if (kind === "key") return /^[\w.:-]{3,128}$/.test(text) ? null : "invalid";
  const [address, prefix, extra] = text.split("/");
  if (extra !== undefined || (kind === "ip" && prefix !== undefined) || (kind === "cidr" && prefix === undefined)) return "invalid";
  const v4 = /^(\d{1,3})(\.\d{1,3}){3}$/.test(address) && address.split(".").every((part) => Number(part) <= 255);
  const v6 = !v4 && /^[0-9a-f:.]+$/i.test(address) && address.includes(":");
  if (!v4 && !v6) return "invalid";
  if (prefix !== undefined && !(/^\d{1,3}$/.test(prefix) && Number(prefix) <= (v4 ? 32 : 128))) return "invalid";
  return null;
}

/** The placeholders of a `security.rule.<rule>.detail` line for one anomaly of `GET /api/security/overview`. */
export function anomalyVars(item, fmt = { integer: String }) {
  const detail = item?.detail && typeof item.detail === "object" ? item.detail : {};
  const count = (value) => (Number.isFinite(Number(value)) ? fmt.integer(Number(value)) : "-");
  return {
    name: item?.name || item?.keyId || "",
    tokens: count(detail.lastHourTokens),
    p95: count(detail.hourlyP95),
    factor: detail.factor ?? "-",
    country: detail.country || "",
    failures: count(detail.failures),
    minutes: count(detail.windowMinutes ?? 10),
    calls: count(detail.calls24h),
  };
}

const SEVERITY_BADGE = Object.freeze({ critical: "error", warning: "warn", info: "info" });

/** The StatusBadge status of an anomaly or event severity. */
export function severityBadge(severity) {
  return SEVERITY_BADGE[severity] || "neutral";
}
