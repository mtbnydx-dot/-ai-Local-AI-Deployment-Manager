// CON-14 and CON-15 browser checks (07 §13.2 console-models, parts 1 and 2).
// Part 1: the Models library, the Storage page and the model detail page.
// Part 2 (CON-15): Discover, the download plan sheet and the Downloads page.
//
// Library: one row per model with its facets; the capacity bars come from
// storage/usage; Delete is type-to-confirm with the bytes freed, a root has no
// Delete; the row actions send what 03 §9.5 says; with only the managers'
// `models` routes mocked the page still lists the models and says why columns
// are empty. Storage: register, set default, unregister, folder browser, preview
// (creates nothing), start, pause, switch back and clean up at parity with
// tests/model-storage.spec.cjs. Detail: ModelCardView with evidence chips
// (R-UI-1), the CompatMatrix (R-UI-2), Quantizations at 8K and 32K, Provenance.
//
// Discover: the debounced search sends the facets the hub parses, the cursor
// load-more appends, family cards carry variant chips and library badges. Plan
// sheet: every choice plans again, blockers come with fix buttons and the one
// call to action moves focus to them instead of sending; a token is planned
// only once committed. Downloads: SSE `downloads` updates progress with no
// refetch and a `truncated` replay refetches; queue reorder by keyboard and by
// drag sends `downloads/reorder`; the classified failure card; cancel and
// delete shows the reclaimable bytes and sends `{deletePartial, confirm}`.
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
const RAW_KEY = /\bhub\.(?:library|storage|detail|nav|discover|plan|downloads|phase|settings|state|wait|action|error|token)\.[A-Za-z]/;
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

