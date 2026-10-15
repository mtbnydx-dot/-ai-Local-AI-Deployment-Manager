"use strict";

// Generates manager-core/data/knowledge/families.json (families v2, with
// capabilityIdAliases) from manager-core/data/model-capabilities.json
// (docs/overhaul/02-models.md section 8.5, MOD-6).
//
//   node scripts/migrate-capabilities-v1.js            write families.json
//   node scripts/migrate-capabilities-v1.js --check    exit 2 when families.json is out of date
//   node scripts/migrate-capabilities-v1.js --dry-run  print the summary, write nothing
//   --input <file>   v1 file (default manager-core/data/model-capabilities.json)
//   --output <file>  families file (default manager-core/data/knowledge/families.json)
//
// The conversion itself is manager-core/model-inspector/migrate-v1.js, the
// module the knowledge loader also runs on a user's own v1 file. This script
// only adds what the bundled data needs on top: the tensor class table and
// header of the existing families file are kept, and the documented
// adjustments below are applied. It reads and writes the two files named
// above and nothing else.

const fs = require("node:fs");
const path = require("node:path");
const { convertCapabilitiesV1 } = require("../manager-core/model-inspector/migrate-v1");

const DATA_DIR = path.join(__dirname, "..", "manager-core", "data");
const DEFAULT_INPUT = path.join(DATA_DIR, "model-capabilities.json");
const DEFAULT_OUTPUT = path.join(DATA_DIR, "knowledge", "families.json");

// Qwen3.8 rekey (02 section 2 and 8.2): real checkpoints declare model_type
// qwen3_5 and are told apart from Qwen3.5/3.6 by their chat template, so the
// family also claims the qwen3_5 types, but only when the template signature
// says so. The fictional qwen3_8 types keep matching on identity alone
// (forModelTypes limits the template proof to the shared qwen3_5 types).
//
// Flash-Next outranks it: a Flash-Next repository name also contains "Qwen3.8",
// and v1 resolved that by file order, which v2 replaces by priority.
//
// DiffusionGemma on Windows Docker/WSL (02 section 8.2, MOD-11): the policy
// block that vllm-manager's diffusionGemmaWindowsBlockReason used to hold in
// code is data on the Gemma family. It applies to the DiffusionGemma identities
// only, on the WSL host platform, unless VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA is set.
const ADJUSTMENTS = Object.freeze({
  gemma4: (entry) => {
    entry.blocks = [{
      engines: ["vllm"],
      when: { hostPlatform: "wsl", modelTypes: ["diffusiongemma", "diffusion_gemma"], architecturePatterns: ["^diffusiongemma"] },
      unlessEnv: "VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA",
      code: "diffusion_gemma_windows",
      reason: {
        zh: "DiffusionGemma NVFP4 在 Windows Docker/WSL 下当前不可稳定运行：V2 runner 会因 UVA 不可用启动失败，V1 fallback 可加载但首个 chat 请求可能触发 CUDA device-side assert。请改用常规 Gemma-4/Qwen，或在原生 Linux 上运行；确认要自行承担风险时设置 VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA=1。",
        en: "DiffusionGemma NVFP4 does not run reliably on Windows Docker/WSL: the V2 runner fails to start without UVA, and the V1 fallback loads but the first chat request may hit a CUDA device-side assert. Use regular Gemma-4/Qwen, run on native Linux, or set VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA=1 to accept the risk.",
      },
    }];
  },
  "qwen3.8-flash-next": (entry) => {
    entry.priority = 30;
  },
  "qwen3.8": (entry) => {
    entry.priority = 20;
    entry.match.modelTypes = [...new Set([...(entry.match.modelTypes || []), "qwen3_5", "qwen3_5_moe"])];
    entry.match.require = [{ templateSignature: ["qwen38-xml-effort"], forModelTypes: ["qwen3_5", "qwen3_5_moe"] }];
    entry.fixtures = ["qwen38-27b-fp8", "qwen38-27b-fp8-indexed"];
  },
});

const USAGE = "Usage: node scripts/migrate-capabilities-v1.js [--check] [--dry-run] [--input <file>] [--output <file>]";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonIfPresent(file) {
  try {
    return readJson(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function orderedEntry(entry) {
  const order = ["id", "label", "priority", "confidence", "match", "contextMax", "speculative", "engines", "blocks", "download", "requires", "notes", "fixtures"];
  const result = {};
  for (const key of order) if (entry[key] !== undefined) result[key] = entry[key];
  return result;
}

/** generateFamilies({v1, existing, runtimeIdForKey}) -> {families, warnings}. Pure. */
function generateFamilies({ v1, existing = null, runtimeIdForKey } = {}) {
  const converted = convertCapabilitiesV1(v1, { runtimeIdForKey });
  const entries = converted.families.entries.map((entry) => {
    ADJUSTMENTS[entry.id]?.(entry);
    return orderedEntry(entry);
  });
  const families = {
    schemaVersion: 2,
    kind: "families",
    asOf: existing?.asOf || converted.families.asOf,
    staleAfterDays: existing?.staleAfterDays || converted.families.staleAfterDays || 120,
  };
  if (Array.isArray(existing?.tensorClasses)) families.tensorClasses = existing.tensorClasses;
  families.capabilityIdAliases = converted.capabilityIdAliases;
  families.entries = entries;
  return { families, warnings: converted.warnings };
}

function parseArgs(argv) {
  const options = { check: false, dryRun: false, input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--input" || arg === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = path.resolve(value);
      index += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function run(argv, io = { log: console.log, error: console.error }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.error(`${error.message}\n${USAGE}`);
    return 1;
  }
  if (options.help) {
    io.log(USAGE);
    return 0;
  }
  try {
    const { families, warnings } = generateFamilies({ v1: readJson(options.input), existing: readJsonIfPresent(options.output) });
    const text = `${JSON.stringify(families, null, 2)}\n`;
    for (const warning of warnings) io.log(`warning: ${warning.message}`);
    io.log(`${families.entries.length} families, ${Object.keys(families.capabilityIdAliases).length} aliases`);
    if (options.check) {
      const current = fs.existsSync(options.output) ? fs.readFileSync(options.output, "utf8") : "";
      if (current !== text) {
        io.error("families.json is out of date; run node scripts/migrate-capabilities-v1.js");
        return 2;
      }
      io.log("families.json is up to date");
      return 0;
    }
    if (options.dryRun) return 0;
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, text);
    io.log("families.json written");
    return 0;
  } catch (error) {
    io.error(`migration failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { ADJUSTMENTS, DEFAULT_INPUT, DEFAULT_OUTPUT, generateFamilies, run };
