// 07 section 4.5 / 13.1: the console's browser port of the expression
// language (lib/expr.js). Part 1 is 01's own operator and limit tests (the
// manager's engines-expr.test.js) run against the port, so every documented
// behaviour is asserted here too. Part 2 is the conformance check: when
// manager-core/engines/expr.js exists, both evaluators run the same cases and
// 2,000 seeded random ASTs and must give identical results, errors and refs.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as expr from "../../console/lib/expr.js";

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

test("fact and env leaves without a value are UNKNOWN in the port", () => {
  assert.equal(evaluate({ fact: "host.platform" }), UNKNOWN);
  assert.equal(evaluate({ fact: "host.platform" }, { fact: {} }), UNKNOWN);
  assert.equal(evaluate({ fact: "host.platform" }, { fact: { "host.platform": null } }), UNKNOWN);
  assert.equal(evaluate({ env: "VLLM_X" }), UNKNOWN);
  assert.equal(evaluate({ env: "VLLM_X" }, { env: {} }), null);
  assert.equal(evaluate({ eq: [{ fact: "runtime.id" }, "a"] }), UNKNOWN);
  assert.equal(evaluate({ or: [{ fact: "runtime.id" }, { eq: [1, 1] }] }), true);
});

test("UNKNOWN is the sentinel the manager uses", () => {
  assert.equal(UNKNOWN, Symbol.for("local-ai.engines.expr.unknown"));
  assert.equal(String(UNKNOWN), "Symbol(local-ai.engines.expr.unknown)");
});

// ---- conformance with the manager's evaluator --------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MANAGER_EXPR = path.join(ROOT, "manager-core", "engines", "expr.js");
const manager = fs.existsSync(MANAGER_EXPR) ? createRequire(import.meta.url)(MANAGER_EXPR) : null;
const conformance = { skip: manager ? false : "manager-core/engines/expr.js does not exist" };

/** The outcome of validating and evaluating one AST, comparable across the two implementations. */
function outcome(impl, ast, ctx, options) {
  const validation = impl.validateExpr(ast, options);
  const shape = { ok: validation.ok, errors: validation.errors.map((item) => ({ path: item.path, code: item.code })), refs: validation.refs };
  let value;
  try {
    value = { value: impl.evaluate(ast, ctx, options) };
  } catch (error) {
    value = { thrown: error.code || error.name };
  }
  return { shape, value };
}

function assertSame(ast, ctx, options, label) {
  const mine = outcome(expr, ast, ctx, options);
  const theirs = outcome(manager, ast, ctx, options);
  assert.deepStrictEqual(mine, theirs, label || JSON.stringify(ast));
}

test("the exported limits, operators and facts match the manager's", conformance, () => {
  assert.deepStrictEqual({ ...expr.LIMITS }, { ...manager.LIMITS });
  assert.deepStrictEqual(Object.keys(expr.OPERATORS).sort(), Object.keys(manager.OPERATORS).sort());
  assert.deepStrictEqual(expr.OPERATORS, manager.OPERATORS);
  assert.deepStrictEqual([...expr.FACT_NAMES], [...manager.FACT_NAMES]);
  assert.equal(expr.FEATURE_FACT_PREFIX, manager.FEATURE_FACT_PREFIX);
  assert.equal(String(expr.ENV_NAME_PATTERN), String(manager.ENV_NAME_PATTERN));
  assert.equal(String(expr.SECRET_ENV_PATTERN), String(manager.SECRET_ENV_PATTERN));
  assert.equal(String(expr.PARAM_ID_PATTERN), String(manager.PARAM_ID_PATTERN));
  assert.equal(expr.UNKNOWN, manager.UNKNOWN);
});

