"use strict";

// docker-template engines (docs/overhaul/01-engines.md §19, ENG-18): the
// template grammar and its validation, the adapter that renders the shipped
// lmdeploy / trtllm / tabbyapi descriptors, the injection rules, the YAML
// emitter, the generated launch files and their secret-file lifecycle, and the
// supervisor's part in it. Pure or temp-dir only: no docker, no network, no
// live data; ACLs go through a fake icacls.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-template-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");
const jobUtils = require("../job-utils");
const { emitYaml } = require("../engines/yaml-emit");
const grammar = require("../engines/template-grammar");
const { validateDescriptor } = require("../engines/descriptor-schema");
const { createLaunchFiles } = require("../engines/launch-files");
const { createRuntimeSupervisor } = require("../engines/runtime-supervisor");
const { renderRunArgs } = require("../engines/adapters/_docker-segments");

const adapter = core.engines.adapters["docker-template"];
const registry = core.engines.createEngineRegistry({ env: {}, overrideDir: path.join(EMPTY_CONFIG_DIR, "none") });
const KEY = "fixture-template-api-key-0001";

// ---------------------------------------------------------------------------
// A tiny reader for exactly what the emitter writes (block maps, block lists,
// double-quoted strings, numbers, booleans, null, [] and {}), so the tests prove
// what a reader sees without a YAML dependency.

function parseYaml(text) {
  const lines = text.split("\n").filter((line) => line.trim() !== "").map((line) => ({ indent: line.match(/^ */)[0].length, text: line.trim() }));
  let at = 0;
  const scalar = (token) => {
    if (token.startsWith('"')) return JSON.parse(token);
    if (token === "null") return null;
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "[]") return [];
    if (token === "{}") return {};
    const number = Number(token);
    assert.ok(Number.isFinite(number), `unreadable scalar ${token}`);
    return number;
  };
  const keyLine = (value) => /^("(?:[^"\\]|\\.)*"):(?: (.*))?$/.exec(value);
  function node(indent) {
    const line = lines[at];
    assert.equal(line.indent, indent, `indent of "${line.text}"`);
    if (line.text.startsWith("- ")) return list(indent);
    if (keyLine(line.text)) return map(indent);
    at += 1;
    return scalar(line.text);
  }
  function map(indent) {
    const out = {};
    while (at < lines.length && lines[at].indent === indent && !lines[at].text.startsWith("- ")) {
      const match = keyLine(lines[at].text);
      assert.ok(match, `a key line: ${lines[at].text}`);
      at += 1;
      out[JSON.parse(match[1])] = match[2] !== undefined ? scalar(match[2]) : node(lines[at].indent);
    }
    return out;
  }
  function list(indent) {
    const out = [];
    while (at < lines.length && lines[at].indent === indent && lines[at].text.startsWith("- ")) {
      lines[at] = { indent: indent + 2, text: lines[at].text.slice(2) };
      out.push(node(indent + 2));
    }
    return out;
  }
  const value = node(lines[0].indent);
  assert.equal(at, lines.length, "the whole text was read");
  return value;
}

// ---------------------------------------------------------------------------
// A render context like vllm-manager's, over a fake model storage.

const ROOT = "C:/fixture/models";
function toContainerPath(value) {
  const text = String(value);
  if (text.startsWith("/models/")) return text;
  if (!text.startsWith(`${ROOT}/`) || text.includes("..")) throw new Error(`outside the model storage: ${text}`);
  return `/models/${text.slice(ROOT.length + 1)}`;
}

function context(engineId, overrides = {}) {
  const descriptor = registry.get(engineId);
  const launchFiles = overrides.launchFiles || createLaunchFiles({ root: path.join(EMPTY_CONFIG_DIR, "ai-root") });
  return {
    descriptor,
    runtime: registry.defaultRuntime(engineId),
    host: {
      kind: "docker",
      containerPort: descriptor.host.containerPort,
      config: { hfCache: "C:/fixture/cache/hf", containerName: "vllm-local", managerLabelValue: "vllm-manager", imagePlatform: "linux/amd64" },
      labelKeys: { manager: "ai.manager", engine: "ai.manager.engine", apiKeyRef: "ai.manager.api-key-ref" },
      modelMountArgs: ["-v", `${ROOT}:/models`],
      launchFiles,
    },
    model: { modelArg: "/models/exl3-model", ref: `${ROOT}/exl3-model` },
    hostFacts: { env: {}, gpus: [{ id: "0", computeCapability: "12.0" }] },
    secrets: { apiKey: KEY, apiKeyRef: "ref-1" },
    jobId: "job-1",
    launchId: "lch_fixturelaunch0001",
    admission: {},
    toContainerPath,
    dockerGpuArg: (ids) => (ids.length ? `device=${ids.join(",")}` : "all"),
    dockerPublishArgs: (port, access, host, containerPort) => (access === "lan" ? [`0.0.0.0:${port}:${containerPort}`] : [`127.0.0.1:${port}:${containerPort}`]),
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    normalizeGpuIds: (ids) => (Array.isArray(ids) ? ids.map(String) : []),
    lanAddress: () => "192.0.2.10",
    ...overrides,
  };
}

function planFor(values = {}, instance = {}) {
  return {
    values: { servedName: "served-a", contextLength: 8192, concurrency: 4, tensorParallel: 1, ...values },
    instance: { id: "primary", mode: "replace", port: 8010, networkAccess: "local", containerName: "vllm-local", gpuIds: ["0"], ...instance },
  };
}

function build(engineId, values, instance, overrides) {
  return adapter.buildLaunch(planFor(values, instance), context(engineId, overrides));
}

function imageIndex(argv) {
  return argv.indexOf(registry.defaultRuntime(argv.includes("--entrypoint") ? "lmdeploy" : "lmdeploy").image);
}

function enginesArgs(command) {
  return command.docker.args;
}

// ---------------------------------------------------------------------------
// The shipped descriptors

