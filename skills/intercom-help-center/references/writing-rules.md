# Writing rules

Every article is written FROM the code, for a customer who has never seen the code.

## Before you write

1. Read the implementing files for the feature (the manifest's `sources`, the routes, the settings screen).
2. Read the UI strings for it: every label, help text, error and empty state the user can see. If there is no strings file, read the text straight from the components.
3. Find every number that matters: defaults, limits, time windows, prices. If a number is not in the code or strings, do not state it.

## The article

Start from `templates/article.md`.

- **Title is the question a customer would search.** "How do I export my orders to CSV?" not "CSV export". This is the biggest single SEO lever you have, and the audit flags non-question titles.
- **One topic per article.** A title that needs "and" is two articles.
- **The first two sentences say what the reader can do and why it matters to them.** No feature name in the first sentence.
- **Labels verbatim, in bold.** If the button says "Save changes", write **Save changes**. Copy from the strings file, never paraphrase a label.
- **Settings table from the strings file**: label in the left column, help text in the right, then plainer words where the help text is terse.
- **Steps: one action per step.** A step with "and" in it is two steps.
- **"What this does NOT do" is mandatory and specific.** Limits, unsupported cases, plans, regions, refusals and why. This section prevents more tickets than any other.
- **Money, deletion and anything irreversible**: say who confirms it, where, and where the proof shows up.
- **Plain words.** No internal names, table names, vendor names, feature flags or jargon. No roadmap promises: "Not yet" is allowed, "coming soon" is not.
- **Links** to other articles by filename: `[label](other-article.md)`. The publisher turns them into real URLs once the target is published, and keeps only the label until then.
- **Reviewer notes** go in `<!-- HTML comments -->`; they are stripped before publishing. Use them to mark anything you could not verify.
- **`sources:`** lists every file you read. The coverage gate fails when one disappears and warns when one changes after `last_synced`.
- **`state: draft`.** You never publish your own writing.

## Supported markdown

`#` headings, paragraphs, **bold**, *italic*, `code`, links, images (public URLs), `-` and `1.` lists (not nested), pipe tables, `>` quotes, fenced code. Anything else (an embed, a callout, a video): write the HTML directly on its own lines, separated by blank lines. It is passed through untouched and flagged (IHC044) so someone checks it renders.

## Translations

A translation is its own file next to the source: `how-do-i-export.fr.md` with

```yaml
title: "Comment exporter mes commandes ?"
locale: fr
translation_of: "help-articles/articles/orders/how-do-i-export.md"   # or the numeric id
state: draft
```

It is published into the source article's `translated_content`, so the source must be published first (IHC041 otherwise). Translate from the source article and the strings file of that locale; labels must match the translated UI exactly.

## When the code and the live article disagree

The code wins, but say so: in the PR body and the plan item, list each claim you changed with the file that proves it. If the code is ambiguous (a flag, an experiment, a plan-dependent branch), do not guess: leave the claim out and add a reviewer comment.
