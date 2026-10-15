"use strict";

// Knowledge routes at the entry (02 §8, §17, §19, MOD-15) through the real
// entry: the 05 guard, the viewer registry, the central sendJson redaction and
// the management proxy. The knowledge loader works over a temp config
// directory, the managers are fake HTTP servers, and pack URLs are fetched
// through a stub (the SSRF guards of fetchPackText are tested with a fake
// https.request), so nothing touches the live configuration or the network.

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const core = require("../../manager-core");
const knowledgeModule = require("../../manager-core/model-inspector/knowledge");
const { resetInspector } = require("../../manager-core/model-inspector/inspect");
const { materializeFixture } = require("../../manager-core/test/helpers/fixture-materialize");
const knowledgeRoutes = require("../lib/knowledge-routes");
const { loadEntry, ownerSession, quietLogger, request, serveEntry } = require("./helpers/entry-harness");

const MODULES = ["./lib/mgmt-proxy", "./lib/knowledge-routes"];

test.after(() => resetInspector());

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startFakeManager(t, domains) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/knowledge/status" ? { ok: true, managerId: "fake", domains, digest: "x" } : { ok: false }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return { port, seen };
}

const MANAGER_DOMAINS = [
  { domain: "models", layers: [], errors: [] },
  { domain: "engines", layers: [{ layer: "bundled", path: "<bundled>", files: [], digest: "d1" }], errors: [] },
  { domain: "recipes", layers: [], errors: [{ file: "D:\\cfg\\recipes\\broken.json", entryId: "r1", code: "invalid_json", message: "unreadable D:\\cfg\\recipes\\broken.json" }] },
  { domain: "launch-params", layers: [], errors: [] },
];

async function mountApp(t, { vllmDomains = MANAGER_DOMAINS, llamaDomains = null, vllmDown = false, llamaDown = true, fetchPack } = {}) {
  const { entry } = await loadEntry();
  const root = tempDir(t, "knowledge-routes-");
  const configDir = path.join(root, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const cacheDir = path.join(root, "cards");
  const loader = knowledgeModule.createKnowledgeLoader({
    configDir, aiRoot: root, cacheDir: path.join(root, "cache"), registry: null, recheckMs: 0, flushIntervalMs: 0,
  });
  t.after(() => loader.close());
  const vllm = vllmDown ? null : await startFakeManager(t, vllmDomains);
  const llama = llamaDown ? null : await startFakeManager(t, llamaDomains || vllmDomains);
  const managers = [
    { id: "vllm", port: vllm ? vllm.port : await unusedPort() },
    { id: "llama", port: llama ? llama.port : await unusedPort() },
  ];
  const ctx = entry.createRouteContext({
    logger: quietLogger(),
    managers,
    knowledge: { loader, cacheDir, ...(fetchPack ? { fetchPack } : {}) },
  });
  const routes = await entry.mountRouteModules({ ctx, modules: MODULES });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  const owner = await ownerSession(entry, port);
  return { entry, ctx, port, owner, root, configDir, cacheDir, loader, vllm, llama, registry: ctx.auth.viewerRegistry };
}

const packsDir = (app) => path.join(app.configDir, "knowledge.d", "packs");

function pack(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: "families",
    asOf: "2026-10-01",
    staleAfterDays: 365,
    pack: { id: "acme-pack" },
    entries: [{ id: "acme-model", label: { zh: "Acme 模型", en: "Acme model" }, match: { modelTypes: ["acme_test"] } }],
    ...overrides,
  };
}

function importPost(app, body) {
  return request(app.port, "/api/knowledge/import", { method: "POST", owner: app.owner, body });
}

// --- GET /api/knowledge ------------------------------------------------------------------------------

