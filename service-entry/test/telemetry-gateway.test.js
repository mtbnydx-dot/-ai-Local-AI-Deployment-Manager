const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

// TEL-5 (docs/overhaul/04-telemetry.md §6): the entry records one telemetry
// row per gateway request. These tests drive the real entry over HTTP against
// fake manager and TTS upstreams, with the store in-process in a temp dir.
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
  "SERVICE_ENTRY_AUTH_FAIL_LIMIT",
  "TTS_UPSTREAM_API_KEY",
  "TELEMETRY_ENABLED",
  "AI_TELEMETRY_DB",
];
const REQUEST_ID = /^req_[a-z2-7]{20}$/;
const FAKE_KEY = "Bearer sk-test-fake-client-a";
const FAKE_BAD_KEY = "Bearer sk-test-fake-wrong";

let entry = null;
let entryServer = null;
let entryPort = 0;
let tempDir = "";
let dbFile = "";
const upstreams = [];
const upstreamHits = [];
const captured = [];
const holdHits = [];
let realAuthorize = null;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(25);
  }
  return Boolean(await predicate());
}

function sse(data) {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

function delta(content, extra = {}) {
  return sse({ id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: content === null ? { role: "assistant" } : { content }, finish_reason: null, ...extra }] });
}

function fakeModelManager() {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/instances") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        instances: [{ id: "primary", primary: true, running: true, engine: "sglang", launchId: "lch_testlaunch", runtime: { id: "sglang@test" }, models: [{ id: "fake-model" }] }],
      }));
    }
    if (url.pathname !== "/serve/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end("{}");
    }
    const mode = url.searchParams.get("mode") || "json";
    upstreamHits.push({ mode, headers: { ...req.headers } });
    req.resume();
    if (mode === "hold") {
      holdHits.push(req);
      return undefined; // never answers: the client gives up first
    }
    if (mode === "stream-hang") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(delta(null));
      res.write(delta("Hel"));
      return undefined; // keeps streaming until the client disconnects
    }
    if (mode === "stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "x-local-llm-queued-ms": "9" });
      res.write(delta(null));
      setTimeout(() => res.write(delta("Hel")), 60);
      setTimeout(() => res.write(delta("lo")), 330);
      setTimeout(() => {
        res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        res.write(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 } } }));
        res.write("data: [DONE]\n\n");
        res.end();
      }, 360);
      return undefined;
    }
    if (mode === "overflow") {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "This model's maximum context length is 4096 tokens.", type: "invalid_request_error", code: "context_length_exceeded" } }));
    }
    if (mode === "boom") {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "engine exploded", type: "server_error", code: "engine_failure" } }));
    }
    res.writeHead(200, { "content-type": "application/json", "x-local-llm-queued-ms": "5" });
    return res.end(JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 4 } },
    }));
  });
}

function fakeTtsUpstream() {
  return http.createServer((req, res) => {
    upstreamHits.push({ mode: "tts", method: req.method, path: String(req.url).split("?")[0], headers: { ...req.headers } });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, jobs: [] }));
    });
  });
}

// Authentication is the security module's business (tested elsewhere): the
// gateway tests stub the decision so no key store is read.
function installAuthStub() {
  realAuthorize = entry.security.authorizeGatewayRequest;
  entry.security.authorizeGatewayRequest = async (req) => {
    const authorization = String(req.headers.authorization || "");
    if (authorization === FAKE_KEY) {
      return {
        ok: true,
        clientId: "client-a",
        client: { id: "client-a", enabled: true, allowedModels: [], rateLimitRpm: Number(req.headers["x-test-rpm"] || 1000) },
        authRequired: true,
        matchedManager: "vllm",
      };
    }
    if (authorization) return { ok: false, status: 401, code: "invalid_api_key", message: "Invalid service API key." };
    return realAuthorize(req);
  };
}

