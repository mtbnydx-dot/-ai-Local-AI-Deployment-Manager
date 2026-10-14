"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const mgmt = require("../lib/mgmt-proxy");
const { createRequestAuth } = require("../lib/request-auth");

// The management proxy (07 §2.10). Every manager here is a fake on a free
// loopback port; no request can reach a real local service.

const REQUEST_ID = /^req_[a-z2-7]{20}$/;
// What may reach a manager: the allowlist, the minted id, and what Node's own
// HTTP client always adds to a request.
const UPSTREAM_HEADERS = new Set(["accept", "content-type", "content-length", "last-event-id", "x-request-id", "host", "connection"]);

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await closeServer(probe);
  return port;
}

function quietLogger() {
  const lines = { warn: [], log: [] };
  return { lines, log: (line) => lines.log.push(String(line)), warn: (line) => lines.warn.push(String(line)), error: (line) => lines.warn.push(String(line)) };
}

function waitFor(predicate, timeoutMs = 2000, label = "condition") {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

// A manager that records every request it receives. `routes` maps a path
// (without query) to (req, res, hit) => void; anything else gets a JSON echo.
async function fakeManager(t, name, routes = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const hit = { method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(hit);
      const route = routes[req.url.split("?")[0]];
      if (route) return route(req, res, hit);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, manager: name, method: req.method, url: req.url }));
    });
  });
  const port = await listen(server);
  t.after(() => closeServer(server));
  return { name, port, seen, routes, server };
}

function managerList(...managers) {
  return managers.map((manager) => ({ id: manager.name, port: manager.port }));
}

// Owner unless the request carries x-test-role: viewer, which mimics a LAN
// caller under today's checkManagementAccess. The proxy never forwards the
// header, so it cannot leak into what a manager sees.
function roleSecurity() {
  return {
    checkManagementAccess(req) {
      return req.headers?.["x-test-role"] === "viewer"
        ? { ok: false, status: 403, code: "management_local_only", message: "Management endpoints are local-only." }
        : { ok: true };
    },
  };
}

function legacyAuth() {
  return createRequestAuth({ security: roleSecurity(), logger: quietLogger() });
}

// Serves proxy.handle() on its own loopback port; a path the proxy declines
// gets a recognisable 404.
async function proxyServer(t, handler) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const handled = await handler.handle(req, res, url);
    if (!handled && !res.headersSent) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ declined: true }));
    }
  });
  const port = await listen(server);
  t.after(() => closeServer(server));
  return port;
}

// The route module the entry mounts, on its own server.
async function mountedProxy(t, managers, options = {}) {
  const ctx = {
    managers: managerList(...managers),
    auth: options.auth || legacyAuth(),
    relay: options.relay ?? null,
    logger: options.logger || quietLogger(),
    now: Date.now,
  };
  const mounted = mgmt.mount(ctx);
  t.after(() => mounted.close());
  const port = await proxyServer(t, mounted);
  return { ctx, mounted, port };
}

// A raw request: http.request sends the path exactly as given, so dot
// segments and backslashes reach the proxy unnormalised.
function send(port, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

function openStream(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname, headers, agent: false }, (response) => {
      response.setEncoding("utf8");
      const stream = { status: response.statusCode, headers: response.headers, text: "", ended: false, closed: false, complete: false, close: () => request.destroy() };
      response.on("data", (chunk) => {
        stream.text += chunk;
      });
      response.on("end", () => {
        stream.ended = true;
      });
      response.on("close", () => {
        stream.closed = true;
        stream.complete = response.complete;
      });
      response.on("error", () => {});
      resolve(stream);
    });
    request.on("error", reject);
  });
}

function assertMinted(response, label = "") {
  assert.match(String(response.headers["x-request-id"] || ""), REQUEST_ID, `${label} x-request-id`);
}

test("maps /api/m/<managerId>/<rest> onto the manager's /api/<rest> and keeps the query", async (t) => {
  const vllm = await fakeManager(t, "vllm", {
    "/api/missing": (req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "no" } }));
    },
  });
  const llama = await fakeManager(t, "llama");
  const { port } = await mountedProxy(t, [vllm, llama]);

  const engines = await send(port, "/api/m/vllm/engines");
  assert.equal(engines.status, 200);
  assert.deepEqual(engines.json, { ok: true, manager: "vllm", method: "GET", url: "/api/engines" });
  assertMinted(engines);

  const status = await send(port, "/api/m/llama/status?verbose=1&q=a%20b");
  assert.equal(status.json.manager, "llama");
  assert.equal(status.json.url, "/api/status?verbose=1&q=a%20b");

  const schema = await send(port, "/api/m/vllm/engines/vllm/schema?model=Qwen3-8B&runtime=vllm%400.11");
  assert.equal(schema.json.url, "/api/engines/vllm/schema?model=Qwen3-8B&runtime=vllm%400.11");

  // Upstream status and body pass through unchanged for the owner.
  const missing = await send(port, "/api/m/vllm/missing");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { ok: false, error: { code: "not_found", message: "no" } });
  assertMinted(missing);

  assert.deepEqual(vllm.seen.map((hit) => hit.url), ["/api/engines", "/api/engines/vllm/schema?model=Qwen3-8B&runtime=vllm%400.11", "/api/missing"]);
  assert.deepEqual(llama.seen.map((hit) => hit.url), ["/api/status?verbose=1&q=a%20b"]);

  // Paths outside /api/m/<id>/ are not the proxy's.
  for (const other of ["/api/m", "/api/mx/vllm/status", "/api/status", "/api/events"]) {
    assert.equal((await send(port, other)).json?.declined, true, other);
  }
});

