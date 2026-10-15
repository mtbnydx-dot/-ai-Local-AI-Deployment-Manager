"use strict";

// The /v1/me family (05 §8.5, PUB-13): the response schema, the pace and
// projection math at the period edges, telemetry-or-counters usage, the
// guarded writes (scope, same-origin, rate limit, audit), the CSV and the
// separate meta bucket.
//
// The pure parts run on fixtures. The HTTP parts run the real entry in-process
// on PUBLIC (access store and limiter are the real ones, in a temp dir). The
// telemetry cases run createMeRoutes behind a fake pipeline, because the entry
// of the harness has no telemetry store.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { listen, loadEntry, request, serveEntry } = require("./helpers/entry-harness");
const { createKeysStore } = require("../lib/keys-store");
const { createLimiter } = require("../lib/limiter");
const {
  createMeRoutes,
  credits6,
  normalizeOrigins,
  paceOf,
  parseUsageQuery,
  usageCsv,
  usageRowsFromSeries,
} = require("../lib/me-routes");
const { sendPublicError } = require("../lib/public-errors");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BOM = "﻿";

// ---- pace and projection (§8.5) ---------------------------------------------------

test("pace compares used with limit x elapsed fraction and projects linearly", () => {
  const start = Date.UTC(2026, 9, 14);
  const end = start + DAY;
  const limit = 2_000_000;
  const at = (hours) => start + hours * HOUR;

  // Nothing used: ok, no projection, also at the very start and the very end.
  assert.deepEqual(paceOf({ limit, used: 0, start, end, now: start }), { remaining: limit, pace: "ok", projectedExhaustionAt: null });
  assert.equal(paceOf({ limit, used: 0, start, end, now: end }).pace, "ok");

  // Exactly on the diagonal is ok (<= 1.0); one token over is ahead.
  assert.equal(paceOf({ limit, used: 1_000_000, start, end, now: at(12) }).pace, "ok");
  assert.equal(paceOf({ limit, used: 1_000_001, start, end, now: at(12) }).pace, "ahead");

  // 1.5M of 2M after 12 h: 125k per hour, 0.5M left, empty 4 h later.
  const ahead = paceOf({ limit, used: 1_500_000, start, end, now: at(12) });
  assert.equal(ahead.pace, "ahead");
  assert.equal(ahead.remaining, 500_000);
  assert.equal(ahead.projectedExhaustionAt, new Date(at(16)).toISOString());

  // A rate that lasts past the period end is not a projection.
  assert.equal(paceOf({ limit, used: 600_000, start, end, now: at(12) }).projectedExhaustionAt, null);
  // Landing exactly on the end is not inside the period either.
  assert.equal(paceOf({ limit, used: 1_000_000, start, end, now: at(12) }).projectedExhaustionAt, null);

  // Exhausted wins over ahead, also over the limit, and has no projection.
  for (const used of [limit, limit + 5_000]) {
    assert.deepEqual(paceOf({ limit, used, start, end, now: at(3) }), { remaining: 0, pace: "exhausted", projectedExhaustionAt: null });
  }

  // Right after the start a single request is already ahead of the diagonal,
  // but no rate can be extrapolated from zero elapsed time.
  assert.deepEqual(paceOf({ limit, used: 10, start, end, now: start }), { remaining: limit - 10, pace: "ahead", projectedExhaustionAt: null });
  // At and after the end the fraction is 1: at the limit exhausted, below it ok.
  assert.equal(paceOf({ limit, used: limit - 1, start, end, now: end }).pace, "ok");
  assert.equal(paceOf({ limit, used: limit - 1, start, end, now: end + HOUR }).projectedExhaustionAt, null);
  // A clock before the start clamps to the start.
  assert.equal(paceOf({ limit, used: 0, start, end, now: start - HOUR }).pace, "ok");

  // No cap: no quota block.
  assert.equal(paceOf({ limit: null, used: 5, start, end, now: start }), null);
  assert.equal(paceOf({ limit: 0, used: 5, start, end, now: start }), null);
});

test("credits are fixed to six decimals and null when unreadable", () => {
  assert.equal(credits6("12500000"), "12.500000");
  assert.equal(credits6("0"), "0.000000");
  assert.equal(credits6("3200000"), "3.200000");
  assert.equal(credits6("-1500000"), "-1.500000");
  assert.equal(credits6("1234567"), "1.234567");
  assert.equal(credits6(""), null);
  assert.equal(credits6("abc"), null);
});

test("origins are exact https origins plus the two loopback http forms", () => {
  assert.deepEqual(normalizeOrigins(["https://App.Example.com", "https://app.example.com", "http://localhost:3000", "http://127.0.0.1"]), [
    "https://app.example.com",
    "http://localhost:3000",
    "http://127.0.0.1",
  ]);
  assert.deepEqual(normalizeOrigins([]), []);
  for (const bad of [["*"], ["http://example.com"], ["https://a.example/path"], ["https://a.example?x=1"], ["ftp://a.example"], ["not a url"], [""], [5], ["http://localhost.evil.example"]]) {
    assert.throws(() => normalizeOrigins(bad), (error) => error.status === 400 && error.param === "origins", JSON.stringify(bad));
  }
  assert.throws(() => normalizeOrigins("https://a.example"), (error) => error.status === 400);
  assert.equal(normalizeOrigins(Array.from({ length: 10 }, (_, i) => `https://a${i}.example`)).length, 10);
  assert.throws(() => normalizeOrigins(Array.from({ length: 11 }, (_, i) => `https://a${i}.example`)), (error) => error.status === 400);
});

