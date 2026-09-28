#!/usr/bin/env node
/**
 * audit.mjs: read the WHOLE Help Center, compare it with the code, and rank what is wrong.
 *
 * READ-ONLY BY CONSTRUCTION: the Intercom client is created with allowWrites: false, so any
 * POST/PUT throws before it leaves the machine. The selftest asserts zero writes.
 *
 * What it reads: every collection and section (any depth), every article with its body and
 * translations, across every page. What it compares against: the coverage manifest / features
 * source and the UI strings files in the repo, and the local articles folder.
 *
 * Output (in --out-dir, default .help-center/):
 *   snapshot.json            raw collections + articles (gitignored; the pre-write check reuses it)
 *   help-center-audit.json   every finding, machine-readable
 *   help-center-audit.md     the human report, ranked by impact
 *
 * Findings: uncovered-feature, empty, short, duplicate, near-duplicate, same-title-other-collection,
 * broken-link, links-to-draft, no-collection, draft, non-question-title, stale, orphan,
 * missing-translation, deleted-on-intercom, other-workspace, not-in-repo, empty-collection.
 *
 * USAGE
 *   node audit.mjs                       # fetch and audit (needs INTERCOM_API_TOKEN)
 *   node audit.mjs --snapshot file.json  # re-audit a saved snapshot, offline
 *   node audit.mjs --out-dir reports/
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, main, env, toPosix } from "./lib/cli.mjs";
import { loadConfig, ensureGitignore } from "./lib/config.mjs";
import { createClient, collectionPaths, norm } from "./lib/intercom.mjs";
import { walkArticles, loadArticles } from "./lib/articles.mjs";
import { discoverFeatures, matchFeatures, repoRel } from "./lib/features.mjs";
import { htmlToText, wordCount, extractLinks, articleIdFromHref, hasEmbeds } from "./lib/html.mjs";
import { normTitle, shingles, isQuestionTitle } from "./lib/text.mjs";
import { report, fail } from "./lib/messages.mjs";

const SPEC = { flags: ["--quiet", "--no-write"], options: ["--out-dir", "--snapshot", "--min-words", "--stale-days", "--region"] };

export const SEVERITY = {
  "uncovered-feature": 9, empty: 9, "broken-link": 8, "deleted-on-intercom": 7, duplicate: 7, "near-duplicate": 6,
  "no-collection": 6, "same-title-other-collection": 5, orphan: 5, "links-to-draft": 5, "other-workspace": 5,
  short: 4, stale: 3, "empty-collection": 3, "missing-translation": 2, "non-question-title": 2, draft: 2, "not-in-repo": 1,
};

const toMs = (t) => (t == null ? null : typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t));

export async function fetchSnapshot({ client, region }) {
  let me = null;
  try { me = await client.get("/me"); } catch { /* workspace name is nice-to-have */ }
  const collections = await client.fetchAllCollections();
  const articles = await client.fetchAllArticles();
  return {
    fetched_at: new Date().toISOString(),
    region,
    workspace: me?.app?.id_code ?? null,
    workspace_name: me?.app?.name ?? null,
    collections,
    articles,
  };
}

/** Locales that have real content in an article's translated_content. */
export function localesOf(a) {
  const out = new Set();
  if (a.title || a.body) out.add(a.default_locale ?? "en");
  const tc = a.translated_content;
  if (tc && typeof tc === "object") {
    for (const [k, v] of Object.entries(tc)) if (k !== "type" && v && typeof v === "object" && (v.body || v.title)) out.add(k);
  }
  return [...out];
}

