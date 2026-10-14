"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const winproc = require("../platform/winproc");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "platform", name), "utf8");
const identity = { pid: 4100, processCreatedAt: "2026-10-14T01:02:03.123Z", exe: "C:\\fixture\\bin\\node.exe" };

function fakeExec(handler) {
  const calls = [];
  return {
    calls,
    execFile(command, args, options, callback) {
      calls.push({ command, args, options });
      try { callback(null, handler(command, args), ""); } catch (error) { callback(error); }
    },
  };
}

test("netstat en and zh fixtures produce the same IPv4, IPv6 and UDP listeners", () => {
  const expected = [
    { protocol: "tcp", address: "127.0.0.1", port: 5176, pid: 4100, state: "LISTENING" },
    { protocol: "tcp", address: "0.0.0.0", port: 5177, pid: 4101, state: "LISTENING" },
    { protocol: "tcp", address: "::", port: 5178, pid: 4102, state: "LISTENING" },
    { protocol: "udp", address: "0.0.0.0", port: 5353, pid: 4104, state: "BOUND" },
  ];
  for (const name of ["netstat-en.txt.fixture", "netstat-zh.txt.fixture"]) assert.deepEqual(winproc.parseNetstat(fixture(name)), expected);
  assert.deepEqual(winproc.parseNetstat("TCP bad:70000 0.0.0.0:0 LISTENING 4\nTCP 0.0.0.0:9 0.0.0.0:0 LISTENING text"), []);
});

test("tasklist CSV handles translated headers, commas and escaped quotes", () => {
  const expected = [{ pid: 4100, imageName: "node.exe" }, { pid: 4104, imageName: "python.exe" }, { pid: 4110, imageName: 'tool,"quoted".exe' }];
  for (const name of ["tasklist-en.csv.fixture", "tasklist-zh.csv.fixture"]) assert.deepEqual(winproc.parseTasklist(fixture(name)), expected);
  assert.deepEqual(winproc.parseTasklist('INFO: No tasks are running.\n"bad.exe","not-a-pid"'), []);
});

test("CIM arrays, singleton, BOM and empty result normalize to UTC", () => {
  const rows = winproc.parseCim(fixture("cim-en.json.fixture"));
  assert.deepEqual(rows, winproc.parseCim(fixture("cim-zh.json.fixture")));
  assert.equal(rows[1].processCreatedAt, "2026-10-14T01:02:04.000Z");
  assert.deepEqual(winproc.parseCim(`\uFEFF${JSON.stringify(rows[0])}`), [rows[0]]);
  assert.deepEqual(winproc.parseCim("null"), []);
  assert.deepEqual(winproc.parseCim(""), []);
  assert.equal(winproc.parseCim('{"pid":1,"processCreatedAt":"bad"}')[0].processCreatedAt, null);
});

test("identity needs PID, UTC creation time within one second and the exe basename", () => {
  assert.equal(winproc.matchesIdentity(identity, { ...identity, exe: "D:\\fixture\\NODE.EXE", processCreatedAt: "2026-10-14T01:02:04.123Z" }), true);
  for (const change of [{ pid: 999 }, { exe: "python.exe" }, { processCreatedAt: "2026-10-14T01:02:04.124Z" }, { processCreatedAt: null }, { exe: "" }]) {
    assert.equal(winproc.matchesIdentity(identity, { ...identity, ...change }), false);
  }
});

test("one batched CIM call handles duplicate PIDs and scalar lookups without a shell", async () => {
  const fake = fakeExec(() => fixture("cim-en.json.fixture"));
  const client = winproc.createWinproc({ execFile: fake.execFile, platform: "win32" });
  const rows = await client.processInfo([4100, 4104, 4100]);
  assert.equal(rows.length, 2);
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].args.at(-1), /ProcessId=4100 OR ProcessId=4104/);
  assert.match(fake.calls[0].args.at(-1), /ToUniversalTime\(\)\.ToString\('o'\)/);
  assert.equal(fake.calls[0].options.windowsHide, true);
  assert.equal((await client.processInfo(4100)).pid, 4100);
  assert.equal(await client.processInfo(9999), null);
  const count = fake.calls.length;
  assert.deepEqual(await client.processInfo([]), []);
  await assert.rejects(client.processInfo("1;Remove-Item"), { code: "invalid_pid" });
  assert.equal(fake.calls.length, count);
});

test("listListeners and filtered imageNames use recorded output only", async () => {
  const fake = fakeExec((command) => command === "netstat.exe" ? fixture("netstat-en.txt.fixture") : fixture("tasklist-zh.csv.fixture"));
  const client = winproc.createWinproc({ execFile: fake.execFile, platform: "win32" });
  assert.equal((await client.listListeners()).length, 4);
  assert.deepEqual(await client.imageNames([4100, 9999]), { 4100: "node.exe" });
  assert.deepEqual(fake.calls.map((call) => call.args), [["-ano"], ["/FO", "CSV", "/NH"]]);
});

test("killTree refuses absent, recycled or mismatched identities before any taskkill", async () => {
  const fake = fakeExec(() => fixture("cim-en.json.fixture"));
  const client = winproc.createWinproc({ execFile: fake.execFile, platform: "win32" });
  for (const record of [undefined, { ...identity, processCreatedAt: "2026-10-13T01:02:03.123Z" }, { ...identity, exe: "python.exe" }]) {
    assert.equal((await client.killTree(4100, { identity: record })).reason, "identity-mismatch");
  }
  assert.equal(fake.calls.some((call) => call.command === "taskkill.exe"), false);
});

test("verified killTree renders tree/force args and a vanished process needs no kill", async () => {
  const fake = fakeExec((command) => command === "powershell.exe" ? fixture("cim-en.json.fixture") : "SUCCESS");
  const client = winproc.createWinproc({ execFile: fake.execFile, platform: "win32" });
  assert.equal((await client.killTree(4100, { identity })).ok, true);
  assert.deepEqual(fake.calls.at(-1).args, ["/PID", "4100", "/T", "/F"]);
  const count = fake.calls.length;
  assert.equal((await client.killTree(9999, { identity })).reason, "vanished");
  assert.equal(fake.calls.length, count + 1);
});

test("non-Windows operations fail before exec while parsers remain portable", async () => {
  const fake = fakeExec(() => { throw new Error("must not execute"); });
  const client = winproc.createWinproc({ execFile: fake.execFile, platform: "linux" });
  await assert.rejects(client.listListeners(), { code: "windows_only" });
  assert.equal(fake.calls.length, 0);
});
