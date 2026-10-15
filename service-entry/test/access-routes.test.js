"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const deployTemplates = require("../lib/deploy-templates");
const keyMigration = require("../lib/key-migration");
const { PRESETS, createAccessRoutes } = require("../lib/access-routes");
const { loadAccessConfig } = require("../lib/public-config");
const { createRequestAuth } = require("../lib/request-auth");
const { cookiePair, fakeRequest, makeAdminAuth, reply } = require("./helpers/admin-auth-fixture");
const { loadEntry, ownerSession, quietLogger, request, serveEntry } = require("./helpers/entry-harness");

// Admin access APIs (05 §13.1, PUB-18). The routes run over the real admin
// auth (sessions, CSRF, machine principals) and a real in-memory access
// store; settings and the legacy files are fakes.

const MISSING_ID = "k_aaaaaaaaaaaaaaaaaaaa";
const CUSTOMER_ID = "0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e";

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function makeSettings(start = {}) {
  const state = { etag: "e1", values: { listeners: { public: { port: 5186, baseUrl: "https://api.example.com" } }, ...start }, writes: [] };
  return {
    state,
    readSection(name) {
      return { values: state.values[name] || {}, sources: {}, etag: state.etag, errors: [], warnings: [] };
    },
    async writeSection(name, patch, options = {}) {
      if (options.etag !== state.etag) {
        return { ok: false, status: 409, code: "config_conflict", error: { code: "config_conflict", message: "The settings changed since you loaded them; reload and try again." }, etag: state.etag, changed: [], restartRequired: [], errors: [] };
      }
      state.writes.push({ name, patch, actor: options.actor });
      state.etag = `e${state.writes.length + 1}`;
      return { ok: true, etag: state.etag, changed: Object.keys(patch).map((key) => `${name}.${key}`), restartRequired: name === "listeners" ? ["entry"] : [], errors: [] };
    },
  };
}

function legacyClient(id, name, secret) {
  return { id, name, enabled: true, keyHash: sha256(secret), allowedModels: [], createdAt: "2026-08-01T00:00:00.000Z", usage: {} };
}

