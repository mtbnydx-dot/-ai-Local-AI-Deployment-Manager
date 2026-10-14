"use strict";

// Shared harness for the engine golden fixtures (01-engines §8). The capture
// script and the golden tests run every fixture through this module, so a
// fixture means the same thing everywhere: the deterministic stub sets copied
// from the existing builder and launch-request tests, a throwaway model library
// for the cases that load a manager, and one runner per fixture kind.
//
// Fixtures never hold a secret or a machine path. Inputs name secrets as
// "<secret:apiKey>" and local paths under the canonical root "C:/fixture"; the
// runner swaps in fake values and a temp directory before the call, and maps
// them back to "<redacted>" and "C:/fixture" in the captured result.
//
// runGoldenFixture(fixture, overrides) accepts replacement modules
// (vllmRuntimeCommand, llamaRuntimeCommand, vllmLaunchRequest, ...) so later
// packages can run the same fixtures through their adapters.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "manager-core", "test", "fixtures", "engines");
const GOLDEN_DIR = path.join(FIXTURES_DIR, "goldens");
const MODEL_SAMPLES_DIR = path.join(FIXTURES_DIR, "model-samples");
const CANONICAL_ROOT = "C:/fixture";
const REDACTED = "<redacted>";
const FUNCTION_MARKER = "<function>";
// Obviously fake values behind the "<secret:name>" placeholders. They exist
// only in this file and in the process running a fixture.
const FAKE_SECRETS = Object.freeze({
  apiKey: "golden-fixture-api-key-0001",
  hfToken: "golden-fixture-hf-token-0001",
});
const SECRET_PLACEHOLDER = /^<secret:([A-Za-z0-9]+)>$/;
// Manager configuration that would otherwise leak the host into a capture:
// image overrides, model roots, cache roots, tokens and tool locations.
const MANAGER_ENV = /^(?:AI|VLLM|SGLANG|LLAMA|HF|HUGGINGFACE|MODEL|MODELSCOPE|DOCKER|DEVTOOLS|WSL|OPEN_WEBUI|PYTHON|MANAGER)_/i;
const SERVER_FILES = {
  vllm: path.join(REPO_ROOT, "vllm-manager", "server.js"),
  llama: path.join(REPO_ROOT, "llama-manager", "server.js"),
};
// Module-scope functions of server.js that the profile pipeline needs but the
// managers do not export. The harness reads them without changing server.js.
const SERVER_INTERNALS = {
  vllm: [
    "MANAGER_LABEL_KEY", "MANAGER_ENGINE_LABEL_KEY", "MANAGER_APIKEY_REF_LABEL_KEY",
    "normalizeLaunchConfig", "normalizeLoadFormat", "normalizeReasoningParser", "normalizeToolCallParser",
    "inferToolCallParser", "resolveLaunchModel", "effectiveLaunchQuantization", "windowsPathToContainerPath",
    "publishArgsToDockerRunArgs", "modelStorage",
  ],
  llama: [
    "MANAGER_LABEL_KEY", "MANAGER_ENGINE_LABEL_KEY", "MANAGER_APIKEY_REF_LABEL_KEY",
    "normalizeGpuLayers", "normalizeLlamaCacheType", "normalizeOnOffAuto", "normalizeLlamaReasoningFormat",
    "normalizeLlamaReasoningEffort", "normalizeLlamaReasoningBudget", "normalizeLlamaMmprojDevice",
    "normalizeDefaultTrueBoolean", "dockerGpuArg", "windowsPathToContainerPath", "publishArgsToDockerRunArgs",
    "modelStorage",
  ],
};
const TEST_LABEL_KEYS = Object.freeze({
  MANAGER_LABEL_KEY: "ai.manager",
  MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
  MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
});

// ---------------------------------------------------------------------------
// Stub sets. Builder sets return the docker/path lambdas; profile sets return
// the probes a launch would otherwise make; request sets take a recorder and
// return the full launch-request dependency object of the source test.

const publishArgsToDockerRunArgs = (args) => args.flatMap((arg) => ["-p", arg]);
const testModelPath = (value) => String(value).replace("D:/AI/models", "/models").replaceAll("\\", "/");

const BUILDER_STUB_SETS = {
  // vllm-manager/test/runtime-command.test.js (the first test's lambdas).
  "vllm-test-v1": () => ({
    dockerGpuArg: (ids) => `device=${ids.join(",")}`,
    dockerPublishArgs: (port, _networkAccess, host) => [`${host || "127.0.0.1"}:${port}:8000`],
    publishArgsToDockerRunArgs,
    windowsPathToContainerPath: testModelPath,
    normalizeGpuIds: (value) => value,
    getLanAddress: () => "192.168.1.27",
  }),
  // vllm-manager/test/pennyroyal.test.js.
  "vllm-pennyroyal-test-v1": () => ({
    dockerGpuArg: () => "device=0",
    dockerPublishArgs: (port) => [`127.0.0.1:${port}:8000`],
    publishArgsToDockerRunArgs,
    windowsPathToContainerPath: (value) => value,
    normalizeGpuIds: (value) => value,
    getLanAddress: () => "127.0.0.1",
  }),
  // llama-manager/test/runtime-command.test.js, remote GGUF / hetero test.
  "llama-test-v1": () => ({
    dockerGpuArg: () => "all",
    dockerPublishArgs: (port, _networkAccess, host) => [`${host || "127.0.0.1"}:${port}:8080`],
    publishArgsToDockerRunArgs,
    normalizeGpuIds: (value) => value,
    normalizeDefaultTrueBoolean: (value, fallback) => value ?? fallback,
    windowsPathToContainerPath: testModelPath,
  }),
  // llama-manager/test/runtime-command.test.js, mmproj/MTP and Muse tests.
  "llama-test-v2": () => ({
    dockerGpuArg: () => "device=0",
    dockerPublishArgs: () => ["127.0.0.1:8080:8080"],
    publishArgsToDockerRunArgs,
    normalizeGpuIds: (value) => value,
    normalizeDefaultTrueBoolean: (value, fallback) => value ?? fallback,
    windowsPathToContainerPath: testModelPath,
  }),
};