async function setup() {
  if (entry) return;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-telemetry-"));
  for (const name of CLEARED_ENV) delete process.env[name];
  const tts = fakeTtsUpstream();
  const manager = fakeModelManager();
  upstreams.push(tts, manager);
  process.env.TTS_GATEWAY_PORT = String(await listen(tts));
  process.env.VLLM_MANAGER_PORT = String(await listen(manager));
  process.env.LLAMA_MANAGER_PORT = String(await unusedPort());
  process.env.SEARCH_GATEWAY_PORT = String(await unusedPort());
  process.env.PLATFORM_MCP_PORT = String(await unusedPort());
  process.env.PLATFORM_MCP_ENV_FILE = path.join(tempDir, "platform-mcp.env");
  process.env.AI_BILLING_DB = path.join(tempDir, "billing.sqlite");
  process.env.SERVICE_ENTRY_MODEL_CACHE_MS = "600000";
  process.env.SERVICE_ENTRY_STATUS_CACHE_MS = "600000";
  dbFile = path.join(tempDir, "telemetry.sqlite");
  entry = require("../server");
  entry.setEntryGatewayAccessSink(async (event) => { captured.push(event); });
  installAuthStub();
  entryServer = entry.createServiceEntryServer();
  entryPort = await listen(entryServer);
}

function telemetryOptions(extra = {}) {
  return {
    config: { enabled: true, dbPath: dbFile, keepJsonlAccessLog: true },
    dataDir: tempDir,
    inProcess: true,
    jobs: { enabled: false },
    flushMs: 40,
    logger: process.env.TEL_DEBUG ? console : { log() {}, warn() {}, error() {} },
    ...extra,
  };
}

