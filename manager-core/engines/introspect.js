"use strict";

const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { redactSecrets } = require("../secret-redactor");
const { introspectedFlagIndex } = require("./param-catalog");
const { getRuntimeFacts } = require("./runtime-facts");

const TIMEOUT_MS = 180_000;
const MAX_HELP_BYTES = 8 * 1024 * 1024;
const PARSERS = Object.freeze(["argparse", "llama-help", "click"]);

function introspectionError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function scalar(text) {
  const value = text.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (/^(none|null)$/i.test(value)) return null;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Parse option rows plus wrapped help; usage synopses never become flags. */
function parseHelp(raw, parser = "argparse") {
  if (!PARSERS.includes(parser)) throw introspectionError("unknown_help_parser", `Unsupported help parser ${parser}.`, 400);
  const text = redactSecrets(String(raw || "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\r\n?/g, "\n"));
  const entries = [];
  let current = null;
  let group = null;
  for (const line of text.split("\n")) {
    // A flag has to begin the row, after whitespace. Headers and usage lines
    // are excluded; comma-separated aliases may contain extra alignment spaces.
    const match = /^\s*(-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]*)(.*)$/.exec(line);
    if (match) {
      const names = [match[1]];
      let remainder = match[2];
      let alias;
      while ((alias = /^\s*(?:(?:\{[^}]+\}|[A-Z][A-Z0-9_]*)\s*)?,\s*(--?[A-Za-z0-9][A-Za-z0-9_.-]*)(.*)$/.exec(remainder))) {
        names.push(alias[1]);
        remainder = alias[2];
      }
      const flag = names.find((name) => name.startsWith("--")) || names[0];
      const parts = remainder.trim().split(/\s{2,}/);
      let valueHint = /^\s\S/.test(remainder) && /^(\{[^}]+\}|\[[^\]]+\]|[A-Z][A-Z0-9_<>| .\[\]-]*)(?:\s|$)/.test(parts[0] || "") ? parts.shift() : "";
      // A bool-pair signature has no metavar, even if help is absent.
      if (names.some((name) => name.startsWith("--no-"))) valueHint = "";
      const choiceText = /^\{([^}]+)\}$/.exec(valueHint) || (parser === "click" ? /^\[([^\]]*\|[^\]]*)\]$/.exec(valueHint) : null);
      const choices = choiceText ? choiceText[1].split(/[,|]/).map((item) => scalar(item)).filter((item) => item !== "") : [];
      current = { flag, aliases: names.filter((name) => name !== flag), takesValue: Boolean(valueHint), valueHint: valueHint || null, choices, default: null, env: null, help: parts.join(" "), group };
      entries.push(current);
    } else if (line.trim() && !/^\s/.test(line)) {
      current = null;
      if (/:$/.test(line.trim())) group = line.trim().slice(0, -1);
    } else if (current && line.trim()) {
      current.help += `${current.help ? " " : ""}${line.trim()}`;
    }
  }
  for (const entry of entries) {
    const fallback = /\(default:\s*(.*?)\)|\[default:\s*(.*?)\]/i.exec(entry.help);
    if (fallback) entry.default = scalar(fallback[1] ?? fallback[2]);
    const env = /\(env:\s*([A-Z_][A-Z0-9_]*)\)/i.exec(entry.help);
    if (env) entry.env = env[1];
  }
  // Some help renderers repeat an option in multiple groups.
  return [...new Map(entries.map((entry) => [entry.flag, entry])).values()];
}

function flagsOf(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.flags) ? value.flags : [];
}

function catalogFlagSet(catalog) {
  const flags = new Set();
  for (const param of catalog?.params || []) {
    for (const flag of [param.emit?.flag, param.emit?.falseFlag, ...(param.flags || []).map((item) => item.flag)]) if (flag) flags.add(flag);
  }
  return flags;
}

function diffFlagSets(a, b, catalog) {
  const previous = new Map(flagsOf(a).map((entry) => [entry.flag, entry]));
  const next = new Map(flagsOf(b).map((entry) => [entry.flag, entry]));
  const report = { added: [...next.keys()].filter((flag) => !previous.has(flag)).sort(), removed: [...previous.keys()].filter((flag) => !next.has(flag)).sort(), renamed: [], choicesChanged: [], defaultsChanged: [], catalogMissing: [], catalogUnmapped: [] };
  for (const from of report.removed) {
    for (const to of report.added) {
      const old = previous.get(from);
      const fresh = next.get(to);
      if ((fresh.aliases || []).includes(from) || (old.aliases || []).includes(to)) report.renamed.push({ from, to, evidence: "alias" });
      else if (new RegExp(`(?:deprecated|renamed|use)[\\s\\S]*${to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|[.,;)]|$)`, "i").test(old.help || "")) report.renamed.push({ from, to, evidence: old.help });
    }
  }
  for (const [flag, fresh] of next) {
    const old = previous.get(flag);
    if (!old) continue;
    const added = (fresh.choices || []).filter((choice) => !(old.choices || []).includes(choice));
    const removed = (old.choices || []).filter((choice) => !(fresh.choices || []).includes(choice));
    if (added.length || removed.length) report.choicesChanged.push({ flag, added, removed });
    if (JSON.stringify(old.default) !== JSON.stringify(fresh.default)) report.defaultsChanged.push({ flag, from: old.default ?? null, to: fresh.default ?? null });
  }
  if (catalog) {
    const known = catalogFlagSet(catalog);
    const index = introspectedFlagIndex({ flags: [...next.values()] });
    report.catalogMissing = [...known].filter((flag) => !index.has(flag)).sort();
    report.catalogUnmapped = [...next.values()].filter((entry) => ![entry.flag, ...(entry.aliases || [])].some((flag) => known.has(flag))).map((entry) => entry.flag).sort();
  }
  return report;
}

