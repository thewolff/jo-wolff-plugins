// hook-runner.mjs — the fail-open runner every plugin's hooks go through. COPIED into a new
// plugin by the `new-plugin` skill (plugin-kit/lib/hook-runner.mjs → <plugin>/lib/hook-runner.mjs);
// each plugin owns its copy, so a change here reaches a plugin only when someone copies it again.
//
// runHook(name, handlerUrl, { plugin, quiet, deadlineMs }) reads stdin, parses it as JSON (empty
// stdin is `{}`), runs the hook module's exported `handle(input, { env })` in a worker thread and
// prints what it returns: an object → JSON on stdout, null → nothing. It exits 0 once stdout has
// taken the whole answer (an exit right after the write loses everything past one pipe buffer,
// 64 KiB, when stdout is a pipe the host has not read yet). Whatever goes wrong, it still exits 0
// with an "allow":
//
//   stdin is not JSON, or not an object   one errors.log line + { systemMessage } (unless quiet)
//   handle throws or rejects              one errors.log line + { systemMessage } (unless quiet)
//   no answer at the deadline             one errors.log line + { systemMessage }, exit 0 at once
//                                         (default 4 s: inside Claude Code's 5 s hook budget, so
//                                         the host never kills the hook and loses the message)
//   stdout not drained by the deadline    one errors.log line, exit 0 at once; nothing more is
//                                         written (bytes the pipe already took cannot be recalled,
//                                         so a host that stops reading mid-answer sees a cut answer)
//
// The deadline is one referenced timer on the main thread, started before stdin is read, and the
// handler runs on another thread (a `node:worker_threads` Worker whose script is this module), so
// the timer fires whatever the handler is doing: a stdin the host holds open, a promise that never
// settles, a synchronous loop that never yields. At the deadline the main thread writes the log
// line, terminates the worker, prints the message (allowed DRAIN_MIN_MS to reach stdout) and
// exits; an answer that would have come later is dropped (fail open, never a late block). An
// answer that does come is written with a completion callback and the exit waits for it, but
// only until the same deadline. The main thread does nothing but wait, so nothing of the
// plugin's can block it.
//
// What the handler thread is told: its env carries HOOK_RUNNER_STARTED_AT_MS (the main thread's
// Date.now() when runHook began, before stdin) and HOOK_RUNNER_DEADLINE_MS, so a handler that
// budgets its own work (a judge call) counts from the runner's clock, not from its own late start.
// A process group the handler spawns detached can be handed to the runner: workerData.kitReap is
// true (a runner older than this never set it, so a handler checks it before posting), and the
// thread posts { kitReap: <pgid> } when it starts one and { kitReaped: <pgid> } when it has reaped
// it itself (lib/judge.mjs does both inside this runner's thread); every group still registered
// when the runner takes an answer or gives up at the deadline (before it drains stdout) gets one
// negative-pid SIGKILL, so terminating the thread never leaves its children running.
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
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

export const DEADLINE_MS = 4_000;
const TIMED_OUT = Symbol("timed out");
/** The least time the deadline's own message gets to reach stdout (ms). */
const DRAIN_MIN_MS = 50;

/** Write `text` to stdout and call `done(err?)` once it has all been handed to the OS. */
function writeStdout(text, done) {
  // A host that closed the pipe (EPIPE) reaches `done`, never an uncaught 'error' and exit 1.
  process.stdout.once("error", done);
  process.stdout.write(text, done);
}

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
 * @param name        the hook's event name as it appears in messages (`PreToolUse`, …)
 * @param handlerUrl  the hook module's `import.meta.url`; it exports `handle(input, { env })` →
 *                    object | null | Promise<object | null>, run on a worker thread
 * @param opts        { plugin: the plugin's name (required: names the state directory and the message),
 *                      quiet: true for events that discard JSON output (SessionEnd),
 *                      deadlineMs: when to give up, counted from here (default 4000) }
 */
