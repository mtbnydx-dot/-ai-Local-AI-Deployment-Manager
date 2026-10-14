"use strict";

// One signing scheme for every local call into service-entry (05 §5.7).
//
// Each caller signs with the entry trust token (.gateway-trust.json):
//
//   HMAC_SHA256(token, METHOD \n path \n principal \n ts \n sha256hex(body)), base64url
//
// Two wire forms share that string:
// - Manager form. Managers (billing ids such as "vllm-manager") call
//   /internal/*. It keeps the x-ai-billing-* header names and signs the
//   pathname only, so a billing call is byte-identical to the signature the
//   billing client has always sent.
// - Machine form. system:<component> principals call ADMIN /api/*. It signs
//   pathname + search, so the query (SSE event types, filters) is bound too,
//   and it carries the body digest so the entry can check the signature
//   before it reads the body.
//
// This module is the only code that signs internal calls or decides which
// internal path prefixes exist. Callers may narrow the prefixes, never widen
// them. Nothing here logs, and no thrown message or result carries a token.

const crypto = require("node:crypto");
const path = require("node:path");
const { createGatewayTrustReader } = require("./gateway-trust");
const { isLocalAddress, normalizeRemoteAddress } = require("./network");

const INTERNAL_PATH_PREFIXES = Object.freeze([
  "/internal/billing/",
  "/internal/access/",
  "/internal/telemetry/",
  "/internal/models/",
]);
const BILLING_PATH_PREFIX = "/internal/billing/";
const MACHINE_PRINCIPAL_RE = /^system:(hub-shim:(vllm|llama)|supervisor|cli|mcp)$/;

// Manager form: the historical billing header names stay on the wire.
const MANAGER_PRINCIPAL_HEADER = "x-ai-billing-manager";
const MANAGER_TIMESTAMP_HEADER = "x-ai-billing-ts";
const MANAGER_SIGNATURE_HEADER = "x-ai-billing-signature";
const MANAGER_VERSION_HEADER = "x-ai-billing-version";
// Machine form.
const MACHINE_PRINCIPAL_HEADER = "x-ai-internal-principal";
const MACHINE_TIMESTAMP_HEADER = "x-ai-internal-ts";
const MACHINE_SIGNATURE_HEADER = "x-ai-internal-signature";
const MACHINE_BODY_SHA256_HEADER = "x-ai-internal-body-sha256";
const MACHINE_VERSION_HEADER = "x-ai-internal-version";
const MACHINE_HEADER_NAMES = Object.freeze([
  MACHINE_PRINCIPAL_HEADER,
  MACHINE_TIMESTAMP_HEADER,
  MACHINE_SIGNATURE_HEADER,
  MACHINE_BODY_SHA256_HEADER,
  MACHINE_VERSION_HEADER,
]);
// Every header this module owns. A hop that relays client traffic strips
// these so a client cannot smuggle a signature through.
const INTERNAL_AUTH_HEADER_NAMES = Object.freeze([
  MANAGER_PRINCIPAL_HEADER,
  MANAGER_TIMESTAMP_HEADER,
  MANAGER_SIGNATURE_HEADER,
  MANAGER_VERSION_HEADER,
  ...MACHINE_HEADER_NAMES,
]);

const DEFAULT_ALLOWED_MANAGERS = Object.freeze(["vllm-manager", "llama-manager"]);
const DEFAULT_INTERNAL_BASE_URL = "http://127.0.0.1:5176";
const DEFAULT_INTERNAL_TIMEOUT_MS = 10000;
const DEFAULT_INTERNAL_MAX_SKEW_MS = 60 * 1000;
const SSE_MIN_RETRY_MS = 1000;
const SSE_MAX_RETRY_MS = 30000;
const SSE_MAX_LINE_BYTES = 1024 * 1024;

function headerText(headers = {}, name) {
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return Boolean(a.length && a.length === b.length && crypto.timingSafeEqual(a, b));
}

