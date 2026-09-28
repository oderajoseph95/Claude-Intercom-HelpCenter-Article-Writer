/**
 * messages.mjs: every error and warning a script or hook can print, in one catalog.
 *
 * Each has a stable code, the text the user sees, the cause and the fix. docs/TROUBLESHOOTING.md
 * is generated from this file (`node scripts/gen-docs.mjs`), and the selftest fails if the two
 * drift or if a script prints an error that is not in the catalog. So every message a user can
 * see has a documented cause and fix.
 */

export const MESSAGES = {
  // ── Intercom access ──
  IHC001: { level: "error", text: "INTERCOM_API_TOKEN is not set.", cause: "The script needs to talk to Intercom and no token is in the environment.", fix: "`export INTERCOM_API_TOKEN=...` in this shell only (never put it in a file you commit). See docs/SETUP.md, step 3." },
  IHC002: { level: "error", text: "Intercom rejected the token (401) for region {region}.", cause: "The token is wrong, revoked, or belongs to a workspace in another data region.", fix: "Run `/intercom-help-center:setup` (or `node scripts/doctor.mjs`): it tries US, EU and AU and tells you which region the token belongs to. Set INTERCOM_REGION or `intercom.region` in config." },
  IHC003: { level: "error", text: "The token cannot read {what} (403).", cause: "The Intercom app behind the token lacks the read permission.", fix: "In Intercom's Developer Hub, open your app > Authentication and enable the 'Read and List articles' scope, then use the refreshed access token. See docs/SETUP.md, step 3." },
  IHC004: { level: "error", text: "The token cannot write {what} (403).", cause: "The token has read access only. Setup cannot test write access without writing, so this shows up on the first real publish.", fix: "Enable the 'Read and Write Articles' scope on the Intercom app (Developer Hub > your app > Authentication) and re-run. Nothing was changed by the refused call." },
  IHC005: { level: "error", text: "Still rate limited by Intercom after {retries} retries.", cause: "A very large Help Center, or another integration using the same token at the same time.", fix: "Wait a minute and re-run the same command. Reads are cached in the snapshot and publishing is resumable." },
  IHC006: { level: "error", text: "{method} {path} failed mid-write: {detail}", cause: "The network or Intercom failed while a write was in flight, so it may or may not have landed.", fix: "Re-run the same command. The publisher re-reads Intercom first and adopts an article it already created instead of creating a second copy." },
  IHC007: { level: "error", text: "INTERCOM_REGION \"{region}\" is not one of us, eu, au.", cause: "Typo in the region.", fix: "Use `us` (api.intercom.io), `eu` (api.eu.intercom.io) or `au` (api.au.intercom.io)." },
  IHC008: { level: "error", text: "Intercom API error: {detail}", cause: "An unexpected response from Intercom.", fix: "Re-run once. If it repeats, open an issue with the command and the status code (never the token)." },

  // ── config and manifest ──
  IHC010: { level: "error", text: "Config file {path} is not valid JSON: {detail}", cause: "A hand edit broke the JSON.", fix: "Fix the JSON, or delete the file and re-run setup; setup is idempotent and re-detects everything." },
  IHC011: { level: "error", text: "Refusing to write {path}: it contains something that looks like an Intercom token.", cause: "A token was pasted into a config value.", fix: "Remove it. The token belongs only in the INTERCOM_API_TOKEN environment variable (or a CI secret)." },
  IHC020: { level: "error", text: "Coverage manifest not found: {path}", cause: "No manifest means zero tracked coverage.", fix: "Run `/intercom-help-center:setup` to scaffold one, or copy examples/help-articles/coverage-manifest.mjs." },
  IHC021: { level: "error", text: "shipped() returned 0 features; refusing to pass vacuously.", cause: "Feature discovery is broken (moved folder, renamed file).", fix: "Fix `shipped()` in the manifest so it reads your real feature list." },
  IHC022: { level: "error", text: "Could not load the manifest {path}: {detail}", cause: "A syntax error in the manifest, or it imports something missing.", fix: "Run `node {path}` to see the error, fix it, re-run." },
  IHC023: { level: "warn", text: "No feature source configured: feature coverage was not checked.", cause: "Neither a coverage manifest nor `features.source` exists yet.", fix: "Run `/intercom-help-center:setup` and confirm a features source." },
  IHC024: { level: "warn", text: "Strings file {path} could not be read: {detail}", cause: "The file moved or is not in a supported format (JSON, YAML, .po, .strings, Android XML).", fix: "Update `strings` in .help-center/config.json." },

  // ── publishing ──
  IHC030: { level: "error", text: "Refusing: {count} writes planned, above the cap of {cap}.", cause: "The run would change more articles or collections than the publish cap allows.", fix: "Publish in smaller batches (pass file paths), or raise the cap deliberately with --max N." },
  IHC031: { level: "error", text: "Refusing: no approved plan at {path}.", cause: "Real writes need a plan a human has approved (`\"approved\": true` plus `approved_by`).", fix: "Run `/intercom-help-center:plan`, review it, then approve it (the command asks you)." },
  IHC032: { level: "error", text: "Collection \"{name}\" not found on Intercom.", cause: "A name mismatch, a renamed collection, or a collection that does not exist yet.", fix: "`node scripts/publish.mjs --list-collections` shows exact names. Pass --create-collections with --publish to create it." },
  IHC033: { level: "error", text: "Section \"{name}\" not found under \"{parent}\".", cause: "The section does not exist yet, or was renamed.", fix: "Pass --create-sections (or --create-collections) with --publish to create it, or fix the name." },
  IHC034: { level: "error", text: "Article {id} ({file}) no longer exists on Intercom.", cause: "It was deleted in the Intercom UI, but its id is still in the file.", fix: "If it should exist, re-run with --recreate-missing to create it again (new id). If the deletion was right, delete the local file too." },
  IHC035: { level: "error", text: "{file} was published to workspace {theirs}, but this token is for workspace {ours}.", cause: "The file's intercom_id belongs to another Intercom workspace (e.g. staging vs production).", fix: "Use the matching token, or clear intercom_id / intercom_workspace in the file to publish it here as a new article." },
  IHC036: { level: "error", text: "Article {id} ({file}) was edited on Intercom after it was last synced. Not overwriting.", cause: "Someone changed it in the Intercom editor. Publishing would silently erase their edit.", fix: "Read the 3-way diff printed above. Then either `node scripts/pull.mjs --id {id}` to take Intercom's version, or re-run with --overwrite-drift {id} to keep the repo's, or merge by hand." },
  IHC037: { level: "error", text: "No author id: INTERCOM_AUTHOR_ID is unset and GET /me returned none.", cause: "Intercom needs an admin id as the author of a new article.", fix: "Set INTERCOM_AUTHOR_ID or `intercom.authorId` in config to an admin id (setup prints the token's own admin id)." },
  IHC038: { level: "error", text: "{file}: frontmatter is missing {fields}.", cause: "Every article needs at least a title and a collection.", fix: "Start from templates/article.md." },
  IHC039: { level: "error", text: "Plan file not found: {path}", cause: "--plan points at a file that does not exist.", fix: "Run `node scripts/plan-collections.mjs` first." },
  IHC040: { level: "error", text: "Plan file {path} is not valid: {detail}", cause: "A hand edit broke the plan.", fix: "Regenerate it, or fix the JSON." },
  IHC041: { level: "error", text: "{file}: translation_of \"{target}\" is not a published article.", cause: "A translation is attached to its source article's id, and the source has none yet.", fix: "Publish the source-language article first, then the translation." },
  IHC042: { level: "warn", text: "\"{title}\" already exists on Intercom (id {id}); adopting it instead of creating a duplicate.", cause: "An earlier run created it and was interrupted, or someone created it by hand.", fix: "Nothing to do. The id is written back into the file; check the article on Intercom." },
  IHC043: { level: "warn", text: "Collection \"{old}\" was renamed on Intercom to \"{name}\"; using its saved id.", cause: "The collection was renamed in the Intercom UI.", fix: "Update `collection:` in {file} to the new name." },
  IHC044: { level: "warn", text: "{file}: kept raw HTML the converter cannot express. Check it renders on Intercom.", cause: "The article contains an embed, a callout or other HTML with no markdown equivalent.", fix: "Nothing, if it looks right on Intercom. It is passed through untouched, never stripped." },
  IHC045: { level: "error", text: "Refusing to create \"{title}\": {count} articles with this title already exist ({ids}).", cause: "The same title exists in more than one collection, so the publisher cannot tell which one this file is.", fix: "Put the right id in the file's intercom_id (find-existing.mjs lists them), or change the title." },

  IHC046: { level: "error", text: "{file} is not in the ad-hoc plan {plan}; skipped.", cause: "An ad-hoc plan approves exactly the files it lists.", fix: "Publish only the listed files, or create a new ad-hoc plan that includes this one." },

  // ── pre-write check ──
  IHC050: { level: "error", text: "No snapshot of the Help Center at {path}, and no token to fetch one.", cause: "The pre-write check needs to see what is already published.", fix: "Export INTERCOM_API_TOKEN and re-run (it fetches one), or run the audit first." },
  IHC051: { level: "warn", text: "Snapshot is {hours}h old (limit {limit}h). Refreshing.", cause: "Articles may have changed on Intercom since the last audit.", fix: "Nothing; it refreshes automatically when a token is present." },
  IHC052: { level: "warn", text: "Snapshot is {hours}h old and there is no token to refresh it; results may be out of date.", cause: "No INTERCOM_API_TOKEN in this shell.", fix: "Export the token, or run the audit, before trusting a CREATE decision." },

  // ── git and pull requests ──
  IHC060: { level: "error", text: "Not inside a git repository.", cause: "The PR flow needs git.", fix: "Run from your repo, or `git init`. Without git you can still audit, write and publish; only the PR step is unavailable." },
  IHC061: { level: "error", text: "Your working tree has uncommitted changes: {files}", cause: "The help-center branch must contain only help-center changes. Stashing or carrying your work along could lose or leak it.", fix: "Commit or stash your changes yourself, then re-run. The plugin never stashes for you." },
  IHC062: { level: "error", text: "PR base branch is not decided. Candidates: {candidates}.", cause: "Signals conflict (e.g. default branch is main but most PRs go to dev), or nothing was found.", fix: "Answer the question (the skill asks once), or run `node scripts/pr.mjs set-base <branch>`. The answer is saved to .help-center/config.json." },
  IHC063: { level: "error", text: "Base branch \"{base}\" does not exist on {remote}.", cause: "A typo in pr.base, or the branch was deleted.", fix: "`node scripts/pr.mjs detect-base` shows the real branches; fix with `pr.mjs set-base`." },
  IHC064: { level: "error", text: "Head and base are the same branch ({branch}).", cause: "You are trying to open a PR from a branch into itself.", fix: "Run `node scripts/pr.mjs start --slug <topic>` to create a help-center branch first." },
  IHC065: { level: "error", text: "{head} is {behind} commit(s) behind {base}.", cause: "The base moved since the branch was created.", fix: "Update it yourself: `git merge {remote}/{base}` (or rebase). The plugin never force-pushes, so it will not rebase for you." },
  IHC066: { level: "error", text: "Current branch \"{branch}\" is not a help-center branch (prefix {prefix}).", cause: "The plugin only commits on branches it created, so it never touches your other branches.", fix: "Run `node scripts/pr.mjs start --slug <topic>` first." },
  IHC067: { level: "error", text: "Nothing to commit under the help-center paths.", cause: "No article, plan or config file changed.", fix: "Write or fix articles first, or check `articlesDir` in config." },
  IHC068: { level: "warn", text: "No git remote: the branch {branch} stays local.", cause: "The repository has no remote to push to.", fix: "Add one (`git remote add origin <url>`) and run `node scripts/pr.mjs finish` again." },
  IHC069: { level: "warn", text: "GitHub CLI not available ({detail}); pushed the branch. Open the PR here: {url}", cause: "`gh` is not installed or not logged in.", fix: "Open the link, or `gh auth login` and re-run for automatic PRs." },
  IHC070: { level: "warn", text: "{host} is not GitHub; pushed the branch. Open the merge request here: {url}", cause: "GitLab, Bitbucket and others are pushed to but not PR'd automatically.", fix: "Open the link to create the merge/pull request." },
  IHC071: { level: "error", text: "{account} cannot push to {repo} and has no fork of it.", cause: "The logged-in GitHub account has read access only.", fix: "Run `gh repo fork {repo} --remote --remote-name fork`, then `node scripts/pr.mjs finish` again; it pushes to the fork and opens a cross-repo PR." },
  IHC072: { level: "error", text: "git push failed: {detail}", cause: "Credentials, branch protection, or a network error.", fix: "Run the printed git command yourself to see the full error. The plugin never retries with --force." },
  IHC073: { level: "error", text: "gh pr create failed: {detail}", cause: "Permissions, an existing PR for this branch, or a network error.", fix: "The branch is pushed. Open the compare URL printed below, or fix and re-run `pr.mjs finish`." },
  IHC074: { level: "warn", text: "gh is logged in as {account}, not the repo owner {owner}.", cause: "Normal for org repos or forks; only a problem if that account cannot push.", fix: "Nothing, unless a push fails; then `gh auth switch` or use a fork." },

  IHC075: { level: "warn", text: "Pushed {branch} to {url}, a local-path remote; there is no web host to open a pull request on.", cause: "The remote is a folder (a bare repository on disk or a network share), not GitHub or GitLab.", fix: "Review and merge the branch with git directly, or add a hosted remote." },

  // ── hooks ──
  IHC080: { level: "error", text: "Blocked: publishing needs an approved plan ({path}).", cause: "The plugin's publish guard hook refuses `publish.mjs --publish` until a human approves the plan.", fix: "Run `/intercom-help-center:publish`: it shows the plan and asks you to approve it. To turn the guard off, set hooks.publishGuard false in .help-center/config.json." },
  IHC081: { level: "error", text: "Blocked: --max {max} is above the configured publish cap {cap}.", cause: "The publish guard hook stops an agent from raising the cap on its own.", fix: "Raise `publish.cap` in .help-center/config.json yourself if you mean it." },
  IHC082: { level: "error", text: "Blocked: this would write an Intercom token into {file}.", cause: "The secret guard hook stops tokens from landing in files that could be committed.", fix: "Keep the token in the INTERCOM_API_TOKEN environment variable or a CI secret only." },
  IHC083: { level: "warn", text: "{count} help article(s) describe code you just changed and may now be stale: {articles}. Run /intercom-help-center:audit.", cause: "You edited a file listed in those articles' `sources:`.", fix: "Re-check the prose against the code, or run the audit." },

  // ── coverage gate findings (coverage-check.mjs) ──
  IHC100: { level: "gate", text: "shipped feature \"{id}\" has NO manifest entry.", cause: "A feature shipped and nobody decided which articles it owes.", fix: "Add it to FEATURES in the manifest: per kind, an article, a ticketed deferral, or an argued n/a." },
  IHC101: { level: "gate", text: "{where}: no entry. Blank is not a considered n/a.", cause: "A kind has no cell.", fix: "Fill it with { article }, { deferred } or { na }." },
  IHC102: { level: "gate", text: "{where}: set exactly one of article/deferred/na (found {found}).", cause: "A cell is empty or sets more than one.", fix: "Keep exactly one key." },
  IHC103: { level: "gate", text: "{where}: article \"{path}\" does not exist.", cause: "The file was moved, renamed or deleted.", fix: "Fix the path, or restore the article." },
  IHC104: { level: "gate", text: "{where}: {key} reason is under 30 characters: \"{val}\"", cause: "A reason too short to be a reason.", fix: "Say why, in a sentence." },
  IHC105: { level: "gate", text: "{where}: {key} \"{val}\" is a shrug, not a reason.", cause: "\"n/a\", \"none\", \"tbd\" and friends are not decisions.", fix: "Write the actual reason." },
  IHC106: { level: "gate", text: "{where}: deferred reason names no ticket: \"{val}\"", cause: "A promise nobody tracks is how articles never get written.", fix: "Name the ticket (ABC-123 or #123, or set TICKET_PATTERN in the manifest)." },
  IHC107: { level: "gate", text: "{file}: cites source \"{src}\", which does not exist.", cause: "The code the article describes moved or was deleted.", fix: "Update sources:, and re-check the article against the new code." },
  IHC108: { level: "warn", text: "{file}: STALE. \"{src}\" changed {changed}, after the article was last synced {synced}.", cause: "The code changed after the article was last published.", fix: "Re-check the prose against the code, then republish. --strict turns this into a failure." },
  IHC109: { level: "warn", text: "{file}: cites no sources.", cause: "A grounded article names the code files it describes.", fix: "Add sources: to its frontmatter." },
  IHC110: { level: "gate", text: "manifest exports no {what}.", cause: "The manifest is missing KINDS or FEATURES.", fix: "Start from examples/help-articles/coverage-manifest.mjs." },
  IHC111: { level: "gate", text: "shipped() must return an array of feature ids.", cause: "shipped() returned something else.", fix: "Return an array of strings." },

  // ── environment ──
  IHC090: { level: "error", text: "Node {version} is too old; Node 18 or newer is required.", cause: "The scripts use the built-in fetch.", fix: "Install Node 18+ (22 LTS recommended)." },
  IHC091: { level: "error", text: "Unknown option {option}.", cause: "A typo, or an option from a different script.", fix: "Run the script with --help." },
};

