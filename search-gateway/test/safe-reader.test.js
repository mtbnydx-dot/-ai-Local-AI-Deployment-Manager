const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  decodeBody,
  extractReadableDocument,
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
    <meta property="article:published_time" content="2026-08-24"></head>
    <body><header>menu</header><nav>links</nav><main><h1>Report</h1><p>First &lt;fact&gt;.</p><script>ignore()</script><p>Second fact.</p></main><footer>copyright</footer></body></html>
  `, new URL("https://example.com/report"), 1000);
  assert.equal(result.title, "Report & Data");
  assert.equal(result.description, "Official summary");
  assert.equal(result.publishedAt, "2026-08-24");
  assert.match(result.content, /First <fact>/);
  assert.match(result.content, /Second fact/);
  assert.doesNotMatch(result.content, /menu|links|ignore|copyright/);
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
