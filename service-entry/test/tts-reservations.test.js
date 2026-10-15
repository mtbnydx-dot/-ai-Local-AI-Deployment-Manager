"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBillingStore } = require("../lib/billing-store");
const { createTtsReconciler } = require("../lib/tts-bridge");

function setup(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tts-reservations-"));
  const file = path.join(directory, "billing.sqlite");
  const store = createBillingStore({ file });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const plan = store.createPlan({ code: "tts-hard", name: "TTS", enforcementMode: "hard", ttsPerMinuteMicrocredits: "60000", ...extra });
  const customer = store.createCustomer({ name: "TTS customer", planId: plan.planId });
  store.bindCredential({ customerId: customer.customerId, managerId: "vllm", serviceClientId: "client-a" });
  const meter = () => ({ requestId: crypto.randomUUID(), managerId: "vllm", clientId: "client-a", characters: 4, estimatedMs: 1000, endpoint: "/api/jobs", engine: "qwen_local" });
  const fund = (amount) => store.adjustBalance({ customerId: customer.customerId, deltaMicrocredits: String(amount), reason: "test", idempotencyKey: crypto.randomUUID() });
  return { store, customer, plan, file, meter, fund };
}

test("Hard TTS rejects zero balance and reserves against concurrent requests", (t) => {
  const { store, meter, fund, customer } = setup(t);
  assert.equal(store.authorizeTtsRequest(meter()).code, "billing_insufficient_balance");
  fund(1500);
  const first = meter();
  assert.equal(store.authorizeTtsRequest(first).allowed, true);
  assert.equal(store.getCustomer(customer.customerId).reservedMicrocredits, "1000");
  assert.equal(store.authorizeTtsRequest(meter()).allowed, false);
  const row = store.recordTtsUsage({ ...first, audioMs: 1000, ok: true });
  assert.equal(row.chargedMicrocredits, "1000");
  assert.equal(store.recordTtsUsage({ ...first, audioMs: 1000, ok: true }).chargedMicrocredits, "1000");
  assert.equal(store.getCustomer(customer.customerId).balanceMicrocredits, "500");
  assert.equal(store.getCustomer(customer.customerId).reservedMicrocredits, "0");
});

test("TTS daily quota includes outstanding work; failed work releases it", (t) => {
  const { store, meter, fund, customer } = setup(t);
  fund(10000);
  store.updateCustomer(customer.customerId, { ttsDailySecondsLimit: "1" });
  const first = meter();
  assert.equal(store.authorizeTtsRequest(first).allowed, true);
  assert.equal(store.authorizeTtsRequest(meter()).code, "billing_tts_daily_limit");
  store.recordTtsUsage({ ...first, ok: false, status: 502 });
  assert.equal(store.authorizeTtsRequest(meter()).allowed, true);
});

test("TTS uses quoted rates and caps unexpectedly long output at available balance", (t) => {
  const { store, meter, fund, plan, customer } = setup(t);
  fund(1500);
  const first = meter();
  store.authorizeTtsRequest(first);
  store.updatePlan(plan.planId, { ttsPerMinuteMicrocredits: "120000" });
  const result = store.recordTtsUsage({ ...first, audioMs: 3000, ok: true });
  assert.equal(result.projectedMicrocredits, "3000");
  assert.equal(result.chargedMicrocredits, "1500");
  assert.equal(store.getCustomer(customer.customerId).balanceMicrocredits, "0");
});

test("batch completion reconciles once after reopening the entry ledger", async (t) => {
  const { store, file, meter, fund, customer } = setup(t);
  fund(5000);
  const first = meter();
  store.authorizeTtsRequest(first);
  store.close();
  const reopened = createBillingStore({ file });
  try {
    let complete = false;
    const reconciler = createTtsReconciler({ getStore: () => reopened, getToken: () => "fixture", getPort: () => 7000, getKey: () => "", fetchImpl: async () => Response.json({ complete, ok: true, audioMs: 2000, characters: 8, engine: "qwen_local", durationSource: "measured" }) });
    await reconciler.flush();
    assert.equal(reopened.listPendingTtsRequests().length, 1);
    complete = true;
    await reconciler.flush();
    await reconciler.flush();
    assert.equal(reopened.listPendingTtsRequests().length, 0);
    assert.equal(reopened.listTtsUsage({ customerId: customer.customerId }).length, 1);
    assert.equal(reopened.getCustomer(customer.customerId).balanceMicrocredits, "3000");
  } finally { reopened.close(); }
});


