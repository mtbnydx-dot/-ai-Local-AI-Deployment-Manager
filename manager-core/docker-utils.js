function isPinnedImageReference(image) {
  const text = String(image || "");
  if (/@sha256:[a-f0-9]{64}$/i.test(text)) return true;
  const tagMatch = text.match(/:([^:/@]+)$/);
  if (!tagMatch) return false;
  return !/^(latest|main|nightly|cuda|server|server-cuda)$/i.test(tagMatch[1]);
}

function createDockerPublishHelpers(options = {}) {
  const containerPort = Number(options.containerPort || 0) || 8000;
  const getLanAddress = typeof options.getLanAddress === "function"
    ? options.getLanAddress
    : () => "127.0.0.1";

  function portPublishArg(port, networkAccess, serviceHost) {
    const args = dockerPublishArgs(port, networkAccess, serviceHost);
    return args[args.length - 1] || `127.0.0.1:${port}:${containerPort}`;
  }

  function dockerPublishArgs(port, networkAccess, serviceHost) {
    if (networkAccess !== "lan") return [`127.0.0.1:${port}:${containerPort}`];
    const lanHost = normalizeLanBindHost(serviceHost);
    if (isWildcardHost(lanHost)) return [`0.0.0.0:${port}:${containerPort}`];
    return [`127.0.0.1:${port}:${containerPort}`, `${lanHost}:${port}:${containerPort}`];
  }

  function normalizeLanBindHost(value) {
    const host = stripHostBrackets(value || getLanAddress());
    if (host && !isLoopbackHost(host) && !isWildcardHost(host)) return host;
    const detected = stripHostBrackets(getLanAddress());
    if (detected && !isLoopbackHost(detected) && !isWildcardHost(detected)) return detected;
    return "0.0.0.0";
  }

  function parseDockerPortPublish(ports) {
    const text = String(ports || "");
    const exact = collectDockerPortBindings(text, containerPort);
    const bindings = exact.length ? exact : collectDockerPortBindings(text, null);
    if (!bindings.length) return null;
    const local = bindings.find((item) => isLoopbackHost(item.host));
    const wildcard = bindings.find((item) => isWildcardHost(item.host));
    const lan = bindings.find((item) => !isLoopbackHost(item.host) && !isWildcardHost(item.host));
    const primary = lan || wildcard || local || bindings[0];
    return {
      host: primary.host,
      port: primary.port,
      localHost: local?.host || (wildcard ? "127.0.0.1" : null),
      lanHost: lan?.host || (wildcard ? getLanAddress() : null),
      bindings,
    };
  }

  return {
    portPublishArg,
    dockerPublishArgs,
    normalizeLanBindHost,
    parseDockerPortPublish,
    publishArgsToDockerRunArgs,
    replaceDockerPublishArgs,
    isDockerPublishBindError,
    stripHostBrackets,
    isLoopbackHost,
    isWildcardHost,
    collectDockerPortBindings,
  };
}

function publishArgsToDockerRunArgs(publishArgs) {
  return (publishArgs || []).flatMap((arg) => ["-p", arg]);
}

function replaceDockerPublishArgs(args, publishArgs) {
  const next = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-p" || args[index] === "--publish") {
      index += 1;
      continue;
    }
    next.push(args[index]);
  }
  const insertAt = Math.max(0, next.indexOf("--ipc=host") + 1);
  next.splice(insertAt, 0, ...publishArgsToDockerRunArgs(publishArgs));
  return next;
}

function isDockerPublishBindError(error) {
  const text = `${error?.stderr || ""}\n${error?.stdout || ""}\n${error?.message || ""}`.toLowerCase();
  return /bind|port is already allocated|cannot assign requested address|listen tcp|driver failed programming external connectivity|ports are not available/.test(text);
}

function stripHostBrackets(value) {
  return String(value || "").trim().replace(/^\[|\]$/g, "");
}

function isLoopbackHost(host) {
  const value = stripHostBrackets(host).toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function isWildcardHost(host) {
  const value = stripHostBrackets(host).toLowerCase();
  return value === "0.0.0.0" || value === "::" || value === "";
}

function collectDockerPortBindings(text, containerPort) {
  const host = String.raw`(\d{1,3}(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::\]|\[::1\]|::1|localhost)`;
  const target = containerPort ? String(containerPort) : String.raw`\d+`;
  const regex = new RegExp(String.raw`(?:${host}:)?(\d+)->${target}\/tcp`, "g");
  const bindings = [];
  let match;
  while ((match = regex.exec(String(text || "")))) {
    bindings.push({
      host: match[1] || "0.0.0.0",
      port: Number(match[2]),
    });
  }
  return bindings;
}

module.exports = {
  isPinnedImageReference,
  createDockerPublishHelpers,
  publishArgsToDockerRunArgs,
  replaceDockerPublishArgs,
  isDockerPublishBindError,
  stripHostBrackets,
  isLoopbackHost,
  isWildcardHost,
  collectDockerPortBindings,
};
