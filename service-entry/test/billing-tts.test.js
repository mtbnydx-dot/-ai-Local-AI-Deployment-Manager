"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Readable } = require("node:stream");
const { DatabaseSync } = require("node:sqlite");

const { createBillingStore } = require("../lib/billing-store");
const { countTtsCharacters, createWavDurationProbe, parseTtsJsonDuration, ttsSynthesisRoute, ttsEngineFromBody, createJsonCollector } = require("../lib/tts-usage");

const NOW = new Date("2026-09-03T10:00:00.000Z");

function makeStore(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "service-entry-tts-billing-"));
  const store = createBillingStore({ file: path.join(dir, "billing.sqlite"), DatabaseSync, clock: () => new Date(NOW), ...options });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

function provision(store, { mode = "hard", perMinute = "60000", perKChars = "1000", dailySeconds = "120", balance = "1000000" } = {}) {
  const plan = store.createPlan({ code: `tts-${crypto.randomUUID().slice(0, 8)}`, name: "TTS plan", enforcementMode: mode, ttsPerMinuteMicrocredits: perMinute, ttsPerThousandCharsMicrocredits: perKChars });
  const customer = store.createCustomer({ name: "Voice customer", planId: plan.planId, ttsDailySecondsLimit: dailySeconds });
  store.bindCredential({ customerId: customer.customerId, managerId: "vllm", serviceClientId: "voice-client" });
  store.adjustBalance({ customerId: customer.customerId, deltaMicrocredits: balance, reason: "seed", idempotencyKey: `seed-${customer.customerId}` });
  return { plan, customer };
}

test("plans and customers carry TTS pricing and daily quota fields", (t) => {
  const store = makeStore(t);
  const { plan, customer } = provision(store);
  assert.equal(plan.ttsPerMinuteMicrocredits, "60000");
  assert.equal(plan.ttsPerThousandCharsMicrocredits, "1000");
  assert.equal(customer.ttsDailySecondsLimit, "120");
  const updated = store.updatePlan(plan.planId, { ttsPerMinuteMicrocredits: "30000" });
  assert.equal(updated.ttsPerMinuteMicrocredits, "30000");
  assert.equal(updated.ttsPerThousandCharsMicrocredits, "1000", "untouched field survives a patch");
  const patched = store.updateCustomer(customer.customerId, { ttsDailySecondsLimit: "0" });
  assert.equal(patched.ttsDailySecondsLimit, null, "0 clears the quota");
});

test("recordTtsUsage prices audio seconds and characters, debits hard customers, and is idempotent", (t) => {
  const store = makeStore(t);
  const { customer } = provision(store);
  const requestId = crypto.randomUUID();
  const usage = store.recordTtsUsage({ requestId, managerId: "vllm", clientId: "voice-client", engine: "qwen", endpoint: "/v1/audio/speech", characters: 1500, audioMs: 30_000, durationSource: "reported", status: 200 });
  // 30s * 60000/min = 30000, 1500 chars * 1000/1000 = 1500 -> 31500
  assert.equal(usage.projectedMicrocredits, "31500");
  assert.equal(usage.chargedMicrocredits, "31500");
  assert.equal(usage.code, "billing_tts_settled");
  assert.equal(usage.customerId, customer.customerId);
  const replay = store.recordTtsUsage({ requestId, managerId: "vllm", clientId: "voice-client", characters: 999, audioMs: 1 });
  assert.equal(replay.replayed, true);
  assert.equal(replay.chargedMicrocredits, "31500");
  const wallet = store.getCustomer(customer.customerId);
  assert.equal(wallet.balanceMicrocredits, String(1_000_000 - 31_500));
  const overview = store.getOverview();
  assert.equal(overview.tts.lifetime.requests, 1);
  assert.equal(overview.tts.lifetime.audioSeconds, 30);
  assert.equal(overview.tts.period.chargedMicrocredits, "31500");
  assert.equal(store.listTtsUsage({ clientId: "voice-client" }).length, 1);
});

test("unbound keys are recorded in shadow without a charge, failed requests are free", (t) => {
  const store = makeStore(t);
  const unbound = store.recordTtsUsage({ requestId: crypto.randomUUID(), managerId: "vllm", clientId: "stranger", characters: 10, audioMs: 5000 });
  assert.equal(unbound.customerId, null);
  assert.equal(unbound.chargedMicrocredits, "0");
  assert.equal(unbound.code, "billing_unbound_shadow");
  provision(store);
  const failed = store.recordTtsUsage({ requestId: crypto.randomUUID(), managerId: "vllm", clientId: "voice-client", characters: 10, audioMs: 0, status: 502, ok: false });
  assert.equal(failed.projectedMicrocredits, "0");
  assert.equal(failed.success, false);
});