function bodySha256Hex(body) {
  let buffer;
  if (Buffer.isBuffer(body)) buffer = body;
  else if (body instanceof Uint8Array) buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  else buffer = Buffer.from(String(body || ""), "utf8");
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeInternalManagerId(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text.length > 80 || !/^[a-z0-9][a-z0-9._-]*$/.test(text)) return "";
  return text;
}

function isMachinePrincipal(value) {
  return MACHINE_PRINCIPAL_RE.test(String(value || ""));
}

// The manager form signs the pathname; a query never takes part.
function managerPathname(value) {
  return String(value || "").split("?")[0];
}

function hasUnsafePathSegment(pathname) {
  return pathname.includes("\\") || /(^|\/)(\.|%2e){1,2}(\/|$)/i.test(pathname);
}

// Caller prefixes can only narrow the module allowlist: a prefix outside it is
// ignored, so no caller can open a new internal surface by passing one.
function effectivePrefixes(pathPrefixes) {
  const requested = Array.isArray(pathPrefixes) ? pathPrefixes : INTERNAL_PATH_PREFIXES;
  return requested
    .map((prefix) => String(prefix || ""))
    .filter((prefix) => INTERNAL_PATH_PREFIXES.some((root) => prefix.startsWith(root)));
}

function isInternalPathAllowed(pathname, pathPrefixes) {
  const text = String(pathname || "");
  if (!text.startsWith("/") || hasUnsafePathSegment(text)) return false;
  return effectivePrefixes(pathPrefixes).some((prefix) => text.startsWith(prefix));
}

function requestTarget(req) {
  const raw = String(req?.originalUrl || req?.url || "");
  if (raw.startsWith("/")) return raw;
  try {
    const parsed = new URL(raw);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "";
  }
}

function skewWindow(value) {
  return Math.max(1000, Number(value ?? DEFAULT_INTERNAL_MAX_SKEW_MS));
}

function signInternal(token, { method, path: signedPath, principal, ts, bodySha256 } = {}) {
  return crypto
    .createHmac("sha256", String(token || ""))
    .update([
      String(method || "").toUpperCase(),
      String(signedPath || ""),
      String(principal || ""),
      String(ts ?? ""),
      String(bodySha256 || ""),
    ].join("\n"), "utf8")
    .digest("base64url");
}

// Manager form. Returns {} (an unsigned request the entry will refuse) when the
// token, manager id or path is not usable, exactly as the billing client did.
function buildInternalRequestHeaders(token, method, pathname, managerId, body, now = Date.now()) {
  const normalizedManagerId = normalizeInternalManagerId(managerId);
  const normalizedPath = managerPathname(pathname);
  const timestamp = String(now);
  if (!token || !normalizedManagerId || !isInternalPathAllowed(normalizedPath)) return {};
  return {
    "content-type": "application/json",
    "accept": "application/json",
    [MANAGER_PRINCIPAL_HEADER]: normalizedManagerId,
    [MANAGER_TIMESTAMP_HEADER]: timestamp,
    [MANAGER_SIGNATURE_HEADER]: signInternal(token, {
      method: String(method || "POST"),
      path: normalizedPath,
      principal: normalizedManagerId,
      ts: timestamp,
      bodySha256: bodySha256Hex(body),
    }),
    [MANAGER_VERSION_HEADER]: "1",
  };
}

