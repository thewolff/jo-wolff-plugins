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
//   `back`                   end the hold (lib/back.mjs endHold: archive the digest to
//                            archive/<ts>.md, write checklist.json, the returned digest, from
//                            its items, clear away.json) and let the prompt through (no block)
//                            with two outputs carrying the same text: additionalContext for the
//                            agent, lib/text.mjs backInstruction (`brb: Jo is back (away
//                            <duration>). Reply with the list below verbatim as your whole
//                            message …`) over `brb: hold cleared; digest archived to <path>.`
//                            and the numbered list, one line per item, so the agent's reply IS
//                            the list; and a systemMessage with the same, for the surfaces that
//                            render hook frames. Why both: the mobile app renders
//                            no hook frame, so a blocked prompt showed Jo nothing; an assistant
//                            message renders everywhere. The only way out. The band's Back
//                            button (mods/band) sends this same word as the user's own prompt
//                            (`$.prompt.submit({ text: "back", asUser: true })`), so a press
//                            arrives here as `back` and ends the hold the same way.
//   `pending`                print the digest as a block reason and change nothing. The record
//                            and the digest are read under the session lock, so a digest a
//                            writer is mid-way through (lines appended, count not yet written)
//                            is not shown; a lock held past 2 s is a throw, logged, and the word
//                            proceeds to the model.
//   the returned digest      while home with checklist.json present (lib/text.mjs digestWord):
//                            `3` / `brb item 3` → the agent is told to show item 3 in full and
//                            work it (lib/back.mjs showItem); `done 3` / `brb done 3` → item 3 is
//                            ticked and the agent told (tickItem; the last tick closes the
//                            list); `brb clear` → every item not done in full, then the file is
//                            removed (clearReturned; also a systemMessage). A block or item too long
//                            for the context is exported whole first (export/<ts>-<what>.md) and
//                            the text points at it; a failed export keeps the list and says so in
//                            a systemMessage. All pass through as
//                            additionalContext. With no checklist, `3` and `done 3` are ordinary
//                            prompts (null) and the `brb …` forms say lib/text.mjs NO_OPEN_TEXT
//                            and start no hold. While away none of these is special. The band
//                            sends the `brb …` forms ending ` @<at>#<hold>`, the open list's `at`
//                            and hold number; such a word, checked first and under the session
//                            lock, with its work done in the same lock, is blocked (no turn) with
//                            a systemMessage when a hold is on, that list is not the open one, a
//                            hold has started and ended since (a newer `hold`), or the check
//                            cannot get the lock (a stated rule; logged). A typed item word's
//                            home check and its work also share one lock.
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
// `pending` while home is null too, and `back` while home passes through with
// `brb: you were not away; nothing held` as additionalContext: the word reaches the model as
// an ordinary reply (an agent that asked "revert or go back?" gets its answer). A digest longer
// than 8000 characters is cut at a line and ends `… (N more lines; full digest: <path>)`
// (lib/text.mjs cappedReason); the archive path is on the first line either way.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// ${XDG_STATE_HOME:-~/.local/state}/brb/errors.log and the prompt proceeds. An away.json that
// does not parse reads as home. Reasons name the way out in backticks (`back`, `brb`). Every
// away.json write here (`brb`, `back`, the new-turn reset) and `pending`'s read run under the
// session lock (lib/state.mjs withAwayLock) after a re-read; a lock held past 2 s (a live
// holder; a dead holder's lock is taken over at once) is a throw, logged, and the prompt
// proceeds.
//
// handle() runs on a worker thread: it returns a plain object or null, never exits or writes to
// stdout itself.

import { logError, runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { clearReturned, endHold, showItem, tickItem } from "../lib/back.mjs";
import { digestPath, freshAway, nextHold, readAway, readChecklist, readDigest, renderDigest, withAwayLock, writeAway } from "../lib/state.mjs";
import { AWAY_NOTICE, NOT_AWAY_TEXT, NO_OPEN_TEXT, alreadyAwayText, awayInstruction, cappedReason, digestWord, holdCommand, stalePressText, surfaceWord } from "../lib/text.mjs";

const block = (reason) => ({ decision: "block", reason, hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true } });
const context = (text) => ({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } });

/** A human prompt while away is a new turn: clear the Stop hook's per-turn backstop flag and tool-less count, in one write. */
function newTurn(sessionId, away, env) {
  if (!away.backstopped && away.toolLessStops === 0) return;
  away.backstopped = false;
  away.toolLessStops = 0;
  writeAway(sessionId, away, env);
}

