#!/usr/bin/env node
// hooks/session-start.mjs — the continuity plugin's SessionStart hook. Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage, never
// a block.
//
// What it does, as `additionalContext`: after a compaction (`source: "compact"`) it injects the
// snapshot hooks/pre-compact.mjs saved for this session and removes the file (a restore that does
// not fit whole in its share of the 20,000-character restore guard is cut, says so, and is kept);
// when there is no snapshot to restore, it says
// that this compaction's state was not restored and what the heartbeat recorded for this
// session's save. After the same compaction it also re-inlines the rules files on the walk from
// the payload's cwd to the walk root (lib/repo-rules.mjs; `rules: "off"` skips it) and lists the
// newest entries of the durable-notes directory (`notesDir`, default `.ai/decision-log` at the
// git root of the real cwd; `notesCount: 0` skips it). The whole context after a compaction
// (restore with its heading and notices, sections, liveness line, separators) is at most 20,000
// characters: each whole rendered section fits in what the blocks before it and the closing lines
// left (the rules section also in 9,000 bytes); one with no room for its heading is left out and
// named in the systemMessage.
// The two sections never appear on a fresh start. On every start it adds the liveness line: the newest save's
// result and the age of the last success, or a short block saying no save ever succeeded. The
// line is marked said for the session, so hooks/user-prompt-submit.mjs does not repeat it.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows. No snapshot, or one older than a day, or one that does not parse →
// nothing restored, said in one line, then the enabled rules and notes sections and the
// liveness line. `"liveness": "off"` in the config
// file silences the line; `"snapshot": "off"` skips the restore. A config file with a problem is
// named once per session (the once-mark is shared with the other hooks) and the defaults apply. A
// once-mark that cannot be written is one errors.log line and a systemMessage; the line itself is
// still given.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { readConfig } from "../lib/config.mjs";
import { logError } from "../lib/errors.mjs";
import { lastSaveFor, renderLiveness } from "../lib/liveness.mjs";
import { markFlag, readFlags, sessionKey } from "../lib/session-flags.mjs";
import { sanitizeSessionId, sessionFlagsPath } from "../lib/paths.mjs";
import { RESTORE_MAX_CHARS, restore } from "../lib/snapshot.mjs";
import { notesRoot, renderNotes, renderRules, walkRules } from "../lib/repo-rules.mjs";

const SEP = "\n\n";
const block = (parts) => parts.reduce((n, p) => n + p.length, 0) + SEP.length * Math.max(0, parts.length - 1);

export function handle(input, { env = process.env } = {}) {
  if (input?.hook_event_name !== "SessionStart") return null;
  const { config, problem } = readConfig(env);
  const key = sessionKey(input);
  const parts = [];
  const omitted = [];
  const later = [];
  // The lines that close the context (liveness, a config problem) are settled first: after a
  // compaction they count against the restore guard too, so the restore is fitted around them.
  const tail = [];
  if (config.liveness !== "off") {
    tail.push(renderLiveness({ env }));
    if (!markFlag(key, "livenessSaid", env)) {
      // The line was still given; what failed is the once-mark, so the prompt hook will repeat it.
      const where = sessionFlagsPath(key, env);
      logError("continuity", "SessionStart", `once-mark not written to ${where}; the liveness line will repeat at the first prompt`, env);
      later.push(`continuity: the session mark could not be written to ${where}; the liveness line will repeat once at the first prompt.`);
    }
  }
  if (problem && !readFlags(key, env).configNoted) {
    tail.push(`continuity: ${problem}.`);
    markFlag(key, "configNoted", env);
  }
  // The whole context after a compaction (the restore or the not-restored line, each section,
  // the closing lines, the blank lines joining them) stays within RESTORE_MAX_CHARS. The restore
  // is fitted first, its heading, notices and any truncation marker inside its share; each
  // section's cap is in bytes against a character guard, so never more. The notes list is small
  // and is fitted next; the rules get what is left and give way. A section with no room for even
  // its heading is left out and named in the systemMessage.
  const room = (...more) => Math.max(0, RESTORE_MAX_CHARS - block([...parts, ...more, ...tail]));
  if (config.snapshot !== "off" && input.source === "compact") {
    const restored = restore(input, { env, max: room("") });
    parts.push(restored || notRestored(lastSaveFor(sanitizeSessionId(input.session_id), { env })));
  }
  if (input.source === "compact") {
    const notes = config.notesCount > 0 ? renderNotes(config.notesDir, notesRoot(input.cwd), config.notesCount, room("")) : null;
    if (config.rules !== "off") {
      const rules = renderRules(walkRules(input.cwd, env), notes ? room("", notes) : room(""));
      if (rules) parts.push(rules);
      else omitted.push("the re-inlined repo rules");
    }
    if (notes) parts.push(notes);
    else if (notes === "") omitted.push("the durable notes list");
  }
  parts.push(...tail);
  const messages = [];
  if (omitted.length) messages.push(`continuity: ${omitted.join(" and ")} left out of the post-compaction restore: the block before ${omitted.length > 1 ? "them" : "it"} reached the ${String(RESTORE_MAX_CHARS).replace(/\B(?=(\d{3})+$)/g, ",")}-character restore guard; read the rules files and the notes directory directly.`);
  messages.push(...later);
  if (!parts.length && !messages.length) return null;
  const out = {};
  if (parts.length) out.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: parts.join(SEP) };
  if (messages.length) out.systemMessage = messages.join(" ");
  return out;
}

// After a compaction with nothing to restore, the model must not assume a restore it never got.
function notRestored(save) {
  const why = !save
    ? "no pre-compaction save was recorded for this session"
    : save.outcome === "ok"
      ? `the save recorded \`ok\` at ${save.at}, but its snapshot is gone or unreadable`
      : save.outcome === "started"
        ? `the save started at ${save.at} and recorded no result: it did not finish`
        : `the save recorded \`${save.outcome}\` at ${save.at}`;
  return `continuity: **this compaction's state was not restored**: ${why}. Nothing from before the compaction is in context beyond what the host kept; reconstruct from the repository and say that you are reconstructing.`;
}

if (invokedDirectly(import.meta.url)) runHook("SessionStart", import.meta.url, { plugin: "continuity", quiet: false });
