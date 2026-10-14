"use strict";

// The recipe and catalog expression language (01-engines §10.2): operators,
// three-valued logic over unknown facts, the AST limits, the env allowlist and
// the regex bound.

const assert = require("node:assert/strict");
const test = require("node:test");

const expr = require("../engines/expr");

const { UNKNOWN, compileExpr, evaluate, validateExpr } = expr;

function codes(result) {
  return result.errors.map((item) => item.code);
}

test("comparison operators compare JSON values deeply", () => {
  assert.equal(evaluate({ eq: [1, 1] }), true);
  assert.equal(evaluate({ eq: ["a", "b"] }), false);
  assert.equal(evaluate({ eq: [{ const: { a: [1, 2] } }, { const: { a: [1, 2] } }] }), true);
  assert.equal(evaluate({ ne: [{ const: [1] }, { const: [2] }] }), true);
  assert.equal(evaluate({ in: ["fp8", ["auto", "fp8"]] }), true);
  assert.equal(evaluate({ in: [null, ["off", null]] }), true);
  assert.equal(evaluate({ notIn: ["mtp", ["off", null]] }), true);
  assert.equal(evaluate({ in: ["x", "not-a-list"] }), false);
  assert.equal(evaluate({ gt: [3, 2] }), true);
  assert.equal(evaluate({ gte: [2, 2] }), true);
  assert.equal(evaluate({ lt: [2, 3] }), true);
  assert.equal(evaluate({ lte: [3, 2] }), false);
  // Ordering needs two numbers.
  assert.equal(evaluate({ gt: ["3", 2] }), false);
  assert.equal(evaluate({ lt: [null, 2] }), false);
});

test("logic operators, isSet, coalesce and if", () => {
  assert.equal(evaluate({ and: [true, { eq: [1, 1] }] }), true);
  assert.equal(evaluate({ and: [true, false] }), false);
  assert.equal(evaluate({ or: [false, { eq: [1, 1] }] }), true);
  assert.equal(evaluate({ or: [false, false] }), false);
  assert.equal(evaluate({ not: true }), false);
  assert.equal(evaluate({ not: [false] }), true);
  // Only the boolean true counts as true.
  assert.equal(evaluate({ not: "yes" }), true);
  assert.equal(evaluate({ and: [1] }), false);
  assert.equal(evaluate({ isSet: { param: "a" } }, { param: { a: 0 } }), true);
  assert.equal(evaluate({ isSet: { param: "a" } }, { param: {} }), false);
  assert.equal(evaluate({ coalesce: [{ user: "contextLength" }, 262144] }, { user: {} }), 262144);
  assert.equal(evaluate({ coalesce: [{ user: "contextLength" }, 262144] }, { user: { contextLength: 131072 } }), 131072);
  assert.equal(evaluate({ coalesce: [null, null] }), null);
  assert.equal(evaluate({ if: [{ eq: [1, 1] }, "a", "b"] }), "a");
  assert.equal(evaluate({ if: [{ eq: [1, 2] }, "a", "b"] }), "b");
});

test("arithmetic works on numbers and gives null otherwise", () => {
  assert.equal(evaluate({ min: [4, 1, 3] }), 1);
  assert.equal(evaluate({ max: [1, { floorDiv: [8, 5] }] }), 1);
  assert.equal(evaluate({ add: [1, 2, 3] }), 6);
  assert.equal(evaluate({ sub: [10, 4] }), 6);
  assert.equal(evaluate({ mul: [2, 3, 4] }), 24);
  assert.equal(evaluate({ floorDiv: [7, 2] }), 3);
  assert.equal(evaluate({ floorDiv: [7, 0] }), null);
  assert.equal(evaluate({ add: [1, "2"] }), null);
  assert.equal(evaluate({ min: [1, null] }), null);
  // The validated Flash-Next derivation: min(coalesce(user concurrency, 1), max(1, floor(cache/5))).
  const derived = {
    min: [
      { coalesce: [{ user: "concurrency" }, 1] },
      { max: [1, { floorDiv: [{ param: "sglang.maxMambaCacheSize" }, 5] }] },
    ],
  };
  assert.equal(evaluate(derived, { user: { concurrency: 4 }, param: { "sglang.maxMambaCacheSize": 8 } }), 1);
  assert.equal(evaluate(derived, { user: { concurrency: 4 }, param: { "sglang.maxMambaCacheSize": 24 } }), 4);
});

