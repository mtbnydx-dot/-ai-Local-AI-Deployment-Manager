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
    buildExternalAccessOptions = (query) => ({ limit: query.limit, maxLines: query.maxLines }),
    formatExternalAccessError = (error) => ({ error: error.message }),
    getClaudeCompressionSettings,
    saveClaudeCompressionSettings,
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
    const [docker, gpu, container, image] = await Promise.all([
      getDockerVersion(),
      getGpuStatus(),
      getContainerStatus(config.containerName),
      getImageStatus(config.image),
    ]);
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
      jobs: Array.from(jobs.values()).slice(-10).reverse(),
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
}

module.exports = {
  registerManagerRoutes,
};
