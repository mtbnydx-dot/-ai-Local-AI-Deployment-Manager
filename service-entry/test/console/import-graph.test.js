// 07 §13.1 import graph: every console module imports in Node through the
// loader (no missing paths or exports, nothing touching the DOM or storage
// at top level), and the §11 size budgets hold.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { mergeI18nAreas } = require("../../lib/console-routes.js");
const { CONSOLE_DIR, mapConsoleUrl } = await import("./loader.mjs");

const KB = 1024;
const BUDGETS = { appConsole: 160 * KB, appVendor: 30 * KB, routeModule: 60 * KB, catalog: 160 * KB };
const LAZY_ONLY = ["uplot", "qrcode"];
// Route-only libraries (the engine-config forms, the Overview, Access, Engines, Deployments and Billing pages): loaded with their page module, never by app.js (07 §11 budgets app.js's closure).
const ROUTE_ONLY_LIBS = new Set(["lib/expr.js", "lib/schema-form-model.js", "lib/overview-model.js", "lib/access-model.js", "lib/exposure-model.js", "lib/portal-model.js", "lib/engines-model.js", "lib/deployments-model.js", "lib/billing-model.js", "lib/wizard-state.js", "lib/compat-model.js"]);

const STATIC_IMPORT = /(?:^|[;\n}])\s*(?:import|export)\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g;
const COMMENTS = /\/\*[\s\S]*?\*\/|(?<![:"'`\\])\/\/[^\n]*/g;

function consoleModules() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "i18n") walk(full);
      } else if (/\.m?js$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(CONSOLE_DIR);
  return out.sort();
}

/** The files a module statically imports, resolved as the browser would (vendor paths mapped). */
function staticImports(file) {
  const source = fs.readFileSync(file, "utf8").replace(COMMENTS, "");
  return [...source.matchAll(STATIC_IMPORT)].map((match) => fileURLToPath(mapConsoleUrl(new URL(match[1], pathToFileURL(file)).href)));
}

/** The static import closure of `entry`, as { file → bytes }. */
function closure(entry) {
  const seen = new Map();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.set(file, fs.statSync(file).size);
    for (const next of staticImports(file)) stack.push(next);
  }
  return seen;
}

function split(sizes) {
  let consoleBytes = 0;
  let vendorBytes = 0;
  for (const [file, bytes] of sizes) {
    if (file.startsWith(CONSOLE_DIR + path.sep)) consoleBytes += bytes;
    else vendorBytes += bytes;
  }
  return { consoleBytes, vendorBytes };
}

const rel = (file) => path.relative(CONSOLE_DIR, file).split(path.sep).join("/");

test("every console module imports in Node with no DOM, storage or missing export", async () => {
  const modules = consoleModules();
  assert.ok(modules.length >= 25, `found only ${modules.length} modules`);
  const failures = [];
  for (const file of modules) {
    try {
      await import(pathToFileURL(file).href);
    } catch (error) {
      failures.push(`${rel(file)}: ${error.message.split("\n")[0]}`);
    }
  }
  assert.deepEqual(failures, []);
  for (const name of ["document", "window", "localStorage", "sessionStorage"]) {
    assert.equal(typeof globalThis[name], "undefined", `${name} must stay undefined so a top-level touch fails the import`);
  }
});

test("every static import resolves to a file, and every module is reachable or an entry point", () => {
  const modules = consoleModules();
  const reached = new Set();
  const missing = [];
  for (const file of modules) {
    for (const target of staticImports(file)) {
      if (!fs.existsSync(target)) missing.push(`${rel(file)} -> ${target}`);
      reached.add(target);
    }
  }
  assert.deepEqual(missing, []);
  const entryPoints = modules.filter((file) => !reached.has(file)).map(rel);
  // app.js boots the page; lib/ui modules that nothing imports yet are the
  // core libraries later packages build on, so they must at least be listed.
  for (const entry of entryPoints) {
    assert.ok(entry === "app.js" || entry.startsWith("lib/") || entry.startsWith("ui/") || entry.startsWith("routes/") || entry.startsWith("components/") || entry.startsWith("data/"), entry);
  }
});