test("dot, empty and encoded-separator segments give 400 invalid_path; an unknown id gives 404 unknown_manager", async (t) => {
  const vllm = await fakeManager(t, "vllm");
  const { port } = await mountedProxy(t, [vllm]);
  const invalid = [
    "/api/m/vllm/../status",
    "/api/m/vllm/../../status",
    "/api/m/vllm/%2e%2e/status",
    "/api/m/vllm/%2E%2E/%2E%2E/status",
    "/api/m/vllm/./status",
    "/api/m/vllm/models%2fsecret",
    "/api/m/vllm/models%2Fsecret",
    "/api/m/vllm/models%5csecret",
    "/api/m/vllm/models\\secret",
    "/api/m/vllm//status",
    "/api/m/vllm/status/",
    "/api/m/vllm/",
    "/api/m/vllm",
    "/api/m/",
    "/api/m/vllm/a%00b",
    "/api/m/vllm/%E0%A4%A",
  ];
  for (const pathname of invalid) {
    const response = await send(port, pathname);
    assert.equal(response.status, 400, pathname);
    assert.deepEqual(Object.keys(response.json), ["ok", "error"], pathname);
    assert.equal(response.json.ok, false, pathname);
    assert.equal(response.json.error.code, "invalid_path", pathname);
    assertMinted(response, pathname);
  }
  for (const method of ["GET", "POST"]) {
    const unknown = await send(port, "/api/m/nope/status", { method });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, "unknown_manager");
    assertMinted(unknown);
  }
  assert.deepEqual(vllm.seen, [], "no rejected path reached the manager");
});