test("the three descriptors validate, are experimental and hosted by vllm-manager", () => {
  assert.deepEqual(registry.errors(), []);
  for (const [id, image, port] of [["lmdeploy", "openmmlab/lmdeploy:v0.18.0", 23333], ["trtllm", "nvcr.io/nvidia/tensorrt-llm/release:1.3.0rc29", 8000], ["tabbyapi", "ghcr.io/theroyallab/tabbyapi:cu13", 5000]]) {
    const descriptor = registry.get(id);
    assert.equal(descriptor.status, "experimental", id);
    assert.equal(descriptor.adapter, "docker-template", id);
    assert.equal(descriptor.tier, 2, id);
    assert.equal(descriptor.hostManager, "vllm", id);
    assert.equal(descriptor.host.containerPort, port, id);
    const runtime = registry.defaultRuntime(id);
    assert.equal(runtime.image, image, id);
    assert.equal(runtime.status, "unpinned", id);
    assert.equal(runtime.pullPolicy, "explicit", id);
    assert.equal(runtime.localBuild, false, id);
    assert.equal(registry.get(id).catalog, `launch-params/${id}.json`);
  }
  assert.deepEqual(registry.get("trtllm").secrets, { apiKey: { mode: "unsupported" } });
  assert.deepEqual(registry.get("lmdeploy").secrets.apiKey, { mode: "flag", flag: "--api-keys" });
  assert.equal(registry.get("tabbyapi").secrets.apiKey.mode, "file");
  assert.equal(registry.get("trtllm").host.allowLan, false);
  assert.equal(registry.get("tabbyapi").artifactFormats.join(), "exl3");
  assert.equal(registry.get("lmdeploy").memoryModel.kind, "free-fraction-after-weights");
  assert.equal(registry.get("tabbyapi").memoryModel.kind, "weights-plus-kv");
  assert.equal(registry.get("trtllm").metricsMap.format, "json");
  assert.deepEqual(registry.get("lmdeploy").metricsMap.map, {}, "names are unverified until a fixture is recorded");
  assert.equal(registry.get("tabbyapi").metricsMap, undefined, "TabbyAPI has no metrics endpoint");
});

test("every placeholder of the shipped templates resolves in the engine's own catalog", () => {
  for (const id of ["lmdeploy", "trtllm", "tabbyapi"]) {
    const catalog = core.engines.loadCatalog(id);
    assert.deepEqual(catalog.errors, [], id);
    const ids = catalog.params.map((param) => param.id);
    const problems = grammar.validateTemplate(registry.get(id).template, { paramIds: ids });
    assert.deepEqual(problems, [], id);
  }
});

// ---------------------------------------------------------------------------
// Rendering

test("lmdeploy renders its command line, mounts, labels and flag-mode key", () => {
  const command = build("lmdeploy", { "lmdeploy.cacheMaxEntryCount": 0.7, "lmdeploy.backend": "pytorch" }, { networkAccess: "lan" });
  assert.equal(command.docker.image, "openmmlab/lmdeploy:v0.18.0");
  assert.equal(command.docker.entrypoint, "lmdeploy");
  assert.deepEqual(command.docker.args, [
    "serve", "api_server", "/models/exl3-model",
    "--server-name", "0.0.0.0", "--server-port", "23333", "--model-name", "served-a",
    "--session-len", "8192", "--max-batch-size", "4", "--tp", "1",
    "--cache-max-entry-count", "0.7", "--backend", "pytorch", "--enable-metrics",
    "--api-keys", KEY,
  ]);
  assert.deepEqual(command.publish, ["0.0.0.0:8010:23333"], "lmdeploy enforces its key, so LAN publishing is offered");
  const flags = command.docker.flags;
  assert.deepEqual(flags.slice(0, 8), ["--platform", "linux/amd64", "--pull", "never", "--name", "vllm-local", "--restart", "on-failure:3"]);
  assert.ok(flags.includes("--ipc=host"));
  assert.ok(flags.join(" ").includes("-v C:/fixture/cache/hf:/root/.cache/huggingface"));
  assert.ok(flags.includes(`${ROOT}:/models:ro`), "the model library is read-only to an experimental image");
  assert.equal(command.labels["ai.manager.engine"], "lmdeploy");
  assert.equal(command.labels["ai.manager.engine-id"], "lmdeploy");
  assert.equal(command.labels["ai.manager.runtime-id"], "lmdeploy@0.18.0");
  assert.equal(command.labels["ai.manager.launch-id"], "lch_fixturelaunch0001");
  assert.equal(command.labels["ai.manager.api-key-ref"], "ref-1");
  assert.equal(command.labels["ai.manager.port"], "8010");
  assert.deepEqual(command.redactions, [KEY]);
  assert.deepEqual(command.secretEnv, {});
  assert.deepEqual(command.files, []);
  // Flags in the legacy vLLM order: name/restart, labels, gpus, ipc, health, publish, mounts, then identity labels, entrypoint, image.
  const positions = ["--name", "--restart", "ai.manager.job=job-1", "--gpus", "--ipc=host", "--health-cmd", "-p 0.0.0.0", "-v C:", "--label ai.manager.launch-id"]
    .map((needle) => flags.join(" ").indexOf(needle));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  const run = renderRunArgs(command);
  assert.equal(run[0], "run");
  assert.ok(run.indexOf("--entrypoint") < run.indexOf("openmmlab/lmdeploy:v0.18.0"));
  assert.equal(run[run.indexOf("--entrypoint") + 1], "lmdeploy");
});

test("an unset value omits its flag; values left to the engine default are not emitted", () => {
  const command = build("lmdeploy", {}, {}, { secrets: {} });
  const args = enginesArgs(command);
  assert.ok(!args.includes("--backend"), "lmdeploy.backend is unset");
  assert.ok(args.includes("--cache-max-entry-count"), "the catalog's literal platform default (0.8) is explicit");
  assert.equal(args[args.indexOf("--cache-max-entry-count") + 1], "0.8");
  assert.ok(!args.includes("--api-keys"), "no key, no flag");
  assert.ok(!args.includes("--adapters"), "no adapters, no repeat group");
});

test("a repeat group renders once per item and only for complete items", () => {
  const command = build("lmdeploy", { "lora.adapters": [{ name: "a1", path: `${ROOT}/lora-a` }, { name: "a2", path: "/models/lora-b" }, { name: "broken" }] });
  const args = enginesArgs(command);
  const at = args.indexOf("--adapters");
  assert.deepEqual(args.slice(at, at + 4), ["--adapters", "a1=/models/lora-a", "--adapters", "a2=/models/lora-b"]);
  assert.equal(args.filter((token) => token === "--adapters").length, 2, "an item without its path drops the whole instance");
});

