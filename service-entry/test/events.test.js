"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const events = require("../lib/events");
const { createRequestAuth } = require("../lib/request-auth");

const { createEventBus, EVENT_TYPES, parseEventId, validateEvent } = events;

// The seam reads the caller's role from security.checkManagementAccess; this
// stand-in turns a test header into "not management-eligible", which is what
// a LAN viewer looks like today.
const fakeSecurity = {
  checkManagementAccess: (req) => (req.headers?.["x-test-viewer"]
    ? { ok: false, status: 403, code: "management_local_only", message: "local only" }
    : { ok: true }),
  isProxiedRequest: () => false,
};

function silentLogger() {
  const lines = [];
  return { lines, warn: (line) => lines.push(String(line)), log: () => {}, error: (line) => lines.push(String(line)) };
}

function makeBus(t, options = {}) {
  const logger = options.logger || silentLogger();
  const auth = options.auth || createRequestAuth({ security: fakeSecurity, logger });
  const bus = createEventBus({ auth, logger, ...options });
  t.after(() => bus.close());
  return { bus, auth, logger };
}

async function serve(t, bus, auth) {
  const mounted = events.mount({ bus, auth });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!(await mounted.handle(req, res, url))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    bus.close();
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return server.address().port;
}

function parseFrames(text) {
  const frames = [];
  for (const block of text.split("\n\n")) {
    if (!block) continue;
    const frame = { comments: [] };
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) frame.comments.push(line.slice(1).trim());
      else if (line.startsWith("id: ")) frame.id = line.slice(4);
      else if (line.startsWith("event: ")) frame.event = line.slice(7);
      else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
      else if (line.startsWith("retry: ")) frame.retry = Number(line.slice(7));
    }
    frames.push(frame);
  }
  return frames;
}

function openStream(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
      res.setEncoding("utf8");
      const stream = {
        status: res.statusCode,
        headers: res.headers,
        raw: "",
        ended: false,
        get frames() {
          // Only complete blocks; a trailing partial frame waits for more data.
          return parseFrames(this.raw.slice(0, this.raw.lastIndexOf("\n\n") + 2));
        },
        get events() {
          return this.frames.filter((frame) => frame.event);
        },
        close() {
          request.destroy();
        },
      };
      const waiters = new Set();
      stream.waitFor = (predicate, timeoutMs = 2000) => new Promise((done, fail) => {
        const check = () => {
          if (predicate(stream)) {
            waiters.delete(check);
            clearTimeout(timer);
            done(stream);
            return true;
          }
          return false;
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          fail(new Error(`timed out waiting; got: ${stream.raw}`));
        }, timeoutMs);
        if (!check()) waiters.add(check);
      });
      res.on("data", (chunk) => {
        stream.raw += chunk;
        for (const check of [...waiters]) check();
      });
      res.on("end", () => {
        stream.ended = true;
        for (const check of [...waiters]) check();
      });
      resolve(stream);
    });
    request.on("error", reject);
  });
}

async function getJson(port, pathname, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
  return { status: response.status, body: await response.json() };
}

// A response double whose buffered byte count the test controls.
function fakeExchange(remoteAddress = "127.0.0.1") {
  const req = new EventEmitter();
  req.headers = {};
  req.socket = { remoteAddress };
  const res = new EventEmitter();
  res.status = 0;
  res.chunks = [];
  res.writableLength = 0;
  res.destroyed = false;
  res.ended = false;
  res.writeHead = (status) => { res.status = status; };
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
  res.end = (chunk) => { if (chunk) res.chunks.push(String(chunk)); res.ended = true; };
  res.destroy = () => { res.destroyed = true; };
  return { req, res };
}

const validNotification = () => ({
  kind: "restore.conflict",
  severity: "warn",
  title: { zh: "恢复冲突", en: "Restore conflict" },
  body: { zh: "需要手动处理", en: "Needs a manual decision" },
  action: { label: { zh: "查看", en: "Open" }, href: "/deployments?manager=vllm" },
  dedupeKey: "restore:vllm",
});

test("EVENT_TYPES is the 00 §9.6 list", () => {
  assert.deepEqual(Object.keys(EVENT_TYPES).sort(), [
    "access", "alerts", "downloads", "instances", "jobs", "library", "notification", "platform", "security", "status", "telemetry.live",
  ]);
});

