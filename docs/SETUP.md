# Setup guide

From nothing to your first audit. About ten minutes, most of it creating the Intercom token.

## 1. Requirements

| | Needed for | Check |
|---|---|---|
| Claude Code | everything | `claude --version` |
| Node 18 or newer | every script (no npm install; zero dependencies) | `node --version` |
| An Intercom workspace with a Help Center, and admin access to create an app | audit, pull, publish | |
| git | the pull request step | `git --version` |
| GitHub CLI, logged in (optional) | opening PRs automatically | `gh auth status` |

Without `gh`, branches are still pushed and you get a link to open the PR. Without git, you can still audit, write and publish; only the PR step is skipped.

## 2. Install the plugin

In Claude Code, from any folder:

```text
/plugin marketplace add oderajoseph95/claude-intercom-help-center
/plugin install intercom-help-center@claude-intercom-help-center
```

What you see: `/plugin install` opens the plugin's details in the `/plugin` panel; choose install (user scope is fine). Check it loaded with `/plugin` (it lists 6 skills, 3 agents, 3 hooks) or `claude plugin details intercom-help-center` in a shell.

To pin a release instead of following `main`: `/plugin marketplace add oderajoseph95/claude-intercom-help-center@v2.0.0`.

## 3. Create an Intercom access token

The plugin talks to Intercom's REST API with a token that belongs to your workspace.

1. In Intercom, open **Settings → Integrations → Developer Hub** (the Developer Hub opens at developers.intercom.com).
2. **New app**. Give it a name you will recognise, such as "Help center sync", and pick the workspace whose Help Center you want to manage. An internal app (for your own workspace) is all you need.
3. Open the app's **Authentication** page. The **access token** for your workspace is shown there.
4. Under the app's permissions (scopes), enable:
   - **Read and List articles**: the audit, the pre-write check and pull.
   - **Read and Write Articles**: publishing, creating collections and moving articles. Leave it off if you only want audits.
   - The token's own admin (`GET /me`) is used to find your workspace name and a default author; if setup reports it cannot read it, also enable **Read one admin** (or **Read admins**).
5. Save. If you change scopes later, the app may ask you to re-authorise; use the token it then shows.

> Menu names above are Intercom's as of 2026-09. If they have moved, search Intercom's developer docs for "access token" and "OAuth scopes". Scope names come from Intercom's OAuth scopes page.

**Where your workspace is hosted** decides the API address. You do not need to know it: setup tries all three and saves the one that works.

| Region | API base URL |
|---|---|
| US | `https://api.intercom.io` |
| EU | `https://api.eu.intercom.io` |
| Australia | `https://api.au.intercom.io` |

## 4. Put the token in your shell, not in a file

In the terminal where you run Claude Code, inside your product's repo:

```bash
export INTERCOM_API_TOKEN=paste-the-token-here     # macOS / Linux / Git Bash
```

```powershell
$env:INTERCOM_API_TOKEN = "paste-the-token-here"   # Windows PowerShell
```

Then start Claude Code from that same terminal (`claude`). Export only this one variable: never `source` a whole `.env` into a session or a CI job. Never paste the token into the chat, a config file, or a commit. The plugin's secret guard blocks writing it into files, and its config refuses to save anything token-shaped.

For a longer-lived setup, keep it in your OS keychain or password manager and export it when you need it.

## 5. Run setup

In Claude Code, in your product's repo:

```text
/intercom-help-center:setup
```

What happens, prompt by prompt:

1. **Detection report.** A list like:
   ```
   ✓ /code/acme-app on branch main · clean
   ✓ remote origin: github.com/acme/acme-app (github, ssh)
   → messages/en.json (i18n-json)
   · next-app-routes: app (14 files)
   GitHub: gh is logged in as jane: branches are pushed and PRs are opened automatically
   PR base: UNDECIDED (signals conflict: setup will ask)
   ✓ workspace "Acme Help" (abc123) · region eu
   ✓ can read articles
   ```
2. **"Where is your list of shipped features?"** with what it found: a coverage manifest, a features JSON, a routes folder. Choose one, or "create a coverage manifest from the routes". The manifest is the file that says which articles each feature owes; the CI gate reads it.
3. **"Where do the words your users see live?"** with the strings files it found, English first. Choose them, or "none, the text is in the components" (a repo with no i18n: the writer reads button text straight from the components).
4. **"The token belongs to workspace Acme Help (eu). Publish there?"** Yes, or stop and switch tokens.
5. **"Which branch should help-center pull requests go to?"**, only when it is not obvious, with the evidence: what CONTRIBUTING.md says, where your last merged PRs went, which long-lived branches exist, the default branch. The recommended answer is first.
6. **Saved.** `.help-center/config.json` is written (commit it: no secrets in it) and `.help-center/.gitignore` keeps the local snapshot out of git.

Re-run setup any time: it shows the current state and changes only what you change. Non-interactive: `/intercom-help-center:setup --yes` accepts only the confident detections.

## 6. First audit

```text
/intercom-help-center:audit
```

It reads every collection and article (read-only) and writes `.help-center/help-center-audit.md`. Claude summarises the top findings. See an example: [examples/sample-output/help-center-audit.md](../examples/sample-output/help-center-audit.md).

Next: [docs/WORKFLOWS.md](WORKFLOWS.md) for the first cleanup, weekly maintenance and shipping a new feature.

## 7. Optional: CI

Copy the templates you want from [`templates/github/`](../templates/github/) to `.github/workflows/` and add the secrets they name. Details in [WORKFLOWS.md](WORKFLOWS.md#ci).

## 8. Optional: GitHub CLI

```bash
gh auth login        # choose GitHub.com, HTTPS or SSH, and log in
gh auth status       # shows the account; setup reports whether it can push to your repo
```

If your account cannot push to the repo (a contributor on an open-source project), fork it (`gh repo fork --remote --remote-name fork`); the plugin then pushes to your fork and opens a cross-repo PR.
