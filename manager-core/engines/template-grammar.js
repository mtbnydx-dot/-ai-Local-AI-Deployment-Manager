"use strict";

// The docker-template grammar (docs/overhaul/01-engines.md §19.1, ENG-18): what a
// descriptor `template` may contain, shared by the descriptor validator (load
// time) and the docker-template adapter (render time) so both read the same
// language.
//
//   template = { entrypoint?, args[], env?{}, files?[], flagFormat? }
//
//   args item (a string, or an object):
//     "literal"                           one argv token
//     "{{name}}"                          one argv token from a placeholder
//     "--x={{name}}"                      one token mixing literal text and placeholders
//     { flag, value, format? }            emitted only when the value is set;
//                                         format "equals" gives --flag=value
//     { args[], when?, repeat? }          a conditional group; `repeat` is a
//                                         "{{list}}" placeholder, the group renders once per item
//
//   placeholder  {{name}} or {{name|dir}} / {{name|base}} (container path parts)
//     model.containerPath  model.ref  servedName  host.containerPort
//     gpu.ids  gpu.count  instance.id  file.<id>  item / item.<field> (in repeat)
//     secrets.apiKey  secrets.adminKey (secret files only)
//     GPUStack aliases: model_path model_name port gpu_ids gpu_count
//     or any parameter id of the engine's catalog
//
// A value is always exactly one argv token: it is never split, never shell-parsed
// and, when it comes from a placeholder, never starts with "-" (the adapter
// rejects it as template_value_flag_injection). Unknown placeholders fail
// descriptor validation, so a typo cannot reach a command line.

