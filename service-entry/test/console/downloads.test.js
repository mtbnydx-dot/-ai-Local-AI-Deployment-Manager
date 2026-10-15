// CON-15: the rules behind the Models Discover page, the download plan sheet and
// the Downloads page (lib/discover-model.js, lib/plan-model.js,
// lib/downloads-model.js), checked against the real hub modules where they
// share a vocabulary: the search query parser, the job states and the error
// action ids. Rendering and the flows against mocked APIs are covered in a
// browser by tests/frontend/console/console-models.spec.js (part 2).

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as discover from "../../console/lib/discover-model.js";
import * as downloads from "../../console/lib/downloads-model.js";
import * as plan from "../../console/lib/plan-model.js";

await import("./loader.mjs");

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE = path.resolve(HERE, "..", "..", "console");
const source = (file) => fs.readFileSync(path.join(CONSOLE, file), "utf8");
const catalog = JSON.parse(fs.readFileSync(path.join(CONSOLE, "i18n", "hub", "en-US.json"), "utf8"));

const pick = (text) => text.en;

// ---------------------------------------------------------------------------
// Discover

test("searchQuery builds the facet pairs the hub parses, for every facet value the form offers", () => {
  const { parseSearchQuery, FACET_KEYS } = require("../../../manager-core/model-hub/search.js");
  const form = { ...discover.EMPTY_SEARCH, q: "  qwen  ", fit: true, moe: true, gated: "false", engine: "llamacpp" };
  const query = discover.searchQuery(form);
  assert.deepEqual(query, { q: "qwen", provider: "huggingface", sort: "trending", limit: 24, facet: ["fit:fits", "engine:llamacpp", "moe:true", "gated:false"] });
  const parsed = parseSearchQuery(query);
  assert.deepEqual([...parsed.facets.keys()].sort(), ["engine", "fit", "gated", "moe"]);
  for (const key of ["format", "size", "modality", "updated"]) {
    const values = { format: discover.FORMAT_FACETS, size: discover.SIZE_FACETS, modality: discover.MODALITY_FACETS, updated: discover.UPDATED_FACETS }[key];
    assert.ok(FACET_KEYS.includes(key));
    for (const value of values) assert.doesNotThrow(() => parseSearchQuery(discover.searchQuery({ ...discover.EMPTY_SEARCH, [key]: value })), `${key}:${value}`);
  }
  for (const sort of discover.SORTS) assert.equal(parseSearchQuery(discover.searchQuery({ ...discover.EMPTY_SEARCH, sort })).sort, sort);
  assert.equal(discover.activeFacetCount(form), 4);
  assert.equal(discover.activeFacetCount(discover.EMPTY_SEARCH), 0);
});

test("the mirror searches Hugging Face; a cursor is carried and a changed form changes the page key", () => {
  assert.equal(discover.providerOf("hf-mirror"), "huggingface");
  assert.equal(discover.providerOf("modelscope"), "modelscope");
  const form = { ...discover.EMPTY_SEARCH, q: "llama" };
  assert.equal(discover.searchQuery(form, { cursor: "abc" }).cursor, "abc");
  assert.equal(discover.searchQuery(form).cursor, undefined);
  assert.equal(discover.searchKey(form), discover.searchKey({ ...form }));
  assert.notEqual(discover.searchKey(form), discover.searchKey({ ...form, fit: true }));
  assert.notEqual(discover.searchKey(form), discover.searchKey({ ...form, source: "hf-mirror" }), "the mirror is a different search for the plan sheet");
});

const ITEMS = [
  { provider: "huggingface", repo: "Qwen/Qwen3-8B-FP8", formats: ["safetensors", "fp8"], quants: [], paramsB: 8.2, downloads: 120000, familyKey: "qwen/qwen3-8b", baseModel: "Qwen/Qwen3-8B",
    fitHint: { label: "fits", neededMb: 31000, basis: "params" }, engines: ["vllm"], library: { state: "absent", entryId: null } },
  { provider: "huggingface", repo: "unsloth/Qwen3-8B-GGUF", formats: ["gguf"], quants: ["Q4_K_M", "Q8_0", "Q2_K"], familyKey: "qwen/qwen3-8b", baseModel: "Qwen/Qwen3-8B",
    fitHint: { label: "tight", neededMb: 6100, basis: "params" }, library: { state: "update-available", entryId: "lib_a" }, gated: true },
  { provider: "huggingface", repo: "other/Solo-7B", formats: ["gguf"], quants: [], familyKey: "", fitHint: { label: "bogus" }, library: { state: "weird" } },
  { repo: "" },
  null,
];

