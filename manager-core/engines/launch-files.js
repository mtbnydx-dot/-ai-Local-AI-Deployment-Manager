"use strict";

// Generated launch files (docs/overhaul/01-engines.md §19.1, ENG-18). A
// docker-template engine can need config files that the platform writes for one
// launch and mounts read-only into the container (TabbyAPI's config.yml and
// api_tokens.yml, TensorRT-LLM's extra_llm_api_options file). They live in
// <AI_ROOT>/.runtime/launch-files/<launchId>/ and have this lifecycle:
//
//   write   the supervisor writes them just before the container is created
//   keep    they stay for the life of the instance (docker restarts the
//           container on failure and re-reads the mounts)
//   remove  the whole directory is deleted when the instance stops, and when a
//           start fails or is rolled back
//
// A file marked secret holds an API key. It is created owner-only (mode 0600
// in a 0700 directory; on Windows the ACL is reduced to the current user with
// icacls) and a failure to restrict it fails the launch instead of leaving a
// readable key behind. scripts/scrub-job-ledgers.js reports any leftover.
//
//   createLaunchFiles({ root, platform?, env?, execFile?, fs? })
//     .baseDir                          <root>/.runtime/launch-files
//     .dirFor(launchId)                 the directory of one launch
//     .hostPathFor(launchId, file)      where one file lands (the adapter mounts this path)
//     .write(launchId, files)           → [{ id, hostPath, target, secret }]
//     .remove(launchId)                 → { removed }
//     .removeForContainer(container)    → { removed }  (the id is the container's ai.manager.launch-id label)
//     .list()                           → launch ids that have a directory
//
// files: [{ id, target, format: "yaml"|"json"|"text", content, secret }]; content
// is an object (yaml, json) or a string (text).

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { emitYaml } = require("./yaml-emit");

const LAUNCH_ID_PATTERN = /^lch_[A-Za-z0-9]{1,40}$/;
const LAUNCH_ID_LABEL = "ai.manager.launch-id";
const FILE_ID_PATTERN = /^[a-z][A-Za-z0-9_]{0,31}$/;
const EXTENSIONS = Object.freeze({ yaml: ".yml", json: ".json", text: ".txt" });
const MAX_FILE_BYTES = 1024 * 1024;
// DOMAIN\user or user, as icacls takes it; nothing that could be read as an option or a list.
const ACL_USER_PATTERN = /^[\w.@ -]{1,64}(?:\\[\w.@ -]{1,64})?$/;

function launchFileError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 500;
  return error;
}

/** The file name a template file gets on the host: <id>.yml, <id>.json or <id>.txt. */
function launchFileName(file) {
  if (!file || !FILE_ID_PATTERN.test(String(file.id || ""))) throw launchFileError("launch_file_invalid", "A launch file needs a valid id.");
  const extension = EXTENSIONS[file.format];
  if (!extension) throw launchFileError("launch_file_invalid", `Unknown launch file format: ${String(file.format).slice(0, 16)}.`);
  return `${file.id}${extension}`;
}

/** { format, content } → the file text. YAML goes through the in-house emitter. */
function serializeLaunchFile(file) {
  let text;
  if (file.format === "yaml") text = emitYaml(file.content);
  else if (file.format === "json") text = `${JSON.stringify(file.content, null, 2)}\n`;
  else if (file.format === "text") text = typeof file.content === "string" ? file.content : String(file.content ?? "");
  else throw launchFileError("launch_file_invalid", `Unknown launch file format: ${String(file.format).slice(0, 16)}.`);
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw launchFileError("launch_file_too_large", `Launch file ${file.id} is larger than ${MAX_FILE_BYTES} bytes.`);
  return text;
}

function createLaunchFiles(options = {}) {
  const root = path.resolve(String(options.root || ""));
  if (!options.root) throw new TypeError("createLaunchFiles needs the platform root.");
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const fsImpl = options.fs || fs;
  const execFile = options.execFile || ((file, args) => new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
  }));
  const baseDir = path.join(root, ".runtime", "launch-files");

  function dirFor(launchId) {
    const id = String(launchId || "");
    if (!LAUNCH_ID_PATTERN.test(id)) throw launchFileError("launch_id_invalid", "A launch id (lch_...) is required for launch files.");
    return path.join(baseDir, id);
  }

  function hostPathFor(launchId, file) {
    return path.join(dirFor(launchId), launchFileName(file));
  }

  function aclUser() {
    const name = String(env.USERNAME || "").trim();
    const domain = String(env.USERDOMAIN || "").trim();
    const user = domain && name ? `${domain}\\${name}` : name;
    if (!user || !ACL_USER_PATTERN.test(user)) throw launchFileError("launch_file_acl_failed", "The current Windows user is unknown, so a secret launch file cannot be restricted.");
    return user;
  }

  // Owner-only access. icacls /inheritance:r drops every inherited entry and
  // /grant:r leaves exactly one: the current user.
  async function restrict(target, { directory }) {
    if (platform !== "win32") {
      fsImpl.chmodSync(target, directory ? 0o700 : 0o600);
      return;
    }
    const user = aclUser();
    await execFile("icacls", [target, "/inheritance:r", "/grant:r", `${user}:${directory ? "(OI)(CI)F" : "F"}`]);
  }

  async function write(launchId, files) {
    const dir = dirFor(launchId);
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return [];
    const seen = new Set();
    const planned = list.map((file) => {
      const name = launchFileName(file);
      if (seen.has(name)) throw launchFileError("launch_file_invalid", `Launch file ${file.id} is listed twice.`);
      seen.add(name);
      return { file, name, text: serializeLaunchFile(file) };
    });
    // A directory left by an earlier attempt with this id is replaced whole.
    fsImpl.rmSync(dir, { recursive: true, force: true });
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const anySecret = planned.some(({ file }) => file.secret === true);
    try {
      // The directory is restricted before the first secret byte lands in it.
      if (anySecret) await restrict(dir, { directory: true });
      const written = [];
      for (const { file, name, text } of planned) {
        const hostPath = path.join(dir, name);
        fsImpl.writeFileSync(hostPath, text, { mode: file.secret === true ? 0o600 : 0o644, flag: "wx" });
        if (file.secret === true) await restrict(hostPath, { directory: false });
        written.push({ id: file.id, hostPath, target: file.target, secret: file.secret === true });
      }
      return written;
    } catch (error) {
      fsImpl.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Deletes the launch's directory (secret files included). Missing is fine. */
  async function remove(launchId) {
    const dir = dirFor(launchId);
    const existed = fsImpl.existsSync(dir);
    fsImpl.rmSync(dir, { recursive: true, force: true });
    return { removed: existed, dir };
  }

  /**
   * A stopped instance's files: the launch id is on the container's
   * ai.manager.launch-id label (a container or its labels). No label, no files.
   */
  async function removeForContainer(container) {
    const labels = container && typeof container === "object" && container.labels && typeof container.labels === "object" ? container.labels : container;
    const launchId = String(labels?.[LAUNCH_ID_LABEL] || "").trim();
    if (!LAUNCH_ID_PATTERN.test(launchId)) return { removed: false, dir: null };
    return remove(launchId);
  }

  function list() {
    if (!fsImpl.existsSync(baseDir)) return [];
    return fsImpl.readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && LAUNCH_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  return { baseDir, dirFor, hostPathFor, write, remove, removeForContainer, list };
}

module.exports = {
  EXTENSIONS,
  LAUNCH_ID_PATTERN,
  createLaunchFiles,
  launchFileName,
  serializeLaunchFile,
};
