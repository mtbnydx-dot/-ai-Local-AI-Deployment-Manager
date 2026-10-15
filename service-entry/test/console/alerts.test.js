// CON-19 (07 §6.9, 04 §13.4): the pure parts of the Alerts page, run in Node.
// Rendering, the calls and axe are covered in a browser by
// tests/frontend/console/console-alerts.spec.js.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { mergeI18nAreas } = require("../../lib/console-routes.js");
const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);

const model = await load("lib/alerts-model.js");
const catalogs = mergeI18nAreas(path.join(CONSOLE_DIR, "i18n")).catalogs;
const NOW = Date.parse("2026-10-14T12:00:00Z");

const BUILTIN = { ruleId: "gpu_temp_high", builtin: true, enabled: true, metric: "gpu.temp_c", scope: {}, op: ">", threshold: 85, clearThreshold: null, windowS: 60, forS: 120, minSamples: 0, severity: "warning", channels: ["inapp", "toast"], cooldownS: 1800, titleZh: "甲", titleEn: "A" };
const CUSTOM = { ...BUILTIN, ruleId: "custom_down", builtin: false, metric: "instance.down", scope: { fleetId: "vllm:primary" }, titleEn: "Down" };
const METRICS = [{ id: "instance.down", unit: "bool", filters: ["fleetId"] }, { id: "gpu.temp_c", unit: "celsius", filters: ["gpu"] }];

test("ack and silence bodies always carry the row's scopeKey", () => {
  const row = { ruleId: "gpu_temp_high", scopeKey: "gpu:1" };
  assert.deepEqual(model.ackBody(row), { scopeKey: "gpu:1" });
  assert.deepEqual(model.silenceBody(row, "2026-10-14T13:00:00.000Z"), { scopeKey: "gpu:1", until: "2026-10-14T13:00:00.000Z" });
  assert.deepEqual(model.silenceBody(row, null), { scopeKey: "gpu:1", until: null });
  assert.equal(model.alertPath("a/b", "ack"), "/api/telemetry/alerts/a%2Fb/ack");
});

test("silence times: presets, a custom time, and the two problems", () => {
  assert.equal(model.silenceUntil("1h", "", NOW).until, "2026-10-14T13:00:00.000Z");
  assert.equal(model.silenceUntil("8h", "", NOW).until, "2026-10-14T20:00:00.000Z");
  assert.equal(model.silenceUntil("24h", "", NOW).until, "2026-10-15T12:00:00.000Z");
  assert.deepEqual(model.silenceUntil("custom", "", NOW), { problem: "invalid" });
  assert.deepEqual(model.silenceUntil("custom", "not a time", NOW), { problem: "invalid" });
  assert.deepEqual(model.silenceUntil("custom", "2020-01-01T00:00:00Z", NOW), { problem: "past" });
  assert.equal(model.silenceUntil("custom", "2026-10-14T15:30:00Z", NOW).until, "2026-10-14T15:30:00.000Z");
});

test("firing rows sort critical first, then the oldest, and keep only firing ones", () => {
  const rows = [
    { ruleId: "a", scopeKey: "*", state: "firing", severity: "warning", since: "2026-10-14T10:00:00Z" },
    { ruleId: "b", scopeKey: "*", state: "ok", severity: "critical", since: "2026-10-14T09:00:00Z" },
    { ruleId: "c", scopeKey: "*", state: "firing", severity: "critical", since: "2026-10-14T11:00:00Z" },
    { ruleId: "d", scopeKey: "*", state: "firing", severity: "warning", since: "2026-10-14T09:30:00Z" },
  ];
  assert.deepEqual(model.sortFiring(rows).map((row) => row.ruleId), ["c", "d", "a"]);
  assert.deepEqual(model.sortFiring(null), []);
});

test("a builtin rule sends only editable changed fields; a new rule sends everything", () => {
  const draft = model.ruleDraft(BUILTIN, METRICS);
  assert.deepEqual(model.ruleBody(draft, BUILTIN), { body: {}, local: {}, changed: false });
  draft.threshold = "88";
  draft.titleEn = "changed but locked";
  draft.channels = ["inapp"];
  const result = model.ruleBody(draft, BUILTIN);
  assert.deepEqual(result.body, { threshold: 88, channels: ["inapp"] });
  assert.equal(result.changed, true);
  assert.deepEqual(Object.keys(result.body).filter((key) => !model.BUILTIN_EDITABLE.includes(key)), []);

  const fresh = model.ruleDraft(null, METRICS);
  Object.assign(fresh, { threshold: "1", titleZh: "新", titleEn: "New" });
  const created = model.ruleBody(fresh, null);
  assert.deepEqual(created.body, { enabled: true, severity: "warning", channels: ["inapp"], metric: "instance.down", op: ">", titleZh: "新", titleEn: "New", scope: {}, threshold: 1, windowS: 300, forS: 0, minSamples: 0, cooldownS: 1800, clearThreshold: null });
});

