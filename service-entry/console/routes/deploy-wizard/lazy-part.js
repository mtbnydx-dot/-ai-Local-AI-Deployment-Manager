// A part of a wizard step that loads on demand (07 §11: a route module's own
// static imports stay under 60 KB). `loader` is `() => import("./part.js")`;
// the part's default export is drawn with `props`. `id` names the part in
// test ids and re-loads it when it changes.

import { Skeleton } from "../../components/skeleton.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useState } from "../../ui/vendor.js";

export function LazyPart({ id, loader, props }) {
  const { t } = useT();
  const [state, setState] = useState({ id: "", Component: null, failed: false });
  useEffect(() => {
    let alive = true;
    loader().then(
      (module) => alive && setState({ id, Component: module.default, failed: false }),
      () => alive && setState({ id, Component: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [id]);
  if (state.failed && state.id === id) return html`<p class="muted" data-testid=${`wizard.part-failed.${id}`}>${t("models.wizard.pendingBody")}</p>`;
  if (!state.Component || state.id !== id) return html`<div aria-busy="true" data-testid=${`wizard.part-loading.${id}`}><${Skeleton} shape="line" rows=${3} /></div>`;
  const Component = state.Component;
  return html`<${Component} ...${props} />`;
}
