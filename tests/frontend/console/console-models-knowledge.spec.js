// CON-29 browser checks (07 §13.2 console-models, part 3): the Knowledge page.
//
// The status panel lists the layers and files of every domain, marks an invalid
// file (`models.knowledge.status.invalid`) and a stale one, and entries show
// their layer. Import previews the diff and writes only after a second
// confirmation that sends the previewed sha256. Deleting a pack asks first and
// sends `x-confirm: delete`. A per-model override PUT that answers 422 renders
// the field errors next to the fields. The real service-entry serves the
// console; the API is mocked in the browser (helpers/console-harness.js).
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
const RAW_KEY = /\bmodels\.knowledge\.[A-Za-z]/;
const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER = {
  role: "owner",
  auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" },
  features: { engines: true, platform: true, hub: true, models: true },
};
const CARD = "mc_aaaaaaaaaaaaaaaaaaaa";
const SHA = "a1".repeat(32);

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

function statusBody(state = {}) {
  const packFiles = state.packDeleted ? [] : [
    { name: "packs/community@0123456789ab.json", kind: "families", entries: 2, errors: [], warnings: [], asOf: "2026-10-01", staleAfterDays: 120, ageDays: 15, stale: false },
  ];
  return {
    ok: true,
    digest: "sha256:1",
    managers: [{ managerId: "vllm", ok: true }, { managerId: "llama", ok: false, code: "manager_unreachable" }],
    domains: [
      {
        domain: "models",
        layers: [
          { layer: "bundled", path: "<bundled>", files: [
            { name: "families.json", kind: "families", entries: 12, errors: [], warnings: [], asOf: "2026-10-14", staleAfterDays: 120, ageDays: 2, stale: false },
            { name: "template-signatures.json", kind: "template-signatures", entries: 4, errors: [], warnings: [], asOf: "2026-01-01", staleAfterDays: 90, ageDays: 288, stale: true },
          ] },
          { layer: "pack", path: "<AI_ROOT>/config/knowledge.d/packs", files: packFiles },
          { layer: "user", path: "<AI_ROOT>/config/knowledge.d", files: [
            { name: "families.json", kind: "families", entries: 0, errors: [{ entryId: "my-family", code: "schema_violation", message: "/engines/vllm/support must be one of verified, documented, community" }], warnings: [], asOf: "2026-10-10", staleAfterDays: null, ageDays: 6, stale: false },
          ] },
        ],
        errors: [{ layer: "user", file: "families.json", entryId: "my-family", code: "schema_violation", message: "/engines/vllm/support must be one of verified, documented, community", severity: "error" }],
        digest: "sha256:1",
        staleFiles: ["<bundled>/template-signatures.json"],
      },
      { domain: "engines", layers: [], errors: [], unavailable: true },
    ],
  };
}

const ENTRIES = {
  families: [
    { id: "qwen3.8", label: { zh: "通义千问 3.8", en: "Qwen3.8" }, layer: "bundled", file: "families.json", overrides: [], matches: [CARD], heuristicHits: 3 },
    { id: "my-family", label: { zh: "我的家族", en: "My family" }, layer: "user", file: "families.json", overrides: [], matches: [], heuristicHits: 0 },
    { id: "community-a", label: { zh: "社区 A", en: "Community A" }, layer: "pack", file: "packs/community@0123456789ab.json", overrides: [], matches: [], heuristicHits: 0 },
  ],
  "template-signatures": [{ id: "qwen38-xml-effort", label: { zh: "Qwen XML", en: "Qwen XML" }, layer: "bundled", file: "template-signatures.json", overrides: [], matches: [CARD], heuristicHits: 0 }],
  "error-signatures": [{ id: "transformers-unknown-arch", title: { zh: "不认识模型类型", en: "Unknown model type" }, layer: "bundled", file: "error-signatures.json", overrides: [], heuristicHits: 1 }],
};

function knowledgeApi(state = {}) {
  return {
    "GET /api/knowledge/status": () => statusBody(state),
    "GET /api/knowledge": (request) => {
      const kind = new URL(request.url()).searchParams.get("kind") || "families";
      return { ok: true, kind, entries: ENTRIES[kind] || [] };
    },
    "POST /api/knowledge/reload": () => ({ ok: true, digest: "sha256:2" }),
  };
}