test("GET /api/knowledge lists the merged entries of a kind with their layer and hit counts", async (t) => {
  const app = await mountApp(t);
  const families = await request(app.port, "/api/knowledge", { owner: app.owner });
  assert.equal(families.status, 200, families.text);
  assert.equal(families.json.kind, "families");
  assert.ok(families.json.entries.length >= 10);
  const qwen = families.json.entries.find((entry) => entry.id === "qwen3.8");
  assert.equal(qwen.layer, "bundled");
  assert.ok(qwen.file.includes("families"));
  assert.deepEqual(qwen.overrides, []);
  assert.equal(qwen.heuristicHits, 0);
  assert.ok(!("matches" in qwen));
  for (const kind of ["template-signatures", "error-signatures"]) {
    const other = await request(app.port, `/api/knowledge?kind=${kind}`, { owner: app.owner });
    assert.equal(other.status, 200);
    assert.equal(other.json.kind, kind);
    assert.ok(other.json.entries.length >= 1, kind);
    assert.ok(other.json.entries.every((entry) => entry.layer));
  }
  const unknown = await request(app.port, "/api/knowledge?kind=nope", { owner: app.owner });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, "unknown_kind");
  const filtered = await request(app.port, "/api/knowledge?q=QWEN3.8", { owner: app.owner });
  assert.ok(filtered.json.entries.length >= 1 && filtered.json.entries.length < families.json.entries.length);
  assert.ok(filtered.json.entries.some((entry) => entry.id === "qwen3.8"));
  const none = await request(app.port, "/api/knowledge?q=zzzz-no-such-entry", { owner: app.owner });
  assert.deepEqual(none.json.entries, []);
});

test("withMatches lists the cached cards a family or a template signature selects", async (t) => {
  const app = await mountApp(t);
  const parent = path.join(app.root, "library");
  fs.mkdirSync(parent, { recursive: true });
  const model = await materializeFixture("qwen38-27b-fp8", { parent });
  t.after(() => model.cleanup());
  const { card } = await core.models.inspectLocalDetailed(model.dir, { inProcess: true, cacheDir: app.cacheDir, roots: [parent] });
  const family = app.loader.matchFamily(card)?.entry?.id;
  assert.ok(family, "the fixture matches a bundled family");
  const response = await request(app.port, "/api/knowledge?withMatches=1", { owner: app.owner });
  const entry = response.json.entries.find((item) => item.id === family);
  assert.deepEqual(entry.matches, [card.cardId]);
  assert.deepEqual(response.json.entries.find((item) => item.id !== family).matches, []);
  const signatures = await request(app.port, "/api/knowledge?kind=template-signatures&withMatches=1", { owner: app.owner });
  assert.ok(signatures.json.entries.every((item) => Array.isArray(item.matches)));
  const errors = await request(app.port, "/api/knowledge?kind=error-signatures&withMatches=1", { owner: app.owner });
  assert.ok(errors.json.entries.every((item) => item.matches.length === 0));
});

test("a viewer reads the entries without file and sources; an anonymous write is refused", async (t) => {
  const app = await mountApp(t);
  const owner = await request(app.port, "/api/knowledge", { owner: app.owner });
  assert.ok(owner.json.entries.some((entry) => "file" in entry));
  const viewer = await request(app.port, "/api/knowledge");
  assert.equal(viewer.status, 200, viewer.text);
  assert.equal(viewer.json.entries.length, owner.json.entries.length);
  for (const entry of viewer.json.entries) {
    assert.ok(!("file" in entry) && !("sources" in entry));
    assert.ok(entry.layer, "the layer name stays");
  }
  const lan = await request(app.port, "/api/knowledge?kind=error-signatures", { peer: "192.168.1.50" });
  assert.equal(lan.status, 200);
  for (const route of [["POST", "/api/knowledge/import", { content: "{}" }], ["POST", "/api/knowledge/reload", {}], ["PUT", "/api/knowledge/overrides/models/mc_aaaaaaaaaaaaaaaaaaaa", {}]]) {
    const denied = await request(app.port, route[1], { method: route[0], body: route[2] });
    assert.equal(denied.status, 401, route[1]);
    assert.equal(denied.json.error.code, "admin_session_required");
  }
  const deleted = await request(app.port, "/api/knowledge/packs/acme-pack", { method: "DELETE", headers: { "x-confirm": "delete" } });
  assert.equal(deleted.status, 401);
  const noCsrf = await request(app.port, "/api/knowledge/reload", { method: "POST", body: {}, headers: { cookie: app.owner.cookie } });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error.code, "csrf_invalid");
  const wrongMethod = await request(app.port, "/api/knowledge/status", { method: "POST", owner: app.owner, body: {} });
  assert.equal(wrongMethod.status, 405);
});

