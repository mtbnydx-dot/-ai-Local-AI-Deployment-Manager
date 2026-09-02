"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateGpuGuards } = require("../gpu-guard");

const gpu = {
  gpus: [
    { id: "0", temp: 84, powerWatts: 590, powerLimitWatts: 600 },
    { id: "1", temp: 60, powerWatts: 200, powerLimitWatts: 600 },
  ],
};

test("temperature and power findings honour their own cooldowns", () => {
  const state = {};
  const first = evaluateGpuGuards(gpu, { tempGuardEnabled: true, tempLimitC: 83 }, state, 1000);
  assert.deepEqual(first.map((item) => item.kind), ["temperature", "power"]);
  assert.equal(first[1].data.gpu, "0");
  assert.equal(first[1].data.percent, 98);
  // Inside the cooldown nothing repeats.
  assert.deepEqual(evaluateGpuGuards(gpu, { tempGuardEnabled: true, tempLimitC: 83 }, state, 2000), []);
  // After the cooldown both fire again.
  const later = evaluateGpuGuards(gpu, { tempGuardEnabled: true, tempLimitC: 83 }, state, 1000 + 10 * 60 * 1000);
  assert.equal(later.length, 2);
});

test("power guard can run without the temperature guard and respects the threshold", () => {
  const findings = evaluateGpuGuards(gpu, { tempGuardEnabled: false, powerGuardEnabled: true, powerLimitPct: 99 }, {}, 0);
  assert.deepEqual(findings, []);
  const pinned = evaluateGpuGuards(gpu, { tempGuardEnabled: false, powerGuardEnabled: true, powerLimitPct: 95 }, {}, 0);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].kind, "power");
});

test("disabled guards and missing GPU data produce nothing", () => {
  assert.deepEqual(evaluateGpuGuards(null, { tempGuardEnabled: true, tempLimitC: 80 }), []);
  assert.deepEqual(evaluateGpuGuards(gpu, { tempGuardEnabled: false, powerGuardEnabled: false }), []);
  assert.deepEqual(evaluateGpuGuards({ gpus: [{ id: "0", temp: null }] }, { tempGuardEnabled: true, tempLimitC: 80 }), []);
});
