// CON-12 (07 §6.3 steps 4 to 7, 02 R-UI-6): the rules behind the wizard's
// Capabilities, Access, Review and Launch steps, run in Node: when Launch is
// blocked, what the image step says, the redacted command, the diffs (overrides
// with reasons, the last launch, a changed plan), the launch phases of a job,
// the failure object and its signature lookup, and the quick path of
// start-last-used. Drawing and interaction are covered in a browser by
// tests/frontend/console/console-wizard.spec.js (part 3).

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);
const model = await load("lib/launch-model.js");
const caps = await load("lib/capabilities-model.js");
const quick = await load("routes/deploy-wizard/quick-paths.js");
const wizard = await load("lib/wizard-state.js");

const CATALOG = {
  engineId: "vllm",
  params: [
    { id: "contextLength", label: { zh: "上下文长度", en: "Context length" } },
    { id: "concurrency", label: { zh: "并发", en: "Concurrency" } },
    { id: "servedName", label: { zh: "对外名称", en: "Served name" }, legacy: { field: "name", aliases: [], codec: "direct" } },
  ],
};

const PLAN = {
  ok: true,
  planHash: "sha256:aaaa",
  prospective: false,
  values: { contextLength: { value: 131072, source: "user" }, concurrency: { value: 1, source: "recipe", reason: "有效并发受 Mamba cache 限制 / Effective concurrency is limited by the Mamba cache" } },
  overrides: [{ param: "concurrency", from: 4, to: 1, source: "recipe", reason: "有效并发受 Mamba cache 限制 / Effective concurrency is limited by the Mamba cache" }],
  errors: [],
  blockers: [],
  warnings: [],
  steps: [{ kind: "pull", image: "example/vllm:1", required: false, policy: "auto" }, { kind: "replace", containerName: "vllm-local", model: "m-1" }],
  admission: { verdict: "ok", message: "" },
};

// ---- the gate ---------------------------------------------------------------------------------

test("Launch is allowed only for an ok plan with no errors, blockers or block verdict", () => {
  assert.deepEqual(model.launchGate(PLAN), { allowed: true, reasons: [] });
  assert.equal(model.launchGate(null).allowed, false);
  assert.deepEqual(model.launchGate(null).reasons, [{ kind: "no-plan" }]);
  assert.deepEqual(model.launchGate({ ...PLAN, errors: [{ code: "x" }] }).reasons, [{ kind: "errors", count: 1 }]);
  assert.deepEqual(model.launchGate({ ...PLAN, blockers: [{ code: "a" }, { code: "b" }] }).reasons, [{ kind: "blockers", count: 2 }]);
  assert.deepEqual(model.launchGate({ ...PLAN, admission: { verdict: "block" } }).reasons, [{ kind: "admission" }]);
  assert.deepEqual(model.launchGate({ ...PLAN, admission: { verdict: "warn" } }).reasons, [], "a warning does not stop a launch");
  assert.deepEqual(model.launchGate({ ...PLAN, prospective: true }).reasons, [{ kind: "prospective" }]);
  assert.deepEqual(model.launchGate({ ...PLAN, ok: false }).reasons, [{ kind: "not-ok" }]);
  assert.deepEqual(model.launchGate(PLAN, { updating: true }).reasons, [{ kind: "updating" }]);
  assert.deepEqual(model.launchGate(PLAN, { running: true }).reasons, [{ kind: "running" }]);
  const all = model.launchGate({ ...PLAN, ok: false, errors: [1], blockers: [1], admission: { verdict: "block" } }, { updating: true });
  assert.deepEqual(all.reasons.map((reason) => reason.kind), ["errors", "blockers", "admission", "updating"]);
});

test("the replace step names the model a launch would replace; parallel mode and an empty slot name nothing", () => {
  assert.deepEqual(model.replaceTargetOf(PLAN, { instance: { mode: "replace" } }), { instance: "vllm-local", model: "m-1" });
  const rows = [{ instanceId: "primary", model: "qwen" }];
  const bare = { ...PLAN, steps: [] };
  assert.deepEqual(model.replaceTargetOf(bare, { instance: { mode: "replace", targetInstanceId: "primary" } }, rows), { instance: "primary", model: "qwen" });
  assert.equal(model.replaceTargetOf(bare, { instance: { mode: "replace", targetInstanceId: "gone" } }, rows), null);
  assert.equal(model.replaceTargetOf(bare, { instance: { mode: "parallel", targetInstanceId: "primary" } }, rows), null);
});

