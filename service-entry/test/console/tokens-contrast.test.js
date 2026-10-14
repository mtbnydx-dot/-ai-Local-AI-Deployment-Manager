// 07 §4.1 / CON-3: shared-public/styles/tokens.css is the one token file the
// console and the public portal link. This test parses both themes (resolving
// var() chains), checks the pairs in contrast-pairs.json, keeps the two dark
// blocks identical (so [data-theme=dark] and the OS preference give the same
// colors) and keeps console selectors out of the shared file.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STYLES = path.join(ROOT, "shared-public", "styles");
const CSS = fs.readFileSync(path.join(STYLES, "tokens.css"), "utf8");
const PAIRS = JSON.parse(fs.readFileSync(path.join(STYLES, "contrast-pairs.json"), "utf8"));

const LIGHT_SELECTOR = ":root";
const OS_DARK_SELECTOR = ':root:not([data-theme="light"])';
const FORCED_DARK_SELECTOR = ':root[data-theme="dark"]';
const OS_DARK_CONTEXT = "@media (prefers-color-scheme: dark)";

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Flat rule blocks with the at-rule they sit in ("" at top level). Enough for
// a token file: one nesting level, no strings containing braces.
function parseBlocks(text) {
  const source = stripComments(text);
  const blocks = [];
  function read(start, end, context) {
    let index = start;
    while (index < end) {
      const open = source.indexOf("{", index);
      if (open < 0 || open >= end) break;
      const header = source.slice(index, open).trim();
      let depth = 1;
      let cursor = open + 1;
      while (depth > 0) {
        const ch = source[cursor++];
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
      }
      if (header.startsWith("@")) read(open + 1, cursor - 1, header);
      else blocks.push({ selector: header, context, body: source.slice(open + 1, cursor - 1) });
      index = cursor;
    }
  }
  read(0, source.length, "");
  return blocks;
}

function declarations(body) {
  const map = new Map();
  for (const item of body.split(";")) {
    const at = item.indexOf(":");
    if (at < 0) continue;
    const name = item.slice(0, at).trim();
    if (name) map.set(name, item.slice(at + 1).trim());
  }
  return map;
}

const blocks = parseBlocks(CSS);
function block(selector, context = "") {
  const found = blocks.filter((entry) => entry.selector === selector && entry.context === context);
  assert.equal(found.length, 1, `exactly one "${selector}" block${context ? ` in ${context}` : ""}`);
  return declarations(found[0].body);
}

const light = block(LIGHT_SELECTOR);
const osDark = block(OS_DARK_SELECTOR, OS_DARK_CONTEXT);
const forcedDark = block(FORCED_DARK_SELECTOR);
const THEMES = { light, dark: new Map([...light, ...forcedDark]) };

function resolve(vars, value, seen = []) {
  return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name) => {
    assert.ok(!seen.includes(name), `var() cycle through ${name}`);
    assert.ok(vars.has(name), `${name} is not defined`);
    return resolve(vars, vars.get(name), [...seen, name]);
  });
}

function color(vars, name) {
  const value = resolve(vars, `var(${name})`).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  assert.ok(hex, `${name} resolves to a #rrggbb color, got "${value}"`);
  return [0, 2, 4].map((offset) => parseInt(hex[1].slice(offset, offset + 2), 16));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const FLOOR = { text: 4.5, "large-text": 3, icon: 3, border: 3, focus: 3 };
const COLOR_TOKEN = /^--(?:bg|surface-\d|text|text-muted|border|border-strong|accent|accent-ink|accent-soft|brand|brand-ink|focus-ring|success|warn|danger|(?:success|warn|danger)-(?:soft|ink)|chart-\d|(?:n|teal|blue|green|amber|red)-\d+)$/;

test("the OS-dark block and data-theme=dark declare the same tokens", () => {
  assert.deepEqual([...osDark.entries()].sort(), [...forcedDark.entries()].sort());
  assert.ok(forcedDark.size > 30, "dark overrides the whole semantic layer");
  assert.equal(THEMES.dark.get("--bg"), "#0b1118");
  assert.equal(THEMES.light.get("--bg"), "#f5f7fa");
});

test("dark overrides only tokens light defines, and no primitive moves", () => {
  for (const name of forcedDark.keys()) {
    if (name === "color-scheme") continue;
    assert.ok(light.has(name), `${name} exists in the light block`);
    assert.ok(!/^--(?:n|teal|blue|green|amber|red)-\d+$/.test(name), `${name} is a primitive and stays in :root`);
  }
});

test("every color token resolves to #rrggbb in both themes", () => {
  for (const [theme, vars] of Object.entries(THEMES)) {
    const names = [...vars.keys()].filter((name) => COLOR_TOKEN.test(name));
    assert.ok(names.length > 50, `${theme}: color tokens found`);
    for (const name of names) assert.equal(color(vars, name).length, 3, `${theme} ${name}`);
  }
});

test("contrast pairs hold in both themes", () => {
  const expanded = [];
  for (const pair of PAIRS.pairs) {
    const backgrounds = pair.bg === "@surfaces" ? PAIRS.surfaces : [pair.bg];
    for (const bg of backgrounds) expanded.push({ ...pair, bg });
  }
  assert.ok(expanded.length >= 40, "the pair list is not empty");
  for (const [theme, vars] of Object.entries(THEMES)) {
    for (const pair of expanded) {
      const wanted = typeof pair.min === "number" ? pair.min : pair.min[theme];
      assert.ok(wanted >= FLOOR[pair.kind], `${pair.fg} (${pair.kind}) declares a minimum of at least ${FLOOR[pair.kind]}`);
      const got = ratio(color(vars, pair.fg), color(vars, pair.bg));
      // The pair list quotes ratios rounded to two decimals.
      assert.ok(Math.round(got * 100) / 100 >= wanted, `${theme}: ${pair.fg} on ${pair.bg} is ${got.toFixed(2)}, needs ${wanted}`);
    }
  }
});

test("pairs cover every text-bearing semantic token", () => {
  const covered = new Set(PAIRS.pairs.flatMap((pair) => [pair.fg, pair.bg]));
  for (const name of ["--text", "--text-muted", "--accent", "--accent-ink", "--success", "--warn", "--danger", "--success-ink", "--warn-ink", "--danger-ink", "--brand-ink", "--border-strong", "--focus-ring"]) {
    assert.ok(covered.has(name), `${name} has a contrast pair`);
  }
  for (let n = 1; n <= 8; n += 1) assert.ok(covered.has(`--chart-${n}`), `--chart-${n} has a contrast pair`);
});

test("tokens.css holds only :root rules, so the portal can link it alone", () => {
  assert.deepEqual(blocks.map((entry) => entry.selector).sort(), [LIGHT_SELECTOR, OS_DARK_SELECTOR, FORCED_DARK_SELECTOR].sort());
  const text = stripComments(CSS);
  assert.ok(!/\burl\(|@import|@font-face/.test(text), "no external references");
  for (const name of ["--btn-h", "--input-h", "--row-h", "--pad-card", "--radius-control", "--radius-card", "--shadow-pop"]) {
    assert.ok(!text.includes(name), `${name} is a console component token and lives in base.css`);
  }
  assert.ok(!/data-density/.test(text), "density rules live in base.css");
});
