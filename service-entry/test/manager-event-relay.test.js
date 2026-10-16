"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const relayModule = require("../lib/manager-event-relay");
const { createEventBus } = require("../lib/events");
const { createRequestAuth } = require("../lib/request-auth");
const { ownerSession } = require("./helpers/entry-harness");

const { createManagerEventRelay, createSseParser, instanceFingerprint } = relayModule;

// The manager event relay (07 §2.11). Every manager here is a fake on a free
// loopback port or a stubbed request; no request can reach a real service.

const T0 = Date.parse("2026-10-14T08:00:00.000Z");

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
  const lines = [];
  return {
    lines,
    log: (line) => lines.push({ level: "log", line: String(line) }),
    warn: (line) => lines.push({ level: "warn", line: String(line) }),
    error: (line) => lines.push({ level: "error", line: String(line) }),
  };
}

function waitFor(predicate, timeoutMs = 3000, label = "condition") {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// The relay's own timers (backoff and the instances poll) on a manual clock;
// sockets and the bus keep real time.
function fakeClock(start = T0) {
  let current = start;
  let seq = 0;
  const pending = new Set();
  const next = () => [...pending].sort((a, b) => a.at - b.at || a.seq - b.seq)[0] || null;
  return {
    now: () => current,
    timers: {
      setTimeout(fn, ms) {
        const timer = { fn, ms, at: current + Math.max(0, Number(ms) || 0), seq: seq += 1, unref() { return timer; } };
        pending.add(timer);
        return timer;
      },
      clearTimeout(timer) {
        pending.delete(timer);
      },
    },
    next,
    pendingCount: () => pending.size,
    hasPending: (ms) => [...pending].some((timer) => timer.ms === ms),
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = next();
        if (!due || due.at > target) break;
        pending.delete(due);
        current = due.at;
        due.fn();
        for (let index = 0; index < 5; index += 1) await flush();
      }
      current = target;
      for (let index = 0; index < 5; index += 1) await flush();
    },
  };
}

function job(id, status, extra = {}) {
  return { id, type: "serve", title: `job ${id}`, status, logs: [`${id} ${status}`], logCount: 1, logsTruncated: false, meta: {}, createdAt: "2026-10-14T07:00:00.000Z", updatedAt: "2026-10-14T07:00:00.000Z", ...extra };
}

function instance(id, extra = {}) {
  return { id, containerName: `ai-${id}`, running: true, status: "Up 5 minutes", port: 8000, requestsTotal: 0, models: [{ id: "qwen-test", requestsTotal: 0 }], ...extra };
}

let fakePids = 41000;

// A manager with the routes the relay reads: an SSE hub at /api/events (the
// manager-core sse-hub wire format), /api/jobs?fields=summary, /api/instances
// and /api/manager/health (the process identity, a fake pid per manager).
// `extra` maps a path to (req, res, hit) for other routes.
async function fakeManager(t, name, { jobs = [], instances = [], extra = {} } = {}) {
  const seen = [];
  const streams = new Set();
  fakePids += 1;
  const state = { jobs, instances, jobsStatus: 200, instancesStatus: 200, healthStatus: 200, pid: fakePids, startedAt: "2026-10-14T06:00:00.000Z" };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const hit = { method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(hit);
      const pathname = req.url.split("?")[0];
      if (extra[pathname]) return extra[pathname](req, res, hit);
      if (pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 3000\n\n");
        streams.add(res);
        res.on("close", () => streams.delete(res));
        return undefined;
      }
      if (pathname === "/api/jobs") {
        res.writeHead(state.jobsStatus, { "content-type": "application/json" });
        return res.end(JSON.stringify(state.jobs));
      }
      if (pathname === "/api/instances") {
        res.writeHead(state.instancesStatus, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, primaryContainer: `ai-${name}`, instances: state.instances }));
      }
      if (pathname === "/api/manager/health") {
        res.writeHead(state.healthStatus, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, engine: name, managerId: name, currentPid: state.pid, startedAt: state.startedAt }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    });
  });
  const port = await listen(server);
  if (t) t.after(() => closeServer(server));
  const writeAll = (text) => {
    for (const stream of streams) stream.write(text);
  };
  return {
    name,
    port,
    server,
    seen,
    streams,
    state,
    hits: (pathname) => seen.filter((hit) => hit.url.split("?")[0] === pathname).length,
    send: (event, data) => writeAll(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    sendRaw: writeAll,
    dropStreams() {
      for (const stream of [...streams]) stream.destroy();
    },
  };
}

function assertOnlyGets(manager) {
  assert.ok(manager.seen.length > 0, `${manager.name} saw no request`);
  for (const hit of manager.seen) {
    assert.equal(hit.method, "GET", `${manager.name} got ${hit.method} ${hit.url}`);
    assert.equal(hit.body, "", `${manager.name} got a request body on ${hit.url}`);
  }
}

const ownerSecurity = { checkManagementAccess: () => ({ ok: true }), isProxiedRequest: () => false };

function makeRelay(t, managers, options = {}) {
  const logger = options.logger || quietLogger();
  const auth = createRequestAuth({ security: ownerSecurity, logger });
  const bus = createEventBus({ auth, logger });
  const relay = createManagerEventRelay({
    bus,
    managers: managers.map((manager) => (manager.server ? { id: manager.name, port: manager.port } : manager)),
    logger,
    random: () => 0.5,
    ...options,
  });
  t.after(() => {
    relay.stop();
    bus.close();
  });
  // Read through the ring, not a subscription: an in-process subscriber
  // would count as an `instances` listener and turn synthesis on.
  const published = (type) => bus.recent({ types: type, limit: 500 }).events;
  return { relay, bus, logger, published };
}

function linkOf(relay, managerId = "vllm") {
  return relay.status().find((item) => item.managerId === managerId);
}

async function connectedRelay(t, managers, options = {}) {
  const made = makeRelay(t, managers, options);
  made.relay.start();
  for (const manager of managers) {
    await waitFor(() => linkOf(made.relay, manager.name)?.state === "connected" && manager.streams.size === 1, 3000, `${manager.name} connected`);
    // The connect-time reads are served before anything else is changed.
    await waitFor(() => manager.hits("/api/jobs") >= 1 && manager.hits("/api/instances") >= 1 && manager.hits("/api/manager/health") >= 1, 3000, `${manager.name} seed reads`);
  }
  return made;
}

// --- SSE parsing ---------------------------------------------------------