// ---- the image step ---------------------------------------------------------------------------

test("the image step is present, auto, explicit (the image_pull_required blocker) or a missing local build", () => {
  const pull = (patch) => ({ ...PLAN, blockers: [], steps: [{ kind: "pull", image: "example/img:1", runtimeId: "vllm@1", required: true, policy: "auto", ...patch }] });
  assert.equal(model.imageStepOf({ steps: [] }).state, "none");
  assert.equal(model.imageStepOf(pull({ required: false })).state, "present");
  assert.equal(model.imageStepOf(pull({})).state, "auto");
  const explicit = model.imageStepOf({ ...pull({ policy: "explicit" }), blockers: [{ code: "image_pull_required" }] });
  assert.equal(explicit.state, "explicit");
  assert.equal(explicit.image, "example/img:1");
  assert.equal(explicit.runtimeId, "vllm@1");
  assert.equal(model.imageStepOf(pull({ policy: "explicit" })).state, "explicit", "an explicit required pull is explicit even before the blocker arrives");
  assert.equal(model.imageStepOf({ ...pull({}), blockers: [{ code: "runtime_local_build_missing" }] }).state, "local-build");
});

// ---- the command ------------------------------------------------------------------------------

test("the command view keeps <redacted>, marks custom extra args and hides anything that still looks like a secret", () => {
  const view = model.commandView({
    argv: ["docker", "run", "-e", "VLLM_API_KEY=<redacted>", "-e", "HF_TOKEN=hf_fake_token_value", "--api-key", "fake-key-value", "--schedule-policy", "lpm", "img", "--served-model-name=m"],
    env: { VLLM_API_KEY: "<redacted>", SOME_API_KEY: "fake-key-value", MODE: "fast" },
    labels: { "ai.manager.recipe": "r" },
  }, { extraArgs: ["--schedule-policy", "lpm"] });
  const text = view.lines.map((line) => line.text);
  assert.deepEqual(text.slice(0, 4), ["docker", "run", "-e", "VLLM_API_KEY=<redacted>"]);
  assert.ok(text.includes("HF_TOKEN=<redacted>"), "a secret env pair is redacted a second time");
  assert.ok(!text.join(" ").includes("fake-key-value") && !text.join(" ").includes("hf_fake_token_value"));
  assert.equal(text[text.indexOf("--api-key") + 1], "<redacted>", "the value after a secret flag is hidden");
  assert.deepEqual(view.lines.filter((line) => line.custom).map((line) => line.text), ["--schedule-policy", "lpm"]);
  assert.equal(view.lines.find((line) => line.text === "VLLM_API_KEY=<redacted>").redacted, true);
  assert.deepEqual(view.env.map((row) => [row.name, row.value, row.redacted]), [["VLLM_API_KEY", "<redacted>", true], ["SOME_API_KEY", "<redacted>", true], ["MODE", "fast", false]]);
  assert.equal(view.labels[0].name, "ai.manager.recipe");
  assert.equal(model.commandView(null).empty, true);
  assert.equal(model.redactToken("--port"), "--port");
  assert.equal(model.redactToken("--token=abc"), "--token=<redacted>");
});

// ---- overrides and diffs ----------------------------------------------------------------------

test("overrides become DiffTable rows with their reason in the page language; an override that changes nothing is dropped", () => {
  const en = model.overrideRows(PLAN, CATALOG, "en-US");
  assert.deepEqual(en, [{ id: "concurrency", label: "Concurrency", from: "4", to: "1", source: "recipe", reason: "Effective concurrency is limited by the Mamba cache" }]);
  const zh = model.overrideRows(PLAN, CATALOG, "zh-CN");
  assert.equal(zh[0].label, "并发");
  assert.equal(zh[0].reason, "有效并发受 Mamba cache 限制");
  const object = model.overrideRows({ overrides: [{ param: "x", from: 1, to: 2, reason: { zh: "因为", en: "because" } }, { param: "same", from: 3, to: 3 }] }, CATALOG, "en-US");
  assert.deepEqual(object.map((row) => [row.id, row.label, row.reason]), [["x", "x", "because"]]);
  assert.equal(model.localizedText("plain text", "en-US"), "plain text");
  assert.equal(model.localizedText("中文 / English text", "zh-CN"), "中文");
});

