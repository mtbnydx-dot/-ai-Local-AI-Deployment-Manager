// The pure part of the Audit pages (07 §6.8, 04 §16): the URL state of the
// conversation search, the parameters of the audit endpoints, the shaping of
// the export chains, the access log and the conversation thread, and the
// settings draft. Nothing here touches the DOM or the clock; `now` and the
// search string are always passed in, so the tests run in Node.

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === "string" ? value : "");

/** The Audit sub-pages in header order; `locked` pages need the audit unlock. */
export const AUDIT_PAGES = Object.freeze([
  Object.freeze({ id: "timeline", path: "/audit" }),
  Object.freeze({ id: "conversations", path: "/audit/conversations", locked: true }),
  Object.freeze({ id: "exports", path: "/audit/exports" }),
  Object.freeze({ id: "access-log", path: "/audit/access-log", locked: true }),
  Object.freeze({ id: "settings", path: "/audit/settings" }),
]);

export const AUDIT_ENDPOINT = "/api/audit";
/** Event types of the timeline (04 §11.7): prefixes. */
export const TIMELINE_PREFIXES = Object.freeze(["launch.", "alert.", "access.", "security."]);
export const TIMELINE_PAGE = 100;
export const CHAT_PAGE = 50;
export const LOG_PAGE = 100;
export const SEARCH_MAX = 200;

/** The path of an audit endpoint (the entry's, 04 §16.5). */
export const auditPath = (rest) => `${AUDIT_ENDPOINT}/${rest}`;

/** True for the error that means "unlock the audit first" (the second factor is missing or ran out). */
export function isLockedError(error) {
  return error?.status === 401 && (error?.code === "audit_session_required" || error?.code === "audit_session_expired");
}

// ---------------------------------------------------------------------------
// Timeline

/** Which family a timeline event belongs to: launch, alert, access or security. */
export function eventFamily(type) {
  const head = String(type || "").split(".")[0];
  return TIMELINE_PREFIXES.some((prefix) => prefix === `${head}.`) ? head : "other";
}

/** The `type` parameter for the chosen families (all four when none is chosen). */
export function timelineTypes(families) {
  const chosen = list(families).filter((family) => TIMELINE_PREFIXES.includes(`${family}.`));
  return (chosen.length ? chosen.map((family) => `${family}.`) : TIMELINE_PREFIXES).join(",");
}

const SEVERITY_TONE = Object.freeze({ info: "info", warning: "warn", warn: "warn", critical: "error", error: "error" });

/** One timeline row; null when it has no usable time. */
export function timelineRow(row) {
  if (!isObject(row) || typeof row.at !== "string" || Number.isNaN(Date.parse(row.at))) return null;
  return {
    id: row.id ?? `${row.at}:${row.type}`,
    at: row.at,
    type: text(row.type),
    family: eventFamily(row.type),
    severity: text(row.severity),
    tone: SEVERITY_TONE[row.severity] || "neutral",
    source: text(row.source),
    title: row.title,
    fleetId: text(row.fleetId),
    requestId: text(row.requestId),
  };
}

export function timelineRows(answer) {
  return list(answer?.rows).map(timelineRow).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Conversations: URL state and parameters

export const CHAT_FILTERS = Object.freeze(["q", "user", "model", "archived", "from", "to"]);
const ARCHIVED = Object.freeze(["yes", "no"]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The conversation search of a URL: `q user model archived from to` plus the open thread (`chat`, `auditId`). */
export function parseChatSearch(search) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const filters = {};
  for (const name of ["q", "user", "model"]) {
    const value = (params.get(name) || "").trim().slice(0, SEARCH_MAX);
    if (value) filters[name] = value;
  }
  const archived = params.get("archived");
  if (ARCHIVED.includes(archived)) filters.archived = archived;
  for (const name of ["from", "to"]) {
    const value = (params.get(name) || "").trim();
    if (DAY_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) filters[name] = value;
  }
  const chat = (params.get("chat") || "").trim().slice(0, 200);
  const auditId = (params.get("auditId") || "").trim().slice(0, 200);
  return { filters, chat: chat || null, auditId: chat ? auditId || null : null };
}

/** `search` with the given parameters set (null removes one); every other parameter stays. */
export function patchChatSearch(search, patch) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  for (const [name, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") params.delete(name);
    else params.set(name, String(value));
  }
  const out = params.toString();
  return out ? `?${out}` : "";
}

const dayStart = (day) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, 0, 0, 0, 0);
};

