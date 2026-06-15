const { extractHostname, isLocalRequest } = require("./network");
const { getServiceGatewayKind } = require("./gateway-utils");

function createAllowedRequestHostnames(options = {}) {
  const host = options.host || "127.0.0.1";
  const getLanAddress = typeof options.getLanAddress === "function"
    ? options.getLanAddress
    : () => "";
  const cacheTtlMs = Number(options.cacheTtlMs || 60000);
  let cache = { value: null, expiresAt: 0 };

  return function allowedRequestHostnames() {
    if (cache.value && cache.expiresAt > Date.now()) return cache.value;
    const names = new Set(["127.0.0.1", "localhost", "::1", String(host).toLowerCase()]);
    try {
      const lan = String(getLanAddress() || "").toLowerCase();
      if (lan) names.add(lan);
    } catch {
      // Network interface enumeration failed; loopback names still apply.
    }
    cache = { value: names, expiresAt: Date.now() + cacheTtlMs };
    return names;
  };
}

function createManagerSecurityGuard(options = {}) {
  const allowedRequestHostnames = options.allowedRequestHostnames || createAllowedRequestHostnames(options);
  const localRequest = options.isLocalRequest || isLocalRequest;
  const hostExtractor = options.extractHostname || extractHostname;
  const gatewayKind = options.getServiceGatewayKind || getServiceGatewayKind;
  const gatewayKinds = options.gatewayKinds || ["openai", "claude"];
  const allowRemoteManagement = Boolean(options.allowRemoteManagement);
  const blockRemoteReads = Boolean(options.blockRemoteReads);
  const remoteManagementError = options.remoteManagementError
    || "管理后台默认仅允许本机访问；局域网设备只能访问带 API Key 的模型网关接口。";
  const originError = options.originError || "跨站请求被拒绝（Origin 校验失败）。";

  function managerSecurityGuard(req, res, next) {
    const hostname = hostExtractor(req.headers?.host);
    if (!hostname || !allowedRequestHostnames().has(hostname)) {
      return res.status(403).json({ error: `请求的 Host 不在白名单内：${hostname || "(空)"}` });
    }
    const isLocal = localRequest(req);
    if (!isLocal && gatewayKind(req, gatewayKinds)) return next();
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(String(req.method || "GET").toUpperCase());
    if (!isLocal && !allowRemoteManagement && (blockRemoteReads || mutating)) {
      return res.status(403).json({ error: remoteManagementError });
    }
    if (!mutating) return next();
    const origin = String(req.headers?.origin || "").trim();
    if (origin) {
      const originHost = hostExtractor(origin);
      if (origin === "null" || !originHost || !allowedRequestHostnames().has(originHost)) {
        return res.status(403).json({ error: originError });
      }
    }
    return next();
  }

  return {
    allowedRequestHostnames,
    managerSecurityGuard,
  };
}

module.exports = {
  createAllowedRequestHostnames,
  createManagerSecurityGuard,
};
