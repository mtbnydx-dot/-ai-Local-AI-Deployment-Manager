// CON-20 (07 §6.10, 05 §13.4): the pure part of the Access pages, in Node.
// Rendering, the one-time ShareCard, confirmations, CSRF on writes and the
// English/390 px checks are covered in a browser by
// tests/frontend/console/console-access.spec.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { CLIENT_GUIDES } from "../../console/data/client-guides.js";
import {
  attentionCounts,
  blankDraft,
  bulkRevokePhrase,
  buildBaseUrls,
  customerRows,
  dateInput,
  dateInputToIso,
  displayStatus,
  draftFromKey,
  draftFromPreset,
  draftToCreateBody,
  draftToPatch,
  fieldErrorMap,
  fillGuide,
  inviteText,
  keyAttention,
  keyListQuery,
  legacyClients,
  legacyManagers,
  legacyShare,
  limitsSummary,
  matchedModels,
  modelNames,
  portalLink,
  revocable,
  splitList,
  tokensByKey,
  validateDraft,
} from "../../console/lib/access-model.js";
import { createFormatters } from "../../console/lib/format.js";
import { createI18n } from "../../console/lib/i18n.js";

const HAN = /\p{Script=Han}/u;
const read = (locale) => JSON.parse(fs.readFileSync(new URL(`../../console/i18n/access/${locale}.json`, import.meta.url), "utf8"));
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`../../../tests/fixtures/console/${name}.json`, import.meta.url), "utf8"));
const i18nFor = (locale) => createI18n({ locale, catalog: read(locale) });
const NOW = Date.parse("2026-10-14T08:00:00Z");
const DAY = 86_400_000;

test("splitList splits on lines, commas and spaces, drops blanks and repeats", () => {
  assert.deepEqual(splitList("a, b\nc  a\n\n"), ["a", "b", "c"]);
  assert.deepEqual(splitList(""), []);
  assert.deepEqual(splitList(null), []);
});

test("dates: a date input maps to the end of that local day and back", () => {
  const iso = dateInputToIso("2027-03-05");
  assert.equal(dateInput(Date.parse(iso)), "2027-03-05");
  assert.equal(new Date(iso).getHours(), 23);
  assert.equal(dateInputToIso(""), null);
  assert.equal(dateInputToIso("2027-02-31"), null, "an impossible date is not a date");
  assert.equal(dateInputToIso("tomorrow"), null);
});

test("a preset fills the draft: class, scopes, limits and an expiry from today", () => {
  const preset = { id: "trial-7d", class: "trial", scopes: ["models.read", "self.read", "chat", "messages"], models: ["*"], listeners: ["public"], limits: { rpm: 10, tpm: 50000, maxConcurrent: 1 }, expiresInDays: 7, requiresCustomer: false };
  const draft = draftFromPreset(preset, { now: NOW, previous: { name: "Bob", holder: "B", notes: "n", customerId: "" } });
  assert.equal(draft.preset, "trial-7d");
  assert.equal(draft.class, "trial");
  assert.deepEqual(draft.scopes, preset.scopes);
  assert.equal(draft.limits.rpm, "10");
  assert.equal(draft.limits.dailyTokens, "", "an unset preset limit stays empty (inherits)");
  assert.equal(draft.name, "Bob", "typed identity survives a preset change");
  assert.equal(draft.expires, dateInput(NOW + 7 * DAY));
  const none = draftFromPreset({ ...preset, expiresInDays: null }, { now: NOW });
  assert.equal(none.expires, "");
});

test("validateDraft mirrors the key store bounds and the paid preset's customer rule", () => {
  const draft = { ...blankDraft(), name: "", scopes: [], models: " ", listeners: [] };
  const errors = validateDraft(draft);
  assert.equal(errors.name, "required");
  assert.equal(errors.scopes, "required");
  assert.equal(errors.models, "required");
  assert.equal(errors.listeners, "required");
  const ok = { ...blankDraft(), name: "k" };
  assert.deepEqual(validateDraft(ok), {});
  assert.equal(validateDraft({ ...ok, name: "x".repeat(121) }).name, "too_long");
  assert.equal(validateDraft({ ...ok, customerId: "nope" }).customerId, "invalid");
  assert.equal(validateDraft(ok, { presetInfo: { requiresCustomer: true } }).customerId, "required");
  assert.equal(validateDraft({ ...ok, allowedOrigins: "https://app.example.test/path" }).allowedOrigins, "invalid");
  assert.deepEqual(validateDraft({ ...ok, allowedOrigins: "https://app.example.test\n*" }), {});
  assert.equal(validateDraft({ ...ok, allowedIps: "not an ip" }).allowedIps, "invalid");
  assert.deepEqual(validateDraft({ ...ok, allowedIps: "203.0.113.0/24 ::1" }), {});
  assert.equal(validateDraft({ ...ok, expires: "2020-01-01" }, { now: NOW }).expires, "past");
  assert.equal(validateDraft({ ...ok, expires: "2020-01-01" }, { now: NOW, mode: "edit" }).expires, undefined, "an edit may keep an old date");
  assert.equal(validateDraft({ ...ok, limits: { ...ok.limits, maxQueued: "0" } })["limits.maxQueued"], undefined, "0 is allowed for the queue");
  assert.equal(validateDraft({ ...ok, limits: { ...ok.limits, rpm: "1.5" } })["limits.rpm"], "invalid");
});