test("publish validates types, sources and payload shapes and counts what it rejects", (t) => {
  const { bus, logger } = makeBus(t);
  assert.equal(bus.publish("nope", {}), null);
  assert.equal(bus.publish("status", null), null);
  assert.equal(bus.publish("status", ["not", "an", "object"]), null);
  assert.equal(bus.publish("status", {}), null, "status needs a reason");
  assert.equal(bus.publish("status", { reason: "manager_up" }, { source: "somewhere" }), null, "unknown source");
  assert.equal(bus.publish("jobs", { managerId: "vllm", jobs: "x" }), null);
  assert.equal(bus.publish("instances", { managerId: "vllm", changed: [1], removed: [] }), null);
  assert.equal(bus.publish("platform", { opKind: "x" }), null, "platform needs its kind discriminator");

  assert.ok(bus.publish("status", { reason: "manager_up", managerId: "vllm" }));
  assert.ok(bus.publish("jobs", { managerId: "vllm", jobs: [{ id: "j1", state: "running" }], removed: [] }, { source: "vllm" }));
  assert.ok(bus.publish("instances", { managerId: "llama", changed: ["primary"], removed: [], native: false }, { source: "llama" }));
  assert.ok(bus.publish("downloads", { kind: "progress", jobs: [{ id: "dl_1" }], aggregate: {} }));
  assert.ok(bus.publish("alerts", { action: "firing", alert: { ruleId: "r1" } }));
  assert.ok(bus.publish("platform", { kind: "operation", opId: "op1", opKind: "doctor-fix" }));
  for (const type of ["library", "telemetry.live", "security", "access"]) {
    assert.ok(bus.publish(type, { any: "thing" }), type);
  }

  const stats = bus.stats();
  assert.equal(stats.rejected["(unknown)"], 1);
  assert.equal(stats.rejected.status, 4);
  assert.equal(stats.published.status, 1);
  // One line per type and reason, not per event.
  bus.publish("status", {});
  assert.equal(bus.stats().rejected.status, 5);
  assert.equal(logger.lines.filter((line) => line.includes("status_reason")).length, 1);
});

test("notification is validated strictly: same-origin links, both languages, /api/ calls", (t) => {
  const { bus } = makeBus(t);
  const envelope = bus.publish("notification", validNotification());
  assert.ok(envelope);
  assert.equal(envelope.source, "entry");
  assert.equal(envelope.data.dedupeKey, "restore:vllm", "extra keys pass through");

  const variants = {
    "cross-origin href": (n) => { n.action.href = "https://evil.example/x"; },
    "protocol-relative href": (n) => { n.action.href = "//evil.example/x"; },
    "backslash href": (n) => { n.action.href = "/\\evil.example"; },
    "tab in href": (n) => { n.action.href = "/\t/evil.example"; },
    "javascript href": (n) => { n.action.href = "javascript:alert(1)"; },
    "missing title.en": (n) => { delete n.title.en; },
    "empty title.zh": (n) => { n.title.zh = " "; },
    "body without en": (n) => { n.body = { zh: "只有中文" }; },
    "unknown severity": (n) => { n.severity = "critical"; },
    "missing kind": (n) => { delete n.kind; },
    "action without target": (n) => { delete n.action.href; },
    "action with both targets": (n) => { n.action.apiCall = { method: "POST", path: "/api/x" }; },
    "action without label": (n) => { delete n.action.label; },
    "apiCall outside /api/": (n) => { delete n.action.href; n.action.apiCall = { method: "POST", path: "/billing" }; },
    "apiCall escaping /api/": (n) => { delete n.action.href; n.action.apiCall = { method: "POST", path: "/api/../billing" }; },
    "apiCall encoded escape": (n) => { delete n.action.href; n.action.apiCall = { method: "POST", path: "/api/%2e%2e/billing" }; },
    "apiCall cross-origin": (n) => { delete n.action.href; n.action.apiCall = { method: "POST", path: "https://evil.example/api/x" }; },
    "apiCall bad method": (n) => { delete n.action.href; n.action.apiCall = { method: "TRACE", path: "/api/x" }; },
  };
  for (const [label, mutate] of Object.entries(variants)) {
    const payload = validNotification();
    mutate(payload);
    assert.equal(bus.publish("notification", payload), null, label);
    assert.notEqual(validateEvent("notification", payload), "", label);
  }

  const apiCall = validNotification();
  delete apiCall.action.href;
  apiCall.action.apiCall = { method: "post", path: "/api/platform/restore-models", body: { mode: "add" } };
  assert.ok(bus.publish("notification", apiCall));
  const noAction = validNotification();
  delete noAction.action;
  delete noAction.body;
  assert.ok(bus.publish("notification", noAction));
});

test("publish never throws, whatever it is handed", (t) => {
  const { bus } = makeBus(t);
  const circular = { reason: "x" };
  circular.self = circular;
  const hostile = { reason: "x" };
  Object.defineProperty(hostile, "boom", { enumerable: true, get() { throw new Error("getter"); } });
  const cases = [
    () => bus.publish("status", circular),
    () => bus.publish("status", { reason: "x", big: 10n }),
    () => bus.publish("status", hostile),
    () => bus.publish("status", { reason: "x", toJSON: () => "a string" }),
    () => bus.publish(undefined, undefined),
    () => bus.publish(Symbol("x"), {}),
    () => bus.publish("status", { reason: "x" }, "not options"),
    () => bus.publish({ toString() { throw new Error("nope"); } }, {}),
  ];
  for (const run of cases) {
    let result;
    assert.doesNotThrow(() => { result = run(); });
    assert.ok(result === null || typeof result === "object");
  }
  assert.equal(bus.publish("status", circular), null);
});

