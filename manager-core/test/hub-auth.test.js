"use strict";

// Shared Hugging Face auth, the access probe and the source probe (docs/
// overhaul/03-hub.md §12, §13, HUB-11), plus the token lifecycle as the hub
// wires it. The hf CLI is a stub execFile, every fetch is a fake, and the
// secret store is in memory; nothing here touches the network or the live
// root.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createHubAuth, pickProbeFile } = require("../model-hub/auth");
const { createSourceProbe } = require("../model-hub/sources");
const { createModelHub } = require("../model-hub");
const { createHubStore } = require("../model-hub/store");
const { createTokenVault } = require("../model-hub/tokens");
const { listArtifacts } = require("../model-hub/selection");
const { normalizeRepoInfo } = require("../model-hub/providers/huggingface");
const { HubError } = require("../model-hub/errors");

const FIXTURES = path.join(__dirname, "fixtures", "hub");
const DAY = 24 * 60 * 60 * 1000;
// Obviously fake; assembled so no scanner mistakes them for real tokens.
const TOKEN_TEMP = ["hf", "_", "FAKEtempFAKEtempFAKEtemp0001"].join("");
const TOKEN_KEPT = ["hf", "_", "FAKErememberedFAKEkept0002"].join("");
const TOKEN_OLD = ["hf", "_", "FAKEexpiredFAKEexpired0003"].join("");

function tempDir(t, prefix = "hub-auth-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function manifestOf(name, repo) {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
  return normalizeRepoInfo(raw, { repo: repo || raw.id, fetchedFrom: "https://huggingface.co", now: Date.parse("2026-10-14T08:00:00Z") });
}

function quietLogger() {
  return { warn() {}, info() {}, error() {}, debug() {} };
}

// A stub of execFile: `handler(args, env)` returns stdout, or throws an error
// carrying stderr. Every call is recorded.
function fakeExec(handler) {
  const calls = [];
  const impl = (command, args, options, callback) => {
    calls.push({ command, args: [...args], env: { ...options.env } });
    let out;
    try {
      out = handler(args, options.env);
    } catch (error) {
      callback(Object.assign(new Error(error.message), { stderr: error.stderr || error.message }), "", error.stderr || "");
      return;
    }
    callback(null, out, "");
  };
  impl.calls = calls;
  return impl;
}

const whoami = JSON.stringify({ user: "example-user", orgs: [] });

function providersFor(manifest) {
  const seen = [];
  return {
    seen,
    get(id) {
      assert.equal(id, "huggingface");
      return { getRepo: async (repo, opts) => { seen.push({ repo, opts }); return manifest; } };
    },
  };
}

// The namespace-first view of the secret store (see hub-tokens.test.js).
function fakeSecretStore(clock) {
  const spaces = new Map();
  const space = (ns) => {
    if (!spaces.has(ns)) spaces.set(ns, new Map());
    return spaces.get(ns);
  };
  return {
    spaces,
    async set(ns, name, value) { space(ns).set(name, { value, createdAt: new Date(clock.now()).toISOString() }); },
    get: (ns, name) => space(ns).get(name)?.value || "",
    async remove(ns, name) { return space(ns).delete(name); },
    list: (ns) => Array.from(space(ns), ([name, entry]) => ({ name, createdAt: entry.createdAt, updatedAt: entry.createdAt })),
    values: (namespaces) => (namespaces || Array.from(spaces.keys())).flatMap((ns) => Array.from(space(ns).values(), (entry) => entry.value)),
  };
}

function filesUnder(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full));
    else found.push(full);
  }
  return found;
}

function assertNoSecretUnder(dir, secrets) {
  const files = filesUnder(dir);
  assert.ok(files.length > 0, "the data directory has files to scan");
  for (const file of files) {
    const content = fs.readFileSync(file, "latin1");
    for (const secret of secrets) assert.equal(content.includes(secret), false, `${path.basename(file)} must not contain a token`);
  }
}

// --- the probe file ------------------------------------------------------------

