// CON-14 browser checks (07 §13.2 console-models, part 1): the Models library,
// the Storage page and the model detail page.
//
// Library: one row per model with its facets; the capacity bars come from
// storage/usage; Delete is type-to-confirm with the bytes freed, a root has no
// Delete; the row actions send what 03 §9.5 says; with only the managers'
// `models` routes mocked the page still lists the models and says why columns
// are empty. Storage: register, set default, unregister, folder browser, preview
// (creates nothing), start, pause, switch back and clean up at parity with
// tests/model-storage.spec.cjs. Detail: ModelCardView with evidence chips
// (R-UI-1), the CompatMatrix (R-UI-2), Quantizations at 8K and 32K, Provenance.
// The real service-entry serves the console; the API is mocked in the browser
// (helpers/console-harness.js).
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
const RAW_KEY = /\bhub\.(?:library|storage|detail|nav)\.[A-Za-z]/;
const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER = {
  role: "owner",
  auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" },
  features: { engines: true, platform: true, hub: true, models: true },
};
const NOT_FOUND = { status: 404, body: { error: "Not found" } };
const ENTRY_A = "lib_a1b2c3d4e5f60718";
const ENTRY_B = "lib_b2c3d4e5f6071829";
const ENTRY_ROOT = "lib_e5f60718293a4b5c";
const MAIN = "mc_aaaaaaaaaaaaaaaaaaaa";

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

// ---------------------------------------------------------------------------
// Mocks

function hubApi(state = {}) {
  const library = fixture("models-library");
  return {
    "GET /api/hub/library": () => ({ ...library, entries: library.entries.filter((item) => !(state.deleted || []).includes(item.id)) }),
    "GET /api/hub/storage/usage": () => fixture("models-usage"),
    "GET /api/hub/tasks/tsk_delete1": () => ({ ok: true, task: { id: "tsk_delete1", kind: "delete", state: state.taskState || "succeeded", result: { entryId: state.deleting, reclaimedBytes: 8_912_345_678 }, error: null } }),
    ...Object.fromEntries(library.entries.map((item) => [`GET /api/hub/library/${item.id}`, () => ({
      ok: true,
      entry: { ...item, aliases: item.id === ENTRY_A ? ["X:/old-models/Qwen3-8B-FP8"] : [], files: [
        { path: "config.json", size: 1200, sha256: "a".repeat(64), gitOid: null, verifiedAt: null },
        { path: "model-00001-of-00002.safetensors", size: 4_500_000_000, sha256: "b".repeat(64), gitOid: null, verifiedAt: "2026-10-02T09:00:00.000Z" },
      ] },
    })])),
  };
}

const LEGACY_MODELS = {
  local: [
    { kind: "local", id: "legacy-model-7B", storageId: "legacy", storageLabel: "Original library", label: "legacy-model-7B", path: "X:/models/legacy-model-7B", size: 15_032_385_536, modified: "2026-09-01T08:00:00.000Z", runnable: true, verificationStatus: "ok", modelFormat: "safetensors", hasGguf: false },
    { kind: "local", id: "Y:/models/gguf-model", storageId: "r_second", storageLabel: "Library Y", label: "gguf-model-Q4", path: "Y:/models/gguf-model", size: 4_300_000_000, modified: "2026-09-02T08:00:00.000Z", runnable: true, verificationStatus: "warn", modelFormat: "gguf", hasGguf: true },
  ],
  cached: [],
};

function baseApi(extra = {}) {
  return {
    "GET /api/status": fixture("status"),
    "GET /api/fleet": fixture("fleet"),
    "GET /api/platform/status": fixture("platform-status"),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    "GET /api/engines": fixture("engines"),
    "GET /api/knowledge/status": NOT_FOUND,
    ...extra,
  };
}

async function newPage(browser, { api = {}, size = SIZES.desktop, theme = "light", locale = "en-US" } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, OWNER);
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const mock = await mockConsoleApi(page, baseApi(api));
  return { context, page, mock, failures };
}

// Pages that are not in the build yet log a failed module load, and the mocks answer 404 on purpose.
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));
const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const callsTo = (mock, method, prefix) => mock.calls.filter((call) => call.method === method && call.path.startsWith(prefix));
const rowOf = (page, name) => page.locator('[data-testid="data-table.row"]').filter({ hasText: name });

async function openLibrary(page) {
  await page.goto(`${entry.url}models`);
  await expect(byId(page, "library")).toBeVisible();
  await expect(byId(page, "library.table")).toBeVisible();
  await expect(page.locator('[data-testid="data-table.row"]').first()).toBeVisible();
}

// ---------------------------------------------------------------------------
// Library

test("the library lists every model with its columns, and the capacity bars come from storage/usage", async ({ browser }) => {
  const { context, page, failures } = await newPage(browser, { api: hubApi() });
  try {
    await openLibrary(page);
    await expect(byId(page, "library")).toHaveAttribute("data-source", "hub");
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(6);
    await expect(byId(page, "library.degraded")).toHaveCount(0);

    const qwen = rowOf(page, "Qwen3-8B-FP8").first();
    await expect(qwen).toContainText("safetensors");
    await expect(qwen).toContainText("Qwen/Qwen3-8B-FP8@40f1c0de");
    await expect(qwen).toContainText("Source declared");
    await expect(qwen).toContainText("Update available: 3 files");
    await expect(qwen.locator('[data-engine="vllm"]')).toBeVisible();
    await expect(qwen.locator('[data-engine="sglang"]')).toBeVisible();
    await expect(qwen.locator('[data-status="ok"]').first()).toContainText("Verified");
    await expect(byId(page, "library.duplicate").first()).toBeVisible();
    await expect(rowOf(page, "gemma-3-12b-it-Q4_K_M").locator('[data-testid="library.residue"]')).toContainText("3.7 GiB leftovers");
    await expect(rowOf(page, "mymodel-root").locator('[data-status="error"]')).toContainText("Failed");

    // Capacity: one bar per visible root (the hidden legacy root is left out) and the cache drive.
    const roots = byId(page, "capacity.root");
    await expect(roots).toHaveCount(2);
    await expect(roots.nth(0)).toContainText("Library X");
    await expect(roots.nth(1)).toContainText("Library Y");
    const second = roots.nth(1);
    await expect(second.locator('[data-testid="stacked-bar.part"]')).toContainText(["Other files on the drive", "Models", "Leftovers of interrupted downloads", "Still to be written by downloads"]);
    await expect(second.locator('[data-testid="stacked-bar.part"]').filter({ hasText: "Leftovers" })).toContainText("3.7 GiB");
    await expect(byId(page, "capacity.cache")).toContainText("Hugging Face cache drive");
    await expect(byId(page, "capacity.hidden")).toBeVisible();
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the facets narrow the table: root, format, runnable-on-engine, role and has-update", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: hubApi() });
  try {
    await openLibrary(page);
    await byId(page, "library.filter.rootId").selectOption("r_second");
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="data-table.row"]')).toContainText("gemma-3-12b-it-Q4_K_M");
    await byId(page, "library.filter.rootId").selectOption("");
    await byId(page, "library.filter.format").selectOption("gguf");
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(1);
    await byId(page, "library.filter.format").selectOption("");
    await byId(page, "library.filter.engine").selectOption("sglang");
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="data-table.row"]')).toContainText("Qwen3-8B-FP8");
    await byId(page, "library.filter.engine").selectOption("");
    await byId(page, "library.filter.role").selectOption("tooling-only");
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="data-table.row"]')).toContainText("sglang-tools");
    await byId(page, "library.filter.role").selectOption("");
    await byId(page, "library.filter.update").check();
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(1);
    await byId(page, "library.filter.update").uncheck();
    await byId(page, "library.filter.q").fill("nothing-matches-this");
    await expect(byId(page, "library.no-match")).toBeVisible();
    await byId(page, "library.filter.q").fill("");
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(6);
  } finally {
    await context.close();
  }
});

