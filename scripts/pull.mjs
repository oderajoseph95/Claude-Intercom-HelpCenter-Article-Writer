#!/usr/bin/env node
/**
 * pull.mjs: bring a LIVE Intercom article into the repo as markdown, so it can be updated
 * instead of duplicated. Read-only against Intercom.
 *
 *   --id <id>          one article. If a local file already has this id, its frontmatter is kept
 *                      and the live body is written NEXT to it as <file>.remote.md for a diff,
 *                      never over your local edits (pass --replace to overwrite on purpose).
 *   --all              every article that has no local file yet (import an existing help center)
 *   --locale <code>    also write that translation as <slug>.<code>.md
 *
 * The body is converted HTML -> markdown. Anything the converter cannot express (embeds,
 * callouts, custom HTML) is kept as a raw HTML block and published back untouched.
 * The live HTML is saved to .help-center/base/<id>.html as the "last published" copy that the
 * publisher's 3-way drift view compares against.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs, main, env, toPosix } from "./lib/cli.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createClient, collectionPaths } from "./lib/intercom.mjs";
import { walkArticles, loadArticles, parseFrontmatter, setFrontmatterKey } from "./lib/articles.mjs";
import { htmlToMarkdown, htmlToText } from "./lib/html.mjs";
import { hash } from "./lib/text.mjs";
import { repoRel } from "./lib/features.mjs";
import { fail, report } from "./lib/messages.mjs";

const SPEC = { flags: ["--all", "--replace", "--quiet"], options: ["--id", "--locale", "--max"] };

export const slugify = (s) => String(s ?? "untitled").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "untitled";
const q = (v) => JSON.stringify(String(v ?? ""));
const toIso = (t) => (t == null ? null : new Date(typeof t === "number" && t < 1e12 ? t * 1000 : t).toISOString());

export function articleToMarkdown(art, { pathOf, workspace, locale, sourceRel }) {
  const content = locale ? art.translated_content?.[locale] : art;
  const warns = [];
  const md = htmlToMarkdown(content?.body ?? "", (w) => warns.push(w));
  const path = art.parent_id != null ? pathOf(art.parent_id).split(" › ") : [];
  const fm = [
    "---",
    `title: ${q(content?.title)}`,
    `description: ${q(content?.description)}`,
    locale ? `locale: ${q(locale)}` : `collection: ${q(path[0] ?? "")}`,
    locale ? `translation_of: ${q(sourceRel ?? art.id)}` : `section: ${q(path.slice(1).join(" › "))}`,
    `state: ${content?.state === "published" ? "published" : "draft"}`,
    "sources:",
    "  # add the code and strings files this article describes; the reviewer checks them",
    `intercom_id: ${q(art.id)}`,
    `intercom_url: ${q(content?.url ?? art.url)}`,
    `intercom_workspace: ${q(art.workspace_id ?? workspace ?? "")}`,
    ...(art.parent_id != null && !locale ? [`collection_id: ${q(art.parent_id)}`] : []),
    `remote_hash: ${q(hash(htmlToText(content?.body ?? "")))}`,
    `remote_updated_at: ${q(toIso(content?.updated_at ?? art.updated_at))}`,
    `last_synced: ${q(new Date().toISOString())}`,
    "---",
    "",
    `# ${content?.title ?? ""}`,
    "",
    md,
  ].join("\n");
  return { text: fm, warns };
}

export async function run(argv, deps = {}) {
  const a = parseArgs(argv, SPEC);
  if (a.flag("--help") || (!a.opt("--id") && !a.flag("--all"))) { console.log("usage: node pull.mjs --id <id> [--locale fr] [--replace] | --all [--max n]"); return a.flag("--help") ? 0 : 1; }
  const { config, root } = loadConfig(deps.root);
  const token = env("INTERCOM_API_TOKEN");
  if (!token && !deps.client) throw fail("IHC001");
  const client = deps.client ?? createClient({ token, region: env("INTERCOM_REGION", config.intercom.region), version: config.intercom.apiVersion, allowWrites: false, sleep: deps.sleep });
  const log = a.flag("--quiet") ? () => {} : (s) => console.log(s);
  const dir = resolve(root, config.articlesDir);
  const baseDir = resolve(root, config.outDir, "base");
  const collections = await client.fetchAllCollections();
  const { pathOf } = collectionPaths(collections);
  let me = null;
  try { me = await client.get("/me"); } catch { /* optional */ }
  const local = loadArticles(walkArticles(dir));
  const localById = new Map(local.filter((f) => f.fm?.intercom_id && !f.fm.translation_of).map((f) => [String(f.fm.intercom_id), f]));

  let ids;
  if (a.flag("--all")) {
    const list = await client.fetchAllArticles({ withBodies: false });
    ids = list.map((x) => String(x.id)).filter((id) => !localById.has(id));
    const max = Number(a.opt("--max", 500));
    if (ids.length > max) { log(`[pull] ${ids.length} articles have no local file; importing the first ${max} (--max)`); ids = ids.slice(0, max); }
  } else ids = [String(a.opt("--id"))];

  let n = 0;
  for (const id of ids) {
    let art;
    try { art = await client.get(`/articles/${id}`); }
    catch (e) { if (e.status === 404) { report("IHC034", { id, file: localById.get(id) ? repoRel(root, localById.get(id).path) : "(not in repo)" }); continue; } throw e; }
    const existing = localById.get(id);
    const collectionSlug = slugify(art.parent_id != null ? pathOf(art.parent_id).split(" › ")[0] : "unsorted");
    const target = existing ? existing.path : join(dir, collectionSlug, `${slugify(art.title)}.md`);
    let { text, warns } = articleToMarkdown(art, { pathOf, workspace: me?.app?.id_code });
    if (existing && a.flag("--replace")) {
      // keep the local frontmatter (sources, collection, state...); take Intercom's title, text and sync keys
      const fresh = parseFrontmatter(text);
      let raw = existing.raw;
      for (const k of ["title", "description", "intercom_url", "remote_hash", "remote_updated_at", "last_synced"]) raw = setFrontmatterKey(raw, k, fresh.fm[k] ?? "");
      const head = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw)[0];
      text = head + fresh.body;
    }
    let out = target;
    if (existing && !a.flag("--replace")) out = target.replace(/\.md$/, ".remote.md");
    else if (!existing && existsSync(target)) out = target.replace(/\.md$/, `-${id}.md`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, `${id}.html`), art.body ?? "");
    for (const w of warns) log(`  ! ${w}`);
    log(`  ↓ ${id} "${art.title}" -> ${toPosix(repoRel(root, out))}${existing && !a.flag("--replace") ? " (live copy beside your file; diff them, nothing overwritten)" : ""}`);
    n++;
    if (a.opt("--locale")) {
      const loc = a.opt("--locale");
      if (!art.translated_content?.[loc]) { log(`  · ${id}: no ${loc} translation on Intercom`); continue; }
      const t = articleToMarkdown(art, { pathOf, locale: loc, sourceRel: toPosix(repoRel(root, target)) });
      const tOut = target.replace(/\.md$/, `.${loc}.md`);
      writeFileSync(tOut, t.text);
      log(`  ↓ ${id} [${loc}] -> ${toPosix(repoRel(root, tOut))}`);
    }
  }
  log(`[pull] ${n} article(s) pulled. Add each one's code files to \`sources:\` before editing, so the reviewer can check it.`);
  return 0;
}

main(import.meta.url, run);
