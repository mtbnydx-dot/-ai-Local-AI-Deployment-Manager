"use strict";

// Redaction in the engine layer (01-engines ENG-15, section 18, 00 section 9.4).
// There is one redactor, manager-core/secret-redactor.js, and one marker,
// <redacted>. These tests pin: the legacy redactDockerArgs exports are thin
// wrappers over it, a LaunchCommand carries no key in anything it renders,
// SGLang still passes --api-key in argv but shows it redacted, and no second
// secret-replacing helper has crept into the engine layer. Fake keys only.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-redaction-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");
const { REDACTED, createSecretRedactor, redactSecrets } = require("../secret-redactor");
const { createVllmRuntimeCommandBuilder } = require("../../vllm-manager/lib/runtime-command");
const { createLlamaRuntimeCommandBuilder } = require("../../llama-manager/lib/runtime-command");

const engines = core.engines;
const registry = engines.createEngineRegistry({ env: {}, overrideDir: EMPTY_CONFIG_DIR });
const FAKE_KEY = "fixture-redaction-api-key-0001";
const SHORT_KEY = "abc";
const REPO_ROOT = path.join(__dirname, "..", "..");

function sglangPlan() {
  return {
    engineId: "sglang",
    values: { servedName: "fixture-model", contextLength: 32768, concurrency: 4, "sglang.memFractionStatic": 0.85 },
    fixed: { args: [], env: {}, labels: [], dockerFlags: [], slots: {} },
    instance: { port: 8001, networkAccess: "local", serviceHost: "127.0.0.1", gpuIds: ["0"] },
    legacy: { preset: {}, runOptions: {}, quantization: {} },
  };
}