test("the SSE parser follows the wire rules and reports an oversize frame", () => {
  const events = [];
  const retries = [];
  const parser = createSseParser({ onEvent: (name, data) => events.push([name, data]), onRetry: (ms) => retries.push(ms), maxChars: 64 });
  assert.equal(parser.push("retry: 3000\n\n: ping 1\n\nid: 7\nevent: jobs\ndata: [1,"), true);
  assert.deepEqual(retries, [3000], "an all-digit retry field is reported");
  assert.deepEqual(events, []);
  parser.push("2]\n\nevent: instances\r\ndata: {\"a\":1}\r");
  parser.push("\n\r\ndata: one\ndata: two\n\n");
  parser.push("event: lonely\n\n");
  parser.push("retry: 2s\nretry: -5\nretry:\n\n");
  parser.push("data:no-space\r\rdata\n\n");
  assert.deepEqual(events, [
    ["jobs", "[1,2]"],
    ["instances", "{\"a\":1}"],
    ["message", "one\ntwo"],
    ["message", "no-space"],
    ["message", ""],
  ]);
  assert.deepEqual(retries, [3000], "a retry field that is not all digits is ignored");
  assert.equal(parser.push(`event: jobs\ndata: ${"x".repeat(80)}`), false, "a frame past the cap is reported");
});

test("an instance fingerprint covers id, lifecycle, running, port and model only", () => {
  const base = instance("primary", { lifecycle: { state: "loading", phase: "weights" } });
  const same = { ...base, requestsTotal: 99, status: "Up 9 minutes", models: [{ id: "qwen-test", requestsTotal: 99 }] };
  assert.equal(instanceFingerprint(same), instanceFingerprint(base));
  for (const changed of [
    { ...base, lifecycle: { state: "ready", phase: "weights" } },
    { ...base, lifecycle: { state: "loading", phase: "kv" } },
    { ...base, running: false },
    { ...base, port: 8001 },
    { ...base, models: [{ id: "other" }] },
  ]) {
    assert.notEqual(instanceFingerprint(changed), instanceFingerprint(base));
  }
});

// --- jobs ------------------------------------------------------------------

test("jobs: only changed jobs are relayed, removed ids are listed and an unchanged snapshot publishes nothing", async (t) => {
  const initial = [job("a", "running"), job("b", "done"), job("c", "failed")];
  const vllm = await fakeManager(t, "vllm", { jobs: initial });
  const { published } = await connectedRelay(t, [vllm]);

  // The same list again, with keys in another order: nothing changed.
  vllm.send("jobs", initial.map((item) => Object.fromEntries(Object.entries(item).reverse())));
  const aDone = job("a", "done", { logs: ["a running", "a done"], logCount: 2 });
  vllm.send("jobs", [aDone, initial[1], initial[2]]);
  await waitFor(() => published("jobs").length === 1, 3000, "the first delta");
  let [event] = published("jobs");
  assert.equal(event.source, "vllm");
  assert.deepEqual(event.data, { managerId: "vllm", jobs: [aDone], removed: [] });

  vllm.send("jobs", [aDone, initial[1]]);
  await waitFor(() => published("jobs").length === 2, 3000, "the removal");
  event = published("jobs")[1];
  assert.deepEqual(event.data, { managerId: "vllm", jobs: [], removed: ["c"] });

  const pull = job("dl_abcdefghijklmnopqrst", "running", { type: "image-pull", progress: { percent: 12 } });
  vllm.send("jobs", [pull, aDone, initial[1]]);
  await waitFor(() => published("jobs").length === 3, 3000, "the new pull job");
  assert.deepEqual(published("jobs")[2].data.jobs.map((item) => item.id), [pull.id]);

  // A delta-shaped payload merges by id and removes only what it names.
  vllm.send("jobs", { managerId: "vllm", jobs: [{ ...pull, progress: { percent: 40 } }], removed: ["b"] });
  await waitFor(() => published("jobs").length === 4, 3000, "the delta payload");
  assert.deepEqual(published("jobs")[3].data.removed, ["b"]);
  assert.deepEqual(published("jobs")[3].data.jobs.map((item) => item.progress.percent), [40]);
  assertOnlyGets(vllm);
});

test("a fresh connection seeds the job map from /api/jobs and never floods", async (t) => {
  const history = Array.from({ length: 60 }, (_, index) => job(`old-${index}`, "done"));
  const vllm = await fakeManager(t, "vllm", { jobs: history });
  const { published } = await connectedRelay(t, [vllm]);
  const next = [job("new", "running"), ...history];
  vllm.send("jobs", next);
  await waitFor(() => published("jobs").length === 1, 3000, "the delta");
  assert.deepEqual(published("jobs")[0].data.jobs.map((item) => item.id), ["new"]);
  assert.equal(vllm.hits("/api/jobs"), 1);
  assert.ok(vllm.seen.find((hit) => hit.url.startsWith("/api/jobs")).url.endsWith("?fields=summary"));
});

test("the first snapshot after a reconnect is diffed against the previous map", async (t) => {
  const clock = fakeClock();
  const vllm = await fakeManager(t, "vllm", { jobs: [job("a", "running"), job("b", "done")] });
  const { relay, published } = await connectedRelay(t, [vllm], { now: clock.now, timers: clock.timers });

  vllm.dropStreams();
  await waitFor(() => linkOf(relay).state === "down", 3000, "the drop");
  // While the stream is down job a finishes.
  vllm.state.jobs = [job("a", "done"), job("b", "done")];
  assert.equal(clock.next().ms, 1000);
  await clock.advance(1000);
  await waitFor(() => published("jobs").length === 1, 3000, "the catch-up delta");
  assert.deepEqual(published("jobs")[0].data, { managerId: "vllm", jobs: [job("a", "done")], removed: [] });
  assert.equal(linkOf(relay).state, "connected");
  assert.equal(linkOf(relay).reconnects, 1);

  // The manager's next broadcast repeats the list: nothing new to relay.
  vllm.send("jobs", vllm.state.jobs);
  vllm.send("jobs", [job("c", "running"), ...vllm.state.jobs]);
  await waitFor(() => published("jobs").length === 2, 3000, "the next delta");
  assert.deepEqual(published("jobs")[1].data.jobs.map((item) => item.id), ["c"]);
  assert.deepEqual(published("status").map((item) => item.data.reason), ["manager_up", "manager_down", "manager_up"]);
  assertOnlyGets(vllm);
});