// Verifies the manager form. Billing paths keep their billing_* codes; every
// other path reports internal_* codes. The check order matches the historical
// billing verifier: loopback, manager, path, headers, skew, signature.
function verifyInternalRequest(req, rawBody, token, options = {}) {
  const headers = req?.headers || {};
  const pathname = managerPathname(options.pathname || requestTarget(req));
  const family = pathname.startsWith(BILLING_PATH_PREFIX) ? "billing" : "internal";
  const fail = (reason) => ({ ok: false, code: `${family}_${reason}` });
  const socketAddress = normalizeRemoteAddress(req?.socket?.remoteAddress || req?.ip || "");
  if (!isLocalAddress(socketAddress)) return fail("loopback_required");
  const managerId = normalizeInternalManagerId(headerText(headers, MANAGER_PRINCIPAL_HEADER));
  const allowedManagers = new Set((options.allowedManagers || DEFAULT_ALLOWED_MANAGERS)
    .map(normalizeInternalManagerId)
    .filter(Boolean));
  if (!managerId || !allowedManagers.has(managerId)) return fail("manager_not_allowed");
  if (!isInternalPathAllowed(pathname, options.pathPrefixes)) return { ok: false, code: "internal_path_not_allowed" };
  const timestamp = headerText(headers, MANAGER_TIMESTAMP_HEADER);
  const signature = headerText(headers, MANAGER_SIGNATURE_HEADER);
  const version = headerText(headers, MANAGER_VERSION_HEADER);
  if (!token || !timestamp || !signature || version !== "1") return fail("signature_missing");
  const issuedAt = Number(timestamp);
  const now = Number(options.now ?? Date.now());
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > skewWindow(options.maxSkewMs)) {
    return fail("signature_expired");
  }
  const expected = signInternal(token, {
    method: String(req?.method || "POST"),
    path: pathname,
    principal: managerId,
    ts: timestamp,
    bodySha256: bodySha256Hex(rawBody),
  });
  if (!safeEqualText(signature, expected)) return fail("signature_invalid");
  return { ok: true, managerId };
}

// Machine form. Returns {} when the token, principal or target is not usable.
function buildMachineHeaders(token, { method, pathWithQuery, principal, body, now = Date.now() } = {}) {
  const target = String(pathWithQuery || "");
  if (!token || !isMachinePrincipal(principal) || !target.startsWith("/") || target.startsWith("//")) return {};
  const timestamp = String(now);
  const digest = bodySha256Hex(body);
  return {
    [MACHINE_PRINCIPAL_HEADER]: principal,
    [MACHINE_TIMESTAMP_HEADER]: timestamp,
    [MACHINE_SIGNATURE_HEADER]: signInternal(token, {
      method: String(method || "GET"),
      path: target,
      principal,
      ts: timestamp,
      bodySha256: digest,
    }),
    [MACHINE_BODY_SHA256_HEADER]: digest,
    [MACHINE_VERSION_HEADER]: "1",
  };
}

// Verifies the machine form against the request target (pathname + search).
// The body is not read here: the caller compares bodySha256Hex(rawBody) with
// the returned bodySha256 before any route runs. internal_signature_missing
// means no machine header at all, so the caller judges other credentials.
function verifyMachineSignature(req, token, options = {}) {
  const headers = req?.headers || {};
  if (!MACHINE_HEADER_NAMES.some((name) => headerText(headers, name))) {
    return { ok: false, code: "internal_signature_missing" };
  }
  const socketAddress = normalizeRemoteAddress(req?.socket?.remoteAddress || req?.ip || "");
  if (!isLocalAddress(socketAddress)) return { ok: false, code: "internal_loopback_required" };
  const principal = headerText(headers, MACHINE_PRINCIPAL_HEADER);
  if (!isMachinePrincipal(principal)) return { ok: false, code: "internal_principal_not_allowed" };
  const timestamp = headerText(headers, MACHINE_TIMESTAMP_HEADER);
  const signature = headerText(headers, MACHINE_SIGNATURE_HEADER);
  const bodySha256 = headerText(headers, MACHINE_BODY_SHA256_HEADER).toLowerCase();
  const version = headerText(headers, MACHINE_VERSION_HEADER);
  if (!token || !timestamp || !signature || version !== "1" || !/^[a-f0-9]{64}$/.test(bodySha256)) {
    return { ok: false, code: "internal_signature_invalid" };
  }
  const issuedAt = Number(timestamp);
  const now = Number(options.now ?? Date.now());
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > skewWindow(options.maxSkewMs)) {
    return { ok: false, code: "internal_signature_expired" };
  }
  const expected = signInternal(token, {
    method: String(req?.method || "GET"),
    path: options.pathWithQuery ?? requestTarget(req),
    principal,
    ts: timestamp,
    bodySha256,
  });
  if (!safeEqualText(signature, expected)) return { ok: false, code: "internal_signature_invalid" };
  return { ok: true, principal, bodySha256 };
}

