// The site header: brand, the six pages and the language switch. Single row on
// a wide screen; the links wrap below the brand on a phone.

import { html } from "../lib/html.js";
import { usePortal } from "../lib/context.js";
import { navGroup } from "../lib/router.js";
import { pickText } from "../lib/i18n.js";
import { LangSwitch } from "./lang-switch.js";

export function Header({ route }) {
  const { t, lang, config } = usePortal();
  const active = navGroup(route.name);
  const items = [
    { id: "status", href: "/status", label: t("nav.status") },
    { id: "models", href: "/models", label: t("nav.models") },
    { id: "docs", href: "/docs", label: t("nav.docs") },
    ...(config.features?.playground === false ? [] : [{ id: "playground", href: "/playground", label: t("nav.playground") }]),
    { id: "me", href: "/me", label: t("nav.me") },
    { id: "announcements", href: "/announcements", label: t("nav.announcements") },
  ];
  const brand = pickText(config.brand, lang) || t("brand.fallback");
  return html`<header class="site-header">
    <div class="container header-row">
      <a class="brand" href="/" aria-label=${t("nav.home", { brand })}>${brand}</a>
      <nav class="site-nav" aria-label=${t("nav.label")}>
        <ul>
          ${items.map((item) => html`<li><a href=${item.href} aria-current=${active === item.id ? "page" : null}>${item.label}</a></li>`)}
        </ul>
      </nav>
      <${LangSwitch} />
    </div>
  </header>`;
}