test("a custom rule edit sends changed fields, scope filters parse by kind, and bad numbers stay local", () => {
  const draft = model.ruleDraft(CUSTOM, METRICS);
  draft.scope.fleetId = " llama:small ";
  draft.clearThreshold = "0.5";
  draft.windowS = "x";
  const result = model.ruleBody(draft, CUSTOM);
  assert.deepEqual(result.local, { windowS: "invalid_type" });
  assert.deepEqual(result.body, { clearThreshold: 0.5, scope: { fleetId: "llama:small" } });

  const gpu = model.ruleDraft({ ...BUILTIN, builtin: false, scope: { gpu: 0, errorClasses: ["a", "b"], perFleet: true } }, METRICS);
  assert.deepEqual(gpu.scope, { gpu: "0", errorClasses: "a, b", perFleet: true });
  const again = model.ruleBody({ ...gpu, scope: { gpu: "2", errorClasses: "x, y ,", perFleet: true } }, { ...BUILTIN, builtin: false });
  assert.deepEqual(again.body.scope, { gpu: 2, errorClasses: ["x", "y"], perFleet: true });
  assert.deepEqual(model.scopeFilters(METRICS[0]), ["fleetId"]);
  assert.deepEqual(model.scopeFilters(null), []);
});

test("the writer's errors split into the form's fields and the rest", () => {
  const errors = [{ field: "threshold", code: "out_of_range" }, { field: "scope.gpu", code: "out_of_range" }, { field: "threshold", code: "again" }, { field: "mystery", code: "x" }, { code: "no_field" }];
  const split = model.splitErrors(errors, ["threshold", "scope"]);
  assert.deepEqual(Object.keys(split.byField), ["threshold", "scope.gpu"]);
  assert.equal(split.byField.threshold.code, "out_of_range");
  assert.equal(split.other.length, 2);
  assert.deepEqual(model.splitErrors(null), { byField: {}, other: [] });
});

test("the webhook list keeps masked URLs for the others and adds or replaces one", () => {
  const hooks = [{ id: "a", url: "https://x.test/…1", format: "slack", minSeverity: "warning", secret: { set: true } }, { id: "b", url: "https://y.test/…2", format: "generic", minSeverity: "info", secret: { set: false } }];
  const added = model.webhookBody(hooks, "c", { id: "c", url: "https://z.test/h", format: "feishu", minSeverity: "warning" });
  assert.deepEqual(added.alerts.webhooks.map((hook) => hook.id), ["a", "b", "c"]);
  assert.deepEqual(added.alerts.webhooks[0], { id: "a", url: "https://x.test/…1", format: "slack", minSeverity: "warning" });
  const replaced = model.webhookBody(hooks, "b", { id: "b", url: "https://new.test/h", format: "generic", minSeverity: "critical", secret: "s" });
  assert.deepEqual(replaced.alerts.webhooks[1], { id: "b", url: "https://new.test/h", format: "generic", minSeverity: "critical", secret: "s" });
  assert.match(model.newWebhookId(NOW), /^wh_[a-z0-9]+$/);
});

test("every static and computed key the page builds has copy in both languages", () => {
  const keys = [];
  for (const tab of model.TABS) keys.push(`obs.alert.tab.${tab}`);
  for (const preset of model.SILENCE_PRESETS) keys.push(`obs.alert.silence.${preset.id}`);
  keys.push("obs.alert.silence.custom", "obs.alert.silenceProblem.invalid", "obs.alert.silenceProblem.past");
  for (const channel of model.CHANNELS) keys.push(`obs.alert.channel.${channel}`);
  for (const format of model.WEBHOOK_FORMATS) keys.push(`obs.alert.format.${format}`);
  for (const severity of model.SEVERITIES) keys.push(`obs.severity.${severity}`);
  for (const unit of ["bool", "ratio", "count", "celsius", "seconds"]) keys.push(`obs.alert.unit.${unit}`);
  for (const filter of ["fleetId", "managerId", "root", "collector", "gpu", "perFleet", "errorClasses"]) keys.push(`obs.alert.scope.${filter}`);
  for (const state of ["firing", "pending", "ok", "resolved"]) keys.push(`obs.alert.state.${state}`);
  for (const status of ["available", "no_subscriber"]) keys.push(`obs.alert.toast.${status}`);
  // The validation codes 04 §13.4 returns for a rule or a webhook.
  for (const code of ["invalid_type", "required", "out_of_range", "invalid_value", "invalid_format", "unknown_metric", "unknown_key", "not_editable", "unsafe_url", "duplicate"]) keys.push(`obs.alert.err.${code}`);
  for (const reason of ["redirect_blocked", "timeout", "dns_failed", "network_error", "unsafe_url", "unknown_format", "secret_unavailable", "webhook_not_found", "publish_failed"]) keys.push(`obs.alert.testfail.${reason}`);
  for (const locale of ["zh-CN", "en-US"]) {
    for (const key of keys) assert.ok(typeof catalogs[locale][key] === "string" && catalogs[locale][key].trim(), `${key} missing in ${locale}`);
  }
});