// Long repository and file names must remain readable with every optional column enabled.
// A wide model table scrolls inside its region without widening the console shell.
for (const [viewport, variants] of [
  ["desktop", [{ locale: "en-US", theme: "light" }, { locale: "zh-CN", theme: "dark" }]],
  ["phone", [{ locale: "zh-CN", theme: "light" }, { locale: "en-US", theme: "dark" }]],
]) {
  test("long library names and sources stay bounded with all 11 columns on " + viewport, async ({ browser }) => {
    const screenshots = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "model-library-layout-"));
    for (const variant of variants) {
      const library = fixture("models-library");
      const names = [
        "Qwen3.5-397B-A17B-MXFP4-UD-Q4_K_XL-LongContext-262144-Community-Calibration-2026-10-14-00001-of-00009.gguf",
        "MiniMax-M2.5-REAP-139B-A10B-NVFP4-Dynamic-262144-context-Instruct-Community-Quantization-2026-10-14",
      ];
      const paths = names.map((name) => "X:/models/huggingface/community-quantizations/long-context-calibration/verified-2026-10-14/production-candidates/" + name + "/snapshots/2026-10-14-final/" + name);
      const repo = "community-long-context-calibration/Qwen3.5-397B-A17B-MXFP4-UD-Q4_K_XL-Instruct-262144-Community-Quantization";
      const revision = "refs/pr/123/long-context-262144-calibration-for-community-quantization-2026-10-14";
      const models = [ENTRY_A, ENTRY_B].map((id, index) => {
        const model = library.entries.find((item) => item.id === id);
        Object.assign(model, { displayName: names[index], path: paths[index] });
        model.provenance = { ...model.provenance, repo, revision, revisionSha: "" };
        return model;
      });
      const api = detailApi({
        "GET /api/hub/library": () => library,
        ...Object.fromEntries(models.map((model) => ["GET /api/hub/library/" + model.id, () => ({ ok: true, entry: { ...model, aliases: [], files: [] } })])),
      });
      const { context, page, failures } = await newPage(browser, { api, size: SIZES[viewport], ...variant });
      try {
        await openLibrary(page);
        const table = byId(page, "library.table");
        await table.locator('[data-testid="data-table.chooser-toggle"]').click();
        for (const column of ["role", "format", "root", "engines", "provenance", "update", "lastUsed"]) {
          await table.locator('[data-testid="data-table.column.' + column + '"]').check();
        }
        await table.locator('[data-testid="data-table.chooser-toggle"]').click();
        const headers = table.locator("thead th[data-column]");
        await expect(headers).toHaveCount(11);
        const columnIds = await headers.evaluateAll((items) => items.map((item) => item.dataset.column));
        const nameIndex = columnIds.indexOf("name");
        const sourceIndex = columnIds.indexOf("provenance");
        expect(nameIndex).toBeGreaterThanOrEqual(0);
        expect(sourceIndex).toBeGreaterThanOrEqual(0);
        for (const [index, model] of models.entries()) {
          const row = table.locator('[data-testid="data-table.row"]:has(a[href="/models/library/' + model.id + '"])');
          await expect(row.locator('[data-testid="library.link"]')).toHaveText(names[index]);
          await expect(row.getByText(paths[index], { exact: true })).toBeVisible();
          await expect(row.getByText(repo + "@" + revision, { exact: true })).toBeVisible();
          const geometry = await row.evaluate((element, columns) => {
            const cells = element.querySelectorAll("td");
            const name = cells[columns.name].querySelector('[data-testid="library.link"]');
            const source = cells[columns.source].querySelector("code");
            return {
              rowHeight: element.getBoundingClientRect().height,
              nameWidth: cells[columns.name].getBoundingClientRect().width,
              linkWidth: name.getBoundingClientRect().width,
              sourceWidth: cells[columns.source].getBoundingClientRect().width,
              sourceTextWidth: source.getBoundingClientRect().width,
            };
          }, { name: nameIndex, source: sourceIndex });
          console.log("library layout " + JSON.stringify({ viewport, ...variant, model: index, ...geometry }));
          expect(geometry.rowHeight, viewport + "/" + variant.locale + ": long model row height").toBeLessThanOrEqual(180);
          expect(geometry.nameWidth, "name column remains usable").toBeGreaterThanOrEqual(300);
          expect(geometry.linkWidth, "name does not collapse beside its badges").toBeGreaterThanOrEqual(200);
          expect(geometry.sourceWidth, "repository column remains usable").toBeGreaterThanOrEqual(160);
          expect(geometry.sourceTextWidth, "repository text does not become a one-character column").toBeGreaterThanOrEqual(120);
        }

        // Assert rendered capacity, not just hidden legend text in the DOM.
        for (const root of [page.locator('[data-testid="capacity.root"][data-root="r_main"]'), byId(page, "capacity.cache")]) {
          await expect(root.locator(".stack-legend")).toBeVisible();
          await expect(root.locator('[data-testid="stacked-bar.part"]').first()).toBeVisible();
          const track = root.locator(".stack-track");
          await expect(track).toBeVisible();
          expect((await track.boundingBox()).height, "capacity bar has a visible track").toBeGreaterThanOrEqual(12);
        }

        const scroll = table.locator('[data-testid="data-table.scroll"]');
        const dimensions = await scroll.evaluate((element) => ({
          left: element.getBoundingClientRect().left,
          right: element.getBoundingClientRect().right,
          client: element.clientWidth,
          scroll: element.scrollWidth,
          viewport: window.innerWidth,
        }));
        expect(dimensions.left).toBeGreaterThanOrEqual(-1);
        expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport + 1);
        expect(dimensions.scroll, "all columns are reachable through table scrolling").toBeGreaterThan(dimensions.client);
        await expectNoOverflow(page);
        const action = table.locator('[data-testid="library.actions"][data-entry="' + ENTRY_A + '"] [data-testid="library.deploy"]');
        if (viewport === "desktop") {
          expect(await scroll.evaluate((element) => element.scrollLeft)).toBe(0);
          const initialAction = await action.boundingBox();
          const initialScroll = await scroll.boundingBox();
          expect(initialAction.x, "sticky actions are visible before horizontal scrolling").toBeGreaterThanOrEqual(initialScroll.x - 1);
          expect(initialAction.x + initialAction.width).toBeLessThanOrEqual(initialScroll.x + initialScroll.width + 1);
        }
        const screenshotStem = path.join(screenshots, viewport + "-" + variant.locale + "-" + variant.theme);
        await page.screenshot({ path: screenshotStem + "-names.png", fullPage: true });
        console.log("library screenshot " + screenshotStem + "-names.png");
        await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
        await expect(action).toBeVisible();
        const actionBox = await action.boundingBox();
        const scrollBox = await scroll.boundingBox();
        expect(actionBox.x).toBeGreaterThanOrEqual(scrollBox.x - 1);
        expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(scrollBox.x + scrollBox.width + 1);
        await expectNoOverflow(page);
        await page.screenshot({ path: screenshotStem + "-actions.png", fullPage: true });
        console.log("library screenshot " + screenshotStem + "-actions.png");

        await scroll.evaluate((element) => { element.scrollLeft = 0; });
        await byId(page, "library.filter.q").fill("00001-of-00009.gguf");
        await expect(table.locator('[data-testid="data-table.row"]')).toHaveCount(1);
        await expect(table.locator('[data-testid="library.link"]')).toHaveText(names[0]);
        await byId(page, "library.filter.q").fill("");
        await expect(table.locator('[data-testid="data-table.row"]')).toHaveCount(6);
        await table.locator('a[data-testid="library.link"][href="/models/library/' + ENTRY_A + '"]').click();
        await expect(byId(page, "model-detail")).toHaveAttribute("data-kind", "local");
        await expect(page.locator("h1")).toHaveText(names[0]);
        expect(realFailures(failures)).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
}

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
// Part 2 (CON-15): Discover, the download plan sheet and the Downloads page

const PLAN_REPO = "plan-org/plan-model-8B-GGUF";
const PLAN_PATH = `/api/hub/repos/huggingface/${PLAN_REPO}`;
const SHA = "b".repeat(40);

const hit = (repo, extra = {}) => ({
  provider: "huggingface", repo, author: repo.split("/")[0], task: "text-generation", formats: ["safetensors"], quants: [], paramsB: 8.2, downloads: 120000, likes: 300,
  lastModified: "2026-10-01T00:00:00.000Z", gated: false, tags: [], baseModel: null, familyKey: "", fitHint: { label: "unknown", status: "unknown", neededMb: null, basis: "params" },
  engines: [], library: { state: "absent", entryId: null }, ...extra,
});
const SEARCH_PAGE_1 = {
  ok: true, provider: "huggingface", fetchedFrom: "https://huggingface.co", partial: false, warnings: [], nextCursor: "cur_page_2",
  items: [
    hit("Qwen/Qwen3-8B-FP8", { formats: ["safetensors", "fp8"], baseModel: "Qwen/Qwen3-8B", familyKey: "qwen/qwen3-8b", fitHint: { label: "fits", status: "ok", neededMb: 31000, basis: "params" }, engines: ["vllm", "sglang"], library: { state: "present", entryId: ENTRY_A } }),
    hit(PLAN_REPO, { formats: ["gguf"], quants: ["Q4_K_M", "Q8_0"], baseModel: "Qwen/Qwen3-8B", familyKey: "qwen/qwen3-8b", fitHint: { label: "tight", status: "warn", neededMb: 6100, basis: "params" }, engines: ["llamacpp"], library: { state: "update-available", entryId: ENTRY_B } }),
    hit("gated-org/gated-model-70B", { gated: true, familyKey: "gated-org/gated-70b", fitHint: { label: "wont-fit", status: "error", neededMb: 150000, basis: "params" } }),
  ],
  families: [{ familyKey: "qwen/qwen3-8b", repos: ["Qwen/Qwen3-8B-FP8", PLAN_REPO] }],
  facets: { format: [{ value: "gguf", count: 1 }], engine: [{ value: "vllm", count: 1 }, { value: "llamacpp", count: 1 }], fit: [], task: [], updated: [], size: [] },
};
const SEARCH_PAGE_2 = {
  ...SEARCH_PAGE_1, nextCursor: null, warnings: [],
  items: [hit("solo-org/solo-model-3B", { formats: ["gguf"], quants: ["Q4_K_M"], paramsB: 3, fitHint: { label: "fits", status: "ok", neededMb: 2800, basis: "params" }, engines: ["llamacpp"] })],
  families: [],
};

function discoverApi(state = {}) {
  state.searches = state.searches || [];
  state.plans = state.plans || [];
  state.seq = 0;
  const planFor = (body) => {
    state.seq += 1;
    state.plans.push(body);
    const freeAfter = 1_300_000_000_000 - 1_000_000_000 - 6_127_783_488;
    return {
      ok: true, planId: `pln_${state.seq}`, expiresAt: "2026-10-16T09:00:00.000Z",
      artifact: { artifactKey: body.selection.artifactKey, files: [{ path: "model.gguf", size: 6_127_783_488, role: "weight" }], totalBytes: 6_127_783_488, bytesToDownload: 6_127_783_488, revisionSha: SHA },
      target: { rootId: body.target.rootId || "r_main", rootLabel: body.target.rootId === "r_second" ? "Library Y" : "Library X", localDir: "X:\\models\\plan-org-plan-model-8B-GGUF", volume: "X:",
        freeBytes: 1_300_000_000_000, reserveBytes: 65_000_000_000, queuedOnVolumeBytes: 1_000_000_000, freeAfterBytes: freeAfter },
      existing: state.existing || { state: "absent", entryId: null, message: "" },
      source: { chosen: body.source === "auto" ? "huggingface" : body.source, endpoint: "https://huggingface.co", reason: body.source === "auto" ? "policy" : "explicit", probe: null },
      access: state.access || { gated: false, status: "not_required", credentialMode: "cached-login", authorizationUrl: null },
      fit: fit("fits", 7400, { basis: "card" }), compatibility: [],
      eta: { seconds: 47, basisBps: 130_000_000, basis: "recent-average" }, runAfter: body.runAfter,
      blocking: state.blocking || [], warnings: state.warnings || [],
    };
  };
  return {
    "GET /api/hub/search": (request) => {
      const params = new URL(request.url()).searchParams;
      state.searches.push(params);
      return params.get("cursor") === "cur_page_2" ? SEARCH_PAGE_2 : SEARCH_PAGE_1;
    },
    [`GET ${PLAN_PATH}`]: () => ({
      ok: true, provider: "huggingface", repo: PLAN_REPO, revision: "main", revisionSha: SHA, fetchedFrom: "https://huggingface.co",
      summary: { task: "text-generation", license: "apache-2.0", baseModel: "Qwen/Qwen3-8B", paramsB: 8.2, contextLength: 40960, lastModified: "2026-10-01T00:00:00.000Z" },
      access: { gated: false, status: "not_required", authorizationUrl: null }, files: { count: 4, totalBytes: 14_000_000_000, truncated: false },
      artifacts: [
        { artifactKey: "gguf:|Q4_K_M", kind: "gguf-quant", label: "Q4_K_M", format: "gguf", quant: "Q4_K_M", bytes: 4_900_000_000, fileCount: 1, complete: true, fit: fit("fits", 7400),
          companions: { mmproj: [{ path: "mmproj-F16.gguf", size: 1_100_000_000 }], draft: [] }, engines: [{ engineId: "llamacpp", basis: "format" }], recommended: true, library: { state: "absent", entryId: null } },
        { artifactKey: "gguf:|Q8_0", kind: "gguf-quant", label: "Q8_0", format: "gguf", quant: "Q8_0", bytes: 8_100_000_000, fileCount: 1, complete: true, fit: fit("tight", 11000),
          companions: { mmproj: [{ path: "mmproj-F16.gguf", size: 1_100_000_000 }], draft: [] }, engines: [{ engineId: "llamacpp", basis: "format" }], recommended: false, library: { state: "absent", entryId: null } },
      ],
      card: { cardId: REMOTE_CARD, identity: {}, role: "main", evidence: [] }, compatibility: [], siblingRepos: [], warnings: [],
    }),
    "POST /api/hub/plan": (request) => {
      const body = JSON.parse(request.postData());
      if (state.planError) return state.planError;
      return planFor(body);
    },
    "POST /api/hub/sources/probe": { ok: true, reachable: true, sources: [{ source: "huggingface", ok: true, ms: 310, bytesPerSec: 0, error: null }, { source: "hf-mirror", ok: true, ms: 95, bytesPerSec: 0, error: null }], recommended: "hf-mirror", at: "2026-10-16T08:00:00.000Z" },
    "POST /api/hub/downloads": (request) => {
      state.enqueued = JSON.parse(request.postData());
      return state.enqueueError || { status: 201, body: { ok: true, job: dlJob("dl_new0000000000001", "queued", { artifact: { provider: "huggingface", repo: PLAN_REPO, quant: "Q4_K_M", totalBytes: 6_127_783_488 } }) } };
    },
    "POST /api/hub/auth/huggingface/login": { ok: true, launched: true, tokenUrl: "https://huggingface.co/settings/tokens" },
  };
}

function dlJob(id, state, extra = {}) {
  return {
    schemaVersion: 1, id, legacyIds: [], createdAt: "2026-10-15T08:00:00.000Z", updatedAt: "2026-10-15T08:05:00.000Z", startedAt: null, finishedAt: null,
    origin: { kind: "console" }, ownerManagerId: "llama", state, waitReason: null, phaseHistory: [{ phase: "queued", at: "2026-10-15T08:00:00.000Z" }],
    priority: "normal", queueOrder: 1, pausedBy: null, autoResume: true,
    artifact: { provider: "huggingface", repo: "acme/model", revision: "main", artifactKey: "gguf:|Q4_K_M", quant: "Q4_K_M", format: "gguf", files: [], totalBytes: 5_000_000_000 },
    target: { rootId: "r_main", rootLabel: "Library X", outputName: "acme-model", localDir: "X:\\models\\acme-model", volume: "X:" },
    transfer: { engine: "cli", attempt: 1, options: { source: "huggingface", credentialMode: "cached-login" } },
    progress: { bytesDone: 0, bytesTotal: 5_000_000_000, percent: 0, speedBps: 0, etaSeconds: null, files: [] },
    retry: { count: 0, max: 3, nextAt: null, history: [] }, error: null, advice: null, runAfter: null, result: null,
    ...extra,
  };
}

const J = Object.freeze({
  active: "dl_act0000000000001", failed: "dl_fail000000000001", paused: "dl_paus000000000001", retrying: "dl_retr000000000001",
  qa: "dl_qa00000000000001", qb: "dl_qb00000000000001", qc: "dl_qc00000000000001", waiting: "dl_wait000000000001", ready: "dl_ready00000000001", cancelled: "dl_canc000000000001",
});
const ACTIVE_JOB = dlJob(J.active, "downloading", {
  artifact: { provider: "huggingface", repo: "acme/active-model", artifactKey: "gguf:|Q4_K_M", quant: "Q4_K_M", totalBytes: 5_000_000_000 },
  target: { rootId: "r_main", rootLabel: "Library X", outputName: "acme-active-model", localDir: "X:\\models\\acme-active-model", volume: "X:" },
  phaseHistory: [{ phase: "queued", at: "2026-10-15T08:00:00.000Z" }, { phase: "resolving", at: "2026-10-15T08:00:05.000Z" }, { phase: "downloading", at: "2026-10-15T08:00:10.000Z" }],
  progress: { bytesDone: 2_050_000_000, bytesTotal: 5_000_000_000, percent: 41, speedBps: 131_000_000, speedEmaBps: 126_000_000, etaSeconds: 23, files: [
    { path: "active-model-Q4_K_M.gguf", bytes: 1_950_000_000, size: 4_900_000_000, state: "partial" }, { path: "mmproj-F16.gguf", bytes: 100_000_000, size: 100_000_000, state: "complete" }] },
});
const FAILED_JOB = dlJob(J.failed, "failed", {
  artifact: { provider: "huggingface", repo: "gated-org/failed-model", artifactKey: "st:", totalBytes: 9_000_000_000 },
  target: { rootId: "r_main", rootLabel: "Library X", outputName: "gated-org-failed-model", localDir: "X:\\models\\gated-org-failed-model", volume: "X:" },
  phaseHistory: [{ phase: "queued" }, { phase: "resolving" }, { phase: "downloading" }, { phase: "failed" }], finishedAt: "2026-10-15T09:00:00.000Z",
  transfer: { engine: "cli", options: { source: "hf-mirror" } },
  error: { code: "hf_login_required", baseCode: "hf_auth_invalid", class: "auth", retryable: false, at: "2026-10-15T09:00:00.000Z",
    title: { zh: "需要登录 Hugging Face", en: "Hugging Face sign-in required" }, hint: { zh: "点击「登录」，在本机窗口完成登录后重试。", en: "Click Sign in, finish in the local window, then retry." },
    actions: ["sign-in", "open-approval", "switch-source"], detail: "401 Client Error: Unauthorized <redacted>" },
});
const PAUSED_JOB = dlJob(J.paused, "paused", {
  artifact: { provider: "huggingface", repo: "acme/paused-model", artifactKey: "gguf:|Q4_K_M", quant: "Q4_K_M", totalBytes: 4_000_000_000 },
  target: { rootId: "r_main", rootLabel: "Library X", outputName: "acme-paused-model", localDir: "X:\\models\\acme-paused-model", volume: "X:" },
  phaseHistory: [{ phase: "queued" }, { phase: "resolving" }, { phase: "downloading" }], progress: { bytesDone: 1_000_000_000, bytesTotal: 4_000_000_000, percent: 25, files: [] },
});
const RETRYING_JOB = dlJob(J.retrying, "retrying", {
  artifact: { provider: "huggingface", repo: "acme/retrying-model", artifactKey: "gguf:|Q4_K_M", quant: "Q4_K_M", totalBytes: 4_000_000_000 },
  target: { rootId: "r_main", rootLabel: "Library X", outputName: "acme-retrying-model", localDir: "X:\\models\\acme-retrying-model", volume: "X:" },
  phaseHistory: [{ phase: "queued" }, { phase: "downloading" }], transfer: { engine: "cli", options: { source: "huggingface" } },
  retry: { count: 1, max: 3, nextAt: new Date(Date.now() + 600_000).toISOString(), history: [{ at: "2026-10-15T08:00:00.000Z", code: "stall" }] },
});
const queued = (id, repo, order, extra = {}) => dlJob(id, "queued", {
  queueOrder: order, artifact: { provider: "huggingface", repo, artifactKey: "gguf:|Q4_K_M", quant: "Q4_K_M", totalBytes: 3_000_000_000 },
  target: { rootId: "r_main", rootLabel: "Library X", outputName: repo.replace("/", "-"), localDir: `X:\\models\\${repo.replace("/", "-")}`, volume: "X:" }, ...extra,
});
const QUEUE_JOBS = [queued(J.qa, "acme/queue-a", 1), queued(J.qb, "acme/queue-b", 2), queued(J.qc, "acme/queue-c", 3),
  { ...queued(J.waiting, "acme/queue-wait", 4), state: "waiting", waitReason: "runtime-busy" }];
const READY_JOB = dlJob(J.ready, "ready", {
  artifact: { provider: "huggingface", repo: "acme/ready-model", artifactKey: "gguf:|Q4_K_M", quant: "Q4_K_M", totalBytes: 2_000_000_000 },
  target: { rootId: "r_main", rootLabel: "Library X", outputName: "acme-ready-model", localDir: "X:\\models\\acme-ready-model", volume: "X:" },
  finishedAt: "2026-10-15T07:00:00.000Z", result: { entryId: ENTRY_A },
});
const CANCELLED_JOB = dlJob(J.cancelled, "cancelled", {
  artifact: { provider: "huggingface", repo: "acme/cancelled-model", artifactKey: "gguf:|Q4_K_M", quant: "Q4_K_M", totalBytes: 2_000_000_000 },
  target: { rootId: "r_main", rootLabel: "Library X", outputName: "acme-cancelled-model", localDir: "X:\\models\\acme-cancelled-model", volume: "X:" }, finishedAt: "2026-10-14T07:00:00.000Z",
});
const HISTORY_RECORD = dlJob("dl_hist000000000001", "ready", {
  artifact: { provider: "huggingface", repo: "old-org/old-model", quant: "Q8_0", totalBytes: 8_000_000_000 },
  target: { rootId: "r_main", rootLabel: "Library X", outputName: "old-org-old-model", localDir: "X:\\models\\old-org-old-model", volume: "X:" }, finishedAt: "2026-06-01T07:00:00.000Z",
});
const AGGREGATE = { activeCount: 2, queuedCount: 4, speedBps: 131_000_000, etaSeconds: 23 };
const HUB_SETTINGS = {
  sources: { policy: "huggingface", hfEndpoint: "https://huggingface.co", mirrorEndpoint: "https://hf-mirror.com", modelScopeEndpoint: "https://www.modelscope.cn", gatedUsesOfficial: true },
  transfer: { xet: "high-performance", maxConcurrent: 1, stallMinutes: 10, materializeStallMinutes: 20 }, verify: { sha256: true },
  retry: { maxAttempts: 3, baseDelaySeconds: 10, maxDelaySeconds: 600, perClass: { network: true, server: true, watchdog: true, integrity: true, tooling: "once" } },
  queue: { idleOnly: false, idleGraceSeconds: 30, resumeOnStart: true, resumeDelaySeconds: 20 }, storage: { reserveGb: 10, showLegacyRootWhenEmpty: false },
  history: { keepRecords: 200, retentionDays: 365 }, library: { rescanOnStart: true, updateCheck: "manual", identifyOnline: false }, notifications: { onReady: true, onFailure: true },
};

function downloadsApi(state = {}) {
  state.jobs = state.jobs || [ACTIVE_JOB, FAILED_JOB, PAUSED_JOB, RETRYING_JOB, ...QUEUE_JOBS, READY_JOB, CANCELLED_JOB];
  state.puts = state.puts || [];
  const ok = (job) => ({ ok: true, job });
  const find = (id) => state.jobs.find((item) => item.id === id);
  return {
    "GET /api/hub/downloads": () => ({ ok: true, jobs: state.jobs, aggregate: AGGREGATE, nextCursor: null }),
    "GET /api/hub/downloads/history": (request) => {
      const q = (new URL(request.url()).searchParams.get("q") || "").toLowerCase();
      return { ok: true, records: [HISTORY_RECORD].filter((item) => !q || item.artifact.repo.includes(q)), nextCursor: null };
    },
    [`GET /api/hub/downloads/${J.paused}/resume-check`]: { ok: true, jobId: J.paused, localDir: "X:\\models\\acme-paused-model", onDiskBytes: 1_234_567_890, partialBytes: 234_567_890, completeBytes: 1_000_000_000 },
    [`GET /api/hub/downloads/${J.active}/resume-check`]: { ok: true, jobId: J.active, onDiskBytes: 2_100_000_000 },
    [`GET /api/hub/downloads/${J.active}/logs`]: { ok: true, lines: ["Resolving files", "Downloading active-model-Q4_K_M.gguf"], total: 2 },
    ...Object.fromEntries(["pause", "resume", "retry", "start-now", "priority"].flatMap((action) => [J.active, J.failed, J.paused, J.retrying, J.qa, J.qb, J.qc, J.waiting, J.cancelled]
      .map((id) => [`POST /api/hub/downloads/${id}/${action}`, () => ok(find(id))]))),
    ...Object.fromEntries([J.active, J.paused, J.qa].map((id) => [`POST /api/hub/downloads/${id}/cancel`, (request) => {
      const body = JSON.parse(request.postData() || "{}");
      if (state.cancelError) return state.cancelError;
      return { ok: true, job: { ...find(id), state: "cancelled" }, reclaimedBytes: body.deletePartial ? 1_234_000_000 : 0 };
    }])),
    "POST /api/hub/downloads/reorder": (request) => {
      const { ids } = JSON.parse(request.postData());
      state.jobs = state.jobs.map((item) => (ids.includes(item.id) ? { ...item, queueOrder: ids.indexOf(item.id) + 1 } : item));
      return { ok: true, jobs: [] };
    },
    "POST /api/hub/downloads/pause-all": { ok: true, affected: 2 },
    "POST /api/hub/downloads/resume-all": { ok: true, affected: 1 },
    [`DELETE /api/hub/downloads/${J.failed}`]: { ok: true },
    "POST /api/hub/auth/huggingface/login": { ok: true, launched: true, tokenUrl: "https://huggingface.co/settings/tokens" },
    "GET /api/hub/settings": () => ({ ok: true, settings: HUB_SETTINGS }),
    "PUT /api/hub/settings": (request) => {
      state.puts.push(JSON.parse(request.postData()));
      return state.settingsError || { ok: true, settings: HUB_SETTINGS };
    },
    "GET /api/hub/storage/usage": () => fixture("models-usage"),
  };
}

// A /api/events stream that opens when the test says so, then replays `frames` once (the page has rendered by then).
function gatedEvents(frames) {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const body = `retry: 3600000\n: mock\n\n${frames.map((frame, index) => `id: ${index + 1}\nevent: ${frame.type}\ndata: ${JSON.stringify({ at: "2026-10-16T08:00:00.000Z", source: "hub", ...frame })}\n\n`).join("")}`;
  return {
    open: () => open(),
    handler: async (request, route) => {
      await gate;
      await route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body });
      return undefined;
    },
  };
}

