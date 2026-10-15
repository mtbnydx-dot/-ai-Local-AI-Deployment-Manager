"use strict";

// OPS-12: working set, restore models (add/skip only), the nightly and backup
// watch, and the toast subscriber. Everything runs on the fake clock and a
// fake manager; no service, container or network is touched.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createWorld } = require("./fixtures/platform/supervisor-world");

const VLLM = "http://127.0.0.1:5177";
const LLAMA = "http://127.0.0.1:5178";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function workingSetPath(world) {
  return path.join(world.aiRoot, ".runtime", "platform", "working-set.json");
}

function writeWorkingSet(world, managers) {
  fs.mkdirSync(path.dirname(workingSetPath(world)), { recursive: true });
  fs.writeFileSync(workingSetPath(world), JSON.stringify({ at: "2026-10-14T07:00:00.000Z", managers }));
}

function entry(id, extra = {}) {
  return { launchId: `lch_${id}`, instanceId: `inst-${id}`, model: `model-${id}`, name: `name-${id}`, ...extra };
}

// A fake manager: GET /api/instances, GET /api/launches/:id, POST /api/launch, GET /api/jobs/:id.
function fakeManager({ instances = [], launches = {}, answer, recent = [], noLaunchRoute = false } = {}) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const target = String(url);
    const route = target.replace(/^https?:\/\/[^/]+/, "");
    const method = init.method || "GET";
    requests.push({ origin: target.slice(0, target.indexOf(route)), method, route, body: init.body || null });
    if (route === "/api/instances") return json({ instances });
    if (route === "/api/recent-launches") return json(recent);
    if (route.startsWith("/api/launches/")) {
      const record = launches[decodeURIComponent(route.split("/").pop())];
      return record ? json(record) : json({ error: "unknown_launch" }, 404);
    }
    if (route === "/api/launch" && method === "POST") {
      if (noLaunchRoute) return json({ error: "not_found" }, 404);
      return answer ? answer(JSON.parse(init.body), requests) : json({ ok: true, jobId: `job_${requests.length}` }, 202);
    }
    if (route.startsWith("/api/jobs/")) return json({ id: route.split("/").pop(), status: "completed" });
    return json({}, 404);
  };
  return { fetch, requests, posts: () => requests.filter((request) => request.route === "/api/launch") };
}

function launchRecord(id, mode = "replace") {
  return { launchId: `lch_${id}`, spec: { engineId: "sglang", runtimeId: "rt", model: { ref: `model-${id}` }, instance: { mode, id: "primary", port: 8000 }, values: { contextLength: 4096 }, extraArgs: [], extraEnv: {}, secrets: { apiKeyRef: "" } } };
}

async function startManager(world, supervisor, id = "vllm-manager") {
  await supervisor.startComponent(id, { wait: true });
  await world.clock.advance(100);
  await world.clock.flush(80);
}

test("auto restore posts add/skip bodies, never `replace`, and never calls /api/start", async (t) => {
  const launches = { lch_a: launchRecord("a", "replace"), lch_b: launchRecord("b", "add"), lch_c: launchRecord("c", undefined) };
  delete launches.lch_c.spec.instance.mode;
  const manager = fakeManager({ launches });
  const world = createWorld(t, { fetch: manager.fetch, runtimeOverrides: { "supervisor.restoreModels": "auto" } });
  writeWorkingSet(world, { vllm: [entry("a"), entry("b"), entry("c")], llama: [] });
  const supervisor = world.create();
  await startManager(world, supervisor);
  const posts = manager.posts();
  assert.equal(posts.length, 3);
  for (const post of posts) {
    const body = JSON.parse(post.body);
    assert.equal(body.instance.mode, "add");
    assert.equal(body.onConflict, "skip");
    assert.equal(body.source, "restore");
    assert.equal(body.engineId, "sglang");
    assert.deepEqual(body.values, { contextLength: 4096 });
  }
  assert.deepEqual(posts.map((post) => JSON.parse(post.body).model.ref), ["model-a", "model-b", "model-c"]);
  for (const request of manager.requests) {
    assert.ok(!/replace/i.test(request.body || ""), `${request.route} carries no replace`);
    assert.notEqual(request.route, "/api/start");
  }
  assert.ok(!world.notifications.some((item) => item.kind.startsWith("restore.")), "a clean restore raises no notification");
});

