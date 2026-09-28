#!/usr/bin/env node
/**
 * selftest.mjs: exercise publish.mjs end to end against a MOCKED Intercom API.
 *
 * No network, no token, nothing real is touched. It copies examples/ to a temp folder, stubs
 * global fetch with a fake Help Center, runs `publish.mjs --publish` twice, and asserts:
 *   - run 1 CREATES the article (POST), writes intercom_id / intercom_url / last_synced back
 *   - run 2 UPDATES the same id (PUT), never a duplicate POST
 *   - the body sent has the spacer between every block, and no leading H1, and no HTML comment
 *   - collections are read across more than one page
 *   - the parity ledger is written with one row
 *
 * What a mock cannot prove: that Intercom accepts and renders this payload. Only a real
 * `--publish` of one article, opened in the Help Center, proves that.
 *
 *   node scripts/selftest.mjs
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "iaw-selftest-"));
cpSync(join(here, "..", "examples"), work, { recursive: true });
const ARTICLE = join(work, "help-articles/articles/getting-started/how-do-i-export-my-orders-to-csv.md");

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, path: u.pathname + u.search, body });
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  if (u.pathname === "/help_center/collections" && method === "GET") {
    // Two pages, so a single-page read would miss "Getting Started".
    if (!u.searchParams.get("page")) return json({ data: [{ id: 1, name: "Billing", parent_id: null }], pages: { next: "https://api.intercom.io/help_center/collections?per_page=100&page=2" } });
    return json({ data: [{ id: 2, name: "Getting Started", parent_id: null }], pages: {} });
  }
  if (u.pathname === "/me") return json({ id: 777 });
  if (u.pathname === "/articles" && method === "POST") return json({ id: 555, url: "https://help.example.com/en/articles/555-export" });
  if (u.pathname === "/articles/555" && method === "PUT") return json({ id: 555, url: "https://help.example.com/en/articles/555-export" });
  return new Response(`unexpected ${method} ${u.pathname}`, { status: 404 });
};

process.env.INTERCOM_API_TOKEN = "test-token-not-real";
delete process.env.INTERCOM_AUTHOR_ID;
const cwd = process.cwd();
process.chdir(work);

async function runPublish(tag) {
  // publish.mjs runs main() only when argv[1] is its own path; each import needs a fresh URL.
  process.argv = [process.argv[0], join(here, "publish.mjs"), "--publish"];
  let exitCode;
  const realExit = process.exit;
  const done = new Promise((res) => { process.exit = (c) => { exitCode = c; res(); }; });
  await import(`./publish.mjs?run=${tag}`);
  await done;
  process.exit = realExit;
  return exitCode;
}

try {
  assert.equal(await runPublish(1), 0, "first publish exits 0");
  const post = calls.find((c) => c.method === "POST");
  assert.ok(post, "run 1 POSTs a new article");
  assert.equal(post.body.parent_id, 2, "collection resolved from page 2");
  assert.equal(post.body.author_id, 777, "author falls back to GET /me");
  assert.equal(post.body.state, "published");
  assert.ok(!post.body.body.includes("<h2>How do I export"), "leading H1 stripped");
  assert.ok(!post.body.body.includes("Reviewer note"), "HTML comment stripped");
  assert.match(post.body.body, /<\/h2><p class="no-margin"><\/p>\n<p class="no-margin">/, "spacer after heading");
  const after1 = readFileSync(ARTICLE, "utf8");
  assert.match(after1, /^intercom_id: "555"$/m, "id written back");
  assert.match(after1, /^intercom_url: "https:\/\/help\.example\.com/m, "url written back");
  assert.match(after1, /^last_synced: "\d{4}-/m, "last_synced written back");
  assert.match(after1, /^sources:\n  - src\/export\.js/m, "other frontmatter untouched");

  calls.length = 0;
  assert.equal(await runPublish(2), 0, "second publish exits 0");
  assert.ok(!calls.some((c) => c.method === "POST"), "run 2 does not create a duplicate");
  assert.ok(calls.some((c) => c.method === "PUT" && c.path === "/articles/555"), "run 2 updates by id");

  const ledger = readFileSync(join(work, "help-articles/PUBLISHED.md"), "utf8");
  assert.match(ledger, /\*\*1 on Intercom\*\* · 1 live · 0 draft/);
  assert.match(ledger, /\| How do I export my orders to a CSV file\? \| Getting Started \| published \| 555 \|/);

  console.log("✓ selftest passed: create, write-back, update-by-id, pagination, spacer, ledger");
} finally {
  process.chdir(cwd);
  rmSync(work, { recursive: true, force: true });
}
