// CON-11 browser checks (07 §13.2 console-wizard, part 1; 02 §18 R-UI-1, R-UI-2, R-UI-9):
// the wizard's model and engine steps and the plan strip. The model library
// degrades to the managers' lists; a draft or projector cannot be the main
// model; the card shows an evidence chip on every fact; every GPU has a fit
// badge. The engine matrix shows `ok` only with evidence, an unknown row is
// grey with the dry probe and Override, a blocked row is disabled; a probe of
// a model that ships its own code asks for consent that lists the auto_map
// files. Plan requests are debounced and deduped (request counts asserted); an
// ok:false plan renders its field errors, suggestion and blockers; a remote
// model is planned prospectively. The draft survives a reload and
// sessionStorage never holds a secret or an extraEnv value; leaving asks
// before the draft is discarded. The real service-entry serves the console;
// the API is mocked in the browser (helpers/console-harness.js).
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const {
  collectFailures,
  expectNoA11yViolations,
  expectNoOverflow,
  mockConsoleApi,
  setPrefs,
  startEntry,
} = require("../helpers/console-harness.js");

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures", "console");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
const wizard = (name) => fixture(`wizard/${name}`);
const HAN = /\p{Script=Han}/u;
const RAW_KEY = /\bmodels\.(?:wizard|card|compat|confidence|role|verdict|remoteCode)\.[A-Za-z]/;
const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER = {
  role: "owner",
  auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" },
  features: { engines: true, platform: true, hub: true, models: true },
};
const NOT_FOUND = { status: 404, body: { error: "Not found" } };
const MAIN = "mc_aaaaaaaaaaaaaaaaaaaa";
const DRAFT = "mc_bbbbbbbbbbbbbbbbbbbb";
const REMOTE = "mc_cccccccccccccccccccc";
const CUSTOM = "mc_dddddddddddddddddddd";
const FAKE_SECRET = "fake-env-secret-value";

let entry;

test.beforeAll(async () => {
  entry = await startEntry();
});

test.afterAll(async () => {
  await entry?.stop();
});

function merge(base, patch) {
  const next = { ...base, ...patch };
  for (const name of ["features", "auth", "access", "gateway"]) if (patch[name]) next[name] = { ...base[name], ...patch[name] };
  return next;
}

// The real entry makes a loopback browser with no session a viewer; this spec tests the owner.
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

const LEGACY_MODELS = {
  local: [
    { name: "example-MadeUp-7B", path: "C:/fixture/models/example-MadeUp-7B", runnable: true },
    { name: "example-draft-head", path: "C:/fixture/models/example-draft-head", runnable: true },
    { name: "example-custom-code", path: "C:/fixture/models/example-custom-code", runnable: true },
  ],
  remote: [],
};

const CARD_BY_PATH = [
  [/draft/, "card-draft"],
  [/custom/, "card-custom"],
  [/./, "card-main"],
];

// The state the mocked endpoints share with a test: which plan comes back, the probe job's state.
function createState() {
  return { plan: "plan-ok", planStatus: 200, probe: "running", compatGpu1: false };
}

