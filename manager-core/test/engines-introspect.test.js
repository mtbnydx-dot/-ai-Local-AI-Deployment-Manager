"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parseHelp, diffFlagSets, refineAutoParsers, buildIntrospectionCommand, introspectRuntime, TIMEOUT_MS } = require("../engines/introspect");
const { createEngineRegistry } = require("../engines/registry");
const { createParamCatalog, validateValues, paramAvailability } = require("../engines/param-catalog");
const { main } = require("../../scripts/introspect-engine-flags");

const ID = `sha256:${"a".repeat(64)}`;
const dockerConfig = { dockerExe: "docker-fixture", dockerArgsPrefix: [] };
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "engines", "help", `${name}.fixture`), "utf8");
const byFlag = (entries) => new Map(entries.map((entry) => [entry.flag, entry]));

function registry(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "introspect-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createEngineRegistry({ overrideDir: root, env: {} });
}

test("argparse parses wrapped choices, defaults and positive/negative aliases", () => {
  const flags = byFlag(parseHelp(fixture("vllm-argparse"), "argparse"));
  assert.equal(flags.size, 8);
  assert.deepEqual(flags.get("--kv-cache-dtype").choices, ["auto", "fp8", "fp8_e4m3", "fp8_e5m2"]);
  assert.equal(flags.get("--kv-cache-dtype").default, "auto");
  assert.equal(flags.get("--max-model-len").default, null);
  assert.deepEqual(flags.get("--enable-prefix-caching").aliases, ["--no-enable-prefix-caching"]);
  assert.equal(flags.get("--enable-prefix-caching").takesValue, false);
  assert.equal(flags.get("--enable-prefix-caching").default, true);
  assert.equal(flags.get("--port").default, 8000);
  assert.equal(flags.get("--port").group, "Model options");
});

test("SGLang argparse aliases may each have a metavar", () => {
  const flags = byFlag(parseHelp(fixture("sglang-argparse"), "argparse"));
  assert.deepEqual(flags.get("--model-path").aliases, ["--model"]);
  assert.equal(flags.get("--model-path").valueHint, "MODEL_PATH");
  assert.equal(flags.get("--mem-fraction-static").default, 0.88);
  assert.equal(flags.get("--disable-radix-cache").takesValue, false);
  assert.equal(flags.get("--disable-radix-cache").default, false);
});

test("llama help parses short aliases and wrapped env evidence", () => {
  const flags = byFlag(parseHelp(fixture("llama-help"), "llama-help"));
  assert.deepEqual(flags.get("--ctx-size").aliases, ["-c"]);
  assert.equal(flags.get("--ctx-size").default, 4096);
  assert.equal(flags.get("--ctx-size").env, "LLAMA_ARG_CTX_SIZE");
  assert.equal(flags.get("--api-key").env, "LLAMA_API_KEY");
  assert.equal(flags.get("--jinja").takesValue, false);
});

test("click parses INTEGER/TEXT choices and bracketed defaults", () => {
  const flags = byFlag(parseHelp(fixture("trtllm-click"), "click"));
  assert.equal(flags.get("--tp_size").default, 1);
  assert.equal(flags.get("--host").valueHint, "TEXT");
  assert.deepEqual(flags.get("--backend").choices, ["pytorch", "tensorrt"]);
  assert.equal(flags.get("--backend").default, "pytorch");
  assert.equal(flags.get("--trust_remote_code").takesValue, false);
});

test("help parsing ignores usage lines, removes ANSI, and rejects unknown parser names", () => {
  assert.deepEqual(parseHelp("usage: --fake FLAG\n\u001b[32mOptions:\u001b[0m\n  --real N  Count (default: 1)" ).map((entry) => entry.flag), ["--real"]);
  assert.throws(() => parseHelp("", "shell"), { code: "unknown_help_parser" });
});

test("aligned boolean help with separated default text is not a metavar", () => {
  const entry = parseHelp("Options:\n  --enabled    Enable feature.  [default: false]", "click")[0];
  assert.equal(entry.takesValue, false);
  assert.equal(entry.default, false);
});

