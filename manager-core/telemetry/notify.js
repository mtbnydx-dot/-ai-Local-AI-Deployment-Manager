"use strict";

// Alert notifier (docs/overhaul/04-telemetry.md §12, §13.3).
//
// createNotifier({ events, webhooks, secretStore, fetch, now, ... }) delivers
// what the alert engine decides to say:
//
// - inapp: events.publish("alerts", { action, alert }) plus
//   events.publish("notification", { kind, severity, title, body, action,
//   channels, dedupeKey }). The notification follows the 00 section 9.6
//   envelope; channels and dedupeKey are 04's additions (contract change C3).
//   Nothing else is ever published here.
// - toast: the same notification with "toast" in channels. Windows toasts are
//   shown by the supervisor, which subscribes as the machine principal
//   system:supervisor; toastChannel() reports whether that principal is
//   connected, counted by the event bus from the authenticated principal, never
//   from anything the client sends.
// - webhook: POST per configured hook (generic, feishu, dingtalk, wecom,
//   slack), 5 s timeout, redirect "manual", retries after 1 s, 5 s and 30 s.
//   Signing secrets are read per delivery from the "webhooks" namespace of the
//   secret store and never copied into a payload, an event, a log line or an
//   error. Webhook URLs can carry tokens, so only the host is ever reported.
//
// At most 20 notifications per hour go out per channel (and per webhook);
// the rest are counted and later announced by one summary notification.

const crypto = require("node:crypto");
const dns = require("node:dns");
const net = require("node:net");
const { redactSecrets } = require("../secret-redactor");

const SECRET_NAMESPACE = "webhooks";
const DEFAULT_CONSOLE_BASE = "http://127.0.0.1:5176";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([1000, 5000, 30_000]);
const DEFAULT_RATE_PER_HOUR = 20;
const HOUR_MS = 3_600_000;
const SUPERVISOR_PRINCIPAL = "system:supervisor";
const SEVERITY_RANK = Object.freeze({ info: 1, warning: 2, critical: 3 });
const FORMATS = Object.freeze(["generic", "feishu", "dingtalk", "wecom", "slack"]);
const NOTIFICATION_SEVERITY = Object.freeze({ critical: "error", warning: "warn", info: "info" });
const USER_AGENT = "local-ai-platform-alerts/1";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// --- SSRF guard (§13.3) ------------------------------------------------------------------

function unsafe(message) {
  const error = new Error(message);
  error.code = "unsafe_webhook_url";
  return error;
}

