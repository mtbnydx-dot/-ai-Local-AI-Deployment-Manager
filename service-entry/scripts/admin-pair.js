#!/usr/bin/env node
"use strict";

// Pairs a browser with the local console (05 §5.2, launcher and CLI pairing).
//
//   node service-entry\scripts\admin-pair.js [--open] [--lan] [--ttl <seconds>]
//        [--port <n>] [--ai-root <dir>]
//
// It asks the entry for a single-use pair code, signed as the machine
// principal system:cli with the entry trust token (<AI_ROOT>/.gateway-trust.json),
// and prints only the URL http://127.0.0.1:5176/#pair=<code> on stdout. The
// code travels in the fragment, so it never reaches a request line, a log or
// a Referer; the console reads it, pairs and strips it. --open opens the URL
// in the default browser instead of waiting for a copy and paste. 06's
// `platform admin pair [--open]` wraps this script.
//
// Exit codes: 0 printed (and opened), 1 the entry refused, 2 no call could be
// made (bad arguments, no trust token, the entry not answering).

const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInternalClient } = require("../../manager-core/internal-auth");

const PRINCIPAL = "system:cli";
const PAIR_CODES_PATH = "/api/session/pair-codes";
const DEFAULT_PORT = 5176;
const DEFAULT_TIMEOUT_MS = 10000;
const PLATFORM_ROOT = path.resolve(__dirname, "..", "..");
const PAIR_URL_RE = /^http:\/\/[^/\s]+\/#pair=[A-Z2-7]{10}$/;
const USAGE = "Usage: node service-entry\\scripts\\admin-pair.js [--open] [--lan] [--ttl <seconds>] [--port <n>] [--ai-root <dir>]";

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
  const options = { open: false, lan: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === "--open") {
      options.open = true;
    } else if (arg === "--lan") {
      options.lan = true;
    } else if (["--ttl", "--port", "--ai-root"].includes(arg)) {
      if (index + 1 >= argv.length) throw usageError(`${arg} needs a value.`);
      options[arg.slice(2)] = String(argv[index + 1]);
      index += 1;
    } else {
      throw usageError(arg.startsWith("--") ? `Unknown option ${arg}.` : USAGE);
    }
  }
  let ttlSeconds;
  if (options.ttl !== undefined) {
    ttlSeconds = Number(options.ttl);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 600) throw usageError("--ttl must be a whole number of seconds from 1 to 600.");
  }
  return {
    open: options.open,
    lan: options.lan,
    ttlSeconds,
    port: options.port !== undefined
      ? parsePort(options.port, "--port")
      : env.SERVICE_ENTRY_PORT ? parsePort(env.SERVICE_ENTRY_PORT, "SERVICE_ENTRY_PORT") : DEFAULT_PORT,
    aiRoot: path.resolve(options["ai-root"] || env.AI_ROOT || PLATFORM_ROOT),
  };
}

// One signed POST /api/session/pair-codes. Resolves to { code, url,
// expiresAt }; an entry refusal rejects with its error code.
async function requestPairCode({ aiRoot = PLATFORM_ROOT, port = DEFAULT_PORT, ttlSeconds, lan = false, fetchFn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const client = createInternalClient({
    principal: PRINCIPAL,
    aiRoot,
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs,
    ...(fetchFn ? { fetchFn } : {}),
  });
  const body = { ...(ttlSeconds !== undefined ? { ttlSeconds } : {}), ...(lan ? { lan: true } : {}) };
  const result = await client.request("POST", PAIR_CODES_PATH, body);
  const json = result.json || {};
  if (result.status !== 200 || json.ok !== true || !PAIR_URL_RE.test(String(json.url || ""))) {
    const error = new Error(`the entry answered HTTP ${result.status}`);
    error.code = String(json.error?.code || json.code || "pair_code_refused");
    error.status = result.status;
    throw error;
  }
  return { code: json.code, url: json.url, expiresAt: json.expiresAt };
}

// The default browser, detached. The URL is an argument, never a shell
// string, so the fragment arrives intact.
function openUrl(url, { spawnFn = spawn, platform = process.platform } = {}) {
  const [command, args] = platform === "win32"
    ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawnFn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on?.("error", () => {});
  child.unref?.();
}

async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let args;
  try {
    args = parseArgs(argv, io.env || process.env);
  } catch (error) {
    stderr.write(`admin-pair: ${error.message}\n`);
    return 2;
  }
  let pair;
  try {
    pair = await requestPairCode({ ...args, fetchFn: io.fetchFn });
  } catch (error) {
    // Neither internal-auth's messages nor the entry's error codes carry
    // the token or a code.
    stderr.write(`admin-pair: ${error.code || "internal_unavailable"}: ${error.message}\n`);
    return error.status ? 1 : 2;
  }
  stdout.write(`${pair.url}\n`);
  if (args.open) {
    try {
      (io.openUrl || openUrl)(pair.url);
    } catch (error) {
      stderr.write(`admin-pair: the browser could not be opened (${error.code || "open_failed"}); open the URL above.\n`);
    }
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  PRINCIPAL,
  main,
  openUrl,
  parseArgs,
  requestPairCode,
};
