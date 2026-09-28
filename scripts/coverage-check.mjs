#!/usr/bin/env node
/**
 * coverage-check.mjs: fail the build when a shipped feature has no help article.
 *
 * Zero dependencies. Node 18+. Run it in CI next to your tests.
 *
 * It reads a COVERAGE MANIFEST (default ./help-articles/coverage-manifest.mjs) that exports:
 *
 *   KINDS     the article types every feature owes, e.g.
 *             ["what-and-when", "customer-use", "setup", "comparison", "troubleshooting"]
 *   FEATURES  { "<feature-id>": { label, kinds: { "<kind>": <cell> } } }
 *             where each cell is EXACTLY ONE of:
 *               { article:  "path/to/article.md" }            written, and the file exists
 *               { deferred: "<reason naming a ticket>" }       owed, and someone is tracking it
 *               { na:       "<reason it does not apply>" }     argued, not asserted
 *   shipped() (optional) returns the list of feature ids that have SHIPPED, read from your repo
 *             (a routes folder, a feature registry, a "completed" folder, a changelog...). If it
 *             is exported, every shipped id MUST have a manifest entry. This is the check that
 *             catches the feature nobody remembered to write up.
 *   TICKET_PATTERN (optional RegExp) what a ticket reference looks like. Default: ABC-123 or #123.
 *
 * WHAT FAILS THE BUILD
 *   1. a shipped feature with no manifest entry
 *   2. a kind with no cell, an empty cell, or a cell setting more than one of article/deferred/na
 *   3. an `article:` path that does not exist (moved, renamed, deleted: a regression)
 *   4. a `deferred:` or `na:` reason under 30 characters, or a shrug ("n/a", "none", "not needed")
 *   5. a `deferred:` that names no ticket (a promise nobody tracks is how articles never get written)
 *   6. an article whose `sources:` frontmatter cites a file that no longer exists
 *
 * WHAT ONLY WARNS (pass --strict to fail on it)
 *   CURRENCY: an article whose `sources:` files changed in git AFTER its `last_synced`. The code it
 *   describes moved since anyone last checked the prose against it. Warn by default, because
 *   blocking every commit on prose accuracy trains people to bypass the gate.
 *
 * WHAT IT CANNOT SEE: whether an article is any good, or whether a claim in it is true. That is
 * the review step. This gate proves the structural claim only: something real exists at that path,
 * or a real, ticketed reason was written down for why not.
 *
 * USAGE
 *   node coverage-check.mjs
 *   node coverage-check.mjs --manifest docs/help/coverage-manifest.mjs
 *   node coverage-check.mjs --strict        # also fail on stale articles
 *   node coverage-check.mjs --report        # print the full backlog of deferred cells
 *
 * TESTED: every failure mode above against the bundled example (examples/), including red runs.
 * NOT TESTED: the currency check outside a git repo (it silently skips when git is unavailable).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (n, f) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : f; };
const MANIFEST = resolve(opt("--manifest", "help-articles/coverage-manifest.mjs"));
const ROOT = resolve(opt("--root", "."));
const STRICT = argv.includes("--strict");
const REPORT = argv.includes("--report");

const errors = [];
const warnings = [];

if (!existsSync(MANIFEST)) {
  console.error(`✗ coverage manifest not found: ${MANIFEST}\n  No manifest means zero tracked coverage. That is the gap, not a smaller one.`);
  process.exit(1);
}

const mod = await import(pathToFileURL(MANIFEST).href + `?t=${Date.now()}`);
const { KINDS, FEATURES } = mod;
const TICKET = mod.TICKET_PATTERN instanceof RegExp ? mod.TICKET_PATTERN : /[A-Z][A-Z0-9]+-\d+|#\d+/;
const SHRUG = /^(n\/?a|none|no|not needed|tbd|todo|later)\.?$/i;

if (!Array.isArray(KINDS) || !KINDS.length) errors.push("manifest exports no KINDS");
if (!FEATURES || typeof FEATURES !== "object") errors.push("manifest exports no FEATURES object");

// 1. every shipped feature has an entry
if (typeof mod.shipped === "function") {
  const shipped = await mod.shipped({ root: ROOT });
  if (!Array.isArray(shipped)) errors.push("shipped() must return an array of feature ids");
  else {
    if (shipped.length === 0) {
      // A gate that passes because it found nothing is worse than no gate.
      errors.push("shipped() returned 0 features. The discovery is probably broken; refusing to pass vacuously.");
    }
    for (const id of shipped) {
      if (!FEATURES?.[id]) errors.push(`shipped feature "${id}" has NO manifest entry. Add one naming, per kind, an article, a ticketed deferral, or an argued n/a.`);
    }
  }
}

// 2-5. every cell resolves
const articlePaths = new Set();
const deferredCells = [];
for (const [id, feature] of Object.entries(FEATURES ?? {})) {
  for (const kind of KINDS ?? []) {
    const cell = feature?.kinds?.[kind];
    const where = `"${id}" / ${kind}`;
    if (!cell || typeof cell !== "object") { errors.push(`${where}: no entry. Blank is not a considered n/a.`); continue; }
    const set = ["article", "deferred", "na"].filter((k) => cell[k] != null);
    if (set.length !== 1) { errors.push(`${where}: set exactly one of article/deferred/na (found ${set.length ? set.join(", ") : "none"})`); continue; }
    const [key] = set;
    const val = String(cell[key]).trim();
    if (key === "article") {
      if (!existsSync(join(ROOT, val))) errors.push(`${where}: article "${val}" does not exist. The manifest says it is covered and it is not.`);
      else articlePaths.add(val);
      continue;
    }
    if (val.length < 30) errors.push(`${where}: ${key} reason is under 30 characters: "${val}"`);
    if (SHRUG.test(val)) errors.push(`${where}: ${key} "${val}" is a shrug, not a reason`);
    if (key === "deferred") {
      if (!TICKET.test(val)) errors.push(`${where}: deferred reason names no ticket: "${val}"`);
      deferredCells.push(`${where}: ${val}`);
    }
  }
}

// 6 + currency: articles cite their sources
function frontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---/.exec(raw.replace(/\r\n/g, "\n"));
  const fm = {};
  let listKey = null;
  for (const line of (m?.[1] ?? "").split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) { fm[listKey].push(item[1].trim().replace(/^["']|["']$/g, "")); continue; }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const v = kv[2].trim();
    if (v === "") { fm[kv[1]] = []; listKey = kv[1]; } else { listKey = null; fm[kv[1]] = v.replace(/^["']|["']$/g, ""); }
  }
  return fm;
}
function lastCommitIso(file) {
  try { return execFileSync("git", ["log", "-1", "--format=%cI", "--", file], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}
for (const rel of articlePaths) {
  const fm = frontmatter(readFileSync(join(ROOT, rel), "utf8"));
  const sources = Array.isArray(fm.sources) ? fm.sources : [];
  if (!sources.length) warnings.push(`${rel}: cites no sources. A grounded article names the code files it describes.`);
  for (const src of sources) {
    if (!existsSync(join(ROOT, src))) { errors.push(`${rel}: cites source "${src}", which does not exist`); continue; }
    const synced = fm.last_synced && fm.last_synced !== "null" ? Date.parse(fm.last_synced) : null;
    const changed = lastCommitIso(src);
    if (synced && changed && Date.parse(changed) > synced) {
      (STRICT ? errors : warnings).push(`${rel}: STALE. "${src}" changed ${changed}, after the article was last synced ${fm.last_synced}. Re-check the prose.`);
    }
  }
}

// report
const featureCount = Object.keys(FEATURES ?? {}).length;
console.log(`help coverage: ${featureCount} feature(s) × ${KINDS?.length ?? 0} kind(s) · ${articlePaths.size} article file(s) · ${deferredCells.length} deferred`);
if (REPORT && deferredCells.length) { console.log("\nstanding backlog:"); for (const d of deferredCells) console.log(`  · ${d}`); }
for (const w of warnings) console.log(`  ! ${w}`);
for (const e of errors) console.log(`  ✗ ${e}`);
if (errors.length) { console.log(`\n✗ ${errors.length} problem(s). A feature does not ship without its article, or a named, ticketed reason.`); process.exit(1); }
console.log("✓ every shipped feature has its articles or a tracked reason");
