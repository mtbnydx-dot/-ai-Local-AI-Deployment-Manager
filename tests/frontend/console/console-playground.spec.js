// CON-13 browser checks (07 §6.6, C13): the Playground against a mocked
// gateway. Streaming with reasoning and usage, the tool-calling preset,
// per-message stats and the route header, `reasoningToggle` merged only when
// the model has it, curl output with $API_KEY only, owner requests with
// x-csrf-token and no authorization, a typed key sent but never stored and
// gone after navigation, the key field after a 401, and one csrf retry.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { collectFailures, mockConsoleApi, setPrefs, startEntry } = require("../helpers/console-harness.js");

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures", "console");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const BASE = "/gateway/auto/openai/v1";
const TYPED_KEY = "test-key-abc123";

// The shell itself keeps its preference markers in localStorage (07 C6); the page must add nothing.
const SHELL_STORAGE_KEYS = ["console.prefs.migrated", "console.prefs.v1"];

async function expectNoPlaygroundData(page) {
  const state = await page.evaluate(() => ({
    local: Object.fromEntries(Object.keys(window.localStorage).map((name) => [name, window.localStorage.getItem(name)])),
    session: Object.keys(window.sessionStorage),
    cookie: document.cookie,
  }));
  expect(Object.keys(state.local).filter((name) => !SHELL_STORAGE_KEYS.includes(name)), "localStorage").toEqual([]);
  expect(JSON.stringify(state.local), "localStorage values").not.toMatch(/test-key|answer|first|with a key|specific key|hello/i);
  expect(state.session, "sessionStorage").toEqual([]);
  expect(state.cookie, "document.cookie").not.toContain(TYPED_KEY);
}

let entry;

test.beforeAll(async () => {
  entry = await startEntry();
});

test.afterAll(async () => {
  await entry?.stop();
});

function owner({ csrf = "t", features = {}, consoleSession = true } = {}) {
  return {
    role: "owner",
    auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf },
    features: { platform: true, ...features },
    gateway: { consoleSession },
  };
}

function merge(base, patch) {
  const next = { ...base, ...patch };
  for (const name of ["features", "auth", "access", "gateway"]) if (patch[name]) next[name] = { ...base[name], ...patch[name] };
  return next;
}

async function withBootstrap(context, patch) {
  const guarded = (handler) => async (route) => {
    try {
      await handler(route);
    } catch (error) {
      if (!/disposed|closed|aborted/i.test(String(error?.message))) throw error;
    }
  };
  await context.route((url) => url.pathname === "/api/console/bootstrap", guarded(async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: JSON.stringify(merge(await response.json(), patch)) });
  }));
  await context.route((url) => !/^\/(api|c|gateway)\//.test(url.pathname), guarded(async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.text()).replace(BOOTSTRAP_BLOCK, (match, open, json, close) => (
      `${open}${JSON.stringify(merge(JSON.parse(json), patch)).replace(/</g, "\\u003c")}${close}`));
    await route.fulfill({ response, body });
  }));
}

const TOGGLE = { on: { chat_template_kwargs: { enable_thinking: true } }, off: { chat_template_kwargs: { enable_thinking: false } } };
const MODELS = {
  object: "list",
  data: [
    { id: "qwen-think", object: "model", capabilities: { vision: true, tools: true, reasoning: true }, controls: { reasoning_toggle: TOGGLE } },
    { id: "plain-model", object: "model", capabilities: { vision: false } },
  ],
};

function frames(chunks) {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

const delta = (value) => ({ choices: [{ index: 0, delta: value }] });
const STREAM = frames([
  delta({ role: "assistant", reasoning_content: "Let me think. " }),
  delta({ reasoning_content: "Two plus two." }),
  delta({ content: "The answer " }),
  delta({ content: "is 4." }),
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } },
]);
const TOOL_STREAM = frames([
  delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: "{\"city\":" } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: "\"Paris\"}" } }] }),
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } },
]);

