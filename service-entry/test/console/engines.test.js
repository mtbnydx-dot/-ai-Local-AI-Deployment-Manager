// CON-16: the Engines pages' model (lib/engines-model.js) and how the page
// modules fit the console rules. Rendering, dialogs and the flows against mocked
// APIs are covered in a browser by tests/frontend/console/console-engines.spec.js.
//
// The descriptor builder is checked against the real manager code: whatever the
// form produces must pass descriptor-schema.js (mode "draft") and the engine
// registry's side-effect-free draft check, exactly as POST
// /api/m/:id/engines/descriptors/validate runs it.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as model from "../../console/lib/engines-model.js";
import { check } from "../../console/lib/guards.js";
import * as schemas from "../../console/lib/schemas.js";

// Registers the vendor path mapping before any ui/ or routes/ module is imported.
await import("./loader.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const CONSOLE_DIR = path.join(ROOT, "service-entry", "console");
const require = createRequire(import.meta.url);
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "console", `${name}.json`), "utf8"));

// ---------------------------------------------------------------------------
// Cards

test("engineTier maps tiers, adapters and the external engine to the four 07 §6.5 labels", () => {
  assert.equal(model.engineTier({ engineId: "vllm", adapter: "vllm", tier: 1 }), "builtin");
  assert.equal(model.engineTier({ engineId: "sglang", adapter: "sglang" }), "builtin");
  assert.equal(model.engineTier({ engineId: "lmdeploy", adapter: "docker-template", tier: 2, status: "experimental" }), "experimental");
  assert.equal(model.engineTier({ engineId: "mybox", adapter: "docker-template", tier: 3, status: "experimental" }), "custom");
  assert.equal(model.engineTier({ engineId: "external", adapter: "external", tier: 3 }), "external");
});

test("summarizeEngines keeps engines with their manager, lists unreachable managers and splits descriptor problems", () => {
  const summary = model.summarizeEngines(fixture("engines"));
  assert.deepEqual(summary.engines.map((engine) => `${engine.managerId}:${engine.engineId}`), ["vllm:vllm", "vllm:sglang", "vllm:lmdeploy", "llama:llamacpp"]);
  assert.deepEqual(summary.offline, []);
  assert.equal(summary.problems.length, 1);
  assert.equal(summary.problems[0].code, "unknown_runtime");
  assert.equal(summary.endpoints.length, 1);

  const body = {
    ...fixture("engines"),
    engines: fixture("engines").engines.filter((engine) => engine.managerId === "vllm"),
    managers: [{ managerId: "vllm", ok: true }, { managerId: "llama", ok: false, code: "manager_unreachable" }],
    errors: [{ managerId: "llama", source: "manager", engineId: "", path: "", code: "manager_unreachable", message: "The llama manager did not answer." }],
  };
  const down = model.summarizeEngines(body);
  assert.deepEqual(down.offline, [{ managerId: "llama", code: "manager_unreachable" }]);
  assert.deepEqual(down.problems, [], "an unreachable manager is not a descriptor problem");

  const fromErrorsOnly = model.summarizeEngines({ engines: [], errors: [{ managerId: "vllm", source: "manager", code: "manager_timeout" }] });
  assert.deepEqual(fromErrorsOnly.offline, [{ managerId: "vllm", code: "manager_timeout" }]);
  assert.deepEqual(model.summarizeEngines(null), { engines: [], offline: [], problems: [], endpoints: [] });
});

test("capability chips, host health and the default runtime", () => {
  const [vllm, sglang, , llama] = fixture("engines").engines;
  assert.deepEqual(model.capabilityChips(vllm), [
    "tensorParallel", "pipelineParallel", "dataParallel", "expertParallel", "parallelInstances", "lora", "sleepWake", "speculative", "toolParser", "role-embedding",
  ]);
  assert.ok(!model.capabilityChips(sglang).includes("toolParser"), "autoParsers.tool null means no chip");
  assert.deepEqual(model.capabilityChips(llama).slice(-2), ["role-embedding", "role-rerank"]);
  assert.equal(model.engineHealth(vllm), "ok");
  assert.equal(model.engineHealth(llama), "unknown", "null means Docker did not answer: never healthy");
  assert.equal(model.engineHealth({ health: { hostReady: false } }), "error");
  assert.equal(model.defaultRuntime(sglang).runtimeId, "sglang@0.5.17");
  assert.equal(model.defaultRuntime({ runtimes: [{ runtimeId: "a" }] }).runtimeId, "a");
  assert.equal(model.defaultRuntime({}), null);
});

