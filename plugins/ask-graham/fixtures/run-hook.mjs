// Spawn a hook or CLI script the way Claude Code does: node <file>, payload on stdin, a fixed env.
// Every spawn has a 5 s budget; a process still running at 5 s is killed and the result says so
// (`timedOut`), so a hang fails the test instead of stalling the run.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PROMPT_HOOK = join(ROOT, "hooks", "ask-graham-hook.mjs");
export const STOP_HOOK = join(ROOT, "hooks", "ask-graham-stop.mjs");
export const INTENSITY_CLI = join(ROOT, "skills", "ask-graham", "scripts", "intensity.mjs");
export const BUDGET_MS = 5000;

/**
 * @param file   the script to run
 * @param input  a string as-is, an object as JSON, undefined for no stdin at all
 * @param env    the whole environment (PATH is added); HOME, XDG_* should be temp dirs
 */
export function spawnScript(file, { input, env = {}, args = [], cwd } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [file, ...args], {
    input: input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input),
    env: { PATH: process.env.PATH, ...env },
    cwd,
    encoding: "utf8",
    timeout: BUDGET_MS,
    killSignal: "SIGKILL",
  });
  return { ...r, ms: Date.now() - started, timedOut: r.error?.code === "ETIMEDOUT" };
}

/** stdout parsed as JSON, or null when the script printed nothing. */
export const reply = (r) => (r.stdout === "" ? null : JSON.parse(r.stdout));
