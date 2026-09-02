export const SERVER_NAME = "local-ai-platform";
export const SERVER_VERSION = "0.5.0";

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
  "local_ai_get_security_posture",
] as const;