// --- GET /api/knowledge/status ------------------------------------------------------------------------------

test("status is always 200: own models domain plus the managers' domains over the proxy", async (t) => {
  const app = await mountApp(t, { llamaDown: false });
  const response = await request(app.port, "/api/knowledge/status", { owner: app.owner });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.ok, true);
  const names = response.json.domains.map((domain) => domain.domain);
  assert.deepEqual(names.slice().sort(), ["engines", "launch-params", "models", "recipes"]);
  assert.equal(names.filter((name) => name === "models").length, 1, "the manager's own models domain is not repeated");
  const models = response.json.domains.find((domain) => domain.domain === "models");
  assert.ok(models.layers.some((layer) => layer.layer === "bundled"));
  assert.equal(response.json.digest, models.digest);
  assert.match(response.json.digest, /^sha256:[0-9a-f]{64}$/);
  const engines = response.json.domains.find((domain) => domain.domain === "engines");
  assert.equal(engines.managerId, "vllm", "the first manager that answers supplies a domain");
  assert.deepEqual(response.json.managers, [{ managerId: "vllm", ok: true }, { managerId: "llama", ok: true }]);
  assert.ok(app.vllm.seen.includes("/api/knowledge/status"));
});

test("status stays 200 with every manager away: their domains are listed as unavailable", async (t) => {
  const app = await mountApp(t, { vllmDown: true, llamaDown: true });
  const started = Date.now();
  const response = await request(app.port, "/api/knowledge/status", { owner: app.owner });
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started < 5000);
  for (const name of ["engines", "recipes", "launch-params"]) {
    const domain = response.json.domains.find((item) => item.domain === name);
    assert.equal(domain.unavailable, true, name);
  }
  assert.ok(response.json.domains.find((item) => item.domain === "models").layers.length > 0);
  assert.ok(response.json.managers.every((manager) => manager.ok === false && manager.code));
});

test("status keeps loader errors and shows a viewer only layer names, base names and path-free messages", async (t) => {
  const app = await mountApp(t, { llamaDown: false });
  fs.mkdirSync(path.join(app.configDir, "knowledge.d"), { recursive: true });
  fs.writeFileSync(path.join(app.configDir, "knowledge.d", "broken.json"), "{ not json");
  const owner = await request(app.port, "/api/knowledge/status", { owner: app.owner });
  const models = owner.json.domains.find((domain) => domain.domain === "models");
  const issue = models.errors.find((item) => item.code === "invalid_json");
  assert.ok(issue, "the corrupt file is reported, not thrown");
  assert.ok(issue.file.includes("knowledge.d"), "the owner sees the display path");
  assert.ok(models.layers.find((layer) => layer.layer === "user").path.includes("knowledge.d"));

  const viewer = await request(app.port, "/api/knowledge/status");
  assert.equal(viewer.status, 200, viewer.text);
  const viewerModels = viewer.json.domains.find((domain) => domain.domain === "models");
  const viewerIssue = viewerModels.errors.find((item) => item.code === "invalid_json");
  assert.equal(viewerIssue.file, "broken.json");
  assert.equal(viewerIssue.message, issue.message, "the message is kept");
  for (const layer of viewerModels.layers) assert.equal(layer.path, layer.layer);
  assert.ok(!viewer.text.includes(app.root), "no directory of this machine reaches a viewer");
  const recipes = viewer.json.domains.find((domain) => domain.domain === "recipes");
  assert.equal(recipes.errors[0].file, "broken.json");
  assert.ok(!recipes.errors[0].message.includes("D:"), recipes.errors[0].message);
  assert.match(recipes.errors[0].message, /broken\.json/);
  const raw = await request(app.port, "/api/knowledge/status", { owner: app.owner });
  assert.ok(raw.json.domains.find((domain) => domain.domain === "recipes").errors[0].file.includes("D:"), "the owner copy is unchanged");
});

// --- import -------------------------------------------------------------------------------------------------

