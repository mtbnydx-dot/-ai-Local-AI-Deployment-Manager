// Loads a heavy part of an Observability page on first use (07 §11: a route
// module keeps its own static imports under 60 KB). The chart component and
// the Legacy statistics card arrive when a panel shows them.

import { useT } from "../../ui/hooks.js";
import { h, html } from "../../ui/html.js";
import { useEffect, useState } from "../../ui/vendor.js";

/**
 * Renders `module[name]` with `props` once `load()` has resolved; a skeleton
 * line while it loads, a short message if the module cannot be fetched.
 * @param load () => import("…")
 */
export function LazyView({ load, name = "default", ...props }) {
  const { t } = useT();
  const [state, setState] = useState({ Component: null, failed: false });
  useEffect(() => {
    let alive = true;
    load().then(
      (module) => alive && setState({ Component: module[name] || null, failed: !module[name] }),
      () => alive && setState({ Component: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [name]);
  if (state.failed) return html`<p class="field-error" role="alert">${t("obs.lazy.failed")}</p>`;
  return state.Component ? h(state.Component, props) : html`<p class="muted" aria-busy="true">…</p>`;
}

export const loadChart = () => import("../../components/time-series-chart.js");
export const loadLegacy = () => import("./legacy.js");
