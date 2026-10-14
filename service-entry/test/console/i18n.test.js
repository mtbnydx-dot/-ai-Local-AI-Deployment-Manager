// 07 §3.7 / 00 §9.16 i18n gate over console/i18n/<area>/{zh-CN,en-US}.json.
//
// Per area: equal key sets in both locales, identical $prefixes, sorted keys,
// every key under its area's prefixes, non-empty zh-CN values. Across areas:
// disjoint prefixes and no key defined twice. On the merged catalog: equal
// placeholders per key, plurals with `other`, no Han in en-US, every literal
// t("…") present, every tk("…") prefix declared in a dynamic-keys.json, and no
// unused keys outside the allowlists. The gate itself is proven on temp
// copies: removing one en key, or copying a key into a second area, fails it.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createI18n, placeholdersOf, resolveLocale, tk } from "../../console/lib/i18n.js";

const require = createRequire(import.meta.url);
const { mergeI18nAreas } = require("../../lib/console-routes.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONSOLE_DIR = path.join(ROOT, "console");
const I18N_DIR = path.join(CONSOLE_DIR, "i18n");
const LOCALES = ["zh-CN", "en-US"];
const HAN = /\p{Script=Han}/u;
// The language switcher may name Chinese in Chinese on the English page.
const HAN_IN_EN_ALLOWED = new Set(["shell.lang.zh"]);

const T_CALL = /(?<![\w$])t\(\s*(["'`])([^"'`$\n]+)\1/g;
const TK_CALL = /(?<![\w$])tk\(\s*(["'`])([^"'`$\n]*)\1/g;
const KEY_LITERAL = /(["'`])([a-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+)\1/g;

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

/** Every console module's source text, which decides what counts as used. */
function consoleSources(consoleDir = CONSOLE_DIR) {
  return walk(consoleDir, (file) => /\.m?js$/.test(file) && !file.includes(`${path.sep}i18n${path.sep}`))
    .map((file) => ({ file: path.relative(consoleDir, file), text: fs.readFileSync(file, "utf8") }));
}

function readJson(file) {
  const text = fs.readFileSync(file, "utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/**
 * The whole gate over an i18n folder and a set of sources.
 * @returns {string[]} problems, empty when the catalogs pass
 */
function auditI18n(i18nDir, sources) {
  const problems = [];
  const areas = fs.readdirSync(i18nDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const owners = new Map();
  const prefixOwners = [];
  const dynamicPrefixes = [];
  const unusedAllowed = new Set();
  const merged = { "zh-CN": {}, "en-US": {} };

  for (const area of areas) {
    const files = {};
    for (const locale of LOCALES) {
      const file = path.join(i18nDir, area, `${locale}.json`);
      try {
        files[locale] = readJson(file);
      } catch (error) {
        problems.push(`${area}/${locale}.json cannot be read: ${error.message}`);
      }
    }
    if (!files["zh-CN"] || !files["en-US"]) continue;
    const keysOf = (data) => Object.keys(data).filter((key) => !key.startsWith("$"));
    for (const locale of LOCALES) {
      if (files[locale].$locale !== locale) problems.push(`${area}/${locale}.json declares $locale ${files[locale].$locale}`);
      const keys = keysOf(files[locale]);
      const sorted = [...keys].sort();
      if (keys.join("\n") !== sorted.join("\n")) problems.push(`${area}/${locale}.json keys are not sorted`);
    }
    const prefixes = files["zh-CN"].$prefixes;
    if (!Array.isArray(prefixes) || !prefixes.length) problems.push(`${area} has no $prefixes`);
    if (JSON.stringify(prefixes) !== JSON.stringify(files["en-US"].$prefixes)) problems.push(`${area} $prefixes differ between locales`);
    for (const prefix of Array.isArray(prefixes) ? prefixes : []) prefixOwners.push({ area, prefix });

    const zhKeys = keysOf(files["zh-CN"]);
    const enKeys = keysOf(files["en-US"]);
    for (const key of zhKeys) if (!enKeys.includes(key)) problems.push(`${area}: ${key} is missing in en-US`);
    for (const key of enKeys) if (!zhKeys.includes(key)) problems.push(`${area}: ${key} is missing in zh-CN`);

    for (const locale of LOCALES) {
      for (const key of keysOf(files[locale])) {
        if (!(prefixes || []).some((prefix) => key.startsWith(prefix))) problems.push(`${area}: ${key} is outside the area's $prefixes`);
        if (locale === "zh-CN") {
          const owner = owners.get(key);
          if (owner && owner !== area) problems.push(`${key} is defined in two areas: ${owner} and ${area}`);
          else owners.set(key, area);
        }
        merged[locale][key] = files[locale][key];
      }
    }
    for (const key of enKeys) {
      if (!zhKeys.includes(key) && owners.has(key) && owners.get(key) !== area) problems.push(`${key} is defined in two areas: ${owners.get(key)} and ${area}`);
    }

    const dynamicFile = path.join(i18nDir, area, "dynamic-keys.json");
    if (fs.existsSync(dynamicFile)) {
      const dynamic = readJson(dynamicFile);
      for (const prefix of dynamic.prefixes || []) {
        dynamicPrefixes.push(prefix);
        if (!(prefixes || []).some((owned) => prefix.startsWith(owned))) problems.push(`${area}: dynamic prefix ${prefix} is outside the area's $prefixes`);
      }
      for (const key of dynamic.unused || []) unusedAllowed.add(key);
    }
  }

  for (let a = 0; a < prefixOwners.length; a += 1) {
    for (let b = a + 1; b < prefixOwners.length; b += 1) {
      const left = prefixOwners[a];
      const right = prefixOwners[b];
      if (left.area !== right.area && (left.prefix.startsWith(right.prefix) || right.prefix.startsWith(left.prefix))) {
        problems.push(`prefixes overlap: ${left.area} ${left.prefix} and ${right.area} ${right.prefix}`);
      }
    }
  }

  for (const key of Object.keys(merged["zh-CN"])) {
    const zh = merged["zh-CN"][key];
    const en = merged["en-US"][key];
    if (en === undefined) continue;
    const zhForms = typeof zh === "string" ? [zh] : Object.values(zh || {});
    if (!zhForms.length || zhForms.some((form) => typeof form !== "string" || !form.trim())) problems.push(`${key}: zh-CN value is empty`);
    for (const [locale, value] of [["zh-CN", zh], ["en-US", en]]) {
      if (value !== null && typeof value === "object" && typeof value.other !== "string") problems.push(`${key}: ${locale} plural has no "other"`);
    }
    const zhVars = [...placeholdersOf(zh)].sort().join(",");
    const enVars = [...placeholdersOf(en)].sort().join(",");
    if (zhVars !== enVars) problems.push(`${key}: placeholders differ (zh-CN {${zhVars}} vs en-US {${enVars}})`);
    const enForms = typeof en === "string" ? [en] : Object.values(en || {});
    if (!HAN_IN_EN_ALLOWED.has(key) && enForms.some((form) => HAN.test(String(form)))) problems.push(`${key}: en-US contains Han characters`);
  }

  const literals = new Set();
  for (const { file, text } of sources) {
    for (const match of text.matchAll(T_CALL)) {
      if (!Object.hasOwn(merged["en-US"], match[2])) problems.push(`${file}: t("${match[2]}") is not in the catalog`);
    }
    for (const match of text.matchAll(TK_CALL)) {
      if (!dynamicPrefixes.some((prefix) => match[2].startsWith(prefix) || prefix.startsWith(match[2]) && match[2] === prefix)) {
        problems.push(`${file}: tk("${match[2]}") matches no dynamic-keys.json prefix`);
      }
    }
    for (const match of text.matchAll(KEY_LITERAL)) literals.add(match[2]);
  }
  for (const key of Object.keys(merged["en-US"])) {
    const used = literals.has(key) || dynamicPrefixes.some((prefix) => key.startsWith(prefix)) || unusedAllowed.has(key);
    if (!used) problems.push(`${key} is never used (add it to dynamic-keys.json "unused" if a later package uses it)`);
  }
  return problems;
}

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

function tempCopy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-i18n-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  copyDir(I18N_DIR, dir);
  return dir;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

test("the console catalogs pass the gate", () => {
  assert.deepEqual(auditI18n(I18N_DIR, consoleSources()), []);
});

test("the server merge of the real catalogs reports no problem and keeps every key", () => {
  const merged = mergeI18nAreas(I18N_DIR);
  assert.deepEqual(merged.problems, []);
  const zh = Object.keys(merged.catalogs["zh-CN"]);
  assert.deepEqual(zh, Object.keys(merged.catalogs["en-US"]));
  assert.ok(zh.includes("shell.product"));
});

test("the shell area carries the 07 §3.7 seed keys", () => {
  const zh = readJson(path.join(I18N_DIR, "shell", "zh-CN.json"));
  const en = readJson(path.join(I18N_DIR, "shell", "en-US.json"));
  assert.equal(zh["shell.product"], "本地 AI 平台");
  assert.equal(en["shell.product"], "Local AI Platform");
  assert.equal(en["shell.skip"], "Skip to main content");
  const nav = Object.keys(en).filter((key) => key.startsWith("shell.nav."));
  assert.equal(nav.length, 12);
  assert.deepEqual(nav.map((key) => en[key]).sort(), ["Access & keys", "Alerts", "Audit", "Billing", "Deployments", "Engines", "Models", "Observability", "Overview", "Playground", "System", "Voice"]);
  for (const key of ["shell.readonly", "shell.update", "shell.conn.polling", "shell.conn.offline", "common.window.1h"]) assert.ok(zh[key] && en[key], key);
  assert.deepEqual(en["deploy.list.count"], { one: "{count} deployment", other: "{count} deployments" });
  assert.deepEqual(zh["deploy.list.count"], { other: "{count} 个部署" });
  assert.deepEqual(en.$prefixes, ["shell.", "common.", "status.", "error.", "overview.", "deploy.", "playground.", "billing.", "voice.", "prefs.", "uikit.", "notify."]);
});

test("gate proven: removing one en key fails", (t) => {
  const dir = tempCopy(t);
  const file = path.join(dir, "shell", "en-US.json");
  const data = readJson(file);
  delete data["shell.skip"];
  writeJson(file, data);
  assert.ok(auditI18n(dir, consoleSources()).includes("shell: shell.skip is missing in en-US"));
});

test("gate proven: copying a key into a second area fails", (t) => {
  const dir = tempCopy(t);
  const zh = { $locale: "zh-CN", $prefixes: ["models."], "models.title": "模型", "shell.product": "本地 AI 平台" };
  const en = { $locale: "en-US", $prefixes: ["models."], "models.title": "Models", "shell.product": "Local AI Platform" };
  writeJson(path.join(dir, "models", "zh-CN.json"), zh);
  writeJson(path.join(dir, "models", "en-US.json"), en);
  writeJson(path.join(dir, "models", "dynamic-keys.json"), { prefixes: [], unused: ["models.title"] });
  const problems = auditI18n(dir, consoleSources());
  assert.ok(problems.includes("shell.product is defined in two areas: models and shell"), problems.join("\n"));
  assert.ok(problems.includes("models: shell.product is outside the area's $prefixes"));
});

test("the gate catches every other rule on fixtures", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-i18n-rules-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeJson(path.join(dir, "alpha", "zh-CN.json"), {
    $locale: "zh-CN", $prefixes: ["alpha."],
    "alpha.b": "乙 {n}", "alpha.a": "甲", "alpha.empty": " ", "alpha.plural": { one: "一" }, "alpha.unused": "闲",
  });
  writeJson(path.join(dir, "alpha", "en-US.json"), {
    $locale: "en-US", $prefixes: ["alpha."],
    "alpha.a": "A", "alpha.b": "B {m}", "alpha.empty": "E", "alpha.plural": { other: "P" }, "alpha.unused": "U 中",
  });
  writeJson(path.join(dir, "beta", "zh-CN.json"), { $locale: "zh-CN", $prefixes: ["alpha.sub."], "alpha.sub.x": "x", "gamma.z": "z" });
  writeJson(path.join(dir, "beta", "en-US.json"), { $locale: "en-US", $prefixes: ["beta."], "alpha.sub.x": "x", "gamma.z": "z" });
  const sources = [{ file: "routes/x.js", text: 'html`${t("alpha.a")} ${t("alpha.b", { n })} ${t("alpha.missing")} ${t(tk("nope.", id))}` "alpha.empty" "alpha.plural" "alpha.sub.x" "gamma.z"' }];
  const problems = auditI18n(dir, sources);
  const expected = [
    "alpha/zh-CN.json keys are not sorted",
    "beta $prefixes differ between locales",
    "beta: gamma.z is outside the area's $prefixes",
    "prefixes overlap: alpha alpha. and beta alpha.sub.",
    "alpha.empty: zh-CN value is empty",
    "alpha.plural: zh-CN plural has no \"other\"",
    "alpha.b: placeholders differ (zh-CN {n} vs en-US {m})",
    "alpha.unused: en-US contains Han characters",
    "routes/x.js: t(\"alpha.missing\") is not in the catalog",
    "routes/x.js: tk(\"nope.\") matches no dynamic-keys.json prefix",
    "alpha.unused is never used (add it to dynamic-keys.json \"unused\" if a later package uses it)",
  ];
  for (const line of expected) assert.ok(problems.includes(line), `missing problem: ${line}\n${problems.join("\n")}`);
});

test("mergeI18nAreas reports a duplicate key and an invalid file as problems", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-i18n-merge-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const area of ["aaa", "bbb"]) {
    writeJson(path.join(dir, area, "zh-CN.json"), { $locale: "zh-CN", $prefixes: ["dup."], "dup.x": `${area} zh` });
    writeJson(path.join(dir, area, "en-US.json"), { $locale: "en-US", $prefixes: ["dup."], "dup.x": `${area} en` });
  }
  fs.mkdirSync(path.join(dir, "ccc"));
  fs.writeFileSync(path.join(dir, "ccc", "zh-CN.json"), "{ not json");
  writeJson(path.join(dir, "ccc", "en-US.json"), { $locale: "en-US", $prefixes: ["ccc."], "ccc.y": "y" });
  const merged = mergeI18nAreas(dir);
  const codes = merged.problems.map((problem) => `${problem.file}:${problem.code}`);
  assert.ok(codes.includes("bbb/zh-CN.json:duplicate_key"), codes.join(","));
  assert.ok(codes.includes("bbb/en-US.json:duplicate_key"));
  assert.ok(codes.includes("ccc/zh-CN.json:invalid_json"));
  assert.equal(merged.catalogs["zh-CN"]["dup.x"], "aaa zh", "the first area keeps the key");
});

test("createI18n: lookup, placeholders, plurals, fallback and pick", () => {
  const warnings = [];
  const en = createI18n({
    locale: "en-US",
    catalog: { "deploy.list.count": { one: "{count} deployment", other: "{count} deployments" }, "shell.conn.offline": "Offline since {time}" },
    fallbackCatalog: { "only.zh": "zh text" },
    onFallback: (what) => warnings.push(what),
  });
  assert.equal(en.t("deploy.list.count", { count: 1 }), "1 deployment");
  assert.equal(en.t("deploy.list.count", { count: 1234 }), "1,234 deployments");
  assert.equal(en.t("deploy.list.count"), "{count} deployments");
  assert.equal(en.t("shell.conn.offline", { time: "08:00" }), "Offline since 08:00");
  assert.equal(en.t("shell.conn.offline", {}), "Offline since {time}", "a missing variable stays visible");
  assert.equal(en.t("missing.key"), "missing.key");
  assert.equal(en.has("missing.key"), false);
  assert.equal(en.t("only.zh"), "zh text");
  assert.deepEqual(warnings, ["only.zh"]);
  assert.equal(en.pick({ zh: "中", en: "En" }), "En");
  assert.equal(en.pick({ "zh-CN": "中", "en-US": "En" }), "En");
  assert.deepEqual(en.pickInfo({ zh: "中" }), { text: "中", fallback: true });
  assert.equal(en.pick("plain"), "plain");
  assert.equal(en.pick(null), "");

  const zh = createI18n({ locale: "zh-CN", catalog: { "deploy.list.count": { other: "{count} 个部署" } } });
  assert.equal(zh.t("deploy.list.count", { count: 1 }), "1 个部署", "zh uses other only");
  assert.equal(zh.pick({ zh: "中", en: "En" }), "中");
  assert.equal(createI18n({ locale: "fr-FR" }).locale, "zh-CN");
  assert.equal(tk("status.", "ready"), "status.ready");
  assert.equal(tk("engines.phase.", "pull", "done"), "engines.phase.pull.done");
});

test("resolveLocale: preference, then navigator zh* or other, default zh-CN", () => {
  assert.equal(resolveLocale({ pref: "en-US", navigatorLanguages: ["zh-CN"] }), "en-US");
  assert.equal(resolveLocale({ pref: "auto", navigatorLanguages: ["zh-TW", "en"] }), "zh-CN");
  assert.equal(resolveLocale({ pref: "auto", navigatorLanguages: ["fr-FR", "zh-CN"] }), "en-US");
  assert.equal(resolveLocale({ navigatorLanguages: [] }), "zh-CN");
  assert.equal(resolveLocale({}), "zh-CN");
});
