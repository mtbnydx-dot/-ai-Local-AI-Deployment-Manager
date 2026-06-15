const core = require("../../manager-core");

const VLLM_REMOTE_PRECISION_ORDER = [
  "NVFP4",
  "MXFP4",
  "FP8",
  "Q4_K_M",
  "Q5_K_M",
  "Q8_0",
  "IQ4_XS",
  "Q4",
  "IQ4",
  "AWQ",
  "GPTQ",
  "NF4",
  "INT4",
  "BNB-4bit",
  "GGUF",
  "原始 BF16/FP16",
];

const VLLM_REMOTE_QUANT_KEYWORDS = [
  ["nvfp4", "NVFP4"],
  ["mxfp4", "MXFP4"],
  ["fp8", "FP8"],
  ["awq", "AWQ"],
  ["gptq", "GPTQ"],
  ["gguf", "GGUF"],
  ["exl2", "EXL2"],
  ["nf4", "NF4"],
  ["bnb-4bit", "BNB-4bit"],
  ["int4", "INT4"],
  ["int8", "INT8"],
  ["bf16", "BF16"],
  ["fp16", "FP16"],
];

const REMOTE_FEATURE_SEARCHES = {
  distilled: ["distill", "distilled", "R1-Distill"],
  uncensored: ["uncensored", "abliterated", "abliteration"],
  moe: ["MoE", "A3B", "A22B"],
  reasoning: ["reasoning", "thinking", "R1"],
};

