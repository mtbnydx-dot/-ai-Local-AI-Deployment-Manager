// CON-27 (07 §6.11): the billing routes and what the page needs from the shell:
// eight routes onto five tabs, owner-only, with their strings in both
// languages. The tabs, forms and tables run in a browser
// (tests/frontend/console/console-billing.spec.js); the model they stand on is
// covered by billing-model.test.js.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { mergeI18nAreas } = require("../../lib/console-routes.js");
const { CONSOLE_DIR } = await import("./loader.mjs");
const { ROUTES } = await import(pathToFileURL(path.join(CONSOLE_DIR, "routes.js")).href);
const { matchRoute } = await import(pathToFileURL(path.join(CONSOLE_DIR, "lib", "router.js")).href);
const billing = await import(pathToFileURL(path.join(CONSOLE_DIR, "routes", "billing", "index.js")).href);
const catalogs = mergeI18nAreas(path.join(CONSOLE_DIR, "i18n")).catalogs;

const PATHS = {
  billing: "/billing",
  "billing.customers": "/billing/customers",
  "billing.credentials": "/billing/credentials",
  "billing.plans": "/billing/plans",
  "billing.prices": "/billing/prices",
  "billing.usage": "/billing/usage",
  "billing.ledger": "/billing/ledger",
  "billing.audit": "/billing/audit",
};

test("the eight billing routes are owner-only pages of the billing section", () => {
  for (const [name, pathname] of Object.entries(PATHS)) {
    const route = ROUTES.find((entry) => entry.name === name);
    assert.ok(route, name);
    assert.equal(route.path, pathname);
    assert.equal(route.section, "billing");
    assert.equal(route.ownerOnly, true, name);
    assert.equal(matchRoute(ROUTES, pathname).route.name, name);
  }
  // The classic page is the server's, not a console route.
  assert.equal(matchRoute(ROUTES, "/billing/classic"), null);
});

test("every billing route lands on one of the five tabs", () => {
  assert.deepEqual([...billing.TABS], ["overview", "customers", "prices", "usage", "audit"]);
  assert.deepEqual(Object.keys(PATHS).map((name) => billing.tabOf(name)), ["overview", "customers", "customers", "prices", "prices", "usage", "usage", "audit"]);
  assert.equal(billing.tabOf("unknown"), "overview");
});

test("a legacy ?manager= link picks the manager the forms start with", () => {
  assert.equal(billing.managerFromQuery({ manager: "llama" }), "llama-manager");
  assert.equal(billing.managerFromQuery({ manager: "vllm" }), "vllm-manager");
  assert.equal(billing.managerFromQuery({ manager: "../x" }), "vllm-manager");
  assert.equal(billing.managerFromQuery(undefined), "vllm-manager");
});

test("the billing strings exist in both languages and keep the classic wording", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    for (const key of ["billing.localOnly.title", "billing.localOnly.body", "billing.localOnly.action", "billing.subtitle", "billing.adjust.debitTitle", "billing.redacted"]) {
      assert.ok(catalogs[locale][key], `${locale} ${key}`);
    }
    for (const tab of billing.TABS) assert.ok(catalogs[locale][`billing.tab.${tab}`], `${locale} billing.tab.${tab}`);
  }
  assert.equal(catalogs["zh-CN"]["billing.localOnly.title"], "计费管理仅限本机");
  assert.equal(catalogs["zh-CN"]["billing.adjust.debitTitle"], "不可逆的扣款记录");
  assert.equal(catalogs["en-US"]["billing.adjust.debitTitle"], "Irreversible debit record");
  assert.deepEqual(["overview", "customers", "prices", "usage", "audit"].map((tab) => catalogs["zh-CN"][`billing.tab.${tab}`]), ["总览", "客户与凭证", "套餐与价格", "用量与账本", "操作审计"]);
});
