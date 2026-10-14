"use strict";

// The two listeners of the entry (05 §3.1): ADMIN (console, /api/*, local and
// LAN /gateway/*) and PUBLIC (portal plus the public API, the only target for
// a tunnel). One process, two http.Server objects. Every request is tagged
// with the listener it arrived on, and trust decisions read req.listener,
// never a header.
//
//   startListeners({ config, adminHandler, publicHandler }) ->
//     Promise<{ admin, public, close() }>
//
// ADMIN failing to bind rejects (the entry cannot run without it). PUBLIC
// failing to bind never does: the entry keeps ADMIN, logs
// public_listener_unavailable and reports the error in `publicError`.

const http = require("node:http");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);
const WILDCARD_HOST = "0.0.0.0";

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host ?? "").trim().toLowerCase());
}

function isWildcardHost(host) {
  return ["0.0.0.0", "::", "[::]", "*"].includes(String(host ?? "").trim().toLowerCase());
}

/**
 * Marks a request with the listener it arrived on: req.listener =
 * { kind: "admin"|"public", lanBound }. `lanBound` tells whether that listener
 * accepts off-box sockets. Returns the request.
 */
function tagListener(req, kind, lanBound = false) {
  req.listener = Object.freeze({ kind: kind === "public" ? "public" : "admin", lanBound: lanBound === true });
  return req;
}

// The address a listener binds. ADMIN with `lan` set binds the wildcard even
// when `host` is still the loopback default; a wildcard host is LAN-bound by
// itself. PUBLIC binds exactly listeners.public.host.
function resolveBinds(config) {
  const listeners = config?.listeners || {};
  const admin = listeners.admin || {};
  const pub = listeners.public || {};
  const adminHost = String(admin.host || "127.0.0.1");
  const adminLan = admin.lan === true || !isLoopbackHost(adminHost);
  const publicHost = String(pub.host || "127.0.0.1");
  return {
    admin: {
      host: admin.lan === true && isLoopbackHost(adminHost) ? WILDCARD_HOST : adminHost,
      port: Number.isInteger(Number(admin.port)) ? Number(admin.port) : 5176,
      lanBound: adminLan,
    },
    public: {
      enabled: pub.enabled !== false,
      host: publicHost,
      port: Number.isInteger(Number(pub.port)) ? Number(pub.port) : 5186,
      lanBound: !isLoopbackHost(publicHost),
    },
  };
}

function wrapHandler(handler, kind, lanBound, logger) {
  return (req, res) => {
    tagListener(req, kind, lanBound);
    let pending;
    try {
      pending = handler(req, res);
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending).catch((error) => {
      logger?.error?.(`${kind} listener: request handler failed: ${error?.message || error}`);
      if (!res.headersSent) {
        try {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: { message: "Internal error.", code: "internal_error" } }));
        } catch {
          res.destroy();
        }
      } else {
        res.destroy();
      }
    });
  };
}

function listenOn(server, bind) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address());
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(bind.port, bind.host);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}

function describeBindError(kind, bind, error) {
  if (error?.code === "EADDRINUSE") return `port ${bind.port} on ${bind.host} is already in use`;
  return `${kind} listener could not bind ${bind.host}:${bind.port}: ${error?.code || error?.message || error}`;
}

/**
 * Binds the ADMIN and PUBLIC servers.
 *   config          an AccessConfig (public-config.js): listeners.{admin,public}
 *   adminHandler    (req, res) for ADMIN
 *   publicHandler   (req, res) for PUBLIC
 *   createServer    (handler) -> http.Server; defaults to http.createServer
 *   decorate        (kind, server) called before listen (timers, close hooks)
 *   onPublicUnavailable  (error) called when PUBLIC could not bind
 *   logger          { log, warn, error }
 * Resolves { admin, public, publicError, binds, close() }. `public` is null
 * when PUBLIC is disabled or failed to bind; `binds` holds the bound
 * addresses ({ host, port, lanBound }) of the listeners that are up.
 */
async function startListeners({
  config,
  adminHandler,
  publicHandler,
  createServer = http.createServer,
  decorate,
  onPublicUnavailable,
  logger = console,
} = {}) {
  if (typeof adminHandler !== "function") throw new TypeError("startListeners needs adminHandler(req, res).");
  const wanted = resolveBinds(config);
  const make = (kind, handler, lanBound) => {
    const server = createServer(wrapHandler(handler, kind, lanBound, logger));
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    decorate?.(kind, server);
    return server;
  };

  const admin = make("admin", adminHandler, wanted.admin.lanBound);
  let adminAddress;
  try {
    adminAddress = await listenOn(admin, wanted.admin);
  } catch (error) {
    error.message = describeBindError("admin", wanted.admin, error);
    throw error;
  }
  const binds = { admin: { host: adminAddress.address, port: adminAddress.port, lanBound: wanted.admin.lanBound } };

  let publicServer = null;
  let publicError = null;
  if (wanted.public.enabled && typeof publicHandler === "function") {
    const candidate = make("public", publicHandler, wanted.public.lanBound);
    try {
      const address = await listenOn(candidate, wanted.public);
      publicServer = candidate;
      binds.public = { host: address.address, port: address.port, lanBound: wanted.public.lanBound };
    } catch (error) {
      publicError = { code: String(error?.code || "listen_failed"), message: describeBindError("public", wanted.public, error) };
      logger?.error?.(`public_listener_unavailable: ${publicError.message}; the ADMIN listener keeps running.`);
      try {
        onPublicUnavailable?.(publicError);
      } catch {
        // A reporting hook never stops the entry.
      }
    }
  }

  let closing = null;
  return {
    admin,
    public: publicServer,
    publicError,
    binds,
    close() {
      if (!closing) closing = Promise.all([closeServer(publicServer), closeServer(admin)]).then(() => undefined);
      return closing;
    },
  };
}

module.exports = {
  isLoopbackHost,
  isWildcardHost,
  resolveBinds,
  startListeners,
  tagListener,
};
