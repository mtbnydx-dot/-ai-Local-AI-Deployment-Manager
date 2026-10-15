// /system/doctor model (06 §7, §11; 07 §6.13): the pure parts of the page.
//
// GET /api/platform/doctor answers {schemaVersion, at, durationMs, summary,
// checks[]}; a check is {id, group, status, title, detail, data, durationMs,
// fix: {id, risk, label, command, docs} | null}. Before the platform backend
// is mounted the page reads each manager's GET /api/tools/health instead
// ({score, ok, checks: [{id, label, status, detail, actions, actionDetails}]}).
// Nothing here touches the DOM, the cache or the network.

export const DOCTOR_GROUPS = Object.freeze(["env", "runtime", "storage", "network", "security", "ops"]);
export const STATUSES = Object.freeze(["fail", "warn", "ok", "info", "skip"]);
export const FIX_RISKS = Object.freeze(["auto", "confirm", "manual"]);

const STATUS_TONE = Object.freeze({ ok: "ok", warn: "warn", fail: "error", info: "info", skip: "neutral" });
// A check id's first segment names its group (06 §7.2), except these two.
const ID_GROUP = Object.freeze({ net: "network", sec: "security" });
// 08 P0-23: the one request a legacy health check may ask the console to send.
const LEGACY_API_ALLOWLIST = new Set(["POST /api/docker/start"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finite(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
}

/** The StatusBadge tone of a check status; a status the console does not know is `unknown`. */
export function statusTone(status) {
  return Object.hasOwn(STATUS_TONE, status) ? STATUS_TONE[status] : "unknown";
}

/** A status the catalog has a label for; anything else reads as `info`. */
export function knownStatus(status) {
  return STATUSES.includes(status) ? status : "info";
}

function groupOf(check) {
  const named = text(check.group);
  if (named) return named;
  const head = text(check.id).split(".")[0];
  return ID_GROUP[head] || head || "env";
}

/** A fix that is not exactly auto or confirm is manual: the console never runs what it does not understand. */
export function fixRisk(risk) {
  return FIX_RISKS.includes(risk) ? risk : "manual";
}

function normalizeFix(raw, pick) {
  if (!isPlainObject(raw) || !text(raw.id)) return null;
  const label = isPlainObject(raw.label) ? text(pick(raw.label)) : text(raw.label);
  return { id: text(raw.id), risk: fixRisk(raw.risk), label, command: text(raw.command) || null, docs: text(raw.docs) || null };
}

/** One check of the doctor report as a row. `pick` chooses the language of a {zh,en} text. */
export function normalizeCheck(raw, pick = (value) => value) {
  const check = isPlainObject(raw) ? raw : {};
  const id = text(check.id);
  const title = isPlainObject(check.title) ? text(pick(check.title)) : text(check.title);
  return {
    id,
    group: groupOf({ ...check, id }),
    status: knownStatus(check.status),
    title: title || id,
    detail: typeof check.detail === "string" ? check.detail : "",
    durationMs: finite(check.durationMs),
    data: isPlainObject(check.data) ? check.data : {},
    fix: normalizeFix(check.fix, pick),
  };
}

/** The report's checks, normalised, failing ones first inside each group. */
export function normalizeReport(raw, pick) {
  const report = isPlainObject(raw) ? raw : {};
  const checks = (Array.isArray(report.checks) ? report.checks : []).filter(isPlainObject).map((item) => normalizeCheck(item, pick));
  return {
    at: text(report.at) || null,
    durationMs: finite(report.durationMs),
    checks,
    summary: summarize(checks),
  };
}

/** {fail, warn, ok, info, skip} counts of a list of checks. */
export function summarize(checks) {
  const out = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const check of checks) out[knownStatus(check.status)] += 1;
  return out;
}

/** Checks grouped by category in the catalogue's order (06 §7.2); a group the console does not know follows them. */
export function groupChecks(checks) {
  const order = (status) => STATUSES.indexOf(status);
  const byGroup = new Map();
  for (const check of checks) {
    if (!byGroup.has(check.group)) byGroup.set(check.group, []);
    byGroup.get(check.group).push(check);
  }
  const known = DOCTOR_GROUPS.filter((id) => byGroup.has(id));
  const extra = [...byGroup.keys()].filter((id) => !DOCTOR_GROUPS.includes(id)).sort();
  return [...known, ...extra].map((id) => ({
    id,
    // Array.prototype.sort is stable: equal statuses keep the catalogue's order.
    checks: byGroup.get(id).slice().sort((a, b) => order(a.status) - order(b.status)),
  }));
}

/** What a fix needs before it may run: nothing (auto), a confirmation (confirm) or never (manual). */
export function fixRequest(check, confirmed = false) {
  const fix = check?.fix;
  if (!fix || fix.risk === "manual") return null;
  if (fix.risk === "confirm" && !confirmed) return null;
  return { path: "/api/platform/doctor/fix", body: { checkId: check.id, fixId: fix.id, ...(fix.risk === "confirm" ? { confirm: true } : {}) } };
}

// ---------------------------------------------------------------------------
// The pre-platform doctor: a manager's GET /api/tools/health

const LEGACY_TONE = Object.freeze({ ok: "ok", warn: "warn", fail: "error", error: "error" });

function legacyAction(raw) {
  if (!isPlainObject(raw) || !text(raw.id)) return null;
  const label = raw.label;
  if (raw.kind === "command" && text(raw.command)) return { id: text(raw.id), kind: "command", command: text(raw.command), label };
  if (raw.kind === "api") {
    const method = text(raw.method).toUpperCase();
    const path = text(raw.path);
    // Only the allowlisted request is ever offered as a button (08 P0-23); the call goes through /api/m/:id.
    if (LEGACY_API_ALLOWLIST.has(`${method} ${path}`)) return { id: text(raw.id), kind: "api", method, path: path.replace(/^\/api/, ""), label };
  }
  return null;
}

/** A manager's tools/health report as rows: {id, label, tone, status, detail, actions}. */
export function legacyChecks(raw, pick = (value) => value) {
  const checks = Array.isArray(raw?.checks) ? raw.checks : [];
  return checks.filter(isPlainObject).map((item) => {
    const label = isPlainObject(item.label) ? text(pick(item.label)) : text(item.label);
    const status = text(item.status);
    return {
      id: text(item.id),
      label: label || text(item.id),
      status: Object.hasOwn(LEGACY_TONE, status) ? status : "warn",
      tone: LEGACY_TONE[status] || "unknown",
      detail: typeof item.detail === "string" ? item.detail : "",
      actions: (Array.isArray(item.actionDetails) ? item.actionDetails : []).map(legacyAction).filter(Boolean).map((action) => ({
        ...action,
        label: isPlainObject(action.label) ? text(pick(action.label)) : text(action.label),
      })),
    };
  });
}