function sglangCtx(extra) {
  return {
    descriptor: registry.get("sglang"),
    runtime: { runtimeId: "sglang@fixture", manifestKey: null, image: "fixture/sglang:pinned", features: {}, compatVersion: null },
    host: {
      kind: "docker",
      containerPort: 8000,
      config: {
        modelsRoot: "C:/fixture/models",
        hfCache: "C:/fixture/cache/hf",
        vllmCache: "C:/fixture/cache/vllm",
        sglangCache: "C:/fixture/cache/sglang",
        containerName: "vllm-local",
        managerLabelValue: "vllm-manager",
      },
      labelKeys: { manager: "ai.manager", engine: "ai.manager.engine", apiKeyRef: "ai.manager.api-key-ref" },
      modelMountArgs: ["-v", "C:/fixture/models:/models"],
    },
    model: { modelArg: "/models/fixture-model", effectiveLoadFormat: "auto", localPath: "C:/fixture/models/fixture-model" },
    hostFacts: { platform: "linux", gpus: [], env: {} },
    secrets: { apiKey: FAKE_KEY },
    extra,
    jobId: "serve-fixture",
    admission: { leaseId: "lease-fixture", vramReservationMb: 1234 },
    launchId: null,
    toContainerPath: (value) => String(value).replace("C:/fixture/models", "/models"),
    dockerGpuArg: (ids) => `device=${ids.join(",")}`,
    dockerPublishArgs: (port, _access, host) => [`${host || "127.0.0.1"}:${port}:8000`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    normalizeGpuIds: (ids) => ids || [],
    lanAddress: () => "192.0.2.10",
  };
}

test("server_args dumps and api_key assignments are redacted to <redacted>", () => {
  const dump = `server_args=ServerArgs(model_path='/models/m', api_key='${FAKE_KEY}', port=8000)`;
  const out = redactSecrets(dump);
  assert.equal(out.includes(FAKE_KEY), false);
  assert.ok(out.includes(REDACTED));
  assert.equal(REDACTED, "<redacted>");
  assert.equal(redactSecrets(`Authorization: Bearer ${FAKE_KEY}`).includes(FAKE_KEY), false);
  // The shared instance applies exact secrets to log lines, ledgers and excerpts alike.
  const redactor = createSecretRedactor({ getSecrets: () => [FAKE_KEY] });
  const line = `engine echoed ${FAKE_KEY} here`;
  assert.equal(redactor.redact(line), `engine echoed ${REDACTED} here`);
  const record = { logs: [line], failure: { logExcerpt: line }, meta: { launchCommand: `docker run --api-key ${FAKE_KEY}` } };
  assert.equal(JSON.stringify(redactor.redactValue(record)).includes(FAKE_KEY), false);
});

test("redactDockerArgs in both managers is the secret-redactor wrapper with the <redacted> marker", () => {
  const vllm = createVllmRuntimeCommandBuilder({ CONFIG: {} });
  const llama = createLlamaRuntimeCommandBuilder({ CONFIG: {} });
  const argv = ["run", "--api-key", FAKE_KEY, `--env=K=${FAKE_KEY}`, "image"];
  const vllmOut = vllm.redactDockerArgs(argv, { vllmApiKey: FAKE_KEY });
  const llamaOut = llama.redactDockerArgs(argv, { llamaApiKey: FAKE_KEY });
  for (const out of [vllmOut, llamaOut]) {
    assert.deepEqual(out, ["run", "--api-key", REDACTED, `--env=K=${REDACTED}`, "image"]);
    assert.equal(JSON.stringify(out).includes("***"), false);
  }
  // Too short to be a real key: left alone, as the redactor's minimum length says.
  assert.deepEqual(vllm.redactDockerArgs(["--x", SHORT_KEY], { vllmApiKey: SHORT_KEY }), ["--x", SHORT_KEY]);
  // No secret known: the same array comes back.
  assert.equal(vllm.redactDockerArgs(argv, {}), argv);
});

test("an SGLang command keeps --api-key in argv and every rendering of it is redacted", () => {
  const command = engines.adapters.sglang.buildLaunch(sglangPlan(), sglangCtx());
  const runArgs = engines.renderRunArgs(command);
  assert.equal(runArgs[runArgs.indexOf("--api-key") + 1], FAKE_KEY, "the executed argv carries the key");
  assert.deepEqual(command.redactions, [FAKE_KEY]);
  assert.equal(JSON.stringify(command.labels).includes(FAKE_KEY), false);
  assert.equal(JSON.stringify(command.metaPatch).includes(FAKE_KEY), false);
  assert.equal(JSON.stringify(command.logs).includes(FAKE_KEY), false);

  const { view, planHash } = engines.launchPlan.commandView(command);
  const text = JSON.stringify(view);
  assert.equal(text.includes(FAKE_KEY), false, "plan command has no key");
  assert.equal(view.argv[view.argv.indexOf("--api-key") + 1], REDACTED);
  assert.match(planHash, /^sha256:[0-9a-f]{64}$/);

  // A stored record is built from the redacted view only.
  const stored = JSON.stringify({ spec: { secrets: { apiKeyRef: "ref-1" } }, resolved: { argvRedacted: view.argv } });
  assert.equal(stored.includes(FAKE_KEY), false);
});

test("extraArgs and extraEnv ride in the command last and never alter the redaction", () => {
  const extra = { args: ["--schedule-policy", "lpm"], env: { SGLANG_FIXTURE_FLAG: "1" } };
  const plain = engines.adapters.sglang.buildLaunch(sglangPlan(), sglangCtx());
  const withExtra = engines.adapters.sglang.buildLaunch(sglangPlan(), sglangCtx(extra));
  assert.deepEqual(withExtra.docker.args.slice(0, plain.docker.args.length), plain.docker.args);
  assert.deepEqual(withExtra.docker.args.slice(plain.docker.args.length), extra.args);
  const flags = withExtra.docker.flags;
  assert.ok(flags.join(" ").includes("-e SGLANG_FIXTURE_FLAG=1"));
  assert.equal(flags.indexOf("-e") < flags.indexOf("--label"), true, "labels stay the last docker flags");
  const view = engines.launchPlan.commandView(withExtra).view;
  assert.equal(JSON.stringify(view).includes(FAKE_KEY), false);
  assert.equal(view.env.SGLANG_FIXTURE_FLAG, "1");
  // Without extras the command is the one the goldens pin.
  assert.deepEqual(engines.renderRunArgs(plain), engines.renderRunArgs(engines.adapters.sglang.buildLaunch(sglangPlan(), sglangCtx({ args: [], env: {} }))));
});

test("there is no engines/redact.js and no second secret-replacing helper in the engine layer", () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "manager-core", "engines", "redact.js")), false);
  const dirs = [
    path.join(REPO_ROOT, "manager-core", "engines"),
    path.join(REPO_ROOT, "vllm-manager", "lib"),
    path.join(REPO_ROOT, "llama-manager", "lib"),
  ];
  const offenders = [];
  for (const dir of dirs) {
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith(".js")) {
          const source = fs.readFileSync(full, "utf8");
          // The old marker, or an ad-hoc `.replace(` of a key by a literal marker.
          if (/["'`]\*\*\*["'`]/.test(source) || /\.replace\([^)]*(?:api[_-]?key|secret|token)[^)]*,\s*["'`]\[?(?:redacted|REDACTED)/i.test(source)) {
            offenders.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
          }
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});
