import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { makeWork, cleanup, capture, write, writeJson, approvedPlan, REPO } from "./helpers.mjs";
import { decide } from "../hooks/guard.mjs";
import { onPost, onStop } from "../hooks/stale.mjs";
import { run as coverage } from "../scripts/coverage-check.mjs";
import { MESSAGES } from "../scripts/lib/messages.mjs";
import { renderTroubleshooting } from "../scripts/gen-docs.mjs";

// Names from the private project this tool was first built in. None may appear in the public repo.
const PRIVATE = new RegExp(["ta" + "cey", "TC" + "Y-[0-9]", "arb" + "-dev", "VUL" + "CAN", "RO" + "NIN", "ARB" + "ITER", "KING" + " JOE", "ar" + "byn", "act" + "orly"].join("|"), "i");
const bash = (cwd, command) => ({ cwd, tool_name: "Bash", tool_input: { command } });

export const tests = [
  ["hook guard: blocks publish without an approved plan and above the cap; allows otherwise; can be switched off", async () => {
    const work = makeWork({ publish: { cap: 20, requireApprovedPlan: true } });
    try {
      assert.match(decide(bash(work, "node scripts/publish.mjs --publish")), /IHC080/);
      assert.equal(decide(bash(work, "node scripts/publish.mjs")), null, "dry run is always allowed");
      approvedPlan(work);
      assert.equal(decide(bash(work, "node scripts/publish.mjs --publish")), null);
      assert.match(decide(bash(work, "node scripts/publish.mjs --publish --max 500")), /IHC081/);
      assert.match(decide(bash(work, "node scripts/publish.mjs --create-collections --plan .help-center/cols.json --publish")), /IHC080/, "a named plan must itself be approved");
      assert.equal(decide(bash(work, "node scripts/publish.mjs --publish"), { env: { HELP_CENTER_HOOKS: "off" } }), null);
    } finally { cleanup(work); }
  }],

  ["hook guard: blocks writing an Intercom token into a file or through a shell redirect", async () => {
    const work = makeWork();
    const env = { INTERCOM_API_TOKEN: "dG9rOnJlYWwtbG9va2luZy10b2tlbi12YWx1ZQ==" };
    try {
      assert.match(decide({ cwd: work, tool_name: "Write", tool_input: { file_path: ".env", content: `INTERCOM_API_TOKEN=${env.INTERCOM_API_TOKEN}` } }, { env }), /IHC082/);
      assert.match(decide({ cwd: work, tool_name: "Edit", tool_input: { file_path: "a.js", new_string: 'const t = "dG9rOmFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6"' } }, { env: {} }), /IHC082/);
      assert.match(decide(bash(work, 'echo "INTERCOM_API_TOKEN=$INTERCOM_API_TOKEN" >> .env'), { env }), /IHC082/);
      assert.equal(decide({ cwd: work, tool_name: "Write", tool_input: { file_path: "a.md", content: "export INTERCOM_API_TOKEN=... in your shell" } }, { env }), null, "docs about the variable are fine");
    } finally { cleanup(work); }
  }],

  ["hook guard: runs as a real process, fast, and fails safe on garbage input", async () => {
    const work = makeWork();
    try {
      const t0 = Date.now();
      let r = spawnSync(process.execPath, [join(REPO, "hooks/guard.mjs")], { input: JSON.stringify(bash(work, "node publish.mjs --publish")), encoding: "utf8" });
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
      assert.ok(Date.now() - t0 < 3000, "fast");
      r = spawnSync(process.execPath, [join(REPO, "hooks/guard.mjs")], { input: "not json", encoding: "utf8" });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "", "garbage in -> allow, never block the session");
    } finally { cleanup(work); }
  }],

  ["hook stale: editing a cited source reminds once per article, and Stop summarises then clears", async () => {
    const work = makeWork({ articlesDir: "help-articles/articles" });
    try {
      const input = { cwd: work, session_id: "s1", tool_name: "Edit", tool_input: { file_path: join(work, "src/export.js") } };
      assert.match(onPost(input), /IHC083 1 help article/);
      assert.equal(onPost(input), null, "once per article per session");
      assert.equal(onPost({ ...input, tool_input: { file_path: join(work, "src/other.js") } }), null);
      assert.match(onStop({ cwd: work, session_id: "s1" }), /how-do-i-export-my-orders-to-csv\.md/);
      assert.equal(onStop({ cwd: work, session_id: "s1" }), null, "cleared after Stop");
    } finally { cleanup(work); }
  }],

  ["coverage gate: the example passes; a missing article file and a ticketless deferral fail", async () => {
    const work = makeWork();
    try {
      let r = await capture(() => coverage(["--manifest", "help-articles/coverage-manifest.mjs"], { root: work }));
      assert.equal(r.result, 0, r.out);
      const m = join(work, "help-articles/coverage-manifest.mjs");
      write(m, readFileSync(m, "utf8").replace("tracked on the board as HELP-42", "we will get to it one day, promise, really").replace('"how-do-i-export', '"missing-'));
      r = await capture(() => coverage(["--manifest", "help-articles/coverage-manifest.mjs"], { root: work }));
      assert.equal(r.result, 1);
      assert.match(r.out, /IHC106/);
      write(join(work, "src/features.json"), JSON.stringify({ shipped: ["csv-export", "order-tags", "new-thing"] }));
      r = await capture(() => coverage(["--manifest", "help-articles/coverage-manifest.mjs"], { root: work }));
      assert.match(r.out, /IHC100 shipped feature "new-thing"/);
    } finally { cleanup(work); }
  }],

  ["docs: every message code is in docs/TROUBLESHOOTING.md, generated from the catalog and current", async () => {
    const doc = readFileSync(join(REPO, "docs/TROUBLESHOOTING.md"), "utf8");
    for (const code of Object.keys(MESSAGES)) assert.ok(doc.includes(code), `${code} documented`);
    const block = /<!-- BEGIN GENERATED ERRORS -->[\s\S]*<!-- END GENERATED ERRORS -->/.exec(doc)?.[0];
    assert.equal(block, renderTroubleshooting(), "run `node scripts/gen-docs.mjs` to regenerate");
  }],

  ["code: every error a script prints comes from the catalog", async () => {
    const files = [...readdirSync(join(REPO, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => `scripts/${f}`), ...readdirSync(join(REPO, "hooks")).filter((f) => f.endsWith(".mjs")).map((f) => `hooks/${f}`)];
    for (const f of files) {
      if (/selftest|gen-docs/.test(f)) continue;
      const text = readFileSync(join(REPO, f), "utf8");
      for (const m of text.matchAll(/fail\("(IHC\d+)"|report\("(IHC\d+)"|msg\("(IHC\d+)"/g)) {
        const code = m[1] ?? m[2] ?? m[3];
        assert.ok(MESSAGES[code], `${f} uses ${code}, which is not in the catalog`);
      }
      const raw = [...text.matchAll(/console\.error\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => !/^`! \$\{w\}`$/.test(a.trim()));
      assert.deepEqual(raw, [], `${f} prints an uncatalogued error`);
      assert.ok(!/throw new Error\(/.test(text), `${f} throws an uncatalogued Error`);
    }
  }],

  ["plugin: manifests, skills, agents and hooks are consistent", async () => {
    const plugin = JSON.parse(readFileSync(join(REPO, ".claude-plugin/plugin.json"), "utf8"));
    const market = JSON.parse(readFileSync(join(REPO, ".claude-plugin/marketplace.json"), "utf8"));
    assert.equal(plugin.name, "intercom-help-center");
    assert.equal(market.plugins[0].name, plugin.name, "entry name == manifest name");
    assert.equal(market.plugins[0].source, "./");
    const changelog = readFileSync(join(REPO, "CHANGELOG.md"), "utf8");
    assert.ok(changelog.includes(`## [${plugin.version}]`), "CHANGELOG has the plugin version");
    for (const d of readdirSync(join(REPO, "skills"))) {
      const s = readFileSync(join(REPO, "skills", d, "SKILL.md"), "utf8");
      assert.match(s, /^---\n[\s\S]*?\ndescription: .+\n[\s\S]*?---\n/, `${d} has frontmatter with a description`);
      for (const ref of s.matchAll(/\]\((references\/[^)]+)\)/g)) assert.ok(existsSync(join(REPO, "skills", d, ref[1])), `${d} links ${ref[1]}`);
      for (const ref of s.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+\.m?js)/g)) assert.ok(existsSync(join(REPO, ref[1])), `${d} runs ${ref[1]}, which exists`);
    }
    for (const f of readdirSync(join(REPO, "agents"))) {
      const a = readFileSync(join(REPO, "agents", f), "utf8");
      assert.match(a, /^---\nname: [a-z-]+\ndescription: .+\ntools: .+\n/m, `${f} frontmatter`);
      assert.ok(!/^(hooks|mcpServers|permissionMode):/m.test(a), `${f} uses no field plugin agents ignore`);
    }
    const hooks = JSON.parse(readFileSync(join(REPO, "hooks/hooks.json"), "utf8"));
    for (const groups of Object.values(hooks.hooks)) for (const g of groups) for (const h of g.hooks) {
      const file = h.args[0].replace("${CLAUDE_PLUGIN_ROOT}/", "");
      assert.ok(existsSync(join(REPO, file)), `hook ${file} exists`);
    }
  }],

  ["repo: no secrets and no private references in any tracked file", async () => {
    const walk = (d) => readdirSync(d).flatMap((f) => {
      if ([".git", "node_modules"].includes(f)) return [];
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    for (const p of walk(REPO)) {
      if (/\.(png|jpg|gif)$/i.test(p) || p.endsWith("hooks-gate-meta.test.mjs")) continue;
      const t = readFileSync(p, "utf8");
      assert.ok(!/dG9rO[A-Za-z0-9+/=]{30,}/.test(t) || /test|fake/i.test(p), `${p} contains something token-shaped`);
      assert.ok(!/sk-ant-[A-Za-z0-9]/.test(t), `${p} contains an Anthropic key`);
      assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(t), `${p} contains a GitHub token`);
      assert.ok(!PRIVATE.test(t), `${p} mentions a private project name`);
    }
  }],
];
