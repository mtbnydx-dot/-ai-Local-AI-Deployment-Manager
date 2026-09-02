function sendError(res, error, fallbackStatus = 500) {
  const payload = { error: error.message };
  // 让前端能定位冲突任务，例如重复下载返回的 existingJobId。
  if (error && error.existingJobId) payload.existingJobId = error.existingJobId;
  if (error && error.code) payload.code = error.code;
  if (error && error.authorizationUrl) payload.authorizationUrl = error.authorizationUrl;
  if (error && error.accessStatus) payload.accessStatus = error.accessStatus;
  return res.status(error.status || fallbackStatus).json(payload);
}

function registerModelRoutes(app, deps = {}) {
  const {
    listModels,
    deleteLocalModel,
    searchRemoteModels,
    startDownload,
    estimateDownload,
    getHfAuthStatus,
    launchHfLogin,
    checkHfAccess,
    isLocalRequest = () => false,
    getModelConfig,
    getModelReadme,
    checkPort,
    getRecentLaunches,
    getDownloadSettings,
    saveDownloadSettings,
    resolveModelLink,
    probeDownloadMirror,
    getDiskUsage,
    cleanupIncomplete,
    checkModelUpstream,
    precheckDownload,
    listGgufVariants,
    listPrecisionVariants,
    describeCapabilityData,
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
    try {
      res.json(await startDownload(req.body || {}));
    } catch (error) {
      sendError(res, error);
    }
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

  // Pre-download compatibility card: capability matrix + runtime manifest +
  // GPU probe applied to the remote repository before a job exists.
  if (precheckDownload) {
    app.get("/api/download/precheck", async (req, res) => {
      try {
        res.json(await precheckDownload(req.query || {}));
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (listGgufVariants) {
    app.get("/api/remote-models/gguf-variants", async (req, res) => {
      try {
        res.json(await listGgufVariants(req.query || {}));
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (listPrecisionVariants) {
    app.get("/api/remote-models/precision-variants", async (req, res) => {
      try {
        res.json(await listPrecisionVariants(req.query || {}));
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (describeCapabilityData) {
    app.get("/api/capability-data", async (_req, res) => {
      try {
        res.json(await describeCapabilityData());
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (getHfAuthStatus) {
    app.get("/api/huggingface/auth/status", async (req, res) => {
      if (!isLocalRequest(req)) return res.status(403).json({ error: "Hugging Face 账号状态仅允许从本机查看。" });
      try {
        res.json(await getHfAuthStatus());
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (launchHfLogin) {
    app.post("/api/huggingface/auth/login", async (req, res) => {
      if (!isLocalRequest(req)) return res.status(403).json({ error: "Hugging Face 登录仅允许从本机发起。" });
      try {
        res.json(await launchHfLogin());
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (checkHfAccess) {
    app.get("/api/huggingface/access", async (req, res) => {
      if (!isLocalRequest(req)) return res.status(403).json({ error: "Hugging Face 授权复检仅允许从本机发起。" });
      try {
        res.json(await checkHfAccess(req.query || {}));
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

  if (probeDownloadMirror) {
    app.post("/api/download/mirror-probe", async (req, res) => {
      try {
        res.json(await probeDownloadMirror(req.body || {}));
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (getDiskUsage) {
    app.get("/api/models/disk-usage", async (_req, res) => {
      try {
        res.json(await getDiskUsage());
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (cleanupIncomplete) {
    app.post("/api/models/cleanup-incomplete", async (req, res) => {
      try {
        res.json(await cleanupIncomplete(req.body || {}));
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  if (checkModelUpstream) {
    app.get("/api/models/upstream-status", async (req, res) => {
      try {
        res.json(await checkModelUpstream(req.query || {}));
      } catch (error) {
        sendError(res, error);
      }
    });
  }
}

module.exports = {
  registerModelRoutes,
};