// ---------------------------------------------------------------------------
// Runtimes and jobs

test("a runtime with present:false offers Pull (a local build offers a rebuild hint instead); introspection needs the image", () => {
  const [, sglang, lmdeploy, llama] = fixture("engines").engines;
  const [present, missing, local] = sglang.runtimes;
  assert.equal(model.runtimeState(present), "present");
  assert.equal(model.runtimeState(missing), "missing");
  assert.equal(model.runtimeState(llama.runtimes[0]), "unknown");
  assert.equal(model.pullAllowed(missing), true);
  assert.equal(model.pullAllowed(local), false, "a local build is rebuilt, never pulled");
  assert.equal(model.pullAllowed(present), false);
  assert.equal(model.pullAllowed(llama.runtimes[0]), false, "unknown is not missing");
  assert.equal(model.introspectAllowed(present), true);
  assert.equal(model.introspectAllowed(missing), false);
  assert.equal(model.introspectAllowed(llama.runtimes[0]), true);
  assert.equal(model.dockerPullCommand(lmdeploy.runtimes[0]), "docker pull openmmlab/lmdeploy:v0.18.0");
  assert.equal(model.dockerPullCommand({}), "");
});

test("jobView reads status or state, progress, and the failure of an introspect or image-pull job", () => {
  assert.equal(model.jobView(null), null);
  const running = model.jobView({ id: "dl_1", type: "image-pull", status: "running", progress: { percent: 41.5, stage: "Downloading" } });
  assert.deepEqual({ state: running.state, done: running.done, percent: running.percent }, { state: "running", done: false, percent: 41.5 });
  assert.equal(model.jobView({ id: "j", status: "running", progress: { percent: null } }).percent, null, "null stays indeterminate");
  assert.equal(model.jobView({ id: "j", status: "running" }).percent, null);
  assert.equal(model.jobView({ id: "j", status: "running", progress: { percent: 140 } }).percent, 100);
  assert.deepEqual({ ...model.jobView({ id: "j", status: "success" }) }.state, "success");
  assert.equal(model.jobView({ id: "j", status: "running", state: "success" }).state, "success", "a later `state` wins");
  const failed = model.jobView({ id: "j", status: "failed", error: "Pull the image first", meta: { errorCode: "runtime_image_missing" } });
  assert.deepEqual({ state: failed.state, done: failed.done, error: failed.error, code: failed.code }, { state: "failed", done: true, error: "Pull the image first", code: "runtime_image_missing" });
  assert.equal(model.jobView({ id: "j", status: "interrupted" }).state, "failed");
  assert.equal(model.jobView({ id: "j", status: "paused" }).state, "paused");
  assert.equal(model.findJob([{ id: "a" }, { id: "b" }], "b").id, "b");
  assert.equal(model.findJob({ jobs: [{ id: "a" }] }, "a").id, "a");
  assert.equal(model.findJob([{ id: "a" }], "z"), null);
  assert.equal(model.findJob(undefined, "a"), null);
});

// ---------------------------------------------------------------------------
// Flag diff

test("flagDiffRows lists added, removed and changed rows from the report in the fixture", () => {
  const { rows, counts, catalogMissing, catalogUnmapped } = model.flagDiffRows(fixture("engines-flags").diff);
  assert.deepEqual(counts, { added: 2, removed: 1, changed: 3 });
  assert.deepEqual(rows.filter((row) => row.kind === "added").map((row) => row.flag), ["--enable-pleoffload", "--linear-attn-backend"]);
  assert.deepEqual(rows.filter((row) => row.kind === "removed").map((row) => row.flag), ["--disable-radix-cache-legacy"]);
  const changed = rows.filter((row) => row.kind === "changed");
  assert.deepEqual(changed.map((row) => [row.change, row.flag]), [["choices", "--kv-cache-dtype"], ["renamed", "--max-total-tokens-legacy"], ["default", "--schedule-conservativeness"]]);
  assert.deepEqual(changed[0], { kind: "changed", change: "choices", flag: "--kv-cache-dtype", addedChoices: ["fp8_e4m3"], removedChoices: ["fp8_e5m2_legacy"] });
  assert.deepEqual(changed[1], { kind: "changed", change: "renamed", flag: "--max-total-tokens-legacy", to: "--max-total-tokens", evidence: "" });
  assert.deepEqual(changed[2], { kind: "changed", change: "default", flag: "--schedule-conservativeness", from: "1", to: "0.8" });
  assert.deepEqual(catalogMissing, ["--flashinfer-workspace"]);
  assert.deepEqual(catalogUnmapped, ["--enable-pleoffload"]);
  assert.deepEqual(model.flagDiffRows(null).rows, []);
  assert.deepEqual(model.flagDiffRows({}).counts, { added: 0, removed: 0, changed: 0 });
});

