// htm bound to Preact's h: components write html`<div>…</div>` and need no
// build step. Preact and htm come from the import map (the one vendor tree).

import { Fragment, h, render } from "preact";
import htm from "htm";

export const html = htm.bind(h);
export { Fragment, h, render };
