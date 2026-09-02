const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_SGLANG_RELEASE,
  DEFAULT_VLLM_RELEASE,
  assessVllmRuntimeCompatibility,
  compareVersions,
  defaultVllmImageReference,
  parseNvidiaCompatibilityCsv,
  probeNvidiaRuntimeCompatibility,
} = require("../lib/runtime-compatibility");

test("default Qwen3.8 vLLM and SGLang releases are pinned to tested amd64 digests", () => {
  assert.equal(DEFAULT_VLLM_RELEASE.version, "v0.28.0");
  assert.equal(DEFAULT_VLLM_RELEASE.cudaVersion, "13.0.2");
  assert.equal(DEFAULT_VLLM_RELEASE.torchVersion, "2.13.0");
  assert.equal(DEFAULT_VLLM_RELEASE.transformersVersion, "5.15.1");
  assert.equal(DEFAULT_VLLM_RELEASE.platform, "linux/amd64");
  assert.equal(
    defaultVllmImageReference(),
    "vllm/vllm-openai@sha256:2286e8533ca8b6bc777594bae30524f1426ba46ca21797524e06df6a94b06635",
  );
  assert.equal(DEFAULT_SGLANG_RELEASE.version, "0.5.17");
  assert.equal(DEFAULT_SGLANG_RELEASE.transformersVersion, "5.12.1");
  assert.equal(DEFAULT_SGLANG_RELEASE.platformDigest, "sha256:3ea7c6d74312d964edbcf9b3819425ea42117eb967ef1cfec632a70c926027df");
});

test("NVIDIA compatibility probe parses driver and compute capability", async () => {
  const parsed = parseNvidiaCompatibilityCsv("0, NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 12.0, 610.47\n");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.gpus[0].computeCapability, "12.0");
  assert.equal(parsed.gpus[0].driverVersion, "610.47");

  let args = null;
  const probed = await probeNvidiaRuntimeCompatibility(async (command, input) => {
    assert.equal(command, "nvidia-smi");
    args = input;
    return { stdout: "0, GPU A, 8.9, 590.12\n" };
  });
  assert.equal(probed.ok, true);
  assert.ok(args.includes("--query-gpu=index,name,compute_cap,driver_version"));
});

