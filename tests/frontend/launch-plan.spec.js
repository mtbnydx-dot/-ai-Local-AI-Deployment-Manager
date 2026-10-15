// ENG-21 browser checks (docs/overhaul/01-engines.md section 25): the launch
// review dialog of the two legacy manager UIs asks POST /api/launch/plan before
// the start and shows the steps, the command, the overrides and the memory
// verdict. Each page is served by the worktree's own manager on a free
// loopback port; /api/launch/plan, /api/start and the pull route are stubbed at
// the browser boundary, so nothing reaches a live manager, Docker or the internet.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { getFreePort, startManager } = require("./helpers/console-harness.js");

const ROOT = path.resolve(__dirname, "..", "..");
const MANAGERS = [
  { label: "vLLM", dir: "vllm-manager", portEnv: "VLLM_MANAGER_PORT", hostEnv: "VLLM_MANAGER_HOST", pidEnv: "VLLM_MANAGER_PID_FILE", apiKey: "#vllmApiKey" },
  { label: "llama", dir: "llama-manager", portEnv: "LLAMA_MANAGER_PORT", hostEnv: "LLAMA_MANAGER_HOST", pidEnv: "LLAMA_MANAGER_PID_FILE", apiKey: "#llamaApiKey" },
];

let tmpDir;
let managers;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eng21-ui-"));
  managers = {};
  for (const manager of MANAGERS) {
    const port = await getFreePort();
    managers[manager.label] = await startManager({
      cwd: path.join(ROOT, manager.dir),
      port,
      env: {
        [manager.hostEnv]: "127.0.0.1",
        [manager.portEnv]: String(port),
        [manager.pidEnv]: path.join(tmpDir, `${manager.dir}-${port}.pid`),
      },
    });
  }
});