export async function analyze({ snapshot, root, config, now = Date.now(), warn = () => {} }) {
  const minWords = Number(config.audit.minWords);
  const staleDays = Number(config.audit.staleDays);
  const threshold = Number(config.audit.nearDuplicate);
  const standard = new Set((config.audit.standardCollections ?? []).map(norm));

  const { byId, pathOf } = collectionPaths(snapshot.collections);
  const { features, source, stringsPaths } = await discoverFeatures({ root, config, warn });

  // local files
  const localFiles = loadArticles(walkArticles(resolve(root, config.articlesDir)));
  const localById = new Map();
  for (const f of localFiles) if (f.fm?.intercom_id) localById.set(String(f.fm.intercom_id), f);
  const exactFeatureByPath = new Map();
  for (const feat of features) for (const p of feat.articlePaths) {
    const k = toPosix(resolve(root, p));
    (exactFeatureByPath.get(k) ?? exactFeatureByPath.set(k, []).get(k)).push(feat.id);
  }

  const ids = new Set(snapshot.articles.map((a) => String(a.id)));
  const stateById = new Map(snapshot.articles.map((a) => [String(a.id), a.state]));
  const allLocales = new Set();
  for (const a of snapshot.articles) for (const l of localesOf(a)) allLocales.add(l);

  const findings = [];
  const add = (type, o) => {
    const published = o.state ? o.state === "published" : true;
    findings.push({ type, severity: SEVERITY[type], impact: SEVERITY[type] * (published ? 1 : 0.5), ...o });
  };

  const records = snapshot.articles.map((a) => {
    const id = String(a.id);
    const text = htmlToText(a.body);
    const words = wordCount(a.body);
    const parentId = a.parent_id ?? (Array.isArray(a.parent_ids) ? a.parent_ids[0] : null);
    const inCollection = parentId != null && (a.parent_type ?? "collection") === "collection" && byId.has(String(parentId));
    const collection_path = inCollection ? pathOf(parentId) : null;
    const links = extractLinks(a.body).map((l) => {
      const target = articleIdFromHref(l.href);
      return { href: l.href, text: l.text, target_id: target, ok: target ? ids.has(target) : null };
    });
    const local = localById.get(id);
    const localPath = local ? toPosix(resolve(local.path)) : null;
    const exact = localPath ? exactFeatureByPath.get(localPath) ?? [] : [];
    const matched = exact.length
      ? exact.map((fid) => ({ id: fid, score: 99, why: ["manifest cell points at this article's file"] }))
      : matchFeatures({ title: a.title, text }, features);
    return {
      id,
      title: a.title ?? "",
      state: a.state ?? "draft",
      url: a.url ?? null,
      collection_path,
      parent_id: parentId ?? null,
      updated_at: toMs(a.updated_at) ? new Date(toMs(a.updated_at)).toISOString() : null,
      words,
      has_embeds: hasEmbeds(a.body),
      locales: localesOf(a),
      links,
      local_file: local ? repoRel(root, local.path) : null,
      features: matched,
      _text: text,
    };
  });

  // per-article checks
  for (const r of records) {
    const base = { article_id: r.id, title: r.title, state: r.state, url: r.url, collection: r.collection_path };
    if (r.words === 0 && !r.has_embeds) add("empty", { ...base, message: "has no text" });
    else if (r.words < minWords) add("short", { ...base, message: `${r.words} words (minimum ${minWords})` });
    if (r.state === "draft") add("draft", { ...base, message: "is a draft, invisible to readers" });
    if (!r.collection_path) add("no-collection", { ...base, message: "is in no collection, so readers cannot browse to it" });
    if (!isQuestionTitle(r.title)) add("non-question-title", { ...base, message: "title is not a question a reader would search" });
    const updated = toMs(r.updated_at);
    if (updated && now - updated > staleDays * 864e5) add("stale", { ...base, message: `not updated in ${Math.floor((now - updated) / 864e5)} days` });
    for (const l of r.links) {
      if (l.target_id && !l.ok) add("broken-link", { ...base, message: `links to article ${l.target_id}, which does not exist`, evidence: { href: l.href } });
      else if (l.target_id && stateById.get(l.target_id) === "draft" && r.state === "published") add("links-to-draft", { ...base, message: `links to article ${l.target_id}, which is a draft`, evidence: { href: l.href } });
    }
    if (allLocales.size > 1) {
      const missing = [...allLocales].filter((l) => !r.locales.includes(l));
      if (missing.length && r.state === "published") add("missing-translation", { ...base, message: `no ${missing.join(", ")} translation` });
    }
    const isStandard = r.collection_path && standard.has(norm(r.collection_path.split(" › ")[0]));
    if (features.length && !r.features.length && !isStandard) add("orphan", { ...base, message: "matches no feature in the code: it may describe something removed or renamed" });
    const local = r.local_file && localById.get(r.id);
    if (local?.fm?.intercom_workspace && snapshot.workspace && local.fm.intercom_workspace !== snapshot.workspace) {
      add("other-workspace", { ...base, message: `local file ${r.local_file} records workspace ${local.fm.intercom_workspace}` });
    }
  }

  // duplicates: exact normalised title
  const byTitle = new Map();
  for (const r of records) {
    const k = normTitle(r.title);
    if (k) (byTitle.get(k) ?? byTitle.set(k, []).get(k)).push(r);
  }
  const dupPairs = new Set();
  const sameText = (x, y) => {
    const A = shingles(x._text), B = shingles(y._text);
    let inter = 0;
    for (const s of A) if (B.has(s)) inter++;
    const union = A.size + B.size - inter;
    return union ? inter / union >= threshold : true;
  };
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const cols = new Set(group.map((g) => g.collection_path));
    // Same title AND same text is a duplicate wherever it lives; same title, different text in
    // different collections is a naming problem, not a merge.
    const allSame = group.every((g) => sameText(group[0], g));
    for (const r of group) {
      const others = group.filter((g) => g !== r).map((g) => g.id);
      others.forEach((o) => dupPairs.add([r.id, o].sort().join("|")));
      add(cols.size > 1 && !allSame ? "same-title-other-collection" : "duplicate", {
        article_id: r.id, title: r.title, state: r.state, url: r.url, collection: r.collection_path,
        message: `same title as ${others.join(", ")}${cols.size > 1 ? " (in another collection)" : ""}`,
        evidence: { group: group.map((g) => ({ id: g.id, collection: g.collection_path, words: g.words, state: g.state })) },
      });
    }
  }

  // near-duplicates: 3-word shingle Jaccard through an inverted index (fast on thousands)
  const sh = new Map(records.map((r) => [r.id, shingles(r._text)]));
  const index = new Map();
  for (const [id, set] of sh) for (const s of set) (index.get(s) ?? index.set(s, []).get(s)).push(id);
  const shared = new Map();
  for (const list of index.values()) {
    if (list.length < 2 || list.length > 50) continue; // boilerplate shingles say nothing
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const k = [list[i], list[j]].sort().join("|");
      shared.set(k, (shared.get(k) ?? 0) + 1);
    }
  }
  const recById = new Map(records.map((r) => [r.id, r]));
  const nearGroups = [];
  for (const [k, inter] of shared) {
    if (dupPairs.has(k)) continue;
    const [x, y] = k.split("|");
    const A = sh.get(x).size, B = sh.get(y).size;
    const sim = inter / (A + B - inter);
    if (sim >= threshold) {
      nearGroups.push([x, y, sim]);
      for (const [p, q] of [[x, y], [y, x]]) {
        const r = recById.get(p);
        add("near-duplicate", { article_id: r.id, title: r.title, state: r.state, url: r.url, collection: r.collection_path,
          message: `${Math.round(sim * 100)}% of its text overlaps article ${q} ("${recById.get(q).title}")`, evidence: { other: q, similarity: Number(sim.toFixed(2)) } });
      }
    }
  }

  // local files pointing at ids Intercom no longer has
  for (const [id, f] of localById) {
    if (!ids.has(id) && (!f.fm.intercom_workspace || !snapshot.workspace || f.fm.intercom_workspace === snapshot.workspace)) {
      add("deleted-on-intercom", { article_id: id, title: f.fm.title, state: f.fm.state, local_file: repoRel(root, f.path),
        message: `${repoRel(root, f.path)} has intercom_id ${id}, which Intercom no longer has` });
    }
  }
  // remote articles with no source file
  const notInRepo = records.filter((r) => !r.local_file);
  if (localFiles.length && notInRepo.length) {
    for (const r of notInRepo) add("not-in-repo", { article_id: r.id, title: r.title, state: r.state, url: r.url, collection: r.collection_path, message: "has no source file in the repo (import it with pull.mjs to maintain it here)" });
  }

  // features with no article
  const covered = new Set(records.flatMap((r) => r.features.map((f) => f.id)));
  for (const f of features.filter((x) => x.shipped && !covered.has(x.id))) {
    add("uncovered-feature", { feature_id: f.id, title: f.label, state: "published",
      message: `shipped feature "${f.label}" has no article on Intercom`,
      evidence: { sources: f.sources, strings: f.strings.slice(0, 12).map((s) => `${s.file}: ${s.key} = "${s.value}"`) } });
  }

  // empty collections (no articles anywhere below them)
  const hasArticle = new Set();
  for (const r of records) {
    let cur = r.parent_id != null ? byId.get(String(r.parent_id)) : null;
    const seen = new Set();
    while (cur && !seen.has(String(cur.id))) { seen.add(String(cur.id)); hasArticle.add(String(cur.id)); cur = cur.parent_id != null ? byId.get(String(cur.parent_id)) : null; }
  }
  for (const c of snapshot.collections) if (!hasArticle.has(String(c.id))) add("empty-collection", { collection_id: String(c.id), title: c.name, collection: pathOf(c.id), state: "published", message: "has no articles" });

  findings.sort((a, b) => b.impact - a.impact || String(a.title).localeCompare(String(b.title)));
  for (const r of records) delete r._text;

  const counts = {};
  for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;
  return {
    generated_at: new Date(now).toISOString(),
    snapshot: { fetched_at: snapshot.fetched_at, workspace: snapshot.workspace, workspace_name: snapshot.workspace_name, region: snapshot.region },
    feature_source: source,
    strings_sources: stringsPaths,
    totals: {
      articles: records.length,
      published: records.filter((r) => r.state === "published").length,
      drafts: records.filter((r) => r.state !== "published").length,
      collections: snapshot.collections.filter((c) => c.parent_id == null).length,
      sections: snapshot.collections.filter((c) => c.parent_id != null).length,
      features: features.length,
      features_covered: features.filter((f) => covered.has(f.id)).length,
      locales: [...allLocales],
      local_files: localFiles.length,
    },
    counts,
    findings,
    articles: records,
    features: features.map((f) => ({ id: f.id, label: f.label, area: f.area, shipped: f.shipped, sources: f.sources, string_keys: f.strings.map((s) => s.key).slice(0, 20), covered_by: records.filter((r) => r.features.some((m) => m.id === f.id)).map((r) => r.id) })),
    collections: snapshot.collections.map((c) => ({ id: String(c.id), name: c.name, parent_id: c.parent_id == null ? null : String(c.parent_id), path: pathOf(c.id) })),
    near_duplicate_pairs: nearGroups.map(([a, b, s]) => ({ a, b, similarity: Number(s.toFixed(2)) })),
  };
}

