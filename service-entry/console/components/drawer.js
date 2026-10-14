// Drawer (07 §4.4): a modal side sheet on the native <dialog> (Modal). Esc and
// a backdrop click call onClose; below sm it becomes a full-screen sheet
// (components.css). With `urlId` it mirrors itself into ?drawer=<urlId>, so a
// reload or a shared link reopens it (the page reads the parameter).

import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useId } from "../ui/vendor.js";
import { Button } from "./button.js";
import { Modal } from "./dialog.js";
import { replaceQueryParam } from "./tabs.js";

function DrawerSheet({ title, width, onClose, footer, urlId, testid, children }) {
  const { t } = useT();
  const id = useId();
  useEffect(() => {
    if (!urlId) return undefined;
    replaceQueryParam("drawer", urlId);
    return () => replaceQueryParam("drawer", null);
  }, [urlId]);
  return html`<${Modal} class=${`drawer drawer-w${width}`} labelId=${`${id}-t`} onRequestClose=${() => onClose?.()} testid=${testid || "drawer.root"}>
    <div class="overlay-head">
      <h2 id=${`${id}-t`} class="card-title grow">${title}</h2>
      <${Button} variant="ghost" iconOnly icon="x" label=${t("common.close")} onClick=${() => onClose?.()} data-autofocus testid="drawer.close" />
    </div>
    <div class="overlay-body">${children}</div>
    ${footer ? html`<div class="overlay-foot">${footer}</div>` : null}
  <//>`;
}

/** @param width 480 | 640 | 840  @param urlId value for ?drawer= while open  @param footer buttons */
export function Drawer({ open, title, width = 480, onClose, footer, urlId, testid, children }) {
  const size = [480, 640, 840].includes(width) ? width : 480;
  return open ? html`<${DrawerSheet} title=${title} width=${size} onClose=${onClose} footer=${footer} urlId=${urlId} testid=${testid}>${children}<//>` : null;
}
