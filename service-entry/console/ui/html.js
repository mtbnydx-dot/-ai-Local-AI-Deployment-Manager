// htm bound to Preact's h (07 C1): components write html`<div>…</div>`
// templates and need no build step.

import { Fragment, h, htm, render } from "./vendor.js";

export const html = htm.bind(h);
export { Fragment, h, render };
