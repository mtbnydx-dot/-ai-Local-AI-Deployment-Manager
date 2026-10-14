"use strict";

// Console serving layer (07 §2.3–§2.6, CON-2).
//
// The new console is a buildless SPA under service-entry/console/. It is
// served from an in-memory snapshot: console/ (as /), shared-public/vendor/
// (as vendor/) and shared-public/styles/ (as shared/styles/), plus the two
// merged catalogs i18n/<locale>.json. Every file lives under
// /c/<buildId>/… with an immutable cache header, and the build id is 06's
// getBuildId().contentHash (00 §9.16); this module computes no id of its own.
//
// Deploys copy files into a running platform, so the snapshot follows the
// content: an HTML request (the shell or the bootstrap) that sees a new
// contentHash rebuilds it. A rebuild reads every file, then asks for the
// build id again; a hash that moved during the read (a deploy in progress)
// means another read, at most three, and otherwise the previous snapshot
// stays. The previous id keeps being served, so an open tab can still
// lazy-load from it; any older id answers 410 console_stale and the tab
// shows its update banner. A snapshot that cannot be built (a vendor file
// missing, VENDOR.json invalid, a file locked mid-deploy) is never served
// half-done: / falls back to the classic console and one log line says why.
//
// Routes (§2.4): / (the shell when the default UI is "new", otherwise
// declined so the inline classic handler answers), the SPA prefixes with an
// HTML Accept, /classic, /billing/classic, /c/<buildId>/… and
// GET /api/console/bootstrap. The default UI is 06's console.defaultUi,
// with SERVICE_ENTRY_CONSOLE_DEFAULT taking precedence (OPS-3 resolves it),
// and ?ui=new|classic overrides it for one request of /.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const core = require("../../manager-core");
const { strictLocalBillingAdmin } = require("./billing-http");

const gzipAsync = promisify(zlib.gzip);
const brotliAsync = promisify(zlib.brotliCompress);

const OWNER = "07";
const LOCALES = Object.freeze(["zh-CN", "en-US"]);
const DEFAULT_LOCALE = "zh-CN";
const DEFAULT_PREFS = Object.freeze({ locale: "zh-CN", theme: "auto", density: "comfortable" });
// console_prefs=theme:dark|locale:en-US|density:compact (07 §3.8); anything
// outside these values is ignored.
const PREF_VALUES = Object.freeze({
  theme: Object.freeze(["auto", "light", "dark"]),
  locale: Object.freeze(["auto", "zh-CN", "en-US"]),
  density: Object.freeze(["comfortable", "compact"]),
});
const PREFS_COOKIE = "console_prefs";
const PREFS_COOKIE_MAX_LENGTH = 512;
// Clean console paths that fall back to the shell (07 §2.4, C3).
const SPA_PREFIXES = Object.freeze([
  "overview", "deployments", "models", "engines", "playground", "observability", "audit",
  "alerts", "access", "billing", "voice", "system", "setup",
]);
// Bootstrap feature names (07 §2.5); the route-mount table turns them on.
const FEATURE_NAMES = Object.freeze([
  "events", "mgmtProxy", "engines", "models", "hub", "telemetry", "alerts", "audit",
  "session", "access", "public", "platform", "setup",
]);
const MANAGER_LABELS = Object.freeze({
  vllm: Object.freeze({ zh: "vLLM / SGLang 管理器", en: "vLLM / SGLang manager" }),
  llama: Object.freeze({ zh: "llama.cpp 管理器", en: "llama.cpp manager" }),
});
// The snapshot serves only these extensions plus LICENSE files (07 §2.3).
const MIME_TYPES = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
});
const LICENSE_MIME = "text/plain; charset=utf-8";
const MAX_BUILD_ATTEMPTS = 3;
const BROTLI_QUALITY = 5;
const BOOT_TEXT = Object.freeze({ "zh-CN": "正在加载控制台…", "en-US": "Loading console…" });
const NOSCRIPT_TEXT = Object.freeze({ "zh-CN": "需要启用 JavaScript", "en-US": "JavaScript is required" });
const TITLE_TEXT = Object.freeze({ "zh-CN": "本地 AI 平台", "en-US": "Local AI Platform" });

