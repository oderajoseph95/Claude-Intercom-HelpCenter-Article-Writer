---
name: intercom-article-writer
description: Write, review and publish help-center articles to Intercom, grounded in the product's own code and UI strings, and keep them complete with a coverage manifest and a CI gate. Use when the user wants to write or update help articles, document a feature for customers, find which shipped features have no article, set up a help-article coverage check, publish or sync markdown articles to an Intercom Help Center, fix spacing or formatting of articles on Intercom, or check that the Help Center matches the repo.
---

# Intercom Article Writer

Help centers rot in two ways: features ship with no article, and articles keep describing code that changed. This skill fixes both. Articles live in the repo as markdown, are written from the code rather than from memory, are gated in CI so a feature cannot ship without one, and are published to Intercom by a script that knows Intercom's quirks.

**The one rule that outranks everything else: a wrong article is worse than a missing one, because the reader acts on it.** Never write a sentence you cannot point to in the code or the UI strings. If you cannot verify something, leave it out and say so in a reviewer comment.

## Files in this skill

| Path | What it is |
|---|---|
| `scripts/publish.mjs` | Markdown to Intercom publisher. Dry run by default. Zero dependencies. |
| `scripts/coverage-check.mjs` | CI gate: every shipped feature has its articles, or a ticketed reason. |
| `scripts/selftest.mjs` | Runs the publisher against a mocked Intercom API. No network. |
| `templates/article.md` | Article template with frontmatter. |
| `examples/` | A tiny example project: manifest, article, source files, CI workflow. |

Run the scripts with `node <this skill's folder>/scripts/<name>.mjs` from the user's repo root. They need Node 18+ and nothing else.

## The workflow

Work through these in order. For a single article on a known feature, you can start at step 3, but still do steps 4 to 6.

### 1. Inventory what shipped, from the code

Do not ask the user for a feature list and do not trust a roadmap. Read the repo:

- routes or pages, settings screens, feature flags or a feature registry
- the UI strings file (for example `locales/en.json`, `messages/*.json`, i18n catalogs): every label and help text a user actually sees
- the changelog, and any "done" folder of specs

Produce a list of user-facing features, each with the files that implement it. Anything a customer can see, click, configure or be confused by counts. Internal jobs, webhooks and APIs a customer never touches do not.

### 2. Build or update the coverage manifest

Create `help-articles/coverage-manifest.mjs` (copy `examples/help-articles/coverage-manifest.mjs`). For every feature, fill one cell per article KIND:

| Kind | Answers |
|---|---|
| `what-and-when` | What is it, and when would I turn it on? |
| `customer-use` | What does my customer see and do? |
| `setup` | Every setting, in a table, and what each one does |
| `comparison` | X vs Y, for anything it could be confused with |
| `troubleshooting` | "It isn't showing", refusals, edge cases |

Each cell is exactly one of:

- `{ article: "path/to/file.md" }`: written. Several kinds may point at the same file.
- `{ deferred: "<30+ char reason that names a ticket>" }`: owed and tracked.
- `{ na: "<30+ char reason this kind does not apply>" }`: argued, not asserted.

Export a `shipped()` function that reads the feature list from the repo (a registry, a folder, a changelog), so a new feature with no manifest entry fails the gate automatically. Set `TICKET_PATTERN` to match the user's tracker.

A deferral without a ticket is a promise nobody is tracking, so the gate rejects it. "We'll write it later" is how help centers end up empty.

### 3. Write the article, grounded in code

Start from `templates/article.md`. Rules:

- **Title is a question a customer would search.** "How do I export my orders to CSV?" not "CSV Export". This is what people type into Google and into the Help Center search, and it is the biggest single SEO lever you have.
- **One topic per article.** If the title needs "and", it is two articles, or one with a clear FAQ.
- **Never invent.** Every button label, setting name, default, limit and number comes from the code or the UI strings file. Copy labels verbatim and put them in **bold**. If a default or limit is in code (`MAX_ROWS = 10000`), cite that value. If you cannot find it, do not state it.
- **Cite your sources** in the `sources:` frontmatter list: the implementing files and the strings file. The gate warns when those files change after the article was last synced, which is how stale articles get caught.
- **Build the settings table from the strings file**: label in the left column, help text in the right, then plain-language edits where the help text is too terse.
- **Always fill "What this does NOT do".** Limits, unsupported cases, refusals and why. This section prevents the most support tickets.
- **Plain words.** Write what the reader would say, not what the code calls it. No internal names, table names, vendor names or jargon. No roadmap promises: "Not yet" is allowed, "coming soon" is not.
- Link other articles by filename, `[label](other-article.md)`. The publisher turns these into real Help Center URLs once the target is published, and drops the link (keeping the text) until then.
- Put notes for the reviewer in `<!-- HTML comments -->`. They are stripped before publishing.
- Leave `state: draft`. You do not publish your own writing.

