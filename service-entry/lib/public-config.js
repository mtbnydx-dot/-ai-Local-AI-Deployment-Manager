"use strict";

// Access configuration adapter (docs/overhaul/05-public.md §3.4).
//
// 06 OPS-3 owns platform.json: the schema, the env-to-key map, precedence
// (env > file > default), etags and the only writer. This module has no
// config-file code of its own. It reads through readSection(name) and writes
// through writeSection(name, patch, { etag }), both injected, and turns the
// five sections 05 consumes (listeners, admin, trustedProxies, exposure,
// public) into one frozen AccessConfig with parsed CIDRs and the derived
// facts the listeners and the trust decisions need.
//
// ACCESS_SCHEMA_LEAVES is the `public` fragment 05 contributes to OPS-3's
// schema (manager-core/data/platform-config.d/public.schema.json); a test
// keeps the two equal. The listeners, admin, trustedProxies and exposure
// leaves live in OPS-3's core schema file.
//
// Reads never throw: an invalid value falls back to its default and is
// reported in issues[]. Writes never throw for a refused change; OPS-3's
// refusals (409 config_conflict and friends) pass through unchanged.

const net = require("node:net");
const { parseCidrList } = require("./trusted-proxy");
const { normalizeIp } = require("./key-policy");

const READ_SECTIONS = Object.freeze(["listeners", "admin", "trustedProxies", "exposure", "public"]);
const WRITABLE_SECTIONS = Object.freeze(["listeners", "admin", "trustedProxies", "public"]);
const DEFAULT_TTL_MS = 2000;
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*"]);

function copy(zh, en) {
  return { "zh-CN": zh, "en-US": en };
}

// One leaf of the fragment, in OPS-3's dialect (06 §4.2). Every 05 leaf is
// applied live (the adapter re-reads), so restartRequired is false.
function leaf(spec, title, description, extra = {}) {
  return { ...spec, title, description, ...extra, restartRequired: false, secret: false, group: "access" };
}

function intLeaf(minimum, maximum, value, title, description, extra) {
  return leaf({ type: "integer", minimum, maximum, default: value }, title, description, extra);
}

function boolLeaf(value, title, description, extra) {
  return leaf({ type: "boolean", default: value }, title, description, extra);
}

function branch(properties) {
  return { type: "object", properties };
}

const ENTRY_ONLY = ["entry"];