const SHELL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "media-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "worker-src 'none'",
].join("; ");
// Today's /billing policy, framable by the console only (00 §9.13).
const BILLING_CLASSIC_CSP = "default-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
const PAGE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
});
const SHELL_HEADERS = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": SHELL_CSP,
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  ...PAGE_HEADERS,
});
const STALE_BODY = Object.freeze({
  ok: false,
  error: Object.freeze({ code: "console_stale", message: "This console version is no longer served. Reload the page.", hint: "reload" }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function snapshotError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function headerText(headers, name) {
  const value = headers?.[name];
  return String(Array.isArray(value) ? value.join(",") : value || "");
}

// ---------------------------------------------------------------------------
// i18n merge (07 §3.7)

const I18N_AREA_NAME = /^[a-z][a-z0-9-]*$/;

function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    return { error: `could not be read (${error?.code || "error"})` };
  }
  try {
    return { value: JSON.parse(stripBom(text)) };
  } catch (error) {
    return { error: `is not valid JSON (${error.message})` };
  }
}

function isCatalogValue(value) {
  if (typeof value === "string") return true;
  if (!isPlainObject(value) || typeof value.other !== "string") return false;
  return Object.values(value).every((item) => typeof item === "string");
}

// Checks one locale file of an area. Returns { keys } or { problem }.
function checkAreaFile(data, locale) {
  if (!isPlainObject(data)) return { problem: { code: "invalid_json", message: "is not a JSON object" } };
  if (data.$locale !== locale) return { problem: { code: "invalid_locale", message: `declares $locale ${JSON.stringify(data.$locale)}, not ${locale}` } };
  const prefixes = data.$prefixes;
  if (!Array.isArray(prefixes) || !prefixes.length || !prefixes.every((item) => typeof item === "string" && /^[a-z][A-Za-z0-9.-]*\.$/.test(item))) {
    return { problem: { code: "invalid_prefixes", message: "needs $prefixes, a list of key prefixes that end with a dot" } };
  }
  const keys = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("$")) continue;
    if (!prefixes.some((prefix) => key.startsWith(prefix))) {
      return { problem: { code: "key_outside_prefixes", key, message: `defines ${key}, which none of its $prefixes owns` } };
    }
    if (!isCatalogValue(value)) return { problem: { code: "invalid_value", key, message: `defines ${key} with a value that is neither a string nor a plural object with "other"` } };
    keys[key] = value;
  }
  return { keys };
}

function readDynamicKeys(file) {
  const read = readJsonFile(file);
  if (read.missing) return { value: null };
  if (read.error) return { problem: { code: "invalid_json", message: read.error } };
  const data = read.value;
  const list = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!isPlainObject(data) || (data.prefixes !== undefined && !list(data.prefixes)) || (data.unused !== undefined && !list(data.unused))) {
    return { problem: { code: "invalid_dynamic_keys", message: "must be { prefixes: [string], unused: [string] }" } };
  }
  return { value: { prefixes: [...(data.prefixes || [])], unused: [...(data.unused || [])] } };
}

function sortedObject(source) {
  const out = {};
  for (const key of Object.keys(source).sort()) out[key] = source[key];
  return out;
}

/**
 * Merges console/i18n/<area>/{zh-CN,en-US}.json into one catalog per locale
 * (07 §3.7, 00 §9.16). Areas merge in name order. A locale file that is not
 * valid JSON, declares the wrong $locale or no $prefixes, holds a key outside
 * its $prefixes or a malformed value, or defines a key an earlier area
 * already defines, is left out as a whole and reported in `problems`; its
 * keys then show as key names. Never throws for content.
 * @returns {{ catalogs: { "zh-CN": object, "en-US": object }, dynamicKeys: object, problems: Array<{area, file, code, key?, message}> }}
 */
