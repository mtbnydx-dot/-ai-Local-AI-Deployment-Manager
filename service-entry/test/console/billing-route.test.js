// CON-22 (07 §6.11): the billing embed's URL builder and its i18n keys. The
// iframe, theme reload and viewer EmptyState run in a browser
// (tests/frontend/console/console-billing.spec.js).

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { mergeI18nAreas } = require("../../lib/console-routes.js");
const { CONSOLE_DIR } = await import("./loader.mjs");
const { billingEmbedSrc } = await import(pathToFileURL(path.join(CONSOLE_DIR, "routes", "billing.js")).href);
const { ROUTES } = await import(pathToFileURL(path.join(CONSOLE_DIR, "routes.js")).href);
const catalogs = mergeI18nAreas(path.join(CONSOLE_DIR, "i18n")).catalogs;

test("billingEmbedSrc is host-relative and always carries embed and theme", () => {
  assert.equal(billingEmbedSrc({ theme: "dark" }), "/billing/classic?embed=1&theme=dark");
  assert.equal(billingEmbedSrc({ theme: "light", manager: "vllm" }), "/billing/classic?embed=1&theme=light&manager=vllm");
  assert.equal(billingEmbedSrc({}), "/billing/classic?embed=1&theme=auto");
});

test("billingEmbedSrc rejects unknown themes and malformed manager ids", () => {
  assert.equal(billingEmbedSrc({ theme: "neon" }), "/billing/classic?embed=1&theme=auto");
  for (const manager of ["", "a&b=1", "../x", "x".repeat(40), "http://evil", undefined, 5]) {
    assert.ok(!billingEmbedSrc({ theme: "auto", manager }).includes("manager"), String(manager));
  }
});

test("the billing route is owner-only and its strings exist in both languages", () => {
  const route = ROUTES.find((entry) => entry.name === "billing");
  assert.equal(route.path, "/billing");
  assert.equal(route.ownerOnly, true);
  for (const locale of ["zh-CN", "en-US"]) {
    for (const key of ["billing.frame.title", "billing.localOnly.title", "billing.localOnly.body", "billing.localOnly.action"]) {
      assert.ok(catalogs[locale][key], `${locale} ${key}`);
    }
  }
  assert.equal(catalogs["zh-CN"]["billing.localOnly.title"], "计费管理仅限本机");
});