/** The `public` namespace fragment 05 adds to OPS-3's schema (§3.4). */
const ACCESS_SCHEMA_LEAVES = {
  schemaVersion: 1,
  namespace: "public",
  owner: "05-public",
  asOf: "2026-10-14",
  staleAfterDays: 365,
  title: copy("公网服务", "Public service"),
  properties: {
    extraHosts: leaf(
      { type: "array", items: { type: "string", format: "hostname" }, default: [] },
      copy("额外允许的公网主机名", "Extra public host names"),
      copy("除公网地址中的域名外，公网监听端口还接受这些主机名，例如反向代理使用的其他域名。", "Host names the public listener accepts besides the one in the public address, such as another domain your reverse proxy uses."),
      { env: ["SERVICE_ENTRY_ALLOWED_HOSTS"], envParse: "csv", consumers: ENTRY_ONLY },
    ),
    brand: branch({
      "zh-CN": leaf(
        { type: "string", pattern: "^[^\\u0000-\\u001f]{1,60}$", default: "本地模型服务" },
        copy("门户名称（中文）", "Portal name (Chinese)"),
        copy("公网门户中文界面显示的服务名称。", "The service name the public portal shows in Chinese."),
      ),
      "en-US": leaf(
        { type: "string", pattern: "^[^\\u0000-\\u001f]{1,60}$", default: "Local Model Service" },
        copy("门户名称（英文）", "Portal name (English)"),
        copy("公网门户英文界面显示的服务名称。", "The service name the public portal shows in English."),
      ),
    }),
    catalog: branch({
      publish: leaf(
        { type: "array", items: { type: "string", pattern: "^[^\\s,]{1,200}$" }, default: ["*"] },
        copy("公开的模型", "Published models"),
        copy("公网门户的模型目录和状态页列出哪些模型，可用 * 通配，例如 qwen*；只写 * 表示全部。", "Which models the public catalog and status page list. Patterns may use *, for example qwen*; * alone lists every model."),
      ),
      showPrices: boolLeaf(true,
        copy("公开显示价格", "Show prices publicly"),
        copy("在公网模型目录中显示每个模型的计费价格。", "Show each model's prices in the public model catalog.")),
      allowColdStart: boolLeaf(false,
        copy("允许公网请求唤醒模型", "Let public requests start models"),
        copy("公网请求指向已休眠或未运行的模型时，是否允许自动唤醒或启动它。关闭时返回“模型未就绪”。", "Whether a public request for a sleeping or stopped model may wake or start it. When off, the request gets a model-not-ready error.")),
    }),
    defaults: branch({
      rpm: intLeaf(1, 100000, 60,
        copy("每个密钥默认每分钟请求数", "Default requests per minute per key"),
        copy("公网密钥没有单独设置时，每分钟最多可发送的请求数。", "How many requests per minute a public key may send when it has no limit of its own.")),
      tpm: intLeaf(1, 100000000, 200000,
        copy("每个密钥默认每分钟令牌数", "Default tokens per minute per key"),
        copy("公网密钥没有单独设置时，每分钟最多可使用的输入加输出令牌数。", "How many input plus output tokens per minute a public key may use when it has no limit of its own.")),
      maxConcurrent: intLeaf(1, 256, 2,
        copy("每个密钥默认并发请求数", "Default concurrent requests per key"),
        copy("公网密钥没有单独设置时，同时进行中的请求上限。", "How many requests a public key may have in flight at once when it has no limit of its own.")),
      maxQueued: intLeaf(0, 1024, 4,
        copy("每个密钥默认排队请求数", "Default queued requests per key"),
        copy("达到并发上限后，公网密钥最多可排队等待的请求数。", "How many requests a public key may have waiting once it reaches its concurrency limit.")),
      queueTimeoutSeconds: intLeaf(1, 600, 30,
        copy("默认排队等待时间（秒）", "Default queue wait (seconds)"),
        copy("排队的公网请求最多等待的秒数，超时后返回繁忙错误。", "How many seconds a queued public request waits at most before it gets a busy error.")),
      maxOutputTokens: intLeaf(1, 1048576, 8192,
        copy("默认单次最大输出令牌数", "Default output token limit per request"),
        copy("公网密钥没有单独设置时，单个请求最多可生成的输出令牌数。", "The largest output a single public request may ask for when its key has no limit of its own.")),
    }),
    share: branch({
      maxConcurrent: intLeaf(1, 256, 4,
        copy("公网总并发请求数", "Public concurrent requests in total"),
        copy("所有公网密钥合计同时进行中的请求上限，为本机自用保留算力。", "How many public requests may be in flight at once across all keys, so the owner keeps capacity.")),
      maxQueued: intLeaf(0, 4096, 16,
        copy("公网总排队请求数", "Public queued requests in total"),
        copy("所有公网密钥合计最多可排队等待的请求数。", "How many public requests may wait in total across all keys.")),
      queueTimeoutSeconds: intLeaf(1, 600, 30,
        copy("公网排队等待时间（秒）", "Public queue wait (seconds)"),
        copy("等待公网总并发名额的请求最多等待的秒数。", "How many seconds a request waiting for a public slot waits at most.")),
      ownerActiveMaxConcurrent: intLeaf(0, 256, 2,
        copy("本机使用时的公网并发数", "Public concurrency while the owner is active"),
        copy("本机或控制台正在使用模型时，公网总并发请求降到这个数；它不能大于公网总并发请求数。", "While the owner or the console is using the models, public requests in flight drop to this number. It cannot exceed the public total.")),
    }),
    preAuth: branch({
      rpm: intLeaf(1, 100000, 120,
        copy("验证前每个 IP 每分钟请求数", "Requests per minute per IP before the key check"),
        copy("验证密钥之前，每个来源 IP 每分钟最多可发送的请求数，用于拖慢扫描。", "How many requests per minute one source IP may send before its key is checked, to slow down scanners.")),
      burst: intLeaf(1, 10000, 30,
        copy("验证前每个 IP 突发请求数", "Burst per IP before the key check"),
        copy("每个来源 IP 在短时间内可以连续发送的请求数。", "How many requests one source IP may send in a short burst.")),
    }),
    authFailure: branch({
      limit: intLeaf(1, 10000, 20,
        copy("密钥错误次数上限", "Failed key attempts allowed"),
        copy("同一来源在统计窗口内密钥验证失败达到这个次数后被临时封禁。", "How many failed key checks from one source within the window lead to a temporary ban."),
        { env: ["SERVICE_ENTRY_AUTH_FAIL_LIMIT"], consumers: ENTRY_ONLY }),
      windowSeconds: intLeaf(1, 86400, 60,
        copy("密钥错误统计窗口（秒）", "Failed attempt window (seconds)"),
        copy("统计密钥验证失败次数所用的时间窗口。", "The time window failed key checks are counted in."),
        { env: ["SERVICE_ENTRY_AUTH_FAIL_WINDOW_SECONDS"], consumers: ENTRY_ONLY }),
      banSeconds: intLeaf(1, 2592000, 600,
        copy("首次封禁时长（秒）", "First ban length (seconds)"),
        copy("来源第一次被封禁的秒数，再次触发时逐步加长；不能大于最长封禁时长。", "How many seconds the first ban of a source lasts; repeat bans grow longer. It cannot exceed the longest ban."),
        { env: ["SERVICE_ENTRY_AUTH_BAN_SECONDS"], consumers: ENTRY_ONLY }),
      maxBanSeconds: intLeaf(1, 2592000, 86400,
        copy("最长封禁时长（秒）", "Longest ban (seconds)"),
        copy("逐步加长后封禁时长的上限。", "The upper limit growing bans reach.")),
    }),
    maxBodyBytes: intLeaf(1048576, 67108864, 16777216,
      copy("公网请求体上限（字节）", "Public request body limit (bytes)"),
      copy("公网单个请求体的最大字节数，超出时请求被拒绝。", "The largest body a single public request may send, in bytes; larger requests are refused.")),
    exposeSearch: boolLeaf(false,
      copy("向公网开放联网搜索", "Offer web search publicly"),
      copy("允许带有搜索权限的公网密钥使用联网搜索接口。", "Let public keys with the search permission use the web search API.")),
    exposeTts: boolLeaf(true,
      copy("向公网开放语音合成", "Offer text to speech publicly"),
      copy("允许带有语音权限的公网密钥调用语音合成接口。声音克隆始终只在本机可用。", "Let public keys with the speech permission call the text-to-speech API. Voice cloning always stays on this machine.")),
    quotaTzOffsetMinutes: leaf(
      { type: ["integer", "null"], minimum: -720, maximum: 840, default: null },
      copy("额度统计时区（分钟）", "Quota time zone (minutes)"),
      copy("每日和每月额度按与 UTC 相差的这些分钟数切换周期；留空跟随计费中心的时区。", "Daily and monthly quotas roll over at this offset from UTC, in minutes. Leave it empty to follow the billing time zone."),
    ),
    managersGatewayOnly: leaf(
      { type: "string", enum: ["off", "warn", "enforce"], default: "warn" },
      copy("管理器只接受入口转发", "Managers accept only the entry"),
      copy("模型管理器如何处理没有经过入口转发的模型请求：off 照常处理，warn 处理并记录，enforce 拒绝。", "How the model managers treat model requests that did not come through the entry: off serves them, warn serves and logs them, enforce refuses them."),
      { env: ["MANAGER_GATEWAY_ONLY"], consumers: ["entry", "vllm-manager", "llama-manager"] },
    ),
  },
};

