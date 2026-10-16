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
//
// Part 3 (CON-12; 02 §18 R-UI-6) is steps 4 to 7 and the quick paths: the capability
// settings, the detected template format and the companions that pair; access (a red
// warning for LAN without a key); Review (overrides with reasons, the image step and
// its pull, the redacted command, the diff vs the last launch, Launch gated on errors,
// blockers and a block verdict, the replace confirmation); Launch (expectedPlanHash, a
// 409 plan_changed back to Review with a diff, every phase from pushed jobs events, the
// root-cause card for a failed launch or probe and its suggestions); start-last-used.
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

// ---------------------------------------------------------------------------
// Part 3: steps 4 to 7 and the quick paths (CON-12)

const REV_DRAFT_ID = "wd_review000001";
const REV_PATH = "C:/fixture/models/example-MadeUp-7B";
const JOB_ID = "job_launch_1";
const PULL_JOB_ID = "dl_pull_1";
const FAKE_LEAK = "fake-live-key-value";
const RAW_KEY_3 = /\b(?:models\.(?:wizard|rootCause|card)|engines\.(?:phase|plan|err|job|group)|common\.(?:command|diff))\.[A-Za-z]/;
const PHASES = ["pull", "admission", "container", "weights", "kv", "graphs", "api", "probe", "ready"];
const PHASE_LABEL = {
  pull: ["Pulling image", "拉取镜像"], admission: ["VRAM admission", "显存准入"], container: ["Creating container", "创建容器"],
  weights: ["Loading weights", "加载权重"], kv: ["Allocating KV cache", "分配 KV 缓存"], graphs: ["Capturing CUDA graphs", "捕获 CUDA graphs"],
  api: ["Starting API server", "启动 API 服务"], probe: ["Generation self-test", "生成自检"], ready: ["Ready", "就绪"],
};

// Installed before the console loads: the console's EventSource is a fake the test pushes frames into (window.__emit).
function installFakeEventSource() {
  const sources = [];
  let counter = 0;
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      sources.push(this);
      setTimeout(() => {
        this.readyState = 1;
        if (typeof this.onopen === "function") this.onopen({});
      }, 0);
    }
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    }
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = FakeEventSource;
  window.__emit = (type, data, source = "vllm") => {
    counter += 1;
    const envelope = { id: String(counter), type, at: new Date().toISOString(), source, data };
    for (const es of sources) {
      for (const handler of es.listeners[type] || []) handler({ data: JSON.stringify(envelope), lastEventId: String(counter) });
    }
  };
}

function reviewDraft(patch = {}) {
  return JSON.stringify({
    v: 1,
    id: REV_DRAFT_ID,
    step: "review",
    modelRef: { kind: "local", entryId: null, path: REV_PATH, cardId: MAIN },
    engineId: "vllm",
    managerId: "vllm",
    runtimeId: "vllm@0.28.0",
    gpus: ["0"],
    instance: { mode: "replace", targetInstanceId: "primary", servedName: "example-served", port: 8000 },
    ...patch,
  });
}

function reviewState() {
  return {
    ...createState(),
    plan: "plan-review",
    replace: true,
    planPatch: null,
    planHash: "sha256:review01",
    context: null,
    start: "ok",
    startHash: null,
    launches: "ok",
    jobs: [],
    pulled: false,
    signatures: "ok",
    idle: { enabled: true, idleMinutes: 30, wakeOnDemand: true, excludeModels: [] },
  };
}

// The plan the mocked manager answers; `planPatch` changes it for one scenario.
function reviewPlan(state) {
  const plan = wizard(state.plan);
  if (state.plan === "plan-review") {
    plan.planHash = state.planHash;
    if (!state.replace) plan.steps = plan.steps.filter((step) => step.kind !== "replace");
    if (state.context) plan.values.contextLength = { value: state.context, source: "recipe" };
  }
  if (state.pulled && state.plan === "plan-pull-required") {
    Object.assign(plan, { ok: true, planHash: "sha256:pulled01", blockers: [] });
    plan.steps[0] = { ...plan.steps[0], required: false };
  }
  return state.planPatch ? { ...plan, ...state.planPatch } : plan;
}

function jobSummary(patch = {}) {
  return {
    id: JOB_ID,
    type: "serve",
    status: "running",
    progress: { phase: "pull", percent: 10, stageKey: "image", stageText: { zh: "检查运行时镜像", en: "Checking the runtime image" } },
    lifecycle: { phase: "pull", phaseHistory: [{ phase: "pull", at: "2026-10-16T00:00:00Z", durationMs: null }] },
    logs: ["checking the image"],
    ...patch,
  };
}

function reviewApi(state, extra = {}) {
  const runtime = encodeURIComponent("example@experimental");
  return {
    "POST /api/m/vllm/launch/plan": () => reviewPlan(state),
    "GET /api/m/vllm/launches": () => (state.launches === "ok" ? wizard("launches") : NOT_FOUND),
    "GET /api/m/vllm/recent-launches": { launches: [] },
    "GET /api/m/vllm/idle-unload": () => ({ ok: true, settings: state.idle, sleeping: [] }),
    "GET /api/m/vllm/instances": { instances: [] },
    "GET /api/m/vllm/jobs": () => ({ jobs: state.jobs }),
    [`GET /api/m/vllm/jobs/${JOB_ID}`]: () => ({ job: jobSummary({ logs: ["line one of the launch log", "line two of the launch log"] }) }),
    "POST /api/m/vllm/start": (request, route, record) => {
      if (state.start === "conflict") {
        state.start = "ok";
        state.context = 65536;
        state.planHash = "sha256:review02";
        return { status: 409, body: { ok: false, code: "plan_changed", error: "The launch plan changed after you reviewed it.", plan: { ...reviewPlan(state), planHash: "sha256:review02" } } };
      }
      if (state.start === "error") return { status: 422, body: { ok: false, code: "instance_conflict", error: "Instance primary is already running another model." } };
      state.jobs = [jobSummary()];
      return { job: { id: JOB_ID, type: "serve" }, launchId: "lch_cccccccccccccccccccc", plan: { planHash: state.startHash || record.body.expectedPlanHash || "sha256:review01", verdict: "ok", warnings: [], overrides: state.startOverrides || [] } };
    },
    [`POST /api/m/vllm/runtimes/${runtime}/pull`]: () => {
      state.jobs = [{ id: PULL_JOB_ID, type: "image-pull", status: "running", progress: { percent: 20 } }];
      state.pulled = true;
      return { status: 202, body: { ok: true, job: { id: PULL_JOB_ID, type: "image-pull" } } };
    },
    "GET /api/knowledge": () => (state.signatures === "ok" ? wizard("error-signatures") : NOT_FOUND),
    "POST /api/m/vllm/tools/profiles": { ok: true, profile: { id: "my-profile", name: "My profile" } },
    ...extra,
  };
}