test("trtllm renders its flags and the extra_llm_api_options file, drops the key and publishes on loopback", () => {
  const command = build("trtllm", { "trtllm.kvCacheFreeGpuMemoryFraction": 0.85, reasoningParser: "qwen3", toolCallParser: "qwen3", kvCacheDtype: "fp8" }, { networkAccess: "lan" });
  assert.equal(command.docker.entrypoint, "trtllm-serve");
  assert.deepEqual(command.docker.args, [
    "/models/exl3-model",
    "--host", "0.0.0.0", "--port", "8000", "--backend", "pytorch",
    "--tp_size", "1", "--max_batch_size", "4", "--max_seq_len", "8192",
    "--kv_cache_free_gpu_memory_fraction", "0.85",
    "--reasoning_parser", "qwen3", "--tool_parser", "qwen3",
    "--extra_llm_api_options", "/launch-files/extra.yaml",
  ]);
  assert.ok(!command.docker.args.includes(KEY), "trtllm-serve has no key option; the key is dropped");
  assert.deepEqual(command.redactions, []);
  assert.deepEqual(command.publish, ["127.0.0.1:8010:8000"], "an unsupported-auth engine is forced to a loopback publish");
  assert.ok(command.logs.some((line) => /loopback|127\.0\.0\.1/.test(line)));
  assert.deepEqual(command.files.map((file) => [file.id, file.target, file.format, file.secret]), [["extra", "/launch-files/extra.yaml", "yaml", false]]);
  assert.deepEqual(command.files[0].content, { enable_iter_perf_stats: true, kv_cache_config: { dtype: "fp8", enable_block_reuse: true } });
  assert.ok(command.docker.flags.includes(`${command.files[0].hostPath}:/launch-files/extra.yaml:ro`));
  assert.ok(command.docker.flags.includes("memlock=-1"));
  // Unset optional values leave the file and the argv without them.
  const plain = build("trtllm", {}, {}, { secrets: {} });
  assert.deepEqual(plain.files[0].content, { enable_iter_perf_stats: true, kv_cache_config: { enable_block_reuse: true } });
  assert.ok(!plain.docker.args.includes("--reasoning_parser"));
});

test("an unsupported-auth engine stays on loopback even when its descriptor claims allowLan", () => {
  const descriptor = structuredClone(registry.get("trtllm"));
  descriptor.host.allowLan = true;
  const command = adapter.buildLaunch(planFor({}, { networkAccess: "lan" }), { ...context("trtllm"), descriptor });
  assert.deepEqual(command.publish, ["127.0.0.1:8010:8000"]);
});

test("tabbyapi writes config.yml and a secret api_tokens.yml and mounts them read-only", () => {
  const command = build("tabbyapi", { "tabbyapi.cacheMode": "Q8", "tabbyapi.cacheSize": 16384, "tabbyapi.tensorParallel": true, "speculative.draftModel": `${ROOT}/exl3-draft` });
  assert.equal(command.docker.entrypoint, null);
  assert.deepEqual(command.docker.args, []);
  assert.deepEqual(command.publish, ["127.0.0.1:8010:5000"]);
  const [config, tokens] = command.files;
  assert.deepEqual([config.id, config.target, config.secret], ["config", "/app/config.yml", false]);
  assert.deepEqual(config.content, {
    network: { host: "0.0.0.0", port: 5000, disable_auth: false },
    model: { model_dir: "/models", model_name: "exl3-model", max_seq_len: 8192, cache_mode: "Q8", cache_size: 16384, tensor_parallel: true, gpu_split_auto: true },
    draft_model: { draft_model_dir: "/models", draft_model_name: "exl3-draft" },
  });
  assert.deepEqual([tokens.id, tokens.target, tokens.secret], ["tokens", "/app/api_tokens.yml", true]);
  assert.equal(tokens.content.api_key, KEY);
  assert.match(tokens.content.admin_key, /^[0-9a-f]{48}$/);
  assert.notEqual(tokens.content.admin_key, KEY, "the admin key is generated, never the user's key");
  assert.deepEqual(command.redactions, [KEY, tokens.content.admin_key]);
  const flags = command.docker.flags.join(" ");
  assert.ok(flags.includes(`${config.hostPath}:/app/config.yml:ro`));
  assert.ok(flags.includes(`${tokens.hostPath}:/app/api_tokens.yml:ro`));
  assert.ok(!flags.includes(KEY) && !command.docker.args.includes(KEY), "the key is only in the secret file");
  // Without a draft model the section is omitted whole; without a key the launch is refused.
  const plain = build("tabbyapi");
  assert.equal(Object.hasOwn(plain.files[0].content, "draft_model"), false);
  assert.equal(Object.hasOwn(plain.files[0].content.model, "cache_mode"), false);
  assert.throws(() => build("tabbyapi", {}, {}, { secrets: {} }), (error) => error.code === "api_key_required" && error.status === 400);
});

test("an env-mode key travels by name, never in argv", () => {
  const descriptor = structuredClone(registry.get("lmdeploy"));
  descriptor.secrets = { apiKey: { mode: "env", env: "LMDEPLOY_API_KEY" } };
  const command = adapter.buildLaunch(planFor(), { ...context("lmdeploy"), descriptor });
  assert.ok(command.docker.flags.join(" ").includes("-e LMDEPLOY_API_KEY"));
  assert.ok(!command.docker.flags.join(" ").includes(KEY));
  assert.deepEqual(command.secretEnv, { LMDEPLOY_API_KEY: KEY });
  assert.ok(!command.docker.args.includes(KEY));
});

test("extraArgs and extraEnv are appended last; labels stay the last flags", () => {
  const command = build("lmdeploy", {}, {}, { extra: { args: ["--dtype", "bfloat16"], env: { NCCL_DEBUG: "WARN" } } });
  assert.deepEqual(command.docker.args.slice(-2), ["--dtype", "bfloat16"]);
  assert.ok(command.docker.flags.join(" ").includes("-e NCCL_DEBUG=WARN"));
});

// ---------------------------------------------------------------------------
// Injection and validation

function customDescriptor(template, extra = {}) {
  return {
    ...structuredClone(registry.get("lmdeploy")),
    id: "lab-engine",
    legacy: { engineLabel: "lab-engine", managerEngineField: "lab-engine" },
    template: { entrypoint: "lab", flagFormat: "space", env: {}, files: [], ...template },
    ...extra,
  };
}

function render(descriptor, values, overrides = {}) {
  return adapter.buildLaunch(planFor(values), { ...context("lmdeploy", { secrets: {} }), descriptor, catalog: core.engines.loadCatalog("lmdeploy"), ...overrides });
}