const render = (t, vars = {}) => t.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));

export function msg(code, vars) {
  const m = MESSAGES[code];
  if (!m) return `${code} ${JSON.stringify(vars)}`;
  return `${code} ${render(m.text, vars)}`;
}

export class HelpCenterError extends Error {
  constructor(code, vars = {}) {
    super(msg(code, vars));
    this.code = code;
    this.vars = vars;
  }
}

/** Build (not throw) a catalogued error; callers `throw fail(...)`. */
export const fail = (code, vars) => new HelpCenterError(code, vars);

/** Print a catalogued message to stderr with its fix. */
export function report(code, vars, { withFix = true } = {}) {
  const m = MESSAGES[code];
  const icon = m?.level === "warn" ? "!" : "✗";
  console.error(`${icon} ${msg(code, vars)}`);
  if (withFix && m?.fix) console.error(`  fix: ${render(m.fix, vars)}`);
}

/** Print any error: catalogued ones with their fix, API errors translated, others as-is. */
export function reportError(e) {
  if (e instanceof HelpCenterError) return report(e.code, e.vars);
  if (e?.status || e?.maybeApplied !== undefined) {
    const code = apiCode(e);
    return report(code, apiVars(e));
  }
  report("IHC008", { detail: e?.message ?? String(e) });
}

export function apiCode(e) {
  if (!e) return "IHC008";
  if (/INTERCOM_API_TOKEN is not set/.test(e.message)) return "IHC001";
  if (e.status === 401) return "IHC002";
  if (e.status === 403) return e.method === "GET" ? "IHC003" : "IHC004";
  if (e.status === 429) return "IHC005";
  if (e.maybeApplied) return "IHC006";
  return "IHC008";
}
export const apiVars = (e) => ({
  region: e?.region || process.env.INTERCOM_REGION || "us",
  what: e?.path ?? "",
  retries: 6,
  method: e?.method,
  path: e?.path,
  detail: e?.message,
});
