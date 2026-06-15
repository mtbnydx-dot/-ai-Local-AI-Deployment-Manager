const fs = require("node:fs");

const INVALID_PASSWORD = "\u5ba1\u8ba1\u5bc6\u7801\u4e0d\u6b63\u786e\u3002";

function defaultStreamMarkdownFile(file, res) {
  res.type("text/markdown; charset=utf-8");
  return fs.createReadStream(file).pipe(res);
}

function registerAuditRoutes(app, deps = {}) {
  const {
    auditRoot,
    auditPasswordFile,
    openWebuiContainer,
    managerName,
    getAuditPassword,
    getContainerStatus,
    verifyAuditPassword,
    createAuditSession,
    getAuditAuth,
    destroyAuditSession,
    requireAuditAuth,
    listAuditExports,
    getAuditMarkdownPath,
    exportOpenWebuiAudit,
    streamMarkdownFile = defaultStreamMarkdownFile,
  } = deps;

  app.get("/api/audit/status", async (_req, res) => {
    try {
      await getAuditPassword();
      const container = await getContainerStatus(openWebuiContainer);
      res.json({
        ok: true,
        auditRoot,
        passwordFile: auditPasswordFile,
        requiresPassword: true,
        openWebuiContainer,
        container,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/audit/login", async (req, res) => {
    try {
      const valid = await verifyAuditPassword(String(req.body?.password || ""));
      if (!valid) return res.status(401).json({ error: INVALID_PASSWORD });
      const session = createAuditSession();
      return res.json({ ok: true, ...session });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/audit/logout", async (req, res) => {
    const auth = getAuditAuth(req);
    if (auth.token) destroyAuditSession(auth.token);
    res.json({ ok: true });
  });

  app.get("/api/audit/exports", async (req, res) => {
    const auth = requireAuditAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    try {
      return res.json({ ok: true, auditRoot, exports: await listAuditExports() });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/audit/exports/:auditId/markdown", async (req, res) => {
    const auth = requireAuditAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    try {
      const file = await getAuditMarkdownPath(req.params.auditId);
      return streamMarkdownFile(file, res);
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post("/api/audit/export", async (req, res) => {
    const auth = requireAuditAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    try {
      const audit = await exportOpenWebuiAudit("manual", {
        manager: managerName,
        requestedBy: "local-admin",
        note: String(req.body?.note || ""),
      });
      return res.json(audit);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });
}

module.exports = {
  registerAuditRoutes,
};