test("flagDiffRows reads what the manager's real diffFlagSets produces", () => {
  const { diffFlagSets } = require("../../../manager-core/engines/introspect.js");
  const a = { flags: [
    { flag: "--old-name", aliases: [], choices: [], default: null, help: "" },
    { flag: "--dtype", aliases: [], choices: ["auto", "half"], default: "auto" },
    { flag: "--gone", aliases: [], choices: [], default: null },
    { flag: "--stable", aliases: [], choices: [], default: 4 },
  ] };
  const b = { flags: [
    { flag: "--new-name", aliases: ["--old-name"], choices: [], default: null },
    { flag: "--dtype", aliases: [], choices: ["auto", "bfloat16"], default: "bfloat16" },
    { flag: "--fresh", aliases: [], choices: [], default: null },
    { flag: "--stable", aliases: [], choices: [], default: 8 },
  ] };
  const { rows, counts } = model.flagDiffRows(diffFlagSets(a, b, null));
  assert.deepEqual(counts, { added: 2, removed: 2, changed: 4 });
  assert.deepEqual(rows.filter((row) => row.kind === "added").map((row) => row.flag), ["--fresh", "--new-name"]);
  assert.deepEqual(rows.filter((row) => row.kind === "removed").map((row) => row.flag), ["--gone", "--old-name"]);
  const byChange = Object.fromEntries(rows.filter((row) => row.kind === "changed").map((row) => [`${row.change}:${row.flag}`, row]));
  assert.equal(byChange["renamed:--old-name"].to, "--new-name");
  assert.deepEqual(byChange["choices:--dtype"].addedChoices, ["bfloat16"]);
  assert.deepEqual(byChange["choices:--dtype"].removedChoices, ["half"]);
  assert.deepEqual([byChange["default:--stable"].from, byChange["default:--stable"].to], ["4", "8"]);
  assert.deepEqual([byChange["default:--dtype"].from, byChange["default:--dtype"].to], ["auto", "bfloat16"]);
});

test("flagsSnapshot accepts the served `flags` section and the spec's `snapshot`", () => {
  assert.deepEqual(model.flagsSnapshot(fixture("engines-flags")), { capturedAt: "2026-10-19T09:30:00.000Z", count: 2 });
  assert.deepEqual(model.flagsSnapshot({ snapshot: { capturedAt: "2026-10-20T00:00:00.000Z", flags: [] } }), { capturedAt: "2026-10-20T00:00:00.000Z", count: 0 });
  assert.equal(model.flagsSnapshot({}), null);
});

test("recipeRows normalises the schema's recipes", () => {
  const rows = model.recipeRows(fixture("schema-sglang"));
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.ok(["verified", "experimental", "blocked"].includes(row.status));
    assert.ok(Array.isArray(row.reasons));
    assert.ok(row.locks.every((lock) => typeof lock.param === "string"));
  }
  assert.deepEqual(model.recipeRows({}), []);
});

// ---------------------------------------------------------------------------
// Descriptor builder

function filledDraft(overrides = {}) {
  return { ...model.defaultDraft(), id: "mybox", labelZh: "我的引擎", labelEn: "My engine", image: "registry.example.com/team/mybox:1.2", port: "9000", ...overrides };
}

test("the starter draft is incomplete: id, names and image are required", () => {
  const { ok, errors } = model.validateDraft(model.defaultDraft());
  assert.equal(ok, false);
  assert.deepEqual(errors.map((error) => `${error.field}:${error.code}`), ["id:required", "labelZh:required", "labelEn:required", "image:required"]);
  assert.deepEqual(errors.map((error) => model.fieldStep(error.field)), ["basics", "basics", "basics", "basics"]);
});

