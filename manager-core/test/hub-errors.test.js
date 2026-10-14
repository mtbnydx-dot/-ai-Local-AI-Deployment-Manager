"use strict";

// Hub error wrapper, refinements and retry policy (docs/overhaul/03-hub.md
// §6.3, §20, HUB-16). Everything works on fixtures and in temp directories;
// the data loader gets explicit directories, so neither this machine's
// <AI_ROOT>/config nor its environment can leak in.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DOWNLOAD_ERROR_CODES,
  HUB_ERROR_ACTIONS,
  HUB_ERROR_CODES,
  HUB_REFINEMENT_BASES,
  HUB_REFINEMENT_CODES,
  HubError,
  classifyDownloadFailure,
  classifyTransferFailure,
  describeHubError,
  loadTransferErrorData,
  retryDecision,
  toEnvelope,
} = require("../model-hub/errors");
const { BUNDLED_DIR } = require("../reference-data");
const { createModelHub } = require("../model-hub");
const { defaultSettings } = require("../model-hub/settings");

const STDERR_DIR = path.join(__dirname, "fixtures", "hub", "stderr");
const MANAGER_CORE = path.join(__dirname, "..");
const REPO_ROOT = path.join(__dirname, "..", "..");

function tempDir(t, prefix = "hub-errors-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeOverride(t, document) {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "hub-transfer-errors.json"), typeof document === "string" ? document : JSON.stringify(document));
  return dir;
}

function load(userDir) {
  return loadTransferErrorData({ userDir: userDir || path.join(os.tmpdir(), "hub-errors-no-such-dir") });
}

function stderr(name) {
  return fs.readFileSync(path.join(STDERR_DIR, `${name}.txt`), "utf8");
}

// "<code>.<variant>.txt" files: the code the wrapper must return.
const FIXTURES = fs.readdirSync(STDERR_DIR)
  .filter((file) => file.endsWith(".txt"))
  .map((file) => ({ name: file.slice(0, -4), code: file.split(".")[0] }));

// Fixtures whose 08 classification is `unknown` and that only the hub's
// `patterns` resolve.
const PATTERN_FIXTURES = ["hf_approval_required.live-access-denied", "repo_not_found.modelscope-401", "network_unreachable.proxy"];

const settings = () => defaultSettings();

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

test("the stderr corpus maps to 08 codes, with the hub patterns resolving only what 08 leaves unknown", () => {
  assert.ok(FIXTURES.length >= 15, "the corpus is present");
  for (const { name, code } of FIXTURES) {
    const tail = stderr(name);
    const result = classifyTransferFailure({ stderrTail: tail });
    const expectedBase = HUB_REFINEMENT_BASES[code] || code;
    // network_timeout is a refinement only with its text; the fixture has it.
    assert.equal(result.code, code, `${name} -> ${code}`);
    assert.equal(result.baseCode, expectedBase, `${name} keeps its 08 base`);
    const base = classifyDownloadFailure({ text: tail });
    if (PATTERN_FIXTURES.includes(name)) {
      assert.equal(base.code, "unknown", `${name} is a pattern case`);
    } else {
      assert.equal(base.code, expectedBase, `08 alone gives ${expectedBase} for ${name}`);
    }
    assert.ok(DOWNLOAD_ERROR_CODES.includes(result.baseCode));
    assert.ok(result.title.zh && result.title.en && result.hint.zh && result.hint.en);
  }
});

test("the live approval tail followed by noise lines still gives hf_approval_required with the right detail", () => {
  const tail = stderr("hf_approval_required.live-access-denied");
  const result = classifyTransferFailure({ stderrTail: tail, exitCode: 1 });
  assert.equal(result.code, "hf_approval_required");
  assert.equal(result.retryable, false);
  assert.deepEqual(result.actions, ["open-approval"]);
  assert.equal(result.detail, "Access denied. This repository requires approval.");
  assert.deepEqual(result.retry, { auto: false, maxAttempts: 0 });
  // Only the last 60 lines are looked at.
  const buried = `${tail}${"noise\n".repeat(80)}`;
  assert.equal(classifyTransferFailure({ stderrTail: buried }).code, "unknown");
  assert.equal(classifyTransferFailure({ stderrTail: buried.split("\n") }).code, "unknown", "an array of lines works too");
});