test("a plan that changed shows its value differences; the last launch compares effective values", () => {
  const after = { ...PLAN, values: { ...PLAN.values, contextLength: { value: 65536, source: "recipe" } } };
  assert.deepEqual(model.planChangeRows(PLAN, after, CATALOG, "en-US").map((row) => [row.id, row.label, row.from, row.to]), [["contextLength", "Context length", "131072", "65536"]]);
  assert.deepEqual(model.planChangeRows(PLAN, PLAN, CATALOG), []);

  const records = [
    { launchId: "lch_old", status: "failed", spec: { model: { ref: "/m/a" } }, resolved: { values: { contextLength: { value: 1, source: "user" } } } },
    { launchId: "lch_new", status: "running", spec: { model: { ref: "/m/a" } }, resolved: { values: { contextLength: { value: 262144, source: "user" }, concurrency: { value: 1, source: "recipe" } } } },
    { launchId: "lch_other", status: "running", spec: { model: { ref: "/m/b" } } },
  ];
  const last = model.lastLaunchOf(records, "/m/a");
  assert.equal(last.launchId, "lch_new", "the first working launch of the model, in served order");
  assert.equal(model.lastLaunchOf(records, "/m/none"), null);
  assert.equal(model.lastLaunchOf([{ spec: { model: { ref: "/m/a" } }, status: "failed" }], "/m/a"), null);
  assert.deepEqual(model.lastLaunchRows(last, PLAN, CATALOG, "en-US").map((row) => [row.id, row.from, row.to]), [["contextLength", "262144", "131072"]]);
  assert.deepEqual(model.lastLaunchRows(null, PLAN, CATALOG), []);

  const rows = model.suggestionRows({ values: {} }, PLAN, { param: "contextLength", value: 65536 }, CATALOG, "en-US");
  assert.deepEqual(rows.map((row) => [row.id, row.from, row.to]), [["contextLength", "131072", "65536"]], "from the effective value, not the empty draft");
});

// ---- the start request and its answer ---------------------------------------------------------

test("a start answer carries the job, and a plan hash other than the reviewed one is flagged (the pre-ENG-2 notice)", () => {
  const same = model.startOutcome({ job: { id: "job_1" }, launchId: "lch_1", plan: { planHash: "sha256:aaaa", overrides: [{ param: "x" }] } }, "sha256:aaaa");
  assert.deepEqual([same.jobId, same.launchId, same.changedAtLaunch, same.overrides.length], ["job_1", "lch_1", false, 1]);
  assert.equal(model.startOutcome({ job: { id: "j" }, plan: { planHash: "sha256:bbbb" } }, "sha256:aaaa").changedAtLaunch, true);
  assert.equal(model.startOutcome({ job: { id: "j" }, plan: { planHash: "sha256:bbbb" } }, "").changedAtLaunch, false, "nothing was reviewed against");
  assert.equal(model.startOutcome({ jobId: "job_2" }).jobId, "job_2");
  assert.equal(model.startOutcome({}).jobId, "");
  assert.equal(model.planChangedOf({ code: "plan_changed", details: { plan: PLAN } }), PLAN);
  assert.deepEqual(model.planChangedOf({ code: "plan_changed" }), {});
  assert.equal(model.planChangedOf({ code: "other" }), null);
});

test("the launch request carries expectedPlanHash and nothing secret", () => {
  const draft = wizard.createDraft({
    modelRef: { kind: "local", entryId: null, path: "/m/a" }, engineId: "vllm", managerId: "vllm",
    values: { contextLength: 65536, apiKey: "fake-typed-key" }, extraEnv: { FOO: "bar" },
  });
  const body = wizard.launchRequest(draft, PLAN, { catalog: { params: [{ id: "apiKey", secret: true }] } });
  assert.equal(body.expectedPlanHash, "sha256:aaaa");
  assert.equal(body.model.ref, "/m/a");
  assert.equal(body.values.apiKey, undefined, "a secret param travels as its own request field, never in values");
  assert.equal(wizard.launchRequest(draft, { ...PLAN, planHash: undefined }).expectedPlanHash, undefined, "a manager before ENG-2 has no hash to send");
});

// ---- the job ------------------------------------------------------------------------------------