test("restore skips what is already running and the dry run reports the plan without side effects", async (t) => {
  const manager = fakeManager({
    instances: [{ id: "inst-a", name: "name-a", model: "model-a", launchId: "lch_a", running: true, lifecycle: { state: "ready" } }],
    launches: { lch_b: launchRecord("b") },
  });
  const world = createWorld(t, { fetch: manager.fetch });
  writeWorkingSet(world, { vllm: [entry("a"), entry("b"), entry("c", { legacy: true, launchId: null })], llama: [] });
  const supervisor = world.create();
  await startManager(world, supervisor);
  const dry = await supervisor.restoreModels({ dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plan.map((item) => [item.managerId, item.launchId, item.action]), [
    ["vllm", "lch_a", "skip-running"], ["vllm", "lch_b", "launch"], ["vllm", null, "offer-only"],
  ]);
  assert.equal(manager.posts().length, 0, "a dry run posts nothing");
  const before = world.notifications.length;
  const started = await supervisor.restoreModels({});
  assert.match(started.opId, /^op_/);
  await world.clock.flush(80);
  const posts = manager.posts();
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].body).model.ref, "model-b");
  // The legacy entry degrades to an offer.
  const offers = world.notifications.slice(before).filter((item) => item.kind === "restore.offer");
  assert.equal(offers.length, 1);
  assert.deepEqual(offers[0].action.apiCall, { method: "POST", path: "/api/platform/restore-models", body: {} });
  assert.deepEqual(offers[0].action.label, { zh: "启动上次的模型", en: "Start last used model" });
});

test("default `offer` mode raises one offer and starts nothing; `off` stays silent", async (t) => {
  const manager = fakeManager({ launches: { lch_a: launchRecord("a") } });
  const world = createWorld(t, { fetch: manager.fetch });
  writeWorkingSet(world, { vllm: [entry("a")], llama: [] });
  const supervisor = world.create();
  await startManager(world, supervisor);
  assert.equal(manager.posts().length, 0);
  const offers = world.notifications.filter((item) => item.kind === "restore.offer");
  assert.equal(offers.length, 1);
  assert.equal(offers[0].severity, "info");
  assert.ok(offers[0].title.zh && offers[0].title.en && offers[0].body.zh && offers[0].body.en);

  const quiet = createWorld(t, { fetch: manager.fetch, runtimeOverrides: { "supervisor.restoreModels": "off" } });
  writeWorkingSet(quiet, { vllm: [entry("a")], llama: [] });
  const second = quiet.create();
  await startManager(quiet, second);
  assert.equal(quiet.notifications.filter((item) => item.kind.startsWith("restore.")).length, 0);
});

test("a conflict raises one restore.conflict notification per entry and restore continues", async (t) => {
  const answers = [
    () => json({ skipped: true, conflict: { instanceId: "primary" } }),
    () => json({ error: { code: "instance_conflict" } }, 409),
    () => json({ ok: true, jobId: "job_x" }, 202),
  ];
  const manager = fakeManager({
    launches: { lch_a: launchRecord("a"), lch_b: launchRecord("b"), lch_c: launchRecord("c") },
    answer: () => answers.shift()(),
  });
  const world = createWorld(t, { fetch: manager.fetch, runtimeOverrides: { "supervisor.restoreModels": "auto" } });
  writeWorkingSet(world, { vllm: [entry("a"), entry("b"), entry("c")], llama: [] });
  const supervisor = world.create();
  await startManager(world, supervisor);
  assert.equal(manager.posts().length, 3, "restore continues after a conflict");
  const conflicts = world.notifications.filter((item) => item.kind === "restore.conflict");
  assert.equal(conflicts.length, 2);
  assert.equal(conflicts[0].severity, "warn");
  assert.deepEqual(conflicts[0].action, { label: { zh: "去部署页手动替换", en: "Replace manually" }, href: "/deployments?manager=vllm" });
  assert.match(conflicts[0].body.en, /name-a was not restored/);
  assert.match(conflicts[0].body.zh, /name-a 未恢复/);
});

