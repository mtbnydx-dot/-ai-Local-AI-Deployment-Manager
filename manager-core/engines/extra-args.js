"use strict";

// Validation of the free-form launch inputs (docs/overhaul/01-engines.md §18):
//
//   validateExtraArgs(tokens, { catalog, introspected, descriptor, storage, values })
//     → { ok, errors, warnings, args, flags }
//   validateExtraEnv(env, { descriptor }) → { ok, errors, warnings, env }
//
// Both are pure: no shell, no file access of their own (path confinement goes
// through the model-storage object the caller hands in) and no network. The
// resolver appends the validated tokens after every generated argument, and
// the plan shows them as `custom`. Errors and warnings are field errors with
// a "中文 / English" message, like the resolver's own.

const path = require("node:path");
const { introspectedFlagIndex } = require("./param-catalog");

const MAX_TOKENS = 64;
const MAX_TOKEN_LENGTH = 4096;
const MAX_ENV_VALUE_LENGTH = 4096;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const FLAG_NAME_PATTERN = /^--?[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const NEGATIVE_NUMBER = /^-\d/;
const PATH_HINT = /PATH|FILE|DIR/i;

// Names (or shapes) an operator cannot set through extraEnv, whatever the
// descriptor allows: credentials, device selection, library injection.
const ENV_DENIED_EXACT = new Set(["CUDA_VISIBLE_DEVICES", "LD_PRELOAD", "PYTHONPATH", "PATH", "HOME"]);
const ENV_DENIED_LLAMA = new Set(["LLAMA_ARG_HOST", "LLAMA_ARG_PORT", "LLAMA_ARG_API_KEY", "LLAMA_ARG_ALIAS", "LLAMA_ARG_MODEL"]);

function fieldError(field, code, zh, en, extra = {}) {
  return { field, code, message: `${zh} / ${en}`, ...extra };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function short(text, limit = 64) {
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function looksLikeFlag(token) {
  return token.startsWith("-") && token.length > 1 && !NEGATIVE_NUMBER.test(token);
}

function paramFlags(param) {
  return [param?.emit?.flag, param?.emit?.falseFlag, ...(Array.isArray(param?.flags) ? param.flags.map((item) => item?.flag) : [])]
    .filter((flag) => typeof flag === "string" && flag);
}

function isSet(value) {
  if (value === undefined || value === null) return false;
  const plain = isPlainObject(value) && Object.hasOwn(value, "value") ? value.value : value;
  return plain !== undefined && plain !== null && plain !== "";
}

// Every spelling of a flag: itself, its introspected aliases and its --no- twin.
function spellings(flag, index) {
  const names = new Set([flag]);
  const entry = index ? index.get(flag) : null;
  if (entry) {
    names.add(entry.flag);
    for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) names.add(alias);
  }
  for (const name of [...names]) {
    if (name.startsWith("--no-")) names.add(`--${name.slice(5)}`);
    else if (name.startsWith("--")) names.add(`--no-${name.slice(2)}`);
  }
  return names;
}

function pathFlagSet(catalog) {
  const flags = new Set();
  for (const param of catalog?.params || []) {
    if (param?.type !== "path") continue;
    for (const flag of paramFlags(param)) flags.add(flag);
  }
  return flags;
}

function confinePath(storage, raw) {
  if (!storage || typeof storage.toContainerPath !== "function") return { ok: false, reason: "no_storage" };
  const text = String(raw);
  const local = typeof storage.fromContainerPath === "function" ? storage.fromContainerPath(text) : text;
  // A relative path would pass through unchanged, outside every storage root.
  if (!path.isAbsolute(local) && !path.posix.isAbsolute(local) && !path.win32.isAbsolute(local)) return { ok: false, reason: "not_absolute" };
  try {
    if (typeof storage.resolvePath === "function") storage.resolvePath(local);
    return { ok: true, value: String(storage.toContainerPath(text)) };
  } catch {
    return { ok: false, reason: "outside_storage" };
  }
}

function validateExtraArgs(tokens, options = {}) {
  const { catalog = null, introspected = null, descriptor = null, storage = null, values = null } = options;
  const errors = [];
  const warnings = [];
  const args = [];
  const flags = [];
  const result = () => ({ ok: errors.length === 0, errors, warnings, args: errors.length ? [] : args, flags });

  if (tokens === undefined || tokens === null) return result();
  if (!Array.isArray(tokens)) {
    errors.push(fieldError("extraArgs", "extra_arg_invalid", "extraArgs 必须是字符串数组", "extraArgs must be an array of strings"));
    return result();
  }
  if (tokens.length > MAX_TOKENS) {
    errors.push(fieldError("extraArgs", "extra_arg_invalid", `额外参数最多 ${MAX_TOKENS} 个`, `At most ${MAX_TOKENS} extra arguments are accepted`));
    return result();
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const field = `extraArgs[${index}]`;
    if (typeof token !== "string") {
      errors.push(fieldError(field, "extra_arg_invalid", "额外参数必须是字符串", "Each extra argument must be a string"));
    } else if (token.length > MAX_TOKEN_LENGTH) {
      errors.push(fieldError(field, "extra_arg_invalid", `额外参数不能超过 ${MAX_TOKEN_LENGTH} 个字符`, `An extra argument is limited to ${MAX_TOKEN_LENGTH} characters`));
    } else if (/[\0\r\n]/.test(token)) {
      errors.push(fieldError(field, "extra_arg_invalid", "额外参数不能包含空字符或换行", "An extra argument cannot contain NUL or a line break"));
    }
  }
  if (errors.length) return result();

  const index = introspectedFlagIndex(introspected);
  const catalogFlags = new Set();
  for (const param of catalog?.params || []) for (const flag of paramFlags(param)) catalogFlags.add(flag);
  const managed = new Set((Array.isArray(descriptor?.managedFlags) ? descriptor.managedFlags : []).map(String));
  const owned = new Map();
  if (isPlainObject(values)) {
    for (const param of catalog?.params || []) {
      if (!isSet(values[param.id])) continue;
      for (const flag of paramFlags(param)) owned.set(flag, param.id);
    }
  }
  const pathFlags = pathFlagSet(catalog);

  let current = null;
  const closeCurrent = () => {
    if (current && !current.rejected) flags.push(current);
    current = null;
  };

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    const field = `extraArgs[${at}]`;
    if (!looksLikeFlag(token)) {
      // A value belongs to the flag before it; a flag known to take none, or
      // no flag at all, leaves the token with no meaning.
      if (current?.rejected) continue;
      if (!current || current.takesValue === false) {
        errors.push(fieldError(field, "extra_arg_invalid",
          `“${short(token)}”不属于任何参数；额外参数必须以 --flag 开头`,
          `"${short(token)}" does not belong to any flag; extra arguments must start with a --flag`));
        continue;
      }
      let emitted = token;
      if (current.pathLike) {
        const confined = confinePath(storage, token);
        if (!confined.ok) {
          errors.push(fieldError(field, "extra_arg_denied",
            `${current.flag} 的路径必须位于已登记的模型库内`,
            `The path for ${current.flag} must be inside a registered model storage root`, { flag: current.flag, reason: confined.reason }));
          continue;
        }
        emitted = confined.value;
      }
      args.push(emitted);
      current.values.push(emitted);
      continue;
    }

    closeCurrent();
    const split = token.indexOf("=");
    const flag = split > 0 && token.startsWith("--") ? token.slice(0, split) : token;
    const inline = split > 0 && token.startsWith("--") ? token.slice(split + 1) : null;
    if (!FLAG_NAME_PATTERN.test(flag)) {
      errors.push(fieldError(field, "extra_arg_invalid", `“${short(flag)}”不是有效的参数名`, `"${short(flag)}" is not a valid flag name`));
      current = { rejected: true };
      continue;
    }

    const names = spellings(flag, index);
    const managedHit = [...names].find((name) => managed.has(name));
    if (managedHit) {
      errors.push(fieldError(field, "extra_arg_denied",
        `${flag} 由平台管理，不能放进额外参数`,
        `${flag} is managed by the platform and cannot be set through extra arguments`, { flag, reason: "managed" }));
      current = { rejected: true };
      continue;
    }
    const ownedHit = [...names].find((name) => owned.has(name));
    if (ownedHit) {
      const param = owned.get(ownedHit);
      errors.push(fieldError(field, "extra_arg_denied",
        `${flag} 已由参数“${param}”设置，不能重复指定`,
        `${flag} is already set by parameter "${param}" and cannot be given twice`, { flag, reason: "duplicate", param }));
      current = { rejected: true };
      continue;
    }

    const entry = index ? index.get(flag) || null : null;
    let state;
    if (index) {
      if (!entry) {
        errors.push(fieldError(field, "extra_arg_unknown",
          `当前运行时不认识 ${flag}`,
          `${flag} is not a flag of this runtime`, { flag }));
        current = { rejected: true };
      continue;
      }
      state = "available";
    } else if (catalogFlags.has(flag)) {
      state = "catalog";
    } else {
      state = "unverified";
      warnings.push(fieldError(field, "extra_arg_unverified",
        `${flag} 尚未通过运行时自省验证，将按原样传给引擎`,
        `${flag} is not verified against the runtime's own help yet; it is passed to the engine as given`, { flag }));
    }

    const pathLike = pathFlags.has(flag) || (entry && typeof entry.valueHint === "string" && PATH_HINT.test(entry.valueHint));
    current = {
      flag,
      state,
      pathLike: Boolean(pathLike),
      takesValue: entry ? Boolean(entry.takesValue) : inline !== null ? true : null,
      values: [],
    };
    if (inline !== null) {
      if (current.pathLike) {
        const confined = confinePath(storage, inline);
        if (!confined.ok) {
          errors.push(fieldError(field, "extra_arg_denied",
            `${flag} 的路径必须位于已登记的模型库内`,
            `The path for ${flag} must be inside a registered model storage root`, { flag, reason: confined.reason }));
          current = { rejected: true };
          continue;
        }
        args.push(`${flag}=${confined.value}`);
        current.values.push(confined.value);
      } else {
        args.push(token);
        current.values.push(inline);
      }
      // A --flag=value pair is complete; a following bare token is not its value.
      current.takesValue = false;
    } else {
      args.push(token);
    }
  }
  closeCurrent();
  return result();
}

function isDeniedEnvName(name) {
  if (ENV_DENIED_EXACT.has(name) || ENV_DENIED_LLAMA.has(name)) return true;
  return /_API_KEY$/.test(name) || name === "API_KEY" || name.includes("TOKEN") || name.startsWith("HF_")
    || name.startsWith("NVIDIA_") || name.endsWith("_PROXY") || name === "PROXY";
}

function validateExtraEnv(env, options = {}) {
  const { descriptor = null } = options;
  const errors = [];
  const warnings = [];
  const out = {};
  const result = () => ({ ok: errors.length === 0, errors, warnings, env: errors.length ? {} : out });

  if (env === undefined || env === null) return result();
  if (!isPlainObject(env)) {
    errors.push(fieldError("extraEnv", "extra_env_invalid", "extraEnv 必须是对象", "extraEnv must be an object of names and values"));
    return result();
  }
  const allow = (Array.isArray(descriptor?.extraEnvAllow) ? descriptor.extraEnvAllow : []).map(String);
  for (const [name, raw] of Object.entries(env)) {
    const field = `extraEnv.${short(name, 80)}`;
    if (!ENV_NAME_PATTERN.test(name)) {
      errors.push(fieldError(field, "extra_env_invalid",
        "环境变量名只能包含大写字母、数字和下划线，且不超过 64 个字符",
        "An environment variable name uses upper-case letters, digits and underscores, up to 64 characters"));
      continue;
    }
    if (isDeniedEnvName(name)) {
      errors.push(fieldError(field, "extra_env_denied",
        `${name} 由平台管理或涉及凭据，不能设置`,
        `${name} is managed by the platform or carries credentials and cannot be set`, { name, reason: "denied" }));
      continue;
    }
    if (!allow.some((prefix) => name.startsWith(prefix))) {
      errors.push(fieldError(field, "extra_env_denied",
        `${name} 不在这个引擎允许的环境变量前缀内`,
        `${name} does not start with a prefix this engine allows`, { name, reason: "not_allowed", allowed: allow }));
      continue;
    }
    if (!["string", "number", "boolean"].includes(typeof raw)) {
      errors.push(fieldError(field, "extra_env_invalid", "环境变量的值必须是字符串", "An environment variable value must be a string", { name }));
      continue;
    }
    const value = String(raw);
    if (value.length > MAX_ENV_VALUE_LENGTH || value.includes("\0")) {
      errors.push(fieldError(field, "extra_env_invalid",
        `环境变量的值不能超过 ${MAX_ENV_VALUE_LENGTH} 个字符，也不能包含空字符`,
        `An environment variable value is limited to ${MAX_ENV_VALUE_LENGTH} characters and cannot contain NUL`, { name }));
      continue;
    }
    out[name] = value;
  }
  return result();
}

module.exports = {
  MAX_TOKENS,
  MAX_TOKEN_LENGTH,
  MAX_ENV_VALUE_LENGTH,
  isDeniedEnvName,
  validateExtraArgs,
  validateExtraEnv,
};
