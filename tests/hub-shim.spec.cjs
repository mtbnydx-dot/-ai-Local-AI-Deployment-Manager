// Browser checks for the hub-mode legacy pages (docs/overhaul/03-hub.md §15,
// §20, HUB-13b). The manager pages keep working through the shims, so what
// matters here is that they render what a shim answers: the 422
// filter_no_match error with its suggestions, a hub job's failure card from
// meta.errorHint, and the phase label in progress.stage. The answers are the
// shim's own mappers applied to the hub fixtures, stubbed at the browser
// boundary; the managers run in frontend-smoke mode, so nothing here reaches
// a live manager, the entry or the network.
const { test, expect } = require("@playwright/test");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const compat = require(path.join(ROOT, "manager-core", "model-hub", "compat.js"));
const HUB_JOBS = require(path.join(ROOT, "manager-core", "test", "fixtures", "hub", "hub-jobs.json")).jobs;

const MODEL = "example-org/Example-8B-GGUF";
const MANAGERS = [
  { label: "vLLM", dir: "vllm-manager", portEnv: "VLLM_MANAGER_PORT", hostEnv: "VLLM_MANAGER_HOST", pidEnv: "VLLM_MANAGER_PID_FILE" },
  { label: "llama", dir: "llama-manager", portEnv: "LLAMA_MANAGER_PORT", hostEnv: "LLAMA_MANAGER_HOST", pidEnv: "LLAMA_MANAGER_PID_FILE" },
];

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

// The same harness as tests/p0-ui.spec.cjs: the worktree manager on a free port,
// in frontend-smoke mode (no shim, no entry call).
async function startManager({ cwd, env, port }) {
  const logs = [];
  const pidFile = env.LLAMA_MANAGER_PID_FILE || env.VLLM_MANAGER_PID_FILE || "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd,
    env: { ...process.env, ...env, AI_FRONTEND_SMOKE: "1", NO_COLOR: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, 25_000);
  } catch (error) {
    await killProcessTree(child);
    throw new Error(`${error.message}\n${logs.join("").slice(-4000)}`);
  }
  return {
    url: `http://127.0.0.1:${port}/`,
    stop: async () => {
      await killProcessTree(child);
      if (pidFile) await fs.rm(pidFile, { force: true }).catch(() => {});
    },
  };
}

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
        [manager.pidEnv]: path.join(ROOT, "test-results", `.hub-shim-${manager.dir}-${port}.pid`),
      },
    });
  }
  return started;
}

// What a manager reports with no container and no Docker engine (the real
// /api/status shells out to the Docker CLI).
function managerStatusPayload() {
  const docker = "Docker Desktop 引擎未就绪。请先用页面的一键 Docker 按钮启动 Docker Desktop，等状态变为可用后再启动模型。";
  return {
    docker: { ok: false, cliOk: true, daemonOk: false, text: docker, daemonError: "stub" },
    gpu: { ok: true, count: 1, name: "Stub GPU", totalMb: 97887, usedMb: 4096, util: 10, temp: 40, gpus: [{ index: 0, id: "0", name: "Stub GPU", computeCap: "12.0", totalMb: 97887, usedMb: 4096, util: 10, temp: 40 }] },
    resources: { gpuMemory: { totalMb: 97887, usedMb: 4096, freeMb: 93791, source: "stub", note: "" }, managedContainers: [], peerManagers: [], peerRunningCount: 0, hasPeerRunning: false },
    container: { exists: false, running: false },
    servedModels: [],
    runningModels: [],
    endpoint: { port: 8000, boundHost: "127.0.0.1", localHost: "127.0.0.1", lanHost: null, publishedHosts: [], host: "127.0.0.1", serviceUrl: "http://127.0.0.1:8000/v1", localUrl: "http://127.0.0.1:8000/v1", lanUrl: null },
    image: { ok: false, text: docker, reason: "docker-daemon", raw: "stub" },
    jobs: [],
    apiKeyRequired: false,
  };
}

