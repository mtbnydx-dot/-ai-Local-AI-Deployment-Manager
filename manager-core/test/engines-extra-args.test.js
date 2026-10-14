"use strict";

// validateExtraArgs / validateExtraEnv (01-engines ENG-15, section 18) and the
// way the adapters append what they accepted. Pure: a fake model-storage
// object stands in for the registered roots; nothing touches disk or Docker.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-extra-args-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");
const { validateExtraArgs, validateExtraEnv } = require("../engines/extra-args");
const { applyExtra } = require("../engines/adapters/_docker-segments");

const registry = core.engines.createEngineRegistry({ env: {}, overrideDir: EMPTY_CONFIG_DIR });
const SGLANG = registry.get("sglang");
const LLAMA = registry.get("llamacpp");
const ROOT = "C:/fixture/models";

const storage = {
  fromContainerPath: (value) => (String(value).startsWith("/models/") ? `${ROOT}${String(value).slice(7)}` : String(value)),
  resolvePath(value) {
    if (!String(value).startsWith(`${ROOT}/`) || String(value).includes("..")) throw new Error("outside");
    return value;
  },
  toContainerPath(value) {
    const local = storage.fromContainerPath(value);
    storage.resolvePath(local);
    return `/models${local.slice(ROOT.length)}`;
  },
};

const catalog = {
  params: [
    { id: "contextLength", type: "int", emit: { kind: "flag", flag: "--context-length" } },
    { id: "tokenizer", type: "path", emit: { kind: "flag", flag: "--tokenizer-path" } },
    { id: "schedulePolicy", type: "string", flags: [{ flag: "--schedule-policy" }] },
  ],
};

const introspected = {
  flags: [
    { flag: "--schedule-policy", aliases: [], takesValue: true, valueHint: "{lpm,fcfs}" },
    { flag: "--tokenizer-path", aliases: [], takesValue: true, valueHint: "TOKENIZER_PATH" },
    { flag: "--context-length", aliases: [], takesValue: true, valueHint: "CONTEXT_LENGTH" },
    { flag: "--chat-template", aliases: [], takesValue: true, valueHint: "CHAT_TEMPLATE_FILE" },
    { flag: "--enable-mixed-chunk", aliases: [], takesValue: false, valueHint: null },
    { flag: "--port", aliases: ["-p"], takesValue: true, valueHint: "PORT" },
    { flag: "--model-path", aliases: ["--model"], takesValue: true, valueHint: "MODEL_PATH" },
  ],
};

const codes = (result) => result.errors.map((item) => item.code);

test("a verified flag and its value pass through unchanged", () => {
  const result = validateExtraArgs(["--schedule-policy", "lpm", "--enable-mixed-chunk"], { catalog, introspected, descriptor: SGLANG, storage });
  assert.equal(result.ok, true);
  assert.deepEqual(result.args, ["--schedule-policy", "lpm", "--enable-mixed-chunk"]);
  assert.deepEqual(result.warnings, []);
  const inline = validateExtraArgs(["--schedule-policy=lpm"], { catalog, introspected, descriptor: SGLANG, storage });
  assert.deepEqual(inline.args, ["--schedule-policy=lpm"]);
});

test("managed flags and their aliases are denied", () => {
  for (const tokens of [["--port", "9000"], ["--port=9000"], ["-p", "9000"], ["--model-path", "x"], ["--api-key", "k"], ["--host", "0.0.0.0"]]) {
    const result = validateExtraArgs(tokens, { catalog, introspected, descriptor: SGLANG, storage });
    assert.equal(result.ok, false, tokens.join(" "));
    assert.equal(result.errors[0]?.code, "extra_arg_denied", tokens.join(" "));
    assert.deepEqual(result.args, [], "nothing is passed on after an error");
  }
  const negated = validateExtraArgs(["--no-enable-metrics"], { catalog, descriptor: SGLANG, storage });
  assert.deepEqual(codes(negated), ["extra_arg_denied"]);
});