test("validation runs on the serialised copy, so a toJSON() cannot slip an unchecked payload through", (t) => {
  const { bus } = makeBus(t);
  assert.equal(bus.publish("status", { reason: "x", toJSON: () => ({}) }), null, "a toJSON() that drops the reason");
  const swapped = validNotification();
  swapped.action.toJSON = () => ({ label: { zh: "查看", en: "Open" }, href: "https://evil.example/x" });
  assert.equal(validateEvent("notification", swapped), "", "the object itself passes");
  assert.equal(bus.publish("notification", swapped), null, "what would be sent is cross-origin");
  const untitled = validNotification();
  untitled.title = { zh: "标题", en: "Title", toJSON: () => ({ zh: "标题" }) };
  assert.equal(bus.publish("notification", untitled), null, "title.en is dropped by toJSON()");
  assert.equal(bus.stats().rejected.notification, 2);
  const rebuilt = bus.publish("status", { toJSON: () => ({ reason: "from-toJSON" }) });
  assert.deepEqual(rebuilt?.data, { reason: "from-toJSON" }, "a toJSON() whose output passes is published as sent");
});

test("a broken injected clock falls back to the system clock and costs no seq", (t) => {
  for (const now of [() => { throw new Error("clock"); }, () => Number.NaN, () => 1e300]) {
    const { bus } = makeBus(t, { now });
    const first = bus.publish("status", { reason: "tick" });
    assert.ok(first);
    assert.equal(parseEventId(first.id).seq, 1);
    assert.ok(Math.abs(Date.parse(first.at) - Date.now()) < 60_000);
    assert.equal(parseEventId(bus.publish("status", { reason: "tock" }).id).seq, 2);
  }
});

