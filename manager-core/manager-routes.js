const { redactSecrets } = require("./secret-redactor");

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
    listBenchmarkRuns,
    compareBenchmarkRuns,
    deleteBenchmarkRun,
    idleUnload,
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
    res.json(redactManagerSecrets(status));
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
    res.json(redactManagerSecrets(await getRunningModelSummary(container, gpu)));
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

  if (listBenchmarkRuns && compareBenchmarkRuns && deleteBenchmarkRun) {
    app.get("/api/benchmarks", async (req, res) => {
      try {
        res.json(await listBenchmarkRuns(req.query || {}));
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    // Comparison is a read of selected runs, so the ids travel in the query and
    // the first one is the baseline unless the caller names another.
    app.get("/api/benchmarks/compare", async (req, res) => {
      try {
        const query = req.query || {};
        res.json(await compareBenchmarkRuns(query.ids || "", { baselineId: String(query.baselineId || "") }));
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    app.delete("/api/benchmarks/:id", async (req, res) => {
      try {
        const result = await deleteBenchmarkRun(req.params.id);
        res.status(result.ok ? 200 : 404).json(result);
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });
  }

  if (idleUnload) {
    app.get("/api/idle-unload", async (_req, res) => {
      try {
        res.json(await idleUnload.listSleeping());
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    app.post("/api/idle-unload", async (req, res) => {
      try {
        res.json({ ok: true, settings: await idleUnload.saveSettings(req.body || {}) });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });

    // Waking restarts a container, so it returns the serve job the caller can
    // follow rather than blocking until the model is loaded. Replacing a
    // running model needs the explicit { confirmReplace: true } (08 P0-1);
    // refusals carry a stable code and details.
    app.post("/api/idle-unload/:id/wake", async (req, res) => {
      try {
        const confirmReplace = req.body?.confirmReplace === true;
        res.json(await idleUnload.wake(req.params.id, { confirmReplace }));
      } catch (error) {
        res.status(error.status || 500).json({
          ok: false,
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.details ? { details: error.details } : {}),
        });
      }
    });

    app.delete("/api/idle-unload/:id", async (req, res) => {
      try {
        const result = await idleUnload.forget(req.params.id);
        res.status(result.ok ? 200 : 404).json(result);
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
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

function redactManagerSecrets(value, explicitSecrets = []) {
  const secrets = Array.from(new Set((Array.isArray(explicitSecrets) ? explicitSecrets : [explicitSecrets])
    .map((item) => String(item || ""))
    .filter((item) => item.length >= 6)));
  return redactManagerSecretsValue(value, secrets);
}

function redactManagerSecretsValue(value, secrets) {
  if (typeof value === "string") {
    // Exact secrets only: API payloads carry model ids that the patterns
    // could hit. The marker is the platform's <redacted> (08 §3).
    return secrets.length
      ? redactSecrets(value, { secrets, patterns: false, minSecretLength: 6 })
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactManagerSecretsValue(item, secrets));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
    const sensitiveName = normalized.endsWith("apikey")
      || normalized.endsWith("token")
      || normalized.endsWith("password")
      || normalized.endsWith("secret")
      || normalized.endsWith("keyhash")
      || normalized === "authorization";
    if (sensitiveName && typeof item === "string") continue;
    output[key] = redactManagerSecretsValue(item, secrets);
  }
  return output;
}

function createManagerApiSecretRedactionMiddleware(options = {}) {
  const getSecrets = typeof options.getSecrets === "function" ? options.getSecrets : () => [];
  return function managerApiSecretRedaction(req, res, next) {
    const requestPath = String(req?.path || req?.url || "").split("?", 1)[0];
    if (!requestPath.startsWith("/api/")) return next();
    const requestMethod = String(req?.method || "GET").toUpperCase();
    const returnsOneTimeClientKey = requestMethod === "POST" && (
      requestPath === "/api/service-clients"
      || /^\/api\/service-clients\/[^/]+\/rotate\/?$/.test(requestPath)
    );
    const sendJson = res.json.bind(res);
    res.json = (payload) => {
      let secrets = [];
      try {
        secrets = getSecrets() || [];
      } catch {
        if (typeof res.status === "function") res.status(503);
        return sendJson({
          error: "runtime_secret_store_unavailable",
          message: "Runtime API-key storage is unavailable; API output is blocked to prevent secret disclosure.",
        });
      }
      const redacted = redactManagerSecrets(payload, secrets);
      // Client provisioning and rotation intentionally return the new key once.
      // These routes remain behind the manager's local-only security guard; all
      // nested hashes and every other API response stay redacted.
      if (
        returnsOneTimeClientKey
        && payload
        && typeof payload === "object"
        && typeof payload.apiKey === "string"
        && payload.apiKey
      ) {
        redacted.apiKey = payload.apiKey;
      }
      return sendJson(redacted);
    };
    return next();
  };
}

// Exact secrets for the job-log and /api/logs redactor (08 P0-5). The runtime
// key store re-reads its file on every values() call and the ledger redacts on
// every appendLog, so the list is cached. set/remove through the returned
// store invalidate it at once; otherwise it is refreshed at most once per
// refreshMs. A throwing source is not cached, so the redactor's patterns-only
// fallback applies until the store reads again.
function createCachedSecretList({ store, sources = [], refreshMs = 1000, now = Date.now } = {}) {
  let cached = null;
  let cachedAt = 0;

  function invalidate() {
    cached = null;
  }

  function getSecrets() {
    const at = now();
    if (cached && at - cachedAt < refreshMs) return cached;
    const collected = [];
    if (store && typeof store.values === "function") collected.push(...store.values());
    for (const source of sources) {
      const value = typeof source === "function" ? source() : source;
      if (typeof value === "string") collected.push(value);
      else if (value && typeof value[Symbol.iterator] === "function") collected.push(...value);
    }
    cached = Array.from(new Set(collected.filter((item) => typeof item === "string" && item)));
    cachedAt = at;
    return cached;
  }

  const wrappedStore = store ? {
    ...store,
    async set(...args) {
      try {
        return await store.set(...args);
      } finally {
        invalidate();
      }
    },
    async remove(...args) {
      try {
        return await store.remove(...args);
      } finally {
        invalidate();
      }
    },
  } : null;

  return { getSecrets, invalidate, store: wrappedStore };
}

module.exports = {
  createCachedSecretList,
  createManagerApiSecretRedactionMiddleware,
  redactManagerSecrets,
  registerManagerRoutes,
  summarizeStatusJob,
};
