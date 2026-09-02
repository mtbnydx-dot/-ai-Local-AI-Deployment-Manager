const assert = require("node:assert/strict");
const test = require("node:test");

const {
  HOUR_MS,
  normalizeSlotObservation,
  createCacheHitTracker,
} = require("../lib/cache-hit-tracker");

test("active llama slot uses the live processed and cached prompt counters", () => {
  const observation = normalizeSlotObservation({
    id: 0,
    id_task: 105494,
    is_processing: true,
    n_prompt_tokens: 153248,
    n_prompt_tokens_processed: 561,
    n_prompt_tokens_cache: 151415,
    next_token: [{ n_decoded: 1273 }],
  }, { runtimeId: "runtime-a", model: "deepseek" }, Date.parse("2026-08-09T00:00:00Z"));

  assert.equal(observation.status, "running");
  assert.equal(observation.promptTokens, 151976);
  assert.equal(observation.processedTokens, 561);
  assert.equal(observation.cachedTokens, 151415);
  assert.equal(observation.hitRate, 151415 / 151976);
});

test("idle llama slot reconstructs cached tokens after llama.cpp clears its cache counter", () => {
  const observation = normalizeSlotObservation({
    id: 0,
    id_task: 101,
    is_processing: false,
    n_prompt_tokens: 138805,
    n_prompt_tokens_processed: 252,
    n_prompt_tokens_cache: 0,
    n_decoded: 649,
  }, { runtimeId: "runtime-a", model: "deepseek" }, Date.parse("2026-08-09T00:00:00Z"));

  assert.equal(observation.status, "completed");
  assert.equal(observation.promptTokens, 138156);
  assert.equal(observation.processedTokens, 252);
  assert.equal(observation.cachedTokens, 137904);
  assert.equal(observation.inferredAfterReset, true);
  assert.ok(observation.hitRate > 0.998);
});

test("tracker deduplicates completed tasks and keeps rolling and cumulative totals", async () => {
  let nowMs = Date.parse("2026-08-09T00:00:00Z");
  let persisted = {};
  const tracker = createCacheHitTracker({
    file: "memory.json",
    now: () => nowMs,
    readJsonFile: async () => structuredClone(persisted),
    writeJsonFile: async (_file, value) => { persisted = structuredClone(value); },
  });

  const first = {
    id: 0,
    id_task: 1,
    is_processing: false,
    n_prompt_tokens: 1100,
    n_prompt_tokens_processed: 100,
    n_prompt_tokens_cache: 0,
    n_decoded: 100,
  };
  await tracker.observeSlots([first], { runtimeId: "runtime-a", model: "deepseek" });
  await tracker.observeSlots([first], { runtimeId: "runtime-a", model: "deepseek" });

  let summary = await tracker.getSummary();
  assert.equal(summary.cumulative.requests, 1);
  assert.equal(summary.cumulative.promptTokens, 1000);
  assert.equal(summary.cumulative.cachedTokens, 900);
  assert.equal(summary.rollingHour.requests, 1);

  nowMs += 30 * 60 * 1000;
  await tracker.observeSlots([{
    ...first,
    id_task: 2,
    n_prompt_tokens: 600,
    n_prompt_tokens_processed: 500,
    n_decoded: 100,
  }], { runtimeId: "runtime-a", model: "deepseek" });
  summary = await tracker.getSummary();
  assert.equal(summary.cumulative.requests, 2);
  assert.equal(summary.cumulative.promptTokens, 1500);
  assert.equal(summary.cumulative.cachedTokens, 900);
  assert.equal(summary.cumulative.hitRate, 0.6);
  assert.equal(summary.rollingHour.requests, 2);

  nowMs += 2 * HOUR_MS;
  summary = await tracker.getSummary();
  assert.equal(summary.rollingHour.requests, 0);
  assert.equal(summary.cumulative.requests, 2);

  const reloaded = createCacheHitTracker({
    file: "memory.json",
    now: () => nowMs,
    readJsonFile: async () => structuredClone(persisted),
    writeJsonFile: async (_file, value) => { persisted = structuredClone(value); },
  });
  await reloaded.observeSlots([{
    ...first,
    id_task: 2,
    n_prompt_tokens: 600,
    n_prompt_tokens_processed: 500,
    n_decoded: 100,
  }], { runtimeId: "runtime-a", model: "deepseek" });
  assert.equal((await reloaded.getSummary()).cumulative.requests, 2);
});

test("live task is shown immediately but enters cumulative totals only after completion", async () => {
  const nowMs = Date.parse("2026-08-09T00:00:00Z");
  let persisted = {};
  const tracker = createCacheHitTracker({
    file: "memory.json",
    now: () => nowMs,
    readJsonFile: async () => structuredClone(persisted),
    writeJsonFile: async (_file, value) => { persisted = structuredClone(value); },
  });

  await tracker.observeSlots([{
    id: 0,
    id_task: 9,
    is_processing: true,
    n_prompt_tokens_processed: 200,
    n_prompt_tokens_cache: 9800,
  }], { runtimeId: "runtime-a" });
  let summary = await tracker.getSummary();
  assert.equal(summary.latest.status, "running");
  assert.equal(summary.latest.hitRate, 0.98);
  assert.equal(summary.cumulative.requests, 0);

  await tracker.observeSlots([{
    id: 0,
    id_task: 9,
    is_processing: false,
    n_prompt_tokens: 10100,
    n_prompt_tokens_processed: 200,
    n_prompt_tokens_cache: 0,
    n_decoded: 100,
  }], { runtimeId: "runtime-a" });
  summary = await tracker.getSummary();
  assert.equal(summary.latest.status, "completed");
  assert.equal(summary.cumulative.requests, 1);
  assert.equal(summary.cumulative.hitRate, 0.98);
});