test("Discover: a debounced search, family cards with variant chips and library badges, facets, a source switch and cursor load-more", async ({ browser }) => {
  const state = {};
  const { context, page, mock, failures } = await newPage(browser, { api: discoverApi(state) });
  try {
    await page.goto(`${entry.url}models/discover`);
    await expect(byId(page, "discover.results")).toBeVisible();
    await expect(byId(page, "discover.card")).toHaveCount(2);
    const family = byId(page, "discover.card").first();
    await expect(family).toContainText("Qwen/Qwen3-8B");
    await expect(family.locator('[data-testid="discover.variant"]')).toHaveCount(2);
    const fp8 = family.locator('[data-repo="Qwen/Qwen3-8B-FP8"]');
    await expect(fp8.locator('[data-testid="discover.chip"]')).toHaveAttribute("data-fit", "fits");
    await expect(fp8.locator('[data-testid="discover.chip"]')).toContainText("FP8");
    await expect(fp8.locator('[data-testid="discover.chip"]')).toContainText("30.3 GiB");
    await expect(fp8.locator('[data-testid="discover.chip"]')).toContainText("Fits");
    await expect(fp8.locator('[data-testid="discover.badge.library"]')).toHaveText("In library");
    const gguf = family.locator(`[data-repo="${PLAN_REPO}"]`);
    await expect(gguf.locator('[data-testid="discover.chip"]')).toContainText("GGUF Q4_K_M Q8_0");
    await expect(gguf.locator('[data-testid="discover.chip"]')).toHaveAttribute("data-fit", "tight");
    await expect(gguf.locator('[data-testid="discover.badge.update"]')).toHaveText("Update available");
    await expect(byId(page, "discover.card").nth(1).locator('[data-testid="discover.badge.gated"]')).toBeVisible();
    await expect(gguf.locator('[data-testid="discover.repo"]')).toHaveAttribute("href", "/models/hub/huggingface/plan-org/plan-model-8B-GGUF");
    expect(state.searches).toHaveLength(1);
    expect(Object.fromEntries(state.searches[0])).toEqual({ provider: "huggingface", sort: "trending", limit: "24" });

    // Typing is debounced: one request for the whole word.
    await byId(page, "discover.q").pressSequentially("qwen", { delay: 40 });
    await expect.poll(() => state.searches.length).toBe(2);
    await page.waitForTimeout(450);
    expect(state.searches).toHaveLength(2);
    expect(state.searches[1].get("q")).toBe("qwen");

    // Facets are server side and repeat `facet`.
    await byId(page, "discover.fit").check();
    await expect.poll(() => state.searches.length).toBe(3);
    await byId(page, "discover.engine").selectOption("llamacpp");
    await byId(page, "discover.size").selectOption("8-16b");
    await byId(page, "discover.gated").selectOption("false");
    await expect.poll(() => state.searches.length).toBe(6);
    expect(state.searches[5].getAll("facet").sort()).toEqual(["engine:llamacpp", "fit:fits", "gated:false", "size:8-16b"]);
    expect(state.searches[5].get("q")).toBe("qwen");
    await byId(page, "discover.clear").click();
    await expect.poll(() => state.searches.length).toBe(7);
    expect(state.searches[6].getAll("facet")).toEqual([]);

    // The source decides the provider; the mirror still searches Hugging Face.
    await byId(page, "discover.source").selectOption("modelscope");
    await expect.poll(() => state.searches.length).toBe(8);
    expect(state.searches[7].get("provider")).toBe("modelscope");
    await byId(page, "discover.source").selectOption("hf-mirror");
    await expect.poll(() => state.searches.length).toBe(9);
    expect(state.searches[8].get("provider")).toBe("huggingface");
    await byId(page, "discover.source").selectOption("huggingface");
    await expect(byId(page, "discover.card")).toHaveCount(2);

    // Cursor load-more appends and drops the button at the end.
    await expect(byId(page, "discover.more")).toBeVisible();
    const before = state.searches.length;
    await byId(page, "discover.more").click();
    await expect(byId(page, "discover.card")).toHaveCount(3);
    expect(state.searches).toHaveLength(before + 1);
    expect(state.searches[before].get("cursor")).toBe("cur_page_2");
    await expect(byId(page, "discover.more")).toHaveCount(0);
    await expect(byId(page, "discover.count")).toContainText("3 cards from 4 repositories");
    expect(mock.csrfViolations).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Discover: an empty result points to clearing the filters, a search error retries, and a pasted link opens the repository", async ({ browser }) => {
  let mode = "empty";
  const api = {
    ...discoverApi(),
    "GET /api/hub/search": () => (mode === "error" ? { status: 502, body: { ok: false, error: { code: "provider_unreachable", message: "Hugging Face did not answer" } } }
      : { ...SEARCH_PAGE_1, items: [], families: [], nextCursor: null }),
    "POST /api/hub/resolve-link": (request) => {
      const { url } = JSON.parse(request.postData());
      return /huggingface\.co\/plan-org/.test(url) ? { ok: true, provider: "huggingface", repo: PLAN_REPO, revision: "main" } : { ok: true, provider: "huggingface" };
    },
  };
  const { context, page } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}models/discover`);
    await expect(byId(page, "discover.empty")).toContainText("No models match");
    mode = "error";
    await byId(page, "discover.fit").check();
    await expect(byId(page, "discover.error")).toBeVisible();
    mode = "empty";
    await byId(page, "discover.error").getByRole("button", { name: "Retry" }).click();
    await expect(byId(page, "discover.empty")).toBeVisible();
    await byId(page, "discover.empty").getByRole("button", { name: "Clear filters" }).click();
    await expect(byId(page, "discover.fit")).not.toBeChecked();
    await byId(page, "discover.link-input").fill("https://example.com/nothing");
    await byId(page, "discover.link-open").click();
    await expect(byId(page, "discover.link-error")).toContainText("not a Hugging Face or ModelScope model");
    await byId(page, "discover.link-input").fill(`https://huggingface.co/${PLAN_REPO}`);
    await byId(page, "discover.link-open").click();
    await expect(page).toHaveURL(/\/models\/hub\/huggingface\/plan-org\/plan-model-8B-GGUF$/);
  } finally {
    await context.close();
  }
});