test("only allowlisted request headers reach the manager, with a freshly minted x-request-id", async (t) => {
  const vllm = await fakeManager(t, "vllm", {
    "/api/start": (req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "manager_session=fake; HttpOnly",
        "x-request-id": "mgr_aaaaaaaaaaaaaaaaaaaa",
        "access-control-allow-origin": "*",
        "x-manager-note": "kept",
      });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  const { port } = await mountedProxy(t, [vllm]);
  const clientId = "req_bbbbbbbbbbbbbbbbbbbb";
  const body = JSON.stringify({ model: "fake-model", contextLength: 4096 });
  const response = await send(port, "/api/m/vllm/start", {
    method: "POST",
    body,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "last-event-id": "abc123-7",
      cookie: "lai_session=fake-cookie-value",
      authorization: "Bearer fake-token-for-tests-only",
      "x-api-key": "sk-test-fake-000000",
      origin: "http://127.0.0.1:5176",
      referer: "http://127.0.0.1:5176/console",
      "x-csrf-token": "fake-csrf-token",
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-host": "public.example.invalid",
      "x-forwarded-proto": "https",
      "x-real-ip": "203.0.113.9",
      forwarded: "for=203.0.113.9",
      "x-request-id": clientId,
      "x-test-role": "owner",
      "x-gateway-marker": "1",
      "user-agent": "test-agent",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(vllm.seen.length, 1);
  const hit = vllm.seen[0];
  for (const name of Object.keys(hit.headers)) {
    assert.ok(UPSTREAM_HEADERS.has(name), `header ${name} must not reach the manager`);
  }
  assert.equal(hit.method, "POST");
  assert.equal(hit.body, body);
  assert.equal(hit.headers.accept, "application/json");
  assert.equal(hit.headers["content-type"], "application/json");
  assert.equal(hit.headers["content-length"], String(Buffer.byteLength(body)));
  assert.equal(hit.headers["last-event-id"], "abc123-7");
  assert.match(hit.headers["x-request-id"], REQUEST_ID);
  assert.notEqual(hit.headers["x-request-id"], clientId, "a client-supplied id is ignored");
  assert.equal(response.headers["x-request-id"], hit.headers["x-request-id"], "the client sees the id the manager saw");

  // Response: cookies, CORS and the manager's own id stay behind.
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.headers["x-manager-note"], "kept");
  assert.deepEqual(response.json, { ok: true });

  // Every request gets its own id.
  const ids = new Set([response.headers["x-request-id"]]);
  for (let index = 0; index < 5; index += 1) {
    const again = await send(port, "/api/m/vllm/status", { headers: { "x-request-id": clientId } });
    assertMinted(again);
    ids.add(again.headers["x-request-id"]);
    assert.equal(vllm.seen.at(-1).headers["x-request-id"], again.headers["x-request-id"]);
  }
  assert.equal(ids.size, 6);
});

const INSTANCES_BODY = {
  ok: true,
  instances: [
    {
      id: "vllm-primary",
      model: "Qwen3-8B",
      modelPath: "E:\\models\\Qwen3-8B",
      running: true,
      port: 8000,
      pid: 4242,
      lifecycle: { state: "ready", phase: "ready" },
      command: ["docker", "run", "--api-key", "sk-test-fake-000000"],
      env: { VLLM_API_KEY: "sk-test-fake-000000" },
      apiKey: "sk-test-fake-000000",
      hfToken: "hf_fakefakefakefakefakefake",
      authorization: "Bearer fake-token-for-tests-only",
      clients: [{ ip: "192.168.1.50", name: "laptop" }],
      note: "loaded from E:\\models\\Qwen3-8B\\config.json",
      mount: "/mnt/e/models/qwen",
    },
  ],
};

test("viewers read only registered manager paths, redacted, and never get a manager stream", async (t) => {
  const vllm = await fakeManager(t, "vllm", {
    "/api/instances": (req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-manager-note": "raw" });
      res.end(JSON.stringify(INSTANCES_BODY));
    },
    "/api/jobs": (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: jobs\ndata: {}\n\n");
    },
    "/api/stats": (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not json at all");
    },
    "/api/models": (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, models: Array.from({ length: 2000 }, (_, index) => ({ id: `model-${index}`, note: "x".repeat(200) })) }));
    },
  });
  const auth = legacyAuth();
  const { port } = await mountedProxy(t, [vllm], { auth });
  const viewer = { "x-test-role": "viewer" };

  // The owner gets the manager's bytes.
  const owner = await send(port, "/api/m/vllm/instances");
  assert.deepEqual(owner.json, INSTANCES_BODY);
  assert.equal(owner.headers["x-manager-note"], "raw");

  const redacted = await send(port, "/api/m/vllm/instances", { headers: viewer });
  assert.equal(redacted.status, 200);
  assertMinted(redacted);
  assert.deepEqual(redacted.json, {
    ok: true,
    instances: [
      {
        id: "vllm-primary",
        model: "Qwen3-8B",
        running: true,
        port: 8000,
        lifecycle: { state: "ready", phase: "ready" },
        note: "loaded from <redacted>",
        mount: "<redacted>",
      },
    ],
  });
  for (const leak of ["E:\\", "/mnt/", "sk-test", "hf_fake", "4242", "192.168.1.50", "Bearer"]) {
    assert.equal(redacted.text.includes(leak), false, leak);
  }

  // HEAD follows GET.
  const head = await send(port, "/api/m/vllm/instances", { method: "HEAD", headers: viewer });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  assertMinted(head);

  // Not registered for viewers (01 registers engines itself): refused with
  // the seam's status and code, and the manager is never asked.
  const before = vllm.seen.length;
  for (const pathname of ["/api/m/vllm/engines", "/api/m/vllm/instances/vllm-primary/logs", "/api/m/vllm/config"]) {
    const refused = await send(port, pathname, { headers: viewer });
    assert.equal(refused.status, 403, pathname);
    assert.equal(refused.json.error.code, "management_local_only", pathname);
    assertMinted(refused, pathname);
  }
  assert.equal(vllm.seen.length, before);

  // A registered read that answers with a stream, a non-JSON body or an
  // oversized body is never handed to a viewer unredacted.
  const stream = await send(port, "/api/m/vllm/jobs", { headers: viewer });
  assert.equal(stream.status, 502);
  assert.equal(stream.json.error.code, "response_not_redactable");
  const text = await send(port, "/api/m/vllm/stats", { headers: viewer });
  assert.equal(text.status, 502);
  assert.equal(text.json.error.code, "response_not_redactable");
  assert.equal(text.text.includes("not json"), false);

  const small = mgmt.createMgmtProxy({ managers: managerList(vllm), auth, maxResponseBytes: 64 * 1024, logger: quietLogger() });
  t.after(() => small.close());
  const smallPort = await proxyServer(t, small);
  const tooLarge = await send(smallPort, "/api/m/vllm/models", { headers: viewer });
  assert.equal(tooLarge.status, 502);
  assert.equal(tooLarge.json.error.code, "response_too_large");
  assertMinted(tooLarge);
  // The owner is not buffered, so the same body streams through.
  const ownerLarge = await send(smallPort, "/api/m/vllm/models");
  assert.equal(ownerLarge.status, 200);
  assert.equal(ownerLarge.json.models.length, 2000);
});

test("every 07 viewer read is registered for viewers and the rest of /api/m/* is declared admin-only", () => {
  const auth = legacyAuth();
  mgmt.mount({ managers: [{ id: "vllm", port: 1 }], auth, logger: quietLogger() }).close();
  assert.deepEqual([...mgmt.VIEWER_READS], ["status", "instances", "running-models", "models", "stats", "jobs", "tools/health"]);
  for (const name of mgmt.VIEWER_READS) {
    const found = auth.viewerRegistry.match("GET", `/api/m/llama/${name}`);
    assert.equal(found?.access, "viewer", name);
    assert.equal(found.entry.owner, "07");
    assert.equal(found.params.managerId, "llama");
    assert.equal(typeof found.entry.redact, "function");
  }
  assert.equal(auth.viewerRegistry.match("GET", "/api/m/vllm/engines")?.access, "admin");
  assert.equal(auth.viewerRegistry.match("POST", "/api/m/vllm/status")?.access, "admin");
  assert.equal(auth.viewerRegistry.match("DELETE", "/api/m/vllm/instances/x")?.access, "admin");
});

