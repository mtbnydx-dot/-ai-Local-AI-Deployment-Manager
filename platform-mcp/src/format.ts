import type { ResponseFormat } from "./schemas.js";

/** Characters the markdown wrapper adds around the payload (title, fence, blank line). */
export const MARKDOWN_OVERHEAD_CHARS = 120;

function escapeFence(text: string): string {
  return text.replace(/```/g, "` ` `");
}

/**
 * Renders the text channel for a payload that has already been held to the
 * response budget.
 *
 * The JSON is serialized compactly. Indentation was pure cost here: it adds
 * roughly half again as many characters for a reader that parses JSON either
 * way, and both channels pay for it.
 */
export function formatToolPayload(
  title: string,
  payload: Record<string, unknown>,
  responseFormat: ResponseFormat,
  maxChars: number,
): string {
  if (responseFormat === "structured") {
    // The caller asked for the structured channel only, so the text just says
    // where to look instead of repeating the whole payload.
    return `${title}: see structuredContent for the full result.`;
  }
  const json = JSON.stringify(payload);
  const rendered = responseFormat === "json"
    ? json
    : `# ${title}\n\n\`\`\`json\n${escapeFence(json)}\n\`\`\``;
  if (rendered.length <= maxChars) return rendered;
  // A backstop. The payload is bounded before it gets here, so reaching this
  // means the wrapper itself overflowed a very small configured limit.
  const suffix = "\n\n[Response text cut here. structuredContent carries the complete bounded payload.]";
  return `${rendered.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}