async function newPage(browser, { api = {}, size = SIZES.desktop, theme = "light", locale = "en-US", state = {} } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce" });
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
    ...knowledgeApi(state),
    ...api,
  });
  return { context, page, mock, failures };
}

// The mocks answer 404 on purpose for what a page does not need.
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));
const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const callsTo = (mock, method, prefix) => mock.calls.filter((call) => call.method === method && call.path.startsWith(prefix));

async function openKnowledge(page, search = "") {
  await page.goto(`${entry.url}models/knowledge${search}`);
  await expect(byId(page, "knowledge")).toBeVisible();
  await expect(byId(page, "knowledge.files").first()).toBeVisible();
}

// ---------------------------------------------------------------------------
// Status and entries

test("the status panel lists layers and files, marks an invalid file and a stale file, and says which domain is not available", async ({ browser }) => {
  const { context, page, failures } = await newPage(browser);
  try {
    await openKnowledge(page);
    const models = page.locator('[data-testid="knowledge.domain"][data-domain="models"]');
    await expect(models.locator('[data-testid="knowledge.file"]')).toHaveCount(4);
    await expect(models.locator('[data-layer="bundled"]')).toHaveCount(2);
    await expect(models.locator('[data-layer="pack"]')).toHaveCount(1);
    await expect(models.locator('[data-layer="user"]')).toHaveCount(1);
    const invalid = models.locator('[data-testid="knowledge.file"][data-state="invalid"]');
    await expect(invalid).toHaveCount(1);
    await expect(invalid.locator('[data-testid="knowledge.file.invalid"]')).toContainText("Invalid");
    await expect(invalid).toContainText("/engines/vllm/support must be one of");
    const stale = models.locator('[data-testid="knowledge.file"][data-state="stale"]');
    await expect(stale).toHaveCount(1);
    await expect(stale.locator('[data-testid="knowledge.file.stale"]')).toContainText("Stale (288 days old)");
    await expect(byId(page, "knowledge.problems")).toContainText("my-family");
    await expect(page.locator('[data-testid="knowledge.domain"][data-domain="engines"]')).toContainText("Not available");
    await expect(byId(page, "knowledge.status.managers")).toContainText("llama");
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("entries show their layer and matched cards in three tabs, and the search narrows the request", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await openKnowledge(page);
    const rows = byId(page, "knowledge.entry");
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "Qwen3.8" }).locator('[data-testid="knowledge.entry.layer"]')).toHaveText("Built in");
    await expect(rows.filter({ hasText: "My family" }).locator('[data-testid="knowledge.entry.layer"]')).toHaveText("Your files");
    await expect(rows.filter({ hasText: "Community A" }).locator('[data-testid="knowledge.entry.layer"]')).toHaveText("Imported pack");
    await expect(rows.filter({ hasText: "Qwen3.8" }).locator('[data-testid="knowledge.entry.matches"]')).toContainText(CARD);
    const first = mock.calls.find((call) => call.method === "GET" && call.path === "/api/knowledge");
    expect(first.query).toMatchObject({ kind: "families", withMatches: "1" });

    await page.getByRole("tab", { name: "Error signatures" }).click();
    await expect(byId(page, "knowledge.entry")).toHaveCount(1);
    await expect(byId(page, "knowledge.entry")).toContainText("Unknown model type");
    await page.getByRole("tab", { name: "Template signatures" }).click();
    await expect(byId(page, "knowledge.entry")).toContainText("qwen38-xml-effort");

    await byId(page, "knowledge.search").fill("qwen");
    await expect.poll(() => callsTo(mock, "GET", "/api/knowledge").some((call) => call.query.q === "qwen")).toBe(true);
  } finally {
    await context.close();
  }
});

