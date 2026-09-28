/**
 * html.mjs: markdown -> Intercom HTML, Intercom HTML -> markdown, and HTML inspection.
 *
 * THE INTERCOM RULES THIS ENCODES (learned on a live Help Center, not from docs)
 *   1. SPACING. Intercom adds no vertical space between blocks sent through the API. The fix is an
 *      empty `<p class="no-margin"></p>` between every pair of top-level blocks, which is what
 *      Intercom's own editor emits for a blank line.
 *   2. HEADINGS. Intercom normalises every heading level to its own style; send <h2>.
 *   3. TABLES. Intercom wraps a plain <table> in its own container; send plain markup.
 *   4. DOUBLE TITLE. `title` is the page header, so a leading `# Title` in the body is stripped.
 *   5. PRESERVE WHAT WE CANNOT EXPRESS. A line that starts with an HTML block tag (<iframe>, <div>,
 *      <video>, <figure>, ...) is passed through untouched, with a warning. Embeds are never
 *      stripped; the importer does the same in reverse.
 */
import { basename } from "node:path";

export const SPACER = '<p class="no-margin"></p>';

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, "&quot;");

export function inline(text, ctx) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_m, c) => `\u0000${codes.push(`<code>${escapeHtml(c)}</code>`) - 1}\u0000`);
  // Inline raw HTML the converter does not model (e.g. <kbd>, <span>) survives untouched.
  const raws = [];
  s = s.replace(/<\/?[a-zA-Z][^<>]*>/g, (m) => `\u0001${raws.push(m) - 1}\u0001`);
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, target) => link(label, target, ctx));
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/(?<![*\w])\*([^*\n]+?)\*(?!\w)/g, "<i>$1</i>");
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i) => raws[Number(i)]);
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
}

function link(label, target, ctx) {
  if (/^(https?:|mailto:|#)/i.test(target)) return `<a href="${target}">${label}</a>`;
  const slug = basename(target.replace(/#.*$/, "")).replace(/\.md$/i, "");
  const hit = ctx?.urlBySlug?.get(slug);
  if (hit) return `<a href="${hit}">${label}</a>`;
  ctx?.warn?.(`internal link "${target}" is not a published article yet; kept the label, dropped the link`);
  return label;
}

const HTML_BLOCK = /^\s*<(iframe|div|figure|video|audio|embed|object|section|aside|details|summary|table|p|ul|ol|blockquote|pre|img|h[1-6]|hr|br|center|script|style)\b/i;

export function blocksFromMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const blocks = [];
  const isBreak = (l) => l.trim() === "" || /^#{1,6}\s/.test(l) || /^\s*```/.test(l) || HTML_BLOCK.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { i++; continue; }

    if (HTML_BLOCK.test(line)) {
      // Raw HTML block: keep every line until a blank line, untouched.
      const raw = [];
      while (i < lines.length && lines[i].trim() !== "") raw.push(lines[i++]);
      blocks.push({ type: "raw", html: raw.join("\n") });
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1] ?? "")) {
      const header = line;
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ type: "heading", level: h[1].length, text: h[2].trim() }); i++; continue; }

    const listType = /^\s*[-*+]\s+/.test(line) ? "ul" : /^\s*\d+[.)]\s+/.test(line) ? "ol" : null;
    if (listType) {
      const re = listType === "ul" ? /^\s*[-*+]\s+/ : /^\s*\d+[.)]\s+/;
      const items = [];
      while (i < lines.length && !isBreak(lines[i])) {
        if (re.test(lines[i])) items.push(lines[i].replace(re, ""));
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      blocks.push({ type: listType, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, "").trim());
      blocks.push({ type: "quote", text: q.join(" ") });
      continue;
    }
    const para = [];
    while (i < lines.length && !isBreak(lines[i])) para.push(lines[i++].trim());
    blocks.push({ type: "p", text: para.join(" ") });
  }
  return blocks;
}

const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

export function blocksToHtml(blocks, ctx) {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "raw":
          ctx?.warn?.(`raw HTML block kept as-is (${b.html.slice(0, 40).replace(/\n/g, " ")}...). Check it renders on Intercom.`);
          return b.html;
        case "heading": return `<h2>${inline(b.text, ctx)}</h2>`;
        case "p": return `<p class="no-margin">${inline(b.text, ctx)}</p>`;
        case "quote": return `<blockquote><p class="no-margin">${inline(b.text, ctx)}</p></blockquote>`;
        case "code": return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
        case "ul":
        case "ol": return `<${b.type}>${b.items.map((it) => `<li><p class="no-margin">${inline(it, ctx)}</p></li>`).join("")}</${b.type}>`;
        case "table": {
          const head = cells(b.header).map((c) => `<th>${inline(c, ctx)}</th>`).join("");
          const body = b.rows.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c, ctx)}</td>`).join("")}</tr>`).join("");
          return `<table><tr>${head}</tr>${body}</table>`;
        }
        default: return "";
      }
    })
    .filter(Boolean)
    .join(`${SPACER}\n`);
}