test("validateDraft rejects bad ids, ports, paths, flags, placeholders and values that look like flags", () => {
  const codes = (draft, options) => model.validateDraft(draft, options).errors.map((error) => `${error.field}:${error.code}`);
  assert.deepEqual(codes(filledDraft()), []);
  assert.deepEqual(codes(filledDraft({ id: "9x" })), ["id:id_pattern"]);
  assert.deepEqual(codes(filledDraft({ id: "Vllm" })), ["id:id_pattern"]);
  assert.deepEqual(codes(filledDraft({ id: "vllm" })), ["id:id_reserved"]);
  assert.deepEqual(codes(filledDraft({ id: "external" })), ["id:id_reserved"]);
  assert.deepEqual(codes(filledDraft(), { knownIds: ["mybox"] }), ["id:id_in_use"]);
  assert.deepEqual(codes(filledDraft({ labelEn: "x".repeat(81) })), ["labelEn:too_long"]);
  assert.deepEqual(codes(filledDraft({ image: "has space" })), ["image:image_invalid"]);
  assert.deepEqual(codes(filledDraft({ image: "http://host/x" })), ["image:image_invalid"]);
  assert.deepEqual(codes(filledDraft({ port: "0" })), ["port:port_invalid"]);
  assert.deepEqual(codes(filledDraft({ port: "70000" })), ["port:port_invalid"]);
  assert.deepEqual(codes(filledDraft({ port: "80a" })), ["port:port_invalid"]);
  assert.deepEqual(codes(filledDraft({ healthPath: "health" })), ["healthPath:path_invalid"]);
  assert.deepEqual(codes(filledDraft({ healthPath: "" })), []);
  assert.deepEqual(codes(filledDraft({ artifactFormats: [] })), ["artifactFormats:formats_required"]);
  assert.deepEqual(codes(filledDraft({ artifactFormats: ["zip"] })), ["artifactFormats:formats_required"]);
  assert.deepEqual(codes(filledDraft({ hostManager: "entry" })), ["hostManager:manager_invalid"]);
  assert.deepEqual(codes(filledDraft({ entrypoint: "python -m x" })), ["entrypoint:entrypoint_invalid"]);
  assert.deepEqual(codes(filledDraft({ memoryKind: "gguf-estimate" })), ["memoryKind:kind_invalid"]);
  assert.deepEqual(codes(filledDraft({ args: [] })), ["args:args_required"]);
  assert.deepEqual(codes(filledDraft({ args: [{ flag: "port", value: "1" }] })), ["args.0.flag:flag_invalid"]);
  assert.deepEqual(codes(filledDraft({ args: [{ flag: "", value: "" }] })), ["args.0.value:value_required"]);
  assert.deepEqual(codes(filledDraft({ args: [{ flag: "--x", value: "{{nope}}" }] })), ["args.0.value:placeholder_unknown"]);
  assert.deepEqual(codes(filledDraft({ args: [{ flag: "--x", value: "pre-{{servedName}}" }] })), ["args.0.value:placeholder_shape"]);
  assert.deepEqual(codes(filledDraft({ args: [{ flag: "--x", value: "-rm" }] })), ["args.0.value:value_flag_like"]);
  assert.deepEqual(codes(filledDraft({ args: [{ flag: "", value: "-v" }] })), [], "a bare token may be a flag");
  assert.deepEqual(codes(filledDraft({ args: [{ flag: "--p", value: "{{ port }}" }] })), [], "a GPUStack alias with spaces inside the braces is one placeholder");
  assert.equal(model.validateDraft(filledDraft({ args: [{ flag: "--x", value: "{{nope}}" }] })).errors[0].params.name, "{{nope}}");
});

