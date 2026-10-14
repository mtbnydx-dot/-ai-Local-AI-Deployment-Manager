"use strict";

// The shared image-ID cache (01 §17). Flags and MOD-13 registries live in
// separate sections of the same file; tags are never cache identities.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { getEngineRegistry } = require("./registry");

const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const IMAGE_ID_TTL_MS = 60_000;

function factsError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = code === "runtime_image_missing" ? 409 : 400;
  return error;
}

function createRuntimeFacts(options = {}) {
  const aiRoot = options.aiRoot || process.env.AI_ROOT || path.resolve(__dirname, "../..");
  const root = path.join(aiRoot, ".runtime", "engine-flags");
  const registry = options.registry || getEngineRegistry();
  const now = options.now || Date.now;
  const ttlMs = Math.max(0, Number(options.ttlMs ?? IMAGE_ID_TTL_MS));
  const execute = options.execFileAsync || promisify(execFile);
  const images = new Map();
  let hostConfig = options.dockerConfig;

  function resolveRuntime(runtimeId) {
    const engineId = String(runtimeId || "").split("@")[0];
    return registry.resolveRuntime(engineId, { runtimeId });
  }

  async function inspect(image, force) {
    try {
      let answer;
      if (options.resolveImageId) answer = await options.resolveImageId(image, { force });
      else {
        hostConfig ||= require("./hosts/docker").createDockerHostConfig();
        const result = await execute(hostConfig.dockerExe, [
          ...hostConfig.dockerArgsPrefix, "image", "inspect", "--format", "{{.Id}}", image,
        ], { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
        answer = result.stdout;
      }
      const id = String(answer || "").trim().toLowerCase();
      return IMAGE_ID_PATTERN.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  function imageId(image, { force = false } = {}) {
    const previous = images.get(image);
    if (!force && previous?.promise) return previous.promise;
    if (!force && previous && previous.expiresAt > now()) return Promise.resolve(previous.value);
    const promise = inspect(image, force).then((value) => {
      // A forced inspection can overlap an older read; only the newest result wins.
      if (images.get(image)?.promise === promise) images.set(image, { value, expiresAt: now() + ttlMs });
      return value;
    });
    images.set(image, { promise });
    return promise;
  }

  function fileFor(engineId, id) {
    return path.join(root, engineId, `${id.slice(7, 23)}.json`);
  }

  function read(engineId, id) {
    try {
      const value = JSON.parse(fs.readFileSync(fileFor(engineId, id), "utf8"));
      return value.schemaVersion === 1 && value.engineId === engineId && value.imageId === id ? value : null;
    } catch {
      return null;
    }
  }

  async function get(runtimeId) {
    const runtime = resolveRuntime(runtimeId);
    const id = await imageId(runtime.image);
    if (!id) return null;
    const value = read(runtime.engineId, id);
    // The same image may have multiple manifest identities. Report the identity
    // the caller resolved without duplicating or losing either fact section.
    return value ? { ...value, runtimeId: runtime.runtimeId } : null;
  }

  async function put(runtimeId, section, data, putOptions = {}) {
    if (!["flags", "registries"].includes(section)) throw factsError("invalid_facts_section", "Runtime facts section must be flags or registries.");
    if (data !== null && (typeof data !== "object" || Array.isArray(data))) throw factsError("invalid_runtime_facts", "Runtime facts must be an object or null.");
    const runtime = resolveRuntime(runtimeId);
    const id = await imageId(runtime.image, { force: true });
    if (!id) throw factsError("runtime_image_missing", "请先拉取镜像 / Pull the image first");
    if (putOptions.imageId && putOptions.imageId !== id) throw factsError("runtime_image_changed", "Runtime image changed during the probe; introspect it again.");
    const file = fileFor(runtime.engineId, id);
    // No await in the read/merge/write segment: simultaneous section puts in
    // this process each read the preceding writer's complete atomic result.
    const previous = read(runtime.engineId, id);
    const value = {
      schemaVersion: 1, engineId: runtime.engineId, runtimeId: runtime.runtimeId, imageId: id,
      flags: previous?.flags ?? null, registries: previous?.registries ?? null,
      [section]: data,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
      fs.renameSync(temp, file);
    } finally {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  return { get, put, resolveRuntime, imageId, clear: () => images.clear() };
}

let defaultStore;
function getRuntimeFacts() {
  return defaultStore ||= createRuntimeFacts();
}

module.exports = {
  IMAGE_ID_PATTERN, IMAGE_ID_TTL_MS, createRuntimeFacts, getRuntimeFacts,
  get: (...args) => getRuntimeFacts().get(...args),
  put: (...args) => getRuntimeFacts().put(...args),
};