test("a placeholder value that would become a flag is refused; numbers and equals-format values are not", () => {
  const descriptor = customDescriptor({
    args: [
      { flag: "--name", value: "{{servedName}}" },
      { flag: "--seed", value: "{{contextLength}}" },
    ],
  });
  for (const hostile of ["--evil", "-x", "--model=/etc/passwd"]) {
    assert.throws(() => render(descriptor, { servedName: hostile }), (error) => error.code === "template_value_flag_injection" && error.status === 400, hostile);
  }
  assert.deepEqual(render(descriptor, { servedName: "ok-name", contextLength: -5 }).docker.args, ["--name", "ok-name", "--seed", "-5"], "a negative number is a number");
  const equals = customDescriptor({ args: [{ flag: "--name", value: "{{servedName}}", format: "equals" }] });
  assert.deepEqual(render(equals, { servedName: "--evil" }).docker.args, ["--name=--evil"], "joined to its flag, a value cannot be a flag");
  const composite = customDescriptor({ args: [{ args: ["--tag", "{{item.name}}={{item.path}}"], repeat: "{{lora.adapters}}" }] });
  assert.throws(() => render(composite, { "lora.adapters": [{ name: "-bad", path: "/models/x" }] }), (error) => error.code === "template_value_flag_injection");
});

test("NUL, CR and LF in a value are refused, lists never become one argument, and literal text may start with a dash", () => {
  const descriptor = customDescriptor({ args: ["--literal", "{{servedName}}"] });
  for (const hostile of ["a\u0000b", "line1\nline2", "x\ry"]) {
    assert.throws(() => render(descriptor, { servedName: hostile }), (error) => error.code === "template_value_invalid", JSON.stringify(hostile));
  }
  const list = customDescriptor({ args: ["{{lora.adapters}}"] });
  assert.throws(() => render(list, { "lora.adapters": [{ name: "a", path: "/models/a" }] }), (error) => error.code === "template_value_invalid");
  assert.deepEqual(render(descriptor, { servedName: "fine" }).docker.args, ["--literal", "fine"]);
});

test("a value is one token: spaces and shell syntax stay inside it", () => {
  const descriptor = customDescriptor({ args: [{ flag: "--name", value: "{{servedName}}" }] });
  const hostile = "a b; rm -rf / && echo $(id) `x` | y > z";
  assert.deepEqual(render(descriptor, { servedName: hostile }).docker.args, ["--name", hostile]);
});

test("a path-typed value must be inside the model storage and becomes a container path", () => {
  const descriptor = customDescriptor({ args: [{ flag: "--draft", value: "{{speculative.draftModel}}" }] }, { catalog: "launch-params/tabbyapi.json" });
  const catalog = core.engines.loadCatalog("tabbyapi");
  const ok = render(descriptor, { "speculative.draftModel": `${ROOT}/draft` }, { catalog });
  assert.deepEqual(ok.docker.args, ["--draft", "/models/draft"]);
  for (const outside of ["C:/elsewhere/draft", "relative/draft", `${ROOT}/../escape`, "/etc/passwd"]) {
    assert.throws(() => render(descriptor, { "speculative.draftModel": outside }, { catalog }), (error) => error.code === "template_path_outside_storage" && error.status === 400, outside);
  }
});

test("descriptor validation rejects unknown placeholders, bad syntax and misplaced variables at load", () => {
  const catalogIds = core.engines.loadCatalog("lmdeploy").params.map((param) => param.id);
  const check = (template, expected, options = {}) => {
    const problems = grammar.validateTemplate({ args: [], ...template }, { paramIds: catalogIds, ...options });
    assert.ok(problems.some((item) => item.code === expected), `${expected} in ${JSON.stringify(problems)}`);
  };
  check({ args: ["{{nope}}"] }, "template_unknown_placeholder");
  check({ args: [{ flag: "--x", value: "{{lmdeploy.nosuch}}" }] }, "template_unknown_placeholder");
  check({ args: ["{{ servedName }}"] }, "template_placeholder_syntax");
  check({ args: ["{{servedName"] }, "template_placeholder_syntax");
  check({ args: ["{{servedName|upper}}"] }, "template_placeholder_syntax");
  check({ args: ["{{item.name}}"] }, "template_item_outside_repeat");
  check({ args: ["{{secrets.apiKey}}"] }, "template_secret_placeholder");
  check({ args: ["{{file.ghost}}"] }, "template_unknown_placeholder");
  check({ args: [{ args: ["x"], repeat: "{{servedName}}" }] }, "template_repeat_invalid");
  check({ args: [{ flag: "not-a-flag", value: "x" }] }, "pattern");
  check({ args: [{ flag: "--x", value: "y", surprise: 1 }] }, "unknown_field");
  check({ args: [{ args: ["x"], when: { nope: [] } }] }, "when_unknown_operator");
  check({ args: ["a"], surprise: true }, "unknown_field");
  check({ args: ["a"], files: [{ id: "f", target: "relative", format: "yaml", content: {} }] }, "pattern");
  check({ args: ["a"], files: [{ id: "f", target: "/a/b", format: "xml", content: {} }] }, "enum");
  check({ args: ["a"], files: [{ id: "f", target: "/a/b", format: "yaml", content: {} }, { id: "f", target: "/a/c", format: "yaml", content: {} }] }, "duplicate");
  check({ args: ["a"], files: [{ id: "f", target: "/a/b", format: "yaml", content: { k: "{{secrets.apiKey}}" } }] }, "template_secret_placeholder");
  check({ args: ["a"], env: { lower: "x" } }, "pattern");
  // Valid grammar, for contrast.
  assert.deepEqual(grammar.validateTemplate({
    args: ["{{model_path}}", { flag: "--port", value: "{{port}}" }, { args: ["--g", "{{gpu_ids}}"], when: { gt: [{ param: "contextLength" }, 1] } }],
    env: { FOO: "{{gpu_count}}" },
  }, { paramIds: catalogIds }), []);
});

