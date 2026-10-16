"use strict";

// 05's admin auth over an in-memory access store, a fake clock and a fixed
// trust token, for unit tests of sessions, pairing, CSRF and elevation.
// Requests are plain objects ({ method, url, headers, socket }), so no
// server is needed; reply() is a minimal response that records what a
// route or the guard answered.

const { createAdminAuth } = require("../../lib/admin-session");
const { createKeysStore } = require("../../lib/keys-store");
const { createMachineAuth } = require("../../lib/machine-auth");
const { createViewerRegistry } = require("../../lib/viewer-allowlist");

const TRUST_TOKEN = "fake-trust-token-for-admin-session-tests-0000";
const LOOPBACK = "127.0.0.1";
const LAN = "192.168.1.50";

function adminConfig(overrides = {}) {
  const { admin = {}, lanBound = false, port = 5176 } = overrides;
  return {
    admin: {
      firstRunAutoPair: true,
      firstRunWindowMinutes: 30,
      sessionDays: 180,
      loopbackViewer: true,
      lanAnonymousViewer: true,
      allowLanOwner: false,
      // The unit suites exercise the pairing machinery, so the fixture runs in
      // the pairing mode (the opt-outs); defaults: true uses the shipped
      // defaults instead (this machine and a LAN-bound LAN are the owner).
      requirePairingOnLoopback: true,
      ...(overrides.defaults === true ? { allowLanOwner: true, requirePairingOnLoopback: false } : {}),
      ...admin,
    },
    listeners: { admin: { host: lanBound ? "0.0.0.0" : "127.0.0.1", port, lan: lanBound } },
    adminLanBound: lanBound,
  };
}

function makeAdminAuth(options = {}) {
  const clock = { now: options.start ?? Date.parse("2026-10-15T08:00:00.000Z") };
  const store = options.store || createKeysStore({ file: ":memory:", now: () => new Date(clock.now) });
  let config = adminConfig({ ...options.config, defaults: options.defaults });
  const registry = createViewerRegistry({ logger: { warn() {}, error() {} } });
  registry.registerRoute({ owner: "test", path: "/" });
  registry.registerRoute({ owner: "test", path: "/api/status", redact: (body) => ({ ...body, secret: undefined }) });
  registry.registerAdminOnly({ owner: "test", method: "GET", path: "/api/keys" });
  const machineAuth = createMachineAuth({ getToken: () => TRUST_TOKEN, viewerRegistry: registry, now: () => clock.now });
  const scan = { value: options.scanState ?? null };
  const files = new Set(options.files || []);
  const logged = [];
  const logger = { log: (line) => logged.push(String(line)), warn: (line) => logged.push(String(line)), error: (line) => logged.push(String(line)) };
  const auth = createAdminAuth({
    store: options.storeGetter || store,
    config: () => config,
    now: () => clock.now,
    scanState: () => scan.value,
    machineAuth,
    viewerRegistry: registry,
    aiRoot: options.aiRoot || "<AI_ROOT>",
    fileExists: (file) => files.has(file),
    getLanAddress: () => options.lanAddress ?? "192.168.1.10",
    lanOwnerForcedOff: () => options.lanOwnerForcedOff === true,
    logger,
  });
  return {
    auth,
    store,
    registry,
    machineAuth,
    clock,
    scan,
    files,
    logged,
    setConfig(next) {
      config = adminConfig({ defaults: options.defaults, ...next });
    },
  };
}

function fakeRequest({ method = "GET", url = "/", headers = {}, peer = LOOPBACK } = {}) {
  return { method, url, headers: { host: "127.0.0.1:5176", ...headers }, socket: { remoteAddress: peer }, resume() {} };
}

function reply() {
  const headers = {};
  const res = {
    headersSent: false,
    status: 0,
    body: "",
    getHeader: (name) => headers[name.toLowerCase()],
    setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
    writeHead(status, extra = {}) {
      this.status = status;
      for (const [name, value] of Object.entries(extra)) headers[name.toLowerCase()] = value;
      this.headersSent = true;
    },
    end(body = "") {
      this.body += String(body);
      this.writableEnded = true;
    },
    destroy() {},
    headers,
    get json() {
      try {
        return JSON.parse(this.body);
      } catch {
        return null;
      }
    },
  };
  return res;
}

// "lai_admin=<id>.<secret>" out of a Set-Cookie line.
function cookiePair(setCookie) {
  return String(setCookie || "").split(";")[0];
}

module.exports = {
  LAN,
  LOOPBACK,
  TRUST_TOKEN,
  adminConfig,
  cookiePair,
  fakeRequest,
  makeAdminAuth,
  reply,
};
