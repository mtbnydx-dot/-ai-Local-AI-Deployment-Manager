"use strict";

// A fake world for supervisor tests: a fake clock, a fake launcher with
// in-memory identity records, fake winproc facts and probes keyed by the
// component a check belongs to. Nothing here spawns, kills or listens.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const configApi = require("../../../platform/config");
const componentsApi = require("../../../platform/components");
const { createSupervisor } = require("../../../platform/supervisor");

const START = Date.parse("2026-10-14T08:00:00.000Z");
const NODE_EXE = "C:\\fixture\\bin\\node.exe";

function createFakeClock(start = START) {
  let current = start;
  let sequence = 0;
  const timers = new Map();
  const clock = {
    now: () => current,
    setTimeout(fn, ms) {
      sequence += 1;
      timers.set(sequence, { id: sequence, at: current + Math.max(0, Number(ms) || 0), fn });
      return sequence;
    },
    clearTimeout(id) { timers.delete(id); },
    async flush(rounds = 30) {
      for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    // Fires every timer due up to now + ms in order, letting promises settle
    // between timers.
    async advance(ms) {
      const target = current + ms;
      await clock.flush();
      for (;;) {
        const due = [...timers.values()].filter((timer) => timer.at <= target).sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!due) break;
        timers.delete(due.id);
        current = Math.max(current, due.at);
        due.fn();
        await clock.flush();
      }
      current = target;
      await clock.flush();
    },
    get pending() { return timers.size; },
  };
  return clock;
}

// Which component a probe belongs to, from its URL or command.
const PROBE_KEYS = Object.freeze([
  [":5176/", "entry"], [":5186/", "service-entry-public"], [":5177/", "vllm-manager"], [":5178/", "llama-manager"],
  [":5190/", "platform-mcp"], [":7000/", "tts-gateway"], [":5180/", "search-gateway"],
]);

function probeKey(check) {
  if (Array.isArray(check?.command)) return "docker";
  const url = String(check?.http || "");
  return PROBE_KEYS.find(([needle]) => url.includes(needle))?.[1] || url;
}

function createWorld(t, options = {}) {
  const aiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "platform-supervisor-"));
  t.after(() => fs.rmSync(aiRoot, { recursive: true, force: true }));
  const clock = options.clock || createFakeClock();
  const config = configApi.loadPlatformConfig({ aiRoot, env: {}, runtimeOverrides: options.runtimeOverrides || {} });
  const registry = componentsApi.loadComponentRegistry({ aiRoot, config });
  if (typeof options.editRegistry === "function") options.editRegistry(registry);
  const world = {
    aiRoot, clock, config, registry,
    up: new Set(options.up || []),
    dockerUp: options.dockerUp !== false,
    autoReady: options.autoReady !== false,
    listeners: [],
    processes: new Map(),
    calls: [],
    notifications: [],
    events: [],
    blockers: [],
    children: new Map(),
    identities: new Map(),
    nextPid: 5000,
  };
  const iso = () => new Date(clock.now()).toISOString();

  world.launcher = {
    async start(spec, startOptions) {
      world.calls.push(["start", spec.id]);
      const pid = world.nextPid++;
      const child = new EventEmitter();
      child.pid = pid;
      const identity = { schemaVersion: 1, id: spec.id, pid, processCreatedAt: iso(), exe: NODE_EXE, commandLine: `node ${(spec.args || []).join(" ")}`, spawnedBy: startOptions?.spawnedBy || "supervisor", startedAt: iso() };
      world.identities.set(spec.id, identity);
      world.processes.set(pid, { pid, processCreatedAt: identity.processCreatedAt, exe: NODE_EXE, commandLine: identity.commandLine });
      world.children.set(spec.id, child);
      if (world.autoReady) world.up.add(spec.id);
      return { ok: true, child, identity };
    },
    async stop(spec, stopOptions = {}) {
      world.calls.push(["stop", spec.id, { explicit: stopOptions.explicit === true }]);
      const identity = stopOptions.identity || world.identities.get(spec.id);
      const current = identity ? world.processes.get(identity.pid) : null;
      if (identity && current && current.processCreatedAt !== identity.processCreatedAt) return { ok: false, state: "unknown", reason: "identity-mismatch" };
      if (identity) world.processes.delete(identity.pid);
      world.identities.delete(spec.id);
      world.up.delete(spec.id);
      return { ok: true, stopped: true, reason: "requested" };
    },
    async adopt(spec, info) {
      world.calls.push(["adopt", spec.id, info.pid]);
      const identity = { schemaVersion: 1, id: spec.id, pid: info.pid, processCreatedAt: info.processCreatedAt, exe: info.exe, commandLine: info.commandLine, spawnedBy: "adopted", startedAt: iso() };
      world.identities.set(spec.id, identity);
      return { ok: true, identity };
    },
    readIdentity(id) { return world.identities.get(id) || null; },
    archiveIdentity(id) {
      world.calls.push(["archive", id]);
      world.identities.delete(id);
    },
  };
  world.winproc = {
    async listListeners() { return world.listeners.slice(); },
    async processInfo(pid) { return world.processes.get(Number(pid)) || null; },
    async imageNames(pids) { return Object.fromEntries(pids.map((pid) => [pid, world.processes.get(pid)?.imageName || "unknown.exe"])); },
    async killTree(pid) { world.calls.push(["killTree", pid]); return { ok: true }; },
  };
  world.probe = async (check) => {
    const key = probeKey(check);
    world.calls.push(["probe", key]);
    return key === "docker" ? { ok: world.dockerUp } : { ok: world.up.has(key) };
  };
  world.fetch = options.fetch || (async (url) => {
    if (String(url).endsWith("/api/instances")) return new Response(JSON.stringify({ instances: options.instances || [] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  });
  world.options = (extra = {}) => ({
    aiRoot, env: {}, clock, config, registry,
    profile: options.profile || "none",
    launcher: world.launcher, winproc: world.winproc, probe: world.probe, fetch: world.fetch,
    ensureDocker: options.ensureDocker || (async () => world.dockerUp),
    collectBlockers: options.collectBlockers === null ? undefined : options.collectBlockers || (async () => world.blockers.slice()),
    entryClient: options.entryClient,
    runDoctor: false,
    readOps: () => ({ nightly: { ok: true, streak: 0, since: null }, backup: { ageHours: 4.5, ok: true } }),
    getBuildId: () => ({ commit: "c0146a7d2f1e", contentHash: "3f9c2a1b7d0e" }),
    loadHook: options.loadHook || (() => ({ prepare: async () => ({ env: {} }) })),
    secrets: { get: () => "", set: async () => {}, has: () => false },
    redactor: { redact: (text) => text },
    pid: 4242,
    ...extra,
  });
  world.create = (extra = {}) => {
    const supervisor = createSupervisor(world.options(extra));
    supervisor.subscribe((event) => {
      world.events.push(event);
      if (event.type === "notification") world.notifications.push(event.data);
    });
    t.after(() => supervisor.close());
    return supervisor;
  };
  world.starts = (id) => world.calls.filter((call) => call[0] === "start" && (!id || call[1] === id)).map((call) => call[1]);
  world.exit = (id, code, signal = null) => world.children.get(id).emit("exit", code, signal);
  world.listen = (port, pid, info) => {
    world.listeners.push({ protocol: "tcp", address: "127.0.0.1", port, pid, state: "LISTENING" });
    if (info) world.processes.set(pid, { pid, ...info });
  };
  return world;
}

module.exports = { START, NODE_EXE, createFakeClock, createWorld, probeKey };
