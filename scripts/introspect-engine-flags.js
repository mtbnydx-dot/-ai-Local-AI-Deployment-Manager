#!/usr/bin/env node
"use strict";

// An explicit operator action; help and importing this module never run Docker.
const { createEngineRegistry } = require("../manager-core/engines/registry");
const { createRuntimeFacts } = require("../manager-core/engines/runtime-facts");
const { introspectRuntime } = require("../manager-core/engines/introspect");

async function main(args = process.argv.slice(2), options = {}) {
  const output = options.output || ((text) => process.stdout.write(`${text}\n`));
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    output("Usage: node scripts/introspect-engine-flags.js <engineId> <runtimeId>");
    return 0;
  }
  if (args.length !== 2 || args.some((arg) => arg.startsWith("-"))) {
    output("Usage: node scripts/introspect-engine-flags.js <engineId> <runtimeId>");
    return 2;
  }
  const registry = options.registry || createEngineRegistry();
  const runtimeFacts = options.runtimeFacts || createRuntimeFacts({ ...options, registry });
  const run = options.introspectRuntime || introspectRuntime;
  try {
    const result = await run(args[0], args[1], { ...options, registry, runtimeFacts });
    output(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    output(JSON.stringify({ ok: false, error: { code: error.code || "introspection_failed", message: error.message } }));
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
module.exports = { main };
