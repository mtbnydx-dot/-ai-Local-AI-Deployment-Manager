const assert = require("node:assert/strict");
const test = require("node:test");

const { authorizeGateway, envConfig } = require("../server");

function req(remoteAddress, headers = {}) {
  return { headers, socket: { remoteAddress } };
}

test("default bind is loopback, not every interface", () => {
  const config = envConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.allowNoKey, false);
  // The container still binds all of its own interfaces; exposure is decided by
  // the published port in docker-compose.
  assert.equal(envConfig({ SEARCH_GATEWAY_HOST: "0.0.0.0" }).host, "0.0.0.0");
});

test("a keyless gateway refuses non-loopback callers instead of serving them", () => {
  // This process holds the upstream credential, so an open instance would turn
  // an unauthenticated caller into an authenticated model request.
  const exposed = envConfig({ SEARCH_GATEWAY_HOST: "0.0.0.0" });
  assert.equal(authorizeGateway(req("192.168.0.30"), exposed), false);
  assert.equal(authorizeGateway(req("127.0.0.1"), exposed), false);

  // Loopback-only is no more reachable than the model service itself.
  const local = envConfig({});
  assert.equal(authorizeGateway(req("127.0.0.1"), local), true);
  assert.equal(authorizeGateway(req("::ffff:127.0.0.1"), local), true);
  assert.equal(authorizeGateway(req("192.168.0.30"), local), false);
});

test("the explicit switch restores keyless operation for a trusted LAN", () => {
  const opened = envConfig({ SEARCH_GATEWAY_HOST: "0.0.0.0", SEARCH_GATEWAY_ALLOW_NO_KEY: "true" });
  assert.equal(opened.allowNoKey, true);
  assert.equal(authorizeGateway(req("192.168.0.30"), opened), true);
});

test("a configured key is required and compared exactly", () => {
  const config = envConfig({ SEARCH_GATEWAY_HOST: "0.0.0.0", SEARCH_GATEWAY_API_KEY: "sk-search-key" });
  assert.equal(authorizeGateway(req("192.168.0.30"), config), false);
  assert.equal(authorizeGateway(req("192.168.0.30", { authorization: "Bearer sk-search-key" }), config), true);
  assert.equal(authorizeGateway(req("192.168.0.30", { "x-api-key": "sk-search-key" }), config), true);
  assert.equal(authorizeGateway(req("192.168.0.30", { authorization: "Bearer sk-wrong" }), config), false);
  // A key beats the loopback allowance: local callers must present it too.
  assert.equal(authorizeGateway(req("127.0.0.1"), config), false);
});
