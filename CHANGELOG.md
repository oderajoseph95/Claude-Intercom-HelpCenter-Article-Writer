# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [3.0.1] - 2026-09-29

The repository is renamed to `Claude-Intercom-HelpCenter-Article-Writer`. Links and docs only; the plugin itself is unchanged.

### Changed
- **Repository**: now [oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer) (was `oderajoseph95/claude-intercom-help-center`; GitHub redirects the old URL). Every link, badge, install command and manifest URL points at the new name.
- **Install**: `/plugin marketplace add oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer`, then `/plugin install intercom-help-center@claude-intercom-help-center`. The plugin name and the marketplace name are unchanged.
- **GitHub Actions templates** check out `oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer` at `ref: v3.0.1`.

### Fixed
- **Windows install**: `/plugin marketplace add` could fail with a misleading "SSH/HTTPS authentication failed" because git hit Windows' path-length limit on a deep example file. The example article is now `examples/help-articles/articles/getting-started/export-csv.md`, and the README, setup guide and troubleshooting page say to run `git config --global core.longpaths true` if it still happens.
- **Release pin**: the pin goes on the marketplace, `/plugin marketplace add oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer#v3.0.1`. The `@v3.0.0` form shown in 3.0.0 does not work.

### Added
- **Issue forms** for bug reports, feature requests and docs improvements. Blank issues stay off.
- **Discussions** are open, with forms for Q&A and Ideas.
- **CONTRIBUTING.md** explains how to get help, report a bug, suggest a feature, start a discussion and send a pull request. The README links to it.

### Upgrading from 3.0.0
- Nothing to do if you installed from the marketplace: the old URL redirects. To point at the new name, run `/plugin marketplace remove claude-intercom-help-center`, then the two install commands above.
- If you copied a workflow from `templates/github/`, change `repository:` to `oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer` and `ref:` to `v3.0.1`.

## [3.0.0] - 2026-09-29

The display name changes to "Intercom Help Center Article Writer for Claude Code". Nothing else about installing or running the plugin changes.

### Changed
- **Display name**: the README title and the plugin's `displayName` now read "Intercom Help Center Article Writer for Claude Code". The plugin name (`intercom-help-center`), the marketplace name and the repository are unchanged.
- **GitHub Actions templates** pin `ref: v3.0.0`, and the README and setup guide show `@v3.0.0` as the release pin example.

