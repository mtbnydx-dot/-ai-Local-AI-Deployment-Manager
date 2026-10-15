function registerServicePolicyRoutes(app, deps = {}) {
  const {
    getServiceExposureSettings,
    saveServiceExposureSettings,
    buildServiceExposurePayload,
    getServiceClientsLedger,
    redactServiceClientsLedger,
    createServiceClient,
    updateServiceClient,
    rotateServiceClientKey,
    deleteServiceClient,
    // (body, currentSettings) -> Promise; forwards a global key change to the
    // platform key store before the manager file is saved (05 §6.8).
    forwardGlobalKey = null,
  } = deps;

  // The key routes forward to the entry's key store (legacy-key-forwarder.js).
  // Its refusals (503 key_store_unavailable, 404, 409 ...) answer as JSON with
  // their code, whatever error handler the manager app installs.
  const handle = (handler) => async (req, res) => {
    try {
      return res.json(await handler(req));
    } catch (error) {
      const status = Number(error?.status || 0);
      if (!error?.code || typeof error.code !== "string" || status < 400 || status >= 600) throw error;
      return res.status(status).json({ ok: false, code: error.code, error: String(error.message || error.code) });
    }
  };

  app.get("/api/service-exposure", handle(async () => {
    const settings = await getServiceExposureSettings();
    return buildServiceExposurePayload(settings);
  }));

  app.post("/api/service-exposure", handle(async (req) => {
    const current = await getServiceExposureSettings();
    if (typeof forwardGlobalKey === "function") await forwardGlobalKey(req.body || {}, current);
    const settings = await saveServiceExposureSettings(req.body || {}, current);
    return buildServiceExposurePayload(settings);
  }));

  app.get("/api/service-clients", handle(async () => redactServiceClientsLedger(await getServiceClientsLedger())));

  app.post("/api/service-clients", handle((req) => createServiceClient(req.body || {})));

  app.patch("/api/service-clients/:id", handle((req) => updateServiceClient(req.params.id, req.body || {})));

  app.post("/api/service-clients/:id/rotate", handle((req) => rotateServiceClientKey(req.params.id, req.body || {})));

  app.delete("/api/service-clients/:id", handle((req) => deleteServiceClient(req.params.id)));
}

module.exports = {
  registerServicePolicyRoutes,
};
