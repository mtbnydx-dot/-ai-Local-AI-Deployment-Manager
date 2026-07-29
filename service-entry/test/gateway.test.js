const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const core = require("../../manager-core");
const entry = require("../server");
const subscriptionSetup = require("../subscription-setup");

async function invokeEntryHandler({
  method = "GET",
  pathname,
  remoteAddress = "127.0.0.1",
  headers = {},
}) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url: pathname,
      headers: { host: "127.0.0.1:5176", ...headers },
      socket: { remoteAddress },
    };
    const response = {
      status: 200,
      headers: {},
      body: "",
      writeHead(status, headers = {}) {
        this.status = status;
        this.headers = headers;
      },
      end(body = "") {
        this.body = String(body);
        resolve({
          status: this.status,
          headers: this.headers,
          json: this.body ? JSON.parse(this.body) : null,
        });
      },
    };
    entry.handleRequest(req, response, {
      serviceEntryMode: "subscription",
      subscriptionProxyConfig: core.normalizeSubscriptionProxyConfig({
        CLIPROXY_ENABLED: "0",
      }),
    }).catch(reject);
  });
}

test("parses gateway routes and maps them to manager paths", () => {
  const openAiRoute = entry.parseGatewayRoute("/gateway/auto/openai/v1/chat/completions");
  assert.deepEqual(openAiRoute, {
    engine: "auto",
    protocol: "openai",
    rest: "v1/chat/completions",
  });
  assert.equal(entry.buildManagerGatewayPath(openAiRoute), "/serve/v1/chat/completions");

  const openAiPropsRoute = entry.parseGatewayRoute("/gateway/auto/openai/v1/props");
  assert.deepEqual(openAiPropsRoute, {
    engine: "auto",
    protocol: "openai",
    rest: "v1/props",
  });
  assert.equal(entry.buildManagerGatewayPath(openAiPropsRoute), "/serve/v1/props");

  const claudeRoute = entry.parseGatewayRoute("/gateway/vllm/claude/v1/messages");
  assert.deepEqual(claudeRoute, {
    engine: "vllm",
    protocol: "claude",
    rest: "v1/messages",
  });
  assert.equal(entry.buildManagerGatewayPath(claudeRoute), "/claude/v1/messages");

  const opencodeRoute = entry.parseGatewayRoute("/gateway/auto/opencode/v1/models");
  assert.deepEqual(opencodeRoute, {
    engine: "auto",
    protocol: "opencode",
    rest: "v1/models",
  });
  assert.equal(entry.buildManagerGatewayPath(opencodeRoute), "/opencode/v1/models");

  const subscriptionRoute = entry.parseGatewayRoute("/gateway/subscription/codex/v1/responses");
  assert.deepEqual(subscriptionRoute, {
    engine: "subscription",
    protocol: "codex",
    rest: "v1/responses",
  });
  assert.equal(core.buildSubscriptionProxyPath(subscriptionRoute.protocol, subscriptionRoute.rest), "/v1/responses");
});

test("rejects unknown gateway routes", () => {
  assert.equal(entry.parseGatewayRoute("/gateway/unknown/openai/v1/models"), null);
  assert.equal(entry.parseGatewayRoute("/gateway/auto/codex/v1/responses"), null);
  assert.equal(entry.parseGatewayRoute("/api/status"), null);
});

test("normalizes full and subscription-only service entry modes", () => {
  assert.equal(entry.normalizeServiceEntryMode("full"), "full");
  assert.equal(entry.normalizeServiceEntryMode("subscription"), "subscription");
  assert.equal(entry.normalizeServiceEntryMode("subscription-only"), "subscription");
  assert.equal(entry.normalizeServiceEntryMode("proxy"), "subscription");
  assert.equal(entry.normalizeServiceEntryMode("unknown"), "full");
});

