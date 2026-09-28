/**
 * articles.mjs: local markdown articles and their frontmatter.
 *
 * The frontmatter parser is a tiny YAML subset (scalars and `- item` lists), which is all an
 * article needs. `setFrontmatterKey` edits one key in place and never re-serialises the block,
 * so nothing else in the file moves.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

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

export function setFrontmatterKey(raw, key, value) {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(raw);
  if (!m) return raw;
  const line = `${key}: ${value === null ? "null" : JSON.stringify(String(value))}`;
  const re = new RegExp(`^${key}:.*$`, "m");
  const block = re.test(m[2]) ? m[2].replace(re, line) : m[2] + eol + line;
  return m[1] + block + m[3] + raw.slice(m[0].length);
}

/** Every .md article under dir, skipping _drafts, dotfiles, README.md and the ledger. */
export function walkArticles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e.startsWith("_") || e.startsWith(".") || e === "README.md" || e === "PUBLISHED.md") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walkArticles(p));
    else if (e.endsWith(".md") && !e.endsWith(".remote.md")) out.push(p);
  }
  return out;
}

export function loadArticles(paths) {
  return paths.map((path) => {
    const raw = readFileSync(path, "utf8");
    const parsed = parseFrontmatter(raw);
    return { path, raw, fm: parsed?.fm ?? null, body: parsed?.body ?? "" };
  });
}