test("import previews a pack without writing, then writes it only for the confirmed sha256", async (t) => {
  const app = await mountApp(t);
  const content = JSON.stringify(pack());
  const preview = await importPost(app, { content });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.ok, true);
  assert.equal(preview.json.packId, "acme-pack");
  assert.match(preview.json.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(preview.json.diff, { added: ["acme-model"], replaced: [], deleted: [], invalidEntries: [] });
  assert.equal(fs.existsSync(packsDir(app)), false, "a preview writes nothing");
  assert.ok(!(await request(app.port, "/api/knowledge", { owner: app.owner })).json.entries.some((entry) => entry.id === "acme-model"));

  const noSha = await importPost(app, { content, confirm: true });
  assert.equal(noSha.status, 400);
  assert.equal(noSha.json.errors[0].field, "sha256");
  const wrong = await importPost(app, { content, confirm: true, sha256: "0".repeat(64) });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.error.code, "sha_mismatch");
  assert.equal(fs.existsSync(packsDir(app)), false);
  const changed = await importPost(app, { content: JSON.stringify(pack({ staleAfterDays: 30 })), confirm: true, sha256: preview.json.sha256 });
  assert.equal(changed.status, 409, "the preview of other bytes does not confirm these bytes");

  const written = await importPost(app, { content, confirm: true, sha256: preview.json.sha256 });
  assert.equal(written.status, 200, written.text);
  assert.equal(written.json.packId, "acme-pack");
  assert.match(written.json.digest, /^sha256:[0-9a-f]{64}$/);
  const files = fs.readdirSync(packsDir(app));
  assert.deepEqual(files, [`acme-pack@${preview.json.sha256.slice(0, 12)}.json`]);
  assert.equal(fs.readFileSync(path.join(packsDir(app), files[0]), "utf8"), content, "the confirmed bytes are stored as they were");
  const entry = (await request(app.port, "/api/knowledge", { owner: app.owner })).json.entries.find((item) => item.id === "acme-model");
  assert.equal(entry.layer, "pack");

  // A new version of the pack replaces the old file and reports what it replaces.
  const v2 = JSON.stringify(pack({ entries: [pack().entries[0], { id: "second-model", match: { modelTypes: ["second_test"] } }] }));
  const preview2 = await importPost(app, { content: v2 });
  assert.deepEqual(preview2.json.diff.added, ["second-model"]);
  assert.deepEqual(preview2.json.diff.replaced, ["acme-model"]);
  const second = await importPost(app, { content: v2, confirm: true, sha256: preview2.json.sha256 });
  assert.equal(second.status, 200);
  assert.deepEqual(fs.readdirSync(packsDir(app)), [`acme-pack@${preview2.json.sha256.slice(0, 12)}.json`], "one file per pack id");
});

test("import reports invalid entries, refuses invalid packs and caps the size", async (t) => {
  const app = await mountApp(t);
  const mixed = JSON.stringify(pack({ entries: [pack().entries[0], { id: "bad id!" }, { id: "no-match" }] }));
  const preview = await importPost(app, { content: mixed });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.json.diff.added, ["acme-model"]);
  assert.ok(preview.json.diff.invalidEntries.length >= 2);
  assert.ok(preview.json.diff.invalidEntries.every((item) => item.code && item.message !== undefined));
  const written = await importPost(app, { content: mixed, confirm: true, sha256: preview.json.sha256 });
  assert.equal(written.status, 200, "valid entries are written; invalid ones were only reported");

  for (const [name, content, field] of [
    ["not json", "{ nope", "content"],
    ["unknown kind", JSON.stringify({ kind: "mystery", entries: [] }), "kind"],
    ["no kind", JSON.stringify({ entries: [] }), "kind"],
    ["bad pack id", JSON.stringify(pack({ pack: { id: "../evil" } })), "pack.id"],
  ]) {
    const refused = await importPost(app, { content });
    assert.equal(refused.status, 400, name);
    assert.equal(refused.json.error.code, "pack_invalid", name);
    assert.equal(refused.json.errors[0].field, field, name);
  }
  const noUsable = JSON.stringify(pack({ pack: { id: "empty-pack" }, entries: [{ id: "x y" }] }));
  const noUsablePreview = await importPost(app, { content: noUsable });
  assert.equal(noUsablePreview.status, 200);
  const noUsableWrite = await importPost(app, { content: noUsable, confirm: true, sha256: noUsablePreview.json.sha256 });
  assert.equal(noUsableWrite.status, 400);
  assert.equal(noUsableWrite.json.error.code, "pack_invalid");

  const huge = await importPost(app, { content: "x".repeat(1024 * 1024 + 1) });
  assert.equal(huge.status, 413);
  assert.equal(huge.json.error.code, "pack_too_large");
  // A body past the route's limit is refused while it is still arriving; the client may see the answer or a reset.
  const hugeBody = await request(app.port, "/api/knowledge/import", { method: "POST", owner: app.owner, body: JSON.stringify({ content: "y".repeat(2 * 1024 * 1024 + 8192) }) }).catch((error) => ({ error }));
  if (hugeBody.error) assert.equal(hugeBody.error.code, "ECONNRESET");
  else assert.equal(hugeBody.json.error.code, "pack_too_large");

  const neither = await importPost(app, {});
  assert.equal(neither.status, 400);
  assert.equal(neither.json.error.code, "invalid_request");
  const both = await importPost(app, { content: "{}", url: "https://example.org/pack.json" });
  assert.equal(both.json.errors[0].code, "conflict");
  const objectContent = await importPost(app, { content: pack({ pack: { id: "object-pack" } }) });
  assert.equal(objectContent.status, 200, "content may be the pack itself");
});