test("draftToCreateBody sends the preset id, every limit and the typed lists", () => {
  const draft = { ...blankDraft(), preset: "friend", name: " Alice ", holder: "Alice", models: "qwen*\n!qwen-big", allowedOrigins: "https://a.example.test", expires: "2099-01-01", limits: { ...blankDraft().limits, rpm: "30", dailyTokens: "2000000" } };
  const body = draftToCreateBody(draft);
  assert.equal(body.preset, "friend");
  assert.equal(body.name, "Alice");
  assert.deepEqual(body.models, ["qwen*", "!qwen-big"]);
  assert.equal(body.limits.rpm, 30);
  assert.equal(body.limits.dailyTokens, 2000000);
  assert.equal(body.limits.tpm, null, "an empty limit is sent as null so the preset value is cleared");
  assert.deepEqual(body.allowedOrigins, ["https://a.example.test"]);
  assert.equal(typeof body.expiresAt, "string");
  assert.equal("customerId" in body, false);
  assert.equal("notes" in body, false);
  assert.equal(draftToCreateBody({ ...draft, preset: "" }).preset, undefined);
  assert.equal(draftToCreateBody({ ...draft, expires: "" }).expiresAt, null);
});

test("draftToPatch carries only what changed", () => {
  const key = fixture("access-keys").items[0];
  const draft = draftFromKey(key);
  assert.deepEqual(draftToPatch(draft, key), {}, "an untouched draft changes nothing");
  const changed = draftToPatch({ ...draft, name: "Alice phone", limits: { ...draft.limits, rpm: "60", dailyTokens: "" }, scopes: [...draft.scopes, "embeddings"] }, key);
  assert.deepEqual(Object.keys(changed).sort(), ["limits", "name", "scopes"]);
  assert.deepEqual(changed.limits, { rpm: 60, dailyTokens: null });
  const expiry = draftToPatch({ ...draft, expires: "" }, key);
  assert.deepEqual(expiry, { expiresAt: null });
  const order = draftToPatch({ ...draft, scopes: [...draft.scopes].reverse() }, key);
  assert.deepEqual(order, {}, "scope order is not a change");
});

test("fieldErrorMap reads an ApiError's field errors by field name", () => {
  const map = fieldErrorMap({ fieldErrors: [{ field: "limits.rpm", code: "out_of_range", message: "too big" }, { field: "name", code: "required" }, { code: "x" }] });
  assert.equal(map["limits.rpm"].code, "out_of_range");
  assert.equal(map.name.code, "required");
  assert.deepEqual(fieldErrorMap(null), {});
});

test("matchedModels follows the key policy: globs, excludes last, none when empty", () => {
  const names = ["Qwen3.8-Flash", "qwen3.8-dspark", "llama-8b", "gemma-27b"];
  assert.deepEqual(matchedModels(["*"], names), names);
  assert.deepEqual(matchedModels(["qwen*"], names), ["Qwen3.8-Flash", "qwen3.8-dspark"]);
  assert.deepEqual(matchedModels(["*", "!qwen*"], names), ["llama-8b", "gemma-27b"]);
  assert.deepEqual(matchedModels(["llama-8b"], names), ["llama-8b"]);
  assert.deepEqual(matchedModels([], names), []);
  assert.deepEqual(matchedModels(["!qwen*"], names), [], "excludes alone allow nothing");
  assert.deepEqual(matchedModels(["*8b"], names), ["llama-8b"]);
});

test("modelNames reads strings and objects from the fleet payload", () => {
  const names = modelNames({ instances: [{ models: ["b", { id: "a" }, { name: "c" }, null, {}] }, { models: ["b"] }, {}] });
  assert.deepEqual(names, ["a", "b", "c"]);
  assert.deepEqual(modelNames(null), []);
});

