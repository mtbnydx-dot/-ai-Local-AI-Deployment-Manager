// CON-5 browser checks (07 §4.4, §9, §13.2 console-a11y, ui-kit part): the
// hidden /system/ui-kit page renders every primitive component, and the specs
// below hold it to axe (both themes, 1440 and 390), the keyboard contracts of
// Tabs and the dialogs, the CodeBlock copy fallback and the lazy qrcode load.
// The real service-entry serves the console; the API is mocked in the browser.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { judge, loadAllowlist, runAxe } = require("../helpers/axe.js");
const {
  collectFailures,
  expectEmptyStorage,
  expectNoA11yViolations,
  expectNoOverflow,
  mockConsoleApi,
  openUiKit,
  setPrefs,
  startEntry,
} = require("../helpers/console-harness.js");

const CODE = "platform admin pair\nplatform doctor --fresh";
const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };

let entry;

test.beforeAll(async () => {
  entry = await startEntry();
});

test.afterAll(async () => {
  await entry?.stop();
});

/** A fresh context with the kit open. `init` scripts run before the page loads. */
async function openKit(browser, { theme = "light", size = "desktop", locale = "en-US", density = "comfortable", init, permissions } = {}) {
  // Reduced motion keeps axe from sampling a half-faded toast or drawer.
  const context = await browser.newContext({ viewport: SIZES[size], colorScheme: theme, locale, reducedMotion: "reduce", ...(permissions ? { permissions } : {}) });
  await setPrefs(context, { theme, locale, density }, { baseUrl: entry.url });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const api = await mockConsoleApi(page);
  const failures = await collectFailures(page);
  await openUiKit(page, entry.url, { locale });
  return { context, page, api, failures, close: () => context.close() };
}

const byTestId = (page, id) => page.locator(`[data-testid="${id}"]`);

for (const theme of ["light", "dark"]) {
  for (const size of ["desktop", "phone"]) {
    test(`ui-kit has no axe findings, ${theme} at ${SIZES[size].width}`, async ({ browser }) => {
      test.setTimeout(120_000);
      const kit = await openKit(browser, { theme, size });
      const { page } = kit;
      try {
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expectNoA11yViolations(page, { label: `${theme} ${size} base` });
        await expectNoOverflow(page);

        // Every overlay and transient state is checked while it is open.
        for (const [trigger, name] of [["uikit.open-confirm", "Apply this change?"], ["uikit.open-danger", "Delete this model?"], ["uikit.open-drawer", "Drawer"]]) {
          await byTestId(page, trigger).click();
          await expect(page.getByRole(trigger === "uikit.open-danger" ? "alertdialog" : "dialog", { name })).toBeVisible();
          await expectNoA11yViolations(page, { label: `${theme} ${size} ${trigger}` });
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog")).toHaveCount(0);
        }

        const help = page.getByRole("button", { name: "Help for Context length" });
        await help.click();
        await expect(help).toHaveAttribute("aria-expanded", "true");
        await expectNoA11yViolations(page, { label: `${theme} ${size} help popover` });
        await page.keyboard.press("Escape");

        await byTestId(page, "uikit.push-toast").click();
        await expect(byTestId(page, "toast.region").locator("[data-testid='toast.root']")).toHaveCount(1);
        await expectNoA11yViolations(page, { label: `${theme} ${size} toast` });

        await byTestId(page, "uikit.toggle-qr").click();
        await expect(byTestId(page, "qr-code.svg")).toBeVisible();
        await expectNoA11yViolations(page, { label: `${theme} ${size} qr` });

        await byTestId(page, "uikit.crash").click();
        await expect(page.getByRole("alert").filter({ hasText: "This page crashed" })).toBeVisible();
        await expectNoA11yViolations(page, { label: `${theme} ${size} crashed section` });
        await expectNoOverflow(page);

        await kit.failures.expectNone();
        await expectEmptyStorage(page);
        expect(kit.api.unmocked, "the kit calls no API").toEqual([]);
      } finally {
        await kit.close();
      }
    });
  }
}

