// axe-core for the console specs (07 C12, §9). axe-core 4.13.0 is a root
// devDependency (OPS-2) and is injected into the page as a same-origin script
// URL served by a Playwright route, so the console's CSP (script-src 'self')
// stays in force during the run. No @axe-core/playwright.
//
// Gate (07 §9): serious and critical findings always fail; a moderate finding
// fails unless axe-allowlist.json lists it with a justification (initially
// empty); minor findings are reported but never fail.
const fs = require("node:fs");
const path = require("node:path");
const { expect } = require("@playwright/test");

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const BLOCKING = new Set(["serious", "critical"]);
const SCRIPT_PATH = "/__axe-core.js";

let source = null;

function axeSource() {
  if (source === null) source = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  return source;
}

/** The allowlist entries; every one needs a rule, a route and a justification. */
function loadAllowlist(file = path.join(__dirname, "axe-allowlist.json")) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = Array.isArray(data.entries) ? data.entries : [];
  for (const entry of entries) {
    for (const field of ["rule", "route", "justification"]) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) throw new Error(`axe-allowlist.json: every entry needs a non-empty "${field}"`);
    }
  }
  return entries;
}

async function injectAxe(page) {
  if (await page.evaluate(() => typeof window.axe !== "undefined")) return;
  const url = new URL(SCRIPT_PATH, page.url()).href;
  await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: axeSource() }));
  await page.addScriptTag({ url });
}

/**
 * Runs axe on the page (or `include` selectors) and returns the violations.
 * @param options.include CSS selectors to scope the run
 * @param options.exclude CSS selectors to skip
 */
async function runAxe(page, { include, exclude } = {}) {
  await injectAxe(page);
  const raw = await page.evaluate(async ({ include: inc, exclude: exc, tags }) => {
    const context = {};
    if (inc?.length) context.include = inc.map((selector) => [selector]);
    if (exc?.length) context.exclude = exc.map((selector) => [selector]);
    const result = await window.axe.run(inc?.length || exc?.length ? context : document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target.join(" "), summary: String(node.failureSummary || "").split("\n").slice(0, 3).join(" ") })),
    }));
  }, { include, exclude, tags: TAGS });
  return raw;
}

/** Splits violations into the ones that fail the gate and the ones that do not. */
function judge(violations, { route = "", allowlist = loadAllowlist() } = {}) {
  const failing = [];
  const tolerated = [];
  for (const violation of violations) {
    const listed = allowlist.some((entry) => entry.rule === violation.id && (entry.route === "*" || entry.route === route));
    if (BLOCKING.has(violation.impact) || (violation.impact === "moderate" && !listed)) failing.push(violation);
    else tolerated.push(violation);
  }
  return { failing, tolerated };
}

function describeViolations(violations) {
  return violations.map((violation) => `${violation.impact} ${violation.id}: ${violation.help}\n${violation.nodes.map((node) => `    ${node.target}\n      ${node.summary}`).join("\n")}`).join("\n");
}

/**
 * Fails the test when axe finds a serious or critical violation, or a moderate
 * one that is not in the allowlist.
 * @param options.label added to the failure message (theme, viewport, state)
 */
async function expectNoA11yViolations(page, { include, exclude, label = "", route = new URL(page.url()).pathname, allowlist } = {}) {
  const violations = await runAxe(page, { include, exclude });
  const { failing } = judge(violations, { route, allowlist });
  expect(failing.length, `axe ${label || route}\n${describeViolations(failing)}`).toBe(0);
  return violations;
}

module.exports = { TAGS, axeSource, describeViolations, expectNoA11yViolations, injectAxe, judge, loadAllowlist, runAxe };
