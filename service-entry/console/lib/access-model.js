// The pure part of the Access pages (07 §6.10, 05 §13.4): the key form draft
// and its request bodies, model-pattern matching, the attention rules of the
// key table, the invite text, the client-guide base URLs and the legacy
// per-engine summary. No DOM, no network; the components and routes under
// routes/access/ and components/{key-form,share-card}.js do the rendering.
//
// Every user-facing sentence is a catalog key (`access.*`); the tables below
// list the keys as literals so the i18n gate can see they are used.

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IP_RULE = /^[0-9a-f:.]+(?:\/\d{1,3})?$/i;
const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/;

export const KEY_CLASSES = Object.freeze(["owner", "internal", "friend", "trial", "customer"]);
export const KEY_STATUSES = Object.freeze(["active", "disabled", "revoked"]);
export const LISTENERS = Object.freeze(["public", "admin"]);
export const ROTATE_OVERLAPS = Object.freeze([
  Object.freeze({ seconds: 0, label: "access.rotate.overlap.0" }),
  Object.freeze({ seconds: 3600, label: "access.rotate.overlap.3600" }),
  Object.freeze({ seconds: 86400, label: "access.rotate.overlap.86400" }),
  Object.freeze({ seconds: 604800, label: "access.rotate.overlap.604800" }),
]);
export const EXPIRY_QUICK_DAYS = Object.freeze([7, 30, 90, 365]);
export const ATTENTION_DAYS = 30;

/** Scopes in the form's order, grouped in plain language (05 §6.3). `adminOnly` scopes never work on the PUBLIC listener. */
export const SCOPES = Object.freeze([
  { id: "models.read", group: "access.scope.group.chat", label: "access.scope.models.read.label", hint: "access.scope.models.read.hint" },
  { id: "chat", group: "access.scope.group.chat", label: "access.scope.chat.label", hint: "access.scope.chat.hint" },
  { id: "completions", group: "access.scope.group.chat", label: "access.scope.completions.label", hint: "access.scope.completions.hint" },
  { id: "responses", group: "access.scope.group.chat", label: "access.scope.responses.label", hint: "access.scope.responses.hint" },
  { id: "messages", group: "access.scope.group.chat", label: "access.scope.messages.label", hint: "access.scope.messages.hint" },
  { id: "embeddings", group: "access.scope.group.chat", label: "access.scope.embeddings.label", hint: "access.scope.embeddings.hint" },
  { id: "audio.speech", group: "access.scope.group.tools", label: "access.scope.audio.speech.label", hint: "access.scope.audio.speech.hint" },
  { id: "audio.clone", group: "access.scope.group.tools", label: "access.scope.audio.clone.label", hint: "access.scope.audio.clone.hint", adminOnly: true },
  { id: "search", group: "access.scope.group.tools", label: "access.scope.search.label", hint: "access.scope.search.hint" },
  { id: "mcp", group: "access.scope.group.tools", label: "access.scope.mcp.label", hint: "access.scope.mcp.hint", adminOnly: true },
  { id: "self.read", group: "access.scope.group.self", label: "access.scope.self.read.label", hint: "access.scope.self.read.hint" },
  { id: "self.rotate", group: "access.scope.group.self", label: "access.scope.self.rotate.label", hint: "access.scope.self.rotate.hint" },
  { id: "self.origins", group: "access.scope.group.self", label: "access.scope.self.origins.label", hint: "access.scope.self.origins.hint" },
  { id: "debug.route", group: "access.scope.group.debug", label: "access.scope.debug.route.label", hint: "access.scope.debug.route.hint" },
].map((scope) => Object.freeze(scope)));

export const SCOPE_GROUPS = Object.freeze(["access.scope.group.chat", "access.scope.group.tools", "access.scope.group.self", "access.scope.group.debug"]);
const DEFAULT_SCOPES = Object.freeze(["models.read", "self.read", "chat", "messages"]);

/**
 * One row per limit of KeyRecord.limits, bounds as the key store validates
 * them (service-entry/lib/keys-store.js). `blank` says what an empty box
 * means: the default of the public listener, or no cap at all.
 */