test("pickProbeFile reads the first weight file of the selected artifact, never config.json", () => {
  const gguf = manifestOf("hf-gguf-multiquant.json");
  const artifacts = listArtifacts(gguf);
  const first = artifacts[0].files.filter((file) => file.role === "weight").map((file) => file.path).sort()[0];
  assert.equal(pickProbeFile(gguf), first);
  assert.match(pickProbeFile(gguf), /\.gguf$/);

  const sharded = artifacts.find((artifact) => artifact.multiPart);
  assert.ok(sharded, "the fixture has a sharded quant");
  assert.equal(pickProbeFile(gguf, { artifactKey: sharded.artifactKey }), "BF16/Example-8B-BF16-00001-of-00002.gguf");
  const q8 = artifacts.find((artifact) => artifact.quant === "Q8_0");
  assert.equal(pickProbeFile(gguf, { artifactKey: q8.artifactKey }), "Example-8B-Q8_0.gguf");

  const fp8 = manifestOf("hf-fp8-generic-shards.json");
  assert.equal(pickProbeFile(fp8), "model-00001-of-00003.safetensors");

  // No recognisable artifact: the first weight-looking file, then any file.
  assert.equal(pickProbeFile({ files: [{ path: "weights/model.bin" }, { path: "config.json" }] }), "weights/model.bin");
  assert.equal(pickProbeFile({ files: [{ path: "README.md" }, { path: "config.json" }] }), "README.md");
  assert.equal(pickProbeFile({ files: [] }), null);

  assert.throws(() => pickProbeFile(gguf, { artifactKey: "gguf:|NOPE" }), (error) => error.code === "artifact_not_found");
});

// --- access ----------------------------------------------------------------------

test("access probes the first weight file of the artifact and reports the status", async () => {
  const exec = fakeExec((args) => (args[0] === "auth" ? whoami : "{}"));
  const providers = providersFor(manifestOf("hf-gguf-multiquant.json"));
  const auth = createHubAuth({ hfCli: "hf-stub", hfHome: "hf-home", providers, execFileImpl: exec, baseEnv: {}, logger: quietLogger() });

  const q8 = listArtifacts(manifestOf("hf-gguf-multiquant.json")).find((artifact) => artifact.quant === "Q8_0");
  const granted = await auth.access({ repo: "example-org/Example-8B-GGUF", artifactKey: q8.artifactKey });
  assert.deepEqual(granted, { granted: true, status: "granted", username: "example-user", authorizationUrl: null });
  const download = exec.calls.find((call) => call.args[0] === "download");
  assert.deepEqual(download.args.slice(0, 4), ["download", "example-org/Example-8B-GGUF", "Example-8B-Q8_0.gguf", "--dry-run"]);
  assert.equal(download.args.includes("config.json"), false);
  assert.deepEqual(providers.seen[0], { repo: "example-org/Example-8B-GGUF", opts: { revision: "main" } });

  // Without an artifactKey the first listed artifact decides.
  exec.calls.length = 0;
  await auth.access({ repo: "example-org/Example-8B-GGUF" });
  assert.match(exec.calls.find((call) => call.args[0] === "download").args[2], /\.gguf$/);
});

test("access reports approval_required with the repo page, and maps manifest failures", async () => {
  const gated = fakeExec((args) => {
    if (args[0] === "auth") return whoami;
    throw Object.assign(new Error("403 Forbidden"), { stderr: "Access to model is restricted. You must have access (gated) - approval required." });
  });
  const auth = createHubAuth({ hfCli: "hf-stub", providers: providersFor(manifestOf("hf-fp8-generic-shards.json")), execFileImpl: gated, baseEnv: {}, logger: quietLogger() });
  const denied = await auth.access({ repo: "example-org/Example-8B-FP8" });
  assert.deepEqual([denied.granted, denied.status, denied.authorizationUrl], [false, "approval_required", "https://huggingface.co/example-org/Example-8B-FP8"]);
  assert.equal(gated.calls.find((call) => call.args[0] === "download").args[2], "model-00001-of-00003.safetensors");

  const loggedOut = fakeExec(() => { throw Object.assign(new Error("not logged in"), { stderr: "Not logged in" }); });
  const anonymous = createHubAuth({ hfCli: "hf-stub", providers: providersFor(manifestOf("hf-fp8-generic-shards.json")), execFileImpl: loggedOut, baseEnv: {}, logger: quietLogger() });
  assert.equal((await anonymous.access({ repo: "example-org/Example-8B-FP8" })).status, "login_required");

  const notFound = Object.assign(new Error("missing"), { name: "ProviderError", code: "repo_not_found" });
  const missing = createHubAuth({ hfCli: "hf-stub", providers: { get: () => ({ getRepo: async () => { throw notFound; } }) }, execFileImpl: gated, baseEnv: {}, logger: quietLogger() });
  assert.deepEqual(await missing.access({ repo: "example-org/Gone" }), { granted: false, status: "not_found", username: null, authorizationUrl: null });

  await assert.rejects(auth.access({ repo: "not a repo" }), (error) => error instanceof HubError && error.status === 400 && error.code === "invalid_request");
});