test("compact density keeps every target at least 24 px and passes axe", async ({ browser }) => {
  const { page, close } = await openKit(browser, { density: "compact", size: "phone" });
  try {
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    await expectNoA11yViolations(page, { label: "compact phone base" });
    const small = await page.evaluate(() => [...document.querySelectorAll("button, a.btn")].filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && (box.width < 24 || box.height < 24);
    }).map((el) => el.textContent.trim() || el.getAttribute("aria-label")));
    expect(small, "controls under 24 x 24 px").toEqual([]);
  } finally {
    await close();
  }
});

test("the kit renders in Chinese and English with no raw keys and no stray language", async ({ browser }) => {
  const han = /\p{Script=Han}/u;
  const rawKey = /\b(?:uikit|common|shell)\.[a-z][A-Za-z0-9.]+/;
  const en = await openKit(browser, { locale: "en-US" });
  try {
    const text = await en.page.locator("#app").innerText();
    expect(han.test(text), "no Han characters in English").toBe(false);
    expect(text).not.toMatch(rawKey);
    await expect(en.page.locator("html")).toHaveAttribute("lang", "en-US");
  } finally {
    await en.close();
  }
  const zh = await openKit(browser, { locale: "zh-CN" });
  try {
    await expect(zh.page.locator("#main h1")).toHaveText("界面组件库");
    const text = await zh.page.locator("#app").innerText();
    expect(text).not.toMatch(rawKey);
    await expectNoA11yViolations(zh.page, { label: "zh-CN" });
  } finally {
    await zh.close();
  }
});

test.describe("Tabs", () => {
  test("roving tabindex and arrow, Home and End keys, skipping the disabled tab", async ({ browser }) => {
    const { page, close } = await openKit(browser);
    try {
      const tablist = page.getByRole("tablist", { name: "Tabs", exact: true });
      const first = tablist.getByRole("tab", { name: "First" });
      const second = tablist.getByRole("tab", { name: /^Second/ });
      const third = tablist.getByRole("tab", { name: "Disabled" });
      await expect(first).toHaveAttribute("aria-selected", "true");
      await expect(first).toHaveAttribute("tabindex", "0");
      await expect(second).toHaveAttribute("tabindex", "-1");
      await expect(third).toBeDisabled();

      await first.focus();
      await page.keyboard.press("ArrowRight");
      await expect(second).toBeFocused();
      await expect(second).toHaveAttribute("aria-selected", "true");
      await expect(second).toHaveAttribute("tabindex", "0");
      await expect(first).toHaveAttribute("tabindex", "-1");
      await expect(page.getByRole("tabpanel")).toContainText("Panel for Second");

      await page.keyboard.press("ArrowRight");
      await expect(first, "wraps past the disabled tab").toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(second, "wraps backwards past the disabled tab").toBeFocused();
      await page.keyboard.press("Home");
      await expect(first).toBeFocused();
      await page.keyboard.press("End");
      await expect(second, "End goes to the last enabled tab").toBeFocused();

      const panel = page.getByRole("tabpanel");
      await expect(panel).toHaveAttribute("tabindex", "0");
      await expect(second).toHaveAttribute("aria-controls", (await panel.getAttribute("id")) || "");
      await expect(panel).toHaveAttribute("aria-labelledby", (await second.getAttribute("id")) || "");
      await page.keyboard.press("Tab");
      await expect(panel, "the tablist is one tab stop; Tab reaches the panel").toBeFocused();
    } finally {
      await close();
    }
  });

  test("manual activation moves focus with the arrows and selects with Enter", async ({ browser }) => {
    const { page, close } = await openKit(browser);
    try {
      const tablist = page.getByRole("tablist", { name: "Manual activation tabs" });
      const first = tablist.getByRole("tab", { name: "First" });
      const second = tablist.getByRole("tab", { name: "Second" });
      await first.focus();
      await page.keyboard.press("ArrowRight");
      await expect(second).toBeFocused();
      await expect(second).toHaveAttribute("aria-selected", "false");
      await expect(first).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(second).toHaveAttribute("aria-selected", "true");
      await expect(first).toHaveAttribute("aria-selected", "false");
    } finally {
      await close();
    }
  });
});

