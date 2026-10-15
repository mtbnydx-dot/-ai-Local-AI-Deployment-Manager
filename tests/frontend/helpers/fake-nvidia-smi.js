// Node preload (NODE_OPTIONS=--require) for the managers console-harness.js starts.
// "nvidia-smi --query-gpu=..." answers one fixed, nearly idle GPU, so the pages (memory
// estimate, GPU cards) do not depend on what the host GPU is running at that moment
// (the live platform may be holding most of its VRAM, or the host may have no GPU at
// all). Every other command goes to the real child_process.execFile untouched.
const childProcess = require("node:child_process");
const { promisify } = require("node:util");

const realExecFile = childProcess.execFile;
const FULL_ROW = "0, Smoke GPU, 12.0, 97887, 1024, 10, 40, 100.00, 600.00, 30";
const NO_COMPUTE_CAP_ROW = "0, Smoke GPU, 97887, 1024, 10, 40";

function fakeGpuQuery(file, args) {
  if (!/(^|[\/])nvidia-smi(\.exe)?$/i.test(String(file))) return null;
  const query = (Array.isArray(args) ? args : []).find((arg) => String(arg).startsWith("--query-gpu="));
  if (!query) return null;
  return `${String(query).includes("compute_cap") ? FULL_ROW : NO_COMPUTE_CAP_ROW}\n`;
}

function execFile(file, ...rest) {
  const callback = typeof rest.at(-1) === "function" ? rest.pop() : null;
  const stdout = fakeGpuQuery(file, rest[0]);
  if (stdout === null) return realExecFile(file, ...rest, ...(callback ? [callback] : []));
  if (callback) setImmediate(() => callback(null, stdout, ""));
  // The callers only use the callback; a stub child keeps the return value truthy.
  return { pid: 0, kill: () => false, on() { return this; }, once() { return this; } };
}

// util.promisify(execFile) must keep resolving to { stdout, stderr }.
execFile[promisify.custom] = (file, ...rest) => new Promise((resolve, reject) => {
  execFile(file, ...rest, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
});

childProcess.execFile = execFile;
