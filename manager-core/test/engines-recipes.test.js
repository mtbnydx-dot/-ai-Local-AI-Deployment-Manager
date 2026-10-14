"use strict";

// Recipes as data (01-engines §10): the loader and its reload, matching,
// applyRecipe (locks, blocks, env and host-fact inputs), the legacy preset and
// profile shims over the PRE-*/P-* goldens, the reload route and the debounced
// fs.watch fallback. Temp directories only; no manager service is touched.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const harness = require("./helpers/engine-golden-stubs");

harness.prepareGoldenEnvironment();
const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-recipes-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("../index");

const { engines } = core;
const recipes = engines.recipes;

function tempDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-recipes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

function newStore(t, files = {}, extra = {}) {
  const overrideDir = tempDir(t, files);
  const registry = engines.createEngineRegistry({ overrideDir: tempDir(t), env: {} });
  return { store: recipes.createRecipeStore({ registry, overrideDir, ...extra }), overrideDir };
}

function minimalRecipe(id, extra = {}) {
  return {
    schemaVersion: 1,
    asOf: "2026-10-14",
    staleAfterDays: 180,
    id,
    kind: "model",
    status: "experimental",
    label: { zh: `测试 ${id}`, en: `Test ${id}` },
    engineId: "sglang",
    values: {},
    ...extra,
  };
}

const DIGEST_A = "a".repeat(64);

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

test("the bundled recipes load without errors: 11 model and 10 scenario, sorted by id", (t) => {
  const { store } = newStore(t);
  const loaded = recipes.loadRecipes(store);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.recipes.length, 21);
  assert.deepEqual(loaded.recipes.map((recipe) => recipe.id), loaded.recipes.map((recipe) => recipe.id).sort());
  assert.equal(store.list({ kind: "model" }).length, 11);
  assert.equal(store.list({ kind: "scenario" }).length, 10);
  assert.deepEqual(store.list({ kind: "scenario", managerId: "llama" }).map((recipe) => recipe.id).sort(), [
    "scenario-llama-96gb-single-256k",
    "scenario-llama-hetero-256k-max",
    "scenario-llama-hetero-64k-safe",
    "scenario-llama-openwebui-daily",
    "scenario-llama-single-gpu-debug",
  ]);
  assert.deepEqual(store.list({ engineId: "sglang", kind: "model" }).map((recipe) => recipe.id).sort(), [
    "pennyroyal-v251",
    "qwen38-dspark-sglang",
    "qwen38-flashnext-262k",
    "qwen38-sglang",
  ]);
  assert.match(store.digest(), /^sha256:[0-9a-f]{64}$/);
  assert.equal(store.sourceOf("pennyroyal-v251"), "bundled");
  assert.equal(store.get("no-such-recipe"), null);
});

test("a loaded recipe is frozen, so a held snapshot cannot be edited by a caller", (t) => {
  const { store } = newStore(t);
  const recipe = store.get("qwen38-flashnext-262k");
  assert.equal(Object.isFrozen(recipe), true);
  assert.equal(Object.isFrozen(recipe.values), true);
  assert.throws(() => { "use strict"; recipe.label.en = "changed"; }, TypeError);
});

test("an override file deep-merges over its bundled recipe and a new id is a new recipe", (t) => {
  const { store } = newStore(t, {
    "flashnext.json": { id: "qwen38-flashnext-262k", label: { en: "Owner label", zh: "自定义" }, values: { "sglang.pageSize": 32 } },
    "mine.json": minimalRecipe("owner-sglang", { values: { "sglang.pageSize": 16 } }),
  });
  const merged = store.get("qwen38-flashnext-262k");
  assert.equal(merged.label.en, "Owner label");
  assert.equal(merged.values["sglang.pageSize"], 32);
  assert.equal(merged.values["sglang.chunkedPrefillSize"], 4096, "values not named by the override are kept");
  assert.equal(merged.engineId, "sglang");
  assert.equal(store.sourceOf("qwen38-flashnext-262k"), "override");
  assert.equal(store.get("owner-sglang").values["sglang.pageSize"], 16);
  assert.equal(store.sourceOf("owner-sglang"), "override");
  assert.deepEqual(store.errors(), []);
  assert.equal(store.list().length, 22);
});

