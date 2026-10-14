// The portal's API client (05 §12). Every call is same-origin and credential
// free: PUBLIC ignores cookies, and the API key (when there is one) travels in
// the Authorization header only, never in a URL.

export class ApiError extends Error {
  constructor(message, { status = 0, code = "network_error", requestId = "", retryAfter = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

/** A 410 from /assets/<id>/… : this tab runs an older build than the server serves. */
export function isStaleError(error) {
  return error instanceof ApiError && error.status === 410 && error.code === "portal_stale";
}

async function readError(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const error = body && typeof body === "object" ? body.error : null;
  const code = error && typeof error.code === "string" ? error.code : `http_${response.status}`;
  const requestId = body && typeof body.request_id === "string" ? body.request_id : response.headers.get("x-request-id") || "";
  const retry = Number(response.headers.get("retry-after"));
  return new ApiError(typeof error?.message === "string" ? error.message : `HTTP ${response.status}`, {
    status: response.status,
    code,
    requestId,
    retryAfter: Number.isFinite(retry) ? retry : null,
  });
}

/**
 * GET (or another method) -> parsed JSON. Throws ApiError: network failures are
 * { status: 0, code: "network_error" }; an aborted call rethrows the AbortError.
 */
export async function fetchJson(path, { key = "", signal, method = "GET", body, headers = {} } = {}) {
  const init = { method, credentials: "omit", signal, headers: { accept: "application/json", ...headers } };
  if (key) init.headers.authorization = `Bearer ${key}`;
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError("Network error", { code: "network_error" });
  }
  if (!response.ok) throw await readError(response);
  try {
    return await response.json();
  } catch {
    throw new ApiError("The answer was not JSON", { status: response.status, code: "invalid_response" });
  }
}

export const getPortalConfig = (options) => fetchJson("/portal-config.json", options);
export const getStatus = (options) => fetchJson("/status.json", options);
export const getCatalog = (options) => fetchJson("/catalog.json", options);
export const getAnnouncements = (options) => fetchJson("/announcements.json", options);
/** The key's own model list (enriched /v1/models, 05 §8.3). */
export const getKeyModels = (key, options) => fetchJson("/v1/models", { ...options, key });
