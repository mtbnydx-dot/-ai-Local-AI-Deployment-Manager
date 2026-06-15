const { spawn } = require("child_process");
const { markJobCancelRequested, markProcessJobStarted } = require("./job-utils");

function terminateProcessTree(pid, options = {}) {
  if (!pid) return;
  const spawnCommand = options.spawnCommand || spawn;
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    const killer = spawnCommand("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    if (killer?.on) killer.on("error", () => {});
    return;
  }
  try {
    process.kill(pid, options.signal || "SIGTERM");
  } catch {
    // Process may have already exited.
  }
}

function createProcessJobRunner(handlers = {}) {
  const appendLog = handlers.appendLog || (() => {});
  const finishJob = handlers.finishJob || (() => {});
  const failJob = handlers.failJob || (() => {});
  const scheduleSave = handlers.scheduleSave || (() => {});
  const spawnCommand = handlers.spawnCommand || spawn;
  const terminate = handlers.terminate || ((pid) => terminateProcessTree(pid));
  const onDone = handlers.onDone || (() => {});
  const startProgressTracker = handlers.startProgressTracker || null;
  const handleDownloadCancel = handlers.handleDownloadCancel || null;
  const cancelNonDownloadMessage = handlers.cancelNonDownloadMessage || null;
  const closeHandlerErrorMode = handlers.closeHandlerErrorMode || "fail";

  const handleCloseError = (job, error) => {
    if (closeHandlerErrorMode === "log") {
      job.error = error?.message || String(error || "Unknown error");
      appendLog(job, `Error: ${job.error}`);
      scheduleSave(0);
      return;
    }
    failJob(job, error);
  };

  return function spawnJobProcess(job, command, args, options = {}) {
    markProcessJobStarted(job);
    appendLog(job, `> ${command} ${args.join(" ")}`);
    const child = spawnCommand(command, args, {
      windowsHide: true,
      env: options.env || process.env,
    });
    job.pid = child.pid;
    markProcessJobStarted(job, { pid: child.pid });
    scheduleSave();
    if (options.progressDir && startProgressTracker) {
      startProgressTracker(job, options.progressDir, options.expectedBytes, {
        countExistingProgress: Boolean(options.countExistingProgress),
      });
    }
    if (child.stdout?.on) child.stdout.on("data", (data) => appendLog(job, data));
    if (child.stderr?.on) child.stderr.on("data", (data) => appendLog(job, data));
    const done = () => {
      try {
        onDone(job);
      } catch {
        // onDone is cleanup-only; never mask the process result.
      }
    };
    if (child.on) {
      child.on("error", (error) => {
        failJob(job, error);
        done();
      });
      child.on("close", (code) => {
        job.exitCode = code;
        Promise.resolve()
          .then(async () => {
            if (job.meta?.cancelRequested && job.type === "download" && handleDownloadCancel) {
              await handleDownloadCancel(job);
            } else if (job.meta?.cancelRequested && cancelNonDownloadMessage) {
              failJob(job, new Error(cancelNonDownloadMessage));
            } else if (code === 0) {
              finishJob(job);
            } else {
              failJob(job, new Error(`Process exited with code ${code}`));
            }
          })
          .catch((error) => handleCloseError(job, error))
          .finally(done);
      });
    }
    job.cancel = (action = "cancel") => {
      markJobCancelRequested(job, action);
      scheduleSave(0);
      terminate(child.pid);
    };
    return job;
  };
}

module.exports = {
  createProcessJobRunner,
  terminateProcessTree,
};
