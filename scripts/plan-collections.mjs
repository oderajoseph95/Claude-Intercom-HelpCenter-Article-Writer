#!/usr/bin/env node
/**
 * plan-collections.mjs: propose a collection tree from the product's features, and place every
 * existing article in it. Writes a PLAN; changes nothing on Intercom.
 *
 * The tree:
 *   Getting started                         (standard)
 *   <one collection per feature>            or per `area`, with one section per feature in it
 *   Billing                                 (standard)
 *   Troubleshooting                         (standard)
 * `collectionMap` in .help-center/config.json overrides the target of any feature:
 *   { "csv-export": "Orders › Exporting" }
 *
 * Each existing article gets: MOVE (to a different collection), KEEP (already right), or REVIEW
 * (no feature match and no standard fit: a human decides; it stays where it is).
 * Existing collections the tree does not use are listed, never deleted.
 *
 * The plan starts with "approved": false. `publish.mjs --create-collections --plan <file>` refuses
 * to apply it until a human approves it (the /plan command asks; or pass --approve --by "<name>").
 *
 * USAGE
 *   node plan-collections.mjs                          # reads .help-center/help-center-audit.json
 *   node plan-collections.mjs --audit path/to/audit.json
 *   node plan-collections.mjs --approve --by "Jane"    # mark the existing plan approved
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { parseArgs, main, toPosix } from "./lib/cli.mjs";
import { loadConfig } from "./lib/config.mjs";
import { norm, splitPath } from "./lib/intercom.mjs";
import { fail } from "./lib/messages.mjs";

const SPEC = { flags: ["--approve", "--quiet"], options: ["--audit", "--out", "--by"] };

const BILLING = /\b(bill|billing|invoice|plan|plans|pricing|price|subscription|subscribe|charge|charged|refund|payment|pay|trial|cancel|upgrade|downgrade|receipt)\b/i;
const TROUBLE = /\b(not working|doesn'?t work|isn'?t|can'?t|cannot|error|errors|fail|failed|failing|missing|broken|troubleshoot|fix|problem|issue|why)\b/i;
const GETTING = /\b(get started|getting started|install|installation|set ?up|setup|onboard|onboarding|first|connect|introduction|overview|welcome|quick start)\b/i;

export function buildPlan(audit, config) {
  const [gs, billing, trouble] = [...(config.audit.standardCollections ?? []), "Getting started", "Billing", "Troubleshooting"].slice(0, 3);
  const map = config.collectionMap ?? {};
  const target = new Map(); // featureId -> path[]
  const byArea = new Map();
  for (const f of audit.features) {
    if (map[f.id]) { target.set(f.id, splitPath(map[f.id])); continue; }
    if (f.area) { target.set(f.id, [f.area, f.label]); (byArea.get(f.area) ?? byArea.set(f.area, []).get(f.area)).push(f.label); }
    else target.set(f.id, [f.label]);
  }

  // the tree, as unique paths in display order
  const paths = [[gs], ...[...target.values()], [billing], [trouble]];
  const seen = new Set();
  const tree = [];
  for (const p of paths) {
    for (let d = 1; d <= p.length; d++) {
      const sub = p.slice(0, d);
      const k = sub.map(norm).join(" › ");
      if (seen.has(k)) continue;
      seen.add(k);
      tree.push(sub);
    }
  }
  const existing = new Map(audit.collections.map((c) => [c.path.split(" › ").map(norm).join(" › "), c]));
  const treeOut = tree.map((p) => {
    const hit = existing.get(p.map(norm).join(" › "));
    return { path: p, exists: Boolean(hit), id: hit?.id ?? null };
  });
  const create = treeOut.filter((t) => !t.exists).map((t) => ({ path: t.path }));

  const moves = [];
  for (const a of audit.articles) {
    const current = a.collection_path ? a.collection_path.split(" › ") : null;
    let to = null;
    let reason = "";
    if (a.features?.length) {
      to = target.get(a.features[0].id);
      reason = `about feature "${a.features[0].id}" (${a.features[0].why.join("; ")})`;
    } else if (BILLING.test(a.title)) { to = [billing]; reason = "title is about billing or plans"; }
    else if (TROUBLE.test(a.title)) { to = [trouble]; reason = "title is a problem or an error"; }
    else if (GETTING.test(a.title)) { to = [gs]; reason = "title is about getting started"; }
    if (!to && current && [gs, billing, trouble].some((n) => norm(n) === norm(current[0]))) {
      moves.push({ article_id: a.id, title: a.title, state: a.state, from: current, to: current, action: "KEEP", reason: "already in a standard collection" });
      continue;
    }
    if (!to) {
      moves.push({ article_id: a.id, title: a.title, state: a.state, from: current, to: current, action: "REVIEW", reason: "matches no feature and no standard collection; stays where it is until a human decides" });
      continue;
    }
    const same = current && current.map(norm).join(" › ") === to.map(norm).join(" › ");
    moves.push({ article_id: a.id, title: a.title, state: a.state, from: current, to, action: same ? "KEEP" : "MOVE", reason });
  }
  const used = new Set(tree.map((p) => p.map(norm).join(" › ")));
  const unused = audit.collections.filter((c) => !used.has(c.path.split(" › ").map(norm).join(" › "))).map((c) => ({ id: c.id, path: c.path }));

  return {
    kind: "collections-plan",
    version: 1,
    generated_at: new Date().toISOString(),
    approved: false,
    approved_by: null,
    approved_at: null,
    tree: treeOut,
    create,
    moves,
    unused_collections: unused,
    summary: {
      collections_to_create: create.length,
      moves: moves.filter((m) => m.action === "MOVE").length,
      keep: moves.filter((m) => m.action === "KEEP").length,
      review: moves.filter((m) => m.action === "REVIEW").length,
    },
  };
}

export function renderPlanMarkdown(plan) {
  const L = ["<!-- GENERATED by plan-collections.mjs. Approve through /intercom-help-center:plan, not by hand-editing. -->", "", "# Proposed Help Center structure", ""];
  L.push(`Status: **${plan.approved ? `approved by ${plan.approved_by} at ${plan.approved_at}` : "NOT APPROVED"}**`, "");
  L.push(`${plan.summary.collections_to_create} collection(s) or section(s) to create · ${plan.summary.moves} article move(s) · ${plan.summary.keep} already in place · ${plan.summary.review} for a human to place`, "");
  L.push("## Tree", "", "```");
  for (const t of plan.tree) L.push(`${"  ".repeat(t.path.length - 1)}${t.path[t.path.length - 1]}${t.exists ? "" : "   (new)"}`);
  L.push("```", "");
  const show = (title, rows) => {
    if (!rows.length) return;
    L.push(`## ${title} (${rows.length})`, "", "| Article | From | To | Why |", "|---|---|---|---|");
    for (const m of rows) L.push(`| ${m.title.replace(/\|/g, "\\|")} (${m.article_id}) | ${m.from?.join(" › ") ?? "(no collection)"} | ${m.to?.join(" › ") ?? "(stays)"} | ${m.reason.replace(/\|/g, "\\|")} |`);
    L.push("");
  };
  show("Moves", plan.moves.filter((m) => m.action === "MOVE"));
  show("Needs a human decision", plan.moves.filter((m) => m.action === "REVIEW"));
  if (plan.unused_collections.length) {
    L.push(`## Existing collections the new tree does not use (${plan.unused_collections.length})`, "", "Nothing is deleted. Empty them by moving articles, then delete them in Intercom by hand if you want.", "");
    for (const c of plan.unused_collections) L.push(`- ${c.path} (${c.id})`);
    L.push("");
  }
  return L.join("\n");
}

export function approvePlanFile(path, by) {
  if (!existsSync(path)) throw fail("IHC039", { path });
  let plan;
  try { plan = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw fail("IHC040", { path, detail: e.message }); }
  if (!by || !String(by).trim()) throw fail("IHC040", { path, detail: "approval needs --by \"<who approved it>\"" });
  plan.approved = true;
  plan.approved_by = String(by).trim();
  plan.approved_at = new Date().toISOString();
  writeFileSync(path, JSON.stringify(plan, null, 2) + "\n");
  return plan;
}

export async function run(argv, deps = {}) {
  const a = parseArgs(argv, SPEC);
  if (a.flag("--help")) { console.log("usage: node plan-collections.mjs [--audit file] [--out file.json] | --approve --by <name>"); return 0; }
  const { config, root } = loadConfig(deps.root);
  const out = resolve(root, a.opt("--out", join(config.outDir, "help-center-collections.plan.json")));
  if (a.flag("--approve")) {
    const plan = approvePlanFile(out, a.opt("--by"));
    writeFileSync(out.replace(/\.json$/, ".md"), renderPlanMarkdown(plan));
    console.log(`[plan-collections] approved by ${plan.approved_by}: ${out}`);
    return 0;
  }
  const auditPath = resolve(root, a.opt("--audit", join(config.outDir, "help-center-audit.json")));
  if (!existsSync(auditPath)) throw fail("IHC039", { path: auditPath });
  const plan = buildPlan(JSON.parse(readFileSync(auditPath, "utf8")), config);
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
  writeFileSync(out.replace(/\.json$/, ".md"), renderPlanMarkdown(plan));
  if (!a.flag("--quiet")) console.log(`[plan-collections] ${plan.summary.collections_to_create} to create, ${plan.summary.moves} moves, ${plan.summary.review} to review -> ${toPosix(relative(root, out.replace(/\.json$/, ".md")))} (NOT approved)`);
  return 0;
}

main(import.meta.url, run);
