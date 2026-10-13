const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("..");
const {
  HEALTH_API_ACTION_ALLOWLIST,
  createHealthProbe,
  healthActionDetail,
  healthActionDetails,
  healthCheck,
} = require("../health");

function assertBilingualLabel(detail) {
  assert.equal(typeof detail.label.zh, "string");
  assert.equal(typeof detail.label.en, "string");
  assert.ok(detail.label.zh.length > 0 && detail.label.en.length > 0);
  assert.match(detail.label.zh, /[一-鿿]/);
  assert.doesNotMatch(detail.label.en, /[一-鿿]/);
}

test("health action details have the 08 P0-23 shapes", () => {
  assert.deepEqual(healthActionDetail("start-docker"), {
    id: "start-docker",
    kind: "api",
    method: "POST",
    path: "/api/docker/start",
    label: { zh: "启动 Docker", en: "Start Docker" },
  });
  assert.deepEqual(healthActionDetail("pull-image", { image: "example/runtime@sha256:0123" }), {
    id: "pull-image",
    kind: "command",
    command: "docker pull example/runtime@sha256:0123",
    label: { zh: "复制拉取命令", en: "Copy pull command" },
  });
  assert.equal(
    healthActionDetail("pull-image", { image: "example/runtime:1.0", platform: "linux/amd64" }).command,
    "docker pull --platform linux/amd64 example/runtime:1.0",
  );
  assert.deepEqual(healthActionDetail("install-download-cli"), {
    id: "install-download-cli",
    kind: "command",
    command: "install-download-cli.cmd",
    label: { zh: "安装下载工具：运行 install-download-cli.cmd", en: "Install the download tool: run install-download-cli.cmd" },
  });
  for (const id of ["start-docker", "pull-image", "install-download-cli"]) {
    assertBilingualLabel(healthActionDetail(id, { image: "example/runtime:1.0" }));
  }
});

test("unknown actions and unusable pull commands are dropped", () => {
  assert.equal(healthActionDetail("format-disk"), null);
  assert.equal(healthActionDetail("pull-image", {}), null);
  assert.equal(healthActionDetail("pull-image", { image: "bad image; rm" }), null);
  // Locally built images are never pulled.
  assert.equal(healthActionDetail("pull-image", { image: "local/muse-runtime:dev" }), null);
  assert.deepEqual(healthActionDetails(["format-disk", "start-docker"]).map((item) => item.id), ["start-docker"]);
});

test("healthCheck keeps the string actions and adds actionDetails only when there are some", () => {
  assert.deepEqual(healthCheck("id", "Label", "ok", 123), { id: "id", label: "Label", status: "ok", detail: "123", actions: [] });
  const docker = healthCheck("docker", "Docker", "fail", "not running", ["start-docker"], healthActionDetails(["start-docker"]));
  assert.deepEqual(docker.actions, ["start-docker"]);
  assert.equal(docker.actionDetails.length, 1);
  assert.equal(docker.actionDetails[0].path, "/api/docker/start");
  const pull = healthCheck("image", "Image", "warn", "missing", ["pull-image"], healthActionDetails(["pull-image"], { image: "example/runtime:1.0" }));
  assert.deepEqual(pull.actions, ["pull-image"]);
  assert.equal(pull.actionDetails[0].kind, "command");
});

test("no api action points anywhere but POST /api/docker/start", () => {
  assert.deepEqual(HEALTH_API_ACTION_ALLOWLIST, ["POST /api/docker/start"]);
  const forged = [
    { id: "stop", kind: "api", method: "POST", path: "/api/stop", label: { zh: "停止", en: "Stop" } },
    { id: "start-docker", kind: "api", method: "GET", path: "/api/docker/start", label: { zh: "启动 Docker", en: "Start Docker" } },
    { id: "shell", kind: "script", command: "x", label: { zh: "脚本", en: "Script" } },
    { id: "empty", kind: "command", command: "", label: { zh: "空", en: "Empty" } },
  ];
  const check = healthCheck("x", "X", "fail", "", [], [...forged, ...healthActionDetails(["start-docker"])]);
  assert.deepEqual(check.actionDetails.map((item) => `${item.method} ${item.path}`), ["POST /api/docker/start"]);
  assert.equal(healthCheck("y", "Y", "fail", "", [], forged).actionDetails, undefined);

  // The allowlisted route is the one runtime-routes registers.
  const routes = [];
  const app = { get: (route) => routes.push(`GET ${route}`), post: (route) => routes.push(`POST ${route}`) };
  core.registerRuntimeRoutes(app, { startDockerDesktop: async () => ({ ok: true }) });
  for (const entry of HEALTH_API_ACTION_ALLOWLIST) assert.ok(routes.includes(entry), entry);
  for (const detail of healthActionDetails(["start-docker", "pull-image", "install-download-cli"], { image: "example/runtime:1.0" })) {
    if (detail.kind === "api") assert.ok(HEALTH_API_ACTION_ALLOWLIST.includes(`${detail.method} ${detail.path}`));
  }
});

test("commandHealth attaches actionDetails only while the command is missing or failing", async () => {
  const install = healthActionDetails(["install-download-cli"]);
  const probe = createHealthProbe({
    execFileAsync: async (command) => {
      if (command === "broken") return { stdout: "", stderr: "boom", error: new Error("exit 1") };
      if (command === "throws") throw new Error("spawn ENOENT");
      return { stdout: "hf 1.0\n", stderr: "" };
    },
  });
  const ok = await probe.commandHealth("hf-cli", "Hugging Face CLI", "hf", ["--help"], "fail", install);
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.actions, []);
  assert.equal(ok.actionDetails, undefined);

  const missing = await probe.commandHealth("hf-cli", "Hugging Face CLI", "", ["--help"], "warn", install);
  assert.equal(missing.status, "warn");
  assert.deepEqual(missing.actions, []);
  assert.deepEqual(missing.actionDetails.map((item) => item.id), ["install-download-cli"]);

  const failing = await probe.commandHealth("hf-cli", "Hugging Face CLI", "broken", ["--help"], "fail", install);
  assert.equal(failing.status, "warn");
  assert.equal(failing.actionDetails[0].command, "install-download-cli.cmd");

  const thrown = await probe.commandHealth("hf-cli", "Hugging Face CLI", "throws", ["--help"], "fail", install);
  assert.equal(thrown.status, "fail");
  assert.equal(thrown.actionDetails[0].id, "install-download-cli");

  // The old call shape keeps working without actionDetails.
  const legacy = await probe.commandHealth("modelscope-cli", "ModelScope CLI", "", ["--help"], "warn");
  assert.equal(legacy.actionDetails, undefined);
});
