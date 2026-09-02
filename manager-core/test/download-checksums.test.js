const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("..");

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

test("checksum verification passes good files and pinpoints corrupted ones", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "download-checksums-"));
  await fs.writeFile(path.join(dir, "good.safetensors"), "good-bytes");
  await fs.writeFile(path.join(dir, "bad.safetensors"), "corrupted!");
  const manifest = [
    { name: "good.safetensors", size: 10, sha256: sha256("good-bytes") },
    { name: "bad.safetensors", size: 10, sha256: sha256("original-!") },
    { name: "missing.safetensors", size: 5, sha256: sha256("never") },
    { name: "../escape.safetensors", size: 1, sha256: sha256("x") },
  ];
  const result = await core.verifyDownloadChecksums(dir, manifest);
  assert.equal(result.ok, false);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.mismatched.map((item) => item.name), ["bad.safetensors"]);
  assert.deepEqual(result.missing, ["missing.safetensors"]);
});

test("checksum runner deletes only mismatched files and fails the job", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "download-checksums-run-"));
  await fs.writeFile(path.join(dir, "good.safetensors"), "good-bytes");
  await fs.writeFile(path.join(dir, "bad.safetensors"), "corrupted!");
  const logs = [];
  const run = core.createDownloadChecksumRunner({
    appendLog: (_job, line) => logs.push(String(line)),
    getSettings: () => ({ verifyChecksums: true }),
    formatBytes: (value) => `${value}B`,
  });
  const job = {
    meta: {
      localDir: dir,
      fileManifest: [
        { name: "good.safetensors", size: 10, sha256: sha256("good-bytes") },
        { name: "bad.safetensors", size: 10, sha256: sha256("original-!") },
      ],
    },
  };
  await assert.rejects(() => run(job), /SHA256 校验失败/);
  assert.equal(await fs.access(path.join(dir, "good.safetensors")).then(() => true, () => false), true, "good file must stay");
  assert.equal(await fs.access(path.join(dir, "bad.safetensors")).then(() => true, () => false), false, "bad file must be deleted");
  assert.deepEqual(job.meta.checksum.mismatched, ["bad.safetensors"]);

  // 关闭设置时直接跳过。
  const skipRun = core.createDownloadChecksumRunner({
    appendLog: () => {},
    getSettings: () => ({ verifyChecksums: false }),
  });
  assert.equal(await skipRun(job), null);
});
