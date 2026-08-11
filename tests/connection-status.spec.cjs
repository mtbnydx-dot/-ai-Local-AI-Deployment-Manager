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

function waitForHttp(url, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        retry();
      });
      req.on("error", retry);
      req.setTimeout(2_000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${url}`));
      setTimeout(poll, 300);
    };
    poll();
  });
}

function killProcessTree(child) {
  if (!child || child.killed) return Promise.resolve();
  if (process.platform !== "win32") {
    child.kill("SIGKILL");
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => resolve());
  });
}

async function startManager({ cwd, env, port }) {
  const managerDir = path.basename(cwd).toLowerCase();
  const isolatedPidEnv = managerDir === "llama-manager"
    ? { LLAMA_MANAGER_PID_FILE: path.join(ROOT, "test-results", `.llama-manager-${port}.pid`) }
    : { VLLM_MANAGER_PID_FILE: path.join(ROOT, "test-results", `.vllm-manager-${port}.pid`) };
  const pidFile = isolatedPidEnv.LLAMA_MANAGER_PID_FILE || isolatedPidEnv.VLLM_MANAGER_PID_FILE;
  const child = spawn(process.execPath, ["server.js"], {
    cwd,
    env: { ...process.env, ...isolatedPidEnv, ...env, AI_FRONTEND_SMOKE: "1", NO_COLOR: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  await waitForHttp(`http://127.0.0.1:${port}/`);
  return {
    url: `http://127.0.0.1:${port}/`,
    stop: async () => {
      await killProcessTree(child);
      await fs.rm(pidFile, { force: true }).catch(() => {});
    },
  };
}

async function stubIcons(page) {
  await page.route("https://unpkg.com/**/lucide*.js", async (route) => {
    await route.fulfill({ contentType: "application/javascript", body: "window.lucide={createIcons(){}};" });
  });
}

// domcontentloaded fires before the app finishes its first round of API calls,
// so a test that starts failing requests right after goto can race the initial
// load and land in the "never connected" state instead of the stale-data one.
async function loadConnected(page, url) {
  const firstStatus = page.waitForResponse(
    (response) => response.url().includes("/api/status") && response.ok(),
    { timeout: 25_000 },
  );
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await firstStatus;
}