test("a tokenRef is resolved for the CLI env and the manifest read, and never echoed", async () => {
  const vault = createTokenVault({ logger: quietLogger() });
  const tokenRef = await vault.put(TOKEN_TEMP);
  const exec = fakeExec((args) => (args[0] === "auth" ? whoami : "{}"));
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), authorization: new Headers(init.headers).get("authorization") });
    return new Response(fs.readFileSync(path.join(FIXTURES, "hf-fp8-generic-shards.json")), { status: 200, headers: { "content-type": "application/json" } });
  };
  const auth = createHubAuth({ hfCli: "hf-stub", tokens: vault, fetchImpl, execFileImpl: exec, baseEnv: {}, logger: quietLogger() });

  const result = await auth.access({ repo: "example-org/Example-8B-FP8", tokenRef });
  assert.equal(result.granted, true);
  assert.equal(JSON.stringify(result).includes(TOKEN_TEMP), false);
  assert.ok(exec.calls.every((call) => call.env.HF_TOKEN === TOKEN_TEMP), "the CLI gets the token through its environment only");
  assert.ok(exec.calls.every((call) => !call.args.join(" ").includes(TOKEN_TEMP)), "never on the command line");
  assert.ok(sent.length > 0 && sent.every((call) => call.url.startsWith("https://huggingface.co/") && call.authorization === `Bearer ${TOKEN_TEMP}`));

  const status = await auth.status({ tokenRef });
  assert.deepEqual(status, { connected: true, username: "example-user", orgs: [], source: "temporary" });

  await vault.release(tokenRef);
  await assert.rejects(auth.access({ repo: "example-org/Example-8B-FP8", tokenRef }), (error) => error.code === "hf_token_expired" && error.status === 409);
  await assert.rejects(auth.status({ tokenRef: "dlt_notaknownref00000" }), (error) => error.code === "hf_token_expired");
});

test("login opens the local window through the CLI wrapper and reports an unsupported host", () => {
  const launched = [];
  const auth = createHubAuth({
    hfCli: "hf-stub",
    hfHome: "hf-home",
    providers: null,
    platform: "win32",
    execFileSyncImpl: (command, args) => { launched.push({ command, args }); },
    baseEnv: {},
    logger: quietLogger(),
  });
  assert.deepEqual(auth.login(), { launched: true, tokenUrl: "https://huggingface.co/settings/tokens" });
  assert.equal(launched.length, 1);
  assert.equal(launched[0].command, "powershell.exe");

  const linux = createHubAuth({ hfCli: "hf-stub", providers: null, platform: "linux", baseEnv: {}, logger: quietLogger() });
  assert.throws(() => linux.login(), (error) => error instanceof HubError && error.status === 501 && error.code === "hf_login_terminal_required");
});

// --- source probe ----------------------------------------------------------------

test("the source probe times the first weight file, sends no credential and caches for ten minutes", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()) });
    const slow = String(url).includes("hf-mirror") ? 1 : 0;
    if (slow) await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(new Uint8Array(1024), { status: 206 });
  };
  let now = Date.parse("2026-10-14T08:00:00Z");
  const clock = { now: () => now };
  const auth = createHubAuth({ hfCli: "hf-stub", providers: providersFor(manifestOf("hf-gguf-multiquant.json")), baseEnv: {}, logger: quietLogger() });
  const probe = createSourceProbe({ auth, fetchImpl, clock });

  const first = await probe.probe({ repo: "example-org/Example-8B-GGUF" });
  assert.equal(first.repo, "example-org/Example-8B-GGUF");
  assert.match(first.file, /\.gguf$/);
  assert.deepEqual(first.sources.map((source) => source.source), ["huggingface", "hf-mirror", "modelscope"]);
  assert.ok(first.sources.every((source) => source.ok && typeof source.ms === "number" && typeof source.bytesPerSec === "number"));
  assert.ok(["huggingface", "hf-mirror", "modelscope"].includes(first.recommended));
  assert.equal(first.at, "2026-10-14T08:00:00.000Z");
  assert.ok(requests.some((request) => request.url.includes(encodeURIComponent(first.file))), "the weight file is what is read");
  assert.ok(requests.every((request) => request.headers.authorization === undefined), "no credential on any probe request");
  const count = requests.length;

  now += 9 * 60 * 1000;
  assert.deepEqual(await probe.probe({ repo: "example-org/Example-8B-GGUF" }), first);
  assert.equal(requests.length, count, "cached");
  now += 2 * 60 * 1000;
  const later = await probe.probe({ repo: "example-org/Example-8B-GGUF" });
  assert.ok(requests.length > count, "re-measured after ten minutes");
  assert.notEqual(later.at, first.at);

  // No repo: the shared default file of mirror-probe.js.
  const bare = await probe.probe({});
  assert.equal(bare.file, "config.json");

  await assert.rejects(probe.probe({ repo: "bad repo" }), (error) => error.code === "invalid_request");
  await assert.rejects(probe.probe({ artifactKey: "gguf:|Q4_K_M" }), (error) => error.code === "invalid_request");
});

