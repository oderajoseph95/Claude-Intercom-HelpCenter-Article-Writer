---
name: fix
description: Carry out the approved help-center plan - run the pre-write check, pull live articles, write and fix articles strictly from the code and UI strings, have every change adversarially reviewed, and open a pull request on the user's repo. Publishes nothing.
argument-hint: "[P001,P002 | feature-id | article title]"
disable-model-invocation: true
---

# Fix and write articles

Rules: `${CLAUDE_PLUGIN_ROOT}/skills/intercom-help-center/SKILL.md` and the references it links (pre-write-check.md, writing-rules.md, review-checklist.md, pull-requests.md). `S` = `${CLAUDE_PLUGIN_ROOT}/scripts`.

Scope: `$ARGUMENTS` (plan item ids, a feature id, or a title). Empty means every **approved** item in `.help-center/help-center-plan.json`. If the plan has no approved items, stop and offer `/intercom-help-center:plan`. For a one-off request with no plan ("write an article about X"), confirm the scope with the user and continue; the pre-write check and the review still apply. When it is reviewed, ask the user to approve publishing those files and record it: `node S/correction-plan.mjs --adhoc "<what and why>" --files <a.md,b.md> --by "<the user's name>"` (an approved plan that covers exactly those files).

1. **Branch first**: `node S/pr.mjs start --slug <short-topic>`. Dirty tree (IHC061): ask the user to commit or stash their own work. Base undecided (exit 3): ask with the evidence, run `node S/pr.mjs set-base <branch>`, retry.
2. **For each item:**
   - Pre-write check: `node S/find-existing.mjs --title "<question>" [--feature <id>]`. UPDATE: `node S/pull.mjs --id <id>` if there is no local file, then edit it. UPDATE-LOCAL: edit that file. AMBIGUOUS: ask. CREATE: start from `${CLAUDE_PLUGIN_ROOT}/templates/article.md`.
   - Write or fix with the `help-center-writer` agent. Brief it with the plan item, its evidence, the files, and the pre-write decision. Several writers can work in parallel on different articles.
   - MERGE: fold unique content into the keeper, set the merged article to `state: draft` (archive), repoint links. DELETE (approved): set `state: draft`; tell the user that deleting it in Intercom is their click.
3. **Review every changed article** with the `help-center-reviewer` agent. A REJECTED article goes back to the writer with the reviewer's findings. Repeat until PASS, or leave the claim out and note it.
4. **Preview**: `node S/publish.mjs <files>` (dry run). Check the diff matches what you meant to change.
5. **Checklist**: go through references/review-checklist.md with the user.
6. **PR**: write the body (what changed with evidence, the plan items, what is not verified) to `.help-center/pr-body.md`. Tell the user head → base, the files, and why that base. Then `node S/pr.mjs finish --title "<plain title>" --body-file .help-center/pr-body.md`.
7. Report the PR URL (or the compare URL, or "branch kept local"), what is still unverified, and the next step: after the PR merges, `/intercom-help-center:publish`.