test("a failed seed read never floods: only jobs updated since the stream opened are relayed", async (t) => {
  const clock = fakeClock();
  const history = Array.from({ length: 40 }, (_, index) => job(`old-${index}`, "done"));
  const fresh = (id, status) => job(id, status, { updatedAt: new Date(T0 + 1000).toISOString() });
  // vllm: the seed read is still running when the first snapshot arrives,
  // then fails. llama: the seed read fails at once, before any snapshot.
  const vllm = await fakeManager(t, "vllm", { jobs: history });
  const llama = await fakeManager(t, "llama", { jobs: history });
  let failVllmSeed = null;
  const seedReads = [];
  const fetchJson = async (managerId, target) => {
    const manager = managerId === "vllm" ? vllm : llama;
    if (target.startsWith("jobs")) {
      seedReads.push(managerId);
      if (managerId === "vllm") {
        await new Promise((resolve) => {
          failVllmSeed = resolve;
        });
        return { ok: false, status: 0, code: "manager_timeout", data: null };
      }
      return { ok: false, status: 500, data: null };
    }
    return { ok: true, status: 200, data: { instances: manager.state.instances } };
  };
  const { relay, published } = makeRelay(t, [vllm, llama], { now: clock.now, timers: clock.timers, fetchJson });
  relay.start();
  await waitFor(() => vllm.streams.size === 1 && llama.streams.size === 1 && seedReads.length === 2 && failVllmSeed, 3000, "both streams and seed reads");

  vllm.send("jobs", [fresh("v-new", "running"), ...history]);
  await waitFor(() => linkOf(relay, "vllm").lastEventAt, 3000, "the held vllm snapshot");
  assert.equal(published("jobs").length, 0, "a snapshot is held while the seed read runs");
  failVllmSeed();
  await waitFor(() => published("jobs").length === 1, 3000, "the vllm delta");
  assert.deepEqual(published("jobs")[0].data, { managerId: "vllm", jobs: [fresh("v-new", "running")], removed: [] });

  llama.send("jobs", [...history.slice(0, 39), fresh("l-new", "running")]);
  await waitFor(() => published("jobs").length === 2, 3000, "the llama delta");
  assert.deepEqual(published("jobs")[1].data, { managerId: "llama", jobs: [fresh("l-new", "running")], removed: [] });

  // From then on the map decides, whatever a job's timestamp says.
  llama.send("jobs", [{ ...history[0], status: "failed" }, fresh("l-new", "running")]);
  await waitFor(() => published("jobs").length === 3, 3000, "the next llama delta");
  assert.deepEqual(published("jobs")[2].data.jobs.map((item) => `${item.id}:${item.status}`), ["old-0:failed"]);
  assert.deepEqual(published("jobs")[2].data.removed, history.slice(1, 39).map((item) => item.id));
  assert.equal(llama.hits("/api/jobs"), 0, "the stub answered every read");
});

test("a snapshot held during the seed read never regresses a job or removes one the seed has", async (t) => {
  const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
  // The snapshot was built before the seed answer: s was created and a
  // finished in between, but b moved on again after the seed.
  const seed = [job("s", "running", { updatedAt: at(2) }), job("a", "done", { updatedAt: at(2) }), job("b", "running", { updatedAt: at(2) })];
  const held = [job("a", "running", { updatedAt: at(1) }), job("b", "done", { updatedAt: at(3) })];
  const vllm = await fakeManager(t, "vllm");
  let releaseSeed = null;
  const fetchJson = async (managerId, target) => {
    if (target.startsWith("jobs")) {
      await new Promise((resolve) => {
        releaseSeed = resolve;
      });
      return { ok: true, status: 200, data: seed };
    }
    return { ok: true, status: 200, data: { instances: [] } };
  };
  const { relay, published } = makeRelay(t, [vllm], { fetchJson });
  relay.start();
  await waitFor(() => vllm.streams.size === 1 && releaseSeed, 3000, "the stream and the seed read");
  vllm.send("jobs", held);
  await waitFor(() => linkOf(relay).lastEventAt, 3000, "the held snapshot");
  releaseSeed();
  await waitFor(() => published("jobs").length === 1, 3000, "the reconciled delta");
  assert.deepEqual(published("jobs")[0].data, { managerId: "vllm", jobs: [held[1]], removed: [] });

  // The map now holds the newest copy of every job: repeating it is silent.
  const current = [seed[0], seed[1], held[1]];
  vllm.send("jobs", current);
  vllm.send("jobs", [job("c", "running", { updatedAt: at(4) }), ...current]);
  await waitFor(() => published("jobs").length === 2, 3000, "the next delta");
  assert.deepEqual(published("jobs")[1].data, { managerId: "vllm", jobs: [job("c", "running", { updatedAt: at(4) })], removed: [] });
});

// --- connection, backoff and status ---------------------------------------

// A stand-in for http.get: "refuse" fails like a stopped manager, "accept"
// answers with an event stream the test controls.
function stubHttpGet(clock) {
  const stub = { mode: "refuse", attempts: [], current: null };
  stub.httpGet = (options, onResponse) => {
    stub.attempts.push({ at: clock.now(), method: options.method, path: options.path, headers: { ...options.headers } });
    const request = new EventEmitter();
    request.destroyed = false;
    request.setTimeout = () => request;
    request.destroy = () => {
      if (request.destroyed) return;
      request.destroyed = true;
      process.nextTick(() => request.emit("close"));
    };
    if (stub.mode === "refuse") {
      process.nextTick(() => {
        request.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
        request.destroy();
      });
    } else {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { "content-type": "text/event-stream; charset=utf-8" };
      stub.current = { request, response };
      process.nextTick(() => onResponse(response));
    }
    return request;
  };
  return stub;
}

const emptyFetch = async () => ({ ok: true, status: 200, data: [] });

async function backoffRun(t) {
  const clock = fakeClock();
  const stub = stubHttpGet(clock);
  const made = makeRelay(t, [{ id: "vllm", port: 5999 }], { now: clock.now, timers: clock.timers, httpGet: stub.httpGet, fetchJson: emptyFetch });
  const { relay } = made;
  const delays = [];
  relay.start();
  await waitFor(() => linkOf(relay).state === "down", 2000, "the first refusal");
  for (let index = 0; index < 8; index += 1) {
    assert.equal(clock.pendingCount(), 1, "only the retry timer is pending while down");
    const delay = clock.next().at - clock.now();
    delays.push(delay);
    await clock.advance(delay);
    await waitFor(() => stub.attempts.length === index + 2, 2000, `attempt ${index + 2}`);
    await flush();
  }
  return { clock, stub, delays, ...made };
}

