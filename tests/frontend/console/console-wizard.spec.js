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
//
// Part 2 (CON-11b; 02 §18 R-UI-3, R-UI-4) is step 3: instance, GPUs, goal chips
// that call launch/recommend and show plan cards (validated state, trade-offs,
// a fit bar), a pick that shows a diff before Apply sets the planner provenance,
// the fit bar under contextLength that follows the plan, the fit solver over a
// mocked fit-grid with its suggestion-chip fallback on 404, a label for every
// memory policy, the RAM bar on a spill, and the copy in both languages.
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
    await expect(byId(page, "model-card.fact").filter({ hasText: "14 GiB" })).toHaveCount(1);
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
    await expect.poll(() => callsTo(mock, "POST", "/api/models/inspect").map((call) => call.body)).toEqual([{ source: "huggingface", repo: "example-org/example-model-7B", revision: "main" }]);
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
    // Step 1 already read the host-wide matrix for the fit badges; step 2 reuses it while it is fresh (at most one more read).
    const wide = callsTo(mock, "GET", `/api/models/${MAIN}/compatibility`).filter((call) => !call.query.gpus).length;
    expect(wide).toBeGreaterThanOrEqual(1);
    expect(wide).toBeLessThanOrEqual(2);
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

// ---------------------------------------------------------------------------
// Part 2: step 3, resources, plans and fit (CON-11b)

const RES_DRAFT_ID = "wd_resources0001";
const POLICIES = ["device-fraction", "static-fraction-of-free", "free-fraction-after-weights", "weights-plus-kv", "gguf-estimate", "measured", "server-reported"];
const POLICY_LABEL = {
  "device-fraction": ["Fraction of the whole GPU", "整卡比例"],
  "static-fraction-of-free": ["Fraction of free memory", "空闲显存比例"],
  "free-fraction-after-weights": ["Fraction left after the weights", "权重后剩余比例"],
  "weights-plus-kv": ["Weights plus KV", "权重加 KV"],
  "gguf-estimate": ["GGUF estimate", "GGUF 估算"],
  measured: ["Measured on this host", "本机实测"],
  "server-reported": ["Reported by the engine", "引擎上报"],
};
const RAW_KEY_2 = /\bmodels\.(?:wizard|card|compat|confidence|role|verdict|remoteCode|goal|fit|plan)\.[A-Za-z]/;

function resourcesDraft(patch = {}) {
  return JSON.stringify({
    v: 1,
    id: RES_DRAFT_ID,
    step: "resources",
    modelRef: { kind: "local", entryId: null, path: "C:/fixture/models/example-MadeUp-7B", cardId: MAIN },
    engineId: "vllm",
    managerId: "vllm",
    runtimeId: "vllm@0.28.0",
    gpus: ["0"],
    ...patch,
  });
}

function resourcesState() {
  return { ...createState(), plan: "plan-resources", policy: "static-fraction-of-free", spill: false, grid: true, recommend: 200, busyPorts: [], blockAbove: 64000 };
}

// The launch plan the mocked manager answers: the memory follows the context length asked for, so the fit bar has something to follow.
function resourcesPlan(state, body) {
  const plan = wizard("plan-resources");
  const asked = body?.values?.contextLength;
  const context = Number(asked && typeof asked === "object" ? asked.value : asked) || 131072;
  const kv = Math.round((20000 * context) / 131072);
  const total = 30000 + kv + 8000 + 1000 + 500 + 500;
  plan.values.contextLength = { value: context, source: asked ? "user" : "engine-default" };
  Object.assign(plan.memory.breakdown, { kv });
  plan.memory.perGpuMb = { 0: total };
  plan.memory.admissionRequestMb = total;
  plan.memory.headroomMb = Math.max(0, 64000 - total);
  plan.memory.policy = state.policy;
  if (state.spill) {
    plan.memory.spill = true;
    plan.memory.ram = { weights: 0, experts: 2048, kv: 0 };
  }
  plan.admission = total > state.blockAbove ? { verdict: "block", message: "The reservation is larger than the free memory." } : { verdict: "ok", message: "" };
  return plan;
}

