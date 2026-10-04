export const SERVER_NAME = "local-ai-platform";
export const SERVER_VERSION = "0.6.0";

/**
 * Every tool, in the order it is registered and therefore the order
 * `tools/list` emits: platform state, then inventory and metrics, then the
 * web tools, then jobs and planning, then recorded history, then posture.
 */
export const TOOL_NAMES = [
  "local_ai_get_overview",
  "local_ai_list_running_models",
  "local_ai_get_gpu_status",
  "local_ai_list_local_models",
  "local_ai_get_performance",
  "local_ai_get_diagnostics",
  "local_ai_get_search_health",
  "local_ai_search_web",
  "local_ai_research_web",
  "local_ai_open_web_page",
  "local_ai_read_search_result",
  "local_ai_find_in_search_result",
  "local_ai_list_jobs",
  "local_ai_preview_route",
  "local_ai_estimate_memory",
  "local_ai_list_benchmarks",
  "local_ai_compare_benchmarks",
  "local_ai_get_idle_state",
  "local_ai_get_security_posture",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Tools that reach the public internet through the local search gateway.
 * They carry the largest schemas and the only untrusted-content surface, so a
 * deployment that does not need them can leave the group out.
 */
export const WEB_TOOL_NAMES = [
  "local_ai_get_search_health",
  "local_ai_search_web",
  "local_ai_research_web",
  "local_ai_open_web_page",
  "local_ai_read_search_result",
  "local_ai_find_in_search_result",
] as const satisfies readonly ToolName[];

const WEB_TOOLS = new Set<ToolName>(WEB_TOOL_NAMES);

/** Tools that read the local platform and never leave the machine. */
export const OPS_TOOL_NAMES = TOOL_NAMES.filter((name) => !WEB_TOOLS.has(name));

/**
 * Which group of tools to register. The whole manifest is sent on every
 * session, so a client that only needs platform operations should not pay for
 * the web tools' schemas, and vice versa.
 */
export const TOOL_PROFILE_NAMES = ["all", "ops", "web"] as const;

export type ToolProfile = (typeof TOOL_PROFILE_NAMES)[number];

export function toolsForProfile(profile: ToolProfile): readonly ToolName[] {
  if (profile === "ops") return OPS_TOOL_NAMES;
  if (profile === "web") return WEB_TOOL_NAMES;
  return TOOL_NAMES;
}
