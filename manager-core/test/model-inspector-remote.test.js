"use strict";

// Remote inspector (docs/overhaul/02-models.md §6, §21.2, MOD-8): mocked
// Hugging Face and ModelScope responses give the same card as the local
// inspector, the Range reader never reads past its cap, an injected readRange
// replaces the built-in one, the 45 s budget holds, and the token reaches only
// the official endpoint or a configured mirror and appears nowhere else.

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = require("..");
const models = require("../model-inspector");
const { InspectError, resetInspector } = require("../model-inspector/inspect");
const { cardIdFor } = require("../model-inspector/cache");
const { buildListing, selectGgufVariant } = require("../model-inspector/remote/collect");
const hfRemote = require("../model-inspector/remote/hf");
const modelscopeRemote = require("../model-inspector/remote/modelscope");
const rangeReader = require("../model-inspector/remote/range-reader");
const { fetchRemoteModelConfig, remoteConfigUrl } = require("../remote-model-config");
const { loadFixture, materializeFixture, stableCardProjection } = require("./helpers/fixture-materialize");
const { fakeGguf } = require("./helpers/gguf-writer");
const { CHUNK_BYTES, createRepoMock, filesFromMaterialized, virtualFile } = require("./helpers/remote-repo-mock");

const FAKE_TOKEN = "hf_FakeRemoteInspectorToken0000";
const HF = "https://huggingface.co";
const SAFETENSORS_FIXTURE = "qwen38-27b-fp8-indexed";
const MANY_SHARDS_FIXTURE = "qwen38-27b-fp8";
const GGUF_FIXTURE = "deepseek-v4-flash-q2k-gguf";
// Everything a card says about the model itself; the rest (ref, remote,
// inspectedAt, evidence sources) differs between a folder and a repository.
const SHARED_FIELDS = [
  "contentDigest", "format", "identity", "topology", "weights", "context", "quant", "modalities", "template",
  "sampling", "speculative", "customCode", "role", "support", "parsers", "origin", "errors",
];
const materialized = new Map();
let root;
let cacheCounter = 0;

test.before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "model-remote-"));
});

test.after(async () => {
  await resetInspector();
  for (const model of materialized.values()) await model.cleanup();
  await fsp.rm(root, { recursive: true, force: true });
});

test.afterEach(() => resetInspector());

// Header-only copies: the remote mock serves sizes from the manifest.
async function fixtureFiles(id) {
  if (!materialized.has(id)) materialized.set(id, await materializeFixture(id, { sizes: "header" }));
  return filesFromMaterialized(id, materialized.get(id));
}

