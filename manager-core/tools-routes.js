function sendError(res, status, error) {
  return res.status(status).json({ error: error.message });
}

function registerToolsRoutes(app, deps = {}) {
  const {
    collectHealthReport,
    getLaunchProfiles,
    saveLaunchProfile,
    deleteLaunchProfile,
    checkModelCompatibility,
    summarizeRuntimeLogs,
    getAutomationSettings,
    saveAutomationSettings,
    createJob,
    normalizeBenchmarkRequest,
    runBenchmarkJob,
    failJob,
    benchmarkTitle = "Benchmark local model",
    verifyDownloadedModel,
    buildConnectionGuide,
    buildClaudeCompressionInsights,
    getModelNotes,
    saveModelNote,
    deleteModelNote,
  } = deps;

  app.get("/api/tools/health", async (_req, res) => {
    try {
      res.json(await collectHealthReport());
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get("/api/tools/profiles", async (_req, res) => {
    try {
      res.json(await getLaunchProfiles());
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post("/api/tools/profiles", async (req, res) => {
    try {
      res.json(await saveLaunchProfile(req.body || {}));
    } catch (error) {
      sendError(res, error.status || 500, error);
    }
  });

  app.delete("/api/tools/profiles/:id", async (req, res) => {
    try {
      res.json(await deleteLaunchProfile(req.params.id));
    } catch (error) {
      sendError(res, error.status || 500, error);
    }
  });

  app.post("/api/tools/model-check", async (req, res) => {
    try {
      res.json(await checkModelCompatibility(req.body || {}));
    } catch (error) {
      sendError(res, error.status || 500, error);
    }
  });

  app.get("/api/tools/log-summary", async (req, res) => {
    try {
      res.json(await summarizeRuntimeLogs({ tail: Number(req.query.tail || 420) }));
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get("/api/tools/automation-settings", async (_req, res) => {
    try {
      res.json(await getAutomationSettings());
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post("/api/tools/automation-settings", async (req, res) => {
    try {
      res.json(await saveAutomationSettings(req.body || {}));
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post("/api/tools/benchmark", async (req, res) => {
    try {
      const job = createJob("benchmark", benchmarkTitle, normalizeBenchmarkRequest(req.body || {}));
      runBenchmarkJob(job, job.meta).catch((error) => failJob(job, error));
      res.json({ job });
    } catch (error) {
      sendError(res, error.status || 500, error);
    }
  });

  app.post("/api/download/verify", async (req, res) => {
    try {
      res.json(await verifyDownloadedModel(req.body || {}));
    } catch (error) {
      sendError(res, error.status || 500, error);
    }
  });

  app.get("/api/connection-guide", async (_req, res) => {
    try {
      res.json(await buildConnectionGuide());
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get("/api/claude/context-compression/insights", async (_req, res) => {
    try {
      res.json(await buildClaudeCompressionInsights());
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.get("/api/tools/model-notes", async (_req, res) => {
    try {
      res.json(await getModelNotes());
    } catch (error) {
      sendError(res, 500, error);
    }
  });

  app.post("/api/tools/model-notes", async (req, res) => {
    try {
      res.json(await saveModelNote(req.body || {}));
    } catch (error) {
      sendError(res, error.status || 500, error);
    }
  });

  app.delete("/api/tools/model-notes/:id", async (req, res) => {
    try {
      res.json(await deleteModelNote(req.params.id));
    } catch (error) {
      sendError(res, error.status || 500, error);
    }
  });
}

module.exports = {
  registerToolsRoutes,
};
