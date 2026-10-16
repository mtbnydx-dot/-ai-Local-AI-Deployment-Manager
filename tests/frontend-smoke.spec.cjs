const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { getFreePort, setPrefs, startManager } = require("./frontend/helpers/console-harness.js");

const ROOT = path.resolve(__dirname, "..");

async function verifyVllmSchedulerLaunch(page) {
  const launches = [];
  // Keep scheduler-field checks independent of the host's runtime images.
  await page.route("**/api/launch/plan", (route) => route.fulfill({
    json: {
      ok: true,
      planHash: "sha256:smoke-scheduler",
      steps: [],
      blockers: [],
      errors: [],
      warnings: [],
      overrides: [],
      admission: { verdict: "allow" },
    },
  }));
  // Capture submissions at the browser boundary; never create a real GPU job.
  await page.route("**/api/start", async (route) => {
    launches.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  const scheduler = page.locator("#maxNumBatchedTokens");
  const stage = (name) => page.locator(`[data-launch-stage-target='${name}']`);
  const submit = page.locator("#startForm button[type='submit']");
  await expect(scheduler).toBeVisible();
  await expect(scheduler).toHaveValue("0");
  await expect(scheduler).toHaveAttribute("name", "maxNumBatchedTokens");
  await stage("access").click();
  // This always exercises the confirmation dialog, independent of runtime status.
  await page.locator("#networkAccess").selectOption("lan");
  await page.locator("#vllmApiKey").fill("");

  for (const engine of ["vllm", "sglang"]) {
    await stage("model").click();
    await page.locator("#runtimeEngine").selectOption(engine);
    for (const tokens of [0, 8192, 4194304]) {
      await stage("resources").click();
      await scheduler.fill(String(tokens));
      await stage("access").click();
      const before = launches.length;
      await submit.click();
      await expect(page.locator("#launchConfirmDialog")).toBeVisible();
      await page.locator("#launchConfirmSubmit").click();
      await expect.poll(() => launches.length).toBe(before + 1);
      expect(launches.at(-1)).toMatchObject({ engine, maxNumBatchedTokens: tokens });
      await expect(submit).toBeEnabled();
    }
  }

  for (const invalid of ["-1", "1.5", "4194305"]) {
    await stage("resources").click();
    await scheduler.fill(invalid);
    await stage("access").click();
    await submit.click();
    await expect(scheduler).toBeVisible();
    expect(await scheduler.evaluate((node) => node.validity.valid)).toBe(false);
    await expect(page.locator("#launchConfirmDialog")).not.toBeVisible();
    expect(launches).toHaveLength(6);
  }
  // Correcting an invalid value must recover without reloading the page.
  await scheduler.fill("0");
  await stage("access").click();
  await submit.click();
  await expect(page.locator("#launchConfirmDialog")).toBeVisible();
  await page.locator("#launchConfirmDialog button[value='cancel']").last().click();
  expect(launches).toHaveLength(6);
  await stage("resources").click();
}

async function verifyResourceLayout(page, label) {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      fields: Array.from(document.querySelectorAll(".context-section .control-group-grid input[type='number']"))
        .filter((node) => node.getClientRects().length)
        .map((node) => {
          const field = node.getBoundingClientRect();
          const label = node.closest("label").getBoundingClientRect();
          return { id: node.id, width: field.width, contained: field.left >= label.left - 1 && field.right <= label.right + 1 };
        }),
    }));
    expect(layout.scrollWidth, `${label} resource page fits ${viewport.width}px`).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(layout.fields.length).toBeGreaterThan(0);
    for (const field of layout.fields) {
      expect(field.width, `${label} ${field.id} is readable at ${viewport.width}px`).toBeGreaterThanOrEqual(180);
      expect(field.contained, `${label} ${field.id} stays inside its label`).toBe(true);
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
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
  // The download form asks for a size estimate, a precheck and variants as soon
  // as it has a model, including while the English audit below walks every view.
  // Answering them here keeps those loading states from depending on the network
  // (or on how long the manager takes to fail) when the audit looks at the page.
  await page.route("**/api/download/estimate?*", route => route.fulfill({ json: { bytes: 1024, fileCount: 1, diskFreeBytes: 100 * 1024 ** 3 } }));
  await page.route("**/api/download/precheck?*", route => route.fulfill({ json: { ok: true, findings: [] } }));
  await page.route("**/api/remote-models/*-variants?*", route => route.fulfill({ json: { variants: [] } }));
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
  if (label === "vLLM") {
    const stableProfile = "qwen38-flash-next-sglang-262k";
    await expect(page.locator(`#serviceProfileSelect option[value='${stableProfile}']`)).toHaveCount(1);
    await page.locator("#serviceProfileSelect").selectOption(stableProfile);
    await page.locator("#serviceProfileApply").click();
    await expect(page.locator("#runtimeEngine")).toHaveValue("sglang");
    await expect(page.locator("#runtimeImage")).toHaveValue("local/sglang:qwen38flashnext-sm120-dac5523d");
    await expect(page.locator("#maxModelLen")).toHaveValue("262144");
    await expect(page.locator("#maxNumSeqs")).toHaveValue("1");
    await expect(page.locator("#sglangPageSize")).toHaveValue("64");
    await expect(page.locator("#sglangChunkedPrefillSize")).toHaveValue("4096");
    await expect(page.locator("#sglangPleOffloadEmbedding")).toBeChecked();
    await expect(page.locator("#sglangLinearAttnPrefillBackend")).toHaveValue("triton");
    await expect(page.locator("#sglangLinearAttnDecodeBackend")).toHaveValue("flashinfer");
    await expect(page.locator("#sglangMaxMambaCacheSize")).toHaveValue("8");
    await expect(page.locator("#sglangDisableThinkingByDefault")).toBeChecked();
  }
  await page.locator("[data-launch-stage='model'] [data-launch-stage-next]").click();
  await expect(page.locator("[data-launch-stage='resources']")).toBeVisible();
  if (label === "vLLM") {
    await expect(page.locator("#sglangAdvancedControls")).toBeVisible();
    await page.locator("#sglangAdvancedControls summary").click();
    // The note is rendered from a template and localised in English mode.
    await expect(page.locator("#sglangProfileNote")).toContainText(/有效并发为 1|Mamba cache 8 is currently 1/);
    await verifyVllmSchedulerLaunch(page);
  }
  await verifyResourceLayout(page, label);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  // The catalog must be reachable at the top even with a long local model library.
  const onlineModel = { id: "example/online-smoke-model", label: "example/online-smoke-model", author: "example", outputName: "online-smoke-model", source: "huggingface", url: "https://huggingface.co/example/online-smoke-model", hasGguf: label === "llama", hasSafetensors: label === "vLLM", quantFormats: label === "llama" ? ["Q4_K_M"] : ["FP8"], paramsB: 8, lastModified: "2026-09-01" };
  await page.route("**/api/remote-models?*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ models: [onlineModel], limit: 48, source: "huggingface", sort: "trending" }) }));
  await page.locator("[data-view='download']").click();
  await page.locator("#downloadRunnableModelsBtn").click();
  await expect(page).toHaveURL(/#online-models$/);
  await expect(page.locator("#remoteSearch")).toBeInViewport();
  await expect(page.locator("#remoteModelList .remote-model-card")).toHaveCount(1);
  await page.locator("#remoteSearch").fill("online-smoke-model");
  const catalogQuery = page.waitForRequest(r => r.url().includes("/api/remote-models?") && new URL(r.url()).searchParams.get("search") === "online-smoke-model");
  await page.locator("#remoteSearchBtn").click(); await catalogQuery;
  await page.locator(".remote-filters summary").click();
  await expect(page.locator("#remoteQuantFilter")).toBeVisible();
  await page.locator(".remote-filters summary").click();
  await expect(page.locator("#modelList")).not.toBeVisible();
  await page.locator("[data-view='models']").click();
  await expect(page.locator("#modelList")).toBeVisible();
  await expect(page.locator("#remoteSearch")).not.toBeVisible();
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
  {
    // Both managers must render English without leftover Chinese in the primary views.
    await page.locator("#languageMode").selectOption("en-US");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    const untranslated = [];
    for (const view of ["service", "models", "online-models", "download", "exposure", "external-access", "tools", "stats", "audit", "logs"]) {
      await page.locator(`[data-view='${view}']`).click();
      const visiblePanels = page.locator(`[data-view-panel='${view}']:visible`);
      await expect(visiblePanels.first()).toBeVisible();
      const collectVisibleHan = () => visiblePanels.evaluateAll((panels) => {
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
      // Text that is rendered after an async step (loading states, refreshed
      // lists) is translated a moment later, so wait until the view has no
      // visible Chinese rather than sleeping for a fixed time. Only text that
      // is still Chinese when the wait runs out counts as untranslated.
      let visibleHan = await collectVisibleHan();
      await expect.poll(async () => {
        visibleHan = await collectVisibleHan();
        return visibleHan.length;
      }, { timeout: 5_000, intervals: [50, 100, 250] }).toBe(0).catch(() => {});
      untranslated.push(...visibleHan.map((value) => `${view}: ${value}`));
    }
    expect(Array.from(new Set(untranslated)), `${label} English mode should not leave visible Chinese in primary views`).toEqual([]);
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
  await page.locator("[data-view='online-models']").click();
  await expect(page.locator("[data-view='online-models'] span")).toHaveText("在线模型");
  await expect(page.locator("#remoteSearch")).toBeInViewport();
  expect(await page.locator("#remoteSearch").evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(250);
  expect(await page.locator(".remote-model-card h4").evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} online model browser fits a phone`).toBe(true);
  // Test catalog-to-download navigation separately from the baseline language audit.
  await page.locator('[data-action="remote-download"]').click();
  await expect(page).toHaveURL(/#download$/);
  await expect(page.locator("#downloadModel")).toHaveValue(onlineModel.id);
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
  await page.route("http://ai-box.lan:5176/billing/classic**", async (route) => {
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: await fs.readFile(path.join(ROOT, "service-entry", "billing.html"), "utf8"),
    });
  });
  await page.route("http://ai-box.lan:5176/api/session", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, role: "owner", via: "session", paired: true, csrfToken: "t", pairCommand: "platform admin pair" }) });
  });
  await page.route("http://ai-box.lan:5176/api/status", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ managers: [] }) });
  });
  await page.route("http://ai-box.lan:5176/api/billing/**", async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split("/").filter(Boolean).at(-1);
    if (url.pathname.endsWith("/ledger/adjustments") && route.request().method() === "POST") {
      expect(route.request().headers()["x-csrf-token"]).toBe("t");
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

  await page.goto("http://ai-box.lan:5176/billing/classic?manager=llama", { waitUntil: "domcontentloaded" });
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

// 07 §2.3: the shell's policy. The smoke loads the new console under it and
// fails on any violation the browser reports.
// CON-26: the managers point at the new console with a host-relative link.
async function smokeLegacyBanner(page, managerUrl, manager) {
  const origin = new URL(managerUrl);
  const config = await (await page.request.get(`${managerUrl}api/config`)).json();
  const entryPort = String(config.entryPort || 5176);
  await page.goto(`${managerUrl}#stats`, { waitUntil: "domcontentloaded" });
  const link = page.locator("#legacyConsoleBanner a");
  await expect(link).toBeVisible();
  const href = new URL(await link.getAttribute("href"));
  expect(href.hostname).toBe(origin.hostname);
  expect(href.protocol).toBe(origin.protocol);
  expect(href.port).toBe(entryPort);
  expect(href.pathname).toBe("/");
  expect(href.searchParams.get("from")).toBe(manager);
  expect(href.searchParams.get("ui")).toBe("new");
  expect(["auto", "light", "dark"]).toContain(href.searchParams.get("theme"));
  expect(href.searchParams.get("lang")).toMatch(/^(zh-CN|en-US)$/);
  expect(href.hash).toBe("#stats");
  await page.goto(`${managerUrl}#download`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#legacyConsoleBanner a")).toBeVisible();
  await page.locator("#legacyConsoleBanner button").click();
  await expect(page.locator("#legacyConsoleBanner")).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator("#legacyConsoleBanner")).toHaveCount(0);
}

const CONSOLE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; worker-src 'none'";

async function smokeConsoleShell(page, baseUrl) {
  const failures = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || /Content Security Policy/i.test(message.text())) failures.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (["document", "script", "stylesheet", "fetch", "xhr"].includes(type) && response.status() >= 400) {
      failures.push(`${type} ${response.status()}: ${response.url()}`);
    }
  });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  // / is the new console by default (07 C10, CON-26); ?ui=classic is the per-request way back.
  const root = await page.request.get(baseUrl);
  expect(root.headers()["content-security-policy"]).toBe(CONSOLE_CSP);
  expect(await root.text()).toContain('name="console-build"');
  const classicRoot = await page.request.get(`${baseUrl}?ui=classic`);
  expect(await classicRoot.text()).toContain("本地模型服务统一入口");
  expect(classicRoot.headers()["content-security-policy"]).toBeUndefined();

  // The shell (CON-6) renders every path in its frame; every page is built.
  for (const [pathname, heading] of [["?ui=new", "总览"], ["overview", "总览"], ["system", "系统"]]) {
    const response = await page.goto(`${baseUrl}${pathname}`, { waitUntil: "domcontentloaded" });
    expect(response.status(), pathname).toBe(200);
    expect(response.headers()["content-security-policy"], pathname).toBe(CONSOLE_CSP);
    await expect(page.locator("#app")).not.toHaveAttribute("aria-busy", /.+/);
    await expect(page.locator("#app h1")).toHaveText(heading);
    await expect(page).toHaveTitle(`${heading} · 本地 AI 平台`);
    await expect(page.locator('#app nav a[href="/classic"]'), "the classic console link is gone").toHaveCount(0);
    expect(await page.evaluate(() => window.__cspViolations), `${pathname} CSP violations`).toEqual([]);
  }

  const buildId = await page.locator('meta[name="console-build"]').getAttribute("content");
  expect(buildId).toMatch(/^[0-9a-f]{12}$/);
  const asset = await page.request.get(`${baseUrl}c/${buildId}/app.js`);
  expect(asset.status()).toBe(200);
  expect(asset.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  const stale = await page.request.get(`${baseUrl}c/000000000000/app.js`);
  expect(stale.status()).toBe(410);
  expect((await stale.json()).error.code).toBe("console_stale");

  // The preferences cookie picks the server-injected language and theme.
  await page.context().addCookies([{ name: "console_prefs", value: "locale:en-US|theme:dark", url: baseUrl }]);
  await page.goto(`${baseUrl}overview`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#app h1")).toHaveText("Overview");
  await expect(page).toHaveTitle("Overview · Local AI Platform");
  await expect(page.locator('#app [data-testid="overview.root"]')).toBeVisible();
  expect(await page.evaluate(() => window.__cspViolations), "English shell CSP violations").toEqual([]);

  // /classic is retired (CON-28): it hands over to the console.
  const classic = await page.request.get(`${baseUrl}classic`, { maxRedirects: 0 });
  expect(classic.status()).toBe(302);
  expect(classic.headers().location).toBe("/overview");

  // Old manager links land on the new pages: #stats with ?from=vllm is /observability, and the banner's theme and lang are kept.
  await page.goto(`${baseUrl}?ui=new&from=vllm&theme=dark&lang=en-US#stats`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(new RegExp("/observability$"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.goto(`${baseUrl}#models`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(new RegExp("/deployments$"));
  // Pages that are not in the build yet answer 404 for their module; that is the "still being built" path, not a failure.
  // No manager runs here, so the overview's per-manager calls answer 502 and its lists simply stay empty.
  const unexpected = failures.filter((item) => !/\/c\/[0-9a-f]+\/routes\/|Failed to load resource|fetch 502: .*\/api\/m\//.test(item));
  expect(unexpected, "console shell frontend errors").toEqual([]);
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
      await smokeLegacyBanner(await context.newPage(), managers[0].url, "vllm");
      await smokeLegacyBanner(await context.newPage(), managers[1].url, "llama");
    } finally {
      await context.close();
    }
  });

  // PUB-5 with required pairing and a fresh access store: the first browser
  // that opens / auto-pairs (once) and is the owner of the classic console;
  // a second browser is a viewer until it opens a #pair= link minted by the
  // first, which pairs it and is stripped from the address bar.
  test("the classic console works after pairing", async ({ browser }) => {
    const entryPort = await getFreePort();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "entry-pairing-"));
    const upstreams = {};
    for (const name of ["VLLM_MANAGER_PORT", "LLAMA_MANAGER_PORT", "TTS_GATEWAY_PORT", "SEARCH_GATEWAY_PORT", "PLATFORM_MCP_PORT"]) {
      upstreams[name] = String(await getFreePort());
    }
    managers = [
      await startManager({
        cwd: path.join(ROOT, "service-entry"),
        port: entryPort,
        env: {
          ...upstreams,
          SERVICE_ENTRY_HOST: "127.0.0.1",
          SERVICE_ENTRY_PORT: String(entryPort),
          SERVICE_ENTRY_CONSOLE_DEFAULT: "classic",
          SERVICE_ENTRY_REQUIRE_PAIRING: "1",
          AI_BILLING_DB: path.join(dataDir, "billing.sqlite"),
        },
      }),
    ];
    const baseUrl = managers[0].url;
    const sessionOf = (page) => page.evaluate(async () => (await fetch("/api/session", { cache: "no-store" })).json());
    const first = await browser.newContext();
    const second = await browser.newContext();
    try {
      const owner = await first.newPage();
      await owner.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await expect(owner.locator("h1")).toContainText("本地模型服务统一入口");
      const ownerSession = await sessionOf(owner);
      expect([ownerSession.role, ownerSession.via, ownerSession.paired]).toEqual(["owner", "session", true]);
      const cookie = (await first.cookies()).find((item) => item.name === "lai_admin");
      expect([cookie.httpOnly, cookie.sameSite, cookie.path]).toEqual([true, "Strict", "/"]);

      // A write without the token is refused; with it the owner mints a code.
      const refused = await owner.evaluate(async () => (await fetch("/api/session/pair-codes", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
      expect(refused).toBe(403);
      const minted = await owner.evaluate(async (csrf) => (await fetch("/api/session/pair-codes", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ ttlSeconds: 120 }),
      })).json(), ownerSession.csrfToken);
      expect(minted.url).toMatch(/#pair=[A-Z2-7]{10}$/);

      // Auto-pair fired once: the second browser is a viewer.
      const other = await second.newPage();
      await other.goto(baseUrl, { waitUntil: "domcontentloaded" });
      expect((await sessionOf(other)).role).toBe("viewer");
      await other.goto(`${baseUrl}#pair=${minted.code}`, { waitUntil: "domcontentloaded" });
      await expect(other.locator("#toast")).toContainText("此浏览器已与控制台配对");
      expect(other.url()).toBe(baseUrl);
      expect((await sessionOf(other)).role).toBe("owner");
    } finally {
      await first.close();
      await second.close();
      await Promise.all(managers.map((manager) => manager.stop()));
      managers = [];
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("the new console shell boots under its CSP", async ({ browser }) => {
    const entryPort = await getFreePort();
    // Nothing listens on the upstream ports: the shell needs no other service.
    const upstreams = {};
    for (const name of ["VLLM_MANAGER_PORT", "LLAMA_MANAGER_PORT", "TTS_GATEWAY_PORT", "SEARCH_GATEWAY_PORT", "PLATFORM_MCP_PORT"]) {
      upstreams[name] = String(await getFreePort());
    }
    managers = [
      await startManager({
        cwd: path.join(ROOT, "service-entry"),
        port: entryPort,
        env: {
          ...upstreams,
          SERVICE_ENTRY_HOST: "127.0.0.1",
          SERVICE_ENTRY_PORT: String(entryPort),
        },
      }),
    ];

    // Without a preference cookie the browser language picks the shell language.
    const context = await browser.newContext({ locale: "zh-CN" });
    // The entry has its own empty state, so the first visitor is the owner of a
    // first run and would be sent to /setup. This test is about the shell.
    await setPrefs(context, { dismissedSetup: true });
    try {
      await smokeConsoleShell(await context.newPage(), managers[0].url);
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
