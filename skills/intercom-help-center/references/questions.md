# Asking the user

The rule: **never ask what you can detect; ask once; save the answer.** Use the AskUserQuestion tool: one question at a time, 2 to 4 concrete options, the recommended option first and labelled "(recommended)", and the evidence in the question text so the user can decide without scrolling.

Subagents cannot ask the user. When the auditor, writer or reviewer needs a decision, it returns the question; you ask it.

## The questions, and where each answer is saved

| When | Question | Options | Saved to |
|---|---|---|---|
| Setup: repo | "I'll set up the help center for `<owner/repo>` at `<path>`. Is this the right repo?" | Yes · Different folder (monorepo package) | config location |
| Setup: features | "Where is your list of shipped features? I found: `<candidates with counts>`." | each candidate · Create a coverage manifest from `<routes>` · Somewhere else | `features.source`, `manifest` |
| Setup: strings | "Where do the words your users see live? I found: `<files>`." | the English file(s) · None, text is in the components · Somewhere else | `strings` |
| Setup: workspace | "The token belongs to workspace `<name>` (`<region>`). Publish there?" | Yes · No, I'll use another token | `intercom.workspace`, `intercom.region` |
| PR base (conflict or none) | "Which branch should help-center PRs go to? Evidence: ..." | the candidates, recommended first · Another branch | `pr.base` |
| Collection tree | "Here is the proposed structure: N collections, M moves, K for you to place. Apply it?" | Approve · Change it · Keep current structure | `approved` in the collections plan; `collectionMap` |
| Plan approval | "The plan has W WRITE, R REWRITE, M MERGE, F FIX, D DELETE. Approve which?" | All · Pick items · None | `decision` per item in the plan |
| Before publishing | "The dry run will create N and update M articles (diff above). Publish?" | Publish one first (recommended) · Publish all N+M · Not now | nothing (per run) |
| Drift | "Article `<id>` was edited on Intercom since the last sync (diff above). Which version wins?" | Keep Intercom's · Take the repo's · Merge them | nothing (per article) |
| Delete / archive | "Article `<id>` matches no feature in the code (`<evidence>`). What should happen?" | Archive it (set to draft) · Keep it · I'll delete it in Intercom myself | plan item decision |
| Same title twice | "Two live articles match: `<id1> in <A>` and `<id2> in <B>`. Which one is this about?" | id1 · id2 · Neither, write a new one with a distinct title | the file's `intercom_id` |
| Dirty tree | "You have uncommitted changes in `<files>`. The help-center branch must start clean. Commit or stash them yourself, then tell me to continue." | I've done it · Cancel | nothing |

For "Pick items", list the item ids with one line each and let the user answer in text (for example "P001, P004"), then record with `correction-plan.mjs --approve P001,P004 --by "<name>"`.

## Non-interactive runs

With no AskUserQuestion (headless `-p` runs, CI, the GitHub Action) or when the user said `--yes`:

| Decision | Safe default |
|---|---|
| setup detections | accept only confident ones (`doctor.mjs --write --yes`); leave the rest unset and list them |
| PR base undecided | stop; do not open a PR; report the evidence |
| collection tree, plan approval | not approved |
| publishing | dry run only |
| drift | keep Intercom's version (do not overwrite) |
| delete, archive, merge | nothing |
| same title twice | stop on that article |

Say in the final message exactly which questions are waiting for a human.