async function freshCacheDir() {
  cacheCounter += 1;
  const dir = path.join(root, `cache-${cacheCounter}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function pick(card, fields = SHARED_FIELDS) {
  const projection = stableCardProjection(card);
  return Object.fromEntries(fields.map((field) => [field, projection[field]]));
}

function codes(list) {
  return list.map((item) => item.code);
}

function withoutWarning(card, code) {
  return card.warnings.filter((item) => item.code !== code);
}

function authorized(requests) {
  return requests.filter((request) => request.headers.authorization);
}

async function allFiles(dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await allFiles(full));
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remote card equals local card

for (const id of [SAFETENSORS_FIXTURE, GGUF_FIXTURE]) {
  test(`${id}: the remote card equals the local card on every shared field`, async () => {
    const mock = createRepoMock({ files: await fixtureFiles(id) });
    const card = await models.inspectRemote({ source: "huggingface", repo: "acme/demo-model" }, { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir() });
    const expected = loadFixture(id).expectedCard;
    assert.deepEqual(models.validateCard(card).errors, []);
    assert.deepEqual(pick(card), pick(expected));
    assert.deepEqual(card.warnings, expected.warnings);
    // The local golden's identity facts, fact by fact, regardless of source kind.
    const remoteFacts = new Set(card.evidence.map((entry) => `${entry.fact}|${entry.confidence}|${JSON.stringify(entry.value ?? null)}`));
    for (const entry of expected.evidence) {
      assert.ok(remoteFacts.has(`${entry.fact}|${entry.confidence}|${JSON.stringify(entry.value ?? null)}`), `evidence ${entry.fact} is on the remote card`);
    }
    assert.equal(card.ref.kind, "hf");
    assert.equal(card.ref.sha, mock.sha);
    assert.equal(card.ref.revision, "main");
    assert.equal(card.ref.gated, false);
    assert.equal(card.cardId, cardIdFor({ kind: "hf", repo: "acme/demo-model", revision: "main" }));
    assert.equal(card.remote.downloads, 1234);
    assert.equal(card.remote.pipelineTag, "text-generation");
    assert.equal(card.remote.hasConfig, id === SAFETENSORS_FIXTURE);
    assert.ok(card.remote.siblings.length >= 1);
    assert.ok(card.evidence.every((entry) => entry.source.kind !== "file"), "no remote fact claims a local file");
    assert.ok(card.evidence.some((entry) => entry.source.kind === "http"));
  });
}

test("the remote card equals the card of the downloaded copy when its files are sized", async (t) => {
  const model = await materializeFixture(SAFETENSORS_FIXTURE, { sizes: "auto" });
  t.after(() => model.cleanup());
  if (!model.files.every((file) => file.sized || file.kind === "captured" || file.kind === "index")) {
    t.skip("this file system cannot size the fixture files (no sparse files)");
    return;
  }
  const local = await models.inspectLocal(model.dir, { cacheDir: await freshCacheDir() });
  const mock = createRepoMock({ files: filesFromMaterialized(SAFETENSORS_FIXTURE, model) });
  const remote = await models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir() });
  assert.deepEqual(pick(remote), pick(local));
  assert.equal(remote.contentDigest, local.contentDigest, "the pre-download digest is the post-download digest");
});

test("the GGUF header window grows from 2 MiB as the parser asks", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(GGUF_FIXTURE) });
  await models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir() });
  const ranges = mock.requests.filter((request) => request.kind === "weights").map((request) => request.range);
  assert.equal(ranges[0], "bytes=0-2097151");
  assert.ok(ranges.length >= 2 && ranges.length <= 4, `header reads: ${ranges}`);
  const MiB = 1024 * 1024;
  // Each later read starts where the last one ended and the window doubles.
  let end = 2 * MiB;
  for (const range of ranges.slice(1)) {
    const [start, last] = range.slice("bytes=".length).split("-").map(Number);
    assert.equal(start, end);
    assert.ok((last + 1 - start) >= end - (end / 2), "the window at least doubles");
    end = last + 1;
  }
  assert.ok(end <= 32 * MiB);
});

test("safetensors headers are read as 8 bytes, then the header, and no payload", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE) });
  await models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir() });
  const weights = mock.requests.filter((request) => request.kind === "weights");
  assert.equal(weights.length, 14, "7 shards, 2 reads each");
  assert.equal(weights.filter((request) => request.range === "bytes=0-7").length, 7);
  assert.ok(weights.every((request) => /^bytes=(0-7|8-\d+)$/.test(request.range)));
  assert.ok(mock.stats.bytesPulled < 4 * 1024 * 1024, "only headers travel");
  const small = mock.requests.filter((request) => request.kind === "small").map((request) => request.url.split("/").pop()).sort();
  assert.deepEqual(small, ["chat_template.jinja", "config.json", "generation_config.json", "model.safetensors.index.json", "tokenizer_config.json"]);
});

test("a repository with many shards and an index is described from the listing, not from 66 headers", async () => {
  const files = await fixtureFiles(MANY_SHARDS_FIXTURE);
  const mock = createRepoMock({
    files,
    api: { safetensors: { total: 27_781_427_952, parameters: { BF16: 3_083_727_792, F8_E4M3: 24_699_207_680 } } },
  });
  const card = await models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir() });
  assert.equal(mock.requests.filter((request) => request.kind === "weights").length, 0, "no header reads");
  assert.equal(card.weights.exact, false);
  assert.equal(card.weights.byClass, null, "byte classes stay unknown without headers");
  assert.equal(card.weights.totalBytes, card.format.weightBytes);
  assert.deepEqual(card.weights.byDtype, { BF16: 3_083_727_792 * 2, F8_E4M3: 24_699_207_680 });
  assert.equal(card.topology.paramsTotal, 27_781_427_952);
  assert.equal(card.speculative.nativeMtp, true, "MTP tensors are named in the index");
  assert.ok(card.topology.mtp.tensorCount > 0);
  assert.equal(card.topology.mtp.bytes, null);
  assert.equal(card.format.complete, true);
  assert.equal(card.identity.modelType, "qwen3_5");
  assert.deepEqual(models.validateCard(card).errors, []);
  assert.ok(card.evidence.some((entry) => entry.fact === "/weights/byDtype" && entry.source.kind === "http" && entry.confidence === "detected"));
});

// ---------------------------------------------------------------------------
// Range reader

test("readRange sends a Range header and reads a 206 body fully", async () => {
  const file = virtualFile(Buffer.from("0123456789abcdef"), 1000);
  const mock = createRepoMock({ files: new Map([["f.bin", file]]) });
  const url = `${HF}/acme/demo-model/resolve/${mock.sha}/f.bin`;
  const buffer = await rangeReader.readRange(url, { start: 4, length: 8, fetchImpl: mock.fetchImpl });
  assert.equal(buffer.toString(), "456789ab");
  assert.equal(buffer.status, 206);
  assert.equal(buffer.rangeIgnored, false);
  assert.equal(buffer.totalBytes, 1000);
  assert.equal(mock.requests[0].range, "bytes=4-11");
  assert.equal(mock.requests[0].redirect, "manual");
});

test("a server that ignores Range is read up to maxBytes and no further", async () => {
  const size = 512 * 1024 * 1024;
  const mock = createRepoMock({ files: new Map([["big.bin", virtualFile(Buffer.alloc(0), size)]]), ignoreRange: true });
  const url = `${HF}/acme/demo-model/resolve/${mock.sha}/big.bin`;
  const maxBytes = 300 * 1024;
  const buffer = await rangeReader.readRange(url, { start: 0, length: 64 * 1024 * 1024, maxBytes, fetchImpl: mock.fetchImpl });
  assert.equal(buffer.rangeIgnored, true);
  assert.equal(buffer.status, 200);
  assert.equal(buffer.length, maxBytes, "what it has: exactly the cap");
  assert.ok(mock.stats.bytesPulled <= maxBytes + CHUNK_BYTES, `pulled ${mock.stats.bytesPulled} bytes of a ${size} byte body`);
  assert.equal(mock.stats.cancelled, 1, "the stream was cancelled");
  assert.equal(mock.requests[0].range, `bytes=0-${maxBytes - 1}`, "the request itself is clamped to maxBytes");
});

test("with Range ignored the requested window is cut out of the prefix that was read", async () => {
  const head = Buffer.from("abcdefghijklmnopqrstuvwxyz");
  const mock = createRepoMock({ files: new Map([["w.bin", virtualFile(head, 1_000_000_000)]]), ignoreRange: true });
  const url = `${HF}/acme/demo-model/resolve/${mock.sha}/w.bin`;
  const window = await rangeReader.readRange(url, { start: 8, length: 8, maxBytes: 1024 * 1024, fetchImpl: mock.fetchImpl });
  assert.equal(window.toString(), "ijklmnop");
  assert.equal(window.rangeIgnored, true);
  assert.ok(mock.stats.bytesPulled <= 16 + CHUNK_BYTES, "stopped at the end of the window, not at the end of the file");
  // A window that lies beyond the cap cannot be had: nothing is invented.
  const beyond = await rangeReader.readRange(url, { start: 2 * 1024 * 1024, length: 16, maxBytes: 1024 * 1024, fetchImpl: mock.fetchImpl });
  assert.equal(beyond.length, 0);
  assert.equal(beyond.rangeIgnored, true);
});

test("readRange maps 416 to an empty result and refuses other statuses and wrong ranges", async () => {
  const mock = createRepoMock({ files: new Map([["f.bin", virtualFile(Buffer.from("abcd"), 4)]]) });
  const url = `${HF}/acme/demo-model/resolve/${mock.sha}/f.bin`;
  const past = await rangeReader.readRange(url, { start: 100, length: 8, fetchImpl: mock.fetchImpl });
  assert.equal(past.length, 0);
  assert.equal(past.status, 416);
  assert.equal(past.totalBytes, 4);
  await assert.rejects(
    rangeReader.readRange(`${HF}/acme/demo-model/resolve/${mock.sha}/missing.bin`, { start: 0, length: 8, fetchImpl: mock.fetchImpl }),
    (error) => error.code === "http_error" && error.status === 404,
  );
  const lying = async () => new Response("zz", { status: 206, headers: { "content-range": "bytes 100-101/1000" } });
  await assert.rejects(rangeReader.readRange(url, { start: 0, length: 2, fetchImpl: lying }), (error) => error.code === "range_mismatch");
  await assert.rejects(rangeReader.readRange(url, { start: -1, length: 2, fetchImpl: mock.fetchImpl }), TypeError);
  await assert.rejects(rangeReader.readRange(url, { start: 0, length: 0, fetchImpl: mock.fetchImpl }), TypeError);
});

test("a header whose body ignores the cap still never reads past maxBytes through inspectRemote", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(GGUF_FIXTURE), ignoreRange: true });
  const card = await models.inspectRemote(
    { source: "hf", repo: "acme/demo-model" },
    { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir(), maxHeaderBytes: 1024 * 1024 },
  );
  assert.ok(mock.stats.bytesPulled <= 3 * (1024 * 1024 + CHUNK_BYTES), `pulled ${mock.stats.bytesPulled}`);
  // The header does not fit in 1 MiB: its facts are unknown, never fabricated.
  assert.equal(card.topology.layers, null);
  assert.equal(card.identity.ggufArchitecture, null);
  assert.equal(card.quant.algo, null);
  assert.equal(card.quant.ggufFileType, null);
  assert.equal(card.format.kind, "gguf");
  assert.equal(card.format.complete, true, "an unreadable header is not a damaged download");
  assert.equal(card.weights.totalBytes, 97591747456, "the size from the file list is exact");
  assert.equal(card.weights.exact, false);
  assert.deepEqual(card.errors, []);
  assert.ok(codes(card.warnings).includes("gguf_header_unavailable"));
  assert.ok(codes(card.warnings).includes("remote_range_ignored"));
  assert.deepEqual(models.validateCard(card).errors, []);
});

test("the API's GGUF summary fills what an unreadable header left unknown", async () => {
  const mock = createRepoMock({
    files: await fixtureFiles(GGUF_FIXTURE),
    ignoreRange: true,
    api: { gguf: { architecture: "deepseek4", context_length: 1048576, total: 284_000_000_000, chat_template: "{{ messages }}" } },
  });
  const card = await models.inspectRemote(
    { source: "hf", repo: "acme/demo-model" },
    { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir(), maxHeaderBytes: 1024 * 1024 },
  );
  assert.equal(card.identity.ggufArchitecture, "deepseek4");
  assert.equal(card.context.native, 1048576);
  assert.equal(card.topology.paramsTotal, 284_000_000_000);
  assert.equal(card.template.source, "gguf");
  assert.equal(card.template.bytes, "{{ messages }}".length);
  assert.ok(!codes(card.warnings).includes("template_missing"));
  assert.ok(card.evidence.some((entry) => entry.fact === "/identity/ggufArchitecture" && entry.source.kind === "http" && entry.confidence === "declared"));
  assert.deepEqual(models.validateCard(card).errors, []);
});

test("without Range support a header that fits the cap is still read (the window is cut from the prefix)", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE), ignoreRange: true });
  const card = await models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir() });
  const expected = loadFixture(SAFETENSORS_FIXTURE).expectedCard;
  assert.deepEqual(pick(card), pick(expected));
  assert.deepEqual(withoutWarning(card, "remote_range_ignored"), expected.warnings);
  assert.ok(codes(card.warnings).includes("remote_range_ignored"));
});

// ---------------------------------------------------------------------------
// Injected readRange

test("an injected readRange does the header reads, with the same arguments", async () => {
  const files = await fixtureFiles(SAFETENSORS_FIXTURE);
  const mock = createRepoMock({ files });
  const calls = [];
  const readRange = async (url, options) => {
    calls.push({ url, ...options });
    const name = decodeURIComponent(new URL(url).pathname.split("/").slice(5).join("/"));
    const file = files.get(name);
    const out = Buffer.alloc(Math.min(options.length, Math.max(0, file.size - options.start)));
    file.head.copy(out, 0, options.start, Math.min(file.head.length, options.start + out.length));
    return out;
  };
  const card = await models.inspectRemote(
    { source: "hf", repo: "acme/demo-model" },
    { fetchImpl: mock.fetchImpl, readRange, token: FAKE_TOKEN, cacheDir: await freshCacheDir() },
  );
  assert.equal(calls.length, 14);
  assert.ok(calls.every((call) => call.url.startsWith(`${HF}/acme/demo-model/resolve/${mock.sha}/`)), "files are addressed at the revision sha");
  assert.ok(calls.every((call) => Number.isSafeInteger(call.start) && call.length >= 1 && call.maxBytes === 32 * 1024 * 1024));
  assert.ok(calls.every((call) => call.fetchImpl === mock.fetchImpl && call.signal instanceof AbortSignal));
  assert.ok(calls.every((call) => call.headers.authorization === `Bearer ${FAKE_TOKEN}`), "the reader gets the headers for its URL");
  assert.equal(mock.requests.filter((request) => request.kind === "weights").length, 0, "the built-in reader was not used");
  assert.deepEqual(pick(card), pick(loadFixture(SAFETENSORS_FIXTURE).expectedCard));
});

test("an injected readRange may flag rangeIgnored and a failing one degrades to unknown facts", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(GGUF_FIXTURE) });
  const flagged = Object.assign(Buffer.alloc(16), { rangeIgnored: true });
  const card = await models.inspectRemote(
    { source: "hf", repo: "acme/demo-model" },
    { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir(), readRange: async () => flagged },
  );
  assert.ok(codes(card.warnings).includes("remote_range_ignored"));
  assert.equal(card.topology.layers, null);
  const broken = await models.inspectRemote(
    { source: "hf", repo: "acme/demo-model", revision: "main" },
    { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir(), readRange: async () => { throw new Error(`reader exploded ${FAKE_TOKEN}`); }, refresh: true },
  );
  assert.equal(broken.topology.layers, null);
  assert.ok(codes(broken.warnings).includes("gguf_header_unavailable"));
  assert.ok(!JSON.stringify(broken).includes(FAKE_TOKEN));
});

// ---------------------------------------------------------------------------
// Budget

test("the budget defaults are 45 s in total and 12 s per request", () => {
  assert.equal(rangeReader.TOTAL_BUDGET_MS, 45_000);
  assert.equal(rangeReader.REQUEST_TIMEOUT_MS, 12_000);
  assert.equal(models.remote.TOTAL_BUDGET_MS, 45_000);
  let clock = 1_000;
  const budget = rangeReader.createBudget({ now: () => clock });
  assert.equal(budget.remaining(), 45_000);
  assert.equal(budget.timeoutFor(), 12_000);
  clock += 40_000;
  assert.equal(budget.timeoutFor(), 5_000, "a request gets what is left");
  budget.check();
  clock += 5_000;
  assert.equal(budget.exhausted(), true);
  assert.throws(() => budget.check(), (error) => error.code === "budget_exhausted");
});

test("once 45 s are spent no further request starts, and the card says what is unknown", async () => {
  let clock = 5_000_000;
  const started = [];
  const mock = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE) });
  const slow = async (url, init) => {
    started.push(clock);
    clock += 20_000;
    return mock.fetchImpl(url, init);
  };
  const cacheDir = await freshCacheDir();
  const card = await models.inspectRemote(
    { source: "hf", repo: "acme/demo-model" },
    { fetchImpl: slow, cacheDir, now: () => clock },
  );
  assert.equal(started.length, 3, "the listing and two files fit; nothing else started");
  assert.ok(started.every((at) => at < 5_000_000 + 45_000), "every request started inside the budget");
  assert.ok(codes(card.warnings).includes("remote_budget_exhausted"));
  assert.equal(card.weights.exact, false, "no shard headers were read");
  assert.equal(card.contentDigest, null, "a digest over missing files would not equal the real one");
  assert.deepEqual(await fsp.readdir(cacheDir), [], "a result shaped by the budget is not cached");
  assert.deepEqual(models.validateCard(card).errors, []);
});

test("a hanging listing ends in inspect_timeout at the budget, not at 12 s", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE), hang: ["/api/models/"] });
  const began = Date.now();
  await assert.rejects(
    models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir(), budgetMs: 120, token: FAKE_TOKEN }),
    (error) => error instanceof InspectError && error.code === "inspect_timeout" && error.status === 504 && !error.message.includes(FAKE_TOKEN),
  );
  assert.ok(Date.now() - began < 2000);
});

test("a file that hangs costs its request timeout, the rest is still read", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE), hang: ["/generation_config.json"] });
  const began = Date.now();
  const card = await models.inspectRemote(
    { source: "hf", repo: "acme/demo-model" },
    { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir(), budgetMs: 5000, requestTimeoutMs: 150 },
  );
  assert.ok(Date.now() - began < 4000);
  assert.equal(card.sampling, null, "the file that timed out is unknown");
  assert.ok(card.errors.some((error) => error.code === "read_failed" && error.file === "generation_config.json"));
  assert.equal(card.identity.modelType, "qwen3_5", "other files were read");
  assert.equal(card.contentDigest, null);
});

test("a caller's abort stops the inspection", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE), hang: ["/api/models/"] });
  const controller = new AbortController();
  const pending = models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir(), signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

// ---------------------------------------------------------------------------
// Token

test("the token goes to the official endpoint and never to the CDN it redirects to", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE), cdnHost: "cdn.example.test" });
  await models.inspectRemote(
    { source: "hf", repo: "acme/demo-model" },
    { fetchImpl: mock.fetchImpl, token: FAKE_TOKEN, cacheDir: await freshCacheDir() },
  );
  const official = mock.requests.filter((request) => request.host === "huggingface.co");
  const cdn = mock.requests.filter((request) => request.host === "cdn.example.test");
  assert.ok(official.length > 10 && cdn.length === 14, "downloads were redirected and followed");
  assert.ok(official.every((request) => request.headers.authorization === `Bearer ${FAKE_TOKEN}`));
  assert.ok(cdn.every((request) => !request.headers.authorization), "the CDN never sees the token");
  assert.ok(cdn.every((request) => /^bytes=/.test(request.range)), "Range survives the redirect");
});

test("a configured mirror receives the token, an unlisted endpoint is refused before any request", async () => {
  const files = await fixtureFiles(SAFETENSORS_FIXTURE);
  const mirror = "https://hf-mirror.example.test";
  const viaMirror = createRepoMock({ files, endpoint: mirror });
  await models.inspectRemote(
    { source: "hf", repo: "acme/demo-model" },
    { fetchImpl: viaMirror.fetchImpl, token: FAKE_TOKEN, endpoint: mirror, mirrors: [mirror], cache: false },
  );
  assert.ok(viaMirror.requests.length > 10);
  assert.ok(viaMirror.requests.every((request) => request.host === "hf-mirror.example.test" && request.headers.authorization === `Bearer ${FAKE_TOKEN}`));

  const refused = createRepoMock({ files, endpoint: "https://evil.example.test" });
  await assert.rejects(
    models.inspectRemote(
      { source: "hf", repo: "acme/demo-model" },
      { fetchImpl: refused.fetchImpl, token: FAKE_TOKEN, endpoint: "https://evil.example.test", mirrors: [mirror], cache: false },
    ),
    (error) => error.code === "endpoint_not_allowed" && error.status === 400 && !error.message.includes(FAKE_TOKEN),
  );
  assert.equal(refused.requests.length, 0, "no request, so no credential, left the process");
  for (const endpoint of ["ftp://mirror.example.test", "https://user:pass@mirror.example.test", "not a url"]) {
    await assert.rejects(models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: refused.fetchImpl, endpoint, cache: false }), { code: "endpoint_not_allowed" });
  }
});

test("the hub's endpoint is used as given when no mirror list is passed, and cleartext keeps the token home", async () => {
  const files = await fixtureFiles(SAFETENSORS_FIXTURE);
  const hubEndpoint = "https://hub-mirror.example.test/hf";
  const hub = createRepoMock({ files, endpoint: "https://hub-mirror.example.test" });
  const seen = [];
  const wrapped = (url, init) => {
    // The mock serves the host root; the endpoint's path prefix is stripped.
    seen.push(String(url));
    return hub.fetchImpl(String(url).replace("/hf/", "/"), init);
  };
  await models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: wrapped, endpoint: hubEndpoint, token: FAKE_TOKEN, cache: false });
  assert.ok(seen.every((url) => url.startsWith(`${hubEndpoint}/`)));
  assert.ok(hub.requests.every((request) => request.headers.authorization === `Bearer ${FAKE_TOKEN}`));

  const plain = createRepoMock({ files, endpoint: "http://mirror.lan.test" });
  await models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: plain.fetchImpl, endpoint: "http://mirror.lan.test", token: FAKE_TOKEN, cache: false });
  assert.ok(plain.requests.length > 10);
  assert.equal(authorized(plain.requests).length, 0, "a token never travels over plain http");

  assert.deepEqual(hfRemote.requestHeaders({ token: FAKE_TOKEN, url: `${HF}/x`, headers: { accept: "a" } }), { accept: "a", authorization: `Bearer ${FAKE_TOKEN}` });
  assert.deepEqual(hfRemote.requestHeaders({ token: FAKE_TOKEN, url: "https://cdn.example.test/x" }), {});
  assert.deepEqual(hfRemote.requestHeaders({ token: FAKE_TOKEN, url: "http://127.0.0.1:9/x", endpoint: "http://127.0.0.1:9" }), { authorization: `Bearer ${FAKE_TOKEN}` });
  assert.deepEqual(hfRemote.requestHeaders({ token: "", url: `${HF}/x` }), {});
});

test("ModelScope never sees a token, and a token provider function is called", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE), source: "modelscope" });
  await models.inspectRemote(
    { source: "modelscope", repo: "acme/demo-model" },
    { fetchImpl: mock.fetchImpl, token: FAKE_TOKEN, cache: false },
  );
  assert.ok(mock.requests.length > 10);
  assert.equal(authorized(mock.requests).length, 0);

  const hf = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE) });
  let asked = 0;
  await models.inspectRemote(
    { source: "hf", repo: "acme/demo-model" },
    { fetchImpl: hf.fetchImpl, token: async () => { asked += 1; return FAKE_TOKEN; }, cache: false },
  );
  assert.equal(asked, 1);
  assert.equal(authorized(hf.requests).length, hf.requests.length);
});

test("the token is absent from cards, cache files, errors and logs", async () => {
  const cacheDir = await freshCacheDir();
  const logged = [];
  const logger = { warn: (...args) => logged.push(args.join(" ")), info: (...args) => logged.push(args.join(" ")), error: (...args) => logged.push(args.join(" ")) };
  const outputs = [];
  const files = await fixtureFiles(SAFETENSORS_FIXTURE);

  // A card (with a redirect to a CDN, a gated file and a cache file).
  const ok = createRepoMock({ files, cdnHost: "cdn.example.test", deny: new Set(["generation_config.json"]) });
  const card = await models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: ok.fetchImpl, token: FAKE_TOKEN, cacheDir, logger });
  outputs.push(JSON.stringify(card));
  const second = await models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: ok.fetchImpl, token: FAKE_TOKEN, cacheDir, logger, includeTemplate: true, refresh: true });
  outputs.push(JSON.stringify(second));
  outputs.push(JSON.stringify(models.getCard(card.cardId, { cacheDir, includeTemplate: true })));

  // Errors: every failure path, with a token that a careless fetch even prints.
  const failing = [
    createRepoMock({ files, status: 403 }),
    createRepoMock({ files, status: 404 }),
    createRepoMock({ files, status: 429 }),
    createRepoMock({ files, status: 500 }),
    { fetchImpl: async () => { throw new Error(`socket closed while sending Bearer ${FAKE_TOKEN}`); }, requests: [] },
    { fetchImpl: async () => new Response("{", { status: 200 }), requests: [] },
    { fetchImpl: async () => new Response(null, { status: 302, headers: { location: `ftp://elsewhere.example.test/?t=${FAKE_TOKEN}` } }), requests: [] },
  ];
  for (const [index, mock] of failing.entries()) {
    const error = await models.inspectRemote({ source: "hf", repo: `acme/failing-${index}` }, { fetchImpl: mock.fetchImpl, token: FAKE_TOKEN, cacheDir, logger }).then(() => null, (reason) => reason);
    assert.ok(error instanceof InspectError, `case ${index} fails with an InspectError, got ${error}`);
    outputs.push(error.message, error.stack || "", JSON.stringify(error, Object.getOwnPropertyNames(error)));
  }
  outputs.push(...logged);

  for (const text of outputs) assert.ok(!text.includes(FAKE_TOKEN), "token found in output");
  const cacheFiles = await allFiles(cacheDir);
  assert.ok(cacheFiles.length >= 1);
  for (const file of cacheFiles) {
    const body = await fsp.readFile(file, "utf8");
    assert.ok(!body.includes(FAKE_TOKEN), `token found in ${path.basename(file)}`);
    assert.ok(!/"authorization"|Bearer /i.test(body), "no authorization header text");
  }
});

