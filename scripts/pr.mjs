#!/usr/bin/env node
/**
 * pr.mjs: put help-center changes on a branch and open a pull request, on the USER's repo,
 * without ever touching their other work.
 *
 *   detect-base            which branch PRs go to, with the evidence (read-only)
 *   set-base <branch>      save the answer to .help-center/config.json (pr.base)
 *   start --slug <topic>   refuse a dirty tree; create help-center/<date>-<topic> from the base
 *   finish --title <t> [--body-file f]
 *                          commit ONLY help-center paths, check head vs base, push (never --force),
 *                          open the PR with gh; else print the compare URL; else stay local
 *
 * HOW THE BASE IS CHOSEN (the same order the skill follows, see references/pull-requests.md)
 *   1. config pr.base, set once at setup and confirmed by the user.
 *   2. otherwise, signals, each recorded as evidence:
 *        a. the repo's own instructions (CLAUDE.md, AGENTS.md, CONTRIBUTING.md, PR template, docs)
 *        b. the base of recently merged PRs (release PRs such as dev -> main are ignored)
 *        c. long-lived branches on the remote (dev, develop, development, next, trunk, staging)
 *        d. the default branch (gh, or refs/remotes/origin/HEAD)
 *        e. branch protection, as a hint that the default is release-only
 *   3. signals agree -> that branch. They conflict or are empty -> exit 3 and ASK the user once.
 *      Never silently pick the production branch when a working branch exists.
 *
 * Exit codes: 0 ok · 1 refused (see message) · 3 needs a human decision (base undecided).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs, main, toPosix } from "./lib/cli.mjs";
import { loadConfig, saveConfig } from "./lib/config.mjs";
import { makeGit, compareUrl } from "./lib/git.mjs";
import { fail, report } from "./lib/messages.mjs";

const SPEC = { flags: ["--json", "--yes"], options: ["--slug", "--title", "--body-file", "--base", "--remote"] };
export const WORKING = ["dev", "develop", "development", "next", "trunk", "staging"];
const RELEASE = ["main", "master", "production", "prod", "release"];

// ── signals ─────────────────────────────────────────────────────────────────────────────────
const DOC_FILES = ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md", ".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/CONTRIBUTING.md", "README.md"];
const DOC_RE = /(?:PRs?\s+(?:in)?to|pull requests?\s+(?:in)?to|open\s+(?:PRs?|pull requests?)\s+against|base\s+branch(?:\s+is)?|target\s+branch(?:\s+is)?|PR\s+base(?:\s+is)?|merge\s+(?:PRs?\s+)?into)\s*[:`'"*]*\s*([A-Za-z0-9._/-]+)/gi;

export function docSignals(root, branches) {
  const out = [];
  const files = [...DOC_FILES];
  if (existsSync(join(root, "docs"))) for (const f of readdirSync(join(root, "docs"))) if (/\.md$/i.test(f)) files.push(`docs/${f}`);
  for (const f of [...new Set(files)]) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(DOC_RE)) {
      const b = m[1].replace(/[`'".,;:)*]+$/, "");
      if (branches.length && !branches.includes(b)) continue;
      if (!branches.length && !/^[a-z][\w./-]*$/.test(b)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      out.push({ branch: b, file: f, line, text: m[0].replace(/[`*]/g, "").trim().slice(0, 100) });
    }
  }
  return out;
}

export function mergedSignal(prs) {
  if (!Array.isArray(prs) || !prs.length) return null;
  const longLived = new Set([...WORKING, ...RELEASE]);
  const work = prs.filter((p) => !longLived.has(p.headRefName)); // drop release PRs (dev -> main)
  const counts = {};
  for (const p of work) counts[p.baseRefName] = (counts[p.baseRefName] ?? 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return null;
  const [branch, n] = sorted[0];
  return { branch, share: n / work.length, count: n, total: work.length, counts };
}

/** Pure decision from the collected signals, so it can be tested without git or gh. */
export function decideBase(s) {
  const evidence = [];
  if (s.configBase) return { base: s.configBase, confident: true, conflict: false, candidates: [s.configBase], evidence: [`config pr.base = ${s.configBase} (set at setup)`] };
  const votes = new Map();
  const vote = (b, w, why) => { if (!b) return; votes.set(b, (votes.get(b) ?? 0) + w); evidence.push(why); };
  for (const d of s.docs ?? []) vote(d.branch, 3, `${d.file}:${d.line} says "${d.text}"`);
  if (s.merged && s.merged.total >= 3 && s.merged.share >= 0.6) vote(s.merged.branch, 3, `${s.merged.count} of the last ${s.merged.total} merged PRs went to ${s.merged.branch}`);
  else if (s.merged?.total) evidence.push(`merged PRs are split: ${JSON.stringify(s.merged.counts)}`);
  const working = (s.remoteBranches ?? []).filter((b) => WORKING.includes(b));
  for (const w of working) vote(w, 1, `long-lived branch "${w}" exists on the remote`);
  if (s.defaultBranch) vote(s.defaultBranch, 1, `the default branch is ${s.defaultBranch}`);
  if (s.defaultProtected && working.length) evidence.push(`${s.defaultBranch} is protected: probably release-only`);

  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const candidates = ranked.map(([b]) => b);
  if (!ranked.length) return { base: null, confident: false, conflict: false, candidates: [], evidence: [...evidence, "no signal found"] };
  if (ranked.length === 1) {
    const [b] = ranked[0];
    // Only the default branch spoke. That is fine when there is no working branch.
    return { base: b, confident: true, conflict: false, candidates, evidence };
  }
  const [top, second] = ranked;
  const strongOnTop = (s.docs ?? []).some((d) => d.branch === top[0]) || (s.merged?.branch === top[0] && s.merged.share >= 0.6 && s.merged.total >= 3);
  const strongElsewhere = (s.docs ?? []).some((d) => d.branch !== top[0]) || (s.merged && s.merged.branch !== top[0] && s.merged.share >= 0.6 && s.merged.total >= 3);
  if (strongOnTop && !strongElsewhere && top[1] >= second[1] + 2) return { base: top[0], confident: true, conflict: false, candidates, evidence };
  return { base: null, confident: false, conflict: true, candidates, evidence };
}

