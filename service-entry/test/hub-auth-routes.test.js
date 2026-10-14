"use strict";

// Hugging Face auth, temporary tokens and the source probe on the hub routes
// (docs/overhaul/03-hub.md §12, §13.1, HUB-11), through the real entry for the
// principals it can mint and through createHubRoutes with a fake auth seam for
// the ones it cannot (a LAN owner). The hf CLI is a fake service, every fetch
// is a fake and the hub lives in a temp directory.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const internalAuth = require("../../manager-core/internal-auth");
const { createModelHub } = require("../../manager-core/model-hub");
const { HubError } = require("../../manager-core/model-hub/errors");
const hubRoutes = require("../lib/hub-routes");
const { loadEntry, ownerSession, quietLogger, request, serveEntry } = require("./helpers/entry-harness");

const LAN = "192.168.1.50";
// Obviously fake; assembled so no scanner mistakes it for a real token.
const FAKE_TOKEN = ["hf", "_", "FAKEroutesFAKEroutesFAKE0001"].join("");

function tempDir(t, prefix = "hub-auth-routes-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeHfService() {
  const calls = [];
  return {
    calls,
    async getStatus(options = {}) {
      calls.push(["getStatus", Boolean(options.token)]);
      return { connected: true, username: "example-user", orgs: ["example-org"], source: "local-cli" };
    },
    async checkRepoAccess(repo, options = {}) {
      calls.push(["checkRepoAccess", repo, options.probeFile]);
      return { granted: false, status: "approval_required", username: "example-user" };
    },
    launchLogin() {
      calls.push(["launchLogin"]);
      return { launched: true, tokenUrl: "https://huggingface.co/settings/tokens" };
    },
    hasCachedToken: () => true,
  };
}

const MANIFEST = {
  repo: "example-org/Example-8B-FP8",
  files: [
    { path: "config.json", size: 10 },
    { path: "model-00001-of-00002.safetensors", size: 100 },
    { path: "model-00002-of-00002.safetensors", size: 100 },
  ],
};

async function startHub(t, { secretStore = null } = {}) {
  const root = tempDir(t);
  const dataDir = path.join(root, "service-entry", "data", "hub");
  const service = fakeHfService();
  const probed = [];
  const hub = createModelHub({
    aiRoot: root,
    dataDir,
    env: {},
    hfCli: "hf-stub",
    modelScopeCli: "modelscope",
    secretStore,
    hfAuthService: service,
    providers: { get: () => ({ getRepo: async () => MANIFEST }) },
    sourceProbeOptions: {
      probe: async (options) => {
        probed.push(options);
        return { ok: true, repo: options.model || "x/default", file: options.file || "config.json", sources: [{ source: "official", label: "huggingface.co", ok: true, status: 206, ms: 20, bytes: 100, bytesPerSec: 5000 }], recommended: "official" };
      },
    },
    logger: quietLogger(),
    heartbeatMs: 3_600_000,
  });
  await hub.start();
  t.after(() => hub.stop());
  return { hub, root, dataDir, service, probed };
}

async function mountEntry(t, { hub }) {
  const { entry } = await loadEntry();
  const ctx = entry.createRouteContext({ logger: quietLogger(), hub });
  const routes = await entry.mountRouteModules({ ctx });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  const owner = await ownerSession(entry, port);
  return { entry, ctx, port, owner, token: entry.security.getTrustToken() };
}

function signed(port, method, pathWithQuery, options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const sign = { method, pathWithQuery, principal: options.principal, body: body || "", now: Date.now() };
  const headers = internalAuth.buildMachineHeaders(options.token, sign);
  return request(port, pathWithQuery, { method, headers, ...(body !== undefined ? { body } : {}) });
}

// --- the routes ------------------------------------------------------------------