async function openReview({ browser, state = reviewState(), draft, api = {}, size, theme, locale, query = "", step = "review", storage }) {
  const made = await newPage(browser, { api: reviewApi(state, api), state, size, theme, locale });
  await made.context.addInitScript(installFakeEventSource);
  // The seed draft goes in once; a reload then finds what the page itself stored.
  await made.context.addInitScript((items) => {
    for (const [name, value] of Object.entries(items)) if (window.sessionStorage.getItem(name) === null) window.sessionStorage.setItem(name, value);
  }, storage || { "console.wizard.draft": reviewDraft({ step, ...draft }) });
  await open(made.page, query);
  await expect(byId(made.page, "wizard")).toHaveAttribute("data-step", step);
  return made;
}

const emit = (page, type, data) => page.evaluate(({ type: kind, data: body }) => window.__emit(kind, body), { type, data });
const emitJob = (page, patch) => emit(page, "jobs", { managerId: "vllm", jobs: [jobSummary(patch)], full: false });
const startCalls = (mock) => callsTo(mock, "POST", "/api/m/vllm/start");
const pageText = async (page) => (await page.locator("body").innerText()).replace(/\s+/g, " ");
const phase = (page, id) => page.locator(`[data-testid="wizard.phase.${id}"]`);

function jobAt(id, extra = {}) {
  const index = PHASES.indexOf(id);
  const history = PHASES.slice(0, index + 1).map((name, at) => ({ phase: name, at: "2026-10-16T00:00:00Z", durationMs: at < index ? 1500 + at * 100 : null }));
  return { progress: { phase: id, percent: Math.round(((index + 1) / PHASES.length) * 100), stageKey: id, stageText: { zh: "进行中", en: "In progress" } }, lifecycle: { phase: id, phaseHistory: history }, ...extra };
}