### Added
- **Live example**: the README links to [help.tacey.app](https://help.tacey.app), the help center this workflow was built on.
- **CODEOWNERS** for the repository.

### Repository
- `main` is branch-protected: changes land through a pull request with the four CI checks green.

### Upgrading from 2.x
- No breaking change. The install commands are the same:
  `/plugin marketplace add oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer` and `/plugin install intercom-help-center@claude-intercom-help-center`.
- If you copied a workflow from `templates/github/`, you can change its `ref: v2.0.0` to `ref: v3.0.0`. The v2.0.0 tag stays available.

## [2.0.0] - 2026-09-29

The skill becomes a Claude Code plugin that manages the whole Help Center, not only new articles.

### Added
- **Plugin packaging**: `.claude-plugin/plugin.json` and a marketplace in the same repo. Install with `/plugin marketplace add oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer` and `/plugin install intercom-help-center@claude-intercom-help-center`.
- **Commands**: `/intercom-help-center:setup`, `:audit`, `:plan`, `:fix`, `:publish`.
- **Agents**: `help-center-auditor` (verifies findings against the code), `help-center-writer` (writes strictly from code and strings), `help-center-reviewer` (adversarial, read-only).
- **Hooks**: a publish guard (approved plan and cap), a secret guard (no Intercom token in files), and a stale-article reminder when cited code changes.
- **Setup and doctor** (`doctor.mjs`): detects the repo, stack, UI strings (JSON, Rails YAML, .po, .strings, Android XML), features and routes, monorepos, GitHub access, the PR base branch with evidence, and the Intercom workspace and region; saves `.help-center/config.json`; can scaffold a coverage manifest.
- **Audit** (`audit.mjs`): read-only, every page, bodies and translations; finds uncovered features, empty, short, duplicate and near-duplicate articles, same titles in two collections, broken links, links to drafts, articles in no collection, drafts, non-question titles, stale and orphan articles, missing translations, articles deleted on Intercom, files from another workspace, articles with no source file, empty collections. Ranked report in markdown and JSON.
- **Categorize** (`plan-collections.mjs`): a collection tree from the features, with every article placed; approval recorded in the plan.
- **Correction plan** (`correction-plan.mjs`): FIX, REWRITE, MERGE, DELETE, KEEP, WRITE with evidence; approve all, some or none.
- **Pre-write check** (`find-existing.mjs`): UPDATE, UPDATE-LOCAL, AMBIGUOUS or CREATE, from a snapshot refreshed when stale.
- **Pull** (`pull.mjs`): import live articles to markdown, keeping embeds and unknown HTML byte for byte.
- **Pull requests** (`pr.mjs`): base branch from config, the repo's docs, merged-PR history, long-lived branches, the default branch and protection; branches only under a prefix; commits only help-center files; never force-pushes or stashes; forks, GitLab, Bitbucket and no-remote handled.
- **Publisher**: `--create-collections` (any depth) and `--plan` (apply an approved collections plan: create and move), translations, drift protection with a 3-way view, deleted-article and other-workspace checks, adoption instead of duplicates, retries on 429 with Retry-After, resumable runs, exact diffs in the dry run, and an approved plan required for real writes.
- **Message catalog**: every error has a code, cause and fix; `docs/TROUBLESHOOTING.md` is generated from it.
- **GitHub Actions templates**: coverage gate, weekly read-only audit, optional Claude-drafted fix PRs (never publishes).
- **Docs**: setup guide, config reference, workflows, troubleshooting, architecture; sample output from the test fixtures.
- **Tests**: `node scripts/selftest.mjs` runs everything offline against a fake Intercom API and a fake git; CI on Linux and Windows, Node 18 and 22.

### Upgrading from 1.x
- If you cloned v1 into `.claude/skills/intercom-article-writer`, delete that folder and install the plugin instead (the skill no longer lives at the repo root, so a `git pull` there leaves a folder without a `SKILL.md`).
- Existing articles keep working: `intercom_id`, `intercom_url` and `last_synced` are read as before. The first v2 publish adds `intercom_workspace`, `remote_hash` and the other write-back keys. Until then, edits made in Intercom are detected by comparing Intercom's `updated_at` with `last_synced`.
- Your coverage manifest works unchanged. Adding `label`, `keywords` and `strings` to each feature makes the audit's feature matching much better.
- Real publishing now needs an approved plan. For the v1 habit of publishing a reviewed article directly, create an ad-hoc plan (`correction-plan.mjs --adhoc`) or set `publish.requireApprovedPlan: false`.

### Changed
- The repository is now `claude-intercom-help-center` (was `intercom-article-writer`).
- The skill moved from the repo root to `skills/intercom-help-center/`; scripts and templates stay at the root.
- `coverage-check.mjs` reads the manifest path from config and reports catalogued codes.
- The example workflow moved to `templates/github/help-center-gate.yml`.

## [1.0.0] - 2026-09-28

### Added
- The `intercom-article-writer` skill: write help articles from code, a coverage manifest and CI gate (`coverage-check.mjs`), and a markdown-to-Intercom publisher (`publish.mjs`) with spacer paragraphs, H1 stripping, paginated collections, create-or-update by id with write-back, `--create-sections`, `--parity`, a dry-run default and a 20-article cap.

[Unreleased]: https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/compare/v3.0.1...dev
[3.0.1]: https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/compare/881238a...v2.0.0
[1.0.0]: https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/tree/881238a
