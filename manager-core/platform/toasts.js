"use strict";

// Windows toasts for the supervisor (06 §5.10). The supervisor raises its own
// notifications locally and subscribes to the entry's `notification` stream
// for everyone else's. Envelopes marked `source: "platform"` are the
// supervisor's own, already toasted when they were raised, so they are ignored
// on the way back (the loop guard). `dedupeKey` suppresses repeats for 10 min.
//
// The toast itself is PowerShell WinRT (Windows.UI.Notifications) under the
// PowerShell AUMID, with the text passed in the environment and the script on
// stdin; no dependency, and nothing that needs registration.

const { spawn } = require("node:child_process");
const messages = require("./messages");

const DEDUPE_MS = 10 * 60 * 1000;
const TOAST_SEVERITIES = new Set(["warn", "error"]);
const POWERSHELL_AUMID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/** The PowerShell script for one toast; LAP_TOAST_TITLE and LAP_TOAST_BODY carry the text. */
function buildToastScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
    "$title = [System.Security.SecurityElement]::Escape($env:LAP_TOAST_TITLE)",
    "$body = [System.Security.SecurityElement]::Escape($env:LAP_TOAST_BODY)",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$xml.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>\")",
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_AUMID}').Show($toast)`,
    "",
  ].join("\r\n");
}

function defaultShowToast({ title, body }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
        windowsHide: true, stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, LAP_TOAST_TITLE: title, LAP_TOAST_BODY: body },
      });
    } catch { resolve(false); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 15000);
    timer.unref?.();
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
    child.stdin.on("error", () => {});
    child.stdin.end(buildToastScript());
  });
}

/**
 * createToaster({ now, showToast({title, body}), language, log })
 * -> { shouldToast(data), local(data), remote(envelope), toasted }.
 * `local` is for notifications the supervisor raises itself, `remote` for
 * envelopes from the entry stream.
 */
function createToaster(options = {}) {
  const now = options.now || (() => Date.now());
  const show = options.showToast || defaultShowToast;
  const language = options.language || messages.resolveLanguage({ env: options.env || process.env });
  const log = typeof options.log === "function" ? options.log : () => {};
  const seen = new Map();
  const toasted = [];

  function shouldToast(data) {
    if (!data || typeof data !== "object") return false;
    if (TOAST_SEVERITIES.has(data.severity)) return true;
    return Array.isArray(data.channels) && data.channels.includes("toast");
  }

  function suppressed(data) {
    const key = typeof data.dedupeKey === "string" && data.dedupeKey ? data.dedupeKey : null;
    if (!key) return false;
    const at = now();
    for (const [name, when] of seen) if (at - when >= DEDUPE_MS) seen.delete(name);
    if (seen.has(key)) return true;
    seen.set(key, at);
    return false;
  }

  function text(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    const zh = value.zh ?? value["zh-CN"];
    const en = value.en ?? value["en-US"];
    return String((language === "zh-CN" ? zh ?? en : en ?? zh) ?? "");
  }

  async function raise(data) {
    if (!shouldToast(data) || suppressed(data)) return false;
    const payload = { title: text(data.title), body: text(data.body) };
    toasted.push({ kind: data.kind || null, ...payload });
    try { await show(payload); } catch (error) { log({ code: "toast_failed", message: String(error?.message || error) }); }
    return true;
  }

  return {
    shouldToast,
    toasted,
    local: (data) => raise(data),
    // An envelope the supervisor published itself comes back through the entry; it was toasted when raised.
    remote: (envelope) => (envelope?.source === "platform" || envelope?.type !== "notification" ? Promise.resolve(false) : raise(envelope.data)),
  };
}

module.exports = { DEDUPE_MS, POWERSHELL_AUMID, buildToastScript, createToaster };
