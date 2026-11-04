// receipt.mjs — gate 2: does this session have a pattern-check receipt?
//
// THE RULE, copied from the pattern-check plugin (0.3.1) rather than imported from it, since
// an installed plugin never depends on a sibling being installed:
//   scripts/lib/state.mjs   repoRoot(cwd): the nearest ancestor of cwd (inclusive) holding `.git`
//                           sessionKey: session_id when it matches /^[A-Za-z0-9][A-Za-z0-9._-]*$/
//                           and is at most 128 chars; else `cwd-<sha256(cwd) first 16 hex>`
//   scripts/lib/context.mjs receipt = <root>/.pattern-check/<key>.md, or the copy at
//                           ${XDG_STATE_HOME:-~/.local/state}/pattern-check/receipts/<key>.md;
//                           either alone counts
//   scripts/pattern-check.mjs `open "<what>"` starts the receipt, `record --session <key>` writes it
// pattern-check's `receiptDir` config (a `.pattern-check.json`) is not read here: a repository
// that moved its receipts elsewhere needs `requirePatternCheck: false` in this plugin's config.
//
// NOT IN A GIT REPOSITORY (no `.git` on the walk up from cwd): the check is skipped, and the
// caller logs one skipped.log line. A session id that is unusable is keyed the way pattern-check
// keys it, so the two plugins agree on which file to look for.
//
// THE COMMAND the deny names is pattern-check's own CLI. Its root is found, in order: the
// sibling checkout (`<this plugin>/../pattern-check`), then the newest version in the Claude
// Code plugin cache beside this plugin (`<cache>/<marketplace>/pattern-check/<version>/`).
// Neither found: the command names `<pattern-check plugin root>` and the install line.

import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const RECEIPT_DIR = ".pattern-check";

/** The nearest ancestor of `cwd` (inclusive) holding `.git`, else null. */
export function gitRoot(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** pattern-check's session key for a hook payload. */
export function sessionKey(sessionId, cwd) {
  if (typeof sessionId === "string" && SAFE_ID.test(sessionId) && sessionId.length <= 128) return { key: sessionId, degraded: false };
  return { key: `cwd-${createHash("sha256").update(resolve(cwd), "utf8").digest("hex").slice(0, 16)}`, degraded: true };
}

function patternCheckStateDir(env, home) {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME || home, ".local", "state");
  return join(base, "pattern-check");
}

/** This plugin's root: CLAUDE_PLUGIN_ROOT when the host set it, else this file's grandparent. */
export function pluginRoot(env = process.env) {
  if (typeof env.CLAUDE_PLUGIN_ROOT === "string" && env.CLAUDE_PLUGIN_ROOT !== "") return env.CLAUDE_PLUGIN_ROOT;
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** The pattern-check CLI path, or null when no install is found. */
export function patternCheckCli(env = process.env) {
  const root = pluginRoot(env);
  const sibling = join(dirname(root), "pattern-check", "scripts", "pattern-check.mjs");
  if (existsSync(sibling)) return sibling;
  // Cache layout: <cache>/<marketplace>/<plugin>/<version>/; this plugin is two levels under the marketplace dir.
  const cacheDir = join(dirname(dirname(root)), "pattern-check");
  try {
    const versions = readdirSync(cacheDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
    for (const v of versions) {
      const cli = join(cacheDir, v, "scripts", "pattern-check.mjs");
      if (existsSync(cli)) return cli;
    }
  } catch {
    // no cache beside us
  }
  return null;
}

/** The two commands that produce a receipt for `key`. */
export function receiptCommand(key, env = process.env) {
  const cli = patternCheckCli(env);
  const node = cli ? `node "${cli}"` : `node "<pattern-check plugin root>/scripts/pattern-check.mjs"`;
  const install = cli ? "" : " (install pattern-check@jo-wolff-plugins first)";
  return `${node} open "<what you are about to build>" then ${node} record --session ${key} with --row "..." or --no-new-pieces "<reason>"${install}`;
}

/**
 * @returns {{ status: "present"|"missing"|"skipped", why?: string, path?: string, key?: string, command?: string }}
 */
export function checkReceipt({ sessionId, cwd }, env = process.env, home = homedir()) {
  if (typeof cwd !== "string" || cwd === "") return { status: "skipped", why: "the payload has no cwd" };
  const root = gitRoot(cwd);
  if (!root) return { status: "skipped", why: `${cwd} is in no git repository` };
  const { key } = sessionKey(sessionId, cwd);
  const path = join(root, RECEIPT_DIR, `${key}.md`);
  const copy = join(patternCheckStateDir(env, home), "receipts", `${key}.md`);
  if (existsSync(path) || existsSync(copy)) return { status: "present", path, key };
  return { status: "missing", path, key, command: receiptCommand(key, env) };
}

/** The deny reason for gate 2. */
export function receiptReason(subagentType, result) {
  const type = String(subagentType ?? "general-purpose").trim() || "general-purpose";
  return `Spawn refused: builder-class "${type}" needs a pattern-check receipt for this session, and none exists at ${result.path}. Run: ${result.command}. Then re-issue this spawn.`;
}
