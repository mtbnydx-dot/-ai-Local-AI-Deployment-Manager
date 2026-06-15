const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCcSwitchProviderTools, CCSWITCH_PROVIDER_SCRIPT } = require("../lib/ccswitch-provider");

function parseJsonSafe(text, fallback = null) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

test("CCSwitch provider setup skips cleanly when database is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccswitch-missing-"));
  const tools = createCcSwitchProviderTools({
    ccSwitchDir: dir,
    pythonExe: "python",
    execFileAsync: async () => {
      throw new Error("should not run");
    },
    parseJsonSafe,
  });

  const result = await tools.configureCcSwitchProvider({ baseUrl: "http://127.0.0.1:5177/claude" });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.dbPath, path.join(dir, "cc-switch.db"));
});

test("CCSwitch provider setup passes Claude bridge payload to Python", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccswitch-present-"));
  fs.writeFileSync(path.join(dir, "cc-switch.db"), "");
  let captured = null;
  const tools = createCcSwitchProviderTools({
    ccSwitchDir: dir,
    pythonExe: "python",
    execFileAsync: async (file, args, options) => {
      assert.equal(file, "python");
      assert.equal(args[0], "-c");
      assert.match(args[1], /provider_health/);
      assert.equal(options.timeout, 15000);
      captured = JSON.parse(Buffer.from(args[2], "base64").toString("utf8"));
      return { stdout: JSON.stringify({ ok: true, providerId: "local-vllm-claude", endpoint: captured.messagesUrl }) };
    },
    parseJsonSafe,
  });

  const result = await tools.configureCcSwitchProvider({
    baseUrl: "http://192.168.1.27:5177/claude",
    messagesUrl: "http://192.168.1.27:5177/claude/v1/messages",
    apiKey: "local-key",
    aliases: [{ name: "claude-opus-4-7", labelOverride: "local" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.endpoint, "http://192.168.1.27:5177/claude/v1/messages");
  assert.equal(captured.dbPath, path.join(dir, "cc-switch.db"));
  assert.equal(captured.apiKey, "local-key");
  assert.deepEqual(captured.aliases, [{ name: "claude-opus-4-7", labelOverride: "local" }]);
});

test("CCSwitch health parses JSON bodies and reports connection failures", async () => {
  const okTools = createCcSwitchProviderTools({
    ccSwitchDir: os.tmpdir(),
    pythonExe: "python",
    execFileAsync: async () => ({ stdout: "{}" }),
    parseJsonSafe,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => "{\"ok\":true}",
    }),
  });

  assert.match(CCSWITCH_PROVIDER_SCRIPT, /ANTHROPIC_BASE_URL/);
  assert.deepEqual((await okTools.getCcSwitchHealth()).body, { ok: true });

  const failTools = createCcSwitchProviderTools({
    ccSwitchDir: os.tmpdir(),
    pythonExe: "python",
    execFileAsync: async () => ({ stdout: "{}" }),
    parseJsonSafe,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });

  const result = await failTools.getCcSwitchHealth();
  assert.equal(result.ok, false);
  assert.match(result.error, /offline/);
});
