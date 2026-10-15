"use strict";

// Hub console copy (docs/overhaul/03-hub.md §19, HUB-15): the `hub` area under
// console/i18n/hub. Coverage is checked against the live hub modules, so a new
// state, wait reason, fit label or error action without copy fails here. The
// cross-area gate (parity, duplicates, unused keys) is console/i18n.test.js.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { mergeI18nAreas } = require("../lib/console-routes");
const { HUB_ERROR_ACTIONS } = require("../../manager-core/model-hub/errors");
const { FIT_LABELS } = require("../../manager-core/model-hub/fit");
const { JOB_STATES, WAIT_REASONS } = require("../../manager-core/model-hub/queue");

const I18N_DIR = path.join(__dirname, "..", "console", "i18n");
const HUB_DIR = path.join(I18N_DIR, "hub");
const LOCALES = ["zh-CN", "en-US"];
const HAN = /\p{Script=Han}/u;

function readArea(locale) {
  return JSON.parse(fs.readFileSync(path.join(HUB_DIR, `${locale}.json`), "utf8"));
}

const catalogs = Object.fromEntries(LOCALES.map((locale) => [locale, readArea(locale)]));
const keysOf = (catalog) => Object.keys(catalog).filter((key) => !key.startsWith("$"));

// Action ids the plan's `blocking[]` entries carry besides the 6.3 error table.
const PLAN_ACTIONS = ["open-storage", "open-downloads"];
// Actions the queue and library UI offer on a job (03 6.3, 9.5, 14).
const JOB_ACTIONS = ["retry", "pause", "resume", "start-now", "cancel-keep", "cancel-delete", "download-run"];

test("hub area declares only the hub. prefix and every key lives under it", () => {
  for (const locale of LOCALES) {
    const catalog = catalogs[locale];
    assert.equal(catalog.$locale, locale);
    assert.deepEqual(catalog.$prefixes, ["hub."]);
    for (const key of keysOf(catalog)) assert.ok(key.startsWith("hub."), `${locale}: ${key} is outside hub.*`);
  }
});

test("both locale files have identical key sets, sorted keys and non-empty values", () => {
  const zh = keysOf(catalogs["zh-CN"]);
  const en = keysOf(catalogs["en-US"]);
  assert.deepEqual(zh, en);
  assert.deepEqual(zh, [...zh].sort());
  for (const locale of LOCALES) {
    for (const key of keysOf(catalogs[locale])) {
      assert.equal(typeof catalogs[locale][key], "string", `${locale}: ${key}`);
      assert.ok(catalogs[locale][key].trim(), `${locale}: ${key} is empty`);
    }
  }
});

test("placeholders match across locales and English has no Han text", () => {
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of keysOf(catalogs["zh-CN"])) {
    assert.deepEqual(placeholders(catalogs["en-US"][key]), placeholders(catalogs["zh-CN"][key]), key);
    assert.ok(!HAN.test(catalogs["en-US"][key]), `en-US ${key} contains Han text`);
    assert.ok(HAN.test(catalogs["zh-CN"][key]) || /^[\w .&-]+$/.test(catalogs["zh-CN"][key]), `zh-CN ${key} is not translated`);
  }
});

test("every 7.1 state has hub.state.* and every wait reason has hub.wait.*", () => {
  const keys = new Set(keysOf(catalogs["en-US"]));
  for (const state of JOB_STATES) {
    // `waiting` is also described by its reason; both are written.
    assert.ok(keys.has(`hub.state.${state}`), `hub.state.${state}`);
  }
  for (const reason of WAIT_REASONS) assert.ok(keys.has(`hub.wait.${reason}`), `hub.wait.${reason}`);
});

test("every fit label has hub.fit.* and the params basis note exists", () => {
  const keys = new Set(keysOf(catalogs["en-US"]));
  for (const label of FIT_LABELS) assert.ok(keys.has(`hub.fit.${label}`), `hub.fit.${label}`);
  assert.ok(keys.has("hub.fit.basis.params"));
});

test("every action id in the 6.3 table, the plan blockers and the job controls has hub.action.*", () => {
  const keys = new Set(keysOf(catalogs["en-US"]));
  const ids = new Set([...Object.values(HUB_ERROR_ACTIONS).flat(), ...PLAN_ACTIONS, ...JOB_ACTIONS]);
  assert.ok(ids.size >= 15, "the action universe is unexpectedly small");
  for (const id of ids) assert.ok(keys.has(`hub.action.${id}`), `hub.action.${id}`);
});

test("the spec 19 fixed keys are all present", () => {
  const keys = new Set(keysOf(catalogs["en-US"]));
  for (const key of [
    "hub.error.fallback", "hub.error.notRetried", "hub.token.label", "hub.token.remember", "hub.token.localOnly",
    "hub.library.provenance.declared", "hub.library.provenance.detected", "hub.library.provenance.unverified",
    "hub.library.provenance.unknown", "hub.library.update.available", "hub.library.duplicate",
    "hub.storage.root.hidden", "hub.unavailable",
  ]) assert.ok(keys.has(key), key);
});

test("the real catalog merges without problems and no other area defines hub.* keys", () => {
  const merged = mergeI18nAreas(I18N_DIR);
  assert.deepEqual(merged.problems, []);
  const hubKeys = new Set(keysOf(catalogs["en-US"]));
  for (const area of fs.readdirSync(I18N_DIR, { withFileTypes: true })) {
    if (!area.isDirectory() || area.name === "hub") continue;
    for (const locale of LOCALES) {
      const other = JSON.parse(fs.readFileSync(path.join(I18N_DIR, area.name, `${locale}.json`), "utf8"));
      for (const key of keysOf(other)) assert.ok(!key.startsWith("hub."), `${area.name}/${locale}: ${key}`);
    }
  }
  for (const locale of LOCALES) {
    for (const key of hubKeys) assert.ok(key in merged.catalogs[locale], `${locale}: ${key} missing from the merged catalog`);
  }
});

test("dynamic-keys.json prefixes sit inside the area and unused keys exist", () => {
  const dynamic = JSON.parse(fs.readFileSync(path.join(HUB_DIR, "dynamic-keys.json"), "utf8"));
  const keys = new Set(keysOf(catalogs["en-US"]));
  for (const prefix of dynamic.prefixes) assert.ok(prefix.startsWith("hub."), prefix);
  for (const key of dynamic.unused) assert.ok(keys.has(key), `unused allowlist names a missing key ${key}`);
});
