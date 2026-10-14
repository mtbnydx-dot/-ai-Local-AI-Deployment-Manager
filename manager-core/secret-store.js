"use strict";

// The platform's only secret store (docs/overhaul/06-ops.md §4.5, 00 §9.4).
//
// One file per namespace, <AI_ROOT>/.runtime/secrets/<namespace>.json, so the
// managers, the entry and the CLI never contend for one lock. Each value is
// wrapped with Windows DPAPI (CurrentUser) by a PowerShell child process that
// reads its request on stdin: no value ever appears in argv. The file and the
// directory carry an owner-only ACL. Without DPAPI (another OS, or a failed
// probe) a store that is not DPAPI-wrapped yet stays "acl-only" and doctor
// warns; a DPAPI-wrapped store never falls back.
//
// Reads are synchronous (get/values feed the redactors) and served from a
// cache that reloads when the file's size, mtime or identity changes. Writes
// serialise through an in-process queue plus <namespace>.json.lock, so writers
// in different processes never lose an update. A corrupt file or a blob that
// fails to unprotect raises SECRET_STORE_UNAVAILABLE and is never overwritten.

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const nodeFs = require("node:fs");
const path = require("node:path");
const { redactSecrets } = require("./secret-redactor");

const SCHEMA_VERSION = 1;
const NAMESPACE_PATTERN = /^[a-z][a-z0-9.-]{1,63}$/;
const NAME_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
// Namespaces the specs use today (06 §4.5; 01 adds engines.external). Any name
// that matches NAMESPACE_PATTERN is accepted; this list is informational.
const SECRET_NAMESPACES = Object.freeze([
  "platform",
  "platform-control",
  "hf",
  "webhooks",
  "internal",
  "admin",
  "runtime.vllm",
  "runtime.llama",
  "engines.external",
]);
const PROTECTION_DPAPI = "dpapi-user";
const PROTECTION_ACL = "acl-only";
const ENTROPY_PREFIX = "local-ai-platform:";
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 15000;
const LOCK_RETRY_MS = 25;
const DPAPI_TIMEOUT_MS = 30000;
// A synchronous call blocks the event loop, so it gives up sooner.
const DPAPI_SYNC_TIMEOUT_MS = 15000;
// A load that failed on a DPAPI call is retried after this long even when the
// file did not change, so a transient PowerShell failure does not stick.
const FAILED_LOAD_RETRY_MS = 30000;
const DPAPI_BLOB_HEADER = "AQAAANCMnd8BFdERjHoAwE/Cl+sB";

// Fixed DPAPI helper. The request ({op, entropy, items:[base64]}) arrives on
// stdin and the answer ({ok, items:[base64]}) leaves on stdout, so argv only
// ever carries this text. [char]34 keeps double quotes out of the argument.
const DPAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$q = [string][char]34",
  "try {",
  "  Add-Type -AssemblyName System.Security",
  "  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "  $entropy = [Text.Encoding]::UTF8.GetBytes([string]$request.entropy)",
  "  $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser",
  "  $items = @()",
  "  if ($request.op -eq 'probe') {",
  "    $sample = [byte[]](1, 2, 3, 4)",
  "    $wrapped = [Security.Cryptography.ProtectedData]::Protect($sample, $entropy, $scope)",
  "    $back = [Security.Cryptography.ProtectedData]::Unprotect($wrapped, $entropy, $scope)",
  "    if ([Convert]::ToBase64String($back) -ne [Convert]::ToBase64String($sample)) { throw 'probe mismatch' }",
  "  } else {",
  "    foreach ($item in @($request.items)) {",
  "      $bytes = [Convert]::FromBase64String([string]$item)",
  "      if ($request.op -eq 'protect') { $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope) }",
  "      elseif ($request.op -eq 'unprotect') { $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope) }",
  "      else { throw 'unsupported op' }",
  "      $items += $q + [Convert]::ToBase64String($result) + $q",
  "    }",
  "  }",
  "  [Console]::Out.Write('{' + $q + 'ok' + $q + ':true,' + $q + 'items' + $q + ':[' + ($items -join ',') + ']}')",
  "} catch {",
  "  $failure = $_.Exception",
  "  while ($failure.InnerException) { $failure = $failure.InnerException }",
  "  [Console]::Out.Write('{' + $q + 'ok' + $q + ':false,' + $q + 'error' + $q + ':' + $q + $failure.GetType().Name + $q + '}')",
  "  exit 1",
  "}",
].join("\n");