test("an admission block stops the rest of that manager only", async (t) => {
  const vllm = fakeManager({
    launches: { lch_a: launchRecord("a"), lch_b: launchRecord("b") },
    answer: () => json({ error: { code: "admission_blocked" } }, 409),
  });
  const llama = fakeManager({ launches: { lch_x: launchRecord("x") } });
  const world = createWorld(t, {
    runtimeOverrides: { "supervisor.restoreModels": "auto" },
    fetch: (url, init) => (String(url).startsWith(LLAMA) ? llama.fetch(url, init) : vllm.fetch(url, init)),
  });
  writeWorkingSet(world, { vllm: [entry("a"), entry("b")], llama: [entry("x")] });
  const supervisor = world.create();
  await startManager(world, supervisor, "vllm-manager");
  await startManager(world, supervisor, "llama-manager");
  assert.equal(vllm.posts().length, 1, "the second vllm entry is skipped");
  assert.equal(llama.posts().length, 1, "the other manager still restores");
  const blocked = world.notifications.filter((item) => item.kind === "restore.blocked");
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].body.en, /Not enough GPU memory/);

  const verdict = fakeManager({ launches: { lch_a: launchRecord("a"), lch_b: launchRecord("b") }, answer: () => json({ verdict: "block" }) });
  const second = createWorld(t, { fetch: verdict.fetch, runtimeOverrides: { "supervisor.restoreModels": "auto" } });
  writeWorkingSet(second, { vllm: [entry("a"), entry("b")], llama: [] });
  await startManager(second, second.create());
  assert.equal(verdict.posts().length, 1);
  assert.equal(second.notifications.filter((item) => item.kind === "restore.blocked").length, 1);
});

test("a manager without POST /api/launch and legacy entries degrade to an offer", async (t) => {
  const manager = fakeManager({ noLaunchRoute: true, launches: { lch_a: launchRecord("a"), lch_b: launchRecord("b") } });
  const world = createWorld(t, { fetch: manager.fetch, runtimeOverrides: { "supervisor.restoreModels": "auto" } });
  writeWorkingSet(world, { vllm: [entry("a"), entry("b"), entry("c", { legacy: true, launchId: null })], llama: [] });
  const supervisor = world.create();
  await startManager(world, supervisor);
  assert.equal(manager.posts().length, 1, "the first 404 ends the manager's attempts");
  assert.equal(manager.requests.filter((request) => request.route === "/api/start").length, 0);
  const offers = world.notifications.filter((item) => item.kind === "restore.offer");
  assert.equal(offers.length, 1);
  assert.match(offers[0].body.en, /^3 model/);
  assert.ok(!world.notifications.some((item) => item.kind === "restore.conflict"));
});

test("--restore-models forces auto whatever the setting says", async (t) => {
  const manager = fakeManager({ launches: { lch_a: launchRecord("a") } });
  const world = createWorld(t, { fetch: manager.fetch, runtimeOverrides: { "supervisor.restoreModels": "off" } });
  writeWorkingSet(world, { vllm: [entry("a")], llama: [] });
  const supervisor = world.create({ restoreModels: true });
  await startManager(world, supervisor);
  assert.equal(manager.posts().length, 1);
});

test("the working set keeps launch ids, matches legacy containers by model and name, and is saved before a manager stop", async (t) => {
  const manager = fakeManager({
    instances: [
      { id: "i1", name: "alpha", model: "model-1", launchId: "lch_1", lifecycle: { state: "ready" } },
      { id: "i2", name: "beta", model: "model-2", lifecycle: { state: "ready" } },
      { id: "i3", name: "gamma", model: "model-3", lifecycle: { state: "loading" } },
    ],
    recent: [
      { launchId: "lch_old", model: "model-2", name: "beta", at: "2026-10-01T00:00:00Z" },
      { launchId: "lch_new", model: "model-2", name: "beta", at: "2026-10-12T00:00:00Z" },
    ],
  });
  const world = createWorld(t, { fetch: manager.fetch });
  const supervisor = world.create();
  await supervisor.start();
  await startManager(world, supervisor);
  assert.ok(!fs.existsSync(workingSetPath(world)), "nothing is written until the periodic tick or a stop");
  await world.clock.advance(5 * 60 * 1000 + 100);
  const written = JSON.parse(fs.readFileSync(workingSetPath(world), "utf8"));
  assert.equal(written.at, "2026-10-14T08:05:00.000Z");
  assert.deepEqual(written.managers.vllm, [
    { launchId: "lch_1", instanceId: "i1", model: "model-1", name: "alpha" },
    { launchId: "lch_new", instanceId: "i2", model: "model-2", name: "beta", legacy: true },
  ]);
  assert.deepEqual(written.managers.llama, []);

  fs.rmSync(workingSetPath(world));
  await supervisor.stopComponent("vllm-manager", { wait: true });
  const saved = JSON.parse(fs.readFileSync(workingSetPath(world), "utf8"));
  assert.equal(saved.managers.vllm.length, 2, "the stop saved the set first");
  assert.ok(world.calls.some((call) => call[0] === "stop" && call[1] === "vllm-manager"));
});

