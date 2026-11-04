#!/usr/bin/env node
// hooks/session-start.mjs — the ctx-watch plugin's SessionStart hook. Runs under lib/hook-runner.mjs:
// exit 0 always; a fault is one errors.log line and a systemMessage, never a deny or block.
//
// What it does: one `check` (probe `ctx daemon status --format json` with CI removed; on a
// failing probe, `ctx index mode auto` and a second probe) and, when the last probe still fails,
// a systemMessage `ctx-watch: <reason>; fix: \`<command>\`` (one line, at most 160 characters).
// Then the dead-man's line: when the launchd tick has not stamped <state>/state.json in more than
// twice its interval (or, never ticked, since this hook first ran), `ctx-watch: timer has not run
// since <time>; run \`node <cli> install\` and the printed launchctl line` (as long as the
// plugin's path makes it: a truncated path is not a command). Healthy and on time → nothing.
// No deny, no block: this hook only talks. Last, when the payload's `source` is `resume` or
// `compact`, it leaves <state>/resume/<session_id> holding the time, for the Stop hook's
// consult-history check (lib/consult-history.mjs); a marker that cannot be written is one
// errors.log line and nothing else (the check then has nothing to consume).
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s (handle() runs on a worker
// thread; the runner's timer on the main thread fires whatever it is doing) → the runner logs it
// to ${XDG_STATE_HOME:-~/.local/state}/ctx-watch/errors.log and allows. The check inside runs on
// one 3 s clock (HOOK_DEADLINE_MS) shared by its up-to-four ctx spawns, each also bounded at
// 1.2 s (HOOK_SPAWN_MS): a step with no time left is skipped and the line says `ctx-watch: check
// timed out after 3000 ms (…)`, so a slow ctx is this hook's own line inside the runner's 4 s,
// not the runner's fail-open line and not silence. A state file that is missing or unreadable is
// "never ticked"; one that cannot be stamped (first-seen) is one errors.log line and a third
// message line naming the path: without the stamp the dead-man's switch cannot work, so the
// person needs to know.
// `CTX_WATCH_CTX` in the environment (an absolute path) is the ctx binary to spawn instead of
// `ctx` from PATH: the evals sandbox points it at a fake that prints a fixture, so no scenario
// starts a real daemon under its empty HOME.
//
// handle() runs on a worker thread, which is what makes the deadline hold. So: return the
// answer as a plain JSON-able object; never process.exit() or write to stdout; a child's
// environment goes on the spawn's env (the probe passes `env` with CI removed), not process.env.

import { runHook, invokedDirectly, logError } from "../lib/hook-runner.mjs";
import { check, needsYouLine, LINE_MAX, CTX } from "../lib/probe.mjs";
import { readState, writeState, statePath, timerOverdue, withStateLock } from "../lib/state.mjs";
import { isResume, markResumed } from "../lib/consult-history.mjs";
import { dirname } from "node:path";
import { shellQuote } from "../lib/launchd.mjs";
import { CLI_PATH } from "../scripts/ctx-watch.mjs";

/** Per-spawn bound inside the hook. */
export const HOOK_SPAWN_MS = 1_200;
/** The whole check's clock (probe, heal, re-probe): inside the runner's 4 s with room for the stamp. */
export const HOOK_DEADLINE_MS = 3_000;
/** How long the first-seen stamp waits for a tick holding the state lock (the runner's 4 s leaves room). */
export const HOOK_LOCK_WAIT_MS = 200;

/** The dead-man's line for a timer that is overdue since `since` (ms); the path is quoted for the shell, and not cut. */
export function timerLine(since, cliPath = CLI_PATH) {
  return `ctx-watch: timer has not run since ${new Date(since).toISOString()}; run \`node ${shellQuote(cliPath)} install\` and the printed launchctl line`;
}

/** The line for a state file the hook could not stamp: without it the dead-man's switch cannot work. */
export function stampLine(file, err) {
  return `ctx-watch: state not written to ${file}: ${err?.message ?? err}`.slice(0, LINE_MAX);
}

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  { systemMessage } or null for "nothing to say"
 */
export function handle(input, { env = process.env, now = Date.now, run, exists, cliPath = CLI_PATH, timeoutMs = HOOK_SPAWN_MS, deadlineMs = HOOK_DEADLINE_MS } = {}) {
  const lines = [];
  const result = check({ env, now, run, exists, timeoutMs, deadlineMs, ctx: typeof env.CTX_WATCH_CTX === "string" && env.CTX_WATCH_CTX ? env.CTX_WATCH_CTX : CTX });
  if (!result.ok) lines.push(needsYouLine(result));
  const file = statePath(env);
  const state = readState(file);
  const at = now();
  if (state.lastTickAt === null && state.firstSeenAt === null) {
    // Re-read under the lock (quietly: the read above already logged a bad file): a tick that
    // landed meanwhile has stamped it, and its popup claim must not be overwritten.
    const r = withStateLock(dirname(file), () => {
      const cur = readState(file, { log: () => {} });
      if (cur.lastTickAt !== null || cur.firstSeenAt !== null) return true;
      return writeState(file, { ...cur, firstSeenAt: at }) || writeState.lastError;
    }, { waitMs: HOOK_LOCK_WAIT_MS });
    const err = !r.ok ? r.error : r.value === true ? null : r.value;
    if (err) {
      const line = stampLine(file, err);
      logError("ctx-watch", "SessionStart", line.slice("ctx-watch: ".length), env);
      lines.push(line);
    }
  }
  const t = timerOverdue(state, at);
  if (t.overdue) lines.push(timerLine(t.since, cliPath));
  if (isResume(input.source) && typeof input.session_id === "string" && input.session_id.trim()) {
    const err = markResumed(dirname(file), input.session_id.trim(), at);
    if (err) logError("ctx-watch", "SessionStart", `resume marker for ${input.session_id.trim()} not written (${err.message}); consult-history will not check this resume`, env);
  }
  return lines.length ? { systemMessage: lines.join("\n") } : null;
}

if (invokedDirectly(import.meta.url)) runHook("SessionStart", import.meta.url, { plugin: "ctx-watch", quiet: false });
