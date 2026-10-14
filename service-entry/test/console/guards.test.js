// 07 §3.4 runtime guards: DSL semantics, dropped-item counting, error paths,
// and the resource guards other workstreams' contract tests import (§13.4).

import assert from "node:assert/strict";
import test from "node:test";

import { any, arr, bool, check, int, iso, nullable, num, obj, oneOf, opt, record, refine, str } from "../../console/lib/guards.js";
import * as schemas from "../../console/lib/schemas.js";

test("primitive guards accept their type only", () => {
  assert.equal(check(str, "a").ok, true);
  assert.equal(check(str, 1).ok, false);
  assert.equal(check(num, 1.5).ok, true);
  assert.equal(check(num, Number.NaN).ok, false);
  assert.equal(check(num, Infinity).ok, false);
  assert.equal(check(int, 2).ok, true);
  assert.equal(check(int, 2.5).ok, false);
  assert.equal(check(bool, false).ok, true);
  assert.equal(check(bool, "false").ok, false);
  assert.equal(check(iso, "2026-10-14T08:00:00Z").ok, true);
  assert.equal(check(iso, "yesterday").ok, false);
  assert.equal(check(iso, 1760428800000).ok, false);
  assert.equal(check(any, undefined).ok, true);
  assert.equal(check(oneOf("a", 1), 1).ok, true);
  assert.equal(check(oneOf("a", 1), "1").ok, false);
});

test("opt allows absence only, nullable allows null only", () => {
  const shape = obj({ a: opt(str), b: nullable(str) });
  assert.deepEqual(check(shape, { b: null }).value, { b: null });
  assert.equal(check(shape, { a: null, b: null }).ok, false);
  assert.equal(check(shape, { a: "x" }).ok, false, "b is required (null or string)");
  const result = check(shape, { b: "y" });
  assert.equal(Object.hasOwn(result.value, "a"), false, "an absent opt key stays absent");
});