function defaultAiRoot() {
  return path.resolve(String(process.env.AI_ROOT || path.resolve(__dirname, "..")));
}

function secretsDirectory(aiRoot) {
  return path.join(path.resolve(String(aiRoot || defaultAiRoot())), ".runtime", "secrets");
}

function storeError(code, message, { status = 503, cause } = {}) {
  // Messages are generic and still pass the platform's only redactor (00 §9.4);
  // causes keep only their shape (summarizeCause).
  const error = new Error(redactSecrets(String(message || "Secret store error.")));
  error.code = code;
  error.status = status;
  if (cause) error.cause = summarizeCause(cause);
  return error;
}

// Only the shape of a failure survives: JSON.parse and exec errors quote file
// contents or child output, which can hold a secret.
function summarizeCause(cause) {
  if (!cause || typeof cause !== "object") return { message: String(cause || "") };
  const summary = { name: String(cause.name || "Error") };
  if (cause.code !== undefined) summary.code = cause.code;
  if (cause.status !== undefined) summary.status = cause.status;
  if (cause.signal) summary.signal = cause.signal;
  if (cause.dpapiError) summary.dpapiError = cause.dpapiError;
  if (cause.reason) summary.reason = cause.reason;
  return summary;
}

function unavailable(message, cause) {
  return storeError("SECRET_STORE_UNAVAILABLE", message, { status: 503, cause });
}

function isStoreError(error) {
  return Boolean(error && typeof error.code === "string" && /^(SECRET_STORE_|secret_store_)/.test(error.code));
}

function validateNamespace(namespace) {
  const value = String(namespace || "");
  if (!NAMESPACE_PATTERN.test(value)) {
    throw storeError("SECRET_STORE_INVALID_NAMESPACE", "Secret namespace must match ^[a-z][a-z0-9.-]{1,63}$.", { status: 400 });
  }
  return value;
}

function validateName(name) {
  const value = typeof name === "string" ? name : "";
  if (!NAME_PATTERN.test(value)) {
    throw storeError("SECRET_STORE_INVALID_NAME", "Secret name must match ^[A-Za-z0-9._:-]{1,160}$.", { status: 400 });
  }
  return value;
}

function validateValue(value) {
  if (typeof value !== "string" || !value) {
    throw storeError("SECRET_STORE_INVALID_VALUE", "A secret value must be a non-empty string.", { status: 400 });
  }
  return value;
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// DPAPI

function powershellPath() {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  return systemRoot
    ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

// Windows PowerShell 5.1 started below a pwsh 7 session inherits pwsh's
// PSModulePath and can then fail to load its own utility cmdlets. Without the
// variable it builds its default module path.
function windowsPowerShellEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
}

/**
 * Runs a command with `input` on stdin and returns its stdout: a string when
 * `sync` is set, otherwise a Promise. Tests replace it with a fake.
 */
function defaultExec(command, args, { input = "", sync = false, timeout = DPAPI_TIMEOUT_MS } = {}) {
  const options = {
    encoding: "utf8",
    env: windowsPowerShellEnv(),
    maxBuffer: 32 * 1024 * 1024,
    timeout,
    windowsHide: true,
  };
  // Explicit pipes: execFileSync would otherwise echo the child's stderr.
  if (sync) return childProcess.execFileSync(command, args, { ...options, input, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile(command, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    // A child that dies before reading stdin must not raise an EPIPE here.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function dpapiFailure(op, cause) {
  let reported = "";
  try {
    const parsed = JSON.parse(String(cause?.stdout || "").trim());
    if (parsed && typeof parsed.error === "string" && /^[A-Za-z0-9_.]{1,80}$/.test(parsed.error)) reported = parsed.error;
  } catch {}
  const error = new Error(`DPAPI ${op} failed${reported ? ` (${reported})` : ""}.`);
  error.code = "DPAPI_FAILED";
  if (reported) error.dpapiError = reported;
  if (cause?.code !== undefined) error.reason = String(cause.code);
  else if (cause?.status !== undefined) error.reason = `exit ${cause.status}`;
  return error;
}

function parseDpapiResponse(op, stdout, expected) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || "").trim());
  } catch {
    throw dpapiFailure(op, { code: "bad_response" });
  }
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.items)) throw dpapiFailure(op, { stdout: String(stdout || "") });
  if (expected !== undefined && parsed.items.length !== expected) throw dpapiFailure(op, { code: "count_mismatch" });
  if (!parsed.items.every((item) => typeof item === "string")) throw dpapiFailure(op, { code: "bad_response" });
  return parsed.items;
}

