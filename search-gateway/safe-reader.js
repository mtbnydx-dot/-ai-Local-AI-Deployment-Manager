const dns = require("node:dns").promises;
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const zlib = require("node:zlib");

const BLOCKED_HOST_SUFFIXES = [
  ".internal",
  ".local",
  ".localhost",
  ".home.arpa",
];

const BLOCKED_IPV4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const BLOCKED_IPV6 = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

const addressBlockList = new net.BlockList();
for (const [address, prefix] of BLOCKED_IPV4) addressBlockList.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of BLOCKED_IPV6) addressBlockList.addSubnet(address, prefix, "ipv6");

async function readPublicPage(urlValue, options = {}, deps = {}) {
  const config = {
    timeoutMs: numberInRange(options.timeoutMs, 1000, 60000, 12000),
    maxBytes: numberInRange(options.maxBytes, 64 * 1024, 5 * 1024 * 1024, 2 * 1024 * 1024),
    maxRedirects: numberInRange(options.maxRedirects, 0, 5, 3),
    maxChars: numberInRange(options.maxChars, 500, 30000, 8000),
    userAgent: String(options.userAgent || "local-ai-search-gateway/0.2 (+safe-result-reader)"),
  };
  const lookup = deps.lookup || dns.lookup.bind(dns);
  const requestImpl = deps.request || requestPinned;
  let current = normalizePublicUrl(urlValue);
  const redirectChain = [];

  for (let redirectCount = 0; redirectCount <= config.maxRedirects; redirectCount += 1) {
    const target = await resolvePublicTarget(current, lookup);
    const response = await requestImpl(target, config);
    if (isRedirectStatus(response.statusCode)) {
      if (!response.location) throw new Error(`Page returned HTTP ${response.statusCode} without a redirect location.`);
      if (redirectCount >= config.maxRedirects) throw new Error(`Page exceeded the ${config.maxRedirects}-redirect safety limit.`);
      const next = normalizePublicUrl(new URL(response.location, current));
      redirectChain.push(next.toString());
      current = next;
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Page returned HTTP ${response.statusCode}.`);
    }
    const contentType = normalizeContentType(response.contentType);
    if (contentType && !isReadableContentType(contentType)) {
      throw new Error(`Page content type ${contentType} is not supported; only HTML and plain text search results can be read.`);
    }
    const decoded = decodeBody(response.body, response.contentEncoding, response.contentType, config.maxBytes);
    const document = contentType === "text/plain"
      ? extractPlainText(decoded, current, config.maxChars)
      : extractReadableDocument(decoded, current, config.maxChars);
    return {
      requestedUrl: String(urlValue),
      finalUrl: current.toString(),
      domain: current.hostname.toLowerCase(),
      redirectChain,
      contentType: contentType || "text/html",
      ...document,
    };
  }
  throw new Error("Page redirect handling failed.");
}

function normalizePublicUrl(value) {
  let parsed;
  try {
    parsed = value instanceof URL ? new URL(value.href) : new URL(String(value || ""));
  } catch {
    throw new Error("Search result URL is invalid.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS search results can be read.");
  if (parsed.username || parsed.password) throw new Error("URLs containing credentials cannot be read.");
  const expectedPort = parsed.protocol === "https:" ? "443" : "80";
  if (parsed.port && parsed.port !== expectedPort) throw new Error("Search-result reading is limited to standard HTTP and HTTPS ports.");
  parsed.hash = "";
  return parsed;
}

async function resolvePublicTarget(urlValue, lookup = dns.lookup.bind(dns)) {
  const url = normalizePublicUrl(urlValue);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedHostname(hostname)) throw new Error("Search result resolves to a local or reserved hostname and cannot be read.");

  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("Search result hostname could not be resolved.");
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error("Search result hostname resolved to no addresses.");
  const normalized = addresses.map((entry) => ({
    address: String(entry.address || ""),
    family: Number(entry.family) || net.isIP(String(entry.address || "")),
  }));
  if (normalized.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("Search result hostname resolves to a local or reserved network address and cannot be read.");
  }
  const chosen = normalized.find((entry) => entry.family === 4) || normalized[0];
  return { url, hostname, address: chosen.address, family: chosen.family };
}

function isBlockedHostname(hostnameValue) {
  const hostname = String(hostnameValue || "").toLowerCase().replace(/\.+$/, "");
  if (!hostname || hostname === "localhost") return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix));
}

function isPublicAddress(value) {
  const address = String(value || "").replace(/^\[|\]$/g, "");
  const family = net.isIP(address);
  if (!family) return false;
  // Node compares IPv4 inputs as IPv4-mapped IPv6 internally. Keeping the
  // mapped range in a shared BlockList would therefore reject every IPv4
  // address, so reject mapped literals explicitly instead.
  if (family === 6 && /^::ffff:/i.test(address)) return false;
  return !addressBlockList.check(address, family === 4 ? "ipv4" : "ipv6");
}

function requestPinned(target, config) {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    const headers = {
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
      "accept-encoding": "gzip, deflate, br",
      host: target.url.host,
      "user-agent": config.userAgent,
    };
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      operation(value);
    };
    const request = transport.request({
      protocol: target.url.protocol,
      hostname: target.address,
      family: target.family,
      port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
      method: "GET",
      path: `${target.url.pathname}${target.url.search}`,
      headers,
      servername: target.hostname,
      timeout: config.timeoutMs,
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      const location = firstHeader(response.headers.location);
      if (isRedirectStatus(statusCode)) {
        response.resume();
        return finish(resolve, { statusCode, location, body: Buffer.alloc(0), contentType: "", contentEncoding: "" });
      }
      const declaredLength = Number(firstHeader(response.headers["content-length"]) || 0);
      if (declaredLength > config.maxBytes) {
        response.destroy();
        return finish(reject, new Error(`Page exceeds the ${config.maxBytes}-byte safety limit.`));
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > config.maxBytes) {
          response.destroy(new Error(`Page exceeds the ${config.maxBytes}-byte safety limit.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(resolve, {
        statusCode,
        location,
        body: Buffer.concat(chunks),
        contentType: firstHeader(response.headers["content-type"]),
        contentEncoding: firstHeader(response.headers["content-encoding"]),
      }));
      response.on("error", (error) => finish(reject, error));
    });
    const absoluteTimer = setTimeout(() => request.destroy(new Error(`Page timed out after ${config.timeoutMs} ms.`)), config.timeoutMs);
    request.once("timeout", () => request.destroy(new Error(`Page timed out after ${config.timeoutMs} ms.`)));
    request.once("error", (error) => finish(reject, error));
    request.end();
  });
}

