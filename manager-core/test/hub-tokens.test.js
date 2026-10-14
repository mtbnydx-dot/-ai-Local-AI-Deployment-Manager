"use strict";

// Temporary token vault (docs/overhaul/03-hub.md §12, §17, HUB-5): memory-only
// by default, namespace "hf" in the secret store on request, and nothing
// secret in any file under the hub data directory. Everything uses a fake
// secret store and temp directories.

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { createTokenVault, isTokenRef, FAILED_RETENTION_MS, SECRET_NAMESPACE } = require("../model-hub/tokens");
const { createCliTransferEngine } = require("../model-hub/transfer");
const { createHubStore } = require("../model-hub/store");
const { HubError } = require("../model-hub/errors");

const TOKEN_A = "hf_FAKEaaaaFAKEaaaaFAKEaaaaFAKE0001";
const TOKEN_B = "fake-remembered-token-0002";
const HOUR = 60 * 60 * 1000;

function tempDir(t, prefix = "hub-tokens-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The namespace-first shape of manager-core/secret-store.js#createSecretVault,
// with the real store's asynchronous set/remove and synchronous reads.
function fakeSecretStore() {
  const spaces = new Map();
  const calls = [];
  const space = (ns) => {
    if (!spaces.has(ns)) spaces.set(ns, new Map());
    return spaces.get(ns);
  };
  return {
    calls,
    spaces,
    async set(ns, name, value) { calls.push(["set", ns, name]); space(ns).set(name, { value, createdAt: new Date(fakeNow.value).toISOString() }); },
    get: (ns, name) => space(ns).get(name)?.value || "",
    async remove(ns, name) { calls.push(["remove", ns, name]); return space(ns).delete(name); },
    list: (ns) => Array.from(space(ns), ([name, entry]) => ({ name, createdAt: entry.createdAt, updatedAt: entry.createdAt })),
    values: (namespaces) => (namespaces || Array.from(spaces.keys())).flatMap((ns) => Array.from(space(ns).values(), (entry) => entry.value)),
  };
}

const fakeNow = { value: Date.parse("2026-10-14T12:00:00Z") };
const fakeClock = { now: () => fakeNow.value };

test.beforeEach(() => {
  fakeNow.value = Date.parse("2026-10-14T12:00:00Z");
});

test("put, resolve and release keep a token in memory only", async () => {
  const store = fakeSecretStore();
  const vault = createTokenVault({ secretStore: store, clock: fakeClock });
  const ref = await vault.put(TOKEN_A);
  assert.match(ref, /^dlt_[a-z2-7]{16}$/);
  assert.equal(isTokenRef(ref), true);
  assert.equal(vault.resolve(ref), TOKEN_A);
  assert.equal(vault.has(ref), true);
  assert.deepEqual(vault.values(), [TOKEN_A]);
  assert.deepEqual(store.calls, [], "the secret store is not touched without remember");
  assert.equal(await vault.release(ref), true);
  assert.equal(vault.resolve(ref), null);
  assert.deepEqual(vault.values(), []);
  assert.equal(await vault.release(ref), false);
  // Two tokens get two refs.
  assert.notEqual(await vault.put(TOKEN_A), await vault.put(TOKEN_A));
});

test("resolve answers null for anything that is not a known ref", () => {
  const vault = createTokenVault({});
  for (const value of [null, undefined, "", "dlt_aaaaaaaaaaaaaaaa", "dlt_short", 42, "../../x"]) {
    assert.equal(vault.resolve(value), null);
  }
});

test("invalid tokens are refused with 422", async () => {
  const vault = createTokenVault({});
  for (const bad of ["", "   ", null, "has space inside", "line\nbreak", "x".repeat(600), "tökén-ünicode"]) {
    await assert.rejects(vault.put(bad), (error) => error instanceof HubError && error.code === "invalid_token" && error.status === 422);
  }
});

test("remember writes namespace hf to the secret store and release deletes it", async () => {
  const store = fakeSecretStore();
  const vault = createTokenVault({ secretStore: store, clock: fakeClock });
  const ref = await vault.put(TOKEN_B, { remember: true });
  assert.deepEqual(store.calls, [["set", SECRET_NAMESPACE, ref]]);
  assert.equal(SECRET_NAMESPACE, "hf");
  assert.equal(store.get("hf", ref), TOKEN_B);
  assert.equal(vault.resolve(ref), TOKEN_B);
  assert.equal(await vault.release(ref), true);
  assert.deepEqual(store.calls.at(-1), ["remove", "hf", ref]);
  assert.equal(store.get("hf", ref), "");
  assert.equal(vault.resolve(ref), null);
});

test("remember without a secret store gives 422 remember_unavailable and stores nothing", async () => {
  const vault = createTokenVault({ secretStore: null });
  await assert.rejects(vault.put(TOKEN_B, { remember: true }), (error) => error instanceof HubError && error.code === "remember_unavailable" && error.status === 422);
  assert.deepEqual(vault.values(), []);
  // Without remember a missing store is fine.
  assert.match(await vault.put(TOKEN_B), /^dlt_/);
});

test("a failed secret-store write leaves no ref behind", async () => {
  const store = fakeSecretStore();
  store.set = async () => { throw new Error("DPAPI unavailable"); };
  const vault = createTokenVault({ secretStore: store });
  await assert.rejects(vault.put(TOKEN_B, { remember: true }), /DPAPI unavailable/);
  assert.deepEqual(vault.values(), []);
});

test("a new vault after a restart loses unremembered tokens but finds remembered ones", async () => {
  const store = fakeSecretStore();
  const first = createTokenVault({ secretStore: store, clock: fakeClock });
  const temp = await first.put(TOKEN_A);
  const kept = await first.put(TOKEN_B, { remember: true });

  const second = createTokenVault({ secretStore: store, clock: fakeClock });
  assert.equal(second.resolve(temp), null, "the job would wait in waiting/auth");
  assert.equal(second.resolve(kept), TOKEN_B);
  assert.ok(second.values().includes(TOKEN_B));
});

test("a failed removal from the store is retried by the next sweep", async () => {
  const store = fakeSecretStore();
  const warnings = [];
  const vault = createTokenVault({ secretStore: store, clock: fakeClock, logger: { warn: (message) => warnings.push(message) } });
  const ref = await vault.put(TOKEN_B, { remember: true });
  const realRemove = store.remove;
  store.remove = async () => { throw new Error("locked"); };
  assert.equal(await vault.release(ref), true);
  assert.equal(store.get("hf", ref), TOKEN_B);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes(TOKEN_B), false);
  store.remove = realRemove;
  await vault.sweep([]);
  assert.equal(store.get("hf", ref), "");
});

