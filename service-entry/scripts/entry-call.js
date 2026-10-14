#!/usr/bin/env node
"use strict";

// A signed call into the local service entry as the machine principal
// system:cli (05 §5.7).
//
//   node service-entry\scripts\entry-call.js <METHOD> <path> [--body <json>]
//        [--port <n>] [--ai-root <dir>] [--timeout-ms <n>] [--quiet]
//
// The request is signed with the entry trust token
// (<AI_ROOT>/.gateway-trust.json; AI_ROOT defaults to the platform root this
// script lives in), so it keeps working once loopback callers without
// credentials are viewers (PUB-5). stop-service-entry.cmd signs the entry
// shutdown with it until OPS-8 replaces that script with `platform stop`.
//
// It prints the JSON answer (never the token) unless --quiet, and exits 0 for
// a 2xx answer, 1 for any other answer and 2 when no call could be made (bad
// arguments, no trust token, the entry not answering).

const path = require("node:path");
const { createInternalClient } = require("../../manager-core/internal-auth");

const PRINCIPAL = "system:cli";
const DEFAULT_PORT = 5176;
const DEFAULT_TIMEOUT_MS = 10000;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const PLATFORM_ROOT = path.resolve(__dirname, "..", "..");
const USAGE = "Usage: node service-entry\\scripts\\entry-call.js <METHOD> <path> [--body <json>] [--port <n>] [--ai-root <dir>] [--timeout-ms <n>] [--quiet]";

function usageError(message) {
  const error = new Error(message);
  error.code = "usage";
  return error;
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usageError(`${label} must be a port number between 1 and 65535.`);
  return port;
}

function parseArgs(argv, env = process.env) {
  const positional = [];
  const options = { quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === "--quiet") {
      options.quiet = true;
    } else if (["--body", "--port", "--ai-root", "--timeout-ms"].includes(arg)) {
      if (index + 1 >= argv.length) throw usageError(`${arg} needs a value.`);
      options[arg.slice(2)] = String(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--")) {
      throw usageError(`Unknown option ${arg}.`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) throw usageError(USAGE);
  const method = positional[0].toUpperCase();
  if (!METHODS.has(method)) throw usageError(`Unknown method ${positional[0]}.`);
  const target = positional[1];
  if (!target.startsWith("/api/")) throw usageError("The path must start with /api/.");
  let body;
  if (options.body !== undefined) {
    try {
      body = JSON.parse(options.body);
    } catch {
      throw usageError("--body must be JSON.");
    }
  }
  const timeoutMs = options["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : Number(options["timeout-ms"]);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw usageError("--timeout-ms must be a positive number.");
  return {
    method,
    target,
    body,
    port: options.port !== undefined
      ? parsePort(options.port, "--port")
      : env.SERVICE_ENTRY_PORT ? parsePort(env.SERVICE_ENTRY_PORT, "SERVICE_ENTRY_PORT") : DEFAULT_PORT,
    aiRoot: path.resolve(options["ai-root"] || env.AI_ROOT || PLATFORM_ROOT),
    timeoutMs,
    quiet: options.quiet,
  };
}

// One signed request; resolves to { status, json }. createInternalClient
// re-reads the trust token and retries once on a 401 (the entry restarted).
async function callEntry({ method, target, body, port = DEFAULT_PORT, aiRoot = PLATFORM_ROOT, timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn }) {
  const client = createInternalClient({
    principal: PRINCIPAL,
    aiRoot,
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs,
    ...(fetchFn ? { fetchFn } : {}),
  });
  return client.request(method, target, body);
}

async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let args;
  try {
    args = parseArgs(argv, io.env || process.env);
  } catch (error) {
    stderr.write(`entry-call: ${error.message}\n`);
    return 2;
  }
  let result;
  try {
    result = await callEntry({ ...args, fetchFn: io.fetchFn });
  } catch (error) {
    // internal-auth's messages never carry the token.
    stderr.write(`entry-call: ${error.code || "internal_unavailable"}: ${error.message}\n`);
    return 2;
  }
  const ok = result.status >= 200 && result.status < 300;
  if (!args.quiet) stdout.write(`${JSON.stringify(result.json)}\n`);
  if (!ok) {
    const code = result.json?.error?.code || result.json?.code || "";
    stderr.write(`entry-call: ${args.method} ${args.target} answered HTTP ${result.status}${code ? ` ${code}` : ""}\n`);
  }
  return ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  PRINCIPAL,
  callEntry,
  main,
  parseArgs,
};
