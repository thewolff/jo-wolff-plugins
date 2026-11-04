#!/usr/bin/env node
// hooks/user-prompt-submit.mjs — brb's UserPromptSubmit hook. Runs under lib/hook-runner.mjs:
// exit 0 always; a fault is one errors.log line and a systemMessage, never a block for its own
// fault.
//
// What it does: the whole prompt is one of three words, or it is not.
//   `brb` (or `brb <note>`)  start the hold: write away.json, block the prompt (no turn) with the
//                            confirmation as the reason and the prompt text suppressed.
//   `back`                   archive the digest to archive/<ts>.md, clear away.json, and print
//                            `brb: hold cleared; digest archived to <path>.` as the block reason's
//                            first line with the digest under it. No turn.
//   `pending`                print the digest the same way and change nothing.
//   anything else, away      the prompt proceeds with the away instruction as additionalContext
//                            (lib/text.mjs awayInstruction, rendered with this session's hold
//                            command: the absolute path of scripts/brb.mjs and the session id).
//   anything else, home      null: nothing printed.
// `back` or `pending` while home is null too: the word reaches the model as an ordinary reply
// (an agent that asked "revert or go back?" gets its answer). A reason longer than 8000
// characters is cut at a line and ends `… (N more lines; full digest: <path>)` (lib/text.mjs
// cappedReason); the archive path is on the first line either way.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// ${XDG_STATE_HOME:-~/.local/state}/brb/errors.log and the prompt proceeds. An away.json that
// does not parse reads as home. Reasons name the way out in backticks (`back`, `brb`).
//
// handle() runs on a worker thread: it returns a plain object or null, never exits or writes to
// stdout itself.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { archiveDigest, clearAway, digestPath, freshAway, readAway, readDigest, renderDigest, writeAway } from "../lib/state.mjs";
import { AWAY_NOTICE, awayInstruction, cappedReason, holdCommand, surfaceWord } from "../lib/text.mjs";

const block = (reason) => ({ decision: "block", reason, hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true } });

/**
 * @param {object} input  the UserPromptSubmit payload; session_id and prompt are read
 * @returns {object|null}
 */
export function handle(input, { env = process.env, now = () => new Date().toISOString() } = {}) {
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  const word = surfaceWord(input?.prompt);
  const away = readAway(sessionId, env);
  if (!word) {
    if (!away) return null;
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: awayInstruction(away, holdCommand(sessionId)) } };
  }
  if (word.word === "brb") {
    if (away) return block(`brb: already away since ${away.since}; ${away.held} held. Type \`back\` to read them or \`pending\` to peek.`);
    writeAway(sessionId, freshAway({ since: now(), note: word.note }), env);
    return block(word.note ? `${AWAY_NOTICE} (note: ${word.note})` : AWAY_NOTICE);
  }
  // back or pending
  if (!away) return null;
  const [header, ...rest] = renderDigest(away, readDigest(sessionId, env)).split("\n");
  if (word.word === "pending") return block(cappedReason(header, rest.join("\n").replace(/^\n+/, ""), digestPath(sessionId, env)));
  const archived = archiveDigest(sessionId, env, now());
  clearAway(sessionId, env);
  const digest = [header, ...rest].join("\n");
  return block(cappedReason(`brb: hold cleared${archived ? `; digest archived to ${archived}` : ""}.`, digest, archived ?? digestPath(sessionId, env)));
}

if (invokedDirectly(import.meta.url)) runHook("UserPromptSubmit", import.meta.url, { plugin: "brb", quiet: false });
