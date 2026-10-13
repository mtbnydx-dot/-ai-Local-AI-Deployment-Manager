"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("..");

function fakeDocker(outputs = {}) {
  const calls = [];
  const docker = async (args, options) => {
    calls.push({ args, options });
    const name = args.at(-1);
    return { stdout: outputs[name] ?? `logs of ${name}\n`, stderr: "" };
  };
  return { docker, calls };
}

function logHandlers({ docker, resolveLogContainer } = {}) {
  return core.createRuntimeRequestHandlers({
    docker,
    containerName: "vllm-local",
    defaultTail: 200,
    maxTail: 2000,
    ...(resolveLogContainer ? { resolveLogContainer } : {}),
  });
}

function parseUnknownInstance(result) {
  assert.equal(result.status, 404);
  assert.equal(result.type, "application/json");
  const payload = JSON.parse(result.text);
  assert.equal(payload.code, "unknown_instance");
  assert.match(payload.error, / \/ No runtime instance owned by this manager matches the request\.$/);
  return payload;
}

test("logs without an instance read the primary container as before", async () => {
  const { docker, calls } = fakeDocker({ "vllm-local": "primary log\n" });
  let resolverCalls = 0;
  const handlers = logHandlers({ docker, resolveLogContainer: async () => { resolverCalls += 1; return "other"; } });
  assert.equal(await handlers.readRuntimeLogsRequest({ query: { tail: "50" } }), "primary log\n");
  assert.equal(await handlers.readRuntimeLogsRequest({ query: { instance: "" } }), "primary log\n");
  assert.equal(await handlers.readRuntimeLogsRequest(), "primary log\n");
  assert.deepEqual(calls.map((call) => call.args), [
    ["logs", "--tail", "50", "vllm-local"],
    ["logs", "--tail", "200", "vllm-local"],
    ["logs", "--tail", "200", "vllm-local"],
  ]);
  assert.equal(resolverCalls, 0);
});

test("an unknown or unowned instance returns 404 unknown_instance without invoking docker", async () => {
  const { docker, calls } = fakeDocker();
  const resolved = [];
  const handlers = logHandlers({
    docker,
    resolveLogContainer: async (instance) => { resolved.push(instance); return null; },
  });
  parseUnknownInstance(await handlers.readRuntimeLogsRequest({ query: { instance: "someone-elses-container" } }));
  assert.deepEqual(resolved, ["someone-elses-container"]);
  // Names that are not container names or instance ids never reach the resolver.
  for (const instance of ["--format={{json .}}", "../vllm-local", "a b", ["code", "other"], { name: "code" }, " "]) {
    parseUnknownInstance(await handlers.readRuntimeLogsRequest({ query: { instance } }));
  }
  assert.deepEqual(resolved, ["someone-elses-container"]);
  // Without a resolver no instance can be proven to be ours.
  parseUnknownInstance(await logHandlers({ docker }).readRuntimeLogsRequest({ query: { instance: "code" } }));
  assert.equal(calls.length, 0);
});

test("a known instance reads its own container, never the caller-provided name", async () => {
  const { docker, calls } = fakeDocker({ "vllm-local-code": "parallel log\n" });
  const handlers = logHandlers({
    docker,
    resolveLogContainer: async (instance) => (instance === "code" ? "vllm-local-code" : null),
  });
  assert.equal(await handlers.readRuntimeLogsRequest({ query: { instance: "code", tail: "5000" } }), "parallel log\n");
  assert.deepEqual(calls.map((call) => call.args), [["logs", "--tail", "2000", "vllm-local-code"]]);
});

test("the /api/logs route sends the unknown_instance JSON with status 404", async () => {
  const { docker, calls } = fakeDocker();
  const handlers = logHandlers({ docker, resolveLogContainer: async () => null });
  const routes = new Map();
  const app = {
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
    delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
  };
  core.registerRuntimeRoutes(app, { readRuntimeLogs: handlers.readRuntimeLogsRequest });
  const response = {
    statusCode: 200,
    contentType: "",
    body: "",
    status(code) { this.statusCode = code; return this; },
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; },
  };
  await routes.get("GET /api/logs")({ query: { instance: "missing" } }, response);
  assert.equal(response.statusCode, 404);
  assert.equal(response.contentType, "application/json");
  assert.equal(JSON.parse(response.body).code, "unknown_instance");
  assert.equal(calls.length, 0);
});

test("the owned-container resolver accepts only containers this manager owns", async () => {
  const statuses = {
    "vllm-local": { exists: true, labels: {} },
  };
  const managed = [
    { name: "vllm-local-code", manager: "vllm-manager", engine: "sglang", labels: { "ai.manager.instance": "code" } },
    { name: "vllm-local-chat", manager: "vllm-manager", engine: "vllm", labels: { "ai.manager.instance": "chat" } },
    { name: "llama-local-gguf", manager: "llama-manager", engine: "llama", labels: { "ai.manager.instance": "gguf" } },
    { name: "vllm-local-bench", manager: "vllm-manager", engine: "benchmark", labels: { "ai.manager.instance": "bench" } },
  ];
  const resolve = core.createOwnedRuntimeContainerResolver({
    primaryContainerName: "vllm-local",
    managerId: "vllm-manager",
    ownerLabelKey: "ai.manager",
    engines: ["vllm", "sglang"],
    getContainerStatus: async (name) => statuses[name] || { exists: false },
    listManagedContainers: async () => managed,
  });
  assert.equal(await resolve("primary"), "vllm-local");
  assert.equal(await resolve("vllm-local"), "vllm-local");
  assert.equal(await resolve("code"), "vllm-local-code");
  assert.equal(await resolve("vllm-local-chat"), "vllm-local-chat");
  assert.equal(await resolve("gguf"), null);
  assert.equal(await resolve("llama-local-gguf"), null);
  assert.equal(await resolve("bench"), null);
  assert.equal(await resolve("unknown"), null);
  assert.equal(await resolve(""), null);

  statuses["vllm-local"] = { exists: true, labels: { "ai.manager": "vllm-manager" } };
  assert.equal(await resolve("primary"), "vllm-local");
  statuses["vllm-local"] = { exists: true, labels: { "ai.manager": "llama-manager" } };
  assert.equal(await resolve("primary"), null);
  statuses["vllm-local"] = { exists: false };
  assert.equal(await resolve("primary"), null);
});

test("serve jobs are attributed to the container that they launched", () => {
  const jobs = new Map([
    ["legacy", { id: "legacy", type: "serve", meta: { model: "m" } }],
    ["primary", { id: "primary", type: "serve", meta: { containerName: "vllm-local" } }],
    ["parallel", { id: "parallel", type: "serve", meta: { containerName: "vllm-local-code" } }],
    ["download", { id: "download", type: "download", meta: { containerName: "vllm-local-code" } }],
  ]);
  const ids = (list) => list.map((job) => job.id);
  assert.deepEqual(ids(core.serveJobsForContainer(jobs.values(), "vllm-local", { primaryContainerName: "vllm-local" })), ["legacy", "primary"]);
  assert.deepEqual(ids(core.serveJobsForContainer(jobs.values(), "vllm-local-code", { primaryContainerName: "vllm-local" })), ["parallel"]);
  assert.deepEqual(ids(core.serveJobsForContainer([...jobs.values()], "vllm-local-missing", { primaryContainerName: "vllm-local" })), []);
});