test("attention: expired, expiring and unused keys, active ones only", () => {
  const items = fixture("access-keys").items;
  assert.equal(keyAttention(items[0], NOW), null);
  assert.equal(keyAttention(items[1], NOW), "expired");
  assert.equal(keyAttention(items[2], NOW), "unused");
  assert.equal(keyAttention(items[3], NOW), null, "a revoked key needs no attention");
  const soon = { ...items[0], expiresAt: new Date(NOW + 5 * DAY).toISOString() };
  assert.equal(keyAttention(soon, NOW), "expiring");
  const stale = { ...items[0], lastUsedAt: new Date(NOW - 45 * DAY).toISOString() };
  assert.equal(keyAttention(stale, NOW), "unused");
  assert.deepEqual(attentionCounts(items, NOW), { expired: 1, expiring: 0, unused: 1 });
  assert.equal(displayStatus(items[1], NOW), "expired");
  assert.equal(displayStatus(items[0], NOW), "active");
});

test("keyListQuery leaves blank filters out and bulk revoke asks for REVOKE n", () => {
  assert.deepEqual(keyListQuery({ q: "  ", status: "", expiring: false }, { limit: 50 }), { limit: 50 });
  assert.deepEqual(keyListQuery({ q: "al", status: "active", class: "friend", customer: "c1", expiring: true }), { limit: 100, q: "al", status: "active", class: "friend", customer: "c1", expiring: "true" });
  assert.equal(bulkRevokePhrase(3), "REVOKE 3");
  assert.deepEqual(revocable(fixture("access-keys").items).map((key) => key.name), ["Alice laptop", "Bob trial", "Carol app"]);
});

test("tokensByKey sums input and output per key id; customerRows reads every list form", () => {
  const map = tokensByKey({ rows: [{ key: "k1", promptTokens: 10, outputTokens: 5 }, { key: null, promptTokens: 1 }, { key: "k2", promptTokens: 7 }] });
  assert.equal(map.get("k1"), 15);
  assert.equal(map.get("k2"), 7);
  assert.equal(map.size, 2);
  const row = { customerId: "c1", name: "Acme", status: "active", planId: "p", balanceMicrocredits: "5" };
  for (const payload of [[row], { items: [row] }, { customers: [row] }]) assert.equal(customerRows(payload)[0].name, "Acme");
  assert.deepEqual(customerRows({}), []);
});

test("portalLink keeps the key in the fragment, which a server never receives", () => {
  assert.equal(portalLink("https://ai.example.test/", "sk-x"), "https://ai.example.test/me#key=sk-x");
  assert.equal(portalLink("", "sk-x"), "");
  assert.equal(portalLink(null, "sk-x"), "");
});

test("the invite text names the base URLs, key, model, limits, expiry and portal link in both languages", () => {
  const created = fixture("access-key-created");
  for (const locale of ["zh-CN", "en-US"]) {
    const i18n = i18nFor(locale);
    const text = inviteText(i18n, { holder: created.key.holder, share: created.share, secret: created.secret, expiresAt: created.key.expiresAt, limits: created.key.limits, fmt: createFormatters(locale) });
    for (const part of [created.share.openaiBase, created.share.anthropicBase, created.secret, "qwen3.8-flash", "https://ai.example.test/me#key="]) assert.ok(text.includes(part), `${locale} invite has ${part}`);
    assert.ok(text.includes("Frank"), "the holder is greeted by name");
    assert.equal(/\{[a-zA-Z]+\}/.test(text), false, `${locale}: no unfilled placeholder`);
    assert.equal(HAN.test(text), locale === "zh-CN", `${locale}: Han only in the Chinese text`);
  }
  const i18n = i18nFor("en-US");
  const none = inviteText(i18n, { share: { openaiBase: "o", anthropicBase: "a" }, secret: "s", expiresAt: null, limits: {} });
  assert.match(none, /Hi!/);
  assert.match(none, /Expires: never/);
  assert.equal(none.includes("Limits:"), false);
  assert.match(limitsSummary(i18n, { rpm: 30, tpm: null, dailyTokens: 5 }), /30 requests\/min · 5 tokens\/day/);
});

