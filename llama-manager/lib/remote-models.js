const core = require("../../manager-core");

const LLAMA_REMOTE_PRECISION_ORDER = [
  "Q4_K_M",
  "Q5_K_M",
  "Q8_0",
  "IQ4_XS",
  "Q4",
  "IQ4",
  "Q6_K",
  "Q3_K_M",
  "Q2_K",
  "NVFP4",
  "MXFP4",
  "FP8",
  "AWQ",
  "GPTQ",
  "NF4",
  "INT4",
  "GGUF",
  "原始 BF16/FP16",
];

const LLAMA_REMOTE_QUANT_KEYWORDS = [
  ["gguf", "GGUF"],
  ["q4_k_m", "Q4_K_M"],
  ["q8_0", "Q8_0"],
  ["q5_k_m", "Q5_K_M"],
  ["iq4_xs", "IQ4_XS"],
  ["q6_k", "Q6_K"],
  ["q3_k_m", "Q3_K_M"],
  ["q2_k", "Q2_K"],
  ["awq", "AWQ"],
  ["gptq", "GPTQ"],
  ["fp8", "FP8"],
  ["nf4", "NF4"],
  ["int4", "INT4"],
  ["int8", "INT8"],
  ["bf16", "BF16"],
  ["fp16", "FP16"],
];

const REMOTE_FEATURE_SEARCHES = {
  distilled: ["distill", "distilled", "R1-Distill"],
  uncensored: ["uncensored", "abliterated", "abliteration", "unfiltered", "no-filter", "nofilter", "uncens"],
  moe: ["MoE", "A3B", "A22B"],
  reasoning: ["reasoning", "thinking", "R1"],
  quantized: ["GGUF", "Q4_K_M", "Q8_0", "Q5_K_M", "IQ4_XS"],
};

