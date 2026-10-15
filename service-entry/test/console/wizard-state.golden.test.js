// CON-11 (07 §6.3, §13.1): the pure wizard state. planRequest and launchRequest
// are pinned to 01 LaunchRequestV2 goldens (local, replace, parallel, prospective
// remote, secrets); the plan loop is proven with fake timers (debounce, dedupe,
// abort, an ok:false plan); persistence never keeps a secret or an extraEnv
// value; fromLegacyProfile is checked field by field and against the real
// manager-core codecs. Refresh the goldens with UPDATE_GOLDENS=1.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GROUP_STEPS,
  STATUS_STEPS,
  STEP_IDS,
  applySuggestion,
  createDraft,
  createPlanLoop,
  diffValues,
  draftForJob,
  forgetDownload,
  fromLaunchRecord,
  fromLegacyProfile,
  groupsForStep,
  isDirty,
  isKnownGroup,
  launchRequest,
  parseDownloads,
  parseDraft,
  patchDraft,
  planReady,
  planRequest,
  rememberDownload,
  requestKey,
  resetParam,
  sanitizeDraft,
  serializeDraft,
  setValue,
  stepOfBlocker,
  stepOfField,
  stepOfGroup,
  stepStatus,
  unknownGroups,
} from "../../console/lib/wizard-state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "console");
const GOLDEN = path.join(HERE, "golden", "wizard-requests.json");
const require = createRequire(import.meta.url);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const catalogOf = (engine) => readJson(path.join(FIXTURES, `schema-${engine}.json`));
const clone = (value) => JSON.parse(JSON.stringify(value));
const FAKE_KEY = "fake-key-for-tests";

const base = (extra = {}) => createDraft({
  id: "wd_testdraft01",
  managerId: "vllm",
  engineId: "vllm",
  modelRef: { kind: "local", entryId: "lib_1", path: "C:/fixture/models/example-7B" },
  ...extra,
});

// ---- the request goldens -----------------------------------------------------------------

const SCENARIOS = {
  "local-replace-minimal": () => base(),
  "local-replace-values": () => base({
    runtimeId: "vllm@0.28.0",
    recipeId: "qwen38-flashnext-262k",
    instance: { mode: "replace", targetInstanceId: "primary", servedName: "example", port: "8000" },
    gpus: ["0", "1"],
    values: { contextLength: 131072, concurrency: 2, kvCacheDtype: "fp8", "speculative.method": null },
    extraArgs: ["--max-log-len", "256"],
    extraEnv: { VLLM_LOGGING_LEVEL: "DEBUG" },
    access: { networkAccess: "lan", apiKey: "auto" },
    acknowledge: ["experimental-engine"],
  }),
  "local-parallel-planner-value": () => base({
    engineId: "llamacpp",
    managerId: "llama",
    instance: { mode: "parallel", targetInstanceId: "primary", instanceId: "vision", port: 8180 },
    gpus: ["0"],
    values: { contextLength: { value: 65536, source: "planner" }, "llamacpp.flashAttention": true },
  }),
  "remote-prospective": () => base({
    modelRef: { kind: "remote", source: "huggingface", repo: "example-org/example-model-7B", revision: "main", cardId: "mc_abcdefghijklmnopqrst" },
    values: { contextLength: 32768 },
    instance: { mode: "replace", servedName: "example-remote" },
  }),
  "secret-value-moves-to-the-request": () => base({ values: { contextLength: 4096, apiKey: FAKE_KEY } }),
};

function built() {
  const out = {};
  for (const [name, make] of Object.entries(SCENARIOS)) {
    const draft = make();
    out[name] = {
      plan: planRequest(draft),
      launch: launchRequest(draft, { planHash: "sha256:0123abcd" }),
    };
  }
  return out;
}

test("planRequest and launchRequest match the LaunchRequestV2 goldens", () => {
  const actual = built();
  if (process.env.UPDATE_GOLDENS === "1") fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, readJson(GOLDEN));
});

