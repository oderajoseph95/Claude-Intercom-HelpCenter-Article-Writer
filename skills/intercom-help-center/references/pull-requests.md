# Pull requests on the user's repo

Help-center changes reach the user's repo only through a branch and a pull request. Never commit on their current branch, never touch their other branches, never stash their work, never force-push.

## 1. Which branch the PR goes to (the base)

**Config first.** If `.help-center/config.json` has `pr.base`, use it. Setup is where it gets set, and the user confirms it once.

**Otherwise detect**, and record the evidence (`node S/pr.mjs detect-base` does all of this and prints it):

| # | Signal | How | Weight |
|---|---|---|---|
| a | The repo's own instructions | CLAUDE.md, AGENTS.md, CONTRIBUTING.md, `.github/pull_request_template.md`, README and docs/*.md, for "PR into", "open PRs against", "base branch", "target branch", "merge into" followed by a branch that exists | strong |
| b | Merged PR history | `gh pr list --state merged --limit 30 --json baseRefName,headRefName`. The most common base, ignoring release PRs whose head is a long-lived branch (dev → main). Counts when 3+ PRs and 60%+ share | strong |
| c | Long-lived branches on the remote | dev, develop, development, next, trunk, staging | weak |
| d | The default branch | `gh repo view --json defaultBranchRef`, or `git symbolic-ref refs/remotes/origin/HEAD` without gh | weak |
| e | Branch protection | `gh api repos/<owner>/<repo>/branches/<default>` → protected: a hint the default is release-only | hint |

**Decide:**

- One strong signal (or several agreeing) and nothing strong against it → use it.
- Only the default branch spoke and no working branch exists → use the default (a trunk-based repo).
- **The default is main but a working branch exists and nothing strong says which** → ASK. Never silently pick the production branch when a working branch exists.
- Strong signals disagree (docs say main, history says dev) → ASK.
- Nothing found → ASK.

**Ask once**, with the evidence, using AskUserQuestion:

> Which branch should help-center pull requests go to? Evidence: CONTRIBUTING.md:12 says "open PRs against dev"; 24 of the last 30 merged PRs went to dev; the default branch is main (protected).
> Options: **dev (recommended)** · main · another branch

Then save it: `node S/pr.mjs set-base <branch>` (writes `pr.base` to config). Exit code 3 from `pr.mjs` always means "a human must decide the base".

## 2. Start a branch, before writing files

```bash
node S/pr.mjs start --slug "export-articles"
```

- Refuses a dirty working tree (IHC061). Do not stash for the user: ask them to commit or stash their own changes, then retry.
- Creates `<pr.branchPrefix><date>-<slug>` (default `help-center/2026-09-29-export-articles`) from `origin/<base>` after a fetch. If that name exists, it adds `-2`, `-3`: it never reuses a branch that may hold someone else's commits.
- Exit 3 if the base is undecided: ask, `set-base`, retry.

## 3. Finish: commit, check, push, open

```bash
node S/pr.mjs finish --title "Update export articles" --body-file .help-center/pr-body.md
```

Before running it, tell the user: **head → base, the changed files, and why that base.** It then:

1. Refuses unless the current branch starts with the prefix (IHC066): it only commits on branches it created.
2. Stages and commits **only** help-center paths: the articles folder, `.help-center/`, the manifest. Other changed files are listed and left alone.
3. Stops if head == base (IHC064), the base is missing on the remote (IHC063), or the head is behind the base (IHC065). For "behind", offer `git merge origin/<base>` or a rebase; the user decides. It never rebases or force-pushes.
4. Pushes with `git push -u` (never `--force`).
5. Opens the PR with `gh pr create --base <base> --draft` (plus `pr.reviewers`, `pr.labels`).

**Write the PR body** to a file first:

```markdown
## What changed
- Updated "How do I export my orders to CSV?" (article 1234): the row limit is 10,000 (src/export.js:1), not 5,000.
- New article: "How do I tag orders a customer edited?" for feature order-tags.

## Plan items addressed
P001 WRITE order-tags · P004 FIX broken link in article 88

## Evidence
Every claim is traced in each article's `sources:`. Reviewer: help-center-reviewer, all claims PASS.

## Not verified
- The screenshots were not re-taken.

Nothing is published to Intercom by merging this. Publishing is a separate, reviewed step.
```

## When the setup is not GitHub + gh

| Situation | What happens |
|---|---|
| GitHub, gh not installed or not logged in | branch pushed; compare URL printed (IHC069) |
| gh logged in as another account than the repo owner | a note (IHC074); fine if that account can push |
| account cannot push to the repo | pushes to the user's fork (a remote whose owner is the gh account) and opens a cross-repo PR (`--head owner:branch`); with no fork, stops and says how to create one (IHC071) |
| GitLab, Bitbucket, other host | branch pushed; merge-request/compare URL printed (IHC070); no automatic PR |
| no remote | branch stays local (IHC068); nothing pushed |
| no git | the PR step is unavailable (IHC060); write and publish still work |
| monorepo, articles in a subfolder | paths are resolved from the git root; only the configured folders are committed |