test("reconnect backoff doubles from 1 s to 30 s and resets after 60 s connected", async (t) => {
  const { clock, stub, delays, relay } = await backoffRun(t);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(linkOf(relay).state, "down");

  // Back for 10 s, then dropped: a short connection keeps the backoff at the cap.
  stub.mode = "accept";
  await clock.advance(clock.next().at - clock.now());
  await waitFor(() => linkOf(relay).state === "connected", 2000, "the reconnect");
  await clock.advance(10000);
  stub.current.response.end();
  await waitFor(() => linkOf(relay).state === "down", 2000, "the short drop");
  assert.equal(clock.next().at - clock.now(), 30000);

  // Back for more than 60 s: the next backoff starts at 1 s again.
  await clock.advance(30000);
  await waitFor(() => linkOf(relay).state === "connected", 2000, "the second reconnect");
  await clock.advance(61000);
  stub.current.response.end();
  await waitFor(() => linkOf(relay).state === "down", 2000, "the long drop");
  assert.equal(clock.next().at - clock.now(), 1000);
  // The first stream after the refusals is the first connection, not a reconnect.
  assert.equal(linkOf(relay).reconnects, 1);
  for (const attempt of stub.attempts) {
    assert.equal(attempt.method, "GET");
    assert.equal(attempt.path, "/api/events");
    assert.match(attempt.headers["x-request-id"], /^req_[a-z2-7]{20}$/);
  }
});

test("status is published and logged once per state change, never per retry", async (t) => {
  const { clock, stub, logger, published, relay } = await backoffRun(t);
  // Nine refused attempts: one line and one event.
  assert.equal(logger.lines.length, 1, JSON.stringify(logger.lines));
  assert.equal(logger.lines[0].level, "warn");
  assert.match(logger.lines[0].line, /cannot reach the vllm manager event stream \(ECONNREFUSED\)/);
  assert.deepEqual(published("status").map((item) => item.data), [{ reason: "manager_down", managerId: "vllm" }]);
  assert.equal(published("status")[0].source, "entry");

  stub.mode = "accept";
  await clock.advance(clock.next().at - clock.now());
  await waitFor(() => linkOf(relay).state === "connected", 2000, "the reconnect");
  assert.equal(logger.lines.length, 2);
  assert.equal(logger.lines[1].level, "log");
  assert.match(logger.lines[1].line, /vllm manager event stream is back after \d+ s/);

  stub.current.response.end();
  await waitFor(() => linkOf(relay).state === "down", 2000, "the drop");
  stub.mode = "refuse";
  for (let index = 0; index < 4; index += 1) await clock.advance(clock.next().at - clock.now());
  assert.equal(logger.lines.length, 3);
  assert.match(logger.lines[2].line, /lost the vllm manager event stream \(ended\)/);
  assert.deepEqual(published("status").map((item) => item.data.reason), ["manager_down", "manager_up", "manager_down"]);
  const status = linkOf(relay);
  assert.equal(status.state, "down");
  assert.equal(typeof status.since, "string");
});

test("the backoff jitter stays within ±20 % and never passes the cap", async (t) => {
  for (const [draw, first, capped] of [[0, 800, 24000], [1, 1200, 30000]]) {
    const clock = fakeClock();
    const stub = stubHttpGet(clock);
    const { relay } = makeRelay(t, [{ id: "llama", port: 5999 }], { now: clock.now, timers: clock.timers, httpGet: stub.httpGet, fetchJson: emptyFetch, random: () => draw });
    relay.start();
    await waitFor(() => linkOf(relay, "llama").state === "down", 2000, "the refusal");
    assert.equal(clock.next().at - clock.now(), first);
    let delay = 0;
    for (let index = 0; index < 7; index += 1) {
      delay = clock.next().at - clock.now();
      await clock.advance(delay);
      await waitFor(() => stub.attempts.length === index + 2, 2000, "the retry");
    }
    assert.equal(clock.next().at - clock.now(), capped);
    relay.stop();
    assert.equal(clock.pendingCount(), 0, "stop cancels the retry timer");
  }
});

test("a stream the manager ended waits for its retry hint before the next attempt; a dropped one does not", async (t) => {
  const clock = fakeClock();
  const stub = stubHttpGet(clock);
  stub.mode = "accept";
  const { relay } = makeRelay(t, [{ id: "vllm", port: 5999 }], { now: clock.now, timers: clock.timers, httpGet: stub.httpGet, fetchJson: emptyFetch });
  relay.start();
  const endWith = async (hint, finish) => {
    await waitFor(() => linkOf(relay).state === "connected", 2000, "the stream");
    const { response } = stub.current;
    response.write(`retry: ${hint}\n\n`);
    await flush();
    finish(response);
    await waitFor(() => linkOf(relay).state === "down", 2000, "the end of the stream");
    const delay = clock.next().at - clock.now();
    await clock.advance(delay);
    return delay;
  };
  // A graceful end is a manager shutting down: the 1 s backoff becomes 5 s.
  assert.equal(await endWith(5000, (response) => response.end()), 5000);
  // A hint is honoured up to the backoff cap only.
  assert.equal(await endWith(3600000, (response) => response.end()), 30000);
  // A broken stream keeps the plain backoff (1 s doubled twice).
  assert.equal(await endWith(5000, (response) => response.destroy(Object.assign(new Error("reset"), { code: "ECONNRESET" }))), 4000);
  await waitFor(() => linkOf(relay).state === "connected", 2000, "the last reconnect");
  assert.equal(linkOf(relay).reconnects, 3);
});