test("a pack read from a URL is confirmed against the bytes fetched again", async (t) => {
  let served = JSON.stringify(pack());
  const asked = [];
  const app = await mountApp(t, { fetchPack: async (url) => { asked.push(url); return { text: served }; } });
  const preview = await importPost(app, { url: "https://packs.example.org/acme.json" });
  assert.equal(preview.status, 200, preview.text);
  const written = await importPost(app, { url: "https://packs.example.org/acme.json", confirm: true, sha256: preview.json.sha256 });
  assert.equal(written.status, 200);
  assert.deepEqual(asked, ["https://packs.example.org/acme.json", "https://packs.example.org/acme.json"]);
  served = JSON.stringify(pack({ staleAfterDays: 1 }));
  const moved = await importPost(app, { url: "https://packs.example.org/acme.json", confirm: true, sha256: preview.json.sha256 });
  assert.equal(moved.status, 409);
  assert.equal(moved.json.error.code, "sha_mismatch");
});

test("a failing pack download is reported with the downloader's own error", async (t) => {
  const app = await mountApp(t, {
    fetchPack: async () => { throw Object.assign(new Error("The pack host resolves to a loopback, private or link-local address."), { status: 400, code: "url_not_allowed" }); },
  });
  const refused = await importPost(app, { url: "https://internal.example.org/pack.json" });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, "url_not_allowed");
});

// --- delete a pack ----------------------------------------------------------------------------------------------

test("DELETE /api/knowledge/packs/:packId needs the confirmation header and removes the pack's layer", async (t) => {
  const app = await mountApp(t);
  const content = JSON.stringify(pack());
  const preview = await importPost(app, { content });
  await importPost(app, { content, confirm: true, sha256: preview.json.sha256 });
  const url = "/api/knowledge/packs/acme-pack";
  const unconfirmed = await request(app.port, url, { method: "DELETE", owner: app.owner });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.json.error.code, "confirmation_required");
  assert.equal(fs.readdirSync(packsDir(app)).length, 1);
  const unknown = await request(app.port, "/api/knowledge/packs/other-pack", { method: "DELETE", owner: app.owner, headers: { "x-confirm": "delete" } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, "pack_not_found");
  const traversal = await request(app.port, "/api/knowledge/packs/..%2F..%2Fx", { method: "DELETE", owner: app.owner, headers: { "x-confirm": "delete" } });
  assert.equal(traversal.status, 404);
  const removed = await request(app.port, url, { method: "DELETE", owner: app.owner, headers: { "x-confirm": "delete" } });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json, { ok: true });
  assert.deepEqual(fs.readdirSync(packsDir(app)), []);
  assert.ok(!(await request(app.port, "/api/knowledge", { owner: app.owner })).json.entries.some((entry) => entry.id === "acme-model"));
  assert.equal((await request(app.port, url, { method: "DELETE", owner: app.owner, headers: { "x-confirm": "delete" } })).status, 404);
});