test("08 download-errors fixtures give the same codes through the wrapper", () => {
  const cases = [
    ["stall", { signals: { stalled: true }, stderrTail: "No progress for a while" }],
    ["verify_failed", { signals: { verifyFailed: true } }],
    ["verify_failed", { stderrTail: "Download verification failed: 权重文件不完整" }],
    ["checksum_mismatch", { stderrTail: "sha256 mismatch for model-00001-of-00002.safetensors" }],
    ["cli_missing", { spawnError: Object.assign(new Error("spawn hf ENOENT"), { code: "ENOENT", syscall: "spawn hf" }) }],
    ["cli_missing", { stderrTail: "/bin/sh: 1: hf: command not found" }],
    ["disk_full", { stderrTail: "OSError: [Errno 28] No space left on device" }],
    ["hf_approval_required", { stderrTail: "Your request to access model org/model is awaiting a review from the repo authors." }],
    ["hf_auth_invalid", { stderrTail: "ValueError: Invalid user token.", signals: { credentialMode: "temp-token", cachedToken: false } }],
    ["hf_token_expired", { signals: { errorCode: "hf_token_expired" } }],
    ["repo_not_found", { stderrTail: "RepositoryNotFoundError: 404 Client Error." }],
    ["revision_not_found", { stderrTail: "RevisionNotFoundError: 404 Client Error." }],
    ["filter_no_match", { signals: { errorCode: "filter_no_match" } }],
    ["rate_limited", { stderrTail: "429 Client Error: Too Many Requests for url: https://huggingface.co/x" }],
    ["network_unreachable", { stderrTail: "ConnectionError: Max retries exceeded with url" }],
    ["unknown", { stderrTail: "Process exited with code 1" }],
    ["unknown", {}],
  ];
  const seen = new Set();
  for (const [code, input] of cases) {
    const result = classifyTransferFailure(input);
    assert.equal(result.code, code, `${code} for ${JSON.stringify(input).slice(0, 100)}`);
    assert.equal(result.baseCode, code);
    seen.add(result.code);
  }
  assert.deepEqual([...seen].sort(), [...DOWNLOAD_ERROR_CODES].sort(), "every 08 code is covered");
  const base = classifyDownloadFailure({ text: "429 Client Error: Too Many Requests" });
  const wrapped = classifyTransferFailure({ stderrTail: "429 Client Error: Too Many Requests" });
  assert.equal(wrapped.retryDelayFactor, base.retryDelayFactor);
  assert.equal(wrapped.minRetryDelaySeconds, 120);
});

test("the result shape carries class, retry and a redacted detail", () => {
  const token = `hf_${"a1b2c3d4e5".repeat(4)}`;
  const result = classifyTransferFailure({
    stderrTail: `401 Client Error: Unauthorized, Invalid user token ${token}\nafter line`,
    signals: { credentialMode: "temp-token", cachedToken: false },
  });
  assert.equal(result.code, "hf_auth_invalid");
  assert.equal(result.class, "auth");
  assert.ok(!result.detail.includes(token), "the token is not in the detail");
  assert.match(result.detail, /<redacted>/);
  const custom = classifyTransferFailure({ stderrTail: "401 Client Error", signals: { secrets: ["not-in-text-xyz"] } });
  assert.equal(custom.detail, "401 Client Error");
  assert.equal(classifyTransferFailure({ signals: { stalled: true } }).class, "watchdog");
  assert.deepEqual(classifyTransferFailure({ signals: { stalled: true } }).retry, { auto: true, maxAttempts: 3 });
  assert.deepEqual(classifyTransferFailure({ signals: { verifyFailed: true } }).retry, { auto: true, maxAttempts: 2 });
  assert.deepEqual(classifyTransferFailure({ stderrTail: "x" }).retry, { auto: true, maxAttempts: 1 });
});

test("ModelScope 401/403 maps to repo_not_found even where 08 would say an HF code", () => {
  const result = classifyTransferFailure({ stderrTail: "modelscope request failed: 403 Client Error: Forbidden", source: "modelscope" });
  assert.equal(result.code, "repo_not_found");
  assert.equal(result.baseCode, "repo_not_found");
  const hf = classifyTransferFailure({ stderrTail: "modelscope request failed: 403 Client Error: Forbidden", source: "huggingface" });
  assert.equal(hf.code, "hf_approval_required", "other sources keep 08's answer");
});