test("familyCards groups repositories by familyKey and keeps the first-appearance order", () => {
  const cards = discover.familyCards(ITEMS);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0].variants.map((variant) => variant.repo), ["Qwen/Qwen3-8B-FP8", "unsloth/Qwen3-8B-GGUF"]);
  assert.equal(cards[0].title, "Qwen/Qwen3-8B");
  assert.equal(cards[0].libraryState, "update-available");
  assert.equal(cards[0].bestFit, "fits");
  assert.equal(cards[0].gated, true);
  assert.equal(cards[1].title, "other/Solo-7B");
  assert.equal(cards[1].variants[0].fit, "unknown", "an unknown fit label reads unknown");
  assert.equal(cards[1].variants[0].libraryState, "absent");
});

test("variant chips read FP8 / GGUF Q4_K_M with the estimated VRAM", () => {
  const [fp8, gguf] = discover.familyCards(ITEMS)[0].variants;
  assert.equal(fp8.label, "FP8");
  assert.equal(fp8.neededMb, 31000);
  assert.equal(fp8.estimate, true);
  assert.equal(gguf.label, "GGUF Q4_K_M Q8_0");
  assert.equal(discover.variantOf({ repo: "a/b", formats: [] }).label, "");
});

test("the plan sheet target round-trips through the URL and a model ref is what the wizard takes", () => {
  const target = { provider: "modelscope", repo: "owner/name", artifact: "gguf:|Q4_K_M", runAfter: true, source: "modelscope", rootId: "r1" };
  const href = discover.planHref(target);
  const parsed = discover.planTargetFromQuery(Object.fromEntries(new URL(href, "http://x").searchParams));
  assert.deepEqual(parsed, target);
  assert.equal(discover.planTargetFromQuery({ drawer: "plan", repo: "noslash" }), null);
  assert.equal(discover.planTargetFromQuery({ repo: "a/b" }), null, "no drawer, no sheet");
  assert.deepEqual(discover.planTargetFromQuery({ drawer: "plan", repo: "a/b", source: "evil" }).source, "");
  assert.deepEqual(discover.remoteRef({ provider: "huggingface", repo: "a/b" }), { kind: "remote", source: "huggingface", repo: "a/b", revision: "main" });
  assert.equal(discover.detailHref("huggingface", "a/b c"), "/models/hub/huggingface/a/b%20c");
  assert.equal(discover.detailHref("huggingface", "noslash"), "");
});

// ---------------------------------------------------------------------------
// Plan sheet

test("planRequest builds the 03 §13.4 body, leaves defaults out and sends the token only for a one-time-token plan", () => {
  const form = { provider: "huggingface", repo: "a/b", revision: "main", artifactKey: "gguf:|Q4_K_M", companions: ["mmproj-F16.gguf"], rootId: "", outputName: "  ", source: "auto", credentialMode: "auto", hfToken: "hf_fake", remember: true };
  const body = plan.planRequest(form);
  assert.deepEqual(body, {
    provider: "huggingface", repo: "a/b", revision: "main",
    selection: { artifactKey: "gguf:|Q4_K_M", companions: ["mmproj-F16.gguf"], files: null },
    target: { rootId: null, outputName: null }, source: "auto", credential: { mode: "auto" }, runAfter: null, priority: "normal",
  });
  const withToken = plan.planRequest({ ...form, credentialMode: "temp-token", runAfter: { engineId: "vllm" }, source: "hf-mirror", priority: "high" });
  assert.deepEqual(withToken.credential, { mode: "temp-token", hfToken: "hf_fake", remember: true });
  assert.equal(withToken.runAfter.engineId, "vllm");
  assert.equal(withToken.source, "hf-mirror");
  assert.equal(withToken.priority, "high");
  assert.equal(plan.planRequest({ ...form, credentialMode: "temp-token", hfToken: " " }).credential.mode, "auto", "no token typed, no token plan");
  assert.doesNotMatch(plan.planKey(withToken), /hf_fake/, "the dedupe key never holds the token");
  assert.equal(plan.planKey(withToken), plan.planKey(plan.planRequest({ ...form, credentialMode: "temp-token", runAfter: { engineId: "vllm" }, source: "hf-mirror", priority: "high" })));
  assert.notEqual(plan.planKey(withToken), plan.planKey(plan.planRequest({ ...form, credentialMode: "temp-token", hfToken: "hf_other", runAfter: { engineId: "vllm" }, source: "hf-mirror", priority: "high" })), "a different token plans again");
});

