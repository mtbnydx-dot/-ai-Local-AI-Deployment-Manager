import type { ResponseFormat } from "./schemas.js";

function escapeFence(text: string): string {
  return text.replace(/```/g, "` ` `");
}

export function formatToolPayload(
  title: string,
  payload: Record<string, unknown>,
  responseFormat: ResponseFormat,
  maxChars: number,
): string {
  const json = JSON.stringify(payload, null, 2);
  const rendered = responseFormat === "json"
    ? json
    : `# ${title}\n\n\`\`\`json\n${escapeFence(json)}\n\`\`\``;
  if (rendered.length <= maxChars) return rendered;
  const suffix = "\n\n[Response text truncated. Use filters or pagination; structured content remains bounded.]";
  return `${rendered.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}
