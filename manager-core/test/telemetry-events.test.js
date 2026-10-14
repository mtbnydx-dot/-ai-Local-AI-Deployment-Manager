"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { DatabaseSync } = require("node:sqlite");
const {
  STATE_NAME,
  SUBSCRIBED_TYPES,
  changedKeys,
  createDockerEventSource,
  createEventCollector,
  dockerEventFromLine,
  dockerEventSourceFromEnv,
  launchEventsFromJob,
  modelLabel,
} = require("../telemetry/collectors/events");
const { openTelemetryStore } = require("../telemetry/store");
const jobsFixture = require("./fixtures/telemetry/events/jobs-relay.json");
const dockerFixture = require("./fixtures/telemetry/events/docker-events.json");
const exitFixture = require("./fixtures/telemetry/events/process-exit.json");
const mcpFixture = require("./fixtures/telemetry/events/mcp-audit.json");

// EventCollector (04 §9). Every source is a fake: the ENT-EV bus and its
// manager relay, the docker CLI, the manager client and the log files (in a
// temp directory). Nothing here starts a process or reaches a service.

// Built at run time so no key-shaped text sits in a tracked file.
const FIXTURE_KEY = ["sk", "fixture0events0key0do0not0store"].join("-");
const NOW = Date.UTC(2026, 9, 14, 10, 0, 0);
const T0_SECONDS = Date.UTC(2026, 9, 14, 8, 0, 0) / 1000;

function withKey(value) {
  return JSON.parse(JSON.stringify(value).split("__FIXTURE_KEY__").join(FIXTURE_KEY));
}