test("a checksum failure on the same file twice is not retryable", () => {
  const once = classifyTransferFailure({ stderrTail: "sha256 mismatch", signals: { badFiles: ["a.safetensors"] } });
  assert.equal(once.retryable, true);
  const twice = classifyTransferFailure({ stderrTail: "sha256 mismatch", signals: { badFiles: ["a.safetensors"], previousBadFiles: ["a.safetensors"] } });
  assert.equal(twice.code, "checksum_mismatch");
  assert.equal(twice.retryable, false);
  assert.deepEqual(twice.retry, { auto: false, maxAttempts: 0 });
  const other = classifyTransferFailure({ stderrTail: "sha256 mismatch", signals: { badFiles: ["b.safetensors"], previousBadFiles: ["a.safetensors"] } });
  assert.equal(other.retryable, true);
});

// ---------------------------------------------------------------------------
// Refinements
// ---------------------------------------------------------------------------

test("the refinement set is fixed in code, one per 08 base", () => {
  assert.deepEqual([...HUB_REFINEMENT_CODES], ["network_timeout", "hf_login_required", "transfer_empty"]);
  assert.deepEqual({ ...HUB_REFINEMENT_BASES }, {
    network_timeout: "network_unreachable",
    hf_login_required: "hf_auth_invalid",
    transfer_empty: "filter_no_match",
  });
  assert.deepEqual([...HUB_ERROR_CODES], [...DOWNLOAD_ERROR_CODES, ...HUB_REFINEMENT_CODES]);
  assert.equal(Object.isFrozen(HUB_ERROR_CODES) && Object.isFrozen(HUB_REFINEMENT_CODES), true);
  for (const code of HUB_REFINEMENT_CODES) assert.equal(DOWNLOAD_ERROR_CODES.includes(code), false, "08's list is untouched");
});

test("network_timeout fires on a timeout text or the resolving timeout, only on network_unreachable", () => {
  for (const tail of [stderr("network_timeout.read-timeout"), "httpx.ReadTimeout: timed out", "connect ETIMEDOUT 1.2.3.4:443"]) {
    const result = classifyTransferFailure({ stderrTail: tail });
    assert.equal(result.code, "network_timeout", tail);
    assert.equal(result.baseCode, "network_unreachable");
    assert.equal(result.retryable, true);
    assert.deepEqual(result.retry, { auto: true, maxAttempts: 3 });
    assert.deepEqual(result.actions, ["switch-source"]);
    assert.equal(result.class, "network");
  }
  const resolving = classifyTransferFailure({ stderrTail: "", signals: { resolveTimeout: true } });
  assert.equal(resolving.code, "network_timeout");
  assert.equal(resolving.baseCode, "network_unreachable");
  // Plain network errors without a timeout word stay on the base code.
  assert.equal(classifyTransferFailure({ stderrTail: stderr("network_unreachable.dns") }).code, "network_unreachable");
  // The same words under another base do not refine.
  assert.equal(classifyTransferFailure({ stderrTail: "disk write timed out: No space left on device" }).code, "disk_full");
});

test("hf_login_required fires on hf_auth_invalid only without a usable token", () => {
  const tail = stderr("hf_auth_invalid.unauthorized");
  const refined = classifyTransferFailure({ stderrTail: tail, signals: { credentialMode: "none", cachedToken: false } });
  assert.equal(refined.code, "hf_login_required");
  assert.equal(refined.baseCode, "hf_auth_invalid");
  assert.equal(refined.retryable, false);
  assert.deepEqual(refined.actions, ["sign-in"]);
  assert.equal(classifyTransferFailure({ stderrTail: tail, job: { transfer: { credentialMode: "cached-login", cachedToken: false } } }).code, "hf_login_required");
  for (const signals of [
    { credentialMode: "temp-token", cachedToken: false },
    { credentialMode: "none", cachedToken: true },
    { credentialMode: "remembered-token" },
    {},
  ]) {
    const result = classifyTransferFailure({ stderrTail: tail, signals });
    assert.equal(result.code, "hf_auth_invalid", JSON.stringify(signals));
    assert.equal(result.baseCode, "hf_auth_invalid");
  }
  // The conditions on another base change nothing.
  assert.equal(classifyTransferFailure({ stderrTail: "Connection reset: ECONNRESET", signals: { credentialMode: "none", cachedToken: false } }).code, "network_unreachable");
});