### 4. Review before publish

Go through this checklist with the user, or state which items you could not check:

- [ ] Every claim traced to a file in `sources:`; nothing described that has not shipped
- [ ] Every button label matches the UI strings exactly
- [ ] Title is a searchable question and matches the body's scope
- [ ] "What this does NOT do" is specific, not boilerplate
- [ ] If money, data deletion or anything irreversible is involved, the article says who confirms it and where
- [ ] No jargon, no internal names, no roadmap promises
- [ ] Someone has opened the real screen, or the steps that describe it are marked unverified in a reviewer comment
- [ ] `node scripts/publish.mjs --html <file>` output reads correctly

Only a human flips `state: draft` to `state: published`.

### 5. Publish to Intercom

```bash
export INTERCOM_API_TOKEN=...          # export only this key, never a whole .env
node scripts/publish.mjs --list-collections           # see collection and section names (read-only)
node scripts/publish.mjs                              # dry run: what would be created or updated
node scripts/publish.mjs --publish path/to/one.md     # first time: ONE article, then open it on Intercom
node scripts/publish.mjs --publish                    # then the rest
```

What the publisher does, so you can explain it:

- **Create vs update by id.** No `intercom_id` in frontmatter means POST (create), then the new id, URL and `last_synced` are written back into the file. With an id it is PUT (update). The file is the identity, so re-running never duplicates. Commit the written-back ids.
- **Collections and sections by name.** `collection:` must match an Intercom collection's name. `section:` is a child collection under it (in Intercom's API a section is a collection with a `parent_id`). `--create-sections` creates a missing one. Collections are read across every page, since a one-page read silently misses later ones.
- **The spacing fix.** Intercom does not add space between blocks, so headings sit flush against the paragraph above. The publisher inserts an empty `<p class="no-margin"></p>` between every pair of top-level blocks, which is what Intercom's own editor emits for a blank line. If a user complains that "there are no spaces between sections", this is the cause.
- **Headings and tables.** Intercom normalises every heading level to its own style and wraps tables in its own styled container. Send plain markup and do not fight it.
- **No double title.** The leading `# Title` in the body is stripped because Intercom shows `title` as the page header.
- **Blast radius.** Dry run unless `--publish`. Refuses to write more than `--max` articles (default 20) in one run. Only `state: published` files are sent, unless `--include-drafts`, which sends them as Intercom drafts for preview.

Supported markdown: `#` headings, paragraphs, **bold**, *italic*, `code`, links, images (must be public URLs), `-` and `1.` lists (not nested), pipe tables, `>` quotes, fenced code. Anything else, simplify it.

### 6. Keep parity, and wire the gate

- After every publish, `help-articles/PUBLISHED.md` is regenerated: one row per synced article. It is the ledger of what is live. Do not hand-edit it.
- `node scripts/publish.mjs --parity` compares the repo with Intercom and reports articles on Intercom with no source file, and source files pointing at ids Intercom no longer has. Run it before assuming the repo and the Help Center agree.
- Add `coverage-check.mjs` to CI (see `examples/github-workflow.yml`). It fails the build on a shipped feature with no manifest entry, a missing article file, a deferral with no ticket, a shrug reason, or a cited source that no longer exists. It warns (or fails with `--strict`) when an article's sources changed after it was last synced.

## When things go wrong

| Symptom | Cause | Fix |
|---|---|---|
| No space between sections on Intercom | Article was published without spacer paragraphs | Re-publish with `publish.mjs` |
| Title appears twice | Body starts with `# Title` and was published by another tool | Re-publish; the H1 is stripped |
| `collection "X" not found` | Name mismatch, or a collection beyond page one | `--list-collections`, copy the exact name |
| A second copy of an article appeared | `intercom_id` was not committed after the first publish | Delete the duplicate on Intercom, keep the id in the file |
| Readers see raw `**` or `|` characters | Article was pasted as markdown, not converted | Re-publish with `publish.mjs` |
| Gate fails on "shipped() returned 0 features" | The feature discovery broke | Fix `shipped()`; the gate refuses to pass on an empty list |

## What is and is not tested

Tested offline: the markdown conversion, frontmatter write-back, dry-run planning, the ledger, the `--max` and missing-token guards, every gate failure mode, and the stale-source check. The full create, update and pagination flow is covered by `selftest.mjs` against a mocked API. **Not tested against a live Intercom workspace in this generic form:** `--publish`, `--parity`, `--create-sections`, the `GET /me` author fallback, EU and AU regions, and how Intercom renders `<pre>`, `<blockquote>` and `<img>`. Always publish one article first and open it.
