// CON-31 (07 §6.2, 02 R-UI-5 and R-UI-7): the rules behind the qualification
// block and Save as recipe, run in Node: which job the checklist follows, its
// rows while the job runs and from the stored host record, the Save gate, the
// recipe form and the mapping of the entry's field errors. Drawing and the
// requests are covered in a browser by tests/frontend/console/console-deployments.spec.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);
const model = await load("lib/qualify-model.js");
const { isUnavailable } = await load("routes/deployment-detail/qualify.js");

const FLEET = "vllm:primary";
const job = (patch = {}) => ({
  id: "job_q1", type: "model-qualify", status: "running", createdAt: "2026-10-16T10:00:00Z",
  meta: { fleetId: FLEET, checks: ["models", "chat", "tool-call", "throughput"] },
  logs: ["Qualifying vllm:primary (models, chat, tool-call, throughput)."],
  progress: { percent: 0, stage: "验证 / Qualify: models", detail: "running", state: "running" },
  ...patch,
});
const record = (patch = {}) => ({
  id: "qr_1", launchId: "lch_aaaaaaaaaaaaaaaaaaaa", fleetId: FLEET, at: "2026-10-16T10:01:00Z", durationMs: 61000,
  results: [
    { check: "models", status: "pass", detail: { zh: "服务名一致", en: "Served name matches" } },
    { check: "chat", status: "pass", detail: { zh: "收到 pong", en: "Got pong" } },
    { check: "tool-call", status: "warn", detail: { zh: "参数多余", en: "Extra argument" } },
  ],
  ...patch,
});

test("the checklist follows the job it started, else the newest running qualification of the fleetId", () => {
  const other = job({ id: "job_x", meta: { fleetId: "llama:main", checks: [] } });
  const older = job({ id: "job_old", createdAt: "2026-10-16T09:00:00Z" });
  const done = job({ id: "job_done", status: "success", createdAt: "2026-10-16T11:00:00Z" });
  const launch = { id: "job_l", type: "serve", status: "running", meta: { fleetId: FLEET } };
  const jobs = { jobs: [other, older, done, launch, job()] };
  assert.equal(model.followedJob(jobs, { jobId: "job_done", fleetId: FLEET }).id, "job_done");
  assert.equal(model.followedJob(jobs, { jobId: "job_missing", fleetId: FLEET }), null);
  assert.equal(model.followedJob(jobs, { fleetId: FLEET }).id, "job_q1");
  assert.equal(model.followedJob({ jobs: [done, other] }, { fleetId: FLEET }), null);
  assert.deepEqual(model.qualifyJobsOf(jobs, FLEET).map((item) => item.id), ["job_done", "job_q1", "job_old"]);
});

test("while the job runs, rows come from the planned checks, the log lines and the progress", () => {
  const running = job({
    logs: ["Qualifying vllm:primary (models, chat, tool-call, throughput).", "models: pass", "chat: pass"],
    progress: { percent: 50, stage: "验证 / Qualify: tool-call", detail: "running", state: "running" },
  });
  const rows = model.checkRows({ job: running });
  assert.deepEqual(rows.map((row) => [row.id, row.status]), [["models", "pass"], ["chat", "pass"], ["tool-call", "running"], ["throughput", "pending"]]);
  assert.equal(model.jobProgress(running).percent, 50);
  // A line the 8-line tail no longer carries still reads as done once a later check runs.
  const trimmed = job({ logs: ["chat: pass"], progress: { percent: 60, stage: "验证 / Qualify: tool-call", detail: "running" } });
  assert.deepEqual(model.checkRows({ job: trimmed }).map((row) => row.status), ["done", "pass", "running", "pending"]);
  // The progress detail of a settled check counts too.
  const settled = job({ logs: [], progress: { stage: "验证 / Qualify: models", detail: "fail" } });
  assert.equal(model.checkRows({ job: settled })[0].status, "fail");
  assert.deepEqual(model.checkRows({ job: null }), []);
});