function mergeI18nAreas(i18nDir) {
  const catalogs = Object.fromEntries(LOCALES.map((locale) => [locale, {}]));
  const owners = Object.fromEntries(LOCALES.map((locale) => [locale, new Map()]));
  const dynamicKeys = {};
  const problems = [];
  let areas = [];
  try {
    areas = fs.readdirSync(i18nDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && I18N_AREA_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code !== "ENOENT") problems.push({ area: "", file: "", code: "unreadable", message: `the i18n folder could not be read (${error?.code || "error"})` });
  }
  for (const area of areas) {
    const dir = path.join(i18nDir, area);
    for (const locale of LOCALES) {
      const file = `${area}/${locale}.json`;
      const read = readJsonFile(path.join(dir, `${locale}.json`));
      if (read.missing) {
        problems.push({ area, file, code: "missing_file", message: `${file} is missing` });
        continue;
      }
      if (read.error) {
        problems.push({ area, file, code: "invalid_json", message: `${file} ${read.error}` });
        continue;
      }
      const checked = checkAreaFile(read.value, locale);
      if (checked.problem) {
        problems.push({ area, file, ...checked.problem, message: `${file} ${checked.problem.message}` });
        continue;
      }
      const taken = Object.keys(checked.keys).find((key) => owners[locale].has(key));
      if (taken) {
        problems.push({ area, file, code: "duplicate_key", key: taken, message: `${file} defines ${taken}, which area ${owners[locale].get(taken)} already defines` });
        continue;
      }
      for (const [key, value] of Object.entries(checked.keys)) {
        owners[locale].set(key, area);
        catalogs[locale][key] = value;
      }
    }
    const dynamic = readDynamicKeys(path.join(dir, "dynamic-keys.json"));
    if (dynamic.problem) {
      const file = `${area}/dynamic-keys.json`;
      problems.push({ area, file, ...dynamic.problem, message: `${file} ${dynamic.problem.message}` });
    } else if (dynamic.value) {
      dynamicKeys[area] = dynamic.value;
    }
  }
  return {
    catalogs: Object.fromEntries(LOCALES.map((locale) => [locale, sortedObject(catalogs[locale])])),
    dynamicKeys,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Preferences, locale and the default UI

/** The allowlisted fields of the console_prefs cookie (07 C6); anything else is ignored. */
function parsePrefsCookie(cookieHeader) {
  const prefs = {};
  for (const part of String(cookieHeader || "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0 || part.slice(0, at).trim() !== PREFS_COOKIE) continue;
    let value = part.slice(at + 1).trim();
    if (value.length > PREFS_COOKIE_MAX_LENGTH) return {};
    try {
      value = decodeURIComponent(value);
    } catch {
      return {};
    }
    for (const pair of value.split("|")) {
      const split = pair.indexOf(":");
      if (split < 0) continue;
      const name = pair.slice(0, split).trim();
      const item = pair.slice(split + 1).trim();
      if (Object.hasOwn(PREF_VALUES, name) && PREF_VALUES[name].includes(item)) prefs[name] = item;
    }
    return prefs;
  }
  return prefs;
}

// zh* → zh-CN, anything else → en-US, no header → zh-CN: the client's
// resolveLocale rule (07 §3.7) over Accept-Language, highest q first.
function localeFromAcceptLanguage(header) {
  const ranked = String(header || "").split(",").map((item, index) => {
    const [tag, ...params] = item.trim().split(";");
    const q = params.map((param) => /^\s*q=([0-9.]+)\s*$/i.exec(param)).find(Boolean);
    return { tag: tag.trim().toLowerCase(), q: q ? Number(q[1]) : 1, index };
  }).filter((item) => item.tag && item.tag !== "*" && item.q > 0);
  ranked.sort((left, right) => right.q - left.q || left.index - right.index);
  if (!ranked.length) return DEFAULT_LOCALE;
  return ranked[0].tag.startsWith("zh") ? "zh-CN" : "en-US";
}

function resolveRequestPrefs(req) {
  const prefs = parsePrefsCookie(req?.headers?.cookie);
  const locale = prefs.locale && prefs.locale !== "auto" ? prefs.locale : localeFromAcceptLanguage(req?.headers?.["accept-language"]);
  return {
    locale,
    theme: prefs.theme || DEFAULT_PREFS.theme,
    density: prefs.density || DEFAULT_PREFS.density,
  };
}

/**
 * The default UI at / (07 C10): 06's console.defaultUi with
 * SERVICE_ENTRY_CONSOLE_DEFAULT taking precedence (OPS-3's env > file >
 * default). Anything unreadable is "classic".
 */
function readDefaultUi({ aiRoot, env = process.env } = {}) {
  try {
    const section = core.platform.readSection("console", { aiRoot, env });
    return section?.values?.defaultUi === "new" ? "new" : "classic";
  } catch {
    return "classic";
  }
}

// ---------------------------------------------------------------------------
// Snapshot

function mimeOf(name) {
  if (name === "LICENSE") return LICENSE_MIME;
  return MIME_TYPES[path.extname(name).toLowerCase()] || "";
}

// Every servable file below dir as { key, full }. A missing root contributes
// nothing; any other read error fails the snapshot.
async function walkServable(dir, prefix, { skip = () => false } = {}) {
  const out = [];
  async function walk(current, relDir) {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" && relDir === "") return;
      throw snapshotError("read_failed", `${prefix || "console/"}${relDir} could not be read (${error?.code || "error"})`, error);
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (skip(rel, entry)) continue;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), rel);
      } else if (entry.isFile() && mimeOf(entry.name)) {
        out.push({ key: `${prefix}${rel}`, full: path.join(current, entry.name) });
      }
    }
  }
  await walk(dir, "");
  return out;
}

