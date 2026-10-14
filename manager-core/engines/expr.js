"use strict";

// Expression language for recipes and parameter catalogs (docs/overhaul/
// 01-engines.md §10.2). An expression is a JSON AST evaluated purely: recipe
// values, locks and blocks, catalog rules and appliesWhen all use this one
// language, and the console carries a browser port of it (07 §4.5) that must
// give identical results, so the semantics below are the contract.
//
// Nodes
//   null, true/false, a finite number, a string  literal
//   [a, b, ...]                                   literal array; elements are nodes
//   {"param": id}                                 effective value at that point of the resolution (unset → null)
//   {"user": id}                                  the explicit user value (unset → null)
//   {"fact": name}                                a host/model/runtime/instance fact (unknown or null → UNKNOWN)
//   {"env": NAME}                                 an allowlisted environment variable (no resolver → UNKNOWN, unset → null)
//                                                 never a secret (API_KEY, TOKEN, ...: env_name_secret)
//   {"const": value}                              any JSON value, taken verbatim
//   {"<operator>": args}                          see OPERATORS
//
// Values are JSON values plus the UNKNOWN sentinel. UNKNOWN propagates through
// every operator except where Kleene logic decides without it: `and` is false
// when any operand is false, `or` is true when any operand is true. `not`,
// comparisons, `in`, `isSet`, arithmetic and `json` of an UNKNOWN are UNKNOWN;
// `coalesce` is UNKNOWN when an UNKNOWN comes before the first non-null value;
// `if` with an UNKNOWN condition is UNKNOWN. Only the boolean `true` counts as
// true; every other value counts as false.
//
// Ordering comparisons (gt, gte, lt, lte) need two numbers and are false
// otherwise. Arithmetic needs numbers and gives null otherwise (floorDiv by 0
// is null too). `number` reads a number from text the way Number() does (env
// inputs arrive as text): a finite number stays, non-blank text that converts
// to a finite number becomes it, anything else is null. `matches` is false for
// a non-string subject. `versionGte` compares dotted versions (a leading "v" or
// "b" and a suffix after the numeric part are ignored) and is false when either
// side is not a version.

const LIMITS = Object.freeze({ maxDepth: 32, maxNodes: 512, maxRegexLength: 200 });

// One sentinel per process, shared through the global symbol registry so a
// second copy of this module (or the console port under node) compares equal.
const UNKNOWN = Symbol.for("local-ai.engines.expr.unknown");