test("extends merges the parent recipe but not its profile, and a bundled child keeps its own", (t) => {
  const { store } = newStore(t, {
    "child.json": {
      schemaVersion: 1, asOf: "2026-10-14", staleAfterDays: 180, id: "owner-child", kind: "model", status: "experimental",
      label: { zh: "子配方", en: "Child" }, extends: "qwen38-flashnext-262k", values: { "sglang.pageSize": 16 },
    },
  });
  const child = store.get("owner-child");
  assert.equal(child.engineId, "sglang");
  assert.equal(child.values["sglang.pageSize"], 16);
  assert.equal(child.values["sglang.fp4GemmBackend"], "flashinfer_cutlass", "the parent's values are inherited");
  assert.equal(child.profile, undefined, "a profile is not inherited");
  assert.deepEqual(store.errors(), []);
  // qwen38-dspark-sglang extends qwen38-sglang in the bundle and has its own profile.
  assert.equal(store.get("qwen38-dspark-sglang").profile.id, "qwen38-sglang-dspark-fastest");
});

test("extends with an unknown parent, a cycle or a too-deep chain fails that recipe only", (t) => {
  const child = (id, parent) => ({
    schemaVersion: 1, asOf: "2026-10-14", staleAfterDays: 180, id, kind: "model", status: "experimental",
    label: { zh: id, en: id }, engineId: "sglang", extends: parent,
  });
  const { store } = newStore(t, {
    "orphan.json": child("orphan", "does-not-exist"),
    "a.json": child("cycle-a", "cycle-b"),
    "b.json": child("cycle-b", "cycle-a"),
    "l1.json": child("level-1", "qwen38-sglang"),
    "l2.json": child("level-2", "level-1"),
    "l3.json": child("level-3", "level-2"),
    "l4.json": child("level-4", "level-3"),
    "l5.json": child("level-5", "level-4"),
    "l6.json": child("level-6", "level-5"),
  });
  assert.equal(store.get("orphan"), null);
  assert.equal(store.get("cycle-a"), null);
  assert.equal(store.get("cycle-b"), null);
  assert.ok(store.get("level-1"));
  assert.ok(store.get("level-4"));
  assert.equal(store.get("level-6"), null, "more than four levels deep");
  const codes = new Set(store.errors().map((error) => error.code));
  assert.ok(codes.has("extends_unknown"));
  assert.ok(codes.has("extends_cycle"));
  assert.ok(codes.has("extends_too_deep"));
  assert.ok(store.get("qwen38-flashnext-262k"), "unrelated recipes still load");
});

test("an invalid override keeps the bundled recipe and is reported in errors[]", (t) => {
  const { store } = newStore(t, {
    "bad.json": { id: "qwen38-flashnext-262k", values: { "sglang.noSuchParam": 1 } },
    "garbage.json": "{ not json",
    "noid.json": { label: "x" },
  });
  const flashnext = store.get("qwen38-flashnext-262k");
  assert.equal(flashnext.values["sglang.pageSize"], 64, "the bundled version is served");
  assert.equal(store.sourceOf("qwen38-flashnext-262k"), "bundled");
  const byFile = Object.fromEntries(store.errors().map((error) => [error.file, error]));
  assert.equal(byFile["bad.json"].code, "unknown_param");
  assert.equal(byFile["bad.json"].origin, "override");
  assert.equal(byFile["garbage.json"].code, "invalid_json");
  assert.equal(byFile["noid.json"].code, "invalid_id");
  assert.equal(store.errors().every((error) => error.source === "recipes"), true);
});

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

test("reloadRecipes keeps the last good version of an invalid file and reports it", (t) => {
  const { store, overrideDir } = newStore(t, {
    "mine.json": minimalRecipe("owner-sglang", { values: { "sglang.pageSize": 16 } }),
  });
  const file = path.join(overrideDir, "mine.json");
  assert.equal(store.get("owner-sglang").values["sglang.pageSize"], 16);
  const held = store.snapshot();

  // A good edit is picked up.
  fs.writeFileSync(file, JSON.stringify(minimalRecipe("owner-sglang", { values: { "sglang.pageSize": 32 } })));
  const first = recipes.reloadRecipes(store);
  assert.deepEqual({ ok: first.ok, count: first.count, errors: first.errors }, { ok: true, count: 22, errors: [] });
  assert.equal(store.get("owner-sglang").values["sglang.pageSize"], 32);
  assert.notEqual(first.digest, held.digest);
  assert.equal(held.recipes.get("owner-sglang").values["sglang.pageSize"], 16, "a snapshot held by an in-flight plan never changes");

  // A schema error keeps the previous good version.
  fs.writeFileSync(file, JSON.stringify(minimalRecipe("owner-sglang", { values: { "sglang.noSuchParam": 1 } })));
  const bad = recipes.reloadRecipes(store);
  assert.equal(bad.ok, false);
  assert.equal(bad.count, 22);
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0].file, "mine.json");
  assert.equal(bad.errors[0].code, "unknown_param");
  assert.equal(store.get("owner-sglang").values["sglang.pageSize"], 32);
  assert.equal(bad.digest, first.digest, "the served set did not change");

  // Broken JSON keeps it too.
  fs.writeFileSync(file, "{ truncated");
  const broken = recipes.reloadRecipes(store);
  assert.equal(broken.ok, false);
  assert.equal(broken.errors[0].code, "invalid_json");
  assert.equal(store.get("owner-sglang").values["sglang.pageSize"], 32);
  assert.deepEqual(store.errors().map((error) => error.code), ["invalid_json"]);

  // A fix clears the error; deleting the file removes the recipe.
  fs.writeFileSync(file, JSON.stringify(minimalRecipe("owner-sglang", { values: { "sglang.pageSize": 64 } })));
  assert.equal(recipes.reloadRecipes(store).ok, true);
  assert.equal(store.get("owner-sglang").values["sglang.pageSize"], 64);
  fs.unlinkSync(file);
  const gone = recipes.reloadRecipes(store);
  assert.deepEqual({ ok: gone.ok, count: gone.count }, { ok: true, count: 21 });
  assert.equal(store.get("owner-sglang"), null);
});

