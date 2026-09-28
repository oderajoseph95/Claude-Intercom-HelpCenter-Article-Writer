# Configuration reference

Everything lives in `.help-center/config.json` at your repo root (for a monorepo: the root that holds `.help-center/`; scripts walk up from the current folder to find it). Setup writes it; you can edit it by hand. Missing keys take the defaults below. Commit it: it must never contain a secret, and saving refuses anything token-shaped (IHC011).

Paths are relative to the folder holding `.help-center/`.

## Full example

```json
{
  "version": 1,
  "articlesDir": "help-articles/articles",
  "manifest": "help-articles/coverage-manifest.mjs",
  "features": { "source": "help-articles/coverage-manifest.mjs", "kind": "manifest" },
  "strings": ["src/locales/en.json"],
  "outDir": ".help-center",
  "collectionMap": { "csv-export": "Orders › Exporting" },
  "publish": { "cap": 20, "requireApprovedPlan": true },
  "planFile": ".help-center/help-center-plan.json",
  "snapshot": { "maxAgeHours": 24 },
  "intercom": {
    "region": "eu",
    "apiVersion": "2.11",
    "authorId": "1234567",
    "workspace": "abc123de",
    "workspaceName": "Acme Help"
  },
  "pr": {
    "base": "dev",
    "baseEvidence": ["confirmed by the user at setup", "CONTRIBUTING.md:12 says \"open PRs against dev\""],
    "branchPrefix": "help-center/",
    "draft": true,
    "reviewers": ["jane"],
    "labels": ["docs"],
    "remote": "origin"
  },
  "audit": {
    "minWords": 80,
    "staleDays": 365,
    "nearDuplicate": 0.6,
    "standardCollections": ["Getting started", "Billing", "Troubleshooting"]
  },
  "hooks": { "enabled": true, "publishGuard": true, "secretGuard": true, "staleReminder": true }
}
```

## Keys

### Where things are

| Key | Default | Meaning |
|---|---|---|
| `articlesDir` | `help-articles/articles` | Folder of article markdown files. Subfolders are fine. Files starting with `_` or `.`, `README.md`, `PUBLISHED.md` and `*.remote.md` are skipped. |
| `manifest` | `help-articles/coverage-manifest.mjs` | The coverage manifest: `KINDS`, `FEATURES`, optional `shipped()`, `STRINGS`, `TICKET_PATTERN`. See below. |
| `features.source` | `null` | Where the feature list comes from, as chosen at setup. If there is no manifest, a JSON file here (`["id"]`, `{ "shipped": [...] }` or `{ "features": [{ "id", "label", "area", "keywords" }] }`) is used directly. |
| `features.kind` | `null` | What setup detected: `manifest`, `features-json`, `next-app-routes`, `rails-routes`... informational. |
| `strings` | `[]` | UI strings files. Formats: i18n JSON (nested keys flattened to `a.b.c`), Rails-style YAML, gettext `.po`, Apple `.strings`, Android `strings.xml`. Several files are fine (monorepos). The manifest's `STRINGS` export is merged in. |
| `outDir` | `.help-center` | Where the audit, plans, snapshot and last-published copies go. |
| `planFile` | `.help-center/help-center-plan.json` | The correction plan the publisher (and the publish guard) require to be approved. |

### Publishing

| Key | Default | Meaning |
|---|---|---|
| `publish.cap` | `20` | Most writes (articles + collections created + moves) one run may make. `--max N` overrides per run; the hook blocks `--max` above this value, so only a human raises it here. |
| `publish.requireApprovedPlan` | `true` | Real writes need `planFile` with `approved: true` and `approved_by`. Set `false` only for a solo workflow where you review the dry run yourself. |
| `intercom.region` | `us` | `us`, `eu` or `au`. `INTERCOM_REGION` overrides. Setup detects it. |
| `intercom.apiVersion` | `2.11` | Sent as `Intercom-Version`. `INTERCOM_API_VERSION` overrides. |
| `intercom.authorId` | `null` | Admin id used as the author of new articles. `INTERCOM_AUTHOR_ID` overrides. Setup fills it with the token's admin. |
| `intercom.workspace`, `intercom.workspaceName` | `null` | The workspace setup confirmed. Informational; each article also records `intercom_workspace` when published. |
| `snapshot.maxAgeHours` | `24` | The pre-write check refreshes the snapshot when older than this (if a token is present). |

