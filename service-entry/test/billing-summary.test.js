"use strict";

// Billing usage summary (04 TEL-14): GROUP BY over the immutable usage tables,
// keyset paging, request drill-down and the credential lookup. Fixture rows
// are written through a second SQLite connection so every expected sum below
// is computed by hand from the literal rows.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const core = require("../../manager-core");
const {
  BillingStoreError,
  createBillingStore,
  decodeUsageCursor,
  encodeUsageCursor,
} = require("../lib/billing-store");
const { createBillingHttpHandler } = require("../lib/billing-http");

const NOW = new Date("2026-10-14T00:00:00.000Z");
const CUSTOMER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CUSTOMER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALL_LLM_GROUPS = ["customer", "model", "manager", "endpoint", "day", "hour", "month", "terminal_state", "usage_source", "decision_code", "enforcement_mode"];
const IMMUTABLE_TRIGGERS = [
  "billing_admin_audit_no_delete",
  "billing_admin_audit_no_update",
  "billing_tts_usage_events_no_delete",
  "billing_tts_usage_events_no_update",
  "billing_usage_events_no_delete",
  "billing_usage_events_no_update",
  "billing_wallet_ledger_no_delete",
  "billing_wallet_ledger_no_update",
];

// Seven LLM rows around the UTC+08:00 day and month edges. r6 and r7 sit just
// outside October in UTC+08:00; r7 is inside October in UTC.
const LLM_ROWS = [
  { id: "r1", at: "2026-10-12T15:59:59.999Z", customerId: CUSTOMER_A, managerId: "vllm-manager", model: "model-a", ok: 1, terminalState: "completed", usageSource: "reported", input: 100, cached: 20, output: 50, projected: "230", charged: "230", mode: "hard", code: "billing_authorized" },
  { id: "r2", at: "2026-10-12T16:00:00.000Z", customerId: CUSTOMER_A, managerId: "vllm-manager", model: "model-a", ok: 1, terminalState: "completed", usageSource: "reported", input: 200, cached: 0, output: 100, projected: "400", charged: "400", mode: "hard", code: "billing_authorized" },
  { id: "r3", at: "2026-10-13T03:00:00.000Z", customerId: CUSTOMER_A, managerId: "llama-manager", model: "model-b", ok: 0, terminalState: "disconnected", usageSource: "estimated", input: 40, cached: 0, output: 10, projected: "60", charged: "60", mode: "hard", code: "billing_authorized" },
  { id: "r4", at: "2026-10-13T05:00:00.000Z", customerId: CUSTOMER_B, managerId: "vllm-manager", model: "model-a", ok: 1, terminalState: "completed", usageSource: "reported", input: 1000, cached: 500, output: 300, projected: "1350", charged: "0", mode: "shadow", code: "billing_authorized" },
  { id: "r5", at: "2026-10-13T06:00:00.000Z", customerId: null, managerId: "vllm-manager", model: "model-a", ok: 1, terminalState: "completed", usageSource: "missing", input: 0, cached: 0, output: 0, projected: "0", charged: "0", mode: "shadow", code: "billing_unbound_shadow" },
  { id: "r6", at: "2026-09-30T15:59:59.999Z", customerId: CUSTOMER_A, managerId: "vllm-manager", model: "model-a", ok: 1, terminalState: "completed", usageSource: "reported", input: 10, cached: 0, output: 10, projected: "30", charged: "30", mode: "hard", code: "billing_authorized" },
  { id: "r7", at: "2026-10-31T16:00:00.000Z", customerId: CUSTOMER_B, managerId: "vllm-manager", model: "model-a", ok: 1, terminalState: "completed", usageSource: "reported", input: 10, cached: 0, output: 10, projected: "30", charged: "0", mode: "shadow", code: "billing_authorized" },
];

const TTS_ROWS = [
  { id: "t1", at: "2026-10-13T02:00:00.000Z", customerId: CUSTOMER_A, engine: "qwen-tts", ok: 1, characters: 120, audioMs: 4500, durationSource: "measured", projected: "75", charged: "75", mode: "hard" },
  { id: "t2", at: "2026-10-13T03:00:00.000Z", customerId: null, engine: "qwen-tts", ok: 0, characters: 30, audioMs: 0, durationSource: "missing", projected: "0", charged: "0", mode: "shadow" },
  { id: "t3", at: "2026-10-13T04:00:00.000Z", customerId: CUSTOMER_B, engine: "fish", ok: 1, characters: 10, audioMs: 1000, durationSource: "reported", projected: "5", charged: "0", mode: "shadow" },
];

