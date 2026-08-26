const { test, expect } = require("@playwright/test");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");
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
  // Keep the picker fixture deterministic. The app refreshes the remote catalog
  // in the background, so a fast Hub response could otherwise append live
  // results before the fixed 12-item assertion below.
  await page.route("**/api/remote-models?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ models: [], limit: 48, source: "huggingface", sort: "trending" }),
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
  await page.route("**/api/stats", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        updatedAt: "2026-08-09T00:30:00.000Z",
        uptimeSeconds: 3600,
        source: "smoke metrics",
        rawMetricCount: 12,
        totals: {
          tokens: { prompt: 10_000, generation: 2_000, cachedPrompt: 0, total: 12_000 },
          requests: { total: 2, success: 2, error: 0, aborted: 0 },
          speed: { recentPromptTokensPerSecond: 120, recentOutputTokensPerSecond: 52, recentRequestsPerMinute: 1, lifetimeTokensPerSecond: 3.3 },
          latency: { avgE2eSeconds: 2, avgTtftSeconds: 0.2, avgTimePerOutputTokenSeconds: 0.02 },
          context: { activeTokens: 0, capacityTokens: 524288, kvUsagePercent: 0 },
        },
        live: { models: [] },
        historical: { models: [] },
        models: [],
        facts: {},
        gpu: { ok: true, name: "Smoke GPU", usedMb: 4096, totalMb: 97887, util: 10, temp: 40 },
        costComparison: [],
        clientUsage: { clients: [] },
        recentAccess: { sources: [] },
        trends: { hours: 24, samples: [] },
        cacheHit: {
          enabled: true,
          source: "llama.cpp /slots (read-only polling)",
          trackingSince: "2026-08-09T00:00:00.000Z",
          observedRequests: 1,
          latest: { status: "completed", promptTokens: 138156, processedTokens: 252, cachedTokens: 137904, hitRate: 137904 / 138156 },
          rollingHour: { requests: 1, promptTokens: 138156, processedTokens: 252, cachedTokens: 137904, hitRate: 137904 / 138156 },
          cumulative: { requests: 1, promptTokens: 138156, processedTokens: 252, cachedTokens: 137904, hitRate: 137904 / 138156 },
        },
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
  await expect(page.locator(".app-signature")).toContainText(/本地模型服务平台 · 2026|Local Model Service Platform · 2026/);
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
      await expect(page.locator("#serviceExposureEndpoints")).toContainText(/网关即时开关|Live gateway controls/);
      await expect(page.locator("#serviceExposureEndpoints [data-exposure-field='enabled']").first()).toBeVisible();
      await page.locator("#exposureMode").selectOption("reverse-proxy");
      await expect(page.locator("#exposurePublicBaseUrl")).toHaveAttribute("required", "");
      await expect(page.locator(".exposure-mode-guidance")).toContainText("HTTPS");
    }
    if (view === "stats" && label === "llama") {
      await expect(page.locator("#cacheHitSummary")).toContainText("99.82%");
      await expect(page.locator("#cacheHitSummary")).toContainText("137.9K / 138.2K");
      await expect(page.locator("#cacheHitNote")).toContainText(/已持久化 1 个完成请求|1 completed request persisted/);
    }
  }
  if (label === "llama") {
    await page.locator("#languageMode").selectOption("en-US");
    await page.waitForTimeout(150);
    const untranslated = [];
    for (const view of ["service", "models", "download", "exposure", "external-access", "tools", "stats", "audit", "logs"]) {
      await page.locator(`[data-view='${view}']`).click();
      const visiblePanels = page.locator(`[data-view-panel='${view}']:visible`);
      await expect(visiblePanels.first()).toBeVisible();
      await page.waitForTimeout(250);
      const visibleHan = await visiblePanels.evaluateAll((panels) => {
        const values = new Set();
        for (const panel of panels) {
          const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const parent = node.parentElement;
            const value = node.nodeValue.trim().replace(/\s+/g, " ");
            if (!value || !/\p{Script=Han}/u.test(value) || !parent || parent.closest("code, pre, .logs-box, .audit-markdown, [data-no-i18n]")) continue;
            if (parent.getClientRects().length) values.add(value);
          }
        }
        return Array.from(values);
      });
      untranslated.push(...visibleHan.map((value) => `${view}: ${value}`));
    }
    expect(Array.from(new Set(untranslated)), "llama English mode should not leave visible Chinese in primary views").toEqual([]);
    await page.locator("#languageMode").selectOption("zh-CN");
    await expect(page.locator("[data-view='service'] span")).toHaveText("服务");
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
  if (label === "llama") {
    await page.locator("[data-view='stats']").click();
    await expect(page.locator("#cacheHitSummary")).toBeVisible();
    const cacheMobile = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      panelWidth: document.querySelector("#cacheHitSummary")?.getBoundingClientRect().width || 0,
    }));
    expect(cacheMobile.panelWidth, "cache-hit cards should stay visible on mobile").toBeGreaterThan(300);
    expect(cacheMobile.scrollWidth, "cache-hit stats should not overflow horizontally").toBeLessThanOrEqual(cacheMobile.clientWidth + 1);
  }
  await page.waitForTimeout(500);
  expect(failures, `${label} frontend errors`).toEqual([]);
}

