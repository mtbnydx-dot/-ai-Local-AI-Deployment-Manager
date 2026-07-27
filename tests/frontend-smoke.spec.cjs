const { test, expect } = require("@playwright/test");
const { spawn, execFile } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

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

async function startManager({ cwd, env, port }) {
  const logs = [];
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
    stop: () => killProcessTree(child),
  };
}

async function smokePage(page, baseUrl, label) {
  const failures = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (["document", "script", "stylesheet"].includes(type) && response.status() >= 400) {
      failures.push(`${type} ${response.status()}: ${response.url()}`);
    }
  });
  await page.route("https://unpkg.com/**/lucide*.js", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: "window.lucide={createIcons(){}};",
    });
  });
  await page.route("**/api/models", async (route) => {
    const local = Array.from({ length: 12 }, (_, index) => ({
      id: `${label.toLowerCase()}-smoke-model-${index + 1}`,
      label: `${label} Smoke Model ${index + 1}`,
      launchModel: `D:/AI/models/${label.toLowerCase()}-smoke-model-${index + 1}`,
      path: `D:/AI/models/${label.toLowerCase()}-smoke-model-${index + 1}`,
      size: 4_000_000_000 + index,
      hasConfig: label === "vLLM",
      hasGguf: label !== "vLLM",
      ggufFiles: label !== "vLLM" ? [{ name: `smoke-${index + 1}.Q4_K_M.gguf` }] : [],
    }));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ local, cached: [] }),
    });
  });
  await page.route("**/api/service-exposure", async (route) => {
    const port = new URL(baseUrl).port || "5177";
    const modelId = `${label.toLowerCase()}-smoke-model-1`;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        settings: {
          enabled: true,
          exposureMode: "lan",
          requireApiKey: true,
          hasApiKey: true,
          apiKeyPreview: "sk-...123456",
          exposeOpenAI: true,
          exposeClaude: true,
          exposeOpenCode: true,
          exposeMetrics: false,
          allowManagerRemote: false,
          rateLimitRpm: 120,
          maxConcurrentRequests: 4,
          requestTimeoutSeconds: 600,
          allowedOrigins: [],
          publicBaseUrl: "",
          notes: "",
        },
        actual: {
          manager: {
            localBaseUrl: `http://127.0.0.1:${port}`,
            lanBaseUrl: `http://192.168.1.27:${port}`,
            host: "127.0.0.1",
            port: Number(port),
            remoteManagementAllowed: false,
          },
          service: {
            running: true,
            containerStatus: "running",
            boundHost: "127.0.0.1",
            localHost: "127.0.0.1",
            lanHost: "192.168.1.27",
            dockerPublishedHosts: ["127.0.0.1"],
            port: label === "vLLM" ? 8000 : 8080,
            openAiGatewayLocalBaseUrl: `http://127.0.0.1:${port}/serve/v1`,
            openAiGatewayLanBaseUrl: `http://192.168.1.27:${port}/serve/v1`,
            openAiLocalBaseUrl: `http://127.0.0.1:${label === "vLLM" ? 8000 : 8080}/v1`,
            openAiLanBaseUrl: null,
            claudeLocalBaseUrl: `http://127.0.0.1:${port}/claude`,
            claudeLanBaseUrl: `http://192.168.1.27:${port}/claude`,
            claudeLocalMessagesUrl: `http://127.0.0.1:${port}/claude/v1/messages`,
            claudeLanMessagesUrl: `http://192.168.1.27:${port}/claude/v1/messages`,
            claudePublicBaseUrl: null,
            openCodeBaseUrl: `http://127.0.0.1:${port}/opencode/v1`,
            modelIds: [modelId],
            maxModelLen: 262144,
            apiKeyRequired: false,
            runtimeApiKeyRequired: false,
            gatewayApiKeyRequired: true,
            gatewayApiKeyEnforced: true,
            gatewayHasGlobalApiKey: true,
            gatewayHasActiveClients: false,
            clients: { total: 0, active: 0 },
          },
          docker: { ok: false, text: "", error: "smoke mock" },
        },
        checks: [
          { status: "ok", title: "模型服务", detail: "smoke mock running" },
          { status: "ok", title: "管理器网关", detail: "smoke mock enabled" },
        ],
      }),
    });
  });
  const modelsLoaded = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/models" && response.request().method() === "GET" && response.ok();
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await modelsLoaded;
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator("[data-view-panel='service']").first()).toBeVisible();
  await expect(page.locator(".launch-flow-tab")).toHaveCount(4);
  await expect(page.locator("[data-launch-stage='model']")).toBeVisible();
  await expect(page.locator(".app-signature")).toContainText("© 2026 mtbnydx-dot");
  await page.locator("#modelPickerToggle").click();
  await expect(page.locator(".model-picker-backdrop")).toBeVisible();
  await expect(page.locator("#modelPickerPopover")).toHaveAttribute("role", "dialog");
  await expect(page.locator(".model-picker-item")).toHaveCount(12);
  const pickerScroll = await page.locator("#modelPickerList").evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    overflowY: getComputedStyle(node).overflowY,
  }));
  expect(pickerScroll.scrollHeight, `${label} picker should expose more than four models`).toBeGreaterThan(pickerScroll.clientHeight);
  expect(pickerScroll.overflowY).toMatch(/auto|scroll/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".model-picker-backdrop")).toBeHidden();
  await page.locator("[data-launch-stage='model'] [data-launch-stage-next]").click();
  await expect(page.locator("[data-launch-stage='resources']")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  for (const view of ["download", "exposure", "external-access", "stats"]) {
    await page.locator(`[data-view='${view}']`).click();
    await expect(page.locator(`[data-view-panel='${view}']`).first()).toBeVisible();
    expect(await page.evaluate(() => window.scrollY), `${label} ${view} view should open at its saved top position`).toBeLessThan(100);
    if (view === "exposure") {
      await expect(page.locator("#serviceExposureEndpoints")).toContainText("网关即时开关");
      await expect(page.locator("#serviceExposureEndpoints [data-exposure-field='enabled']").first()).toBeVisible();
      await page.locator("#exposureMode").selectOption("reverse-proxy");
      await expect(page.locator("#exposurePublicBaseUrl")).toHaveAttribute("required", "");
      await expect(page.locator(".exposure-mode-guidance")).toContainText("HTTPS");
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-view='service']").click();
  await page.evaluate(() => window.scrollTo(0, 0));
  const mobileShell = await page.evaluate(() => ({
    sidebarHeight: document.querySelector(".sidebar")?.getBoundingClientRect().height || 0,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(mobileShell.sidebarHeight, `${label} mobile navigation should stay compact`).toBeLessThan(120);
  expect(mobileShell.scrollWidth, `${label} mobile page should not overflow horizontally`).toBeLessThanOrEqual(mobileShell.clientWidth + 1);
  await page.waitForTimeout(500);
  expect(failures, `${label} frontend errors`).toEqual([]);
}

async function smokeEntryPage(page, baseUrl, mode = "full") {
  const failures = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (["document", "script", "stylesheet"].includes(type) && response.status() >= 400) {
      failures.push(`${type} ${response.status()}: ${response.url()}`);
    }
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#lastUpdatedBadge")).toContainText("已刷新", { timeout: 15_000 });
  await expect(page.locator("h1")).toContainText(mode === "subscription" ? "订阅反代独立入口" : "AI 服务统一入口");
  await expect(page.locator("#entrySummary")).toBeVisible();
  if (mode === "subscription") {
    await expect(page.locator("#managerGrid")).toBeHidden();
    await expect(page.locator("#entryModeBadge")).toContainText("反代独立模式");
    await expect(page.locator("#entrySummary")).toContainText("反代 / 前端 / 网关");
  } else {
    await expect(page.locator("#managerGrid")).toBeVisible();
  }
  await expect(page.locator("#subscription-proxy")).toBeVisible();
  await expect(page.locator("#subscription-proxy")).toContainText("本机、局域网");
  await expect(page.locator("#subscriptionProxyPanel")).toContainText("CLIProxyAPI", { timeout: 15_000 });
  await expect(page.locator("a[href='/subscription-login.html']")).toContainText("反代账号配置");
  await expect(page.locator("a[href='/subscription-service.html']")).toContainText("服务发布配置");
  await expect(page.locator("#entryAccessPanel")).toBeVisible();
  await expect(page.locator(".app-signature")).toContainText("© 2026 mtbnydx-dot");
  await page.goto(new URL("/subscription-login.html", baseUrl).href, { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1")).toContainText("反代账号配置");
  await expect(page.locator("[data-provider]")).toHaveCount(5);
  await page.goto(new URL("/subscription-service.html", baseUrl).href, { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1")).toContainText("服务发布配置");
  await expect(page.locator("#panel")).toContainText("/gateway/subscription/openai/v1", { timeout: 15_000 });
  await expect(page.locator("#publicBaseUrl")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scopeColumns: getComputedStyle(document.querySelector(".scope-grid")).gridTemplateColumns,
  }));
  expect(mobileLayout.scrollWidth, "service-entry mobile page should not overflow horizontally")
    .toBeLessThanOrEqual(mobileLayout.clientWidth + 1);
  expect(mobileLayout.scopeColumns.split(" ")).toHaveLength(1);
  expect(failures, "service-entry frontend errors").toEqual([]);
}

test.describe("manager frontends", () => {
  let managers = [];

  test.afterEach(async () => {
    await Promise.all(managers.map((manager) => manager.stop()));
    managers = [];
  });

  test("vLLM and llama pages load after modular split", async ({ browser }) => {
    const vllmPort = await getFreePort();
    const llamaPort = await getFreePort();
    managers = [
      await startManager({
        cwd: path.join(ROOT, "vllm-manager"),
        port: vllmPort,
        env: {
          VLLM_MANAGER_HOST: "127.0.0.1",
          VLLM_MANAGER_PORT: String(vllmPort),
        },
      }),
      await startManager({
        cwd: path.join(ROOT, "llama-manager"),
        port: llamaPort,
        env: {
          LLAMA_MANAGER_HOST: "127.0.0.1",
          LLAMA_MANAGER_PORT: String(llamaPort),
        },
      }),
    ];

    const context = await browser.newContext();
    try {
      await smokePage(await context.newPage(), managers[0].url, "vLLM");
      await smokePage(await context.newPage(), managers[1].url, "llama");
    } finally {
      await context.close();
    }
  });

  test("service-entry dashboard loads", async ({ browser }) => {
    const entryPort = await getFreePort();
    managers = [
      await startManager({
        cwd: path.join(ROOT, "service-entry"),
        port: entryPort,
        env: {
          SERVICE_ENTRY_HOST: "127.0.0.1",
          SERVICE_ENTRY_PORT: String(entryPort),
        },
      }),
    ];

    const context = await browser.newContext();
    try {
      await smokeEntryPage(await context.newPage(), managers[0].url);
    } finally {
      await context.close();
    }
  });

  test("subscription-only dashboard hides local model managers", async ({ browser }) => {
    const entryPort = await getFreePort();
    managers = [
      await startManager({
        cwd: path.join(ROOT, "service-entry"),
        port: entryPort,
        env: {
          SERVICE_ENTRY_HOST: "127.0.0.1",
          SERVICE_ENTRY_PORT: String(entryPort),
          SERVICE_ENTRY_MODE: "subscription",
          CLIPROXY_ENABLED: "0",
        },
      }),
    ];

    const context = await browser.newContext();
    try {
      await smokeEntryPage(await context.newPage(), managers[0].url, "subscription");
    } finally {
      await context.close();
    }
  });
});
