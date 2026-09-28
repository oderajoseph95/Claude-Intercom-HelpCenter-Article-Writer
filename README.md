# Intercom Article Writer

A Claude Code skill that writes help-center articles from your code and publishes them to Intercom, plus a CI gate that fails the build when a feature ships without an article.

- **Coverage manifest**: one file that says which articles every shipped feature owes.
- **CI gate**: fails when a feature has no article, when an article file goes missing, or when a "we'll write it later" has no ticket behind it. Warns when the code an article describes has changed since it was published.
- **Grounded drafts**: Claude writes each article from the implementing code and your UI strings file, so button labels, defaults and limits match the product. SEO question titles, one topic per article, a "what this does NOT do" section every time.
- **Publisher**: markdown to Intercom HTML with the fixes Intercom needs (spacing between blocks, no double title, paginated collections, create-or-update by id). Dry run by default.
- **Parity ledger**: `PUBLISHED.md` lists every article that is live, and `--parity` reports drift between the repo and the Help Center.

No dependencies. Node 18+.

## Install as a Claude Code skill

For every project on your machine:

```bash
git clone https://github.com/oderajoseph95/intercom-article-writer ~/.claude/skills/intercom-article-writer
```

Or for one repo, so your team gets it too:

```bash
git clone https://github.com/oderajoseph95/intercom-article-writer .claude/skills/intercom-article-writer
```

Then ask Claude Code something like:

- "Which of our shipped features have no help article?"
- "Write a help article for the CSV export feature."
- "Set up the help article coverage gate in CI."
- "Publish the reviewed articles to Intercom."

Claude picks up the skill from its description. `SKILL.md` holds the full workflow.

## Environment

| Variable | Required | Default | What it is |
|---|---|---|---|
| `INTERCOM_API_TOKEN` | to talk to Intercom | none | Access token from your Intercom developer app. Needs articles read and write. |
| `INTERCOM_AUTHOR_ID` | no | the token's admin, from `GET /me` | Admin id shown as the author of new articles |
| `INTERCOM_REGION` | no | `us` | `us`, `eu` or `au`, for your workspace's data region |
| `INTERCOM_API_VERSION` | no | `2.11` | Intercom API version header |

Export only these. Never load a whole `.env` into a publishing job.

## Quick start

```bash
# 1. Copy the example manifest and edit it for your features
mkdir -p help-articles/articles
cp ~/.claude/skills/intercom-article-writer/examples/help-articles/coverage-manifest.mjs help-articles/

# 2. Run the gate
node ~/.claude/skills/intercom-article-writer/scripts/coverage-check.mjs

# 3. Preview an article as Intercom HTML (no network)
node ~/.claude/skills/intercom-article-writer/scripts/publish.mjs --html help-articles/articles/getting-started/my-article.md

# 4. Dry run, then publish ONE article and open it in your Help Center before doing the rest
node ~/.claude/skills/intercom-article-writer/scripts/publish.mjs
node ~/.claude/skills/intercom-article-writer/scripts/publish.mjs --publish help-articles/articles/getting-started/my-article.md
```

## Example manifest

```js
// help-articles/coverage-manifest.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["what-and-when", "customer-use", "setup", "comparison", "troubleshooting"];
export const TICKET_PATTERN = /[A-Z][A-Z0-9]+-\d+|#\d+/; // Linear/Jira keys or GitHub issues

// Read "what shipped" from the repo, so a new feature cannot slip past the gate.
export function shipped({ root }) {
  return JSON.parse(readFileSync(join(root, "src/features.json"), "utf8")).shipped;
}

export const FEATURES = {
  "csv-export": {
    label: "Export orders to CSV",
    kinds: {
      "what-and-when":   { article: "help-articles/articles/getting-started/how-do-i-export-my-orders-to-csv.md" },
      "customer-use":    { na: "export is a merchant-only admin screen; shoppers never see it" },
      "setup":           { article: "help-articles/articles/getting-started/how-do-i-export-my-orders-to-csv.md" },
      "comparison":      { na: "there is only one export path, so there is no X versus Y to explain" },
      "troubleshooting": { deferred: "a 'why is my export empty' FAQ is owed, tracked as HELP-42" },
    },
  },
};
```

A full working example, with an article, source files and a GitHub Actions workflow, is in [`examples/`](examples/).

## Article frontmatter

```yaml
---
title: "How do I export my orders to a CSV file?"   # a question people search for
description: "Download any date range of orders as a spreadsheet."
collection: "Getting Started"                        # Intercom collection, by name
section: ""                                          # optional section inside it
state: draft                                         # a human sets this to published after review
sources:                                             # the code this article describes
  - src/export.js
  - src/locales/en.json
intercom_id: null                                    # written back by the publisher
intercom_url: null
last_synced: null
---
```

## Publisher flags

| Flag | What it does |
|---|---|
| *(none)* | Dry run: show what would be created or updated |
| `--publish` | Actually write to Intercom and update frontmatter and `PUBLISHED.md` |
| `--dir <path>` | Articles folder (default `help-articles/articles`) |
| `--include-drafts` | Also send `state: draft` files, as Intercom drafts |
| `--create-sections` | Create a missing section under its collection |
| `--max <n>` | Refuse a run that would write more than n articles (default 20) |
| `--list-collections` | Print collections and sections, read-only |
| `--parity` | Report drift between the repo and Intercom, read-only |
| `--html <file>` | Print converted HTML, no network |

## Why the spacing fix matters

Intercom does not add vertical space between blocks sent through the API, so every heading lands flush against the paragraph above it. Its own editor inserts an empty `<p class="no-margin"></p>` for a blank line. The publisher puts one between every pair of blocks, so every article is right by construction instead of by whoever hand-formatted it.

## Tests

```bash
node scripts/selftest.mjs                          # full publish flow against a mocked Intercom API
cd examples && node ../scripts/coverage-check.mjs  # gate against the example project
```

**Not yet tested against a live Intercom workspace in this form:** `--publish`, `--parity`, `--create-sections`, the author fallback, EU/AU regions, and how Intercom renders code blocks, quotes and images. The conversion rules and create/update logic come from a publisher that runs against a live Intercom Help Center. Publish one article and look at it before a bulk run. Issues and PRs welcome.

## License

MIT. See [LICENSE](LICENSE).