function createLlamaRemoteModelService({
  fetchImpl = globalThis.fetch,
  getHfToken = () => process.env.HF_TOKEN,
} = {}) {
  const useSystemProxyFallback = fetchImpl === globalThis.fetch;

  function remoteFetch(url, options) {
    return core.fetchWithSystemProxyFallback(fetchImpl, url, options, {
      allowProxyFallback: useSystemProxyFallback,
    });
  }

  async function fetchJson(url) {
    const token = getHfToken();
    const response = await remoteFetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "llama-manager/0.1",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Remote request failed (${response.status}): ${text || response.statusText}`);
    }
    return response.json();
  }

  async function fetchJsonPost(url, body, method = "POST") {
    const response = await remoteFetch(url, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "llama-manager/0.1",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Remote request failed (${response.status}): ${text.slice(0, 200) || response.statusText}`);
    }
    return response.json();
  }

  async function searchRemoteModelCatalog(query = {}) {
    const source = core.cleanDownloadSource(query.source || "huggingface");
    const legacy = legacyRemoteCategoryParams(String(query.category || ""));
    const sort = normalizeRemoteSort(query.sort || legacy.sort);
    const task = normalizeRemoteTask(query.task || legacy.task);
    const feature = normalizeRemoteFeature(query.feature || legacy.feature);
    const category = feature === "all" ? (sort === "lastModified" ? "latest" : "popular") : feature;
    const search = String(query.search || "").trim();
    const limit = normalizeRemoteLimit(query.limit);
    const size = String(query.size || "").trim();
    const freshness = String(query.freshness || "auto").trim();
    const quant = core.normalizeRemoteQuantFilter(query.quant || legacy.quant);
    const models = source === "modelscope"
      ? await searchModelScopeModels({ category, sort, task, feature, search, limit, size, quant })
      : await searchHuggingFaceModels({ category, sort, task, feature, search, limit, size, freshness, quant });
    return { source, category, sort, task, feature, search, limit, size, freshness, quant, models };
  }

  async function resolveModelLinkRequest(body = {}) {
    const input = core.cleanRequired(body.url, "url");
    const reference = core.parseModelReference(input);
    if (reference.source === "huggingface") {
      const info = await getHuggingFaceModelInfo(reference.model);
      return {
        ...reference,
        ...info,
        outputName: core.safeOutputName(reference.model.replace(/[\\/]/g, "-")),
      };
    }
    return {
      ...reference,
      label: reference.model,
      url: reference.url,
      tags: [],
      downloads: null,
      likes: null,
      lastModified: null,
      summary: "已从 ModelScope 链接解析出模型 ID。下载时会使用 ModelScope 来源。",
      selection: inferRemoteModelSelection({
        id: reference.model,
        author: reference.model.split("/")[0],
        source: "modelscope",
      }),
      outputName: core.safeOutputName(reference.model.replace(/[\\/]/g, "-")),
    };
  }

  async function searchHuggingFaceModels({ category, sort, task = "all", feature = "all", search, limit, size, freshness, quant }) {
    const profile = remoteSearchProfile(category, search, freshness);
    profile.sort = normalizeRemoteSort(sort || profile.sort);
    profile.task = normalizeRemoteTask(task);
    profile.feature = normalizeRemoteFeature(feature);
    profile.search = featureAwareGgufSearches(profile.search, search, profile.feature);
    const quantFilter = core.normalizeRemoteQuantFilter(quant);
    const searches = core.remoteSearchesWithQuant(Array.isArray(profile.search) ? profile.search : [profile.search], quantFilter);
    const pipelineTags = profile.task === "text" ? ["text-generation"] : profile.task === "vision" ? ["image-text-to-text"] : [""];
    const seen = new Set();
    const candidates = [];
    const requestLimit = Math.min(100, Math.max(48, limit));

    for (const pipelineTag of pipelineTags) {
      for (const query of searches) {
        const params = new URLSearchParams({
          sort: profile.sort === "trending" ? "trendingScore" : profile.sort,
          direction: "-1",
          limit: String(requestLimit),
          full: "true",
        });
        if (query) params.set("search", query);
        if (pipelineTag) params.set("pipeline_tag", pipelineTag);
        const data = await fetchJson(`https://huggingface.co/api/models?${params}`);
        for (const model of Array.isArray(data) ? data : []) {
          const id = model.modelId || model.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const summary = simplifyHuggingFaceModel(model);
          if (!isRemoteModelCandidate(summary, profile, size, quantFilter)) continue;
          candidates.push(summary);
        }
      }
    }

    return rankAndLimitRemoteModels(candidates, profile, limit);
  }

  async function searchModelScopeModels({ category, sort, task = "all", feature = "all", search, limit, size, quant }) {
    const profile = remoteSearchProfile(category, search, "all");
    profile.sort = normalizeRemoteSort(sort || profile.sort);
    profile.task = normalizeRemoteTask(task);
    profile.feature = normalizeRemoteFeature(feature);
    profile.search = featureAwareGgufSearches(profile.search, search, profile.feature);
    const quantFilter = core.normalizeRemoteQuantFilter(quant);
    const baseSearches = Array.isArray(profile.search) ? profile.search : [profile.search];
    const searches = core.remoteSearchesWithQuant(baseSearches.filter(Boolean).length ? baseSearches : ["GGUF"], quantFilter);
    const sortBy = profile.sort === "downloads" ? "DownloadsCount" : profile.sort === "likes" ? "StarsCount" : profile.sort === "lastModified" ? "GmtModified" : "Default";
    const seen = new Set();
    const candidates = [];
    const requestLimit = Math.min(100, Math.max(40, limit));

    for (const term of unique(searches)) {
      const body = {
        PageSize: requestLimit,
        PageNumber: 1,
        SortBy: sortBy,
        Name: term || "GGUF",
        Criterion: [],
        SingleCriterion: [],
        Target: "",
      };
      let data;
      try {
        data = await fetchJsonPost("https://www.modelscope.cn/api/v1/dolphin/models", body, "PUT");
      } catch (error) {
        if (candidates.length) break;
        throw new Error(`ModelScope 查询失败：${error.message}`);
      }
      const list = data?.Data?.Model?.Models || data?.Data?.Models || data?.Data?.model?.Models || [];
      for (const raw of Array.isArray(list) ? list : []) {
        const summary = simplifyModelScopeModel(raw);
        if (!summary?.id || seen.has(summary.id)) continue;
        seen.add(summary.id);
        if (!isRemoteModelCandidate(summary, profile, size, quantFilter)) continue;
        candidates.push(summary);
      }
    }

    return rankAndLimitRemoteModels(candidates, profile, limit);
  }

  function simplifyModelScopeModel(raw) {
    if (!raw || typeof raw !== "object") return null;
    const namespace = raw.Path || raw.Namespace || raw.Organization || raw.OrganizationName || (raw.Owner && (raw.Owner.Name || raw.Owner)) || "";
    const name = raw.Name || raw.ModelName || "";
    const rawId = String(raw.Id || "");
    const id = String(rawId.includes("/") ? rawId : (namespace && name ? `${namespace}/${name}` : (name || rawId))).trim();
    if (!id) return null;
    const tags = []
      .concat(Array.isArray(raw.Tasks) ? raw.Tasks.map((item) => item?.Name || item) : [])
      .concat(Array.isArray(raw.Tags) ? raw.Tags : [])
      .map(String)
      .filter(Boolean);
    const lower = `${id} ${tags.join(" ")}`.toLowerCase();
    const quantFormats = inferManagerRemoteQuantFormats({ id, tags, siblings: [] });
    const lastModifiedMs = Number(raw.LastUpdatedTime || raw.GmtModified || raw.LastModifiedTime || 0);
    const lastModified = lastModifiedMs ? new Date(lastModifiedMs * (lastModifiedMs < 1e12 ? 1000 : 1)).toISOString() : "";
    const paramsB = core.inferRemoteParamsB(id);
    const badges = [];
    if (lower.includes("distill")) badges.push("distilled");
    if (core.isUncensoredText(lower)) badges.push("uncensored");
    if (/\b(?:vl|vision|multimodal|omni|image|video)\b/i.test(lower)) badges.push("multimodal");
    badges.push(...quantFormats.slice(0, 5));
    return {
      source: "modelscope",
      model: id,
      id,
      label: id,
      author: namespace || id.split("/")[0],
      url: `https://modelscope.cn/models/${id}`,
      tags,
      badges,
      downloads: Number(raw.Downloads || raw.DownloadsCount || 0),
      likes: Number(raw.Stars || raw.StarsCount || raw.Likes || 0),
      gated: false,
      pipelineTag: Array.isArray(raw.Tasks) && raw.Tasks[0] ? String(raw.Tasks[0].Name || raw.Tasks[0]) : "",
      libraryName: "",
      lastModified,
      createdAt: "",
      hasConfig: true,
      hasSafetensors: false,
      hasGguf: /gguf/.test(lower),
      hasQuantizedFiles: core.hasQuantizedRemoteFiles(quantFormats),
      quantFormats,
      paramsB,
      sizeClass: core.remoteSizeClass(paramsB),
      fileSizeBytes: null,
      largestFileBytes: null,
      fileCount: null,
      summary: raw.ChineseName || raw.Description || "",
      selection: inferRemoteModelSelection({ id, author: namespace || id.split("/")[0], tags, source: "modelscope", quantFormats }),
      outputName: core.safeOutputName(id.replace(/[\\/]/g, "-")),
    };
  }

  async function getHuggingFaceModelInfo(modelId) {
    const data = await fetchJson(`https://huggingface.co/api/models/${core.encodeRepoId(modelId)}`);
    return simplifyHuggingFaceModel(data);
  }

  async function getHuggingFaceDownloadEstimate(modelId, precision = "") {
    const data = await fetchJson(`https://huggingface.co/api/models/${core.encodeRepoId(modelId)}?blobs=true`);
    const selected = core.selectDownloadSiblings(Array.isArray(data.siblings) ? data.siblings : [], precision);
    const siblings = selected.siblings;
    const bytes = siblings.reduce((sum, file) => {
      const size = Number(file.size || file.lfs?.size || 0);
      return Number.isFinite(size) && size > 0 ? sum + size : sum;
    }, 0);
    return {
      bytes: bytes || null,
      fileCount: siblings.length,
      includePatterns: selected.includePatterns,
      filtered: selected.filtered,
      matchedFiles: selected.matched,
      totalFiles: selected.total,
    };
  }

  function simplifyHuggingFaceModel(model) {
    const id = model.modelId || model.id;
    const tags = Array.isArray(model.tags) ? model.tags : [];
    const siblings = Array.isArray(model.siblings) ? model.siblings : [];
    const author = model.author || id.split("/")[0];
    const lower = `${id} ${tags.join(" ")} ${siblings.map((item) => item.rfilename || "").join(" ")}`.toLowerCase();
    const quantFormats = inferManagerRemoteQuantFormats({ id, tags, siblings });
    const selection = inferRemoteModelSelection({
      id,
      author,
      tags,
      siblings,
      source: "huggingface",
      quantFormats,
    });
    const paramsB = core.inferRemoteParamsB(`${id} ${siblings.map((item) => item.rfilename || "").join(" ")}`);
    const fileSizeBytes = siblings.reduce((sum, file) => {
      const size = Number(file.size || file.lfs?.size || 0);
      return Number.isFinite(size) && size > 0 ? sum + size : sum;
    }, 0);
    const largestFileBytes = siblings.reduce((max, file) => {
      const size = Number(file.size || file.lfs?.size || 0);
      return Number.isFinite(size) && size > max ? size : max;
    }, 0);
    const badges = [];
    if (lower.includes("distill")) badges.push("distilled");
    if (core.isUncensoredText(lower)) badges.push("uncensored");
    if (isMultimodalModel(model, lower)) badges.push("multimodal");
    badges.push(...quantFormats.slice(0, 5));
    if (model.gated) badges.push("gated");
    return {
      source: "huggingface",
      model: id,
      id,
      label: id,
      author,
      url: `https://huggingface.co/${id}`,
      tags,
      badges,
      downloads: Number(model.downloads || 0),
      likes: Number(model.likes || 0),
      gated: Boolean(model.gated),
      pipelineTag: model.pipeline_tag || "",
      libraryName: model.library_name || "",
      lastModified: model.lastModified || model.createdAt || "",
      createdAt: model.createdAt || "",
      hasConfig: siblings.some((item) => item.rfilename === "config.json"),
      hasSafetensors: siblings.some((item) => String(item.rfilename || "").endsWith(".safetensors")),
      hasGguf: siblings.some((item) => String(item.rfilename || "").toLowerCase().endsWith(".gguf")),
      hasQuantizedFiles: core.hasQuantizedRemoteFiles(quantFormats),
      quantFormats,
      paramsB,
      sizeClass: core.remoteSizeClass(paramsB),
      fileSizeBytes: fileSizeBytes || null,
      largestFileBytes: largestFileBytes || null,
      fileCount: siblings.length,
      summary: model.cardData?.summary || model.cardData?.language || "",
      selection,
      outputName: core.safeOutputName(id.replace(/[\\/]/g, "-")),
    };
  }

  return {
    legacyRemoteCategoryParams,
    normalizeRemoteLimit,
    normalizeRemoteSort,
    normalizeRemoteTask,
    normalizeRemoteFeature,
    remoteSearchProfile,
    searchRemoteModelCatalog,
    resolveModelLinkRequest,
    searchHuggingFaceModels,
    searchModelScopeModels,
    simplifyHuggingFaceModel,
    simplifyModelScopeModel,
    getHuggingFaceModelInfo,
    getHuggingFaceDownloadEstimate,
    isRemoteModelCandidate,
    rankAndLimitRemoteModels,
  };
}