test("a non-GET without the owner never reaches the manager", async (t) => {
  const vllm = await fakeManager(t, "vllm");
  const { port } = await mountedProxy(t, [vllm]);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await send(port, "/api/m/vllm/stop", { method, headers: { "x-test-role": "viewer", "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 403, method);
    assert.equal(response.json.error.code, "management_local_only", method);
    assertMinted(response, method);
  }
  // A registered viewer read is still a write when the method is not GET.
  const post = await send(port, "/api/m/vllm/status", { method: "POST", headers: { "x-test-role": "viewer" } });
  assert.equal(post.status, 403);
  assert.deepEqual(vllm.seen, []);

  // Once 05's admin auth is attached, its status and code are the answer.
  const adminAuth = {
    authenticate: () => ({ role: "viewer", principal: "loopback", via: "loopback", redact: true }),
    checkManagementAccess: (req) => (req.headers["x-test-csrf"] === "stale"
      ? { ok: false, status: 403, code: "csrf_invalid", message: "Reload the page." }
      : { ok: false, status: 401, code: "admin_session_required", message: "Pair this browser first." }),
    eventTypesFor: () => new Set(["status"]),
  };
  const sessionAuth = createRequestAuth({ security: roleSecurity(), adminAuth, logger: quietLogger() });
  const { port: sessionPort } = await mountedProxy(t, [vllm], { auth: sessionAuth });
  const unpaired = await send(sessionPort, "/api/m/vllm/start", { method: "POST", body: "{}" });
  assert.equal(unpaired.status, 401);
  assert.equal(unpaired.json.error.code, "admin_session_required");
  const stale = await send(sessionPort, "/api/m/vllm/start", { method: "POST", headers: { "x-test-csrf": "stale" }, body: "{}" });
  assert.equal(stale.status, 403);
  assert.equal(stale.json.error.code, "csrf_invalid");
  // A loopback viewer still reads registered paths, redacted.
  const read = await send(sessionPort, "/api/m/vllm/status");
  assert.equal(read.status, 200);
  assert.deepEqual(vllm.seen.map((hit) => `${hit.method} ${hit.url}`), ["GET /api/status"]);
});

test("event streams pass through chunk by chunk with no timeout, and the upstream closes when the client leaves", async (t) => {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let upstreamClosed = false;
  const vllm = await fakeManager(t, "vllm", {
    "/api/events": async (req, res, hit) => {
      res.on("close", () => {
        upstreamClosed = true;
      });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-request-id": "mgr_cccccccccccccccccccc" });
      res.write(`event: jobs\ndata: {"n":1,"lastEventId":"${hit.headers["last-event-id"] || ""}"}\n\n`);
      await released;
      res.write('event: jobs\ndata: {"n":2}\n\n');
    },
  });
  const proxy = mgmt.createMgmtProxy({ managers: managerList(vllm), auth: legacyAuth(), requestTimeoutMs: 100, logger: quietLogger() });
  t.after(() => proxy.close());
  const port = await proxyServer(t, proxy);

  const stream = await openStream(port, "/api/m/vllm/events", { accept: "text/event-stream", "last-event-id": "k3f9a2-41" });
  assert.equal(stream.status, 200);
  assert.match(stream.headers["content-type"], /^text\/event-stream/);
  assert.equal(stream.headers["cache-control"], "no-store");
  assert.equal(stream.headers["x-accel-buffering"], "no");
  assertMinted(stream);
  await waitFor(() => stream.text.includes('"n":1'), 2000, "the first chunk");
  assert.ok(stream.text.includes('"lastEventId":"k3f9a2-41"'), "last-event-id reaches the manager");
  assert.equal(stream.text.includes('"n":2'), false, "the second chunk is not written yet");

  // Well past requestTimeoutMs: a live stream has no deadline.
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(stream.ended, false);
  release();
  await waitFor(() => stream.text.includes('"n":2'), 2000, "the second chunk");
  assert.equal(stream.ended, false);

  stream.close();
  await waitFor(() => upstreamClosed, 2000, "the manager-side stream to close");
  await waitFor(() => proxy.stats().inflight === 0, 2000, "the flight to settle");
});

test("viewer requests for a stream are refused before the manager streams to them", async (t) => {
  const vllm = await fakeManager(t, "vllm", {
    "/api/status": (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: secret-ish\n\n");
    },
  });
  const { port } = await mountedProxy(t, [vllm]);
  const response = await send(port, "/api/m/vllm/status", { headers: { "x-test-role": "viewer", accept: "text/event-stream" } });
  assert.equal(response.status, 502);
  assert.equal(response.json.error.code, "response_not_redactable");
  assert.equal(response.text.includes("secret-ish"), false);
});

test("502 manager_unreachable, 504 manager_timeout and 413 body_too_large use the error envelope", async (t) => {
  let dropConnection = true;
  const vllm = await fakeManager(t, "vllm", {
    "/api/hang": () => {},
    "/api/flaky": (req, res) => {
      if (dropConnection) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    },
  });
  const logger = quietLogger();
  const offline = await unusedPort();
  const proxy = mgmt.createMgmtProxy({
    managers: [...managerList(vllm), { id: "llama", port: offline }],
    auth: legacyAuth(),
    requestTimeoutMs: 200,
    logger,
  });
  t.after(() => proxy.close());
  const port = await proxyServer(t, proxy);

  const unreachable = await send(port, "/api/m/llama/status");
  assert.equal(unreachable.status, 502);
  assert.equal(unreachable.json.ok, false);
  assert.equal(unreachable.json.error.code, "manager_unreachable");
  assert.equal(unreachable.json.error.managerId, "llama");
  assert.equal(typeof unreachable.json.error.hint, "string");
  assert.equal(unreachable.text.includes(String(offline)), false, "the port stays internal");
  assertMinted(unreachable);

  const started = Date.now();
  const timeout = await send(port, "/api/m/vllm/hang");
  assert.equal(timeout.status, 504);
  assert.equal(timeout.json.error.code, "manager_timeout");
  assert.equal(timeout.json.error.managerId, "vllm");
  assert.ok(Date.now() - started < 3000);
  assertMinted(timeout);

  const before = vllm.seen.length;
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
  const tooLarge = await send(port, "/api/m/vllm/start", { method: "POST", headers: { "content-type": "application/json" }, body: big });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.json.error.code, "body_too_large");
  assertMinted(tooLarge);
  // Exactly 2 MiB is allowed.
  const limit = await send(port, "/api/m/vllm/start", { method: "POST", headers: { "content-type": "text/plain" }, body: Buffer.alloc(2 * 1024 * 1024, 0x61) });
  assert.equal(limit.status, 200);
  assert.equal(vllm.seen.length, before + 1, "only the in-limit body reached the manager");
  assert.equal(vllm.seen.at(-1).body.length, 2 * 1024 * 1024);

  // No retries, and one log line per outage rather than one per request.
  const warned = logger.lines.warn.length;
  const logged = logger.lines.log.length;
  const dropped = await send(port, "/api/m/vllm/flaky");
  assert.equal(dropped.status, 502);
  assert.equal(dropped.json.error.code, "manager_unreachable");
  assert.equal((await send(port, "/api/m/vllm/flaky")).status, 502);
  assert.equal((await send(port, "/api/m/llama/status")).status, 502);
  assert.equal(vllm.seen.filter((hit) => hit.url === "/api/flaky").length, 2);
  dropConnection = false;
  assert.equal((await send(port, "/api/m/vllm/flaky")).status, 200);
  const newWarnings = logger.lines.warn.slice(warned);
  assert.equal(newWarnings.length, 1, newWarnings.join("\n"));
  assert.ok(newWarnings[0].includes("vllm"));
  assert.equal(logger.lines.warn.filter((line) => line.includes("llama")).length, 1);
  assert.deepEqual(logger.lines.log.slice(logged).filter((line) => line.includes("answers again")).length, 1);
});

test("a write gets the longer write deadline, so a slow manager action is not cut off at the read timeout", async (t) => {
  const vllm = await fakeManager(t, "vllm", {
    // Answers after 300 ms, like POST /api/docker/start waiting for Docker.
    "/api/docker/start": (req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true,"started":true}');
      }, 300);
    },
    "/api/hang": () => {},
  });
  const proxy = mgmt.createMgmtProxy({ managers: managerList(vllm), auth: legacyAuth(), requestTimeoutMs: 100, writeTimeoutMs: 1000, logger: quietLogger() });
  t.after(() => proxy.close());
  const port = await proxyServer(t, proxy);

  const read = await send(port, "/api/m/vllm/docker/start");
  assert.equal(read.status, 504);
  assert.equal(read.json.error.code, "manager_timeout");
  const write = await send(port, "/api/m/vllm/docker/start", { method: "POST", body: "{}" });
  assert.equal(write.status, 200);
  assert.deepEqual(write.json, { ok: true, started: true });
  // A write still has a deadline.
  const started = Date.now();
  const hung = await send(port, "/api/m/vllm/hang", { method: "POST", body: "{}" });
  assert.equal(hung.status, 504);
  assert.equal(hung.json.error.code, "manager_timeout");
  assert.ok(Date.now() - started >= 900, "the write deadline, not the read one");

  // The in-process client splits its defaults the same way.
  const client = mgmt.createManagerClient({ managers: managerList(vllm), requestTimeoutMs: 100, writeTimeoutMs: 1000 });
  t.after(() => client.close());
  assert.equal((await client.get("vllm", "docker/start")).code, "manager_timeout");
  const posted = await client.post("vllm", "docker/start", {});
  assert.equal(posted.ok, true);
  assert.deepEqual(posted.data, { ok: true, started: true });
});