test("Delete is type-to-confirm on the folder name, sends it, follows the task and reports the bytes freed; a root has no Delete", async ({ browser }) => {
  const state = { deleted: [], deleting: ENTRY_B };
  const api = {
    ...hubApi(state),
    [`DELETE /api/hub/library/${ENTRY_B}`]: () => {
      state.deleted.push(ENTRY_B);
      return { status: 202, body: { ok: true, taskId: "tsk_delete1", task: { id: "tsk_delete1", state: "queued" } } };
    },
  };
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await openLibrary(page);
    // The model-mode root is the library entry itself: no Delete, a note instead.
    await expect(rowOf(page, "mymodel-root").locator('[data-testid="library.delete-open"]')).toHaveCount(0);
    await expect(rowOf(page, "mymodel-root").locator('[data-testid="library.root-note"]')).toBeVisible();

    const row = rowOf(page, "gemma-3-12b-it-Q4_K_M");
    await row.locator('[data-testid="library.delete-open"]').click();
    const dialog = byId(page, "library.delete");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("never stops a running container");
    await expect(dialog).toContainText("6.8 GiB");
    await expect(byId(page, "dialog.expected")).toHaveText("gemma-3-12b-it-Q4_K_M");
    await expect(byId(page, "dialog.confirm")).toBeDisabled();
    await byId(page, "dialog.input").fill("gemma-3-12b-it");
    await expect(byId(page, "dialog.confirm")).toBeDisabled();
    await byId(page, "dialog.input").fill("gemma-3-12b-it-Q4_K_M");
    await expect(byId(page, "dialog.confirm")).toBeEnabled();
    expect(callsTo(mock, "DELETE", "/api/hub/library")).toHaveLength(0);
    await byId(page, "dialog.confirm").click();

    await expect(dialog).toHaveCount(0);
    const deletes = callsTo(mock, "DELETE", "/api/hub/library");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].path).toBe(`/api/hub/library/${ENTRY_B}`);
    expect(deletes[0].body).toEqual({ confirm: "gemma-3-12b-it-Q4_K_M" });
    await expect(page.locator('[data-testid="toast.root"]').filter({ hasText: "Deleted gemma-3-12b-it-Q4_K_M" })).toContainText("8.3 GiB freed");
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(5);
  } finally {
    await context.close();
  }
});

test("a failed delete keeps the dialog open and shows why; Escape and Cancel delete nothing", async ({ browser }) => {
  const api = {
    ...hubApi(),
    [`DELETE /api/hub/library/${ENTRY_A}`]: { status: 409, body: { ok: false, error: { code: "path_busy", message: "A download is writing to this folder." } } },
  };
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await openLibrary(page);
    const row = rowOf(page, "Qwen3-8B-FP8").first();
    await row.locator('[data-testid="library.delete-open"]').click();
    await byId(page, "dialog.cancel").click();
    await expect(byId(page, "library.delete")).toHaveCount(0);
    expect(callsTo(mock, "DELETE", "/api/hub/library")).toHaveLength(0);

    await row.locator('[data-testid="library.delete-open"]').click();
    await byId(page, "dialog.input").fill("Qwen3-8B-FP8");
    await byId(page, "dialog.confirm").click();
    await expect(byId(page, "dialog.error")).toContainText("A download is writing to this folder.");
    await expect(byId(page, "library.delete")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(byId(page, "library.delete")).toHaveCount(0);
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(6);
  } finally {
    await context.close();
  }
});

