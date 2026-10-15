// Renders the tree lib/md.js parses. Every string goes through Preact as a text
// node, so a document can never inject markup; links were already limited to
// https:// and site paths by the parser.

import { html } from "../lib/html.js";
import { parseMarkdown } from "../lib/md.js";
import { CodeBlock } from "./code-block.js";

function Inline({ nodes }) {
  return nodes.map((node) => {
    if (node.type === "code") return html`<code>${node.text}</code>`;
    if (node.type === "strong") return html`<strong><${Inline} nodes=${node.children} /></strong>`;
    if (node.type === "link") {
      return node.external
        ? html`<a href=${node.href} target="_blank" rel="noopener noreferrer"><${Inline} nodes=${node.children} /></a>`
        : html`<a href=${node.href}><${Inline} nodes=${node.children} /></a>`;
    }
    return node.text;
  });
}

function Block({ block, copyLabel }) {
  if (block.type === "heading") {
    const Tag = `h${Math.min(block.level, 4)}`;
    return html`<${Tag} id=${block.id}><${Inline} nodes=${block.children} /></${Tag}>`;
  }
  if (block.type === "paragraph") return html`<p><${Inline} nodes=${block.children} /></p>`;
  if (block.type === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return html`<${Tag}>${block.items.map((item) => html`<li><${Inline} nodes=${item} /></li>`)}</${Tag}>`;
  }
  return html`<${CodeBlock} code=${block.text} language=${block.lang} label=${copyLabel} />`;
}

/** Markdown({ source, copyLabel }): the document, or a given parsed `blocks` list. */
export function Markdown({ source, blocks, copyLabel }) {
  const list = blocks || parseMarkdown(source);
  return html`<div class="prose">${list.map((block) => html`<${Block} block=${block} copyLabel=${copyLabel} />`)}</div>`;
}