function wizardApi(state, extra = {}) {
  const cardRoutes = {};
  for (const [id, file] of [[MAIN, "card-main"], [DRAFT, "card-draft"], [REMOTE, "card-remote"], [CUSTOM, "card-custom"]]) {
    cardRoutes[`GET /api/models/${id}/card`] = () => wizard(file);
    cardRoutes[`GET /api/models/${id}/compatibility`] = (request, route, record) => {
      const body = wizard("compat");
      if (id !== MAIN) return { ...body, cardId: id };
      if (record.query.gpus === "1") return wizard("compat-gpu1");
      if (record.query.gpus === "0") return { ...body, host: { ...body.host, gpus: [body.host.gpus[0]] } };
      return body;
    };
    cardRoutes[`POST /api/models/${id}/probe`] = () => ({ status: 202, body: { ok: true, jobId: "job_probe_1", managerId: "vllm" } });
  }
  return {
    "GET /api/status": fixture("status"),
    "GET /api/fleet": fixture("fleet"),
    "GET /api/platform/status": fixture("platform-status"),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    "GET /api/engines": fixture("engines"),
    "GET /api/m/vllm/engines/vllm/schema": fixture("schema-vllm"),
    "GET /api/m/vllm/models": LEGACY_MODELS,
    "GET /api/m/llama/models": { local: [], remote: [] },
    "GET /api/m/vllm/instances": { instances: [] },
    "GET /api/m/llama/instances": { instances: [] },
    "POST /api/models/inspect": (request, route, record) => {
      if (record.body?.repo) return wizard("card-remote");
      const found = CARD_BY_PATH.find(([pattern]) => pattern.test(String(record.body?.path || "")));
      return wizard(found[1]);
    },
    "POST /api/hub/resolve-link": { provider: "huggingface", repo: "example-org/example-model-7B", revision: "main" },
    "POST /api/m/vllm/launch/plan": () => (state.planStatus === 200
      ? wizard(state.plan)
      : { status: state.planStatus, body: { ok: false, error: { code: "invalid_request", message: "The plan request is malformed." } } }),
    "GET /api/m/vllm/jobs": () => ({
      jobs: [{ id: "job_probe_1", type: "model-probe", state: state.probe, progress: { percent: state.probe === "running" ? 40 : 100 }, ...(state.probe === "failed" ? { error: { message: "probe crashed" } } : {}) }],
    }),
    "GET /api/knowledge/status": NOT_FOUND,
    ...cardRoutes,
    ...extra,
  };
}

async function newPage(browser, { api = {}, state = createState(), size = SIZES.desktop, theme = "light", locale = "en-US", storage } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, OWNER);
  if (storage) {
    await context.addInitScript((items) => {
      for (const [name, value] of Object.entries(items)) window.sessionStorage.setItem(name, value);
    }, storage);
  }
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const mock = await mockConsoleApi(page, wizardApi(state, api));
  return { context, page, mock, failures, state };
}

// Pages that are not in the build yet log a failed module load, and the mocks answer 404 on purpose.
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));
const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const callsTo = (mock, method, prefix) => mock.calls.filter((call) => call.method === method && call.path.startsWith(prefix));
const planCalls = (mock) => callsTo(mock, "POST", "/api/m/vllm/launch/plan");
const storedDraft = (page) => page.evaluate(() => window.sessionStorage.getItem("console.wizard.draft"));

async function open(page, query = "") {
  await page.goto(`${entry.url}deployments/new${query}`);
  await expect(byId(page, "wizard")).toBeVisible();
}

async function pickModel(page, name) {
  await page.locator(`[data-testid="wizard.model.item"]:has-text("${name}") [data-testid="wizard.model.pick"]`).click();
}

// ---------------------------------------------------------------------------
// Step 1