export const stripLeadingH1 = (body) => body.trim().replace(/^#[ \t]+.+(?:\r?\n)+/, "");

export function toIntercomHtml(body, ctx) {
  return blocksToHtml(blocksFromMarkdown(stripLeadingH1(body)), ctx);
}

// ── inspecting Intercom HTML ────────────────────────────────────────────────────────────────
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", apos: "'" };
export const decode = (s) => String(s).replace(/&(amp|lt|gt|quot|#39|nbsp|apos);/g, (_m, e) => ENTITIES[e]).replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));

/** Visible text of an HTML body, one line per block, for word counts, similarity and diffs. */
export function htmlToText(html) {
  return decode(
    String(html ?? "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|h[1-6]|li|tr|blockquote|pre|div|table|ul|ol)>/gi, "\n")
      .replace(/<\/?(b|strong|i|em|u|s|code|kbd|a|span|sup|sub|mark|small|abbr)\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export const wordCount = (html) => (htmlToText(html).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

/** Every href in the body. */
export function extractLinks(html) {
  const out = [];
  const re = /<a\b[^>]*?href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html ?? "")))) out.push({ href: decode(m[1]), text: htmlToText(m[2]) });
  return out;
}

/** Article id from an Intercom help-center or API link, e.g. /en/articles/123-some-slug. */
export function articleIdFromHref(href) {
  const m = /\/articles\/(\d+)(?:[-/?#]|$)/.exec(String(href));
  return m ? m[1] : null;
}

export const hasEmbeds = (html) => /<(iframe|video|embed|object|img)\b/i.test(String(html ?? ""));

// ── Intercom HTML -> markdown (for importing a live article to edit it) ─────────────────────
/** Replace each OUTERMOST <tag>...</tag> of the given names (nesting-aware) using fn. */
function stashBalanced(s, tags, fn) {
  const open = new RegExp(`<(${tags.join("|")})\\b[^>]*>`, "i");
  let out = "";
  let rest = s;
  for (;;) {
    const m = open.exec(rest);
    if (!m) return out + rest;
    const tag = m[1].toLowerCase();
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    re.lastIndex = m.index;
    let depth = 0, end = -1, t;
    while ((t = re.exec(rest))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { end = t.index + t[0].length; break; }
    }
    if (end < 0) return out + rest; // unbalanced: leave it for the generic rules
    out += rest.slice(0, m.index) + fn(rest.slice(m.index, end));
    rest = rest.slice(end);
  }
}

/**
 * Lossless where it matters: text, headings, lists, links, bold/italic, code, tables and images
 * become markdown; ANY element it does not model (iframes, videos, callouts, custom divs) is kept
 * as a raw HTML block, which the publisher passes back through untouched. Spacer paragraphs are
 * dropped because the publisher re-inserts them.
 */
export function htmlToMarkdown(html, warn = () => {}) {
  let s = String(html ?? "").replace(/\r\n/g, "\n");
  s = s.replace(/<p class="no-margin">\s*<\/p>/gi, "\n").replace(/<p>\s*<\/p>/gi, "\n");
  const keep = [];
  const stash = (m) => { warn(`kept an element the converter cannot express as raw HTML: ${m.slice(0, 50).replace(/\s+/g, " ")}...`); return `\n\n\u0002${keep.push(m.trim()) - 1}\u0002\n\n`; };
  s = stashBalanced(s, ["div", "figure", "section", "aside", "details"], stash); // outermost first
  s = s.replace(/<(iframe|video|audio|object|embed|script)\b[\s\S]*?(<\/\1>|\/>)/gi, stash);
  const inl = (x) => decode(
    x.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, "**$2**")
      .replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, "*$2*")
      .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
      .replace(/<img\b[^>]*?src="([^"]*)"[^>]*?(?:alt="([^"]*)")?[^>]*>/gi, (_m, src, alt) => `![${alt ?? ""}](${src})`)
      .replace(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<(?!\/?(kbd|span|sup|sub|u|s)\b)[^>]+>/g, ""),
  ).replace(/\s+/g, " ").trim();
  s = s.replace(/<pre>\s*<code>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, c) => `\n\n\`\`\`\n${decode(c)}\n\`\`\`\n\n`);
  s = s.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_m, t) => `\n\n## ${inl(t)}\n\n`);
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, t) => {
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => inl(c[1]).replace(/\|/g, "\\|")));
    if (!rows.length) return "";
    const head = `| ${rows[0].join(" | ")} |`;
    const sep = `|${rows[0].map(() => "---").join("|")}|`;
    return `\n\n${[head, sep, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`)].join("\n")}\n\n`;
  });
  s = s.replace(/<(ul|ol)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, type, items) => {
    let n = 0;
    const lis = [...items.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((li) => `${type === "ol" ? `${++n}.` : "-"} ${inl(li[1])}`);
    return `\n\n${lis.join("\n")}\n\n`;
  });
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, q) => `\n\n> ${inl(q)}\n\n`);
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, p) => `\n\n${inl(p)}\n\n`);
  s = s.replace(/<img\b[^>]*>/gi, (m) => `\n\n${inl(m)}\n\n`);
  s = s.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  s = s.replace(/<\/?(?:span|font)[^>]*>/gi, "");
  for (let guard = 0; /\u0002\d+\u0002/.test(s) && guard < 10; guard++) s = s.replace(/\u0002(\d+)\u0002/g, (_m, i) => keep[Number(i)]);
  return s.split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
