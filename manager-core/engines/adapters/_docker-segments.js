"use strict";

// Docker segments shared by the engine adapters (docs/overhaul/01-engines.md
// §6-§7, §13). A LaunchCommand keeps `docker run` as four ordered parts:
// flags, entrypoint, image and engine args. renderRunArgs is the one place
// that joins them into the argv after "docker", and the goldens, the legacy
// wrappers and DockerHost all call it, so the argv a test pins is the argv that
// runs. Nothing here sorts, dedupes or rewrites a token.

function dockerSegment(cmd) {
  const docker = cmd && typeof cmd === "object" && cmd.docker && typeof cmd.docker === "object" ? cmd.docker : cmd;
  if (!docker || typeof docker !== "object" || Array.isArray(docker)) {
    throw new TypeError("A LaunchCommand with a docker segment ({ flags, entrypoint, image, args }) is required.");
  }
  return docker;
}

/**
 * LaunchCommand (or its docker segment) -> the argv after "docker":
 * ["run", "-d", ...flags, ...(entrypoint ? ["--entrypoint", entrypoint] : []), image, ...args].
 * The entrypoint keeps its legacy position, immediately before the image.
 */
function renderRunArgs(cmd) {
  const docker = dockerSegment(cmd);
  return [
    "run", "-d",
    ...(Array.isArray(docker.flags) ? docker.flags : []),
    ...(docker.entrypoint ? ["--entrypoint", docker.entrypoint] : []),
    docker.image,
    ...(Array.isArray(docker.args) ? docker.args : []),
  ];
}

/** Label strings ("key=value") -> ["--label", "key=value", ...], in order. */
function labelFlags(labels) {
  return (Array.isArray(labels) ? labels : []).flatMap((label) => ["--label", String(label)]);
}

// The launch identity labels (01 §15.2, 00 §9.9), emitted by every adapter as
// the last docker flags before the entrypoint/image. Containers started by
// older code lack them and are adopted through LaunchStore instead.
const LAUNCH_LABEL_KEYS = Object.freeze({
  launchId: "ai.manager.launch-id",
  engineId: "ai.manager.engine-id",
  recipe: "ai.manager.recipe",
  runtimeId: "ai.manager.runtime-id",
});

/** { launchId, engineId, recipeId, runtimeId } -> the four label pairs; unknown values are empty. */
function launchLabelFlags({ launchId, engineId, recipeId, runtimeId } = {}) {
  const text = (value) => (value === undefined || value === null ? "" : String(value));
  return [
    "--label", `${LAUNCH_LABEL_KEYS.launchId}=${text(launchId)}`,
    "--label", `${LAUNCH_LABEL_KEYS.engineId}=${text(engineId)}`,
    "--label", `${LAUNCH_LABEL_KEYS.recipe}=${text(recipeId)}`,
    "--label", `${LAUNCH_LABEL_KEYS.runtimeId}=${text(runtimeId)}`,
  ];
}

/** Recipe env as "-e NAME=value" flags, in order; unset and empty values are skipped. */
function envAssignmentFlags(env) {
  const flags = [];
  for (const [key, value] of Object.entries(env && typeof env === "object" ? env : {})) {
    if (value !== undefined && value !== null && value !== "") flags.push("-e", `${key}=${value}`);
  }
  return flags;
}

/**
 * The `--label key=value` pairs of a flag list as an object, in emission
 * order: the read-only LaunchCommand.labels mirror that inspect and the plan
 * read. A later pair for the same key wins, as it does for docker.
 */
function labelsFromFlags(flags) {
  const labels = {};
  const list = Array.isArray(flags) ? flags : [];
  for (let index = 0; index < list.length - 1; index += 1) {
    if (list[index] !== "--label") continue;
    const pair = String(list[index + 1]);
    const split = pair.indexOf("=");
    const key = split > 0 ? pair.slice(0, split) : "";
    if (key && key !== "__proto__") labels[key] = pair.slice(split + 1);
    index += 1;
  }
  return labels;
}

module.exports = {
  LAUNCH_LABEL_KEYS,
  envAssignmentFlags,
  labelFlags,
  launchLabelFlags,
  labelsFromFlags,
  renderRunArgs,
};
