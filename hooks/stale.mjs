#!/usr/bin/env node
/**
 * stale.mjs: the stale-article reminder.
 *
 *   post  (PostToolUse on Write/Edit/MultiEdit) when the edited file is listed in any article's
 *         `sources:`, tell Claude which articles may now be stale (once per article per session)
 *         and remember them for this session.
 *   stop  (Stop) if anything was remembered this session, show one line to the user:
 *         "N help article(s) describe code you changed... run /intercom-help-center:audit".
 *         It never blocks stopping.
 *
 * Fast (walks only the articles folder), fail-safe (any error = silent exit 0), and switchable:
 * HELP_CENTER_HOOKS=off, hooks.enabled / hooks.staleReminder = false in .help-center/config.json.
 */
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadConfig, findRoot } from "../scripts/lib/config.mjs";
import { walkArticles, loadArticles } from "../scripts/lib/articles.mjs";
import { msg } from "../scripts/lib/messages.mjs";
import { isMain, toPosix } from "../scripts/lib/cli.mjs";

const sessionFile = (root, config, id) => join(resolve(root, config.outDir), `session-${String(id || "default").replace(/[^\w-]/g, "")}.json`);

export function onPost(input, { env = process.env } = {}) {
  if (String(env.HELP_CENTER_HOOKS ?? "").toLowerCase() === "off") return null;
  const file = input.tool_input?.file_path;
  if (!file) return null;
  const root = findRoot(input.cwd || process.cwd());
  const { config, exists } = loadConfig(root);
  if (!exists || config.hooks?.enabled === false || config.hooks?.staleReminder === false) return null;
  const rel = toPosix(relative(root, resolve(input.cwd || root, file)));
  const articlesDir = toPosix(config.articlesDir).replace(/\/$/, "");
  if (rel.startsWith(articlesDir + "/") || rel.startsWith(".help-center/")) return null;
  const hits = loadArticles(walkArticles(resolve(root, config.articlesDir)))
    .filter((a) => Array.isArray(a.fm?.sources) && a.fm.sources.some((s) => toPosix(s) === rel))
    .map((a) => toPosix(relative(root, a.path)));
  if (!hits.length) return null;
  const path = sessionFile(root, config, input.session_id);
  const seen = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { articles: [] };
  const fresh = hits.filter((h) => !seen.articles.includes(h));
  if (!fresh.length) return null;
  seen.articles.push(...fresh);
  mkdirSync(resolve(root, config.outDir), { recursive: true });
  writeFileSync(path, JSON.stringify(seen));
  return msg("IHC083", { count: fresh.length, articles: fresh.join(", ") });
}

export function onStop(input, { env = process.env } = {}) {
  if (String(env.HELP_CENTER_HOOKS ?? "").toLowerCase() === "off") return null;
  const root = findRoot(input.cwd || process.cwd());
  const { config, exists } = loadConfig(root);
  if (!exists || config.hooks?.enabled === false || config.hooks?.staleReminder === false) return null;
  const path = sessionFile(root, config, input.session_id);
  if (!existsSync(path)) return null;
  const { articles = [] } = JSON.parse(readFileSync(path, "utf8"));
  rmSync(path, { force: true });
  if (!articles.length) return null;
  return msg("IHC083", { count: articles.length, articles: articles.slice(0, 5).join(", ") + (articles.length > 5 ? ", ..." : "") });
}

if (isMain(import.meta.url)) {
  try {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    const input = JSON.parse(data || "{}");
    if (process.argv[2] === "stop") {
      const m = onStop(input);
      if (m) process.stdout.write(JSON.stringify({ systemMessage: m }));
    } else {
      const m = onPost(input);
      if (m) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: m } }));
    }
  } catch {
    // fail-safe: a reminder must never break the session
  }
  process.exit(0);
}