function writeNightly(world, report, mtime) {
  const file = path.join(world.aiRoot, "artifacts", "nightly", "latest.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report));
  const seconds = new Date(mtime).getTime() / 1000;
  fs.utimesSync(file, seconds, seconds);
}

test("a failing nightly report emits one notification per report in the 00 §9.6 shape", async (t) => {
  const world = createWorld(t);
  writeNightly(world, { ok: false, passed: 10, failed: 2 }, "2026-10-14T03:00:00Z");
  const supervisor = world.create();
  await supervisor.start();
  await world.clock.flush(40);
  const nightly = () => world.notifications.filter((item) => item.kind === "nightly.failed");
  assert.equal(nightly().length, 1);
  const first = nightly()[0];
  assert.equal(first.severity, "error");
  assert.ok(first.title.zh && first.title.en && first.body.zh && first.body.en);
  assert.match(first.body.en, /failed 1 nights in a row/);
  assert.match(first.dedupeKey, /^nightly\.failed:/);
  assert.deepEqual(Object.keys(first).sort(), ["body", "dedupeKey", "kind", "severity", "title"]);

  // The same report on later ticks, and after a supervisor restart, stays quiet.
  await world.clock.advance(30 * 60 * 1000);
  assert.equal(nightly().length, 1);
  supervisor.close();
  const restarted = world.create();
  await restarted.start();
  await world.clock.flush(40);
  assert.equal(nightly().length, 1, "the report mtime is remembered across restarts");

  // A new failing report is a new notification; a passing one is not.
  writeNightly(world, { ok: false }, "2026-10-15T03:00:00Z");
  await world.clock.advance(10 * 60 * 1000 + 100);
  assert.equal(nightly().length, 2);
  writeNightly(world, { ok: true }, "2026-10-16T03:00:00Z");
  await world.clock.advance(10 * 60 * 1000 + 100);
  assert.equal(nightly().length, 2);
});

test("a backup older than 36 hours raises backup.stale once per backup", async (t) => {
  const world = createWorld(t);
  const stamp = "20261012-0300";
  const dir = path.join(world.aiRoot, "backups", stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "backup-manifest.json"), JSON.stringify({ format: "local-ai-platform-backup-v2", at: "2026-10-12T03:00:00Z", files: [] }));
  const supervisor = world.create();
  await supervisor.start();
  await world.clock.flush(40);
  await world.clock.advance(60 * 60 * 1000);
  const stale = world.notifications.filter((item) => item.kind === "backup.stale");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].severity, "warn");
  assert.match(stale[0].body.en, /hours old/);
});

function toastWorld(t, extra = {}) {
  const subscriptions = [];
  const entryClient = {
    request: async () => ({ status: 200, json: {} }),
    events(types, handler, options) {
      const subscription = { types, handler, options, closed: false, close() { this.closed = true; } };
      subscriptions.push(subscription);
      return subscription;
    },
  };
  const shown = [];
  const world = createWorld(t, { entryClient, runtimeOverrides: { "supervisor.notifications.toast": true, ...(extra.runtimeOverrides || {}) } });
  return { world, subscriptions, shown, showToast: async (toast) => { shown.push(toast); } };
}

