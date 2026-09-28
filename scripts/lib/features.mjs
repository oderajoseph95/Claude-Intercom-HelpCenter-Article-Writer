/**
 * features.mjs: what the product actually does, read from the user's repo.
 *
 * Two sources, the same ones the coverage gate uses:
 *   1. the COVERAGE MANIFEST (help-articles/coverage-manifest.mjs): FEATURES, optional shipped(),
 *      optional STRINGS; each feature may carry `keywords`, `strings` (key prefixes), `sources`
 *      and `area` (to group features under one collection).
 *   2. config `features.source`: a JSON file with `["id", ...]`, `{ shipped: [...] }` or
 *      `{ features: [{ id, label, keywords, area }] }`, used when there is no manifest yet.
 * Plus the UI STRINGS files (JSON, Rails YAML, gettext .po, Apple .strings, Android XML), which
 * are how an article is matched to a feature by the words a user actually sees.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tokens, stem } from "./text.mjs";
import { fail } from "./messages.mjs";

// ── strings ─────────────────────────────────────────────────────────────────────────────────
function flattenJson(obj, prefix = "", out = []) {
  if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) flattenJson(v, prefix ? `${prefix}.${k}` : k, out);
  else if (typeof obj === "string") out.push({ key: prefix, value: obj });
  return out;
}

/** Minimal YAML for locale files: nested `key:` maps with scalar values. */
function flattenYaml(text) {
  const out = [];
  const stack = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!raw.trim() || /^\s*#/.test(raw) || /^---/.test(raw)) continue;
    const m = /^(\s*)(["']?)([^"':]+)\2:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const value = m[4].trim();
    if (value === "" || value === "|" || value === ">") { stack.push({ indent, key: m[3].trim() }); continue; }
    out.push({ key: [...stack.map((s) => s.key), m[3].trim()].join("."), value: value.replace(/^["'](.*)["']$/, "$1") });
  }
  // Rails nests everything under the locale ("en.invoices.title"); drop that root so keys match
  // feature ids and prefixes the same way JSON keys do.
  const roots = new Set(out.map((e) => e.key.split(".")[0]));
  if (roots.size === 1 && /^[a-z]{2}([-_][A-Za-z]{2,4})?$/.test([...roots][0])) for (const e of out) e.key = e.key.split(".").slice(1).join(".");
  return out;
}

function parsePo(text) {
  const out = [];
  const re = /msgid\s+"((?:[^"\\]|\\.)*)"\s*\n\s*msgstr\s+"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text))) if (m[1]) out.push({ key: m[1], value: m[2] || m[1] });
  return out;
}
const parseAppleStrings = (text) => [...text.matchAll(/"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g)].map((m) => ({ key: m[1], value: m[2] }));
const parseAndroid = (text) => [...text.matchAll(/<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)].map((m) => ({ key: m[1], value: m[2].trim() }));

export function loadStrings(root, paths = [], warn = () => {}) {
  const all = [];
  for (const p of [].concat(paths ?? []).filter(Boolean)) {
    const abs = resolve(root, p);
    try {
      const text = readFileSync(abs, "utf8");
      let entries;
      if (/\.json$/i.test(p)) entries = flattenJson(JSON.parse(text));
      else if (/\.ya?ml$/i.test(p)) entries = flattenYaml(text);
      else if (/\.po$/i.test(p)) entries = parsePo(text);
      else if (/\.strings$/i.test(p)) entries = parseAppleStrings(text);
      else if (/\.xml$/i.test(p)) entries = parseAndroid(text);
      else throw new Error("unsupported format");
      for (const e of entries) all.push({ ...e, file: relative(root, abs).replace(/\\/g, "/") });
    } catch (e) {
      warn("IHC024", { path: p, detail: e.message });
    }
  }
  return all;
}

// ── features ────────────────────────────────────────────────────────────────────────────────
export async function loadManifest(root, manifestPath) {
  const abs = resolve(root, manifestPath);
  if (!existsSync(abs)) return null;
  try {
    return await import(pathToFileURL(abs).href + `?t=${Date.now()}`);
  } catch (e) {
    throw fail("IHC022", { path: manifestPath, detail: e.message });
  }
}

/**
 * @returns {{ features: Array, strings: Array, source: string|null }}
 * Each feature: { id, label, keywords:Set, sources, strings:[{key,value,file}], area, shipped, articlePaths }
 */
export async function discoverFeatures({ root, config, warn = () => {} }) {
  const mod = await loadManifest(root, config.manifest);
  let raw = {};
  let shippedIds = null;
  let source = null;
  let stringsPaths = [].concat(config.strings ?? []);

  if (mod) {
    source = config.manifest;
    raw = mod.FEATURES ?? {};
    if (typeof mod.shipped === "function") shippedIds = await mod.shipped({ root });
    if (mod.STRINGS) stringsPaths = [...new Set([...stringsPaths, ...[].concat(mod.STRINGS)])];
  } else if (config.features?.source && existsSync(resolve(root, config.features.source)) && /\.json$/i.test(config.features.source)) {
    source = config.features.source;
    const j = JSON.parse(readFileSync(resolve(root, config.features.source), "utf8"));
    const list = Array.isArray(j) ? j : j.features ?? j.shipped ?? [];
    for (const f of list) {
      const id = typeof f === "string" ? f : f.id;
      if (id) raw[id] = typeof f === "string" ? {} : f;
    }
    shippedIds = Object.keys(raw);
  }

  const strings = loadStrings(root, stringsPaths, warn);
  const ids = [...new Set([...Object.keys(raw), ...(shippedIds ?? [])])];
  const features = ids.map((id) => {
    const f = raw[id] ?? {};
    const label = f.label ?? id.replace(/[-_]+/g, " ");
    const prefixes = [].concat(f.strings ?? []);
    const idTokens = id.toLowerCase().split(/[-_.\s]+/).filter((t) => t.length > 2);
    const own = strings.filter((s) =>
      prefixes.length ? prefixes.some((p) => s.key === p || s.key.startsWith(p + ".")) : idTokens.some((t) => s.key.toLowerCase().split(/[._-]/).includes(t)),
    );
    const keywords = new Set([...tokens(label), ...idTokens.map(stem), ...[].concat(f.keywords ?? []).flatMap(tokens)]);
    const articlePaths = Object.values(f.kinds ?? {}).map((c) => c?.article).filter(Boolean);
    return {
      id,
      label,
      keywords,
      sources: [].concat(f.sources ?? []),
      strings: own,
      area: f.area ?? null,
      shipped: shippedIds ? shippedIds.includes(id) : true,
      inManifest: Boolean(raw[id] && mod),
      articlePaths: [...new Set(articlePaths)],
    };
  });
  return { features, strings, source, stringsPaths };
}

/**
 * Score how strongly an article is about a feature, from the words a user sees:
 *   +3  the feature's label appears as a phrase
 *   +2  per keyword in the title, +1 per keyword in the body (capped)
 *   +1  per UI string of the feature quoted verbatim in the body (capped at 4)
 * A score of 3 or more is a match.
 */
export function scoreFeature(article, feature) {
  const title = String(article.title ?? "");
  const text = String(article.text ?? "");
  const hay = `${title}\n${text}`.toLowerCase();
  const why = [];
  let score = 0;
  if (feature.label && feature.label.length > 3 && hay.includes(feature.label.toLowerCase())) { score += 3; why.push(`mentions "${feature.label}"`); }
  const tt = new Set(tokens(title));
  const bt = new Set(tokens(text));
  let kwTitle = 0, kwBody = 0;
  for (const k of feature.keywords) { if (tt.has(k)) kwTitle++; else if (bt.has(k)) kwBody++; }
  if (kwTitle) { score += 2 * kwTitle; why.push(`title shares ${kwTitle} keyword(s)`); }
  if (kwBody) { score += Math.min(kwBody, 3); why.push(`body shares ${kwBody} keyword(s)`); }
  let quoted = 0;
  const lowerText = text.toLowerCase();
  for (const s of feature.strings) if (s.value && s.value.length > 3 && lowerText.includes(s.value.toLowerCase())) quoted++;
  if (quoted) { score += Math.min(quoted, 4); why.push(`quotes ${quoted} UI string(s)`); }
  // Body words alone are too common to prove anything ("order", "edit"...). A match needs a
  // specific signal: the label as a phrase, a quoted UI string, two title keywords, or one title
  // keyword backed by two in the body.
  const specific = why[0]?.startsWith("mentions") || quoted > 0 || kwTitle >= 2 || (kwTitle >= 1 && kwBody >= 2);
  return { score: specific ? score : Math.min(score, 2), why };
}

export function matchFeatures(article, features, threshold = 3) {
  return features
    .map((f) => ({ id: f.id, ...scoreFeature(article, f) }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

export const repoRel = (root, p) => relative(root, resolve(root, p)).replace(/\\/g, "/");
export const joinRoot = (root, p) => join(root, p);