test("the local replace request carries only what the user decided", () => {
  assert.deepEqual(planRequest(base()), {
    engineId: "vllm",
    model: { ref: "C:/fixture/models/example-7B" },
    instance: { mode: "replace", networkAccess: "local" },
    values: {},
  });
});

test("the prospective remote request is 00 §9.2: prospective true and model.card, never a path", () => {
  const draft = SCENARIOS["remote-prospective"]();
  const request = planRequest(draft);
  assert.equal(request.prospective, true);
  assert.deepEqual(request.model, { card: "mc_abcdefghijklmnopqrst", servedName: "example-remote" });
  assert.equal("ref" in request.model, false);
  // The manager needs the card object (01 §11); a caller that has it passes it in.
  const card = { cardId: "mc_abcdefghijklmnopqrst", schema: "modelcard/v1" };
  assert.deepEqual(planRequest(draft, { card }).model.card, card);
  assert.equal(launchRequest(draft, { planHash: "sha256:aa" }).expectedPlanHash, "sha256:aa");
});

test("launchRequest is planRequest plus expectedPlanHash, and plain without a hash", () => {
  const draft = base();
  assert.deepEqual(launchRequest(draft, { planHash: "sha256:abc" }), { ...planRequest(draft), expectedPlanHash: "sha256:abc" });
  assert.deepEqual(launchRequest(draft, { ok: true }), planRequest(draft));
  assert.deepEqual(launchRequest(draft, null), planRequest(draft));
});

test("a secret value never stays in values: it becomes its own request field, null extraEnv is not sent", () => {
  const draft = base({ values: { apiKey: FAKE_KEY, contextLength: 2048 }, extraEnv: { KEEP: "1", RETYPE: null } });
  const request = planRequest(draft, { catalog: { params: [{ id: "apiKey", secret: true }] } });
  assert.equal(request.apiKey, FAKE_KEY);
  assert.deepEqual(request.values, { contextLength: 2048 });
  assert.deepEqual(request.extraEnv, { KEEP: "1" });
  assert.equal(planRequest(base()).apiKey, undefined, "the draft never holds the generated key");
});

test("the replace slot is the target instance, a parallel slot is the new name", () => {
  const replace = planRequest(base({ instance: { mode: "replace", targetInstanceId: "primary", instanceId: "ignored" } }));
  assert.equal(replace.instance.id, "primary");
  const parallel = planRequest(base({ instance: { mode: "parallel", targetInstanceId: "primary", instanceId: "vision" } }));
  assert.equal(parallel.instance.id, "vision");
  assert.equal(planRequest(base({ instance: { mode: "parallel" } })).instance.id, undefined);
});

test("requestKey is stable under key order and ignores undefined", () => {
  assert.equal(requestKey({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } }), requestKey({ a: { c: undefined, d: [2, { x: 2, y: 1 }] }, b: 1 }));
  assert.notEqual(requestKey({ a: 1 }), requestKey({ a: 2 }));
  assert.equal(requestKey(planRequest(base())), requestKey(planRequest(base())));
});

// ---- the draft ---------------------------------------------------------------------------

test("createDraft normalises any seed and mints a wd_ id", () => {
  const draft = createDraft({ step: "nonsense", goal: "fast", instance: { mode: "x", port: "99999" }, gpus: [0, "1", "1"], access: { networkAccess: "wan" }, junk: 1 });
  assert.match(draft.id, /^wd_[a-z2-7]{12}$/);
  assert.equal(draft.v, 1);
  assert.equal(draft.step, "model");
  assert.equal(draft.goal, null);
  assert.deepEqual(draft.instance, { mode: "replace", targetInstanceId: "", instanceId: "", servedName: "", port: null });
  assert.deepEqual(draft.gpus, ["0", "1"]);
  assert.deepEqual(draft.access, { networkAccess: "local", apiKey: "auto" });
  assert.equal("junk" in draft, false);
  assert.notEqual(createDraft().id, createDraft().id);
  assert.equal(createDraft({}, { random: () => 0 }).id, "wd_aaaaaaaaaaaa");
});