// The internal key is the entry trust token. The reader checks the file mtime
// on every call, so a restarted entry's new token is picked up without caching.
function readInternalKey(options = {}) {
  const aiRoot = options.aiRoot || options.root || process.env.AI_ROOT || path.resolve(__dirname, "..");
  return createGatewayTrustReader({
    root: aiRoot,
    file: options.trustFile || options.file,
    envName: options.envName,
    cacheTtlMs: 0,
  });
}

function normalizeInternalBaseUrl(value, options = {}) {
  const label = String(options.label || "Internal service");
  const text = String(value || DEFAULT_INTERNAL_BASE_URL).trim().replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} URL is invalid.`);
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname)) {
    throw new Error(`${label} must use an HTTP loopback URL.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`${label} URL must not contain credentials, a path, a query, or a fragment.`);
  }
  return parsed.origin;
}

function boundedInternalTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(60000, Math.max(250, Math.floor(number)))
    : DEFAULT_INTERNAL_TIMEOUT_MS;
}

function internalError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

// Transport failures are rethrown with our own message: the underlying error
// is never attached, so nothing that saw the request headers can leak.
function transportError(error, pathname) {
  const timedOut = error?.name === "TimeoutError";
  return internalError(
    timedOut ? "internal_timeout" : "internal_unavailable",
    timedOut ? `Internal request to ${pathname} timed out.` : `Internal request to ${pathname} failed.`,
  );
}

function callerHeaders(value) {
  const output = {};
  for (const [name, headerValue] of Object.entries(value && typeof value === "object" ? value : {})) {
    const key = String(name).toLowerCase();
    if (INTERNAL_AUTH_HEADER_NAMES.includes(key) || ["host", "content-length"].includes(key)) continue;
    if (headerValue === undefined || headerValue === null) continue;
    output[key] = String(headerValue);
  }
  return output;
}

