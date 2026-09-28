# Hunt log (v2.0.0)

Before release, the whole loop (install → setup → audit → plan → fix → PR → publish) was walked as a new user on three freshly made repositories, with real git and the scripts run for real. Intercom was the in-memory fake from the test suite. Every place that stuck, confused or could burn someone is listed here with what changed.

## The three repos

| Repo | Shape |
|---|---|
| **Next.js SaaS** | `app/` router with a route group `(app)`, `messages/en.json` + `fr.json`, CONTRIBUTING.md saying "open pull requests against `develop`", default branch `main`, a `develop` branch, a remote that is a bare repo on disk |
| **Rails app** | `config/routes.rb` with `resources`, `config/locales/en.yml`, branch `master`, no remote |
| **No i18n** | a React component with the button text inline, no strings file, no feature list, no remote |

## Findings and fixes

| # | Where | What happened | Fixed by |
|---|---|---|---|
| 1 | setup, Next | A remote that is a folder on disk printed as `null/null/null (unknown)` | Remotes are parsed as `local` and shown by path; the PR step pushes and says there is no web host to open a PR on (new message IHC075) |
| 2 | setup, Next | Both `messages/en.json` and `messages/fr.json` were marked as English: the English detector matched the folder name `messages` | The detector now looks only at locale segments (`en`, `en-US`, `Base.lproj`, Android `values/`) |
| 3 | setup, Next | The CONTRIBUTING evidence quote kept a stray backtick | Evidence quotes are stripped of markdown |
| 4 | setup, Rails | With no remote, the PR base was UNDECIDED with "no signal found", though `master` was the only branch | With no remote, the single local long-lived branch is the base |
| 5 | setup, Rails | The scaffolded manifest's `shipped()` tried to read `config/routes.rb` as a folder and crashed | Framework-specific scaffolds (Rails, Laravel, Django) are checked before the generic route-folder one |
| 6 | setup, Rails | UI string keys came out as `en.invoices.title`, so no feature matched its strings | Rails YAML keys drop the single locale root, like JSON keys |
| 7 | setup, Next | Routes inside a Next.js route group `(app)` were never counted as features; file-based routers (`pages/pricing.tsx`, Remix flat routes) were ignored | The scaffold looks inside route groups, counts files as routes, and skips index, layouts, dynamic segments and api/ |
| 8 | setup, all | The scaffolded manifest had an empty FEATURES, so the audit could not match any article to a feature until someone typed them all in | The scaffold pre-fills FEATURES from what `shipped()` finds, with a label and a strings prefix guessed from the strings file. Kinds stay empty on purpose: deciding them is the human's job |
| 9 | setup, no i18n | Nothing detected; the gate then fails with IHC021 (no features) | Kept on purpose: a gate that passes on zero features proves nothing. SETUP.md and the setup command say to fill `shipped()`; the README tells people to add the gate to CI after the first plan |
| 10 | fix, Next | **Blocker.** `pr start` refused to run because setup, the audit and the plans had left their own files uncommitted: the loop could never reach the PR step | Uncommitted files in the plugin's own paths (`.help-center/`, the articles folder, the manifest) are carried onto the new branch; anything else still stops the run |
| 11 | fix, Next | **Burn risk.** If the audit ran before setup, `.help-center/.gitignore` did not exist and the snapshot (every article body, drafts included) would have been committed by the PR step | The audit and the pre-write check create the ignore file themselves, and the PR step refuses to stage the snapshot, session files and the PR body whatever git says |
| 12 | publish, Next | The dry-run diff read "click Invite teammate ." (a space before the full stop) | Inline tags are removed without adding spaces when HTML is turned into text |
| 13 | fix | Branch names used the UTC date, a day off for users east or west of it late in the day | Branch dates use local time |
| 14 | fix | The PR body file would have been committed into the PR | Added to the local-only list |
| 15 | plan | Output paths were printed as long absolute Windows paths | Printed relative to the repo |
| 16 | plan | Articles already in Getting started with no feature were sent to "needs a human" | Articles already in a standard collection are KEEP |
| 17 | audit | Two articles with the same title and the same text in different collections were reported as a naming clash, not a duplicate, so the plan never proposed merging them | Same title plus same text is a duplicate wherever it lives; same title with different text is a naming clash |
| 18 | audit | Every article of a translated help center was "missing" its own default language | The default locale counts as present when the article has content |
| 19 | audit | Common words in the body ("order", "edit") matched articles to the wrong feature | A match now needs a specific signal: the label, a quoted UI string, or title keywords |
| 20 | publish | "Keep Intercom's version" after drift re-imported the article and dropped the local `sources:` | `pull --replace` keeps the local frontmatter and takes Intercom's title, text and sync keys |
| 21 | fix → publish | A one-off article written without an audit could not be published at all, because publishing needs an approved plan | Ad-hoc plans: `correction-plan.mjs --adhoc --files ... --by ...` approves exactly those files (IHC046 for anything else) |
| 22 | manual install | Copying the agents into `.claude/agents` would have left them pointing at plugin paths that do not exist | The manual-install instructions no longer copy the agents; the skill says to do their job itself in that mode |
| 23 | upgrade | v1 users who `git pull` in their skill folder would lose `SKILL.md` | "Upgrading from 1.x" in the CHANGELOG and the README FAQ |

## Checked against Claude Code's plugin docs

| Area | Result |
|---|---|
| `plugin.json` | name, displayName, version, description, author, homepage, repository, license, keywords. Passes `claude plugin validate --strict` |
| `marketplace.json` | name, owner, description, one entry with `source: "./"`, category, tags; entry name equals the manifest name; the name is not reserved. Passes validation |
| Install | `claude plugin marketplace add ./` then `claude plugin install intercom-help-center@claude-intercom-help-center` in a clean config: 6 skills, 3 agents, 3 hooks loaded |
| Commands | written as skills with `description`, `argument-hint`, `disable-model-invocation: true` (the docs recommend `skills/` over `commands/` for new plugins) |
| Agents | `name`, `description`, `tools` (minimal per agent), `model`, `color`; none of the fields plugin agents ignore (`hooks`, `mcpServers`, `permissionMode`) |
| Hooks | `hooks/hooks.json` with `PreToolUse`, `PostToolUse`, `Stop`, exec form (`command` + `args`) with `${CLAUDE_PLUGIN_ROOT}`, timeouts; deny through `permissionDecision`, context through `additionalContext`, the Stop reminder through `systemMessage` and never blocking |
| Skill paths | `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_SKILL_DIR}` in skill bodies, as the docs describe |
| GitHub Action | `anthropics/claude-code-action@v1` with `anthropic_api_key`, `plugin_marketplaces`, `plugins`, `prompt`, `claude_args`, and the `id-token: write` permission, as in the docs' examples |

## Still open (not fixed, stated honestly)

- Nothing here has run against a real Intercom workspace. The fake models the documented API; only a real run proves the payloads.
- Real `gh pr create` was not run (the Next.js repo's remote was a folder). The GitHub path is covered by the scripted fake.
- Hooks were run as processes with real hook input, not inside a live Claude Code session.
- `AskUserQuestion` prompts are instructions to Claude; how each prompt looks depends on the Claude Code version.
