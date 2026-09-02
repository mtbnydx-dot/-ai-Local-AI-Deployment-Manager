#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const platformRoot = path.resolve(scriptDirectory, "..");
const aiRoot = path.resolve(process.env.AI_ROOT || path.join(platformRoot, ".."));
const entryPoint = path.join(platformRoot, "dist", "src", "index.js");
const searchCredentialPath = path.join(
  aiRoot,
  "vllm-manager",
  "logs",
  ".last-public-service-key.txt",
);

try {
  await access(entryPoint);
} catch {
  console.error("Platform MCP build is unavailable. Run npm run build before starting stdio mode.");
  process.exit(1);
}

let searchGatewayApiKey = String(process.env.PLATFORM_MCP_SEARCH_GATEWAY_API_KEY || "").trim();
if (!searchGatewayApiKey) {
  try {
    searchGatewayApiKey = (await readFile(searchCredentialPath, "utf8")).trim();
  } catch {
    console.error("Platform MCP could not read the protected local search credential.");
    process.exit(1);
  }
}

if (searchGatewayApiKey.length < 16) {
  console.error("Platform MCP local search credential is invalid.");
  process.exit(1);
}

process.env.AI_ROOT = aiRoot;
process.env.PLATFORM_MCP_SEARCH_GATEWAY_API_KEY = searchGatewayApiKey;
if (!process.argv.includes("--stdio")) process.argv.push("--stdio");

await import(pathToFileURL(entryPoint).href);
