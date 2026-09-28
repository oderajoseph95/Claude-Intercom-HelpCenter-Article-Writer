/**
 * A scripted stand-in for lib/git.mjs, so the PR flow is tested against every repo shape
 * (no gh, wrong account, fork, missing base, behind base, GitLab, no remote) without a network.
 */
import { parseRemote } from "../scripts/lib/git.mjs";

export function createFakeGit(o = {}) {
  const s = {
    isRepo: o.isRepo ?? true,
    root: o.root ?? "/repo",
    branch: o.branch ?? "main",
    dirty: [...(o.dirty ?? [])],
    remotes: (o.remotes ?? [{ name: "origin", url: "git@github.com:acme/app.git" }]).map((r) => ({ ...r, ...parseRemote(r.url) })),
    remoteBranches: o.remoteBranches ?? ["main", "dev"],
    localBranches: new Set(o.localBranches ?? ["main"]),
    originHead: o.originHead ?? "main",
    behind: o.behind ?? 0,
    gh: o.gh ?? { installed: true, account: "acme-dev", repo: { nameWithOwner: "acme/app", defaultBranchRef: { name: "main" }, viewerPermission: "WRITE" }, merged: [], protected: false },
    pushFails: o.pushFails ?? false,
    prFails: o.prFails ?? false,
    calls: [],
  };
  const r = (code = 0, stdout = "", stderr = "") => ({ code, stdout, stderr });
  const g = {
    state: s,
    git: (...args) => {
      s.calls.push(["git", ...args]);
      if (args[0] === "push" && args.some((x) => /^(--force|-f|--force-with-lease)$/.test(x))) throw new Error("refusing git push --force");
      if (["reset", "stash", "clean"].includes(args[0])) throw new Error(`refusing git ${args[0]}`);
      if (args[0] === "switch" && args[1] === "-c") { s.branch = args[2]; s.localBranches.add(args[2]); return r(); }
      if (args[0] === "add") return r();
      if (args[0] === "commit") { const paths = args.slice(args.indexOf("--") + 1); s.committed = paths; s.dirty = s.dirty.filter((d) => !paths.includes(d)); return r(0, "[branch] commit"); }
      if (args[0] === "push") return s.pushFails ? r(1, "", "remote: permission denied") : r(0, "pushed");
      if (args[0] === "diff") return r(0, (s.committed ?? []).join("\n"));
      return r();
    },
    gh: (...args) => {
      s.calls.push(["gh", ...args]);
      if (args[0] === "pr" && args[1] === "create") return s.prFails ? r(1, "", "a pull request already exists") : r(0, "https://github.com/acme/app/pull/42");
      return r();
    },
    isRepo: () => s.isRepo,
    root: () => s.root,
    currentBranch: () => s.branch,
    dirtyFiles: () => [...s.dirty],
    remotes: () => s.remotes,
    originHead: () => s.originHead,
    remoteBranches: () => [...s.remoteBranches],
    localBranchExists: (b) => s.localBranches.has(b),
    behindAhead: () => ({ behind: s.behind, ahead: 1 }),
    authorsOn: () => [],
    userEmail: () => "dev@example.com",
    ghAvailable: () => Boolean(s.gh?.installed),
    ghAccount: () => s.gh?.account ?? null,
    ghRepo: () => s.gh?.repo ?? null,
    ghMergedBases: () => s.gh?.merged ?? null,
    ghProtected: () => s.gh?.protected ?? null,
  };
  return g;
}