function resourcesApi(state, extra = {}) {
  return {
    "POST /api/m/vllm/launch/plan": (request, route, record) => resourcesPlan(state, record.body),
    "POST /api/m/llama/launch/plan": () => fixture("plan-llamacpp"),
    "GET /api/m/llama/engines/llamacpp/schema": fixture("schema-llamacpp"),
    "GET /api/m/vllm/port-check": (request, route, record) => {
      const port = Number(record.query.port);
      return state.busyPorts.includes(port) ? { port, available: false, reason: "os", detail: `Port ${port} is used by another process.` } : { port, available: true, detail: `Port ${port} is free.` };
    },
    "POST /api/launch/recommend": () => (state.recommend === 200 ? wizard("recommend") : { status: state.recommend, body: { ok: false, error: { code: state.recommend === 404 ? "endpoint_unavailable" : "internal_error", message: "No." } } }),
    [`POST /api/models/${MAIN}/fit-grid`]: () => (state.grid ? wizard("fit-grid") : NOT_FOUND),
    ...extra,
  };
}

async function openResources({ browser, state = resourcesState(), draft, api = {}, size, theme, locale }) {
  const made = await newPage(browser, { api: resourcesApi(state, api), state, size, theme, locale, storage: { "console.wizard.draft": resourcesDraft(draft) } });
  await open(made.page);
  await expect(byId(made.page, "wizard")).toHaveAttribute("data-step", "resources");
  await expect(byId(made.page, "wizard.step.resources")).toBeVisible();
  return made;
}

const contextInput = (page) => page.locator('[data-field="contextLength"] [data-testid="schema-form.number"]');
const lastPlanBody = (mock) => planCalls(mock).at(-1)?.body;
const draftOf = async (page) => JSON.parse(await storedDraft(page));
const recommendCalls = (mock) => callsTo(mock, "POST", "/api/launch/recommend");
const goal = (page, name) => page.locator(`[data-testid="wizard.res.goal"][data-goal="${name}"]`);
const card = (page, planId) => page.locator(`[data-testid="plan-cards.card"][data-plan-id="${planId}"]`);
const cellRows = (dialog) => dialog.locator('[data-testid="diff-table.row"]').evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("th, td")].map((cell) => cell.textContent.trim())));

