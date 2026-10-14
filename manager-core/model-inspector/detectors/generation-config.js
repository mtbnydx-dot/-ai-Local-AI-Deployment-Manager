"use strict";

// Sampling defaults (docs/overhaul/02-models.md §5): generation_config.json
// for Hugging Face checkpoints, general.sampling.* for GGUF files. The values
// are what the checkpoint recommends, recorded as declared facts; family
// knowledge may override them later (02 §8.2 `sampling`).

const { readJsonFile } = require("./inventory");

const SAMPLING_KEYS = Object.freeze(["temperature", "top_p", "top_k", "min_p", "repetition_penalty"]);
// llama.cpp's general.sampling.* names for the same values.
const GGUF_SAMPLING_KEYS = Object.freeze({
  temp: "temperature",
  top_p: "top_p",
  top_k: "top_k",
  min_p: "min_p",
  penalty_repeat: "repetition_penalty",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// GGUF stores these as float32: 0.95 reads back as 0.949999988...; six
// decimals is what llama.cpp prints.
function roundFloat32(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** generation_config.json -> /sampling/* facts; returns the parsed file or null. */
function detectGenerationConfig(inv, facts) {
  const config = readJsonFile(inv, "generation_config.json", facts);
  if (!isPlainObject(config)) return null;
  let found = false;
  for (const key of SAMPLING_KEYS) {
    const value = finiteNumber(config[key]);
    if (value === null) continue;
    facts.set(`/sampling/${key}`, value, { kind: "file", ref: `generation_config.json#/${key}` }, "declared");
    found = true;
  }
  if (found) facts.set("/sampling/source", "generation_config.json", { kind: "file", ref: "generation_config.json" }, "declared");
  return config;
}

/** GGUF general.sampling.* -> /sampling/* facts (when no generation_config.json set them). */
function detectGgufSampling(kv, file, facts) {
  if (facts.get("/sampling/source")) return;
  let found = false;
  for (const [suffix, key] of Object.entries(GGUF_SAMPLING_KEYS)) {
    const value = finiteNumber(kv?.[`general.sampling.${suffix}`]);
    if (value === null) continue;
    facts.set(`/sampling/${key}`, roundFloat32(value), { kind: "gguf", ref: `${file}#general.sampling.${suffix}` }, "declared");
    found = true;
  }
  if (found) facts.set("/sampling/source", "gguf", { kind: "gguf", ref: file }, "declared");
}

module.exports = {
  GGUF_SAMPLING_KEYS,
  SAMPLING_KEYS,
  detectGenerationConfig,
  detectGgufSampling,
};