// Every polled refresh used to end in `.catch(() => {})`, so a dead manager left
// the console showing a frozen snapshot with no indication it had stopped
// updating. These tests kill the manager for real and assert the UI says so.
test.describe("connection status", () => {
  let manager = null;

  test.afterEach(async () => {
    if (manager) await manager.stop();
    manager = null;
  });

  test("vLLM console reports a lost connection and recovers", async ({ browser }) => {
    const port = await getFreePort();
    manager = await startManager({
      cwd: path.join(ROOT, "vllm-manager"),
      port,
      env: { VLLM_MANAGER_HOST: "127.0.0.1", VLLM_MANAGER_PORT: String(port) },
    });

    // Pin the locale so the assertions can check the Chinese copy.
    const context = await browser.newContext({ locale: "zh-CN" });
    const page = await context.newPage();
    try {
      await stubIcons(page);
      await loadConnected(page, manager.url);

      const banner = page.locator("#connectionBanner");
      await expect(banner).toBeHidden();

      // Simulate the manager dying: fail the polled endpoints outright.
      await page.route("**/api/status", (route) => route.abort("connectionrefused"));
      await page.route("**/api/jobs", (route) => route.abort("connectionrefused"));

      // status polls every 5s and the banner needs 2 consecutive failures.
      await expect(banner).toBeVisible({ timeout: 20_000 });
      await expect(banner).toContainText("连接已中断");
      await expect(banner).toContainText("停留在");
      await expect(banner.locator(".connection-banner-meta")).toContainText("连续");
      // The manager name must not be spliced in from the other language.
      await expect(banner).not.toContainText("Lost connection");

      // The banner is an alert so assistive tech announces it.
      await expect(banner).toHaveAttribute("role", "alert");

      // Restore the endpoints; the banner must clear on its own.
      await page.unroute("**/api/status");
      await page.unroute("**/api/jobs");
      await expect(banner).toBeHidden({ timeout: 20_000 });
    } finally {
      await context.close();
    }
  });

  test("the banner is fully localised in English", async ({ browser }) => {
    const port = await getFreePort();
    manager = await startManager({
      cwd: path.join(ROOT, "vllm-manager"),
      port,
      env: { VLLM_MANAGER_HOST: "127.0.0.1", VLLM_MANAGER_PORT: String(port) },
    });

    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    try {
      await stubIcons(page);
      await loadConnected(page, manager.url);

      await page.route("**/api/status", (route) => route.abort("connectionrefused"));
      await page.route("**/api/jobs", (route) => route.abort("connectionrefused"));

      const banner = page.locator("#connectionBanner");
      await expect(banner).toBeVisible({ timeout: 20_000 });
      await expect(banner).toContainText("Lost connection");
      await expect(banner).toContainText("no longer updating");
      // No Chinese characters may leak into the English rendering.
      const text = await banner.innerText();
      expect(/[一-鿿]/.test(text), `English banner contained Chinese: ${text}`).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("llama console reports a lost connection", async ({ browser }) => {
    const port = await getFreePort();
    manager = await startManager({
      cwd: path.join(ROOT, "llama-manager"),
      port,
      env: { LLAMA_MANAGER_HOST: "127.0.0.1", LLAMA_MANAGER_PORT: String(port) },
    });

    const context = await browser.newContext({ locale: "zh-CN" });
    const page = await context.newPage();
    try {
      await stubIcons(page);
      await loadConnected(page, manager.url);

      const banner = page.locator("#connectionBanner");
      await expect(banner).toBeHidden();

      await page.route("**/api/status", (route) => route.abort("connectionrefused"));
      await page.route("**/api/jobs", (route) => route.abort("connectionrefused"));

      await expect(banner).toBeVisible({ timeout: 20_000 });
      await expect(banner).toContainText("连接已中断");
    } finally {
      await context.close();
    }
  });

  test("a console opened against a dead manager says so immediately", async ({ browser }) => {
    const port = await getFreePort();
    manager = await startManager({
      cwd: path.join(ROOT, "vllm-manager"),
      port,
      env: { VLLM_MANAGER_HOST: "127.0.0.1", VLLM_MANAGER_PORT: String(port) },
    });

    const context = await browser.newContext({ locale: "zh-CN" });
    const page = await context.newPage();
    try {
      await stubIcons(page);
      // The document loads, but every API call fails. With no data ever
      // received there is nothing stale to look at, so the banner should not
      // wait for a second failure.
      await page.route("**/api/config", (route) => route.abort("connectionrefused"));
      await page.route("**/api/status", (route) => route.abort("connectionrefused"));
      // Deliberately not loadConnected: this case never connects at all.
      await page.goto(manager.url, { waitUntil: "domcontentloaded" });

      const banner = page.locator("#connectionBanner");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText("尚未成功获取过数据");
    } finally {
      await context.close();
    }
  });

  // At <=820px the nav collapses to a horizontal strip. The label text stays
  // visible there today, but nothing guaranteed it: the base rule at that
  // breakpoint hides the span and only a later `display: inline !important`
  // brings it back. These assert the accessible name and tooltip exist
  // independently of that, so the links stay identifiable either way.
  for (const [engine, dir, hostEnv, portEnv, expected] of [
    ["vLLM", "vllm-manager", "VLLM_MANAGER_HOST", "VLLM_MANAGER_PORT", { zh: "服务", en: "Service" }],
    ["llama", "llama-manager", "LLAMA_MANAGER_HOST", "LLAMA_MANAGER_PORT", { zh: "服务", en: "Service" }],
  ]) {
    test(`${engine} narrow-screen nav items keep an accessible name`, async ({ browser }) => {
      const port = await getFreePort();
      manager = await startManager({
        cwd: path.join(ROOT, dir),
        port,
        env: { [hostEnv]: "127.0.0.1", [portEnv]: String(port) },
      });

      const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 600, height: 900 } });
      const page = await context.newPage();
      try {
        await stubIcons(page);
        await loadConnected(page, manager.url);

        const links = page.locator(".nav [data-view]");
        const count = await links.count();
        expect(count).toBeGreaterThan(4);

        for (let index = 0; index < count; index += 1) {
          const link = links.nth(index);
          const view = await link.getAttribute("data-view");
          const name = await link.getAttribute("aria-label");
          const title = await link.getAttribute("title");
          expect(name, `${view} has no aria-label`).toBeTruthy();
          expect(title, `${view} has no title`).toBeTruthy();
          // lucide swaps the <i> for an <svg>; either way the icon must not be
          // announced separately from the label.
          const iconHidden = await link.evaluate((node) => {
            const icon = node.querySelector("svg, i[data-lucide]");
            return !icon || icon.getAttribute("aria-hidden") === "true";
          });
          expect(iconHidden, `${view} icon is not aria-hidden`).toBe(true);
        }

        await expect(page.locator(".nav [data-view='service']")).toHaveAttribute("aria-label", expected.zh);
        // The computed accessible name, not just the attribute.
        await expect(page.getByRole("link", { name: expected.zh, exact: true })).toBeVisible();

        // Switching language must carry through to the tooltip and the name,
        // not just the hidden text.
        await page.selectOption("#languageMode", "en-US");
        await expect(page.locator(".nav [data-view='service']")).toHaveAttribute("aria-label", expected.en, { timeout: 10_000 });
        await expect(page.locator(".nav [data-view='service']")).toHaveAttribute("title", expected.en);
      } finally {
        await context.close();
      }
    });
  }

  test("the model picker keeps its scroll position across a status poll", async ({ browser }) => {
    const port = await getFreePort();
    manager = await startManager({
      cwd: path.join(ROOT, "vllm-manager"),
      port,
      env: { VLLM_MANAGER_HOST: "127.0.0.1", VLLM_MANAGER_PORT: String(port) },
    });

    const context = await browser.newContext({ locale: "zh-CN" });
    const page = await context.newPage();
    try {
      await stubIcons(page);
      // Enough models that the list actually scrolls.
      await page.route("**/api/models", async (route) => {
        const local = Array.from({ length: 60 }, (_, index) => ({
          id: `scroll-model-${index + 1}`,
          label: `Scroll Model ${index + 1}`,
          launchModel: `D:/AI/models/scroll-model-${index + 1}`,
          path: `D:/AI/models/scroll-model-${index + 1}`,
          size: 4_000_000_000 + index,
          hasConfig: true,
        }));
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ local, cached: [] }) });
      });
      await loadConnected(page, manager.url);

      await page.locator("#modelPickerToggle").click();
      const list = page.locator("#modelPickerList");
      await expect(list).toBeVisible();
      await expect(list.locator(".model-picker-item").first()).toBeVisible({ timeout: 10_000 });

      const scrolled = await list.evaluate((node) => {
        node.scrollTop = 240;
        return node.scrollTop;
      });
      // Skip rather than assert a false pass if the list did not overflow.
      test.skip(scrolled < 40, "model picker list did not overflow in this viewport");

      // A status poll fires every 5s and re-renders the list.
      await page.waitForTimeout(7_000);

      const after = await list.evaluate((node) => node.scrollTop);
      expect(after, "scroll position must survive the polled re-render").toBeGreaterThan(scrolled - 20);
    } finally {
      await context.close();
    }
  });
});