// Profile pipelines use the managers' own normalisers, path mapping and
// docker helpers; only the host probes are stubbed.
const PROFILE_STUB_SETS = {
  "vllm-profile-v1": (input) => ({
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: [] }),
    getLanAddress: () => "192.168.1.27",
    hostGpus: clone(input.hostGpus || []),
  }),
  "llama-profile-v1": (input) => ({
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: [] }),
    getLanAddress: () => "192.168.1.27",
    getGpuStatus: async () => ({ ok: true, gpus: clone(input.hostGpus || []) }),
  }),
};

function vllmRequestBaseDeps(recorder) {
  return {
    CONFIG: { defaultPort: 8000, containerName: "vllm-local", managerId: "vllm-manager" },
    positiveInt: (value, fallback) => Number(value || fallback),
    reportGpuAdmissionError: (_job, error) => recorder.call(`reportGpuAdmissionError:${error.message}`),
  };
}

function testLease(recorder, summary, { releaseError = "" } = {}) {
  return {
    summary,
    startHeartbeat: () => {
      recorder.call("heartbeat-start");
      return () => recorder.call("heartbeat-stop");
    },
    commit: async (metadata) => recorder.call(`commit:${metadata?.jobId || ""}:${metadata?.containerName || ""}`),
    release: async (reason) => {
      recorder.call(`release:${reason}`);
      if (releaseError) throw new Error(releaseError);
    },
  };
}

const REQUEST_STUB_SETS = {
  // vllm-manager/test/launch-request.test.js, "builds serve job metadata and run options".
  "vllm-request-test-v1": (recorder) => ({
    ...vllmRequestBaseDeps(recorder),
    cleanRequired: (value, name) => {
      if (!value) throw new Error(`${name} required`);
      return String(value);
    },
    deriveName: (model) => model.split("/").pop(),
    nonNegativeNumber: (value, fallback) => Math.max(0, Number(value || fallback)),
    optionalNonNegativeNumber: (value) => (value == null || value === "" ? null : Math.max(0, Number(value))),
    normalizeDtype: (value) => value || "auto",
    normalizeQuantization: (value) => value || "",
    normalizeLoadFormat: (value) => value || "auto",
    cleanOptionalLaunchArg: (value) => String(value || "").trim(),
    normalizeKvCacheDtype: (value) => value || "auto",
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: ["mixed GPUs"] }),
    normalizeGpuIds: (value) => String(value || "").split(",").filter(Boolean),
    normalizeClientPreset: (value) => value || "openai",
    normalizeReasoningParser: (value) => value || "",
    normalizeToolCallParser: (value) => value || "",
    inferToolCallParser: () => "qwen3_coder",
    normalizeNetworkAccess: (value) => value || "local",
    normalizeSpeculativeMode: (value) => value || "off",
    checkModelCompatibility: async (input) => {
      recorder.call("checkModelCompatibility");
      recorder.record("compatibilityRequest", input);
      return { ok: true, findings: [] };
    },
    getLanAddress: () => "192.168.1.27",
    createJob: (type, title, meta) => recorder.createJob({ id: "serve-1", type, title, meta }),
    runStartJob: (job, options) => {
      recorder.startJob(options);
      job.status = "success";
      return Promise.resolve();
    },
    failJob: (_job, error) => recorder.call(`failJob:${error.message}`),
    saveRuntimeApiKey: async (secret) => {
      recorder.call("saveRuntimeApiKey");
      return `ref-${secret}`;
    },
    deleteRuntimeApiKey: async (reference) => recorder.call(`deleteRuntimeApiKey:${reference}`),
    acquireGpuAdmission: async (input) => {
      recorder.call("acquireGpuAdmission");
      recorder.record("gpuAdmissionRequest", input);
      return testLease(recorder, {
        id: "lease-vllm",
        requestedTotalMb: 12000,
        reservations: [{ gpuId: "GPU-A", gpuIndex: "0", requestedMb: 6000 }, { gpuId: "GPU-B", gpuIndex: "1", requestedMb: 6000 }],
      });
    },
  }),
  // vllm-manager/test/launch-request.test.js, "binds an implicit GPU selection to the admitted device".
  "vllm-request-implicit-gpu-v1": (recorder) => ({
    ...vllmRequestBaseDeps(recorder),
    cleanRequired: (value) => String(value || "model"),
    deriveName: () => "model",
    nonNegativeNumber: (value, fallback) => Number(value || fallback),
    optionalNonNegativeNumber: () => null,
    normalizeDtype: () => "auto",
    normalizeQuantization: () => "",
    normalizeLoadFormat: () => "auto",
    cleanOptionalLaunchArg: () => "",
    normalizeKvCacheDtype: () => "auto",
    normalizeLaunchGpuSelection: async () => ({ gpuDeviceIds: [], selectedCount: 2, warnings: [] }),
    normalizeGpuIds: () => [],
    normalizeClientPreset: () => "openai",
    normalizeReasoningParser: () => "",
    normalizeToolCallParser: () => "",
    inferToolCallParser: () => "",
    normalizeNetworkAccess: () => "local",
    getLanAddress: () => "127.0.0.1",
    createJob: (type, title, meta) => recorder.createJob({ id: "serve-implicit", type, title, meta }),
    runStartJob: async (job, options) => {
      recorder.startJob(options);
      job.status = "success";
    },
    failJob: (_job, error) => recorder.call(`failJob:${error.message}`),
    acquireGpuAdmission: async (input) => {
      recorder.call("acquireGpuAdmission");
      recorder.record("gpuAdmissionRequest", input);
      return testLease(recorder, {
        id: "lease-implicit",
        requestedTotalMb: 8000,
        reservations: [{ gpuId: "GPU-A", gpuIndex: "0", requestedMb: 8000 }],
      });
    },
  }),
  // vllm-manager/test/launch-request.test.js, "replace launch acquires after preparation ...".
  "vllm-request-replace-v1": (recorder) => ({
    ...vllmRequestBaseDeps(recorder),
    cleanRequired: (value) => String(value || "model"),
    deriveName: () => "model",
    nonNegativeNumber: (value, fallback) => Number(value || fallback),
    optionalNonNegativeNumber: () => null,
    normalizeDtype: () => "auto",
    normalizeQuantization: () => "",
    normalizeLoadFormat: () => "auto",
    cleanOptionalLaunchArg: () => "",
    normalizeKvCacheDtype: () => "auto",
    normalizeLaunchGpuSelection: async () => ({ gpuDeviceIds: ["0"], selectedCount: 1, warnings: [] }),
    normalizeGpuIds: () => ["0"],
    normalizeClientPreset: () => "openai",
    normalizeReasoningParser: () => "",
    normalizeToolCallParser: () => "",
    inferToolCallParser: () => "",
    normalizeNetworkAccess: () => "local",
    getLanAddress: () => "127.0.0.1",
    createJob: (type, title, meta) => recorder.createJob({ id: "replace-job", type, title, meta, status: "running" }),
    runStartJob: async (job, options) => {
      recorder.startJob(options);
      const context = await options.prepareGpuAdmission(async (admissionRequest) => {
        recorder.call(`prepare:${admissionRequest.instanceMode}`);
        admissionRequest.retireLeaseIds = ["old-lease"];
        return { marker: "prepared" };
      });
      recorder.call(`context:${context.marker}`);
      job.status = "failed";
    },
    failJob: (_job, error) => recorder.call(`failJob:${error.message}`),
    saveRuntimeApiKey: async () => {
      recorder.call("saveRuntimeApiKey");
      return "ref-replace";
    },
    deleteRuntimeApiKey: async (reference) => recorder.call(`deleteRuntimeApiKey:${reference}`),
    acquireGpuAdmission: async () => { throw new Error("replace must not acquire before preparation"); },
    acquireGpuAdmissionAfterPrepare: async (admissionRequest, prepare) => {
      recorder.call("acquireGpuAdmissionAfterPrepare");
      recorder.record("gpuAdmissionRequest", admissionRequest);
      const context = await prepare(admissionRequest);
      recorder.call(`retireLeaseIds:${(admissionRequest.retireLeaseIds || []).join(",")}`);
      return {
        context,
        lease: testLease(recorder, {
          id: "new-lease",
          requestedTotalMb: 9000,
          reservations: [{ gpuId: "0", gpuIndex: "0", requestedMb: 9000 }],
        }, { releaseError: "release failed" }),
      };
    },
  }),
  // llama-manager/test/launch-request.test.js, "keeps hetero GPU plan and tensor split in sync".
  "llama-request-test-v1": (recorder) => llamaRequestTestDeps(recorder, { estimateStub: true }),
  // The same dependencies with the real local-GGUF VRAM estimate
  // (llama-manager/test/launch-request.test.js, "parallel VRAM estimate uses local GGUF size").
  "llama-request-estimate-v1": (recorder) => llamaRequestTestDeps(recorder, { estimateStub: false }),
};