// The leaves of OPS-3's core file that 05 consumes, with 05's defaults
// (§3.4). A test checks them against the core schema, so drift is caught.
const CORE_LEAF_SPECS = {
  "listeners.admin.host": { type: "string", format: "hostname", default: "127.0.0.1" },
  "listeners.admin.port": { type: "integer", format: "port", default: 5176 },
  "listeners.admin.lan": { type: "boolean", default: false },
  "listeners.public.enabled": { type: "boolean", default: true },
  "listeners.public.host": { type: "string", format: "hostname", default: "127.0.0.1" },
  "listeners.public.port": { type: "integer", format: "port", default: 5186 },
  "listeners.public.lan": { type: "boolean", default: false },
  "listeners.public.baseUrl": { type: "string", format: "https-url", default: "" },
  "admin.firstRunAutoPair": { type: "boolean", default: true },
  "admin.firstRunWindowMinutes": { type: "integer", minimum: 1, maximum: 1440, default: 30 },
  "admin.sessionDays": { type: "integer", minimum: 1, maximum: 3650, default: 180 },
  "admin.loopbackViewer": { type: "boolean", default: true },
  "admin.lanAnonymousViewer": { type: "boolean", default: true },
  "admin.allowLanOwner": { type: "boolean", default: true },
  "admin.requirePairingOnLoopback": { type: "boolean", default: false },
  "admin.legacyProxyGateway": { type: "string", enum: ["serve", "reject"], default: "serve" },
  "admin.gatewayRpm": { type: "integer", minimum: 1, maximum: 100000, default: 600 },
  "admin.extraHosts": { type: "array", items: { type: "string", format: "hostname" }, default: [] },
  "trustedProxies.cidrs": { type: "array", items: { type: "string", format: "cidr" }, default: ["127.0.0.1/32", "::1/128"] },
  "trustedProxies.clientIpHeader": { type: "string", pattern: "^[A-Za-z0-9-]{1,64}$", default: "cf-connecting-ip" },
  "trustedProxies.countryHeader": { type: "string", pattern: "^[A-Za-z0-9-]{0,64}$", default: "cf-ipcountry" },
  "exposure.requireApiKey": { type: "string", enum: ["auto", "on", "off"], default: "auto" },
  "exposure.allowedOrigins": { type: "array", items: { type: "string", pattern: "^(\\*|https?://[^\\s/]+)$" }, default: [] },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function collectSchemaLeaves(properties, prefix, out) {
  for (const [name, node] of Object.entries(properties)) {
    const key = `${prefix}.${name}`;
    if (node.properties) collectSchemaLeaves(node.properties, key, out);
    else out[key] = node;
  }
  return out;
}

/** dotted key -> leaf spec, for every key the adapter reads. */
const LEAF_SPECS = Object.freeze({ ...CORE_LEAF_SPECS, ...collectSchemaLeaves(ACCESS_SCHEMA_LEAVES.properties, "public", {}) });

function getPath(object, key) {
  let current = object;
  for (const segment of key.split(".")) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function setPath(object, key, value) {
  const segments = key.split(".");
  let current = object;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments[segments.length - 1]] = value;
}

function buildDefaults() {
  const defaults = {};
  for (const [key, spec] of Object.entries(LEAF_SPECS)) setPath(defaults, key, clone(spec.default));
  return deepFreeze(defaults);
}

/** Every access default, nested by section (§3.4). */
const ACCESS_DEFAULTS = buildDefaults();

// ---------------------------------------------------------------------------
// Value checks: the OPS-3 dialect subset these leaves use, plus 05 semantics.

function isWildcardHost(value) {
  return WILDCARD_HOSTS.has(String(value).trim());
}

function isHostName(value) {
  const text = String(value).trim();
  if (!text || text.length > 253) return false;
  if (isWildcardHost(text) || net.isIP(text.replace(/^\[|\]$/g, ""))) return true;
  return text.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function isLoopbackHost(value) {
  const text = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (text === "localhost") return true;
  const ip = normalizeIp(text);
  return ip === "::1" || (net.isIPv4(ip) && ip.startsWith("127."));
}

// "" or https://host[:port][/path], without credentials, query or fragment.
function httpsUrlProblem(value) {
  if (value === "") return "";
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return "must be an https:// address or empty";
  }
  if (url.protocol !== "https:" || !url.hostname) return "must be an https:// address or empty";
  if (url.username || url.password) return "must not carry a user name or password";
  if (url.search || url.hash) return "must not carry a query or a fragment";
  return "";
}

const FORMAT_PROBLEMS = {
  hostname: (value) => (isHostName(value) ? "" : "is not a valid host name"),
  port: (value) => (Number.isInteger(value) && value >= 1 && value <= 65535 ? "" : "is not a valid port"),
  "https-url": httpsUrlProblem,
  cidr: (value) => (parseCidrList([value]).cidrs.length === 1 ? "" : "is not an IP address or CIDR range"),
};

function typeMatches(type, value) {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: return false;
  }
}