function refineAutoParsers(capabilities, facts) {
  const result = JSON.parse(JSON.stringify(capabilities));
  const index = introspectedFlagIndex(facts);
  for (const [kind, flag] of [["tool", "--tool-call-parser"], ["reasoning", "--reasoning-parser"]]) {
    const entry = index?.get(flag);
    if (entry?.default === "auto" && entry.choices?.includes("auto")) result.autoParsers[kind] = "auto";
  }
  return result;
}

function buildIntrospectionCommand(descriptor, image, options = {}) {
  const name = options.name || `ai-introspect-${crypto.randomBytes(4).toString("hex")}`;
  if (!/^ai-introspect-[a-f0-9]{8}$/.test(name)) throw introspectionError("invalid_probe_name", "Invalid introspection container name.", 400);
  if (!descriptor?.introspection || !PARSERS.includes(descriptor.introspection.parser)) throw introspectionError("introspection_unsupported", "This engine does not support flag introspection.", 400);
  return {
    name,
    command: options.dockerConfig?.dockerExe || "docker",
    args: [...(options.dockerConfig?.dockerArgsPrefix || []), "run", "--rm", "--pull", "never", "--network", "none", "--memory", "4g", "--cpus", "2", "--name", name, "--entrypoint", descriptor.introspection.entrypoint, image, ...descriptor.introspection.argv],
  };
}

async function introspectRuntime(engineId, runtimeId, options = {}) {
  const registry = options.registry || require("./registry").getEngineRegistry();
  const descriptor = registry.require(engineId);
  const runtime = registry.resolveRuntime(engineId, { runtimeId });
  const facts = options.runtimeFacts || getRuntimeFacts();
  const imageId = await facts.imageId(runtime.image, { force: true });
  if (!imageId) throw introspectionError("runtime_image_missing", "请先拉取镜像 / Pull the image first", 409);
  const dockerConfig = options.dockerConfig || require("./hosts/docker").createDockerHostConfig();
  // Run the inspected ID, so a concurrent retag cannot probe another image.
  const command = buildIntrospectionCommand(descriptor, imageId, { dockerConfig, name: options.name });
  const execute = options.execFileAsync || promisify(execFile);
  let result;
  try {
    result = await execute(command.command, command.args, { windowsHide: true, timeout: options.timeoutMs ?? TIMEOUT_MS, maxBuffer: MAX_HELP_BYTES });
  } catch (error) {
    // Only this explicitly-created probe may be removed; no model container
    // name or manager label is accepted by the command renderer.
    if (error.killed || error.code === "ETIMEDOUT") {
      try { await execute(command.command, [...dockerConfig.dockerArgsPrefix, "rm", "-f", command.name], { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 }); } catch {}
      throw introspectionError("introspection_timeout", "Flag introspection exceeded the time limit.");
    }
    throw introspectionError("introspection_failed", redactSecrets(error.message || "Flag introspection failed."));
  }
  const raw = `${result.stdout || ""}\n${result.stderr || ""}`;
  const section = { capturedAt: new Date((options.now || Date.now)()).toISOString(), argv: command.args, rawSha256: crypto.createHash("sha256").update(raw).digest("hex"), flags: parseHelp(raw, descriptor.introspection.parser) };
  if (!section.flags.length) throw introspectionError("introspection_empty", "The runtime help output contained no recognized flags.");
  await facts.put(runtime.runtimeId, "flags", section, { imageId });
  return { engineId, runtimeId: runtime.runtimeId, imageId, flags: section };
}

module.exports = { TIMEOUT_MS, MAX_HELP_BYTES, PARSERS, parseHelp, parseArgparse: (raw) => parseHelp(raw, "argparse"), parseLlamaHelp: (raw) => parseHelp(raw, "llama-help"), parseClick: (raw) => parseHelp(raw, "click"), diffFlagSets, catalogFlagSet, refineAutoParsers, buildIntrospectionCommand, introspectRuntime };