test("an invalid first version of an override leaves the bundled recipe alone, and a later fix applies", (t) => {
  const { store, overrideDir } = newStore(t, {
    "flashnext.json": { id: "qwen38-flashnext-262k", values: { "sglang.noSuchParam": 1 } },
  });
  assert.equal(store.errors().length, 1);
  assert.equal(store.get("qwen38-flashnext-262k").values["sglang.pageSize"], 64);
  fs.writeFileSync(path.join(overrideDir, "flashnext.json"), JSON.stringify({ id: "qwen38-flashnext-262k", values: { "sglang.pageSize": 128 } }));
  assert.equal(store.reload().ok, true);
  assert.equal(store.get("qwen38-flashnext-262k").values["sglang.pageSize"], 128);
  // Now a broken edit falls back to the override that last validated, not to the bundle.
  fs.writeFileSync(path.join(overrideDir, "flashnext.json"), JSON.stringify({ id: "qwen38-flashnext-262k", values: { "sglang.noSuchParam": 1 } }));
  const result = store.reload();
  assert.equal(result.ok, false);
  assert.equal(store.get("qwen38-flashnext-262k").values["sglang.pageSize"], 128);
});

test("two override files with one id: the first (by name) wins and the second is reported", (t) => {
  const { store } = newStore(t, {
    "a.json": minimalRecipe("owner-twice", { values: { "sglang.pageSize": 16 } }),
    "b.json": minimalRecipe("owner-twice", { values: { "sglang.pageSize": 32 } }),
  });
  assert.equal(store.get("owner-twice").values["sglang.pageSize"], 16);
  assert.deepEqual(store.errors().map((error) => `${error.file}:${error.code}`), ["b.json:duplicate_recipe"]);
});

test("a missing override directory is not an error and a file over 256 KiB is refused", (t) => {
  const registry = engines.createEngineRegistry({ overrideDir: tempDir(t), env: {} });
  const missing = recipes.createRecipeStore({ registry, overrideDir: path.join(tempDir(t), "not-created") });
  assert.deepEqual(missing.errors(), []);
  assert.equal(missing.list().length, 21);
  const { store } = newStore(t, { "huge.json": JSON.stringify({ id: "owner-huge", pad: "x".repeat(300 * 1024) }) });
  assert.deepEqual(store.errors().map((error) => error.code), ["recipe_too_large"]);
});

// ---------------------------------------------------------------------------
// Watcher (fake fs.watch and timers)
// ---------------------------------------------------------------------------

function fakeWatch() {
  const state = { handlers: [], closed: 0, watchedDir: null, throwWith: null, errorHandler: null };
  const watch = (dir, options, handler) => {
    if (state.throwWith) throw state.throwWith;
    state.watchedDir = dir;
    state.handlers.push(handler);
    return {
      close() { state.closed += 1; },
      on(event, listener) { if (event === "error") state.errorHandler = listener; },
    };
  };
  const emit = (event = "change", name = "x.json") => state.handlers.forEach((handler) => handler(event, name));
  return { state, watch, emit };
}

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = nextId++; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    get pending() { return pending.size; },
    delays() { return [...pending.values()].map((item) => item.ms); },
    flush() { const items = [...pending.values()]; pending.clear(); items.forEach((item) => item.fn()); return items.length; },
  };
}

