#!/usr/bin/env node
/**
 * publish.mjs: publish markdown help articles to an Intercom Help Center, safely.
 *
 * Zero dependencies. Node 18+.
 *
 * WHAT IT DOES
 *   - Converts each article's markdown to Intercom-ready HTML (spacing fix, no double title,
 *     raw HTML and embeds preserved) and CREATES or UPDATES it:
 *       no `intercom_id` -> POST /articles, then writes id, url, workspace, hashes back to the file
 *       `intercom_id`    -> PUT /articles/{id}. Never a second copy.
 *   - Resolves `collection:` + `section:` by NAME at any depth ("A › B › C"), remembers the id so a
 *     renamed collection still resolves, and creates missing ones only when told to.
 *   - Publishes translations (`locale:` + `translation_of:`) into the source article's
 *     translated_content.
 *   - Applies an APPROVED collections plan (--create-collections --plan file): creates missing
 *     collections and sections, and moves articles.
 *
 * SAFETY (each one is exercised in selftest.mjs)
 *   - Dry run by default; prints the exact changes, including a text diff against the live article.
 *   - Real writes need an approved correction plan (publish.requireApprovedPlan in config).
 *   - A run that would write more than --max (default: config publish.cap, 20) refuses to start.
 *   - DRIFT: an article edited in the Intercom UI since the last sync is never overwritten silently.
 *     The run shows a 3-way view (last published / Intercom now / repo) and skips that article.
 *   - DELETED on Intercom: reported, never silently recreated (--recreate-missing to recreate).
 *   - OTHER WORKSPACE: a file published with another workspace's token is refused.
 *   - RESUMABLE: each file is written back the moment its write succeeds. If a run dies mid-way,
 *     re-running adopts anything already created (same title) instead of duplicating it.
 *   - It cannot delete anything. Archiving is `state: draft`; deleting is a human click.
 *
 * ENV
 *   INTERCOM_API_TOKEN       required for anything that talks to Intercom (export only this key)
 *   INTERCOM_AUTHOR_ID       admin id for new articles (else config intercom.authorId, else GET /me)
 *   INTERCOM_REGION          us | eu | au (else config intercom.region)
 *   INTERCOM_API_VERSION     default 2.11
 *   INTERCOM_HELP_CENTER_ID  only for workspaces with several help centers, when creating collections
 *
 * USAGE
 *   node publish.mjs                                  # dry run over the articles dir, with diffs
 *   node publish.mjs path/to/one.md                   # only these files
 *   node publish.mjs --publish path/to/one.md         # really write ONE, then open it on Intercom
 *   node publish.mjs --publish                        # then the rest (cap applies)
 *   node publish.mjs --publish --create-collections   # also create missing collections/sections
 *   node publish.mjs --create-collections --plan .help-center/help-center-collections.plan.json [--publish]
 *   node publish.mjs --list-collections               # print the tree, read-only
 *   node publish.mjs --parity                         # repo vs Intercom drift, read-only
 *   node publish.mjs --html path/to/one.md            # print converted HTML, no network
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs, main, env, toPosix } from "./lib/cli.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createClient, collectionPaths, norm, splitPath, IntercomError } from "./lib/intercom.mjs";
import { walkArticles, loadArticles, setFrontmatterKey } from "./lib/articles.mjs";
import { toIntercomHtml, htmlToText } from "./lib/html.mjs";
import { normTitle, diffLines, formatDiff, hasChanges, hash } from "./lib/text.mjs";
import { fail, report, reportError, apiCode, apiVars } from "./lib/messages.mjs";

const SPEC = {
  flags: ["--publish", "--include-drafts", "--create-sections", "--create-collections", "--list-collections", "--parity", "--html", "--recreate-missing", "--no-adopt", "--no-diff", "--quiet"],
  options: ["--dir", "--ledger", "--max", "--plan"],
  multi: ["--overwrite-drift"],
};

const toMs = (t) => (t == null ? null : typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t));
export const textHash = (html) => hash(htmlToText(html));

// ── ledger ──────────────────────────────────────────────────────────────────────────────────
export function renderLedger(articles, root = process.cwd()) {
  const synced = articles.filter((x) => x.fm?.intercom_id && !x.fm.translation_of).sort((x, y) => String(x.fm.title).localeCompare(String(y.fm.title)));
  const live = synced.filter((x) => x.fm.state === "published").length;
  const rows = synced.map((x) => {
    const where = x.fm.section ? `${x.fm.collection} › ${x.fm.section}` : x.fm.collection;
    return `| ${x.fm.title} | ${where} | ${x.fm.state ?? "draft"} | ${x.fm.intercom_id} | \`${toPosix(relative(root, x.path))}\` | ${x.fm.last_synced ?? ""} |`;
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

// ── collections ─────────────────────────────────────────────────────────────────────────────
/** Find a collection path; returns { id } or { missing, parentId, depth }. */
export function findPath(collections, segments) {
  let parent = null;
  for (let d = 0; d < segments.length; d++) {
    const hit = collections.find((c) => String(c.parent_id ?? "") === String(parent ?? "") && norm(c.name) === norm(segments[d]));
    if (!hit) return { missing: segments.slice(d), parentId: parent, depth: d };
    parent = String(hit.id);
  }
  return { id: parent };
}