const LABEL = {
  "uncovered-feature": "Shipped features with no article", empty: "Empty articles", "broken-link": "Broken internal links",
  "deleted-on-intercom": "Deleted on Intercom but still referenced in the repo", duplicate: "Duplicate titles", "near-duplicate": "Near-duplicate text",
  "no-collection": "Articles in no collection", "same-title-other-collection": "Same title in two collections", orphan: "Orphan articles (match no feature)",
  "links-to-draft": "Published articles linking to drafts", "other-workspace": "Files published to another workspace", short: "Short articles",
  stale: "Not updated in a long time", "empty-collection": "Empty collections", "missing-translation": "Missing translations",
  "non-question-title": "Titles that are not questions", draft: "Drafts", "not-in-repo": "On Intercom with no source file in the repo",
};

export function renderMarkdown(audit) {
  const t = audit.totals;
  const L = [];
  L.push("<!-- GENERATED by audit.mjs. Re-run to refresh; do not hand-edit. -->", "", "# Help Center audit", "");
  L.push(`Workspace: **${audit.snapshot.workspace_name ?? audit.snapshot.workspace ?? "unknown"}** (${audit.snapshot.region ?? "us"}) · snapshot ${audit.snapshot.fetched_at ?? "n/a"} · report ${audit.generated_at}`, "");
  L.push(`**${t.articles} articles** (${t.published} published, ${t.drafts} draft) in ${t.collections} collections and ${t.sections} sections.`);
  if (audit.feature_source) L.push(`**${t.features_covered} of ${t.features} features** have at least one article (features from \`${audit.feature_source}\`).`);
  else L.push("Feature coverage was **not checked**: no coverage manifest or features source is configured. Run setup.");
  if (t.locales.length > 1) L.push(`Locales in use: ${t.locales.join(", ")}.`);
  L.push("");
  L.push("## Summary", "", "| Finding | Count | Severity |", "|---|---|---|");
  for (const [type, n] of Object.entries(audit.counts).sort((a, b) => SEVERITY[b[0]] - SEVERITY[a[0]])) L.push(`| ${LABEL[type] ?? type} | ${n} | ${SEVERITY[type]} |`);
  if (!audit.findings.length) L.push("| Nothing found | 0 | |");
  L.push("");
  L.push("## Fix these first", "", "Ranked by impact: severity, halved for drafts (fewer readers see them).", "", "| # | Finding | Article / feature | Detail |", "|---|---|---|---|");
  audit.findings.slice(0, 25).forEach((f, i) => {
    const who = f.article_id ? `${f.title || "(untitled)"} (${f.article_id})` : f.feature_id ? `feature: ${f.title}` : f.title;
    L.push(`| ${i + 1} | ${LABEL[f.type] ?? f.type} | ${String(who).replace(/\|/g, "\\|")} | ${String(f.message).replace(/\|/g, "\\|")} |`);
  });
  L.push("");
  const types = [...new Set(audit.findings.map((f) => f.type))];
  for (const type of types) {
    const items = audit.findings.filter((f) => f.type === type);
    L.push(`## ${LABEL[type] ?? type} (${items.length})`, "");
    for (const f of items.slice(0, 100)) {
      const where = f.collection ? ` · ${f.collection}` : "";
      const link = f.url ? ` · [open](${f.url})` : "";
      L.push(`- **${f.title || f.feature_id || f.article_id}**${f.article_id ? ` (${f.article_id}, ${f.state})` : ""}${where}: ${f.message}${link}`);
      if (f.evidence?.strings?.length) for (const s of f.evidence.strings.slice(0, 5)) L.push(`  - UI string: \`${s}\``);
      if (f.evidence?.sources?.length) L.push(`  - code: ${f.evidence.sources.map((s) => `\`${s}\``).join(", ")}`);
    }
    if (items.length > 100) L.push(`- ...and ${items.length - 100} more (see help-center-audit.json)`);
    L.push("");
  }
  L.push("## Collections", "");
  const counts = new Map();
  for (const a of audit.articles) if (a.collection_path) counts.set(a.collection_path, (counts.get(a.collection_path) ?? 0) + 1);
  for (const c of [...audit.collections].sort((a, b) => a.path.localeCompare(b.path))) {
    const depth = c.path.split(" › ").length - 1;
    L.push(`${"  ".repeat(depth)}- ${c.name} (${counts.get(c.path) ?? 0})`);
  }
  L.push("", "## Next step", "", "Run `/intercom-help-center:plan` to turn this into a correction plan (FIX / REWRITE / MERGE / DELETE / KEEP / WRITE), each item with its evidence.", "");
  return L.join("\n");
}

export async function run(argv, deps = {}) {
  const a = parseArgs(argv, SPEC);
  if (a.flag("--help")) { console.log("usage: node audit.mjs [--snapshot file.json] [--out-dir dir] [--min-words n] [--stale-days n]"); return 0; }
  const { config, root } = loadConfig(deps.root);
  if (a.opt("--min-words")) config.audit.minWords = Number(a.opt("--min-words"));
  if (a.opt("--stale-days")) config.audit.staleDays = Number(a.opt("--stale-days"));
  const outDir = resolve(root, a.opt("--out-dir", config.outDir));
  const region = a.opt("--region", env("INTERCOM_REGION", config.intercom.region));
  const log = a.flag("--quiet") ? () => {} : (s) => console.log(s);

  let snapshot;
  if (a.opt("--snapshot")) {
    const p = resolve(root, a.opt("--snapshot"));
    if (!existsSync(p)) throw fail("IHC050", { path: p });
    snapshot = JSON.parse(readFileSync(p, "utf8"));
  } else {
    const token = env("INTERCOM_API_TOKEN");
    if (!token) throw fail("IHC001");
    const client = deps.client ?? createClient({ token, region, version: config.intercom.apiVersion, allowWrites: false, sleep: deps.sleep });
    log(`[audit] reading the Help Center (${region}, read-only)...`);
    snapshot = await fetchSnapshot({ client, region });
    if (!a.flag("--no-write")) { ensureGitignore(root, a.opt("--out-dir", config.outDir)); writeFileSync(join(outDir, "snapshot.json"), JSON.stringify(snapshot, null, 2)); }
    log(`[audit] ${snapshot.articles.length} articles, ${snapshot.collections.length} collections (${client.stats.get} GETs, ${client.stats.write} writes)`);
  }

  const audit = await analyze({ snapshot, root, config, now: deps.now, warn: (code, vars) => report(code, vars) });
  if (!audit.feature_source) report("IHC023", {}, { withFix: true });
  if (!a.flag("--no-write")) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "help-center-audit.json"), JSON.stringify(audit, null, 2));
    writeFileSync(join(outDir, "help-center-audit.md"), renderMarkdown(audit));
    log(`[audit] wrote ${toPosix(join(a.opt("--out-dir", config.outDir), "help-center-audit.md"))} and .json`);
  }
  log(`[audit] ${audit.findings.length} findings: ${Object.entries(audit.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  return 0;
}

main(import.meta.url, run);
