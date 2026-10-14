"use strict";

// Range reads and bounded fetches for the remote inspector (docs/overhaul/
// 02-models.md §6.1).
//
// readRange(url, {start, length, maxBytes, fetchImpl, headers, signal}) sends
// `Range: bytes=start-(start+length-1)`:
//   206  read fully, bounded by `length`;
//   200  the server ignored Range: the body is streamed and cancelled as soon
//        as the bytes the caller asked for (or `maxBytes`) are in, so a body is
//        never read beyond `maxBytes`. The result is flagged `rangeIgnored`
//        and holds what the stream gave for the requested window;
//   416  an empty result (the window starts past the end of the file).
// The result is a Buffer carrying `status`, `rangeIgnored` and `totalBytes`.
//
// The module also holds the pieces every remote request shares: redirects are
// followed by hand so a credential header is decided per hop (hf.js sends a
// token to the official endpoint or a configured mirror only, never on to a
// CDN), every request has a timeout inside the total inspect budget (45 s),
// and bodies are read with a hard byte cap.

const { fetchWithSystemProxyFallback } = require("../../proxy-fetch");

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const TOTAL_BUDGET_MS = 45_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "local-model-manager-inspector/1.0";

class RemoteError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
    Object.assign(this, extra);
  }
}

function abortError() {
  const error = new Error("The inspection was cancelled.");
  error.name = "AbortError";
  error.code = "aborted";
  return error;
}

/**
 * createBudget({totalMs, requestMs, signal, now}) -> the 45 s inspect budget.
 * timeoutFor() is the timeout of the next request: 12 s, or what is left.
 * `now` is injectable so tests can move the clock.
 */
function createBudget({ totalMs = TOTAL_BUDGET_MS, requestMs = REQUEST_TIMEOUT_MS, signal = null, now = Date.now } = {}) {
  const total = Number.isFinite(Number(totalMs)) && Number(totalMs) > 0 ? Number(totalMs) : TOTAL_BUDGET_MS;
  const perRequest = Number.isFinite(Number(requestMs)) && Number(requestMs) > 0 ? Number(requestMs) : REQUEST_TIMEOUT_MS;
  const deadline = now() + total;
  return {
    totalMs: total,
    requestMs: perRequest,
    signal,
    now,
    remaining: () => Math.max(0, deadline - now()),
    exhausted: () => now() >= deadline,
    timeoutFor: () => Math.max(1, Math.min(perRequest, deadline - now())),
    // Throws before a request starts once the budget is spent or the caller cancelled.
    check() {
      if (signal?.aborted) throw abortError();
      if (now() >= deadline) throw new RemoteError("budget_exhausted", `The remote inspection budget of ${Math.round(total / 1000)} s is spent.`);
    },
  };
}

function combineSignals(signal, timeoutMs) {
  const signals = [];
  if (signal) signals.push(signal);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (!signals.length) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/** The transport: an injected fetch is used as given; the default goes through the system proxy fallback. */
function transportOf(fetchImpl) {
  if (typeof fetchImpl === "function") return fetchImpl;
  return (url, init) => fetchWithSystemProxyFallback(globalThis.fetch, url, init);
}

function describeNetworkError(error) {
  // Codes and names only: a fetch error's cause can carry request details.
  const code = typeof error?.cause?.code === "string" ? error.cause.code : typeof error?.code === "string" ? error.code : "";
  return code || error?.name || "network error";
}

async function discard(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Nothing to do; the connection is dropped either way.
  }
}

/**
 * fetchChecked(url, {fetchImpl, headers, headersFor, signal, timeoutMs, maxRedirects, allowRedirect})
 * -> {response, url}. One GET with a timeout. Redirects are followed here,
 * each hop with `headersFor(hopUrl)` (so credentials are decided per host);
 * https never downgrades to http, and `allowRedirect(url)` may refuse a hop.
 * Throws RemoteError: timeout, unreachable, too_many_redirects,
 * redirect_refused. A caller abort throws an AbortError.
 */
