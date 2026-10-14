"use strict";

// Read-only external probes, except the narrowly scoped create/delete write
// test and the explicitly requested deep GPU container. Tests inject execFile
// and use temporary roots; Doctor never runs repairs, pulls or installers.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const RUNTIME_MANIFEST_PATH = require.resolve("../runtime-manifest");
const { storageReadJson } = require("../model-storage");
const { createDockerHostConfig } = require("../engines/hosts/docker");
const { createEngineRegistry } = require("../engines/registry");

const WINDOWS_FACTS_SCRIPT = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $errors=@(); function Collect($name,$work) { try { & $work } catch { $script:errors += $name; @() } }; $pwsh=Get-Command pwsh.exe -ErrorAction SilentlyContinue; [pscustomobject]@{ powershell=@{present=$true;version=$PSVersionTable.PSVersion.ToString()}; pwsh=@{present=[bool]$pwsh;path=$(if($pwsh){$pwsh.Source}else{''});version=$(if($pwsh){[Diagnostics.FileVersionInfo]::GetVersionInfo($pwsh.Source).ProductVersion}else{''})}; totalMemoryBytes=(Collect 'memory' { (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory }); processes=@(Collect 'processes' {Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate}); firewall=@(Collect 'firewall' {Get-NetFirewallPortFilter | Select-Object LocalPort,RemotePort,Protocol}); tasks=@(Collect 'tasks' {Get-ScheduledTask | Where-Object {$_.TaskName -like 'LocalAIPlatform*'} | Select-Object TaskName,State,Actions}); runKeys=@(Collect 'runKeys' {Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction Stop | Select-Object * -ExcludeProperty PS*}); errors=$errors } | ConvertTo-Json -Depth 6 -Compress`;

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function readJson(file, fallback = null) { return storageReadJson(file, fallback); }
function fileExists(file) { try { return fs.statSync(file).isFile(); } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
function globPattern(pattern) {
  let expression = "";
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      i += 1;
      if (pattern[i + 1] === "/") { i += 1; expression += "(?:.*/)?"; } else expression += ".*";
    } else if (pattern[i] === "*") expression += "[^/]*";
    else expression += pattern[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`);
}

function hashBuildInputs(directory, patterns) {
  const expressions = (patterns || []).map(globPattern), files = [];
  function visit(relative = "") {
    const full = path.join(directory, relative);
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", ".runtime"].includes(entry.name) || entry.isSymbolicLink()) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(next);
      else if (entry.isFile() && expressions.some((pattern) => pattern.test(next))) files.push(next);
    }
  }
  visit();
  const hash = crypto.createHash("sha256");
  for (const file of files.sort()) hash.update(file).update("\0").update(fs.readFileSync(path.join(directory, file))).update("\0");
  return hash.digest("hex");
}

function lockVersionsMatch(lock, installed) {
  if (!lock || !installed) return null;
  if (lock.packages && installed.packages) {
    return Object.entries(lock.packages).every(([name, entry]) => !name || entry.link || (entry.optional && !installed.packages[name]) || installed.packages[name]?.version === entry.version);
  }
  if (lock.dependencies && installed.dependencies) return Object.entries(lock.dependencies).every(([name, entry]) => (entry.optional && !installed.dependencies[name]) || installed.dependencies[name]?.version === entry.version);
  return null;
}

function decodeWsl(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes.toString(bytes.includes(0) ? "utf16le" : "utf8").replace(/^\uFEFF/, "");
  return String(bytes || "").replace(/^\uFEFF/, "");
}

function parseWsl(text) {
  return decodeWsl(text).split(/\r?\n/).map((line) => {
    const match = /^\s*\*?\s*(\S+)\s+(.+?)\s+(\d+)\s*$/.exec(line);
    return match ? { name: match[1], state: match[2].trim(), version: Number(match[3]) } : null;
  }).filter(Boolean);
}