test("a failed source is reported with its error and never persists settings", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("modelscope")) throw new Error("getaddrinfo ENOTFOUND");
    return new Response(new Uint8Array(512), { status: 206 });
  };
  const probe = createSourceProbe({ auth: { probeFile: async () => null }, fetchImpl });
  const result = await probe.probe({});
  const ms = result.sources.find((source) => source.source === "modelscope");
  assert.equal(ms.ok, false);
  assert.match(ms.error, /ENOTFOUND/);
  assert.equal(result.ok, true);
  assert.notEqual(result.recommended, "modelscope");
});

// --- token lifecycle in the hub -------------------------------------------------

test("the hub releases tokens on ready, on cancel and seven days after a failure, at start and hourly", async (t) => {
  const root = tempDir(t);
  const dataDir = path.join(root, "hub");
  const clock = { value: Date.parse("2026-10-14T12:00:00Z"), now() { return this.value; } };
  const secretStore = fakeSecretStore(clock);
  const seedVault = createTokenVault({ secretStore, clock, logger: quietLogger() });
  const refs = {
    ready: await seedVault.put(TOKEN_TEMP, { remember: true }),
    cancelled: await seedVault.put(`${TOKEN_TEMP}-b`, { remember: true }),
    expired: await seedVault.put(TOKEN_OLD, { remember: true }),
    recent: await seedVault.put(TOKEN_KEPT, { remember: true }),
    running: await seedVault.put(`${TOKEN_KEPT}-c`, { remember: true }),
  };
  const iso = (offsetMs) => new Date(clock.now() + offsetMs).toISOString();
  const job = (id, state, ref, extra = {}) => ({ id, state, transfer: { options: { credentialMode: "temp-token", tokenRef: ref, remember: true } }, ...extra });
  const store = createHubStore({ dataDir, clock });
  await store.init();
  await store.writeDownloads({ jobs: [
    job("dl_1", "ready", refs.ready, { finishedAt: iso(-1000) }),
    job("dl_2", "cancelled", refs.cancelled, { finishedAt: iso(-1000) }),
    job("dl_3", "failed", refs.expired, { finishedAt: iso(-8 * DAY) }),
    job("dl_4", "failed", refs.recent, { finishedAt: iso(-1 * DAY) }),
    job("dl_5", "downloading", refs.running),
  ] });
  await store.flush();

  const hub = createModelHub({ aiRoot: root, dataDir, env: {}, clock, secretStore, logger: quietLogger(), heartbeatMs: 3_600_000, tokenSweepMs: 20 });
  await hub.start();
  t.after(() => hub.stop());

  const left = () => secretStore.list("hf").map((item) => item.name).sort();
  assert.deepEqual(left(), [refs.recent, refs.running].sort(), "ready, cancelled and 8-day-old failed tokens are released at start");
  assert.equal(hub.tokens.resolve(refs.recent), TOKEN_KEPT, "a remembered token that is still needed survives the restart");

  // Eight days later the failed job's token expires on the hourly sweep.
  clock.value += 8 * DAY;
  const deadline = Date.now() + 3000;
  while (left().includes(refs.recent) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(left(), [refs.running]);
  assert.equal(hub.tokens.resolve(refs.recent), null);
  assert.equal(hub.tokens.has(refs.running), true);
});

test("remember without a secret store gives 422 remember_unavailable, and no token reaches any hub file", async (t) => {
  const root = tempDir(t);
  const dataDir = path.join(root, "hub");
  const hub = createModelHub({ aiRoot: root, dataDir, env: {}, logger: quietLogger(), heartbeatMs: 3_600_000 });
  await hub.start();
  t.after(() => hub.stop());

  await assert.rejects(hub.tokens.put(TOKEN_TEMP, { remember: true }), (error) => error instanceof HubError && error.status === 422 && error.code === "remember_unavailable");
  assert.equal(hub.status().features.rememberToken, false);

  const tokenRef = await hub.tokens.put(TOKEN_TEMP);
  assert.equal(hub.tokens.resolve(tokenRef), TOKEN_TEMP);
  assert.deepEqual(hub.tokens.values(), [TOKEN_TEMP]);

  // Exercise every path that writes: settings, the heartbeat stamp, a stop.
  await hub.settings.update({ transfer: { maxConcurrent: 2 } });
  const bodies = [hub.status(), await hub.settings.get()];
  for (const body of bodies) assert.equal(JSON.stringify(body).includes(TOKEN_TEMP), false);
  await hub.stop();
  assertNoSecretUnder(dataDir, [TOKEN_TEMP]);

});