const expr = require("./expr");

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const FLAG_PATTERN = /^--?[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const FILE_ID_PATTERN = /^[a-z][A-Za-z0-9_]{0,31}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const TARGET_PATTERN = /^\/[A-Za-z0-9._/@+-]*$/;
const ENTRYPOINT_PATTERN = /^[^\s\u0000]{1,256}$/;
const FILE_FORMATS = Object.freeze(["yaml", "json", "text"]);
const FLAG_FORMATS = Object.freeze(["space", "equals"]);
const FILTERS = Object.freeze(["dir", "base"]);
const MAX_STRING = 4096;
const MAX_NODES = 2048;
const MAX_DEPTH = 24;

// name → the canonical name it stands for (the GPUStack spellings, 01 §19.1).
const GPUSTACK_ALIASES = Object.freeze({
  model_path: "model.containerPath",
  model_name: "servedName",
  port: "host.containerPort",
  gpu_ids: "gpu.ids",
  gpu_count: "gpu.count",
});
const RESERVED_NAMES = Object.freeze([
  "model.containerPath",
  "model.ref",
  "servedName",
  "host.containerPort",
  "gpu.ids",
  "gpu.count",
  "instance.id",
  ...Object.keys(GPUSTACK_ALIASES),
]);
const SECRET_NAMES = Object.freeze(["secrets.apiKey", "secrets.adminKey"]);

/**
 * "text {{name}} more" → { parts: [{ text } | { name, filter }], errors: [{ code, message }] }.
 * A "{{" or "}}" that is not part of a well-formed placeholder is a syntax error.
 */
function parseTemplateString(text) {
  const parts = [];
  const errors = [];
  const source = String(text);
  const pattern = /\{\{([^{}]*)\}\}/g;
  let last = 0;
  let match;
  const literal = (piece) => {
    if (!piece) return;
    if (/\{\{|\}\}/.test(piece)) {
      errors.push({ code: "template_placeholder_syntax", message: "A placeholder is written {{name}} (no spaces, one name)." });
    }
    parts.push({ text: piece });
  };
  while ((match = pattern.exec(source))) {
    literal(source.slice(last, match.index));
    const inner = match[1];
    const [name, filter, ...rest] = inner.split("|");
    if (rest.length || !NAME_PATTERN.test(name) || (filter !== undefined && !FILTERS.includes(filter))) {
      errors.push({ code: "template_placeholder_syntax", message: `"{{${inner.slice(0, 80)}}}" is not a placeholder; use {{name}} or {{name|${FILTERS.join("|")}}}.` });
    } else {
      parts.push({ name, ...(filter ? { filter } : {}) });
    }
    last = match.index + match[0].length;
  }
  literal(source.slice(last));
  return { parts, errors };
}

/** The canonical name of a placeholder (GPUStack aliases resolved). */
function canonicalName(name) {
  return Object.hasOwn(GPUSTACK_ALIASES, name) ? GPUSTACK_ALIASES[name] : name;
}

/**
 * Where a placeholder name points: "reserved", "file", "item", "secret", or
 * "param" (a catalog parameter id).
 */
function classifyName(name) {
  const canonical = canonicalName(name);
  if (RESERVED_NAMES.includes(canonical)) return "reserved";
  if (/^file\.[a-z][A-Za-z0-9_]*$/.test(name)) return "file";
  if (name === "item" || /^item\.[A-Za-z][A-Za-z0-9_]*$/.test(name)) return "item";
  if (SECRET_NAMES.includes(name)) return "secret";
  return "param";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function joinPath(base, key) {
  return typeof key === "number" ? `${base}[${key}]` : base ? `${base}.${key}` : String(key);
}

/**
 * validateTemplate(template, { paramIds? }) → [{ path, code, message }]
 * paramIds: the engine catalog's parameter ids. Without it a parameter-shaped
 * placeholder is accepted by shape only; with it an unknown one is
 * template_unknown_placeholder.
 */
function validateTemplate(template, options = {}) {
  const errors = [];
  const add = (path, code, message) => errors.push({ path, code, message });
  const paramIds = options.paramIds ? new Set(options.paramIds) : null;
  let nodes = 0;
  if (!isPlainObject(template)) {
    add("template", "type", "template must be an object.");
    return errors;
  }
  for (const key of Object.keys(template)) {
    if (!["entrypoint", "args", "env", "files", "flagFormat"].includes(key)) add(joinPath("template", key), "unknown_field", `Unknown template field "${key}".`);
  }
  if (template.entrypoint !== undefined && template.entrypoint !== null
    && (typeof template.entrypoint !== "string" || !ENTRYPOINT_PATTERN.test(template.entrypoint))) {
    add("template.entrypoint", "pattern", "template.entrypoint is one executable name (no spaces).");
  }
  if (template.flagFormat !== undefined && !FLAG_FORMATS.includes(template.flagFormat)) {
    add("template.flagFormat", "enum", `template.flagFormat must be one of ${FLAG_FORMATS.join(", ")}.`);
  }

  // Files first: their ids are placeholders (file.<id>) in args and env.
  const fileIds = new Set();
  const files = template.files === undefined ? [] : template.files;
  if (!Array.isArray(files)) add("template.files", "type", "template.files must be a list.");
  else {
    const targets = new Set();
    files.forEach((file, index) => {
      const path = joinPath("template.files", index);
      if (!isPlainObject(file)) {
        add(path, "type", "A template file is an object.");
        return;
      }
      for (const key of Object.keys(file)) {
        if (!["id", "target", "format", "content", "secret"].includes(key)) add(joinPath(path, key), "unknown_field", `Unknown template file field "${key}".`);
      }
      if (typeof file.id !== "string" || !FILE_ID_PATTERN.test(file.id)) add(joinPath(path, "id"), "pattern", "A template file id is camelCase letters, digits and underscores.");
      else if (fileIds.has(file.id)) add(joinPath(path, "id"), "duplicate", `Template file id "${file.id}" is used twice.`);
      else fileIds.add(file.id);
      if (typeof file.target !== "string" || !TARGET_PATTERN.test(file.target) || file.target.split("/").some((part) => part === "..")) {
        add(joinPath(path, "target"), "pattern", "A template file target is an absolute container path without \"..\".");
      } else if (targets.has(file.target)) add(joinPath(path, "target"), "duplicate", `Template file target "${file.target}" is used twice.`);
      else targets.add(file.target);
      if (!FILE_FORMATS.includes(file.format)) add(joinPath(path, "format"), "enum", `A template file format is one of ${FILE_FORMATS.join(", ")}.`);
      if (file.secret !== undefined && typeof file.secret !== "boolean") add(joinPath(path, "secret"), "type", "secret must be true or false.");
    });
  }

  function checkString(text, path, scope) {
    nodes += 1;
    if (typeof text !== "string") {
      add(path, "type", "Expected a string.");
      return;
    }
    if (text.length > MAX_STRING || text.includes("\u0000")) {
      add(path, "invalid_string", `A template string is at most ${MAX_STRING} characters with no NUL.`);
      return;
    }
    const parsed = parseTemplateString(text);
    for (const problem of parsed.errors) add(path, problem.code, problem.message);
    for (const part of parsed.parts) {
      if (!part.name) continue;
      const kind = classifyName(part.name);
      if (kind === "file") {
        if (!fileIds.has(part.name.slice("file.".length))) add(path, "template_unknown_placeholder", `Placeholder {{${part.name}}} names a file the template does not declare.`);
      } else if (kind === "item") {
        if (!scope.repeat) add(path, "template_item_outside_repeat", `Placeholder {{${part.name}}} is valid only inside a repeat group.`);
      } else if (kind === "secret") {
        if (!scope.secretFile) add(path, "template_secret_placeholder", `Placeholder {{${part.name}}} is valid only in a file marked secret:true.`);
      } else if (kind === "param") {
        if (part.name.startsWith("file.") || part.name.startsWith("secrets.") || part.name.startsWith("item.")) {
          add(path, "template_unknown_placeholder", `Unknown placeholder {{${part.name}}}.`);
        } else if (!expr.PARAM_ID_PATTERN.test(part.name) || (paramIds && !paramIds.has(part.name))) {
          add(path, "template_unknown_placeholder", `Unknown placeholder {{${part.name}}}: it is neither a template variable nor a parameter of this engine's catalog.`);
        }
      }
    }
  }

  function checkWhen(when, path) {
    const compiled = expr.compileExpr(when, { paramIds: paramIds ? [...paramIds] : undefined, envAllowlist: [] });
    for (const problem of compiled.errors) add(joinPath(path, problem.path || ""), `when_${problem.code}`, problem.message);
  }

  function checkItems(list, path, scope, depth) {
    if (!Array.isArray(list)) {
      add(path, "type", `${path} must be a list.`);
      return;
    }
    list.forEach((item, index) => checkItem(item, joinPath(path, index), scope, depth));
  }

  function checkItem(item, path, scope, depth) {
    nodes += 1;
    if (nodes > MAX_NODES) {
      if (nodes === MAX_NODES + 1) add(path, "too_large", `A template has at most ${MAX_NODES} nodes.`);
      return;
    }
    if (depth > MAX_DEPTH) {
      add(path, "too_deep", "A template is nested too deeply.");
      return;
    }
    if (typeof item === "string") {
      checkString(item, path, scope);
      return;
    }
    if (!isPlainObject(item)) {
      add(path, "type", "A template item is a string token or an object.");
      return;
    }
    if (Object.hasOwn(item, "flag")) {
      for (const key of Object.keys(item)) {
        if (!["flag", "value", "format"].includes(key)) add(joinPath(path, key), "unknown_field", `A flag item has flag, value and format, not "${key}".`);
      }
      if (typeof item.flag !== "string" || !FLAG_PATTERN.test(item.flag)) add(joinPath(path, "flag"), "pattern", "flag must be a command-line flag such as --port.");
      if (item.format !== undefined && !FLAG_FORMATS.includes(item.format)) add(joinPath(path, "format"), "enum", `format must be one of ${FLAG_FORMATS.join(", ")}.`);
      checkString(item.value, joinPath(path, "value"), scope);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!["args", "when", "repeat"].includes(key)) add(joinPath(path, key), "unknown_field", `A group item has args, when and repeat, not "${key}".`);
    }
    let inner = scope;
    if (item.repeat !== undefined) {
      if (typeof item.repeat !== "string") add(joinPath(path, "repeat"), "type", "repeat is a \"{{list}}\" placeholder.");
      else {
        const parsed = parseTemplateString(item.repeat);
        const single = parsed.parts.length === 1 && parsed.parts[0].name && !parsed.parts[0].filter ? parsed.parts[0].name : null;
        if (parsed.errors.length || !single || classifyName(single) !== "param") {
          add(joinPath(path, "repeat"), "template_repeat_invalid", "repeat is exactly one placeholder naming a list parameter.");
        } else {
          checkString(item.repeat, joinPath(path, "repeat"), scope);
        }
      }
      inner = { ...scope, repeat: true };
    }
    if (item.when !== undefined) checkWhen(item.when, joinPath(path, "when"));
    if (item.args === undefined) add(joinPath(path, "args"), "required", "A group item needs args.");
    else checkItems(item.args, joinPath(path, "args"), inner, depth + 1);
  }

  const baseScope = { repeat: false, secretFile: false };
  if (template.args === undefined) add("template.args", "required", "template.args is required.");
  else checkItems(template.args, "template.args", baseScope, 0);

  if (template.env !== undefined) {
    if (!isPlainObject(template.env)) add("template.env", "type", "template.env must be an object of NAME: value.");
    else {
      for (const [name, value] of Object.entries(template.env)) {
        const path = joinPath("template.env", name);
        if (!ENV_NAME_PATTERN.test(name)) add(path, "pattern", `"${name.slice(0, 64)}" is not an environment variable name.`);
        checkString(value, path, baseScope);
      }
    }
  }

  if (Array.isArray(files)) {
    files.forEach((file, index) => {
      if (!isPlainObject(file)) return;
      const path = joinPath(joinPath("template.files", index), "content");
      if (file.content === undefined) {
        add(path, "required", "A template file needs content.");
        return;
      }
      const scope = { repeat: false, secretFile: file.secret === true };
      if (file.format === "text") {
        checkString(file.content, path, scope);
        return;
      }
      if (!isPlainObject(file.content) && !Array.isArray(file.content)) {
        add(path, "type", "A yaml or json file's content is an object or a list.");
        return;
      }
      const walk = (value, at, depth) => {
        nodes += 1;
        if (nodes > MAX_NODES) {
          if (nodes === MAX_NODES + 1) add(at, "too_large", `A template has at most ${MAX_NODES} nodes.`);
          return;
        }
        if (depth > MAX_DEPTH) {
          add(at, "too_deep", "A template is nested too deeply.");
          return;
        }
        if (typeof value === "string") checkString(value, at, scope);
        else if (Array.isArray(value)) value.forEach((item, i) => walk(item, joinPath(at, i), depth + 1));
        else if (isPlainObject(value)) {
          for (const [key, item] of Object.entries(value)) {
            if (key.includes("{{") || key.includes("}}")) add(joinPath(at, key), "template_placeholder_syntax", "A file key is literal text, not a placeholder.");
            walk(item, joinPath(at, key), depth + 1);
          }
        } else if (!(value === null || typeof value === "number" || typeof value === "boolean")) {
          add(at, "type", "File content holds objects, lists, strings, numbers, booleans and null.");
        }
      };
      walk(file.content, path, 0);
    });
  }
  return errors;
}

module.exports = {
  ENV_NAME_PATTERN,
  FILE_FORMATS,
  FILTERS,
  FLAG_FORMATS,
  GPUSTACK_ALIASES,
  RESERVED_NAMES,
  SECRET_NAMES,
  canonicalName,
  classifyName,
  parseTemplateString,
  validateTemplate,
};