// ---------------------------------------------------------------------------
// Failures

test("gated: the listing works, the files refuse, and the card says so", async () => {
  const mock = createRepoMock({
    files: await fixtureFiles(SAFETENSORS_FIXTURE),
    deny: new Set(["config.json", "tokenizer_config.json", "generation_config.json", "chat_template.jinja", "model.safetensors.index.json"]),
    api: {
      gated: "auto",
      config: { model_type: "qwen3_5", architectures: ["Qwen3_5ForConditionalGeneration"], tokenizer_config: { chat_template: "{{ messages }}" } },
    },
  });
  mock.requests.length = 0;
  const cacheDir = await freshCacheDir();
  const card = await models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: mock.fetchImpl, cacheDir });
  assert.equal(card.ref.gated, true);
  assert.ok(codes(card.warnings).includes("remote_gated"));
  assert.ok(codes(card.warnings).includes("config_from_api"));
  assert.equal(card.identity.modelType, "qwen3_5", "from the API summary");
  assert.deepEqual(card.identity.architectures, ["Qwen3_5ForConditionalGeneration"]);
  assert.equal(card.template.source, "tokenizer_config.json");
  assert.equal(card.contentDigest, null, "a digest over an incomplete set of files would not equal the real one");
  assert.equal(card.topology.layers, null, "the topology lives in the config.json that was refused");
  assert.deepEqual(models.validateCard(card).errors, []);
  assert.equal((await fsp.readdir(cacheDir)).length, 1, "a gated result is stable, so it is cached");
});

