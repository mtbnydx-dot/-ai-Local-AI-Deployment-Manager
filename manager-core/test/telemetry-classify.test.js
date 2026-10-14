"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyOutcome, statusClass, ERROR_CLASSES, TERMINAL_STATES } = require("../telemetry/error-class");
const { classifyGatewayRoute } = require("../telemetry/route-class");
const {
  SOURCE_PROGRAMS,
  SOURCE_PROGRAM_LABELS,
  inferSourceProgram,
  labelFor,
} = require("../telemetry/source-program");
const accessLog = require("../access-log");
const outcomeFixture = require("./fixtures/telemetry/classify-outcome.json");
const routeFixture = require("./fixtures/telemetry/route-class.json");
const sourceFixture = require("./fixtures/telemetry/source-programs.json");

// The §5.4 table, top to bottom. Every row must have at least one golden case.
const SPEC_ROWS_54 = [
  "completed", "client_abort", "timeout", "auth_failed", "auth_banned", "forbidden", "rate_limited",
  "quota_denied", "billing_unavailable", "no_runtime", "config_error", "context_overflow",
  "bad_request (pre_upstream)", "bad_request (upstream)", "upstream_unreachable", "upstream_5xx",
  "stream_error", "internal",
];

test("§5.4 golden rows: classifyOutcome", () => {
  for (const row of SPEC_ROWS_54) {
    assert.ok(outcomeFixture.cases.some((item) => item.row === row), `fixture covers ${row}`);
  }
  for (const item of outcomeFixture.cases) {
    const result = classifyOutcome(item.input);
    assert.deepEqual(result, item.expected, `${item.row}: ${JSON.stringify(item.input)}`);
    assert.ok(TERMINAL_STATES.includes(result.terminalState));
    assert.ok(ERROR_CLASSES.includes(result.errorClass));
    if (result.errorCode !== null) assert.match(result.errorCode, /^[a-z0-9_.-]{1,64}$/);
  }
});

test("classifyOutcome never echoes the upstream error text", () => {
  const marker = "marker-text-from-the-upstream-body";
  for (const status of [400, 413, 500, 503]) {
    const result = classifyOutcome({ phase: "upstream", status, upstreamErrorText: `prompt is too long ${marker}` });
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
  // A code that is a free-text message is replaced by the class.
  assert.equal(classifyOutcome({ phase: "upstream", status: 500, code: "Engine crashed: out of memory" }).errorCode, "upstream_5xx");
  assert.equal(classifyOutcome({ phase: "upstream", status: 500, code: "x".repeat(65) }).errorCode, "upstream_5xx");
});

test("context overflow needs status 400 and only reads the first 4 KiB of the body", () => {
  const text = "maximum context length";
  assert.equal(classifyOutcome({ phase: "upstream", status: 422, upstreamErrorText: text }).errorClass, "bad_request");
  assert.equal(classifyOutcome({ phase: "upstream", status: 400, upstreamErrorText: `${"x".repeat(4096)}${text}` }).errorClass, "bad_request");
  assert.equal(classifyOutcome({ phase: "upstream", status: 400, upstreamErrorText: `${"x".repeat(4000)}${text}` }).errorClass, "context_overflow");
});

test("statusClass buckets statuses for rollups", () => {
  assert.equal(statusClass(200), "2xx");
  assert.equal(statusClass(304), "3xx");
  assert.equal(statusClass(499), "4xx");
  assert.equal(statusClass(503), "5xx");
  assert.equal(statusClass(0), "none");
  assert.equal(statusClass(undefined), "none");
  assert.equal(statusClass(99), "none");
});

// The §5.5 table, top to bottom.
const SPEC_ROWS_55 = [
  "openai traffic", "opencode traffic", "engineId route", "external route", "claude traffic", "models control",
  "tts traffic", "tts control", "tts static", "search traffic", "mcp traffic", "gateway control", "options control",
  "public alias",
];

test("§5.5 golden rows: classifyGatewayRoute", () => {
  for (const row of SPEC_ROWS_55) {
    assert.ok(routeFixture.cases.some((item) => item.row === row), `fixture covers ${row}`);
  }
  for (const item of routeFixture.cases) {
    const result = classifyGatewayRoute(item.method, item.path);
    if (item.aliasOf) {
      assert.notEqual(result, null, item.path);
      assert.deepEqual(result, classifyGatewayRoute(item.method, item.aliasOf), `${item.path} classifies like ${item.aliasOf}`);
      continue;
    }
    assert.deepEqual(result, item.expected, `${item.method} ${item.path}`);
  }
});

test("only traffic routes produce request rows; the TTS poll flood is control", () => {
  const polls = Array.from({ length: 48 }, (_, index) => classifyGatewayRoute("GET", `/gateway/tts/api/jobs/job_${index}`));
  assert.ok(polls.every((item) => item.kind === "control" && item.route === "tts"));
  assert.equal(classifyGatewayRoute("GET", "/gateway/tts/api/jobs?limit=20").kind, "control");
  assert.equal(classifyGatewayRoute("POST", "/gateway/auto/openai/v1/chat/completions?x=1").kind, "traffic");
});

test("source programs: access-log labels are unchanged and match the telemetry slugs", () => {
  for (const item of sourceFixture.accessLogCases) {
    assert.equal(accessLog.inferAccessSourceProgram(item.entry), item.legacyLabel, item.name);
    const normalized = accessLog.normalizeAccessEvent({ ...item.entry, at: "2026-10-14T08:00:00.000Z" }, "192.0.2.1");
    assert.equal(normalized.sourceProgram, item.legacyLabel, `${item.name} (normalizeAccessEvent)`);
    if (item.slug === null) continue;
    const slug = inferSourceProgram({
      userAgent: item.entry.userAgent,
      origin: item.entry.origin,
      referer: item.entry.refererHost,
      protocol: item.entry.kind,
      path: item.entry.path,
    });
    assert.equal(slug, item.slug, `${item.name} slug`);
  }
});

test("source programs: X-Title and x-ai-client hints", () => {
  for (const item of sourceFixture.hintCases) {
    assert.equal(inferSourceProgram(item.input), item.slug, item.name);
  }
});

test("every §5.3 slug has a zh and an en label", () => {
  const specSlugs = [
    "openwebui", "chatbox", "lobechat", "workbuddy", "claude-code", "claude-compat", "opencode", "openai-python",
    "openai-node", "python", "curl", "powershell", "node", "go", "java", "cherry-studio", "cursor", "browser", "unknown",
  ];
  for (const slug of [...specSlugs, "openai-compat"]) {
    assert.ok(SOURCE_PROGRAMS.includes(slug), slug);
    assert.ok(SOURCE_PROGRAM_LABELS[slug].zh && SOURCE_PROGRAM_LABELS[slug].en, slug);
    assert.match(slug, /^[a-z0-9-]{1,40}$/);
  }
  assert.equal(labelFor("browser", "zh", { originHost: "192.0.2.10:3000" }), "浏览器 · 192.0.2.10:3000");
  assert.equal(labelFor("browser", "en", { originHost: "192.0.2.10:3000" }), "Browser · 192.0.2.10:3000");
  assert.equal(labelFor("browser", "en"), "Browser client");
  assert.equal(labelFor("claude-compat", "en-US"), "Claude-compatible client");
  assert.equal(labelFor("my-notes-app", "zh"), "my-notes-app");
  assert.equal(labelFor(undefined), "未知来源");
});
