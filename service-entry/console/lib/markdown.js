// Markdown to a token tree (07 §4.4 MarkdownViewer, §10, §13.1
// markdown.golden.test.js). Pure: no DOM, no I/O. The output is data, and
// components/markdown-viewer.js renders it as VNodes, so there is no HTML
// string anywhere and raw HTML in the source stays plain text.
//
// Supported: ATX and setext headings, paragraphs, block quotes, ordered and
// bullet lists (nested), fenced and indented code, rules, GFM tables, code
// spans, emphasis, strong, strikethrough, links, images, autolinks and hard
// breaks. Anything else is text.
//
// Nodes (every one has a `type`; there is deliberately no "html" type):
//   block:  heading{level,children} paragraph{children} blockquote{children}
//           list{ordered,start,items:[{children}]} code{lang,text} hr
//           table{align,head:[cells],rows:[[cells]],truncated}
//   inline: text{text} code{text} em|strong|del{children}
//           link{href,title,children} image{src,alt,title} br
// A link or image whose URL fails safeUrl() (lib/url.js) is dropped: the link
// keeps its text and the image keeps its alt text.
//
// Hostile input is bounded: the source, a paragraph, nesting depth, table
// size and the total node count all have caps, and `truncated` says when one
// of them cut the result.

import { safeUrl } from "./url.js";

export const LIMITS = Object.freeze({
  maxChars: 1_000_000,
  maxInlineChars: 8000,
  maxBlockDepth: 8,
  maxInlineDepth: 6,
  maxNodes: 60_000,
  maxTableRows: 500,
  maxTableColumns: 32,
});

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const PUNCTUATION = /[!-/:-@[-`{-~]/;

const isBlank = (line) => line.trim() === "";
const indentOf = (line) => /^ */.exec(line)[0].length;

// safeUrl() plus: an HTML character reference in a URL ("&#106;avascript:") is never a link.
function linkTarget(value) {
  return /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(String(value)) ? null : safeUrl(value);
}

function text(value) {
  return { type: "text", text: value };
}

// ---- inline ---------------------------------------------------------------

function findClosingBracket(source, from) {
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") index += 1;
    else if (char === "`") {
      const run = /^`+/.exec(source.slice(index))[0];
      const close = source.indexOf(run, index + run.length);
      if (close > 0) index = close + run.length - 1;
      else index += run.length - 1;
    } else if (char === "[") depth += 1;
    else if (char === "]") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

/** `(destination "title")` starting at `from` (the "("); returns { href, title, end } or null. */
function parseDestination(source, from) {
  let index = from + 1;
  while (/[ \t\n]/.test(source[index] || "")) index += 1;
  let href = "";
  if (source[index] === "<") {
    const close = source.indexOf(">", index);
    if (close < 0 || source.slice(index, close).includes("\n")) return null;
    href = source.slice(index + 1, close);
    index = close + 1;
  } else {
    let depth = 0;
    const start = index;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") index += 2;
      else if (/\s/.test(char)) break;
      else if (char === "(") {
        depth += 1;
        index += 1;
      } else if (char === ")") {
        if (depth === 0) break;
        depth -= 1;
        index += 1;
      } else index += 1;
    }
    href = source.slice(start, index);
  }
  while (/[ \t\n]/.test(source[index] || "")) index += 1;
  let title = "";
  const quote = source[index];
  if (quote === "\"" || quote === "'" || quote === "(") {
    const closer = quote === "(" ? ")" : quote;
    let cursor = index + 1;
    while (cursor < source.length && source[cursor] !== closer) cursor += source[cursor] === "\\" ? 2 : 1;
    if (cursor >= source.length) return null;
    title = source.slice(index + 1, cursor).replace(/\\(.)/g, "$1");
    index = cursor + 1;
    while (/[ \t\n]/.test(source[index] || "")) index += 1;
  }
  if (source[index] !== ")") return null;
  return { href: href.replace(/\\([!-/:-@[-`{-~])/g, "$1"), title, end: index + 1 };
}

