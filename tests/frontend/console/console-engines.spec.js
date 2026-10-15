// CON-16 browser checks (07 §13.2 console-engines): the engine cards and the
// offline-manager card; Introspect asks first and follows its job; the flag diff
// lists added, removed and changed rows; a present:false runtime pulls only after
// a confirm, with { confirm: true }, and shows progress; the descriptor builder
// validates in the browser, then shows the server's errors (browser-only on a
// 404) and copies or downloads; external endpoints are added, tested, edited and
// removed with a write-only key that is never echoed. The real service-entry
// serves the console; the API is mocked in the browser (helpers/console-harness.js).
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
const HAN = /\p{Script=Han}/u;
const RAW_KEY = /\bengines\.(?:page|form)\.[A-Za-z]/;
const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER = {
  role: "owner",
  auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" },
  features: { engines: true, platform: true },
};
const NOT_FOUND = { status: 404, body: { error: "Not found" } };
const RUNTIME_A = encodeURIComponent("sglang@0.5.17");
const RUNTIME_B = encodeURIComponent("sglang@0.5.18");

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

async function newPage(browser, { api = {}, size = SIZES.desktop, theme = "light", locale = "en-US" } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce", acceptDownloads: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(entry.url).origin }).catch(() => {});
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, OWNER);
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const mock = await mockConsoleApi(page, {
    "GET /api/status": fixture("status"),
    "GET /api/fleet": fixture("fleet"),
    "GET /api/platform/status": fixture("platform-status"),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    "GET /api/engines": fixture("engines"),
    "GET /api/engines/external/endpoints": fixture("engines-external"),
    "GET /api/knowledge/status": NOT_FOUND,
    ...api,
  });
  return { context, page, mock, failures };
}

// A page not in the build logs a 404 for its module; the engine pages are in the build, so only 404s the mocks answer on purpose are tolerated.
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));
const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const callsTo = (mock, method, prefix) => mock.calls.filter((call) => call.method === method && call.path.startsWith(prefix));
const decode = (value) => decodeURIComponent(value);

async function openDetail(page, tab = "") {
  await page.goto(`${entry.url}engines/sglang${tab ? `?tab=${tab}` : ""}`);
  await expect(byId(page, "engine-detail")).toBeVisible();
}

async function dialogOf(page, id) {
  const dialog = byId(page, id);
  await expect(dialog).toBeVisible();
  return dialog;
}

// ---------------------------------------------------------------------------
// Cards