/** A prompt that works the returned digest while home: its output; undefined when it is not one (the prompt goes on as usual). `locked`: the caller holds the session lock. */
function workReturned(sessionId, pick, env, { locked = false } = {}) {
  if (!readChecklist(sessionId, env)) return pick.prefixed ? context(NO_OPEN_TEXT) : undefined;
  if (pick.verb === "show") {
    const r = showItem(sessionId, pick.n, env, { locked });
    if (r?.systemMessage) return { systemMessage: r.systemMessage, ...context(r.agentText) };
    return r ? context(r.agentText) : pick.prefixed ? context(NO_OPEN_TEXT) : undefined;
  }
  if (pick.verb === "done") {
    const r = tickItem(sessionId, pick.n, env, { locked });
    return r ? context(r.agentText) : pick.prefixed ? context(NO_OPEN_TEXT) : undefined;
  }
  const r = clearReturned(sessionId, env, { locked });
  return r ? { systemMessage: r.text, ...context(r.agentText) } : context(NO_OPEN_TEXT);
}

/** A band press, under the session lock: dropped unless home with the list it names (`at` and `hold`) open; else its work, done in the same lock. */
function pressUnderLock(sessionId, pick, input, env) {
  const away = Boolean(readAway(sessionId, env));
  const open = readChecklist(sessionId, env);
  if (away || open?.at !== pick.token || open?.hold !== pick.hold) {
    const why = stalePressText(String(input.prompt).trim().replace(/\s+@\S+$/, ""), away ? "away" : open?.at === pick.token && pick.hold !== null && pick.hold < open.hold ? "cycled" : "gone");
    return { ...block(why), systemMessage: why };
  }
  return workReturned(sessionId, pick, env, { locked: true }) ?? null;
}

/**
 * @param {object} input  the UserPromptSubmit payload; session_id and prompt are read
 * @returns {object|null}
 */
export function handle(input, { env = process.env, now = () => new Date().toISOString() } = {}) {
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  // OMP's adapter reads `brb item N` and `brb clear` as `brb` with a note, so OMP keeps 0.5.0's words.
  const pick = env.BRB_HARNESS === "omp" ? null : digestWord(input?.prompt);
  // A band press carries the `at` and hold number of the list it was made for. It runs only while
  // that list is the open one, no hold is on and no hold has begun since; otherwise it is dropped
  // here, before any away handling, so a press that raced a `brb` never reaches the agent as an
  // answer. Check and work share one lock, so no `brb`, `back` or tick lands between them.
  // Stated rule, not a fault-deny: a band press whose check cannot run (the lock is not had) is
  // dropped too, since only the band sends the tagged word and the person can type it instead.
  // A fault in the work itself, once the check has passed, still fails open through the runner.
  if (pick?.token) {
    let entered = false;
    try {
      return withAwayLock(sessionId, env, () => {
        entered = true;
        return pressUnderLock(sessionId, pick, input, env);
      });
    } catch (err) {
      if (entered) throw err;
      const word = String(input.prompt).trim().replace(/\s+@\S+$/, "");
      const why = stalePressText(word, "unchecked", err?.message ?? String(err));
      logError("brb", "UserPromptSubmit", `dropped a band press (${word}) it could not check: ${err?.message ?? String(err)}`, env);
      return { ...block(why), systemMessage: why };
    }
  }
  // A typed item word: the home check and the work share one lock, so a `brb` cannot start
  // between them and have the word tick or clear the list during the hold.
  if (pick) {
    const out = withAwayLock(sessionId, env, () => (readAway(sessionId, env) ? undefined : workReturned(sessionId, pick, env, { locked: true })));
    if (out !== undefined) return out;
  }
  const word = surfaceWord(input?.prompt);
  if (word?.word === "pending") {
    if (!readAway(sessionId, env)) return null;
    const { away, body } = withAwayLock(sessionId, env, () => ({ away: readAway(sessionId, env), body: readDigest(sessionId, env) }));
    if (!away) return null;
    const [header, ...rest] = renderDigest(away, body, env).split("\n");
    return block(cappedReason(header, rest.join("\n").replace(/^\n+/, ""), digestPath(sessionId, env)));
  }
  if (!readAway(sessionId, env) && word?.word !== "brb") return word?.word === "back" ? context(NOT_AWAY_TEXT) : null;
  if (word?.word === "back") {
    const ended = endHold(sessionId, env, now());
    return ended ? { systemMessage: ended.text, ...context(ended.agentText) } : context(NOT_AWAY_TEXT);
  }
  return withAwayLock(sessionId, env, () => {
    const away = readAway(sessionId, env);
    if (!word) {
      if (!away) return null;
      newTurn(sessionId, away, env);
      return context(awayInstruction(away, holdCommand(sessionId), now()));
    }
    // brb
    if (away) {
      newTurn(sessionId, away, env);
      const at = now();
      return { systemMessage: alreadyAwayText(away, at), ...context(`${alreadyAwayText(away, at)}\n\n${awayInstruction(away, holdCommand(sessionId), at)}`) };
    }
    writeAway(sessionId, freshAway({ since: now(), note: word.note, hold: nextHold(sessionId, env) }), env);
    return block(word.note ? `${AWAY_NOTICE} (note: ${word.note})` : AWAY_NOTICE);
  });
}

if (invokedDirectly(import.meta.url)) runHook("UserPromptSubmit", import.meta.url, { plugin: "brb", quiet: false });
