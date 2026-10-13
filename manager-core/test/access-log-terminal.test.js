"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const core = require("..");

function fakeResponse({ statusCode = 200, headersSent = false } = {}) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headersSent = headersSent;
  res.writableFinished = false;
  res.finishResponse = () => {
    res.headersSent = true;
    res.writableFinished = true;
    res.emit("finish");
    res.emit("close");
  };
  return res;
}

function fakeRequest(extra = {}) {
  return {
    method: "POST",
    originalUrl: "/serve/v1/chat/completions?stream=1",
    headers: { "x-request-id": "req_ABCDEFGHIJKLMNOPQRST", "user-agent": "test-client/1.0" },
    socket: { remoteAddress: "::ffff:192.168.1.20" },
    body: { model: "local-model", stream: true },
    ...extra,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("onResponseDone fires once for finish, for close before finish and for finish then close", async () => {
  const finished = fakeResponse();
  const calls = [];
  core.onResponseDone(finished, (state) => calls.push(state));
  finished.finishResponse();
  assert.deepEqual(calls, [{ terminalState: "completed" }]);

  const aborted = fakeResponse();
  const abortCalls = [];
  core.onResponseDone(aborted, (state) => abortCalls.push(state));
  aborted.emit("close");
  aborted.emit("finish");
  aborted.emit("close");
  assert.deepEqual(abortCalls, [{ terminalState: "client_abort" }]);

  // A close that reports a finished writable is still a completed response.
  const lateFinish = fakeResponse();
  const lateCalls = [];
  core.onResponseDone(lateFinish, (state) => lateCalls.push(state));
  lateFinish.writableFinished = true;
  lateFinish.emit("close");
  lateFinish.emit("finish");
  assert.deepEqual(lateCalls, [{ terminalState: "completed" }]);

  const already = fakeResponse();
  already.writableFinished = true;
  const alreadyCalls = [];
  core.onResponseDone(already, (state) => alreadyCalls.push(state));
  await flush();
  assert.deepEqual(alreadyCalls, [{ terminalState: "completed" }]);

  const throwing = fakeResponse();
  core.onResponseDone(throwing, () => { throw new Error("logger failed"); });
  assert.doesNotThrow(() => throwing.emit("close"));
});

test("a client abort before any header logs one 499 entry with client_abort", async () => {
  const entries = [];
  const res = fakeResponse();
  core.attachServiceGatewayAccessLog(fakeRequest(), res, "openai", async (entry) => entries.push(entry));
  res.emit("close");
  res.emit("finish");
  await flush();
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.status, 499);
  assert.equal(entry.terminalState, "client_abort");
  assert.equal(entry.requestId, "req_ABCDEFGHIJKLMNOPQRST");
  assert.equal(entry.socketAddress, "192.168.1.20");
  assert.equal(entry.remoteAddress, "192.168.1.20");
  assert.equal(entry.path, "/serve/v1/chat/completions");
  assert.equal(entry.stream, true);
});

test("a stream aborted after its headers keeps the sent status, and finish then close logs once", async () => {
  const entries = [];
  const append = async (entry) => entries.push(entry);
  const streaming = fakeResponse({ statusCode: 200, headersSent: true });
  core.attachServiceGatewayAccessLog(fakeRequest(), streaming, "openai", append);
  streaming.emit("close");

  const completed = fakeResponse();
  const request = fakeRequest({ headers: {}, serviceGateway: { requestId: "req_FROMGATEWAY0000000000" } });
  core.attachServiceGatewayAccessLog(request, completed, "claude", append);
  completed.finishResponse();
  await flush();

  assert.equal(entries.length, 2);
  assert.equal(entries[0].status, 200);
  assert.equal(entries[0].terminalState, "client_abort");
  assert.equal(entries[1].status, 200);
  assert.equal(entries[1].terminalState, "completed");
  assert.equal(entries[1].requestId, "req_FROMGATEWAY0000000000");

  // A failing or synchronous log sink never throws into the response path.
  const throwingRes = fakeResponse();
  core.attachServiceGatewayAccessLog(fakeRequest(), throwingRes, "openai", () => { throw new Error("disk full"); });
  assert.doesNotThrow(() => throwingRes.finishResponse());
  await flush();
});

test("a request proxied by the trusted entry logs the vouched client and keeps the socket peer", async (t) => {
  const token = "test-gateway-trust-token-0123456789";
  core.configureGatewayTrust(() => token);
  t.after(() => core.configureGatewayTrust(null));
  const headers = { ...core.buildGatewayTrustHeaders(token, "192.168.1.77"), "x-request-id": "req_VOUCHED0000000000000" };
  const entries = [];
  const res = fakeResponse();
  core.attachServiceGatewayAccessLog(fakeRequest({ headers, socket: { remoteAddress: "127.0.0.1" } }), res, "openai", async (entry) => entries.push(entry));
  res.finishResponse();
  await flush();
  assert.equal(entries[0].remoteAddress, "192.168.1.77");
  assert.equal(entries[0].socketAddress, "127.0.0.1");

  // A forged marker without a valid signature logs the socket address.
  const forged = { ...headers, "x-service-entry-signature": "forged" };
  const forgedRes = fakeResponse();
  core.attachServiceGatewayAccessLog(fakeRequest({ headers: forged, socket: { remoteAddress: "127.0.0.1" } }), forgedRes, "openai", async (entry) => entries.push(entry));
  forgedRes.finishResponse();
  await flush();
  assert.equal(entries[1].remoteAddress, "127.0.0.1");
});

test("a real HTTP response logs completed once, and a client that hangs up mid-stream logs client_abort", async (t) => {
  const http = require("node:http");
  const entries = [];
  const server = http.createServer((req, res) => {
    core.attachServiceGatewayAccessLog(req, res, "openai", async (entry) => entries.push(entry));
    if (req.url === "/done") return res.end("ok");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/done" }, (res) => {
      res.resume();
      res.on("end", resolve);
    }).on("error", reject);
  });
  await new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/stream" }, (res) => {
      res.once("data", () => request.destroy());
    });
    request.on("error", () => {});
    request.on("close", resolve);
    request.on("timeout", reject);
  });
  for (let attempt = 0; attempt < 50 && entries.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await flush();
  assert.equal(entries.length, 2);
  const done = entries.find((entry) => entry.path === "/done");
  const stream = entries.find((entry) => entry.path === "/stream");
  assert.equal(done.terminalState, "completed");
  assert.equal(done.status, 200);
  assert.equal(stream.terminalState, "client_abort");
  assert.equal(stream.status, 200, "headers were already sent");
  assert.equal(stream.socketAddress, "127.0.0.1");
});

test("normalizeAccessEvent keeps requestId, terminalState and resolvedInstance", () => {
  const event = core.normalizeAccessEvent({
    at: "2026-10-14T00:00:00.000Z",
    requestId: "req_ABCDEFGHIJKLMNOPQRST",
    terminalState: "client_abort",
    resolvedInstance: "vision",
    remoteAddress: "192.168.1.20",
    socketAddress: "127.0.0.1",
    status: 499,
  }, "192.168.1.2");
  assert.equal(event.requestId, "req_ABCDEFGHIJKLMNOPQRST");
  assert.equal(event.terminalState, "client_abort");
  assert.equal(event.resolvedInstance, "vision");
  assert.equal(event.ok, false);
  const legacy = core.normalizeAccessEvent({ at: "2026-10-14T00:00:00.000Z", status: 200 });
  assert.equal(legacy.requestId, "");
  assert.equal(legacy.terminalState, "");
  assert.equal(legacy.resolvedInstance, "");
});