function parseSizeGb(value) {
  const match = /^([\d.]+)\s*(KB|MB|GB|TB|K|M|G|T|B)?$/i.exec(String(value ?? "").trim());
  if (!match || !Number.isFinite(Number(match[1]))) return null;
  const unit = (match[2] || "B").replace(/B$/i, "").toUpperCase();
  return Number(match[1]) * ({ "": 1 / 1024 ** 3, K: 1 / 1024 ** 2, M: 1 / 1024, G: 1, T: 1024 }[unit]);
}

function parseWslConfig(text) {
  let section = "", memoryGb = null, swapGb = null;
  const invalid = [];
  for (const raw of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, "").trim();
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) { section = heading[1].toLowerCase(); continue; }
    if (section !== "wsl2") continue;
    const assignment = /^(memory|swap)\s*=\s*(.+)$/i.exec(line);
    if (!assignment) continue;
    const parsed = parseSizeGb(assignment[2]);
    if (parsed === null) invalid.push(assignment[1].toLowerCase());
    if (assignment[1].toLowerCase() === "memory") memoryGb = parsed;
    else swapGb = parsed;
  }
  return { memoryGb, swapGb, invalid };
}

function parseGpuCsv(text) {
  return String(text || "").split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const [driverVersion, name, computeCapability, memoryMb] = line.split(",").map((value) => value.trim());
    if (!/^[\d.]+$/.test(driverVersion || "") || !name) throw Object.assign(new Error("GPU query returned invalid data."), { code: "invalid_gpu_data" });
    return { driverVersion, name, computeCapability, memoryMb: Number(memoryMb) || 0 };
  });
}

