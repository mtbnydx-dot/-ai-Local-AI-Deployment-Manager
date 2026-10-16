// 07 §13.4 cross-spec check for CON-20: what the 05 access routes really
// produce (their presets and the invite block of a created key) passes the
// console guards, and the console's form model turns each real preset into a
// body the real key policy would accept. The fixtures under
// tests/fixtures/console/access-*.json were generated from the same module.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { blankDraft, draftFromPreset, draftToCreateBody, validateDraft } from "../../console/lib/access-model.js";
import { check } from "../../console/lib/guards.js";
import * as schemas from "../../console/lib/schemas.js";

const require = createRequire(import.meta.url);
const routes = require("../../lib/access-routes.js");
const policy = require("../../lib/key-policy.js");

const view = (preset) => ({
  id: preset.id, class: preset.class, scopes: [...preset.scopes], models: [...preset.models], listeners: [...preset.listeners], limits: { ...preset.limits },
  expiresInDays: preset.expiresInDays, requiresCustomer: preset.requiresCustomer, labelKey: preset.labelKey, descriptionKey: preset.descriptionKey,
});

test("every real preset passes PresetGuard and its catalog keys exist in both locales", async () => {
  const fs = await import("node:fs");
  const zh = JSON.parse(fs.readFileSync(new URL("../../console/i18n/access/zh-CN.json", import.meta.url), "utf8"));
  const en = JSON.parse(fs.readFileSync(new URL("../../console/i18n/access/en-US.json", import.meta.url), "utf8"));
  assert.ok(routes.PRESETS.length >= 5);
  for (const preset of routes.PRESETS) {
    const result = check(schemas.PresetGuard, view(preset));
    assert.deepEqual(result.errors, [], preset.id);
    for (const key of [preset.labelKey, preset.descriptionKey]) {
      assert.equal(typeof zh[key], "string", `${key} in zh-CN`);
      assert.equal(typeof en[key], "string", `${key} in en-US`);
    }
  }
});

test("the console's scope list is the key policy's scope list", async () => {
  const { SCOPES } = await import("../../console/lib/access-model.js");
  assert.deepEqual([...SCOPES.map((scope) => scope.id)].sort(), [...policy.SCOPES].sort());
  assert.deepEqual([...SCOPES.filter((scope) => scope.adminOnly).map((scope) => scope.id)].sort(), [...policy.ADMIN_ONLY_SCOPES].sort());
});

test("a draft from each real preset becomes a body the server applies as that preset (same scopes, limits and class)", () => {
  const now = Date.parse("2026-10-14T08:00:00Z");
  for (const preset of routes.PRESETS) {
    const draft = { ...draftFromPreset(view(preset), { now }), name: `${preset.id} key`, customerId: preset.requiresCustomer ? "3f0c2b1e-8a47-4d6e-9b1a-5c2d7e9f0a11" : "" };
    assert.deepEqual(validateDraft(draft, { presetInfo: view(preset), now }), {}, preset.id);
    const body = draftToCreateBody(draft);
    const applied = routes.applyPreset({ preset: preset.id, name: body.name, ...(body.customerId ? { customerId: body.customerId } : {}) }, () => now);
    assert.equal(body.preset, preset.id);
    assert.equal(body.class, applied.input.class);
    assert.deepEqual([...body.scopes].sort(), [...applied.input.scopes].sort(), `${preset.id} scopes`);
    assert.deepEqual([...body.listeners].sort(), [...applied.input.listeners].sort());
    for (const [name, value] of Object.entries(preset.limits)) assert.equal(body.limits[name], value, `${preset.id} limits.${name}`);
    const expected = preset.expiresInDays ? applied.input.expiresAt.slice(0, 10) : null;
    if (expected) assert.equal(new Date(body.expiresAt).getTime() > now, true);
    else assert.equal(body.expiresAt, null);
  }
});

test("a custom draft keeps the key policy's own bounds", () => {
  const draft = { ...blankDraft(), name: "x", limits: { ...blankDraft().limits, rpm: "0", tpm: "abc", maxConcurrent: "1025", dailyTokens: "0" } };
  const errors = validateDraft(draft);
  assert.equal(errors["limits.rpm"], "out_of_range");
  assert.equal(errors["limits.tpm"], "invalid");
  assert.equal(errors["limits.maxConcurrent"], "out_of_range");
  assert.equal(errors["limits.dailyTokens"], undefined, "0 is a valid daily cap");
});

test("the real share block passes the created-key guard", () => {
  const share = routes.buildShare({ config: { publicOrigin: "https://ai.example.test" }, secret: ("sk-" + "plat-TESTONLYFAKEKEY"), recommendedModel: null });
  const result = check(schemas.KeyCreatedGuard, { ok: true, key: { id: "k_x", name: "n", status: "active" }, secret: ("sk-" + "plat-TESTONLYFAKEKEY"), share });
  assert.deepEqual(result.errors, []);
});
