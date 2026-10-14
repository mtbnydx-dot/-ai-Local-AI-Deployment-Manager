"use strict";

// HTTP layer shared by the hub's metadata providers (03 §4.2, §17).
//
// The rule this file enforces: a Hugging Face credential is only ever
// attached to a request for huggingface.co or a subdomain of it, over https.
// authorizedFetch follows redirects by hand (the runtime would carry the
// Authorization header across a redirect to a CDN or a mirror), so every hop
// is judged on its own host. Asking it to send a credential to any other
// host is a bug in the caller and throws credential_host_violation before a
// byte leaves the process.

const DEFAULT_TIMEOUT_MS = 15 * 1000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HF_HOST = "huggingface.co";

// Errors whose request may succeed against another endpoint or a little
// later (a mirror fallback is allowed for them).
const NETWORK_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Error raised by the providers. `code` is the hub code (an 08 download code
 * where one fits, otherwise a provider_* code with a `baseCode`), `status` the
 * HTTP status when there was one, `networkClass` whether another endpoint may
 * answer, and `details` structured, secret-free context.
 */
class ProviderError extends Error {
  constructor(code, message, { status = null, baseCode = null, networkClass = false, retryable = false, details = null, cause = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.baseCode = baseCode || code;
    this.status = status;
    this.networkClass = networkClass;
    this.retryable = retryable;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function parseUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    throw new ProviderError("provider_bad_url", "The provider URL is not valid.", { baseCode: "unknown" });
  }
}

/** True for huggingface.co and its subdomains (text or URL object). */
function isHuggingFaceHost(value) {
  let hostname = "";
  try {
    hostname = (value instanceof URL ? value : new URL(String(value).includes("://") ? String(value) : `https://${value}`)).hostname;
  } catch {
    return false;
  }
  hostname = hostname.toLowerCase().replace(/\.$/, "");
  return hostname === HF_HOST || hostname.endsWith(`.${HF_HOST}`);
}

// Credentials need both the host and a TLS connection.
function credentialsAllowed(url) {
  return url.protocol === "https:" && isHuggingFaceHost(url);
}

function credentialHostViolation(url) {
  return new ProviderError(
    "credential_host_violation",
    `A Hugging Face credential must not be sent to ${url.hostname}; it is only sent to ${HF_HOST} over https.`,
    { baseCode: "hf_auth_invalid", details: { host: url.hostname, protocol: url.protocol } },
  );
}

function combineSignals(signal, timeoutMs) {
  const signals = [];
  if (signal) signals.push(signal);
  if (Number(timeoutMs) > 0) signals.push(AbortSignal.timeout(Number(timeoutMs)));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function discardBody(response) {
  try {
    const cancelled = response?.body?.cancel?.();
    if (cancelled && typeof cancelled.catch === "function") cancelled.catch(() => {});
  } catch {
    // The body was already consumed or closed.
  }
}

/**
 * authorizedFetch(url, { token, fetchImpl, timeoutMs, maxRedirects, signal,
 * headers, method, body, ... }) → Response.
 *
 * - `token` (or a caller-supplied authorization header, which is treated the
 *   same way) is attached only while the request is for huggingface.co or a
 *   subdomain over https. For any other first host the call throws
 *   credential_host_violation without issuing a request.
 * - Redirects are followed manually, at most `maxRedirects` (5). Every hop is
 *   judged on its own host: a hop off huggingface.co is issued without the
 *   credential (and without cookies when the origin changed), so a CDN or
 *   mirror redirect never sees the token. The runtime's own redirect
 *   handling is never used (`redirect: "manual"`).
 * - A https to http redirect and any other scheme are refused.
 * - The default timeout is 15 s for the whole call, redirects included.
 */
async function authorizedFetch(url, options = {}) {
  const {
    token = "",
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
    signal,
    headers,
    method: requestedMethod,
    body: requestedBody,
    redirect: _ignoredRedirect,
    ...rest
  } = options;
  if (typeof fetchImpl !== "function") throw new TypeError("authorizedFetch needs a fetch implementation");

  let current = parseUrl(url);
  if (current.protocol !== "https:" && current.protocol !== "http:") {
    throw new ProviderError("provider_bad_url", `Unsupported URL protocol ${current.protocol}`, { baseCode: "unknown" });
  }
  const baseHeaders = new Headers(headers || undefined);
  const callerAuthorization = baseHeaders.get("authorization");
  baseHeaders.delete("authorization");
  const trimmedToken = typeof token === "string" ? token.trim() : "";
  const credential = trimmedToken ? `Bearer ${trimmedToken}` : callerAuthorization || "";
  if (credential && !credentialsAllowed(current)) throw credentialHostViolation(current);

  const combined = combineSignals(signal, timeoutMs);
  let method = String(requestedMethod || "GET").toUpperCase();
  let body = requestedBody;
  for (let hops = 0; ; hops += 1) {
    const hopHeaders = new Headers(baseHeaders);
    if (credential && credentialsAllowed(current)) hopHeaders.set("authorization", credential);
    const response = await fetchImpl(current.href, {
      ...rest,
      method,
      ...(body !== undefined && body !== null ? { body } : {}),
      headers: Object.fromEntries(hopHeaders.entries()),
      redirect: "manual",
      ...(combined ? { signal: combined } : {}),
    });
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers?.get?.("location") : null;
    if (!location) return response;
    discardBody(response);
    if (hops >= maxRedirects) {
      throw new ProviderError("provider_redirect_loop", `The provider redirected more than ${maxRedirects} times.`, {
        status: response.status,
        baseCode: "network_unreachable",
        networkClass: true,
      });
    }
    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new ProviderError("provider_bad_response", "The provider sent an invalid redirect location.", { status: response.status, baseCode: "unknown" });
    }
    if (next.protocol !== "https:" && next.protocol !== "http:") {
      throw new ProviderError("provider_bad_response", `The provider redirected to an unsupported scheme (${next.protocol}).`, { status: response.status, baseCode: "unknown" });
    }
    if (current.protocol === "https:" && next.protocol === "http:") {
      throw new ProviderError("provider_bad_response", "The provider redirected from https to http.", { status: response.status, baseCode: "unknown" });
    }
    if (next.origin !== current.origin) baseHeaders.delete("cookie");
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
      method = "GET";
      body = undefined;
    }
    current = next;
  }
}

