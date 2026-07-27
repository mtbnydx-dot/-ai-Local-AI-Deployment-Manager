function createManagerOperationalSnapshotStore(options = {}) {
  const ttlMs = Math.max(250, Number(options.ttlMs || 10000));
  let cached = null;
  let expiresAt = 0;
  let inFlight = null;

  async function buildSnapshot() {
    const [docker, gpu, container] = await Promise.all([
      options.getDockerVersion(),
      options.getGpuStatus(),
      options.getContainerStatus(options.containerName),
    ]);
    const [image, runtime, resources] = await Promise.all([
      options.getImageStatus(container?.image || options.image),
      options.getRunningModelSummary(container, gpu),
      options.getManagerResourceSummary(gpu, container),
    ]);
    return {
      at: new Date().toISOString(),
      docker,
      gpu,
      container,
      image,
      runtime,
      resources,
    };
  }

  async function getSnapshot(request = {}) {
    const force = request.force === true;
    const now = Date.now();
    if (!force && cached) {
      if (expiresAt <= now && !inFlight) {
        getSnapshot({ force: true }).catch(() => {});
      }
      return cached;
    }
    if (!force && inFlight) return inFlight;
    const promise = buildSnapshot()
      .then((value) => {
        cached = value;
        expiresAt = Date.now() + ttlMs;
        return value;
      })
      .finally(() => {
        if (inFlight === promise) inFlight = null;
      });
    inFlight = promise;
    return promise;
  }

  function clear() {
    cached = null;
    expiresAt = 0;
  }

  return { clear, getSnapshot };
}

module.exports = {
  createManagerOperationalSnapshotStore,
};