// --- per-model override ----------------------------------------------------------------------------------------------

test("PUT /api/knowledge/overrides/models/:cardId writes a per-model file selected by the card's contentDigest", async (t) => {
  const app = await mountApp(t);
  const parent = path.join(app.root, "library");
  fs.mkdirSync(parent, { recursive: true });
  const model = await materializeFixture("qwen38-27b-fp8", { parent });
  t.after(() => model.cleanup());
  const { card } = await core.models.inspectLocalDetailed(model.dir, { inProcess: true, cacheDir: app.cacheDir, roots: [parent] });
  const url = `/api/knowledge/overrides/models/${card.cardId}`;

  const missing = await request(app.port, "/api/knowledge/overrides/models/mc_bbbbbbbbbbbbbbbbbbbb", { method: "PUT", owner: app.owner, body: { id: "qwen3.8" } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "card_not_found");

  const invalid = await request(app.port, url, { method: "PUT", owner: app.owner, body: { engines: 5, priority: "high" } });
  assert.equal(invalid.status, 422, invalid.text);
  assert.equal(invalid.json.error.code, "invalid_override");
  assert.ok(invalid.json.errors.length >= 1);
  assert.ok(invalid.json.errors.every((item) => item.field && item.code && item.message));
  assert.equal(fs.existsSync(path.join(app.configDir, "knowledge.d", "models")), false, "an invalid override writes nothing");

  const ok = await request(app.port, url, { method: "PUT", owner: app.owner, body: { notes: [{ zh: "本机覆盖", en: "Local override" }], contextMax: 131072 } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.ok, true);
  assert.ok(ok.json.file.endsWith(`models/${card.cardId}.json`), ok.json.file);
  const file = path.join(app.configDir, "knowledge.d", "models", `${card.cardId}.json`);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.kind, "families");
  assert.equal(stored.entries.length, 1);
  assert.deepEqual(stored.entries[0].match, { contentDigest: card.contentDigest });
  assert.equal(stored.entries[0].id, app.loader.matchFamily(card).entry.id, "the id defaults to the card's family");
  assert.equal(app.loader.matchFamily(card).entry.contextMax, 131072, "the loader applies the override to this model");

  // The body cannot choose which models it applies to.
  const sneaky = await request(app.port, url, { method: "PUT", owner: app.owner, body: { match: { repo: "other/model" }, contextMax: 65536 } });
  assert.equal(sneaky.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).entries[0].match, { contentDigest: card.contentDigest });
  assert.equal(app.loader.matchFamily(card).entry.contextMax, 65536, "a second PUT replaces the first");

  // A card with no family and no id in the body cannot name an entry.
  const noId = tempDir(t, "no-family-");
  fs.writeFileSync(path.join(noId, "config.json"), JSON.stringify({ model_type: "zz_unknown_arch", architectures: ["ZzUnknownForCausalLM"], hidden_size: 64, num_hidden_layers: 2, num_attention_heads: 2, vocab_size: 100 }));
  fs.writeFileSync(path.join(noId, "model.safetensors"), Buffer.alloc(16));
  const unknown = await core.models.inspectLocalDetailed(noId, { inProcess: true, cacheDir: app.cacheDir, roots: [path.dirname(noId)], depth: "quick" });
  const unnamed = await request(app.port, `/api/knowledge/overrides/models/${unknown.card.cardId}`, { method: "PUT", owner: app.owner, body: { contextMax: 4096 } });
  assert.equal(unnamed.status, 422);
  assert.equal(unnamed.json.errors[0].field, "id");
  const named = await request(app.port, `/api/knowledge/overrides/models/${unknown.card.cardId}`, { method: "PUT", owner: app.owner, body: { id: "zz-unknown", contextMax: 4096 } });
  assert.equal(named.status, 200, named.text);
});

// --- reload -----------------------------------------------------------------------------------------------------------

