// CodeBlock (07 §4.4) and the console's one copy-to-clipboard routine.
//
// copyText() uses navigator.clipboard in a secure context. When that is
// missing (LAN over http) or refuses (permission denied, no focus), it falls
// back to a hidden textarea and execCommand("copy"). If even that fails the
// block selects its text so the person can press Ctrl+C.

import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useRef, useState } from "../ui/vendor.js";
import { Icon } from "./icon.js";

function legacyCopy(value) {
  const doc = globalThis.document;
  if (!doc?.body || typeof doc.execCommand !== "function") return false;
  const previous = doc.activeElement;
  // Inside a modal <dialog> everything outside it is inert, so the textarea joins the dialog.
  const host = previous?.closest?.("dialog") || doc.body;
  const area = doc.createElement("textarea");
  area.value = value;
  area.readOnly = true;
  area.tabIndex = -1;
  area.setAttribute("aria-hidden", "true");
  Object.assign(area.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0" });
  host.appendChild(area);
  let ok = false;
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, value.length);
    ok = doc.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  if (typeof previous?.focus === "function") previous.focus();
  return ok;
}

/** Copies `text`; resolves true when a route worked and false when the person must copy by hand. */
export async function copyText(text) {
  const value = String(text ?? "");
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (globalThis.isSecureContext && clipboard?.writeText) {
      await clipboard.writeText(value);
      return true;
    }
  } catch {
    // Permission denied or the document lost focus: use the textarea route.
  }
  return legacyCopy(value);
}

/** A copy button's state: "idle" | "copied" | "failed"; it returns to idle after 2 s. */
export function useCopy() {
  const [state, setState] = useState("idle");
  const timer = useRef(null);
  useEffect(() => () => globalThis.clearTimeout(timer.current), []);
  async function copy(text) {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    globalThis.clearTimeout(timer.current);
    timer.current = globalThis.setTimeout(() => setState("idle"), 2000);
    return ok;
  }
  return [state, copy];
}

// wrap wraps long lines; copyLabel overrides the button text.
export function CodeBlock({ code, language, wrap = false, copyLabel, testid }) {
  const { t } = useT();
  const [state, copy] = useCopy();
  const pre = useRef(null);
  async function onCopy() {
    if (!(await copy(code)) && pre.current) {
      const range = globalThis.document.createRange();
      range.selectNodeContents(pre.current);
      const selection = globalThis.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  const status = state === "copied" ? t("common.copied") : state === "failed" ? t("common.copyFailed") : "";
  return html`<div class="code-block" data-testid=${testid || "code-block.root"}>
    <pre ref=${pre} tabindex="0" class=${wrap ? "code-wrap" : undefined} data-testid="code-block.code"><code data-language=${language}>${code}</code></pre>
    <button type="button" class="btn btn-sm code-block-copy" onClick=${onCopy} data-state=${state} data-testid="code-block.copy">
      <${Icon} name=${state === "copied" ? "check" : "copy"} />${state === "copied" ? t("common.copied") : copyLabel || t("common.copy")}
    </button>
    <span class=${state === "failed" ? "small text-danger" : "sr-only"} role="status" data-testid="code-block.status">${status}</span>
  </div>`;
}
