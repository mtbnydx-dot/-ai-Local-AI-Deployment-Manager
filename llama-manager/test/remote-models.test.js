const assert = require("node:assert/strict");
const test = require("node:test");
const { createLlamaRemoteModelService } = require("../lib/remote-models");

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

test("llama remote model service prefers GGUF quant precision ordering", () => {
  const service = createLlamaRemoteModelService();
  const model = service.simplifyHuggingFaceModel({
    id: "bartowski/Qwen3-27B-GGUF",
    author: "bartowski",
    tags: ["gguf"],
    siblings: [
      { rfilename: "Qwen3-27B-Q4_K_M.gguf", size: 10 },
      { rfilename: "Qwen3-27B-Q8_0.gguf", size: 20 },
    ],
  });

  assert.equal(model.hasGguf, true);
  assert.equal(model.hasSafetensors, false);
  assert.equal(model.paramsB, 27);
  assert.equal(model.selection.precision, "Q4_K_M");
  assert.ok(model.quantFormats.includes("GGUF"));
});

test("llama remote model service only returns GGUF-compatible models", async () => {
  const seenUrls = [];
  const service = createLlamaRemoteModelService({
    fetchImpl: async (url) => {
      seenUrls.push(String(url));
      return jsonResponse([
        {
          id: "Qwen/Qwen3-8B-AWQ",
          pipeline_tag: "text-generation",
          siblings: [{ rfilename: "model.safetensors" }],
        },
        {
          id: "bartowski/Qwen3-8B-GGUF",
          author: "bartowski",
          pipeline_tag: "text-generation",
          tags: ["gguf"],
          downloads: 1000,
          siblings: [{ rfilename: "Qwen3-8B-Q4_K_M.gguf" }],
        },
      ]);
    },
  });

  const result = await service.searchRemoteModelCatalog({ search: "Qwen3-8B", limit: 12 });
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, "bartowski/Qwen3-8B-GGUF");
  assert.match(seenUrls[0], /search=Qwen3-8B\+GGUF/);
});

test("llama Hugging Face search honors the vision task while keeping GGUF-only results", async () => {
  const seenUrls = [];
  const service = createLlamaRemoteModelService({
    fetchImpl: async (url) => {
      seenUrls.push(String(url));
      return jsonResponse([
        {
          id: "bartowski/Qwen3-8B-GGUF",
          pipeline_tag: "text-generation",
          tags: ["gguf"],
          siblings: [{ rfilename: "Qwen3-8B-Q4_K_M.gguf" }],
        },
        {
          id: "bartowski/Qwen3-VL-8B-GGUF",
          pipeline_tag: "image-text-to-text",
          tags: ["gguf", "vision"],
          siblings: [{ rfilename: "Qwen3-VL-8B-Q4_K_M.gguf" }],
        },
        {
          id: "Qwen/Qwen3-VL-8B",
          pipeline_tag: "image-text-to-text",
          tags: ["vision"],
          siblings: [{ rfilename: "model.safetensors" }],
        },
      ]);
    },
  });

  const result = await service.searchRemoteModelCatalog({ source: "huggingface", task: "vision", search: "Qwen3", limit: 12 });
  assert.equal(result.source, "huggingface");
  assert.equal(result.task, "vision");
  assert.deepEqual(result.models.map((model) => model.id), ["bartowski/Qwen3-VL-8B-GGUF"]);
  assert.match(seenUrls[0], /pipeline_tag=image-text-to-text/);
  assert.match(seenUrls[0], /search=Qwen3\+GGUF/);
});

test("llama ModelScope search honors source and task with GGUF selection metadata", async () => {
  const requests = [];
  const service = createLlamaRemoteModelService({
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return jsonResponse({
        Data: {
          Model: {
            Models: [
              {
                Id: "community/Qwen3-8B-Q4_K_M-GGUF",
                Path: "community",
                Name: "Qwen3-8B-Q4_K_M-GGUF",
                Tasks: [{ Name: "text-generation" }],
                DownloadsCount: 100,
              },
              {
                Id: "community/Qwen3-VL-8B-Q4_K_M-GGUF",
                Path: "community",
                Name: "Qwen3-VL-8B-Q4_K_M-GGUF",
                Tasks: [{ Name: "image-text-to-text" }],
                Tags: ["vision", "gguf"],
                DownloadsCount: 200,
              },
              {
                Id: "community/Qwen3-VL-8B",
                Path: "community",
                Name: "Qwen3-VL-8B",
                Tasks: [{ Name: "image-text-to-text" }],
                Tags: ["vision"],
              },
            ],
          },
        },
      });
    },
  });

  const result = await service.searchRemoteModelCatalog({ source: "modelscope", task: "vision", search: "Qwen3", limit: 12 });
  assert.equal(result.source, "modelscope");
  assert.equal(result.task, "vision");
  assert.deepEqual(result.models.map((model) => model.id), ["community/Qwen3-VL-8B-Q4_K_M-GGUF"]);
  assert.equal(result.models[0].source, "modelscope");
  assert.equal(result.models[0].hasGguf, true);
  assert.equal(result.models[0].selection.precision, "Q4_K_M");
  assert.equal(requests[0].url, "https://www.modelscope.cn/api/v1/dolphin/models");
  assert.equal(requests[0].options.method, "PUT");
  assert.match(JSON.parse(requests[0].options.body).Name, /Qwen3 GGUF/);
});

test("llama remote model service resolves HF model links", async () => {
  const service = createLlamaRemoteModelService({
    fetchImpl: async () => jsonResponse({
      id: "bartowski/Qwen3-8B-GGUF",
      author: "bartowski",
      tags: ["gguf"],
      siblings: [{ rfilename: "Qwen3-8B-Q4_K_M.gguf" }],
    }),
  });

  const resolved = await service.resolveModelLinkRequest({ url: "https://huggingface.co/bartowski/Qwen3-8B-GGUF" });
  assert.equal(resolved.source, "huggingface");
  assert.equal(resolved.model, "bartowski/Qwen3-8B-GGUF");
  assert.equal(resolved.outputName, "bartowski-Qwen3-8B-GGUF");
});