test("a running job marks the phases before the current one done, the current active and the rest pending", () => {
  const job = { status: "running", lifecycle: { phase: "weights", phaseHistory: [
    { phase: "pull", at: "2026-10-01T00:00:00Z", durationMs: 2000 }, { phase: "admission", at: "x", durationMs: 100 },
    { phase: "container", at: "x", durationMs: 900 }, { phase: "weights", at: "x", durationMs: null },
  ] } };
  const phases = model.jobPhases(job, { pullStep: { required: true } });
  assert.deepEqual(phases.map((phase) => phase.id), [...model.LAUNCH_PHASES]);
  assert.deepEqual(phases.map((phase) => phase.state), ["done", "done", "done", "active", "pending", "pending", "pending", "pending", "pending"]);
  assert.deepEqual(phases.map((phase) => phase.durationMs).slice(0, 4), [2000, 100, 900, null]);
});

test("pull is skipped when the image was present, active when it is being pulled, and the failed phase is an error", () => {
  const job = { status: "running", progress: { phase: "admission" }, lifecycle: { phase: "admission", phaseHistory: [{ phase: "admission", at: "x", durationMs: null }] } };
  assert.equal(model.jobPhases(job, { pullStep: { required: false } })[0].state, "skipped");
  assert.equal(model.jobPhases(job, { pullStep: { required: true } })[0].state, "done");
  const pulling = { status: "running", lifecycle: { phase: "pull", phaseHistory: [{ phase: "pull", at: "x", durationMs: null }] } };
  assert.equal(model.jobPhases(pulling, { pullStep: { required: true } })[0].state, "active");
  assert.equal(model.jobPhases(pulling, { pullStep: { required: false } })[0].state, "active", "a phase that ran is never shown as skipped");
  const failed = { status: "failed", lifecycle: { phase: "kv", phaseHistory: [] }, failure: { code: "kv_too_small", phase: "kv" } };
  assert.deepEqual(model.jobPhases(failed).map((phase) => phase.state), ["done", "done", "done", "done", "error", "pending", "pending", "pending", "pending"]);
  const done = model.jobPhases({ status: "success", lifecycle: { phase: "ready" } }, { pullStep: { required: false } });
  assert.deepEqual(done.map((phase) => phase.state), ["skipped", "done", "done", "done", "done", "done", "done", "done", "done"], "success is done everywhere; pull was skipped");
  assert.equal(model.jobPhases({ status: "success", lifecycle: { phase: "ready" } }, { pullStep: { required: true } })[0].state, "done");
  assert.equal(model.jobPhases({ status: "running" })[0].state, "active", "before any progress the first phase is the active one");
  assert.equal(model.jobState({ status: "interrupted" }), "failed");
  assert.equal(model.jobState({ status: "success" }), "success");
  assert.equal(model.jobState({ status: "paused" }), "running");
});

test("the live detail line names a phase for a known stageKey and shows the server text for an unknown one", () => {
  assert.deepEqual(model.stageDetail({ progress: { stageKey: "weights", stageText: { zh: "a", en: "b" } } }), { phaseKey: "weights", text: null });
  assert.deepEqual(model.stageDetail({ progress: { stageKey: "waitReady", stageText: { zh: "等待", en: "Waiting" } } }), { phaseKey: null, text: { zh: "等待", en: "Waiting" } });
  assert.deepEqual(model.stageDetail({ progress: { stage: "legacy text" } }), { phaseKey: null, text: "legacy text" });
  assert.deepEqual(model.stageDetail({}), { phaseKey: null, text: null });
});

// ---- the failure card -------------------------------------------------------------------------

const SIGNATURE = {
  id: "cuda-oom", code: "cuda_oom", phase: "kv",
  title: { zh: "显存不足 {1}", en: "Out of memory {1}" },
  hint: { zh: "降低上下文", en: "Lower the context" },
  suggestions: [{ kind: "param", param: "contextLength", to: "planner" }, { kind: "probe" }, { kind: "runtime", action: "newer-image" }, { kind: "weird" }, { kind: "param" }],
};