test("a stream is dropped when its manager stops listening or another process answers", async (t) => {
  const clock = fakeClock();
  const vllm = await fakeManager(t, "vllm");
  const { relay, logger } = await connectedRelay(t, [vllm], { now: clock.now, timers: clock.timers });
  assert.equal(vllm.hits("/api/manager/health"), 1, "the process is recorded on connect");
  // The next check is due 15 s after an answer arrived.
  const nextCheck = (count) => waitFor(() => vllm.hits("/api/manager/health") === count && clock.hasPending(15000), 3000, `check ${count}`);
  await nextCheck(1);

  // Answers that say nothing about the process keep the stream: an error
  // status, then the start time moving by a few seconds (it is derived from
  // the manager's uptime on every answer).
  vllm.state.healthStatus = 500;
  await clock.advance(15000);
  await nextCheck(2);
  vllm.state.healthStatus = 200;
  vllm.state.startedAt = "2026-10-14T06:00:04.000Z";
  await clock.advance(15000);
  await nextCheck(3);
  assert.equal(linkOf(relay).state, "connected");
  assert.equal(vllm.streams.size, 1);

  // The manager restarted on the same port: another pid answers.
  vllm.state.pid += 1;
  await clock.advance(15000);
  await waitFor(() => linkOf(relay).state === "down", 3000, "the drop after a restart");
  assert.ok(logger.lines.some((item) => item.line.includes("lost the vllm manager event stream (stale_stream)")));
  await waitFor(() => vllm.streams.size === 0, 3000, "the stale stream to close");
  await clock.advance(clock.next().at - clock.now());
  await waitFor(() => linkOf(relay).state === "connected" && vllm.streams.size === 1, 3000, "the reconnect");
  await nextCheck(5);

  // The manager stopped listening but its open stream would keep it alive:
  // the next check is refused and the relay lets go, so the server closes.
  let serverClosed = false;
  vllm.server.close(() => {
    serverClosed = true;
  });
  await clock.advance(15000);
  await waitFor(() => serverClosed, 3000, "the manager's server to close");
  assert.equal(linkOf(relay).state, "down");
  assert.equal(linkOf(relay).reconnects, 1);
  assertOnlyGets(vllm);
});

test("a manager that shuts down slowly is let go, and its successor on the same port is relayed", async (t) => {
  // The real manager-core hub and lifecycle: onShutdown closes the hub first
  // and flushes for a while before the server stops listening, longer than
  // the relay's first retry, so the relay reattaches to the stopping process.
  const { createSseHub } = require("../../manager-core/sse-hub");
  const { createManagerLifecycle } = require("../../manager-core/manager-lifecycle");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-relay-lifecycle-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const silent = { log() {}, warn() {}, error() {} };
  const startManager = async (port, { pid, tailMs, jobs }) => {
    const hub = createSseHub();
    const eventRequests = [];
    const handler = (req, res) => {
      const pathname = req.url.split("?")[0];
      const json = (body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "GET") {
        res.writeHead(405);
        return res.end();
      }
      if (pathname === "/api/events") {
        eventRequests.push(Date.now());
        return hub.handleRequest(req, res);
      }
      if (pathname === "/api/jobs") return json(jobs);
      if (pathname === "/api/instances") return json({ ok: true, instances: [] });
      if (pathname === "/api/manager/health") return json({ ok: true, currentPid: pid, startedAt: new Date(T0 + pid).toISOString() });
      res.writeHead(404);
      return res.end();
    };
    const app = {
      listen: (listenPort, host, onListening) => {
        const server = http.createServer(handler);
        server.listen(listenPort, host, onListening);
        return server;
      },
    };
    const lifecycle = createManagerLifecycle({
      app,
      host: "127.0.0.1",
      port,
      label: "fake manager",
      pidFile: path.join(tempDir, `manager-${pid}.pid`),
      logger: silent,
      onShutdown: async () => {
        hub.close();
        await new Promise((resolve) => setTimeout(resolve, tailMs));
      },
    });
    const server = await lifecycle.startManager();
    await new Promise((resolve, reject) => {
      if (server.listening) return resolve();
      server.once("listening", resolve);
      server.once("error", reject);
      return undefined;
    });
    return { hub, lifecycle, server, eventRequests };
  };

  const first = await startManager(0, { pid: 41001, tailMs: 1500, jobs: [] });
  const port = first.server.address().port;
  const { relay, published } = makeRelay(t, [{ id: "vllm", port }], { minBackoffMs: 100, maxBackoffMs: 300, suspectCheckMs: 50 });
  relay.start();
  await waitFor(() => linkOf(relay).state === "connected" && first.hub.clientCount() === 1, 3000, "the first stream");

  let shutDown = false;
  const shutdown = first.lifecycle.shutdownManager("api").then(() => {
    shutDown = true;
  });
  await waitFor(() => shutDown, 5000, "the manager shutdown to finish");
  await shutdown;
  assert.equal(first.eventRequests.length, 2, "the relay reattached while the manager was flushing");

  const second = await startManager(port, { pid: 41002, tailMs: 0, jobs: [] });
  t.after(async () => {
    relay.stop();
    await second.lifecycle.shutdownManager("test");
  });
  await waitFor(() => linkOf(relay).state === "connected" && second.hub.clientCount() === 1, 5000, "the stream to the new manager");
  second.hub.broadcast("jobs", [job("after-restart", "running", { updatedAt: new Date().toISOString() })]);
  await waitFor(() => published("jobs").some((event) => event.data.jobs.some((item) => item.id === "after-restart")), 3000, "the new manager's job");
  assert.ok(linkOf(relay).reconnects >= 2);
});

test("a manager answering without an event stream is down, not connected", async (t) => {
  const odd = await fakeManager(t, "vllm", {
    extra: { "/api/events": (req, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); } },
  });
  const clock = fakeClock();
  const { relay, logger } = makeRelay(t, [odd], { now: clock.now, timers: clock.timers });
  relay.start();
  await waitFor(() => linkOf(relay).state === "down", 2000, "the refusal");
  assert.match(logger.lines[0].line, /\(http_404\)/);
  assert.equal(odd.hits("/api/jobs"), 0, "nothing is read before the stream is up");
});

// --- instances -------------------------------------------------------------