function parseInline(source, ctx, depth = 0) {
  if (source.length > LIMITS.maxInlineChars || depth > LIMITS.maxInlineDepth) {
    ctx.truncated = source.length > LIMITS.maxInlineChars ? true : ctx.truncated;
    return source ? [text(source)] : [];
  }
  const out = [];
  let buffer = "";
  const add = (node) => {
    const last = out[out.length - 1];
    if (node.type === "text" && last?.type === "text") last.text += node.text;
    else {
      out.push(node);
      ctx.nodes += 1;
    }
  };
  const flush = () => {
    if (buffer) {
      add(text(buffer));
      buffer = "";
    }
  };
  const push = (node) => {
    flush();
    add(node);
  };
  let index = 0;
  while (index < source.length && ctx.nodes < LIMITS.maxNodes) {
    const char = source[index];
    if (char === "\\" && index + 1 < source.length && PUNCTUATION.test(source[index + 1])) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }
    if (char === "\\" && source[index + 1] === "\n") {
      push({ type: "br" });
      index += 2;
      continue;
    }
    if (char === "\n") {
      if (/ {2,}$/.test(buffer)) {
        buffer = buffer.replace(/ +$/, "");
        push({ type: "br" });
      } else buffer += "\n";
      index += 1;
      continue;
    }
    if (char === "`") {
      const run = /^`+/.exec(source.slice(index))[0];
      const close = source.indexOf(run, index + run.length);
      if (close > 0 && source[close + run.length] !== "`") {
        let code = source.slice(index + run.length, close).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        push({ type: "code", text: code });
        index = close + run.length;
        continue;
      }
      buffer += run;
      index += run.length;
      continue;
    }
    if (char === "<") {
      const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(source.slice(index, index + 2100));
      if (auto) {
        const href = linkTarget(auto[1]);
        if (href) push({ type: "link", href, title: "", children: [text(auto[1])] });
        else buffer += auto[0];
        index += auto[0].length;
        continue;
      }
    }
    if (char === "[" || (char === "!" && source[index + 1] === "[")) {
      const image = char === "!";
      const open = image ? index + 1 : index;
      const close = findClosingBracket(source, open + 1);
      if (close > 0 && source[close + 1] === "(") {
        const target = parseDestination(source, close + 1);
        if (target) {
          const inner = source.slice(open + 1, close);
          const href = linkTarget(target.href);
          if (image) {
            if (href) push({ type: "image", src: href, alt: plainText(inner), title: target.title });
            else if (inner) buffer += plainText(inner);
          } else {
            const children = parseInline(inner, ctx, depth + 1);
            if (href) push({ type: "link", href, title: target.title, children });
            else for (const child of children) push(child);
          }
          index = target.end;
          continue;
        }
      }
      buffer += char;
      index += 1;
      continue;
    }
    if (char === "*" || char === "_" || char === "~") {
      const run = /^(\*+|_+|~+)/.exec(source.slice(index))[0];
      const width = char === "~" ? (run.length >= 2 ? 2 : 0) : Math.min(run.length, 2);
      const before = source[index - 1] || " ";
      const intraword = char === "_" && /[\p{L}\p{N}]/u.test(before);
      if (width && !intraword && !/\s/.test(source[index + width] || " ")) {
        const marker = char.repeat(width);
        let close = index + width;
        let found = -1;
        while ((close = source.indexOf(marker, close)) >= 0) {
          const prev = source[close - 1];
          const next = source[close + width];
          const closes = !/\s/.test(prev) && prev !== "\\" && (char !== "_" || !/[\p{L}\p{N}]/u.test(next || " ")) && next !== char;
          if (closes && close > index + width) {
            found = close;
            break;
          }
          close += width;
        }
        if (found > 0) {
          const type = char === "~" ? "del" : width === 2 ? "strong" : "em";
          push({ type, children: parseInline(source.slice(index + width, found), ctx, depth + 1) });
          index = found + width;
          continue;
        }
      }
      buffer += run;
      index += run.length;
      continue;
    }
    buffer += char;
    index += 1;
  }
  if (index < source.length) ctx.truncated = true;
  flush();
  return out;
}

/** The text of a source with no inline markup parsed (image alt text). */
function plainText(source) {
  return source.replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
}

// ---- blocks ---------------------------------------------------------------

function splitRow(line) {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells = [];
  let cell = "";
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\\" && body[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (body[index] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += body[index];
  }
  cells.push(cell.trim());
  return cells;
}

