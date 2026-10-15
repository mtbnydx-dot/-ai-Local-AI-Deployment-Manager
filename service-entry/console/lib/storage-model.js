// The rules of the Storage page (07 §6.4, parity with the legacy
// /model-storage page, tests/model-storage.spec.cjs), pure so they can be
// tested without a DOM: path text, what a root and a migration job offer, and
// the request bodies of the manager's /api/model-storage* routes.
//
// The roots and migrations stay with the managers (03 keeps the migration
// planner there); the console reaches them through /api/m/<manager>/model-storage*.

const ACTIVE_STATES = Object.freeze(["copying", "verifying", "publishing", "cleaning"]);
const STARTABLE_STATES = Object.freeze(["planned", "failed", "interrupted", "cancelled"]);
const KEPT_STATES = Object.freeze(["completed", "cleanup_failed"]);
const KNOWN_STATES = Object.freeze(["planned", "completed", "copying", "verifying", "publishing", "cleaning", "cancelled", "interrupted", "failed", "cleanup_failed", "rolled_back"]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" ? value : "";
}

/** A pasted path without surrounding spaces and quotes (Explorer's "Copy as path" adds them). */
export function cleanPath(value) {
  return text(value).trim().replace(/^"(.*)"$/, "$1");
}

/** The folder above `value` (with its trailing separator), or "" at the top. */
export function parentDirectory(value) {
  const cleaned = cleanPath(value).replace(/[\\/]+$/, "");
  const index = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return index < 0 ? "" : cleaned.slice(0, index + 1);
}

function lastSegment(value) {
  const parts = cleanPath(value).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

/** Where a migrated model ends up: `<directory>/<name>`, the name defaulting to the source folder's. "" until both are known. */
export function destinationText(directory, outputName, source) {
  const dir = cleanPath(directory);
  const name = text(outputName).trim() || lastSegment(source);
  if (!dir || !name) return "";
  const separator = dir.includes("\\") ? "\\" : dir.includes("/") ? "/" : /^[a-z]:/i.test(dir) ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${separator}${name}`;
}

/** Whether a folder dialog choice may be used: not the drive list and not a drive root. */
export function folderChoosable(path) {
  const value = cleanPath(path);
  return Boolean(value) && !/^[a-z]:[\\/]?$/i.test(value) && value !== "/";
}

/** The badge a root shows: offline, default, imported (one model) or available. */
export function rootBadge(root, defaultRootId) {
  if (root?.online === false) return "offline";
  if (root?.id === defaultRootId) return "default";
  return root?.mode === "model" ? "imported" : "available";
}

/** The roots a migration can target: online model libraries. */
export function libraryRoots(snapshot) {
  return list(snapshot?.roots).filter((root) => root && root.online !== false && root.mode !== "model");
}

/** The root the target field starts with: the default library, else the first. */
export function defaultTarget(snapshot) {
  const libraries = libraryRoots(snapshot);
  return (libraries.find((root) => root.id === snapshot?.defaultRootId) || libraries[0])?.path || "";
}

/** POST /api/model-storage/roots */
export function registerBody(form) {
  return {
    path: cleanPath(form?.path),
    label: text(form?.label).trim(),
    mode: form?.mode === "model" ? "model" : "library",
    create: form?.create === true,
    makeDefault: form?.makeDefault === true,
  };
}

/** POST /api/model-storage/migrations/plan */
export function planBody(form) {
  return {
    source: cleanPath(form?.source),
    targetDirectory: cleanPath(form?.targetDirectory),
    outputName: text(form?.outputName).trim(),
  };
}

export function knownState(state) {
  return KNOWN_STATES.includes(state) ? state : "";
}

/** What a migration job offers (legacy page: start or continue, pause, switch back, clean up). */
export function migrationActions(job) {
  const state = text(job?.state);
  const sourceKept = !job?.sourceRemoved;
  return {
    start: STARTABLE_STATES.includes(state),
    continue: state !== "planned" && STARTABLE_STATES.includes(state),
    cancel: ACTIVE_STATES.includes(state) && state !== "cleaning",
    rollback: KEPT_STATES.includes(state) && sourceKept,
    cleanup: KEPT_STATES.includes(state) && sourceKept,
    active: ACTIVE_STATES.includes(state),
  };
}

export function anyActive(migrations) {
  return list(migrations).some((job) => ACTIVE_STATES.includes(text(job?.state)));
}

/** Percent copied, or null while the total is unknown. */
export function migrationPercent(job) {
  const total = Number(job?.totalBytes);
  const done = Number(job?.bytesDone);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(done)) return null;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

/** The folder name that heads a migration card. */
export function migrationTitle(job) {
  return lastSegment(job?.source) || text(job?.id);
}
