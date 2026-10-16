// CON-7a browser checks (07 §4.4): DataTable sort, column chooser persistence,
// CSV export and windowing, the LogViewer pause on scroll-up, and the
// MarkdownViewer's inert output, all on the hidden /system/ui-kit page.
// axe runs over the same page in console-a11y.spec.js.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const { collectFailures, mockConsoleApi, openUiKit, setPrefs, startEntry } = require("../helpers/console-harness.js");

let entry;

test.beforeAll(async () => {
  entry = await startEntry();
});

test.afterAll(async () => {
  await entry?.stop();
});

async function openKit(browser, { size = { width: 1440, height: 960 } } = {}) {
  const context = await browser.newContext({ viewport: size, locale: "en-US", reducedMotion: "reduce", acceptDownloads: true });
  await setPrefs(context, { theme: "light", locale: "en-US", density: "comfortable" }, { baseUrl: entry.url });
  const page = await context.newPage();
  const api = await mockConsoleApi(page);
  const failures = await collectFailures(page);
  await openUiKit(page, entry.url, { locale: "en-US" });
  return { context, page, api, failures };
}

const byTestId = (page, id) => page.locator(`[data-testid="${id}"]`);
const names = (page, root) => page.locator(`[data-testid="${root}"] tbody tr[data-row] td:first-child`).allTextContents();

test("DataTable sorts by a header button and reports aria-sort", async ({ browser }) => {
  const { page, context, failures } = await openKit(browser);
  try {
    const root = "uikit.table";
    const header = page.locator(`[data-testid="${root}"] th[data-column="name"]`);
    await expect(header).toHaveAttribute("aria-sort", "none");
    expect(await names(page, root)).toEqual(["qwen-32b", "llama-8b", "gemma-27b", "phi-4"]);
    await header.getByRole("button").click();
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(await names(page, root)).toEqual(["gemma-27b", "llama-8b", "phi-4", "qwen-32b"]);
    await header.getByRole("button").click();
    await expect(header).toHaveAttribute("aria-sort", "descending");
    expect(await names(page, root)).toEqual(["qwen-32b", "phi-4", "llama-8b", "gemma-27b"]);
    await header.getByRole("button").click();
    await expect(header).toHaveAttribute("aria-sort", "none");
    // Empty values stay last in both directions.
    const gpu = page.locator(`[data-testid="${root}"] th[data-column="gpu"]`);
    await gpu.getByRole("button").click();
    await gpu.getByRole("button").click();
    expect((await names(page, root)).slice(-1)).toEqual(["gemma-27b"]);
    await expect(page.locator(`[data-testid="${root}"] table caption`)).toHaveText("Sample models");
    await failures.expectNone();
  } finally {
    await context.close();
  }
});

test("the column chooser is remembered per table across reloads", async ({ browser }) => {
  const { page, context } = await openKit(browser);
  try {
    const root = byTestId(page, "uikit.table");
    await expect(root.locator('th[data-column="note"]')).toHaveCount(0);
    await root.locator('[data-testid="data-table.chooser-toggle"]').click();
    await root.locator('[data-testid="data-table.column.note"]').check();
    await expect(root.locator('th[data-column="note"]')).toHaveCount(1);
    await root.locator('[data-testid="data-table.column.gpu"]').uncheck();
    await expect(root.locator('th[data-column="gpu"]')).toHaveCount(0);

    await openUiKit(page, entry.url, { locale: "en-US" });
    const again = byTestId(page, "uikit.table");
    await expect(again.locator('th[data-column="note"]')).toHaveCount(1);
    await expect(again.locator('th[data-column="gpu"]')).toHaveCount(0);
    await expect(byTestId(page, "uikit.table-big").locator('th[data-column="score"]')).toHaveCount(1);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("console.prefs.v1") || "{}"));
    expect(stored.tableColumns["uikit-table"]).toEqual(["name", "tokens", "note"]);
  } finally {
    await context.close();
  }
});

test("CSV export has a BOM, escapes formulas and quotes fields", async ({ browser }) => {
  const { page, context } = await openKit(browser);
  try {
    const root = byTestId(page, "uikit.table");
    await root.locator('[data-testid="data-table.chooser-toggle"]').click();
    await root.locator('[data-testid="data-table.column.note"]').check();
    const [download] = await Promise.all([page.waitForEvent("download"), root.locator('[data-testid="data-table.csv"]').click()]);
    expect(download.suggestedFilename()).toMatch(/^uikit-table-\d{12}\.csv$/);
    const bytes = fs.readFileSync(await download.path());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8").slice(1);
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("Name,GPU %,Tokens/s,Note");
    expect(lines[1]).toBe("qwen-32b,61.5,38.6,'=SUM(A1:A9)");
    expect(lines[3]).toBe("gemma-27b,,22.1,'+cmd");
    expect(lines[4]).toBe('phi-4,33.3,,"say ""hi"", ok"');
  } finally {
    await context.close();
  }
});