test("ids are <bootId>-<seq>, monotonic per process start", (t) => {
  const { bus } = makeBus(t);
  assert.match(bus.bootId, /^[0-9a-z]{6}$/);
  const ids = [1, 2, 3].map(() => bus.publish("status", { reason: "tick" }).id);
  assert.deepEqual(ids.map((id) => parseEventId(id)), [
    { bootId: bus.bootId, seq: 1 },
    { bootId: bus.bootId, seq: 2 },
    { bootId: bus.bootId, seq: 3 },
  ]);
  assert.equal(bus.publish("status", {}), null);
  assert.equal(parseEventId(bus.publish("status", { reason: "tick" }).id).seq, 4, "a rejected event takes no seq");
  const other = createEventBus({ logger: silentLogger() });
  t.after(() => other.close());
  assert.notEqual(other.bootId, bus.bootId);
  const envelope = bus.publish("jobs", { managerId: "vllm", jobs: [] }, { source: "vllm" });
  assert.deepEqual(Object.keys(envelope), ["id", "type", "at", "source", "data"]);
  assert.match(envelope.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test("the ring keeps the newest events within its count and byte limits", (t) => {
  const { bus } = makeBus(t, { ringSize: 5 });
  for (let index = 1; index <= 12; index += 1) bus.publish("status", { reason: `r${index}` });
  let stats = bus.stats();
  assert.equal(stats.ring.count, 5);
  assert.equal(parseEventId(stats.ring.oldestId).seq, 8);
  assert.deepEqual(bus.recent({}).events.map((item) => item.data.reason), ["r8", "r9", "r10", "r11", "r12"]);

  const { bus: small } = makeBus(t, { ringBytes: 4096, storeCapBytes: 4096 });
  for (let index = 0; index < 40; index += 1) small.publish("library", { pad: "x".repeat(300), index });
  stats = small.stats();
  assert.ok(stats.ring.bytes <= 4096, `ring holds ${stats.ring.bytes} bytes`);
  assert.ok(stats.ring.count < 40 && stats.ring.count >= 8);
  assert.equal(small.recent({ limit: 500 }).events.at(-1).data.index, 39);
});

test("an oversize event is delivered live in full but stored truncated", async (t) => {
  const { bus, auth } = makeBus(t, { storeCapBytes: 1024 });
  const port = await serve(t, bus, auth);
  const stream = await openStream(port, "/api/events");
  const big = bus.publish("library", { blob: "y".repeat(5000) });
  await stream.waitFor((s) => s.events.length === 1);
  assert.equal(stream.events[0].data.data.blob.length, 5000);
  const stored = bus.recent({}).events.at(-1);
  assert.equal(stored.id, big.id);
  assert.deepEqual(stored.data, { truncated: true });
  assert.equal(bus.stats().truncated, 1);
  stream.close();

  const replay = await openStream(port, "/api/events", { "last-event-id": `${bus.bootId}-0` });
  await replay.waitFor((s) => s.events.length === 1);
  assert.deepEqual(replay.events[0].data.data, { truncated: true });
  replay.close();
});

test("/api/events writes id lines and replays gap-free after Last-Event-ID (header and query)", async (t) => {
  const { bus, auth } = makeBus(t);
  const port = await serve(t, bus, auth);
  const live = await openStream(port, "/api/events");
  assert.equal(live.status, 200);
  assert.equal(live.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(live.headers["cache-control"], "no-store");
  assert.equal(live.headers["x-accel-buffering"], "no");

  const published = [];
  published.push(bus.publish("status", { reason: "a" }));
  published.push(bus.publish("jobs", { managerId: "vllm", jobs: [{ id: "j1" }], removed: [] }, { source: "vllm" }));
  published.push(bus.publish("status", { reason: "b" }));
  await live.waitFor((s) => s.events.length === 3);
  assert.equal(live.frames[0].retry, 3000);
  for (const [index, frame] of live.events.entries()) {
    assert.equal(frame.id, published[index].id, "the id: line is the envelope id");
    assert.equal(frame.event, published[index].type);
    assert.deepEqual(frame.data, published[index]);
  }
  live.close();

  // Missed while disconnected.
  const missed = [
    bus.publish("status", { reason: "c" }),
    bus.publish("jobs", { managerId: "llama", jobs: [], removed: ["j1"] }, { source: "llama" }),
    bus.publish("status", { reason: "d" }),
  ];
  const lastSeen = published[2].id;
  const viaHeader = await openStream(port, "/api/events", { "last-event-id": lastSeen });
  await viaHeader.waitFor((s) => s.events.length === 3);
  assert.deepEqual(viaHeader.events.map((frame) => frame.id), missed.map((item) => item.id));
  assert.equal(viaHeader.events.some((frame) => frame.event === "resync"), false);
  const next = bus.publish("status", { reason: "live" });
  await viaHeader.waitFor((s) => s.events.length === 4);
  assert.equal(viaHeader.events[3].id, next.id, "replay hands over to live with no gap or duplicate");
  viaHeader.close();

  const viaQuery = await openStream(port, `/api/events?lastEventId=${encodeURIComponent(lastSeen)}&types=status`);
  await viaQuery.waitFor((s) => s.events.length === 3);
  assert.deepEqual(viaQuery.events.map((frame) => frame.data.data.reason), ["c", "d", "live"], "type-filtered replay");
  viaQuery.close();

  // EventSource keeps the original URL on auto-reconnect and sends the newer
  // position as the header, so the header wins over the query.
  const both = await openStream(port, `/api/events?lastEventId=${encodeURIComponent(published[0].id)}`, { "last-event-id": next.id });
  const after = bus.publish("status", { reason: "after" });
  await both.waitFor((s) => s.events.length === 1);
  assert.equal(both.events[0].id, after.id);
  both.close();
});

test("a foreign or evicted Last-Event-ID starts the stream with resync", async (t) => {
  const { bus, auth } = makeBus(t, { ringSize: 3 });
  const port = await serve(t, bus, auth);
  for (let index = 0; index < 6; index += 1) bus.publish("status", { reason: `r${index}` });

  const foreign = await openStream(port, "/api/events", { "last-event-id": "zzzzzz-3" });
  await foreign.waitFor((s) => s.events.length === 1);
  assert.equal(foreign.events[0].event, "resync");
  assert.deepEqual(foreign.events[0].data.data, { reason: "restart" });
  assert.equal(foreign.events[0].id, `${bus.bootId}-6`, "resync moves the client to the current position");
  foreign.close();

  const evicted = await openStream(port, "/api/events", { "last-event-id": `${bus.bootId}-1` });
  await evicted.waitFor((s) => s.events.length === 1);
  assert.deepEqual(evicted.events[0].data.data, { reason: "gap" });
  evicted.close();

  // The oldest kept event is seq 4, so a client that saw seq 3 is still whole.
  const edge = await openStream(port, "/api/events", { "last-event-id": `${bus.bootId}-3` });
  await edge.waitFor((s) => s.events.length === 3);
  assert.deepEqual(edge.events.map((frame) => frame.data.data.reason), ["r3", "r4", "r5"]);
  edge.close();

  for (const id of [`${bus.bootId}-99`, "garbage"]) {
    const odd = await openStream(port, "/api/events", { "last-event-id": id });
    await odd.waitFor((s) => s.events.length === 1);
    assert.equal(odd.events[0].event, "resync", id);
    odd.close();
  }
});

test("/api/events/recent pages with and without since and reports gaps", async (t) => {
  const { bus, auth } = makeBus(t, { ringSize: 10 });
  const port = await serve(t, bus, auth);
  const ids = [];
  for (let index = 0; index < 8; index += 1) {
    ids.push(bus.publish(index % 2 ? "jobs" : "status", index % 2
      ? { managerId: "vllm", jobs: [{ id: `j${index}` }], removed: [] }
      : { reason: `r${index}` }, index % 2 ? { source: "vllm" } : {}).id);
  }

  let { status, body } = await getJson(port, "/api/events/recent");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.bootId, bus.bootId);
  assert.equal(body.events.length, 8);
  assert.equal(body.lastId, ids[7]);
  assert.equal(body.gap, false);

  ({ body } = await getJson(port, "/api/events/recent?limit=3"));
  assert.deepEqual(body.events.map((item) => item.id), ids.slice(5));

  ({ body } = await getJson(port, `/api/events/recent?since=${ids[2]}&types=status`));
  assert.deepEqual(body.events.map((item) => item.data.reason), ["r4", "r6"]);
  assert.equal(body.lastId, ids[7]);

  ({ body } = await getJson(port, `/api/events/recent?since=${ids[0]}&limit=2`));
  assert.deepEqual(body.events.map((item) => item.id), ids.slice(1, 3), "paging forward starts at the oldest");
  assert.equal(body.lastId, ids[2]);

  ({ body } = await getJson(port, `/api/events/recent?since=${ids[7]}`));
  assert.deepEqual(body.events, []);
  assert.equal(body.gap, false);

  ({ body } = await getJson(port, "/api/events/recent?since=zzzzzz-1"));
  assert.equal(body.gap, true);
  for (let index = 0; index < 12; index += 1) bus.publish("status", { reason: "flood" });
  ({ body } = await getJson(port, `/api/events/recent?since=${ids[1]}`));
  assert.equal(body.gap, true, "older than the ring");

  ({ body } = await getJson(port, "/api/events/recent?limit=100000"));
  assert.ok(body.events.length <= 500);
});

test("viewers receive only status and instances, redacted, on SSE and /recent", async (t) => {
  const { bus, auth } = makeBus(t);
  const port = await serve(t, bus, auth);
  const viewer = await openStream(port, "/api/events", { "x-test-viewer": "1" });
  const owner = await openStream(port, "/api/events");

  bus.publish("status", { reason: "manager_down", managerId: "vllm", ok: false, offline: ["vllm"], detail: "C:\\secret\\path" });
  bus.publish("jobs", { managerId: "vllm", jobs: [{ id: "j1" }], removed: [] }, { source: "vllm" });
  bus.publish("instances", {
    managerId: "vllm",
    changed: ["primary"],
    removed: [],
    native: true,
    instances: [{ id: "primary", lifecycle: { state: "ready" }, port: 30000, pid: 987654, model: "/models/x" }],
  }, { source: "vllm" });
  bus.publish("notification", validNotification());
  bus.publish("telemetry.live", { rps: 1 });

  await owner.waitFor((s) => s.events.length === 5);
  await viewer.waitFor((s) => s.events.length === 2);
  bus.publish("status", { reason: "sentinel" });
  await viewer.waitFor((s) => s.events.length === 3);
  assert.deepEqual(viewer.events.map((frame) => frame.event), ["status", "instances", "status"]);
  assert.deepEqual(viewer.events[0].data.data, { reason: "manager_down", managerId: "vllm", ok: false, offline: ["vllm"] });
  assert.deepEqual(viewer.events[1].data.data, {
    managerId: "vllm",
    changed: ["primary"],
    removed: [],
    native: true,
    instances: [{ id: "primary", state: "ready" }],
  });
  assert.equal(viewer.raw.includes("secret"), false);
  assert.equal(owner.events[0].data.data.detail, "C:\\secret\\path", "owners are not redacted");

  // A viewer asking for more than it may have gets only its own types.
  const greedy = await openStream(port, "/api/events?types=jobs,notification,instances", { "x-test-viewer": "1" });
  bus.publish("jobs", { managerId: "vllm", jobs: [], removed: [] }, { source: "vllm" });
  bus.publish("instances", { managerId: "vllm", changed: [], removed: ["primary"] }, { source: "vllm" });
  await greedy.waitFor((s) => s.events.length === 1);
  assert.equal(greedy.events[0].event, "instances");

  // Replay to a viewer is filtered and redacted the same way.
  const replay = await openStream(port, "/api/events", { "x-test-viewer": "1", "last-event-id": `${bus.bootId}-0` });
  await replay.waitFor((s) => s.events.length === 4);
  assert.deepEqual(replay.events.map((frame) => frame.event), ["status", "instances", "status", "instances"]);
  assert.equal(replay.raw.includes("secret"), false);

  const { body } = await getJson(port, "/api/events/recent", { "x-test-viewer": "1" });
  assert.deepEqual([...new Set(body.events.map((item) => item.type))].sort(), ["instances", "status"]);
  assert.equal(JSON.stringify(body).includes("secret"), false);
  assert.equal(JSON.stringify(body).includes("987654"), false);
  const ownerRecent = await getJson(port, "/api/events/recent");
  assert.equal(ownerRecent.body.events.length, 8);
  for (const stream of [viewer, owner, greedy, replay]) stream.close();
});

test("a viewer redaction JSON cannot carry drops only that viewer's frame and leaves no hole in the ring", (t) => {
  const logger = silentLogger();
  const auth = createRequestAuth({ security: fakeSecurity, logger });
  // Later packages register their own redactors; these hand back a cycle and a BigInt.
  auth.viewerRegistry.registerEventType({ owner: "03", type: "library", redact: (data) => { const out = { ...data }; out.self = out; return out; } });
  auth.viewerRegistry.registerEventType({ owner: "03", type: "downloads", redact: () => ({ bytes: 10n }) });
  const { bus } = makeBus(t, { auth, logger });
  // The viewer connects first, so its failure would come before the owner's delivery.
  const viewer = fakeExchange("127.0.0.2");
  assert.ok(bus.handleSse(viewer.req, viewer.res, { role: "viewer" }));
  const owner = fakeExchange("127.0.0.1");
  assert.ok(bus.handleSse(owner.req, owner.res, { role: "owner" }));
  const ids = [
    bus.publish("status", { reason: "s1" }),
    bus.publish("library", { x: 1 }),
    bus.publish("downloads", { kind: "progress", jobs: [] }),
    bus.publish("status", { reason: "s4" }),
    bus.publish("library", { x: 2 }),
    bus.publish("status", { reason: "s6" }),
  ].map((envelope) => envelope?.id);
  assert.deepEqual(ids.map((id) => parseEventId(id)?.seq), [1, 2, 3, 4, 5, 6], "every publish is accepted and numbered");
  assert.deepEqual(bus.stats().rejected, {});
  const idLines = (exchange) => exchange.res.chunks.filter((chunk) => chunk.startsWith("id: ")).map((chunk) => chunk.split("\n")[0].slice(4));
  assert.deepEqual(idLines(owner), ids, "the owner after the viewer receives every event live");
  assert.deepEqual(idLines(viewer), [ids[0], ids[3], ids[5]]);
  assert.equal(viewer.res.destroyed, false);
  assert.deepEqual(bus.recent({}).events.map((item) => item.id), ids, "the ring has no hole");
  assert.equal(logger.lines.filter((line) => line.includes("viewer copy of a library event")).length, 1, "logged once per type");

  // Replay after the failed events is gap-free, for owners and for viewers.
  const replay = fakeExchange("127.0.0.3");
  assert.ok(bus.handleSse(replay.req, replay.res, { role: "owner", lastEventId: ids[2] }));
  assert.deepEqual(idLines(replay), ids.slice(3));
  assert.equal(replay.res.chunks.some((chunk) => chunk.includes("event: resync")), false);
  assert.deepEqual(bus.recent({ since: ids[1] }).events.map((item) => item.id), ids.slice(2));
  const viewerReplay = fakeExchange("127.0.0.4");
  assert.ok(bus.handleSse(viewerReplay.req, viewerReplay.res, { role: "viewer", lastEventId: `${bus.bootId}-0` }));
  assert.equal(viewerReplay.res.status, 200);
  assert.equal(viewerReplay.res.destroyed, false);
  assert.deepEqual(idLines(viewerReplay), [ids[0], ids[3], ids[5]]);
  assert.deepEqual(bus.recent({ role: "viewer" }).events.map((item) => item.id), [ids[0], ids[3], ids[5]]);
});

test("envelopes are frozen, so neither the publisher nor a subscriber can change what the others see", async (t) => {
  const { bus, auth, logger } = makeBus(t);
  const port = await serve(t, bus, auth);
  const refused = [];
  bus.subscribe((envelope) => {
    try {
      envelope.data.jobs.length = 0;
    } catch (error) {
      refused.push(error.name);
    }
    envelope.data.injected = "by-subscriber";
  });
  const seen = [];
  bus.subscribe((envelope) => seen.push(envelope));
  const original = { managerId: "vllm", jobs: [{ id: "j1" }], removed: [] };
  const returned = bus.publish("jobs", structuredClone(original), { source: "vllm" });
  assert.ok(returned);
  assert.deepEqual(refused, ["TypeError"]);
  assert.ok(logger.lines.some((line) => line.includes("subscriber threw")), "the throwing subscriber is contained");
  assert.equal(seen[0], returned, "one shared envelope");
  assert.throws(() => { returned.data.managerId = "mutated-by-publisher"; }, TypeError);
  assert.throws(() => { returned.data.jobs[0].id = "j2"; }, TypeError);
  assert.throws(() => { delete returned.data.removed; }, TypeError);
  assert.throws(() => { returned.id = "x"; }, TypeError);

  const recent = bus.recent({}).events[0];
  assert.deepEqual(recent.data, original);
  const replay = await openStream(port, "/api/events", { "last-event-id": `${bus.bootId}-0` });
  await replay.waitFor((s) => s.events.length === 1);
  assert.deepEqual(replay.events[0].data, recent, "SSE replay and /recent agree");
  const polled = await getJson(port, "/api/events/recent");
  assert.deepEqual(polled.body.events[0], recent);
  replay.close();

  bus.publish("status", { reason: "frozen-for-viewers", managerId: "vllm" });
  const viewerCopy = bus.recent({ role: "viewer" }).events[0];
  assert.equal(Object.isFrozen(viewerCopy), true);
  assert.equal(Object.isFrozen(viewerCopy.data), true);
});

test("a principal with role none gets 401 on both routes", async (t) => {
  const stubAuth = createRequestAuth({
    security: fakeSecurity,
    logger: silentLogger(),
    adminAuth: {
      authenticate: () => ({ role: "none", principal: "", via: "none", redact: true }),
      checkManagementAccess: () => ({ ok: false, status: 401, code: "admin_session_required", message: "pair" }),
      eventTypesFor: () => new Set(),
    },
  });
  const { bus } = makeBus(t, { auth: stubAuth });
  const port = await serve(t, bus, stubAuth);
  const sse = await fetch(`http://127.0.0.1:${port}/api/events`);
  assert.equal(sse.status, 401);
  assert.equal((await sse.json()).error.code, "admin_session_required");
  const recent = await getJson(port, "/api/events/recent");
  assert.equal(recent.status, 401);
  assert.equal(recent.body.ok, false);
});

test("a heartbeat comment arrives on idle streams", async (t) => {
  const { bus, auth } = makeBus(t, { heartbeatMs: 25 });
  const port = await serve(t, bus, auth);
  const stream = await openStream(port, "/api/events");
  await stream.waitFor((s) => s.frames.some((frame) => frame.comments.some((comment) => /^ping \d+$/.test(comment))));
  stream.close();
});

test("a client whose buffer passes the limit is dropped and the others keep receiving", (t) => {
  const { bus } = makeBus(t, { maxBufferedBytes: 4096 });
  const slow = fakeExchange("127.0.0.1");
  const fast = fakeExchange("127.0.0.2");
  assert.ok(bus.handleSse(slow.req, slow.res, { role: "owner" }));
  assert.ok(bus.handleSse(fast.req, fast.res, { role: "owner" }));
  assert.equal(bus.stats().clients, 2);
  slow.res.writableLength = 10_000;
  bus.publish("status", { reason: "one" });
  assert.equal(slow.res.destroyed, true);
  assert.equal(bus.stats().clients, 1);
  assert.equal(bus.stats().dropped.slow, 1);
  bus.publish("status", { reason: "two" });
  assert.equal(fast.res.chunks.filter((chunk) => chunk.startsWith("id: ")).length, 2);
  assert.equal(slow.res.chunks.filter((chunk) => chunk.startsWith("id: ")).length, 1);
});

test("a reader that stops reading over a real socket is dropped once the response buffer passes the limit", async (t) => {
  const { bus, auth } = makeBus(t, { maxBufferedBytes: 64 * 1024 });
  const port = await serve(t, bus, auth);
  const healthy = await openStream(port, "/api/events?types=status");
  const stalled = await new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/api/events?types=library" }, (res) => {
      res.pause();
      resolve(request);
    });
    request.on("error", reject);
  });
  t.after(() => stalled.destroy());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bus.stats().clients, 2);
  // The kernel socket buffers fill first; after that the server-side
  // http.ServerResponse.writableLength grows until the bus drops the stream.
  const pad = "x".repeat(32 * 1024);
  const deadline = Date.now() + 10_000;
  let sent = 0;
  while (bus.stats().dropped.slow === 0 && Date.now() < deadline) {
    for (let index = 0; index < 16; index += 1) bus.publish("library", { pad, index });
    sent += 16 * pad.length;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(bus.stats().dropped.slow, 1, `still connected after ${sent} bytes`);
  assert.equal(bus.stats().clients, 1);
  bus.publish("status", { reason: "still-here" });
  await healthy.waitFor((s) => s.events.some((frame) => frame.data.data.reason === "still-here"));
  healthy.close();
});

