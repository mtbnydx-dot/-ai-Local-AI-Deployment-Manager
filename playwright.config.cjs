const { defineConfig } = require("@playwright/test");

const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL || "";

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
