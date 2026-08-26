const DEFAULT_VLLM_RELEASE = Object.freeze({
  version: "v0.28.0",
  repository: "vllm/vllm-openai",
  manifestDigest: "sha256:61fc8a896b0a4fbbbdc063bc4b0dbc25ce98e02b5050c24aeb7830ac02039b14",
  platformDigest: "sha256:2286e8533ca8b6bc777594bae30524f1426ba46ca21797524e06df6a94b06635",
  platform: "linux/amd64",
  cudaVersion: "13.0.2",
  torchVersion: "2.13.0",
  transformersVersion: "5.15.1",
  bitsAndBytesPlugin: false,
  minimumComputeCapability: "7.5",
  minimumBlackwellCudaVersion: "12.8",
  minimumDriverVersions: Object.freeze({
    win32: "580.88",
    linux: "580.65.06",
  }),
});

const DEFAULT_SGLANG_RELEASE = Object.freeze({
  version: "0.5.17",
  repository: "lmsysorg/sglang",
  manifestDigest: "",
  platformDigest: "sha256:3ea7c6d74312d964edbcf9b3819425ea42117eb967ef1cfec632a70c926027df",
  platform: "linux/amd64",
  cudaVersion: "13.0",
  torchVersion: "2.11.0",
  transformersVersion: "5.12.1",
  minimumComputeCapability: "7.5",
  minimumBlackwellCudaVersion: "12.8",
  minimumDriverVersions: DEFAULT_VLLM_RELEASE.minimumDriverVersions,
});

function defaultVllmImageReference(release = DEFAULT_VLLM_RELEASE) {
  return `${release.repository}@${release.platformDigest}`;
}

function parseNvidiaCompatibilityCsv(stdout) {
  const gpus = String(stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [index, name, computeCapability, driverVersion] = line.split(",").map((part) => String(part || "").trim());
      return {
        index: Number(index),
        id: String(index || "").trim(),
        name,
        computeCapability,
        driverVersion,
      };
    })
    .filter((gpu) => Number.isInteger(gpu.index) && gpu.index >= 0);
  if (!gpus.length) {
    return { ok: false, gpus: [], error: "nvidia-smi did not report an NVIDIA GPU." };
  }
  return { ok: true, gpus, driverVersion: gpus[0].driverVersion, error: "" };
}

async function probeNvidiaRuntimeCompatibility(execFileAsync) {
  if (typeof execFileAsync !== "function") {
    return { ok: false, gpus: [], error: "nvidia-smi execution is not configured." };
  }
  try {
    const result = await execFileAsync("nvidia-smi", [
      "--query-gpu=index,name,compute_cap,driver_version",
      "--format=csv,noheader,nounits",
    ]);
    return parseNvidiaCompatibilityCsv(result.stdout);
  } catch (error) {
    return { ok: false, gpus: [], error: error.message || "nvidia-smi compatibility query failed." };
  }
}