test("a long replay may exceed the live limit until the socket drains once", (t) => {
  const { bus } = makeBus(t, { maxBufferedBytes: 2048 });
  for (let index = 0; index < 50; index += 1) bus.publish("library", { pad: "z".repeat(100), index });
  const exchange = fakeExchange();
  const realWrite = exchange.res.write;
  exchange.res.write = (chunk) => {
    exchange.res.writableLength += Buffer.byteLength(String(chunk));
    return realWrite(chunk);
  };
  assert.ok(bus.handleSse(exchange.req, exchange.res, { role: "owner", lastEventId: `${bus.bootId}-0` }));
  assert.ok(exchange.res.writableLength > 2048);
  bus.publish("status", { reason: "live" });
  assert.equal(exchange.res.destroyed, false, "the replay backlog is not held against the client");
  exchange.res.writableLength = 0;
  exchange.res.emit("drain");
  exchange.res.writableLength = 3000;
  bus.publish("status", { reason: "late" });
  assert.equal(exchange.res.destroyed, true, "after a drain the normal limit applies");
});

test("stream caps answer 503 too_many_streams, in total and per address", async (t) => {
  const { bus } = makeBus(t, { maxClients: 3, maxClientsPerIp: 2 });
  const open = (ip) => {
    const exchange = fakeExchange(ip);
    bus.handleSse(exchange.req, exchange.res, { role: "owner" });
    return exchange;
  };
  const first = open("10.0.0.1");
  assert.equal(first.res.status, 200);
  assert.equal(open("10.0.0.1").res.status, 200);
  const third = open("10.0.0.1");
  assert.equal(third.res.status, 503);
  assert.equal(JSON.parse(third.res.chunks.join("")).error.code, "too_many_streams");
  assert.equal(open("10.0.0.2").res.status, 200);
  assert.equal(open("10.0.0.3").res.status, 503, "the total cap");
  assert.equal(bus.stats().refused.capacity, 2);
  first.req.emit("close");
  assert.equal(open("10.0.0.3").res.status, 200, "a closed stream frees its slot");

  // Over HTTP the refusal is a JSON error envelope.
  const { bus: tiny, auth } = makeBus(t, { maxClients: 1 });
  const port = await serve(t, tiny, auth);
  const holder = await openStream(port, "/api/events");
  const refused = await fetch(`http://127.0.0.1:${port}/api/events`);
  assert.equal(refused.status, 503);
  const body = await refused.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "too_many_streams");
  holder.close();
});

