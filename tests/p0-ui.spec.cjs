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

function statsPayload(speed = {}) {
  const totals = {
    tokens: { prompt: 10_000, generation: 2_000, cachedPrompt: 0, total: 12_000 },
    requests: { total: 2, success: 2, error: 0, aborted: 0 },
    speed: { recentPromptTokensPerSecond: 120, recentOutputTokensPerSecond: 52, recentRequestsPerMinute: 1, lifetimeTokensPerSecond: 3.3, ...speed },
    latency: { avgE2eSeconds: 2, avgTtftSeconds: 0.2, avgTimePerOutputTokenSeconds: 0.02 },
    context: { activeTokens: 0, capacityTokens: 524288, kvUsagePercent: 0 },
  };
  return {
    ok: true,
    updatedAt: "2026-10-14T00:30:00.000Z",
    uptimeSeconds: 3600,
    source: "p0 stub",
    totals,
    live: { totals, models: [], uptimeSeconds: 3600 },
    historical: { models: [] },
    models: [],
    facts: {},
    gpu: { ok: true, name: "Stub GPU", usedMb: 4096, totalMb: 97887, util: 10, temp: 40 },
    costComparison: [],
    clientUsage: { clients: [] },
    recentAccess: { sources: [] },
    trends: { hours: 24, samples: [] },
  };
}

function exposurePayload(settings = {}) {
  return {
    settings: {
      enabled: true,
      exposureMode: "lan",
      requireApiKey: false,
      hasApiKey: false,
      exposeOpenAI: true,
      exposeClaude: true,
      exposeOpenCode: true,
      exposeMetrics: false,
      allowManagerRemote: false,
      rateLimitRpm: 120,
      maxConcurrentRequests: 4,
      requestTimeoutSeconds: 600,
      allowedOrigins: [],
      allowedHeaders: [],
      publicBaseUrl: "",
      notes: "",
      ...settings,
    },
    actual: { manager: {}, service: { running: false, modelIds: [], clients: { total: 0, active: 0 } }, docker: { ok: false } },
    checks: [],
  };
}

function requestBody(request) {
  try {
    return request.postDataJSON();
  } catch {
    return request.postData();
  }
}

// Opens a manager page whose writes never reach the worktree manager: the
// catch-all is registered first, so the specific stubs a test adds run before
// it, and any write that no stub claims is answered here and recorded.
async function openManagerPage(page, baseUrl, setup = async () => {}) {
  const failures = [];
  const unclaimedWrites = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (["GET", "HEAD"].includes(request.method())) {
      await route.fallback();
      return;
    }
    unclaimedWrites.push({ method: request.method(), path: new URL(request.url()).pathname, body: requestBody(request) });
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("https://unpkg.com/**/lucide*.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.lucide={createIcons(){}};",
  }));
  await page.route("**/api/models", (route) => route.fulfill({ json: { local: [], cached: [] } }));
  // Catalog, estimate and precheck calls would otherwise reach Hugging Face.
  await page.route("**/api/remote-models?*", (route) => route.fulfill({ json: { models: [], limit: 48, source: "huggingface", sort: "trending" } }));
  await page.route("**/api/remote-models/*-variants?*", (route) => route.fulfill({ json: { variants: [] } }));
  await page.route("**/api/download/estimate?*", (route) => route.fulfill({ json: { bytes: 1024, fileCount: 1, diskFreeBytes: 100 * 1024 ** 3 } }));
  await page.route("**/api/download/precheck?*", (route) => route.fulfill({ json: { ok: true, findings: [] } }));
  await page.route("**/api/stats", (route) => route.fulfill({ json: statsPayload() }));
  // Job snapshots come from the stubs only; a long retry keeps EventSource quiet.
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "retry: 600000\n\n" }));
  await setup();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-shell")).toBeVisible();
  return { failures, unclaimedWrites };
}

async function openView(page, view) {
  await page.locator(`[data-view='${view}']`).first().click();
  await expect(page.locator(`[data-view-panel='${view}']`).first()).toBeVisible();
}

const MANAGERS = [
  { label: "vLLM", dir: "vllm-manager", portEnv: "VLLM_MANAGER_PORT", hostEnv: "VLLM_MANAGER_HOST", pidEnv: "VLLM_MANAGER_PID_FILE" },
  { label: "llama", dir: "llama-manager", portEnv: "LLAMA_MANAGER_PORT", hostEnv: "LLAMA_MANAGER_HOST", pidEnv: "LLAMA_MANAGER_PID_FILE" },
];