test("the listing refusing access is a gated error; unknown repos and revisions are 404s", async () => {
  const files = await fixtureFiles(SAFETENSORS_FIXTURE);
  const gated = createRepoMock({ files, status: 401 });
  await assert.rejects(models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: gated.fetchImpl }), (error) => error.code === "gated" && error.status === 403);
  const missing = createRepoMock({ files, status: 404 });
  await assert.rejects(models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: missing.fetchImpl }), (error) => error.code === "repo_not_found" && error.status === 404);
  const noRevision = async () => new Response(JSON.stringify({ error: "Revision Not Found for url: x" }), { status: 404 });
  await assert.rejects(models.inspectRemote({ source: "hf", repo: "acme/demo-model", revision: "v9" }, { fetchImpl: noRevision }), { code: "revision_not_found" });
  const limited = createRepoMock({ files, status: 429 });
  await assert.rejects(models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: limited.fetchImpl }), (error) => error.code === "rate_limited" && error.status === 429);
  const down = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, { fetchImpl: down }), (error) => error.code === "network_unreachable" && error.status === 502);
});

test("a malformed request is refused before any request", async () => {
  const mock = createRepoMock({ files: new Map() });
  for (const request of [
    { source: "hf", repo: "no-slash" },
    { source: "hf", repo: "a/b/c" },
    { source: "hf", repo: "../x" },
    { source: "hf", repo: "acme/demo model" },
    { source: "hf", repo: "acme/demo", revision: "bad revision" },
    { source: "civitai", repo: "acme/demo" },
    {},
  ]) {
    await assert.rejects(models.inspectRemote(request, { fetchImpl: mock.fetchImpl }), (error) => error instanceof InspectError && error.code === "invalid_repo" && error.status === 400, JSON.stringify(request));
  }
  assert.equal(mock.requests.length, 0);
});