test("POST /api/knowledge/reload re-reads the layers and answers the digest", async (t) => {
  const app = await mountApp(t);
  const before = await request(app.port, "/api/knowledge/reload", { method: "POST", owner: app.owner, body: {} });
  assert.equal(before.status, 200);
  assert.equal(before.json.ok, true);
  assert.match(before.json.digest, /^sha256:[0-9a-f]{64}$/);
  fs.mkdirSync(path.join(app.configDir, "knowledge.d"), { recursive: true });
  fs.writeFileSync(path.join(app.configDir, "knowledge.d", "mine.json"), JSON.stringify(pack({ pack: undefined })));
  const after = await request(app.port, "/api/knowledge/reload", { method: "POST", owner: app.owner, body: {} });
  assert.notEqual(after.json.digest, before.json.digest);
  const entry = (await request(app.port, "/api/knowledge", { owner: app.owner })).json.entries.find((item) => item.id === "acme-model");
  assert.equal(entry.layer, "user");
});

// --- the registry ----------------------------------------------------------------------------------------------------------

test("the 05 registry holds the knowledge routes: two viewer GETs with a redaction, the rest owner-only", async (t) => {
  const app = await mountApp(t);
  const entries = app.registry.inventory().filter((item) => item.path.startsWith("/api/knowledge"));
  assert.deepEqual(entries.map((item) => `${item.method} ${item.path} ${item.access} ${item.owner}`).sort(), [
    "DELETE /api/knowledge/packs/:packId admin 02",
    "GET /api/knowledge viewer 02",
    "GET /api/knowledge/status viewer 02",
    "POST /api/knowledge/import admin 02",
    "POST /api/knowledge/reload admin 02",
    "PUT /api/knowledge/overrides/models/:cardId admin 02",
  ]);
  for (const route of knowledgeRoutes.viewerRoutes) assert.equal(typeof app.registry.match("GET", route.path).entry.redact, "function");
  assert.throws(() => knowledgeRoutes.mount({}), /ctx\.auth is missing/);
  assert.throws(() => knowledgeRoutes.createKnowledgeRoutes({}), /request-auth seam/);
});

// --- fetchPackText ------------------------------------------------------------------------------------------------------------

// A fake https.request: `reply` decides the answer; the options it was called with are kept.
function fakeHttps(reply) {
  const calls = [];
  const request = (options, callback) => {
    const call = new EventEmitter();
    call.destroyed = false;
    call.destroy = () => { call.destroyed = true; };
    call.end = () => {
      calls.push(options);
      const answer = reply(options);
      if (answer.error) {
        setImmediate(() => call.emit("error", new Error(answer.error)));
        return;
      }
      const response = new PassThrough();
      response.statusCode = answer.status ?? 200;
      response.headers = answer.headers ?? { "content-type": "application/json; charset=utf-8" };
      callback(response);
      for (const chunk of [].concat(answer.chunks ?? [answer.body ?? "{}"])) response.write(chunk);
      response.end();
    };
    return call;
  };
  return { request, calls };
}