test("the loopback owner reads the login status, opens the login window and checks access", async (t) => {
  const { hub, service } = await startHub(t);
  const { port, owner } = await mountEntry(t, { hub });

  const status = await request(port, "/api/hub/auth/huggingface", { owner });
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { ok: true, connected: true, username: "example-user", orgs: ["example-org"], source: "local-cli" });

  const login = await request(port, "/api/hub/auth/huggingface/login", { method: "POST", owner, body: {} });
  assert.equal(login.status, 200);
  assert.deepEqual(login.json, { ok: true, launched: true, tokenUrl: "https://huggingface.co/settings/tokens" });
  assert.deepEqual(service.calls.filter((call) => call[0] === "launchLogin"), [["launchLogin"]]);

  const access = await request(port, "/api/hub/auth/huggingface/access?repo=example-org/Example-8B-FP8", { owner });
  assert.equal(access.status, 200);
  assert.deepEqual(access.json, { ok: true, granted: false, status: "approval_required", username: "example-user", authorizationUrl: "https://huggingface.co/example-org/Example-8B-FP8" });
  assert.deepEqual(service.calls.find((call) => call[0] === "checkRepoAccess"), ["checkRepoAccess", "example-org/Example-8B-FP8", "model-00001-of-00002.safetensors"], "the first weight file, not config.json");

  const missing = await request(port, "/api/hub/auth/huggingface/access", { owner });
  assert.deepEqual([missing.status, missing.json.error.code], [400, "invalid_request"]);
  const bad = await request(port, "/api/hub/auth/huggingface/access?repo=nope", { owner });
  assert.deepEqual([bad.status, bad.json.error.code], [400, "invalid_request"]);
});

test("a viewer sees only { connected } and { granted, status }, and cannot log in or probe", async (t) => {
  const { hub, service } = await startHub(t);
  const { port } = await mountEntry(t, { hub });

  const status = await request(port, "/api/hub/auth/huggingface", { peer: LAN });
  assert.deepEqual(status.json, { ok: true, connected: true });
  const access = await request(port, "/api/hub/auth/huggingface/access?repo=example-org/Example-8B-FP8", { peer: LAN });
  assert.deepEqual(access.json, { ok: true, granted: false, status: "approval_required" });

  for (const [route, body] of [["/api/hub/auth/huggingface/login", {}], ["/api/hub/sources/probe", {}]]) {
    const refused = await request(port, route, { method: "POST", peer: LAN, body });
    assert.deepEqual([refused.status, refused.json.error.code], [401, "admin_session_required"], route);
  }
  // A loopback caller without a session is a viewer too.
  const loopbackViewer = await request(port, "/api/hub/auth/huggingface/login", { method: "POST", body: {} });
  assert.deepEqual([loopbackViewer.status, loopbackViewer.json.error.code], [401, "admin_session_required"]);
  assert.equal(service.calls.some((call) => call[0] === "launchLogin"), false);
});

test("a signed shim may use the login only when its signed origin says the caller is local", async (t) => {
  const { hub, service } = await startHub(t);
  const { port, token } = await mountEntry(t, { hub });
  const principal = "system:hub-shim:llama";
  const login = (origin) => signed(port, "POST", "/api/hub/auth/huggingface/login", { principal, token, body: { origin } });

  const local = await login({ kind: "manager-shim", managerId: "llama", clientLocal: true });
  assert.equal(local.status, 200, local.text);
  assert.equal(local.json.launched, true);

  for (const origin of [{ kind: "manager-shim", managerId: "llama", clientLocal: false }, { kind: "manager-shim", managerId: "llama" }, { clientLocal: "true" }]) {
    const refused = await login(origin);
    assert.deepEqual([refused.status, refused.json.error.code], [403, "token_requires_local"], JSON.stringify(origin));
  }
  const noBody = await signed(port, "POST", "/api/hub/auth/huggingface/login", { principal, token });
  assert.deepEqual([noBody.status, noBody.json.error.code], [403, "token_requires_local"]);
  assert.equal(service.calls.filter((call) => call[0] === "launchLogin").length, 1);

  // The read side of auth is open to the shim; routes outside SHIM_ROUTES are not.
  const read = await signed(port, "GET", "/api/hub/auth/huggingface", { principal, token });
  assert.equal(read.status, 200);
  assert.equal(read.json.connected, true);
  const forbidden = await signed(port, "GET", "/api/hub/status", { principal, token });
  assert.equal(forbidden.json.error.code, "principal_route_forbidden");
});