const articlePath = (fm) => [...splitPath(fm.collection), ...splitPath(fm.section ?? "")];

/** Edited on Intercom since our last write? Compares a text hash first, then timestamps. */
export function detectDrift(fm, live) {
  if (fm.remote_hash) return textHash(live.body) !== fm.remote_hash ? "the text on Intercom changed since the last sync" : null;
  const synced = toMs(fm.remote_updated_at) ?? toMs(fm.last_synced);
  const updated = toMs(live.updated_at);
  if (synced && updated && updated - synced > 120000) return "Intercom's updated_at is later than the last sync";
  return null;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
export async function run(argv, deps = {}) {
  const a = parseArgs(argv, SPEC);
  if (a.flag("--help")) { console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith(" *")).join("\n")); return 0; }
  const { config, root } = loadConfig(deps.root);
  const DIR = resolve(root, a.opt("--dir", config.articlesDir));
  const LEDGER = resolve(root, a.opt("--ledger", join(dirname(a.opt("--dir", config.articlesDir)), "PUBLISHED.md")));
  const MAX = Number(a.opt("--max", config.publish.cap));
  const PUBLISH = a.flag("--publish");
  const CREATE_COLLECTIONS = a.flag("--create-collections");
  const CREATE_SECTIONS = a.flag("--create-sections") || CREATE_COLLECTIONS;
  const overwrite = new Set(a.multi("--overwrite-drift").flatMap((x) => x.split(",")).map((s) => s.trim()));
  const fileArgs = a.positionals.filter((p) => p.endsWith(".md")).map((p) => resolve(root, p));
  const log = a.flag("--quiet") ? () => {} : (s) => console.log(s);
  const token = env("INTERCOM_API_TOKEN");
  const region = env("INTERCOM_REGION", config.intercom.region);

  if (a.flag("--html")) {
    for (const f of loadArticles(fileArgs)) console.log(toIntercomHtml(f.body, { warn: (w) => console.error(`! ${w}`) }));
    return 0;
  }

  const client = deps.client ?? (token ? createClient({ token, region, version: env("INTERCOM_API_VERSION", config.intercom.apiVersion), allowWrites: PUBLISH, sleep: deps.sleep }) : null);

  if (a.flag("--list-collections")) {
    if (!client) throw fail("IHC001");
    const cols = await client.fetchAllCollections();
    const { pathOf } = collectionPaths(cols);
    for (const c of [...cols].sort((x, y) => pathOf(x.id).localeCompare(pathOf(y.id)))) {
      const depth = pathOf(c.id).split(" › ").length - 1;
      log(`${"   ".repeat(depth)}${c.id}  ${depth ? "› " : ""}${c.name}`);
    }
    return 0;
  }

  const all = loadArticles(walkArticles(DIR));

  if (a.flag("--parity")) {
    if (!client) throw fail("IHC001");
    const remote = await client.fetchAllArticles({ withBodies: false });
    const remoteIds = new Set(remote.map((r) => String(r.id)));
    const localIds = new Set(all.filter((x) => x.fm?.intercom_id && !x.fm.translation_of).map((x) => String(x.fm.intercom_id)));
    const orphans = remote.filter((r) => !localIds.has(String(r.id)));
    const dangling = all.filter((x) => x.fm?.intercom_id && !remoteIds.has(String(x.fm.intercom_id)));
    log(`Intercom: ${remote.length} articles · local with ids: ${localIds.size}`);
    for (const r of orphans) log(`  ✗ on Intercom, no source file: ${r.id} "${r.title}" [${r.state}]`);
    for (const x of dangling) log(`  ✗ source file points at an id Intercom does not have: ${toPosix(relative(root, x.path))} (${x.fm.intercom_id})`);
    if (!orphans.length && !dangling.length) log("  ✓ in parity");
    return orphans.length || dangling.length ? 1 : 0;
  }

  // Real writes need a plan a human approved.
  const planPath = resolve(root, a.opt("--plan", config.planFile));
  let adhocFiles = null;
  if (PUBLISH && (a.opt("--plan") || config.publish.requireApprovedPlan)) {
    if (!existsSync(planPath)) throw fail("IHC031", { path: toPosix(relative(root, planPath)) });
    let plan;
    try { plan = JSON.parse(readFileSync(planPath, "utf8")); } catch (e) { throw fail("IHC040", { path: planPath, detail: e.message }); }
    if (plan.approved !== true || !plan.approved_by) throw fail("IHC031", { path: toPosix(relative(root, planPath)) });
    // An ad-hoc plan approves exactly the files it lists, nothing else.
    if (plan.adhoc) adhocFiles = new Set((plan.items ?? []).map((i) => toPosix(relative(root, resolve(root, i.local_file ?? "")))));
  }

  if (!client && PUBLISH) throw fail("IHC001");
  if (!client) log("  (no INTERCOM_API_TOKEN: collections, drift and diffs are not checked in this dry run)\n");

  let me = null;
  if (client) { try { me = await client.get("/me"); } catch (e) { if (e.status === 401) throw e; } }
  const workspace = me?.app?.id_code ?? null;
  const collections = client ? await client.fetchAllCollections() : null;

  if (CREATE_COLLECTIONS && a.opt("--plan")) return applyCollectionsPlan({ planPath, client, collections, PUBLISH, MAX, log, root });

  const remoteList = client ? await client.fetchAllArticles({ withBodies: false }) : [];
  const urlBySlug = new Map(all.filter((x) => x.fm?.intercom_url).map((x) => [basename(x.path, ".md"), x.fm.intercom_url]));

  // ── plan every article before writing anything, so the cap covers the whole run ──
  const targets = fileArgs.length ? loadArticles(fileArgs) : all;
  const plan = [];
  let errors = 0;
  const missingPaths = new Map();
  for (const f of targets) {
    const rel = toPosix(relative(root, f.path));
    if (!f.fm) { log(`  · skip ${rel}: no frontmatter`); continue; }
    if (adhocFiles && !adhocFiles.has(rel)) { report("IHC046", { file: rel, plan: toPosix(relative(root, planPath)) }); errors++; continue; }
    const isTranslation = Boolean(f.fm.locale && f.fm.translation_of);
    const missing = (isTranslation ? ["title"] : ["title", "collection"]).filter((k) => !f.fm[k]);
    if (missing.length) { report("IHC038", { file: rel, fields: missing.join(", ") }); errors++; continue; }
    const state = f.fm.state === "published" ? "published" : "draft";
    if (state === "draft" && !a.flag("--include-drafts")) { log(`  · skip ${rel}: state is not "published" (use --include-drafts)`); continue; }
    if (f.fm.intercom_workspace && workspace && String(f.fm.intercom_workspace) !== String(workspace)) {
      report("IHC035", { file: rel, theirs: f.fm.intercom_workspace, ours: workspace }); errors++; continue;
    }
    const item = { f, rel, state, isTranslation, action: f.fm.intercom_id ? "UPDATE" : "CREATE" };
    if (!isTranslation && collections) {
      const segs = articlePath(f.fm);
      const found = findPath(collections, segs);
      if (found.id) item.parentId = found.id;
      else if (f.fm.collection_id && collections.some((c) => String(c.id) === String(f.fm.collection_id))) {
        item.parentId = String(f.fm.collection_id);
        report("IHC043", { old: segs.join(" › "), name: collectionPaths(collections).pathOf(f.fm.collection_id), file: rel });
      } else if (found.depth === 0 && !CREATE_COLLECTIONS) { report("IHC032", { name: segs[0] }); errors++; continue; }
      else if (found.depth > 0 && !CREATE_SECTIONS) { report("IHC033", { name: found.missing[0], parent: segs.slice(0, found.depth).join(" › ") }); errors++; continue; }
      else { item.createPath = segs; for (let d = found.depth + 1; d <= segs.length; d++) missingPaths.set(segs.slice(0, d).map(norm).join(" › "), segs.slice(0, d)); }
    }
    plan.push(item);
  }

  const writes = plan.length + missingPaths.size;
  if (writes > MAX) throw fail("IHC030", { count: writes, cap: MAX });

  let authorId = env("INTERCOM_AUTHOR_ID") ? Number(env("INTERCOM_AUTHOR_ID")) : config.intercom.authorId ? Number(config.intercom.authorId) : null;
  if (!authorId && me?.id) authorId = Number(me.id);
  if (PUBLISH && plan.length && !authorId) throw fail("IHC037");

  // translations go after their source articles, so a source created in this run has its id
  plan.sort((x, y) => Number(x.isTranslation) - Number(y.isTranslation));
  const baseDir = resolve(root, config.outDir, "base");
  let ok = 0;
  for (const p of plan) {
    const { f, rel, state } = p;
    const warnings = [];
    const html = toIntercomHtml(f.body, { urlBySlug, warn: (w) => warnings.push(w) });
    if (warnings.some((w) => w.startsWith("raw HTML"))) report("IHC044", { file: rel }, { withFix: false });
    try {
      if (p.isTranslation) { ok += await publishTranslation({ p, html, state, authorId, client, PUBLISH, all, root, log }); continue; }
      if (p.createPath && PUBLISH) p.parentId = await ensurePath(client, collections, p.createPath, log);
      const where = articlePath(f.fm).join(" › ");

      // CREATE: never a duplicate. Adopt an article with the same title if exactly one exists.
      if (p.action === "CREATE" && client && !a.flag("--no-adopt")) {
        const same = remoteList.filter((r) => normTitle(r.title) && normTitle(r.title) === normTitle(f.fm.title));
        if (same.length > 1) { report("IHC045", { title: f.fm.title, count: same.length, ids: same.map((s) => s.id).join(", ") }); errors++; continue; }
        if (same.length === 1) { report("IHC042", { title: f.fm.title, id: same[0].id }, { withFix: false }); p.action = "UPDATE"; p.adopted = String(same[0].id); }
      }
      let id = p.adopted ?? (f.fm.intercom_id ? String(f.fm.intercom_id) : null);

      // UPDATE: the article must still exist, and must not have been edited on Intercom since.
      let live = null;
      if (p.action === "UPDATE" && client) {
        try { live = await client.get(`/articles/${id}`); }
        catch (e) {
          if (e.status !== 404) throw e;
          if (!a.flag("--recreate-missing")) { report("IHC034", { id, file: rel }); errors++; continue; }
          log(`  ! ${rel}: article ${id} is gone on Intercom; --recreate-missing: creating it again`);
          p.action = "CREATE";
          id = null;
        }
        if (live && !p.adopted) {
          const drift = detectDrift(f.fm, live);
          if (drift && !overwrite.has(id)) {
            const basePath = join(baseDir, `${id}.html`);
            const baseText = existsSync(basePath) ? htmlToText(readFileSync(basePath, "utf8")) : "";
            log(`\n  3-way view for "${f.fm.title}" (${id}): ${drift}`);
            if (baseText) log(formatDiff(diffLines(baseText, htmlToText(live.body)), { labelA: "last published", labelB: "Intercom now (someone's edit)" }));
            else log("  (no saved copy of the last published version: comparing Intercom now with the repo)");
            log(formatDiff(diffLines(baseText || htmlToText(live.body), htmlToText(html)), { labelA: baseText ? "last published" : "Intercom now", labelB: "repo (what would be published)" }));
            report("IHC036", { id, file: rel }); errors++; continue;
          }
        }
      }

      const payload = { title: f.fm.title, description: f.fm.description ?? "", body: html, author_id: authorId, state };
      if (p.parentId) Object.assign(payload, { parent_id: Number(p.parentId), parent_type: "collection" });

      if (!PUBLISH) {
        log(`  [dry] ${p.action}${p.adopted ? " (adopt existing)" : ""} "${f.fm.title}" -> ${where}${p.parentId ? ` (${p.parentId})` : p.createPath ? " (collection will be created)" : ""} [${state}]`);
        if (live && !a.flag("--no-diff")) {
          const changed = ["title", "description", "state"].filter((k) => String(live[k] ?? "") !== String(payload[k] ?? ""));
          if (p.parentId && String(live.parent_id ?? "") !== String(p.parentId)) changed.push(`collection (${live.parent_id} -> ${p.parentId})`);
          const d = diffLines(htmlToText(live.body), htmlToText(html));
          log(`        fields changing: ${changed.length ? changed.join(", ") : "none"} · body: ${hasChanges(d) ? "changes below" : "unchanged"}`);
          if (hasChanges(d)) log(formatDiff(d, { labelA: "Intercom now", labelB: "after publish" }).replace(/^/gm, "      "));
        } else if (p.action === "CREATE") log(`        new article, ${htmlToText(html).split(/\s+/).filter(Boolean).length} words`);
        for (const w of warnings) log(`        ! ${w}`);
        ok++;
        continue;
      }

      const art = p.action === "UPDATE" ? await client.put(`/articles/${id}`, payload) : await client.post("/articles", payload);
      writeBack(f, art, { html, workspace, parentId: p.parentId, baseDir, fallbackId: id });
      for (const w of warnings) log(`        ! ${w}`);
      log(`  ${p.action === "CREATE" ? "+ created" : "↑ updated"} "${f.fm.title}" (id ${art.id ?? id}) ${art.url ?? ""}`);
      ok++;
    } catch (e) {
      if (e instanceof IntercomError) report(apiCode(e), { ...apiVars(e), what: `article ${f.fm.intercom_id ?? rel}` });
      else reportError(e);
      errors++;
      if (e.maybeApplied) break; // stop here; the re-run adopts whatever landed
    }
  }

  if (PUBLISH) {
    writeFileSync(LEDGER, renderLedger(loadArticles(walkArticles(DIR)), root));
    log(`\n  ledger written: ${toPosix(relative(root, LEDGER))}`);
  } else log("\n  (dry run: nothing written. Pass --publish to apply exactly the changes above.)");
  log(`\n[publish] ${ok} ${PUBLISH ? "written" : "planned"} · ${errors} errors`);
  return errors ? 1 : 0;
}

