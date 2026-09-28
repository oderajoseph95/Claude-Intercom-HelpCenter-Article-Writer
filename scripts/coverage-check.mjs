#!/usr/bin/env node
/**
 * coverage-check.mjs: fail the build when a shipped feature has no help article.
 *
 * Zero dependencies. Node 18+. Needs NO Intercom token: it reads only the repo. Run it in CI on
 * every pull request, next to your tests.
 *
 * It reads a COVERAGE MANIFEST (default: config `manifest`, else help-articles/coverage-manifest.mjs):
 *   KINDS     the article types every feature owes
 *   FEATURES  { "<feature-id>": { label, kinds: { "<kind>": <cell> } } }, each cell EXACTLY ONE of
 *               { article:  "path/to/article.md" }        written, and the file exists
 *               { deferred: "<reason naming a ticket>" }   owed, and someone is tracking it
 *               { na:       "<reason it does not apply>" } argued, not asserted
 *   shipped() (optional) the shipped feature ids, read from the repo. Every one must have an entry.
 *   TICKET_PATTERN (optional RegExp). Default: ABC-123 or #123.
 *
 * FAILS THE BUILD on: a shipped feature with no entry (IHC100), a missing/empty/double cell
 * (IHC101/102), a missing article file (IHC103), a short or shrug reason (IHC104/105), a deferral
 * with no ticket (IHC106), a cited source that no longer exists (IHC107), a broken manifest
 * (IHC020/021/022/110/111).
 * WARNS (fails with --strict): an article whose sources changed in git after last_synced (IHC108),
 * an article citing no sources (IHC109).
 *
 * What it cannot see: whether an article is good or true. That is the review step.
 *
 * USAGE
 *   node coverage-check.mjs [--manifest path] [--root dir] [--strict] [--report]
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs, main } from "./lib/cli.mjs";
import { loadConfig } from "./lib/config.mjs";
import { parseFrontmatter } from "./lib/articles.mjs";
import { fail, msg } from "./lib/messages.mjs";

const SPEC = { flags: ["--strict", "--report"], options: ["--manifest", "--root"] };

export async function run(argv, deps = {}) {
  const a = parseArgs(argv, SPEC);
  if (a.flag("--help")) { console.log("usage: node coverage-check.mjs [--manifest path] [--root dir] [--strict] [--report]"); return 0; }
  const ROOT = resolve(a.opt("--root", deps.root ?? "."));
  const { config } = loadConfig(ROOT);
  const MANIFEST = resolve(ROOT, a.opt("--manifest", config.manifest));
  const STRICT = a.flag("--strict");
  const errors = [];
  const warnings = [];

  if (!existsSync(MANIFEST)) throw fail("IHC020", { path: MANIFEST });
  let mod;
  try { mod = await import(pathToFileURL(MANIFEST).href + `?t=${Date.now()}`); }
  catch (e) { throw fail("IHC022", { path: MANIFEST, detail: e.message }); }
  const { KINDS, FEATURES } = mod;
  const TICKET = mod.TICKET_PATTERN instanceof RegExp ? mod.TICKET_PATTERN : /[A-Z][A-Z0-9]+-\d+|#\d+/;
  const SHRUG = /^(n\/?a|none|no|not needed|tbd|todo|later)\.?$/i;

  if (!Array.isArray(KINDS) || !KINDS.length) errors.push(msg("IHC110", { what: "KINDS" }));
  if (!FEATURES || typeof FEATURES !== "object") errors.push(msg("IHC110", { what: "FEATURES" }));

  if (typeof mod.shipped === "function") {
    const shipped = await mod.shipped({ root: ROOT });
    if (!Array.isArray(shipped)) errors.push(msg("IHC111"));
    else {
      if (!shipped.length) errors.push(msg("IHC021"));
      for (const id of shipped) if (!FEATURES?.[id]) errors.push(msg("IHC100", { id }));
    }
  }

  const articlePaths = new Set();
  const deferred = [];
  for (const [id, feature] of Object.entries(FEATURES ?? {})) {
    for (const kind of KINDS ?? []) {
      const cell = feature?.kinds?.[kind];
      const where = `"${id}" / ${kind}`;
      if (!cell || typeof cell !== "object") { errors.push(msg("IHC101", { where })); continue; }
      const set = ["article", "deferred", "na"].filter((k) => cell[k] != null);
      if (set.length !== 1) { errors.push(msg("IHC102", { where, found: set.length ? set.join(", ") : "none" })); continue; }
      const [key] = set;
      const val = String(cell[key]).trim();
      if (key === "article") {
        if (!existsSync(join(ROOT, val))) errors.push(msg("IHC103", { where, path: val }));
        else articlePaths.add(val);
        continue;
      }
      if (val.length < 30) errors.push(msg("IHC104", { where, key, val }));
      if (SHRUG.test(val)) errors.push(msg("IHC105", { where, key, val }));
      if (key === "deferred") {
        if (!TICKET.test(val)) errors.push(msg("IHC106", { where, val }));
        deferred.push(`${where}: ${val}`);
      }
    }
  }

  const lastCommitIso = (file) => {
    try { return execFileSync("git", ["log", "-1", "--format=%cI", "--", file], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
    catch { return null; }
  };
  for (const rel of articlePaths) {
    const fm = parseFrontmatter(readFileSync(join(ROOT, rel), "utf8"))?.fm ?? {};
    const sources = Array.isArray(fm.sources) ? fm.sources : [];
    if (!sources.length) warnings.push(msg("IHC109", { file: rel }));
    for (const src of sources) {
      if (!existsSync(join(ROOT, src))) { errors.push(msg("IHC107", { file: rel, src })); continue; }
      const synced = fm.last_synced ? Date.parse(fm.last_synced) : null;
      const changed = lastCommitIso(src);
      if (synced && changed && Date.parse(changed) > synced) (STRICT ? errors : warnings).push(msg("IHC108", { file: rel, src, changed, synced: fm.last_synced }));
    }
  }

  console.log(`help coverage: ${Object.keys(FEATURES ?? {}).length} feature(s) × ${KINDS?.length ?? 0} kind(s) · ${articlePaths.size} article file(s) · ${deferred.length} deferred`);
  if (a.flag("--report") && deferred.length) { console.log("\nstanding backlog:"); for (const d of deferred) console.log(`  · ${d}`); }
  for (const w of warnings) console.log(`  ! ${w}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  if (errors.length) { console.log(`\n✗ ${errors.length} problem(s). A feature does not ship without its article, or a named, ticketed reason.`); return 1; }
  console.log("✓ every shipped feature has its articles or a tracked reason");
  return 0;
}

main(import.meta.url, run);
