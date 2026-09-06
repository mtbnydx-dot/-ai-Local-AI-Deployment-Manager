"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { createModelStorage, storageError, containsPath, overlapsPath, pathKey, storageReadJson, storageWriteJson } = require("./model-storage");

async function inventory(root) {
  const files = [], dirs = [];
  async function walk(dir) {
    for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
      if (files.length + dirs.length > 200000) throw storageError("目录条目过多，请选择单个模型目录。", 400);
      const target = path.join(dir, item.name), stat = await fsp.lstat(target);
      if (stat.isSymbolicLink()) throw storageError(`目录含链接，无法安全迁移：${target}。请先将 HF 缓存快照导出为普通模型文件夹。`, 400);
      const relative = path.relative(root, target);
      if (stat.isDirectory()) { dirs.push(relative); await walk(target); }
      else if (stat.isFile()) files.push({ path: relative, size: stat.size, mtimeMs: stat.mtimeMs });
      else throw storageError(`不支持迁移的特殊文件：${target}`, 400);
    }
  }
  if ((await fsp.lstat(root)).isSymbolicLink()) throw storageError("请选择实际模型目录，不要选择目录链接。", 400);
  await walk(root);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), dirs: dirs.sort(), bytes: files.reduce((a, b) => a + b.size, 0) };
}
function fingerprint(list) { return crypto.createHash("sha256").update(JSON.stringify(list)).digest("hex"); }
async function hashFile(file, onChunk = () => {}) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) { onChunk(chunk.length); hash.update(chunk); }
  return hash.digest("hex");
}

