"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

// scripts/setup-public.ps1 (05 §14, PUB-20) runs in a copy of the repository
// pieces it needs under a temp root, with a fake platform.cmd that only logs its
// arguments. Nothing touches the real root, the settings file or the network.

const REPO = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO, "scripts", "setup-public.ps1");

function scriptEnv() {
  const drop = new Set(["psmodulepath"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !drop.has(name.toLowerCase())));
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || env.Path || ""}`;
  return env;
}

function hasWindowsPowerShell() {
  if (process.platform !== "win32") return false;
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"], { env: scriptEnv(), windowsHide: true, timeout: 60000 });
  return !probe.error && probe.status === 0;
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-public-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "service-entry", "lib"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "scripts", "setup-public.ps1"));
  fs.copyFileSync(path.join(REPO, "service-entry", "lib", "deploy-templates.js"), path.join(root, "service-entry", "lib", "deploy-templates.js"));
  fs.cpSync(path.join(REPO, "deploy"), path.join(root, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(root, "platform.cmd"), "@echo off\r\necho %* >> \"%~dp0platform-calls.log\"\r\nexit /b 0\r\n");
  return root;
}

function run(root, args) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "setup-public.ps1"), ...args], {
    encoding: "utf8", env: scriptEnv(), windowsHide: true, timeout: 120000,
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

function platformCalls(root) {
  const file = path.join(root, "platform-calls.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

test("the script has no key-file read, no environment writes and no inline settings writer", () => {
  const bytes = fs.readFileSync(SCRIPT);
  const text = bytes.toString("utf8");
  assert.notEqual(bytes[0], 0xef, "no BOM");
  assert.equal(/(^|[^\r])\n/.test(text), false, "CRLF only");
  assert.doesNotMatch(text, /setx/i);
  assert.doesNotMatch(text, /last-public-service-key|\$ApiKey|Get-Content[^\r\n]*[Kk]ey/);
  assert.doesNotMatch(text, /MODEL_GATEWAY_API_KEY/);
  assert.doesNotMatch(text, /\\\.env|\.env"/, "it no longer writes a .env file");
  assert.match(text, /config set/);
  assert.match(text, /\[switch\]\$Apply/);
});

const skip = !hasWindowsPowerShell() && "the setup script needs Windows PowerShell";

test("without -Apply it renders into config/public, prints the settings commands and runs none", { skip, timeout: 180000 }, (t) => {
  const root = makeRoot(t);
  const result = run(root, ["-ModelApiDomain", "Models.Example.com", "-Topology", "caddy", "-WebUiDomain", "chat.example.com"]);
  assert.equal(result.status, 0, result.out);
  const dir = path.join(root, "config", "public");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["Caddyfile", "openwebui.compose.yaml"]);
  assert.match(fs.readFileSync(path.join(dir, "Caddyfile"), "utf8"), /^models\.example\.com \{$/m);
  assert.match(result.out, /platform config set listeners\.public\.baseUrl https:\/\/models\.example\.com/);
  assert.match(result.out, /platform config set trustedProxies\.clientIpHeader x-forwarded-for/);
  assert.match(result.out, /platform config set trustedProxies\.cidrs 127\.0\.0\.1\/32/);
  assert.match(result.out, /not changed without -Apply/);
  assert.doesNotMatch(result.out, /setx/i);
  assert.deepEqual(platformCalls(root), [], "no settings were written");
  assert.equal(fs.existsSync(path.join(root, "deploy", "public", ".env")), false);
  assert.deepEqual(fs.readdirSync(path.join(root, "deploy", "public")).sort(), fs.readdirSync(path.join(REPO, "deploy", "public")).sort(), "tracked deploy files are untouched");
});

test("-Apply writes the settings only through platform config set", { skip, timeout: 180000 }, (t) => {
  const root = makeRoot(t);
  const result = run(root, ["-ModelApiDomain", "models.example.com", "-Topology", "cloudflared-token", "-Apply"]);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(platformCalls(root), [
    "config set listeners.public.baseUrl https://models.example.com",
    "config set trustedProxies.clientIpHeader cf-connecting-ip",
  ]);
  assert.deepEqual(fs.readdirSync(path.join(root, "config", "public")).sort(), ["cloudflared.compose.yaml", "cloudflared.env.example"]);
  assert.equal(fs.existsSync(path.join(root, "config", "public", "cloudflared.env")), false, "the token file is the owner's to create");
});

test("an existing file is kept unless -Overwrite is given, and -DryRun writes nothing", { skip, timeout: 240000 }, (t) => {
  const root = makeRoot(t);
  const dry = run(root, ["-ModelApiDomain", "models.example.com", "-Topology", "caddy", "-Apply", "-DryRun"]);
  assert.equal(dry.status, 0, dry.out);
  assert.equal(fs.existsSync(path.join(root, "config")), false, "dry run creates no directory");
  assert.deepEqual(platformCalls(root), [], "dry run runs no settings command");

  assert.equal(run(root, ["-ModelApiDomain", "models.example.com", "-Topology", "caddy"]).status, 0);
  const file = path.join(root, "config", "public", "Caddyfile");
  fs.writeFileSync(file, "owner edit\n");
  const refused = run(root, ["-ModelApiDomain", "models.example.com", "-Topology", "caddy"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.out, /already exist/);
  assert.equal(fs.readFileSync(file, "utf8"), "owner edit\n");
  assert.equal(run(root, ["-ModelApiDomain", "models.example.com", "-Topology", "caddy", "-Overwrite"]).status, 0);
  assert.match(fs.readFileSync(file, "utf8"), /reverse_proxy 127\.0\.0\.1:5186/);
});

test("a bad domain or a missing renderer fails before anything is written", { skip, timeout: 240000 }, (t) => {
  const root = makeRoot(t);
  const bad = run(root, ["-ModelApiDomain", "https://models.example.com/path", "-Topology", "caddy"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /bare hostname/);
  const lan = run(root, ["-ModelApiDomain", "models.example.com", "-Topology", "lan", "-Apply"]);
  assert.equal(lan.status, 0, lan.out);
  assert.deepEqual(platformCalls(root), ["config set listeners.public.host 0.0.0.0"]);
  assert.equal(fs.existsSync(path.join(root, "config", "public")), false, "lan renders no files");
});