### Structure

| Key | Default | Meaning |
|---|---|---|
| `collectionMap` | `{}` | Pin a feature to a collection path: `{"feature-id": "Collection › Section › Sub"}`. Overrides `area`. |
| `audit.standardCollections` | `["Getting started", "Billing", "Troubleshooting"]` | The three standard collections, in that order. Rename them to match yours (e.g. "Getting Started"). |
| `audit.minWords` | `80` | Articles under this are "short". |
| `audit.staleDays` | `365` | Articles not updated for this long are "stale". |
| `audit.nearDuplicate` | `0.6` | Text overlap (0 to 1) at which two articles count as near-duplicates. |

### Pull requests

| Key | Default | Meaning |
|---|---|---|
| `pr.base` | `null` | The branch help-center PRs go to. Set once at setup (or `node scripts/pr.mjs set-base <branch>`). When empty, it is detected each time and the user is asked if unclear. |
| `pr.baseEvidence` | `[]` | Why that base was chosen, for the record. |
| `pr.branchPrefix` | `help-center/` | Branches are `<prefix><date>-<slug>`. The plugin only ever commits on branches with this prefix. |
| `pr.draft` | `true` | Open PRs as drafts. |
| `pr.reviewers`, `pr.labels` | `[]` | Passed to `gh pr create`. |
| `pr.remote` | `origin` | The remote PRs target. |

### Hooks

| Key | Default | Meaning |
|---|---|---|
| `hooks.enabled` | `true` | Master switch for all three hooks. |
| `hooks.publishGuard` | `true` | Block unapproved or over-cap publishing. |
| `hooks.secretGuard` | `true` | Block writing an Intercom token into files. |
| `hooks.staleReminder` | `true` | Remind when you edit code that articles cite. |

`HELP_CENTER_HOOKS=off` in the environment disables all three without touching config.

## The coverage manifest

`help-articles/coverage-manifest.mjs` (copy [the example](../examples/help-articles/coverage-manifest.mjs), or let setup scaffold one):

```js
export const KINDS = ["what-and-when", "customer-use", "setup", "comparison", "troubleshooting"];
export const TICKET_PATTERN = /[A-Z][A-Z0-9]+-\d+|#\d+/;   // what a ticket reference looks like
export const STRINGS = ["src/locales/en.json"];              // merged into config.strings

export function shipped({ root }) {                          // read "what shipped" from the repo
  return JSON.parse(readFileSync(join(root, "src/features.json"), "utf8")).shipped;
}

export const FEATURES = {
  "csv-export": {
    label: "Export orders",                 // what users call it (matched as a phrase)
    area: "Orders",                         // optional: groups features into one collection
    keywords: ["csv", "spreadsheet"],       // optional: extra words users search for
    strings: ["settings.export"],           // optional: UI string key prefixes of this feature
    sources: ["src/export.js"],             // optional: the implementing files
    kinds: {
      "what-and-when": { article: "help-articles/articles/orders/how-do-i-export.md" },
      "customer-use":  { na: "a merchant-only admin screen; shoppers never see it" },
      "troubleshooting": { deferred: "the 'empty export' FAQ is owed, tracked as HELP-42" },
      // ...one cell per kind: exactly one of article / deferred (with a ticket) / na (with a reason)
    },
  },
};
```

## Article frontmatter

| Key | Set by | Meaning |
|---|---|---|
| `title` | you | The question a customer would search. |
| `description` | you | One line under the title. |
| `collection` | you | Collection name, matched by name. |
| `section` | you | Optional path inside it: `"Admin"` or `"Admin › Advanced"`. |
| `state` | a human | `draft` or `published`. Only `published` is sent (unless `--include-drafts`). |
| `sources` | the writer | Files the article was written from. The gate checks they exist and warns when they change. |
| `locale`, `translation_of` | you | Translation files only. |
| `intercom_id`, `intercom_url`, `intercom_workspace`, `collection_id`, `remote_hash`, `remote_updated_at`, `last_synced` | the publisher | Written back after each publish. Do not edit. |
