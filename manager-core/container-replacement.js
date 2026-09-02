function sanitizeContainerName(value) {
  return String(value || "model-service")
    .replace(/^\/+/, "")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .slice(0, 80) || "model-service";
}

function dockerErrorText(result) {
  return String(result?.stderr || result?.stdout || result?.error?.message || "").trim();
}

function isMissingContainerResult(result) {
  return /no such (object|container)/i.test(dockerErrorText(result));
}

async function inspectReplacementContainer(docker, containerName) {
  const out = await docker([
    "inspect",
    containerName,
    "--format",
    "{{json .}}",
  ], { rejectOnError: false, maxBuffer: 8 * 1024 * 1024 });
  if (out.error || !out.stdout.trim()) {
    if (isMissingContainerResult(out)) return null;
    const error = new Error(dockerErrorText(out) || `Unable to inspect ${containerName}.`);
    error.code = "CONTAINER_INSPECT_FAILED";
    throw error;
  }
  try {
    return JSON.parse(out.stdout.trim());
  } catch (cause) {
    const error = new Error(`Docker returned invalid inspect data for ${containerName}.`);
    error.code = "CONTAINER_INSPECT_FAILED";
    error.cause = cause;
    throw error;
  }
}

async function removeContainerIfPresent(docker, containerName) {
  const out = await docker(["rm", "-f", containerName], { rejectOnError: false });
  if (out.error && !isMissingContainerResult(out)) {
    throw new Error(dockerErrorText(out) || `Unable to remove ${containerName}.`);
  }
  return !out.error;
}

async function beginContainerReplacement(options = {}) {
  const {
    docker,
    containerName,
    managerId = "",
    ownerLabelKey = "ai.manager",
    stopTimeoutSeconds = 30,
    onEvent = () => {},
  } = options;
  if (typeof docker !== "function") throw new TypeError("docker is required");
  const originalName = sanitizeContainerName(containerName);
  const previous = await inspectReplacementContainer(docker, originalName);
  const previousOwner = String(previous?.Config?.Labels?.[ownerLabelKey] || "");
  if (previous && previousOwner && managerId && previousOwner !== managerId) {
    const error = new Error(`Refusing to replace ${originalName}; it belongs to ${previousOwner}.`);
    error.code = "CONTAINER_OWNED_BY_OTHER_MANAGER";
    error.status = 409;
    throw error;
  }

  const backupName = previous
    ? `${originalName}-rollback-${Date.now().toString(36)}`.slice(0, 120)
    : "";
  const previousWasRunning = Boolean(previous?.State?.Running);
  let state = previous ? "preparing" : "empty";

  if (previous) {
    onEvent({ type: "backup-start", originalName, backupName, previousWasRunning });
    try {
      if (previousWasRunning) {
        await docker(["stop", "-t", String(Math.max(1, Number(stopTimeoutSeconds) || 30)), originalName]);
      }
      await docker(["rename", originalName, backupName]);
      state = "prepared";
      onEvent({ type: "backup-ready", originalName, backupName, previousWasRunning });
    } catch (error) {
      if (previousWasRunning) {
        await docker(["start", originalName], { rejectOnError: false }).catch(() => {});
      }
      throw error;
    }
  }

  return {
    originalName,
    backupName,
    hadPrevious: Boolean(previous),
    previousWasRunning,
    get state() {
      return state;
    },
    async commit() {
      if (state === "committed") return { committed: true, removedBackup: false };
      if (state === "rolled-back") throw new Error("Replacement was already rolled back.");
      let removedBackup = false;
      if (backupName) removedBackup = await removeContainerIfPresent(docker, backupName);
      state = "committed";
      onEvent({ type: "commit", originalName, backupName, removedBackup });
      return { committed: true, removedBackup };
    },
    async rollback(cause = null) {
      if (state === "rolled-back") return { rolledBack: true, restoredPrevious: Boolean(previous) };
      if (state === "committed") throw new Error("Replacement was already committed.");
      await removeContainerIfPresent(docker, originalName);
      let restoredPrevious = false;
      if (backupName) {
        const backup = await inspectReplacementContainer(docker, backupName);
        if (backup) {
          await docker(["rename", backupName, originalName]);
          if (previousWasRunning) await docker(["start", originalName]);
          restoredPrevious = true;
        }
      }
      state = "rolled-back";
      onEvent({ type: "rollback", originalName, backupName, restoredPrevious, cause });
      return { rolledBack: true, restoredPrevious, previousWasRunning };
    },
  };
}

async function sweepStaleRollbackContainers(options = {}) {
  const {
    docker,
    managerId = "",
    ownerLabelKey = "ai.manager",
    maxAgeMs = 24 * 60 * 60 * 1000,
  } = options;
  if (typeof docker !== "function") return [];
  const listed = await docker(["ps", "-a", "--format", "{{json .}}"], {
    rejectOnError: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  const lines = String(listed.stdout || "").split(/\r?\n/).filter(Boolean);
  const removed = [];
  const now = Date.now();
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const name = String(row.Names || row.Name || "").replace(/^\/+/, "");
    if (!/-rollback-[a-z0-9]+$/i.test(name)) continue;
    const inspect = await inspectReplacementContainer(docker, name).catch(() => null);
    if (!inspect) continue;
    const owner = String(inspect.Config?.Labels?.[ownerLabelKey] || "");
    if (managerId && owner && owner !== managerId) continue;
    const created = Date.parse(inspect.Created || "") || 0;
    if (!created || now - created < maxAgeMs) continue;
    await removeContainerIfPresent(docker, name);
    removed.push(name);
  }
  return removed;
}

module.exports = {
  beginContainerReplacement,
  inspectReplacementContainer,
  isMissingContainerResult,
  removeContainerIfPresent,
  sanitizeContainerName,
  sweepStaleRollbackContainers,
};
