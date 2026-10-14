"use strict";

// Model hub providers (docs/overhaul/03-hub.md §4, §17, HUB-2): the Hugging
// Face and hf-mirror metadata providers and the credential guard around
// them. No test touches the network: every case drives the providers
// through a fake fetch, and the recorded-shape API payloads live in
// test/fixtures/hub/hf-*.json.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ProviderError,
  authorizedFetch,
  cappedJson,
  isHuggingFaceHost,
  parseLinkHeader,
} = require("../model-hub/providers/http");
const { SEARCH_EXPAND, TREE_FALLBACK_FILES, createHuggingFaceProvider, normalizeRepoInfo } = require("../model-hub/providers/huggingface");
const { createHfMirrorProvider } = require("../model-hub/providers/hf-mirror");
const { buildModelScopeCliEnv, createModelScopeProvider } = require("../model-hub/providers/modelscope");
const { MIRROR_FALLBACK_CODE, createProviders } = require("../model-hub/providers");
const { createSingleFlightCache } = require("../single-flight-cache");

const FIXTURES = path.join(__dirname, "fixtures", "hub");
const PROVIDERS_DIR = path.join(__dirname, "..", "model-hub", "providers");
// Obviously fake; assembled so no scanner mistakes it for a real token.
const FAKE_TOKEN = ["hf", "_", "FAKEFAKEFAKEFAKEFAKEFAKEFAKE"].join("");
const FIXED_NOW = Date.parse("2026-10-14T08:00:00.000Z");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

function fakeClock(start = FIXED_NOW) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function textResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers: { "content-type": "text/markdown", ...headers } });
}

function redirect(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

// A recording fetch. `handler(url: URL, init, call)` returns a Response, or
// throws. Every call keeps the lower-cased request headers it was given.
function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || "GET",
      headers: Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), value])),
      redirect: init.redirect,
      body: init.body,
      signal: init.signal,
    };
    calls.push(call);
    return handler(new URL(call.url), init, call);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function networkFailure() {
  return Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
}

// Settles like a real fetch: rejects with the signal's reason once it aborts
// (immediately when it already has).
function hangUntilAborted(init) {
  return new Promise((resolve, reject) => {
    if (init.signal.aborted) return reject(init.signal.reason);
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    return undefined;
  });
}

function huge(count) {
  return Array.from({ length: count }, (_, index) => ({ rfilename: `shard-${String(index).padStart(5, "0")}.bin`, size: 10 }));
}

function provider(fetchImpl, extra = {}) {
  return createHuggingFaceProvider({ fetchImpl, getToken: () => "", clock: fakeClock(), ...extra });
}

// ---------------------------------------------------------------- http.js

test("isHuggingFaceHost accepts huggingface.co and its subdomains only", () => {
  for (const host of ["huggingface.co", "HuggingFace.co", "cdn-lfs.huggingface.co", "https://huggingface.co/x", "huggingface.co."]) {
    assert.equal(isHuggingFaceHost(host), true, host);
  }
  for (const host of ["hf-mirror.com", "huggingface.co.evil.example", "evilhuggingface.co", "cas-bridge.xethub.hf.co", "huggingface.com", "", "not a host"]) {
    assert.equal(isHuggingFaceHost(host), false, host);
  }
});

test("authorizedFetch attaches the credential for huggingface.co hosts over https only", async () => {
  const fetchImpl = recordingFetch(() => json({ ok: true }));
  await authorizedFetch("https://huggingface.co/api/models", { token: FAKE_TOKEN, fetchImpl });
  await authorizedFetch("https://cdn-lfs.huggingface.co/x", { token: FAKE_TOKEN, fetchImpl });
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(fetchImpl.calls[1].headers.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.ok(fetchImpl.calls.every((call) => call.redirect === "manual"), "redirects are never left to the runtime");
  // No token, no header, and any host is fine.
  await authorizedFetch("https://hf-mirror.com/api/models", { fetchImpl });
  assert.equal(fetchImpl.calls[2].headers.authorization, undefined);
});

test("credential_host_violation: a credential for any other host throws before a request is made", async () => {
  const fetchImpl = recordingFetch(() => json({}));
  const cases = [
    "https://hf-mirror.com/api/models",
    "https://huggingface.co.evil.example/api/models",
    "https://evilhuggingface.co/api/models",
    "https://cas-bridge.xethub.hf.co/blob",
    "http://huggingface.co/api/models",
    "http://127.0.0.1:5000/api/models",
  ];
  for (const url of cases) {
    await assert.rejects(authorizedFetch(url, { token: FAKE_TOKEN, fetchImpl }), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "credential_host_violation", url);
      assert.ok(!error.message.includes(FAKE_TOKEN), "the error never carries the token");
      assert.ok(!JSON.stringify(error.details).includes(FAKE_TOKEN));
      return true;
    });
    // A hand-written Authorization header is the same credential.
    await assert.rejects(
      authorizedFetch(url, { fetchImpl, headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }),
      (error) => error.code === "credential_host_violation",
      url,
    );
  }
  assert.equal(fetchImpl.calls.length, 0, "nothing was sent");
});

