"use strict";

// OPS-16: `platform config import-env` (06 §4.7), the `exposure setup` wrapper
// (06 §6.2) and the nightly "platform status" / "serving" steps. Everything runs
// against temp roots with a fake DPAPI and injected exec / spawn spies; no real
// registry value is read or deleted and no live service is probed.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const { run } = require("../platformctl.js");
const { createFakeDpapi } = require("../../manager-core/test/fixtures/secrets/fake-dpapi");
const { createSecretStore } = require("../../manager-core/secret-store");

const FAKE_KEY = "fixture-mcp-key-ops16-0000000000000000001";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platformctl-ops16-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sink() {
  const chunks = [];
  return { write(text) { chunks.push(String(text)); return true; }, text: () => chunks.join(""), isTTY: false };
}

// A world whose execFile answers `reg query` from a fixed table and records every call.
function makeWorld(t, { registry = "", answers = [] } = {}) {
  const root = tempRoot(t);
  const dpapi = createFakeDpapi();
  const execCalls = [];
  const spawnCalls = [];
  const world = {
    root, dpapi, execCalls, spawnCalls,
    async cli(argv, options = {}) {
      const stdout = sink();
      const stderr = sink();
      const code = await run(argv, {
        aiRoot: root,
        env: { PLATFORM_LANG: "en-US", ...(options.env || {}) },
        stdout,
        stderr,
        stdin: Readable.from([]),
        stdinIsTTY: options.tty === true,
        dpapi,
        acl: { secure: async () => {} },
        prompt: async (question) => { world.asked = (world.asked || []).concat(question); return answers.shift() ?? ""; },
        execFile: (file, args, opts, callback) => {
          execCalls.push({ file, args });
          const done = typeof opts === "function" ? opts : callback;
          if (file === "reg" && args[0] === "query") return done(null, registry, "");
          return done(null, "", "");
        },
        spawnSync: (file, args, opts) => { spawnCalls.push({ file, args, opts }); return { status: options.spawnStatus ?? 0 }; },
      });
      return { code, out: stdout.text(), err: stderr.text() };
    },
  };
  return world;
}

const REG_TABLE = [
  "",
  "HKEY_CURRENT_USER\\Environment",
  "    SERVICE_ENTRY_PUBLIC_PORT    REG_SZ    5199",
  "    PLATFORM_MCP_API_KEY    REG_SZ    " + FAKE_KEY,
  "    PATH    REG_EXPAND_SZ    C:\\Windows",
  "    TTS_GATEWAY_PORT    REG_SZ    not-a-number",
  "",
].join("\r\n");

function regDeletes(world) {
  return world.execCalls.filter((call) => call.file === "reg" && call.args[0] === "delete");
}

