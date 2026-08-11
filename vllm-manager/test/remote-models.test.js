const assert = require("node:assert/strict");
const test = require("node:test");
const { createVllmRemoteModelService } = require("../lib/remote-models");

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

test("vLLM remote model service simplifies HF metadata with vLLM precision ordering", () => {
  const service = createVllmRemoteModelService();
  const model = service.simplifyHuggingFaceModel({
    id: "Qwen/Qwen3.6-27B-Text-NVFP4-MTP",
    author: "QwenLM",
    tags: ["text-generation"],
    downloads: 100,
    likes: 5,
    pipeline_tag: "text-generation",
    siblings: [
      { rfilename: "config.json" },
      { rfilename: "model-00001-of-00002.safetensors", size: 10 },
    ],
  });

  assert.equal(model.id, "Qwen/Qwen3.6-27B-Text-NVFP4-MTP");
  assert.equal(model.hasSafetensors, true);
  assert.equal(model.hasGguf, false);
  assert.equal(model.paramsB, 27);
  assert.equal(model.selection.precision, "NVFP4");
  assert.ok(model.quantFormats.includes("NVFP4"));
});

test("vLLM remote model service filters unsupported HF models during search", async () => {
  const seenUrls = [];
  const service = createVllmRemoteModelService({
    fetchImpl: async (url) => {
      seenUrls.push(String(url));
      return jsonResponse([
        {
          id: "org/embedding-model",
          pipeline_tag: "sentence-similarity",
          siblings: [{ rfilename: "model.safetensors" }],
        },
        {
          id: "Qwen/Qwen3-8B-AWQ",
          author: "QwenLM",
          pipeline_tag: "text-generation",
          tags: ["text-generation"],
          downloads: 1000,
          siblings: [{ rfilename: "model.safetensors" }],
        },
      ]);
    },
  });

  const result = await service.searchRemoteModelCatalog({ search: "Qwen", quant: "AWQ", limit: 12 });
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, "Qwen/Qwen3-8B-AWQ");
  assert.match(seenUrls[0], /search=Qwen\+AWQ/);
});

test("vLLM remote model service estimates selected HF download files", async () => {
  const service = createVllmRemoteModelService({
    fetchImpl: async () => jsonResponse({
      siblings: [
        { rfilename: "model-Q4_K_M.gguf", size: 10 },
        { rfilename: "model-Q8_0.gguf", size: 20 },
        { rfilename: "tokenizer.json", size: 5 },
      ],
    }),
  });

  const estimate = await service.getHuggingFaceDownloadEstimate("owner/model", "Q4");
  assert.equal(estimate.bytes, 10);
  assert.equal(estimate.fileCount, 1);
  assert.deepEqual(estimate.includePatterns, ["*Q4*.gguf", "*IQ4*.gguf"]);
  assert.equal(estimate.filtered, true);
  assert.equal(estimate.matchedFiles, 1);
  assert.equal(estimate.totalFiles, 3);
});
