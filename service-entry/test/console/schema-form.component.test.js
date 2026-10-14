// CON-10: the node-testable parts of components/schema-form.js. Rendering,
// focus, axe and the editing behaviour are covered in a browser by
// tests/frontend/console/console-schema-form.spec.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);

test("SchemaForm exports the component and follows the shared component rules", async () => {
  const module = await load("components/schema-form.js");
  assert.equal(typeof module.SchemaForm, "function");
  assert.equal(typeof module.parseNumberText, "function");
  const source = fs.readFileSync(path.join(CONSOLE_DIR, "components", "schema-form.js"), "utf8");
  assert.match(source, /data-testid/);
  assert.equal(/\sstyle="/.test(source), false, "no inline style attribute (CSP style-src 'self')");
  assert.match(source, /data-field=/, "the data-field hook");
  assert.match(source, /data-source=/, "the data-source hook");
  const demo = await load("routes/system/schema-form-demo.js");
  assert.equal(typeof demo.default, "function");
  assert.equal(typeof demo.mountSchemaFormDemo, "function");
});

test("parseNumberText separates empty, a number and half-typed text", async () => {
  const { parseNumberText } = await load("components/schema-form.js");
  assert.equal(parseNumberText(""), null);
  assert.equal(parseNumberText("  "), null);
  assert.equal(parseNumberText("42"), 42);
  assert.equal(parseNumberText("-1.5"), -1.5);
  assert.equal(parseNumberText("1e"), undefined);
  assert.equal(parseNumberText("-"), undefined);
});

test("every engines.form key the component names has zh-CN and en-US copy", () => {
  const source = fs.readFileSync(path.join(CONSOLE_DIR, "components", "schema-form.js"), "utf8");
  const keys = new Set([...source.matchAll(/["'`](engines\.[A-Za-z0-9_.-]+[A-Za-z0-9_-])["'`]/g)].map((match) => match[1]));
  assert.ok(keys.size > 20);
  for (const locale of ["zh-CN", "en-US"]) {
    const catalog = JSON.parse(fs.readFileSync(path.join(CONSOLE_DIR, "i18n", "engines", `${locale}.json`), "utf8"));
    for (const key of keys) {
      if (key.endsWith(".")) continue;
      assert.ok(Object.hasOwn(catalog, key), `${locale} has ${key}`);
    }
    // The dynamic families the component builds with tk().
    for (const key of ["engines.form.level.basic", "engines.form.level.advanced", "engines.form.level.expert", "engines.form.tristate.default", "engines.form.tristate.on", "engines.form.tristate.off",
      "engines.form.availability.unavailable", "engines.form.availability.unverified", "engines.form.secret.set", "engines.form.secret.unchanged", "engines.form.secret.pending", "engines.form.secret.clearing",
      "engines.form.err.out_of_range", "engines.form.err.out_of_range_min", "engines.form.err.out_of_range_max", "engines.form.err.not_in_choices", "engines.form.err.item_invalid",
      "engines.source.user", "engines.source.planner", "engines.source.recipe", "engines.source.model", "engines.source.knowledge", "engines.source.engine-default", "engines.source.platform-default"]) {
      assert.ok(Object.hasOwn(catalog, key), `${locale} has ${key}`);
    }
  }
});