export const LIMIT_FIELDS = Object.freeze([
  { id: "rpm", min: 1, max: 1_000_000, blank: "inherit", label: "access.field.rpm.label", help: "access.field.rpm.help", unit: "access.unit.perMinute", flag: "limits.rpm" },
  { id: "tpm", min: 1, max: 10_000_000_000, blank: "inherit", label: "access.field.tpm.label", help: "access.field.tpm.help", unit: "access.unit.tokensPerMinute", flag: "limits.tpm" },
  { id: "maxConcurrent", min: 1, max: 1024, blank: "inherit", label: "access.field.maxConcurrent.label", help: "access.field.maxConcurrent.help", unit: "access.unit.requests", flag: "limits.maxConcurrent" },
  { id: "maxQueued", min: 0, max: 10_000, blank: "inherit", label: "access.field.maxQueued.label", help: "access.field.maxQueued.help", unit: "access.unit.requests", flag: "limits.maxQueued" },
  { id: "queueTimeoutSeconds", min: 1, max: 3600, blank: "inherit", label: "access.field.queueTimeoutSeconds.label", help: "access.field.queueTimeoutSeconds.help", unit: "access.unit.seconds", flag: "limits.queueTimeoutSeconds" },
  { id: "requestTimeoutSeconds", min: 1, max: 86_400, blank: "inherit", label: "access.field.requestTimeoutSeconds.label", help: "access.field.requestTimeoutSeconds.help", unit: "access.unit.seconds", flag: "limits.requestTimeoutSeconds" },
  { id: "dailyTokens", min: 0, max: 1_000_000_000_000, blank: "unlimited", label: "access.field.dailyTokens.label", help: "access.field.dailyTokens.help", unit: "access.unit.tokensPerDay", flag: "limits.dailyTokens" },
  { id: "monthlyTokens", min: 0, max: 1_000_000_000_000, blank: "unlimited", label: "access.field.monthlyTokens.label", help: "access.field.monthlyTokens.help", unit: "access.unit.tokensPerMonth", flag: "limits.monthlyTokens" },
  { id: "dailyRequests", min: 0, max: 1_000_000_000, blank: "unlimited", label: "access.field.dailyRequests.label", help: "access.field.dailyRequests.help", unit: "access.unit.requestsPerDay", flag: "limits.dailyRequests" },
  { id: "maxOutputTokens", min: 1, max: 10_000_000, blank: "inherit", label: "access.field.maxOutputTokens.label", help: "access.field.maxOutputTokens.help", unit: "access.unit.tokens", flag: "limits.maxOutputTokens" },
].map((field) => Object.freeze(field)));

/** Non-limit fields: catalog keys for the label and the help popover, and the API field the flag shows. */
export const FIELD_COPY = Object.freeze({
  name: { label: "access.field.name.label", help: "access.field.name.help", flag: "name" },
  holder: { label: "access.field.holder.label", help: "access.field.holder.help", flag: "holder" },
  class: { label: "access.field.class.label", help: "access.field.class.help", flag: "class" },
  customerId: { label: "access.field.customerId.label", help: "access.field.customerId.help", flag: "customerId" },
  notes: { label: "access.field.notes.label", help: "access.field.notes.help", flag: "notes" },
  scopes: { label: "access.field.scopes.label", help: "access.field.scopes.help", flag: "scopes" },
  models: { label: "access.field.models.label", help: "access.field.models.help", flag: "models" },
  fleetAllow: { label: "access.field.fleetAllow.label", help: "access.field.fleetAllow.help", flag: "fleetAllow" },
  listeners: { label: "access.field.listeners.label", help: "access.field.listeners.help", flag: "listeners" },
  allowedOrigins: { label: "access.field.allowedOrigins.label", help: "access.field.allowedOrigins.help", flag: "allowedOrigins" },
  allowedIps: { label: "access.field.allowedIps.label", help: "access.field.allowedIps.help", flag: "allowedIps" },
  expires: { label: "access.field.expires.label", help: "access.field.expires.help", flag: "expiresAt" },
});

// ---------------------------------------------------------------------------
// Lists, dates, numbers

