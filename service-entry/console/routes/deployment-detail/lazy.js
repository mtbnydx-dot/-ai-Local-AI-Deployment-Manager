// Loads a heavy tab of the deployment detail page on first use (07 §11: a
// route module keeps its own static imports under 60 KB). The tab modules sit
// beside this file and arrive when their tab is shown.

import { useT } from "../../ui/hooks.js";
import { h, html } from "../../ui/html.js";
import { useEffect, useState } from "../../ui/vendor.js";

/**
 * Renders `module[name]` with `props` once `load()` has resolved; nothing
 * while it loads, a short message if the module cannot be fetched.
 * @param load () => import("…")
 */
export function LazyView({ load, name = "default", ...props }) {
  const { t } = useT();
  const [state, setState] = useState({ Component: null, failed: false });
  useEffect(() => {
    let alive = true;
    setState({ Component: null, failed: false });
    load().then(
      (module) => alive && setState({ Component: module[name] || null, failed: !module[name] }),
      () => alive && setState({ Component: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [name]);
  if (state.failed) return h("p", { class: "field-error", role: "alert" }, t("deploy.lazy.failed"));
  return state.Component ? h(state.Component, props) : html`<p class="muted" aria-busy="true">…</p>`;
}