const ENV_NAME_PATTERN = /^(VLLM|SGLANG|LLAMA)_[A-Z0-9_]{1,48}$/;
// Expressions feed argv, env and labels, so a secret never becomes readable,
// even when a recipe lists it in inputs.env (VLLM_API_KEY, LLAMA_API_KEY...).
const SECRET_ENV_PATTERN = /(?:^|_)(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/;
const PARAM_ID_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/;
const FEATURE_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

// The facts an expression may read (01 §10.2). runtime.features.<k> covers any
// manifest feature flag.
const FACT_NAMES = Object.freeze([
  "host.platform",
  "host.anySm12x",
  "host.maxComputeCap",
  "model.capabilityId",
  "model.familyId",
  "model.quantMethod",
  "model.architectures",
  "model.nativeMtp.supported",
  "runtime.id",
  "runtime.compatVersion",
  "instance.mode",
]);
const FEATURE_FACT_PREFIX = "runtime.features.";

const LEAVES = new Set(["param", "user", "fact", "env", "const"]);

// arity: exact number of arguments; min: at least that many; unary: one node
// (a one-element array is accepted too); object: the json builder.
const OPERATORS = Object.freeze({
  eq: { arity: 2 },
  ne: { arity: 2 },
  in: { arity: 2 },
  notIn: { arity: 2 },
  gt: { arity: 2 },
  gte: { arity: 2 },
  lt: { arity: 2 },
  lte: { arity: 2 },
  and: { min: 1 },
  or: { min: 1 },
  not: { unary: true },
  isSet: { unary: true },
  coalesce: { min: 1 },
  if: { arity: 3 },
  min: { min: 1 },
  max: { min: 1 },
  add: { min: 1 },
  sub: { arity: 2 },
  mul: { min: 1 },
  floorDiv: { arity: 2 },
  number: { unary: true },
  matches: { arity: 2 },
  versionGte: { arity: 2 },
  json: { object: true },
});

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class ExprError extends Error {
  constructor(errors) {
    const first = errors[0] || { path: "", code: "invalid_expression", message: "Invalid expression." };
    super(`${first.message}${first.path ? ` (at ${first.path})` : ""}`);
    this.name = "ExprError";
    this.code = first.code;
    this.errors = errors;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFactName(name) {
  if (typeof name !== "string") return false;
  if (FACT_NAMES.includes(name)) return true;
  return name.startsWith(FEATURE_FACT_PREFIX) && FEATURE_KEY_PATTERN.test(name.slice(FEATURE_FACT_PREFIX.length));
}

function isOperatorNode(node) {
  if (!isPlainObject(node)) return false;
  const keys = Object.keys(node);
  return keys.length === 1 && (LEAVES.has(keys[0]) || Object.hasOwn(OPERATORS, keys[0]));
}

function joinPath(base, key) {
  if (typeof key === "number") return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

// Every JSON value is acceptable inside {"const": v}; this bounds its size so a
// const cannot smuggle an unbounded structure past the node limit.
function constSize(value, depth, budget) {
  if (depth > LIMITS.maxDepth) return Infinity;
  if (Array.isArray(value)) {
    let total = 1;
    for (const item of value) {
      total += constSize(item, depth + 1, budget - total);
      if (total > budget) return total;
    }
    return total;
  }
  if (isPlainObject(value)) {
    let total = 1;
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) return Infinity;
      total += constSize(item, depth + 1, budget - total);
      if (total > budget) return total;
    }
    return total;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return 1;
  if (typeof value === "number" && Number.isFinite(value)) return 1;
  return Infinity;
}

/**
 * Validates and compiles an AST in one walk.
 *
 * options:
 *   envAllowlist  names an {"env"} leaf may read (a recipe's inputs.env). Without
 *                 it every env leaf is rejected (catalog rules read no env);
 *                 "any" accepts every name that matches ENV_NAME_PATTERN.
 *   paramIds      known param ids; when given, {"param"}/{"user"} must name one.
 *
 * → { ok, errors: [{ path, code, message }], refs: { params, users, facts, envs }, run(ctx) }
 */
function compileExpr(ast, options = {}) {
  const errors = [];
  const refs = { params: new Set(), users: new Set(), facts: new Set(), envs: new Set() };
  const envAny = options.envAllowlist === "any";
  const envAllowlist = Array.isArray(options.envAllowlist) ? new Set(options.envAllowlist) : null;
  const paramIds = options.paramIds ? new Set(options.paramIds) : null;
  let nodes = 0;
  let aborted = false;

  function fail(path, code, message) {
    errors.push({ path, code, message });
  }

  // Returns an evaluator closure for the node, or null when it is invalid.
  function build(node, path, depth) {
    if (aborted) return null;
    nodes += 1;
    if (nodes > LIMITS.maxNodes) {
      fail(path, "too_many_nodes", `An expression may have at most ${LIMITS.maxNodes} nodes.`);
      aborted = true;
      return null;
    }
    if (depth > LIMITS.maxDepth) {
      fail(path, "too_deep", `An expression may nest at most ${LIMITS.maxDepth} levels.`);
      aborted = true;
      return null;
    }
    if (node === null || typeof node === "boolean" || typeof node === "string") return () => node;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        fail(path, "invalid_literal", "Numbers must be finite.");
        return null;
      }
      return () => node;
    }
    if (Array.isArray(node)) {
      const items = node.map((item, index) => build(item, joinPath(path, index), depth + 1));
      if (items.some((item) => !item)) return null;
      return (ctx) => {
        const values = items.map((item) => item(ctx));
        return values.includes(UNKNOWN) ? UNKNOWN : values;
      };
    }
    if (!isPlainObject(node)) {
      fail(path, "invalid_node", "An expression node must be JSON.");
      return null;
    }
    const keys = Object.keys(node);
    if (keys.length !== 1) {
      fail(path, "invalid_node", `An expression object must have exactly one key (an operator or a leaf); got ${keys.length ? keys.join(", ") : "none"}.`);
      return null;
    }
    const [key] = keys;
    const arg = node[key];
    const here = joinPath(path, key);
    if (LEAVES.has(key)) return buildLeaf(key, arg, here, depth);
    if (!Object.hasOwn(OPERATORS, key)) {
      fail(path, "unknown_operator", `Unknown operator "${String(key).slice(0, 64)}".`);
      return null;
    }
    return buildOperator(key, arg, here, depth);
  }

  function buildLeaf(key, arg, path, depth) {
    if (key === "const") {
      if (constSize(arg, depth, LIMITS.maxNodes) > LIMITS.maxNodes) {
        fail(path, "invalid_literal", "A const value must be bounded JSON.");
        return null;
      }
      const value = JSON.parse(JSON.stringify(arg));
      return () => value;
    }
    if (typeof arg !== "string" || !arg) {
      fail(path, "invalid_id", `"${key}" takes a non-empty string.`);
      return null;
    }
    if (key === "param" || key === "user") {
      if (!PARAM_ID_PATTERN.test(arg)) {
        fail(path, "invalid_id", `"${arg.slice(0, 64)}" is not a parameter id.`);
        return null;
      }
      (key === "param" ? refs.params : refs.users).add(arg);
      if (paramIds && !paramIds.has(arg)) {
        fail(path, "unknown_param", `Unknown parameter "${arg}".`);
        return null;
      }
      return key === "param"
        ? (ctx) => normalizeRead(ctx.param(arg))
        : (ctx) => normalizeRead(ctx.user(arg));
    }
    if (key === "fact") {
      if (!isFactName(arg)) {
        fail(path, "unknown_fact", `Unknown fact "${arg.slice(0, 64)}".`);
        return null;
      }
      refs.facts.add(arg);
      return (ctx) => {
        const value = ctx.fact(arg);
        return value === undefined || value === null ? UNKNOWN : normalizeRead(value);
      };
    }
    // env
    if (!ENV_NAME_PATTERN.test(arg)) {
      fail(path, "env_name_invalid", `Environment variable "${arg.slice(0, 64)}" must match ${ENV_NAME_PATTERN}.`);
      return null;
    }
    refs.envs.add(arg);
    if (SECRET_ENV_PATTERN.test(arg)) {
      fail(path, "env_name_secret", `Environment variable ${arg} holds a secret and cannot be read by an expression.`);
      return null;
    }
    if (!envAny && (!envAllowlist || !envAllowlist.has(arg))) {
      fail(path, "env_not_allowed", `Environment variable ${arg} is not in this expression's inputs.env allowlist.`);
      return null;
    }
    return (ctx) => {
      const value = ctx.env(arg);
      if (value === undefined) return UNKNOWN;
      return value === null || value === "" ? null : String(value);
    };
  }

  function argumentList(op, arg, path) {
    const spec = OPERATORS[op];
    if (spec.unary) {
      if (Array.isArray(arg)) {
        if (arg.length !== 1) {
          fail(path, "bad_arity", `"${op}" takes one argument.`);
          return null;
        }
        return { items: arg, base: path };
      }
      return { items: [arg], base: null };
    }
    if (!Array.isArray(arg)) {
      fail(path, "bad_arity", `"${op}" takes an argument list.`);
      return null;
    }
    if (spec.arity !== undefined && arg.length !== spec.arity) {
      fail(path, "bad_arity", `"${op}" takes ${spec.arity} arguments; got ${arg.length}.`);
      return null;
    }
    if (spec.min !== undefined && arg.length < spec.min) {
      fail(path, "bad_arity", `"${op}" takes at least ${spec.min} argument(s).`);
      return null;
    }
    return { items: arg, base: path };
  }

  function buildOperator(op, arg, path, depth) {
    if (op === "json") return buildJson(arg, path, depth);
    const list = argumentList(op, arg, path);
    if (!list) return null;
    if (op === "matches") return buildMatches(list.items, path, depth);
    const args = list.items.map((item, index) => build(item, list.base === null ? path : joinPath(path, index), depth + 1));
    if (args.some((item) => !item)) return null;
    return makeOperator(op, args);
  }

  function buildJson(arg, path, depth) {
    if (!isPlainObject(arg)) {
      fail(path, "bad_arity", "\"json\" takes an object whose values are expressions.");
      return null;
    }
    const entries = [];
    for (const [key, value] of Object.entries(arg)) {
      if (UNSAFE_KEYS.has(key)) {
        fail(joinPath(path, key), "invalid_node", `"${key}" is not allowed as a json key.`);
        return null;
      }
      const child = build(value, joinPath(path, key), depth + 1);
      if (!child) return null;
      entries.push([key, child]);
    }
    return (ctx) => {
      const out = {};
      for (const [key, child] of entries) {
        const value = child(ctx);
        if (value === UNKNOWN) return UNKNOWN;
        out[key] = value;
      }
      return out;
    };
  }

  // The pattern must be a string literal so it is compiled once, here.
  function buildMatches(items, path, depth) {
    const subject = build(items[0], joinPath(path, 0), depth + 1);
    const pattern = items[1];
    const patternPath = joinPath(path, 1);
    nodes += 1;
    if (typeof pattern !== "string") {
      fail(patternPath, "regex_not_literal", "The \"matches\" pattern must be a string literal.");
      return null;
    }
    if (pattern.length > LIMITS.maxRegexLength) {
      fail(patternPath, "regex_too_long", `A pattern may be at most ${LIMITS.maxRegexLength} characters.`);
      return null;
    }
    let regex;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      fail(patternPath, "regex_invalid", `Invalid pattern: ${error.message}`);
      return null;
    }
    if (!subject) return null;
    return (ctx) => {
      const value = subject(ctx);
      if (value === UNKNOWN) return UNKNOWN;
      return typeof value === "string" && regex.test(value);
    };
  }

  const root = build(ast, "", 1);
  const ok = errors.length === 0 && Boolean(root);
  const frozenRefs = {
    params: [...refs.params].sort(),
    users: [...refs.users].sort(),
    facts: [...refs.facts].sort(),
    envs: [...refs.envs].sort(),
  };
  return {
    ok,
    errors,
    refs: frozenRefs,
    run(ctx = {}) {
      if (!ok) throw new ExprError(errors);
      return root(normalizeContext(ctx));
    },
  };
}

