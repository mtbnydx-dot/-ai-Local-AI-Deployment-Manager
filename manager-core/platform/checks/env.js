"use strict";

const semver = require("../semver");

const NODE_REQUIREMENT = "^22.22.2 || ^24.15.0 || >=26.0.0";
const PYTHON_REQUIREMENT = ">=3.10";
const NODE_DOCS = "/docs/getting-started.md#prerequisites";
const DEPS_DOCS = "/docs/troubleshooting.md#dependencies";
const MCP_DOCS = "/docs/mcp-platform-guide.md";
const DOWNLOAD_DOCS = "/docs/getting-started.md#download-tool";

// Probes own all filesystem and process access. Checks evaluate their results
// without changing the installation, dependencies or running components.
function check(id, zh, en, run) {
  return { id, group: "env", title: { "zh-CN": zh, "en-US": en }, run };
}

function withFix(result, fix) {
  return { ...result, fix, actions: [fix.id] };
}

function pythonVersion(text) {
  const value = String(text || "").trim();
  if (semver.parseVersion(value)) return value;
  const match = /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(value);
  return match ? match[1] : null;
}

function pythonData(tool, requirement) {
  const version = pythonVersion(tool.version);
  return {
    present: tool.present === true,
    version: tool.version ?? null,
    requirement,
    supported: tool.present === true && semver.satisfies(version, requirement),
  };
}