function llamaRequestTestDeps(recorder, { estimateStub }) {
  return {
    CONFIG: { defaultPort: 8080, containerName: "llama-local", managerId: "llama-manager" },
    cleanRequired: (value, name) => {
      if (!value) throw new Error(`${name} required`);
      return String(value);
    },
    deriveName: (model) => model.split(/[\\/]/).pop(),
    positiveInt: (value, fallback) => Number(value || fallback),
    normalizeGpuLayers: (value) => value === "auto" ? "auto" : (value == null || value === "" ? -1 : Number(value)),
    normalizeLlamaCacheType: (value) => value || "q8_0",
    normalizeOnOffAuto: (value) => value || "auto",
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: ["hetero"] }),
    normalizeGpuIds: (value) => String(value || "").split(",").filter(Boolean),
    normalizeLlamaSplitMode: (value) => value || "layer",
    cleanOptionalLaunchArg: (value) => String(value || "").trim(),
    normalizeClientPreset: (value) => value || "openai",
    normalizeLlamaReasoningFormat: (value) => value || "none",
    normalizeDefaultTrueBoolean: (value) => value !== false,
    normalizeNetworkAccess: (value) => value || "local",
    getLanAddress: () => "192.168.1.27",
    getGpuStatus: async () => ({ gpus: [{ id: "0" }, { id: "1" }] }),
    buildLlamaGpuPlan: () => ({ mainGpu: "0", mainGpuHostId: "host-0" }),
    suggestTensorSplit: () => "2,1",
    createJob: (type, title, meta) => recorder.createJob({ id: "serve-llama", type, title, meta }),
    runStartJob: (job, options) => {
      recorder.startJob(options);
      job.status = "success";
      return Promise.resolve();
    },
    failJob: (_job, error) => recorder.call(`failJob:${error.message}`),
    saveRuntimeApiKey: async (secret) => {
      recorder.call("saveRuntimeApiKey");
      return `ref-${secret}`;
    },
    deleteRuntimeApiKey: async (reference) => recorder.call(`deleteRuntimeApiKey:${reference}`),
    reportGpuAdmissionError: (_job, error) => recorder.call(`reportGpuAdmissionError:${error.message}`),
    ...(estimateStub ? {
      estimateParallelVram: async () => {
        recorder.call("estimateParallelVram");
        return { requestedMb: 10000, requestedMbByGpu: { 0: 5000, 1: 5000 }, estimatePolicy: "test_local_gguf_estimate" };
      },
    } : {}),
    acquireGpuAdmission: async (input) => {
      recorder.call("acquireGpuAdmission");
      recorder.record("gpuAdmissionRequest", input);
      return testLease(recorder, {
        id: "lease-llama",
        requestedTotalMb: 10000,
        reservations: [{ gpuId: "GPU-A", gpuIndex: "0", requestedMb: 5000 }, { gpuId: "GPU-B", gpuIndex: "1", requestedMb: 5000 }],
      });
    },
  };
}