test("subscriberCount counts only the clients and subscribers that would receive the types", (t) => {
  const { bus } = makeBus(t);
  assert.equal(bus.subscriberCount({ types: ["telemetry.live"] }), 0);
  const owner = fakeExchange("127.0.0.1");
  bus.handleSse(owner.req, owner.res, { role: "owner", types: "status,alerts", client: "console" });
  const viewer = fakeExchange("127.0.0.2");
  bus.handleSse(viewer.req, viewer.res, { role: "viewer" });
  const supervisor = fakeExchange("127.0.0.3");
  bus.handleSse(supervisor.req, supervisor.res, {
    principal: { role: "owner", principal: "system:supervisor", via: "hmac", redact: false },
    types: ["notification", "platform"],
    client: "supervisor",
  });
  const off = bus.subscribe(() => {}, { types: ["jobs", "instances"] });

  assert.equal(bus.subscriberCount({ types: ["telemetry.live"] }), 0);
  assert.equal(bus.subscriberCount({ types: ["status"] }), 2, "owner stream + viewer stream");
  assert.equal(bus.subscriberCount({ types: ["instances"] }), 2, "viewer stream + in-process subscriber");
  assert.equal(bus.subscriberCount({ types: ["notification"] }), 1);
  assert.equal(bus.subscriberCount({ types: ["jobs"] }), 1);
  assert.equal(bus.subscriberCount({}), 4);
  assert.equal(bus.subscriberCount({ client: "supervisor" }), 1);
  assert.equal(bus.subscriberCount({ principal: "system:supervisor", types: ["notification"] }), 1);
  assert.equal(bus.subscriberCount({ principal: "system:supervisor", types: ["status"] }), 0);
  off();
  assert.equal(bus.subscriberCount({ types: ["jobs"] }), 0);
  viewer.res.emit("close");
  assert.equal(bus.subscriberCount({ types: ["instances"] }), 0);
});

