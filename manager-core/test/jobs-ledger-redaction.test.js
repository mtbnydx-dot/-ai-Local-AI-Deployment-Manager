"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("..");

// Obviously fake keys, assembled at runtime (release privacy scan).
const FAKE_RUNTIME_KEY = "fake-runtime-key-0123456789";
const FAKE_HF = ["hf", "FAKEtoken0for0ledger0tests0"].join("_");

async function tempLedger(t, name = "jobs-ledger.json") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "jobs-ledger-redaction-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

function createStore(file, extra = {}) {
  const writes = [];
  const logLines = [];
  const store = core.createJobsLedgerStore({
    jobs: extra.jobs || new Map(),
    file,
    readJsonFile: core.readJsonFile,
    writeJsonFile: async (target, value) => {
      writes.push(target);
      return core.writeJsonFile(target, value);
    },
    maxLogLines: 50,
    onLog: (line) => logLines.push(line),
    ...extra,
  });
  return { store, writes, logLines };
}

async function flush(store) {
  store.clearJobsSaveTimer();
  await store.waitForJobsLedgerWrites();
  await store.saveJobsLedgerNow();
}

test("appendLog never stores a fixture key, by pattern or by exact value", async (t) => {
  const file = await tempLedger(t);
  const redact = core.createSecretRedactor({ getSecrets: () => [FAKE_RUNTIME_KEY] });
  const { store } = createStore(file, { redact });
  const job = store.createJob("serve", "Start");
  store.appendLog(job, `> docker run --name rt -e HF_TOKEN=${FAKE_HF} image --api-key ${FAKE_RUNTIME_KEY}`);
  store.appendLog(job, `engine echoed key ${FAKE_RUNTIME_KEY}\nsecond line`);
  await flush(store);
  const text = await fsp.readFile(file, "utf8");
  assert.equal(text.includes(FAKE_RUNTIME_KEY), false);
  assert.equal(text.includes(FAKE_HF), false);
  assert.deepEqual(job.logs, [
    "> docker run --name rt -e HF_TOKEN=<redacted> image --api-key <redacted>",
    "engine echoed key <redacted>",
    "second line",
  ]);
});

test("the default redactor removes secret-shaped text and appendJobLog callers outside the store are covered", async (t) => {
  const file = await tempLedger(t);
  const { store } = createStore(file);
  const job = store.createJob("download", "Download");
  store.appendLog(job, `HF_TOKEN=${FAKE_HF} hf download org/model`);
  assert.deepEqual(job.logs, ["HF_TOKEN=<redacted> hf download org/model"]);
  await flush(store);
  const outside = { logs: [] };
  core.appendJobLog(outside, `Authorization: Bearer ${FAKE_HF}`);
  assert.deepEqual(outside.logs, ["Authorization: Bearer <redacted>"]);
});

test("failJob redacts docker error text, stdout and stderr before they are stored", async (t) => {
  const file = await tempLedger(t);
  const redact = core.createSecretRedactor({ getSecrets: () => [FAKE_RUNTIME_KEY] });
  const { store } = createStore(file, { redact });
  const job = store.createJob("serve", "Start");
  const error = new Error(`Command failed: docker run -d --name rt image serve --api-key ${FAKE_RUNTIME_KEY}`);
  error.stdout = `ready key=${FAKE_RUNTIME_KEY}`;
  error.stderr = `trace ${FAKE_RUNTIME_KEY}`;
  store.failJob(job, error);
  assert.equal(job.status, "failed");
  assert.equal(job.error, "Command failed: docker run -d --name rt image serve --api-key <redacted>");
  assert.equal(JSON.stringify(job).includes(FAKE_RUNTIME_KEY), false, "progress detail and issues derive from the redacted text");
  await flush(store);
  assert.equal((await fsp.readFile(file, "utf8")).includes(FAKE_RUNTIME_KEY), false);
});

test("a directly set job.error and meta are redacted on write without mutating memory", async (t) => {
  const file = await tempLedger(t);
  const redact = core.createSecretRedactor({ getSecrets: () => [FAKE_RUNTIME_KEY] });
  const { store } = createStore(file, { redact });
  const job = store.createJob("serve", "Start", { command: `serve --api-key ${FAKE_RUNTIME_KEY}`, model: "org/model" });
  job.error = `Error: ${FAKE_RUNTIME_KEY}`;
  await flush(store);
  const saved = JSON.parse(await fsp.readFile(file, "utf8")).jobs[0];
  assert.equal(saved.error, "Error: <redacted>");
  assert.equal(saved.meta.command, "serve --api-key <redacted>");
  assert.equal(saved.meta.model, "org/model");
  assert.equal(job.meta.command.includes(FAKE_RUNTIME_KEY), true, "in-memory meta is not mutated by the save");
});