test("the registry drops an override whose template names an unknown placeholder, and reports it", () => {
  const dir = path.join(EMPTY_CONFIG_DIR, "bad-override");
  fs.mkdirSync(dir, { recursive: true });
  const bad = customDescriptor({ args: ["{{definitelyNotAParam}}"] }, { runtimes: { default: "lmdeploy", allowed: ["lmdeploy"], allowCustomImage: true } });
  fs.writeFileSync(path.join(dir, "lab.json"), JSON.stringify(bad));
  const local = core.engines.createEngineRegistry({ env: {}, overrideDir: dir });
  assert.equal(local.has("lab-engine"), false);
  assert.ok(local.errors().some((item) => item.engineId === "lab-engine" && item.code === "template_unknown_placeholder"), JSON.stringify(local.errors()));
  const draft = local.checkOverride(bad, { mode: "draft" });
  assert.equal(draft.ok, false);
  assert.ok(draft.errors.some((item) => item.code === "template_unknown_placeholder"));
  // The same engine with a shared concept (common.json) is accepted: a custom engine has no catalog of its own.
  const good = customDescriptor({ args: ["{{model.containerPath}}", { flag: "--len", value: "{{contextLength}}" }] }, { runtimes: { default: "lmdeploy", allowed: ["lmdeploy"], allowCustomImage: true } });
  const goodCheck = local.checkOverride(good, { mode: "draft" });
  assert.deepEqual((goodCheck.errors || []).filter((item) => /template/.test(item.code) || /^template/.test(item.path || "")), [], "no template problem (runtime wiring of the fake engine is not under test)");
});

test("a secret file needs mode file, mode file needs a secret file, and templates exist only on docker-template", () => {
  const base = () => structuredClone(registry.get("tabbyapi"));
  const noFile = base();
  noFile.secrets.apiKey.file = "config";
  assert.ok(validateDescriptor(noFile, { mode: "bundled" }).errors.some((item) => item.code === "secret_file_missing"));
  const orphan = base();
  orphan.secrets = { apiKey: { mode: "flag", flag: "--api-keys" } };
  assert.ok(validateDescriptor(orphan, { mode: "bundled" }).errors.some((item) => item.code === "secret_file_unused"));
  const wrongAdapter = structuredClone(registry.get("vllm"));
  wrongAdapter.template = { args: [] };
  assert.ok(validateDescriptor(wrongAdapter, { mode: "bundled" }).errors.some((item) => item.code === "field_not_applicable"));
  const missing = base();
  delete missing.template;
  assert.ok(validateDescriptor(missing, { mode: "bundled" }).errors.some((item) => item.path === "template" && item.code === "required"));
});

// ---------------------------------------------------------------------------
// The YAML emitter