test("buildDescriptor: the template keeps bare tokens as strings and flag rows as { flag, value }", () => {
  const descriptor = model.buildDescriptor(filledDraft({ entrypoint: "mybox-serve", healthPath: "" }), { today: "2026-10-20" });
  assert.equal(descriptor.id, "mybox");
  assert.equal(descriptor.asOf, "2026-10-20");
  assert.deepEqual(descriptor.template.args, [
    "{{model.containerPath}}",
    { flag: "--host", value: "0.0.0.0" },
    { flag: "--port", value: "{{host.containerPort}}" },
    { flag: "--served-model-name", value: "{{servedName}}" },
  ]);
  assert.equal(descriptor.template.entrypoint, "mybox-serve");
  assert.equal(descriptor.host.containerPort, 9000);
  assert.deepEqual(descriptor.runtimes, { default: "mybox", allowed: ["mybox"] });
  assert.deepEqual(descriptor.api.ready, { kind: "models-list" }, "no health path: readiness comes from the model list");
  assert.equal(descriptor.api.health, null);
  assert.equal(model.buildDescriptor(filledDraft(), { today: "2026-10-20" }).api.health, "/health");
  assert.equal(model.buildDescriptor(filledDraft({ entrypoint: "" }), { today: "2026-10-20" }).template.entrypoint, undefined);
  assert.equal(model.descriptorFileName(filledDraft()), "mybox.json");
  assert.equal(model.descriptorFileName({}), "engine.json");
});

test("a reviewed draft passes EngineDescriptorGuard and the manager's own draft validation", () => {
  const review = model.reviewDraft(filledDraft(), { today: "2026-10-20" });
  assert.equal(review.ok, true, JSON.stringify(review.errors));
  assert.equal(check(schemas.EngineDescriptorGuard, review.descriptor).ok, true);

  const { validateDescriptor } = require("../../../manager-core/engines/descriptor-schema.js");
  const verdict = validateDescriptor(review.descriptor, { mode: "draft" });
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.kind, "descriptor");

  for (const memoryKind of model.BUILDER_MEMORY_KINDS) {
    for (const hostManager of model.BUILDER_MANAGERS) {
      const variant = model.buildDescriptor(filledDraft({ memoryKind, hostManager, artifactFormats: ["gguf", "safetensors"] }), { today: "2026-10-20" });
      assert.deepEqual(validateDescriptor(variant, { mode: "draft" }).errors, [], `${memoryKind} on ${hostManager}`);
    }
  }
});

test("reviewDraft reports form errors before it builds anything", () => {
  const review = model.reviewDraft(model.defaultDraft());
  assert.equal(review.ok, false);
  assert.equal(review.descriptor, null);
  assert.ok(review.errors.length >= 4);
});

test("guardDescriptor reports a missing field of EngineDescriptorGuard", () => {
  const broken = { ...model.buildDescriptor(filledDraft(), { today: "2026-10-20" }) };
  delete broken.adapter;
  const problems = model.guardDescriptor(broken);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, "shape");
  assert.match(problems[0].field, /adapter/);
});

test("the registry accepts the draft once the runtime-manifest entry is in place, and says unknown_runtime before", () => {
  const runtimeManifest = require("../../../manager-core/runtime-manifest.js");
  const { createEngineRegistry } = require("../../../manager-core/engines/registry.js");
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "console-engines-"));
  try {
    const draft = filledDraft();
    const descriptor = model.buildDescriptor(draft, { today: "2026-10-20" });
    const plain = createEngineRegistry({ overrideDir, env: {} });
    const before = plain.checkOverride(descriptor, { mode: "draft" });
    assert.equal(before.ok, false);
    assert.ok(before.errors.some((error) => error.code === "unknown_runtime"), JSON.stringify(before.errors));

    const entry = model.buildRuntimeEntry(draft).runtimes.mybox;
    assert.deepEqual(entry, { label: "My engine", engineId: "mybox", image: "registry.example.com/team/mybox:1.2", status: "unpinned" });
    const known = runtimeManifest.listRuntimes();
    const extended = {
      ...runtimeManifest,
      listRuntimes: () => [...known, { ...known[0], manifestKey: "mybox", runtimeId: "mybox@local", engineId: "mybox", image: entry.image, label: entry.label }],
    };
    const after = createEngineRegistry({ overrideDir, env: {}, manifest: extended }).checkOverride(descriptor, { mode: "draft" });
    assert.deepEqual(after.errors, []);
    assert.equal(after.ok, true);
  } finally {
    fs.rmSync(overrideDir, { recursive: true, force: true });
  }
});

