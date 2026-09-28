# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Branches

- `main` is stable: it is what the marketplace installs. Nobody pushes to it directly.
- `dev` is where work lands. Open pull requests against `dev`.
- A release is a pull request from `dev` to `main`, merged with a merge commit, then tagged (`v2.1.0`) with a GitHub Release and a CHANGELOG entry.

## Setup

No dependencies. You need Node 18+ and git.

```bash
git clone https://github.com/oderajoseph95/claude-intercom-help-center
cd claude-intercom-help-center
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
