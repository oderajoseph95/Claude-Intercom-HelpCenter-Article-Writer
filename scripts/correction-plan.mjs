#!/usr/bin/env node
/**
 * correction-plan.mjs: turn the audit into a plan a human approves, one verdict per item.
 *
 *   per article:          FIX | REWRITE | MERGE | DELETE | KEEP
 *   per uncovered feature: WRITE
 *
 * Every item carries its EVIDENCE: the audit findings, and for features the code files and UI
 * string keys. The script makes the first, deterministic pass; the help-center-auditor agent then
 * checks each item against the code and edits reasons, and the human approves.
 *
 * Nothing here is ever applied automatically:
 *   - DELETE is a proposal. The publisher cannot delete anything. The safest action is to archive
 *     (set `state: draft`); deleting stays a human click in Intercom.
 *   - MERGE and DELETE always need an explicit human yes (needs_confirmation: true).
 *
 * USAGE
 *   node correction-plan.mjs                              # from .help-center/help-center-audit.json
 *   node correction-plan.mjs --approve all --by "Jane"    # approve every item
 *   node correction-plan.mjs --approve P001,P004 --by "Jane"  # approve some; the rest are skipped
 *   node correction-plan.mjs --approve none --by "Jane"   # record that nothing was approved
 *   node correction-plan.mjs --render                     # re-render the .md after editing the .json
 *   node correction-plan.mjs --adhoc "Document the new export limit" --files a.md,b.md --by "Jane"
 *       # a one-off, already-approved plan for a few articles written outside an audit; publish
 *       # them with: publish.mjs --publish --plan <the printed file> a.md b.md
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { parseArgs, main, toPosix } from "./lib/cli.mjs";
import { loadConfig } from "./lib/config.mjs";
import { fail } from "./lib/messages.mjs";

const SPEC = { flags: ["--quiet", "--render"], options: ["--audit", "--out", "--approve", "--by", "--adhoc", "--files"] };

const FIX_TYPES = new Set(["broken-link", "links-to-draft", "no-collection", "non-question-title", "stale", "missing-translation", "other-workspace", "same-title-other-collection"]);

export function buildCorrectionPlan(audit) {
  const byArticle = new Map();
  for (const f of audit.findings) if (f.article_id) (byArticle.get(f.article_id) ?? byArticle.set(f.article_id, []).get(f.article_id)).push(f);
  const art = new Map(audit.articles.map((a) => [a.id, a]));
  const items = [];
  let n = 0;
  const id = () => `P${String(++n).padStart(3, "0")}`;

  // duplicate groups -> keeper + MERGE
  const mergeInto = new Map();
  const groups = [];
  for (const f of audit.findings.filter((x) => x.type === "duplicate")) groups.push(f.evidence.group.map((g) => g.id));
  for (const p of audit.near_duplicate_pairs ?? []) groups.push([p.a, p.b]);
  const rank = (x) => [art.get(x)?.state === "published" ? 1 : 0, art.get(x)?.words ?? 0, Date.parse(art.get(x)?.updated_at ?? 0) || 0];
  for (const g of groups) {
    const members = g.filter((x) => art.has(x) && !mergeInto.has(x));
    if (members.length < 2) continue;
    members.sort((a, b) => { const A = rank(a), B = rank(b); return B[0] - A[0] || B[1] - A[1] || B[2] - A[2]; });
    const [keeper, ...rest] = members;
    for (const r of rest) mergeInto.set(r, keeper);
  }

  for (const a of audit.articles) {
    const fs = byArticle.get(a.id) ?? [];
    const types = new Set(fs.map((f) => f.type));
    const reasons = fs.filter((f) => f.type !== "not-in-repo").map((f) => `${f.type}: ${f.message}`);
    let verdict = "KEEP";
    let action = "No change needed.";
    let needs_confirmation = false;
    if (mergeInto.has(a.id)) {
      verdict = "MERGE";
      action = `Merge anything unique into article ${mergeInto.get(a.id)} ("${art.get(mergeInto.get(a.id))?.title}"), then archive this one (state: draft) and point links at the keeper.`;
      needs_confirmation = true;
    } else if (types.has("orphan") && (types.has("empty") || a.state !== "published")) {
      verdict = "DELETE";
      action = "Matches no feature and is empty or unpublished. Confirm in the code that the feature is gone, then archive (state: draft) or delete it in Intercom by hand.";
      needs_confirmation = true;
    } else if (types.has("orphan")) {
      verdict = "DELETE";
      action = "Matches no feature in the code. Search the code for what it describes: if the feature was removed, archive it; if it was renamed, this becomes a REWRITE.";
      needs_confirmation = true;
    } else if (types.has("empty") || types.has("short")) {
      verdict = "REWRITE";
      action = "Rewrite from the code and the UI strings, using templates/article.md.";
    } else if ([...types].some((t) => FIX_TYPES.has(t))) {
      verdict = "FIX";
      action = fs.filter((f) => FIX_TYPES.has(f.type)).map((f) => fixFor(f)).join(" ");
    } else if (types.has("draft")) {
      action = "Draft: publish it after review, or leave it.";
    }
    items.push({
      id: id(), verdict, article_id: a.id, title: a.title, state: a.state, url: a.url, collection: a.collection_path, local_file: a.local_file,
      features: (a.features ?? []).map((f) => f.id), reasons, action, needs_confirmation,
      merge_into: mergeInto.get(a.id) ?? null, decision: null,
    });
  }

  for (const f of audit.findings.filter((x) => x.type === "uncovered-feature")) {
    items.push({
      id: id(), verdict: "WRITE", feature_id: f.feature_id, title: f.title, reasons: [f.message],
      evidence: f.evidence, action: `Write a new article for "${f.title}" from the code and strings below. Run find-existing.mjs first: never create a duplicate.`,
      needs_confirmation: false, decision: null,
    });
  }
  for (const f of audit.findings.filter((x) => x.type === "deleted-on-intercom")) {
    items.push({
      id: id(), verdict: "FIX", article_id: f.article_id, title: f.title, local_file: f.local_file, reasons: [f.message],
      action: "Deleted on Intercom. Ask the user: recreate it (publish --recreate-missing) or delete the local file.", needs_confirmation: true, decision: null,
    });
  }

  const order = { WRITE: 0, REWRITE: 1, MERGE: 2, FIX: 3, DELETE: 4, KEEP: 5 };
  items.sort((a, b) => order[a.verdict] - order[b.verdict]);
  const counts = {};
  for (const i of items) counts[i.verdict] = (counts[i.verdict] ?? 0) + 1;
  return { kind: "correction-plan", version: 1, generated_at: new Date().toISOString(), audit_generated_at: audit.generated_at, approved: false, approved_by: null, approved_at: null, counts, items };
}

function fixFor(f) {
  switch (f.type) {
    case "broken-link": return `Fix or remove the link ${f.evidence?.href ?? ""}.`;
    case "links-to-draft": return `Publish the linked draft or remove the link ${f.evidence?.href ?? ""}.`;
    case "no-collection": return "Put it in a collection (see the collections plan).";
    case "non-question-title": return "Retitle as the question a reader would search.";
    case "stale": return "Re-check every claim against the current code.";
    case "missing-translation": return `Add the missing translation (${f.message.replace(/^no /, "").replace(/ translation$/, "")}).`;
    case "other-workspace": return "Clear intercom_id/intercom_workspace in the local file, or publish with the matching token.";
    case "same-title-other-collection": return "Give each copy a distinct title, or merge them.";
    default: return f.message;
  }
}

export function renderCorrectionMarkdown(plan) {
  const L = ["<!-- GENERATED by correction-plan.mjs. Approvals are recorded through /intercom-help-center:plan or --approve. -->", "", "# Help Center correction plan", ""];
  L.push(`Status: **${plan.approved ? `approved by ${plan.approved_by} at ${plan.approved_at}` : "NOT APPROVED"}**`, "");
  L.push(Object.entries(plan.counts).map(([k, v]) => `${v} ${k}`).join(" · "), "");
  L.push("Nothing is applied automatically. DELETE and MERGE always need an explicit yes; deletion itself is a human click in Intercom.", "");
  for (const verdict of ["WRITE", "REWRITE", "MERGE", "FIX", "DELETE", "KEEP"]) {
    const rows = plan.items.filter((i) => i.verdict === verdict);
    if (!rows.length) continue;
    L.push(`## ${verdict} (${rows.length})`, "");
    for (const i of rows) {
      const d = i.decision ? ` · **${i.decision}**` : "";
      L.push(`### ${i.id} · ${i.title || i.feature_id}${d}`, "");
      if (i.article_id) L.push(`- Article: ${i.article_id} (${i.state ?? "?"})${i.collection ? ` in ${i.collection}` : ""}${i.url ? ` · [open](${i.url})` : ""}${i.local_file ? ` · file \`${i.local_file}\`` : ""}`);
      if (i.feature_id) L.push(`- Feature: \`${i.feature_id}\``);
      if (i.features?.length) L.push(`- Features: ${i.features.map((f) => `\`${f}\``).join(", ")}`);
      for (const r of i.reasons) L.push(`- Finding: ${r}`);
      if (i.evidence?.sources?.length) L.push(`- Code: ${i.evidence.sources.map((s) => `\`${s}\``).join(", ")}`);
      for (const s of i.evidence?.strings ?? []) L.push(`- UI string: \`${s}\``);
      L.push(`- Action: ${i.action}`);
      if (i.needs_confirmation) L.push("- Needs an explicit yes from a human.");
      L.push("");
    }
  }
  return L.join("\n");
}

/** Record approvals: "all", "none", or a comma list of item ids (the rest are skipped). */
export function applyApprovals(plan, which, by) {
  if (!by || !String(by).trim()) throw fail("IHC040", { path: "plan", detail: "approval needs --by \"<who approved it>\"" });
  const pick = String(which).trim().toLowerCase();
  const chosen = pick === "all" ? new Set(plan.items.map((i) => i.id)) : pick === "none" ? new Set() : new Set(String(which).split(",").map((s) => s.trim().toUpperCase()));
  const unknown = [...chosen].filter((c) => !plan.items.some((i) => i.id === c));
  if (unknown.length) throw fail("IHC040", { path: "plan", detail: `unknown item id(s): ${unknown.join(", ")}` });
  for (const i of plan.items) i.decision = chosen.has(i.id) ? "approved" : "skipped";
  plan.approved = chosen.size > 0;
  plan.approved_by = String(by).trim();
  plan.approved_at = new Date().toISOString();
  return plan;
}

