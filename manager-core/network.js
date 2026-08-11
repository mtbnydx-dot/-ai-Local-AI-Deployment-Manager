const net = require("node:net");
const os = require("node:os");

function getLanAddress(interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [name, values] of Object.entries(interfaces || {})) {
    for (const item of values || []) {
      if (item.family !== "IPv4" || item.internal || !item.address) continue;
      if (item.address === "127.0.0.1" || item.address.startsWith("169.254.")) continue;
      candidates.push({
        address: item.address,
        name,
        virtual: isVirtualInterfaceName(name) || isVirtualLanAddress(item.address),
        privateLan: isPrivateLanAddress(item.address),
      });
    }
  }
  const preferred = candidates
    .filter((item) => item.privateLan && !item.virtual)
    .sort((a, b) => lanAddressRank(a.address) - lanAddressRank(b.address))[0];
  return preferred?.address || candidates.find((item) => item.privateLan)?.address || candidates[0]?.address || "127.0.0.1";
}

function isVirtualInterfaceName(name = "") {
  return /docker|wsl|vethernet|hyper-v|virtualbox|vmware|loopback|tailscale|zerotier/i.test(String(name));
}

function isVirtualLanAddress(address = "") {
  // Docker Desktop and WSL commonly occupy 172.16/12. Prefer 192.168/10.x physical LANs when present.
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(String(address));
}

function isPrivateLanAddress(address = "") {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(String(address));
}

function lanAddressRank(address = "") {
  if (String(address).startsWith("192.168.")) return 0;
  if (String(address).startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(String(address))) return 2;
  return 3;
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
