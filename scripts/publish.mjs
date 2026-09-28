#!/usr/bin/env node
/**
 * publish.mjs: publish markdown help articles to an Intercom Help Center.
 *
 * Zero dependencies. Node 18+ (uses global fetch).
 *
 * WHAT IT DOES
 *   - Walks an articles directory (default ./help-articles/articles), reads each .md file's
 *     frontmatter, converts the body to Intercom-ready HTML, and CREATES or UPDATES the article:
 *       * no `intercom_id` in frontmatter  -> POST /articles, then writes the new id back
 *       * `intercom_id` present            -> PUT /articles/{id} (never a duplicate)
 *     The source file path is the identity. The id written back into the file is what makes the
 *     next run an update instead of a second copy.
 *   - Resolves `collection:` and `section:` frontmatter BY NAME against the live Help Center.
 *     In Intercom's API a section is just a collection with a `parent_id`.
 *   - Regenerates a parity ledger (PUBLISHED.md) listing every synced article.
 *   - `--parity` compares the ledger side (local files with ids) against what is really on
 *     Intercom, read-only, and reports drift in both directions.
 *
 * THE INTERCOM GOTCHAS THIS HANDLES (learned on a live Help Center, not from docs)
 *   1. SPACING. Intercom does NOT add vertical space between blocks you send it. A heading lands
 *      flush against the paragraph above it. The fix is an explicit empty
 *      `<p class="no-margin"></p>` between EVERY pair of top-level blocks, which is what
 *      Intercom's own editor emits for a blank line. This script always inserts it.
 *   2. HEADINGS. Intercom normalises any heading level you send to its own house style. Do not
 *      fight it; this script sends <h2> for every markdown heading.
 *   3. TABLES. Intercom wraps a plain <table> in its own styled container. Send plain markup;
 *      do not hand-copy its inline styles.
 *   4. DOUBLE TITLE. Intercom renders `title` as the page header, so a leading `# Title` in the
 *      body would show the title twice. The first H1 is stripped from the body (the file keeps it).
 *   5. PAGINATION. /help_center/collections returns a page at a time. A single-page read silently
 *      drops later collections and sections, which then error as "not found". This follows every page.
 *   6. BLAST RADIUS. Dry run is the default. Nothing is written anywhere without --publish, and a
 *      run that would write more than --max articles (default 20) refuses to start.
 *
 * ENV
 *   INTERCOM_API_TOKEN     required for anything that talks to Intercom (export only this key)
 *   INTERCOM_AUTHOR_ID     admin id to author new articles. If unset, taken from GET /me.
 *   INTERCOM_REGION        us (default) | eu | au
 *   INTERCOM_API_VERSION   default 2.11
 *
 * USAGE
 *   node publish.mjs                              # dry run over ./help-articles/articles
 *   node publish.mjs --dir docs/help/articles     # another articles folder
 *   node publish.mjs path/to/one.md               # only these files
 *   node publish.mjs --publish                    # actually create/update on Intercom
 *   node publish.mjs --publish --include-drafts   # also push `state: draft` files as Intercom drafts
 *   node publish.mjs --publish --create-sections  # create a missing section under its collection
 *   node publish.mjs --list-collections           # print collections and sections (read-only)
 *   node publish.mjs --parity                     # local vs Intercom drift report (read-only)
 *   node publish.mjs --html path/to/one.md        # print the converted HTML, no network at all
 *
 * TESTED VS NOT TESTED (be honest with yourself before relying on it)
 *   TESTED offline: frontmatter parsing, markdown -> HTML conversion (spacer rule, H1 strip,
 *     tables, lists, links, code, comments stripped), dry-run planning, ledger rendering.
 *   The conversion rules and the create/update-by-id shape are ported from a publisher that has
 *     run against a live Intercom Help Center (API 2.11).
 *   NOT TESTED in this generic form against a live workspace: --publish, --parity,
 *     --list-collections, --create-sections, the GET /me author fallback, EU/AU regions, and how
 *     Intercom renders <pre>, <blockquote> and <img> sent this way. Run --publish on ONE article
 *     first and open it in the Help Center before trusting a bulk run.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const DIR = opt("--dir", "help-articles/articles");
const LEDGER = opt("--ledger", join(dirname(DIR), "PUBLISHED.md"));
const MAX = Number(opt("--max", "20"));
const PUBLISH = flag("--publish");
const INCLUDE_DRAFTS = flag("--include-drafts");
const CREATE_SECTIONS = flag("--create-sections");
const LIST_COLLECTIONS = flag("--list-collections");
const PARITY = flag("--parity");
const HTML_ONLY = flag("--html");
const fileArgs = argv.filter((a) => a.endsWith(".md"));

const TOKEN = process.env.INTERCOM_API_TOKEN;
const VERSION = process.env.INTERCOM_API_VERSION || "2.11";
const BASE = { us: "https://api.intercom.io", eu: "https://api.eu.intercom.io", au: "https://api.au.intercom.io" }[
  (process.env.INTERCOM_REGION || "us").toLowerCase()
];
const SPACER = '<p class="no-margin"></p>';

// ── Intercom API ────────────────────────────────────────────────────────────────────────────
async function api(path, { method = "GET", body } = {}) {
  if (!TOKEN) throw new Error("INTERCOM_API_TOKEN is not set. Export only that key.");
  if (method !== "GET" && !PUBLISH) throw new Error(`refusing ${method} ${path}: dry run (pass --publish)`);
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Intercom-Version": VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

/** Follow `pages.next` to the end. A one-page read is how sections go missing. */
async function fetchAllCollections() {
  const all = [];
  let path = "/help_center/collections?per_page=100";
  while (path) {
    const res = await api(path);
    all.push(...(res.data ?? []));
    const next = res.pages?.next;
    path = typeof next === "string" ? next.replace(/^https:\/\/api(\.\w+)?\.intercom\.io/, "") : null;
  }
  return all;
}