function inferRemoteModelSelection(options) {
  return core.inferModelSelection({
    ...options,
    precisionOrder: LLAMA_REMOTE_PRECISION_ORDER,
  });
}

function inferManagerRemoteQuantFormats(options) {
  return core.inferRemoteQuantFormats({
    ...options,
    keywords: LLAMA_REMOTE_QUANT_KEYWORDS,
  });
}

function legacyRemoteCategoryParams(category) {
  const value = String(category || "").trim().toLowerCase();
  if (value === "latest") return { sort: "lastModified" };
  if (["distilled", "uncensored", "quantized", "moe", "reasoning"].includes(value)) return { feature: value };
  return {};
}

function normalizeRemoteLimit(value) {
  const number = Number(value || 48);
  if (!Number.isFinite(number)) return 48;
  return Math.min(120, Math.max(12, Math.floor(number)));
}

function normalizeRemoteSort(value) {
  const sort = String(value || "downloads").trim().toLowerCase();
  if (["downloads", "likes"].includes(sort)) return sort;
  if (["lastmodified", "latest", "updated"].includes(sort)) return "lastModified";
  if (sort === "trending") return "trending";
  return "downloads";
}

function normalizeRemoteTask(value) {
  const task = String(value || "all").trim().toLowerCase();
  return ["text", "vision"].includes(task) ? task : "all";
}