test("a failed job yields the 00 §9.11 error; a legacy job yields a minimal one; a job that did not fail yields none", () => {
  const failure = model.jobFailure({ status: "failed", error: "start failed", failure: { code: "cuda_oom", signatureId: "cuda-oom", phase: "kv", hint: { zh: "a", en: "b" }, logExcerpt: "CUDA out of memory", suggestions: [{ kind: "probe" }] } });
  assert.deepEqual([failure.code, failure.signatureId, failure.phase, failure.logExcerpt], ["cuda_oom", "cuda-oom", "kv", "CUDA out of memory"]);
  assert.deepEqual(failure.suggestions, [{ kind: "probe" }]);
  const legacy = model.jobFailure({ status: "failed", error: "container exited", lifecycle: { phase: "weights" }, meta: { errorCode: "container_exited" } });
  assert.deepEqual([legacy.code, legacy.signatureId, legacy.phase, legacy.message], ["container_exited", null, "weights", "container exited"]);
  assert.equal(model.jobFailure({ status: "running" }), null);
  assert.equal(model.jobFailure(null), null);
});

test("title and suggestions come from the error when present, else from the looked-up signature (R-UI-6)", () => {
  const bare = { code: "cuda_oom", signatureId: "cuda-oom", phase: "kv", hint: { zh: "错误里的提示", en: "hint from the error" }, logExcerpt: "x" };
  const fromSignature = model.failureView(bare, SIGNATURE, "en-US");
  assert.equal(fromSignature.title, "Out of memory …", "an unfilled capture placeholder is dropped");
  assert.equal(fromSignature.hint, "hint from the error", "the error's own hint wins");
  assert.deepEqual(fromSignature.suggestions.map((item) => item.kind), ["param", "probe", "runtime"], "unknown and incomplete suggestions are dropped");
  assert.equal(fromSignature.suggestions[0].to, "planner");

  const own = model.failureView({ ...bare, title: { zh: "自己的标题", en: "own title" }, suggestions: [{ kind: "param", param: "kvCacheDtype", to: "fp8" }] }, SIGNATURE, "zh-CN");
  assert.equal(own.title, "自己的标题");
  assert.deepEqual(own.suggestions, [{ kind: "param", param: "kvCacheDtype", to: "fp8", security: false }]);

  const nothing = model.failureView({ code: "start_failed", message: "boom" }, null, "en-US");
  assert.deepEqual([nothing.title, nothing.signatureId, nothing.suggestions.length], ["", null, 0]);
  assert.equal(model.failureView({ code: "x", signatureId: "s" }, { id: "s", phase: "api" }).phase, "api", "the phase falls back to the signature's");
  assert.equal(model.normalizeSuggestions([{ kind: "param", param: "trustRemoteCode", to: true, security: true }])[0].security, true);
  const map = model.signatureMap({ entries: [SIGNATURE, { nope: 1 }] });
  assert.equal(map.get("cuda-oom"), SIGNATURE);
  assert.equal(map.size, 1);
});

test("admission knobs come from details.knobs of an error or a job failure", () => {
  const knobs = [{ param: "sglang.memFractionStatic", suggestion: 0.9 }, { param: "bad" }, { suggestion: 1 }];
  assert.deepEqual(model.knobsOf({ details: { knobs } }), [{ param: "sglang.memFractionStatic", suggestion: 0.9 }]);
  assert.deepEqual(model.knobsOf(null, { knobs }), [{ param: "sglang.memFractionStatic", suggestion: 0.9 }]);
  assert.deepEqual(model.knobsOf({}, undefined), []);
});

// ---- storage, links and profile ---------------------------------------------------------------

test("the started launch round-trips through storage and belongs to its draft", () => {
  const text = model.serializeLaunch({ draftId: "wd_abc123456", managerId: "vllm", jobId: "job_1", launchId: "lch_1", instanceId: "primary", planHash: "sha256:a", pull: { required: true, policy: "auto", image: "i" }, secret: "x" });
  assert.ok(!text.includes("secret"));
  const parsed = model.parseLaunch(text, "wd_abc123456");
  assert.deepEqual([parsed.jobId, parsed.managerId, parsed.pull.required], ["job_1", "vllm", true]);
  assert.equal(model.parseLaunch(text, "wd_other0000"), null);
  assert.equal(model.parseLaunch("{}"), null);
  assert.equal(model.parseLaunch("not json"), null);
});

