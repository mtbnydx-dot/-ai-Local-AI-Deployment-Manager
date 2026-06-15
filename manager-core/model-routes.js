function sendError(res, error, fallbackStatus = 500) {
  return res.status(error.status || fallbackStatus).json({ error: error.message });
}

function registerModelRoutes(app, deps = {}) {
  const {
    listModels,
    deleteLocalModel,
    searchRemoteModels,
    startDownload,
    estimateDownload,
    getModelConfig,
    getModelReadme,
    checkPort,
    getRecentLaunches,
    getDownloadSettings,
    saveDownloadSettings,
    resolveModelLink,
  } = deps;

  app.get("/api/models", async (_req, res) => {
    res.json(await listModels());
  });

  if (deleteLocalModel) {
    app.post("/api/models/delete-local", async (req, res) => {
      try {
        res.json(await deleteLocalModel(req.body || {}));
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  app.get("/api/remote-models", async (req, res) => {
    try {
      res.json(await searchRemoteModels(req.query || {}));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/download", async (req, res) => {
    res.json(await startDownload(req.body || {}));
  });

  if (estimateDownload) {
    app.get("/api/download/estimate", async (req, res) => {
      try {
        res.json(await estimateDownload(req.query || {}));
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (getModelConfig) {
    app.get("/api/model/config", async (req, res) => {
      try {
        res.json(await getModelConfig(req.query || {}));
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (getModelReadme) {
    app.get("/api/model/readme", async (req, res) => {
      try {
        res.json(await getModelReadme(req.query || {}));
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (checkPort) {
    app.get("/api/port-check", async (req, res) => {
      try {
        res.json(await checkPort(req.query || {}));
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (getRecentLaunches) {
    app.get("/api/recent-launches", (_req, res) => {
      res.json(getRecentLaunches());
    });
  }

  if (getDownloadSettings) {
    app.get("/api/download/settings", (_req, res) => {
      res.json(getDownloadSettings());
    });
  }

  if (saveDownloadSettings) {
    app.post("/api/download/settings", async (req, res) => {
      try {
        res.json(await saveDownloadSettings(req.body || {}));
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  app.post("/api/resolve-model-link", async (req, res) => {
    try {
      res.json(await resolveModelLink(req.body || {}));
    } catch (error) {
      sendError(res, error);
    }
  });
}

module.exports = {
  registerModelRoutes,
};