test("the YAML emitter quotes every string and round-trips hostile text", () => {
  const nasty = ["yes", "no", "null", "~", "123", "1e3", "0x1f", "a: b", "# not a comment", "- dash", "multi\nline", '"quoted"', "back\\slash", "tab\tchar",
    "\u2028separator", "\u0085next-line", "emoji \u{1F600}", "", " padded ", "key: {flag: [x]}", "&anchor", "*alias", "!tag", "%directive", "@at", "`tick", "|", ">"];
  const document = {
    plain: "text",
    "key with: colon": 1,
    yes: true,
    nested: { deeper: { deepest: [1, 2.5, -3, "x", null, false, [], {}, [1, [2, 3]], { a: { b: "c" } }] } },
    list: nasty,
    empty: {},
    emptyList: [],
    nothing: null,
  };
  const text = emitYaml(document);
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
  assert.deepEqual(parseYaml(text), document);
  for (const line of text.split("\n").filter(Boolean)) {
    const scalar = line.replace(/^\s*(?:- )*(?:"(?:[^"\\]|\\.)*":\s?)?/, "");
    assert.ok(scalar === "" || /^("|-?\d|true$|false$|null$|\[\]$|\{\}$)/.test(scalar), `a string is always quoted: ${line}`);
  }
  assert.deepEqual(parseYaml(emitYaml({ a: [{ x: 1, y: { p: 2 } }, "s"] }, { indent: 4 })), { a: [{ x: 1, y: { p: 2 } }, "s"] });
  assert.equal(emitYaml({ a: undefined, b: 1 }), '"b": 1\n', "undefined entries are skipped");
  assert.equal(emitYaml([]), "[]\n");
  assert.equal(emitYaml("only"), '"only"\n');
  assert.ok(!emitYaml({ k: "line\u2028break" }).includes("\u2028"), "line separators are escaped");
  for (const bad of [NaN, Infinity, () => 1, Symbol("x"), new Date(), 10n]) {
    assert.throws(() => emitYaml({ bad }), TypeError, String(typeof bad));
  }
  const circular = {};
  circular.self = circular;
  assert.throws(() => emitYaml(circular), /circular/);
  assert.throws(() => emitYaml(undefined), TypeError);
});

// ---------------------------------------------------------------------------
// Launch files and the secret file lifecycle

function fakeIcacls() {
  const calls = [];
  return { calls, execFile: async (file, args) => { calls.push([file, ...args]); return { stdout: "", stderr: "" }; } };
}

const FILES = [
  { id: "config", target: "/app/config.yml", format: "yaml", content: { network: { port: 5000 } }, secret: false },
  { id: "tokens", target: "/app/api_tokens.yml", format: "yaml", content: { api_key: KEY }, secret: true },
  { id: "note", target: "/app/note.txt", format: "text", content: "plain\n", secret: false },
  { id: "meta", target: "/app/meta.json", format: "json", content: { a: [1, 2] }, secret: false },
];

test("launch files are written under .runtime/launch-files/<launchId>, and removed with the instance", async (t) => {
  const root = fs.mkdtempSync(path.join(EMPTY_CONFIG_DIR, "lf-"));
  const icacls = fakeIcacls();
  const store = createLaunchFiles({ root, platform: "linux", execFile: icacls.execFile });
  assert.equal(store.baseDir, path.join(root, ".runtime", "launch-files"));
  assert.equal(store.dirFor("lch_abc123"), path.join(root, ".runtime", "launch-files", "lch_abc123"));
  const written = await store.write("lch_abc123", FILES);
  assert.deepEqual(written.map((file) => [file.id, file.secret, path.basename(file.hostPath)]), [["config", false, "config.yml"], ["tokens", true, "tokens.yml"], ["note", false, "note.txt"], ["meta", false, "meta.json"]]);
  assert.deepEqual(parseYaml(fs.readFileSync(written[0].hostPath, "utf8")), { network: { port: 5000 } });
  assert.deepEqual(parseYaml(fs.readFileSync(written[1].hostPath, "utf8")), { api_key: KEY });
  assert.equal(fs.readFileSync(written[2].hostPath, "utf8"), "plain\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(written[3].hostPath, "utf8")), { a: [1, 2] });
  assert.equal(store.hostPathFor("lch_abc123", FILES[1]), written[1].hostPath, "the adapter's mount path is where the file lands");
  assert.deepEqual(icacls.calls, [], "no icacls off Windows");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(written[1].hostPath).mode & 0o777, 0o600, "the secret file is owner-only");
    assert.equal(fs.statSync(path.dirname(written[1].hostPath)).mode & 0o777, 0o700);
  }
  assert.deepEqual(store.list(), ["lch_abc123"]);
  assert.deepEqual(await store.remove("lch_abc123"), { removed: true, dir: store.dirFor("lch_abc123") });
  assert.equal(fs.existsSync(store.dirFor("lch_abc123")), false, "the secret file is gone with the instance");
  assert.deepEqual(await store.remove("lch_abc123"), { removed: false, dir: store.dirFor("lch_abc123") }, "removing twice is fine");
  assert.deepEqual(store.list(), []);
  await store.write("lch_stop00001", FILES.slice(0, 2));
  const container = { name: "vllm-local", labels: { "ai.manager.launch-id": "lch_stop00001" } };
  assert.equal((await store.removeForContainer(container)).removed, true);
  assert.equal((await store.removeForContainer({ labels: {} })).removed, false, "a container without a launch label has no files");
  assert.equal((await store.removeForContainer({ labels: { "ai.manager.launch-id": "../../x" } })).removed, false);
  t.diagnostic("launch file lifecycle ok");
});

test("on Windows a secret file and its directory are reduced to the current user with icacls", async () => {
  const root = fs.mkdtempSync(path.join(EMPTY_CONFIG_DIR, "lf-win-"));
  const icacls = fakeIcacls();
  const store = createLaunchFiles({ root, platform: "win32", env: { USERNAME: "fixture-user", USERDOMAIN: "FIXTUREPC" }, execFile: icacls.execFile });
  const written = await store.write("lch_win00001", FILES.slice(0, 2));
  const dir = store.dirFor("lch_win00001");
  assert.deepEqual(icacls.calls, [
    ["icacls", dir, "/inheritance:r", "/grant:r", "FIXTUREPC\\fixture-user:(OI)(CI)F"],
    ["icacls", written[1].hostPath, "/inheritance:r", "/grant:r", "FIXTUREPC\\fixture-user:F"],
  ], "the directory first, then only the secret file");
  // A launch without a secret file never calls icacls.
  const plain = fakeIcacls();
  const open = createLaunchFiles({ root, platform: "win32", env: { USERNAME: "fixture-user" }, execFile: plain.execFile });
  await open.write("lch_win00002", [FILES[0]]);
  assert.deepEqual(plain.calls, []);
});

test("a secret file that cannot be restricted is not left behind", async () => {
  const root = fs.mkdtempSync(path.join(EMPTY_CONFIG_DIR, "lf-fail-"));
  const failing = createLaunchFiles({
    root,
    platform: "win32",
    env: { USERNAME: "fixture-user" },
    execFile: async (file, args) => { if (args[0].endsWith("tokens.yml")) throw new Error("icacls failed"); return { stdout: "", stderr: "" }; },
  });
  await assert.rejects(() => failing.write("lch_fail0001", FILES.slice(0, 2)), /icacls failed/);
  assert.equal(fs.existsSync(failing.dirFor("lch_fail0001")), false, "the directory and the key are removed");
  const noUser = createLaunchFiles({ root, platform: "win32", env: {}, execFile: async () => ({}) });
  await assert.rejects(() => noUser.write("lch_fail0002", FILES.slice(0, 2)), (error) => error.code === "launch_file_acl_failed");
  assert.equal(fs.existsSync(noUser.dirFor("lch_fail0002")), false);
  const hostile = createLaunchFiles({ root, platform: "win32", env: { USERNAME: 'x" /grant Everyone:F' }, execFile: async () => ({}) });
  await assert.rejects(() => hostile.write("lch_fail0003", FILES.slice(0, 2)), (error) => error.code === "launch_file_acl_failed", "an odd user name never reaches icacls");
});

test("launch ids and file ids are validated; a stale directory is replaced", async () => {
  const root = fs.mkdtempSync(path.join(EMPTY_CONFIG_DIR, "lf-ids-"));
  const store = createLaunchFiles({ root, platform: "linux" });
  for (const id of ["", "../escape", "lch_", "lch_a/b", "lch_a\\b", "launch1", "lch_" + "x".repeat(60)]) {
    assert.throws(() => store.dirFor(id), (error) => error.code === "launch_id_invalid", JSON.stringify(id));
  }
  await assert.rejects(() => store.write("lch_ok0001", [{ id: "Bad Id", target: "/a", format: "text", content: "x" }]), (error) => error.code === "launch_file_invalid");
  await assert.rejects(() => store.write("lch_ok0001", [{ id: "dup", target: "/a", format: "text", content: "x" }, { id: "dup", target: "/b", format: "text", content: "y" }]), (error) => error.code === "launch_file_invalid");
  await assert.rejects(() => store.write("lch_ok0001", [{ id: "big", target: "/a", format: "text", content: "x".repeat(1024 * 1024 + 1) }]), (error) => error.code === "launch_file_too_large");
  await store.write("lch_ok0002", [{ id: "a", target: "/a", format: "text", content: "old" }]);
  const again = await store.write("lch_ok0002", [{ id: "b", target: "/b", format: "text", content: "new" }]);
  assert.deepEqual(fs.readdirSync(store.dirFor("lch_ok0002")), ["b.txt"], "the earlier attempt's files are replaced whole");
  assert.equal(fs.readFileSync(again[0].hostPath, "utf8"), "new");
  assert.deepEqual(await store.write("lch_ok0003", []), []);
  assert.equal(fs.existsSync(store.dirFor("lch_ok0003")), false, "no files, no directory");
});

// ---------------------------------------------------------------------------
// JSON metrics, capabilities, findings, memory

test("trtllm maps the iteration stats JSON through the descriptor's pick and ratio sources", () => {
  const descriptor = registry.get("trtllm");
  const payload = [
    { numActiveRequests: 9, numQueuedRequests: 9, kvCacheStats: { usedNumBlocks: 1, maxNumBlocks: 10 } },
    { numActiveRequests: 3, numQueuedRequests: 1, kvCacheStats: { usedNumBlocks: 25, maxNumBlocks: 100 } },
  ];
  const mapped = adapter.mapMetrics(payload, { descriptor, defaultModel: "served-a" });
  assert.equal(mapped.models.length, 1);
  assert.equal(mapped.models[0].model, "served-a");
  assert.deepEqual([mapped.models[0].gauges.requestsRunning, mapped.models[0].gauges.requestsWaiting, mapped.models[0].gauges.kvUsageRatio], [3, 1, 0.25], "the newest snapshot wins");
  assert.equal(mapped.models[0].gauges.specAcceptRate, null);
  assert.ok(mapped.unsupported.includes("gauges.specAcceptRate") && !mapped.unsupported.includes("gauges.requestsRunning"));
  assert.ok(mapped.unsupported.includes("counters.promptTokensTotal"), "counters the engine does not report are unsupported");
  // A broken payload yields null gauges, not a crash.
  const empty = adapter.mapMetrics({}, { descriptor });
  assert.equal(empty.models[0].gauges.requestsRunning, null);
  assert.equal(adapter.mapMetrics("nonsense", { descriptor }).models[0].gauges.kvUsageRatio, null);
});

test("findings, declared capabilities and the memory estimate come from the descriptor", () => {
  const plan = planFor({}, { gpuIds: ["0"], networkAccess: "lan" });
  const findings = adapter.validate(plan, context("lmdeploy", { runtime: { ...registry.defaultRuntime("lmdeploy"), release: { verifiedComputeCapabilityMax: "9.0" } } }));
  assert.deepEqual(findings.map((item) => [item.severity, item.code]), [["warn", "experimental_engine"], ["warn", "engine_sm120_unverified"]]);
  assert.ok(findings.every((item) => item.title.zh && item.title.en && item.detail.zh && item.detail.en));
  const trt = adapter.validate(plan, context("trtllm"));
  assert.ok(trt.some((item) => item.code === "lan_unavailable"));
  assert.ok(!trt.some((item) => item.code === "engine_sm120_unverified"), "trtllm names no verified capability limit");
  const capabilities = adapter.declaredCapabilities(planFor({ contextLength: 4096 }), context("tabbyapi"));
  assert.deepEqual(capabilities, { text: true, vision: false, audio: false, embedding: false, rerank: false, tools: false, reasoning: false, maxContext: 4096 });
  const estimate = adapter.estimateMemory(planFor({ "lmdeploy.cacheMaxEntryCount": 0.5 }), {
    ...context("lmdeploy"),
    artifact: { weightsMb: 10000, kvBytesPerToken: 100000 },
    gpus: [{ id: "0", totalMb: 97887, usedMb: 600 }],
  });
  assert.equal(estimate.admissionRequest.estimatePolicy, "free_fraction_after_weights");
  assert.ok(estimate.admissionRequest.requestedMb > 10000);
  const tabby = adapter.estimateMemory(planFor({ "tabbyapi.cacheSize": 8192 }), { ...context("tabbyapi"), artifact: { weightsMb: 10000, kvBytesPerToken: 100000 } });
  assert.equal(tabby.admissionRequest.estimatePolicy, "weights_plus_kv");
});

test("probeVersion reads the first answering version path", async () => {
  const descriptor = registry.get("lmdeploy");
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return { ok: true, text: async () => JSON.stringify({ version: "0.18.0" }) }; };
  assert.deepEqual(await adapter.probeVersion("http://127.0.0.1:8010", fetchImpl, descriptor), { version: "0.18.0", raw: { version: "0.18.0" } });
  assert.deepEqual(seen, ["http://127.0.0.1:8010/version"]);
  assert.equal(await adapter.probeVersion("http://127.0.0.1:8010", async () => ({ ok: false }), descriptor), null);
});