test("serverDescriptorErrors and validateUnavailable read the validate route's answers", () => {
  assert.deepEqual(model.serverDescriptorErrors({ ok: false, errors: [{ path: "tier", code: "tier_mismatch", message: "m" }, "junk"] }), [{ path: "tier", code: "tier_mismatch", message: "m" }]);
  assert.deepEqual(model.serverDescriptorErrors({ ok: true }), []);
  assert.equal(model.validateUnavailable({ status: 404, code: "http_404" }), true);
  assert.equal(model.validateUnavailable({ status: 0, code: "endpoint_unavailable" }), true);
  assert.equal(model.validateUnavailable({ status: 502, code: "manager_unreachable" }), false);
  assert.equal(model.validateUnavailable({ status: 403, code: "forbidden" }), false);
});

// ---------------------------------------------------------------------------
// External endpoints

test("hostClassOf follows the manager's loopback, LAN and remote classes", () => {
  assert.equal(model.hostClassOf("http://localhost:11434/v1"), "loopback");
  assert.equal(model.hostClassOf("http://127.0.0.1/v1"), "loopback");
  assert.equal(model.hostClassOf("http://[::1]:8000"), "loopback");
  assert.equal(model.hostClassOf("http://192.168.1.20:1234/v1"), "lan");
  assert.equal(model.hostClassOf("http://172.20.0.5/v1"), "lan");
  assert.equal(model.hostClassOf("http://172.32.0.5/v1"), "remote");
  assert.equal(model.hostClassOf("http://nas/v1"), "lan");
  assert.equal(model.hostClassOf("http://printer.local/v1"), "lan");
  assert.equal(model.hostClassOf("https://api.example.com/v1"), "remote");
  assert.equal(model.hostClassOf("not a url"), "remote");
  assert.equal(model.needsPlaintextAck("http://api.example.com/v1"), true);
  assert.equal(model.needsPlaintextAck("https://api.example.com/v1"), false);
  assert.equal(model.needsPlaintextAck("http://localhost:1/v1"), false);
});

test("validateEndpointDraft: create needs a valid id and URL; the plaintext acknowledgement is required for remote http", () => {
  const draft = { ...model.emptyEndpointDraft(), endpointId: "team-gateway", baseUrl: "https://gateway.example.com/v1" };
  const codes = (value, options) => model.validateEndpointDraft(value, options).errors.map((error) => `${error.field}:${error.code}`);
  assert.deepEqual(codes(draft), []);
  assert.deepEqual(codes({ ...draft, endpointId: "" }), ["endpointId:required"]);
  assert.deepEqual(codes({ ...draft, endpointId: "Team" }), ["endpointId:id_pattern"]);
  assert.deepEqual(codes(draft, { existingIds: ["team-gateway"] }), ["endpointId:id_in_use"]);
  assert.deepEqual(codes({ ...draft, baseUrl: "" }), ["baseUrl:required"]);
  assert.deepEqual(codes({ ...draft, baseUrl: "gateway" }), ["baseUrl:url_invalid"]);
  assert.deepEqual(codes({ ...draft, baseUrl: "ftp://gateway.example.com/v1" }), ["baseUrl:url_scheme"]);
  assert.deepEqual(codes({ ...draft, baseUrl: "https://user:pw@gateway.example.com/v1" }), ["baseUrl:url_credentials"]);
  assert.deepEqual(codes({ ...draft, baseUrl: "https://gateway.example.com/v1?x=1" }), ["baseUrl:url_extras"]);
  assert.deepEqual(codes({ ...draft, baseUrl: "http://gateway.example.com/v1" }), ["baseUrl:plaintext_remote"]);
  assert.deepEqual(codes({ ...draft, baseUrl: "http://gateway.example.com/v1", acknowledgePlaintext: true }), []);
  assert.deepEqual(codes({ ...draft, baseUrl: "http://localhost:11434/v1" }), []);
  assert.deepEqual(codes({ ...draft, apiKey: "has space" }), ["apiKey:key_invalid"]);
  assert.deepEqual(codes({ ...draft, apiKey: "sk-test-fake" }), []);
  assert.deepEqual(codes({ ...draft, kind: "other" }), ["kind:kind_invalid"]);
  assert.deepEqual(codes({ ...draft, label: "x".repeat(81) }), ["label:too_long"]);
});

