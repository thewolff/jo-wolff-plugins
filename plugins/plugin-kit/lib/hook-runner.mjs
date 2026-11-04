// hook-runner.mjs — the fail-open runner every plugin's hooks go through. COPIED into a new
// plugin by the `new-plugin` skill (plugin-kit/lib/hook-runner.mjs → <plugin>/lib/hook-runner.mjs);
// each plugin owns its copy, so a change here reaches a plugin only when someone copies it again.
//
// runHook(name, fn, { plugin, quiet, deadlineMs }) reads stdin, parses it as JSON (empty stdin is
// `{}`), calls fn(input) and prints what fn returns: an object → JSON on stdout, null → nothing.
// Then it exits 0. Whatever goes wrong, it still exits 0 with an "allow":
//
//   stdin is not JSON, or not an object   one errors.log line + { systemMessage } (unless quiet)
//   fn throws or rejects                  one errors.log line + { systemMessage } (unless quiet)
//   no answer at the deadline             one errors.log line + { systemMessage }, exit 0 at once
//                                         (default 4 s: inside Claude Code's 5 s hook budget, so
//                                         the host never kills the hook and loses the message)
//
// The deadline is one timer started before stdin is read, and it counts everything: a stdin the
// host holds open, a handler promise that never settles (the timer is referenced, so it fires
// with no other handle alive and exits the process itself), and a handler that blocks the loop
// past the deadline (its answer arrives late and is dropped: fail open, never a late block).
//
// errors.log is `${XDG_STATE_HOME:-~/.local/state}/<plugin>/errors.log`, one line per fault:
// `<iso> <hook> <message>` (a thrown error's line carries two stack frames after ` | `; the
// systemMessage carries the message alone). `quiet` is for events whose JSON output the host discards
// (SessionEnd): the log line is the only trace there.
//
// A hook never exits 2: on the events that can block, exit 2 blocks, and a hook that blocks
// because of its own fault is the one failure a plugin promises never to have.

import { appendFileSync, createReadStream, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEADLINE_MS = 4_000;
const TIMED_OUT = Symbol("timed out");

/** `${XDG_STATE_HOME:-~/.local/state}/<plugin>`. */
export function stateDir(plugin, env = process.env) {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), plugin);
}

/** The errors log's path for `plugin`. */
export function errorsLogPath(plugin, env = process.env) {
  return join(stateDir(plugin, env), "errors.log");
}

/** Append `<iso> <hook> <message>` to the plugin's errors.log; never throws. */
export function logError(plugin, hook, message, env = process.env) {
  try {
    mkdirSync(stateDir(plugin, env), { recursive: true });
    appendFileSync(errorsLogPath(plugin, env), `${new Date().toISOString()} ${hook} ${String(message).replace(/\s+/g, " ").trim()}\n`);
  } catch {
    /* nowhere to log; the hook still fails open */
  }
}

/**
 * All of `stdin` (0 for the process's stdin, another fd, or a path) as text; never settles
 * while the writer holds it open. Fd 0 goes through `process.stdin` (a libuv stream): an fs
 * read of a pipe sits in the thread pool, and `process.exit` waits for it, so the deadline's
 * exit would hang behind the very stdin it is giving up on.
 */
function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    const stream = stdin === 0 ? process.stdin : typeof stdin === "number" ? createReadStream(null, { fd: stdin, autoClose: false }) : createReadStream(stdin);
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (text += chunk));
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });
}

/**
 * @param name   the hook's event name as it appears in messages (`PreToolUse`, …)
 * @param fn     (input, { env }) → object | null | Promise<object | null>
 * @param opts   { plugin: the plugin's name (required: names the state directory and the message),
 *                 quiet: true for events that discard JSON output (SessionEnd),
 *                 deadlineMs: when to give up, counted from here (default 4000) }
 */
export async function runHook(name, fn, { plugin, quiet = false, deadlineMs = DEADLINE_MS, env = process.env, stdin = 0, exit = (code) => process.exit(code), write = (s) => process.stdout.write(s) } = {}) {
  if (!plugin) throw new TypeError("runHook needs { plugin }");
  const started = Date.now();
  let done = false;
  let timer;
  // The one exit: the first caller wins; a late timer or a late answer finds `done` set.
  const finish = (text) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (text) write(text);
    return exit(0);
  };
  const failOpen = (why, detail = "") => {
    if (done) return;
    logError(plugin, name, why + detail, env);
    return finish(quiet ? "" : JSON.stringify({ systemMessage: `${plugin} ${name} failed open: ${why}` }));
  };
  const noAnswer = `no answer within ${deadlineMs} ms`;
  const deadline = new Promise((resolve) => {
    // Referenced on purpose: with nothing else alive (a promise that never settles) this is
    // what ends the process.
    timer = setTimeout(() => {
      failOpen(noAnswer);
      resolve(TIMED_OUT);
    }, deadlineMs);
  });
  let input;
  try {
    const raw = await Promise.race([readStdin(stdin), deadline]);
    if (raw === TIMED_OUT || done) return;
    input = JSON.parse(raw || "{}");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("payload is not an object");
  } catch (err) {
    return failOpen(`stdin not JSON: ${err.message}`);
  }
  try {
    const out = await Promise.race([Promise.resolve().then(() => fn(input, { env })), deadline]);
    if (out === TIMED_OUT || done) return;
    const elapsed = Date.now() - started;
    if (elapsed > deadlineMs) return failOpen(`${noAnswer} (the answer came after ${elapsed} ms)`);
    return finish(out && typeof out === "object" && Object.keys(out).length ? JSON.stringify(out) : "");
  } catch (err) {
    const message = err?.message ?? String(err);
    return failOpen(message, err?.stack ? ` | ${err.stack.split("\n").slice(1, 3).join(" ")}` : "");
  }
}

/** True when the module at `importMetaUrl` is the script node was started with (not an import). */
export function invokedDirectly(importMetaUrl) {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