test("a flag owned by a set parameter is a duplicate", () => {
  const set = validateExtraArgs(["--context-length", "4096"], { catalog, introspected, descriptor: SGLANG, storage, values: { contextLength: 65536 } });
  assert.deepEqual(codes(set), ["extra_arg_denied"]);
  assert.equal(set.errors[0].reason, "duplicate");
  const unset = validateExtraArgs(["--context-length", "4096"], { catalog, introspected, descriptor: SGLANG, storage, values: { contextLength: "" } });
  assert.equal(unset.ok, true);
});

test("with introspection an unknown flag is an error; without it, an unverified warning", () => {
  const known = validateExtraArgs(["--no-such-flag", "1"], { catalog, introspected, descriptor: SGLANG, storage });
  assert.deepEqual(codes(known), ["extra_arg_unknown"]);
  const unverified = validateExtraArgs(["--no-such-flag", "1"], { catalog, descriptor: SGLANG, storage });
  assert.equal(unverified.ok, true);
  assert.deepEqual(unverified.warnings.map((item) => item.code), ["extra_arg_unverified"]);
  assert.deepEqual(unverified.args, ["--no-such-flag", "1"]);
  // A catalog-known flag needs no introspection.
  const fromCatalog = validateExtraArgs(["--schedule-policy", "lpm"], { catalog, descriptor: SGLANG, storage });
  assert.deepEqual(fromCatalog.warnings, []);
});

test("token shape: no stray values, no shell trickery, size limits", () => {
  const opts = { catalog, introspected, descriptor: SGLANG, storage };
  assert.deepEqual(codes(validateExtraArgs(["lpm"], opts)), ["extra_arg_invalid"]);
  assert.deepEqual(codes(validateExtraArgs(["--enable-mixed-chunk", "yes"], opts)), ["extra_arg_invalid"]);
  assert.deepEqual(codes(validateExtraArgs(["--schedule-policy", "a\nb"], opts)), ["extra_arg_invalid"]);
  assert.deepEqual(codes(validateExtraArgs(["--schedule-policy", "a\0b"], opts)), ["extra_arg_invalid"]);
  assert.deepEqual(codes(validateExtraArgs(["--schedule-policy", "x".repeat(4097)], opts)), ["extra_arg_invalid"]);
  assert.deepEqual(codes(validateExtraArgs(Array(65).fill("--enable-mixed-chunk"), opts)), ["extra_arg_invalid"]);
  assert.deepEqual(codes(validateExtraArgs("--x", opts)), ["extra_arg_invalid"]);
  assert.deepEqual(codes(validateExtraArgs([5], opts)), ["extra_arg_invalid"]);
  // Shell syntax is just text: the value is one argv element.
  const text = validateExtraArgs(["--schedule-policy", "$(id); rm -rf /"], opts);
  assert.equal(text.ok, true);
  assert.deepEqual(text.args, ["--schedule-policy", "$(id); rm -rf /"]);
  assert.equal(validateExtraArgs(undefined, { catalog, descriptor: SGLANG }).ok, true);
  assert.deepEqual(validateExtraArgs([], { catalog, descriptor: SGLANG }).args, []);
});

test("path-valued flags are confined to the model storage roots and rewritten", () => {
  const opts = { catalog, introspected, descriptor: SGLANG, storage };
  const inside = validateExtraArgs(["--tokenizer-path", `${ROOT}/tok`, "--chat-template", `${ROOT}/t.jinja`], opts);
  assert.equal(inside.ok, true);
  assert.deepEqual(inside.args, ["--tokenizer-path", "/models/tok", "--chat-template", "/models/t.jinja"]);
  const inline = validateExtraArgs([`--tokenizer-path=${ROOT}/tok`], opts);
  assert.deepEqual(inline.args, ["--tokenizer-path=/models/tok"]);
  const container = validateExtraArgs(["--tokenizer-path", "/models/tok"], opts);
  assert.deepEqual(container.args, ["--tokenizer-path", "/models/tok"]);

  for (const bad of ["C:/Windows/system.ini", "/etc/passwd", "relative/dir", `${ROOT}/../outside`]) {
    const result = validateExtraArgs(["--chat-template", bad], opts);
    assert.deepEqual(codes(result), ["extra_arg_denied"], bad);
  }
  // Without a storage object a path flag cannot be confined, so it is refused.
  assert.deepEqual(codes(validateExtraArgs(["--tokenizer-path", `${ROOT}/tok`], { catalog, introspected, descriptor: SGLANG })), ["extra_arg_denied"]);
  // The catalog marks path params even when no help text names the value.
  assert.deepEqual(codes(validateExtraArgs(["--tokenizer-path", "/etc/passwd"], { catalog, descriptor: SGLANG, storage })), ["extra_arg_denied"]);
});