/** `a, b` or one per line → unique non-empty items in order. */
export function splitList(text) {
  const seen = new Set();
  const out = [];
  for (const item of String(text ?? "").split(/[\s,]+/)) {
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** `YYYY-MM-DD` of an instant in local time, the value of an <input type=date>. */
export function dateInput(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** ISO instant of the end of a local day (23:59:59), or null for an empty or invalid date. */
export function dateInputToIso(text) {
  const match = DATE_INPUT.exec(String(text ?? "").trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
  return Number.isNaN(date.getTime()) || date.getMonth() !== Number(match[2]) - 1 ? null : date.toISOString();
}

function limitNumber(text, spec) {
  const value = String(text ?? "").trim();
  if (value === "") return { value: null };
  if (!/^\d+$/.test(value)) return { error: "invalid" };
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < spec.min || number > spec.max) return { error: "out_of_range" };
  return { value: number };
}

// ---------------------------------------------------------------------------
// The form draft

function emptyLimits() {
  return Object.fromEntries(LIMIT_FIELDS.map((field) => [field.id, ""]));
}

/** A custom key: friend class, chat scopes, every model, public listener, no expiry. */
export function blankDraft() {
  return {
    preset: "",
    name: "",
    holder: "",
    notes: "",
    class: "friend",
    customerId: "",
    scopes: [...DEFAULT_SCOPES],
    models: "*",
    fleetAllow: "",
    listeners: ["public"],
    limits: emptyLimits(),
    allowedOrigins: "",
    allowedIps: "",
    expires: "",
  };
}

/** The draft a preset (GET /api/access/presets) fills in; name, holder, notes and customer carry over. */
export function draftFromPreset(preset, { now = Date.now(), previous = null } = {}) {
  const base = blankDraft();
  if (previous) Object.assign(base, { name: previous.name, holder: previous.holder, notes: previous.notes, customerId: previous.customerId });
  if (!preset) return base;
  const limits = emptyLimits();
  for (const field of LIMIT_FIELDS) {
    const value = preset.limits?.[field.id];
    if (value !== undefined && value !== null) limits[field.id] = String(value);
  }
  return {
    ...base,
    preset: String(preset.id || ""),
    class: KEY_CLASSES.includes(preset.class) ? preset.class : base.class,
    scopes: Array.isArray(preset.scopes) ? [...preset.scopes] : base.scopes,
    models: Array.isArray(preset.models) && preset.models.length ? preset.models.join("\n") : base.models,
    listeners: Array.isArray(preset.listeners) && preset.listeners.length ? [...preset.listeners] : base.listeners,
    limits,
    expires: preset.expiresInDays ? dateInput(now + preset.expiresInDays * DAY_MS) : "",
  };
}

/** The edit draft of a KeyRecord. */
export function draftFromKey(key) {
  const limits = emptyLimits();
  for (const field of LIMIT_FIELDS) {
    const value = key?.limits?.[field.id];
    if (value !== undefined && value !== null) limits[field.id] = String(value);
  }
  return {
    preset: "",
    name: String(key?.name ?? ""),
    holder: String(key?.holder ?? ""),
    notes: String(key?.notes ?? ""),
    class: KEY_CLASSES.includes(key?.class) ? key.class : "friend",
    customerId: String(key?.customerId ?? ""),
    scopes: Array.isArray(key?.scopes) ? [...key.scopes] : [],
    models: (Array.isArray(key?.models) ? key.models : []).join("\n"),
    fleetAllow: (Array.isArray(key?.fleetAllow) ? key.fleetAllow : []).join("\n"),
    listeners: Array.isArray(key?.listeners) && key.listeners.length ? [...key.listeners] : ["public"],
    limits,
    allowedOrigins: (Array.isArray(key?.allowedOrigins) ? key.allowedOrigins : []).join("\n"),
    allowedIps: (Array.isArray(key?.allowedIps) ? key.allowedIps : []).join("\n"),
    expires: key?.expiresAt ? dateInput(Date.parse(key.expiresAt)) : "",
  };
}

function validOrigin(text) {
  if (text === "*") return true;
  try {
    const url = new URL(text);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && !/[?#]/.test(text);
  } catch {
    return false;
  }
}

/**
 * Client-side checks before a request is sent: the same bounds the key store
 * enforces, so the person sees the problem next to the field. Returns
 * `{ [field]: code }` (codes are `access.err.<code>`), empty when valid.
 * @param presetInfo the preset entry of the draft, for its customer requirement
 */
export function validateDraft(draft, { presetInfo = null, mode = "create", now = Date.now() } = {}) {
  const errors = {};
  const name = String(draft.name ?? "").trim();
  if (!name) errors.name = "required";
  else if (name.length > 120) errors.name = "too_long";
  const customer = String(draft.customerId ?? "").trim();
  if (customer && !UUID.test(customer)) errors.customerId = "invalid";
  else if (!customer && presetInfo?.requiresCustomer) errors.customerId = "required";
  if (!draft.scopes?.length) errors.scopes = "required";
  if (!splitList(draft.models).length) errors.models = "required";
  if (!draft.listeners?.length) errors.listeners = "required";
  for (const field of LIMIT_FIELDS) {
    const parsed = limitNumber(draft.limits?.[field.id], field);
    if (parsed.error) errors[`limits.${field.id}`] = parsed.error;
  }
  if (splitList(draft.allowedOrigins).some((origin) => !validOrigin(origin))) errors.allowedOrigins = "invalid";
  if (splitList(draft.allowedIps).some((rule) => !IP_RULE.test(rule))) errors.allowedIps = "invalid";
  if (String(draft.expires ?? "").trim()) {
    const iso = dateInputToIso(draft.expires);
    if (!iso) errors.expires = "invalid";
    else if (mode === "create" && Date.parse(iso) <= now) errors.expires = "past";
  }
  return errors;
}

function limitsOf(draft) {
  const out = {};
  for (const field of LIMIT_FIELDS) out[field.id] = limitNumber(draft.limits?.[field.id], field).value ?? null;
  return out;
}

/** The POST /api/access/keys body of a draft (05 §13.1); the preset id rides along so the server records it. */
export function draftToCreateBody(draft) {
  const customer = String(draft.customerId ?? "").trim();
  const holder = String(draft.holder ?? "").trim();
  const notes = String(draft.notes ?? "").trim();
  const fleet = splitList(draft.fleetAllow);
  return {
    ...(draft.preset ? { preset: draft.preset } : {}),
    name: String(draft.name ?? "").trim(),
    class: draft.class,
    ...(customer ? { customerId: customer.toLowerCase() } : {}),
    ...(holder ? { holder } : {}),
    scopes: [...draft.scopes],
    models: splitList(draft.models),
    ...(fleet.length ? { fleetAllow: fleet } : {}),
    listeners: [...draft.listeners],
    limits: limitsOf(draft),
    allowedOrigins: splitList(draft.allowedOrigins),
    allowedIps: splitList(draft.allowedIps),
    expiresAt: dateInputToIso(draft.expires),
    ...(notes ? { notes } : {}),
  };
}

const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));
const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);

/** The PATCH body that turns `key` into `draft`: only the fields that changed. Empty when nothing did. */
export function draftToPatch(draft, key) {
  const next = draftToCreateBody({ ...draft, preset: "" });
  const patch = {};
  if (next.name !== key.name) patch.name = next.name;
  if (next.class !== key.class) patch.class = next.class;
  if ((next.customerId ?? null) !== (key.customerId ?? null)) patch.customerId = next.customerId ?? null;
  if ((next.holder ?? null) !== (key.holder ?? null)) patch.holder = next.holder ?? null;
  if (!sameSet(next.scopes, key.scopes || [])) patch.scopes = next.scopes;
  if (!sameList(next.models, key.models || [])) patch.models = next.models;
  if (!sameList(next.fleetAllow || [], key.fleetAllow || [])) patch.fleetAllow = next.fleetAllow || [];
  if (!sameSet(next.listeners, key.listeners || [])) patch.listeners = next.listeners;
  const limits = {};
  for (const field of LIMIT_FIELDS) {
    if ((next.limits[field.id] ?? null) !== (key.limits?.[field.id] ?? null)) limits[field.id] = next.limits[field.id];
  }
  if (Object.keys(limits).length) patch.limits = limits;
  if (!sameList(next.allowedOrigins, key.allowedOrigins || [])) patch.allowedOrigins = next.allowedOrigins;
  if (!sameList(next.allowedIps, key.allowedIps || [])) patch.allowedIps = next.allowedIps;
  const before = key.expiresAt ? dateInput(Date.parse(key.expiresAt)) : "";
  if (String(draft.expires || "") !== before) patch.expiresAt = next.expiresAt;
  if ((next.notes ?? null) !== (key.notes ?? null)) patch.notes = next.notes ?? null;
  return patch;
}

/** Maps an ApiError's `fieldErrors` to `{ [field]: code }`; `limits.rpm` stays `limits.rpm`. */
export function fieldErrorMap(error) {
  const out = {};
  for (const item of Array.isArray(error?.fieldErrors) ? error.fieldErrors : []) {
    if (item?.field && !out[item.field]) out[item.field] = { code: String(item.code || "invalid"), message: String(item.message || "") };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model patterns (05 §6.3: a port of key-policy matchPattern/modelAllowed)

function globMatch(pattern, value) {
  const glob = String(pattern ?? "").trim().toLowerCase();
  const text = String(value ?? "").trim().toLowerCase();
  if (!glob) return false;
  if (!glob.includes("*")) return glob === text;
  const parts = glob.split("*");
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!text.startsWith(first)) return false;
  let position = first.length;
  for (let index = 1; index < parts.length - 1; index += 1) {
    if (!parts[index]) continue;
    const found = text.indexOf(parts[index], position);
    if (found === -1) return false;
    position = found + parts[index].length;
  }
  return text.length - position >= last.length && text.endsWith(last);
}

/** The model ids a list of patterns allows (`*` globs, `!pattern` excludes applied last); [] allows none. */
export function matchedModels(patterns, names) {
  const includes = [];
  const excludes = [];
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    const pattern = String(raw ?? "").trim();
    if (pattern.startsWith("!")) {
      if (pattern.slice(1).trim()) excludes.push(pattern.slice(1).trim());
    } else if (pattern) {
      includes.push(pattern);
    }
  }
  if (!includes.length) return [];
  return (Array.isArray(names) ? names : []).filter((name) => includes.some((p) => globMatch(p, name)) && !excludes.some((p) => globMatch(p, name)));
}

/** Served model ids from a GET /api/fleet payload (entries are strings or objects), unique and sorted. */
export function modelNames(fleet) {
  const names = new Set();
  for (const instance of Array.isArray(fleet?.instances) ? fleet.instances : []) {
    for (const entry of Array.isArray(instance?.models) ? instance.models : []) {
      const id = typeof entry === "string" ? entry : entry?.id ?? entry?.name ?? entry?.model;
      if (typeof id === "string" && id.trim()) names.add(id.trim());
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// The key table

/** The badge tone of each status the table shows. */
export const STATUS_TONE = Object.freeze({ active: "ok", disabled: "neutral", revoked: "error", expired: "warn" });

/** The status the table shows: an active key past its expiry reads as expired. */
export function displayStatus(key, now = Date.now()) {
  if (key.status === "active" && key.expiresAt && Date.parse(key.expiresAt) <= now) return "expired";
  return KEY_STATUSES.includes(key.status) ? key.status : "active";
}

/** "expired", "expiring" or "unused" for an active key that needs a look, else null (05 §13.4 attention strip). */
export function keyAttention(key, now = Date.now(), { days = ATTENTION_DAYS } = {}) {
  if (!key || key.status !== "active") return null;
  const expires = key.expiresAt ? Date.parse(key.expiresAt) : NaN;
  if (Number.isFinite(expires)) {
    if (expires <= now) return "expired";
    if (expires - now <= days * DAY_MS) return "expiring";
  }
  const last = key.lastUsedAt ? Date.parse(key.lastUsedAt) : Date.parse(key.createdAt || "");
  if (Number.isFinite(last) && now - last >= days * DAY_MS) return "unused";
  return null;
}

/** Counts per attention kind over loaded keys. */
export function attentionCounts(keys, now = Date.now()) {
  const counts = { expired: 0, expiring: 0, unused: 0 };
  for (const key of Array.isArray(keys) ? keys : []) {
    const kind = keyAttention(key, now);
    if (kind) counts[kind] += 1;
  }
  return counts;
}

/** The GET /api/access/keys query of the table's filters; blanks are left out. */
export function keyListQuery(filters = {}, { limit = 100 } = {}) {
  const query = { limit };
  if (filters.status) query.status = filters.status;
  if (filters.class) query.class = filters.class;
  if (filters.customer) query.customer = filters.customer;
  const q = String(filters.q ?? "").trim();
  if (q) query.q = q;
  if (filters.expiring) query.expiring = "true";
  return query;
}

/** The phrase the bulk-revoke dialog asks for. */
export function bulkRevokePhrase(count) {
  return `REVOKE ${count}`;
}

/** Keys the bulk bar may revoke: everything not revoked already. */
export function revocable(keys) {
  return (Array.isArray(keys) ? keys : []).filter((key) => key && key.status !== "revoked");
}

/** Tokens used today per key id from a GET /api/telemetry/breakdown?dim=key payload. */
export function tokensByKey(breakdown) {
  const out = new Map();
  for (const row of Array.isArray(breakdown?.rows) ? breakdown.rows : []) {
    if (typeof row?.key !== "string") continue;
    const total = (Number(row.promptTokens) || 0) + (Number(row.outputTokens) || 0);
    out.set(row.key, total);
  }
  return out;
}

/** Rows of a GET /api/billing/customers answer: a list, `{ items }` or `{ customers }`. */
export function customerRows(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.customers) ? payload.customers : [];
  return list
    .filter((row) => row && typeof (row.customerId ?? row.id) === "string")
    .map((row) => ({ id: String(row.customerId ?? row.id), name: String(row.name || row.externalRef || row.customerId || row.id), status: String(row.status || ""), planId: row.planId ?? null, externalRef: String(row.externalRef || ""), balance: row.balanceMicrocredits ?? null }));
}

// ---------------------------------------------------------------------------
// Share card and invite text (05 §13.4)

/** The portal link of a new key: the secret travels in the fragment, which is never sent to a server. */
export function portalLink(portalUrl, secret) {
  try {
    const url = new URL("me", String(portalUrl || ""));
    url.hash = `key=${secret}`;
    return url.href;
  } catch {
    return "";
  }
}

/** "30 requests/min · 100,000 tokens/min …" from KeyRecord.limits; empty when nothing is capped. */
export function limitsSummary(i18n, limits) {
  const parts = [];
  for (const [id, key] of [
    ["rpm", "access.summary.rpm"], ["tpm", "access.summary.tpm"], ["maxConcurrent", "access.summary.maxConcurrent"],
    ["dailyTokens", "access.summary.dailyTokens"], ["monthlyTokens", "access.summary.monthlyTokens"],
    ["dailyRequests", "access.summary.dailyRequests"], ["maxOutputTokens", "access.summary.maxOutputTokens"],
  ]) {
    const value = limits?.[id];
    if (value !== null && value !== undefined) parts.push(i18n.t(key, { value }));
  }
  return parts.join(" · ");
}

/**
 * The message a person sends to the key's holder. `i18n` decides the
 * language, so the share card can render it in either locale. It includes
 * the key, because that is what the message is for.
 */
export function inviteText(i18n, { holder, share, secret, expiresAt, limits, fmt }) {
  const who = String(holder || "").trim();
  const lines = [
    who ? i18n.t("access.invite.greetingNamed", { name: who }) : i18n.t("access.invite.greeting"),
    i18n.t("access.invite.intro"),
    "",
    i18n.t("access.invite.openai", { url: share?.openaiBase || "" }),
    i18n.t("access.invite.anthropic", { url: share?.anthropicBase || "" }),
    i18n.t("access.invite.key", { key: secret }),
    i18n.t("access.invite.model", { model: share?.recommendedModel || "auto" }),
  ];
  const summary = limitsSummary(i18n, limits);
  if (summary) lines.push(i18n.t("access.invite.limits", { limits: summary }));
  lines.push(expiresAt ? i18n.t("access.invite.expires", { date: fmt?.dateTime ? fmt.dateTime(expiresAt, { style: "date" }) : expiresAt }) : i18n.t("access.invite.noExpiry"));
  const link = portalLink(share?.portalUrl, secret);
  if (link) lines.push("", i18n.t("access.invite.portal", { url: link }));
  lines.push("", i18n.t("access.invite.keep"));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Client guides: base URLs

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** True for localhost, any 127.x.x.x address and the IPv6 loopback. */
export function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "[::1]" || host === "::1" || LOOPBACK_V4.test(host);
}

function trimSlash(text) {
  return String(text || "").replace(/\/+$/, "");
}

/**
 * The three ways to reach the gateway for the clients page (07 §6.10):
 * this machine, the LAN address and the public base URL. `gateway` is the
 * bootstrap's `{ autoOpenAi, autoClaude }` (ADMIN paths); Public uses the
 * 05 §8 paths (`/v1`, `/anthropic`) and exists only when a base URL is set.
 * @param where { protocol, hostname, port } of the page
 */
export function buildBaseUrls({ where, gateway, publicBase }) {
  const protocol = where?.protocol || "http:";
  const port = where?.port ? `:${where.port}` : "";
  const hostname = where?.hostname || "";
  const openaiPath = gateway?.autoOpenAi || "/gateway/auto/openai/v1";
  const claudePath = gateway?.autoClaude || "/gateway/auto/claude";
  const onLoopback = isLoopbackHost(hostname);
  const localHost = onLoopback ? hostname : "localhost";
  const lanHost = onLoopback ? "<LAN-IP>" : hostname;
  const make = (id, origin, extra = {}) => ({ id, available: true, placeholder: false, openai: `${origin}${openaiPath}`, anthropic: `${origin}${claudePath}`, ...extra });
  const out = [
    make("local", `${protocol}//${localHost}${port}`),
    make("lan", `${protocol}//${lanHost}${port}`, { placeholder: onLoopback }),
  ];
  const base = trimSlash(publicBase);
  out.push(base
    ? { id: "public", available: true, placeholder: false, openai: `${base}/v1`, anthropic: `${base}/anthropic` }
    : { id: "public", available: false, placeholder: false, openai: "", anthropic: "" });
  return out;
}

/** Fills `{baseUrl}`, `{anthropicUrl}` and `{model}` in a guide template; `$API_KEY` stays as written. */
export function fillGuide(template, { baseUrl, anthropicUrl, model }) {
  return String(template ?? "")
    .replaceAll("{baseUrl}", baseUrl || "")
    .replaceAll("{anthropicUrl}", anthropicUrl || "")
    .replaceAll("{model}", model || "auto");
}

// ---------------------------------------------------------------------------
// Legacy per-engine keys (the pre-05 degrade path: GET /api/keys)

/** Rows of a GET /api/keys answer for the legacy table; unknown shapes give []. */
export function legacyClients(payload) {
  const list = payload?.keys?.clients ?? payload?.clients;
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item.id === "string")
    .map((item) => ({
      manager: String(item.manager || ""),
      managerName: String(item.managerName || item.manager || ""),
      id: item.id,
      name: String(item.name || item.id),
      state: String(item.state || "active"),
      createdAt: item.createdAt || null,
      lastUsedAt: item.lastUsedAt || null,
      expiresAt: item.expiresAt || null,
      allowedModels: Array.isArray(item.allowedModels) ? item.allowedModels : [],
      rateLimitRpm: Number(item.rateLimitRpm) || null,
      neverUsed: item.neverUsed === true,
      unused: item.unused === true,
      expiringSoon: item.expiringSoon === true,
    }));
}

/** Managers listed in a GET /api/keys answer, for the legacy create form. */
export function legacyManagers(payload) {
  const list = payload?.keys?.perManager;
  return (Array.isArray(list) ? list : []).filter((item) => item && typeof item.manager === "string").map((item) => ({ id: item.manager, name: String(item.managerName || item.manager), online: item.online !== false }));
}

/** The share block of a key created without the platform key store (legacy path): base URLs and a curl line, no portal. */
export function legacyShare(urls, secret, model = "auto") {
  const snippetCurl = [
    `curl ${urls.openai}/chat/completions \\`,
    `  -H "Authorization: Bearer ${secret}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }] })}'`,
  ].join("\n");
  return { openaiBase: urls.openai, anthropicBase: urls.anthropic, portalUrl: null, recommendedModel: model === "auto" ? null : model, snippetCurl };
}