test("success links point at the playground, the deployment and its qualification", () => {
  const links = model.successLinks({ managerId: "vllm", instanceId: "", servedName: "my model" });
  assert.equal(links.fleetId, "vllm:primary");
  assert.equal(links.playground, "/playground?model=my%20model");
  assert.equal(links.deployment, "/deployments/vllm%3Aprimary");
  assert.equal(links.qualify, "/deployments/vllm%3Aprimary?qualify=1");
  assert.equal(model.successLinks({ managerId: "llama", instanceId: "b", modelName: "m" }).fleetId, "llama:b");
  assert.equal(model.runtimesHref("sglang"), "/engines/sglang?tab=runtimes");
});

test("the profile body holds the sparse values and the catalog version and never a secret", () => {
  const draft = wizard.createDraft({
    modelRef: { kind: "local", entryId: null, path: "/m/a" }, engineId: "llamacpp", managerId: "llama", recipeId: "r1",
    instance: { servedName: "served", port: 8001 }, values: { contextLength: 4096, apiKey: "fake-typed-key", "llamacpp.hfToken": "fake", empty: "" },
  });
  const body = model.profileBody(draft, { catalogVersion: "2026-10-14+2026-10-14" }, "  My profile ");
  assert.equal(body.name, "My profile");
  assert.equal(body.schemaVersion, 2);
  assert.deepEqual(body.values, { contextLength: 4096 });
  assert.equal(body.catalogVersion, "2026-10-14+2026-10-14");
  assert.equal(body.engineId, "llamacpp");
  assert.equal(body.recipeId, "r1");
  assert.deepEqual(body.config, { model: "/m/a", engine: "llama.cpp", name: "served", port: 8001 });
  assert.ok(!JSON.stringify(body).includes("fake"));
});

// ---- steps 4 and 5 ----------------------------------------------------------------------------

test("a companion pairs with a main model by vocabulary, hidden size and target layers (02 §7)", () => {
  const main = { topology: { hiddenSize: 5120, vocabSize: 248320, layers: 64 } };
  assert.equal(caps.pairsWith(main, { compatibleWith: { hiddenSize: 5120, vocabSize: 248320, targetLayers: 64 } }), true);
  assert.equal(caps.pairsWith(main, { compatibleWith: { hiddenSize: 5120, vocabSize: 248320 } }), true, "targetLayers is optional");
  assert.equal(caps.pairsWith(main, { compatibleWith: { hiddenSize: 5120, vocabSize: 248320, targetLayers: 32 } }), false);
  assert.equal(caps.pairsWith(main, { compatibleWith: { hiddenSize: 4096, vocabSize: 248320 } }), false);
  assert.equal(caps.pairsWith(main, { compatibleWith: { hiddenSize: 1024, projectionDim: 5120, vocabSize: 248320 } }), true, "a projector may match through its output dimension");
  assert.equal(caps.pairsWith(main, { compatibleWith: { hiddenSize: 5120, vocabSize: 1 } }), false);
  assert.equal(caps.pairsWith(main, {}), false);
  assert.equal(caps.pairsWith({}, { compatibleWith: { hiddenSize: 5120, vocabSize: 248320 } }), false);
  assert.equal(caps.companionParam("draft", "vllm"), "speculative.draftModel");
  assert.equal(caps.companionParam("mtp-head", "sglang"), "speculative.draftModel");
  assert.equal(caps.companionParam("mmproj", "llamacpp"), "llamacpp.mmproj");
  assert.equal(caps.companionParam("mmproj", "vllm"), "", "only llama.cpp takes a projector file");
  const entries = caps.companionEntries([
    { path: "/m/draft", displayName: "draft", card: { cardId: "mc_a", role: { value: "draft" } } },
    { path: "/m/main", card: { cardId: "mc_b", role: "main" } },
    { path: "/m/proj", card: { cardId: "mc_c", role: "mmproj" } },
    { path: "/m/none" },
  ]);
  assert.deepEqual(entries.map((entry) => [entry.cardId, entry.role]), [["mc_a", "draft"], ["mc_c", "mmproj"]]);
});

