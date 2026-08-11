"use strict";

const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { writeJsonFile } = require("./file-utils");

const execFileAsync = promisify(execFile);

function createRuntimeSecretStore(options = {}) {
  const file = path.resolve(String(options.file || path.join(process.cwd(), "logs", "runtime-secrets.json")));
  let mutationQueue = Promise.resolve();

  function readStoreSync() {
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return normalizeStore({});
      throw runtimeSecretStoreError(error);
    }
    try {
      const parsed = JSON.parse(source);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || (parsed.secrets !== undefined && (!parsed.secrets || typeof parsed.secrets !== "object" || Array.isArray(parsed.secrets)))) {
        throw new Error("invalid runtime secret store shape");
      }
      return normalizeStore(parsed);
    } catch (error) {
      throw runtimeSecretStoreError(error);
    }
  }

  function get(reference) {
    const id = normalizeReference(reference);
    if (!id) return "";
    return String(readStoreSync().secrets[id]?.secret || "");
  }

  function values() {
    return Object.values(readStoreSync().secrets)
      .map((entry) => String(entry?.secret || ""))
      .filter(Boolean);
  }

  async function set(secret) {
    const value = String(secret || "").trim();
    if (!value) return "";
    const reference = crypto.randomUUID();
    await mutate((store) => {
      store.secrets[reference] = {
        secret: value,
        createdAt: new Date().toISOString(),
      };
      return store;
    });
    return reference;
  }

  async function remove(reference) {
    const id = normalizeReference(reference);
    if (!id) return false;
    let existed = false;
    await mutate((store) => {
      existed = Boolean(store.secrets[id]);
      delete store.secrets[id];
      return store;
    });
    return existed;
  }

  function mutate(update) {
    const operation = mutationQueue.then(async () => {
      const store = readStoreSync();
      const next = normalizeStore(await update(store));
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await writeJsonFile(file, next);
      await secureSecretFile(file);
    });
    mutationQueue = operation.catch(() => {});
    return operation;
  }

  return { file, get, values, set, remove };
}

function runtimeSecretStoreError(cause) {
  const error = new Error("Runtime API-key store is unavailable or corrupt.");
  error.code = "RUNTIME_SECRET_STORE_UNAVAILABLE";
  error.status = 503;
  error.cause = cause;
  return error;
}

async function secureSecretFile(file) {
  if (process.platform !== "win32") {
    await fsp.chmod(file, 0o600);
    return;
  }
  const username = String(process.env.USERNAME || "").trim();
  const domain = String(process.env.USERDOMAIN || "").trim();
  if (!username) throw runtimeSecretStoreError(new Error("Unable to determine the current Windows account."));
  const identity = domain ? `${domain}\\${username}` : username;
  try {
    await execFileAsync("icacls.exe", [
      file,
      "/inheritance:r",
      "/grant:r",
      `${identity}:(F)`,
      "*S-1-5-18:(F)",
    ], { windowsHide: true });
  } catch (error) {
    throw runtimeSecretStoreError(error);
  }
}

function normalizeReference(value) {
  const reference = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{8,160}$/.test(reference) ? reference : "";
}

function normalizeStore(value = {}) {
  const secrets = {};
  if (value?.secrets && typeof value.secrets === "object" && !Array.isArray(value.secrets)) {
    for (const [reference, entry] of Object.entries(value.secrets)) {
      const id = normalizeReference(reference);
      const secret = String(entry?.secret || "").trim();
      if (!id || !secret) continue;
      secrets[id] = {
        secret,
        createdAt: String(entry?.createdAt || ""),
      };
    }
  }
  return { version: 1, secrets };
}

module.exports = {
  createRuntimeSecretStore,
  normalizeRuntimeSecretReference: normalizeReference,
  secureLocalSecretFile: secureSecretFile,
};