test("patchDraft merges one level of instance and access; setValue and resetParam do not mutate", () => {
  const draft = deepFreeze(base({ values: { contextLength: 1024 } }));
  const next = patchDraft(draft, { instance: { port: 8001 }, access: { networkAccess: "lan" }, step: "engine" });
  assert.equal(next.instance.port, 8001);
  assert.equal(next.instance.mode, "replace");
  assert.equal(next.access.networkAccess, "lan");
  assert.equal(next.id, draft.id);
  assert.deepEqual(setValue(draft, "concurrency", 4).values, { contextLength: 1024, concurrency: 4 });
  assert.deepEqual(setValue(draft, "contextLength", null).values, {});
  assert.deepEqual(resetParam(draft, "contextLength").values, {});
  assert.deepEqual(draft.values, { contextLength: 1024 });
});

test("applySuggestion sets values and the request fields a field error can name", () => {
  const draft = base();
  assert.deepEqual(applySuggestion(draft, { param: "contextLength", value: 131072 }).values, { contextLength: 131072 });
  assert.equal(applySuggestion(draft, { param: "instance.port", value: 8123 }).instance.port, 8123);
  assert.equal(applySuggestion(draft, { param: "instance.id", value: "primary" }).instance.targetInstanceId, "primary");
  assert.equal(applySuggestion(patchDraft(draft, { instance: { mode: "parallel" } }), { param: "instance.id", value: "b" }).instance.instanceId, "b");
  assert.equal(applySuggestion(draft, { param: "model.servedName", value: "x" }).instance.servedName, "x");
  assert.equal(applySuggestion(draft, {}), draft);
});