function encodeBody(method, body) {
  if (method === "GET" || method === "HEAD" || body === undefined || body === null) return undefined;
  if (typeof body === "string" || Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return JSON.stringify(body);
}

async function discardBody(response) {
  try { await response.body?.cancel?.(); } catch {}
}

// Minimal text/event-stream parser: data/event/id fields, comments ignored,
// CRLF, CR or LF line ends, and a line split across chunks.
function createSseParser(dispatch) {
  let buffer = "";
  let fields = { id: null, event: "", data: [] };
  function line(text) {
    if (text === "") {
      if (fields.data.length) {
        const raw = fields.data.join("\n");
        let data = raw;
        try { data = JSON.parse(raw); } catch {}
        dispatch({ id: fields.id, event: fields.event || "message", data });
      }
      fields = { id: null, event: "", data: [] };
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const name = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "data") fields.data.push(value);
    else if (name === "event") fields.event = value;
    else if (name === "id" && !value.includes("\0")) fields.id = value;
  }
  return function push(chunk) {
    buffer += chunk;
    const lineEnd = /\r\n|\n|\r/g;
    let start = 0;
    let match;
    while ((match = lineEnd.exec(buffer))) {
      // A trailing CR may be the first half of a CRLF in the next chunk.
      if (match[0] === "\r" && match.index === buffer.length - 1) break;
      line(buffer.slice(start, match.index));
      start = lineEnd.lastIndex;
    }
    buffer = buffer.slice(start);
    if (buffer.length > SSE_MAX_LINE_BYTES) {
      throw internalError("internal_sse_line_too_long", "Internal event stream sent an oversized line.");
    }
  };
}

function createInternalClient(options = {}) {
  const principal = String(options.principal || "").trim();
  const managerId = normalizeInternalManagerId(options.managerId);
  if (principal && options.managerId) {
    throw new Error("An internal client signs as a machine principal or as a manager, not both.");
  }
  if (principal && !isMachinePrincipal(principal)) {
    throw new Error("Internal client principal is not a known machine principal.");
  }
  if (!principal && !managerId) throw new Error("A valid internal principal or manager id is required.");
  const baseUrl = normalizeInternalBaseUrl(options.baseUrl || DEFAULT_INTERNAL_BASE_URL);
  const timeoutMs = boundedInternalTimeout(options.timeoutMs);
  const fetchFn = options.fetchFn || ((...args) => fetch(...args));
  const keyOptions = { aiRoot: options.aiRoot ?? options.root, trustFile: options.trustFile, envName: options.envName };
  const injectedReadKey = typeof options.readKey === "function" ? options.readKey : null;
  let keyReader = injectedReadKey || readInternalKey(keyOptions);

  function currentKey() {
    try {
      return String(keyReader() || "").trim();
    } catch {
      return "";
    }
  }

  // A 401 means the entry may have restarted with a new token. A fresh reader
  // cannot be pinned to the old token by an mtime that did not move.
  function reloadKey() {
    if (!injectedReadKey) keyReader = readInternalKey(keyOptions);
    return currentKey();
  }

  function resolveTarget(pathWithQuery) {
    const text = String(pathWithQuery || "");
    if (!text.startsWith("/") || text.startsWith("//")) {
      throw internalError("internal_path_not_allowed", "Internal request path must be an absolute path on the entry.");
    }
    const url = new URL(`${baseUrl}${text}`);
    if (url.origin !== baseUrl) {
      throw internalError("internal_path_not_allowed", "Internal request path must stay on the entry.");
    }
    if (!principal && !isInternalPathAllowed(url.pathname)) {
      throw internalError("internal_path_not_allowed", "Internal request path is not allowed.");
    }
    return { href: `${baseUrl}${url.pathname}${url.search}`, pathname: url.pathname, target: `${url.pathname}${url.search}` };
  }

  function signedHeaders(token, method, target, payload, extraHeaders, accept) {
    const auth = principal
      ? buildMachineHeaders(token, { method, pathWithQuery: target, principal, body: payload })
      : buildInternalRequestHeaders(token, method, target, managerId, payload);
    return {
      ...callerHeaders(extraHeaders),
      ...auth,
      accept,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    };
  }

  async function request(method, pathWithQuery, body, requestOptions = {}) {
    const verb = String(method || "GET").toUpperCase();
    const { href, pathname, target } = resolveTarget(pathWithQuery);
    const payload = encodeBody(verb, body);
    let token = currentKey();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (!token) throw internalError("internal_key_unavailable", "Internal trust key is unavailable.");
      let status;
      let text;
      try {
        const response = await fetchFn(href, {
          method: verb,
          headers: signedHeaders(token, verb, target, payload, requestOptions.headers, "application/json"),
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        if (status === 401 && attempt === 1) {
          await discardBody(response);
          token = reloadKey();
          continue;
        }
        text = await response.text();
      } catch (error) {
        throw transportError(error, pathname);
      }
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      return { status, json };
    }
    // Unreachable: the second attempt always returns or throws.
    throw internalError("internal_unavailable", `Internal request to ${pathname} failed.`);
  }

  // Holds one signed event stream. Each (re)connect re-reads the key and
  // re-signs; a 401 reloads the key and retries once at once, other failures
  // back off (1 s doubling to 30 s) and resume with Last-Event-ID. A 4xx other
  // than 401/408/429 is final. Errors reach onError without any token.
  function sse(pathWithQuery, onEvent, sseOptions = {}) {
    if (typeof onEvent !== "function") throw new TypeError("An internal event stream needs an onEvent callback.");
    const { href, pathname, target } = resolveTarget(pathWithQuery);
    const reconnect = sseOptions.reconnect !== false;
    const minRetryMs = Math.max(10, Number(sseOptions.retryMs ?? SSE_MIN_RETRY_MS));
    const maxRetryMs = Math.max(minRetryMs, Number(sseOptions.maxRetryMs ?? SSE_MAX_RETRY_MS));
    const report = (error) => {
      try { sseOptions.onError?.(error); } catch {}
    };
    let closed = false;
    let controller = null;
    let timer = null;
    let lastEventId = "";
    let retryDelay = minRetryMs;

    async function connectOnce(token, allowKeyReload) {
      if (!token) throw internalError("internal_key_unavailable", "Internal trust key is unavailable.");
      controller = new AbortController();
      const extra = { ...(sseOptions.headers || {}), ...(lastEventId ? { "last-event-id": lastEventId } : {}) };
      let response;
      try {
        response = await fetchFn(href, {
          method: "GET",
          headers: signedHeaders(token, "GET", target, undefined, extra, "text/event-stream"),
          signal: controller.signal,
        });
      } catch (error) {
        throw transportError(error, pathname);
      }
      if (response.status === 401 && allowKeyReload) {
        await discardBody(response);
        return connectOnce(reloadKey(), false);
      }
      if (!response.ok || !response.body) {
        await discardBody(response);
        const final = response.status >= 400 && response.status < 500 && ![401, 408, 429].includes(response.status);
        throw internalError("internal_sse_rejected", `Internal event stream ${pathname} was refused (HTTP ${response.status}).`, {
          status: response.status,
          final,
        });
      }
      retryDelay = minRetryMs;
      try { sseOptions.onOpen?.({ status: response.status }); } catch {}
      const push = createSseParser((event) => {
        if (event.id !== null) lastEventId = event.id;
        try {
          onEvent(event);
        } catch {
          report(internalError("internal_sse_handler_failed", "Internal event handler failed."));
        }
      });
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          push(decoder.decode(value, { stream: true }));
        }
      } catch (error) {
        if (error?.code === "internal_sse_line_too_long") throw error;
        throw transportError(error, pathname);
      } finally {
        try { reader.releaseLock(); } catch {}
      }
      throw internalError("internal_sse_closed", `Internal event stream ${pathname} ended.`);
    }

    async function run() {
      timer = null;
      if (closed) return;
      try {
        await connectOnce(currentKey(), true);
      } catch (error) {
        if (closed) return;
        report(error);
        if (error?.final || !reconnect) return;
      }
      if (closed || !reconnect) return;
      timer = setTimeout(run, retryDelay);
      timer.unref?.();
      retryDelay = Math.min(maxRetryMs, retryDelay * 2);
    }

    run();
    return {
      close() {
        closed = true;
        if (timer) clearTimeout(timer);
        timer = null;
        try { controller?.abort(); } catch {}
      },
    };
  }

  return {
    principal: principal || null,
    managerId: managerId || null,
    baseUrl,
    request,
    sse,
  };
}

module.exports = {
  INTERNAL_PATH_PREFIXES,
  BILLING_PATH_PREFIX,
  MACHINE_PRINCIPAL_RE,
  MANAGER_PRINCIPAL_HEADER,
  MANAGER_TIMESTAMP_HEADER,
  MANAGER_SIGNATURE_HEADER,
  MANAGER_VERSION_HEADER,
  MACHINE_PRINCIPAL_HEADER,
  MACHINE_TIMESTAMP_HEADER,
  MACHINE_SIGNATURE_HEADER,
  MACHINE_BODY_SHA256_HEADER,
  MACHINE_VERSION_HEADER,
  INTERNAL_AUTH_HEADER_NAMES,
  DEFAULT_INTERNAL_BASE_URL,
  DEFAULT_INTERNAL_TIMEOUT_MS,
  DEFAULT_INTERNAL_MAX_SKEW_MS,
  bodySha256Hex,
  normalizeInternalManagerId,
  isMachinePrincipal,
  isInternalPathAllowed,
  signInternal,
  buildInternalRequestHeaders,
  verifyInternalRequest,
  buildMachineHeaders,
  verifyMachineSignature,
  readInternalKey,
  normalizeInternalBaseUrl,
  createInternalClient,
};