test("the library degrades to the managers' lists; the title and steps are in place", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser);
  try {
    await open(page);
    await expect(page).toHaveTitle("Deployments · Local AI Platform");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("New deployment");
    await expect(byId(page, "wizard.stepper").locator('[data-testid="stepper.step"]')).toHaveCount(7);
    await expect(byId(page, "wizard.stepper").locator('[data-state="active"]')).toContainText("Model");
    await expect(byId(page, "wizard.model.library")).toHaveAttribute("data-source", "managers");
    await expect(byId(page, "wizard.model.item")).toHaveCount(3);
    expect(callsTo(mock, "GET", "/api/hub/library")).toHaveLength(1);
    await expect(byId(page, "wizard.next")).toBeDisabled();
    await expect(byId(page, "wizard.plan-label")).toHaveText("Once a model and an engine are chosen, the launch plan shows here.");
    expect(planCalls(mock)).toHaveLength(0);
    // The filter narrows the list.
    await byId(page, "wizard.model.filter").fill("custom");
    await expect(byId(page, "wizard.model.item")).toHaveCount(1);
    await byId(page, "wizard.model.filter").fill("zzz");
    await expect(byId(page, "wizard.model.nomatch")).toBeVisible();
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("hub library entries whose card is a draft or projector cannot be chosen", async ({ browser }) => {
  const entries = [
    { id: "lib_1", kind: "folder", path: "C:/fixture/models/example-MadeUp-7B", displayName: "example-MadeUp-7B", format: "safetensors", bytes: 15032385536, card: { cardId: MAIN, role: "main" } },
    { id: "lib_2", kind: "folder", path: "C:/fixture/models/example-draft-head", displayName: "example-draft-head", format: "safetensors", bytes: 1000000, card: { cardId: DRAFT, role: "draft" } },
    { id: "lib_3", kind: "folder", path: "C:/fixture/models/example-vision-proj", displayName: "example-vision-proj", format: "gguf", bytes: 500000, card: { cardId: "mc_eeeeeeeeeeeeeeeeeeee", role: "mmproj" } },
  ];
  const { context, page } = await newPage(browser, { api: { "GET /api/hub/library": { entries, roots: [], nextCursor: null } } });
  try {
    await open(page);
    await expect(byId(page, "wizard.model.library")).toHaveAttribute("data-source", "hub");
    const draft = page.locator('[data-testid="wizard.model.item"][data-role="draft"]');
    await expect(draft.locator("button")).toBeDisabled();
    await expect(draft.locator('[data-testid="wizard.model.item-note"]')).toHaveText("This is a draft/projector and pairs with a main model");
    await expect(page.locator('[data-testid="wizard.model.item"][data-role="mmproj"] button')).toBeDisabled();
    await expect(page.locator('[data-testid="wizard.model.item"][data-role="main"] button')).toBeEnabled();
  } finally {
    await context.close();
  }
});

test("a folder the inspector finds to be a draft is refused with the reason, and Next stays off", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await open(page);
    await pickModel(page, "example-draft-head");
    await expect(byId(page, "wizard.model.notMain")).toHaveText("This is a draft/projector and pairs with a main model");
    expect(callsTo(mock, "POST", "/api/models/inspect").map((call) => call.body)).toEqual([{ path: "C:/fixture/models/example-draft-head" }]);
    await expect(byId(page, "wizard.model.rejected").locator('[data-testid="model-card.role"]')).toHaveText("Speculative draft");
    await expect(byId(page, "wizard.model.selected")).toHaveCount(0);
    await expect(byId(page, "wizard.next")).toBeDisabled();
    expect(await storedDraft(page)).toBeNull();
    // A main model replaces the notice.
    await pickModel(page, "example-MadeUp-7B");
    await expect(byId(page, "wizard.model.notMain")).toHaveCount(0);
    await expect(byId(page, "wizard.model.selected")).toBeVisible();
    await expect(byId(page, "wizard.next")).toBeEnabled();
  } finally {
    await context.close();
  }
});

