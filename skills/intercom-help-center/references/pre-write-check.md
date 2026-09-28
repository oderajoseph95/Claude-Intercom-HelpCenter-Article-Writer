# The pre-write check, and update vs create

Run this before writing ANY article, including one the user asked for by name. Duplicates are how help centers rot: two articles drift apart and the reader finds the wrong one.

## Run it

```bash
node S/find-existing.mjs --title "How do I export my orders to CSV?" --feature csv-export
node S/find-existing.mjs --title "..." --keywords "export,csv,spreadsheet" --json
```

It searches:

1. **What is live on Intercom**, from `.help-center/snapshot.json`. If the snapshot is older than `snapshot.maxAgeHours` (default 24) and a token is present, it refreshes it first (warning IHC051). Without a token it uses the old one and warns (IHC052); tell the user the answer may be out of date. With no snapshot and no token it stops (IHC050).
2. **The local articles folder**, including drafts that were never published.

It scores each article by title similarity, keyword overlap and, with `--feature`, how strongly the article is about that feature (label phrase, quoted UI strings, title keywords).

## Act on the decision

| Decision | Exit | What you do |
|---|---|---|
| `UPDATE <id>` | 0 | An article on Intercom covers this. If it has no local file, `node S/pull.mjs --id <id>`. Edit that file. Keep `intercom_id`. |
| `UPDATE-LOCAL <file>` | 0 | A local file covers this (not published yet). Edit it. |
| `AMBIGUOUS` | 3 | Two or more match about equally (typical: the same title in two collections). **Ask the user** which one, showing each id, title and collection. If both are real and different, the fix is to retitle one of them, not to create a third. |
| `CREATE` | 0 | Nothing covers it. Start from `templates/article.md`. |

Record the link in the plan item or the PR body: "updates article 1234 (How do I...)".

## Updating a live article

1. **Pull** it if there is no local file (`pull.mjs --id`). If a local file already exists, pull writes `<file>.remote.md` beside it and never overwrites your file; diff the two before editing.
2. **Diff against the code.** For every claim in the body, find it in the code or strings. Mark each one: correct, wrong (the code says otherwise), unverifiable.
3. **Change only what is wrong.** Keep the structure, the tone and everything else. Anything the converter kept as raw HTML (embeds, videos, callouts) stays byte for byte.
4. **Keep the id.** Never delete and recreate: the article's URL, its links from other articles and its view history belong to that id.
5. **Show the diff before publishing**: `node S/publish.mjs <file>` (dry run) prints the text diff against the live article and every field that will change.

## Creating a new article

Only after `CREATE`. Then follow [writing-rules.md](writing-rules.md). Leave `state: draft`.

## Why the publisher also protects you

Even if this step is skipped, `publish.mjs` refuses to create an article when one with the same title already exists: with exactly one it adopts that id (IHC042) and updates it; with two or more it refuses (IHC045). That is a safety net, not the process. The check above is.
