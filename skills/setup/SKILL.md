---
name: setup
description: First-run setup for the Intercom help center plugin. Detects the repo, stack, UI strings, features, GitHub access, PR base branch and Intercom workspace, asks only what it cannot detect, and saves .help-center/config.json. Safe to re-run; shows the current state.
argument-hint: "[--yes]"
disable-model-invocation: true
---

# Set up the help center

Read `${CLAUDE_PLUGIN_ROOT}/skills/intercom-help-center/SKILL.md` for the rules, then do this. `S` = `${CLAUDE_PLUGIN_ROOT}/scripts`. Arguments: `$ARGUMENTS` (`--yes` = accept confident detections without asking, and ask nothing else).

1. **Detect.** Run `node S/doctor.mjs --json` from the repo root. It never prints the token. Read the JSON.
2. **Report** in a short list: repo and branch (and dirty files), remote and what GitHub access allows (`github.summary`), strings files found, feature sources found, articles folder, PR base with its evidence, Intercom workspace, region and read access, Node version. Mark each ✓ or ✗.
3. **Fix blockers first**, in plain words:
   - Node older than 18: install Node 18+.
   - No token: tell the user to create an Intercom access token with the 'Read and List articles' and 'Read and Write Articles' scopes (docs/SETUP.md in the plugin repo, step 3) and run `export INTERCOM_API_TOKEN=...` in their shell. Never ask them to paste it in chat or into a file. Setup can continue without it; audit and publish wait.
   - Token rejected in every region: the token is wrong or revoked.
4. **Ask what is not certain** (AskUserQuestion, one at a time, with the evidence in the question; see `${CLAUDE_PLUGIN_ROOT}/skills/intercom-help-center/references/questions.md`). Skip any question whose answer is already in `.help-center/config.json` or is unambiguous:
   - the features source (a coverage manifest, a features JSON, a routes folder, or "create a manifest");
   - the strings files (the English ones first; "none, the text is in the components" is a valid answer);
   - the Intercom workspace, if a token is present;
   - the PR base, when `prBase.base` is null or `prBase.conflict` is true;
   - the articles folder, only if the default `help-articles/articles` would be wrong (for example a docs-site folder).
5. **Save**: `node S/doctor.mjs --write --strings <a,b> --features <path> --base <branch> [--articles-dir <dir>] [--region <r>]`. Add `--scaffold-manifest` if the user chose "create a manifest", then open the scaffolded file with them and fill `shipped()` if it still returns `[]`.
6. **Confirm**: run `node S/doctor.mjs` again and show the final state. Suggest the next step: `/intercom-help-center:audit` (needs the token), and the CI templates in `${CLAUDE_PLUGIN_ROOT}/templates/github/`.

`.help-center/config.json` is meant to be committed: it holds no secrets, and saving refuses anything token-shaped. `.help-center/.gitignore` keeps the snapshot and session files out of git. Re-running setup changes only what the user passes or what was undecided.
