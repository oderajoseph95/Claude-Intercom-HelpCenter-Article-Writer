#!/usr/bin/env node
/**
 * guard.mjs: PreToolUse hook. Two guards, each fast and each switchable.
 *
 *   publishGuard  blocks `publish.mjs --publish` unless the plan it would apply is approved
 *                 (approved: true + approved_by), and blocks a --max above publish.cap.
 *                 So an agent cannot mass-publish, or raise its own cap.
 *   secretGuard   blocks a Write/Edit whose content contains an Intercom token, and a shell command
 *                 that writes INTERCOM_API_TOKEN into a file.
 *
 * FAIL-SAFE: if the hook itself breaks (bad input, unreadable config), it allows the tool call and
 * never blocks your session. The publisher enforces the same plan and cap rules itself, so the
 * rule still holds when the hook is off.
 *
 * OFF SWITCHES: HELP_CENTER_HOOKS=off · .help-center/config.json hooks.enabled / hooks.publishGuard /
 * hooks.secretGuard = false · or disable the plugin.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, findRoot, looksLikeSecret } from "../scripts/lib/config.mjs";
import { msg } from "../scripts/lib/messages.mjs";
import { isMain } from "../scripts/lib/cli.mjs";

export function decide(input, { env = process.env } = {}) {
  if (String(env.HELP_CENTER_HOOKS ?? "").toLowerCase() === "off") return null;
  const cwd = input.cwd || process.cwd();
  const root = findRoot(cwd);
  const { config } = loadConfig(root);
  if (config.hooks?.enabled === false) return null;
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};

  if (tool === "Bash") {
    const cmd = String(ti.command ?? "");
    if (config.hooks?.secretGuard !== false) {
      const writesToken = /INTERCOM_API_TOKEN/.test(cmd) && /(>>?|\btee\b)/.test(cmd) && /(echo|printf|cat|env|printenv|set)\b/.test(cmd);
      const token = env.INTERCOM_API_TOKEN;
      const inlineToken = token && token.length >= 12 && cmd.includes(token) && /(>>?|\btee\b)/.test(cmd);
      if (writesToken || inlineToken) return msg("IHC082", { file: "a file (shell redirect)" });
    }
    if (config.hooks?.publishGuard !== false && /publish\.mjs/.test(cmd) && /--publish\b/.test(cmd)) {
      const planArg = /--plan(?:=|\s+)("[^"]+"|'[^']+'|\S+)/.exec(cmd)?.[1]?.replace(/^["']|["']$/g, "");
      if (planArg || config.publish?.requireApprovedPlan !== false) {
        const planPath = resolve(root, planArg ?? config.planFile);
        let approved = false;
        if (existsSync(planPath)) {
          try { const p = JSON.parse(readFileSync(planPath, "utf8")); approved = p.approved === true && Boolean(p.approved_by); } catch { approved = false; }
        }
        if (!approved) return msg("IHC080", { path: planArg ?? config.planFile });
      }
      const max = /--max(?:=|\s+)(\d+)/.exec(cmd)?.[1];
      if (max && Number(max) > Number(config.publish?.cap ?? 20)) return msg("IHC081", { max, cap: config.publish?.cap ?? 20 });
    }
    return null;
  }

  if (config.hooks?.secretGuard !== false && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const content = [ti.content, ti.new_string, ti.new_source, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string) : [])].filter(Boolean).join("\n");
    if (content && looksLikeSecret(content, env.INTERCOM_API_TOKEN)) return msg("IHC082", { file: ti.file_path ?? ti.notebook_path ?? "a file" });
  }
  return null;
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (isMain(import.meta.url)) {
  try {
    const input = JSON.parse((await readStdin()) || "{}");
    const reason = decide(input);
    if (reason) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
    }
  } catch {
    // fail-safe: never block a session because the guard itself failed
  }
  process.exit(0);
}