test("transfer_empty fires on filter_no_match only with the emptySelection signal", () => {
  const refined = classifyTransferFailure({ exitCode: 0, signals: { errorCode: "filter_no_match", emptySelection: true } });
  assert.equal(refined.code, "transfer_empty");
  assert.equal(refined.baseCode, "filter_no_match");
  assert.equal(refined.retryable, false);
  assert.deepEqual(refined.actions, ["view-log", "pick-artifact"]);
  assert.equal(refined.class, "selection");
  assert.equal(classifyTransferFailure({ signals: { errorCode: "filter_no_match" } }).code, "filter_no_match");
  assert.equal(classifyTransferFailure({ stderrTail: "sha256 mismatch", signals: { emptySelection: true } }).code, "checksum_mismatch");
});

// ---------------------------------------------------------------------------
// Data validation
// ---------------------------------------------------------------------------

test("the bundled data is valid and every key is an 08 code", () => {
  const loaded = load();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.source, "bundled");
  const { data } = loaded;
  for (const key of [...Object.keys(data.classes), ...Object.keys(data.maxAttempts)]) assert.ok(DOWNLOAD_ERROR_CODES.includes(key), key);
  for (const entry of [...data.patterns, ...data.remedies]) assert.ok(DOWNLOAD_ERROR_CODES.includes(entry.code), entry.code);
  for (const code of DOWNLOAD_ERROR_CODES) assert.ok(data.classes[code], `${code} has a class`);
  assert.deepEqual(data.refinements.map((entry) => entry.code), [...HUB_REFINEMENT_CODES]);
  for (const entry of data.refinements) assert.equal(entry.base, HUB_REFINEMENT_BASES[entry.code]);
  assert.equal(data.asOf, "2026-10-14");
  assert.equal(data.staleAfterDays, 180);
  assert.equal(typeof loaded.freshness.stale, "boolean");
  const raw = JSON.parse(fs.readFileSync(path.join(BUNDLED_DIR, "hub-transfer-errors.json"), "utf8"));
  assert.equal(raw.schemaVersion, 1);
  assert.deepEqual(Object.keys(raw.remedies[0].set), ["xet"]);
});

test("an override that adds a code is dropped and reported; the rest of the override applies", (t) => {
  const dir = writeOverride(t, {
    schemaVersion: 1,
    classes: { brand_new: "network", stall: "watchdog" },
    maxAttempts: { brand_new: 5, unknown: 2 },
    patterns: [
      { code: "brand_new", match: "whatever" },
      { code: "disk_full", match: "volume is full" },
    ],
    refinements: [
      { code: "rate_limit_burst", base: "rate_limited", when: { text: "burst" }, retryable: true, title: { zh: "x", en: "x" }, hint: { zh: "y", en: "y" } },
    ],
    remedies: [{ code: "brand_new", when: { text: "x" }, set: { xet: "off" }, maxTimes: 1 }],
  });
  const loaded = load(dir);
  assert.equal(loaded.source, "user");
  assert.equal(loaded.data.classes.brand_new, undefined);
  assert.equal(loaded.data.maxAttempts.brand_new, undefined);
  assert.equal(loaded.data.maxAttempts.unknown, 2, "a valid key in the same file applies");
  assert.equal(loaded.data.patterns.some((entry) => entry.code === "brand_new"), false);
  assert.equal(loaded.data.patterns.some((entry) => entry.code === "disk_full"), true);
  assert.deepEqual(loaded.data.refinements.map((entry) => entry.code), [...HUB_REFINEMENT_CODES]);
  assert.equal(loaded.data.remedies.length, 1);
  const unknownCodes = loaded.errors.filter((error) => error.code === "unknown_code");
  assert.equal(unknownCodes.length, 5);
  for (const error of loaded.errors) {
    assert.equal(error.name, "hub-transfer-errors.json");
    assert.equal(error.file, path.join(dir, "hub-transfer-errors.json"));
    assert.ok(error.message);
  }
  assert.equal(classifyTransferFailure({ stderrTail: "the volume is full" }, { data: loaded.data }).code, "disk_full");
  assert.equal(classifyTransferFailure({ stderrTail: "the volume is full" }).code, "unknown", "the default data is untouched");
});

