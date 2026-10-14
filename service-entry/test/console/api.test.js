// 07 §3.4 API client: every error-normalization row, timeout and abort,
// request ids, guard failures, CSRF handling and token hygiene.

import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApiClient, describeError, errorKey, normalizeError } from "../../console/lib/api.js";
import { createAuditSession } from "../../console/lib/audit-session.js";
import { obj, str } from "../../console/lib/guards.js";
import { createI18n } from "../../console/lib/i18n.js";

const CSRF = "csrf-fake-token-0001";
const NEW_CSRF = "csrf-fake-token-0002";
const AUDIT = "audit-fake-token-0003";

function reply(status, body, headers = {}) {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const contentType = typeof body === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8";
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": contentType, ...headers }),
    text: async () => text,
  };
}

/** A fetch that answers from `routes` (list of (url, init) → reply) and records calls. */
function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    return handler(url, init, calls.length);
  };
  return { fetchImpl, calls };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the request to fail");
}

test("normalizeError maps each §3.4 response row", () => {
  const envelope = normalizeError({
    status: 400,
    body: { ok: false, error: { code: "invalid_field", message: "Bad", hint: "Fix it", docs: "/docs/x" }, errors: [{ field: "contextLength", code: "out_of_range", message: "too big", suggestion: { value: 131072, why: "w" } }] },
    headers: new Headers({ "x-request-id": "req_aaaaaaaaaaaaaaaaaaaa" }),
    url: "/api/launch/plan",
  });
  assert.ok(envelope instanceof ApiError);
  assert.equal(envelope.code, "invalid_field");
  assert.equal(envelope.message, "Bad");
  assert.equal(envelope.hint, "Fix it");
  assert.equal(envelope.docs, "/docs/x");
  assert.equal(envelope.requestId, "req_aaaaaaaaaaaaaaaaaaaa");
  assert.deepEqual(envelope.fieldErrors, [{ field: "contextLength", code: "out_of_range", message: "too big", suggestion: { value: 131072, why: "w" } }]);

  assert.equal(normalizeError({ status: 409, body: { ok: false, error: "text", code: "instance_conflict" } }).code, "instance_conflict");
  assert.equal(normalizeError({ status: 500, body: { error: "boom" } }).code, "http_500");
  assert.equal(normalizeError({ status: 500, body: { error: "boom" } }).message, "boom");
  assert.equal(normalizeError({ status: 404, body: { error: "Not found" } }).code, "endpoint_unavailable");
  assert.equal(normalizeError({ status: 404, body: { ok: false, error: { code: "not_found", message: "Not found." } } }).code, "not_found");
  assert.equal(normalizeError({ status: 502, body: "<html>bad gateway</html>" }).code, "bad_response");
  assert.equal(normalizeError({ status: 503 }).code, "http_503");

  const proxy = normalizeError({ status: 502, body: { ok: false, error: { code: "manager_unreachable", message: "m", managerId: "llama", hint: "start it" } }, url: "/api/m/llama/instances" });
  assert.equal(proxy.code, "manager_unreachable");
  assert.equal(proxy.managerId, "llama");
  assert.equal(normalizeError({ status: 504, body: { ok: false, error: { code: "manager_timeout", message: "m" } }, url: "/api/m/vllm/status?x=1" }).managerId, "vllm");

  const planChanged = normalizeError({ status: 409, body: { ok: false, code: "plan_changed", error: "The plan changed.", plan: { planHash: "sha256:new" } } });
  assert.equal(planChanged.code, "plan_changed");
  assert.deepEqual(planChanged.details, { plan: { planHash: "sha256:new" } });
  const wake = normalizeError({ status: 409, body: { ok: false, error: { code: "wake_would_replace_running", message: "m" }, details: { running: "a", requested: "b" } } });
  assert.equal(wake.code, "wake_would_replace_running");
  assert.deepEqual(wake.details, { running: "a", requested: "b" });
  assert.equal(normalizeError({ status: 409, body: { ok: false, error: "missing key", code: "wake_api_key_missing" } }).code, "wake_api_key_missing");
});

test("a rejected fetch is network_error, a slow one timeout, a cancelled one aborted", async () => {
  const offline = createApiClient({ fetchImpl: async () => {
    throw new TypeError("Failed to fetch");
  } });
  assert.equal((await failure(offline.get("/api/status"))).code, "network_error");

  const hanging = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const slow = createApiClient({ fetchImpl: hanging, timeoutMs: 20 });
  const timedOut = await failure(slow.get("/api/status"));
  assert.equal(timedOut.code, "timeout");
  assert.equal((await failure(slow.get("/api/status", { timeoutMs: 5 }))).code, "timeout", "a per-request timeout wins");

  const controller = new AbortController();
  const client = createApiClient({ fetchImpl: hanging, timeoutMs: 0 });
  const pending = client.get("/api/status", { signal: controller.signal });
  controller.abort();
  assert.equal((await failure(pending)).code, "aborted");
  const preAborted = AbortSignal.abort();
  assert.equal((await failure(client.get("/api/status", { signal: preAborted }))).code, "aborted");
});

