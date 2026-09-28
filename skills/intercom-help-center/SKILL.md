---
name: intercom-help-center
description: Keep an Intercom Help Center true to the product's code. Audits every live article, maps articles to the features and UI strings in the repo, finds duplicates, broken links, stale or orphan articles and shipped features with no article, proposes a collection structure, writes and fixes articles grounded in code (never invented), opens a pull request on the user's repo, and publishes to Intercom only what a human approved, with a dry run, a cap and drift protection. Use when the user wants to audit, clean up, reorganize, write, update, translate or publish Intercom help articles, set up help-center CI, or check the Help Center against the code.
when_to_use: "Trigger phrases: help center, help article, knowledge base, Intercom articles, docs for customers, which features have no article, publish to Intercom, articles are out of date, reorganize collections, help center audit."
---

# Intercom Help Center

A wrong help article is worse than a missing one, because the reader acts on it. Everything in this skill serves one rule: **every sentence an article states comes from the code or the UI strings, and nothing reaches Intercom that a human did not approve.**

## Where things are

The scripts live in `${CLAUDE_PLUGIN_ROOT}/scripts/` and the templates in `${CLAUDE_PLUGIN_ROOT}/templates/`. If those paths do not exist (a manual install without the plugin), use `${CLAUDE_SKILL_DIR}/scripts/` and `${CLAUDE_SKILL_DIR}/templates/`; in that mode the three agents are not installed, so do their jobs yourself by the same rules (the reviewer's job most of all: check every claim against the code before anything is committed). Below, `S` means that folder. Run every script from the user's repo root, and quote the path (`node "S/audit.mjs"`): plugin folders often contain spaces on Windows and macOS. Node 18+ is the only requirement. Every script takes `--help`.

| Script | Does | Touches Intercom? |
|---|---|---|
| `S/doctor.mjs` | Detects repo, stack, strings, features, GitHub access, PR base, Intercom region and workspace. `--write` saves `.help-center/config.json` | reads `/me` only |
| `S/audit.mjs` | Reads every collection and article, compares with the code, writes `help-center-audit.md/.json` | **read-only** |
| `S/plan-collections.mjs` | Proposes a collection tree from features and places every article | no |
| `S/correction-plan.mjs` | Turns the audit into `help-center-plan.md/.json`: FIX / REWRITE / MERGE / DELETE / KEEP / WRITE with evidence; records approvals | no |
| `S/find-existing.mjs` | **The pre-write check.** UPDATE / UPDATE-LOCAL / AMBIGUOUS / CREATE | reads (snapshot) |
| `S/pull.mjs` | Imports a live article as markdown so it can be updated, not duplicated | reads |
| `S/publish.mjs` | Dry run by default; publishes approved articles; applies an approved collections plan | writes only with `--publish` |
| `S/pr.mjs` | Branch, commit only help-center files, push, open the PR against the right base | no |
| `S/coverage-check.mjs` | CI gate: every shipped feature has its articles, or a ticketed reason | no |

Reference files (read the one you need, when you need it):
[pre-write check](references/pre-write-check.md) · [writing rules](references/writing-rules.md) · [review checklist](references/review-checklist.md) · [pull requests and the PR base](references/pull-requests.md) · [publishing, drift and errors](references/publishing.md) · [collections](references/collections.md) · [asking the user](references/questions.md) · [using Intercom's MCP server](references/intercom-mcp.md)

## Asking the user

Ask only what cannot be detected, ask it once, and save the answer in `.help-center/config.json`. Use the AskUserQuestion tool (one question, 2 to 4 concrete options, the recommended one first, the evidence in the question text). Always ask before: confirming setup detections, choosing a PR base when signals conflict, approving the collection tree, approving plan items (all / pick / none), resolving drift (keep Intercom's / take the repo's / merge), and **any deletion**. If AskUserQuestion is not available (non-interactive run, CI, `--yes`), take the safe default: dry run, no deletion, no merge, no publish, and say what you would have asked. Details and exact wordings: [references/questions.md](references/questions.md).

## The loop

```
setup → audit → categorize → plan → (approve) → fix/write → review → PR → publish (approved only) → parity → CI
```

Start wherever the user is, but never skip a guard: for "write one article" you still run the pre-write check, the review and a dry run.

### 0. Setup (first run, or when `.help-center/config.json` is missing)

Run `/intercom-help-center:setup`, or do what it does: `node S/doctor.mjs --json`, show the user what was detected, confirm the features source, the strings source, the Intercom workspace and the PR base (ask only where there is doubt), then `node S/doctor.mjs --write --strings <paths> --features <path> --base <branch>`. If there is no coverage manifest, offer `--scaffold-manifest`.

Decision points:
- **No token** (`INTERCOM_API_TOKEN` unset): the audit and publish cannot run. Everything local still works (writing, coverage gate, PR). Point to docs/SETUP.md step 3; never ask the user to paste the token into the chat or a file.
- **Token rejected in the configured region**: doctor tries us, eu, au and reports the right one; save it.
- **No i18n strings file**: labels live in components. You read button text from the component files and cite those files in `sources:`.
- **Monorepo**: strings and features may be per package; `strings` accepts several paths. The config lives at the repo root.

### 1. Audit (read-only)

`node S/audit.mjs`. It reads every page of collections and articles, so it is safe on thousands of articles (429s are retried with backoff). Summarise `help-center-audit.md` for the user: totals, coverage, then the top findings by impact. Do not dump the whole report.

If `IHC023` (no feature source) appears, feature coverage and orphans were not checked: say so, and offer setup.

### 2. Categorize

`node S/plan-collections.mjs` proposes one collection per feature (or per `area`), plus Getting started, Billing and Troubleshooting, and places every article (MOVE / KEEP / REVIEW). Show the tree, then ask the user to approve it, edit it, or skip restructuring. Edits go into `collectionMap` in config (`{"feature-id": "Collection › Section"}`) and you re-run. On approval: `node S/plan-collections.mjs --approve --by "<their name>"`. See [references/collections.md](references/collections.md).

### 3. Correction plan

`node S/correction-plan.mjs` writes `help-center-plan.md`. Then check each item against the code (delegate to the `help-center-auditor` agent for more than a handful): confirm an orphan's feature is really gone before leaving DELETE, confirm a WRITE's feature really shipped, add file:line evidence. Present the plan grouped by verdict and ask: approve all, pick items, or none. Record it: `node S/correction-plan.mjs --approve all|P001,P003|none --by "<name>"`.

- DELETE is always a proposal. The publisher cannot delete. Archive = `state: draft`; deleting stays a click in Intercom, done by a human, after an explicit yes.
- MERGE: fold what is unique into the keeper, archive the other, repoint links.

### 4. Fix and write (approved items only)

For every item, in order:

1. **Pre-write check first, every time**: `node S/find-existing.mjs --title "<question title>" [--feature <id>]`. UPDATE → `node S/pull.mjs --id <id>` if there is no local file, then edit that file and keep its `intercom_id`. UPDATE-LOCAL → edit that file. AMBIGUOUS (exit 3) → ask the user which one. CREATE → start from `${CLAUDE_PLUGIN_ROOT}/templates/article.md`. Rules: [references/pre-write-check.md](references/pre-write-check.md).
2. **Write from the code**: read the implementing files and the strings; copy labels verbatim in bold; cite every file in `sources:`. Delegate drafting to the `help-center-writer` agent when there are several articles. Rules: [references/writing-rules.md](references/writing-rules.md).
3. **Updating** a live article: change only what the code proves wrong; keep the id, the structure and anything the converter preserved as raw HTML (embeds, callouts).
4. Leave `state: draft` on new articles. A human sets `published`.

### 5. Review

Every drafted or changed article goes to the `help-center-reviewer` agent (adversarial: it checks every claim against the cited code and rejects invented facts). Fix what it rejects; re-review. Then go through [references/review-checklist.md](references/review-checklist.md) with the user and state which items you could not verify.

### 6. Pull request (the user's repo)

Follow [references/pull-requests.md](references/pull-requests.md) exactly: `node S/pr.mjs start --slug <topic>` before writing files (it refuses a dirty tree and asks for the base if undecided), then `node S/pr.mjs finish --title "<plain title>" --body-file <file>` (commits only help-center paths, checks head vs base, pushes without force, opens a draft PR, or prints a compare URL). Before `finish`, always tell the user head → base, the files, and why that base.

### 7. Publish (approved and reviewed only)

`/intercom-help-center:publish`. Always the dry run first (`node S/publish.mjs [files]`), show the exact changes, ask for the go-ahead, then publish ONE article, have the user open it on Intercom, then the rest. The publisher enforces an approved plan, the cap and drift protection itself; the plugin's hook blocks unapproved or over-cap runs too. Errors and drift: [references/publishing.md](references/publishing.md).

### 8. Parity and CI

`node S/publish.mjs --parity` after publishing. Offer the GitHub Actions templates in `${CLAUDE_PLUGIN_ROOT}/templates/github/` (coverage gate on every PR, weekly read-only audit, optional Claude-drafted fix PRs). Publishing never runs in CI.

## When a script fails

Every error has a code (`IHC0xx`) with its cause and fix printed under it, and listed in the repo's docs/TROUBLESHOOTING.md. Read the fix line, act on it, and tell the user in plain words. Never work around a refusal (a guard, the cap, drift, a dirty tree): those exist to protect the user. Common ones:

| Code | Do |
|---|---|
| IHC001/002 | token missing or wrong region: run doctor; never ask for the token in chat |
| IHC031/080 | no approved plan: show the plan and ask |
| IHC030/081 | over the cap: publish in batches; only the user raises the cap |
| IHC036 | edited on Intercom: show the 3-way view and ask (keep Intercom's / take the repo's / merge) |
| IHC034 | deleted on Intercom: ask recreate or delete the local file |
| IHC061 | dirty tree: ask the user to commit or stash their work themselves |
| IHC062 | base undecided: ask with the evidence, then `pr.mjs set-base` |

## What this skill never does

- publish without a dry run, an approved plan and a human go-ahead
- delete anything on Intercom
- overwrite an edit made in the Intercom UI without asking
- create an article when one on the same topic exists
- write the token into any file, or ask for it in chat
- commit on the user's branches, stash their work, or force-push
- invent a label, limit, default, price or promise the code does not show
