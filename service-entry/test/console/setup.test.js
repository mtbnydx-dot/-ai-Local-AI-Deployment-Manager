// CON-25 (07 §6.14, 06 §8, §11): the pure parts of the first-run setup in Node,
// run against the real describeSetup() so the console reads exactly what the
// backend writes. Rendering, the step POSTs with operation progress, Skip, the
// back bar and the pre-06 checklist are covered in a browser by
// tests/frontend/console/console-setup.spec.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { mergeI18nAreas } = require("../../lib/console-routes.js");
const backend = require("../../../manager-core/platform/setup.js");
const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);

const model = await load("lib/setup-model.js");
const { createQueryCache } = await load("lib/store.js");
const { buildCommands } = await load("components/command-palette.js");
const { createI18n } = await load("lib/i18n.js");
const { ROUTES } = await load("routes.js");

const catalogs = mergeI18nAreas(path.join(CONSOLE_DIR, "i18n")).catalogs;

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "setup-test-"));
}

function describeFromBackend(aiRoot, checks = []) {
  return backend.describeSetup({ aiRoot, env: {}, lan: false, doctor: { checks }, statfs: () => ({ bavail: 1000, bsize: 1_000_000 }) });
}

test("the console knows the ten 06 §8 step ids in the backend's order", () => {
  assert.deepEqual([...model.SETUP_STEP_IDS], [...backend.STEP_IDS]);
});

