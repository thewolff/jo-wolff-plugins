#!/usr/bin/env node
// hooks/session-start.mjs — the ctx-watch plugin's SessionStart hook. Runs under lib/hook-runner.mjs:
// exit 0 always; a fault is one errors.log line and a systemMessage, never a deny or block.
//
// What it does: one `check` without the heal (probe `ctx daemon status --format json` with CI
// removed; on a failing probe, read the upgrade gate: `ctx upgrade status --format json` and the
// handoff marker) and, when the probe fails, a systemMessage `ctx-watch: <reason>; fix:
// \`<command>\`` (one line, at most 160 characters). The heal (`ctx index mode auto`) does not
// run here: ctx's own handoff waits up to 75 s for installation quiescence, a hook has 4 s, and a
// heal killed at its bound is the likeliest writer of the supervisor environment without LANG
// found on 2026-11-11. The timer heals; an agent runs `ctx-watch repair`.
// When ctx is down, stuck in an upgrade, or mid-upgrade, the answer also carries
// hookSpecificOutput.additionalContext (agentContext): one short block for the agent naming what
// is down, since when, and the exact command it may run or hand over. Healthy, or only the
// semantic index not ready (the daemon is up; the systemMessage covers it): no context. Every
// outage it tells the agent about (down, stuck, ctx missing; not a live upgrade, which is not an
// outage to repair) is recorded in the session's latch (lib/mid-session.mjs noteTold), with the
// timer's downSince when the timer has declared it and null when only this hook's own probe saw
// it, so the mid-session hook does not repeat it, adopts the timer's episode when it is declared,
// and still says when ctx is back; a latch it cannot write is one errors.log line.
// Then the dead-man's line: when the launchd tick has not stamped <state>/state.json in more than
// twice its interval (or, never ticked, since this hook first ran), `ctx-watch: timer has not run
// since <time>; run \`node <cli> install\` and the printed launchctl line` (as long as the
// plugin's path makes it: a truncated path is not a command). Healthy and on time → nothing.
// No deny, no block: this hook only talks. First of all, when the payload's `source` is `resume`,
// `compact` or `fork`, it leaves <state>/resume/<session_id> holding the time the hook started
// (before the probe, which can take up to 3 s: a prompt typed meanwhile is inside the window),
// for the Stop hook's consult-history check (lib/consult-history.mjs); a marker that cannot be
// written is one errors.log line and nothing else (the check then has nothing to consume). The
// flag file ~/.claude/.ctx-watch-off does not reach this hook: it turns off the Stop check only.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s (handle() runs on a worker
// thread; the runner's timer on the main thread fires whatever it is doing) → the runner logs it
// to ${XDG_STATE_HOME:-~/.local/state}/ctx-watch/errors.log and allows. The check inside runs on
// one 3 s clock (HOOK_DEADLINE_MS) shared by its two read-only ctx spawns, each also bounded at
// 1.2 s (HOOK_SPAWN_MS; `ctx upgrade status` took 0.85 s on 2026-11-11): a step with no time
// left is skipped and the line says `ctx-watch: check timed out after 3000 ms (…)`, so a slow ctx
// is this hook's own line inside the runner's 4 s, not the runner's fail-open line and not
// silence. A `ctx upgrade status` that does not answer leaves the handoff marker (a file read,
// no spawn) to say whether an upgrade is live. A state file that is missing or unreadable is
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
import { check, needsYouLine, LINE_MAX, CTX, FIX_MISSING } from "../lib/probe.mjs";
import { readState, writeState, statePath, timerOverdue, withStateLock, failureKind } from "../lib/state.mjs";
import { isResume, markResumed } from "../lib/consult-history.mjs";
import { noteTold } from "../lib/mid-session.mjs";
import { dirname } from "node:path";
import { shellQuote } from "../lib/launchd.mjs";
import { CLI_PATH } from "../scripts/ctx-watch.mjs";

/** Per-spawn bound inside the hook (read-only spawns only: the hook never heals). */
export const HOOK_SPAWN_MS = 1_200;
/** The whole check's clock (probe, upgrade gate): inside the runner's 4 s with room for the stamp. */
export const HOOK_DEADLINE_MS = 3_000;
/** How long the first-seen stamp waits for a tick holding the state lock (the runner's 4 s leaves room). */
export const HOOK_LOCK_WAIT_MS = 200;
/** The longest reason the agent's block quotes. */
const CONTEXT_REASON_MAX = 240;

/** The dead-man's line for a timer that is overdue since `since` (ms); the path is quoted for the shell, and not cut. */
export function timerLine(since, cliPath = CLI_PATH) {
  return `ctx-watch: timer has not run since ${new Date(since).toISOString()}; run \`node ${shellQuote(cliPath)} install\` and the printed launchctl line`;
}