test("planReady needs manager, engine and a planable model; isDirty ignores a pristine draft", () => {
  assert.equal(planReady(base()), true);
  assert.equal(planReady(base({ managerId: "" })), false);
  assert.equal(planReady(base({ modelRef: { kind: "remote", source: "huggingface", repo: "o/n" } })), false, "a remote model needs its card id");
  assert.equal(planReady(base({ modelRef: { kind: "remote", source: "huggingface", repo: "o/n", cardId: "mc_x" } })), true);
  assert.equal(isDirty(createDraft()), false);
  assert.equal(isDirty(base()), true);
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// ---- groups and steps --------------------------------------------------------------------

test("07 §6.3 group to step mapping, with an unknown group on Resources", () => {
  assert.equal(stepOfGroup("model"), "model");
  for (const group of ["capacity", "memory", "parallelism", "runtime-expert"]) assert.equal(stepOfGroup(group), "resources");
  for (const group of ["reasoning-tools", "speculative", "multimodal", "sampling"]) assert.equal(stepOfGroup(group), "capabilities");
  assert.equal(stepOfGroup("network-security"), "access");
  assert.equal(stepOfGroup("brand-new-group"), "resources");
  assert.equal(isKnownGroup("brand-new-group"), false);
  const catalog = { groups: [{ id: "memory", order: 2 }, { id: "capacity", order: 1 }, { id: "weird", order: 9 }, { id: "sampling", order: 3 }] };
  assert.deepEqual(groupsForStep(catalog, "resources"), ["capacity", "memory", "weird"]);
  assert.deepEqual(unknownGroups(catalog), ["weird"]);
});

test("every group the real 01 catalogs seed is mapped explicitly", () => {
  const core = require(path.join(ROOT, "manager-core"));
  const catalogs = core.engines.getParamCatalog();
  const files = fs.readdirSync(path.join(ROOT, "manager-core", "data", "launch-params")).filter((name) => name.endsWith(".json") && name !== "common.json");
  assert.ok(files.length >= 3);
  const unmapped = [];
  for (const file of files) {
    const engineId = file.replace(/\.json$/, "");
    const payload = core.engines.paramCatalog.buildSchemaPayload({ catalog: catalogs.loadCatalog(engineId, {}), facts: {} });
    for (const group of payload.groups) if (!isKnownGroup(group.id)) unmapped.push(`${engineId}:${group.id}`);
    for (const param of payload.params) assert.ok(STEP_IDS.includes(stepOfGroup(param.group)), `${engineId} ${param.id}`);
  }
  assert.deepEqual(unmapped, [], "a seeded group without a step fails here; add it to GROUP_STEPS");
  for (const step of Object.values(GROUP_STEPS)) assert.ok(STEP_IDS.includes(step));
});

test("stepOfField follows request fields, then the catalog group of the param (paths cut to the id)", () => {
  const catalog = catalogOf("llamacpp");
  assert.equal(stepOfField("model.ref"), "model");
  assert.equal(stepOfField("prospective"), "model");
  assert.equal(stepOfField("runtimeId"), "engine");
  assert.equal(stepOfField("runtime.imageOverride"), "engine");
  assert.equal(stepOfField("instance.port"), "resources");
  assert.equal(stepOfField("instance.networkAccess"), "access");
  assert.equal(stepOfField("extraArgs[1]"), "resources");
  assert.equal(stepOfField(""), "review");
  assert.equal(stepOfField("contextLength", catalog), stepOfGroup(catalog.params.find((param) => param.id === "contextLength").group));
  const nested = catalog.params.find((param) => param.id === "llamacpp.overrideTensor");
  if (nested) assert.equal(stepOfField("llamacpp.overrideTensor[0].pattern", catalog), stepOfGroup(nested.group));
  assert.equal(stepOfField("no-such-param", catalog), "resources");
  assert.equal(stepOfBlocker({ code: "experimental_ack_required" }), "engine");
  assert.equal(stepOfBlocker({ code: "insufficient_vram" }), "resources");
  assert.equal(stepOfBlocker({ code: "image_pull_required" }), "review");
  assert.equal(stepOfBlocker({ code: "something_new" }), "review");
});

test("stepStatus reports ok, warn or error per step from the draft and the plan", () => {
  const catalog = catalogOf("vllm");
  assert.deepEqual(STATUS_STEPS, ["model", "engine", "resources", "capabilities", "access", "review"]);
  const empty = stepStatus(createDraft(), null, catalog);
  assert.equal(empty.model, "error");
  assert.equal(empty.engine, "error");
  assert.equal(empty.review, "error");
  const ready = stepStatus(base(), { ok: true, errors: [], blockers: [], warnings: [], admission: { verdict: "ok" } }, catalog);
  assert.deepEqual(ready, { model: "ok", engine: "ok", resources: "ok", capabilities: "ok", access: "ok", review: "ok" });
  assert.equal(stepStatus(base(), null, catalog).review, "warn", "no plan yet");
  const remote = stepStatus(base({ modelRef: { kind: "remote", source: "huggingface", repo: "o/n", cardId: "mc_x" } }), { ok: true }, catalog);
  assert.equal(remote.model, "warn");
  assert.equal(remote.review, "warn");
  const problems = stepStatus(base(), {
    ok: false,
    errors: [{ field: "contextLength", code: "out_of_range" }, { field: "instance.networkAccess", code: "x" }],
    blockers: [{ code: "experimental_ack_required" }, { code: "image_pull_required" }],
    warnings: [{ field: "model.ref", code: "w" }],
    admission: { verdict: "block" },
  }, catalog);
  assert.equal(problems.engine, "error");
  assert.equal(problems.access, "error");
  assert.equal(problems.resources, "error");
  assert.equal(problems.model, "warn");
  assert.equal(problems.review, "error");
  assert.equal(stepStatus(base({ access: { networkAccess: "lan", apiKey: "none" } }), { ok: true }, catalog).access, "warn");
});

// ---- the plan loop -----------------------------------------------------------------------

function fakeTimers() {
  let now = 0;
  const timers = new Map();
  let next = 1;
  return {
    setTimer(fn, ms) {
      timers.set(next, { at: now + ms, fn });
      return next++;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
      await Promise.resolve();
      await Promise.resolve();
    },
    get pending() {
      return timers.size;
    },
  };
}

function loopWith(send) {
  const timers = fakeTimers();
  const states = [];
  const loop = createPlanLoop({ send, setTimer: timers.setTimer, clearTimer: timers.clearTimer, onChange: (state) => states.push(state.status) });
  return { loop, timers, states };
}

test("plan requests are debounced: a burst of edits sends one request", async () => {
  const sent = [];
  const { loop, timers } = loopWith(async (managerId, body) => {
    sent.push({ managerId, body });
    return { ok: true, planHash: "sha256:1" };
  });
  for (let value = 1; value <= 5; value += 1) {
    loop.request("vllm", planRequest(base({ values: { contextLength: value * 1024 } })));
    await timers.advance(100);
  }
  assert.equal(sent.length, 0, "still inside the debounce");
  await timers.advance(250);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.values.contextLength, 5 * 1024);
  assert.equal(loop.state.status, "ready");
  assert.equal(loop.state.plan.planHash, "sha256:1");
  assert.equal(loop.state.requests, 1);
});

test("plan requests are deduped by requestKey: the same body and the one the plan answers send nothing", async () => {
  let count = 0;
  const { loop, timers, states } = loopWith(async () => {
    count += 1;
    return { ok: true };
  });
  const body = planRequest(base());
  loop.request("vllm", body);
  loop.request("vllm", clone(body));
  await timers.advance(300);
  assert.equal(count, 1);
  loop.request("vllm", clone(body));
  await timers.advance(300);
  assert.equal(count, 1, "an unchanged request is not sent again");
  assert.equal(loop.state.status, "ready");
  // A change inside the debounce that is undone before it fires also sends nothing.
  loop.request("vllm", planRequest(base({ values: { contextLength: 2048 } })));
  assert.equal(loop.state.status, "updating");
  loop.request("vllm", clone(body));
  await timers.advance(300);
  assert.equal(count, 1);
  assert.equal(loop.state.status, "ready");
  assert.ok(states.includes("updating"));
  // A different manager is a different request.
  loop.request("llama", clone(body));
  await timers.advance(300);
  assert.equal(count, 2);
});

test("a newer request aborts the older one and its late answer is ignored", async () => {
  const pending = [];
  const signals = [];
  const { loop, timers } = loopWith((managerId, body, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal);
    pending.push({ resolve, reject, body });
  }));
  loop.request("vllm", planRequest(base({ values: { contextLength: 1 } })));
  await timers.advance(300);
  loop.request("vllm", planRequest(base({ values: { contextLength: 2 } })));
  await timers.advance(300);
  assert.equal(pending.length, 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  pending[1].resolve({ ok: true, planHash: "new" });
  await Promise.resolve();
  pending[0].resolve({ ok: true, planHash: "old" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(loop.state.plan.planHash, "new");
});

test("an ok:false plan is a plan; a thrown error keeps the last plan and retries on request", async () => {
  const answers = [
    { ok: false, errors: [{ field: "contextLength", code: "out_of_range", message: "too big" }], blockers: [{ code: "insufficient_vram" }] },
    "fail",
    { ok: true, planHash: "sha256:fixed" },
  ];
  const { loop, timers } = loopWith(async () => {
    const answer = answers.shift();
    if (answer === "fail") throw Object.assign(new Error("boom"), { code: "network_error" });
    return answer;
  });
  const body = planRequest(base());
  loop.request("vllm", body);
  await timers.advance(300);
  assert.equal(loop.state.status, "ready");
  assert.equal(loop.state.plan.ok, false);
  assert.equal(loop.state.plan.errors[0].field, "contextLength");
  loop.request("vllm", planRequest(base({ values: { contextLength: 7 } })));
  await timers.advance(300);
  assert.equal(loop.state.status, "error");
  assert.equal(loop.state.error.code, "network_error");
  assert.equal(loop.state.plan.ok, false, "the last plan stays visible");
  loop.refresh("vllm", planRequest(base({ values: { contextLength: 7 } })));
  await timers.advance(0);
  assert.equal(loop.state.status, "ready");
  assert.equal(loop.state.plan.planHash, "sha256:fixed");
  assert.equal(loop.state.error, null);
});

test("pause drops pending work, keeps the plan and dispose stops everything", async () => {
  let count = 0;
  const { loop, timers } = loopWith(async () => {
    count += 1;
    return { ok: true };
  });
  loop.request("vllm", planRequest(base()));
  assert.equal(timers.pending, 1);
  loop.pause();
  assert.equal(timers.pending, 0);
  assert.equal(loop.state.status, "idle");
  await timers.advance(1000);
  assert.equal(count, 0);
  loop.request("vllm", planRequest(base()));
  await timers.advance(300);
  assert.equal(count, 1);
  loop.pause();
  assert.equal(loop.state.plan.ok, true);
  loop.dispose();
  loop.request("vllm", planRequest(base({ values: { contextLength: 3 } })));
  assert.equal(timers.pending, 0);
});

// ---- persistence -------------------------------------------------------------------------

test("a stored draft has no secret value and no extraEnv value, and parses back", () => {
  const catalog = { params: [{ id: "apiKey", secret: true }, { id: "tabby.adminKey", secret: true }, { id: "contextLength" }] };
  const draft = base({
    values: { contextLength: 4096, apiKey: FAKE_KEY, "tabby.adminKey": "fake-admin", hfToken: "hf_fake" },
    extraEnv: { MY_TOKEN: "fake-token-value", PLAIN: "visible" },
    extraArgs: ["--max-log-len", "10", "--api-key", FAKE_KEY, "--auth-token=fake", "--keep"],
  });
  const text = serializeDraft(draft, catalog);
  for (const secret of [FAKE_KEY, "fake-admin", "hf_fake", "fake-token-value", "visible", "fake"]) assert.equal(text.includes(secret), false, `${secret} must not be stored`);
  const stored = JSON.parse(text);
  assert.deepEqual(stored.values, { contextLength: 4096 });
  assert.deepEqual(stored.extraEnv, { MY_TOKEN: null, PLAIN: null }, "names stay, values must be retyped");
  assert.deepEqual(stored.extraArgs, ["--max-log-len", "10", "--keep"]);
  const back = parseDraft(text);
  assert.equal(back.id, draft.id);
  assert.equal(back.modelRef.path, draft.modelRef.path);
  assert.deepEqual(back.extraEnv, { MY_TOKEN: null, PLAIN: null });
  assert.equal("apiKey" in planRequest(back), false);
  assert.deepEqual(Object.keys(planRequest(back, { catalog })).includes("extraEnv"), false, "retype-pending env is not sent");
  assert.equal(draft.values.apiKey, FAKE_KEY, "the live draft is untouched");
  assert.deepEqual(sanitizeDraft(draft, catalog).values, stored.values);
});

test("parseDraft rejects text that is not a v1 draft", () => {
  assert.equal(parseDraft(""), null);
  assert.equal(parseDraft("{"), null);
  assert.equal(parseDraft(JSON.stringify({ v: 2, id: "wd_abcdefgh" })), null);
  assert.equal(parseDraft(JSON.stringify({ v: 1, id: "nope" })), null);
  assert.equal(parseDraft(null), null);
  assert.equal(parseDraft(serializeDraft(createDraft())).step, "model");
});

test("jobId to draftId memory for Download first", () => {
  let map = parseDownloads(undefined);
  assert.deepEqual(map, {});
  map = rememberDownload(map, "dl_1", "wd_abcdefgh");
  map = rememberDownload(map, "dl_2", "not-a-draft");
  assert.deepEqual(map, { dl_1: "wd_abcdefgh" });
  assert.equal(draftForJob(map, "dl_1"), "wd_abcdefgh");
  assert.equal(draftForJob(map, "dl_3"), null);
  assert.deepEqual(parseDownloads(JSON.stringify({ dl_1: "wd_abcdefgh", bad: "x", n: 1 })), { dl_1: "wd_abcdefgh" });
  assert.deepEqual(forgetDownload(map, "dl_1"), {});
  for (let index = 0; index < 30; index += 1) map = rememberDownload(map, `dl_x${index}`, "wd_abcdefgh");
  assert.equal(Object.keys(map).length, 20);
});

// ---- launches and profiles ---------------------------------------------------------------

test("fromLaunchRecord starts a draft from the stored spec and keeps no env value", () => {
  const record = {
    launchId: "lch_aaaaaaaaaaaaaaaaaaaa",
    managerId: "vllm",
    spec: {
      engineId: "sglang",
      runtimeId: "sglang@0.5.17",
      recipeId: "qwen38-flashnext-262k",
      model: { ref: "C:/fixture/models/example-7B", servedName: "example" },
      instance: { mode: "replace", id: "primary", port: 8000, networkAccess: "lan", gpuIds: ["0"] },
      values: { contextLength: 262144, concurrency: 1 },
      extraArgs: ["--x"],
      extraEnv: { SECRET_THING: "fake-value" },
      secrets: { apiKeyRef: "ref" },
    },
  };
  const draft = fromLaunchRecord(record);
  assert.equal(draft.managerId, "vllm");
  assert.equal(draft.engineId, "sglang");
  assert.equal(draft.modelRef.path, "C:/fixture/models/example-7B");
  assert.deepEqual(draft.instance, { mode: "replace", targetInstanceId: "primary", instanceId: "", servedName: "example", port: 8000 });
  assert.deepEqual(draft.gpus, ["0"]);
  assert.deepEqual(draft.extraEnv, { SECRET_THING: null });
  assert.equal(draft.access.networkAccess, "lan");
  assert.deepEqual(draft.values, { contextLength: 262144, concurrency: 1 });
  const parallel = fromLaunchRecord({ spec: { instance: { mode: "add", id: "vision" } }, managerId: "llama" });
  assert.equal(parallel.instance.mode, "parallel");
  assert.equal(parallel.instance.instanceId, "vision");
  assert.equal(fromLaunchRecord({}).modelRef, null);
});

test("fromLegacyProfile accounts for every key of a flat profile and never copies a secret", () => {
  const catalog = catalogOf("vllm");
  const config = {
    engine: "vllm",
    model: "C:/fixture/models/example-7B",
    name: "example",
    port: 8000,
    instanceMode: "parallel",
    instanceId: "vision",
    networkAccess: "lan",
    gpuDeviceIds: "0,1",
    maxModelLen: 65536,
    maxNumSeqs: 2,
    kvCacheDtype: "fp8_e4m3",
    apiKey: FAKE_KEY,
    hfAccessToken: "hf_fake",
    runtimeImage: "example/image:1",
    totallyUnknownField: { nested: [1, 2] },
  };
  const profile = { id: "p1", name: "Profile", config };
  const draft = fromLegacyProfile(profile, catalog, { managerId: "vllm" });
  assert.equal(draft.engineId, "vllm");
  assert.equal(draft.managerId, "vllm");
  assert.equal(draft.modelRef.path, "C:/fixture/models/example-7B");
  assert.equal(draft.instance.mode, "parallel");
  assert.equal(draft.instance.instanceId, "vision");
  assert.equal(draft.instance.port, 8000);
  assert.equal(draft.access.networkAccess, "lan");
  assert.deepEqual(draft.gpus, ["0", "1"]);
  const byLegacyField = new Map(catalog.params.filter((param) => param.legacy?.field).map((param) => [param.legacy.field, param.id]));
  assert.equal(draft.values[byLegacyField.get("maxModelLen")], 65536);
  assert.equal(draft.values[byLegacyField.get("maxNumSeqs")], 2);
  assert.equal(draft.values[byLegacyField.get("name")], "example");
  const legacy = draft.legacy;
  assert.deepEqual(legacy.unmapped, { totallyUnknownField: { nested: [1, 2] } });
  assert.deepEqual(legacy.secrets, ["apiKey", "hfAccessToken"]);
  assert.equal(legacy.runtimeImage, "example/image:1");
  const accounted = new Set([...legacy.consumed, ...Object.keys(legacy.unmapped), ...legacy.secrets]);
  assert.deepEqual([...accounted].sort(), Object.keys(config).sort(), "lossless: every key is a value, a request field, unmapped or a secret name");
  assert.equal(JSON.stringify(draft).includes(FAKE_KEY), false);
  assert.equal(JSON.stringify(draft).includes("hf_fake"), false);
  assert.equal(JSON.stringify(planRequest(draft, { catalog })).includes(FAKE_KEY), false);
});

test("fromLegacyProfile reads a v2 profile's sparse values and ignores a secret among them", () => {
  const catalog = catalogOf("sglang");
  const draft = fromLegacyProfile({ id: "p2", engineId: "sglang", recipeId: "pennyroyal-v251", values: { contextLength: 524288, apiKey: FAKE_KEY }, config: {} }, catalog, { managerId: "vllm" });
  assert.equal(draft.engineId, "sglang");
  assert.equal(draft.recipeId, "pennyroyal-v251");
  assert.deepEqual(draft.values, { contextLength: 524288 });
});

test("fromLegacyProfile agrees with manager-core's legacyConfigToValues on every builtin profile", () => {
  const core = require(path.join(ROOT, "manager-core"));
  const catalogs = core.engines.getParamCatalog();
  let compared = 0;
  for (const [managerId, defaultEngine] of [["vllm", "vllm"], ["llama", "llamacpp"]]) {
    for (const profile of core.engines.builtinProfiles(managerId, { modelsRoot: "C:/fixture/models" })) {
      const engineId = profile.config.engine === "sglang" ? "sglang" : defaultEngine;
      const payload = core.engines.paramCatalog.buildSchemaPayload({ catalog: catalogs.loadCatalog(engineId, {}), facts: {} });
      const expected = core.engines.legacyAliases.legacyConfigToValues(profile.config, engineId, { catalog: catalogs.loadCatalog(engineId, {}) });
      const draft = fromLegacyProfile(profile, payload, { managerId });
      assert.deepEqual(draft.values, expected, `${managerId}/${profile.id}`);
      const accounted = new Set([...draft.legacy.consumed, ...Object.keys(draft.legacy.unmapped), ...draft.legacy.secrets]);
      assert.deepEqual([...accounted].sort(), Object.keys(profile.config).sort(), `${managerId}/${profile.id} loses nothing`);
      compared += 1;
    }
  }
  assert.ok(compared >= 15);
});

// ---- comparing values --------------------------------------------------------------------

test("diffValues lists changed params in catalog order with labels, unwrapped values and provenance", () => {
  const catalog = catalogOf("vllm");
  const ids = catalog.params.map((param) => param.id);
  const rows = diffValues(
    { concurrency: 1, contextLength: 4096, servedName: "same" },
    { servedName: "same", contextLength: { value: 8192, source: "planner" }, concurrency: 1, "no.such.param": true },
    catalog,
    { locale: "en-US" },
  );
  assert.deepEqual(rows.map((row) => row.id), ["contextLength", "no.such.param"].sort((a, b) => (ids.indexOf(a) < 0 ? 1e6 : ids.indexOf(a)) - (ids.indexOf(b) < 0 ? 1e6 : ids.indexOf(b))));
  const context = rows.find((row) => row.id === "contextLength");
  assert.equal(context.from, "4096");
  assert.equal(context.to, "8192");
  assert.equal(context.source, "planner");
  assert.ok(context.label && context.label !== "contextLength");
  assert.equal(diffValues({ contextLength: 1 }, { contextLength: 1 }, catalog).length, 0);
  const zh = diffValues({}, { contextLength: 1 }, catalog, { locale: "zh-CN" })[0];
  assert.notEqual(zh.label, context.label);
  assert.equal(diffValues({ x: [1, 2] }, { x: [1, 3] }, null)[0].to, "[1,3]");
});
