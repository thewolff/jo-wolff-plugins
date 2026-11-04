// hookio.mjs — the process shell both Claude Code hooks run in: read the payload from stdin,
// call the hook's `handle`, print its JSON, exit 0. Every path out of here exits 0.
//
// HOW IT FAILS. A payload that is empty, not JSON, or not an object; stdin that is not closed
// within STDIN_DEADLINE_MS; a `handle` that throws: the call (or the stop) is allowed, one
// {"systemMessage": "pattern-check: ..."} line is printed, which Claude Code shows the user, and
// one line naming the hook file and the reason is appended to <state dir>/errors.log. Every
// warning `handle` returns (a corrupt state file, an unparsable config, an unwritable state
// directory) is logged the same way. When errors.log itself cannot be written, the printed
// warning says so; nothing is swallowed silently.
//
// Recovery: rerunning a hook on the same input is safe (the counter is a set of paths; the Stop
// guard is a hash). Retry bound: none; hooks never retry. The deadline keeps a hook inside the
// 5 s budget hooks.json gives it. errors.log is capped: past ERRORS_LOG_MAX bytes it is renamed
// to errors.log.1 (one generation kept) before the next line is written.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stateDir } from "./state.mjs";

export const STDIN_DEADLINE_MS = 2000;
export const ERRORS_LOG_MAX = 1_000_000;

export function errorsLogPath(env = process.env, home = homedir()) {
  return join(stateDir(env, home), "errors.log");
}

/** Appends one line to errors.log. Throws when the log cannot be written; the caller reports that. */
export function logError(file, hook, reason, now = new Date()) {
  mkdirSync(dirname(file), { recursive: true });
  try { if (statSync(file).size > ERRORS_LOG_MAX) renameSync(file, `${file}.1`); } catch { /* absent: nothing to rotate */ }
  appendFileSync(file, `${now.toISOString()} ${hook} ${String(reason).replace(/\s*\n\s*/g, " ")}\n`);
}

/** Reads all of stdin, or what arrived before the deadline. */
export function readStdin(deadlineMs = STDIN_DEADLINE_MS, stream = process.stdin) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const text = () => Buffer.concat(chunks).toString("utf8");
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.pause();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ text: text(), timedOut: true, error: null }), deadlineMs);
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => finish({ text: text(), timedOut: false, error: null }));
    stream.on("error", (e) => finish({ text: "", timedOut: false, error: e }));
    stream.resume();
  });
}

/**
 * The hook's output for one stdin text: parse, handle, and turn every fault into an allow plus a
 * warning. Pure apart from what `handle` does; logging is the caller's.
 * @param {{ event: string, allowed: string, handle: (input: object) => object|null }} hook
 * @param {{ text: string, timedOut: boolean, error: Error|null }} stdin
 */
export function respond({ event, allowed, handle }, { text, timedOut, error }) {
  const fault = (why) => ({ systemMessage: `pattern-check: the ${event} hook ${why}; ${allowed}` });
  if (error) return fault(`could not read stdin (${error.message})`);
  if (timedOut) return fault(`did not get a closed stdin within ${STDIN_DEADLINE_MS / 1000} s`);
  if (text.trim() === "") return fault(`got empty stdin, not a ${event} payload`);
  let input;
  try { input = JSON.parse(text); } catch (e) { return fault(`got stdin that is not JSON (${e.message})`); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return fault(`got a ${event} payload that is not a JSON object`);
  try {
    return handle(input);
  } catch (e) {
    return fault(`failed (${e?.message ?? e})`);
  }
}

/** Runs a hook as a process: stdin in, JSON out, errors.log on any warning, exit 0. */
export async function runHook({ file, event, allowed, handle }) {
  let out;
  try {
    out = respond({ event, allowed, handle }, await readStdin());
  } catch (e) {
    out = { systemMessage: `pattern-check: the ${event} hook failed (${e?.message ?? e}); ${allowed}` };
  }
  if (out?.systemMessage) {
    try {
      logError(errorsLogPath(), file, out.systemMessage.replace(/^pattern-check: /, ""));
    } catch (e) {
      out.systemMessage += ` (and errors.log could not be written: ${e.message})`;
    }
  }
  if (out) process.stdout.write(JSON.stringify(out), () => process.exit(0));
  else process.exit(0);
}
