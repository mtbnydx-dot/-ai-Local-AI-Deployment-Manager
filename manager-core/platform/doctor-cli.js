"use strict";

// `platform doctor [--fix[=<checkId>]] [--yes] [--deep] [--group g] [--json]`
// (06 §6.2). scripts/platformctl.js (OPS-7a) lazy-requires runDoctorCommand and
// passes its own io and, when a supervisor answers, a `fixer` that posts to
// POST /v1/doctor/fix; without one the fixes run in this process.
//   exit 0: no check failed (after fixes); 1: a check still fails; 2: bad arguments.
const doctorApi = require("./doctor");
const fixApi = require("./doctor-fix");

const GROUP_NAMES = new Set(doctorApi.CHECK_GROUPS);

function parseDoctorArgs(argv = []) {
  const parsed = { fix: false, checkId: null, yes: false, deep: false, json: false, groups: [], errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === "--fix") parsed.fix = true;
    else if (arg.startsWith("--fix=")) { parsed.fix = true; parsed.checkId = arg.slice(6) || null; }
    else if (arg === "--yes" || arg === "-y") parsed.yes = true;
    else if (arg === "--deep") parsed.deep = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--group" || arg.startsWith("--group=")) {
      const value = arg === "--group" ? argv[++i] : arg.slice(8);
      for (const name of String(value || "").split(",").filter(Boolean)) {
        if (GROUP_NAMES.has(name)) parsed.groups.push(name); else parsed.errors.push(`Unknown group ${name}.`);
      }
    } else parsed.errors.push(`Unknown option ${arg}.`);
  }
  return parsed;
}

function pick(text, lang) { return (text && (text[lang] || text["en-US"])) || ""; }

async function runDoctorCommand(argv, io = {}, deps = {}) {
  const out = io.out || ((text) => process.stdout.write(`${text}\n`));
  const err = io.err || ((text) => process.stderr.write(`${text}\n`));
  const lang = io.lang || "en-US";
  const args = parseDoctorArgs(argv);
  if (args.errors.length) { err(args.errors.join("\n")); return 2; }
  const runDoctor = deps.runDoctor || doctorApi.runDoctor;
  const base = { ...(deps.options || {}), deep: args.deep, ...(args.groups.length ? { groups: args.groups } : {}) };
  let report = await runDoctor(base);
  const outcomes = [];

  if (args.fix) {
    const targets = report.checks.filter((check) => fixApi.collectFixes(check).length && check.status !== "ok" && check.status !== "skip" && (!args.checkId || check.id === args.checkId));
    if (args.checkId && !targets.length) err(`${args.checkId}: no fix is available.`);
    const fixer = deps.fixer || ((body, fixIo) => fixApi.runFix(body, { ...(deps.options || {}), prompt: io.prompt, line: fixIo.line, progress: fixIo.progress }));
    for (const check of targets) for (const fix of fixApi.collectFixes(check)) {
      const label = pick(fix.label, lang);
      if (fix.risk === "manual") {
        // Printed, never executed.
        outcomes.push({ checkId: check.id, fixId: fix.id, outcome: "manual", command: fix.command || null, docs: fix.docs || null });
        if (!args.json) out(`${check.id}: manual - ${label}${fix.command ? `\n    ${fix.command}` : ""}${fix.docs ? `\n    docs: ${fix.docs}` : ""}`);
        continue;
      }
      try {
        await fixer({ checkId: check.id, fixId: fix.id, confirm: args.yes }, { line: (text) => { if (!args.json) out(`${check.id}: ${text}`); }, progress: () => {} });
        outcomes.push({ checkId: check.id, fixId: fix.id, outcome: "done" });
      } catch (error) {
        outcomes.push({ checkId: check.id, fixId: fix.id, outcome: error.code === "confirm_required" ? "declined" : "failed", code: error.code || "fix_failed" });
        if (!args.json) out(`${check.id}: ${error.code === "confirm_required" ? "skipped (not confirmed)" : `failed (${error.code || error.message})`}`);
      }
    }
    report = await runDoctor(base);
  }

  if (args.json) out(JSON.stringify(args.fix ? { ...report, fixes: outcomes } : report, null, 2));
  else {
    for (const check of report.checks) out(`${check.status.toUpperCase().padEnd(4)} ${check.id} - ${check.detail}`);
    const s = report.summary;
    out(`ok ${s.ok}, warn ${s.warn}, fail ${s.fail}, info ${s.info}, skip ${s.skip}`);
  }
  return report.summary.fail > 0 ? 1 : 0;
}

module.exports = { parseDoctorArgs, runDoctorCommand };
