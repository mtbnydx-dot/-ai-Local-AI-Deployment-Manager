const crypto = require("node:crypto");

const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "spm",
  "yclid",
]);

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it",
  "latest", "new", "news", "of", "on", "or", "the", "to", "with", "current", "today",
  "一下", "今天", "当前", "最新", "相关", "新闻", "数据", "情况",
]);

const SOURCE_TYPES = [
  "official",
  "academic",
  "documentation",
  "news",
  "organization",
  "community",
  "commercial",
  "other",
];

const ACADEMIC_DOMAINS = [
  "arxiv.org", "doi.org", "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "ssrn.com",
  "jstor.org", "nature.com", "science.org", "sciencedirect.com", "springer.com",
  "wiley.com", "tandfonline.com", "cambridge.org", "oup.com", "researchgate.net",
];

const NEWS_DOMAINS = [
  "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "bloomberg.com", "ft.com",
  "wsj.com", "nytimes.com", "economist.com", "theguardian.com", "aljazeera.com",
  "cnn.com", "cnbc.com", "forbes.com", "time.com", "axios.com", "politico.com",
  "scmp.com", "caixin.com", "yicai.com", "thepaper.cn", "36kr.com", "xinhua.net",
  "people.com.cn", "chinadaily.com.cn", "abc.net.au", "smh.com.au", "afr.com",
];

const COMMUNITY_DOMAINS = [
  "reddit.com", "quora.com", "zhihu.com", "stackoverflow.com", "stackexchange.com",
  "news.ycombinator.com", "x.com", "twitter.com", "facebook.com", "youtube.com",
  "bilibili.com", "medium.com", "substack.com",
];

const COMMERCIAL_DOMAINS = [
  "amazon.com", "amazon.com.au", "ebay.com", "jd.com", "taobao.com", "tmall.com",
  "aliexpress.com", "walmart.com", "bestbuy.com",
];

