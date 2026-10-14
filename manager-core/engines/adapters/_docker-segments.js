"use strict";

// Docker run segments shared by every Docker-hosted adapter (01-engines §6-§7).
// A LaunchCommand keeps the docker flags, the entrypoint, the image and the
// engine args apart; renderRunArgs puts them back in the one order docker
// reads them, so the goldens and DockerHost (§13) render through the same
// function.

/**
 * LaunchCommand -> docker argv after "docker":
 * ["run", "-d", ...flags, ...(entrypoint ? ["--entrypoint", entrypoint] : []), image, ...args]
 */
function renderRunArgs(command) {
  const docker = command?.docker || {};
  return [
    "run", "-d",
    ...(docker.flags || []),
    ...(docker.entrypoint ? ["--entrypoint", docker.entrypoint] : []),
    docker.image,
    ...(docker.args || []),
  ];
}

/** ["--label", "k=v", ...] -> ["--label", "k=v"] pairs, in order. */
function labelFlags(labels) {
  return (labels || []).flatMap((label) => ["--label", String(label)]);
}

/**
 * The read-only label map of a LaunchCommand: every "--label key=value" pair
 * of the flags, split at the first "=". Later pairs win, as they do in docker.
 */
function labelsFromFlags(flags) {
  const labels = {};
  const list = flags || [];
  for (let index = 0; index < list.length - 1; index += 1) {
    if (list[index] !== "--label") continue;
    const pair = String(list[index + 1]);
    const split = pair.indexOf("=");
    if (split > 0) labels[pair.slice(0, split)] = pair.slice(split + 1);
    index += 1;
  }
  return labels;
}

/** Recipe env as "-e NAME=value" flags; unset and empty values are skipped. */
function envAssignmentFlags(env) {
  const flags = [];
  for (const [key, value] of Object.entries(env || {})) {
    if (value !== undefined && value !== null && value !== "") flags.push("-e", `${key}=${value}`);
  }
  return flags;
}

module.exports = {
  envAssignmentFlags,
  labelFlags,
  labelsFromFlags,
  renderRunArgs,
};