export async function run(argv, deps = {}) {
  const a = parseArgs(argv, SPEC);
  if (a.flag("--help")) { console.log("usage: node correction-plan.mjs [--audit file] [--out file.json] [--approve all|none|P001,P002 --by <name>]"); return 0; }
  const { config, root } = loadConfig(deps.root);
  const out = resolve(root, a.opt("--out", config.planFile));
  if (a.opt("--adhoc")) {
    const by = a.opt("--by");
    const files = String(a.opt("--files", "")).split(",").map((s) => s.trim()).filter(Boolean);
    if (!by || !files.length) throw fail("IHC040", { path: "adhoc plan", detail: "--adhoc needs --files a.md,b.md and --by \"<who approved it>\"" });
    const missing = files.filter((f) => !existsSync(resolve(root, f)));
    if (missing.length) throw fail("IHC040", { path: "adhoc plan", detail: `files not found: ${missing.join(", ")}` });
    const d = new Date(deps.now ?? Date.now());
    const stamp = d.toISOString().replace(/[-:]/g, "").slice(0, 13);
    const path = resolve(root, config.outDir, `adhoc-${stamp}.plan.json`);
    const plan = {
      kind: "correction-plan", version: 1, adhoc: true, generated_at: d.toISOString(),
      approved: true, approved_by: String(by).trim(), approved_at: d.toISOString(),
      counts: { WRITE: files.length },
      items: files.map((f, i) => ({ id: `A${String(i + 1).padStart(3, "0")}`, verdict: "WRITE", title: f, local_file: toPosix(f), reasons: [String(a.opt("--adhoc"))], action: "Publish this reviewed article.", needs_confirmation: false, decision: "approved" })),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(plan, null, 2) + "\n");
    writeFileSync(path.replace(/\.json$/, ".md"), renderCorrectionMarkdown(plan));
    console.log(`[plan] ad-hoc plan approved by ${plan.approved_by}: ${toPosix(relative(root, path))}`);
    console.log(`       publish with: publish.mjs --publish --plan ${toPosix(relative(root, path))} ${files.join(" ")}`);
    return 0;
  }
  if (a.flag("--render")) {
    if (!existsSync(out)) throw fail("IHC039", { path: out });
    let plan;
    try { plan = JSON.parse(readFileSync(out, "utf8")); } catch (e) { throw fail("IHC040", { path: out, detail: e.message }); }
    writeFileSync(out.replace(/\.json$/, ".md"), renderCorrectionMarkdown(plan));
    console.log(`[plan] re-rendered ${out.replace(/\.json$/, ".md")}`);
    return 0;
  }
  if (a.opt("--approve")) {
    if (!existsSync(out)) throw fail("IHC039", { path: out });
    let plan;
    try { plan = JSON.parse(readFileSync(out, "utf8")); } catch (e) { throw fail("IHC040", { path: out, detail: e.message }); }
    applyApprovals(plan, a.opt("--approve"), a.opt("--by"));
    writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
    writeFileSync(out.replace(/\.json$/, ".md"), renderCorrectionMarkdown(plan));
    const approved = plan.items.filter((i) => i.decision === "approved").length;
    console.log(`[plan] ${approved} of ${plan.items.length} item(s) approved by ${plan.approved_by}`);
    return 0;
  }
  const auditPath = resolve(root, a.opt("--audit", join(config.outDir, "help-center-audit.json")));
  if (!existsSync(auditPath)) throw fail("IHC039", { path: auditPath });
  const plan = buildCorrectionPlan(JSON.parse(readFileSync(auditPath, "utf8")));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
  writeFileSync(out.replace(/\.json$/, ".md"), renderCorrectionMarkdown(plan));
  if (!a.flag("--quiet")) console.log(`[plan] ${Object.entries(plan.counts).map(([k, v]) => `${v} ${k}`).join(", ")} -> ${toPosix(relative(root, out.replace(/\.json$/, ".md")))} (NOT approved)`);
  return 0;
}

main(import.meta.url, run);