test("in-process subscribers get typed envelopes in seq order, and a throwing one is contained", (t) => {
  const { bus, logger } = makeBus(t);
  const seen = [];
  bus.subscribe(() => { throw new Error("collector bug"); });
  bus.subscribe((envelope) => {
    seen.push(envelope.id);
    // Publishing from inside a subscriber must not reorder anything.
    if (envelope.data.reason === "outer") bus.publish("status", { reason: "inner" });
  }, { types: ["status"] });
  const jobsOnly = [];
  const off = bus.subscribe((envelope) => jobsOnly.push(envelope.type), { types: "jobs" });
  const outer = bus.publish("status", { reason: "outer" });
  assert.ok(outer);
  bus.publish("jobs", { managerId: "vllm", jobs: [] }, { source: "vllm" });
  assert.deepEqual(seen, [`${bus.bootId}-1`, `${bus.bootId}-2`]);
  assert.deepEqual(bus.recent({}).events.map((item) => item.id), [`${bus.bootId}-1`, `${bus.bootId}-2`, `${bus.bootId}-3`]);
  assert.deepEqual(jobsOnly, ["jobs"]);
  off();
  bus.publish("jobs", { managerId: "vllm", jobs: [] }, { source: "vllm" });
  assert.deepEqual(jobsOnly, ["jobs"]);
  assert.ok(logger.lines.some((line) => line.includes("subscriber threw")));
  assert.throws(() => bus.subscribe("not a function"), TypeError);

  // A publisher mutating its object afterwards cannot change what was sent.
  const payload = { reason: "before" };
  const envelope = bus.publish("status", payload);
  payload.reason = "after";
  assert.equal(envelope.data.reason, "before");
  assert.equal(bus.recent({ types: ["status"] }).events.at(-1).data.reason, "before");
});