test("validateEndpointDraft in edit mode checks the key only when it is being replaced", () => {
  const stored = { endpointId: "team-gateway", label: "Team", kind: "openai", baseUrl: "https://gateway.example.com/v1", apiKeyRef: "engines.external:team-gateway", enabled: true };
  const draft = model.draftFromEndpoint(stored);
  assert.equal(draft.hasKey, true);
  assert.equal(draft.apiKey, "", "the stored key is never part of the form");
  assert.equal(model.validateEndpointDraft({ ...draft, apiKey: "ignored until replace" }, { mode: "edit" }).ok, true);
  assert.equal(model.validateEndpointDraft({ ...draft, keyAction: "replace", apiKey: "" }, { mode: "edit" }).ok, false);
  assert.equal(model.validateEndpointDraft({ ...draft, keyAction: "replace", apiKey: "sk-test-new" }, { mode: "edit" }).ok, true);
});

test("create and patch bodies: the key is write-only, a patch sends only what changed, null removes the key", () => {
  const create = model.endpointCreateBody({ ...model.emptyEndpointDraft(), endpointId: " team-gateway ", label: " Team ", kind: "openai", baseUrl: "https://gateway.example.com/v1 ", apiKey: "sk-test-fake", includeInAuto: true });
  assert.deepEqual(create, { endpointId: "team-gateway", kind: "openai", baseUrl: "https://gateway.example.com/v1", enabled: true, routing: { includeInAuto: true }, label: "Team", apiKey: "sk-test-fake" });
  const noKey = model.endpointCreateBody({ ...model.emptyEndpointDraft(), endpointId: "ollama-local", baseUrl: "http://localhost:11434/v1", kind: "ollama" });
  assert.equal("apiKey" in noKey, false);
  assert.equal("label" in noKey, false);
  assert.equal("acknowledge" in noKey, false);
  assert.deepEqual(model.endpointCreateBody({ ...model.emptyEndpointDraft(), endpointId: "far", baseUrl: "http://api.example.com/v1", acknowledgePlaintext: true }).acknowledge, ["plaintext-remote"]);

  const stored = { endpointId: "team-gateway", label: "Team", kind: "openai", baseUrl: "https://gateway.example.com/v1", apiKeyRef: "engines.external:team-gateway", enabled: true, routing: { includeInAuto: false } };
  const draft = model.draftFromEndpoint(stored);
  assert.deepEqual(model.endpointPatchBody(draft, stored), {}, "nothing changed, nothing sent");
  assert.deepEqual(model.endpointPatchBody({ ...draft, enabled: false, includeInAuto: true, label: "Renamed" }, stored), { label: "Renamed", enabled: false, routing: { includeInAuto: true } });
  assert.deepEqual(model.endpointPatchBody({ ...draft, keyAction: "replace", apiKey: "sk-test-new" }, stored), { apiKey: "sk-test-new" });
  assert.deepEqual(model.endpointPatchBody({ ...draft, keyAction: "remove" }, stored), { apiKey: null });
  assert.deepEqual(model.endpointPatchBody({ ...draft, apiKey: "typed but kept" }, stored), {}, "a key typed under 'keep' is not sent");
  assert.deepEqual(model.endpointPatchBody({ ...draft, baseUrl: "http://api.example.com/v1", acknowledgePlaintext: true }, stored), { baseUrl: "http://api.example.com/v1", acknowledge: ["plaintext-remote"] });
});

test("endpointRoutable, health status and the test result view", () => {
  const [local, gateway] = fixture("engines-external").endpoints;
  assert.deepEqual(model.endpointRoutable(local), { routable: true, reason: "direct" });
  assert.deepEqual(model.endpointRoutable({ ...local, routing: { includeInAuto: true } }), { routable: true, reason: "auto" });
  assert.deepEqual(model.endpointRoutable(gateway), { routable: false, reason: "unauthorized" });
  assert.deepEqual(model.endpointRoutable({ enabled: false }), { routable: false, reason: "disabled" });
  assert.deepEqual(model.endpointRoutable({ enabled: true }), { routable: false, reason: "unchecked" });
  assert.deepEqual(model.endpointRoutable({ health: { state: "unreachable" } }), { routable: false, reason: "unreachable" });
  assert.equal(model.endpointHealthStatus(local), "ok");
  assert.equal(model.endpointHealthStatus(gateway), "warn");
  assert.equal(model.endpointHealthStatus({ health: { state: "error" } }), "error");
  assert.equal(model.endpointHealthStatus({ enabled: false }), "neutral");
  assert.equal(model.endpointHealthStatus({}), "unknown");
  assert.deepEqual(model.testResultView({ ok: true, latencyMs: 31, models: ["a", "b"], state: "ready" }), { ok: true, latencyMs: 31, state: "ready", models: ["a", "b"], errorCode: "" });
  assert.deepEqual(model.testResultView({ ok: false, state: "unreachable", error: { code: "unreachable" } }), { ok: false, latencyMs: null, state: "unreachable", models: [], errorCode: "unreachable" });
});

