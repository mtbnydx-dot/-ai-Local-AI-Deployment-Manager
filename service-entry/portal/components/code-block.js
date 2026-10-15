// A code sample with a copy button. The text is rendered as a Preact text node
// (escaped); `label` names what is copied, for assistive technology.

import { html } from "../lib/html.js";
import { CopyButton } from "./copy-button.js";

export function CodeBlock({ code, language = "", label }) {
  return html`<figure class="code-block">
    <figcaption class="code-head">
      <span class="code-lang">${language}</span>
      <${CopyButton} text=${code} label=${label} />
    </figcaption>
    <pre tabindex="0"><code>${code}</code></pre>
  </figure>`;
}
