// Client snippets and doc templates (05 §12.4). data/client-snippets.json
// holds the copy-paste text with {{OPENAI_BASE}}, {{ANTHROPIC_BASE}}, {{BASE}},
// {{MODEL}} and {{KEY}} placeholders. The base URLs come from /portal-config.json
// (the request origin when it is empty), and {{KEY}} renders as the literal
// $API_KEY unless the reader asks for their own key to be inserted. Docs
// markdown uses the same placeholders plus {{RETENTION_DAYS}}.

export const PLACEHOLDERS = Object.freeze(["OPENAI_BASE", "ANTHROPIC_BASE", "BASE", "MODEL", "KEY", "RETENTION_DAYS"]);
export const KEY_PLACEHOLDER = "$API_KEY";
export const DEFAULT_MODEL = "your-model-id";
export const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// What a key may look like before it is pasted into text the reader copies.
const INSERTABLE_KEY_RE = /^[A-Za-z0-9._~+/=-]{1,512}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

// Every client 05 §12.4 requires, by snippet id.
export const REQUIRED_CLIENT_IDS = Object.freeze([
  "curl-chat",
  "curl-stream",
  "curl-embeddings",
  "curl-tts",
  "python-openai",
  "node-openai",
  "python-anthropic",
  "claude-code",
  "openwebui",
  "chatbox",
  "cherry-studio",
  "nextchat",
  "lobechat",
  "cursor",
  "continue",
  "cline",
  "tts-openai",
]);

function trimBase(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

/**
 * The placeholder values for one render. `config` is /portal-config.json;
 * `origin` stands in when it names no base (LAN-only deployments). A key is
 * used only with insertKey and only when it is made of key-safe characters.
 */
export function templateContext({ config = {}, origin = "", model = "", key = "", insertKey = false, retentionDays } = {}) {
  const fallback = trimBase(origin);
  const base = trimBase(config?.baseUrl) || fallback;
  const days = Number(retentionDays ?? config?.retention?.requestDays);
  return {
    BASE: base,
    OPENAI_BASE: trimBase(config?.openaiBase) || (base ? `${base}/v1` : ""),
    ANTHROPIC_BASE: trimBase(config?.anthropicBase) || (base ? `${base}/anthropic` : ""),
    MODEL: MODEL_RE.test(String(model || "")) ? String(model) : DEFAULT_MODEL,
    KEY: insertKey && INSERTABLE_KEY_RE.test(String(key || "")) ? String(key) : KEY_PLACEHOLDER,
    RETENTION_DAYS: String(Number.isInteger(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS),
  };
}

/** Replaces the {{NAME}} placeholders in one pass; an unknown {{name}} stays as written. */
export function fillTemplate(text, context) {
  return String(text ?? "").replace(/\{\{([A-Z_]+)\}\}/g, (match, name) => (Object.hasOwn(context, name) ? context[name] : match));
}

/** { asOf, ageDays, stale } of the snippet document; stale after staleAfterDays (default 90). */
export function snippetAge(doc, now = Date.now()) {
  const asOf = typeof doc?.asOf === "string" ? doc.asOf : "";
  const time = Date.parse(asOf);
  const limit = Number.isFinite(Number(doc?.staleAfterDays)) && Number(doc.staleAfterDays) > 0 ? Number(doc.staleAfterDays) : 90;
  if (!Number.isFinite(time)) return { asOf, ageDays: null, stale: true };
  const ageDays = Math.max(0, Math.floor((now - time) / DAY_MS));
  return { asOf, ageDays, stale: ageDays > limit };
}

/** The entries in file order, grouped by `group` (entries without one group by id). */
export function groupClients(doc) {
  const groups = [];
  const byName = new Map();
  for (const entry of Array.isArray(doc?.clients) ? doc.clients : []) {
    const name = entry.group || entry.id;
    if (!byName.has(name)) {
      const group = { id: name, clients: [] };
      byName.set(name, group);
      groups.push(group);
    }
    byName.get(name).clients.push(entry);
  }
  return groups;
}

/** The text of one entry in one language, placeholders filled: { code } or { steps }. */
export function renderClient(entry, lang, context) {
  const zh = lang === "zh-CN";
  const note = fillTemplate((zh ? entry.note_zh : entry.note_en) || "", context);
  if (entry.kind === "steps") {
    const steps = (zh ? entry.steps_zh : entry.steps_en) || entry.steps_en || [];
    return { kind: "steps", steps: steps.map((step) => fillTemplate(step, context)), note };
  }
  return { kind: "code", code: fillTemplate(entry.code, context), language: entry.language || "", note };
}

/** Problems with a snippet document, as readable strings; an empty list means it is sound. */
export function validateSnippetDocument(doc) {
  const problems = [];
  if (!doc || typeof doc !== "object") return ["the document is not an object"];
  if (doc.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (!Number.isFinite(Date.parse(doc.asOf))) problems.push("asOf must be an ISO date");
  if (doc.staleAfterDays !== 90) problems.push("staleAfterDays must be 90");
  const clients = Array.isArray(doc.clients) ? doc.clients : [];
  const seen = new Set();
  for (const entry of clients) {
    const id = String(entry?.id || "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) problems.push(`bad client id ${JSON.stringify(entry?.id)}`);
    if (seen.has(id)) problems.push(`${id}: duplicate id`);
    seen.add(id);
    if (!entry.name) problems.push(`${id}: no name`);
    if (!entry.versionTested) problems.push(`${id}: no versionTested`);
    if (!Number.isFinite(Date.parse(entry.asOf))) problems.push(`${id}: no asOf`);
    if (entry.kind === "code") {
      if (typeof entry.code !== "string" || !entry.code.trim()) problems.push(`${id}: no code`);
    } else if (entry.kind === "steps") {
      for (const field of ["steps_zh", "steps_en"]) {
        if (!Array.isArray(entry[field]) || !entry[field].length) problems.push(`${id}: no ${field}`);
      }
    } else {
      problems.push(`${id}: kind must be "code" or "steps"`);
    }
    const text = JSON.stringify([entry.code, entry.steps_zh, entry.steps_en, entry.note_zh, entry.note_en]);
    for (const match of text.matchAll(/\{\{([A-Za-z_]+)\}\}/g)) {
      if (!PLACEHOLDERS.includes(match[1])) problems.push(`${id}: unknown placeholder {{${match[1]}}}`);
    }
    if (!Array.isArray(entry.fields) || !entry.fields.every((name) => PLACEHOLDERS.includes(name))) problems.push(`${id}: fields must list placeholders`);
    else for (const name of entry.fields) if (!text.includes(`{{${name}}}`)) problems.push(`${id}: declares {{${name}}} but does not use it`);
  }
  for (const id of REQUIRED_CLIENT_IDS) if (!seen.has(id)) problems.push(`missing required client ${id}`);
  return problems;
}