export function collectSignals({ g, root, config, remote }) {
  const remoteBranches = g.remoteBranches(remote);
  const remotes = g.remotes();
  const origin = remotes.find((r) => r.name === remote) ?? null;
  const slug = origin?.kind === "github" ? `${origin.owner}/${origin.repo}` : null;
  let defaultBranch = null, defaultProtected = null, merged = null, viewer = null;
  const ghOk = slug && g.ghAvailable();
  if (ghOk) {
    const info = g.ghRepo(slug);
    defaultBranch = info?.defaultBranchRef?.name ?? null;
    viewer = info?.viewerPermission ?? null;
    merged = mergedSignal(g.ghMergedBases(slug));
    if (defaultBranch) defaultProtected = g.ghProtected(slug, defaultBranch);
  }
  if (!defaultBranch) defaultBranch = g.originHead(remote);
  if (!origin) {
    // No remote: PRs are impossible, but a local branch still needs a base. Use the checked-out
    // long-lived branch (main, master, dev...) when there is exactly one obvious choice.
    const cur = g.currentBranch();
    const local = [...WORKING, ...RELEASE].filter((b) => g.localBranchExists(b));
    defaultBranch = local.length === 1 ? local[0] : [...WORKING, ...RELEASE].includes(cur) ? cur : null;
  }
  return {
    configBase: config.pr.base,
    docs: docSignals(root, remoteBranches),
    merged,
    remoteBranches,
    defaultBranch,
    defaultProtected,
    origin,
    slug,
    ghOk: Boolean(ghOk),
    viewer,
  };
}