function writeBack(f, art, { html, workspace, parentId, baseDir, fallbackId }) {
  let raw = f.raw;
  const set = (k, v) => { raw = setFrontmatterKey(raw, k, v); };
  const id = art.id ?? fallbackId;
  set("intercom_id", id);
  if (art.url) set("intercom_url", art.url);
  const ws = art.workspace_id ?? workspace;
  if (ws) set("intercom_workspace", ws);
  if (parentId) set("collection_id", parentId);
  set("remote_hash", textHash(art.body ?? html));
  if (art.updated_at) set("remote_updated_at", new Date(toMs(art.updated_at)).toISOString());
  set("last_synced", new Date().toISOString());
  writeFileSync(f.path, raw);
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, `${id}.html`), art.body ?? html);
  Object.assign(f, loadArticles([f.path])[0]);
}

async function ensurePath(client, collections, segs, log) {
  let parent = null;
  for (const name of segs) {
    let hit = collections.find((c) => String(c.parent_id ?? "") === String(parent ?? "") && norm(c.name) === norm(name));
    if (!hit) {
      const body = { name };
      if (parent) body.parent_id = String(parent);
      if (env("INTERCOM_HELP_CENTER_ID")) body.help_center_id = Number(env("INTERCOM_HELP_CENTER_ID"));
      hit = await client.post("/help_center/collections", body);
      if (hit.parent_id === undefined) hit.parent_id = parent;
      collections.push(hit);
      log(`  + created ${parent ? "section" : "collection"} "${name}"${parent ? ` under ${parent}` : ""} (${hit.id})`);
    }
    parent = String(hit.id);
  }
  return parent;
}

