#!/usr/bin/env node
/**
 * find-existing.mjs: THE PRE-WRITE CHECK. Run it before writing ANY article.
 *
 * It searches what is already published (the audit snapshot, refreshed when older than
 * snapshot.maxAgeHours and a token is present) and the local articles folder for the same topic,
 * by title similarity, keyword overlap and feature mapping, and decides:
 *
 *   UPDATE  <id>     an article on Intercom already covers this. Edit it; keep its id.
 *   UPDATE-LOCAL     a local file (not yet on Intercom) covers this. Edit that file.
 *   AMBIGUOUS        two or more strong matches (e.g. the same title in two collections).
 *                    A human picks; never guess. Exit code 3.
 *   CREATE           nothing covers it. Write a new article.
 *
 * USAGE
 *   node find-existing.mjs --title "How do I export my orders?"
 *   node find-existing.mjs --feature csv-export
 *   node find-existing.mjs --title "..." --keywords "export,csv" --json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, main, env, toPosix } from "./lib/cli.mjs";
import { loadConfig, ensureGitignore } from "./lib/config.mjs";
import { createClient, collectionPaths } from "./lib/intercom.mjs";
import { walkArticles, loadArticles } from "./lib/articles.mjs";
import { discoverFeatures, scoreFeature, repoRel } from "./lib/features.mjs";
import { htmlToText } from "./lib/html.mjs";
import { normTitle, titleSimilarity, tokens } from "./lib/text.mjs";
import { fail, report } from "./lib/messages.mjs";
import { fetchSnapshot } from "./audit.mjs";

const SPEC = { flags: ["--json", "--refresh", "--offline"], options: ["--title", "--feature", "--keywords", "--threshold"] };

export async function getSnapshot({ root, config, client, refresh = false, offline = false, now = Date.now(), region }) {
  const path = resolve(root, config.outDir, "snapshot.json");
  const limitH = Number(config.snapshot.maxAgeHours);
  let snap = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const ageH = snap ? (now - Date.parse(snap.fetched_at ?? statSync(path).mtime)) / 36e5 : Infinity;
  if (snap && ageH <= limitH && !refresh) return { snapshot: snap, fresh: true, ageH };
  if (!client || offline) {
    if (!snap) throw fail("IHC050", { path: toPosix(repoRel(root, path)) });
    report("IHC052", { hours: Math.round(ageH) }, { withFix: true });
    return { snapshot: snap, fresh: false, ageH };
  }
  if (snap) report("IHC051", { hours: Math.round(ageH), limit: limitH }, { withFix: false });
  snap = await fetchSnapshot({ client, region });
  ensureGitignore(root, config.outDir);
  writeFileSync(path, JSON.stringify(snap, null, 2));
  return { snapshot: snap, fresh: true, ageH: 0 };
}

export function findMatches({ snapshot, local, query, feature, threshold = 0.5 }) {
  const { pathOf } = collectionPaths(snapshot.collections ?? []);
  const qTokens = new Set([...tokens(query.title ?? ""), ...(query.keywords ?? []).flatMap(tokens)]);
  const qNorm = normTitle(query.title ?? "");
  const score = (title, text) => {
    const why = [];
    let s = 0;
    if (qNorm && normTitle(title) === qNorm) { s = 1; why.push("same title"); }
    else if (query.title) { const t = titleSimilarity(query.title, title); if (t > 0) { s = Math.max(s, t); why.push(`title ${Math.round(t * 100)}% similar`); } }
    if (qTokens.size) {
      const bt = new Set(tokens(`${title} ${text}`));
      let hit = 0;
      for (const k of qTokens) if (bt.has(k)) hit++;
      const kw = hit / qTokens.size;
      if (kw >= 0.5) { s = Math.max(s, Math.min(0.9, kw * 0.8)); why.push(`${hit}/${qTokens.size} keywords`); }
    }
    if (feature) {
      const f = scoreFeature({ title, text }, feature);
      if (f.score >= 3) { s = Math.max(s, Math.min(0.95, 0.5 + f.score / 20)); why.push(`about feature ${feature.id} (${f.why.join("; ")})`); }
    }
    return { s, why };
  };
  const remote = snapshot.articles.map((a) => {
    const { s, why } = score(a.title, htmlToText(a.body));
    return { where: "intercom", id: String(a.id), title: a.title, state: a.state, url: a.url ?? null, collection: a.parent_id != null ? pathOf(a.parent_id) : null, score: Number(s.toFixed(2)), why };
  });
  const remoteIds = new Set(remote.map((r) => r.id));
  const locals = local.map((f) => {
    const { s, why } = score(f.fm?.title ?? "", f.body);
    return { where: "local", file: f.rel, id: f.fm?.intercom_id ? String(f.fm.intercom_id) : null, title: f.fm?.title, state: f.fm?.state, score: Number(s.toFixed(2)), why };
  });
  // a local file already linked to a remote article adds its path to that match
  for (const l of locals) if (l.id && remoteIds.has(l.id)) { const r = remote.find((x) => x.id === l.id); r.local_file = l.file; r.score = Math.max(r.score, l.score); }
  const candidates = [...remote, ...locals.filter((l) => !l.id || !remoteIds.has(l.id))].filter((c) => c.score >= threshold).sort((a, b) => b.score - a.score);

  const strong = candidates.filter((c) => c.score >= Math.max(threshold, 0.6));
  let decision;
  if (!candidates.length) decision = { action: "CREATE", reason: "nothing published or local covers this topic" };
  else if (strong.length > 1 && strong[0].score - strong[1].score < 0.15) decision = { action: "AMBIGUOUS", reason: "several articles match about equally; a human must pick one", candidates: strong.map((c) => c.id ?? c.file) };
  else {
    const top = candidates[0];
    decision = top.where === "intercom"
      ? { action: "UPDATE", id: top.id, local_file: top.local_file ?? null, reason: `already covered by "${top.title}" (${top.why.join("; ")})` }
      : { action: "UPDATE-LOCAL", file: top.file, reason: `a local file already covers this: "${top.title}" (${top.why.join("; ")})` };
  }
  return { decision, candidates: candidates.slice(0, 10) };
}

export async function run(argv, deps = {}) {
  const a = parseArgs(argv, SPEC);
  if (a.flag("--help") || (!a.opt("--title") && !a.opt("--feature") && !a.opt("--keywords"))) {
    console.log('usage: node find-existing.mjs --title "<question>" [--feature <id>] [--keywords a,b] [--json] [--refresh|--offline]');
    return a.flag("--help") ? 0 : 1;
  }
  const { config, root } = loadConfig(deps.root);
  const token = env("INTERCOM_API_TOKEN");
  const region = env("INTERCOM_REGION", config.intercom.region);
  const client = deps.client ?? (token ? createClient({ token, region, version: config.intercom.apiVersion, allowWrites: false, sleep: deps.sleep }) : null);
  const { snapshot, ageH } = await getSnapshot({ root, config, client, refresh: a.flag("--refresh"), offline: a.flag("--offline"), now: deps.now, region });
  const local = loadArticles(walkArticles(resolve(root, config.articlesDir))).map((f) => ({ ...f, rel: repoRel(root, f.path) }));
  let feature = null;
  if (a.opt("--feature")) {
    const { features } = await discoverFeatures({ root, config });
    feature = features.find((f) => f.id === a.opt("--feature")) ?? null;
  }
  const query = { title: a.opt("--title", feature?.label ?? ""), keywords: String(a.opt("--keywords", "")).split(",").map((s) => s.trim()).filter(Boolean) };
  const result = findMatches({ snapshot, local, query, feature, threshold: Number(a.opt("--threshold", 0.5)) });
  result.snapshot_age_hours = Number(ageH.toFixed(1));
  if (a.flag("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    const d = result.decision;
    console.log(`${d.action}${d.id ? ` ${d.id}` : ""}${d.file ? ` ${d.file}` : ""}: ${d.reason}`);
    for (const c of result.candidates) console.log(`  ${c.score.toFixed(2)}  ${c.where === "intercom" ? `#${c.id}` : c.file}  "${c.title}"${c.collection ? `  [${c.collection}]` : ""}${c.local_file ? `  (file ${c.local_file})` : ""}  ${c.why.join("; ")}`);
  }
  return result.decision.action === "AMBIGUOUS" ? 3 : 0;
}

main(import.meta.url, run);
