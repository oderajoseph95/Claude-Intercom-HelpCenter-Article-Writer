import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createFakeIntercom } from "./fake-intercom.mjs";
import { makeWork, cleanup, capture, approvedPlan, noSleep, write } from "./helpers.mjs";
import { run as publish } from "../scripts/publish.mjs";

const ARTICLE = "help-articles/articles/getting-started/export-csv.md";
const cols = () => [
  { id: "1", name: "Billing", parent_id: null },
  { id: "2", name: "Getting Started", parent_id: null },
  { id: "3", name: "Orders", parent_id: null },
];

async function withFake(opts, fn) {
  const fake = createFakeIntercom({ collections: cols(), ...opts }).install();
  const work = makeWork();
  process.env.INTERCOM_API_TOKEN = "test-token-not-real";
  delete process.env.INTERCOM_AUTHOR_ID;
  try { return await fn({ fake, work, pub: (argv) => capture(() => publish(argv, { root: work, sleep: noSleep })) }); }
  finally { fake.uninstall(); cleanup(work); }
}

export const tests = [
  ["publish: refuses real writes until a plan is approved, then creates, writes back and updates by id", () => withFake({}, async ({ fake, work, pub }) => {
    let r = await pub(["--publish"]);
    assert.equal(r.result.code, "IHC031", "no approved plan -> refused");
    assert.equal(fake.writes().length, 0, "nothing written while refused");
    approvedPlan(work);

    r = await pub(["--publish"]);
    assert.equal(r.result, 0, r.out);
    const post = fake.writes().find((c) => c.method === "POST" && c.path === "/articles");
    assert.ok(post, "POST /articles");
    assert.equal(post.body.parent_id, 2, "collection resolved from page 2 of collections");
    assert.equal(post.body.author_id, 777, "author falls back to GET /me");
    assert.ok(!post.body.body.includes("<h2>How do I export"), "leading H1 stripped");
    assert.ok(!post.body.body.includes("Reviewer note"), "HTML comment stripped");
    assert.match(post.body.body, /<\/h2><p class="no-margin"><\/p>\n<p class="no-margin">/, "spacer after heading");
    const after = readFileSync(join(work, ARTICLE), "utf8");
    assert.match(after, /^intercom_id: "\d+"$/m, "id written back");
    assert.match(after, /^intercom_workspace: "ws1"$/m, "workspace written back");
    assert.match(after, /^remote_hash: "[0-9a-f]{8}"$/m, "hash written back");
    assert.match(after, /^sources:\n  - src\/export\.js/m, "other frontmatter untouched");
    const id = /^intercom_id: "(\d+)"$/m.exec(after)[1];
    assert.ok(existsSync(join(work, `.help-center/base/${id}.html`)), "last-published copy saved for 3-way diffs");
    const ledger = readFileSync(join(work, "help-articles/PUBLISHED.md"), "utf8");
    assert.match(ledger, /\*\*1 on Intercom\*\* · 1 live · 0 draft/);

    fake.reset();
    r = await pub(["--publish"]);
    assert.equal(r.result, 0, r.out);
    assert.ok(!fake.writes().some((c) => c.method === "POST"), "second run never creates a duplicate");
    assert.ok(fake.writes().some((c) => c.method === "PUT" && c.path === `/articles/${id}`), "second run updates by id");
  })],

  ["publish: dry run prints the exact diff against the live article and writes nothing", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    await pub(["--publish"]);
    const id = /^intercom_id: "(\d+)"$/m.exec(readFileSync(join(work, ARTICLE), "utf8"))[1];
    const p = join(work, ARTICLE);
    write(p, readFileSync(p, "utf8").replace("It takes about a minute.", "It takes about two minutes."));
    fake.reset();
    const r = await pub([]);
    assert.equal(r.result, 0, r.out);
    assert.equal(fake.writes().length, 0, "dry run: zero writes");
    assert.match(r.out, new RegExp(`\\[dry\\] UPDATE .*\\(2\\)`));
    assert.match(r.out, /- .*about a minute/);
    assert.match(r.out, /\+ .*about two minutes/);
    assert.ok(id);
  })],

  ["publish: an article edited on Intercom is never overwritten silently (3-way view), unless --overwrite-drift", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    await pub(["--publish"]);
    const id = /^intercom_id: "(\d+)"$/m.exec(readFileSync(join(work, ARTICLE), "utf8"))[1];
    fake.article(id).body = "<p>Someone fixed a typo in the Intercom editor.</p>";
    fake.reset();
    let r = await pub(["--publish"]);
    assert.equal(r.result, 1);
    assert.match(r.out, /IHC036/);
    assert.match(r.out, /last published/);
    assert.match(r.out, /Someone fixed a typo/);
    assert.ok(!fake.writes().some((c) => c.method === "PUT"), "drifted article not overwritten");
    r = await pub(["--publish", "--overwrite-drift", id]);
    assert.equal(r.result, 0, r.out);
    assert.ok(fake.writes().some((c) => c.method === "PUT"), "explicit overwrite goes through");
  })],

  ["publish: deleted on Intercom is reported, and only --recreate-missing recreates it", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    await pub(["--publish"]);
    fake.state.articles.length = 0;
    fake.reset();
    let r = await pub(["--publish"]);
    assert.match(r.out, /IHC034/);
    assert.equal(fake.writes().length, 0);
    r = await pub(["--publish", "--recreate-missing"]);
    assert.equal(r.result, 0, r.out);
    assert.equal(fake.writes().filter((c) => c.method === "POST").length, 1, "recreated once");
  })],

  ["publish: a file from another workspace is refused", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    const p = join(work, ARTICLE);
    write(p, readFileSync(p, "utf8").replace("intercom_id: null", 'intercom_id: "55"\nintercom_workspace: "staging-ws"'));
    const r = await pub(["--publish"]);
    assert.match(r.out, /IHC035/);
    assert.equal(fake.writes().length, 0);
  })],

  ["publish: network failure after a create landed; the re-run adopts it instead of duplicating", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    fake.networkFailOnce("POST", "/articles", { afterApply: true });
    let r = await pub(["--publish"]);
    assert.match(r.out, /IHC006/);
    assert.equal(fake.state.articles.length, 1, "the write landed on Intercom");
    fake.reset();
    r = await pub(["--publish"]);
    assert.equal(r.result, 0, r.out);
    assert.match(r.out, /IHC042/);
    assert.equal(fake.writes().filter((c) => c.method === "POST").length, 0, "no second copy");
    assert.equal(fake.state.articles.length, 1);
  })],

  ["publish: the cap refuses the whole run before any write", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    for (const n of [1, 2]) write(join(work, `help-articles/articles/getting-started/extra-${n}.md`), `---\ntitle: "Extra ${n}?"\ncollection: "Getting Started"\nstate: published\n---\n\nBody ${n}.\n`);
    const r = await pub(["--publish", "--max", "2"]);
    assert.equal(r.result.code, "IHC030");
    assert.equal(fake.writes().length, 0);
  })],

  ["publish: two live articles with the same title -> refuse to guess", () => withFake({ articles: [
    { id: "71", title: "How do I export my orders to a CSV file?", state: "published", parent_id: 2, body: "<p>a</p>" },
    { id: "72", title: "How do I export my orders to a CSV file?", state: "published", parent_id: 3, body: "<p>b</p>" },
  ] }, async ({ fake, work, pub }) => {
    approvedPlan(work);
    const r = await pub(["--publish"]);
    assert.match(r.out, /IHC045/);
    assert.equal(fake.writes().length, 0);
  })],

  ["publish: no author id anywhere -> clear error", () => withFake({ me: { type: "admin", app: { id_code: "ws1", name: "x" } } }, async ({ fake, work, pub }) => {
    approvedPlan(work);
    const r = await pub(["--publish"]);
    assert.equal(r.result.code, "IHC037");
    assert.equal(fake.writes().length, 0);
  })],

  ["publish: a token without write scope reports IHC004", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    fake.failOnce("POST", "/articles", 403);
    const r = await pub(["--publish"]);
    assert.match(r.out, /IHC004/);
  })],

  ["publish: a renamed collection still resolves through its saved id", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    await pub(["--publish"]);
    fake.state.collections.find((c) => c.id === "2").name = "Start here";
    fake.reset();
    const r = await pub(["--publish"]);
    assert.equal(r.result, 0, r.out);
    assert.match(r.out, /IHC043/);
    assert.equal(fake.writes().find((c) => c.method === "PUT").body.parent_id, 2);
  })],

  ["publish: nested collections deeper than 2 levels are created on demand with --create-collections", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    write(join(work, "help-articles/articles/deep.md"), `---\ntitle: "How deep does it go?"\ncollection: "Guides"\nsection: "Admin › Advanced › Exports"\nstate: published\n---\n\nDeep.\n`);
    let r = await pub(["--publish", "help-articles/articles/deep.md"]);
    assert.match(r.out, /IHC032/, "missing collection refused without the flag");
    r = await pub(["--publish", "--create-collections", "help-articles/articles/deep.md"]);
    assert.equal(r.result, 0, r.out);
    const posts = fake.writes().filter((c) => c.path === "/help_center/collections");
    assert.deepEqual(posts.map((p) => p.body.name), ["Guides", "Admin", "Advanced", "Exports"]);
    assert.equal(posts[0].body.parent_id, undefined, "top-level collection has no parent");
    assert.equal(typeof posts[1].body.parent_id, "string", "sections carry a string parent_id");
  })],

  ["publish: a translation goes into the source article's translated_content", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    write(join(work, "help-articles/articles/getting-started/export-csv.fr.md"), `---\ntitle: "Comment exporter mes commandes ?"\nlocale: fr\ntranslation_of: "help-articles/articles/getting-started/export-csv.md"\nstate: published\n---\n\nBonjour.\n`);
    const r = await pub(["--publish"]);
    assert.equal(r.result, 0, r.out);
    const put = fake.writes().find((c) => c.method === "PUT" && c.body.translated_content);
    assert.ok(put, "PUT with translated_content");
    assert.equal(put.body.translated_content.fr.type, "article_content");
    assert.equal(put.body.translated_content.fr.title, "Comment exporter mes commandes ?");
  })],

  ["publish: CRLF (Windows) article files parse and publish", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    const p = join(work, ARTICLE);
    write(p, readFileSync(p, "utf8").replace(/\r?\n/g, "\r\n"));
    const r = await pub(["--publish"]);
    assert.equal(r.result, 0, r.out);
    assert.match(readFileSync(p, "utf8"), /\r\nintercom_id: "\d+"\r\n/, "write-back keeps CRLF");
  })],

  ["publish: raw HTML and embeds are preserved, with a warning", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    const p = join(work, ARTICLE);
    write(p, readFileSync(p, "utf8").replace("## Before you start", '<iframe src="https://www.youtube.com/embed/abc" width="560"></iframe>\n\n![Export screen](https://example.com/export.png)\n\n## Before you start'));
    const r = await pub(["--publish"]);
    assert.equal(r.result, 0, r.out);
    assert.match(r.out, /IHC044/);
    const body = fake.writes().find((c) => c.method === "POST").body.body;
    assert.match(body, /<iframe src="https:\/\/www\.youtube\.com\/embed\/abc" width="560"><\/iframe>/);
    assert.match(body, /<img src="https:\/\/example\.com\/export\.png" alt="Export screen">/);
  })],

  ["publish: an ad-hoc plan approves exactly the files it lists", () => withFake({}, async ({ fake, work, pub }) => {
    const { run: correction } = await import("../scripts/correction-plan.mjs");
    write(join(work, "help-articles/articles/getting-started/other.md"), `---\ntitle: "Other?"\ncollection: "Getting Started"\nstate: published\n---\n\nOther.\n`);
    let r = await capture(() => correction(["--adhoc", "Document the export", "--files", ARTICLE, "--by", "Jane"], { root: work, now: Date.parse("2026-09-29T10:00:00Z") }));
    assert.equal(r.result, 0, r.out);
    const plan = /help-center\/adhoc-[\w]+\.plan\.json/.exec(r.out)[0];
    r = await pub(["--publish", "--plan", `.${plan}`]);
    assert.match(r.out, /IHC046 .*other\.md/);
    assert.equal(fake.writes().filter((c) => c.method === "POST").length, 1, "only the listed article");
  })],

  ["publish: 429 rate limits are retried (Retry-After honoured) and the run completes", () => withFake({}, async ({ fake, work, pub }) => {
    approvedPlan(work);
    fake.failOnce("GET", "/help_center/collections", 429, { "Retry-After": "0" });
    const r = await pub(["--publish"]);
    assert.equal(r.result, 0, r.out);
    assert.equal(fake.state.calls.filter((c) => c.path === "/help_center/collections").length, 3, "one retry + two pages");
  })],
];
