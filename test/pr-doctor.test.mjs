import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createFakeGit } from "./fake-git.mjs";
import { createFakeIntercom } from "./fake-intercom.mjs";
import { makeWork, cleanup, capture, write, readJson } from "./helpers.mjs";
import { run as pr, decideBase, mergedSignal } from "../scripts/pr.mjs";
import { run as doctor, detectStack, scanRepo } from "../scripts/doctor.mjs";
import { parseRemote, compareUrl, makeGit } from "../scripts/lib/git.mjs";
import { createClient } from "../scripts/lib/intercom.mjs";

async function withRepo(gitOpts, fn, config) {
  const work = makeWork(config);
  const g = createFakeGit({ root: work, ...gitOpts });
  try { return await fn({ work, g, go: (argv) => capture(() => pr(argv, { root: work, git: g, now: Date.parse("2026-09-29T10:00:00Z") })) }); }
  finally { cleanup(work); }
}
const DEV_PRS = [...Array(8)].map((_, i) => ({ baseRefName: "dev", headRefName: `feat/${i}` })).concat([{ baseRefName: "main", headRefName: "dev" }, { baseRefName: "main", headRefName: "hotfix/x" }]);

export const tests = [
  ["pr start: the plugin's own uncommitted files (config, audit, plans) are carried over; only the user's changes stop it", () => withRepo({ dirty: [".help-center/config.json", ".help-center/help-center-plan.md", "help-articles/coverage-manifest.mjs"] }, async ({ g, go }) => {
    let r = await go(["start", "--slug", "x"]);
    assert.equal(r.result, 0, r.out);
    g.state.dirty.push("README.md");
    r = await go(["start", "--slug", "y"]);
    assert.equal(r.result.code, "IHC061");
    assert.match(r.result.message, /README\.md/);
    assert.ok(!/config\.json/.test(r.result.message), "only the user's files are listed");
  }, { pr: { base: "dev" } })],

  ["pr: no remote -> the single local long-lived branch is the base; a local-path remote pushes but opens no PR", async () => {
    await withRepo({ remotes: [], remoteBranches: [], localBranches: ["master"], branch: "master", gh: { installed: false } }, async ({ go }) => {
      const r = await go(["detect-base"]);
      assert.equal(r.result, 0, r.out);
      assert.match(r.out, /base: master/);
    });
    await withRepo({ remotes: [{ name: "origin", url: "../remote.git" }], branch: "help-center/x", dirty: ["help-articles/articles/a.md"], gh: { installed: false } }, async ({ go, g }) => {
      const r = await go(["finish"]);
      assert.equal(r.result, 0, r.out);
      assert.match(r.out, /IHC075/);
      assert.ok(g.state.calls.some((c) => c[1] === "push"));
    }, { pr: { base: "dev" } });
  }],

  ["setup scaffold: Next.js route groups and file routes, Rails resources, and Rails locale keys without the 'en.' root", async () => {
    const { scaffoldManifest } = await import("../scripts/doctor.mjs");
    const { loadStrings } = await import("../scripts/lib/features.mjs");
    const work = makeWork();
    try {
      write(join(work, "n/app/(app)/projects/page.tsx"), "x");
      write(join(work, "n/app/billing/page.tsx"), "x");
      write(join(work, "n/app/[slug]/page.tsx"), "x");
      write(join(work, "n/app/api/route.ts"), "x");
      write(join(work, "n/app/layout.tsx"), "x");
      await scaffoldManifest(join(work, "n"), { manifest: "m.mjs", features: { source: "app", kind: "next-app-routes" }, strings: [] });
      const n = await import(pathToFileURL(join(work, "n/m.mjs")).href);
      assert.deepEqual(n.shipped({ root: join(work, "n") }).sort(), ["billing", "projects"]);
      assert.deepEqual(Object.keys(n.FEATURES).sort(), ["billing", "projects"], "FEATURES pre-filled");
      write(join(work, "p/pages/pricing.tsx"), "x");
      write(join(work, "p/pages/_app.tsx"), "x");
      write(join(work, "p/pages/index.tsx"), "x");
      await scaffoldManifest(join(work, "p"), { manifest: "m.mjs", features: { source: "pages", kind: "next-pages" }, strings: [] });
      assert.deepEqual((await import(pathToFileURL(join(work, "p/m.mjs")).href)).shipped({ root: join(work, "p") }), ["pricing"]);
      write(join(work, "r/config/routes.rb"), "Rails.application.routes.draw do\n  resources :invoices\n  resource :account\nend\n");
      write(join(work, "r/config/locales/en.yml"), "en:\n  invoices:\n    download: \"Download PDF\"\n");
      await scaffoldManifest(join(work, "r"), { manifest: "m.mjs", features: { source: "config/routes.rb", kind: "rails-routes" }, strings: ["config/locales/en.yml"] });
      const r = await import(pathToFileURL(join(work, "r/m.mjs")).href);
      assert.deepEqual(r.shipped({ root: join(work, "r") }), ["invoices", "account"]);
      assert.deepEqual(r.FEATURES.invoices.strings, ["invoices"], "Rails keys match after dropping the locale root");
      assert.deepEqual(loadStrings(join(work, "r"), ["config/locales/en.yml"]).map((e) => e.key), ["invoices.download"]);
    } finally { cleanup(work); }
  }],

  ["pr base: config wins; docs + merged history pick dev; only-main repos use main; conflicts and silence ask", async () => {
    assert.equal(decideBase({ configBase: "trunk" }).base, "trunk");
    const docs = [{ branch: "dev", file: "CONTRIBUTING.md", line: 3, text: "Open PRs against dev" }];
    let d = decideBase({ docs, remoteBranches: ["main", "dev"], defaultBranch: "main" });
    assert.equal(d.base, "dev"); assert.ok(d.confident);
    d = decideBase({ merged: mergedSignal(DEV_PRS), remoteBranches: ["main", "dev"], defaultBranch: "main", defaultProtected: true });
    assert.equal(d.base, "dev", "80%+ of work PRs go to dev; the dev->main release PR is ignored");
    d = decideBase({ remoteBranches: ["main"], defaultBranch: "main" });
    assert.equal(d.base, "main");
    d = decideBase({ remoteBranches: ["main", "dev"], defaultBranch: "main" });
    assert.equal(d.base, null, "never silently picks the production branch when a working branch exists");
    assert.ok(d.conflict);
    d = decideBase({ docs: [{ branch: "main", file: "README.md", line: 1, text: "PRs into main" }], merged: mergedSignal(DEV_PRS), remoteBranches: ["main", "dev"], defaultBranch: "main" });
    assert.equal(d.base, null, "docs say main, history says dev -> ask");
    assert.equal(decideBase({}).base, null);
  }],

  ["pr base: detect-base reads the repo's own docs", () => withRepo({ gh: { installed: false } }, async ({ work, go }) => {
    write(join(work, "CONTRIBUTING.md"), "# Contributing\n\nPlease open pull requests against `dev`, never main.\n");
    const r = await go(["detect-base"]);
    assert.equal(r.result, 0, r.out);
    assert.match(r.out, /base: dev/);
    assert.match(r.out, /CONTRIBUTING\.md:3/);
  })],

  ["pr start: refuses a dirty tree; asks when the base is undecided; creates help-center/<date>-<slug> from origin/<base>", () => withRepo({ dirty: ["src/app.js"] }, async ({ g, go, work }) => {
    let r = await go(["start", "--slug", "Export docs"]);
    assert.equal(r.result.code, "IHC061");
    g.state.dirty = [];
    r = await go(["start", "--slug", "Export docs"]);
    assert.equal(r.result, 3, "undecided base -> exit 3 (ask)");
    assert.match(r.out, /IHC062/);
    r = await go(["set-base", "dev"]);
    assert.equal(readJson(join(work, ".help-center/config.json")).pr.base, "dev");
    g.state.localBranches.add("help-center/2026-09-29-export-docs");
    r = await go(["start", "--slug", "Export docs"]);
    assert.equal(r.result, 0, r.out);
    assert.equal(g.state.branch, "help-center/2026-09-29-export-docs-2", "an existing branch is never reused");
    assert.ok(g.state.calls.some((c) => c.join(" ") === "git switch -c help-center/2026-09-29-export-docs-2 origin/dev"));
  })],

  ["pr finish: commits only help-center paths, prints head → base and files, opens a draft PR with gh", () => withRepo({ branch: "help-center/2026-09-29-x", dirty: ["help-articles/articles/a.md", ".help-center/help-center-plan.md", ".help-center/snapshot.json", "src/app.js"] }, async ({ g, go }) => {
    const r = await go(["finish", "--title", "Update export articles"]);
    assert.equal(r.result, 0, r.out);
    assert.deepEqual(g.state.committed, ["help-articles/articles/a.md", ".help-center/help-center-plan.md"]);
    assert.match(r.out, /not included .*src\/app\.js/);
    assert.match(r.out, /help-center\/2026-09-29-x → dev/);
    const create = g.state.calls.find((c) => c[1] === "pr" && c[2] === "create");
    assert.ok(create.includes("--draft"));
    assert.equal(create[create.indexOf("--base") + 1], "dev");
    assert.ok(!g.state.calls.some((c) => c.includes("--force")), "never force-pushes");
  }, { pr: { base: "dev" } })],

  ["pr finish: refuses on a non-help-center branch, head == base, missing base, and a head behind base", () => withRepo({ branch: "feature/mine", dirty: ["help-articles/articles/a.md"] }, async ({ g, go }) => {
    let r = await go(["finish"]);
    assert.equal(r.result.code, "IHC066");
    g.state.branch = "help-center/x";
    r = await go(["finish", "--base", "help-center/x"]);
    assert.equal(r.result.code, "IHC064");
    g.state.remoteBranches = ["main"];
    r = await go(["finish"]);
    assert.equal(r.result.code, "IHC063");
    g.state.remoteBranches = ["main", "dev"];
    g.state.behind = 2;
    r = await go(["finish"]);
    assert.equal(r.result.code, "IHC065");
  }, { pr: { base: "dev" } })],

  ["pr finish: no gh -> compare URL; GitLab -> merge-request URL; no remote -> stays local", async () => {
    await withRepo({ branch: "help-center/x", dirty: ["help-articles/articles/a.md"], gh: { installed: false } }, async ({ go }) => {
      const r = await go(["finish"]);
      assert.match(r.out, /IHC069/);
      assert.match(r.out, /https:\/\/github\.com\/acme\/app\/compare\/dev\.\.\.help-center\/x\?expand=1/);
    }, { pr: { base: "dev" } });
    await withRepo({ branch: "help-center/x", dirty: ["help-articles/articles/a.md"], remotes: [{ name: "origin", url: "https://gitlab.com/acme/app.git" }] }, async ({ go, g }) => {
      const r = await go(["finish"]);
      assert.match(r.out, /IHC070/);
      assert.match(r.out, /merge_requests\/new/);
      assert.ok(!g.state.calls.some((c) => c[0] === "gh" && c[1] === "pr"));
    }, { pr: { base: "dev" } });
    await withRepo({ branch: "help-center/x", dirty: ["help-articles/articles/a.md"], remotes: [] }, async ({ go, g }) => {
      const r = await go(["finish"]);
      assert.equal(r.result, 0);
      assert.match(r.out, /IHC068/);
      assert.ok(!g.state.calls.some((c) => c[1] === "push"));
    }, { pr: { base: "dev" } });
  }],

  ["pr finish: gh logged in as another account without push rights -> fork required, then cross-repo PR", () => withRepo({
    branch: "help-center/x", dirty: ["help-articles/articles/a.md"],
    gh: { installed: true, account: "contrib", repo: { nameWithOwner: "acme/app", defaultBranchRef: { name: "main" }, viewerPermission: "READ" } },
  }, async ({ g, go }) => {
    let r = await go(["finish"]);
    assert.equal(r.result.code, "IHC071");
    assert.match(r.out, /IHC074/);
    g.state.remotes.push({ name: "fork", url: "git@github.com:contrib/app.git", ...parseRemote("git@github.com:contrib/app.git") });
    g.state.dirty = ["help-articles/articles/a.md"];
    r = await go(["finish"]);
    assert.equal(r.result, 0, r.out);
    assert.ok(g.state.calls.some((c) => c.join(" ") === "git push -u fork help-center/x"));
    const create = g.state.calls.find((c) => c[1] === "pr" && c[2] === "create");
    assert.equal(create[create.indexOf("--head") + 1], "contrib:help-center/x");
  }, { pr: { base: "dev" } })],

  ["git: remotes parse for ssh/https/GitLab/Bitbucket; the wrapper refuses --force, reset and stash", async () => {
    assert.deepEqual(pick(parseRemote("git@github.com:acme/app.git")), ["github.com", "acme", "app", "github"]);
    assert.deepEqual(pick(parseRemote("https://github.com/acme/app")), ["github.com", "acme", "app", "github"]);
    assert.deepEqual(pick(parseRemote("https://gitlab.com/group/sub/app.git")), ["gitlab.com", "group/sub", "app", "gitlab"]);
    assert.deepEqual(pick(parseRemote("git@bitbucket.org:team/app.git")), ["bitbucket.org", "team", "app", "bitbucket"]);
    assert.match(compareUrl(parseRemote("git@bitbucket.org:team/app.git"), "dev", "help-center/x"), /pull-requests\/new\?source=help-center%2Fx&dest=dev/);
    const calls = [];
    const g = makeGit((cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: " M help-articles/a.md\n?? help-articles/new file.md", stderr: "" }; }, "/x");
    assert.throws(() => g.git("push", "--force", "origin", "x"), /force/);
    assert.throws(() => g.git("stash"), /stash/);
    assert.throws(() => g.git("reset", "--hard"), /reset/);
    assert.deepEqual(g.dirtyFiles(), ["help-articles/a.md", "help-articles/new file.md"], "porcelain parsed with leading space kept");
  }],

  ["doctor: detects i18n JSON (Next.js), Rails YAML, and no-i18n repos; routes and monorepos", async () => {
    const work = makeWork();
    try {
      write(join(work, "next/app/billing/page.tsx"), "export default () => null");
      write(join(work, "next/app/settings/page.tsx"), "export default () => null");
      write(join(work, "next/messages/en.json"), '{"a":"b"}');
      write(join(work, "next/messages/fr.json"), '{"a":"b"}');
      let s = detectStack(join(work, "next"), scanRepo(join(work, "next")));
      assert.equal(s.strings[0].path, "messages/en.json");
      assert.ok(s.features.some((f) => f.kind === "next-app-routes" && f.count === 2));
      write(join(work, "rails/config/locales/en.yml"), "en:\n  export:\n    button: \"Download CSV\"\n");
      write(join(work, "rails/config/routes.rb"), "Rails.application.routes.draw do\n  resources :orders\nend\n");
      s = detectStack(join(work, "rails"), scanRepo(join(work, "rails")));
      assert.equal(s.strings[0].format, "rails-yaml");
      assert.ok(s.features.some((f) => f.kind === "rails-routes"));
      write(join(work, "plain/src/App.jsx"), "export const App = () => <button>Save</button>");
      s = detectStack(join(work, "plain"), scanRepo(join(work, "plain")));
      assert.ok(s.noI18n && s.componentFiles === 1);
      write(join(work, "mono/package.json"), '{"workspaces":["packages/*"]}');
      write(join(work, "mono/packages/web/package.json"), "{}");
      write(join(work, "mono/packages/api/package.json"), "{}");
      s = detectStack(join(work, "mono"), scanRepo(join(work, "mono")));
      assert.deepEqual(s.monorepo.packages.sort(), ["packages/api", "packages/web"]);
    } finally { cleanup(work); }
  }],

  ["doctor: finds the token's region without printing it, writes config (no secrets), is idempotent, scaffolds a manifest", async () => {
    const work = makeWork();
    const fake = createFakeIntercom({ region: "eu" }).install();
    const token = "dG9rOnNlY3JldC10b2tlbi1mb3ItdGVzdHMtb25seQ==";
    process.env.INTERCOM_API_TOKEN = token;
    const g = createFakeGit({ root: work, gh: { installed: true, account: "acme-dev", repo: { viewerPermission: "ADMIN", defaultBranchRef: { name: "main" } }, merged: DEV_PRS } });
    const deps = { root: work, git: g, makeClient: (region) => createClient({ token, region, allowWrites: false, maxRetries: 0 }) };
    try {
      let r = await capture(() => doctor([], deps));
      assert.equal(r.result, 0, r.out);
      assert.match(r.out, /workspace "Acme Help" \(ws1\) · region eu/);
      assert.ok(!r.out.includes(token), "token never printed");
      assert.ok(!existsSync(join(work, ".help-center/config.json")), "report-only run writes nothing");
      r = await capture(() => doctor(["--write", "--yes", "--strings", "src/en.json", "--base", "dev"], deps));
      assert.equal(r.result, 0, r.out);
      const c = readJson(join(work, ".help-center/config.json"));
      assert.equal(c.intercom.region, "eu");
      assert.equal(c.intercom.workspace, "ws1");
      assert.equal(c.intercom.authorId, "777");
      assert.equal(c.pr.base, "dev");
      assert.deepEqual(c.strings, ["src/en.json"]);
      assert.ok(!readFileSync(join(work, ".help-center/config.json"), "utf8").includes(token));
      assert.ok(existsSync(join(work, ".help-center/.gitignore")));
      r = await capture(() => doctor(["--write"], deps));
      const c2 = readJson(join(work, ".help-center/config.json"));
      assert.equal(c2.pr.base, "dev", "re-running keeps earlier answers");
      assert.deepEqual(c2.strings, ["src/en.json"]);
      r = await capture(() => doctor(["--scaffold-manifest", "--manifest", "docs/help/coverage-manifest.mjs", "--features", "src/features.json", "--write"], deps));
      const m = readFileSync(join(work, "docs/help/coverage-manifest.mjs"), "utf8");
      assert.match(m, /src\/features\.json/);
      const mod = await import(pathToFileURL(join(work, "docs/help/coverage-manifest.mjs")).href);
      assert.deepEqual(mod.shipped({ root: work }), ["csv-export", "order-tags"], "scaffolded shipped() reads the features file");
    } finally { fake.uninstall(); cleanup(work); }
  }],
];

const pick = (r) => [r.host, r.owner, r.repo, r.kind];