function builderStubs(name) {
  const factory = BUILDER_STUB_SETS[name];
  if (!factory) throw new Error(`Unknown builder stub set "${name}".`);
  return factory();
}

// ---------------------------------------------------------------------------
// Environment: one temp root per process, the manager env scrubbed, and the
// managers pointed at it before they are loaded.

let environment = null;

function prepareGoldenEnvironment() {
  if (environment) return environment;
  for (const file of Object.values(SERVER_FILES)) {
    if (require.cache[file]) throw new Error(`${path.relative(REPO_ROOT, file)} was loaded before the golden environment was prepared.`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-goldens-"));
  const modelsRoot = path.join(root, "models");
  const aiRoot = path.join(root, "ai");
  fs.mkdirSync(modelsRoot, { recursive: true });
  fs.mkdirSync(aiRoot, { recursive: true });
  for (const name of Object.keys(process.env)) {
    if (MANAGER_ENV.test(name)) delete process.env[name];
  }
  Object.assign(process.env, {
    AI_ROOT: aiRoot,
    VLLM_MODELS_ROOT: modelsRoot,
    LLAMA_MODELS_ROOT: modelsRoot,
    MODEL_STORAGE_FILE: path.join(aiRoot, "model-storage.json"),
    MODEL_GPU_ADMISSION_ROOT: path.join(aiRoot, "gpu-admission"),
  });
  process.once("exit", () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });
  environment = { root, modelsRoot, aiRoot, rootPattern: rootPattern(root) };
  return environment;
}

function rootPattern(root) {
  const variants = new Set();
  for (const resolve of [(value) => value, fs.realpathSync, fs.realpathSync.native]) {
    let resolved;
    try { resolved = resolve(root); } catch { continue; }
    variants.add(resolved);
    variants.add(resolved.replaceAll("\\", "/"));
    variants.add(resolved.replaceAll("/", "\\"));
  }
  const alternatives = Array.from(variants)
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(alternatives.join("|"), "gi");
}

const loadedServers = {};

// Requires server.js with one extra line appended at compile time that exposes
// the SERVER_INTERNALS bindings. The file on disk is not changed.
function loadServer(manager) {
  if (loadedServers[manager]) return loadedServers[manager];
  prepareGoldenEnvironment();
  const file = SERVER_FILES[manager];
  const names = SERVER_INTERNALS[manager];
  const originalCompile = Module.prototype._compile;
  Module.prototype._compile = function compileWithGoldenInternals(content, filename, ...rest) {
    if (filename === file) {
      const pairs = names.map((name) => `${JSON.stringify(name)}: typeof ${name} === "undefined" ? undefined : ${name}`);
      content = `${content}\n;module.exports.__engineGoldenInternals = { ${pairs.join(", ")} };\n`;
    }
    return originalCompile.call(this, content, filename, ...rest);
  };
  let server;
  try {
    server = require(file);
  } finally {
    Module.prototype._compile = originalCompile;
  }
  const internals = server.__engineGoldenInternals;
  if (!internals) throw new Error(`${path.relative(REPO_ROOT, file)} was loaded without the golden internals.`);
  const missing = names.filter((name) => internals[name] === undefined);
  if (missing.length) {
    throw new Error(`${path.relative(REPO_ROOT, file)} no longer defines ${missing.join(", ")}; update SERVER_INTERNALS in the golden harness.`);
  }
  loadedServers[manager] = { server, internals };
  return loadedServers[manager];
}

// ---------------------------------------------------------------------------
// Value mapping between fixture form and runtime form.

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// JSON form of a captured value: functions become "<function>" so that their
// presence is pinned; undefined members drop out as they would in a ledger.
function toJsonValue(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "function" ? FUNCTION_MARKER : item)));
}

function mapStrings(value, mapString) {
  if (typeof value === "string") return mapString(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, mapString));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = mapStrings(item, mapString);
    return result;
  }
  return value;
}

function materializeValue(value, env) {
  return mapStrings(value, (text) => {
    const secret = text.match(SECRET_PLACEHOLDER);
    if (secret) {
      if (!Object.hasOwn(FAKE_SECRETS, secret[1])) throw new Error(`Unknown fixture secret "${secret[1]}".`);
      return FAKE_SECRETS[secret[1]];
    }
    if (text === CANONICAL_ROOT || text.startsWith(`${CANONICAL_ROOT}/`)) {
      return path.join(env.root, ...text.slice(CANONICAL_ROOT.length).split("/").filter(Boolean));
    }
    if (text.includes(CANONICAL_ROOT)) throw new Error(`Fixture paths must start with ${CANONICAL_ROOT}: ${text}`);
    return text;
  });
}