test("both evaluators agree on 01's documented cases", conformance, () => {
  const cases = [
    [{ eq: [1, 1] }], [{ ne: [{ const: [1] }, { const: [2] }] }], [{ in: [null, ["off", null]] }], [{ notIn: ["mtp", ["off", null]] }],
    [{ in: ["x", "not-a-list"] }], [{ gt: ["3", 2] }], [{ lt: [null, 2] }], [{ not: "yes" }], [{ and: [1] }], [{ not: [false] }],
    [{ isSet: { param: "a" } }, { param: { a: 0 } }], [{ isSet: { param: "a" } }, { param: {} }],
    [{ coalesce: [{ user: "contextLength" }, 262144] }, { user: { contextLength: 131072 } }],
    [{ coalesce: [null, null] }], [{ if: [{ eq: [1, 2] }, "a", "b"] }],
    [{ min: [4, 1, 3] }], [{ max: [1, { floorDiv: [8, 5] }] }], [{ floorDiv: [7, 0] }], [{ add: [1, "2"] }], [{ min: [1, null] }],
    [{ min: [{ coalesce: [{ user: "concurrency" }, 1] }, { max: [1, { floorDiv: [{ param: "sglang.maxMambaCacheSize" }, 5] }] }] },
      { user: { concurrency: 4 }, param: { "sglang.maxMambaCacheSize": 8 } }],
    [{ matches: [{ fact: "runtime.id" }, "^sglang@"] }, { fact: { "runtime.id": "sglang@0.5.17" } }],
    [{ matches: [42, "4"] }], [{ versionGte: ["v0.28.0", "0.28"] }], [{ versionGte: ["b10630", "b9000"] }], [{ versionGte: ["nightly", "0.5.17"] }],
    [{ json: { enable_thinking: { not: { param: "off" } }, max_new_tokens: { const: 512 } } }, { param: { off: true } }],
    [{ const: { a: [1, { b: null }] } }],
    [{ and: [{ fact: "host.anySm12x" }, false] }, { fact: { "host.anySm12x": null } }],
    [{ or: [{ fact: "host.anySm12x" }, false] }, { fact: { "host.anySm12x": null } }],
    [{ coalesce: [null, { fact: "host.anySm12x" }, 1] }, { fact: {} }],
    [{ number: { env: "VLLM_GEMMA_MAX_NEW_TOKENS" } }, { env: { VLLM_GEMMA_MAX_NEW_TOKENS: " 2048 " } }],
    [{ number: { env: "VLLM_GEMMA_MAX_NEW_TOKENS" } }, { env: {} }],
    [{ env: "VLLM_X" }, {}], [{ env: "VLLM_API_KEY" }, { env: { VLLM_API_KEY: "fake" } }],
    [{ param: "nope" }, {}, { paramIds: ["contextLength"] }],
    [{ eq: [{ env: "VLLM_QWEN_MOE_BACKEND" }, "marlin"] }, { env: { VLLM_QWEN_MOE_BACKEND: "marlin" } }, { envAllowlist: ["VLLM_QWEN_MOE_BACKEND"] }],
    [{ eq: [{ env: "VLLM_QWEN_MOE_BACKEND" }, "marlin"] }, {}, { envAllowlist: ["VLLM_OTHER"] }],
    [{ regexReplace: ["a", "b"] }], [{ eq: [1] }], [{ and: [] }], [{ eq: [1, 2], ne: [1, 2] }], [{}], [{ param: "Context Length" }],
    [{ matches: ["abc", "("] }], [{ matches: ["abc", { param: "pattern" }] }], [{ matches: ["abc", "a".repeat(201)] }],
    [{ json: JSON.parse("{\"__proto__\": 1}") }],
    [{ add: Array.from({ length: 512 }, (_, index) => index) }], [{ add: Array.from({ length: 511 }, (_, index) => index) }],
    [{ fact: "runtime.features.pleOffload" }, { fact: { "runtime.features.pleOffload": true } }], [{ fact: "host.gpuName" }],
    [null], [true], ["text"], [3.5], [[1, 2, { param: "a" }]], [Number.POSITIVE_INFINITY],
  ];
  let deep = true;
  for (let index = 0; index < 32; index += 1) deep = { not: deep };
  cases.push([deep]);
  let shallow = true;
  for (let index = 0; index < 31; index += 1) shallow = { not: shallow };
  cases.push([shallow]);
  for (const [ast, ctx, options] of cases) assertSame(ast, ctx, options);
  assert.ok(cases.length > 50);
});

