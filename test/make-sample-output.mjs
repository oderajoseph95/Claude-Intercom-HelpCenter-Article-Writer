#!/usr/bin/env node
/**
 * Regenerates examples/sample-output/ from the fake Intercom fixtures, so readers can see exactly
 * what the audit and the plans look like before installing anything.
 *
 *   node test/make-sample-output.mjs
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeIntercom, sampleHelpCenter } from "./fake-intercom.mjs";
import { makeWork, cleanup, capture, REPO, write } from "./helpers.mjs";
import { run as audit } from "../scripts/audit.mjs";
import { run as planCollections } from "../scripts/plan-collections.mjs";
import { run as correction } from "../scripts/correction-plan.mjs";

const fake = createFakeIntercom(sampleHelpCenter()).install();
fake.state.me.app.name = "Example Co Help Center";
const work = makeWork();
process.env.INTERCOM_API_TOKEN = "fake-token";
write(join(work, "help-articles/articles/gone.md"), `---\ntitle: "How do I archive an order?"\ncollection: "Orders"\nstate: published\nintercom_id: "4040"\n---\n\nArchive.\n`);
const now = Date.parse("2026-09-29T09:00:00Z");
try {
  for (const [f, argv] of [[audit, []], [planCollections, []], [correction, []]]) {
    const r = await capture(() => f(argv, { root: work, now }));
    if (r.result !== 0) throw new Error(r.out);
  }
  const out = join(REPO, "examples/sample-output");
  mkdirSync(out, { recursive: true });
  const stamp = (s) => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "2026-09-29T09:00:00.000Z");
  for (const f of ["help-center-audit.md", "help-center-audit.json", "help-center-collections.plan.md", "help-center-plan.md"]) {
    writeFileSync(join(out, f), stamp(readFileSync(join(work, ".help-center", f), "utf8")));
  }
  console.log(`sample output written to examples/sample-output/`);
} finally {
  fake.uninstall();
  cleanup(work);
}