function canonicalizeValue(value, env) {
  const secrets = Object.values(FAKE_SECRETS);
  return mapStrings(value, (text) => {
    let result = text;
    for (const secret of secrets) result = result.split(secret).join(REDACTED);
    env.rootPattern.lastIndex = 0;
    if (env.rootPattern.test(result)) {
      env.rootPattern.lastIndex = 0;
      result = result.replace(env.rootPattern, CANONICAL_ROOT).replaceAll("\\", "/");
    }
    return result;
  });
}

function applyCaseEnvironment(envSpec = {}) {
  const savedEnv = [];
  let savedPlatform = null;
  for (const [name, raw] of Object.entries(envSpec)) {
    if (name === "platform") {
      savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: String(raw), configurable: true, enumerable: true, writable: false });
      continue;
    }
    savedEnv.push([name, Object.hasOwn(process.env, name) ? process.env[name] : undefined]);
    const value = raw === null || raw === undefined ? null : mapStrings(String(raw), (text) => {
      const secret = text.match(SECRET_PLACEHOLDER);
      return secret ? FAKE_SECRETS[secret[1]] : text;
    });
    if (value === null || value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of savedEnv.reverse()) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
  };
}

// ---------------------------------------------------------------------------
// Model samples: JSON descriptions of checkpoint files, materialised under the
// temp model library ("C:/fixture/models").

function resetModelLibrary(env) {
  fs.rmSync(env.modelsRoot, { recursive: true, force: true });
  fs.mkdirSync(env.modelsRoot, { recursive: true });
}

function readModelSample(name) {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(String(name))) throw new Error(`Invalid model sample name "${name}".`);
  return JSON.parse(fs.readFileSync(path.join(MODEL_SAMPLES_DIR, `${name}.json`), "utf8"));
}

function materializeModelSample(name, env) {
  const sample = readModelSample(name);
  for (const entry of sample.entries || []) {
    const relative = String(entry.path || "");
    if (!relative || relative.startsWith("/") || relative.split("/").includes("..")) throw new Error(`Invalid sample path "${relative}" in ${name}.`);
    const target = path.join(env.modelsRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, sampleEntryBytes(entry, name));
  }
  return sample;
}

function sampleEntryBytes(entry, name) {
  if (Object.hasOwn(entry, "json")) return `${JSON.stringify(entry.json, null, 2)}\n`;
  if (Object.hasOwn(entry, "text")) return String(entry.text);
  if (Object.hasOwn(entry, "zeros")) return Buffer.alloc(Number(entry.zeros));
  if (Object.hasOwn(entry, "gguf")) return encodeGguf(entry.gguf);
  throw new Error(`Sample entry ${entry.path} in ${name} has no json, text, zeros or gguf content.`);
}

// The GGUF writer of llama-manager/test/launch-request.test.js: strings, uint32
// numbers and boolean arrays, one tensor record, then zero padding.
function encodeGguf({ version = 3, metadata = {}, tensors = [{ name: "weight", elements: 1000 }], padding = 0 } = {}) {
  const u32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(Number(value)); return buffer; };
  const u64 = (value) => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer; };
  const str = (value) => { const content = Buffer.from(String(value)); return Buffer.concat([u64(content.length), content]); };
  const kv = [];
  for (const [key, value] of Object.entries(metadata)) {
    let encoded;
    let type;
    if (typeof value === "string") {
      type = 8;
      encoded = str(value);
    } else if (Array.isArray(value)) {
      type = 9;
      encoded = Buffer.concat([u32(7), u64(value.length), ...value.map((item) => Buffer.from([item ? 1 : 0]))]);
    } else {
      type = 4;
      encoded = u32(value);
    }
    kv.push(str(key), u32(type), encoded);
  }
  const tensorInfo = tensors.flatMap((tensor) => [str(tensor.name), u32(1), u64(tensor.elements), u32(0), u64(0)]);
  return Buffer.concat([
    Buffer.from("GGUF"), u32(version), u64(tensors.length), u64(Object.keys(metadata).length),
    ...kv,
    ...tensorInfo,
    Buffer.alloc(Number(padding || 0)),
  ]);
}

// ---------------------------------------------------------------------------
// Runners.

