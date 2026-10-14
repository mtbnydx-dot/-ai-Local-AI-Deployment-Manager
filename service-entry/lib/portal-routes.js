"use strict";

// Portal serving layer for the PUBLIC listener (05 §3.2, §12.1, PUB-15).
//
// The portal is a buildless SPA under service-entry/portal/. It is served from
// an in-memory snapshot of the allowlisted files:
//   portal/**                      as /assets/<id>/…
//   shared-public/vendor/<dir>/…   as /assets/<id>/vendor/<dir>/…  (only the
//                                  files VENDOR.json lists for the packages
//                                  the portal uses; nothing is vendored here)
//   shared-public/styles/tokens.css as /assets/<id>/shared/styles/tokens.css
// <id> is 06's getBuildId().contentHash (00 §9.16); this module computes no id
// of its own. Every other path, traversal included, is a map miss and answers
// like any unknown route.
//
// The shell (index.html) carries the build id, an inline import map generated
// from VENDOR.json.importMap and the document language. The CSP admits that
// one inline script by its sha256 and nothing else. An HTML request asks
// getBuildId() again (it re-stats at most every 2 s); a new contentHash
// rebuilds the snapshot. A rebuild reads every file between two build-id calls
// and repeats when the hash moved (a deploy in progress). The previous id keeps
// being served so an open tab can lazy-load from it; an older id answers 410
// portal_stale and the shell reloads.
//
// This module is the `portal` seam of createPublicListener: handle(req, res,
// url, route) -> Promise<boolean>.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const core = require("../../manager-core");
const { newRequestId } = require("./public-errors");

const gzipAsync = promisify(zlib.gzip);
const brotliAsync = promisify(zlib.brotliCompress);

// The VENDOR.json packages the portal imports (05 §12.1). lucide is the
// console's icon subset and is not served here.
const PORTAL_PACKAGES = Object.freeze(["preact", "htm", "uplot", "qrcode-generator"]);
const LANGUAGES = Object.freeze(["zh-CN", "en-US"]);
const DEFAULT_LANGUAGE = "zh-CN";
const MAX_BUILD_ATTEMPTS = 3;
// After a failed build the next attempt waits this long, so a broken install
// (a vendor file missing, a deploy half copied) is not re-read on every request.
const FAILURE_BACKOFF_MS = 5000;
const BROTLI_QUALITY = 5;
const MIME_TYPES = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
});
const LICENSE_MIME = "text/plain; charset=utf-8";
const ASSET_PATH_RE = /^\/assets\/([A-Za-z0-9._-]+)\/(.+)$/;
const PAGE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
});

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function snapshotError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function headerText(headers, name) {
  const value = headers?.[name];
  return String(Array.isArray(value) ? value.join(",") : value || "");
}

function mimeOf(name) {
  if (name === "LICENSE") return LICENSE_MIME;
  return MIME_TYPES[path.extname(name).toLowerCase()] || "";
}