test("row actions send what 03 §9.5 says: verify, check update, update, clean up leftovers; Move and Probe are links", async ({ browser }) => {
  const api = {
    ...hubApi(),
    [`POST /api/hub/library/${ENTRY_A}/verify`]: { ok: true, taskId: "tsk_v1" },
    [`POST /api/hub/library/${ENTRY_A}/check-update`]: { ok: true, update: { status: "available", changedFiles: 3, bytesToDownload: 120_000_000 } },
    [`POST /api/hub/library/${ENTRY_A}/update`]: { ok: true, job: { id: "dl_up1" } },
    [`POST /api/hub/library/${ENTRY_B}/cleanup-residue`]: { ok: true, removed: ["a.incomplete", "b.incomplete"], removedBytes: 4_000_000_000 },
    "POST /api/hub/library/rescan": { ok: true, taskId: "tsk_r1" },
  };
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await openLibrary(page);
    const qwen = rowOf(page, "Qwen3-8B-FP8").first();
    await qwen.locator('[data-testid="library.verify"]').click();
    await expect.poll(() => callsTo(mock, "POST", `/api/hub/library/${ENTRY_A}/verify`).length).toBe(1);
    expect(callsTo(mock, "POST", `/api/hub/library/${ENTRY_A}/verify`)[0].body).toEqual({ checksums: false });
    await qwen.locator('[data-testid="library.check-update"]').click();
    await expect.poll(() => callsTo(mock, "POST", `/api/hub/library/${ENTRY_A}/check-update`).length).toBe(1);
    await expect(page.locator('[data-testid="toast.root"]').filter({ hasText: "Update available: 3 files" })).toBeVisible();
    await qwen.locator('[data-testid="library.update"]').click();
    await expect.poll(() => callsTo(mock, "POST", `/api/hub/library/${ENTRY_A}/update`).length).toBe(1);
    await rowOf(page, "gemma-3-12b-it-Q4_K_M").locator('[data-testid="library.cleanup"]').click();
    await expect.poll(() => callsTo(mock, "POST", `/api/hub/library/${ENTRY_B}/cleanup-residue`).length).toBe(1);
    await expect(page.locator('[data-testid="toast.root"]').filter({ hasText: "Leftovers removed" })).toContainText("3.7 GiB");
    await byId(page, "library.rescan").click();
    await expect.poll(() => callsTo(mock, "POST", "/api/hub/library/rescan").length).toBe(1);

    expect(await qwen.locator('[data-testid="library.move"]').getAttribute("href")).toBe("/models/storage?move=X%3A%2Fmodels%2FQwen3-8B-FP8");
    expect(await qwen.locator('[data-testid="library.probe"]').getAttribute("href")).toBe(`/models/library/${ENTRY_A}?tab=compat`);
    expect(await qwen.locator('[data-testid="library.deploy"]').getAttribute("href")).toBe("/deployments/new?model=X%3A%2Fmodels%2FQwen3-8B-FP8");
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("degrade: with only the managers' models routes mocked the library lists the models and says what is missing", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser, {
    api: { "GET /api/m/vllm/models": LEGACY_MODELS, "GET /api/m/llama/models": LEGACY_MODELS, "POST /api/models/inspect": () => wizard("card-main") },
  });
  try {
    await page.goto(`${entry.url}models`);
    await expect(byId(page, "library")).toHaveAttribute("data-source", "managers");
    await expect(byId(page, "library.degraded")).toContainText("model hub backend is not available");
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(2);
    await expect(rowOf(page, "legacy-model-7B")).toContainText("14 GiB");
    await expect(rowOf(page, "gguf-model-Q4")).toContainText("gguf");
    await expect(rowOf(page, "gguf-model-Q4").locator('[data-status="warn"]')).toBeVisible();
    // The hub-only columns and actions are not there; Deploy and Move still are.
    await expect(page.locator('[data-column="provenance"]')).toHaveCount(0);
    await expect(page.locator('[data-column="update"]')).toHaveCount(0);
    const first = rowOf(page, "legacy-model-7B");
    await expect(first.locator('[data-testid="library.deploy"]')).toBeVisible();
    await expect(first.locator('[data-testid="library.verify"]')).toHaveCount(0);
    await expect(first.locator('[data-testid="library.delete-open"]')).toHaveCount(0);
    await expect(byId(page, "library.rescan")).toHaveCount(0);
    // The capacity could not be read (nothing mocked for it): the library is not blocked.
    await expect(byId(page, "capacity.unavailable")).toBeVisible();
    await first.locator('[data-testid="library.link"]').click();
    await expect(byId(page, "model-detail")).toHaveAttribute("data-kind", "local");
    // The card is inspected from the folder path; there is no hub provenance to show.
    await expect(byId(page, "model-card.name")).toContainText("example-MadeUp-7B");
    expect(callsTo(mock, "POST", "/api/models/inspect")[0].body).toEqual({ path: "X:/models/legacy-model-7B" });
    await byId(page, "tabs.tab").filter({ hasText: "Provenance" }).click();
    await expect(byId(page, "detail.provenance.legacy")).toBeVisible();
    expect(mock.unmocked.filter((item) => !/hub|disk-usage|knowledge/.test(item))).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a library that cannot load shows a retry, and an empty library points to Discover", async ({ browser }) => {
  const down = await newPage(browser, { api: { "GET /api/hub/library": { status: 500, body: { ok: false, error: { code: "internal_error", message: "boom" } } } } });
  try {
    await down.page.goto(`${entry.url}models`);
    await expect(byId(down.page, "library.unavailable")).toBeVisible();
    await expect(byId(down.page, "library.unavailable")).toContainText("could not be loaded");
  } finally {
    await down.context.close();
  }
  const empty = await newPage(browser, { api: { ...hubApi(), "GET /api/hub/library": { ok: true, entries: [], roots: [], nextCursor: null, total: 0 } } });
  try {
    await empty.page.goto(`${entry.url}models`);
    await expect(byId(empty.page, "library.empty")).toBeVisible();
    await expect(byId(empty.page, "library.empty").getByRole("link", { name: "Discover models" })).toHaveAttribute("href", "/models/discover");
  } finally {
    await empty.context.close();
  }
});

// ---------------------------------------------------------------------------
// Storage (parity with tests/model-storage.spec.cjs)

const TREE = {
  "": ["X:/", "Y:/"],
  "X:/": ["models", "other drive models", "unrelated"],
  "X:/models": ["Qwen3-8B-FP8"],
  "X:/other drive models": [],
  "X:/unrelated": [],
  "Y:/": ["models"],
  "Y:/models": [],
};
const parentOf = (value) => {
  if (value === "X:/" || value === "Y:/") return "";
  const parent = value.slice(0, value.lastIndexOf("/"));
  return parent.endsWith(":") ? `${parent}/` : parent;
};

function storageBackend() {
  const state = {
    defaultRootId: "legacy",
    roots: [{ id: "legacy", label: "Original library", path: "X:/models", mode: "library", online: true, freeBytes: 1_300_000_000_000, totalBytes: 4_000_000_000_000 }],
    migrations: [],
    wrote: [],
  };
  const base = "/api/m/vllm/model-storage";
  const job = () => state.migrations[0];
  return {
    state,
    routes: {
      [`GET ${base}`]: () => ({ ok: true, roots: state.roots, defaultRootId: state.defaultRootId, aliases: [], operations: [] }),
      [`GET ${base}/migrations`]: () => ({ migrations: state.migrations }),
      [`GET ${base}/directories`]: (request, route, record) => {
        const value = String(record.query.path || "");
        const children = TREE[value];
        if (value && !children) return { status: 400, body: { error: "This folder does not exist." } };
        const filter = String(record.query.query || "").toLowerCase();
        const names = (children || TREE[""]).filter((name) => name.toLowerCase().includes(filter));
        return {
          path: value,
          parent: value ? parentOf(value) : null,
          directories: names.map((name) => ({ name, path: value ? `${value.replace(/\/$/, "")}/${name}` : name })),
          total: names.length,
          nextOffset: null,
        };
      },
      [`POST ${base}/roots`]: (request, route, record) => {
        state.wrote.push(["roots", record.body]);
        const root = { id: `root_${state.roots.length}`, label: record.body.label || record.body.path, path: record.body.path, mode: record.body.mode, online: true, freeBytes: 900_000_000_000, totalBytes: 2_000_000_000_000 };
        state.roots.push(root);
        if (record.body.makeDefault) state.defaultRootId = root.id;
        return { ok: true, root };
      },
      [`POST ${base}/default`]: (request, route, record) => {
        state.wrote.push(["default", record.body]);
        state.defaultRootId = record.body.id;
        return { ok: true };
      },
      [`POST ${base}/unregister`]: (request, route, record) => {
        state.wrote.push(["unregister", record.body]);
        state.roots = state.roots.filter((root) => root.id !== record.body.id);
        return { ok: true };
      },
      [`POST ${base}/migrations/plan`]: (request, route, record) => {
        state.wrote.push(["plan", record.body]);
        const name = record.body.outputName || record.body.source.split("/").pop();
        state.migrations = [{
          id: "mig_1", state: "planned", source: record.body.source, target: `${record.body.targetDirectory}/${name}`, targetDirectory: record.body.targetDirectory,
          needsRegistration: true, needsCreation: true, fileCount: 2, completedFiles: 0, totalBytes: 4_500_001_200, bytesDone: 0, sourceRemoved: false, createdAt: "2026-10-14T08:00:00.000Z",
        }];
        return { ...state.migrations[0], freeBytes: 1_300_000_000_000, files: [{ path: "config.json", size: 1200 }, { path: "model-00001-of-00002.safetensors", size: 4_500_000_000 }], truncated: false, sourceWillBePreserved: true };
      },
      [`POST ${base}/migrations/mig_1/start`]: () => {
        state.wrote.push(["start", "mig_1"]);
        Object.assign(job(), { state: "completed", bytesDone: job().totalBytes, completedFiles: 2, phase: "done" });
        return { ok: true };
      },
      [`POST ${base}/migrations/mig_1/cancel`]: () => {
        state.wrote.push(["cancel", "mig_1"]);
        Object.assign(job(), { state: "cancelled" });
        return { ok: true };
      },
      [`POST ${base}/migrations/mig_1/rollback`]: () => {
        state.wrote.push(["rollback", "mig_1"]);
        Object.assign(job(), { state: "rolled_back" });
        return { ok: true };
      },
      [`POST ${base}/migrations/mig_1/cleanup`]: (request, route, record) => {
        state.wrote.push(["cleanup", record.body]);
        Object.assign(job(), { sourceRemoved: true });
        return { ok: true };
      },
    },
  };
}

const rootRow = (page, name) => page.locator('[data-testid="storage.root"]').filter({ hasText: name });

test("storage: register a folder through the browser, set it default, preview creates nothing, start, switch back and clean up asks for the path", async ({ browser }) => {
  const backend = storageBackend();
  const { context, page, mock, failures } = await newPage(browser, { api: { ...hubApi(), ...backend.routes } });
  try {
    await page.goto(`${entry.url}models/storage`);
    await expect(byId(page, "storage")).toBeVisible();
    await expect(byId(page, "storage.root")).toHaveCount(1);
    await expect(rootRow(page, "Original library")).toContainText("Default download location");
    await expect(rootRow(page, "Original library")).toContainText("1.2 TiB free of 3.6 TiB");
    await expect(byId(page, "capacity.root").first()).toBeVisible();

    // Register: the folder browser drills down, filters and hands the path back.
    await byId(page, "storage.register-open").click();
    await byId(page, "storage.register-browse").click();
    await expect(byId(page, "folder.dialog")).toBeVisible();
    await expect(byId(page, "folder.item")).toHaveText(["X:/", "Y:/"]);
    await expect(byId(page, "folder.choose")).toBeDisabled();
    await byId(page, "folder.item").filter({ hasText: "X:/" }).click();
    await expect(byId(page, "folder.selected")).toHaveText("X:/");
    await expect(byId(page, "folder.choose")).toBeDisabled();
    await byId(page, "folder.filter").fill("other");
    await expect(byId(page, "folder.item")).toHaveCount(1);
    await byId(page, "folder.item").click();
    await expect(byId(page, "folder.selected")).toHaveText("X:/other drive models");
    await byId(page, "folder.up").click();
    await expect(byId(page, "folder.selected")).toHaveText("X:/");
    await byId(page, "folder.filter").fill("other");
    await expect(byId(page, "folder.item")).toHaveCount(1);
    await byId(page, "folder.item").click();
    await byId(page, "folder.choose").click();
    await expect(byId(page, "folder.dialog")).toHaveCount(0);
    await expect(byId(page, "storage.register-path")).toHaveValue("X:/other drive models");
    await byId(page, "storage.register-label").fill("Second library");
    await byId(page, "storage.register-default").check();
    await byId(page, "storage.register-save").click();
    await expect(byId(page, "storage.root")).toHaveCount(2);
    await expect(rootRow(page, "Second library")).toContainText("Default download location");
    expect(backend.state.wrote[0]).toEqual(["roots", { path: "X:/other drive models", label: "Second library", mode: "library", create: false, makeDefault: true }]);

    // Set default back, then unregister asks first and keeps the files.
    await rootRow(page, "Original library").locator('[data-testid="storage.set-default"]').click();
    await expect(rootRow(page, "Original library")).toContainText("Default download location");
    expect(backend.state.wrote.at(-1)).toEqual(["default", { id: "legacy" }]);
    await rootRow(page, "Second library").locator('[data-testid="storage.unregister"]').click();
    await expect(byId(page, "storage.unregister-confirm")).toContainText("the files on disk stay");
    await byId(page, "dialog.cancel").click();
    await expect(byId(page, "storage.root")).toHaveCount(2);
    await rootRow(page, "Second library").locator('[data-testid="storage.unregister"]').click();
    await byId(page, "dialog.confirm").click();
    await expect(byId(page, "storage.root")).toHaveCount(1);
    await expect(rootRow(page, "Original library").locator('[data-testid="storage.unregister"]')).toHaveCount(0);

    // The planner: a typed target and name give the final location; the preview creates and registers nothing.
    await expect(byId(page, "storage.planner.target")).toHaveValue("X:/models");
    await byId(page, "storage.planner.target").fill("Y:/direct entry/models");
    await byId(page, "storage.planner.name").fill("renamed-model");
    await expect(byId(page, "storage.planner.destination")).toHaveText("Y:/direct entry/models/renamed-model");
    const rootsBefore = backend.state.roots.length;
    await byId(page, "storage.planner.preview").click();
    await expect(byId(page, "storage.preview")).toBeVisible();
    await expect(byId(page, "storage.preview.size")).toContainText("2 files");
    await expect(byId(page, "storage.preview.registers")).toContainText("created and registered when you start");
    expect(backend.state.roots).toHaveLength(rootsBefore);
    expect(backend.state.wrote.find((item) => item[0] === "plan")[1]).toEqual({ source: "X:/models/Qwen3-8B-FP8", targetDirectory: "Y:/direct entry/models", outputName: "renamed-model" });
    // Editing the form hides the stale preview.
    await byId(page, "storage.planner.name").fill("other-name");
    await expect(byId(page, "storage.preview")).toHaveCount(0);
    await byId(page, "storage.planner.name").fill("renamed-model");
    await byId(page, "storage.planner.preview").click();

    await byId(page, "storage.preview.start").click();
    await expect(byId(page, "storage.start-confirm")).toBeVisible();
    expect(backend.state.wrote.some((item) => item[0] === "start")).toBe(false);
    await byId(page, "dialog.confirm").click();
    await expect.poll(() => backend.state.wrote.some((item) => item[0] === "start")).toBe(true);
    const migration = byId(page, "storage.migration");
    await expect(migration).toHaveAttribute("data-state", "completed");
    await expect(byId(page, "storage.migration.kept")).toContainText("source files are kept");
    await expect(byId(page, "storage.migrations.count")).toHaveText("1 tasks");

    // Clean up needs the exact source path; switching back needs a confirmation.
    await byId(page, "storage.migration.cleanup").click();
    await expect(byId(page, "dialog.confirm")).toBeDisabled();
    await byId(page, "dialog.input").fill("wrong path");
    await expect(byId(page, "dialog.confirm")).toBeDisabled();
    await byId(page, "dialog.cancel").click();
    expect(backend.state.wrote.some((item) => item[0] === "cleanup")).toBe(false);
    await byId(page, "storage.migration.rollback").click();
    await byId(page, "dialog.confirm").click();
    await expect(migration).toHaveAttribute("data-state", "rolled_back");
    expect(mock.csrfViolations).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("storage: cleanup sends confirmSource with the typed source path; ?move= preselects the source; leftovers are cleaned after a confirmation", async ({ browser }) => {
  const backend = storageBackend();
  backend.state.migrations = [{
    id: "mig_1", state: "completed", source: "X:/models/Qwen3-8B-FP8", target: "Y:/models/Qwen3-8B-FP8", targetDirectory: "Y:/models", fileCount: 2, completedFiles: 2,
    totalBytes: 4_500_001_200, bytesDone: 4_500_001_200, sourceRemoved: false, createdAt: "2026-10-14T08:00:00.000Z",
  }];
  const api = { ...hubApi(), ...backend.routes, "POST /api/hub/storage/cleanup": { ok: true, reclaimedBytes: 16_000_000_000, results: [] } };
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}models/storage?move=${encodeURIComponent("Y:/models/gemma-3-12b-it-Q4_K_M")}`);
    await expect(byId(page, "storage.planner.source")).toHaveValue("Y:/models/gemma-3-12b-it-Q4_K_M");
    await expect(byId(page, "storage.planner.source-path")).toHaveText("Y:/models/gemma-3-12b-it-Q4_K_M");

    await byId(page, "storage.migration.cleanup").click();
    await byId(page, "dialog.input").fill("X:/models/Qwen3-8B-FP8");
    await byId(page, "dialog.confirm").click();
    await expect.poll(() => backend.state.wrote.some((item) => item[0] === "cleanup")).toBe(true);
    expect(backend.state.wrote.find((item) => item[0] === "cleanup")[1]).toEqual({ confirmSource: "X:/models/Qwen3-8B-FP8" });

    await expect(byId(page, "storage.leftovers")).toContainText("2 leftovers of interrupted downloads");
    await expect(byId(page, "storage.leftovers.duplicates")).toContainText("8.3 GiB");
    await byId(page, "storage.leftovers.clean").click();
    await byId(page, "dialog.confirm").click();
    await expect.poll(() => callsTo(mock, "POST", "/api/hub/storage/cleanup").length).toBe(1);
    expect(callsTo(mock, "POST", "/api/hub/storage/cleanup")[0].body).toEqual({
      targets: [{ kind: "incomplete", entryId: ENTRY_B }, { kind: "partial-download", jobId: "dl_orphan01" }],
      confirm: true,
    });
    await expect(page.locator('[data-testid="toast.root"]').filter({ hasText: "Cleaned up" })).toContainText("14.9 GiB");
  } finally {
    await context.close();
  }
});

test("storage: a running migration shows its progress and can be paused and continued", async ({ browser }) => {
  const backend = storageBackend();
  backend.state.migrations = [{
    id: "mig_1", state: "copying", source: "X:/models/Qwen3-8B-FP8", target: "Y:/models/Qwen3-8B-FP8", fileCount: 2, completedFiles: 1,
    totalBytes: 4_000_000_000, bytesDone: 1_000_000_000, currentFile: "model-00002-of-00002.safetensors", phase: "copying", sourceRemoved: false,
  }];
  const { context, page } = await newPage(browser, { api: { ...hubApi(), ...backend.routes } });
  try {
    await page.goto(`${entry.url}models/storage`);
    const migration = byId(page, "storage.migration");
    await expect(migration).toHaveAttribute("data-state", "copying");
    await expect(byId(page, "storage.migration.progress")).toContainText("1 of 2 files");
    await expect(byId(page, "storage.migration.progress").locator('[role="progressbar"]')).toHaveAttribute("aria-valuenow", "25");
    await expect(migration).toContainText("model-00002-of-00002.safetensors");
    await expect(byId(page, "storage.migration.cleanup")).toHaveCount(0);
    await byId(page, "storage.migration.cancel").click();
    await expect(migration).toHaveAttribute("data-state", "cancelled");
    expect(backend.state.wrote.at(-1)).toEqual(["cancel", "mig_1"]);
    await expect(byId(page, "storage.migration.start")).toHaveText("Continue the move");
  } finally {
    await context.close();
  }
});

test("storage: when no manager answers the page says so and keeps the capacity bars", async ({ browser }) => {
  const down = { status: 502, body: { ok: false, error: { code: "manager_unreachable", message: "The vllm manager is not running." } } };
  const { context, page } = await newPage(browser, { api: { ...hubApi(), "GET /api/m/vllm/model-storage": down, "GET /api/m/llama/model-storage": down } });
  try {
    await page.goto(`${entry.url}models/storage`);
    await expect(byId(page, "storage.unavailable")).toBeVisible();
    await expect(byId(page, "capacity.root").first()).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Model detail

const REMOTE_CARD = "mc_cccccccccccccccccccc";
const REPO = "/api/hub/repos/huggingface/example-org/example-model-7B";
const fit = (label, neededMb, extra = {}) => ({ label, status: label === "fits" ? "ok" : "warn", spill: false, neededMb, confidence: "estimate", policy: "gguf-estimate", basis: "params", ...extra });

function repoDetail(context) {
  const wide = context === "32768";
  return {
    ok: true,
    provider: "huggingface",
    repo: "example-org/example-model-7B",
    revision: "main",
    revisionSha: "a".repeat(40),
    fetchedFrom: "https://huggingface.co",
    summary: { task: "text-generation", license: "apache-2.0", baseModel: "example-org/example-base-7B", paramsB: 7.6, contextLength: 131072, lastModified: "2026-09-30T08:00:00.000Z" },
    access: { gated: true, status: "login_required", authorizationUrl: null },
    files: { count: 3, totalBytes: 20_000_000_000, truncated: false },
    artifacts: [
      { artifactKey: "gguf:|Q4_K_M", kind: "gguf-quant", label: "Q4_K_M", format: "gguf", quant: "Q4_K_M", bytes: 4_700_000_000, fileCount: 1, complete: true, fit: wide ? fit("tight", 9800) : fit("fits", 6100), engines: [{ engineId: "llamacpp", basis: "format" }], recommended: true, library: { state: "absent", entryId: null } },
      { artifactKey: "gguf:|Q8_0", kind: "gguf-quant", label: "Q8_0", format: "gguf", quant: "Q8_0", bytes: 8_100_000_000, fileCount: 1, complete: true, fit: wide ? fit("wont-fit", 140_000) : fit("fits", 10_200), engines: [{ engineId: "llamacpp", basis: "format" }], recommended: false, library: { state: "present", entryId: ENTRY_A } },
      { artifactKey: "st:", kind: "safetensors", label: "BF16", format: "safetensors", quant: "BF16", bytes: 15_200_000_000, fileCount: 4, complete: true, fit: fit("fits", 18_000, { spill: wide }), engines: [{ engineId: "vllm", basis: "format" }, { engineId: "sglang", basis: "format" }], recommended: false, library: { state: "absent", entryId: null } },
    ],
    card: { cardId: REMOTE_CARD, identity: {}, role: "main", evidence: [] },
    compatibility: [],
    siblingRepos: [],
    warnings: [{ code: "custom_code", message: "This repository ships Python files that run with trust_remote_code" }],
  };
}

function detailApi(extra = {}) {
  return {
    ...hubApi(),
    [`GET /api/models/${MAIN}/card`]: () => wizard("card-main"),
    [`GET /api/models/${MAIN}/compatibility`]: () => wizard("compat"),
    [`POST /api/models/${MAIN}/probe`]: () => ({ status: 202, body: { ok: true, jobId: "job_probe_1", managerId: "vllm" } }),
    "GET /api/m/vllm/jobs": { jobs: [{ id: "job_probe_1", type: "model-probe", state: "success", progress: { percent: 100 } }] },
    [`GET /api/models/${REMOTE_CARD}/card`]: () => wizard("card-remote"),
    [`GET /api/models/${REMOTE_CARD}/compatibility`]: () => ({ ...wizard("compat"), cardId: REMOTE_CARD }),
    [REPO.replace(/^/, "GET ")]: (request, route, record) => repoDetail(record.query.context),
    [`GET ${REPO}/readme`]: { ok: true, markdown: "# Example model\n\nA **made up** model for tests.", truncated: false, revisionSha: "a".repeat(40) },
    [`GET ${REPO}/files`]: (request, route, record) => (record.query.cursor
      ? { ok: true, files: [{ path: "tokenizer.json", size: 11_000_000 }], nextCursor: null }
      : { ok: true, files: [{ path: "config.json", size: 900 }, { path: "model-Q4_K_M.gguf", size: 4_700_000_000 }], nextCursor: "page2" }),
    "GET /api/hub/repos/huggingface/Qwen/Qwen3-8B-FP8/readme": { ok: true, markdown: "# Qwen3 8B FP8\n\nReadme of the provenance repository.", truncated: true },
    ...extra,
  };
}

test("detail of a local model: the card shows an evidence chip per fact and says when a name was only a guess (R-UI-1)", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser, { api: detailApi() });
  try {
    await page.goto(`${entry.url}models/library/${ENTRY_A}`);
    await expect(byId(page, "model-detail")).toHaveAttribute("data-kind", "local");
    await expect(page.locator("h1")).toHaveText("Qwen3-8B-FP8");
    await expect(byId(page, "tabs.tab")).toHaveText(["Overview", "Compatibility", "Files", "README", "Provenance"]);
    await expect(byId(page, "model-card.name")).toContainText("example-MadeUp-7B");
    const family = page.locator('[data-fact="family"]');
    await expect(family.locator('[data-confidence="name-heuristic"]')).toContainText("Guessed from the name");
    await expect(page.locator('[data-fact="modelType"] [data-confidence="declared"]')).toContainText("Declared by the model");
    // Every fact row carries a chip, even a value nothing vouches for.
    const facts = page.locator('[data-testid="model-card.fact"]');
    const total = await facts.count();
    expect(total).toBeGreaterThan(5);
    await expect(facts.locator("[data-confidence]")).toHaveCount(total);
    expect(callsTo(mock, "GET", `/api/models/${MAIN}/card`)[0].query.view).toBe("full");
    // Actions of a local model.
    await expect(byId(page, "detail.deploy")).toHaveAttribute("href", "/deployments/new?model=X%3A%2Fmodels%2FQwen3-8B-FP8");
    await expect(byId(page, "detail.open-hub")).toHaveAttribute("href", "https://huggingface.co/Qwen/Qwen3-8B-FP8");
    await expect(byId(page, "detail.open-hub")).toHaveAttribute("rel", "noopener noreferrer");
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("detail Compatibility: ok needs evidence, unknown is grey with the dry probe and Override, a blocked row is disabled (R-UI-2)", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: detailApi() });
  try {
    await page.goto(`${entry.url}models/library/${ENTRY_A}?tab=compat`);
    await expect(byId(page, "detail.compat")).toBeVisible();
    const rows = page.locator('[data-testid="compat.row"]');
    await expect(rows.first()).toBeVisible();
    const vllm = rows.filter({ has: page.locator('[data-engine="vllm"]') }).or(page.locator('[data-testid="compat.row"][data-engine="vllm"]')).first();
    await expect(vllm).toHaveAttribute("data-verdict", "ok");
    // The fixture marks sglang ok without any evidence: it must not read green.
    const sglang = page.locator('[data-testid="compat.row"][data-engine="sglang"]');
    await expect(sglang).toHaveAttribute("data-verdict", "unknown");
    await expect(sglang.locator('[data-testid="compat.verdict"]')).toContainText("Unknown (unverified)");
    await expect(sglang.locator('[data-testid="compat.probe"]')).toBeVisible();
    await expect(sglang.locator('[data-testid="compat.override"]')).toBeVisible();
    await expect(page.locator('[data-testid="compat.row"][data-engine="llamacpp"]')).toHaveAttribute("data-verdict", "block");
    await expect(page.locator('[data-testid="compat.row"][data-engine="llamacpp"] [data-testid="compat.select"]')).toBeDisabled();

    await sglang.locator('[data-testid="compat.probe"]').click();
    await expect.poll(() => callsTo(mock, "POST", `/api/models/${MAIN}/probe`).length).toBe(1);
    expect(callsTo(mock, "POST", `/api/models/${MAIN}/probe`)[0].body).toEqual({ engineId: "sglang", runtimeId: "sglang@0.5.17", allowRemoteCode: false });
    await expect(byId(page, "wizard.probe")).toHaveAttribute("data-state", "success", { timeout: 15000 });

    // Override opens the wizard with the engine chosen, where the warning is.
    await sglang.locator('[data-testid="compat.override"]').click();
    await expect(page).toHaveURL(/\/deployments\/new\?model=X%3A%2Fmodels%2FQwen3-8B-FP8&engine=sglang&manager=vllm/);
  } finally {
    await context.close();
  }
});

test("detail Files, README and Provenance of a local model", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: detailApi() });
  try {
    await page.goto(`${entry.url}models/library/${ENTRY_A}?tab=files`);
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="data-table.row"]').nth(1)).toContainText("model-00001-of-00002.safetensors");
    await byId(page, "tabs.tab").filter({ hasText: "README" }).click();
    await expect(byId(page, "detail.readme")).toContainText("Readme of the provenance repository");
    await expect(byId(page, "detail.readme")).toContainText("shortened");
    await byId(page, "tabs.tab").filter({ hasText: "Provenance" }).click();
    const provenance = byId(page, "detail.provenance");
    await expect(provenance).toContainText("Qwen/Qwen3-8B-FP8");
    await expect(provenance).toContainText("Source declared");
    await expect(provenance).toContainText("40f1c0de8a1b2c3d4e5f60718293a4b5c6d7e8f9");
    await expect(provenance.getByRole("link", { name: "dl_job0001" })).toHaveAttribute("href", "/models/downloads?job=dl_job0001");
    await expect(byId(page, "detail.provenance.history")).toContainText("X:/old-models/Qwen3-8B-FP8");
    // The tab is in the URL, so a reload and a shared link keep it.
    await expect(page).toHaveURL(/tab=provenance/);
  } finally {
    await context.close();
  }
});

test("detail of a model that is gone says so and links back to the library", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: { ...hubApi(), "GET /api/hub/library/lib_gone": { status: 404, body: { ok: false, error: { code: "library_entry_not_found", message: "No such library entry." } } } },
  });
  try {
    await page.goto(`${entry.url}models/library/lib_gone`);
    await expect(byId(page, "detail.missing")).toContainText("This model was not found");
    await expect(byId(page, "detail.missing").getByRole("link", { name: "Back to the library" })).toHaveAttribute("href", "/models");
  } finally {
    await context.close();
  }
});

test("detail of a repository: the summary and gated access, Quantizations at 8K and 32K, Download links to the plan sheet, README and paged Files", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser, { api: detailApi() });
  try {
    await page.goto(`${entry.url}models/hub/huggingface/example-org/example-model-7B?draft=d1`);
    await expect(byId(page, "model-detail")).toHaveAttribute("data-kind", "remote");
    await expect(page.locator("h1")).toHaveText("example-org/example-model-7B");
    await expect(byId(page, "tabs.tab")).toHaveText(["Overview", "Compatibility", "Quantizations", "Files", "README"]);
    await expect(byId(page, "detail.summary")).toContainText("apache-2.0");
    await expect(byId(page, "detail.summary")).toContainText("7.6 B");
    await expect(byId(page, "detail.access")).toHaveText("Sign-in required");
    await expect(byId(page, "detail.warnings")).toContainText("trust_remote_code");
    await expect(byId(page, "model-card.name")).toBeVisible();
    await expect(byId(page, "detail.back-to-wizard")).toHaveAttribute("href", "/deployments/new?draft=d1");
    const plan = "/models/discover?drawer=plan&provider=huggingface&repo=example-org%2Fexample-model-7B";
    await expect(byId(page, "detail.download")).toHaveAttribute("href", plan);
    await expect(byId(page, "detail.download-deploy")).toHaveAttribute("href", `${plan}&runAfter=deploy`);
    await expect(byId(page, "detail.open-hub")).toHaveAttribute("href", "https://huggingface.co/example-org/example-model-7B");

    await byId(page, "tabs.tab").filter({ hasText: "Quantizations" }).click();
    const quants = page.locator('[data-testid="detail.quants"] [data-testid="data-table.row"]');
    await expect(quants).toHaveCount(3);
    const q4 = quants.filter({ hasText: "Q4_K_M" });
    await expect(q4.locator('[data-testid="detail.quants.recommended"]')).toBeVisible();
    await expect(q4).toContainText("Fits");
    await expect(q4).toContainText("Tight");
    await expect(quants.filter({ hasText: "Q8_0" })).toContainText("Won't fit");
    await expect(quants.filter({ hasText: "Q8_0" })).toContainText("In library");
    await expect(quants.filter({ hasText: "BF16" })).toContainText("Spills to RAM");
    await expect(q4.locator('[data-testid="detail.quants.download"]')).toHaveAttribute("href", `${plan}&artifact=gguf%3A%7CQ4_K_M`);
    expect(callsTo(mock, "GET", REPO).filter((call) => call.path === REPO).map((call) => call.query.context).sort()).toEqual(["32768", "8192"]);

    await byId(page, "tabs.tab").filter({ hasText: "README" }).click();
    await expect(byId(page, "detail.readme")).toContainText("made up");
    await byId(page, "tabs.tab").filter({ hasText: "Files" }).click();
    await expect(page.locator('[data-testid="detail.files"] [data-testid="data-table.row"]')).toHaveCount(2);
    await byId(page, "data-table.load-more").click();
    await expect(page.locator('[data-testid="detail.files"] [data-testid="data-table.row"]')).toHaveCount(3);
    expect(callsTo(mock, "GET", `${REPO}/files`).map((call) => call.query.cursor || "")).toEqual(["", "page2"]);

    // A repository is not on disk: the matrix is shown, the probe explains why it cannot run.
    await byId(page, "tabs.tab").filter({ hasText: "Compatibility" }).click();
    await expect(byId(page, "detail.compat.remote")).toBeVisible();
    await page.locator('[data-testid="compat.row"][data-engine="sglang"] [data-testid="compat.probe"]').click();
    await expect(page.locator('[data-testid="toast.root"]').filter({ hasText: "Download the model first" })).toBeVisible();
    expect(callsTo(mock, "POST", `/api/models/${REMOTE_CARD}/probe`)).toHaveLength(0);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("detail of a repository without a hub says so", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: { [`GET ${REPO}`]: NOT_FOUND } });
  try {
    await page.goto(`${entry.url}models/hub/huggingface/example-org/example-model-7B`);
    await expect(byId(page, "detail.unavailable")).toContainText("service-entry is not running");
  } finally {
    await context.close();
  }
});

test("a model that ships its own code asks for consent, listing the files, before the probe runs (R-UI-9)", async ({ browser }) => {
  const CUSTOM = "mc_dddddddddddddddddddd";
  const api = detailApi({
    [`GET /api/models/${CUSTOM}/card`]: () => wizard("card-custom"),
    [`GET /api/models/${CUSTOM}/compatibility`]: () => ({ ...wizard("compat"), cardId: CUSTOM }),
    [`POST /api/models/${CUSTOM}/probe`]: () => ({ status: 202, body: { ok: true, jobId: "job_probe_1", managerId: "vllm" } }),
  });
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}models/library/${ENTRY_ROOT}?tab=compat`);
    const probe = page.locator('[data-testid="compat.row"][data-engine="lmdeploy"] [data-testid="compat.probe"]');
    await probe.click();
    const consent = byId(page, "detail.compat.consent");
    await expect(consent).toBeVisible();
    await expect(consent).toContainText("runs its own Python code");
    await expect(consent.locator("li code").first()).toBeVisible();
    await byId(page, "dialog.cancel").click();
    expect(callsTo(mock, "POST", `/api/models/${CUSTOM}/probe`)).toHaveLength(0);
    await probe.click();
    await consent.getByRole("button", { name: "Allow and run the probe" }).click();
    await expect.poll(() => callsTo(mock, "POST", `/api/models/${CUSTOM}/probe`).length).toBe(1);
    expect(callsTo(mock, "POST", `/api/models/${CUSTOM}/probe`)[0].body).toMatchObject({ engineId: "lmdeploy", allowRemoteCode: true });
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Copy, size, accessibility

const PAGES = [
  ["library", "models", "library.table"],
  ["storage", "models/storage", "storage.planner"],
  ["detail", `models/library/${ENTRY_A}`, "model-detail"],
  ["repository", "models/hub/huggingface/example-org/example-model-7B", "model-detail"],
];

for (const locale of ["en-US", "zh-CN"]) {
  test(`every key of the Models pages renders in ${locale}, nothing overflows at 390 px, axe is clean in both themes`, async ({ browser }) => {
    const backend = storageBackend();
    backend.state.migrations = [{ id: "mig_1", state: "completed", source: "X:/models/Qwen3-8B-FP8", target: "Y:/models/Qwen3-8B-FP8", fileCount: 2, completedFiles: 2, totalBytes: 4_500_001_200, bytesDone: 4_500_001_200, sourceRemoved: false }];
    const api = detailApi(backend.routes);
    for (const theme of ["light", "dark"]) {
      for (const [label, route, ready] of PAGES) {
        const size = theme === "dark" ? SIZES.phone : SIZES.desktop;
        const { context, page, failures } = await newPage(browser, { api, locale, theme, size });
        try {
          await page.goto(`${entry.url}${route}`);
          await expect(byId(page, ready)).toBeVisible();
          if (label === "library") await expect(page.locator('[data-testid="data-table.row"]').first()).toBeVisible();
          if (label === "storage") await expect(byId(page, "storage.migration")).toBeVisible();
          if (label === "detail") await expect(byId(page, "model-card.name")).toBeVisible();
          if (label === "repository") await expect(byId(page, "detail.summary")).toBeVisible();
          const text = await page.locator("#main").innerText();
          expect(text, `${label} ${locale} shows a raw key`).not.toMatch(RAW_KEY);
          if (locale === "en-US") expect(text.replace(/\s+/g, " "), `${label} shows Han text in English`).not.toMatch(HAN);
          else expect(text).toMatch(HAN);
          await expectNoOverflow(page);
          await expectNoA11yViolations(page, { label: `${label} ${locale} ${theme}` });
          expect(realFailures(failures)).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  });
}
