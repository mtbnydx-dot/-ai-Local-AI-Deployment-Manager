// Shared harness for the console Playwright specs (07 §13.2, CON-5).
//
// Process helpers (moved here from frontend-smoke.spec.cjs):
//   getFreePort, waitForHttp, killProcessTree, startManager (the managers see one fixed GPU and a
//   temp models root with a stub smoke model, so pages and the launch plan do not vary by host;
//   fakeGpu: false keeps the host's nvidia-smi)
// Console helpers:
//   startEntry()                    service-entry on a free port, new console as the default UI
//   mockConsoleApi(page, overrides) routes /api/** and /gateway/** inside the browser; nothing
//                                   reaches a real service and every non-GET must carry x-csrf-token
//   openUiKit(page, baseUrl, opts)  mounts /system/ui-kit (routes/system/ui-kit.js mountUiKit)
//   expectNoA11yViolations          axe-core, see axe.js
//   expectNoOverflow, collectFailures, expectEmptyStorage, setPrefs
// Specs use ephemeral ports and never touch a running platform.
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { expect } = require("@playwright/test");
const axe = require("./axe.js");

const ROOT = path.resolve(__dirname, "..", "..", "..");
// Model folders the smoke profile launches (frontend-smoke.spec.cjs applies the RadixArk profile).
// The launch plan validates the local model folder (config, tokenizer, a weight file); these
// stub folders live in a temp models root, so the plan has no blocker and no real model
// library is read.
const SMOKE_MODEL_DIRS = ["RadixArk-Qwen3.8-Flash-Next-NVFP4"];
// A safetensors file is an 8-byte little-endian header length, then that many bytes of JSON.
const EMPTY_SAFETENSORS = Buffer.concat([Buffer.from([2, 0, 0, 0, 0, 0, 0, 0]), Buffer.from("{}")]);
const SMOKE_MODEL_FILES = { "params.json": "{}", "tokenizer.json": "{}", "model.safetensors": EMPTY_SAFETENSORS };
const FAKE_NVIDIA_SMI = path.join(__dirname, "fake-nvidia-smi.js").split(path.sep).join("/");
const UPSTREAM_PORT_ENV = ["VLLM_MANAGER_PORT", "LLAMA_MANAGER_PORT", "TTS_GATEWAY_PORT", "SEARCH_GATEWAY_PORT", "PLATFORM_MCP_PORT"];
const DEFAULT_SESSION = Object.freeze({ ok: true, role: "owner", paired: true, csrfToken: "t", pairCommand: "platform admin pair" });

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