test("authorizedFetch strips the credential across a redirect to a CDN host", async () => {
  const fetchImpl = recordingFetch((url) => {
    if (url.hostname === "huggingface.co" && url.pathname.endsWith("/resolve/main/model.bin")) {
      return redirect("https://cas-bridge.xethub.hf.co/xet/model.bin?sig=abc", 302);
    }
    if (url.hostname === "cas-bridge.xethub.hf.co") return redirect("https://huggingface.co/api/done", 307);
    return json({ done: true });
  });
  const response = await authorizedFetch("https://huggingface.co/org/repo/resolve/main/model.bin", {
    token: FAKE_TOKEN,
    fetchImpl,
    headers: { cookie: "session=1", accept: "*/*" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(fetchImpl.calls.map((call) => new URL(call.url).hostname), ["huggingface.co", "cas-bridge.xethub.hf.co", "huggingface.co"]);
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(fetchImpl.calls[1].headers.authorization, undefined, "the CDN hop carries no credential");
  assert.equal(fetchImpl.calls[1].headers.cookie, undefined, "nor cookies across origins");
  assert.equal(fetchImpl.calls[1].headers.accept, "*/*");
  // Coming back to huggingface.co is a Hugging Face host again.
  assert.equal(fetchImpl.calls[2].headers.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.ok(fetchImpl.calls.every((call) => call.redirect === "manual"));
  const sentToThirdParty = fetchImpl.calls.filter((call) => !isHuggingFaceHost(call.url) && call.headers.authorization);
  assert.deepEqual(sentToThirdParty, []);
});

test("authorizedFetch follows redirect rules: limit, downgrade, scheme, method", async () => {
  let hops = 0;
  const loop = recordingFetch(() => redirect(`https://huggingface.co/hop-${hops += 1}`));
  await assert.rejects(authorizedFetch("https://huggingface.co/start", { fetchImpl: loop }), (error) => error.code === "provider_redirect_loop" && error.networkClass);
  assert.equal(loop.calls.length, 6, "the original request plus five redirects");

  const downgrade = recordingFetch(() => redirect("http://cdn.example/blob"));
  await assert.rejects(authorizedFetch("https://huggingface.co/x", { fetchImpl: downgrade }), (error) => error.code === "provider_bad_response");
  const scheme = recordingFetch(() => redirect("ftp://cdn.example/blob"));
  await assert.rejects(authorizedFetch("https://huggingface.co/x", { fetchImpl: scheme }), (error) => error.code === "provider_bad_response");

  const post = recordingFetch((url) => (url.pathname === "/a" ? redirect("/b", 303) : json({})));
  await authorizedFetch("https://huggingface.co/a", { fetchImpl: post, method: "POST", body: "payload", token: FAKE_TOKEN });
  assert.equal(post.calls[0].method, "POST");
  assert.equal(post.calls[1].method, "GET");
  assert.equal(post.calls[1].body, undefined);
  assert.equal(post.calls[1].headers.authorization, `Bearer ${FAKE_TOKEN}`, "a relative redirect stays on huggingface.co");

  // A 3xx without a Location is just a response.
  const bare = recordingFetch(() => new Response(null, { status: 304 }));
  assert.equal((await authorizedFetch("https://huggingface.co/x", { fetchImpl: bare })).status, 304);
});

test("cappedJson enforces the byte cap on streams and on bodies that cannot stream", async () => {
  assert.deepEqual(await cappedJson(json({ a: 1 }), 1024), { a: 1 });
  await assert.rejects(cappedJson(json({ big: "x".repeat(5000) }), 1000), (error) => error.code === "provider_response_too_large");
  // content-length alone is enough to refuse.
  const declared = new Response("{}", { headers: { "content-length": "999999" } });
  await assert.rejects(cappedJson(declared, 1000), (error) => error.code === "provider_response_too_large");
  const noStream = { headers: { get: () => null }, arrayBuffer: async () => Buffer.from(JSON.stringify({ big: "x".repeat(5000) })).buffer };
  await assert.rejects(cappedJson(noStream, 1000), (error) => error.code === "provider_response_too_large");
  await assert.rejects(cappedJson(new Response("not json"), 1000), (error) => error.code === "provider_bad_response");
});

test("parseLinkHeader finds rel=next among several links", () => {
  const header = '<https://huggingface.co/api/models?cursor=prev1>; rel="prev", <https://huggingface.co/api/models?a=1,2&cursor=next1>; rel="next"';
  const links = parseLinkHeader(header);
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((link) => link.rel), [["prev"], ["next"]]);
  assert.equal(links[1].url, "https://huggingface.co/api/models?a=1,2&cursor=next1");
  assert.deepEqual(parseLinkHeader("<https://x.example/a>; rel=next")[0].rel, ["next"]);
  assert.deepEqual(parseLinkHeader(""), []);
  assert.deepEqual(parseLinkHeader("garbage"), []);
});

// ------------------------------------------------------------ search

test("search builds the documented query and parses the fixture pages with the Link cursor", async () => {
  const page1 = fixture("hf-search-page1.json");
  const page2 = fixture("hf-search-page2.json");
  const fetchImpl = recordingFetch((url) => {
    if (url.searchParams.get("cursor") === "abc123") return json(page2);
    return json(page1, { headers: { link: '<https://huggingface.co/api/models?search=example&filter=gguf&limit=24&cursor=abc123>; rel="next"' } });
  });
  const hf = provider(fetchImpl);

  const first = await hf.search({ q: "example", filter: "gguf", task: "text-generation", sort: "downloads", limit: 24 });
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.origin + url.pathname, "https://huggingface.co/api/models");
  assert.equal(url.searchParams.get("search"), "example");
  assert.deepEqual(url.searchParams.getAll("filter"), ["gguf"]);
  assert.equal(url.searchParams.get("pipeline_tag"), "text-generation");
  assert.equal(url.searchParams.get("sort"), "downloads");
  assert.equal(url.searchParams.get("direction"), "-1");
  assert.equal(url.searchParams.get("limit"), "24");
  assert.deepEqual(url.searchParams.getAll("expand[]"), [...SEARCH_EXPAND]);
  assert.equal(fetchImpl.calls[0].headers.accept, "application/json");

  assert.equal(first.fetchedFrom, "https://huggingface.co");
  assert.deepEqual(first.warnings, []);
  assert.equal(first.nextCursor, "/api/models?search=example&filter=gguf&limit=24&cursor=abc123");
  assert.equal(first.items.length, 4, "the entry without an id is dropped");
  const [gguf, fp8, mixed, sparse] = first.items;
  assert.equal(gguf.namespace, "huggingface");
  assert.equal(gguf.repo, "example-org/Example-8B-GGUF");
  assert.equal(gguf.author, "example-org");
  assert.equal(gguf.pipelineTag, "text-generation");
  assert.equal(gguf.library, "gguf");
  assert.equal(gguf.downloads, 120000);
  assert.equal(gguf.likes, 300);
  assert.equal(gguf.baseModel, "Example-Org/Example-8B");
  assert.equal(gguf.license, "apache-2.0");
  assert.equal(gguf.gated, false);
  assert.equal(gguf.gatedMode, null);
  assert.deepEqual(gguf.gguf, { architecture: "qwen3", context_length: 40960, total: 8190735360 }, "bulky gguf fields are not carried");
  assert.equal(gguf.usedStorage, 62000000000);
  assert.equal(fp8.baseModel, "Example-Org/Example-8B", "base_model may be a list");
  assert.equal(fp8.safetensors.total, 8190735360);
  assert.equal(fp8.safetensors.parameters.F8_E4M3, 6947599360);
  assert.equal(fp8.license, "apache-2.0", "the license falls back to the tag");
  assert.equal(mixed.gated, true);
  assert.equal(mixed.gatedMode, "manual");
  assert.equal(sparse.downloads, null, "missing numbers stay unknown");
  assert.equal(sparse.pipelineTag, null);
  assert.deepEqual(sparse.tags, ["gguf"]);

  // Following the cursor requests exactly the Link URL's query.
  const second = await hf.search({ cursor: first.nextCursor });
  assert.equal(fetchImpl.calls[1].url, "https://huggingface.co/api/models?search=example&filter=gguf&limit=24&cursor=abc123");
  assert.equal(second.nextCursor, null);
  assert.equal(second.items.length, 2);
  assert.equal(second.items[0].baseModel, "another-org/Another-14B", "base_model:<relation>:<repo> tags are read");
  assert.equal(second.items[1].repo, "standalone-model");
});

test("a search cursor can only ever address this provider's own models endpoint", async () => {
  const fetchImpl = recordingFetch(() => json([]));
  const hf = provider(fetchImpl, { getToken: () => FAKE_TOKEN });
  await hf.search({ cursor: "https://evil.example/api/models?cursor=zzz&limit=5" });
  assert.equal(fetchImpl.calls[0].url, "https://huggingface.co/api/models?cursor=zzz&limit=5");
  for (const bad of ["/api/other?x=1", "https://huggingface.co/api/models", "", "x".repeat(5000), "/api/models/../secret?x=1"]) {
    if (!bad) continue;
    await assert.rejects(hf.search({ cursor: bad }), (error) => error.code === "invalid_cursor", bad.slice(0, 30));
  }
  assert.equal(fetchImpl.calls.length, 1);

  // A Link header pointing at another host or path yields only a clean cursor, or none.
  const link = (value) => recordingFetch(() => json([], { headers: { link: `<${value}>; rel="next"` } }));
  assert.equal((await provider(link("https://evil.example/api/models?cursor=q")).search({ q: "a" })).nextCursor, "/api/models?cursor=q");
  assert.equal((await provider(link("https://huggingface.co/somewhere/else?cursor=q")).search({ q: "a" })).nextCursor, null);
});

test("search validates sort and clamps the limit", async () => {
  const fetchImpl = recordingFetch(() => json([]));
  const hf = provider(fetchImpl);
  await hf.search({ sort: "updated", limit: 5000 });
  await hf.search({ sort: "trending", limit: -3 });
  await hf.search({ sort: "likes", limit: "7", direction: 1, author: "example-org", filter: ["gguf", "text-generation"] });
  const params = fetchImpl.calls.map((call) => new URL(call.url).searchParams);
  assert.equal(params[0].get("sort"), "lastModified");
  assert.equal(params[0].get("limit"), "100");
  assert.equal(params[1].get("sort"), "trendingScore");
  assert.equal(params[1].get("limit"), "24");
  assert.equal(params[2].get("limit"), "7");
  assert.equal(params[2].get("direction"), "1");
  assert.equal(params[2].get("author"), "example-org");
  assert.deepEqual(params[2].getAll("filter"), ["gguf", "text-generation"]);
  await assert.rejects(hf.search({ sort: "popular" }), (error) => error.code === "invalid_query");
  await assert.rejects(provider(recordingFetch(() => json({ not: "a list" }))).search({}), (error) => error.code === "provider_bad_response");
});

// -------------------------------------------------------- manifest

test("getRepo returns a manifest with sha256, gitOid, sizes and revisionSha", async () => {
  const payload = fixture("hf-gguf-multiquant.json");
  const fetchImpl = recordingFetch(() => json(payload));
  const hf = provider(fetchImpl);
  const manifest = await hf.getRepo("example-org/Example-8B-GGUF");

  assert.equal(fetchImpl.calls[0].url, "https://huggingface.co/api/models/example-org/Example-8B-GGUF/revision/main?blobs=true");
  assert.equal(manifest.namespace, "huggingface");
  assert.equal(manifest.repo, "example-org/Example-8B-GGUF");
  assert.equal(manifest.revision, "main");
  assert.match(manifest.revisionSha, /^[0-9a-f]{40}$/);
  assert.equal(manifest.revisionSha, payload.sha);
  assert.equal(manifest.gated, false);
  assert.equal(manifest.private, false);
  assert.equal(manifest.pipelineTag, "text-generation");
  assert.equal(manifest.library, "gguf");
  assert.equal(manifest.baseModel, "Example-Org/Example-8B");
  assert.equal(manifest.license, "apache-2.0");
  assert.equal(manifest.lastModified, "2026-09-18T10:21:34.000Z");
  assert.equal(manifest.fetchedAt, "2026-10-14T08:00:00.000Z");
  assert.equal(manifest.fetchedFrom, "https://huggingface.co");
  assert.equal(manifest.filesTruncated, false);
  assert.deepEqual(manifest.warnings, []);
  assert.deepEqual(manifest.structured.gguf, { architecture: "qwen3", context_length: 40960, total: 8190735360 });
  assert.equal(manifest.structured.safetensors, null);
  assert.equal(manifest.structured.config.model_type, "qwen3");

  assert.equal(manifest.files.length, 10);
  const byPath = new Map(manifest.files.map((file) => [file.path, file]));
  const q4 = byPath.get("Example-8B-Q4_K_M.gguf");
  assert.equal(q4.size, 5027783488);
  assert.match(q4.sha256, /^[0-9a-f]{64}$/);
  assert.equal(q4.sha256, payload.siblings.find((s) => s.rfilename === q4.path).lfs.sha256);
  assert.match(q4.gitOid, /^[0-9a-f]{40}$/);
  assert.equal(q4.lfs, true);
  const shard = byPath.get("BF16/Example-8B-BF16-00002-of-00002.gguf");
  assert.equal(shard.size, 6392923488, "shards in subdirectories keep their directory");
  const readme = byPath.get("README.md");
  assert.equal(readme.sha256, null, "a git-stored file has no sha256");
  assert.equal(readme.lfs, false);
  assert.match(readme.gitOid, /^[0-9a-f]{40}$/);
  assert.ok(manifest.files.every((file) => typeof file.path === "string" && (file.size === null || file.size >= 0)));
});

test("getRepo parses the FP8 and mixed fixtures (safetensors summary, gated, custom code)", async () => {
  const fp8 = normalizeRepoInfo(fixture("hf-fp8-generic-shards.json"), { repo: "example-org/Example-8B-FP8", fetchedFrom: "https://huggingface.co", now: FIXED_NOW });
  assert.equal(fp8.structured.safetensors.total, 8190735360);
  assert.equal(fp8.structured.safetensors.parameters.BF16, 1243136000);
  assert.equal(fp8.structured.gguf, null);
  assert.equal(fp8.baseModel, "Example-Org/Example-8B");
  assert.equal(fp8.files.filter((file) => file.path.endsWith(".safetensors")).length, 3);
  assert.equal(fp8.files.find((file) => file.path === "config.json").sha256, null);

  const mixed = normalizeRepoInfo(fixture("hf-mixed.json"), { repo: "example-org/Example-Mixed", now: FIXED_NOW });
  assert.equal(mixed.gated, true);
  assert.equal(mixed.gatedMode, "auto");
  assert.equal(mixed.pipelineTag, "image-text-to-text");
  assert.deepEqual(mixed.structured.config.auto_map, { AutoModel: "modeling_example.ExampleModel" });
  assert.ok(mixed.files.some((file) => file.path === "fp8/model-00001-of-00002.safetensors"));
  assert.equal(mixed.baseModel, null);
  assert.equal(mixed.license, "other");

  // A bare payload does not throw.
  const bare = normalizeRepoInfo({}, { repo: "a/b" });
  assert.equal(bare.revisionSha, null);
  assert.deepEqual(bare.files, []);
  assert.equal(bare.structured.config && typeof bare.structured.config, "object");
  assert.equal(normalizeRepoInfo({ sha: "not-a-sha" }).revisionSha, null);
});

test("sha256 tolerates the older lfs.oid spelling and rejects malformed digests", () => {
  const manifest = normalizeRepoInfo({
    siblings: [
      { rfilename: "a.bin", size: 5, lfs: { oid: `sha256:${"A".repeat(64)}`, size: 5 } },
      { rfilename: "b.bin", size: 5, lfs: { sha256: "tooshort", size: 5 } },
      { rfilename: "c.txt", lfs: { size: 9, sha256: "b".repeat(64) } },
      { rfilename: "" },
      { nothing: true },
    ],
  });
  assert.deepEqual(manifest.files.map((file) => [file.path, file.size, file.sha256, file.lfs]), [
    ["a.bin", 5, "a".repeat(64), true],
    ["b.bin", 5, null, true],
    ["c.txt", 9, "b".repeat(64), true],
  ]);
});

test("getRepo encodes revisions, validates ids and maps HTTP failures to hub codes", async () => {
  const fetchImpl = recordingFetch(() => json(fixture("hf-fp8-generic-shards.json")));
  const hf = provider(fetchImpl);
  await hf.getRepo("example-org/Example-8B-FP8", { revision: "refs/pr/1" });
  assert.equal(fetchImpl.calls[0].url, "https://huggingface.co/api/models/example-org/Example-8B-FP8/revision/refs%2Fpr%2F1?blobs=true");
  for (const bad of ["a/b/c", "../x", "a b/c", "", "owner/", "/name"]) {
    await assert.rejects(hf.getRepo(bad), (error) => error.code === "invalid_repo", bad);
  }
  await assert.rejects(hf.getRepo("a/b", { revision: ".." }), (error) => error.code === "invalid_revision");
  assert.equal(fetchImpl.calls.length, 1);

  const failing = (status, headers = {}) => provider(recordingFetch(() => new Response("body must not leak", { status, headers })));
  const code = async (status, headers) => {
    try {
      await failing(status, headers).getRepo("a/b");
    } catch (error) {
      assert.ok(!String(error.message).includes("body must not leak"), "the response body is never echoed");
      return error;
    }
    return null;
  };
  assert.equal((await code(404)).code, "repo_not_found");
  assert.equal((await code(401, { "x-error-code": "RepoNotFound" })).code, "repo_not_found", "HF answers 401 for a missing repo");
  assert.equal((await code(404, { "x-error-code": "RevisionNotFound" })).code, "revision_not_found");
  assert.equal((await code(403)).code, "hf_approval_required");
  assert.equal((await code(403, { "x-error-code": "GatedRepo" })).code, "hf_approval_required");
  assert.equal((await code(401)).code, "hf_auth_invalid");
  const limited = await code(429, { "retry-after": "30" });
  assert.equal(limited.code, "rate_limited");
  assert.equal(limited.networkClass, true);
  assert.equal(limited.details.retryAfterSeconds, 30);
  assert.equal((await code(503)).networkClass, true);
  const broken = await code(500);
  assert.equal(broken.code, "provider_http_error");
  assert.equal(broken.networkClass, false);
  assert.equal(broken.baseCode, "unknown");
});

test("repositories with 20k+ files are listed through the paged tree API", async () => {
  const base = fixture("hf-gguf-multiquant.json");
  const requests = [];
  const fetchImpl = recordingFetch((url) => {
    requests.push(url.pathname + url.search);
    if (url.pathname.endsWith("/revision/main")) return json({ ...base, id: "example-org/Example-Huge", siblings: huge(TREE_FALLBACK_FILES) });
    if (url.searchParams.get("cursor") === "p2") return json(fixture("hf-tree-page2.json"));
    return json(fixture("hf-tree-page1.json"), {
      headers: { link: '<https://huggingface.co/api/models/example-org/Example-Huge/tree/main?recursive=true&expand=true&cursor=p2>; rel="next"' },
    });
  });
  const manifest = await provider(fetchImpl).getRepo("example-org/Example-Huge");
  assert.deepEqual(requests, [
    "/api/models/example-org/Example-Huge/revision/main?blobs=true",
    "/api/models/example-org/Example-Huge/tree/main?recursive=true&expand=true",
    "/api/models/example-org/Example-Huge/tree/main?recursive=true&expand=true&cursor=p2",
  ]);
  assert.deepEqual(manifest.files.map((file) => file.path), [
    "shards/part-00001.safetensors",
    "shards/part-00002.safetensors",
    "config.json",
    "shards/part-00003.safetensors",
    "tokenizer.json",
  ]);
  const part = manifest.files[0];
  assert.equal(part.size, 4000000000, "the LFS size, not the pointer size");
  assert.match(part.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.files[2].sha256, null);
  assert.equal(manifest.files[2].lfs, false);
  assert.equal(manifest.filesTruncated, false);
  assert.equal(manifest.revisionSha, base.sha, "the revision info still supplies the SHA");
});

test("a failing tree listing keeps the revision listing and says it may be short", async () => {
  const base = fixture("hf-gguf-multiquant.json");
  const fetchImpl = recordingFetch((url) => (url.pathname.endsWith("/revision/main")
    ? json({ ...base, siblings: huge(TREE_FALLBACK_FILES) })
    : new Response("", { status: 500 })));
  const manifest = await provider(fetchImpl).getRepo("a/b");
  assert.equal(manifest.files.length, TREE_FALLBACK_FILES);
  assert.equal(manifest.filesTruncated, true);
  assert.equal(manifest.warnings[0].code, "file_tree_unavailable");
});

// ---------------------------------------------------------- readme

test("getReadme fetches README.md through the resolve endpoint", async () => {
  const fetchImpl = recordingFetch(() => textResponse("# Example\n\nHello"));
  const result = await provider(fetchImpl).getReadme("example-org/Example-8B-GGUF", { revision: "abc123" });
  assert.equal(fetchImpl.calls[0].url, "https://huggingface.co/example-org/Example-8B-GGUF/resolve/abc123/README.md");
  assert.equal(result.markdown, "# Example\n\nHello");
  assert.equal(result.truncated, false);
  assert.equal(result.fetchedFrom, "https://huggingface.co");
});

test("getReadme stops reading at the 512 KiB cap and flags truncation", async () => {
  const chunk = Buffer.alloc(64 * 1024, "a");
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (pulled >= 64) return controller.close();
      pulled += 1;
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await provider(recordingFetch(() => new Response(body, { status: 200 }))).getReadme("a/b");
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.markdown), 512 * 1024);
  assert.ok(pulled <= 10, `read ${pulled} chunks of a 4 MiB body`);
  assert.equal(cancelled, true, "the rest of the body is abandoned");
});

