// Browser checks for the P0 UI fixes (docs/overhaul/08-p0-fixes.md, UI batch).
// Pages are served by the worktree's own servers (the frontend-smoke harness)
// or from disk, and every API answer that matters is stubbed at the browser
// boundary. Nothing here reaches a live manager or changes runtime state.
const { test, expect } = require("@playwright/test");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BILLING_HTML = path.join(ROOT, "service-entry", "billing.html");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForHttp(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(2_000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(poll, 300);
    };
    poll();
  });
}

function killProcessTree(child) {
  if (!child || child.killed) return Promise.resolve();
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => resolve());
  });
}

// Same harness as tests/frontend-smoke.spec.cjs: the worktree server on a free port.
async function startManager({ cwd, env, port }) {
  const logs = [];
  const pidFile = env.LLAMA_MANAGER_PID_FILE || env.VLLM_MANAGER_PID_FILE || "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd,
    env: {
      ...process.env,
      ...env,
      AI_FRONTEND_SMOKE: "1",
      NO_COLOR: "1",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  child.once("exit", (code) => {
    if (code !== null && code !== 0) logs.push(`process exited with code ${code}`);
  });
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, 25_000);
  } catch (error) {
    await killProcessTree(child);
    throw new Error(`${error.message}\n${logs.join("").slice(-4000)}`);
  }
  return {
    url: `http://127.0.0.1:${port}/`,
    logs,
    stop: async () => {
      await killProcessTree(child);
      if (pidFile) await fs.rm(pidFile, { force: true }).catch(() => {});
    },
  };
}

function trackPageErrors(page) {
  const failures = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  return failures;
}

// WCAG relative-luminance contrast of an element's text against its background.
async function textContrast(locator) {
  return locator.evaluate((node) => {
    const style = getComputedStyle(node);
    const luminance = (rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map(Number)
      .map((value) => value / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
    return { ratio: (values[1] + 0.05) / (values[0] + 0.05), color: style.color, background: style.backgroundColor };
  });
}

function entryStatusPayload(baseUrl) {
  return {
    ok: true,
    entry: {
      host: "127.0.0.1",
      port: Number(new URL(baseUrl).port),
      gateway: { autoOpenAi: `${baseUrl}gateway/auto/openai` },
      gatewayAccess: { totals: { requests: {} }, recent: [], paths: [], timeline: [] },
    },
    managers: [],
    tts: { name: "TTS", port: 7000, listening: false, healthy: false, availableCount: 0, totalCount: 0, engines: [] },
  };
}

async function stubEntryApis(page, baseUrl) {
  // The console must never reach the live managers from a test, so every
  // entry API answers from here.
  await page.route("**/api/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/status", (route) => route.fulfill({ json: entryStatusPayload(baseUrl) }));
  await page.route("**/api/fleet", (route) => route.fulfill({
    json: { ok: true, settings: { mode: "balanced", reserveMb: 8192, maxUtilizationPct: 85 }, instances: [], slots: [], routing: { mode: "balanced", capabilityCounts: {} } },
  }));
}

test.describe.configure({ mode: "serial" });

test.describe("P0-22 console theme", () => {
  let entry;

  test.beforeAll(async () => {
    const port = await getFreePort();
    entry = await startManager({
      cwd: path.join(ROOT, "service-entry"),
      port,
      env: { SERVICE_ENTRY_HOST: "127.0.0.1", SERVICE_ENTRY_PORT: String(port) },
    });
  });

  test.afterAll(async () => {
    if (entry) await entry.stop();
  });

  for (const colorScheme of ["light", "dark"]) {
    test(`header buttons keep readable hover contrast in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await stubEntryApis(page, entry.url);
      await page.goto(entry.url, { waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "auto");
      const button = page.locator("#refreshBtn");
      await expect(button).toBeVisible();
      const idle = await textContrast(button);
      expect(idle.ratio, `${colorScheme} idle ${idle.color} on ${idle.background}`).toBeGreaterThanOrEqual(4.5);
      await button.hover();
      await expect.poll(async () => (await textContrast(button)).ratio, {
        message: `${colorScheme} hover contrast of #refreshBtn`,
      }).toBeGreaterThanOrEqual(4.5);
      const hovered = await textContrast(button);
      // The hover surface follows the theme: dark mode must not hover to a light surface.
      const backgroundIsDark = await button.evaluate((node) => {
        const [r, g, b] = getComputedStyle(node).backgroundColor.match(/[\d.]+/g).map(Number);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
      });
      expect(backgroundIsDark, `${colorScheme} hover background ${hovered.background}`).toBe(colorScheme === "dark");
    });
  }
});

test.describe("P0-17 billing labels", () => {
  test("overview lists raw recent requests instead of a monthly aggregate", async ({ page }) => {
    const failures = trackPageErrors(page);
    const html = await fs.readFile(BILLING_HTML, "utf8");
    await page.route("http://billing.p0-ui.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/billing" || url.pathname === "/billing/") {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
        return;
      }
      if (url.pathname === "/api/billing/usage") {
        await route.fulfill({
          json: {
            ok: true,
            items: [
              { usageId: "u-1", at: "2026-10-14T02:00:00.000Z", customerId: null, managerId: "vllm", model: "local/base-7b", status: 200, ok: true, terminalState: "completed", inputTokens: "1200", outputTokens: "300", totalTokens: "1500" },
              { usageId: "u-2", at: "2026-10-14T01:00:00.000Z", customerId: null, managerId: "llama", model: "local/tiny-1b", status: 499, ok: false, terminalState: "disconnected", inputTokens: "10", outputTokens: "0", totalTokens: "10" },
            ],
          },
        });
        return;
      }
      if (url.pathname === "/api/status") {
        await route.fulfill({ json: { managers: [] } });
        return;
      }
      await route.fulfill({ json: { ok: true, items: [] } });
    });
    await page.goto("http://billing.p0-ui.test/billing", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#overviewUsageHeading")).toHaveText("最近请求（原始记录，最多 100 条）");
    const headers = page.locator("table:has(#overviewUsageRows) thead th");
    await expect(headers).toHaveText(["时间", "客户", "管理器", "模型", "Tokens", "状态"]);
    const rows = page.locator("#overviewUsageRows tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("local/base-7b");
    await expect(rows.nth(0)).toContainText("完成 · 200");
    await expect(rows.nth(1)).toContainText("连接中断 · 499");
    await expect(page.locator("body")).not.toContainText("按「客户 × 管理器/模型 × 月」聚合");
    await expect(page.locator("body")).not.toContainText("本期用量");
    await expect(page.locator("#billingUsageHeading")).toHaveText("最近请求（原始记录，最多 100 条）");
    expect(failures, "billing frontend errors").toEqual([]);
  });
});