function openStore(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "service-entry-billing-summary-"));
  const file = path.join(dir, "billing.sqlite");
  const store = createBillingStore({ file, DatabaseSync, clock: () => new Date(NOW), ...options });
  // Close before removing: Windows keeps an open SQLite file locked.
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, file };
}

function rowUuid(label) {
  return crypto.createHash("sha256").update(label).digest("hex").replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, "$1-$2-4$3-8$4-$5");
}

// A second connection writes the fixture rows. Its foreign keys are off, so
// usage rows need no reservation; the immutability triggers still apply.
function seed(file, { llm = [], tts = [] } = {}) {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  try {
    const insertLlm = db.prepare(`
      INSERT INTO billing_usage_events
        (usage_id, at, request_id, external_request_id, customer_id, manager_id, service_client_id, model, endpoint,
         stream, response_status, ok, terminal_state, usage_source, input_tokens, output_tokens, total_tokens,
         cached_input_tokens, projected_microcredits, charged_microcredits, enforcement_mode, decision_code)
      VALUES (?, ?, ?, ?, ?, ?, 'client-1', ?, '/v1/chat/completions', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of llm) {
      insertLlm.run(
        rowUuid(`usage:${row.id}`), row.at, rowUuid(`request:${row.id}`), `req_${row.id}`, row.customerId, row.managerId,
        row.model, row.ok ? 200 : 499, row.ok, row.terminalState, row.usageSource, row.input, row.output,
        row.input + row.output, row.cached, BigInt(row.projected), BigInt(row.charged), row.mode, row.code,
      );
    }
    const insertTts = db.prepare(`
      INSERT INTO billing_tts_usage_events
        (usage_id, at, request_id, external_request_id, customer_id, manager_id, service_client_id, engine, endpoint,
         response_status, ok, characters, audio_ms, duration_source, projected_microcredits, charged_microcredits,
         enforcement_mode, decision_code)
      VALUES (?, ?, ?, NULL, ?, 'tts', 'client-1', ?, '/v1/audio/speech', ?, ?, ?, ?, ?, ?, ?, ?, 'billing_tts_settled')
    `);
    for (const row of tts) {
      insertTts.run(
        rowUuid(`tts-usage:${row.id}`), row.at, rowUuid(`tts-request:${row.id}`), row.customerId, row.engine,
        row.ok ? 200 : 500, row.ok, row.characters, row.audioMs, row.durationSource, BigInt(row.projected),
        BigInt(row.charged), row.mode,
      );
    }
  } finally {
    db.close();
  }
}

function seededStore(t, options = {}) {
  const { store, file } = openStore(t, options);
  store.createCustomer({ customerId: CUSTOMER_A, name: "Customer A" });
  store.createCustomer({ customerId: CUSTOMER_B, name: "Customer B" });
  seed(file, { llm: LLM_ROWS, tts: TTS_ROWS });
  return { store, file };
}

function metrics(requests, ok, input, cached, output, projected, charged, estimated, shadow) {
  return {
    requests,
    ok,
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens: input + output,
    projectedMicrocredits: projected,
    chargedMicrocredits: charged,
    estimatedUsageRequests: estimated,
    shadowRequests: shadow,
  };
}

function assertBillingError(fn, code) {
  assert.throws(fn, (error) => error instanceof BillingStoreError && error.code === code && error.status === 400, code);
}

function inspect(file, sql) {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

test("customer × model × day groups use UTC+08:00 day keys and match the hand-computed sums", (t) => {
  const { store } = seededStore(t);
  const summary = store.summarizeUsage({ groupBy: "customer,model,day", tzOffsetMinutes: 480 });
  assert.equal(summary.ok, true);
  assert.equal(summary.kind, "llm");
  assert.deepEqual(summary.groupBy, ["customer", "model", "day"]);
  // Default window: the current billing month at the requested offset.
  assert.equal(summary.from, "2026-09-30T16:00:00.000Z");
  assert.equal(summary.to, "2026-10-31T16:00:00.000Z");
  assert.equal(summary.tzOffsetMinutes, 480);
  assert.equal(summary.truncated, false);
  // r1 is 23:59:59.999 on the 12th locally and r2 is midnight on the 13th; r6
  // and r7 fall outside the local month. Within a day the busiest group comes
  // first, then the keys ascend (the unbound customer sorts first).
  assert.deepEqual(summary.rows, [
    { customerId: CUSTOMER_A, customerName: "Customer A", model: "model-a", day: "2026-10-12", ...metrics(1, 1, 100, 20, 50, "230", "230", 0, 0) },
    { customerId: null, customerName: null, model: "model-a", day: "2026-10-13", ...metrics(1, 1, 0, 0, 0, "0", "0", 0, 1) },
    { customerId: CUSTOMER_A, customerName: "Customer A", model: "model-a", day: "2026-10-13", ...metrics(1, 1, 200, 0, 100, "400", "400", 0, 0) },
    { customerId: CUSTOMER_A, customerName: "Customer A", model: "model-b", day: "2026-10-13", ...metrics(1, 0, 40, 0, 10, "60", "60", 1, 0) },
    { customerId: CUSTOMER_B, customerName: "Customer B", model: "model-a", day: "2026-10-13", ...metrics(1, 1, 1000, 500, 300, "1350", "0", 0, 1) },
  ]);
  assert.deepEqual(summary.totals, metrics(5, 4, 1340, 520, 460, "2040", "690", 1, 2));
});

test("the offset moves both the default month window and the day keys", (t) => {
  const { store } = seededStore(t);
  const utc = store.summarizeUsage({ groupBy: ["day"], tzOffsetMinutes: 0 });
  assert.equal(utc.from, "2026-10-01T00:00:00.000Z");
  assert.equal(utc.to, "2026-11-01T00:00:00.000Z");
  assert.deepEqual(utc.rows, [
    { day: "2026-10-12", ...metrics(2, 2, 300, 20, 150, "630", "630", 0, 0) },
    { day: "2026-10-13", ...metrics(3, 2, 1040, 500, 310, "1410", "60", 1, 2) },
    { day: "2026-10-31", ...metrics(1, 1, 10, 0, 10, "30", "0", 0, 1) },
  ]);

  // The store default comes from the constructor when the query has none.
  const { store: shifted } = seededStore(t, { tzOffsetMinutes: 480 });
  assert.equal(shifted.summarizeUsage({ groupBy: "day" }).tzOffsetMinutes, 480);
  assert.equal(shifted.summarizeUsage({ groupBy: "day" }).rows[0].day, "2026-10-12");

  const hours = store.summarizeUsage({ groupBy: "hour", tzOffsetMinutes: "+480", from: "2026-10-12", to: "2026-10-14" });
  assert.deepEqual(hours.rows.map((row) => [row.hour, row.requests]), [
    ["2026-10-12T23:00", 1],
    ["2026-10-13T00:00", 1],
    ["2026-10-13T11:00", 1],
    ["2026-10-13T13:00", 1],
    ["2026-10-13T14:00", 1],
  ]);
});

test("month keys, explicit ranges, filters, truncation and totals over the whole range", (t) => {
  const { store } = seededStore(t);
  // Date-only bounds are local midnight at the offset, and `to` is exclusive:
  // r7 (local 2026-11-01 00:00) is out until the range ends a day later.
  const months = store.summarizeUsage({ groupBy: "month", tzOffsetMinutes: 480, from: "2026-09-01", to: "2026-11-01" });
  assert.equal(months.from, "2026-08-31T16:00:00.000Z");
  assert.equal(months.to, "2026-10-31T16:00:00.000Z");
  assert.deepEqual(months.rows.map((row) => [row.month, row.requests, row.projectedMicrocredits]), [
    ["2026-09", 1, "30"],
    ["2026-10", 5, "2040"],
  ]);
  const wider = store.summarizeUsage({ groupBy: "month", tzOffsetMinutes: 480, from: "2026-09-01", to: "2026-11-02" });
  assert.deepEqual(wider.rows.map((row) => [row.month, row.requests]), [["2026-09", 1], ["2026-10", 5], ["2026-11", 1]]);
  // ISO bounds with an offset and epoch milliseconds select the same instants.
  const iso = store.summarizeUsage({ groupBy: "month", from: "2026-09-01T00:00:00+08:00", to: String(Date.parse("2026-11-02T00:00:00+08:00")), tzOffsetMinutes: 480 });
  assert.deepEqual(iso.rows, wider.rows);

  const customerOnly = store.summarizeUsage({ groupBy: "model,terminal_state", customerId: CUSTOMER_A.toUpperCase(), tzOffsetMinutes: 480 });
  assert.deepEqual(customerOnly.rows.map((row) => [row.model, row.terminalState, row.requests]), [
    ["model-a", "completed", 2],
    ["model-b", "disconnected", 1],
  ]);
  assert.equal(customerOnly.totals.chargedMicrocredits, "690");

  const llama = store.summarizeUsage({ groupBy: "manager,usage_source,decision_code,enforcement_mode,endpoint", managerId: "LLAMA-MANAGER", tzOffsetMinutes: 480 });
  assert.deepEqual(llama.rows.map((row) => [row.managerId, row.usageSource, row.decisionCode, row.enforcementMode, row.endpoint, row.requests]), [
    ["llama-manager", "estimated", "billing_authorized", "hard", "/v1/chat/completions", 1],
  ]);

  const truncated = store.summarizeUsage({ groupBy: "customer,model,day", tzOffsetMinutes: 480, limit: 2 });
  assert.equal(truncated.truncated, true);
  assert.deepEqual(truncated.rows.map((row) => [row.customerId, row.day]), [[CUSTOMER_A, "2026-10-12"], [null, "2026-10-13"]]);
  assert.deepEqual(truncated.totals, metrics(5, 4, 1340, 520, 460, "2040", "690", 1, 2));

  // An empty groupBy answers totals only.
  const totalsOnly = store.summarizeUsage({ tzOffsetMinutes: 480 });
  assert.deepEqual(totalsOnly.groupBy, []);
  assert.deepEqual(totalsOnly.rows, []);
  assert.equal(totalsOnly.totals.requests, 5);
});

test("microcredit sums above 2^53 stay exact as decimal strings", (t) => {
  const { store, file } = openStore(t);
  store.createCustomer({ customerId: CUSTOMER_A, name: "Customer A" });
  const base = LLM_ROWS[0];
  seed(file, {
    llm: [
      { ...base, id: "big-1", projected: "4503599627370497", charged: "3000000000000001" },
      { ...base, id: "big-2", at: "2026-10-12T18:00:00.000Z", projected: "4503599627370498", charged: "6007199254740992" },
    ],
  });
  const summary = store.summarizeUsage({ groupBy: "customer,month", tzOffsetMinutes: 480 });
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0].projectedMicrocredits, "9007199254740995");
  assert.equal(summary.rows[0].chargedMicrocredits, "9007199254740993");
  assert.equal(summary.totals.projectedMicrocredits, "9007199254740995");
  // Both sums are past Number.MAX_SAFE_INTEGER, where a float sum would round.
  assert.notEqual(String(4503599627370497 + 4503599627370498), summary.rows[0].projectedMicrocredits);
  assert.notEqual(String(Number(summary.rows[0].chargedMicrocredits)), summary.rows[0].chargedMicrocredits);
});

test("tts summaries sum characters and audio, map model to the engine and refuse terminal_state", (t) => {
  const { store } = seededStore(t);
  const summary = store.summarizeUsage({ kind: "TTS", groupBy: "model", tzOffsetMinutes: 480 });
  assert.equal(summary.kind, "tts");
  assert.deepEqual(summary.rows, [
    { model: "qwen-tts", requests: 2, ok: 1, characters: 150, audioMs: 4500, projectedMicrocredits: "75", chargedMicrocredits: "75", missingDurationRequests: 1, shadowRequests: 1 },
    { model: "fish", requests: 1, ok: 1, characters: 10, audioMs: 1000, projectedMicrocredits: "5", chargedMicrocredits: "0", missingDurationRequests: 0, shadowRequests: 1 },
  ]);
  assert.deepEqual(summary.totals, { requests: 3, ok: 2, characters: 160, audioMs: 5500, projectedMicrocredits: "80", chargedMicrocredits: "75", missingDurationRequests: 1, shadowRequests: 2 });
  const byCustomer = store.summarizeUsage({ kind: "tts", groupBy: "customer,usage_source", tzOffsetMinutes: 480 });
  assert.deepEqual(byCustomer.rows.map((row) => [row.customerName, row.usageSource, row.requests]), [
    [null, "missing", 1],
    ["Customer A", "measured", 1],
    ["Customer B", "reported", 1],
  ]);
  assertBillingError(() => store.summarizeUsage({ kind: "tts", groupBy: "terminal_state" }), "billing_invalid_group_by");
});

test("the groupBy whitelist and every query parameter are validated", (t) => {
  const { store } = seededStore(t);
  assert.deepEqual(store.summarizeUsage({ groupBy: " Customer ,day,day" }).groupBy, ["customer", "day"]);
  for (const groupBy of ["client", "customer;drop table billing_usage_events", "u.model", "customer,,day", ["customer", 1]]) {
    assertBillingError(() => store.summarizeUsage({ groupBy }), "billing_invalid_group_by");
  }
  for (const tzOffsetMinutes of [4.5, "8h", "480 minutes", 900, "-841", "1e3"]) {
    assertBillingError(() => store.summarizeUsage({ groupBy: "day", tzOffsetMinutes }), "billing_invalid_tz_offset");
  }
  assert.equal(store.summarizeUsage({ groupBy: "day", tzOffsetMinutes: "-0" }).tzOffsetMinutes, 0);
  assert.equal(store.summarizeUsage({ groupBy: "day", tzOffsetMinutes: -840 }).tzOffsetMinutes, -840);
  for (const from of ["yesterday", "2026-02-30", "2026-10-13T00:00:00", "-1", "10000-01-01T00:00:00Z", 1.5]) {
    assertBillingError(() => store.summarizeUsage({ groupBy: "day", from }), "billing_invalid_time");
  }
  assertBillingError(() => store.summarizeUsage({ from: "2026-10-14", to: "2026-10-14" }), "billing_invalid_range");
  assertBillingError(() => store.summarizeUsage({ from: "2026-11-01" }), "billing_invalid_range");
  assertBillingError(() => store.summarizeUsage({ from: "2025-01-01", to: "2026-10-01" }), "billing_range_too_large");
  assertBillingError(() => store.summarizeUsage({ kind: "audio" }), "billing_invalid_kind");
  assertBillingError(() => store.summarizeUsage({ limit: 0 }), "billing_invalid_integer");
  assertBillingError(() => store.summarizeUsage({ limit: 1001 }), "billing_invalid_integer");
  assertBillingError(() => store.summarizeUsage({ sort: "requests" }), "billing_unknown_field");
  assertBillingError(() => store.summarizeUsage({ customerId: "not-a-uuid" }), "billing_invalid_uuid");
  assertBillingError(() => store.summarizeUsage({ managerId: "vllm manager" }), "billing_invalid_input");
});

test("read paths prepare only SELECT statements and leave triggers and rows intact", (t) => {
  const prepared = [];
  const executed = [];
  class SpyDatabase extends DatabaseSync {
    prepare(sql) {
      prepared.push(sql);
      return super.prepare(sql);
    }

    exec(sql) {
      executed.push(sql);
      return super.exec(sql);
    }
  }
  const { store, file } = seededStore(t, { DatabaseSync: SpyDatabase });
  const tables = ["billing_usage_events", "billing_tts_usage_events", "billing_wallet_ledger", "billing_admin_audit", "billing_request_reservations", "billing_customers"];
  const counts = () => tables.map((table) => [table, Number(inspect(file, `SELECT COUNT(*) AS n FROM ${table}`)[0].n)]);
  const before = counts();
  prepared.length = 0;
  executed.length = 0;

  store.summarizeUsage({ groupBy: "customer,model,month", tzOffsetMinutes: 480 });
  store.summarizeUsage({ groupBy: ALL_LLM_GROUPS, tzOffsetMinutes: -300, from: "2026-09-01", to: "2026-11-02", limit: 3 });
  store.summarizeUsage({ kind: "tts", groupBy: "customer,day" });
  store.getUsageByExternalRequestId(["req_r1", "req_r4"]);
  store.lookupCustomerForCredential("vllm-manager", "client-1");
  const page = store.listUsage({ window: "all", limit: 2 });
  store.listUsage({ window: "all", limit: 2, cursor: encodeUsageCursor(page[1]) });

  assert.ok(prepared.length >= 8, "the read paths ran their queries");
  for (const sql of prepared) {
    assert.match(sql, /^\s*SELECT\b/i, sql);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|PRAGMA|ATTACH|VACUUM)\b/i, sql);
  }
  assert.deepEqual(executed, [], "no transaction or schema statement on a read path");
  assert.deepEqual(counts(), before);

  const triggers = inspect(file, "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").map((row) => row.name);
  assert.deepEqual(triggers, IMMUTABLE_TRIGGERS);
  const indexes = inspect(file, "SELECT name FROM sqlite_master WHERE type='index'").map((row) => row.name);
  for (const name of ["idx_billing_usage_at", "idx_billing_usage_external", "idx_billing_tts_usage_at"]) assert.ok(indexes.includes(name), name);
  // The triggers still reject edits after the new indexes were added.
  const db = new DatabaseSync(file);
  try {
    assert.throws(() => db.exec("UPDATE billing_usage_events SET charged_microcredits=0"), /immutable/);
    assert.throws(() => db.exec("DELETE FROM billing_tts_usage_events"), /immutable/);
  } finally {
    db.close();
  }
});

function provision(store) {
  const plan = store.createPlan({ code: "summary-plan", name: "Summary plan", enforcementMode: "hard" });
  const customer = store.createCustomer({ name: "Bound customer", planId: plan.planId });
  store.bindCredential({ customerId: customer.customerId, managerId: "vllm-manager", serviceClientId: "client-1" });
  store.adjustBalance({ customerId: customer.customerId, deltaMicrocredits: "1000000", reason: "Test funding", idempotencyKey: crypto.randomUUID() });
  store.upsertPrice({ planId: plan.planId, managerId: "vllm-manager", model: "model-a", inputPerMillionMicrocredits: "1000000", outputPerMillionMicrocredits: "2000000" });
  return { plan, customer };
}

function settleOne(store, externalRequestId) {
  const authorization = store.authorizeRequest({
    requestId: crypto.randomUUID(),
    externalRequestId,
    managerId: "vllm-manager",
    clientId: "client-1",
    model: "model-a",
    endpoint: "/v1/chat/completions",
    estimatedInputTokens: 100,
    maxOutputTokens: 100,
  });
  return store.settleRequest({
    requestId: authorization.requestId,
    externalRequestId,
    managerId: "vllm-manager",
    clientId: "client-1",
    model: "model-a",
    status: 200,
    ok: true,
    terminalState: "completed",
    usageSource: "reported",
    inputTokens: 100,
    outputTokens: 50,
  });
}

test("listUsage pages by (at, usage_id) without repeats when rows share a timestamp", (t) => {
  let current = new Date("2026-10-13T08:00:00.000Z");
  const { store } = openStore(t, { clock: () => new Date(current) });
  provision(store);
  for (let index = 0; index < 5; index += 1) settleOne(store, `req_same_${index}`);
  current = new Date("2026-10-13T09:00:00.000Z");
  settleOne(store, "req_later");

  const all = store.listUsage({ window: "all", limit: 100 });
  assert.equal(all.length, 6);
  assert.equal(all[0].externalRequestId, "req_later");
  for (let index = 1; index < all.length; index += 1) {
    const previous = all[index - 1];
    assert.ok(previous.at > all[index].at || (previous.at === all[index].at && previous.usageId > all[index].usageId), "ordered by at DESC, usage_id DESC");
  }
  const seen = [];
  let cursor = null;
  do {
    const page = store.listUsage({ window: "all", limit: 2, ...(cursor ? { cursor } : {}) });
    seen.push(...page.map((item) => item.usageId));
    cursor = page.length === 2 ? encodeUsageCursor(page[page.length - 1]) : null;
  } while (cursor);
  assert.deepEqual(seen, all.map((item) => item.usageId));
  // Offset paging keeps working and agrees with the keyset order.
  assert.deepEqual(store.listUsage({ window: "all", limit: 2, offset: 2 }).map((item) => item.usageId), seen.slice(2, 4));

  assert.deepEqual(decodeUsageCursor(encodeUsageCursor(all[2])), { at: all[2].at, usageId: all[2].usageId });
  assert.equal(encodeUsageCursor({ at: "yesterday", usageId: all[0].usageId }), null);
  for (const cursorValue of ["not base64!", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ t: "2026-10-13", id: "x" })).toString("base64url")]) {
    assertBillingError(() => store.listUsage({ cursor: cursorValue }), "billing_invalid_cursor");
  }
});

test("getUsageByExternalRequestId returns the usage event and its reservation decision", (t) => {
  const { store } = openStore(t);
  provision(store);
  const settled = settleOne(store, "req_k3m9q2x7p4a8c5d1h6j0");
  const found = store.getUsageByExternalRequestId("req_k3m9q2x7p4a8c5d1h6j0");
  assert.equal(found.usage.requestId, settled.requestId);
  assert.equal(found.usage.externalRequestId, "req_k3m9q2x7p4a8c5d1h6j0");
  // 100 input × 1 + 50 output × 2 microcredits; the reservation priced 100 + 100 × 2.
  assert.equal(found.usage.projectedMicrocredits, "200");
  assert.equal(found.usage.chargedMicrocredits, "200");
  assert.equal(found.usage.usageSource, "reported");
  assert.equal(found.usage.terminalState, "completed");
  assert.equal(found.usage.decisionCode, "billing_authorized");
  assert.deepEqual(found.reservation, { enforcementMode: "hard", decisionCode: "billing_authorized", reservationMicrocredits: "300" });
  // Either of the request's ids finds it (request_id or manager_request_id).
  assert.deepEqual(store.getUsageByExternalRequestId(["mgr_unknown", "req_k3m9q2x7p4a8c5d1h6j0"]), found);
  assert.equal(store.getUsageByExternalRequestId("req_missing"), null);
  assert.equal(store.getUsageByExternalRequestId(""), null);
  assert.equal(store.getUsageByExternalRequestId(undefined), null);
  assertBillingError(() => store.getUsageByExternalRequestId("x".repeat(129)), "billing_invalid_input");
});

test("lookupCustomerForCredential answers active bindings and caches for 60 s", (t) => {
  let current = new Date(NOW);
  const { store, file } = openStore(t, { clock: () => new Date(current) });
  const { customer } = provision(store);
  const found = store.lookupCustomerForCredential("VLLM-manager", "client-1");
  assert.equal(found.customerId, customer.customerId);
  assert.equal(found.customerStatus, "active");
  assert.match(found.bindingId, /^[0-9a-f-]{36}$/);
  found.customerId = "mutated";
  assert.equal(store.lookupCustomerForCredential("vllm-manager", "client-1").customerId, customer.customerId);

  // A change made outside this store is seen once the 60 s entry expires.
  const db = new DatabaseSync(file);
  try {
    db.exec("UPDATE billing_credential_bindings SET active=0");
  } finally {
    db.close();
  }
  current = new Date(NOW.getTime() + 59_000);
  assert.equal(store.lookupCustomerForCredential("vllm-manager", "client-1").customerId, customer.customerId);
  current = new Date(NOW.getTime() + 61_000);
  assert.equal(store.lookupCustomerForCredential("vllm-manager", "client-1"), null);
  // A rebind through the store drops the cached "unbound" answer at once.
  store.bindCredential({ customerId: customer.customerId, managerId: "vllm-manager", serviceClientId: "client-1", active: true });
  assert.equal(store.lookupCustomerForCredential("vllm-manager", "client-1").customerId, customer.customerId);

  assert.equal(store.lookupCustomerForCredential("vllm-manager", "client-2"), null);
  assert.equal(store.lookupCustomerForCredential("bad manager", "client-1"), null);
  assert.equal(store.lookupCustomerForCredential("vllm-manager", ""), null);
});

function responseState() {
  const state = { status: 0, data: null };
  return {
    state,
    res: {
      writeHead(status) { state.status = status; },
      end(body) { state.data = body ? JSON.parse(body) : null; },
    },
  };
}

function createHandler(store) {
  return createBillingHttpHandler({
    getStore: () => store,
    readRequestBody: async () => Buffer.alloc(0),
    sendJson(res, data, status = 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    },
    verifyBillingRequest: core.verifyBillingRequest,
    getTrustToken: () => "billing-summary-test-token",
    isLocalAddress: core.isLocalAddress,
    extractHostname: core.extractHostname,
  });
}

async function get(handler, pathAndQuery, headers = {}) {
  const out = responseState();
  const req = { method: "GET", url: pathAndQuery, headers: { host: "127.0.0.1:5176", ...headers }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(await handler(req, out.res, new URL(`http://127.0.0.1${pathAndQuery}`)), true);
  return out.state;
}

test("GET /api/billing/usage/summary passes whitelisted parameters and answers errors in the envelope", async (t) => {
  const calls = [];
  const fake = {
    summarizeUsage(options) {
      calls.push(options);
      return { ok: true, kind: "llm", groupBy: ["customer", "day"], rows: [], totals: { requests: 0 }, truncated: false };
    },
  };
  const handler = createHandler(fake);
  const ok = await get(handler, "/api/billing/usage/summary?kind=llm&groupBy=customer&groupBy=day&tzOffsetMinutes=480&limit=10&from=2026-10-01&to=&customerId=" + CUSTOMER_A);
  assert.equal(ok.status, 200);
  assert.deepEqual(calls[0], { kind: "llm", groupBy: "customer,day", from: "2026-10-01", customerId: CUSTOMER_A, tzOffsetMinutes: "480", limit: "10" });
  assert.equal(ok.data.ok, true);

  const unknown = await get(handler, "/api/billing/usage/summary?groupBy=day&group_by=model");
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.data, { ok: false, error: { code: "unknown_parameter", message: "Unknown query parameter: group_by." } });
  const duplicate = await get(handler, "/api/billing/usage/summary?limit=1&limit=2");
  assert.equal(duplicate.data.error.code, "duplicate_parameter");
  assert.equal(calls.length, 1);

  const proxied = await get(handler, "/api/billing/usage/summary", { "x-forwarded-for": "203.0.113.5" });
  assert.equal(proxied.status, 403);
  assert.equal(proxied.data.error.code, "billing_admin_local_only");
  const lan = await get(handler, "/api/billing/usage/summary", { host: "192.0.2.10:5176" });
  assert.equal(lan.status, 403);

  const { store } = seededStore(t);
  const real = createHandler(store);
  const summary = await get(real, "/api/billing/usage/summary?groupBy=customer,model,month&tzOffsetMinutes=480");
  assert.equal(summary.status, 200);
  assert.equal(summary.data.rows.length, 4);
  assert.equal(summary.data.totals.projectedMicrocredits, "2040");
  const invalid = await get(real, "/api/billing/usage/summary?groupBy=client");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.ok, false);
  assert.equal(invalid.data.error.code, "billing_invalid_group_by");
  // The older billing routes keep their flat error shape.
  const legacy = await get(real, "/api/billing/usage?window=week");
  assert.deepEqual(Object.keys(legacy.data).sort(), ["code", "message", "ok"]);
});

test("GET /api/billing/usage keeps items and adds nextCursor for a full page", async (t) => {
  const { store } = seededStore(t);
  const handler = createHandler(store);
  const first = await get(handler, "/api/billing/usage?window=all&limit=3");
  assert.equal(first.status, 200);
  assert.equal(first.data.ok, true);
  assert.equal(first.data.items.length, 3);
  assert.equal(typeof first.data.nextCursor, "string");
  const second = await get(handler, `/api/billing/usage?window=all&limit=3&cursor=${first.data.nextCursor}`);
  const third = await get(handler, `/api/billing/usage?window=all&limit=3&cursor=${second.data.nextCursor}`);
  assert.equal(third.data.items.length, 1);
  assert.equal(third.data.nextCursor, null);
  const ids = [...first.data.items, ...second.data.items, ...third.data.items].map((item) => item.externalRequestId);
  assert.deepEqual(ids, ["req_r7", "req_r5", "req_r4", "req_r3", "req_r2", "req_r1", "req_r6"]);
  const bad = await get(handler, "/api/billing/usage?cursor=bogus");
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "billing_invalid_cursor");
});
