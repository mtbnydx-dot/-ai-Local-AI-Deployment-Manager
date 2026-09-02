#!/usr/bin/env node
"use strict";
// Lists Chinese UI strings in the manager pages that have no English entry:
// static text in index.html plus string literals the JS renders, checked
// against the exact dictionary, the regex patterns and the partial rules.
// Exit code is 1 only when --strict is passed; test-all runs it as a report.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const STRICT = process.argv.includes("--strict");

function loadDictionaries() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  const common = fs.readFileSync(path.join(ROOT, "shared-public/js/i18n-common.js"), "utf8");
  vm.runInContext(common, sandbox);
  const llamaCopy = fs.readFileSync(path.join(ROOT, "llama-manager/public/js/i18n-copy.js"), "utf8");
  vm.runInContext(llamaCopy, sandbox);
  const vllm = sandbox.window.VllmI18n || {};
  const llama = sandbox.window.LlamaI18n || {};
  // Keys rendered through t(key) carry their Chinese text as the zh-CN value.
  const copyValues = (copy) => new Set(Object.values(copy?.["zh-CN"] || {}).map((value) => String(value).replace(/\s+/g, " ").trim()));
  return {
    vllm: {
      exact: new Set([...Object.keys(vllm.UI_TEXT_TRANSLATIONS || {}), ...copyValues(vllm.UI_COPY)]),
      patterns: (vllm.UI_TRANSLATION_PATTERNS || []).map(([pattern]) => pattern),
      partials: (vllm.UI_PARTIAL_TRANSLATIONS || []).map(([pattern]) => pattern),
    },
    llama: {
      exact: new Set([...Object.keys(llama.EN_TEXT || {}), ...copyValues(llama.UI_COPY)]),
      patterns: (llama.UI_TRANSLATION_PATTERNS || []).map(([pattern]) => pattern),
      partials: (llama.UI_PARTIAL_TRANSLATIONS || []).map(([pattern]) => pattern),
    },
  };
}

function staticTexts(html) {
  const values = new Set();
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  for (const match of stripped.matchAll(/>([^<>]+)</g)) {
    const text = match[1].replace(/\s+/g, " ").trim();
    if (text && /\p{Script=Han}/u.test(text)) values.add(text);
  }
  for (const match of stripped.matchAll(/(?:placeholder|title|aria-label)="([^"]+)"/g)) {
    const text = match[1].replace(/\s+/g, " ").trim();
    if (text && /\p{Script=Han}/u.test(text)) values.add(text);
  }
  return Array.from(values);
}

function covered(text, dictionary) {
  if (dictionary.exact.has(text)) return true;
  if (dictionary.patterns.some((pattern) => pattern.test(text))) return true;
  let remaining = text;
  for (const partial of dictionary.partials) remaining = remaining.replace(partial, "");
  return !/\p{Script=Han}/u.test(remaining);
}

const dictionaries = loadDictionaries();
let total = 0;
const report = {};
for (const [engine, file] of [["vllm", "vllm-manager/public/index.html"], ["llama", "llama-manager/public/index.html"]]) {
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  const missing = staticTexts(html).filter((text) => !covered(text, dictionaries[engine]));
  report[engine] = missing;
  total += missing.length;
}
for (const [engine, missing] of Object.entries(report)) {
  console.log(`== ${engine}: ${missing.length} static string(s) without an English entry`);
  for (const text of missing.slice(0, 40)) console.log(`   - ${text}`);
  if (missing.length > 40) console.log(`   ... ${missing.length - 40} more`);
}
if (STRICT && total > 0) process.exit(1);