test("JSON in and out, query encoding, request id on data and errors", async () => {
  const { fetchImpl, calls } = fakeFetch((url) => (url.startsWith("/api/fail")
    ? reply(500, { ok: false, error: { code: "boom", message: "m" } }, { "x-request-id": "req_bbbbbbbbbbbbbbbbbbbb" })
    : reply(200, { ok: true, items: [1] }, { "x-request-id": "req_cccccccccccccccccccc" })));
  const api = createApiClient({ fetchImpl });
  const data = await api.post("/api/things", { name: "x" }, { query: { b: "2", a: "1", skip: null } });
  assert.deepEqual(data, { ok: true, items: [1] });
  assert.equal(data.__requestId, "req_cccccccccccccccccccc");
  assert.equal(Object.keys(data).includes("__requestId"), false, "the request id is not enumerable");
  assert.equal(calls[0].url, "/api/things?a=1&b=2");
  assert.equal(calls[0].body, JSON.stringify({ name: "x" }));
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.equal(calls[0].headers.accept, "application/json");
  const error = await failure(api.get("/api/fail"));
  assert.equal(error.requestId, "req_bbbbbbbbbbbbbbbbbbbb");
  assert.equal(error.status, 500);
});

test("an empty 2xx body is null; a non-JSON 2xx body is bad_response", async () => {
  const empty = createApiClient({ fetchImpl: async () => ({ status: 204, ok: true, headers: new Headers(), text: async () => "" }) });
  assert.equal(await empty.del("/api/x"), null);
  const html = createApiClient({ fetchImpl: async () => reply(200, "<!doctype html><p>login</p>") });
  assert.equal((await failure(html.get("/api/x"))).code, "bad_response");
});

test("a failing guard throws invalid_response with details instead of returning garbage", async () => {
  const api = createApiClient({ fetchImpl: async () => reply(200, { id: 7 }) });
  const error = await failure(api.get("/api/x", { guard: obj({ id: str }) }));
  assert.equal(error.code, "invalid_response");
  assert.deepEqual(error.details.errors, [{ path: "$.id", expected: "string", got: "number" }]);
  const ok = createApiClient({ fetchImpl: async () => reply(200, { id: "a", extra: 1 }) });
  assert.deepEqual(await ok.get("/api/x", { guard: obj({ id: str }) }), { id: "a", extra: 1 });
});

test("x-csrf-token goes on every non-GET and never on GET; manager() roots at /api/m/<id>", async () => {
  const { fetchImpl, calls } = fakeFetch(() => reply(200, { ok: true }));
  const api = createApiClient({ fetchImpl, csrfToken: CSRF });
  await api.get("/api/status");
  await api.request("/api/status", { method: "HEAD" });
  await api.post("/api/a", {});
  await api.put("/api/a", {});
  await api.patch("/api/a", {});
  await api.del("/api/a");
  await api.manager("vllm").get("/instances");
  await api.manager("vllm").post("/stop", { instanceId: "primary" });
  assert.deepEqual(calls.map((call) => [call.method, call.url, call.headers["x-csrf-token"] || null]), [
    ["GET", "/api/status", null],
    ["HEAD", "/api/status", null],
    ["POST", "/api/a", CSRF],
    ["PUT", "/api/a", CSRF],
    ["PATCH", "/api/a", CSRF],
    ["DELETE", "/api/a", CSRF],
    ["GET", "/api/m/vllm/instances", null],
    ["POST", "/api/m/vllm/stop", CSRF],
  ]);
  assert.deepEqual(api.csrfHeaders(), { "x-csrf-token": CSRF });
  api.setCsrfToken(null);
  assert.deepEqual(api.csrfHeaders(), {});
});

test("csrf_invalid re-reads /api/session once and retries once", async () => {
  const { fetchImpl, calls } = fakeFetch((url, init) => {
    if (url === "/api/session") return reply(200, { ok: true, role: "owner", csrfToken: NEW_CSRF });
    if (init.headers["x-csrf-token"] === NEW_CSRF) return reply(200, { ok: true, done: true });
    return reply(403, { ok: false, error: { code: "csrf_invalid", message: "m", hint: "reload" } });
  });
  const api = createApiClient({ fetchImpl, csrfToken: CSRF });
  assert.deepEqual(await api.post("/api/x", {}), { ok: true, done: true });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["POST /api/x", "GET /api/session", "POST /api/x"]);

  const always = fakeFetch((url) => (url === "/api/session"
    ? reply(200, { ok: true, role: "owner", csrfToken: NEW_CSRF })
    : reply(403, { ok: false, error: { code: "csrf_invalid", message: "m" } })));
  const stubborn = createApiClient({ fetchImpl: always.fetchImpl, csrfToken: CSRF });
  assert.equal((await failure(stubborn.post("/api/x", {}))).code, "csrf_invalid");
  assert.equal(always.calls.length, 3, "one re-read and one retry, never a loop");

  const getCsrf = fakeFetch(() => reply(403, { ok: false, error: { code: "csrf_invalid", message: "m" } }));
  const reader = createApiClient({ fetchImpl: getCsrf.fetchImpl, csrfToken: CSRF });
  await failure(reader.get("/api/x"));
  assert.equal(getCsrf.calls.length, 1, "a GET is never retried for CSRF");
});