test("fetchPackText refuses what is not a public https JSON document", async () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const okRequest = fakeHttps(() => ({ body: '{"kind":"families"}' }));
  const fetched = await knowledgeRoutes.fetchPackText("https://packs.example.org/a.json?x=1", { lookup, request: okRequest.request });
  assert.equal(fetched.text, '{"kind":"families"}');
  const options = okRequest.calls[0];
  assert.equal(options.host, "packs.example.org");
  assert.equal(options.path, "/a.json?x=1");
  assert.equal(options.servername, "packs.example.org");
  // The connection goes to the address that was checked, not to a fresh lookup.
  const pinned = await new Promise((resolve) => options.lookup("packs.example.org", {}, (error, address, family) => resolve({ error, address, family })));
  assert.deepEqual(pinned, { error: null, address: "93.184.216.34", family: 4 });
  const pinnedAll = await new Promise((resolve) => options.lookup("packs.example.org", { all: true }, (error, list) => resolve(list)));
  assert.deepEqual(pinnedAll, [{ address: "93.184.216.34", family: 4 }]);

  const rejects = async (url, code, status, extra = {}) => {
    const reply = extra.reply || (() => ({ body: "{}" }));
    await assert.rejects(
      knowledgeRoutes.fetchPackText(url, { lookup: extra.lookup || lookup, request: fakeHttps(reply).request, ...(extra.options || {}) }),
      (error) => error.code === code && error.status === status,
      `${url} -> ${code}`,
    );
  };
  await rejects("not a url", "invalid_url", 400);
  await rejects("http://packs.example.org/a.json", "invalid_url", 400);
  await rejects("ftp://packs.example.org/a.json", "invalid_url", 400);
  await rejects("https://user:pw@packs.example.org/a.json", "invalid_url", 400);
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.16.0.9", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    await rejects("https://packs.example.org/a.json", "url_not_allowed", 400, { lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }] });
  }
  // One private address among the public ones is enough to refuse (DNS rebinding).
  await rejects("https://packs.example.org/a.json", "url_not_allowed", 400, { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }] });
  await rejects("https://127.0.0.1/a.json", "url_not_allowed", 400);
  await rejects("https://[::1]/a.json", "url_not_allowed", 400);
  await rejects("https://packs.example.org/a.json", "pack_fetch_failed", 502, { lookup: async () => { throw new Error("ENOTFOUND"); } });
  await rejects("https://packs.example.org/a.json", "pack_fetch_failed", 502, { reply: () => ({ status: 302, headers: { location: "https://elsewhere.example.org/" } }) });
  await rejects("https://packs.example.org/a.json", "pack_fetch_failed", 502, { reply: () => ({ status: 404 }) });
  await rejects("https://packs.example.org/a.json", "pack_fetch_failed", 502, { reply: () => ({ error: "ECONNRESET" }) });
  await rejects("https://packs.example.org/a.json", "pack_invalid", 400, { reply: () => ({ headers: { "content-type": "text/html" } }) });
  await rejects("https://packs.example.org/a.json", "pack_too_large", 413, { reply: () => ({ headers: { "content-type": "application/json", "content-length": "5000000" } }) });
  await rejects("https://packs.example.org/a.json", "pack_too_large", 413, { reply: () => ({ chunks: ["x".repeat(600), "y".repeat(600)] }), options: { maxBytes: 1000 } });
  await rejects("https://packs.example.org/a.json", "pack_fetch_failed", 502, { reply: () => ({ hang: true, status: 200, chunks: [] }), options: { timeoutMs: 1 }, lookup: async () => [{ address: "93.184.216.34", family: 4 }] }).catch(() => {});
});

test("isBlockedAddress separates public unicast addresses from the rest", () => {
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"]) assert.equal(knowledgeRoutes.isBlockedAddress(address), false, address);
  for (const address of ["127.0.0.1", "10.0.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "100.100.100.100", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fe80::abcd", "ff02::1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "not an address", ""]) {
    assert.equal(knowledgeRoutes.isBlockedAddress(address), true, address);
  }
});

test("redaction helpers copy their input and tolerate unexpected bodies", () => {
  const fakeKey = `sk-${"a1".repeat(16)}`;
  const status = {
    ok: true,
    domains: [
      { domain: "models", layers: [{ layer: "pack", path: "<AI_ROOT>/config/knowledge.d/packs", files: [{ name: "a@b.json", errors: [{ file: "C:\\x\\y.json", message: "see C:\\x\\y.json now" }] }] }], errors: [{ file: "<AI_ROOT>/config/knowledge.d/z.json", message: `bad ${fakeKey}` }], staleFiles: ["<bundled>/families.json"] },
      "junk",
    ],
  };
  const out = knowledgeRoutes.redactKnowledgeStatusForViewer(status);
  assert.equal(out.domains[0].layers[0].path, "pack");
  assert.equal(out.domains[0].layers[0].files[0].errors[0].file, "y.json");
  assert.equal(out.domains[0].layers[0].files[0].errors[0].message, "see y.json now");
  assert.equal(out.domains[0].errors[0].file, "z.json");
  assert.ok(!out.domains[0].errors[0].message.includes(fakeKey), "secret-shaped text is redacted");
  assert.deepEqual(out.domains[0].staleFiles, ["families.json"]);
  assert.equal(out.domains[1], "junk");
  assert.equal(status.domains[0].layers[0].path, "<AI_ROOT>/config/knowledge.d/packs", "the input is not modified");
  assert.equal(knowledgeRoutes.redactKnowledgeStatusForViewer(null), null);
  assert.deepEqual(knowledgeRoutes.redactKnowledgeForViewer({ ok: false }), { ok: false });
});