function defaultModules(overrides = {}) {
  const lazy = (name, file) => overrides[name] || require(path.join(REPO_ROOT, file));
  return {
    get vllmRuntimeCommand() { return lazy("vllmRuntimeCommand", "vllm-manager/lib/runtime-command.js"); },
    get llamaRuntimeCommand() { return lazy("llamaRuntimeCommand", "llama-manager/lib/runtime-command.js"); },
    get vllmLaunchRequest() { return lazy("vllmLaunchRequest", "vllm-manager/lib/launch-request.js"); },
    get llamaLaunchRequest() { return lazy("llamaLaunchRequest", "llama-manager/lib/launch-request.js"); },
    get vllmDefaultProfiles() { return lazy("vllmDefaultProfiles", "vllm-manager/lib/default-profiles.js"); },
    get llamaDefaultProfiles() { return lazy("llamaDefaultProfiles", "llama-manager/lib/default-profiles.js"); },
    get vllmModelCapabilities() { return lazy("vllmModelCapabilities", "vllm-manager/lib/model-capabilities.js"); },
    get llamaGpuPlan() { return lazy("llamaGpuPlan", "llama-manager/lib/gpu-plan.js"); },
    get core() { return lazy("core", "manager-core/index.js"); },
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function assertFixtureSecretEnv(secretEnv) {
  const allowed = new Set(Object.values(FAKE_SECRETS));
  for (const [name, value] of Object.entries(secretEnv || {})) {
    if (!allowed.has(String(value))) throw new Error(`secretEnv.${name} carries a value that is not a fixture secret.`);
  }
}

// The builder expect block: the legacy return value plus job.meta and the
// appendLog lines. A builder that throws records the message instead.
function builderExpect(build, { job, logs, jobsSaved = null }) {
  let result = null;
  let error = null;
  try {
    result = build();
  } catch (caught) {
    error = String(caught?.message || caught);
  }
  assertFixtureSecretEnv(result?.secretEnv);
  const expect = {
    runArgs: result ? result.runArgs : null,
    activePublishArgs: result ? result.activePublishArgs : null,
    secretEnvNames: result ? Object.keys(result.secretEnv || {}).sort() : null,
    runtimeImage: result ? result.runtimeImage ?? null : null,
    runtimeEngine: result ? result.runtimeEngine ?? null : null,
    jobMeta: job?.meta ?? null,
    logs,
  };
  if (jobsSaved) expect.scheduleJobsSaveCalls = jobsSaved();
  if (error !== null) expect.error = error;
  return expect;
}

function runVllmBuilder({ fixture, input, modules }) {
  const logs = [];
  let jobsSaved = 0;
  const { buildVllmRuntimeCommand } = modules.vllmRuntimeCommand.createVllmRuntimeCommandBuilder({
    CONFIG: clone(input.config),
    ...(input.modelMountArgs ? { getModelMountArgs: () => clone(input.modelMountArgs) } : {}),
    ...TEST_LABEL_KEYS,
    appendLog: (_job, line) => logs.push(String(line)),
    scheduleJobsSave: () => { jobsSaved += 1; },
    ...builderStubs(fixture.stubs),
    resolveLaunchModel: () => clone(input.launch),
    effectiveLaunchQuantization: () => clone(input.quantization),
    resolveVllmRuntimePreset: () => clone(input.preset),
  });
  const job = clone(input.job);
  return builderExpect(() => buildVllmRuntimeCommand(job, clone(input.opts)), { job, logs, jobsSaved: () => jobsSaved });
}

function runLlamaBuilder({ fixture, input, modules }) {
  const logs = [];
  const { buildLlamaRuntimeCommand } = modules.llamaRuntimeCommand.createLlamaRuntimeCommandBuilder({
    CONFIG: clone(input.config),
    ...(input.modelMountArgs ? { getModelMountArgs: () => clone(input.modelMountArgs) } : {}),
    ...TEST_LABEL_KEYS,
    appendLog: (_job, line) => logs.push(String(line)),
    ...builderStubs(fixture.stubs),
    resolveLaunchModel: () => clone(input.launch),
  });
  const job = clone(input.job);
  return builderExpect(() => buildLlamaRuntimeCommand(job, clone(input.opts)), { job, logs });
}

// capabilities.runtimeMetadata is the runtime-manifest entry of the base image,
// passed through untouched. The golden keeps its identity only, so additive
// manifest fields (01 ENG-2) do not rewrite every PRE fixture; the values that
// matter to a launch are already pinned through unsupportedReason and notes.
function runVllmPreset({ input }) {
  const { server } = loadServer("vllm");
  const preset = server.resolveVllmRuntimePreset(clone(input.opts), clone(input.launch || {}));
  const metadata = preset?.capabilities?.runtimeMetadata;
  if (metadata && typeof metadata === "object") {
    preset.capabilities = {
      ...preset.capabilities,
      runtimeMetadata: { repository: metadata.repository ?? null, version: metadata.version ?? null },
    };
  }
  return { preset };
}

function findProfile(profiles, profileId) {
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Builtin launch profile "${profileId}" does not exist.`);
  return profile;
}

function profileStubs(name, input) {
  const factory = PROFILE_STUB_SETS[name];
  if (!factory) throw new Error(`Unknown profile stub set "${name}".`);
  return factory(input);
}

// builtin profile -> normalizeLaunchConfig -> launch-request normalisation ->
// preset -> builder, with the manager's own functions at every step.
async function runVllmProfile({ fixture, input, modules }) {
  const { server, internals } = loadServer("vllm");
  const core = modules.core;
  const stubs = profileStubs(fixture.stubs, input);
  const profile = findProfile(modules.vllmDefaultProfiles.createVllmDefaultLaunchProfiles(internals.normalizeLaunchConfig), input.profileId);
  let started = null;
  const startRuntimeRequest = modules.vllmLaunchRequest.createVllmStartRuntimeRequest({
    CONFIG: server.CONFIG,
    cleanRequired: core.cleanRequired,
    deriveName: core.deriveName,
    positiveInt: core.positiveInt,
    nonNegativeNumber: core.nonNegativeNumber,
    optionalNonNegativeNumber: core.optionalNonNegativeNumber,
    normalizeDtype: server.normalizeDtype,
    normalizeQuantization: server.normalizeQuantization,
    normalizeLoadFormat: internals.normalizeLoadFormat,
    cleanOptionalLaunchArg: core.cleanOptionalLaunchArg,
    normalizeKvCacheDtype: core.normalizeKvCacheDtype,
    normalizeLaunchGpuSelection: stubs.normalizeLaunchGpuSelection,
    normalizeGpuIds: core.normalizeGpuIds,
    normalizeClientPreset: core.normalizeClientPreset,
    normalizeReasoningParser: internals.normalizeReasoningParser,
    normalizeToolCallParser: internals.normalizeToolCallParser,
    inferToolCallParser: internals.inferToolCallParser,
    normalizeNetworkAccess: core.normalizeNetworkAccess,
    normalizeSpeculativeMode: modules.vllmModelCapabilities.normalizeSpeculativeMode,
    normalizeRuntimeEngine: modules.vllmRuntimeCommand.normalizeRuntimeEngine,
    getLanAddress: stubs.getLanAddress,
    createJob: (type, title, meta) => ({ id: input.jobId, type, title, meta }),
    runStartJob: async (job, options) => { started = { job, options }; },
    failJob: () => {},
    normalizeRuntimeInstanceMode: core.normalizeRuntimeInstanceMode,
    normalizeRuntimeInstanceId: core.normalizeRuntimeInstanceId,
    buildRuntimeContainerName: core.buildRuntimeContainerName,
  });
  await startRuntimeRequest({ body: { ...profile.config, model: input.model } });
  await settle();
  if (!started) throw new Error(`Profile ${input.profileId} did not reach runStartJob.`);
  const logs = [];
  let jobsSaved = 0;
  const { buildVllmRuntimeCommand } = modules.vllmRuntimeCommand.createVllmRuntimeCommandBuilder({
    getModelMountArgs: () => internals.modelStorage.dockerMountArgs(),
    CONFIG: server.CONFIG,
    MANAGER_LABEL_KEY: internals.MANAGER_LABEL_KEY,
    MANAGER_ENGINE_LABEL_KEY: internals.MANAGER_ENGINE_LABEL_KEY,
    MANAGER_APIKEY_REF_LABEL_KEY: internals.MANAGER_APIKEY_REF_LABEL_KEY,
    appendLog: (_job, line) => logs.push(String(line)),
    scheduleJobsSave: () => { jobsSaved += 1; },
    dockerGpuArg: server.dockerGpuArg,
    dockerPublishArgs: server.dockerPublishArgs,
    publishArgsToDockerRunArgs: internals.publishArgsToDockerRunArgs,
    windowsPathToContainerPath: internals.windowsPathToContainerPath,
    normalizeGpuIds: core.normalizeGpuIds,
    getLanAddress: stubs.getLanAddress,
    resolveLaunchModel: internals.resolveLaunchModel,
    effectiveLaunchQuantization: internals.effectiveLaunchQuantization,
    resolveVllmRuntimePreset: server.resolveVllmRuntimePreset,
  });
  // runStartJobOnce adds the probed host GPUs before it builds the command.
  const runtimeOpts = { ...started.options, hostGpus: stubs.hostGpus };
  return builderExpect(() => buildVllmRuntimeCommand(started.job, runtimeOpts), { job: started.job, logs, jobsSaved: () => jobsSaved });
}

async function runLlamaProfile({ fixture, input, modules }) {
  const { server, internals } = loadServer("llama");
  const core = modules.core;
  const gpuPlan = modules.llamaGpuPlan;
  const stubs = profileStubs(fixture.stubs, input);
  const profile = findProfile(modules.llamaDefaultProfiles.createLlamaDefaultLaunchProfiles(server.normalizeLaunchConfig), input.profileId);
  const logs = [];
  let started = null;
  const startRuntimeRequest = modules.llamaLaunchRequest.createLlamaStartRuntimeRequest({
    CONFIG: server.CONFIG,
    cleanRequired: core.cleanRequired,
    deriveName: core.deriveName,
    positiveInt: core.positiveInt,
    normalizeGpuLayers: internals.normalizeGpuLayers,
    normalizeLlamaCacheType: internals.normalizeLlamaCacheType,
    normalizeOnOffAuto: internals.normalizeOnOffAuto,
    normalizeLaunchGpuSelection: stubs.normalizeLaunchGpuSelection,
    normalizeGpuIds: core.normalizeGpuIds,
    normalizeLlamaSplitMode: gpuPlan.normalizeLlamaSplitMode,
    cleanOptionalLaunchArg: core.cleanOptionalLaunchArg,
    normalizeClientPreset: core.normalizeClientPreset,
    normalizeLlamaReasoningFormat: internals.normalizeLlamaReasoningFormat,
    normalizeLlamaReasoningEffort: internals.normalizeLlamaReasoningEffort,
    normalizeLlamaReasoningBudget: internals.normalizeLlamaReasoningBudget,
    normalizeLlamaMmprojDevice: internals.normalizeLlamaMmprojDevice,
    normalizeDefaultTrueBoolean: internals.normalizeDefaultTrueBoolean,
    normalizeNetworkAccess: core.normalizeNetworkAccess,
    getLanAddress: stubs.getLanAddress,
    getGpuStatus: stubs.getGpuStatus,
    buildLlamaGpuPlan: gpuPlan.buildLlamaGpuPlan,
    suggestTensorSplit: gpuPlan.suggestTensorSplit,
    createJob: (type, title, meta) => ({ id: input.jobId, type, title, meta }),
    runStartJob: async (job, options) => { started = { job, options }; },
    failJob: () => {},
    normalizeRuntimeInstanceMode: core.normalizeRuntimeInstanceMode,
    normalizeRuntimeInstanceId: core.normalizeRuntimeInstanceId,
    buildRuntimeContainerName: core.buildRuntimeContainerName,
    resolveLaunchModel: server.resolveLaunchModel,
    appendLog: (_job, line) => logs.push(String(line)),
  });
  await startRuntimeRequest({ body: { ...profile.config, model: input.model } });
  await settle();
  if (!started) throw new Error(`Profile ${input.profileId} did not reach runStartJob.`);
  const { buildLlamaRuntimeCommand } = modules.llamaRuntimeCommand.createLlamaRuntimeCommandBuilder({
    getModelMountArgs: () => internals.modelStorage.dockerMountArgs(),
    CONFIG: server.CONFIG,
    MANAGER_LABEL_KEY: internals.MANAGER_LABEL_KEY,
    MANAGER_ENGINE_LABEL_KEY: internals.MANAGER_ENGINE_LABEL_KEY,
    MANAGER_APIKEY_REF_LABEL_KEY: internals.MANAGER_APIKEY_REF_LABEL_KEY,
    appendLog: (_job, line) => logs.push(String(line)),
    dockerGpuArg: internals.dockerGpuArg,
    dockerPublishArgs: server.dockerPublishArgs,
    publishArgsToDockerRunArgs: internals.publishArgsToDockerRunArgs,
    normalizeGpuIds: core.normalizeGpuIds,
    normalizeDefaultTrueBoolean: internals.normalizeDefaultTrueBoolean,
    windowsPathToContainerPath: internals.windowsPathToContainerPath,
    resolveLaunchModel: server.resolveLaunchModel,
  });
  return builderExpect(() => buildLlamaRuntimeCommand(started.job, started.options), { job: started.job, logs });
}

// Launch-request goldens: the dependency calls in order, the admission request
// and run options as the dependencies saw them, and job.meta once settled.
function createRequestRecorder() {
  const state = { calls: [], records: {}, job: null, runOptions: null };
  return {
    call(name) { state.calls.push(String(name)); },
    record(name, value) { if (!Object.hasOwn(state.records, name)) state.records[name] = toJsonValue(value); },
    createJob(job) {
      state.calls.push("createJob");
      state.job = job;
      return job;
    },
    startJob(options) {
      state.calls.push("runStartJob");
      state.runOptions = toJsonValue(options);
    },
    expect(error) {
      const expect = { calls: state.calls };
      if (Object.hasOwn(state.records, "compatibilityRequest")) expect.compatibilityRequest = state.records.compatibilityRequest;
      expect.gpuAdmissionRequest = state.records.gpuAdmissionRequest ?? null;
      expect.runOptions = state.runOptions;
      expect.jobMeta = state.job?.meta ?? null;
      expect.jobStatus = state.job?.status ?? null;
      if (error) expect.error = error;
      return expect;
    },
  };
}

async function runRequest({ fixture, input, modules }, create) {
  const factory = REQUEST_STUB_SETS[fixture.stubs];
  if (!factory) throw new Error(`Unknown request stub set "${fixture.stubs}".`);
  const recorder = createRequestRecorder();
  const request = create(factory(recorder));
  let error = null;
  try {
    await request({ body: clone(input.body) });
  } catch (caught) {
    error = { message: String(caught?.message || caught), code: caught?.code ?? null, status: caught?.status ?? null };
  }
  await settle();
  return recorder.expect(error);
}

const RUNNERS = {
  "vllm:builder": runVllmBuilder,
  "llama:builder": runLlamaBuilder,
  "vllm:preset": runVllmPreset,
  "vllm:profile": runVllmProfile,
  "llama:profile": runLlamaProfile,
  "vllm:request": (context) => runRequest(context, (deps) => context.modules.vllmLaunchRequest.createVllmStartRuntimeRequest(deps)),
  "llama:request": (context) => runRequest(context, (deps) => context.modules.llamaLaunchRequest.createLlamaStartRuntimeRequest(deps)),
};

// Runs one fixture (its input, env and stubs; expect is ignored) and returns
// the expect block it produces, in canonical fixture form.
async function runGoldenFixture(fixture, overrides = {}) {
  const env = prepareGoldenEnvironment();
  const runner = RUNNERS[`${fixture.manager}:${fixture.kind}`];
  if (!runner) throw new Error(`No golden runner for manager "${fixture.manager}" and kind "${fixture.kind}".`);
  resetModelLibrary(env);
  const input = materializeValue(fixture.input || {}, env);
  if (input.modelFixture) materializeModelSample(input.modelFixture, env);
  const restore = applyCaseEnvironment(fixture.env || {});
  try {
    const result = await runner({ fixture, input, env, modules: defaultModules(overrides) });
    return canonicalizeValue(toJsonValue(result), env);
  } finally {
    restore();
    resetModelLibrary(env);
  }
}

function loadGoldenFixtures(dir = GOLDEN_DIR) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
}

// The identity needles of the release privacy scan (user and machine name,
// profile and repository paths), the home directory in both slash forms, the
// temp root of this run and the fake secret values, applied to fixture text.
// Returns the needles that match.
function findMachineData(text) {
  const home = os.homedir();
  const needles = new Set([
    process.env.USERNAME,
    process.env.USER,
    process.env.COMPUTERNAME,
    process.env.USERPROFILE,
    home,
    home.replaceAll("\\", "/"),
    REPO_ROOT,
    ...Object.values(FAKE_SECRETS),
  ]);
  try { needles.add(os.userInfo().username); } catch {}
  try { needles.add(os.hostname()); } catch {}
  const haystack = String(text).toLowerCase();
  const hits = Array.from(needles)
    .filter((needle) => typeof needle === "string" && needle.trim().length >= 3)
    .filter((needle) => haystack.includes(needle.toLowerCase()));
  if (environment) {
    environment.rootPattern.lastIndex = 0;
    if (environment.rootPattern.test(String(text))) hits.push("temp root");
    environment.rootPattern.lastIndex = 0;
  }
  return hits;
}

module.exports = {
  BUILDER_STUB_SETS,
  CANONICAL_ROOT,
  FAKE_SECRETS,
  GOLDEN_DIR,
  MODEL_SAMPLES_DIR,
  PROFILE_STUB_SETS,
  REDACTED,
  REPO_ROOT,
  REQUEST_STUB_SETS,
  encodeGguf,
  findMachineData,
  loadGoldenFixtures,
  loadServer,
  materializeModelSample,
  prepareGoldenEnvironment,
  readModelSample,
  runGoldenFixture,
  toJsonValue,
};