function assessVllmRuntimeCompatibility(options = {}) {
  const probe = options.probe || {};
  const imageReference = String(options.imageReference || "").trim();
  const imageMetadata = options.imageMetadata || null;
  const hostPlatform = String(options.hostPlatform || process.platform);
  const hostArch = normalizeArchitecture(options.hostArch || process.arch);
  const requestedGpuIds = normalizeGpuSelection(options.selectedGpuIds);
  const findings = [];

  if (!probe.ok || !Array.isArray(probe.gpus) || !probe.gpus.length) {
    findings.push(finding("fail", "NVIDIA GPU probe", probe.error || "vLLM requires an NVIDIA GPU, but none was detected."));
    return finalize(findings, imageReference, [], imageMetadata);
  }

  if (options.allowAnyCompatibleGpu && !requestedGpuIds.length) {
    const compatibleIds = probe.gpus
      .filter((gpu) => assessVllmRuntimeCompatibility({
        ...options,
        allowAnyCompatibleGpu: false,
        selectedGpuIds: [String(gpu.id ?? gpu.index)],
      }).ok)
      .map((gpu) => String(gpu.id ?? gpu.index));
    if (compatibleIds.length) {
      const compatible = assessVllmRuntimeCompatibility({
        ...options,
        allowAnyCompatibleGpu: false,
        selectedGpuIds: compatibleIds,
      });
      const rejected = probe.gpus.filter((gpu) => !compatibleIds.includes(String(gpu.id ?? gpu.index)));
      const candidateFinding = finding(
        "ok",
        "Automatic GPU candidate selection",
        `At least one compatible GPU is available for single-GPU admission: ${compatibleIds.join(", ")}. The admitted device will be checked again before container creation.`,
      );
      const rejectedFinding = rejected.length
        ? [finding("warn", "Excluded GPU candidates", `Incompatible automatic candidates were excluded from this early check: ${rejected.map((gpu) => String(gpu.id ?? gpu.index)).join(", ")}.`)]
        : [];
      return finalize(
        [...compatible.findings, candidateFinding, ...rejectedFinding],
        imageReference,
        compatible.gpus,
        imageMetadata,
      );
    }
  }

  const available = probe.gpus;
  const selected = requestedGpuIds.length
    ? available.filter((gpu) => requestedGpuIds.includes(String(gpu.id ?? gpu.index)))
    : available;
  const missing = requestedGpuIds.filter((id) => !available.some((gpu) => String(gpu.id ?? gpu.index) === id));
  if (missing.length) {
    findings.push(finding("fail", "GPU selection", `Selected GPU ${missing.join(", ")} is not reported by nvidia-smi.`));
  }
  if (!selected.length) {
    findings.push(finding("fail", "GPU selection", "No selected NVIDIA GPU remains after compatibility filtering."));
    return finalize(findings, imageReference, selected, imageMetadata);
  }

  const minimumCompute = Number(imageMetadata?.minimumComputeCapability || DEFAULT_VLLM_RELEASE.minimumComputeCapability);
  for (const gpu of selected) {
    const capability = Number(gpu.computeCapability);
    if (!Number.isFinite(capability)) {
      findings.push(finding("warn", `GPU ${gpu.index} compute capability`, `${gpu.name || "NVIDIA GPU"} did not report compute capability; runtime support cannot be fully verified.`));
    } else if (capability < minimumCompute) {
      findings.push(finding("fail", `GPU ${gpu.index} compute capability`, `${gpu.name || "NVIDIA GPU"} is SM ${gpu.computeCapability}; vLLM requires SM ${minimumCompute.toFixed(1)} or newer.`));
    } else {
      findings.push(finding("ok", `GPU ${gpu.index} compute capability`, `${gpu.name || "NVIDIA GPU"} reports SM ${gpu.computeCapability}.`));
    }
  }

  if (!/@sha256:[0-9a-f]{64}$/i.test(imageReference)) {
    findings.push(finding("warn", "Immutable image pin", `${imageReference || "The configured image"} is not pinned to a Docker content digest.`));
  } else {
    findings.push(finding("ok", "Immutable image pin", imageReference));
  }

  if (!imageMetadata) {
    findings.push(finding("warn", "Image CUDA metadata", "This image is an override or an unrecognized build. The manager cannot automatically verify its CUDA, PyTorch, Transformers, architecture, or driver requirements; verify the image metadata manually."));
    return finalize(findings, imageReference, selected, imageMetadata);
  }

  const imageArch = normalizeArchitecture(String(imageMetadata.platform || "").split("/").at(-1));
  if (imageArch && hostArch && imageArch !== hostArch) {
    findings.push(finding("fail", "Container architecture", `Image platform ${imageMetadata.platform} does not match host architecture ${hostArch}.`));
  } else if (imageMetadata.platform) {
    findings.push(finding("ok", "Container architecture", `${imageMetadata.platform} matches this host.`));
  }

  const cudaVersion = String(imageMetadata.cudaVersion || "");
  const blackwellMinimumCuda = String(imageMetadata.minimumBlackwellCudaVersion || DEFAULT_VLLM_RELEASE.minimumBlackwellCudaVersion);
  const blackwell = selected.filter((gpu) => Number(gpu.computeCapability) >= 10);
  if (blackwell.length && compareVersions(cudaVersion, blackwellMinimumCuda) < 0) {
    findings.push(finding("fail", "Blackwell CUDA runtime", `SM ${blackwell.map((gpu) => gpu.computeCapability).join(", ")} requires CUDA ${blackwellMinimumCuda} or newer; the image declares CUDA ${cudaVersion || "unknown"}.`));
  } else if (blackwell.length) {
    findings.push(finding("ok", "Blackwell CUDA runtime", `CUDA ${cudaVersion} supports the selected Blackwell GPU(s).`));
  }

  const requiredDriver = String(imageMetadata.minimumDriverVersions?.[hostPlatform]
    || imageMetadata.minimumDriverVersions?.linux
    || "");
  const driverVersions = Array.from(new Set(selected.map((gpu) => String(gpu.driverVersion || probe.driverVersion || "").trim()).filter(Boolean)));
  if (!driverVersions.length) {
    findings.push(finding("warn", "NVIDIA driver", "Driver version was not reported; CUDA runtime compatibility cannot be fully verified."));
  } else if (requiredDriver) {
    const unsupportedDrivers = driverVersions.filter((version) => compareVersions(version, requiredDriver) < 0);
    if (unsupportedDrivers.length) {
      findings.push(finding("fail", "NVIDIA driver", `CUDA ${cudaVersion} requires driver ${requiredDriver} or newer on ${hostPlatform}; detected ${unsupportedDrivers.join(", ")}.`));
    } else {
      findings.push(finding("ok", "NVIDIA driver", `Driver ${driverVersions.join(", ")} satisfies the CUDA ${cudaVersion} minimum (${requiredDriver}).`));
    }
  }

  return finalize(findings, imageReference, selected, imageMetadata);
}