test("instances are synthesised only while someone subscribes and only on change", async (t) => {
  const clock = fakeClock();
  const vllm = await fakeManager(t, "vllm", { instances: [instance("primary")] });
  const { relay, bus, published } = await connectedRelay(t, [vllm], { now: clock.now, timers: clock.timers });
  assert.equal(vllm.hits("/api/instances"), 1, "one baseline read per connection");

  // Nobody listens: no polling and nothing published, whatever changes.
  vllm.state.instances = [instance("primary", { port: 8100 })];
  await clock.advance(30000);
  await relay.poke("vllm");
  assert.equal(vllm.hits("/api/instances"), 1);
  assert.equal(published("instances").length, 0);

  const off = bus.subscribe(() => {}, { types: ["instances"] });
  // The first poll with a listener reports what moved since the last read.
  await clock.advance(10000);
  await waitFor(() => published("instances").length === 1, 3000, "the first synthesised event");
  assert.deepEqual(published("instances")[0].data, { managerId: "vllm", changed: ["primary"], removed: [], native: false });
  assert.equal(published("instances")[0].source, "vllm");

  // Counters and the Docker status text move every poll; nothing is published.
  vllm.state.instances = [instance("primary", { port: 8100, requestsTotal: 42, status: "Up 9 minutes" })];
  await clock.advance(10000);
  await waitFor(() => vllm.hits("/api/instances") === 3, 3000, "the second poll");
  await relay.poke("vllm");
  assert.equal(published("instances").length, 1);

  vllm.state.instances = [instance("primary", { port: 8100, lifecycle: { state: "ready", phase: "ready" } }), instance("side", { port: 8200 })];
  await clock.advance(10000);
  await waitFor(() => published("instances").length === 2, 3000, "the change");
  assert.deepEqual(published("instances")[1].data, { managerId: "vllm", changed: ["primary", "side"], removed: [], native: false });

  vllm.state.instances = [instance("primary", { port: 8100, lifecycle: { state: "ready", phase: "ready" } })];
  await clock.advance(10000);
  await waitFor(() => published("instances").length === 3, 3000, "the removal");
  assert.deepEqual(published("instances")[2].data, { managerId: "vllm", changed: [], removed: ["side"], native: false });

  off();
  const reads = vllm.hits("/api/instances");
  await clock.advance(60000);
  await relay.poke("vllm");
  assert.equal(vllm.hits("/api/instances"), reads, "polling stops with the last listener");
  assertOnlyGets(vllm);
});

test("poke and a job state change trigger an immediate instances read", async (t) => {
  const clock = fakeClock();
  const vllm = await fakeManager(t, "vllm", { jobs: [job("start-1", "running")], instances: [] });
  const { relay, bus, published } = await connectedRelay(t, [vllm], { now: clock.now, timers: clock.timers });
  bus.subscribe(() => {}, { types: ["instances", "jobs"] });

  vllm.state.instances = [instance("primary")];
  await relay.poke("vllm");
  assert.deepEqual(published("instances").map((item) => item.data.changed), [["primary"]], "poke read at once, without a clock tick");
  assert.equal(clock.now(), T0);

  // A job that only logs does not trigger a read; a state change does.
  const before = vllm.hits("/api/instances");
  vllm.send("jobs", [job("start-1", "running", { logs: ["weights 50%"] })]);
  await waitFor(() => published("jobs").length === 1, 3000, "the progress delta");
  await flush();
  assert.equal(vllm.hits("/api/instances"), before);
  vllm.state.instances = [];
  vllm.send("jobs", [job("start-1", "failed", { logs: ["weights 50%"] })]);
  await waitFor(() => published("instances").length === 2, 3000, "the job-state read");
  assert.deepEqual(published("instances")[1].data, { managerId: "vllm", changed: [], removed: ["primary"], native: false });
  assert.equal(clock.now(), T0);

  await relay.poke("nobody");
  await relay.poke(undefined);
  assertOnlyGets(vllm);
});

test("a native instances event switches synthesis off for that manager", async (t) => {
  const clock = fakeClock();
  const vllm = await fakeManager(t, "vllm", { instances: [instance("primary")] });
  const llama = await fakeManager(t, "llama", { instances: [instance("primary")] });
  const { relay, bus, published } = await connectedRelay(t, [vllm, llama], { now: clock.now, timers: clock.timers });
  bus.subscribe(() => {}, { types: ["instances"] });

  // A payload with the list is fingerprinted as it is; no read is needed.
  const reads = vllm.hits("/api/instances");
  vllm.send("instances", { managerId: "vllm", instances: [instance("primary", { running: false })] });
  await waitFor(() => published("instances").length === 1, 3000, "the native event");
  assert.deepEqual(published("instances")[0].data, { managerId: "vllm", changed: ["primary"], removed: [], native: true });
  assert.equal(vllm.hits("/api/instances"), reads);
  assert.equal(linkOf(relay, "vllm").nativeInstances, true);
  assert.equal(linkOf(relay, "llama").nativeInstances, false);

  // Synthesis is off for vllm: no polls, no poke reads. llama still polls.
  vllm.state.instances = [instance("primary", { port: 9000 })];
  llama.state.instances = [instance("primary", { port: 9100 })];
  await clock.advance(30000);
  await relay.poke("vllm");
  await waitFor(() => published("instances").some((item) => item.data.managerId === "llama"), 3000, "the llama synthesis");
  assert.equal(vllm.hits("/api/instances"), reads);
  assert.equal(published("instances").filter((item) => item.data.managerId === "vllm").length, 1);

  // A bare trigger re-reads /api/instances once.
  vllm.send("instances", {});
  await waitFor(() => published("instances").filter((item) => item.data.managerId === "vllm").length === 2, 3000, "the triggered read");
  assert.equal(vllm.hits("/api/instances"), reads + 1);
  const triggered = published("instances").filter((item) => item.data.managerId === "vllm")[1];
  assert.deepEqual(triggered.data, { managerId: "vllm", changed: ["primary"], removed: [], native: true });

  // Ids the manager names are carried even when the fingerprint is the same.
  vllm.send("instances", { managerId: "vllm", instances: vllm.state.instances, changed: ["primary"] });
  await waitFor(() => published("instances").filter((item) => item.data.managerId === "vllm").length === 3, 3000, "the named change");
  assertOnlyGets(vllm);
  assertOnlyGets(llama);
});

// --- robustness --------------------------------------------------------------

test("a malformed frame is skipped and the stream keeps relaying", async (t) => {
  const vllm = await fakeManager(t, "vllm", { jobs: [job("a", "running")] });
  const { relay, logger, published } = await connectedRelay(t, [vllm]);
  vllm.sendRaw("event: jobs\ndata: {not json\n\n");
  vllm.sendRaw("event: jobs\ndata: {\"nothing\":true}\n\n");
  vllm.sendRaw("event: instances\ndata: 42\n\n");
  // Unknown and unnamed events are ignored without a log line.
  vllm.sendRaw("event: downloads\ndata: {\"jobs\":[]}\n\n");
  vllm.sendRaw("data: hello\n\n");
  vllm.sendRaw(": ping 1\n\n");
  vllm.send("jobs", [job("a", "done")]);
  await waitFor(() => published("jobs").length === 1, 3000, "the valid frame");
  assert.deepEqual(published("jobs")[0].data.jobs.map((item) => item.status), ["done"]);
  const warnings = logger.lines.filter((item) => item.level === "warn").map((item) => item.line);
  assert.equal(warnings.length, 2, JSON.stringify(warnings));
  assert.ok(warnings.some((line) => line.includes("malformed jobs frame from the vllm manager")));
  assert.ok(warnings.some((line) => line.includes("malformed instances frame from the vllm manager")));
  assert.equal(linkOf(relay).state, "connected");
  assert.equal(linkOf(relay).reconnects, 0);
  assert.equal(published("instances").length, 0);
  assert.equal(linkOf(relay).nativeInstances, false, "a malformed instances frame is not a native event");
  assert.equal(typeof linkOf(relay).lastEventAt, "string");
});