test("getReadme caps a custom size without cutting a character in half, and handles bodies that cannot stream", async () => {
  const text = "你好".repeat(200);
  const cut = await provider(recordingFetch(() => textResponse(text))).getReadme("a/b", { maxBytes: 100 });
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(cut.markdown) <= 100);
  assert.ok(!cut.markdown.includes("�"));
  assert.ok(text.startsWith(cut.markdown));

  const noStream = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => Buffer.from("x".repeat(300)).buffer,
  };
  const proxied = await provider(recordingFetch(() => noStream)).getReadme("a/b", { maxBytes: 100 });
  assert.equal(proxied.markdown.length, 100);
  assert.equal(proxied.truncated, true);
  const small = await provider(recordingFetch(() => textResponse("short"))).getReadme("a/b", { maxBytes: 1000 });
  assert.equal(small.truncated, false);
});

test("a repository without a README is not a failure; a missing repository is", async () => {
  const none = await provider(recordingFetch(() => new Response("", { status: 404, headers: { "x-error-code": "EntryNotFound" } }))).getReadme("a/b");
  assert.deepEqual([none.markdown, none.truncated, none.missing], ["", false, true]);
  const bare404 = await provider(recordingFetch(() => new Response("", { status: 404 }))).getReadme("a/b");
  assert.equal(bare404.missing, true);
  await assert.rejects(
    provider(recordingFetch(() => new Response("", { status: 401, headers: { "x-error-code": "RepoNotFound" } }))).getReadme("a/b"),
    (error) => error.code === "repo_not_found",
  );
});