test.afterAll(async () => {
  for (const manager of Object.values(managers || {})) await manager.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A LaunchPlan as 01 section 10 describes it (00 section 4.3 + 9.2), fake values only.
function planFixture(overrides = {}) {
  return {
    ok: true,
    engineId: "vllm",
    prospective: false,
    catalogVersion: "test",
    planHash: "sha256:aaaa",
    steps: [
      { kind: "pull", runtimeId: "vllm-default", image: "example/runtime:1", required: false, policy: "auto" },
      { kind: "replace", containerName: "old-container", model: "old-model" },
      { kind: "start", containerName: "new-container", port: 18080, gpuIds: [0] },
    ],
    blockers: [],
    errors: [],
    warnings: [],
    overrides: [{ param: "max-num-seqs", from: 64, to: 8, source: "recipe", reason: { zh: "配方限制并发", en: "the recipe caps concurrency" } }],
    command: { argv: ["docker", "run", "--name", "new-container", "example/runtime:1", "--api-key", "<redacted>"], env: { EXAMPLE_ENV: "x" }, labels: {} },
    memory: { perGpuMb: { 0: 12345 }, admissionRequestMb: 12345 },
    admission: { verdict: "allow", message: "ok" },
    ...overrides,
  };
}

const PULL_BLOCKER = {
  code: "image_pull_required",
  message: { zh: "运行时镜像尚未下载。", en: "The runtime image is not downloaded." },
  action: { label: { zh: "拉取镜像", en: "Pull image" }, apiCall: { method: "POST", path: "/api/runtimes/vllm-default/pull", body: { confirm: true } } },
};

// Opens a manager page with the launch API stubbed. `state.plan` is what the
// plan route answers; `state.startAnswers` is consumed one per /api/start.
async function openLaunchPage(page, manager, state) {
  const failures = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  state.planRequests = [];
  state.starts = [];
  state.pulls = [];
  await page.route("**/api/**", async (route) => {
    if (["GET", "HEAD"].includes(route.request().method())) {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("https://unpkg.com/**/lucide*.js", (route) => route.fulfill({ contentType: "application/javascript", body: "window.lucide={createIcons(){}};" }));
  await page.route("**/api/remote-models?*", (route) => route.fulfill({ json: { models: [], limit: 48, source: "huggingface", sort: "trending" } }));
  await page.route("**/api/remote-models/*-variants?*", (route) => route.fulfill({ json: { variants: [] } }));
  await page.route("**/api/download/estimate?*", (route) => route.fulfill({ json: { bytes: 1024, fileCount: 1, diskFreeBytes: 100 * 1024 ** 3 } }));
  await page.route("**/api/download/precheck?*", (route) => route.fulfill({ json: { ok: true, findings: [] } }));
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "retry: 600000\n\n" }));
  await page.route("**/api/models", (route) => route.fulfill({
    json: {
      local: [{
        id: "plan-model",
        label: "Plan Model",
        launchModel: "/models/plan-model",
        path: "/models/plan-model",
        size: 4_000_000_000,
        hasConfig: manager.label === "vLLM",
        hasGguf: manager.label !== "vLLM",
        ggufFiles: manager.label !== "vLLM" ? [{ name: "plan.Q4_K_M.gguf" }] : [],
      }],
      cached: [],
    },
  }));
  await page.route("**/api/launch/plan", async (route) => {
    state.planRequests.push(route.request().postDataJSON());
    if (state.planStatus && state.planStatus !== 200) {
      await route.fulfill({ status: state.planStatus, json: { error: "unavailable" } });
      return;
    }
    await route.fulfill({ json: state.plan });
  });
  await page.route("**/api/start", async (route) => {
    state.starts.push(route.request().postDataJSON());
    const answer = (state.startAnswers || []).shift() || { status: 200, json: { ok: true } };
    await route.fulfill(answer);
  });
  await page.route("**/api/runtimes/*/pull", async (route) => {
    state.pulls.push({ url: route.request().url(), body: route.request().postDataJSON() });
    await route.fulfill({ json: { ok: true, job: { id: "dl_test" } } });
  });
  const modelsLoaded = page.waitForResponse((response) => response.url().endsWith("/api/models"));
  await page.goto(managers[manager.label].url, { waitUntil: "domcontentloaded" });
  await modelsLoaded;
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator("#startModel")).not.toHaveValue("");
  return { failures };
}

// Submits the launch form the way the page does, without walking the stages.
async function submitLaunch(page, manager) {
  // The network fields live on a stage that is not on screen; set them directly.
  await page.evaluate((apiKeySelector) => {
    const network = document.querySelector("#networkAccess");
    network.value = "lan";
    network.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector(apiKeySelector).value = "";
    const form = document.querySelector("#startForm");
    form.requestSubmit(form.querySelector("button[type='submit']"));
  }, manager.apiKey);
}

for (const manager of MANAGERS) {
  test.describe(`ENG-21 launch-plan review (${manager.label})`, () => {
    test("shows steps, command, overrides and the memory verdict, then starts with the reviewed hash", async ({ page }) => {
      const state = { plan: planFixture() };
      const { failures } = await openLaunchPage(page, manager, state);
      await page.locator("#languageMode").selectOption("zh-CN");
      await submitLaunch(page, manager);

      const dialog = page.locator("#launchConfirmDialog");
      await expect(dialog).toBeVisible();
      const review = dialog.locator("[data-launch-plan]");
      await expect(review.locator("[data-launch-plan-step]")).toHaveCount(3);
      await expect(review.locator("[data-launch-plan-step='pull']")).toContainText("镜像已就绪");
      await expect(review.locator("[data-launch-plan-step='replace']")).toContainText("old-container");
      await expect(review.locator("[data-launch-plan-step='start']")).toContainText("18080");
      await expect(review.locator("[data-launch-plan-override]")).toContainText("max-num-seqs");
      await expect(review.locator("[data-launch-plan-override]")).toContainText("配方限制并发");
      await expect(review.locator("[data-launch-plan-memory='allow']")).toContainText("显存预检");
      await review.locator("summary").click();
      await expect(review.locator("[data-launch-plan-command]")).toContainText("docker run --name new-container");
      await expect(review.locator("[data-launch-plan-command]")).toContainText("<redacted>");
      await expect(page.locator("#launchConfirmSubmit")).toBeEnabled();
      expect(state.planRequests).toHaveLength(1);

      await page.locator("#launchConfirmSubmit").click();
      await expect.poll(() => state.starts.length).toBe(1);
      expect(state.starts[0].expectedPlanHash).toBe("sha256:aaaa");
      expect(failures).toEqual([]);
    });

    test("a blocker or a block verdict disables the confirm button", async ({ page }) => {
      const state = { plan: planFixture({ ok: false, blockers: [{ code: "recipe_blocked", message: { zh: "配方禁止此组合", en: "The recipe blocks this combination" } }] }) };
      await openLaunchPage(page, manager, state);
      await page.locator("#languageMode").selectOption("zh-CN");
      await submitLaunch(page, manager);
      await expect(page.locator("#launchConfirmDialog")).toBeVisible();
      await expect(page.locator("[data-launch-plan-blocker='recipe_blocked']")).toContainText("配方禁止此组合");
      await expect(page.locator("#launchConfirmSubmit")).toBeDisabled();
      await page.locator("#launchConfirmDialog button[value='cancel']").last().click();
      await expect(page.locator("#launchConfirmDialog")).not.toBeVisible();
      expect(state.starts).toHaveLength(0);

      // A block verdict alone (no blocker entry) also blocks, and a later
      // clean plan re-enables the button: the disabled state never sticks.
      state.plan = planFixture({ admission: { verdict: "block", message: "not enough VRAM" } });
      await submitLaunch(page, manager);
      await expect(page.locator("[data-launch-plan-memory='block']")).toBeVisible();
      await expect(page.locator("#launchConfirmSubmit")).toBeDisabled();
      await page.locator("#launchConfirmDialog button[value='cancel']").last().click();

      state.plan = planFixture();
      await submitLaunch(page, manager);
      await expect(page.locator("#launchConfirmSubmit")).toBeEnabled();
      await page.locator("#launchConfirmDialog button[value='cancel']").last().click();
      expect(state.starts).toHaveLength(0);
    });

    test("image_pull_required shows the pull action, which pulls only after the click", async ({ page }) => {
      const state = { plan: planFixture({ ok: false, blockers: [PULL_BLOCKER], steps: [{ kind: "pull", runtimeId: "vllm-default", image: "example/runtime:1", required: true, policy: "explicit" }] }) };
      await openLaunchPage(page, manager, state);
      await page.locator("#languageMode").selectOption("en-US");
      await submitLaunch(page, manager);
      const action = page.locator("[data-launch-plan-blocker='image_pull_required'] [data-launch-plan-action]");
      await expect(action).toBeVisible();
      await expect(action).toHaveText("Pull image");
      await expect(page.locator("#launchConfirmSubmit")).toBeDisabled();
      expect(state.pulls).toHaveLength(0);

      // The image arrives: the pull call carries confirm:true and the re-check clears the blocker.
      state.plan = planFixture();
      await action.click();
      await expect.poll(() => state.pulls.length).toBe(1);
      expect(state.pulls[0].url).toContain("/api/runtimes/vllm-default/pull");
      expect(state.pulls[0].body).toEqual({ confirm: true });
      await page.locator("[data-launch-plan-refresh]").click();
      await expect(page.locator("[data-launch-plan-blocker]")).toHaveCount(0);
      await expect(page.locator("#launchConfirmSubmit")).toBeEnabled();
      await page.locator("#launchConfirmDialog button[value='cancel']").last().click();
      expect(state.starts).toHaveLength(0);
    });

    test("a 409 plan_changed returns to the review with the new plan", async ({ page }) => {
      const state = { plan: planFixture(), startAnswers: [{ status: 409, json: { ok: false, code: "plan_changed", error: "The launch plan changed." } }] };
      await openLaunchPage(page, manager, state);
      await submitLaunch(page, manager);
      await expect(page.locator("#launchConfirmDialog")).toBeVisible();
      state.plan = planFixture({ planHash: "sha256:bbbb" });
      await page.locator("#launchConfirmSubmit").click();

      await expect(page.locator("[data-launch-plan-changed]")).toBeVisible();
      expect(state.starts).toHaveLength(1);
      expect(state.starts[0].expectedPlanHash).toBe("sha256:aaaa");
      await expect(page.locator("#launchConfirmSubmit")).toBeEnabled();
      await page.locator("#launchConfirmSubmit").click();
      await expect.poll(() => state.starts.length).toBe(2);
      expect(state.starts[1].expectedPlanHash).toBe("sha256:bbbb");
      await expect(page.locator("#launchConfirmDialog")).not.toBeVisible();
    });

    test("the zh/en toggle swaps the review copy", async ({ page }) => {
      const state = { plan: planFixture() };
      await openLaunchPage(page, manager, state);
      for (const [language, steps, memory] of [["zh-CN", "执行步骤", "显存预检"], ["en-US", "Steps", "Memory check"]]) {
        await page.locator("#languageMode").selectOption(language);
        await submitLaunch(page, manager);
        const review = page.locator("#launchConfirmDialog [data-launch-plan]");
        await expect(review).toContainText(steps);
        await expect(review).toContainText(memory);
        await expect(review.locator("[data-launch-plan-override]")).toContainText(language === "zh-CN" ? "配方限制并发" : "the recipe caps concurrency");
        await page.locator("#launchConfirmDialog button[value='cancel']").last().click();
        await expect(page.locator("#launchConfirmDialog")).not.toBeVisible();
      }
    });

    test("an unavailable plan keeps the legacy confirmation and adds no hash", async ({ page }) => {
      const state = { plan: planFixture(), planStatus: 404 };
      await openLaunchPage(page, manager, state);
      await submitLaunch(page, manager);
      await expect(page.locator("#launchConfirmDialog")).toBeVisible();
      await expect(page.locator("#launchConfirmDialog [data-launch-plan]")).toHaveCount(0);
      await expect(page.locator("#launchConfirmSubmit")).toBeEnabled();
      await page.locator("#launchConfirmSubmit").click();
      await expect.poll(() => state.starts.length).toBe(1);
      expect(state.starts[0]).not.toHaveProperty("expectedPlanHash");
    });

    test("adds no duplicate DOM ids and stays a classic script", async ({ page }) => {
      const state = { plan: planFixture({ ok: false, blockers: [PULL_BLOCKER] }) };
      await openLaunchPage(page, manager, state);
      await submitLaunch(page, manager);
      await expect(page.locator("#launchConfirmDialog [data-launch-plan]")).toBeVisible();
      const duplicates = await page.evaluate(() => {
        const seen = new Map();
        for (const node of document.querySelectorAll("[id]")) seen.set(node.id, (seen.get(node.id) || 0) + 1);
        return [...seen].filter(([, count]) => count > 1).map(([id]) => id);
      });
      expect(duplicates).toEqual([]);

      const file = path.join(ROOT, manager.dir, "public", "app.js");
      const source = fs.readFileSync(file, "utf8");
      expect(() => new vm.Script(source, { filename: file })).not.toThrow();
      expect(source).not.toMatch(/^\s*(?:import\s.+from\s|import\s*["'(]|export\s+(?:default|const|function|class|\{))/m);
    });
  });
}