test("the usage query defaults to 30 days and allows at most 92", () => {
  const today = "2026-10-15";
  const parse = (query) => parseUsageQuery(new URLSearchParams(query), { today });
  assert.deepEqual(parse(""), { from: "2026-09-16", to: today, byModel: false });
  assert.deepEqual(parse("from=2026-10-01&to=2026-10-03&group_by=day,model"), { from: "2026-10-01", to: "2026-10-03", byModel: true });
  assert.equal(parse("group_by=day").byModel, false);
  // 92 inclusive days pass, 93 do not.
  assert.equal(parse("from=2026-07-15&to=2026-10-14").from, "2026-07-15");
  assert.throws(() => parse("from=2026-07-14&to=2026-10-14"), (error) => error.status === 400 && error.param === "from");
  assert.throws(() => parse("from=2026-10-05&to=2026-10-04"), (error) => error.param === "from");
  assert.throws(() => parse("from=2026-02-30"), (error) => error.param === "from");
  assert.throws(() => parse("to=yesterday"), (error) => error.param === "to");
  for (const bad of ["group_by=model", "group_by=hour", "group_by=day,day", "group_by="]) {
    assert.throws(() => parse(bad), (error) => error.param === "group_by", bad);
  }
});

test("series fold into day rows and the CSV is BOM-prefixed and formula-escaped", () => {
  const day = (date) => Date.parse(`${date}T00:00:00.000Z`);
  const series = (metric, group, values) => ({ metric, unit: "x", group, points: values.map((value, index) => [day("2026-10-01") + index * DAY, value]) });
  const body = {
    series: [
      series("req.count", { model: "alpha" }, [3, 0, null]),
      series("tok.prompt", { model: "alpha" }, [100, 0, null]),
      series("tok.cached", { model: "alpha" }, [40, 0, null]),
      series("tok.output", { model: "alpha" }, [50, 0, null]),
      series("req.errors", { model: "alpha" }, [1, 0, null]),
      series("req.count", { model: "=HYPERLINK(\"http://x\")" }, [0, 2, 0]),
      series("req.count", { other: true }, [0, 0, 1]),
      series("req.count", { model: "outside" }, [9, 9, 9, 9]),
    ],
  };
  const grouped = usageRowsFromSeries(body, { from: "2026-10-01", to: "2026-10-03", byModel: true, tzOffsetMinutes: 0 });
  assert.deepEqual(grouped.map((row) => [row.date, row.model, row.requests]), [
    ["2026-10-01", "alpha", 3],
    ["2026-10-01", "outside", 9],
    ["2026-10-02", "=HYPERLINK(\"http://x\")", 2],
    ["2026-10-02", "outside", 9],
    ["2026-10-03", "other", 1],
    ["2026-10-03", "outside", 9],
  ]);
  assert.deepEqual(grouped[0], { date: "2026-10-01", model: "alpha", requests: 3, input_tokens: 100, cached_input_tokens: 40, output_tokens: 50, errors: 1 });

  const flat = usageRowsFromSeries({ series: [series("req.count", {}, [4, null, 5])] }, { from: "2026-10-01", to: "2026-10-04", byModel: false, tzOffsetMinutes: 0 });
  assert.deepEqual(flat.map((row) => [row.date, row.requests]), [["2026-10-01", 4], ["2026-10-02", 0], ["2026-10-03", 5], ["2026-10-04", 0]]);
  // A timezone moves the day a point belongs to.
  const shifted = usageRowsFromSeries({ series: [{ metric: "req.count", group: {}, points: [[day("2026-10-01") - 8 * HOUR, 7]] }] }, { from: "2026-10-01", to: "2026-10-01", byModel: false, tzOffsetMinutes: 480 });
  assert.equal(shifted[0].requests, 7);

  const csv = usageCsv(grouped);
  assert.ok(csv.startsWith(BOM), "BOM first");
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], '"date","model","requests","input_tokens","cached_input_tokens","output_tokens","errors"');
  assert.ok(lines.includes('"2026-10-02","\'=HYPERLINK(""http://x"")","2","0","0","0","0"'), lines.join("\n"));
  assert.equal(lines.at(-1), "", "ends with CRLF");
  for (const line of lines.slice(1, -1)) assert.doesNotMatch(line.split(",")[1], /^"[=+@-]/);
});

// ---- the real entry on PUBLIC -----------------------------------------------------

let entry = null;
let publicPort = 0;
const servers = [];

async function setup() {
  if (entry) return;
  const loaded = await loadEntry();
  entry = loaded.entry;
  const pub = entry.createPublicServer();
  servers.push(pub);
  publicPort = await listen(pub);
}

// Every HTTP test starts with empty buckets: all calls come from one address,
// and the pre-auth bucket (30 burst) would otherwise answer first.
async function fresh() {
  await setup();
  entry.resetEntryRateLimitBuckets();
}