// The store closes before its directory goes (Windows keeps open files).
async function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-events-"));
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, inProcess: true, logger: null });
  t.after(async () => {
    await store.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { store, file, dir };
}

// A second, read-only connection; WAL lets it read while the store is open.
function readEvents(file, where = "1 = 1") {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY at, id`).all().map((row) => ({
      ...row,
      data: row.data ? JSON.parse(row.data) : null,
    }));
  } finally {
    db.close();
  }
}

function dumpEvents(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return JSON.stringify(db.prepare("SELECT * FROM events").all());
  } finally {
    db.close();
  }
}

// What ENT-EV hands an in-process subscriber. `relay` stands in for the
// manager relay (ENT-EV3): it delivers `jobs` and `instances` envelopes the
// way the bus does, deep-frozen and with `<bootId>-<seq>` ids.
function fakeBus() {
  const subscribers = new Set();
  const subscribeCalls = [];
  let seq = 0;
  function deepFreeze(value) {
    if (value && typeof value === "object") {
      Object.freeze(value);
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
  }
  const bus = {
    subscribeCalls,
    published: [],
    subscribe(fn, options) {
      subscribeCalls.push(options);
      const entry = { fn, types: new Set(options?.types || []) };
      subscribers.add(entry);
      return () => subscribers.delete(entry);
    },
    publish(type, data) {
      bus.published.push({ type, data });
      return null;
    },
    subscriberCount: () => subscribers.size,
    deliver(type, data, { source = "entry", at = NOW } = {}) {
      seq += 1;
      const envelope = deepFreeze({ id: `fx0001-${seq}`, type, at: new Date(at).toISOString(), source, data: JSON.parse(JSON.stringify(data)) });
      for (const entry of [...subscribers]) if (entry.types.has(type)) entry.fn(envelope);
    },
  };
  bus.relay = {
    jobs: (payload) => bus.deliver("jobs", payload, { source: payload.managerId }),
    instances: (managerId, changed = [], removed = []) => bus.deliver("instances", { managerId, changed, removed, native: false }, { source: managerId }),
  };
  return bus;
}

// Timers that only fire when the test says so.
function manualTimers() {
  const all = [];
  return {
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false, fired: false, unref() { return timer; } };
      all.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    pending: () => all.filter((timer) => !timer.cleared && !timer.fired),
    async fire(timer) {
      timer.fired = true;
      await timer.fn();
    },
  };
}

function waitFor(predicate, timeoutMs = 3000, label = "condition") {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      let value;
      try {
        value = await predicate();
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

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.stdout.end();
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");
    return true;
  };
  return child;
}

// Records every row offered to the store, so a test can tell what a
// collector read from what the database already held.
function spyInserts(store) {
  const offered = [];
  return {
    offered,
    store: new Proxy(store, {
      get(target, property) {
        if (property === "insertEvents") {
          return (rows) => {
            offered.push(...rows);
            return target.insertEvents(rows);
          };
        }
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

function types(rows) {
  return rows.map((row) => row.type);
}

// --- jobs ------------------------------------------------------------------

test("relayed serve jobs give launch.started, one phase per stage and launch.ready with durations", async (t) => {
  const { store, file } = await tempStore(t);
  const bus = fakeBus();
  const collector = createEventCollector({ store, events: bus, now: () => NOW, logger: null });
  collector.start();
  t.after(() => collector.stop());
  assert.deepEqual(bus.subscribeCalls, [{ types: [...SUBSCRIBED_TYPES] }], "one subscription through events.subscribe");
  assert.deepEqual([...SUBSCRIBED_TYPES], ["jobs", "instances", "status", "downloads", "security", "access", "platform"]);

  for (const payload of jobsFixture.ready) bus.relay.jobs(payload);
  await collector.flush();
  const rows = readEvents(file);
  assert.deepEqual(types(rows), ["launch.started", "launch.phase", "launch.phase", "launch.phase", "launch.ready"]);
  for (const row of rows) {
    assert.equal(row.manager_id, "vllm");
    assert.equal(row.source, "vllm");
    assert.equal(row.fleet_id, "vllm:primary", "a replace-mode launch serves the primary instance");
    assert.equal(row.severity, "info");
    assert.ok(row.dedupe_key.startsWith("job:vllm:mfx01-serve:"));
    assert.equal(row.data.i18nKey, `obs.event.${row.type}`);
  }
  const [started, pull, weights, probe, ready] = rows;
  assert.equal(started.at, Date.parse("2026-10-14T08:00:00.000Z"));
  assert.equal(started.title, "Launch started: qwen-test");
  assert.equal(started.dedupe_key, "job:vllm:mfx01-serve:started");
  assert.equal(started.data.model, "qwen-test", "the model path is reduced to its name");
  assert.deepEqual(
    [pull.data.phase, pull.data.prevPhase, pull.data.prevDurationMs],
    ["拉取镜像", null, null],
  );
  assert.deepEqual([weights.data.phase, weights.data.prevPhase, weights.data.prevDurationMs], ["加载权重", "拉取镜像", 9000]);
  assert.deepEqual([probe.data.phase, probe.data.prevPhase, probe.data.prevDurationMs], ["就绪检查", "加载权重", 80000]);
  assert.equal(probe.at, Date.parse("2026-10-14T08:01:30.000Z"));
  assert.equal(ready.dedupe_key, "job:vllm:mfx01-serve:final");
  assert.equal(ready.at, Date.parse("2026-10-14T08:02:00.000Z"));
  assert.equal(ready.data.durationMs, 120000);
  assert.deepEqual(ready.data.phases, [
    { phase: "拉取镜像", durationMs: 9000 },
    { phase: "加载权重", durationMs: 80000 },
    { phase: "就绪检查", durationMs: 30000 },
  ]);
  assert.equal(ready.data.gpuUsedBeforeMb, null);
  assert.equal(ready.data.gpuUsedAfterMb, null);
  assert.deepEqual(bus.published, [], "the collector never publishes");

  // The relay resends, and an entry restart replays: dedupe_key keeps one
  // row per event, in memory and in the database.
  for (const payload of jobsFixture.ready) bus.relay.jobs(payload);
  await collector.flush();
  assert.equal(readEvents(file).length, 5);
  await collector.stop();

  const restarted = createEventCollector({ store, events: bus, now: () => NOW, logger: null });
  restarted.start();
  t.after(() => restarted.stop());
  for (const payload of jobsFixture.ready) bus.relay.jobs(payload);
  await restarted.flush();
  assert.equal(readEvents(file).length, 5, "a restarted collector inserts nothing twice");
  assert.equal(restarted.status().recorded, 0);
  assert.equal(restarted.status().duplicates, 5, "the store dropped the replayed rows by dedupe_key");
});

test("launch.failed carries phase, signature and a redacted message cut to 300 characters", async (t) => {
  const { store, file } = await tempStore(t);
  const bus = fakeBus();
  const collector = createEventCollector({ store, events: bus, now: () => NOW, logger: null });
  collector.start();
  t.after(() => collector.stop());
  const payloads = withKey(jobsFixture.failed);
  assert.ok(JSON.stringify(payloads).includes(FIXTURE_KEY), "the fixture carries the key");
  for (const payload of payloads) bus.relay.jobs(payload);
  await collector.flush();

  const rows = readEvents(file);
  assert.deepEqual(types(rows), ["launch.started", "launch.phase", "launch.phase", "launch.failed"]);
  const failed = rows[3];
  assert.equal(failed.severity, "warning");
  assert.equal(failed.manager_id, "llama");
  assert.equal(failed.fleet_id, "llama:draft-b", "a parallel launch serves its own instance");
  assert.equal(failed.dedupe_key, "job:llama:mfx02-serve:final");
  assert.equal(failed.at, Date.parse("2026-10-14T09:00:40.000Z"));
  assert.equal(failed.data.phase, "加载权重");
  assert.equal(failed.data.errorSignature, null, "a plain-text error has no signature");
  assert.equal(failed.data.durationMs, 40000);
  assert.equal(failed.data.model, "demo-gguf");
  assert.ok(failed.data.message.length <= 300, `message is ${failed.data.message.length} characters`);
  assert.match(failed.data.message, /^Command failed: docker run --name llama-draft-b --api-key <redacted>/);
  assert.ok(!failed.data.message.includes("\n"));
  assert.equal(dumpEvents(file).includes(FIXTURE_KEY), false, "the fixture key is nowhere in the events table");

  // A structured job error (00 §9.11) gives its signature and phase.
  const [structured] = launchEventsFromJob("llama", {
    id: "mfx03",
    type: "serve",
    status: "failed",
    createdAt: "2026-10-14T09:10:00.000Z",
    finishedAt: "2026-10-14T09:10:05.000Z",
    error: { code: "launch_failed", signatureId: "cuda-oom-kv", phase: "kv", message: `Bearer ${FIXTURE_KEY}`, logExcerpt: "" },
    meta: {},
  }, { now: NOW }).filter((row) => row.type === "launch.failed");
  assert.equal(structured.data.errorSignature, "cuda-oom-kv");
  assert.equal(structured.data.phase, "kv");
  assert.equal(structured.data.message, "Bearer <redacted>");
  // An interrupted job (manager restart) is a failure with its own signature.
  const [interrupted] = launchEventsFromJob("vllm", { id: "mfx04", type: "serve", status: "interrupted", createdAt: "2026-10-14T09:20:00.000Z", updatedAt: "2026-10-14T09:21:00.000Z", error: "Manager restarted while this job was running." }, { now: NOW })
    .filter((row) => row.type === "launch.failed");
  assert.equal(interrupted.data.errorSignature, "interrupted");
});

test("job mapping is pure and skips jobs that are not launches", () => {
  const job = jobsFixture.ready[2].jobs[0];
  assert.deepEqual(launchEventsFromJob("vllm", job, { now: NOW }), launchEventsFromJob("vllm", job, { now: NOW + 1 }));
  assert.deepEqual(launchEventsFromJob("vllm", { ...job, type: "benchmark" }), []);
  assert.deepEqual(launchEventsFromJob("", job), []);
  assert.deepEqual(launchEventsFromJob("vllm", { ...job, id: "" }), []);
  const skipped = launchEventsFromJob("vllm", job, { now: NOW, skipStagePhases: true, launchId: "lch_bbbbbbbbbbbbbbbbbbbb" });
  assert.deepEqual(types(skipped), ["launch.started", "launch.ready"]);
  assert.ok(skipped.every((row) => row.launchId === "lch_bbbbbbbbbbbbbbbbbbbb"));
  assert.equal(modelLabel("Qwen/Qwen3-8B"), "Qwen/Qwen3-8B");
  assert.equal(modelLabel("/models/org/name/weights"), "weights");
  assert.equal(modelLabel(["C:", "models", "x.gguf"].join("\\")), "x.gguf");
});

test("instances with a lifecycle give phases with the launch id; their jobs stop giving stage phases", async (t) => {
  const { store, file } = await tempStore(t);
  const bus = fakeBus();
  const reads = [];
  let lifecycle = { state: "loading", phase: "weights", since: "2026-10-14T08:00:05.000Z" };
  const managers = {
    ids: ["vllm"],
    get: async (managerId, target) => {
      reads.push(`${managerId} ${target}`);
      return {
        ok: true,
        status: 200,
        data: { ok: true, instances: [{ id: "primary", engineId: "sglang", launchId: "lch_aaaaaaaaaaaaaaaaaaaa", running: true, model: "qwen-test", lifecycle }] },
      };
    },
  };
  const collector = createEventCollector({ store, events: bus, managers, now: () => NOW, logger: null });
  collector.start();
  t.after(() => collector.stop());

  bus.relay.instances("vllm", ["primary"]);
  await collector.flush();
  lifecycle = { state: "ready", phase: "ready", since: "2026-10-14T08:02:00.000Z" };
  bus.relay.instances("vllm", ["primary"]);
  await collector.flush();
  bus.relay.instances("vllm", ["primary"]);
  await collector.flush();
  assert.deepEqual(reads, ["vllm instances", "vllm instances", "vllm instances"], "each instances event reads /api/instances once");

  bus.relay.jobs(jobsFixture.ready[2]);
  await collector.flush();
  const rows = readEvents(file);
  assert.deepEqual(types(rows), ["launch.started", "launch.phase", "instance.state", "launch.phase", "instance.state", "launch.ready"]);
  const phases = rows.filter((row) => row.type === "launch.phase");
  assert.deepEqual(phases.map((row) => [row.data.phase, row.data.prevPhase, row.data.prevDurationMs, row.launch_id, row.fleet_id]), [
    ["weights", null, null, "lch_aaaaaaaaaaaaaaaaaaaa", "vllm:primary"],
    ["ready", "weights", 115000, "lch_aaaaaaaaaaaaaaaaaaaa", "vllm:primary"],
  ]);
  const states = rows.filter((row) => row.type === "instance.state");
  assert.deepEqual(states.map((row) => [row.data.state, row.data.prevState]), [["loading", null], ["ready", "loading"]]);
  const jobRows = rows.filter((row) => row.dedupe_key.startsWith("job:"));
  assert.deepEqual(types(jobRows), ["launch.started", "launch.ready"], "stage history phases are skipped once instances report phases");
  assert.ok(jobRows.every((row) => row.launch_id === "lch_aaaaaaaaaaaaaaaaaaaa"), "the launch id comes from the instance");
});

// --- docker ------------------------------------------------------------------

function dockerLines() {
  return dockerFixture.events.map((event) => JSON.stringify(event));
}

test("docker events: oom is critical, the die after it is oomKilled, health and start are kept", async (t) => {
  const { store, file } = await tempStore(t);
  const opens = [];
  let child = null;
  const source = {
    command: "docker",
    precheck: async () => ({ ok: true }),
    open: ({ sinceSeconds }) => {
      opens.push(sinceSeconds);
      child = fakeChild();
      return child;
    },
  };
  const collector = createEventCollector({ store, dockerEvents: source, now: () => NOW, logger: null });
  collector.start();
  await waitFor(() => child, 2000, "the docker stream");
  assert.deepEqual(opens, [null], "the first stream starts now, without a replay");
  for (const line of dockerLines()) child.stdout.write(`${line}\n`);
  child.stdout.write("not json\n");
  await waitFor(async () => {
    await collector.flush();
    return readEvents(file).length >= 5;
  }, 3000, "docker rows");
  const rows = readEvents(file);
  assert.deepEqual(types(rows), ["container.start", "container.oom", "container.exit", "container.health", "container.exit"]);
  const [start, oom, die, health, cleanExit] = rows;
  assert.equal(start.fleet_id, "vllm:primary");
  assert.equal(start.manager_id, "vllm");
  assert.equal(start.launch_id, "lch_aaaaaaaaaaaaaaaaaaaa");
  assert.equal(start.source, "docker");
  assert.equal(oom.severity, "critical");
  assert.equal(oom.data.containerId, "a1a1a1a1a1a1");
  assert.equal(die.severity, "warning");
  assert.equal(die.data.exitCode, 137);
  assert.equal(die.data.oomKilled, true);
  assert.equal(health.severity, "warning");
  assert.equal(health.data.status, "unhealthy");
  assert.equal(health.fleet_id, "llama:draft-b");
  assert.equal(cleanExit.severity, "info");
  assert.equal(cleanExit.data.exitCode, 0);
  assert.equal(cleanExit.data.oomKilled, false);
  await collector.stop();
  assert.equal(child.killed, true, "stop() ends the stream");

  // The last event time survives a restart: the next stream replays from it.
  const saved = await store.getState(STATE_NAME);
  assert.equal(saved.docker.since, T0_SECONDS + 400);
  child = null;
  const restarted = createEventCollector({ store, dockerEvents: source, now: () => NOW, logger: null });
  restarted.start();
  t.after(() => restarted.stop());
  await waitFor(() => child, 2000, "the second stream");
  assert.deepEqual(opens, [null, T0_SECONDS + 400]);
  for (const line of dockerLines()) child.stdout.write(`${line}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await restarted.flush();
  assert.equal(readEvents(file).length, 5, "replayed docker events are not recorded twice");
  assert.equal(createDockerEventSource({}).eventArgs(T0_SECONDS).join(" "), `events --filter label=ai.manager --format {{json .}} --since ${T0_SECONDS}`);
  assert.equal(dockerEventFromLine(JSON.stringify({ Type: "volume", Action: "mount", Actor: { ID: "v1" } })), null);
});

