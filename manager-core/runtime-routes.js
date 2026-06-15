function sendJsonError(res, error, fallbackStatus = 500) {
  res.status(error.status || fallbackStatus).json({ error: error.message });
}

function normalizeTextResult(result) {
  if (typeof result === "string") {
    return { text: result, type: "text/plain" };
  }
  return {
    text: result?.text ?? "",
    type: result?.type || "text/plain",
    status: result?.status || 200,
  };
}

function normalizeProxyResult(result) {
  if (typeof result === "string") {
    return { body: result, status: 200, type: "application/json" };
  }
  return {
    body: result?.body ?? "",
    status: result?.status || 200,
    type: result?.type || "application/json",
  };
}

function registerRuntimeRoutes(app, deps = {}) {
  const {
    startRuntime,
    startDockerDesktop,
    stopRuntime,
    unloadRunningModel,
    readRuntimeLogs,
    testRuntimeCompletion,
  } = deps;

  if (typeof startRuntime === "function") {
    app.post("/api/start", async (req, res) => {
      try {
        res.json(await startRuntime({ req, body: req.body || {} }));
      } catch (error) {
        sendJsonError(res, error);
      }
    });
  }

  if (typeof startDockerDesktop === "function") {
    app.post("/api/docker/start", async (req, res) => {
      try {
        res.json(await startDockerDesktop({ req, query: req.query || {}, body: req.body || {} }));
      } catch (error) {
        sendJsonError(res, error);
      }
    });
  }

  if (typeof stopRuntime === "function") {
    app.post("/api/stop", async (req, res) => {
      try {
        res.json(await stopRuntime({ req, body: req.body || {} }));
      } catch (error) {
        sendJsonError(res, error);
      }
    });
  }

  if (typeof unloadRunningModel === "function") {
    app.post("/api/running-models/unload", async (req, res) => {
      try {
        res.json(await unloadRunningModel({ req, body: req.body || {} }));
      } catch (error) {
        sendJsonError(res, error);
      }
    });
  }

  if (typeof readRuntimeLogs === "function") {
    app.get("/api/logs", async (req, res) => {
      try {
        const result = normalizeTextResult(await readRuntimeLogs({ req, query: req.query || {} }));
        res.status(result.status || 200).type(result.type).send(result.text);
      } catch (error) {
        res.status(error.status || 500).type("text/plain").send(error.message);
      }
    });
  }

  if (typeof testRuntimeCompletion === "function") {
    app.post("/api/test", async (req, res) => {
      try {
        const result = normalizeProxyResult(await testRuntimeCompletion({ req, body: req.body || {} }));
        res.status(result.status).type(result.type).send(result.body);
      } catch (error) {
        sendJsonError(res, error);
      }
    });
  }
}

module.exports = {
  registerRuntimeRoutes,
};
