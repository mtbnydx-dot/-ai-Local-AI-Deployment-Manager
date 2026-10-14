"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const sqlite = require("node:sqlite");
const { createGatewayRecorder } = require("../telemetry/recorder");
const { openTelemetryStore } = require("../telemetry/store");

const REQUEST_ID = /^req_[a-z2-7]{20}$/;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 30);

function fakeResponse(overrides = {}) {
  return Object.assign(new EventEmitter(), { headersSent: false, statusCode: 200, writableFinished: false }, overrides);
}

function fakeRequest(overrides = {}) {
  return { method: "POST", url: "/gateway/auto/openai/v1/chat/completions?x=1", headers: { "user-agent": "unit/1.0" }, socket: { remoteAddress: "::ffff:192.0.2.7" }, ...overrides };
}

function finish(res, status = 200) {
  res.statusCode = status;
  res.headersSent = true;
  res.writableFinished = true;
  res.emit("finish");
  res.emit("close");
}

// A store that remembers what the recorder writes.
function memoryStore(overrides = {}) {
  const calls = { requests: [], control: [], coverage: [] };
  return {
    calls,
    async insertRequests(rows) {
      calls.requests.push(...rows);
      return { accepted: rows.length, duplicates: 0, rejected: 0, dropped: 0, errors: [] };
    },
    async recordControlCounts(rows) {
      calls.control.push(...rows);
      return { accepted: rows.length, duplicates: 0, rejected: 0, dropped: 0, errors: [] };
    },
    async recordCoverage(rows) {
      calls.coverage.push(...rows);
      return { accepted: rows.length, duplicates: 0, rejected: 0, dropped: 0, errors: [] };
    },
    ...overrides,
  };
}

function quietRecorder(options = {}) {
  return createGatewayRecorder({ logger: null, now: () => NOW, ...options });
}

test("an id minted by the caller is adopted, and a client x-request-id only becomes client_request_id", async () => {
  const recorder = quietRecorder({ store: memoryStore() });
  const adopted = recorder.begin(fakeRequest({ headers: { "x-request-id": "client/abc:1" } }), fakeResponse(), { requestId: "req_abcdefghijklmnopqrst" });
  assert.equal(adopted.requestId, "req_abcdefghijklmnopqrst");
  assert.equal(adopted.clientRequestId, "client/abc:1");

  const minted = recorder.begin(fakeRequest({ headers: { "x-request-id": "req_abcdefghijklmnopqrst" } }), fakeResponse());
  assert.match(minted.requestId, REQUEST_ID);
  assert.notEqual(minted.requestId, "req_abcdefghijklmnopqrst", "an inbound id is never the key");
  assert.equal(minted.clientRequestId, "req_abcdefghijklmnopqrst");

  const refused = recorder.begin(fakeRequest(), fakeResponse(), { requestId: "not-a-request-id", clientRequestId: "bad id with spaces" });
  assert.match(refused.requestId, REQUEST_ID, "a malformed supplied id is replaced");
  assert.equal(refused.clientRequestId, "", "a client id with other characters is dropped");
  await recorder.stop({ flushMs: 50 });
});

test("finalisation uses one finish/close listener pair and rec.done resolves exactly once", async () => {
  const store = memoryStore();
  const recorder = quietRecorder({ store });
  const res = fakeResponse();
  const rec = recorder.begin(fakeRequest(), res, { route: "auto" });
  assert.equal(res.listenerCount("finish"), 1);
  assert.equal(res.listenerCount("close"), 1);

  let resolved = 0;
  const values = [];
  rec.done.then((row) => { resolved += 1; values.push(row); });
  assert.equal(rec.finalized, false);
  finish(res);
  res.emit("close");
  res.emit("finish");
  await rec.done;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, 1);
  assert.equal(values[0].requestId, rec.requestId);
  assert.equal(rec.finalized, true);
  assert.equal(res.listenerCount("finish"), 0, "the pair is removed once settled");
  assert.equal(res.listenerCount("close"), 0);

  await rec.done;
  await recorder.stop({ flushMs: 200 });
  await recorder.flush();
  assert.equal(store.calls.requests.filter((row) => row.requestId === rec.requestId).length, 1, "one row, however often the response signals");
});

