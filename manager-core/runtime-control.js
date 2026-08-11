function createRuntimeStopHandlers(options = {}) {
  const {
    managerName,
    containerName,
    getRunningModelSummary,
    stopRuntime,
    exportAudit = async () => ({ ok: true, skipped: true }),
    unloadNote,
  } = options;

  if (typeof getRunningModelSummary !== "function") throw new Error("createRuntimeStopHandlers requires getRunningModelSummary.");
  if (typeof stopRuntime !== "function") throw new Error("createRuntimeStopHandlers requires stopRuntime.");

  async function stopRuntimeRequest() {
    const before = await getRunningModelSummary();
    const result = await stopRuntime();
    const audit = await exportAudit("model-stop", {
      manager: managerName,
      serviceContainer: containerName,
      previousModels: before.models,
      stopResult: result,
    }).catch((error) => ({ ok: false, error: error.message }));
    return { ok: true, ...result, audit };
  }

  async function unloadRunningModelRequest({ body = {} } = {}) {
    const modelId = String(body.modelId || "").trim();
    const before = await getRunningModelSummary();
    const result = await stopRuntime();
    const audit = await exportAudit("model-unload", {
      manager: managerName,
      serviceContainer: containerName,
      requestedModelId: modelId || null,
      previousModels: before.models,
      unloadResult: result,
    }).catch((error) => ({ ok: false, error: error.message }));
    return {
      ok: true,
      modelId: modelId || null,
      unloaded: result.removed,
      containerName,
      previousModels: before.models,
      audit,
      note: unloadNote || "This runtime does not hot-unload a model from the current server process; this stops only the managed container.",
    };
  }

  return {
    stopRuntimeRequest,
    unloadRunningModelRequest,
  };
}

module.exports = {
  createRuntimeStopHandlers,
};
