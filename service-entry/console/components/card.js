// Card (07 §4.4): a titled <section>; the heading names the region.

import { h, html } from "../ui/html.js";
import { HeadingLevelContext } from "../ui/context.js";
import { useId } from "../ui/vendor.js";

// tone danger|flat; level is the title's heading level.
export function Card({ title, actions, tone, level = 2, id, testid, children }) {
  const auto = useId();
  const titleId = `${id || auto}-title`;
  const toneClass = tone === "danger" ? " card-danger" : tone === "flat" ? " card-flat" : "";
  return html`<section id=${id} class=${`card${toneClass}`} aria-labelledby=${title ? titleId : undefined} data-testid=${testid || "card.root"}>
    ${title || actions ? html`<div class="card-header">
      ${title ? h(`h${level}`, { id: titleId, class: "card-title", "data-testid": "card.title" }, title) : null}
      <span class="spacer"></span>
      ${actions ? html`<div class="row-nowrap">${actions}</div>` : null}
    </div>` : null}
    <${HeadingLevelContext.Provider} value=${level + 1}>${children}<//>
  </section>`;
}