test("401 admin_session_required calls onUnpaired and is not retried; 403 local-only calls onReadOnly; 410 calls onStale", async () => {
  const seen = [];
  const answers = {
    "/api/a": reply(401, { ok: false, error: { code: "admin_session_required", message: "m" } }),
    "/api/b": reply(403, { ok: false, error: "only here", code: "management_local_only" }),
    "/api/c": reply(410, { ok: false, error: { code: "console_stale", message: "m", hint: "reload" } }),
    "/api/m/vllm/instances": reply(502, { ok: false, error: { code: "manager_unreachable", message: "m", managerId: "vllm" } }),
  };
  const { fetchImpl, calls } = fakeFetch((url) => answers[url]);
  const api = createApiClient({
    fetchImpl,
    csrfToken: CSRF,
    onUnpaired: (error) => seen.push(["unpaired", error.code]),
    onReadOnly: (error) => seen.push(["readonly", error.code]),
    onStale: (error) => seen.push(["stale", error.code]),
  });
  assert.equal((await failure(api.post("/api/a", {}))).code, "admin_session_required");
  assert.equal((await failure(api.post("/api/b", {}))).code, "management_local_only");
  assert.equal((await failure(api.get("/api/c"))).code, "console_stale");
  const down = await failure(api.manager("vllm").get("/instances"));
  assert.equal(down.code, "manager_unreachable");
  assert.equal(down.managerId, "vllm");
  assert.deepEqual(seen, [["unpaired", "admin_session_required"], ["readonly", "management_local_only"], ["stale", "console_stale"]]);
  assert.equal(calls.length, 4, "nothing was retried");
});

test("409 conflicts keep their code and details for the page", async () => {
  const api = createApiClient({ fetchImpl: async () => reply(409, { ok: false, code: "plan_changed", error: "changed", plan: { planHash: "sha256:b" } }) });
  const error = await failure(api.post("/api/m/vllm/launch", { expectedPlanHash: "sha256:a" }));
  assert.equal(error.code, "plan_changed");
  assert.equal(error.details.plan.planHash, "sha256:b");
});

test("the CSRF and audit tokens never appear in an ApiError", async () => {
  const audit = createAuditSession({ now: () => Date.parse("2026-10-14T08:00:00Z") });
  assert.equal(audit.unlock({ ok: true, expiresAt: "2026-10-14T09:00:00Z", token: AUDIT }), true);
  const answers = [
    () => reply(403, { ok: false, error: { code: "csrf_invalid", message: "m" } }),
    () => reply(500, { ok: false, error: { code: "boom", message: "m" } }),
    () => reply(500, "<html>trace</html>"),
    () => {
      throw new Error(`socket closed ${CSRF}`);
    },
  ];
  for (const answer of answers) {
    const api = createApiClient({ fetchImpl: async () => answer(), csrfToken: CSRF, timeoutMs: 0 });
    const error = await failure(api.post("/api/audit/chats/x", { q: 1 }, { headers: audit.headers() }));
    const dump = [JSON.stringify(error), error.message, String(error.stack), String(error), JSON.stringify(Object.entries(error))].join("\n");
    assert.equal(dump.includes(CSRF), false, `CSRF token leaked in ${error.code}`);
    assert.equal(dump.includes(AUDIT), false, `audit token leaked in ${error.code}`);
  }
  assert.equal(JSON.stringify(audit).includes(AUDIT), false, "the audit session never serialises its token");
});

test("errorKey and describeError use the error.code.* catalog keys", () => {
  const i18n = createI18n({ locale: "en-US", catalog: {
    "error.code.manager_unreachable": "{manager} is not running",
    "error.unknown": "Request failed ({code})",
  } });
  assert.equal(errorKey({ code: "timeout" }), "error.code.timeout");
  assert.equal(describeError(new ApiError({ code: "manager_unreachable", managerId: "llama" }), i18n), "llama is not running");
  assert.equal(describeError(new ApiError({ code: "odd", message: "Server says no" }), i18n), "Server says no");
  assert.equal(describeError(new ApiError({ code: "odd" }), i18n), "Request failed (odd)");
});