test("obj keeps unknown keys and reports the failing path", () => {
  const guard = obj({ id: str, nested: obj({ count: int }) });
  const ok = check(guard, { id: "x", nested: { count: 1, extra: true }, more: [1] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { id: "x", nested: { count: 1, extra: true }, more: [1] });
  const bad = check(guard, { id: "x", nested: { count: "1" } });
  assert.equal(bad.ok, false);
  assert.equal(bad.value, undefined);
  assert.deepEqual(bad.errors, [{ path: "$.nested.count", expected: "integer", got: "string" }]);
  assert.deepEqual(check(guard, null).errors, [{ path: "$", expected: "object", got: "null" }]);
  assert.deepEqual(check(guard, []).errors, [{ path: "$", expected: "object", got: "array" }]);
});

test("arr drops invalid items and counts them; dropInvalid:false fails instead", () => {
  const item = obj({ id: str });
  const lenient = check(obj({ items: arr(item) }), { items: [{ id: "a" }, { id: 2 }, null, { id: "d" }] });
  assert.equal(lenient.ok, true);
  assert.deepEqual(lenient.value.items, [{ id: "a" }, { id: "d" }]);
  assert.equal(lenient.dropped, 2);
  assert.deepEqual(lenient.errors, [], "dropped items leave no fatal errors");

  const strict = check(arr(item, { dropInvalid: false }), [{ id: "a" }, { id: 2 }]);
  assert.equal(strict.ok, false);
  assert.deepEqual(strict.errors, [{ path: "$[1].id", expected: "string", got: "number" }]);
  assert.equal(check(arr(str), "nope").ok, false);
});

test("nested drops are counted through outer arrays", () => {
  const guard = arr(obj({ tags: arr(str) }));
  const result = check(guard, [{ tags: ["a", 1, "b"] }, { tags: [2] }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [{ tags: ["a", "b"] }, { tags: [] }]);
  assert.equal(result.dropped, 2);
});

test("record checks every value; refine adds a rule with its own name", () => {
  assert.deepEqual(check(record(num), { a: 1, b: 2 }).value, { a: 1, b: 2 });
  assert.deepEqual(check(record(num), { a: 1, b: "2" }).errors, [{ path: "$.b", expected: "number", got: "string" }]);
  const even = refine(int, (value) => value % 2 === 0, "even integer");
  assert.equal(check(even, 4).ok, true);
  assert.deepEqual(check(even, 3).errors, [{ path: "$", expected: "even integer", got: "number" }]);
  const throwing = refine(any, () => {
    throw new Error("boom");
  }, "never");
  assert.equal(check(throwing, 1).ok, false, "a throwing predicate fails instead of crashing");
});

test("one bad instance never blanks the fleet", () => {
  const fleet = {
    ok: true,
    instances: [
      { instanceId: "primary", status: "running", lifecycle: { state: "ready", phase: "ready" }, models: [{ id: "m" }] },
      { status: "running" },
      { id: "vllm:secondary", lifecycle: { state: "loading", phaseHistory: [{ phase: "pull", at: "2026-10-14T08:00:00Z" }] }, sleep: { id: "slp_1" } },
    ],
  };
  const result = check(schemas.FleetGuard, fleet);
  assert.equal(result.ok, true);
  assert.equal(result.value.instances.length, 2);
  assert.equal(result.dropped, 1);
});

test("NotificationGuard accepts same-origin targets and rejects cross-origin href and non-/api/ apiCall", () => {
  const base = { kind: "component.failed", severity: "error", title: { zh: "z", en: "e" } };
  const label = { zh: "z", en: "e" };
  const accepts = (action) => check(schemas.NotificationGuard, { ...base, action }).ok;
  assert.equal(check(schemas.NotificationGuard, base).ok, true);
  assert.equal(check(schemas.NotificationGuard, { ...base, dedupeKey: "k", body: label }).ok, true);
  assert.equal(accepts({ label, href: "/deployments?manager=vllm" }), true);
  assert.equal(accepts({ label, apiCall: { method: "POST", path: "/api/platform/restore" } }), true);
  assert.equal(accepts({ label, href: "https://evil.example/x" }), false);
  assert.equal(accepts({ label, href: "//evil.example/x" }), false);
  assert.equal(accepts({ label, href: "/\\evil.example" }), false);
  assert.equal(accepts({ label, href: "javascript:alert(1)" }), false);
  assert.equal(accepts({ label, apiCall: { method: "POST", path: "/gateway/auto/openai/v1/chat" } }), false);
  assert.equal(accepts({ label, apiCall: { method: "POST", path: "/api/../gateway/x" } }), false);
  assert.equal(accepts({ label, apiCall: { method: "POST", path: "/api/%2e%2e/x" } }), false);
  assert.equal(accepts({ label, apiCall: { method: "TRACE", path: "/api/x" } }), false);
  assert.equal(accepts({ label, href: "/a", apiCall: { method: "POST", path: "/api/x" } }), false, "exactly one target");
  assert.equal(accepts({ label }), false);
  assert.equal(check(schemas.NotificationGuard, { ...base, severity: "fatal" }).ok, false);
  assert.equal(check(schemas.NotificationGuard, { ...base, title: { zh: "only" } }).ok, false);
});

test("LaunchPlanGuard takes ok:false plans with blockers, planHash and steps", () => {
  const plan = {
    ok: false, engineId: "sglang", planHash: "sha256:9f", blockers: [{ code: "image_pull_required" }],
    values: { concurrency: { value: 1, source: "planner", reason: "x" } },
    steps: [{ kind: "pull", image: "local/x", required: true, policy: "explicit" }],
    command: { argv: ["docker", "run", "<redacted>"], env: { KEY: "<redacted>" }, labels: {} },
    memory: { perGpuMb: { 0: 96801 }, policy: "static-fraction-of-free", kvPoolTokens: 262144, maxFullLengthRequests: 1 },
    admission: { verdict: "warn", message: "m" },
  };
  assert.equal(check(schemas.LaunchPlanGuard, plan).ok, true);
  assert.equal(check(schemas.LaunchPlanGuard, { ...plan, admission: { verdict: "maybe" } }).ok, false);
  assert.equal(check(schemas.LaunchPlanGuard, { ...plan, command: { argv: ["docker", 1] } }).ok, false, "argv never drops items");
});

test("every resource guard named in 07 §3.4 is exported", () => {
  const names = ["StatusGuard", "FleetGuard", "InstanceGuard", "InstanceMetricsGuard", "LaunchPlanGuard", "JobErrorGuard", "ErrorEnvelopeGuard",
    "EventEnvelopeGuard", "NotificationGuard", "SessionGuard", "PlatformStatusGuard", "ModelCardGuard", "FitResultGuard", "FitGridGuard",
    "PlanCardGuard", "CompatRowGuard", "EngineGuard", "SchemaCatalogGuard", "EngineDescriptorGuard", "JobGuard", "DownloadJobGuard",
    "LibraryEntryGuard", "TimeseriesGuard", "BreakdownGuard", "RequestRowGuard", "AlertGuard", "KeyGuard", "ComponentGuard",
    "DoctorCheckGuard", "BootstrapGuard"];
  for (const name of names) assert.equal(typeof schemas[name], "function", name);
});

test("resource guards accept the spec examples", () => {
  const cases = [
    ["ErrorEnvelopeGuard", { ok: false, error: { code: "plan_changed", message: "m", hint: "h" }, errors: [{ field: "contextLength", code: "out_of_range", message: "m", suggestion: { value: 131072 } }] }],
    ["SessionGuard", { ok: true, role: "viewer", via: "loopback", paired: false, autoPairAvailable: true, pairCommand: "platform admin pair" }],
    ["PlatformStatusGuard", { schemaVersion: 1, at: "2026-10-14T08:00:00Z", readiness: { overall: "degraded", layers: [{ id: "serving", status: "warn", code: "no_model_serving", action: { id: "restore-models", label: { "zh-CN": "z", "en-US": "e" } } }] }, components: [{ id: "entry", state: "ready", ports: [{ name: "admin", port: 5176, bind: "127.0.0.1" }] }] }],
    ["DoctorCheckGuard", { id: "runtime.docker-daemon", group: "runtime", status: "fail", title: { "zh-CN": "z", "en-US": "e" }, fix: { id: "start-docker", risk: "confirm", command: "platform doctor" } }],
    ["InstanceMetricsGuard", { ok: true, instanceId: "primary", scrapedAt: "2026-10-14T08:00:00Z", metrics: { ttftMs: { avg: 1, p50: 1, p95: 2, count: 3 } }, facts: {}, unsupported: ["specAcceptRate"] }],
    ["JobErrorGuard", { code: "oom", signatureId: "cuda-oom", phase: "kv", hint: { zh: "z", en: "e" }, logExcerpt: "<redacted>" }],
    ["EventEnvelopeGuard", { id: "k3f9a2-1", type: "jobs", at: "2026-10-14T08:00:00.000Z", source: "vllm", data: { managerId: "vllm", jobs: [], removed: [] } }],
    ["EngineGuard", { engineId: "vllm", runtimes: [{ runtimeId: "vllm@0.28.0", present: null, default: true }] }],
    ["SchemaCatalogGuard", { ok: true, engineId: "vllm", groups: [{ id: "core", order: 1 }], params: [{ id: "contextLength", type: "int", group: "core" }] }],
    ["EngineDescriptorGuard", { id: "lmdeploy", adapter: "docker-template", label: { zh: "z", en: "e" } }],
    ["ModelCardGuard", { schema: "modelcard/v1", cardId: "mc_1", ref: { kind: "local" }, format: { kind: "gguf" }, role: { value: "main", runnable: true }, identity: { modelType: "qwen3" } }],
    ["CompatRowGuard", { engineId: "llamacpp", runtimeId: "llamacpp@b10630", verdict: "unknown", reasons: [{ code: "arch_not_in_knowledge", level: "unknown", message: { zh: "z", en: "e" } }] }],
    ["FitResultGuard", { status: "warn", spill: true, budgetMb: { 0: 94943 }, headroomMb: 4888, suggestions: [{ code: "kv_fp8", param: "kvCacheDtype" }] }],
    ["FitGridGuard", { ok: true, cardId: "mc_1", cells: [{ kvDtype: "auto", concurrency: 1, maxContext: 262144, limitedBy: "native", status: "ok", spill: false }] }],
    ["PlanCardGuard", { planId: "pl_1", rank: 1, engineId: "llamacpp", values: { contextLength: { value: 131072, source: "planner" } } }],
    ["JobGuard", { id: "job_1", type: "serve", status: "running" }],
    ["DownloadJobGuard", { id: "dl_7k2m4q9x3c5vb8np", state: "downloading", progress: { bytesDone: 1, bytesTotal: 2, percent: 50 }, error: null }],
    ["LibraryEntryGuard", { id: "lib_9d1e6c0a5b2f4e17", kind: "folder", displayName: "x", bytes: 1 }],
    ["TimeseriesGuard", { ok: true, step: 300, series: [{ metric: "lat.ttft_p95", unit: "ms", group: { model: "m" }, points: [[1760342400000, 812.5], [1760342700000, null]] }], annotations: [{ at: 1, type: "launch.ready", title: "t" }] }],
    ["BreakdownGuard", { ok: true, dim: "error_class", rows: [{ key: "auth_failed", requests: 90, share: 0.24 }], total: { requests: 372 } }],
    ["RequestRowGuard", { requestId: "req_abc", receivedAt: "2026-10-14T08:00:00Z", durationMs: 1, terminalState: "completed" }],
    ["AlertGuard", { ruleId: "r1", scopeKey: "fleet:vllm:primary", state: "firing", severity: "warn", since: "2026-10-14T08:00:00Z" }],
    ["KeyGuard", { id: "k_7f3m9q2x8v4c1n6t5r0w", name: "laptop", preview: "sk-plat-Q…9xZk", status: "active", class: "friend" }],
    ["StatusGuard", { ok: true, managers: [{ id: "vllm", ok: true }], components: { total: 2, online: 1, offline: ["llama"], items: [{ id: "vllm", online: true }] } }],
    ["BootstrapGuard", { ok: true, buildId: "3f9c2a1b7d0e", role: "owner", auth: { mode: "loopback-trust", session: null, csrf: null }, managers: [{ id: "vllm", label: { zh: "z", en: "e" }, legacyUiPort: 5177 }], features: { events: true } }],
  ];
  for (const [name, value] of cases) {
    const result = check(schemas[name], value);
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.errors)}`);
  }
  assert.equal(check(schemas.TimeseriesGuard, { series: [{ metric: "m", points: [[1, "x"]] }] }).dropped, 1, "a malformed point is dropped");
});
