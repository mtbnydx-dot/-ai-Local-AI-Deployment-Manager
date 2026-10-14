// ui-kit section: buttons, status badges, tabs and form fields.

import { tk } from "../../../lib/i18n.js";
import { useT } from "../../../ui/hooks.js";
import { html } from "../../../ui/html.js";
import { useState } from "../../../ui/vendor.js";
import { Button } from "../../../components/button.js";
import { Card } from "../../../components/card.js";
import { FormField } from "../../../components/form-field.js";
import { StatusBadge } from "../../../components/status-badge.js";
import { Tabs } from "../../../components/tabs.js";
import { STATUSES, TABS, VARIANTS } from "../../../data/ui-kit-fixtures.js";

export default function ActionsSection() {
  const { t } = useT();
  const [tab, setTab] = useState("one");
  const [changed, setChanged] = useState(true);
  const info = { what: t("uikit.help.what"), whenToChange: t("uikit.help.when"), tradeoffs: t("uikit.help.tradeoffs"), flag: "--max-model-len", docs: "/docs" };
  return html`
    <${Card} title=${t("uikit.buttons")}>
      <div class="row">
        ${VARIANTS.map((variant) => html`<${Button} variant=${variant}>${t(tk("uikit.variant.", variant))}<//>`)}
        <${Button} size="sm">${t("uikit.small")}<//>
        <${Button} iconOnly icon="search" label=${t("uikit.iconOnly")} />
        <${Button} busy>${t("uikit.busy")}<//>
        <${Button} disabled>${t("uikit.disabled")}<//>
        <${Button} href="/system">${t("uikit.link")}<//>
      </div>
      <div class="row">${STATUSES.map((status) => html`<${StatusBadge} status=${status} />`)}<${StatusBadge} status="ok" label=${t("uikit.custom")} /></div>
    <//>

    <${Card} title=${t("uikit.tabs")}>
      <${Tabs} tabs=${TABS.map((item) => ({ ...item, label: t(tk("uikit.tab.", item.id)), badge: item.id === "two" ? 3 : undefined }))} value=${tab} onChange=${setTab} urlParam=${null} label=${t("uikit.tabs")}>
        <p>${t("uikit.panel", { name: t(tk("uikit.tab.", tab)) })}</p>
      <//>
      <${Tabs} tabs=${TABS.slice(0, 2).map((item) => ({ ...item, label: t(tk("uikit.tab.", item.id)) }))} activation="manual" urlParam="manual" label=${t("uikit.manualTabs")} />
    <//>

    <${Card} title=${t("uikit.forms")}>
      <div class="stack">
        <${FormField} label=${t("uikit.field.context")} unit="tokens" hint=${t("uikit.field.hint")} help=${info} provenance="recipe" changed=${changed} onReset=${() => setChanged(false)}>
          ${(props) => html`<input class="input" type="number" value="65536" ...${props} />`}
        <//>
        <${FormField} label=${t("uikit.field.name")} required error=${t("uikit.field.error")}>${(props) => html`<input class="input" value="" ...${props} />`}<//>
        <${FormField} label=${t("uikit.field.port")} warning=${t("uikit.field.warning")} provenance="user">${(props) => html`<input class="input" value="8000" ...${props} />`}<//>
        <${FormField} label=${t("uikit.field.locked")} locked=${{ reason: t("uikit.field.lockReason") }} provenance="planner">${(props) => html`<input class="input" value="auto" ...${props} />`}<//>
      </div>
    <//>`;
}