test.after(async () => {
  await entry?.stopTelemetry();
  for (const request of holdHits) request.destroy?.();
  for (const server of [entryServer, ...upstreams]) {
    if (!server) continue;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  // The row finalisation reads billing's customer cache, which opens the ledger.
  try {
    entry?.getBillingStore().close();
  } catch {
    // Already closed.
  }
  // Gateway auth opens the access store beside the ledger (PUB-8).
  entry?.closeAccessStore();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function allRows(sql, ...params) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

async function flushTelemetry() {
  await entry.getTelemetry()?.recorder?.flush();
}

async function rowsFor(marker, count = 1) {
  let found = [];
  await waitFor(async () => {
    await flushTelemetry();
    found = allRows("SELECT * FROM requests WHERE user_agent = ? ORDER BY id", marker);
    return found.length >= count;
  });
  return found;
}

async function send(pathname, { method = "POST", marker, body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${entryPort}${pathname}`, {
    method,
    headers: { "user-agent": marker, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

function chat(mode, marker, { headers = {}, stream = false } = {}) {
  return send(`/gateway/vllm/openai/v1/chat/completions?mode=${mode}`, {
    marker,
    body: { model: "fake-model", messages: [{ role: "user", content: "secret prompt text" }], ...(stream ? { stream: true } : {}) },
    headers,
  });
}

function openRawRequest(pathname, marker, headers = {}) {
  const payload = JSON.stringify({ model: "fake-model", messages: [], stream: true });
  const request = http.request({
    host: "127.0.0.1",
    port: entryPort,
    path: pathname,
    method: "POST",
    headers: { "user-agent": marker, "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers },
  });
  request.on("error", () => {}); // the test destroys the socket on purpose
  request.end(payload);
  return request;
}

// What the entry does to a response, as a client sees it: status, body bytes
// and the header names (minus the request-id pair telemetry adds).
const SCENARIOS = [
  ["json chat", () => chat("json", "tel/identical-json")],
  ["streamed chat", () => chat("stream", "tel/identical-stream", { stream: true })],
  ["upstream 400", () => chat("overflow", "tel/identical-overflow")],
  ["bad key", () => chat("json", "tel/identical-401", { headers: { authorization: FAKE_BAD_KEY } })],
  ["tts poll", () => send("/gateway/tts/api/jobs", { method: "GET", marker: "tel/identical-poll" })],
  ["unknown route", () => send("/gateway/nowhere/openai/v1/chat/completions", { marker: "tel/identical-404" })],
];

async function runScenarios() {
  const results = {};
  for (const [name, run] of SCENARIOS) {
    const response = await run();
    const headerNames = [...response.headers.keys()]
      .filter((key) => !["x-request-id", "x-client-request-id", "date"].includes(key))
      .sort();
    // 05 §10.1 error bodies carry the request id, which differs per request.
    const text = response.text.replace(/"request_id":"req_[a-z2-7]{20}"/g, "\"request_id\":\"<id>\"");
    results[name] = { status: response.status, text, headerNames };
  }
  return results;
}

// The registrations of finish/close listeners an in-flight response gets from
// the entry, counted at the listener-add call (Node's own are added before).
function countingServer() {
  const observed = [];
  const server = http.createServer(async (req, res) => {
    const counts = { finish: 0, close: 0 };
    const add = res.on.bind(res);
    res.on = (event, listener) => {
      if (event === "finish" || event === "close") counts[event] += 1;
      return add(event, listener);
    };
    observed.push({ url: req.url, counts });
    await entry.handleRequest(req, res);
  });
  return { server, observed };
}

async function listenerRegistrations(pathname, { headers = {}, body } = {}) {
  const { server, observed } = countingServer();
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "tel/listeners", ...headers },
      body: JSON.stringify(body || { model: "fake-model", messages: [] }),
    });
    await response.arrayBuffer();
    await delay(30);
    return { ...observed.at(-1).counts };
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

let baseline = null;

test("TELEMETRY_ENABLED=0 leaves the gateway exactly as it was", async () => {
  await setup();
  const runtime = await entry.startTelemetry(telemetryOptions({ config: undefined, env: { TELEMETRY_ENABLED: "0" } }));
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.recorder, null);
  assert.equal(runtime.status().store, "disabled");

  const hitsBefore = upstreamHits.length;
  const response = await chat("json", "tel/disabled", { headers: { "x-request-id": "client-id-1" } });
  assert.equal(response.status, 200);
  // 05 §8.2 (PUB-8): every gateway answer carries the entry's request id,
  // also while telemetry is off; upstream still gets the client's id.
  assert.match(String(response.headers.get("x-request-id")), REQUEST_ID, "the entry mints an id while telemetry is off");
  assert.equal(response.headers.get("x-client-request-id"), null);
  assert.equal(upstreamHits.slice(hitsBefore).find((hit) => hit.mode === "json").headers["x-request-id"], "client-id-1", "the client's id is forwarded as before");
  assert.equal(fs.existsSync(dbFile), false, "no store is created");

  // The legacy access log still sees the request, with the client's id.
  assert.ok(await waitFor(() => captured.some((event) => event.userAgent === "tel/disabled")));
  assert.equal(captured.find((event) => event.userAgent === "tel/disabled").requestId, "client-id-1");

  baseline = {
    results: await runScenarios(),
    unauthorized: await listenerRegistrations("/gateway/vllm/openai/v1/chat/completions", { headers: { authorization: FAKE_BAD_KEY } }),
    completed: await listenerRegistrations("/gateway/vllm/openai/v1/chat/completions?mode=json"),
  };
  await entry.stopTelemetry();
  assert.equal(entry.getTelemetry(), null);
});

test("with the store unavailable, responses are byte-identical and the pair of listeners is the recorder's", async () => {
  await setup();
  assert.ok(baseline, "the previous test measured the baseline");
  const blocker = path.join(tempDir, "blocker");
  fs.writeFileSync(blocker, "a file where the database directory should be");
  const runtime = await entry.startTelemetry(telemetryOptions({ config: { enabled: true, dbPath: path.join(blocker, "telemetry.sqlite"), keepJsonlAccessLog: true } }));
  try {
    assert.equal(runtime.enabled, true);
    assert.equal(runtime.status().store, "unavailable");

    const results = await runScenarios();
    assert.deepEqual(Object.keys(results), Object.keys(baseline.results));
    for (const [name, expected] of Object.entries(baseline.results)) {
      assert.equal(results[name].status, expected.status, `${name}: status`);
      assert.equal(results[name].text, expected.text, `${name}: body`);
      assert.deepEqual(results[name].headerNames, expected.headerNames, `${name}: header names`);
    }
    // The rows were built and handed to the unavailable store, which discards
    // them with a counter; none of that reached the responses.
    const stats = runtime.recorder.stats();
    assert.ok(stats.rows >= SCENARIOS.length - 1, `rows were recorded (${stats.rows})`);
    assert.ok(stats.discarded + stats.buffered > 0, "and discarded, or still waiting for the store");

    // Finalisation goes through onResponseDone only: on an early refusal the
    // recorder adds the one finish/close pair; on a proxied request it replaces
    // the legacy log's pair instead of adding a second one.
    const unauthorized = await listenerRegistrations("/gateway/vllm/openai/v1/chat/completions", { headers: { authorization: FAKE_BAD_KEY } });
    assert.deepEqual(
      { finish: unauthorized.finish - baseline.unauthorized.finish, close: unauthorized.close - baseline.unauthorized.close },
      { finish: 1, close: 1 },
    );
    const completed = await listenerRegistrations("/gateway/vllm/openai/v1/chat/completions?mode=json");
    assert.deepEqual(completed, baseline.completed);
  } finally {
    await entry.stopTelemetry();
  }
});

test("one row per request carries every field, the real tokens and a minted request id", async () => {
  await setup();
  await entry.stopTelemetry(); // whatever an earlier test left behind
  await entry.startTelemetry(telemetryOptions());
  captured.length = 0;
  const marker = "tel/json-row";
  const hitsBefore = upstreamHits.length;
  const response = await chat("json", marker, { headers: { authorization: FAKE_KEY, "x-request-id": "client-id-2", referer: "http://chat.example.test/chat" } });
  assert.equal(response.status, 200);
  const requestId = response.headers.get("x-request-id");
  assert.match(requestId, REQUEST_ID);
  assert.notEqual(requestId, "client-id-2");
  assert.equal(response.headers.get("x-client-request-id"), "client-id-2");
  assert.equal(upstreamHits.slice(hitsBefore).find((hit) => hit.mode === "json").headers["x-request-id"], requestId, "the manager sees the minted id");

  const rows = await rowsFor(marker);
  assert.equal(rows.length, 1, "exactly one row");
  const [row] = rows;
  assert.equal(row.request_id, requestId);
  assert.equal(row.client_request_id, "client-id-2");
  assert.equal(row.manager_request_id, requestId);
  assert.equal(row.ingress, "entry");
  assert.equal(row.protocol, "openai");
  assert.equal(row.op, "chat");
  assert.equal(row.route, "vllm");
  assert.equal(row.method, "POST");
  assert.equal(row.path, "/gateway/vllm/openai/v1/chat/completions");
  assert.equal(row.manager_id, "vllm");
  assert.equal(row.fleet_id, "vllm:primary");
  assert.equal(row.engine_id, "sglang");
  assert.equal(row.runtime_id, "sglang@test");
  assert.equal(row.launch_id, "lch_testlaunch");
  assert.equal(row.model_requested, "fake-model");
  assert.equal(row.model_resolved, "fake-model");
  assert.equal(row.stream, 0);
  assert.equal(row.key_id, "client-a");
  assert.equal(row.auth_source, "authorization-bearer");
  assert.equal(row.client_ip, "127.0.0.1");
  assert.equal(row.user_agent, marker);
  assert.equal(row.origin_host, "chat.example.test");
  assert.ok(row.source_program);
  assert.equal(row.status, 200);
  assert.equal(row.terminal_state, "completed");
  assert.equal(row.error_class, "none");
  assert.equal(row.error_code, null);
  assert.equal(row.queue_ms, 5, "the manager's x-local-llm-queued-ms");
  assert.ok(row.upstream_headers_ms >= 0);
  assert.equal(row.ttft_ms, null, "TTFT applies to streams only");
  assert.equal(row.decode_tps, null);
  assert.ok(row.duration_ms >= 0);
  assert.ok(row.ended_at >= row.received_at);
  assert.equal(row.prompt_tokens, 12);
  assert.equal(row.cached_tokens, 4);
  assert.equal(row.output_tokens, 7);
  assert.equal(row.usage_source, "reported");
  assert.equal(row.finish_reason, "stop");
  assert.ok(row.bytes_out > 0);
  assert.ok(JSON.stringify(row).includes("secret prompt text") === false, "no prompt text is stored");

  // The legacy JSONL log is fed from the row: real tokens, the minted id.
  assert.ok(await waitFor(() => captured.some((event) => event.userAgent === marker)));
  const legacy = captured.filter((event) => event.userAgent === marker);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].requestId, requestId);
  assert.equal(legacy[0].inputTokens, 12);
  assert.equal(legacy[0].outputTokens, 7);
  assert.equal(legacy[0].totalTokens, 19);
  assert.equal(legacy[0].status, 200);
  assert.equal(legacy[0].terminalState, "completed");
  assert.equal(legacy[0].resolvedEngine, "vllm");
  assert.equal(legacy[0].clientId, "client-a");
});

test("a stream records TTFT, decode_tps and the usage of its final chunk", async () => {
  await setup();
  const marker = "tel/stream-row";
  const response = await chat("stream", marker, { stream: true });
  assert.equal(response.status, 200);
  assert.match(response.text, /\[DONE\]/);
  const [row] = await rowsFor(marker);
  assert.ok(row, "the stream is recorded");
  assert.equal(row.stream, 1);
  assert.equal(row.terminal_state, "completed");
  assert.equal(row.status, 200);
  assert.ok(row.ttft_ms >= 40, `ttft ${row.ttft_ms} ms`);
  assert.ok(row.ttft_ms < row.duration_ms);
  assert.equal(row.prompt_tokens, 10);
  assert.equal(row.cached_tokens, 3);
  assert.equal(row.output_tokens, 5);
  assert.equal(row.usage_source, "reported");
  assert.equal(row.finish_reason, "stop");
  assert.equal(row.queue_ms, 9);
  assert.ok(row.decode_tps > 2 && row.decode_tps < 200, `decode_tps ${row.decode_tps}`);
  assert.ok(row.bytes_out > 100);
});

test("a client that leaves mid-stream is a client_abort row that keeps the upstream status", async () => {
  await setup();
  const marker = "tel/abort-midstream";
  const request = openRawRequest("/gateway/vllm/openai/v1/chat/completions?mode=stream-hang", marker);
  const response = await new Promise((resolve) => request.once("response", resolve));
  assert.equal(response.statusCode, 200);
  await new Promise((resolve) => response.once("data", resolve));
  await delay(60);
  request.destroy();

  const rows = await rowsFor(marker);
  await delay(150);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].terminal_state, "client_abort");
  assert.equal(rows[0].error_class, "client_abort");
  assert.equal(rows[0].status, 200);
  assert.equal(rows[0].stream, 1);
  assert.equal(rows[0].finish_reason, "abort");
  assert.ok(rows[0].ttft_ms >= 0, "the first token arrived before the client left");
  assert.equal(allRows("SELECT COUNT(*) AS n FROM requests WHERE user_agent = ?", marker)[0].n, 1, "still one row after the late events");
});

test("a client that leaves before the upstream answers is status 499", async () => {
  await setup();
  const marker = "tel/abort-early";
  const reached = new Promise((resolve) => {
    const seen = holdHits.length;
    const poll = setInterval(() => {
      if (holdHits.length > seen) {
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });
  const request = openRawRequest("/gateway/vllm/openai/v1/chat/completions?mode=hold", marker);
  await reached;
  request.destroy();

  const rows = await rowsFor(marker);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 499);
  assert.equal(rows[0].terminal_state, "client_abort");
  assert.equal(rows[0].error_class, "client_abort");
  assert.equal(rows[0].ttft_ms, null);
  assert.equal(rows[0].upstream_headers_ms, null);
});

test("401 and 429 refusals are rows with their class, and still answer with a request id", async () => {
  await setup();
  const unauthorized = await chat("json", "tel/refused-401", { headers: { authorization: FAKE_BAD_KEY, "x-request-id": "client-id-3" } });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("x-request-id"), REQUEST_ID);
  assert.equal(unauthorized.headers.get("x-client-request-id"), "client-id-3");
  const [denied] = await rowsFor("tel/refused-401");
  assert.equal(denied.status, 401);
  assert.equal(denied.terminal_state, "rejected");
  assert.equal(denied.error_class, "auth_failed");
  assert.equal(denied.error_code, "invalid_api_key");
  assert.equal(denied.key_id, null, "a key that failed authentication is never recorded");
  assert.equal(denied.request_id, unauthorized.headers.get("x-request-id"));
  assert.equal(denied.manager_request_id, null, "the request never reached a manager");
  assert.equal(denied.usage_source, null);

  entry.resetEntryRateLimitBuckets();
  const first = await chat("json", "tel/refused-429", { headers: { authorization: FAKE_KEY, "x-test-rpm": "1" } });
  const second = await chat("json", "tel/refused-429", { headers: { authorization: FAKE_KEY, "x-test-rpm": "1" } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.match(second.headers.get("x-request-id"), REQUEST_ID);
  const rows = await rowsFor("tel/refused-429", 2);
  assert.equal(rows.length, 2);
  const limited = rows.find((row) => row.status === 429);
  assert.equal(limited.terminal_state, "rejected");
  assert.equal(limited.error_class, "rate_limited");
  assert.equal(limited.error_code, "rate_limit_exceeded");
  assert.equal(limited.key_id, "client-a");
  assert.notEqual(rows[0].request_id, rows[1].request_id);
});

test("upstream errors are classified from the status and the error body, never stored as text", async () => {
  await setup();
  const overflow = await chat("overflow", "tel/upstream-400");
  assert.equal(overflow.status, 400);
  const boom = await chat("boom", "tel/upstream-500");
  assert.equal(boom.status, 500);
  const [context] = await rowsFor("tel/upstream-400");
  assert.equal(context.status, 400);
  assert.equal(context.terminal_state, "failed");
  assert.equal(context.error_class, "context_overflow");
  assert.equal(context.error_code, "context_length_exceeded");
  const [failed] = await rowsFor("tel/upstream-500");
  assert.equal(failed.status, 500);
  assert.equal(failed.terminal_state, "failed");
  assert.equal(failed.error_class, "upstream_5xx");
  assert.equal(failed.error_code, "engine_failure");
  assert.equal(JSON.stringify([context, failed]).includes("engine exploded"), false);
  assert.equal(JSON.stringify([context, failed]).includes("maximum context length"), false);
});

test("the TTS jobs poll produces no row and is counted in control_counts_1m", async () => {
  await setup();
  const marker = "tel/tts-poll";
  const hitsBefore = upstreamHits.length;
  for (let index = 0; index < 3; index += 1) {
    const poll = await send("/gateway/tts/api/jobs", { method: "GET", marker });
    assert.equal(poll.status, 200);
    assert.match(poll.headers.get("x-request-id"), REQUEST_ID);
  }
  const forwarded = upstreamHits.slice(hitsBefore).filter((hit) => hit.mode === "tts");
  assert.equal(forwarded.length, 3);
  assert.ok(forwarded.every((hit) => REQUEST_ID.test(hit.headers["x-request-id"])), "the TTS service gets the minted id");

  const counted = async () => {
    await flushTelemetry();
    return Number(allRows("SELECT COALESCE(SUM(count), 0) AS n FROM control_counts_1m WHERE route = 'tts' AND status_class = '2xx'")[0].n);
  };
  assert.ok(await waitFor(async () => (await counted()) >= 3));
  assert.deepEqual(allRows("SELECT id FROM requests WHERE user_agent = ?", marker), [], "a poll is never a request row");

  // A synthesis job is traffic and does get a row; so does a refused poll.
  const created = await send("/gateway/tts/api/jobs", { marker: "tel/tts-job", body: { text: "hello" } });
  assert.equal(created.status, 200);
  const [job] = await rowsFor("tel/tts-job");
  assert.equal(job.protocol, "tts");
  assert.equal(job.op, "tts_batch");
  assert.equal(job.status, 200);
  assert.equal(job.usage_source, null, "token usage does not apply to TTS");

  const refused = await send("/gateway/tts/api/jobs", { method: "GET", marker: "tel/tts-401", headers: { authorization: FAKE_BAD_KEY } });
  assert.equal(refused.status, 401);
  const [denied] = await rowsFor("tel/tts-401");
  assert.equal(denied.status, 401, "401 on a control route is kept so auth storms stay visible");
  assert.equal(denied.error_class, "auth_failed");
});

test("an auth ban is recorded as a security.ban event", async () => {
  await setup();
  for (let index = 0; index < 20; index += 1) entry.authGuard.record("203.0.113.77");
  assert.equal(entry.authGuard.check("203.0.113.77").banned, true);
  let events = [];
  assert.ok(await waitFor(() => {
    events = allRows("SELECT * FROM events WHERE type = 'security.ban'");
    return events.length > 0;
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].severity, "warning");
  assert.equal(events[0].source, "entry");
  const data = JSON.parse(events[0].data);
  assert.equal(data.ipMasked, "203.0.113.x");
  assert.equal(data.failures, 20);
});

test("stopping the telemetry runtime finalises in-flight requests and flushes", async () => {
  await setup();
  const marker = "tel/stop-inflight";
  const reached = new Promise((resolve) => {
    const seen = holdHits.length;
    const poll = setInterval(() => {
      if (holdHits.length > seen) {
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });
  const request = openRawRequest("/gateway/vllm/openai/v1/chat/completions?mode=hold", marker);
  await reached;
  const recorder = entry.getTelemetry().recorder;
  assert.ok(recorder.inflight() >= 1);
  await entry.stopTelemetry();
  assert.equal(recorder.inflight(), 0);
  request.destroy();
  const rows = allRows("SELECT * FROM requests WHERE user_agent = ?", marker);
  assert.equal(rows.length, 1, "the request was flushed by stop()");
  assert.equal(rows[0].terminal_state, "failed");
  assert.equal(rows[0].error_class, "internal");
  assert.equal(rows[0].error_code, "entry_shutdown");
});
