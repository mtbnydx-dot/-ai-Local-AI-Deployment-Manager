// 07 §3.1 module rules over every console module, plus fixtures proving
// that each rule fires. Comments are stripped first, so a comment may name
// what the code must not do; string and template contents are checked.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CONSOLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "console");

const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_KEYWORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|new|delete|void|throw|yield|await)$/;

/** The source with every comment blanked (line breaks kept, so line numbers stay). */
export function stripComments(source) {
  let out = "";
  let index = 0;
  let last = "";
  const length = source.length;
  while (index < length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
      continue;
    }
    if (char === "\"" || char === "'") {
      let cursor = index + 1;
      while (cursor < length && source[cursor] !== char && source[cursor] !== "\n") cursor += source[cursor] === "\\" ? 2 : 1;
      out += source.slice(index, cursor + 1);
      index = cursor + 1;
      last = char;
      continue;
    }
    if (char === "`") {
      let cursor = index + 1;
      let depth = 0;
      while (cursor < length) {
        const current = source[cursor];
        if (current === "\\") {
          cursor += 2;
          continue;
        }
        if (depth === 0 && current === "`") break;
        if (current === "$" && source[cursor + 1] === "{") {
          depth += 1;
          cursor += 2;
          continue;
        }
        if (depth > 0 && current === "{") depth += 1;
        if (depth > 0 && current === "}") depth -= 1;
        cursor += 1;
      }
      out += source.slice(index, cursor + 1);
      index = cursor + 1;
      last = "`";
      continue;
    }
    if (char === "/" && (!last || REGEX_BEFORE.test(last) || REGEX_KEYWORD.test(out.trimEnd()))) {
      let cursor = index + 1;
      let inClass = false;
      while (cursor < length && source[cursor] !== "\n") {
        const current = source[cursor];
        if (current === "\\") {
          cursor += 2;
          continue;
        }
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
        cursor += 1;
      }
      out += source.slice(index, cursor + 1);
      index = cursor + 1;
      last = "/";
      continue;
    }
    out += char;
    if (!/\s/.test(char)) last = char;
    index += 1;
  }
  return out;
}

