// CON-7b browser checks (07 §4.4, §6.7, §13.2 console-observability, chart
// component part): the chart section of /system/ui-kit holds the
// TimeRangePicker, the GpuMemoryBar and the lazily mounted TimeSeriesCharts.
// Checked here: uPlot is requested only when a chart is shown, gaps are
// breaks, the table view exposes the data, the range round-trips through the
// URL, the GpuMemoryBar table total equals its segments, and axe is clean in
// both themes at 1440 and 390. The real service-entry serves the console; the
// API is mocked in the browser.
const { test, expect } = require("@playwright/test");
const {
  collectFailures,
  expectNoA11yViolations,
  expectNoOverflow,
  mockConsoleApi,
  openUiKit,
  setPrefs,
  startEntry,
} = require("../helpers/console-harness.js");

const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
let entry;

test.beforeAll(async () => {
  entry = await startEntry();
});

test.afterAll(async () => {
  await entry?.stop();
});

const byTestId = (page, id) => page.locator(`[data-testid="${id}"]`);

async function openKit(browser, { theme = "light", size = "desktop", search = "" } = {}) {
  const context = await browser.newContext({ viewport: SIZES[size], colorScheme: theme, locale: "en-US", reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale: "en-US", density: "comfortable" }, { baseUrl: entry.url });
  const page = await context.newPage();
  const requested = [];
  page.on("request", (request) => {
    if (/\/vendor\/uplot\//.test(request.url())) requested.push(request.url());
  });
  await mockConsoleApi(page);
  const failures = await collectFailures(page);
  await openUiKit(page, entry.url, { search });
  return { context, page, requested, failures, close: () => context.close() };
}

async function showCharts(page) {
  await byTestId(page, "uikit.toggle-charts").click();
  await expect(byTestId(page, "uikit.chart-line").locator(".u-over")).toBeVisible();
  await expect(byTestId(page, "uikit.chart-stacked").locator(".u-over")).toBeVisible();
}

test("uPlot is requested only when a chart is shown", async ({ browser }) => {
  const { page, requested, failures, close } = await openKit(browser);
  try {
    expect(requested, "no uPlot request on the kit page itself").toEqual([]);
    await showCharts(page);
    expect(requested.filter((url) => url.endsWith(".js")).length, "the module loads once for both charts").toBe(1);
    expect(requested.some((url) => url.endsWith(".css")), "and its stylesheet").toBe(true);
    await expect(byTestId(page, "uikit.chart-line").getByRole("img", { name: /Latency with a collection gap: 2 series, 112 values/ })).toBeVisible();
    await failures.expectNone();
  } finally {
    await close();
  }
});

test("gaps render as breaks and the table view exposes every value", async ({ browser }) => {
  const { page, close } = await openKit(browser);
  try {
    await showCharts(page);
    const line = byTestId(page, "uikit.chart-line");
    // The first series has a six-sample gap, the second two lone points: counted on the canvas model through the table.
    await line.locator("[data-testid='time-series-chart.toggle']").click();
    const table = line.locator("[data-testid='time-series-chart.table'] table");
    await expect(table).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(60);
    await expect(table.locator("thead th")).toHaveText(["Time", "TTFT p50 (ms)", "TTFT p95 (ms)"]);
    await expect(table.locator("td[data-gap='true']")).toHaveCount(8);
    await expect(table.locator("td[data-gap='true']").first()).toHaveText("—");
    await expect(line.locator("[data-testid='time-series-chart.toggle']")).toHaveAttribute("aria-pressed", "true");
    await expect(line.getByRole("img")).toHaveCount(0);
    await line.locator("[data-testid='time-series-chart.toggle']").click();
    await expect(line.locator(".u-over")).toBeVisible();

    // uPlot is told not to join the gap: the series model carries nulls and spanGaps false.
    const stacked = byTestId(page, "uikit.chart-stacked");
    await stacked.locator("[data-testid='time-series-chart.toggle']").click();
    await expect(stacked.locator("td[data-gap='true']")).toHaveCount(2);
  } finally {
    await close();
  }
});

test("legend buttons hide a series, annotations are listed and a drag reports the brushed range", async ({ browser }) => {
  const { page, close } = await openKit(browser);
  try {
    await showCharts(page);
    const line = byTestId(page, "uikit.chart-line");
    const item = line.locator("[data-testid='time-series-chart.legend-item']").first();
    await expect(item).toHaveAttribute("aria-pressed", "true");
    await item.click();
    await expect(item).toHaveAttribute("aria-pressed", "false");
    await expect(line.locator(".u-over")).toBeVisible();
    await item.click();
    await expect(item).toHaveAttribute("aria-pressed", "true");

    const marks = line.locator("[data-testid='time-series-chart.annotation']");
    await expect(marks).toHaveCount(4);
    await expect(marks.first()).toContainText("Launch");

    const over = line.locator(".u-over");
    const box = await over.boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await expect(line.locator("[data-testid='time-series-chart.tooltip']")).toBeVisible();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(byTestId(page, "uikit.brush")).toContainText("Last zoom:");
  } finally {
    await close();
  }
});

test("the time range round-trips through the URL", async ({ browser }) => {
  const { page, close } = await openKit(browser, { search: "?range=7d&model=a" });
  try {
    const picker = byTestId(page, "time-range-picker.root");
    await expect(byTestId(page, "time-range-picker.7d")).toHaveAttribute("aria-pressed", "true");
    await expect(byTestId(page, "time-range-picker.label")).toHaveText("Last 7 d");

    await byTestId(page, "time-range-picker.1h").click();
    await expect(byTestId(page, "time-range-picker.1h")).toHaveAttribute("aria-pressed", "true");
    expect(new URL(page.url()).searchParams.get("range")).toBe("1h");
    expect(new URL(page.url()).searchParams.get("model"), "other parameters are kept").toBe("a");

    await byTestId(page, "time-range-picker.custom").click();
    await byTestId(page, "time-range-picker.from").fill("2026-10-13T08:00");
    await byTestId(page, "time-range-picker.to").fill("2026-10-13T07:00");
    await byTestId(page, "time-range-picker.apply").click();
    await expect(byTestId(page, "time-range-picker.problem")).toHaveText("The start must be before the end.");
    expect(new URL(page.url()).searchParams.get("range"), "an invalid range is not written").toBe("1h");

    await byTestId(page, "time-range-picker.to").fill("2026-10-14T09:30");
    await byTestId(page, "time-range-picker.apply").click();
    await expect(byTestId(page, "time-range-picker.problem")).toHaveCount(0);
    const url = new URL(page.url());
    expect(url.searchParams.get("range")).toBeNull();
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    await expect(picker.locator("[aria-pressed='true']")).toHaveCount(1);

    // Reloading from the copied link shows the same custom range.
    await openUiKit(page, entry.url, { search: `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` });
    await expect(byTestId(page, "time-range-picker.custom")).toHaveAttribute("aria-pressed", "true");
    await expect(byTestId(page, "time-range-picker.from")).toHaveValue("2026-10-13T08:00");
    await expect(byTestId(page, "time-range-picker.to")).toHaveValue("2026-10-14T09:30");
    // A link with a broken range falls back to the default preset.
    await openUiKit(page, entry.url, { search: "?range=2h" });
    await expect(byTestId(page, "time-range-picker.24h")).toHaveAttribute("aria-pressed", "true");
  } finally {
    await close();
  }
});

test("GpuMemoryBar: the table total equals its segments", async ({ browser }) => {
  const { page, close } = await openKit(browser);
  try {
    const bars = byTestId(page, "gpu-memory-bar.root");
    await expect(bars).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) {
      const bar = bars.nth(index);
      const sizes = await bar.locator("[data-testid='gpu-memory-bar.row']").evaluateAll((rows) => rows.map((row) => Number(row.dataset.mb)));
      const total = await bar.locator("[data-testid='gpu-memory-bar.total']").getAttribute("data-mb");
      expect(sizes.reduce((sum, value) => sum + value, 0)).toBe(Number(total));
      const widths = await bar.locator(".gpu-bar-seg").evaluateAll((segments) => segments.map((segment) => Number(segment.dataset.mb)));
      expect(widths.reduce((sum, value) => sum + value, 0), "the bar draws the same segments").toBe(Number(total));
      await expect(bar.getByRole("img")).toHaveAttribute("aria-label", /in use/);
    }
    const first = bars.nth(0);
    await expect(first.locator("[data-testid='gpu-memory-bar.row']")).toHaveCount(6);
    await expect(first.locator("[data-testid='gpu-memory-bar.over']")).toHaveCount(0);
    await expect(first.locator("[data-testid='gpu-memory-bar.budget']")).toHaveCount(1);
    const second = bars.nth(1);
    await expect(second.locator("[data-testid='gpu-memory-bar.row']")).toHaveCount(4);
    await expect(second.locator("[data-testid='gpu-memory-bar.over']")).toHaveCount(1);
    await expect(second.locator("[data-testid='gpu-memory-bar.over-text']")).toHaveText("Over budget by 13,000 MiB");
    await expect(second.locator("[data-testid='gpu-memory-bar.table'] caption")).toHaveText("Memory breakdown of GPU 1");
  } finally {
    await close();
  }
});

for (const theme of ["light", "dark"]) {
  for (const size of ["desktop", "phone"]) {
    test(`charts section has no axe findings, ${theme} at ${SIZES[size].width}`, async ({ browser }) => {
      test.setTimeout(120_000);
      const { page, close } = await openKit(browser, { theme, size });
      try {
        await showCharts(page);
        await expectNoA11yViolations(page, { label: `${theme} ${size} charts` });
        await expectNoOverflow(page);
        await byTestId(page, "uikit.chart-line").locator("[data-testid='time-series-chart.toggle']").click();
        await byTestId(page, "time-range-picker.custom").click();
        await expectNoA11yViolations(page, { label: `${theme} ${size} table view and custom range` });
        await expectNoOverflow(page);
      } finally {
        await close();
      }
    });
  }
}