test("the watcher debounces a burst of events into one reload", (t) => {
  const { store, overrideDir } = newStore(t, { "mine.json": minimalRecipe("owner-sglang", { values: { "sglang.pageSize": 16 } }) });
  let reloads = 0;
  const realReload = store.reload;
  store.reload = () => { reloads += 1; return realReload(); };
  const fake = fakeWatch();
  const timers = fakeTimers();
  const seen = [];
  const watcher = recipes.watchRecipeOverrides({ store, watch: fake.watch, timers, onReload: (result) => seen.push(result) });
  assert.equal(fake.state.watchedDir, overrideDir);
  assert.equal(watcher.watching, true);

  fs.writeFileSync(path.join(overrideDir, "mine.json"), JSON.stringify(minimalRecipe("owner-sglang", { values: { "sglang.pageSize": 32 } })));
  fake.emit("change");
  fake.emit("rename");
  fake.emit("change");
  assert.equal(timers.pending, 1, "each event restarts the one pending timer");
  assert.deepEqual(timers.delays(), [1000], "1 s debounce by default");
  assert.equal(reloads, 0);
  assert.equal(store.get("owner-sglang").values["sglang.pageSize"], 16);

  assert.equal(timers.flush(), 1);
  assert.equal(reloads, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, true);
  assert.equal(store.get("owner-sglang").values["sglang.pageSize"], 32);

  fake.emit("change");
  assert.equal(timers.flush(), 1);
  assert.equal(reloads, 2);

  watcher.close();
  fake.emit("change");
  assert.equal(timers.pending, 0, "a closed watcher schedules nothing");
  assert.equal(fake.state.closed, 1);
  assert.equal(watcher.watching, false);
});

test("the watcher honours debounceMs, logs an invalid file in one line and survives reload errors", (t) => {
  const { store, overrideDir } = newStore(t, { "mine.json": minimalRecipe("owner-sglang") });
  const fake = fakeWatch();
  const timers = fakeTimers();
  const logs = [];
  const watcher = recipes.watchRecipeOverrides({ store, watch: fake.watch, timers, debounceMs: 250, log: (line) => logs.push(line) });
  fs.writeFileSync(path.join(overrideDir, "mine.json"), "{ nope");
  fake.emit("change");
  assert.deepEqual(timers.delays(), [250]);
  timers.flush();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /kept the last good recipes/);
  assert.ok(store.get("owner-sglang"), "the last good version is still served");

  store.reload = () => { throw new Error("disk gone"); };
  fake.emit("change");
  timers.flush();
  assert.equal(logs.length, 2);
  assert.match(logs[1], /reload failed: disk gone/);
  watcher.close();
});

test("a watch error logs one line and stops the watcher; a missing directory is simply not watched", (t) => {
  const { store } = newStore(t);
  const fake = fakeWatch();
  const logs = [];
  const watcher = recipes.watchRecipeOverrides({ store, watch: fake.watch, timers: fakeTimers(), log: (line) => logs.push(line) });
  fake.state.errorHandler(new Error("EPERM: watch failed"));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /stopped: EPERM/);
  assert.equal(watcher.watching, false);
  assert.equal(fake.state.closed, 1);
  watcher.close();

  const absent = fakeWatch();
  absent.state.throwWith = Object.assign(new Error("no such directory"), { code: "ENOENT" });
  const quietLogs = [];
  const quiet = recipes.watchRecipeOverrides({ store, watch: absent.watch, timers: fakeTimers(), log: (line) => quietLogs.push(line) });
  assert.equal(quiet.watching, false);
  assert.deepEqual(quietLogs, []);
  quiet.trigger();
  quiet.close();

  const denied = fakeWatch();
  denied.state.throwWith = Object.assign(new Error("denied"), { code: "EACCES" });
  const deniedLogs = [];
  recipes.watchRecipeOverrides({ store, watch: denied.watch, timers: fakeTimers(), log: (line) => deniedLogs.push(line) }).close();
  assert.equal(deniedLogs.length, 1);
});