function normalizeRemoteFeature(value) {
  const feature = String(value || "all").trim().toLowerCase();
  if (["distilled", "uncensored", "quantized", "moe", "reasoning"].includes(feature)) return feature;
  return "all";
}

function remoteSearchProfile(category, search, freshness = "auto") {
  const rawQuery = String(search || "").trim();
  const query = rawQuery && /gguf/i.test(rawQuery) ? rawQuery : rawQuery ? `${rawQuery} GGUF` : "";
  const minLastModified = remoteFreshnessCutoff(freshness, category);
  if (query) {
    return {
      engine: "llama",
      category: "search",
      search: query,
      sort: "downloads",
      minLastModified,
      requireGguf: true,
    };
  }
  if (category === "latest") {
    return {
      engine: "llama",
      category,
      search: ["GGUF", "Qwen GGUF", "Llama GGUF", "DeepSeek GGUF", "Gemma GGUF", "Mistral GGUF"],
      sort: "lastModified",
      minLastModified,
      requireGguf: true,
    };
  }
  if (category === "distilled") {
    return {
      engine: "llama",
      category,
      search: ["GGUF distill", "GGUF distilled", "GGUF R1-Distill", "Qwen GGUF Distill", "DeepSeek GGUF Distill"],
      sort: "downloads",
      minLastModified,
      requireGguf: true,
    };
  }
  if (category === "uncensored") {
    return {
      engine: "llama",
      category,
      search: ["GGUF uncensored", "GGUF abliterated", "GGUF abliteration", "GGUF unfiltered", "GGUF no-filter", "GGUF nofilter", "GGUF uncens"],
      sort: "downloads",
      minLastModified,
      requireGguf: true,
    };
  }
  if (category === "quantized") {
    return {
      engine: "llama",
      category,
      search: ["GGUF", "Q4_K_M", "Q8_0", "Q5_K_M", "IQ4_XS"],
      sort: "downloads",
      minLastModified,
      requireGguf: true,
      requireQuantized: true,
    };
  }
  if (category === "moe" || category === "reasoning") {
    const featureSearches = REMOTE_FEATURE_SEARCHES[category] || [category];
    return {
      engine: "llama",
      category,
      search: featureSearches.map((term) => `GGUF ${term}`),
      sort: "downloads",
      minLastModified,
      requireGguf: true,
    };
  }
  return {
    engine: "llama",
    category: "popular",
    search: ["GGUF", "Qwen GGUF", "Llama GGUF", "DeepSeek GGUF", "Gemma GGUF", "Mistral GGUF"],
    sort: "downloads",
    minLastModified,
    requireGguf: true,
  };
}

