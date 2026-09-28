---
name: audit
description: Read-only audit of the whole Intercom Help Center against the code - duplicates, empty and short articles, broken links, drafts, articles in no collection, stale and orphan articles, missing translations, and shipped features with no article. Writes help-center-audit.md and .json.
argument-hint: "[--snapshot file] [--min-words n] [--stale-days n]"
disable-model-invocation: true
---

# Audit the help center

Rules: `${CLAUDE_PLUGIN_ROOT}/skills/intercom-help-center/SKILL.md`. `S` = `${CLAUDE_PLUGIN_ROOT}/scripts`.

1. If `.help-center/config.json` is missing, run `/intercom-help-center:setup` first, or at least confirm the features and strings sources; without them the audit cannot check coverage (IHC023).
2. Run `node S/audit.mjs $ARGUMENTS`. It is read-only: its Intercom client cannot send a write. With `--snapshot <file>` it re-audits a saved snapshot offline.
3. On an error, read the printed code and its fix line (IHC001 no token, IHC002 wrong region, IHC003 no read permission, IHC005 rate limited). Do not retry blindly.
4. Summarise `.help-center/help-center-audit.md` for the user: totals, feature coverage, and the top 10 findings by impact, each with the article title and link, plus the count per finding type. Do not paste the whole report.
5. With more than a handful of findings, hand the report to the `help-center-auditor` agent to verify against the code (it checks orphans and uncovered features in the source, not only by name).
6. Offer the next step: `/intercom-help-center:plan`.
