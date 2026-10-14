"use strict";

// A validator for the subset of JSON Schema draft 2020-12 that manager-core's
// own schemas use (docs/overhaul/02-models.md §8.1): the ModelCard schema in
// card-schema.js and, later, the knowledge file schemas. It is written by hand
// so manager-core keeps no dependencies. A keyword outside the subset throws
// when the schema is compiled, so a typo in a schema fails loudly instead of
// silently validating nothing. `format` is an annotation here, as the draft
// allows.

const ANNOTATIONS = new Set([
  "$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "format",
]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs"]);
const SCHEMA_LIST_KEYWORDS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SCHEMA_KEYWORDS = new Set(["additionalProperties", "items", "not", "propertyNames", "contains"]);
const VALUE_KEYWORDS = new Set([
  "type", "enum", "const", "required", "minProperties", "maxProperties", "minItems", "maxItems", "uniqueItems",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "$ref",
]);
const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const DEFAULT_MAX_ERRORS = 100;

class SchemaError extends Error {
  constructor(message, at) {
    super(`${message} (schema ${at})`);
    this.name = "SchemaError";
    this.code = "schema_invalid";
    this.at = at;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(token) {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapePointer(token) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isFinite(value) ? "number" : "non-finite";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === "integer") return actual === "number" && Number.isInteger(value);
  return actual === type;
}

// Deep equality for enum, const and uniqueItems (JSON values only).
function jsonEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (typeof left !== "object" || Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

function resolveRef(root, ref, at) {
  if (typeof ref !== "string" || !(ref === "#" || ref.startsWith("#/"))) {
    throw new SchemaError(`only local $ref values ("#" or "#/...") are supported, not ${JSON.stringify(ref)}`, at);
  }
  let target = root;
  for (const token of ref === "#" ? [] : ref.slice(2).split("/").map(unescapePointer)) {
    if (!isPlainObject(target) || !Object.hasOwn(target, token)) throw new SchemaError(`$ref ${ref} does not resolve`, at);
    target = target[token];
  }
  if (typeof target !== "boolean" && !isPlainObject(target)) throw new SchemaError(`$ref ${ref} is not a schema`, at);
  return target;
}

// Checks every keyword once and compiles the regular expressions.
function checkSchema(schema, at, root, patterns) {
  if (typeof schema === "boolean") return;
  if (!isPlainObject(schema)) throw new SchemaError("a schema must be an object or a boolean", at);
  for (const [keyword, value] of Object.entries(schema)) {
    const here = `${at}/${escapePointer(keyword)}`;
    if (ANNOTATIONS.has(keyword)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
      if (!isPlainObject(value)) throw new SchemaError(`${keyword} must be an object`, here);
      for (const [name, child] of Object.entries(value)) {
        if (keyword === "patternProperties") compilePattern(name, here, patterns);
        checkSchema(child, `${here}/${escapePointer(name)}`, root, patterns);
      }
    } else if (SCHEMA_LIST_KEYWORDS.has(keyword)) {
      if (!Array.isArray(value) || !value.length) throw new SchemaError(`${keyword} must be a non-empty array`, here);
      value.forEach((child, index) => checkSchema(child, `${here}/${index}`, root, patterns));
    } else if (SCHEMA_KEYWORDS.has(keyword)) {
      checkSchema(value, here, root, patterns);
    } else if (VALUE_KEYWORDS.has(keyword)) {
      checkValueKeyword(keyword, value, here, root, patterns);
    } else {
      throw new SchemaError(`unsupported keyword ${JSON.stringify(keyword)}`, here);
    }
  }
}

function checkValueKeyword(keyword, value, at, root, patterns) {
  switch (keyword) {
    case "type": {
      const types = Array.isArray(value) ? value : [value];
      if (!types.length || types.some((type) => !TYPES.has(type))) throw new SchemaError(`type ${JSON.stringify(value)} is not supported`, at);
      return;
    }
    case "enum":
      if (!Array.isArray(value)) throw new SchemaError("enum must be an array", at);
      return;
    case "const":
      return;
    case "required":
      if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) throw new SchemaError("required must list property names", at);
      return;
    case "uniqueItems":
      if (typeof value !== "boolean") throw new SchemaError("uniqueItems must be a boolean", at);
      return;
    case "pattern":
      compilePattern(value, at, patterns);
      return;
    case "$ref":
      resolveRef(root, value, at);
      return;
    case "multipleOf":
      if (typeof value !== "number" || !(value > 0)) throw new SchemaError("multipleOf must be a positive number", at);
      return;
    default:
      if (typeof value !== "number" || !Number.isFinite(value)) throw new SchemaError(`${keyword} must be a number`, at);
  }
}

function compilePattern(source, at, patterns) {
  if (typeof source !== "string") throw new SchemaError("a pattern must be a string", at);
  if (patterns.has(source)) return patterns.get(source);
  let compiled;
  try {
    compiled = new RegExp(source, "u");
  } catch (error) {
    throw new SchemaError(`pattern ${JSON.stringify(source)} is not a valid regular expression: ${error.message}`, at);
  }
  patterns.set(source, compiled);
  return compiled;
}

function describe(value) {
  const type = typeOf(value);
  return type === "non-finite" ? String(value) : type;
}

/**
 * Compiles `schema` once; the result validates values against it:
 * validator(value, {maxErrors}) -> {ok, errors:[{path, keyword, message}]},
 * where `path` is the JSON pointer of the offending part of the value.
 */
function compileSchema(schema) {
  const patterns = new Map();
  const refs = new Map();
  checkSchema(schema, "#", schema, patterns);

  function target(ref) {
    if (!refs.has(ref)) refs.set(ref, resolveRef(schema, ref, "#"));
    return refs.get(ref);
  }

  function visit(node, value, path, state) {
    if (state.errors.length >= state.maxErrors) return;
    if (node === true) return;
    if (node === false) {
      state.errors.push({ path, keyword: "false", message: "no value is allowed here" });
      return;
    }
    const fail = (keyword, message) => {
      if (state.errors.length < state.maxErrors) state.errors.push({ path, keyword, message });
    };
    if (Object.hasOwn(node, "$ref")) visit(target(node.$ref), value, path, state);
    if (Object.hasOwn(node, "type")) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.some((type) => matchesType(value, type))) {
        fail("type", `expected ${types.join(" or ")}, got ${describe(value)}`);
        return;
      }
    }
    if (Object.hasOwn(node, "const") && !jsonEqual(value, node.const)) fail("const", `must equal ${JSON.stringify(node.const)}`);
    if (Object.hasOwn(node, "enum") && !node.enum.some((item) => jsonEqual(item, value))) {
      fail("enum", `must be one of ${node.enum.map((item) => JSON.stringify(item)).join(", ")}`);
    }
    if (typeof value === "number") checkNumber(node, value, fail);
    if (typeof value === "string") checkString(node, value, fail);
    if (Array.isArray(value)) checkArray(node, value, path, state, fail);
    if (isPlainObject(value)) checkObject(node, value, path, state, fail);
    for (const keyword of ["allOf", "anyOf", "oneOf"]) {
      if (!Object.hasOwn(node, keyword)) continue;
      const passing = node[keyword].map((child) => isValid(child, value, path)).filter(Boolean).length;
      if (keyword === "allOf" && passing !== node.allOf.length) {
        for (const child of node.allOf) visit(child, value, path, state);
      } else if (keyword === "anyOf" && passing === 0) {
        fail("anyOf", "matches none of the allowed shapes");
      } else if (keyword === "oneOf" && passing !== 1) {
        fail("oneOf", passing === 0 ? "matches none of the allowed shapes" : "matches more than one exclusive shape");
      }
    }
    if (Object.hasOwn(node, "not") && isValid(node.not, value, path)) fail("not", "matches a shape that is not allowed");
  }

  function isValid(node, value, path) {
    const state = { errors: [], maxErrors: 1 };
    visit(node, value, path, state);
    return state.errors.length === 0;
  }

  function checkNumber(node, value, fail) {
    if (Object.hasOwn(node, "minimum") && value < node.minimum) fail("minimum", `must be >= ${node.minimum}`);
    if (Object.hasOwn(node, "maximum") && value > node.maximum) fail("maximum", `must be <= ${node.maximum}`);
    if (Object.hasOwn(node, "exclusiveMinimum") && value <= node.exclusiveMinimum) fail("exclusiveMinimum", `must be > ${node.exclusiveMinimum}`);
    if (Object.hasOwn(node, "exclusiveMaximum") && value >= node.exclusiveMaximum) fail("exclusiveMaximum", `must be < ${node.exclusiveMaximum}`);
    if (Object.hasOwn(node, "multipleOf")) {
      const quotient = value / node.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) fail("multipleOf", `must be a multiple of ${node.multipleOf}`);
    }
  }

  function checkString(node, value, fail) {
    const length = Array.from(value).length;
    if (Object.hasOwn(node, "minLength") && length < node.minLength) fail("minLength", `must be at least ${node.minLength} characters`);
    if (Object.hasOwn(node, "maxLength") && length > node.maxLength) fail("maxLength", `must be at most ${node.maxLength} characters`);
    if (Object.hasOwn(node, "pattern") && !patterns.get(node.pattern).test(value)) fail("pattern", `must match ${node.pattern}`);
  }

  function checkArray(node, value, path, state, fail) {
    if (Object.hasOwn(node, "minItems") && value.length < node.minItems) fail("minItems", `must have at least ${node.minItems} items`);
    if (Object.hasOwn(node, "maxItems") && value.length > node.maxItems) fail("maxItems", `must have at most ${node.maxItems} items`);
    if (node.uniqueItems === true) {
      const duplicate = value.findIndex((item, index) => value.findIndex((other) => jsonEqual(other, item)) !== index);
      if (duplicate >= 0) fail("uniqueItems", `item ${duplicate} repeats an earlier item`);
    }
    const prefix = Array.isArray(node.prefixItems) ? node.prefixItems : [];
    value.forEach((item, index) => {
      const child = index < prefix.length ? prefix[index] : node.items;
      if (child !== undefined) visit(child, item, `${path}/${index}`, state);
    });
    if (Object.hasOwn(node, "contains") && !value.some((item, index) => isValid(node.contains, item, `${path}/${index}`))) {
      fail("contains", "has no item of the required shape");
    }
  }

  function checkObject(node, value, path, state, fail) {
    const keys = Object.keys(value);
    if (Object.hasOwn(node, "minProperties") && keys.length < node.minProperties) fail("minProperties", `must have at least ${node.minProperties} properties`);
    if (Object.hasOwn(node, "maxProperties") && keys.length > node.maxProperties) fail("maxProperties", `must have at most ${node.maxProperties} properties`);
    for (const name of node.required || []) {
      if (!Object.hasOwn(value, name)) {
        if (state.errors.length < state.maxErrors) state.errors.push({ path: `${path}/${escapePointer(name)}`, keyword: "required", message: "is required" });
      }
    }
    const properties = isPlainObject(node.properties) ? node.properties : {};
    const patternEntries = isPlainObject(node.patternProperties) ? Object.entries(node.patternProperties) : [];
    for (const key of keys) {
      const childPath = `${path}/${escapePointer(key)}`;
      if (Object.hasOwn(node, "propertyNames")) visit(node.propertyNames, key, childPath, state);
      let matched = false;
      if (Object.hasOwn(properties, key)) {
        matched = true;
        visit(properties[key], value[key], childPath, state);
      }
      for (const [source, child] of patternEntries) {
        if (patterns.get(source).test(key)) {
          matched = true;
          visit(child, value[key], childPath, state);
        }
      }
      if (!matched && Object.hasOwn(node, "additionalProperties")) {
        if (node.additionalProperties === false) {
          if (state.errors.length < state.maxErrors) state.errors.push({ path: childPath, keyword: "additionalProperties", message: "is not an allowed property" });
        } else {
          visit(node.additionalProperties, value[key], childPath, state);
        }
      }
    }
  }

  return function validate(value, options = {}) {
    const maxErrors = Math.max(1, Number(options.maxErrors) || DEFAULT_MAX_ERRORS);
    const state = { errors: [], maxErrors };
    visit(schema, value, "", state);
    return { ok: state.errors.length === 0, errors: state.errors };
  };
}

/** One-shot validation: validate(schema, value) -> {ok, errors}. */
function validate(schema, value, options = {}) {
  return compileSchema(schema)(value, options);
}

module.exports = {
  SchemaError,
  compileSchema,
  escapePointer,
  jsonEqual,
  unescapePointer,
  validate,
};