test("fileUrl encodes each segment and refuses traversal", () => {
  const hf = provider(recordingFetch(() => json({})));
  assert.equal(hf.fileUrl("a/b", "dir/My File [1].gguf", "main"), "https://huggingface.co/a/b/resolve/main/dir/My%20File%20%5B1%5D.gguf");
  assert.equal(hf.fileUrl("a/b", "x.bin", "refs/pr/2"), "https://huggingface.co/a/b/resolve/refs%2Fpr%2F2/x.bin");
  for (const bad of ["../x", "a/../b", "/abs", "a//b", "", "a\\b"]) {
    assert.throws(() => hf.fileUrl("a/b", bad), (error) => error.code === "unsafe_path", bad);
  }
  assert.throws(() => hf.fileUrl("../b", "x"), (error) => error.code === "invalid_repo");
});

// ------------------------------------------- credentials per provider

test("the Hugging Face provider sends its token to huggingface.co only", async () => {
  const fetchImpl = recordingFetch(() => json([]));
  const hf = provider(fetchImpl, { getToken: () => FAKE_TOKEN });
  assert.equal(hf.sendsCredentials, true);
  await hf.search({ q: "x" });
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${FAKE_TOKEN}`);

  // The fetch handed to 02 carries the same guard: the token only goes to HF hosts.
  await hf.fetchImpl("https://huggingface.co/a/b/resolve/main/x.gguf", { headers: { range: "bytes=0-1023" } });
  await hf.fetchImpl("https://cas-bridge.xethub.hf.co/blob", { headers: { range: "bytes=0-1023" } });
  assert.equal(fetchImpl.calls[1].headers.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(fetchImpl.calls[1].headers.range, "bytes=0-1023");
  assert.equal(fetchImpl.calls[2].headers.authorization, undefined);
  // A token passed by the caller is ignored; the provider owns it.
  await hf.fetchImpl("https://cas-bridge.xethub.hf.co/blob", { token: "caller-token" });
  assert.equal(fetchImpl.calls[3].headers.authorization, undefined);
  // A hand-written header for another host is refused.
  await assert.rejects(hf.fetchImpl("https://cas-bridge.xethub.hf.co/blob", { headers: { authorization: "Bearer x" } }), (error) => error.code === "credential_host_violation");
});

test("a Hugging Face provider pointed at a non-HF endpoint never sends the token", async () => {
  const fetchImpl = recordingFetch(() => json([]));
  const hf = provider(fetchImpl, { endpoint: "https://hf-proxy.example/base/", getToken: () => FAKE_TOKEN });
  assert.equal(hf.sendsCredentials, false);
  assert.equal(hf.apiBase, "https://hf-proxy.example/base");
  await hf.search({ q: "x" });
  assert.equal(fetchImpl.calls[0].url.startsWith("https://hf-proxy.example/base/api/models?"), true);
  assert.equal(fetchImpl.calls[0].headers.authorization, undefined);
});

test("credential_host_violation: the hf-mirror provider refuses every credential", async () => {
  const fetchImpl = recordingFetch((url) => (url.pathname === "/api/models" ? json([]) : json(fixture("hf-fp8-generic-shards.json"))));
  const mirror = createHfMirrorProvider({ fetchImpl, clock: fakeClock() });
  assert.equal(mirror.id, "hf-mirror");
  assert.equal(mirror.namespace, "huggingface");
  assert.equal(mirror.sendsCredentials, false);
  assert.equal(mirror.apiBase, "https://hf-mirror.com");

  await mirror.search({ q: "x" });
  await mirror.getRepo("example-org/Example-8B-FP8");
  assert.ok(fetchImpl.calls.length >= 2);
  assert.ok(fetchImpl.calls.every((call) => call.url.startsWith("https://hf-mirror.com/") && call.headers.authorization === undefined));

  const before = fetchImpl.calls.length;
  await assert.rejects(mirror.fetchImpl("https://hf-mirror.com/x", { token: FAKE_TOKEN }), (error) => error.code === "credential_host_violation");
  await assert.rejects(mirror.fetchImpl("https://hf-mirror.com/x", { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }), (error) => error.code === "credential_host_violation");
  await assert.rejects(mirror.fetchImpl("https://huggingface.co/x", { headers: new Headers({ authorization: "Bearer x" }) }), (error) => error.code === "credential_host_violation");
  assert.equal(fetchImpl.calls.length, before, "the refused calls sent nothing");
  await mirror.fetchImpl("https://hf-mirror.com/a/b/resolve/main/x", { headers: { range: "bytes=0-9" } });
  assert.equal(fetchImpl.calls.at(-1).headers.authorization, undefined);
});

// ---------------------------------------------------------- ModelScope

function msProvider(fetchImpl, extra = {}) {
  return createModelScopeProvider({ fetchImpl, clock: fakeClock(), ...extra });
}

const MS_REVISION = "3f2c9d1e5a7b4c8d9e0f1a2b3c4d5e6f7a8b9c0d";

test("modelscope: search PUTs the dolphin body, normalises items and pages by PageNumber", async () => {
  const pages = [fixture("modelscope-search-page1.json"), fixture("modelscope-search-page2.json")];
  const fetchImpl = recordingFetch((url, init) => json(pages[JSON.parse(init.body).PageNumber - 1]));
  const ms = msProvider(fetchImpl);
  assert.equal(ms.id, "modelscope");
  assert.equal(ms.namespace, "modelscope");
  assert.equal(ms.sendsCredentials, false);

  const first = await ms.search({ q: "Qwen3 GGUF", sort: "downloads", limit: 3 });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, "https://www.modelscope.cn/api/v1/dolphin/models");
  assert.equal(call.method, "PUT");
  assert.equal(call.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(call.body), { PageSize: 3, PageNumber: 1, SortBy: "DownloadsCount", Name: "Qwen3 GGUF", Criterion: [], SingleCriterion: [], Target: "" });
  assert.deepEqual(first.items.map((item) => item.repo), ["example-org/Example-Qwen3-8B-GGUF", "example-org/Example-Vision-7B", "other-org/Example-Base-1B"]);
  assert.equal(first.nextCursor, null, "three of three: no next page");

  const [gguf, vision, base] = first.items;
  assert.equal(gguf.namespace, "modelscope");
  assert.equal(gguf.author, "example-org");
  assert.equal(gguf.pipelineTag, "text-generation");
  assert.equal(gguf.library, "gguf");
  assert.deepEqual(gguf.tags, ["text-generation", "gguf", "qwen3"]);
  assert.equal(gguf.downloads, 12034);
  assert.equal(gguf.likes, 57);
  assert.equal(gguf.lastModified, new Date(1788000000 * 1000).toISOString());
  assert.equal(gguf.createdAt, new Date(1787000000000).toISOString());
  assert.equal(gguf.license, "Apache License 2.0");
  assert.equal(gguf.gated, false);
  assert.equal(vision.downloads, 900, "DownloadsCount alias");
  assert.equal(vision.likes, 3);
  assert.equal(vision.pipelineTag, "image-text-to-text");
  assert.equal(base.downloads, 15, "numeric strings parse");
  assert.equal(base.likes, null);

  // A page size below the total gives a page-number cursor.
  const paged = await ms.search({ q: "Qwen3 GGUF", sort: "downloads", limit: 2 });
  assert.equal(paged.nextCursor, "2");
  const second = await ms.search({ q: "Qwen3 GGUF", sort: "downloads", limit: 2, cursor: paged.nextCursor });
  assert.equal(JSON.parse(fetchImpl.calls.at(-1).body).PageNumber, 2);
  assert.deepEqual(second.items.map((item) => item.repo), ["example-org/Example-Last"]);
  assert.equal(second.nextCursor, null);
});

test("modelscope: sort and cursor are validated, and search tolerates a legacy list location", async () => {
  const fetchImpl = recordingFetch(() => json({ Data: { Models: [{ Path: "o", Name: "m" }, { Name: "no-owner" }, null] } }));
  const ms = msProvider(fetchImpl);
  assert.deepEqual((await ms.search({})).items.map((item) => item.repo), ["o/m"]);
  assert.equal(JSON.parse(fetchImpl.calls[0].body).SortBy, "Default");
  assert.equal(JSON.parse(fetchImpl.calls[0].body).PageSize, 24);
  await ms.search({ sort: "likes", limit: 500 });
  assert.equal(JSON.parse(fetchImpl.calls.at(-1).body).SortBy, "StarsCount");
  assert.equal(JSON.parse(fetchImpl.calls.at(-1).body).PageSize, 100);
  const before = fetchImpl.calls.length;
  await assert.rejects(ms.search({ sort: "bogus" }), (error) => error.code === "invalid_query");
  for (const cursor of ["0", "-1", "abc", "https://evil.example/x", "99999"]) {
    await assert.rejects(ms.search({ cursor }), (error) => error.code === "invalid_cursor", cursor);
  }
  assert.equal(fetchImpl.calls.length, before, "invalid input sends nothing");
  await assert.rejects(msProvider(recordingFetch(() => json({ nope: true }))).search({}), (error) => error.code === "provider_bad_response");
});

test("modelscope: the manifest normalises Files[] with sizes and sha256, skipping directories", async () => {
  const fetchImpl = recordingFetch(() => json(fixture("modelscope-files.json")));
  const ms = msProvider(fetchImpl);
  const manifest = await ms.getRepo("example-org/Example-Qwen3-8B-GGUF", { revision: MS_REVISION });
  assert.equal(fetchImpl.calls[0].url, `https://www.modelscope.cn/api/v1/models/example-org/Example-Qwen3-8B-GGUF/repo/files?Revision=${MS_REVISION}&Recursive=true`);
  assert.equal(fetchImpl.calls[0].headers.authorization, undefined);
  assert.equal(manifest.namespace, "modelscope");
  assert.equal(manifest.repo, "example-org/Example-Qwen3-8B-GGUF");
  assert.equal(manifest.revision, MS_REVISION);
  assert.equal(manifest.revisionSha, MS_REVISION);
  assert.equal(manifest.gated, false);
  assert.equal(manifest.filesTruncated, false);
  assert.equal(manifest.fetchedFrom, "https://www.modelscope.cn");
  assert.equal(manifest.fetchedAt, new Date(FIXED_NOW).toISOString());
  assert.deepEqual(manifest.files.map((file) => file.path), [
    "README.md",
    "config.json",
    "Q4_K_M/Example-Qwen3-8B-Q4_K_M-00001-of-00002.gguf",
    "Q4_K_M/Example-Qwen3-8B-Q4_K_M-00002-of-00002.gguf",
    "tokenizer.json",
  ]);
  const byPath = Object.fromEntries(manifest.files.map((file) => [file.path, file]));
  assert.deepEqual(byPath["README.md"], { path: "README.md", size: 2048, sha256: "a".repeat(64), gitOid: null, lfs: false });
  assert.equal(byPath["config.json"].sha256, "b".repeat(64), "upper case is lowered");
  assert.equal(byPath["Q4_K_M/Example-Qwen3-8B-Q4_K_M-00001-of-00002.gguf"].size, 3000000000);
  assert.equal(byPath["Q4_K_M/Example-Qwen3-8B-Q4_K_M-00001-of-00002.gguf"].lfs, true);
  assert.equal(byPath["Q4_K_M/Example-Qwen3-8B-Q4_K_M-00002-of-00002.gguf"].sha256, "d".repeat(64), "sha256: prefix is stripped");
  assert.equal(byPath["tokenizer.json"].size, 7031645, "numeric string sizes parse");
  assert.equal(byPath["tokenizer.json"].sha256, null, "a malformed hash is dropped, not trusted");
});

