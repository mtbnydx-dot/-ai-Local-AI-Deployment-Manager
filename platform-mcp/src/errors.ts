/**
 * Turns a thrown error into a failure an agent can act on.
 *
 * The previous wording told every caller to "check that the relevant local
 * manager is running, then retry", which is the right advice for exactly one
 * of these categories. An agent that cannot tell a rejected argument from a
 * cold manager from a rate limit has only one strategy available — retry the
 * identical call — and that is the wrong move for most failures here.
 */

import { UpstreamRequestError } from "./http-client.js";
import { cleanText } from "./redaction.js";

export type ToolErrorCategory =
  | "bad_request"
  | "not_configured"
  | "not_found"
  | "rate_limited"
  | "response_too_large"
  | "timeout"
  | "unknown"
  | "upstream_contract"
  | "upstream_rejected"
  | "upstream_unavailable";

export type ClassifiedToolError = {
  category: ToolErrorCategory;
  retryable: boolean;
  retryAfterSeconds: number | null;
  message: string;
  guidance: string;
  service: string | null;
  status: number | null;
};

const GUIDANCE: Record<ToolErrorCategory, string> = {
  bad_request: "The arguments were rejected. Fix them before calling again; an identical retry fails the same way.",
  not_configured:
    "A required local service is not configured for MCP. This needs an operator change, not a retry.",
  not_found: "The requested record does not exist or has expired. Re-list the collection to get current identifiers.",
  rate_limited: "Wait for the retry window, then continue. Reuse data already returned instead of re-requesting it.",
  response_too_large:
    "The upstream reply exceeded the safety limit. Narrow the request with filters, a smaller limit, or fewer URLs.",
  timeout:
    "The local service did not answer in time. It may be busy loading a model; retry once after a short pause, then report the delay.",
  unknown: "Report the message. Retry only once, and treat a second identical failure as a real fault.",
  upstream_contract:
    "The local service answered with an unexpected shape, which usually means a version mismatch. Retrying will not help; report it.",
  upstream_rejected:
    "The local service refused the request. Check the arguments and the service's own authentication; do not retry unchanged.",
  upstream_unavailable:
    "The local service is not reachable. Confirm it is running, then retry; do not keep retrying a service that stays down.",
};

export function classifyToolError(error: unknown): ClassifiedToolError {
  const base = {
    message: error instanceof Error ? cleanText(error.message, 800) : "The platform request failed.",
    service: null as string | null,
    status: null as number | null,
  };

  if (isRateLimitError(error)) {
    return finish("rate_limited", true, error.retryAfterSeconds, {
      ...base,
      message: cleanText(error.message, 800),
    });
  }

  if (error instanceof UpstreamRequestError) {
    const detail = { message: cleanText(error.message, 800), service: error.service, status: error.status || null };
    if (error.reason === "timeout") return finish("timeout", true, null, detail);
    if (error.reason === "unreachable") return finish("upstream_unavailable", true, null, detail);
    if (error.reason === "too_large") return finish("response_too_large", false, null, detail);
    if (error.reason === "bad_shape") return finish("upstream_contract", false, null, detail);
    const status = error.status;
    if (status === 429) return finish("rate_limited", true, null, detail);
    if (status === 404) return finish("not_found", false, null, detail);
    if (status === 408 || status === 504) return finish("timeout", true, null, detail);
    if (status === 503 || status === 502) return finish("upstream_unavailable", true, null, detail);
    if (status >= 500) return finish("upstream_unavailable", true, null, detail);
    if (status >= 400) return finish("upstream_rejected", false, null, detail);
    return finish("unknown", false, null, detail);
  }

  if (isSchemaValidationError(error)) {
    return finish("upstream_contract", false, null, {
      ...base,
      message: "A local service returned data that does not match the published tool output schema.",
    });
  }

  if (error instanceof Error && /not configured|must be configured|provide PLATFORM_MCP/i.test(error.message)) {
    return finish("not_configured", false, null, base);
  }

  return finish("unknown", false, null, base);
}

export class ToolRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "ToolRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isRateLimitError(error: unknown): error is ToolRateLimitError {
  return error instanceof ToolRateLimitError;
}

/**
 * Zod is the only validator in play, but matching on the shape rather than on
 * an `instanceof` keeps this working if a tool ever validates with something
 * else, and avoids importing zod just for a type test.
 */
function isSchemaValidationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; issues?: unknown };
  return Array.isArray(candidate.issues) && String(candidate.name || "").includes("Error");
}

function finish(
  category: ToolErrorCategory,
  retryable: boolean,
  retryAfterSeconds: number | null,
  detail: { message: string; service: string | null; status: number | null },
): ClassifiedToolError {
  return {
    category,
    retryable,
    retryAfterSeconds,
    message: detail.message,
    guidance: GUIDANCE[category],
    service: detail.service,
    status: detail.status,
  };
}