// ---------------------------------------------------------------------------
// ModelScope

test("ModelScope: the same card from the file list and resolve downloads", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE), source: "modelscope" });
  const card = await models.inspectRemote({ source: "modelscope", repo: "acme/demo-model" }, { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir() });
  const expected = loadFixture(SAFETENSORS_FIXTURE).expectedCard;
  assert.deepEqual(pick(card), pick(expected));
  assert.equal(card.ref.kind, "modelscope");
  assert.equal(card.ref.revision, "master");
  assert.equal(card.ref.sha, null);
  assert.equal(card.remote.hasConfig, true);
  assert.equal(card.remote.downloads, null);
  assert.equal(card.cardId, cardIdFor({ kind: "modelscope", repo: "acme/demo-model", revision: "master" }));
  assert.ok(mock.requests[0].url.startsWith("https://www.modelscope.cn/api/v1/models/acme/demo-model/repo/files?Recursive=true&Revision=master"));
  assert.ok(mock.requests.some((request) => request.url.includes("/models/acme/demo-model/resolve/master/config.json")));
  assert.deepEqual(models.validateCard(card).errors, []);
});

test("ModelScope without Range support: header facts stay unknown, hasConfig is read from the file list", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(GGUF_FIXTURE), source: "modelscope", ignoreRange: true, repo: "acme/demo-gguf" });
  const card = await models.inspectRemote(
    { source: "modelscope", repo: "acme/demo-gguf" },
    { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir(), maxHeaderBytes: 512 * 1024 },
  );
  assert.equal(card.remote.hasConfig, false, "a fact from the file list, not a constant");
  assert.equal(card.topology.layers, null);
  assert.equal(card.identity.ggufArchitecture, null);
  assert.equal(card.weights.totalBytes, 97591747456);
  assert.ok(codes(card.warnings).includes("gguf_header_unavailable"));
  assert.ok(mock.stats.bytesPulled <= 2 * (512 * 1024 + CHUNK_BYTES));
  const withConfig = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE), source: "modelscope" });
  const other = await models.inspectRemote({ source: "modelscope", repo: "acme/demo-model" }, { fetchImpl: withConfig.fetchImpl, cacheDir: await freshCacheDir() });
  assert.equal(other.remote.hasConfig, true);
  assert.throws(() => modelscopeRemote.resolveEndpoint({ endpoint: "https://evil.example.test" }), { code: "endpoint_not_allowed" });
  assert.equal(modelscopeRemote.resolveEndpoint({ endpoint: "https://modelscope.cn/" }).base, "https://modelscope.cn");
});

