// CON-22 browser checks (07 §6.11 console-billing): /billing embeds the legacy
// page at /billing/classic?embed=1, reloads it when the theme changes, and
// shows the local-only EmptyState to everyone but a local owner. The real
// service-entry serves the shell and the console assets; the owner-gated
// document requests and the console API are answered in the browser (the
// server-side gate is covered by service-entry/test/console-routes.test.js).
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { collectFailures, expectNoOverflow, mockConsoleApi, setPrefs, startEntry } = require("../helpers/console-harness.js");

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures", "console");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER = { role: "owner", auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" } };
const VIEWER = { role: "viewer", auth: { mode: "session", session: { role: "viewer", via: "none", paired: false, autoPairAvailable: false }, csrf: null } };
const SESSION_UNPAIRED = { ok: true, role: "viewer", via: "none", paired: false, csrfToken: null, autoPairAvailable: false, pairCommand: "platform admin pair" };
const BILLING_CLASSIC_CSP = "default-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
const REMOTE_VIEWER = { ...VIEWER, access: { local: false } };

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

// The real entry makes a loopback browser with no session a viewer, so each test states its role.
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
  // The classic page is served from disk with the headers /billing/classic sends once owner-gated.
  await context.route((url) => url.pathname === "/billing/classic", guarded(async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "content-security-policy": BILLING_CLASSIC_CSP, "x-frame-options": "SAMEORIGIN" },
      body: fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "service-entry", "billing.html"), "utf8"),
    });
  }));
  await context.route((url) => !/^\/(api|c|gateway)\//.test(url.pathname) && url.pathname !== "/billing/classic", guarded(async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.fallback();
      return;
    }
    // The entry's admin guard answers /billing without a paired session with its static pairing
    // page, so the shell is fetched from /overview and served under /billing (the SPA reads
    // location.pathname). The server's own gate is covered by service-entry's console-routes tests.
    const asBilling = new URL(route.request().url()).pathname === "/billing";
    const response = await route.fetch(asBilling ? { url: `${entry.url}overview` } : undefined);
    const body = (await response.text()).replace(BOOTSTRAP_BLOCK, (match, open, json, close) => (
      `${open}${JSON.stringify(merge(JSON.parse(json), patch)).replace(/</g, "\u003c")}${close}`));
    await route.fulfill({ response, body });
  }));
}

async function newPage(browser, { bootstrap = OWNER, theme = "light", locale = "en-US" } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: theme, locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, { features: { platform: true }, ...bootstrap });
  const page = await context.newPage();
  const failures = await collectFailures(page);
  await mockConsoleApi(page, {
    "GET /api/status": fixture("status"),
    "GET /api/fleet": fixture("fleet"),
    "GET /api/platform/status": fixture("platform-status"),
    "GET /api/session": bootstrap.role === "owner" ? fixture("session") : SESSION_UNPAIRED,
  });
  return { context, page, failures };
}

const frame = (page) => page.locator('[data-testid="billing.frame"]');

test("an owner on this machine gets the classic billing page in an iframe, with theme and manager", async ({ browser }) => {
  const { context, page } = await newPage(browser, { theme: "light" });
  try {
    await page.goto(`${entry.url}billing?manager=vllm`);
    await expect(page.locator("#main h1")).toHaveText("Billing");
    await expect(frame(page)).toHaveAttribute("src", "/billing/classic?embed=1&theme=light&manager=vllm");
    await expect(frame(page)).toHaveAttribute("title", "Billing center");
    const inner = page.frameLocator('[data-testid="billing.frame"]');
    await expect(inner.locator("html")).toHaveAttribute("data-embed", "1");
    await expect(inner.locator("html")).toHaveAttribute("data-theme", "light");
    // The copied sidebar and theme select are hidden: the console provides them.
    await expect(inner.locator(".manager-sidebar")).toBeHidden();
    await expect(inner.locator("#billingThemeMode")).toBeHidden();
    await expectNoOverflow(page);
  } finally {
    await context.close();
  }
});

test("a theme change reloads the iframe with ?theme=", async ({ browser }) => {
  const { context, page } = await newPage(browser, { theme: "light" });
  try {
    await page.goto(`${entry.url}billing`);
    await expect(frame(page)).toHaveAttribute("src", "/billing/classic?embed=1&theme=light");
    const inner = page.frameLocator('[data-testid="billing.frame"]');
    await expect(inner.locator("html")).toHaveAttribute("data-theme", "light");
    const loads = [];
    page.on("framenavigated", (frameInfo) => {
      if (frameInfo.url().includes("/billing/classic")) loads.push(frameInfo.url());
    });
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("Switch theme");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(frame(page)).toHaveAttribute("src", "/billing/classic?embed=1&theme=dark");
    await expect(inner.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(loads.some((url) => url.includes("theme=dark"))).toBe(true);
  } finally {
    await context.close();
  }
});

test("everyone but a local owner gets an EmptyState and no iframe", async ({ browser }) => {
  // An owner whose bootstrap says the browser is not on this machine: the page's own EmptyState.
  const remoteOwner = { ...OWNER, access: { local: false } };
  for (const [bootstrap, locale, title] of [
    [remoteOwner, "en-US", "Billing administration is local-only"],
    [remoteOwner, "zh-CN", "计费管理仅限本机"],
  ]) {
    const { context, page } = await newPage(browser, { bootstrap, locale });
    try {
      await page.goto(`${entry.url}billing`);
      await expect(page.locator('[data-testid="billing.local-only"] h2')).toHaveText(title);
      await expect(page.locator("iframe")).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
  // A viewer on another machine gets the shell's owner-only EmptyState.
  const remote = await newPage(browser, { bootstrap: REMOTE_VIEWER });
  try {
    await remote.page.goto(`${entry.url}billing`);
    await expect(remote.page.locator('[data-testid="forbidden.root"] [data-testid="empty-state.title"]')).toHaveText("Owner only, on this machine");
    await expect(remote.page.locator("iframe")).toHaveCount(0);
  } finally {
    await remote.context.close();
  }
  // A viewer on this machine is asked to pair first.
  const local = await newPage(browser, { bootstrap: VIEWER });
  try {
    await local.page.goto(`${entry.url}billing`);
    await expect(local.page.locator("iframe")).toHaveCount(0);
    await expect(local.page.locator("#main h1")).not.toHaveText("Billing");
  } finally {
    await local.context.close();
  }
});
