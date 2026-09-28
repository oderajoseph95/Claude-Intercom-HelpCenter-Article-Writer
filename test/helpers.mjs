import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..");

/** A temp copy of examples/ with an optional config. Removed by cleanup(). */
export function makeWork(config) {
  const work = mkdtempSync(join(tmpdir(), "ihc-test-"));
  cpSync(join(REPO, "examples"), work, { recursive: true, filter: (src) => !src.includes("sample-output") });
  if (config) writeJson(join(work, ".help-center/config.json"), config);
  return work;
}
export const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

export function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export const write = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };

/** Run fn with console captured; returns { result, out } where out is every printed line. */
export async function capture(fn) {
  const lines = [];
  const { log, error, warn } = console;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    let result;
    try { result = await fn(); }
    catch (e) { result = e; }
    return { result, out: lines.join("\n") };
  } finally {
    Object.assign(console, { log, error, warn });
  }
}

export function approvedPlan(work, file = ".help-center/help-center-plan.json") {
  writeJson(join(work, file), { kind: "correction-plan", approved: true, approved_by: "Test Reviewer", approved_at: new Date().toISOString(), items: [] });
}

export const noSleep = async () => {};
