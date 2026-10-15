"use strict";

// The portal's own dictionaries (05 §12.1, PUB-15): service-entry/portal/i18n/
// {zh-CN,en-US}.json. Key parity, no duplicate keys, matching placeholders, no
// Han text in English, and every key the portal sources use exists.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PORTAL = path.join(__dirname, "..", "portal");
const LOCALES = ["zh-CN", "en-US"];
const HAN = /[㐀-䶿一-鿿豈-﫿]/;

function readText(locale) {
  return fs.readFileSync(path.join(PORTAL, "i18n", `${locale}.json`), "utf8").replace(/^﻿/, "");
}

// Every key of every object in a JSON text, in order. JSON.parse keeps only the
// last of two equal keys, so duplicates need the text itself.
function objectKeys(text) {
  const stack = [];
  const keys = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === "{") {
      stack.push([]);
    } else if (ch === "}") {
      keys.push(...stack.pop());
    } else if (ch === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const raw = text.slice(index + 1, end);
      let after = end + 1;
      while (/\s/.test(text[after] || "")) after += 1;
      if (text[after] === ":" && stack.length) stack[stack.length - 1].push(JSON.parse(`"${raw}"`));
      index = end;
    }
    index += 1;
  }
  return keys;
}

function placeholders(value) {
  return [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort();
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "i18n" && entry.name !== "docs" && entry.name !== "data") out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const dictionaries = Object.fromEntries(LOCALES.map((locale) => [locale, JSON.parse(readText(locale))]));

test("both dictionaries hold exactly the same keys", () => {
  const zh = Object.keys(dictionaries["zh-CN"]).sort();
  const en = Object.keys(dictionaries["en-US"]).sort();
  assert.deepEqual(en.filter((key) => !zh.includes(key)), [], "keys only in en-US");
  assert.deepEqual(zh.filter((key) => !en.includes(key)), [], "keys only in zh-CN");
  assert.ok(zh.length > 100);
});

test("neither dictionary repeats a key", () => {
  for (const locale of LOCALES) {
    const keys = objectKeys(readText(locale));
    const seen = new Set();
    const repeated = keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)));
    assert.deepEqual(repeated, [], `${locale} repeats keys`);
  }
});

test("keys are flat lower-case ids and values are non-empty strings", () => {
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(dictionaries[locale])) {
      assert.match(key, /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/, `${locale}: ${key}`);
      assert.equal(typeof value, "string", `${locale}: ${key}`);
      assert.ok(value.trim(), `${locale}: ${key} is empty`);
    }
  }
});

test("both languages use the same {placeholders}", () => {
  for (const key of Object.keys(dictionaries["zh-CN"])) {
    assert.deepEqual(placeholders(dictionaries["en-US"][key]), placeholders(dictionaries["zh-CN"][key]), key);
  }
});

test("English has no Han text and Chinese has some", () => {
  for (const [key, value] of Object.entries(dictionaries["en-US"])) {
    assert.ok(!HAN.test(value), `en-US ${key} contains Han text`);
  }
  // A value without Chinese in zh-CN is a copy of the English (names such as
  // "{count}" alone are the only legitimate exception).
  for (const [key, value] of Object.entries(dictionaries["zh-CN"])) {
    assert.ok(HAN.test(value), `zh-CN ${key} has no Chinese text`);
  }
});

test("every translation key the portal sources use exists", () => {
  const known = new Set(Object.keys(dictionaries["zh-CN"]));
  const used = new Set();
  const prefixes = new Set();
  for (const file of sourceFiles(PORTAL)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bt(?:\.has)?\(\s*(["'])([a-z0-9_.]+)\1/g)) used.add(match[2]);
    // t(`prefix.${expr}`): at least one key must live under the prefix.
    for (const match of text.matchAll(/\bt(?:\.has)?\(\s*`([a-z0-9_.]+?)\$\{/g)) prefixes.add(match[1]);
    // Keys kept in data tables (label: "x.y") are listed by the pages as data-i18n="…".
    for (const match of text.matchAll(/data-i18n="([a-z0-9_.]+)"/g)) used.add(match[1]);
  }
  assert.ok(used.size > 50, "the scan should find the portal's keys");
  assert.deepEqual([...used].filter((key) => !known.has(key)), [], "keys used but not defined");
  for (const prefix of prefixes) {
    assert.ok([...known].some((key) => key.startsWith(prefix)), `no key under ${prefix}`);
  }
});

test("the status, state, queue and severity vocabularies are complete", () => {
  const known = new Set(Object.keys(dictionaries["en-US"]));
  const need = [
    ...["operational", "degraded", "offline", "maintenance", "unknown"].map((name) => `status.${name}`),
    ...["ready", "loading", "starting", "degraded", "offline", "sleeping", "cold", "unknown"].map((name) => `state.${name}`),
    ...["idle", "light", "busy", "unknown"].map((name) => `queue.${name}`),
    ...["info", "maintenance", "incident"].map((name) => `severity.${name}`),
    ...["up", "down", "none"].map((name) => `status.hour_${name}`),
    ...["text", "vision", "audio", "embedding", "rerank", "tools", "reasoning", "recommended"].map((name) => `tag.${name}`),
  ];
  assert.deepEqual(need.filter((key) => !known.has(key)), []);
});

test("every public error code of the taxonomy has portal text", () => {
  const { publicErrorCodes } = require("../lib/public-errors");
  const codes = publicErrorCodes();
  assert.ok(codes.length > 20);
  const known = new Set(Object.keys(dictionaries["en-US"]));
  // csrf_invalid is an ADMIN-only code; the portal never meets it.
  assert.deepEqual(codes.filter((code) => code !== "csrf_invalid" && !known.has(`error.${code}`)), []);
});