async function fetchChecked(url, options = {}) {
  const send = transportOf(options.fetchImpl);
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : MAX_REDIRECTS;
  let current = String(url);
  for (let hop = 0; ; hop += 1) {
    if (options.signal?.aborted) throw abortError();
    const headers = options.headersFor ? options.headersFor(current) : (options.headers || {});
    let response;
    try {
      response = await send(current, {
        method: options.method || "GET",
        headers: { "user-agent": USER_AGENT, ...headers },
        redirect: "manual",
        signal: combineSignals(options.signal, options.timeoutMs),
      });
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new RemoteError("timeout", `The request did not finish within ${Math.round((options.timeoutMs || 0) / 1000)} s.`);
      }
      throw new RemoteError("unreachable", `The request failed (${describeNetworkError(error)}).`);
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers?.get?.("location") : null;
    if (!location) return { response, url: current };
    await discard(response);
    if (hop >= maxRedirects) throw new RemoteError("too_many_redirects", "The server redirected too many times.");
    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new RemoteError("redirect_refused", "The server sent an invalid redirect.");
    }
    const from = new URL(current);
    if (!/^https?:$/.test(next.protocol) || (from.protocol === "https:" && next.protocol !== "https:") || next.username || next.password) {
      throw new RemoteError("redirect_refused", "The redirect target is not allowed.");
    }
    if (options.allowRedirect && !options.allowRedirect(next.href)) {
      throw new RemoteError("redirect_refused", "The redirect target is not allowed.");
    }
    current = next.href;
  }
}

/**
 * readBody(response, cap) -> {buffer, capped}. Reads the body stream chunk by
 * chunk and cancels it once `cap` bytes are in (capped: the cap was reached,
 * so there may be more). Without a stream (a minimal fake response) the whole
 * body is read and cut to the cap.
 */
async function readBody(response, cap) {
  const limit = Math.max(0, Math.floor(cap));
  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    let capped = false;
    try {
      while (total < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        const room = limit - total;
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          total += room;
          capped = true;
          break;
        }
        chunks.push(chunk);
        total += chunk.length;
      }
      if (total >= limit) capped = true;
    } finally {
      if (capped) await reader.cancel().catch(() => {});
      reader.releaseLock?.();
    }
    return { buffer: Buffer.concat(chunks), capped };
  }
  let whole;
  if (typeof response.arrayBuffer === "function") whole = Buffer.from(await response.arrayBuffer());
  else if (typeof response.text === "function") whole = Buffer.from(await response.text(), "utf8");
  else whole = Buffer.alloc(0);
  return { buffer: whole.length > limit ? whole.subarray(0, limit) : whole, capped: whole.length >= limit };
}

function tagged(buffer, info) {
  const result = Buffer.from(buffer);
  result.status = info.status;
  result.rangeIgnored = Boolean(info.rangeIgnored);
  result.totalBytes = Number.isSafeInteger(info.totalBytes) ? info.totalBytes : null;
  return result;
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || "").trim());
  if (match) return { start: Number(match[1]), end: Number(match[2]), total: match[3] === "*" ? null : Number(match[3]) };
  const unsatisfied = /^bytes\s+\*\/(\d+)$/i.exec(String(value || "").trim());
  return unsatisfied ? { start: null, end: null, total: Number(unsatisfied[1]) } : null;
}

/**
 * readRange(url, {start, length, maxBytes, fetchImpl, headers, headersFor, signal, timeoutMs}) -> Promise<Buffer>
 * The Buffer carries `status`, `rangeIgnored` and `totalBytes`. Throws
 * RemoteError `http_error` (with `status`) for other statuses, and the
 * fetchChecked errors.
 */
async function readRange(url, options = {}) {
  const start = Number(options.start ?? 0);
  const length = Number(options.length);
  const maxBytes = Math.max(1, Math.floor(Number(options.maxBytes) || DEFAULT_MAX_BYTES));
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1) {
    throw new TypeError("readRange needs a start >= 0 and a length >= 1.");
  }
  const want = Math.min(length, maxBytes);
  const range = `bytes=${start}-${start + want - 1}`;
  const { response } = await fetchChecked(url, {
    ...options,
    headers: { ...(options.headers || {}), range, accept: "*/*" },
    headersFor: options.headersFor ? (target) => ({ ...options.headersFor(target), range, accept: "*/*" }) : undefined,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  });
  const { status } = response;
  if (status === 416) {
    const total = parseContentRange(response.headers?.get?.("content-range"))?.total ?? null;
    await discard(response);
    return tagged(Buffer.alloc(0), { status, rangeIgnored: false, totalBytes: total });
  }
  if (status === 206) {
    const info = parseContentRange(response.headers?.get?.("content-range"));
    if (info && info.start !== null && info.start !== start) {
      await discard(response);
      throw new RemoteError("range_mismatch", "The server answered a different byte range than requested.");
    }
    const { buffer } = await readBody(response, want);
    return tagged(buffer, { status, rangeIgnored: false, totalBytes: info?.total ?? null });
  }
  if (status === 200) {
    // Range ignored: the body starts at byte 0. Read only as far as the
    // requested window (and never past maxBytes), then slice the window out.
    const cap = Math.min(maxBytes, start + want);
    const { buffer } = await readBody(response, cap);
    const length200 = Number(response.headers?.get?.("content-length"));
    const window = start < buffer.length ? buffer.subarray(start, Math.min(buffer.length, start + want)) : Buffer.alloc(0);
    return tagged(window, { status, rangeIgnored: true, totalBytes: Number.isSafeInteger(length200) ? length200 : null });
  }
  await discard(response);
  throw new RemoteError("http_error", `The server answered HTTP ${status}.`, { status });
}