test("the template card lists what was detected and leaves out none and unknown; LAN without a key is the warning", () => {
  const rows = caps.templateRows({ template: { toolFormat: "hermes-json", reasoningFormat: "none", source: "chat_template.jinja", signatureId: "qwen38", thinking: { kwarg: "enable_thinking" } } });
  assert.deepEqual(rows.map((row) => row.id), ["toolFormat", "source", "signature", "thinking"]);
  assert.deepEqual(caps.templateRows({}), []);
  assert.deepEqual(caps.accessIssues({ access: { networkAccess: "lan", apiKey: "none" } }), { lanWithoutKey: true, lan: true });
  assert.deepEqual(caps.accessIssues({ access: { networkAccess: "lan", apiKey: "auto" } }), { lanWithoutKey: false, lan: true });
  assert.deepEqual(caps.accessIssues({ access: { networkAccess: "local", apiKey: "none" } }), { lanWithoutKey: false, lan: false });
  assert.deepEqual(caps.idleSummary({ enabled: true, idleMinutes: 30, wakeOnDemand: true, excludeModels: ["m1"] }, "m1"), { enabled: true, idleMinutes: 30, wakeOnDemand: true, excluded: true });
  assert.equal(caps.idleSummary({ enabled: false }, "x").enabled, false);
  assert.equal(caps.idleSummary(null, "x"), null);
});

// ---- quick paths ------------------------------------------------------------------------------

test("start-last-used (?manager=&from=recent) is a quick path of its own and reaches Review", () => {
  assert.deepEqual(quick.quickPathOf({ manager: "vllm", from: "recent", step: "review" }), { kind: "recent", managerId: "vllm", index: 0 });
  assert.deepEqual(quick.quickPathOf({ manager: "vllm", from: "recent", recent: "2", step: "review" }), { kind: "recent", managerId: "vllm", index: 2 });
  assert.equal(quick.quickPathOf({ manager: "vllm", from: "recent", recent: "-1" }).index, 0);
  assert.equal(quick.quickPathOf({ manager: "vllm", step: "review" }).kind, "seed", "without from=recent a manager alone seeds a draft");
  assert.equal(quick.quickPathOf({ clone: "lch_1", manager: "vllm", from: "relaunch" }).kind, "clone");
});

function fakeApi(routes) {
  return { manager: (id) => ({ get: async (route) => {
    const hit = routes[`${id} ${route}`];
    if (hit === undefined) throw Object.assign(new Error("Not found"), { status: 404, code: "endpoint_unavailable" });
    return typeof hit === "function" ? hit() : hit;
  } }) };
}

test("a recent launch with a stored launch id starts from its spec; an older one from its flat config; none gives null", async () => {
  const record = { launchId: "lch_1", managerId: "vllm", spec: { engineId: "vllm", model: { ref: "/m/a", servedName: "a" }, instance: { mode: "replace", id: "primary", port: 8000, networkAccess: "lan", gpuIds: ["0"] }, values: { contextLength: 65536 } } };
  const withId = await quick.loadRecentDraft(fakeApi({
    "vllm /recent-launches": { launches: [{ model: "/m/a", name: "a", launchId: "lch_1" }] },
    "vllm /launches/lch_1": { ok: true, launch: record },
  }), "vllm", 0, { step: "review" });
  assert.equal(withId.step, "review");
  assert.deepEqual([withId.modelRef.path, withId.engineId, withId.managerId, withId.access.networkAccess, withId.values.contextLength], ["/m/a", "vllm", "vllm", "lan", 65536]);

  const legacy = await quick.loadRecentDraft(fakeApi({
    "vllm /recent-launches": { launches: [{ model: "/m/b", name: "b", launchedAt: "2026-10-01T00:00:00Z", config: { engine: "vllm", port: 8002 } }] },
    "vllm /engines/vllm/schema": CATALOG,
  }), "vllm", 0, { step: "review" });
  assert.deepEqual([legacy.step, legacy.modelRef.path, legacy.instance.port, legacy.engineId], ["review", "/m/b", 8002, "vllm"]);

  const gone = await quick.loadRecentDraft(fakeApi({
    "vllm /recent-launches": { launches: [{ model: "/m/c", launchId: "lch_gone", config: { engine: "vllm" } }] },
    "vllm /engines/vllm/schema": CATALOG,
  }), "vllm", 0, {});
  assert.equal(gone.modelRef.path, "/m/c", "a stored launch that is gone falls back to the flat config");

  assert.equal(await quick.loadRecentDraft(fakeApi({ "vllm /recent-launches": { launches: [] } }), "vllm", 0), null);
  assert.equal(await quick.loadRecentDraft(fakeApi({ "vllm /recent-launches": { launches: [{ name: "no model" }] } }), "vllm", 0), null);
  assert.equal(await quick.loadRecentDraft(fakeApi({ "vllm /recent-launches": { launches: [{ model: "/m/a" }] } }), "vllm", 3), null);
});