test("a stored host record wins and carries each check's status and bilingual detail", () => {
  const rows = model.checkRows({ job: job({ status: "success" }), record: record() });
  assert.deepEqual(rows.map((row) => [row.id, row.status]), [["models", "pass"], ["chat", "pass"], ["tool-call", "warn"]]);
  assert.deepEqual(rows[1].detail, { zh: "收到 pong", en: "Got pong" });
  assert.deepEqual(model.summarize(rows), { pass: 2, warn: 1, fail: 0, skip: 0 });
  const odd = model.checkRows({ record: record({ results: [{ check: "chat", status: "weird" }, null] }) });
  assert.deepEqual(odd.map((row) => row.status), ["done"]);
});

test("Save as recipe needs a passing chat check on this deployment's launch", () => {
  const scope = { launchId: "lch_aaaaaaaaaaaaaaaaaaaa", fleetId: FLEET };
  assert.equal(model.canSaveRecipe([record()], scope), true);
  assert.equal(model.canSaveRecipe([], scope), false);
  assert.equal(model.canSaveRecipe([record({ results: [{ check: "chat", status: "fail" }] })], scope), false);
  assert.equal(model.canSaveRecipe([record({ results: [{ check: "models", status: "pass" }] })], scope), false);
  // A pass of another launch does not count; without a launch id the fleetId decides.
  assert.equal(model.canSaveRecipe([record({ launchId: "lch_bbbbbbbbbbbbbbbbbbbb" })], scope), false);
  assert.equal(model.canSaveRecipe([record()], { launchId: "", fleetId: FLEET }), true);
  assert.deepEqual(model.recordsFor([record({ id: "a", at: "2026-10-16T08:00:00Z" }), record({ id: "b" })], { launchId: "lch_aaaaaaaaaaaaaaaaaaaa" }).map((item) => item.id), ["b", "a"]);
});

test("the recipe form suggests a valid id, checks its fields and builds the exact request body", () => {
  assert.equal(model.suggestRecipeId("D:/models/Qwen3.8-32B-Instruct"), "qwen3-8-32b-instruct-verified");
  assert.equal(model.suggestRecipeId("123"), "verified");
  assert.equal(model.suggestRecipeId(""), "verified");
  assert.match(model.suggestRecipeId("x".repeat(200)), model.RECIPE_ID_RE);
  assert.ok(model.suggestRecipeId("x".repeat(200)).length <= 64);
  const draft = model.blankRecipeDraft("qwen3-demo-32b");
  assert.equal(draft.recipeId, "qwen3-demo-32b-verified");
  assert.equal(draft.titleEn, "qwen3-demo-32b");
  assert.deepEqual(Object.keys(model.validateRecipeDraft(draft)), ["title.zh"]);
  assert.deepEqual(Object.keys(model.validateRecipeDraft({ ...draft, recipeId: "Bad Id", titleEn: " ", scope: "all" })).sort(), ["recipeId", "scope", "title.en", "title.zh"]);
  const body = model.saveRecipeBody({ ...draft, titleZh: " 中文 ", locks: ["contextLength"], notes: "  " });
  assert.deepEqual(body, { recipeId: "qwen3-demo-32b-verified", title: { zh: "中文", en: "qwen3-demo-32b" }, scope: "family", locks: ["contextLength"] });
  assert.equal(model.saveRecipeBody({ ...draft, titleZh: "x" }, { overwrite: true }).overwrite, true);
  assert.equal(Object.hasOwn(model.saveRecipeBody({ ...draft, titleZh: "x" }), "overwrite"), false);
});

