const assert = require("node:assert/strict");
const test = require("node:test");
const {
  classifyRepoAccessError,
  createHfAuthService,
  parseJsonOutput,
  quotePowerShell,
} = require("../lib/hf-auth");

test("HF auth service reports the connected CLI identity without returning a token", async () => {
  const calls = [];
  const service = createHfAuthService({
    hfCli: "C:\\tools\\hf.exe",
    hfHome: "D:\\AI\\cache\\huggingface",
    baseEnv: {},
    execFileImpl(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(null, JSON.stringify({ user: "alice", orgs: "team-a,team-b" }), "");
    },
  });

  const status = await service.getStatus();
  assert.deepEqual(status, {
    connected: true,
    username: "alice",
    orgs: ["team-a", "team-b"],
    source: "local-cli",
  });
  assert.deepEqual(calls[0].args, ["auth", "whoami", "--format", "json"]);
  assert.equal(calls[0].options.env.HF_HOME, "D:\\AI\\cache\\huggingface");
  assert.equal(Object.hasOwn(status, "token"), false);
});

test("HF auth service dry-runs a repository file before granting gated access", async () => {
  const calls = [];
  const service = createHfAuthService({
    hfCli: "hf",
    hfHome: "D:\\hf",
    baseEnv: {},
    execFileImpl(_file, args, _options, callback) {
      calls.push(args);
      if (args[0] === "auth") callback(null, '{"user":"alice"}', "");
      else callback(null, "[]", "");
    },
  });

  const access = await service.checkRepoAccess("owner/model", { probeFile: "config.json" });
  assert.equal(access.granted, true);
  assert.equal(access.status, "granted");
  assert.deepEqual(calls[1], ["download", "owner/model", "config.json", "--dry-run", "--format", "json"]);
});

test("HF auth service distinguishes missing login from missing model approval", async () => {
  let mode = "logged-out";
  const service = createHfAuthService({
    hfCli: "hf",
    hfHome: "D:\\hf",
    baseEnv: {},
    execFileImpl(_file, args, _options, callback) {
      if (args[0] === "auth" && mode === "logged-out") {
        const error = new Error("Not logged in");
        callback(error, "", "Not logged in");
        return;
      }
      if (args[0] === "auth") {
        callback(null, '{"user":"alice"}', "");
        return;
      }
      const error = new Error("Access denied. This repository requires approval.");
      callback(error, "", error.message);
    },
  });

  const loggedOut = await service.checkRepoAccess("owner/model");
  assert.deepEqual(loggedOut, { granted: false, status: "login_required", username: null });

  mode = "connected";
  const gated = await service.checkRepoAccess("owner/model");
  assert.deepEqual(gated, { granted: false, status: "approval_required", username: "alice" });
});

test("HF auth service launches a visible isolated PowerShell login window", () => {
  const calls = [];
  const service = createHfAuthService({
    hfCli: "D:\\AI\\venvs\\ai311\\Scripts\\hf.exe",
    hfHome: "D:\\AI\\cache\\huggingface",
    platform: "win32",
    baseEnv: { HF_TOKEN: "must-not-be-embedded" },
    execFileSyncImpl(file, args, options) {
      calls.push({ file, args, options });
    },
  });

  const result = service.launchLogin();
  assert.equal(result.launched, true);
  assert.equal(calls[0].file, "powershell.exe");
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 10000);
  assert.match(calls[0].args.at(-1), /Start-Process/);
  assert.match(calls[0].args.at(-1), /-NoExit/);
  assert.match(calls[0].args.at(-1), /-EncodedCommand/);
  assert.doesNotMatch(calls[0].args.at(-1), /must-not-be-embedded/);
});

test("HF auth helpers tolerate formatted output and classify access denial", () => {
  assert.equal(parseJsonOutput("notice\n{\"user\":\"alice\"}\n").user, "alice");
  assert.equal(classifyRepoAccessError(new Error("403 gated repository")), "approval_required");
  assert.equal(quotePowerShell("a'b"), "'a''b'");
});
