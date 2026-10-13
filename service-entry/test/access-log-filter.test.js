const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// The entry reads its upstream ports when it is loaded, so the fake upstreams
// start first and the entry is required afterwards (see setup()).
const CLEARED_ENV = [
  "SERVICE_ENTRY_HOST",
  "SERVICE_ENTRY_REQUIRE_API_KEY",
  "SERVICE_ENTRY_ALLOW_LAN_ADMIN",
  "SERVICE_ENTRY_ALLOWED_ORIGINS",
  "SERVICE_ENTRY_ALLOWED_HOSTS",
  "SERVICE_ENTRY_PUBLIC_BASE_URL",
  "SERVICE_ENTRY_TRUSTED_PROXIES",
  "SERVICE_ENTRY_RATE_LIMIT_RPM",
  "TTS_UPSTREAM_API_KEY",
];

let entry = null;
let entryPort = 0;
let entryServer = null;
let tempDir = "";
const upstreams = [];
const captured = [];
const managerHits = new EventEmitter();

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function fakeTtsUpstream() {
  return http.createServer((req, res) => {
    const pathname = String(req.url || "").split("?")[0];
    req.resume();
    req.on("end", () => {
      if (pathname === "/api/missing") {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ detail: "not found" }));
      }
      if (pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<!doctype html><title>tts</title>");
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, path: pathname, method: req.method }));
    });
  });
}

function fakeModelManager() {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/instances") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        instances: [{ id: "primary", primary: true, running: true, models: [{ id: "fake-model" }] }],
      }));
    }
    if (url.pathname === "/serve/v1/chat/completions") {
      req.resume();
      const mode = url.searchParams.get("mode");
      managerHits.emit(mode, req);
      if (mode === "hold") return undefined; // never answers: the client gives up first
      if (mode === "stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {\"choices\":[]}\n\n");
        return undefined; // keeps streaming until the client disconnects
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "done", choices: [] }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    return res.end("{}");
  });
}

async function setup() {
  if (entry) return;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-access-filter-"));
  for (const name of CLEARED_ENV) delete process.env[name];
  const tts = fakeTtsUpstream();
  const manager = fakeModelManager();
  upstreams.push(tts, manager);
  process.env.TTS_GATEWAY_PORT = String(await listen(tts));
  process.env.VLLM_MANAGER_PORT = String(await listen(manager));
  process.env.LLAMA_MANAGER_PORT = String(await unusedPort());
  process.env.AI_BILLING_DB = path.join(tempDir, "billing.sqlite");
  entry = require("../server");
  entry.setEntryGatewayAccessSink(async (event) => { captured.push(event); });
  entryServer = entry.createServiceEntryServer();
  entryPort = await listen(entryServer);
}