// VENDOR.json is the integrity source (07 §2.2): every file it lists must be
// in the snapshot with its size and sha256, or the snapshot fails.
function checkVendor(files) {
  const manifestEntry = files.get("vendor/VENDOR.json");
  if (!manifestEntry) throw snapshotError("vendor_invalid", "shared-public/vendor/VENDOR.json is missing");
  let manifest;
  try {
    manifest = JSON.parse(stripBom(manifestEntry.raw.toString("utf8")));
  } catch (error) {
    throw snapshotError("vendor_invalid", `shared-public/vendor/VENDOR.json is not valid JSON (${error.message})`);
  }
  if (!isPlainObject(manifest) || !Array.isArray(manifest.packages)) {
    throw snapshotError("vendor_invalid", "shared-public/vendor/VENDOR.json lists no packages");
  }
  for (const entry of manifest.packages) {
    for (const file of Array.isArray(entry?.files) ? entry.files : []) {
      const key = `vendor/${entry.dir}/${file?.path}`;
      const found = files.get(key);
      if (!found) throw snapshotError("vendor_invalid", `${key} is listed in VENDOR.json but missing`);
      if (Number.isFinite(file.bytes) && found.raw.length !== file.bytes) throw snapshotError("vendor_invalid", `${key} does not have the size VENDOR.json lists`);
      if (typeof file.sha256 === "string" && sha256Hex(found.raw) !== file.sha256) throw snapshotError("vendor_invalid", `${key} does not match its sha256 in VENDOR.json`);
    }
  }
}

// The shell links only files the snapshot holds, so a stylesheet or icon a
// later package adds appears without a template edit and is never a 404.
function compileTemplate(text, files) {
  return text.replace(/^[ \t]*<link\b[^>]*\bhref="\/c\/%BUILD_ID%\/([^"]+)"[^>]*>[ \t]*\r?\n?/gm, (line, rel) => (files.has(rel) ? line : ""));
}

async function compress(entry) {
  const [gzip, br] = await Promise.all([
    gzipAsync(entry.raw),
    brotliAsync(entry.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.raw.length } }),
  ]);
  entry.gzip = gzip.length < entry.raw.length ? gzip : null;
  entry.br = br.length < entry.raw.length ? br : null;
}

// Accept-Encoding → "br", "gzip" or "" (raw), honouring q=0.
function pickEncoding(header, entry) {
  const accepted = new Map();
  for (const item of String(header || "").toLowerCase().split(",")) {
    const [name, ...params] = item.trim().split(";");
    if (!name) continue;
    const q = params.map((param) => /^\s*q=([0-9.]+)\s*$/.exec(param)).find(Boolean);
    accepted.set(name.trim(), q ? Number(q[1]) : 1);
  }
  const allows = (name) => (accepted.has(name) ? accepted.get(name) > 0 : (accepted.get("*") || 0) > 0);
  if (entry.br && allows("br")) return "br";
  if (entry.gzip && allows("gzip")) return "gzip";
  return "";
}

// ---------------------------------------------------------------------------
// Routes

/**
 * The console routes of one entry (07 §2.4).
 * @returns {{ handle(req, res, url): Promise<boolean>, snapshot(): object|null, bootstrap(req): object, refresh(options?): Promise<object|null> }}
 */