function failingDocker(calls) {
  return (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const child = fakeChild();
    setImmediate(() => {
      child.stderr.end("error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.");
      child.emit("exit", 1, null);
      child.stderr.once("end", () => child.emit("close", 1, null));
    });
    return child;
  };
}

function assertNeverStartsDocker(spawned, execs) {
  for (const call of [...spawned, ...execs]) {
    const line = [call.command, ...call.args].join(" ");
    assert.doesNotMatch(line, /docker desktop/i, `no Docker Desktop start: ${line}`);
    assert.doesNotMatch(line, /\bsleep\b|infinity|--set-default|--install|\bstart\b/i, `no start call: ${line}`);
  }
}

test("Docker unavailable: backoff from 5 s to 5 min, and Docker Desktop is never started", async (t) => {
  const timers = manualTimers();
  const spawned = [];
  const execs = [];
  const source = createDockerEventSource({
    spawn: failingDocker(spawned),
    execFile: (command, args) => execs.push({ command, args }),
  });
  const collector = createEventCollector({ dockerEvents: source, timers, now: () => NOW, logger: null });
  collector.start();
  t.after(() => collector.stop());
  const delays = [];
  for (let attempt = 0; attempt < 9; attempt += 1) {
    await waitFor(() => timers.pending().length === 1, 2000, `backoff ${attempt}`);
    const [timer] = timers.pending();
    delays.push(timer.ms);
    await timers.fire(timer);
  }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  await waitFor(() => timers.pending().length === 1, 2000, "the last backoff");
  assert.equal(spawned.length, 10, "one docker events attempt per backoff step");
  for (const call of spawned) {
    assert.equal(call.command, "docker");
    assert.deepEqual(call.args, ["events", "--filter", "label=ai.manager", "--format", "{{json .}}"]);
    assert.equal(call.options.windowsHide, true);
  }
  assert.deepEqual(execs, [], "no other command runs");
  assertNeverStartsDocker(spawned, execs);
  const status = collector.status();
  assert.equal(status.state, "degraded");
  assert.equal(status.docker.state, "backoff");
  assert.equal(status.docker.lastError.code, "docker_unavailable");
  assert.match(status.docker.lastError.message, /dockerDesktopLinuxEngine/);
});