/** The line for a state file the hook could not stamp: without it the dead-man's switch cannot work. */
export function stampLine(file, err) {
  return `ctx-watch: state not written to ${file}: ${err?.message ?? err}`.slice(0, LINE_MAX);
}

/**
 * The agent's block for a failing check, or null when the agent needs nothing: ctx healthy, or
 * only the semantic index not ready. `since` (ms) is when the outage started: the timer's
 * downSince when it has one, else this probe.
 */
export function agentContext(result, since, cliPath = CLI_PATH) {
  if (result.ok) return null;
  const upgrading = result.upgrading === true;
  const kind = failureKind(result);
  if (!upgrading && kind === "semantic") return null;
  const reason = result.reason.length > CONTEXT_REASON_MAX ? `${result.reason.slice(0, CONTEXT_REASON_MAX - 1)}…` : result.reason;
  const repair = `node ${shellQuote(cliPath)} repair`;
  const when = `since ${new Date(since).toISOString()}`;
  if (result.fix === FIX_MISSING) {
    return [
      `ctx-watch: ctx could not run ${when} (${reason}); ctx search and history are unavailable.`,
      "ctx-watch cannot repair a missing ctx: hand the person `ctx docs show getting-started`.",
    ].join("\n");
  }
  if (upgrading) {
    return [
      `ctx-watch: a ctx upgrade is in progress (${reason}). The ctx history daemon reads not running until it finishes; ctx search and history may fail meanwhile.`,
      `Do not run \`ctx index mode auto\` or \`${repair}\` now: either would fight the upgrade. Check again with \`ctx upgrade status --format json\`; if it holds the same state over 30 min with its owner process gone, ctx-watch reports it as stuck.`,
    ].join("\n");
  }
  if (kind === "upgrade") {
    return [
      `ctx-watch: ctx's upgrade is stuck ${when} (${reason}); ctx search and history are down until it is released.`,
      `Repair: \`${repair}\` (exit 0 = repaired; it refuses while an upgrade owner is alive or its handoff marker is under 15 min old, and pauses and restores the ctx-watch timer).`,
      `By hand, from a shell with LANG set and CI unset: \`${result.fix}\`. The \`ctx upgrade --dry-run\` release was observed to work on 2026-11-11 and is not documented by ctx; do not run it while an upgrade owner process is alive.`,
    ].join("\n");
  }
  return [
    `ctx-watch: the ctx daemon is not running ${when} (${reason}); ctx search and history are down or stale.`,
    `Repair: \`${repair}\` (exit 0 = repaired; it refuses during a live ctx upgrade, and pauses and restores the ctx-watch timer).`,
    "By hand: `ctx index mode auto`, from a shell with LANG set and CI unset (`env -u CI`; with CI set ctx turns its daemon off). If either fails, hand the person its last line.",
  ].join("\n");
}

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  { systemMessage, hookSpecificOutput? } or null for "nothing to say"
 */
export function handle(input, { env = process.env, now = Date.now, run, exists, cliPath = CLI_PATH, timeoutMs = HOOK_SPAWN_MS, deadlineMs = HOOK_DEADLINE_MS } = {}) {
  const lines = [];
  const file = statePath(env);
  if (isResume(input.source) && typeof input.session_id === "string" && input.session_id.trim()) {
    const err = markResumed(dirname(file), input.session_id.trim(), now());
    if (err) logError("ctx-watch", "SessionStart", `resume marker for ${input.session_id.trim()} not written (${err.message}); consult-history will not check this resume`, env);
  }
  const result = check({ env, now, run, exists, timeoutMs, deadlineMs, heal: false, ctx: typeof env.CTX_WATCH_CTX === "string" && env.CTX_WATCH_CTX ? env.CTX_WATCH_CTX : CTX });
  if (!result.ok) lines.push(needsYouLine(result));
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
  if (!lines.length) return null;
  const context = agentContext(result, (state.episode === "down" ? state.downSince : null) ?? result.at ?? at, cliPath);
  const id = typeof input.session_id === "string" ? input.session_id.trim() : "";
  if (context && id && result.upgrading !== true) {
    const err = noteTold(dirname(file), id, { down: state.episode === "down" && state.episodeKind !== "semantic" ? state.downSince : null, toldAt: at });
    if (err) logError("ctx-watch", "SessionStart", `mid-session latch for ${id} not written (${err.message}); the first prompt will repeat this`, env);
  }
  return context ? { systemMessage: lines.join("\n"), hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } } : { systemMessage: lines.join("\n") };
}

if (invokedDirectly(import.meta.url)) runHook("SessionStart", import.meta.url, { plugin: "ctx-watch", quiet: false });