test("step 4: reasoning and tool settings, the detected template format with its evidence, and the draft heads that pair", async ({ browser }) => {
  const mainCard = wizard("card-main");
  Object.assign(mainCard.card.topology, { hiddenSize: 5120, vocabSize: 248320, layers: 64 });
  const draftCard = wizard("card-draft");
  draftCard.card.compatibleWith = { hiddenSize: 5120, vocabSize: 248320, targetLayers: 64 };
  const otherCard = wizard("card-custom");
  otherCard.card.compatibleWith = { hiddenSize: 2048, vocabSize: 32000 };
  const { context, page, failures } = await openReview({
    browser, step: "capabilities",
    api: {
      [`GET /api/models/${MAIN}/card`]: mainCard,
      [`GET /api/models/${DRAFT}/card`]: draftCard,
      [`GET /api/models/${CUSTOM}/card`]: otherCard,
      "GET /api/hub/library": { entries: [
        { path: "C:/fixture/models/example-draft-head", displayName: "example-draft-head", card: { cardId: DRAFT, role: "draft" } },
        { path: "C:/fixture/models/example-other-head", displayName: "example-other-head", card: { cardId: CUSTOM, role: "draft" } },
        { path: REV_PATH, displayName: "example-MadeUp-7B", card: { cardId: MAIN, role: "main" } },
      ] },
    },
  });
  try {
    const form = byId(page, "wizard.cap.schema-form");
    await expect(form).toBeVisible();
    await expect(form.locator('[data-group="reasoning-tools"]')).toBeVisible();
    await expect(form.locator('[data-group="speculative"]')).toBeVisible();
    await expect(form.locator('[data-group="capacity"]')).toHaveCount(0);
    await expect(form.locator('[data-group="network-security"]')).toHaveCount(0);

    const template = byId(page, "wizard.cap.template");
    await expect(template).toContainText("Detected template format");
    const tool = template.locator('[data-fact="toolFormat"]');
    await expect(tool).toContainText("hermes-json");
    await expect(tool.locator('[data-testid="evidence-chip.root"]')).toHaveAttribute("data-confidence", "detected");
    await expect(template.locator('[data-fact="reasoningFormat"] [data-testid="evidence-chip.root"]')).toHaveAttribute("data-confidence", "unknown");

    // Only the draft head that fits the model is offered, and nothing is applied until it is chosen.
    await expect(byId(page, "wizard.cap.companion")).toHaveCount(1);
    await expect(byId(page, "wizard.cap.companion")).toContainText("example-draft-head");
    expect(JSON.parse(await storedDraft(page)).values["speculative.draftModel"]).toBeUndefined();
    await byId(page, "wizard.cap.companion-use").click();
    await expect.poll(async () => JSON.parse(await storedDraft(page)).values["speculative.draftModel"]).toBe("C:/fixture/models/example-draft-head");
    await expect(byId(page, "wizard.cap.companion-use")).toBeDisabled();
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("step 5: local or LAN, an automatic key that is never shown, a red warning for LAN without a key, the gateway and the idle policy", async ({ browser }) => {
  const state = reviewState();
  const { context, page, mock } = await openReview({ browser, state, step: "access" });
  try {
    await expect(byId(page, "wizard.access.network-choice")).toBeVisible();
    await expect(page.locator('[data-testid="wizard.access.network-choice"] [data-option="local"] input')).toBeChecked();
    await expect(byId(page, "wizard.access.key-note")).toBeVisible();
    await expect(byId(page, "wizard.access.lan-warning")).toHaveCount(0);
    await expect(byId(page, "wizard.access.served")).toHaveText("example-served");
    await expect(byId(page, "wizard.access.port")).toHaveText("8000 (this computer only)");
    await expect(byId(page, "wizard.access.idle-state")).toContainText("unloaded after 30 minutes idle");
    await expect(byId(page, "wizard.access.idle-state")).toContainText("wakes up on demand");

    await page.locator('[data-testid="wizard.access.network-choice"] [data-option="lan"] input').check();
    await expect.poll(() => planCalls(mock).at(-1)?.body.instance.networkAccess).toBe("lan");
    await expect(byId(page, "wizard.access.port")).toHaveText("8000 (local network)");
    await expect(byId(page, "wizard.access.lan-warning")).toHaveCount(0);
    await page.locator('[data-testid="wizard.access.key-choice"] [data-option="none"] input').check();
    const warning = byId(page, "wizard.access.lan-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toHaveAttribute("role", "alert");
    await expect(warning).toContainText("Open to the local network with no key");
    const stored = JSON.parse(await storedDraft(page));
    expect(stored.access).toEqual({ networkAccess: "lan", apiKey: "none" });
    // The status of the step in the strip: a warning, not an error.
    await expect(page.locator('[data-testid="stepper.step"]').nth(4)).toHaveAttribute("data-state", "active");
    await page.locator('[data-testid="wizard.access.key-choice"] [data-option="auto"] input').check();
    await expect(warning).toHaveCount(0);
    await expect(byId(page, "wizard.access.key-note")).toContainText("Access & keys");
  } finally {
    await context.close();
  }

  // An excluded model and a manager without the policy route.
  state.idle = { enabled: true, idleMinutes: 15, wakeOnDemand: false, excludeModels: ["example-served"] };
  const excluded = await openReview({ browser, state, step: "access" });
  try {
    await expect(byId(excluded.page, "wizard.access.idle-state")).toContainText("is on the idle-unload exclude list");
  } finally {
    await excluded.context.close();
  }
  const missing = await openReview({ browser, state: reviewState(), step: "access", api: { "GET /api/m/vllm/idle-unload": NOT_FOUND } });
  try {
    await expect(byId(missing.page, "wizard.access.gateway")).toBeVisible();
    await expect(byId(missing.page, "wizard.access.idle")).toHaveCount(0);
  } finally {
    await missing.context.close();
  }
});

test("Review: summary, steps, the image step, overrides with reasons, effective values with provenance, the redacted command and the diff vs the last launch", async ({ browser }) => {
  const leaking = wizard("plan-review");
  leaking.command.argv.push("--api-key", FAKE_LEAK);
  leaking.command.env.EXTRA_API_KEY = FAKE_LEAK;
  const state = reviewState();
  state.planPatch = { command: leaking.command };
  const { context, page, mock, failures } = await openReview({ browser, state, draft: { extraArgs: ["--schedule-policy", "lpm"] } });
  try {
    await expect(byId(page, "wizard.step.review")).toBeVisible();
    const summary = byId(page, "wizard.review.summary");
    await expect(summary.locator('[data-fact="model"]')).toContainText("example-MadeUp-7B");
    await expect(summary.locator('[data-fact="engine"]')).toContainText("vllm");
    await expect(summary.locator('[data-fact="recipe"]')).toContainText("example-recipe");

    const steps = byId(page, "wizard.review.step");
    await expect(steps).toHaveCount(2);
    await expect(steps.first()).toHaveText('Will stop and replace the running model "running-model-1"');
    await expect(steps.nth(1)).toHaveText("Start vllm-local on port 8000, GPU 0");

    // A stable image that is pulled first: nothing to do, and it says so.
    await expect(byId(page, "wizard.image.state")).toHaveAttribute("data-state", "auto");
    await expect(byId(page, "wizard.image.auto")).toHaveText("The image vllm/vllm-openai:v0.28.0 is pulled first, before any model is replaced");
    await expect(byId(page, "wizard.image.pull")).toHaveCount(0);

    // Overrides as a DiffTable with the reason.
    const overrides = byId(page, "wizard.review.overrides-diff");
    await expect(overrides.locator("thead th")).toHaveText(["Setting", "Current", "New", "Source", "Reason"]);
    expect(await cellRows(overrides)).toEqual([["Max concurrent requests", "4", "1", "recipe", "Effective concurrency is limited by the Mamba cache"]]);

    // Every value with where it comes from, read-only.
    const values = byId(page, "wizard.review.schema-form");
    await expect(values).toBeVisible();
    await expect(values.locator('[data-field="concurrency"]')).toHaveAttribute("data-source", "recipe");
    await expect(values.locator('[data-field="contextLength"]')).toHaveAttribute("data-source", "user");
    await expect(values.locator('[data-field="contextLength"] [data-testid="schema-form.number"]')).toBeDisabled();

    // The redacted command: one token per line, <redacted> kept, custom args marked, a leaked key hidden by the console as well.
    const lines = byId(page, "command-preview.line");
    await expect(lines.filter({ hasText: "VLLM_API_KEY=<redacted>" })).toHaveCount(1);
    await expect(lines.filter({ hasText: "--max-model-len" })).toHaveCount(1);
    await expect(page.locator('[data-testid="command-preview.line"][data-custom="true"]')).toHaveText(["--schedule-policy Custom", "lpm Custom"]);
    await expect(page.locator('[data-testid="command-preview.env-row"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="command-preview.env-row"] td')).toHaveText(["<redacted>", "<redacted>"]);
    expect(await page.content()).not.toContain(FAKE_LEAK);
    expect(await pageText(page)).not.toContain(FAKE_LEAK);

    // Against the last successful launch of this model: only what differs, and the failed attempt is ignored.
    const last = byId(page, "wizard.last.diff");
    expect(await cellRows(last)).toEqual([["Context length (per request)", "65536", "131072", "user"]]);
    expect(callsTo(mock, "GET", "/api/m/vllm/launches")).not.toHaveLength(0);
    await expect(byId(page, "wizard.launch")).toBeEnabled();
    await expect(byId(page, "wizard.review.gate")).toHaveCount(0);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }

  // Before the LaunchStore route exists the legacy recent-launches list stands in.
  const legacy = reviewState();
  legacy.launches = "missing";
  const fallback = await openReview({
    browser, state: legacy,
    api: {
      "GET /api/m/vllm/recent-launches": { launches: [{ model: REV_PATH, name: "example-served", launchedAt: "2026-10-01T00:00:00Z", config: { engine: "vllm", maxModelLen: 65536 } }] },
      "GET /api/m/vllm/engines/vllm/schema": fixture("schema-vllm"),
    },
  });
  try {
    await expect(byId(fallback.page, "wizard.last")).toBeVisible();
    await expect(fallback.page.locator('[data-testid="wizard.last.diff"], [data-testid="wizard.last.none"]').first()).toBeVisible();
  } finally {
    await fallback.context.close();
  }
});

for (const [name, patch, reason] of [
  ["a plan error", { ok: false, errors: [{ field: "contextLength", code: "out_of_range", message: "Too large." }] }, "errors"],
  ["a blocker", { ok: false, blockers: [{ code: "insufficient_vram", message: { zh: "显存不足", en: "Not enough free VRAM" } }] }, "blockers"],
  ["a block verdict", { admission: { verdict: "block", message: "No room." } }, "admission"],
  ["a preview-only plan", { prospective: true }, "prospective"],
]) {
  test(`Launch is disabled by ${name} and says why`, async ({ browser }) => {
    const state = reviewState();
    state.planPatch = patch;
    const { context, page, mock } = await openReview({ browser, state });
    try {
      await expect(byId(page, "wizard.step.review")).toBeVisible();
      await expect(byId(page, "wizard.launch")).toBeDisabled();
      await expect(page.locator(`[data-testid="wizard.review.gate"] [data-reason="${reason}"]`)).toBeVisible();
      await byId(page, "wizard.launch").click({ force: true, trial: true }).catch(() => undefined);
      expect(startCalls(mock)).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
}

test("image_pull_required: the pull asks first, sends {confirm:true}, follows the job and asks for a new plan", async ({ browser }) => {
  const state = reviewState();
  state.plan = "plan-pull-required";
  const runtimePath = `/api/m/vllm/runtimes/${encodeURIComponent("example@experimental")}/pull`;
  const { context, page, mock } = await openReview({ browser, state, draft: { runtimeId: "example@experimental" } });
  try {
    await expect(byId(page, "wizard.image.state")).toHaveAttribute("data-state", "explicit");
    await expect(byId(page, "wizard.image.step")).toHaveText("Pull image example/experimental:1 (size unknown)");
    await expect(byId(page, "wizard.image.blocker")).toContainText("Experimental images are never pulled automatically");
    await expect(byId(page, "wizard.image.command-text")).toHaveText("docker pull example/experimental:1");
    await expect(byId(page, "wizard.launch")).toBeDisabled();

    // Asking comes first; cancelling pulls nothing.
    await byId(page, "wizard.image.pull").click();
    const dialog = byId(page, "wizard.image.confirm");
    await expect(dialog).toContainText("Pull example/experimental:1?");
    await expect(dialog).toContainText("This only downloads the image; no running model is stopped.");
    expect(callsTo(mock, "POST", runtimePath)).toHaveLength(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(callsTo(mock, "POST", runtimePath)).toHaveLength(0);

    const plans = planCalls(mock).length;
    await byId(page, "wizard.image.pull").click();
    await byId(page, "wizard.image.confirm").locator('[data-testid="dialog.confirm"]').click();
    await expect.poll(() => callsTo(mock, "POST", runtimePath).length).toBe(1);
    expect(callsTo(mock, "POST", runtimePath)[0].body).toEqual({ confirm: true });
    const progress = byId(page, "wizard.image.job");
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("data-state", "running");
    await emit(page, "jobs", { managerId: "vllm", jobs: [{ id: PULL_JOB_ID, type: "image-pull", status: "running", progress: { percent: 60 } }], full: false });
    await expect(page.locator('[data-testid="engine-job.progress"] [role="progressbar"]')).toHaveAttribute("aria-valuenow", "60");
    // The pull ends: the plan is asked for again, the blocker goes and Launch opens up.
    await emit(page, "jobs", { managerId: "vllm", jobs: [{ id: PULL_JOB_ID, type: "image-pull", status: "success", progress: { percent: 100 } }], full: false });
    await expect(byId(page, "wizard.image.state")).toHaveAttribute("data-state", "present", { timeout: 10000 });
    expect(planCalls(mock).length).toBeGreaterThan(plans);
    await expect(byId(page, "wizard.launch")).toBeEnabled();
  } finally {
    await context.close();
  }
});

test("a locally built image that is missing shows the rebuild hint instead of a Pull button", async ({ browser }) => {
  const state = reviewState();
  state.plan = "plan-pull-required";
  state.planPatch = { blockers: [{ code: "runtime_local_build_missing", message: { zh: "本地镜像缺失", en: "Local image missing" } }] };
  const { context, page } = await openReview({ browser, state });
  try {
    await expect(byId(page, "wizard.image.state")).toHaveAttribute("data-state", "local-build");
    await expect(byId(page, "wizard.image.local")).toContainText("The locally built image example/experimental:1 is missing and cannot be pulled");
    await expect(byId(page, "wizard.image.pull")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("Launch sends expectedPlanHash, then every phase follows the jobs events with the server's own text for an unknown stage", async ({ browser }) => {
  const state = reviewState();
  state.replace = false;
  const { context, page, mock } = await openReview({ browser, state });
  try {
    await byId(page, "wizard.launch").click();
    await expect(byId(page, "wizard.step.launch")).toBeVisible();
    expect(startCalls(mock)).toHaveLength(1);
    expect(startCalls(mock)[0].body).toMatchObject({ engineId: "vllm", expectedPlanHash: "sha256:review01", model: { ref: REV_PATH }, instance: { mode: "replace" } });
    expect(JSON.stringify(startCalls(mock)[0].body)).not.toContain("apiKey");

    // The plan said the image is pulled first: pull is active, with its progress.
    await expect(phase(page, "pull")).toHaveAttribute("data-state", "active");
    await expect(byId(page, "wizard.launch.pull")).toContainText("Pulling image vllm/vllm-openai:v0.28.0: 10%");
    await expect(page.locator('[data-testid="wizard.launch.stepper"] [aria-current="step"]')).toContainText("Pulling image");

    for (const id of PHASES.slice(0, -1)) {
      await emitJob(page, jobAt(id));
      await expect(phase(page, id)).toHaveAttribute("data-state", "active");
      const at = PHASES.indexOf(id);
      for (const earlier of PHASES.slice(0, at)) await expect(phase(page, earlier)).toHaveAttribute("data-state", "done");
      for (const later of PHASES.slice(at + 1)) await expect(phase(page, later)).toHaveAttribute("data-state", "pending");
      // A stageKey that names a phase shows the phase label; nothing else is needed for it.
      if (at > 0) await expect(byId(page, "wizard.launch.pull")).toHaveCount(0);
    }
    // Durations of the finished phases.
    await expect(byId(page, "wizard.launch.stepper").locator('[data-testid="stepper.step"]').first()).toContainText(/Done.*sec/);

    // An unknown stageKey shows the bilingual text the server sent.
    await emitJob(page, { progress: { phase: "weights", percent: 50, stageKey: "waitReady", stageText: { zh: "等待模型加载", en: "Waiting for the model to load" } }, lifecycle: { phase: "weights", phaseHistory: jobAt("weights").lifecycle.phaseHistory } });
    await expect(byId(page, "wizard.launch.stepper").locator('[data-testid="stepper.step"][data-state="active"]')).toContainText("Waiting for the model to load");

    await emitJob(page, { status: "success", ...jobAt("ready") });
    await expect(byId(page, "wizard.step.launch")).toHaveAttribute("data-state", "success");
    for (const id of PHASES) await expect(phase(page, id)).toHaveAttribute("data-state", "done");
    const success = byId(page, "wizard.launch.success");
    await expect(success).toBeVisible();
    await expect(byId(page, "wizard.launch.playground")).toHaveAttribute("href", "/playground?model=example-served");
    await expect(byId(page, "wizard.launch.view")).toHaveAttribute("href", "/deployments/vllm%3Aprimary");
    await expect(byId(page, "wizard.launch.qualify")).toHaveText("Qualify this deployment");
    // CON-31: the action opens the qualification block in place (its requests are covered by console-deployments.spec.js).
    await expect(byId(page, "wizard.launch.qualify")).toHaveAttribute("aria-expanded", "false");
    await byId(page, "wizard.launch.qualify").click();
    await expect(byId(page, "wizard.launch.qualify")).toHaveAttribute("aria-expanded", "true");
    await expect(byId(page, "wizard.launch.copy")).toBeVisible();
    // The draft is used up: nothing is kept and leaving does not ask.
    await expect.poll(() => storedDraft(page)).toBeNull();
    await byId(page, "wizard.launch.view").click();
    await expect(page).toHaveURL(/\/deployments\/vllm%3Aprimary/);
    await expect(byId(page, "wizard.discard")).toHaveCount(0);
    // The log tail of the job.
    expect(callsTo(mock, "GET", `/api/m/vllm/jobs/${JOB_ID}`).length).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test("the log tail of the launch job shows on the Launch step", async ({ browser }) => {
  const state = reviewState();
  state.replace = false;
  const { context, page } = await openReview({ browser, state });
  try {
    await byId(page, "wizard.launch").click();
    const log = byId(page, "wizard.launch.log");
    await expect(log).toContainText("line one of the launch log");
    await expect(log).toContainText("line two of the launch log");
  } finally {
    await context.close();
  }
});

test("a 409 plan_changed returns to Review with the new plan and a diff; nothing started; the next launch uses the new hash", async ({ browser }) => {
  const state = reviewState();
  state.replace = false;
  state.start = "conflict";
  const { context, page, mock } = await openReview({ browser, state });
  try {
    const plans = planCalls(mock).length;
    await byId(page, "wizard.launch").click();
    const change = byId(page, "wizard.review.change");
    await expect(change).toBeVisible();
    await expect(change).toContainText("The plan changed before launch; review it again");
    expect(await cellRows(byId(page, "wizard.review.change-diff"))).toEqual([["Context length (per request)", "131072", "65536", "recipe"]]);
    await expect(byId(page, "wizard.step.review")).toBeVisible();
    expect(startCalls(mock)).toHaveLength(1);
    expect(startCalls(mock)[0].body.expectedPlanHash).toBe("sha256:review01");
    // The new plan is asked for, and no job exists.
    await expect.poll(() => planCalls(mock).length).toBeGreaterThan(plans);
    expect(state.jobs).toEqual([]);
    await expect(byId(page, "wizard.launch")).toBeEnabled();
    await byId(page, "wizard.launch").click();
    await expect(byId(page, "wizard.step.launch")).toBeVisible();
    expect(startCalls(mock)).toHaveLength(2);
    expect(startCalls(mock)[1].body.expectedPlanHash).toBe("sha256:review02");
  } finally {
    await context.close();
  }
});

test("without ENG-2 a plan that differs at launch shows the non-blocking notice with its overrides", async ({ browser }) => {
  const state = reviewState();
  state.replace = false;
  state.startHash = "sha256:launched99";
  state.startOverrides = [{ param: "concurrency", from: 1, to: 2, source: "planner", reason: { zh: "启动时重新计算", en: "Recomputed at launch" } }];
  const { context, page } = await openReview({ browser, state });
  try {
    await byId(page, "wizard.launch").click();
    const notice = byId(page, "wizard.launch.changed");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("role", "status");
    await expect(notice).toContainText("The plan changed at launch; view the difference");
    await expect(byId(page, "wizard.launch.progress")).toBeVisible();
    await byId(page, "wizard.launch.changed-toggle").click();
    expect(await cellRows(byId(page, "wizard.launch.changed-diff"))).toEqual([["Max concurrent requests", "1", "2", "planner", "Recomputed at launch"]]);
  } finally {
    await context.close();
  }
});

test("replace mode asks first and names what is replaced; cancel starts nothing", async ({ browser }) => {
  const { context, page, mock } = await openReview({ browser });
  try {
    await byId(page, "wizard.launch").click();
    const dialog = byId(page, "wizard.replace");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Replace vllm-local (running-model-1)?");
    await expect(dialog).toContainText("In-flight requests are cut.");
    expect(startCalls(mock)).toHaveLength(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(startCalls(mock)).toHaveLength(0);
    await byId(page, "wizard.launch").click();
    await byId(page, "wizard.replace").getByRole("button", { name: "Replace and launch" }).click();
    await expect(byId(page, "wizard.step.launch")).toBeVisible();
    expect(startCalls(mock)).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("a launch the manager refuses stays on Review as a banner", async ({ browser }) => {
  const state = reviewState();
  state.replace = false;
  state.start = "error";
  const { context, page, mock } = await openReview({ browser, state });
  try {
    await byId(page, "wizard.launch").click();
    await expect(byId(page, "wizard.review.error")).toContainText("Instance primary is already running another model.");
    await expect(byId(page, "wizard.step.review")).toBeVisible();
    expect(startCalls(mock)).toHaveLength(1);
    await expect(byId(page, "wizard.launch")).toBeEnabled();
  } finally {
    await context.close();
  }
});

const FAILED = {
  status: "failed",
  error: "start failed",
  failure: {
    code: "cuda_oom", signatureId: "cuda-oom", phase: "kv",
    hint: { zh: "降低上下文长度或并发。", en: "Lower the context length or concurrency." },
    logExcerpt: "torch.OutOfMemoryError: CUDA out of memory.\nTried to allocate 20.00 GiB.",
  },
  ...jobAt("kv"),
};

async function launchAndFail(browser, { failed = FAILED, state = reviewState(), api = {}, locale } = {}) {
  state.replace = false;
  const made = await openReview({ browser, state, api, locale });
  await byId(made.page, "wizard.launch").click();
  await expect(byId(made.page, "wizard.step.launch")).toBeVisible();
  // The job list is read first; a frame for a list the console does not hold yet is dropped on purpose.
  await expect(phase(made.page, "pull")).toHaveAttribute("data-state", "active");
  await emitJob(made.page, failed);
  await expect(byId(made.page, "wizard.launch.failure")).toBeVisible();
  return made;
}

test("a failed launch is one root-cause card: title and suggestions from the looked-up signature, the failed phase, the redacted log", async ({ browser }) => {
  const { context, page, mock } = await launchAndFail(browser);
  try {
    const panel = byId(page, "wizard.launch.failure");
    await expect(byId(page, "wizard.step.launch")).toHaveAttribute("data-state", "failed");
    await expect(panel.locator('[data-testid="root-cause.title"]')).toHaveText("Out of memory while allocating the KV cache");
    await expect(panel.locator('[data-testid="root-cause.hint"]')).toHaveText("Lower the context length or concurrency.");
    await expect(panel.locator('[data-testid="root-cause.phase"]')).toContainText("Failed in: Allocating KV cache");
    await expect(panel.locator('[data-testid="root-cause.explanation"]')).toHaveText("The memory needed is more than what is free.");
    await expect(panel.locator('[data-testid="root-cause.log"]')).toContainText("CUDA out of memory");
    await expect(panel.locator('[data-testid="root-cause.signature"]')).toHaveText("cuda-oom");
    await expect(panel.locator('[data-testid="root-cause.code"]')).toHaveText("cuda_oom");
    // The Stepper marks the failed phase.
    await expect(phase(page, "kv")).toHaveAttribute("data-state", "error");
    await expect(phase(page, "weights")).toHaveAttribute("data-state", "done");
    await expect(phase(page, "graphs")).toHaveAttribute("data-state", "pending");
    // The signature list is read once.
    expect(callsTo(mock, "GET", "/api/knowledge").length).toBe(1);
    expect(callsTo(mock, "GET", "/api/knowledge")[0].query.kind).toBe("error-signatures");
    // Suggestions: two settings, the probe and the runtimes tab.
    await expect(panel.locator('[data-kind="param"]')).toHaveCount(2);
    await expect(panel.locator('[data-kind="probe"]')).toHaveCount(1);
    await expect(panel.locator('[data-testid="root-cause.runtime"]')).toHaveAttribute("href", "/engines/vllm?tab=runtimes");
  } finally {
    await context.close();
  }
});

test("applying a suggestion returns to Review with the change as a diff and never relaunches", async ({ browser }) => {
  const { context, page, mock } = await launchAndFail(browser);
  try {
    expect(startCalls(mock)).toHaveLength(1);
    await page.locator('[data-testid="root-cause.suggestion"][data-param="contextLength"] [data-testid="root-cause.apply"]').click();
    await expect(byId(page, "wizard.step.review")).toBeVisible();
    const change = byId(page, "wizard.review.change");
    await expect(change).toContainText("Suggestion applied; confirm before launching again");
    expect(await cellRows(byId(page, "wizard.review.change-diff"))).toEqual([["Context length (per request)", "131072", "65536"]]);
    expect(JSON.parse(await storedDraft(page)).values.contextLength).toBe(65536);
    // The plan is asked for again with the change; nothing was started a second time.
    await expect.poll(() => planCalls(mock).at(-1)?.body.values.contextLength).toBe(65536);
    expect(startCalls(mock)).toHaveLength(1);
    await expect(byId(page, "wizard.launch")).toBeEnabled();
    // The suggestion goes away with the dismiss.
    await byId(page, "wizard.review.change-dismiss").click();
    await expect(change).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a suggestion with security impact asks first; the probe suggestion goes to the engine step", async ({ browser }) => {
  const trust = { ...FAILED, failure: { ...FAILED.failure, code: "trust_remote_code_required", signatureId: "trust-remote-code", phase: "weights" }, ...jobAt("weights") };
  const { context, page, mock } = await launchAndFail(browser, { failed: trust });
  try {
    const row = page.locator('[data-testid="root-cause.suggestion"][data-param="trustRemoteCode"]');
    await expect(row).toContainText("Security impact");
    await row.locator('[data-testid="root-cause.apply"]').click();
    const dialog = byId(page, "root-cause.security");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("lets the model run its own code");
    await expect(byId(page, "wizard.step.launch")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(JSON.parse(await storedDraft(page)).values.trustRemoteCode).toBeUndefined();
    await row.locator('[data-testid="root-cause.apply"]').click();
    await byId(page, "root-cause.security").getByRole("button", { name: "Apply and review" }).click();
    await expect(byId(page, "wizard.step.review")).toBeVisible();
    await expect.poll(async () => JSON.parse(await storedDraft(page)).values.trustRemoteCode).toBe(true);
    expect(startCalls(mock)).toHaveLength(1);
  } finally {
    await context.close();
  }

  const second = await launchAndFail(browser);
  try {
    await second.page.locator('[data-testid="root-cause.probe"]').click();
    await expect(byId(second.page, "wizard.step.engine")).toBeVisible();
  } finally {
    await second.context.close();
  }
});

test("an admission failure keeps details.knobs as Apply chips", async ({ browser }) => {
  const admission = { ...FAILED, failure: { code: "insufficient_vram", signatureId: null, phase: "admission", hint: null, logExcerpt: "" }, meta: { errorDetails: { knobs: [{ param: "vllm.gpuMemoryUtilization", suggestion: 0.8 }] } }, ...jobAt("admission") };
  const { context, page } = await launchAndFail(browser, { failed: admission });
  try {
    const knob = page.locator('[data-testid="root-cause.knob"][data-param="vllm.gpuMemoryUtilization"]');
    await expect(knob).toBeVisible();
    await expect(knob).toContainText("0.8");
    await knob.locator('[data-testid="root-cause.knob-apply"]').click();
    await expect(byId(page, "wizard.step.review")).toBeVisible();
    expect(await cellRows(byId(page, "wizard.review.change-diff"))).toEqual([["VRAM reservation (whole GPU)", "—", "0.8"]]);
    expect(JSON.parse(await storedDraft(page)).values["vllm.gpuMemoryUtilization"]).toBe(0.8);
  } finally {
    await context.close();
  }
});

test("a suggestion that asks the planner takes the value from launch/recommend, and falls back to the step when there is none", async ({ browser }) => {
  const planner = { ...FAILED, failure: { ...FAILED.failure, signatureId: "planner-sig" } };
  const signatures = { ok: true, entries: [{ id: "planner-sig", code: "cuda_oom", title: { zh: "x", en: "Planner sig" }, suggestions: [{ kind: "param", param: "contextLength", to: "planner" }] }] };
  const { context, page, mock } = await launchAndFail(browser, {
    failed: planner,
    api: {
      "GET /api/knowledge": signatures,
      "POST /api/launch/recommend": { ok: true, cardId: MAIN, goal: "balanced", gpuSets: [{ gpuIds: ["0"], plans: [{ planId: "pl_1", engineId: "vllm", values: { contextLength: { value: 49152, reason: "fits" } } }] }] },
    },
  });
  try {
    await page.locator('[data-testid="root-cause.suggestion"][data-param="contextLength"] [data-testid="root-cause.apply"]').click();
    await expect(byId(page, "wizard.step.review")).toBeVisible();
    expect(callsTo(mock, "POST", "/api/launch/recommend")[0].body).toMatchObject({ cardId: MAIN, goal: "balanced", gpuSets: [["0"]] });
    expect(JSON.parse(await storedDraft(page)).values.contextLength).toEqual({ value: 49152, source: "planner" });
  } finally {
    await context.close();
  }

  const none = await launchAndFail(browser, {
    failed: planner,
    api: { "GET /api/knowledge": signatures, "POST /api/launch/recommend": NOT_FOUND },
  });
  try {
    await none.page.locator('[data-testid="root-cause.suggestion"][data-param="contextLength"] [data-testid="root-cause.apply"]').click();
    await expect(byId(none.page, "wizard")).toHaveAttribute("data-step", "resources");
  } finally {
    await none.context.close();
  }
});

test("a failed dry probe is the same root-cause card, and applying its suggestion goes to Review", async ({ browser }) => {
  const failedProbe = { jobs: [{
    id: "job_probe_1", type: "model-probe", status: "failed",
    error: "probe failed",
    failure: { code: "cuda_oom", signatureId: "cuda-oom", phase: "kv", hint: { zh: "先降低上下文。", en: "Lower the context first." }, logExcerpt: "probe: CUDA out of memory" },
  }] };
  const state = createState();
  const { context, page } = await newPage(browser, { state, api: { "GET /api/m/vllm/jobs": failedProbe, "GET /api/knowledge": wizard("error-signatures") } });
  try {
    await toEngineStep(page);
    await row(page, "lmdeploy").locator('[data-testid="compat.probe"]').click();
    const panel = byId(page, "wizard.probe.failure");
    await expect(panel).toBeVisible({ timeout: 15000 });
    await expect(panel).toContainText("Why the dry probe failed");
    await expect(panel.locator('[data-testid="root-cause.title"]')).toHaveText("Out of memory while allocating the KV cache");
    await expect(panel.locator('[data-testid="root-cause.log"]')).toContainText("probe: CUDA out of memory");
    await panel.locator('[data-testid="root-cause.suggestion"][data-param="kvCacheDtype"] [data-testid="root-cause.apply"]').click();
    await expect(byId(page, "wizard")).toHaveAttribute("data-step", "review");
  } finally {
    await context.close();
  }
});

test("start-last-used reaches Review in one click, with the last launch's settings, and drops the query", async ({ browser }) => {
  const state = reviewState();
  const recent = { launches: [
    { model: REV_PATH, name: "example-served", launchedAt: "2026-10-01T00:00:00Z", config: { engine: "vllm", maxModelLen: 65536, port: 8001 } },
    { model: "C:/fixture/models/example-other", name: "other", launchedAt: "2026-09-01T00:00:00Z", config: { engine: "vllm", maxModelLen: 4096 } },
  ] };
  const made = await newPage(browser, { state, api: reviewApi(state, { "GET /api/m/vllm/recent-launches": recent, "GET /api/m/vllm/engines/vllm/schema": fixture("schema-vllm") }) });
  await made.context.addInitScript(installFakeEventSource);
  try {
    await open(made.page, "?manager=vllm&from=recent&step=review");
    await expect(byId(made.page, "wizard")).toHaveAttribute("data-step", "review");
    await expect(byId(made.page, "wizard.step.review")).toBeVisible();
    await expect(byId(made.page, "wizard.review.summary").locator('[data-fact="model"]')).toContainText("example-MadeUp-7B");
    await expect.poll(() => planCalls(made.mock).at(-1)?.body.model.ref).toBe(REV_PATH);
    expect(planCalls(made.mock).at(-1)?.body.instance.port).toBe(8001);
    await expect(made.page).toHaveURL(/\/deployments\/new$/);
    await expect(byId(made.page, "wizard.launch")).toBeVisible();
    // The draft is kept, so a reload does not start the quick path again.
    await expect.poll(async () => JSON.parse(await storedDraft(made.page))?.step).toBe("review");
  } finally {
    await made.context.close();
  }

  const second = await newPage(browser, { state: reviewState(), api: reviewApi(state, { "GET /api/m/vllm/recent-launches": recent, "GET /api/m/vllm/engines/vllm/schema": fixture("schema-vllm") }) });
  await second.context.addInitScript(installFakeEventSource);
  try {
    await open(second.page, "?manager=vllm&from=recent&recent=1&step=review");
    await expect.poll(() => planCalls(second.mock).at(-1)?.body.model.ref).toBe("C:/fixture/models/example-other");
  } finally {
    await second.context.close();
  }

  // Nothing to start from: the wizard says so and stays usable.
  const empty = await newPage(browser, { state: reviewState(), api: reviewApi(state, { "GET /api/m/vllm/recent-launches": { launches: [] } }) });
  await empty.context.addInitScript(installFakeEventSource);
  try {
    await open(empty.page, "?manager=vllm&from=recent&step=review");
    await expect(byId(empty.page, "wizard.notice")).toContainText("No recent launch was found.");
  } finally {
    await empty.context.close();
  }
});

test("Save as profile sends the sparse values and the catalog version, and never a secret", async ({ browser }) => {
  const state = reviewState();
  state.replace = false;
  const { context, page, mock } = await openReview({ browser, state, draft: { values: { contextLength: 65536, apiKey: "fake-typed-key" } } });
  try {
    await byId(page, "wizard.profile.open").click();
    await byId(page, "wizard.profile.name").fill("My profile");
    await byId(page, "wizard.profile.save").click();
    await expect.poll(() => callsTo(mock, "POST", "/api/m/vllm/tools/profiles").length).toBe(1);
    const body = callsTo(mock, "POST", "/api/m/vllm/tools/profiles")[0].body;
    expect(body).toMatchObject({ name: "My profile", schemaVersion: 2, engineId: "vllm", values: { contextLength: 65536 }, catalogVersion: "2026-10-14+2026-10-14" });
    expect(JSON.stringify(body)).not.toContain("fake-typed-key");
    await expect(byId(page, "wizard.profile.form")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("Save as profile waits for the current catalog but does not need a completed launch plan", async ({ browser }) => {
  const state = reviewState();
  state.replace = false;
  let releaseCatalog, releasePlan;
  const catalogReady = new Promise((resolve) => { releaseCatalog = resolve; });
  const planReady = new Promise((resolve) => { releasePlan = resolve; });
  const { context, page, mock } = await openReview({
    browser, state, draft: { values: { contextLength: 65536, apiKey: "fake-typed-key" } },
    api: {
      "GET /api/m/vllm/engines/vllm/schema": async () => { await catalogReady; return fixture("schema-vllm"); },
      "POST /api/m/vllm/launch/plan": async () => { await planReady; return reviewPlan(state); },
    },
  });
  try {
    await byId(page, "wizard.profile.open").click();
    await byId(page, "wizard.profile.name").fill("Early profile");
    await expect(byId(page, "wizard.profile.save")).toBeDisabled();
    // Native form submission must obey the same guard as the disabled button.
    await byId(page, "wizard.profile.form").evaluate((form) => form.requestSubmit());
    expect(callsTo(mock, "POST", "/api/m/vllm/tools/profiles")).toHaveLength(0);
    await expect.poll(() => planCalls(mock).length).toBeGreaterThan(0);

    releaseCatalog();
    await expect(byId(page, "wizard.profile.save")).toBeEnabled();
    await expect(byId(page, "wizard.plan-status")).toHaveAttribute("data-status", "updating");
    await byId(page, "wizard.profile.save").click();
    await expect.poll(() => callsTo(mock, "POST", "/api/m/vllm/tools/profiles").length).toBe(1);
    const body = callsTo(mock, "POST", "/api/m/vllm/tools/profiles")[0].body;
    expect(body).toMatchObject({ name: "Early profile", schemaVersion: 2, engineId: "vllm", values: { contextLength: 65536 }, catalogVersion: "2026-10-14+2026-10-14" });
    expect(JSON.stringify(body)).not.toContain("fake-typed-key");
    await expect(byId(page, "wizard.profile.form")).toHaveCount(0);
  } finally {
    releaseCatalog();
    releasePlan();
    await context.close();
  }
});

test("a reload on the Launch step finds the job again", async ({ browser }) => {
  const state = reviewState();
  state.replace = false;
  const { context, page } = await openReview({ browser, state });
  try {
    await byId(page, "wizard.launch").click();
    await expect(byId(page, "wizard.step.launch")).toBeVisible();
    state.jobs = [jobSummary(jobAt("weights"))];
    await page.reload();
    await expect(byId(page, "wizard.step.launch")).toBeVisible();
    await expect(phase(page, "weights")).toHaveAttribute("data-state", "active");
  } finally {
    await context.close();
  }
});

for (const locale of ["en-US", "zh-CN"]) {
  test(`${locale}: steps 4 to 7 show no raw keys and the right language`, async ({ browser }) => {
    const state = reviewState();
    state.replace = false;
    const { context, page } = await openReview({ browser, state, locale, step: "capabilities" });
    try {
      const texts = {};
      await expect(byId(page, "wizard.cap.template-facts")).toBeVisible();
      texts.capabilities = await page.locator("main").innerText();
      await byId(page, "wizard.next").click();
      await expect(byId(page, "wizard.access.idle-state")).toBeVisible();
      texts.access = await page.locator("main").innerText();
      await byId(page, "wizard.next").click();
      await expect(byId(page, "wizard.launch")).toBeVisible();
      // Review renders its shell before the debounced plan and lazy values are ready.
      await expect(byId(page, "wizard.plan-status")).toHaveAttribute("data-status", "ready");
      await expect(byId(page, "wizard.review.overrides")).toBeVisible();
      await expect(byId(page, "wizard.review.schema-form")).toBeVisible();
      texts.review = await page.locator("main").innerText();
      await byId(page, "wizard.launch").click();
      await expect(byId(page, "wizard.step.launch")).toBeVisible();
      await expect(phase(page, "pull")).toHaveAttribute("data-state", "active");
      await emitJob(page, { status: "failed", error: "x", failure: { ...FAILED.failure }, ...jobAt("kv") });
      await expect(byId(page, "wizard.launch.failure")).toBeVisible();
      texts.failure = await page.locator("main").innerText();
      for (const [name, text] of Object.entries(texts)) {
        expect(text, `${locale} ${name}`).not.toMatch(RAW_KEY_3);
        if (locale === "en-US") expect(text, `${locale} ${name}`).not.toMatch(HAN);
        else expect(text, `${locale} ${name}`).toMatch(HAN);
      }
      if (locale === "zh-CN") {
        expect(texts.review).toContain("被调整的设置");
        expect(texts.review).toContain("有效并发受 Mamba cache 限制");
        expect(texts.review).toContain("与上次成功启动对比");
        expect(texts.failure).toContain("启动失败的根本原因");
        expect(texts.failure).toContain("失败阶段：分配 KV 缓存");
        expect(texts.access).toContain("自动生成");
        expect(texts.capabilities).toContain("检测到的模板格式");
        for (const id of PHASES) await expect(phase(page, id)).toHaveText(PHASE_LABEL[id][1]);
      } else {
        for (const id of PHASES) await expect(phase(page, id)).toHaveText(PHASE_LABEL[id][0]);
      }
    } finally {
      await context.close();
    }
  });
}

for (const [sizeName, size] of Object.entries(SIZES)) {
  for (const theme of ["light", "dark"]) {
    test(`${sizeName} ${theme}: Review, the pull step, Launch and the failure card fit the screen and pass the accessibility checks`, async ({ browser }) => {
      const state = reviewState();
      const { context, page } = await openReview({ browser, state, size, theme, draft: { extraArgs: ["--schedule-policy", "lpm"] } });
      try {
        await expect(byId(page, "wizard.last.diff")).toBeVisible();
        await expect(byId(page, "wizard.review.schema-form")).toBeVisible();
        await expectNoOverflow(page);
        await expectNoA11yViolations(page, { label: `wizard review ${theme} ${sizeName}` });
        await byId(page, "wizard.launch").click();
        await byId(page, "wizard.replace").getByRole("button", { name: "Replace and launch" }).click();
        await expect(byId(page, "wizard.step.launch")).toBeVisible();
        await expect(phase(page, "pull")).toHaveAttribute("data-state", "active");
        await emitJob(page, { status: "failed", error: "x", failure: { ...FAILED.failure }, ...jobAt("kv") });
        await expect(byId(page, "wizard.launch.failure")).toBeVisible();
        await expectNoOverflow(page);
        await expectNoA11yViolations(page, { label: `wizard launch failure ${theme} ${sizeName}` });
      } finally {
        await context.close();
      }
    });
  }
}

test("steps 4 and 5 fit the phone screen and pass the accessibility checks in both themes", async ({ browser }) => {
  for (const theme of ["light", "dark"]) {
    for (const step of ["capabilities", "access"]) {
      const { context, page } = await openReview({ browser, step, size: SIZES.phone, theme });
      try {
        await expect(byId(page, `wizard.step.${step}`)).toBeVisible();
        await expectNoOverflow(page);
        await expectNoA11yViolations(page, { label: `wizard ${step} ${theme} phone` });
      } finally {
        await context.close();
      }
    }
  }
});

test("the explicit pull card passes the accessibility checks", async ({ browser }) => {
  const state = reviewState();
  state.plan = "plan-pull-required";
  const { context, page } = await openReview({ browser, state });
  try {
    await expect(byId(page, "wizard.image.explicit")).toBeVisible();
    await expectNoOverflow(page);
    await expectNoA11yViolations(page, { label: "wizard review pull required" });
  } finally {
    await context.close();
  }
});