// A read leaf gives JSON: undefined becomes null, other non-JSON values become
// null as well, so a resolver bug cannot leak functions into a plan.
function normalizeRead(value) {
  if (value === undefined || value === null) return null;
  if (value === UNKNOWN) return UNKNOWN;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value) || isPlainObject(value)) return value;
  return null;
}

function resolver(source, missing) {
  if (typeof source === "function") return source;
  if (source && typeof source === "object") {
    return (key) => (Object.hasOwn(source, key) ? source[key] : missing);
  }
  return () => undefined;
}

/**
 * ctx: { param, user, fact, env }, each a function (id → value) or a plain map.
 * A name missing from an env map is unset (null); without any env resolver the
 * environment is not known here (the console) and env leaves are UNKNOWN.
 */
function normalizeContext(ctx) {
  return {
    param: resolver(ctx.param, undefined),
    user: resolver(ctx.user, undefined),
    fact: resolver(ctx.fact, undefined),
    env: ctx.env === undefined || ctx.env === null ? () => undefined : resolver(ctx.env, null),
  };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function parseVersion(value) {
  if (typeof value !== "string" && !isNumber(value)) return null;
  const match = /^[vVbB]?(\d+(?:\.\d+)*)(?:[-+._a-zA-Z].*)?$/.exec(String(value).trim());
  return match ? match[1].split(".").map(Number) : null;
}

function compareVersions(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] || 0;
    const right = b[index] || 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function evaluateAll(args, ctx) {
  return args.map((arg) => arg(ctx));
}

function arithmetic(values, reduce) {
  if (values.includes(UNKNOWN)) return UNKNOWN;
  if (!values.every(isNumber)) return null;
  const result = reduce(values);
  return isNumber(result) ? result : null;
}

function makeOperator(op, args) {
  switch (op) {
    case "eq":
    case "ne":
      return (ctx) => {
        const [a, b] = evaluateAll(args, ctx);
        if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
        return op === "eq" ? deepEqual(a, b) : !deepEqual(a, b);
      };
    case "in":
    case "notIn":
      return (ctx) => {
        const [value, list] = evaluateAll(args, ctx);
        if (value === UNKNOWN || list === UNKNOWN) return UNKNOWN;
        const found = Array.isArray(list) && list.some((item) => deepEqual(item, value));
        return op === "in" ? found : !found;
      };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return (ctx) => {
        const [a, b] = evaluateAll(args, ctx);
        if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
        if (!isNumber(a) || !isNumber(b)) return false;
        if (op === "gt") return a > b;
        if (op === "gte") return a >= b;
        if (op === "lt") return a < b;
        return a <= b;
      };
    case "and":
      return (ctx) => {
        let unknown = false;
        for (const arg of args) {
          const value = arg(ctx);
          if (value === UNKNOWN) unknown = true;
          else if (value !== true) return false;
        }
        return unknown ? UNKNOWN : true;
      };
    case "or":
      return (ctx) => {
        let unknown = false;
        for (const arg of args) {
          const value = arg(ctx);
          if (value === true) return true;
          if (value === UNKNOWN) unknown = true;
        }
        return unknown ? UNKNOWN : false;
      };
    case "not":
      return (ctx) => {
        const value = args[0](ctx);
        return value === UNKNOWN ? UNKNOWN : value !== true;
      };
    case "isSet":
      return (ctx) => {
        const value = args[0](ctx);
        return value === UNKNOWN ? UNKNOWN : value !== null;
      };
    case "coalesce":
      return (ctx) => {
        for (const arg of args) {
          const value = arg(ctx);
          if (value === UNKNOWN) return UNKNOWN;
          if (value !== null) return value;
        }
        return null;
      };
    case "if":
      return (ctx) => {
        const condition = args[0](ctx);
        if (condition === UNKNOWN) return UNKNOWN;
        return condition === true ? args[1](ctx) : args[2](ctx);
      };
    case "min":
      return (ctx) => arithmetic(evaluateAll(args, ctx), (values) => Math.min(...values));
    case "max":
      return (ctx) => arithmetic(evaluateAll(args, ctx), (values) => Math.max(...values));
    case "add":
      return (ctx) => arithmetic(evaluateAll(args, ctx), (values) => values.reduce((sum, value) => sum + value, 0));
    case "mul":
      return (ctx) => arithmetic(evaluateAll(args, ctx), (values) => values.reduce((product, value) => product * value, 1));
    case "sub":
      return (ctx) => arithmetic(evaluateAll(args, ctx), ([a, b]) => a - b);
    case "floorDiv":
      return (ctx) => arithmetic(evaluateAll(args, ctx), ([a, b]) => (b === 0 ? null : Math.floor(a / b)));
    case "number":
      return (ctx) => {
        const value = args[0](ctx);
        if (value === UNKNOWN) return UNKNOWN;
        if (isNumber(value)) return value;
        if (typeof value !== "string" || !value.trim()) return null;
        const number = Number(value.trim());
        return isNumber(number) ? number : null;
      };
    case "versionGte":
      return (ctx) => {
        const [a, b] = evaluateAll(args, ctx);
        if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
        const left = parseVersion(a);
        const right = parseVersion(b);
        return Boolean(left && right) && compareVersions(left, right) >= 0;
      };
    default:
      throw new Error(`unreachable operator ${op}`);
  }
}

/** → { ok, errors, refs } without keeping the compiled form. */
function validateExpr(ast, options = {}) {
  const { ok, errors, refs } = compileExpr(ast, options);
  return { ok, errors, refs };
}

/**
 * Compiles and evaluates in one call; throws ExprError when the AST is invalid.
 * Evaluation accepts any well-formed env name (the allowlist is a load-time
 * check, made by validateExpr with the recipe's inputs.env). Hot paths compile
 * once with compileExpr and call run(ctx) per evaluation.
 */
function evaluate(ast, ctx = {}, options = {}) {
  return compileExpr(ast, { ...options, envAllowlist: options.envAllowlist ?? "any" }).run(ctx);
}

/** The references an AST reads, also from nodes that fail validation; never throws. */
function collectRefs(ast, options = {}) {
  return compileExpr(ast, { ...options, envAllowlist: options.envAllowlist ?? "any" }).refs;
}

/** "true" | "false" | "unknown" for a result, the way appliesWhen and rules read it. */
function truthState(value) {
  if (value === UNKNOWN) return "unknown";
  return value === true ? "true" : "false";
}

module.exports = {
  ENV_NAME_PATTERN,
  SECRET_ENV_PATTERN,
  ExprError,
  FACT_NAMES,
  FEATURE_FACT_PREFIX,
  LIMITS,
  OPERATORS,
  PARAM_ID_PATTERN,
  UNKNOWN,
  collectRefs,
  compileExpr,
  deepEqual,
  evaluate,
  isFactName,
  isOperatorNode,
  parseVersion,
  truthState,
  validateExpr,
};
