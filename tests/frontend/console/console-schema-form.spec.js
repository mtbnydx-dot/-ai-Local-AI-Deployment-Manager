// CON-10 browser checks (07 section 4.5, 13.2): SchemaForm over the demo
// catalog at /system/ui-kit's companion module. axe in both themes at 1440 and
// 390, and the behaviours the pure goldens cannot show: the level switch, the
// lock, the planner chip, a suggestion that applies only on click, tristate,
// kv, list and json editors, and the write-only secret. The API is mocked.
const { test, expect } = require("@playwright/test");
const {
  collectFailures,
  expectEmptyStorage,
  expectNoA11yViolations,
  expectNoOverflow,
  mockConsoleApi,
  setPrefs,
  startEntry,
} = require("../helpers/console-harness.js");

const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
const FAKE_KEY = "fake-test-key-0000";

let entry;

test.beforeAll(async () => {
  entry = await startEntry();
});

test.afterAll(async () => {
  await entry?.stop();
});

async function openDemo(browser, { theme = "light", size = "desktop", locale = "en-US" } = {}) {
  const context = await browser.newContext({ viewport: SIZES[size], colorScheme: theme, locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  const page = await context.newPage();
  await mockConsoleApi(page);
  const failures = await collectFailures(page);
  await page.goto(`${entry.url}system/ui-kit`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("aria-busy", /.+/);
  const buildId = await page.locator('meta[name="console-build"]').getAttribute("content");
  await page.evaluate(async ({ id, lang }) => {
    const catalog = await (await fetch(`/c/${id}/i18n/${lang}.json`)).json();
    const module = await import(`/c/${id}/routes/system/schema-form-demo.js`);
    module.mountSchemaFormDemo(document.getElementById("app"), { catalog, locale: lang });
  }, { id: buildId, lang: locale });
  await expect(page.locator('#main [data-ready="true"]')).toBeVisible();
  return { context, page, failures, close: () => context.close() };
}

const field = (page, id) => page.locator(`[data-testid="schema-form.root"] [data-field="${id}"]`);
const demoValues = async (page) => JSON.parse(await page.locator('[data-testid="demo.values"]').textContent());
const setLevel = (page, name) => page.locator('[data-testid="schema-form.root"]').getByRole("button", { name, exact: true }).click();

for (const theme of ["light", "dark"]) {
  for (const size of ["desktop", "phone"]) {
    test(`SchemaForm has no axe findings, ${theme} at ${SIZES[size].width}`, async ({ browser }) => {
      test.setTimeout(120_000);
      const demo = await openDemo(browser, { theme, size });
      try {
        await expectNoA11yViolations(demo.page, { label: `${theme} ${size} schema form basic` });
        await expectNoOverflow(demo.page);
        await setLevel(demo.page, "Expert");
        await expect(field(demo.page, "extraEnv")).toBeVisible();
        await expectNoA11yViolations(demo.page, { label: `${theme} ${size} schema form expert` });
        await expectNoOverflow(demo.page);
        await expectEmptyStorage(demo.page);
        await demo.failures.expectNone();
      } finally {
        await demo.close();
      }
    });
  }
}

test("the level switch shows deeper fields and the footer counts what is hidden", async ({ browser }) => {
  const { page, close } = await openDemo(browser);
  try {
    await expect(field(page, "contextLength")).toBeVisible();
    await expect(field(page, "extraArgs")).toHaveCount(0);
    // One engine-level and one appliesWhen parameter are not applicable; more sit at deeper levels.
    await expect(page.getByTestId("schema-form.hidden-na").first()).toHaveText("2 parameters hidden (not applicable to demo)");
    await expect(page.getByTestId("schema-form.hidden-level").first()).toContainText("more parameters at higher levels");
    await setLevel(page, "Expert");
    await expect(field(page, "extraArgs")).toBeVisible();
    await expect(page.getByTestId("schema-form.hidden-level")).toHaveCount(0);
    // The Basic button reports the pressed state.
    await expect(page.locator('[data-testid="schema-form.root"]').getByRole("button", { name: "Expert", exact: true })).toHaveAttribute("aria-pressed", "true");
    // A search crosses levels and matches the flag.
    await page.locator('[data-testid="schema-form.root"] [data-testid="schema-form.search"]').fill("served-model");
    await expect(field(page, "servedName")).toBeVisible();
    await expect(field(page, "contextLength")).toHaveCount(0);
  } finally {
    await close();
  }
});

test("a recipe-locked field is disabled with its reason, and a planner value carries its chip", async ({ browser }) => {
  const { page, close } = await openDemo(browser);
  try {
    await setLevel(page, "Advanced");
    const locked = field(page, "trustRemoteCode");
    await expect(locked).toHaveAttribute("data-locked", "true");
    await expect(locked.getByRole("switch")).toBeDisabled();
    await expect(locked).toContainText("The architecture needs repository code.");
    await expect(locked).toHaveAttribute("data-source", "recipe");
    const planner = field(page, "kvCacheDtype");
    await expect(planner).toHaveAttribute("data-source", "planner");
    await expect(planner.locator(".badge")).toHaveText("Planner");
    // The planner's value is selected but is not the user's: no changed dot yet.
    await expect(planner.getByRole("radio", { name: "FP8" })).toBeChecked();
    await expect(planner.getByTestId("form-field.changed")).toHaveCount(0);
  } finally {
    await close();
  }
});

test("a suggestion is a chip and changes the value only when clicked", async ({ browser }) => {
  const { page, close } = await openDemo(browser);
  try {
    await setLevel(page, "Advanced");
    const temperature = field(page, "temperature");
    await expect(temperature.getByTestId("form-field.error")).toHaveText("Too hot.");
    const chip = temperature.getByTestId("schema-form.suggestion");
    await expect(chip).toHaveText("Apply 2");
    expect((await demoValues(page)).temperature).toBe(3);
    await chip.click();
    expect((await demoValues(page)).temperature).toBe(2);
    await expect(temperature.locator("input")).toHaveValue("2");
  } finally {
    await close();
  }
});

test("numbers show a human hint and keep half-typed text", async ({ browser }) => {
  const { page, close } = await openDemo(browser);
  try {
    const input = field(page, "contextLength").locator("input");
    await input.fill("262144");
    await expect(field(page, "contextLength").getByTestId("schema-form.human")).toHaveText("262,144 = 256K");
    expect((await demoValues(page)).contextLength).toBe(262144);
    // appliesWhen follows the value: above 100000 the long-context option appears.
    await expect(field(page, "demo.when")).toHaveCount(0);
    await setLevel(page, "Advanced");
    await expect(field(page, "demo.when")).toBeVisible();
    await input.fill("");
    expect((await demoValues(page)).contextLength).toBeUndefined();
    await expect(field(page, "demo.when")).toHaveCount(0);
  } finally {
    await close();
  }
});

test("tristate sends null for Default, and the changed dot and reset follow the value", async ({ browser }) => {
  const { page, close } = await openDemo(browser);
  try {
    const caching = field(page, "prefixCaching");
    await expect(caching.getByRole("radio", { name: "Default" })).toBeChecked();
    await caching.getByRole("radio", { name: "On" }).check();
    expect((await demoValues(page)).prefixCaching).toBe(true);
    await expect(caching.getByTestId("form-field.changed")).toBeVisible();
    await caching.getByRole("radio", { name: "Off" }).check();
    expect((await demoValues(page)).prefixCaching).toBe(false);
    await caching.getByRole("radio", { name: "Default" }).check();
    expect("prefixCaching" in (await demoValues(page))).toBe(false);
    await caching.getByRole("radio", { name: "On" }).check();
    await caching.getByTestId("form-field.reset").click();
    expect("prefixCaching" in (await demoValues(page))).toBe(false);
  } finally {
    await close();
  }
});

test("list, rows, kv and json editors write whole values", async ({ browser }) => {
  const { page, close } = await openDemo(browser);
  try {
    await setLevel(page, "Expert");
    const args = field(page, "extraArgs");
    await args.getByRole("button", { name: "Add" }).click();
    await args.getByRole("textbox").first().fill("--schedule-policy");
    await args.getByRole("button", { name: "Add" }).click();
    await args.getByRole("textbox").nth(1).fill("lpm");
    expect((await demoValues(page)).extraArgs).toEqual(["--schedule-policy", "lpm"]);
    await args.getByRole("button", { name: "Remove" }).first().click();
    expect((await demoValues(page)).extraArgs).toEqual(["lpm"]);

    const env = field(page, "extraEnv");
    await env.getByRole("button", { name: "Add" }).click();
    await env.getByPlaceholder("Key").fill("EXAMPLE_FLAG");
    await env.getByPlaceholder("Value").fill("1");
    expect((await demoValues(page)).extraEnv).toEqual({ EXAMPLE_FLAG: "1" });

    const lora = field(page, "lora.adapters");
    await lora.getByRole("button", { name: "Add" }).click();
    await lora.getByPlaceholder("Name").fill("style");
    await lora.getByPlaceholder("Path").fill("C:/fixture/lora");
    expect((await demoValues(page))["lora.adapters"]).toEqual([{ name: "style", path: "C:/fixture/lora" }]);

    const json = field(page, "chatTemplateKwargs");
    await json.locator("textarea").fill("{\"enable_thinking\": ");
    await expect(json.getByTestId("schema-form.json-error")).toHaveText("Not valid JSON");
    expect((await demoValues(page)).chatTemplateKwargs).toBeUndefined();
    await json.locator("textarea").fill("{\"enable_thinking\": false}");
    await expect(json.getByTestId("schema-form.json-error")).toHaveCount(0);
    expect((await demoValues(page)).chatTemplateKwargs).toEqual({ enable_thinking: false });
  } finally {
    await close();
  }
});

test("a secret is write-only: a typed value is pending, Clear is explicit, Undo returns to Unchanged", async ({ browser }) => {
  const { page, close } = await openDemo(browser);
  try {
    const secret = field(page, "apiKey");
    await expect(secret.getByTestId("schema-form.secret-state")).toHaveText("Unchanged");
    await secret.locator("input").fill(FAKE_KEY);
    await expect(secret.getByTestId("schema-form.secret-state")).toHaveText("A new value will be sent");
    expect((await demoValues(page)).apiKey).toBe(FAKE_KEY);
    await secret.getByTestId("schema-form.secret-undo").click();
    await expect(secret.getByTestId("schema-form.secret-state")).toHaveText("Unchanged");
    expect("apiKey" in (await demoValues(page))).toBe(false);
    await expect(secret.locator("input")).toHaveValue("");
    // The rendered form never contains the value once it is no longer pending.
    expect(await page.content()).not.toContain(FAKE_KEY);
  } finally {
    await close();
  }
});

test("catalog mode is read-only with every level and no level switch", async ({ browser }) => {
  const { page, close } = await openDemo(browser);
  try {
    const catalog = page.getByTestId("schema-form.catalog");
    await expect(catalog.getByTestId("schema-form.levels")).toHaveCount(0);
    await expect(catalog.locator('[data-field="extraEnv"]')).toBeVisible();
    await expect(catalog.locator('[data-field="demo.when"]')).toBeVisible();
    const editable = catalog.locator(".sf-field input:not([disabled]), .sf-field select:not([disabled]), .sf-field textarea:not([disabled])");
    await expect(editable).toHaveCount(0);
  } finally {
    await close();
  }
});

test("the form follows the Chinese locale", async ({ browser }) => {
  const { page, close } = await openDemo(browser, { locale: "zh-CN" });
  try {
    const levels = page.locator('[data-testid="schema-form.root"] [data-testid="schema-form.levels"]');
    await expect(levels).toContainText("基础");
    await expect(levels).toContainText("进阶");
    await expect(levels).toContainText("专家");
    await expect(page.getByTestId("schema-form.hidden-na").first()).toHaveText("已隐藏 2 个不适用于 demo 的参数");
    await expect(page.locator('[data-testid="schema-form.root"] [data-testid="schema-form.search"]')).toHaveAttribute("placeholder", "查找参数…");
  } finally {
    await close();
  }
});