test("daily TTS quota is enforced for hard customers and only observed in shadow", (t) => {
  const store = makeStore(t);
  provision(store, { dailySeconds: "60" });
  let state = store.getTtsQuotaState({ managerId: "vllm", clientId: "voice-client" });
  assert.equal(state.bound, true);
  assert.equal(state.allowed, true);
  assert.equal(state.limitSeconds, 60);
  assert.equal(state.remainingSeconds, 60);
  store.recordTtsUsage({ requestId: crypto.randomUUID(), managerId: "vllm", clientId: "voice-client", characters: 10, audioMs: 61_000 });
  state = store.getTtsQuotaState({ managerId: "vllm", clientId: "voice-client" });
  assert.equal(state.allowed, false);
  assert.equal(state.code, "billing_tts_daily_limit");
  assert.equal(state.remainingSeconds, 0);
  assert.equal(store.getTtsQuotaState({ managerId: "vllm", clientId: "nobody" }).bound, false);

  const shadow = makeStore(t);
  provision(shadow, { mode: "shadow", dailySeconds: "10" });
  shadow.recordTtsUsage({ requestId: crypto.randomUUID(), managerId: "vllm", clientId: "voice-client", characters: 10, audioMs: 20_000 });
  const observed = shadow.getTtsQuotaState({ managerId: "vllm", clientId: "voice-client" });
  assert.equal(observed.allowed, true);
  assert.equal(observed.code, "billing_tts_daily_limit_shadow");
});

test("synthesis routes, character counting and engine extraction", () => {
  assert.equal(ttsSynthesisRoute({ rest: "openai/v1/audio/speech" }).endpoint, "/v1/audio/speech");
  assert.equal(ttsSynthesisRoute({ rest: "api/tts" }).kind, "json");
  assert.equal(ttsSynthesisRoute({ rest: "api/jobs" }).kind, "batch");
  assert.equal(ttsSynthesisRoute({ rest: "api/engines" }), null);
  assert.equal(ttsSynthesisRoute({ rest: "api/tts" }, "GET"), null);
  assert.equal(countTtsCharacters({ input: "你好，世界 " }), 5);
  assert.equal(countTtsCharacters({ items: [{ text: "abc" }, { text: "de" }] }, "batch"), 5);
  assert.equal(countTtsCharacters(null), 0);
  assert.equal(ttsEngineFromBody({ model: "tts-qwen" }), "qwen");
  assert.equal(ttsEngineFromBody({ engine: "fish speech!" }), "fish-speech-");
  assert.equal(ttsEngineFromBody({}), "unknown");
  assert.deepEqual(parseTtsJsonDuration({ output: { duration_ms: 1234.4 } }), { audioMs: 1234, durationSource: "reported" });
  assert.equal(parseTtsJsonDuration({}).durationSource, "missing");
});

function wavBuffer(seconds, sampleRate = 16000, channels = 1, bits = 16) {
  const byteRate = sampleRate * channels * (bits / 8);
  const dataBytes = Math.round(seconds * byteRate);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * (bits / 8), 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

async function drain(stream) {
  for await (const _chunk of stream) { /* consume */ }
}

test("WAV duration probe measures streamed audio and passes bytes through", async () => {
  const wav = wavBuffer(2.5);
  let reported = null;
  const probe = createWavDurationProbe((result) => { reported = result; });
  const chunks = [];
  for (let offset = 0; offset < wav.length; offset += 1000) chunks.push(wav.subarray(offset, offset + 1000));
  const output = [];
  const source = Readable.from(chunks);
  source.pipe(probe);
  for await (const chunk of probe) output.push(chunk);
  assert.equal(Buffer.concat(output).equals(wav), true);
  assert.equal(reported.audioMs, 2500);
  assert.equal(reported.durationSource, "reported");

  const notWav = createWavDurationProbe();
  Readable.from([Buffer.from("{\"detail\":\"error\"}")]).pipe(notWav);
  await drain(notWav);
  assert.equal(notWav.result().durationSource, "missing");
});

test("JSON collector parses bounded bodies and ignores overflow", async () => {
  let parsed;
  const collector = createJsonCollector(1024, (value) => { parsed = value; });
  Readable.from([Buffer.from("{\"output\":{\"duration_ms\":"), Buffer.from("1500}}")]).pipe(collector);
  await drain(collector);
  assert.deepEqual(parsed, { output: { duration_ms: 1500 } });
  let big = "unset";
  const small = createJsonCollector(8, (value) => { big = value; });
  Readable.from([Buffer.from("{\"output\":{\"duration_ms\":1500}}")]).pipe(small);
  await drain(small);
  assert.equal(big, null);
});
