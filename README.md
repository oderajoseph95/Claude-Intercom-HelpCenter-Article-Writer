# Intercom Help Center Article Writer for Claude Code

**Keep your Intercom help center true to your code.**

[![CI](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/actions/workflows/ci.yml/badge.svg)](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 18+](https://img.shields.io/badge/node-18%2B-brightgreen)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

A Claude Code plugin that reads your whole Intercom Help Center, compares it with what your product actually does, and fixes the gap: it finds duplicates, broken links, stale and orphan articles and shipped features nobody documented, proposes a collection structure built from your features, writes and corrects articles from your code and UI strings (never from memory), opens a pull request on your repo, and publishes to Intercom only what a human approved. A CI gate keeps it that way.

Help centers rot in two ways: features ship with no article, and articles keep describing code that changed. This plugin fixes both, and treats one rule as absolute: **a wrong article is worse than a missing one, because the reader acts on it.**

- [Live example: help.tacey.app](#live-example-helptaceyapp) · [How is this different from Intercom's official Claude plugin?](#how-is-this-different-from-intercoms-official-claude-plugin)
- [How it works](#how-it-works) · [Quick start](#quick-start-60-seconds) · [Install](#install) · [Commands](#commands) · [Agents](#agents) · [Hooks](#hooks)
- [Configuration](#configuration) · [GitHub Actions](#github-actions) · [Safety model](#safety-model) · [Edge cases](#edge-cases)
- [FAQ](#faq) · [Troubleshooting](#troubleshooting) · [Tested vs not tested](#tested-vs-not-tested) · [Uninstall](#uninstall)

## Live example: help.tacey.app

**[help.tacey.app](https://help.tacey.app)** is the help center for Tacey, a Shopify order-editing app, and it is where this workflow came from. In one pass it went from 7 articles in 6 collections to 109 articles in 22 collections, one collection per feature, every title a question a merchant would search for, and every article citing the code, changelog entry and screenshots it was written from.

Those articles were published by Tacey's in-house publisher, the script this plugin was extracted from and generalized. The plugin itself has not yet been run against a live workspace (see [Tested vs not tested](#tested-vs-not-tested)).

## How is this different from Intercom's official Claude plugin?

They solve different problems. **They're complementary: use Intercom's plugin to learn what customers ask; use this to keep your help center true to your code.**

Intercom's official plugin ([claude.com/plugins/intercom](https://claude.com/plugins/intercom), [source](https://github.com/intercom/claude-plugin-external)) brings your Intercom workspace into Claude: analysis of conversations and support themes, a Customer 360 profile, and setup helpers such as installing the Messenger. It describes itself as read-only. Intercom's MCP server ([mcp.intercom.com/mcp](https://www.intercom.com/integrations/connectors/intercom-mcp-server)) can read and create or update Help Center articles when you ask it to, through an OAuth sign-in.

Neither of them reads your code. This plugin is built around your code.

| | Intercom's plugin | Intercom's MCP server | This plugin |
|---|---|---|---|
| Main job | understand customers and conversations | give Claude Intercom tools while you chat | keep help articles true to the code |
| Reads your code, UI strings and feature list | no | no | **yes** |
| How it talks to Intercom | through the MCP server | one tool call at a time, interactive OAuth sign-in | Intercom's REST API directly, with an API token |
| Help Center articles | read-only | read, create, update on request | audit all, write, update, publish with guards |
| Whole help center at once (snapshot, parity, bulk updates) | no | not what it is built for | **yes**, paginated, rate-limit aware |
| Create collections and sections, move articles | no | not in Intercom's MCP docs | **yes**, from an approved plan |
| Runs unattended in CI | no | no (needs a sign-in) | **yes** (gate, weekly audit, draft-fix PRs) |
| Coverage gate: fail the build when a feature ships without an article | no | no | **yes** |
| Stale-article detection when code changes | no | no | **yes** (gate + in-session hook) |
| Code-grounded drafting with cited sources, adversarial review | no | no | **yes** |
| Pull requests on your repo | no | no | **yes** |
| Publishing safety: dry run, approved plan, cap, drift protection | n/a | no | **yes** |
| Regions | per MCP server | US-hosted workspaces only (per Intercom's page) | US, EU, AU |

Their MCP gives Claude a few Intercom tools to use while you chat. This plugin talks to Intercom's API directly, so it can work on the whole help center at once, run unattended in CI, and never publish anything you haven't reviewed.

If you already have Intercom's MCP server connected, the auditor may use it as an extra read path for individual lookups; the snapshot, the audit and publishing still go through the API ([details](skills/intercom-help-center/references/intercom-mcp.md), untested).

<sub>Sources, checked 2026-09-29: [claude.com/plugins/intercom](https://claude.com/plugins/intercom), [github.com/intercom/claude-plugin-external](https://github.com/intercom/claude-plugin-external), [intercom.com/integrations/connectors/intercom-mcp-server](https://www.intercom.com/integrations/connectors/intercom-mcp-server). Products change; check their pages for the current state.</sub>

## How it works

```
                 ┌──────────────────── your repo ─────────────────────┐
                 │  code · UI strings · feature list · articles (md)   │
                 └──────────┬──────────────────────────────▲──────────┘
                            │ reads                        │ pull request
   ┌───────┐   ┌────────┐   ▼   ┌──────────┐   ┌──────┐   ┌┴─────┐   ┌────────┐   ┌─────────┐   ┌────────┐
   │ setup │ → │ audit  │ ───→  │categorize│ → │ plan │ → │ fix  │ → │ review │ → │ publish │ → │ parity │
   └───────┘   └────────┘       └──────────┘   └──────┘   └──────┘   └────────┘   └────┬────┘   └────────┘
                   ▲ read-only                  ▲ you approve                ▲ you approve │ writes, capped
                   │                                                                      ▼
                 ┌─┴──────────────────── Intercom Help Center ───────────────────────────────┐
                 └─────────────────────────────────────────────────────────────────────────────┘
      CI: coverage gate on every PR · weekly read-only audit · optional Claude-drafted fix PRs (never publishes)
```

1. **Setup** detects your repo, where your UI strings and features live, your GitHub access, which branch PRs go to, and your Intercom workspace and region. It asks only what it cannot detect, once, and saves the answers in `.help-center/config.json`.
2. **Audit** reads every collection and article (every page, bodies and translations included), maps each article to a feature by the words your users see, and ranks what is wrong. It cannot write: its API client refuses anything but GET.
3. **Categorize** proposes a collection tree from your features (plus Getting started, Billing, Troubleshooting) and places every existing article.
4. **Plan** gives every article a verdict (FIX, REWRITE, MERGE, DELETE, KEEP) and every undocumented feature a WRITE, each with its evidence. You approve all, some, or none.
5. **Fix** runs the pre-write check (update the existing article, never duplicate it), writes from the code with the writer agent, and has every change attacked by the reviewer agent.
6. **Review and PR**: the changes go to a branch and a draft pull request on your repo, against the right base branch.
7. **Publish**: dry run with exact diffs, one article first, then the rest, within a cap. Edits made in the Intercom editor are never silently overwritten.
8. **Parity and CI**: a ledger of what is live, and a gate that fails the build when a feature ships without an article.

## What you get

A real report, generated from the test fixtures: [examples/sample-output/help-center-audit.md](examples/sample-output/help-center-audit.md), plus the [collection plan](examples/sample-output/help-center-collections.plan.md) and the [correction plan](examples/sample-output/help-center-plan.md) it leads to.

## Quick start (60 seconds)

```text
/plugin marketplace add oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer
/plugin install intercom-help-center@claude-intercom-help-center
```

In your shell, in your product's repo (the token never goes in a file or the chat):

```bash
export INTERCOM_API_TOKEN=...        # docs/SETUP.md step 3 shows how to create one
```

Then in Claude Code:

```text
/intercom-help-center:setup
/intercom-help-center:audit
```

You get `.help-center/help-center-audit.md`. From there: `/intercom-help-center:plan`, `/intercom-help-center:fix`, `/intercom-help-center:publish`. Full walkthrough with every prompt: [docs/SETUP.md](docs/SETUP.md).

## Install

**From the plugin marketplace** (recommended):

```text
/plugin marketplace add oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer
/plugin install intercom-help-center@claude-intercom-help-center
```

No GitHub SSH key? Use the HTTPS URL instead:

```text
/plugin marketplace add https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer.git
```

Pin a release instead of following `main`: `/plugin marketplace add oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer#v3.0.2`. From a shell: `claude plugin marketplace add ...` and `claude plugin install ...` work the same way.

**Windows:** if `marketplace add` fails with "SSH/HTTPS authentication failed" or "Filename too long", git hit Windows' 260-character path limit while cloning (the auth message is misleading). Run `git config --global core.longpaths true` once, then retry.

**Without the marketplace** (try it, or develop on it):

```bash
git clone https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer
claude --plugin-dir ./Claude-Intercom-HelpCenter-Article-Writer
```

**As a plain skill** (no commands, agents or hooks; the core skill and its scripts only):

```bash
git clone https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer /tmp/ihc
mkdir -p .claude/skills/intercom-help-center
cp -r /tmp/ihc/skills/intercom-help-center/. /tmp/ihc/scripts /tmp/ihc/templates .claude/skills/intercom-help-center/
```

The skill then finds its scripts under its own folder. Ask Claude "audit our help center" and it picks the skill up from its description. This mode has no slash commands, agents or hooks (they rely on the plugin layout), so the publish guard is only the one built into `publish.mjs`. Prefer the plugin.

### Versions

`main` is the stable branch: it is what the marketplace installs and what the CI templates pin by tag. `dev` is unreleased work. Releases are tagged (`v2.0.0`); see [CHANGELOG.md](CHANGELOG.md).

## Commands

| Command | What it does | Touches Intercom |
|---|---|---|
| `/intercom-help-center:setup` | Detect everything, ask what it cannot detect, save `.help-center/config.json`. Safe to re-run. | reads `/me` |
| `/intercom-help-center:audit` | Read the whole Help Center, compare with the code, write the ranked report | read-only |
| `/intercom-help-center:plan` | Propose the collection tree and the correction plan; record your approvals | no |
| `/intercom-help-center:fix` | Carry out approved items: pre-write check, write from code, adversarial review, pull request | no |
| `/intercom-help-center:publish` | Dry run with diffs, then publish approved articles (one first), within the cap | writes, after you confirm |

Commands are namespaced by the plugin name. If nothing else uses the name, the short form (`/audit`) works too. You can also just ask: "which of our features have no help article?", "write an article for the CSV export", "clean up our help center". The core skill handles those.

Under the hood each command runs zero-dependency Node scripts you can also run yourself (`node scripts/<name>.mjs --help`): `doctor`, `audit`, `plan-collections`, `correction-plan`, `find-existing`, `pull`, `publish`, `pr`, `coverage-check`.

## Agents

| Agent | Tools | Job |
|---|---|---|
| `help-center-auditor` | Read, Grep, Glob, Bash, Edit | Runs the audit, verifies DELETE / WRITE / MERGE proposals against the code, writes evidence into the plan. Never approves or publishes. |
| `help-center-writer` | Read, Grep, Glob, Write, Edit, Bash | Writes and fixes articles strictly from code and strings: pre-write check first, question titles, verbatim labels, cited sources, a "What this does NOT do" section. Never publishes. |
| `help-center-reviewer` | Read, Grep, Glob | Adversarial: breaks the article into claims and checks each against the code. PASS only when every claim is traced; otherwise REJECT with fixes. Read-only. |

## Hooks

| Hook | When | What it does |
|---|---|---|
| Publish guard | before a shell command | Blocks `publish.mjs --publish` without an approved plan, and any `--max` above your configured cap. An agent cannot mass-publish or raise its own cap. |
| Secret guard | before a write or a shell command | Blocks writing an Intercom token into a file (or through `echo ... > file`). |
| Stale reminder | after an edit, and at the end of a turn | When you edit a file that an article cites in `sources:`, tells Claude which articles may now be stale and suggests the audit. Never blocks. |

They are fast, and fail safe: if a hook itself breaks, it lets the action through (the publisher enforces the same plan and cap rules on its own). Turn them off with `hooks.enabled`, `hooks.publishGuard`, `hooks.secretGuard` or `hooks.staleReminder` set to `false` in `.help-center/config.json`, with `HELP_CENTER_HOOKS=off`, or by disabling the plugin.

## Configuration

Setup writes `.help-center/config.json`; commit it (it never holds a secret, and saving refuses anything token-shaped). The keys you are most likely to touch:

| Key | Default | What it does |
|---|---|---|
| `articlesDir` | `help-articles/articles` | where article markdown lives |
| `manifest` | `help-articles/coverage-manifest.mjs` | the coverage manifest (features, what each owes) |
| `strings` | `[]` | UI strings files (JSON, Rails YAML, .po, .strings, Android XML) |
| `publish.cap` | `20` | the most writes one publish run may make |
| `pr.base` | detected, confirmed once | the branch help-center PRs go to |
| `collectionMap` | `{}` | put a feature in a specific collection: `{"csv-export": "Orders › Exporting"}` |

Every key, with defaults and examples: [docs/CONFIG.md](docs/CONFIG.md).

### Environment variables

| Variable | Required | Default | What it is |
|---|---|---|---|
| `INTERCOM_API_TOKEN` | for audit, pull and publish | none | Intercom access token. Export only this key in the shell; never write it to a file. |
| `INTERCOM_REGION` | no | config, else `us` | `us` = `https://api.intercom.io`, `eu` = `https://api.eu.intercom.io`, `au` = `https://api.au.intercom.io`. Setup detects it. |
| `INTERCOM_AUTHOR_ID` | no | config, else the token's admin | Admin shown as the author of new articles |
| `INTERCOM_API_VERSION` | no | `2.11` | `Intercom-Version` header |
| `INTERCOM_HELP_CENTER_ID` | no | the default help center | only for workspaces with several help centers, when creating collections |
| `HELP_CENTER_HOOKS` | no | on | `off` disables the plugin's hooks |

## GitHub Actions

Three templates in [`templates/github/`](templates/github/). Copy the ones you want to `.github/workflows/`.

| Template | Runs | Needs | Does |
|---|---|---|---|
| `help-center-gate.yml` | every PR and push | nothing | Fails when a shipped feature has no article (or no ticketed reason), an article file is missing, or an article cites code that no longer exists. Warns on stale articles. |
| `help-center-audit.yml` | weekly + on demand | secret `INTERCOM_API_TOKEN` (read access) | Read-only audit; the report goes to the job summary and a 14-day artifact. |
| `help-center-draft-fixes.yml` | on demand (optional schedule) | `INTERCOM_API_TOKEN`, `ANTHROPIC_API_KEY`, the [Claude GitHub App](https://github.com/apps/claude) | Audits, then runs [`anthropics/claude-code-action@v1`](https://github.com/anthropics/claude-code-action) with this plugin to draft fixes, and opens a **draft** PR. Claude never receives the Intercom token and never publishes. |

The templates check out this repo at a release tag, so your CI does not change under you. Add the gate once your manifest's features have their cells decided (after your first plan): until then it lists every undecided cell, which is the backlog, not a bug. Publishing is never automated: it stays a human step on a developer machine. More in [docs/WORKFLOWS.md](docs/WORKFLOWS.md#ci).

## Safety model

| Guard | Where it lives |
|---|---|
| The audit cannot write: its API client throws on anything but GET | `scripts/lib/intercom.mjs` |
| Dry run is the default; the dry run prints exact field changes and a text diff | `publish.mjs` |
| Real writes need an approved plan with a named approver | `publish.mjs` and the publish-guard hook |
| A cap on writes per run, checked before the first write | `publish.mjs` and the hook |
| Never a duplicate: the pre-write check, then adoption of an existing same-title article | `find-existing.mjs`, `publish.mjs` |
| Never overwrite an edit made in the Intercom UI without asking (3-way view) | `publish.mjs` |
| Never publish into the wrong workspace | `intercom_workspace` in frontmatter |
| No delete capability at all; DELETE verdicts become "archive" or a human click | by design |
| Only help-center files are committed, on a branch the plugin created; never `--force`, never stash | `pr.mjs`, `lib/git.mjs` |
| The token lives only in the environment; config saving and a hook refuse token-shaped text | `lib/config.mjs`, secret-guard hook |
| Resumable: every file is written back as soon as its write succeeds | `publish.mjs` |

## Edge cases

Each row is handled in code and exercised by `node scripts/selftest.mjs` unless the last column says otherwise.

| Situation | What happens | In the selftest |
|---|---|---|
| A brand-new workspace with no articles | audit reports every shipped feature as uncovered | yes |
| Thousands of articles | every page is read; 429s retried with backoff, `Retry-After` honoured; near-duplicates via an index, not all pairs | pagination and 429: yes · scale: no |
| Article edited in the Intercom UI after publishing | publish stops for it, prints a 3-way view, asks | yes |
| Article deleted on Intercom, id still in the file | reported (IHC034); `--recreate-missing` to recreate | yes |
| An id from a different workspace | refused (IHC035) | yes |
| Multilingual articles | audit flags missing translations; `locale:` + `translation_of:` files publish into `translated_content` | yes (fake API shape) |
| Draft vs published | only `state: published` is sent unless `--include-drafts`; drafts flagged in the audit | yes |
| Collections nested 3+ levels | resolved and created at any depth (`section: "A › B"`) | yes |
| A collection renamed in Intercom | resolved through the saved `collection_id`, with a warning | yes |
| The same title in two collections | audit separates true duplicates from naming clashes; the pre-write check returns AMBIGUOUS; publish refuses to guess | yes |
| Images and embeds | preserved both ways; raw HTML passed through untouched with a warning | yes |
| HTML the converter cannot express | kept as a raw HTML block on import, sent back byte for byte | yes |
| A feature removed from the code | its articles become orphans → DELETE proposal → archive or a human click; never automatic | yes |
| A monorepo | detected (workspaces, turbo, nx, lerna); several strings files; paths resolved from the git root | detection: yes |
| No git | audit, write and publish work; the PR step says so (IHC060) | message only |
| Windows paths and CRLF files | parsed, and CRLF kept on write-back | yes (CI also runs on Windows) |
| A token without write access | first write fails with IHC004; nothing changed | yes |
| Network failure mid-publish | run stops; re-running adopts what landed instead of duplicating | yes |
| No author id | from config, env, or the token's admin; else IHC037 | yes |
| Dry run showing exact changes | fields that change and a line diff against the live article | yes |
| PR base: config, repo docs, merged-PR history, long-lived branches, default branch, protection | decided with evidence; conflicts ask once | yes |
| No `gh` | branch pushed, compare URL printed | yes |
| `gh` logged in as a different account than the repo owner | noted; pushes to your fork and opens a cross-repo PR if you cannot push | yes |
| Base branch missing, head behind base, head == base, dirty tree | refused with the fix; never rebases, stashes or force-pushes | yes |
| GitLab, Bitbucket or another host | branch pushed, merge-request URL printed, no automatic PR | yes |
| Repos with i18n JSON, Rails YAML, or no i18n at all | strings detected, or text read from components | yes |

## FAQ

**Does it publish on its own?** No. Publishing needs an approved plan, a dry run you have seen, and your go-ahead; CI never publishes.

**Will it delete my articles?** No. It has no delete capability. A DELETE verdict means "archive (set to draft) or delete it yourself in Intercom", after you say yes.

**What if my team edits articles in Intercom?** Keep doing it. The publisher detects those edits and asks which version wins. `pull.mjs` brings the live version into the repo.

**We have no i18n files.** Fine. The writer reads button text from your components and cites those files.

**Our help center is in several languages.** The audit flags missing translations; translations are separate files published into the source article.

**Does it need npm install?** No. Node 18+ and nothing else.

**Can I use it without GitHub?** Yes. GitLab and Bitbucket get a merge-request link; without a remote the branch stays local; without git you can still audit and publish.

**What does the audit send anywhere?** It reads from Intercom and writes files in your repo. Nothing else. The snapshot of article bodies stays in `.help-center/` and is gitignored.

**I used v1 (intercom-article-writer).** Your articles and manifest keep working. Remove the old skill folder and install the plugin; see [Upgrading from 1.x](CHANGELOG.md#upgrading-from-1x).

**Why an API token and not Intercom's MCP server?** The token lets the plugin read the whole help center, run in CI, and enforce the dry run, plan, cap and drift checks in code. See the [comparison](#how-is-this-different-from-intercoms-official-claude-plugin).

## Troubleshooting

Every error prints a code, its cause and its fix. The full list, generated from the code so it cannot drift: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Common ones: `IHC001` no token · `IHC002` wrong region · `IHC031` plan not approved · `IHC036` edited on Intercom · `IHC062` PR base undecided.

## Tested vs not tested

**Tested** by `node scripts/selftest.mjs` (offline, on Linux and Windows, Node 18 and 22 in CI) against an in-memory fake of the Intercom REST API and a scripted fake of git and gh: the whole audit (pagination, every finding type, bodies fetched when the list omits them), both plans and approvals, publishing (create, write-back, update by id, adoption, drift, deleted, other workspace, cap, 429 retry, network failure, 403, missing author, renamed and nested collections, translations, CRLF, embeds), the pre-write check, pull, the PR flow in every repo shape above, setup detection, the hooks as real processes, the coverage gate, the docs-vs-code check, and a scan for secrets and private names. `claude plugin validate` passes, and the plugin was installed from this marketplace into a clean Claude Code config (6 skills, 3 agents, 3 hooks loaded).

**Not tested against a live Intercom workspace yet:** the audit, `--publish`, `--create-collections`, moves, translations, `pull`, and doctor's region and permission checks have run only against the fake API, which models Intercom's documented API shapes (version 2.11) but cannot prove Intercom accepts and renders every payload. Also untested: real `gh`/`git` runs of `pr.mjs` (scripted fakes only), the hooks inside a live Claude Code session, the GitHub Actions templates on GitHub, the Claude Code GitHub Action run, Intercom's MCP server as a read path, and performance on thousands of articles. **Before trusting a bulk run, audit once, then publish ONE article and open it in your Help Center.** Reports from real workspaces are welcome in the issues.

## Uninstall

```text
/plugin uninstall intercom-help-center@claude-intercom-help-center
/plugin marketplace remove claude-intercom-help-center
```

Then delete `.help-center/` and your copies of the workflow templates if you do not want them. Your articles stay in your repo and on Intercom.

## Contributing and support

- **Questions and help:** [Discussions > Q&A](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/discussions/categories/q-a)
- **Ideas:** [Discussions > Ideas](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/discussions/categories/ideas)
- **Bugs, feature requests, docs fixes:** [open an issue](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/issues/new/choose) (each has a short form)
- **Pull requests:** branch from `dev` and target `dev`; CI must pass and the maintainer reviews every change. Details in [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing, security, license

[CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) (never commit tokens; report privately) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · [CHANGELOG.md](CHANGELOG.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

MIT. See [LICENSE](LICENSE).
