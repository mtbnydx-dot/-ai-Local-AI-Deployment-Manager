"use strict";

// Report-only Doctor (06 §7). Fix execution belongs to OPS-9b and the CLI
// belongs to OPS-7a. Every check receives the same memoized probe boundary.
const path = require("node:path");
const configApi = require("./config");
const components = require("./components");
const { redactValue } = require("../secret-redactor");
const { allSecretValues } = require("../secret-store");
const { createDefaultProbes } = require("./doctor-probes");

const CHECK_GROUPS = Object.freeze(["env", "runtime", "storage"]);
const STATUS_IDS = Object.freeze(["ok", "warn", "fail", "info", "skip"]);
const CHECK_IDS = Object.freeze([
  "env.node-version", "env.node-sqlite", "env.deps.*", "env.mcp-dist", "env.download-cli", "env.python", "env.pwsh", "env.git",
  "runtime.docker-cli", "runtime.docker-daemon", "runtime.wsl", "runtime.wslconfig", "runtime.nvidia-driver", "runtime.images", "runtime.gpu-in-docker",
  "storage.ai-root", "storage.model-roots", "storage.hf-cache", "storage.docker-data", "storage.writable",
]);

function selected(value) { return value === undefined ? null : new Set(Array.isArray(value) ? value : [value]); }
function milliseconds(now) { const value = now(); return value instanceof Date ? value.getTime() : Number(value); }

async function runDoctor(options = {}) {
  const env = options.env || process.env;
  const aiRoot = path.resolve(options.aiRoot || env.AI_ROOT || path.join(__dirname, "../.."));
  const clock = options.now || Date.now;
  const started = milliseconds(clock);
  const config = options.config || configApi.loadPlatformConfig({ aiRoot, env });
  const registry = options.registry || components.loadComponentRegistry({ aiRoot, config, now: started });
  const getSecrets = options.getSecrets || (() => allSecretValues(aiRoot, { onError: (namespace, error) => { throw error; } }));
  const ctx = {
    aiRoot, env, config, registry, platform: options.platform || process.platform, deep: options.deep === true,
    value: (key, fallback) => config.values?.[key] ?? config[key] ?? fallback,
    fix: (checkId, id, risk, zh, en, docs = "/docs/troubleshooting.md", extra = {}) => ({ id, risk, label: { "zh-CN": zh, "en-US": en }, command: `platform doctor --fix=${checkId}`, docs, ...extra }),
  };
  const defaults = createDefaultProbes(ctx, options.probeOptions);
  const probes = { ...defaults, ...(options.probes || {}) };
  const pending = new Map();
  ctx.probe = (name, ...args) => {
    const key = `${name}:${JSON.stringify(args)}`;
    if (!pending.has(key)) pending.set(key, Promise.resolve().then(() => {
      if (!Object.hasOwn(probes, name)) throw Object.assign(new Error(`Probe ${name} is unavailable.`), { code: "probe_unavailable" });
      return typeof probes[name] === "function" ? probes[name](...args) : probes[name];
    }));
    return pending.get(key);
  };
  ctx.isWorktree = options.isWorktree === undefined ? await ctx.probe("isWorktree") : options.isWorktree === true;
  const groups = selected(options.groups), ids = selected(options.ids);
  const descriptors = CHECK_GROUPS.flatMap((group) => require(`./checks/${group}`).createChecks(ctx));
  const requested = descriptors.filter((check) => (!groups || groups.has(check.group)) && (!ids || ids.has(check.id) || (check.id.startsWith("env.deps.") && ids.has("env.deps.*"))));
  const checks = await Promise.all(requested.map(async (descriptor) => {
    const at = milliseconds(clock);
    let result;
    try {
      result = descriptor.deep && !ctx.deep
        ? { status: "skip", detail: "Deep probe was not requested.", data: { reason: "deep_not_requested" } }
        : await descriptor.run();
      if (!result || !STATUS_IDS.includes(result.status)) throw Object.assign(new Error("Probe returned an invalid check result."), { code: "invalid_probe_result" });
    } catch (error) {
      result = { status: "fail", detail: `Probe failed: ${error.message || error.code || "unknown error"}`, data: { code: String(error.code || "probe_failed") }, fix: descriptor.fix || null };
    }
    const record = { id: descriptor.id, group: descriptor.group, status: result.status, title: descriptor.title, detail: String(result.detail || ""), data: result.data || {}, durationMs: Math.max(0, milliseconds(clock) - at), fix: result.fix || null, actions: result.actions || (result.fix ? [result.fix.id] : []) };
    try {
      return options.redactor ? options.redactor.redactValue(record) : redactValue(record, { secrets: getSecrets() });
    } catch {
      // A broken vault must not turn an opaque token into visible diagnostic
      // text. Withhold the entire payload rather than guessing what is secret.
      return { ...record, status: "fail", detail: "Secret redaction is unavailable; diagnostic details were withheld.", data: { code: "secret_redaction_unavailable" }, fix: null, actions: [] };
    }
  }));
  const summary = Object.fromEntries(STATUS_IDS.map((status) => [status, checks.filter((check) => check.status === status).length]));
  return { schemaVersion: 1, at: new Date(started).toISOString(), durationMs: Math.max(0, milliseconds(clock) - started), summary, checks };
}

module.exports = { runDoctor, createDefaultProbes, CHECK_IDS, CHECK_GROUPS };