function buildFleetSmokeSnapshot(input = "balanced") {
  const settings = {
    mode: "balanced",
    reserveMb: 8192,
    maxUtilizationPct: 85,
    preferEngine: "auto",
    ...(typeof input === "string" ? { mode: input } : input || {}),
  };
  const totalMb = 97887;
  const usedMb = 72625;
  const freeMb = totalMb - usedMb;
  // Keep the stub's API value reserve-limited so the page also proves it
  // independently caps the displayed recommendation at the configured line.
  const allocatableMb = Math.max(0, freeMb - settings.reserveMb);
  return {
    ok: true,
    updatedAt: "2026-08-05T00:00:00.000Z",
    settings,
    gpuMemory: {
      totalMb,
      usedMb,
      freeMb,
      reserveMb: settings.reserveMb,
      allocatableMb,
      warningThresholdPct: settings.maxUtilizationPct,
    },
    instances: [
      {
        id: "primary",
        instanceId: "primary",
        primary: true,
        managerId: "vllm",
        managerName: "vLLM Manager",
        engine: "vllm",
        containerName: "vllm-local",
        running: true,
        lifecycleState: "ready",
        status: "Up 2 hours (healthy)",
        port: 8000,
        localBaseUrl: "http://127.0.0.1:8000/v1",
        models: [{ id: "nvidia-qwen3.6-27b-nvfp4", capabilities: ["text", "tools"] }],
      },
      {
        id: "llama-primary",
        instanceId: "primary",
        primary: true,
        managerId: "llama",
        managerName: "llama.cpp Manager",
        engine: "llama",
        containerName: "llama-local",
        running: false,
        lifecycleState: "crashed",
        status: "Exited (255) 4 weeks ago",
        port: 8080,
        models: [],
      },
    ],
    slots: [
      { id: "vision", label: "视觉模型槽位", role: "视觉 / 图像理解", state: "empty", status: "待加载", managerId: "vllm" },
      { id: "embedding", label: "Embedding / Reranker 槽位", role: "向量 / 检索增强", state: "empty", status: "待加载", managerId: "vllm" },
    ],
    gatewayBase: "http://127.0.0.1:5176/gateway/auto/openai",
    routing: {
      mode: settings.mode,
      capabilityCounts: { text: 1, vision: 0, audio: 0, embedding: 0, rerank: 0, tools: 1 },
    },
  };
}