// ---------------------------------------------------------------------------
// The supervisor's part: files before the container, gone on failure and on replace

const CONFIG = { containerName: "vllm-local", imagePlatform: "linux/amd64", managerId: "vllm-manager" };
const GPUS = [{ index: 0, id: "0", name: "Fixture GPU", computeCapability: "12.0", driverVersion: "610.47" }];

function fakeJobs() {
  return {
    create: () => jobUtils.createJobRecord("serve", "Start fixture", {}),
    api: {
      appendLog(job, text) { for (const line of String(text || "").split("\n")) if (line) job.logs.push(line); },
      setJobProgress(job, progress) { jobUtils.applyJobProgress(job, progress); },
      scheduleJobsSave() {},
      finishJob(job, meta) { jobUtils.markJobSuccess(job, { meta }); },
      failJob(job, error) { jobUtils.markJobFailed(job, error?.message || String(error)); },
    },
  };
}

function supervisorRig({ failCreate = false, previousLaunchId = "" } = {}) {
  const root = fs.mkdtempSync(path.join(EMPTY_CONFIG_DIR, "sup-"));
  const store = createLaunchFiles({ root, platform: "linux" });
  const events = [];
  const filesAtCreate = [];
  const host = {
    kind: "docker",
    async ensureImage(image) { events.push(["ensureImage", image]); return { ok: true, pulled: false, image }; },
    async ready() { return { ok: true, version: "27.0.0-fixture", started: false }; },
    async list() { return []; },
    async inspect() { return { exists: Boolean(previousLaunchId), running: true, labels: previousLaunchId ? { "ai.manager.launch-id": previousLaunchId } : {} }; },
    async checkpoint() {
      return { hadPrevious: Boolean(previousLaunchId), async commit() { return { committed: true }; }, async rollback() { return { rolledBack: true, restoredPrevious: true }; } };
    },
    async create(cmd) {
      events.push(["create", cmd.name]);
      // The files must exist the moment the container is created.
      for (const arg of cmd.runArgs.filter((item) => /:\/(app|launch-files)\/.*:ro$/.test(String(item)))) {
        const hostPath = String(arg).replace(/:\/(app|launch-files)\/[^:]*:ro$/, "");
        filesAtCreate.push([path.basename(hostPath), fs.existsSync(hostPath)]);
      }
      if (failCreate) throw Object.assign(new Error("docker run failed"), { code: "container_create_failed" });
      return { stdout: "cid\n" };
    },
    async logs() { return ""; },
    async stop(name) { events.push(["stop", name]); return { removed: true }; },
  };
  const launchStore = {
    beginLaunch(job) { job.meta.launchId = "lch_suprig00001"; return job.meta.launchId; },
    recordCommand() {},
    markStatus() {},
  };
  const jobs = fakeJobs();
  const supervisor = createRuntimeSupervisor({
    managerId: CONFIG.managerId,
    containerBaseName: CONFIG.containerName,
    host,
    jobs: jobs.api,
    launchStore,
    launchFiles: store,
    runtimeGatePolicy: "enforce",
    probes: { nvidiaCompatibility: async () => ({ ok: true, gpus: GPUS }) },
    waitForRuntimeReady: async (options) => { options.finishJob(options.job, { ready: true }); },
    delay: async () => {},
  });
  return { root, store, supervisor, jobs, events, filesAtCreate };
}