test("sources depend on the provider: a ModelScope repository only comes from ModelScope", () => {
  assert.deepEqual(plan.sourceChoices("huggingface"), ["auto", "huggingface", "hf-mirror"]);
  assert.deepEqual(plan.sourceChoices("modelscope"), ["auto", "modelscope"]);
  assert.equal(plan.alternateSource("hf-mirror"), "huggingface");
  assert.equal(plan.alternateSource("huggingface"), "hf-mirror");
});

test("artifactChoices, companions and the initial pick follow the recommended artifact", () => {
  const choices = plan.artifactChoices([
    { artifactKey: "gguf:|Q8_0", label: "Q8_0", bytes: 8e9, fileCount: 1, complete: true, fit: { label: "fits", neededMb: 9000 }, engines: [{ engineId: "llamacpp" }], companions: { mmproj: [{ path: "mmproj-F16.gguf", size: 1e9 }], draft: [{ path: "draft.gguf", size: 5e8 }] } },
    { artifactKey: "gguf:|Q4_K_M", label: "Q4_K_M", bytes: 5e9, fileCount: 1, recommended: true, fit: { label: "fits", spill: true }, engines: [] },
    { artifactKey: "", label: "nameless" },
  ]);
  assert.equal(choices.length, 2);
  assert.equal(plan.initialArtifact(choices), "gguf:|Q4_K_M");
  assert.equal(plan.initialArtifact(choices, "gguf:|Q8_0"), "gguf:|Q8_0");
  assert.equal(plan.initialArtifact(choices, "missing"), "gguf:|Q4_K_M");
  assert.deepEqual(choices[0].companions.map((file) => file.kind), ["mmproj", "draft"]);
  assert.deepEqual(plan.defaultCompanions(choices[0].companions), ["mmproj-F16.gguf"]);
  assert.deepEqual(plan.defaultCompanions([]), []);
  assert.equal(plan.deployEngine(choices[0]), "llamacpp");
  assert.equal(plan.deployEngine(choices[1]), "");
});

test("rootChoices hides offline and hidden roots; the free-space bars add the queue and this download", () => {
  const roots = plan.rootChoices({ roots: [
    { id: "a", label: "Library A", freeBytes: 500, totalBytes: 1000, default: true },
    { id: "b", hidden: true }, { id: "c", online: false }, { label: "no id" },
  ] });
  assert.deepEqual(roots.map((root) => root.id), ["a"]);
  const bars = plan.freeSpaceBars({ target: { freeBytes: 500, reserveBytes: 50, queuedOnVolumeBytes: 100, freeAfterBytes: 250 }, artifact: { bytesToDownload: 150 } }, roots[0]);
  assert.equal(bars.total, 1000);
  assert.deepEqual(bars.before, [{ id: "used", value: 500 }]);
  assert.deepEqual(bars.after.map((part) => [part.id, part.value]), [["used", 500], ["queued", 100], ["download", 150]]);
  assert.equal(bars.freeAfterBytes, 250);
  assert.equal(bars.overflows, false);
  assert.equal(plan.freeSpaceBars({ target: {} }, null), null);
  assert.equal(plan.freeSpaceBars({ target: { freeBytes: 100 }, artifact: { bytesToDownload: 400 } }, null).overflows, true);
});