test("cards show label, tier, host, health, runtimes and capability chips; descriptor problems are listed", async ({ browser }) => {
  const { context, page, failures } = await newPage(browser);
  try {
    await page.goto(`${entry.url}engines`);
    await expect(page).toHaveTitle("Engines · Local AI Platform");
    await expect(byId(page, "engine-card")).toHaveCount(4);
    const card = (engineId) => page.locator(`[data-testid="engine-card"]:has([data-engine="${engineId}"])`);
    await expect(card("vllm").locator('[data-testid="engine.tier"]')).toHaveText("Built-in");
    await expect(card("lmdeploy").locator('[data-testid="engine.tier"]')).toHaveText("Experimental");
    await expect(card("vllm").locator('[data-testid="engine.health"]')).toContainText("Host ready");
    await expect(card("llamacpp").locator('[data-testid="engine.health"]')).toContainText("Host not checked");
    await expect(card("sglang").locator('[data-testid="engine-card.runtimes"]')).toContainText("3 runtimes");
    await expect(card("sglang").locator('[data-testid="engine-card.missing"]')).toHaveText("2 not pulled");
    await expect(card("lmdeploy").locator('[data-testid="engine-card.missing"]')).toHaveText("1 not pulled");
    await expect(card("vllm").locator('[data-capability="tensorParallel"]')).toHaveText("Tensor parallel");
    await expect(card("vllm").getByRole("link", { name: "vLLM" })).toHaveAttribute("href", "/engines/vllm");
    await expect(byId(page, "engine-problems")).toContainText("unknown_runtime");
    await expect(byId(page, "engines.new")).toHaveAttribute("href", "/engines/new");
    // The external endpoints and the knowledge panel are part of the page; knowledge degrades on a 404.
    await expect(byId(page, "engine-endpoint")).toHaveCount(2);
    await expect(byId(page, "engine-knowledge.unavailable")).toBeVisible();
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a manager that does not answer is a grey card with a Start button; Start posts with the CSRF header", async ({ browser }) => {
  const body = fixture("engines");
  body.engines = body.engines.filter((engine) => engine.managerId === "vllm");
  body.managers = [body.managers[0], { managerId: "llama", ok: false, code: "manager_unreachable" }];
  body.errors = [{ managerId: "llama", source: "manager", engineId: "", path: "", code: "manager_unreachable", message: "The llama manager did not answer." }];
  const { context, page, mock } = await newPage(browser, {
    api: {
      "GET /api/engines": body,
      "POST /api/managers/llama/start": { ok: true },
      "GET /api/knowledge/status": { ok: true, managerId: "vllm", domains: [{ domain: "models", layers: [], errors: [] }, { domain: "engines", layers: [], errors: [{ code: "x" }, { code: "y" }] }, { domain: "recipes", unavailable: true, layers: [], errors: [] }], digest: null },
    },
  });
  try {
    await page.goto(`${entry.url}engines`);
    const offline = byId(page, "engine-offline");
    await expect(offline).toBeVisible();
    await expect(byId(page, "engine-offline.text")).toHaveText("llama.cpp manager is not running");
    await expect(byId(page, "engine-card")).toHaveCount(3);
    await expect(byId(page, "engine-problems")).toHaveCount(0);
    await byId(page, "engine-offline.start").click();
    await expect.poll(() => callsTo(mock, "POST", "/api/managers/llama/start").length).toBe(1);
    // The knowledge panel lists every domain with its problem count.
    await expect(page.locator('[data-domain="models"]')).toContainText("No problems");
    await expect(page.locator('[data-domain="engines"]')).toContainText("2 problems");
    await expect(page.locator('[data-domain="recipes"]')).toContainText("Not available");
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("an entry that cannot list engines shows an empty state with Try again", async ({ browser }) => {
  let answers = 0;
  const { context, page } = await newPage(browser, {
    api: { "GET /api/engines": () => (++answers === 1 ? { status: 503, body: { ok: false, error: { code: "engines_unavailable", message: "x" } } } : fixture("engines")) },
  });
  try {
    await page.goto(`${entry.url}engines`);
    await expect(byId(page, "engines.unavailable")).toBeVisible();
    await byId(page, "empty-state.action").click();
    await expect(byId(page, "engine-card")).toHaveCount(4);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Runtimes: Introspect

function jobsHandler(state) {
  return () => [{ id: "job_i1", type: "introspect", status: state.status, progress: state.progress, error: state.error || null, meta: state.meta || {} }];
}

test("Introspect asks first, sends { confirm: true } only on Confirm, and follows its job", async ({ browser }) => {
  const state = { status: "running", progress: { percent: 40 } };
  const { context, page, mock } = await newPage(browser, {
    api: {
      [`POST /api/m/vllm/engines/sglang/runtimes/${RUNTIME_A}/introspect`]: { job: { id: "job_i1", type: "introspect", status: "running" } },
      "GET /api/m/vllm/jobs": jobsHandler(state),
      [`GET /api/m/vllm/engines/sglang/runtimes/${RUNTIME_A}/flags`]: fixture("engines-flags"),
    },
  });
  try {
    await openDetail(page);
    const row = page.locator('[data-testid="engine-runtime"][data-runtime="sglang@0.5.17"]');
    await expect(row.locator('[data-testid="engine-runtime.present"]')).toContainText("Image present");
    await expect(row.locator('[data-testid="engine-runtime.captured"]')).toContainText("Captured");
    const introspect = row.locator('[data-testid="engine-runtime.introspect"]');
    await introspect.click();
    const dialog = await dialogOf(page, "engine-runtime.confirm");
    await expect(dialog).toContainText("short-lived container");
    await expect(dialog).toContainText("No GPU, no mounted folders and no network.");
    expect(callsTo(mock, "POST", "/api/m/vllm/engines")).toEqual([]);
    // Cancel sends nothing and returns focus to the opener.
    await dialog.locator('[data-testid="dialog.cancel"]').click();
    await expect(byId(page, "engine-runtime.confirm")).toHaveCount(0);
    await expect(introspect).toBeFocused();
    expect(callsTo(mock, "POST", "/api/m/vllm/engines")).toEqual([]);

    await introspect.click();
    await (await dialogOf(page, "engine-runtime.confirm")).locator('[data-testid="dialog.confirm"]').click();
    await expect.poll(() => callsTo(mock, "POST", "/api/m/vllm/engines").length).toBe(1);
    const [call] = callsTo(mock, "POST", "/api/m/vllm/engines");
    expect(decode(call.path)).toBe("/api/m/vllm/engines/sglang/runtimes/sglang@0.5.17/introspect");
    expect(call.body).toEqual({ confirm: true });
    expect(call.headers["x-csrf-token"]).toBe("t");

    // The job's progress is shown, then its end; the engine list is read again afterwards.
    const progress = page.locator('[data-testid="engine-job.progress"] [role="progressbar"]');
    await expect(progress).toHaveAttribute("aria-valuenow", "40");
    const before = callsTo(mock, "GET", "/api/engines").length;
    state.status = "success";
    state.progress = { percent: 100 };
    state.meta = { flagCount: 2 };
    await expect(byId(page, "engine-job.introspect")).toHaveAttribute("data-state", "success", { timeout: 15000 });
    await expect(byId(page, "engine-job.introspect")).toContainText("Captured the flags of sglang@0.5.17.");
    await expect.poll(() => callsTo(mock, "GET", "/api/engines").length, { timeout: 15000 }).toBeGreaterThan(before);
    await byId(page, "engine-job.dismiss").click();
    await expect(byId(page, "engine-job.introspect")).toHaveCount(0);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a failed introspect job says so with the manager's reason and what to do first", async ({ browser }) => {
  const state = { status: "failed", progress: { percent: 100 }, error: "Image was removed", meta: { errorCode: "runtime_image_missing" } };
  const { context, page } = await newPage(browser, {
    api: {
      [`POST /api/m/vllm/engines/sglang/runtimes/${RUNTIME_A}/introspect`]: { job: { id: "job_i1", type: "introspect", status: "running" } },
      "GET /api/m/vllm/jobs": jobsHandler(state),
      [`GET /api/m/vllm/engines/sglang/runtimes/${RUNTIME_A}/flags`]: fixture("engines-flags"),
    },
  });
  try {
    await openDetail(page);
    await page.locator('[data-runtime="sglang@0.5.17"] [data-testid="engine-runtime.introspect"]').click();
    await (await dialogOf(page, "engine-runtime.confirm")).locator('[data-testid="dialog.confirm"]').click();
    const failed = byId(page, "engine-job.introspect");
    await expect(failed).toHaveAttribute("data-state", "failed");
    await expect(failed).toContainText("Introspecting sglang@0.5.17 failed.");
    await expect(byId(page, "engine-job.error")).toHaveText("Image was removed");
    await expect(failed).toContainText("Pull the image first.");
  } finally {
    await context.close();
  }
});

test("a runtime whose image is not present cannot be introspected, and a refused introspect keeps the dialog open with the reason", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: { [`POST /api/m/vllm/engines/sglang/runtimes/${RUNTIME_A}/introspect`]: { status: 409, body: { ok: false, error: { code: "runtime_image_missing", message: "The image is gone", hint: "Pull the image first" } } } },
  });
  try {
    await openDetail(page);
    await expect(page.locator('[data-runtime="sglang@0.5.18"] [data-testid="engine-runtime.introspect"]')).toBeDisabled();
    await page.locator('[data-runtime="sglang@0.5.17"] [data-testid="engine-runtime.introspect"]').click();
    const dialog = await dialogOf(page, "engine-runtime.confirm");
    await dialog.locator('[data-testid="dialog.confirm"]').click();
    await expect(dialog.locator('[data-testid="dialog.error"]')).toContainText("The image is gone");
    await expect(dialog).toBeVisible();
    expect(callsTo(mock, "POST", "/api/m/vllm/engines")).toHaveLength(1);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Runtimes: Pull

test("a present:false runtime pulls only after Confirm, with { confirm: true }, shows progress and turns present", async ({ browser }) => {
  const state = { present: false, status: "running", progress: { percent: 35 } };
  const engines = () => {
    const body = fixture("engines");
    const sglang = body.engines.find((engine) => engine.engineId === "sglang");
    sglang.runtimes.find((runtime) => runtime.runtimeId === "sglang@0.5.18").present = state.present;
    return body;
  };
  const { context, page, mock } = await newPage(browser, {
    api: {
      "GET /api/engines": engines,
      [`POST /api/m/vllm/runtimes/${RUNTIME_B}/pull`]: { status: 202, body: { ok: true, job: { id: "dl_pull1", type: "image-pull" } } },
      "GET /api/m/vllm/jobs": () => [{ id: "dl_pull1", type: "image-pull", status: state.status, progress: state.progress }],
    },
  });
  try {
    await openDetail(page);
    const row = page.locator('[data-testid="engine-runtime"][data-runtime="sglang@0.5.18"]');
    await expect(row).toHaveAttribute("data-present", "missing");
    await expect(row.locator('[data-testid="engine-runtime.present"]')).toContainText("Image not pulled");
    // The docker pull command stays copyable, and a local build offers a rebuild hint instead of Pull.
    await expect(row.locator('[data-testid="engine-runtime.pull-command"]')).toHaveText("docker pull lmsysorg/sglang:v0.5.18");
    await row.locator('[data-testid="engine-runtime.copy"]').nth(1).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("docker pull lmsysorg/sglang:v0.5.18");
    const local = page.locator('[data-testid="engine-runtime"][data-runtime="sglang@flashnext"]');
    await expect(local.locator('[data-testid="engine-runtime.pull"]')).toHaveCount(0);
    await expect(local).toContainText("A local build cannot be pulled.");
    await expect(page.locator('[data-runtime="sglang@0.5.17"] [data-testid="engine-runtime.pull"]')).toHaveCount(0);

    const pull = row.locator('[data-testid="engine-runtime.pull"]');
    await pull.click();
    const dialog = await dialogOf(page, "engine-runtime.confirm");
    await expect(dialog).toContainText("Pull lmsysorg/sglang:v0.5.18?");
    expect(callsTo(mock, "POST", "/api/m/vllm/runtimes")).toEqual([]);
    await dialog.locator('[data-testid="dialog.cancel"]').click();
    expect(callsTo(mock, "POST", "/api/m/vllm/runtimes")).toEqual([]);

    await pull.click();
    await (await dialogOf(page, "engine-runtime.confirm")).locator('[data-testid="dialog.confirm"]').click();
    await expect.poll(() => callsTo(mock, "POST", "/api/m/vllm/runtimes").length).toBe(1);
    const [call] = callsTo(mock, "POST", "/api/m/vllm/runtimes");
    expect(decode(call.path)).toBe("/api/m/vllm/runtimes/sglang@0.5.18/pull");
    expect(call.body).toEqual({ confirm: true });
    expect(call.headers["x-csrf-token"]).toBe("t");

    await expect(page.locator('[data-testid="engine-job.pull"] [role="progressbar"]')).toHaveAttribute("aria-valuenow", "35");
    state.status = "success";
    state.progress = { percent: 100 };
    state.present = true;
    await expect(byId(page, "engine-job.pull")).toHaveAttribute("data-state", "success", { timeout: 15000 });
    await expect(byId(page, "engine-job.pull")).toContainText("Pulled lmsysorg/sglang:v0.5.18.");
    await expect(row).toHaveAttribute("data-present", "present", { timeout: 15000 });
    await expect(row.locator('[data-testid="engine-runtime.pull"]')).toHaveCount(0);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a manager without the pull route says so in the dialog and sends nothing else", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { [`POST /api/m/vllm/runtimes/${RUNTIME_B}/pull`]: NOT_FOUND } });
  try {
    await openDetail(page);
    await page.locator('[data-runtime="sglang@0.5.18"] [data-testid="engine-runtime.pull"]').click();
    const dialog = await dialogOf(page, "engine-runtime.confirm");
    await dialog.locator('[data-testid="dialog.confirm"]').click();
    await expect(dialog.locator('[data-testid="dialog.error"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="dialog.error"]')).not.toBeEmpty();
    expect(callsTo(mock, "POST", "/api/m/vllm/runtimes")).toHaveLength(1);
    await expect(byId(page, "engine-job.pull")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Flag diff

test("the flag diff lists added, removed and changed rows from ?against=", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: { [`GET /api/m/vllm/engines/sglang/runtimes/${RUNTIME_A}/flags`]: fixture("engines-flags") },
  });
  try {
    await openDetail(page, "flags");
    const rows = byId(page, "flag-diff.row");
    await expect(rows).toHaveCount(6);
    await expect(byId(page, "flag-diff.summary")).toContainText("2 added, 1 removed, 3 changed");
    const flagCalls = callsTo(mock, "GET", `/api/m/vllm/engines/sglang/runtimes/${RUNTIME_A}/flags`);
    expect(flagCalls.at(-1).query).toEqual({ against: "sglang@0.5.18" });
    await expect(page.locator('[data-testid="flag-diff.row"][data-kind="added"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="flag-diff.row"][data-kind="removed"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="flag-diff.row"][data-kind="changed"]')).toHaveCount(3);
    await expect(page.locator('[data-kind="added"]').first()).toContainText("--enable-pleoffload");
    await expect(page.locator('[data-kind="removed"]')).toContainText("--disable-radix-cache-legacy");
    const renamed = page.locator('[data-change="renamed"]');
    await expect(renamed).toContainText("--max-total-tokens-legacy");
    await expect(renamed).toContainText("Renamed to --max-total-tokens");
    await expect(page.locator('[data-change="choices"]')).toContainText("New choices: fp8_e4m3");
    await expect(page.locator('[data-change="choices"]')).toContainText("Removed choices: fp8_e5m2_legacy");
    await expect(page.locator('[data-change="default"]')).toContainText("Default changed: 1 → 0.8");
    // Every row says what it is in words, not only by colour.
    await expect(page.locator('[data-kind="added"] .badge').first()).toHaveText("Added");
    await expect(page.locator('[data-kind="removed"] .badge')).toHaveText("Removed");
    await expect(page.locator('[data-kind="changed"] .badge').first()).toHaveText("Changed");
    await page.locator('[data-testid="flag-diff.coverage"] summary').click();
    await expect(byId(page, "flag-diff.coverage")).toContainText("--flashinfer-workspace");

    // Comparing with the parameter catalog asks for against=catalog.
    await page.getByLabel("Compare with").selectOption("catalog");
    await expect.poll(() => callsTo(mock, "GET", `/api/m/vllm/engines/sglang/runtimes/${RUNTIME_A}/flags`).at(-1).query.against).toBe("catalog");
    // The same side on both sides compares nothing and asks for nothing.
    const asked = callsTo(mock, "GET", "/api/m/vllm/engines/sglang/runtimes").length;
    await page.getByLabel("Compare with").selectOption("sglang@0.5.17");
    await expect(byId(page, "flag-diff.same")).toBeVisible();
    expect(callsTo(mock, "GET", "/api/m/vllm/engines/sglang/runtimes")).toHaveLength(asked);
  } finally {
    await context.close();
  }
});

test("a side without captured flags says to introspect first and goes back to Runtimes", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: { [`GET /api/m/vllm/engines/sglang/runtimes/${RUNTIME_A}/flags`]: { status: 404, body: { ok: false, error: { code: "runtime_not_introspected", message: "x" } } } },
  });
  try {
    await openDetail(page, "flags");
    await expect(byId(page, "flag-diff.not-introspected")).toBeVisible();
    await byId(page, "empty-state.action").click();
    await expect(byId(page, "engine-runtimes")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("tab")).toBe("runtimes");
  } finally {
    await context.close();
  }
});

test("an identical pair of runtimes says there is no difference", async ({ browser }) => {
  const same = { ...fixture("engines-flags"), diff: { added: [], removed: [], renamed: [], choicesChanged: [], defaultsChanged: [], catalogMissing: [], catalogUnmapped: [] } };
  const { context, page } = await newPage(browser, { api: { [`GET /api/m/vllm/engines/sglang/runtimes/${RUNTIME_A}/flags`]: same } });
  try {
    await openDetail(page, "flags");
    await expect(byId(page, "flag-diff.identical")).toBeVisible();
    await expect(byId(page, "flag-diff.row")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Parameters, recipes, descriptor

test("Parameters is SchemaForm in catalog mode with availability badges, Recipes lists the schema's recipes, Descriptor is read-only JSON", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { "GET /api/m/vllm/engines/sglang/schema": fixture("schema-sglang") } });
  try {
    await openDetail(page, "parameters");
    await expect(byId(page, "engine-parameters.form")).toBeVisible();
    // The fixture's runtime has not been introspected, so the page says parameters are unverified.
    await expect(byId(page, "engine-parameters.unverified")).toContainText("has not been introspected");
    await expect(page.getByText("Unverified").first()).toBeVisible();
    expect(callsTo(mock, "GET", "/api/m/vllm/engines/sglang/schema").at(-1).query).toEqual({ runtime: "sglang@0.5.17" });

    await page.getByRole("tab", { name: "Recipes" }).click();
    const recipes = byId(page, "engine-recipe");
    await expect(recipes.first()).toBeVisible();
    await expect(page.locator('[data-recipe="pennyroyal-v251"]')).toContainText("Pennyroyal v2.5.1");
    await expect(page.locator('[data-recipe="pennyroyal-v251"] [data-reason="family"]')).toHaveText("Same model family");
    await expect(page.locator('[data-recipe="pennyroyal-v251"] [data-reason="runtime_mismatch"]')).toHaveText("Different runtime");
    await expect(page.locator('[data-recipe="pennyroyal-v251"]')).toContainText("quantization = modelopt_fp4");

    await page.getByLabel("Runtime", { exact: true }).selectOption("sglang@0.5.18");
    await expect.poll(() => callsTo(mock, "GET", "/api/m/vllm/engines/sglang/schema").at(-1).query.runtime).toBe("sglang@0.5.18");
    expect(new URL(page.url()).searchParams.get("runtime")).toBe("sglang@0.5.18");

    await page.getByRole("tab", { name: "Descriptor" }).click();
    const json = await byId(page, "engine-descriptor.json").locator("code").innerText();
    expect(JSON.parse(json).engineId).toBe("sglang");
    await expect(byId(page, "engine-descriptor")).toContainText("read-only");
  } finally {
    await context.close();
  }
});

test("a schema that cannot load shows an error with a retry; an unknown engine shows an empty state", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: { "GET /api/m/vllm/engines/sglang/schema": { status: 500, body: { ok: false, error: { code: "schema_unavailable", message: "x" } } } } });
  try {
    await openDetail(page, "parameters");
    await expect(byId(page, "engine-schema.error")).toBeVisible();
    await page.goto(`${entry.url}engines/nothing-here`);
    await expect(byId(page, "engine-detail.missing")).toContainText('Engine "nothing-here" was not found');
    await byId(page, "empty-state.action").click();
    await expect(byId(page, "engines")).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Descriptor builder

async function fillBasics(page, { id = "mybox", port = "9000" } = {}) {
  await byId(page, "engine-new.field.id").fill(id);
  await byId(page, "engine-new.field.labelZh").fill("我的引擎");
  await byId(page, "engine-new.field.labelEn").fill("My engine");
  await byId(page, "engine-new.field.image").fill("registry.example.com/team/mybox:1.2");
  await byId(page, "engine-new.field.port").fill(port);
}

const VALIDATE = "POST /api/m/vllm/engines/descriptors/validate";

test("the builder validates in the browser first and does not call the manager until the draft passes", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { [VALIDATE]: { ok: true, kind: "descriptor", errors: [] } } });
  try {
    await page.goto(`${entry.url}engines/new`);
    await expect(byId(page, "engine-new.steps").locator("li")).toHaveCount(4);
    await expect(byId(page, "engine-new.steps").locator('[aria-current="step"]')).toContainText("Basics");
    // Empty basics: the step stays and the fields explain themselves.
    await byId(page, "engine-new.next").click();
    await expect(page.getByText("This field is required").first()).toBeVisible();
    await expect(byId(page, "engine-new.basics")).toBeVisible();
    await byId(page, "engine-new.field.id").fill("Bad_Id");
    await byId(page, "engine-new.field.port").fill("99999");
    await byId(page, "engine-new.next").click();
    await expect(page.getByText("Use 2 to 32 characters").first()).toBeVisible();
    await expect(page.getByText("Enter a port from 1 to 65535")).toBeVisible();
    // An id a built-in engine owns, or one already registered, is refused before any request.
    await byId(page, "engine-new.field.id").fill("vllm");
    await byId(page, "engine-new.next").click();
    await expect(page.getByText("This id belongs to a built-in engine")).toBeVisible();
    await byId(page, "engine-new.field.id").fill("lmdeploy");
    await byId(page, "engine-new.next").click();
    await expect(page.getByText("An engine with this id already exists")).toBeVisible();
    expect(callsTo(mock, "POST", "/api/m/")).toEqual([]);

    await fillBasics(page);
    await byId(page, "engine-new.next").click();
    await expect(byId(page, "engine-new.mapping")).toBeVisible();
    // A placeholder that is not known and a value that looks like a flag are caught here too.
    await byId(page, "engine-new.arg.add").click();
    await byId(page, "engine-new.arg.flag").last().fill("--extra");
    await byId(page, "engine-new.arg.value").last().fill("{{nope}}");
    await byId(page, "engine-new.next").click();
    await expect(page.getByText("{{nope}} is not a known placeholder")).toBeVisible();
    await byId(page, "engine-new.arg.value").last().fill("-rm");
    await byId(page, "engine-new.next").click();
    await expect(page.getByText("A value cannot start with a dash")).toBeVisible();
    await byId(page, "engine-new.arg.remove").last().click();
    await byId(page, "engine-new.next").click();
    await expect(byId(page, "engine-new.memory")).toBeVisible();
    expect(callsTo(mock, "POST", "/api/m/")).toEqual([]);
  } finally {
    await context.close();
  }
});

test("review shows the server's errors, then passes once fixed; the JSON copies and downloads", async ({ browser }) => {
  let answer = { ok: false, kind: "descriptor", errors: [{ path: "runtimes.allowed[0]", code: "unknown_runtime", message: "Runtime mybox is not in the runtime manifest." }] };
  const { context, page, mock } = await newPage(browser, { api: { [VALIDATE]: () => answer } });
  try {
    await page.goto(`${entry.url}engines/new`);
    await fillBasics(page);
    for (let step = 0; step < 3; step += 1) await byId(page, "engine-new.next").click();
    await expect(byId(page, "engine-new.review")).toBeVisible();
    await expect(byId(page, "engine-new.browser")).toContainText("Checked in this browser");
    // The server's verdict follows the browser's, with its own error rows.
    await expect(byId(page, "engine-new.server")).toHaveAttribute("data-state", "errors");
    await expect(byId(page, "engine-new.server-errors")).toContainText("runtimes.allowed[0]");
    await expect(byId(page, "engine-new.server-errors")).toContainText("Runtime mybox is not in the runtime manifest.");
    await expect(byId(page, "engine-new.manifest-hint")).toContainText("runtime manifest");
    const [call] = callsTo(mock, "POST", "/api/m/vllm/engines/descriptors/validate");
    expect(call.body.descriptor.id).toBe("mybox");
    expect(call.body.descriptor.adapter).toBe("docker-template");
    expect(call.body.descriptor.runtimes).toEqual({ default: "mybox", allowed: ["mybox"] });
    expect(call.headers["x-csrf-token"]).toBe("t");

    // The page shows the file it asks the person to write, with the target folder.
    const shown = JSON.parse(await byId(page, "engine-new.json").locator("code").innerText());
    expect(shown).toEqual(call.body.descriptor);
    expect(shown.template.args[0]).toBe("{{model.containerPath}}");
    await expect(byId(page, "engine-new.folder")).toHaveText("<AI_ROOT>/config/engines/mybox.json");
    expect(JSON.parse(await byId(page, "engine-new.runtime-json").locator("code").innerText()).runtimes.mybox.engineId).toBe("mybox");
    await expect(byId(page, "engine-new.after")).toContainText("Restart the vLLM manager");

    // Copy puts exactly the JSON on the clipboard; Download saves mybox.json.
    await byId(page, "engine-new.json").locator('[data-testid="code-block.copy"]').click();
    // Windows clipboards hand back CRLF line ends.
    await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).split(/\r?\n/).join("\n")).toBe(JSON.stringify(shown, null, 2));
    const download = page.waitForEvent("download");
    await byId(page, "engine-new.download").click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("mybox.json");
    expect(JSON.parse(fs.readFileSync(await saved.path(), "utf8"))).toEqual(shown);

    // Check again after the runtime entry is in place.
    answer = { ok: true, kind: "descriptor", errors: [] };
    await byId(page, "engine-new.recheck").click();
    await expect(byId(page, "engine-new.server")).toHaveAttribute("data-state", "ok");
    await expect(byId(page, "engine-new.server")).toContainText("The manager accepts this descriptor");
    expect(callsTo(mock, "POST", "/api/m/vllm/engines/descriptors/validate")).toHaveLength(2);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a manager without the validate route (404) leaves the browser check only", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { [VALIDATE]: NOT_FOUND } });
  try {
    await page.goto(`${entry.url}engines/new`);
    await fillBasics(page);
    for (let step = 0; step < 3; step += 1) await byId(page, "engine-new.next").click();
    await expect(byId(page, "engine-new.server")).toHaveAttribute("data-state", "browser-only");
    await expect(byId(page, "engine-new.server")).toContainText("Browser check only");
    await expect(byId(page, "engine-new.browser")).toContainText("Checked in this browser");
    // The JSON is still offered.
    await expect(byId(page, "engine-new.json")).toBeVisible();
    await expect(byId(page, "engine-new.download")).toBeVisible();
    expect(callsTo(mock, "POST", "/api/m/vllm/engines/descriptors/validate")).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("the builder keeps its draft while moving between steps, and the llama manager is checked on its own route", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { "POST /api/m/llama/engines/descriptors/validate": { ok: true, kind: "descriptor", errors: [] } } });
  try {
    await page.goto(`${entry.url}engines/new`);
    await fillBasics(page);
    await byId(page, "engine-new.field.hostManager").selectOption("llama");
    await byId(page, "engine-new.format.gguf").check();
    await byId(page, "engine-new.next").click();
    await byId(page, "engine-new.next").click();
    await byId(page, "engine-new.memory.static-fraction-of-free").check();
    await byId(page, "engine-new.back").click();
    await byId(page, "engine-new.back").click();
    await expect(byId(page, "engine-new.field.id")).toHaveValue("mybox");
    await expect(byId(page, "engine-new.field.hostManager")).toHaveValue("llama");
    await byId(page, "engine-new.next").click();
    await byId(page, "engine-new.next").click();
    await expect(byId(page, "engine-new.memory.static-fraction-of-free")).toBeChecked();
    await byId(page, "engine-new.next").click();
    await expect(byId(page, "engine-new.server")).toHaveAttribute("data-state", "ok");
    const [call] = callsTo(mock, "POST", "/api/m/llama/engines/descriptors/validate");
    expect(call.body.descriptor.hostManager).toBe("llama");
    expect(call.body.descriptor.artifactFormats).toEqual(["safetensors", "gguf"]);
    expect(call.body.descriptor.memoryModel).toEqual({ kind: "static-fraction-of-free" });
    await expect(byId(page, "engine-new.after")).toContainText("Restart the llama.cpp manager");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// External endpoints

const EP = "/api/engines/external/endpoints";
const KEY = "sk-test-fake-0123456789";

test("adding an endpoint sends the key once; it is not echoed in the page, the storage or the list", async ({ browser }) => {
  const created = { ok: true, endpoint: { endpointId: "my-ollama", label: "my-ollama", kind: "ollama", baseUrl: "http://localhost:11434/v1", apiKeyRef: "engines.external:my-ollama", enabled: true } };
  const { context, page, mock } = await newPage(browser, { api: { [`POST ${EP}`]: { status: 201, body: created } } });
  try {
    await page.goto(`${entry.url}engines/external`);
    await expect(page.locator('[data-testid="engine-endpoint"][data-endpoint="ollama-local"]')).toContainText("http://localhost:11434/v1");
    await expect(page.locator('[data-endpoint="ollama-local"] [data-testid="engine-endpoint.health"]')).toContainText("Ready");
    await expect(page.locator('[data-endpoint="ollama-local"]')).toContainText("12 ms");
    await expect(page.locator('[data-endpoint="ollama-local"] [data-routable]')).toHaveAttribute("data-routable", "yes");
    await expect(page.locator('[data-endpoint="team-gateway"] [data-testid="engine-endpoint.health"]')).toContainText("Key refused");
    await expect(page.locator('[data-endpoint="team-gateway"] [data-routable]')).toHaveAttribute("data-routable", "no");
    await expect(page.locator('[data-endpoint="team-gateway"]')).toContainText("Key stored");
    await expect(page.locator("body")).not.toContainText("engines.external");

    await byId(page, "engine-endpoint.add").click();
    const dialog = await dialogOf(page, "engine-endpoint.dialog");
    // The key field is write-only: a password input that can be shown while typing, never prefilled.
    const key = dialog.locator('[data-testid="engine-endpoint.field.apiKey"]');
    await expect(key).toHaveAttribute("type", "password");
    await expect(key).toHaveAttribute("autocomplete", "new-password");
    await dialog.locator('[data-testid="engine-endpoint.field.id"]').fill("my-ollama");
    await dialog.locator('[data-testid="engine-endpoint.field.baseUrl"]').fill("http://localhost:11434/v1");
    await key.fill(KEY);
    await dialog.locator('[data-testid="engine-endpoint.key-toggle"]').click();
    await expect(key).toHaveAttribute("type", "text");
    await dialog.locator('[data-testid="engine-endpoint.key-toggle"]').click();
    await dialog.locator('[data-testid="engine-endpoint.save"]').click();
    await expect(byId(page, "engine-endpoint.dialog")).toHaveCount(0);

    const [call] = callsTo(mock, "POST", EP);
    expect(call.body).toEqual({ endpointId: "my-ollama", kind: "generic", baseUrl: "http://localhost:11434/v1", enabled: true, routing: { includeInAuto: false }, apiKey: KEY });
    expect(call.headers["x-csrf-token"]).toBe("t");
    // Not in the page, not in storage, not in a later GET.
    const where = await page.evaluate(() => ({ html: document.documentElement.outerHTML, local: JSON.stringify({ ...window.localStorage }), session: JSON.stringify({ ...window.sessionStorage }), cookie: document.cookie, values: [...document.querySelectorAll("input, textarea")].map((node) => node.value) }));
    expect(where.html).not.toContain(KEY);
    expect(where.local + where.session + where.cookie).not.toContain(KEY);
    expect(where.values).not.toContain(KEY);
    expect(mock.calls.filter((item) => item.method === "GET" && JSON.stringify(item).includes(KEY))).toEqual([]);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a remote http:// address needs the plaintext acknowledgement; a server refusal shows under its field", async ({ browser }) => {
  let refuse = true;
  const { context, page, mock } = await newPage(browser, {
    api: {
      [`POST ${EP}`]: () => (refuse
        ? { status: 400, body: { ok: false, error: { code: "endpoint_invalid", message: "The external endpoint is not valid; nothing was saved." }, errors: [{ path: "baseUrl", code: "blocked_address", message: "baseUrl points at a link-local address." }] } }
        : { status: 201, body: { ok: true, endpoint: { endpointId: "far-away" } } }),
    },
  });
  try {
    await page.goto(`${entry.url}engines/external`);
    await byId(page, "engine-endpoint.add").click();
    const dialog = await dialogOf(page, "engine-endpoint.dialog");
    await dialog.locator('[data-testid="engine-endpoint.field.id"]').fill("far-away");
    await dialog.locator('[data-testid="engine-endpoint.field.baseUrl"]').fill("http://api.example.com/v1");
    await expect(dialog.locator('[data-testid="engine-endpoint.ack"]')).toBeVisible();
    await dialog.locator('[data-testid="engine-endpoint.save"]').click();
    await expect(dialog).toContainText("A remote http:// address sends everything in clear text");
    expect(callsTo(mock, "POST", EP)).toEqual([]);
    await dialog.locator('[data-testid="engine-endpoint.field.ack"]').check();
    await dialog.locator('[data-testid="engine-endpoint.save"]').click();
    await expect(dialog).toContainText("baseUrl points at a link-local address.");
    expect(callsTo(mock, "POST", EP)).toHaveLength(1);
    expect(callsTo(mock, "POST", EP)[0].body.acknowledge).toEqual(["plaintext-remote"]);
    refuse = false;
    await dialog.locator('[data-testid="engine-endpoint.save"]').click();
    await expect(byId(page, "engine-endpoint.dialog")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("Test probes an endpoint without asking, and shows latency and models", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: {
      [`POST ${EP}/ollama-local/test`]: { ok: true, endpointId: "ollama-local", latencyMs: 31, state: "ready", models: ["qwen3:32b", "llama3.1:8b"] },
      [`POST ${EP}/team-gateway/test`]: { ok: false, endpointId: "team-gateway", latencyMs: 90, state: "unauthorized", models: [], error: { code: "unauthorized", message: "The endpoint is unauthorized." } },
    },
  });
  try {
    await page.goto(`${entry.url}engines/external`);
    await page.locator('[data-endpoint="ollama-local"] [data-testid="engine-endpoint.test"]').click();
    await expect(page.locator('[data-endpoint="ollama-local"] [data-testid="engine-endpoint.test-result"]')).toHaveText("Reachable in 31 ms, 2 models");
    await page.locator('[data-endpoint="team-gateway"] [data-testid="engine-endpoint.test"]').click();
    await expect(page.locator('[data-endpoint="team-gateway"] [data-testid="engine-endpoint.test-result"]')).toHaveText("Test failed: unauthorized");
    expect(callsTo(mock, "POST", `${EP}/ollama-local/test`)).toHaveLength(1);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Edit never shows the stored key: replace sends a new one, remove sends null, keep sends nothing for it", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { [`PATCH ${EP}/team-gateway`]: { ok: true, endpoint: { endpointId: "team-gateway" } } } });
  try {
    await page.goto(`${entry.url}engines/external`);
    const open = async () => {
      await page.locator('[data-endpoint="team-gateway"] [data-testid="engine-endpoint.edit"]').click();
      return dialogOf(page, "engine-endpoint.dialog");
    };
    let dialog = await open();
    await expect(dialog.locator('[data-testid="engine-endpoint.id"]')).toHaveText("team-gateway");
    await expect(dialog.locator('[data-testid="engine-endpoint.key-actions"]')).toContainText("Key stored");
    await expect(dialog.locator('[data-testid="engine-endpoint.field.apiKey"]')).toHaveCount(0);
    await expect(dialog).not.toContainText("engines.external");
    const values = await dialog.locator("input").evaluateAll((nodes) => nodes.map((node) => node.value));
    expect(values.join("|")).not.toContain("engines.external");

    // Keep: changing only the name sends only the name.
    await dialog.locator('[data-testid="engine-endpoint.field.label"]').fill("Gateway");
    await dialog.locator('[data-testid="engine-endpoint.save"]').click();
    await expect(byId(page, "engine-endpoint.dialog")).toHaveCount(0);
    expect(callsTo(mock, "PATCH", EP)[0].body).toEqual({ label: "Gateway" });

    dialog = await open();
    await dialog.locator('[data-testid="engine-endpoint.key.replace"]').check();
    await dialog.locator('[data-testid="engine-endpoint.field.apiKey"]').fill(KEY);
    await dialog.locator('[data-testid="engine-endpoint.save"]').click();
    await expect(byId(page, "engine-endpoint.dialog")).toHaveCount(0);
    expect(callsTo(mock, "PATCH", EP)[1].body).toEqual({ apiKey: KEY });

    dialog = await open();
    await dialog.locator('[data-testid="engine-endpoint.key.remove"]').check();
    await expect(dialog.locator('[data-testid="engine-endpoint.field.apiKey"]')).toHaveCount(0);
    await dialog.locator('[data-testid="engine-endpoint.save"]').click();
    await expect(byId(page, "engine-endpoint.dialog")).toHaveCount(0);
    expect(callsTo(mock, "PATCH", EP)[2].body).toEqual({ apiKey: null });
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(KEY);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Remove asks first and deletes with ?confirm=1 only on Confirm", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { [`DELETE ${EP}/ollama-local`]: { ok: true, removed: "ollama-local" } } });
  try {
    await page.goto(`${entry.url}engines/external`);
    await page.locator('[data-endpoint="ollama-local"] [data-testid="engine-endpoint.remove"]').click();
    const dialog = await dialogOf(page, "engine-endpoint.remove-dialog");
    await expect(dialog).toContainText("Remove Ollama (this PC)?");
    await expect(dialog).toContainText("stored key are deleted");
    expect(callsTo(mock, "DELETE", EP)).toEqual([]);
    await dialog.locator('[data-testid="dialog.cancel"]').click();
    expect(callsTo(mock, "DELETE", EP)).toEqual([]);
    await page.locator('[data-endpoint="ollama-local"] [data-testid="engine-endpoint.remove"]').click();
    await (await dialogOf(page, "engine-endpoint.remove-dialog")).locator('[data-testid="dialog.confirm"]').click();
    await expect.poll(() => callsTo(mock, "DELETE", EP).length).toBe(1);
    const [call] = callsTo(mock, "DELETE", EP);
    expect(call.path).toBe(`${EP}/ollama-local`);
    expect(call.query).toEqual({ confirm: "1" });
    expect(call.headers["x-csrf-token"]).toBe("t");
  } finally {
    await context.close();
  }
});

test("with no external endpoints the page says how to add one", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: { [`GET ${EP}`]: { ok: true, engineId: "external", endpoints: [] } } });
  try {
    await page.goto(`${entry.url}engines/external`);
    await expect(byId(page, "empty-state.root")).toContainText("No external endpoints yet");
    await byId(page, "empty-state.action").click();
    await expect(byId(page, "engine-endpoint.dialog")).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Language, themes, phone width, accessibility

const PAGES = [
  { name: "list", url: "engines", ready: "engines.cards" },
  { name: "detail", url: "engines/sglang", ready: "engine-detail" },
  { name: "builder", url: "engines/new", ready: "engine-new" },
  { name: "external", url: "engines/external", ready: "engine-endpoints.table" },
];
const PAGE_API = {
  "GET /api/m/vllm/engines/sglang/schema": fixture("schema-sglang"),
  [`GET /api/m/vllm/engines/sglang/runtimes/${RUNTIME_A}/flags`]: fixture("engines-flags"),
};

for (const theme of ["light", "dark"]) {
  for (const [sizeName, size] of Object.entries(SIZES)) {
    test(`the engine pages have no axe findings and no horizontal overflow, ${theme} at ${sizeName}`, async ({ browser }) => {
      const { context, page, failures } = await newPage(browser, { theme, size, api: PAGE_API });
      try {
        for (const item of PAGES) {
          await page.goto(`${entry.url}${item.url}`);
          await expect(byId(page, item.ready)).toBeVisible();
          await expectNoOverflow(page);
          await expectNoA11yViolations(page, { label: `${item.name} ${theme} ${sizeName}` });
        }
        // The detail tabs and the builder's later steps.
        await page.goto(`${entry.url}engines/sglang`);
        for (const tab of ["Parameters", "Flag diff", "Recipes", "Descriptor"]) {
          await page.getByRole("tab", { name: tab }).click();
          await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
          await expect(byId(page, "tabs.panel")).toBeVisible();
          await page.waitForLoadState("networkidle");
          await expectNoOverflow(page);
          await expectNoA11yViolations(page, { label: `detail ${tab} ${theme} ${sizeName}` });
        }
        expect(realFailures(failures)).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}

test("the builder steps and the endpoint dialogs have no axe findings", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: { [VALIDATE]: { ok: true, kind: "descriptor", errors: [] }, [`DELETE ${EP}/ollama-local`]: { ok: true } } });
  try {
    await page.goto(`${entry.url}engines/new`);
    await byId(page, "engine-new.next").click();
    await expectNoA11yViolations(page, { label: "builder basics with errors" });
    await fillBasics(page);
    await byId(page, "engine-new.next").click();
    await expectNoA11yViolations(page, { label: "builder mapping" });
    await byId(page, "engine-new.next").click();
    await expectNoA11yViolations(page, { label: "builder memory" });
    await byId(page, "engine-new.next").click();
    await expect(byId(page, "engine-new.server")).toHaveAttribute("data-state", "ok");
    await expectNoA11yViolations(page, { label: "builder review" });

    await page.goto(`${entry.url}engines/external`);
    await byId(page, "engine-endpoint.add").click();
    await dialogOf(page, "engine-endpoint.dialog");
    await expectNoA11yViolations(page, { label: "endpoint dialog" });
    await byId(page, "engine-endpoint.cancel").click();
    await page.locator('[data-endpoint="team-gateway"] [data-testid="engine-endpoint.edit"]').click();
    await dialogOf(page, "engine-endpoint.dialog");
    await expectNoA11yViolations(page, { label: "endpoint edit dialog" });
    await byId(page, "engine-endpoint.cancel").click();
    await page.locator('[data-endpoint="ollama-local"] [data-testid="engine-endpoint.remove"]').click();
    await dialogOf(page, "engine-endpoint.remove-dialog");
    await expectNoA11yViolations(page, { label: "endpoint remove dialog" });
  } finally {
    await context.close();
  }
});

test("English has no Han text outside backend data and no raw keys; Chinese has no raw keys", async ({ browser }) => {
  for (const locale of ["en-US", "zh-CN"]) {
    const { context, page } = await newPage(browser, { locale, api: { ...PAGE_API, [VALIDATE]: { ok: true, kind: "descriptor", errors: [] } } });
    try {
      for (const item of PAGES) {
        await page.goto(`${entry.url}${item.url}`);
        await expect(byId(page, item.ready)).toBeVisible();
        const text = await page.evaluate(() => {
          const clone = document.querySelector("#main").cloneNode(true);
          for (const node of clone.querySelectorAll("[data-user-content], code, pre")) node.remove();
          return clone.innerText;
        });
        expect(text, `${locale} ${item.name}: raw keys`).not.toMatch(RAW_KEY);
        if (locale === "en-US") expect(text, `en-US ${item.name}: Han`).not.toMatch(HAN);
        else expect(text, `zh-CN ${item.name}`).toMatch(HAN);
      }
      // The detail tabs and the builder steps read in the same language.
      await page.goto(`${entry.url}engines/sglang`);
      for (const tab of ["parameters", "flags", "recipes", "descriptor"]) {
        await page.goto(`${entry.url}engines/sglang?tab=${tab}`);
        await expect(byId(page, "tabs.panel")).toBeVisible();
        await page.waitForLoadState("networkidle");
        const text = await page.evaluate(() => document.querySelector("#main").innerText);
        expect(text, `${locale} ${tab}: raw keys`).not.toMatch(RAW_KEY);
      }
      await page.goto(`${entry.url}engines/new`);
      await fillBasics(page);
      for (let step = 0; step < 3; step += 1) {
        await byId(page, "engine-new.next").click();
        const text = await page.evaluate(() => document.querySelector("#main").innerText);
        expect(text, `${locale} builder step ${step}: raw keys`).not.toMatch(RAW_KEY);
      }
    } finally {
      await context.close();
    }
  }
});
