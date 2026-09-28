#!/usr/bin/env node
/**
 * doctor.mjs: detect everything setup needs, report what works and what does not, and (with
 * --write) save the answers to .help-center/config.json. Idempotent: re-running shows the
 * current state and changes only what you pass or what was undecided.
 *
 * It detects:
 *   - Node version
 *   - the repo: git root, current branch, dirty tree, remote host and owner/repo, monorepo tool
 *   - the stack: where UI strings live (i18n JSON, Rails YAML, gettext .po, Apple .strings,
 *     Android XML, or none = plain text in components) and where features/routes are declared
 *   - GitHub access: gh installed? logged in as? can that account push? else plain git remote
 *   - the PR base branch, with evidence (see pr.mjs)
 *   - Intercom: token present? GET /me in the configured region, else tries us/eu/au to find
 *     the token's region; workspace name and id; read access to articles. It NEVER prints the
 *     token. Write access cannot be tested without writing; the first real publish reports it.
 *
 * USAGE
 *   node doctor.mjs                         # report only, changes nothing
 *   node doctor.mjs --json                  # the same, machine-readable (the setup skill uses this)
 *   node doctor.mjs --write [--yes]         # save detected values; --yes accepts confident ones
 *   node doctor.mjs --write --strings src/locales/en.json --features src/features.json --base dev
 *   node doctor.mjs --scaffold-manifest     # write help-articles/coverage-manifest.mjs if missing
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs, main, env, toPosix } from "./lib/cli.mjs";
import { loadConfig, saveConfig, CONFIG_PATH } from "./lib/config.mjs";
import { createClient, REGIONS } from "./lib/intercom.mjs";
import { makeGit } from "./lib/git.mjs";
import { collectSignals, decideBase } from "./pr.mjs";
import { walkArticles } from "./lib/articles.mjs";
import { loadStrings } from "./lib/features.mjs";
import { pathToFileURL } from "node:url";
import { report } from "./lib/messages.mjs";

const SPEC = {
  flags: ["--json", "--write", "--yes", "--scaffold-manifest", "--no-network"],
  options: ["--strings", "--features", "--articles-dir", "--base", "--region", "--author-id", "--cap", "--manifest"],
  multi: ["--add-strings"],
};

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", "out", "coverage", "vendor", "target", ".venv", "venv", "__pycache__", ".turbo", ".cache", "tmp", ".help-center"]);

export function scanRepo(root, limit = 40000) {
  const files = [];
  const walk = (dir) => {
    if (files.length >= limit) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= limit) return;
      if (e.name.startsWith(".") && ![".github"].includes(e.name)) continue;
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(toPosix(relative(root, p)));
    }
  };
  walk(root);
  return files;
}

const LOCALE_DIR = /(^|\/)(locales?|i18n|lang|langs|translations|messages|intl)(\/|$)/i;
const EN = /(^|[\/._-])(en|en-us|en_us|en-gb)([\/._-]|$)|(^|\/)base\.lproj\/|(^|\/)values\/strings\.xml$/i;

export function detectStack(root, files) {
  const strings = [];
  for (const f of files) {
    let format = null;
    if (/\.json$/i.test(f) && (LOCALE_DIR.test(f) || /(^|\/)(en|en-US|en_US)\.json$/i.test(f)) && !/package(-lock)?\.json$|tsconfig|\.config\./i.test(f)) format = "i18n-json";
    else if (/(^|\/)config\/locales\/.+\.ya?ml$/i.test(f) || (LOCALE_DIR.test(f) && /\.ya?ml$/i.test(f))) format = "rails-yaml";
    else if (/\.po$/i.test(f)) format = "gettext-po";
    else if (/\.strings$/i.test(f)) format = "apple-strings";
    else if (/(^|\/)res\/values\/strings\.xml$/i.test(f)) format = "android-xml";
    if (format) strings.push({ path: f, format, english: EN.test(f) });
  }
  strings.sort((a, b) => Number(b.english) - Number(a.english) || a.path.length - b.path.length);

  const features = [];
  const has = (re) => files.filter((f) => re.test(f));
  const manifest = has(/(^|\/)coverage-manifest\.mjs$/);
  if (manifest.length) features.push({ kind: "manifest", path: manifest[0], count: null });
  for (const f of has(/(^|\/)(features|feature-flags|feature_flags|flags)\.json$/i)) features.push({ kind: "features-json", path: f, count: null });
  const routeKinds = [
    ["next-app-routes", /(^|\/)app\/(.+\/)?page\.(t|j)sx?$/, (f) => f.replace(/\/page\.[tj]sx?$/, "").replace(/^(.*\/)?app\/?/, "")],
    ["next-pages", /(^|\/)pages\/(?!api\/|_).+\.(t|j)sx?$/, (f) => f.replace(/^(.*\/)?pages\//, "").replace(/\.[tj]sx?$/, "")],
    ["remix-routes", /(^|\/)app\/routes\/.+\.(t|j)sx?$/, (f) => f.replace(/^(.*\/)?app\/routes\//, "").replace(/\.[tj]sx?$/, "")],
    ["sveltekit-routes", /(^|\/)src\/routes\/(.+\/)?\+page\.svelte$/, (f) => f.replace(/\/\+page\.svelte$/, "").replace(/^(.*\/)?src\/routes\/?/, "")],
    ["rails-routes", /(^|\/)config\/routes\.rb$/, null],
    ["laravel-routes", /(^|\/)routes\/web\.php$/, null],
    ["django-urls", /(^|\/)urls\.py$/, null],
  ];
  for (const [kind, re] of routeKinds) {
    const hits = has(re);
    if (!hits.length) continue;
    const dir = kind === "rails-routes" || kind === "laravel-routes" || kind === "django-urls" ? hits[0] : commonDir(hits);
    features.push({ kind, path: dir, count: hits.length });
  }
  const changelog = has(/^CHANGELOG\.md$/i);
  if (changelog.length) features.push({ kind: "changelog", path: changelog[0], count: null });

  const componentFiles = has(/\.(jsx|tsx|vue|svelte|erb|html)$/i).length;
  const monorepo = detectMonorepo(root, files);
  return { strings, features, noI18n: !strings.length, componentFiles, monorepo };
}

function commonDir(paths) {
  const parts = paths.map((p) => p.split("/"));
  const out = [];
  for (let i = 0; ; i++) {
    const seg = parts[0][i];
    if (seg === undefined || !parts.every((p) => p[i] === seg) || i >= parts[0].length - 1) break;
    out.push(seg);
  }
  return out.join("/") || ".";
}

function detectMonorepo(root, files) {
  const pkg = existsSync(join(root, "package.json")) ? safeJson(join(root, "package.json")) : null;
  let tool = null;
  if (pkg?.workspaces) tool = "npm/yarn workspaces";
  if (files.includes("pnpm-workspace.yaml")) tool = "pnpm workspaces";
  if (files.includes("turbo.json")) tool = (tool ? tool + " + " : "") + "turborepo";
  if (files.includes("nx.json")) tool = (tool ? tool + " + " : "") + "nx";
  if (files.includes("lerna.json")) tool = (tool ? tool + " + " : "") + "lerna";
  const packages = files.filter((f) => /^(packages|apps|services)\/[^/]+\/package\.json$/.test(f)).map((f) => f.replace(/\/package\.json$/, ""));
  return tool || packages.length > 1 ? { tool: tool ?? "folders", packages } : null;
}
const safeJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

export async function checkIntercom({ token, preferred, makeClient }) {
  if (!token) return { token: false };
  const order = [...new Set([preferred, "us", "eu", "au"].filter(Boolean))];
  for (const region of order) {
    const c = makeClient(region);
    try {
      const me = await c.get("/me");
      let read = false, sample = null, readError = null;
      try { const r = await c.get("/articles?per_page=1&page=1"); read = true; sample = r.total_count ?? r.pages?.total_pages ?? (r.data ?? []).length; }
      catch (e) { readError = e.status ?? e.message; }
      return {
        token: true, ok: true, region, regionMismatch: region !== preferred,
        admin: { id: me.id ?? null, name: me.name ?? null },
        workspace: { id: me.app?.id_code ?? null, name: me.app?.name ?? null },
        read, readError, articlesHint: sample, write: "unknown until the first real publish (a 403 then means no write access)",
      };
    } catch (e) {
      if (e.status !== 401) return { token: true, ok: false, region, error: e.status ? `HTTP ${e.status}` : e.message };
    }
  }
  return { token: true, ok: false, error: "rejected (401) in every region: the token is wrong or revoked" };
}

export async function diagnose({ root, config, g, makeClient, network = true }) {
  const out = { node: process.versions.node, nodeOk: Number(process.versions.node.split(".")[0]) >= 18 };
  const isRepo = g.isRepo();
  const gitRoot = isRepo ? g.root() : null;
  const remotes = isRepo ? g.remotes() : [];
  const origin = remotes.find((r) => r.name === (config.pr.remote ?? "origin")) ?? remotes[0] ?? null;
  out.repo = {
    git: isRepo,
    root: gitRoot ? toPosix(gitRoot) : toPosix(root),
    configRoot: toPosix(root),
    branch: isRepo ? g.currentBranch() : null,
    dirty: isRepo ? g.dirtyFiles().length : null,
    remote: origin ? { name: origin.name, url: origin.url, host: origin.host, owner: origin.owner, repo: origin.repo, kind: origin.kind, protocol: origin.protocol } : null,
  };
  const files = scanRepo(root);
  out.stack = detectStack(root, files);
  out.articles = { dir: config.articlesDir, exists: existsSync(resolve(root, config.articlesDir)), count: walkArticles(resolve(root, config.articlesDir)).length };

  // GitHub
  const gh = { installed: false, account: null, canPush: null, permission: null };
  if (isRepo) {
    gh.installed = g.ghAvailable();
    if (gh.installed) gh.account = g.ghAccount();
    if (gh.installed && gh.account && origin?.kind === "github") {
      const info = g.ghRepo(`${origin.owner}/${origin.repo}`);
      gh.permission = info?.viewerPermission ?? null;
      gh.canPush = gh.permission ? ["WRITE", "MAINTAIN", "ADMIN"].includes(gh.permission) : null;
    }
  }
  out.github = gh;
  out.github.summary = !isRepo ? "no git: audit, write and publish work; the PR step does not"
    : !origin ? "git with no remote: branches stay local; no push, no PR"
    : origin.kind === "local" ? "a local-path remote: branches are pushed there; no PR (no web host)"
    : origin.kind !== "github" ? `${origin.kind} remote: branches are pushed and a compare/merge-request URL is printed; no automatic PR`
    : !gh.installed ? "GitHub remote, no gh: branches are pushed and a compare URL is printed; install gh for automatic PRs"
    : !gh.account ? "gh is installed but not logged in: run `gh auth login` for automatic PRs"
    : gh.canPush === false ? `gh is logged in as ${gh.account}, who cannot push to ${origin.owner}/${origin.repo}: PRs go through your fork`
    : `gh is logged in as ${gh.account}: branches are pushed and PRs are opened automatically`;

  // PR base
  if (isRepo) {
    const s = collectSignals({ g, root: gitRoot ?? root, config, remote: config.pr.remote ?? "origin" });
    out.prBase = decideBase(s);
  } else out.prBase = { base: null, confident: false, evidence: ["no git"] };

  // Intercom
  const token = env("INTERCOM_API_TOKEN");
  out.intercom = network ? await checkIntercom({ token, preferred: env("INTERCOM_REGION", config.intercom.region), makeClient }) : { token: Boolean(token), skipped: true };
  return out;
}

export async function scaffoldManifest(root, config, detected) {
  const path = resolve(root, config.manifest);
  if (existsSync(path)) return null;
  const src = config.features?.source ?? detected?.path ?? null;
  const kind = config.features?.kind ?? detected?.kind ?? null;
  const strings = JSON.stringify(config.strings ?? []);
  let shipped = "  // TODO: return your shipped feature ids, read from the repo so a new feature cannot slip past.\n  return [];";
  if (kind === "features-json" && src) shipped = `  const j = JSON.parse(readFileSync(join(root, ${JSON.stringify(src)}), "utf8"));\n  const list = Array.isArray(j) ? j : j.shipped ?? j.features ?? [];\n  return list.map((f) => (typeof f === "string" ? f : f.id));`;
  else if (kind === "rails-routes" && src) shipped = `  const text = readFileSync(join(root, ${JSON.stringify(src)}), "utf8");\n  return [...new Set([...text.matchAll(/^\\s*resources?\\s+:(\\w+)/gm)].map((m) => m[1]))];`;
  else if (kind === "laravel-routes" && src) shipped = `  const text = readFileSync(join(root, ${JSON.stringify(src)}), "utf8");\n  return [...new Set([...text.matchAll(/Route::\\w+\\(\\s*['"]\\/?([a-z][\\w-]*)/g)].map((m) => m[1]))];`;
  else if (kind === "django-urls" && src) shipped = `  const text = readFileSync(join(root, ${JSON.stringify(src)}), "utf8");\n  return [...new Set([...text.matchAll(/path\\(\\s*['"]([a-z][\\w-]*)/g)].map((m) => m[1]))];`;
  else if (kind && /routes|pages/.test(kind) && src) shipped = [
    `  // One feature per top-level route under ${src} (a folder, or a file for file-based routers).`,
    "  // Route groups like (app) are looked inside, not counted; dynamic segments ([id], $id),",
    "  // private entries (_x), index, layouts and api/ are skipped.",
    "  const ids = new Set();",
    "  const SKIP = /^([[_.@$+]|api$|index$|layout$|page$|route$|root$|error$|not-found$|loading$)/;",
    "  const walk = (d) => {",
    "    for (const e of readdirSync(d, { withFileTypes: true })) {",
    "      if (e.isDirectory() && /^\\(.*\\)$/.test(e.name)) { walk(join(d, e.name)); continue; }",
    "      const id = e.isDirectory() ? e.name : e.name.replace(/\\.[a-z]+$/, \"\").split(\".\")[0];",
    "      if (!SKIP.test(id)) ids.add(id);",
    "    }",
    "  };",
    `  walk(join(root, ${JSON.stringify(src)}));`,
    "  return [...ids];",
  ].join("\n");
  const text = `/**
 * Help-center coverage manifest. Written by doctor.mjs --scaffold-manifest; edit freely.
 *
 * Every shipped feature owes one cell per KIND. A cell is exactly one of:
 *   { article: "<path to .md>" }                          written
 *   { deferred: "<30+ char reason naming a ticket>" }     owed, tracked
 *   { na: "<30+ char reason this kind does not apply>" }  argued, not asserted
 * Optional per feature: label, area (groups features into one collection), keywords,
 * strings (UI string key prefixes), sources (code files).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["what-and-when", "customer-use", "setup", "comparison", "troubleshooting"];
export const TICKET_PATTERN = /[A-Z][A-Z0-9]+-\\d+|#\\d+/;
export const STRINGS = ${strings};

export function shipped({ root }) {
${shipped}
}

`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text}export const FEATURES = {};\n`);
  // Pre-fill FEATURES from what shipped() finds today (label and strings prefix guessed), so the
  // audit can match articles at once. Kinds stay empty: the gate lists each until a human decides.
  let ids = [];
  try { ids = (await import(`${pathToFileURL(path).href}?t=${Date.now()}`)).shipped({ root }) ?? []; } catch { ids = []; }
  const keys = loadStrings(root, config.strings ?? []).map((e) => e.key);
  const rows = ids.map((id) => {
    const label = String(id).replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    const prefix = keys.some((k) => k === id || k.startsWith(`${id}.`)) ? [id] : [];
    return `  ${JSON.stringify(id)}: { label: ${JSON.stringify(label)}, strings: ${JSON.stringify(prefix)}, kinds: {} },`;
  });
  const body = rows.length ? rows.join("\n") : '  // "feature-id": { label: "What users call it", kinds: { ... } },';
  writeFileSync(path, `${text}export const FEATURES = {\n  // Pre-filled from shipped(). Decide every kind of every feature; the gate reports the rest.\n${body}\n};\n`);
  return path;
}

function print(d, log) {
  const ok = (b) => (b ? "✓" : "✗");
  log(`Node ${d.node} ${ok(d.nodeOk)}`);
  log(`\nRepo`);
  if (!d.repo.git) log("  ✗ not a git repository (audit/write/publish still work; no PR step)");
  else {
    log(`  ✓ ${d.repo.root} on branch ${d.repo.branch}${d.repo.dirty ? ` · ${d.repo.dirty} uncommitted change(s)` : " · clean"}`);
    log(d.repo.remote ? `  ✓ remote ${d.repo.remote.name}: ${d.repo.remote.host ? `${d.repo.remote.host}/${d.repo.remote.owner}/${d.repo.remote.repo}` : d.repo.remote.url} (${d.repo.remote.kind}${d.repo.remote.protocol ? `, ${d.repo.remote.protocol}` : ""})` : "  ! no remote");
  }
  if (d.stack.monorepo) log(`  · monorepo (${d.stack.monorepo.tool}): ${d.stack.monorepo.packages.join(", ") || "packages not listed"}`);
  log(`\nUI strings`);
  if (d.stack.strings.length) for (const s of d.stack.strings.slice(0, 8)) log(`  ${s.english ? "→" : "·"} ${s.path} (${s.format})`);
  else log(`  ! none found: text lives in components (${d.stack.componentFiles} files). The writer reads labels from the components directly.`);
  log(`\nFeatures`);
  if (d.stack.features.length) for (const f of d.stack.features) log(`  · ${f.kind}: ${f.path}${f.count ? ` (${f.count} file${f.count === 1 ? "" : "s"})` : ""}`);
  else log("  ! nothing detected: setup will ask you where your feature list lives");
  log(`\nArticles: ${d.articles.dir} ${d.articles.exists ? `(${d.articles.count} files)` : "(not created yet)"}`);
  log(`\nGitHub: ${d.github.summary}`);
  log(`\nPR base: ${d.prBase.base ?? "UNDECIDED"}${d.prBase.conflict ? " (signals conflict: setup will ask)" : ""}`);
  for (const e of d.prBase.evidence ?? []) log(`  · ${e}`);
  log(`\nIntercom`);
  const i = d.intercom;
  if (i.skipped) log("  · network check skipped");
  else if (!i.token) log("  ✗ INTERCOM_API_TOKEN not set (audit and publish need it; see docs/SETUP.md)");
  else if (!i.ok) log(`  ✗ ${i.error}${i.region ? ` (region ${i.region})` : ""}`);
  else {
    log(`  ✓ workspace "${i.workspace.name}" (${i.workspace.id}) · region ${i.region}${i.regionMismatch ? " (not the configured region: setup will save it)" : ""}`);
    log(`  ✓ token admin: ${i.admin.name} (id ${i.admin.id})`);
    log(`  ${i.read ? "✓ can read articles" : `✗ cannot read articles (${i.readError})`}`);
    log(`  · write access: ${i.write}`);
  }
}

export async function run(argv, deps = {}) {
  const a = parseArgs(argv, SPEC);
  if (a.flag("--help")) { console.log("usage: node doctor.mjs [--json] [--write [--yes] [--strings p] [--features p] [--base b] [--region r] [--author-id n] [--cap n]] [--scaffold-manifest]"); return 0; }
  const { config, root, exists } = loadConfig(deps.root);
  const g = deps.git ?? makeGit(undefined, root);
  const token = env("INTERCOM_API_TOKEN");
  const makeClient = deps.makeClient ?? ((region) => createClient({ token, region, version: config.intercom.apiVersion, allowWrites: false, maxRetries: 2 }));
  const d = await diagnose({ root, config, g, makeClient, network: !a.flag("--no-network") });
  d.config = { path: CONFIG_PATH, exists };

  if (a.flag("--write") || a.flag("--scaffold-manifest")) {
    const next = structuredClone(config);
    const yes = a.flag("--yes");
    if (a.opt("--articles-dir")) next.articlesDir = a.opt("--articles-dir");
    if (a.opt("--manifest")) next.manifest = a.opt("--manifest");
    if (a.opt("--strings")) next.strings = a.opt("--strings").split(",").map((s) => s.trim()).filter(Boolean);
    else if (yes && !next.strings.length && d.stack.strings.length) next.strings = d.stack.strings.filter((s) => s.english).slice(0, 3).map((s) => s.path);
    for (const s of a.multi("--add-strings")) if (!next.strings.includes(s)) next.strings.push(s);
    const feat = a.opt("--features");
    if (feat) {
      const hit = d.stack.features.find((f) => f.path === feat);
      next.features = { source: feat, kind: hit?.kind ?? (/\.json$/i.test(feat) ? "features-json" : "custom") };
      if (hit?.kind === "manifest") next.manifest = feat;
    } else if (yes && !next.features.source && d.stack.features.length) {
      const pick = d.stack.features.find((f) => f.kind === "manifest") ?? d.stack.features[0];
      next.features = { source: pick.path, kind: pick.kind };
      if (pick.kind === "manifest") next.manifest = pick.path;
    }
    if (a.opt("--base")) { next.pr.base = a.opt("--base"); next.pr.baseEvidence = [`confirmed by the user at setup`, ...(d.prBase.evidence ?? [])]; }
    else if (!next.pr.base && d.prBase.base && d.prBase.confident && yes) { next.pr.base = d.prBase.base; next.pr.baseEvidence = d.prBase.evidence; }
    if (a.opt("--region")) next.intercom.region = a.opt("--region");
    else if (d.intercom.ok) next.intercom.region = d.intercom.region;
    if (d.intercom.ok) { next.intercom.workspace = d.intercom.workspace.id; next.intercom.workspaceName = d.intercom.workspace.name; if (!next.intercom.authorId && d.intercom.admin.id) next.intercom.authorId = String(d.intercom.admin.id); }
    if (a.opt("--author-id")) next.intercom.authorId = a.opt("--author-id");
    if (a.opt("--cap")) next.publish.cap = Number(a.opt("--cap"));
    if (a.flag("--write")) { const p = saveConfig(root, next); d.config = { path: toPosix(relative(root, p)), exists: true, written: true }; }
    if (a.flag("--scaffold-manifest")) {
      const detected = d.stack.features.find((f) => f.kind !== "manifest" && f.kind !== "changelog");
      const p = await scaffoldManifest(root, next, detected);
      d.manifestScaffolded = p ? toPosix(relative(root, p)) : null;
    }
    d.saved = next;
  }

  if (a.flag("--json")) console.log(JSON.stringify(d, null, 2));
  else {
    print(d, (s) => console.log(s));
    if (d.config.written) console.log(`\nSaved ${d.config.path}. Re-run any time; it only changes what you pass.`);
    else console.log(`\nConfig: ${exists ? "found" : "not written yet"} (${CONFIG_PATH}). Run with --write to save.`);
    if (d.manifestScaffolded) console.log(`Scaffolded ${d.manifestScaffolded}.`);
  }
  if (d.intercom.token && d.intercom.ok === false && /401/.test(d.intercom.error ?? "")) report("IHC002", { region: "us, eu and au" });
  return d.nodeOk ? 0 : 1;
}

main(import.meta.url, run);