test("blockers come from a 422 plan_blocked list or from one failed call, each with its fix actions", () => {
  const list = plan.blockersFromError({ code: "plan_blocked", details: { blocking: [{ code: "disk_full", message: "m", hint: "h", actions: ["choose-root", "open-storage"] }, { code: "already_downloading", actions: ["open-downloads"], existingJobId: "dl_1" }] } });
  assert.deepEqual(list.map((item) => item.code), ["disk_full", "already_downloading"]);
  assert.equal(list[1].existingJobId, "dl_1");
  const single = plan.blockersFromError({ code: "already_in_library", message: "dup", details: { entryId: "lib_x" } });
  assert.deepEqual(single[0].actions, ["open-library"]);
  assert.equal(single[0].entryId, "lib_x");
  assert.deepEqual(plan.blockersFromError({ code: "filter_no_match" })[0].actions, ["pick-artifact"]);
  assert.deepEqual(plan.blockersFromError({ code: "totally_new" })[0].actions, []);
  assert.equal(plan.replanCode({ code: "plan_changed" }), true);
  assert.equal(plan.replanCode({ code: "plan_blocked" }), false);
  assert.equal(plan.duplicateState({ existing: { state: "duplicate-elsewhere" } }).duplicate, true);
  assert.equal(plan.duplicateState({ existing: { state: "partial" } }).warn, true);
  assert.equal(plan.duplicateState({ existing: { state: "partial" } }).duplicate, false);
  assert.equal(plan.duplicateState(null).warn, false);
});

test("probeRows sorts by latency, failures last, and marks the recommended source", () => {
  const rows = plan.probeRows({ recommended: "hf-mirror", sources: [{ source: "huggingface", ok: false, ms: null }, { source: "hf-mirror", ok: true, ms: 80.4 }, { source: "modelscope", ok: true, ms: 200 }] });
  assert.deepEqual(rows.map((row) => row.source), ["hf-mirror", "modelscope", "huggingface"]);
  assert.equal(rows[0].ms, 80);
  assert.equal(rows[0].recommended, true);
  assert.deepEqual(plan.probeRows(null), []);
});

test("every blocker action the real planner and the error table can produce has a fix button in the sheet", () => {
  const { HUB_ERROR_ACTIONS } = require("../../../manager-core/model-hub/errors.js");
  const sheet = source("routes/models/download-plan.js");
  const planner = fs.readFileSync(path.resolve(HERE, "..", "..", "..", "manager-core", "model-hub", "plan.js"), "utf8");
  const produced = new Set([...planner.matchAll(/actions: \[([^\]]+)\]/g)].flatMap((match) => [...match[1].matchAll(/"([a-z-]+)"/g)].map((item) => item[1])));
  assert.ok(produced.has("choose-root") && produced.has("open-downloads"), "the planner's blocker actions were found");
  for (const id of produced) assert.match(sheet, new RegExp(`case "${id}"`), `plan sheet fix for ${id}`);
  const failure = source("routes/models/downloads-failure.js");
  for (const id of new Set(Object.values(HUB_ERROR_ACTIONS).flat())) assert.match(failure, new RegExp(`case "${id}"`), `failure card action ${id}`);
});

// ---------------------------------------------------------------------------
// Downloads

const job = (id, state, extra = {}) => ({
  id, state, priority: "normal", queueOrder: 1, artifact: { provider: "huggingface", repo: `o/${id}`, quant: "Q4_K_M", totalBytes: 1000 },
  target: { outputName: `o-${id}`, rootLabel: "Library" }, phaseHistory: [], progress: {}, ...extra,
});

test("splitJobs puts in-process jobs first in Active, queued by priority, and finished jobs in History", () => {
  const groups = downloads.splitJobs([
    job("p", "paused"), job("f", "failed"), job("d", "downloading"), job("r", "retrying"), job("ok", "ready", { finishedAt: "2026-10-01T00:00:00Z" }),
    job("q2", "queued", { priority: "low", queueOrder: 1 }), job("q1", "waiting", { priority: "high", queueOrder: 9 }), job("old", "cancelled", { finishedAt: "2026-09-01T00:00:00Z" }),
    { id: "", state: "queued" }, null,
  ]);
  assert.deepEqual(groups.active.map((item) => item.id), ["d", "r", "p", "f"]);
  assert.deepEqual(groups.queued.map((item) => item.id), ["q1", "q2"]);
  assert.deepEqual(groups.finished.map((item) => item.id), ["ok", "old"]);
});