function statsPayload() {
  const totals = {
    tokens: { prompt: 0, generation: 0, cachedPrompt: 0, total: 0 },
    requests: { total: 0, success: 0, error: 0, aborted: 0 },
    speed: {},
    latency: {},
    context: { activeTokens: 0, capacityTokens: 0, kvUsagePercent: 0 },
  };
  return { ok: true, updatedAt: "2026-10-14T00:30:00.000Z", uptimeSeconds: 1, source: "stub", totals, live: { totals, models: [], uptimeSeconds: 1 }, historical: { models: [] }, models: [], facts: {}, gpu: { ok: false }, costComparison: [], clientUsage: { clients: [] }, recentAccess: { sources: [] }, trends: { hours: 24, samples: [] } };
}

// A manager page whose API is stubbed at the browser boundary: reads fall
// through to the frontend-smoke manager, every write is answered here.
async function openManagerPage(page, baseUrl, setup = async () => {}) {
  const failures = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (["GET", "HEAD"].includes(request.method())) {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("https://unpkg.com/**/lucide*.js", (route) => route.fulfill({ contentType: "application/javascript", body: "window.lucide={createIcons(){}};" }));
  await page.route("**/api/models", (route) => route.fulfill({ json: { local: [], cached: [] } }));
  await page.route("**/api/remote-models?*", (route) => route.fulfill({ json: { models: [], limit: 48, source: "huggingface", sort: "trending" } }));
  await page.route("**/api/remote-models/*-variants?*", (route) => route.fulfill({ json: { variants: [] } }));
  await page.route("**/api/download/estimate?*", (route) => route.fulfill({ json: { bytes: 1024, fileCount: 1, diskFreeBytes: 100 * 1024 ** 3 } }));
  await page.route("**/api/download/precheck?*", (route) => route.fulfill({ json: { ok: true, findings: [] } }));
  await page.route("**/api/stats", (route) => route.fulfill({ json: statsPayload() }));
  await page.route("**/api/status", (route) => route.fulfill({ json: managerStatusPayload() }));
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "retry: 600000\n\n" }));
  await setup();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-shell")).toBeVisible();
  return { failures };
}

async function openView(page, view) {
  await page.locator(`[data-view='${view}']`).first().click();
  await expect(page.locator(`[data-view-panel='${view}']`).first()).toBeVisible();
}

const HAN = /\p{Script=Han}/u;

test.describe.configure({ mode: "serial" });