function decodeBody(buffer, contentEncodingValue, contentTypeValue, maxBytes) {
  const encoding = String(contentEncodingValue || "").toLowerCase().trim();
  let body;
  try {
    if (encoding === "gzip" || encoding === "x-gzip") body = zlib.gunzipSync(buffer, { maxOutputLength: maxBytes });
    else if (encoding === "deflate") body = zlib.inflateSync(buffer, { maxOutputLength: maxBytes });
    else if (encoding === "br") body = zlib.brotliDecompressSync(buffer, { maxOutputLength: maxBytes });
    else if (!encoding || encoding === "identity") body = buffer;
    else throw new Error(`Page uses unsupported content encoding ${encoding}.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Page uses unsupported")) throw error;
    throw new Error("Page body could not be safely decompressed.");
  }
  if (body.length > maxBytes) throw new Error(`Page exceeds the ${maxBytes}-byte decompressed safety limit.`);
  const charsetMatch = String(contentTypeValue || "").match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  const charset = normalizeCharset(charsetMatch?.[1] || sniffHtmlCharset(body) || "utf-8");
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

function extractReadableDocument(htmlValue, urlValue, maxChars = 8000) {
  const html = String(htmlValue || "");
  const title = cleanText(decodeHtmlEntities(firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i)), 300);
  const description = cleanText(decodeHtmlEntities(
    metaContent(html, "description") || metaProperty(html, "og:description"),
  ), 600);
  const publishedAt = cleanText(
    metaProperty(html, "article:published_time")
      || metaContent(html, "date")
      || firstMatch(html, /<time\b[^>]*datetime\s*=\s*["']([^"']+)["'][^>]*>/i),
    100,
  ) || null;

  const cleaned = html
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|template|form|button|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const articleCandidates = [
    ...matchAllContent(cleaned, /<article\b[^>]*>([\s\S]*?)<\/article>/gi),
    ...matchAllContent(cleaned, /<main\b[^>]*>([\s\S]*?)<\/main>/gi),
  ];
  const selected = articleCandidates.sort((left, right) => textDensity(right) - textDensity(left))[0]
    || firstMatch(cleaned, /<body\b[^>]*>([\s\S]*?)<\/body>/i)
    || cleaned;
  const text = htmlFragmentToText(selected);
  const bounded = clipText(text, maxChars);
  return {
    title: title || urlValue.hostname,
    description,
    publishedAt,
    content: bounded,
    charCount: bounded.length,
    truncated: text.length > bounded.length,
  };
}

function extractPlainText(textValue, urlValue, maxChars) {
  const text = String(textValue || "").replace(/\r\n?/g, "\n").replace(/[\t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const bounded = clipText(text, maxChars);
  return {
    title: urlValue.hostname,
    description: "",
    publishedAt: null,
    content: bounded,
    charCount: bounded.length,
    truncated: text.length > bounded.length,
  };
}

function htmlFragmentToText(value) {
  return decodeHtmlEntities(String(value || "")
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|blockquote|pre|table)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return safeCodePoint(Number.parseInt(lower.slice(2), 16), match);
    if (lower.startsWith("#")) return safeCodePoint(Number.parseInt(lower.slice(1), 10), match);
    return named[lower] ?? match;
  });
}

function safeCodePoint(value, fallback) {
  try {
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : fallback;
  } catch {
    return fallback;
  }
}

function metaContent(html, name) {
  return metaValue(html, "name", name);
}

function metaProperty(html, name) {
  return metaValue(html, "property", name);
}

function metaValue(html, key, expected) {
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const keyValue = attributeValue(tag, key);
    if (keyValue.toLowerCase() !== expected.toLowerCase()) continue;
    return attributeValue(tag, "content");
  }
  return "";
}

function attributeValue(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, "i");
  const match = String(tag || "").match(pattern);
  return match ? (match[1] ?? match[2] ?? "") : "";
}

function sniffHtmlCharset(buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("ascii");
  return head.match(/<meta\b[^>]*charset\s*=\s*["']?([^\s"'/>;]+)/i)?.[1] || "";
}

function normalizeCharset(value) {
  const charset = String(value || "utf-8").toLowerCase().trim();
  if (["utf8", "utf-8"].includes(charset)) return "utf-8";
  if (["gbk", "gb2312", "gb18030"].includes(charset)) return "gb18030";
  if (["latin1", "iso-8859-1", "windows-1252"].includes(charset)) return "windows-1252";
  return charset;
}

function normalizeContentType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function isReadableContentType(value) {
  return ["text/html", "text/plain", "application/xhtml+xml"].includes(value);
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function matchAllContent(value, pattern) {
  return Array.from(String(value || "").matchAll(pattern), (match) => match[1] || "");
}

function firstMatch(value, pattern) {
  return String(value || "").match(pattern)?.[1] || "";
}

function textDensity(value) {
  return htmlFragmentToText(value).length;
}

function firstHeader(value) {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function cleanText(value, max) {
  return clipText(String(value || "").replace(/\s+/g, " ").trim(), max);
}

function clipText(value, max) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function numberInRange(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const integer = Math.trunc(parsed);
  return integer >= min && integer <= max ? integer : fallback;
}

module.exports = {
  decodeBody,
  extractReadableDocument,
  isBlockedHostname,
  isPublicAddress,
  normalizePublicUrl,
  readPublicPage,
  resolvePublicTarget,
};
