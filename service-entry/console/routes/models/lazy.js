// A component loaded on first render (07 §11 keeps a route module's own static
// imports under 60 KB, so the parts of a page that are not always shown load
// when they are first needed). `from` is `() => import("./x.js")`, `name` the
// export to render; the other props pass through.

import { Skeleton } from "../../components/skeleton.js";
import { html } from "../../ui/html.js";
import { useEffect, useState } from "../../ui/vendor.js";

export function Lazy({ from, name, ...props }) {
  const [Component, setComponent] = useState(null);
  useEffect(() => {
    let alive = true;
    from().then((module) => alive && setComponent(() => module[name]), () => {});
    return () => {
      alive = false;
    };
  }, []);
  return Component ? html`<${Component} ...${props} />` : html`<div aria-busy="true"><${Skeleton} shape="line" rows=${3} /></div>`;
}
