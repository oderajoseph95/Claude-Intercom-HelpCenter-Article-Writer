# Publishing, drift and errors

## The order, every time

1. The plan is approved (`help-center-plan.json` has `approved: true` and `approved_by`). If not: show it and ask (IHC031).
2. **Dry run**: `node S/publish.mjs [files]`. It prints, per article: CREATE or UPDATE, the target collection, the state, every field that changes, and a text diff against the live article. Show the user the summary and any surprising diff.
3. Ask for the go-ahead.
4. **Publish ONE article**: `node S/publish.mjs --publish path/to/one.md`. Ask the user to open the printed URL and check spacing, headings, tables, images and embeds.
5. Then the rest: `node S/publish.mjs --publish`. The cap (`publish.cap`, default 20) refuses a bigger run before any write (IHC030). Publish in batches by passing file paths. Only the user raises the cap.
6. `node S/publish.mjs --parity` and commit the written-back frontmatter (`intercom_id`, `intercom_url`, `intercom_workspace`, `remote_hash`, `last_synced`), `.help-center/base/`, and `PUBLISHED.md`, through the PR flow.

**One-off articles** (written without an audit): after review and the user's yes, `node S/correction-plan.mjs --adhoc "<what and why>" --files a.md,b.md --by "<name>"` writes an approved plan that covers exactly those files; publish with `--plan <that file> a.md b.md`. Any other file is skipped (IHC046).

Only files with `state: published` are sent. `--include-drafts` sends drafts as Intercom drafts (useful for previewing).

## What is written back, and why

| Key | Why |
|---|---|
| `intercom_id` | the identity: the next run updates this id instead of creating a copy |
| `intercom_url` | internal links from other articles resolve to it |
| `intercom_workspace` | a file cannot be published into the wrong workspace (IHC035) |
| `collection_id` | a renamed collection still resolves (IHC043 warns) |
| `remote_hash`, `remote_updated_at` | detect edits made in the Intercom UI (drift) |
| `last_synced` | the coverage gate's stale-article check |

`.help-center/base/<id>.html` keeps the last published body: the "base" of the 3-way drift view. Commit it.

## Drift: edited in the Intercom UI

If someone changed the article on Intercom since the last sync, publish stops for that article (IHC036) and prints a 3-way view: last published → Intercom now, and last published → the repo. Ask the user:

- **Keep Intercom's version**: `node S/pull.mjs --id <id> --replace`, then re-apply any code-driven fixes on top.
- **Take the repo's version**: `node S/publish.mjs --publish --overwrite-drift <id> <file>`.
- **Merge**: edit the local file to include the Intercom edit, then publish with `--overwrite-drift <id>`.

Never pass `--overwrite-drift` without that answer.

## Other situations

| Situation | What happens | What you do |
|---|---|---|
| Deleted on Intercom, id still in the file | IHC034, skipped | ask: recreate (`--recreate-missing`) or delete the local file |
| Same title already live, no id in the file | adopts it (IHC042) | nothing: the id is written back |
| Same title live twice | refuses (IHC045) | ask which id is this file's; put it in `intercom_id` |
| Collection or section missing | IHC032/033 | `--create-collections` (and `--create-sections`) with `--publish`, after the user agrees |
| Collection nested 3+ levels | supported: `section: "Admin › Advanced"` | |
| Network failure mid-write | IHC006, run stops | re-run the same command: it adopts what landed, never duplicates |
| 429 rate limit | retried with backoff, Retry-After honoured | if IHC005, wait and re-run |
| Token lacks write access | IHC004 on the first write | the user fixes the app's permissions; nothing was changed |
| No author id | IHC037 | set `intercom.authorId` (setup prints the admin id) |
| Several help centers | collections go to the default one | set `INTERCOM_HELP_CENTER_ID` when creating collections |

## Applying a collections plan

```bash
node S/publish.mjs --create-collections --plan .help-center/help-center-collections.plan.json          # dry run
node S/publish.mjs --create-collections --plan .help-center/help-center-collections.plan.json --publish --max 60
```

The plan must be approved. It creates missing collections top-down, then moves each MOVE article (`parent_id` only; nothing else about the article changes). REVIEW articles stay where they are. Unused collections are listed and never deleted. The cap counts creates plus moves.

## The hook

The plugin's PreToolUse hook blocks `publish.mjs --publish` without an approved plan (IHC080) and any `--max` above the configured cap (IHC081). If it blocks you, that is the answer: ask the user. They can switch it off in config (`hooks.publishGuard: false`), but you do not.