test("Docker in a stopped WSL distro: the distro is never booted, only listed", async (t) => {
  const timers = manualTimers();
  const spawned = [];
  const execs = [];
  let running = ["Other-Distro"];
  const source = dockerEventSourceFromEnv({ DOCKER_WSL_DISTRO: "Ubuntu-Test" }, {
    spawn: (command, args, options) => {
      spawned.push({ command, args: [...args], options });
      return fakeChild();
    },
    execFile: (command, args, options, callback) => {
      execs.push({ command, args: [...args] });
      // wsl.exe prints UTF-16LE.
      setImmediate(() => callback(null, Buffer.from(`${running.join("\r\n")}\r\n`, "utf16le"), Buffer.alloc(0)));
    },
  });
  const collector = createEventCollector({ dockerEvents: source, timers, now: () => NOW, logger: null });
  collector.start();
  t.after(() => collector.stop());
  const delays = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitFor(() => timers.pending().length === 1, 2000, `backoff ${attempt}`);
    const [timer] = timers.pending();
    delays.push(timer.ms);
    if (attempt < 2) await timers.fire(timer);
  }
  assert.deepEqual(delays, [5000, 10000, 20000]);
  assert.deepEqual(spawned, [], "no wsl -d call while the distro is stopped");
  assert.equal(collector.status().docker.lastError.code, "wsl_distro_not_running");
  for (const call of execs) {
    assert.equal(call.command, "wsl.exe");
    assert.deepEqual(call.args, ["--list", "--running", "--quiet"]);
  }

  running = ["Other-Distro", "Ubuntu-Test"];
  await timers.fire(timers.pending()[0]);
  await waitFor(() => spawned.length === 1, 2000, "the stream once the distro runs");
  assert.equal(spawned[0].command, "wsl.exe");
  assert.deepEqual(spawned[0].args, ["-d", "Ubuntu-Test", "--exec", "docker", "events", "--filter", "label=ai.manager", "--format", "{{json .}}"]);
  assert.equal(collector.status().docker.state, "connected");
  assertNeverStartsDocker(spawned, execs);
  assert.equal(dockerEventSourceFromEnv({ DOCKER_WSL_DISTRO: "bad name; rm" }), null);
});

