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
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator("[data-view-panel='service']").first()).toBeVisible();
  for (const view of ["download", "external-access", "stats"]) {
    await page.locator(`[data-view='${view}']`).click();
    await expect(page.locator(`[data-view-panel='${view}']`).first()).toBeVisible();
  }
  await page.waitForTimeout(500);
  expect(failures, `${label} frontend errors`).toEqual([]);
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
});