test("matches, versionGte and json", () => {
  assert.equal(evaluate({ matches: [{ fact: "runtime.id" }, "^sglang@"] }, { fact: { "runtime.id": "sglang@0.5.17" } }), true);
  assert.equal(evaluate({ matches: [42, "4"] }), false);
  assert.equal(evaluate({ versionGte: ["0.5.21", "0.5.17"] }), true);
  assert.equal(evaluate({ versionGte: ["v0.28.0", "0.28"] }), true);
  assert.equal(evaluate({ versionGte: ["b10630", "b9000"] }), true);
  assert.equal(evaluate({ versionGte: ["0.5.9", "0.5.17"] }), false);
  assert.equal(evaluate({ versionGte: ["nightly", "0.5.17"] }), false);
  assert.deepEqual(
    evaluate({ json: { enable_thinking: { not: { param: "off" } }, max_new_tokens: { const: 512 } } }, { param: { off: true } }),
    { enable_thinking: false, max_new_tokens: 512 },
  );
  assert.deepEqual(evaluate({ const: { a: [1, { b: null }] } }), { a: [1, { b: null }] });
});

test("unknown facts propagate, except where and/or decide without them", () => {
  const ctx = { fact: { "host.platform": "win32", "host.anySm12x": null } };
  assert.equal(evaluate({ fact: "host.anySm12x" }, ctx), UNKNOWN);
  assert.equal(evaluate({ eq: [{ fact: "host.anySm12x" }, true] }, ctx), UNKNOWN);
  assert.equal(evaluate({ not: { fact: "host.anySm12x" } }, ctx), UNKNOWN);
  assert.equal(evaluate({ and: [{ fact: "host.anySm12x" }, false] }, ctx), false);
  assert.equal(evaluate({ and: [{ fact: "host.anySm12x" }, true] }, ctx), UNKNOWN);
  assert.equal(evaluate({ or: [{ fact: "host.anySm12x" }, true] }, ctx), true);
  assert.equal(evaluate({ or: [{ fact: "host.anySm12x" }, false] }, ctx), UNKNOWN);
  assert.equal(evaluate({ coalesce: [null, { fact: "host.anySm12x" }, 1] }, ctx), UNKNOWN);
  assert.equal(evaluate({ coalesce: [2, { fact: "host.anySm12x" }] }, ctx), 2);
  assert.equal(evaluate({ if: [{ fact: "host.anySm12x" }, "a", "b"] }, ctx), UNKNOWN);
  assert.equal(evaluate({ eq: [{ fact: "host.platform" }, "win32"] }, ctx), true);
  assert.equal(expr.truthState(UNKNOWN), "unknown");
  assert.equal(expr.truthState(true), "true");
  assert.equal(expr.truthState("x"), "false");
});

test("fact names are the documented set plus runtime.features.<key>", () => {
  for (const name of expr.FACT_NAMES) assert.equal(validateExpr({ fact: name }).ok, true, name);
  assert.equal(validateExpr({ fact: "runtime.features.pleOffload" }).ok, true);
  assert.deepEqual(codes(validateExpr({ fact: "host.gpuName" })), ["unknown_fact"]);
  assert.deepEqual(codes(validateExpr({ fact: "runtime.features.bad-key" })), ["unknown_fact"]);
});