function makeHarness(options = {}) {
  const fixture = makeAdminAuth();
  const settings = options.settings || makeSettings();
  const files = { "service-clients.json": JSON.stringify({ version: 1, clients: [legacyClient("alice", "Alice laptop", "fake-legacy-secret-alice-0001")] }) };
  const managers = [{ id: "vllm", billingId: "vllm-manager", root: "<MANAGER_ROOT>" }];
  const readFile = async (file) => {
    const name = file.split(/[\\/]/).pop();
    if (files[name] === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return files[name];
  };
  const migration = {
    plan: () => keyMigration.planLegacyKeyMigration({ store: fixture.store, managers, bindings: [], readFile }),
    apply: () => keyMigration.runKeyMigration({ store: fixture.store, managers, bindings: [], readFile, force: true, actor: "migration" }),
  };
  const events = [];
  const auth = createRequestAuth({
    security: { checkManagementAccess: () => ({ ok: false }) },
    adminAuth: fixture.auth,
    logger: { warn() {}, error() {} },
  });
  const config = () => loadAccessConfig({ readSection: settings.readSection });
  const routes = createAccessRoutes({
    auth,
    sendJson: (res, data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    },
    readJsonObjectBody: async (req) => req.jsonBody || {},
    getStore: () => (options.noStore ? null : fixture.store),
    getSecurity: () => ({ accessConfig: config, refreshAccessConfig: () => {} }),
    getBus: () => ({ publish: (type, data) => events.push({ type, data }) }),
    migration,
    settings,
    aiRoot: options.aiRoot || "",
    logger: { warn() {}, error() {}, log() {} },
    now: () => fixture.clock.now,
  });
  const code = fixture.auth.mintPairCode({ actor: "test" }).code;
  const paired = fixture.auth.pairWithCode(fakeRequest({ method: "POST", url: "/api/session/pair" }), code);
  assert.equal(paired.ok, true);
  const session = { cookie: cookiePair(paired.setCookie), csrfToken: paired.csrfToken };

  // who: "owner" (session plus CSRF), "no-csrf", "viewer", "cli".
  async function call(method, path, { body, who = "owner", headers = {} } = {}) {
    const req = fakeRequest({
      method,
      url: path,
      headers: {
        ...(who === "owner" || who === "no-csrf" ? { cookie: session.cookie } : {}),
        ...(who === "owner" && method !== "GET" ? { "x-csrf-token": session.csrfToken } : {}),
        ...headers,
      },
    });
    if (who === "cli") fixture.machineAuth.remember(req, "system:cli");
    if (body !== undefined) req.jsonBody = body;
    const res = reply();
    const handled = await routes.handle(req, res, new URL(path, "http://127.0.0.1:5176"));
    return { handled, status: res.status, json: res.json, text: res.body };
  }
  return { fixture, store: fixture.store, settings, events, call, files };
}

function createFriend(h, extra = {}) {
  return h.call("POST", "/api/access/keys", { body: { preset: "friend", name: "Alice laptop", holder: "Alice", ...extra } });
}

// --- authorization -----------------------------------------------------------------

test("every route needs the owner: a viewer reads nothing, a write needs the CSRF token, system:cli needs neither", async () => {
  const h = makeHarness();
  const reads = ["/api/access/keys", "/api/access/presets", "/api/access/migration", "/api/access/audit", "/api/public/settings", "/api/public/announcements", "/api/public/models/m1/meta"];
  for (const path of reads) {
    const viewer = await h.call("GET", path, { who: "viewer" });
    assert.equal(viewer.status, 403, path);
    assert.equal(viewer.json.error.code, "owner_required", path);
    const owner = await h.call("GET", path);
    assert.equal(owner.status, 200, path);
    const cli = await h.call("GET", path, { who: "cli" });
    assert.equal(cli.status, 200, path);
  }
  const writes = [
    ["POST", "/api/access/keys", { preset: "friend", name: "x" }],
    ["PATCH", "/api/access/keys/k_x", { name: "y" }],
    ["POST", "/api/access/keys/k_x/rotate", {}],
    ["POST", "/api/access/keys/k_x/revoke", { confirmName: "x" }],
    ["POST", "/api/access/keys/bulk-revoke", { keyIds: ["k_x"], confirm: "REVOKE 1" }],
    ["POST", "/api/access/migration/plan", {}],
    ["POST", "/api/access/migration/apply", { confirm: true }],
    ["PATCH", "/api/public/settings", { section: "public", patch: {} }],
    ["POST", "/api/public/announcements", {}],
    ["PATCH", "/api/public/announcements/an_x", {}],
    ["DELETE", "/api/public/announcements/an_x", undefined],
    ["PUT", "/api/public/models/m1/meta", {}],
  ];
  const before = h.store.listAudit({ limit: 200 }).items.length;
  for (const [method, path, body] of writes) {
    const noToken = await h.call(method, path, { body, who: "no-csrf" });
    assert.equal(noToken.status, 403, `${method} ${path}`);
    assert.equal(noToken.json.error.code, "csrf_invalid", `${method} ${path}`);
    const viewer = await h.call(method, path, { body, who: "viewer" });
    assert.ok([401, 403].includes(viewer.status), `${method} ${path} -> ${viewer.status}`);
    assert.equal(viewer.json.ok, false);
  }
  assert.equal(h.store.listAudit({ limit: 200 }).items.length, before, "refused calls change and audit nothing");
  const cli = await h.call("POST", "/api/access/keys", { body: { preset: "friend", name: "From the CLI" }, who: "cli" });
  assert.equal(cli.status, 201);
  assert.equal(h.store.listAudit({ action: "key.create" }).items[0].actor, "system:cli");
});

test("paths other packages own fall through, and an unsupported method on a served path answers 405", async () => {
  const h = makeHarness();
  const unowned = await h.call("GET", "/api/public/nothing-owned-here");
  assert.equal(unowned.handled, false);
  assert.equal((await h.call("GET", "/api/status")).handled, false);
  const wrong = await h.call("DELETE", "/api/access/keys/k_x");
  assert.equal(wrong.status, 405);
  const viewerWrong = await h.call("DELETE", "/api/access/presets", { who: "viewer" });
  assert.ok([401, 403].includes(viewerWrong.status), "a viewer learns nothing about the method table");
  assert.equal(viewerWrong.json.error.code === "method_not_allowed", false);
});

test("an unavailable access store answers 503 and never an empty list", async () => {
  const h = makeHarness({ noStore: true });
  const list = await h.call("GET", "/api/access/keys");
  assert.equal(list.status, 503);
  assert.equal(list.json.error.code, "access_store_unavailable");
});

// --- keys ----------------------------------------------------------------------------

test("create returns the secret once with the share block, applies the preset and audits without the secret", async () => {
  const h = makeHarness();
  h.store.upsertModelMeta("qwen3.8-35b", { recommended: true });
  const created = await createFriend(h);
  assert.equal(created.status, 201);
  const { key, secret, share } = created.json;
  assert.match(secret, /^sk-plat-/);
  assert.equal(key.class, "friend");
  assert.equal(key.limits.rpm, 30);
  assert.equal(key.limits.dailyTokens, 2_000_000);
  assert.deepEqual(key.labels, { preset: "friend" });
  assert.equal(key.expiresAt, new Date(h.fixture.clock.now + 90 * 86_400_000).toISOString());
  assert.deepEqual(key.listeners, ["public"]);
  assert.equal(share.openaiBase, "https://api.example.com/v1");
  assert.equal(share.anthropicBase, "https://api.example.com/anthropic");
  assert.equal(share.portalUrl, "https://api.example.com/");
  assert.equal(share.recommendedModel, "qwen3.8-35b");
  assert.ok(share.snippetCurl.includes(secret) && share.snippetCurl.includes("qwen3.8-35b"));

  // The secret is returned once: no read, list, audit row or rotation-less update repeats it.
  const everything = [
    (await h.call("GET", `/api/access/keys/${key.id}`)).text,
    (await h.call("GET", "/api/access/keys")).text,
    (await h.call("GET", "/api/access/audit")).text,
    (await h.call("PATCH", `/api/access/keys/${key.id}`, { body: { notes: "hello" } })).text,
    JSON.stringify(h.events),
  ].join("\n");
  assert.equal(everything.includes(secret), false);
  assert.equal(everything.includes(sha256(secret)), false);
  const audit = h.store.listAudit({ action: "key.create" }).items[0];
  assert.equal(audit.targetId, key.id);
  assert.match(audit.actor, /^session:/);
});

test("a request overrides the preset, an unknown preset and a paid preset without a customer are field errors", async () => {
  const h = makeHarness();
  const custom = await createFriend(h, { limits: { rpm: 5 }, expiresAt: null, listeners: ["public", "admin"] });
  assert.equal(custom.status, 201);
  assert.equal(custom.json.key.limits.rpm, 5);
  assert.equal(custom.json.key.limits.tpm, 100_000, "the rest of the preset's limits stay");
  assert.equal(custom.json.key.expiresAt, null);

  const unknown = await h.call("POST", "/api/access/keys", { body: { preset: "vip", name: "x" } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, "invalid_field");
  assert.equal(unknown.json.errors[0].field, "preset");

  const noCustomer = await h.call("POST", "/api/access/keys", { body: { preset: "paid", name: "Dave Co" } });
  assert.equal(noCustomer.status, 400);
  assert.equal(noCustomer.json.errors[0].field, "customerId");
  const paid = await h.call("POST", "/api/access/keys", { body: { preset: "paid", name: "Dave Co", customerId: CUSTOMER_ID } });
  assert.equal(paid.status, 201);
  assert.equal(paid.json.key.class, "customer");
  assert.ok(paid.json.key.scopes.includes("audio.speech"));

  const invalid = await h.call("POST", "/api/access/keys", { body: { preset: "friend", name: "x", scopes: ["admin.everything"] } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.errors[0].field, "scopes");
  const bare = await h.call("POST", "/api/access/keys", { body: { name: "No preset", class: "friend", scopes: ["models.read", "chat"], models: ["*"] } });
  assert.equal(bare.status, 201, "a key can be created without a preset");
});

test("presets match the table of 05 §6.6 and carry i18n keys", async () => {
  const h = makeHarness();
  const { json } = await h.call("GET", "/api/access/presets");
  assert.deepEqual(json.presets.map((preset) => preset.id), ["friend", "trial-7d", "paid", "internal-app", "owner-device"]);
  const byId = Object.fromEntries(json.presets.map((preset) => [preset.id, preset]));
  assert.equal(byId["trial-7d"].limits.rpm, 10);
  assert.equal(byId["trial-7d"].expiresInDays, 7);
  assert.deepEqual(byId["trial-7d"].scopes, ["models.read", "self.read", "chat", "messages"]);
  assert.equal(byId.paid.requiresCustomer, true);
  assert.equal(byId.paid.limits.maxOutputTokens, 16384);
  assert.equal(byId["internal-app"].limits.maxConcurrent, 16);
  assert.equal(byId["owner-device"].scopes.includes("debug.route"), true);
  assert.equal(byId.friend.labelKey, "access.preset.friend.title");
  assert.equal(PRESETS.length, 5);
});

test("list filters, pages and counts; get returns usage; patch validates with field errors", async () => {
  const h = makeHarness();
  const ids = [];
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    ids.push((await createFriend(h, { name })).json.key.id);
    h.fixture.clock.now += 1000;
  }
  await h.call("POST", "/api/access/keys", { body: { preset: "trial-7d", name: "Trialist" } });
  const page = await h.call("GET", "/api/access/keys?limit=2");
  assert.equal(page.json.items.length, 2);
  assert.ok(page.json.nextCursor);
  assert.equal(page.json.counts.total, 4);
  const next = await h.call("GET", `/api/access/keys?limit=2&cursor=${encodeURIComponent(page.json.nextCursor)}`);
  assert.equal(next.json.items.length, 2);
  assert.equal((await h.call("GET", "/api/access/keys?class=trial")).json.items.length, 1);
  assert.equal((await h.call("GET", "/api/access/keys?q=gam")).json.items[0].name, "Gamma");
  assert.equal((await h.call("GET", "/api/access/keys?expiring=10")).json.items.length, 1, "only the 7-day trial expires within 10 days");
  assert.equal((await h.call("GET", "/api/access/keys?limit=0")).status, 400);
  assert.equal((await h.call("GET", "/api/access/keys?status=bogus")).json.error.code, "invalid_field");

  h.store.addUsage(ids[0], { requests: 3, inputTokens: 10, outputTokens: 20, at: h.fixture.clock.now });
  const detail = await h.call("GET", `/api/access/keys/${ids[0]}`);
  assert.equal(detail.json.key.id, ids[0]);
  assert.equal(detail.json.usage.day.requests, 3);
  assert.ok(detail.json.usage.month);
  assert.equal((await h.call("GET", `/api/access/keys/${MISSING_ID}`)).status, 404);

  const patched = await h.call("PATCH", `/api/access/keys/${ids[0]}`, { body: { holder: "Zed", limits: { rpm: 12 } } });
  assert.equal(patched.json.key.holder, "Zed");
  assert.equal(patched.json.key.limits.rpm, 12);
  const bad = await h.call("PATCH", `/api/access/keys/${ids[0]}`, { body: { limits: { rpm: -3 }, id: "k_other" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "invalid_field");
  assert.ok(bad.json.errors.some((item) => item.field === "limits.rpm"));
  assert.ok(bad.json.errors.some((item) => item.field === "id"));
  assert.equal((await h.call("PATCH", `/api/access/keys/${MISSING_ID}`, { body: { holder: "x" } })).status, 404);
});

test("rotate returns a new secret once, accepts only the listed overlaps, and the old secret dies unless overlapped", async () => {
  const h = makeHarness();
  const created = await createFriend(h);
  const id = created.json.key.id;
  const bad = await h.call("POST", `/api/access/keys/${id}/rotate`, { body: { overlapSeconds: 5 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.errors[0].field, "overlapSeconds");
  const overlapped = await h.call("POST", `/api/access/keys/${id}/rotate`, { body: { overlapSeconds: 3600 } });
  assert.equal(overlapped.status, 200);
  assert.match(overlapped.json.secret, /^sk-plat-/);
  assert.notEqual(overlapped.json.secret, created.json.secret);
  assert.equal(h.store.findBySecret(created.json.secret, h.fixture.clock.now).matched, "previous");
  const plain = await h.call("POST", `/api/access/keys/${id}/rotate`, { body: {} });
  assert.equal(h.store.findBySecret(overlapped.json.secret, h.fixture.clock.now), null, "overlap defaults to none");
  assert.equal(h.store.findBySecret(plain.json.secret, h.fixture.clock.now).matched, "current");
  assert.equal(JSON.stringify(h.store.listAudit({ limit: 200 })).includes(plain.json.secret), false);
});

test("revoke needs the typed name and bulk revoke needs REVOKE n; both are audited", async () => {
  const h = makeHarness();
  const ids = [];
  for (const name of ["One", "Two", "Three"]) ids.push((await createFriend(h, { name })).json.key.id);

  const missing = await h.call("POST", `/api/access/keys/${ids[0]}/revoke`, { body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, "confirm_required");
  const wrong = await h.call("POST", `/api/access/keys/${ids[0]}/revoke`, { body: { confirmName: "one" } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error.code, "confirm_mismatch");
  assert.equal(h.store.getKey(ids[0]).status, "active");
  const revoked = await h.call("POST", `/api/access/keys/${ids[0]}/revoke`, { body: { confirmName: "One" } });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.key.status, "revoked");
  assert.equal(h.store.listAudit({ action: "key.revoke", targetId: ids[0] }).items.length, 1);
  assert.equal((await h.call("POST", `/api/access/keys/${MISSING_ID}/revoke`, { body: { confirmName: "x" } })).status, 404);

  const wrongCount = await h.call("POST", "/api/access/keys/bulk-revoke", { body: { keyIds: ids.slice(1), confirm: "REVOKE 3" } });
  assert.equal(wrongCount.status, 400);
  assert.equal(wrongCount.json.error.code, "confirm_mismatch");
  const noConfirm = await h.call("POST", "/api/access/keys/bulk-revoke", { body: { keyIds: ids.slice(1) } });
  assert.equal(noConfirm.status, 400);
  const unknown = await h.call("POST", "/api/access/keys/bulk-revoke", { body: { keyIds: [ids[1], MISSING_ID], confirm: "REVOKE 2" } });
  assert.equal(unknown.status, 404);
  assert.equal(h.store.getKey(ids[1]).status, "active", "nothing is revoked when one id is unknown");
  const empty = await h.call("POST", "/api/access/keys/bulk-revoke", { body: { keyIds: [], confirm: "REVOKE 0" } });
  assert.equal(empty.status, 400);

  const bulk = await h.call("POST", "/api/access/keys/bulk-revoke", { body: { keyIds: ids, confirm: "REVOKE 3" } });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.json.revoked, 2, "the key revoked earlier is not counted again");
  for (const id of ids) assert.equal(h.store.getKey(id).status, "revoked");
  const summary = h.store.listAudit({ action: "key.bulk_revoke" }).items[0];
  assert.equal(summary.details.requested, 3);
  assert.match(summary.actor, /^session:/);
});

// --- migration -----------------------------------------------------------------------

test("migration/plan has no side effects and apply is idempotent", async () => {
  const h = makeHarness();
  const snapshot = () => JSON.stringify({
    keys: h.store.listKeys({ limit: 200 }).items,
    audit: h.store.listAudit({ limit: 200 }).items,
    marker: h.store.getMeta("migration.v1"),
    report: h.store.getMeta("migration.report"),
  });
  const before = snapshot();
  const plan = await h.call("POST", "/api/access/migration/plan", { body: {} });
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.json.plan.inserts, [{ keyId: "vllm.alice", name: "Alice laptop", source: "service-clients" }]);
  assert.ok(Array.isArray(plan.json.plan.skipped));
  assert.ok(Array.isArray(plan.json.plan.warnings));
  assert.equal(plan.text.includes(sha256("fake-legacy-secret-alice-0001")), false, "no hash in the plan");
  assert.equal(snapshot(), before);
  assert.equal((await h.call("POST", "/api/access/migration/plan", { body: {} })).text, plan.text);
  assert.equal((await h.call("GET", "/api/access/migration")).json.report, null);

  const refused = await h.call("POST", "/api/access/migration/apply", { body: {} });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, "confirm_required");
  assert.equal(snapshot(), before);

  const applied = await h.call("POST", "/api/access/migration/apply", { body: { confirm: true } });
  assert.equal(applied.status, 200);
  assert.equal(applied.json.report.counts.inserted, 1);
  assert.equal(h.store.listKeys({ limit: 50 }).items.length, 1);
  assert.equal(h.store.getKey("vllm.alice").class, "friend");
  assert.equal(applied.text.includes(sha256("fake-legacy-secret-alice-0001")), false, "no hash in the report");
  const keysAfter = JSON.stringify(h.store.listKeys({ limit: 50 }).items);

  const again = await h.call("POST", "/api/access/migration/apply", { body: { confirm: true } });
  assert.equal(again.status, 200);
  assert.equal(JSON.stringify(h.store.listKeys({ limit: 50 }).items), keysAfter, "a second apply changes no key");
  assert.equal(h.store.listKeys({ limit: 50 }).items.length, 1);
  const planned = await h.call("POST", "/api/access/migration/plan", { body: {} });
  assert.deepEqual(planned.json.plan.inserts, [], "nothing is left to import");
  assert.equal(planned.json.plan.skipped[0].reason, "key_exists");
  assert.equal((await h.call("GET", "/api/access/migration")).json.report.counts.inserted, 1);
  assert.equal(h.store.listAudit({ action: "migration.apply" }).items.length, 2);
});

// --- audit ---------------------------------------------------------------------------

test("the audit lists newest first with action and target filters and a cursor", async () => {
  const h = makeHarness();
  const a = (await createFriend(h, { name: "A" })).json.key.id;
  const b = (await createFriend(h, { name: "B" })).json.key.id;
  await h.call("PATCH", `/api/access/keys/${a}`, { body: { notes: "n" } });
  const all = await h.call("GET", "/api/access/audit?limit=2");
  assert.equal(all.json.items.length, 2);
  assert.equal(all.json.items[0].action, "key.update");
  assert.ok(all.json.nextCursor);
  const rest = await h.call("GET", `/api/access/audit?limit=50&cursor=${all.json.nextCursor}`);
  assert.ok(rest.json.items.every((item) => item.id < all.json.items[1].id));
  assert.deepEqual((await h.call("GET", "/api/access/audit?action=key.create")).json.items.map((item) => item.targetId).sort(), [a, b].sort());
  assert.equal((await h.call("GET", `/api/access/audit?target=${b}`)).json.items.length, 1);
  assert.equal((await h.call("GET", "/api/access/audit?cursor=abc")).status, 400);
});

// --- settings ------------------------------------------------------------------------

test("settings GET shows the sections, issues and etag; PATCH validates, passes a stale etag through and reports restartRequired", async () => {
  const h = makeHarness();
  const read = await h.call("GET", "/api/public/settings");
  assert.equal(read.json.etag, "e1");
  assert.deepEqual(Object.keys(read.json.config).sort(), ["admin", "exposure", "listeners", "public", "trustedProxies"]);
  assert.equal(read.json.config.listeners.public.port, 5186);
  assert.ok(Array.isArray(read.json.issues));

  const noEtag = await h.call("PATCH", "/api/public/settings", { body: { section: "public", patch: { exposeSearch: true } } });
  assert.equal(noEtag.status, 428);
  assert.equal(noEtag.json.error.code, "etag_required");

  const exposure = await h.call("PATCH", "/api/public/settings", { body: { section: "exposure", patch: { requireApiKey: "on" } }, headers: { "if-match": "e1" } });
  assert.equal(exposure.status, 400, "exposure is read-only here");
  assert.equal((await h.call("PATCH", "/api/public/settings", { body: { patch: {} }, headers: { "if-match": "e1" } })).status, 400);

  const invalid = await h.call("PATCH", "/api/public/settings", { body: { section: "trustedProxies", patch: { cidrs: ["not-a-cidr"] } }, headers: { "if-match": "e1" } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, "config_invalid");
  assert.ok(invalid.json.errors.length >= 1);
  assert.equal(h.settings.state.writes.length, 0, "an invalid patch is not written");

  const saved = await h.call("PATCH", "/api/public/settings", { body: { section: "listeners", patch: { public: { port: 5199 } } }, headers: { "if-match": '"e1"' } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.etag, "e2");
  assert.deepEqual(saved.json.restartRequired, ["entry"]);
  assert.match(h.settings.state.writes[0].actor, /^session:/);
  assert.equal(h.store.listAudit({ action: "settings.update" }).items[0].targetId, "listeners");
  assert.deepEqual(h.events.map((event) => event.type), ["access"]);

  const stale = await h.call("PATCH", "/api/public/settings", { body: { section: "public", patch: { exposeSearch: true } }, headers: { "if-match": "e1" } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "config_conflict");
  assert.equal(stale.json.etag, "e2");

  const live = await h.call("PATCH", "/api/public/settings", { body: { section: "public", patch: { exposeSearch: true } }, headers: { "if-match": "e2" } });
  assert.equal(live.status, 200);
  assert.deepEqual(live.json.restartRequired, []);
  const cli = await h.call("PATCH", "/api/public/settings", { body: { section: "admin", patch: { gatewayRpm: 300 } }, headers: { "if-match": "e3" }, who: "cli" });
  assert.equal(cli.status, 200);
  assert.equal(h.settings.state.writes.at(-1).actor, "system:cli");
});

// --- announcements and model meta ----------------------------------------------------

test("announcements are created, listed with drafts, updated and deleted; invalid input is a field error", async () => {
  const h = makeHarness();
  const created = await h.call("POST", "/api/public/announcements", { body: { severity: "maintenance", title: { zh: "维护", en: "Maintenance" }, body: { zh: "今晚", en: "Tonight" } } });
  assert.equal(created.status, 201);
  const id = created.json.announcement.id;
  assert.equal(created.json.announcement.published, false);
  const bad = await h.call("POST", "/api/public/announcements", { body: { severity: "panic", title: { zh: "x", en: "x" } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.errors[0].field, "severity");
  const updated = await h.call("PATCH", `/api/public/announcements/${id}`, { body: { published: true } });
  assert.equal(updated.json.announcement.published, true);
  assert.equal((await h.call("GET", "/api/public/announcements")).json.items.length, 1);
  assert.equal((await h.call("PATCH", "/api/public/announcements/an_missing", { body: { published: true } })).status, 404);
  assert.equal((await h.call("DELETE", `/api/public/announcements/${id}`)).json.removed, true);
  assert.equal((await h.call("DELETE", `/api/public/announcements/${id}`)).status, 404);
  assert.deepEqual(h.store.listAudit({ limit: 50 }).items.map((item) => item.action).filter((action) => action.startsWith("announcement.")).sort(), ["announcement.create", "announcement.remove", "announcement.update"]);
});

test("model meta reads null before it is set, upserts a partial patch and decodes the model id", async () => {
  const h = makeHarness();
  const id = "org%2Fqwen3.8";
  assert.equal((await h.call("GET", `/api/public/models/${id}/meta`)).json.meta, null);
  const put = await h.call("PUT", `/api/public/models/${id}/meta`, { body: { displayName: { zh: "千问", en: "Qwen" }, recommended: true, aliases: ["qwen"] } });
  assert.equal(put.status, 200);
  assert.equal(put.json.meta.modelId, "org/qwen3.8");
  const again = await h.call("PUT", `/api/public/models/${id}/meta`, { body: { hidden: true } });
  assert.equal(again.json.meta.displayName.en, "Qwen", "a partial patch keeps the rest");
  assert.equal(again.json.meta.hidden, true);
  const bad = await h.call("PUT", `/api/public/models/${id}/meta`, { body: { sort: "high", bogus: 1 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "invalid_field");
  assert.equal((await h.call("GET", `/api/public/models/${id}/meta`)).json.meta.recommended, true);
  assert.equal((await h.call("GET", "/api/public/models/%E0%A4%A/meta")).status, 400);
});

// --- mounted in the entry --------------------------------------------------------------

test("mounted in the entry: the table lists the module, the routes need the real owner session, and the compat views keep their shape", async (t) => {
  const { entry } = await loadEntry();
  assert.ok(entry.ROUTE_MODULES.includes("./lib/access-routes"));
  const ctx = entry.createRouteContext({ logger: quietLogger() });
  const routes = await entry.mountRouteModules({ ctx });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const registry = ctx.auth.viewerRegistry;
  assert.equal(registry.match("POST", "/api/access/keys/bulk-revoke").access, "admin");
  assert.equal(registry.match("PUT", "/api/public/models/x/meta").access, "admin");
  const port = await serveEntry(t, entry, routes);
  const owner = await ownerSession(entry, port);

  const anonymous = await request(port, "/api/access/presets");
  assert.ok([401, 403].includes(anonymous.status), "loopback without a session is a viewer and reads nothing");
  const presets = await request(port, "/api/access/presets", { owner });
  assert.equal(presets.status, 200);
  assert.equal(presets.json.presets.length, 5);
  const noToken = await request(port, "/api/access/keys", { method: "POST", body: { preset: "trial-7d", name: "Integration trial" }, headers: { cookie: owner.cookie } });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.json.error.code, "csrf_invalid");
  const created = await request(port, "/api/access/keys", { method: "POST", body: { preset: "trial-7d", name: "Integration trial" }, owner });
  assert.equal(created.status, 201, created.text);
  assert.match(created.json.secret, /^sk-plat-/);
  assert.ok(created.json.share.openaiBase.endsWith("/v1"));

  const revoked = await request(port, `/api/access/keys/${created.json.key.id}/revoke`, { method: "POST", body: { confirmName: "Integration trial" }, owner });
  assert.equal(revoked.json.key.status, "revoked");

  // The classic console's views keep their shapes (05 §13.1).
  const keys = await request(port, "/api/keys", { owner });
  assert.equal(keys.json.ok, true);
  assert.ok(Array.isArray(keys.json.keys.perManager) && Array.isArray(keys.json.keys.clients) && typeof keys.json.keys.total === "number");
  const security = await request(port, "/api/security", { owner });
  assert.equal(security.json.ok, true);
  const checklist = security.json.security.publicChecklist;
  assert.deepEqual(checklist.map((item) => item.id), ["api-key", "lan-admin", "cors", "rate-limit", "proxy-target", "firewall"]);
  for (const item of checklist) assert.deepEqual(Object.keys(item).sort(), ["detail", "id", "state", "title"]);

  const plan = await request(port, "/api/access/migration/plan", { method: "POST", body: {}, owner });
  assert.equal(plan.status, 200, plan.text);
  assert.ok(Array.isArray(plan.json.plan.inserts));
});

test("templates: preview renders the files and commands from the saved base URL; write goes only to config/public and never overwrites unasked", async (t) => {
  const aiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "access-templates-"));
  t.after(() => fs.rmSync(aiRoot, { recursive: true, force: true }));
  const h = makeHarness({ aiRoot });
  const expected = deployTemplates.planTemplates({ topology: "caddy", baseUrl: "https://api.example.com", config: {} });

  assert.equal((await h.call("GET", "/api/public/templates?topology=caddy", { who: "viewer" })).status, 403);
  const preview = await h.call("GET", "/api/public/templates?topology=caddy");
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json, { ok: true, files: expected.files, commands: expected.commands });
  assert.ok(preview.json.commands.includes("platform config set listeners.public.baseUrl https://api.example.com"));
  const withWebui = await h.call("GET", "/api/public/templates?topology=caddy&webuiDomain=chat.example.com");
  assert.ok(withWebui.json.files.some((file) => file.name === "openwebui.compose.yaml"));
  assert.equal((await h.call("GET", "/api/public/templates?topology=lan")).json.files.length, 0);
  const badTopology = await h.call("GET", "/api/public/templates?topology=nginx");
  assert.equal(badTopology.status, 400);
  assert.equal(badTopology.json.errors[0].field, "topology");
  assert.equal((await h.call("GET", "/api/public/templates")).status, 400);
  assert.equal((await h.call("GET", "/api/public/templates?topology=caddy&webuiDomain=bad_domain")).json.errors[0].field, "webuiDomain");

  const body = { topology: "caddy" };
  assert.equal((await h.call("POST", "/api/public/templates/write", { body, who: "no-csrf" })).status, 403);
  assert.ok([401, 403].includes((await h.call("POST", "/api/public/templates/write", { body, who: "viewer" })).status));
  assert.deepEqual(fs.readdirSync(aiRoot), [], "a refused write touches nothing");

  const written = await h.call("POST", "/api/public/templates/write", { body });
  assert.equal(written.status, 200, written.text);
  assert.deepEqual(written.json, { ok: true, written: ["config/public/Caddyfile"] });
  assert.equal(fs.readFileSync(path.join(aiRoot, "config", "public", "Caddyfile"), "utf8"), expected.files[0].content);
  assert.deepEqual(fs.readdirSync(aiRoot), ["config"]);

  fs.writeFileSync(path.join(aiRoot, "config", "public", "Caddyfile"), "owner edit\n");
  const again = await h.call("POST", "/api/public/templates/write", { body });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "template_exists");
  assert.deepEqual(again.json.error.existing, ["Caddyfile"]);
  assert.equal((await h.call("POST", "/api/public/templates/write", { body: { ...body, overwrite: "yes" } })).status, 400);
  assert.equal(fs.readFileSync(path.join(aiRoot, "config", "public", "Caddyfile"), "utf8"), "owner edit\n");
  const replaced = await h.call("POST", "/api/public/templates/write", { body: { ...body, overwrite: true }, who: "cli" });
  assert.equal(replaced.status, 200);
  assert.equal(fs.readFileSync(path.join(aiRoot, "config", "public", "Caddyfile"), "utf8"), expected.files[0].content);

  const audit = h.store.listAudit({ action: "templates.write" }).items;
  assert.equal(audit.length, 2);
  assert.equal(JSON.stringify(audit).includes("reverse_proxy"), false, "the audit holds names, not file contents");

  assert.equal((await h.call("POST", "/api/public/templates/write", { body: { topology: "nginx" } })).status, 400);
  assert.deepEqual((await h.call("POST", "/api/public/templates/write", { body: { topology: "lan" } })).json, { ok: true, written: [] });
});

test("templates: no base URL, or no platform root, is a clear refusal", async () => {
  const noUrl = makeHarness({ aiRoot: os.tmpdir(), settings: makeSettings({ listeners: { public: { port: 5186 } } }) });
  const missing = await noUrl.call("GET", "/api/public/templates?topology=cloudflared-token");
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, "public_base_url_required");
  const noRoot = makeHarness();
  const refused = await noRoot.call("POST", "/api/public/templates/write", { body: { topology: "caddy" } });
  assert.equal(refused.status, 503);
  assert.equal(refused.json.error.code, "ai_root_unavailable");
});
