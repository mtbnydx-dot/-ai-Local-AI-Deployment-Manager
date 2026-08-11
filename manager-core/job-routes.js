const DEFAULT_NOT_FOUND = "Job not found";
const DEFAULT_CANCEL_DOWNLOAD_ONLY = "\u53ea\u6709\u4e0b\u8f7d\u4efb\u52a1\u652f\u6301\u53d6\u6d88\u3002";
const DEFAULT_PAUSE_DOWNLOAD_ONLY = "\u53ea\u6709\u4e0b\u8f7d\u4efb\u52a1\u652f\u6301\u6682\u505c\u3002";
const DEFAULT_RESUME_DOWNLOAD_ONLY = "\u53ea\u6709\u4e0b\u8f7d\u4efb\u52a1\u652f\u6301\u7ee7\u7eed\u3002";

function sendError(res, status, error) {
  return res.status(status).json({ error });
}

function registerJobRoutes(app, deps = {}) {
  const {
    jobs,
    beforeReadJobs = () => {},
    cancelDownloadJob,
    pauseDownloadJob,
    resumeDownloadJob,
    cancelNonDownloadJob,
    notFoundText = DEFAULT_NOT_FOUND,
    messages = {},
  } = deps;

  const cancelDownloadOnly = messages.cancelDownloadOnly || DEFAULT_CANCEL_DOWNLOAD_ONLY;
  const pauseDownloadOnly = messages.pauseDownloadOnly || DEFAULT_PAUSE_DOWNLOAD_ONLY;
  const resumeDownloadOnly = messages.resumeDownloadOnly || DEFAULT_RESUME_DOWNLOAD_ONLY;

  function getJob(id) {
    return jobs.get(id);
  }

  app.get("/api/jobs", async (_req, res) => {
    await beforeReadJobs();
    res.json(Array.from(jobs.values()).reverse());
  });

  app.get("/api/jobs/:id", async (req, res) => {
    await beforeReadJobs();
    const job = getJob(req.params.id);
    if (!job) return sendError(res, 404, notFoundText);
    return res.json(job);
  });

  app.post("/api/jobs/:id/cancel", async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return sendError(res, 404, notFoundText);
    if (job.type !== "download") {
      if (cancelNonDownloadJob) return cancelNonDownloadJob(req, res, job);
      return sendError(res, 400, cancelDownloadOnly);
    }
    try {
      await cancelDownloadJob(job);
      return res.json({ ok: true, id: job.id, status: job.status });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  });

  app.post("/api/jobs/:id/pause", async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return sendError(res, 404, notFoundText);
    if (job.type !== "download") return sendError(res, 400, pauseDownloadOnly);
    try {
      await pauseDownloadJob(job);
      return res.json({ ok: true, id: job.id, status: job.status });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  });

  app.post("/api/jobs/:id/resume", async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return sendError(res, 404, notFoundText);
    if (job.type !== "download") return sendError(res, 400, resumeDownloadOnly);
    try {
      const resumed = await resumeDownloadJob(job);
      return res.json({ ok: true, id: resumed.id, status: resumed.status });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  });
}

module.exports = {
  registerJobRoutes,
};
