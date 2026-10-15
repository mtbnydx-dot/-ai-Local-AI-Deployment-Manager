// MOD-19 browser checks (docs/overhaul/02-models.md §21.3): the two legacy
// manager UIs take their model facts from the server (the model card behind
// /api/model/config and /api/memory-estimate) and never guess them from the
// model name. Each page is served by the worktree's own manager on a free
// loopback port and every API answer that matters is stubbed at the browser
// boundary, so nothing reaches a live manager or the internet.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { getFreePort, startManager } = require("./helpers/console-harness.js");

const ROOT = path.resolve(__dirname, "..", "..");
const MANAGERS = [
  { label: "vLLM", dir: "vllm-manager", portEnv: "VLLM_MANAGER_PORT", hostEnv: "VLLM_MANAGER_HOST", pidEnv: "VLLM_MANAGER_PID_FILE" },
  { label: "llama", dir: "llama-manager", portEnv: "LLAMA_MANAGER_PORT", hostEnv: "LLAMA_MANAGER_HOST", pidEnv: "LLAMA_MANAGER_PID_FILE" },
];

// Ids the legacy pages and their other specs rely on (frontend-smoke, p0-ui).
const VLLM_IDS = [
  "startModel", "maxModelLen", "maxNumSeqs", "gpuMemoryUtilization", "kvCacheDtype", "launchQuantization",
  "memoryEstimate", "memoryGpuBars", "memoryEstimateNote", "contextHumanHint",
  "reasoningParser", "reasoningNote", "toolCallParser", "toolCallNote", "enableAutoToolChoice", "clientPreset",
  "modelList", "languageMode",
];
const LLAMA_IDS = [
  "startModel", "maxModelLen", "reasoningParser", "reasoningNote", "textOnlyMode", "textOnlyNote",
  "memoryEstimate", "memoryGpuBars", "memoryEstimateNote", "modelList", "languageMode",
];

let tmpDir;
let managers;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mod19-ui-"));
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

function requestBody(request) {
  try {
    return request.postDataJSON();
  } catch {
    return request.postData();
  }
}

// Opens a manager page. Reads that matter are stubbed by the caller's setup;
// the background reads the pages make on load are answered with empty lists.
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
  await page.route("https://unpkg.com/**/lucide*.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.lucide={createIcons(){}};",
  }));
  await page.route("**/api/remote-models?*", (route) => route.fulfill({ json: { models: [], limit: 48, source: "huggingface", sort: "trending" } }));
  await page.route("**/api/remote-models/*-variants?*", (route) => route.fulfill({ json: { variants: [] } }));
  await page.route("**/api/download/estimate?*", (route) => route.fulfill({ json: { bytes: 1024, fileCount: 1, diskFreeBytes: 100 * 1024 ** 3 } }));
  await page.route("**/api/download/precheck?*", (route) => route.fulfill({ json: { ok: true, findings: [] } }));
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "retry: 600000\n\n" }));
  await setup();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-shell")).toBeVisible();
  return { failures };
}

// The pages follow the browser language by default; the checks below read the
// Chinese copy, so pick it explicitly.
async function useChinese(page) {
  await page.locator("#languageMode").selectOption("zh-CN");
}

async function openView(page, view) {
  await page.locator(`[data-view='${view}']`).first().click();
  await expect(page.locator(`[data-view-panel='${view}']`).first()).toBeVisible();
}

// A /api/model/config answer for a model whose name says nothing: the parsers
// are the §8.6 resolution (value + source), the size lives only in the card.
function modelConfigAnswer(model, parsers = {}) {
  return {
    source: "huggingface",
    model,
    found: true,
    numHiddenLayers: 40,
    numAttentionLayers: 40,
    numKeyValueHeads: 8,
    headDim: 128,
    maxPositionEmbeddings: 131072,
    quantMethod: "",
    speculative: { enabled: false, mode: "off", numSpeculativeTokens: 1, nativeMtp: false, reason: "" },
    capabilityEntry: null,
    recommendedReasoningParser: parsers.reasoning ?? "",
    recommendedToolCallParser: parsers.tool ?? "",
    parsers: {
      reasoningParser: { value: parsers.reasoning ?? "", source: "template", reason: { en: "from the chat template", zh: "来自聊天模板" } },
      toolCallParser: { value: parsers.tool ?? "", source: "knowledge", reason: { en: "from the family", zh: "来自家族知识" } },
      autoToolChoice: { value: Boolean(parsers.tool), source: "knowledge", reason: { en: "a tool parser is set", zh: "已设置工具调用解析器" } },
      engineId: "vllm",
      warnings: [],
    },
  };
}

