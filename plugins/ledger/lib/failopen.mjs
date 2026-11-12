// failopen.mjs — every hook ends in exit 0 with its "allow" output, whatever went wrong.
//
// runHook(name, fn, opts) reads stdin, parses it as JSON, calls fn(input), prints what fn
// returns (an object → JSON on stdout; null → nothing) and exits 0. If stdin is not JSON or fn
// throws, it appends one line to ${XDG_STATE_HOME:-~/.local/state}/ledger/errors.log
// (`<iso> <hook> <message>`) and prints { systemMessage: "ledger <hook> failed open: <msg>" }
// so the person can see the hook is not doing its job — except where the event discards
// JSON output (SessionEnd), in which case the log line is the only trace.
//
// A hook never exits 2: on the events that can block, exit 2 would block, and a hook that
// blocks because of its own fault is the one failure this plugin promises never to have.
//
// Config and store notices (a config file that did not parse, a corrupt database moved aside)
// are not failures; the hook still does its job and reports them in the same systemMessage.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentLogDb, stateDir } from "./config.mjs";
import { nowIso } from "./time.mjs";

// The hook payload's session_id and cwd, kept by runHook so a logError from deep inside a hook
// can say which session and folder it came from.
let hookInput = { session_id: null, cwd: null };

export const PARENT_LOOKUP_TIMEOUT_MS = 250;
export const PARENT_COMMAND_MAX = 200;
let parentCommand;

/**
 * The parent process's command line (`ps -o command= -p <ppid>`), looked up once per process and
 * only when a line is logged; `? (<why>)` when ps fails, times out or prints nothing. Never throws.
 * The why is itself evidence: under a macOS seatbelt profile the setuid ps cannot be started and
 * spawnSync reports EPERM (measured 2026-11-12 under sandbox-exec).
 */
function parentCommandLine() {
  if (parentCommand !== undefined) return parentCommand;
  parentCommand = "? (ps not run)";
  try {
    const r = spawnSync("ps", ["-o", "command=", "-p", String(process.ppid)], {
      encoding: "utf8",
      timeout: PARENT_LOOKUP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024,
    });
    const text = r.status === 0 ? String(r.stdout ?? "").replace(/\s+/g, " ").trim() : "";
    if (text) parentCommand = text.length > PARENT_COMMAND_MAX ? `${text.slice(0, PARENT_COMMAND_MAX)}…` : text;
    else if (r.error?.code === "ETIMEDOUT" || r.signal) parentCommand = `? (ps timed out after ${PARENT_LOOKUP_TIMEOUT_MS} ms)`;
    else if (r.error) parentCommand = `? (ps ${r.error.code ?? r.error.message})`;
    else parentCommand = `? (ps exit ${r.status}, no output)`;
  } catch (err) {
    parentCommand = `? (ps ${err?.code ?? "failed"})`;
  }
  return parentCommand;
}

/** The `ctx={…}` tag on a line: session id, cwd, parent pid and command. Never throws. */
function contextTag(env) {
  try {
    const session = hookInput.session_id ?? env.LEDGER_SESSION_ID ?? null;
    let cwd = hookInput.cwd;
    if (!cwd) {
      try {
        cwd = process.cwd();
      } catch {
        cwd = null;
      }
    }
    return ` ctx=${JSON.stringify({ session, cwd, ppid: process.ppid, parent: parentCommandLine() })}`;
  } catch {
    return "";
  }
}

/**
 * Append one line to the errors log; never throws. The line is
 * `<iso> <hook> <message> ctx={"session","cwd","ppid","parent"} [db <path>]`, the db being the one
 * this process's config resolved (lib/config.mjs currentLogDb); the db suffix is left out before
 * any config was loaded. Lines from ledger 0.4.0 and older have no ctx tag.
 */
export function logError(hook, message, env = process.env) {
  try {
    const dir = stateDir(env);
    mkdirSync(dir, { recursive: true });
    const db = currentLogDb();
    appendFileSync(join(dir, "errors.log"), `${nowIso()} ${hook} ${String(message).replace(/\s+/g, " ").trim()}${contextTag(env)}${db ? ` [db ${db}]` : ""}\n`);
  } catch {
    /* nowhere to log; the hook still fails open */
  }
}

/** The errors log's path. */
export function errorsLogPath(env = process.env) {
  return join(stateDir(env), "errors.log");
}

/**
 * The errors log lines written at or after `since` (ms), oldest first: { at, hook, db, message, ctx }
 * (`db` null for an untagged line: one written before config loaded, or by ledger 0.2.x; `ctx`
 * the parsed ctx tag, null on a line without one, and never part of `message`). With
 * `db` given, only the lines tagged with that database. A missing or unreadable log is no lines;
 * a line that does not start with an ISO stamp is skipped.
 */
export function readErrors(env = process.env, { since = 0, db = undefined } = {}) {
  let text = "";
  try {
    text = readFileSync(errorsLogPath(env), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(\S+)\s?(.*)$/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t) || t < since) continue;
    const tag = /^(.*) \[db (.*)\]$/.exec(m[3]);
    let message = tag ? tag[1] : m[3];
    let ctx = null;
    const c = /^(.*) ctx=(\{.*\})$/.exec(message);
    if (c) {
      try {
        ctx = JSON.parse(c[2]);
        message = c[1];
      } catch {
        /* not our tag: leave the message whole */
      }
    }
    const entry = { at: m[1], hook: m[2], db: tag ? tag[2] : null, message, ctx };
    if (db !== undefined && entry.db !== db) continue;
    out.push(entry);
  }
  return out;
}

/**
 * @param name   the hook's name as it appears in messages (`SessionStart`, …)
 * @param fn     (input) → object | null | Promise<…>
 * @param opts   { quiet: true } for events that discard systemMessage (SessionEnd)
 */
export async function runHook(name, fn, { quiet = false, stdin = 0, exit = (code) => process.exit(code), write = (s) => process.stdout.write(s) } = {}) {
  let input;
  try {
    input = JSON.parse(readFileSync(stdin, "utf8") || "{}");
    if (!input || typeof input !== "object") throw new Error("payload is not an object");
    hookInput = { session_id: typeof input.session_id === "string" ? input.session_id : null, cwd: typeof input.cwd === "string" ? input.cwd : null };
  } catch (err) {
    logError(name, `stdin not JSON: ${err.message}`);
    if (!quiet) write(JSON.stringify({ systemMessage: `ledger ${name} failed open: stdin not JSON` }));
    return exit(0);
  }
  try {
    const out = await fn(input);
    if (out && typeof out === "object" && Object.keys(out).length) write(JSON.stringify(out));
  } catch (err) {
    const message = err?.message ?? String(err);
    logError(name, `${message}${err?.stack ? ` | ${err.stack.split("\n").slice(1, 3).join(" ")}` : ""}`);
    if (!quiet) write(JSON.stringify({ systemMessage: `ledger ${name} failed open: ${message}` }));
  }
  return exit(0);
}

/** Join notice lines into one systemMessage field, or nothing when there are none. */
export function noticeField(notices) {
  return notices.length ? { systemMessage: notices.join("\n") } : {};
}

/** True when the module at `importMetaUrl` is the script node was started with (not an import). */
export function invokedDirectly(importMetaUrl) {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