function specProblem(spec, value) {
  const types = Array.isArray(spec.type) ? spec.type : [spec.type];
  if (!types.some((type) => typeMatches(type, value))) return `must be ${types.join(" or ")}`;
  if (value === null) return "";
  if (spec.enum && !spec.enum.includes(value)) return `must be one of ${spec.enum.join(", ")}`;
  if (typeof value === "number") {
    if (spec.minimum !== undefined && value < spec.minimum) return `must be at least ${spec.minimum}`;
    if (spec.maximum !== undefined && value > spec.maximum) return `must be at most ${spec.maximum}`;
    if (spec.format === "port") return FORMAT_PROBLEMS.port(value);
  }
  if (typeof value === "string") {
    if (spec.format && FORMAT_PROBLEMS[spec.format]) {
      const problem = FORMAT_PROBLEMS[spec.format](value);
      if (problem) return problem;
    }
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) return "has an invalid format";
  }
  if (Array.isArray(value) && spec.items) {
    for (const [index, item] of value.entries()) {
      const problem = specProblem(spec.items, item);
      if (problem) return `item ${index + 1} ${problem}`;
    }
  }
  return "";
}

// 05 semantics on top of the schema: a wildcard extra host would admit any
// Host header (DNS rebinding), so it is refused.
const SEMANTIC_PROBLEMS = {
  "admin.extraHosts": (value) => (value.some(isWildcardHost) ? "must not contain a wildcard host" : ""),
  "public.extraHosts": (value) => (value.some(isWildcardHost) ? "must not contain a wildcard host" : ""),
};

