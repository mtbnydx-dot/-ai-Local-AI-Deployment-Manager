// /system/ui-kit (07 §6.13, CON-5; hidden from the navigation): every
// component in every state, for the axe, keyboard and visual specs.
//
// The page is a shell plus sections, each a route-sized module in ui-kit/ that
// loads on demand. A package that adds a component appends one loader to
// SECTIONS and writes its own section file, so the page never outgrows the
// 60 KB route budget (07 §11) however many components exist.
//
// The page needs the console services (i18n, formatters, toasts); mountUiKit()
// builds a minimal set so a spec can render it before the router exists, and
// the default export is the route component for the real shell.

import { createFormatters } from "../../lib/format.js";
import { createI18n } from "../../lib/i18n.js";
import { createPrefsStore } from "../../lib/prefs.js";
import { createQueryCache } from "../../lib/store.js";
import { createStorage } from "../../lib/storage.js";
import { createServices, ServicesContext } from "../../ui/context.js";
import { useT } from "../../ui/hooks.js";
import { html, render } from "../../ui/html.js";
import { useEffect, useState } from "../../ui/vendor.js";
import { Button } from "../../components/button.js";
import { PageHeader } from "../../components/page-header.js";
import { StatusBadge } from "../../components/status-badge.js";
import { createToasts, ToastHost } from "../../components/toast.js";

const SECTIONS = [
  () => import("./ui-kit/actions.js"),
  () => import("./ui-kit/overlays.js"),
  () => import("./ui-kit/display.js"),
  () => import("./ui-kit/data.js"),
  () => import("./ui-kit/charts.js"),
];

function UiKit() {
  const { t } = useT();
  const [sections, setSections] = useState(null);
  useEffect(() => {
    let alive = true;
    Promise.all(SECTIONS.map((load) => load())).then((modules) => alive && setSections(modules.map((module) => module.default)));
    return () => {
      alive = false;
    };
  }, []);
  return html`<div class="uikit stack" data-ready=${sections ? "true" : "false"}>
    <${PageHeader} title=${t("uikit.title")} subtitle=${t("uikit.subtitle")} breadcrumbs=${[{ label: t("shell.nav.system"), href: "/system" }, { label: t("uikit.title") }]}
      actions=${html`<${Button} variant="primary" icon="check">${t("uikit.primary")}<//>`} meta=${html`<${StatusBadge} status="info" />`} />
    ${(sections || []).map((Section, index) => html`<${Section} key=${index} />`)}
    <${ToastHost} />
  </div>`;
}

export { UiKit };
export default UiKit;

/**
 * Renders the page into `root` with a minimal service set (no API, no router).
 * @param catalog the merged catalog of `locale` (the snapshot's /c/<id>/i18n/<locale>.json)
 * @returns a function that unmounts the page
 */
export function mountUiKit(root, { catalog = {}, locale = "en-US" } = {}) {
  const services = createServices({ api: {}, cache: createQueryCache(), i18n: createI18n({ locale, catalog }), formatters: createFormatters(locale), toasts: createToasts(), prefs: createPrefsStore(createStorage()) });
  root.replaceChildren?.();
  render(html`<${ServicesContext.Provider} value=${services}><main id="main"><${UiKit} /></main><//>`, root);
  return () => render(null, root);
}
