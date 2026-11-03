// context.mjs — what both hooks and the CLI resolve before doing anything: the config, the
// state directory, the session key, the repository root, and whether a receipt exists.
//
// A receipt counts as present when either copy exists: the one in the repository
// (<root>/<receiptDir>/<key>.md) or the one in the state directory. Either alone lifts the deny,
// so a user who deletes the untracked repo copy, or whose state directory is wiped, is not
// blocked twice for one check.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./config.mjs";
import { paths, repoRoot, sessionKey, stateDir } from "./state.mjs";

/** The plugin's root directory: CLAUDE_PLUGIN_ROOT when the host set it, else this file's grandparent. */
export function pluginRoot(env = process.env) {
  const fromEnv = env.CLAUDE_PLUGIN_ROOT;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The CLI path as the hooks name it in their messages. */
export function cliPath(env = process.env) {
  return join(pluginRoot(env), "scripts", "pattern-check.mjs");
}

/** The exact command an agent runs to record the receipt for `key`. */
export function recordCommand(key, env = process.env) {
  return `node "${cliPath(env)}" record --session ${key}`;
}

/**
 * @param {{ session_id?: string, cwd?: string }} input a hook payload, or the CLI's equivalent
 * @param {{ env?: object, home?: string, session?: string }} opts `session` is an explicit key (the CLI's --session)
 */
export function resolveContext(input, opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cwd = typeof input?.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  const config = resolveConfig({ cwd, env, home });
  const base = stateDir(env, home);
  const root = repoRoot(cwd);
  const { key, degraded } = opts.session ? { key: opts.session, degraded: false } : sessionKey({ sessionId: input?.session_id, cwd });
  const receiptPath = join(root, config.receiptDir, `${key}.md`);
  const receiptCopy = paths.receiptCopy(base, key);
  const receiptExists = existsSync(receiptPath) || existsSync(receiptCopy);
  const warnings = [...config.faults];
  if (degraded) warnings.push(`no usable session_id was available, so this session is keyed by its working directory (${key}); two sessions in ${cwd} share one counter and one receipt`);
  return { env, home, cwd, config, base, root, key, degraded, receiptPath, receiptCopy, receiptExists, warnings };
}