test("normalizeSetup reads the backend's describeSetup() answer: ten steps, titles in both languages, live status", () => {
  const root = tempRoot();
  try {
    const setup = model.normalizeSetup(describeFromBackend(root, [{ id: "env.node-version", status: "ok", detail: "ok" }]));
    assert.equal(setup.steps.length, 10);
    assert.deepEqual(setup.steps.map((step) => step.id), model.SETUP_STEP_IDS);
    assert.equal(setup.steps[0].title["en-US"], "Check prerequisites");
    assert.equal(setup.steps[0].title["zh-CN"], "检查环境");
    assert.equal(setup.steps.find((step) => step.id === "ops").optional, true);
    assert.deepEqual(setup.steps.find((step) => step.id === "ops").data.commands.length, 3);
    assert.equal(setup.completedAt, null);
    assert.equal(setup.current, "deps", "prereq passes, so deps is the first open step");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeSetup keeps blocking prerequisites with their manual fix and drops unknown statuses to todo", () => {
  const setup = model.normalizeSetup({
    steps: [
      { id: "prereq", status: "blocked", detail: "1 blocking", data: { blocking: [{ id: "runtime.docker-daemon", detail: "not running", fix: { id: "start-docker", risk: "manual", command: "start Docker Desktop" } }] } },
      { id: "deps", status: "from-the-future" },
      { id: "x", status: "done" },
      "junk",
      { status: "done" },
    ],
    completedAt: null,
  });
  assert.deepEqual(setup.steps.map((step) => [step.id, step.status]), [["prereq", "blocked"], ["deps", "todo"], ["x", "done"]]);
  assert.equal(setup.steps[0].data.blocking[0].fix.command, "start Docker Desktop");
  assert.equal(model.normalizeSetup(null).steps.length, 0);
  assert.equal(model.normalizeSetup({ steps: [{ id: "a", status: "done" }], current: "nope" }).current, null);
});

test("setupIncomplete: only a missing completedAt with an open step counts", () => {
  const open = model.normalizeSetup({ steps: [{ id: "a", status: "done" }, { id: "b", status: "todo" }] });
  const settled = model.normalizeSetup({ steps: [{ id: "a", status: "done" }, { id: "b", status: "skipped" }] });
  const complete = model.normalizeSetup({ steps: [{ id: "a", status: "todo" }], completedAt: "2026-10-16T00:00:00.000Z" });
  assert.equal(model.setupIncomplete(open), true);
  assert.equal(model.setupIncomplete(settled), false);
  assert.equal(model.setupIncomplete(complete), false);
  assert.equal(model.setupIncomplete(model.normalizeSetup({ steps: [] })), false);
  assert.equal(model.setupIncomplete(null), false);
  assert.deepEqual(model.setupProgress(open), { settled: 1, total: 2 });
  assert.equal(open.current, "b");
});

test("every step has one primary action; ops only shows commands and never posts", () => {
  assert.deepEqual(model.SETUP_STEP_IDS.map((id) => model.stepPlan(id).kind), ["post", "post", "post", "link", "post", "post", "post", "mark", "post", "link"]);
  assert.equal(model.stepRunsOperation("ops"), false);
  assert.equal(model.stepRunsOperation("storage"), false);
  assert.equal(model.stepRunsOperation("images"), true);
  assert.equal(model.stepPlan("storage").href, "/models/storage?from=setup");
  assert.equal(model.stepPlan("first-model").href, "/deployments/new?from=setup");
});

test("stepRequest sends what the backend validates: engines for images, a mode for exposure, an empty body otherwise", () => {
  assert.deepEqual(model.stepRequest("images", { engines: ["llama", "bogus", "vllm"] }), { path: "/api/platform/setup/images", body: { engines: ["vllm", "llama"] } });
  assert.deepEqual(model.stepRequest("images", { engines: [] }).body, { engines: ["vllm"] });
  assert.deepEqual(model.stepRequest("exposure", { mode: "lan" }).body, { mode: "lan" });
  assert.deepEqual(model.stepRequest("exposure", { mode: "public" }).body, { mode: "local" });
  assert.deepEqual(model.stepRequest("deps"), { path: "/api/platform/setup/deps", body: {} });
  assert.deepEqual(model.skipRequest("tts"), { path: "/api/platform/setup/tts", body: { skip: true } });
  assert.deepEqual(model.doneRequest("ops"), { path: "/api/platform/setup/ops", body: { done: true } });
  assert.deepEqual(model.skipAllRequest(), { path: "/api/platform/setup/all", body: { skip: true } });
});

test("the requests pass the backend's own validation", async () => {
  const root = tempRoot();
  try {
    const runner = backend.createSetupRunner({ aiRoot: root, env: {} });
    for (const id of model.SETUP_STEP_IDS) {
      for (const request of [model.stepRequest(id, { engines: ["vllm", "llama"], mode: "local" }), model.skipRequest(id), model.doneRequest(id)]) {
        const plan = await runner.prepare(id, request.body);
        assert.equal(plan.step, id);
      }
    }
    assert.equal((await runner.prepare("all", model.skipAllRequest().body)).step, "all");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Skip persists in the backend's setup.json and the next read has every step settled and completedAt set", async () => {
  const root = tempRoot();
  try {
    const runner = backend.createSetupRunner({ aiRoot: root, env: {} });
    await runner.runStep("all", model.skipAllRequest().body, {});
    const setup = model.normalizeSetup(describeFromBackend(root));
    assert.equal(model.setupIncomplete(setup), false);
    assert.ok(setup.steps.every((step) => step.status === "skipped" || step.status === "done"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setupHref adds from=setup and keeps the rest of the query", () => {
  assert.equal(model.setupHref("/models/storage"), "/models/storage?from=setup");
  assert.equal(model.setupHref("/access?tab=keys"), "/access?tab=keys&from=setup");
  assert.equal(model.isFromSetup({ from: "setup" }), true);
  assert.equal(model.isFromSetup({ from: "vllm" }), false);
  assert.equal(model.isFromSetup(undefined), false);
});

test("the first model opens the Deploy wizard seeded with a library folder, or the plain wizard when the library is empty", () => {
  assert.equal(model.firstModelHref([]), "/deployments/new?from=setup");
  assert.equal(model.firstModelHref(undefined), "/deployments/new?from=setup");
  assert.equal(model.firstModelHref([{ kind: "file", path: "X:/a.gguf" }, { kind: "folder", path: "X:/models/Qwen3-8B" }]), `/deployments/new?model=${encodeURIComponent("X:/models/Qwen3-8B")}&from=setup`);
});

test("image-pull jobs: only running pulls, with byte progress when the job reports totals", () => {
  const jobs = [
    { id: "dl_1", type: "image-pull", state: "running", progress: { percent: 40, bytesDone: 400, bytesTotal: 1000 }, meta: { runtimeId: "vllm-default" } },
    { id: "dl_2", type: "image-pull", state: "success", progress: { percent: 100 } },
    { id: "dl_3", type: "download", state: "running" },
    { id: "dl_4", type: "image-pull", state: "running", progress: {}, meta: { image: "example/engine:1" } },
  ];
  const running = model.imagePullJobs({ jobs });
  assert.deepEqual(running.map((job) => job.id), ["dl_1", "dl_4"]);
  assert.deepEqual([running[0].percent, running[0].bytesDone, running[0].bytesTotal], [40, 400, 1000]);
  assert.deepEqual([running[1].percent, running[1].bytesTotal, running[1].label], [null, null, "example/engine:1"]);
  assert.deepEqual(model.imagePullJobs(null), []);
  assert.deepEqual(model.pullManagers(["sglang", "vllm"]), ["vllm"]);
  assert.deepEqual(model.pullManagers(["llama", "vllm"]), ["llama", "vllm"]);
  assert.deepEqual(model.pullManagers([]), ["vllm"]);
});

test("pre-06 checklist: five items from /api/status, /api/fleet, the library and /api/keys; a failed call reads unknown", () => {
  const ok = model.buildChecklist({
    status: { ok: true, managers: [{ id: "vllm", ok: true }] },
    fleet: { gpuMemory: { totalMb: 24000 }, instances: [{ id: "vllm:primary", lifecycleState: "ready", running: true, models: [{ id: "m" }] }] },
    library: { entries: [{ id: "lib_1" }], total: 1 },
    keys: { keys: { clients: [{ id: "k1", state: "active" }] } },
  });
  assert.deepEqual(ok.map((item) => [item.id, item.state]), [["docker", "ok"], ["gpu", "ok"], ["model", "ok"], ["serving", "ok"], ["key", "ok"]]);
  const empty = model.buildChecklist({
    status: { ok: true, managers: [{ id: "vllm", ok: false }] },
    fleet: { instances: [{ id: "vllm:primary", lifecycleState: "stopped", running: false, models: [] }] },
    library: { entries: [], total: 0 },
    keys: { keys: { clients: [] } },
  });
  assert.deepEqual(empty.map((item) => item.state), ["todo", "todo", "todo", "todo", "todo"]);
  const unknown = model.buildChecklist({});
  assert.deepEqual(unknown.map((item) => item.state), ["unknown", "unknown", "unknown", "unknown", "unknown"]);
  assert.deepEqual(ok.map((item) => item.id), [...model.CHECKLIST_ITEMS]);
  assert.ok(ok.every((item) => item.href.startsWith("/")));
});

function fakeApi(answer) {
  const calls = [];
  return { calls, get: async (path) => { calls.push(path); if (answer instanceof Error) throw answer; return answer; } };
}

const incomplete = { steps: [{ id: "prereq", status: "done" }, { id: "deps", status: "todo" }], completedAt: null };
const owner = { role: "owner", bootstrap: { features: { setup: true } }, prefs: { get: () => false } };

test("boot step 8 routes only an owner, with the setup backend, not dismissed, whose setup is incomplete", async () => {
  const run = (overrides, answer = incomplete) => {
    const api = fakeApi(answer);
    return model.firstRunTarget({ ...owner, ...overrides, api, cache: createQueryCache() }).then((target) => ({ target, calls: api.calls }));
  };
  assert.deepEqual(await run({}), { target: "/setup", calls: ["/api/platform/setup"] });
  assert.deepEqual(await run({ role: "viewer" }), { target: null, calls: [] });
  assert.deepEqual(await run({ role: "none" }), { target: null, calls: [] });
  assert.deepEqual(await run({ bootstrap: { features: { setup: false } } }), { target: null, calls: [] });
  assert.deepEqual(await run({ prefs: { get: (name) => name === "dismissedSetup" } }), { target: null, calls: [] });
  assert.deepEqual(await run({}, { ...incomplete, completedAt: "2026-10-16T00:00:00.000Z" }), { target: null, calls: ["/api/platform/setup"] });
  assert.deepEqual(await run({}, { steps: [{ id: "a", status: "skipped" }], completedAt: null }), { target: null, calls: ["/api/platform/setup"] });
  const failing = await run({}, Object.assign(new Error("down"), { code: "setup_unavailable" }));
  assert.equal(failing.target, null, "an unreadable setup never routes");
});

test("first-run routing applies on the landing pages only", () => {
  assert.equal(model.isLandingPath("/"), true);
  assert.equal(model.isLandingPath("/overview"), true);
  assert.equal(model.isLandingPath("/deployments"), false);
  assert.equal(model.isLandingPath("/setup"), false);
});

test("the /setup route is owner-only and the palette and strip give a way back in", () => {
  const route = ROUTES.find((item) => item.name === "setup");
  assert.equal(route.path, "/setup");
  assert.equal(route.ownerOnly, true);
  const i18n = createI18n({ locale: "en-US", catalog: catalogs["en-US"] });
  const commands = buildCommands({ role: "owner", i18n });
  assert.equal(commands.find((command) => command.id === "action:setup")?.href, "/setup");
  assert.equal(buildCommands({ role: "viewer", i18n }).some((command) => command.id === "action:setup"), false);
});

test("every platform.setup key the page needs has an English and a Chinese string, and the step copy covers all ten steps", () => {
  for (const locale of ["en-US", "zh-CN"]) {
    for (const id of model.SETUP_STEP_IDS) {
      assert.ok(catalogs[locale][`platform.setup.explain.${id}`], `${locale} explain.${id}`);
      assert.ok(catalogs[locale][`platform.setup.action.${id}`], `${locale} action.${id}`);
    }
    for (const status of model.SETUP_STATUSES) assert.ok(catalogs[locale][`platform.setup.status.${status}`], `${locale} status.${status}`);
    for (const id of model.CHECKLIST_ITEMS) {
      assert.ok(catalogs[locale][`platform.setup.check.${id}`], `${locale} check.${id}`);
      assert.ok(catalogs[locale][`platform.setup.checkHint.${id}`], `${locale} checkHint.${id}`);
    }
  }
});
