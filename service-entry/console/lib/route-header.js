// The gateway's `x-local-ai-route` answer header (07 §6.6), ported from the
// classic console's `describePlaygroundRoute` (index.html).
//
// The header is "<manager> <instance> <model> <reason>", space-separated.
// The instance is left out of the summary when it repeats the manager.

const HEADER = "x-local-ai-route";

/**
 * @param source a Headers-like object, a Response, or the header text
 * @returns {{ manager, instance, model, reason, text } | null} `text` joins the parts with " \u00b7 "
 */
export function describeRoute(source) {
  let raw = source;
  if (source && typeof source === "object") {
    const headers = source.headers && typeof source.headers.get === "function" ? source.headers : source;
    raw = typeof headers.get === "function" ? headers.get(HEADER) : null;
  }
  if (typeof raw !== "string" || !raw.trim()) return null;
  const [manager = "", instance = "", model = "", reason = ""] = raw.trim().split(/\s+/);
  const shownInstance = instance && instance !== manager ? instance : "";
  return {
    manager,
    instance,
    model,
    reason,
    text: [manager, shownInstance, model, reason].filter(Boolean).join(" \u00b7 "),
  };
}