test("a close before finish is client_abort: 499 before headers, the sent status after", async () => {
  const store = memoryStore();
  const recorder = quietRecorder({ store });
  const early = fakeResponse();
  const earlyRec = recorder.begin(fakeRequest(), early);
  early.emit("close");
  const earlyRow = await earlyRec.done;
  assert.equal(earlyRow.status, 499);
  assert.equal(earlyRow.terminalState, "client_abort");
  assert.equal(earlyRow.errorClass, "client_abort");
  assert.equal(earlyRow.finishReason, "abort");

  const late = fakeResponse({ headersSent: true, statusCode: 200 });
  const lateRec = recorder.begin(fakeRequest(), late);
  late.emit("close");
  const lateRow = await lateRec.done;
  assert.equal(lateRow.status, 200);
  assert.equal(lateRow.terminalState, "client_abort");
  await recorder.stop({ flushMs: 50 });
});

test("an upstream timeout that ends the request is a timeout row, also when it answered 502", async () => {
  const recorder = quietRecorder({ store: memoryStore() });
  const res = fakeResponse();
  const rec = recorder.begin(fakeRequest(), res);
  rec.dispatched();
  rec.timedOut();
  rec.fail({ status: 502, code: "gateway_proxy_error", phase: "upstream" });
  finish(res, 502);
  const row = await rec.done;
  assert.equal(row.terminalState, "timeout");
  assert.equal(row.errorClass, "upstream_timeout");
  await recorder.stop({ flushMs: 50 });
});

test("a record that never ends is finalised by the safety timer as failed/internal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const recorder = quietRecorder({ store: memoryStore() });
  const rec = recorder.begin(fakeRequest(), fakeResponse(), { timeoutMs: 5000 });
  assert.equal(recorder.inflight(), 1);
  t.mock.timers.tick(5000 + 60_000);
  const row = await rec.done;
  assert.equal(row.terminalState, "failed");
  assert.equal(row.errorClass, "internal");
  assert.equal(recorder.inflight(), 0);
  t.mock.timers.reset();
});

