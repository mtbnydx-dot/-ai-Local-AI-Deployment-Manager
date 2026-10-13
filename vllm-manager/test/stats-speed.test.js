const test = require("node:test");
const assert = require("node:assert/strict");

const manager = require("../server");
const core = require("../../manager-core");

// Speed sources of 08 P0-7: the per-model outputSource is one of these two.
const SPEED_SOURCES = new Set(["counter_window", "sglang_gen_throughput_gauge"]);
const REMOVED_SOURCES = ["counter_delta", "sglang_live_gauge", "sglang_recent_gauge", "sglang_active_average"];

function metrics(lines) {
  return manager.parsePrometheusMetrics(lines.join("\n"));
}

function modelStats(name, lines, nowSeconds, engine = "sglang") {
  const [model] = manager.buildModelStats(metrics(lines), { [name]: { id: name } }, {}, nowSeconds, { engine });
  return model;
}

test("an idle SGLang with a generation counter reports the counter window, not the stale gauge", () => {
  const name = "sglang-idle-with-counter";
  const first = modelStats(name, [
    `sglang:generation_tokens_total{model_name="${name}"} 1000`,
    `sglang:gen_throughput{model_name="${name}"} 88.5`,
    `sglang:num_running_reqs{model_name="${name}"} 0`,
  ], 100);
  assert.equal(first.speed.outputSource, "counter_window");
  assert.equal(first.speed.recentOutputTokensPerSecond, 0);
  assert.equal(first.speed.windowSeconds, 0);

  const later = modelStats(name, [
    `sglang:generation_tokens_total{model_name="${name}"} 1600`,
    `sglang:gen_throughput{model_name="${name}"} 88.5`,
    `sglang:num_running_reqs{model_name="${name}"} 0`,
  ], 160);
  assert.equal(later.speed.outputSource, "counter_window");
  assert.equal(later.speed.windowSeconds, 60);
  assert.equal(later.speed.recentOutputTokensPerSecond, 10);
  assert.notEqual(later.speed.recentOutputTokensPerSecond, 88.5);
  assert.equal(later.speed.outputObservedAt, null);
});

test("a running SGLang reports the live gauge", () => {
  const name = "sglang-running";
  const model = modelStats(name, [
    `sglang:generation_tokens_total{model_name="${name}"} 500`,
    `sglang:gen_throughput{model_name="${name}"} 120.25`,
    `sglang:num_running_reqs{model_name="${name}"} 3`,
  ], 500);
  assert.equal(model.speed.outputSource, "sglang_gen_throughput_gauge");
  assert.equal(model.speed.recentOutputTokensPerSecond, 120.25);
  assert.equal(model.speed.outputObservedAt, 500);
  assert.equal(typeof model.speed.windowSeconds, "number");
});

test("an SGLang build without generation_tokens_total uses the gauge while running and 0 when idle", () => {
  const name = "sglang-no-counter";
  const running = modelStats(name, [
    `sglang:gen_throughput{model_name="${name}"} 64`,
    `sglang:num_running_reqs{model_name="${name}"} 1`,
  ], 700);
  assert.equal(running.speed.outputSource, "sglang_gen_throughput_gauge");
  assert.equal(running.speed.recentOutputTokensPerSecond, 64);

  const idle = modelStats(name, [
    `sglang:gen_throughput{model_name="${name}"} 64`,
    `sglang:num_running_reqs{model_name="${name}"} 0`,
  ], 760);
  assert.equal(idle.speed.outputSource, "sglang_gen_throughput_gauge");
  assert.equal(idle.speed.recentOutputTokensPerSecond, 0);
  assert.equal(idle.speed.outputObservedAt, null);
});

test("vLLM reports the counter window with windowSeconds", () => {
  const name = "vllm-window";
  const first = modelStats(name, [
    `vllm:generation_tokens_total{model_name="${name}"} 100`,
    `vllm:prompt_tokens_total{model_name="${name}"} 400`,
  ], 1000, "vllm");
  assert.equal(first.speed.outputSource, "counter_window");
  assert.equal(first.speed.windowSeconds, 0);

  const later = modelStats(name, [
    `vllm:generation_tokens_total{model_name="${name}"} 700`,
    `vllm:prompt_tokens_total{model_name="${name}"} 1600`,
  ], 1060, "vllm");
  assert.equal(later.speed.outputSource, "counter_window");
  assert.equal(later.speed.windowSeconds, 60);
  assert.equal(later.speed.recentOutputTokensPerSecond, 10);
  assert.equal(later.speed.recentPromptTokensPerSecond, 20);
});

test("no removed speed source is emitted, and the totals carry the window", () => {
  const cases = [
    ["sglang-src-a", ["sglang:generation_tokens_total{model_name=\"sglang-src-a\"} 10", "sglang:gen_throughput{model_name=\"sglang-src-a\"} 5"]],
    ["sglang-src-b", ["sglang:gen_throughput{model_name=\"sglang-src-b\"} 0"]],
    ["sglang-src-c", ["sglang:gen_throughput{model_name=\"sglang-src-c\"} 9", "sglang:num_running_reqs{model_name=\"sglang-src-c\"} 1"]],
  ];
  const models = [];
  for (const [name, lines] of cases) {
    const model = modelStats(name, lines, 2000);
    assert.ok(SPEED_SOURCES.has(model.speed.outputSource), `${name}: ${model.speed.outputSource}`);
    assert.ok(!REMOVED_SOURCES.includes(model.speed.outputSource));
    models.push(model);
  }
  const vllmModel = modelStats("vllm-src", ["vllm:generation_tokens_total{model_name=\"vllm-src\"} 1"], 2000, "vllm");
  assert.ok(!REMOVED_SOURCES.includes(vllmModel.speed.outputSource));

  const windowed = { ...vllmModel, speed: { ...vllmModel.speed, windowSeconds: 58 } };
  const totals = manager.withSpeedWindowSeconds(core.aggregateStats([...models, windowed], 100), [...models, windowed]);
  assert.equal(totals.speed.windowSeconds, 58);
  assert.equal(totals.speed.outputSource, "mixed");
  assert.equal(manager.withSpeedWindowSeconds(core.aggregateStats(models, 100), models).speed.windowSeconds, 0);
});