test("the wizard's embedded Discover offers Use this model, hands over a remote model ref and never touches the URL", async ({ browser }) => {
  const api = {
    ...discoverApi(),
    "GET /api/m/vllm/models": LEGACY_MODELS, "GET /api/m/llama/models": { local: [], remote: [] },
    "GET /api/m/vllm/instances": { instances: [] }, "GET /api/m/llama/instances": { instances: [] },
    "POST /api/models/inspect": () => wizard("card-remote"),
    [`GET /api/models/${REMOTE_CARD}/compatibility`]: () => ({ ...wizard("compat"), cardId: REMOTE_CARD }),
  };
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}deployments/new?source=search`);
    await byId(page, "wizard.model.search-open").click();
    const drawer = byId(page, "wizard.model.discover");
    await expect(drawer.locator('[data-testid="discover"]')).toHaveAttribute("data-embedded", "true");
    await expect(drawer.locator('[data-testid="discover.card"]')).toHaveCount(2);
    await expect(drawer.locator('[data-testid="discover.download"]')).toHaveCount(0);
    await expect(drawer.locator('[data-testid="page-header.title"]')).toHaveCount(0);
    await drawer.locator('[data-repo="Qwen/Qwen3-8B-FP8"] [data-testid="discover.pick"]').click();
    await expect(drawer).toHaveCount(0);
    await expect.poll(() => callsTo(mock, "POST", "/api/models/inspect").map((call) => call.body)).toEqual([{ source: "huggingface", repo: "Qwen/Qwen3-8B-FP8", revision: "main" }]);
    expect(new URL(page.url()).searchParams.get("source")).toBe("search");
  } finally {
    await context.close();
  }
});

test("plan sheet: opens from Download, plans on every choice, shows the before/after bars, source latency and the ETA, then queues the planId", async ({ browser }) => {
  const state = {};
  const { context, page, mock, failures } = await newPage(browser, { api: { ...discoverApi(state), ...downloadsApi() } });
  try {
    await page.goto(`${entry.url}models/discover`);
    await byId(page, "discover.card").first().locator(`[data-repo="${PLAN_REPO}"] [data-testid="discover.download"]`).click();
    await expect(byId(page, "plan")).toBeVisible();
    await expect(byId(page, "plan.repo")).toHaveText(PLAN_REPO);
    await expect.poll(() => state.plans.length).toBe(1);
    expect(state.plans[0]).toMatchObject({
      provider: "huggingface", repo: PLAN_REPO, revision: "main",
      selection: { artifactKey: "gguf:|Q4_K_M", companions: ["mmproj-F16.gguf"], files: null }, target: { rootId: null, outputName: null },
      source: "auto", credential: { mode: "auto" }, runAfter: null, priority: "normal",
    });
    expect(new URL(page.url()).searchParams.get("drawer")).toBe("plan");
    expect(new URL(page.url()).searchParams.get("repo")).toBe(PLAN_REPO);
    await expect(byId(page, "plan.artifact")).toHaveCount(2);
    await expect(byId(page, "plan.artifact").first()).toHaveAttribute("data-selected", "true");
    await expect(byId(page, "plan.artifact").first()).toContainText("Recommended");
    await expect(byId(page, "plan.size")).toContainText("5.7 GiB");
    await expect(byId(page, "plan.eta")).toContainText("About");
    await expect(byId(page, "plan.fit")).toContainText("Fits");
    await expect(byId(page, "plan.source-chosen")).toContainText("Hugging Face");
    await expect(byId(page, "plan.bar.before")).toBeVisible();
    await expect(byId(page, "plan.bar.after")).toContainText("This download");
    await expect(byId(page, "plan.bar.after")).toContainText("Queued downloads");
    await expect(byId(page, "plan.free-after")).toContainText("Free after");
    await expect(byId(page, "plan.probe")).toContainText("95 ms");
    await expect(byId(page, "plan.probe").locator('[data-source="hf-mirror"]')).toContainText("Fastest");
    await expect(byId(page, "plan.localdir")).toContainText("plan-org-plan-model-8B-GGUF");

    // Each choice plans again, once.
    await byId(page, "plan.artifact").nth(1).click();
    await expect.poll(() => state.plans.length).toBe(2);
    expect(state.plans[1].selection.artifactKey).toBe("gguf:|Q8_0");
    await byId(page, "plan.companion").uncheck();
    await expect.poll(() => state.plans.length).toBe(3);
    expect(state.plans[2].selection.companions).toEqual([]);
    await byId(page, "plan.root").selectOption("r_second");
    await expect.poll(() => state.plans.length).toBe(4);
    expect(state.plans[3].target.rootId).toBe("r_second");
    await byId(page, "plan.source").selectOption("hf-mirror");
    await expect.poll(() => state.plans.length).toBe(5);
    expect(state.plans[4].source).toBe("hf-mirror");
    await expect(byId(page, "plan.source-chosen")).toContainText("HF mirror");
    await byId(page, "plan.folder").fill("my-folder");
    await expect.poll(() => state.plans.length).toBe(6);
    expect(state.plans[5].target.outputName).toBe("my-folder");

    // One call to action: it queues the plan and goes to the Downloads page.
    await byId(page, "plan.submit").click();
    await expect.poll(() => state.enqueued).toEqual({ planId: "pln_6", priority: "normal" });
    await expect(page).toHaveURL(/\/models\/downloads\?job=dl_new0000000000001$/);
    await expect(byId(page, "downloads")).toBeVisible();
    expect(mock.csrfViolations).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("plan sheet from a link: the artifact, the source and Download & deploy are preselected, Escape closes it and clears the URL", async ({ browser }) => {
  const state = {};
  const { context, page } = await newPage(browser, { api: { ...discoverApi(state), ...downloadsApi() } });
  try {
    await page.goto(`${entry.url}models/discover?drawer=plan&provider=huggingface&repo=${encodeURIComponent(PLAN_REPO)}&artifact=${encodeURIComponent("gguf:|Q8_0")}&runAfter=deploy&source=hf-mirror`);
    await expect(byId(page, "plan")).toBeVisible();
    await expect(byId(page, "plan.artifact").nth(1)).toHaveAttribute("data-selected", "true");
    await expect(byId(page, "plan.deploy")).toBeChecked();
    await expect(byId(page, "plan.submit")).toHaveText("Download & deploy");
    await expect.poll(() => state.plans.length).toBe(1);
    expect(state.plans[0]).toMatchObject({ source: "hf-mirror", selection: { artifactKey: "gguf:|Q8_0" } });
    expect(state.plans[0].runAfter).toMatchObject({ engineId: "llamacpp", managerId: null, values: {} });
    await byId(page, "plan.submit").click();
    await expect.poll(() => state.enqueued?.runAfter?.engineId).toBe("llamacpp");
    await expect(page).toHaveURL(/\/models\/downloads\?job=dl_new0000000000001$/);
    await page.goto(`${entry.url}models/discover?drawer=plan&provider=huggingface&repo=${encodeURIComponent(PLAN_REPO)}`);
    await expect(byId(page, "plan")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(byId(page, "plan")).toHaveCount(0);
    await expect(page).toHaveURL(`${entry.url}models/discover`);
    const params = new URL(page.url()).searchParams;
    expect([params.get("drawer"), params.get("repo"), params.get("provider")]).toEqual([null, null, null]);
  } finally {
    await context.close();
  }
});

test("plan sheet blockers: each comes with fix buttons, the call to action is never silently disabled and moves focus to them instead of sending", async ({ browser }) => {
  const state = {
    blocking: [
      { code: "disk_full", message: "The target drive has 1 GB free.", hint: "Choose another model folder or free some space.", actions: ["choose-root", "open-storage"] },
      { code: "hf_login_required", message: "gated", hint: "Sign in", actions: ["sign-in", "open-approval"] },
    ],
  };
  const { context, page, mock } = await newPage(browser, { api: { ...discoverApi(state), ...downloadsApi() } });
  try {
    await page.goto(`${entry.url}models/discover?drawer=plan&provider=huggingface&repo=${encodeURIComponent(PLAN_REPO)}`);
    await expect(byId(page, "plan.blockers")).toBeVisible();
    await expect(byId(page, "plan.blocker")).toHaveCount(2);
    await expect(byId(page, "plan.blocker").first()).toContainText("Not enough free space on the target drive");
    await expect(byId(page, "plan.blocker").first()).toContainText("Choose another library or free some space.");
    await expect(byId(page, "plan.submit")).toBeEnabled();
    await expect(byId(page, "plan.submit")).toHaveAttribute("data-blocked", "true");
    await byId(page, "plan.submit").click();
    await expect(byId(page, "plan.blockers")).toBeFocused();
    expect(callsTo(mock, "POST", "/api/hub/downloads")).toHaveLength(0);

    await byId(page, "plan.fix.choose-root").click();
    await expect(byId(page, "plan.root")).toBeFocused();
    await expect(byId(page, "plan.fix.open-storage")).toHaveAttribute("href", "/models/storage");
    await expect(byId(page, "plan.fix.open-approval")).toHaveAttribute("href", "https://huggingface.co/plan-org/plan-model-8B-GGUF");
    await byId(page, "plan.fix.sign-in").click();
    await expect.poll(() => callsTo(mock, "POST", "/api/hub/auth/huggingface/login").length).toBe(1);
    await expect(page.locator('[data-testid="toast.root"]').filter({ hasText: "login window is open" })).toBeVisible();

    // Fixed: plan again (Check again) and the same button queues the download.
    state.blocking = [];
    await byId(page, "plan.recheck").click();
    await expect(byId(page, "plan.blockers")).toBeHidden();
    await byId(page, "plan.submit").click();
    await expect.poll(() => state.enqueued).toMatchObject({ planId: "pln_2" });
  } finally {
    await context.close();
  }
});

test("plan sheet: a copy that is already in the library blocks until Download another copy; a 409 on queueing shows its fixes; an expired plan is planned again", async ({ browser }) => {
  const state = { existing: { state: "present", entryId: ENTRY_A, message: "These exact files are already in this folder." } };
  const { context, page } = await newPage(browser, { api: { ...discoverApi(state), ...downloadsApi() } });
  try {
    await page.goto(`${entry.url}models/discover?drawer=plan&provider=huggingface&repo=${encodeURIComponent(PLAN_REPO)}`);
    const blocker = byId(page, "plan.blocker");
    await expect(blocker).toHaveCount(1);
    await expect(blocker).toContainText("The same files are already in the library");
    await expect(byId(page, "plan.fix.open-library")).toHaveAttribute("href", `/models/library/${ENTRY_A}`);
    await byId(page, "plan.fix.allow-duplicate").click();
    await expect(byId(page, "plan.blocker")).toHaveCount(0);
    await expect(byId(page, "plan.duplicate-on")).toBeVisible();

    state.enqueueError = { status: 409, body: { ok: false, error: { code: "already_downloading", message: "This folder is already being downloaded." }, details: { existingJobId: J.active } } };
    await byId(page, "plan.submit").click();
    await expect(blocker).toContainText("This folder is already being downloaded");
    expect(state.enqueued).toMatchObject({ allowDuplicate: true });
    await expect(byId(page, "plan.fix.open-downloads")).toHaveAttribute("href", `/models/downloads?job=${J.active}`);

    await byId(page, "plan.recheck").click();
    await expect(byId(page, "plan.blocker")).toHaveCount(0);
    // plan_changed: the hub says the repository changed since the plan, so the sheet plans again by itself.
    const plansBefore = state.plans.length;
    state.enqueueError = { status: 409, body: { ok: false, error: { code: "plan_changed", message: "changed" } } };
    await byId(page, "plan.submit").click();
    await expect.poll(() => state.plans.length).toBeGreaterThan(plansBefore);
    await expect(page.locator('[data-testid="toast.root"]').filter({ hasText: "plan changed" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("plan sheet: a gated repository shows its access state with sign-in, the approval page and a one-time token that stays out of the dedupe key", async ({ browser }) => {
  const state = { access: { gated: true, status: "approval_required", credentialMode: "cached-login", authorizationUrl: "https://huggingface.co/plan-org/plan-model-8B-GGUF" } };
  const { context, page } = await newPage(browser, { api: { ...discoverApi(state), ...downloadsApi() } });
  try {
    await page.goto(`${entry.url}models/discover?drawer=plan&provider=huggingface&repo=${encodeURIComponent(PLAN_REPO)}`);
    await expect(byId(page, "plan.access")).toHaveText("Approval required");
    await expect(byId(page, "plan.approval")).toHaveAttribute("href", "https://huggingface.co/plan-org/plan-model-8B-GGUF");
    await expect(byId(page, "plan.approval")).toHaveAttribute("target", "_blank");
    await byId(page, "plan.token-toggle").click();
    await byId(page, "plan.token.remember").check();
    // Typing does not plan (each plan with a token puts it in the hub vault); leaving the field does.
    await byId(page, "plan.token.input").pressSequentially("hf_fake_token_for_tests", { delay: 20 });
    await page.waitForTimeout(500);
    expect(state.plans).toHaveLength(1);
    await byId(page, "plan.token.input").blur();
    await expect.poll(() => state.plans.length).toBe(2);
    expect(state.plans[1].credential).toEqual({ mode: "temp-token", hfToken: "hf_fake_token_for_tests", remember: true });
    await expect(page.locator("body")).not.toContainText("hf_fake_token_for_tests");
    expect(await page.evaluate(() => JSON.stringify([...Object.entries(localStorage), ...Object.entries(sessionStorage)]))).not.toContain("hf_fake_token_for_tests");
  } finally {
    await context.close();
  }
});

// ---- Downloads

test("Downloads Active: progress, the phase Stepper, per-file rows, the wait lines and the tab counts", async ({ browser }) => {
  const state = {};
  const { context, page, failures } = await newPage(browser, { api: downloadsApi(state) });
  try {
    await page.goto(`${entry.url}models/downloads`);
    await expect(byId(page, "downloads.active")).toBeVisible();
    await expect(byId(page, "tabs.tab")).toHaveText(["Active4", "Queued4", "History"]);
    await expect(byId(page, "downloads.counts")).toHaveText("2 active, 4 queued");
    await expect(byId(page, "downloads.speed")).toContainText("124.9 MiB/s");
    const active = page.locator(`[data-job="${J.active}"]`);
    await expect(active.locator('[data-testid="progress-row.bar"]')).toHaveAttribute("aria-valuenow", "41");
    await expect(active).toContainText("acme/active-model · Q4_K_M");
    await expect(active.locator('[data-testid="stepper.step"][data-state="active"]')).toContainText("Downloading");
    await expect(active.locator('[data-testid="stepper.step"][data-state="done"]')).toHaveCount(2);
    await expect(active.locator('[data-testid="stepper.step"]')).toHaveCount(6);
    await active.getByText("2 files").click();
    await expect(active.locator('[data-testid="download.files"] li')).toHaveCount(2);
    await expect(active.locator('[data-testid="download.files"]')).toContainText("mmproj-F16.gguf");
    await expect(page.locator(`[data-job="${J.paused}"]`).locator('[data-testid="download.resume"]')).toBeVisible();
    await expect(page.locator(`[data-job="${J.retrying}"]`)).toContainText("Retrying in");
    await expect(page.locator(`[data-job="${J.retrying}"]`)).toContainText("attempt 1/3");
    await byId(page, "tabs.tab").filter({ hasText: "Queued" }).click();
    await expect(byId(page, "download.queued")).toHaveCount(4);
    await expect(page.locator(`[data-job="${J.waiting}"] [data-testid="download.line"]`)).toHaveText("Models are busy; starts when idle");
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Downloads: a downloads event updates the progress without a refetch, and a truncated replay refetches the list", async ({ browser }) => {
  const moved = { ...ACTIVE_JOB, progress: { ...ACTIVE_JOB.progress, bytesDone: 4_000_000_000, percent: 80, speedBps: 150_000_000, speedEmaBps: 150_000_000, etaSeconds: 7 } };
  const live = gatedEvents([{ type: "downloads", data: { kind: "job", jobs: [moved], aggregate: { ...AGGREGATE, speedBps: 150_000_000, etaSeconds: 7 } } }]);
  const first = await newPage(browser, { api: { ...downloadsApi(), "GET /api/events": live.handler } });
  try {
    await first.page.goto(`${entry.url}models/downloads`);
    const bar = first.page.locator(`[data-job="${J.active}"] [data-testid="progress-row.bar"]`);
    await expect(bar).toHaveAttribute("aria-valuenow", "41");
    expect(callsTo(first.mock, "GET", "/api/hub/downloads").filter((call) => call.path === "/api/hub/downloads")).toHaveLength(1);
    live.open();
    await expect(bar).toHaveAttribute("aria-valuenow", "80");
    await expect(byId(first.page, "downloads.speed")).toContainText("143.1 MiB/s");
    expect(callsTo(first.mock, "GET", "/api/hub/downloads").filter((call) => call.path === "/api/hub/downloads")).toHaveLength(1);
  } finally {
    await first.context.close();
  }

  const replay = gatedEvents([{ type: "downloads", data: { kind: "job", truncated: true, jobs: [], aggregate: AGGREGATE } }]);
  const second = await newPage(browser, { api: { ...downloadsApi(), "GET /api/events": replay.handler } });
  try {
    await second.page.goto(`${entry.url}models/downloads`);
    await expect(byId(second.page, "downloads.active")).toBeVisible();
    const lists = () => callsTo(second.mock, "GET", "/api/hub/downloads").filter((call) => call.path === "/api/hub/downloads").length;
    expect(lists()).toBe(1);
    replay.open();
    await expect.poll(lists).toBe(2);
  } finally {
    await second.context.close();
  }
});

test("Downloads Queued: the up and down buttons send downloads/reorder with the full order, keep focus and announce the move; a drag does the same", async ({ browser }) => {
  const state = {};
  const { context, page, mock } = await newPage(browser, { api: downloadsApi(state) });
  try {
    await page.goto(`${entry.url}models/downloads?tab=queued`);
    const rows = byId(page, "download.queued");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("acme/queue-a");
    await expect(rows.nth(0).locator('[data-testid="download.up"]')).toBeDisabled();
    await expect(rows.nth(3).locator('[data-testid="download.down"]')).toBeDisabled();

    const downOfA = rows.nth(0).locator('[data-testid="download.down"]');
    await expect(downOfA).toHaveAccessibleName("Move acme/queue-a · Q4_K_M down");
    await downOfA.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => callsTo(mock, "POST", "/api/hub/downloads/reorder").length).toBe(1);
    expect(callsTo(mock, "POST", "/api/hub/downloads/reorder")[0].body).toEqual({ ids: [J.qb, J.qa, J.qc, J.waiting] });
    await expect(rows.nth(1)).toContainText("acme/queue-a");
    await expect(byId(page, "downloads.moved")).toContainText("moved to position 2 of 4");
    await expect(rows.nth(1).locator('[data-testid="download.down"]')).toBeFocused();

    // Up on the last-but-one row, from the keyboard again.
    await rows.nth(2).locator('[data-testid="download.up"]').focus();
    await page.keyboard.press("Space");
    await expect.poll(() => callsTo(mock, "POST", "/api/hub/downloads/reorder").length).toBe(2);
    expect(callsTo(mock, "POST", "/api/hub/downloads/reorder")[1].body).toEqual({ ids: [J.qb, J.qc, J.qa, J.waiting] });

    // Dragging the first row onto the last one.
    await rows.nth(0).dragTo(rows.nth(3));
    await expect.poll(() => callsTo(mock, "POST", "/api/hub/downloads/reorder").length).toBe(3);
    expect(callsTo(mock, "POST", "/api/hub/downloads/reorder")[2].body).toEqual({ ids: [J.qc, J.qa, J.waiting, J.qb] });

    // Priority and Start now.
    await rows.nth(0).locator('[data-testid="download.priority"]').selectOption("high");
    await expect.poll(() => callsTo(mock, "POST", `/api/hub/downloads/${J.qc}/priority`).length).toBe(1);
    expect(callsTo(mock, "POST", `/api/hub/downloads/${J.qc}/priority`)[0].body).toEqual({ priority: "high" });
    await rows.nth(0).locator('[data-testid="download.start-now"]').click();
    await expect.poll(() => callsTo(mock, "POST", `/api/hub/downloads/${J.qc}/start-now`).length).toBe(1);
    await byId(page, "downloads.pause-all").click();
    await expect.poll(() => callsTo(mock, "POST", "/api/hub/downloads/pause-all").length).toBe(1);
    await expect(page.locator('[data-testid="toast.root"]').filter({ hasText: "Paused 2 downloads" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Downloads failure card: the hub's classified cause, its fixes (sign in, approval page, switch source, retry) and a dismiss", async ({ browser }) => {
  const state = {};
  const { context, page, mock } = await newPage(browser, { api: downloadsApi(state) });
  try {
    await page.goto(`${entry.url}models/downloads`);
    const card = page.locator(`[data-job="${J.failed}"] [data-testid="download.failure"]`);
    await expect(card).toHaveAttribute("data-code", "hf_login_required");
    await expect(card.locator('[data-testid="download.failure.title"]')).toHaveText("Hugging Face sign-in required");
    await expect(card.locator('[data-testid="download.failure.hint"]')).toContainText("Click Sign in");
    await expect(card.locator('[data-testid="download.failure.detail"]')).toContainText("<redacted>");
    await expect(card.locator('[data-testid="download.failure.retry"]')).toHaveText("Not retried automatically");
    await expect(page.locator(`[data-job="${J.failed}"] [data-testid="stepper.step"][data-state="error"]`)).toContainText("Downloading");

    await card.locator('[data-testid="download.fix.sign-in"]').click();
    await expect.poll(() => callsTo(mock, "POST", "/api/hub/auth/huggingface/login").length).toBe(1);
    await expect(card.locator('[data-testid="download.fix.open-approval"]')).toHaveAttribute("href", "https://huggingface.co/gated-org/failed-model");
    // A finished job cannot be resumed, so switching source opens a new plan on the other source.
    await expect(card.locator('[data-testid="download.fix.switch-source"]')).toHaveAttribute("href", /\/models\/discover\?drawer=plan&.*repo=gated-org%2Ffailed-model.*source=huggingface/);
    await card.locator('[data-testid="download.fix.retry"]').click();
    await expect.poll(() => callsTo(mock, "POST", `/api/hub/downloads/${J.failed}/retry`).length).toBe(1);
    await page.locator(`[data-job="${J.failed}"] [data-testid="download.dismiss"]`).click();
    await expect.poll(() => callsTo(mock, "DELETE", `/api/hub/downloads/${J.failed}`).length).toBe(1);
  } finally {
    await context.close();
  }
});

test("Downloads: a failure without a title falls back to the catalog line, shows the retry state and opens the log", async ({ browser }) => {
  const bare = dlJob(J.failed, "failed", { error: { code: "unknown", retryable: true, actions: ["view-log"], detail: "boom <redacted>" }, retry: { count: 2, max: 3 } });
  const { context, page } = await newPage(browser, { api: downloadsApi({ jobs: [bare] }) });
  try {
    await page.goto(`${entry.url}models/downloads`);
    await expect(byId(page, "download.failure.title")).toHaveText("Download failed; see the log");
    await expect(byId(page, "download.failure.retry")).toHaveText("Retrying automatically (2 of 3)");
    await byId(page, "download.fix.view-log").click();
    await expect(byId(page, "download.log")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Cancel (keep files) sends an empty body; Cancel and delete asks first, shows the reclaimable bytes, wants the folder name and sends {deletePartial, confirm}", async ({ browser }) => {
  const state = {};
  const { context, page, mock } = await newPage(browser, { api: downloadsApi(state) });
  try {
    await page.goto(`${entry.url}models/downloads`);
    const paused = page.locator(`[data-job="${J.paused}"]`);
    await paused.locator('[data-testid="download.cancel-keep"]').click();
    await expect.poll(() => callsTo(mock, "POST", `/api/hub/downloads/${J.paused}/cancel`).length).toBe(1);
    expect(callsTo(mock, "POST", `/api/hub/downloads/${J.paused}/cancel`)[0].body).toEqual({});
    await expect(page.locator('[data-testid="toast.root"]').filter({ hasText: "the files are kept" })).toBeVisible();

    await paused.locator('[data-testid="download.cancel-delete"]').click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Delete the partial download acme-paused-model?");
    await expect(dialog).toContainText("freeing about 1.1 GiB");
    await expect(dialog).toContainText("Running models are not touched");
    const confirm = dialog.getByRole("button", { name: "Cancel and delete partial files" });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("textbox").fill("acme-paused-model");
    state.cancelError = { status: 409, body: { ok: false, error: { code: "path_busy", message: "The folder is in use; nothing was deleted." } } };
    await confirm.click();
    await expect(dialog).toContainText("The folder is in use");
    expect(callsTo(mock, "POST", `/api/hub/downloads/${J.paused}/cancel`)[1].body).toEqual({ deletePartial: true, confirm: "acme-paused-model" });
    state.cancelError = null;
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    expect(callsTo(mock, "POST", `/api/hub/downloads/${J.paused}/cancel`)).toHaveLength(3);
    await expect(page.locator('[data-testid="toast.root"]').filter({ hasText: "1.1 GiB freed" })).toBeVisible();
    expect(callsTo(mock, "GET", `/api/hub/downloads/${J.paused}/resume-check`)).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("Downloads: pausing, resuming, the View log tail, History search with the compacted records, and the settings Drawer", async ({ browser }) => {
  const state = {};
  const { context, page, mock } = await newPage(browser, { api: downloadsApi(state) });
  try {
    await page.goto(`${entry.url}models/downloads`);
    await page.locator(`[data-job="${J.active}"] [data-testid="download.pause"]`).click();
    await expect.poll(() => callsTo(mock, "POST", `/api/hub/downloads/${J.active}/pause`).length).toBe(1);
    await page.locator(`[data-job="${J.paused}"] [data-testid="download.resume"]`).click();
    await expect.poll(() => callsTo(mock, "POST", `/api/hub/downloads/${J.paused}/resume`).length).toBe(1);
    await page.locator(`[data-job="${J.active}"] [data-testid="download.log-toggle"]`).click();
    await expect(byId(page, "download.log")).toContainText("Resolving files");
    await byId(page, "downloads.resume-all").click();
    await expect.poll(() => callsTo(mock, "POST", "/api/hub/downloads/resume-all").length).toBe(1);

    await byId(page, "tabs.tab").filter({ hasText: "History" }).click();
    await expect(byId(page, "download.history")).toHaveCount(3);
    const ready = page.locator(`[data-job="${J.ready}"]`);
    await expect(ready).toContainText("Ready");
    await expect(ready.locator('[data-testid="download.library-link"]')).toHaveAttribute("href", `/models/library/${ENTRY_A}`);
    await expect(page.locator('[data-job="dl_hist000000000001"]')).toContainText("old-org/old-model");
    await expect(page.locator(`[data-job="${J.cancelled}"] [data-testid="download.retry"]`)).toBeVisible();
    await byId(page, "downloads.history-q").fill("old-org");
    await expect(byId(page, "download.history")).toHaveCount(1);
    await byId(page, "downloads.history-q").fill("nothing-like-this");
    await expect(byId(page, "downloads.history-empty")).toBeVisible();

    // The settings Drawer saves only what changed, and shows the hub's field errors.
    await byId(page, "downloads.settings").click();
    await expect(byId(page, "settings")).toBeVisible();
    await expect(byId(page, "settings.save")).toBeDisabled();
    await page.locator('[data-testid="settings.retry.perClass.network"]').selectOption("off");
    await page.locator('[data-testid="settings.transfer.maxConcurrent"]').fill("9");
    await page.locator('[data-testid="settings.queue.idleOnly"]').check();
    state.settingsError = { status: 400, body: { ok: false, error: { code: "settings_invalid", message: "Some hub settings are not valid; nothing was saved." }, errors: [{ field: "transfer.maxConcurrent", code: "out_of_range", message: "Must be between 1 and 4" }] } };
    await byId(page, "settings.save").click();
    await expect(byId(page, "settings.failure")).toContainText("Some settings are not valid");
    await expect(byId(page, "settings.field.transfer.maxConcurrent")).toContainText("Must be between 1 and 4");
    expect(state.puts[0]).toEqual({ settings: { retry: { perClass: { network: false } }, transfer: { maxConcurrent: 9 }, queue: { idleOnly: true } } });
    state.settingsError = null;
    await page.locator('[data-testid="settings.transfer.maxConcurrent"]').fill("2");
    await byId(page, "settings.save").click();
    await expect(byId(page, "settings")).toHaveCount(0);
    expect(state.puts[1]).toEqual({ settings: { retry: { perClass: { network: false } }, transfer: { maxConcurrent: 2 }, queue: { idleOnly: true } } });
  } finally {
    await context.close();
  }
});

test("a job waiting for a token takes it in place; the token goes only to the resume call", async ({ browser }) => {
  const waiting = { ...queued(J.waiting, "acme/token-model", 1), state: "waiting", waitReason: "auth" };
  const api = { ...downloadsApi({ jobs: [waiting] }), [`POST /api/hub/downloads/${J.waiting}/resume`]: { ok: true, job: waiting } };
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}models/downloads?tab=queued`);
    await expect(byId(page, "download.line")).toContainText("Re-enter the Hugging Face token");
    await byId(page, "download.enter-token").click();
    await byId(page, "download.token.input").fill("hf_fake_token_for_tests");
    await byId(page, "download.token.resume").click();
    await expect.poll(() => callsTo(mock, "POST", `/api/hub/downloads/${J.waiting}/resume`).length).toBe(1);
    expect(callsTo(mock, "POST", `/api/hub/downloads/${J.waiting}/resume`)[0].body).toEqual({ credential: { hfToken: "hf_fake_token_for_tests", remember: false } });
  } finally {
    await context.close();
  }
});