function createSearchCoordinator(config, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("global fetch is required; use Node.js 20+.");

  const now = deps.now || Date.now;
  const randomUUID = deps.randomUUID || crypto.randomUUID;
  const cache = new Map();
  const inFlight = new Map();
  const circuits = new Map();
  const sessions = new Map();
  const waiters = [];
  let activeBackendRequests = 0;

  const metrics = {
    searches: 0,
    researchRequests: 0,
    cacheHits: 0,
    coalescedRequests: 0,
    backendRequests: 0,
    backendFailures: 0,
    zeroResultSearches: 0,
    weakSearches: 0,
    pagesRead: 0,
    pageReadFailures: 0,
    pageCacheHits: 0,
    pageFinds: 0,
    pageFindFailures: 0,
  };
  let lastSearch = null;

  const defaults = {
    cacheTtlMs: config.searchCacheTtlMs || 10 * 60 * 1000,
    negativeCacheTtlMs: config.searchNegativeCacheTtlMs || 60 * 1000,
    sessionTtlMs: config.searchSessionTtlMs || 15 * 60 * 1000,
    maxCacheEntries: config.searchMaxCacheEntries || 300,
    maxSessions: config.searchMaxSessions || 200,
    maxConcurrent: config.searchMaxConcurrent || 2,
    defaultEngines: normalizeTokenList(config.searchDefaultEngines || ["searchtoday"]),
    chineseEngines: normalizeTokenList(config.searchChineseEngines || []),
    fallbackEngines: normalizeTokenList(config.searchFallbackEngines || ["yandex"]),
  };

  function cleanup() {
    const timestamp = now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= timestamp) cache.delete(key);
    }
    for (const [key, entry] of sessions) {
      if (entry.expiresAt <= timestamp) sessions.delete(key);
    }
    for (const [engine, entry] of circuits) {
      if (entry.until <= timestamp) circuits.delete(engine);
    }
    trimOldest(cache, defaults.maxCacheEntries);
    trimOldest(sessions, defaults.maxSessions);
  }

  async function withBackendSlot(operation) {
    if (activeBackendRequests >= defaults.maxConcurrent) {
      if (waiters.length >= 50) throw new Error("Search backend queue is full; retry shortly.");
      await new Promise((resolve) => waiters.push(resolve));
    }
    activeBackendRequests += 1;
    try {
      return await operation();
    } finally {
      activeBackendRequests -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  }

  function circuitState(engine) {
    const entry = circuits.get(String(engine || "").toLowerCase());
    if (!entry || entry.until <= now()) return null;
    return {
      engine: entry.engine,
      reason: entry.reason,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.until - now()) / 1000)),
    };
  }

  function openCircuit(engine, reason) {
    const name = cleanToken(engine, 64).toLowerCase();
    if (!name) return null;
    const durationMs = cooldownDuration(reason, config);
    const existing = circuits.get(name);
    const until = Math.max(existing?.until || 0, now() + durationMs);
    const state = { engine: name, reason: clipText(reason || "unresponsive", 160), until, updatedAt: now() };
    circuits.set(name, state);
    return {
      engine: state.engine,
      reason: state.reason,
      retryAfterSeconds: Math.max(1, Math.ceil((until - now()) / 1000)),
    };
  }

  function availableEngines(requested) {
    const selected = [];
    const cooledDown = [];
    for (const engine of normalizeTokenList(requested)) {
      const state = circuitState(engine);
      if (state) cooledDown.push(state);
      else selected.push(engine);
    }
    return { selected, cooledDown };
  }

  async function fetchBackend(query, options, engines) {
    const searchUrl = new URL(`${config.searchBackendUrl}/search`);
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("format", "json");
    searchUrl.searchParams.set("safesearch", String(options.safesearch ?? 1));
    if (options.language) searchUrl.searchParams.set("language", options.language);
    if (options.time_range) searchUrl.searchParams.set("time_range", options.time_range);
    if (engines.length) searchUrl.searchParams.set("engines", engines.join(","));
    if (options.categories) searchUrl.searchParams.set("categories", options.categories);

    metrics.backendRequests += 1;
    return withBackendSlot(async () => {
      let response;
      try {
        response = await fetchImpl(searchUrl, {
          headers: { accept: "application/json", "user-agent": "local-ai-search-gateway/0.2" },
          signal: AbortSignal.timeout(config.searchTimeoutMs),
        });
      } catch (error) {
        metrics.backendFailures += 1;
        throw new Error(isTimeoutError(error)
          ? `Search backend timed out after ${config.searchTimeoutMs} ms.`
          : "Search backend could not be reached.");
      }
      const text = await response.text();
      if (!response.ok) {
        metrics.backendFailures += 1;
        throw new Error(`Search backend returned ${response.status}: ${clipText(text, 400)}`);
      }
      const data = parseJsonText(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        metrics.backendFailures += 1;
        throw new Error("Search backend returned invalid JSON.");
      }
      return data;
    });
  }

  async function searchUncached(query, rawOptions = {}) {
    const options = normalizeSearchOptions(rawOptions, config);
    options.preferredDomains = Array.from(new Set([...options.preferredDomains, ...automaticPreferredDomains(query)])).slice(0, 20);
    const explicitEngines = normalizeTokenList(options.engines);
    const requestedEngines = explicitEngines.length
      ? explicitEngines
      : Array.from(new Set([
        ...defaults.defaultEngines,
        ...(isChineseSearch(query, options.language) ? defaults.chineseEngines : []),
      ]));
    const primary = availableEngines(requestedEngines);
    const fallbackPool = explicitEngines.length
      ? []
      : defaults.fallbackEngines.filter((engine) => !requestedEngines.includes(engine));
    const warnings = [];
    const allUnresponsive = [];
    const cooledDown = [...primary.cooledDown];
    const attempted = [];
    const payloads = [];
    let fallbackUsed = false;
    let fallbackReason = null;

    if (primary.selected.length) {
      attempted.push(...primary.selected);
      payloads.push(await fetchBackend(query, options, primary.selected));
    } else if (explicitEngines.length) {
      warnings.push("Every explicitly selected engine is temporarily cooling down.");
    }

    for (const payload of payloads) {
      const failures = normalizeUnresponsiveEngines(payload.unresponsive_engines);
      for (const failure of failures) {
        allUnresponsive.push(failure);
        openCircuit(failure.engine, failure.reason);
      }
    }

    let rawResults = payloads.flatMap((payload) => array(payload.results));
    let rawAnswers = payloads.flatMap((payload) => array(payload.answers));
    let corrections = payloads.flatMap((payload) => array(payload.corrections));
    let suggestions = payloads.flatMap((payload) => array(payload.suggestions));

    const preliminaryRanked = rankAndSelectResults(query, rawResults, options);
    const preliminaryQuality = classifyQuality(
      preliminaryRanked.results,
      preliminaryRanked.totalCandidates,
      allUnresponsive.length,
      options.maxResults,
      options.minRelevance,
    );
    const primarySparse = preliminaryRanked.results.length < Math.min(3, options.maxResults);
    if (!explicitEngines.length && (["empty", "weak"].includes(preliminaryQuality) || primarySparse) && fallbackPool.length) {
      const fallback = availableEngines(fallbackPool.filter((engine) => !attempted.includes(engine)));
      cooledDown.push(...fallback.cooledDown);
      if (fallback.selected.length) {
        fallbackUsed = true;
        fallbackReason = preliminaryQuality === "weak"
          ? "primary_results_weak"
          : preliminaryRanked.results.length
            ? "primary_results_sparse"
            : allUnresponsive.length
              ? "primary_engines_unresponsive"
              : cooledDown.length
                ? "primary_engines_cooling_down"
                : "primary_engines_empty";
        warnings.push(`Fallback engines were used because ${fallbackReason.replaceAll("_", " ")}.`);
        attempted.push(...fallback.selected);
        const payload = await fetchBackend(query, options, fallback.selected);
        payloads.push(payload);
        const failures = normalizeUnresponsiveEngines(payload.unresponsive_engines);
        for (const failure of failures) {
          allUnresponsive.push(failure);
          openCircuit(failure.engine, failure.reason);
        }
        rawResults = rawResults.concat(array(payload.results));
        rawAnswers = rawAnswers.concat(array(payload.answers));
        corrections = corrections.concat(array(payload.corrections));
        suggestions = suggestions.concat(array(payload.suggestions));
      }
    }

    const ranked = rankAndSelectResults(query, rawResults, options);
    const answers = normalizeAnswers(rawAnswers);
    const quality = classifyQuality(ranked.results, ranked.totalCandidates, allUnresponsive.length, options.maxResults, options.minRelevance);
    const partial = allUnresponsive.length > 0 || cooledDown.length > 0 || quality === "weak";
    if (allUnresponsive.length) {
      warnings.push(`${allUnresponsive.length} search engine response(s) were unavailable; healthy engines were used where possible.`);
    }
    if (cooledDown.length) {
      warnings.push(`${cooledDown.length} engine(s) were skipped because their cooldown is still active.`);
    }
    if (quality === "weak") {
      warnings.push("Search results have weak lexical relevance; use a shorter query, preferred_domains, or local_ai_research_web.");
    }
    if (quality === "empty" && quotedPhrases(query).length) {
      warnings.push("No result matched every quoted phrase; remove or shorten the quotes, or use local_ai_research_web with alternate wording.");
    }
    if (quality === "empty") metrics.zeroResultSearches += 1;
    if (quality === "weak") metrics.weakSearches += 1;

    const engineDistribution = countValues(ranked.results.flatMap((result) => result.engines));
    const available = attempted.length > 0 && (ranked.results.length > 0 || allUnresponsive.length < attempted.length);
    const output = {
      query,
      searchedAt: new Date(now()).toISOString(),
      count: ranked.results.length,
      totalCandidates: ranked.totalCandidates,
      uniqueCandidates: ranked.uniqueCandidates,
      quality,
      partial,
      available,
      cacheHit: false,
      coalesced: false,
      fallbackUsed,
      fallbackReason,
      answers,
      corrections: normalizeTextList(corrections, 5, 240),
      suggestions: normalizeTextList(suggestions, 8, 240),
      sourceDomains: Array.from(new Set(ranked.results.map((result) => result.domain))).slice(0, 30),
      sourceTypeCoverage: countValues(ranked.results.map((result) => result.sourceType)),
      engineStatus: {
        requested: requestedEngines,
        attempted: Array.from(new Set(attempted)),
        used: Object.keys(engineDistribution),
        distribution: engineDistribution,
        unresponsive: dedupeEngineStates(allUnresponsive.map((failure) => {
          const active = circuitState(failure.engine);
          return active || { ...failure, retryAfterSeconds: 1 };
        })),
        cooledDown: dedupeEngineStates(cooledDown),
      },
      warnings: Array.from(new Set(warnings)).slice(0, 12),
      results: ranked.results,
    };
    lastSearch = {
      searchedAt: output.searchedAt,
      quality: output.quality,
      count: output.count,
      partial: output.partial,
      available: output.available,
    };
    return output;
  }

  async function searchBase(queryValue, rawOptions = {}) {
    cleanup();
    const query = clipText(String(queryValue || "").trim(), 500);
    if (query.length < 2) throw new Error("Search query must contain at least two characters.");
    const options = normalizeSearchOptions(rawOptions, config);
    const key = searchCacheKey(query, options);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      metrics.cacheHits += 1;
      return { ...clone(cached.value), cacheHit: true, coalesced: false };
    }
    const pending = inFlight.get(key);
    if (pending) {
      metrics.coalescedRequests += 1;
      const value = await pending;
      return { ...clone(value), cacheHit: false, coalesced: true };
    }
    const operation = searchUncached(query, options);
    inFlight.set(key, operation);
    try {
      const value = await operation;
      const ttl = value.partial || value.quality === "empty" || value.quality === "weak"
        ? defaults.negativeCacheTtlMs
        : defaults.cacheTtlMs;
      cache.set(key, { value: clone(value), expiresAt: now() + ttl, createdAt: now() });
      trimOldest(cache, defaults.maxCacheEntries);
      return value;
    } finally {
      inFlight.delete(key);
    }
  }

  function registerSession(result) {
    cleanup();
    const searchId = randomUUID();
    const sessionResults = result.results.map((item, index) => ({
      ...item,
      resultId: `r${index + 1}`,
    }));
    sessions.set(searchId, {
      createdAt: now(),
      expiresAt: now() + defaults.sessionTtlMs,
      results: sessionResults.map((item) => ({
        resultId: item.resultId,
        title: item.title,
        url: item.url,
        domain: item.domain,
        sourceType: item.sourceType,
        primarySourceLikelihood: item.primarySourceLikelihood,
      })),
    });
    trimOldest(sessions, defaults.maxSessions);
    return {
      ...result,
      searchId,
      expiresInSeconds: Math.floor(defaults.sessionTtlMs / 1000),
      results: sessionResults,
    };
  }

  async function search(query, options = {}) {
    metrics.searches += 1;
    return registerSession(await searchBase(query, options));
  }

  async function research(input = {}) {
    metrics.researchRequests += 1;
    const queries = normalizeResearchQueries(input.queries, input, config);
    if (!queries.length) throw new Error("Research requires at least one query.");
    const maxSources = numberInRange(input.maxSources ?? input.max_sources, 3, 40, 18);
    const maxPerDomain = numberInRange(input.maxPerDomain ?? input.max_per_domain, 1, 6, 3);
    const sourceStrategy = normalizeSourceStrategy(input.sourceStrategy ?? input.source_strategy);
    const resultsByQuery = await mapWithConcurrency(queries, defaults.maxConcurrent, async (entry) => {
      try {
        const result = await searchBase(entry.query, {
          ...entry,
          maxResults: entry.maxResults,
          maxPerDomain,
        });
        return { entry, result, error: null };
      } catch (error) {
        return { entry, result: null, error: safeErrorMessage(error) };
      }
    });

    const merged = new Map();
    const answers = [];
    const corrections = [];
    const suggestions = [];
    const warnings = [];
    const unresponsive = [];
    const cooledDown = [];
    let anyCacheHit = false;
    let partial = false;

    for (const item of resultsByQuery) {
      if (item.error || !item.result) {
        partial = true;
        warnings.push(`${item.entry.id}: ${item.error}`);
        continue;
      }
      anyCacheHit = anyCacheHit || item.result.cacheHit;
      partial = partial || item.result.partial;
      answers.push(...item.result.answers);
      corrections.push(...item.result.corrections);
      suggestions.push(...item.result.suggestions);
      warnings.push(...item.result.warnings.map((warning) => `${item.entry.id}: ${warning}`));
      unresponsive.push(...item.result.engineStatus.unresponsive);
      cooledDown.push(...item.result.engineStatus.cooledDown);
      for (const result of item.result.results) {
        const key = result.canonicalUrl;
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, {
            ...result,
            matchedQueries: [item.entry.id],
          });
          continue;
        }
        existing.matchedQueries = Array.from(new Set([...existing.matchedQueries, item.entry.id]));
        existing.engines = Array.from(new Set([...existing.engines, ...result.engines]));
        existing.engine = existing.engines.join(", ");
        existing.relevance = Math.min(1, Math.max(existing.relevance, result.relevance) + 0.03);
        if (result.content.length > existing.content.length) existing.content = result.content;
      }
    }

    const selected = selectSourceDiverse(
      Array.from(merged.values()).sort(compareResults),
      maxSources,
      maxPerDomain,
      sourceStrategy,
    );
    const queryCoverage = resultsByQuery.map((item) => ({
      id: item.entry.id,
      query: item.entry.query,
      count: item.result?.count || 0,
      quality: item.result?.quality || "unavailable",
      cacheHit: Boolean(item.result?.cacheHit),
      error: item.error,
    }));
    const successfulQueries = queryCoverage.filter((item) => !item.error).length;
    const strongQueries = queryCoverage.filter((item) => item.quality === "good" || item.quality === "mixed").length;
    const quality = selected.length === 0
      ? "empty"
      : strongQueries >= Math.ceil(Math.max(1, successfulQueries) / 2) && selected.length >= Math.min(8, maxSources)
        ? "good"
        : selected.filter((item) => item.relevance >= 0.2).length >= Math.min(4, selected.length)
          ? "mixed"
          : "weak";
    if (quality === "weak") partial = true;
    const sourceTypeCoverage = countValues(selected.map((result) => result.sourceType));
    const requestedSourceTypes = Array.from(new Set([
      ...normalizeSourceTypes(input.preferredSourceTypes ?? input.preferred_source_types),
      ...queries.flatMap((query) => query.preferredSourceTypes || []),
    ]));
    const expectedSourceTypes = requestedSourceTypes.length
      ? requestedSourceTypes
      : sourceStrategy === "balanced"
        ? ["official", "academic", "documentation", "news"]
        : sourceStrategy === "primary"
          ? ["official", "academic", "documentation", "organization"]
          : [];
    const coverageGaps = expectedSourceTypes.filter((type) => !sourceTypeCoverage[type]);
    if (coverageGaps.length) warnings.push(`Source-type coverage gaps: ${coverageGaps.join(", ")}. Add a focused query for those source types if they matter to the answer.`);
    const output = {
      query: queries.map((item) => item.query).join(" | "),
      searchedAt: new Date(now()).toISOString(),
      count: selected.length,
      totalCandidates: Array.from(merged.values()).length,
      uniqueCandidates: Array.from(merged.values()).length,
      quality,
      partial,
      available: successfulQueries > 0,
      cacheHit: anyCacheHit,
      coalesced: false,
      fallbackUsed: resultsByQuery.some((item) => item.result?.fallbackUsed),
      fallbackReason: null,
      answers: normalizeTextList(answers, 6, 700),
      corrections: normalizeTextList(corrections, 8, 240),
      suggestions: normalizeTextList(suggestions, 12, 240),
      sourceDomains: Array.from(new Set(selected.map((result) => result.domain))).slice(0, 40),
      sourceStrategy,
      sourceTypeCoverage,
      coverageGaps,
      engineStatus: {
        requested: Array.from(new Set(resultsByQuery.flatMap((item) => item.result?.engineStatus.requested || []))),
        attempted: Array.from(new Set(resultsByQuery.flatMap((item) => item.result?.engineStatus.attempted || []))),
        used: Array.from(new Set(selected.flatMap((item) => item.engines))),
        distribution: countValues(selected.flatMap((item) => item.engines)),
        unresponsive: dedupeEngineStates(unresponsive),
        cooledDown: dedupeEngineStates(cooledDown),
      },
      warnings: Array.from(new Set(warnings)).slice(0, 20),
      queryCoverage,
      results: selected,
    };
    lastSearch = {
      searchedAt: output.searchedAt,
      quality: output.quality,
      count: output.count,
      partial: output.partial,
      available: output.available,
    };
    return registerSession(output);
  }

  function resolveSessionResults(searchIdValue, resultIdsValue) {
    cleanup();
    const searchId = String(searchIdValue || "").trim();
    const resultIds = Array.from(new Set(array(resultIdsValue).map((value) => String(value || "").trim()).filter(Boolean)));
    const session = sessions.get(searchId);
    if (!session || session.expiresAt <= now()) {
      throw new Error("Search result set is unknown or expired. Run a new search and use its search_id.");
    }
    if (!resultIds.length || resultIds.length > 3) {
      throw new Error("Choose between one and three result_ids from the referenced search result set.");
    }
    const selected = resultIds.map((resultId) => session.results.find((item) => item.resultId === resultId));
    if (selected.some((item) => !item)) {
      throw new Error("One or more result_ids do not belong to the referenced search result set.");
    }
    return selected;
  }

  function notePageRead(ok) {
    if (ok) metrics.pagesRead += 1;
    else metrics.pageReadFailures += 1;
  }

  function notePageCacheHit() {
    metrics.pageCacheHits += 1;
  }

  function notePageFind(ok) {
    metrics.pageFinds += 1;
    if (!ok) metrics.pageFindFailures += 1;
  }

  function health() {
    cleanup();
    const cooldowns = Array.from(circuits.values()).map((entry) => ({
      engine: entry.engine,
      reason: entry.reason,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.until - now()) / 1000)),
    }));
    const defaultAvailable = defaults.defaultEngines.filter((engine) => !circuitState(engine));
    const state = lastSearch?.available === false
      ? "unavailable"
      : lastSearch?.partial || (cooldowns.length > 0 && defaultAvailable.length < defaults.defaultEngines.length)
        ? "degraded"
        : "healthy";
    return {
      state,
      defaultEngines: defaults.defaultEngines,
      chineseEngines: defaults.chineseEngines,
      fallbackEngines: defaults.fallbackEngines,
      availableDefaultEngines: defaultAvailable,
      cooldowns,
      cacheEntries: cache.size,
      activeBackendRequests,
      queuedBackendRequests: waiters.length,
      sessionCount: sessions.size,
      lastSearch,
      metrics: { ...metrics },
    };
  }

  return {
    health,
    notePageCacheHit,
    notePageFind,
    notePageRead,
    research,
    resolveSessionResults,
    search,
    searchBase,
  };
}