function createModelMigration(options = {}) {
  const storage = options.storage || createModelStorage(options);
  const jobDir = path.join(path.dirname(storage.file), "model-migrations");
  const workers = new Map();
  const save = job => storageWriteJson(path.join(jobDir, `${job.id}.json`), job);
  function load(id) {
    if (!/^[\da-f-]{36}$/.test(String(id))) throw storageError("无效的迁移任务。", 400);
    const job = storageReadJson(path.join(jobDir, `${id}.json`), null);
    if (!job) throw storageError("迁移任务不存在。", 404);
    return job;
  }
  function publicJob(job) {
    const { id, source, target, targetDirectory, needsRegistration, needsCreation, state, phase, error, fileCount, totalBytes, bytesDone, completedFiles, currentFile, createdAt, updatedAt, sourceRemoved } = job;
    const active = storage.activeOperations().some(o => o.id === id);
    return { id, source, target, targetDirectory, needsRegistration, needsCreation, state: !active && state === "cleaning" ? "cleanup_failed" : ["copying", "verifying", "publishing"].includes(state) && !active ? "interrupted" : state, phase, error, fileCount, totalBytes, bytesDone, completedFiles, currentFile, createdAt, updatedAt, sourceRemoved: Boolean(sourceRemoved) };
  }
  function list() {
    if (!fs.existsSync(jobDir)) return [];
    return fs.readdirSync(jobDir).filter(n => /^[\da-f-]{36}\.json$/.test(n)).map(n => publicJob(storageReadJson(path.join(jobDir, n), {}))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  async function assertIdle(targets) {
    const busy = await (options.getBusyPaths?.() || []);
    const conflict = busy.find(item => targets.some(target => overlapsPath(item.path, target)));
    if (conflict) throw storageError(`请先结束相关下载或卸载挂载此目录的模型容器：${conflict.label || conflict.path}`);
  }
  function validateJobPaths(job, allowUnregistered = false) {
    const source = storage.resolvePath(job.source, { follow: false, allowRoot: false });
    const destination = allowUnregistered && job.targetDirectory ? storage.migrationDestination(job.targetDirectory, path.basename(job.target)) : null;
    if (destination && pathKey(destination.target) !== pathKey(job.target)) throw storageError("目标路径发生变化，请重新预览迁移。");
    const target = allowUnregistered && destination ? destination.target : storage.resolvePath(job.target, { follow: false, allowRoot: false });
    const expectedStage = path.join(path.dirname(target), `.model-migration-${job.id}`);
    if (pathKey(job.stage) !== pathKey(expectedStage) || overlapsPath(source, target) || overlapsPath(source, expectedStage)) throw storageError("迁移记录中的目录关系不安全，已停止操作。");
    return { source, target, stage: expectedStage, destination };
  }
  async function plan(input = {}) {
    const source = storage.resolvePath(String(input.source || ""), { follow: false, allowRoot: false });
    if (storage.isRetired(source)) throw storageError("这个模型已切换到迁移后的路径，请使用当前路径。");
    const sourceRoot = storage.rootFor(source);
    if (sourceRoot.mode === "library" && pathKey(path.dirname(source)) !== pathKey(sourceRoot.path)) throw storageError("请迁移整个模型目录，不能单独迁移权重分片。", 400);
    const name = String(input.outputName || path.basename(source)).trim();
    const destination = input.targetDirectory ? storage.migrationDestination(input.targetDirectory, name) : null;
    const target = destination ? destination.target : storage.downloadTarget(input.storageId, name);
    if (overlapsPath(source, target)) throw storageError("源和目标必须是两个互不包含的目录。", 400);
    if (fs.existsSync(target)) throw storageError("目标目录已经存在；迁移不会覆盖或合并现有目录。");
    storage.assertUnlocked([source, target]);
    await assertIdle([source, target]);
    const contents = await inventory(source);
    if (!contents.files.some(f => /\.(gguf|safetensors|bin|pt|pth)$/i.test(f.path))) throw storageError("源目录未发现模型权重，不能作为模型迁移。", 400);
    const disk = await fsp.statfs(destination?.existingAncestor || path.dirname(target));
    const freeBytes = Number(disk.bavail) * Number(disk.bsize), reserve = options.reserveBytes ?? 10 * 1024 ** 3;
    if (freeBytes < contents.bytes + reserve) throw storageError("目标磁盘空间不足，迁移需要完整副本和预留空间。", 400);
    const id = crypto.randomUUID();
    const job = { id, source, target, ...(destination ? { targetDirectory: destination.directory, needsRegistration: destination.needsRegistration, needsCreation: destination.needsCreation } : {}), stage: path.join(path.dirname(target), `.model-migration-${id}`), state: "planned", phase: "等待执行", ...contents, fingerprint: fingerprint(contents), fileCount: contents.files.length, totalBytes: contents.bytes, bytesDone: 0, completedFiles: 0, createdAt: new Date().toISOString(), freeBytes };
    save(job);
    return { ...publicJob(job), freeBytes, files: contents.files.slice(0, 100), truncated: contents.files.length > 100, sourceWillBePreserved: true };
  }
  async function start(id) {
    const job = load(id);
    if (!["planned", "failed", "cancelled", "interrupted"].includes(publicJob(job).state)) throw storageError("此迁移当前不能开始或继续。");
    validateJobPaths(job, true);
    await assertIdle([job.source, job.target]);
    if (storage.activeOperations().some(o => o.kind === "migration")) throw storageError("已有迁移正在运行，请等待完成。");
    storage.acquireOperation([job.source, job.target], "migration", id);
    const state = { cancelled: false };
    workers.set(id, state);
    job.state = "copying"; job.error = ""; job.updatedAt = new Date().toISOString(); save(job);
    void run(job, state).catch(() => {}).finally(() => { workers.delete(id); storage.releaseOperation(id); });
    return publicJob(job);
  }
  async function run(job, control) {
    let lastSaved = 0;
    const update = (force = false) => { if (force || Date.now() - lastSaved > 1000) { job.updatedAt = new Date().toISOString(); save(job); lastSaved = Date.now(); } };
    const checkCancel = () => { if (control.cancelled) throw Object.assign(new Error("迁移已暂停，源文件完整保留，可继续迁移。"), { cancelled: true }); };
    try {
      const { source, target, stage, destination: plannedDestination } = validateJobPaths(job, true);
      if (fingerprint(await inventory(source)) !== job.fingerprint) throw storageError("源目录内容发生变化，请重新预览迁移。原文件未改动。");
      const recovering = fs.existsSync(target);
      const markerName = `.platform-migration-${job.id}.json`;
      if (recovering && storageReadJson(path.join(target, markerName), null)?.id !== job.id) throw storageError("目标目录被其他文件占用，已停止迁移。");
      checkCancel();
      if (plannedDestination?.needsRegistration) storage.registerRoot({ path: plannedDestination.directory, create: true });
      validateJobPaths(job);
      const destination = recovering ? target : stage;
      if (fs.existsSync(destination) && (await fsp.lstat(destination)).isSymbolicLink()) throw storageError("迁移暂存目录变成了链接，已停止。");
      await fsp.mkdir(destination, { recursive: true });
      const stagedContents = await inventory(destination); // Reject nested junctions before resuming.
      const disk = await fsp.statfs(destination);
      const stagedSizes = new Map(stagedContents.files.map(f => [f.path, f.size]));
      const reusableBytes = job.files.reduce((sum, f) => sum + (stagedSizes.get(f.path) === f.size ? f.size : 0), 0);
      const partialBytes = job.files.reduce((sum, f) => sum + (stagedSizes.get(`${f.path}.${job.id}.partial`) || 0), 0);
      if (Number(disk.bavail) * Number(disk.bsize) + partialBytes < job.totalBytes - reusableBytes + (options.reserveBytes ?? 10 * 1024 ** 3)) throw storageError("目标磁盘剩余空间不足，源文件完整保留。");
      for (const d of job.dirs) await fsp.mkdir(path.join(destination, d), { recursive: true });
      job.bytesDone = 0; job.completedFiles = 0;
      for (const entry of job.files) {
        checkCancel();
        const completedBytes = job.bytesDone;
        const from = path.resolve(source, entry.path), to = path.resolve(destination, entry.path);
        if (!containsPath(source, from) || !containsPath(destination, to)) throw storageError("迁移文件清单超出模型目录。");
        job.currentFile = entry.path; job.phase = "复制并计算 SHA256"; update(true);
        const sourceHash = crypto.createHash("sha256");
        const partial = `${to}.${job.id}.partial`;
        let digest;
        if (fs.existsSync(to)) {
          if ((await fsp.lstat(to)).isSymbolicLink()) throw storageError("目标文件变成链接，已停止。");
          digest = await hashFile(from, checkCancel);
          if (await hashFile(to, checkCancel) !== digest) throw storageError(`目标已有副本校验失败：${entry.path}。已保留两侧文件。`);
        } else {
          if (fs.existsSync(partial) && (await fsp.lstat(partial)).isSymbolicLink()) throw storageError("暂存文件变成链接，已停止。");
          await pipeline(fs.createReadStream(from, { highWaterMark: 4 * 1024 * 1024 }), new Transform({ transform(chunk, _encoding, callback) { try { checkCancel(); sourceHash.update(chunk); job.bytesDone += chunk.length; update(); callback(null, chunk); } catch (error) { callback(error); } } }), fs.createWriteStream(partial));
          digest = sourceHash.digest("hex"); job.phase = "校验目标副本"; update(true);
          if (await hashFile(partial, checkCancel) !== digest) throw storageError(`目标副本校验失败：${entry.path}`);
          await fsp.rename(partial, to);
        }
        entry.sha256 = digest; job.bytesDone = completedBytes + entry.size; job.completedFiles++; update(true);
      }
      // Re-check all source metadata immediately before publication. Hashes are
      // saved separately and deliberately excluded from the original inventory.
      if (fingerprint(await inventory(source)) !== job.fingerprint) throw storageError("复制期间源目录发生变化，未切换路径。");
      await assertIdle([source, target]); checkCancel();
      job.state = "publishing"; job.phase = "切换模型路径"; update(true);
      if (!recovering) { storageWriteJson(path.join(stage, markerName), { id: job.id }); await fsp.rename(stage, target); }
      storage.addAlias(source, target, job.id);
      job.state = "completed"; job.phase = "迁移完成，源文件保留，可回滚"; job.currentFile = ""; update(true);
    } catch (error) { job.state = error.cancelled ? "cancelled" : "failed"; job.error = error.message; update(true); }
  }
  function cancel(id) {
    if (load(id).state === "cleaning") throw storageError("源文件清理已确认并开始，请等待完成后查看结果。");
    const control = workers.get(id);
    if (!control) throw storageError("任务不在此管理器运行，请回到发起迁移的管理器操作。");
    control.cancelled = true; return { ok: true, id };
  }
  async function rollback(id) {
    const job = load(id);
    if (!["completed", "cleanup_failed"].includes(publicJob(job).state) || job.sourceRemoved) throw storageError("源文件已清理或迁移未完成，无法直接回滚。");
    if (storage.isRetired(job.target)) throw storageError("目标模型已再次迁移，请先回滚最新一轮迁移。");
    validateJobPaths(job); await assertIdle([job.source, job.target]);
    storage.acquireOperation([job.source, job.target], "migration", id);
    try {
      if (fingerprint(await inventory(job.source)) !== job.fingerprint) throw storageError("源文件已经变化，请人工检查后再回滚。");
      for (const f of job.files) if (await hashFile(path.join(job.source, f.path)) !== f.sha256) throw storageError("源文件校验失败，未切换路径。");
      storage.removeAlias(id); job.state = "rolled_back"; job.phase = "已恢复原路径，目标副本保留"; save(job); return publicJob(job);
    } finally { storage.releaseOperation(id); }
  }
  async function cleanupSource(id, confirmSource) {
    const job = load(id);
    if (!["completed", "cleanup_failed"].includes(publicJob(job).state) || job.sourceRemoved || confirmSource !== job.source) throw storageError("请核对并明确确认要清理的源目录。", 400);
    const verifiedTarget = storage.resolvePath(job.target);
    validateJobPaths(job); await assertIdle([job.source, job.target, verifiedTarget]);
    storage.acquireOperation([job.source, job.target, verifiedTarget], "migration", id);
    const control = { cancelled: false }; workers.set(id, control);
    job.state = "cleaning"; job.error = ""; job.phase = "重新校验两侧文件"; save(job);
    void (async () => {
      try {
        const remaining = fs.existsSync(job.source) ? await inventory(job.source) : { files: [], dirs: [] };
        if (remaining.files.some(f => !job.files.some(old => old.path === f.path && old.size === f.size && old.mtimeMs === f.mtimeMs)) || remaining.dirs.some(d => !job.dirs.includes(d))) throw storageError("源目录新增或修改了文件，已阻止清理。");
        await inventory(verifiedTarget); // Verify the current destination even after another migration.
        for (const f of job.files) {
          if ((fs.existsSync(path.join(job.source, f.path)) && await hashFile(path.join(job.source, f.path)) !== f.sha256) || await hashFile(path.join(verifiedTarget, f.path)) !== f.sha256) throw storageError(`文件校验不一致，已阻止清理：${f.path}`);
        }
        job.phase = "清理已校验的源文件"; save(job);
        for (const f of job.files) {
          const full = storage.resolvePath(path.resolve(job.source, f.path), { follow: false, allowRoot: false });
          if (!containsPath(job.source, full)) throw storageError("源文件超出确认范围。");
          if (!fs.existsSync(full)) continue;
          const stat = await fsp.lstat(full);
          if (stat.isSymbolicLink() || stat.size !== f.size || stat.mtimeMs !== f.mtimeMs) throw storageError("清理时检测到源文件变化，剩余文件已保留。");
          await fsp.unlink(full);
        }
        for (const d of [...job.dirs].sort((a, b) => b.length - a.length)) if (fs.existsSync(path.join(job.source, d))) await fsp.rmdir(path.join(job.source, d));
        if (fs.existsSync(job.source)) await fsp.rmdir(job.source);
        job.sourceRemoved = true; job.state = "completed"; job.phase = "迁移完成，原盘空间已释放"; save(job);
      } catch (error) { job.state = "cleanup_failed"; job.error = error.message; save(job); }
    })().finally(() => { workers.delete(id); storage.releaseOperation(id); });
    return publicJob(job);
  }
  return { plan, start, cancel, rollback, cleanupSource, list, get: id => publicJob(load(id)), jobDir };
}

module.exports = { createModelMigration, inventoryModelDirectory: inventory };
