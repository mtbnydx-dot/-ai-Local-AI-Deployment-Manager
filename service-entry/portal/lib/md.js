// The docs' markdown renderer (05 §12.1). It is escape-first: the source is
// parsed into a small tree of text nodes (headings, paragraphs, lists, fenced
// code, inline code, bold and links) and nothing else, so raw HTML in a
// document is only ever text. Pages render the tree through Preact, which
// escapes every string; renderHtml() serialises the same tree with the same
// escaping for tests and for non-Preact callers. Links must be https:// or a
// site-relative path; anything else (javascript:, data:, http:) loses its
// link and keeps its label.

const HEADING_RE = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,})\s*([A-Za-z0-9_+-]*)\s*$/;
const BULLET_RE = /^\s{0,3}[-*]\s+(.*)$/;
const ORDERED_RE = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const CONTINUATION_RE = /^\s{2,}\S/;
const MAX_LINK_LENGTH = 2048;

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** The href a link may carry: an https:// URL or a site-relative path; otherwise "". */
export function safeHref(value) {
  const href = String(value ?? "").trim();
  if (!href || href.length > MAX_LINK_LENGTH || /[\s<>"'`\\\u0000-\u001f]/.test(href)) return "";
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (href.startsWith("#")) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" && url.hostname ? href : "";
  } catch {
    return "";
  }
}

/** "Rate limits & quotas" -> "rate-limits-quotas"; text without ASCII letters gives "". */
export function slugify(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// Inline text -> nodes: `code`, **bold**, [label](href). Everything else is text.
export function parseInline(text) {
  const source = String(text ?? "");
  const nodes = [];
  let plain = "";
  const flush = () => {
    if (plain) nodes.push({ type: "text", text: plain });
    plain = "";
  };
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "`") {
      const end = source.indexOf("`", index + 1);
      if (end > index + 1) {
        flush();
        nodes.push({ type: "code", text: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    } else if (ch === "*" && source[index + 1] === "*") {
      const end = source.indexOf("**", index + 2);
      if (end > index + 2) {
        flush();
        nodes.push({ type: "strong", children: parseInline(source.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    } else if (ch === "[") {
      const close = source.indexOf("](", index + 1);
      const end = close > index ? source.indexOf(")", close + 2) : -1;
      if (close > index && end > close) {
        const label = source.slice(index + 1, close);
        const href = safeHref(source.slice(close + 2, end));
        flush();
        if (href) nodes.push({ type: "link", href, external: !href.startsWith("/") && !href.startsWith("#"), children: parseInline(label) });
        else nodes.push(...parseInline(label));
        index = end + 1;
        continue;
      }
    }
    plain += ch;
    index += 1;
  }
  flush();
  return nodes;
}

/** Markdown text -> blocks: heading, paragraph, list and code. Never throws. */
export function parseMarkdown(source) {
  const lines = String(source ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  const used = new Set();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s{0,3}${fence[1]}\`*\\s*$`).test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // the closing fence (an unterminated block runs to the end)
      blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      let id = slugify(heading[2]) || `section-${blocks.length + 1}`;
      while (used.has(id)) id = `${id}-x`;
      used.add(id);
      blocks.push({ type: "heading", level: heading[1].length, id, children: parseInline(heading[2]) });
      index += 1;
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    const ordered = bullet ? null : ORDERED_RE.exec(line);
    if (bullet || ordered) {
      const pattern = bullet ? BULLET_RE : ORDERED_RE;
      const items = [];
      while (index < lines.length) {
        const match = pattern.exec(lines[index]);
        if (!match) break;
        const parts = [match[1]];
        index += 1;
        while (index < lines.length && CONTINUATION_RE.test(lines[index]) && !pattern.test(lines[index])) {
          parts.push(lines[index].trim());
          index += 1;
        }
        items.push(parseInline(parts.join(" ")));
      }
      blocks.push({ type: "list", ordered: Boolean(ordered), items });
      continue;
    }
    const parts = [];
    while (index < lines.length && lines[index].trim() && !FENCE_RE.test(lines[index]) && !HEADING_RE.test(lines[index]) && !BULLET_RE.test(lines[index]) && !ORDERED_RE.test(lines[index])) {
      parts.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(parts.join(" ")) });
  }
  return blocks;
}

function inlineHtml(nodes) {
  return nodes
    .map((node) => {
      if (node.type === "code") return `<code>${escapeHtml(node.text)}</code>`;
      if (node.type === "strong") return `<strong>${inlineHtml(node.children)}</strong>`;
      if (node.type === "link") {
        const rel = node.external ? ' rel="noopener noreferrer" target="_blank"' : "";
        return `<a href="${escapeHtml(node.href)}"${rel}>${inlineHtml(node.children)}</a>`;
      }
      return escapeHtml(node.text);
    })
    .join("");
}

/** Markdown text -> an HTML string in which every source character is escaped. */
export function renderHtml(source) {
  return parseMarkdown(source)
    .map((block) => {
      if (block.type === "heading") return `<h${block.level} id="${escapeHtml(block.id)}">${inlineHtml(block.children)}</h${block.level}>`;
      if (block.type === "paragraph") return `<p>${inlineHtml(block.children)}</p>`;
      if (block.type === "list") {
        const tag = block.ordered ? "ol" : "ul";
        return `<${tag}>${block.items.map((item) => `<li>${inlineHtml(item)}</li>`).join("")}</${tag}>`;
      }
      const lang = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : "";
      return `<pre><code${lang}>${escapeHtml(block.text)}</code></pre>`;
    })
    .join("\n");
}