async function startManagers() {
  const started = {};
  for (const manager of MANAGERS) {
    const port = await getFreePort();
    started[manager.label] = await startManager({
      cwd: path.join(ROOT, manager.dir),
      port,
      env: {
        [manager.hostEnv]: "127.0.0.1",
        [manager.portEnv]: String(port),
        [manager.pidEnv]: path.join(ROOT, "test-results", `.p0-ui-${manager.dir}-${port}.pid`),
      },
    });
  }
  return started;
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

test.describe("manager pages", () => {
  // The consoles follow the browser language unless one is picked; assert the
  // zh source copy and switch to English explicitly where English is checked.
  test.use({ locale: "zh-CN" });
  let managers = {};

  test.beforeAll(async () => {
    managers = await startManagers();
  });

  test.afterAll(async () => {
    await Promise.all(Object.values(managers).map((manager) => manager.stop()));
  });

  test("P0-7 speed label follows outputSource and windowSeconds", async ({ page }) => {
    let speed = {};
    const { failures } = await openManagerPage(page, managers.vLLM.url, async () => {
      await page.route("**/api/stats", (route) => route.fulfill({ json: statsPayload(speed) }));
    });
    const summary = page.locator("#statsSummary");
    const cases = [
      [{ outputSource: "sglang_gen_throughput_gauge", windowSeconds: 0 }, "输出速度（实时）"],
      [{ outputSource: "counter_window", windowSeconds: 60 }, "输出速度（近 60 秒平均）"],
      [{ outputSource: "counter_window", windowSeconds: 0 }, "输出速度（采样中）"],
      // OBS omits windowSeconds until the window has a baseline.
      [{ outputSource: "counter_window" }, "输出速度（采样中）"],
      [{ outputSource: "sglang_recent_gauge" }, "输出速度（采样中）"],
      [{ outputSource: "unavailable" }, "输出速度（采样中）"],
      [{ outputSource: "mixed", windowSeconds: 58 }, "输出速度（多来源合计）"],
    ];
    for (const [nextSpeed, label] of cases) {
      speed = nextSpeed;
      await openView(page, "service");
      await openView(page, "stats");
      await expect(summary, JSON.stringify(nextSpeed)).toContainText(label);
      await expect(summary).not.toContainText("当前输出速度");
      await expect(summary).not.toContainText("最近一次活跃采样");
      await expect(summary).not.toContainText("启动以来活跃平均");
    }
    await expect(summary).toContainText("平均延迟（启动以来）");
    speed = { outputSource: "counter_window", windowSeconds: 60 };
    await page.locator("#languageMode").selectOption("en-US");
    await openView(page, "service");
    await openView(page, "stats");
    await expect(summary).toContainText("Output speed (60 s average)");
    await expect(summary).toContainText("Average latency (since start)");
    await page.locator("#languageMode").selectOption("zh-CN");
    expect(failures).toEqual([]);
  });

  for (const label of ["vLLM", "llama"]) {
    test(`P0-3 ${label} instance rows open their own logs`, async ({ page }) => {
      const logRequests = [];
      const { failures } = await openManagerPage(page, managers[label].url, async () => {
        await page.route("**/api/instances", (route) => route.fulfill({
          json: {
            instances: [
              { id: "primary", instanceId: "primary", primary: true, running: true, containerName: "stub-runtime", port: 8000, models: [{ id: "main-model" }], localBaseUrl: "http://127.0.0.1:8000/v1" },
              { id: "par-1", instanceId: "par-1", primary: false, running: true, containerName: "stub-runtime-par-1", port: 8001, models: [{ id: "side-model" }] },
            ],
          },
        }));
        await page.route("**/api/logs?*", (route) => {
          const url = new URL(route.request().url());
          logRequests.push(url.search);
          const instance = url.searchParams.get("instance");
          return route.fulfill({ contentType: "text/plain; charset=utf-8", body: `log lines of ${instance || "the primary container"}` });
        });
      });
      const rows = page.locator("#runtimeInstancesList .runtime-instance-row");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0).locator("[data-instance-action='logs']")).toContainText("日志");
      await rows.nth(1).locator("[data-instance-action='logs']").click();
      await expect(page).toHaveURL(/#logs$/);
      await expect(page.locator("#logsBox")).toHaveText("log lines of par-1");
      await expect(page.locator("#logsInstanceLabel")).toHaveText("实例：par-1");
      expect(logRequests.at(-1)).toBe("?tail=220&instance=par-1");
      await page.locator("#logsShowPrimaryBtn").click();
      await expect(page.locator("#logsBox")).toHaveText("log lines of the primary container");
      await expect(page.locator("#logsInstanceLabel")).toBeHidden();
      expect(logRequests.at(-1)).toBe("?tail=220");
      expect(failures).toEqual([]);
    });

    test(`P0-21 ${label} CORS any-origin needs an API key and PNA is saved`, async ({ page }) => {
      const saved = [];
      const { failures } = await openManagerPage(page, managers[label].url, async () => {
        // A legacy record: no corsMode, no API key.
        await page.route("**/api/service-exposure", async (route) => {
          if (route.request().method() === "POST") {
            const body = requestBody(route.request());
            saved.push(body);
            await route.fulfill({ json: exposurePayload({ ...body, allowedOrigins: [], allowedHeaders: [] }) });
            return;
          }
          await route.fulfill({ json: exposurePayload() });
        });
      });
      await openView(page, "exposure");
      const cors = page.locator("#exposureCorsMode");
      const requireKey = page.locator("#exposureRequireApiKey");
      await expect(cors).toHaveValue("restricted");
      await expect(cors.locator("option[value='open']")).toHaveText("任意来源（需 API Key）");
      await expect(cors.locator("option[value='open']")).toHaveJSProperty("disabled", true);
      await requireKey.check();
      await expect(cors.locator("option[value='open']")).toHaveJSProperty("disabled", false);
      await cors.selectOption("open");
      await requireKey.uncheck();
      await expect(cors).toHaveValue("restricted");
      await expect(cors.locator("option[value='open']")).toHaveJSProperty("disabled", true);
      await requireKey.check();
      await cors.selectOption("open");
      const pna = page.locator("#exposureAllowPrivateNetwork");
      await expect(pna).not.toBeChecked();
      await pna.check();
      await page.locator("#serviceExposureForm button[type='submit']").click();
      await expect.poll(() => saved.length).toBe(1);
      expect(saved[0]).toMatchObject({ corsMode: "open", requireApiKey: true, allowPrivateNetwork: true });
      await expect(pna).toBeChecked();
      expect(failures).toEqual([]);
    });
  }

  test("P0-1 wake into a busy slot asks first and only OK confirms the replace", async ({ page }) => {
    const wakes = [];
    let refusal = "wake_would_replace_running";
    const { failures } = await openManagerPage(page, managers.vLLM.url, async () => {
      await page.route("**/api/idle-unload", (route) => route.fulfill({
        json: {
          ok: true,
          settings: { enabled: true, idleMinutes: 30, minVramMb: 0, excludeModels: [] },
          sleeping: [{ id: "slp_1", model: "Sleepy-8B", hasConfig: true, sleptAt: "2026-10-14T01:00:00.000Z", vramMb: 20480, idleMinutes: 31 }],
        },
      }));
      await page.route("**/api/idle-unload/slp_1/wake", async (route) => {
        const body = requestBody(route.request()) || {};
        wakes.push(body);
        if (refusal === "wake_api_key_missing") {
          await route.fulfill({ status: 409, json: { ok: false, code: "wake_api_key_missing", error: "唤醒所需的 API Key 已不可用。/ The API key needed to wake is gone." } });
          return;
        }
        if (body.confirmReplace !== true) {
          await route.fulfill({
            status: 409,
            json: {
              ok: false,
              code: "wake_would_replace_running",
              error: "唤醒会替换正在运行的 Busy-27B。/ Waking would replace the running model Busy-27B.",
              details: { runningModel: "Busy-27B", runningContainer: "stub-runtime" },
            },
          });
          return;
        }
        await route.fulfill({ json: { ok: true, id: "slp_1", model: "Sleepy-8B", job: { id: "job-wake-1" } } });
      });
    });
    await openView(page, "tools");
    const wakeButton = page.locator("[data-idle-wake='slp_1']");
    const dialog = page.locator("#actionConfirmDialog");
    await expect(wakeButton).toBeVisible();

    // Cancelling the replace confirm sends nothing more.
    await wakeButton.click();
    await expect(dialog).toBeVisible();
    await page.locator("#actionConfirmSubmit").click();
    await expect(dialog).toContainText("唤醒会停止并替换正在运行的「Busy-27B」。确定继续？");
    await dialog.locator(".launch-confirm-actions .secondary-button").click();
    await expect(dialog).toBeHidden();
    expect(wakes).toEqual([{}]);

    // OK re-posts once with confirmReplace.
    await wakeButton.click();
    await page.locator("#actionConfirmSubmit").click();
    await expect(dialog).toContainText("Busy-27B");
    await page.locator("#actionConfirmSubmit").click();
    await expect.poll(() => wakes.length).toBe(3);
    expect(wakes.slice(1)).toEqual([{}, { confirmReplace: true }]);
    await expect(page.locator("#toastRoot")).toContainText("唤醒任务已创建");

    // A lost key explains what to do instead.
    refusal = "wake_api_key_missing";
    await wakeButton.click();
    await page.locator("#actionConfirmSubmit").click();
    await expect(page.locator("#toastRoot")).toContainText("原 API Key 已不可用，请从启动页重新启动该模型。");
    expect(wakes).toHaveLength(4);
    expect(failures).toEqual([]);
  });

  for (const label of ["vLLM", "llama"]) {
    test(`P0-8 ${label} failed download card renders the classified reason from meta`, async ({ page }) => {
      const jobs = [
        {
          id: "dl-gated",
          type: "download",
          status: "failed",
          title: "下载 example/gated-model",
          error: "需要申请访问权限 / Access approval required",
          updatedAt: "2026-10-14T01:00:00.000Z",
          logs: ["403 Client Error"],
          meta: {
            model: "example/gated-model",
            maxRetries: 2,
            retryCount: 0,
            errorCode: "hf_approval_required",
            errorRetryable: false,
            errorHint: { zh: "需要先在 Hugging Face 模型页申请访问权限并等待批准。", en: "Request access on the Hugging Face model page and wait for approval." },
          },
        },
        {
          // A code the UI has never heard of (the hub may add derived codes).
          id: "dl-derived",
          type: "download",
          status: "failed",
          title: "下载 example/empty-model",
          error: "传输为空 / Transfer was empty",
          updatedAt: "2026-10-14T00:50:00.000Z",
          logs: [],
          meta: {
            model: "example/empty-model",
            maxRetries: 2,
            retryCount: 1,
            errorCode: "transfer_empty",
            errorRetryable: true,
            errorHint: { zh: "下载结束但没有写入任何文件。", en: "The download finished without writing any file." },
          },
        },
      ];
      const { failures } = await openManagerPage(page, managers[label].url, async () => {
        await page.route("**/api/jobs?*", (route) => route.fulfill({ json: jobs }));
      });
      await openView(page, "download");
      const gated = page.locator("#jobList [data-download-error='hf_approval_required']");
      await expect(gated).toContainText("需要申请访问权限");
      await expect(gated).not.toContainText("Access approval required");
      await expect(gated).toContainText("需要先在 Hugging Face 模型页申请访问权限并等待批准。");
      await expect(gated).toContainText("此错误不会自动重试");
      await expect(page.locator("#jobList .job-row").filter({ has: page.locator("[data-download-error='hf_approval_required']") })).not.toContainText("自动重试 0/2");
      const derived = page.locator("#jobList [data-download-error='transfer_empty']");
      await expect(derived).toContainText("传输为空");
      await expect(derived).toContainText("下载结束但没有写入任何文件。");
      await expect(derived).not.toContainText("此错误不会自动重试");
      await expect(page.locator("#jobList .job-row").filter({ has: page.locator("[data-download-error='transfer_empty']") })).toContainText("自动重试 1/2");

      await page.locator("#languageMode").selectOption("en-US");
      await expect(gated).toContainText("Access approval required");
      await expect(gated).toContainText("Request access on the Hugging Face model page and wait for approval.");
      await expect(gated).toContainText("Not retried automatically");
      await expect(derived).toContainText("The download finished without writing any file.");
      await page.locator("#languageMode").selectOption("zh-CN");
      expect(failures).toEqual([]);
    });

    test(`P0-13 ${label} mirror probe suggests and only Apply saves the setting`, async ({ page }) => {
      const settingsWrites = [];
      const { failures } = await openManagerPage(page, managers[label].url, async () => {
        await page.route("**/api/download/settings", async (route) => {
          if (route.request().method() === "POST") {
            settingsWrites.push(requestBody(route.request()));
            await route.fulfill({ json: { ok: true, ...requestBody(route.request()) } });
            return;
          }
          await route.fulfill({ json: { queueMode: false, autoRetryCount: 2, autoRetryDelaySeconds: 10, hfMirror: false, hfTransfer: false, verifyChecksums: true, idleOnlyQueue: false } });
        });
        await page.route("**/api/download/mirror-probe", (route) => route.fulfill({
          json: {
            ok: true,
            recommended: "mirror",
            recommendedLabel: "hf-mirror.com",
            official: { ok: true, ms: 900, bytesPerSec: 100_000 },
            mirror: { ok: true, ms: 200, bytesPerSec: 2_000_000 },
            modelscope: { ok: false, error: "HTTP 404" },
            modelScopeRepo: "",
          },
        }));
      });
      await openView(page, "download");
      const mirror = page.locator("#downloadHfMirror");
      await expect(mirror).not.toBeChecked();
      await page.locator("#downloadMirrorProbeBtn").click();
      await expect(page.locator("#downloadMirrorProbeText")).toHaveText("镜像可用，建议开启");
      await expect(page.locator("#downloadMirrorProbeSummary")).toContainText("镜像 200ms");
      await page.waitForTimeout(300);
      await expect(mirror).not.toBeChecked();
      expect(settingsWrites, "a probe must not save settings").toEqual([]);
      await page.locator("#downloadMirrorApplyBtn").click();
      await expect.poll(() => settingsWrites.length).toBe(1);
      expect(settingsWrites[0]).toMatchObject({ hfMirror: true });
      await expect(mirror).toBeChecked();
      await expect(page.locator("#downloadMirrorApplyBtn")).toBeHidden();
      expect(failures).toEqual([]);
    });

    test(`P0-11 ${label} disk panel lists every storage root and addresses models by path`, async ({ page }) => {
      const cleanups = [];
      const upstreamQueries = [];
      const gib = 1024 ** 3;
      const diskUsage = {
        ok: true,
        root: "/srv/lib-a",
        disk: { freeBytes: 400 * gib, totalBytes: 1000 * gib },
        modelsBytes: 5 * gib,
        models: [
          { name: "alpha", path: "/srv/lib-a/alpha", rootId: "main", bytes: 5 * gib, sizeBytes: 5 * gib, incompleteFiles: 0, incompleteBytes: 0 },
          { name: "beta", path: "/srv/lib-b/beta", rootId: "second", bytes: 2 * gib, sizeBytes: 2 * gib, incompleteFiles: 2, incompleteBytes: 1024 },
        ],
        roots: [
          { id: "main", label: "Main library", path: "/srv/lib-a", default: true, legacy: false, available: true, freeBytes: 400 * gib, totalBytes: 1000 * gib, usedByModelsBytes: 5 * gib, modelCount: 1 },
          { id: "second", label: "Second library", path: "/srv/lib-b", default: false, legacy: false, available: true, freeBytes: 50 * gib, totalBytes: 500 * gib, usedByModelsBytes: 2 * gib, modelCount: 1 },
          { id: "legacy", label: "原模型库", path: "/srv/legacy", default: false, legacy: true, available: true, freeBytes: 50 * gib, totalBytes: 500 * gib, usedByModelsBytes: 0, modelCount: 0 },
        ],
        hfCache: { hubBytes: 0, xetBytes: 0, modelscopeBytes: 0 },
        incompleteBytes: 0,
        incompleteFiles: 0,
      };
      const { failures } = await openManagerPage(page, managers[label].url, async () => {
        await page.route("**/api/models/disk-usage", (route) => route.fulfill({ json: diskUsage }));
        await page.route("**/api/models/cleanup-incomplete", async (route) => {
          cleanups.push(requestBody(route.request()));
          await route.fulfill({ json: { ok: true, removed: ["a.incomplete", "b.incomplete"], removedBytes: 1024 } });
        });
        await page.route("**/api/models/upstream-status?*", async (route) => {
          upstreamQueries.push(Object.fromEntries(new URL(route.request().url()).searchParams));
          await route.fulfill({ json: { ok: true, updateAvailable: false, message: "up to date" } });
        });
      });
      await openView(page, "models");
      const roots = page.locator("#diskUsagePanel .disk-usage-roots");
      await expect(roots.locator("thead th")).toHaveText(["存储位置", "可用", "模型占用"]);
      await expect(roots.locator("tbody tr")).toHaveCount(3);
      await expect(roots.locator("tbody tr").nth(0)).toContainText("Main library");
      await expect(roots.locator("tbody tr").nth(0)).toContainText("默认");
      await expect(roots.locator("tbody tr").nth(2)).toContainText("原模型库");
      const rows = page.locator("#diskUsagePanel .disk-usage-row");
      await expect(rows.filter({ hasText: "alpha" }).locator(".disk-usage-root")).toHaveText("Main library");
      await expect(rows.filter({ hasText: "beta" }).locator(".disk-usage-root")).toHaveText("Second library");
      await rows.filter({ hasText: "beta" }).locator("[data-disk-action='cleanup']").click();
      await expect.poll(() => cleanups.length).toBe(1);
      expect(cleanups[0]).toEqual({ path: "/srv/lib-b/beta", name: "beta" });
      await rows.filter({ hasText: "alpha" }).locator("[data-disk-action='upstream']").click();
      await expect.poll(() => upstreamQueries.length).toBe(1);
      expect(upstreamQueries[0]).toEqual({ name: "alpha", path: "/srv/lib-a/alpha" });
      expect(failures).toEqual([]);
    });
  }

  test("P0-13 vLLM download request carries the chosen priority", async ({ page }) => {
    const downloads = [];
    const { failures } = await openManagerPage(page, managers.vLLM.url, async () => {
      await page.route("**/api/download", async (route) => {
        downloads.push(requestBody(route.request()));
        await route.fulfill({ json: { ok: true, job: { id: "dl-1" } } });
      });
    });
    await openView(page, "download");
    await page.locator("#downloadModel").fill("example/tiny-model");
    await page.locator("#downloadPriority").selectOption("high");
    await page.locator("#downloadForm button[type='submit']").click();
    await expect.poll(() => downloads.length).toBe(1);
    expect(downloads[0]).toMatchObject({ model: "example/tiny-model", priority: "high" });
    expect(failures).toEqual([]);
  });

  test("P0-12 llama presets point at GGUF repositories with a quant that exists", async ({ page }) => {
    const { failures } = await openManagerPage(page, managers.llama.url);
    await expect(page.locator("#startModel")).toHaveValue("Qwen/Qwen3-0.6B-GGUF");
    await openView(page, "download");
    await expect(page.locator("#downloadModel")).toHaveValue("Qwen/Qwen3-0.6B-GGUF");
    await expect(page.locator("#downloadPrecision")).toHaveValue("q8_0");
    await page.locator("#downloadSpec").selectOption("8B");
    await expect(page.locator("#downloadModel")).toHaveValue("Qwen/Qwen3-8B-GGUF");
    await expect(page.locator("#downloadPrecision")).toHaveValue("q4_k_m");
    await page.locator("#downloadDeveloper").selectOption("Meta");
    await expect(page.locator("#downloadModel")).toHaveValue("bartowski/Meta-Llama-3.1-8B-Instruct-GGUF");
    await expect(page.locator("#downloadPrecision")).toHaveValue("q4_k_m");
    await expect(page.locator("#downloadPresetHint")).not.toContainText("授权 token");
    expect(failures).toEqual([]);
  });

  test("P0-15 llama shows an unverified GGUF architecture as unknown, not compatible", async ({ page }) => {
    const { failures } = await openManagerPage(page, managers.llama.url, async () => {
      await page.route("**/api/models", (route) => route.fulfill({
        json: {
          local: [{
            id: "newarch-model",
            label: "newarch-model",
            path: "D:/models/newarch-model",
            launchModel: "D:/models/newarch-model/newarch.Q4_K_M.gguf",
            hasGguf: true,
            size: 4_000_000_000,
            ggufVariants: [{
              launchModel: "D:/models/newarch-model/newarch.Q4_K_M.gguf",
              name: "newarch.Q4_K_M.gguf",
              fileBytes: 4_000_000_000,
              architecture: "newarch",
              runtimeCompatibility: {
                status: "unknown",
                supported: null,
                message: "newarch 不在已验证的架构列表中，能否运行取决于当前 llama.cpp 版本。 / newarch is not in the verified architecture list. Whether it runs depends on the current llama.cpp build.",
              },
            }],
          }],
          cached: [],
        },
      }));
    });
    await openView(page, "models");
    const badge = page.locator("#modelList .runtime-compat").first();
    await expect(badge).toHaveText("未知（未验证）");
    await expect(badge).toHaveClass(/runtime-compat-warn/);
    await expect(page.locator("#modelList .runtime-compat-ok")).toHaveCount(0);
    expect(failures).toEqual([]);
  });
});