test.describe("dialogs", () => {
  test("type-to-confirm blocks a wrong string and restores focus", async ({ browser }) => {
    const { page, close } = await openKit(browser);
    try {
      const trigger = byTestId(page, "uikit.open-danger");
      const dialog = page.getByRole("alertdialog", { name: "Delete this model?" });
      const input = byTestId(page, "dialog.input");
      const confirm = byTestId(page, "dialog.confirm");

      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await expect(input, "initial focus is the type field").toBeFocused();
      await expect(confirm).toBeDisabled();
      await expect(dialog).toContainText("Deployments that serve this model stop.");
      await expect(dialog).toContainText("Running deployments of other models keep running.");

      for (const wrong of ["delete-m", "Delete-me", "delete-me ", "delete-me!"]) {
        await input.fill(wrong);
        await expect(confirm, `"${wrong}" does not unlock confirm`).toBeDisabled();
      }
      await input.press("Enter");
      await expect(dialog, "Enter with a wrong string does nothing").toBeVisible();
      await page.mouse.click(4, 4);
      await expect(dialog, "the backdrop never closes a danger dialog").toBeVisible();

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger, "focus returns to the opener on Esc").toBeFocused();

      await page.keyboard.press("Enter");
      await expect(input).toBeFocused();
      await expect(input, "the text is cleared on reopen").toHaveValue("");
      await input.fill("delete-me");
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger, "focus returns to the opener after confirming").toBeFocused();
    } finally {
      await close();
    }
  });

  test("a default dialog focuses Confirm, a failing confirm stays open with the error, Cancel restores focus", async ({ browser }) => {
    const { page, close } = await openKit(browser);
    try {
      const plain = byTestId(page, "uikit.open-confirm");
      await plain.click();
      await expect(byTestId(page, "dialog.confirm")).toBeFocused();
      await page.mouse.click(4, 4);
      await expect(page.getByRole("dialog", { name: "Apply this change?" }), "the backdrop closes a default dialog").toHaveCount(0);
      await expect(plain).toBeFocused();

      const fail = byTestId(page, "uikit.open-fail");
      await fail.click();
      await byTestId(page, "dialog.confirm").click();
      await expect(byTestId(page, "dialog.error")).toHaveText("The request timed out. Try again in a moment.");
      await expect(byTestId(page, "dialog.confirm"), "the dialog stays open and can retry").toBeEnabled();
      await byTestId(page, "dialog.cancel").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(fail).toBeFocused();
    } finally {
      await close();
    }
  });

  test("Tab stays inside an open dialog and the drawer is a full-screen sheet on a phone", async ({ browser }) => {
    const { page, close } = await openKit(browser, { size: "phone" });
    try {
      const opener = byTestId(page, "uikit.open-drawer");
      await opener.click();
      const drawer = page.getByRole("dialog", { name: "Drawer" });
      await expect(drawer).toBeVisible();
      expect((await drawer.boundingBox()).width).toBeGreaterThanOrEqual(389);
      for (let index = 0; index < 6; index += 1) {
        await page.keyboard.press("Tab");
        // A modal dialog may hand focus to the browser UI (activeElement is then the body), never to the page behind it.
        expect(await page.evaluate(() => document.activeElement === document.body || Boolean(document.activeElement?.closest("dialog"))), `Tab ${index + 1} stays in the dialog`).toBe(true);
      }
      await byTestId(page, "drawer.close").click();
      await expect(drawer).toHaveCount(0);
      await expect(opener).toBeFocused();
    } finally {
      await close();
    }
  });
});