test("a LAN owner gets 403 token_requires_local for the login and the token", async () => {
  const sent = [];
  let launched = 0;
  const hub = {
    auth: { login: () => { launched += 1; return { launched: true }; } },
    tokens: { put: async () => { throw new Error("must not be reached"); } },
  };
  const owner = (extra) => ({
    principal: () => ({ role: "owner", principal: "session:abcd1234", via: "session", redact: false, ...extra }),
    checkWrite: () => ({ ok: true }),
    viewerRegistry: { match: () => null },
  });
  const sendJson = (res, data, status = 200) => sent.push({ status, data });
  const request = (extra = {}) => ({ method: "POST", headers: {}, socket: { remoteAddress: LAN }, resume() {}, ...extra });
  const url = new URL("/api/hub/auth/huggingface/login", "http://127.0.0.1");

  const lan = hubRoutes.createHubRoutes({ hub, auth: owner({ network: "lan" }), sendJson, readJsonObjectBody: async () => ({}) });
  assert.equal(await lan.handle(request(), {}, url), true);
  assert.deepEqual([sent.at(-1).status, sent.at(-1).data.error.code], [403, "token_requires_local"]);
  assert.equal(launched, 0);

  // The principal claims loopback, but the socket is on the LAN: still refused.
  const lying = hubRoutes.createHubRoutes({ hub, auth: owner({ network: "loopback" }), sendJson, readJsonObjectBody: async () => ({}) });
  await lying.handle(request(), {}, url);
  assert.equal(sent.at(-1).data.error.code, "token_requires_local");
  // A loopback socket with a proxy header is not a local caller either.
  await lying.handle(request({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "203.0.113.7" } }), {}, url);
  assert.equal(sent.at(-1).data.error.code, "token_requires_local");
  assert.equal(launched, 0);

  const local = hubRoutes.createHubRoutes({ hub, auth: owner({ network: "loopback" }), sendJson, readJsonObjectBody: async () => ({}) });
  await local.handle(request({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), {}, url);
  assert.equal(sent.at(-1).status, 200);
  assert.equal(launched, 1);
});

test("the source probe is owner-only, informational and takes no credential", async (t) => {
  const { hub, probed, dataDir } = await startHub(t);
  const { port, owner } = await mountEntry(t, { hub });
  const settingsFile = path.join(dataDir, "settings.json");
  const read = () => (fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : null);
  const before = read();

  const result = await request(port, "/api/hub/sources/probe", { method: "POST", owner, body: { repo: "example-org/Example-8B-FP8" } });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.reachable, true);
  assert.equal(result.json.file, "model-00001-of-00002.safetensors");
  assert.deepEqual(result.json.sources.map((source) => source.source), ["huggingface"]);
  assert.equal(result.json.recommended, "huggingface");
  assert.deepEqual(probed.map((options) => [options.model, options.file]), [["example-org/Example-8B-FP8", "model-00001-of-00002.safetensors"]]);
  assert.equal(probed[0].token, undefined);
  assert.equal(read(), before, "the probe never persists settings");

  const invalid = await request(port, "/api/hub/sources/probe", { method: "POST", owner, body: { repo: 7 } });
  assert.deepEqual([invalid.status, invalid.json.error.code], [400, "invalid_request"]);
});

// --- credential handling ---------------------------------------------------------

function fakeSecretStore() {
  const entries = new Map();
  return {
    entries,
    async set(ns, name, value) { entries.set(`${ns}/${name}`, value); },
    get: (ns, name) => entries.get(`${ns}/${name}`) || "",
    async remove(ns, name) { return entries.delete(`${ns}/${name}`); },
    list: (ns) => Array.from(entries.keys()).filter((key) => key.startsWith(`${ns}/`)).map((key) => ({ name: key.slice(ns.length + 1), createdAt: new Date().toISOString() })),
    values: () => Array.from(entries.values()),
  };
}