test("an override changes matchers and copy of a refinement, merged by code; a bad change is dropped", (t) => {
  const dir = writeOverride(t, {
    schemaVersion: 1,
    refinements: [
      { code: "network_timeout", when: { text: "deadline exceeded" }, title: { zh: "超时了", en: "Timed out" } },
      { code: "hf_login_required", base: "repo_not_found" },
      { code: "transfer_empty", when: { text: "(" } },
    ],
  });
  const loaded = load(dir);
  const timeout = loaded.data.refinements.find((entry) => entry.code === "network_timeout");
  assert.deepEqual(timeout.title, { zh: "超时了", en: "Timed out" });
  assert.equal(timeout.hint.en.startsWith("Retrying"), true, "the copy not mentioned stays");
  assert.equal(timeout.when.text, "deadline exceeded");
  assert.equal(loaded.data.refinements.find((entry) => entry.code === "hf_login_required").base, "hf_auth_invalid");
  assert.equal(loaded.data.refinements.find((entry) => entry.code === "transfer_empty").when.signal, "emptySelection", "an invalid matcher change leaves the bundled one");
  assert.equal(loaded.errors.length, 2);
  assert.deepEqual(loaded.errors.map((error) => error.code), ["invalid_entry", "invalid_entry"]);
  const result = classifyTransferFailure({ stderrTail: "ConnectionError: gRPC deadline exceeded" }, { data: loaded.data });
  assert.equal(result.code, "network_timeout");
  assert.deepEqual(result.title, { zh: "超时了", en: "Timed out" });
});

test("invalid entries are dropped one by one, with the bundled entry kept", (t) => {
  const dir = writeOverride(t, {
    schemaVersion: 1,
    classes: { stall: "Bad Class", unknown: "mystery" },
    maxAttempts: { stall: 99, rate_limited: 1.5, verify_failed: 1 },
    patterns: [{ code: "unknown", match: "(" }, { code: "unknown", match: "x".repeat(500) }, "nope"],
    remedies: [{ code: "unknown", when: { text: "foo" }, set: { xet: "turbo" }, maxTimes: 1 }, { code: "unknown", when: { text: "foo" }, set: { other: "off" }, maxTimes: 1 }],
  });
  const loaded = load(dir);
  assert.equal(loaded.data.classes.stall, "watchdog");
  assert.equal(loaded.data.classes.unknown, "mystery");
  assert.equal(loaded.data.maxAttempts.stall, 3);
  assert.equal(loaded.data.maxAttempts.rate_limited, 3);
  assert.equal(loaded.data.maxAttempts.verify_failed, 1);
  assert.equal(loaded.data.patterns.filter((entry) => entry.code === "unknown").length, 0);
  assert.equal(loaded.data.patterns.length, 3, "the bundled patterns stay");
  assert.equal(loaded.data.remedies.length, 1, "the bundled remedy stays");
  assert.equal(loaded.errors.length, 8);
  assert.equal(loaded.errors.every((error) => error.code === "invalid_entry"), true);
});

test("a corrupt or foreign-schema override is reported and ignored; startup never throws", (t) => {
  for (const [document, code] of [["{ not json", "corrupt"], ["", "corrupt"], ["[]", "corrupt"], [{ schemaVersion: 2, classes: { stall: "x" } }, "unsupported_schema"]]) {
    const loaded = load(writeOverride(t, document));
    assert.deepEqual(loaded.errors.map((error) => error.code), [code]);
    assert.equal(loaded.data.classes.stall, "watchdog");
    assert.equal(loaded.data.refinements.length, 3);
  }
  const missingBundled = loadTransferErrorData({ bundledDir: tempDir(t), userDir: tempDir(t) });
  assert.deepEqual(missingBundled.data.refinements, []);
  assert.deepEqual(missingBundled.errors, []);
});