const STATIC_IMPORT = /(?:^|[;\n}])\s*(?:import|export)\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const VENDOR_PATH = /\bvendor\/[a-z0-9-]+\/\d[^"'`\s]*/;
const HAN = /\p{Script=Han}/u;
// The browser's fetch: a bare call or one through globalThis/window/self.
// A method that happens to be called fetch (the query cache's) is not it.
const GLOBAL_FETCH = /(?:\b(?:globalThis|window|self)\s*\.\s*|(?<![\w$.]))fetch\s*\(/;

const FORBIDDEN = [
  ["innerHTML", /\binnerHTML\b/],
  ["outerHTML", /\bouterHTML\b/],
  ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  ["dangerouslySetInnerHTML", /\bdangerouslySetInnerHTML\b/],
  ["document.write", /\bdocument\s*\.\s*write(?:ln)?\b/],
  ["setAttribute(\"style\"", /\bsetAttribute\(\s*["'`]style["'`]/],
  ["eval(", /(?<![\w$.])eval\s*\(/],
  ["new Function", /\bnew\s+Function\b/],
  ["127.0.0.1", /127\.0\.0\.1/],
  ["localhost:", /localhost:/i],
  [":5177", /:5177\b/],
  [":5178", /:5178\b/],
];

/** Every §3.1 violation in one module; `file` is relative to console/ with forward slashes. */
export function lintModule(file, source) {
  const problems = [];
  const code = stripComments(source);
  const inLib = file.startsWith("lib/");
  const add = (rule) => problems.push(`${file}: ${rule}`);

  const specifiers = [...code.matchAll(STATIC_IMPORT), ...code.matchAll(DYNAMIC_IMPORT)].map((match) => match[1]);
  for (const specifier of specifiers) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) add(`bare or absolute import "${specifier}"`);
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    if (inLib && !target.startsWith("lib/")) add(`lib/ imports outside lib/ ("${specifier}")`);
  }
  if (inLib && file !== "lib/storage.js" && /\b(?:document|window)\b/.test(code)) add("lib/ touches the DOM (document/window)");
  if (VENDOR_PATH.test(code) && file !== "ui/vendor.js" && file !== "ui/vendor-lazy.js") add("vendor path outside ui/vendor.js and ui/vendor-lazy.js");
  if (file === "ui/vendor.js" && /vendor\/(?:uplot|qrcode)\//.test(code)) add("uPlot and qrcode must load lazily");
  for (const [name, pattern] of FORBIDDEN) if (pattern.test(code)) add(`forbidden ${name}`);
  if (/http:\/\//.test(code) && file !== "data/client-guides.js") add("http:// outside data/client-guides.js");
  if (GLOBAL_FETCH.test(code) && file !== "lib/api.js" && file !== "routes/playground.js") add("fetch( outside lib/api.js and routes/playground.js");
  if (/\b(?:localStorage|sessionStorage)\b|\bdocument\s*\.\s*cookie\b/.test(code) && file !== "lib/storage.js") add("storage or cookies outside lib/storage.js");
  if (HAN.test(code)) add("Han characters outside comments (copy belongs in the catalogs)");
  const lazyCalls = code.replace(/\bfunction\s+load(?:Uplot|Qrcode)\s*\(/g, "").match(/\bload(Uplot|Qrcode)\s*\(/g) || [];
  for (const call of lazyCalls) {
    const allowed = call.startsWith("loadUplot") ? "components/time-series-chart.js" : "components/qr-code.js";
    if (file !== allowed) add(`${call.replace(/\s*\($/, "")}() outside ${allowed}`);
  }
  return problems;
}

function consoleModules() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "i18n") walk(full);
      } else if (/\.m?js$/.test(entry.name)) {
        out.push(path.relative(CONSOLE_DIR, full).split(path.sep).join("/"));
      }
    }
  };
  walk(CONSOLE_DIR);
  return out.sort();
}

test("every console module follows the 07 §3.1 rules", () => {
  const modules = consoleModules();
  assert.ok(modules.includes("lib/api.js") && modules.includes("ui/vendor.js") && modules.includes("app.js"));
  const problems = modules.flatMap((file) => lintModule(file, fs.readFileSync(path.join(CONSOLE_DIR, file), "utf8")));
  assert.deepEqual(problems, []);
});

test("stripComments keeps strings, templates and regexes and drops comments", () => {
  const source = [
    "const a = \"// not a comment\"; // gone",
    "const b = `x ${y /* inner */} // kept`; /* gone */",
    "const c = /\\/\\/[/]/g.test(z) / 2; // gone",
    "const d = 'it''s'; return /a\\//;",
  ].join("\n");
  const stripped = stripComments(source);
  assert.ok(stripped.includes("\"// not a comment\""));
  assert.ok(stripped.includes("// kept`"));
  assert.ok(stripped.includes("/\\/\\/[/]/g"));
  assert.ok(stripped.includes("return /a\\//"));
  assert.equal(stripped.includes("gone"), false);
  assert.equal(stripped.split("\n").length, 4, "line breaks are kept");
});

test("each rule fires on a fixture", () => {
  const cases = [
    ["lib/x.js", "import { h } from \"../ui/vendor.js\";", "lib/ imports outside lib/"],
    ["lib/x.js", "export const y = document.title;", "lib/ touches the DOM"],
    ["components/x.js", "import { h } from \"../vendor/preact/10.29.8/preact.module.js\";", "vendor path outside"],
    ["components/x.js", "import x from \"preact\";", "bare or absolute import"],
    ["ui/vendor.js", "export { default } from \"../vendor/uplot/1.6.32/uPlot.esm.js\";", "uPlot and qrcode must load lazily"],
    ["components/x.js", "node.innerHTML = s;", "forbidden innerHTML"],
    ["components/x.js", "el.insertAdjacentHTML('x', s);", "forbidden insertAdjacentHTML"],
    ["components/x.js", "html`<div dangerouslySetInnerHTML=${x} />`", "forbidden dangerouslySetInnerHTML"],
    ["components/x.js", "document.write(s);", "forbidden document.write"],
    ["components/x.js", "el.setAttribute(\"style\", s);", "forbidden setAttribute(\"style\""],
    ["components/x.js", "eval(s);", "forbidden eval("],
    ["components/x.js", "const f = new Function(s);", "forbidden new Function"],
    ["routes/x.js", "const u = \"127.0.0.1\";", "forbidden 127.0.0.1"],
    ["routes/x.js", "const u = `localhost:${p}`;", "forbidden localhost:"],
    ["routes/x.js", "const u = host + \":5177\";", "forbidden :5177"],
    ["routes/x.js", "const u = host + \":5178/\";", "forbidden :5178"],
    ["routes/x.js", "const u = \"http://example.test\";", "http:// outside"],
    ["routes/x.js", "fetch(\"/api/x\");", "fetch( outside"],
    ["components/x.js", "const r = await window.fetch(u);", "fetch( outside"],
    ["routes/x.js", "localStorage.getItem(\"x\");", "storage or cookies outside"],
    ["lib/prefs.js", "const c = doc.cookie; document.cookie = c;", "storage or cookies outside"],
    ["routes/x.js", "const label = \"模型\";", "Han characters outside comments"],
    ["routes/x.js", "loadUplot();", "loadUplot() outside components/time-series-chart.js"],
    ["routes/x.js", "await loadQrcode();", "loadQrcode() outside components/qr-code.js"],
  ];
  for (const [file, source, rule] of cases) {
    const problems = lintModule(file, source);
    assert.ok(problems.some((problem) => problem.includes(rule)), `${file} ${source} -> ${problems.join("; ") || "no problem"}`);
  }
  const allowed = [
    ["lib/api.js", "const r = await globalThis.fetch(url);"],
    ["routes/playground.js", "const r = await fetch(url, init);"],
    ["lib/storage.js", "globalThis.localStorage; globalThis.document.cookie;"],
    ["data/client-guides.js", "const base = \"http://<host>:5176\";"],
    ["components/time-series-chart.js", "const uPlot = await loadUplot();"],
    ["components/qr-code.js", "const qrcode = await loadQrcode();"],
    ["ui/vendor-lazy.js", "export function loadUplot() { return import(\"../vendor/uplot/1.6.32/uPlot.esm.js\"); }"],
    ["routes/x.js", "// innerHTML, 127.0.0.1 and 模型 may appear in comments\nconst ok = 1; /* eval( */"],
    ["lib/x.js", "export const el = doc.documentElement;"],
    ["ui/x.js", "cache.fetch(key, fn, { ttlMs });"],
  ];
  for (const [file, source] of allowed) assert.deepEqual(lintModule(file, source), [], `${file}: ${source}`);
});
