// Loads a heavy part of an Access page on first use (07 §11: a route module
// keeps its own static imports under 60 KB). The key drawer, the share card
// and the usage charts are separate modules that arrive when they are shown.

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
  if (state.failed) return html`<p class="field-error" role="alert">${t("access.lazy.failed")}</p>`;
  return state.Component ? h(state.Component, props) : null;
}