test("an override is reported in /api/hub/status dataErrors and through the status provider", async (t) => {
  const root = tempDir(t, "hub-root-");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "hub-transfer-errors.json"), JSON.stringify({
    schemaVersion: 1,
    classes: { brand_new: "network" },
    patterns: [{ code: "unknown", match: "(" }],
  }));
  const providers = new Map();
  const lines = [];
  const hub = createModelHub({
    aiRoot: root,
    dataDir: path.join(root, "service-entry", "data", "hub"),
    env: {},
    heartbeatMs: 3_600_000,
    logger: { warn: (line) => lines.push(String(line)), log() {}, info() {}, error() {} },
    registerStatusProvider: (name, fn) => providers.set(name, fn),
  });
  t.after(() => hub.stop());
  await hub.start();
  assert.equal(hub.state, "running", "bad data never stops the hub");
  const errors = hub.status().dataErrors.filter((error) => error.name === "hub-transfer-errors.json");
  assert.deepEqual(errors.map((error) => error.code).sort(), ["invalid_entry", "unknown_code"]);
  assert.ok(errors.every((error) => error.file === path.join(root, "config", "hub-transfer-errors.json")));
  assert.equal(hub.transferErrorData().refinements.length, 3);
  const provided = providers.get("hub-transfer-errors")();
  assert.equal(provided.ok, false);
  assert.equal(provided.errors.length, 2);
  assert.equal(lines.some((line) => line.includes("were dropped")), true);
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

