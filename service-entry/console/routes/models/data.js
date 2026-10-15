// What the Models pages read (07 §6.4), and the degrade path they share.
//
// The hub (03) answers /api/hub/*; before it does (or when it did not start),
// every read falls back to the managers' own routes through the management
// proxy: the library from `/api/m/{vllm,llama}/models`, the capacity from
// `/models/disk-usage`, and the roots and migrations from `/model-storage*`.
// A page tells the two apart by `source` ("hub" or "managers") and says so in a
// banner, so a missing column is never a silent gap.

import { degradable, entryView, mergeLegacyModels, taskDone, taskFailed } from "../../lib/library-model.js";
import { useServices } from "../../ui/context.js";
import { useQuery } from "../../ui/hooks.js";

const MANAGERS = ["vllm", "llama"];
const PAGE_LIMIT = 500;
const MAX_PAGES = 10;

function list(value) {
  return Array.isArray(value) ? value : [];
}

/** The first manager that answers `call(managerApi)`; the last error when none does. */
export async function firstManager(api, call) {
  let failure = null;
  for (const managerId of MANAGERS) {
    try {
      return { managerId, body: await call(api.manager(managerId), managerId) };
    } catch (error) {
      failure = failure || error;
    }
  }
  throw failure;
}

/** The whole hub library (every page of it) as table rows, or the managers' merged listing. */
export async function loadLibrary(api) {
  try {
    const entries = [];
    let roots = [];
    let cursor = "";
    let total = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await api.get("/api/hub/library", { query: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } });
      entries.push(...list(body?.entries));
      if (list(body?.roots).length) roots = body.roots;
      if (Number.isFinite(body?.total)) total = body.total;
      cursor = typeof body?.nextCursor === "string" ? body.nextCursor : "";
      if (!cursor) break;
    }
    return { source: "hub", views: entries.map((entry) => entryView(entry, roots)), roots, total: total ?? entries.length };
  } catch (error) {
    if (!degradable(error)) throw error;
  }
  const settled = await Promise.allSettled(MANAGERS.map((managerId) => api.manager(managerId).get("/models")));
  const answers = settled.map((result, index) => (result.status === "fulfilled" ? { managerId: MANAGERS[index], body: result.value } : null)).filter(Boolean);
  if (!answers.length) throw settled[0].reason;
  const merged = mergeLegacyModels(answers);
  return { source: "managers", views: merged.views, roots: merged.roots, total: merged.views.length };
}

/** @returns the useQuery result of the library; `data.source` is "hub" or "managers" */
export function useLibraryQuery() {
  const { api } = useServices();
  return useQuery(["hub", "library", "list"], () => loadLibrary(api), { ttlMs: 20000 });
}

/** Capacity per root: GET /api/hub/storage/usage, else the managers' disk-usage (same `roots[]` fields, fewer of them). */
export async function loadUsage(api) {
  try {
    return { source: "hub", usage: await api.get("/api/hub/storage/usage") };
  } catch (error) {
    if (!degradable(error)) throw error;
  }
  const { body } = await firstManager(api, (manager) => manager.get("/models/disk-usage"));
  return { source: "managers", usage: body };
}

export function useUsageQuery() {
  const { api } = useServices();
  return useQuery(["hub", "library", "usage"], () => loadUsage(api), { ttlMs: 15000 });
}

const TASK_POLL_MS = 700;
const TASK_MAX_MS = 10 * 60 * 1000;

/**
 * Follows a hub task (GET /api/hub/tasks/:id, 03 §9.5) to its end and returns
 * it; `library` events also carry the progress, so the poll is the safety net.
 * Rejects with the failed task's error, or `task_timeout` after ten minutes.
 */
export async function waitForTask(api, taskId, { intervalMs = TASK_POLL_MS, maxMs = TASK_MAX_MS, onProgress } = {}) {
  const started = Date.now();
  for (;;) {
    const body = await api.get(`/api/hub/tasks/${encodeURIComponent(taskId)}`);
    const task = body?.task ?? body;
    onProgress?.(task);
    if (taskDone(task)) {
      if (taskFailed(task)) {
        const failure = new Error(task?.error?.message || task?.error?.code || "task_failed");
        failure.code = task?.error?.code || "task_failed";
        throw failure;
      }
      return task;
    }
    if (Date.now() - started > maxMs) {
      const failure = new Error("task_timeout");
      failure.code = "task_timeout";
      throw failure;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs));
  }
}
