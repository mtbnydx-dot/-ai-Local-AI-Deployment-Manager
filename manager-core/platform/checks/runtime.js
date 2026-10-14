"use strict";

// Runtime checks consume facts only. Pull/start/rebuild entries are fix
// metadata; no check calls the manager lifecycle or the fix runner (06 §7).
function title(zh, en) { return { "zh-CN": zh, "en-US": en }; }
function versionAtLeast(actual, minimum) {
  const a = String(actual || "").split(".").map(Number), b = String(minimum || "").split(".").map(Number);
  if (!a.length || [...a, ...b].some((number) => !Number.isFinite(number))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}
function activeRuntimes(rows) { return (rows || []).filter((row) => row.status !== "retired" && !row.release?.retired); }

function createChecks(ctx) {
  const descriptor = (id, zh, en, run, extra = {}) => ({ id, group: "runtime", title: title(zh, en), run, ...extra });
  const manual = (id, zh, en) => ctx.fix(id, "runtime-docs", "manual", zh, en, "/docs/troubleshooting.md#runtime");
  const pullFix = (runtime) => runtime.localBuild
    ? ctx.fix("runtime.images", `rebuild-image:${runtime.runtimeId}`, "manual", "重建本机镜像", "Rebuild local image", "/docs/troubleshooting.md#runtime", { runtimeId: runtime.runtimeId, buildScript: runtime.release?.build?.script || null })
    : ctx.fix("runtime.images", `pull-image:${runtime.runtimeId}`, "confirm", "拉取运行时镜像", "Pull runtime image", "/docs/troubleshooting.md#runtime", { runtimeId: runtime.runtimeId, engineId: runtime.engineId, via: "manager", apiCall: { method: "POST", path: `/api/runtimes/${encodeURIComponent(runtime.runtimeId)}/pull`, body: { confirm: true } } });
  return [
    descriptor("runtime.docker-cli", "Docker 命令行", "Docker CLI", async () => {
      const result = await ctx.probe("dockerCli");
      return { status: result.present ? "ok" : "fail", detail: result.present ? "Docker CLI is available." : "Docker CLI is not available.", data: result, fix: result.present ? null : manual("runtime.docker-cli", "安装 Docker Desktop", "Install Docker Desktop") };
    }),
    descriptor("runtime.docker-daemon", "Docker 引擎", "Docker engine", async () => {
      const result = await ctx.probe("dockerDaemon");
      return { status: result.ready ? "ok" : "fail", detail: result.ready ? "Docker engine is responding." : "Docker engine is not responding; Doctor has not started it.", data: result, fix: result.ready ? null : ctx.fix("runtime.docker-daemon", "start-docker", "confirm", "启动 Docker Desktop", "Start Docker Desktop", "/docs/troubleshooting.md#docker") };
    }, { fix: ctx.fix("runtime.docker-daemon", "start-docker", "confirm", "启动 Docker Desktop", "Start Docker Desktop", "/docs/troubleshooting.md#docker") }),
    descriptor("runtime.wsl", "WSL 发行版", "WSL distributions", async () => {
      if (ctx.platform !== "win32") return { status: "skip", detail: "WSL is a Windows-only check.", data: { reason: "unsupported_platform" } };
      const result = await ctx.probe("wsl"), requested = ctx.env.DOCKER_WSL_DISTRO || ctx.value("docker.wslDistro", "") || "docker-desktop";
      const distro = result.distributions?.find((item) => item.name.toLowerCase() === String(requested).toLowerCase());
      return { status: distro?.version === 2 ? "ok" : "warn", detail: distro?.version === 2 ? "The selected Docker WSL distribution uses WSL 2." : "The selected Docker WSL distribution is missing or is not WSL 2.", data: { ...result, requested }, fix: distro?.version === 2 ? null : manual("runtime.wsl", "检查 WSL 2 安装", "Check the WSL 2 installation") };
    }),
    descriptor("runtime.wslconfig", "WSL 内存与交换空间", "WSL memory and swap", async () => {
      if (ctx.platform !== "win32") return { status: "skip", detail: "WSL configuration is a Windows-only check.", data: { reason: "unsupported_platform" } };
      const result = await ctx.probe("wslConfig"), minimumGb = ctx.value("doctor.wslMinMemoryGb", 48);
      const memoryGb = result.memoryGb ?? (Number.isFinite(result.totalMemoryGb) ? result.totalMemoryGb / 2 : null);
      const valid = Number.isFinite(memoryGb) && memoryGb >= minimumGb && !result.invalid?.length && (result.swapGb == null || Number.isFinite(result.swapGb));
      return { status: valid ? "ok" : "warn", detail: valid ? "The WSL memory allocation meets the configured minimum." : "WSL memory is below the configured minimum or could not be verified; review the suggested configuration.", data: { ...result, effectiveMemoryGb: memoryGb, minimumGb, memorySource: result.memoryGb == null ? "host-default" : "file", suggested: `[wsl2]\nmemory=${minimumGb}GB\nswap=0` }, fix: valid ? null : manual("runtime.wslconfig", "手动检查 WSL 配置", "Review WSL configuration manually") };
    }),
    descriptor("runtime.nvidia-driver", "NVIDIA 驱动与 GPU", "NVIDIA driver and GPUs", async () => {
      const [result, rows] = await Promise.all([ctx.probe("nvidia"), ctx.probe("runtimes")]);
      const runtimes = activeRuntimes(rows), gpus = result.gpus || [], affected = [];
      for (const runtime of runtimes) {
        const requiredDriver = runtime.release?.minimumDriverVersions?.[ctx.platform] || null;
        const requiredCompute = runtime.release?.minimumComputeCapability || null;
        const supported = gpus.some((gpu) => (!requiredDriver || versionAtLeast(gpu.driverVersion, requiredDriver)) && (!requiredCompute || versionAtLeast(gpu.computeCapability, requiredCompute)));
        if (!supported) affected.push({ runtimeId: runtime.runtimeId, requiredDriver, requiredCompute });
      }
      const ok = gpus.length > 0 && affected.length === 0;
      return { status: ok ? "ok" : "fail", detail: ok ? "The installed driver and at least one GPU meet every active runtime's requirements." : `No suitable GPU or driver was verified for: ${affected.map((item) => item.runtimeId).join(", ") || "all active runtimes"}.`, data: { gpus, affected }, fix: ok ? null : manual("runtime.nvidia-driver", "检查 NVIDIA 驱动与 GPU 要求", "Review NVIDIA driver and GPU requirements") };
    }),
    descriptor("runtime.images", "运行时镜像", "Runtime images", async () => {
      const runtimes = activeRuntimes(await ctx.probe("runtimes"));
      if (!runtimes.length) return { status: "skip", detail: "There are no active runtimes to inspect.", data: { runtimes: [] } };
      const states = await ctx.probe("images", runtimes), missing = [];
      const rows = runtimes.map((runtime) => {
        const state = states.find((item) => item.image === runtime.image) || { present: null };
        const policy = runtime.localBuild ? "local-build" : runtime.pullPolicy === "auto" ? "auto" : "explicit";
        const fix = state.present === false ? pullFix(runtime) : null;
        if (fix) missing.push(fix);
        return { runtimeId: runtime.runtimeId, engineId: runtime.engineId, image: runtime.image, present: state.present, localBuild: Boolean(runtime.localBuild), pullPolicy: policy, note: policy === "local-build" ? "Local builds need their recorded rebuild script." : policy === "auto" ? "Stable tier-1 images auto-pull at launch." : "This runtime requires an explicit pull before launch.", fix };
      });
      const unavailable = rows.every((row) => row.present === null);
      const partial = rows.some((row) => row.present === null);
      return { status: unavailable ? "skip" : missing.length || partial ? "warn" : "ok", detail: unavailable ? "Image presence could not be inspected because Docker is unavailable." : missing.length ? "Some launch images are missing; no image has been pulled." : partial ? "Some image presence checks are unavailable; no image has been pulled." : "All active runtime images are present.", data: { runtimes: rows, localBuilds: rows.filter((row) => row.localBuild).map((row) => row.runtimeId) }, fix: missing[0] || null, actions: missing.map((fix) => fix.id) };
    }),
    descriptor("runtime.gpu-in-docker", "Docker GPU 深度检查", "Docker GPU deep check", async () => {
      const runtimes = activeRuntimes(await ctx.probe("runtimes")), images = await ctx.probe("images", runtimes);
      const runtime = runtimes.find((row) => row.status === "pinned" && /@sha256:[a-f0-9]{64}$/i.test(row.image) && images.some((image) => image.image === row.image && image.present === true));
      if (!runtime) return { status: "skip", detail: "No present pinned image is available for the GPU probe; no image will be pulled.", data: { reason: "present_pinned_image_required" } };
      const argv = ["run", "--rm", "--pull", "never", "--network", "none", "--gpus", "all", "--entrypoint", "nvidia-smi", runtime.image];
      const result = await ctx.probe("gpuDocker", { image: runtime.image, argv });
      return { status: result.ok ? "ok" : "fail", detail: result.ok ? "The explicit GPU probe succeeded in the pinned local image." : "The GPU probe failed in the pinned local image.", data: { runtimeId: runtime.runtimeId, ...result }, fix: result.ok ? null : manual("runtime.gpu-in-docker", "检查 Docker GPU 支持", "Review Docker GPU support") };
    }, { deep: true }),
  ];
}

module.exports = { createChecks, versionAtLeast };