test("every hub code has a zh and en title and hint, and actions", () => {
  assert.equal(HUB_ERROR_CODES.length, 17);
  for (const code of HUB_ERROR_CODES) {
    const entry = describeHubError(code);
    assert.equal(entry.code, code);
    for (const field of ["title", "hint"]) {
      assert.equal(typeof entry[field].zh, "string", `${code} ${field}.zh`);
      assert.equal(typeof entry[field].en, "string", `${code} ${field}.en`);
      assert.ok(entry[field].zh.trim() && entry[field].en.trim());
      assert.match(entry[field].zh, /[一-鿿]/, `${code} ${field}.zh is Chinese`);
    }
    assert.ok(DOWNLOAD_ERROR_CODES.includes(entry.baseCode));
    assert.ok(Array.isArray(HUB_ERROR_ACTIONS[code]), `${code} has an action list`);
    assert.ok(entry.class);
  }
  assert.equal(describeHubError("network_timeout").baseCode, "network_unreachable");
  assert.equal(describeHubError("no_such_code").code, "unknown");
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

test("retry decisions follow retryability, per-class switches and the per-code caps", () => {
  const stall = classifyTransferFailure({ signals: { stalled: true } });
  assert.equal(retryDecision(stall, {}, settings()).retry, true);
  assert.equal(retryDecision(stall, { retry: { count: 2 } }, settings()).retry, true);
  const exhausted = retryDecision(stall, { retry: { count: 3 } }, settings());
  assert.deepEqual([exhausted.retry, exhausted.reason], [false, "exhausted"]);

  const integrity = classifyTransferFailure({ signals: { verifyFailed: true } });
  assert.equal(retryDecision(integrity, { retry: { count: 1 } }, settings()).retry, true);
  assert.equal(retryDecision(integrity, { retry: { count: 2 } }, settings()).reason, "exhausted", "verify_failed is capped at 2");

  const unknown = classifyTransferFailure({ stderrTail: "boom" });
  assert.equal(retryDecision(unknown, { retry: { count: 0 } }, settings()).retry, true);
  assert.equal(retryDecision(unknown, { retry: { count: 1 } }, settings()).retry, false, "unknown is capped at 1");

  // The settings cap applies on top of the per-code cap.
  const capped = { ...settings(), retry: { ...settings().retry, maxAttempts: 1 } };
  assert.equal(retryDecision(stall, { retry: { count: 1 } }, capped).reason, "exhausted");
  const off = { ...settings(), retry: { ...settings().retry, maxAttempts: 0 } };
  assert.equal(retryDecision(stall, {}, off).reason, "disabled");

  // Per-class switches: false disables, "once" allows a single retry.
  const noNetwork = { ...settings(), retry: { ...settings().retry, perClass: { ...settings().retry.perClass, network: false } } };
  const network = classifyTransferFailure({ stderrTail: stderr("network_unreachable.dns") });
  assert.equal(retryDecision(network, {}, noNetwork).reason, "class_disabled");
  assert.equal(retryDecision(stall, {}, noNetwork).retry, true, "other classes are not affected");
  const onceNetwork = { ...settings(), retry: { ...settings().retry, perClass: { ...settings().retry.perClass, network: "once" } } };
  assert.equal(retryDecision(network, { retry: { count: 0 } }, onceNetwork).retry, true);
  assert.equal(retryDecision(network, { retry: { count: 1 } }, onceNetwork).reason, "exhausted");
  // A refinement uses the class of its base.
  const timeout = classifyTransferFailure({ stderrTail: stderr("network_timeout.read-timeout") });
  assert.equal(retryDecision(timeout, {}, noNetwork).reason, "class_disabled");
  assert.equal(retryDecision(timeout, {}, settings()).retry, true);
});

test("no setting can enable auto-retry for a non-retryable code", () => {
  const generous = { retry: { maxAttempts: 10, perClass: { network: true, server: true, watchdog: true, integrity: true, tooling: true } } };
  for (const code of HUB_ERROR_CODES) {
    const entry = describeHubError(code);
    const decision = retryDecision({ code }, {}, generous);
    assert.equal(decision.retry, entry.retryable, `${code}`);
    if (!entry.retryable) assert.equal(decision.reason, "not_retryable");
  }
  // The result of the wrapper wins over the table, as for a repeated checksum failure.
  const twice = classifyTransferFailure({ stderrTail: "sha256 mismatch", signals: { badFiles: ["a"], previousBadFiles: ["a"] } });
  assert.equal(retryDecision(twice, {}, generous).retry, false);
  for (const code of ["hf_login_required", "transfer_empty", "cli_missing", "disk_full"]) {
    assert.equal(retryDecision({ code }, {}, generous).retry, false, code);
  }
  assert.equal(retryDecision({ code: "network_timeout" }, {}, generous).retry, true);
});

test("backoff is min(max, base * 2^(n-1)) * retryDelayFactor with +-20 % jitter", () => {
  const s = settings();
  const stall = classifyTransferFailure({ signals: { stalled: true } });
  const at = (attempt, random, extra = {}) => retryDecision(stall, { retry: { count: attempt - 1 } }, extra.settings || s, { random: () => random, now: Date.UTC(2026, 9, 14), ...extra.options });
  // The default max attempts of the stall code is 3: attempts 1..3.
  assert.equal(at(1, 0.5).delayMs, 10_000);
  assert.equal(at(1, 0).delayMs, 8_000);
  assert.equal(at(1, 1).delayMs, 12_000);
  assert.equal(at(2, 0.5).delayMs, 20_000);
  assert.equal(at(3, 0.5).delayMs, 40_000);
  assert.equal(at(3, 0.5).nextAt, "2026-10-14T00:00:40.000Z");
  const slow = { ...s, retry: { ...s.retry, baseDelaySeconds: 300, maxDelaySeconds: 400, maxAttempts: 5 } };
  assert.equal(at(1, 0.5, { settings: slow }).delayMs, 300_000);
  assert.equal(at(2, 0.5, { settings: slow }).delayMs, 400_000, "capped at the max delay");
  for (let i = 0; i < 50; i += 1) {
    const delay = retryDecision(stall, {}, s).delayMs;
    assert.ok(delay >= 8_000 && delay <= 12_000, `jittered delay ${delay}`);
  }
});

test("rate_limited multiplies the delay by 4, at least 120 s, and Retry-After wins when larger", () => {
  const limited = classifyTransferFailure({ stderrTail: "429 Client Error: Too Many Requests" });
  assert.equal(limited.code, "rate_limited");
  assert.equal(limited.retryDelayFactor, 4);
  const options = { random: () => 0.5 };
  assert.equal(retryDecision(limited, {}, settings(), options).delayMs, 120_000, "10 s x 4 is raised to the 120 s floor");
  assert.equal(retryDecision(limited, { retry: { count: 1 } }, settings(), options).delayMs, 120_000, "20 s x 4 = 80 s -> 120 s");
  assert.equal(retryDecision(limited, { retry: { count: 2 } }, settings(), options).delayMs, 160_000, "40 s x 4");
  const withHeader = classifyTransferFailure({ stderrTail: stderr("rate_limited.http429") });
  assert.equal(withHeader.retryAfterSeconds, 45);
  assert.equal(retryDecision(withHeader, {}, settings(), options).delayMs, 120_000, "a smaller Retry-After does not shorten it");
  assert.equal(retryDecision(limited, {}, settings(), { ...options, retryAfterSeconds: 900 }).delayMs, 900_000);
  assert.equal(retryDecision(limited, { retry: { count: 3 } }, settings(), options).reason, "exhausted");
});

test("the xet-off remedy is offered once and only for its text", () => {
  const xet = classifyTransferFailure({ stderrTail: stderr("unknown.xet") });
  assert.equal(xet.code, "unknown");
  assert.deepEqual(xet.remedy, { code: "unknown", set: { xet: "off" }, maxTimes: 1 });
  const first = retryDecision(xet, { retry: { count: 0 } }, settings());
  assert.equal(first.retry, true);
  assert.deepEqual(first.remedy, { reason: "unknown/xet", set: { xet: "off" }, attempt: 1 });

  const applied = { retry: { count: 0 }, transfer: { optionsHistory: [{ at: "2026-10-14T00:00:00.000Z", reason: "unknown/xet", set: { xet: "off" } }] } };
  assert.equal(retryDecision(xet, applied, settings()).remedy, null, "not applied twice");
  assert.equal(retryDecision(xet, { retry: { count: 0 }, transfer: { xet: "off" } }, settings()).remedy, null, "nothing to change");

  const plain = classifyTransferFailure({ stderrTail: stderr("unknown.exit1") });
  assert.equal(plain.remedy, null);
  assert.equal(retryDecision(plain, {}, settings()).remedy, null);
  // The remedy needs a retry to ride on.
  const off = { ...settings(), retry: { ...settings().retry, maxAttempts: 0 } };
  assert.equal(retryDecision(xet, {}, off).remedy, null);
});

// ---------------------------------------------------------------------------
// HubError and the envelope
// ---------------------------------------------------------------------------

test("HubError and toEnvelope produce the 00 §4.2 envelope", () => {
  const failure = classifyTransferFailure({ stderrTail: stderr("repo_not_found.hub") });
  const error = HubError.fromFailure(failure);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "HubError");
  assert.equal(error.code, "repo_not_found");
  assert.equal(error.status, 404);
  const { status, body } = toEnvelope(error);
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "repo_not_found");
  assert.equal(body.error.message, "Repository not found");
  assert.equal(body.error.hint, failure.hint.en);
  assert.deepEqual(body.error.details.title, failure.title);
  assert.equal(body.error.details.baseCode, "repo_not_found");

  const custom = new HubError("hub_disabled", "The hub is off.", { status: 409, hint: "Turn it on.", details: { flag: "rollback" } });
  assert.deepEqual(toEnvelope(custom), {
    status: 409,
    body: { ok: false, error: { code: "hub_disabled", message: "The hub is off.", hint: "Turn it on.", details: { flag: "rollback" } } },
  });
  assert.equal(new HubError("network_timeout").status, 504);
  assert.equal(new HubError("network_timeout").message, "The download source timed out");
  assert.equal(new HubError("something_else").status, 500);

  const token = `hf_${"z9y8x7w6v5".repeat(4)}`;
  const leaky = toEnvelope(new Error(`failed with ${token}`));
  assert.equal(leaky.status, 500);
  assert.equal(leaky.body.error.code, "unknown");
  assert.ok(!JSON.stringify(leaky).includes(token));
  assert.equal(toEnvelope(null).body.error.message, "Download failed", "an empty failure describes itself as unknown");
  assert.equal(toEnvelope(failure).body.error.code, "repo_not_found", "a classification result works as well");
});

