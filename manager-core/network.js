const net = require("node:net");
const os = require("node:os");

function getLanAddress(interfaces = os.networkInterfaces()) {
  for (const values of Object.values(interfaces || {})) {
    for (const item of values || []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return "127.0.0.1";
}

function normalizeRemoteAddress(value) {
  return String(value || "").trim().replace(/^::ffff:/, "").replace(/^\[|\]$/g, "") || "unknown";
}

function isLocalAddress(value) {
  const address = normalizeRemoteAddress(value).toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function isLocalRequest(req) {
  return isLocalAddress(req?.socket?.remoteAddress || req?.ip || "");
}

function extractHostname(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
      .hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

function isExternalAddress(remoteAddress, lanAddress = "") {
  const value = normalizeRemoteAddress(remoteAddress).toLowerCase();
  const localLan = normalizeRemoteAddress(lanAddress).toLowerCase();
  if (!value || value === "unknown") return false;
  if (isLocalAddress(value)) return false;
  if (localLan && value === localLan) return false;
  return true;
}

function isPortListening(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

module.exports = {
  getLanAddress,
  normalizeRemoteAddress,
  isLocalAddress,
  isLocalRequest,
  extractHostname,
  isExternalAddress,
  isPortListening,
};