function sseAnswer(body) {
  return { status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store", "x-local-ai-route": "vllm vllm vllm-qwen manual", "x-request-id": "req_pg_1" }, body };
}

async function open(browser, { bootstrap = owner(), api = {}, size = { width: 1440, height: 960 } } = {}) {
  const context = await browser.newContext({ viewport: size, locale: "en-US", reducedMotion: "reduce" });
  await setPrefs(context, { theme: "light", locale: "en-US", density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, bootstrap);
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const mock = await mockConsoleApi(page, {
    "GET /api/status": fixture("status"),
    "GET /api/fleet": fixture("fleet"),
    "GET /api/platform/status": fixture("platform-status"),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    "GET /api/engines": { ok: true, engines: [{ engineId: "vllm", label: "vLLM" }] },
    "GET /api/engines/external/endpoints": { ok: true, endpoints: [] },
    [`GET ${BASE}/models`]: MODELS,
    ...api,
  });
  await page.goto(`${entry.url}playground`);
  await expect(page.locator('[data-testid="playground.root"]')).toBeVisible();
  return { context, page, mock, failures };
}

const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const chatCalls = (mock) => mock.calls.filter((call) => call.method === "POST" && call.path === `${BASE}/chat/completions`);
const realFailures = (failures) => failures.failures.filter((item) => !/\/routes\/(?!playground)|Failed to load resource/.test(item));

async function send(page, text) {
  await byId(page, "playground.input").fill(text);
  await byId(page, "playground.send").click();
}

test("streams content and reasoning with per-message stats, the route header and csrf-only credentials", async ({ browser }) => {
  const { context, page, mock, failures } = await open(browser, {
    bootstrap: owner({ features: { telemetry: true } }),
    api: { [`POST ${BASE}/chat/completions`]: () => sseAnswer(STREAM) },
  });
  try {
    await expect(byId(page, "playground.model")).toHaveValue("qwen-think");
    await send(page, "What is two plus two?");

    const turn = byId(page, "playground.turn.assistant");
    await expect(turn.locator('[data-testid="playground.content"]')).toHaveText("The answer is 4.");
    await expect(turn.locator('[data-testid="playground.reasoning-text"]')).toHaveText("Let me think. Two plus two.");
    await expect(turn.locator('[data-testid="playground.route"]')).toHaveText("vllm · vllm-qwen · manual");
    await expect(turn.locator('[data-testid="playground.timing"]')).toContainText(/First token .*Total .*tok\/s.*8 tokens/);
    await expect(turn.locator('[data-testid="playground.request-link"]')).toHaveAttribute("href", "/observability/requests/req_pg_1");

    // The owner sends the session cookie and the csrf header, never an authorization header.
    const calls = [...mock.find("GET", `${BASE}/models`), ...chatCalls(mock)];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.headers["x-csrf-token"], `${call.method} ${call.path}`).toBe("t");
      expect(call.headers.authorization, `${call.method} ${call.path}`).toBeUndefined();
    }
    const body = chatCalls(mock)[0].body;
    expect(body.model).toBe("qwen-think");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "What is two plus two?" });
    await expect(byId(page, "playground.key-panel")).toHaveCount(0);
    await expectNoPlaygroundData(page);
    expect(mock.csrfViolations).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("reasoningToggle is merged only for a model whose card has it, and the switch hides the reasoning text", async ({ browser }) => {
  const { context, page, mock } = await open(browser, { api: { [`POST ${BASE}/chat/completions`]: () => sseAnswer(STREAM) } });
  try {
    await send(page, "first");
    await expect(byId(page, "playground.content")).toHaveText("The answer is 4.");
    expect(chatCalls(mock)[0].body.chat_template_kwargs).toEqual({ enable_thinking: true });

    await byId(page, "playground.reasoning-toggle").uncheck();
    await expect(byId(page, "playground.reasoning")).toHaveCount(0);
    await send(page, "second");
    await expect(byId(page, "playground.content")).toHaveCount(2);
    expect(chatCalls(mock)[1].body.chat_template_kwargs).toEqual({ enable_thinking: false });

    await byId(page, "playground.model").selectOption("plain-model");
    await byId(page, "playground.reasoning-toggle").check();
    await send(page, "third");
    await expect(byId(page, "playground.content")).toHaveCount(3);
    const plain = chatCalls(mock)[2].body;
    expect(plain.model).toBe("plain-model");
    expect("chat_template_kwargs" in plain).toBe(false);
    // Shown again: only the switch changed, the request did not.
    await expect(byId(page, "playground.reasoning").first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the tool-calling preset sends tools and shows the call as JSON", async ({ browser }) => {
  const { context, page, mock } = await open(browser, { api: { [`POST ${BASE}/chat/completions`]: () => sseAnswer(TOOL_STREAM) } });
  try {
    await byId(page, "playground.preset-tools").click();
    await expect(byId(page, "playground.input")).not.toHaveValue("");
    await byId(page, "playground.send").click();
    const call = byId(page, "playground.tool-call");
    await expect(call).toBeVisible();
    await expect(call.locator("code")).toContainText('"name": "get_weather"');
    await expect(call.locator("code")).toContainText('"city": "Paris"');
    const body = chatCalls(mock)[0].body;
    expect(body.tools[0].function.name).toBe("get_weather");
    expect(body.tool_choice).toBe("auto");
    // Vision shows only for a model that reports it.
    await expect(byId(page, "playground.preset-vision")).toBeVisible();
    await byId(page, "playground.model").selectOption("plain-model");
    await expect(byId(page, "playground.preset-vision")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("copy as curl and Python show $API_KEY only", async ({ browser }) => {
  const { context, page } = await open(browser, { api: { [`POST ${BASE}/chat/completions`]: () => sseAnswer(STREAM) } });
  try {
    await send(page, "hello");
    await expect(byId(page, "playground.content")).toBeVisible();
    await byId(page, "playground.export-curl").click();
    const code = byId(page, "playground.export-code");
    await expect(code).toContainText("Authorization: Bearer $API_KEY");
    await expect(code).toContainText("/gateway/auto/openai/v1/chat/completions");
    await byId(page, "playground.export-python").click();
    await expect(code).toContainText('os.environ["API_KEY"]');
    expect(await page.locator("body").innerText()).not.toContain("x-csrf-token");
  } finally {
    await context.close();
  }
});

test("a 401 shows the key field; a typed key is sent, never stored, and gone after navigation", async ({ browser }) => {
  const { context, page, mock, failures } = await open(browser, {
    bootstrap: owner({ consoleSession: false }),
    api: {
      [`GET ${BASE}/models`]: (request) => (request.headers().authorization === `Bearer ${TYPED_KEY}`
        ? MODELS
        : { status: 401, body: { error: { code: "invalid_api_key", message: "A key is required." } } }),
      [`POST ${BASE}/chat/completions`]: () => sseAnswer(STREAM),
    },
  });
  try {
    const field = byId(page, "playground.key");
    await expect(field).toBeVisible();
    await field.fill(TYPED_KEY);
    await expect(byId(page, "playground.model")).toHaveValue("qwen-think");
    await send(page, "with a key");
    await expect(byId(page, "playground.content")).toHaveText("The answer is 4.");
    expect(chatCalls(mock)[0].headers.authorization).toBe(`Bearer ${TYPED_KEY}`);
    await expectNoPlaygroundData(page);
    expect(await page.locator("body").innerText()).not.toContain(TYPED_KEY);

    // Navigating away and back drops the key.
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Overview" }).click();
    await expect(page).toHaveURL(/\/overview$/);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Playground" }).click();
    await expect(byId(page, "playground.root")).toBeVisible();
    await expect(byId(page, "playground.key")).toHaveValue("");
    const lastModels = mock.find("GET", `${BASE}/models`).at(-1);
    expect(lastModels.headers.authorization).toBeUndefined();
    await expectNoPlaygroundData(page);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("an owner can open Test with a specific key; the field is empty again on the next visit", async ({ browser }) => {
  const { context, page, mock } = await open(browser, { api: { [`POST ${BASE}/chat/completions`]: () => sseAnswer(STREAM) } });
  try {
    await expect(byId(page, "playground.key-panel")).toHaveCount(0);
    await byId(page, "playground.key-open").click();
    await byId(page, "playground.key").fill(TYPED_KEY);
    await send(page, "specific key");
    await expect(byId(page, "playground.content")).toBeVisible();
    expect(chatCalls(mock)[0].headers.authorization).toBe(`Bearer ${TYPED_KEY}`);
    await byId(page, "playground.key-forget").click();
    await expect(byId(page, "playground.key-panel")).toHaveCount(0);
    await expectNoPlaygroundData(page);
  } finally {
    await context.close();
  }
});

test("a 403 csrf_invalid re-reads the session and retries once", async ({ browser }) => {
  // The page boots with a stale token; /api/session hands out the right one.
  const { context, page, mock } = await open(browser, {
    bootstrap: owner({ csrf: "stale" }),
    api: { [`POST ${BASE}/chat/completions`]: () => sseAnswer(STREAM) },
  });
  try {
    await send(page, "retry me");
    await expect(byId(page, "playground.content")).toHaveText("The answer is 4.");
    const calls = chatCalls(mock);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers["x-csrf-token"]).toBe("stale");
    expect(calls[1].headers["x-csrf-token"]).toBe("t");
    expect(mock.csrfViolations).toEqual([`POST ${BASE}/chat/completions`]);
  } finally {
    await context.close();
  }
});

test("a gateway error is shown on the message and a stuck csrf token does not loop", async ({ browser }) => {
  const { context, page, mock } = await open(browser, {
    api: { [`POST ${BASE}/chat/completions`]: { status: 429, body: { error: { code: "rate_limited", message: "Too many requests." } } } },
  });
  try {
    await send(page, "too fast");
    await expect(byId(page, "playground.error")).toContainText("429");
    await expect(byId(page, "playground.error")).toContainText("Too many requests.");
    expect(chatCalls(mock)).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("on a phone the settings open in a drawer and the page does not scroll sideways", async ({ browser }) => {
  const { context, page } = await open(browser, { size: { width: 390, height: 844 } });
  try {
    await expect(byId(page, "playground.config-card")).toHaveCount(0);
    await byId(page, "playground.config-open").click();
    await expect(byId(page, "playground.drawer")).toBeVisible();
    await expect(byId(page, "playground.target")).toBeVisible();
    await page.keyboard.press("Escape");
    const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
  } finally {
    await context.close();
  }
});