function ipv6Groups(text) {
  // Expands an IPv6 literal (without brackets or zone) into eight 16-bit groups.
  let address = text.split("%")[0];
  let tail = [];
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (embedded) {
    const octets = embedded[1].split(".").map(Number);
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    address = address.slice(0, embedded.index) + "0:0";
  }
  const halves = address.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const fill = new Array(Math.max(0, 8 - head.length - rest.length)).fill("0");
  const groups = (halves.length > 1 ? [...head, ...fill, ...rest] : head).map((part) => parseInt(part || "0", 16));
  if (tail.length) {
    groups.splice(6, 2, ...tail);
  }
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/**
 * classifyAddress(ip) → "loopback" | "link-local" | "" for an IPv4 or IPv6
 * literal. IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are judged by the
 * IPv4 address inside; 0.0.0.0 and :: count as loopback because a connection
 * to them reaches this machine.
 */
function classifyAddress(address) {
  const text = String(address || "").trim().replace(/^\[|\]$/g, "");
  const family = net.isIP(text.split("%")[0]);
  if (family === 4) {
    const octets = text.split(".").map(Number);
    if (octets[0] === 127 || octets.every((octet) => octet === 0)) return "loopback";
    if (octets[0] === 169 && octets[1] === 254) return "link-local";
    return "";
  }
  if (family === 6) {
    const groups = ipv6Groups(text);
    if (!groups) return "";
    if (groups.every((group) => group === 0)) return "loopback";
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return "loopback";
    if ((groups[0] & 0xffc0) === 0xfe80) return "link-local";
    const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
    if (mapped) {
      return classifyAddress(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
    }
  }
  return "";
}

function isLoopbackName(host) {
  const name = String(host || "").toLowerCase().replace(/\.+$/, "");
  return name === "localhost" || name.endsWith(".localhost");
}

/**
 * assertSafeWebhookUrl(url, { allowLoopback }) → URL
 * Allows only http or https, rejects userinfo, link-local addresses
 * (169.254.0.0/16, fe80::/10) and loopback unless allowLoopback is true.
 * Throws an Error with code "unsafe_webhook_url"; the message never repeats
 * the URL, which may carry a token.
 */
function assertSafeWebhookUrl(raw, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    throw unsafe("The webhook URL is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw unsafe("The webhook URL must use http or https.");
  if (parsed.username || parsed.password) throw unsafe("The webhook URL must not contain a user name or password.");
  // WHATWG parsing already turns 2852039166 or 0xa9fea9fe into 169.254.169.254.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const kind = classifyAddress(host);
  if (kind === "link-local") throw unsafe("The webhook URL must not point at a link-local address.");
  if ((kind === "loopback" || isLoopbackName(host)) && options.allowLoopback !== true) throw unsafe("The webhook URL must not point at this machine.");
  return parsed;
}

// A hostname is also checked after DNS resolution, so a name that points at a
// link-local or loopback address is refused as well.
async function assertSafeResolved(parsed, lookup, allowLoopback) {
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return;
  let addresses;
  try {
    addresses = await lookup(host);
  } catch {
    const error = new Error("The webhook host could not be resolved.");
    error.code = "dns_failed";
    throw error;
  }
  for (const entry of Array.isArray(addresses) ? addresses : [addresses]) {
    const address = typeof entry === "string" ? entry : entry && entry.address;
    const kind = classifyAddress(address);
    if (kind === "link-local" || (kind === "loopback" && !allowLoopback)) throw unsafe("The webhook host resolves to an address that is not allowed.");
  }
}

function defaultLookup(host) {
  return dns.promises.lookup(host, { all: true });
}

// --- formats (§13.3) ------------------------------------------------------------------------

// {zh, en}, or one string that stands for both.
function titleOf(title) {
  if (typeof title === "string") return { zh: title, en: title };
  return { zh: String(title && title.zh || ""), en: String(title && title.en || "") };
}

// "zh / en", or the text once when both languages are the same.
function titleText(title) {
  return title.zh === title.en ? title.zh : `${title.zh} / ${title.en}`;
}

function iso(value) {
  if (finite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}

function absoluteLink(link, base) {
  const text = String(link || "");
  if (/^https?:\/\//i.test(text)) return text;
  if (!text.startsWith("/")) return text || null;
  return `${String(base || DEFAULT_CONSOLE_BASE).replace(/\/+$/, "")}${text}`;
}

// The alert as webhooks see it. No addresses, key ids or request bodies are
// ever part of it: `detail` (masked addresses) is not copied.
function webhookAlert(alert, options = {}) {
  const at = finite(alert.at) ? alert.at : (finite(options.now) ? options.now : Date.now());
  return {
    event: String(options.event || alert.event || "alert.firing"),
    ruleId: String(alert.ruleId || ""),
    severity: SEVERITY_RANK[alert.severity] ? alert.severity : "info",
    scope: String(alert.scopeKey || alert.scope || "*"),
    title: titleOf(alert.title),
    value: finite(alert.value) ? alert.value : null,
    threshold: finite(alert.threshold) ? alert.threshold : null,
    since: iso(alert.since) || iso(at),
    at: iso(at),
    link: absoluteLink(alert.link, options.consoleBase),
  };
}

function numberText(value) {
  return value === null ? "-" : String(Math.round(value * 10_000) / 10_000);
}

function chatText(a) {
  const head = a.event === "alert.resolved" ? "[RESOLVED]" : a.event === "alert.test" ? "[TEST]" : a.event === "alert.summary" ? "[SUMMARY]" : "[FIRING]";
  return [
    `${head}[${a.severity}] ${titleText(a.title)}`,
    `rule: ${a.ruleId} | scope: ${a.scope} | value: ${numberText(a.value)} | threshold: ${numberText(a.threshold)}`,
    `since: ${a.since}`,
    ...(a.link ? [a.link] : []),
  ].join("\n");
}

function hmacHex(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function jsonHeaders(extra = {}) {
  return { "content-type": "application/json; charset=utf-8", "user-agent": USER_AGENT, ...extra };
}

/**
 * formatWebhook(format, alert, { secret, now, url, event, consoleBase }) →
 *   { url, headers, body }
 * `body` is the exact JSON text that is sent (and that the generic signature
 * covers). With a secret the generic, WeCom and Slack bodies carry
 * `x-ai-signature: sha256=<hex HMAC-SHA256(secret, body)>`; Feishu and
 * DingTalk use their native timestamp signing (the Feishu body gets
 * timestamp and sign, the DingTalk URL gets timestamp and sign parameters).
 * WeCom group robots have no signing scheme of their own.
 */
function formatWebhook(format, alert, options = {}) {
  if (!FORMATS.includes(format)) {
    const error = new Error("Unknown webhook format.");
    error.code = "unknown_webhook_format";
    throw error;
  }
  const a = webhookAlert(alert, options);
  const secret = typeof options.secret === "string" ? options.secret : "";
  const clock = finite(options.now) ? options.now : Date.now();
  const url = options.url || "";
  if (format === "generic") {
    const body = JSON.stringify({
      version: 1,
      event: a.event,
      ruleId: a.ruleId,
      severity: a.severity,
      scope: a.scope,
      title: titleText(a.title),
      value: a.value,
      threshold: a.threshold,
      since: a.since,
      at: a.at,
      link: a.link,
    });
    return { url, headers: jsonHeaders(secret ? { "x-ai-signature": `sha256=${hmacHex(secret, body)}` } : {}), body };
  }
  const text = chatText(a);
  if (format === "feishu") {
    const timestamp = String(Math.floor(clock / 1000));
    const signed = secret
      ? { timestamp, sign: crypto.createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64") }
      : {};
    return { url, headers: jsonHeaders(), body: JSON.stringify({ ...signed, msg_type: "text", content: { text } }) };
  }
  if (format === "dingtalk") {
    let target = url;
    if (secret) {
      const timestamp = String(clock);
      const sign = crypto.createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
      const parsed = new URL(url);
      parsed.searchParams.set("timestamp", timestamp);
      parsed.searchParams.set("sign", sign);
      target = parsed.toString();
    }
    return { url: target, headers: jsonHeaders(), body: JSON.stringify({ msgtype: "text", text: { content: text } }) };
  }
  const body = format === "wecom"
    ? JSON.stringify({ msgtype: "text", text: { content: text } })
    : JSON.stringify({ text });
  return { url, headers: jsonHeaders(secret ? { "x-ai-signature": `sha256=${hmacHex(secret, body)}` } : {}), body };
}

// --- the notifier ---------------------------------------------------------------------------

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (handle && typeof handle.unref === "function") handle.unref();
  });
}

function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return "";
  }
}

/**
 * createNotifier({ events, webhooks, secretStore, fetch, now, lookup, sleep,
 *   record, logger, consoleBase, allowLoopback, perHour, timeoutMs,
 *   retryDelaysMs }) →
 *   { notify(alert, options), test(request), toastChannel(), flush(), idle(),
 *     stats(), close() }
 * - events: the entry event bus ({publish, subscriberCount}).
 * - webhooks: the configured hooks, or a function returning them
 *   ([{id, url, format, minSeverity}], telemetry.alerts.webhooks).
 * - secretStore: manager-core/secret-store.js (get/has by namespace and key).
 * - record(event): stores an alert.* event row (alert.notify_failed).
 */
function createNotifier(options = {}) {
  const events = options.events || null;
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : (typeof fetch === "function" ? fetch : null);
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const lookup = typeof options.lookup === "function" ? options.lookup : defaultLookup;
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  const logger = options.logger === undefined ? console : options.logger;
  const consoleBase = options.consoleBase || DEFAULT_CONSOLE_BASE;
  const allowLoopback = options.allowLoopback === true;
  const perHour = finite(options.perHour) && options.perHour >= 1 ? Math.floor(options.perHour) : DEFAULT_RATE_PER_HOUR;
  const timeoutMs = finite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const retryDelays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;

  const sent = new Map();
  const held = new Map();
  const pending = new Set();
  const counters = { published: 0, webhooksSent: 0, webhooksFailed: 0, coalesced: 0 };
  let closed = false;

  function warn(line) {
    if (!logger) return;
    try {
      (typeof logger.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(`alerts: ${line}`));
    } catch {
      // Logging never breaks a notification.
    }
  }

  function publish(type, data) {
    if (!events || typeof events.publish !== "function") return null;
    try {
      const envelope = events.publish(type, data, { source: "telemetry" });
      if (envelope) counters.published += 1;
      return envelope;
    } catch (error) {
      warn(`${type} was not published (${(error && error.code) || "error"})`);
      return null;
    }
  }

  function hooks() {
    const list = typeof options.webhooks === "function" ? options.webhooks() : options.webhooks;
    return (Array.isArray(list) ? list : []).filter((hook) => isPlainObject(hook) && hook.id && hook.url);
  }

  // --- rate limit: 20 per hour per channel ---

  function window(key, t) {
    const list = (sent.get(key) || []).filter((at) => t - at < HOUR_MS);
    sent.set(key, list);
    return list;
  }

  function consume(key, t) {
    const list = window(key, t);
    if (list.length >= perHour) {
      held.set(key, (held.get(key) || 0) + 1);
      counters.coalesced += 1;
      return false;
    }
    list.push(t);
    return true;
  }

  // --- in-app and toast ---

  function publicAlert(alert) {
    const out = {
      ruleId: String(alert.ruleId || ""),
      scopeKey: String(alert.scopeKey || "*"),
      severity: SEVERITY_RANK[alert.severity] ? alert.severity : "info",
      title: titleOf(alert.title),
      value: finite(alert.value) ? alert.value : null,
      threshold: finite(alert.threshold) ? alert.threshold : null,
      since: iso(alert.since),
      link: String(alert.link || ""),
    };
    // Masked addresses only (the engine's SQL masks them at the source).
    if (isPlainObject(alert.detail)) out.detail = alert.detail;
    return out;
  }

  function notificationFor(alert, action, channels, extra = {}) {
    const resolved = action === "resolved";
    const value = numberText(finite(alert.value) ? alert.value : null);
    const threshold = numberText(finite(alert.threshold) ? alert.threshold : null);
    const key = String(alert.link || "").startsWith("/") ? String(alert.link) : `/#/observability/alerts?rule=${encodeURIComponent(alert.ruleId || "")}`;
    return {
      kind: extra.kind || `alert.${action}`,
      severity: resolved ? "success" : NOTIFICATION_SEVERITY[alert.severity] || "info",
      title: { zh: `${resolved ? "已恢复：" : ""}${titleOf(alert.title).zh}`, en: `${resolved ? "Resolved: " : ""}${titleOf(alert.title).en}` },
      body: resolved
        ? { zh: `当前值 ${value}，已回到阈值 ${threshold} 之内。`, en: `Value ${value} is back within the threshold of ${threshold}.` }
        : { zh: `当前值 ${value}，阈值 ${threshold}。`, en: `Value ${value}, threshold ${threshold}.` },
      action: { label: { zh: "查看告警", en: "View alert" }, href: key },
      channels,
      dedupeKey: extra.dedupeKey || `alert:${alert.ruleId}:${alert.scopeKey}:${action}:${resolved ? alert.at : (finite(alert.firedAt) ? alert.firedAt : alert.since)}`,
    };
  }

  // Publishes one notification for the channels that still have room this
  // hour and returns them.
  function sendInapp(alert, action, wanted, t, extra) {
    const channels = wanted.filter((channel) => consume(channel, t));
    if (channels.length) publish("notification", notificationFor(alert, action, channels, extra));
    return channels;
  }

  // --- webhooks ---

  async function readSecret(hook) {
    const store = options.secretStore;
    if (!store) return "";
    let has = false;
    try {
      has = Boolean(await store.has(SECRET_NAMESPACE, hook.id));
    } catch {
      throw Object.assign(new Error("secret store unavailable"), { code: "secret_unavailable" });
    }
    if (!has) return "";
    let value = "";
    try {
      value = await store.get(SECRET_NAMESPACE, hook.id);
    } catch {
      throw Object.assign(new Error("secret store unavailable"), { code: "secret_unavailable" });
    }
    if (typeof value !== "string" || !value) throw Object.assign(new Error("secret store unavailable"), { code: "secret_unavailable" });
    return value;
  }

  async function recordFailure(hook, alert, reason, detail = {}) {
    counters.webhooksFailed += 1;
    warn(`webhook ${hook.id} was not delivered (${reason})`);
    if (typeof options.record !== "function") return;
    const t = clock();
    try {
      await options.record({
        at: t,
        source: "entry",
        type: "alert.notify_failed",
        severity: "warning",
        title: `Alert notification failed: webhook ${hook.id}`,
        data: { webhookId: String(hook.id), format: String(hook.format || "generic"), reason, host: hostOf(hook.url), ruleId: alert.ruleId, scopeKey: alert.scopeKey, ...detail },
        dedupeKey: `alert.notify_failed:${hook.id}:${alert.ruleId}:${alert.scopeKey}:${t}`,
      });
    } catch {
      // The failure is already logged; an event that cannot be stored is dropped.
    }
  }

  // One attempt. Returns { ok } or { ok:false, reason, retry, status? }.
  async function attempt(hook, built, parsed) {
    try {
      await assertSafeResolved(parsed, lookup, allowLoopback);
      const response = await fetchImpl(built.url, {
        method: "POST",
        headers: built.headers,
        body: built.body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const status = Number(response && response.status);
      if (response && typeof response.body === "object" && response.body && typeof response.body.cancel === "function") {
        response.body.cancel().catch(() => {});
      }
      if (status >= 200 && status < 300) return { ok: true, status };
      if ((status >= 300 && status < 400) || (response && response.type === "opaqueredirect")) return { ok: false, reason: "redirect_blocked", retry: false, status };
      if (status === 429 || status >= 500) return { ok: false, reason: `http_${status}`, retry: true, status };
      return { ok: false, reason: `http_${status || 0}`, retry: false, status };
    } catch (error) {
      const code = String((error && error.code) || "");
      if (code === "unsafe_webhook_url") return { ok: false, reason: "unsafe_url", retry: false };
      const timedOut = (error && (error.name === "TimeoutError" || error.name === "AbortError")) || code === "ABORT_ERR";
      return { ok: false, reason: timedOut ? "timeout" : code === "dns_failed" ? "dns_failed" : "network_error", retry: true };
    }
  }

  async function deliver(hook, alert, event) {
    let parsed;
    try {
      parsed = assertSafeWebhookUrl(hook.url, { allowLoopback });
    } catch {
      await recordFailure(hook, alert, "unsafe_url");
      return { ok: false, reason: "unsafe_url" };
    }
    if (!FORMATS.includes(hook.format || "generic")) {
      await recordFailure(hook, alert, "unknown_format");
      return { ok: false, reason: "unknown_format" };
    }
    if (!fetchImpl) {
      await recordFailure(hook, alert, "no_transport");
      return { ok: false, reason: "no_transport" };
    }
    let secret;
    try {
      secret = await readSecret(hook);
    } catch {
      await recordFailure(hook, alert, "secret_unavailable");
      return { ok: false, reason: "secret_unavailable" };
    }
    let last = { ok: false, reason: "network_error" };
    for (let index = 0; index <= retryDelays.length; index += 1) {
      if (closed) return { ok: false, reason: "closed" };
      // The signature timestamp is taken per attempt, so a retry is not stale.
      const built = formatWebhook(hook.format || "generic", alert, { secret, now: clock(), url: parsed.toString(), event, consoleBase });
      last = await attempt(hook, built, parsed);
      if (last.ok) {
        counters.webhooksSent += 1;
        return last;
      }
      if (!last.retry || index === retryDelays.length) break;
      await sleep(retryDelays[index]);
    }
    await recordFailure(hook, alert, last.reason, { attempts: retryDelays.length + 1, ...(last.status ? { status: last.status } : {}) });
    return last;
  }

  function track(promise) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  }

  function sendWebhooks(alert, event, t, only = null) {
    const rank = SEVERITY_RANK[alert.severity] || 1;
    const jobs = [];
    for (const hook of hooks()) {
      if (only && hook.id !== only) continue;
      if ((SEVERITY_RANK[hook.minSeverity || "warning"] || 2) > rank && !only) continue;
      if (!only && !consume(`webhook:${hook.id}`, t)) continue;
      jobs.push(track(deliver(hook, alert, event)));
    }
    return jobs;
  }

  // --- public API ---

  /**
   * notify(alert, { action, channels, silenced, renotify }): action is
   * "firing", "resolved" or "acked". A silenced alert still updates the
   * `alerts` stream (state, not a notification); an ack never notifies.
   */
  async function notify(alert, notifyOptions = {}) {
    if (closed || !isPlainObject(alert)) return { inapp: false, toast: false, webhooks: 0 };
    const action = ["firing", "resolved", "acked"].includes(notifyOptions.action) ? notifyOptions.action : "firing";
    const channels = Array.isArray(notifyOptions.channels) ? notifyOptions.channels : [];
    const t = clock();
    const result = { inapp: false, toast: false, webhooks: 0 };
    if (channels.includes("inapp") && !notifyOptions.renotify) {
      publish("alerts", { action, alert: publicAlert(alert) });
    }
    if (notifyOptions.silenced || action === "acked") return result;
    const wanted = ["inapp", "toast"].filter((channel) => channels.includes(channel));
    if (wanted.length) {
      const used = sendInapp(alert, action, wanted, t, notifyOptions.renotify ? { dedupeKey: `alert:${alert.ruleId}:${alert.scopeKey}:renotify:${t}` } : undefined);
      result.inapp = used.includes("inapp");
      result.toast = used.includes("toast");
    }
    if (channels.includes("webhook")) {
      result.webhooks = sendWebhooks(alert, `alert.${action}`, t).length;
    }
    return result;
  }

  // The owner's "send a test" (POST /api/telemetry/alerts/test). It is not
  // counted against the hourly cap.
  async function test(request = {}) {
    const channel = String(request.channel || "");
    const t = clock();
    const alert = {
      ruleId: "test",
      scopeKey: "*",
      severity: "info",
      title: { zh: "测试通知", en: "Test notification" },
      value: null,
      threshold: null,
      since: t,
      at: t,
      link: "/#/observability/alerts",
    };
    if (channel === "inapp" || channel === "toast") {
      const available = channel === "toast" ? toastChannel() === "available" : true;
      const body = notificationFor(alert, "test", [channel], { kind: "alert.test", dedupeKey: `alert:test:${channel}:${t}` });
      body.body = { zh: "这是一条测试通知。", en: "This is a test notification." };
      body.action = { label: { zh: "打开告警", en: "Open alerts" }, href: "/#/observability/alerts" };
      const envelope = publish("notification", body);
      if (!envelope) return { ok: false, delivered: false, error: "publish_failed" };
      return available ? { ok: true, delivered: true } : { ok: true, delivered: false, error: "no_subscriber" };
    }
    if (channel === "webhook") {
      const id = String(request.webhookId || "");
      const hook = hooks().find((item) => item.id === id);
      if (!hook) return { ok: false, delivered: false, error: "webhook_not_found" };
      const outcome = await deliver(hook, alert, "alert.test");
      return outcome.ok ? { ok: true, delivered: true } : { ok: false, delivered: false, error: outcome.reason };
    }
    return { ok: false, delivered: false, error: "unknown_channel" };
  }

  function toastChannel() {
    if (!events || typeof events.subscriberCount !== "function") return "no_subscriber";
    try {
      return events.subscriberCount({ principal: SUPERVISOR_PRINCIPAL, types: ["notification"] }) > 0 ? "available" : "no_subscriber";
    } catch {
      return "no_subscriber";
    }
  }

  // One summary for what the hourly cap held back, sent when the channel has room again.
  async function flush() {
    const t = clock();
    for (const [key, count] of [...held]) {
      if (!count || window(key, t).length >= perHour) continue;
      held.delete(key);
      window(key, t).push(t);
      const summary = {
        ruleId: "summary",
        scopeKey: "*",
        severity: "info",
        title: { zh: `有 ${count} 条告警通知已合并`, en: `${count} alert notifications were combined` },
        value: count,
        threshold: null,
        since: t,
        at: t,
        link: "/#/observability/alerts",
      };
      if (key.startsWith("webhook:")) {
        const hook = hooks().find((item) => `webhook:${item.id}` === key);
        if (hook) track(deliver(hook, summary, "alert.summary"));
      } else {
        const body = notificationFor(summary, "summary", [key], { kind: "alert.summary", dedupeKey: `alert:summary:${key}:${t}` });
        body.body = { zh: "上一小时内的通知超过上限，已合并为本条。请打开告警页查看全部。", en: "More notifications than the hourly limit came in; they are combined here. Open the alerts page to see them all." };
        publish("notification", body);
      }
    }
  }

  async function idle() {
    while (pending.size) {
      await Promise.allSettled([...pending]);
    }
  }

  function stats() {
    return { ...counters, pending: pending.size, held: Object.fromEntries(held) };
  }

  function close() {
    closed = true;
    return idle();
  }

  return { notify, test, toastChannel, flush, idle, stats, close };
}

module.exports = {
  DEFAULT_RATE_PER_HOUR,
  FORMATS,
  SECRET_NAMESPACE,
  SUPERVISOR_PRINCIPAL,
  assertSafeWebhookUrl,
  classifyAddress,
  createNotifier,
  formatWebhook,
};