function normalizeSearchOptions(input = {}, config = {}) {
  return {
    maxResults: numberInRange(input.maxResults ?? input.max_results, 1, 20, config.maxResults || 8),
    language: cleanToken(input.language, 24),
    time_range: cleanToken(input.time_range ?? input.timeRange, 24),
    engines: normalizeTokenList(input.engines),
    categories: normalizeTokenList(input.categories).join(","),
    safesearch: numberInRange(input.safesearch, 0, 2, 1),
    preferredDomains: normalizeDomainList(input.preferredDomains ?? input.preferred_domains),
    includeDomains: normalizeDomainList(input.includeDomains ?? input.include_domains),
    excludeDomains: Array.from(new Set([
      ...normalizeDomainList(input.excludeDomains ?? input.exclude_domains),
      ...normalizeDomainList(config.searchBlockedDomains || ["ai.so.com"]),
    ])).slice(0, 20),
    maxPerDomain: numberInRange(input.maxPerDomain ?? input.max_per_domain, 1, 6, 3),
    preferredSourceTypes: normalizeSourceTypes(input.preferredSourceTypes ?? input.preferred_source_types),
    minRelevance: numberInRangeFloat(config.searchMinRelevance, 0.05, 0.5, 0.16),
  };
}

function normalizeResearchQueries(values, defaults = {}, config = {}) {
  return array(values).slice(0, 8).map((raw, index) => {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { query: raw };
    const query = clipText(String(item.query || "").trim(), 500);
    if (query.length < 2) return null;
    return {
      id: cleanToken(item.id, 40) || `q${index + 1}`,
      query,
      maxResults: numberInRange(item.maxResults ?? item.max_results ?? defaults.maxResultsPerQuery ?? defaults.max_results_per_query, 2, 15, 8),
      language: cleanToken(item.language ?? defaults.language, 24),
      time_range: cleanToken(item.time_range ?? item.timeRange ?? defaults.time_range ?? defaults.timeRange, 24),
      engines: normalizeTokenList(item.engines ?? defaults.engines),
      categories: normalizeTokenList(item.categories ?? defaults.categories),
      safesearch: numberInRange(item.safesearch ?? defaults.safesearch, 0, 2, 1),
      preferredDomains: normalizeDomainList(item.preferredDomains ?? item.preferred_domains ?? defaults.preferredDomains ?? defaults.preferred_domains),
      includeDomains: normalizeDomainList(item.includeDomains ?? item.include_domains ?? defaults.includeDomains ?? defaults.include_domains),
      excludeDomains: normalizeDomainList(item.excludeDomains ?? item.exclude_domains ?? defaults.excludeDomains ?? defaults.exclude_domains),
      preferredSourceTypes: normalizeSourceTypes(item.preferredSourceTypes ?? item.preferred_source_types ?? defaults.preferredSourceTypes ?? defaults.preferred_source_types),
    };
  }).filter(Boolean);
}