// ── commands ────────────────────────────────────────────────────────────────────────────────
export async function run(argv, deps = {}) {
  const a = parseArgs(argv, SPEC);
  const [cmd, arg] = a.positionals;
  if (a.flag("--help") || !cmd) { console.log("usage: node pr.mjs detect-base [--json] | set-base <branch> | start --slug <topic> | finish --title <t> [--body-file f]"); return cmd ? 0 : 1; }
  const { config, root } = loadConfig(deps.root);
  const g = deps.git ?? makeGit(undefined, root);
  const log = (s) => console.log(s);
  const remote = a.opt("--remote", config.pr.remote ?? "origin");
  const now = deps.now ?? Date.now();

  if (cmd === "set-base") {
    if (!arg) throw fail("IHC091", { option: "set-base needs a branch name" });
    config.pr.base = arg;
    config.pr.baseEvidence = [`chosen by the user on ${new Date(now).toISOString().slice(0, 10)}`];
    saveConfig(root, config);
    log(`[pr] base saved: ${arg} (.help-center/config.json)`);
    return 0;
  }

  if (!g.isRepo()) throw fail("IHC060");
  const gitRoot = g.root() ?? root;

  if (cmd === "detect-base") {
    const s = collectSignals({ g, root: gitRoot, config, remote });
    const d = decideBase(s);
    if (a.flag("--json")) console.log(JSON.stringify({ ...d, signals: { ...s, origin: s.origin && { host: s.origin.host, owner: s.origin.owner, repo: s.origin.repo, kind: s.origin.kind } } }, null, 2));
    else {
      log(d.base ? `base: ${d.base}${d.confident ? "" : " (not confident)"}` : `base: UNDECIDED${d.conflict ? " (signals conflict)" : ""}`);
      for (const e of d.evidence) log(`  · ${e}`);
      if (!d.base) report("IHC062", { candidates: d.candidates.join(", ") || "none" });
    }
    return d.base ? 0 : 3;
  }

  const prefix = config.pr.branchPrefix || "help-center/";
  // The plugin's own files: the only paths it ever stages, and the only uncommitted changes it
  // carries onto a new branch. Anything else uncommitted belongs to the user and stops the run.
  const allowed = [config.articlesDir, ".help-center", "help-articles", config.manifest].filter(Boolean).map((p) => toPosix(relative(gitRoot, resolve(root, p))));
  const isOurs = (f) => allowed.some((p) => f === p || f.startsWith(p.replace(/\/$/, "") + "/"));
  const s = collectSignals({ g, root: gitRoot, config, remote });
  const decided = decideBase(s);
  const base = a.opt("--base", decided.base);
  const hasRemote = Boolean(s.origin);

  if (cmd === "start") {
    const dirty = g.dirtyFiles().filter((f) => !isOurs(f));
    if (dirty.length) throw fail("IHC061", { files: dirty.slice(0, 10).join(", ") + (dirty.length > 10 ? ` (+${dirty.length - 10} more)` : "") });
    if (!base) { report("IHC062", { candidates: decided.candidates.join(", ") || "none" }); for (const e of decided.evidence) log(`  · ${e}`); return 3; }
    if (hasRemote && !s.remoteBranches.includes(base)) throw fail("IHC063", { base, remote });
    const slug = String(a.opt("--slug", "update")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "update";
    const d = new Date(now);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let branch = `${prefix}${date}-${slug}`;
    // never reuse a branch that exists (it may hold someone else's commits): add a suffix
    for (let i = 2; g.localBranchExists(branch) || s.remoteBranches.includes(branch); i++) branch = `${prefix}${date}-${slug}-${i}`;
    if (hasRemote) g.git("fetch", remote, base);
    const from = hasRemote ? `${remote}/${base}` : base;
    const r = g.git("switch", "-c", branch, from);
    if (r.code !== 0) throw fail("IHC072", { detail: `git switch -c ${branch} ${from}: ${r.stderr}` });
    log(`[pr] on new branch ${branch} (from ${from}). Base: ${base} because ${decided.evidence[0] ?? "it was given"}.`);
    return 0;
  }

  if (cmd === "finish") {
    const head = g.currentBranch();
    if (!head || !head.startsWith(prefix)) throw fail("IHC066", { branch: head, prefix });
    if (!base) { report("IHC062", { candidates: decided.candidates.join(", ") || "none" }); return 3; }
    if (head === base) throw fail("IHC064", { branch: head });

    // stage ONLY help-center paths, never local working files (the snapshot holds every article
    // body, drafts included); list anything else and leave it alone
    const changed = g.dirtyFiles();
    const localOnly = (f) => /(^|\/)(snapshot\.json|session-[^/]*\.json|journal\.json|pr-body\.md)$/.test(f);
    const mine = changed.filter((f) => isOurs(f) && !localOnly(f));
    const others = changed.filter((f) => !mine.includes(f));
    if (others.length) log(`[pr] not included (outside help-center paths): ${others.join(", ")}`);
    if (mine.length) {
      const add = g.git("add", "--", ...mine);
      if (add.code !== 0) throw fail("IHC072", { detail: `git add: ${add.stderr}` });
      const title = a.opt("--title", "Update help center articles");
      const c = g.git("commit", "-m", title, "--", ...mine);
      if (c.code !== 0) throw fail("IHC072", { detail: `git commit: ${c.stderr || c.stdout}` });
    } else {
      const ahead = hasRemote ? g.behindAhead(base, head, remote) : null;
      if (!ahead || !ahead.ahead) throw fail("IHC067");
    }

    if (!hasRemote) { report("IHC068", { branch: head }); return 0; }
    if (!s.remoteBranches.includes(base)) throw fail("IHC063", { base, remote });
    g.git("fetch", remote, base);
    const ba = g.behindAhead(base, head, remote);
    if (ba && ba.behind > 0) throw fail("IHC065", { head, base, behind: ba.behind, remote });

    const files = g.git("diff", "--name-only", `${remote}/${base}...${head}`).stdout.split("\n").filter(Boolean);
    log(`[pr] ${head} → ${base}`);
    log(`[pr] why ${base}: ${decided.evidence.join("; ") || "given with --base"}`);
    log(`[pr] files: ${files.join(", ") || "(none)"}`);

    // where to push: origin if we can, else the user's fork
    let pushRemote = remote;
    let headRef = head;
    const origin = s.origin;
    let account = null;
    if (origin.kind === "github" && s.ghOk) {
      account = g.ghAccount();
      if (account && origin.owner && account.toLowerCase() !== origin.owner.toLowerCase()) report("IHC074", { account, owner: origin.owner }, { withFix: false });
      const canPush = ["WRITE", "MAINTAIN", "ADMIN"].includes(String(s.viewer ?? "").toUpperCase());
      if (s.viewer && !canPush) {
        const fork = g.remotes().find((r) => r.kind === "github" && r.name !== remote && r.repo === origin.repo && r.owner?.toLowerCase() === account?.toLowerCase());
        if (!fork) throw fail("IHC071", { account: account ?? "this account", repo: s.slug });
        pushRemote = fork.name;
        headRef = `${fork.owner}:${head}`;
      }
    }
    const push = g.git("push", "-u", pushRemote, head);
    if (push.code !== 0) throw fail("IHC072", { detail: push.stderr || push.stdout });

    const url = compareUrl(origin, base, head);
    if (origin.kind === "local") { report("IHC075", { branch: head, url: origin.url }, { withFix: false }); return 0; }
    if (origin.kind !== "github") { report("IHC070", { host: origin.host ?? "this host", url: url ?? "(open your host's merge-request page)" }, { withFix: false }); return 0; }
    if (!s.ghOk) { report("IHC069", { detail: "gh missing or not logged in", url }, { withFix: false }); return 0; }
    const args = ["pr", "create", "--repo", s.slug, "--base", base, "--head", headRef, "--title", a.opt("--title", "Update help center articles")];
    if (a.opt("--body-file")) args.push("--body-file", a.opt("--body-file")); else args.push("--body", "Help center updates. See .help-center/help-center-plan.md for the plan items and evidence.");
    if (config.pr.draft) args.push("--draft");
    for (const r of config.pr.reviewers ?? []) args.push("--reviewer", r);
    for (const l of config.pr.labels ?? []) args.push("--label", l);
    const pr = g.gh(...args);
    if (pr.code !== 0) { report("IHC073", { detail: pr.stderr || pr.stdout }); log(`  compare: ${url}`); return 1; }
    log(`[pr] opened: ${pr.stdout}`);
    return 0;
  }

  throw fail("IHC091", { option: cmd });
}

main(import.meta.url, run);
