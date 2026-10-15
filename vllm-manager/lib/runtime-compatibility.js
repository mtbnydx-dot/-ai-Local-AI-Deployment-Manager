const { getRuntimeRelease } = require("../../manager-core/runtime-manifest");
const {
  assessRuntimeGate,
  compareVersions,
  normalizeArchitecture,
  parseNvidiaCompatibilityCsv,
  probeNvidiaCompatibility: probeNvidiaRuntimeCompatibility,
} = require("../../manager-core/engines/runtime-supervisor");

// Pinned releases come from manager-core/data/runtime-manifest.json (with the
// config/ override); the manifest module keeps the last known-good values as a
// fallback, so these stay frozen objects with the same shape as before.
const DEFAULT_VLLM_RELEASE = getRuntimeRelease("vllm");
const DEFAULT_SGLANG_RELEASE = getRuntimeRelease("sglang");
const DEFAULT_SGLANG_FLASH_NEXT_RELEASE = getRuntimeRelease("sglangFlashNext");

function defaultVllmImageReference(release = DEFAULT_VLLM_RELEASE) {
  return `${release.repository}@${release.platformDigest}`;
}

// The vLLM flavour of the shared runtime gate (01 §14 stage 1, ENG-11): the
// pinned vLLM release's minimums apply to images without their own, the
// image must be digest-pinned (warning) and an unknown image is a warning
// that its CUDA stack cannot be verified. The supervisor runs the same gate
// with these options for every vLLM/SGLang start.
const VLLM_GATE_OPTIONS = Object.freeze({
  engineLabel: "vLLM",
  fallbackRelease: DEFAULT_VLLM_RELEASE,
  checkImagePin: true,
  unknownRelease: Object.freeze({
    title: "Image CUDA metadata",
    detail: "This image is an override or an unrecognized build. The manager cannot automatically verify its CUDA, PyTorch, Transformers, architecture, or driver requirements; verify the image metadata manually.",
  }),
  describeRelease: (release) => `${release.version || "known build"} / CUDA ${release.cudaVersion || "?"} / PyTorch ${release.torchVersion || "?"} / Transformers ${release.transformersVersion || "?"}`,
});

/** { probe, selectedGpuIds, imageReference, imageMetadata, hostPlatform, hostArch, allowAnyCompatibleGpu } → gate assessment. */
function assessVllmRuntimeCompatibility(options = {}) {
  return assessRuntimeGate({
    ...VLLM_GATE_OPTIONS,
    ...options,
    release: options.imageMetadata || null,
  });
}

module.exports = {
  DEFAULT_SGLANG_FLASH_NEXT_RELEASE,
  DEFAULT_SGLANG_RELEASE,
  DEFAULT_VLLM_RELEASE,
  VLLM_GATE_OPTIONS,
  assessVllmRuntimeCompatibility,
  compareVersions,
  defaultVllmImageReference,
  normalizeArchitecture,
  parseNvidiaCompatibilityCsv,
  probeNvidiaRuntimeCompatibility,
};