function createVllmRemoteModelService({
  fetchImpl = globalThis.fetch,
  getHfToken = () => process.env.HF_TOKEN,
} = {}) {
  function authHeaders(extra = {}) {
    const token = getHfToken();
    return {
      ...extra,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  async function fetchJson(url) {
    const response = await fetchImpl(url, {
      headers: authHeaders({
        accept: "application/json",
        "user-agent": "vllm-manager/0.1",
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Remote request failed (${response.status}): ${text || response.statusText}`);
    }
    return response.json();
  }

  async function fetchJsonPost(url, body, method = "POST") {
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "vllm-manager/0.1",
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
    const search = String(query.search || "").trim();
    const limit = normalizeRemoteLimit(query.limit);
    const size = String(query.size || "").trim();
    const freshness = String(query.freshness || "auto").trim();
    const quant = core.normalizeRemoteQuantFilter(query.quant || legacy.quant);
    const models = source === "modelscope"
      ? await searchModelScopeModels({ sort, task, feature, search, limit, size, quant })
      : await searchHuggingFaceModels({ sort, task, feature, search, limit, size, freshness, quant });
    return { source, sort, task, feature, search, limit, size, freshness, quant, models };
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

  async function searchHuggingFaceModels({ sort, task, feature, search, limit, size, freshness, quant }) {
    const quantFilter = core.normalizeRemoteQuantFilter(quant);
    const profile = {
      engine: "vllm",
      sort,
      task,
      feature,
      minLastModified: remoteFreshnessCutoff(freshness, sort),
    };
    const query = String(search || "").trim();
    const featureSearches = REMOTE_FEATURE_SEARCHES[feature] || [""];
    const baseSearches = query
      ? (feature === "all" ? [query] : unique([...featureSearches.map((term) => `${query} ${term}`), query]))
      : featureSearches;
    const searches = core.remoteSearchesWithQuant(baseSearches, quantFilter);
    const hfSort = sort === "trending" ? "trendingScore" : sort;
    const pipelineTags = task === "text" ? ["text-generation"] : task === "vision" ? ["image-text-to-text"] : [""];
    const seen = new Set();
    const candidates = [];
    const requestLimit = Math.min(100, Math.max(48, limit));

    for (const pipelineTag of pipelineTags) {
      for (const term of searches) {
        const params = new URLSearchParams({
          sort: hfSort,
          direction: "-1",
          limit: String(requestLimit),
          full: "true",
        });
        if (term) params.set("search", term);
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

  async function searchModelScopeModels({ sort, task, feature, search, limit, size, quant }) {
    const quantFilter = core.normalizeRemoteQuantFilter(quant);
    const profile = { engine: "vllm", sort, task, feature, minLastModified: null };
    const query = String(search || "").trim();
    const featureSearches = REMOTE_FEATURE_SEARCHES[feature] || [""];
    const baseSearches = query
      ? (feature === "all" ? [query] : unique([...featureSearches.map((term) => `${query} ${term}`), query]))
      : (feature === "all" ? ["Qwen", "DeepSeek", "GLM", "InternLM", ""] : featureSearches);
    const sortBy = sort === "downloads" ? "DownloadsCount" : sort === "likes" ? "StarsCount" : sort === "lastModified" ? "GmtModified" : "Default";
    const seen = new Set();
    const candidates = [];
    const requestLimit = Math.min(100, Math.max(40, limit));

    for (const term of baseSearches) {
      const body = {
        PageSize: requestLimit,
        PageNumber: 1,
        SortBy: sortBy,
        Name: term || "",
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
    const id = String(raw.Id && raw.Id.includes && raw.Id.includes("/") ? raw.Id : (namespace && name ? `${namespace}/${name}` : (name || raw.Id || ""))).trim();
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
    if (/vl|vision|multimodal|image/.test(lower)) badges.push("multimodal");
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
      hasSafetensors: true,
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
    const siblings = core.filterDownloadSiblings(Array.isArray(data.siblings) ? data.siblings : [], precision);
    const bytes = siblings.reduce((sum, file) => {
      const size = Number(file.size || file.lfs?.size || 0);
      return Number.isFinite(size) && size > 0 ? sum + size : sum;
    }, 0);
    return {
      bytes: bytes || null,
      fileCount: siblings.length,
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
    normalizeRemoteSort,
    normalizeRemoteTask,
    normalizeRemoteFeature,
    normalizeRemoteLimit,
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
    precisionOrder: VLLM_REMOTE_PRECISION_ORDER,
  });
}

function inferManagerRemoteQuantFormats(options) {
  return core.inferRemoteQuantFormats({
    ...options,
    keywords: VLLM_REMOTE_QUANT_KEYWORDS,
  });
}

function legacyRemoteCategoryParams(category) {
  const value = String(category || "").toLowerCase();
  if (value === "latest") return { sort: "lastModified" };
  if (value === "distilled") return { feature: "distilled" };
  if (value === "uncensored") return { feature: "uncensored" };
  if (value === "quantized") return { quant: "quantized" };
  return {};
}

function normalizeRemoteSort(value) {
  const sort = String(value || "trending").trim().toLowerCase();
  if (["downloads", "likes"].includes(sort)) return sort;
  if (["lastmodified", "latest", "updated"].includes(sort)) return "lastModified";
  return "trending";
}

function normalizeRemoteTask(value) {
  const task = String(value || "all").trim().toLowerCase();
  return ["text", "vision"].includes(task) ? task : "all";
}

function normalizeRemoteFeature(value) {
  const feature = String(value || "all").trim().toLowerCase();
  return ["distilled", "uncensored", "moe", "reasoning"].includes(feature) ? feature : "all";
}

function normalizeRemoteLimit(value) {
  const number = Number(value || 48);
  if (!Number.isFinite(number)) return 48;
  return Math.min(120, Math.max(12, Math.floor(number)));
}

function remoteFreshnessCutoff(freshness, sort) {
  const value = String(freshness || "auto").toLowerCase();
  if (value === "all" || value === "any" || value === "none") return null;
  if (value === "2026") return "2026-01-01";
  if (value === "2025") return "2025-01-01";
  if (value === "auto" && sort !== "trending") return "2025-01-01";
  return null;
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
  if (profile.sort === "lastModified") return sorted.slice(0, limit);
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
  const multimodal = model.badges?.includes("multimodal") ? 5 : 0;
  const quant = model.hasQuantizedFiles ? 4 : 0;
  if (profile.sort === "lastModified") return (Number.isFinite(modified) ? modified / 86400000 : 0) + downloads / 100;
  if (profile.sort === "likes") return likes * 4 + downloads / 4 + recency;
  if (profile.sort === "downloads") return downloads + likes / 2 + recency / 2;
  return downloads + likes + recency + multimodal + quant;
}

function isMultimodalModel(model, lower) {
  const tag = String(model.pipeline_tag || "").toLowerCase();
  return ["image-text-to-text", "visual-question-answering", "image-to-text"].includes(tag)
    || /\b(vl|vision|multimodal|omni|image|video)\b/i.test(lower);
}

function unique(values) {
  return Array.from(new Set(values));
}

module.exports = {
  createVllmRemoteModelService,
  VLLM_REMOTE_PRECISION_ORDER,
  VLLM_REMOTE_QUANT_KEYWORDS,
};