test("base URLs: this machine, the LAN address and the public base URL", () => {
  const gateway = { autoOpenAi: "/gateway/auto/openai/v1", autoClaude: "/gateway/auto/claude" };
  const lan = buildBaseUrls({ where: { protocol: "http:", hostname: "192.0.2.10", port: "5176" }, gateway, publicBase: "https://ai.example.test/" });
  const byId = Object.fromEntries(lan.map((item) => [item.id, item]));
  assert.equal(byId.lan.openai, "http://192.0.2.10:5176/gateway/auto/openai/v1");
  assert.equal(byId.lan.placeholder, false);
  assert.equal(byId.local.openai, "http://localhost:5176/gateway/auto/openai/v1");
  assert.equal(byId.public.openai, "https://ai.example.test/v1");
  assert.equal(byId.public.anthropic, "https://ai.example.test/anthropic");
  const local = buildBaseUrls({ where: { protocol: "http:", hostname: "localhost", port: "5176" }, gateway, publicBase: "" });
  const byLocal = Object.fromEntries(local.map((item) => [item.id, item]));
  assert.equal(byLocal.lan.placeholder, true);
  assert.match(byLocal.lan.openai, /<LAN-IP>:5176/);
  assert.equal(byLocal.public.available, false, "no public URL without a base URL");
  assert.equal(byLocal.local.anthropic, "http://localhost:5176/gateway/auto/claude");
});

test("client guides: the seven apps, placeholders only, a catalog key for every step", () => {
  assert.deepEqual(CLIENT_GUIDES.map((guide) => guide.id), ["openwebui", "claude-code", "opencode", "chatbox", "cherry-studio", "curl", "python"]);
  const zh = read("zh-CN");
  const en = read("en-US");
  const everything = [];
  for (const guide of CLIENT_GUIDES) {
    assert.ok(guide.steps.length >= 1, guide.id);
    for (const step of guide.steps) {
      assert.equal(typeof zh[step], "string", `${step} in zh-CN`);
      assert.equal(typeof en[step], "string", `${step} in en-US`);
    }
    for (const snippet of guide.snippets) {
      assert.equal(typeof en[snippet.label], "string", snippet.label);
      everything.push(snippet.code);
    }
    for (const row of guide.rows) {
      assert.equal(typeof en[row.label], "string", row.label);
      everything.push(row.value);
    }
  }
  const text = everything.join("\n");
  assert.ok(text.includes("{baseUrl}") && text.includes("{anthropicUrl}") && text.includes("{model}"));
  assert.ok(text.includes("$API_KEY"));
  assert.equal(/sk-[A-Za-z0-9]{8,}/.test(text), false, "no real-looking key in a guide");
  const filled = fillGuide(text, { baseUrl: "https://x.test/v1", anthropicUrl: "https://x.test/anthropic", model: "" });
  assert.equal(/\{(baseUrl|anthropicUrl|model)\}/.test(filled), false);
  assert.ok(filled.includes("$API_KEY"), "the key placeholder is never replaced");
  assert.ok(filled.includes("\"model\": \"auto\""), "an empty model falls back to auto");
});

test("the legacy path: per-engine clients, managers and a share block without a portal", () => {
  const payload = {
    ok: true,
    keys: {
      clients: [{ manager: "vllm", managerName: "vLLM", id: "c1", name: "Desk", state: "expired", lastUsedAt: null, allowedModels: ["a"], rateLimitRpm: 12, neverUsed: true }, { nope: true }],
      perManager: [{ manager: "vllm", managerName: "vLLM", online: true }, { manager: "llama", managerName: "llama.cpp", online: false }],
    },
  };
  const rows = legacyClients(payload);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rateLimitRpm, 12);
  assert.equal(rows[0].state, "expired");
  assert.deepEqual(legacyManagers(payload).map((item) => item.id), ["vllm", "llama"]);
  assert.deepEqual(legacyClients({}), []);
  const share = legacyShare({ openai: "https://x.test/v1", anthropic: "https://x.test/claude" }, "sk-legacy-TEST");
  assert.equal(share.portalUrl, null);
  assert.ok(share.snippetCurl.includes("Bearer sk-legacy-TEST"));
  assert.ok(share.snippetCurl.includes("https://x.test/v1/chat/completions"));
});

test("the access catalog has field help in both languages for every limit and field", async () => {
  const { FIELD_COPY, LIMIT_FIELDS, SCOPES } = await import("../../console/lib/access-model.js");
  const zh = read("zh-CN");
  const en = read("en-US");
  const keys = [
    ...Object.values(FIELD_COPY).flatMap((field) => [field.label, field.help]),
    ...LIMIT_FIELDS.flatMap((field) => [field.label, field.help, field.unit]),
    ...SCOPES.flatMap((scope) => [scope.label, scope.hint]),
  ];
  for (const key of keys) {
    assert.ok(zh[key] && en[key], `${key} has help in zh-CN and en-US`);
    assert.equal(HAN.test(en[key]), false, `${key} has no Han in English`);
  }
  assert.match(zh["access.field.rpm.help"], /Retry-After/);
  assert.match(en["access.field.rpm.help"], /Retry-After/);
});
