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
import { stateDir } from "./config.mjs";
import { nowIso } from "./time.mjs";

/** Append one line to the errors log; never throws. */
export function logError(hook, message, env = process.env) {
  try {
    const dir = stateDir(env);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "errors.log"), `${nowIso()} ${hook} ${String(message).replace(/\s+/g, " ").trim()}\n`);
  } catch {
    /* nowhere to log; the hook still fails open */
  }
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