test("number reads env text the way Number() does", () => {
  const read = { number: { env: "VLLM_GEMMA_MAX_NEW_TOKENS" } };
  const run = (value) => evaluate(read, { env: value === undefined ? {} : { VLLM_GEMMA_MAX_NEW_TOKENS: value } });
  assert.equal(run("4096"), 4096);
  assert.equal(run(" 2048 "), 2048);
  assert.equal(run("1e3"), 1000);
  assert.equal(run("128.5"), 128.5);
  assert.equal(run("many"), null);
  assert.equal(run(""), null);
  assert.equal(run(undefined), null);
  assert.equal(evaluate({ number: 7 }), 7);
  assert.equal(evaluate({ number: [true] }), null);
  assert.equal(evaluate({ number: { fact: "host.maxComputeCap" } }, { fact: {} }), UNKNOWN);
  assert.equal(evaluate({ gte: [{ number: "512" }, 128] }), true);
  assert.deepEqual(codes(validateExpr({ number: [1, 2] })), ["bad_arity"]);
});

test("unknown operators, bad arity and bad ids fail validation", () => {
  assert.deepEqual(codes(validateExpr({ regexReplace: ["a", "b"] })), ["unknown_operator"]);
  assert.deepEqual(codes(validateExpr({ eq: [1] })), ["bad_arity"]);
  assert.deepEqual(codes(validateExpr({ if: [true, 1] })), ["bad_arity"]);
  assert.deepEqual(codes(validateExpr({ and: [] })), ["bad_arity"]);
  assert.deepEqual(codes(validateExpr({ eq: 1 })), ["bad_arity"]);
  assert.deepEqual(codes(validateExpr({ not: [true, false] })), ["bad_arity"]);
  assert.deepEqual(codes(validateExpr({ eq: [1, 2], ne: [1, 2] })), ["invalid_node"]);
  assert.deepEqual(codes(validateExpr({})), ["invalid_node"]);
  assert.deepEqual(codes(validateExpr({ param: "Context Length" })), ["invalid_id"]);
  assert.deepEqual(codes(validateExpr({ param: "" })), ["invalid_id"]);
  assert.deepEqual(codes(validateExpr(Number.POSITIVE_INFINITY)), ["invalid_literal"]);
  assert.deepEqual(codes(validateExpr({ param: "nope" }, { paramIds: ["contextLength"] })), ["unknown_param"]);
  assert.equal(validateExpr({ param: "contextLength" }, { paramIds: ["contextLength"] }).ok, true);
  assert.throws(() => evaluate({ nope: [] }), (error) => error instanceof expr.ExprError && error.code === "unknown_operator");
  assert.throws(() => compileExpr({ eq: [1] }).run({}), expr.ExprError);
  // Prototype keys never reach a json object.
  assert.equal(validateExpr({ json: JSON.parse('{"__proto__": 1}') }).ok, false);
});

test("depth and node limits are enforced", () => {
  let deep = true;
  for (let index = 0; index < expr.LIMITS.maxDepth; index += 1) deep = { not: deep };
  assert.deepEqual(codes(validateExpr(deep)), ["too_deep"]);
  let shallowEnough = true;
  for (let index = 0; index < expr.LIMITS.maxDepth - 1; index += 1) shallowEnough = { not: shallowEnough };
  assert.equal(validateExpr(shallowEnough).ok, true);

  const wide = { add: Array.from({ length: expr.LIMITS.maxNodes }, (_, index) => index) };
  assert.deepEqual(codes(validateExpr(wide)), ["too_many_nodes"]);
  const fits = { add: Array.from({ length: expr.LIMITS.maxNodes - 1 }, (_, index) => index) };
  assert.equal(validateExpr(fits).ok, true);
  // A const value counts against the same budget.
  assert.deepEqual(codes(validateExpr({ const: Array.from({ length: expr.LIMITS.maxNodes + 1 }, () => 1) })), ["invalid_literal"]);
});