test.describe("MOD-19 legacy UI adoption", () => {
  test("both app.js files stay classic scripts without name-based inference", async () => {
    for (const manager of MANAGERS) {
      const file = path.join(ROOT, manager.dir, "public", "app.js");
      const source = fs.readFileSync(file, "utf8");
      // A classic script compiles as a plain Script: no import/export statements.
      expect(() => new vm.Script(source, { filename: file }), `${manager.label} app.js compiles as a classic script`).not.toThrow();
      expect(source).not.toMatch(/^\s*(?:import\s.+from\s|import\s*["'(]|export\s+(?:default|const|function|class|\{))/m);
      const html = fs.readFileSync(path.join(ROOT, manager.dir, "public", "index.html"), "utf8");
      expect(html).not.toMatch(/<script[^>]*type=["']module["'][^>]*app\.js/);
      // The browser-side guessers are gone. llama keeps its own memory
      // estimator (02 limits MOD-19 to its reasoning format); the name-based
      // parser and projector guesses are gone from both files.
      const removed = ["inferReasoningParser", "inferToolCallParser", "isLikelyMultimodalModel"];
      if (manager.label === "vLLM") removed.push("estimateMemoryUsage", "estimateArchitecture", "getLaunchQuantizationProfile");
      for (const name of removed) {
        const defined = new RegExp(`function\s+${name}\b`).test(source);
        expect(defined, `${manager.label} app.js still defines ${name}`).toBe(false);
      }
    }
  });

  test("existing DOM ids are unchanged", async ({ page }) => {
    for (const [label, ids] of [["vLLM", VLLM_IDS], ["llama", LLAMA_IDS]]) {
      const { failures } = await openManagerPage(page, managers[label].url, async () => {
        await page.route("**/api/models", (route) => route.fulfill({ json: { local: [], cached: [] } }));
      });
      for (const id of ids) {
        await expect(page.locator(`#${id}`), `${label} #${id}`).toHaveCount(1);
      }
      expect(failures).toEqual([]);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  test("llama model list shows an unverified deepseek4 GGUF as unknown, not compatible", async ({ page }) => {
    const { failures } = await openManagerPage(page, managers.llama.url, async () => {
      await page.route("**/api/models", (route) => route.fulfill({
        json: {
          local: [{
            id: "deepseek4-model",
            label: "deepseek4-model",
            path: "D:/models/deepseek4-model",
            launchModel: "D:/models/deepseek4-model/deepseek4.Q4_K_M.gguf",
            hasGguf: true,
            size: 4_000_000_000,
            ggufVariants: [{
              launchModel: "D:/models/deepseek4-model/deepseek4.Q4_K_M.gguf",
              name: "deepseek4.Q4_K_M.gguf",
              fileBytes: 4_000_000_000,
              architecture: "deepseek4",
              runtimeCompatibility: {
                status: "unknown",
                supported: null,
                message: "deepseek4 不在已验证的架构列表中，能否运行取决于当前 llama.cpp 版本。 / deepseek4 is not in the verified architecture list. Whether it runs depends on the current llama.cpp build.",
              },
            }],
          }],
          cached: [],
        },
      }));
    });
    await useChinese(page);
    await openView(page, "models");
    const badge = page.locator("#modelList .runtime-compat").first();
    await expect(badge).toHaveText("未知（未验证）");
    await expect(badge).not.toHaveText("兼容");
    await expect(badge).toHaveClass(/runtime-compat-warn/);
    await expect(page.locator("#modelList .runtime-compat-ok")).toHaveCount(0);
    expect(failures).toEqual([]);
  });

  test("vLLM launch form fills the parser dropdowns from /api/model/config, not from the model name", async ({ page }) => {
    const configRequests = [];
    const answers = {
      // Names that the old guessers matched ("qwen3", "deepseek") now say nothing.
      "acme/zeta-opaque": { reasoning: "granite", tool: "xlam" },
      "acme/qwen3-lookalike": { reasoning: "", tool: "" },
      "acme/novel-format": { reasoning: "custom_think", tool: "custom_tools" },
    };
    const { failures } = await openManagerPage(page, managers.vLLM.url, async () => {
      await page.route("**/api/models", (route) => route.fulfill({ json: { local: [], cached: [] } }));
      await page.route("**/api/model/config?*", (route) => {
        const model = new URL(route.request().url()).searchParams.get("model");
        configRequests.push(model);
        const parsers = answers[model];
        return route.fulfill({ json: parsers ? modelConfigAnswer(model, parsers) : { source: "huggingface", model, found: false, reason: "not stubbed" } });
      });
      await page.route("**/api/memory-estimate", (route) => route.fulfill({ json: { ok: true, plan: {}, recommendations: {} } }));
    });
    await useChinese(page);
    await openView(page, "service");
    const reasoning = page.locator("#reasoningParser");
    const tool = page.locator("#toolCallParser");

    await page.locator("#startModel").fill("acme/zeta-opaque");
    await expect.poll(() => configRequests).toContain("acme/zeta-opaque");
    await expect(reasoning).toHaveValue("granite");
    await expect(tool).toHaveValue("xlam");
    await expect(page.locator("#reasoningNote")).toContainText("--reasoning-parser granite");
    await expect(page.locator("#toolCallNote")).toContainText("--tool-call-parser xlam");

    // A "qwen3" name alone no longer turns a parser on: the card said none.
    await page.locator("#startModel").fill("acme/qwen3-lookalike");
    await expect.poll(() => configRequests).toContain("acme/qwen3-lookalike");
    await expect(reasoning).toHaveValue("");
    await expect(tool).toHaveValue("");
    await expect(page.locator("#reasoningNote")).toContainText("不会传 --reasoning-parser");

    // A parser the static list does not have is added, never dropped.
    await page.locator("#startModel").fill("acme/novel-format");
    await expect.poll(() => configRequests).toContain("acme/novel-format");
    await expect(reasoning).toHaveValue("custom_think");
    await expect(tool).toHaveValue("custom_tools");
    expect(failures).toEqual([]);
  });

  test("vLLM memory panel estimates a model without a size token from the model card", async ({ page }) => {
    const estimateBodies = [];
    const { failures } = await openManagerPage(page, managers.vLLM.url, async () => {
      await page.route("**/api/models", (route) => route.fulfill({ json: { local: [], cached: [] } }));
      await page.route("**/api/model/config?*", (route) => route.fulfill({ json: modelConfigAnswer(new URL(route.request().url()).searchParams.get("model"), { reasoning: "qwen3", tool: "hermes" }) }));
      await page.route("**/api/memory-estimate", async (route) => {
        const body = requestBody(route.request());
        estimateBodies.push(body);
        await route.fulfill({
          json: {
            ok: true,
            engine: "vllm",
            plan: {
              weightsGb: 14.2,
              kvGb: 2.5,
              kvGbHigh: 2.5,
              overheadPerGpuGb: 1.3,
              perGpuGb: 18,
              weightPerGpuGb: 14.2,
              kvPerGpuGb: 2.5,
              memorySplitFactor: 1,
              overflowPerGpuGb: 0,
              status: "ok",
              selectedGpus: [],
            },
            recommendations: { status: "ok", summary: "预计可运行", suggestions: [] },
            fit: { status: "ok", confidence: "exact" },
            card: { cardId: "card-test", confidence: "exact" },
          },
        });
      });
    });
    await useChinese(page);
    await openView(page, "service");
    await page.locator("#startModel").fill("acme/opaque-model");
    await expect.poll(() => estimateBodies.some((body) => body?.model === "acme/opaque-model")).toBe(true);

    const request = estimateBodies.find((body) => body?.model === "acme/opaque-model");
    // Card mode: the model plus an engine id; no parameter count, bytes per
    // parameter or architecture guessed in the browser.
    expect(request).toMatchObject({ model: "acme/opaque-model", engineId: "vllm", engine: "vllm" });
    for (const key of ["paramsB", "bytesPerParam", "kvBytes", "arch"]) expect(request).not.toHaveProperty(key);
    expect(Number(request.contextTokens)).toBeGreaterThan(0);

    const weights = page.locator("#memoryEstimate .estimate-item").first();
    await expect(weights).toContainText("14.2 GB");
    await expect(page.locator("#memoryEstimate")).toContainText("每卡 KV cache");
    await expect(page.locator("#memoryEstimate")).not.toContainText("0.00 GB");
    expect(failures).toEqual([]);
  });

  test("vLLM memory panel says so when no card can be built, instead of guessing", async ({ page }) => {
    const estimateBodies = [];
    const { failures } = await openManagerPage(page, managers.vLLM.url, async () => {
      await page.route("**/api/models", (route) => route.fulfill({ json: { local: [], cached: [] } }));
      await page.route("**/api/model/config?*", (route) => route.fulfill({ json: { source: "huggingface", model: "acme/unknown-70B", found: false, reason: "offline" } }));
      await page.route("**/api/memory-estimate", async (route) => {
        estimateBodies.push(requestBody(route.request()));
        await route.fulfill({ json: { ok: true, plan: {}, recommendations: {} } });
      });
    });
    await useChinese(page);
    await openView(page, "service");
    // The old estimator would have read "70B" from this name.
    await page.locator("#startModel").fill("acme/unknown-70B");
    await expect(page.locator("#memoryEstimateNote")).toContainText("估算不可用");
    await expect(page.locator("#memoryEstimate")).not.toContainText("70");
    await page.waitForTimeout(400);
    expect(estimateBodies.filter((body) => body?.model === "acme/unknown-70B")).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("llama reasoning format follows the server's card answer, not the model name", async ({ page }) => {
    const { failures } = await openManagerPage(page, managers.llama.url, async () => {
      await page.route("**/api/models", (route) => route.fulfill({ json: { local: [], cached: [] } }));
    });
    const select = page.locator("#reasoningParser");
    // No card answer for a name that used to select "deepseek": llama.cpp decides.
    await page.locator("#startModel").fill("acme/deepseek-lookalike");
    await expect(select).toHaveValue("auto");

    // A server answer (launch recommendation / saved profile) carries the card's value.
    await page.evaluate(() => applyLaunchProfile({ model: "acme/plain-name", reasoningFormat: "deepseek-legacy" }));
    await expect(page.locator("#startModel")).toHaveValue("acme/plain-name");
    await expect(select).toHaveValue("deepseek-legacy");
    await expect(page.locator("#reasoningNote")).toContainText("--reasoning-format deepseek-legacy");

    // Another model has no card answer, so the value falls back to auto.
    await page.locator("#startModel").fill("acme/other-model");
    await expect(select).toHaveValue("auto");
    expect(failures).toEqual([]);
  });
});