test("extraEnv: name shape, allowed prefixes, denylist and value limits", () => {
  const ok = validateExtraEnv({ SGLANG_ENABLE_X: "1", NCCL_DEBUG: "WARN", TORCH_LOGS: 1 }, { descriptor: SGLANG });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.env, { SGLANG_ENABLE_X: "1", NCCL_DEBUG: "WARN", TORCH_LOGS: "1" });

  const denied = [
    "OPENAI_API_KEY", "SGLANG_API_KEY", "HF_TOKEN", "HF_HOME", "MY_TOKEN_FILE", "CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES",
    "LD_PRELOAD", "PYTHONPATH", "PATH", "HOME", "HTTP_PROXY", "NO_PROXY",
  ];
  for (const name of denied) {
    // Even a descriptor that allowed every prefix could not set these.
    const result = validateExtraEnv({ [name]: "x" }, { descriptor: { ...SGLANG, extraEnvAllow: [""] } });
    assert.deepEqual(codes(result), ["extra_env_denied"], name);
  }
  assert.deepEqual(codes(validateExtraEnv({ MY_SETTING: "1" }, { descriptor: SGLANG })), ["extra_env_denied"]);
  assert.deepEqual(codes(validateExtraEnv({ SGLANG_X: "1" }, { descriptor: { ...SGLANG, extraEnvAllow: [] } })), ["extra_env_denied"]);
  assert.deepEqual(codes(validateExtraEnv({ sglang_x: "1" }, { descriptor: SGLANG })), ["extra_env_invalid"]);
  assert.deepEqual(codes(validateExtraEnv({ [`S${"X".repeat(64)}`]: "1" }, { descriptor: SGLANG })), ["extra_env_invalid"]);
  assert.deepEqual(codes(validateExtraEnv({ SGLANG_X: "a\0b" }, { descriptor: SGLANG })), ["extra_env_invalid"]);
  assert.deepEqual(codes(validateExtraEnv({ SGLANG_X: "x".repeat(4097) }, { descriptor: SGLANG })), ["extra_env_invalid"]);
  assert.deepEqual(codes(validateExtraEnv({ SGLANG_X: { a: 1 } }, { descriptor: SGLANG })), ["extra_env_invalid"]);
  assert.deepEqual(codes(validateExtraEnv(["A"], { descriptor: SGLANG })), ["extra_env_invalid"]);
});

test("LLAMA_ARG_* names the platform owns are denied for llama.cpp, others stay allowed", () => {
  const descriptor = { ...LLAMA, extraEnvAllow: ["LLAMA_"] };
  for (const name of ["LLAMA_ARG_PORT", "LLAMA_ARG_HOST", "LLAMA_ARG_API_KEY", "LLAMA_ARG_ALIAS", "LLAMA_ARG_MODEL"]) {
    assert.deepEqual(codes(validateExtraEnv({ [name]: "1" }, { descriptor })), ["extra_env_denied"], name);
  }
  assert.equal(validateExtraEnv({ LLAMA_ARG_N_GPU_LAYERS: "99" }, { descriptor }).ok, true);
});

test("applyExtra appends args last and env before the label block, and leaves an empty command alone", () => {
  const make = () => ({ docker: { flags: ["--name", "x", "-e", "A=1", "--label", "k=v"], image: "img", args: ["serve", "--port", "8000"] } });
  const untouched = make();
  assert.equal(applyExtra(untouched, undefined), untouched);
  assert.deepEqual(applyExtra(make(), { args: [], env: {} }), make());
  const command = applyExtra(make(), { args: ["--schedule-policy", "lpm"], env: { SGLANG_X: "1" } });
  assert.deepEqual(command.docker.args, ["serve", "--port", "8000", "--schedule-policy", "lpm"]);
  assert.deepEqual(command.docker.flags, ["--name", "x", "-e", "A=1", "-e", "SGLANG_X=1", "--label", "k=v"]);
});