test("env leaves need the recipe's inputs.env allowlist and the engine prefixes", () => {
  const ast = { eq: [{ env: "VLLM_QWEN_MOE_BACKEND" }, "marlin"] };
  // Catalog expressions read no env at all.
  assert.deepEqual(codes(validateExpr(ast)), ["env_not_allowed"]);
  assert.deepEqual(codes(validateExpr(ast, { envAllowlist: ["VLLM_GEMMA_RUNNER"] })), ["env_not_allowed"]);
  const allowed = compileExpr(ast, { envAllowlist: ["VLLM_QWEN_MOE_BACKEND"] });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.refs.envs, ["VLLM_QWEN_MOE_BACKEND"]);
  assert.equal(allowed.run({ env: { VLLM_QWEN_MOE_BACKEND: "marlin" } }), true);
  // A name missing from an env map is unset; without an env resolver it is unknown.
  assert.equal(allowed.run({ env: {} }), false);
  assert.equal(allowed.run({}), UNKNOWN);
  assert.equal(compileExpr({ env: "VLLM_X" }, { envAllowlist: ["VLLM_X"] }).run({ env: { VLLM_X: "" } }), null);
  for (const name of ["HF_TOKEN", "PATH", "VLLM_API_KEY_lower", "OPENAI_API_KEY", "VLLM_"]) {
    assert.deepEqual(codes(validateExpr({ env: name }, { envAllowlist: [name] })), ["env_name_invalid"], name);
  }
  assert.equal(validateExpr({ env: "SGLANG_X" }, { envAllowlist: "any" }).ok, true);
});

test("an expression never reads a secret from the environment, even when allowlisted", () => {
  for (const name of ["VLLM_API_KEY", "LLAMA_API_KEY", "SGLANG_HF_TOKEN", "VLLM_SECRET_VALUE"]) {
    assert.deepEqual(codes(validateExpr({ env: name }, { envAllowlist: [name] })), ["env_name_secret"], name);
    assert.throws(() => evaluate({ env: name }, { env: { [name]: "fake-test-value" } }), (error) => error.code === "env_name_secret");
  }
  // Token counts are not secrets.
  assert.equal(validateExpr({ env: "SGLANG_MAX_PREFILL_TOKENS" }, { envAllowlist: ["SGLANG_MAX_PREFILL_TOKENS"] }).ok, true);
});

test("regex patterns are string literals of at most 200 characters, compiled once", () => {
  assert.deepEqual(codes(validateExpr({ matches: ["abc", "a".repeat(expr.LIMITS.maxRegexLength + 1)] })), ["regex_too_long"]);
  assert.equal(validateExpr({ matches: ["abc", "a".repeat(expr.LIMITS.maxRegexLength)] }).ok, true);
  assert.deepEqual(codes(validateExpr({ matches: ["abc", "("] })), ["regex_invalid"]);
  assert.deepEqual(codes(validateExpr({ matches: ["abc", { param: "pattern" }] })), ["regex_not_literal"]);
  const compiled = compileExpr({ matches: [{ param: "name" }, "^qwen"] });
  assert.equal(compiled.run({ param: { name: "qwen3.8" } }), true);
  assert.equal(compiled.run({ param: { name: "llama" } }), false);
});

test("refs list what an expression reads, also for an invalid one", () => {
  const refs = expr.collectRefs({
    and: [{ param: "speculative.method" }, { user: "concurrency" }, { fact: "model.quantMethod" }, { env: "VLLM_X" }, { bogus: 1 }],
  });
  assert.deepEqual(refs, { params: ["speculative.method"], users: ["concurrency"], facts: ["model.quantMethod"], envs: ["VLLM_X"] });
});

test("read leaves return JSON only, so a resolver cannot leak functions or NaN", () => {
  const ctx = { param: (id) => ({ fn: () => 1, nan: Number.NaN, missing: undefined })[id] };
  assert.equal(evaluate({ param: "fn" }, ctx), null);
  assert.equal(evaluate({ param: "nan" }, ctx), null);
  assert.equal(evaluate({ param: "missing" }, ctx), null);
  assert.equal(evaluate({ fact: "runtime.id" }, { fact: () => undefined }), UNKNOWN);
});
