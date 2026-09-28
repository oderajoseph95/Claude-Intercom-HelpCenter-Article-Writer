---
name: publish
description: Publish reviewed, approved help articles (and an approved collection structure) to Intercom. Always shows the dry run and the exact changes first, publishes one article for a visual check, respects the cap, and never overwrites edits made in Intercom without asking.
argument-hint: "[files...] [--collections]"
disable-model-invocation: true
---

# Publish to Intercom

Rules: `${CLAUDE_PLUGIN_ROOT}/skills/intercom-help-center/SKILL.md` and `references/publishing.md` next to it. `S` = `${CLAUDE_PLUGIN_ROOT}/scripts`. Scope: `$ARGUMENTS` (files; `--collections` applies the approved collections plan).

**This writes to a live Help Center. It stops at the dry run unless the user explicitly confirms.**

1. Preconditions: a token (IHC001), an approved plan (`help-center-plan.json` with `approved: true`; otherwise show it and ask; for a one-off article, the ad-hoc plan from `/intercom-help-center:fix`, passed with `--plan .help-center/adhoc-<stamp>.plan.json`), and reviewed articles. Prefer publishing from the default branch after the help-center PR merged, so the written-back ids land in git cleanly. If the user publishes from the help-center branch, commit the write-back to that branch.
2. **Dry run**: `node S/publish.mjs <files>` (or `node S/publish.mjs --create-collections --plan .help-center/help-center-collections.plan.json` for the structure). Summarise: creates, updates, collections to create, moves, and any diff that changes more than expected. Show the warnings (raw HTML kept, adopted articles).
3. **Ask**: publish one first (recommended) · publish all · not now. Without an answer (non-interactive), stop here.
4. **One first**: `node S/publish.mjs --publish <one file>`. Give the user the URL and ask them to check spacing, headings, tables, images and embeds. Continue only after they say it looks right.
5. **The rest**: `node S/publish.mjs --publish <files>`. Over the cap (IHC030): publish in batches; only the user raises `publish.cap`. The plugin's hook blocks unapproved or over-cap runs (IHC080, IHC081): do not work around it.
6. **Drift** (IHC036): show the 3-way view and ask: keep Intercom's version, take the repo's, or merge. Act as references/publishing.md says. Never pass `--overwrite-drift` without that answer.
7. **Deleted on Intercom** (IHC034): ask whether to recreate it (`--recreate-missing`) or delete the local file.
8. **After**: `node S/publish.mjs --parity`. Commit the written-back frontmatter, `.help-center/base/` and `PUBLISHED.md` through `pr.mjs` (a small follow-up PR). Report what was published, with URLs, and anything skipped, with the reason.