/**
 * Turns whatever a fetch implementation threw into a ProviderError:
 * ProviderErrors pass through, a timeout becomes provider_timeout and any
 * other transport failure provider_unreachable (both network class). A
 * caller-initiated abort is rethrown untouched, so it is never mistaken for
 * an outage.
 */
function wrapTransportError(error, { signal } = {}) {
  if (error instanceof ProviderError) return error;
  if (signal?.aborted || error?.name === "AbortError") return error;
  if (error?.name === "TimeoutError") {
    return new ProviderError("provider_timeout", "The provider did not answer in time.", {
      baseCode: "network_unreachable",
      networkClass: true,
      retryable: true,
      cause: error,
    });
  }
  const code = String(error?.cause?.code || error?.code || "");
  return new ProviderError("provider_unreachable", `The provider could not be reached${code ? ` (${code})` : ""}.`, {
    baseCode: "network_unreachable",
    networkClass: true,
    retryable: true,
    details: code ? { errno: code } : null,
    cause: error,
  });
}

/** True when another endpoint (a mirror) may answer a request that failed with `error`. */
function isNetworkClassError(error) {
  return Boolean(error) && error.networkClass === true;
}

function retryAfterSeconds(response) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 86400);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.min(86400, Math.ceil((at - Date.now()) / 1000))) : null;
}

/**
 * Maps a non-2xx provider response to a ProviderError (08 download codes
 * where they fit). Hugging Face's own x-error-code header is more specific
 * than the status: a missing repo can answer 401 to an anonymous caller.
 * The response body is never echoed.
 */
function providerHttpError(response, { tokenSent = false, what = "request" } = {}) {
  discardBody(response);
  const status = Number(response.status) || 0;
  const hfCode = String(response.headers?.get?.("x-error-code") || "");
  const details = { status, ...(hfCode ? { hfErrorCode: hfCode } : {}), tokenSent: Boolean(tokenSent) };
  if (hfCode === "RepoNotFound" || (status === 404 && hfCode !== "RevisionNotFound" && hfCode !== "EntryNotFound")) {
    return new ProviderError("repo_not_found", `The repository was not found (${what}).`, { status, details });
  }
  if (hfCode === "RevisionNotFound") return new ProviderError("revision_not_found", `The revision was not found (${what}).`, { status, details });
  if (hfCode === "EntryNotFound") return new ProviderError("file_not_found", `The file was not found (${what}).`, { status, baseCode: "repo_not_found", details });
  if (hfCode === "GatedRepo" || status === 403) {
    return new ProviderError("hf_approval_required", `Access to this repository needs approval (${what}).`, { status, details });
  }
  if (status === 401) {
    return new ProviderError("hf_auth_invalid", `The provider refused the request as unauthenticated (${what}).`, { status, details });
  }
  if (status === 429) {
    return new ProviderError("rate_limited", "The provider is rate limiting requests.", {
      status,
      networkClass: true,
      retryable: true,
      details: { ...details, retryAfterSeconds: retryAfterSeconds(response) },
    });
  }
  if (NETWORK_STATUSES.has(status)) {
    return new ProviderError("provider_http_error", `The provider is unavailable (HTTP ${status}).`, {
      status,
      baseCode: "network_unreachable",
      networkClass: true,
      retryable: true,
      details,
    });
  }
  return new ProviderError("provider_http_error", `The provider answered HTTP ${status} (${what}).`, {
    status,
    baseCode: "unknown",
    retryable: status >= 500,
    details,
  });
}

