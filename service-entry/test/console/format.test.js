// 07 §3.7 formatters against golden/format.json for both locales: bytes,
// tokens, durations, relative times, percents, rates and dates.
//
// To refresh the golden after a deliberate change, run this file with
// CONSOLE_GOLDEN_UPDATE=1 and review the diff before committing it.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFormatters } from "../../console/lib/format.js";
import { LOCALES } from "../../console/lib/i18n.js";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "format.json");
const NOW = "2026-10-14T08:00:00.000Z";

// [function, ...arguments]; the golden holds one output per locale.
const CASES = [
  ["bytes", 0], ["bytes", 512], ["bytes", 1536], ["bytes", 5027783488], ["bytes", 62491774157], ["bytes", 102641946624], ["bytes", 1.2e15],
  ["bytes", 5027783488, { unit: "MiB" }], ["bytes", 5027783488, { unit: "GiB" }], ["bytes", null], ["bytes", -2048],
  ["mib", 96801], ["mib", 512.4], ["mib", undefined],
  ["tokens", 0], ["tokens", 512], ["tokens", 8192], ["tokens", 131072], ["tokens", 262144], ["tokens", 1048576], ["tokens", 200000], ["tokens", "x"],
  ["duration", 0], ["duration", 512], ["duration", 1000], ["duration", 59999], ["duration", 545000], ["duration", 3600000], ["duration", 3723000],
  ["duration", 90061000], ["duration", 545000, { style: "narrow" }], ["duration", -5000], ["duration", Number.NaN],
  ["relative", "2026-10-14T07:59:55.000Z"], ["relative", "2026-10-14T07:57:00.000Z"], ["relative", "2026-10-14T05:00:00.000Z"],
  ["relative", "2026-10-13T08:00:00.000Z"], ["relative", "2026-09-01T08:00:00.000Z"], ["relative", "2024-10-14T08:00:00.000Z"],
  ["relative", "2026-10-14T10:00:00.000Z"], ["relative", "not a date"],
  ["percent", 0.612], ["percent", 1], ["percent", 0.0005, 2], ["percent", 0.24, 0], ["percent", null],
  ["number", 1234567.891], ["number", 0.5, 0], ["integer", 1234567.5], ["rate", 38.64, "tok/s"], ["rate", 1200, "req/min"],
  ["dateTime", NOW], ["dateTime", NOW, { style: "short" }], ["dateTime", NOW, { style: "long" }], ["dateTime", NOW, { style: "date" }], ["dateTime", "garbage"],
  ["time", "2026-10-14T08:00:05.000Z"], ["range", NOW, "2026-10-14T09:30:00.000Z"], ["range", NOW, "2026-10-15T09:30:00.000Z"],
];

function run(locale) {
  const format = createFormatters(locale, { timeZone: "UTC" });
  return CASES.map(([name, ...args]) => (name === "relative" ? format.relative(args[0], NOW) : format[name](...args)));
}

function caseLabel([name, ...args]) {
  return `${name}(${args.map((arg) => (Number.isNaN(arg) ? "NaN" : JSON.stringify(arg))).join(", ")})`;
}

test("formatters match the golden in both locales", () => {
  const actual = { schemaVersion: 1, timeZone: "UTC", now: NOW, cases: CASES.map((item, index) => ({ case: caseLabel(item), ...Object.fromEntries(LOCALES.map((locale) => [locale, run(locale)[index]])) })) };
  if (process.env.CONSOLE_GOLDEN_UPDATE === "1") {
    fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  assert.equal(golden.cases.length, CASES.length, "the golden lists every case");
  for (let index = 0; index < CASES.length; index += 1) {
    assert.equal(golden.cases[index].case, caseLabel(CASES[index]));
    for (const locale of LOCALES) {
      assert.equal(actual.cases[index][locale], golden.cases[index][locale], `${locale} ${golden.cases[index].case}`);
    }
  }
});

test("sizes keep binary GiB/MiB labels in both locales and missing values are a dash", () => {
  for (const locale of LOCALES) {
    const format = createFormatters(locale);
    assert.match(format.bytes(62491774157), /GiB$/);
    assert.match(format.bytes(5242880, { unit: "MiB" }), /^5 MiB$/);
    assert.equal(format.bytes(undefined), String.fromCharCode(0x2014));
    assert.equal(format.relative(null), String.fromCharCode(0x2014));
  }
});