/** The query of GET /api/audit/chats for the filters: day inputs become ISO times (`to` is the end of that day). */
export function chatsQuery(filters, { cursor = null, limit = CHAT_PAGE } = {}) {
  const query = { limit };
  for (const name of ["q", "user", "model"]) if (filters[name]) query[name] = filters[name];
  if (filters.archived === "yes") query.archived = "true";
  if (filters.archived === "no") query.archived = "false";
  if (filters.from) query.from = dayStart(filters.from).toISOString();
  if (filters.to) {
    const end = dayStart(filters.to);
    end.setDate(end.getDate() + 1);
    query.to = end.toISOString();
  }
  if (cursor) query.cursor = cursor;
  return query;
}

export function chatRow(row) {
  if (!isObject(row) || typeof row.chatId !== "string" || !row.chatId) return null;
  return {
    chatId: row.chatId,
    title: text(row.title),
    userName: text(row.userName),
    userEmail: text(row.userEmail),
    models: list(row.models).filter((model) => typeof model === "string"),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
    messageCount: finite(row.messageCount) ?? 0,
    auditId: text(row.auditId),
    versions: finite(row.versions) ?? 1,
    archived: row.archived === true,
  };
}

/** The rows, the next cursor and whether the index is still being built, from a GET /api/audit/chats answer. */
export function chatsPage(answer) {
  return {
    rows: list(answer?.rows).map(chatRow).filter(Boolean),
    cursor: typeof answer?.nextCursor === "string" && answer.nextCursor ? answer.nextCursor : null,
    building: answer?.index?.building === true,
  };
}

/** A message time in ms, from epoch seconds, epoch milliseconds or ISO text; null when it is none of them. */
export function messageTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return messageTime(Number(value));
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

const ROLES = Object.freeze(["user", "assistant", "system", "tool"]);

/**
 * The thread of a GET /api/audit/chats/:chatId answer, oldest first. The
 * content is text for the MarkdownViewer; nothing in it is ever HTML.
 */
export function threadModel(answer) {
  const chat = isObject(answer?.chat) ? answer.chat : {};
  const messages = list(answer?.messages)
    .filter((message) => isObject(message))
    .map((message, index) => ({
      id: String(message.id ?? index),
      parentId: message.parentId == null ? null : String(message.parentId),
      role: ROLES.includes(message.role) ? message.role : "other",
      model: text(message.model),
      at: messageTime(message.timestamp),
      content: typeof message.content === "string" ? message.content : message.content == null ? "" : String(JSON.stringify(message.content)),
      index,
    }))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.index - b.index);
  return {
    chatId: text(chat.chatId) || text(answer?.chatId),
    title: text(chat.title),
    userName: text(chat.userName),
    models: list(chat.models).filter((model) => typeof model === "string"),
    auditId: text(answer?.auditId),
    isLatest: answer?.isLatest !== false,
    messages,
  };
}