test("a table above 500 rows keeps at most 120 rows in the DOM while scrolling", async ({ browser }) => {
  const { page, context, failures } = await openKit(browser);
  try {
    const root = "uikit.table-big";
    const rows = page.locator(`[data-testid="${root}"] tbody tr[data-row]`);
    await expect(byTestId(page, root)).toHaveAttribute("data-mode", "windowed");
    await expect(byTestId(page, root).locator('[data-testid="data-table.count"]')).toHaveText("2,000 rows");
    expect(await rows.count()).toBeLessThanOrEqual(120);
    expect(await rows.count()).toBeGreaterThan(10);
    await expect(rows.first()).toContainText("model-0000");

    const scroller = byTestId(page, root).locator('[data-testid="data-table.scroll"]');
    for (const fraction of [0.25, 0.5, 1]) {
      await scroller.evaluate((element, at) => {
        element.scrollTop = (element.scrollHeight - element.clientHeight) * at;
      }, fraction);
      await expect.poll(() => rows.count()).toBeLessThanOrEqual(120);
    }
    await expect(rows.last()).toContainText("model-1999");

    // Sorting runs over every loaded row, not only the visible window.
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    const score = page.locator(`[data-testid="${root}"] th[data-column="score"]`);
    await score.getByRole("button").click();
    await score.getByRole("button").click();
    await expect.poll(async () => (await rows.first().locator("td").last().textContent()).trim()).toBe("999");
    expect(await rows.count()).toBeLessThanOrEqual(120);
    await failures.expectNone();
  } finally {
    await context.close();
  }
});

test("the LogViewer pauses following on scroll-up and resumes with Jump to latest", async ({ browser }) => {
  const { page, context, failures } = await openKit(browser);
  try {
    const viewer = byTestId(page, "uikit.log");
    const box = viewer.locator('[data-testid="log-viewer.log"]');
    await expect(box).toHaveAttribute("role", "log");
    await expect(box).toHaveAttribute("aria-live", "off");
    await expect(viewer.locator('[data-testid="log-viewer.line"]')).toHaveCount(60);
    await expect(viewer).toHaveAttribute("data-following", "true");
    await expect(viewer.locator('[data-testid="log-viewer.follow"]')).toHaveAttribute("aria-pressed", "true");
    const atBottom = () => box.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop <= 8);
    expect(await atBottom()).toBe(true);

    // New lines arrive while following and keep the view at the end.
    await expect.poll(() => viewer.locator('[data-testid="log-viewer.line"]').count()).toBeGreaterThan(60);
    expect(await atBottom()).toBe(true);

    await box.hover();
    // The wheel handler pauses following before native scrolling finishes.
    await box.evaluate((element) => {
      const before = element.scrollTop;
      element.dataset.wheelScrollEnded = "false";
      const onEnd = () => {
        if (element.scrollTop >= before) return;
        element.dataset.wheelScrollEnded = "true";
        element.removeEventListener("scrollend", onEnd);
      };
      element.addEventListener("scrollend", onEnd);
    });
    await page.mouse.wheel(0, -600);
    await expect(viewer).toHaveAttribute("data-following", "false");
    await expect(viewer.locator('[data-testid="log-viewer.follow"]')).toHaveAttribute("aria-pressed", "false");
    await expect(viewer.locator('[data-testid="log-viewer.jump"]')).toBeVisible();
    await expect(box).toHaveAttribute("data-wheel-scroll-ended", "true");
    await box.evaluate((element) => { delete element.dataset.wheelScrollEnded; });
    const top = await box.evaluate((element) => element.scrollTop);
    const count = await viewer.locator('[data-testid="log-viewer.line"]').count();
    await expect.poll(() => viewer.locator('[data-testid="log-viewer.line"]').count()).toBeGreaterThan(count);
    expect(await box.evaluate((element) => element.scrollTop), "a paused view does not move").toBe(top);

    await viewer.locator('[data-testid="log-viewer.jump"]').click();
    await expect(viewer).toHaveAttribute("data-following", "true");
    await expect.poll(atBottom).toBe(true);

    // Level filter and search highlight.
    await viewer.locator('[data-testid="log-viewer.level"]').selectOption("error");
    const lines = viewer.locator('[data-testid="log-viewer.line"]');
    expect(await lines.count()).toBeGreaterThan(0);
    for (const text of await lines.allTextContents()) expect(text).toContain("ERROR");
    await viewer.locator('[data-testid="log-viewer.level"]').selectOption("all");
    await viewer.locator('[data-testid="log-viewer.search"]').fill("step 7 ");
    await expect(viewer.locator("mark").first()).toHaveText("step 7 ");
    await failures.expectNone();
  } finally {
    await context.close();
  }
});

test("the MarkdownViewer renders hostile text inertly", async ({ browser }) => {
  const { page, context, failures } = await openKit(browser);
  try {
    const view = byTestId(page, "uikit.markdown-view");
    await expect(view.locator("h2")).toHaveText("Release notes");
    await expect(view.locator("script")).toHaveCount(0);
    await expect(view).toContainText("<script>alert(1)</script>");
    await expect(view.locator('a[href^="javascript" i]')).toHaveCount(0);
    await expect(view).toContainText("bad link");
    const safe = view.getByRole("link", { name: "safe link" });
    await expect(safe).toHaveAttribute("rel", "noopener noreferrer");
    await expect(safe).toHaveAttribute("target", "_blank");
    await expect(view.locator("img")).toHaveCount(0);
    await expect(view.locator('[data-testid="markdown.image-blocked"]')).toHaveText("remote");
    await expect(view.locator("table th")).toHaveText(["name", "value"]);
    await expect(view.locator('[data-testid="markdown.code"] code')).toHaveText("platform doctor --fresh");
    expect(await page.evaluate(() => window.__injected)).toBeUndefined();
    await failures.expectNone();
  } finally {
    await context.close();
  }
});

test("tables switch to cards below sm when they ask for it", async ({ browser }) => {
  const { page, context } = await openKit(browser, { size: { width: 390, height: 844 } });
  try {
    const root = byTestId(page, "uikit.table");
    await expect(root).toHaveAttribute("data-mode", "cards");
    await expect(root.locator('[data-testid="data-table.card"]')).toHaveCount(4);
    // The 2000-row table keeps its table layout (it did not ask for cards) and stays windowed.
    await expect(byTestId(page, "uikit.table-big")).toHaveAttribute("data-mode", "windowed");
  } finally {
    await context.close();
  }
});