test("relay.poke follows a 2xx POST once the relay is mounted and is skipped without it", async (t) => {
  const vllm = await fakeManager(t, "vllm", {
    "/api/broken": (req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"ok":false}');
    },
    "/api/conflict": (req, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end('{"ok":false}');
    },
  });
  const llama = await fakeManager(t, "llama");
  const { ctx, port } = await mountedProxy(t, [vllm, llama]);

  // Without ENT-EV3 there is no relay; the write still works.
  assert.equal(ctx.relay, null);
  assert.equal((await send(port, "/api/m/vllm/start", { method: "POST", body: "{}" })).status, 200);

  // The relay mounts after the proxy; the proxy reads ctx.relay at call time.
  const pokes = [];
  ctx.relay = { poke: (managerId) => pokes.push(managerId) };
  assert.equal((await send(port, "/api/m/llama/start", { method: "POST", body: "{}" })).status, 200);
  await waitFor(() => pokes.length === 1, 2000, "the poke");
  assert.deepEqual(pokes, ["llama"]);

  await send(port, "/api/m/vllm/status");
  await send(port, "/api/m/vllm/status", { method: "HEAD" });
  await send(port, "/api/m/vllm/broken", { method: "POST", body: "{}" });
  await send(port, "/api/m/vllm/conflict", { method: "POST", body: "{}" });
  await send(port, "/api/m/vllm/stop", { method: "POST", headers: { "x-test-role": "viewer" } });
  await send(port, "/api/m/vllm/instances/a/stop", { method: "DELETE" });
  await waitFor(() => pokes.length === 2, 2000, "the DELETE poke");
  assert.deepEqual(pokes, ["llama", "vllm"], "GET, HEAD, non-2xx and refused writes never poke");

  // A relay that throws never breaks the answer.
  ctx.relay = { poke: () => { throw new Error("relay down"); } };
  assert.equal((await send(port, "/api/m/vllm/start", { method: "POST", body: "{}" })).status, 200);
  ctx.relay = { poke: () => Promise.reject(new Error("relay down")) };
  assert.equal((await send(port, "/api/m/vllm/start", { method: "POST", body: "{}" })).status, 200);
});