function createDefaultProbes(ctx = {}, options = {}) {
  const aiRoot = ctx.aiRoot || path.resolve(__dirname, "../.."), env = ctx.env || process.env;
  const platform = ctx.platform || process.platform, execFile = options.execFile || childProcess.execFile;
  const execute = (command, args, extra = {}) => new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, env, timeout: 1200, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", ...extra }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr: String(stderr || "") })) : resolve(stdout));
  });
  let windowsFactsPromise;
  function windowsFacts() {
    if (platform !== "win32") return Promise.resolve({ unsupported: true });
    if (!windowsFactsPromise) windowsFactsPromise = execute(env.POWERSHELL_EXE || "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_FACTS_SCRIPT], { timeout: 4000 }).then((text) => JSON.parse(String(text).replace(/^\uFEFF/, "")));
    return windowsFactsPromise;
  }
  function dockerConfig() { return createDockerHostConfig(env, { values: { wslDistro: ctx.value?.("docker.wslDistro", ""), desktopExe: ctx.value?.("docker.desktopExe", "") }, sources: {} }, { aiRoot }); }
  function docker(args, extra) { const host = dockerConfig(); return execute(host.dockerExe, [...host.dockerArgsPrefix, ...args], extra); }
  async function tool(name) {
    if (name === "pwsh" && platform === "win32") {
      const facts = await (ctx.probe ? ctx.probe("windowsFacts") : windowsFacts());
      const entry = facts.pwsh?.present ? facts.pwsh : facts.powershell;
      return { present: Boolean(entry?.present), version: entry?.version || null };
    }
    const command = name === "python" ? env.PYTHON_EXE || "python" : name;
    try {
      const output = await execute(command, name === "pwsh" ? ["-Version"] : ["--version"]);
      return { present: true, version: String(output).match(/\d+\.\d+(?:\.\d+)?/)?.[0] || null };
    } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return { present: false, version: null }; throw error; }
  }
  return {
    isWorktree: () => fs.existsSync(path.join(aiRoot, ".git")),
    nodeVersion: () => process.version,
    sqlite: () => typeof require("node:sqlite").DatabaseSync === "function",
    windowsFacts, tool,
    dependencyState(pkg) {
      const directory = path.resolve(aiRoot, pkg.dir);
      const lockFile = path.join(directory, "package-lock.json");
      const state = readJson(path.join(aiRoot, ".runtime", "platform", "deps-state.json"), {});
      const saved = state.packages?.[pkg.dir] || state[pkg.dir];
      return { installed: fs.existsSync(path.join(directory, "node_modules")), lockHash: fileExists(lockFile) ? sha256(fs.readFileSync(lockFile)) : null, recordedHash: saved?.lockSha256 || null, versionsMatch: lockVersionsMatch(readJson(lockFile), readJson(path.join(directory, "node_modules", ".package-lock.json"))) };
    },
    async mcpBuild(pkg) {
      if (!pkg) return { exists: false, currentHash: null, stampHash: null, running: false };
      const directory = path.resolve(aiRoot, pkg.dir), stamp = readJson(path.join(directory, pkg.build.stamp));
      const facts = platform === "win32" ? await (ctx.probe ? ctx.probe("windowsFacts") : windowsFacts()) : {};
      const running = (facts.processes || []).some((process) => /node(?:\.exe)?$/i.test(process.ExecutablePath || process.exe || "") && String(process.CommandLine || process.commandLine || "").includes(directory));
      return { exists: fileExists(path.join(directory, "dist", "src", "index.js")), currentHash: hashBuildInputs(directory, pkg.build.inputs), stampHash: stamp?.srcSha256 || null, running };
    },
    downloadCli() { const file = env.HF_CLI || path.join(aiRoot, "venvs", "download-cli", "Scripts", "hf.exe"); return { present: fileExists(file), path: file }; },
    dockerCli: async () => ({ present: true, version: String(await docker(["--version"])).trim() }),
    dockerDaemon: async () => ({ ready: true, version: String(await docker(["info", "--format", "{{.ServerVersion}}"])).trim() }),
    wsl: async () => ({ distributions: parseWsl(await execute(env.WSL_EXE || "wsl.exe", ["-l", "-v"], { encoding: null })) }),
    async wslConfig() {
      const file = path.join(env.USERPROFILE || env.HOME || aiRoot, ".wslconfig");
      let text = null;
      try { text = await fsp.readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const facts = await (ctx.probe ? ctx.probe("windowsFacts") : windowsFacts());
      return { exists: text !== null, ...parseWslConfig(text), totalMemoryGb: Number(facts.totalMemoryBytes) / 1024 ** 3 || null };
    },
    nvidia: async () => ({ gpus: parseGpuCsv(await execute(env.NVIDIA_SMI || "nvidia-smi", ["--query-gpu=driver_version,name,compute_cap,memory.total", "--format=csv,noheader,nounits"])) }),
    async runtimes() {
      // The existing manifest loader owns a process-wide cache and reads its
      // root from env. A short-lived Node process scopes that loader without
      // changing this process's env/cache or duplicating its identity rules.
      const script = `const manifest=require(${JSON.stringify(RUNTIME_MANIFEST_PATH)});process.stdout.write(JSON.stringify({runtimes:manifest.listRuntimes(),errors:manifest.listRuntimeIdentityErrors(),description:manifest.describeRuntimeManifest()}));`;
      const snapshot = JSON.parse(String(await execute(process.execPath, ["-e", script], { cwd: aiRoot, env: { ...env, AI_ROOT: aiRoot }, timeout: 4000 })));
      const source = {
        listRuntimes: () => snapshot.runtimes,
        listRuntimeIdentityErrors: () => snapshot.errors,
        describeRuntimeManifest: () => snapshot.description,
      };
      const registry = createEngineRegistry({ env, overrideDir: path.join(aiRoot, "config", "engines"), manifest: source });
      return source.listRuntimes().filter((runtime) => runtime.status !== "retired" && !runtime.release.retired).map((runtime) => {
        const effective = registry.has(runtime.engineId) ? registry.runtimesFor(runtime.engineId).find((ref) => ref.manifestKey === runtime.manifestKey) : null;
        return effective || { ...runtime, pullPolicy: registry.pullPolicy(runtime.engineId, runtime) };
      });
    },
    async images(runtimes) {
      return Promise.all(runtimes.map(async (runtime) => {
        try { const id = String(await docker(["image", "inspect", "--format", "{{.Id}}", runtime.image])).trim(); return { image: runtime.image, present: true, imageId: id }; }
        catch (error) { const missing = /no such (?:image|object)|image.*not found/i.test(`${error.message} ${error.stderr || ""}`); return { image: runtime.image, present: missing ? false : null, code: missing ? "image_missing" : "docker_unavailable" }; }
      }));
    },
    gpuDocker: async ({ image, argv }) => {
      const allowed = { "--pull": "never", "--gpus": "all", "--entrypoint": "nvidia-smi", "--network": "none" };
      let safe = Array.isArray(argv) && argv[0] === "run" && argv.at(-1) === image && argv.includes("--rm");
      for (let i = 1; safe && i < argv.length - 1; i += 1) {
        if (argv[i] === "--rm") continue;
        if (!Object.hasOwn(allowed, argv[i]) || argv[i + 1] !== allowed[argv[i]]) { safe = false; break; }
        i += 1;
      }
      if (!safe || !image || !/@sha256:[a-f0-9]{64}$/i.test(image) || !["--pull", "--gpus", "--entrypoint"].every((flag) => argv.includes(flag))) throw Object.assign(new Error("GPU probe requires a pinned local image and --pull never."), { code: "unsafe_gpu_probe" });
      const name = `ai-doctor-gpu-${crypto.randomBytes(12).toString("hex")}`;
      const command = [...argv.slice(0, -1), "--name", name, image];
      try {
        const text = await docker(command, { timeout: Number(options.deepTimeoutMs) || 30000 });
        return { ok: true, output: String(text).slice(0, 4096) };
      } catch (error) {
        if (error.killed || ["ETIMEDOUT", "ABORT_ERR"].includes(error.code)) {
          // Killing the Docker client does not ensure that --rm ran. Only the
          // unique container this invocation named may be removed here.
          try { await docker(["rm", "-f", name]); } catch {}
        }
        throw error;
      }
    },
    modelRoots() {
      const key = (value) => { const resolved = path.resolve(value); return platform === "win32" ? resolved.toLowerCase() : resolved; };
      const managers = [
        { id: "legacy-vllm", directory: "vllm-manager", override: env.VLLM_MODELS_ROOT },
        { id: "legacy-llama", directory: "llama-manager", override: env.LLAMA_MODELS_ROOT },
      ];
      const legacy = managers.map((manager) => ({ id: manager.id, path: manager.override ? path.resolve(aiRoot, manager.directory, manager.override) : path.join(aiRoot, "models") }));
      if (key(legacy[0].path) === key(legacy[1].path)) legacy[0].id = "legacy";
      const files = [...new Set(managers.map((manager) => env.MODEL_STORAGE_FILE ? path.resolve(aiRoot, manager.directory, env.MODEL_STORAGE_FILE) : path.join(aiRoot, "service-entry", "data", "model-storage.json")))];
      const registered = files.flatMap((file) => readJson(file, { roots: [] }).roots || []);
      return [...legacy, ...registered].filter((root, index, roots) => root.path && roots.findIndex((entry) => entry.path && key(entry.path) === key(root.path)) === index);
    },
    dockerData: () => platform === "win32" && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Docker", "wsl") : null,
    async diskSpace(directory) {
      let ancestor = directory;
      while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
      const stat = await fsp.statfs(ancestor, { bigint: true });
      return { path: directory, measuredPath: ancestor, exists: fs.existsSync(directory), freeGb: Number(stat.bavail * stat.bsize) / 1024 ** 3, totalGb: Number(stat.blocks * stat.bsize) / 1024 ** 3 };
    },
    async writable(directories) {
      return Promise.all(directories.map(async (directory) => {
        const file = path.join(directory, `.doctor-write-${crypto.randomUUID()}.tmp`);
        let created = false, handle;
        try { handle = await fsp.open(file, "wx"); created = true; await handle.writeFile("doctor write probe\n"); return { path: directory, writable: true }; }
        catch (error) { return { path: directory, writable: false, code: error.code || "write_failed" }; }
        finally { try { if (handle) await handle.close(); } finally { if (created) await fsp.unlink(file); } }
      }));
    },
  };
}

module.exports = { createDefaultProbes, hashBuildInputs, lockVersionsMatch, parseWsl, decodeWsl, parseWslConfig, parseGpuCsv, WINDOWS_FACTS_SCRIPT };
