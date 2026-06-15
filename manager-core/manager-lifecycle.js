const fsp = require("fs/promises");
const { buildProcessHealth, preparePidFile, writePidFile } = require("./health");

function createManagerLifecycle(options = {}) {
  const app = options.app;
  const host = options.host || "127.0.0.1";
  const port = Number(options.port || 0);
  const label = options.label || "Manager";
  const pidFile = options.pidFile || "";
  const logger = options.logger || console;
  let httpServer = null;
  let isShuttingDown = false;

  async function prepareManagerPidFile() {
    const result = await preparePidFile(pidFile, label);
    if (result.removed && result.stale) logger.warn?.(`${label} removing stale pid file for dead process ${result.pid}.`);
    return result;
  }

  async function removePidFile() {
    if (!pidFile) return;
    try {
      const current = (await fsp.readFile(pidFile, "utf8")).trim();
      if (current === String(process.pid)) await fsp.unlink(pidFile);
    } catch {}
  }

  async function closeHttpServer() {
    if (!httpServer) return;
    await new Promise((resolve) => httpServer.close(resolve));
    httpServer = null;
  }

  async function startManager() {
    if (typeof options.beforeStart === "function") await options.beforeStart();
    await prepareManagerPidFile();
    if (typeof options.afterPreparePid === "function") await options.afterPreparePid();
    if (pidFile) await writePidFile(pidFile);
    if (typeof options.beforeListen === "function") await options.beforeListen();
    httpServer = app.listen(port, host, () => {
      logger.log?.(options.listenMessage || `${label} listening on http://${host}:${port}`);
    });
    return httpServer;
  }

  async function shutdownManager(signal = "shutdown") {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.log?.(`${label} shutting down (${signal})`);
    let shutdownError = null;
    try {
      if (typeof options.onShutdown === "function") await options.onShutdown({ signal });
    } catch (error) {
      shutdownError = error;
    } finally {
      await removePidFile();
      await closeHttpServer();
    }
    if (shutdownError) throw shutdownError;
    if (options.exitProcessOnShutdown) process.exit(0);
  }

  async function buildManagerHealth(engine = options.engine) {
    return buildProcessHealth({
      engine,
      managerId: options.managerId || "",
      host,
      port,
      pidFile,
    });
  }

  return {
    startManager,
    shutdownManager,
    buildManagerHealth,
    closeHttpServer,
    removePidFile,
    getHttpServer: () => httpServer,
    isShuttingDown: () => isShuttingDown,
  };
}

module.exports = {
  createManagerLifecycle,
};