test("close() ends proxied streams, visibly cuts any other body, and later requests get 503", async (t) => {
  const vllm = await fakeManager(t, "vllm", {
    "/api/events": (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: open\n\n");
    },
    // A JSON body the manager is still writing when the entry shuts down.
    "/api/backups": (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ok":true,"items":["first"');
    },
  });
  const proxy = mgmt.createMgmtProxy({ managers: managerList(vllm), auth: legacyAuth(), logger: quietLogger() });
  const port = await proxyServer(t, proxy);
  const stream = await openStream(port, "/api/m/vllm/events");
  const partial = await openStream(port, "/api/m/vllm/backups");
  await waitFor(() => stream.text.includes("open"), 2000, "the stream");
  await waitFor(() => partial.text.includes("first"), 2000, "the partial body");
  assert.equal(proxy.stats().inflight, 2);
  proxy.close();
  // The event stream ends cleanly, so an EventSource just reconnects.
  await waitFor(() => stream.ended && stream.closed, 2000, "the stream to end");
  assert.equal(stream.complete, true);
  // The cut JSON body is an aborted response, never a complete one.
  await waitFor(() => partial.closed, 2000, "the partial response to close");
  assert.equal(partial.ended, false);
  assert.equal(partial.complete, false);
  assert.equal(proxy.stats().inflight, 0);
  const late = await send(port, "/api/m/vllm/status");
  assert.equal(late.status, 503);
  assert.equal(late.json.error.code, "mgmt_proxy_closed");
  assertMinted(late);
});

test("the viewer redaction strips paths, pids, client details and key-shaped fields", () => {
  const input = {
    ok: true,
    status: "running",
    modelId: "Qwen3-8B",
    keyId: "k_abc",
    port: 8000,
    pid: 1,
    ppid: 2,
    containerPid: 3,
    pidFile: "x",
    serviceKey: "fake",
    adminApiKey: "fake",
    "x-api-key": "fake",
    trustToken: "fake",
    hf_token: "fake",
    clientSecret: "fake",
    password: "fake",
    keyHash: "fake",
    logDir: "fake",
    modelRoots: ["fake"],
    cacheDirectory: "fake",
    argv: ["fake"],
    env: { A: "1" },
    remoteAddress: "192.168.1.9",
    userAgent: "fake",
    serviceClients: [],
    nested: [{ hostPath: "fake", label: "see \\\\fileserver\\share\\model.gguf or file:///E:/models/x.gguf" }],
    message: "Authorization: Bearer fake-token-for-tests-only failed at C:/data/models/m.gguf",
  };
  const output = mgmt.redactManagerReadForViewer(input);
  assert.deepEqual(output, {
    ok: true,
    status: "running",
    modelId: "Qwen3-8B",
    keyId: "k_abc",
    port: 8000,
    nested: [{ label: "see <redacted> or <redacted>" }],
    message: "Authorization: Bearer <redacted> failed at <redacted>",
  });
  assert.notEqual(output, input, "a new value is built");
  assert.equal(input.pid, 1, "the input is not changed");
  assert.equal(mgmt.redactManagerReadForViewer("plain"), "plain");
  assert.deepEqual(mgmt.redactManagerReadForViewer([1, null, true]), [1, null, true]);
});

