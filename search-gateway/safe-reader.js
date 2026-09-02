const dns = require("node:dns").promises;
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const zlib = require("node:zlib");
const { Readability } = require("@mozilla/readability");
const { JSDOM, VirtualConsole } = require("jsdom");

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

const HTML_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const JSON_CONTENT_TYPES = new Set(["application/json", "application/ld+json", "application/problem+json"]);
const XML_CONTENT_TYPES = new Set(["application/xml", "text/xml", "application/rss+xml", "application/atom+xml"]);
const TEXT_CONTENT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "text/tab-separated-values"]);

const addressBlockList = new net.BlockList();
for (const [address, prefix] of BLOCKED_IPV4) addressBlockList.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of BLOCKED_IPV6) addressBlockList.addSubnet(address, prefix, "ipv6");

let pdfLibraryPromise = null;
const quietVirtualConsole = new VirtualConsole();

async function readPublicPage(urlValue, options = {}, deps = {}) {
  const config = {
    timeoutMs: numberInRange(options.timeoutMs, 1000, 60000, 12000),
    maxBytes: numberInRange(options.maxBytes, 64 * 1024, 15 * 1024 * 1024, 6 * 1024 * 1024),
    maxRedirects: numberInRange(options.maxRedirects, 0, 5, 3),
    maxChars: numberInRange(options.maxChars, 500, 120000, 8000),
    maxPdfPages: numberInRange(options.maxPdfPages, 1, 200, 80),
    userAgent: String(options.userAgent || "local-ai-search-gateway/0.4 (+safe-public-page-reader)"),
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

    const body = decodeBodyBuffer(response.body, response.contentEncoding, config.maxBytes);
    const contentType = detectContentType(response.contentType, body, current);
    if (!isReadableContentType(contentType)) {
      throw new Error(`Page content type ${contentType || "unknown"} is not supported; HTML, text, JSON, XML/RSS, and PDF results can be read.`);
    }

    let document;
    if (contentType === "application/pdf") {
      document = await extractPdfDocument(body, current, config.maxChars, config.maxPdfPages, deps.pdfjs);
    } else {
      const decoded = decodeTextBuffer(body, response.contentType);
      if (HTML_CONTENT_TYPES.has(contentType)) document = extractReadableDocument(decoded, current, config.maxChars);
      else if (JSON_CONTENT_TYPES.has(contentType)) document = extractJsonDocument(decoded, current, config.maxChars);
      else if (XML_CONTENT_TYPES.has(contentType)) document = extractXmlDocument(decoded, current, config.maxChars);
      else document = extractPlainText(decoded, current, config.maxChars, contentType);
    }

    return {
      requestedUrl: String(urlValue),
      finalUrl: current.toString(),
      domain: current.hostname.toLowerCase(),
      redirectChain,
      contentType,
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
    throw new Error("Web page URL is invalid.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS web pages can be read.");
  if (parsed.username || parsed.password) throw new Error("URLs containing credentials cannot be read.");
  const expectedPort = parsed.protocol === "https:" ? "443" : "80";
  if (parsed.port && parsed.port !== expectedPort) throw new Error("Web-page reading is limited to standard HTTP and HTTPS ports.");
  parsed.hash = "";
  return parsed;
}

async function resolvePublicTarget(urlValue, lookup = dns.lookup.bind(dns)) {
  const url = normalizePublicUrl(urlValue);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedHostname(hostname)) throw new Error("Web page resolves to a local or reserved hostname and cannot be read.");

  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("Web page hostname could not be resolved.");
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error("Web page hostname resolved to no addresses.");
  const normalized = addresses.map((entry) => ({
    address: String(entry.address || ""),
    family: Number(entry.family) || net.isIP(String(entry.address || "")),
  }));
  if (normalized.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("Web page hostname resolves to a local or reserved network address and cannot be read.");
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
  if (family === 6 && /^::ffff:/i.test(address)) return false;
  return !addressBlockList.check(address, family === 4 ? "ipv4" : "ipv6");
}

function requestPinned(target, config) {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    const headers = {
      accept: "text/html,application/xhtml+xml,application/pdf,application/json,application/xml,text/plain,text/markdown;q=0.9,*/*;q=0.1",
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

function decodeBodyBuffer(buffer, contentEncodingValue, maxBytes) {
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
  return body;
}

function decodeTextBuffer(buffer, contentTypeValue) {
  const charsetMatch = String(contentTypeValue || "").match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  const charset = normalizeCharset(charsetMatch?.[1] || sniffHtmlCharset(buffer) || "utf-8");
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

function decodeBody(buffer, contentEncodingValue, contentTypeValue, maxBytes) {
  return decodeTextBuffer(decodeBodyBuffer(buffer, contentEncodingValue, maxBytes), contentTypeValue);
}

function extractReadableDocument(htmlValue, urlValue, maxChars = 8000) {
  const html = String(htmlValue || "");
  let dom;
  try {
    dom = new JSDOM(html, { url: urlValue.toString(), contentType: "text/html", virtualConsole: quietVirtualConsole });
  } catch {
    return extractPlainText(html.replace(/<[^>]+>/g, " "), urlValue, maxChars, "text/html");
  }
  const document = dom.window.document;
  const jsonLd = extractJsonLdMetadata(document);
  let article = null;
  try {
    article = new Readability(document.cloneNode(true), { charThreshold: 120, keepClasses: false }).parse();
  } catch {
    article = null;
  }

  let contentRoot;
  let extractionMethod;
  if (article?.content && cleanText(article.textContent, 200).length >= 80) {
    const articleDom = new JSDOM(`<body>${article.content}</body>`, { url: urlValue.toString(), virtualConsole: quietVirtualConsole });
    contentRoot = articleDom.window.document.body;
    extractionMethod = "mozilla-readability";
  } else {
    const fallbackDocument = document.cloneNode(true);
    fallbackDocument.querySelectorAll("script,style,noscript,svg,canvas,template,form,button,nav,footer,header,aside,[role='navigation'],[role='banner'],[role='contentinfo']")
      .forEach((element) => element.remove());
    contentRoot = fallbackDocument.querySelector("article,main,[role='main']") || fallbackDocument.body || fallbackDocument.documentElement;
    extractionMethod = "dom-main-content";
  }

  const fullText = domToStructuredText(contentRoot);
  const bounded = clipText(fullText, maxChars);
  const canonicalUrl = resolveDocumentUrl(
    firstNonEmpty(
      document.querySelector("link[rel~='canonical']")?.getAttribute("href"),
      jsonLd.canonicalUrl,
    ),
    urlValue,
  );
  const title = cleanText(firstNonEmpty(
    article?.title,
    jsonLd.title,
    metaValue(document, ["property:og:title", "name:twitter:title"]),
    document.title,
  ), 300) || urlValue.hostname;
  const description = cleanText(firstNonEmpty(
    article?.excerpt,
    jsonLd.description,
    metaValue(document, ["name:description", "property:og:description", "name:twitter:description"]),
  ), 800);
  const author = cleanText(firstNonEmpty(
    article?.byline,
    jsonLd.author,
    metaValue(document, ["name:author", "property:article:author"]),
  ), 300) || null;
  const publishedAt = cleanText(firstNonEmpty(
    jsonLd.publishedAt,
    metaValue(document, ["property:article:published_time", "name:date", "name:publication_date", "itemprop:datePublished"]),
    document.querySelector("time[datetime]")?.getAttribute("datetime"),
  ), 100) || null;
  const modifiedAt = cleanText(firstNonEmpty(
    jsonLd.modifiedAt,
    metaValue(document, ["property:article:modified_time", "name:last-modified", "itemprop:dateModified"]),
  ), 100) || null;
  const siteName = cleanText(firstNonEmpty(
    article?.siteName,
    jsonLd.siteName,
    metaValue(document, ["property:og:site_name", "name:application-name"]),
  ), 200) || null;
  const language = cleanText(firstNonEmpty(
    jsonLd.language,
    document.documentElement.getAttribute("lang"),
    metaValue(document, ["property:og:locale", "http-equiv:content-language"]),
  ), 40) || null;
  const headings = extractHeadings(contentRoot);
  const documentType = article ? "html_article" : "html_page";

  return {
    title,
    description,
    author,
    siteName,
    publishedAt,
    modifiedAt,
    canonicalUrl,
    language,
    documentType,
    extractionMethod,
    metadataConfidence: metadataConfidence({ title, description, author, publishedAt, canonicalUrl, jsonLdTypes: jsonLd.types }),
    headings,
    jsonLdTypes: jsonLd.types,
    content: bounded,
    charCount: bounded.length,
    sourceCharCount: fullText.length,
    wordCount: countWords(fullText, language),
    pageCount: null,
    pagesRead: null,
    truncated: fullText.length > bounded.length,
  };
}

function extractPlainText(textValue, urlValue, maxChars, contentType = "text/plain") {
  const fullText = normalizeText(textValue);
  const bounded = clipText(fullText, maxChars);
  const firstHeading = contentType === "text/markdown" ? fullText.match(/^#{1,6}\s+(.+)$/m)?.[1] : "";
  return baseDocument({
    title: cleanText(firstHeading, 300) || filenameTitle(urlValue) || urlValue.hostname,
    documentType: contentType === "text/markdown" ? "markdown" : contentType === "text/csv" ? "csv" : "plain_text",
    extractionMethod: "bounded-text",
    fullText,
    bounded,
    language: null,
  });
}

function extractJsonDocument(textValue, urlValue, maxChars) {
  let value;
  try {
    value = JSON.parse(String(textValue || ""));
  } catch {
    return extractPlainText(textValue, urlValue, maxChars, "application/json");
  }
  const root = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const fullText = normalizeText(JSON.stringify(value, null, 2));
  const bounded = clipText(fullText, maxChars);
  const title = cleanText(firstNonEmpty(root.title, root.name, root.headline), 300) || filenameTitle(urlValue) || urlValue.hostname;
  const description = cleanText(firstNonEmpty(root.description, root.abstract, root.summary), 800);
  return {
    ...baseDocument({ title, documentType: "json", extractionMethod: "json-structure", fullText, bounded, language: root.inLanguage || null }),
    description,
    author: cleanText(personNames(root.author), 300) || null,
    publishedAt: cleanText(firstNonEmpty(root.datePublished, root.published_at, root.date), 100) || null,
    modifiedAt: cleanText(firstNonEmpty(root.dateModified, root.updated_at), 100) || null,
    metadataConfidence: description || root.datePublished ? "medium" : "low",
    jsonLdTypes: normalizeTypeList(root["@type"]),
  };
}

function extractXmlDocument(textValue, urlValue, maxChars) {
  let document;
  try {
    document = new JSDOM(String(textValue || ""), { contentType: "text/xml", url: urlValue.toString(), virtualConsole: quietVirtualConsole }).window.document;
  } catch {
    return extractPlainText(textValue, urlValue, maxChars, "application/xml");
  }
  if (document.querySelector("parsererror")) return extractPlainText(textValue, urlValue, maxChars, "application/xml");
  const interesting = new Set(["title", "description", "summary", "content", "encoded", "pubdate", "published", "updated", "author", "creator"]);
  const lines = Array.from(document.querySelectorAll("*"))
    .filter((element) => interesting.has(String(element.localName || element.tagName).toLowerCase()))
    .map((element) => cleanText(element.textContent, 4000))
    .filter(Boolean);
  const fullText = normalizeText(lines.length ? lines.join("\n\n") : document.documentElement.textContent);
  const bounded = clipText(fullText, maxChars);
  const title = cleanText(document.querySelector("channel > title, feed > title, title")?.textContent, 300) || filenameTitle(urlValue) || urlValue.hostname;
  return {
    ...baseDocument({ title, documentType: "xml_feed", extractionMethod: "xml-structure", fullText, bounded, language: document.documentElement.getAttribute("lang") }),
    description: cleanText(document.querySelector("channel > description, feed > subtitle, description")?.textContent, 800),
    publishedAt: cleanText(document.querySelector("pubDate, published, updated")?.textContent, 100) || null,
    metadataConfidence: lines.length ? "medium" : "low",
  };
}

async function extractPdfDocument(buffer, urlValue, maxChars, maxPdfPages, injectedPdfjs = null) {
  const pdfjs = injectedPdfjs || await loadPdfLibrary();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch {
    throw new Error("PDF could not be parsed safely.");
  }

  let metadata = {};
  try {
    const result = await pdf.getMetadata();
    metadata = result?.info && typeof result.info === "object" ? result.info : {};
  } catch {
    metadata = {};
  }

  const pageCount = Math.max(0, Number(pdf.numPages) || 0);
  const pageLimit = Math.min(pageCount, maxPdfPages);
  const chunks = [];
  let pagesRead = 0;
  let extractedChars = 0;
  try {
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent({ disableNormalization: false });
      const pageText = pdfItemsToText(textContent.items);
      page.cleanup();
      if (pageText) {
        const block = `--- Page ${pageNumber} ---\n${pageText}`;
        chunks.push(block);
        extractedChars += block.length + 2;
      }
      pagesRead = pageNumber;
      if (extractedChars >= maxChars) break;
    }
  } finally {
    if (typeof pdf.destroy === "function") await pdf.destroy();
    else if (typeof loadingTask.destroy === "function") await loadingTask.destroy();
  }

  const fullText = normalizeText(chunks.join("\n\n"));
  if (!fullText) throw new Error("PDF has no extractable text layer; it may be scanned or image-only, and OCR is not enabled in this bounded reader.");
  const bounded = clipText(fullText, maxChars);
  const title = cleanText(firstNonEmpty(metadata.Title, filenameTitle(urlValue)), 300) || urlValue.hostname;
  const author = cleanText(metadata.Author, 300) || null;
  const publishedAt = normalizePdfDate(metadata.CreationDate);
  const modifiedAt = normalizePdfDate(metadata.ModDate);
  return {
    title,
    description: cleanText(metadata.Subject, 800),
    author,
    siteName: null,
    publishedAt,
    modifiedAt,
    canonicalUrl: null,
    language: cleanText(metadata.Language, 40) || null,
    documentType: "pdf",
    extractionMethod: "pdfjs-text",
    metadataConfidence: author || publishedAt || metadata.Subject ? "medium" : "low",
    headings: [],
    jsonLdTypes: [],
    content: bounded,
    charCount: bounded.length,
    sourceCharCount: fullText.length,
    wordCount: countWords(fullText),
    pageCount,
    pagesRead,
    truncated: pagesRead < pageCount || fullText.length > bounded.length,
  };
}

function findTextMatches(documentValue, patternValue, options = {}) {
  const content = String(documentValue?.content ?? documentValue ?? "");
  const pattern = cleanText(patternValue, 200);
  const mode = options.mode === "all_terms" ? "all_terms" : "phrase";
  const caseSensitive = Boolean(options.caseSensitive);
  const maxMatches = numberInRange(options.maxMatches, 1, 10, 5);
  const contextChars = numberInRange(options.contextChars, 80, 800, 320);
  if (pattern.length < 2) throw new Error("Find pattern must contain at least two characters.");
  if (!content) return [];

  const haystack = caseSensitive ? content : content.toLocaleLowerCase();
  const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase();
  const ranges = [];
  if (mode === "phrase") {
    let offset = 0;
    while (ranges.length < maxMatches) {
      const index = haystack.indexOf(needle, offset);
      if (index < 0) break;
      ranges.push([index, index + needle.length]);
      offset = index + Math.max(1, needle.length);
    }
  } else {
    const terms = Array.from(new Set(needle.match(/[\p{L}\p{N}]+/gu) || [])).slice(0, 12);
    if (!terms.length) return [];
    const paragraphs = paragraphRanges(content);
    for (const paragraph of paragraphs) {
      const comparable = caseSensitive ? paragraph.text : paragraph.text.toLocaleLowerCase();
      if (!terms.every((term) => comparable.includes(term))) continue;
      const localStart = Math.min(...terms.map((term) => comparable.indexOf(term)).filter((value) => value >= 0));
      ranges.push([paragraph.start + localStart, paragraph.end]);
      if (ranges.length >= maxMatches) break;
    }
  }

  return ranges.map(([start, end], index) => {
    const contextStart = Math.max(0, start - contextChars);
    const contextEnd = Math.min(content.length, end + contextChars);
    return {
      matchIndex: index + 1,
      startChar: start,
      endChar: end,
      pageNumber: pageNumberAt(content, start),
      context: cleanContext(content.slice(contextStart, contextEnd)),
    };
  });
}

function baseDocument({ title, documentType, extractionMethod, fullText, bounded, language }) {
  return {
    title,
    description: "",
    author: null,
    siteName: null,
    publishedAt: null,
    modifiedAt: null,
    canonicalUrl: null,
    language: cleanText(language, 40) || null,
    documentType,
    extractionMethod,
    metadataConfidence: "low",
    headings: [],
    jsonLdTypes: [],
    content: bounded,
    charCount: bounded.length,
    sourceCharCount: fullText.length,
    wordCount: countWords(fullText, language),
    pageCount: null,
    pagesRead: null,
    truncated: fullText.length > bounded.length,
  };
}

function extractJsonLdMetadata(document) {
  const nodes = [];
  let totalChars = 0;
  for (const script of Array.from(document.querySelectorAll("script[type='application/ld+json']")).slice(0, 30)) {
    const text = String(script.textContent || "").trim().replace(/^<!--|-->$/g, "");
    if (!text || text.length > 512000 || totalChars + text.length > 1024 * 1024) continue;
    totalChars += text.length;
    try {
      flattenJsonLd(JSON.parse(text), nodes);
    } catch {
      // Malformed publisher metadata must not prevent reading the page.
    }
  }
  const types = Array.from(new Set(nodes.flatMap((node) => normalizeTypeList(node?.["@type"])))).slice(0, 20);
  const articleNode = nodes.find((node) => normalizeTypeList(node?.["@type"]).some((type) => /(?:Article|Report|Posting|ScholarlyArticle|NewsArticle)$/i.test(type)))
    || nodes.find((node) => node?.headline || node?.datePublished)
    || {};
  const publisher = articleNode.publisher && typeof articleNode.publisher === "object" ? articleNode.publisher : {};
  return {
    title: firstNonEmpty(articleNode.headline, articleNode.name),
    description: firstNonEmpty(articleNode.description, articleNode.abstract),
    author: personNames(articleNode.author),
    publishedAt: firstNonEmpty(articleNode.datePublished, articleNode.uploadDate),
    modifiedAt: articleNode.dateModified,
    canonicalUrl: firstNonEmpty(
      typeof articleNode.mainEntityOfPage === "string" ? articleNode.mainEntityOfPage : articleNode.mainEntityOfPage?.["@id"],
      articleNode.url,
    ),
    language: articleNode.inLanguage,
    siteName: firstNonEmpty(publisher.name, nodes.find((node) => normalizeTypeList(node?.["@type"]).includes("WebSite"))?.name),
    types,
  };
}

function flattenJsonLd(value, output) {
  if (Array.isArray(value)) {
    value.slice(0, 100).forEach((item) => flattenJsonLd(item, output));
    return;
  }
  if (!value || typeof value !== "object" || output.length >= 200) return;
  output.push(value);
  if (Array.isArray(value["@graph"])) flattenJsonLd(value["@graph"], output);
}

function normalizeTypeList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => cleanText(item, 100)).filter(Boolean).slice(0, 20);
}

function personNames(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    return firstNonEmpty(item.name, [item.givenName, item.familyName].filter(Boolean).join(" "));
  }).filter(Boolean).slice(0, 10).join(", ");
}

function metaValue(document, selectors) {
  for (const selector of selectors) {
    const separator = selector.indexOf(":");
    const attribute = separator >= 0 ? selector.slice(0, separator) : selector;
    const expected = separator >= 0 ? selector.slice(separator + 1) : "";
    const nodes = Array.from(document.querySelectorAll("meta"));
    const match = nodes.find((node) => String(node.getAttribute(attribute) || "").toLowerCase() === expected.toLowerCase());
    if (match?.getAttribute("content")) return match.getAttribute("content");
  }
  return "";
}

function resolveDocumentUrl(value, baseUrl) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value), baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    parsed.hash = "";
    return parsed.toString().slice(0, 2000);
  } catch {
    return null;
  }
}

