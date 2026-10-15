// Copy to the clipboard with a visible and announced confirmation. A browser
// that refuses (an insecure origin, no permission) gets the old selection
// fallback, then an error toast; nothing throws into the page.

import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "../lib/html.js";
import { usePortal } from "../lib/context.js";

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the selection fallback.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "visually-hidden";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** CopyButton({ text, label }): `label` names what is copied, for assistive technology. */
export function CopyButton({ text, label, className = "" }) {
  const { t, toast } = usePortal();
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    if (await writeClipboard(String(text))) {
      setCopied(true);
      toast(t("copy.done"), "ok");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } else {
      toast(t("copy.failed"), "error");
    }
  }
  return html`<button type="button" class=${`btn btn-small ${className}`.trim()} aria-label=${label || t("copy.label")} onClick=${copy}>${copied ? t("copy.copied") : t("copy.label")}</button>`;
}
