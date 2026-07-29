#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  inspectCliProxyConfig,
  updateCliProxyHost,
} = require("./subscription-setup");

async function writeAtomically(filePath, content) {
  const stat = await fs.stat(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf8", mode: stat.mode });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const [command, configuredPath] = process.argv.slice(2);
  if (command !== "ensure-loopback" || !configuredPath) {
    throw new Error("Usage: node subscription-config-tool.js ensure-loopback <config-path>");
  }
  const configPath = path.resolve(configuredPath);
  const original = await fs.readFile(configPath, "utf8");
  const before = inspectCliProxyConfig(original);
  const updated = updateCliProxyHost(original, "127.0.0.1");
  const changed = updated !== original;
  if (changed) await writeAtomically(configPath, updated);
  const after = inspectCliProxyConfig(updated);
  if (!after.loopbackOnly) {
    throw new Error(`CLIProxyAPI config is not loopback-only after update: ${configPath}`);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    changed,
    configPath,
    beforeHost: before.host,
    host: after.host,
    port: after.port,
  }));
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