test("real entry and Python TTS enforce RPM, Hard balance and asynchronous metering", { timeout: 30000 }, async (t) => {
  const { spawn, spawnSync } = require("node:child_process");
  const net = require("node:net");
  const python = process.env.TTS_TEST_PY || (process.env.TTS_RUNTIME_ROOT ? path.join(process.env.TTS_RUNTIME_ROOT, "envs/gateway/Scripts/python.exe") : "python");
  const available = spawnSync(python, ["-c", "import fastapi,httpx,uvicorn"], { windowsHide: true, timeout: 5000 });
  if (available.status !== 0) {
    if (process.env.REQUIRE_TTS_TESTS === "1") assert.fail("Python TTS integration dependencies are required");
    t.skip("TTS Python environment is not installed"); return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-real-entry-"));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  process.env.TTS_GATEWAY_PORT = String(port);
  process.env.AI_BILLING_DB = path.join(dir, "billing.sqlite");
  const entry = require("../server");
  fs.writeFileSync(path.join(dir, "trust.json"), JSON.stringify({ token: entry.security.getTrustToken() }));
  const fixture = path.join(dir, "fixture.py");
  fs.writeFileSync(fixture, [
    "import io,wave,asyncio,uvicorn,main",
    "buffer=io.BytesIO()",
    "with wave.open(buffer,'wb') as wav:",
    "    wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(24000);wav.writeframes(bytes(48000))",
    "async def generate(payload):",
    "    await asyncio.sleep(0.03)",
    "    return buffer.getvalue(),payload.engine,1,''",
    "main.synthesis_service.generate=generate",
    `uvicorn.run(main.app,host='127.0.0.1',port=${port},log_level='error')`
  ].join("\n"));
  const child = spawn(python, [fixture], { windowsHide: true, stdio: "ignore", env: { ...process.env, PYTHONPATH: path.resolve(__dirname, "../../tts-platform/gateway"), TTS_DATA_ROOT: path.join(dir, "data"), TTS_GATEWAY_TRUST_FILE: path.join(dir, "trust.json"), TTS_API_KEY: "" } });
  let server;
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) })).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    entry.security.authorizeGatewayRequest = async () => ({ ok: true, matchedManager: "vllm", client: { id: "client-a", rateLimitRpm: 1, maxConcurrentRequests: 1, maxQueuedRequests: 8 } });
    server = entry.createServiceEntryServer();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}/gateway/tts`;
    assert.equal((await fetch(base + "/api/voices")).status, 200);
    assert.equal((await fetch(base + "/api/voices")).status, 429);
    const store = entry.getBillingStore();
    const plan = store.createPlan({ code: "integration", name: "Integration", enforcementMode: "hard", ttsPerMinuteMicrocredits: "60000" });
    const customer = store.createCustomer({ name: "Synthetic customer", planId: plan.planId });
    store.bindCredential({ customerId: customer.customerId, managerId: "vllm", serviceClientId: "client-a" });
    const post = async (route, body) => {
      entry.resetEntryRateLimitBuckets();
      return fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    };
    assert.equal((await post("/openai/v1/audio/speech", { model: "tts-fish", input: "test" })).status, 402);
    assert.equal((await post("/v1/audio/%73peech", { model: "tts-fish", input: "test" })).status, 402);
    store.adjustBalance({ customerId: customer.customerId, deltaMicrocredits: "10000", reason: "test", idempotencyKey: crypto.randomUUID() });
    const batch = await post("/api/jobs", { engines: ["fish", "qwen_local"], text: "test" });
    assert.equal(batch.status, 202);
    const jobs = (await batch.json()).items;
    for (let i = 0; i < 50; i++) {
      await entry.flushTtsSettlements();
      if (store.listTtsUsage({ customerId: customer.customerId }).length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const usage = store.listTtsUsage({ customerId: customer.customerId });
    assert.equal(usage.length, 1);
    assert.equal(usage[0].audioMs, 2000);
    assert.equal(usage[0].chargedMicrocredits, "2000");
    assert.equal(usage[0].characters, 8);
    assert.equal(jobs.length, 2);
    assert.equal(store.getCustomer(customer.customerId).balanceMicrocredits, "8000");
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
    entry.getBillingStore().close();
    // The ban check opens the access store beside the ledger (05 §9.3).
    entry.closeAccessStore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