test("diff detects added, removed, renamed by alias/help, choices and defaults", () => {
  const old = [
    { flag: "--old", help: "Deprecated, use --new.", choices: [] },
    { flag: "--before", aliases: [], choices: [] },
    { flag: "--gone", choices: [] },
    { flag: "--dtype", choices: ["auto", "fp16"], default: "fp16" },
  ];
  const fresh = [
    { flag: "--new", aliases: [], choices: [] },
    { flag: "--after", aliases: ["--before"], choices: [] },
    { flag: "--added", choices: [] },
    { flag: "--dtype", choices: ["auto", "fp8"], default: "auto" },
  ];
  const report = diffFlagSets(old, fresh, { params: [{ emit: { flag: "--dtype" } }, { emit: { flag: "--missing" } }, { emit: { flag: "--before" } }] });
  assert.deepEqual(report.added, ["--added", "--after", "--new"]);
  assert.deepEqual(report.removed, ["--before", "--gone", "--old"]);
  assert.deepEqual(report.renamed, [{ from: "--before", to: "--after", evidence: "alias" }, { from: "--old", to: "--new", evidence: "Deprecated, use --new." }]);
  assert.deepEqual(report.choicesChanged, [{ flag: "--dtype", added: ["fp8"], removed: ["fp16"] }]);
  assert.deepEqual(report.defaultsChanged, [{ flag: "--dtype", from: "fp16", to: "auto" }]);
  assert.deepEqual(report.catalogMissing, ["--missing"]);
  assert.deepEqual(report.catalogUnmapped, ["--added", "--new"]);
});

test("autoParsers refines only an auto choice with auto default and keeps descriptor values otherwise", () => {
  const original = { autoParsers: { tool: null, reasoning: "builtin" } };
  const flags = { flags: [
    { flag: "--tool-call-parser", choices: ["auto", "hermes"], default: "auto" },
    { flag: "--reasoning-parser", choices: ["auto", "qwen3"], default: "qwen3" },
  ] };
  assert.deepEqual(refineAutoParsers(original, flags).autoParsers, { tool: "auto", reasoning: "builtin" });
  assert.deepEqual(original.autoParsers, { tool: null, reasoning: "builtin" });
});

test("v2 enum validation takes introspected choices and flags absent from the runtime are errors", (t) => {
  const reg = registry(t);
  const catalogs = createParamCatalog({ overrideDir: path.join(os.tmpdir(), "absent-introspect-config") });
  const introspected = { flags: [{ flag: "--kv-cache-dtype", choices: ["auto", "brand_new_dtype"] }] };
  const catalog = catalogs.loadCatalog("vllm", { runtime: reg.defaultRuntime("vllm"), introspected });
  assert.deepEqual(validateValues({ kvCacheDtype: "brand_new_dtype" }, catalog).errors, []);
  assert.equal(validateValues({ kvCacheDtype: "fp8" }, catalog).errors[0].code, "invalid_choice");
  assert.equal(validateValues({ contextLength: 4096 }, catalog).errors[0].code, "flag_not_in_runtime");
  assert.equal(validateValues({ contextLength: 4096 }, catalog, { legacy: true }).warnings[0].code, "flag_not_in_runtime");
});

test("introspection presence wins even when every renamed flag is outside compatVersion windows", () => {
  const availability = paramAvailability({ flags: [{ flag: "--old", until: "0.1.0" }], emit: { kind: "flag-value" } }, { compatVersion: "2.0.0" }, { flags: [{ flag: "--old" }] });
  assert.equal(availability.state, "available");
  assert.equal(availability.flag, "--old");
});