test("timing columns and decode_tps come from the stream, anchored on a monotonic clock", async () => {
  let t = 0;
  const store = memoryStore();
  const recorder = quietRecorder({ store, monotonic: () => t, now: () => NOW });
  const res = fakeResponse();
  const rec = recorder.begin(fakeRequest(), res, { route: "vllm" });
  rec.setRouting({ managerId: "vllm", fleetId: "vllm:primary", modelRequested: "m", modelResolved: "m", stream: true });
  t = 10;
  rec.dispatched();
  t = 40;
  rec.headers(200, { "content-type": "text/event-stream", "x-local-llm-queued-ms": "7" });
  const tap = rec.tap();
  const chunks = [];
  tap.on("data", (chunk) => chunks.push(chunk));
  t = 100;
  tap.write(Buffer.from('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
  t = 1100;
  tap.write(Buffer.from('data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":21}}\n\ndata: [DONE]\n\n'));
  tap.end();
  t = 1100;
  finish(res);
  const row = await rec.done;
  assert.equal(Buffer.concat(chunks).toString("utf8").startsWith('data: {"choices"'), true, "bytes pass through untouched");
  assert.equal(row.upstreamHeadersMs, 30);
  assert.equal(row.ttftMs, 90);
  assert.equal(row.durationMs, 1100);
  assert.equal(row.queueMs, 7);
  assert.equal(row.outputTokens, 21);
  assert.equal(row.promptTokens, 8);
  assert.equal(row.decodeTps, 20, "(21 - 1) tokens over the 1000 ms after the first token");
  assert.equal(row.usageSource, "reported");
  assert.equal(row.stream, 1);
  assert.equal(row.managerRequestId, row.requestId);
  await recorder.stop({ flushMs: 50 });
});

test("control requests produce no row and are counted; refusals on control routes are kept", async () => {
  const store = memoryStore();
  const rows = [];
  const recorder = quietRecorder({ store, onRow: (row) => rows.push(row), flushMs: 20 });
  const polls = [];
  for (let index = 0; index < 3; index += 1) {
    const res = fakeResponse();
    polls.push(recorder.begin(fakeRequest({ method: "GET", url: "/gateway/tts/api/jobs" }), res, { path: "/gateway/tts/api/jobs" }));
    finish(res, 200);
  }
  const unauthorized = fakeResponse();
  const refusedRec = recorder.begin(fakeRequest({ method: "GET", url: "/gateway/tts/api/jobs" }), unauthorized);
  refusedRec.reject({ status: 401, code: "unauthorized" });
  finish(unauthorized, 401);
  const crashed = fakeResponse();
  recorder.begin(fakeRequest({ method: "GET", url: "/gateway/tts/api/jobs" }), crashed);
  finish(crashed, 503);
  await Promise.all(polls.map((rec) => rec.done));
  await recorder.flush();

  assert.deepEqual(polls.map(() => null), [null, null, null]);
  assert.equal(rows.length, 2, "the 401 and the 503 are rows");
  assert.deepEqual(rows.map((row) => row.status).sort(), [401, 503]);
  assert.equal(store.calls.requests.length, 2);
  const counted = Object.fromEntries(store.calls.control.map((row) => [row.statusClass, row.count]));
  assert.deepEqual(counted, { "2xx": 3, "4xx": 1, "5xx": 1 });
  assert.ok(store.calls.control.every((row) => row.route === "tts" && row.bucket === Math.floor(NOW / 60_000) * 60_000));
  await recorder.stop({ flushMs: 50 });
});

test("the recorder marks a minute covered once and keeps rows while the store is unavailable", async () => {
  let store = null;
  const real = memoryStore();
  const recorder = quietRecorder({ store: () => store });
  const res = fakeResponse();
  const rec = recorder.begin(fakeRequest(), res);
  finish(res);
  await rec.done;
  await recorder.flush();
  assert.equal(recorder.stats().buffered, 1, "no store yet: the row waits");

  store = real;
  await recorder.flush();
  await recorder.flush();
  assert.equal(real.calls.requests.length, 1);
  assert.deepEqual(real.calls.coverage, [{ bucket: Math.floor(NOW / 60_000) * 60_000, component: "recorder" }], "one marker per minute");
  assert.equal(recorder.stats().buffered, 0);
  await recorder.stop({ flushMs: 50 });
});

test("a busy store keeps the rows for the next flush; a full buffer drops the oldest", async () => {
  let busy = true;
  const written = [];
  const store = memoryStore({
    async insertRequests(rows) {
      if (busy) return { accepted: 0, duplicates: 0, rejected: 0, dropped: 0, errors: [], error: "telemetry_store_busy", retryable: true };
      written.push(...rows);
      return { accepted: rows.length, duplicates: 0, rejected: 0, dropped: 0, errors: [] };
    },
  });
  const recorder = quietRecorder({ store, bufferMax: 3 });
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    const res = fakeResponse();
    const rec = recorder.begin(fakeRequest(), res);
    ids.push(rec.requestId);
    finish(res);
  }
  await recorder.flush();
  assert.equal(recorder.stats().buffered, 3);
  assert.equal(recorder.stats().dropped, 2);
  busy = false;
  await recorder.flush();
  assert.deepEqual(written.map((row) => row.requestId), ids.slice(2), "the oldest two were dropped");
  await recorder.stop({ flushMs: 50 });
});

test("onRow sees every recorded row and cannot break the response path", async () => {
  const seen = [];
  const recorder = quietRecorder({
    store: memoryStore(),
    onRow: (row, context) => {
      seen.push([row.requestId, Boolean(context.req), Boolean(context.res)]);
      throw new Error("consumer failed");
    },
  });
  const res = fakeResponse();
  const req = fakeRequest();
  const rec = recorder.begin(req, res);
  finish(res);
  const row = await rec.done;
  assert.deepEqual(seen, [[rec.requestId, true, true]]);
  assert.equal(row.status, 200);
  await recorder.stop({ flushMs: 50 });
});

test("stop() finalises what is still in flight as failed/internal and flushes it", async () => {
  const store = memoryStore();
  const recorder = quietRecorder({ store });
  recorder.start();
  const rec = recorder.begin(fakeRequest(), fakeResponse());
  const result = await recorder.stop({ flushMs: 500 });
  assert.equal(result.timedOut, false);
  const row = await rec.done;
  assert.equal(row.terminalState, "failed");
  assert.equal(row.errorClass, "internal");
  assert.equal(row.errorCode, "entry_shutdown");
  assert.equal(store.calls.requests.length, 1);
  assert.equal(recorder.inflight(), 0);
});

test("the store records control counts additively and coverage once per minute, and rejects bad rows", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-recorder-"));
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, inProcess: true, logger: null });
  t.after(async () => {
    await store.close({ flushMs: 200 });
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });
  const bucket = Math.floor(NOW / 60_000) * 60_000;

  const first = await store.recordControlCounts([
    { bucket: bucket + 5000, route: "tts", statusClass: "2xx", count: 3 },
    { bucket, route: "tts", statusClass: "2xx", count: 2 },
    { bucket, route: "gateway", statusClass: "none", count: 1 },
    { bucket, route: "Not A Route", statusClass: "2xx", count: 1 },
    { bucket, route: "tts", statusClass: "9xx", count: 1 },
    { bucket, route: "tts", statusClass: "2xx", count: 0 },
  ]);
  assert.equal(first.accepted, 3);
  assert.equal(first.rejected, 3);
  await store.recordControlCounts([{ bucket, route: "tts", statusClass: "2xx", count: 4 }]);

  const coverage = await store.recordCoverage([{ bucket, component: "recorder" }]);
  const again = await store.recordCoverage([{ bucket: bucket + 1000, component: "recorder" }, { bucket, component: "Bad Name" }]);
  assert.equal(coverage.accepted, 1);
  assert.equal(again.duplicates, 1, "the same minute is idempotent");
  assert.equal(again.rejected, 1);

  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const counts = db.prepare("SELECT route, status_class, count FROM control_counts_1m ORDER BY route, status_class").all();
    assert.deepEqual(counts.map((row) => ({ ...row })), [
      { route: "gateway", status_class: "none", count: 1 },
      { route: "tts", status_class: "2xx", count: 9 },
    ]);
    assert.deepEqual(db.prepare("SELECT bucket, component FROM coverage_1m").all().map((row) => ({ ...row })), [{ bucket, component: "recorder" }]);
  } finally {
    db.close();
  }
  const stats = await store.stats();
  assert.ok(stats.writes.controlCounts1m.accepted >= 4);
});

