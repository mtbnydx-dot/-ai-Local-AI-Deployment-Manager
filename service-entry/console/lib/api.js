// API client, error normalization and response guards (07 §3.4).
//
// Every console request goes through createApiClient: JSON in and out, the
// caller's signal combined with a timeout, the request id attached to data
// and errors, and `x-csrf-token` on every non-GET. The CSRF token lives in
// this closure only; it is never stored and never copied into an ApiError.

import { check } from "./guards.js";
import { tk } from "./i18n.js";
import { withQuery } from "./url.js";

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const ENVELOPE_KEYS = new Set(["ok", "error", "errors", "code", "message", "hint", "docs", "details"]);
const ERROR_OBJECT_KEYS = new Set(["code", "message", "hint", "docs"]);
const MANAGER_PATH = /^\/api\/m\/([^/?#]+)/;
const SESSION_PATH = "/api/session";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** A failed console request; `code` is what pages branch on (§3.4 table). */
export class ApiError extends Error {
  constructor({ status = 0, code = "unknown_error", message = "", hint = null, docs = null, fieldErrors = [], requestId = null, managerId = null, details = null } = {}) {
    super(message || code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.docs = docs;
    this.fieldErrors = fieldErrors;
    this.requestId = requestId;
    this.managerId = managerId;
    this.details = details;
  }

  toJSON() {
    return {
      name: this.name, status: this.status, code: this.code, message: this.message, hint: this.hint, docs: this.docs,
      fieldErrors: this.fieldErrors, requestId: this.requestId, managerId: this.managerId, details: this.details,
    };
  }
}

function headerValue(headers, name) {
  try {
    if (typeof headers?.get === "function") return headers.get(name) || null;
    if (isPlainObject(headers)) return headers[name] ?? headers[name.toLowerCase()] ?? null;
  } catch {
    // A broken headers object only loses the request id.
  }
  return null;
}

function managerIdOf(url) {
  try {
    const pathname = String(url || "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").split(/[?#]/)[0];
    const match = MANAGER_PATH.exec(pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function mapFieldErrors(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(isPlainObject).map((item) => ({
    field: typeof item.field === "string" ? item.field : null,
    code: typeof item.code === "string" ? item.code : "invalid",
    message: typeof item.message === "string" ? item.message : "",
    suggestion: item.suggestion === undefined ? null : item.suggestion,
  }));
}

// Everything in the body (and the error object) that is not part of the
// envelope itself: managerId, plan, conflict, … kept for the calling page.
function collectDetails(body) {
  const details = {};
  if (isPlainObject(body.details)) Object.assign(details, body.details);
  for (const [name, value] of Object.entries(body)) {
    if (!ENVELOPE_KEYS.has(name)) details[name] = value;
  }
  if (isPlainObject(body.error)) {
    for (const [name, value] of Object.entries(body.error)) {
      if (!ERROR_OBJECT_KEYS.has(name)) details[name] = value;
    }
  }
  return Object.keys(details).length ? details : null;
}

/**
 * Turns a non-2xx answer into an ApiError (§3.4). `body` is the parsed JSON
 * when there was some, the raw text otherwise.
 */
export function normalizeError({ status = 0, body, headers, url } = {}) {
  const requestId = headerValue(headers, "x-request-id");
  const fromUrl = managerIdOf(url);
  if (typeof body === "string" && body.trim()) {
    return new ApiError({ status, code: "bad_response", message: `HTTP ${status}: the response is not JSON.`, requestId, managerId: fromUrl });
  }
  if (!isPlainObject(body)) {
    return new ApiError({ status, code: `http_${status}`, message: `HTTP ${status}`, requestId, managerId: fromUrl });
  }
  const details = collectDetails(body);
  const managerId = text(details?.managerId) || fromUrl;
  if (isPlainObject(body.error) && text(body.error.code)) {
    return new ApiError({
      status,
      code: body.error.code,
      message: text(body.error.message) || body.error.code,
      hint: body.error.hint ?? body.hint ?? null,
      docs: text(body.error.docs) || null,
      fieldErrors: mapFieldErrors(body.errors),
      requestId,
      managerId,
      details,
    });
  }
  const message = text(body.error) || text(body.message);
  let code = text(body.code);
  if (!code && status === 404 && /^not found\.?$/i.test(message)) code = "endpoint_unavailable";
  if (!code) code = `http_${status}`;
  return new ApiError({
    status,
    code,
    message: message || code,
    hint: body.hint ?? null,
    docs: text(body.docs) || null,
    fieldErrors: mapFieldErrors(body.errors),
    requestId,
    managerId,
    details,
  });
}

function attachRequestId(data, requestId) {
  if (data !== null && typeof data === "object" && requestId) {
    try {
      Object.defineProperty(data, "__requestId", { value: requestId, enumerable: false, configurable: true });
    } catch {
      // Frozen data simply has no request id.
    }
  }
  return data;
}

function parseBody(raw, contentType) {
  if (!raw) return { empty: true };
  const looksJson = /\bjson\b/i.test(contentType || "") || (!contentType && /^[[{]/.test(raw.trim()));
  if (!looksJson) return { text: raw };
  try {
    return { json: JSON.parse(raw) };
  } catch {
    return { text: raw };
  }
}

function simpleError(code, status, requestId, managerId, message) {
  return new ApiError({ status, code, message, requestId, managerId });
}

/**
 * @returns {{ request, get, post, put, patch, del, manager(managerId), csrfHeaders(), setCsrfToken(token) }}
 */
export function createApiClient({ fetchImpl, timeoutMs = 15000, csrfToken = null, onReadOnly, onUnpaired, onStale, base = "" } = {}) {
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : (...args) => globalThis.fetch(...args);
  let token = typeof csrfToken === "string" && csrfToken ? csrfToken : null;

  function notify(hook, error) {
    if (typeof hook !== "function") return;
    try {
      hook(error);
    } catch {
      // A failing hook must not hide the original error.
    }
  }

  async function refreshCsrf() {
    try {
      const session = await send(SESSION_PATH, { method: "GET" }, false);
      if (isPlainObject(session) && typeof session.csrfToken === "string" && session.csrfToken) {
        token = session.csrfToken;
        return true;
      }
    } catch {
      // Fall through: the original csrf_invalid error is thrown.
    }
    return false;
  }

  async function send(path, options = {}, allowRetry = true) {
    const method = String(options.method || "GET").toUpperCase();
    const url = `${base}${withQuery(path, options.query)}`;
    const headers = { accept: "application/json", ...(options.headers || {}) };
    let body;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    if (!SAFE_METHODS.has(method) && token) headers["x-csrf-token"] = token;

    const controller = new AbortController();
    const limit = options.timeoutMs ?? timeoutMs;
    let timedOut = false;
    const timer = limit > 0 ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limit) : null;
    const callerSignal = options.signal;
    const managerId = managerIdOf(url);
    if (callerSignal?.aborted) {
      if (timer) clearTimeout(timer);
      throw simpleError("aborted", 0, null, managerId, "The request was cancelled.");
    }
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener?.("abort", onCallerAbort, { once: true });

    let response;
    let raw = "";
    try {
      response = await doFetch(url, { method, headers, body, signal: controller.signal, credentials: "same-origin" });
      raw = typeof response?.text === "function" ? await response.text() : "";
    } catch {
      if (timedOut) throw simpleError("timeout", 0, null, managerId, `No answer within ${limit} ms.`);
      if (callerSignal?.aborted) throw simpleError("aborted", 0, null, managerId, "The request was cancelled.");
      throw simpleError("network_error", 0, null, managerId, "The entry service could not be reached.");
    } finally {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener?.("abort", onCallerAbort);
    }

    const status = Number(response?.status) || 0;
    const requestId = headerValue(response?.headers, "x-request-id");
    const parsed = parseBody(raw, headerValue(response?.headers, "content-type"));
    const ok = response?.ok ?? (status >= 200 && status < 300);
    if (!ok) {
      const error = normalizeError({ status, body: parsed.json ?? parsed.text, headers: response?.headers, url });
      if (error.code === "csrf_invalid" && !SAFE_METHODS.has(method) && allowRetry && await refreshCsrf()) {
        return send(path, options, false);
      }
      if (status === 401 && error.code === "admin_session_required") notify(onUnpaired, error);
      else if (error.code === "management_local_only") notify(onReadOnly, error);
      else if (status === 410 || error.code === "console_stale") notify(onStale, error);
      throw error;
    }
    if (parsed.text !== undefined) {
      throw simpleError("bad_response", status, requestId, managerId, `HTTP ${status}: the response is not JSON.`);
    }
    let data = parsed.empty ? null : parsed.json;
    if (options.guard) {
      const result = check(options.guard, data);
      if (!result.ok) {
        throw new ApiError({
          status,
          code: "invalid_response",
          message: "The response does not have the expected shape.",
          requestId,
          managerId,
          details: { errors: result.errors.slice(0, 20), dropped: result.dropped },
        });
      }
      data = result.value;
    }
    return attachRequestId(data, requestId);
  }

  function rooted(prefix) {
    const request = (path, options = {}) => send(`${prefix}${path}`, options);
    return {
      request,
      get: (path, options = {}) => request(path, { ...options, method: "GET" }),
      post: (path, body, options = {}) => request(path, { ...options, method: "POST", body }),
      put: (path, body, options = {}) => request(path, { ...options, method: "PUT", body }),
      patch: (path, body, options = {}) => request(path, { ...options, method: "PATCH", body }),
      del: (path, options = {}) => request(path, { ...options, method: "DELETE" }),
    };
  }

  return {
    ...rooted(""),
    /** The same API rooted at /api/m/<managerId> (§3.9). */
    manager(managerId) {
      return rooted(`/api/m/${encodeURIComponent(String(managerId))}`);
    },
    /** For the two direct fetch callers (Playground streams). */
    csrfHeaders() {
      return token ? { "x-csrf-token": token } : {};
    },
    /** After pairing, the new session's token (§3.2 step 1). */
    setCsrfToken(next) {
      token = typeof next === "string" && next ? next : null;
    },
  };
}

/** The catalog key of an error code; `error.code.*` is a dynamic prefix of the shell area. */
export function errorKey(error) {
  return tk("error.code.", error?.code || "unknown_error");
}

/** Display text for an error: its catalog entry, else the server message, else a generic line. */
export function describeError(error, i18n) {
  const vars = { code: error?.code || "", manager: error?.managerId || "", requestId: error?.requestId || "" };
  const key = errorKey(error);
  if (i18n?.has?.(key)) return i18n.t(key, vars);
  if (typeof error?.message === "string" && error.message && error.message !== error.code) return error.message;
  return i18n?.t ? i18n.t("error.unknown", vars) : String(error?.code || "");
}