test.after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (entry) {
    await entry.stopTelemetry?.();
    entry.closeAccessStore();
    try {
      entry.getBillingStore().close();
    } catch {
      // Already closed.
    }
  }
});

let keySeq = 0;
const SELF_SCOPES = ["models.read", "chat", "self.read", "self.rotate", "self.origins"];

function createKey(input = {}) {
  keySeq += 1;
  const { key, secret } = entry.getAccessStore().createKey({
    class: "friend",
    models: ["qwen*"],
    scopes: SELF_SCOPES,
    ...input,
    name: `me routes key ${keySeq}`,
  }, { actor: "test" });
  return { id: key.id, secret, preview: key.preview };
}

function call(key, pathname, { method = "GET", body, headers = {}, accept } = {}) {
  return request(publicPort, pathname, {
    method,
    headers: { host: "127.0.0.1", authorization: `Bearer ${key.secret}`, ...(accept ? { "accept-language": accept } : {}), ...headers },
    body,
  });
}

const isIso = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const nullable = (check) => (value) => value === null || check(value);
const isInt = (value) => Number.isInteger(value) && value >= 0;

// A structural check: every key present, no extra key, each value passes.
function shape(value, spec, where = "$") {
  if (typeof spec === "function") {
    assert.ok(spec(value), `${where} = ${JSON.stringify(value)}`);
    return;
  }
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${where} is an object`);
  assert.deepEqual(Object.keys(value).sort(), Object.keys(spec).sort(), `${where} keys`);
  for (const [name, inner] of Object.entries(spec)) shape(value[name], inner, `${where}.${name}`);
}

const ME_SCHEMA = {
  object: (v) => v === "key",
  id: (v) => /^k_/.test(v),
  name: (v) => typeof v === "string",
  preview: (v) => typeof v === "string" && v.length > 4,
  class: (v) => typeof v === "string",
  status: (v) => v === "active",
  created_at: isIso,
  expires_at: nullable(isIso),
  scopes: (v) => Array.isArray(v) && v.every((s) => typeof s === "string"),
  models: { patterns: (v) => Array.isArray(v), available: (v) => Array.isArray(v) },
  limits: {
    rpm: nullable(isInt),
    tpm: nullable(isInt),
    max_concurrent: nullable(isInt),
    max_output_tokens: nullable(isInt),
    daily_tokens: nullable(isInt),
    monthly_tokens: nullable(isInt),
  },
  rate_limit: {
    requests: { limit: isInt, remaining: isInt, reset_seconds: isInt },
    tokens: nullable(() => true),
  },
  usage: {
    today: { requests: isInt, input_tokens: isInt, cached_input_tokens: isInt, output_tokens: isInt, resets_at: isIso },
    month: { requests: isInt, input_tokens: isInt, cached_input_tokens: isInt, output_tokens: isInt, resets_at: isIso },
  },
  quota: {
    daily_tokens: nullable(() => true),
    monthly_tokens: nullable(() => true),
  },
  billing: (v) => v === null || typeof v === "object",
  allowed_origins: (v) => Array.isArray(v),
  self_service: { rotate: (v) => typeof v === "boolean", origins: (v) => typeof v === "boolean" },
  announcements: (v) => Array.isArray(v),
  request_id: (v) => /^req_[a-z2-7]{20}$/.test(v),
};
const QUOTA_SCHEMA = {
  limit: isInt,
  used: isInt,
  remaining: isInt,
  pace: (v) => ["ok", "ahead", "exhausted"].includes(v),
  projected_exhaustion_at: nullable(isIso),
};

test("GET /v1/me matches the 8.5 schema", async () => {
  await fresh();
  const store = entry.getAccessStore();
  const key = createKey({
    limits: { rpm: 30, tpm: 100000, maxConcurrent: 2, maxOutputTokens: 8192, dailyTokens: 2_000_000 },
    expiresAt: "2999-01-12T00:00:00.000Z",
  });
  store.createAnnouncement({ severity: "maintenance", title: { zh: "维护窗口", en: "Maintenance window" }, published: true, startsAt: "2020-01-01T00:00:00.000Z" }, { actor: "test" });
  store.createAnnouncement({ severity: "info", title: { zh: "草稿", en: "Draft" }, published: false }, { actor: "test" });
  store.createAnnouncement({ severity: "info", title: { zh: "已结束", en: "Over" }, published: true, startsAt: "2020-01-01T00:00:00.000Z", endsAt: "2020-02-01T00:00:00.000Z" }, { actor: "test" });
  store.addUsage(key.id, { requests: 2, inputTokens: 1000, cachedInputTokens: 400, outputTokens: 500, errors: 0 });

  const answer = await call(key, "/v1/me", { accept: "en-US" });
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.headers["cache-control"], "no-store");
  assert.match(String(answer.headers["content-type"]), /application\/json/);
  const me = answer.json;
  shape(me, { ...ME_SCHEMA, quota: { daily_tokens: QUOTA_SCHEMA, monthly_tokens: (v) => v === null } });
  assert.equal(me.request_id, answer.headers["x-request-id"]);
  assert.equal(me.id, key.id);
  assert.equal(me.preview, key.preview);
  assert.equal(me.class, "friend");
  assert.equal(me.expires_at, "2999-01-12T00:00:00.000Z");
  assert.deepEqual(me.scopes.slice().sort(), SELF_SCOPES.slice().sort());
  assert.deepEqual(me.models.patterns, ["qwen*"]);
  assert.deepEqual(me.limits, { rpm: 30, tpm: 100000, max_concurrent: 2, max_output_tokens: 8192, daily_tokens: 2_000_000, monthly_tokens: null });
  assert.deepEqual(me.self_service, { rotate: true, origins: true });
  assert.equal(me.billing, null);
  assert.deepEqual(me.allowed_origins, []);
  // The tokens block exists because the key has a tpm limit.
  shape(me.rate_limit.tokens, { limit: isInt, remaining: isInt, reset_seconds: isInt });
  assert.equal(me.rate_limit.requests.limit, 30);
  assert.equal(me.rate_limit.tokens.limit, 100000);

  // usage from the counters (no telemetry store in this entry).
  assert.equal(me.usage.today.requests, 2);
  assert.equal(me.usage.today.input_tokens, 1000);
  assert.equal(me.usage.today.cached_input_tokens, 400);
  assert.equal(me.usage.today.output_tokens, 500);
  assert.deepEqual(me.usage.month.requests, 2);
  assert.ok(Date.parse(me.usage.today.resets_at) > Date.now());
  assert.ok(Date.parse(me.usage.month.resets_at) >= Date.parse(me.usage.today.resets_at));
  assert.equal(me.quota.daily_tokens.limit, 2_000_000);
  assert.equal(me.quota.daily_tokens.used, 1500);
  assert.equal(me.quota.daily_tokens.remaining, 2_000_000 - 1500);

  // Published announcements that have not ended, titled by Accept-Language.
  assert.deepEqual(me.announcements.map((item) => [item.severity, item.title]), [["maintenance", "Maintenance window"]]);
  shape(me.announcements[0], { id: (v) => /^an_/.test(v), severity: (v) => v === "maintenance", title: (v) => typeof v === "string", starts_at: isIso, ends_at: (v) => v === null });
  const zh = await call(key, "/v1/me", { accept: "zh-CN,zh;q=0.9" });
  assert.equal(zh.json.announcements[0].title, "维护窗口");

  // /gateway/me on the PUBLIC listener is the same route.
  const alias = await call(key, "/gateway/me");
  assert.equal(alias.status, 200, alias.text);
  assert.equal(alias.json.id, key.id);
});

test("/gateway/me on ADMIN is the same route and needs a key", async (t) => {
  await fresh();
  const adminPort = await serveEntry(t, entry);
  const key = createKey();
  const answer = await request(adminPort, "/gateway/me", { headers: { authorization: `Bearer ${key.secret}` } });
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.json.id, key.id);
  assert.equal(answer.json.object, "key");
  assert.match(String(answer.headers["x-request-id"]), /^req_/);
  const usage = await request(adminPort, "/gateway/me/usage?from=2026-10-01&to=2026-10-02", { headers: { authorization: `Bearer ${key.secret}` } });
  assert.equal(usage.status, 200, usage.text);
  assert.equal(usage.json.data.length, 2);
  // Without a key the owner's loopback is not a key holder: the route needs one.
  const keyless = await request(adminPort, "/gateway/me");
  assert.ok([400, 401, 403].includes(keyless.status), keyless.text);
});

test("a key without self.read, or no key at all, is refused with the taxonomy codes", async () => {
  await fresh();
  const narrow = createKey({ scopes: ["models.read", "chat"] });
  const denied = await call(narrow, "/v1/me");
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "scope_denied");
  const anonymous = await request(publicPort, "/v1/me", { headers: { host: "127.0.0.1" } });
  assert.equal(anonymous.status, 401);
  const wrong = await request(publicPort, "/v1/me", { method: "POST", headers: { host: "127.0.0.1", authorization: `Bearer ${narrow.secret}` }, body: {} });
  assert.equal(wrong.status, 405);
  assert.match(String(wrong.headers.allow), /GET/);
  assert.equal(wrong.json.error.code, "method_not_allowed");
});

test("reading /v1/me does not touch the rpm and tpm buckets", async () => {
  await fresh();
  const key = createKey({ limits: { rpm: 5, tpm: 50000 } });
  for (let n = 1; n <= 4; n += 1) {
    const read = await call(key, "/v1/me");
    assert.equal(read.status, 200, read.text);
    assert.equal(read.json.rate_limit.requests.limit, 5);
    assert.equal(read.json.rate_limit.requests.remaining, 5);
    assert.equal(read.json.rate_limit.tokens.remaining, 50000);
  }
});

test("usage comes from the counters here: zero-filled days, source, and the 92 day cap", async () => {
  await fresh();
  const key = createKey();
  const store = entry.getAccessStore();
  store.addUsage(key.id, { requests: 3, inputTokens: 300, cachedInputTokens: 100, outputTokens: 60, errors: 1 });
  const tz = store.getUsage(key.id).tzOffsetMinutes;
  const today = new Date(Date.now() + tz * 60_000).toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * DAY).toISOString().slice(0, 10);

  const answer = await call(key, `/v1/me/usage?from=${from}&to=${today}&group_by=day,model`);
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.json.object, "list");
  assert.equal(answer.json.granularity, "day");
  assert.equal(answer.json.source, "counters");
  assert.equal(answer.json.data.length, 3);
  assert.deepEqual(answer.json.data[2], { date: today, requests: 3, input_tokens: 300, cached_input_tokens: 100, output_tokens: 60, errors: 1 });
  assert.deepEqual(answer.json.data[0], { date: from, requests: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, errors: 0 });

  const tooLong = await call(key, "/v1/me/usage?from=2020-01-01&to=2020-06-01");
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.error.param, "from");
  const badDate = await call(key, "/v1/me/usage?from=nope");
  assert.equal(badDate.status, 400);
  assert.equal(badDate.json.error.code, "invalid_request");

  const requests = await call(key, "/v1/me/requests?limit=10");
  assert.equal(requests.status, 200);
  assert.deepEqual(requests.json, { object: "list", data: [], next_cursor: null, source: "counters" });
  assert.equal((await call(key, "/v1/me/requests?limit=101")).status, 400);
  assert.equal((await call(key, "/v1/me/requests?limit=0")).status, 400);
});

test("the usage CSV is BOM-prefixed, CRLF, and sent as a download", async () => {
  await fresh();
  const key = createKey();
  entry.getAccessStore().addUsage(key.id, { requests: 1, inputTokens: 10, outputTokens: 5 });
  const answer = await call(key, "/v1/me/usage.csv?group_by=day");
  assert.equal(answer.status, 200, answer.text);
  assert.match(String(answer.headers["content-type"]), /^text\/csv; charset=utf-8/);
  assert.match(String(answer.headers["content-disposition"]), /^attachment; filename="usage-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.ok(answer.text.startsWith(BOM));
  const lines = answer.text.slice(1).split("\r\n");
  assert.equal(lines[0], '"date","model","requests","input_tokens","cached_input_tokens","output_tokens","errors"');
  assert.equal(lines.length, 30 + 2, "30 days, a header and the trailing CRLF");
  assert.match(lines.at(-2), /^"\d{4}-\d{2}-\d{2}","","1","10","0","5","0"$/);
});

test("rotate needs self.rotate, same-origin and confirm; it is rate limited and audited", async () => {
  await fresh();
  const store = entry.getAccessStore();
  const readOnly = createKey({ scopes: ["models.read", "self.read"] });
  const noScope = await call(readOnly, "/v1/me/rotate", { method: "POST", body: { confirm: true } });
  assert.equal(noScope.status, 403);
  assert.equal(noScope.json.error.code, "scope_denied");
  assert.equal((await call(readOnly, "/v1/me")).json.self_service.rotate, false);

  // The key lists another site; the portal's own origin is judged separately.
  let key = createKey({ allowedOrigins: ["https://app.example.com"] });
  const cross = await call(key, "/v1/me/rotate", { method: "POST", body: { confirm: true }, headers: { origin: "https://evil.example" } });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error.code, "origin_not_allowed");
  // The key's own listed site is not the portal: rotation stays same-origin only.
  const listed = await call(key, "/v1/me/rotate", { method: "POST", body: { confirm: true }, headers: { origin: "https://app.example.com" } });
  assert.equal(listed.status, 403);
  assert.equal(listed.json.error.code, "origin_not_allowed");

  const noConfirm = await call(key, "/v1/me/rotate", { method: "POST", body: {} });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.json.error.param, "confirm");
  const wrongType = await call(key, "/v1/me/rotate", { method: "POST", body: "confirm=true", headers: { "content-type": "text/plain" } });
  assert.equal(wrongType.status, 415);
  const badJson = await call(key, "/v1/me/rotate", { method: "POST", body: "{nope", headers: { "content-type": "application/json" } });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, "invalid_json");
  assert.ok(entry.getAccessStore().getKey(key.id), "nothing rotated yet");

  // Same origin (Origin equals the Host) works, with no Origin at all too.
  const rotated = await call(key, "/v1/me/rotate", { method: "POST", body: { confirm: true }, headers: { origin: "http://127.0.0.1" } });
  assert.equal(rotated.status, 200, rotated.text);
  shape(rotated.json, { key: (v) => /^sk-/.test(v), preview: (v) => typeof v === "string", rotated_at: isIso, previous_valid_until: (v) => v === null });
  assert.notEqual(rotated.json.key, key.secret);
  assert.equal(rotated.headers["cache-control"], "no-store");
  assert.equal(JSON.stringify(rotated.json).includes(key.secret), false);
  // The old secret is dead at once, the new one works and shows the new preview.
  assert.equal((await call(key, "/v1/me")).status, 401);
  key = { ...key, secret: rotated.json.key };
  const after = await call(key, "/v1/me");
  assert.equal(after.status, 200);
  assert.equal(after.json.preview, rotated.json.preview);
  assert.equal(after.json.id, key.id);

  const audit = store.listAudit({ limit: 50 });
  const rows = (Array.isArray(audit) ? audit : audit.items || audit.rows || []).filter((row) => row.targetId === key.id && row.action === "key.rotate.self");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, `key:${key.id}`);
  assert.equal(JSON.stringify(rows[0]).includes(rotated.json.key), false, "the new secret is never audited");

  // 3 an hour: two more succeed, the fourth is refused with a retry time.
  for (let n = 2; n <= 3; n += 1) {
    const again = await call(key, "/v1/me/rotate", { method: "POST", body: { confirm: true } });
    assert.equal(again.status, 200, `rotation ${n}: ${again.text}`);
    key = { ...key, secret: again.json.key };
  }
  const limited = await call(key, "/v1/me/rotate", { method: "POST", body: { confirm: true } });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, "rate_limit_exceeded");
  assert.ok(Number(limited.headers["retry-after"]) > 60);
  assert.equal((await call(key, "/v1/me")).status, 200, "the key was not rotated by the refused call");
});

test("the origins editor needs self.origins and same-origin, validates, replaces and audits", async () => {
  await fresh();
  const store = entry.getAccessStore();
  const noScope = createKey({ scopes: ["models.read", "self.read", "self.rotate"] });
  assert.equal((await call(noScope, "/v1/me/origins", { method: "PUT", body: { origins: [] } })).status, 403);

  const key = createKey();
  const cross = await call(key, "/v1/me/origins", { method: "PUT", body: { origins: ["https://a.example"] }, headers: { origin: "https://evil.example" } });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error.code, "origin_not_allowed");

  for (const origins of [["*"], ["http://example.com"], ["https://a.example/x"], "https://a.example", Array.from({ length: 11 }, (_, i) => `https://a${i}.example`)]) {
    const bad = await call(key, "/v1/me/origins", { method: "PUT", body: { origins } });
    assert.equal(bad.status, 400, JSON.stringify(origins));
    assert.equal(bad.json.error.code, "invalid_request");
    assert.equal(bad.json.error.param, "origins");
  }
  assert.deepEqual(store.getKey(key.id).allowedOrigins, []);
  assert.equal((await call(key, "/v1/me/origins", { method: "POST", body: { origins: [] } })).status, 405);

  const saved = await call(key, "/v1/me/origins", { method: "PUT", body: { origins: ["https://App.Example.com", "http://localhost:5173"] }, headers: { origin: "http://127.0.0.1" } });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json, { allowed_origins: ["https://app.example.com", "http://localhost:5173"] });
  assert.deepEqual((await call(key, "/v1/me")).json.allowed_origins, ["https://app.example.com", "http://localhost:5173"]);
  assert.deepEqual(store.getKey(key.id).allowedOrigins, ["https://app.example.com", "http://localhost:5173"]);

  // A listed site may now read from its page; the portal still can write.
  const fromSite = await call(key, "/v1/me", { headers: { origin: "https://app.example.com" } });
  assert.equal(fromSite.status, 200);
  assert.equal(fromSite.headers["access-control-allow-origin"], "https://app.example.com");
  assert.equal((await call(key, "/v1/me", { headers: { origin: "https://other.example" } })).status, 403);
  const portalWrite = await call(key, "/v1/me/origins", { method: "PUT", body: { origins: [] }, headers: { origin: "http://127.0.0.1" } });
  assert.equal(portalWrite.status, 200, portalWrite.text);
  assert.deepEqual(portalWrite.json, { allowed_origins: [] });

  const audit = store.listAudit({ limit: 100 });
  const rows = (Array.isArray(audit) ? audit : audit.items || audit.rows || []).filter((row) => row.targetId === key.id).map((row) => row.action);
  assert.ok(rows.includes("key.origins.self"), rows.join(","));
  assert.ok(rows.includes("key.update"), rows.join(","));
});