test("Reload posts to /api/knowledge/reload", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await openKnowledge(page);
    await byId(page, "knowledge.reload").click();
    await expect.poll(() => callsTo(mock, "POST", "/api/knowledge/reload").length).toBe(1);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Import

const PACK_TEXT = JSON.stringify({ schemaVersion: 2, kind: "families", pack: { id: "community" }, entries: [{ id: "new-family" }, { id: "qwen3.8" }] });

test("import previews the diff first and writes only after Confirm import, which sends the previewed sha256", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: {
      "POST /api/knowledge/import": (request) => {
        const body = request.postDataJSON();
        const diff = { added: ["new-family"], replaced: ["qwen3.8"], deleted: ["old-family"], invalidEntries: [{ entryId: "bad", code: "schema_violation", message: "bad entry" }] };
        if (body.confirm === true) return { ok: true, packId: "community", sha256: body.sha256, kind: "families", diff, digest: "sha256:3" };
        return { ok: true, packId: "community", sha256: SHA, kind: "families", bytes: PACK_TEXT.length, diff };
      },
    },
  });
  try {
    await openKnowledge(page);
    await byId(page, "knowledge.import.open").click();
    await expect(byId(page, "knowledge.import")).toBeVisible();
    await expect(byId(page, "knowledge.import.confirm")).toHaveCount(0);
    await byId(page, "knowledge.import.mode-content").click();
    await byId(page, "knowledge.import.input").fill(PACK_TEXT);
    await byId(page, "knowledge.import.preview").click();

    await expect(byId(page, "knowledge.import.diff")).toBeVisible();
    await expect(byId(page, "knowledge.import.sha")).toHaveText(SHA);
    const rows = byId(page, "knowledge.import.diff-table").locator('[data-testid="diff-table.row"]');
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "new-family" })).toContainText("New entry");
    await expect(rows.filter({ hasText: "old-family" })).toContainText("In use");
    await expect(byId(page, "knowledge.import.invalid")).toContainText("bad entry");
    const writes = () => callsTo(mock, "POST", "/api/knowledge/import");
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body).toEqual({ content: PACK_TEXT });

    // Editing the pack discards the preview: the old sha256 can no longer be confirmed.
    await byId(page, "knowledge.import.input").fill(`${PACK_TEXT} `);
    await expect(byId(page, "knowledge.import.diff")).toHaveCount(0);
    await expect(byId(page, "knowledge.import.confirm")).toHaveCount(0);
    await byId(page, "knowledge.import.preview").click();
    await expect(byId(page, "knowledge.import.confirm")).toBeVisible();
    expect(writes()).toHaveLength(2);

    await byId(page, "knowledge.import.confirm").click();
    await expect(byId(page, "knowledge.import")).toHaveCount(0);
    expect(writes()).toHaveLength(3);
    expect(writes()[2].body).toEqual({ content: `${PACK_TEXT} `, confirm: true, sha256: SHA });
  } finally {
    await context.close();
  }
});