async function smokeEntryPage(page, baseUrl) {
  const failures = [];
  let fleetSettings = { mode: "balanced", reserveMb: 8192, maxUtilizationPct: 85, preferEngine: "auto" };
  let fleetReads = 0;
  let delayNextFleetRead = false;
  let delayedFleetReadStarted = Promise.resolve();
  let resolveDelayedFleetReadStarted = () => {};
  const settingsRequests = [];
  const previewRequests = [];
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
  await page.route("**/api/status", async (route) => {
    const entryPort = Number(new URL(baseUrl).port);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        entry: {
          host: "127.0.0.1",
          port: entryPort,
          gateway: {
            autoOpenAi: `${baseUrl}gateway/auto/openai`,
            tts: `${baseUrl}gateway/tts/`,
            ttsOpenAi: `${baseUrl}gateway/tts/openai/v1`,
          },
          gatewayAccess: { totals: { requests: {} }, recent: [], paths: [], timeline: [] },
        },
        managers: [],
        tts: {
          name: "TTS 语音克隆平台",
          port: 7000,
          listening: true,
          healthy: true,
          availableCount: 1,
          totalCount: 2,
          engines: [
            { id: "fish", name: "Fish S2 Pro", type: "local", available: true, detail: "ready" },
            { id: "qwen_local", name: "Qwen3-TTS", type: "local", available: false, detail: "offline" },
          ],
          gatewayUrls: {
            local: `${baseUrl}gateway/tts/`,
            localOpenAi: `${baseUrl}gateway/tts/openai/v1`,
          },
        },
      }),
    });
  });
  await page.route("**/api/fleet/settings", async (route) => {
    const body = route.request().postDataJSON();
    settingsRequests.push(body);
    fleetSettings = { ...fleetSettings, ...body };
    const fleet = buildFleetSmokeSnapshot(fleetSettings);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, settings: fleet.settings, fleet }),
    });
  });
  await page.route("**/api/fleet/route-preview", async (route) => {
    const body = route.request().postDataJSON();
    previewRequests.push(body);
    const unavailable = !["text", "tools"].includes(body.capability);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(unavailable ? {
        ok: false,
        status: 503,
        error: "capability_not_available",
        message: `No running model provides the required ${body.capability} capability.`,
        capability: body.capability,
        reason: `No running model provides the required ${body.capability} capability.`,
      } : {
        ok: true,
        status: 200,
        capability: body.capability,
        reason: `generic_${body.capability}`,
        manager: { id: "vllm", name: "vLLM Manager", port: 5177 },
        instance: { id: "primary", instanceId: "primary", primary: true, status: "ready", port: 8000 },
        model: { id: "nvidia-qwen3.6-27b-nvfp4", capabilities: ["text", "tools"] },
      }),
    });
  });
  await page.route("**/api/fleet", async (route) => {
    fleetReads += 1;
    const responseSettings = { ...fleetSettings };
    if (delayNextFleetRead) {
      delayNextFleetRead = false;
      resolveDelayedFleetReadStarted();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildFleetSmokeSnapshot(responseSettings)),
    });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1")).toContainText("本地模型服务统一入口");
  await expect(page.locator("#entrySummary")).toBeVisible();
  await expect(page.locator("#fleetMainPanel")).toBeVisible();
  await expect(page.locator("#fleetRoutingPanel")).toBeVisible();
  await expect(page.locator("#fleetTitle")).toContainText("多模型舰队");
  await expect(page.locator("#fleetMainPanel")).toContainText("所有已发现实例与能力槽位");
  await expect(page.locator("#fleetMainPanel")).toContainText("已崩溃");
  await expect(page.locator("#fleetMainPanel")).toContainText("1 个可路由 · 1 个非路由 · 共 2 个实例");
  await expect(page.locator("#fleetMainPanel")).toContainText("API 可分配");
  await expect(page.locator("#fleetMainPanel")).toContainText("16.7 GiB");
  await expect(page.locator("#fleetMainPanel")).toContainText("保护线内上限");
  await expect(page.locator("#fleetMainPanel")).toContainText("10.3 GiB");
  await expect(page.locator("#managerGrid")).toBeVisible();
  await expect(page.locator('[data-render-key="tts-platform"]')).toContainText("TTS 语音克隆平台");
  await expect(page.locator('[data-render-key="tts-platform"]')).toContainText("1 / 2");
  await expect(page.locator('[data-render-key="tts-platform"] a[href="/gateway/tts/"]')).toBeVisible();
  await expect(page.locator("#entryAccessPanel")).toBeVisible();
  await expect(page.locator(".app-signature")).toContainText("本地模型服务平台 · 2026");
  await expect(page.locator("#lastUpdatedBadge")).toContainText("已刷新", { timeout: 15_000 });
  await expect(page.locator("#fleetMainPanel")).not.toHaveAttribute("aria-live", /.+/);
  await expect(page.locator("#fleetRoutingPanel")).not.toHaveAttribute("aria-live", /.+/);
  await expect(page.locator("#fleetStatusAnnouncer")).toHaveAttribute("aria-live", "polite");

  const primaryRow = page.locator('[data-render-key="vllm:primary"]');
  const detailsButton = primaryRow.locator("[data-fleet-details]");
  await detailsButton.click();
  await expect(detailsButton).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => {
    window.__smokeFleetRow = document.querySelector('[data-render-key="vllm:primary"]');
    window.__smokeFleetDetailsButton = window.__smokeFleetRow?.querySelector("[data-fleet-details]");
  });
  const identityRefreshTarget = fleetReads + 1;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => fleetReads).toBeGreaterThanOrEqual(identityRefreshTarget);
  expect(await page.evaluate(() => (
    window.__smokeFleetRow === document.querySelector('[data-render-key="vllm:primary"]')
    && window.__smokeFleetDetailsButton === document.querySelector('[data-render-key="vllm:primary"] [data-fleet-details]')
    && document.activeElement === window.__smokeFleetDetailsButton
  )), "fleet refresh should retain keyed row/button identity and focus").toBe(true);
  await expect(detailsButton).toHaveAttribute("aria-expanded", "true");

  delayedFleetReadStarted = new Promise((resolve) => {
    resolveDelayedFleetReadStarted = resolve;
  });
  delayNextFleetRead = true;
  await page.locator("#fleetRefreshBtn").click();
  await delayedFleetReadStarted;
  await page.locator("[data-fleet-mode='multimodal']").click();
  await expect(page.locator("#toast")).toContainText("舰队模式已保存：多模态优先");
  await expect.poll(() => fleetReads).toBeGreaterThanOrEqual(3);
  await expect(page.locator("[data-fleet-mode='multimodal']")).toHaveAttribute("aria-pressed", "true");
  expect(settingsRequests).toEqual([{ mode: "multimodal" }]);

  await expect(page.locator("#fleetMaxUtilizationPct")).toHaveValue("85");
  await expect(page.locator("#fleetReserveGiB")).toHaveValue("8");
  await page.locator("#fleetMaxUtilizationPct").fill("90.5");
  await page.locator("#fleetReserveGiB").fill("6.5");
  await page.locator("#fleetPolicySave").click();
  await expect(page.locator("#toast")).toContainText("显存策略已保存：安全线 90.5%，预留 6.5 GiB");
  await expect(page.locator("#fleetMainPanel")).toContainText("保护线 90.5%");
  expect(settingsRequests).toEqual([
    { mode: "multimodal" },
    { maxUtilizationPct: 90.5, reserveMb: 6656 },
  ]);

  await page.locator("#fleetPreviewCapability").selectOption("vision");
  await page.locator("#fleetPreviewModel").fill("nvidia-qwen3.6-27b-nvfp4");
  await page.locator("#fleetPreviewSubmit").click();
  await expect(page.locator("#fleetPreviewResult")).toContainText("capability_not_available");
  await page.locator("#fleetPreviewCapability").selectOption("text");
  await page.locator("#fleetPreviewModel").fill("");
  await page.locator("#fleetPreviewSubmit").click();
  await expect(page.locator("#fleetPreviewResult")).toContainText("将路由到 nvidia-qwen3.6-27b-nvfp4");
  expect(previewRequests).toEqual([
    { capability: "vision", engine: "auto", protocol: "openai", model: "nvidia-qwen3.6-27b-nvfp4" },
    { capability: "text", engine: "auto", protocol: "openai" },
  ]);
  expect(JSON.stringify(previewRequests)).not.toMatch(/messages|prompt|content|image|audio/i);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileShell = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    fleetWidth: document.querySelector("#fleetMainPanel")?.getBoundingClientRect().width || 0,
  }));
  expect(mobileShell.fleetWidth, "fleet workbench should stay visible on mobile").toBeGreaterThan(300);
  expect(mobileShell.scrollWidth, "service-entry mobile page should not overflow horizontally")
    .toBeLessThanOrEqual(mobileShell.clientWidth + 1);
  expect(failures, "service-entry frontend errors").toEqual([]);
}