test("viewers of a manager's stats never learn who called it", async (t) => {
  const { buildRecentAccessStats, groupAccessEvents, normalizeAccessEvent } = require("../../manager-core/access-log");
  const now = Date.now();
  const at = (agoMs) => new Date(now - agoMs).toISOString();
  // A LAN browser and a LAN script that names itself, as the gateway logs them.
  const events = [
    {
      at: at(3000), remoteAddress: "192.168.1.77", method: "POST", path: "/serve/v1/chat/completions", status: 200, model: "Qwen3-8B",
      userAgent: "Mozilla/5.0 Phone-of-Alice", origin: "http://alice-laptop.lan:3000", referer: "http://alice-laptop.lan:3000/chat",
      clientId: "cl_alice", inputTokens: 10, outputTokens: 5, durationMs: 120,
    },
    {
      at: at(2000), remoteAddress: "10.0.0.23", method: "POST", path: "/claude/v1/messages", status: 500, model: "Qwen3-8B",
      userAgent: "python-requests/2.31 bobs-workstation", sourceProgram: "bobs-nightly-batch", inputTokens: 3, durationMs: 40,
    },
    {
      at: at(1000), remoteAddress: "192.168.1.78", method: "POST", path: "/serve/v1/chat/completions", status: 200, model: "Qwen3-8B",
      userAgent: "Mozilla/5.0 Tablet-of-Carol", referer: "http://carol-tablet.lan/notes", inputTokens: 4, outputTokens: 2, durationMs: 80,
    },
  ];
  // GET /api/stats as both managers build it, plus the same per-caller
  // groups under a key the redaction has no special case for.
  const stats = {
    ok: true,
    recentAccess: buildRecentAccessStats({ now, events }),
    accessByModel: groupAccessEvents(events.map((entry) => normalizeAccessEvent(entry)), (entry) => entry.model),
  };
  const callers = [
    "192.168.1.77", "192.168.1.78", "10.0.0.23", "Mozilla", "Phone-of-Alice", "Tablet-of-Carol", "python-requests",
    "bobs-workstation", "bobs-nightly-batch", "alice-laptop", "carol-tablet", "cl_alice",
  ];
  for (const needle of callers) assert.ok(JSON.stringify(stats).includes(needle), `the fixture carries ${needle}`);

  const vllm = await fakeManager(t, "vllm", {
    "/api/stats": (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(stats));
    },
  });
  const { port } = await mountedProxy(t, [vllm]);

  // The owner sees every caller.
  const owner = await send(port, "/api/m/vllm/stats");
  assert.deepEqual(owner.json, JSON.parse(JSON.stringify(stats)));

  const viewer = await send(port, "/api/m/vllm/stats", { headers: { "x-test-role": "viewer" } });
  assert.equal(viewer.status, 200);
  assertMinted(viewer);
  for (const needle of callers) assert.equal(viewer.text.includes(needle), false, needle);
  // The access summary keeps its counts; the per-caller groups and the
  // single requests are gone.
  assert.deepEqual(Object.keys(viewer.json.recentAccess), ["ok", "updatedAt", "windowMs", "startAt", "endAt", "totals"]);
  assert.equal(viewer.json.recentAccess.totals.requests.total, 3);
  assert.equal(viewer.json.recentAccess.totals.requests.error, 1);
  assert.equal(viewer.json.recentAccess.totals.tokens.total, 24);
  // Anywhere else, the client maps and their top entries are dropped and
  // the aggregate counts stay.
  const group = viewer.json.accessByModel[0];
  assert.equal(group.key, "Qwen3-8B");
  assert.equal(group.count, 3);
  for (const key of [
    "remoteAddresses", "userAgents", "origins", "refererHosts", "sourcePrograms",
    "topRemoteAddress", "topUserAgent", "topOrigin", "topRefererHost", "topSourceProgram",
  ]) {
    assert.equal(key in group, false, key);
  }

  // The single-field spellings go the same way.
  assert.deepEqual(mgmt.redactManagerReadForViewer({
    model: "m",
    origin: "http://a.lan",
    Referer: "http://a.lan/x",
    referrerHost: "a.lan",
    sourceProgram: "x",
    "x-forwarded-for": "192.168.1.5",
    remote_host: "a.lan",
    top_user_agent: ["ua", 1],
    clientIps: ["192.168.1.5"],
  }), { model: "m" });
  // An access summary that failed to load keeps its error, scrubbed.
  assert.deepEqual(mgmt.redactManagerReadForViewer({ recentAccess: { ok: false, error: "cannot read E:\\logs\\access.jsonl", sources: [] } }), {
    recentAccess: { ok: false, error: "cannot read <redacted>" },
  });
});

test("the in-process manager client uses the same mapping and never throws", async (t) => {
  const vllm = await fakeManager(t, "vllm", {
    "/api/hang": () => {},
    "/api/refuse": (req, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "instance_busy", message: "Busy." } }));
    },
  });
  const llama = await fakeManager(t, "llama");
  const offline = await unusedPort();
  const client = mgmt.createManagerClient({ managers: [...managerList(vllm, llama), { id: "spare", port: offline }], requestTimeoutMs: 200 });
  t.after(() => client.close());

  const engines = await client.get("vllm", "engines", { query: { model: "a b", skip: undefined } });
  assert.equal(engines.ok, true);
  assert.equal(engines.status, 200);
  assert.equal(engines.managerId, "vllm");
  assert.match(engines.requestId, REQUEST_ID);
  assert.equal(engines.data.url, "/api/engines?model=a+b");
  assert.equal(vllm.seen.at(-1).headers["x-request-id"], engines.requestId);

  const reuse = "req_dddddddddddddddddddd";
  const started = await client.post("llama", "/start", { model: "fake" }, { requestId: reuse });
  assert.equal(started.ok, true);
  assert.equal(started.requestId, reuse);
  assert.equal(llama.seen.at(-1).method, "POST");
  assert.deepEqual(JSON.parse(llama.seen.at(-1).body), { model: "fake" });
  assert.equal(llama.seen.at(-1).headers["content-type"], "application/json");

  const refused = await client.post("vllm", "refuse", {});
  assert.deepEqual([refused.ok, refused.status, refused.code, refused.message], [false, 409, "instance_busy", "Busy."]);

  const checks = [
    [await client.get("nope", "status"), "unknown_manager"],
    [await client.get("vllm", "../status"), "invalid_path"],
    [await client.get("vllm", "a%2fb"), "invalid_path"],
    [await client.get("vllm", ""), "invalid_path"],
    [await client.get("spare", "status"), "manager_unreachable"],
    [await client.get("vllm", "hang"), "manager_timeout"],
  ];
  for (const [result, code] of checks) {
    assert.equal(result.ok, false, code);
    assert.equal(result.status, 0, code);
    assert.equal(result.code, code);
    assert.match(result.requestId, REQUEST_ID);
  }
  const controller = new AbortController();
  const pending = client.get("vllm", "hang", { signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  assert.equal((await pending).code, "aborted");
  const hangs = () => vllm.seen.filter((hit) => hit.url === "/api/hang").length;
  const hung = hangs();
  const closing = client.get("vllm", "hang", { timeoutMs: 5000 });
  await waitFor(() => hangs() === hung + 1, 2000, "the hang request");
  client.close();
  assert.equal((await closing).code, "aborted");
  assert.equal((await client.get("vllm", "status")).code, "aborted");
});