test("phaseSteps marks done, active, error and skipped; every real job state maps to a phase", () => {
  const { JOB_STATES } = require("../../../manager-core/model-hub/queue.js");
  const states = (item) => downloads.phaseSteps(item).map((step) => `${step.id}:${step.state}`).join(" ");
  assert.equal(states(job("a", "downloading")), "queued:done resolving:done downloading:active materializing:pending verifying:pending ready:pending");
  assert.equal(states(job("a", "ready")), "queued:done resolving:done downloading:done materializing:done verifying:done ready:done");
  assert.equal(states(job("a", "failed", { phaseHistory: [{ phase: "queued" }, { phase: "resolving" }, { phase: "downloading" }, { phase: "failed" }] })), "queued:done resolving:done downloading:error materializing:pending verifying:pending ready:pending");
  assert.equal(states(job("a", "cancelled", { phaseHistory: [{ phase: "queued" }, { phase: "resolving" }] })), "queued:done resolving:skipped downloading:pending materializing:pending verifying:pending ready:pending");
  assert.equal(states(job("a", "paused", { phaseHistory: [{ phase: "downloading" }] })), "queued:done resolving:done downloading:active materializing:pending verifying:pending ready:pending");
  for (const state of JOB_STATES) {
    const steps = downloads.phaseSteps(job("a", state));
    assert.equal(steps.length, 6, state);
    assert.ok(steps.some((step) => step.state === "active" || step.state === "done" || step.state === "error" || step.state === "skipped"), state);
    const line = downloads.stateLine(job("a", state, { waitReason: "disk" }));
    assert.ok(Object.hasOwn(catalog, line.key), `${state} -> ${line.key}`);
  }
  for (const phase of downloads.PHASES) assert.ok(Object.hasOwn(catalog, `hub.phase.${phase}`), phase);
});

test("stateLine says what a waiting, retrying and verifying job is doing", () => {
  assert.deepEqual(downloads.stateLine(job("a", "waiting", { waitReason: "runtime-busy" })), { key: "hub.wait.runtime-busy" });
  assert.deepEqual(downloads.stateLine(job("a", "waiting", { waitReason: "nonsense" })), { key: "hub.wait.concurrency" });
  const retrying = downloads.stateLine(job("a", "retrying", { retry: { count: 2, max: 3, nextAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 30)).toISOString() } }), Date.UTC(2026, 9, 1, 0, 0, 0));
  assert.deepEqual(retrying, { key: "hub.state.retrying", vars: { seconds: 30, n: 2, max: 3 } });
  assert.deepEqual(downloads.stateLine(job("a", "verifying", { progress: { verify: { filesDone: 1, filesTotal: 4 } } })), { key: "hub.state.verifying", vars: { done: 1, total: 4 } });
});

test("failureView renders the hub's classified error and always offers Retry on a failed job", () => {
  const failed = job("a", "failed", {
    error: { code: "hf_login_required", baseCode: "hf_auth_invalid", class: "auth", retryable: false, title: { zh: "需要登录", en: "Sign-in required" }, hint: { zh: "点击登录", en: "Click Sign in" }, actions: ["sign-in"], detail: "401 <redacted>" },
    retry: { count: 1, max: 3 },
  });
  const view = downloads.failureView(failed, pick);
  assert.equal(view.title, "Sign-in required");
  assert.equal(view.hint, "Click Sign in");
  assert.equal(view.code, "hf_login_required");
  assert.deepEqual(view.actions, ["sign-in", "retry"]);
  assert.equal(view.retryable, false);
  assert.equal(view.detail, "401 <redacted>");
  const bare = downloads.failureView(job("b", "failed"), pick);
  assert.equal(bare.title, "");
  assert.deepEqual(bare.actions, ["retry"]);
  assert.equal(downloads.failureView(job("c", "downloading"), pick), null);
  assert.deepEqual(downloads.failureView(job("d", "failed", { error: { code: "stall", actions: ["resume", "switch-source", "retry"] } }), pick).actions, ["resume", "switch-source", "retry"]);
});

test("switching source is in place for a running job, a new plan for a finished one", () => {
  assert.equal(downloads.switchTarget(job("a", "failed", { transfer: { options: { source: "hf-mirror" } } })), "huggingface");
  assert.equal(downloads.switchTarget(job("a", "failed", { transfer: { options: { source: "huggingface" } } })), "hf-mirror");
  assert.equal(downloads.switchTarget({ ...job("a", "failed"), artifact: { provider: "modelscope", repo: "o/m" } }), "");
  assert.equal(downloads.canResumeInPlace(job("a", "retrying")), true);
  assert.equal(downloads.canResumeInPlace(job("a", "failed")), false);
  assert.equal(downloads.approvalUrl(job("a", "failed")), "https://huggingface.co/o/a");
  assert.equal(downloads.approvalUrl({ id: "x" }), "");
});

