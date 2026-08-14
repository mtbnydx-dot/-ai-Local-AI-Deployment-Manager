const { spawn } = require("child_process");
const { StringDecoder } = require("node:string_decoder");
const { markInterruptedJob, markJobCancelRequested, markProcessJobStarted } = require("./job-utils");

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
  const handleProcessSuccess = typeof handlers.handleProcessSuccess === "function"
    ? handlers.handleProcessSuccess
    : null;

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
    const stdoutForwarder = createUtf8LogForwarder((data) => appendLog(job, data));
    const stderrForwarder = createUtf8LogForwarder((data) => appendLog(job, data));
    if (child.stdout?.on) {
      child.stdout.on("data", stdoutForwarder.write);
      child.stdout.on("end", stdoutForwarder.flush);
    }
    if (child.stderr?.on) {
      child.stderr.on("data", stderrForwarder.write);
      child.stderr.on("end", stderrForwarder.flush);
    }
    const done = () => {
      try {
        onDone(job);
      } catch {
        // onDone is cleanup-only; never mask the process result.
      }
    };
    if (child.on) {
      child.on("error", (error) => {
        if (error?.code === "ENOENT") {
          failJob(job, new Error(`${command} CLI 未安装或无法执行（${error.message}）。`));
        } else {
          failJob(job, error);
        }
        done();
      });
      child.on("close", (code) => {
        stdoutForwarder.flush();
        stderrForwarder.flush();
        job.exitCode = code;
        Promise.resolve()
          .then(async () => {
            if (job.meta?.cancelRequested && job.type === "download" && handleDownloadCancel) {
              await handleDownloadCancel(job);
            } else if (job.meta?.cancelRequested && cancelNonDownloadMessage) {
              failJob(job, new Error(cancelNonDownloadMessage));
            } else if (code === 0) {
              if (handleProcessSuccess) await handleProcessSuccess(job, options);
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

function createUtf8LogForwarder(append) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let flushed = false;

  const forwardCompleteLines = (text, final = false) => {
    pending += String(text || "").replace(/\r/g, "\n");
    const lines = pending.split("\n");
    pending = final ? "" : lines.pop();
    const ready = final ? lines : lines;
    for (const line of ready) {
      if (line) append(line);
    }
    if (final && pending) append(pending);
  };

  return {
    write(data) {
      if (flushed) return;
      const text = Buffer.isBuffer(data) || ArrayBuffer.isView(data)
        ? decoder.write(Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength || data.length))
        : String(data || "");
      forwardCompleteLines(text);
    },
    flush() {
      if (flushed) return;
      flushed = true;
      const tail = decoder.end();
      const text = pending + tail;
      pending = "";
      for (const line of text.replace(/\r/g, "\n").split("\n")) {
        if (line) append(line);
      }
    },
  };
}

function interruptRunningDownloadJobs(jobs, options = {}) {
  const terminate = options.terminate || terminateProcessTree;
  const interrupted = [];
  if (!jobs || typeof jobs.values !== "function") return interrupted;
  for (const job of jobs.values()) {
    if (job?.type !== "download" || job.status !== "running") continue;
    try {
      if (job.pid) terminate(job.pid);
    } catch {
      // The child may have already exited.
    }
    markInterruptedJob(job, {
      error: options.error || "管理器关闭时已终止下载进程。",
      message: options.message || "管理器关闭，已终止下载子进程。",
    });
    interrupted.push(job);
  }
  return interrupted;
}

module.exports = {
  createUtf8LogForwarder,
  createProcessJobRunner,
  interruptRunningDownloadJobs,
  terminateProcessTree,
};
