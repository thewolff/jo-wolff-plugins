#!/usr/bin/env node
// hooks/session-start.mjs — the ctx-watch plugin's SessionStart hook. Runs under lib/hook-runner.mjs:
// exit 0 always; a fault is one errors.log line and a systemMessage, never a deny or block.
//
// What it does: one `check` (probe `ctx daemon status --format json` with CI removed; on a
// failing probe, `ctx index mode auto` and a second probe) and, when the last probe still fails,
// a systemMessage `ctx-watch: <reason>; fix: \`<command>\`` (one line, at most 160 characters).
// Then the dead-man's line: when the launchd tick has not stamped <state>/state.json in more than
// twice its interval (or, never ticked, since this hook first ran), `ctx-watch: timer has not run
// since <time>; run \`node <cli> install\` and the printed launchctl line`. Healthy and on time →
// nothing. No deny, no block: this hook only talks.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s (handle() runs on a worker
// thread; the runner's timer on the main thread fires whatever it is doing) → the runner logs it
// to ${XDG_STATE_HOME:-~/.local/state}/ctx-watch/errors.log and allows. Each ctx spawn here is
// bounded at 1.2 s so three of them fit the 4 s; a slower ctx is the runner's fail-open line.
// A state file that is missing or unreadable is "never ticked"; one that cannot be stamped
// (first-seen) is one errors.log line and a third message line naming the path: without the
// stamp the dead-man's switch cannot work, so the person needs to know.
//
// handle() runs on a worker thread, which is what makes the deadline hold. So: return the
// answer as a plain JSON-able object; never process.exit() or write to stdout; a child's
// environment goes on the spawn's env (the probe passes `env` with CI removed), not process.env.

import { runHook, invokedDirectly, logError } from "../lib/hook-runner.mjs";
import { check, needsYouLine, LINE_MAX } from "../lib/probe.mjs";
import { readState, writeState, statePath, timerOverdue } from "../lib/state.mjs";
import { CLI_PATH } from "../scripts/ctx-watch.mjs";

/** Per-spawn bound inside the hook: three spawns inside the runner's 4 s. */
export const HOOK_SPAWN_MS = 1_200;

/** The dead-man's line for a timer that is overdue since `since` (ms). */
export function timerLine(since, cliPath = CLI_PATH) {
  return `ctx-watch: timer has not run since ${new Date(since).toISOString()}; run \`node ${cliPath} install\` and the printed launchctl line`;
}

/** The line for a state file the hook could not stamp: without it the dead-man's switch cannot work. */
export function stampLine(file, err) {
  return `ctx-watch: state not written to ${file}: ${err?.message ?? err}`.slice(0, LINE_MAX);
}

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  { systemMessage } or null for "nothing to say"
 */
export function handle(input, { env = process.env, now = Date.now, run, exists, cliPath = CLI_PATH, timeoutMs = HOOK_SPAWN_MS } = {}) {
  void input;
  const lines = [];
  const result = check({ env, now, run, exists, timeoutMs });
  if (!result.ok) lines.push(needsYouLine(result));
  const file = statePath(env);
  const state = readState(file);
  const at = now();
  if (state.lastTickAt === null && state.firstSeenAt === null && !writeState(file, { ...state, firstSeenAt: at })) {
    const line = stampLine(file, writeState.lastError);
    logError("ctx-watch", "SessionStart", line.slice("ctx-watch: ".length), env);
    lines.push(line);
  }
  const t = timerOverdue(state, at);
  if (t.overdue) lines.push(timerLine(t.since, cliPath));
  return lines.length ? { systemMessage: lines.join("\n") } : null;
}

if (invokedDirectly(import.meta.url)) runHook("SessionStart", import.meta.url, { plugin: "ctx-watch", quiet: false });