// ---------------------------------------------------------------------------
// Grep guards
// ---------------------------------------------------------------------------

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "test", "tests", ".git", "worktrees"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// Comments may explain why a header is forbidden; the guard is about code.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
}

test("guard: no x-hub-shim header name in any non-test source under the four packages", () => {
  const offenders = [];
  for (const pkg of ["manager-core", "service-entry", "vllm-manager", "llama-manager"]) {
    const dir = path.join(REPO_ROOT, pkg);
    if (!fs.existsSync(dir)) continue;
    for (const file of listFiles(dir)) {
      if (/x-hub-shim/i.test(stripComments(fs.readFileSync(file, "utf8")))) offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("guard: model-hub holds no redaction function and no hub-secrets file", () => {
  const hubDir = path.join(MANAGER_CORE, "model-hub");
  const files = fs.readdirSync(hubDir, { recursive: true }).filter((name) => String(name).endsWith(".js"));
  assert.ok(files.includes("errors.js"));
  for (const name of files) {
    const source = stripComments(fs.readFileSync(path.join(hubDir, String(name)), "utf8"));
    assert.equal(/function\s+redact/.test(source), false, `${name} defines a redaction function`);
    assert.equal(/hub-secrets/.test(source), false, `${name} mentions hub-secrets`);
  }
  assert.equal(fs.existsSync(path.join(hubDir, "hub-secrets.json")), false);
});
