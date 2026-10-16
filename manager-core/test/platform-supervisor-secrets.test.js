"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const configApi = require("../platform/config");
const { createLauncher } = require("../platform/launcher");
const searchHook = require("../platform/hooks/search-gateway");
const { createSecretVault } = require("../secret-store");
const { createFakeDpapi } = require("./fixtures/secrets/fake-dpapi");
const { createWorld } = require("./fixtures/platform/supervisor-world");

const API_KEY = "fixture-search-api-value-001";
const UPSTREAM_KEY = "fixture-search-upstream-value-002";

async function searchWorld(t, { adopt = false, dpapiAvailable = true, initialSecrets = true, profile = "none" } = {}) {
  const world = createWorld(t, { profile });
  const dpapiCalls = [];
  const vaultOptions = { aiRoot: world.aiRoot, dpapi: createFakeDpapi({ calls: dpapiCalls, failProbe: !dpapiAvailable }), acl: { async secure() {} } };
  const writer = createSecretVault(vaultOptions);
  if (initialSecrets) {
    await writer.set("platform", "search.apiKey", API_KEY);
    await writer.set("platform", "search.upstreamApiKey", UPSTREAM_KEY);
  }
  // Reopen the persisted store: do not accidentally test only a writer cache.
  const secrets = createSecretVault(vaultOptions);
  const config = configApi.loadPlatformConfig({ aiRoot: world.aiRoot, env: {}, secrets });
  if (initialSecrets) {
    assert.equal(config.sources["search.apiKey"], "store");
    assert.equal(config.sources["search.upstreamApiKey"], "store");
    const stored = JSON.parse(fs.readFileSync(path.join(world.aiRoot, ".runtime", "secrets", "platform.json"), "utf8"));
    assert.equal(stored.protection, dpapiAvailable ? "dpapi-user" : "acl-only");
    if (dpapiAvailable) {
      assert.ok(dpapiCalls.some((call) => call.request.op === "unprotect"));
      assert.ok(!JSON.stringify(stored).includes(API_KEY));
      assert.ok(!JSON.stringify(stored).includes(UPSTREAM_KEY));
    }
  }
  const commands = [], logs = [];
  let hookCalls = 0;
  const launch = createLauncher({
    aiRoot: world.aiRoot, winproc: world.winproc, getSecrets: () => secrets.values(),
    appendLog: (line) => logs.push(line),
    execFile(command, args, options, callback) {
      commands.push({ command, args, options });
      if (args.at(-1) === "down") {
        world.listeners.length = 0;
        world.up.delete("search-gateway");
      } else {
        assert.equal(args.at(-2), "up");
        world.up.add("search-gateway");
      }
      callback(null, "", "");
    },
  });
  if (adopt) {
    world.up.add("search-gateway");
    world.listen(5180, 6100, { processCreatedAt: "2026-10-16T00:00:00.000Z", exe: "C:\\fixture\\com.docker.backend.exe", commandLine: "com.docker.backend.exe" });
  }
  const launcher = {
    ...world.launcher,
    start: (spec, options) => (spec.kind === "compose" ? launch : world.launcher).start(spec, options),
    stop: (spec, options) => (spec.kind === "compose" ? launch : world.launcher).stop(spec, options),
    adopt: (spec, info) => (spec.kind === "compose" ? launch : world.launcher).adopt(spec, info),
    readIdentity: (id) => id === "search-gateway" ? launch.readIdentity(id) : world.launcher.readIdentity(id),
  };
  const supervisor = world.create({
    config, secrets, launcher, log: (line) => logs.push(line),
    loadHook: () => ({ async prepare(ctx) { hookCalls += 1; return searchHook.prepare(ctx); } }),
  });
  return { world, supervisor, migrationSecrets: writer, commands, logs, hookCalls: () => hookCalls };
}

function assertSearchEnv(command, apiKey = API_KEY, upstreamKey = UPSTREAM_KEY) {
  assert.equal(command.command, "docker");
  assert.equal(command.options.env.SEARCH_GATEWAY_API_KEY, apiKey);
  assert.equal(command.options.env.UPSTREAM_API_KEY, upstreamKey);
  assert.equal(command.options.env.UPSTREAM_BASE_URL, "http://host.docker.internal:5186/v1");
  assert.equal(command.options.windowsHide, true);
  assert.deepEqual(command.args.slice(-2), ["up", "-d"]);
  for (const key of [apiKey, upstreamKey]) assert.ok(!command.args.join(" ").includes(key));
}