test("toasts: one SSE subscription, warn/error or channels:toast only, platform-sourced envelopes ignored, dedupe for 10 min", async (t) => {
  const { world, subscriptions, shown, showToast } = toastWorld(t);
  const supervisor = world.create({ showToast, env: { PLATFORM_LANG: "en-US" } });
  await supervisor.start();
  await world.clock.flush(20);
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(subscriptions[0].types, ["notification", "platform"]);
  assert.equal(subscriptions[0].options.client, "supervisor");
  const send = (envelope) => subscriptions[0].handler(envelope);
  const data = (severity, extra = {}) => ({ kind: "alert.fired", severity, title: { zh: "标题", en: "Title" }, body: { zh: "内容", en: "Body" }, ...extra });

  send({ type: "notification", source: "telemetry", data: data("info") });
  assert.equal(shown.length, 0, "info is not toasted");
  send({ type: "notification", source: "telemetry", data: data("warn", { dedupeKey: "k1" }) });
  send({ type: "notification", source: "telemetry", data: data("error", { dedupeKey: "k1" }) });
  await world.clock.flush(10);
  assert.equal(shown.length, 1, "the dedupe key suppresses the repeat");
  assert.equal(shown[0].title.length > 0, true);
  send({ type: "notification", source: "telemetry", data: data("info", { channels: ["toast"] }) });
  await world.clock.flush(10);
  assert.equal(shown.length, 2, "channels:toast toasts any severity");
  send({ type: "platform", source: "entry", data: data("error") });
  await world.clock.flush(10);
  assert.equal(shown.length, 2, "only notification envelopes toast");

  await world.clock.advance(10 * 60 * 1000 + 1000);
  send({ type: "notification", source: "telemetry", data: data("warn", { dedupeKey: "k1" }) });
  await world.clock.flush(10);
  assert.equal(shown.length, 3, "after 10 minutes the key may toast again");
});

test("toast loop guard: a local notification is toasted once and its echo from the entry is ignored", async (t) => {
  const { world, subscriptions, shown, showToast } = toastWorld(t);
  writeNightly(world, { ok: false }, "2026-10-14T03:00:00Z");
  const supervisor = world.create({ showToast });
  await supervisor.start();
  await world.clock.flush(40);
  assert.equal(shown.length, 1, "toasted locally when raised");
  const local = world.notifications.find((item) => item.kind === "nightly.failed");
  // The entry bridge republishes it with source:"platform"; the supervisor ignores it.
  subscriptions[0].handler({ type: "notification", source: "platform", at: "2026-10-14T08:00:00Z", data: local });
  await world.clock.flush(20);
  assert.equal(shown.length, 1);
  // The same payload from any other source would have been a new toast (the guard is the source, not the content).
  subscriptions[0].handler({ type: "notification", source: "entry", data: { ...local, dedupeKey: "other" } });
  await world.clock.flush(20);
  assert.equal(shown.length, 2);
});

test("toasts stay off by default and the subscription follows the live setting", async (t) => {
  const quiet = createWorld(t, { entryClient: { events() { throw new Error("must not subscribe"); }, request: async () => ({ status: 200, json: {} }) } });
  const shown = [];
  writeNightly(quiet, { ok: false }, "2026-10-14T03:00:00Z");
  const supervisor = quiet.create({ showToast: async (toast) => { shown.push(toast); } });
  await supervisor.start();
  await quiet.clock.flush(40);
  assert.equal(shown.length, 0);
  assert.equal(quiet.notifications.filter((item) => item.kind === "nightly.failed").length, 1);
});

test("a re-exec successor announces itself and the old process leaves children running", async (t) => {
  const world = createWorld(t);
  const successor = world.create({ takeover: true });
  await successor.start();
  await world.clock.flush(20);
  const announced = world.notifications.filter((item) => item.kind === "supervisor.reexec");
  assert.equal(announced.length, 1);
  assert.equal(announced[0].severity, "info");

  const calls = [];
  const old = createWorld(t);
  const supervisor = old.create({
    closeControl: async () => calls.push("close"), spawnSupervisor: async () => calls.push("spawn"),
    waitForPipe: async () => true, exit: (code) => calls.push(["exit", code]),
  });
  await supervisor.startComponent("vllm-manager", { wait: true });
  const pid = supervisor.records.get("vllm-manager").pid;
  await supervisor.reexec();
  await old.clock.advance(100);
  assert.deepEqual(calls, ["close", "spawn", ["exit", 0]]);
  assert.ok(old.processes.has(pid), "the fake child survives the hand-off");
  assert.ok(!old.calls.some((call) => call[0] === "stop" || call[0] === "killTree"));
});