function rankAndSelectResults(query, rawResults, options) {
  const normalized = rawResults
    .map((item) => normalizeSearchResult(item, query, options))
    .filter(Boolean)
    .filter((item) => domainAllowed(item.domain, options));
  const deduped = new Map();
  for (const item of normalized) {
    const titleKey = `${item.domain}|${normalizeForMatch(item.title)}`;
    const key = deduped.has(item.canonicalUrl) ? item.canonicalUrl : titleKey;
    const existing = deduped.get(key) || deduped.get(item.canonicalUrl);
    if (!existing) {
      deduped.set(item.canonicalUrl, item);
      if (titleKey.length > item.domain.length + 12) deduped.set(titleKey, item);
      continue;
    }
    existing.engines = Array.from(new Set([...existing.engines, ...item.engines]));
    existing.engine = existing.engines.join(", ");
    existing.score = maxNullable(existing.score, item.score);
    existing.relevance = Math.max(existing.relevance, item.relevance);
    existing.lowRelevance = existing.relevance < 0.12;
    if (item.content.length > existing.content.length) existing.content = item.content;
  }
  const unique = Array.from(new Set(deduped.values()));
  unique.sort(compareResults);
  const relevant = unique.filter((item) => item.relevance >= options.minRelevance);
  const marginal = unique.filter((item) => item.relevance >= options.minRelevance / 2 && item.relevance < options.minRelevance);
  const pool = relevant.length >= 1
    ? relevant
    : [...relevant, ...marginal].slice(0, Math.min(3, options.maxResults));
  const results = selectDomainDiverse(pool, options.maxResults, options.maxPerDomain);
  return {
    totalCandidates: rawResults.length,
    uniqueCandidates: unique.length,
    results,
  };
}