async function publishTranslation({ p, html, state, authorId, client, PUBLISH, all, root, log }) {
  const { f, rel } = p;
  let target = String(f.fm.translation_of);
  if (!/^\d+$/.test(target)) {
    const want = toPosix(target).replace(/^\.\//, "");
    const src = all.find((x) => toPosix(relative(root, x.path)) === want || basename(x.path) === basename(want));
    target = src?.fm?.intercom_id ? String(src.fm.intercom_id) : null;
  }
  if (!target) throw fail("IHC041", { file: rel, target: f.fm.translation_of });
  const locale = String(f.fm.locale);
  if (!PUBLISH) { log(`  [dry] TRANSLATE "${f.fm.title}" -> article ${target} [${locale}, ${state}]`); return 1; }
  const content = { type: "article_content", title: f.fm.title, description: f.fm.description ?? "", body: html, author_id: authorId, state };
  const art = await client.put(`/articles/${target}`, { translated_content: { type: "article_translated_content", [locale]: content } });
  let raw = f.raw;
  raw = setFrontmatterKey(raw, "intercom_id", target);
  raw = setFrontmatterKey(raw, "last_synced", new Date().toISOString());
  writeFileSync(f.path, raw);
  log(`  ↑ translated "${f.fm.title}" (${locale}) on article ${target} ${art.url ?? ""}`);
  return 1;
}

async function applyCollectionsPlan({ planPath, client, collections, PUBLISH, MAX, log, root }) {
  if (!existsSync(planPath)) throw fail("IHC039", { path: planPath });
  let plan;
  try { plan = JSON.parse(readFileSync(planPath, "utf8")); } catch (e) { throw fail("IHC040", { path: planPath, detail: e.message }); }
  if (plan.kind !== "collections-plan") throw fail("IHC040", { path: planPath, detail: "not a collections plan (run plan-collections.mjs)" });
  if (plan.approved !== true || !plan.approved_by) throw fail("IHC031", { path: toPosix(relative(root, planPath)) });
  if (!client) throw fail("IHC001");

  const creates = [];
  const seen = new Set();
  for (const t of plan.tree) {
    for (let d = 1; d <= t.path.length; d++) {
      const sub = t.path.slice(0, d);
      const k = sub.map(norm).join(" › ");
      if (!seen.has(k) && !findPath(collections, sub).id) { seen.add(k); creates.push(sub); }
    }
  }
  const articles = await client.fetchAllArticles({ withBodies: false });
  const liveById = new Map(articles.map((x) => [String(x.id), x]));
  const moves = plan.moves.filter((m) => m.action === "MOVE" && liveById.has(String(m.article_id)));
  const total = creates.length + moves.length;
  if (total > MAX) throw fail("IHC030", { count: total, cap: MAX });

  log(`[collections] ${creates.length} to create, ${moves.length} moves (plan approved by ${plan.approved_by})`);
  let errors = 0;
  if (PUBLISH) for (const c of creates) await ensurePath(client, collections, c, log);
  else for (const c of creates) log(`  [dry] + ${c.join(" › ")}`);
  for (const m of moves) {
    const where = m.to.join(" › ");
    if (!PUBLISH) { log(`  [dry] MOVE "${m.title}" (${m.article_id}) ${m.from?.join(" › ") ?? "(no collection)"} -> ${where}`); continue; }
    const to = findPath(collections, m.to);
    if (!to.id) { report("IHC032", { name: where }); errors++; continue; }
    if (String(liveById.get(String(m.article_id)).parent_id ?? "") === String(to.id)) { log(`  = "${m.title}" already in ${where}`); continue; }
    try {
      await client.put(`/articles/${m.article_id}`, { parent_id: Number(to.id), parent_type: "collection" });
      log(`  → moved "${m.title}" (${m.article_id}) to ${where}`);
    } catch (e) { reportError(e); errors++; if (e.maybeApplied) break; }
  }
  if (!PUBLISH) log("\n  (dry run: nothing written. Pass --publish to apply.)");
  return errors ? 1 : 0;
}

main(import.meta.url, run);