test("subscription-only mode exposes only subscription gateway URLs", () => {
  const urls = entry.buildEntryGatewayUrls({
    serviceEntryMode: "subscription",
    entryHost: "0.0.0.0",
    entryPort: 5176,
    lanAddress: "192.168.1.27",
  });
  assert.equal(urls.autoOpenAi, null);
  assert.equal(urls.lanAutoClaude, null);
  assert.equal(urls.subscription.local.openAi, "http://127.0.0.1:5176/gateway/subscription/openai/v1");
  assert.equal(urls.subscription.lan.codex, "http://192.168.1.27:5176/gateway/subscription/codex/v1");
});

test("normalizes CLIProxyAPI configuration and exposes local, LAN, and public endpoints", () => {
  const config = core.normalizeSubscriptionProxyConfig({
    CLIPROXY_BASE_URL: "http://127.0.0.1:8317/v1/",
    CLIPROXY_ENABLED: "true",
    CLIPROXY_STATUS_TIMEOUT_MS: "3000",
  });
  assert.equal(config.baseUrl, "http://127.0.0.1:8317");
  assert.equal(config.enabled, true);
  assert.equal(config.upstreamScope, "loopback");
  assert.equal(config.authMode, "passthrough");

  const urls = core.buildSubscriptionProxyGatewayUrls({
    entryHost: "0.0.0.0",
    entryPort: 5176,
    lanAddress: "192.168.1.27",
    publicBaseUrl: "https://ai.example.com/",
  });
  assert.equal(urls.local.openAi, "http://127.0.0.1:5176/gateway/subscription/openai/v1");
  assert.equal(urls.lan.claude, "http://192.168.1.27:5176/gateway/subscription/claude");
  assert.equal(urls.public.codex, "https://ai.example.com/gateway/subscription/codex/v1");
});

test("rejects unsafe subscription proxy paths and base URLs containing credentials", () => {
  assert.throws(
    () => core.buildSubscriptionProxyPath("openai", "v1/%2e%2e/models"),
    /unsafe segment/,
  );
  assert.throws(
    () => core.normalizeSubscriptionProxyBaseUrl("http://user:secret@127.0.0.1:8317"),
    /must not contain credentials/,
  );
});

test("proxy headers keep auth fields and remove hop-by-hop fields", () => {
  const headers = entry.buildProxyHeaders(
    {
      host: "192.168.1.27:5176",
      connection: "keep-alive",
      "content-length": "10",
      authorization: "Bearer service-key",
      "anthropic-api-key": "service-key",
      "x-api-key": "service-key",
      "content-type": "application/json",
      "x-forwarded-for": "192.168.1.99",
    },
    { socket: { remoteAddress: "192.168.1.100" } },
  );

  assert.equal(headers.host, undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers["content-length"], undefined);
  assert.equal(headers.authorization, "Bearer service-key");
  assert.equal(headers["anthropic-api-key"], "service-key");
  assert.equal(headers["x-api-key"], "service-key");
  assert.equal(headers["x-service-entry-gateway"], "1");
  assert.equal(headers["x-forwarded-for"], "192.168.1.99, 192.168.1.100");
});

test("gateway access entries contain metadata but not prompt content", () => {
  const route = entry.parseGatewayRoute("/gateway/auto/claude/v1/messages");
  const manager = entry.findManager("vllm");
  const body = Buffer.from(JSON.stringify({
    model: "local-model",
    messages: [{ role: "user", content: "secret prompt content" }],
    stream: true,
    tools: [{ name: "shell", input_schema: { type: "object" } }],
  }));
  const event = entry.buildEntryGatewayAccessEntry(
    {
      socket: { remoteAddress: "::ffff:192.168.1.50" },
      method: "POST",
      url: "/gateway/auto/claude/v1/messages?debug=1",
      headers: {
        authorization: "Bearer service-key",
        "user-agent": "WorkBuddy/5.1.7",
        origin: "http://127.0.0.1:3000",
        referer: "http://127.0.0.1:3000/chat",
      },
    },
    route,
    manager,
    200,
    Date.now() - 25,
    body,
    "",
  );

  assert.equal(event.path, "/gateway/auto/claude/v1/messages");
  assert.equal(event.kind, "claude");
  assert.equal(event.requestedEngine, "auto");
  assert.equal(event.resolvedEngine, "vllm");
  assert.equal(event.model, "local-model");
  assert.equal(event.stream, true);
  assert.equal(event.authSource, "authorization-bearer");
  assert.equal(event.userAgent, "WorkBuddy/5.1.7");
  assert.equal(event.origin, "http://127.0.0.1:3000");
  assert.equal(event.refererHost, "127.0.0.1:3000");
  assert.equal(event.toolSchemaCount, 1);
  assert.equal(Object.hasOwn(event, "messages"), false);
  assert.equal(JSON.stringify(event).includes("secret prompt content"), false);
});