function createChecks(ctx) {
  const requirements = ctx.registry.requirements || {};
  const nodeRequirement = requirements.node || NODE_REQUIREMENT;
  const pythonRequirement = requirements.python || PYTHON_REQUIREMENT;
  const packages = (ctx.registry.packages || []).filter((pkg) => ctx.isWorktree || pkg.live);
  const checks = [
    check("env.node-version", "Node.js 版本", "Node.js version", async () => {
      const version = await ctx.probe("nodeVersion");
      const data = { version, requirement: nodeRequirement };
      if (semver.satisfies(version, nodeRequirement)) {
        return { status: "ok", detail: `Node.js ${version} satisfies ${nodeRequirement}.`, data };
      }
      return withFix({
        status: "fail", detail: `Node.js ${version || "version unavailable"} does not satisfy ${nodeRequirement}. Install Node.js 24 LTS.`, data,
      }, ctx.fix("env.node-version", "install-node", "manual", "安装 Node.js 24 LTS", "Install Node.js 24 LTS", NODE_DOCS));
    }),
    check("env.node-sqlite", "Node.js SQLite 模块", "Node.js SQLite module", async () => {
      const available = await ctx.probe("sqlite");
      const data = { available: available === true };
      if (available === true) return { status: "ok", detail: "The node:sqlite DatabaseSync API is available.", data };
      return withFix({
        status: "fail", detail: "The node:sqlite DatabaseSync API is unavailable. Install a supported Node.js release.", data,
      }, ctx.fix("env.node-sqlite", "install-node", "manual", "安装支持 SQLite 的 Node.js", "Install Node.js with SQLite support", NODE_DOCS));
    }),
  ];

  for (const pkg of packages) {
    const name = pkg.dir === "." ? "root" : pkg.dir;
    const id = `env.deps.${name}`;
    checks.push(check(id, pkg.dir === "." ? "根目录测试依赖" : `${pkg.dir} 依赖`, `${name} dependencies`, async () => {
      const state = await ctx.probe("dependencyState", pkg);
      const data = {
        package: pkg.dir,
        installed: state.installed === true,
        lockHash: state.lockHash ?? null,
        recordedHash: state.recordedHash ?? null,
        versionsMatch: state.versionsMatch ?? null,
        verification: state.recordedHash ? "deps-state" : "installed-lock",
      };
      let detail;
      if (!data.installed) {
        data.reason = "dependencies-missing";
        detail = `${name} node_modules is missing.`;
      } else if (!data.lockHash) {
        data.reason = "lock-missing";
        detail = `${name} package-lock.json is missing or could not be hashed.`;
      } else if (data.recordedHash) {
        if (data.lockHash === data.recordedHash) {
          return { status: "ok", detail: `${name} dependencies match the recorded package-lock.json hash.`, data };
        }
        data.reason = "lock-mismatch";
        detail = `${name} package-lock.json has changed since dependencies were recorded.`;
      } else if (data.versionsMatch === true) {
        return { status: "ok", detail: `${name} installed package versions match package-lock.json; deps-state.json has no recorded hash.`, data };
      } else {
        data.reason = data.versionsMatch === false ? "installed-lock-mismatch" : "installed-lock-unavailable";
        detail = data.versionsMatch === false
          ? `${name} installed package versions differ from package-lock.json; deps-state.json has no recorded hash.`
          : `${name} dependencies cannot be verified: deps-state.json has no recorded hash and the installed lock is unavailable.`;
      }
      return withFix({ status: "fail", detail, data }, ctx.fix(id, "npm-ci", "confirm", "重新安装依赖", "Reinstall dependencies", DEPS_DOCS, {
        package: pkg.dir, components: pkg.components || [],
      }));
    }));
  }

  checks.push(check("env.mcp-dist", "MCP 构建", "MCP build", async () => {
    const pkg = (ctx.registry.packages || []).find((candidate) => candidate.dir === "platform-mcp");
    if (!pkg) return { status: "skip", detail: "The component registry does not include the platform-mcp package.", data: { package: "platform-mcp" } };
    const state = await ctx.probe("mcpBuild", pkg);
    const data = {
      package: pkg.dir, exists: state.exists === true, currentHash: state.currentHash ?? null,
      stampHash: state.stampHash ?? null, running: state.running === true,
    };
    if (data.exists && data.currentHash && data.currentHash === data.stampHash) {
      return { status: "ok", detail: "The MCP entry point exists and its build stamp matches the current sources.", data };
    }
    const result = {
      status: data.exists ? "warn" : "fail",
      detail: data.exists
        ? "The MCP build is stale or its build stamp is unavailable. Rebuild it before starting MCP."
        : "The MCP entry point dist/src/index.js is missing. Build the MCP package before starting it.",
      data,
    };
    return withFix(result, ctx.fix("env.mcp-dist", "mcp-build", data.running ? "confirm" : "auto", "构建 MCP 服务", "Build MCP server", MCP_DOCS, {
      package: pkg.dir, components: pkg.components || ["platform-mcp"],
    }));
  }));

  checks.push(check("env.download-cli", "模型下载工具", "Model download tool", async () => {
    const cli = await ctx.probe("downloadCli");
    const data = { present: cli.present === true, path: cli.path ?? null };
    if (data.present) return { status: "ok", detail: "The Hugging Face download CLI is available.", data };
    const python = pythonData(await ctx.probe("tool", "python"), pythonRequirement);
    data.python = python;
    return withFix({
      status: "warn",
      detail: python.supported
        ? "The optional Hugging Face download CLI is missing. A supported Python is available for installation."
        : `The optional Hugging Face download CLI is missing. Install Python ${pythonRequirement} before installing the download tool.`,
      data,
    }, ctx.fix("env.download-cli", "install-download-cli", "confirm", "安装模型下载工具", "Install model download tool", DOWNLOAD_DOCS, {
      requires: { python: pythonRequirement },
    }));
  }));

  for (const name of ["python", "pwsh", "git"]) {
    const label = { python: "Python", pwsh: "PowerShell", git: "Git" }[name];
    const id = `env.${name}`;
    checks.push(check(id, `${label} 环境`, `${label} environment`, async () => {
      const tool = await ctx.probe("tool", name);
      const data = name === "python"
        ? pythonData(tool, pythonRequirement)
        : { present: tool.present === true, version: tool.version ?? null };
      let detail = data.present ? `${label} is available${data.version ? ` (${data.version})` : "; version unavailable"}.` : `${label} is not installed or is unavailable on PATH.`;
      if (name === "python" && data.present) {
        detail += data.supported ? ` It satisfies ${pythonRequirement}.` : ` Download-tool installation requires Python ${pythonRequirement}.`;
      }
      const result = { status: "info", detail, data };
      if (data.present && (name !== "python" || data.supported)) return result;
      return withFix(result, ctx.fix(id, `install-${name}`, "manual", `安装 ${label}`, `Install ${label}`, NODE_DOCS));
    }));
  }
  return checks;
}

module.exports = { createChecks };
