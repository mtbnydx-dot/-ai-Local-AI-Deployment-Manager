"use strict";
// Leaves a trace when a long-running service process ends.
//
// The vLLM manager once went offline with nothing in its log after
// "listening": the console window was closed and Node simply died. This module
// appends one JSON line per lifecycle event (start, signal, uncaught error,
// exit) to logs/process-exit.log so the next person can see whether the process
// was asked to stop, crashed, or was killed from outside. Hard kills
// (taskkill /F, power loss) still leave no trace; that absence is itself the
// signal.

const fs = require("node:fs");
const path = require("node:path");

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_KEEP = 3;

function describeSignal(signal) {
  switch (signal) {
    case "SIGINT": return "interrupted from the console (Ctrl+C)";
    case "SIGBREAK": return "interrupted from the console (Ctrl+Break)";
    case "SIGHUP": return "console window closed or session ended";
    case "SIGTERM": return "termination requested";
    default: return signal;
  }
}

function rotateIfNeeded(file, maxBytes, keep) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;
  for (let index = keep - 1; index >= 1; index -= 1) {
    const from = `${file}.${index}`;
    const to = `${file}.${index + 1}`;
    try { fs.renameSync(from, to); } catch {}
  }
  try { fs.renameSync(file, `${file}.1`); } catch {}
}

function createExitLogWriter(options = {}) {
  const file = options.file;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const keep = Number(options.keep) > 0 ? Number(options.keep) : DEFAULT_KEEP;
  const label = String(options.label || "process");
  const pid = Number(options.pid) > 0 ? Number(options.pid) : process.pid;
  const startedAt = Date.now();

  function write(event, extra = {}) {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      label,
      pid,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      event,
      ...extra,
    });
    if (!file) return line;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateIfNeeded(file, maxBytes, keep);
      fs.appendFileSync(file, `${line}\n`, "utf8");
    } catch {
      // Logging must never take the process down.
    }
    return line;
  }

  return { write, file };
}

function truncateError(error) {
  const text = error && error.stack ? String(error.stack) : String(error && error.message ? error.message : error);
  return text.slice(0, 2000);
}

function installProcessExitLogging(options = {}) {
  const proc = options.process || process;
  const writer = createExitLogWriter({ ...options, pid: proc.pid });
  const logger = options.logger || console;
  const onSignal = typeof options.onSignal === "function" ? options.onSignal : null;
  const exitOnSignal = options.exitOnSignal !== false;
  const handlers = [];
  let signalHandled = false;

  function on(event, handler) {
    proc.on(event, handler);
    handlers.push([event, handler]);
  }

  writer.write("start", { node: proc.version, argv: (proc.argv || []).slice(1, 3) });

  for (const signal of SIGNALS) {
    // Windows only emits SIGINT/SIGBREAK/SIGHUP; registering the rest is harmless.
    const handler = () => {
      if (signalHandled) return;
      signalHandled = true;
      const reason = describeSignal(signal);
      writer.write("signal", { signal, reason });
      logger.warn?.(`${options.label || "process"} received ${signal}: ${reason}`);
      const finish = () => { if (exitOnSignal) proc.exit(0); };
      if (onSignal) {
        Promise.resolve()
          .then(() => onSignal(signal))
          .then(finish, (error) => {
            writer.write("shutdown-error", { signal, error: truncateError(error) });
            if (exitOnSignal) proc.exit(1);
          });
      } else {
        finish();
      }
    };
    try {
      on(signal, handler);
    } catch {
      // Unsupported signal on this platform.
    }
  }

  on("uncaughtException", (error) => {
    writer.write("uncaught-exception", { error: truncateError(error) });
    logger.error?.(`Uncaught exception: ${error?.stack || error}`);
    proc.exit(1);
  });
  on("unhandledRejection", (reason) => {
    writer.write("unhandled-rejection", { error: truncateError(reason) });
    logger.error?.(`Unhandled rejection: ${reason?.stack || reason}`);
    proc.exit(1);
  });
  on("exit", (code) => {
    writer.write("exit", { code });
  });

  return {
    file: writer.file,
    write: writer.write,
    uninstall() {
      for (const [event, handler] of handlers) proc.removeListener(event, handler);
    },
  };
}

module.exports = {
  SIGNALS,
  createExitLogWriter,
  describeSignal,
  installProcessExitLogging,
};