test("step 3: instance, GPU cards, goal chips, settings and the resource panel are in place; the port is checked live", async ({ browser }) => {
  const state = resourcesState();
  state.busyPorts = [8001];
  const { context, page, mock, failures } = await openResources({ browser, state });
  try {
    await expect(byId(page, "wizard.res.instance")).toBeVisible();
    await expect(page.locator('[data-testid="wizard.res.mode-option"][data-mode="replace"]')).toHaveAttribute("aria-pressed", "true");
    await expect(byId(page, "wizard.res.gpu")).toHaveCount(2);
    await expect(page.locator('[data-testid="wizard.res.gpu"][data-gpu="0"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-testid="wizard.res.gpu"][data-gpu="0"]')).toContainText("88 GiB free of 96 GiB");
    await expect(page.locator('[data-testid="wizard.res.gpu"][data-gpu="0"]')).toContainText("8 GiB used by others");
    await expect(byId(page, "wizard.res.goal")).toHaveCount(4);
    await expect(byId(page, "wizard.res.goal").first()).toHaveText("Longest context");
    await expect(byId(page, "wizard.res.goal").nth(2)).toHaveText("High throughput");
    // The form shows this step's groups only.
    await expect(contextInput(page)).toBeVisible();
    await expect(page.locator('[data-field="reasoningParser"]')).toHaveCount(0);
    // The plan drives the panel: verdict, GPU bar, KV pool and the policy label.
    await expect(byId(page, "wizard.res.verdict")).toContainText("Fits");
    await expect(byId(page, "wizard.res.gpu-bar")).toHaveCount(1);
    await expect(byId(page, "wizard.res.kv-pool")).toHaveText("Reserves 58.6 GiB → KV pool ≈ 19.5 GiB ≈ 200,000 tokens ≈ 3 full-length requests");
    // The port is checked as it is typed (debounced), and a taken port says so.
    await byId(page, "wizard.res.port").fill("8002");
    await expect(byId(page, "wizard.res.port-status")).toHaveAttribute("data-state", "free");
    await byId(page, "wizard.res.port").fill("8001");
    await expect(byId(page, "wizard.res.port-status")).toHaveAttribute("data-state", "busy");
    await expect(byId(page, "wizard.res.port-status")).toContainText("The port is taken: Port 8001 is used by another process.");
    expect(callsTo(mock, "GET", "/api/m/vllm/port-check").map((call) => call.query.port)).toEqual(["8002", "8001"]);
    await expect.poll(async () => (await draftOf(page)).instance.port).toBe(8001);
    // A second GPU joins the set, and the plan is asked again for both.
    await page.locator('[data-testid="wizard.res.gpu"][data-gpu="1"]').click();
    await expect.poll(async () => (await draftOf(page)).gpus).toEqual(["0", "1"]);
    await expect.poll(() => lastPlanBody(mock)?.instance?.gpuIds).toEqual(["0", "1"]);
    // Parallel mode drops the replace target.
    await expect(byId(page, "wizard.res.target")).toBeVisible();
    await page.locator('[data-testid="wizard.res.mode-option"][data-mode="parallel"]').click();
    await expect(byId(page, "wizard.res.target")).toHaveCount(0);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a goal chip calls launch/recommend; the cards show validated state, trade-offs and a fit bar, and hand catalog ids over unchanged (R-UI-3, R-UI-4)", async ({ browser }) => {
  const { context, page, mock, failures } = await openResources({ browser });
  try {
    expect(recommendCalls(mock)).toHaveLength(0);
    await goal(page, "balanced").click();
    await expect(byId(page, "plan-cards.card")).toHaveCount(3);
    expect(recommendCalls(mock)).toHaveLength(1);
    expect(recommendCalls(mock)[0].body).toEqual({ cardId: MAIN, goal: "balanced", gpuSets: [["0"]] });
    await expect(goal(page, "balanced")).toHaveAttribute("aria-pressed", "true");
    await expect(byId(page, "plan-cards.set")).toHaveAttribute("data-gpus", "0");
    await expect(byId(page, "wizard.res.plan-notes")).toContainText("Plans are estimated on empty GPUs.");
    // validated: ok, null (not validated) and failed with its errors.
    await expect(card(page, "pl_1").locator('[data-testid="plan-cards.validated"]')).toHaveAttribute("data-state", "ok");
    await expect(card(page, "pl_1")).toContainText("Validated");
    await expect(card(page, "pl_2").locator('[data-testid="plan-cards.validated"]')).toHaveAttribute("data-state", "unvalidated");
    await expect(card(page, "pl_2")).toContainText("Not validated");
    await expect(card(page, "pl_3").locator('[data-testid="plan-cards.validated"]')).toHaveAttribute("data-state", "failed");
    await expect(card(page, "pl_3")).toContainText("Validation failed");
    await expect(card(page, "pl_3").locator('[data-testid="plan-cards.errors"]')).toContainText("The context is above the model's native limit.");
    // Trade-offs, engine@runtime and the title.
    await expect(card(page, "pl_1").locator('[data-testid="plan-cards.tradeoffs"]')).toContainText("The KV cache uses fp8");
    await expect(card(page, "pl_2").locator('[data-testid="plan-cards.engine"]')).toHaveText("llamacpp@b6000");
    await expect(card(page, "pl_1").locator('[data-testid="plan-cards.title"]')).toContainText("vLLM · 256K context");
    // Each card has a fit bar with the six segments; a spill adds the RAM bar.
    await expect(card(page, "pl_1").locator('[data-testid="fit-bar.segment"]')).toHaveCount(6);
    await expect(card(page, "pl_1").locator('[data-testid="fit-bar.ram"]')).toHaveCount(0);
    await expect(card(page, "pl_2").locator('[data-testid="fit-bar.ram"]')).toBeVisible();
    await expect(card(page, "pl_2").locator('[data-testid="fit-bar.spill"]')).toContainText("Some weights or KV sit in system RAM; expect lower speed");
    // The catalog ids are the planner's, not renamed.
    const params = await card(page, "pl_2").locator('[data-testid="plan-cards.value"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-param")));
    expect(params).toEqual(["contextLength", "concurrency", "llamacpp.cacheTypeK", "llamacpp.nCpuMoe"]);
    // Choosing another goal asks again.
    await goal(page, "throughput").click();
    await expect.poll(() => recommendCalls(mock).length).toBe(2);
    expect(recommendCalls(mock)[1].body.goal).toBe("throughput");
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a pick shows a diff first; only Apply copies the values in, marked planner (provenance), and the plan request carries them", async ({ browser }) => {
  const { context, page, mock, failures } = await openResources({ browser });
  try {
    await goal(page, "balanced").click();
    await card(page, "pl_1").locator('[data-testid="plan-cards.pick"]').click();
    const dialog = byId(page, "wizard.res.diff");
    await expect(dialog).toBeVisible();
    await expect(byId(page, "wizard.res.engine-change")).toHaveCount(0);
    // The diff is against the current values: context 131072 → 262144, concurrency 1 → 4, KV auto → fp8.
    expect(await cellRows(dialog)).toEqual([
      ["Context length (per request)", "131072", "262144", "planner"],
      ["Max concurrent requests", "1", "4", "planner"],
      ["KV cache precision", "auto", "fp8", "planner"],
    ]);
    // Nothing is applied yet.
    expect((await draftOf(page)).values ?? {}).toEqual({});
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect((await draftOf(page)).values ?? {}).toEqual({});
    // Apply.
    await card(page, "pl_1").locator('[data-testid="plan-cards.pick"]').click();
    await byId(page, "wizard.res.diff").getByRole("button", { name: "Apply plan" }).click();
    await expect(byId(page, "wizard.res.diff")).toBeHidden();
    const stored = await draftOf(page);
    expect(stored.values).toEqual({
      contextLength: { value: 262144, source: "planner" },
      concurrency: { value: 4, source: "planner" },
      kvCacheDtype: { value: "fp8", source: "planner" },
    });
    expect(stored.goal).toBe("balanced");
    expect(stored.gpus).toEqual(["0"]);
    await expect(card(page, "pl_1")).toHaveAttribute("data-selected", "true");
    // The form shows the planner provenance and the next plan request carries it.
    await expect(page.locator('[data-field="contextLength"]')).toHaveAttribute("data-source", "planner");
    await expect(contextInput(page)).toHaveValue("262144");
    await expect.poll(() => lastPlanBody(mock)?.values?.contextLength).toEqual({ value: 262144, source: "planner" });
    expect(lastPlanBody(mock).values.kvCacheDtype).toEqual({ value: "fp8", source: "planner" });
    // Editing an applied value makes it the user's own.
    await contextInput(page).fill("65536");
    await expect.poll(async () => (await draftOf(page)).values.contextLength).toBe(65536);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a plan of another engine confirms the engine change first, then shows the diff; Apply switches engine, runtime and manager", async ({ browser }) => {
  const { context, page, mock, failures } = await openResources({ browser, draft: { values: { "vllm.cpuOffloadGb": 4, contextLength: 4096 } } });
  try {
    await goal(page, "balanced").click();
    await card(page, "pl_2").locator('[data-testid="plan-cards.pick"]').click();
    const confirm = byId(page, "wizard.res.engine-change");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("This plan runs on llamacpp@b6000; you chose vllm@0.28.0.");
    await expect(byId(page, "wizard.res.diff")).toHaveCount(0);
    await confirm.getByRole("button", { name: "Review the changes" }).click();
    const dialog = byId(page, "wizard.res.diff");
    await expect(dialog).toBeVisible();
    const first = dialog.locator('[data-testid="diff-table.row"]').first();
    await expect(first).toContainText("Engine");
    await expect(first).toContainText("vllm@0.28.0");
    await expect(first).toContainText("llamacpp@b6000");
    expect((await draftOf(page)).engineId).toBe("vllm");
    await dialog.getByRole("button", { name: "Apply plan" }).click();
    await expect.poll(async () => (await draftOf(page)).engineId).toBe("llamacpp");
    const stored = await draftOf(page);
    expect(stored).toMatchObject({ managerId: "llama", runtimeId: "llamacpp@b6000", recipeId: "", goal: "balanced", gpus: ["0"] });
    expect(stored.values["llamacpp.nCpuMoe"]).toEqual({ value: 2, source: "planner" });
    expect(stored.values).not.toHaveProperty("vllm.cpuOffloadGb");
    expect(stored.values.contextLength).toEqual({ value: 65536, source: "planner" });
    // The plan is now asked of the llama manager.
    await expect.poll(() => callsTo(mock, "POST", "/api/m/llama/launch/plan").length).toBeGreaterThan(0);
    expect(callsTo(mock, "POST", "/api/m/llama/launch/plan").at(-1).body).toMatchObject({ engineId: "llamacpp", runtimeId: "llamacpp@b6000" });
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("cancelling the engine change leaves the draft untouched", async ({ browser }) => {
  const { context, page } = await openResources({ browser });
  try {
    await goal(page, "balanced").click();
    await card(page, "pl_2").locator('[data-testid="plan-cards.pick"]').click();
    await byId(page, "wizard.res.engine-change").getByRole("button", { name: "Cancel" }).click();
    await expect(byId(page, "wizard.res.engine-change")).toBeHidden();
    await expect(byId(page, "wizard.res.diff")).toHaveCount(0);
    expect(await draftOf(page)).toMatchObject({ engineId: "vllm", managerId: "vllm" });
  } finally {
    await context.close();
  }
});

test("recommend failures: a missing endpoint says so, an error is a banner with Retry", async ({ browser }) => {
  const state = resourcesState();
  state.recommend = 404;
  const { context, page, mock } = await openResources({ browser, state });
  try {
    await goal(page, "low-vram").click();
    await expect(byId(page, "wizard.res.goal-unavailable")).toHaveText("This platform version cannot recommend plans yet.");
    state.recommend = 500;
    await goal(page, "balanced").click();
    await expect(byId(page, "wizard.res.goal-error")).toBeVisible();
    state.recommend = 200;
    await byId(page, "wizard.res.goal-retry").click();
    await expect(byId(page, "plan-cards.card")).toHaveCount(3);
    expect(recommendCalls(mock).map((call) => call.body.goal)).toEqual(["low-vram", "balanced", "balanced"]);
  } finally {
    await context.close();
  }
});

test("the fit bar under contextLength follows the debounced plan (R-UI-3)", async ({ browser }) => {
  const { context, page, mock, failures } = await openResources({ browser });
  try {
    const bar = byId(page, "wizard.res.context-fitbar");
    await expect(bar).toBeVisible();
    await expect(page.locator('[data-field="contextLength"] [data-testid="wizard.res.context-fitbar"]')).toHaveCount(1);
    await expect(bar.locator('[data-testid="fit-bar.segment"]')).toHaveCount(6);
    const kinds = await bar.locator('[data-testid="fit-bar.segment"]').evaluateAll((spans) => spans.map((span) => span.getAttribute("data-kind")));
    expect(kinds).toEqual(["weights", "kv", "activations", "draft", "mmproj", "headroom"]);
    await expect(bar).toHaveAttribute("data-used", "60000");
    await expect(bar.locator('[data-kind="kv"]').first()).toHaveAttribute("data-mb", "20000");
    await expect(bar.locator('[data-testid="fit-bar.legend"][data-kind="activations"]')).toContainText("Activations & graphs");
    // A longer context: the plan is asked once more (debounced), the KV segment grows and the verdict turns.
    const before = planCalls(mock).length;
    await contextInput(page).fill("262144");
    await expect(bar).toHaveAttribute("data-used", "80000");
    await expect(bar.locator('[data-kind="kv"]').first()).toHaveAttribute("data-mb", "40000");
    expect(planCalls(mock).length - before).toBe(1);
    await expect(byId(page, "wizard.res.verdict")).toContainText("Does not fit");
    await expect(byId(page, "wizard.res.admission-message")).toContainText("The reservation is larger than the free memory.");
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a spill adds the RAM bar and the spill note to the fit bar and the resource panel", async ({ browser }) => {
  const state = resourcesState();
  const { context, page } = await openResources({ browser, state });
  try {
    await expect(byId(page, "fit-bar.ram")).toHaveCount(0);
    state.spill = true;
    await contextInput(page).fill("131071");
    await expect(byId(page, "wizard.res.context-fitbar").locator('[data-testid="fit-bar.ram"]')).toBeVisible();
    await expect(byId(page, "wizard.res.context-fitbar").locator('[data-testid="fit-bar.spill"]')).toContainText("Some weights or KV sit in system RAM");
    await expect(byId(page, "wizard.res.ram").locator('[data-testid="fit-bar.ram-segment"]')).toHaveCount(3);
    await expect(byId(page, "wizard.res.ram").locator('[data-testid="fit-bar.ram-segment"][data-kind="experts"]')).toHaveAttribute("data-mb", "2048");
    await expect(byId(page, "wizard.res.ram")).toContainText("Expert weights in RAM");
  } finally {
    await context.close();
  }
});

test("the fit solver renders the fit-grid; a cell opens a diff, then Apply sets the three settings", async ({ browser }) => {
  const { context, page, mock, failures } = await openResources({ browser });
  try {
    await expect(byId(page, "wizard.res.solver")).toHaveAttribute("data-mode", "grid");
    const calls = callsTo(mock, "POST", `/api/models/${MAIN}/fit-grid`);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ engineId: "vllm", runtimeId: "vllm@0.28.0", gpuIds: ["0"], kvDtypes: ["auto", "fp8", "fp8_e5m2"], concurrency: [1, 2, 4, 8] });
    await expect(byId(page, "fit-solver.cell")).toHaveCount(8);
    // Color and text: fits, uses RAM, does not fit; the limit that stops the next step is written out.
    const cellAt = (kv, count) => page.locator(`[data-testid="fit-solver.cell"][data-kv="${kv}"][data-concurrency="${count}"]`);
    await expect(cellAt("auto", 1)).toHaveAttribute("data-tone", "fits");
    await expect(cellAt("auto", 1)).toContainText("256K");
    await expect(cellAt("auto", 1)).toContainText("At the model's own limit");
    await expect(cellAt("fp8", 4)).toHaveAttribute("data-tone", "spill");
    await expect(cellAt("fp8", 4)).toContainText("Uses RAM");
    await expect(cellAt("auto", 8)).toHaveAttribute("data-tone", "none");
    await expect(cellAt("auto", 8)).toBeDisabled();
    await expect(cellAt("auto", 4)).toContainText("Limited by VRAM");
    await expect(cellAt("auto", 1)).toHaveAttribute("data-current", "true");
    // A cell opens the diff; Apply sets context, concurrency and KV dtype as the user's own values.
    await cellAt("fp8", 2).click();
    const dialog = byId(page, "fit-solver.dialog");
    await expect(dialog).toBeVisible();
    expect(await cellRows(dialog)).toEqual([
      ["Context length (per request)", "131072", "262144"],
      ["Max concurrent requests", "1", "2"],
      ["KV cache precision", "auto", "fp8"],
    ]);
    expect((await draftOf(page)).values ?? {}).toEqual({});
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await draftOf(page)).values).toEqual({ contextLength: 262144, concurrency: 2, kvCacheDtype: "fp8" });
    await expect.poll(() => lastPlanBody(mock)?.values).toMatchObject({ contextLength: 262144, concurrency: 2, kvCacheDtype: "fp8" });
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("without fit-grid (404) the solver falls back to the FitResult suggestions as Apply chips with their size", async ({ browser }) => {
  const state = resourcesState();
  state.grid = false;
  const { context, page, failures } = await openResources({ browser, state });
  try {
    await expect(byId(page, "wizard.res.solver")).toHaveAttribute("data-mode", "suggestions");
    await expect(byId(page, "fit-solver.unavailable")).toBeVisible();
    await expect(byId(page, "fit-solver.cell")).toHaveCount(0);
    const chips = byId(page, "fit-solver.chip");
    await expect(chips).toHaveCount(2);
    await expect(chips.first()).toContainText("fp8 KV saves 8 GiB");
    await expect(chips.first().locator('[data-testid="fit-solver.delta"]')).toHaveText("−8 GiB");
    await chips.first().click();
    await expect.poll(async () => (await draftOf(page)).values).toEqual({ kvCacheDtype: "fp8" });
    await expect(page.locator('[data-field="kvCacheDtype"]')).toHaveAttribute("data-source", "user");
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("every memory.policy value has a label (with its name in mono); an unknown policy shows only its raw name", async ({ browser }) => {
  const state = resourcesState();
  const { context, page } = await openResources({ browser, state });
  try {
    let asked = 100000;
    for (const policy of [...POLICIES, "future-policy"]) {
      state.policy = policy;
      asked += 1;
      await contextInput(page).fill(String(asked));
      const label = page.locator(`[data-testid="wizard.res.policy"][data-policy="${policy}"]`);
      await expect(label).toBeVisible();
      if (policy === "future-policy") {
        await expect(label).toHaveText("future-policy");
        await expect(label.locator('[data-testid="wizard.res.policy-raw"]')).toBeVisible();
      } else {
        await expect(label).toContainText(POLICY_LABEL[policy][0]);
        await expect(label.locator("code")).toHaveText(policy);
      }
    }
  } finally {
    await context.close();
  }
});

for (const locale of ["en-US", "zh-CN"]) {
  test(`${locale}: step 3, its plan cards, fit bar and solver show no raw keys and the right language`, async ({ browser }) => {
    const state = resourcesState();
    state.spill = true;
    const { context, page } = await openResources({ browser, state, locale });
    try {
      await goal(page, "max-context").click();
      await expect(byId(page, "plan-cards.card")).toHaveCount(3);
      await expect(byId(page, "fit-solver.cell")).toHaveCount(8);
      await expect(byId(page, "fit-bar.ram").first()).toBeVisible();
      const text = await page.locator("main").innerText();
      expect(text, `${locale} step 3`).not.toMatch(RAW_KEY_2);
      if (locale === "en-US") {
        expect(text).not.toMatch(HAN);
        await expect(goal(page, "low-vram")).toHaveText("Low VRAM");
        await expect(card(page, "pl_1")).toContainText("Validated");
      } else {
        expect(text).toMatch(HAN);
        await expect(goal(page, "max-context")).toHaveText("最长上下文");
        await expect(goal(page, "balanced")).toHaveText("均衡");
        await expect(goal(page, "throughput")).toHaveText("高吞吐");
        await expect(goal(page, "low-vram")).toHaveText("省显存");
        await expect(card(page, "pl_1")).toContainText("已校验");
        await expect(card(page, "pl_2")).toContainText("未校验");
        await expect(card(page, "pl_3")).toContainText("校验未通过");
        await expect(byId(page, "wizard.res.verdict")).toContainText("可启动");
        await expect(card(page, "pl_2").locator('[data-testid="fit-bar.spill"]')).toContainText("部分权重或 KV 放在内存，速度会下降");
        await expect(byId(page, "wizard.res.policy")).toContainText("空闲显存比例");
        await expect(byId(page, "wizard.res.kv-pool")).toContainText("预留 58.6 GiB → KV 池约 19.5 GiB ≈ 200,000 tokens ≈ 3 个满长请求");
        await expect(byId(page, "fit-bar.legend").first()).toContainText("权重");
      }
    } finally {
      await context.close();
    }
  });
}

for (const [sizeName, size] of Object.entries(SIZES)) {
  for (const theme of ["light", "dark"]) {
    test(`${sizeName} ${theme}: step 3 fits the screen and passes the accessibility checks`, async ({ browser }) => {
      const state = resourcesState();
      state.spill = true;
      const { context, page } = await openResources({ browser, state, size, theme });
      try {
        await goal(page, "balanced").click();
        await expect(byId(page, "plan-cards.card")).toHaveCount(3);
        if (sizeName === "phone") {
          // Below md the resource panel is a chip that opens a Drawer.
          await expect(byId(page, "wizard.res.aside")).toHaveCount(0);
          await expect(byId(page, "wizard.res.chip")).toContainText("Resources");
          await expect(byId(page, "wizard.res.chip")).toContainText("Fits");
        } else {
          await expect(byId(page, "wizard.res.aside")).toBeVisible();
          await expect(byId(page, "wizard.res.chip")).toHaveCount(0);
        }
        await expectNoOverflow(page);
        await expectNoA11yViolations(page, { label: `wizard resources ${theme} ${sizeName}` });
        if (sizeName === "phone") {
          await byId(page, "wizard.res.chip").click();
          const drawer = byId(page, "wizard.res.drawer");
          await expect(drawer).toBeVisible();
          await expect(drawer.locator('[data-testid="wizard.res.verdict"]')).toContainText("Fits");
          await expect(drawer.locator('[data-testid="fit-solver.cell"]')).toHaveCount(8);
          await expectNoOverflow(page);
          await expectNoA11yViolations(page, { label: `wizard resources drawer ${theme} ${sizeName}` });
        } else {
          await card(page, "pl_1").locator('[data-testid="plan-cards.pick"]').click();
          await expect(byId(page, "wizard.res.diff")).toBeVisible();
          await expectNoA11yViolations(page, { label: `wizard plan diff ${theme} ${sizeName}` });
        }
      } finally {
        await context.close();
      }
    });
  }
}