test("the origins editor shares its hourly bucket", async () => {
  await fresh();
  const key = createKey();
  for (let n = 1; n <= 20; n += 1) {
    const ok = await call(key, "/v1/me/origins", { method: "PUT", body: { origins: [] } });
    // The meta bucket (30/min) is the other bound; 20 + 20 meta takes fit.
    assert.equal(ok.status, 200, `edit ${n}: ${ok.text}`);
  }
  const limited = await call(key, "/v1/me/origins", { method: "PUT", body: { origins: [] } });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, "rate_limit_exceeded");
});

// ---- telemetry or counters, behind a fake pipeline ---------------------------------

let tempDir = null;
function freshStore() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "me-routes-"));
  return createKeysStore({ DatabaseSync, file: path.join(tempDir, "access.sqlite"), tzOffsetMinutes: 0 });
}

// A server with createMeRoutes only: the pipeline authorizes a Bearer secret
// against the store, and refusals use the real public error writer.
async function meServer(t, { telemetry = null, billing = null, now = Date.now } = {}) {
  const store = freshStore();
  const limiter = createLimiter({ store: () => store, config: () => ({ public: {} }) });
  const pipeline = {
    listenerOf: () => "public",
    checkBan: () => null,
    sendRefusal: (req, res, { code, param, headers }) => sendPublicError(req, res, code, { param, headers }),
    async authorize(req, { scope }) {
      const secret = String(req.headers.authorization || "").replace(/^Bearer /, "");
      const found = store.findBySecret(secret, new Date());
      if (!found) return { ok: false, status: 401, code: "invalid_api_key", message: "no" };
      if (!found.key.scopes.includes(scope)) return { ok: false, status: 403, code: "scope_denied", message: "no" };
      return { ok: true, kind: "key", key: found.key, scopes: found.key.scopes };
    },
  };
  const routes = createMeRoutes({
    pipeline,
    limiter,
    keysStore: store,
    config: {},
    billing,
    telemetry,
    now,
    listModels: async () => [{ id: "alpha" }, { id: "beta" }],
    sendJson: (res, body, status, headers) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    },
    logger: { warn() {} },
  });
  const server = http.createServer((req, res) => {
    routes.handle(req, res, new URL(req.url, "http://x")).catch((error) => {
      res.writeHead(500);
      res.end(String(error?.stack || error));
    });
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
      resolve();
    });
  }));
  const { key, secret } = store.createKey({ class: "friend", models: ["*"], scopes: SELF_SCOPES, name: "fake pipeline key", limits: { dailyTokens: 1_000_000, monthlyTokens: 10_000_000 } }, { actor: "test" });
  const get = (pathname, headers = {}) => request(port, `/gateway/me${pathname}`, { headers: { host: "127.0.0.1", authorization: `Bearer ${secret}`, ...headers } });
  return { store, key, get, limiter };
}

