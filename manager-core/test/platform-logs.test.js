"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const logs = require("../platform/logs");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-logs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("rotateOnStart preserves current out/err and keeps exactly N previous runs", (t) => {
  const dir = temporary(t);
  for (const stream of ["out", "err"]) {
    fs.writeFileSync(path.join(dir, `entry.${stream}.log`), `current-${stream}`);
    for (let i = 1; i <= 3; i += 1) fs.writeFileSync(path.join(dir, `entry.${stream}.${i}.log`), `older-${i}`);
  }
  const rotations = logs.rotateOnStart(dir, "entry", 3);
  assert.equal(rotations.length, 2);
  for (const stream of ["out", "err"]) {
    assert.equal(fs.existsSync(path.join(dir, `entry.${stream}.log`)), false);
    assert.equal(fs.readFileSync(path.join(dir, `entry.${stream}.1.log`), "utf8"), `current-${stream}`);
    assert.equal(fs.readFileSync(path.join(dir, `entry.${stream}.3.log`), "utf8"), "older-2");
    assert.equal(fs.existsSync(path.join(dir, `entry.${stream}.4.log`)), false);
  }
  assert.throws(() => logs.rotateOnStart(dir, "../other"), /Invalid log base/);
});

test("copy-truncate keeps an existing append handle usable and preserves the snapshot", (t) => {
  const dir = temporary(t), file = path.join(dir, "entry.err.log");
  const previous = "previous run\n".repeat(20);
  fs.writeFileSync(file, previous);
  fs.writeFileSync(path.join(dir, "entry.err.1.log"), "older");
  const fd = fs.openSync(file, "a");
  try {
    assert.equal(logs.maybeCopyTruncate(file, 20), true);
    assert.equal(fs.readFileSync(path.join(dir, "entry.err.1.log"), "utf8"), previous);
    assert.equal(fs.readFileSync(path.join(dir, "entry.err.2.log"), "utf8"), "older");
    fs.writeSync(fd, "new run\n");
    assert.equal(fs.readFileSync(file, "utf8"), "new run\n");
  } finally { fs.closeSync(fd); }
  assert.equal(logs.maybeCopyTruncate(file, 1024), false);
  assert.equal(logs.maybeCopyTruncate(path.join(dir, "absent.log"), 1024), false);
});

test("tailLog bounds bytes and lines, handles CRLF/UTF-8 and redacts every selected line", (t) => {
  const file = path.join(temporary(t), "entry.out.log");
  fs.writeFileSync(file, "discard\r\n中文内容\r\nsecond\r\nthird\r\n");
  const calls = [];
  assert.equal(logs.tailLog(file, { lines: 2, redactor: { redact(line) { calls.push(line); return `safe:${line}`; } } }), "safe:second\nsafe:third");
  assert.deepEqual(calls, ["second", "third"]);
  assert.equal(logs.tailLog(file, { maxBytes: 16 }), "second\nthird");
  assert.equal(logs.tailLog(file, { lines: 0 }), "");
  assert.equal(logs.tailLog(`${file}.missing`), "");
});

test("tails use the shared patterns and refreshed store values without a new redaction API", (t) => {
  const file = path.join(temporary(t), "entry.err.log");
  const patternKey = "sk-fixture0123456789abcdefghijklmn", exactKey = "opaque-fixture-secret-012345";
  fs.writeFileSync(file, `token=${exactKey}\n${patternKey}\n`);
  let secrets = [];
  const first = logs.tailLog(file, { getSecrets: () => secrets });
  assert.ok(first.includes(exactKey));
  assert.ok(!first.includes(patternKey));
  secrets = [exactKey];
  assert.equal(logs.tailLog(file, { getSecrets: () => secrets }), "token=<redacted>\n<redacted>");
  assert.equal(Object.keys(logs).some((name) => /redact/i.test(name)), false);
});

test("default tail/follow redactors load opaque values from the env root and explicit root takes precedence", (t) => {
  const envRoot = temporary(t), explicitRoot = temporary(t);
  const envKey = "opaque-env-fixture-value-012345", explicitKey = "opaque-explicit-fixture-value-67890";
  for (const [root, value] of [[envRoot, envKey], [explicitRoot, explicitKey]]) {
    // Valid ACL-only store fixtures avoid DPAPI or process calls in this test.
    const dir = path.join(root, ".runtime", "secrets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "platform.json"), JSON.stringify({ schemaVersion: 1, namespace: "platform", protection: "acl-only", entries: { "fixture.key": { value, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z" } } }));
  }
  const file = path.join(envRoot, "entry.out.log");
  fs.writeFileSync(file, `${envKey}\n${explicitKey}\n`);
  const previousRoot = process.env.AI_ROOT;
  process.env.AI_ROOT = envRoot;
  try {
    assert.equal(logs.tailLog(file), `<redacted>\n${explicitKey}`);
    assert.equal(logs.tailLog(file, { aiRoot: explicitRoot }), `${envKey}\n<redacted>`);
    const seen = [];
    const follower = logs.followLog(file, { lines: 0, onLine: (line) => seen.push(line) });
    try {
      fs.appendFileSync(file, `${envKey}\n`);
      follower.poll();
      assert.deepEqual(seen, ["<redacted>"]);
    } finally { follower.close(); }
  } finally {
    if (previousRoot === undefined) delete process.env.AI_ROOT;
    else process.env.AI_ROOT = previousRoot;
  }
});

test("followLog joins split secret lines and UTF-8 bytes before redacting", (t) => {
  const file = path.join(temporary(t), "entry.out.log");
  const key = "opaque-fixture-secret-012345";
  fs.writeFileSync(file, `old line\n${key.slice(0, 12)}`);
  const seen = [];
  const follower = logs.followLog(file, { getSecrets: () => [key], onLine: (line) => seen.push(line) });
  t.after(() => follower.close());
  assert.deepEqual(seen, ["old line"]);
  fs.appendFileSync(file, `${key.slice(12)}\n`);
  follower.poll();
  const chinese = Buffer.from("中文\n");
  fs.appendFileSync(file, chinese.subarray(0, 1)); follower.poll();
  fs.appendFileSync(file, chinese.subarray(1)); follower.poll();
  assert.deepEqual(seen, ["old line", "<redacted>", "中文"]);
});

test("followLog reopens after rename rotation, detects truncation, and aborts cleanly", (t) => {
  const dir = temporary(t), file = path.join(dir, "entry.out.log");
  fs.writeFileSync(file, "first\n");
  const controller = new AbortController(), seen = [];
  const follower = logs.followLog(file, { lines: 0, signal: controller.signal, onLine: (line) => seen.push(line) });
  t.after(() => follower.close());
  fs.renameSync(file, `${file}.previous`);
  follower.poll();
  fs.writeFileSync(file, "second\n"); follower.poll();
  fs.truncateSync(file, 0); follower.poll();
  fs.appendFileSync(file, "third\n"); follower.poll();
  assert.deepEqual(seen, ["second", "third"]);
  controller.abort();
  assert.equal(follower.closed, true);
  fs.appendFileSync(file, "after close\n"); follower.poll();
  assert.deepEqual(seen, ["second", "third"]);
});