export async function runHook(name, handlerUrl, { plugin, quiet = false, deadlineMs = DEADLINE_MS, env = process.env, stdin = 0, exit = (code) => process.exit(code), write = writeStdout } = {}) {
  const startedAt = Date.now();
  if (!plugin) throw new TypeError("runHook needs { plugin }");
  if (typeof handlerUrl !== "string") throw new TypeError("runHook needs the hook module's import.meta.url (a string); it exports handle()");
  const deadlineAt = startedAt + deadlineMs;
  let done = false;
  let timer;
  let worker = null;
  // Process groups the handler thread started and has not reaped itself.
  const groups = new Set();
  // The one exit: the first caller wins; a late timer or a late answer finds `done` set. The
  // answer is written whole before the exit, bounded by what is left of the deadline (at least
  // DRAIN_MIN_MS, so the deadline's own message gets its write); past that the write is abandoned.
  const finish = (text) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    worker?.terminate().catch(() => {});
    for (const pgid of groups) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // ESRCH: the group is already gone
      }
    }
    if (!text) return exit(0);
    let drain;
    let ended = false;
    const end = (fault) => {
      if (ended) return;
      ended = true;
      clearTimeout(drain);
      if (fault) logError(plugin, name, fault, env);
      exit(0);
    };
    const drainMs = Math.max(deadlineAt - Date.now(), DRAIN_MIN_MS);
    drain = setTimeout(() => end(`stdout not drained within ${drainMs} ms: the host is not reading it; the rest of a ${Buffer.byteLength(text)}-byte answer was dropped`), drainMs);
    try {
      write(text, (err) => end(err ? `stdout write failed: ${err.message}` : null));
    } catch (err) {
      end(`stdout write failed: ${err.message}`);
    }
  };
  const failOpen = (why, detail = "") => {
    if (done) return;
    logError(plugin, name, why + detail, env);
    return finish(quiet ? "" : JSON.stringify({ systemMessage: `${plugin} ${name} failed open: ${why}` }));
  };
  const deadline = new Promise((resolve) => {
    // Referenced on purpose: with nothing else alive (a promise that never settles) this is
    // what ends the process.
    timer = setTimeout(() => {
      failOpen(`no answer within ${deadlineMs} ms`);
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
  const answer = new Promise((resolve) => {
    try {
      // argv is emptied so the hook module, imported in the worker, sees it was not invoked
      // directly and does not start a runner of its own.
      worker = new Worker(new URL(import.meta.url), { workerData: { kitHook: true, kitReap: true, module: handlerUrl, input }, env: { ...env, HOOK_RUNNER_STARTED_AT_MS: String(startedAt), HOOK_RUNNER_DEADLINE_MS: String(deadlineMs) }, argv: [], stdout: true, stderr: true });
    } catch (err) {
      return resolve({ error: { message: `could not start the handler thread: ${err.message}` } });
    }
    worker.on("message", (msg) => {
      if (msg && typeof msg === "object" && Number.isInteger(msg.kitReap) && msg.kitReap > 0) return void groups.add(msg.kitReap);
      if (msg && typeof msg === "object" && Number.isInteger(msg.kitReaped)) return void groups.delete(msg.kitReaped);
      resolve(msg);
    });
    worker.on("error", (err) => resolve({ error: { message: err?.message ?? String(err), stack: err?.stack } }));
    // After the answer's own event, so a message posted just before the thread ended wins.
    worker.on("exit", (code) => setImmediate(() => resolve({ error: { message: `the handler thread ended (code ${code}) without an answer: handle() returned a promise nothing will settle` } })));
  });
  const result = await Promise.race([answer, deadline]);
  if (result === TIMED_OUT || done) return;
  if (result.error) return failOpen(result.error.message, result.error.stack ? ` | ${result.error.stack.split("\n").slice(1, 3).join(" ")}` : "");
  const out = result.out;
  return finish(out && typeof out === "object" && Object.keys(out).length ? JSON.stringify(out) : "");
}

// The worker half: import the hook module, run its handle(), post the answer or the error.
if (!isMainThread && workerData?.kitHook === true) {
  const post = (msg) => parentPort.postMessage(msg);
  import(workerData.module)
    .then((m) => {
      if (typeof m.handle !== "function") throw new Error(`${workerData.module} exports no handle()`);
      return m.handle(workerData.input, { env: process.env });
    })
    .then((out) => {
      try {
        post({ out: out ?? null });
      } catch (err) {
        post({ error: { message: `the handler's answer cannot be sent to the main thread: ${err.message}` } });
      }
    })
    .catch((err) => post({ error: { message: err?.message ?? String(err), stack: err?.stack } }));
}

/**
 * True when the module at `importMetaUrl` is the script node was started with (not an import,
 * and not the handler thread, where argv is empty).
 */
export function invokedDirectly(importMetaUrl) {
  if (!isMainThread) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