test("reclaimableBytes prefers the bytes on disk; reorder helpers keep ids unique", () => {
  assert.equal(downloads.reclaimableBytes(job("a", "paused", { progress: { bytesDone: 300 } }), { onDiskBytes: 450 }), 450);
  assert.equal(downloads.reclaimableBytes(job("a", "paused", { progress: { bytesDone: 300 } }), null), 300);
  assert.equal(downloads.reclaimableBytes(job("a", "paused"), null), 0);
  const ids = ["a", "b", "c"];
  assert.deepEqual(downloads.moveId(ids, 2, 0), ["c", "a", "b"]);
  assert.deepEqual(downloads.moveId(ids, 0, 1), ["b", "a", "c"]);
  assert.equal(downloads.moveId(ids, 0, 0), ids);
  assert.equal(downloads.moveId(ids, 0, 5), ids);
  assert.deepEqual(downloads.applyOrder([{ id: "a" }, { id: "b" }, { id: "c" }], ["c", "a"]).map((item) => item.id), ["c", "a", "b"]);
  assert.deepEqual(downloads.applyOrder([{ id: "a" }], []).map((item) => item.id), ["a"]);
});

test("the sparkline keeps 60 samples and scales to the highest", () => {
  let samples = [];
  for (let index = 0; index < 75; index += 1) samples = downloads.pushSample(samples, index);
  assert.equal(samples.length, downloads.SPARK_SAMPLES);
  assert.equal(samples[0], 15);
  assert.equal(downloads.sparkPoints([], 100, 20), "");
  const points = downloads.sparkPoints([0, 50, 100], 100, 21).split(" ");
  assert.equal(points.length, 3);
  assert.equal(points[0], "0.0,20.0");
  assert.equal(points[2], "100.0,1.0");
  assert.equal(downloads.pushSample([], -5)[0], 0);
});

test("historyRows merges the live finished jobs with the compacted records, searches and sorts newest first", () => {
  const finished = [job("a", "ready", { finishedAt: "2026-10-02T00:00:00Z" })];
  const records = [job("a", "ready", { finishedAt: "2026-01-01T00:00:00Z" }), job("b", "failed", { finishedAt: "2026-10-03T00:00:00Z" }), job("c", "cancelled", { finishedAt: "2026-09-01T00:00:00Z" })];
  assert.deepEqual(downloads.historyRows(finished, records).map((item) => item.id), ["b", "a", "c"]);
  assert.equal(downloads.historyRows(finished, records)[1].finishedAt, "2026-10-02T00:00:00Z", "an id in both keeps the live job");
  assert.deepEqual(downloads.historyRows(finished, records, "O/B").map((item) => item.id), ["b"]);
  assert.deepEqual(downloads.historyRows(null, undefined), []);
});

test("the settings form maps the hub settings both ways and patches only what changed", () => {
  const settings = {
    sources: { policy: "huggingface", mirrorEndpoint: "https://hf-mirror.com", gatedUsesOfficial: true },
    transfer: { xet: "high-performance", maxConcurrent: 1 }, verify: { sha256: true }, queue: { idleOnly: false },
    retry: { maxAttempts: 3, perClass: { network: true, server: true, watchdog: true, integrity: true, tooling: "once" } },
    notifications: { onReady: true, onFailure: true },
  };
  const form = downloads.settingsForm(settings);
  assert.equal(form["retry.perClass.tooling"], "once");
  assert.equal(form["retry.perClass.network"], "on");
  assert.equal(form["transfer.maxConcurrent"], "1");
  assert.deepEqual(downloads.settingsPatch(settings, form), {});
  const patch = downloads.settingsPatch(settings, { ...form, "retry.perClass.network": "off", "retry.perClass.tooling": "on", "transfer.maxConcurrent": "3", "queue.idleOnly": true, "sources.policy": "auto" });
  assert.deepEqual(patch, { retry: { perClass: { network: false, tooling: true } }, transfer: { maxConcurrent: 3 }, queue: { idleOnly: true }, sources: { policy: "auto" } });
  for (const field of downloads.SETTINGS_FIELDS) {
    assert.ok(Object.hasOwn(catalog, `hub.settings.${field.path}`), field.path);
    for (const option of field.options || []) assert.ok(Object.hasOwn(catalog, `hub.settings.opt.${option}`), `${field.path}:${option}`);
  }
});