/** "" when `value` is acceptable for the access key, otherwise the reason. */
function leafProblem(key, value) {
  const spec = LEAF_SPECS[key];
  if (!spec) return "";
  const problem = specProblem(spec, value);
  if (problem) return problem;
  return SEMANTIC_PROBLEMS[key] ? SEMANTIC_PROBLEMS[key](value) : "";
}

// Rules across two leaves of one section: { fields, message, check(get) }.
const CROSS_FIELD_RULES = [
  {
    code: "share_order",
    fields: ["public.share.ownerActiveMaxConcurrent", "public.share.maxConcurrent"],
    message: "The public concurrency while the owner is active cannot exceed the public total.",
    holds: (get) => get("public.share.ownerActiveMaxConcurrent") <= get("public.share.maxConcurrent"),
  },
  {
    code: "ban_order",
    fields: ["public.authFailure.banSeconds", "public.authFailure.maxBanSeconds"],
    message: "The first ban cannot be longer than the longest ban.",
    holds: (get) => get("public.authFailure.banSeconds") <= get("public.authFailure.maxBanSeconds"),
  },
];

// ---------------------------------------------------------------------------
// Reading

function safeIssue(issue, fallbackField) {
  return {
    field: String(issue?.field || fallbackField || ""),
    code: String(issue?.code || "invalid_value"),
    message: String(issue?.message || "The value is invalid; the default is in force.").slice(0, 300),
    ...(issue?.source ? { source: String(issue.source) } : {}),
    ...(issue?.env ? { env: String(issue.env) } : {}),
  };
}

