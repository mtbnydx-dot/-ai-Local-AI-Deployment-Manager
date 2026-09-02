const test = require("node:test");
const assert = require("node:assert/strict");
const { createSingleFlightCache } = require("../single-flight-cache");

test("single-flight cache shares one in-flight load and honors TTL", async () => {
  let now = 1000;
  let loads = 0;
  const cache = createSingleFlightCache({ ttlMs: 2000, now: () => now });
  const loader = async () => {
    loads += 1;
    return `value-${loads}`;
  };

  const [a, b, c] = await Promise.all([
    cache.get("gpu", loader),
    cache.get("gpu", loader),
    cache.get("gpu", loader),
  ]);
  assert.equal(loads, 1, "concurrent callers must share one load");
  assert.deepEqual([a, b, c], ["value-1", "value-1", "value-1"]);

  now += 1000;
  assert.equal(await cache.get("gpu", loader), "value-1", "fresh value is served without loading");
  assert.equal(loads, 1);

  now += 2000;
  assert.equal(await cache.get("gpu", loader), "value-2", "expired value triggers a reload");
  assert.equal(loads, 2);
});

test("single-flight cache does not pin failures and supports invalidate", async () => {
  let now = 0;
  let fail = true;
  let loads = 0;
  const cache = createSingleFlightCache({ ttlMs: 5000, now: () => now });
  const loader = async () => {
    loads += 1;
    if (fail) throw new Error("boom");
    return "ok";
  };

  await assert.rejects(() => cache.get("k", loader), /boom/);
  fail = false;
  assert.equal(await cache.get("k", loader), "ok", "a failed load must not be cached");
  assert.equal(loads, 2);

  cache.invalidate("k");
  assert.equal(await cache.get("k", loader), "ok");
  assert.equal(loads, 3, "invalidate must force a reload");
});