test("modelscope: a missing Revision gives revisionSha null; a malformed one is ignored", async () => {
  const fetchImpl = recordingFetch(() => json(fixture("modelscope-files-no-revision.json")));
  const ms = msProvider(fetchImpl);
  const manifest = await ms.getRepo("example-org/Example-Qwen3-8B-GGUF");
  assert.equal(manifest.revision, "master");
  assert.equal(manifest.revisionSha, null);
  assert.equal(manifest.files.length, 5);
  assert.match(fetchImpl.calls[0].url, /Revision=master&Recursive=true$/);

  // Without a full-SHA request, the first well-formed Files[].Revision wins.
  const mixed = fixture("modelscope-files.json");
  mixed.Data.Files[0].Revision = "abc123";
  const viaFiles = await msProvider(recordingFetch(() => json(mixed))).getRepo("example-org/Example-Qwen3-8B-GGUF", { revision: "master" });
  assert.equal(viaFiles.revisionSha, MS_REVISION);

  const empty = await msProvider(recordingFetch(() => json({ Data: { Files: [] } }))).getRepo("a/b");
  assert.deepEqual(empty.files, []);
  assert.equal(empty.revisionSha, null);
});

test("modelscope: private, gated and missing repositories are repo_not_found with a ModelScope detail", async () => {
  for (const status of [401, 403, 404]) {
    const ms = msProvider(recordingFetch(() => json({ Code: status, Success: false, Message: "no" }, { status })));
    await assert.rejects(ms.getRepo("a/b"), (error) => {
      assert.equal(error.code, "repo_not_found", String(status));
      assert.equal(error.status, status);
      assert.equal(error.details.provider, "modelscope");
      assert.equal(error.details.publicOnly, true);
      assert.ok(error.details.hint.zh && error.details.hint.en);
      return true;
    });
  }
  // Failures carried in a 200 envelope.
  const envelope = msProvider(recordingFetch(() => json({ Code: 10010204004, Success: false, Message: "The model does not exist." })));
  await assert.rejects(envelope.getRepo("a/b"), (error) => error.code === "repo_not_found" && error.details.provider === "modelscope");
  const other = msProvider(recordingFetch(() => json({ Code: 500, Success: false, Message: "boom" })));
  await assert.rejects(other.getRepo("a/b"), (error) => error.code === "provider_http_error" && error.retryable === true && !error.networkClass);
  // Server trouble stays network class so callers may retry.
  await assert.rejects(msProvider(recordingFetch(() => json({}, { status: 503 }))).getRepo("a/b"), (error) => error.code === "provider_http_error" && error.networkClass === true);
  await assert.rejects(msProvider(recordingFetch(() => { throw networkFailure(); })).getRepo("a/b"), (error) => error.code === "provider_unreachable" && error.networkClass === true);
  // Bad input never reaches the network.
  const fetchImpl = recordingFetch(() => json({}));
  const ms = msProvider(fetchImpl);
  for (const repo of ["", "single", "a/b/c", "../x/y", "a/b c"]) await assert.rejects(ms.getRepo(repo), (error) => error.code === "invalid_repo", repo);
  await assert.rejects(ms.getRepo("a/b", { revision: ".." }), (error) => error.code === "invalid_revision");
  assert.equal(fetchImpl.calls.length, 0);
});

