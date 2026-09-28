/**
 * config.mjs: `.help-center/config.json`, the one place a decision is saved once.
 *
 * It is committed to the user's repo, so it NEVER holds a secret. The token lives only in the
 * INTERCOM_API_TOKEN environment variable. `saveConfig` refuses to write anything that looks
 * like a token.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fail } from "./messages.mjs";

export const CONFIG_PATH = ".help-center/config.json";

export const DEFAULTS = Object.freeze({
  version: 1,
  articlesDir: "help-articles/articles",
  manifest: "help-articles/coverage-manifest.mjs",
  features: { source: null, kind: null },
  strings: [],
  outDir: ".help-center",
  collectionMap: {},
  publish: { cap: 20, requireApprovedPlan: true },
  planFile: ".help-center/help-center-plan.json",
  snapshot: { maxAgeHours: 24 },
  intercom: { region: "us", apiVersion: "2.11", authorId: null, workspace: null, workspaceName: null },
  pr: { base: null, baseEvidence: [], branchPrefix: "help-center/", draft: true, reviewers: [], labels: [], remote: "origin" },
  audit: {
    minWords: 80,
    staleDays: 365,
    nearDuplicate: 0.6,
    standardCollections: ["Getting started", "Billing", "Troubleshooting"],
  },
  hooks: { enabled: true, staleReminder: true, publishGuard: true, secretGuard: true },
});

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
export function deepMerge(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over ?? {})) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

/** Walk up from `start` to the folder holding .help-center/config.json (monorepos), else start. */
export function findRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_PATH))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

export function loadConfig(root = findRoot()) {
  const path = join(root, CONFIG_PATH);
  if (!existsSync(path)) return { config: structuredClone(DEFAULTS), path, exists: false, root };
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw fail("IHC010", { path, detail: e.message }); }
  return { config: deepMerge(DEFAULTS, raw), path, exists: true, root };
}

const TOKEN_SHAPES = [/dG9rO[A-Za-z0-9+/=_-]{20,}/, /\b(Bearer\s+)[A-Za-z0-9._=-]{20,}/];
export function looksLikeSecret(text, token = process.env.INTERCOM_API_TOKEN) {
  const s = String(text ?? "");
  if (token && token.length >= 12 && s.includes(token)) return true;
  return TOKEN_SHAPES.some((re) => re.test(s)) || /INTERCOM_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{20,}/.test(s);
}

export function saveConfig(root, config) {
  const path = join(root, CONFIG_PATH);
  const text = JSON.stringify(config, null, 2) + "\n";
  if (looksLikeSecret(text)) throw fail("IHC011", { path });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  ensureGitignore(root, config.outDir);
  return path;
}

/** Local working files that must never be committed (the snapshot holds every article body, drafts included). */
export const LOCAL_ONLY = ["snapshot.json", "session-*.json", "journal.json", "pr-body.md"];

export function ensureGitignore(root, outDir = ".help-center") {
  const dir = resolve(root, outDir);
  const ignore = join(dir, ".gitignore");
  if (existsSync(ignore)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(ignore, ["# Written by intercom-help-center. config.json and the plans are committed; these are local working files.", ...LOCAL_ONLY, ""].join("\n"));
}

/** Resolve a repo-relative path from config against the root. */
export const at = (root, p) => resolve(root, p);