test("import-env previews by default: masks secrets, flags invalid values and writes nothing", async (t) => {
  const world = makeWorld(t, { registry: REG_TABLE });
  const result = await world.cli(["config", "import-env"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /SERVICE_ENTRY_PUBLIC_PORT -> listeners\.public\.port = 5199/);
  assert.match(result.out, /PLATFORM_MCP_API_KEY -> platformMcp\.apiKey = \*\*\*\*/);
  assert.match(result.out, /TTS_GATEWAY_PORT -> tts\.gatewayPort = \?.*invalid/);
  assert.ok(!result.out.includes(FAKE_KEY) && !result.err.includes(FAKE_KEY));
  assert.ok(!result.out.includes("PATH"), "only mapped names are considered");
  assert.equal(fs.existsSync(path.join(world.root, "config", "platform.json")), false);
  assert.equal(regDeletes(world).length, 0);
  assert.deepEqual(world.execCalls[0], { file: "reg", args: ["query", "HKCU\\Environment"] });
});

test("import-env --apply writes platform.json and the secret store in the temp root; invalid values are skipped", async (t) => {
  const world = makeWorld(t, { registry: REG_TABLE });
  const result = await world.cli(["config", "import-env", "--apply", "--json"], { env: { SERVICE_ENTRY_PUBLIC_BASE_URL: "https://models.example.test" } });
  assert.equal(result.code, 0, result.err);
  const report = JSON.parse(result.out);
  assert.deepEqual(report.imported.sort(), ["cli.lang", "listeners.public.baseUrl", "listeners.public.port", "platformMcp.apiKey"]);
  assert.ok(!result.out.includes(FAKE_KEY));
  const file = JSON.parse(fs.readFileSync(path.join(world.root, "config", "platform.json"), "utf8"));
  assert.equal(file.listeners.public.port, 5199);
  assert.equal(file.listeners.public.baseUrl, "https://models.example.test");
  assert.equal(JSON.stringify(file).includes(FAKE_KEY), false, "secrets never reach platform.json");
  assert.equal(file.tts?.gatewayPort, undefined, "an unparsable value is not written");
  const store = createSecretStore({ aiRoot: world.root, namespace: "platform", dpapi: world.dpapi });
  assert.equal(store.get("platformMcp.apiKey"), FAKE_KEY);
  assert.equal(regDeletes(world).length, 0, "no reg delete without --remove-user-env");
});

test("--remove-user-env never runs reg delete without a TTY, and needs an explicit yes with one", async (t) => {
  const noTty = makeWorld(t, { registry: REG_TABLE });
  const refused = await noTty.cli(["config", "import-env", "--apply", "--remove-user-env"]);
  assert.equal(refused.code, 0);
  assert.match(refused.err, /interactive terminal/);
  assert.equal(regDeletes(noTty).length, 0);
  assert.equal(noTty.asked, undefined, "no prompt is even shown without a TTY");

  const declined = makeWorld(t, { registry: REG_TABLE, answers: [""] });
  assert.equal((await declined.cli(["config", "import-env", "--apply", "--remove-user-env"], { tty: true })).code, 0);
  assert.equal(regDeletes(declined).length, 0, "the default answer is no");

  const accepted = makeWorld(t, { registry: REG_TABLE, answers: ["y"] });
  const done = await accepted.cli(["config", "import-env", "--apply", "--remove-user-env"], { tty: true });
  assert.equal(done.code, 0, done.err);
  const names = regDeletes(accepted).map((call) => call.args[3]).sort();
  assert.deepEqual(names, ["PLATFORM_MCP_API_KEY", "SERVICE_ENTRY_PUBLIC_PORT"], "only imported names that live in HKCU are deleted");
  for (const call of regDeletes(accepted)) assert.deepEqual([call.args[0], call.args[1], call.args[2]], ["delete", "HKCU\\Environment", "/v"]);
  assert.ok(regDeletes(accepted).every((call) => call.args.at(-1) === "/f"));

  const alone = await makeWorld(t, { registry: REG_TABLE }).cli(["config", "import-env", "--remove-user-env"]);
  assert.equal(alone.code, 2, "--remove-user-env needs --apply");
});

test("exposure setup passes its arguments through to setup-public.ps1 and returns its exit code", async (t) => {
  const world = makeWorld(t);
  const result = await world.cli(["exposure", "setup", "--DryRun", "-ModelApiDomain", "models.example.test", "--Topology=caddy"]);
  assert.equal(result.code, 0);
  assert.equal(world.spawnCalls.length, 1);
  const call = world.spawnCalls[0];
  assert.equal(call.file, "powershell");
  assert.deepEqual(call.args.slice(0, 4), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
  assert.equal(call.args[4], path.join(world.root, "scripts", "setup-public.ps1"));
  assert.deepEqual(call.args.slice(5), ["-DryRun", "-ModelApiDomain", "models.example.test", "-Topology", "caddy"]);
  assert.equal(call.opts.stdio, "inherit");
  assert.equal((await makeWorld(t).cli(["exposure", "setup"], { spawnStatus: 7 })).code, 7);

  const bare = await world.cli(["exposure"]);
  assert.equal(bare.code, 2);
});

// ---------------------------------------------------------------------------
// nightly-e2e.ps1 -StatusOnly: the new steps without any live probe

function nightlyRun(t, status, extraArgs = []) {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "platformctl.js"), `process.stdout.write(${JSON.stringify(JSON.stringify(status))}); process.exit(${status.readiness?.overall === "ready" ? 0 : 1});\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || env.Path || ""}`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "nightly-e2e.ps1"), "-Root", root, "-StatusOnly", ...extraArgs], {
    encoding: "utf8", env, windowsHide: true, timeout: 120000,
  });
  const latest = path.join(root, "artifacts", "nightly", "latest.json");
  const report = fs.existsSync(latest) ? JSON.parse(fs.readFileSync(latest, "utf8").replace(/^﻿/, "")) : null;
  return { status: result.status, report, out: `${result.stdout}${result.stderr}` };
}

const LAYERS_READY = ["environment", "runtime", "components", "serving", "exposure"].map((id) => ({ id, status: "ok" }));

test("nightly adds a 'platform status' step with the readiness layers and a 'serving' step", { skip: process.platform !== "win32" }, (t) => {
  const green = nightlyRun(t, { readiness: { overall: "ready", layers: LAYERS_READY }, models: { serving: 2 } });
  assert.equal(green.status, 0, green.out);
  const names = green.report.steps.map((step) => step.name);
  assert.deepEqual(names, ["platform status", "serving"]);
  const statusStep = green.report.steps[0];
  assert.equal(statusStep.ok, true);
  assert.equal(statusStep.overall, "ready");
  assert.deepEqual(statusStep.layers.map((layer) => layer.id), ["environment", "runtime", "components", "serving", "exposure"]);
  assert.match(statusStep.detail, /serving=ok/);
  assert.match(green.report.steps[1].detail, /models serving: 2/);
  assert.equal(green.report.ok, true);

  const idle = { readiness: { overall: "degraded", layers: LAYERS_READY.map((layer) => (layer.id === "serving" ? { id: "serving", status: "warn", code: "no_model_serving" } : layer)) }, models: { serving: 0 } };
  const failing = nightlyRun(t, idle);
  assert.equal(failing.status, 1);
  assert.deepEqual(failing.report.steps.map((step) => [step.name, step.ok]), [["platform status", true], ["serving", false]]);
  const allowed = nightlyRun(t, idle, ["-AllowNoServing"]);
  assert.equal(allowed.status, 0, allowed.out);

  const down = nightlyRun(t, { readiness: { overall: "down", layers: LAYERS_READY } });
  assert.equal(down.report.steps[0].ok, false);
});

test("nightly keeps every existing step name", () => {
  const text = fs.readFileSync(path.join(ROOT, "scripts", "nightly-e2e.ps1"), "utf8");
  for (const name of ["test-all.cmd", "entry /api/status", "vLLM manager health", "llama manager health", "TTS gateway health", "MCP health", "search gateway health", "public API route", "platform-mcp validate:live"]) {
    assert.ok(text.includes(`"${name}"`) || text.includes(`'${name}'`), `step "${name}" is still produced`);
  }
});