// The shell's CSP (05 §12.1). The one inline script is the import map, named
// by the hash of its text.
function buildCsp(importMapText) {
  const hash = crypto.createHash("sha256").update(importMapText, "utf8").digest("base64");
  return [
    "default-src 'none'",
    `script-src 'self' 'sha256-${hash}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

// The document language of one request: ?lang=, then Accept-Language. The
// client applies its own order (?lang=, localStorage, navigator.language) and
// corrects the attribute; this is the no-script and first-paint value.
function pickLanguage(url, req) {
  const asked = String(url?.searchParams?.get("lang") || "").trim().toLowerCase();
  if (asked === "zh" || asked === "zh-cn") return "zh-CN";
  if (asked === "en" || asked === "en-us") return "en-US";
  for (const part of headerText(req?.headers, "accept-language").toLowerCase().split(",")) {
    const tag = part.split(";")[0].trim();
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
    if (tag === "en" || tag.startsWith("en-")) return "en-US";
  }
  return DEFAULT_LANGUAGE;
}

async function compress(entry) {
  const [gzip, br] = await Promise.all([
    gzipAsync(entry.raw),
    brotliAsync(entry.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.raw.length } }),
  ]);
  entry.gzip = gzip.length < entry.raw.length ? gzip : null;
  entry.br = br.length < entry.raw.length ? br : null;
}

// Accept-Encoding -> "br", "gzip" or "" (raw), honouring q=0.
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
      throw snapshotError("read_failed", `${prefix}${relDir} could not be read (${error?.code || "error"})`, error);
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

async function readInto(files, key, full, mime) {
  let raw;
  try {
    raw = await fs.promises.readFile(full);
  } catch (error) {
    throw snapshotError("read_failed", `${key} could not be read (${error?.code || "error"})`, error);
  }
  files.set(key, { mime, raw, gzip: null, br: null });
  return raw;
}

// The vendor files of the portal's packages, exactly as VENDOR.json lists them
// (07 §2.2), each verified against its size and sha256. Returns the files'
// keys and the import map as { specifier: "<dir>/<file>" }.
async function readVendor(vendorDir, files) {
  let manifest;
  let text;
  try {
    text = stripBom(await fs.promises.readFile(path.join(vendorDir, "VENDOR.json"), "utf8"));
  } catch (error) {
    throw snapshotError("vendor_invalid", `shared-public/vendor/VENDOR.json could not be read (${error?.code || "error"})`, error);
  }
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw snapshotError("vendor_invalid", `shared-public/vendor/VENDOR.json is not valid JSON (${error.message})`, error);
  }
  if (!isPlainObject(manifest) || !Array.isArray(manifest.packages) || !isPlainObject(manifest.importMap)) {
    throw snapshotError("vendor_invalid", "shared-public/vendor/VENDOR.json lists no packages or no import map");
  }
  const importMap = {};
  for (const pkg of manifest.packages) {
    if (!PORTAL_PACKAGES.includes(pkg?.name)) continue;
    const dir = String(pkg.dir || "");
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(dir)) throw snapshotError("vendor_invalid", `VENDOR.json lists an invalid directory for ${pkg.name}`);
    for (const file of Array.isArray(pkg.files) ? pkg.files : []) {
      const rel = String(file?.path || "");
      if (!rel || rel.includes("..") || rel.includes("\\") || rel.startsWith("/")) throw snapshotError("vendor_invalid", `VENDOR.json lists an invalid path for ${pkg.name}`);
      const key = `vendor/${dir}/${rel}`;
      const raw = await readInto(files, key, path.join(vendorDir, ...dir.split("/"), ...rel.split("/")), mimeOf(path.basename(rel)) || LICENSE_MIME);
      if (Number.isFinite(file.bytes) && raw.length !== file.bytes) throw snapshotError("vendor_invalid", `${key} does not have the size VENDOR.json lists`);
      if (typeof file.sha256 === "string" && sha256Hex(raw) !== file.sha256) throw snapshotError("vendor_invalid", `${key} does not match its sha256 in VENDOR.json`);
    }
    for (const specifier of Object.keys(isPlainObject(pkg.entries) ? pkg.entries : {})) {
      const target = manifest.importMap[specifier];
      if (typeof target !== "string" || !files.has(`vendor/${target}`)) throw snapshotError("vendor_invalid", `the import map entry ${specifier} is missing or names a file VENDOR.json does not list`);
      importMap[specifier] = target;
    }
  }
  for (const name of PORTAL_PACKAGES) {
    if (!manifest.packages.some((pkg) => pkg?.name === name)) throw snapshotError("vendor_invalid", `VENDOR.json does not list ${name}`);
  }
  return importMap;
}

/**
 * createPortalRoutes({ rootDir, vendorDir, stylesDir, aiRoot, getBuildId, logger, now, dev, backoffMs })
 * -> { handle(req, res, url, route), refresh(options), snapshot(), errorStylesheets() }
 *   getBuildId()  -> { commit, contentHash } (06); defaults to core.platform.getBuildId
 *   dev           no compression and no-store assets, for local work on the portal
 */
function createPortalRoutes(options = {}) {
  const aiRoot = options.aiRoot ? path.resolve(String(options.aiRoot)) : path.resolve(__dirname, "..", "..");
  const rootDir = path.resolve(String(options.rootDir || path.join(__dirname, "..", "portal")));
  const vendorDir = path.resolve(String(options.vendorDir || path.join(aiRoot, "shared-public", "vendor")));
  const stylesDir = path.resolve(String(options.stylesDir || path.join(aiRoot, "shared-public", "styles")));
  const logger = options.logger || console;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const dev = Boolean(options.dev);
  const backoffMs = Number.isFinite(options.backoffMs) ? Math.max(0, options.backoffMs) : FAILURE_BACKOFF_MS;
  const getBuildId = typeof options.getBuildId === "function" ? options.getBuildId : () => core.platform.getBuildId({ aiRoot });

  let current = null;
  let previous = null;
  let building = null;
  let lastFailure = "";
  let lastFailureAt = 0;

  function warn(line) {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, core.redactSecrets(`portal-routes: ${line}`));
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
    warn(`the portal snapshot was not built (${code}: ${error?.message || error}); ${fallback}`);
  }

  function buildIdNow() {
    let result;
    try {
      result = getBuildId();
    } catch (error) {
      throw snapshotError(String(error?.code || "build_id_unavailable"), String(error?.message || error), error);
    }
    if (!isPlainObject(result) || typeof result.contentHash !== "string" || !/^[A-Za-z0-9._-]+$/.test(result.contentHash)) {
      throw snapshotError("build_id_unavailable", "getBuildId() returned no usable contentHash");
    }
    return { contentHash: result.contentHash, commit: typeof result.commit === "string" && result.commit ? result.commit : null };
  }

  async function readContent(id) {
    const files = new Map();
    // package.json is only the module-type marker; index.html is the shell
    // template and error.html belongs to public-errors.js (neither has a
    // servable extension). Everything else under portal/ is the app.
    const own = await walkServable(rootDir, "", { skip: (rel, entry) => !entry.isDirectory() && rel === "package.json" });
    for (const source of own) await readInto(files, source.key, source.full, mimeOf(path.basename(source.full)));
    const importMap = await readVendor(vendorDir, files);
    await readInto(files, "shared/styles/tokens.css", path.join(stylesDir, "tokens.css"), MIME_TYPES[".css"]);
    let templateText;
    try {
      templateText = stripBom(await fs.promises.readFile(path.join(rootDir, "index.html"), "utf8"));
    } catch (error) {
      throw snapshotError("shell_missing", `portal/index.html could not be read (${error?.code || "error"})`, error);
    }
    if (!files.has("app.js")) throw snapshotError("shell_missing", "portal/app.js is missing");
    const imports = {};
    for (const [specifier, target] of Object.entries(importMap)) imports[specifier] = `/assets/${id}/vendor/${target}`;
    const importMapText = JSON.stringify({ imports });
    const element = `<script type="importmap">${importMapText}</script>`;
    // %LANG% is the only per-request value; the rest is fixed for the snapshot.
    const template = templateText.replace(/%(BUILD_ID|IMPORT_MAP)%/g, (match, name) => (name === "BUILD_ID" ? id : element));
    if (!dev) await Promise.all([...files.values()].map(compress));
    return { files, template, csp: buildCsp(importMapText), importMapText };
  }

  // Reads every file between two build-id calls; a hash that moved during the
  // read means a deploy is copying files, so the read is repeated.
  async function computeSnapshot() {
    for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt += 1) {
      const before = buildIdNow();
      const content = await readContent(before.contentHash);
      const after = buildIdNow();
      if (after.contentHash === before.contentHash) {
        return { id: after.contentHash, commit: after.commit, builtAt: new Date(now()).toISOString(), ...content };
      }
    }
    throw snapshotError("build_id_moving", `the portal files changed during ${MAX_BUILD_ATTEMPTS} reads in a row (a deploy in progress)`);
  }

  function install(snapshot) {
    if (current && current.id !== snapshot.id) previous = current;
    current = snapshot;
    lastFailure = "";
    lastFailureAt = 0;
  }

  /**
   * The current snapshot, rebuilt first when the build id moved (or always
   * with force). A failure keeps whatever was served before; null means there
   * has never been a snapshot.
   */
  function refresh({ force = false } = {}) {
    if (building) return building;
    if (!force && lastFailureAt && now() - lastFailureAt < backoffMs) return Promise.resolve(current);
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
        lastFailureAt = now();
        noteFailure(error, current ? `still serving ${current.id}` : "the portal answers 503");
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

  function sendJson(req, res, status, body, headers = {}) {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-length": String(payload.length),
      ...headers,
    });
    res.end(String(req.method || "").toUpperCase() === "HEAD" ? undefined : payload);
  }

  function sendStale(req, res) {
    sendJson(req, res, 410, {
      error: { message: "This portal version is no longer served. Reload the page.", type: "invalid_request_error", code: "portal_stale", param: null },
      request_id: req.requestId || newRequestId(),
    });
  }

  async function serveShell(req, res, url) {
    const snapshot = await refresh({ force: dev });
    if (!snapshot) {
      sendJson(req, res, 503, {
        error: { message: "The portal is not available right now.", type: "server_error", code: "service_unavailable", param: null },
        request_id: req.requestId || newRequestId(),
      });
      return;
    }
    const body = Buffer.from(snapshot.template.replace(/%LANG%/g, pickLanguage(url, req)), "utf8");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": snapshot.csp,
      vary: "accept-language",
      ...PAGE_HEADERS,
      "content-length": String(body.length),
    });
    res.end(String(req.method || "").toUpperCase() === "HEAD" ? undefined : body);
  }

  async function serveAsset(req, res, pathname) {
    const match = ASSET_PATH_RE.exec(pathname);
    if (!match) return false;
    if (dev) await refresh({ force: true });
    else if (!current) await refresh();
    const snapshot = snapshotFor(match[1]);
    if (!snapshot) {
      sendStale(req, res);
      return true;
    }
    let rel = "";
    try {
      rel = decodeURIComponent(match[2]);
    } catch {
      rel = "";
    }
    // A map lookup: a path that is not a snapshot key, traversal included, is
    // not served.
    const entry = rel ? snapshot.files.get(rel) : null;
    if (!entry) return false;
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
    res.end(String(req.method || "").toUpperCase() === "HEAD" ? undefined : body);
    return true;
  }

  /** true when the response was sent; false leaves the 404 to the listener. */
  async function handle(req, res, url, route) {
    const kind = route?.kind;
    if (kind === "portal") {
      await serveShell(req, res, url);
      return true;
    }
    if (kind === "asset") return serveAsset(req, res, url.pathname);
    return false;
  }

  // The stylesheets of the current build for the server-rendered error pages
  // (public-errors.js); none until a snapshot exists, which this call starts.
  function errorStylesheets() {
    if (!current) refresh().catch(() => {});
    return current ? [`/assets/${current.id}/shared/styles/tokens.css`, `/assets/${current.id}/styles/portal.css`] : [];
  }

  return {
    handle,
    refresh,
    errorStylesheets,
    snapshot: () => current,
  };
}

module.exports = {
  LANGUAGES,
  PORTAL_PACKAGES,
  buildCsp,
  createPortalRoutes,
  pickLanguage,
};