test("modelscope: README and fileUrl use the repo endpoint; a missing README is not a failure", async () => {
  const fetchImpl = recordingFetch((url) => (url.searchParams.get("FilePath") === "README.md" ? textResponse("# Example\n") : json({}, { status: 404 })));
  const ms = msProvider(fetchImpl);
  const readme = await ms.getReadme("example-org/Example-Qwen3-8B-GGUF");
  assert.deepEqual({ markdown: readme.markdown, truncated: readme.truncated, missing: readme.missing }, { markdown: "# Example\n", truncated: false, missing: false });
  assert.equal(fetchImpl.calls[0].url, "https://www.modelscope.cn/api/v1/models/example-org/Example-Qwen3-8B-GGUF/repo?Revision=master&FilePath=README.md");

  const capped = await ms.getReadme("example-org/Example-Qwen3-8B-GGUF", { maxBytes: 4 });
  assert.equal(capped.truncated, true);

  const missing = await msProvider(recordingFetch(() => json({}, { status: 404 }))).getReadme("a/b");
  assert.equal(missing.missing, true);
  const envelope = await msProvider(recordingFetch(() => textResponse(JSON.stringify({ Code: 404, Success: false, Message: "file not found" })))).getReadme("a/b");
  assert.equal(envelope.missing, true);

  assert.equal(ms.fileUrl("a/b", "dir/m odel.gguf", MS_REVISION), `https://www.modelscope.cn/api/v1/models/a/b/repo?Revision=${MS_REVISION}&FilePath=dir%2Fm%20odel.gguf`);
  assert.throws(() => ms.fileUrl("a/b", "../x"), (error) => error.code === "unsafe_path");
  assert.throws(() => ms.fileUrl("a/b", "a//b"), (error) => error.code === "unsafe_path");
});

test("modelscope: no credential is ever sent, and the handed-out fetch refuses one", async () => {
  const fetchImpl = recordingFetch((url) => (url.pathname.endsWith("/files") ? json(fixture("modelscope-files.json")) : json({ Data: { Models: [] } })));
  const ms = msProvider(fetchImpl);
  await ms.search({ q: "x" });
  await ms.getRepo("a/b");
  assert.ok(fetchImpl.calls.every((call) => call.headers.authorization === undefined));
  const before = fetchImpl.calls.length;
  await assert.rejects(ms.fetchImpl("https://www.modelscope.cn/x", { token: FAKE_TOKEN }), (error) => error.code === "credential_host_violation");
  await assert.rejects(ms.fetchImpl("https://www.modelscope.cn/x", { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }), (error) => error.code === "credential_host_violation");
  assert.equal(fetchImpl.calls.length, before);
  await ms.fetchImpl("https://www.modelscope.cn/x", { headers: { range: "bytes=0-9" } });
  assert.equal(fetchImpl.calls.at(-1).headers.range, "bytes=0-9");
});

test("modelscope: searches and manifests are cached on their own TTLs", async () => {
  const clock = fakeClock();
  const cache = {
    search: createSingleFlightCache({ ttlMs: 90 * 1000, now: () => clock.now() }),
    manifest: createSingleFlightCache({ ttlMs: 5 * 60 * 1000, now: () => clock.now() }),
    readme: createSingleFlightCache({ ttlMs: 30 * 60 * 1000, now: () => clock.now() }),
  };
  const fetchImpl = recordingFetch((url) => (url.pathname.endsWith("/files") ? json(fixture("modelscope-files.json")) : json(fixture("modelscope-search-page1.json"))));
  const ms = msProvider(fetchImpl, { cache, clock });
  const [a, b] = await Promise.all([ms.getRepo("a/b"), ms.getRepo("a/b")]);
  a.files.length = 0;
  assert.equal(b.files.length, 5, "callers get clones");
  await ms.getRepo("a/b");
  await ms.getRepo("a/b", { revision: "dev" });
  await ms.search({ q: "x" });
  await ms.search({ q: "x" });
  assert.equal(fetchImpl.calls.length, 3);
  clock.advance(91 * 1000);
  await ms.search({ q: "x" });
  await ms.getRepo("a/b");
  assert.equal(fetchImpl.calls.length, 4, "search expired at 90 s, the manifest has not");
  clock.advance(5 * 60 * 1000);
  await ms.getRepo("a/b");
  assert.equal(fetchImpl.calls.length, 5);
  await ms.getRepo("a/b", { force: true });
  assert.equal(fetchImpl.calls.length, 6);
});

