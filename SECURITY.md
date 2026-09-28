# Security

## Reporting a vulnerability

Please report it privately: [open a security advisory](https://github.com/oderajoseph95/Claude-Intercom-HelpCenter-Article-Writer/security/advisories/new). Do not open a public issue. You will get an answer within a few days.

Useful things to include: what an attacker could do, the steps to reproduce, and the version.

## Never commit tokens

- The Intercom token belongs in the `INTERCOM_API_TOKEN` environment variable of your shell, or in a CI secret. Never in `.help-center/config.json`, an article, a script, a commit, or the chat.
- Export only that one variable. Do not load a whole `.env` into a Claude Code session or a CI job.
- The plugin helps: saving config refuses token-shaped values, and the secret-guard hook blocks writing a token into files. These are safety nets, not a reason to relax.
- If a token was committed or pasted anywhere, revoke it in Intercom's Developer Hub right away and create a new one. Removing it from git history is not enough.

## What the plugin can do with your token

- The audit, the pre-write check and `pull` only read (their API client refuses writes).
- `publish.mjs` writes only with `--publish`, only for an approved plan, and only up to the cap. It can create and update articles and collections, and move articles. It cannot delete anything.
- Nothing is sent anywhere except Intercom's API for your region. No telemetry.

## Scope

The plugin runs locally with your permissions. Review the scripts before running them against a production Help Center; they are plain Node with no dependencies, so that is practical.