// ---------------------------------------------------------------------------
// GGUF variants

function ggufHead(metadata, tensorCount = 2) {
  const tensors = Array.from({ length: tensorCount }, (_, index) => ({ name: `blk.${index}.attn_q.weight`, dims: [64, 64], type: "F16", offset: index * 8192 }));
  return fakeGguf({ "general.architecture": "llama", "llama.block_count": 2, "llama.context_length": 4096, "llama.embedding_length": 64, "llama.attention.head_count": 4, "llama.attention.head_count_kv": 2, ...metadata }, tensors, 64);
}

function variantRepo() {
  const GiB = 1024 ** 3;
  return new Map([
    ["README.md", virtualFile(Buffer.alloc(0), 2000)],
    ["Model-Q8_0.gguf", virtualFile(ggufHead({ "general.name": "Q8" }), 8 * GiB)],
    ["Model-Q4_K_M-00001-of-00002.gguf", virtualFile(ggufHead({ "general.name": "Q4", "split.no": 0, "split.count": 2 }), 3 * GiB)],
    ["Model-Q4_K_M-00002-of-00002.gguf", virtualFile(ggufHead({ "general.name": "Q4", "split.no": 1, "split.count": 2 }), 3 * GiB)],
    ["Model-Q2_K-00001-of-00003.gguf", virtualFile(ggufHead({ "general.name": "Q2" }), 1 * GiB)],
    ["mmproj-F16.gguf", virtualFile(fakeGguf({ "general.architecture": "clip", "general.type": "mmproj", "clip.has_vision_encoder": true }, [], 32), GiB / 2)],
    [".gitattributes", virtualFile(Buffer.alloc(0), 100)],
    ["docs/deep/ignored.md", virtualFile(Buffer.alloc(0), 10)],
  ]);
}

