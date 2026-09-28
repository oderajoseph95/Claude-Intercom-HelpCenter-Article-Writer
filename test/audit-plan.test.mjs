import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createFakeIntercom, sampleHelpCenter } from "./fake-intercom.mjs";
import { makeWork, cleanup, capture, noSleep, readJson, write, writeJson } from "./helpers.mjs";
import { run as audit } from "../scripts/audit.mjs";
import { run as planCollections } from "../scripts/plan-collections.mjs";
import { run as correction } from "../scripts/correction-plan.mjs";
import { run as publish } from "../scripts/publish.mjs";

async function setup(opts = {}, fn) {
  const fake = createFakeIntercom({ ...sampleHelpCenter(), ...opts }).install();
  const work = makeWork();
  process.env.INTERCOM_API_TOKEN = "test-token-not-real";
  // a local file linked to an article that no longer exists on Intercom
  write(join(work, "help-articles/articles/gone.md"), `---\ntitle: "Gone?"\ncollection: "Orders"\nstate: published\nintercom_id: "4040"\n---\n\nGone.\n`);
  try { return await fn({ fake, work }); } finally { fake.uninstall(); cleanup(work); }
}
const runIn = (work, f, argv) => capture(() => f(argv, { root: work, sleep: noSleep, now: Date.parse("2026-09-29T00:00:00Z") }));