test.describe("CodeBlock copy", () => {
  // Records what execCommand("copy") would copy, whatever the page selected.
  const spy = ({ secure, clipboard, execResult }) => {
    window.__copied = [];
    window.__clipboardCalls = 0;
    const original = document.execCommand.bind(document);
    document.execCommand = (command, ...rest) => {
      if (command !== "copy") return original(command, ...rest);
      const el = document.activeElement;
      window.__copied.push(el && "value" in el ? el.value.slice(el.selectionStart, el.selectionEnd) : String(window.getSelection()));
      return execResult;
    };
    if (secure === false) Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    if (clipboard === "denied") {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => { window.__clipboardCalls += 1; return Promise.reject(new DOMException("denied", "NotAllowedError")); } },
      });
    }
    if (clipboard === "forbidden") {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => { window.__clipboardCalls += 1; return Promise.resolve(); } },
      });
    }
  };

  test("falls back to the textarea route when clipboard permission is denied", async ({ browser }) => {
    const { page, close } = await openKit(browser, { init: `(${spy})({ clipboard: "denied", execResult: true })` });
    try {
      const copy = byTestId(page, "code-block.copy");
      await copy.click();
      await expect(copy).toContainText("Copied");
      await expect(byTestId(page, "code-block.status")).toHaveText("Copied");
      expect(await page.evaluate(() => window.__clipboardCalls), "the async clipboard was tried first").toBe(1);
      expect(await page.evaluate(() => window.__copied)).toEqual([CODE]);
      await expect(copy, "the label returns after a moment").toContainText("Copy", { timeout: 4000 });
      await expect(page.locator("textarea"), "the helper textarea is removed").toHaveCount(0);
    } finally {
      await close();
    }
  });

  test("uses execCommand outside a secure context (LAN over http)", async ({ browser }) => {
    const { page, close } = await openKit(browser, { init: `(${spy})({ secure: false, clipboard: "forbidden", execResult: true })` });
    try {
      await byTestId(page, "code-block.copy").click();
      await expect(byTestId(page, "code-block.status")).toHaveText("Copied");
      expect(await page.evaluate(() => window.__clipboardCalls), "navigator.clipboard is not used when insecure").toBe(0);
      expect(await page.evaluate(() => window.__copied)).toEqual([CODE]);
    } finally {
      await close();
    }
  });

  test("when every route fails it says so and selects the text for Ctrl+C", async ({ browser }) => {
    const { page, close } = await openKit(browser, { init: `(${spy})({ clipboard: "denied", execResult: false })` });
    try {
      await byTestId(page, "code-block.copy").click();
      await expect(byTestId(page, "code-block.status")).toHaveText("Copy failed. Select the text and copy it by hand.");
      expect(await page.evaluate(() => window.getSelection().toString())).toBe(CODE);
    } finally {
      await close();
    }
  });

  test("writes through navigator.clipboard when it is allowed", async ({ browser }) => {
    const { page, close } = await openKit(browser, { permissions: ["clipboard-read", "clipboard-write"] });
    try {
      await byTestId(page, "code-block.copy").click();
      await expect(byTestId(page, "code-block.status")).toHaveText("Copied");
      // Windows puts CRLF on the clipboard.
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText.split(/\r?\n/).join("\n")).toBe(CODE);
    } finally {
      await close();
    }
  });
});

