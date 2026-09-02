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

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
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