// --- log tails -----------------------------------------------------------------

function exitLines(list) {
  return list.map((entry) => `${JSON.stringify(withKey(entry))}\n`).join("");
}

test("process-exit tails: offsets and the last event per label survive a restart; hard kills are detected", async (t) => {
  const { store, file, dir } = await tempStore(t);
  const log = path.join(dir, "vllm-manager", "logs", "process-exit.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const firstText = exitLines(exitFixture.firstRun);
  fs.writeFileSync(log, firstText);
  const tailFiles = [{ id: "process-exit:vllm", kind: "process-exit", managerId: "vllm", file: log }];

  const first = spyInserts(store);
  const collectorA = createEventCollector({ store: first.store, tailFiles, now: () => NOW, logger: null });
  await collectorA.tick();
  await collectorA.stop();
  assert.deepEqual(types(first.offered), ["manager.start", "manager.signal", "manager.exit", "manager.start"]);
  const saved = await store.getState(STATE_NAME);
  assert.equal(saved.tails["process-exit:vllm"].offset, Buffer.byteLength(firstText));
  assert.equal(saved.tails["process-exit:vllm"].labels["vLLM Manager"].pid, 4102);

  const secondText = exitLines(exitFixture.secondRun);
  fs.appendFileSync(log, secondText);
  const second = spyInserts(store);
  const collectorB = createEventCollector({ store: second.store, tailFiles, now: () => NOW, logger: null });
  await collectorB.tick();
  assert.equal(collectorB.status().tails["process-exit:vllm"].bytesRead, Buffer.byteLength(secondText), "only the new bytes are read");
  assert.deepEqual(types(second.offered), ["manager.hard_kill_suspected", "manager.start", "manager.crash", "manager.exit"]);
  await collectorB.stop();

  const rows = readEvents(file);
  assert.equal(rows.length, 8);
  const hardKill = rows.find((row) => row.type === "manager.hard_kill_suspected");
  assert.equal(hardKill.severity, "warning");
  assert.equal(hardKill.manager_id, "vllm");
  assert.equal(hardKill.at, Date.parse("2026-10-14T07:45:00.000Z"));
  assert.deepEqual([hardKill.data.pid, hardKill.data.previousPid, hardKill.data.previousEvent], [4103, 4102, "start"]);
  assert.equal(rows.filter((row) => row.type === "manager.hard_kill_suspected").length, 1, "a clean signal and exit is not a hard kill");
  const crash = rows.find((row) => row.type === "manager.crash");
  assert.equal(crash.severity, "critical");
  assert.equal(crash.data.error, "Error: upstream refused --api-key <redacted>");
  const exits = rows.filter((row) => row.type === "manager.exit");
  assert.deepEqual(exits.map((row) => [row.data.code, row.severity]), [[0, "info"], [1, "warning"]]);
  assert.equal(dumpEvents(file).includes(FIXTURE_KEY), false);
});

test("a rotated process-exit.log is read to its end before the new file", async (t) => {
  const { store, file, dir } = await tempStore(t);
  const log = path.join(dir, "process-exit.log");
  const lines = exitFixture.firstRun.map((entry) => `${JSON.stringify(entry)}\n`);
  fs.writeFileSync(log, lines[0] + lines[1]);
  const tailFiles = [{ id: "process-exit:entry", kind: "process-exit", managerId: "entry", file: log }];
  const collector = createEventCollector({ store, tailFiles, now: () => NOW, logger: null });
  await collector.tick();
  // A line lands, then process-exit-log.js rotates the file to .1.
  fs.appendFileSync(log, lines[2]);
  fs.renameSync(log, `${log}.1`);
  fs.writeFileSync(log, lines[3]);
  await collector.tick();
  await collector.stop();
  assert.deepEqual(types(readEvents(file)), ["manager.start", "manager.signal", "manager.exit", "manager.start"]);
});

test("the MCP tail records tool calls without the client id; a partial line waits for its end", async (t) => {
  const { store, file, dir } = await tempStore(t);
  const log = path.join(dir, "audit", "platform-mcp.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const [ok, failed, rejected] = mcpFixture.lines.map((entry) => JSON.stringify(entry));
  fs.writeFileSync(log, `${ok}\n${failed}\n${rejected.slice(0, 40)}`);
  const collector = createEventCollector({ store, tailFiles: [{ id: "mcp", kind: "mcp", file: log }], now: () => NOW, logger: null });
  await collector.tick();
  assert.equal(readEvents(file).length, 2);
  fs.appendFileSync(log, `${rejected.slice(40)}\n`);
  await collector.tick();
  await collector.tick();
  await collector.stop();
  const rows = readEvents(file);
  assert.deepEqual(types(rows), ["mcp.tool_call", "mcp.tool_call", "mcp.tool_call"]);
  assert.deepEqual(rows.map((row) => [row.data.tool, row.data.ok, row.data.durationMs, row.data.errorCode]), [
    ["get_platform_status", true, 42, null],
    ["start_model", false, 1500, "ManagerRequestError"],
    ["list_models", false, 0, "rate_limited"],
  ]);
  assert.equal(rows[0].dedupe_key, "mcp:6f1c2b1e-0000-4000-8000-000000000001");
  assert.equal(rows[0].source, "mcp");
  assert.equal(dumpEvents(file).includes("client-fixture"), false, "the client id is not recorded");
});

// --- bus kinds, config, benchmarks ----------------------------------------------

test("reachability edges, security, access, platform and downloads from the bus", async (t) => {
  const { store, file } = await tempStore(t);
  const bus = fakeBus();
  const collector = createEventCollector({ store, events: bus, now: () => NOW, logger: null });
  collector.start();
  t.after(() => collector.stop());
  const at = (minutes) => ({ at: NOW + minutes * 60_000 });
  bus.deliver("status", { reason: "manager_down", managerId: "llama" }, at(1));
  bus.deliver("status", { reason: "manager_down", managerId: "llama" }, at(2));
  bus.deliver("status", { reason: "manager_up", managerId: "llama" }, at(3));
  bus.deliver("status", { reason: "fleet_changed" }, at(4));
  bus.deliver("security", { kind: "ban", ip: "203.0.113.9", ipMasked: "203.0.113.x", until: "2026-10-14T10:20:00.000Z", failures: 20 }, at(5));
  bus.deliver("security", { kind: "internal_auth_failed", requestId: "req_aaaaaaaaaaaaaaaaaaaa", authorization: `Bearer ${FIXTURE_KEY}` }, at(6));
  bus.deliver("access", { kind: "key_created", keyId: "k_fixture01", secret: FIXTURE_KEY }, at(7));
  bus.deliver("access", { kind: "settings_changed", changed: ["exposure.requireApiKey"] }, at(8));
  bus.deliver("platform", { kind: "component", id: "vllm", state: "unhealthy", prev: "ready", reason: "health check failed" }, { ...at(9), source: "platform" });
  bus.deliver("platform", { kind: "operation", opId: "op1", opKind: "setup", state: "running" }, { ...at(10), source: "platform" });
  bus.deliver("downloads", { kind: "job", jobs: [{ id: "dl_aaaaaaaaaaaaaaaaaaaa", state: "downloading" }, { id: "dl_bbbbbbbbbbbbbbbbbbbb", state: "failed", repo: "org/model", error: { code: "transfer_stalled" } }] }, { ...at(11), source: "hub" });
  bus.relay.jobs({ managerId: "vllm", jobs: [{ id: "legacy-dl", type: "download", status: "success", meta: { repoId: "org/other" }, updatedAt: "2026-10-14T10:12:00.000Z" }], removed: [] });
  await collector.flush();

  const rows = readEvents(file);
  assert.deepEqual(types(rows), [
    "manager.unreachable", "manager.reachable", "security.ban", "security.internal_auth_failed",
    "config.keys", "config.exposure", "platform.component", "download.failed", "download.completed",
  ]);
  const [down, up, ban, authFailed, keys, exposure, component, failedDownload, legacyDownload] = rows;
  assert.equal(down.severity, "warning");
  assert.equal(down.manager_id, "llama");
  assert.equal(up.severity, "info");
  assert.equal(ban.severity, "warning");
  assert.deepEqual([ban.data.ipMasked, ban.data.failures], ["203.0.113.x", 20]);
  assert.equal(authFailed.request_id, "req_aaaaaaaaaaaaaaaaaaaa");
  assert.equal(keys.data.action, "key_created");
  assert.equal(keys.data.keyId, "k_fixture01");
  assert.deepEqual(keys.data.changed, []);
  assert.equal(keys.data.secret, undefined, "access events keep the action and key id only");
  assert.deepEqual(exposure.data.changed, ["exposure.requireApiKey"]);
  assert.equal(component.severity, "warning");
  assert.equal(component.source, "platform");
  assert.equal(failedDownload.data.errorCode, "transfer_stalled");
  assert.equal(failedDownload.dedupe_key, "dl:hub:dl_bbbbbbbbbbbbbbbbbbbb:failed");
  assert.equal(legacyDownload.dedupe_key, "dl:vllm:legacy-dl:completed");
  assert.equal(dumpEvents(file).includes(FIXTURE_KEY), false);

  // The edge state is persisted: a restart does not repeat "reachable".
  await collector.stop();
  const restarted = createEventCollector({ store, events: bus, now: () => NOW, logger: null });
  restarted.start();
  t.after(() => restarted.stop());
  bus.deliver("status", { reason: "manager_up", managerId: "llama" }, at(20));
  await restarted.flush();
  assert.equal(readEvents(file, "type LIKE 'manager.%'").length, 2);
});

test("config changes record changed key names only, from the hook and from platform.json", async (t) => {
  const { store, file, dir } = await tempStore(t);
  const configFile = path.join(dir, "config", "platform.json");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ listeners: { admin: { port: 5176, lan: false } }, telemetry: { retention: { requestsDays: 30 } } }));
  let clock = NOW;
  const collector = createEventCollector({ store, platformConfigFile: configFile, configCheckMs: 0, now: () => clock, logger: null });

  const before = { mode: "auto", reserveMb: 2048, preferEngine: "engine-value-a", hidden: { token: "value-one" } };
  const after = { mode: "auto", reserveMb: 3072, preferEngine: "engine-value-b", hidden: { token: "value-two" } };
  assert.deepEqual(changedKeys(before, after), ["hidden.token", "preferEngine", "reserveMb"]);
  collector.recordConfigChange("fleet", { before, after });
  assert.equal(collector.recordConfigChange("fleet", { before, after: before }), null, "no change, no event");
  assert.equal(collector.recordConfigChange("bogus", ["a"]), null);

  await collector.tick();
  assert.equal(readEvents(file, "type = 'config.platform'").length, 0, "the first read is the baseline");
  clock += 60_000;
  fs.writeFileSync(configFile, JSON.stringify({ listeners: { admin: { port: 5176, lan: true } }, telemetry: { retention: {} }, console: { defaultUi: "console-new-value" } }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(configFile, later, later);
  await collector.tick();
  await collector.stop();

  const fleet = readEvents(file, "type = 'config.fleet'");
  const platform = readEvents(file, "type = 'config.platform'");
  assert.equal(readEvents(file).length, 2);
  assert.deepEqual(fleet.map((row) => row.data.changed), [["hidden.token", "preferEngine", "reserveMb"]]);
  assert.deepEqual(platform.map((row) => row.data.changed), [["console.defaultUi", "listeners.admin.lan", "telemetry.retention", "telemetry.retention.requestsDays"]]);
  assert.equal(platform[0].source, "platform");
  const dump = dumpEvents(file);
  for (const value of ["value-one", "value-two", "engine-value-a", "engine-value-b", "console-new-value"]) assert.equal(dump.includes(value), false, `${value} is not recorded`);
});

test("benchmarks are polled into one benchmark.run per run", async (t) => {
  const { store, file } = await tempStore(t);
  let updatedAt = "2026-10-14T09:00:00.000Z";
  let runs = [
    { id: "run-1", at: "2026-10-14T08:30:00.000Z", engine: "sglang", model: "/models/qwen-test", label: "baseline", load: { requests: 32, concurrency: 4 }, metrics: { outputTokensPerSecond: 512 } },
  ];
  const reads = [];
  const managers = {
    ids: ["vllm", "llama"],
    get: async (managerId, target) => {
      reads.push(`${managerId} ${target}`);
      if (managerId === "llama") return { ok: false, status: 0, code: "manager_unreachable", data: null };
      return { ok: true, status: 200, data: { version: 1, updatedAt, total: runs.length, models: [], runs } };
    },
  };
  const collector = createEventCollector({ store, managers, now: () => NOW, logger: null });
  await collector.pollBenchmarks();
  await collector.pollBenchmarks();
  runs = [{ id: "run-2", at: "2026-10-14T09:10:00.000Z", engine: "sglang", model: "qwen-test", load: {}, metrics: {} }, ...runs];
  updatedAt = "2026-10-14T09:10:00.000Z";
  await collector.pollBenchmarks();
  await collector.stop();
  assert.deepEqual(reads, ["vllm benchmarks", "llama benchmarks", "vllm benchmarks", "llama benchmarks", "vllm benchmarks", "llama benchmarks"]);
  const rows = readEvents(file);
  assert.deepEqual(rows.map((row) => [row.type, row.dedupe_key, row.data.model]), [
    ["benchmark.run", "bench:vllm:run-1", "qwen-test"],
    ["benchmark.run", "bench:vllm:run-2", "qwen-test"],
  ]);
  assert.equal(rows[0].data.metrics.outputTokensPerSecond, 512);
});

test("a store that is restarting keeps the rows for the next write", async () => {
  const offered = [];
  let busy = true;
  const states = new Map();
  const store = {
    insertEvents: async (rows) => {
      offered.push(rows.length);
      if (busy) return { accepted: 0, duplicates: 0, rejected: 0, dropped: rows.length, errors: [], error: "telemetry_store_busy", retryable: true };
      return { accepted: rows.length, duplicates: 0, rejected: 0, dropped: 0, errors: [] };
    },
    getState: async (name) => states.get(name) ?? null,
    setState: async (name, value) => {
      states.set(name, JSON.parse(JSON.stringify(value)));
      return { ok: true };
    },
  };
  const bus = fakeBus();
  const collector = createEventCollector({ store, events: bus, now: () => NOW, logger: null });
  collector.start();
  bus.relay.jobs(jobsFixture.ready[0]);
  await collector.flush();
  assert.equal(collector.status().pending, 2);
  assert.equal(collector.status().recorded, 0);
  busy = false;
  await collector.flush();
  assert.equal(collector.status().pending, 0);
  assert.equal(collector.status().recorded, 2);
  assert.ok(offered.length > 2, "the busy store was asked again");
  await collector.stop();
});