/** Articles list paginates by page number. Handles both `next` links and total_pages. */
async function fetchAllArticles() {
  const all = [];
  for (let page = 1; page < 1000; page++) {
    const res = await api(`/articles?page=${page}&per_page=50`);
    const data = res.data ?? [];
    all.push(...data);
    const total = res.pages?.total_pages;
    if (!data.length || (total && page >= total) || (!total && !res.pages?.next)) break;
  }
  return all;
}

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ");

// ── frontmatter (tiny YAML subset: scalars and `- item` lists) ──────────────────────────────
export function parseFrontmatter(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fm = {};
  let listKey = null;
  for (const line of m[1].split("\n")) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) { fm[listKey].push(unquote(item[1].replace(/\s+#.*$/, ""))); continue; }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].replace(/\s+#.*$/, "").trim();
    if (value === "") { fm[kv[1]] = []; listKey = kv[1]; continue; }
    listKey = null;
    fm[kv[1]] = value === "null" ? null : unquote(value);
  }
  return { fm, body: m[2] };
}
const unquote = (s) => s.trim().replace(/^["'](.*)["']$/, "$1");

/** Set one frontmatter key in place. Never re-serialises the block, so nothing else moves. */
export function setFrontmatterKey(raw, key, value) {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(raw);
  if (!m) return raw;
  const line = `${key}: ${value === null ? "null" : JSON.stringify(String(value))}`;
  const re = new RegExp(`^${key}:.*$`, "m");
  const block = re.test(m[2]) ? m[2].replace(re, line) : m[2] + eol + line;
  return m[1] + block + m[3] + raw.slice(m[0].length);
}

// ── markdown -> Intercom HTML ───────────────────────────────────────────────────────────────
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, "&quot;");

export function inline(text, ctx) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_m, c) => `\u0000${codes.push(`<code>${escapeHtml(c)}</code>`) - 1}\u0000`);
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, target) => link(label, target, ctx));
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/(?<![*\w])\*([^*\n]+?)\*(?!\w)/g, "<i>$1</i>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
}

