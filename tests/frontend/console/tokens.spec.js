// CON-3 browser checks (07 §4.1-4.2): the real tokens.css and console base.css
// are loaded from disk by a page that runs no script, so every value below is
// computed by CSS alone. No server, no network and no platform state is used.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const TOKENS = pathToFileURL(path.join(ROOT, "shared-public", "styles", "tokens.css")).href;
const BASE = pathToFileURL(path.join(ROOT, "service-entry", "console", "styles", "base.css")).href;
const COMPONENTS = pathToFileURL(path.join(ROOT, "service-entry", "console", "styles", "components.css")).href;

let dir;

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "con3-tokens-"));
});

test.afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Mirrors the shell's link order (07 §2.3); the page has no script at all.
function pageUrl(name, { theme = "", density = "comfortable", withConsole = true } = {}) {
  const file = path.join(dir, `${name}.html`);
  const links = [`<link rel="stylesheet" href="${TOKENS}">`];
  if (withConsole) links.push(`<link rel="stylesheet" href="${BASE}">`, `<link rel="stylesheet" href="${COMPONENTS}">`);
  fs.writeFileSync(
    file,
    `<!doctype html><html lang="en" ${theme ? `data-theme="${theme}"` : ""} data-density="${density}"><head><meta charset="utf-8">${links.join("")}</head>` +
      `<body><button class="btn btn-primary">ok</button><div class="card">card</div></body></html>`,
  );
  return pathToFileURL(file).href;
}

async function computed(page, names) {
  return page.evaluate((list) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(list.map((name) => [name, style.getPropertyValue(name).trim()]));
  }, names);
}

const NAMES = ["--bg", "--surface-1", "--surface-2", "--surface-3", "--text", "--text-muted", "--border", "--border-strong", "--accent", "--accent-ink", "--focus-ring", "--success", "--warn", "--danger", "--chart-1", "--chart-8"];

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("[data-theme=dark] and the OS dark preference give the same computed tokens", async ({ browser }) => {
    const forced = await browser.newContext({ javaScriptEnabled: false, colorScheme: "light" });
    const osContext = await browser.newContext({ javaScriptEnabled: false, colorScheme: "dark" });
    try {
      const forcedPage = await forced.newPage();
      await forcedPage.goto(pageUrl("forced-dark", { theme: "dark" }));
      const osPage = await osContext.newPage();
      await osPage.goto(pageUrl("os-dark"));
      const fromForced = await computed(forcedPage, NAMES);
      const fromOs = await computed(osPage, NAMES);
      expect(fromOs["--bg"]).toBe("#0b1118");
      expect(fromForced).toEqual(fromOs);
      const paint = (p) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(await paint(forcedPage)).toBe(await paint(osPage));
      expect(await paint(osPage)).toBe("rgb(11, 17, 24)");
    } finally {
      await forced.close();
      await osContext.close();
    }
  });

  test("light stays light under an OS dark preference when data-theme=light", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: "dark" });
    try {
      const page = await context.newPage();
      await page.goto(pageUrl("forced-light", { theme: "light" }));
      expect((await computed(page, ["--bg"]))["--bg"]).toBe("#f5f7fa");
    } finally {
      await context.close();
    }
  });

  test("auto follows the OS preference in both directions", async ({ browser }) => {
    for (const [scheme, bg] of [["light", "#f5f7fa"], ["dark", "#0b1118"]]) {
      const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: scheme });
      try {
        const page = await context.newPage();
        await page.goto(pageUrl(`auto-${scheme}`));
        expect((await computed(page, ["--bg"]))["--bg"]).toBe(bg);
      } finally {
        await context.close();
      }
    }
  });

  test("compact density gives --row-h of 32 px and comfortable 40 px", async ({ page }) => {
    await page.goto(pageUrl("compact", { density: "compact" }));
    const compact = await computed(page, ["--row-h", "--input-h", "--pad-card"]);
    expect(compact).toEqual({ "--row-h": "32px", "--input-h": "30px", "--pad-card": "12px" });
    expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("13px");
    await page.goto(pageUrl("comfortable"));
    const comfortable = await computed(page, ["--row-h", "--input-h", "--pad-card"]);
    expect(comfortable).toEqual({ "--row-h": "40px", "--input-h": "36px", "--pad-card": "20px" });
    expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("14px");
  });

  test("tokens.css alone styles the page (portal use) and adds no console layout", async ({ page }) => {
    await page.goto(pageUrl("portal", { withConsole: false }));
    const values = await computed(page, ["--bg", "--accent", "--row-h", "--btn-h"]);
    expect(values["--bg"]).toBe("#f5f7fa");
    expect(values["--accent"]).toBe("#1d4ed8");
    expect(values["--row-h"]).toBe("");
    expect(values["--btn-h"]).toBe("");
  });

  test("primitives follow the theme and the density tokens", async ({ page }) => {
    await page.goto(pageUrl("button", { theme: "dark", density: "compact" }));
    const button = await page.locator(".btn").evaluate((el) => {
      const style = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, background: style.backgroundColor, color: style.color };
    });
    expect(button.height).toBe(30);
    expect(button.background).toBe("rgb(124, 176, 255)");
    expect(button.color).toBe("rgb(11, 17, 24)");
  });
});