test("GGUF variants: the largest complete one is described; files selects another", async () => {
  const mock = createRepoMock({ files: variantRepo(), repo: "acme/demo-gguf" });
  const cacheDir = await freshCacheDir();
  const card = await models.inspectRemote({ source: "hf", repo: "acme/demo-gguf" }, { fetchImpl: mock.fetchImpl, cacheDir });
  assert.equal(card.format.kind, "gguf");
  assert.equal(card.identity.displayName, "Q8", "the largest complete variant (Q2 is missing two shards)");
  assert.ok(codes(card.warnings).includes("multiple_gguf_variants"));
  assert.deepEqual(card.modalities.projectorFiles, ["mmproj-F16.gguf"]);
  assert.ok(card.modalities.input.includes("image"));
  const headerReads = mock.requests.filter((request) => request.kind === "weights").map((request) => request.url.split("/").pop());
  assert.deepEqual(Array.from(new Set(headerReads)).sort(), ["Model-Q8_0.gguf", "mmproj-F16.gguf"], "other variants' headers are not read");
  assert.deepEqual(card.remote.siblings.map((item) => item.name).slice(0, 3), ["README.md", "Model-Q8_0.gguf", "Model-Q4_K_M-00001-of-00002.gguf"], "the card lists every repository file");

  const chosen = createRepoMock({ files: variantRepo(), repo: "acme/demo-gguf" });
  const split = await models.inspectRemote(
    { source: "hf", repo: "acme/demo-gguf", files: ["Model-Q4_K_M-00001-of-00002.gguf", "Model-Q4_K_M-00002-of-00002.gguf"] },
    { fetchImpl: chosen.fetchImpl, cacheDir },
  );
  assert.equal(split.identity.displayName, "Q4");
  assert.equal(split.format.layout, "gguf-split");
  assert.equal(split.format.weightFiles, 2);
  assert.equal(split.format.weightBytes, 6 * 1024 ** 3);
  assert.ok(!codes(split.warnings).includes("multiple_gguf_variants"));
  assert.equal(split.cardId, card.cardId, "the card id is (source, repo, revision); the selection replaces the cached facts");
  const read = new Set(chosen.requests.filter((request) => request.kind === "weights").map((request) => request.url.split("/").pop()));
  assert.ok(read.has("Model-Q4_K_M-00001-of-00002.gguf") && read.has("Model-Q4_K_M-00002-of-00002.gguf") && !read.has("Model-Q8_0.gguf"));
});

test("the listing keeps the detectors' view: depth two, no dot entries, sorted, classified", () => {
  const listing = buildListing([
    { name: "b.safetensors", size: 5 }, { name: "a/b/c.json", size: 1 }, { name: ".gitattributes", size: 1 }, { name: "sub/config.json", size: 2 },
    { name: "config.json", size: 3 }, { name: "../etc", size: 1 }, { name: "config.json", size: 9 },
  ]);
  assert.deepEqual(listing.files.map((file) => [file.name, file.kind, file.size]), [
    ["b.safetensors", "weights:safetensors", 5], ["config.json", "config", 3], ["sub/config.json", "other", 2],
  ]);
  assert.deepEqual(listing.skipped, { hidden: 1, links: 0, deep: 1 });
  const selection = selectGgufVariant(buildListing(Array.from(variantRepo(), ([name, file]) => ({ name, size: file.size }))).files, new Set());
  assert.equal(selection.main.files[0].name, "Model-Q8_0.gguf");
  assert.equal(selection.variants, 3);
});

// ---------------------------------------------------------------------------
// Cache

test("remote facts are cached by repository and sha for 24 hours", async () => {
  const files = await fixtureFiles(SAFETENSORS_FIXTURE);
  const mock = createRepoMock({ files });
  const cacheDir = await freshCacheDir();
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const options = { fetchImpl: mock.fetchImpl, cacheDir, now: () => clock };
  const request = { source: "hf", repo: "acme/demo-model" };

  const first = await models.inspectRemoteDetailed(request, options);
  assert.equal(first.cached, false);
  const spent = mock.requests.length;
  assert.deepEqual(await fsp.readdir(cacheDir), [`${first.card.cardId}.json`]);

  clock += 60 * 60 * 1000;
  const again = await models.inspectRemoteDetailed(request, options);
  assert.equal(again.cached, true);
  assert.equal(mock.requests.length, spent, "an hour later: answered from memory, no request");
  assert.deepEqual(again.card, first.card);

  await resetInspector();
  const fromDisk = await models.inspectRemoteDetailed(request, options);
  assert.equal(fromDisk.cached, true);
  assert.equal(mock.requests.length, spent, "from the cache file after a restart");
  assert.deepEqual(pick(fromDisk.card), pick(first.card));
  assert.equal(models.getCard(first.card.cardId, { cacheDir }).ref.sha, mock.sha);

  // After the TTL the listing is asked again; the same sha keeps the facts.
  clock += 24 * 60 * 60 * 1000;
  const revalidated = await models.inspectRemoteDetailed(request, options);
  assert.equal(revalidated.cached, true);
  assert.equal(mock.requests.length, spent + 1, "only the listing was fetched");
  assert.equal(mock.requests.at(-1).kind, "api");

  // A changed sha is a miss: everything is read again.
  clock += 25 * 60 * 60 * 1000;
  mock.setSha("fedcba9876543210fedcba9876543210fedcba98");
  const changed = await models.inspectRemoteDetailed(request, options);
  assert.equal(changed.cached, false);
  assert.equal(changed.card.ref.sha, "fedcba9876543210fedcba9876543210fedcba98");
  assert.ok(mock.requests.length > spent + 10);
  assert.ok(mock.requests.slice(spent + 1).some((item) => item.url.includes("fedcba9876543210")), "files are read at the new sha");

  // refresh skips the cache within the TTL.
  const before = mock.requests.length;
  await models.inspectRemoteDetailed(request, { ...options, refresh: true });
  assert.ok(mock.requests.length > before + 10);
});

