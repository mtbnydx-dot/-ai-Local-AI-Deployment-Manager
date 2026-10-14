// MarkdownViewer (07 §4.4, §10): renders lib/markdown.js's token tree as
// VNodes. There is no HTML string and no raw HTML node, so hostile README or
// conversation text is inert. External links open in a new tab with
// rel="noopener noreferrer"; remote images become a placeholder (they would
// reveal the viewer's address and load third-party content).

import { parseMarkdown, resolveImage, resolveLink } from "../lib/markdown.js";
import { useT } from "../ui/hooks.js";
import { h, html } from "../ui/html.js";
import { useMemo } from "../ui/vendor.js";

function currentOrigin() {
  try {
    return globalThis.location?.origin || "";
  } catch {
    return "";
  }
}

function Inline({ nodes, ctx }) {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "code":
        return html`<code key=${index} class="md-code-inline">${node.text}</code>`;
      case "em":
        return html`<em key=${index}><${Inline} nodes=${node.children} ctx=${ctx} /></em>`;
      case "strong":
        return html`<strong key=${index}><${Inline} nodes=${node.children} ctx=${ctx} /></strong>`;
      case "del":
        return html`<del key=${index}><${Inline} nodes=${node.children} ctx=${ctx} /></del>`;
      case "br":
        return html`<br key=${index} />`;
      case "link": {
        const target = resolveLink(node.href, ctx);
        if (!target) return html`<${Inline} key=${index} nodes=${node.children} ctx=${ctx} />`;
        return html`<a key=${index} href=${target.href} title=${node.title || undefined} data-testid="markdown.link"
          rel=${target.external ? "noopener noreferrer" : undefined} target=${target.external ? "_blank" : undefined}>
          <${Inline} nodes=${node.children} ctx=${ctx} /></a>`;
      }
      case "image": {
        const src = resolveImage(node.src, { ...ctx, allow: ctx.allowImages });
        if (!src) {
          return html`<span key=${index} class="md-image-blocked" data-testid="markdown.image-blocked" title=${ctx.blockedLabel}>${node.alt || ctx.blockedLabel}</span>`;
        }
        return html`<img key=${index} class="md-image" src=${src} alt=${node.alt} title=${node.title || undefined} loading="lazy" referrerpolicy="no-referrer" data-testid="markdown.image" />`;
      }
      default:
        return null;
    }
  });
}

function Cells({ cells, tag, align, ctx }) {
  return cells.map((cell, index) => h(tag, { key: index, scope: tag === "th" ? "col" : undefined, class: align[index] ? `md-align-${align[index]}` : undefined }, html`<${Inline} nodes=${cell} ctx=${ctx} />`));
}

function Blocks({ nodes, ctx }) {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "heading":
        return h(`h${Math.min(6, Math.max(1, node.level + ctx.headingOffset))}`, { key: index, class: "md-heading" }, html`<${Inline} nodes=${node.children} ctx=${ctx} />`);
      case "paragraph":
        return html`<p key=${index}><${Inline} nodes=${node.children} ctx=${ctx} /></p>`;
      case "blockquote":
        return html`<blockquote key=${index}><${Blocks} nodes=${node.children} ctx=${ctx} /></blockquote>`;
      case "list":
        return h(node.ordered ? "ol" : "ul", { key: index, start: node.ordered && node.start !== 1 ? node.start : undefined },
          node.items.map((item, at) => html`<li key=${at}><${Blocks} nodes=${item.children} ctx=${ctx} /></li>`));
      case "code":
        return html`<pre key=${index} class="md-code" tabindex="0" data-testid="markdown.code"><code data-language=${node.lang || undefined}>${node.text}</code></pre>`;
      case "hr":
        return html`<hr key=${index} />`;
      case "table":
        return html`<div key=${index} class="table-wrap md-table" tabindex="0" role="region" aria-label=${ctx.tableLabel} data-testid="markdown.table">
          <table class="table">
            <thead><tr><${Cells} cells=${node.head} tag="th" align=${node.align} ctx=${ctx} /></tr></thead>
            <tbody>${node.rows.map((row, at) => html`<tr key=${at}><${Cells} cells=${row} tag="td" align=${node.align} ctx=${ctx} /></tr>`)}</tbody>
          </table>
        </div>`;
      default:
        return null;
    }
  });
}

// source markdown text; baseHref resolves relative links and images;
// allowImages "same-origin" | "none"; headingOffset shifts # to h2 by default.
export function MarkdownViewer({ source, baseHref, allowImages = "same-origin", headingOffset = 1, testid }) {
  const { t } = useT();
  const tree = useMemo(() => parseMarkdown(source), [source]);
  const ctx = { baseHref, origin: currentOrigin(), allowImages, headingOffset, blockedLabel: t("common.md.imageBlocked"), tableLabel: t("common.md.table") };
  return html`<div class="markdown" data-testid=${testid || "markdown.root"}>
    <${Blocks} nodes=${tree.children} ctx=${ctx} />
    ${tree.truncated ? html`<p class="muted small" role="note" data-testid="markdown.truncated">${t("common.md.truncated")}</p>` : null}
  </div>`;
}