test("loading a ledger with keys rewrites it once and the second load is a no-op", async (t) => {
  const file = await tempLedger(t);
  await fsp.writeFile(file, JSON.stringify({
    version: 1,
    jobs: [{
      id: "job-1",
      type: "serve",
      title: "Start",
      status: "failed",
      logs: [`> docker run image --api-key ${FAKE_RUNTIME_KEY}`, "clean line", `token ${FAKE_HF}`],
      error: `Command failed: docker run --api-key ${FAKE_RUNTIME_KEY}`,
      meta: { command: `HF_TOKEN=${FAKE_HF}`, nested: ["fine"] },
      createdAt: "2026-10-01T00:00:00.000Z",
    }],
  }), "utf8");

  const first = createStore(file);
  await first.store.loadJobsLedgerIntoMemory();
  assert.equal(first.writes.length, 1, "dirty ledger is saved once");
  assert.deepEqual(first.logLines, ["jobs-ledger: redacted 4 secret-like strings on load"]);
  assert.equal(first.logLines.some((line) => line.includes(FAKE_RUNTIME_KEY) || line.includes(FAKE_HF)), false);
  const text = await fsp.readFile(file, "utf8");
  assert.equal(text.includes(FAKE_RUNTIME_KEY), false);
  assert.equal(text.includes(FAKE_HF), false);
  const saved = JSON.parse(text).jobs[0];
  assert.deepEqual(saved.logs, ["> docker run image --api-key <redacted>", "clean line", "token <redacted>"]);
  assert.equal(saved.meta.command, "HF_TOKEN=<redacted>");

  const second = createStore(file);
  await second.store.loadJobsLedgerIntoMemory();
  assert.equal(second.writes.length, 0, "a clean ledger is not rewritten");
  assert.deepEqual(second.logLines, []);
  assert.equal(await fsp.readFile(file, "utf8"), text);
});

test("a clean ledger loads without changes and running jobs still persist as interrupted", async (t) => {
  const file = await tempLedger(t);
  const clean = {
    version: 1,
    jobs: [{ id: "done", type: "download", title: "Download", status: "success", logs: ["ok"], meta: { repoId: "org/model" }, createdAt: "2026-10-01T00:00:00.000Z" }],
  };
  await fsp.writeFile(file, JSON.stringify(clean), "utf8");
  const { store, writes, logLines } = createStore(file);
  await store.loadJobsLedgerIntoMemory();
  assert.equal(writes.length, 0);
  assert.deepEqual(logLines, []);

  clean.jobs.push({ id: "live", type: "serve", title: "Start", status: "running", logs: [], createdAt: "2026-10-02T00:00:00.000Z" });
  await fsp.writeFile(file, JSON.stringify(clean), "utf8");
  const reload = createStore(file);
  await reload.store.loadJobsLedgerIntoMemory();
  assert.equal(reload.writes.length, 1);
  const saved = JSON.parse(await fsp.readFile(file, "utf8"));
  assert.equal(saved.jobs.find((job) => job.id === "live").status, "interrupted");
});

test("a throwing custom redactor falls back to the patterns", async (t) => {
  const file = await tempLedger(t);
  const { store } = createStore(file, { redact: () => { throw new Error("boom"); } });
  const job = store.createJob("serve", "Start");
  store.appendLog(job, "--api-key abc12345");
  assert.deepEqual(job.logs, ["--api-key <redacted>"]);
  await flush(store);
});

test("/api/logs output is redacted by default and by the server redactor", async () => {
  function makeResponse() {
    const state = {};
    const res = {
      status(code) { state.statusCode = code; return this; },
      type(value) { state.type = value; return this; },
      send(value) { state.sent = value; return value; },
      json(value) { state.json = value; return value; },
    };
    return { res, state };
  }
  const register = (deps) => {
    const routes = new Map();
    core.registerRuntimeRoutes({
      get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
      post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
    }, deps);
    return routes.get("GET /api/logs");
  };

  let handler = register({ readRuntimeLogs: async () => `INFO args: --api-key abc12345 --port 8000\nINFO key ${FAKE_RUNTIME_KEY}` });
  let response = makeResponse();
  await handler({ query: {} }, response.res);
  assert.equal(response.state.sent, `INFO args: --api-key <redacted> --port 8000\nINFO key ${FAKE_RUNTIME_KEY}`);

  handler = register({
    readRuntimeLogs: async () => ({ text: `INFO key ${FAKE_RUNTIME_KEY}`, type: "text/plain" }),
    redactLogs: core.createSecretRedactor({ getSecrets: () => [FAKE_RUNTIME_KEY] }),
  });
  response = makeResponse();
  await handler({ query: {} }, response.res);
  assert.equal(response.state.sent, "INFO key <redacted>");

  handler = register({
    readRuntimeLogs: async () => {
      const error = new Error(`Command failed: docker logs --tail 10 rt --token ${FAKE_RUNTIME_KEY}`);
      error.status = 502;
      throw error;
    },
  });
  response = makeResponse();
  await handler({ query: {} }, response.res);
  assert.equal(response.state.statusCode, 502);
  assert.equal(response.state.sent, "Command failed: docker logs --tail 10 rt --token <redacted>");
});