function runFor(rig, files) {
  return {
    options: { instanceMode: "replace", containerName: CONFIG.containerName, port: 8010, gpuDeviceIds: ["0"], networkAccess: "local" },
    engineId: "tabbyapi",
    engineName: "TabbyAPI",
    containerName: CONFIG.containerName,
    port: 8010,
    cleanup: "caller",
    imagePolicy: "explicit",
    buildCommand: () => ({
      runArgs: ["run", "-d", "--name", CONFIG.containerName, "-v", `${rig.store.hostPathFor("lch_suprig00001", files[0])}:/app/config.yml:ro`, "ghcr.io/fixture/tabby:tag"],
      publish: [],
      image: "ghcr.io/fixture/tabby:tag",
      secretEnv: {},
      files,
    }),
  };
}

test("the supervisor writes the launch files right before the container exists", async () => {
  const rig = supervisorRig();
  const job = rig.jobs.create();
  await rig.supervisor.start({ job, run: runFor(rig, FILES.slice(0, 2)) });
  assert.equal(job.status, "success");
  assert.deepEqual(rig.filesAtCreate, [["config.yml", true]]);
  const dir = rig.store.dirFor("lch_suprig00001");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["config.yml", "tokens.yml"], "they stay for the life of the instance");
  assert.ok(job.logs.some((line) => /Wrote 2 generated launch file\(s\): config, tokens/.test(line)));
  assert.ok(job.logs.every((line) => !line.includes(KEY)), "the key is not logged");
});

test("a failed start removes the files it wrote", async () => {
  const rig = supervisorRig({ failCreate: true });
  const job = rig.jobs.create();
  await assert.rejects(() => rig.supervisor.start({ job, run: runFor(rig, FILES.slice(0, 2)) }), /docker run failed/);
  assert.equal(job.status, "failed");
  assert.equal(fs.existsSync(rig.store.dirFor("lch_suprig00001")), false, "no secret file survives a failed start");
});

test("replacing an instance deletes the replaced instance's own files", async () => {
  const rig = supervisorRig({ previousLaunchId: "lch_replaced001" });
  await rig.store.write("lch_replaced001", FILES.slice(0, 2));
  const job = rig.jobs.create();
  await rig.supervisor.start({ job, run: runFor(rig, FILES.slice(0, 2)) });
  assert.equal(job.status, "success");
  assert.equal(fs.existsSync(rig.store.dirFor("lch_replaced001")), false, "the old instance's api_tokens.yml is gone");
  assert.equal(fs.existsSync(rig.store.dirFor("lch_suprig00001")), true, "the new instance's files stay");
});

test("a start that needs files but has no launch-files store fails clearly", async () => {
  const rig = supervisorRig();
  const bare = createRuntimeSupervisor({
    managerId: CONFIG.managerId,
    containerBaseName: CONFIG.containerName,
    host: { kind: "docker", async ensureImage() { return { ok: true }; }, async ready() { return { ok: true, version: "1" }; }, async list() { return []; }, async inspect() { return { exists: false }; }, async checkpoint() { return { async commit() { return {}; }, async rollback() { return {}; } }; }, async create() { return { stdout: "" }; } },
    jobs: rig.jobs.api,
    launchStore: { beginLaunch(job) { job.meta.launchId = "lch_suprig00002"; }, recordCommand() {}, markStatus() {} },
    runtimeGatePolicy: "warn",
    probes: {},
    waitForRuntimeReady: async () => {},
    delay: async () => {},
  });
  const job = rig.jobs.create();
  await assert.rejects(() => bare.start({ job, run: runFor(rig, FILES.slice(0, 1)) }), (error) => error.code === "launch_files_unavailable");
});

test("instances of a template engine are hosted instances: listed with typed fields, stoppable, files removed", async () => {
  const command = build("lmdeploy");
  const labels = { "ai.manager": "vllm-manager" };
  for (let index = 0; index < command.docker.flags.length - 1; index += 1) {
    if (command.docker.flags[index] !== "--label") continue;
    const [key, ...rest] = command.docker.flags[index + 1].split("=");
    labels[key] = rest.join("=");
  }
  const container = { name: "vllm-local", running: true, image: command.docker.image, status: "Up", engine: labels["ai.manager.engine"], labels };
  const catalog = core.engines.createInstanceCatalog({ registry, managerId: "vllm" });
  assert.equal(catalog.isHosted(container), true);
  assert.equal(catalog.isKnownEngine(container), true);
  assert.equal(catalog.engineIdOf(container), "lmdeploy");
  const typed = catalog.typed({ id: "primary", models: [{ id: "served-a", maxModelLen: 8192 }] }, container);
  assert.equal(typed.engineId, "lmdeploy");
  assert.equal(typed.engineFamily, "openai-server");
  assert.equal(typed.runtime.id, "lmdeploy@0.18.0");
  assert.equal(typed.launchId, "lch_fixturelaunch0001");
  assert.equal(typed.lifecycle.state, "ready");
  assert.equal(typed.capabilities.maxContext, 8192);
  assert.equal(typed.apiSurface.chat, true);
  // Stop: the container goes, and so do the files its launch id names.
  const root = fs.mkdtempSync(path.join(EMPTY_CONFIG_DIR, "stop-"));
  const store = createLaunchFiles({ root, platform: "linux" });
  await store.write(labels["ai.manager.launch-id"], FILES.slice(0, 2));
  assert.equal(fs.existsSync(store.dirFor(labels["ai.manager.launch-id"])), true);
  assert.equal((await store.removeForContainer(container)).removed, true);
  assert.equal(fs.existsSync(store.dirFor(labels["ai.manager.launch-id"])), false);
});