test("the real fs.watch fallback reloads after a hand edit", async (t) => {
  const { store, overrideDir } = newStore(t);
  let watcher = null;
  const reloaded = new Promise((resolve) => {
    watcher = recipes.watchRecipeOverrides({ store, debounceMs: 20, onReload: (result) => resolve(result) });
    setTimeout(() => fs.writeFileSync(path.join(overrideDir, "mine.json"), JSON.stringify(minimalRecipe("owner-watched"))), 20);
  });
  t.after(() => watcher.close());
  const result = await Promise.race([reloaded, new Promise((resolve) => setTimeout(() => resolve(null), 5000).unref())]);
  if (result === null) return t.skip("fs.watch delivered no event in this environment");
  assert.equal(result.ok, true);
  assert.ok(store.get("owner-watched"));
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test("matchRecipes scores contentDigest above familyId above quant and filters by runtimeId", (t) => {
  const runtimeId = engines.createEngineRegistry({ env: {} }).resolveRuntime("sglang", { manifestKey: "sglangFlashNext" }).runtimeId;
  const { store } = newStore(t, {
    "digest.json": minimalRecipe("t-digest", { match: { contentDigest: DIGEST_A } }),
    "family.json": minimalRecipe("t-family", { match: { familyId: "test-family" } }),
    "quant.json": minimalRecipe("t-quant", { match: { quant: ["nvfp4"] } }),
    "runtime.json": minimalRecipe("t-runtime", { runtime: { ref: "sglangFlashNext" }, match: { runtimeId } }),
  });
  assert.deepEqual(store.errors(), []);
  const rank = (model, extra = {}) => recipes.matchRecipes({ engineId: "sglang", model, ...extra }, store);
  const find = (ranked, id) => ranked.find((item) => item.recipe.id === id);

  const exact = rank({ contentDigest: `sha256:${DIGEST_A}`, familyId: "test-family", quantMethod: "nvfp4" });
  assert.equal(find(exact, "t-digest").eligible, true);
  assert.equal(find(exact, "t-digest").score, recipes.SCORES.contentDigest);
  assert.equal(find(exact, "t-family").score, recipes.SCORES.familyId);
  assert.equal(find(exact, "t-quant").score, recipes.SCORES.quant);
  assert.ok(find(exact, "t-digest").score > find(exact, "t-family").score);
  assert.ok(find(exact, "t-family").score > find(exact, "t-quant").score);
  assert.deepEqual(find(exact, "t-digest").reasons, ["content_digest"]);

  const other = rank({ familyId: "other-family", quantMethod: "awq" });
  assert.equal(find(other, "t-digest").eligible, false);
  assert.deepEqual(find(other, "t-digest").reasons, ["content_digest_mismatch"]);
  assert.equal(find(other, "t-family").eligible, false);
  assert.equal(find(other, "t-quant").eligible, true, "quant alone is a score, not a gate");
  assert.equal(find(other, "t-quant").score, 0);

  const pinned = rank({}, { runtime: { runtimeId, manifestKey: "sglangFlashNext" } });
  assert.equal(find(pinned, "t-runtime").eligible, true);
  assert.equal(find(pinned, "t-runtime").score, recipes.SCORES.runtime);
  const wrong = rank({}, { runtime: { runtimeId: "sglang@0.5.17", manifestKey: "sglang" } });
  assert.equal(find(wrong, "t-runtime").eligible, false);
  assert.deepEqual(find(wrong, "t-runtime").reasons, ["runtime_mismatch"]);
  assert.equal(find(rank({}), "t-runtime").eligible, false, "no effective runtime");

  // Eligible recipes come first.
  const flags = exact.map((item) => Number(item.eligible));
  assert.deepEqual(flags, [...flags].sort((a, b) => b - a));
});

test("matchRecipes: capabilityIds count like familyId, hardware matches add their score, scenarios never match", () => {
  const store = recipes.getRecipeStore();
  const ranked = recipes.matchRecipes({
    engineId: "sglang",
    model: { capabilityIds: ["qwen3.8", "qwen3.8-flash-next"], quantMethod: "nvfp4" },
    hostFacts: { platform: "win32", maxComputeCap: "12.0", maxGpuMemoryGb: 96 },
    runtime: { runtimeId: "sglang@qwen38flashnext-sm120-dac5523d", manifestKey: "sglangFlashNext" },
  }, store);
  const top = ranked[0];
  assert.equal(top.recipe.id, "qwen38-flashnext-262k");
  assert.equal(top.eligible, true);
  const { SCORES } = recipes;
  assert.equal(top.score, SCORES.capabilityIds + SCORES.quant + SCORES.sm + SCORES.memory + SCORES.runtime + SCORES.verified);
  assert.ok(top.reasons.includes("capability") && top.reasons.includes("compute_capability") && top.reasons.includes("gpu_memory"));
  assert.equal(ranked.some((item) => item.recipe.kind === "scenario"), false);

  const smallHost = recipes.matchRecipes({
    engineId: "sglang",
    model: { capabilityIds: ["qwen3.8-flash-next"], quantMethod: "nvfp4" },
    hostFacts: { maxComputeCap: "8.9", maxGpuMemoryGb: 24 },
  }, store).find((item) => item.recipe.id === "qwen38-flashnext-262k");
  assert.equal(smallHost.eligible, true, "hardware is a score, the launch plan decides about fit");
  assert.ok(smallHost.reasons.includes("compute_capability_low") && smallHost.reasons.includes("gpu_memory_low"));
  assert.ok(smallHost.score < top.score);

  const unknown = recipes.matchRecipes({ engineId: "sglang", model: {} }, store);
  assert.equal(unknown.some((item) => item.eligible && item.recipe.match?.capabilityIds), false);
});

// ---------------------------------------------------------------------------
// applyRecipe
// ---------------------------------------------------------------------------

test("applyRecipe: recipe values, user values, derived values and locks with provenance", () => {
  const recipe = recipes.getRecipeStore().get("qwen38-flashnext-262k");
  const plain = recipes.applyRecipe(recipe, {}, { hostFacts: { platform: "win32" } });
  assert.equal(plain.values["sglang.maxTotalTokens"], 262144);
  assert.equal(plain.values["sglang.maxRunningRequests"], 1);
  assert.equal(plain.values.reasoningParser, "qwen3");
  assert.equal(plain.provenance.reasoningParser, "lock");
  assert.equal(plain.provenance["sglang.pageSize"], "recipe");
  assert.deepEqual(plain.blocks, []);
  assert.deepEqual(plain.overrides, []);
  assert.equal(plain.memory.policy, "static-fraction-of-free");
  assert.equal(plain.status, "verified");

  const user = recipes.applyRecipe(recipe, { contextLength: 100000, reasoningParser: "other", "speculative.method": "mtp" }, {});
  assert.equal(user.values["sglang.maxTotalTokens"], 100000, "the user's context length feeds the derived token budget");
  assert.equal(user.values.reasoningParser, "qwen3", "a lock wins over the user");
  assert.deepEqual(user.overrides.map((item) => [item.param, item.code, item.user, item.value]), [["reasoningParser", "recipe_locked", "other", "qwen3"]]);
  assert.deepEqual(user.blocks.map((block) => block.code), ["recipe_requires_speculative_off"], "blockIf");
  assert.match(user.blocks[0].message.en, /requires speculative decoding off/);
  assert.equal(recipes.applyRecipe(recipe, { reasoningParser: "qwen3" }, {}).overrides.length, 0, "a user value equal to the lock is no override");
});

test("applyRecipe reports retired and unsupported recipes as blocks", () => {
  const store = recipes.getRecipeStore();
  const dspark = store.get("qwen38-dspark-vllm");
  assert.equal(dspark.status, "blocked");
  assert.deepEqual(recipes.applyRecipe(dspark, {}, {}).blocks.map((block) => block.code), ["vllm_dspark_wsl_unsupported"]);
  const muse = store.get("llama-muse-glimmer");
  assert.equal(muse.status, "blocked");
  assert.deepEqual(recipes.applyRecipe(muse, {}, {}).blocks.map((block) => block.code), ["recipe_retired"]);
});

test("env and host-fact inputs reproduce today's outputs: DiffusionGemma, Qwen MoE backend and SM12x", () => {
  const store = recipes.getRecipeStore();
  const gemma = store.get("diffusiongemma-windows");
  const gemmaCase = (platform, env) => {
    const applied = recipes.applyRecipe(gemma, {}, { hostFacts: { platform }, env });
    return { blocks: applied.blocks.map((block) => block.code), runner: applied.fixed.env.VLLM_USE_V2_MODEL_RUNNER };
  };
  assert.deepEqual(gemmaCase("win32", {}), { blocks: ["diffusiongemma_windows_blocked"], runner: "0" });
  assert.deepEqual(gemmaCase("win32", { VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA: "1" }), { blocks: [], runner: "0" });
  assert.deepEqual(gemmaCase("win32", { VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA: "0" }).blocks, ["diffusiongemma_windows_blocked"]);
  assert.deepEqual(gemmaCase("linux", {}), { blocks: [], runner: "1" });
  assert.equal(gemmaCase("linux", { VLLM_GEMMA_USE_V2_MODEL_RUNNER: "off" }).runner, "0");
  assert.equal(gemmaCase("win32", { VLLM_GEMMA_USE_V2_MODEL_RUNNER: "true" }).runner, "1");
  assert.equal(gemmaCase("win32", { SOME_OTHER_VAR: "1" }).blocks.length, 1, "only declared names are read");

  const moe = store.get("qwen36-nvfp4-vllm");
  const moeCase = (anySm12x, env, user = {}) => {
    const applied = recipes.applyRecipe(moe, { kvCacheDtype: "auto", ...user }, { hostFacts: { anySm12x }, env });
    return { backend: applied.values["vllm.moeBackend"], dtype: applied.values.dtype, kv: applied.values.kvCacheDtype };
  };
  assert.deepEqual(moeCase(true, {}), { backend: "flashinfer_b12x", dtype: "bfloat16", kv: "fp8" });
  assert.deepEqual(moeCase(false, {}), { backend: "marlin", dtype: undefined, kv: "fp8" });
  assert.equal(moeCase(true, { VLLM_QWEN_MOE_BACKEND: "marlin" }).backend, "marlin");
  assert.equal(moeCase(true, { VLLM_QWEN_MOE_BACKEND: "marlin" }).dtype, undefined, "bfloat16 only with the b12x backend");
  assert.equal(moeCase(false, { VLLM_QWEN_MOE_BACKEND: "FLASHINFER_B12X" }).backend, "flashinfer_b12x", "the env value is case-insensitive");
  assert.equal(moeCase(false, { VLLM_QWEN_MOE_BACKEND: "not-a-backend" }).backend, "marlin", "a value outside the allowed list is ignored");
  assert.equal(moeCase(true, {}, { kvCacheDtype: "fp8_e4m3" }).kv, "fp8_e4m3", "an explicit KV dtype is kept");
});

// ---------------------------------------------------------------------------
// Legacy preset shim: PRE-* goldens
// ---------------------------------------------------------------------------

const preFixtures = harness.loadGoldenFixtures().filter((fixture) => fixture.id.startsWith("PRE-"));

test("the PRE golden set is PRE-01..19 (16a and 16b included)", () => {
  assert.deepEqual(preFixtures.map((fixture) => fixture.id.split("-")[1]).sort(), [
    "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16a", "16b", "17", "18", "19",
  ]);
});

for (const fixture of preFixtures) {
  test(`${fixture.id}: resolveVllmRuntimePreset renders the golden preset from recipe data`, async () => {
    assert.deepEqual(await harness.runGoldenFixture(fixture), fixture.expect);
  });
}

test("presetFromRecipe renders a preset from a recipe id without a manager", () => {
  const preset = recipes.presetFromRecipe("qwen38-vllm-nvfp4", { model: "example/Qwen3.8-27B-NVFP4" }, {}, {
    engineId: "vllm",
    imageFor: (key) => `example.invalid/${key}:test`,
    defaultImage: () => "example.invalid/vllm:test",
    hostGpus: [{ id: "0", name: "NVIDIA RTX PRO 6000 Blackwell", computeCap: "12.0" }],
    platform: "linux",
    env: {},
  });
  assert.ok(preset.id);
  assert.ok(preset.image);
  assert.ok(!preset.unsupportedReason);
  assert.throws(() => recipes.presetFromRecipe("no-such-recipe", {}, {}, {}), /Unknown recipe/);
});

// ---------------------------------------------------------------------------
// Legacy profile shim
// ---------------------------------------------------------------------------

const VLLM_PROFILE_IDS = [
  "orcarouter-pennyroyal-v251-524k",
  "qwen38-flash-next-sglang-262k",
  "qwen38-vllm-mtp3-quality",
  "qwen38-sglang-dspark-fastest",
  "qwen38-nvfp4-capacity",
  "blackwell-96gb-256k",
  "claude-long-context-64k",
  "claude-maximum-context",
  "openwebui-chat",
  "low-vram-safe",
];
const LLAMA_PROFILE_IDS = [
  "llama-96gb-single-256k",
  "llama-hetero-64k-safe",
  "llama-hetero-256k-max",
  "llama-openwebui-daily",
  "llama-single-gpu-debug",
];

test("builtinProfiles lists today's profiles in today's order with the legacy shape", () => {
  const vllm = recipes.builtinProfiles("vllm", { modelsRoot: "/srv/models" });
  assert.deepEqual(vllm.map((profile) => profile.id), VLLM_PROFILE_IDS);
  const llama = recipes.builtinProfiles("llama", { modelsRoot: "/srv/models" });
  assert.deepEqual(llama.map((profile) => profile.id), LLAMA_PROFILE_IDS);
  for (const profile of [...vllm, ...llama]) {
    assert.equal(profile.source, "builtin");
    assert.equal(typeof profile.name, "string");
    assert.equal(typeof profile.description, "string");
    assert.equal(typeof profile.config, "object");
  }
  assert.deepEqual(recipes.builtinProfiles("vllm", { modelsRoot: "/srv/models" }), vllm, "deterministic");
});

test("builtinProfiles joins profile.modelDir to the configured models root in the root's separator style", () => {
  const posix = recipes.builtinProfiles("vllm", { modelsRoot: "/srv/models/" }).find((profile) => profile.id === "qwen38-flash-next-sglang-262k");
  assert.equal(posix.config.model, "/srv/models/RadixArk-Qwen3.8-Flash-Next-NVFP4");
  const windows = recipes.builtinProfiles("vllm", { modelsRoot: "X:\\library\\models" }).find((profile) => profile.id === "qwen38-flash-next-sglang-262k");
  assert.equal(windows.config.model, "X:\\library\\models\\RadixArk-Qwen3.8-Flash-Next-NVFP4");
  const noModel = recipes.builtinProfiles("vllm", { modelsRoot: "/srv/models" }).find((profile) => profile.id === "openwebui-chat");
  assert.equal(noModel.config.model, undefined, "a scenario profile names no model");
  const pennyroyal = recipes.builtinProfiles("vllm", { modelsRoot: "/srv/models" }).find((profile) => profile.id === "orcarouter-pennyroyal-v251-524k").config;
  assert.equal(pennyroyal.engine, "sglang");
  assert.match(pennyroyal.runtimeImage, /@sha256:[0-9a-f]{64}$/, "the profile pins its manifest runtime");
});

test("builtinProfiles applies the manager's normalize hook to each config", () => {
  const seen = [];
  const profiles = recipes.builtinProfiles("llama", { modelsRoot: "/srv/models", normalize: (config) => { seen.push(config); return { ...config, normalized: true }; } });
  assert.equal(seen.length, 5);
  assert.equal(profiles.every((profile) => profile.config.normalized === true), true);
});

test("no profile reaches an absolute path except through the models root it is given", () => {
  const root = "Q:/placeholder-root/models";
  for (const managerId of ["vllm", "llama"]) {
    for (const profile of recipes.builtinProfiles(managerId, { modelsRoot: root })) {
      const stripped = JSON.stringify(profile.config).split(root).join("<root>");
      assert.equal(/[A-Za-z]:[\\/]|\/(?:home|Users)\//.test(stripped), false, profile.id);
    }
  }
});

// ---------------------------------------------------------------------------
// POST /api/recipes/reload
// ---------------------------------------------------------------------------

function recordingApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; },
  };
}

