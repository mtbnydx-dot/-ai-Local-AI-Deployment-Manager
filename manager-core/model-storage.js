"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function storageError(message, status = 409) { return Object.assign(new Error(message), { status }); }
function pathKey(value) { const p = path.resolve(value); return process.platform === "win32" ? p.toLowerCase() : p; }
function containsPath(root, value) { const a = pathKey(root), b = pathKey(value); return a === b || b.startsWith(a + path.sep); }
function overlapsPath(a, b) { return containsPath(a, b) || containsPath(b, a); }
function isProcessAlive(pid) { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; } }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (e) { if (e.code === "ENOENT") return fallback; throw storageError(`存储记录无法读取：${file}`); } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: "wx" });
  fs.renameSync(temp, file);
}

function createModelStorage(options = {}) {
  const legacyRoot = path.resolve(options.modelsRoot);
  const file = path.resolve(options.file || path.join(path.dirname(legacyRoot), "service-entry/data/model-storage.json"));
  const operationDir = path.join(path.dirname(file), "model-operations");
  const defaultState = () => ({ version: 1, roots: [], defaultRootId: "legacy", aliases: [] });
  const read = () => readJson(file, defaultState());
  function roots() {
    const result = [{ id: "legacy", label: "原模型库", path: legacyRoot, mode: "library" }];
    for (const r of read().roots || []) if (!result.some(x => pathKey(x.path) === pathKey(r.path))) result.push(r);
    return result;
  }
  function mutate(fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    let fd;
    try { fd = fs.openSync(lock, "wx"); } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const owner = readJson(lock, null);
      if (owner?.pid && !isProcessAlive(owner.pid)) { fs.unlinkSync(lock); fd = fs.openSync(lock, "wx"); }
      else throw storageError("另一个存储操作正在保存，请稍后重试。");
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); const data = read(); const result = fn(data); writeJson(file, data); return result; }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  function assertOrdinaryPath(value) {
    const text = String(value || "").trim();
    if (!path.isAbsolute(text) || /[\0\r\n]/.test(text) || (process.platform === "win32" && (/^\\\\[?.]/.test(text) || /[:*?"<>|]/.test(text.slice(2))))) throw storageError("请输入有效的绝对文件夹路径，例如 F:\\AI\\models。", 400);
    const resolved = path.resolve(text);
    if (resolved === path.parse(resolved).root) throw storageError("请选择盘符下的专用模型文件夹，不能将整个磁盘作为模型库。", 400);
    return resolved;
  }
  function rootFor(value) { return roots().filter(r => containsPath(r.path, value)).sort((a, b) => b.path.length - a.path.length)[0] || null; }
  function followAliases(value) {
    let current = path.resolve(value);
    const aliases = read().aliases || [];
    for (let i = 0; i <= aliases.length; i++) {
      const a = aliases.find(x => containsPath(x.from, current));
      if (!a) return current;
      current = path.join(a.to, path.relative(a.from, current));
    }
    throw storageError("模型迁移路径存在循环，请检查迁移记录。");
  }
  function resolvePath(value, { follow = true, allowRoot = true } = {}) {
    if (!path.isAbsolute(String(value || ""))) throw storageError("模型路径必须是绝对路径。", 400);
    const target = follow ? followAliases(value) : path.resolve(value);
    const root = rootFor(target);
    if (!root || (!allowRoot && root.mode === "library" && pathKey(target) === pathKey(root.path))) throw storageError("路径必须位于已登记的模型库内，且不能操作整个模型库。", 400);
    // Validate real ancestors too: a nested junction must not escape the library.
    let ancestor = target;
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    if (fs.existsSync(root.path)) {
      const realRoot = fs.realpathSync(root.path), realAncestor = fs.realpathSync(ancestor);
      if (!containsPath(realRoot, realAncestor)) throw storageError("模型路径经过指向库外的链接，请直接登记实际目录。", 400);
    } else throw storageError(`模型库当前不可用：${root.path}`, 503);
    return target;
  }
  function fromContainerPath(value) {
    const text = String(value || "");
    if (text === "/models" || text.startsWith("/models/")) return path.join(legacyRoot, text.slice(7));
    for (const r of roots()) { const prefix = `/model-storage/${r.id}`; if (text === prefix || text.startsWith(prefix + "/")) return path.join(r.path, text.slice(prefix.length)); }
    return text;
  }
  function toContainerPath(value) {
    const input = fromContainerPath(value);
    if (!path.isAbsolute(input)) return input;
    const target = resolvePath(input);
    assertUnlocked([target]);
    const r = rootFor(target), prefix = r.id === "legacy" ? "/models" : `/model-storage/${r.id}`;
    const relative = path.relative(r.path, target).split(path.sep).join("/");
    return relative ? `${prefix}/${relative}` : prefix;
  }
  function dockerMountArgs() {
    return roots().filter(r => fs.existsSync(r.path)).flatMap(r => ["-v", `${r.path}:${r.id === "legacy" ? "/models" : `/model-storage/${r.id}`}`]);
  }
  function activeOperations() {
    if (!fs.existsSync(operationDir)) return [];
    return fs.readdirSync(operationDir).filter(n => /^[\da-f-]+\.json$/.test(n)).map(n => readJson(path.join(operationDir, n), null)).filter(x => x && (isProcessAlive(x.pid) || (x.childPid && isProcessAlive(x.childPid))));
  }
  function assertUnlocked(targets, excludeId = "") {
    const busy = activeOperations().find(o => o.id !== excludeId && o.targets.some(a => targets.some(b => overlapsPath(a, b))));
    if (busy) throw storageError(`目录正在${busy.kind === "download" ? "下载" : "迁移或校验"}，请等待任务完成：${busy.targets[0]}`);
  }
  function acquireOperation(targets, kind, id = crypto.randomUUID()) {
    return mutate(() => {
      if (activeOperations().some(o => o.id === id)) throw storageError("此任务已在另一个操作中运行，请等待完成。");
      assertUnlocked(targets);
      fs.mkdirSync(operationDir, { recursive: true });
      writeJson(path.join(operationDir, `${id}.json`), { id, pid: process.pid, kind, targets: targets.map(x => path.resolve(x)), createdAt: new Date().toISOString() });
      return id;
    });
  }
  function releaseOperation(id) {
    if (!/^[\da-f-]+$/.test(String(id || ""))) return;
    const p = path.join(operationDir, `${id}.json`), record = readJson(p, null);
    if (record?.pid === process.pid) fs.rmSync(p, { force: true });
  }
  function trackChild(id, childPid) {
    const p = path.join(operationDir, `${id}.json`), record = readJson(p, null);
    if (record?.pid === process.pid) writeJson(p, { ...record, childPid });
  }
  function registerRoot(input = {}) {
    let target = assertOrdinaryPath(input.path);
    if (roots().some(r => overlapsPath(r.path, target))) throw storageError("这个路径已登记，或与已有模型库重叠。", 400);
    if (!fs.existsSync(target)) {
      if (!input.create) throw storageError("目录不存在；勾选“创建文件夹”后可创建。", 400);
      fs.mkdirSync(target, { recursive: true });
    }
    if (!fs.statSync(target).isDirectory()) throw storageError("请选择文件夹。", 400);
    target = fs.realpathSync(target);
    if (roots().some(r => overlapsPath(r.path, target))) throw storageError("这个路径已登记，或与已有模型库重叠。", 400);
    const mode = input.mode === "model" ? "model" : "library";
    if (mode === "model" && !fs.readdirSync(target).some(n => /\.(gguf|safetensors)$|^(config|params)\.json$/.test(n))) throw storageError("该目录未发现模型配置或权重；请选择模型本身所在的目录。", 400);
    const entry = { id: crypto.createHash("sha256").update(pathKey(target)).digest("hex").slice(0, 16), path: target, mode, label: String(input.label || path.basename(target)).slice(0, 80) };
    return mutate(data => { if ((data.roots || []).some(r => overlapsPath(r.path, target))) throw storageError("目录已被另一个管理器登记。"); data.roots.push(entry); if (input.makeDefault && mode === "library") data.defaultRootId = entry.id; return entry; });
  }
  function setDefault(id) {
    const root = roots().find(r => r.id === id && r.mode === "library");
    if (!root) throw storageError("下载目标必须是模型库文件夹。", 400);
    resolvePath(root.path);
    return mutate(data => { data.defaultRootId = id; return { ok: true }; });
  }
  function unregisterRoot(id) {
    const r = roots().find(x => x.id === id);
    if (!r || id === "legacy") throw storageError("原模型库不能取消登记。", 400);
    assertUnlocked([r.path]);
    return mutate(data => {
      if ((data.aliases || []).some(a => overlapsPath(a.to, r.path) || overlapsPath(a.from, r.path))) throw storageError("该库包含迁移映射，请先回滚迁移后再取消登记。");
      data.roots = data.roots.filter(x => x.id !== id); if (data.defaultRootId === id) data.defaultRootId = "legacy"; return { ok: true, filesPreserved: true };
    });
  }
  function downloadTarget(storageId, outputName) {
    const r = roots().find(x => x.id === (storageId || read().defaultRootId || "legacy") && x.mode === "library");
    if (!r) throw storageError("下载目录未登记，请先添加模型库。", 400);
    if (!outputName || outputName === "." || outputName === ".." || /[\\/:\0]/.test(outputName)) throw storageError("无效的模型文件夹名。", 400);
    const original = path.join(r.path, outputName), result = resolvePath(original, { follow: false, allowRoot: false });
    if (pathKey(followAliases(result)) !== pathKey(result)) throw storageError("此模型已迁移，请选择迁移后的模型库。");
    return result;
  }
  function prepareDownload(target, metadata) {
    resolvePath(target, { follow: false, allowRoot: false });
    const marker = path.join(target, ".platform-download.json");
    const files = fs.existsSync(target) ? fs.readdirSync(target) : [];
    const previous = readJson(marker, null);
    if (files.length && (!previous || previous.model !== metadata.model || previous.source !== metadata.source || previous.precision !== metadata.precision)) throw storageError("目标目录已有其他文件，已阻止覆盖。请换一个文件夹名，或从原下载任务继续。");
    fs.mkdirSync(target, { recursive: true });
    writeJson(marker, { model: metadata.model, source: metadata.source, precision: metadata.precision, createdAt: previous?.createdAt || new Date().toISOString() });
  }
  async function snapshot() {
    const libraries = await Promise.all(roots().map(async r => {
      try { const st = await fsp.statfs(r.path); return { ...r, online: true, freeBytes: Number(st.bavail) * Number(st.bsize), totalBytes: Number(st.blocks) * Number(st.bsize) }; }
      catch (e) { return { ...r, online: false, error: e.code }; }
    }));
    return { ok: true, roots: libraries, defaultRootId: read().defaultRootId || "legacy", aliases: read().aliases || [], operations: activeOperations() };
  }
  function isRetired(target) { return (read().aliases || []).some(a => containsPath(a.from, target)); }
  function addAlias(from, to, migrationId) { return mutate(data => { if ((data.aliases || []).some(a => a.migrationId === migrationId)) return; if ((data.aliases || []).some(a => overlapsPath(a.from, from) || overlapsPath(a.from, to))) throw storageError("迁移路径与已有映射冲突，请选择新的目标目录。"); data.aliases.push({ from, to, migrationId }); }); }
  function removeAlias(migrationId) { return mutate(data => { data.aliases = data.aliases.filter(a => a.migrationId !== migrationId); }); }
  return { file, operationDir, roots, snapshot, registerRoot, setDefault, unregisterRoot, resolvePath, rootFor, followAliases, fromContainerPath, toContainerPath, dockerMountArgs, downloadTarget, prepareDownload, activeOperations, acquireOperation, releaseOperation, trackChild, assertUnlocked, isRetired, addAlias, removeAlias };
}

module.exports = { createModelStorage, storageError, containsPath, overlapsPath, pathKey, storageReadJson: readJson, storageWriteJson: writeJson };