test("Downloads degrade: without the hub the page lists the managers' own download jobs, read-only, and says so; an empty queue points to Discover", async ({ browser }) => {
  const degraded = await newPage(browser, { api: {
    "GET /api/hub/downloads": NOT_FOUND,
    "GET /api/m/vllm/jobs": { jobs: [{ id: "j1", type: "download", status: "running", label: "legacy/pull-model" }, { id: "j2", type: "benchmark", status: "running" }] },
    "GET /api/m/llama/jobs": { jobs: [] },
  } });
  try {
    await degraded.page.goto(`${entry.url}models/downloads`);
    await expect(byId(degraded.page, "downloads")).toHaveAttribute("data-source", "managers");
    await expect(byId(degraded.page, "downloads.degraded")).toContainText("needs the model hub backend");
    await expect(byId(degraded.page, "download.manager-job")).toHaveCount(1);
    await expect(byId(degraded.page, "download.manager-job")).toContainText("legacy/pull-model");
    await expect(byId(degraded.page, "downloads.pause-all")).toHaveCount(0);
  } finally {
    await degraded.context.close();
  }
  const empty = await newPage(browser, { api: downloadsApi({ jobs: [] }) });
  try {
    await empty.page.goto(`${entry.url}models/downloads`);
    await expect(byId(empty.page, "downloads.active-empty")).toContainText("No active downloads");
    await expect(byId(empty.page, "downloads.active-empty").getByRole("link", { name: "Discover" })).toHaveAttribute("href", "/models/discover");
  } finally {
    await empty.context.close();
  }
});

