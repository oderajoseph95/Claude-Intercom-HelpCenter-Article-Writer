/**
 * git.mjs: every git and gh call the plugin makes, behind one injectable runner.
 *
 * The runner is swapped for a fake in the selftest, so the PR flow is tested against scripted
 * git/gh output (no gh, wrong account, missing base, forks, GitLab remotes...) without a network.
 *
 * Hard rules, enforced here rather than trusted to callers:
 *   - never `push --force`, never `reset`, never `stash`, never `checkout` an existing branch
 *     with local changes, never delete a branch.
 */
import { spawnSync } from "node:child_process";

export function defaultRunner(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  if (r.error) return { code: 127, stdout: "", stderr: r.error.message };
  return { code: r.status ?? 1, stdout: (r.stdout ?? "").replace(/\s+$/, ""), stderr: (r.stderr ?? "").trim() };
}

export function makeGit(run = defaultRunner, cwd = process.cwd()) {
  const git = (...args) => {
    if (args[0] === "push" && args.some((a) => /^(--force|--force-with-lease|-f)$/.test(a))) throw new Error("refusing git push --force");
    if (["reset", "stash", "clean"].includes(args[0])) throw new Error(`refusing git ${args[0]}`);
    return run("git", args, { cwd });
  };
  const gh = (...args) => run("gh", args, { cwd });
  const ok = (r) => r.code === 0;

  const api = {
    run, git, gh,
    isRepo: () => ok(git("rev-parse", "--is-inside-work-tree")) ,
    root: () => { const r = git("rev-parse", "--show-toplevel"); return ok(r) ? r.stdout : null; },
    currentBranch: () => { const r = git("rev-parse", "--abbrev-ref", "HEAD"); return ok(r) ? r.stdout : null; },
    dirtyFiles: () => {
      const r = git("status", "--porcelain", "--untracked-files=all");
      if (!ok(r)) return [];
      return r.stdout.split("\n").filter(Boolean).map((l) => l.slice(3).trim().replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1"));
    },
    remotes: () => {
      const r = git("remote", "-v");
      if (!ok(r)) return [];
      const seen = new Map();
      for (const line of r.stdout.split("\n")) {
        const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(line);
        if (m && !seen.has(m[1])) seen.set(m[1], { name: m[1], url: m[2], ...parseRemote(m[2]) });
      }
      return [...seen.values()];
    },
    originHead: (remote = "origin") => {
      const r = git("symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`);
      return ok(r) ? r.stdout.replace(new RegExp(`^${remote}/`), "") : null;
    },
    remoteBranches: (remote = "origin") => {
      const r = git("ls-remote", "--heads", remote);
      if (!ok(r)) {
        const l = git("branch", "-r", "--format=%(refname:short)");
        return ok(l) ? l.stdout.split("\n").filter((b) => b.startsWith(remote + "/") && !b.endsWith("/HEAD")).map((b) => b.slice(remote.length + 1)) : [];
      }
      return r.stdout.split("\n").map((l) => l.split(/\s+/)[1]).filter(Boolean).map((ref) => ref.replace(/^refs\/heads\//, ""));
    },
    localBranchExists: (b) => ok(git("rev-parse", "--verify", "--quiet", `refs/heads/${b}`)),
    behindAhead: (base, head, remote = "origin") => {
      const r = git("rev-list", "--left-right", "--count", `${remote}/${base}...${head}`);
      if (!ok(r)) return null;
      const [behind, ahead] = r.stdout.split(/\s+/).map(Number);
      return { behind, ahead };
    },
    authorsOn: (branch, base) => {
      const r = git("log", `${base}..${branch}`, "--format=%ae");
      return ok(r) ? [...new Set(r.stdout.split("\n").filter(Boolean))] : [];
    },
    userEmail: () => { const r = git("config", "user.email"); return ok(r) ? r.stdout : null; },

    // gh
    ghAvailable: () => ok(gh("--version")),
    ghAccount: () => {
      const r = gh("api", "user", "--jq", ".login");
      return ok(r) && r.stdout ? r.stdout : null;
    },
    ghRepo: (slug) => {
      const r = gh("repo", "view", ...(slug ? [slug] : []), "--json", "nameWithOwner,defaultBranchRef,viewerPermission,isFork,parent");
      if (!ok(r)) return null;
      try { return JSON.parse(r.stdout); } catch { return null; }
    },
    ghMergedBases: (slug, limit = 30) => {
      const r = gh("pr", "list", ...(slug ? ["--repo", slug] : []), "--state", "merged", "--limit", String(limit), "--json", "baseRefName,headRefName");
      if (!ok(r)) return null;
      try { return JSON.parse(r.stdout); } catch { return null; }
    },
    ghProtected: (slug, branch) => {
      const r = gh("api", `repos/${slug}/branches/${branch}`, "--jq", ".protected");
      return ok(r) ? r.stdout === "true" : null;
    },
  };
  return api;
}

/** git@github.com:o/r.git, https://github.com/o/r(.git), ssh://git@host:22/o/r -> parts. */
export function parseRemote(url) {
  const s = String(url ?? "").trim();
  let m = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)([^\s]+?)(?:\.git)?\/?$/.exec(s);
  let host, path, protocol;
  if (m && !/^\w+:\/\//.test(s)) { host = m[1]; path = m[2]; protocol = "ssh"; }
  else {
    m = /^(\w+):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(s);
    if (!m) {
      // a local path or file:// remote (a bare repo on disk, a network share)
      const local = /^(file:\/\/|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(s);
      return { host: null, owner: null, repo: s.split(/[\\/]/).pop()?.replace(/\.git$/, "") ?? null, kind: local ? "local" : "unknown", protocol: local ? "file" : null };
    }
    protocol = m[1]; host = m[2]; path = m[3];
  }
  const parts = path.split("/");
  const repo = parts.pop();
  const owner = parts.join("/");
  const kind = /github\.com$/i.test(host) ? "github" : /gitlab/i.test(host) ? "gitlab" : /bitbucket/i.test(host) ? "bitbucket" : "other";
  return { host, owner, repo, kind, protocol };
}

export function compareUrl({ kind, host, owner, repo }, base, head) {
  const h = encodeURIComponent(head);
  const b = encodeURIComponent(base);
  if (kind === "github") return `https://${host}/${owner}/${repo}/compare/${base}...${head}?expand=1`;
  if (kind === "gitlab") return `https://${host}/${owner}/${repo}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${h}&merge_request%5Btarget_branch%5D=${b}`;
  if (kind === "bitbucket") return `https://${host}/${owner}/${repo}/pull-requests/new?source=${h}&dest=${b}`;
  return null;
}