function link(label, target, ctx) {
  if (/^(https?:|mailto:|#)/i.test(target)) return `<a href="${target}">${label}</a>`;
  // Internal link to another article: "other.md", "./other.md", "../collection/other.md", "other".
  const slug = basename(target.replace(/#.*$/, "")).replace(/\.md$/i, "");
  const hit = ctx?.urlBySlug?.get(slug);
  if (hit) return `<a href="${hit}">${label}</a>`;
  ctx?.warn?.(`internal link "${target}" is not a published article yet; kept the label, dropped the link`);
  return label;
}

export function blocksFromMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const blocks = [];
  const isBreak = (l) => l.trim() === "" || /^#{1,6}\s/.test(l) || /^\s*```/.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { i++; continue; }

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
        else items[items.length - 1] += " " + lines[i].trim(); // wrapped continuation line
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
    .join(`${SPACER}\n`); // THE spacing fix. Intercom will not add this for you.
}

/** The page header is `title`; a leading body H1 would render the title twice. */
export const stripLeadingH1 = (body) => body.trim().replace(/^#[ \t]+.+(?:\r?\n)+/, "");

export function toIntercomHtml(body, ctx) {
  return blocksToHtml(blocksFromMarkdown(stripLeadingH1(body)), ctx);
}

// ── local articles ──────────────────────────────────────────────────────────────────────────
function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e.startsWith("_") || e.startsWith(".") || e === "README.md" || e === "PUBLISHED.md") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

function loadArticles(paths) {
  return paths.map((path) => {
    const raw = readFileSync(path, "utf8");
    const parsed = parseFrontmatter(raw);
    return { path, raw, fm: parsed?.fm ?? null, body: parsed?.body ?? "" };
  });
}

// ── ledger ──────────────────────────────────────────────────────────────────────────────────
export function renderLedger(articles) {
  const synced = articles.filter((a) => a.fm?.intercom_id).sort((x, y) => String(x.fm.title).localeCompare(String(y.fm.title)));
  const live = synced.filter((a) => a.fm.state === "published").length;
  const rows = synced.map((a) => {
    const where = a.fm.section ? `${a.fm.collection} › ${a.fm.section}` : a.fm.collection;
    const src = relative(process.cwd(), a.path).replace(/\\/g, "/");
    return `| ${a.fm.title} | ${where} | ${a.fm.state ?? "draft"} | ${a.fm.intercom_id} | \`${src}\` | ${a.fm.last_synced ?? ""} |`;
  });
  return [
    "<!-- GENERATED by publish.mjs. Do not hand-edit; re-run the publisher. -->",
    "",
    "# Help Center parity ledger",
    "",
    "Every article synced to Intercom, 1:1 with its source file. A file with no row here is not on",
    "Intercom. An Intercom article with no row here is drift: run `publish.mjs --parity`.",
    "",
    `**${synced.length} on Intercom** · ${live} live · ${synced.length - live} draft`,
    "",
    "| Article | Collection › Section | State | Intercom ID | Source | Last synced |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
async function main() {
  if (HTML_ONLY) {
    for (const a of loadArticles(fileArgs)) {
      console.log(toIntercomHtml(a.body, { warn: (w) => console.error(`! ${w}`) }));
    }
    return 0;
  }

  if (LIST_COLLECTIONS) {
    const cols = await fetchAllCollections();
    for (const c of cols.filter((c) => !c.parent_id)) {
      console.log(`${c.id}  ${c.name}`);
      for (const s of cols.filter((s) => String(s.parent_id) === String(c.id))) console.log(`   ${s.id}  › ${s.name}`);
    }
    return 0;
  }

  const all = loadArticles(walk(DIR));
  const urlBySlug = new Map(
    all.filter((a) => a.fm?.intercom_url).map((a) => [basename(a.path, ".md"), a.fm.intercom_url]),
  );

  if (PARITY) {
    const remote = await fetchAllArticles();
    const remoteIds = new Set(remote.map((r) => String(r.id)));
    const localIds = new Set(all.filter((a) => a.fm?.intercom_id).map((a) => String(a.fm.intercom_id)));
    const orphans = remote.filter((r) => !localIds.has(String(r.id)));
    const dangling = all.filter((a) => a.fm?.intercom_id && !remoteIds.has(String(a.fm.intercom_id)));
    console.log(`Intercom: ${remote.length} articles · local with ids: ${localIds.size}`);
    for (const r of orphans) console.log(`  ✗ on Intercom, no source file: ${r.id} "${r.title}" [${r.state}]`);
    for (const a of dangling) console.log(`  ✗ source file points at an id Intercom does not have: ${a.path} (${a.fm.intercom_id})`);
    if (!orphans.length && !dangling.length) console.log("  ✓ in parity");
    return orphans.length || dangling.length ? 1 : 0;
  }

  const targets = fileArgs.length ? loadArticles(fileArgs) : all;
  const plan = [];
  for (const a of targets) {
    if (!a.fm) { console.log(`  · skip ${a.path}: no frontmatter`); continue; }
    const missing = ["title", "collection"].filter((k) => !a.fm[k]);
    if (missing.length) { console.log(`  ✗ ${a.path}: missing ${missing.join(", ")}`); plan.push({ a, error: true }); continue; }
    const state = a.fm.state === "published" ? "published" : "draft";
    if (state === "draft" && !INCLUDE_DRAFTS) { console.log(`  · skip ${a.path}: state is not "published" (use --include-drafts)`); continue; }
    plan.push({ a, state, action: a.fm.intercom_id ? "UPDATE" : "CREATE" });
  }

  const writes = plan.filter((p) => !p.error);
  if (writes.length > MAX) {
    console.error(`Refusing: ${writes.length} articles would be written, above --max ${MAX}. Raise --max on purpose if you mean it.`);
    return 1;
  }

  let collections = null;
  if (TOKEN) collections = await fetchAllCollections();
  else if (PUBLISH) { console.error("INTERCOM_API_TOKEN is not set. Export only that key."); return 1; }
  else console.log("  (no INTERCOM_API_TOKEN: collections are not resolved in this dry run)\n");

  let authorId = process.env.INTERCOM_AUTHOR_ID ? Number(process.env.INTERCOM_AUTHOR_ID) : null;
  if (PUBLISH && !authorId) authorId = Number((await api("/me")).id);

  let ok = 0, errors = plan.filter((p) => p.error).length;
  for (const p of writes) {
    const { a, state, action } = p;
    const warnings = [];
    const html = toIntercomHtml(a.body, { urlBySlug, warn: (w) => warnings.push(w) });
    const where = a.fm.section ? `${a.fm.collection} › ${a.fm.section}` : a.fm.collection;

    let parentId = null;
    try {
      if (collections) parentId = await resolveParent(collections, a.fm.collection, a.fm.section);
    } catch (e) { console.log(`  ✗ ${a.path}: ${e.message}`); errors++; continue; }

    if (!PUBLISH) {
      console.log(`  [dry] ${action} "${a.fm.title}" -> ${where}${parentId ? ` (${parentId})` : ""} [${state}] ${html.length} chars`);
      for (const w of warnings) console.log(`        ! ${w}`);
      ok++;
      continue;
    }

    const payload = {
      title: a.fm.title,
      description: a.fm.description ?? "",
      body: html,
      author_id: authorId,
      state,
      parent_id: Number(parentId),
      parent_type: "collection",
    };
    try {
      const art = action === "UPDATE"
        ? await api(`/articles/${a.fm.intercom_id}`, { method: "PUT", body: payload })
        : await api("/articles", { method: "POST", body: payload });
      let raw = a.raw;
      raw = setFrontmatterKey(raw, "intercom_id", art.id ?? a.fm.intercom_id);
      if (art.url) raw = setFrontmatterKey(raw, "intercom_url", art.url);
      raw = setFrontmatterKey(raw, "last_synced", new Date().toISOString());
      writeFileSync(a.path, raw);
      Object.assign(a, loadArticles([a.path])[0]);
      for (const w of warnings) console.log(`        ! ${w}`);
      console.log(`  ${action === "CREATE" ? "+" : "↑"} ${action.toLowerCase()}d "${a.fm.title}" (id ${a.fm.intercom_id}) ${art.url ?? ""}`);
      ok++;
    } catch (e) {
      console.log(`  ✗ ${a.path}: ${e.message}`);
      errors++;
    }
  }

  if (PUBLISH) {
    writeFileSync(LEDGER, renderLedger(loadArticles(walk(DIR))));
    console.log(`\n  ledger written: ${LEDGER}`);
  } else {
    console.log(`\n  (dry run: nothing written. Ledger would list ${all.filter((a) => a.fm?.intercom_id).length} synced article(s).)`);
  }
  console.log(`\n[publish] ${ok} ${PUBLISH ? "written" : "planned"} · ${errors} errors`);
  return errors ? 1 : 0;
}

async function resolveParent(collections, collectionName, sectionName) {
  const top = collections.find((c) => !c.parent_id && norm(c.name) === norm(collectionName));
  if (!top) throw new Error(`collection "${collectionName}" not found on Intercom (see --list-collections)`);
  if (!sectionName) return String(top.id);
  const sec = collections.find((c) => String(c.parent_id) === String(top.id) && norm(c.name) === norm(sectionName));
  if (sec) return String(sec.id);
  if (!CREATE_SECTIONS || !PUBLISH) throw new Error(`section "${sectionName}" not found under "${collectionName}" (pass --create-sections with --publish to create it)`);
  const created = await api("/help_center/collections", { method: "POST", body: { name: sectionName, parent_id: Number(top.id) } });
  collections.push(created);
  console.log(`  + created section "${sectionName}" under "${collectionName}" (${created.id})`);
  return String(created.id);
}

// Run only when executed directly, so the converter can be imported by tests without publishing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
