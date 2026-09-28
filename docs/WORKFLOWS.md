# Workflows

Five situations, start to finish. Each assumes setup is done ([SETUP.md](SETUP.md)) and `INTERCOM_API_TOKEN` is exported in your shell.

## 1. The first audit (and the big cleanup)

You inherited a Help Center nobody has looked at in a year.

1. `/intercom-help-center:audit`. Read the summary; skim `.help-center/help-center-audit.md`.
2. `/intercom-help-center:plan`. Two decisions:
   - **Structure.** Approve the proposed tree, change it (tell Claude which feature goes where; it saves that as `collectionMap`), or keep your current collections.
   - **Corrections.** The auditor agent checks every DELETE, WRITE and MERGE against the code first. Then approve all, pick items (for a first cleanup, start with the WRITE and FIX items), or none.
3. **Import what you will maintain.** Articles that exist only on Intercom get pulled into the repo as they are touched (`pull.mjs --id`). To bring everything in at once: `node scripts/pull.mjs --all` (read-only; up to 500 per run). Add each article's code files to `sources:` as you go.
4. `/intercom-help-center:fix`. It works on a new branch, writes and fixes from the code, has every article reviewed, and opens a draft PR. Review the PR like code.
5. After it merges, `/intercom-help-center:publish`: dry run, one article, look at it in your Help Center, then the rest in batches of `publish.cap`.
6. Apply the structure: the same command with `--collections` (dry run first; creates collections, then moves articles).
7. Delete what you agreed to delete, by hand, in Intercom. The plugin never deletes.
8. Add the coverage gate to CI (below), so it stays clean.

A big Help Center: do it in rounds of 20 to 40 items. Every round is one PR and one publish.

## 2. Weekly maintenance

With the audit template in CI, you get a report every Monday in the Actions run summary. Otherwise run `/intercom-help-center:audit` yourself. Typical week:

- **Stale articles**: the gate warned that an article's `sources:` changed. `/intercom-help-center:fix <article title>`: the writer diffs the article against the new code and changes only what is wrong.
- **Edited in Intercom** by your support team: nothing to do until you next publish that article; the publisher then shows their edit and asks which version wins. To adopt their edit into the repo right away: `node scripts/pull.mjs --id <id> --replace` (keeps your `sources:`).
- **Broken links, drafts linked from live articles**: small FIX items; batch them into one PR.

## 3. A new feature shipped

1. The coverage gate fails the PR that ships it: `shipped feature "x" has NO manifest entry` (IHC100). That is the reminder.
2. In the same PR, or right after, add the feature to the manifest. For each kind, point at an article, defer it with a ticket, or argue n/a.
3. `/intercom-help-center:fix x` (a feature id). The pre-write check makes sure no article already covers it; the writer drafts from the new code and strings; the reviewer checks it.
4. Merge, then `/intercom-help-center:publish` that one article. With no audit plan, the fix command records an ad-hoc approval for exactly that file (`correction-plan.mjs --adhoc`), and publish uses it with `--plan`.

## 4. Multilingual Help Center

1. The audit lists `missing-translation` for published articles that lack a locale other articles have.
2. Each translation is its own file next to the source: `how-do-i-export.fr.md` with `locale: fr` and `translation_of: "<path to the source article>"`. Translate from the source and the strings file of that locale; labels must match the translated UI.
3. The source article must be published first. Publishing the translation writes it into the source article's `translated_content` (same article id, same URL, another language).
4. `pull.mjs --id <id> --locale fr` imports an existing translation.

## 5. Moving to a new structure without breaking anything

- Moving an article changes its collection, not its URL; links keep working.
- New collections appear in the Help Center once they contain a published article.
- Do it in two publishes: first `--collections` (create + move), then check the Help Center, then the article fixes.
- Old collections are listed as unused, never deleted. Delete them in Intercom when they are empty and you are sure.

## CI

| Template | Put it in | Secrets and variables |
|---|---|---|
| [help-center-gate.yml](../templates/github/help-center-gate.yml) | `.github/workflows/` | none |
| [help-center-audit.yml](../templates/github/help-center-audit.yml) | `.github/workflows/` | secret `INTERCOM_API_TOKEN` (read scope is enough); optional variable `INTERCOM_REGION` |
| [help-center-draft-fixes.yml](../templates/github/help-center-draft-fixes.yml) | `.github/workflows/` | secrets `INTERCOM_API_TOKEN`, `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN` with the matching input); the Claude GitHub App installed on the repo |

Add secrets under **Settings → Secrets and variables → Actions**. Each template checks out this plugin at a release tag; bump the tag when you upgrade.

Notes:

- The gate needs `fetch-depth: 0` for the stale check (already set).
- The audit's artifact includes article titles (drafts too). On a public repository anyone who can see the repo can download artifacts: keep the retention short or run it in a private repo.
- The draft-fixes workflow gives the Intercom token to the audit step only. Claude drafts with the offline snapshot, cannot publish, and the PR it opens is a draft. PRs created with the default `GITHUB_TOKEN` do not trigger other workflows; re-run checks from the PR page if you need them.
- Nothing in CI publishes. Publishing is always `/intercom-help-center:publish` on a developer machine, after review.