function createConsoleRoutes(options = {}) {
  const rootDir = path.resolve(String(options.rootDir || path.join(__dirname, "..", "console")));
  const vendorDir = path.resolve(String(options.vendorDir || path.join(__dirname, "..", "..", "shared-public", "vendor")));
  const stylesDir = path.resolve(String(options.stylesDir || path.join(__dirname, "..", "..", "shared-public", "styles")));
  const classicHtml = path.resolve(String(options.classicHtml || path.join(__dirname, "..", "index.html")));
  const billingHtml = path.resolve(String(options.billingHtml || path.join(__dirname, "..", "billing.html")));
  const aiRoot = options.aiRoot ? path.resolve(String(options.aiRoot)) : path.resolve(__dirname, "..", "..");
  const auth = options.auth;
  if (!auth || typeof auth.principal !== "function") throw new TypeError("createConsoleRoutes needs the request-auth seam");
  const security = options.security || null;
  const logger = options.logger || console;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const dev = Boolean(options.dev);
  const getBuildId = typeof options.getBuildId === "function" ? options.getBuildId : () => core.platform.getBuildId({ aiRoot });
  const getDefaultUi = typeof options.getDefaultUi === "function" ? options.getDefaultUi : () => readDefaultUi({ aiRoot });
  const readVersion = typeof options.readVersion === "function" ? options.readVersion : () => core.platform.readVersion(aiRoot);
  const getFeatures = typeof options.features === "function" ? options.features : () => options.features;
  const managers = (Array.isArray(options.managers) ? options.managers : [])
    .map((item) => ({ id: String(item?.id || ""), port: Number(item?.port) }))
    .filter((item) => item.id);
  const isStrictLocalBilling = typeof options.isStrictLocalBillingRequest === "function"
    ? options.isStrictLocalBillingRequest
    : (req) => strictLocalBillingAdmin(req, { isLocalAddress: core.isLocalAddress, extractHostname: core.extractHostname });
  const sendJson = typeof options.sendJson === "function"
    ? options.sendJson
    : (res, data, status = 200, extraHeaders = {}) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...PAGE_HEADERS, ...extraHeaders });
      res.end(JSON.stringify(data));
    };

  let current = null;
  let previous = null;
  let building = null;
  let lastFailure = "";
  const loggedProblems = new Set();

  function warn(line) {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, core.redactSecrets(`console-routes: ${line}`));
    } catch {
      // Logging must never break a request.
    }
  }

  // One line per distinct failure, not one per request while it lasts.
  function noteFailure(error, fallback) {
    const code = String(error?.code || "snapshot_failed");
    const key = `${code}:${error?.message || error}`;
    if (key === lastFailure) return;
    lastFailure = key;
    warn(`the console snapshot was not built (${code}: ${error?.message || error}); ${fallback}`);
  }

  function noteProblems(problems) {
    for (const problem of problems) {
      const key = `${problem.file}:${problem.code}:${problem.key || ""}`;
      if (loggedProblems.has(key)) continue;
      loggedProblems.add(key);
      warn(`i18n area ${problem.area || "(root)"}: ${problem.message}; the file is left out of the merged catalog`);
    }
  }

  function buildIdNow() {
    let result;
    try {
      result = getBuildId();
    } catch (error) {
      throw snapshotError(String(error?.code || "build_id_unavailable"), String(error?.message || error), error);
    }
    if (!isPlainObject(result) || typeof result.contentHash !== "string" || !result.contentHash) {
      throw snapshotError("build_id_unavailable", "getBuildId() returned no contentHash");
    }
    return { contentHash: result.contentHash, commit: typeof result.commit === "string" && result.commit ? result.commit : null };
  }

  async function readContent() {
    const sources = [
      ...await walkServable(rootDir, "", {
        // The raw area catalogs are merged below; package.json is only the
        // module-type marker.
        skip: (rel, entry) => (entry.isDirectory() && rel === "i18n") || (!entry.isDirectory() && rel === "package.json"),
      }),
      ...await walkServable(vendorDir, "vendor/"),
      ...await walkServable(stylesDir, "shared/styles/"),
    ];
    const files = new Map();
    for (const source of sources) {
      let raw;
      try {
        raw = await fs.promises.readFile(source.full);
      } catch (error) {
        throw snapshotError("read_failed", `${source.key} could not be read (${error?.code || "error"})`, error);
      }
      files.set(source.key, { mime: mimeOf(path.basename(source.full)), raw, gzip: null, br: null });
    }
    checkVendor(files);
    if (!files.has("app.js")) throw snapshotError("shell_missing", "console/app.js is missing");
    let templateText;
    try {
      templateText = stripBom(await fs.promises.readFile(path.join(rootDir, "index.html"), "utf8"));
    } catch (error) {
      throw snapshotError("shell_missing", `console/index.html could not be read (${error?.code || "error"})`, error);
    }
    const merged = mergeI18nAreas(path.join(rootDir, "i18n"));
    for (const locale of LOCALES) {
      const body = Buffer.from(JSON.stringify({ $locale: locale, ...merged.catalogs[locale] }), "utf8");
      files.set(`i18n/${locale}.json`, { mime: MIME_TYPES[".json"], raw: body, gzip: null, br: null });
    }
    if (!dev) await Promise.all([...files.values()].map(compress));
    return {
      files,
      template: compileTemplate(templateText, files),
      catalogs: merged.catalogs,
      dynamicKeys: merged.dynamicKeys,
      problems: merged.problems,
    };
  }

  // Reads every file between two build-id calls; a hash that moved during
  // the read means a deploy is copying files, so the read is repeated.
  async function computeSnapshot() {
    for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt += 1) {
      const before = buildIdNow();
      const content = await readContent();
      const after = buildIdNow();
      if (after.contentHash === before.contentHash) {
        return { id: after.contentHash, commit: after.commit, builtAt: new Date(now()).toISOString(), ...content };
      }
    }
    throw snapshotError("build_id_moving", `the console files changed during ${MAX_BUILD_ATTEMPTS} reads in a row (a deploy in progress)`);
  }

  function install(snapshot) {
    if (current && current.id !== snapshot.id) previous = current;
    current = snapshot;
    lastFailure = "";
    noteProblems(snapshot.problems);
  }

  /**
   * The current snapshot, rebuilt first when the build id moved (or always
   * with force). A failure keeps whatever was served before; null means
   * there has never been a snapshot.
   */
  function refresh({ force = false } = {}) {
    if (building) return building;
    if (!force && current) {
      let id;
      try {
        id = buildIdNow().contentHash;
      } catch (error) {
        noteFailure(error, `still serving ${current.id}`);
        return Promise.resolve(current);
      }
      if (id === current.id) return Promise.resolve(current);
    }
    building = (async () => {
      try {
        install(await computeSnapshot());
      } catch (error) {
        noteFailure(error, current ? `still serving ${current.id}` : "/ serves the classic console");
      }
      return current;
    })();
    building.finally(() => {
      building = null;
    }).catch(() => {});
    return building;
  }

  function snapshotFor(id) {
    if (current && current.id === id) return current;
    if (previous && previous.id === id) return previous;
    return null;
  }

  function principalOf(req) {
    try {
      return auth.principal(req) || {};
    } catch {
      return {};
    }
  }

  function consoleRole(who) {
    if (who.role === "owner") return "owner";
    if (who.role === "viewer" || who.role === "system") return "viewer";
    return "none";
  }

  // 05's session body minus the token (07 §2.5). The seam offers session(req)
  // once PUB-5 mounts admin sessions; before that there is none.
  function authBlock(req) {
    const mode = typeof auth.mode === "string" && auth.mode ? auth.mode : "loopback-trust";
    if (typeof auth.session !== "function") return { mode, session: null, csrf: null };
    let body = null;
    try {
      body = auth.session(req);
    } catch (error) {
      warn(`reading the session failed; the bootstrap carries none: ${error?.message || error}`);
    }
    if (!isPlainObject(body)) return { mode, session: null, csrf: null };
    return {
      mode,
      session: {
        role: typeof body.role === "string" ? body.role : "none",
        via: typeof body.via === "string" ? body.via : "none",
        paired: body.paired === true,
        autoPairAvailable: body.autoPairAvailable === true,
      },
      csrf: typeof body.csrfToken === "string" && body.csrfToken ? body.csrfToken : null,
    };
  }

  function versionInfo() {
    try {
      const value = readVersion();
      return isPlainObject(value) ? value : {};
    } catch {
      return {};
    }
  }

  function featureFlags() {
    const source = getFeatures();
    const flags = Object.fromEntries(FEATURE_NAMES.map((name) => [name, false]));
    if (isPlainObject(source)) {
      for (const [name, value] of Object.entries(source)) {
        if (typeof value === "boolean") flags[name] = value;
      }
    }
    return flags;
  }

  function isLocal(req) {
    const proxied = typeof security?.isProxiedRequest === "function" && security.isProxiedRequest(req);
    return !proxied && core.isLocalRequest(req);
  }

  function allowLanAdmin() {
    try {
      return Boolean(security?.policy?.().allowLanAdmin);
    } catch {
      return false;
    }
  }

  /** The §2.5 bootstrap for one request: a fresh role and the current build id. */
  function bootstrap(req, snapshot = current) {
    const who = principalOf(req);
    const role = consoleRole(who);
    const local = isLocal(req);
    const version = versionInfo();
    const buildId = snapshot ? snapshot.id : null;
    return {
      ok: true,
      buildId,
      role,
      access: { local, lanViewer: !local && role === "viewer", allowLanAdmin: allowLanAdmin() },
      auth: authBlock(req),
      defaults: { ...DEFAULT_PREFS },
      platform: {
        version: typeof version.version === "string" ? version.version : null,
        commit: snapshot?.commit || (typeof version.shortCommit === "string" ? version.shortCommit : null),
        contentHash: buildId,
        deployedAt: typeof version.deployedAt === "string" ? version.deployedAt : null,
      },
      managers: managers.map((manager) => ({
        id: manager.id,
        label: { ...(MANAGER_LABELS[manager.id] || { zh: manager.id, en: manager.id }) },
        legacyUiPort: Number.isInteger(manager.port) ? manager.port : null,
      })),
      gateway: { autoOpenAi: "/gateway/auto/openai/v1", autoClaude: "/gateway/auto/claude", consoleSession: auth.consoleSession === true },
      features: featureFlags(),
    };
  }

  function catalogText(snapshot, locale, key, fallback) {
    const value = snapshot?.catalogs?.[locale]?.[key];
    return typeof value === "string" && value ? value : fallback[locale];
  }

  function renderShell(snapshot, req) {
    const prefs = resolveRequestPrefs(req);
    const json = JSON.stringify(bootstrap(req, snapshot)).replace(/</g, "\\u003c");
    const values = {
      BUILD_ID: snapshot.id,
      LANG: prefs.locale,
      THEME_ATTR: prefs.theme === "auto" ? "" : `data-theme="${prefs.theme}"`,
      DENSITY: prefs.density,
      TITLE: escapeHtml(catalogText(snapshot, prefs.locale, "shell.product", TITLE_TEXT)),
      BOOT_TEXT: escapeHtml(catalogText(snapshot, prefs.locale, "shell.boot.loading", BOOT_TEXT)),
      NOSCRIPT_TEXT: escapeHtml(catalogText(snapshot, prefs.locale, "shell.boot.noscript", NOSCRIPT_TEXT)),
      BOOTSTRAP_JSON: json,
    };
    // One pass, so text that was just injected is never scanned again.
    return snapshot.template.replace(/%([A-Z_]+)%/g, (match, name) => (Object.hasOwn(values, name) ? values[name] : match));
  }

  // true when the shell went out; false when no snapshot exists.
  async function serveShell(req, res) {
    const snapshot = await refresh({ force: dev });
    if (!snapshot) return false;
    const body = Buffer.from(renderShell(snapshot, req), "utf8");
    res.writeHead(200, { ...SHELL_HEADERS, "content-length": body.length });
    res.end(body);
    return true;
  }

  async function servePage(res, file, extraHeaders = {}) {
    const content = await fs.promises.readFile(file);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...PAGE_HEADERS, ...extraHeaders });
    res.end(content);
  }

  async function serveAsset(req, res, pathname, headOnly) {
    const match = /^\/c\/([^/]+)\/(.+)$/.exec(pathname);
    if (!match) {
      sendJson(res, { ok: false, error: { code: "not_found", message: "Not found." } }, 404);
      return true;
    }
    if (dev) await refresh({ force: true });
    else if (!current) await refresh();
    const snapshot = snapshotFor(match[1]);
    if (!snapshot) {
      sendJson(res, STALE_BODY, 410);
      return true;
    }
    let rel = "";
    try {
      rel = decodeURIComponent(match[2]);
    } catch {
      rel = "";
    }
    // A map lookup: a path that is not a snapshot key, traversal included, is a 404.
    const entry = rel ? snapshot.files.get(rel) : null;
    if (!entry) {
      sendJson(res, { ok: false, error: { code: "not_found", message: "Not found." } }, 404);
      return true;
    }
    const etag = `"${snapshot.id}"`;
    const headers = {
      "content-type": entry.mime,
      "cache-control": dev ? "no-store" : "public, max-age=31536000, immutable",
      etag,
      vary: "accept-encoding",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    const ifNoneMatch = headerText(req.headers, "if-none-match");
    if (!dev && ifNoneMatch && ifNoneMatch.split(",").some((tag) => tag.trim() === etag || tag.trim() === `W/${etag}`)) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const encoding = dev ? "" : pickEncoding(headerText(req.headers, "accept-encoding"), entry);
    const body = encoding ? entry[encoding] : entry.raw;
    if (encoding) headers["content-encoding"] = encoding;
    headers["content-length"] = body.length;
    res.writeHead(200, headers);
    res.end(headOnly ? undefined : body);
    return true;
  }

  function acceptsHtml(req) {
    return /\btext\/html\b/i.test(headerText(req.headers, "accept"));
  }

  function spaPrefixOf(pathname) {
    const first = pathname.split("/")[1] || "";
    return SPA_PREFIXES.includes(first) ? first : "";
  }

  function defaultUi() {
    try {
      return getDefaultUi() === "new" ? "new" : "classic";
    } catch {
      return "classic";
    }
  }

  async function handle(req, res, url) {
    const method = String(req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return false;
    const pathname = url.pathname;
    if (pathname.startsWith("/c/")) return serveAsset(req, res, pathname, method === "HEAD");
    if (method !== "GET") return false;
    if (pathname === "/api/console/bootstrap") {
      await refresh({ force: dev });
      sendJson(res, bootstrap(req));
      return true;
    }
    if (pathname === "/classic") {
      await servePage(res, classicHtml);
      return true;
    }
    if (pathname === "/billing/classic" || pathname === "/billing/classic/") {
      if (!isStrictLocalBilling(req)) {
        sendJson(res, { error: "Billing administration is available only through localhost.", code: "billing_admin_local_only" }, 403);
        return true;
      }
      await servePage(res, billingHtml, { "content-security-policy": BILLING_CLASSIC_CSP, "x-frame-options": "SAMEORIGIN" });
      return true;
    }
    if (pathname === "/") {
      const override = url.searchParams.get("ui");
      const ui = override === "new" || override === "classic" ? override : defaultUi();
      // Declined: the inline handler serves the classic console as before.
      if (ui !== "new") return false;
      return serveShell(req, res);
    }
    const prefix = spaPrefixOf(pathname);
    if (!prefix || !acceptsHtml(req)) return false;
    // /billing stays the legacy page until the new console is the default (C8).
    if ((pathname === "/billing" || pathname === "/billing/") && defaultUi() !== "new") return false;
    if (await serveShell(req, res)) return true;
    // No snapshot at all: a console link lands on the classic console.
    res.writeHead(302, { location: "/classic", ...PAGE_HEADERS });
    res.end();
    return true;
  }

  return {
    handle,
    bootstrap,
    refresh,
    snapshot: () => current,
  };
}

// 07's viewer registrations (07 §2.9, 05 §5.4). /api/events/recent and the
// proxied manager reads are registered by the events and proxy modules; 05's
// baseline already declares / and the legacy /billing page.
function registerConsoleRoutes(registry, warn) {
  const registrations = [
    () => registry.registerRoute({ owner: OWNER, path: "/classic" }),
    () => registry.registerRoute({ owner: OWNER, path: "/c/*" }),
    () => registry.registerRoute({ owner: OWNER, path: "/api/console/bootstrap" }),
    // The legacy billing page stays owner-only and local-only (00 §9.13).
    () => registry.registerAdminOnly({ owner: OWNER, method: "GET", path: "/billing/classic" }),
    () => registry.registerAdminOnly({ owner: OWNER, method: "GET", path: "/billing/classic/" }),
  ];
  for (const name of SPA_PREFIXES) {
    if (name !== "billing") registrations.push(() => registry.registerRoute({ owner: OWNER, path: `/${name}` }));
    registrations.push(() => registry.registerRoute({ owner: OWNER, path: `/${name}/*` }));
  }
  for (const register of registrations) {
    try {
      register();
    } catch (error) {
      // An entry that cannot be registered stays owner-only (deny by default).
      warn(`a viewer registry entry was not registered and stays owner-only: ${error?.message || error}`);
    }
  }
}

// Route module (07 §2.7). The snapshot is built on the first HTML request,
// so mounting reads no files and cannot fail on a missing console tree.
function mount(ctx) {
  const auth = ctx?.auth;
  if (!auth || typeof auth.principal !== "function" || !auth.viewerRegistry) throw new Error("console-routes: ctx.auth is missing");
  const logger = ctx.logger || console;
  const warn = (line) => {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, core.redactSecrets(`console-routes: ${line}`));
    } catch {
      // Logging must never break startup.
    }
  };
  registerConsoleRoutes(auth.viewerRegistry, warn);
  const entryDir = path.resolve(String(ctx.rootDir || path.join(__dirname, "..")));
  const aiRoot = path.resolve(String(ctx.aiRoot || path.dirname(entryDir)));
  const routes = createConsoleRoutes({
    rootDir: path.join(entryDir, "console"),
    vendorDir: path.join(aiRoot, "shared-public", "vendor"),
    stylesDir: path.join(aiRoot, "shared-public", "styles"),
    classicHtml: path.join(entryDir, "index.html"),
    billingHtml: path.join(entryDir, "billing.html"),
    aiRoot,
    auth,
    security: ctx.security,
    managers: ctx.managers,
    // Read per request: modules mounted after this one still turn theirs on.
    features: () => ctx.features,
    getDefaultUi: () => readDefaultUi({ aiRoot }),
    getBuildId: () => core.platform.getBuildId({ aiRoot }),
    readVersion: () => core.platform.readVersion(aiRoot),
    sendJson: ctx.sendJson,
    logger,
    now: ctx.now,
    dev: process.env.SERVICE_ENTRY_CONSOLE_DEV === "1",
  });
  return {
    handle: routes.handle,
    close() {
      // Nothing to release: the snapshot is plain memory.
    },
  };
}

module.exports = {
  BILLING_CLASSIC_CSP,
  FEATURE_NAMES,
  SHELL_CSP,
  SPA_PREFIXES,
  createConsoleRoutes,
  localeFromAcceptLanguage,
  mergeI18nAreas,
  mount,
  name: "console",
  parsePrefsCookie,
  readDefaultUi,
  registerConsoleRoutes,
};