/** Normalises what an injected readRange returned: a Buffer, or {buffer|bytes, rangeIgnored}. */
function normalizeRangeResult(value) {
  if (value instanceof Uint8Array) {
    return { buffer: Buffer.from(value.buffer, value.byteOffset, value.byteLength), rangeIgnored: Boolean(value.rangeIgnored) };
  }
  const raw = value?.buffer ?? value?.bytes;
  if (raw instanceof Uint8Array) {
    return { buffer: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), rangeIgnored: Boolean(value.rangeIgnored) };
  }
  throw new RemoteError("range_failed", "The range reader returned no bytes.");
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;

function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RemoteError("timeout", "The range reader did not answer in time.")), ms);
    const onAbort = () => reject(abortError());
    signal?.addEventListener?.("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    });
  });
}

/**
 * createRepoReader({fileUrl, headersFor, fetchImpl, readRange, budget, maxBytes})
 * -> {fetchFile(name, {maxBytes}), rangeRead(name, start, length)}
 * The two reads a hub client needs, under the inspect budget.
 *   fetchFile: GET a small file (default cap 8 MiB). Resolves
 *     {ok:true, buffer} or {ok:false, code} with code file_too_large,
 *     unauthorized (401/403), not_found, http_error, timeout, unreachable.
 *     A cancelled inspection throws an AbortError; a spent budget throws
 *     RemoteError budget_exhausted.
 *   rangeRead: a header window of a weight file. An injected `readRange`
 *     (the hub's mirror-aware reader) replaces the built-in one; both get the
 *     same arguments (02 §3.2) and resolve {buffer, rangeIgnored}.
 */
function createRepoReader({ fileUrl, headersFor, fetchImpl, readRange: injected, budget, maxBytes = DEFAULT_MAX_BYTES }) {
  async function fetchFile(name, options = {}) {
    const limit = options.maxBytes || MAX_FILE_BYTES;
    budget.check();
    let fetched;
    try {
      fetched = await fetchChecked(fileUrl(name), { fetchImpl, headersFor, signal: budget.signal, timeoutMs: budget.timeoutFor() });
    } catch (error) {
      if (error instanceof RemoteError) return { ok: false, code: error.code };
      throw error;
    }
    const { response } = fetched;
    if (response.status === 401 || response.status === 403) {
      await discard(response);
      return { ok: false, code: "unauthorized", status: response.status };
    }
    if (response.status === 404) {
      await discard(response);
      return { ok: false, code: "not_found", status: 404 };
    }
    if (response.status !== 200) {
      await discard(response);
      return { ok: false, code: "http_error", status: response.status };
    }
    try {
      const { buffer } = await readBody(response, limit + 1);
      if (buffer.length > limit) return { ok: false, code: "file_too_large" };
      return { ok: true, buffer };
    } catch (error) {
      if (budget.signal?.aborted) throw abortError();
      return { ok: false, code: error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "unreachable" };
    }
  }

  async function rangeRead(name, start, length) {
    budget.check();
    const url = fileUrl(name);
    if (typeof injected === "function") {
      const timeoutMs = budget.timeoutFor();
      let value;
      try {
        value = await withTimeout(Promise.resolve(injected(url, {
          start,
          length,
          maxBytes,
          fetchImpl,
          headers: headersFor(url),
          signal: combineSignals(budget.signal, timeoutMs),
        })), timeoutMs, budget.signal);
      } catch (error) {
        if (error instanceof RemoteError || error?.name === "AbortError") throw error;
        throw new RemoteError("range_failed", "The range reader failed.");
      }
      return normalizeRangeResult(value);
    }
    const buffer = await readRange(url, { start, length, maxBytes, fetchImpl, headersFor, signal: budget.signal, timeoutMs: budget.timeoutFor() });
    return { buffer, rangeIgnored: buffer.rangeIgnored };
  }

  return { fetchFile, rangeRead };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  MAX_FILE_BYTES,
  MAX_REDIRECTS,
  REQUEST_TIMEOUT_MS,
  RemoteError,
  TOTAL_BUDGET_MS,
  USER_AGENT,
  abortError,
  createBudget,
  createRepoReader,
  discard,
  fetchChecked,
  normalizeRangeResult,
  parseContentRange,
  readBody,
  readRange,
  transportOf,
};