test("a silent or oversize stream is dropped and replaced", async (t) => {
  const quiet = await fakeManager(t, "vllm");
  const idle = await connectedRelay(t, [quiet], { now: fakeClock().now, timers: fakeClock().timers, idleTimeoutMs: 400 });
  // No heartbeat for longer than the idle timeout: the socket is half-open.
  await waitFor(() => linkOf(idle.relay, "vllm").state === "down", 3000, "the idle drop");
  assert.ok(idle.logger.lines.some((item) => item.line.includes("lost the vllm manager event stream (idle_timeout)")));
  await waitFor(() => quiet.streams.size === 0, 3000, "the idle stream to close");

  const clock = fakeClock();
  const chatty = await fakeManager(t, "llama");
  const { relay, logger } = await connectedRelay(t, [chatty], { now: clock.now, timers: clock.timers, maxFrameChars: 4096 });
  chatty.sendRaw(`event: jobs\ndata: ${"x".repeat(5000)}`);
  await waitFor(() => linkOf(relay, "llama").state === "down", 3000, "the oversize drop");
  assert.ok(logger.lines.some((item) => item.line.includes("lost the llama manager event stream (frame_too_large)")));
  await waitFor(() => chatty.streams.size === 0, 3000, "the oversize stream to close");
  await clock.advance(1000);
  await waitFor(() => linkOf(relay, "llama").state === "connected" && chatty.streams.size === 1, 3000, "the reconnect");
});

test("relayed job summaries pass through the secret redactor", async (t) => {
  const vllm = await fakeManager(t, "vllm", { jobs: [] });
  const { published } = await connectedRelay(t, [vllm]);
  vllm.send("jobs", [job("a", "running", { logs: [`docker run --api-key ${"sk-" + "test-fake-0000000000"} image`] })]);
  await waitFor(() => published("jobs").length === 1, 3000, "the delta");
  const text = JSON.stringify(published("jobs")[0]);
  assert.equal(text.includes(("sk-" + "test-fake-0000000000")), false);
  assert.ok(text.includes("<redacted>"));
});

test("stop closes the manager streams and cancels every timer", async (t) => {
  const clock = fakeClock();
  const vllm = await fakeManager(t, "vllm", { instances: [instance("primary")] });
  const { relay, bus } = await connectedRelay(t, [vllm], { now: clock.now, timers: clock.timers });
  bus.subscribe(() => {}, { types: ["instances"] });
  assert.ok(clock.pendingCount() >= 1, "the poll timer runs while connected");
  relay.stop();
  await waitFor(() => vllm.streams.size === 0, 3000, "the stream to close");
  assert.equal(clock.pendingCount(), 0);
  const reads = vllm.hits("/api/instances");
  await relay.poke("vllm");
  await clock.advance(60000);
  assert.equal(vllm.hits("/api/instances"), reads);
  assert.equal(linkOf(relay).state, "down");
  relay.stop();
});

test("no non-GET request ever reaches a manager", async (t) => {
  const clock = fakeClock();
  const vllm = await fakeManager(t, "vllm", { jobs: [job("a", "running")], instances: [instance("primary")] });
  const { relay, bus, published } = await connectedRelay(t, [vllm], { now: clock.now, timers: clock.timers });
  bus.subscribe(() => {}, { types: ["instances"] });
  vllm.state.instances = [instance("primary", { running: false })];
  vllm.send("jobs", [job("a", "done")]);
  await waitFor(() => published("instances").length === 1, 3000, "the job-state read");
  await relay.poke("vllm");
  await clock.advance(20000);
  vllm.send("instances", {});
  vllm.dropStreams();
  await waitFor(() => linkOf(relay).state === "down", 3000, "the drop");
  await clock.advance(1000);
  await waitFor(() => linkOf(relay).state === "connected", 3000, "the reconnect");
  await relay.poke("vllm");
  assert.ok(vllm.seen.length >= 8, `requests: ${vllm.seen.map((hit) => hit.url).join(", ")}`);
  assertOnlyGets(vllm);
  assert.deepEqual([...new Set(vllm.seen.map((hit) => hit.url))].sort(), ["/api/events", "/api/instances", "/api/jobs?fields=summary", "/api/manager/health"]);
});

test("the route module sets ctx.relay, answers no route and is not started in smoke runs", async (t) => {
  const vllm = await fakeManager(t, "vllm", { instances: [instance("primary")] });
  const logger = quietLogger();
  const auth = createRequestAuth({ security: ownerSecurity, logger });
  const bus = createEventBus({ auth, logger });
  t.after(() => bus.close());

  const previous = process.env.AI_FRONTEND_SMOKE;
  process.env.AI_FRONTEND_SMOKE = "1";
  const smokeCtx = { bus, managers: [{ id: "vllm", port: vllm.port }], logger, now: Date.now, relay: null };
  let mounted;
  try {
    mounted = relayModule.mount(smokeCtx);
  } finally {
    if (previous === undefined) delete process.env.AI_FRONTEND_SMOKE;
    else process.env.AI_FRONTEND_SMOKE = previous;
  }
  assert.equal(typeof smokeCtx.relay.poke, "function");
  await flush();
  assert.equal(vllm.seen.length, 0, "a smoke run never connects to a manager");
  mounted.close();

  const ctx = { bus, managers: [{ id: "vllm", port: vllm.port }], logger, now: Date.now, relay: null };
  const live = relayModule.mount(ctx);
  t.after(() => live.close());
  assert.equal(await live.handle({ method: "GET" }, {}, new URL("http://127.0.0.1/api/events")), false);
  await waitFor(() => ctx.relay.status()[0].state === "connected", 3000, "the mounted relay");
  live.close();
  await waitFor(() => vllm.streams.size === 0, 3000, "close to end the stream");
  assert.throws(() => relayModule.mount({ managers: [] }), /ctx\.bus is missing/);
});

