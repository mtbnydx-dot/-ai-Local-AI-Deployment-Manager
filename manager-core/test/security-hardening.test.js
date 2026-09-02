const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("..");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeRequest(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers, method: "POST", get: () => "" };
}

function fakeResponse() {
  const res = { statusCode: 0, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
  res.getHeader = (key) => res.headers[key.toLowerCase()];
  res.end = () => res;
  res.once = () => res;
  res.setTimeout = () => res;
  return res;
}

test("gateway trust: a signed loopback hop reports the real client, an unsigned one is not local", async (t) => {
  const root = tempDir("trust-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { token } = await core.issueGatewayTrustToken({ root });
  const readGatewayTrustToken = core.createGatewayTrustReader({ root, cacheTtlMs: 0, envName: "TRUST_TOKEN_UNSET_FOR_TEST" });
  const opts = { readGatewayTrustToken };

  // A direct client is judged by its socket address.
  assert.equal(core.isLocalRequester(fakeRequest("127.0.0.1"), opts), true);
  assert.equal(core.isLocalRequester(fakeRequest("192.168.0.55"), opts), false);

  // service-entry proxies from loopback, so without the signed client address a
  // LAN caller would look local. This is the local-only bypass.
  const lanHop = core.buildGatewayTrustHeaders(token, "192.168.0.55");
  assert.equal(core.isLocalRequester(fakeRequest("127.0.0.1", lanHop), opts), false);

  const localHop = core.buildGatewayTrustHeaders(token, "127.0.0.1");
  assert.equal(core.isLocalRequester(fakeRequest("127.0.0.1", localHop), opts), true);

  // Fail closed: the marker alone proves nothing.
  assert.equal(core.isLocalRequester(fakeRequest("127.0.0.1", { "x-service-entry-gateway": "1" }), opts), false);

  // A signature made with any other token is rejected.
  const forged = core.buildGatewayTrustHeaders("not-the-real-token", "127.0.0.1");
  assert.equal(core.isLocalRequester(fakeRequest("127.0.0.1", forged), opts), false);

  // Replay outside the skew window is rejected.
  const stale = core.buildGatewayTrustHeaders(token, "127.0.0.1", Date.now() - 10 * 60 * 1000);
  assert.equal(core.isLocalRequester(fakeRequest("127.0.0.1", stale), opts), false);

  // The marker is only meaningful on the loopback hop.
  assert.equal(core.isLocalRequester(fakeRequest("192.168.0.55", localHop), opts), false);
});

test("gateway trust publication stays readable during concurrent token rotation", async (t) => {
  const root = tempDir("trust-atomic-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envName = "GATEWAY_TRUST_ATOMIC_WRITE_TEST";
  const previousEnv = process.env[envName];
  process.env[envName] = "bootstrap-fallback-must-not-be-observed";
  t.after(() => {
    if (previousEnv === undefined) delete process.env[envName];
    else process.env[envName] = previousEnv;
  });

  await core.issueGatewayTrustToken({ root, token: "before-rotation-token" });
  const readGatewayTrustToken = core.createGatewayTrustReader({ root, cacheTtlMs: 0, envName });
  assert.equal(readGatewayTrustToken(), "before-rotation-token");

  const originalWriteFile = fsp.writeFile;
  let enteredWrite;
  let releaseWrite;
  const writeEntered = new Promise((resolve) => { enteredWrite = resolve; });
  const writeRelease = new Promise((resolve) => { releaseWrite = resolve; });
  let intercepted = false;
  fsp.writeFile = async (file, data, options) => {
    if (intercepted) return originalWriteFile.call(fsp, file, data, options);
    intercepted = true;
    await originalWriteFile.call(fsp, file, "", options);
    enteredWrite(file);
    await writeRelease;
    return originalWriteFile.call(fsp, file, data, options);
  };
  t.after(() => { fsp.writeFile = originalWriteFile; });

  let rotation;
  try {
    rotation = core.issueGatewayTrustToken({ root, token: "after-rotation-token" });
    await writeEntered;
    assert.equal(
      readGatewayTrustToken(),
      "before-rotation-token",
      "a reader must see the complete previous token while the replacement file is still being written",
    );
  } finally {
    releaseWrite();
    if (rotation) await rotation;
    fsp.writeFile = originalWriteFile;
  }

  assert.equal(readGatewayTrustToken(), "after-rotation-token");
});

test("rate limit bucket ignores client-supplied X-Forwarded-For", async (t) => {
  const root = tempDir("trust-rl-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { token } = await core.issueGatewayTrustToken({ root });
  const readGatewayTrustToken = core.createGatewayTrustReader({ root, cacheTtlMs: 0, envName: "TRUST_TOKEN_UNSET_FOR_TEST" });
  const opts = { readGatewayTrustToken };

  // Rotating the header used to mint a fresh bucket per request.
  const first = core.serviceClientFingerprint(fakeRequest("192.168.0.9", { "x-forwarded-for": "1.1.1.1" }), "", opts);
  const second = core.serviceClientFingerprint(fakeRequest("192.168.0.9", { "x-forwarded-for": "2.2.2.2" }), "", opts);
  assert.equal(first, second);

  // Distinct callers still get distinct buckets.
  const other = core.serviceClientFingerprint(fakeRequest("192.168.0.10"), "", opts);
  assert.notEqual(first, other);

  // Through a signed hop the bucket follows the vouched-for client.
  const hopA = core.buildGatewayTrustHeaders(token, "192.168.0.9");
  assert.equal(core.serviceClientFingerprint(fakeRequest("127.0.0.1", hopA), "", opts), first);

  // An API key still wins as the bucket key.
  const keyed = core.serviceClientFingerprint(fakeRequest("192.168.0.9"), "sk-abc", opts);
  assert.notEqual(keyed, first);
});

test("config files fail closed when corrupt instead of silently reverting to defaults", async (t) => {
  const dir = tempDir("cfg-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "service-exposure-settings.json");

  // Missing is fine and yields the fallback.
  assert.deepEqual(await core.readJsonFile(file, { fallback: true }), { fallback: true });

  await fsp.writeFile(file, '{"enabled":true,"requi', "utf8");
  await assert.rejects(() => core.readJsonFile(file, {}), (error) => error.code === "CONFIG_CORRUPT");

  // A truncated write leaves a zero-length file; that is corruption, not an
  // intentionally empty config.
  await fsp.writeFile(file, "", "utf8");
  await assert.rejects(() => core.readJsonFile(file, {}), (error) => error.code === "CONFIG_CORRUPT");

  assert.ok(core.listConfigHealthIssues().some((issue) => issue.file === path.resolve(file)));

  // Valid content clears the recorded issue.
  await fsp.writeFile(file, '{"enabled":true}', "utf8");
  assert.deepEqual(await core.readJsonFile(file, {}), { enabled: true });
  assert.equal(core.listConfigHealthIssues().some((issue) => issue.file === path.resolve(file)), false);
});

test("service gateway rejects requests when the exposure config cannot be parsed", async (t) => {
  const dir = tempDir("cfg-gw-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "service-exposure-settings.json");
  await fsp.writeFile(file, '{"enabled":true,"requireApiKey":tr', "utf8");

  const store = core.createServiceExposureSettingsStore({
    file,
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
  });
  const middleware = core.createServiceGatewayMiddleware({
    gatewayName: "test",
    supportedKinds: ["openai"],
    getServiceExposureSettings: () => store.getServiceExposureSettings(),
    getServiceClientsLedger: async () => ({ clients: [] }),
    resolveServiceClientForApiKey: async () => null,
    rateBuckets: new Map(),
    concurrencyBuckets: new Map(),
  });

  const req = fakeRequest("192.168.0.77");
  req.path = "/serve/v1/chat/completions";
  req.originalUrl = req.path;
  req.url = req.path;
  const res = fakeResponse();
  let passedThrough = false;
  await middleware(req, res, () => { passedThrough = true; });

  assert.equal(passedThrough, false, "a corrupt config must not fall through to the model");
  assert.equal(res.statusCode, 500);
});

test("a configured service API key survives a manager restart", async (t) => {
  const dir = tempDir("keyrt-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "service-exposure-settings.json");
  const newStore = () => core.createServiceExposureSettingsStore({
    file,
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
  });

  const saved = await newStore().saveServiceExposureSettings(
    { enabled: true, exposureMode: "lan", requireApiKey: true, apiKey: "sk-local-abc123" },
    {},
  );
  assert.equal(core.isGlobalServiceApiKeyAccepted("sk-local-abc123", saved), true);
  // Only the hash is persisted.
  assert.equal(JSON.parse(await fsp.readFile(file, "utf8")).apiKey, "");

  // Reloading used to drop the stored hash, because the persisted apiKey:"" was
  // read as "set the key to empty".
  const reloaded = await newStore().getServiceExposureSettings();
  assert.equal(core.hasGlobalServiceApiKey(reloaded), true);
  assert.equal(core.isGlobalServiceApiKeyAccepted("sk-local-abc123", reloaded), true);
  assert.equal(core.isGlobalServiceApiKeyAccepted("sk-wrong", reloaded), false);

  // Saving an unrelated setting keeps the key.
  const updated = await newStore().saveServiceExposureSettings(
    { ...core.redactServiceExposureSettings(reloaded), notes: "changed" },
    reloaded,
  );
  assert.equal(core.isGlobalServiceApiKeyAccepted("sk-local-abc123", updated), true);

  // Clearing is still explicit and still works.
  const cleared = await newStore().saveServiceExposureSettings({ clearApiKey: true }, updated);
  assert.equal(core.hasGlobalServiceApiKey(cleared), false);
});

test("secret records keep their hash when re-normalized without a new secret", () => {
  const created = core.normalizeSecretRecord({ apiKey: "sk-secret-value" }, {});
  assert.equal(created.hash.length, 64);
  // A persisted record carries hash + preview and an empty secret.
  const persisted = { apiKey: "", apiKeyHash: created.hash, apiKeyPreview: created.preview };
  assert.equal(core.normalizeSecretRecord(persisted, {}).hash, created.hash);
  assert.equal(core.normalizeSecretRecord({}, persisted).hash, created.hash);
  assert.equal(core.normalizeSecretRecord({ clearApiKey: true }, persisted).hash, "");
});

test("exposure checks report unparseable config files", () => {
  const checks = core.buildServiceExposureChecks(
    { enabled: true, exposureMode: "lan", requireApiKey: true },
    { configIssues: [{ file: "D:/AI/vllm-manager/logs/service-exposure-settings.json", kind: "corrupt", message: "bad" }] },
  );
  const check = checks.find((item) => item.title === "配置文件完整性");
  assert.ok(check, "config integrity check should be present");
  assert.equal(check.status, "fail");
});

test("reference data loads bundled tables and reports freshness", () => {
  core.clearReferenceDataCache();
  const pricing = core.loadModelPricing({ now: Date.parse("2026-06-01T00:00:00Z") });
  assert.ok(pricing.profiles.length > 0);
  assert.equal(pricing.source, "bundled");
  assert.equal(pricing.freshness.stale, false);

  core.clearReferenceDataCache();
  // Far enough past staleAfterDays that the UI should caveat the comparison.
  const aged = core.loadModelPricing({ now: Date.parse("2030-01-01T00:00:00Z"), force: true });
  assert.equal(aged.freshness.stale, true);
  assert.match(aged.freshness.notice, /参考数据来自/);

  core.clearReferenceDataCache();
  const gpu = core.loadGpuPerformance();
  assert.ok(gpu.factors.some((entry) => entry.match.includes("5090")));

  const payload = core.buildReferenceDataPayload();
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.pricing.profiles));
  assert.ok(Array.isArray(payload.gpuPerformance.factors));
  core.clearReferenceDataCache();
});

test("audit retention keeps the newest export and prunes by count and age", () => {
  const byCount = core.auditRetentionSettings({ auditMaxExports: 5, auditMaxAgeDays: 0 });
  assert.equal(byCount.maxExports, 5);
  assert.equal(byCount.maxAgeDays, 0);
  const defaults = core.auditRetentionSettings({});
  assert.equal(defaults.maxExports, core.DEFAULT_AUDIT_MAX_EXPORTS);
  assert.equal(defaults.maxAgeDays, core.DEFAULT_AUDIT_MAX_AGE_DAYS);
});

test("audit exports go incremental for automatic reasons and full for manual ones", async (t) => {
  const auditRoot = tempDir("audit-");
  t.after(() => fs.rmSync(auditRoot, { recursive: true, force: true }));

  const calls = [];
  let nextMaxUpdatedAt = 1000;
  const store = core.createAuditStore({
    auditRoot,
    auditPasswordFile: path.join(auditRoot, "audit-admin-password.txt"),
    openWebuiContainer: "open-webui",
    serviceContainer: "vllm-local",
    managerName: "vllm-manager",
    auditMaxExports: 2,
    getContainerStatus: async () => ({ exists: true }),
    docker: async (args) => {
      if (args[0] === "exec" && args[2] === "python") {
        calls.push(args.slice(4));
        return {
          stdout: JSON.stringify({
            ok: true,
            chat_count: 1,
            total_chat_count: 3,
            message_count: 2,
            incremental: args.length > 5,
            since_updated_at: args[5] ? Number(args[5]) : null,
            max_updated_at: nextMaxUpdatedAt,
            files: [],
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  });

  const manual = await store.exportOpenWebuiAudit("manual", {});
  assert.equal(manual.mode, "full");
  assert.equal(calls[0].length, 1, "a full export passes no cursor");

  nextMaxUpdatedAt = 2000;
  const auto = await store.exportOpenWebuiAudit("model-stop", {});
  assert.equal(auto.mode, "incremental");
  assert.equal(calls[1][1], "1000", "the second run resumes from the first run's cursor");

  // An explicit full request overrides the incremental default.
  nextMaxUpdatedAt = 3000;
  const forcedFull = await store.exportOpenWebuiAudit("model-stop", { full: true });
  assert.equal(forcedFull.mode, "full");

  const cursor = await store.readAuditCursor();
  assert.equal(cursor.maxUpdatedAt, 3000);

  // Retention capped the directory count, and the newest export is still there.
  const remaining = await store.listAuditExports();
  assert.ok(remaining.length <= 2, `expected at most 2 exports, got ${remaining.length}`);
  assert.equal(remaining[0].auditId, forcedFull.auditId);
});
