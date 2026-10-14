// ui-kit section: dialogs, the drawer and toasts. The drawer mirrors ?drawer=kit
// and reopens from it, which the keyboard spec relies on.

import { tk } from "../../../lib/i18n.js";
import { useServices } from "../../../ui/context.js";
import { useT } from "../../../ui/hooks.js";
import { html } from "../../../ui/html.js";
import { useState } from "../../../ui/vendor.js";
import { Button } from "../../../components/button.js";
import { Card } from "../../../components/card.js";
import { ConfirmDialog } from "../../../components/confirm-dialog.js";
import { Drawer } from "../../../components/drawer.js";
import { readQueryParam } from "../../../components/tabs.js";
import { Toast } from "../../../components/toast.js";
import { LEVELS } from "../../../data/ui-kit-fixtures.js";

const pause = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));
const failing = () => Promise.reject(Object.assign(new Error("timeout"), { code: "timeout" }));

export default function OverlaysSection() {
  const { t } = useT();
  const { toasts } = useServices();
  const [dialog, setDialog] = useState(() => (readQueryParam("drawer") === "kit" ? "drawer" : ""));
  const [pushes, setPushes] = useState(0);
  const close = () => setDialog("");
  const push = () => {
    const level = LEVELS[pushes % LEVELS.length];
    toasts?.push({ level, title: t(tk("uikit.toast.", level)), body: t("uikit.toast.body") });
    setPushes(pushes + 1);
  };
  return html`
    <${Card} title=${t("uikit.overlays")}>
      <div class="row">
        <${Button} onClick=${() => setDialog("confirm")} testid="uikit.open-confirm">${t("uikit.openConfirm")}<//>
        <${Button} variant="danger" onClick=${() => setDialog("danger")} testid="uikit.open-danger">${t("uikit.openDanger")}<//>
        <${Button} onClick=${() => setDialog("fail")} testid="uikit.open-fail">${t("uikit.openFail")}<//>
        <${Button} onClick=${() => setDialog("drawer")} testid="uikit.open-drawer">${t("uikit.openDrawer")}<//>
        <${Button} onClick=${push} testid="uikit.push-toast">${t("uikit.pushToast")}<//>
      </div>
      <div class="stack-sm">${LEVELS.map((level) => html`<${Toast} level=${level} title=${t(tk("uikit.toast.", level))} body=${t("uikit.toast.body")} requestId=${level === "error" ? "req_0123" : undefined} />`)}</div>
    <//>

    <${ConfirmDialog} open=${dialog === "confirm"} title=${t("uikit.confirm.title")} body=${t("uikit.confirm.body")} onConfirm=${() => pause(50)} onClose=${close} />
    <${ConfirmDialog} open=${dialog === "danger"} tone="danger" title=${t("uikit.danger.title")} body=${t("uikit.danger.body")} details=${[t("uikit.danger.stops"), t("uikit.danger.keeps")]}
      typeToConfirm="delete-me" confirmLabel=${t("uikit.danger.confirm")} onConfirm=${() => pause(50)} onClose=${close} />
    <${ConfirmDialog} open=${dialog === "fail"} title=${t("uikit.fail.title")} onConfirm=${failing} onClose=${close} />
    <${Drawer} open=${dialog === "drawer"} title=${t("uikit.drawer.title")} width=${640} urlId="kit" onClose=${close} footer=${html`<${Button} onClick=${close} testid="uikit.drawer-done">${t("uikit.drawer.done")}<//>`}>
      <p>${t("uikit.drawer.body")}</p>
    <//>`;
}