async function smokeBillingPage(page) {
  const failures = [];
  let adjustmentWrites = 0;
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  await page.addInitScript(() => {
    window.__billingConfirmMessages = [];
    window.__billingConfirmResult = false;
    window.confirm = (message) => {
      window.__billingConfirmMessages.push(String(message));
      return window.__billingConfirmResult;
    };
  });
  await page.route("http://ai-box.lan:5176/billing**", async (route) => {
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: await fs.readFile(path.join(ROOT, "service-entry", "billing.html"), "utf8"),
    });
  });
  await page.route("http://ai-box.lan:5176/api/status", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ managers: [] }) });
  });
  await page.route("http://ai-box.lan:5176/api/billing/**", async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split("/").filter(Boolean).at(-1);
    if (url.pathname.endsWith("/ledger/adjustments") && route.request().method() === "POST") {
      adjustmentWrites += 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    const payloads = {
      overview: { overview: {} },
      customers: {
        customers: [{ id: "cust-1", name: "Acme Lab", status: "active", enforcementMode: "shadow" }],
        total: 501,
      },
      plans: { plans: [], total: 0 },
      prices: { prices: [], total: 0 },
      credentials: { credentials: [], total: 0 },
      usage: { usage: [], total: 0 },
      ledger: { ledger: [], total: 0 },
      "audit-events": { auditEvents: [], total: 0 },
      templates: { items: [], total: 0, catalogVersion: "smoke" },
    };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(payloads[name] || { items: [], total: 0 }) });
  });

  await page.goto("http://ai-box.lan:5176/billing?manager=llama", { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-manager-view="service"]')).toHaveAttribute("href", "http://ai-box.lan:5178/#service");
  await expect(page.locator("#billingManagerReturn")).toHaveAttribute("href", "http://ai-box.lan:5178/#service");
  await expect(page.locator(".app-signature")).toContainText("本地模型服务平台 · 2026");
  await expect(page.locator("#billingLimitNotice")).toContainText("客户仅显示前 1 / 501 条");

  await page.locator("#customersTab").click();
  const form = page.locator("#billingAdjustmentForm");
  await form.locator('[name="customerId"]').selectOption("cust-1");
  await form.locator('[name="amountCredits"]').fill("-10.5");
  await form.locator('[name="reason"]').fill("纠正重复赠送积分");
  await form.locator('button[type="submit"]').click();
  await expect.poll(() => page.evaluate(() => window.__billingConfirmMessages.length)).toBe(1);
  const confirmation = await page.evaluate(() => window.__billingConfirmMessages[0]);
  expect(confirmation).toContain("不可逆的扣款记录");
  expect(confirmation).toContain("Acme Lab（cust-1）");
  expect(confirmation).toContain("-10.5 积分");
  expect(adjustmentWrites).toBe(0);

  await page.evaluate(() => { window.__billingConfirmResult = true; });
  await form.locator('button[type="submit"]').click();
  await expect.poll(() => adjustmentWrites).toBe(1);
  expect(failures, "billing frontend errors").toEqual([]);
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
          VLLM_MANAGER_PID_FILE: path.join(ROOT, "test-results", `.vllm-manager-${vllmPort}.pid`),
        },
      }),
      await startManager({
        cwd: path.join(ROOT, "llama-manager"),
        port: llamaPort,
        env: {
          LLAMA_MANAGER_HOST: "127.0.0.1",
          LLAMA_MANAGER_PORT: String(llamaPort),
          LLAMA_MANAGER_PID_FILE: path.join(ROOT, "test-results", `.llama-manager-${llamaPort}.pid`),
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

  test("billing uses the current LAN hostname and confirms immutable debits", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      await smokeBillingPage(await context.newPage());
    } finally {
      await context.close();
    }
  });
});