async function call(app, route, req = {}) {
  const res = fakeResponse();
  await app.routes.get(route)({ headers: {}, body: undefined, ...req }, res);
  return res;
}

function mountRoutes(store, { local = () => true } = {}) {
  const app = recordingApp();
  engines.registerEngineRoutes(app, {
    registry: store.registry(),
    recipeStore: store,
    managerId: "vllm",
    ownerLabelValue: "vllm-manager",
    isLocalRequest: local,
    getImageStatus: async () => ({ ok: false, text: "missing", reason: "missing-image" }),
    listManagedContainers: async () => [],
  });
  return app;
}

test("POST /api/recipes/reload re-reads the override directory and GET /api/engines lists file errors", async (t) => {
  const { store, overrideDir } = newStore(t, { "mine.json": minimalRecipe("owner-sglang", { values: { "sglang.pageSize": 16 } }) });
  let local = true;
  const app = mountRoutes(store, { local: () => local });
  assert.ok(app.routes.has("POST /api/recipes/reload"));

  fs.writeFileSync(path.join(overrideDir, "mine.json"), JSON.stringify(minimalRecipe("owner-sglang", { values: { "sglang.pageSize": 32 } })));
  const ok = await call(app, "POST /api/recipes/reload");
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.count, 22);
  assert.deepEqual(ok.body.errors, []);
  assert.match(ok.body.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(store.get("owner-sglang").values["sglang.pageSize"], 32);

  fs.writeFileSync(path.join(overrideDir, "mine.json"), "{ broken");
  const bad = await call(app, "POST /api/recipes/reload");
  assert.equal(bad.statusCode, 200);
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.count, 22, "the last good version is still served");
  assert.equal(bad.body.errors[0].file, "mine.json");
  const listing = await call(app, "GET /api/engines");
  assert.ok(listing.body.errors.some((error) => error.source === "recipes" && error.file === "mine.json" && error.code === "invalid_json"), JSON.stringify(listing.body.errors));

  local = false;
  const denied = await call(app, "POST /api/recipes/reload");
  assert.equal(denied.statusCode, 403);

  const bare = recordingApp();
  engines.registerEngineRoutes(bare, { registry: store.registry(), managerId: "vllm" });
  assert.equal(bare.routes.has("POST /api/recipes/reload"), false, "no store, no route");
});

test("GET /api/engines/:engineId/schema ranks the engine's recipes and lists the manager's scenarios", async (t) => {
  const { store } = newStore(t);
  const app = mountRoutes(store);
  const res = await call(app, "GET /api/engines/:engineId/schema", { params: { engineId: "sglang" }, query: {} });
  assert.equal(res.statusCode, 200);
  const text = JSON.stringify(res.body.recipes);
  assert.ok(text.includes("qwen38-flashnext-262k"), text.slice(0, 400));
  assert.ok(text.includes("pennyroyal-v251"));
  assert.ok(Array.isArray(res.body.scenarios));
  assert.ok(JSON.stringify(res.body.scenarios).includes("scenario-"));
});
