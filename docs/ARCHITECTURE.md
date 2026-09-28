# Architecture

## Layout

```
.claude-plugin/
  plugin.json              the plugin manifest (name, version, metadata)
  marketplace.json         this repo is also its own marketplace; the plugin source is "./"
skills/
  intercom-help-center/    the core skill (model-invoked): the loop, the rules, when to ask
    SKILL.md
    references/            loaded on demand: pre-write check, writing rules, review checklist,
                           pull requests, publishing, collections, questions, Intercom MCP
  setup/ audit/ plan/ fix/ publish/
                           user-invoked commands (/intercom-help-center:<name>)
agents/                    help-center-auditor, help-center-writer, help-center-reviewer
hooks/
  hooks.json               PreToolUse guard, PostToolUse + Stop stale reminder
  guard.mjs  stale.mjs
scripts/                   zero-dependency Node 18+ scripts; each exports run(argv, deps)
  lib/
    intercom.mjs           the only Intercom client: pagination, retries, read-only mode
    messages.mjs           every error and warning (code, text, cause, fix)
    config.mjs             .help-center/config.json, defaults, secret refusal
    articles.mjs           frontmatter parse and in-place edit, article discovery
    features.mjs           manifest, features source, UI strings, feature matching
    html.mjs               markdown <-> Intercom HTML, link and text extraction
    text.mjs               title normalisation, similarity, line diff, hashing
    git.mjs                every git/gh call, behind an injectable runner
    cli.mjs                argument parsing, run-as-script wrapper
  doctor.mjs audit.mjs plan-collections.mjs correction-plan.mjs find-existing.mjs
  pull.mjs publish.mjs pr.mjs coverage-check.mjs gen-docs.mjs selftest.mjs
templates/                 article template, GitHub Actions templates
test/                      fake Intercom, fake git, the test files, sample-output generator
examples/                  a tiny example project, and sample output
docs/                      setup, config, workflows, troubleshooting, this file, hunt log
```

## Principles

1. **Scripts decide, the model writes.** Everything that must be exact (pagination, which article is a duplicate, whether a write is allowed, which branch a PR targets) is code with tests. The model does what code cannot: read a codebase, write prose, judge a claim. The skills tell Claude which script to run at each step and what to do with each outcome.
2. **Guards live in the code path, not only in instructions.** The audit's client cannot write. The publisher checks the plan, the cap, drift and workspace itself. The hook adds a second layer for agents. A skill instruction is the third.
3. **Every message has a code.** `messages.mjs` is the single catalog; `docs/TROUBLESHOOTING.md` is generated from it and the selftest fails if they differ or if a script prints an uncatalogued error.
4. **Zero dependencies.** Node's `fetch`, `fs`, `child_process`. Nothing to install, nothing to audit, runs anywhere Node 18 runs.
5. **Testable without the network.** Every script exports `run(argv, deps)`; tests inject a fake Intercom (as `fetch`) and a fake git.

## Data flow

```
Intercom ──GET (every page)──► snapshot.json ──► audit.mjs ──► help-center-audit.json/.md
                                   │                               │
repo: manifest, strings, articles ─┘                               ├─► plan-collections.mjs ─► collections plan (approve)
                                                                   └─► correction-plan.mjs ──► correction plan (approve)
approved items ──► find-existing.mjs (UPDATE / CREATE / AMBIGUOUS) ──► pull.mjs ──► writer agent ──► reviewer agent
               ──► pr.mjs (branch, commit help-center paths, push, PR)
merged articles ──► publish.mjs (plan check, cap, adopt, drift, dry run) ──PUT/POST──► Intercom
               ──► write-back: intercom_id, url, workspace, collection_id, remote_hash, last_synced; base/<id>.html
```

## Identity and idempotency

- An article's identity is its file. `intercom_id` in frontmatter turns every later publish into an update.
- If a create landed but the response was lost, the next run finds the same title on Intercom and adopts that id (IHC042) instead of creating a second copy. Two live articles with the same title stop the run for that file (IHC045).
- `remote_hash` (a hash of the article's visible text as Intercom returned it) plus `.help-center/base/<id>.html` detect and display edits made in the Intercom UI.
- `intercom_workspace` stops a file published to one workspace from being written into another.

## Feature matching

An article is "about" a feature when the words users see say so: the feature's label as a phrase (+3), keywords in the title (+2 each) or body (+1 each, capped), and the feature's own UI strings quoted in the body (+1 each, capped). A match needs a score of 3 and at least one specific signal (the label, a quoted string, two title keywords, or one title keyword backed by two in the body), so common words alone never match. A manifest cell pointing at an article's file is an exact match and wins.

## Duplicates

Exact duplicates share a normalised title (lowercase, punctuation and question words removed) and similar text; the same title with different text in different collections is a naming clash instead. Near-duplicates share 60%+ of their 3-word shingles (Jaccard), found through an inverted index that skips boilerplate shingles, so it stays fast on thousands of articles.

## PR base decision

Signals, strongest first: config `pr.base`; the repo's own instructions; the base of 3+ recent merged PRs with a 60%+ share (release PRs from long-lived branches ignored); long-lived working branches; the default branch; protection on the default as a hint. One strong signal with nothing strong against it wins. A default branch alone wins only when no working branch exists. Anything else is a question for the user, asked once and saved.
