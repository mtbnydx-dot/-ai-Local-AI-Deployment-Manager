const childProcess = require("node:child_process");
const net = require("node:net");
const tls = require("node:tls");
const zlib = require("node:zlib");

let cachedWindowsProxy = null;

function getProxyForUrl(targetUrl, env = process.env) {
  if (!targetUrl || isNoProxyMatch(targetUrl, env.NO_PROXY || env.no_proxy || "")) return "";
  const url = new URL(targetUrl);
  const envProxy = url.protocol === "https:"
    ? (env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy)
    : (env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy);
  const proxy = normalizeProxyUrl(envProxy || getWindowsProxyForProtocol(url.protocol));
  if (!proxy || !/^https?:\/\//i.test(proxy)) return "";
  return proxy;
}

async function fetchWithSystemProxyFallback(fetchImpl, url, init = {}, options = {}) {
  const allowProxyFallback = options.allowProxyFallback !== false;
  const directFetch = fetchImpl || globalThis.fetch;
  const target = String(url);
  const proxyUrl = allowProxyFallback ? getProxyForUrl(target, options.env || process.env) : "";

  if (proxyUrl && options.preferProxy !== false) {
    try {
      return await fetchThroughHttpProxy(target, init, proxyUrl);
    } catch (proxyError) {
      if (options.proxyOnly) throw proxyError;
    }
  }

  try {
    return await directFetch(url, init);
  } catch (error) {
    if (!allowProxyFallback || !proxyUrl || !isFetchNetworkFailure(error)) throw error;
    return fetchThroughHttpProxy(target, init, proxyUrl);
  }
}

async function fetchThroughHttpProxy(targetUrl, init = {}, proxyUrl) {
  const target = new URL(targetUrl);
  const proxy = new URL(normalizeProxyUrl(proxyUrl));
  if (!["http:", "https:"].includes(proxy.protocol)) {
    throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`);
  }
  if (target.protocol === "https:") return fetchHttpsThroughHttpProxy(target, init, proxy);
  if (target.protocol === "http:") return fetchHttpThroughProxy(target, init, proxy);
  throw new Error(`Unsupported URL protocol: ${target.protocol}`);
}

async function fetchHttpsThroughHttpProxy(target, init, proxy) {
  const socket = await connectSocket(proxy.hostname, proxyPort(proxy), init.signal);
  try {
    const targetPort = target.port || 443;
    const auth = proxyAuthorizationHeader(proxy);
    const connectHeaders = [
      `CONNECT ${target.hostname}:${targetPort} HTTP/1.1`,
      `Host: ${target.hostname}:${targetPort}`,
      "Proxy-Connection: Keep-Alive",
    ];
    if (auth) connectHeaders.push(`Proxy-Authorization: ${auth}`);
    socket.write(`${connectHeaders.join("\r\n")}\r\n\r\n`);

    const proxyHead = await readHeader(socket, init.signal);
    const proxyResponse = parseResponseHead(proxyHead.header);
    if (proxyResponse.status < 200 || proxyResponse.status >= 300) {
      throw new Error(`Proxy CONNECT failed (${proxyResponse.status} ${proxyResponse.statusText})`);
    }
    if (proxyHead.leftover.length) socket.unshift(proxyHead.leftover);

    const secure = tls.connect({
      socket,
      servername: target.hostname,
    });
    await waitForSecureConnect(secure, init.signal);
    return await sendHttpRequest(secure, target, init);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function fetchHttpThroughProxy(target, init, proxy) {
  const socket = await connectSocket(proxy.hostname, proxyPort(proxy), init.signal);
  try {
    return await sendHttpRequest(socket, target, init, {
      absolutePath: target.href,
      proxyAuth: proxyAuthorizationHeader(proxy),
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function sendHttpRequest(stream, target, init = {}, options = {}) {
  const method = String(init.method || "GET").toUpperCase();
  const headers = normalizeHeaders(init.headers);
  const body = bodyToBuffer(init.body);
  if (!headers.host) headers.host = target.host;
  if (!headers.accept) headers.accept = "application/json";
  if (!headers["user-agent"]) headers["user-agent"] = "local-ai-manager/0.1";
  if (!headers["accept-encoding"]) headers["accept-encoding"] = "identity";
  headers.connection = "close";
  if (body && !headers["content-length"]) headers["content-length"] = String(body.length);
  if (options.proxyAuth) headers["proxy-authorization"] = options.proxyAuth;

  const path = options.absolutePath || `${target.pathname || "/"}${target.search || ""}`;
  const requestHead = [
    `${method} ${path} HTTP/1.1`,
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    "",
    "",
  ].join("\r\n");

  stream.write(requestHead);
  if (body) stream.write(body);
  const raw = await readAll(stream, init.signal);
  return parseHttpResponse(raw);
}

function connectSocket(host, port, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const socket = net.connect(Number(port), host);
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onConnect = () => {
      cleanup();
      socket.setTimeout(0);
      resolve(socket);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(new Error("Proxy connection timed out"));
    };
    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(abortError());
    };
    socket.setTimeout(15000);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    return null;
  });
}

function waitForSecureConnect(stream, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const cleanup = () => {
      stream.off("secureConnect", onSecureConnect);
      stream.off("error", onError);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onSecureConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      stream.destroy();
      reject(abortError());
    };
    stream.once("secureConnect", onSecureConnect);
    stream.once("error", onError);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    return null;
  });
}

function readHeader(stream, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const chunks = [];
    let total = 0;
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      const buffer = Buffer.concat(chunks, total);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      cleanup();
      resolve({
        header: buffer.slice(0, end).toString("latin1"),
        leftover: buffer.slice(end + 4),
      });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      stream.destroy();
      reject(abortError());
    };
    stream.on("data", onData);
    stream.once("error", onError);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function readAll(stream, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const chunks = [];
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onData = (chunk) => chunks.push(chunk);
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      stream.destroy();
      reject(abortError());
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function parseHttpResponse(raw) {
  const marker = raw.indexOf("\r\n\r\n");
  if (marker < 0) throw new Error("Invalid HTTP response from proxy tunnel");
  const head = raw.slice(0, marker).toString("latin1");
  const parsed = parseResponseHead(head);
  let body = raw.slice(marker + 4);
  if (/chunked/i.test(parsed.headers["transfer-encoding"] || "")) body = decodeChunkedBody(body);
  body = decodeContentBody(body, parsed.headers["content-encoding"]);
  return {
    ok: parsed.status >= 200 && parsed.status < 300,
    status: parsed.status,
    statusText: parsed.statusText,
    headers: {
      get: (name) => parsed.headers[String(name || "").toLowerCase()] || null,
    },
    text: async () => body.toString("utf8"),
    json: async () => JSON.parse(body.toString("utf8")),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

function parseResponseHead(head) {
  const lines = String(head || "").split(/\r?\n/);
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/i.exec(lines.shift() || "");
  if (!statusMatch) throw new Error("Invalid HTTP status from proxy tunnel");
  const headers = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  return {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] || "",
    headers,
  };
}

function decodeChunkedBody(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const sizeText = buffer.slice(offset, lineEnd).toString("ascii").split(";")[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error("Invalid chunked response from proxy tunnel");
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(buffer.slice(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

function decodeContentBody(body, encoding = "") {
  const value = String(encoding || "").toLowerCase();
  if (!value || value === "identity") return body;
  if (value.includes("gzip")) return zlib.gunzipSync(body);
  if (value.includes("br")) return zlib.brotliDecompressSync(body);
  if (value.includes("deflate")) return zlib.inflateSync(body);
  return body;
}

function normalizeHeaders(input) {
  const headers = {};
  if (!input) return headers;
  if (typeof input.forEach === "function") {
    input.forEach((value, key) => {
      headers[String(key).toLowerCase()] = String(value);
    });
    return headers;
  }
  const entries = Array.isArray(input) ? input : Object.entries(input);
  for (const [key, value] of entries) {
    if (value == null) continue;
    headers[String(key).toLowerCase()] = String(value);
  }
  return headers;
}

function bodyToBuffer(body) {
  if (body == null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("Proxy fetch only supports string, Buffer, ArrayBuffer, and URLSearchParams bodies");
}

function getWindowsProxyForProtocol(protocol) {
  if (process.platform !== "win32") return "";
  if (cachedWindowsProxy) return cachedWindowsProxy[protocol] || cachedWindowsProxy.default || "";
  cachedWindowsProxy = {};
  try {
    const output = childProcess.execFileSync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    ], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    if (!/\bProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output)) return "";
    const proxyMatch = /\bProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(output);
    if (!proxyMatch) return "";
    cachedWindowsProxy = parseWindowsProxyServer(proxyMatch[1].trim());
    return cachedWindowsProxy[protocol] || cachedWindowsProxy.default || "";
  } catch {
    cachedWindowsProxy = {};
    return "";
  }
}

function parseWindowsProxyServer(value) {
  if (!String(value || "").includes("=")) return { default: value };
  const result = {};
  for (const part of String(value).split(";")) {
    const [key, raw] = part.split("=");
    if (!key || !raw) continue;
    if (/^https$/i.test(key)) result["https:"] = raw;
    if (/^http$/i.test(key)) result["http:"] = raw;
  }
  return result;
}

function normalizeProxyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[a-z]+:\/\//i.test(raw)) return raw;
  return `http://${raw}`;
}

function proxyPort(proxy) {
  if (proxy.port) return Number(proxy.port);
  return proxy.protocol === "https:" ? 443 : 80;
}

function proxyAuthorizationHeader(proxy) {
  if (!proxy.username) return "";
  const user = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password || "");
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function isFetchNetworkFailure(error) {
  if (!error) return false;
  const code = error.code || error.cause?.code;
  if (["UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) return true;
  return /fetch failed|network|timeout/i.test(String(error.message || ""));
}

function isNoProxyMatch(targetUrl, noProxy) {
  const value = String(noProxy || "").trim();
  if (!value) return false;
  const host = new URL(targetUrl).hostname.toLowerCase();
  return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).some((rule) => {
    if (rule === "*") return true;
    if (rule.startsWith(".")) return host.endsWith(rule);
    return host === rule || host.endsWith(`.${rule}`);
  });
}

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

module.exports = {
  fetchWithSystemProxyFallback,
  fetchThroughHttpProxy,
  getProxyForUrl,
  isFetchNetworkFailure,
  normalizeProxyUrl,
  parseWindowsProxyServer,
};
