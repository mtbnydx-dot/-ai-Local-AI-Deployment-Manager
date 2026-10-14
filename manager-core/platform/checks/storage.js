"use strict";

const path = require("node:path");

function createChecks(ctx) {
  const descriptor = (id, zh, en, run) => ({ id, group: "storage", title: { "zh-CN": zh, "en-US": en }, run });
  const manual = (id) => ctx.fix(id, "storage-docs", "manual", "检查磁盘空间与路径", "Review disk space and paths", "/docs/troubleshooting.md#storage");
  async function capacity(id, paths, minimumGb, criticalGb = null) {
    if (!paths.length) return { status: "skip", detail: "No storage path is configured for this check.", data: { paths: [] } };
    const disks = await Promise.all(paths.map(async (entry) => ({ id: entry.id, ...await ctx.probe("diskSpace", entry.path) })));
    const invalid = disks.some((disk) => !Number.isFinite(disk.freeGb));
    const critical = criticalGb !== null && disks.some((disk) => disk.freeGb < criticalGb);
    const warning = disks.some((disk) => disk.freeGb < minimumGb || disk.exists === false);
    const status = invalid || critical ? "fail" : warning ? "warn" : "ok";
    return { status, detail: invalid ? "Free disk space could not be verified." : critical ? "The platform drive has less than 5 GiB free." : warning ? "A storage path is missing or free disk space is below the configured minimum." : "Free disk space meets the configured minimum.", data: { disks, minimumGb, ...(criticalGb !== null ? { criticalGb } : {}) }, fix: status === "ok" ? null : manual(id) };
  }
  return [
    descriptor("storage.ai-root", "平台目录空间", "Platform folder space", () => capacity("storage.ai-root", [{ id: "ai-root", path: ctx.aiRoot }], ctx.value("doctor.minFreeGb.aiRoot", 20), 5)),
    descriptor("storage.model-roots", "模型库空间", "Model library space", async () => capacity("storage.model-roots", await ctx.probe("modelRoots"), ctx.value("doctor.minFreeGb.modelRoots", 50))),
    descriptor("storage.hf-cache", "Hugging Face 缓存空间", "Hugging Face cache space", () => {
      const home = ctx.value("paths.hfHome", "") || ctx.env.HF_HOME || path.join(ctx.aiRoot, "cache", "huggingface");
      return capacity("storage.hf-cache", [{ id: "hf-cache", path: home }], ctx.value("doctor.minFreeGb.hfCache", ctx.value("doctor.minFreeGb.modelRoots", 50)));
    }),
    descriptor("storage.docker-data", "Docker 数据磁盘", "Docker data drive", async () => {
      const directory = await ctx.probe("dockerData");
      return capacity("storage.docker-data", directory ? [{ id: "docker-data", path: directory }] : [], ctx.value("doctor.minFreeGb.dockerData", 30));
    }),
    descriptor("storage.writable", "平台目录写入检查", "Platform folder write check", async () => {
      const directories = ["config", "logs", ".runtime"].map((name) => path.join(ctx.aiRoot, name));
      const results = await ctx.probe("writable", directories), ok = results.length === directories.length && results.every((result) => result.writable === true);
      return { status: ok ? "ok" : "fail", detail: ok ? "Unique temporary probe files were created and removed in the platform folders." : "A platform folder is missing or could not complete the write probe; no folder or permission has been repaired.", data: { directories: results }, fix: ok ? null : ctx.fix("storage.writable", "mkdirs", "auto", "创建缺失的平台目录", "Create missing platform folders", "/docs/troubleshooting.md#storage") };
    }),
  ];
}

module.exports = { createChecks };
