const test = require("node:test");
const assert = require("node:assert/strict");

const manager = require("../server");
const core = require("../../manager-core");

// llama.cpp's *_tokens_seconds gauges are averages since the server started
// (08 P0-7), so they feed only the averages. These fixtures make the lifetime
// average and the windowed counter rate diverge on purpose.
function llamaMetrics({ predicted, prompt, predictedPerSecond, promptPerSecond, processing = 0 }) {
  return manager.parsePrometheusMetrics([
    `llamacpp:tokens_predicted_total ${predicted}`,
    `llamacpp:prompt_tokens_total ${prompt}`,
    `llamacpp:predicted_tokens_seconds ${predictedPerSecond}`,
    `llamacpp:prompt_tokens_seconds ${promptPerSecond}`,
    `llamacpp:requests_processing ${processing}`,
  ].join("\n"));
}

function modelStats(name, input, nowSeconds) {
  const [model] = manager.buildModelStats(llamaMetrics(input), { [name]: { id: name } }, {}, nowSeconds);
  return model;
}

test("llama recent output speed comes from the counter window, never the lifetime average", () => {
  const name = "llama-diverging";
  const first = modelStats(name, { predicted: 1000, prompt: 5000, predictedPerSecond: 42.5, promptPerSecond: 910 }, 300);
  assert.equal(first.speed.outputSource, "counter_window");
  assert.equal(first.speed.windowSeconds, 0);
  assert.equal(first.speed.recentOutputTokensPerSecond, 0);
  assert.notEqual(first.speed.recentOutputTokensPerSecond, 42.5);
  assert.notEqual(first.speed.recentPromptTokensPerSecond, 910);

  const later = modelStats(name, { predicted: 1300, prompt: 5600, predictedPerSecond: 42.5, promptPerSecond: 910, processing: 1 }, 360);
  assert.equal(later.speed.outputSource, "counter_window");
  assert.equal(later.speed.windowSeconds, 60);
  assert.equal(later.speed.recentOutputTokensPerSecond, 5);
  assert.equal(later.speed.recentPromptTokensPerSecond, 10);
  assert.notEqual(later.speed.recentOutputTokensPerSecond, later.speed.averageOutputTokensPerSecond);
  // The lifetime figures stay available as averages.
  assert.equal(later.speed.averageOutputTokensPerSecond, 42.5);
  assert.equal(later.speed.averagePromptTokensPerSecond, 910);
});

test("an idle llama server reports zero recent output even with a high lifetime average", () => {
  const name = "llama-idle";
  modelStats(name, { predicted: 4000, prompt: 9000, predictedPerSecond: 77, promptPerSecond: 1200 }, 1000);
  const idle = modelStats(name, { predicted: 4000, prompt: 9000, predictedPerSecond: 77, promptPerSecond: 1200 }, 1060);
  assert.equal(idle.speed.outputSource, "counter_window");
  assert.equal(idle.speed.windowSeconds, 60);
  assert.equal(idle.speed.recentOutputTokensPerSecond, 0);
  assert.equal(idle.speed.averageOutputTokensPerSecond, 77);
});

test("llama totals carry the window and a single counter_window source", () => {
  const name = "llama-totals";
  modelStats(name, { predicted: 10, prompt: 20, predictedPerSecond: 30, promptPerSecond: 40 }, 5000);
  const model = modelStats(name, { predicted: 610, prompt: 620, predictedPerSecond: 30, promptPerSecond: 40 }, 5030);
  const totals = manager.withSpeedWindowSeconds(core.aggregateStats([model], 100), [model]);
  assert.equal(totals.speed.outputSource, "counter_window");
  assert.equal(totals.speed.windowSeconds, 30);
  assert.equal(totals.speed.recentOutputTokensPerSecond, 20);
});
