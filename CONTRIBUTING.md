# Contributing

Thanks for helping. Questions, bug reports, suggestions and pull requests are all welcome.

## How to get help, report a bug, or suggest a feature

| You want to | Go here |
|---|---|
| **Get help** using the plugin (install, setup, an error you do not understand) | [Discussions > Q&A](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/discussions/categories/q-a). Check [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) first: every IHC error code has a cause and a fix. |
| **Report a bug** (the plugin did something wrong) | [Open a bug report](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/issues/new?template=bug_report.yml). The form asks for the plugin version, Claude Code version, OS, the command you ran, what you expected and what happened, and the `doctor` output. |
| **Suggest a feature** you already know you want | [Open a feature request](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/issues/new?template=feature_request.yml). |
| **Float an idea** you want to talk through first | [Discussions > Ideas](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/discussions/categories/ideas). A clear idea can become a feature request later. |
| **Fix the docs** (wrong, unclear, missing, broken link) | [Open a docs improvement](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/issues/new?template=docs_improvement.yml), or send a pull request directly. |
| **Report a security problem** | [Open a private security advisory](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/security/advisories/new). Never a public issue. See [SECURITY.md](SECURITY.md). |
| **Share how you use it** | [Discussions > Show and tell](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/discussions/categories/show-and-tell). |

Before posting anything: **remove your Intercom token, API keys, real workspace ids and private article content.** `doctor` never prints the token, but check its output anyway.

## Contributing a pull request

1. Fork the repo and branch from `dev`.
2. Make your change, with a test (see the rules below).
3. Run `node scripts/selftest.mjs`; it must end with `0 failed`.
4. Open the pull request **against `dev`**, never `main`. Fill in the pull request template.
5. CI must pass: the selftest on Linux and Windows with Node 18 and 22, the example coverage gate, and the docs check.
6. The maintainer reviews every pull request (see [.github/CODEOWNERS](.github/CODEOWNERS)) and merges it into `dev`. Releases then go from `dev` to `main`.

## Branches

- `main` is stable: it is what the marketplace installs. Nobody pushes to it directly.
- `dev` is where work lands. Open pull requests against `dev`.
- A release is a pull request from `dev` to `main`, merged with a merge commit, then tagged (`v2.1.0`) with a GitHub Release and a CHANGELOG entry.

## Setup

No dependencies. You need Node 18+ and git.

```bash
git clone https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer
cd Claude-Intercom-HelpCenter-Article-Writer
node scripts/selftest.mjs
claude --plugin-dir .        # try your changes in Claude Code
```

## Rules

1. **Keep it zero-dependency.** Node built-ins only.
2. **Every behaviour change has a test**, shown failing before the change. Tests are in `test/*.test.mjs`; they run offline against `test/fake-intercom.mjs` and `test/fake-git.mjs`. Run one file with `node scripts/selftest.mjs <name>`.
3. **Every message a user can see goes in `scripts/lib/messages.mjs`** with a code, cause and fix. Then run `node scripts/gen-docs.mjs`; the selftest fails if `docs/TROUBLESHOOTING.md` is out of date.
4. **Anything that writes to Intercom** needs the same guards as publishing: dry run by default, an approved plan, the cap, and a test proving each.
5. **Update the docs** that describe what you changed: README, `docs/`, and the skill references in `skills/intercom-help-center/references/`.
6. **Validate the plugin** if you touched `.claude-plugin/`, `skills/`, `agents/` or `hooks/`: `claude plugin validate .`.
7. **Be honest about testing.** If you could not test something against a real Intercom workspace, say so in the PR. The README's "Tested vs not tested" section is updated with every release.
8. **Never commit a token**, a real workspace id, or private article content. Fixtures use made-up data.

## Reporting real-workspace results

The most useful contribution right now: run the read-only audit against your own Help Center and report what worked and what did not (without sharing private content). Use the bug report template.