async function startManager({ cwd, env, port, fakeGpu = true }) {
  const logs = [];
  const usesTempModels = !env.VLLM_MODELS_ROOT && !env.LLAMA_MODELS_ROOT && !process.env.VLLM_MODELS_ROOT && !process.env.LLAMA_MODELS_ROOT;
  const tempModelsRoot = usesTempModels ? await fs.mkdtemp(path.join(os.tmpdir(), "ai-smoke-models-")) : "";
  for (const name of tempModelsRoot ? SMOKE_MODEL_DIRS : []) {
    await fs.mkdir(path.join(tempModelsRoot, name), { recursive: true });
    for (const [file, text] of Object.entries(SMOKE_MODEL_FILES)) await fs.writeFile(path.join(tempModelsRoot, name, file), text);
  }
  const pidFile = env.LLAMA_MANAGER_PID_FILE || env.VLLM_MANAGER_PID_FILE || "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd,
    env: {
      ...process.env,
      ...(tempModelsRoot ? { VLLM_MODELS_ROOT: tempModelsRoot, LLAMA_MODELS_ROOT: tempModelsRoot } : {}),
      ...env,
      AI_FRONTEND_SMOKE: "1",
      NO_COLOR: "1",
      ...(fakeGpu ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${FAKE_NVIDIA_SMI}"`.trim() } : {}),
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
    if (tempModelsRoot) await fs.rm(tempModelsRoot, { recursive: true, force: true }).catch(() => {});
    throw new Error(`${error.message}\n${logs.join("").slice(-4000)}`);
  }
  return {
    url: `http://127.0.0.1:${port}/`,
    logs,
    stop: async () => {
      await killProcessTree(child);
      if (pidFile) await fs.rm(pidFile, { force: true }).catch(() => {});
      if (tempModelsRoot) await fs.rm(tempModelsRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * service-entry/server.js on a free loopback port with the new console as the
 * default UI. The upstream services (managers, TTS, search, MCP) get free ports
 * nothing listens on, so the shell boots without any other service.
 * @returns {{ url, port, logs, stop() }}
 */
async function startEntry({ env = {} } = {}) {
  const port = await getFreePort();
  const upstreams = {};
  for (const name of UPSTREAM_PORT_ENV) upstreams[name] = String(await getFreePort());
  const entry = await startManager({
    cwd: path.join(ROOT, "service-entry"),
    port,
    env: { ...upstreams, SERVICE_ENTRY_HOST: "127.0.0.1", SERVICE_ENTRY_PORT: String(port), SERVICE_ENTRY_CONSOLE_DEFAULT: "new", ...env },
  });
  return { ...entry, port };
}

function json(body, status = 200, headers = {}) {
  return { status, contentType: "application/json", headers, body: JSON.stringify(body) };
}

function sseBody(events = []) {
  // retry is long so a finished mock stream does not reconnect in a loop.
  const frames = events.map((event, index) => {
    const { id = index + 1, type = "message", ...rest } = event;
    const envelope = { type, at: new Date(0).toISOString(), source: "entry", data: {}, ...rest };
    return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`;
  });
  return `retry: 3600000\n: mock stream\n\n${frames.join("")}`;
}

function parseBody(request) {
  const text = request.postData();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Mocks the console's API inside the browser.
 *
 * `overrides` maps "METHOD /path" (or "/path" for any method) to a JSON value,
 * `{ status, body, headers }` (body is serialized) or a function
 * `(request, route) => value | undefined` (return undefined after calling
 * route.fulfill yourself). `/api/console/**` is passed through to the entry,
 * so the real bootstrap and snapshot still work. Defaults: `/api/session`
 * (owner, paired, csrfToken "t"), `/api/platform/setup` (setup finished), `/api/events` (an empty stream; `events:
 * false` gives 503 so the console falls back to polling; `events: [{ type,
 * data }]` replays frames with `id:` lines) and `/api/events/recent`.
 * Any other unmocked call answers 404 `not_mocked` and is listed in `unmocked`.
 *
 * @returns {{ calls, unmocked, csrfViolations, find(method, pathPrefix) }}
 */
async function mockConsoleApi(page, overrides = {}) {
  const { events = [], session = {}, recent = { events: [], lastId: 0, gap: false }, ...routes } = overrides;
  const sessionBody = { ...DEFAULT_SESSION, ...session };
  const handlers = {
    "GET /api/session": () => json(sessionBody),
    "GET /api/events": () => (events === false ? json({ ok: false, error: { code: "events_unavailable" } }, 503) : { status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: sseBody(events) }),
    "GET /api/events/recent": () => json({ ok: true, ...recent }),
    // Boot step 8 (first-run routing) reads this for an owner on a build with the setup backend; "done" keeps every other spec where it opened.
    "GET /api/platform/setup": () => json({ steps: [], completedAt: "2026-10-16T00:00:00.000Z", current: null }),
    ...routes,
  };
  const calls = [];
  const unmocked = [];
  const csrfViolations = [];

  await page.route((url) => /^\/(api|gateway)\//.test(url.pathname), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname.startsWith("/api/console/")) return route.fallback();
    const record = { method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers(), body: parseBody(request) };
    calls.push(record);
    if (method !== "GET" && method !== "HEAD" && record.headers["x-csrf-token"] !== sessionBody.csrfToken) {
      csrfViolations.push(`${method} ${url.pathname}`);
      return route.fulfill(json({ ok: false, error: { code: "csrf_invalid", message: "missing or wrong x-csrf-token" } }, 403));
    }
    const handler = handlers[`${method} ${url.pathname}`] ?? handlers[url.pathname];
    if (handler === undefined) {
      unmocked.push(`${method} ${url.pathname}`);
      return route.fulfill(json({ ok: false, error: { code: "not_mocked", message: `${method} ${url.pathname} is not mocked` } }, 404));
    }
    const answer = typeof handler === "function" ? await handler(request, route, record) : handler;
    if (answer === undefined) return undefined;
    if (answer && typeof answer === "object" && (answer.contentType || answer.status) && "body" in answer) {
      return route.fulfill({ ...answer, body: typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), contentType: answer.contentType || "application/json" });
    }
    return route.fulfill(json(answer));
  });

  return {
    calls,
    unmocked,
    csrfViolations,
    find: (method, pathPrefix) => calls.filter((call) => call.method === method && call.path.startsWith(pathPrefix)),
  };
}

/** Fails when the page scrolls horizontally (WCAG 1.4.10 reflow; 07 §8). */
async function expectNoOverflow(page, { tolerance = 1 } = {}) {
  const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(sizes.scroll, `page is ${sizes.scroll}px wide in a ${sizes.client}px viewport`).toBeLessThanOrEqual(sizes.client + tolerance);
}

/**
 * Collects page errors, console errors, CSP violations and 4xx/5xx answers for
 * documents, scripts and styles. Call before navigating.
 * @returns {{ failures: string[], expectNone() }}
 */
async function collectFailures(page) {
  const failures = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || /Content Security Policy/i.test(message.text())) failures.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (["document", "script", "stylesheet"].includes(type) && response.status() >= 400) failures.push(`${type} ${response.status()}: ${response.url()}`);
  });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return {
    failures,
    async expectNone() {
      const csp = await page.evaluate(() => window.__cspViolations || []).catch(() => []);
      expect([...failures, ...csp.map((item) => `csp: ${item}`)], "frontend failures").toEqual([]);
    },
  };
}

/** Both web storages (and, with `cookies`, document.cookie) are empty. */
async function expectEmptyStorage(page, { cookies = false } = {}) {
  const state = await page.evaluate(() => ({ local: Object.keys(window.localStorage), session: Object.keys(window.sessionStorage), cookie: document.cookie }));
  expect(state.local, "localStorage").toEqual([]);
  expect(state.session, "sessionStorage").toEqual([]);
  if (cookies) expect(state.cookie, "document.cookie").toBe("");
}

/**
 * Sets console preferences before the page loads: the `console_prefs` cookie
 * the server reads to inject lang, data-theme and data-density (07 C6) when
 * `baseUrl` is given, and `console.prefs.v1` in localStorage (an init script)
 * when `storage` is true. `storage` defaults to false with a baseUrl so that
 * specs asserting empty storage stay possible.
 * @param prefs { theme: "light"|"dark"|"auto", locale: "zh-CN"|"en-US"|"auto", density: "comfortable"|"compact" }
 */
async function setPrefs(context, prefs = {}, { baseUrl, storage = !baseUrl } = {}) {
  if (storage) {
    await context.addInitScript((value) => {
      try {
        window.localStorage.setItem("console.prefs.v1", JSON.stringify(value));
      } catch {
        // Storage may be blocked; the cookie still carries the theme.
      }
    }, prefs);
  }
  const cookie = ["locale", "theme", "density"].filter((name) => prefs[name]).map((name) => `${name}:${prefs[name]}`).join("|");
  if (baseUrl && cookie) await context.addCookies([{ name: "console_prefs", value: cookie, url: baseUrl }]);
}

/**
 * Opens /system/ui-kit on its own: app.js is replaced by a stub that only clears
 * `aria-busy` (the shell would otherwise render the page inside its own chrome
 * and call the status APIs), then routes/system/ui-kit.js is imported from the
 * build snapshot and mounted into #app with the catalog of `locale`. Resolves
 * once every section is mounted. The shell hosting the kit is covered by
 * console-shell.spec.js.
 */
async function openUiKit(page, baseUrl, { locale = "en-US", search = "" } = {}) {
  await page.route(/\/c\/[^/]+\/app\.js$/, (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: "document.getElementById('app')?.removeAttribute('aria-busy');\n",
  }));
  await page.goto(`${baseUrl}system/ui-kit${search}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("aria-busy", /.+/);
  const buildId = await page.locator('meta[name="console-build"]').getAttribute("content");
  await page.evaluate(async ({ id, lang }) => {
    const response = await fetch(`/c/${id}/i18n/${lang}.json`);
    const catalog = await response.json();
    const module = await import(`/c/${id}/routes/system/ui-kit.js`);
    module.mountUiKit(document.getElementById("app"), { catalog, locale: lang });
  }, { id: buildId, lang: locale });
  // The sections load on demand; the kit marks itself ready when all are mounted.
  await expect(page.locator('#main [data-ready="true"]')).toBeVisible();
  await expect(page.locator("#main h1")).toBeVisible();
  return buildId;
}

module.exports = {
  ROOT,
  DEFAULT_SESSION,
  collectFailures,
  expectEmptyStorage,
  expectNoA11yViolations: axe.expectNoA11yViolations,
  expectNoOverflow,
  getFreePort,
  killProcessTree,
  mockConsoleApi,
  openUiKit,
  setPrefs,
  startEntry,
  startManager,
  waitForHttp,
};
