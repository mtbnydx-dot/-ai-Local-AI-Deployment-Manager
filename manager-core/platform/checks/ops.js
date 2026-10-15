"use strict";

// Ops checks (06 §7.2): supervisor, autostart, nightly, backup, deploy drift,
// version, updates, config and log size. All facts come through probes. Nothing
// here registers a task or writes a file.
const HOUR_STALE = 36;
const LOGS_WARN_BYTES = 2 * 1024 ** 3;
const NIGHTLY_FAIL_STREAK = 3;
const AUTOSTART_NAME = "LocalAIPlatform";

function title(zh, en) { return { "zh-CN": zh, "en-US": en }; }
function lower(value) { return String(value || "").replace(/\\/g, "/").toLowerCase(); }

function createChecks(ctx) {
  const descriptor = (id, zh, en, run) => ({ id, group: "ops", title: title(zh, en), run });
  const manual = (id, zh, en, extra = {}) => ctx.fix(id, `${id.replace(/^ops\./, "")}-docs`, "manual", zh, en, "/docs/troubleshooting.md#ops", extra);
  const root = lower(ctx.aiRoot);
  const windowsOnly = () => (ctx.platform === "win32" ? null : { status: "skip", detail: "This check reads Windows facts only.", data: { reason: "unsupported_platform" } });

  return [
    descriptor("ops.supervisor", "平台监督进程", "Platform supervisor", async () => {
      const state = await ctx.probe("supervisor");
      return state.running
        ? { status: "ok", detail: "The supervisor answers on its control pipe.", data: state }
        : { status: "info", detail: "The supervisor is not running; start it with `platform start`.", data: state, fix: manual("ops.supervisor", "运行 platform start 启动", "Run `platform start`", { command: "platform start" }) };
    }),
    descriptor("ops.autostart", "开机自启动", "Autostart", async () => {
      const skipped = windowsOnly();
      if (skipped) return skipped;
      const [tasks, runKeys] = await Promise.all([ctx.probe("tasks"), ctx.probe("runKeys")]);
      const task = tasks.find((item) => item.name === AUTOSTART_NAME) || null;
      const runValue = runKeys && Object.hasOwn(runKeys, AUTOSTART_NAME) ? String(runKeys[AUTOSTART_NAME]) : null;
      const command = task ? task.actions.map((action) => `${action.execute} ${action.arguments}`).join(" ") : runValue;
      const method = task ? "task" : runValue ? "run-key" : null;
      const enable = manual("ops.autostart", "运行 platform autostart enable 注册（不会自动注册）", "Run `platform autostart enable` (never registered automatically)", { command: "platform autostart enable" });
      if (!method) return { status: "info", detail: "Autostart is not registered.", data: { method: null, registered: false }, fix: enable };
      const matches = Boolean(root) && lower(command).includes(root);
      return matches
        ? { status: "ok", detail: `Autostart is registered (${method}) for this platform folder.`, data: { method, registered: true, pathMatches: true, state: task?.state || null } }
        : { status: "warn", detail: `Autostart is registered (${method}) for a different platform folder.`, data: { method, registered: true, pathMatches: false, state: task?.state || null }, fix: enable };
    }),
    descriptor("ops.nightly", "夜间自检", "Nightly check", async () => {
      const [nightly, tasks] = await Promise.all([ctx.probe("nightly"), ctx.platform === "win32" ? ctx.probe("tasks").catch(() => []) : []]);
      const task = (tasks || []).find((item) => item.name === "LocalAIPlatformNightlyE2E") || null;
      if (!nightly.available) return { status: "info", detail: "There is no nightly report yet.", data: { available: false, task }, fix: manual("ops.nightly", "按文档注册夜间自检", "Register the nightly check as documented") };
      const { available, trend, ...summary } = nightly;
      const data = { ...summary, trendDays: trend.length, task };
      const docs = manual("ops.nightly", "查看夜间自检报告", "Review the nightly report");
      if (nightly.streak >= NIGHTLY_FAIL_STREAK) return { status: "fail", detail: `The nightly check has failed ${nightly.streak} nights in a row (since ${nightly.since}).`, data, fix: docs };
      if (!nightly.ok) return { status: "warn", detail: `The latest nightly check failed (${nightly.failed} failing step(s)).`, data, fix: docs };
      if (nightly.ageHours !== null && nightly.ageHours > HOUR_STALE) return { status: "warn", detail: `The latest nightly report is ${nightly.ageHours} hours old.`, data, fix: docs };
      return { status: "ok", detail: `The latest nightly check passed (${nightly.passed} steps).`, data };
    }),
    descriptor("ops.backup", "备份", "Backup", async () => {
      const [backup, tasks] = await Promise.all([ctx.probe("backup"), ctx.platform === "win32" ? ctx.probe("tasks").catch(() => []) : []]);
      const task = (tasks || []).find((item) => item.name === "LocalAIPlatformBackup") || null;
      if (!backup.available) return { status: "info", detail: "No backup has been written yet.", data: { available: false, task }, fix: manual("ops.backup", "按文档注册备份任务", "Register the backup task as documented") };
      const data = { stamp: backup.stamp, at: backup.at, ageHours: backup.ageHours, format: backup.format, files: backup.files, warnings: backup.warnings, task };
      const docs = manual("ops.backup", "查看备份说明", "Review the backup guide");
      if (!backup.formatOk) return { status: "warn", detail: "The newest backup has an unexpected manifest format.", data, fix: docs };
      if (backup.ageHours !== null && backup.ageHours > HOUR_STALE) return { status: "warn", detail: `The newest backup is ${backup.ageHours} hours old.`, data, fix: docs };
      return { status: "ok", detail: "The newest backup is recent and has the expected format.", data };
    }),
    descriptor("ops.deploy-drift", "部署漂移", "Deploy drift", async () => {
      if (ctx.isWorktree) return { status: "skip", detail: "Drift is only checked in the live root.", data: { reason: "worktree" } };
      const drift = await ctx.probe("drift");
      if (!drift.length) return { status: "ok", detail: "Every deployed file matches its recorded hash.", data: { count: 0, files: [] } };
      return { status: "warn", detail: `${drift.length} deployed file(s) were edited in the live root and will be overwritten by the next deploy.`, data: { count: drift.length, files: drift.slice(0, 50).map((item) => ({ path: item.path, error: item.error || null })) }, fix: manual("ops.deploy-drift", "把直接修改移植回源分支", "Port the live edits back to the source branch") };
    }),
    descriptor("ops.version", "版本记录", "Version record", async () => {
      const version = await ctx.probe("version");
      const data = { source: version.source, version: version.version || null, commit: version.shortCommit || null, branch: version.branch || null, deployedAt: version.deployedAt || null };
      return version.source === "version.json"
        ? { status: "ok", detail: `Version ${data.version || data.commit || "unknown"} is recorded in version.json.`, data }
        : { status: "info", detail: "version.json is missing; the version is derived from git or the package.", data };
    }),
    descriptor("ops.updates", "可用更新", "Available updates", async () => {
      const updates = await ctx.probe("newerCommits");
      const data = { available: updates.available === true, behind: updates.behind ?? null, ref: updates.ref || null, fetched: updates.fetched === true, error: updates.error || null };
      if (updates.error || updates.behind === null || updates.behind === undefined) return { status: "info", detail: "The number of newer commits could not be determined.", data };
      return updates.available
        ? { status: "info", detail: `${updates.behind} newer commit(s) are available.`, data, fix: manual("ops.updates", "运行 platform update", "Run `platform update`", { command: "platform update" }) }
        : { status: "ok", detail: "The deployed commit is current.", data };
    }),
    descriptor("ops.config", "平台配置", "Platform configuration", async () => {
      const errors = (ctx.config.errors || []).map((error) => ({ field: error.field, code: error.code }));
      return errors.length
        ? { status: "fail", detail: `platform.json has ${errors.length} problem(s); the defaults are in force for the affected keys.`, data: { errors }, fix: manual("ops.config", "修正 platform.json", "Correct platform.json") }
        : { status: "ok", detail: "platform.json is valid.", data: { errors: [], warnings: (ctx.config.warnings || []).map((warning) => ({ field: warning.field, code: warning.code })) } };
    }),
    descriptor("ops.config-shadowed", "环境变量覆盖配置", "Environment shadowing configuration", async () => {
      const userNames = new Set((ctx.platform === "win32" ? await ctx.probe("userEnvNames").catch(() => []) : []).map((name) => name.toUpperCase()));
      const rows = Object.entries(ctx.config.sources || {}).filter(([, source]) => source === "env").map(([key]) => {
        const names = (ctx.config.envSet?.[key] || []);
        return { key, envNames: names, inUserEnvironment: names.some((name) => userNames.has(name.toUpperCase())) };
      });
      if (!rows.length) return { status: "ok", detail: "No environment variable overrides a configuration key.", data: { shadowed: [] } };
      return { status: "warn", detail: `${rows.length} configuration key(s) are overridden by environment variables.`, data: { shadowed: rows }, fix: ctx.fix("ops.config-shadowed", "import-env", "confirm", "把环境变量导入 platform.json", "Import the environment values into platform.json", "/docs/troubleshooting.md#ops") };
    }),
    descriptor("ops.logs-size", "日志占用空间", "Log size", async () => {
      const size = await ctx.probe("logsSize");
      const data = { bytes: size.bytes, files: size.files, truncated: size.truncated === true, warnBytes: LOGS_WARN_BYTES };
      return size.bytes > LOGS_WARN_BYTES
        ? { status: "warn", detail: `logs/ holds ${(size.bytes / 1024 ** 3).toFixed(1)} GiB.`, data, fix: ctx.fix("ops.logs-size", "prune-rotated-logs", "auto", "清理 14 天前的轮转日志", "Delete rotated logs older than 14 days", "/docs/troubleshooting.md#ops") }
        : { status: "ok", detail: "The log folder is within its size limit.", data };
    }),
  ];
}

module.exports = { createChecks };