test("QrCode loads qrcode lazily, only when one is shown", async ({ browser }) => {
  const context = await browser.newContext({ viewport: SIZES.desktop });
  const requested = [];
  try {
    const page = await context.newPage();
    page.on("request", (request) => {
      if (/\/vendor\/(?:qrcode|uplot)\//.test(request.url())) requested.push(request.url());
    });
    await mockConsoleApi(page);
    await openUiKit(page, entry.url);
    expect(requested, "no qrcode or uPlot request on page load").toEqual([]);

    const toggle = byTestId(page, "uikit.toggle-qr");
    await toggle.click();
    const svg = page.getByRole("img", { name: "Pairing code (sample)" });
    await expect(svg).toBeVisible();
    expect(requested.filter((url) => url.includes("/vendor/qrcode/")).length, "qrcode is requested once").toBe(1);
    expect(requested.some((url) => url.includes("/vendor/uplot/")), "uPlot stays out of this page").toBe(false);
    expect((await svg.locator("path").getAttribute("d")).startsWith("M")).toBe(true);
    const box = await svg.boundingBox();
    expect(box.width).toBeGreaterThan(100);

    await toggle.click();
    await expect(svg).toHaveCount(0);
    await toggle.click();
    await expect(svg).toBeVisible();
    expect(requested.filter((url) => url.includes("/vendor/qrcode/")).length, "the module is cached for the page").toBe(1);
  } finally {
    await context.close();
  }
});

test.describe("Toast", () => {
  test("keeps at most 3, auto-dismisses success while paused on hover, and keeps errors", async ({ browser }) => {
    test.setTimeout(60_000);
    const { page, close } = await openKit(browser);
    try {
      const push = byTestId(page, "uikit.push-toast");
      const region = byTestId(page, "toast.region");
      const toasts = region.locator("[data-testid='toast.root']");

      await push.click();
      const success = toasts.first();
      await expect(success).toHaveAttribute("role", "status");
      await success.hover();
      await page.waitForTimeout(5600);
      await expect(success, "hover pauses the 5 s timer").toBeVisible();
      await page.mouse.move(700, 5);
      await expect(success).toHaveCount(0, { timeout: 8000 });

      await push.click();
      const error = toasts.first();
      await expect(error).toHaveAttribute("role", "alert");
      await expect(error.getByRole("button", { name: "Copy details" })).toBeVisible();
      for (let index = 0; index < 4; index += 1) await push.click();
      await expect(toasts, "at most three toasts").toHaveCount(3);
      // The queue was [error, info, warn, success, error]: the oldest non-errors went first.
      await expect(region.locator("[data-level='error']"), "errors are kept over older non-errors").toHaveCount(2);
      await page.waitForTimeout(5600);
      await expect(region.locator("[data-level='error']"), "errors persist").toHaveCount(2);
      await expect(region.locator("[data-level='success']"), "the success toast closed itself").toHaveCount(0);
    } finally {
      await close();
    }
  });
});

test.describe("component contracts", () => {
  test("StatTile windows, ProgressRow values, Stepper and StatusBadge text", async ({ browser }) => {
    const { page, close } = await openKit(browser);
    try {
      const tiles = page.locator("[data-testid='stat-tile.root']");
      expect(await tiles.count()).toBe(3);
      await expect(page.locator("[data-testid='stat-tile.root'] [data-window]")).toHaveCount(3);
      await expect(page.locator("[data-testid='stat-tile.value']").first()).toHaveText("38.6");
      await expect(page.locator("data[value='—']"), "an empty value is an em dash, not a zero").toHaveCount(1);

      const bar = page.getByRole("progressbar", { name: "model.gguf" });
      await expect(bar).toHaveAttribute("aria-valuenow", "42");
      await expect(bar).toHaveAttribute("aria-valuetext", /^42% · 1\.2 GiB\/s · about 3 min left$/);
      const indeterminate = page.getByRole("progressbar", { name: "index" });
      await expect(indeterminate).not.toHaveAttribute("aria-valuenow", /.*/);
      await expect(indeterminate).toHaveAttribute("aria-valuetext", "In progress");

      const steps = page.getByRole("list", { name: "Deployment phases", exact: true }).locator("li");
      await expect(steps).toHaveCount(5);
      await expect(steps.locator("xpath=self::*[@aria-current='step']"), "only the active step is current").toHaveCount(1);
      await expect(steps.nth(3)).toContainText("Failed");

      for (const status of ["OK", "Warning", "Error", "Info", "Neutral", "Unknown", "Loading"]) {
        await expect(page.locator("[data-testid='status-badge.root']").filter({ hasText: new RegExp(`^\\s*${status}\\s*$`) }).first()).toBeVisible();
      }
      await expect(page.locator("[data-testid='status-badge.root'][data-status='unknown']").first()).not.toHaveClass(/badge-success/);
    } finally {
      await close();
    }
  });

  test("FormField wires labels, units, help, errors, the lock and the reset button", async ({ browser }) => {
    const { page, close } = await openKit(browser);
    try {
      const context = page.getByLabel("Context length", { exact: true });
      await expect(context).toHaveValue("65536");
      const described = (await context.getAttribute("aria-describedby")).split(" ");
      expect(described.length).toBe(2);
      await expect(page.locator(`#${described[0]}`)).toHaveText("Larger values need more memory.");
      await expect(page.locator(`#${described[1]}`)).toHaveText("tokens");
      await expect(page.getByRole("img", { name: "Modified" })).toBeVisible();

      const name = page.getByLabel("Name");
      await expect(name).toHaveAttribute("aria-invalid", "true");
      await expect(name).toHaveAttribute("required", "");
      const errorId = (await name.getAttribute("aria-describedby")).split(" ").pop();
      await expect(page.locator(`#${errorId}`)).toContainText("A name is required");

      const locked = page.getByLabel("Locked field");
      await expect(locked).toBeDisabled();
      await expect(page.locator(`#${(await locked.getAttribute("aria-describedby")).split(" ")[0]}`)).toContainText("set by the recipe");

      await page.getByRole("button", { name: "Reset to default" }).click();
      await expect(page.getByRole("img", { name: "Modified" })).toHaveCount(0);

      const help = page.getByRole("button", { name: "Help for Context length" });
      await help.click();
      const panel = page.getByRole("group", { name: "Help for Context length" });
      await expect(panel).toContainText("The longest prompt plus answer the model accepts.");
      await expect(panel.locator("code")).toHaveText("--max-model-len");
      await expect(panel.getByRole("link", { name: "Documentation" })).toHaveAttribute("rel", "noopener noreferrer");
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(help, "Esc returns focus to the trigger").toBeFocused();
      await expect(help).toHaveAttribute("aria-expanded", "false");
    } finally {
      await close();
    }
  });

  test("ErrorBoundary shows the code and request id and copies diagnostics without the query string", async ({ browser }) => {
    const { page, close } = await openKit(browser, { permissions: ["clipboard-read", "clipboard-write"] });
    try {
      await byTestId(page, "uikit.crash").click();
      const panel = page.getByRole("alert").filter({ hasText: "This page crashed" });
      await expect(panel.getByRole("heading", { name: "This page crashed" })).toBeFocused();
      await expect(byTestId(page, "error-boundary.code")).toHaveText("ui_kit_crash");
      await expect(byTestId(page, "error-boundary.request-id")).toHaveText("req_uikit");
      await expect(byTestId(page, "error-boundary.reload")).toBeVisible();
      await byTestId(page, "error-boundary.copy").click();
      const diagnostics = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
      expect(diagnostics).toMatchObject({ code: "ui_kit_crash", requestId: "req_uikit", path: "/system/ui-kit" });
      expect(diagnostics.build).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      await close();
    }
  });

  test("DiffTable marks changed rows with text styling and EmptyState names its action", async ({ browser }) => {
    const { page, close } = await openKit(browser);
    try {
      const rows = page.locator("[data-testid='diff-table.row']");
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toHaveAttribute("data-changed", "true");
      await expect(rows.nth(2)).toHaveAttribute("data-changed", "false");
      const decoration = await rows.nth(0).locator("td").first().evaluate((el) => getComputedStyle(el).textDecorationLine);
      expect(decoration, "removed values are struck through").toBe("line-through");
      await expect(page.getByRole("table", { name: "Launch settings: current and new values" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Go to overview" })).toBeVisible();
    } finally {
      await close();
    }
  });
});

test.describe("addressable state and layout", () => {
  test("Tabs mirror the active tab into the URL and a link restores it; the Drawer mirrors ?drawer=", async ({ browser }) => {
    const { page, close } = await openKit(browser);
    try {
      const manual = page.getByRole("tablist", { name: "Manual activation tabs" });
      await manual.getByRole("tab", { name: "Second" }).click();
      await expect(page).toHaveURL(/[?&]manual=two\b/);
      expect(await page.evaluate(() => window.history.length), "replaceState adds no history entries").toBeLessThanOrEqual(2);

      await byTestId(page, "uikit.open-drawer").click();
      await expect(page).toHaveURL(/[?&]drawer=kit\b/);
      await expect(page).toHaveURL(/[?&]manual=two\b/);
      await page.keyboard.press("Escape");
      await expect(page).not.toHaveURL(/drawer=/);

      await openUiKit(page, entry.url, { search: "?manual=two&drawer=kit" });
      await expect(page.getByRole("dialog", { name: "Drawer" }), "?drawer=kit reopens the drawer").toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("tablist", { name: "Manual activation tabs" }).getByRole("tab", { name: "Second" }), "?manual=two selects the tab").toHaveAttribute("aria-selected", "true");
    } finally {
      await close();
    }
  });

  test("HelpPopover is a bottom sheet below sm and anchored under its trigger on desktop", async ({ browser }) => {
    const phone = await openKit(browser, { size: "phone" });
    try {
      await phone.page.getByRole("button", { name: "Help for Context length" }).click();
      const panel = phone.page.getByRole("group", { name: "Help for Context length" });
      const box = await panel.boundingBox();
      expect(box.x).toBe(0);
      expect(box.width).toBe(390);
      expect(Math.round(box.y + box.height), "pinned to the bottom edge").toBe(844);
    } finally {
      await phone.close();
    }
    const desktop = await openKit(browser);
    try {
      const trigger = desktop.page.getByRole("button", { name: "Help for Context length" });
      await trigger.click();
      const triggerBox = await trigger.boundingBox();
      const box = await desktop.page.getByRole("group", { name: "Help for Context length" }).boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height);
      expect(box.width).toBeLessThanOrEqual(320);
    } finally {
      await desktop.close();
    }
  });

  test("StackedBar lists every part and the free share as text", async ({ browser }) => {
    const { page, close } = await openKit(browser);
    try {
      const bar = byTestId(page, "stacked-bar.root");
      await expect(bar.locator("[data-testid='stacked-bar.part']")).toHaveCount(3);
      await expect(bar).toContainText("57 GiB / 80 GiB");
      await expect(bar.locator("[data-testid='stacked-bar.part']").first()).toContainText("weights 42 GiB (53%)");
      await expect(bar.locator("li").last()).toContainText("Free 23 GiB");
    } finally {
      await close();
    }
  });
});

test.describe("axe gate", () => {
  const v = (id, impact) => ({ id, impact, help: id, nodes: [] });

  test("serious and critical always fail, moderate fails unless listed with a justification, minor never fails", () => {
    const listed = [{ rule: "heading-order", route: "/system/ui-kit", justification: "documented exception" }];
    const { failing, tolerated } = judge([v("a", "critical"), v("b", "serious"), v("heading-order", "moderate"), v("region", "moderate"), v("c", "minor")], { route: "/system/ui-kit", allowlist: listed });
    expect(failing.map((item) => item.id)).toEqual(["a", "b", "region"]);
    expect(tolerated.map((item) => item.id)).toEqual(["heading-order", "c"]);
    const sneaky = [{ rule: "color-contrast", route: "*", justification: "cannot hide a serious finding" }];
    expect(judge([v("color-contrast", "serious")], { allowlist: sneaky }).failing).toHaveLength(1);
    expect(judge([v("heading-order", "moderate")], { route: "/other", allowlist: listed }).failing, "an entry is per route").toHaveLength(1);
  });

  test("allowlist entries need a rule, a route and a justification, and the shipped list is empty", () => {
    expect(loadAllowlist()).toEqual([]);
    const file = path.join(os.tmpdir(), `axe-allowlist-${process.pid}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify({ entries: [{ rule: "region", route: "*", justification: " " }] }));
      expect(() => loadAllowlist(file)).toThrow(/justification/);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test("axe really runs on the page: a nameless button is reported as critical", async ({ browser }) => {
    const { page, close } = await openKit(browser);
    try {
      await page.evaluate(() => {
        document.querySelector("#main").append(document.createElement("button"));
      });
      const violations = await runAxe(page);
      const hit = violations.find((item) => item.id === "button-name");
      expect(hit?.impact).toBe("critical");
      expect(judge(violations, { route: "/system/ui-kit" }).failing.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// CON-28 sweep (07 §9, §11, §13.2): every route of the table, in both themes at
// 1440 and 390, runs axe and must not scroll sideways. The shell hosts the
// pages (the real app.js); the APIs a page reads are answered from the shared
// fixtures where they exist and by the harness's 404 otherwise, so a page that
// has no data shows its own empty or error state, and that state is held to the
// same standard. The route list comes from console/routes.js, so a page added
// later is swept without editing this file.

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures");
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER_BOOTSTRAP = {
  role: "owner",
  auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" },
  features: { platform: true, telemetry: true, alerts: true, audit: true, access: true, public: true, session: true, hub: true, models: true, engines: true, setup: true },
};
const PARAM_SAMPLES = {
  fleetId: "vllm:primary",
  entryId: "entry-1",
  provider: "hf",
  owner: "acme",
  name: "demo-model",
  engineId: "vllm",
  requestId: "req-1",
  keyId: "key-1",
};
const fixture = (file) => JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8"));

async function loadRoutePaths() {
  const { ROUTES } = await import(pathToFileURL(path.resolve(__dirname, "..", "..", "..", "service-entry", "console", "routes.js")).href);
  return ROUTES.filter((route) => !route.redirect && route.path !== "*").map((route) => ({
    name: route.name,
    href: route.path.replace(/:([A-Za-z]+)/g, (_, key) => encodeURIComponent(PARAM_SAMPLES[key] ?? "sample")).replace(/^\//, ""),
  }));
}

async function sweepContext(browser, { theme, size, role = "owner" }) {
  const context = await browser.newContext({ viewport: SIZES[size], colorScheme: theme, locale: "en-US", reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale: "en-US", density: "comfortable" }, { baseUrl: entry.url });
  const patch = role === "owner" ? OWNER_BOOTSTRAP : { role, auth: { ...OWNER_BOOTSTRAP.auth, session: { role, via: "session", paired: false, autoPairAvailable: false } }, features: OWNER_BOOTSTRAP.features };
  const guarded = (handler) => async (route) => {
    try {
      await handler(route);
    } catch (error) {
      if (!/disposed|closed|aborted/i.test(String(error?.message))) throw error;
    }
  };
  await context.route((url) => url.pathname === "/api/console/bootstrap", guarded(async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, ...patch, features: { ...body.features, ...patch.features } }) });
  }));
  await context.route((url) => !/^\/(api|c|gateway)\//.test(url.pathname), guarded(async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    // The entry's admin guard answers /billing without a paired session with its static pairing page
    // (covered by service-entry's tests), so the shell is fetched from /overview and served under /billing.
    const asBilling = new URL(route.request().url()).pathname === "/billing";
    const response = await route.fetch(asBilling ? { url: `${entry.url}overview` } : undefined);
    const text = await response.text();
    return route.fulfill({
      response,
      body: text.replace(BOOTSTRAP_BLOCK, (match, open, json, close) => {
        const base = JSON.parse(json);
        return `${open}${JSON.stringify({ ...base, ...patch, features: { ...base.features, ...patch.features } }).replace(/</g, String.fromCharCode(92) + "u003c")}${close}`;
      }),
    });
  }));
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const api = await mockConsoleApi(page, {
    "GET /api/status": fixture("console/status.json"),
    "GET /api/platform/status": fixture("console/platform-status.json"),
    "GET /api/fleet": fixture("console/fleet.json"),
    "GET /api/telemetry/live": fixture("telemetry/live.json"),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    ...(role === "owner" ? {} : { session: { role, paired: false } }),
  });
  return { context, page, api, failures };
}

async function settle(page) {
  await expect(page.locator("#main h1").first()).toBeVisible();
  await expect(page.locator("#app")).not.toHaveAttribute("aria-busy", /.+/);
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
}

test.describe("every route", () => {
  for (const theme of ["light", "dark"]) {
    for (const size of ["desktop", "phone"]) {
      test(`axe is clean and nothing overflows on any route, ${theme} at ${SIZES[size].width}`, async ({ browser }) => {
        test.setTimeout(900_000);
        const only = (process.env.CONSOLE_SWEEP_ONLY || "").split(",").filter(Boolean);
        const routes = (await loadRoutePaths()).filter((route) => !only.length || only.includes(route.name));
        if (!only.length) expect(routes.length, "the route table is not empty").toBeGreaterThan(40);
        const { context, page, failures } = await sweepContext(browser, { theme, size });
        const problems = [];
        try {
          for (const route of [...routes, ...(only.length ? [] : [{ name: "not-found", href: "models/no-such-page" }])]) {
            await page.goto(`${entry.url}${route.href}`);
            try {
              await settle(page);
              await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
              await expectNoA11yViolations(page, { label: `${route.name} ${theme} ${size}` });
              await expectNoOverflow(page);
            } catch (error) {
              problems.push(`${route.name} (/${route.href}): ${String(error.message).split("\n").slice(0, 12).join("\n")}`);
            }
          }
          expect(problems.join("\n---\n"), "routes with findings").toBe("");
          const real = failures.failures.filter((item) => !/Failed to load resource/.test(item));
          expect(real, "frontend failures").toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }

  test("a viewer's forbidden page is axe-clean too, both themes at 390", async ({ browser }) => {
    for (const theme of ["light", "dark"]) {
      const { context, page } = await sweepContext(browser, { theme, size: "phone", role: "viewer" });
      try {
        await page.goto(`${entry.url}system/doctor`);
        await settle(page);
        await expectNoA11yViolations(page, { label: `viewer ${theme}` });
        await expectNoOverflow(page);
      } finally {
        await context.close();
      }
    }
  });
});
