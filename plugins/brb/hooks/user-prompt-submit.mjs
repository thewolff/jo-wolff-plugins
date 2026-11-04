#!/usr/bin/env node
// hooks/user-prompt-submit.mjs — brb's UserPromptSubmit hook. Runs under lib/hook-runner.mjs:
// exit 0 always; a fault is one errors.log line and a systemMessage, never a block for its own
// fault.
//
// What it does: the whole prompt is one of three words, or it is not.
//   `brb` (or `brb <note>`)  start the hold: write away.json, block the prompt (no turn) with the
//                            confirmation as the reason and the prompt text suppressed. While
//                            already away it is not blocked and changes nothing: the prompt
//                            proceeds; Jo sees lib/text.mjs alreadyAwayText (`brb: still away
//                            since <since> (<duration>); N held. Only `back` ends the hold; …`)
//                            as a systemMessage, and the agent gets the same line over the away
//                            instruction as additionalContext, so it returns to holding. (On OMP
//                            the adapter handles `brb` itself: it shows that line, no turn.)
//   `back`                   archive the digest to archive/<ts>.md, clear away.json, and print
//                            `brb: hold cleared; digest archived to <path>.` as the block reason's
//                            first line with the digest under it. No turn. The only way out.
//   `pending`                print the digest the same way and change nothing.
//   anything else, away      the prompt proceeds with the away instruction as additionalContext
//                            (lib/text.mjs awayInstruction, rendered with this session's hold
//                            command: the absolute path of scripts/brb.mjs and the session id;
//                            its first line is `brb: still away since <since> (<duration>); N
//                            held`). Jo typing is an exchange, typically an answer to an
//                            `on fire:` line, not a return: the hold stays. It is a new human
//                            turn, though, so `backstopped` and `toolLessStops` in away.json are
//                            cleared (one write, newTurn below; a second `brb` while away does
//                            the same, `pending` does not): the Stop hook's once-per-turn
//                            backstop and its tool-less bound count from this prompt, not from
//                            the turns before it.
//   anything else, home      null: nothing printed.
// `back` or `pending` while home is null too: the word reaches the model as an ordinary reply
// (an agent that asked "revert or go back?" gets its answer). A reason longer than 8000
// characters is cut at a line and ends `… (N more lines; full digest: <path>)` (lib/text.mjs
// cappedReason); the archive path is on the first line either way.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// ${XDG_STATE_HOME:-~/.local/state}/brb/errors.log and the prompt proceeds. An away.json that
// does not parse reads as home. Reasons name the way out in backticks (`back`, `brb`). Every
// away.json write here (`brb`, `back`, the new-turn reset) runs under the session lock
// (lib/state.mjs withAwayLock) after a re-read; a lock held past 2 s is a throw, logged, and
// the prompt proceeds.
//
// handle() runs on a worker thread: it returns a plain object or null, never exits or writes to
// stdout itself.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { archiveDigest, clearAway, digestPath, freshAway, readAway, readDigest, renderDigest, withAwayLock, writeAway } from "../lib/state.mjs";
import { AWAY_NOTICE, alreadyAwayText, awayInstruction, cappedReason, holdCommand, surfaceWord } from "../lib/text.mjs";

const block = (reason) => ({ decision: "block", reason, hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true } });
const context = (text) => ({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } });

/** A human prompt while away is a new turn: clear the Stop hook's per-turn backstop flag and tool-less count, in one write. */
function newTurn(sessionId, away, env) {
  if (!away.backstopped && away.toolLessStops === 0) return;
  away.backstopped = false;
  away.toolLessStops = 0;
  writeAway(sessionId, away, env);
}

/**
 * @param {object} input  the UserPromptSubmit payload; session_id and prompt are read
 * @returns {object|null}
 */
export function handle(input, { env = process.env, now = () => new Date().toISOString() } = {}) {
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  const word = surfaceWord(input?.prompt);
  if (word?.word === "pending") {
    const away = readAway(sessionId, env);
    if (!away) return null;
    const [header, ...rest] = renderDigest(away, readDigest(sessionId, env)).split("\n");
    return block(cappedReason(header, rest.join("\n").replace(/^\n+/, ""), digestPath(sessionId, env)));
  }
  if (!readAway(sessionId, env) && word?.word !== "brb") return null;
  return withAwayLock(sessionId, env, () => {
    const away = readAway(sessionId, env);
    if (!word) {
      if (!away) return null;
      newTurn(sessionId, away, env);
      return context(awayInstruction(away, holdCommand(sessionId), now()));
    }
    if (word.word === "brb") {
      if (away) {
        newTurn(sessionId, away, env);
        const at = now();
        return { systemMessage: alreadyAwayText(away, at), ...context(`${alreadyAwayText(away, at)}\n\n${awayInstruction(away, holdCommand(sessionId), at)}`) };
      }
      writeAway(sessionId, freshAway({ since: now(), note: word.note }), env);
      return block(word.note ? `${AWAY_NOTICE} (note: ${word.note})` : AWAY_NOTICE);
    }
    // back
    if (!away) return null;
    const digest = renderDigest(away, readDigest(sessionId, env));
    const archived = archiveDigest(sessionId, env, now());
    clearAway(sessionId, env);
    return block(cappedReason(`brb: hold cleared${archived ? `; digest archived to ${archived}` : ""}.`, digest, archived ?? digestPath(sessionId, env)));
  });
}

if (invokedDirectly(import.meta.url)) runHook("UserPromptSubmit", import.meta.url, { plugin: "brb", quiet: false });