function remoteFreshnessCutoff(freshness, category) {
  const value = String(freshness || "auto").toLowerCase();
  if (value === "all" || value === "any" || value === "none") return null;
  if (value === "2026") return "2026-01-01";
  if (value === "2025") return "2025-01-01";
  if (value === "auto" && (category === "latest" || category === "quantized")) return "2025-01-01";
  return null;
}

function featureAwareGgufSearches(profileSearch, search, feature) {
  const rawSearch = String(search || "").trim();
  const existing = Array.isArray(profileSearch) ? profileSearch : [profileSearch];
  if (!rawSearch || feature === "all") return existing;
  const terms = REMOTE_FEATURE_SEARCHES[feature] || [];
  return unique([
    ...terms.map((term) => `${rawSearch} ${term} GGUF`),
    /gguf/i.test(rawSearch) ? rawSearch : `${rawSearch} GGUF`,
  ]);
}

function isRemoteModelCandidate(model, profile, sizeFilter, quantFilter = "") {
  if (!model?.id) return false;
  if (!remotePipelineAllowed(model, profile.engine)) return false;
  if (profile.requireGguf && !model.hasGguf) return false;
  if (profile.requireQuantized && !model.hasQuantizedFiles) return false;
  if (profile.minLastModified && !core.isAfterDate(model.lastModified || model.createdAt, profile.minLastModified)) return false;
  if (profile.task && profile.task !== "all" && !matchesRemoteTask(model, profile.task)) return false;
  if (profile.feature && profile.feature !== "all" && !matchesRemoteFeature(model, profile.feature)) return false;
  if (sizeFilter && !core.matchesRemoteSizeFilter(model, sizeFilter)) return false;
  if (quantFilter && !core.matchesRemoteQuantFilter(model, quantFilter)) return false;
  return true;
}