/**
 * DPAPI CurrentUser through a fixed PowerShell script (06 §4.5). One child
 * process handles a whole batch. `probe` round-trips a constant once and is
 * cached; on another OS it is false without spawning anything.
 */
function createDpapi({ exec = defaultExec, platform = process.platform, command, timeoutMs = DPAPI_TIMEOUT_MS, syncTimeoutMs = DPAPI_SYNC_TIMEOUT_MS } = {}) {
  const supported = platform === "win32";
  const shell = command || powershellPath();
  const args = ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT];
  let probeResult = null;
  let probePromise = null;

  function requestText(op, entropy, items) {
    return JSON.stringify({ op, entropy: String(entropy || ""), items });
  }

  function assertSupported(op) {
    if (!supported) throw dpapiFailure(op, { code: "unsupported_platform" });
  }

  async function call(op, entropy, items) {
    assertSupported(op);
    let stdout;
    try {
      stdout = await exec(shell, args.slice(), { input: requestText(op, entropy, items), timeout: timeoutMs });
    } catch (error) {
      throw dpapiFailure(op, error);
    }
    return parseDpapiResponse(op, stdout, op === "probe" ? undefined : items.length);
  }

  function callSync(op, entropy, items) {
    assertSupported(op);
    let stdout;
    try {
      stdout = exec(shell, args.slice(), { input: requestText(op, entropy, items), timeout: syncTimeoutMs, sync: true });
    } catch (error) {
      throw dpapiFailure(op, error);
    }
    return parseDpapiResponse(op, stdout, op === "probe" ? undefined : items.length);
  }

  const encode = (values) => values.map((value) => Buffer.from(String(value), "utf8").toString("base64"));
  const decode = (items) => items.map((item) => Buffer.from(item, "base64").toString("utf8"));

  return {
    platform,
    supported,
    async probe() {
      if (probeResult !== null) return probeResult;
      if (!supported) {
        probeResult = false;
        return probeResult;
      }
      if (!probePromise) {
        probePromise = call("probe", `${ENTROPY_PREFIX}probe`, [])
          .then(() => true, () => false)
          .then((result) => {
            probeResult = result;
            probePromise = null;
            return result;
          });
      }
      return probePromise;
    },
    probeSync() {
      if (probeResult !== null) return probeResult;
      if (!supported) {
        probeResult = false;
        return probeResult;
      }
      try {
        callSync("probe", `${ENTROPY_PREFIX}probe`, []);
        probeResult = true;
      } catch {
        probeResult = false;
      }
      return probeResult;
    },
    async protect(entropy, values) {
      if (!values.length) return [];
      return call("protect", entropy, encode(values));
    },
    protectSync(entropy, values) {
      if (!values.length) return [];
      return callSync("protect", entropy, encode(values));
    },
    async unprotect(entropy, blobs) {
      if (!blobs.length) return [];
      return decode(await call("unprotect", entropy, blobs));
    },
    unprotectSync(entropy, blobs) {
      if (!blobs.length) return [];
      return decode(callSync("unprotect", entropy, blobs));
    },
  };
}

let sharedDpapi = null;
function defaultDpapi() {
  if (!sharedDpapi) sharedDpapi = createDpapi();
  return sharedDpapi;
}

// ---------------------------------------------------------------------------
// ACL (today's secureSecretFile: owner plus SYSTEM, no inheritance)

function currentWindowsIdentity() {
  const username = String(process.env.USERNAME || "").trim();
  const domain = String(process.env.USERDOMAIN || "").trim();
  if (!username) throw new Error("Unable to determine the current Windows account.");
  return domain ? `${domain}\\${username}` : username;
}

function aclArguments(target, directory) {
  const rights = directory ? "(OI)(CI)F" : "(F)";
  return [target, "/inheritance:r", "/grant:r", `${currentWindowsIdentity()}:${rights}`, `*S-1-5-18:${rights}`];
}