test.after(async () => {
  for (const server of [entryServer, ...upstreams]) {
    if (!server) continue;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(20);
  }
  return predicate();
}

function entriesFor(marker) {
  return captured.filter((event) => event.userAgent === marker);
}

async function send(pathname, { method = "GET", marker, body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${entryPort}${pathname}`, {
    method,
    headers: { "user-agent": marker, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  await response.arrayBuffer();
  return response.status;
}

test("shouldLogTtsAccess keeps writes, errors and billable synthesis only", async () => {
  await setup();
  const { shouldLogTtsAccess } = entry;
  const reqOf = (method, url) => ({ method, url, headers: {} });
  const ok = { statusCode: 200 };

  assert.equal(shouldLogTtsAccess(reqOf("GET", "/gateway/tts/api/jobs"), ok), false);
  assert.equal(shouldLogTtsAccess(reqOf("GET", "/gateway/tts/api/jobs/job_123?wait=1"), ok), false);
  assert.equal(shouldLogTtsAccess(reqOf("GET", "/gateway/tts/"), ok), false);
  assert.equal(shouldLogTtsAccess(reqOf("HEAD", "/gateway/tts/app.js"), ok), false);
  assert.equal(shouldLogTtsAccess(reqOf("OPTIONS", "/gateway/tts/api/jobs"), { statusCode: 204 }), false);
  assert.equal(shouldLogTtsAccess(reqOf("GET", "/gateway/tts/api/jobs"), { statusCode: 304 }), false);

  assert.equal(shouldLogTtsAccess(reqOf("POST", "/gateway/tts/api/jobs"), ok), true);
  assert.equal(shouldLogTtsAccess(reqOf("DELETE", "/gateway/tts/api/jobs/job_123"), ok), true);
  assert.equal(shouldLogTtsAccess(reqOf("GET", "/gateway/tts/api/jobs"), { statusCode: 404 }), true);
  assert.equal(shouldLogTtsAccess(reqOf("GET", "/gateway/tts/api/jobs"), { statusCode: 499 }), true);
  assert.equal(shouldLogTtsAccess(reqOf("GET", "/gateway/tts/api/engines"), { statusCode: 503 }), true);
  assert.equal(shouldLogTtsAccess(reqOf("POST", "/gateway/tts/openai/v1/audio/speech"), ok), true);
  assert.equal(shouldLogTtsAccess(reqOf("GET", "/gateway/tts/openai/v1/models"), ok), true);
  assert.equal(shouldLogTtsAccess(reqOf("GET", "/gateway/tts/openai/v1"), ok), true);
  assert.equal(shouldLogTtsAccess(reqOf("GET", "/gateway/tts/openai/v10"), ok), false);
});

test("the TTS proxy skips successful polls and logs writes, errors and synthesis", async () => {
  await setup();
  const poll = "tts-filter/poll";
  const query = "tts-filter/poll-query";
  const shell = "tts-filter/shell";
  const write = "tts-filter/write";
  const missing = "tts-filter/missing";
  const synthesis = "tts-filter/synthesis";

  assert.equal(await send("/gateway/tts/api/jobs", { marker: poll }), 200);
  assert.equal(await send("/gateway/tts/api/jobs?status=running", { marker: query }), 200);
  assert.equal(await send("/gateway/tts/", { marker: shell }), 200);
  assert.equal(await send("/gateway/tts/api/jobs", { method: "POST", marker: write, body: { text: "hello" } }), 200);
  assert.equal(await send("/gateway/tts/api/missing", { marker: missing }), 404);
  assert.equal(await send("/gateway/tts/openai/v1/models", { marker: synthesis }), 200);

  assert.ok(await waitFor(() => entriesFor(write).length && entriesFor(missing).length && entriesFor(synthesis).length));
  // The polls finished before the logged requests were even sent.
  assert.equal(entriesFor(poll).length, 0);
  assert.equal(entriesFor(query).length, 0);
  assert.equal(entriesFor(shell).length, 0);

  const [writeEntry] = entriesFor(write);
  assert.equal(writeEntry.method, "POST");
  assert.equal(writeEntry.status, 200);
  assert.equal(writeEntry.terminalState, "completed");
  assert.equal(entriesFor(missing)[0].status, 404);
  assert.equal(entriesFor(synthesis)[0].path, "/gateway/tts/openai/v1/models");
  assert.equal(entriesFor(write).length + entriesFor(missing).length + entriesFor(synthesis).length, 3);
});

test("a completed gateway request logs one entry with its request id", async () => {
  await setup();
  const marker = "gateway-filter/completed";
  const status = await send("/gateway/vllm/openai/v1/chat/completions?mode=done", {
    method: "POST",
    marker,
    body: { model: "fake-model", messages: [] },
    headers: { "x-request-id": "req_testcompleted0000001" },
  });
  assert.equal(status, 200);
  assert.ok(await waitFor(() => entriesFor(marker).length === 1));
  await delay(100);
  const events = entriesFor(marker);
  assert.equal(events.length, 1);
  assert.equal(events[0].terminalState, "completed");
  assert.equal(events[0].status, 200);
  assert.equal(events[0].requestId, "req_testcompleted0000001");
  assert.equal(events[0].resolvedEngine, "vllm");
  assert.equal(events[0].model, "fake-model");
  assert.ok(events[0].socketAddress);
});

function openRawRequest(pathname, marker) {
  const payload = JSON.stringify({ model: "fake-model", messages: [], stream: true });
  const request = http.request({
    host: "127.0.0.1",
    port: entryPort,
    path: pathname,
    method: "POST",
    headers: { "user-agent": marker, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
  });
  request.on("error", () => {}); // the test destroys the socket on purpose
  request.end(payload);
  return request;
}

test("a client that aborts mid-stream produces one client_abort entry", async () => {
  await setup();
  const marker = "gateway-filter/stream-abort";
  const request = openRawRequest("/gateway/vllm/openai/v1/chat/completions?mode=stream", marker);
  const response = await new Promise((resolve) => request.once("response", resolve));
  assert.equal(response.statusCode, 200);
  await new Promise((resolve) => response.once("data", resolve));
  request.destroy();

  assert.ok(await waitFor(() => entriesFor(marker).length === 1));
  await delay(150);
  const events = entriesFor(marker);
  assert.equal(events.length, 1);
  assert.equal(events[0].terminalState, "client_abort");
  // Headers were already sent, so the upstream status stays on record.
  assert.equal(events[0].status, 200);
  assert.equal(events[0].path, "/gateway/vllm/openai/v1/chat/completions");
});

test("a client that aborts before the upstream answers logs 499 once", async () => {
  await setup();
  const marker = "gateway-filter/early-abort";
  const reached = new Promise((resolve) => managerHits.once("hold", resolve));
  const request = openRawRequest("/gateway/vllm/openai/v1/chat/completions?mode=hold", marker);
  await reached;
  request.destroy();

  assert.ok(await waitFor(() => entriesFor(marker).length === 1));
  await delay(150);
  const events = entriesFor(marker);
  assert.equal(events.length, 1);
  assert.equal(events[0].terminalState, "client_abort");
  assert.equal(events[0].status, 499);
});

test("logEntryGatewayAccessWhenDone writes exactly once per response", async () => {
  await setup();
  const fakeRes = () => Object.assign(new EventEmitter(), { headersSent: false, statusCode: 200, writableFinished: false });
  const fakeReq = (marker) => ({ method: "POST", url: "/gateway/auto/openai/v1/chat/completions", headers: { "user-agent": marker }, socket: { remoteAddress: "127.0.0.1" } });
  const build = (req) => ({ status, terminalState }) => ({ userAgent: req.headers["user-agent"], status, terminalState });

  const abortReq = fakeReq("helper/abort");
  const abortRes = fakeRes();
  entry.logEntryGatewayAccessWhenDone(abortReq, abortRes, build(abortReq));
  abortRes.emit("close");
  abortRes.emit("close");

  const doneReq = fakeReq("helper/done");
  const doneRes = fakeRes();
  entry.logEntryGatewayAccessWhenDone(doneReq, doneRes, build(doneReq));
  doneRes.headersSent = true;
  doneRes.writableFinished = true;
  doneRes.emit("finish");
  doneRes.emit("close");

  const skippedReq = fakeReq("helper/skipped");
  const skippedRes = fakeRes();
  entry.logEntryGatewayAccessWhenDone(skippedReq, skippedRes, build(skippedReq), () => false);
  skippedRes.emit("finish");

  await delay(20);
  assert.deepEqual(entriesFor("helper/abort"), [{ userAgent: "helper/abort", status: 499, terminalState: "client_abort" }]);
  assert.deepEqual(entriesFor("helper/done"), [{ userAgent: "helper/done", status: 200, terminalState: "completed" }]);
  assert.deepEqual(entriesFor("helper/skipped"), []);
});