function matchesRemoteTask(model, task) {
  const isVision = (model.badges || []).includes("multimodal")
    || ["image-text-to-text", "visual-question-answering", "image-to-text", "any-to-any"].includes(String(model.pipelineTag || "").toLowerCase());
  return task === "vision" ? isVision : !isVision;
}

function matchesRemoteFeature(model, feature) {
  const text = `${model.id} ${(model.tags || []).join(" ")}`.toLowerCase();
  if (feature === "distilled") return (model.badges || []).includes("distilled") || /distill/.test(text);
  if (feature === "uncensored") return (model.badges || []).includes("uncensored") || core.isUncensoredText(text);
  if (feature === "quantized") return Boolean(model.hasQuantizedFiles);
  if (feature === "moe") return /\bmoe\b|mixture-of-expert|\ba\d{1,3}b\b|-a\d{1,3}b/.test(text);
  if (feature === "reasoning") return /reasoning|thinking|\br1\b|qwq|deepseek-r1|-think/.test(text);
  return true;
}

function remotePipelineAllowed(model, engine) {
  const tag = String(model.pipelineTag || "").toLowerCase();
  const tags = (model.tags || []).map((item) => String(item).toLowerCase());
  const id = String(model.id || "").toLowerCase();
  if (/(^|[\/_.\-\s])(embed|embedding|rerank|reranker|ranker)/.test(id)) return false;
  if (["sentence-similarity", "text-ranking", "translation", "summarization", "question-answering", "fill-mask", "feature-extraction", "text-classification", "token-classification", "zero-shot-classification", "image-classification", "zero-shot-image-classification", "image-feature-extraction", "text-to-image", "image-to-image", "automatic-speech-recognition", "text-to-speech"].includes(tag)) return false;
  if (engine === "llama") return model.hasGguf;
  if (["text-generation", "image-text-to-text", "visual-question-answering", "image-to-text", "text2text-generation", "conversational"].includes(tag)) return true;
  if (!tag && (model.hasSafetensors || model.hasGguf || model.hasConfig)) return true;
  if (tags.some((item) => ["text-generation", "transformers", "safetensors", "gguf"].includes(item))) return true;
  return false;
}

function rankAndLimitRemoteModels(models, profile, limit) {
  const sorted = models
    .map((model) => ({ model, score: remoteModelScore(model, profile) }))
    .sort((a, b) => b.score - a.score || String(b.model.lastModified || "").localeCompare(String(a.model.lastModified || "")))
    .map((item) => item.model);
  if (profile.category !== "popular") return sorted.slice(0, limit);
  const familyCounts = new Map();
  const selected = [];
  const skipped = [];
  for (const model of sorted) {
    const key = core.remoteFamilyKey(model);
    const count = familyCounts.get(key) || 0;
    if (count >= 4) {
      skipped.push(model);
      continue;
    }
    familyCounts.set(key, count + 1);
    selected.push(model);
    if (selected.length >= limit) return selected;
  }
  return [...selected, ...skipped].slice(0, limit);
}

function remoteModelScore(model, profile) {
  const downloads = Math.log10(Number(model.downloads || 0) + 10) * 20;
  const likes = Math.log10(Number(model.likes || 0) + 10) * 5;
  const modified = new Date(model.lastModified || model.createdAt || 0).getTime();
  const recency = Number.isFinite(modified) ? Math.max(0, (modified - Date.UTC(2024, 0, 1)) / 86400000) / 80 : 0;
  const quant = model.hasQuantizedFiles ? 4 : 0;
  if (profile.sort === "lastModified") return (Number.isFinite(modified) ? modified / 86400000 : 0) + downloads / 100;
  return downloads + likes + recency + quant;
}

function isMultimodalModel(model, lower) {
  const tag = String(model.pipeline_tag || "").toLowerCase();
  return ["image-text-to-text", "visual-question-answering", "image-to-text", "any-to-any"].includes(tag)
    || /\b(vl|vision|multimodal|omni|image|video)\b/i.test(lower);
}

function unique(values) {
  return Array.from(new Set(values));
}

module.exports = {
  createLlamaRemoteModelService,
  LLAMA_REMOTE_PRECISION_ORDER,
  LLAMA_REMOTE_QUANT_KEYWORDS,
};
