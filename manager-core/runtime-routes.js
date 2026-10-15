const { redactSecrets } = require("./secret-redactor");

function sendJsonError(res, error, fallbackStatus = 500) {
  const payload = { error: error.message };
  if (error.code) payload.code = String(error.code);
  if (error.details && typeof error.details === "object") payload.details = error.details;
  // A launch the plan refused (01-engines §21.1): the legacy shape plus
  // ok:false, the plan's field errors and the next step.
  if (Array.isArray(error.errors) && !(error instanceof AggregateError)) {
    payload.ok = false;
    payload.errors = error.errors;
    if (error.hint) payload.hint = String(error.hint);
  }
  // plan_changed (01 §11): the plan as it is now, so the caller can review it.
  if (error.planView && typeof error.planView === "object") {
    payload.ok = false;
    payload.plan = error.planView;
  }
  res.status(error.status || fallbackStatus).json(payload);
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

// A text function or a bound redactor ({ redact }) from createSecretRedactor.
function resolveTextRedactor(input) {
  const custom = typeof input === "function" ? input
    : (input && typeof input.redact === "function" ? (text) => input.redact(text) : null);
  return (text) => {
    if (!custom) return redactSecrets(text);
    try {
      return custom(text);
    } catch {
      return redactSecrets(text);
    }
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
    listRuntimeInstances,
    stopRuntimeInstance,
  } = deps;
  // /api/logs text is redacted before it leaves the manager (08 P0-5). The
  // servers pass a createSecretRedactor that also knows the exact runtime keys;
  // the default removes secret-shaped substrings only.
  const redactLogs = resolveTextRedactor(deps.redactLogs);

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
        res.status(result.status || 200).type(result.type).send(redactLogs(String(result.text ?? "")));
      } catch (error) {
        res.status(error.status || 500).type("text/plain").send(redactLogs(String(error?.message ?? "")));
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

  if (typeof listRuntimeInstances === "function") {
    app.get("/api/instances", async (req, res) => {
      try {
        res.json(await listRuntimeInstances({ req, query: req.query || {} }));
      } catch (error) {
        sendJsonError(res, error);
      }
    });
  }

  if (typeof stopRuntimeInstance === "function") {
    app.post("/api/instances/:id/stop", async (req, res) => {
      try {
        res.json(await stopRuntimeInstance({ req, id: req.params.id, body: req.body || {} }));
      } catch (error) {
        sendJsonError(res, error);
      }
    });
  }
}

module.exports = {
  registerRuntimeRoutes,
  sendJsonError,
};