test("entry server serves only whitelisted docs", async () => {
  const server = entry.createServiceEntryServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const okResponse = await fetch(`http://127.0.0.1:${port}/docs/client-setup-guide.md`);
    assert.equal(okResponse.status, 200);
    assert.match(await okResponse.text(), /# 客户端连接指南/);

    const subscriptionResponse = await fetch(`http://127.0.0.1:${port}/docs/subscription-proxy-guide.md`);
    assert.equal(subscriptionResponse.status, 200);
    assert.match(await subscriptionResponse.text(), /# 订阅反代指南/);

    const missingResponse = await fetch(`http://127.0.0.1:${port}/docs/server.js`);
    assert.equal(missingResponse.status, 404);

    const consolePage = await fetch(`http://127.0.0.1:${port}/subscription-console.html`);
    assert.equal(consolePage.status, 200);
    const consoleHtml = await consolePage.text();
    assert.match(consoleHtml, /订阅反代控制台/);
    assert.match(consoleHtml, /data-open-account/);
    assert.match(consoleHtml, /<dialog class="account-dialog"/);

    const loginPage = await fetch(`http://127.0.0.1:${port}/subscription-login.html`, { redirect: "manual" });
    assert.equal(loginPage.status, 302);
    assert.equal(loginPage.headers.get("location"), "/subscription-console.html#login");

    const servicePage = await fetch(`http://127.0.0.1:${port}/subscription-service.html`, { redirect: "manual" });
    assert.equal(servicePage.status, 302);
    assert.equal(servicePage.headers.get("location"), "/subscription-console.html#service");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("subscription-only entry skips managers and rejects local-model routes", async () => {
  const server = entry.createServiceEntryServer({
    serviceEntryMode: "subscription",
    subscriptionProxyConfig: core.normalizeSubscriptionProxyConfig({
      CLIPROXY_ENABLED: "0",
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.entry.mode, "subscription");
    assert.deepEqual(status.entry.modules, ["frontend", "gateway", "subscription-proxy"]);
    assert.deepEqual(status.managers, []);
    assert.equal(status.entry.gateway.autoOpenAi, null);

    const localRoute = await fetch(`http://127.0.0.1:${port}/gateway/auto/openai/v1/models`);
    assert.equal(localRoute.status, 404);
    assert.match((await localRoute.json()).error.message, /disabled in subscription-only mode/);

    const managerStart = await fetch(`http://127.0.0.1:${port}/api/managers/vllm/start`, { method: "POST" });
    assert.equal(managerStart.status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("remote clients receive only minimal health and cannot access management APIs", async () => {
  const health = await invokeEntryHandler({
    pathname: "/api/health",
    remoteAddress: "192.168.1.88",
  });
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.json).sort(), ["mode", "ok", "service", "version"]);
  assert.equal(health.json.mode, "subscription");

  for (const pathname of ["/api/status", "/api/gateway-access"]) {
    const response = await invokeEntryHandler({
      pathname,
      remoteAddress: "192.168.1.88",
    });
    assert.equal(response.status, 403);
    assert.match(response.json.error, /本机|localhost/i);
  }

  for (const pathname of ["/api/shutdown", "/api/manager/shutdown"]) {
    const response = await invokeEntryHandler({
      method: "POST",
      pathname,
      remoteAddress: "192.168.1.88",
    });
    assert.equal(response.status, 403);
    assert.match(response.json.error, /本机|localhost/i);
  }

  const forwardedShutdown = await invokeEntryHandler({
    method: "POST",
    pathname: "/api/shutdown",
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-for": "203.0.113.50" },
  });
  assert.equal(forwardedShutdown.status, 403);

  const forwardedStatus = await invokeEntryHandler({
    pathname: "/api/status",
    remoteAddress: "127.0.0.1",
    headers: { forwarded: "for=203.0.113.50;proto=https" },
  });
  assert.equal(forwardedStatus.status, 403);

  const crossOriginShutdown = await invokeEntryHandler({
    method: "POST",
    pathname: "/api/shutdown",
    headers: { origin: "https://attacker.invalid" },
  });
  assert.equal(crossOriginShutdown.status, 403);

  const dnsRebindingStatus = await invokeEntryHandler({
    pathname: "/api/status",
    headers: { host: "attacker.invalid" },
  });
  assert.equal(dnsRebindingStatus.status, 403);

  const sameOriginStatus = await invokeEntryHandler({
    pathname: "/api/status",
    headers: {
      origin: "http://127.0.0.1:5176",
      referer: "http://127.0.0.1:5176/subscription-console.html",
    },
  });
  assert.equal(sameOriginStatus.status, 200);
});

test("subscription setup config replaces unsafe examples and preserves valid API keys", () => {
  const original = [
    'host: ""',
    "port: 8317",
    'auth-dir: "~/.cli-proxy-api"',
    "api-keys:",
    '  - "your-api-key-1"',
    '  - "existing-client-key-that-is-long-enough"',
    "debug: false",
    "",
  ].join("\n");
  const before = subscriptionSetup.inspectCliProxyConfig(original);
  assert.equal(before.loopbackOnly, false);
  assert.equal(before.safeApiKeyCount, 1);
  assert.equal(before.unsafeApiKeyCount, 1);

  const updated = subscriptionSetup.updateCliProxyApiKeys(
    original,
    "sk-proxy-generated-client-key-that-is-long-enough",
  );
  const after = subscriptionSetup.inspectCliProxyConfig(updated);
  assert.equal(after.safeApiKeyCount, 2);
  assert.equal(after.unsafeApiKeyCount, 0);
  assert.match(updated, /existing-client-key-that-is-long-enough/);
  assert.match(updated, /sk-proxy-generated-client-key-that-is-long-enough/);
  assert.doesNotMatch(updated, /your-api-key-1/);
  assert.match(updated, /debug: false/);
});

test("subscription setup can enforce loopback host without changing unrelated config", () => {
  const original = [
    'host: "" # bind address',
    "port: 8317",
    'auth-dir: "~/.cli-proxy-api"',
    "debug: false",
    "",
  ].join("\r\n");
  const updated = subscriptionSetup.updateCliProxyHost(original);
  assert.equal(subscriptionSetup.inspectCliProxyConfig(updated).loopbackOnly, true);
  assert.match(updated, /^host: "127\.0\.0\.1" # bind address\r$/m);
  assert.match(updated, /auth-dir: "~\/\.cli-proxy-api"/);
  assert.match(updated, /debug: false/);
  assert.match(updated, /\r\n/);
  assert.equal(subscriptionSetup.updateCliProxyHost(updated), updated);

  const bomUpdated = subscriptionSetup.updateCliProxyHost(`\uFEFFhost: ""\r\nport: 8317\r\n`);
  assert.equal(bomUpdated.startsWith("\uFEFF"), true);
  assert.equal(subscriptionSetup.inspectCliProxyConfig(bomUpdated).loopbackOnly, true);
  assert.equal((bomUpdated.match(/^host:/gm) || []).length, 0);
  assert.equal((bomUpdated.match(/host:/g) || []).length, 1);
});

test("subscription setup APIs are actionable from localhost", async () => {
  const calls = [];
  const controller = {
    async getStatus() {
      calls.push(["status"]);
      return {
        ok: true,
        localOnly: true,
        executable: { found: true, path: "/test/cliproxyapi" },
        config: { found: true, path: "/test/config.yaml", safeApiKeyConfigured: false },
        auth: { accountFiles: 0 },
        providers: [{ id: "codex", label: "OpenAI / Codex" }],
        loginSession: null,
      };
    },
    async generateApiKey() {
      calls.push(["api-key"]);
      return { ok: true, apiKey: "sk-proxy-test-value" };
    },
    async startLogin(provider) {
      calls.push(["login", provider]);
      return { id: "login-test", provider, status: "waiting" };
    },
  };
  const server = entry.createServiceEntryServer({
    serviceEntryMode: "subscription",
    subscriptionSetupController: controller,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/subscription-proxy/setup`);
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).localOnly, true);

    const mediaTypeResponse = await fetch(`http://127.0.0.1:${port}/api/subscription-proxy/api-key`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(mediaTypeResponse.status, 415);

    const keyResponse = await fetch(`http://127.0.0.1:${port}/api/subscription-proxy/api-key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(keyResponse.status, 200);
    assert.equal((await keyResponse.json()).apiKey, "sk-proxy-test-value");

    const loginResponse = await fetch(`http://127.0.0.1:${port}/api/subscription-proxy/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "codex" }),
    });
    assert.equal(loginResponse.status, 202);
    assert.equal((await loginResponse.json()).loginSession.status, "waiting");
    assert.deepEqual(calls, [["status"], ["api-key"], ["login", "codex"]]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("subscription setup controller writes a key and launches the selected official login flag", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-setup-"));
  const configPath = path.join(tempDir, "config.yaml");
  await fs.writeFile(configPath, [
    'host: "127.0.0.1"',
    "port: 8317",
    `auth-dir: ${JSON.stringify(path.join(tempDir, "auth"))}`,
    "api-keys:",
    '  - "your-api-key-1"',
    "",
  ].join("\n"));
  const spawnCalls = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const controller = subscriptionSetup.createSubscriptionSetupController({
    executable: process.execPath,
    configPath,
    loginTimeoutMs: 1000,
    spawnImpl(executable, args, options) {
      spawnCalls.push({ executable, args, options });
      return child;
    },
  });
  try {
    const generated = await controller.generateApiKey();
    assert.match(generated.apiKey, /^sk-proxy-[A-Za-z0-9_-]+$/);
    const written = subscriptionSetup.inspectCliProxyConfig(await fs.readFile(configPath, "utf8"));
    assert.equal(written.safeApiKeyCount, 1);
    assert.equal(written.unsafeApiKeyCount, 0);

    const login = await controller.startLogin("codex");
    assert.equal(login.provider, "codex");
    assert.deepEqual(spawnCalls[0].args, ["-config", configPath, "-codex-login"]);
    assert.equal(spawnCalls[0].executable, process.execPath);
    child.emit("spawn");
    assert.equal((await controller.getStatus()).loginSession.status, "waiting");
    child.stdout.write("Open http://attacker.invalid/openai-login to continue\n");
    assert.equal((await controller.getStatus()).loginSession.authUrl, null);
    child.stderr.write("Visit https://auth.openai.com/oauth/authorize?state=test-state\n");
    assert.equal(
      (await controller.getStatus()).loginSession.authUrl,
      "https://auth.openai.com/oauth/authorize?state=test-state",
    );
    child.emit("exit", 0, null);
    assert.equal((await controller.getStatus()).loginSession.status, "succeeded");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("provider login URL allowlist requires HTTPS and the official provider host", () => {
  assert.equal(
    subscriptionSetup.isAllowedProviderLoginUrl("codex", "https://auth.openai.com/oauth/authorize"),
    true,
  );
  assert.equal(
    subscriptionSetup.isAllowedProviderLoginUrl("claude", "https://claude.ai/oauth/authorize"),
    true,
  );
  assert.equal(
    subscriptionSetup.isAllowedProviderLoginUrl("kimi", "https://auth.kimi.com/device"),
    true,
  );
  assert.equal(
    subscriptionSetup.isAllowedProviderLoginUrl("xai", "https://auth.x.ai/activate"),
    true,
  );
  assert.equal(
    subscriptionSetup.isAllowedProviderLoginUrl("antigravity", "https://accounts.google.com/o/oauth2/v2/auth"),
    true,
  );
  assert.equal(
    subscriptionSetup.isAllowedProviderLoginUrl("codex", "http://auth.openai.com/oauth/authorize"),
    false,
  );
  assert.equal(
    subscriptionSetup.isAllowedProviderLoginUrl("codex", "https://auth.openai.com.attacker.invalid/oauth"),
    false,
  );
  assert.equal(
    subscriptionSetup.isAllowedProviderLoginUrl("claude", "https://attacker.invalid/claude-login"),
    false,
  );
});

test("subscription service status always previews LAN endpoints and validates public HTTPS URLs", () => {
  const status = entry.getSubscriptionServiceStatus({
    serviceEntryMode: "subscription",
    entryHost: "127.0.0.1",
    entryPort: 5176,
    lanAddress: "192.168.1.27",
    publicBaseUrl: "",
    platform: "darwin",
    localControl: true,
  });
  assert.equal(status.lan.active, false);
  assert.equal(status.lan.baseUrl, "http://192.168.1.27:5176");
  assert.equal(status.lan.endpoints.openAi, "http://192.168.1.27:5176/gateway/subscription/openai/v1");
  assert.match(status.lan.startCommand, /subscription-proxy-macos\.sh start lan/);
  assert.equal(status.public.configured, false);
  assert.equal(status.public.endpoints, null);
  assert.equal(
    entry.normalizePublicBaseUrl("https://ai.example.com/proxy/"),
    "https://ai.example.com/proxy",
  );
  assert.throws(() => entry.normalizePublicBaseUrl("http://ai.example.com"), /must use HTTPS|必须使用 HTTPS/);
});

test("subscription service page can save a public base URL from localhost", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-service-"));
  const configPath = path.join(tempDir, "subscription-service.local.json");
  const server = entry.createServiceEntryServer({
    serviceEntryMode: "subscription",
    entryHost: "127.0.0.1",
    entryPort: 5176,
    lanAddress: "192.168.1.27",
    subscriptionServiceConfigPath: configPath,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const previewResponse = await fetch(`http://127.0.0.1:${port}/api/subscription-service`);
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.lan.endpoints.codex, "http://192.168.1.27:5176/gateway/subscription/codex/v1");
    assert.equal(preview.public.configured, false);

    const saveResponse = await fetch(`http://127.0.0.1:${port}/api/subscription-service/public-base-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicBaseUrl: "https://ai.example.com/" }),
    });
    assert.equal(saveResponse.status, 200);
    const saved = await saveResponse.json();
    assert.equal(saved.public.baseUrl, "https://ai.example.com");
    assert.equal(saved.public.endpoints.claude, "https://ai.example.com/gateway/subscription/claude");
    assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).publicBaseUrl, "https://ai.example.com");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("subscription proxy status distinguishes ready and API-key-required states", async () => {
  const config = core.normalizeSubscriptionProxyConfig({
    CLIPROXY_BASE_URL: "http://127.0.0.1:8317",
  });
  const ready = await entry.probeSubscriptionProxy({
    config,
    fetchImpl: async () => new Response(JSON.stringify({
      object: "list",
      data: [{ id: "gpt-subscription" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.models, ["gpt-subscription"]);
  assert.match(ready.declaration, /本机、局域网和可选公网/);

  const authRequired = await entry.probeSubscriptionProxy({
    config,
    fetchImpl: async () => new Response("", { status: 401 }),
  });
  assert.equal(authRequired.state, "auth-required");
  assert.equal(authRequired.reachable, true);
  assert.match(authRequired.credentialBoundary, /不读取或保存 OAuth/);
});

test("subscription gateway forwards path, body, and caller authentication to CLIProxyAPI", async () => {
  const captured = {};
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured.path = req.url;
    captured.authorization = req.headers.authorization;
    captured.apiKey = req.headers["x-api-key"];
    captured.gateway = req.headers["x-service-entry-gateway"];
    captured.body = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "chatcmpl-proxy", object: "chat.completion" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const gateway = entry.createServiceEntryServer({
    subscriptionProxyConfig: core.normalizeSubscriptionProxyConfig({
      CLIPROXY_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    }),
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = gateway.address().port;
  try {
    const response = await fetch(
      `http://127.0.0.1:${gatewayPort}/gateway/subscription/openai/v1/chat/completions?trace=1`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer caller-owned-key",
          "x-api-key": "caller-owned-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "subscription-model",
          messages: [{ role: "user", content: "do not log this prompt" }],
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, "chatcmpl-proxy");
    assert.equal(captured.path, "/v1/chat/completions?trace=1");
    assert.equal(captured.authorization, "Bearer caller-owned-key");
    assert.equal(captured.apiKey, "caller-owned-key");
    assert.equal(captured.gateway, "1");
    assert.match(captured.body, /subscription-model/);
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("subscription gateway preserves SSE streaming responses", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write("data: first\n\n");
    setTimeout(() => res.end("data: [DONE]\n\n"), 5);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const gateway = entry.createServiceEntryServer({
    subscriptionProxyConfig: core.normalizeSubscriptionProxyConfig({
      CLIPROXY_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    }),
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = gateway.address().port;
  try {
    const response = await fetch(
      `http://127.0.0.1:${gatewayPort}/gateway/subscription/claude/v1/messages`,
      {
        method: "POST",
        headers: {
          "anthropic-api-key": "caller-owned-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "subscription-model", stream: true, messages: [] }),
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.equal(await response.text(), "data: first\n\ndata: [DONE]\n\n");
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("auto gateway selects the manager that owns the requested model", () => {
  const vllm = entry.findManager("vllm");
  const llama = entry.findManager("llama");
  const catalogs = [
    {
      manager: vllm,
      listening: true,
      running: true,
      models: [{ id: "qwen-vllm" }],
      modelIds: new Set(["qwen-vllm"]),
      aliases: new Set(["qwen3.6"]),
    },
    {
      manager: llama,
      listening: true,
      running: true,
      models: [{ id: "gemma-gguf" }],
      modelIds: new Set(["gemma-gguf"]),
      aliases: new Set(["gemma4"]),
    },
  ];
  assert.equal(entry.selectGatewayManager(catalogs, "gemma-gguf").id, "llama");
  assert.equal(entry.selectGatewayManager(catalogs, "qwen3.6").id, "vllm");
  assert.equal(entry.selectGatewayManager(catalogs, "auto").id, "vllm");
});

test("auto model catalog merges both engines without duplicate ids", () => {
  const data = entry.mergeManagerModelCatalogs([
    {
      manager: entry.findManager("vllm"),
      models: [{ id: "shared" }, { id: "vllm-only", owned_by: "vllm" }],
    },
    {
      manager: entry.findManager("llama"),
      models: [{ id: "shared" }, { id: "llama-only", owned_by: "llama.cpp" }],
    },
  ]);
  assert.deepEqual(data.map((model) => model.id), ["shared", "vllm-only", "llama-only"]);
  assert.deepEqual(data.map((model) => model.manager_engine), ["vllm", "vllm", "llama"]);
});

test("auto OpenAI model list route is detected without matching chat routes", () => {
  assert.equal(entry.isAggregatedModelListRequest(
    { method: "GET" },
    entry.parseGatewayRoute("/gateway/auto/openai/v1/models"),
  ), true);
  assert.equal(entry.isAggregatedModelListRequest(
    { method: "POST" },
    entry.parseGatewayRoute("/gateway/auto/openai/v1/chat/completions"),
  ), false);
});