test("usage comes from telemetry when it answers and from the counters otherwise", async (t) => {
  const asked = [];
  let mode = "telemetry";
  const day = (date) => Date.parse(`${date}T00:00:00.000Z`);
  const clock = day("2026-10-15") + 6 * HOUR;
  const telemetry = {
    async timeseries(params, options) {
      asked.push({ params, options });
      if (mode === "down") throw Object.assign(new Error("store down"), { code: "telemetry_store_unavailable" });
      const point = (date, value) => [day(date), value];
      const grouped = params.groupBy === "model";
      const make = (metric, perDay) => ({ metric, unit: "x", group: grouped ? { model: "alpha" } : {}, points: Object.entries(perDay).map(([date, value]) => point(date, value)) });
      return {
        series: [
          make("req.count", { "2026-10-14": 5, "2026-10-15": 7 }),
          make("tok.prompt", { "2026-10-14": 500, "2026-10-15": 700 }),
          make("tok.cached", { "2026-10-14": 50, "2026-10-15": 70 }),
          make("tok.output", { "2026-10-14": 100, "2026-10-15": 200 }),
          make("req.errors", { "2026-10-14": 1, "2026-10-15": 0 }),
        ],
      };
    },
    async requests(params) {
      asked.push({ requests: params });
      if (mode === "down") throw Object.assign(new Error("store down"), { code: "telemetry_store_unavailable" });
      return {
        rows: [{
          requestId: "req_abcdefghijklmnopqrst", receivedAt: "2026-10-15T05:00:00.000Z", modelRequested: "alpha", modelResolved: "alpha-v2", op: "chat", stream: true, status: 200,
          errorCode: null, errorClass: null, promptTokens: 12, cachedTokens: 4, outputTokens: 30, ttftMs: 120, durationMs: 900,
          clientIp: "203.0.113.9", userAgent: "secret-agent", owuiUserId: "u1", keyId: "k_x",
        }],
        nextCursor: "next-page",
      };
    },
  };
  const { store, key, get } = await meServer(t, { telemetry, now: () => clock });
  // The counters disagree on purpose: a key used the quota 9000 tokens today.
  store.addUsage(key.id, { at: new Date(clock), requests: 99, inputTokens: 6000, cachedInputTokens: 1, outputTokens: 3000 });

  const me = (await get("")).json;
  // Usage is the telemetry's: today = 15 Oct, month = 14 + 15 Oct.
  assert.deepEqual({ ...me.usage.today, resets_at: undefined }, { requests: 7, input_tokens: 700, cached_input_tokens: 70, output_tokens: 200, resets_at: undefined });
  assert.deepEqual({ ...me.usage.month, resets_at: undefined }, { requests: 12, input_tokens: 1200, cached_input_tokens: 120, output_tokens: 300, resets_at: undefined });
  // The quota is the counters', the number that enforces the cap.
  assert.equal(me.quota.daily_tokens.used, 9000);
  assert.deepEqual(me.models.available, ["alpha", "beta"]);
  assert.equal(asked[0].params.key_id, key.id, "restricted to the caller's key");
  assert.equal(asked[0].params.step, "86400");
  assert.equal(asked[0].params.from, String(day("2026-10-01")));

  const usage = (await get("/usage?from=2026-10-14&to=2026-10-15&group_by=day,model")).json;
  assert.equal(usage.source, "telemetry");
  assert.deepEqual(usage.data.map((row) => [row.date, row.model, row.requests, row.input_tokens, row.cached_input_tokens, row.output_tokens, row.errors]), [
    ["2026-10-14", "alpha", 5, 500, 50, 100, 1],
    ["2026-10-15", "alpha", 7, 700, 70, 200, 0],
  ]);
  const grouped = asked.find((item) => item.params?.groupBy === "model");
  assert.equal(grouped.params.key_id, key.id);
  assert.equal(grouped.params.from, String(day("2026-10-14")));
  assert.equal(grouped.params.to, String(day("2026-10-16")));

  const csv = await get("/usage.csv?from=2026-10-14&to=2026-10-15&group_by=day,model");
  assert.ok(csv.text.startsWith(BOM));
  assert.match(csv.text, /"2026-10-15","alpha","7","700","70","200","0"/);

  // Recent requests: the public projection only, never an address or an agent.
  const requests = await get("/requests?limit=5");
  assert.equal(requests.json.source, "telemetry");
  assert.equal(requests.json.next_cursor, "next-page");
  assert.deepEqual(requests.json.data, [{
    request_id: "req_abcdefghijklmnopqrst", at: "2026-10-15T05:00:00.000Z", model: "alpha-v2", endpoint: "chat", stream: true, status: 200,
    error_code: null, input_tokens: 12, cached_input_tokens: 4, output_tokens: 30, ttft_ms: 120, duration_ms: 900,
  }]);
  assert.equal(requests.text.includes("203.0.113.9"), false);
  assert.equal(requests.text.includes("secret-agent"), false);
  const requestParams = asked.find((item) => item.requests).requests;
  assert.equal(requestParams.key_id, key.id);
  assert.equal(requestParams.limit, "5");
  const paged = await get("/requests?limit=5&cursor=next-page");
  assert.equal(paged.status, 200);
  assert.equal(asked.filter((item) => item.requests).at(-1).requests.cursor, "next-page");

  // Telemetry down: counters, with their own source, and an empty request list.
  mode = "down";
  const fallback = (await get("/usage?from=2026-10-14&to=2026-10-15")).json;
  assert.equal(fallback.source, "counters");
  assert.deepEqual(fallback.data.map((row) => [row.date, row.requests]), [["2026-10-14", 0], ["2026-10-15", 99]]);
  const meDown = (await get("")).json;
  assert.equal(meDown.usage.today.requests, 99);
  assert.equal(meDown.usage.today.input_tokens, 6000);
  assert.deepEqual((await get("/requests")).json, { object: "list", data: [], next_cursor: null, source: "counters" });
});