test("RTX PRO 6000 Blackwell and driver 610 pass the pinned CUDA 13 runtime preflight", () => {
  const result = assessVllmRuntimeCompatibility({
    probe: parseNvidiaCompatibilityCsv("0, NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 12.0, 610.47\n"),
    selectedGpuIds: ["0"],
    imageReference: defaultVllmImageReference(),
    imageMetadata: DEFAULT_VLLM_RELEASE,
    hostPlatform: "win32",
    hostArch: "x64",
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.ok(result.findings.some((item) => item.title === "Blackwell CUDA runtime" && item.severity === "ok"));
  assert.ok(result.findings.some((item) => item.title === "NVIDIA driver" && /610\.47/.test(item.detail)));
});

test("preflight blocks unsupported GPU, old driver, old Blackwell CUDA, and wrong image architecture", () => {
  const oldGpu = assessVllmRuntimeCompatibility({
    probe: parseNvidiaCompatibilityCsv("0, NVIDIA V100, 7.0, 610.47\n"),
    imageReference: defaultVllmImageReference(),
    imageMetadata: DEFAULT_VLLM_RELEASE,
    hostPlatform: "win32",
    hostArch: "x64",
  });
  assert.equal(oldGpu.ok, false);
  assert.ok(oldGpu.findings.some((item) => item.title.includes("compute capability") && item.severity === "fail"));

  const oldDriver = assessVllmRuntimeCompatibility({
    probe: parseNvidiaCompatibilityCsv("0, NVIDIA RTX PRO 6000, 12.0, 575.99\n"),
    imageReference: defaultVllmImageReference(),
    imageMetadata: DEFAULT_VLLM_RELEASE,
    hostPlatform: "win32",
    hostArch: "x64",
  });
  assert.equal(oldDriver.ok, false);
  assert.ok(oldDriver.findings.some((item) => item.title === "NVIDIA driver" && item.severity === "fail"));

  const oldCuda = assessVllmRuntimeCompatibility({
    probe: parseNvidiaCompatibilityCsv("0, NVIDIA RTX PRO 6000, 12.0, 610.47\n"),
    imageReference: "vllm/vllm-openai@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    imageMetadata: { ...DEFAULT_VLLM_RELEASE, cudaVersion: "12.6" },
    hostPlatform: "win32",
    hostArch: "x64",
  });
  assert.equal(oldCuda.ok, false);
  assert.ok(oldCuda.findings.some((item) => item.title === "Blackwell CUDA runtime" && item.severity === "fail"));

  const wrongArchitecture = assessVllmRuntimeCompatibility({
    probe: parseNvidiaCompatibilityCsv("0, NVIDIA RTX PRO 6000, 12.0, 610.47\n"),
    imageReference: defaultVllmImageReference(),
    imageMetadata: { ...DEFAULT_VLLM_RELEASE, platform: "linux/arm64" },
    hostPlatform: "win32",
    hostArch: "x64",
  });
  assert.equal(wrongArchitecture.ok, false);
  assert.ok(wrongArchitecture.findings.some((item) => item.title === "Container architecture" && item.severity === "fail"));
});

test("custom image remains allowed with explicit compatibility warnings", () => {
  const result = assessVllmRuntimeCompatibility({
    probe: parseNvidiaCompatibilityCsv("0, NVIDIA RTX PRO 6000, 12.0, 610.47\n"),
    imageReference: "example/vllm:custom",
    imageMetadata: null,
    hostPlatform: "win32",
    hostArch: "x64",
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "warn");
  assert.ok(result.findings.some((item) => item.title === "Immutable image pin" && item.severity === "warn"));
  assert.ok(result.findings.some((item) => item.title === "Image CUDA metadata" && item.severity === "warn"));
  assert.match(result.findings.find((item) => item.title === "Image CUDA metadata").detail, /cannot automatically verify/i);
  assert.doesNotMatch(result.findings.find((item) => item.title === "Image CUDA metadata").detail, /will be verified/i);
});

test("implicit single-GPU preflight accepts any compatible heterogeneous candidate then hard-checks the admitted ID", () => {
  const probe = parseNvidiaCompatibilityCsv([
    "0, NVIDIA V100, 7.0, 610.47",
    "1, NVIDIA RTX PRO 6000 Blackwell, 12.0, 610.47",
  ].join("\n"));
  const early = assessVllmRuntimeCompatibility({
    probe,
    selectedGpuIds: [],
    imageReference: defaultVllmImageReference(),
    imageMetadata: DEFAULT_VLLM_RELEASE,
    hostPlatform: "win32",
    hostArch: "x64",
    allowAnyCompatibleGpu: true,
  });
  assert.equal(early.ok, true);
  assert.deepEqual(early.gpus.map((gpu) => gpu.id), ["1"]);
  assert.ok(early.findings.some((item) => item.title === "Excluded GPU candidates" && item.severity === "warn"));

  const admittedBadGpu = assessVllmRuntimeCompatibility({
    probe,
    selectedGpuIds: ["0"],
    imageReference: defaultVllmImageReference(),
    imageMetadata: DEFAULT_VLLM_RELEASE,
    hostPlatform: "win32",
    hostArch: "x64",
    allowAnyCompatibleGpu: false,
  });
  assert.equal(admittedBadGpu.ok, false);
  assert.ok(admittedBadGpu.findings.some((item) => item.title.includes("compute capability") && item.severity === "fail"));
});

test("version comparison handles CUDA and Windows driver versions", () => {
  assert.equal(compareVersions("13.0.2", "12.8"), 1);
  assert.equal(compareVersions("580.88", "580.88"), 0);
  assert.equal(compareVersions("575.99", "580.88"), -1);
});