function readOne(readSection, name) {
  try {
    const result = readSection(name);
    if (!isPlainObject(result)) throw new Error("no section");
    return {
      values: isPlainObject(result.values) ? result.values : isPlainObject(result.value) ? result.value : {},
      sources: isPlainObject(result.sources) ? result.sources : {},
      etag: typeof result.etag === "string" ? result.etag : "none",
      errors: Array.isArray(result.errors) ? result.errors : [],
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
    };
  } catch {
    return {
      values: {},
      sources: {},
      etag: "none",
      errors: [{ field: name, code: "config_unreadable", message: `The ${name} settings could not be read; defaults are in force.` }],
      warnings: [],
    };
  }
}

function hostOf(baseUrl) {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function originOf(baseUrl) {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "";
  }
}

/**
 * Reads the five access sections through `readSection(name)` and returns a
 * deeply frozen AccessConfig:
 *   { listeners, admin, trustedProxies, exposure, public,      // effective values
 *     adminLanBound, publicLanBound, publicOrigin, publicHost, // derived
 *     etag, sources, issues: [{field, code, message, source?}], warnings }
 * plus the non-enumerable `trustedCidrs` (parsed, for trusted-proxy.js).
 * An invalid value falls back to its default and lands in issues[].
 */
function loadAccessConfig({ readSection } = {}) {
  if (typeof readSection !== "function") throw new TypeError("loadAccessConfig needs readSection(name).");
  const sections = Object.fromEntries(READ_SECTIONS.map((name) => [name, readOne(readSection, name)]));
  const issues = [];
  const warnings = [];
  const seen = new Set();
  const note = (list, issue) => {
    const signature = `${issue.field}\0${issue.code}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    list.push(issue);
  };
  for (const name of READ_SECTIONS) {
    for (const error of sections[name].errors) note(issues, safeIssue(error, name));
    for (const warning of sections[name].warnings) note(warnings, safeIssue(warning, name));
  }

  const values = {};
  const sources = {};
  for (const [key, spec] of Object.entries(LEAF_SPECS)) {
    const [name, ...rest] = key.split(".");
    const section = sections[name];
    const raw = getPath(section.values, rest.join("."));
    let value = raw;
    let source = section.sources[key] || (raw === undefined ? "default" : "file");
    if (raw === undefined) {
      value = clone(spec.default);
      source = "default";
    } else {
      const problem = leafProblem(key, raw);
      if (problem) {
        note(issues, { field: key, code: "invalid_value", message: `${key} ${problem}; the default is in force.`, source });
        value = clone(spec.default);
        source = "default";
      }
    }
    setPath(values, key, clone(value));
    sources[key] = source;
  }
  const get = (key) => getPath(values, key);
  for (const rule of CROSS_FIELD_RULES) {
    if (rule.holds(get)) continue;
    note(issues, { field: rule.fields[0], code: rule.code, message: `${rule.message} The defaults are in force.`, fields: rule.fields.slice() });
    for (const key of rule.fields) {
      setPath(values, key, clone(LEAF_SPECS[key].default));
      sources[key] = "default";
    }
  }

  // CIDRs: the schema already checks the format; parseCidrList is the parser
  // trusted-proxy.js matches with, so a list it cannot fully read is replaced.
  let parsed = parseCidrList(values.trustedProxies.cidrs);
  if (parsed.issues.length) {
    note(issues, { field: "trustedProxies.cidrs", code: "invalid_value", message: `${parsed.issues.join("; ")}; the default is in force.` });
    values.trustedProxies.cidrs = clone(LEAF_SPECS["trustedProxies.cidrs"].default);
    sources["trustedProxies.cidrs"] = "default";
    parsed = parseCidrList(values.trustedProxies.cidrs);
  }
  values.trustedProxies.clientIpHeader = values.trustedProxies.clientIpHeader.toLowerCase();
  values.trustedProxies.countryHeader = values.trustedProxies.countryHeader.toLowerCase();

  const { listeners } = values;
  const etags = READ_SECTIONS.map((name) => sections[name].etag).filter((etag) => etag !== "none");
  const config = {
    ...values,
    adminLanBound: listeners.admin.lan === true || !isLoopbackHost(listeners.admin.host),
    publicLanBound: listeners.public.enabled !== false && (listeners.public.lan === true || !isLoopbackHost(listeners.public.host)),
    publicOrigin: originOf(listeners.public.baseUrl),
    publicHost: hostOf(listeners.public.baseUrl),
    etag: etags[0] || "none",
    sources,
    issues,
    warnings,
  };
  Object.defineProperty(config, "trustedCidrs", { value: Object.freeze(parsed.cidrs), enumerable: false });
  return deepFreeze(config);
}

/**
 * A cached AccessConfig for per-request use. get() re-reads at most every
 * ttlMs (readSection is itself cached on the file's stat), and keeps the same
 * object while nothing changed, so a new etag or env value takes effect live.
 */
function createAccessConfigSource({ readSection, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  if (typeof readSection !== "function") throw new TypeError("createAccessConfigSource needs readSection(name).");
  let current = null;
  let fingerprint = "";
  let loadedAt = 0;
  function refresh() {
    const next = loadAccessConfig({ readSection });
    const print = JSON.stringify(next);
    if (!current || print !== fingerprint) {
      current = next;
      fingerprint = print;
    }
    loadedAt = Number(now());
    return current;
  }
  return {
    get() {
      if (!current || !(Number(now()) - loadedAt < Math.max(0, Number(ttlMs) || 0))) return refresh();
      return current;
    },
    refresh,
  };
}

// ---------------------------------------------------------------------------
// Writing

function failure(status, code, message, errors = []) {
  return { ok: false, status, code, error: { code, message }, changed: [], restartRequired: [], errors };
}

// A section patch as dotted keys relative to the namespace, the way OPS-3's
// writeSection reads it: nested objects and dotted keys both work, null unsets.
function flattenPatch(section, patch, prefix = section, out = {}) {
  for (const [segment, value] of Object.entries(patch)) {
    const key = segment.startsWith(`${section}.`) ? segment : `${prefix}.${segment}`;
    if (isPlainObject(value) && !LEAF_SPECS[key]) flattenPatch(section, value, key, out);
    else out[key] = value;
  }
  return out;
}

function cleanActor(actor) {
  return String(actor || "").trim().slice(0, 120) || "unknown";
}

/**
 * Validates a settings patch for one access section and writes it through
 * OPS-3's writeSection(section, patch, { etag, actor }). Resolves
 * { ok: true, config, etag, changed, restartRequired } or a refusal
 * { ok: false, status, code, error, errors } (OPS-3's own refusals, such as
 * 409 config_conflict, pass through unchanged). On a change it appends one
 * access_audit row with the changed key names (never values) and publishes
 * an `access` event of kind settings_changed. Never touches the file system.
 */
async function updateAccessSection(section, patch, options = {}) {
  const { etag, actor, actorIp = null, writeSection, readSection, source, store, bus, logger = console } = options;
  if (typeof writeSection !== "function") throw new TypeError("updateAccessSection needs writeSection(name, patch, { etag }).");
  if (!WRITABLE_SECTIONS.includes(section)) {
    return failure(400, "unknown_section", `Only ${WRITABLE_SECTIONS.join(", ")} can be changed here.`, [{ field: String(section || ""), code: "unknown_section", message: "Not an access settings section." }]);
  }
  if (typeof etag !== "string" || !etag.trim()) {
    return failure(428, "etag_required", "Load the settings first and send their etag, so a concurrent change is not overwritten.");
  }
  if (!isPlainObject(patch)) {
    return failure(400, "config_invalid", "A settings patch must be an object.", [{ field: section, code: "invalid_type", message: "A settings patch must be an object." }]);
  }

  const flat = flattenPatch(section, patch);
  const errors = [];
  for (const [key, value] of Object.entries(flat)) {
    if (value === null || !LEAF_SPECS[key]) continue; // unset, or for OPS-3 to judge
    const problem = leafProblem(key, value);
    if (problem) errors.push({ field: key, code: "invalid_value", message: `${key} ${problem}.` });
  }
  // Cross-field rules are judged on the settings in force plus the patch.
  const reader = typeof readSection === "function" ? readSection : null;
  const current = source && typeof source.get === "function" ? source.get() : reader ? loadAccessConfig({ readSection: reader }) : null;
  if (current && !errors.length) {
    const get = (key) => {
      if (Object.hasOwn(flat, key)) return flat[key] === null ? LEAF_SPECS[key].default : flat[key];
      return getPath(current, key);
    };
    for (const rule of CROSS_FIELD_RULES) {
      if (!rule.fields.some((key) => Object.hasOwn(flat, key))) continue;
      if (!rule.holds(get)) errors.push({ field: rule.fields[0], fields: rule.fields.slice(), code: rule.code, message: rule.message });
    }
  }
  if (errors.length) return failure(400, "config_invalid", "The settings were not saved because some values are invalid.", errors);

  const written = await writeSection(section, patch, { etag, actor: cleanActor(actor) });
  if (!written || written.ok !== true) {
    if (written && written.ok === false) return { ...written, status: written.status || 400 };
    return failure(500, "config_write_failed", "The settings could not be saved.");
  }
  const changed = Array.isArray(written.changed) ? written.changed.slice() : [];
  const restartRequired = Array.isArray(written.restartRequired) ? written.restartRequired.slice() : [];
  const warnings = Array.isArray(written.warnings) ? written.warnings.slice() : [];
  if (changed.length) {
    if (store && typeof store.appendAudit === "function") {
      try {
        store.appendAudit({ actor: cleanActor(actor), actorIp, action: "settings.update", targetType: "settings", targetId: section, details: { fields: changed } });
      } catch (error) {
        // The write already happened; a failed audit row is reported, not undone.
        warnings.push({ field: "$audit", code: "audit_failed", message: "The change was saved, but its audit row could not be written." });
        logger?.warn?.(`access settings audit failed: ${String(error?.code || error?.message || error)}`);
      }
    }
    if (bus && typeof bus.publish === "function") {
      bus.publish("access", { kind: "settings_changed", section, changed, restartRequired });
    }
  }
  let config = null;
  if (source && typeof source.refresh === "function") config = source.refresh();
  else if (reader) config = loadAccessConfig({ readSection: reader });
  return { ok: true, config, etag: written.etag, changed, restartRequired, ...(warnings.length ? { warnings } : {}) };
}

module.exports = {
  ACCESS_DEFAULTS,
  ACCESS_SCHEMA_LEAVES: deepFreeze(ACCESS_SCHEMA_LEAVES),
  CORE_LEAF_SPECS: deepFreeze(CORE_LEAF_SPECS),
  READ_SECTIONS,
  WRITABLE_SECTIONS,
  createAccessConfigSource,
  leafProblem,
  loadAccessConfig,
  updateAccessSection,
};