function loopbackReq() {
  return { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
}

test("credential.hfToken is accepted from a loopback owner or a local shim only, and stays out of every response and file", async (t) => {
  const { hub, dataDir } = await startHub(t, { secretStore: fakeSecretStore() });
  const accept = (req, who, body) => hubRoutes.acceptHubCredential({ hub, req, who, body });
  const owner = { kind: "owner", principal: "session:abcd1234", network: "loopback", via: "session" };
  const body = { credential: { hfToken: FAKE_TOKEN } };

  const temp = await accept(loopbackReq(), owner, body);
  assert.deepEqual(Object.keys(temp).sort(), ["credentialMode", "remember", "tokenRef"]);
  assert.equal(temp.credentialMode, "temp-token");
  assert.equal(temp.remember, false);
  assert.match(temp.tokenRef, /^dlt_[a-z2-7]{16}$/);
  assert.equal(hub.tokens.resolve(temp.tokenRef), FAKE_TOKEN);
  assert.equal(JSON.stringify(temp).includes(FAKE_TOKEN), false);

  const remembered = await accept(loopbackReq(), owner, { credential: { hfToken: `${FAKE_TOKEN}-r`, remember: true } });
  assert.equal(remembered.remember, true);

  // The CLI principal's signature already needs a loopback socket.
  assert.equal((await accept(loopbackReq(), { kind: "owner", principal: "system:cli", network: "", via: "hmac" }, body)).credentialMode, "temp-token");
  // A shim carries the manager's verdict in its signed body.
  const shim = { kind: "shim", principal: "system:hub-shim:vllm", managerId: "vllm" };
  assert.equal((await accept(loopbackReq(), shim, { origin: { clientLocal: true }, ...body })).credentialMode, "temp-token");

  // Nothing else gets to pass a token, and the vault stays as it was.
  const known = hub.tokens.values().length;
  const refuse = async (req, who, input, status, code) => {
    await assert.rejects(accept(req, who, input), (error) => error instanceof HubError && error.status === status && error.code === code);
  };
  const lanReq = { headers: {}, socket: { remoteAddress: LAN } };
  await refuse(lanReq, { ...owner, network: "lan" }, body, 403, "token_requires_local");
  await refuse(lanReq, owner, body, 403, "token_requires_local");
  await refuse({ headers: { "x-forwarded-for": "203.0.113.7" }, socket: { remoteAddress: "127.0.0.1" } }, owner, body, 403, "token_requires_local");
  await refuse(loopbackReq(), shim, { origin: { clientLocal: false }, ...body }, 403, "token_requires_local");
  await refuse(loopbackReq(), shim, body, 403, "token_requires_local");
  await refuse(loopbackReq(), { kind: "viewer", principal: "loopback" }, body, 403, "token_requires_local");
  await refuse(loopbackReq(), { kind: "reader", principal: "system:mcp" }, body, 403, "token_requires_local");
  assert.equal(hub.tokens.values().length, known);

  // Shape errors come after the locality check.
  await refuse(loopbackReq(), owner, { credential: "x" }, 400, "invalid_request");
  await refuse(loopbackReq(), owner, { credential: { hfToken: FAKE_TOKEN, remember: "yes" } }, 400, "invalid_request");
  await refuse(loopbackReq(), owner, { credential: { hfToken: 42 } }, 400, "invalid_request");
  await refuse(loopbackReq(), owner, { credential: { hfToken: "has space" } }, 422, "invalid_token");
  await refuse(loopbackReq(), owner, { credential: { remember: true } }, 400, "invalid_request");
  // No token: nothing to store.
  assert.equal(await accept(loopbackReq(), owner, {}), null);
  assert.equal(await accept(lanReq, { ...owner, network: "lan" }, { credential: { remember: false } }), null);

  // Responses carry the ref only; no hub file holds a token value.
  for (const file of ["settings.json", "downloads.json"]) {
    const full = path.join(dataDir, file);
    if (fs.existsSync(full)) {
      const content = fs.readFileSync(full, "utf8");
      assert.equal(content.includes(FAKE_TOKEN), false, file);
    }
  }
  await hub.stop();
  const scan = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? scan(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  for (const file of scan(dataDir)) assert.equal(fs.readFileSync(file, "latin1").includes(FAKE_TOKEN), false, path.basename(file));
});

test("remember without a secret store gives 422 remember_unavailable", async (t) => {
  const { hub } = await startHub(t);
  const owner = { kind: "owner", principal: "session:abcd1234", network: "loopback", via: "session" };
  await assert.rejects(
    hubRoutes.acceptHubCredential({ hub, req: loopbackReq(), who: owner, body: { credential: { hfToken: FAKE_TOKEN, remember: true } } }),
    (error) => error instanceof HubError && error.status === 422 && error.code === "remember_unavailable",
  );
  assert.deepEqual(hub.tokens.values(), []);
});