test("billing is null without a binding and reports mode, balance and spend with one", async (t) => {
  const summaries = [];
  const billing = {
    lookupCustomerForCredential: () => null,
    getCustomerSummary(id, options) {
      summaries.push([id, options]);
      return { enforcementMode: "shadow", balanceMicrocredits: "12500000", periodSpendMicrocredits: "3200000", period: {} };
    },
  };
  const { store, key, get } = await meServer(t, { billing });
  assert.equal((await get("")).json.billing, null, "no customer, no billing block");
  assert.deepEqual(summaries, []);

  store.updateKey(key.id, { customerId: "11111111-1111-4111-8111-111111111111" }, { actor: "test" });
  const bound = (await get("")).json.billing;
  assert.deepEqual(bound, { bound: true, mode: "shadow", balance_credits: "12.500000", period_spend_credits: "3.200000" });
  assert.equal(summaries[0][0], "11111111-1111-4111-8111-111111111111");
  assert.ok(summaries[0][1].at instanceof Date);
});

test("quota pace reflects the period position in /v1/me", async (t) => {
  const start = Date.UTC(2026, 9, 15);
  const clock = start + 12 * HOUR;
  const { store, key, get } = await meServer(t, { now: () => clock });
  // Daily cap 1,000,000: 700,000 after half a day is ahead and projected.
  store.addUsage(key.id, { at: new Date(clock), requests: 1, inputTokens: 500_000, outputTokens: 200_000 });
  const me = (await get("")).json;
  assert.equal(me.quota.daily_tokens.pace, "ahead");
  assert.equal(me.quota.daily_tokens.remaining, 300_000);
  // 700k per 12 h: the remaining 300k lasts 5.14 h.
  assert.equal(me.quota.daily_tokens.projected_exhaustion_at, new Date(clock + Math.round((300_000 * 12 * HOUR) / 700_000)).toISOString());
  // Monthly cap 10M, 0.7M used in 14.5 days of 31: ok, and no exhaustion in the month.
  assert.equal(me.quota.monthly_tokens.pace, "ok");
  assert.equal(me.quota.monthly_tokens.projected_exhaustion_at, null);
  store.addUsage(key.id, { at: new Date(clock), requests: 1, inputTokens: 300_000 });
  const spent = (await get("")).json;
  assert.deepEqual([spent.quota.daily_tokens.pace, spent.quota.daily_tokens.remaining, spent.quota.daily_tokens.projected_exhaustion_at], ["exhausted", 0, null]);
});

test("the meta bucket allows 30 reads a minute per key and is separate from rpm", async (t) => {
  const { key, get, limiter } = await meServer(t);
  const other = (await get("")).json;
  assert.equal(other.limits.rpm, 60, "the public default applies");
  let last;
  for (let n = 2; n <= 30; n += 1) {
    last = await get("");
    assert.equal(last.status, 200, `read ${n}`);
  }
  // The key's rpm bucket is exactly as full as before the 30 reads.
  assert.equal(last.json.rate_limit.requests.remaining, last.json.rate_limit.requests.limit);
  const refused = await get("");
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error.code, "rate_limit_exceeded");
  assert.ok(Number(refused.headers["retry-after"]) >= 1);
  // The same key still has its whole inference allowance.
  const entered = limiter.enter({ caller: { key: { id: key.id, limits: {}, class: "friend" } }, listener: "public" });
  assert.equal(entered.ok, true);
  assert.equal(entered.ticket.rpm.remaining, entered.ticket.rpm.limit - 1);
});