export const tests = [
  ["audit: reads every page read-only, and finds every class of problem", () => setup({}, async ({ fake, work }) => {
    const r = await runIn(work, audit, []);
    assert.equal(r.result, 0, r.out);
    assert.equal(fake.writes().length, 0, "audit made zero writes");
    assert.ok(fake.state.calls.filter((c) => c.path === "/articles").length >= 5, "articles read across all pages");
    assert.ok(fake.state.calls.filter((c) => c.path === "/help_center/collections").length >= 3, "collections read across all pages");
    const a = readJson(join(work, ".help-center/help-center-audit.json"));
    assert.equal(a.totals.articles, 11);
    const types = new Set(a.findings.map((f) => f.type));
    for (const t of ["same-title-other-collection", "duplicate", "near-duplicate", "empty", "broken-link", "links-to-draft", "draft", "no-collection",
      "non-question-title", "stale", "orphan", "uncovered-feature", "missing-translation", "deleted-on-intercom", "empty-collection"]) assert.ok(types.has(t), `finds ${t}`);
    const uncovered = a.findings.filter((f) => f.type === "uncovered-feature").map((f) => f.feature_id);
    assert.deepEqual(uncovered, ["order-tags"], "csv-export is covered; order-tags is not");
    const tagEvidence = a.findings.find((f) => f.feature_id === "order-tags").evidence.strings.join("\n");
    assert.match(tagEvidence, /settings\.tags\.autoTag\.label = "Tag edited orders"/, "evidence cites the UI string key and file");
    const exportArticle = a.articles.find((x) => x.id === "1");
    assert.equal(exportArticle.features[0].id, "csv-export", "article mapped to its feature from UI strings");
    assert.equal(exportArticle.collection_path, "Orders");
    assert.equal(a.articles.find((x) => x.id === "4").collection_path, "Old stuff › Legacy › Deep", "3-level path");
    const md = readFileSync(join(work, ".help-center/help-center-audit.md"), "utf8");
    assert.match(md, /## Fix these first/);
    assert.match(md, /Shipped features with no article/);
    assert.ok(existsSync(join(work, ".help-center/snapshot.json")));
  })],

  ["audit: list responses without bodies are fetched one by one (never judged empty by mistake)", () => setup({ listWithoutBody: true }, async ({ fake, work }) => {
    const r = await runIn(work, audit, []);
    assert.equal(r.result, 0, r.out);
    assert.ok(fake.state.calls.some((c) => c.path === "/articles/1"), "fetched body of article 1");
    const a = readJson(join(work, ".help-center/help-center-audit.json"));
    assert.ok(!a.findings.some((f) => f.type === "empty" && f.article_id === "1"));
  })],

  ["audit: a brand-new workspace with no articles still reports every feature as uncovered", () => setup({ articles: [], collections: [] }, async ({ work }) => {
    const r = await runIn(work, audit, []);
    assert.equal(r.result, 0, r.out);
    const a = readJson(join(work, ".help-center/help-center-audit.json"));
    assert.equal(a.totals.articles, 0);
    assert.deepEqual(a.findings.filter((f) => f.type === "uncovered-feature").map((f) => f.feature_id).sort(), ["csv-export", "order-tags"]);
  })],

  ["audit: a saved snapshot re-audits offline with no token", () => setup({}, async ({ fake, work }) => {
    await runIn(work, audit, []);
    delete process.env.INTERCOM_API_TOKEN;
    fake.reset();
    const r = await runIn(work, audit, ["--snapshot", ".help-center/snapshot.json"]);
    assert.equal(r.result, 0, r.out);
    assert.equal(fake.state.calls.length, 0, "no network");
  })],

  ["audit: no token and no snapshot -> IHC001", () => setup({}, async ({ work }) => {
    delete process.env.INTERCOM_API_TOKEN;
    const r = await runIn(work, audit, []);
    assert.equal(r.result.code, "IHC001");
  })],

  ["plan-collections: proposes a tree from features and places every article; never approved by default", () => setup({}, async ({ work }) => {
    await runIn(work, audit, []);
    const r = await runIn(work, planCollections, []);
    assert.equal(r.result, 0, r.out);
    const p = readJson(join(work, ".help-center/help-center-collections.plan.json"));
    assert.equal(p.approved, false);
    const paths = p.tree.map((t) => t.path.join(" › "));
    for (const x of ["Getting started", "Orders", "Orders › Export orders", "Orders › Tag edited orders", "Billing", "Troubleshooting"]) assert.ok(paths.includes(x), `tree has ${x}`);
    assert.equal(p.moves.length, 11, "every article placed");
    const byId = Object.fromEntries(p.moves.map((m) => [m.article_id, m]));
    assert.equal(byId["1"].action, "MOVE");
    assert.deepEqual(byId["1"].to, ["Orders", "Export orders"]);
    assert.deepEqual(byId["5"].to, ["Billing"], "billing draft goes to Billing");
    assert.equal(byId["4"].action, "REVIEW", "unknown topic is left for a human");
    assert.ok(p.unused_collections.some((c) => c.path === "Old stuff"), "unused collections listed, not deleted");
  })],

  ["collections plan: refused until approved; dry run writes nothing; publish creates and moves; cap applies", () => setup({}, async ({ fake, work }) => {
    await runIn(work, audit, []);
    await runIn(work, planCollections, []);
    const planArg = ["--create-collections", "--plan", ".help-center/help-center-collections.plan.json"];
    let r = await runIn(work, publish, [...planArg, "--publish"]);
    assert.equal(r.result.code, "IHC031");
    r = await runIn(work, planCollections, ["--approve"]);
    assert.equal(r.result.code, "IHC040", "approval needs a name");
    r = await runIn(work, planCollections, ["--approve", "--by", "Jane"]);
    assert.equal(r.result, 0);
    fake.reset();
    r = await runIn(work, publish, planArg);
    assert.equal(r.result, 0, r.out);
    assert.equal(fake.writes().length, 0, "dry run");
    assert.match(r.out, /\[dry\] MOVE "How do I export my orders to CSV\?"/);
    r = await runIn(work, publish, [...planArg, "--publish", "--max", "3"]);
    assert.equal(r.result.code, "IHC030");
    assert.equal(fake.writes().length, 0);
    r = await runIn(work, publish, [...planArg, "--publish", "--max", "50"]);
    assert.equal(r.result, 0, r.out);
    const posts = fake.writes().filter((c) => c.path === "/help_center/collections");
    assert.ok(posts.some((p) => p.body.name === "Billing" && p.body.parent_id === undefined), "top-level created without parent");
    assert.ok(posts.some((p) => p.body.name === "Export orders" && p.body.parent_id === "11"), "section created under Orders");
    const move = fake.writes().find((c) => c.method === "PUT" && c.path === "/articles/1");
    assert.ok(move && move.body.parent_type === "collection" && Object.keys(move.body).length === 2, "move sends only parent_id + parent_type");
    assert.ok(!fake.writes().some((c) => c.method === "DELETE"), "nothing deleted");
  })],

  ["correction plan: verdicts with evidence; approvals all / pick / none", () => setup({}, async ({ work }) => {
    await runIn(work, audit, []);
    let r = await runIn(work, correction, []);
    assert.equal(r.result, 0, r.out);
    const p = readJson(join(work, ".help-center/help-center-plan.json"));
    assert.equal(p.approved, false);
    const v = (pred) => p.items.find(pred)?.verdict;
    assert.equal(v((i) => i.feature_id === "order-tags"), "WRITE");
    assert.equal(v((i) => i.article_id === "3"), "MERGE", "empty duplicate 'Welcome' merges into the full one");
    assert.equal(v((i) => i.article_id === "4"), "DELETE", "orphan proposed for deletion");
    assert.ok(p.items.find((i) => i.article_id === "4").needs_confirmation);
    assert.equal(v((i) => i.article_id === "6"), "FIX", "links to a draft");
    assert.ok([v((i) => i.article_id === "7"), v((i) => i.article_id === "8")].includes("MERGE"), "one of the near-duplicate pair merges into the other");
    assert.ok(p.items.find((i) => i.feature_id === "order-tags").evidence.strings.length > 0, "WRITE carries UI-string evidence");
    assert.ok(readFileSync(join(work, ".help-center/help-center-plan.md"), "utf8").includes("## WRITE (1)"));
    r = await runIn(work, correction, ["--approve", "P999", "--by", "Jane"]);
    assert.equal(r.result.code, "IHC040");
    const first = p.items[0].id;
    r = await runIn(work, correction, ["--approve", first, "--by", "Jane"]);
    assert.equal(r.result, 0);
    let q = readJson(join(work, ".help-center/help-center-plan.json"));
    assert.equal(q.items.filter((i) => i.decision === "approved").length, 1);
    assert.equal(q.approved, true);
    r = await runIn(work, correction, ["--approve", "none", "--by", "Jane"]);
    q = readJson(join(work, ".help-center/help-center-plan.json"));
    assert.equal(q.approved, false, "approving nothing leaves the plan unapproved");
  })],

  ["config: a token pasted into config is refused", async () => {
    const { saveConfig, DEFAULTS } = await import("../scripts/lib/config.mjs");
    const work = makeWork();
    try {
      const c = structuredClone(DEFAULTS);
      c.intercom.authorId = "dG9rOmFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MTIzNDU2";
      assert.throws(() => saveConfig(work, c), /IHC011/);
      writeJson(join(work, "x.json"), {});
    } finally { cleanup(work); }
  }],
];