function normalizeGpuSelection(value) {
  const input = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(new Set(input.map((item) => String(item).trim()).filter(Boolean)));
}

function normalizeArchitecture(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["x64", "x86_64", "amd64"].includes(normalized)) return "amd64";
  if (["aarch64", "arm64"].includes(normalized)) return "arm64";
  return normalized;
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function versionParts(value) {
  const match = String(value || "").match(/\d+(?:\.\d+)*/);
  return match ? match[0].split(".").map(Number) : [];
}

function finding(severity, title, detail) {
  return { severity, title, detail };
}

function finalize(findings, imageReference, gpus, imageMetadata) {
  const failures = findings.filter((item) => item.severity === "fail");
  const warnings = findings.filter((item) => item.severity === "warn");
  const gpuSummary = gpus.map((gpu) => `${gpu.name || `GPU ${gpu.index}`} (SM ${gpu.computeCapability || "?"}, driver ${gpu.driverVersion || "?"})`).join("; ");
  const releaseSummary = imageMetadata
    ? `${imageMetadata.version || "known build"} / CUDA ${imageMetadata.cudaVersion || "?"} / PyTorch ${imageMetadata.torchVersion || "?"} / Transformers ${imageMetadata.transformersVersion || "?"}`
    : "custom image metadata unknown";
  return {
    ok: failures.length === 0,
    status: failures.length ? "fail" : warnings.length ? "warn" : "ok",
    imageReference,
    release: imageMetadata || null,
    gpus,
    findings,
    summary: `${releaseSummary}; ${gpuSummary || "no compatible GPU"}`,
  };
}

module.exports = {
  DEFAULT_SGLANG_RELEASE,
  DEFAULT_VLLM_RELEASE,
  assessVllmRuntimeCompatibility,
  compareVersions,
  defaultVllmImageReference,
  normalizeArchitecture,
  parseNvidiaCompatibilityCsv,
  probeNvidiaRuntimeCompatibility,
};