test("only values from the user, the planner or the model can be locked", () => {
  const values = {
    servedName: { value: "m", source: "user" }, contextLength: { value: 8192, source: "planner" },
    gpuMemory: { value: 0.9, source: "engine-default" }, quant: { value: "fp8", source: "model" }, plain: 3,
  };
  assert.deepEqual(model.lockCandidates(values).map((item) => item.id), ["contextLength", "plain", "quant", "servedName"]);
  assert.equal(model.lockCandidates(values).find((item) => item.id === "contextLength").value, 8192);
  assert.deepEqual(model.lockCandidates(null), []);
});

test("422 field errors land on their inputs; paths of the built recipe are listed apart", () => {
  const error = {
    code: "recipe_invalid",
    fieldErrors: [
      { field: "recipeId", code: "invalid", message: "bad id" },
      { field: "title", code: "invalid", message: "needs zh and en text" },
      { field: "match.familyId", code: "required", message: "familyId is missing" },
      { field: null, code: "invalid", message: "" },
    ],
  };
  const mapped = model.mapFieldErrors(error);
  assert.deepEqual(mapped.fields, { recipeId: "bad id", "title.zh": "needs zh and en text" });
  assert.deepEqual(mapped.other, [{ field: "match.familyId", message: "familyId is missing" }, { field: "", message: "invalid" }]);
  assert.deepEqual(model.mapFieldErrors(null), { fields: {}, other: [] });
});

test("recipe_exists tells a bundled recipe (no overwrite) from a user one", () => {
  assert.equal(model.existingRecipeSource({ code: "recipe_exists", details: { details: { source: "bundled" } } }), "bundled");
  assert.equal(model.existingRecipeSource({ code: "recipe_exists", details: { source: "user" } }), "user");
  assert.equal(model.existingRecipeSource({ code: "recipe_exists" }), "user");
  assert.equal(model.existingRecipeSource({ code: "not_qualified" }), "");
});

test("the saved recipe links to the engine's Recipes tab; the model reference comes from the launch", () => {
  assert.equal(model.recipeHref("vllm", "qwen3-demo-verified"), "/engines/vllm?tab=recipes&recipe=qwen3-demo-verified");
  assert.equal(model.recipeHref("a b", ""), "/engines/a%20b?tab=recipes");
  assert.deepEqual(model.modelRefOf({ spec: { model: { ref: "<MODEL_DIR>/m" } } }), { kind: "local", path: "<MODEL_DIR>/m" });
  assert.equal(model.modelRefOf({ spec: {} }), null);
});

test("without MOD-16 (404 or endpoint_unavailable) the block is unavailable; other errors are not", () => {
  assert.equal(isUnavailable({ code: "endpoint_unavailable", status: 404 }), true);
  assert.equal(isUnavailable({ code: "bad_response", status: 404 }), true);
  assert.equal(isUnavailable({ code: "card_not_found", status: 404 }), false);
  assert.equal(isUnavailable({ code: "manager_unreachable", status: 503 }), false);
  assert.equal(isUnavailable(null), false);
});

test("the checklist and form follow the module rules and every check id has a catalog entry in both languages", () => {
  for (const locale of ["en-US", "zh-CN"]) {
    const catalog = JSON.parse(fs.readFileSync(path.join(CONSOLE_DIR, "i18n", "models", `${locale}.json`), "utf8"));
    for (const id of model.CHECK_IDS) assert.ok(catalog[`models.qualify.check.${id}`], `${locale} models.qualify.check.${id}`);
    for (const status of ["pending", "running", "done", ...model.SETTLED]) assert.ok(catalog[`models.qualify.status.${status}`], `${locale} status ${status}`);
    for (const scope of model.RECIPE_SCOPES) assert.ok(catalog[`models.recipe.scope.${scope}`] && catalog[`models.recipe.scope.${scope}.hint`], `${locale} scope ${scope}`);
    assert.ok(catalog["models.recipe.warning.recipe_reload_failed"]);
  }
  const source = fs.readFileSync(path.join(CONSOLE_DIR, "components", "qualify-checklist.js"), "utf8");
  assert.match(source, /data-testid|testid/);
  assert.equal(/\sstyle="/.test(source), false);
});