test("modelscope: the CLI environment reuses the proxy-strip and direct-DNS helper", () => {
  const env = buildModelScopeCliEnv(path.join("cache-root", "hf"), { HTTPS_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1", ALL_PROXY: "x", KEEP: "1" });
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) assert.equal(env[key], undefined, key);
  assert.equal(env.NO_PROXY, "*");
  assert.equal(env.no_proxy, "*");
  assert.equal(env.MODELSCOPE_DIRECT_DNS, "1");
  assert.ok(env.MODELSCOPE_DIRECT_DNS_SERVERS);
  assert.ok(env.PYTHONPATH.split(path.delimiter).some((entry) => /python-direct-dns$/.test(entry)));
  assert.equal(env.MODELSCOPE_CACHE, path.join("cache-root", "hf", "modelscope"));
  assert.equal(env.KEEP, "1");
});

// ------------------------------------------------ transport failures

test("transport failures become network-class ProviderErrors; a caller abort stays an abort", async () => {
  const unreachable = provider(recordingFetch(() => { throw networkFailure(); }));
  await assert.rejects(unreachable.getRepo("a/b"), (error) => {
    assert.equal(error.code, "provider_unreachable");
    assert.equal(error.baseCode, "network_unreachable");
    assert.equal(error.networkClass, true);
    assert.equal(error.details.errno, "ECONNRESET");
    return true;
  });

  const hanging = provider(recordingFetch((url, init) => hangUntilAborted(init)), { timeoutMs: 25 });
  await assert.rejects(hanging.getRepo("a/b"), (error) => error.code === "provider_timeout" && error.networkClass === true);

  const controller = new AbortController();
  const waiting = provider(recordingFetch((url, init) => hangUntilAborted(init)), { timeoutMs: 5000 });
  const pending = waiting.getRepo("a/b", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError" && !(error instanceof ProviderError));
});

// ---------------------------------------------------- mirror fallback

function providersFor(fetchImpl, extra = {}) {
  return createProviders({
    settings: { get: () => ({ sources: { policy: "huggingface", hfEndpoint: "https://huggingface.co", mirrorEndpoint: "https://hf-mirror.com", modelScopeEndpoint: "https://www.modelscope.cn" } }) },
    fetchImpl,
    getHfToken: () => FAKE_TOKEN,
    clock: fakeClock(),
    ...extra,
  });
}

test("mirror fallback: an unreachable official API is retried once on the mirror, without credentials, with a warning", async () => {
  const fetchImpl = recordingFetch((url) => {
    if (url.hostname === "huggingface.co") throw networkFailure();
    if (url.pathname === "/api/models") return json(fixture("hf-search-page2.json"), { headers: { link: '<https://hf-mirror.com/api/models?cursor=m2>; rel="next"' } });
    if (url.pathname.endsWith("/README.md")) return textResponse("# From the mirror");
    return json(fixture("hf-fp8-generic-shards.json"));
  });
  const namespace = providersFor(fetchImpl).forNamespace("huggingface");

  const manifest = await namespace.getRepo("example-org/Example-8B-FP8");
  assert.equal(manifest.fetchedFrom, "https://hf-mirror.com");
  assert.equal(manifest.warnings.length, 1);
  assert.equal(manifest.warnings[0].code, MIRROR_FALLBACK_CODE);
  assert.equal(manifest.warnings[0].from, "https://huggingface.co");
  assert.equal(manifest.warnings[0].to, "https://hf-mirror.com");
  assert.match(manifest.warnings[0].message.zh, /镜像/);
  assert.match(manifest.warnings[0].message.en, /mirror/i);
  assert.match(manifest.warnings[0].detail, /provider_unreachable/);
  assert.match(manifest.revisionSha, /^[0-9a-f]{40}$/);

  const search = await namespace.search({ q: "another" });
  assert.equal(search.fetchedFrom, "https://hf-mirror.com");
  assert.equal(search.warnings[0].code, MIRROR_FALLBACK_CODE);
  assert.equal(search.nextCursor, "/api/models?cursor=m2");
  assert.equal(search.items.length, 2);

  const readme = await namespace.getReadme("example-org/Example-8B-FP8");
  assert.equal(readme.markdown, "# From the mirror");
  assert.equal(readme.fetchedFrom, "https://hf-mirror.com");
  assert.equal(readme.warnings[0].code, MIRROR_FALLBACK_CODE);

  const official = fetchImpl.calls.filter((call) => call.url.startsWith("https://huggingface.co/"));
  const mirrored = fetchImpl.calls.filter((call) => call.url.startsWith("https://hf-mirror.com/"));
  assert.equal(official.length, 3, "each operation tried the official API once");
  assert.equal(mirrored.length, 3, "and the mirror once");
  assert.ok(official.every((call) => call.headers.authorization === `Bearer ${FAKE_TOKEN}`));
  assert.ok(mirrored.every((call) => call.headers.authorization === undefined), "the mirror never sees the token");
});

test("mirror fallback: timeouts and 5xx/429 fall back, other failures and aborts do not", async () => {
  const mirrorOk = (status) => recordingFetch((url) => {
    if (url.hostname === "huggingface.co") return new Response("", { status });
    return json(fixture("hf-fp8-generic-shards.json"));
  });
  for (const status of [429, 502, 503, 504]) {
    const fetchImpl = mirrorOk(status);
    const manifest = await providersFor(fetchImpl).forNamespace("huggingface").getRepo("a/b");
    assert.equal(manifest.fetchedFrom, "https://hf-mirror.com", `HTTP ${status}`);
  }
  for (const status of [401, 403, 404, 500]) {
    const fetchImpl = mirrorOk(status);
    await assert.rejects(providersFor(fetchImpl).forNamespace("huggingface").getRepo("a/b"), (error) => error instanceof ProviderError && error.status === status, `HTTP ${status}`);
    assert.ok(fetchImpl.calls.every((call) => call.url.startsWith("https://huggingface.co/")), `HTTP ${status} never reaches the mirror`);
  }

  const slow = recordingFetch((url, init) => {
    if (url.hostname !== "huggingface.co") return json(fixture("hf-fp8-generic-shards.json"));
    return hangUntilAborted(init);
  });
  const viaTimeout = await providersFor(slow, { timeoutMs: 25 }).forNamespace("huggingface").getRepo("a/b");
  assert.equal(viaTimeout.warnings[0].code, MIRROR_FALLBACK_CODE);

  const controller = new AbortController();
  const hung = recordingFetch((url, init) => hangUntilAborted(init));
  const pending = providersFor(hung).forNamespace("huggingface").getRepo("a/b", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.ok(hung.calls.every((call) => call.url.startsWith("https://huggingface.co/")), "an abort does not start a mirror request");
});

test("mirror fallback: when the mirror fails too the original error is thrown, with the mirror's outcome", async () => {
  const fetchImpl = recordingFetch((url) => {
    if (url.hostname === "huggingface.co") throw networkFailure();
    return new Response("", { status: 404 });
  });
  await assert.rejects(providersFor(fetchImpl).forNamespace("huggingface").getRepo("a/b"), (error) => {
    assert.equal(error.code, "provider_unreachable");
    assert.deepEqual(error.details.fallback, { code: "repo_not_found", status: 404 });
    return true;
  });
});

test("the sources policy decides the transport: hf-mirror policy uses the mirror alone, with no credentials", async () => {
  const fetchImpl = recordingFetch((url) => (url.pathname === "/api/models" ? json([]) : json(fixture("hf-fp8-generic-shards.json"))));
  const policy = { value: "hf-mirror" };
  const providers = createProviders({
    settings: () => ({ sources: { policy: policy.value, hfEndpoint: "https://huggingface.co", mirrorEndpoint: "https://hf-mirror.com" } }),
    fetchImpl,
    getHfToken: () => FAKE_TOKEN,
    clock: fakeClock(),
  });
  const mirrorOnly = providers.forNamespace("huggingface");
  assert.equal(mirrorOnly.id, "hf-mirror");
  const manifest = await mirrorOnly.getRepo("a/b");
  assert.equal(manifest.fetchedFrom, "https://hf-mirror.com");
  assert.deepEqual(manifest.warnings, []);
  assert.ok(fetchImpl.calls.every((call) => call.url.startsWith("https://hf-mirror.com/") && call.headers.authorization === undefined));

  // The policy is read per call, and an explicit policy overrides the setting.
  policy.value = "huggingface";
  assert.equal(providers.forNamespace("huggingface").id, "huggingface");
  assert.equal(providers.forNamespace("huggingface", "hf-mirror").id, "hf-mirror");
  policy.value = "auto";
  assert.equal(providers.forNamespace("huggingface").id, "huggingface");
  assert.equal(providers.forNamespace("huggingface").fallback.id, "hf-mirror");
});

test("createProviders: endpoints follow the settings, unknown and unavailable providers are reported", () => {
  const settings = { sources: { policy: "huggingface", hfEndpoint: "https://huggingface.co", mirrorEndpoint: "https://hf-mirror.com" } };
  const providers = createProviders({ settings: { get: () => settings }, fetchImpl: recordingFetch(() => json({})), clock: fakeClock() });
  assert.equal(providers.get("huggingface").apiBase, "https://huggingface.co");
  assert.equal(providers.get("huggingface"), providers.get("huggingface"), "instances are reused");
  assert.equal(providers.get("hf-mirror").apiBase, "https://hf-mirror.com");
  settings.sources.mirrorEndpoint = "https://mirror.example/hf";
  assert.equal(providers.get("hf-mirror").apiBase, "https://mirror.example/hf");
  assert.equal(providers.get("modelscope").apiBase, "https://www.modelscope.cn");
  assert.equal(providers.forNamespace("modelscope").id, "modelscope");
  settings.sources.modelScopeEndpoint = "https://ms.example";
  assert.equal(providers.get("modelscope").apiBase, "https://ms.example");
  assert.throws(() => providers.get("nope"), (error) => error.code === "unknown_provider");
  assert.throws(() => providers.forNamespace("nope"), (error) => error.code === "unknown_provider");
  assert.deepEqual([...providers.ids], ["huggingface", "hf-mirror", "modelscope"]);

  // Defaults apply when the settings are empty.
  const defaults = createProviders({ settings: {}, fetchImpl: recordingFetch(() => json({})) });
  assert.equal(defaults.get("huggingface").apiBase, "https://huggingface.co");
  assert.equal(defaults.get("hf-mirror").apiBase, "https://hf-mirror.com");
  assert.throws(() => createProviders({ settings: { get: async () => ({}) }, fetchImpl: recordingFetch(() => json({})) }).get("huggingface"), TypeError);
});

// -------------------------------------------------------------- cache

test("responses are cached per call and per credential state, with TTLs from the clock", async () => {
  let token = "";
  const clock = fakeClock();
  const fetchImpl = recordingFetch(() => json(fixture("hf-fp8-generic-shards.json")));
  const providers = providersFor(fetchImpl, { clock, getHfToken: () => token });
  const hf = providers.get("huggingface");

  const first = await hf.getRepo("a/b");
  await hf.getRepo("a/b");
  assert.equal(fetchImpl.calls.length, 1, "a repeated call is served from the cache");
  first.files.length = 0;
  first.tags.push("tampered");
  const again = await hf.getRepo("a/b");
  assert.ok(again.files.length > 0 && !again.tags.includes("tampered"), "callers get their own copy");
  assert.equal(fetchImpl.calls.length, 1);

  await hf.getRepo("a/b", { revision: "dev" });
  assert.equal(fetchImpl.calls.length, 2, "another revision is another entry");

  token = FAKE_TOKEN;
  await hf.getRepo("a/b");
  assert.equal(fetchImpl.calls.length, 3, "a credentialed answer is never served to an anonymous caller or the reverse");
  await hf.getRepo("a/b");
  assert.equal(fetchImpl.calls.length, 3);

  clock.advance(5 * 60 * 1000 + 1);
  await hf.getRepo("a/b");
  assert.equal(fetchImpl.calls.length, 4, "the manifest expires after 5 minutes");
});

test("search, manifest and readme use their own TTLs and the token is never part of a cache key", async () => {
  const clock = fakeClock();
  const keys = [];
  const makeCache = (ttlMs) => {
    const inner = createSingleFlightCache({ ttlMs, now: () => clock.now() });
    return { get: (key, loader, options) => { keys.push(key); return inner.get(key, loader, options); } };
  };
  const fetchImpl = recordingFetch((url) => {
    if (url.pathname === "/api/models") return json([]);
    if (url.pathname.endsWith("/README.md")) return textResponse("# r");
    return json(fixture("hf-fp8-generic-shards.json"));
  });
  const cache = { search: makeCache(90_000), manifest: makeCache(300_000), readme: makeCache(1_800_000) };
  const hf = createProviders({
    settings: {},
    fetchImpl,
    getHfToken: () => FAKE_TOKEN,
    cache,
    clock,
  }).get("huggingface");
  await hf.search({ q: "x" });
  await hf.getRepo("a/b");
  await hf.getReadme("a/b");
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(keys.every((key) => !key.includes(FAKE_TOKEN)), keys.join("\n"));
  assert.ok(keys.every((key) => key.includes("cred:true")));

  clock.advance(91_000);
  await hf.search({ q: "x" });
  await hf.getRepo("a/b");
  await hf.getReadme("a/b");
  assert.equal(fetchImpl.calls.length, 4, "only the search entry (90 s) had expired");
  clock.advance(5 * 60 * 1000);
  await hf.getRepo("a/b");
  await hf.getReadme("a/b");
  assert.equal(fetchImpl.calls.length, 5, "the manifest (5 min) expired, the readme (30 min) did not");

  const uncached = createProviders({ settings: {}, fetchImpl, cache: null, clock }).get("huggingface");
  const before = fetchImpl.calls.length;
  await uncached.getRepo("a/b");
  await uncached.getRepo("a/b");
  assert.equal(fetchImpl.calls.length, before + 2);
});

// ------------------------------------------------------------ hygiene

test("the provider fixtures hold no paths, e-mail addresses or tokens", () => {
  const files = fs.readdirSync(FIXTURES).filter((name) => /^(?:hf|modelscope)-.*\.json$/.test(name));
  assert.ok(files.length >= 11, files.join(", "));
  const patterns = [
    { id: "drive path", pattern: /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/ },
    { id: "user path", pattern: /[\\/]Users[\\/]|\/home\//i },
    { id: "e-mail", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
    { id: "token", pattern: /\bhf_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN/i },
  ];
  for (const name of files) {
    const body = fs.readFileSync(path.join(FIXTURES, name), "utf8");
    JSON.parse(body);
    for (const { id, pattern } of patterns) assert.ok(!pattern.test(body), `${name}: ${id}`);
  }
});

test("providers read no environment, keep no secret store and define no redactor", () => {
  for (const name of fs.readdirSync(PROVIDERS_DIR).filter((file) => file.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(PROVIDERS_DIR, name), "utf8");
    assert.ok(!/process\.env/.test(source), `${name} reads process.env`);
    assert.ok(!/function\s+redact/.test(source), `${name} defines a redactor`);
    assert.ok(!/hub-secrets|runtime-secret-store|secret-store/.test(source), `${name} touches a secret store`);
    assert.ok(!/console\.(log|warn|error)/.test(source), `${name} logs`);
  }
});