test("an import from a URL sends the URL; a rejected pack shows its field errors and offers no confirmation", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: {
      "POST /api/knowledge/import": () => ({ status: 400, body: { ok: false, error: { code: "pack_invalid", message: "The pack is not a valid knowledge file." }, errors: [{ field: "kind", code: "unknown_kind", message: "kind is missing or unknown." }] } }),
    },
  });
  try {
    await openKnowledge(page);
    await byId(page, "knowledge.import.open").click();
    await byId(page, "knowledge.import.input").fill("https://example.test/pack.json");
    await byId(page, "knowledge.import.preview").click();
    await expect(byId(page, "knowledge.import.error")).toBeVisible();
    await expect(byId(page, "knowledge.import.errors")).toContainText("kind is missing or unknown.");
    await expect(byId(page, "knowledge.import.confirm")).toHaveCount(0);
    expect(callsTo(mock, "POST", "/api/knowledge/import")[0].body).toEqual({ url: "https://example.test/pack.json" });
    expect(callsTo(mock, "POST", "/api/knowledge/import").every((call) => call.body.confirm !== true)).toBe(true);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Pack delete

test("deleting a pack asks first, then sends DELETE with x-confirm: delete; only imported packs offer Delete", async ({ browser }) => {
  const state = { packDeleted: false };
  const { context, page, mock } = await newPage(browser, {
    state,
    api: {
      "DELETE /api/knowledge/packs/community": () => {
        state.packDeleted = true;
        return { ok: true };
      },
    },
  });
  try {
    await openKnowledge(page);
    await expect(byId(page, "knowledge.pack.delete")).toHaveCount(1);
    await byId(page, "knowledge.pack.delete").click();
    const dialog = byId(page, "knowledge.pack.confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("community");
    await dialog.locator('[data-testid="dialog.cancel"]').click();
    await expect(dialog).toBeHidden();
    expect(callsTo(mock, "DELETE", "/api/knowledge/packs")).toHaveLength(0);

    await byId(page, "knowledge.pack.delete").click();
    await dialog.locator('[data-testid="dialog.confirm"]').click();
    await expect.poll(() => callsTo(mock, "DELETE", "/api/knowledge/packs/community").length).toBe(1);
    expect(callsTo(mock, "DELETE", "/api/knowledge/packs/community")[0].headers["x-confirm"]).toBe("delete");
    await expect(byId(page, "knowledge.pack.delete")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Per-model override

test("a per-model override that answers 422 shows each field error next to its field, then saves once fixed", async ({ browser }) => {
  let attempt = 0;
  const { context, page, mock } = await newPage(browser, {
    api: {
      [`PUT /api/knowledge/overrides/models/${CARD}`]: () => {
        attempt += 1;
        if (attempt === 1) {
          return { status: 422, body: { ok: false, error: { code: "invalid_override", message: "The override is not valid." }, errors: [
            { field: "id", code: "required", message: "Name the family entry to override." },
            { field: "contextMax", code: "type", message: "/contextMax must be an integer" },
          ] } };
        }
        return { ok: true, file: "<AI_ROOT>/config/knowledge.d/models/mc.json" };
      },
    },
  });
  try {
    await openKnowledge(page, `?override=${CARD}`);
    await expect(byId(page, "knowledge.override")).toBeVisible();
    await expect(byId(page, "knowledge.override.card")).toHaveValue(CARD);
    await byId(page, "knowledge.override.json").fill('{ "contextMax": "big" }');
    await byId(page, "knowledge.override.save").click();

    await expect(byId(page, "knowledge.override.id-field").locator('[data-testid="form-field.error"]')).toContainText("Name the family entry to override.");
    await expect(byId(page, "knowledge.override.fields-field").locator('[data-testid="form-field.error"]')).toBeVisible();
    await expect(byId(page, "knowledge.override.errors")).toContainText("/contextMax must be an integer");
    expect(callsTo(mock, "PUT", "/api/knowledge/overrides/models/")[0].body).toEqual({ contextMax: "big" });

    await byId(page, "knowledge.override.id").fill("qwen3.8");
    await byId(page, "knowledge.override.json").fill('{ "contextMax": 65536 }');
    await byId(page, "knowledge.override.save").click();
    await expect(byId(page, "knowledge.override")).toHaveCount(0);
    expect(callsTo(mock, "PUT", "/api/knowledge/overrides/models/")[1].body).toEqual({ contextMax: 65536, id: "qwen3.8" });
  } finally {
    await context.close();
  }
});

test("text that is not a JSON object is refused before anything is sent", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await openKnowledge(page, `?override=${CARD}`);
    await byId(page, "knowledge.override.json").fill("[1, 2");
    await byId(page, "knowledge.override.save").click();
    await expect(byId(page, "knowledge.override.fields-field").locator('[data-testid="form-field.error"]')).toContainText("not a JSON object");
    expect(callsTo(mock, "PUT", "/api/knowledge/overrides/models/")).toHaveLength(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Copy, size, accessibility

for (const locale of ["en-US", "zh-CN"]) {
  test(`every key of the Knowledge page renders in ${locale}, nothing overflows at 390 px, axe is clean in both themes`, async ({ browser }) => {
    for (const theme of ["light", "dark"]) {
      const size = theme === "dark" ? SIZES.phone : SIZES.desktop;
      const { context, page, failures } = await newPage(browser, { locale, theme, size });
      try {
        await openKnowledge(page);
        await expect(byId(page, "knowledge.entry").first()).toBeVisible();
        const text = await page.locator("#main").innerText();
        expect(text, `${locale} shows a raw key`).not.toMatch(RAW_KEY);
        if (locale === "en-US") expect(text.replace(/\s+/g, " "), "Han text in English").not.toMatch(HAN);
        else expect(text).toMatch(HAN);
        await expectNoOverflow(page);
        await expectNoA11yViolations(page, { label: `knowledge ${locale} ${theme}` });
        await byId(page, "knowledge.import.open").click();
        await expect(byId(page, "knowledge.import")).toBeVisible();
        expect(await byId(page, "knowledge.import").innerText()).not.toMatch(RAW_KEY);
        await expectNoA11yViolations(page, { label: `knowledge import ${locale} ${theme}` });
        expect(realFailures(failures)).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
}
