/**
 * cli.mjs: argument parsing and the run-as-script wrapper every script uses.
 *
 * Every script exports `run(argv, deps)` returning an exit code, so the selftest can call it
 * in-process with a fake Intercom and a fake git. Run directly, `main()` maps errors to the
 * message catalog (code, cause, fix) instead of a stack trace.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, reportError } from "./messages.mjs";

/**
 * @param {string[]} argv
 * @param {{ flags?: string[], options?: string[], multi?: string[], help?: string }} spec
 */
export function parseArgs(argv, spec) {
  const flags = new Set();
  const opts = {};
  const positionals = [];
  const known = new Set([...(spec.flags ?? []), ...(spec.options ?? []), ...(spec.multi ?? []), "--help", "-h"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-") || a === "-") { positionals.push(a); continue; }
    const [name, inlineVal] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (!known.has(name)) throw fail("IHC091", { option: name });
    if (spec.options?.includes(name) || spec.multi?.includes(name)) {
      const v = inlineVal ?? argv[++i];
      if (v === undefined) throw fail("IHC091", { option: `${name} (needs a value)` });
      if (spec.multi?.includes(name)) (opts[name] ??= []).push(v);
      else opts[name] = v;
    } else flags.add(name === "-h" ? "--help" : name);
  }
  return { flag: (n) => flags.has(n), opt: (n, d) => opts[n] ?? d, multi: (n) => opts[n] ?? [], positionals, flags, opts };
}

export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

export function main(metaUrl, run) {
  if (!isMain(metaUrl)) return;
  const [maj] = process.versions.node.split(".").map(Number);
  if (maj < 18) { reportError(fail("IHC090", { version: process.versions.node })); process.exit(1); }
  Promise.resolve()
    .then(() => run(process.argv.slice(2)))
    .then((code) => process.exit(code ?? 0), (e) => { reportError(e); if (process.env.HELP_CENTER_DEBUG) console.error(e); process.exit(1); });
}

export const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
export const toPosix = (p) => String(p).replace(/\\/g, "/");
