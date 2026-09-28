#!/usr/bin/env node
/**
 * selftest.mjs: every test, offline. No network, no token, nothing real is touched.
 *
 * Intercom is a fake in-memory API (test/fake-intercom.mjs) installed as fetch; git and gh are a
 * scripted fake (test/fake-git.mjs). Each test works in a temp copy of examples/.
 *
 * What a fake cannot prove: that Intercom accepts and renders these payloads, or that real
 * git/gh behave as scripted. The README's "Tested vs not tested" section lists exactly that.
 *
 *   node scripts/selftest.mjs            # all
 *   node scripts/selftest.mjs publish    # only test files whose name contains "publish"
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, "..", "test");
const filter = process.argv[2];
// Never let a real token reach a test: strip INTERCOM_* before anything runs.
for (const k of Object.keys(process.env)) if (k.startsWith("INTERCOM_") || k === "HELP_CENTER_HOOKS") delete process.env[k];
const clean = { ...process.env };

let pass = 0, failed = 0;
const failures = [];
for (const f of readdirSync(testDir).filter((x) => x.endsWith(".test.mjs")).sort()) {
  if (filter && !f.includes(filter)) continue;
  const { tests } = await import(pathToFileURL(join(testDir, f)).href);
  console.log(`\n${f}`);
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      failures.push({ file: f, name, e });
      console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split("\n").slice(0, 12).join("\n      ")}`);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k];
    }
  }
}
console.log(`\n${failed ? "✗" : "✓"} selftest: ${pass} passed, ${failed} failed`);
if (process.env.HELP_CENTER_DEBUG) for (const f of failures) console.error(f.e);
process.exit(failed ? 1 : 0);