// A small seeded generator (mulberry32), so a failure names a reproducible case.
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PARAM_IDS = ["contextLength", "concurrency", "speculative.method", "sglang.maxMambaCacheSize", "tensorParallel", "kvCacheDtype"];
const CONST_POOL = [0, 1, 2, 3, 5, 8, 64, -1, 0.5, 262144, "auto", "fp8", "off", "mtp", "0.5.17", "v0.28.0", "b10630", "", true, false, null, [1, 2], ["off", null], ["auto", "fp8"], { a: 1 }];
const BINARY = ["eq", "ne", "in", "notIn", "gt", "gte", "lt", "lte", "sub", "floorDiv", "versionGte"];
const VARIADIC = ["and", "or", "coalesce", "min", "max", "add", "mul"];
const UNARY = ["not", "isSet", "number"];
const PATTERNS = ["^a", "fp\\d", "^(auto|off)$", "0\\.5", "^$"];

function randomAst(rand, depth) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  if (depth <= 0 || rand() < 0.22) {
    const roll = rand();
    if (roll < 0.34) return { param: pick(PARAM_IDS) };
    if (roll < 0.58) return { user: pick(PARAM_IDS) };
    if (roll < 0.62) return { fact: "host.platform" };
    if (roll < 0.64) return { env: "VLLM_X" };
    const value = pick(CONST_POOL);
    return rand() < 0.5 ? value : { const: value };
  }
  const roll = rand();
  const child = () => randomAst(rand, depth - 1);
  // A few malformed nodes keep the validation errors under comparison too.
  if (roll < 0.015) return { bogus: [child()] };
  if (roll < 0.03) return { eq: [child()] };
  if (roll < 0.045) return { and: [] };
  if (roll < 0.1) return { if: [child(), child(), child()] };
  if (roll < 0.15) return { matches: [child(), pick(PATTERNS)] };
  if (roll < 0.2) return { json: { x: child(), y: child() } };
  if (roll < 0.5) return { [pick(BINARY)]: [child(), child()] };
  if (roll < 0.8) return { [pick(VARIADIC)]: Array.from({ length: 1 + Math.floor(rand() * 3) }, child) };
  const op = pick(UNARY);
  return { [op]: rand() < 0.3 ? [child()] : child() };
}

function randomContext(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const map = () => {
    const out = {};
    for (const id of PARAM_IDS) if (rand() < 0.6) out[id] = pick(CONST_POOL);
    return out;
  };
  const ctx = { param: map(), user: map() };
  const roll = rand();
  if (roll < 0.3) ctx.fact = { "host.platform": rand() < 0.5 ? "win32" : null };
  if (roll > 0.8) ctx.env = rand() < 0.5 ? {} : { VLLM_X: "12" };
  return ctx;
}

test("both evaluators agree on 2,000 seeded random ASTs", conformance, () => {
  const rand = prng(0x5eed);
  let evaluated = 0;
  let rejected = 0;
  for (let index = 0; index < 2000; index += 1) {
    const ast = randomAst(rand, 4);
    const ctx = randomContext(rand);
    assertSame(ast, ctx, undefined, `ast #${index}: ${JSON.stringify(ast)} ctx ${JSON.stringify(ctx)}`);
    if (validateExpr(ast).ok) evaluated += 1;
    else rejected += 1;
  }
  // The generator must exercise both the evaluator and the validator's errors.
  assert.ok(evaluated > 1200, `only ${evaluated} valid ASTs`);
  assert.ok(rejected > 20, `only ${rejected} invalid ASTs`);
});

test("both evaluators agree on the real catalogs' appliesWhen and platform default expressions", conformance, () => {
  const dir = path.join(ROOT, "manager-core", "data", "launch-params");
  let count = 0;
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const param of data.params || []) {
      for (const ast of [param.appliesWhen, param.platformDefault?.expr].filter((item) => item !== null && item !== undefined)) {
        const ctx = { param: { "speculative.method": "mtp", tensorParallel: 2, "llamacpp.gpuLayers": "auto" }, fact: { "instance.mode": "parallel", "model.quantMethod": "awq" } };
        assertSame(ast, ctx, undefined, `${file} ${param.id}`);
        count += 1;
      }
    }
  }
  assert.ok(count >= 10, `only ${count} expressions found`);
});
