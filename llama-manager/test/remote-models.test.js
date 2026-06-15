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
