function registerManagerRoutes(app, deps = {}) {
  const {
    config,
    host,
    port,
    engine,
    jobs,
    getLanAddress,
    getConfigExtras = () => ({}),
    hasHfToken = () => Boolean(process.env.HF_TOKEN),
    isLocalRequest,
    shutdownManager,
    exitProcessOnShutdownError = false,
    buildManagerHealth,
    getDockerVersion,
    getGpuStatus,
    getContainerStatus,
    getImageStatus,
    getRunningModelSummary,
    getManagerResourceSummary,
    buildStatusExtras = () => ({}),
    buildMemoryEstimate,
    collectStats,
    collectExternalAccessStats,
    searchAccessLogs,
    exportAccessLogs,
    buildExternalAccessOptions = (query) => ({ limit: query.limit, maxLines: query.maxLines }),
    formatExternalAccessError = (error) => ({ error: error.message }),
    getClaudeCompressionSettings,
    saveClaudeCompressionSettings,
    createManagerBackup,
    listManagerBackups,
    getManagerBackup,
    restoreManagerBackup,
  } = deps;

  app.get("/api/config", (_req, res) => {
    const lanAddress = getLanAddress();
    res.json({
      ...config,
      managerHost: host,
      managerPort: port,
      lanAddress,
      hasHfToken: hasHfToken(),
      ...getConfigExtras(),
    });
  });

  app.post("/api/manager/shutdown", (req, res) => {
    if (!isLocalRequest(req)) {
      return res.status(403).json({ ok: false, error: "Shutdown is only available from localhost." });
    }
    res.json({ ok: true, message: "Manager is shutting down. Model services are not touched." });
    const timer = setTimeout(() => {
      shutdownManager("api").catch((error) => {
        console.error(`Manager shutdown failed: ${error.message}`);
        if (exitProcessOnShutdownError) process.exit(1);
      });
    }, 50);
    timer.unref?.();
  });

  app.get("/api/manager/health", async (_req, res) => {
    res.json(await buildManagerHealth(engine));
  });

  app.get("/api/status", async (_req, res) => {
    const [docker, gpu, container] = await Promise.all([
      getDockerVersion(),
      getGpuStatus(),
      getContainerStatus(config.containerName),
    ]);
    const image = await getImageStatus(container?.image || config.image);
    const runtime = await getRunningModelSummary(container, gpu);
    const resources = await getManagerResourceSummary(gpu, container);
    const status = {
      docker,
      gpu,
      resources,
      container,
      servedModels: runtime.servedModels,
      runningModels: runtime.models,
      endpoint: runtime.endpoint,
      image,
      jobs: Array.from(jobs.values()).slice(-10).reverse().map(summarizeStatusJob),
      ...(await buildStatusExtras({ docker, gpu, container, image, runtime, resources })),
    };
    if (Object.prototype.hasOwnProperty.call(runtime, "apiKeyRequired")) {
      status.apiKeyRequired = runtime.apiKeyRequired;
    }
    res.json(status);
  });

  app.get("/api/resources", async (_req, res) => {
    const [gpu, container] = await Promise.all([
      getGpuStatus(),
      getContainerStatus(config.containerName),
    ]);
    res.json(await getManagerResourceSummary(gpu, container));
  });

  app.post("/api/memory-estimate", (req, res) => {
    try {
      res.json(buildMemoryEstimate(req.body || {}));
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/running-models", async (_req, res) => {
    const [gpu, container] = await Promise.all([
      getGpuStatus(),
      getContainerStatus(config.containerName),
    ]);
    res.json(await getRunningModelSummary(container, gpu));
  });

  if (collectStats) {
    app.get("/api/stats", async (_req, res) => {
      try {
        res.json(await collectStats());
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  if (collectExternalAccessStats) {
    app.get("/api/external-access", async (req, res) => {
      try {
        res.json(await collectExternalAccessStats(buildExternalAccessOptions(req.query || {})));
      } catch (error) {
        res.status(500).json(formatExternalAccessError(error));
      }
    });
  }

  if (searchAccessLogs) {
    app.get("/api/access-logs/search", async (req, res) => {
      try {
        res.json(await searchAccessLogs(req.query || {}));
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });
  }

  if (exportAccessLogs) {
    app.get("/api/access-logs/export", async (req, res) => {
      try {
        const output = await exportAccessLogs(req.query || {});
        res.setHeader("content-type", output.contentType);
        res.setHeader("content-disposition", `attachment; filename="${output.filename}"`);
        res.send(output.text);
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });
  }

  if (getClaudeCompressionSettings && saveClaudeCompressionSettings) {
    app.get("/api/claude/context-compression", async (_req, res) => {
      try {
        res.json(await getClaudeCompressionSettings());
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.post("/api/claude/context-compression", async (req, res) => {
      try {
        res.json(await saveClaudeCompressionSettings(req.body || {}));
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  if (createManagerBackup && listManagerBackups && getManagerBackup && restoreManagerBackup) {
    app.get("/api/backups", async (_req, res) => {
      try {
        res.json(await listManagerBackups());
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    app.post("/api/backups", async (_req, res) => {
      try {
        res.json({ ok: true, backup: await createManagerBackup() });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    app.get("/api/backups/:id/download", async (req, res) => {
      try {
        const { id, backup } = await getManagerBackup(req.params.id);
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("content-disposition", `attachment; filename="${id}"`);
        res.send(`${JSON.stringify(backup, null, 2)}\n`);
      } catch (error) {
        res.status(error.status || 500).json({ ok: false, error: error.message });
      }
    });

    app.post("/api/backups/:id/restore", async (req, res) => {
      try {
        res.json(await restoreManagerBackup(req.params.id));
      } catch (error) {
        res.status(error.status || 500).json({ ok: false, error: error.message });
      }
    });
  }
}

function summarizeStatusJob(job = {}) {
  const logs = Array.isArray(job.logs) ? job.logs : [];
  return {
    id: job.id,
    type: job.type,
    title: job.title,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    error: job.error || null,
    progress: job.progress || null,
    meta: job.meta || {},
    logCount: logs.length,
    lastLog: logs.at(-1) || "",
  };
}

module.exports = {
  registerManagerRoutes,
  summarizeStatusJob,
};
