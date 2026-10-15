#!/usr/bin/env node
// ask-graham-stop.mjs — Claude Code Stop: block, once, a turn that read the ask-graham skill
// but ended without a verdict line.
//
// The check itself is checkStop in skills/ask-graham/scripts/verdict.mjs, shared with the OMP
// session_stop handler. This file only does Claude Code's I/O: it reads the Stop payload
// (session_id, transcript_path), parses the JSONL transcript (torn lines skipped), and keeps the
// once-per-turn record.
//
// ONCE PER TURN. A block is recorded as the turn opener's id in
// ${XDG_STATE_HOME:-$HOME/.local/state}/ask-graham/blocked/<session id> (XDG_STATE_HOME counts only
// when it is an absolute path, as with the intensity config). A stop whose turn opener is the one
// recorded passes, so the agent is asked for the verdict at most once per turn and a reply that
// still lacks it cannot loop. stop_hook_active is not read: Claude Code sets it after any Stop
// hook's continuation, so a stop that follows another hook's block is still checked. If the
// record cannot be written, the stop passes rather than block with no way to stop blocking.
//
// MAIN SESSION ONLY. Subagents end on SubagentStop, which this hook is not registered for.
//
// FAIL OPEN. Every path exits 0. Any error (bad stdin, missing or unreadable transcript,
// unwritable state) prints nothing on stdout, so the stop goes through.
//
// Contract: JSON on stdin (Stop payload). {"decision":"block","reason":...} on stdout, or nothing.
// OMP does not run this file; omp/ask-graham-omp.ts does the same job there.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkStop, parseJsonl } from "../skills/ask-graham/scripts/verdict.mjs";

/** The directory holding one once-per-turn record per session. */
export function blockedDir(env = process.env, home = homedir()) {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "ask-graham", "blocked");
}

// A session id usable as a file name. Claude Code's are UUIDs.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The hook's output for one payload: the JSON to print, or null for none. Throws are the caller's to swallow. */
export function handle(input, opts = {}) {
  const sessionId = input?.session_id;
  const transcript = input?.transcript_path;
  if (typeof sessionId !== "string" || !SAFE_ID.test(sessionId)) return null;
  if (typeof transcript !== "string" || transcript === "") return null;

  let raw;
  try {
    raw = readFileSync(transcript, "utf8");
  } catch {
    return null; // missing or unreadable transcript: fail open
  }

  const record = join(blockedDir(opts.env ?? process.env, opts.home ?? homedir()), sessionId);
  let blockedOpener = null;
  try {
    blockedOpener = readFileSync(record, "utf8").trim() || null;
  } catch {
    blockedOpener = null; // no block recorded for this session yet
  }

  const r = checkStop({ entries: parseJsonl(raw), blockedOpener });
  if (!r.block) return null;
  try {
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, `${r.opener}\n`);
  } catch {
    return null; // a block that cannot be recorded could repeat every stop: pass instead
  }
  return { decision: "block", reason: r.block };
}

function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { input = {}; }
  let out = null;
  try {
    out = handle(input);
  } catch {
    out = null; // fail open
  }
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) main();