function normalizeSearchResult(raw, query, options) {
  if (!raw || typeof raw !== "object" || !raw.url) return null;
  let parsed;
  try {
    parsed = new URL(String(raw.url));
  } catch {
    return null;
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) return null;
  const domain = parsed.hostname.toLowerCase();
  const canonicalUrl = canonicalizeUrl(parsed);
  const title = clipText(String(raw.title || raw.url || ""), 240);
  const content = clipText(String(raw.content || raw.snippet || ""), 1200);
  const engines = normalizeTokenList(Array.isArray(raw.engines) ? raw.engines : raw.engine);
  const score = Number.isFinite(Number(raw.score)) ? Number(raw.score) : null;
  const publishedDate = clipText(String(raw.publishedDate || raw.published_date || raw.published_at || ""), 80) || null;
  const source = classifySource(canonicalUrl, raw.category, title);
  const relevance = relevanceScore(query, {
    title, content, url: canonicalUrl, domain, score, publishedDate, sourceType: source.sourceType,
  }, options);
  return {
    title,
    url: canonicalUrl,
    canonicalUrl,
    domain,
    content,
    engine: engines.join(", ") || null,
    engines,
    score,
    relevance,
    lowRelevance: relevance < options.minRelevance,
    category: clipText(String(raw.category || ""), 80) || null,
    publishedDate,
    sourceType: source.sourceType,
    sourceTypeReason: source.reason,
    primarySourceLikelihood: source.primarySourceLikelihood,
  };
}