test.describe("hub-mode legacy pages", () => {
  // The consoles follow the browser language unless one is picked: assert the
  // zh source copy first and switch to English explicitly where it is checked.
  test.use({ locale: "zh-CN" });
  let managers = {};

  test.beforeAll(async () => {
    managers = await startManagers();
  });

  test.afterAll(async () => {
    await Promise.all(Object.values(managers).map((manager) => manager.stop()));
  });

  for (const label of ["llama", "vLLM"]) {
    test(`${label} shows the filter_no_match suggestions the shim sends with its 422`, async ({ page }) => {
      // The shim's own mapping of the hub's error, so the page sees the real shape.
      const shimAnswer = compat.toLegacyDownloadError(422, {
        ok: false,
        error: {
          code: "filter_no_match",
          message: "No file matches.",
          details: { suggestions: [{ artifactKey: "gguf:|Q4_K_M", label: "Q4_K_M", quant: "Q4_K_M", bytes: 5027783488 }, { artifactKey: "gguf:|Q8_0", label: "Q8_0", quant: "Q8_0", bytes: 8709518528 }] },
        },
      }, { precision: "Q9_X", totalFiles: 10 });
      expect(shimAnswer.status).toBe(422);
      const posts = [];
      const { failures } = await openManagerPage(page, managers[label].url, async () => {
        await page.route("**/api/download", async (route) => {
          if (route.request().method() !== "POST") {
            await route.fallback();
            return;
          }
          posts.push(route.request().postDataJSON());
          await route.fulfill({ status: shimAnswer.status, json: shimAnswer.body });
        });
        await page.route("**/api/jobs?*", (route) => route.fulfill({ json: [] }));
      });
      await openView(page, "download");
      await page.locator("#downloadModel").fill(MODEL);
      await page.locator("#downloadForm button[type='submit']").click();
      const toast = page.locator("#toastRoot");
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0].model).toBe(MODEL);
      await expect(toast).toContainText("下载任务创建失败");
      await expect(toast).toContainText("Q4_K_M 4.7 GB");
      await expect(toast).toContainText("Q8_0 8.1 GB");

      await page.locator("#languageMode").selectOption("en-US");
      await page.locator("#toastRoot .toast-close").first().click().catch(() => {});
      await page.locator("#downloadForm button[type='submit']").click();
      await expect.poll(() => posts.length).toBe(2);
      await expect(toast).toContainText("Q4_K_M 4.7 GB");
      await expect(toast).toContainText("Q8_0 8.1 GB");
      await page.locator("#languageMode").selectOption("zh-CN");
      expect(failures).toEqual([]);
    });

    test(`${label} renders a hub job's failure card and phase label, in English without Han text and at 390 px without overflow`, async ({ page }) => {
      const jobs = HUB_JOBS.map((job) => compat.toLegacyJob(job, { summary: true }));
      const verifying = compat.toLegacyJob({ ...HUB_JOBS[0], id: "dl_verifyingjob0001", state: "verifying", progress: { ...HUB_JOBS[0].progress, verify: { filesDone: 2, filesTotal: 5 } } }, { summary: true });
      jobs.push(verifying);
      const failed = jobs.find((job) => job.status === "failed");
      expect(failed.meta.errorCode).toBe("hf_login_required");
      expect(failed.progress.stage).toMatchObject({ id: "failed" });
      const { failures } = await openManagerPage(page, managers[label].url, async () => {
        await page.route("**/api/jobs?*", (route) => route.fulfill({ json: jobs }));
      });
      await openView(page, "download");

      const card = page.locator("#jobList [data-download-error='hf_login_required']");
      await expect(card).toBeVisible();
      await expect(card).toContainText(failed.meta.errorHint.zh);
      const failedRow = page.locator("#jobList .job-row").filter({ has: page.locator("[data-download-error='hf_login_required']") });
      await expect(failedRow).toContainText("失败");
      const verifyingRow = page.locator("#jobList .job-row").filter({ hasText: "正在校验（2/5 个文件）" });
      await expect(verifyingRow).toHaveCount(1);

      // English mode: the card and the phase labels pick their English half.
      await page.locator("#languageMode").selectOption("en-US");
      await expect(card).toContainText(failed.meta.errorHint.en);
      await expect(page.locator("#jobList .job-row").filter({ hasText: "Verifying (2/5 files)" })).toHaveCount(1);
      await expect(failedRow).toContainText("Failed");
      // What the hub's data brings to the page has no Han text in English: the
      // failure card, the job titles and the phase labels (the legacy page's own
      // untranslated strings, like the pause button, are not the shim's).
      expect(await card.innerText(), "the failure card in English").not.toMatch(HAN);
      for (const title of await page.locator("#jobList h4").allInnerTexts()) expect(title).not.toMatch(HAN);
      const meta = (await page.locator("#jobList .download-progress-meta small").allInnerTexts()).join(" | ");
      expect(meta).toContain("Downloading");
      expect(meta).toContain("Verifying (2/5 files)");
      expect(meta).not.toMatch(/下载中|正在校验|排队中|已就绪/);

      // A phone keeps the card readable: no horizontal overflow.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(card).toBeVisible();
      // The job rows (card, phase label, progress line) stay inside the phone width.
      // The download form above them has its own layout, which this spec does not judge.
      const overflow = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth + 1;
        const list = document.querySelector("#jobList");
        return {
          list: list.scrollWidth - list.clientWidth,
          wide: Array.from(list.querySelectorAll("*"))
            .filter((node) => node.getBoundingClientRect().right > limit && node.getBoundingClientRect().width > 0)
            .map((node) => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)} ${Math.round(node.getBoundingClientRect().right)}`),
        };
      });
      expect(overflow.wide, `${label} job rows fit a phone`).toEqual([]);
      expect(overflow.list).toBeLessThanOrEqual(1);
      const cardBox = await card.boundingBox();
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(390 + 1);
      await page.locator("#languageMode").selectOption("zh-CN");
      expect(failures).toEqual([]);
    });
  }
});
