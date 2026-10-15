"use strict";

// The console contract of docs/overhaul/04-telemetry.md section 19 (TEL-19):
//  - tests/fixtures/telemetry/*.json, which 07's Playwright specs serve as
//    stubs, validate against schemas.js and equal what the real routes answer
//    for a seeded database, so a stub cannot drift from the API;
//  - the `telemetry` i18n area has zh and en parity, owns only obs.* and
//    audit.*, and keeps the keys 07 references;
//  - fixtures and catalogs pass the release privacy rules.
//
// After an intended API change, rewrite the fixtures with
//   UPDATE_TELEMETRY_FIXTURES=1 node --test manager-core/test/telemetry-fixtures.test.js

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assertValid, validate } = require("../telemetry/schemas");
const { ERROR_CLASSES, TERMINAL_STATES } = require("../telemetry/error-class");
const { METRICS } = require("../telemetry/query");
const { containsIdentity, identityNeedles } = require("../../scripts/capture-model-fixture.js");
const { FIXTURE_NAMES, buildFixtures, tempDir } = require("./helpers/telemetry-fixtures-build");

const REPO_ROOT = path.join(__dirname, "..", "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "telemetry");
const I18N_DIR = path.join(REPO_ROOT, "service-entry", "console", "i18n");
const AREA_DIR = path.join(I18N_DIR, "telemetry");
const SCHEMA_OF = Object.freeze({
  live: "live",
  summary: "summary",
  timeseries: "timeseries",
  breakdown: "breakdown",
  requests: "requests",
  "request-detail": "requestDetail",
  alerts: "alerts",
  "audit-status": "auditStatus",
  "audit-chats": "auditChats",
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixturePath(name) {
  return path.join(FIXTURE_DIR, `${name}.json`);
}

// --- fixtures ---------------------------------------------------------------------

test("every fixture has a schema and the folder holds exactly the documented set", () => {
  assert.deepEqual(Object.keys(SCHEMA_OF).sort(), [...FIXTURE_NAMES].sort());
  if (process.env.UPDATE_TELEMETRY_FIXTURES !== "1") {
    assert.deepEqual(fs.readdirSync(FIXTURE_DIR).sort(), FIXTURE_NAMES.map((name) => `${name}.json`).sort());
  }
});

test("the fixtures equal what the real routes answer for a seeded database", async (t) => {
  const dir = tempDir();
  const built = await buildFixtures(dir);
  t.after(async () => {
    await built.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  assert.deepEqual(Object.keys(built.fixtures).sort(), [...FIXTURE_NAMES].sort());
  if (process.env.UPDATE_TELEMETRY_FIXTURES === "1") {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const name of FIXTURE_NAMES) fs.writeFileSync(fixturePath(name), render(built.fixtures[name]));
  }
  for (const name of FIXTURE_NAMES) {
    const onDisk = readJson(fixturePath(name));
    assertValid(SCHEMA_OF[name], built.fixtures[name]);
    assert.deepEqual(onDisk, built.fixtures[name], `${name}.json is stale; rerun with UPDATE_TELEMETRY_FIXTURES=1`);
    assert.equal(fs.readFileSync(fixturePath(name), "utf8"), render(built.fixtures[name]), `${name}.json is not in the canonical layout`);
  }
});

test("each fixture validates against schemas.js", () => {
  for (const name of FIXTURE_NAMES) {
    const result = validate(SCHEMA_OF[name], readJson(fixturePath(name)));
    assert.deepEqual(result.errors, [], name);
  }
});

test("the schemas reject a fixture that lost a field or changed a type", () => {
  const live = readJson(fixturePath("live"));
  const broken = JSON.parse(JSON.stringify(live));
  delete broken.gateway.inflight;
  assert.equal(validate("live", broken).ok, false);
  const retyped = JSON.parse(JSON.stringify(live));
  retyped.at = 12345;
  assert.equal(validate("live", retyped).ok, false);

  const alerts = readJson(fixturePath("alerts"));
  assert.ok(alerts.rows.length >= 2, "one firing and one cleared alert");
  const wrong = JSON.parse(JSON.stringify(alerts));
  wrong.rows[0].state = "resolved";
  assert.equal(validate("alerts", wrong).ok, false);
  const missing = JSON.parse(JSON.stringify(alerts));
  delete missing.toastChannel;
  assert.equal(validate("alerts", missing).ok, false);

  const status = readJson(fixturePath("audit-status"));
  const noChain = JSON.parse(JSON.stringify(status));
  noChain.chains[0].bytes = "many";
  assert.equal(validate("auditStatus", noChain).ok, false);

  const chats = readJson(fixturePath("audit-chats"));
  const noRows = JSON.parse(JSON.stringify(chats));
  delete noRows.rows[0].chatId;
  assert.equal(validate("auditChats", noRows).ok, false);
});

test("the fixtures cover what 07 renders: states, an error row, a cleared alert, a chain and chats", () => {
  const live = readJson(fixturePath("live"));
  assert.ok(live.instances.length >= 1 && live.gpus.length >= 1);
  const requests = readJson(fixturePath("requests"));
  assert.ok(requests.rows.some((row) => row.errorClass !== "none"), "an error row");
  assert.ok(requests.facets && Object.keys(requests.facets).length > 0, "facets");
  const alerts = readJson(fixturePath("alerts"));
  assert.ok(alerts.rows.some((row) => row.state === "firing") && alerts.rows.some((row) => row.state === "ok"));
  assert.ok(readJson(fixturePath("audit-status")).chains.length >= 1);
  assert.ok(readJson(fixturePath("audit-chats")).rows.length >= 1);
  assert.ok(readJson(fixturePath("timeseries")).annotations.length >= 1);
});

// --- the telemetry i18n area --------------------------------------------------------

const LOCALES = ["zh-CN", "en-US"];
const OWNED_PREFIXES = ["audit.", "obs."];
// The keys 07 and the 04 section 19 edge states refer to by name.
const REQUIRED_KEYS = [
  "obs.reservation", "obs.noPrice", "obs.lanReadOnly", "obs.idle", "obs.gap", "obs.noMetric",
  "obs.latencyFromGateway", "obs.importedLifetime", "obs.title", "obs.window", "audit.title", "audit.unlock",
  "audit.chain", "audit.rebaseline", "audit.accessLog", "audit.chainBroken", "obs.alert.firing", "obs.alert.resolved",
];

function area(locale) {
  return readJson(path.join(AREA_DIR, `${locale}.json`));
}

function keysOf(file) {
  return Object.keys(file).filter((key) => !key.startsWith("$"));
}

function placeholders(value) {
  return [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort().join(",");
}

test("the telemetry area has zh and en parity and owns only obs.* and audit.*", () => {
  const zh = area("zh-CN");
  const en = area("en-US");
  assert.equal(zh.$locale, "zh-CN");
  assert.equal(en.$locale, "en-US");
  assert.deepEqual(zh.$prefixes, OWNED_PREFIXES);
  assert.deepEqual(en.$prefixes, OWNED_PREFIXES);
  assert.deepEqual(keysOf(zh), keysOf(en));
  assert.deepEqual(keysOf(zh), [...keysOf(zh)].sort(), "keys are sorted");
  for (const key of keysOf(zh)) {
    assert.ok(OWNED_PREFIXES.some((prefix) => key.startsWith(prefix)), `${key} is outside obs.* and audit.*`);
    assert.ok(typeof zh[key] === "string" && zh[key].trim(), `${key}: zh-CN value is empty`);
    assert.ok(typeof en[key] === "string" && en[key].trim(), `${key}: en-US value is empty`);
    assert.equal(placeholders(zh[key]), placeholders(en[key]), `${key}: placeholders differ`);
    assert.equal(/\p{Script=Han}/u.test(en[key]), false, `${key}: en-US contains Han characters`);
  }
});

test("the area keeps the keys 07 references and names every error class and terminal state", () => {
  const keys = new Set(keysOf(area("en-US")));
  for (const key of REQUIRED_KEYS) assert.ok(keys.has(key), `${key} is missing`);
  for (const errorClass of ERROR_CLASSES) assert.ok(keys.has(`obs.err.${errorClass}`), `obs.err.${errorClass} is missing`);
  for (const state of TERMINAL_STATES) assert.ok(keys.has(`obs.term.${state}`), `obs.term.${state} is missing`);
  for (const key of keys) {
    const tail = key.replace(/^obs\.(err|term)\./, "");
    if (key.startsWith("obs.err.")) assert.ok(ERROR_CLASSES.includes(tail), `${key} is not an error class`);
    if (key.startsWith("obs.term.")) assert.ok(TERMINAL_STATES.includes(tail), `${key} is not a terminal state`);
  }
});

test("every timeseries metric has a zh and en label (07 CON-7b reads obs.metric.<id>)", () => {
  const zh = area("zh-CN");
  const en = area("en-US");
  for (const id of Object.keys(METRICS)) {
    assert.ok(zh[`obs.metric.${id}`], `obs.metric.${id} is missing in zh-CN`);
    assert.ok(en[`obs.metric.${id}`], `obs.metric.${id} is missing in en-US`);
  }
  for (const key of keysOf(en).filter((item) => item.startsWith("obs.metric."))) {
    assert.ok(Object.hasOwn(METRICS, key.slice("obs.metric.".length)), `${key} names no metric`);
  }
});

test("dynamic-keys.json covers the looked-up families and every key is used or listed", () => {
  const dynamic = readJson(path.join(AREA_DIR, "dynamic-keys.json"));
  assert.deepEqual([...dynamic.prefixes].sort(), ["obs.alert.", "obs.err.", "obs.metric.", "obs.term."]);
  const keys = keysOf(area("en-US"));
  for (const key of dynamic.unused) assert.ok(keys.includes(key), `${key} is listed as unused but does not exist`);
  for (const key of keys) {
    const covered = dynamic.prefixes.some((prefix) => key.startsWith(prefix)) || dynamic.unused.includes(key);
    assert.ok(covered, `${key} is neither under a dynamic prefix nor listed`);
  }
});

test("no other area defines an obs.* or audit.* key", () => {
  for (const entry of fs.readdirSync(I18N_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "telemetry") continue;
    for (const locale of LOCALES) {
      const file = path.join(I18N_DIR, entry.name, `${locale}.json`);
      if (!fs.existsSync(file)) continue;
      const catalog = readJson(file);
      for (const key of keysOf(catalog)) {
        assert.ok(!OWNED_PREFIXES.some((prefix) => key.startsWith(prefix)), `${entry.name}/${locale}.json defines ${key}`);
      }
      for (const prefix of catalog.$prefixes || []) {
        assert.ok(!OWNED_PREFIXES.some((owned) => prefix.startsWith(owned) || owned.startsWith(prefix)), `${entry.name} claims prefix ${prefix}`);
      }
    }
  }
});

// --- privacy ------------------------------------------------------------------------

// The same families of leaks the release scan and the model-fixture scan
// reject (build-github-release.ps1, fixture-privacy.test.js).
const PATTERNS = [
  { id: "drive-letter path", pattern: /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/ },
  { id: "\\Users\\ path", pattern: /[\\/]Users[\\/]/i },
  { id: "/home/ path", pattern: /\/home\//i },
  { id: "e-mail address", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
  { id: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { id: "credential", pattern: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{20,})\b/i },
];

function findings(text, needles) {
  const out = PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.id);
  if (containsIdentity(text, needles)) out.push("machine or user name");
  return out;
}

test("fixtures and the telemetry catalogs pass the privacy rules", () => {
  const needles = identityNeedles([path.resolve(REPO_ROOT)]);
  const files = [
    ...FIXTURE_NAMES.map((name) => fixturePath(name)),
    ...[...LOCALES.map((locale) => `${locale}.json`), "dynamic-keys.json"].map((name) => path.join(AREA_DIR, name)),
  ];
  const hits = [];
  for (const file of files) {
    for (const finding of findings(fs.readFileSync(file, "utf8"), needles)) hits.push(`${path.relative(REPO_ROOT, file)}: ${finding}`);
  }
  assert.deepEqual(hits, []);
});

test("the privacy check flags planted leaks (never written to disk)", () => {
  const needle = "fixture-needle-xyz";
  const planted = {
    "drive-letter path": ["Q", ":\\", "models"].join(""),
    "\\Users\\ path": ["\\", "Users", "\\someone"].join(""),
    "e-mail address": ["someone", "@", "example.org"].join(""),
    credential: ["sk", "-", "A".repeat(24)].join(""),
    "machine or user name": needle,
  };
  for (const [kind, text] of Object.entries(planted)) assert.ok(findings(`value ${text} end`, [needle]).includes(kind), kind);
  assert.deepEqual(findings("192.0.2.10 and <AI_ROOT> and model-a", [needle]), []);
});