function job(ref, state, extra = {}) {
  return { id: `dl_${ref.slice(4, 12)}`, state, transfer: { options: { tokenRef: ref } }, ...extra };
}

test("sweep releases ready and cancelled jobs, failed jobs after 7 days and unreferenced tokens", async () => {
  const store = fakeSecretStore();
  const vault = createTokenVault({ secretStore: store, clock: fakeClock });
  const refs = {};
  for (const name of ["downloading", "queued", "ready", "cancelled", "failedFresh", "failedOld", "plan", "removedRemembered"]) {
    refs[name] = await vault.put(`${TOKEN_A}-${name}`, { remember: name === "removedRemembered" });
  }
  fakeNow.value += 2 * HOUR;
  // A token put just now (a plan not yet enqueued) is inside the grace period.
  refs.fresh = await vault.put(`${TOKEN_A}-fresh`);
  const nowIso = new Date(fakeNow.value).toISOString();
  const old = new Date(fakeNow.value - FAILED_RETENTION_MS - HOUR).toISOString();
  const recent = new Date(fakeNow.value - FAILED_RETENTION_MS + HOUR).toISOString();
  const jobs = [
    job(refs.downloading, "downloading"),
    job(refs.queued, "queued"),
    job(refs.ready, "ready", { finishedAt: nowIso }),
    job(refs.cancelled, "cancelled", { finishedAt: nowIso }),
    job(refs.failedFresh, "failed", { finishedAt: recent }),
    job(refs.failedOld, "failed", { finishedAt: old }),
    { id: "dl_without", state: "ready", transfer: { options: { tokenRef: null } } },
  ];
  const released = await vault.sweep(jobs);
  assert.deepEqual(new Set(released), new Set([refs.ready, refs.cancelled, refs.failedOld, refs.plan, refs.removedRemembered]));
  for (const name of ["downloading", "queued", "failedFresh", "fresh"]) assert.ok(vault.resolve(refs[name]), name);
  for (const name of ["ready", "cancelled", "failedOld", "plan", "removedRemembered"]) assert.equal(vault.resolve(refs[name]), null, name);
  assert.equal(store.get("hf", refs.removedRemembered), "");
});