function relevanceScore(query, item, options) {
  const tokens = queryTokens(query);
  const title = normalizeForMatch(item.title);
  const content = normalizeForMatch(item.content);
  const url = normalizeForMatch(item.url);
  const titleCoverage = tokenCoverage(tokens, title);
  const contentCoverage = tokenCoverage(tokens, content);
  const urlCoverage = tokenCoverage(tokens, url);
  const phrases = quotedPhrases(query);
  const phraseHaystack = normalizeForPhrase(`${item.title} ${item.content} ${item.url}`);
  const everyPhraseMatched = phrases.length === 0 || phrases.every((phrase) => phraseHaystack.includes(normalizeForPhrase(phrase)));
  const phraseBoost = phrases.length && everyPhraseMatched ? 0.16 : 0;
  const preferredBoost = options.preferredDomains.some((domain) => domainMatches(item.domain, domain)) ? 0.16 : 0;
  const preferredSourceBoost = (options.preferredSourceTypes || []).includes(item.sourceType) ? 0.1 : 0;
  const authorityBoost = /(^|\.)(gov|edu)(\.[a-z]{2})?$/i.test(item.domain) || /(^|\.)gov\.cn$/i.test(item.domain) ? 0.12 : 0;
  const engineScore = item.score == null ? 0 : Math.min(0.05, (Math.max(0, item.score) / (Math.max(0, item.score) + 1)) * 0.05);
  const dateBoost = recentDateBoost(item.publishedDate);
  const weakPenalty = titleCoverage === 0 && contentCoverage < 0.12 ? 0.15 : 0;
  let value = titleCoverage * 0.52
    + contentCoverage * 0.25
    + urlCoverage * 0.04
    + phraseBoost
    + preferredBoost
    + preferredSourceBoost
    + authorityBoost
    + engineScore
    + dateBoost
    - weakPenalty;
  // Quotation marks are an explicit precision request. SearXNG engines do not
  // enforce them consistently, so candidates missing any quoted phrase must
  // not look relevant merely because they share a few common words.
  if (!everyPhraseMatched) value *= 0.15;
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function queryTokens(value) {
  const pieces = normalizeForMatch(value).match(/[\p{L}\p{N}]+/gu) || [];
  const output = new Set();
  for (const piece of pieces) {
    const isHan = /^[\p{Script=Han}]+$/u.test(piece);
    if (isHan && piece.length > 2) {
      if (piece.length <= 4 && !STOP_WORDS.has(piece)) output.add(piece);
      for (let index = 0; index < piece.length - 1; index += 1) {
        const gram = piece.slice(index, index + 2);
        if (!STOP_WORDS.has(gram)) output.add(gram);
      }
    } else if (!STOP_WORDS.has(piece) && piece.length > 1) {
      output.add(piece);
    }
  }
  return Array.from(output).slice(0, 40);
}

function isChineseSearch(query, language) {
  return /^zh(?:[-_]|$)/i.test(String(language || "")) || /\p{Script=Han}/u.test(String(query || ""));
}

function tokenCoverage(tokens, haystack) {
  if (!tokens.length || !haystack) return 0;
  let matched = 0;
  let weight = 0;
  for (const token of tokens) {
    const tokenWeight = Math.min(4, Math.max(1, token.length / 2));
    weight += tokenWeight;
    if (haystack.includes(token)) matched += tokenWeight;
  }
  return weight ? matched / weight : 0;
}

function quotedPhrases(value) {
  const matches = String(value || "").matchAll(/["“”']([^"“”']{2,80})["“”']/g);
  return Array.from(matches, (match) => normalizeForMatch(match[1])).filter(Boolean).slice(0, 5);
}

function classifyQuality(results, totalCandidates, unresponsiveCount, requestedCount, minRelevance = 0.16) {
  if (!results.length) return "empty";
  const relevant = results.filter((item) => item.relevance >= minRelevance).length;
  const highConfidence = results.filter((item) => item.relevance >= Math.min(0.6, minRelevance + 0.14)).length;
  const domainCount = new Set(results.map((item) => item.domain)).size;
  const topRelevance = results[0]?.relevance || 0;
  const topSet = results.slice(0, Math.min(4, results.length));
  const topAverage = topSet.reduce((sum, item) => sum + item.relevance, 0) / topSet.length;
  if (
    highConfidence >= Math.min(4, requestedCount)
    && domainCount >= Math.min(3, results.length)
    && topRelevance >= 0.36
    && topAverage >= 0.28
    && unresponsiveCount === 0
  ) return "good";
  if (
    relevant >= Math.min(3, results.length)
    && highConfidence >= Math.min(2, results.length)
    && domainCount >= Math.min(2, results.length)
    && topRelevance >= 0.34
  ) return "mixed";
  if (totalCandidates > 0) return "weak";
  return "empty";
}

function selectDomainDiverse(results, limit, maxPerDomain) {
  const selected = [];
  const deferred = [];
  const counts = new Map();
  for (const item of results) {
    const count = counts.get(item.domain) || 0;
    if (count >= maxPerDomain) {
      deferred.push(item);
      continue;
    }
    selected.push(item);
    counts.set(item.domain, count + 1);
    if (selected.length >= limit) return selected;
  }
  for (const item of deferred) {
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function selectSourceDiverse(results, limit, maxPerDomain, strategy = "balanced") {
  if (strategy === "relevance") return selectDomainDiverse(results, limit, maxPerDomain);
  const ranked = strategy === "primary"
    ? [...results].sort((left, right) => {
      const boost = (item) => item.primarySourceLikelihood === "high" ? 0.12 : item.primarySourceLikelihood === "medium" ? 0.05 : 0;
      const difference = (right.relevance + boost(right)) - (left.relevance + boost(left));
      return difference || compareResults(left, right);
    })
    : results;
  const selected = [];
  const selectedUrls = new Set();
  const domainCounts = new Map();
  const topRelevance = ranked[0]?.relevance || 0;
  const minimumDiversityRelevance = Math.max(0.12, topRelevance * 0.45);
  const typeOrder = strategy === "primary"
    ? ["official", "academic", "documentation", "organization", "news", "community", "commercial", "other"]
    : ["official", "academic", "documentation", "news", "organization", "community", "commercial", "other"];

  const add = (item) => {
    if (!item || selectedUrls.has(item.canonicalUrl)) return false;
    const count = domainCounts.get(item.domain) || 0;
    if (count >= maxPerDomain) return false;
    selected.push(item);
    selectedUrls.add(item.canonicalUrl);
    domainCounts.set(item.domain, count + 1);
    return true;
  };

  for (const sourceType of typeOrder) {
    const candidate = ranked.find((item) => item.sourceType === sourceType && item.relevance >= minimumDiversityRelevance && !selectedUrls.has(item.canonicalUrl));
    add(candidate);
    if (selected.length >= limit) return selected;
  }
  for (const item of ranked) {
    add(item);
    if (selected.length >= limit) return selected;
  }
  for (const item of ranked) {
    if (selectedUrls.has(item.canonicalUrl)) continue;
    selected.push(item);
    selectedUrls.add(item.canonicalUrl);
    if (selected.length >= limit) break;
  }
  return selected;
}

function classifySource(urlValue, categoryValue = "", titleValue = "") {
  let parsed;
  try {
    parsed = urlValue instanceof URL ? urlValue : new URL(String(urlValue || ""));
  } catch {
    return { sourceType: "other", primarySourceLikelihood: "unknown", reason: "unclassified_url" };
  }
  const domain = parsed.hostname.toLowerCase();
  const pathValue = parsed.pathname.toLowerCase();
  const category = String(categoryValue || "").toLowerCase();
  const title = String(titleValue || "").toLowerCase();

  if (ACADEMIC_DOMAINS.some((value) => domainMatches(domain, value)) || /(?:^|\.)(?:edu|ac)\.[a-z]{2,}$/i.test(domain) || /(?:^|\.)edu$/i.test(domain)) {
    return { sourceType: "academic", primarySourceLikelihood: "high", reason: "academic_domain" };
  }
  if (isOfficialDomain(domain)) {
    return { sourceType: "official", primarySourceLikelihood: "high", reason: "government_or_multilateral_domain" };
  }
  if (
    /(?:^|\.)(?:docs?|developer|developers|support|help)\./i.test(domain)
    || /\/(?:docs?|documentation|reference|api|manuals?|release-notes?|releases?)(?:\/|$)/i.test(pathValue)
    || ["github.com", "gitlab.com", "codeberg.org"].some((value) => domainMatches(domain, value))
    || /\b(?:documentation|api reference|release notes?|developer guide)\b/i.test(title)
  ) {
    return { sourceType: "documentation", primarySourceLikelihood: "high", reason: "documentation_or_repository" };
  }
  if (NEWS_DOMAINS.some((value) => domainMatches(domain, value)) || category === "news" || /\b(?:news|newspaper)\b/i.test(category)) {
    return { sourceType: "news", primarySourceLikelihood: "unknown", reason: "news_domain_or_category" };
  }
  if (COMMUNITY_DOMAINS.some((value) => domainMatches(domain, value)) || /\b(?:forum|discussion|social)\b/i.test(category)) {
    return { sourceType: "community", primarySourceLikelihood: "unknown", reason: "community_domain_or_category" };
  }
  if (COMMERCIAL_DOMAINS.some((value) => domainMatches(domain, value)) || /\/(?:product|products|shop|store|buy)(?:\/|$)/i.test(pathValue)) {
    return { sourceType: "commercial", primarySourceLikelihood: "unknown", reason: "commerce_domain_or_path" };
  }
  if (/\/(?:newsroom|press|media|investors?|company|about|blog|research|reports?)(?:\/|$)/i.test(pathValue)) {
    return { sourceType: "organization", primarySourceLikelihood: "medium", reason: "organization_owned_content" };
  }
  return { sourceType: "other", primarySourceLikelihood: "unknown", reason: "unclassified" };
}

function isOfficialDomain(domain) {
  if (/(?:^|\.)gov$/i.test(domain) || /(?:^|\.)(?:gov|go|gouv|gob)\.[a-z]{2,}(?:\.[a-z]{2})?$/i.test(domain)) return true;
  return [
    "europa.eu", "un.org", "who.int", "worldbank.org", "imf.org", "oecd.org",
    "stats.gov.cn", "gov.cn", "abs.gov.au", "rba.gov.au",
  ].some((value) => domainMatches(domain, value));
}

function compareResults(left, right) {
  const leftPreferred = left.lowRelevance ? 0 : 1;
  const rightPreferred = right.lowRelevance ? 0 : 1;
  if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
  if (left.relevance !== right.relevance) return right.relevance - left.relevance;
  return (right.score || 0) - (left.score || 0);
}

function canonicalizeUrl(value) {
  const parsed = value instanceof URL ? new URL(value.href) : new URL(String(value));
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) parsed.port = "";
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_QUERY_KEYS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

function domainAllowed(domain, options) {
  if (options.includeDomains.length && !options.includeDomains.some((value) => domainMatches(domain, value))) return false;
  return !options.excludeDomains.some((value) => domainMatches(domain, value));
}

function domainMatches(hostname, expected) {
  const host = String(hostname || "").toLowerCase();
  const domain = String(expected || "").toLowerCase().replace(/^\.+/, "");
  return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));
}

function normalizeUnresponsiveEngines(values) {
  return array(values).map((value) => {
    if (Array.isArray(value)) {
      return { engine: cleanToken(value[0], 64).toLowerCase(), reason: clipText(value[1] || "unresponsive", 160) };
    }
    if (value && typeof value === "object") {
      return {
        engine: cleanToken(value.engine || value.name, 64).toLowerCase(),
        reason: clipText(value.reason || value.error || "unresponsive", 160),
      };
    }
    const text = String(value || "");
    const [engine, ...rest] = text.split(":");
    return { engine: cleanToken(engine, 64).toLowerCase(), reason: clipText(rest.join(":") || "unresponsive", 160) };
  }).filter((item) => item.engine);
}

function cooldownDuration(reasonValue, config = {}) {
  const reason = String(reasonValue || "").toLowerCase();
  if (reason.includes("captcha") || reason.includes("access denied") || reason.includes("403")) {
    return config.searchCaptchaCooldownMs || 60 * 60 * 1000;
  }
  if (reason.includes("too many") || reason.includes("429")) {
    return config.searchRateLimitCooldownMs || 5 * 60 * 1000;
  }
  if (reason.includes("timeout")) return config.searchTimeoutCooldownMs || 2 * 60 * 1000;
  return config.searchErrorCooldownMs || 60 * 1000;
}

function searchCacheKey(query, options) {
  return JSON.stringify({
    query: normalizeForMatch(query),
    maxResults: options.maxResults,
    language: options.language,
    time_range: options.time_range,
    engines: options.engines,
    categories: options.categories,
    safesearch: options.safesearch,
    preferredDomains: options.preferredDomains,
    includeDomains: options.includeDomains,
    excludeDomains: options.excludeDomains,
    maxPerDomain: options.maxPerDomain,
    preferredSourceTypes: options.preferredSourceTypes,
  });
}

function normalizeAnswers(values) {
  return normalizeTextList(array(values).map((answer) => {
    if (typeof answer === "string") return answer;
    if (!answer || typeof answer !== "object") return "";
    return answer.answer || answer.content || answer.text || answer.value || "";
  }), 3, 700);
}

function normalizeTextList(values, maxItems, maxChars) {
  return Array.from(new Set(array(values).map((value) => clipText(String(value || "").trim(), maxChars)).filter(Boolean))).slice(0, maxItems);
}

function normalizeTokenList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(new Set(values.map((item) => cleanToken(item, 64).toLowerCase()).filter(Boolean))).slice(0, 12);
}

