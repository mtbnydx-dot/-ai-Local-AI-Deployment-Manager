// The footer: the brand, a pointer to the status page and the build commit.

import { html } from "../lib/html.js";
import { usePortal } from "../lib/context.js";
import { pickText } from "../lib/i18n.js";

export function Footer() {
  const { t, lang, config } = usePortal();
  const brand = pickText(config.brand, lang) || t("brand.fallback");
  const build = config.commit || (config.buildId ? String(config.buildId).slice(0, 12) : "");
  return html`<footer class="site-footer">
    <div class="container footer-row">
      <span>${brand}</span>
      <a href="/status">${t("footer.status")}</a>
      <a href="/docs/privacy">${t("footer.privacy")}</a>
      ${build ? html`<span class="footer-build">${t("footer.build")} <code>${build}</code></span>` : null}
    </div>
  </footer>`;
}
