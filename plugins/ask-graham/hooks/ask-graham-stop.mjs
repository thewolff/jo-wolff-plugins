#!/usr/bin/env node
// ask-graham-stop.mjs — Claude Code Stop: block, once, a turn that read the ask-graham skill
// but ended without a verdict line, a structure check line, or a waiting reply (its `**Ask:**` line
// and five `**Gate questions**` bullets, then the comparables question alone on the final line).
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
// SOURCES. When the user's sources file exists (scripts/sources.mjs readSources), checkStop also
// requires its proof from the transcript's tool calls: a Read of the file, a run or read of each
// source, and the reply's `**Local search:**` block. A missing or unparseable file requires nothing.
//
// FINDINGS. A reply carrying a `**Verdict:**` or `**Structure check:**` line is also recorded, per
// session, in ${XDG_STATE_HOME:-$HOME/.local/state}/ask-graham/findings/<session id>.json
// (skills/ask-graham/scripts/findings.mjs parses it; README "Findings on disk" gives the shape), for
// other plugins to read. When the payload carries last_assistant_message (Claude Code 2.1.317's
// does), it is written whether or not the check runs or blocks. Without it the reply comes from the
// transcript, which stop-check=off skips reading, so with the check off that stop writes nothing.
// A write that fails is a fault like the others below and does not change what the check decides.
//
// FAIL OPEN, NOT SILENT. Every path exits 0 and a fault never blocks. A fault (empty or non-JSON
// stdin, a payload without a usable session_id or transcript_path, a missing or unreadable
// transcript, an unreadable or unwritable record, a config file that names no valid stop-check
// value, a throw) lets the stop through, appends one line to errors.log, and prints one
// systemMessage line (hooks/fault.mjs).
//
// Contract: JSON on stdin (Stop payload). {"decision":"block","reason":...} and/or {"systemMessage":...}
// on stdout, or nothing. OMP does not run this file; omp/ask-graham-omp.ts does the same job there.

import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkStop, currentTurn, lastAssistantText, parseJsonl } from "../skills/ask-graham/scripts/verdict.mjs";
import { FINDINGS_VERSION, parseFindings } from "../skills/ask-graham/scripts/findings.mjs";
import { resolveSetting } from "../skills/ask-graham/scripts/intensity.mjs";
import { readSources } from "../skills/ask-graham/scripts/sources.mjs";
import { errText, faults, stateDir } from "./fault.mjs";

const HOOK_FILE = "ask-graham-stop.mjs";

/** The directory holding one once-per-turn record per session. */
export function blockedDir(env = process.env, home = homedir()) {
  return join(stateDir(env, home), "blocked");
}

// A session id usable as a file name. Claude Code's are UUIDs.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The directory holding one findings file per session (README "Findings on disk"). */
export function findingsDir(env = process.env, home = homedir()) {
  return join(stateDir(env, home), "findings");
}

/**
 * Write the findings of `reply` to findings/<sessionId>.json (tmp file, then rename; mode 0600;
 * replaces the session's earlier file). A reply with no Verdict or Structure check line writes
 * nothing. A write that fails is passed to `fault` and never thrown. Returns the path written, or null.
 */
export function writeFindings(reply, { sessionId, cwd, env = process.env, home = homedir(), fault = () => {}, now = () => new Date() }) {
  const found = parseFindings(reply);
  if (!found) return null;
  const record = {
    version: FINDINGS_VERSION,
    sessionId,
    writtenAt: now().toISOString(),
    kind: found.kind,
    ask: found.ask,
    verdict: found.verdict,
    alternative: found.alternative,
    alternatives: found.alternatives,
    found: found.found,
    cwd,
  };
  const path = join(findingsDir(env, home), `${sessionId}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return path;
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    fault(`findings ${path} could not be written (${e.code ?? errText(e)}), so this stop's findings were not recorded`);
    return null;
  }
}

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
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cwd = typeof input?.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  // The findings file does not depend on the check: the payload's reply is recorded before anything
  // that can skip the check. Without one, the transcript's last reply is recorded once it is read.
  const reply = typeof input.last_assistant_message === "string" && input.last_assistant_message.trim() ? input.last_assistant_message : undefined;
  const recordFindings = (text) => writeFindings(text, { sessionId, cwd, env, home, fault });
  if (reply) recordFindings(reply);
  if (typeof transcript !== "string" || transcript === "") {
    fault("payload has no transcript_path, so the Stop check did not run");
    return null;
  }
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
  const entries = parseJsonl(raw);
  if (!reply) recordFindings(lastAssistantText(currentTurn(entries)));

  const blockRecord = join(blockedDir(env, home), sessionId);
  let blockedOpener = null;
  try {
    blockedOpener = readFileSync(blockRecord, "utf8").trim() || null;
  } catch (e) {
    if (e.code !== "ENOENT") {
      // an unreadable record cannot say whether this turn was already blocked; blocking anyway could
      // block every stop of the turn, so pass instead
      fault(`block record ${blockRecord} could not be read (${e.code ?? errText(e)}), so the stop was not blocked`);
      return null;
    }
    blockedOpener = null; // no block recorded for this session yet
  }

  const r = checkStop({ entries, text: reply, blockedOpener, sources: readSources({ env, home }), home });
  if (!r.block) return null;
  try {
    mkdirSync(dirname(blockRecord), { recursive: true });
    writeFileSync(blockRecord, `${r.opener}\n`);
  } catch (e) {
    // a block that cannot be recorded could repeat every stop: pass instead
    fault(`block record ${blockRecord} could not be written (${e.code ?? errText(e)}), so the stop was not blocked`);
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