function startsBlock(line, nextLine) {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = ITEM.exec(line);
  if (item && item[3] !== undefined && (!/^\d/.test(item[2]) || item[2].startsWith("1"))) return true;
  return Boolean(nextLine !== undefined && line.includes("|") && TABLE_DELIMITER.test(nextLine) && nextLine.includes("-") && (nextLine.includes("|") || line.includes("|")));
}

function parseList(lines, from, ctx, depth) {
  const first = ITEM.exec(lines[from]);
  const ordered = /^\d/.test(first[2]);
  const marker = ordered ? first[2].slice(-1) : first[2];
  const items = [];
  let index = from;
  while (index < lines.length && ctx.nodes < LIMITS.maxNodes) {
    const match = ITEM.exec(lines[index]);
    if (!match || /^\d/.test(match[2]) !== ordered || (ordered ? match[2].slice(-1) : match[2]) !== marker) break;
    const contentIndent = Math.max(match[1].length + match[2].length + 1, 2);
    const itemLines = [match[3] || ""];
    index += 1;
    while (index < lines.length) {
      const line = lines[index];
      if (isBlank(line)) {
        let peek = index + 1;
        while (peek < lines.length && isBlank(lines[peek])) peek += 1;
        if (peek < lines.length && indentOf(lines[peek]) >= contentIndent) {
          itemLines.push("");
          index += 1;
          continue;
        }
        break;
      }
      if (indentOf(line) >= contentIndent) {
        itemLines.push(line.slice(contentIndent));
        index += 1;
        continue;
      }
      const sibling = ITEM.exec(line);
      if (sibling || startsBlock(line)) break;
      if (isBlank(itemLines[itemLines.length - 1])) break;
      itemLines.push(line.trim());
      index += 1;
    }
    ctx.nodes += 1;
    items.push({ children: depth >= LIMITS.maxBlockDepth ? plainBlocks(itemLines.join("\n"), ctx) : parseBlocks(itemLines, ctx, depth + 1) });
    while (index < lines.length && isBlank(lines[index]) && ITEM.test(lines[index + 1] || "")) index += 1;
  }
  const start = ordered ? Number.parseInt(first[2], 10) : 1;
  return { node: { type: "list", ordered, start, items }, next: index };
}

function plainBlocks(source, ctx) {
  ctx.truncated = true;
  return source.trim() ? [{ type: "paragraph", children: [text(source.trim())] }] : [];
}

function parseTable(lines, from, ctx) {
  const head = splitRow(lines[from]);
  const align = splitRow(lines[from + 1]).map((spec) => (spec.startsWith(":") && spec.endsWith(":") ? "center" : spec.endsWith(":") ? "right" : spec.startsWith(":") ? "left" : null));
  if (head.length !== align.length) return null;
  const columns = Math.min(head.length, LIMITS.maxTableColumns);
  let truncated = head.length > columns;
  const cell = (value) => parseInline(value, ctx, 1);
  const rows = [];
  let index = from + 2;
  while (index < lines.length && !isBlank(lines[index]) && !FENCE.test(lines[index]) && !QUOTE.test(lines[index])) {
    if (rows.length >= LIMITS.maxTableRows) {
      truncated = true;
      while (index < lines.length && !isBlank(lines[index])) index += 1;
      break;
    }
    const cells = splitRow(lines[index]);
    if (cells.length > LIMITS.maxTableColumns) truncated = true;
    rows.push(Array.from({ length: columns }, (_, column) => cell(cells[column] || "")));
    index += 1;
    if (ctx.nodes >= LIMITS.maxNodes) break;
  }
  if (truncated) ctx.truncated = true;
  return { node: { type: "table", align: align.slice(0, columns), head: head.slice(0, columns).map(cell), rows, truncated }, next: index };
}