test("probe command has no network, GPU, mounts, manager labels or pull", (t) => {
  const descriptor = registry(t).get("sglang");
  const command = buildIntrospectionCommand(descriptor, ID, { name: "ai-introspect-1234abcd", dockerConfig: { dockerExe: "wsl.exe", dockerArgsPrefix: ["-d", "fixture", "--exec", "docker"] } });
  assert.equal(command.command, "wsl.exe");
  assert.deepEqual(command.args.slice(0, 5), ["-d", "fixture", "--exec", "docker", "run"]);
  for (const [flag, value] of [["--network", "none"], ["--pull", "never"], ["--memory", "4g"], ["--cpus", "2"]]) assert.equal(command.args[command.args.indexOf(flag) + 1], value);
  assert.ok(command.args.includes("--rm"));
  for (const flag of ["--gpus", "--mount", "-v", "--volume", "--label", "-l", "--privileged", "--env", "-e"]) assert.ok(!command.args.includes(flag));
  assert.ok(!command.args.some((arg) => arg.includes("ai.manager")));
  assert.throws(() => buildIntrospectionCommand(descriptor, ID, { name: "vllm-local" }), { code: "invalid_probe_name" });
});

test("fake execution probes the inspected ID, stores flags and enforces the default timeout", async (t) => {
  const calls = [];
  const writes = [];
  const result = await introspectRuntime("vllm", "vllm@0.28.0", {
    registry: registry(t), dockerConfig,
    runtimeFacts: { imageId: async () => ID, put: async (...args) => writes.push(args) },
    execFileAsync: async (...args) => { calls.push(args); return { stdout: fixture("vllm-argparse"), stderr: "" }; },
  });
  assert.equal(calls[0][2].timeout, TIMEOUT_MS);
  assert.equal(calls[0][1][calls[0][1].indexOf("--entrypoint") + 2], ID);
  assert.equal(result.flags.flags.length, 8);
  assert.equal(result.flags.rawSha256.length, 64);
  assert.deepEqual(writes[0].slice(0, 2), ["vllm@0.28.0", "flags"]);
  assert.deepEqual(writes[0][3], { imageId: ID });
});

test("missing images never spawn a probe or pull", async (t) => {
  let calls = 0;
  await assert.rejects(introspectRuntime("vllm", "vllm@0.28.0", { registry: registry(t), dockerConfig, runtimeFacts: { imageId: async () => null }, execFileAsync: async () => { calls += 1; } }), { code: "runtime_image_missing" });
  assert.equal(calls, 0);
});

test("timeout cleanup removes only the probe name and never writes a partial snapshot", async (t) => {
  const calls = [];
  let writes = 0;
  await assert.rejects(introspectRuntime("vllm", "vllm@0.28.0", {
    registry: registry(t), dockerConfig, name: "ai-introspect-1234abcd",
    runtimeFacts: { imageId: async () => ID, put: async () => { writes += 1; } },
    execFileAsync: async (_command, args) => { calls.push(args); if (args[0] === "run") throw Object.assign(new Error("timeout"), { killed: true }); return { stdout: "" }; },
  }), { code: "introspection_timeout" });
  assert.deepEqual(calls[1], ["rm", "-f", "ai-introspect-1234abcd"]);
  assert.equal(writes, 0);
});

test("a failed help command or unrecognized output never writes facts", async (t) => {
  for (const execFileAsync of [async () => { throw new Error("bad command"); }, async () => ({ stdout: "unrecognized format", stderr: "" })]) {
    await assert.rejects(introspectRuntime("vllm", "vllm@0.28.0", { registry: registry(t), dockerConfig, runtimeFacts: { imageId: async () => ID, put: async () => assert.fail("must not write") }, execFileAsync }), /bad command|no recognized flags/);
  }
});

test("CLI help and malformed invocation have no side effects; a valid invocation uses the same runner", async (t) => {
  let calls = 0;
  const output = [];
  const options = { registry: registry(t), runtimeFacts: {}, output: (value) => output.push(value), introspectRuntime: async (engineId, runtimeId) => { calls += 1; return { engineId, runtimeId }; } };
  assert.equal(await main(["--help"], options), 0);
  assert.equal(await main(["vllm"], options), 2);
  assert.equal(calls, 0);
  assert.equal(await main(["vllm", "vllm@0.28.0"], options), 0);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(output.at(-1)), { engineId: "vllm", runtimeId: "vllm@0.28.0" });
});
