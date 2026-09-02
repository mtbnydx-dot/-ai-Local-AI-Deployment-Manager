const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  decodeBody,
  extractReadableDocument,
  extractJsonDocument,
  extractXmlDocument,
  findTextMatches,
  isPublicAddress,
  normalizePublicUrl,
  readPublicPage,
  resolvePublicTarget,
} = require("../safe-reader");

test("public-address guard rejects loopback, private, shared, link-local, documentation, and mapped ranges", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "172.16.1.1", "192.168.1.1", "198.51.100.1", "::1", "fc00::1", "fe80::1", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
});

test("reader URL policy rejects credentials, local names, unsafe schemes, and nonstandard ports", async () => {
  assert.throws(() => normalizePublicUrl("file:///etc/passwd"), /HTTP/);
  assert.throws(() => normalizePublicUrl("https://user:pass@example.com"), /credentials/);
  assert.throws(() => normalizePublicUrl("https://example.com:8443"), /standard/);
  await assert.rejects(resolvePublicTarget("http://manager.internal/status"), /local or reserved hostname/);
});

test("DNS policy rejects a hostname if any returned address is private", async () => {
  await assert.rejects(
    resolvePublicTarget("https://example.com", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    /local or reserved network address/,
  );
});

test("HTML extraction removes active/page-chrome elements and retains article metadata", () => {
  const result = extractReadableDocument(`
    <html><head><title>Report &amp; Data</title>
    <meta name="description" content="Official summary">
    <meta property="article:published_time" content="2026-08-24">
    <link rel="canonical" href="/canonical-report">
    <script type="application/ld+json">{"@type":"NewsArticle","headline":"Report & Data","author":{"name":"Ada Analyst"},"dateModified":"2026-08-25"}</script></head>
    <body><header>menu</header><nav>links</nav><main><h1>Report</h1><p>First &lt;fact&gt;.</p><script>ignore()</script><p>Second fact.</p></main><footer>copyright</footer></body></html>
  `, new URL("https://example.com/report"), 1000);
  assert.equal(result.title, "Report & Data");
  assert.equal(result.description, "Official summary");
  assert.equal(result.publishedAt, "2026-08-24");
  assert.equal(result.modifiedAt, "2026-08-25");
  assert.equal(result.author, "Ada Analyst");
  assert.equal(result.canonicalUrl, "https://example.com/canonical-report");
  assert.deepEqual(result.jsonLdTypes, ["NewsArticle"]);
  assert.deepEqual(result.headings, [{ level: 1, text: "Report" }]);
  assert.match(result.content, /First <fact>/);
  assert.match(result.content, /Second fact/);
  assert.doesNotMatch(result.content, /menu|links|ignore|copyright/);
});

test("JSON and XML/RSS extraction retain structure and bounded metadata", () => {
  const json = extractJsonDocument(JSON.stringify({
    "@type": "Dataset", title: "Population dataset", description: "Official series", author: { name: "Statistics Office" }, rows: [1, 2, 3],
  }), new URL("https://data.example/report.json"), 1000);
  assert.equal(json.documentType, "json");
  assert.equal(json.title, "Population dataset");
  assert.equal(json.author, "Statistics Office");
  assert.match(json.content, /"rows"/);

  const xml = extractXmlDocument("<?xml version='1.0'?><rss><channel><title>Research feed</title><description>Updates</description><item><title>Paper one</title><pubDate>2026-08-20</pubDate><description>Finding text</description></item></channel></rss>", new URL("https://example.com/feed.xml"), 1000);
  assert.equal(xml.documentType, "xml_feed");
  assert.equal(xml.title, "Research feed");
  assert.match(xml.content, /Paper one/);
  assert.equal(xml.publishedAt, "2026-08-20");
});

test("PDF extraction preserves page markers and page-aware find matches", async () => {
  const pdfjs = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 2,
        getMetadata: async () => ({ info: { Title: "Policy report", Author: "Public Agency", CreationDate: "D:20260824090000" } }),
        getPage: async (pageNumber) => ({
          getTextContent: async () => ({ items: [{ str: pageNumber === 1 ? "Overview" : "Target evidence on page two", hasEOL: true }] }),
          cleanup() {},
        }),
        async destroy() {},
      }),
    }),
  };
  const page = await readPublicPage("https://example.com/report.pdf", { maxChars: 2000 }, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    pdfjs,
    request: async () => ({
      statusCode: 200,
      location: "",
      body: Buffer.from("%PDF-mocked"),
      contentType: "application/pdf",
      contentEncoding: "",
    }),
  });
  assert.equal(page.documentType, "pdf");
  assert.equal(page.pageCount, 2);
  assert.equal(page.pagesRead, 2);
  assert.equal(page.author, "Public Agency");
  const matches = findTextMatches(page, "target evidence", { maxMatches: 3 });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].pageNumber, 2);
});

test("all-terms page find returns only paragraphs containing every requested term", () => {
  const matches = findTextMatches("First paragraph has growth only.\n\nSecond paragraph has growth and employment evidence.", "growth employment", { mode: "all_terms" });
  assert.equal(matches.length, 1);
  assert.match(matches[0].context, /Second paragraph/);
});

test("compressed bodies are decoded within the decompressed limit", () => {
  const compressed = zlib.gzipSync(Buffer.from("hello web"));
  assert.equal(decodeBody(compressed, "gzip", "text/plain; charset=utf-8", 1024), "hello web");
  assert.throws(() => decodeBody(zlib.gzipSync(Buffer.from("x".repeat(5000))), "gzip", "text/plain", 1000), /decompressed/);
});

test("redirect destinations are resolved and revalidated before a second request", async () => {
  const requested = [];
  const lookup = async (hostname) => hostname === "public.example"
    ? [{ address: "93.184.216.34", family: 4 }]
    : [{ address: "127.0.0.1", family: 4 }];
  const request = async (target) => {
    requested.push(target.hostname);
    return {
      statusCode: 302,
      location: "http://private.example/secret",
      body: Buffer.alloc(0),
      contentType: "",
      contentEncoding: "",
    };
  };
  await assert.rejects(
    readPublicPage("https://public.example/start", {}, { lookup, request }),
    /local or reserved network address/,
  );
  assert.deepEqual(requested, ["public.example"]);
});

test("safe reader returns bounded text from an injected pinned response", async () => {
  const page = await readPublicPage("https://example.com/article", { maxChars: 1000 }, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({
      statusCode: 200,
      location: "",
      body: Buffer.from("<html><head><title>Example</title></head><body><article><p>Useful source text.</p></article></body></html>"),
      contentType: "text/html; charset=utf-8",
      contentEncoding: "",
    }),
  });
  assert.equal(page.finalUrl, "https://example.com/article");
  assert.equal(page.title, "Example");
  assert.equal(page.content, "Useful source text.");
});