function parseBlocks(lines, ctx, depth = 0) {
  const out = [];
  let index = 0;
  while (index < lines.length && ctx.nodes < LIMITS.maxNodes) {
    const line = lines[index];
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const closer = new RegExp(`^ {0,3}${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},}[ \\t]*$`);
      const body = [];
      index += 1;
      while (index < lines.length && !closer.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      ctx.nodes += 1;
      out.push({ type: "code", lang: /^[\w+#.-]{1,32}$/.test(fence[2]) ? fence[2] : "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      ctx.nodes += 1;
      out.push({ type: "heading", level: heading[1].length, children: parseInline((heading[2] || "").trim(), ctx) });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      ctx.nodes += 1;
      out.push({ type: "hr" });
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        inner.push(lines[index].replace(/^ {0,3}> ?/, ""));
        index += 1;
      }
      ctx.nodes += 1;
      out.push({ type: "blockquote", children: depth >= LIMITS.maxBlockDepth ? plainBlocks(inner.join("\n"), ctx) : parseBlocks(inner, ctx, depth + 1) });
      continue;
    }
    if (/^( {4}|\t)/.test(line)) {
      const body = [];
      while (index < lines.length && (/^( {4}|\t)/.test(lines[index]) || (isBlank(lines[index]) && /^( {4}|\t)/.test(lines[index + 1] || "")))) {
        body.push(lines[index].replace(/^( {4}|\t)/, ""));
        index += 1;
      }
      ctx.nodes += 1;
      out.push({ type: "code", lang: "", text: body.join("\n") });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const { node, next } = parseList(lines, index, ctx, depth);
      out.push(node);
      index = next;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && TABLE_DELIMITER.test(lines[index + 1]) && lines[index + 1].includes("-")) {
      const table = parseTable(lines, index, ctx);
      if (table) {
        ctx.nodes += 1;
        out.push(table.node);
        index = table.next;
        continue;
      }
    }
    // A paragraph runs to a blank line or the next block start; a setext underline turns it into a heading.
    const body = [line.trimStart()];
    index += 1;
    let level = 0;
    while (index < lines.length && !isBlank(lines[index])) {
      const setext = SETEXT.exec(lines[index]);
      if (setext) {
        level = setext[1][0] === "=" ? 1 : 2;
        index += 1;
        break;
      }
      if (startsBlock(lines[index], lines[index + 1])) break;
      body.push(lines[index].trimStart());
      index += 1;
    }
    const children = parseInline(body.join("\n"), ctx);
    ctx.nodes += 1;
    out.push(level ? { type: "heading", level, children } : { type: "paragraph", children });
  }
  if (index < lines.length) ctx.truncated = true;
  return out;
}

/**
 * @param source markdown text (anything else is read as empty)
 * @returns {{ type: "root", children: object[], truncated: boolean }}
 */
export function parseMarkdown(source) {
  let input = typeof source === "string" ? source : "";
  const ctx = { nodes: 0, truncated: false };
  if (input.length > LIMITS.maxChars) {
    input = input.slice(0, LIMITS.maxChars);
    ctx.truncated = true;
  }
  const lines = input.replace(/\r\n?/g, "\n").replace(/\u0000/g, "�").split("\n");
  const children = parseBlocks(lines, ctx);
  return { type: "root", children, truncated: ctx.truncated };
}

// ---- URL policy -------------------------------------------------------------

function parseUrl(value, base) {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/**
 * Where a link goes. `href` has passed safeUrl() already (the parser drops
 * the rest); this resolves a relative one against `baseHref` and says whether
 * it leaves `origin`. `#` and `?` links stay as written.
 * @returns {{ href: string, external: boolean } | null}
 */
export function resolveLink(href, { baseHref, origin } = {}) {
  const safe = safeUrl(href);
  if (!safe) return null;
  if (safe.startsWith("#")) return { href: safe, external: false };
  const absolute = /^https?:/i.test(safe);
  const base = parseUrl(baseHref || "/", origin || "https://console.invalid");
  const url = parseUrl(safe, base);
  if (!url || !/^https?:$/.test(url.protocol)) return null;
  const external = Boolean(origin) ? url.origin !== origin : absolute;
  if (external) return { href: url.href, external };
  return { href: absolute || baseHref ? `${url.pathname}${url.search}${url.hash}` : safe, external };
}

/**
 * Whether an image may load: only "same-origin" images (relative or on
 * `origin`) when `allow` is "same-origin"; nothing when it is "none". Remote
 * README images would leak the viewer's address, so they are never loaded.
 * @returns {string|null} the URL to load, or null for the placeholder
 */
export function resolveImage(src, { baseHref, origin, allow = "same-origin" } = {}) {
  if (allow === "none") return null;
  const resolved = resolveLink(src, { baseHref, origin });
  if (!resolved || resolved.external || resolved.href.startsWith("#")) return null;
  if (!origin && /^https?:/i.test(resolved.href)) return null;
  return resolved.href;
}
