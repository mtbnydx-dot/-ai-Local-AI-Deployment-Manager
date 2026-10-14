"use strict";

// zh/en strings of the platform tooling (docs/overhaul/06-ops.md §6.4):
// { key: { "zh-CN", "en-US" } } with {name} placeholders. Later packages add
// their keys here; a key never carries a flag name on its own.
// Language order: an explicit --lang zh|en, then PLATFORM_LANG, then the
// system locale (a zh* locale gives zh, anything else gives en).

const LANGUAGES = Object.freeze(["zh-CN", "en-US"]);
const DEFAULT_LANGUAGE = "en-US";

const MESSAGES = Object.freeze({
  // Why a component is blocked (the `reason` of blocked{reason}).
  "blocked.registry-invalid": {
    "zh-CN": "组件定义有误，已被禁用：{detail}",
    "en-US": "The component definition is invalid and it is disabled: {detail}",
  },
  "blocked.search-upstream-unreachable": {
    "zh-CN": "联网搜索网关找不到可用的模型入口。请在设置里填写“搜索上游地址”，或开启公网监听或控制台局域网访问。",
    "en-US": "The search gateway has no model endpoint it can reach. Set the search upstream address, or turn on the public listener or LAN access to the console.",
  },
  "blocked.mcp-key-invalid": {
    "zh-CN": "MCP 访问密钥无效（至少需要 32 个字符）。请重新生成。",
    "en-US": "The MCP access key is invalid (it needs at least 32 characters). Generate a new one.",
  },
  "blocked.mcp-search-key-invalid": {
    "zh-CN": "搜索网关访问密钥太短（至少需要 16 个字符）。",
    "en-US": "The search gateway key is too short (it needs at least 16 characters).",
  },
  "blocked.secret-store-unavailable": {
    "zh-CN": "密钥库不可用，无法读取或保存密钥。",
    "en-US": "The secret store is unavailable, so keys cannot be read or saved.",
  },
  // Failures after a component started.
  "failed.mcp-not-loopback": {
    "zh-CN": "MCP 服务没有只绑定本机回环地址，已被停止。",
    "en-US": "The MCP server did not bind to loopback only and was stopped.",
  },
  // Registry problems (errors[].code) for the console and `platform doctor`.
  "registry.unknown_placeholder": {
    "zh-CN": "组件 {id} 使用了未知的占位符：{detail}",
    "en-US": "Component {id} uses an unknown placeholder: {detail}",
  },
  "registry.forbidden_override_field": {
    "zh-CN": "组件 {id} 的覆盖配置不能修改 {detail}，已使用内置定义。",
    "en-US": "The override for component {id} cannot change {detail}; the built-in definition is used.",
  },
  "registry.unknown_component": {
    "zh-CN": "覆盖配置里的组件 {id} 不存在，已忽略。",
    "en-US": "The override names a component {id} that does not exist and is ignored.",
  },
  "registry.stale": {
    "zh-CN": "组件清单的数据日期是 {detail}，已超过建议的更新周期。",
    "en-US": "The component list data is dated {detail}, which is past its suggested refresh period.",
  },
});

function interpolate(text, params) {
  return String(text).replace(/\{(\w+)\}/g, (match, name) => (params && params[name] !== undefined ? String(params[name]) : match));
}

/** "zh", "zh-TW", "zh_CN" -> zh-CN; anything else -> en-US; null when the input says nothing. */
function normalizeLanguage(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  return text.startsWith("zh") ? "zh-CN" : "en-US";
}

function systemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "";
  }
}

/** --lang, then PLATFORM_LANG, then the system locale (§6.4). */
function resolveLanguage({ lang, env = process.env, locale } = {}) {
  return normalizeLanguage(lang) || normalizeLanguage(env.PLATFORM_LANG) || normalizeLanguage(locale ?? systemLocale()) || DEFAULT_LANGUAGE;
}

/** The text for a key; an unknown key comes back as the key so a gap is visible, never a crash. */
function message(key, language, params) {
  const entry = MESSAGES[key];
  if (!entry) return String(key);
  const lang = LANGUAGES.includes(language) ? language : normalizeLanguage(language) || DEFAULT_LANGUAGE;
  return interpolate(entry[lang] || entry[DEFAULT_LANGUAGE], params);
}

/** Both languages at once, for payloads that carry {zh-CN, en-US} (notifications, status reasons). */
function bilingual(key, params) {
  return { "zh-CN": message(key, "zh-CN", params), "en-US": message(key, "en-US", params) };
}

module.exports = {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  MESSAGES,
  normalizeLanguage,
  resolveLanguage,
  message,
  t: message,
  bilingual,
};