const defaultAcl = Object.freeze({
  async secure(target, { directory = false } = {}) {
    if (process.platform !== "win32") {
      await nodeFs.promises.chmod(target, directory ? 0o700 : 0o600);
      return;
    }
    const args = aclArguments(target, directory);
    await new Promise((resolve, reject) => {
      childProcess.execFile("icacls.exe", args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()));
    });
  },
});

// ---------------------------------------------------------------------------
// Files

function statSignature(stat) {
  return `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}

function readSignature(fsImpl, file) {
  try {
    return statSignature(fsImpl.statSync(file));
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw unavailable("The secret store file cannot be read.", error);
  }
}

async function renameWithRetry(fsImpl, temp, file) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsImpl.promises.rename(temp, file);
      return;
    } catch (error) {
      // Windows rejects a replace while another process has the target open.
      const retryable = ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
      if (!retryable || attempt >= 12) {
        await fsImpl.promises.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      await delay(25 * attempt);
    }
  }
}

async function writeFileAtomic(fsImpl, file, text) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  await fsImpl.promises.writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  await renameWithRetry(fsImpl, temp, file);
}

function stringifyDocument(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Legacy formats

/**
 * Default legacy map: the runtime key files ({version, secrets:{reference:
 * {secret, createdAt}}}) at <manager>/logs/runtime-api-keys.json and the old
 * default logs/runtime-secrets.json. Each entry keeps its reference, and the
 * replacement is the stub that old code reads as an empty store.
 */
function mapLegacyRuntimeSecrets(text, { namespace } = {}) {
  const parsed = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed.secrets !== undefined && (!parsed.secrets || typeof parsed.secrets !== "object" || Array.isArray(parsed.secrets)))) {
    throw new Error("invalid runtime secret store shape");
  }
  const entries = [];
  for (const [reference, entry] of Object.entries(parsed.secrets || {})) {
    const name = String(reference || "").trim();
    const value = String(entry?.secret || "").trim();
    if (!/^[a-zA-Z0-9_-]{8,160}$/.test(name) || !value) continue;
    entries.push({ name, value, createdAt: String(entry?.createdAt || "") });
  }
  return {
    entries,
    replacement: stringifyDocument({ version: 1, secrets: {}, migratedTo: `secret-store:${namespace}` }),
  };
}

// ---------------------------------------------------------------------------
// Store

function parseDocument(text, namespace) {
  let parsed;
  try {
    parsed = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw unavailable("The secret store file is corrupt.", { name: error?.name || "SyntaxError", reason: "invalid_json" });
  }
  const invalid = (reason) => unavailable("The secret store file is corrupt.", { name: "Error", reason });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("not_an_object");
  if (parsed.schemaVersion !== SCHEMA_VERSION) throw invalid("unsupported_schema_version");
  if (parsed.namespace !== namespace) throw invalid("namespace_mismatch");
  if (![PROTECTION_DPAPI, PROTECTION_ACL].includes(parsed.protection)) throw invalid("unknown_protection");
  if (!parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) throw invalid("entries_not_an_object");
  const entries = new Map();
  for (const [name, entry] of Object.entries(parsed.entries)) {
    if (!NAME_PATTERN.test(name) || !entry || typeof entry !== "object") throw invalid("invalid_entry");
    const record = {
      createdAt: String(entry.createdAt || ""),
      updatedAt: String(entry.updatedAt || entry.createdAt || ""),
    };
    if (parsed.protection === PROTECTION_DPAPI) {
      if (typeof entry.blob !== "string" || !entry.blob) throw invalid("missing_blob");
      record.blob = entry.blob;
    } else {
      if (typeof entry.value !== "string" || !entry.value) throw invalid("missing_value");
      record.value = entry.value;
    }
    entries.set(name, record);
  }
  return { protection: parsed.protection, entries };
}

function buildDocument(namespace, protection, entries) {
  const out = {};
  for (const name of Array.from(entries.keys()).sort()) {
    const entry = entries.get(name);
    out[name] = protection === PROTECTION_DPAPI
      ? { blob: entry.blob, createdAt: entry.createdAt, updatedAt: entry.updatedAt }
      : { value: entry.value, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
  }
  return { schemaVersion: SCHEMA_VERSION, namespace, protection, entries: out };
}

/**
 * createSecretStore({ aiRoot, namespace, dpapi, fsImpl, now, acl }) — one
 * namespace file. get/has/list/values are synchronous; set/remove/importLegacy
 * are queued and locked. See 06 §4.5.
 */
function createSecretStore({ aiRoot, namespace, dpapi, fsImpl = nodeFs, now = () => new Date(), acl = defaultAcl } = {}) {
  const ns = validateNamespace(namespace);
  const protector = dpapi || defaultDpapi();
  const directory = secretsDirectory(aiRoot);
  const file = path.join(directory, `${ns}.json`);
  const lockFile = `${file}.lock`;
  const entropy = `${ENTROPY_PREFIX}${ns}`;
  // name -> { value, blob?, createdAt, updatedAt }
  let cache = { signature: undefined, protection: null, entries: new Map() };
  let failure = null;
  // blob -> value: a reload unprotects only blobs it has not seen yet.
  let knownBlobs = new Map();
  let queue = Promise.resolve();
  // The ACL error of a directory this store created, reported by the next write.
  let directoryAclError = null;

  function knownValues() {
    return Array.from(cache.entries.values(), (entry) => entry.value).filter(Boolean);
  }

  function readDocument() {
    const signature = readSignature(fsImpl, file);
    if (signature === "missing") return { signature, document: null };
    let text;
    try {
      text = fsImpl.readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { signature: "missing", document: null };
      throw unavailable("The secret store file cannot be read.", error);
    }
    return { signature, document: parseDocument(text, ns) };
  }

  function unknownBlobs(document) {
    if (!document || document.protection !== PROTECTION_DPAPI) return [];
    return Array.from(new Set(Array.from(document.entries.values(), (entry) => entry.blob)))
      .filter((blob) => !knownBlobs.has(blob));
  }

  function decrypted(document, blobs, values) {
    const blobValues = new Map(knownBlobs);
    blobs.forEach((blob, index) => blobValues.set(blob, values[index]));
    const entries = new Map();
    if (document) {
      for (const [name, entry] of document.entries) {
        const value = document.protection === PROTECTION_DPAPI ? blobValues.get(entry.blob) : entry.value;
        if (typeof value !== "string" || !value) throw unavailable("A secret could not be unprotected.", { name: "Error", reason: "empty_value" });
        entries.set(name, { ...entry, value });
      }
    }
    return entries;
  }

  function commit(signature, document, entries) {
    const blobs = new Map();
    for (const entry of entries.values()) if (entry.blob) blobs.set(entry.blob, entry.value);
    knownBlobs = blobs;
    cache = { signature, protection: document ? document.protection : null, entries };
    failure = null;
  }

  function unprotectFailure(error) {
    return isStoreError(error) ? error : unavailable("A secret could not be unprotected.", error);
  }

  function shouldReuseFailure(signature) {
    return failure && failure.signature === signature
      && (!failure.retryable || Date.now() - failure.at < FAILED_LOAD_RETRY_MS);
  }

  function rememberFailure(signature, error, retryable) {
    failure = { signature, error, at: Date.now(), retryable };
    return error;
  }

  function loadSync() {
    const current = readSignature(fsImpl, file);
    if (current === cache.signature && !failure) return;
    if (shouldReuseFailure(current)) throw failure.error;
    let state;
    try {
      state = readDocument();
    } catch (error) {
      throw rememberFailure(current, error, false);
    }
    const blobs = unknownBlobs(state.document);
    let values;
    try {
      values = protector.unprotectSync(entropy, blobs);
    } catch (error) {
      throw rememberFailure(state.signature, unprotectFailure(error), true);
    }
    try {
      commit(state.signature, state.document, decrypted(state.document, blobs, values));
    } catch (error) {
      throw rememberFailure(state.signature, error, true);
    }
  }

  async function load() {
    const current = readSignature(fsImpl, file);
    if (current === cache.signature && !failure) return;
    if (shouldReuseFailure(current)) throw failure.error;
    let state;
    try {
      state = readDocument();
    } catch (error) {
      throw rememberFailure(current, error, false);
    }
    const blobs = unknownBlobs(state.document);
    let values;
    try {
      values = await protector.unprotect(entropy, blobs);
    } catch (error) {
      throw rememberFailure(state.signature, unprotectFailure(error), true);
    }
    // Another load may have committed a newer file while this one waited.
    if (cache.signature === readSignature(fsImpl, file) && !failure) return;
    try {
      commit(state.signature, state.document, decrypted(state.document, blobs, values));
    } catch (error) {
      throw rememberFailure(state.signature, error, true);
    }
  }

  function has(name) {
    const key = validateName(name);
    loadSync();
    return cache.entries.has(key);
  }

  function get(name) {
    const key = validateName(name);
    loadSync();
    return cache.entries.get(key)?.value || "";
  }

  function list() {
    loadSync();
    return Array.from(cache.entries.keys()).sort().map((name) => {
      const entry = cache.entries.get(name);
      return { name, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    });
  }

  function values() {
    loadSync();
    return knownValues();
  }

  function enqueue(task) {
    const run = queue.then(() => task());
    queue = run.catch(() => {});
    return run;
  }

  async function acquireLock() {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await fsImpl.promises.open(lockFile, "wx");
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        } finally {
          await handle.close();
        }
        return () => fsImpl.promises.rm(lockFile, { force: true }).catch(() => {});
      } catch (error) {
        if (error?.code === "ENOENT") {
          await ensureDirectory();
          if (Date.now() > deadline) throw unavailable("The secret store directory cannot be created.", error);
          continue;
        }
        if (error?.code !== "EEXIST") throw unavailable("The secret store lock cannot be taken.", error);
      }
      try {
        const stat = fsImpl.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fsImpl.promises.rm(lockFile, { force: true }).catch(() => {});
          continue;
        }
      } catch {}
      if (Date.now() > deadline) {
        throw storeError("SECRET_STORE_LOCKED", "The secret store is locked by another writer.", { status: 503 });
      }
      await delay(LOCK_RETRY_MS);
    }
  }

  async function ensureDirectory() {
    const created = fsImpl.mkdirSync(directory, { recursive: true });
    if (!created) return;
    try {
      await acl.secure(directory, { directory: true });
    } catch (error) {
      directoryAclError = error;
    }
  }

  // Reads the current file under the lock and decrypts every entry, so a
  // write never replaces a file it could not read in full.
  async function readCurrent() {
    const state = readDocument();
    const blobs = unknownBlobs(state.document);
    let values;
    try {
      values = await protector.unprotect(entropy, blobs);
    } catch (error) {
      throw unprotectFailure(error);
    }
    return { ...state, entries: decrypted(state.document, blobs, values) };
  }

  async function targetProtection(current) {
    // A DPAPI-wrapped store never falls back to plaintext.
    if (current.document?.protection === PROTECTION_DPAPI) return PROTECTION_DPAPI;
    return (await protector.probe()) ? PROTECTION_DPAPI : PROTECTION_ACL;
  }

  /**
   * mutate(entries, stamp) edits the decrypted map in place and returns true
   * when it changed something. Runs under the lock.
   */
  async function commitLocked(mutate) {
    const current = await readCurrent();
    const entries = new Map(Array.from(current.entries, ([name, entry]) => [name, { ...entry }]));
    const stamp = toIso(now());
    if (!mutate(entries, stamp)) {
      commit(current.signature, current.document, current.entries);
      return { changed: false, aclError: null };
    }
    const protection = await targetProtection(current);
    if (protection === PROTECTION_DPAPI) {
      const pending = Array.from(entries.values()).filter((entry) => !entry.blob);
      let blobs;
      try {
        blobs = await protector.protect(entropy, pending.map((entry) => entry.value));
      } catch (error) {
        throw unavailable("A secret could not be protected.", error);
      }
      pending.forEach((entry, index) => { entry.blob = blobs[index]; });
    } else {
      for (const entry of entries.values()) delete entry.blob;
    }
    const document = buildDocument(ns, protection, entries);
    await ensureDirectory();
    await writeFileAtomic(fsImpl, file, stringifyDocument(document));
    let aclError = directoryAclError;
    directoryAclError = null;
    try {
      await acl.secure(file);
    } catch (error) {
      aclError = aclError || error;
    }
    commit(readSignature(fsImpl, file), { protection, entries }, entries);
    return { changed: true, aclError };
  }

  async function withLock(task) {
    const release = await acquireLock();
    try {
      return await task();
    } finally {
      await release();
    }
  }

  function aclFailed(error) {
    // The write stays in place; the caller learns that the ACL is not owner-only.
    return storeError("secret_store_acl_failed", "The secret was stored, but its owner-only ACL could not be applied.", { status: 500, cause: error });
  }

  async function set(name, value) {
    const key = validateName(name);
    const secret = validateValue(value);
    await enqueue(() => withLock(async () => {
      const result = await commitLocked((entries, stamp) => {
        const existing = entries.get(key);
        if (existing && existing.value === secret) return false;
        entries.set(key, { value: secret, createdAt: existing?.createdAt || stamp, updatedAt: stamp });
        return true;
      });
      if (result.aclError) throw aclFailed(result.aclError);
    }));
  }

  async function remove(name) {
    const key = validateName(name);
    let existed = false;
    await enqueue(async () => {
      // Nothing to remove from a store that does not exist yet: no lock, no directory.
      if (readSignature(fsImpl, file) === "missing") return;
      await withLock(async () => {
        const result = await commitLocked((entries) => {
          existed = entries.delete(key);
          return existed;
        });
        if (result.aclError) throw aclFailed(result.aclError);
      });
    });
    return existed;
  }

  // Reads the file back and unprotects the imported names afresh, without the
  // blob cache, so the comparison proves what is on disk.
  async function verifyOnDisk(expected) {
    const state = readDocument();
    if (!state.document) throw unavailable("Legacy import verification failed.", { name: "Error", reason: "store_missing" });
    const names = expected.map((entry) => entry.name);
    const records = names.map((name) => state.document.entries.get(name));
    if (records.some((record) => !record)) throw unavailable("Legacy import verification failed.", { name: "Error", reason: "entry_missing" });
    let actual;
    if (state.document.protection === PROTECTION_DPAPI) {
      try {
        actual = await protector.unprotect(entropy, records.map((record) => record.blob));
      } catch (error) {
        throw unprotectFailure(error);
      }
    } else {
      actual = records.map((record) => record.value);
    }
    if (expected.some((entry, index) => actual[index] !== entry.value)) {
      throw unavailable("Legacy import verification failed.", { name: "Error", reason: "value_mismatch" });
    }
  }

  /**
   * One-time migration of a plaintext file (06 §4.5): import every entry under
   * its own name, read the store back and compare, and only then replace the
   * legacy file with map's `replacement` (when the file still holds what was
   * imported). A file map cannot parse aborts with SECRET_STORE_UNAVAILABLE
   * and stays byte-identical. A file with nothing to import is left alone.
   */
  async function importLegacy({ file: legacyFile, map = mapLegacyRuntimeSecrets } = {}) {
    const source = path.resolve(String(legacyFile || ""));
    return enqueue(async () => {
      let text;
      try {
        text = fsImpl.readFileSync(source, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return { imported: 0, skipped: 0, replaced: false };
        throw unavailable("The legacy secret file cannot be read.", error);
      }
      let mapped;
      try {
        mapped = map(text, { namespace: ns, file: source }) || {};
      } catch (error) {
        throw unavailable("The legacy secret file is corrupt.", { name: error?.name || "Error", reason: "legacy_unreadable" });
      }
      const legacyEntries = [];
      for (const entry of Array.isArray(mapped.entries) ? mapped.entries : []) {
        const name = String(entry?.name || "");
        const value = typeof entry?.value === "string" ? entry.value : "";
        if (!NAME_PATTERN.test(name) || !value) continue;
        legacyEntries.push({ name, value, createdAt: String(entry.createdAt || "") });
      }
      // Nothing to import (already a stub, or empty): the file is left alone.
      if (!legacyEntries.length) return { imported: 0, skipped: 0, replaced: false };
      return withLock(() => importLocked(source, text, mapped, legacyEntries));
    });
  }

  async function importLocked(source, text, mapped, legacyEntries) {
    let imported = 0;
    let skipped = 0;
    const result = await commitLocked((entries, stamp) => {
      for (const entry of legacyEntries) {
        const existing = entries.get(entry.name);
        if (existing && existing.value === entry.value) {
          skipped += 1;
          continue;
        }
        entries.set(entry.name, {
          value: entry.value,
          createdAt: entry.createdAt || existing?.createdAt || stamp,
          updatedAt: stamp,
        });
        imported += 1;
      }
      return imported > 0;
    });
    await verifyOnDisk(legacyEntries);
    let replaced = false;
    // A store whose ACL could not be applied keeps the legacy file as it is.
    if (typeof mapped.replacement === "string" && !result.aclError) {
      let latest = null;
      try {
        latest = fsImpl.readFileSync(source, "utf8");
      } catch {}
      if (latest === text) {
        await writeFileAtomic(fsImpl, source, mapped.replacement);
        // The replacement holds no secret, so an ACL failure here is not fatal.
        await acl.secure(source).catch(() => {});
        replaced = true;
      }
    }
    if (result.aclError) throw aclFailed(result.aclError);
    return { imported, skipped, replaced };
  }

  return {
    namespace: ns,
    file,
    // The protection of the file on disk, or the one the next write uses.
    get protection() {
      if (cache.protection && cache.signature === readSignature(fsImpl, file)) return cache.protection;
      try {
        const state = readDocument();
        if (state.document) return state.document.protection;
      } catch {}
      return protector.supported === false ? PROTECTION_ACL : PROTECTION_DPAPI;
    },
    load,
    loadSync,
    has,
    get,
    list,
    values,
    set,
    remove,
    importLegacy,
  };
}

function listSecretNamespaces(aiRoot) {
  let names;
  try {
    names = nodeFs.readdirSync(secretsDirectory(aiRoot));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((name) => NAMESPACE_PATTERN.test(name))
    .sort();
}

// Store instances shared by allSecretValues, per protector, so repeated
// redactor feeds reuse the decrypted cache instead of spawning PowerShell.
const sharedStores = new WeakMap();

function sharedStore(aiRoot, namespace, dpapi) {
  const protector = dpapi || defaultDpapi();
  let stores = sharedStores.get(protector);
  if (!stores) {
    stores = new Map();
    sharedStores.set(protector, stores);
  }
  const key = `${aiRoot}\u0000${namespace}`;
  if (!stores.has(key)) stores.set(key, createSecretStore({ aiRoot, namespace, dpapi: protector }));
  return stores.get(key);
}

/**
 * Every stored value across namespaces: the redactor feed for a process that
 * reads several namespaces. A namespace that cannot be read is skipped and
 * reported through onError, so the others still redact.
 */
function allSecretValues(aiRoot, { namespaces, dpapi, onError } = {}) {
  const root = path.resolve(String(aiRoot || defaultAiRoot()));
  const selected = Array.isArray(namespaces) ? namespaces : listSecretNamespaces(root);
  const collected = [];
  for (const namespace of selected) {
    try {
      collected.push(...sharedStore(root, validateNamespace(namespace), dpapi).values());
    } catch (error) {
      if (typeof onError === "function") onError(namespace, error);
    }
  }
  return Array.from(new Set(collected));
}

/**
 * Namespace-first view over the per-namespace stores, for callers that hold
 * several namespaces: get(ns, name), has(ns, name), set(ns, name, value),
 * clear(ns, name) (alias remove), list(ns) and values(namespaces?).
 */
function createSecretVault({ aiRoot, dpapi, fsImpl, now, acl } = {}) {
  const root = path.resolve(String(aiRoot || defaultAiRoot()));
  const protector = dpapi || defaultDpapi();
  const stores = new Map();
  function store(namespace) {
    const ns = validateNamespace(namespace);
    if (!stores.has(ns)) stores.set(ns, createSecretStore({ aiRoot: root, namespace: ns, dpapi: protector, fsImpl, now, acl }));
    return stores.get(ns);
  }
  return {
    aiRoot: root,
    store,
    has: (namespace, name) => store(namespace).has(name),
    get: (namespace, name) => store(namespace).get(name),
    set: (namespace, name, value) => store(namespace).set(name, value),
    clear: (namespace, name) => store(namespace).remove(name),
    remove: (namespace, name) => store(namespace).remove(name),
    list: (namespace) => store(namespace).list(),
    values(namespaces) {
      const selected = Array.isArray(namespaces) ? namespaces : listSecretNamespaces(root);
      return Array.from(new Set(selected.flatMap((namespace) => store(namespace).values())));
    },
  };
}

module.exports = {
  SECRET_NAMESPACES,
  SECRET_STORE_SCHEMA_VERSION: SCHEMA_VERSION,
  DPAPI_BLOB_HEADER,
  createSecretStore,
  createDpapi,
  createSecretVault,
  listSecretNamespaces,
  allSecretValues,
  mapLegacyRuntimeSecrets,
  secretsDirectory,
  secureSecretFile: (target, options) => defaultAcl.secure(target, options),
};