function tooLarge(maxBytes) {
  return new ProviderError("provider_response_too_large", `The provider response is larger than ${maxBytes} bytes.`, {
    baseCode: "unknown",
    details: { maxBytes },
  });
}

/**
 * Reads at most maxBytes of a response body. Streaming bodies are cancelled
 * as soon as the cap is crossed; bodies that cannot stream (the proxy
 * tunnel's response object) are read whole and cut. With allowTruncate the
 * result is cut at maxBytes and flagged, otherwise crossing the cap throws
 * provider_response_too_large.
 */
async function readCapped(response, maxBytes, { allowTruncate = false } = {}) {
  const limit = Math.max(1, Math.floor(Number(maxBytes) || 0));
  const declared = Number(response.headers?.get?.("content-length"));
  if (!allowTruncate && Number.isFinite(declared) && declared > limit) {
    discardBody(response);
    throw tooLarge(limit);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const whole = Buffer.from(await response.arrayBuffer());
    if (whole.length <= limit) return { buffer: whole, truncated: false };
    if (!allowTruncate) throw tooLarge(limit);
    return { buffer: whole.subarray(0, limit), truncated: true };
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (total + chunk.length > limit) {
        if (!allowTruncate) throw tooLarge(limit);
        chunks.push(chunk.subarray(0, limit - total));
        total = limit;
        return { buffer: Buffer.concat(chunks, total), truncated: true };
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already finished.
    }
  }
  return { buffer: Buffer.concat(chunks, total), truncated: false };
}

/** Parses a JSON body of at most maxBytes (provider_response_too_large beyond it). */
async function cappedJson(response, maxBytes) {
  const { buffer } = await readCapped(response, maxBytes);
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("provider_bad_response", "The provider answered with a body that is not valid JSON.", { baseCode: "unknown" });
  }
}

/** Reads UTF-8 text of at most maxBytes → { text, truncated }; never splits a character into garbage at the cut. */
async function cappedText(response, maxBytes) {
  const { buffer, truncated } = await readCapped(response, maxBytes, { allowTruncate: true });
  let text = buffer.toString("utf8").replace(/^﻿/, "");
  if (truncated) text = text.replace(/�+$/, "");
  return { text, truncated };
}

/**
 * Parses an RFC 8288 Link header → [{ url, rel: string[], params }]. Commas
 * inside <...> do not split links.
 */
function parseLinkHeader(value) {
  const links = [];
  const text = String(value || "");
  const pattern = /<([^>]*)>((?:\s*;\s*[^;,<]+(?:="[^"]*")?)*)/g;
  for (const match of text.matchAll(pattern)) {
    const params = {};
    for (const part of match[2].split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      const key = part.slice(0, separator).trim().toLowerCase();
      if (!key) continue;
      params[key] = part.slice(separator + 1).trim().replace(/^"|"$/g, "");
    }
    links.push({ url: match[1].trim(), rel: String(params.rel || "").toLowerCase().split(/\s+/).filter(Boolean), params });
  }
  return links;
}

/** The rel="next" URL of a response's Link header, or null. */
function nextLinkOf(response) {
  const header = response.headers?.get?.("link");
  if (!header) return null;
  return parseLinkHeader(header).find((link) => link.rel.includes("next") && link.url)?.url || null;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  HF_HOST,
  MAX_REDIRECTS,
  ProviderError,
  authorizedFetch,
  cappedJson,
  cappedText,
  credentialHostViolation,
  credentialsAllowed,
  isHuggingFaceHost,
  isNetworkClassError,
  nextLinkOf,
  parseLinkHeader,
  providerHttpError,
  readCapped,
  wrapTransportError,
};