function domToStructuredText(root) {
  if (!root) return "";
  const lines = [];
  const selectors = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dt,dd,figcaption,caption,tr";
  for (const element of Array.from(root.querySelectorAll(selectors)).slice(0, 10000)) {
    const tag = element.tagName.toLowerCase();
    if (tag !== "li" && element.closest("li") && element.closest("li") !== element) continue;
    if (tag !== "blockquote" && element.closest("blockquote") && element.closest("blockquote") !== element) continue;
    const text = tag === "tr"
      ? Array.from(element.querySelectorAll(":scope > th,:scope > td")).map((cell) => cleanText(cell.textContent, 2000)).filter(Boolean).join(" | ")
      : cleanText(element.textContent, 12000);
    if (!text) continue;
    const level = /^h([1-6])$/.exec(tag)?.[1];
    const prefix = level ? `${"#".repeat(Number(level))} ` : tag === "li" ? "- " : tag === "blockquote" ? "> " : tag === "tr" ? "| " : "";
    const line = `${prefix}${text}`;
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  const structured = normalizeText(lines.join("\n\n"));
  if (structured.length >= 80) return structured;
  return normalizeText(root.textContent);
}

function extractHeadings(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"))
    .map((element) => ({ level: Number(element.tagName.slice(1)), text: cleanText(element.textContent, 240) }))
    .filter((item) => item.text)
    .slice(0, 40);
}

function metadataConfidence(value) {
  const signals = [value.description, value.author, value.publishedAt, value.canonicalUrl].filter(Boolean).length;
  if (value.jsonLdTypes?.length && signals >= 2) return "high";
  if (signals >= 1) return "medium";
  return "low";
}

function pdfItemsToText(itemsValue) {
  const lines = [];
  let current = "";
  for (const item of Array.isArray(itemsValue) ? itemsValue : []) {
    const text = typeof item?.str === "string" ? item.str : "";
    if (text) current += `${current && !/\s$/.test(current) ? " " : ""}${text}`;
    if (item?.hasEOL) {
      if (current.trim()) lines.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) lines.push(current.trim());
  return normalizeText(lines.join("\n"));
}

function normalizePdfDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^D:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!match) return cleanText(text, 100) || null;
  const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00"] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

async function loadPdfLibrary() {
  if (!pdfLibraryPromise) pdfLibraryPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfLibraryPromise;
}

function detectContentType(headerValue, body, urlValue) {
  const header = normalizeContentType(headerValue);
  if (header && header !== "application/octet-stream") return header;
  if (body.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  const head = body.subarray(0, Math.min(body.length, 1024)).toString("utf8").trimStart().toLowerCase();
  if (/^<!doctype\s+html|^<html\b/.test(head)) return "text/html";
  if (/^[\[{]/.test(head)) return "application/json";
  if (/^<\?xml\b|^<(rss|feed)\b/.test(head)) return "application/xml";
  if (String(urlValue.pathname || "").toLowerCase().endsWith(".pdf")) return "application/pdf";
  return header || "text/html";
}

function isReadableContentType(value) {
  return value === "application/pdf"
    || HTML_CONTENT_TYPES.has(value)
    || JSON_CONTENT_TYPES.has(value)
    || XML_CONTENT_TYPES.has(value)
    || TEXT_CONTENT_TYPES.has(value);
}

function normalizeContentType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
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

function paragraphRanges(content) {
  const output = [];
  const pattern = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;
  for (const match of content.matchAll(pattern)) {
    const text = String(match[0] || "").trim();
    if (!text) continue;
    output.push({ text, start: match.index, end: match.index + match[0].length });
  }
  return output;
}

function pageNumberAt(content, offset) {
  const before = content.slice(0, Math.max(0, offset));
  const matches = Array.from(before.matchAll(/--- Page (\d+) ---/g));
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

function cleanContext(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/ *\n */g, " \n ").replace(/\s+/g, " ").trim();
}

function filenameTitle(urlValue) {
  try {
    const filename = decodeURIComponent(path.posix.basename(urlValue.pathname || ""));
    return cleanText(filename.replace(/\.(?:pdf|txt|md|json|xml|rss|csv)$/i, "").replace(/[-_]+/g, " "), 300);
  } catch {
    return "";
  }
}

function countWords(value, language = undefined) {
  const text = String(value || "");
  if (!text) return 0;
  try {
    return Array.from(new Intl.Segmenter(language || undefined, { granularity: "word" }).segment(text)).filter((segment) => segment.isWordLike).length;
  } catch {
    return (text.match(/[\p{L}\p{N}]+/gu) || []).length;
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/[\t ]+\n/g, "\n").replace(/\n[\t ]+/g, "\n").replace(/[\t ]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const first = value.find((item) => String(item || "").trim());
      if (first) return first;
      continue;
    }
    if (value != null && String(value).trim()) return value;
  }
  return "";
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
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
  decodeBodyBuffer,
  detectContentType,
  extractJsonDocument,
  extractPdfDocument,
  extractPlainText,
  extractReadableDocument,
  extractXmlDocument,
  findTextMatches,
  isBlockedHostname,
  isPublicAddress,
  normalizePublicUrl,
  readPublicPage,
  resolvePublicTarget,
};