// --- through the real entry ------------------------------------------------

const CLEARED_ENV = [
  "SERVICE_ENTRY_HOST",
  "SERVICE_ENTRY_REQUIRE_API_KEY",
  "SERVICE_ENTRY_ALLOW_LAN_ADMIN",
  "SERVICE_ENTRY_ALLOWED_ORIGINS",
  "SERVICE_ENTRY_ALLOWED_HOSTS",
  "SERVICE_ENTRY_PUBLIC_BASE_URL",
  "SERVICE_ENTRY_TRUSTED_PROXIES",
  "SERVICE_ENTRY_RATE_LIMIT_RPM",
  "AI_FRONTEND_SMOKE",
];

let entrySetup = null;

// The entry reads its manager ports when it is loaded, so both fake managers
// listen first and every other upstream port points at nothing.
async function setupEntry() {
  if (entrySetup) return entrySetup;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-manager-relay-"));
  const vllm = await fakeManager(null, "vllm", { jobs: [job("v1", "running")], instances: [instance("primary")] });
  const llama = await fakeManager(null, "llama", {
    jobs: [job("l1", "running")],
    instances: [],
    extra: {
      "/api/start": (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, jobId: "l2" }));
      },
    },
  });
  for (const name of CLEARED_ENV) delete process.env[name];
  process.env.VLLM_MANAGER_PORT = String(vllm.port);
  process.env.LLAMA_MANAGER_PORT = String(llama.port);
  for (const name of ["TTS_GATEWAY_PORT", "SEARCH_GATEWAY_PORT", "PLATFORM_MCP_PORT"]) {
    process.env[name] = String(await unusedPort());
  }
  process.env.PLATFORM_MCP_ENV_FILE = path.join(tempDir, "platform-mcp.env");
  process.env.AI_BILLING_DB = path.join(tempDir, "billing.sqlite");
  process.env.SERVICE_ENTRY_DATA_DIR = path.join(tempDir, "data");
  const entry = require("../server");
  entry.setEntryGatewayAccessSink(async () => {});
  entrySetup = { entry, vllm, llama, tempDir };
  return entrySetup;
}

test.after(async () => {
  if (!entrySetup) return;
  await closeServer(entrySetup.vllm.server);
  await closeServer(entrySetup.llama.server);
  entrySetup.entry.closeAccessStore();
  fs.rmSync(entrySetup.tempDir, { recursive: true, force: true });
});

function openStream(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname, headers }, (response) => {
      response.setEncoding("utf8");
      const stream = { status: response.statusCode, frames: [], close: () => request.destroy() };
      let buffer = "";
      response.on("data", (chunk) => {
        buffer += chunk;
        let cut = buffer.indexOf("\n\n");
        while (cut >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = block.split("\n").find((line) => line.startsWith("data: "));
          if (data) stream.frames.push({ receivedAt: Date.now(), envelope: JSON.parse(data.slice(6)) });
          cut = buffer.indexOf("\n\n");
        }
      });
      resolve(stream);
    });
    request.on("error", reject);
  });
}

function send(port, pathname, { method = "GET", body = "", owner = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(owner ? owner.headers(method) : {}), ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) };
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body || undefined);
  });
}

test("with two fake managers a job state change reaches an /api/events client as a jobs delta within 1 s", async (t) => {
  const { entry, vllm, llama } = await setupEntry();
  assert.deepEqual(entry.ROUTE_MODULES.slice(0, 3), ["./lib/events", "./lib/mgmt-proxy", "./lib/manager-event-relay"]);
  const ctx = entry.createRouteContext({ logger: quietLogger() });
  const routes = await entry.mountRouteModules({ ctx });
  assert.equal(routes.failed.length, 0, JSON.stringify(routes.failed));
  assert.equal(typeof ctx.relay?.poke, "function");
  const server = entry.createServiceEntryServer({ routes });
  const port = await listen(server);
  t.after(() => closeServer(server));
  for (const manager of [vllm, llama]) {
    await waitFor(() => ctx.relay.status().find((item) => item.managerId === manager.name)?.state === "connected", 3000, `${manager.name} connected`);
    await waitFor(() => manager.hits("/api/jobs") >= 1 && manager.hits("/api/instances") >= 1, 3000, `${manager.name} seed reads`);
  }

  // The console owner: a paired session since PUB-5.
  const owner = await ownerSession(entry, port);
  const stream = await openStream(port, "/api/events?types=jobs,instances&client=console", owner.headers());
  assert.equal(stream.status, 200);
  const frames = (type, managerId) => stream.frames.filter((frame) => frame.envelope.type === type && frame.envelope.data.managerId === managerId);

  for (const [manager, id] of [[vllm, "v1"], [llama, "l1"]]) {
    manager.state.jobs = [job(id, "done")];
    const sentAt = Date.now();
    manager.send("jobs", manager.state.jobs);
    await waitFor(() => frames("jobs", manager.name).length === 1, 3000, `the ${manager.name} delta`);
    const [frame] = frames("jobs", manager.name);
    assert.ok(frame.receivedAt - sentAt < 1000, `${manager.name} delta took ${frame.receivedAt - sentAt} ms`);
    assert.equal(frame.envelope.source, manager.name);
    assert.deepEqual(frame.envelope.data, { managerId: manager.name, jobs: [job(id, "done")], removed: [] });
  }

  // A write through the management proxy pokes the relay, so the new
  // instance shows up without waiting for the 10 s poll.
  llama.state.instances = [instance("primary")];
  const started = await send(port, "/api/m/llama/start", { method: "POST", body: "{}", owner });
  assert.equal(started.status, 200, started.body);
  await waitFor(() => frames("instances", "llama").length === 1, 3000, "the poked instances event");
  assert.deepEqual(frames("instances", "llama")[0].envelope.data, { managerId: "llama", changed: ["primary"], removed: [], native: false });

  // The only write a manager ever saw is the one sent through the proxy.
  for (const manager of [vllm, llama]) {
    const writes = manager.seen.filter((hit) => hit.method !== "GET");
    assert.deepEqual(writes.map((hit) => `${hit.method} ${hit.url}`), manager === llama ? ["POST /api/start"] : []);
  }
  stream.close();
});
