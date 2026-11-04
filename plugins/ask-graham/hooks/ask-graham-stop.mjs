#!/usr/bin/env node
// ask-graham-stop.mjs — Claude Code Stop: block, once, a turn that read the ask-graham skill
// but ended without a verdict line, a structure check line, or the final comparables question while waiting.
//
// The check itself is checkStop in skills/ask-graham/scripts/verdict.mjs, shared with the OMP
// session_stop handler. This file only does Claude Code's I/O: it reads the Stop payload
// (session_id, transcript_path, last_assistant_message), parses the JSONL transcript (torn lines
// skipped), and keeps the once-per-turn record. The reply checked is the payload's
// last_assistant_message when it is a non-empty string: Claude Code 2.1.317 runs the Stop hooks
// before the final reply is in the transcript. Without it the reply is read from the transcript.
//
// ONCE PER TURN. A block is recorded as the turn opener's id in
// ${XDG_STATE_HOME:-$HOME/.local/state}/ask-graham/blocked/<session id> (XDG_STATE_HOME counts only
// when it is an absolute path, as with the intensity config). A stop whose turn opener is the one
// recorded passes, so the agent is asked for the verdict at most once per turn and a reply that
// still lacks it cannot loop. stop_hook_active is not read: Claude Code sets it after any Stop
// hook's continuation, so a stop that follows another hook's block is still checked. If the
// record cannot be written, the stop passes rather than block with no way to stop blocking.
//
// OFF SWITCH. stop-check=off in the nearest .ask-graham or the user config (intensity.mjs, resolved
// from the payload's cwd, else the process's) skips the check before the transcript is read.
//
// MAIN SESSION ONLY. Subagents end on SubagentStop, which this hook is not registered for.
//
// FAIL OPEN, NOT SILENT. Every path exits 0 and a fault never blocks. A fault (empty or non-JSON
// stdin, a payload without a usable session_id or transcript_path, a missing or unreadable
// transcript, an unreadable or unwritable record, a config file that names no valid stop-check
// value, a throw) lets the stop through, appends one line to errors.log, and prints one
// systemMessage line (hooks/fault.mjs).
//
// Contract: JSON on stdin (Stop payload). {"decision":"block","reason":...} and/or {"systemMessage":...}
// on stdout, or nothing. OMP does not run this file; omp/ask-graham-omp.ts does the same job there.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkStop, parseJsonl } from "../skills/ask-graham/scripts/verdict.mjs";
import { resolveSetting } from "../skills/ask-graham/scripts/intensity.mjs";
import { errText, faults, stateDir } from "./fault.mjs";

const HOOK_FILE = "ask-graham-stop.mjs";

/** The directory holding one once-per-turn record per session. */
export function blockedDir(env = process.env, home = homedir()) {
  return join(stateDir(env, home), "blocked");
}

// A session id usable as a file name. Claude Code's are UUIDs.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The hook's output for one payload: the JSON to print, or null for none. Each fault that skips or
 * weakens the check is passed to `opts.fault(reason)`. Throws are the caller's to catch.
 */
export function handle(input, opts = {}) {
  const fault = opts.fault ?? (() => {});
  const sessionId = input?.session_id;
  const transcript = input?.transcript_path;
  if (typeof sessionId !== "string" || !SAFE_ID.test(sessionId)) {
    fault(`payload session_id ${JSON.stringify(sessionId) ?? "undefined"} is not a plain file name, so the Stop check did not run`);
    return null;
  }
  if (typeof transcript !== "string" || transcript === "") {
    fault("payload has no transcript_path, so the Stop check did not run");
    return null;
  }
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cwd = typeof input?.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  const setting = resolveSetting("stop-check", { cwd, env, home });
  if (setting.invalid) fault(`config ${setting.path} names no valid stop-check (on or off), so it counts as on`);
  if (setting.value === "off") return null;

  let raw;
  try {
    raw = readFileSync(transcript, "utf8");
  } catch (e) {
    fault(`transcript ${transcript} could not be read (${e.code ?? errText(e)}), so the Stop check did not run`);
    return null;
  }

  const record = join(blockedDir(env, home), sessionId);
  let blockedOpener = null;
  try {
    blockedOpener = readFileSync(record, "utf8").trim() || null;
  } catch (e) {
    if (e.code !== "ENOENT") {
      // an unreadable record cannot say whether this turn was already blocked; blocking anyway could
      // block every stop of the turn, so pass instead
      fault(`block record ${record} could not be read (${e.code ?? errText(e)}), so the stop was not blocked`);
      return null;
    }
    blockedOpener = null; // no block recorded for this session yet
  }

  const reply = typeof input.last_assistant_message === "string" ? input.last_assistant_message : undefined;
  const r = checkStop({ entries: parseJsonl(raw), text: reply, blockedOpener });
  if (!r.block) return null;
  try {
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, `${r.opener}\n`);
  } catch (e) {
    // a block that cannot be recorded could repeat every stop: pass instead
    fault(`block record ${record} could not be written (${e.code ?? errText(e)}), so the stop was not blocked`);
    return null;
  }
  return { decision: "block", reason: r.block };
}

/** The whole hook for one stdin text: the JSON to print, or null. Never throws. */
export function run(raw, { env = process.env, home, handleFn = handle } = {}) {
  const f = faults(HOOK_FILE, { env, ...(home ? { home } : {}) });
  let out = null;
  let input = null;
  if (typeof raw !== "string" || raw.trim() === "") {
    f.add("stdin was empty, so the Stop check did not run");
  } else {
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      input = parsed;
    } catch (e) {
      f.add(`stdin is not a JSON object (${errText(e)}), so the Stop check did not run`);
    }
  }
  if (input) {
    try {
      out = handleFn(input, { env, home, fault: (reason) => f.add(reason) });
    } catch (e) {
      f.add(`the Stop check threw (${errText(e)}), so the stop went through`);
      out = null;
    }
  }
  const warning = f.warning(out ? "the check still ran" : "the stop went through");
  return warning ? { ...(out ?? {}), systemMessage: warning } : out;
}

function main() {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { raw = ""; }
  let out = null;
  try { out = run(raw); } catch { out = null; } // run never throws; belt and braces for exit 0
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) main();