test("§11 budgets: app.js closure, the core library closure and lazy-only vendors", () => {
  const app = closure(path.join(CONSOLE_DIR, "app.js"));
  const appSizes = split(app);
  assert.ok(appSizes.consoleBytes <= BUDGETS.appConsole, `app.js console closure ${appSizes.consoleBytes} B > ${BUDGETS.appConsole} B`);
  assert.ok(appSizes.vendorBytes <= BUDGETS.appVendor, `app.js vendor closure ${appSizes.vendorBytes} B > ${BUDGETS.appVendor} B`);

  // Everything CON-4 ships, imported together, must already fit what app.js may load.
  const core = new Map();
  for (const file of consoleModules().filter((item) => /^(lib|ui)\//.test(rel(item)) && !ROUTE_ONLY_LIBS.has(rel(item)))) {
    for (const [dep, bytes] of closure(file)) core.set(dep, bytes);
  }
  const coreSizes = split(core);
  assert.ok(coreSizes.consoleBytes <= BUDGETS.appConsole, `core libraries ${coreSizes.consoleBytes} B > ${BUDGETS.appConsole} B`);
  assert.ok(coreSizes.vendorBytes <= BUDGETS.appVendor, `core vendor code ${coreSizes.vendorBytes} B > ${BUDGETS.appVendor} B`);
  for (const file of core.keys()) {
    for (const lazy of LAZY_ONLY) {
      assert.equal(file.includes(`${path.sep}vendor${path.sep}${lazy}${path.sep}`), false, `${lazy} is in a static closure (${file})`);
    }
  }
});

test("§11 budgets: each route module's own static imports stay under 60 KB", () => {
  const routes = consoleModules().filter((file) => rel(file).startsWith("routes/"));
  for (const file of routes) {
    const own = [...closure(file)].filter(([dep]) => dep === file || rel(dep).startsWith("routes/") || rel(dep).startsWith("components/"));
    const bytes = own.reduce((sum, [, size]) => sum + size, 0);
    assert.ok(bytes <= BUDGETS.routeModule, `${rel(file)} ${bytes} B > ${BUDGETS.routeModule} B`);
  }
});

test("§11 budgets: the merged catalog stays under 160 KB per locale", () => {
  const merged = mergeI18nAreas(path.join(CONSOLE_DIR, "i18n"));
  for (const [locale, catalog] of Object.entries(merged.catalogs)) {
    const bytes = Buffer.byteLength(JSON.stringify(catalog));
    assert.ok(bytes <= BUDGETS.catalog, `${locale} catalog ${bytes} B > ${BUDGETS.catalog} B`);
  }
});

test("the lazy loaders resolve uPlot and qrcode through the loader", async () => {
  const lazy = await import(pathToFileURL(path.join(CONSOLE_DIR, "ui", "vendor-lazy.js")).href);
  assert.equal(typeof await lazy.loadUplot(), "function");
  assert.equal(typeof await lazy.loadQrcode(), "function");
  assert.equal(await lazy.loadUplot(), await lazy.loadUplot(), "one load per page");
  assert.match(lazy.uplotStylesheetUrl(), /\/vendor\/uplot\/1\.6\.32\/uPlot\.min\.css$/);
});

test("ui/html.js renders htm templates through Preact", async () => {
  const { html, h } = await import(pathToFileURL(path.join(CONSOLE_DIR, "ui", "html.js")).href);
  const node = html`<p class="x">${"hi"}</p>`;
  assert.equal(node.type, "p");
  assert.equal(node.props.class, "x");
  assert.equal(typeof h, "function");
  const vendor = await import(pathToFileURL(path.join(CONSOLE_DIR, "ui", "vendor.js")).href);
  assert.equal("options" in vendor, false, "Preact's options hooks are not exposed (07 C1)");
  assert.equal(typeof vendor.icons, "object");
});
