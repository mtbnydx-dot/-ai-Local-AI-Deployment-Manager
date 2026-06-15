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
  } = deps;

  app.get("/api/service-exposure", async (_req, res) => {
    const settings = await getServiceExposureSettings();
    res.json(await buildServiceExposurePayload(settings));
  });

  app.post("/api/service-exposure", async (req, res) => {
    const current = await getServiceExposureSettings();
    const settings = await saveServiceExposureSettings(req.body || {}, current);
    res.json(await buildServiceExposurePayload(settings));
  });

  app.get("/api/service-clients", async (_req, res) => {
    res.json(redactServiceClientsLedger(await getServiceClientsLedger()));
  });

  app.post("/api/service-clients", async (req, res) => {
    res.json(await createServiceClient(req.body || {}));
  });

  app.patch("/api/service-clients/:id", async (req, res) => {
    res.json(await updateServiceClient(req.params.id, req.body || {}));
  });

  app.post("/api/service-clients/:id/rotate", async (req, res) => {
    res.json(await rotateServiceClientKey(req.params.id, req.body || {}));
  });

  app.delete("/api/service-clients/:id", async (req, res) => {
    res.json(await deleteServiceClient(req.params.id));
  });
}

module.exports = {
  registerServicePolicyRoutes,
};