// --- through the real entry -------------------------------------------------

const CLEARED_ENV = [
  "SERVICE_ENTRY_HOST",
  "SERVICE_ENTRY_REQUIRE_API_KEY",
  "SERVICE_ENTRY_ALLOW_LAN_ADMIN",
  "SERVICE_ENTRY_ALLOWED_ORIGINS",
  "SERVICE_ENTRY_ALLOWED_HOSTS",
  "SERVICE_ENTRY_PUBLIC_BASE_URL",
  "SERVICE_ENTRY_TRUSTED_PROXIES",
  "SERVICE_ENTRY_RATE_LIMIT_RPM",
];

let entry = null;
let entryVllm = null;
let tempDir = "";

// The entry reads its manager ports when it is loaded, so the fake vLLM
// manager listens first and every other upstream port points at nothing.
async function setupEntry() {
  if (entry) return { entry, vllm: entryVllm };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-mgmt-proxy-"));
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    if (req.url === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hello\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  entryVllm = { server, seen, port: await listen(server) };
  for (const name of CLEARED_ENV) delete process.env[name];
  process.env.VLLM_MANAGER_PORT = String(entryVllm.port);
  for (const name of ["LLAMA_MANAGER_PORT", "TTS_GATEWAY_PORT", "SEARCH_GATEWAY_PORT", "PLATFORM_MCP_PORT"]) {
    process.env[name] = String(await unusedPort());
  }
  process.env.PLATFORM_MCP_ENV_FILE = path.join(tempDir, "platform-mcp.env");
  process.env.AI_BILLING_DB = path.join(tempDir, "billing.sqlite");
  entry = require("../server");
  entry.setEntryGatewayAccessSink(async () => {});
  return { entry, vllm: entryVllm };
}

test.after(async () => {
  if (entryVllm) await closeServer(entryVllm.server);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test("the entry mounts the proxy right after the event bus and serves /api/m/* through its guards", async (t) => {
  const { entry: server, vllm } = await setupEntry();
  assert.deepEqual(server.ROUTE_MODULES.slice(0, 2), ["./lib/events", "./lib/mgmt-proxy"]);
  const ctx = server.createRouteContext({ logger: quietLogger() });
  const routes = await server.mountRouteModules({ ctx });
  assert.equal(routes.failed.length, 0, JSON.stringify(routes.failed));
  assert.equal(ctx.features.mgmtProxy, true);
  assert.equal(typeof ctx.managerClient?.get, "function");
  const http5176 = server.createServiceEntryServer({ routes });
  const port = await listen(http5176);
  t.after(() => closeServer(http5176));

  const engines = await send(port, "/api/m/vllm/engines?model=x");
  assert.equal(engines.status, 200);
  assert.deepEqual(engines.json, { ok: true, url: "/api/engines?model=x" });
  assertMinted(engines);
  assert.equal(vllm.seen.at(-1).headers["x-request-id"], engines.headers["x-request-id"]);

  const offline = await send(port, "/api/m/llama/status");
  assert.equal(offline.status, 502);
  assert.equal(offline.json.error.code, "manager_unreachable");

  // The entry's own guards run first: nothing proxied, nothing cross-site.
  const before = vllm.seen.length;
  const proxied = await send(port, "/api/m/vllm/status", { headers: { "x-forwarded-for": "203.0.113.5" } });
  assert.equal(proxied.status, 404);
  assert.equal(proxied.json.code, "public_proxy_gateway_only");
  const crossSite = await send(port, "/api/m/vllm/start", { method: "POST", headers: { origin: "https://evil.example.com" }, body: "{}" });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json.code, "origin_not_allowed");
  assert.equal(vllm.seen.length, before);

  // The in-process client reaches the same manager.
  const viaClient = await ctx.managerClient.get("vllm", "engines");
  assert.deepEqual(viaClient.data, { ok: true, url: "/api/engines" });

  // Server close ends a proxied stream instead of waiting on it.
  const stream = await openStream(port, "/api/m/vllm/events");
  await waitFor(() => stream.text.includes("hello"), 2000, "the proxied stream");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server.close() hung on the proxied stream")), 3000);
    http5176.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  await waitFor(() => stream.ended, 2000, "the stream to end");
});
