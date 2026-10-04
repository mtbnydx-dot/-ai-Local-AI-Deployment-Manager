const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBenchmarkRun,
  compareBenchmarkRuns,
  createBenchmarkHistoryStore,
  normalizeBenchmarkHistory,
} = require("../benchmark-history-store");

function memoryStore(initial = {}) {
  let saved = initial;
  return {
    store: createBenchmarkHistoryStore({
      file: "benchmark-history.json",
      engine: "vllm",
      readJsonFile: async () => saved,
      writeJsonFile: async (_file, value) => { saved = value; },
      maxRuns: 10,
    }),
    read: () => saved,
  };
}

const sampleBenchmark = {
  model: "qwen3-27b",
  requests: 8,
  concurrency: 4,
  maxTokens: 256,
  stream: false,
  warmupRequests: 1,
  failedRequests: 0,
  totalOutputTokens: 2048,
  wallTokensPerSecond: 120.5,
  avgTokensPerSecond: 40.2,
  avgTtftMs: 310,
  p95TtftMs: 460,
  avgMs: 5200,
  p50Ms: 5100,
  p95Ms: 6400,
};

test("a recorded run keeps the launch configuration it was measured against", async () => {
  const { store, read } = memoryStore();
  const run = await store.recordBenchmarkRun(sampleBenchmark, {
    label: "基线",
    config: { maxNumSeqs: 4, maxModelLen: 32768, kvCacheDtype: "auto", nonsense: "dropped" },
  });
  assert.equal(run.engine, "vllm");
  assert.equal(run.model, "qwen3-27b");
  assert.equal(run.config.maxNumSeqs, 4);
  // Only keys that affect throughput or memory are kept.
  assert.equal(run.config.nonsense, undefined);
  assert.equal(run.metrics.wallTokensPerSecond, 120.5);
  assert.equal(run.load.concurrency, 4);
  assert.equal(read().runs.length, 1);
});

test("history keeps the newest runs first and prunes past the cap", async () => {
  const { store } = memoryStore();
  for (let index = 0; index < 14; index += 1) {
    await store.recordBenchmarkRun(
      { ...sampleBenchmark, wallTokensPerSecond: index },
      { config: { maxNumSeqs: index }, at: new Date(Date.now() + index * 1000).toISOString() },
    );
  }
  const listed = await store.listBenchmarkRuns({ limit: 50 });
  assert.equal(listed.total, 10);
  assert.equal(listed.runs[0].metrics.wallTokensPerSecond, 13);
  assert.equal(listed.runs.at(-1).metrics.wallTokensPerSecond, 4);
  assert.deepEqual(listed.models, ["qwen3-27b"]);
});

test("comparison surfaces only the settings that differ and the resulting deltas", () => {
  const baseline = buildBenchmarkRun(
    { ...sampleBenchmark, wallTokensPerSecond: 100, avgTtftMs: 400 },
    { id: "a", engine: "vllm", config: { maxNumSeqs: 4, maxModelLen: 32768, kvCacheDtype: "auto" } },
  );
  const candidate = buildBenchmarkRun(
    { ...sampleBenchmark, wallTokensPerSecond: 150, avgTtftMs: 500 },
    { id: "b", engine: "vllm", config: { maxNumSeqs: 8, maxModelLen: 32768, kvCacheDtype: "auto" } },
  );
  const result = compareBenchmarkRuns([baseline, candidate]);

  assert.equal(result.baselineId, "a");
  // maxModelLen and kvCacheDtype are identical, so they stay out of the table.
  assert.deepEqual(result.configKeys, ["maxNumSeqs"]);

  const throughput = result.metrics.find((metric) => metric.key === "wallTokensPerSecond");
  assert.equal(throughput.values[1].deltaPercent, 50);
  assert.equal(throughput.values[1].improved, true);

  // Higher throughput came with worse latency; "better" is per-metric.
  const ttft = result.metrics.find((metric) => metric.key === "avgTtftMs");
  assert.equal(ttft.values[1].deltaPercent, 25);
  assert.equal(ttft.values[1].improved, false);
});

test("an explicit baseline re-anchors the deltas", () => {
  const first = buildBenchmarkRun({ ...sampleBenchmark, wallTokensPerSecond: 100 }, { id: "a", config: { maxNumSeqs: 4 } });
  const second = buildBenchmarkRun({ ...sampleBenchmark, wallTokensPerSecond: 200 }, { id: "b", config: { maxNumSeqs: 8 } });
  const result = compareBenchmarkRuns([first, second], { baselineId: "b" });
  assert.equal(result.baselineId, "b");
  const throughput = result.metrics.find((metric) => metric.key === "wallTokensPerSecond");
  assert.equal(throughput.values[0].deltaPercent, -50);
  assert.equal(throughput.values[0].improved, false);
});

test("comparison keeps the requested order and ignores unknown ids", async () => {
  const { store } = memoryStore();
  const older = await store.recordBenchmarkRun(sampleBenchmark, { config: { maxNumSeqs: 2 } });
  const newer = await store.recordBenchmarkRun(sampleBenchmark, { config: { maxNumSeqs: 8 } });
  const result = await store.compareRuns([newer.id, "missing", older.id]);
  assert.deepEqual(result.runs.map((run) => run.id), [newer.id, older.id]);
  assert.equal(result.baselineId, newer.id);
});

test("deleting a run reports whether anything was removed", async () => {
  const { store } = memoryStore();
  const run = await store.recordBenchmarkRun(sampleBenchmark, { config: {} });
  assert.deepEqual(await store.deleteBenchmarkRun(run.id), { ok: true, removed: 1 });
  assert.deepEqual(await store.deleteBenchmarkRun(run.id), { ok: false, removed: 0 });
});

test("a corrupt or partial ledger normalizes instead of throwing", () => {
  const normalized = normalizeBenchmarkHistory({ runs: [null, { at: "nonsense" }, { at: new Date().toISOString() }] });
  assert.equal(normalized.runs.length, 1);
  assert.equal(normalized.version, 1);
});
