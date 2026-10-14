"use strict";

// A stand-in for the PowerShell DPAPI helper of manager-core/secret-store.js.
// It speaks the same stdin/stdout protocol ({op, entropy, items:[base64]}), so
// createDpapi's real request and response code runs, and records every call
// for spies. A blob is "FAKEDPAPI" + a 4-byte entropy tag + the value XORed with
// sha256(entropy): it never contains the value, and like DPAPI it refuses to
// unwrap under another entropy.

const crypto = require("node:crypto");

const MARKER = Buffer.from("FAKEDPAPI");

function entropyKey(entropy) {
  return crypto.createHash("sha256").update(String(entropy)).digest();
}

function xor(bytes, key) {
  const out = Buffer.alloc(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) out[index] = bytes[index] ^ key[index % key.length];
  return out;
}

function failure(type) {
  const error = new Error(`Command failed: fake DPAPI (${type})`);
  error.status = 1;
  error.stdout = JSON.stringify({ ok: false, error: type });
  return error;
}

/**
 * Options: calls (array the spy appends {command, args, input, sync, request}
 * to), failProbe, fail(request) → truthy to fail that call, and
 * transform(request, response) to tamper with a successful answer.
 */
function createFakeDpapiExec(options = {}) {
  const calls = options.calls || [];
  function answer(request) {
    if (request.op === "probe") {
      if (options.failProbe) throw failure("PlatformNotSupportedException");
      return { ok: true, items: [] };
    }
    if (options.fail && options.fail(request)) throw failure("CryptographicException");
    const key = entropyKey(request.entropy);
    const tag = key.subarray(0, 4);
    if (request.op === "protect") {
      return {
        ok: true,
        items: request.items.map((item) => Buffer.concat([MARKER, tag, xor(Buffer.from(item, "base64"), key)]).toString("base64")),
      };
    }
    if (request.op === "unprotect") {
      return {
        ok: true,
        items: request.items.map((item) => {
          const bytes = Buffer.from(item, "base64");
          if (!bytes.subarray(0, MARKER.length).equals(MARKER) || !bytes.subarray(MARKER.length, MARKER.length + 4).equals(tag)) {
            throw failure("CryptographicException");
          }
          return xor(bytes.subarray(MARKER.length + 4), key).toString("base64");
        }),
      };
    }
    throw failure("NotSupportedException");
  }
  function respond(request) {
    const response = answer(request);
    return JSON.stringify(options.transform ? options.transform(request, response) || response : response);
  }
  return function exec(command, args, execOptions = {}) {
    const request = JSON.parse(String(execOptions.input || "{}"));
    calls.push({ command, args: Array.from(args), input: String(execOptions.input || ""), sync: Boolean(execOptions.sync), request });
    if (execOptions.sync) return respond(request);
    return new Promise((resolve, reject) => {
      try {
        resolve(respond(request));
      } catch (error) {
        reject(error);
      }
    });
  };
}

function createFakeDpapi(options = {}) {
  const { createDpapi } = require("../../../secret-store");
  return createDpapi({ exec: createFakeDpapiExec(options), platform: options.platform || "win32" });
}

module.exports = { createFakeDpapiExec, createFakeDpapi };