test("close() ends every stream and stops publishing", async (t) => {
  const { bus, auth } = makeBus(t);
  const port = await serve(t, bus, auth);
  const one = await openStream(port, "/api/events");
  const two = await openStream(port, "/api/events?types=status");
  assert.equal(bus.stats().clients, 2);
  bus.close();
  await one.waitFor((s) => s.ended);
  await two.waitFor((s) => s.ended);
  assert.equal(bus.stats().clients, 0);
  assert.equal(bus.publish("status", { reason: "late" }), null);
  const after = await fetch(`http://127.0.0.1:${port}/api/events`);
  assert.equal(after.status, 503);
});

test("the module claims only its two GET routes", async (t) => {
  const { bus, auth } = makeBus(t);
  const mounted = events.mount({ bus, auth });
  const fake = (method, pathname) => [{ method, headers: {}, socket: { remoteAddress: "127.0.0.1" } }, {}, new URL(pathname, "http://127.0.0.1")];
  for (const [method, pathname] of [["GET", "/gateway/x"], ["GET", "/api/status"], ["POST", "/api/events"], ["GET", "/api/events/other"]]) {
    assert.equal(await mounted.handle(...fake(method, pathname)), false, `${method} ${pathname}`);
  }
  assert.equal(auth.viewerRegistry.match("GET", "/api/events").access, "viewer");
  assert.equal(auth.viewerRegistry.match("GET", "/api/events/recent").access, "viewer");
  assert.throws(() => events.mount({ auth }), /ctx\.bus/);
  assert.throws(() => events.mount({ bus }), /ctx\.auth/);
});
