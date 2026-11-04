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

import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentLogDb, stateDir } from "./config.mjs";
import { nowIso } from "./time.mjs";

/**
 * Append one line to the errors log; never throws. The line is
 * `<iso> <hook> <message> [db <path>]`, the db being the one this process's config resolved
 * (lib/config.mjs currentLogDb); the suffix is left out before any config was loaded.
 */
export function logError(hook, message, env = process.env) {
  try {
    const dir = stateDir(env);
    mkdirSync(dir, { recursive: true });
    const db = currentLogDb();
    appendFileSync(join(dir, "errors.log"), `${nowIso()} ${hook} ${String(message).replace(/\s+/g, " ").trim()}${db ? ` [db ${db}]` : ""}\n`);
  } catch {
    /* nowhere to log; the hook still fails open */
  }
}

/** The errors log's path. */
export function errorsLogPath(env = process.env) {
  return join(stateDir(env), "errors.log");
}

/**
 * The errors log lines written at or after `since` (ms), oldest first: { at, hook, db, message }
 * (`db` null for an untagged line: one written before config loaded, or by ledger 0.2.x). With
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
    const entry = { at: m[1], hook: m[2], db: tag ? tag[2] : null, message: tag ? tag[1] : m[3] };
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