/** The versions of a chat, newest first. */
export function versionRows(answer) {
  return list(answer?.versions)
    .filter((item) => isObject(item) && typeof item.auditId === "string" && item.auditId)
    .map((item) => ({ auditId: item.auditId, createdAt: text(item.createdAt), updatedAt: text(item.updatedAt), messageCount: finite(item.messageCount) ?? 0 }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

// ---------------------------------------------------------------------------
// Export chains

function exportRow(row) {
  if (!isObject(row) || typeof row.auditId !== "string" || !row.auditId) return null;
  const mode = row.mode === "incremental" ? "incremental" : "full";
  const chatCount = finite(row.chatCount) ?? 0;
  return {
    auditId: row.auditId,
    mode,
    createdAt: text(row.createdAt),
    reason: text(row.reason),
    chatCount,
    totalChatCount: finite(row.totalChatCount),
    messageCount: finite(row.messageCount) ?? 0,
    mdBytes: finite(row.mdBytes) ?? 0,
    hasMarkdown: Boolean(row.mdFile),
    chainId: typeof row.chainId === "string" ? row.chainId : null,
    empty: row.skippedEmpty === true || (mode === "incremental" && chatCount === 0),
  };
}

export function exportRows(answer) {
  return list(answer?.exports).map(exportRow).filter(Boolean);
}

/** The export ids the retention plan would remove, with the reason. */
export function removalPlan(status) {
  const out = new Map();
  for (const item of list(status?.retention?.plan?.remove)) if (isObject(item) && typeof item.auditId === "string") out.set(item.auditId, text(item.reason));
  return out;
}

/**
 * The export chains for the page: each chain is one full baseline plus the
 * incrementals after it (04 §16.2), newest chain first, built from the status
 * (chains and retention plan) and the export list. Exports that belong to no
 * chain are returned apart.
 * @returns {{ chains: Array<{ id, createdAt, active, chats, messages, bytes, baseline, incrementals, empties }>, loose: object[], needsRebaseline: boolean, warnings: Array<{ code, message }> }}
 */
export function chainModel(status, exportsAnswer) {
  const rows = exportRows(exportsAnswer);
  const byId = new Map(rows.map((row) => [row.auditId, row]));
  const removals = removalPlan(status);
  const used = new Set();
  const mark = (row) => (row ? { ...row, removeReason: removals.get(row.auditId) || null } : null);
  const chains = list(status?.chains).filter((chain) => isObject(chain) && typeof chain.fullAuditId === "string").map((chain) => {
    const ids = list(chain.auditIds).filter((id) => typeof id === "string");
    if (!ids.includes(chain.fullAuditId)) ids.push(chain.fullAuditId);
    for (const id of ids) used.add(id);
    const incrementals = ids.filter((id) => id !== chain.fullAuditId).map((id) => mark(byId.get(id) || { auditId: id, mode: "incremental", createdAt: "", chatCount: 0, messageCount: 0, mdBytes: 0, hasMarkdown: false, chainId: chain.fullAuditId, empty: false, reason: "", totalChatCount: null })).filter(Boolean);
    return {
      id: chain.fullAuditId,
      createdAt: text(chain.createdAt),
      active: chain.active === true,
      chats: finite(chain.chats) ?? 0,
      messages: finite(chain.messages) ?? 0,
      bytes: finite(chain.bytes) ?? 0,
      baseline: mark(byId.get(chain.fullAuditId) || null),
      incrementals,
      empties: incrementals.filter((row) => row.empty).length,
    };
  });
  return {
    chains,
    loose: rows.filter((row) => !used.has(row.auditId)).map(mark),
    needsRebaseline: status?.retention?.plan?.needsRebaseline === true || status?.schedule?.needsRebaseline === true,
    warnings: list(status?.retention?.plan?.warnings).filter(isObject).map((item) => ({ code: text(item.code), message: text(item.message) })),
  };
}

/** The `n` of "1 full baseline + n incrementals" for a chain. */
export const incrementalCount = (chain) => chain.incrementals.length;

/** The body of POST /api/audit/export. */
export function exportBody(mode, note) {
  return { mode: mode === "incremental" ? "incremental" : "full", note: String(note || "").trim().slice(0, 500) };
}

// ---------------------------------------------------------------------------
// Access log

export function accessRow(row) {
  if (!isObject(row) || finite(row.seq) === null) return null;
  return {
    seq: row.seq,
    at: text(row.at),
    source: text(row.source),
    actor: text(row.actor),
    session: text(row.session),
    clientIp: text(row.clientIp),
    action: text(row.action),
    target: text(row.target),
    outcome: text(row.outcome),
    detail: row.detail ?? null,
    hash: text(row.hash),
  };
}

export function accessPage(answer) {
  return {
    rows: list(answer?.rows).map(accessRow).filter(Boolean),
    cursor: typeof answer?.nextCursor === "string" && answer.nextCursor ? answer.nextCursor : null,
  };
}

const OUTCOME_TONE = Object.freeze({ ok: "ok", denied: "warn", error: "error" });
export const outcomeTone = (outcome) => OUTCOME_TONE[outcome] || "neutral";

/** A short, safe line for an access-log detail object: its scalar fields as `name=value`; nested values are left out. */
export function detailText(detail) {
  if (detail === null || detail === undefined) return "";
  if (typeof detail === "string") return detail.slice(0, 200);
  if (!isObject(detail)) return String(detail).slice(0, 200);
  return Object.entries(detail)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .map(([name, value]) => `${name}=${String(value).slice(0, 80)}`)
    .join(" ")
    .slice(0, 300);
}

/** The result of GET /api/audit/access-log/verify: broken after which entry, or intact with its row count. */
export function verifyView(answer) {
  if (!isObject(answer)) return null;
  const broken = finite(answer.firstBrokenSeq);
  return { ok: answer.ok === true && broken === null, rows: finite(answer.rows) ?? 0, firstBrokenSeq: broken };
}

// ---------------------------------------------------------------------------
// Settings

export const SETTING_FIELDS = Object.freeze([
  Object.freeze({ path: "schedule.enabled", kind: "bool", group: "schedule" }),
  Object.freeze({ path: "schedule.incrementalEveryMinutes", kind: "int", min: 15, max: 1440, group: "schedule", unit: "minutes" }),
  Object.freeze({ path: "schedule.fullAtLocal", kind: "clock", group: "schedule" }),
  Object.freeze({ path: "retention.maxExports", kind: "int", min: 0, max: 100000, group: "retention", unit: "exports" }),
  Object.freeze({ path: "retention.maxAgeDays", kind: "int", min: 0, max: 36500, group: "retention", unit: "days" }),
  Object.freeze({ path: "retention.rebaselineDays", kind: "decimal", min: 0, max: 36500, group: "retention", unit: "days" }),
  Object.freeze({ path: "retention.maxChains", kind: "int", min: 0, max: 1000, group: "retention", unit: "chains" }),
  Object.freeze({ path: "logQueryText", kind: "bool", group: "privacy" }),
]);
export const SETTING_GROUPS = Object.freeze(["schedule", "retention", "privacy"]);

function read(settings, path) {
  return path.split(".").reduce((value, name) => (isObject(value) ? value[name] : undefined), settings);
}

/** The form draft of a GET /api/audit/settings answer: booleans as booleans, the rest as text. */
export function settingsDraft(settings) {
  const draft = {};
  for (const field of SETTING_FIELDS) {
    const value = read(settings, field.path);
    draft[field.path] = field.kind === "bool" ? value === true : value === undefined || value === null ? "" : String(value);
  }
  return draft;
}

function fieldValue(field, raw) {
  if (field.kind === "bool") return { value: raw === true };
  const value = String(raw ?? "").trim();
  if (value === "") return { error: "required" };
  if (field.kind === "clock") return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? { value } : { error: "clock" };
  if (!/^\d+(\.\d+)?$/.test(value) || (field.kind === "int" && value.includes("."))) return { error: "number" };
  const number = Number(value);
  if (number < field.min || number > field.max) return { error: "range" };
  return { value: number };
}

/**
 * The PUT body for the fields that changed (only those are sent) and the
 * error code of every invalid field.
 * @returns {{ patch: object, errors: Record<string,string>, changed: boolean }}
 */
export function settingsPatch(settings, draft) {
  const patch = {};
  const errors = {};
  let changed = false;
  for (const field of SETTING_FIELDS) {
    const { value, error } = fieldValue(field, draft[field.path]);
    if (error) {
      errors[field.path] = error;
      continue;
    }
    const before = read(settings, field.path);
    const same = field.kind === "bool" || field.kind === "clock" ? before === value : before !== undefined && before !== null && Number(before) === value;
    if (same) continue;
    changed = true;
    const [head, tail] = field.path.split(".");
    if (tail) (patch[head] ||= {})[tail] = value;
    else patch[head] = value;
  }
  return { patch, errors, changed };
}

/** The writer's `errors[]` mapped to the form paths they name; the rest are kept apart. */
export function serverSettingErrors(errors) {
  const byPath = {};
  const other = [];
  for (const item of list(errors)) {
    if (!isObject(item)) continue;
    const field = text(item.field);
    const path = SETTING_FIELDS.find((entry) => entry.path === field || field === entry.path.split(".").pop() || field === `audit.${entry.path}`)?.path;
    if (path) byPath[path] = text(item.code) || "invalid";
    else other.push({ field, code: text(item.code), message: text(item.message) });
  }
  return { byPath, other };
}
