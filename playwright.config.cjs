const fs = require("node:fs");
const path = require("node:path");
const { defineConfig } = require("@playwright/test");

function existingPath(...parts) {
  const value = path.join(...parts.filter(Boolean));
  return value && fs.existsSync(value);
}

function resolveBrowserChannel() {
  if (process.env.PLAYWRIGHT_BROWSER_CHANNEL) {
    return process.env.PLAYWRIGHT_BROWSER_CHANNEL;
  }
  if (process.platform !== "win32") {
    return "";
  }

  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const localAppData = process.env.LOCALAPPDATA;
  if (
    existingPath(programFiles, "Google", "Chrome", "Application", "chrome.exe") ||
    existingPath(programFilesX86, "Google", "Chrome", "Application", "chrome.exe") ||
    existingPath(localAppData, "Google", "Chrome", "Application", "chrome.exe")
  ) {
    return "chrome";
  }
  if (
    existingPath(programFiles, "Microsoft", "Edge", "Application", "msedge.exe") ||
    existingPath(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe") ||
    existingPath(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")
  ) {
    return "msedge";
  }
  return "";
}

const browserChannel = resolveBrowserChannel();
// Let release checks bound concurrency on a host that is running other work.
const workerText = String(process.env.PLAYWRIGHT_WORKERS || "").trim();
const releaseWorkers = workerText ? Number(workerText) : undefined;
if (workerText && (!Number.isInteger(releaseWorkers) || releaseWorkers < 1)) {
  throw new Error("PLAYWRIGHT_WORKERS must be a positive integer");
}

module.exports = defineConfig({
  // Specs are discovered: any *.spec.{cjs,js,mjs} under tests/ runs without a
  // config or package.json edit. tests/helpers and tests/fixtures hold no specs.
  testDir: "./tests",
  testMatch: ["**/*.spec.cjs", "**/*.spec.js", "**/*.spec.mjs"],
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  ...(releaseWorkers === undefined ? {} : { workers: releaseWorkers }),
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    ...(browserChannel ? { channel: browserChannel } : {}),
    headless: true,
    viewport: { width: 1440, height: 960 },
    ignoreHTTPSErrors: true,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
});
