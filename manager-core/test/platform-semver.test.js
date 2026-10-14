"use strict";

// The range check behind the platform's own requirements (docs/overhaul/
// 06-ops.md §2.1, V15): the Node range of the component registry and npm-style
// ranges in general.

const assert = require("node:assert/strict");
const test = require("node:test");

const semver = require("../platform/semver");

const NODE_RANGE = "^22.22.2 || ^24.15.0 || >=26.0.0";

test("the platform Node range accepts the supported lines only", () => {
  const cases = [
    ["22.22.2", true], ["v22.23.0", true], ["22.22.1", false], ["23.0.0", false],
    ["24.15.0", true], ["24.16.0", true], ["24.14.9", false], ["25.9.0", false],
    ["26.0.0", true], ["27.1.0", true], ["20.19.0", false], ["26.0.0-rc.1", false],
  ];
  for (const [version, expected] of cases) assert.equal(semver.satisfies(version, NODE_RANGE), expected, version);
});

test("caret, tilde, comparators, partial versions and wildcards follow npm", () => {
  const cases = [
    ["^1.2.3", "1.9.9", true], ["^1.2.3", "2.0.0", false], ["^0.2.3", "0.2.9", true], ["^0.2.3", "0.3.0", false],
    ["^0.0.3", "0.0.3", true], ["^0.0.3", "0.0.4", false], ["~1.2.3", "1.2.9", true], ["~1.2.3", "1.3.0", false],
    ["~1", "1.9.0", true], ["~1", "2.0.0", false], [">=24.15", "24.15.0", true], [">=24.15", "24.14.0", false],
    [">24", "24.9.9", false], [">24", "25.0.0", true], ["<=24.1", "24.1.7", true], ["<=24.1", "24.2.0", false],
    ["24", "24.3.1", true], ["24", "25.0.0", false], ["24.x", "24.0.1", true], ["*", "1.0.0", true],
    [">= 22.0.0 < 23", "22.5.0", true], [">=22.0.0 <23", "23.0.0", false], ["=1.0.0", "1.0.0", true],
    ["1.0.0", "1.0.1", false], [">=1.0.0-beta.2 <2", "1.0.0-beta.3", true], [">=1.0.0-beta.2 <2", "1.0.1-beta.3", false],
  ];
  for (const [range, version, expected] of cases) assert.equal(semver.satisfies(version, range), expected, `${version} in ${range}`);
});

test("parsing and comparison", () => {
  assert.deepEqual(semver.parseVersion("v24.16.0"), { major: 24, minor: 16, patch: 0, prerelease: [] });
  assert.equal(semver.parseVersion("24.16"), null);
  assert.equal(semver.compareVersions("1.0.0-alpha", "1.0.0"), -1);
  assert.equal(semver.compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
  assert.equal(semver.compareVersions("1.0.0-alpha.beta", "1.0.0-alpha.1"), 1);
  assert.equal(semver.compareVersions("2.0.0", "10.0.0"), -1);
  assert.equal(semver.compareVersions("1.2.3+build", "1.2.3"), 0);
  assert.throws(() => semver.compareVersions("x", "1.0.0"), TypeError);
  assert.equal(semver.validRange(NODE_RANGE), true);
  for (const bad of ["", "abc", ">=", "1.2.3 - 2.0.0", "^^1"]) {
    assert.equal(semver.validRange(bad), false, JSON.stringify(bad));
    assert.equal(semver.satisfies("1.2.3", bad), false);
  }
  assert.equal(semver.satisfies("not-a-version", NODE_RANGE), false);
});
