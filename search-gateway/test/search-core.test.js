const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canonicalizeUrl,
  classifySource,
  classifyQuality,
  createSearchCoordinator,
  queryTokens,
  rankAndSelectResults,
  selectSourceDiverse,
} = require("../search-core");

function config(overrides = {}) {
  return {
    searchBackendUrl: "http://searxng.test",
    searchTimeoutMs: 1000,
    maxResults: 8,
    searchDefaultEngines: ["searchtoday"],
    searchChineseEngines: [],
    searchFallbackEngines: ["yandex"],
    searchBlockedDomains: ["ai.so.com"],
    searchMinRelevance: 0.16,
    searchMaxConcurrent: 2,
    searchCacheTtlMs: 600000,
    searchNegativeCacheTtlMs: 60000,
    searchSessionTtlMs: 900000,
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("canonical URLs remove tracking, fragments, default ports, and duplicate slashes", () => {
  assert.equal(
    canonicalizeUrl("https://Example.com:443/a//b/?utm_source=x&b=2&a=1#section"),
    "https://example.com/a/b?a=1&b=2",
  );
});

test("Chinese relevance tokens use useful grams instead of overweighting one long phrase", () => {
  const tokens = queryTokens("中国经济青年失业率");
  assert.equal(tokens.includes("中国经济青年失业率"), false);
  assert.equal(tokens.includes("中国"), true);
  assert.equal(tokens.includes("经济"), true);
  assert.equal(tokens.includes("失业"), true);
});

test("quoted phrases suppress candidates that only share generic words", () => {
  const ranked = rankAndSelectResults('"两个历史" 论争 2025 2026 中国史观 官方定调', [{
    title: "2024 历史学名单",
    url: "https://noise.example/history",
    content: "中国历史研究资料与名单",
    engines: ["searchtoday"],
  }, {
    title: "两个历史论争的官方定调",
    url: "https://source.example/two-histories",
    content: "2025 2026 中国史观争论的完整时间线",
    engines: ["privacywall"],
  }], {
    maxResults: 8,
    maxPerDomain: 2,
    preferredDomains: [],
    includeDomains: [],
    excludeDomains: [],
    minRelevance: 0.16,
  });
  assert.equal(ranked.results.length, 1);
  assert.equal(ranked.results[0].domain, "source.example");
});

test("quality stays weak when only one result is convincingly relevant", () => {
  const weak = [0.381, 0.285, 0.274, 0.267].map((relevance, index) => ({
    relevance,
    domain: `source${index}.example`,
  }));
  const good = [0.52, 0.45, 0.39, 0.34].map((relevance, index) => ({
    relevance,
    domain: `source${index}.example`,
  }));
  assert.equal(classifyQuality(weak, 18, 0, 8, 0.16), "weak");
  assert.equal(classifyQuality(good, 18, 0, 4, 0.16), "good");
});

test("ranking deduplicates canonical URLs and keeps domains diverse", () => {
  const ranked = rankAndSelectResults("MCP TypeScript SDK v2", [{
    title: "MCP TypeScript SDK v2",
    url: "https://github.com/modelcontextprotocol/typescript-sdk?utm_source=test",
    content: "Official SDK v2",
    engines: ["google"],
    score: 3,
  }, {
    title: "MCP TypeScript SDK v2",
    url: "https://github.com/modelcontextprotocol/typescript-sdk#readme",
    content: "Longer official Model Context Protocol SDK v2 source text",
    engines: ["bing"],
    score: 2,
  }, {
    title: "MCP TypeScript SDK documentation",
    url: "https://modelcontextprotocol.io/docs/sdk",
    content: "TypeScript SDK v2 documentation",
    engines: ["startpage"],
  }], {
    maxResults: 5,
    maxPerDomain: 1,
    preferredDomains: ["modelcontextprotocol.io"],
    includeDomains: [],
    excludeDomains: [],
    minRelevance: 0.16,
  });
  assert.equal(ranked.totalCandidates, 3);
  assert.equal(ranked.uniqueCandidates, 2);
  assert.equal(ranked.results.length, 2);
  assert.deepEqual(ranked.results.find((item) => item.domain === "github.com").engines.sort(), ["bing", "google"]);
  assert.equal(ranked.results[0].domain, "modelcontextprotocol.io");
});

test("engine failures open cooldowns and repeated searches use the cache", async () => {
  const urls = [];
  let timestamp = Date.parse("2026-08-24T00:00:00Z");
  const coordinator = createSearchCoordinator(config(), {
    now: () => timestamp,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    fetch: async (url) => {
      urls.push(new URL(String(url)));
      return jsonResponse({
        unresponsive_engines: [["searchtoday", "too many requests"]],
        results: [1, 2, 3].map((index) => ({
          title: `Official MCP SDK v2 source ${index}`,
          url: `https://example${index}.com/${urls.length}`,
          content: "MCP SDK v2 release documentation",
          engines: ["bing"],
        })),
      });
    },
  });

  const first = await coordinator.search("MCP SDK v2", { maxResults: 5 });
  assert.equal(first.partial, true);
  assert.equal(first.engineStatus.unresponsive[0].engine, "searchtoday");
  const cached = await coordinator.search("MCP SDK v2", { maxResults: 5 });
  assert.equal(cached.cacheHit, true);
  assert.equal(urls.length, 1);

  timestamp += 1000;
  const secondQuery = await coordinator.search("MCP protocol specification", { maxResults: 5 });
  assert.equal(new URL(urls[1]).searchParams.get("engines").includes("searchtoday"), false);
  assert.equal(secondQuery.engineStatus.cooledDown.some((item) => item.engine === "searchtoday"), true);
  assert.equal(coordinator.health().state, "degraded");
});

test("identical in-flight requests are coalesced into one backend request", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const coordinator = createSearchCoordinator(config(), {
    fetch: async () => {
      calls += 1;
      await gate;
      return jsonResponse({
        results: [1, 2, 3].map((index) => ({
          title: `Qwen release notes source ${index}`,
          url: `https://example${index}.com/qwen`,
          content: "Qwen release notes",
          engines: ["bing"],
        })),
      });
    },
  });
  const first = coordinator.searchBase("Qwen release notes", { maxResults: 5 });
  const second = coordinator.searchBase("Qwen release notes", { maxResults: 5 });
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(left.coalesced, false);
  assert.equal(right.coalesced, true);
});

test("research merges duplicate sources, reports query coverage, and registers readable IDs", async () => {
  let id = 0;
  const coordinator = createSearchCoordinator(config(), {
    randomUUID: () => "22222222-2222-4222-8222-222222222222",
    fetch: async (url) => {
      const query = new URL(String(url)).searchParams.get("q");
      id += 1;
      return jsonResponse({
        results: [{
          title: "China economic data",
          url: `https://stats.gov.cn/data?utm_source=${id}`,
          content: `${query} official statistics`,
          engines: [id === 1 ? "bing" : "google"],
        }, {
          title: `${query} analysis`,
          url: `https://source${id}.example/report`,
          content: `${query} independent report`,
          engines: ["bing"],
        }],
      });
    },
  });
  const result = await coordinator.research({
    queries: [{ id: "macro", query: "China GDP data" }, { id: "jobs", query: "China youth employment" }],
    max_sources: 10,
  });
  assert.equal(result.queryCoverage.length, 2);
  assert.equal(result.sourceStrategy, "balanced");
  assert.equal(result.sourceTypeCoverage.official, 1);
  assert.equal(result.results.every((item) => /^r\d+$/.test(item.resultId)), true);
  const official = result.results.find((item) => item.domain === "stats.gov.cn");
  assert.deepEqual(official.matchedQueries.sort(), ["jobs", "macro"]);
  assert.equal(coordinator.resolveSessionResults(result.searchId, [official.resultId])[0].url, official.url);
  assert.throws(() => coordinator.resolveSessionResults(result.searchId, ["r999"]), /do not belong/);
});

test("source classification and balanced selection expose multiple evidence classes without treating them as credibility scores", () => {
  assert.equal(classifySource("https://www.stats.gov.cn/data/report").sourceType, "official");
  assert.equal(classifySource("https://arxiv.org/abs/2608.12345").sourceType, "academic");
  assert.equal(classifySource("https://github.com/example/project/releases").sourceType, "documentation");
  assert.equal(classifySource("https://www.reuters.com/world/story").sourceType, "news");
  assert.equal(classifySource("https://www.reddit.com/r/economics/comments/1").sourceType, "community");

  const items = [
    ["news", 0.9, "reuters.com"],
    ["official", 0.7, "stats.gov.cn"],
    ["academic", 0.65, "arxiv.org"],
    ["documentation", 0.62, "docs.example.com"],
  ].map(([sourceType, relevance, domain], index) => ({
    sourceType, relevance, domain, canonicalUrl: `https://${domain}/${index}`, lowRelevance: false, score: relevance,
  }));
  const selected = selectSourceDiverse(items, 4, 2, "balanced");
  assert.deepEqual(new Set(selected.map((item) => item.sourceType)), new Set(["news", "official", "academic", "documentation"]));
});

test("an empty primary pool performs only one distinct fallback pass", async () => {
  const urls = [];
  const coordinator = createSearchCoordinator(config(), {
    fetch: async (url) => {
      urls.push(new URL(String(url)));
      return jsonResponse({ results: [] });
    },
  });
  const result = await coordinator.search("rare query phrase", { maxResults: 5 });
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get("engines"), "searchtoday");
  assert.equal(urls[1].searchParams.get("engines"), "yandex");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.quality, "empty");
});

test("off-topic primary candidates are withheld and trigger one relevance fallback", async () => {
  let calls = 0;
  const coordinator = createSearchCoordinator(config(), {
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({
          results: [{ title: "Popular fashion models", url: "https://noise.example/models", content: "runway photos", engines: ["yandex"] }],
        });
      }
      return jsonResponse({
        results: [{
          title: "Model Context Protocol TypeScript SDK",
          url: "https://modelcontextprotocol.io/sdk/typescript",
          content: "Official TypeScript SDK for Model Context Protocol",
          engines: ["brave"],
        }],
      });
    },
  });
  const result = await coordinator.search("Model Context Protocol TypeScript SDK", { maxResults: 8 });
  assert.equal(calls, 2);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].domain, "modelcontextprotocol.io");
  assert.equal(result.results.some((item) => item.domain === "noise.example"), false);
});
