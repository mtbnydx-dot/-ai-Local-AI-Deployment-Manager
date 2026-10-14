"use strict";

// Runtime API keys of the model containers, behind opaque references.
//
// This is a facade over the platform's single secret store (06 OPS-3b,
// manager-core/secret-store.js): the keys live DPAPI-wrapped in
// <AI_ROOT>/.runtime/secrets/<namespace>.json. The API is unchanged:
// set(secret, { prefix? }) returns a new UUID reference (optionally
// <prefix>-<uuid>), get/values are synchronous (values feeds the managers'
// redactor), remove is async, and an unreadable store throws
// RUNTIME_SECRET_STORE_UNAVAILABLE (503).
//
// The old plaintext file (<manager>/logs/runtime-api-keys.json, or the old
// default logs/runtime-secrets.json) is migrated once: its entries are imported
// under the same references, the store is read back and compared, and only
// then is the file replaced by a stub that old code reads as an empty store.
// Until that has finished, its entries are still served from the old file.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createSecretStore, mapLegacyRuntimeSecrets, secureSecretFile } = require("./secret-store");

function createRuntimeSecretStore(options = {}) {
  const legacyFile = path.resolve(String(options.file || path.join(process.cwd(), "logs", "runtime-secrets.json")));
  const namespace = String(options.namespace || `runtime.legacy-${crypto.createHash("sha256").update(legacyFile).digest("hex").slice(0, 8)}`);
  // Without an explicit root (tests), a store named only by its file lives
  // next to that file, so it never lands in a platform root by accident.
  const aiRoot = options.aiRoot || (options.file ? path.dirname(legacyFile) : undefined);
  const store = createSecretStore({
    aiRoot,
    namespace,
    dpapi: options.dpapi,
    fsImpl: options.fsImpl,
    now: options.now,
    acl: options.acl,
  });
  let legacy = { signature: undefined, entries: new Map(), error: null };
  let migration = null;
  let failedMigrationSignature;

  // Re-reads the old file only when it changed. A corrupt file fails closed
  // and is never touched.
  function readLegacy() {
    let signature;
    try {
      const stat = fs.statSync(legacyFile);
      signature = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    } catch (error) {
      if (error?.code !== "ENOENT") throw runtimeSecretStoreError(error);
      signature = "missing";
    }
    if (signature === legacy.signature) {
      if (legacy.error) throw legacy.error;
      return legacy;
    }
    try {
      const mapped = signature === "missing"
        ? { entries: [] }
        : mapLegacyRuntimeSecrets(fs.readFileSync(legacyFile, "utf8"), { namespace });
      legacy = { signature, entries: new Map(mapped.entries.map((entry) => [entry.name, entry.value])), error: null };
    } catch (error) {
      legacy = { signature, entries: new Map(), error: runtimeSecretStoreError(error) };
      throw legacy.error;
    }
    return legacy;
  }

  function migrate() {
    if (!migration) {
      const signature = legacy.signature;
      migration = (async () => {
        await store.load();
        return store.importLegacy({ file: legacyFile });
      })();
      migration.then(
        () => { failedMigrationSignature = undefined; },
        () => { failedMigrationSignature = signature; },
      ).finally(() => { migration = null; });
    }
    return migration;
  }

  // Synchronous view for get/values: the store plus, while the old file still
  // holds entries, those entries. A pending migration starts in the background
  // (once per version of the old file); writes wait for it.
  function readView() {
    const current = readLegacy();
    if (current.entries.size && !migration && failedMigrationSignature !== current.signature) {
      migrate().catch(() => {});
    }
    return current;
  }

  async function ready() {
    const current = readLegacy();
    if (current.entries.size) await migrate();
    await store.load();
  }

  function get(reference) {
    const id = normalizeReference(reference);
    if (!id) return "";
    try {
      const current = readView();
      return store.get(id) || String(current.entries.get(id) || "");
    } catch (error) {
      throw runtimeSecretStoreError(error);
    }
  }

  function values() {
    try {
      const current = readView();
      const pending = Array.from(current.entries).filter(([name]) => !store.has(name)).map(([, value]) => value);
      return store.values().concat(pending);
    } catch (error) {
      throw runtimeSecretStoreError(error);
    }
  }

  // options.prefix names the kind of reference (idle wake keeps its copies as
  // wake-<uuid>, 01 §15.3); the reference stays unique and opaque either way.
  async function set(secret, options = {}) {
    const value = String(secret || "").trim();
    if (!value) return "";
    const prefix = /^[a-z][a-z0-9]{0,15}$/.test(String(options?.prefix || "")) ? `${options.prefix}-` : "";
    const reference = `${prefix}${crypto.randomUUID()}`;
    try {
      await ready();
      await store.set(reference, value);
    } catch (error) {
      throw runtimeSecretStoreError(error);
    }
    return reference;
  }

  async function remove(reference) {
    const id = normalizeReference(reference);
    if (!id) return false;
    try {
      await ready();
      return await store.remove(id);
    } catch (error) {
      throw runtimeSecretStoreError(error);
    }
  }

  // Optional: finishes the migration and loads the store ahead of the first
  // synchronous read.
  async function load() {
    try {
      await ready();
    } catch (error) {
      throw runtimeSecretStoreError(error);
    }
  }

  return { file: store.file, legacyFile, namespace, get, values, set, remove, load };
}

function runtimeSecretStoreError(cause) {
  if (cause?.code === "RUNTIME_SECRET_STORE_UNAVAILABLE") return cause;
  const error = new Error("Runtime API-key store is unavailable or corrupt.");
  error.code = "RUNTIME_SECRET_STORE_UNAVAILABLE";
  error.status = 503;
  // Only the shape of the cause is kept: a JSON parse error quotes the file.
  if (cause && typeof cause === "object") {
    error.cause = { name: String(cause.name || "Error"), code: cause.code, ...(cause.cause ? { cause: cause.cause } : {}) };
  }
  return error;
}

async function secureSecretFileOrThrow(file) {
  try {
    await secureSecretFile(file);
  } catch (error) {
    throw runtimeSecretStoreError(error);
  }
}

function normalizeReference(value) {
  const reference = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{8,160}$/.test(reference) ? reference : "";
}

module.exports = {
  createRuntimeSecretStore,
  normalizeRuntimeSecretReference: normalizeReference,
  secureLocalSecretFile: secureSecretFileOrThrow,
};