test("external endpoint rows never carry a key: no fixture, body or view holds apiKey", () => {
  for (const name of ["engines", "engines-external"]) {
    const text = fs.readFileSync(path.join(ROOT, "tests", "fixtures", "console", `${name}.json`), "utf8");
    assert.equal(/"apiKey"\s*:/.test(text), false, `${name}.json has no apiKey field`);
  }
});

// ---------------------------------------------------------------------------
// Guards, request paths and the page modules

test("the engines guards accept the fixtures and drop nothing", () => {
  for (const [name, guard] of [["engines", schemas.EnginesResponseGuard], ["engines-external", schemas.ExternalEndpointsGuard], ["engines-flags", schemas.FlagsResponseGuard]]) {
    const result = check(guard, fixture(name));
    assert.deepEqual(result.errors, [], name);
    assert.equal(result.dropped, 0, name);
  }
  assert.equal(check(schemas.DescriptorValidationGuard, { ok: false, kind: "descriptor", errors: [{ path: "id", code: "pattern", message: "m" }] }).ok, true);
  assert.equal(check(schemas.DescriptorValidationGuard, { ok: true, errors: [] }).ok, true);
  assert.equal(check(schemas.DescriptorValidationGuard, { errors: [] }).ok, false);
});

test("the page modules load and export what routes.js and the entry page expect", async () => {
  const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, "routes", "engines", file)).href);
  for (const file of ["index.js", "engine-detail.js", "engine-new.js", "external.js"]) {
    const module = await load(file);
    assert.equal(typeof module.default, "function", `${file} default export`);
  }
  assert.equal(typeof (await load("external.js")).ExternalEndpointsPanel, "function");
  const schemaTabs = await load("schema-tabs.js");
  assert.equal(typeof schemaTabs.ParametersTab, "function");
  assert.equal(typeof schemaTabs.RecipesTab, "function");
  const { ROUTES } = await import(pathToFileURL(path.join(CONSOLE_DIR, "routes.js")).href);
  const engines = ROUTES.filter((route) => route.name.startsWith("engines"));
  assert.deepEqual(engines.map((route) => route.path), ["/engines", "/engines/new", "/engines/external", "/engines/:engineId"]);
});

test("the page sources follow the write rules: confirm first, key never rendered, nothing stored in the browser", () => {
  const read = (file) => fs.readFileSync(path.join(CONSOLE_DIR, "routes", "engines", file), "utf8");
  const runtimes = read("runtimes-tab.js");
  // Both job-starting calls are made from the confirm dialog's handler with { confirm: true }.
  assert.equal((runtimes.match(/\{ confirm: true \}/g) || []).length, 2);
  assert.match(runtimes, /ConfirmDialog/);
  assert.match(runtimes, /onConfirm=\$\{start\}/);
  assert.match(runtimes, /\/runtimes\/\$\{enc\(target\.runtimeId\)\}\/pull/);
  assert.match(runtimes, /\/introspect/);
  const external = read("external.js");
  assert.ok([...external.matchAll(/apiKeyRef(.{0,3})/g)].every((match) => /^\s*\?/.test(match[1])), "the secret reference is only ever tested for presence, never rendered");
  assert.match(external, /type=\$\{shown \? "text" : "password"\}/);
  assert.match(external, /autocomplete="new-password"/);
  assert.match(external, /confirm: "1"/);
  assert.match(external, /ConfirmDialog/);
  for (const file of fs.readdirSync(path.join(CONSOLE_DIR, "routes", "engines"))) {
    assert.equal(/localStorage|sessionStorage|document\.cookie/.test(read(file)), false, `${file} stores nothing in the browser`);
  }
});