test("the card shows an evidence chip on every fact (R-UI-1) and each GPU gets a fit badge", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser);
  try {
    await open(page);
    await pickModel(page, "example-MadeUp-7B");
    await expect(byId(page, "model-card.name")).toHaveText("example-MadeUp-7B");
    await expect(byId(page, "model-card.role")).toHaveText("Main model");
    const facts = byId(page, "model-card.fact");
    expect(await facts.count()).toBeGreaterThanOrEqual(8);
    // Every row carries one chip with one of the four confidences or unknown, written out.
    const chips = await facts.evaluateAll((rows) => rows.map((row) => ({
      fact: row.getAttribute("data-fact"),
      confidence: row.querySelector("[data-confidence]")?.getAttribute("data-confidence"),
      text: row.querySelector("[data-confidence]")?.textContent.trim(),
    })));
    for (const chip of chips) expect(["declared", "detected", "name-heuristic", "verified-on-host", "unknown"], chip.fact).toContain(chip.confidence);
    const row = (fact) => chips.find((chip) => chip.fact === fact);
    expect(row("modelType")).toMatchObject({ confidence: "declared", text: "Declared by the model" });
    expect(row("family")).toMatchObject({ confidence: "name-heuristic", text: "Guessed from the name" });
    expect(row("size")).toMatchObject({ confidence: "verified-on-host", text: "Verified on this host" });
    expect(row("format")).toMatchObject({ confidence: "detected", text: "Detected" });
    expect(row("context")).toMatchObject({ confidence: "unknown", text: "Unknown" });
    await expect(byId(page, "model-card.fact").filter({ hasText: "Example family" })).toHaveCount(1);
    await expect(byId(page, "model-card.fact").filter({ hasText: "14.0 GiB" })).toHaveCount(1);
    // One fit badge per GPU, from the compatibility endpoint asked for that GPU alone.
    await expect(byId(page, "wizard.gpu-fit.item")).toHaveCount(2);
    await expect(page.locator('[data-testid="wizard.gpu-fit.item"][data-gpu="0"]')).toHaveAttribute("data-fit", "ok");
    await expect(page.locator('[data-testid="wizard.gpu-fit.item"][data-gpu="1"]')).toHaveAttribute("data-fit", "fail");
    await expect(page.locator('[data-testid="wizard.gpu-fit.item"][data-gpu="1"]')).toContainText("Does not fit");
    expect(callsTo(mock, "GET", `/api/models/${MAIN}/compatibility`).map((call) => call.query.gpus || "all").sort()).toEqual(["0", "1", "all"]);
    // The draft keeps the card id, so step 2 needs no second inspect.
    expect(JSON.parse(await storedDraft(page)).modelRef).toMatchObject({ kind: "local", path: "C:/fixture/models/example-MadeUp-7B", cardId: MAIN });
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a pasted link resolves to a remote model that is planned from its card, and Download first keeps the draft", async ({ browser }) => {
  const state = createState();
  state.plan = "plan-remote";
  const { context, page, mock } = await newPage(browser, { state });
  try {
    await open(page);
    await page.getByRole("tab", { name: "Paste a link or pick a folder" }).click();
    await byId(page, "wizard.model.link-input").fill("https://huggingface.co/example-org/example-model-7B");
    await byId(page, "wizard.model.link-resolve").click();
    await expect(byId(page, "wizard.model.remote")).toBeVisible();
    expect(callsTo(mock, "POST", "/api/hub/resolve-link").map((call) => call.body)).toEqual([{ url: "https://huggingface.co/example-org/example-model-7B" }]);
    expect(callsTo(mock, "POST", "/api/models/inspect").map((call) => call.body)).toEqual([{ source: "huggingface", repo: "example-org/example-model-7B", revision: "main" }]);
    await byId(page, "wizard.next").click();
    await expect(byId(page, "wizard.step.engine")).toBeVisible();
    await page.locator('[data-testid="compat.row"][data-engine="vllm"] [data-testid="compat.select"]').click();
    // The plan is prospective: model.card is the full card the manager needs (00 §9.2, 01 §11).
    await expect.poll(() => planCalls(mock).length).toBe(1);
    const body = planCalls(mock)[0].body;
    expect(body).toMatchObject({ engineId: "vllm", prospective: true, runtimeId: "vllm@0.28.0" });
    expect(body.model.card).toMatchObject({ cardId: REMOTE, schema: "modelcard/v1" });
    expect(body.model.ref).toBeUndefined();
    await expect(byId(page, "wizard.plan-warnings")).toContainText("Planned from the model card");
    // Download first leaves the page without the discard question and keeps the draft for the way back.
    await byId(page, "wizard.back").click();
    await byId(page, "wizard.model.download-first").click();
    await expect(page).toHaveURL(/\/models\/hub\/huggingface\/example-org\/example-model-7B\?draft=wd_[a-z2-7]+/);
    const draft = JSON.parse(await storedDraft(page));
    expect(draft.modelRef).toMatchObject({ kind: "remote", repo: "example-org/example-model-7B", cardId: REMOTE });
    expect(page.url()).toContain(draft.id);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Step 2 and the plan loop

async function toEngineStep(page) {
  await open(page);
  await pickModel(page, "example-MadeUp-7B");
  await expect(byId(page, "wizard.model.selected")).toBeVisible();
  await byId(page, "wizard.next").click();
  await expect(byId(page, "wizard.step.engine")).toBeVisible();
  await expect(byId(page, "compat.row")).toHaveCount(4);
}

const row = (page, engine) => page.locator(`[data-testid="compat.row"][data-engine="${engine}"]`);

test("the matrix: ok only with evidence, unknown is grey with probe and override, a blocked row is disabled (R-UI-2)", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser);
  try {
    await toEngineStep(page);
    expect(callsTo(mock, "GET", `/api/models/${MAIN}/compatibility`).filter((call) => !call.query.gpus)).toHaveLength(2);
    // vllm is ok with evidence; sglang was sent as ok without evidence and reads Unknown (unverified).
    await expect(row(page, "vllm")).toHaveAttribute("data-verdict", "ok");
    await expect(row(page, "vllm").locator('[data-testid="compat.verdict"]')).toContainText("Runs");
    await expect(row(page, "vllm").locator('[data-testid="compat.evidence"]')).toContainText("Knowledge base entry");
    await expect(row(page, "sglang")).toHaveAttribute("data-verdict", "unknown");
    await expect(row(page, "sglang").locator('[data-testid="compat.verdict"]')).toHaveText("Unknown (unverified)");
    await expect(row(page, "sglang").locator('[data-testid="compat.verdict"]')).toHaveAttribute("data-status", "unknown");
    await expect(row(page, "sglang").locator('[data-testid="compat.verdict"]')).toHaveClass(/badge-neutral/);
    await expect(row(page, "sglang").locator('[data-testid="compat.unknownHint"]')).toContainText("Nothing shows that this engine supports the architecture");
    await expect(row(page, "sglang").locator('[data-testid="compat.probe"]')).toHaveText("Run the dry probe");
    await expect(row(page, "sglang").locator('[data-testid="compat.override"]')).toHaveText("Override");
    await expect(row(page, "sglang").locator('[data-testid="compat.select"]')).toHaveCount(0);
    await expect(row(page, "lmdeploy")).toHaveAttribute("data-verdict", "unknown");
    await expect(row(page, "lmdeploy").locator('[data-testid="compat.experimental"]')).toHaveText("Experimental");
    await expect(row(page, "lmdeploy").locator('[data-testid="compat.notPulled"]')).toBeVisible();
    // No green anywhere but the vllm row.
    await expect(page.locator('[data-testid="compat.row"][data-verdict="ok"]')).toHaveCount(1);
    // A blocked row is disabled and says why.
    await expect(row(page, "llamacpp")).toHaveAttribute("data-verdict", "block");
    await expect(row(page, "llamacpp").locator('[data-testid="compat.select"]')).toBeDisabled();
    await expect(row(page, "llamacpp").locator('[data-testid="compat.reasons"]')).toContainText("llama.cpp can only run GGUF files.");
    // The recommendation and why.
    await expect(row(page, "vllm")).toHaveAttribute("data-recommended", "true");
    await byId(page, "wizard.engine.why").locator("summary").click();
    await expect(byId(page, "wizard.engine.why")).toContainText("This runtime can run the model.");
    await expect(byId(page, "wizard.engine.why")).toContainText("It is the engine's default runtime.");
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("selecting a row sets engine, runtime and manager; the plan is requested once, debounced and not repeated", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await toEngineStep(page);
    expect(planCalls(mock)).toHaveLength(0);
    await row(page, "vllm").locator('[data-testid="compat.select"]').click();
    await expect(row(page, "vllm").locator('[data-testid="compat.select"]')).toHaveText("Selected");
    await expect.poll(() => planCalls(mock).length).toBe(1);
    const body = planCalls(mock)[0].body;
    expect(body).toEqual({
      engineId: "vllm",
      runtimeId: "vllm@0.28.0",
      model: { ref: "C:/fixture/models/example-MadeUp-7B" },
      instance: { mode: "replace", networkAccess: "local" },
      values: {},
    });
    await expect(byId(page, "wizard.plan-status")).toHaveAttribute("data-ok", "true");
    await expect(byId(page, "wizard.plan-label")).toHaveText("The plan is ready; no problems found.");
    const draft = JSON.parse(await storedDraft(page));
    expect(draft).toMatchObject({ engineId: "vllm", managerId: "vllm", runtimeId: "vllm@0.28.0" });
    // Selecting the same row again changes nothing and sends nothing.
    await row(page, "vllm").locator('[data-testid="compat.select"]').click();
    await page.waitForTimeout(700);
    expect(planCalls(mock)).toHaveLength(1);
    // Back and forth over the steps keeps one plan; a change sends a second one.
    await byId(page, "wizard.back").click();
    await byId(page, "wizard.next").click();
    await page.waitForTimeout(700);
    expect(planCalls(mock)).toHaveLength(1);
    // The experimental engine asks first, and adds the acknowledgement the plan needs.
    await row(page, "lmdeploy").locator('[data-testid="compat.override"]').click();
    await expect(byId(page, "wizard.engine.warn")).toBeVisible();
    await byId(page, "wizard.engine.warn").getByRole("button", { name: "Use anyway" }).click();
    await expect.poll(() => planCalls(mock).length).toBe(2);
    expect(planCalls(mock)[1].body).toMatchObject({ engineId: "lmdeploy", acknowledge: ["experimental-engine"] });
  } finally {
    await context.close();
  }
});

test("an ok:false plan renders its field errors, suggestion and blockers; a malformed request is a banner that keeps the last plan", async ({ browser }) => {
  const state = createState();
  state.plan = "plan-problems";
  const { context, page, mock } = await newPage(browser, { state });
  try {
    await toEngineStep(page);
    await row(page, "vllm").locator('[data-testid="compat.select"]').click();
    await expect.poll(() => planCalls(mock).length).toBe(1);
    await expect(byId(page, "wizard.plan-status")).toHaveAttribute("data-ok", "false");
    await expect(byId(page, "wizard.plan-label")).toHaveText("The plan has 2 problems to fix.");
    const error = byId(page, "wizard.plan-error");
    await expect(error).toHaveAttribute("data-field", "contextLength");
    await expect(error).toContainText("Context length must be at most 131072 for this model.");
    await expect(error).toContainText("Context length", { ignoreCase: false });
    await expect(error.locator('[data-testid="wizard.plan-suggestion"]')).toHaveText("Use 131072");
    const blocker = byId(page, "wizard.plan-blocker");
    await expect(blocker).toHaveAttribute("data-code", "insufficient_vram");
    await expect(blocker).toContainText("Not enough free VRAM");
    await expect(blocker.locator('[data-testid="wizard.plan-fix"]')).toHaveText("Adjust memory");
    await expect(byId(page, "wizard.plan-warnings")).toContainText("No recipe applies");
    await expect(byId(page, "wizard.plan-banner")).toHaveCount(0);
    // The suggestion applies on a click and sends a new plan with the value.
    state.plan = "plan-ok";
    await error.locator('[data-testid="wizard.plan-suggestion"]').click();
    await expect.poll(() => planCalls(mock).length).toBe(2);
    expect(planCalls(mock)[1].body.values).toEqual({ contextLength: 131072 });
    await expect(byId(page, "wizard.plan-status")).toHaveAttribute("data-ok", "true");
    await expect(byId(page, "wizard.plan-error")).toHaveCount(0);
    // A 400 is a banner; the last plan stays; Retry asks again.
    state.planStatus = 400;
    await row(page, "lmdeploy").locator('[data-testid="compat.override"]').click();
    await byId(page, "wizard.engine.warn").getByRole("button", { name: "Use anyway" }).click();
    await expect(byId(page, "wizard.plan-banner")).toContainText("The plan could not be updated");
    await expect(byId(page, "wizard.plan-status")).toHaveAttribute("data-ok", "true");
    state.planStatus = 200;
    const before = planCalls(mock).length;
    await byId(page, "wizard.plan-retry").click();
    await expect.poll(() => planCalls(mock).length).toBe(before + 1);
    await expect(byId(page, "wizard.plan-banner")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the dry probe: a plain model probes at once, a model with its own code asks first and lists the files (R-UI-9)", async ({ browser }) => {
  const state = createState();
  const { context, page, mock } = await newPage(browser, { state });
  try {
    await toEngineStep(page);
    const compatReads = () => callsTo(mock, "GET", `/api/models/${MAIN}/compatibility`).filter((call) => !call.query.gpus).length;
    const reads = compatReads();
    await row(page, "lmdeploy").locator('[data-testid="compat.probe"]').click();
    await expect.poll(() => callsTo(mock, "POST", `/api/models/${MAIN}/probe`).length).toBe(1);
    expect(callsTo(mock, "POST", `/api/models/${MAIN}/probe`)[0].body).toEqual({ engineId: "lmdeploy", runtimeId: "lmdeploy@0.18.0", allowRemoteCode: false });
    await expect(byId(page, "wizard.engine.consent")).toHaveCount(0);
    await expect(byId(page, "wizard.probe")).toHaveAttribute("data-state", "running");
    // When the job ends the matrix is read again.
    state.probe = "success";
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(byId(page, "wizard.probe")).toHaveAttribute("data-state", "success", { timeout: 15000 });
    await expect.poll(compatReads).toBeGreaterThan(reads);
  } finally {
    await context.close();
  }

  const second = await newPage(browser, { state: createState(), api: { "GET /api/m/vllm/jobs": { jobs: [] } } });
  try {
    await open(second.page, "?model=C:/fixture/models/example-custom-code&engine=lmdeploy");
    await byId(second.page, "wizard.next").click();
    await expect(row(second.page, "lmdeploy")).toBeVisible();
    await row(second.page, "lmdeploy").locator('[data-testid="compat.probe"]').click();
    const dialog = byId(second.page, "wizard.engine.consent");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("This model runs its own Python code: modeling_madeup.py, configuration_madeup.py. Continue only if you trust the publisher.");
    await expect(byId(second.page, "wizard.remote-code.files").locator("li")).toHaveText(["modeling_madeup.py", "configuration_madeup.py"]);
    expect(callsTo(second.mock, "POST", `/api/models/${CUSTOM}/probe`)).toHaveLength(0);
    // Cancel runs nothing.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(callsTo(second.mock, "POST", `/api/models/${CUSTOM}/probe`)).toHaveLength(0);
    await row(second.page, "lmdeploy").locator('[data-testid="compat.probe"]').click();
    await byId(second.page, "wizard.engine.consent").getByRole("button", { name: "Allow and run the probe" }).click();
    await expect.poll(() => callsTo(second.mock, "POST", `/api/models/${CUSTOM}/probe`).length).toBe(1);
    expect(callsTo(second.mock, "POST", `/api/models/${CUSTOM}/probe`)[0].body).toMatchObject({ engineId: "lmdeploy", allowRemoteCode: true });
  } finally {
    await second.context.close();
  }
});

// ---------------------------------------------------------------------------
// The draft

test("the draft survives a reload, and sessionStorage never holds a secret or an extraEnv value", async ({ browser }) => {
  const launch = {
    ok: true,
    launch: {
      launchId: "lch_aaaaaaaaaaaaaaaaaaaa",
      managerId: "vllm",
      spec: {
        engineId: "vllm",
        runtimeId: "vllm@0.28.0",
        model: { ref: "C:/fixture/models/example-MadeUp-7B", servedName: "example" },
        instance: { mode: "replace", id: "primary", port: 8000, networkAccess: "lan", gpuIds: ["0"] },
        values: { contextLength: 65536, apiKey: FAKE_SECRET },
        extraArgs: ["--max-log-len", "64", "--api-key", FAKE_SECRET],
        extraEnv: { MY_TOKEN: FAKE_SECRET },
        secrets: { apiKeyRef: "ref_1" },
      },
    },
  };
  const { context, page, mock } = await newPage(browser, { api: { "GET /api/m/vllm/launches/lch_aaaaaaaaaaaaaaaaaaaa": launch } });
  try {
    await open(page, "?clone=lch_aaaaaaaaaaaaaaaaaaaa&manager=vllm");
    await expect(byId(page, "wizard.model.selected")).toBeVisible();
    await expect.poll(() => planCalls(mock).length).toBeGreaterThan(0);
    const body = planCalls(mock)[0].body;
    expect(body).toMatchObject({ engineId: "vllm", instance: { mode: "replace", id: "primary", port: 8000, networkAccess: "lan", gpuIds: ["0"] }, model: { ref: "C:/fixture/models/example-MadeUp-7B", servedName: "example" } });
    // The stored text has no secret and no env value; the env name stays so it can be retyped.
    const text = await storedDraft(page);
    expect(text).not.toContain(FAKE_SECRET);
    const stored = JSON.parse(text);
    expect(stored.values).toEqual({ contextLength: 65536 });
    expect(stored.extraEnv).toEqual({ MY_TOKEN: null });
    expect(stored.extraArgs).toEqual(["--max-log-len", "64"]);
    expect(await page.evaluate(() => JSON.stringify(Object.entries(window.sessionStorage)))).not.toContain(FAKE_SECRET);
    expect(await page.evaluate(() => JSON.stringify(Object.entries(window.localStorage)))).not.toContain(FAKE_SECRET);
    // A reload brings the same draft back, on the same step.
    const id = stored.id;
    await page.reload();
    await expect(byId(page, "wizard")).toHaveAttribute("data-draft", id);
    await expect(byId(page, "wizard.model.selected")).toBeVisible();
    expect(JSON.parse(await storedDraft(page))).toMatchObject({ id, engineId: "vllm", managerId: "vllm", runtimeId: "vllm@0.28.0" });
    // ?draft=<id> loads it too; an unknown id starts a new draft and says so.
    await open(page, `?draft=${id}&step=engine`);
    await expect(byId(page, "wizard")).toHaveAttribute("data-draft", id);
    await expect(byId(page, "wizard.step.engine")).toBeVisible();
    await open(page, "?draft=wd_doesnotexist");
    await expect(byId(page, "wizard.notice")).toContainText("That draft was not found");
  } finally {
    await context.close();
  }
});

test("leaving the page with a draft asks to discard it; keeping editing stays, discarding clears the draft", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await open(page);
    await pickModel(page, "example-MadeUp-7B");
    await expect(byId(page, "wizard.model.selected")).toBeVisible();
    expect(await storedDraft(page)).not.toBeNull();
    await page.getByRole("link", { name: "Engines" }).first().click();
    const dialog = byId(page, "wizard.discard");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Discard this deployment draft?");
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/deployments\/new/);
    expect(await storedDraft(page)).not.toBeNull();
    await page.getByRole("link", { name: "Engines" }).first().click();
    await byId(page, "wizard.discard").getByRole("button", { name: "Discard" }).click();
    await expect(page).toHaveURL(/\/engines$/);
    expect(await storedDraft(page)).toBeNull();
  } finally {
    await context.close();
  }
});

