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
  // Supervisor notifications (06 §5.10): {label} is the component's label.
  "notify.component.failed.title": {
    "zh-CN": "{label}反复退出，已停止自动重启",
    "en-US": "{label} keeps exiting and is no longer restarted",
  },
  "notify.component.failed.body": {
    "zh-CN": "{label}已自动重启 {count} 次（{windowMin} 分钟内）仍然失败。最后一次退出原因：{reason}。请查看它的日志后手动启动。",
    "en-US": "{label} was restarted {count} times within {windowMin} minutes and still failed. Last exit: {reason}. Check its log, then start it manually.",
  },
  "notify.component.recovered.title": {
    "zh-CN": "{label}已恢复",
    "en-US": "{label} recovered",
  },
  "notify.component.recovered.body": {
    "zh-CN": "{label}在自动重启后重新就绪。",
    "en-US": "{label} is ready again after an automatic restart.",
  },
  "notify.restart.executed.title": {
    "zh-CN": "已执行排队的重启：{label}",
    "en-US": "Queued restart done: {label}",
  },
  "notify.restart.executed.body": {
    "zh-CN": "平台空闲后，{label}已按计划重启。",
    "en-US": "{label} was restarted as planned once the platform was idle.",
  },
  "notify.restart.overdue.title": {
    "zh-CN": "{label}的重启一直在等待空闲",
    "en-US": "{label} is still waiting to restart",
  },
  "notify.restart.overdue.body": {
    "zh-CN": "排队的重启已等待超过 {hours} 小时，因为平台一直忙碌（{blockers}）。它仍在排队；也可以在空闲时手动重启。",
    "en-US": "The queued restart has waited more than {hours} hours because the platform stayed busy ({blockers}). It is still queued; you can also restart it manually when convenient.",
  },
  // Restore, nightly, backup and re-exec notifications (06 §5.10, §5.12, §11).
  "notify.restore.offer.title": {
    "zh-CN": "上次使用的模型尚未运行",
    "en-US": "Your last models are not running",
  },
  "notify.restore.offer.body": {
    "zh-CN": "{count} 个上次运行的模型当前没有启动。需要时可以一键启动，平台不会替换正在运行的模型。",
    "en-US": "{count} model(s) from your last session are not running. Start them with one click; running models are never replaced.",
  },
  "notify.restore.conflict.title": {
    "zh-CN": "{model} 未恢复",
    "en-US": "{model} was not restored",
  },
  "notify.restore.conflict.body": {
    "zh-CN": "{model} 未恢复：目标实例正在运行其他模型。平台不会自动替换，请到部署页手动处理。",
    "en-US": "{model} was not restored: its instance is running another model. The platform never replaces it automatically; replace it from Deployments if you want to.",
  },
  "notify.restore.blocked.title": {
    "zh-CN": "恢复模型已停止",
    "en-US": "Model restore stopped",
  },
  "notify.restore.blocked.body": {
    "zh-CN": "显存不足，已停止恢复其余模型。",
    "en-US": "Not enough GPU memory. Restoring the remaining models was stopped.",
  },
  "notify.nightly.failed.title": {
    "zh-CN": "夜间自检失败",
    "en-US": "The nightly check failed",
  },
  "notify.nightly.failed.body": {
    "zh-CN": "夜间自检已连续 {n} 晚失败（自 {date} 起）。",
    "en-US": "The nightly check has failed {n} nights in a row (since {date}).",
  },
  "notify.backup.stale.title": {
    "zh-CN": "备份已过期",
    "en-US": "The backup is out of date",
  },
  "notify.backup.stale.body": {
    "zh-CN": "最近一次备份是 {hours} 小时前，超过 36 小时。",
    "en-US": "The newest backup is {hours} hours old, more than 36 hours.",
  },
  "notify.supervisor.reexec.title": {
    "zh-CN": "监督进程已重新执行",
    "en-US": "The supervisor re-executed",
  },
  "notify.supervisor.reexec.body": {
    "zh-CN": "监督进程已换成新版本，组件没有受到影响。",
    "en-US": "The supervisor was replaced by a newer one. Components were not touched.",
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