test("a commit sha never expires", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const pinned = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE), revision: sha, sha });
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const options = { fetchImpl: pinned.fetchImpl, cacheDir: await freshCacheDir(), now: () => clock };
  await models.inspectRemote({ source: "hf", repo: "acme/demo-model", revision: sha }, options);
  const spent = pinned.requests.length;
  clock += 10 * 24 * 60 * 60 * 1000;
  const later = await models.inspectRemoteDetailed({ source: "hf", repo: "acme/demo-model", revision: sha }, options);
  assert.equal(later.cached, true);
  assert.equal(pinned.requests.length, spent, "a commit cannot change, so nothing is asked again");
});

test("facts made without a token for a refusing repository are redone once a token is given", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE), requireToken: new Set(["config.json"]) });
  const options = { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir() };
  const request = { source: "hf", repo: "acme/demo-model" };
  const anonymous = await models.inspectRemoteDetailed(request, options);
  assert.equal(anonymous.card.ref.gated, true);
  assert.equal(anonymous.card.topology.layers, null, "config.json was refused");
  const spent = mock.requests.length;
  const again = await models.inspectRemoteDetailed(request, options);
  assert.equal(again.cached, true, "without a token nothing new can be learned");
  assert.equal(mock.requests.length, spent);
  const withToken = await models.inspectRemoteDetailed(request, { ...options, token: FAKE_TOKEN });
  assert.equal(withToken.cached, false);
  assert.equal(withToken.card.topology.layers, 64);
  assert.equal(withToken.card.ref.gated, false);
  assert.ok(withToken.card.contentDigest);
  const afterwards = await models.inspectRemoteDetailed(request, options);
  assert.equal(afterwards.cached, true, "a card made with a token serves later callers too");
  assert.equal(afterwards.card.topology.layers, 64);
});

test("concurrent identical requests share one inspection", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE) });
  const options = { fetchImpl: mock.fetchImpl, cacheDir: await freshCacheDir() };
  const [one, two] = await Promise.all([
    models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, options),
    models.inspectRemote({ source: "hf", repo: "acme/demo-model" }, options),
  ]);
  assert.deepEqual(one, two);
  assert.equal(mock.requests.filter((request) => request.kind === "api").length, 1);
  assert.equal(mock.requests.filter((request) => request.kind === "weights").length, 14);
});

test("a cache that cannot be written still returns the card", async () => {
  const mock = createRepoMock({ files: await fixtureFiles(SAFETENSORS_FIXTURE) });
  const blocker = path.join(root, "not-a-directory");
  await fsp.writeFile(blocker, "x");
  const warned = [];
  const card = await models.inspectRemote(
    { source: "hf", repo: "acme/demo-model" },
    { fetchImpl: mock.fetchImpl, cacheDir: path.join(blocker, "cache"), logger: { warn: (message) => warned.push(message) } },
  );
  assert.equal(card.identity.modelType, "qwen3_5");
  assert.equal(warned.length, 1);
});

// ---------------------------------------------------------------------------
// Delegation and namespace

test("remote-model-config delegates URL building and the token rule to the remote clients", async () => {
  assert.equal(remoteConfigUrl("huggingface", "Qwen/Qwen3-8B"), "https://huggingface.co/Qwen/Qwen3-8B/resolve/main/config.json");
  assert.equal(remoteConfigUrl("modelscope", "Qwen/Qwen3-8B"), "https://www.modelscope.cn/models/Qwen/Qwen3-8B/resolve/master/config.json");
  assert.equal(remoteConfigUrl("hf", "a b/c", { hfEndpoint: "https://m.example.test/", file: "x/y.json" }), "https://m.example.test/a%20b/c/resolve/main/x/y.json");
  assert.equal(remoteConfigUrl("modelscope", "o/n", { revision: "v1" }), "https://www.modelscope.cn/models/o/n/resolve/v1/config.json");

  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify({ model_type: "qwen3" }) };
  };
  const official = await fetchRemoteModelConfig({ model: "x/y", token: FAKE_TOKEN, fetchImpl });
  assert.equal(official.ok, true);
  assert.equal(seen[0].headers.authorization, `Bearer ${FAKE_TOKEN}`);
  await fetchRemoteModelConfig({ model: "x/y", source: "modelscope", token: FAKE_TOKEN, fetchImpl });
  assert.equal(seen[1].headers.authorization, undefined, "ModelScope never gets the token");
  await fetchRemoteModelConfig({ model: "x/y", token: FAKE_TOKEN, hfEndpoint: "http://mirror.lan.test", fetchImpl });
  assert.equal(seen[2].headers.authorization, undefined, "nor does a cleartext mirror");
  const bad = await fetchRemoteModelConfig({ model: "x/y", hfEndpoint: "not a url", fetchImpl });
  assert.equal(bad.ok, false);
  assert.equal(seen.length, 3);
});

test("core.models exposes the remote inspector without flat export collisions", () => {
  assert.equal(core.models.inspectRemote, models.inspectRemote);
  assert.equal(typeof core.models.inspectRemoteDetailed, "function");
  assert.equal(core.models.remote.readRange, rangeReader.readRange);
  assert.equal(core.inspectRemote, undefined, "inspectRemote stays inside core.models");
  assert.equal(core.readRange, undefined);
  assert.equal(core.models.getCard(cardIdFor({ kind: "hf", repo: "acme/never-inspected", revision: "main" })), null);
});
