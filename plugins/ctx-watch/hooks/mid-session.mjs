#!/usr/bin/env node
// hooks/mid-session.mjs — the ctx-watch plugin's mid-session hook (0.4.0), registered twice in
// hooks/hooks.json: on UserPromptSubmit (every prompt) and on PostToolUseFailure of a ctx call
// (a Bash `ctx …` command, or a `mcp__ctx__*` tool), the event name passed as its one argument.
// Runs under lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a
// systemMessage, never a block.
//
// Why: ctx dies in the middle of sessions (2026-11-04, three times in an afternoon; 2026-11-05 for
// six days; 2026-11-11), and until 0.4.0 an agent heard about it only at SessionStart. This hook
// tells it mid-session, once per episode, from the state the launchd timer already keeps
// (lib/mid-session.mjs): it spawns no ctx and no launchctl, so a healthy prompt costs one node
// start and two small file reads, and prints nothing. What it can say, each at most once per
// session per episode: ctx is down (or its upgrade is stuck, or its upgrade state is unknown)
// since when, with `/ctx-watch:repair`; ctx is back (one line); the timer has not stamped its
// state in over 15 min, so the state cannot be trusted (one line). The answer is
// hookSpecificOutput.additionalContext only: the person already has the popup and the
// SessionStart line.
//
// The PostToolUseFailure registration is for long autonomous turns, where the next prompt may be
// an hour away: a ctx call that failed is when the agent most needs to know, and it shares the
// prompt hook's latch, so an agent told there is not told again at the next prompt. It does not
// judge the error text (ctx's messages for a dead daemon are not a contract); it relays the
// timer's state, and says nothing when that state is healthy and fresh.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { EVENTS, CLI_PATH, midSession } from "../lib/mid-session.mjs";

export { latchPath } from "../lib/mid-session.mjs";

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  { hookSpecificOutput: { hookEventName, additionalContext } } or null
 */
export function handle(input, { env = process.env, now = Date.now, cliPath = CLI_PATH } = {}) {
  return midSession(input, { env, now, cliPath });
}

if (invokedDirectly(import.meta.url)) runHook(EVENTS.includes(process.argv[2]) ? process.argv[2] : EVENTS[0], import.meta.url, { plugin: "ctx-watch", quiet: false });