test("an untouched wizard leaves without asking", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await open(page);
    await page.getByRole("link", { name: "Engines" }).first().click();
    await expect(page).toHaveURL(/\/engines$/);
    await expect(byId(page, "wizard.discard")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Copy, layout and accessibility

for (const locale of ["en-US", "zh-CN"]) {
  test(`${locale}: steps 1 and 2 show no raw keys and the right language`, async ({ browser }) => {
    const { context, page } = await newPage(browser, { locale });
    try {
      await open(page);
      await pickModel(page, "example-MadeUp-7B");
      await expect(byId(page, "wizard.gpu-fit.item")).toHaveCount(2);
      let text = await page.locator("main").innerText();
      expect(text, `${locale} step 1`).not.toMatch(RAW_KEY);
      if (locale === "en-US") expect(text).not.toMatch(HAN);
      else {
        expect(text).toMatch(HAN);
        await expect(byId(page, "model-card.role")).toHaveText("主模型");
        await expect(page.locator('[data-fact="family"] [data-confidence]')).toHaveText("按名称推测");
      }
      await byId(page, "wizard.next").click();
      await expect(byId(page, "compat.row")).toHaveCount(4);
      text = await page.locator("main").innerText();
      expect(text, `${locale} step 2`).not.toMatch(RAW_KEY);
      if (locale === "en-US") expect(text).not.toMatch(HAN);
      else {
        await expect(row(page, "sglang").locator('[data-testid="compat.verdict"]')).toHaveText("未知（未验证）");
        await expect(row(page, "sglang").locator('[data-testid="compat.probe"]')).toHaveText("运行预检探针");
      }
    } finally {
      await context.close();
    }
  });
}

for (const [sizeName, size] of Object.entries(SIZES)) {
  for (const theme of ["light", "dark"]) {
    test(`${sizeName} ${theme}: both steps fit the screen and pass the accessibility checks`, async ({ browser }) => {
      const state = createState();
      state.plan = "plan-problems";
      const { context, page } = await newPage(browser, { size, theme, state });
      try {
        await open(page);
        await pickModel(page, "example-MadeUp-7B");
        await expect(byId(page, "wizard.gpu-fit.item")).toHaveCount(2);
        await expectNoOverflow(page);
        await expectNoA11yViolations(page, { label: `wizard model ${theme} ${sizeName}` });
        await byId(page, "wizard.next").click();
        await expect(byId(page, "compat.row")).toHaveCount(4);
        await row(page, "vllm").locator('[data-testid="compat.select"]').click();
        await expect(byId(page, "wizard.plan-error")).toBeVisible();
        await expectNoOverflow(page);
        await expectNoA11yViolations(page, { label: `wizard engine ${theme} ${sizeName}` });
        await row(page, "lmdeploy").locator('[data-testid="compat.override"]').click();
        await expect(byId(page, "wizard.engine.warn")).toBeVisible();
        await expectNoA11yViolations(page, { label: `wizard warning dialog ${theme} ${sizeName}` });
      } finally {
        await context.close();
      }
    });
  }
}