test("a recorder over a real store writes a complete row, extra included", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-recorder-"));
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, inProcess: true, logger: null });
  const recorder = createGatewayRecorder({ store, logger: null, flushMs: 20 });
  t.after(async () => {
    await recorder.stop({ flushMs: 200 });
    await store.close({ flushMs: 200 });
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });
  const res = fakeResponse();
  const rec = recorder.begin(fakeRequest({ headers: { "user-agent": "unit/1.0", "x-openwebui-chat-id": "chat-1" } }), res, { route: "auto", keyId: "k_demo", clientIp: "::ffff:192.0.2.7" });
  rec.setRouting({ managerId: "llama", modelRequested: "m", modelResolved: "m-resolved", routeReason: "explicit_model" });
  rec.setExtra({ toolSchemaCount: 2, unknownKey: "ignored" });
  rec.dispatched();
  rec.headers(200, { "content-type": "application/json" });
  const tap = rec.tap();
  tap.on("data", () => {});
  tap.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 } } }));
  await new Promise((resolve) => tap.once("end", resolve));
  finish(res);
  await rec.done;
  await recorder.flush();
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const [row] = db.prepare("SELECT * FROM requests").all();
    assert.equal(row.request_id, rec.requestId);
    assert.equal(row.client_ip, "192.0.2.7");
    assert.equal(row.owui_chat_id, "chat-1");
    assert.equal(row.finish_reason, "tool_calls");
    assert.equal(row.reasoning_tokens, 1);
    assert.deepEqual(JSON.parse(row.extra), { routeReason: "explicit_model", toolSchemaCount: 2 });
  } finally {
    db.close();
  }
});
