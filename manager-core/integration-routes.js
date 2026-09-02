function sendJsonError(res, error, fallbackStatus = 500) {
  res.status(error.status || fallbackStatus).json({ error: error.message });
}

function registerIntegrationRoutes(app, deps = {}) {
  const {
    getGpuPlan,
    getClaudeSetup,
    setupClaude,
  } = deps;

  if (typeof getGpuPlan === "function") {
    app.get("/api/gpu-plan", async (req, res) => {
      try {
        res.json(await getGpuPlan({ req, query: req.query || {} }));
      } catch (error) {
        sendJsonError(res, error);
      }
    });
  }

  if (typeof getClaudeSetup === "function") {
    app.get("/api/claude/setup", async (req, res) => {
      try {
        res.json(await getClaudeSetup({ req, query: req.query || {} }));
      } catch (error) {
        sendJsonError(res, error);
      }
    });
  }

  if (typeof setupClaude === "function") {
    app.post("/api/claude/setup", async (req, res) => {
      try {
        res.json(await setupClaude({ req, body: req.body || {} }));
      } catch (error) {
        sendJsonError(res, error);
      }
    });
  }
}

module.exports = {
  registerIntegrationRoutes,
};
