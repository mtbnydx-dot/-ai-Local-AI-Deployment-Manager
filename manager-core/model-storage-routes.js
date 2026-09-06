"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { storageReadJson, storageError } = require("./model-storage");
const run = promisify(execFile);

function createStorageBusyPathProbe({ aiRoot, getJobs = () => [] } = {}) {
  return async function getBusyPaths() {
    const result = [];
    const addJobs = jobs => {
      for (const job of jobs) {
        if (!["running", "queued"].includes(job.status)) continue;
        const p = job.type === "download" ? job.meta?.localDir : job.meta?.model;
        if (p && path.isAbsolute(p)) result.push({ path: p, label: `任务 ${job.id}` });
      }
    };
    addJobs(Array.from(getJobs()));
    for (const manager of ["vllm-manager", "llama-manager"]) {
      const pidFile = path.join(aiRoot, manager, ".manager.pid");
      if (!fs.existsSync(pidFile)) continue;
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      try { process.kill(pid, 0); } catch { continue; }
      const data = storageReadJson(path.join(aiRoot, manager, "logs/jobs-ledger.json"), []);
      addJobs(Array.isArray(data) ? data : (data.jobs || []));
    }
    // Only use Mounts and names from inspect; never return container environments.
    const { stdout } = await run("docker", ["ps", "-q"], { windowsHide: true, timeout: 6000 });
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) {
      const response = await run("docker", ["inspect", ...ids], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
      for (const container of JSON.parse(response.stdout)) for (const mount of container.Mounts || []) {
        if (mount.Type !== "bind") continue;
        let source = String(mount.Source || "");
        if (process.platform === "win32") source = source.replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\//i, (_all, drive) => `${drive.toUpperCase()}:\\`).replaceAll("/", "\\");
        if (path.isAbsolute(source)) result.push({ path: source, label: `容器 ${String(container.Name || container.Id).replace(/^\//, "")}` });
      }
    }
    return result;
  };
}

function registerModelStorageRoutes(app, { storage, migration, isLocalRequest, publicDir } = {}) {
  const guard = (req, res, next) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "模型目录与迁移管理仅允许本机操作。" });
    next();
  };
  const action = fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
  app.get("/model-storage", guard, (_req, res) => res.sendFile(path.join(publicDir, "model-storage.html")));
  app.get("/api/model-storage", guard, action(() => storage.snapshot()));
  app.get("/api/model-storage/directories", guard, action(req => storage.browseDirectories(req.query.path, req.query.query, req.query.offset)));
  app.post("/api/model-storage/roots", guard, action(req => storage.registerRoot(req.body)));
  app.post("/api/model-storage/default", guard, action(req => storage.setDefault(req.body.id)));
  app.post("/api/model-storage/unregister", guard, action(req => storage.unregisterRoot(req.body.id)));
  app.get("/api/model-storage/migrations", guard, action(() => ({ migrations: migration.list() })));
  app.post("/api/model-storage/migrations/plan", guard, action(req => migration.plan(req.body)));
  app.post("/api/model-storage/migrations/:id/start", guard, action(req => migration.start(req.params.id)));
  app.post("/api/model-storage/migrations/:id/cancel", guard, action(req => migration.cancel(req.params.id)));
  app.post("/api/model-storage/migrations/:id/rollback", guard, action(req => migration.rollback(req.params.id)));
  app.post("/api/model-storage/migrations/:id/cleanup", guard, action(req => migration.cleanupSource(req.params.id, req.body.confirmSource)));
}

module.exports = { createStorageBusyPathProbe, registerModelStorageRoutes };