// ---------------------------------------------------------------------------
// Copy, size, accessibility

const PAGES = [
  ["library", "models", "library.table"],
  ["storage", "models/storage", "storage.planner"],
  ["detail", `models/library/${ENTRY_A}`, "model-detail"],
  ["repository", "models/hub/huggingface/example-org/example-model-7B", "model-detail"],
  ["discover", "models/discover", "discover.results"],
  ["plan", `models/discover?drawer=plan&provider=huggingface&repo=${encodeURIComponent(PLAN_REPO)}`, "plan.bars"],
  ["downloads", "models/downloads", "downloads.active"],
  ["queue", "models/downloads?tab=queued", "downloads.queue"],
];

for (const locale of ["en-US", "zh-CN"]) {
  test(`every key of the Models pages renders in ${locale}, nothing overflows at 390 px, axe is clean in both themes`, async ({ browser }) => {
    const backend = storageBackend();
    backend.state.migrations = [{ id: "mig_1", state: "completed", source: "X:/models/Qwen3-8B-FP8", target: "Y:/models/Qwen3-8B-FP8", fileCount: 2, completedFiles: 2, totalBytes: 4_500_001_200, bytesDone: 4_500_001_200, sourceRemoved: false }];
    const api = detailApi({ ...backend.routes, ...discoverApi(), ...downloadsApi() });
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
