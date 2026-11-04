#!/usr/bin/env node
// hooks/session-start.mjs — brb's SessionStart hook. Runs under lib/hook-runner.mjs: exit 0
// always; a fault is one errors.log line and a systemMessage, never a block.
//
// What it does: when the session's away.json exists (a resume, a clear or a compaction while
// Jo is away), the away instruction (rendered with this session's hold command) goes to the
// agent as additionalContext and one line goes to
// the person: `brb: away since <since>; N held`. Home → null, nothing printed.
//
// OMP calls this same file before each agent turn (omp/brb-omp.ts) and delivers the
// additionalContext as a hidden message, so the instruction reaches the agent there too.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// ${XDG_STATE_HOME:-~/.local/state}/brb/errors.log and the session starts without the context.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { readAway } from "../lib/state.mjs";
import { awayInstruction, holdCommand } from "../lib/text.mjs";

/**
 * @param {object} input  the SessionStart payload; session_id is read
 * @returns {object|null}
 */
export function handle(input, { env = process.env } = {}) {
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  const away = readAway(sessionId, env);
  if (!away) return null;
  return {
    systemMessage: `brb: away since ${away.since}; ${away.held} held. Type \`back\` to read them.`,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: awayInstruction(away, holdCommand(sessionId)) },
  };
}

if (invokedDirectly(import.meta.url)) runHook("SessionStart", import.meta.url, { plugin: "brb", quiet: false });
