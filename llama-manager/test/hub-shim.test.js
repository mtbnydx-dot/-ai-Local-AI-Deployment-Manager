"use strict";

// HUB-13a/b (docs/overhaul/03-hub.md §15, §20): the llama manager's job routes,
// SSE `jobs` relay and model routes as signed hub shims, against a fake hub that verifies every
// signature with internal-auth.js. Temporary AI root and ports only; no live
// service is called and no process is spawned.

const path = require("node:path");
const express = require("express");
const { runHubShimSuite } = require("../../manager-core/test/helpers/hub-shim-suite");
const { runHubShimRoutesSuite } = require("../../manager-core/test/helpers/hub-shim-routes-suite");

runHubShimSuite({ managerId: "llama", serverPath: path.join(__dirname, "..", "server.js"), express });
// HUB-13b: every other row of the 03 §15 table, against a fake hub.
runHubShimRoutesSuite({ managerId: "llama", express });

// HUB-13b: the shim's catalogue summary carries every key the legacy summary did
// (plus runnable) and agrees with it where the hub knows the value.
const test = require("node:test");
const assert = require("node:assert/strict");
const compat = require("../../manager-core/model-hub/compat");
const { createLlamaRemoteModelService, LLAMA_REMOTE_PRECISION_ORDER, LLAMA_REMOTE_QUANT_KEYWORDS } = require("../lib/remote-models");

test("toLegacyRemoteModel keeps the legacy catalogue summary keys", () => {
  const raw = require("../../manager-core/test/fixtures/hub/hf-gguf-multiquant.json");
  const legacy = createLlamaRemoteModelService().simplifyHuggingFaceModel(raw);
  const mapped = compat.toLegacyRemoteModel({
    provider: "huggingface",
    repo: raw.id,
    author: raw.author,
    task: raw.pipeline_tag,
    formats: ["gguf"],
    quants: ["Q4_K_M"],
    paramsB: legacy.paramsB,
    downloads: raw.downloads,
    likes: raw.likes,
    lastModified: raw.lastModified,
    gated: raw.gated,
    tags: raw.tags,
    engines: ["llamacpp"],
  }, { managerId: "llama", precisionOrder: LLAMA_REMOTE_PRECISION_ORDER, quantKeywords: LLAMA_REMOTE_QUANT_KEYWORDS });
  assert.deepEqual(Object.keys(mapped).filter((key) => key !== "runnable").sort(), Object.keys(legacy).sort());
  for (const key of ["id", "model", "label", "author", "url", "tags", "downloads", "likes", "gated", "pipelineTag", "lastModified", "hasGguf", "paramsB", "sizeClass", "outputName", "source"]) {
    assert.deepEqual(mapped[key], legacy[key], key);
  }
  assert.equal(mapped.runnable, "llama" === "llama");
});
