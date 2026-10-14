"use strict";

// Which client program sent a gateway request (04 §5.3), as a stable slug for
// telemetry dimensions. Labels are separate (SOURCE_PROGRAM_LABELS), so the
// console can localise them and access-log.js keeps its Chinese labels.
//
// Order: an X-Title / x-ai-client hint, then the user-agent rules that
// access-log.js has always used (same patterns, same order, including the
// protocol and path checks mixed into them), then the origin host, then a
// browser user agent, then the OpenAI protocol fallback. All of these are
// client-supplied hints, never identity.

const HINT_MAX_LENGTH = 40;
const META_MAX_LENGTH = 240;

const SOURCE_PROGRAM_LABELS = Object.freeze({
  openwebui: { zh: "OpenWebUI", en: "OpenWebUI" },
  chatbox: { zh: "Chatbox", en: "Chatbox" },
  lobechat: { zh: "LobeChat", en: "LobeChat" },
  workbuddy: { zh: "WorkBuddy", en: "WorkBuddy" },
  "claude-code": { zh: "Claude Code", en: "Claude Code" },
  "claude-compat": { zh: "Claude 兼容客户端", en: "Claude-compatible client" },
  opencode: { zh: "OpenCode", en: "OpenCode" },
  "openai-python": { zh: "OpenAI Python SDK", en: "OpenAI Python SDK" },
  "openai-node": { zh: "OpenAI Node SDK", en: "OpenAI Node SDK" },
  "openai-compat": { zh: "OpenAI 兼容客户端", en: "OpenAI-compatible client" },
  python: { zh: "Python 客户端", en: "Python client" },
  curl: { zh: "curl", en: "curl" },
  powershell: { zh: "PowerShell", en: "PowerShell" },
  node: { zh: "Node.js 客户端", en: "Node.js client" },
  go: { zh: "Go 客户端", en: "Go client" },
  java: { zh: "Java/OkHttp 客户端", en: "Java/OkHttp client" },
  "cherry-studio": { zh: "Cherry Studio", en: "Cherry Studio" },
  cursor: { zh: "Cursor", en: "Cursor" },
  browser: { zh: "浏览器客户端", en: "Browser client" },
  unknown: { zh: "未知来源", en: "Unknown source" },
});

const SOURCE_PROGRAMS = Object.freeze(Object.keys(SOURCE_PROGRAM_LABELS));

// Spellings of a known program that the hint normaliser does not already
// turn into its slug.
const HINT_ALIASES = new Map([
  ["open-webui", "openwebui"],
  ["lobe-chat", "lobechat"],
  ["lobehub", "lobechat"],
  ["work-buddy", "workbuddy"],
  ["claude-cli", "claude-code"],
  ["cherrystudio", "cherry-studio"],
  ["cursor-ai", "cursor"],
]);

// The user-agent rules from access-log.js, in their original order. Each
// receives { ua, path, protocol } in lower case.
const USER_AGENT_RULES = [
  ["workbuddy", ({ ua }) => /workbuddy/.test(ua)],
  ["openwebui", ({ ua }) => /open[-_\s]?webui/.test(ua)],
  ["chatbox", ({ ua }) => /chatbox/.test(ua)],
  ["lobechat", ({ ua }) => /lobe[-_\s]?chat|lobehub/.test(ua)],
  ["claude-compat", ({ ua, protocol, path }) => /claude/.test(ua) || protocol === "claude" || path.startsWith("/claude") || path.includes("/claude/")],
  ["opencode", ({ ua, protocol, path }) => /opencode/.test(ua) || protocol === "opencode" || path.includes("/opencode")],
  ["openai-python", ({ ua }) => /openai[-_\s]?python/.test(ua)],
  ["openai-node", ({ ua }) => /openai[-_\s]?(node|js)|openai\/js/.test(ua)],
  ["python", ({ ua }) => /python-requests|httpx|aiohttp|python\//.test(ua)],
  ["curl", ({ ua }) => /curl\//.test(ua)],
  ["powershell", ({ ua }) => /powershell|microsoft powershell/.test(ua)],
  ["node", ({ ua }) => /node\.js|node-fetch|undici|axios/.test(ua)],
  ["go", ({ ua }) => /go-http-client/.test(ua)],
  ["java", ({ ua }) => /okhttp|java\//.test(ua)],
];

function truncateMeta(value, maxLength = META_MAX_LENGTH) {
  return String(value || "").trim().slice(0, maxLength);
}

// Host of an Origin or Referer value; also accepts a bare host.
function originHostOf(value) {
  const text = truncateMeta(value);
  if (!text) return "";
  try {
    return new URL(text).host || text;
  } catch {
    return text.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].slice(0, 160);
  }
}

// An X-Title or x-ai-client value as a slug: lower case, runs of anything
// else than a-z and 0-9 become "-", at most 40 characters. A hint with no
// usable characters (for example CJK only) is ignored.
function normalizeSourceHint(value) {
  const text = String(Array.isArray(value) ? value[0] : value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, HINT_MAX_LENGTH)
    .replace(/-+$/, "");
  return HINT_ALIASES.get(text) || text;
}

function inferSourceProgram(input = {}) {
  const hint = normalizeSourceHint(input.xTitle || input.aiClient || "");
  if (hint) return hint;
  const context = {
    ua: truncateMeta(input.userAgent).toLowerCase(),
    path: String(input.path || "").toLowerCase(),
    protocol: String(input.protocol || "").toLowerCase(),
  };
  const rule = USER_AGENT_RULES.find(([, matches]) => matches(context));
  if (rule) return rule[0];
  if (originHostOf(input.origin || input.referer || "")) return "browser";
  if (/mozilla|chrome|safari|edg\//.test(context.ua)) return "browser";
  if (context.protocol === "openai" || context.path.includes("/serve/v1") || context.path.includes("/openai/")) {
    return "openai-compat";
  }
  return "unknown";
}

// The label for a slug. A browser request with a known origin is labelled
// with that host ("浏览器 · host"). A slug that came from a client hint and
// has no label is shown as the slug itself.
function labelFor(slug, locale = "zh", options = {}) {
  const key = String(slug || "unknown");
  const lang = locale === "en" || String(locale || "").startsWith("en") ? "en" : "zh";
  if (key === "browser") {
    const host = String(options.originHost || "").trim();
    if (host) return lang === "en" ? `Browser · ${host}` : `浏览器 · ${host}`;
  }
  return SOURCE_PROGRAM_LABELS[key]?.[lang] || key;
}

module.exports = {
  SOURCE_PROGRAMS,
  SOURCE_PROGRAM_LABELS,
  normalizeSourceHint,
  inferSourceProgram,
  labelFor,
};