async function assertPublicRedaction(fixture, extraKeys = []) {
  const { world, supervisor, commands, logs } = fixture;
  await world.clock.flush();
  const described = await supervisor.describeComponent("search-gateway");
  assert.equal(described.spec.env.SEARCH_GATEWAY_API_KEY, "<redacted>");
  assert.equal(described.spec.env.UPSTREAM_API_KEY, "<redacted>");
  const publicData = JSON.stringify({ described, status: await supervisor.status(), operations: await supervisor.operations(), events: world.events, logs });
  const events = fs.readFileSync(path.join(world.aiRoot, "logs", "platform", "events.jsonl"), "utf8");
  for (const key of [API_KEY, UPSTREAM_KEY, ...extraKeys]) {
    assert.ok(!publicData.includes(key));
    assert.ok(!events.includes(key));
    assert.ok(!JSON.stringify(commands.map(({ command, args }) => ({ command, args }))).includes(key));
  }
}

test("core can start before store import, then full and explicit restart resolve the current search secrets", async (t) => {
  const fixture = await searchWorld(t, { initialSecrets: false, profile: "core" });
  const migrate = async (key, value) => {
    const result = await configApi.setSecretLeaf(key, value, { aiRoot: fixture.world.aiRoot, env: {}, secrets: fixture.migrationSecrets });
    assert.equal(result.ok, true);
    assert.ok(!JSON.stringify(result).includes(value));
  };
  await fixture.supervisor.start();
  assert.equal(fixture.supervisor.records.get("entry").state, "ready");
  assert.equal(fixture.supervisor.records.get("search-gateway").spec.env.SEARCH_GATEWAY_API_KEY, undefined);
  await migrate("search.apiKey", API_KEY);
  await migrate("search.upstreamApiKey", UPSTREAM_KEY);
  const started = await fixture.supervisor.startProfile("full", { runtimeOverrides: {} });
  await fixture.world.clock.flush();
  assert.equal((await fixture.supervisor.operation(started.opId)).state, "ok");
  assert.equal(fixture.commands.length, 1);
  assertSearchEnv(fixture.commands[0]);
  const nextApiKey = "fixture-search-api-rotated-003";
  const nextUpstreamKey = "fixture-search-upstream-rotated-004";
  await migrate("search.apiKey", nextApiKey);
  await migrate("search.upstreamApiKey", nextUpstreamKey);
  await fixture.supervisor.restart("search-gateway", { wait: true });
  assert.equal(fixture.commands.length, 3);
  assertSearchEnv(fixture.commands[2], nextApiKey, nextUpstreamKey);
  await assertPublicRedaction(fixture, [nextApiKey, nextUpstreamKey]);
});

for (const dpapiAvailable of [true, false]) {
  test(`supervisor passes persisted ${dpapiAvailable ? "DPAPI" : "ACL-only"} platform secrets into search child env, never public output`, async (t) => {
    const fixture = await searchWorld(t, { dpapiAvailable });
    await fixture.supervisor.startComponent("search-gateway", { wait: true });
    assert.equal(fixture.commands.length, 1);
    assertSearchEnv(fixture.commands[0]);
    await fixture.supervisor.restart("search-gateway", { wait: true });
    assert.deepEqual(fixture.commands.map((command) => command.args.slice(-1)[0]), ["-d", "down", "-d"]);
    assertSearchEnv(fixture.commands[2]);
    assert.equal(fixture.hookCalls(), 2);
    await assertPublicRedaction(fixture);
  });
}

test("a healthy search compose is adopted until explicit idle-gated restart runs down, hook and up with vault env", async (t) => {
  const fixture = await searchWorld(t, { adopt: true });
  await fixture.supervisor.startComponent("search-gateway", { wait: true });
  assert.equal(fixture.supervisor.records.get("search-gateway").owner, "adopted");
  assert.equal(fixture.commands.length, 0, "start does not recreate an existing healthy container");
  assert.equal(fixture.hookCalls(), 0);
  fixture.world.blockers.push({ source: "entry", reason: "gateway-stream" });
  await assert.rejects(fixture.supervisor.restart("search-gateway", { wait: true }), { code: "component_busy" });
  assert.equal(fixture.commands.length, 0);
  fixture.world.blockers.length = 0;
  await fixture.supervisor.restart("search-gateway", { wait: true });
  assert.deepEqual(fixture.commands[0].args, ["compose", "-f", path.join(fixture.world.aiRoot, "search-gateway", "docker-compose.yml"), "-p", "local-ai-search", "down"]);
  assert.equal(fixture.commands[0].options.env.SEARCH_GATEWAY_API_KEY, API_KEY);
  assert.equal(fixture.commands[0].options.env.UPSTREAM_API_KEY, UPSTREAM_KEY);
  assertSearchEnv(fixture.commands[1]);
  assert.equal(fixture.hookCalls(), 1);
  await assertPublicRedaction(fixture);
});
