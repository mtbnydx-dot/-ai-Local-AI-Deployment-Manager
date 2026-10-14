"use strict";

// Hook of the platform-mcp component (docs/overhaul/06-ops.md §3.4). It ports
// scripts/start-platform-mcp.ps1:89-176:
// - prepare: the MCP key lives in the secret store (namespace "platform", name
//   platformMcp.apiKey). A key found in a legacy .runtime/platform-mcp/server.env
//   is imported, read back, and only then is the file rewritten without it.
//   With no key anywhere, 32 random bytes are generated. The key reaches the
//   child through env only, never argv.
// - afterReady: keeps writing .runtime/platform-mcp/server.pid for the legacy
//   status and stop scripts, and asserts the process listens on loopback only;
//   otherwise it is killed and the component is failed.
// The PLATFORM_MCP_* defaults themselves come from the registry entry and
// childEnv, so this hook adds only what needs the store or the process.

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const path = require("node:path");

const SECRET_NAMESPACE = "platform";
const SECRET_NAME = "platformMcp.apiKey";
const KEY_ENV = "PLATFORM_MCP_API_KEY";
const SEARCH_KEY_ENV = "PLATFORM_MCP_SEARCH_GATEWAY_API_KEY";
const MIN_KEY_LENGTH = 32;
const MIN_SEARCH_KEY_LENGTH = 16;
const RUNTIME_DIR = path.join(".runtime", "platform-mcp");
const SERVER_ENV_NAME = "server.env";
const SERVER_PID_NAME = "server.pid";
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"]);
const SECRET_LINE_PATTERN = /^\s*([A-Za-z0-9_]+)\s*=/;
const SECRET_NAME_SEGMENTS = new Set(["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "APIKEY"]);
const SCRUBBED_HEADER = "# The Platform MCP access key now lives in the platform secret store. Use `platform secrets copy platformMcp.apiKey` for MCP client setup.";

function runtimeFile(aiRoot, name) {
  return path.join(path.resolve(String(aiRoot)), RUNTIME_DIR, name);
}

function isSecretName(name) {
  return String(name).toUpperCase().split("_").some((segment) => SECRET_NAME_SEGMENTS.has(segment));
}

function newApiKey(randomBytes) {
  return Buffer.from(randomBytes(32)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// -> { key, keptLines, hadSecretLines }. A line that is not NAME=value is kept as it is.
function readLegacyServerEnv(file, fsImpl) {
  let text;
  try {
    text = fsImpl.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let key = "";
  let hadSecretLines = false;
  const keptLines = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const match = SECRET_LINE_PATTERN.exec(line);
    if (match && isSecretName(match[1])) {
      hadSecretLines = true;
      if (match[1] === KEY_ENV) key = line.slice(line.indexOf("=") + 1).trim();
      continue;
    }
    if (line.trim() && !line.startsWith("# Generated locally")) keptLines.push(line);
  }
  return { key, keptLines, hadSecretLines };
}

function writeScrubbed(file, keptLines, fsImpl) {
  const content = `${[SCRUBBED_HEADER, ...keptLines.filter((line) => line !== SCRUBBED_HEADER)].join("\r\n")}\r\n`;
  const temp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(temp, content, { encoding: "ascii" });
  fsImpl.renameSync(temp, file);
}

function blocked(reason, extra = {}) {
  return { env: {}, blocked: { reason, ...extra } };
}

/**
 * ctx: { aiRoot, secrets (vault: get/has/set), component? (the resolved entry),
 * fs?, randomBytes? }. -> { env: { PLATFORM_MCP_API_KEY }, imported, generated, scrubbed }
 * or { env: {}, blocked: { reason } }. Values are never in the result except the key in env.
 */
async function prepare(ctx = {}) {
  const fsImpl = ctx.fs || nodeFs;
  const randomBytes = ctx.randomBytes || crypto.randomBytes;
  const vault = ctx.secrets;
  if (!vault || typeof vault.get !== "function" || typeof vault.set !== "function") return blocked("secret-store-unavailable");
  const serverEnv = runtimeFile(ctx.aiRoot, SERVER_ENV_NAME);
  let imported = false;
  let generated = false;
  let scrubbed = false;
  try {
    let key = String(vault.get(SECRET_NAMESPACE, SECRET_NAME) || "");
    const legacy = readLegacyServerEnv(serverEnv, fsImpl);
    if (!key && legacy?.key) {
      if (legacy.key.length < MIN_KEY_LENGTH) return blocked("mcp-key-invalid");
      await vault.set(SECRET_NAMESPACE, SECRET_NAME, legacy.key);
      if (String(vault.get(SECRET_NAMESPACE, SECRET_NAME) || "") !== legacy.key) return blocked("secret-store-unavailable");
      key = legacy.key;
      imported = true;
    }
    if (!key) {
      const fresh = newApiKey(randomBytes);
      await vault.set(SECRET_NAMESPACE, SECRET_NAME, fresh);
      if (String(vault.get(SECRET_NAMESPACE, SECRET_NAME) || "") !== fresh) return blocked("secret-store-unavailable");
      key = fresh;
      generated = true;
    }
    if (key.length < MIN_KEY_LENGTH) return blocked("mcp-key-invalid");
    // Only after the read-back above: the plaintext line goes away.
    if (legacy?.hadSecretLines) {
      writeScrubbed(serverEnv, legacy.keptLines, fsImpl);
      scrubbed = true;
    }
    const searchKey = String(ctx.component?.env?.[SEARCH_KEY_ENV] || "");
    if (searchKey && searchKey.length < MIN_SEARCH_KEY_LENGTH) return blocked("mcp-search-key-invalid");
    return { env: { [KEY_ENV]: key }, imported, generated, scrubbed };
  } catch (error) {
    return blocked("secret-store-unavailable", { code: String(error?.code || "error") });
  }
}

function listenerAddresses(listeners, port, pid) {
  return (Array.isArray(listeners) ? listeners : []).filter((entry) => Number(entry?.port) === Number(port) && (pid === undefined || Number(entry?.pid) === Number(pid)));
}

/**
 * ctx: { aiRoot, pid, port, listeners | listListeners(), killTree?, fs? }.
 * -> { ok: true } or { ok: false, error: { code: "mcp_not_loopback", reason }, kill: true }
 * (the supervisor kills and marks the component failed; killTree is called
 * here too when the caller passes one).
 */
async function afterReady(ctx = {}) {
  const fsImpl = ctx.fs || nodeFs;
  const pidFile = runtimeFile(ctx.aiRoot, SERVER_PID_NAME);
  if (Number.isInteger(ctx.pid)) {
    fsImpl.mkdirSync(path.dirname(pidFile), { recursive: true });
    fsImpl.writeFileSync(pidFile, `${ctx.pid}`, { encoding: "ascii" });
  }
  const listeners = typeof ctx.listListeners === "function" ? await ctx.listListeners() : ctx.listeners;
  const own = listenerAddresses(listeners, ctx.port, ctx.pid);
  if (own.length && own.every((entry) => LOOPBACK_ADDRESSES.has(String(entry.address || entry.localAddress || "")))) return { ok: true };
  if (typeof ctx.killTree === "function") await ctx.killTree(ctx.pid);
  try {
    fsImpl.rmSync(pidFile, { force: true });
  } catch {
    // The pid file is a courtesy to the legacy scripts.
  }
  return { ok: false, kill: true, error: { code: "mcp_not_loopback", reason: "failed.mcp-not-loopback" } };
}

module.exports = { SECRET_NAMESPACE, SECRET_NAME, prepare, afterReady };