test("sweep at start drops old remembered tokens no job carries and keeps young or referenced ones", async () => {
  const store = fakeSecretStore();
  const before = createTokenVault({ secretStore: store, clock: fakeClock });
  const referenced = await before.put(TOKEN_B, { remember: true });
  const orphan = await before.put(`${TOKEN_B}-orphan`, { remember: true });
  fakeNow.value += 3 * HOUR;
  const young = await before.put(`${TOKEN_B}-young`, { remember: true });

  const restarted = createTokenVault({ secretStore: store, clock: fakeClock });
  const released = await restarted.sweep(new Map([["a", job(referenced, "paused")]]));
  assert.deepEqual(released, [orphan]);
  assert.equal(restarted.resolve(referenced), TOKEN_B);
  assert.ok(restarted.resolve(young));
  assert.equal(restarted.resolve(orphan), null);
});

test("sweep of an empty ledger is a no-op", async () => {
  const vault = createTokenVault({});
  assert.deepEqual(await vault.sweep([]), []);
  assert.deepEqual(await vault.sweep(null), []);
});

test("no token reaches downloads.json, history, logs or task files in the data directory", async (t) => {
  const root = tempDir(t);
  const dataDir = path.join(root, "data", "hub");
  const store = createHubStore({ dataDir });
  await store.init();
  const secrets = fakeSecretStore();
  const vault = createTokenVault({ secretStore: secrets, clock: fakeClock });
  const tokenRef = await vault.put(TOKEN_A, { remember: true });

  const fakeChildren = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 777;
    fakeChildren.push(child);
    setImmediate(() => {
      child.stdout.write(`token is ${TOKEN_A}\nHF_TOKEN=${TOKEN_A}\n`);
      child.stderr.write(`Bearer ${TOKEN_A}\n`);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 1, null));
    });
    return child;
  };
  const engine = createCliTransferEngine({
    hfCli: "hf", modelScopeCli: "modelscope", hfHome: path.join(root, "hf-home"), dataDir, spawnImpl, platform: "win32", env: { PATH: "x" }, tokens: vault,
  });
  const job = {
    id: "dl_7k2m4q9x3c5vb8np",
    state: "downloading",
    artifact: { repo: "org/model", revisionSha: "0123456789abcdef0123456789abcdef01234567", files: [] },
    target: { localDir: path.join(root, "models", "org-model") },
    transfer: { engine: "cli", batchIndex: 0, options: { source: "huggingface", endpoint: "https://huggingface.co", xet: "default", credentialMode: "temp-token", tokenRef, remember: true }, include: { mode: "all" } },
    logs: [],
  };
  const lines = [];
  const exit = await new Promise((resolve) => {
    engine.start(job, { onLine: (stream, text) => lines.push(text), onExit: resolve });
  });
  assert.equal(exit.code, 1);
  job.logs = lines;
  job.error = { code: "hf_auth_invalid", detail: lines.find((line) => line.includes("redacted")) || "" };
  await store.writeDownloads({ schemaVersion: 1, jobs: [job] });
  await store.appendHistory({ id: job.id, state: "failed", transfer: job.transfer, error: job.error });
  await store.flush();
  fs.mkdirSync(path.join(dataDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "tasks", "t1.json"), JSON.stringify({ job: job.id, transfer: job.transfer }));

  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  })(dataDir);
  assert.ok(files.some((file) => file.endsWith(`${job.id}.log`)), "the engine wrote the job log");
  assert.ok(files.some((file) => file.endsWith("downloads.json")));
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes(TOKEN_A), false, `${path.basename(file)} holds the token`);
    assert.equal(/hf_FAKEaaaa/.test(text), false, `${path.basename(file)} holds a token fragment`);
  }
  assert.ok(files.some((file) => fs.readFileSync(file, "utf8").includes("<redacted>")));
});
