import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { createFakeIntercom, sampleHelpCenter } from "./fake-intercom.mjs";
import { makeWork, cleanup, capture, noSleep, write, writeJson, approvedPlan } from "./helpers.mjs";
import { run as findExisting } from "../scripts/find-existing.mjs";
import { run as pull } from "../scripts/pull.mjs";
import { run as publish } from "../scripts/publish.mjs";
import { htmlToMarkdown, toIntercomHtml } from "../scripts/lib/html.mjs";

async function setup(opts, fn) {
  const fake = createFakeIntercom({ ...sampleHelpCenter(), ...opts }).install();
  const work = makeWork();
  process.env.INTERCOM_API_TOKEN = "test-token-not-real";
  try { return await fn({ fake, work, go: (f, argv) => capture(() => f(argv, { root: work, sleep: noSleep })) }); }
  finally { fake.uninstall(); cleanup(work); }
}

export const tests = [
  ["pre-write check: a published article on the same topic -> UPDATE its id, never CREATE", () => setup({}, async ({ work, go }) => {
    const r = await go(findExisting, ["--title", "How can I export orders as a CSV?", "--json"]);
    const res = JSON.parse(r.out.slice(r.out.indexOf("{")));
    assert.ok(["UPDATE", "AMBIGUOUS"].includes(res.decision.action), r.out);
    assert.ok(res.candidates.some((c) => c.id === "1"));
    assert.ok(existsSync(join(work, ".help-center/snapshot.json")), "fetched and cached a snapshot");
  })],

  ["pre-write check: the same title in two collections -> AMBIGUOUS, exit 3, a human picks", () => setup({}, async ({ go }) => {
    const r = await go(findExisting, ["--title", "How do I export my orders to CSV?"]);
    assert.equal(r.result, 3, r.out);
    assert.match(r.out, /^AMBIGUOUS/m);
    assert.match(r.out, /#1 /);
    assert.match(r.out, /#2 /);
  })],

  ["pre-write check: a new topic -> CREATE", () => setup({}, async ({ go }) => {
    const r = await go(findExisting, ["--title", "How do I connect my Slack workspace?"]);
    assert.equal(r.result, 0);
    assert.match(r.out, /^CREATE/m);
  })],

  ["pre-write check: a local draft not yet on Intercom -> UPDATE-LOCAL", () => setup({ articles: [] }, async ({ work, go }) => {
    write(join(work, "help-articles/articles/slack.md"), `---\ntitle: "How do I connect Slack?"\ncollection: "Integrations"\nstate: draft\n---\n\nConnect Slack.\n`);
    const r = await go(findExisting, ["--title", "How do I connect Slack?"]);
    assert.match(r.out, /^UPDATE-LOCAL help-articles\/articles\/slack\.md/m, r.out);
  })],

  ["pre-write check: a stale snapshot is refreshed with a token; without one it warns (IHC052); none at all -> IHC050", () => setup({}, async ({ fake, work, go }) => {
    writeJson(join(work, ".help-center/snapshot.json"), { fetched_at: "2020-01-01T00:00:00Z", collections: [], articles: [] });
    let r = await go(findExisting, ["--title", "Export orders to CSV"]);
    assert.match(r.out, /IHC051/);
    assert.ok(fake.state.calls.some((c) => c.path === "/articles"), "refreshed");
    writeJson(join(work, ".help-center/snapshot.json"), { fetched_at: "2020-01-01T00:00:00Z", collections: [], articles: [] });
    delete process.env.INTERCOM_API_TOKEN;
    r = await go(findExisting, ["--title", "Export orders to CSV"]);
    assert.match(r.out, /IHC052/);
    const { rmSync } = await import("node:fs");
    rmSync(join(work, ".help-center/snapshot.json"));
    r = await go(findExisting, ["--title", "Export orders to CSV"]);
    assert.equal(r.result.code, "IHC050");
  })],

  ["pull: imports a live article to markdown, keeps embeds, and republishing sends them back untouched", () => setup({ articles: [
    { id: "40", title: "How do I watch the setup video?", state: "published", parent_id: 11, workspace_id: "ws1", updated_at: 1790000000,
      body: '<h2>Watch</h2><p class="no-margin"></p><p class="no-margin">Play the <b>Setup</b> video.</p><p class="no-margin"></p><div class="intercom-embed"><iframe src="https://www.youtube.com/embed/xyz"></iframe></div><p class="no-margin"></p><ul><li><p class="no-margin">Step one</p></li></ul>' },
  ] }, async ({ fake, work, go }) => {
    let r = await go(pull, ["--id", "40"]);
    assert.equal(r.result, 0, r.out);
    const file = join(work, "help-articles/articles/orders/how-do-i-watch-the-setup-video.md");
    const md = readFileSync(file, "utf8");
    assert.match(md, /^intercom_id: "40"$/m);
    assert.match(md, /^collection: "Orders"$/m);
    assert.match(md, /<div class="intercom-embed"><iframe src="https:\/\/www\.youtube\.com\/embed\/xyz"><\/iframe><\/div>/, "embed kept as raw HTML");
    assert.match(md, /^- Step one$/m);
    assert.match(md, /Play the \*\*Setup\*\* video\./);
    assert.ok(existsSync(join(work, ".help-center/base/40.html")));
    approvedPlan(work);
    write(file, readFileSync(file, "utf8").replace("state: published", "state: published"));
    fake.reset();
    r = await go(publish, ["--publish", "help-articles/articles/orders/how-do-i-watch-the-setup-video.md"]);
    assert.equal(r.result, 0, r.out);
    const put = fake.writes().find((c) => c.method === "PUT");
    assert.match(put.body.body, /<div class="intercom-embed"><iframe src="https:\/\/www\.youtube\.com\/embed\/xyz"><\/iframe><\/div>/, "embed republished untouched");
    // pulling again next to an existing file never overwrites it
    r = await go(pull, ["--id", "40"]);
    assert.ok(existsSync(file.replace(/\.md$/, ".remote.md")), "live copy written beside the local file");
  })],

  ["pull --replace (keep Intercom's version after drift) keeps the local sources and collection", () => setup({}, async ({ fake, work, go }) => {
    const file = join(work, "help-articles/articles/orders/export.md");
    write(file, `---\ntitle: "Old title?"\ncollection: "Orders"\nstate: published\nsources:\n  - src/export.js\nintercom_id: "1"\n---\n\n# Old title?\n\nOld body.\n`);
    fake.article("1").body = "<p>Intercom's edited body.</p>";
    const r = await go(pull, ["--id", "1", "--replace"]);
    assert.equal(r.result, 0, r.out);
    const md = readFileSync(file, "utf8");
    assert.match(md, /^sources:\n  - src\/export\.js$/m, "sources kept");
    assert.match(md, /^title: "How do I export my orders to CSV\?"$/m, "Intercom's title taken");
    assert.match(md, /Intercom's edited body\./);
    assert.ok(!md.includes("Old body."));
  })],

  ["html: markdown -> Intercom HTML -> markdown keeps the content", async () => {
    const md = "# Title\n\nIntro with **bold**, *italic*, `code` and a [link](https://x.y).\n\n## Steps\n\n1. One\n2. Two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> Note\n\n```\nnpm i\n```\n";
    const html = toIntercomHtml(md);
    assert.ok(!html.includes("Title"), "H1 stripped");
    const back = htmlToMarkdown(html);
    for (const s of ["**bold**", "*italic*", "`code`", "[link](https://x.y)", "## Steps", "1. One", "| A | B |", "> Note", "npm i"]) assert.ok(back.includes(s), `round-trips ${s}\n${back}`);
  }],
];