function normalizeSourceTypes(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(new Set(values.map((item) => String(item || "").trim().toLowerCase()).filter((item) => SOURCE_TYPES.includes(item)))).slice(0, SOURCE_TYPES.length);
}

function normalizeSourceStrategy(value) {
  const strategy = String(value || "balanced").trim().toLowerCase();
  return ["balanced", "relevance", "primary"].includes(strategy) ? strategy : "balanced";
}

function normalizeDomainList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(new Set(values.map((item) => String(item || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^\.+/, ""))
    .filter((item) => /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(item)))).slice(0, 20);
}

function cleanToken(value, limit) {
  const text = String(value || "").trim();
  if (!text || !/^[\w.-]+$/.test(text)) return "";
  return text.slice(0, limit);
}

function normalizeForMatch(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeForPhrase(value) {
  return normalizeForMatch(value).replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function recentDateBoost(value) {
  if (!value) return 0;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86400000);
  if (ageDays <= 30) return 0.05;
  if (ageDays <= 365) return 0.025;
  return 0;
}

function dedupeEngineStates(values) {
  const output = new Map();
  for (const value of array(values)) {
    if (!value?.engine) continue;
    const existing = output.get(value.engine);
    if (!existing || (value.retryAfterSeconds || 0) > (existing.retryAfterSeconds || 0)) output.set(value.engine, value);
  }
  return Array.from(output.values());
}

function countValues(values) {
  const output = {};
  for (const raw of values) {
    const value = String(raw || "").trim();
    if (!value) continue;
    output[value] = (output[value] || 0) + 1;
  }
  return output;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
  return results;
}

function trimOldest(map, limit) {
  while (map.size > limit) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function isTimeoutError(error) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function safeErrorMessage(error) {
  return clipText(error instanceof Error ? error.message : "Search failed.", 400);
}

function maxNullable(left, right) {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

function numberInRange(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  return integer >= min && integer <= max ? integer : fallback;
}

function numberInRangeFloat(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function automaticPreferredDomains(queryValue) {
  const query = normalizeForMatch(queryValue);
  if (/(国家统计局|中国政府网|政府工作报告|官方数据)/u.test(query)) return ["stats.gov.cn", "gov.cn"];
  return [];
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function clipText(text, max) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

module.exports = {
  canonicalizeUrl,
  classifySource,
  classifyQuality,
  createSearchCoordinator,
  domainMatches,
  normalizeSearchOptions,
  normalizeUnresponsiveEngines,
  queryTokens,
  rankAndSelectResults,
  relevanceScore,
  selectDomainDiverse,
  selectSourceDiverse,
};
