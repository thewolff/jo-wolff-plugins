#!/usr/bin/env node
// judge.mjs — the shared judge dispatch. COPIED into a plugin that asks a model to grade
// something (plugin-kit/lib/judge.mjs → <plugin>/lib/judge.mjs, byte for byte; the kit's
// test/judge.test.mjs diffs every shipped copy against this one). Node builtins only, so the
// copy works wherever the plugin is installed, with no sibling plugin present.
//
// THE COMMAND
//   One string, run through /bin/sh as the leader of its own process group. Two forms:
//     - contains the literal {prompt}: every occurrence is replaced by the shell-escaped prompt;
//     - no placeholder: the command runs as-is and the prompt is piped to its stdin.
//   Example: `codex exec --skip-git-repo-check -` (the trailing `-` reads the prompt from stdin),
//   or `claude -p --output-format json`. Confirm a command with `node lib/judge.mjs setup`,
//   which makes one test call before it writes anything.
//
// WHERE THE COMMAND COMES FROM (resolveJudgeCommand), first found wins:
//   1. env[pluginKey.envVar]                    tests and one-off overrides, e.g. LEDGER_JUDGE_BIN
//   2. pluginKey.command                        the plugin's own setting, passed in by the caller
//   3. ${XDG_CONFIG_HOME:-~/.config}/judge/config.json   { "command", "timeoutMs" }: the shared
//                                               file every plugin reads, written by `setup`
//   4. ~/.claude/i-have-audhd.json .enforcement.judgeCommand   legacy, read-only: the profile
//                                               i-have-audhd wrote before the shared file existed
//                                               ($I_HAVE_AUDHD_PROFILE names another path)
//   The result names its `source`, so a warning or a skipped.log line can say which file supplied
//   the command: a plugin key silently overriding the shared file is the surprise to avoid.
//   The timeout is pluginKey.timeoutMs, else the shared file's timeoutMs, else DEFAULT_TIMEOUT_MS,
//   whichever source supplied the command.
//   A shared file that exists but is malformed (unreadable, not JSON, not an object) ends the
//   search there: steps 1 and 2 still win, but the legacy profile is not consulted in its place,
//   so a typo never quietly swaps in an older command. `which` names the file and the parse error.
//
// OUTPUT PARSING
//   STDOUT ONLY is captured: judge CLIs print banners and errors on stderr, and merging the streams
//   puts noise in front of the answer. json mode takes the LAST top-level JSON object on stdout
//   (string-aware brace matching, so a `}` inside a JSON string does not end it); a
//   {"type":"result","result":"…"} envelope, the shape `claude -p --output-format json` emits, is
//   unwrapped by scanning its `result` string for the last object inside. yesno mode takes the
//   last non-empty stdout line, strips leading markdown and punctuation, and reads one word.
//
// FAILURE IS OPEN AND LOUD, AND NEVER A PASS
//   runJudge never throws. json mode returns the object, or { error, detail, stderr } where error
//   is one of ERRORS: "timeout" (no exit within timeoutMs), "nonzero" (exit status not 0),
//   "unparseable" (exit 0, no JSON object on stdout), "spawn-failed" (/bin/sh could not start, or
//   no command). yesno mode returns "yes", "no", or "unverified" for every failure, including an
//   answer that is neither word; dispatch() is the layer underneath for a caller that needs the
//   reason as well. `stderr` carries the last STDERR_KEPT characters of the judge's stderr, where
//   a CLI says why it failed (not logged in, rate limited, unknown flag).
//
// CLEANUP: the judge's /bin/sh is detached into a fresh process group. When the dispatch settles
//   (exit, timeout, or spawn error) one negative-pid SIGKILL reaps whatever of that group is still
//   alive and the pipes are released, so a pipeline stage or a wrapper's child cannot hold the
//   caller's process open. Inside a plugin-kit hook-runner thread the group is also registered
//   with the runner ({ kitReap } on spawn, { kitReaped } on settle), so a runner that gives up at
//   its deadline and terminates the thread kills the group too instead of orphaning it.
//
// CLI
//   node lib/judge.mjs setup [--command <cmd>] [--timeout-ms <n>] [--yes] [--force]
//     asks for the command when --command is absent, makes one test call, shows the JSON it will
//     write, and writes the shared file atomically (tmp + rename, mode 0600 for a new file, other
//     keys kept) after a yes. A failed test call refuses to write unless --force; so does an
//     existing shared file that is malformed (its other keys cannot be kept, so --force replaces
//     it whole). Exit 0 written; 1 refused or the test failed; 2 usage.
//   node lib/judge.mjs which [--env-var <NAME>]
//     prints command, timeoutMs and source as resolved here, or where it looked, after a
//     `malformed: <path>: <error>` line when the shared file is malformed. Exit 0 found; 1 none.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

export const DEFAULT_TIMEOUT_MS = 30_000;
/** The failure classes runJudge's json mode and dispatch() report in `error`. */
export const ERRORS = Object.freeze(["timeout", "nonzero", "unparseable", "spawn-failed"]);
const STDERR_KEPT = 4_000;
const STDOUT_CAP = 2_000_000;
// Inside a lib/hook-runner.mjs handler thread whose runner reaps registered groups (workerData.kitReap;
// an older runner would take the message for the handler's answer): a message to its main thread.
// Elsewhere a no-op.
const toRunner = !isMainThread && parentPort && workerData?.kitHook === true && workerData?.kitReap === true
  ? (msg) => {
      try {
        parentPort.postMessage(msg);
      } catch {
        // the runner is gone; nothing to tell
      }
    }
  : () => {};

const homeOf = (env, home) => home || env.HOME || homedir();

/** `${XDG_CONFIG_HOME:-~/.config}/judge/config.json`. */
export function sharedConfigPath({ env = process.env, home, xdgConfigHome } = {}) {
  const base = xdgConfigHome || (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim()) || join(homeOf(env, home), ".config");
  return join(base, "judge", "config.json");
}

/** The i-have-audhd profile, the legacy place a judge command lives ($I_HAVE_AUDHD_PROFILE, else ~/.claude/i-have-audhd.json). */
export function legacyProfilePath({ env = process.env, home } = {}) {
  const explicit = env.I_HAVE_AUDHD_PROFILE;
  if (explicit && explicit.trim()) return explicit.trim();
  return join(homeOf(env, home), ".claude", "i-have-audhd.json");
}

/** The JSON object at `path`, or null when the file is absent, unreadable, not JSON, or not an object. */
function readJsonObject(path) {
  return readJsonFile(path).value;
}

/** { value, error }: value is the JSON object at `path`; both null when the file is absent; error says why when it exists but is unreadable, not JSON, or not an object. */
function readJsonFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { value: null, error: err.code === "ENOENT" || err.code === "ENOTDIR" ? null : err.code || err.message };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { value: parsed, error: null };
    return { value: null, error: "not a JSON object" };
  } catch (err) {
    return { value: null, error: err.message };
  }
}

/**
 * The shared file as read: { path, config, malformed }. config is its object, or null; malformed
 * is `<path>: <error>` when the file exists and cannot be used, else null.
 */
export function readSharedConfig({ env = process.env, home, xdgConfigHome } = {}) {
  const path = sharedConfigPath({ env, home, xdgConfigHome });
  const { value, error } = readJsonFile(path);
  return { path, config: value, malformed: error ? `${path}: ${error}` : null };
}

const isCommand = (v) => typeof v === "string" && v.trim() !== "";
const asTimeout = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);

/**
 * The judge command for a plugin, or null when none is configured anywhere, or when steps 1 and 2
 * supply none and the shared file is malformed (readSharedConfig says why).
 * @param {object} o
 * @param {{ envVar?: string, command?: string|null, timeoutMs?: number, source?: string }} [o.pluginKey]
 *   envVar: the plugin's override variable; command: the plugin's own configured command (already
 *   read by the caller); source: how to name that setting (`review.judgeCommand in <path>`).
 * @param {object} [o.env]  defaults to process.env
 * @param {string} [o.home]  overrides $HOME; [o.xdgConfigHome] overrides $XDG_CONFIG_HOME
 * @returns {{ command: string, timeoutMs: number, source: string } | null}
 */
export function resolveJudgeCommand({ pluginKey = {}, env = process.env, home, xdgConfigHome } = {}) {
  const { path: sharedPath, config: shared, malformed } = readSharedConfig({ env, home, xdgConfigHome });
  const timeoutMs = asTimeout(pluginKey.timeoutMs) ?? asTimeout(shared?.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const found = (command, source) => ({ command, timeoutMs, source });
  if (pluginKey.envVar && isCommand(env[pluginKey.envVar])) return found(env[pluginKey.envVar], `env ${pluginKey.envVar}`);
  if (isCommand(pluginKey.command)) return found(pluginKey.command, pluginKey.source || "plugin config");
  if (malformed) return null;
  if (shared && isCommand(shared.command)) return found(shared.command, sharedPath);
  const legacyPath = legacyProfilePath({ env, home });
  const legacy = readJsonObject(legacyPath)?.enforcement?.judgeCommand;
  if (isCommand(legacy)) return found(legacy, `enforcement.judgeCommand in ${legacyPath} (legacy)`);
  return null;
}

/** Where resolveJudgeCommand looks, in order, for a `which` or a "no judge" message. */
export function lookedIn({ pluginKey = {}, env = process.env, home, xdgConfigHome } = {}) {
  const places = [];
  if (pluginKey.envVar) places.push(`env ${pluginKey.envVar}`);
  if (pluginKey.source) places.push(pluginKey.source);
  places.push(sharedConfigPath({ env, home, xdgConfigHome }), `enforcement.judgeCommand in ${legacyProfilePath({ env, home })}`);
  return places;
}

export function shellEscape(text) {
  return "'" + String(text).replace(/'/g, `'\\''`) + "'";
}

/** Every top-level {...} span in `text`, in order; braces inside JSON strings do not count. */
export function topLevelJsonSpans(text) {
  const spans = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) spans.push(text.slice(start, i + 1));
      }
    }
  }
  return spans;
}

/**
 * The last JSON object on `stdout`, or null. A `{"type":"result","result":"<string>"}` envelope
 * (claude -p --output-format json) is unwrapped to the last object inside its result string, when
 * there is one; otherwise the envelope itself is the answer.
 */
export function lastJsonObject(stdout) {
  const spans = topLevelJsonSpans(String(stdout ?? ""));
  for (let i = spans.length - 1; i >= 0; i--) {
    let parsed;
    try {
      parsed = JSON.parse(spans[i]);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    if (parsed.type === "result" && typeof parsed.result === "string") {
      const inner = lastJsonObject(parsed.result);
      if (inner) return inner;
    }
    return parsed;
  }
  return null;
}

/** The one-word answer among `words` on the last non-empty line of `stdout`, or null. */
export function parseAnswer(stdout, words = ["yes", "no"]) {
  const last = String(stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (!last) return null;
  const word = /^[\s*_`"'>#-]*([a-z]+)/i.exec(last)?.[1]?.toLowerCase();
  return words.includes(word) ? word : null;
}

/**
 * One judge run. Resolves { ok: true, stdout, stderr, code: 0 } or
 * { ok: false, error: <ERRORS member>, detail, stdout, stderr, code }. Never rejects.
 */
export function dispatch(prompt, { command, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    const cmd = typeof command === "string" ? command : "";
    if (!cmd.trim()) {
      resolve({ ok: false, error: "spawn-failed", detail: "no command", stdout: "", stderr: "", code: null });
      return;
    }
    const placeholder = cmd.includes("{prompt}");
    const line = placeholder ? cmd.split("{prompt}").join(shellEscape(prompt)) : cmd;
    const budget = Math.max(1, Math.floor(Number(timeoutMs)) || DEFAULT_TIMEOUT_MS);
    let child;
    try {
      child = spawn("/bin/sh", ["-c", line], { detached: true, stdio: ["pipe", "pipe", "pipe"], env });
    } catch (err) {
      resolve({ ok: false, error: "spawn-failed", detail: err.code || err.message, stdout: "", stderr: "", code: null });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    if (child.pid) toRunner({ kitReap: child.pid });
    // Every exit path, once: stop the timer, reap the judge's process group, release the pipes.
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // ESRCH: nothing of the group is left, the usual case after a clean exit
      }
      if (child.pid) toRunner({ kitReaped: child.pid });
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ stdout, stderr, code: null, ...result });
    };
    const timer = setTimeout(() => settle({ ok: false, error: "timeout", detail: `no exit within ${budget} ms` }), budget);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < STDOUT_CAP) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_KEPT);
    });
    child.on("error", (err) => settle({ ok: false, error: "spawn-failed", detail: err.code || err.message }));
    child.on("close", (code) => settle(code === 0 ? { ok: true, code } : { ok: false, error: "nonzero", detail: `exit ${code}`, code }));
    // The no-placeholder form receives the prompt on stdin; the placeholder form ignores it.
    child.stdin.on("error", () => {});
    child.stdin.end(placeholder ? undefined : String(prompt));
  });
}

/** True for the { error } object runJudge's json mode returns on a failure. */
export function isJudgeError(result) {
  return Boolean(result) && typeof result === "object" && ERRORS.includes(result.error);
}

/**
 * runJudge(prompt, { command, timeoutMs, mode })
 *   mode "json" (default): the last JSON object on stdout, or { error, detail, stderr }.
 *   mode "yesno": "yes" | "no" | "unverified".
 *   Never throws.
 */
export async function runJudge(prompt, { command, timeoutMs = DEFAULT_TIMEOUT_MS, mode = "json", env = process.env } = {}) {
  const run = await dispatch(prompt, { command, timeoutMs, env });
  if (mode === "yesno") return run.ok ? (parseAnswer(run.stdout) ?? "unverified") : "unverified";
  if (!run.ok) return { error: run.error, detail: run.detail, stderr: run.stderr };
  const obj = lastJsonObject(run.stdout);
  if (!obj) return { error: "unparseable", detail: "exit 0 but no JSON object on stdout", stderr: run.stderr };
  return obj;
}

// ─── setup ──────────────────────────────────────────────────────────────────────────────

const TEST_PROMPT = 'Reply with exactly this JSON object on one line and nothing else: {"ok": true}';

/** One test call. { ok, ms, error, detail, stderr, answer }. */
export async function testCall(command, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env) {
  const started = Date.now();
  const answer = await runJudge(TEST_PROMPT, { command, timeoutMs, mode: "json", env });
  const ms = Date.now() - started;
  if (isJudgeError(answer)) return { ok: false, ms, error: answer.error, detail: answer.detail, stderr: answer.stderr };
  return { ok: true, ms, answer };
}

/**
 * Write { command, timeoutMs } into the shared file, keeping its other keys. Returns the path.
 * Throws on I/O failure, and when the existing file is malformed unless `force` (then the file is
 * replaced whole: there are no other keys to keep).
 */
export function writeSharedConfig({ command, timeoutMs, env = process.env, home, xdgConfigHome, force = false }) {
  const { path, config, malformed } = readSharedConfig({ env, home, xdgConfigHome });
  if (malformed && !force) throw new Error(`malformed: ${malformed}; not overwriting it without force`);
  const next = { ...(config ?? {}), command, timeoutMs };
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // a new file is private to its owner
  }
  const tmp = `${path}.setup-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  return path;
}

const USAGE =
  "usage: node judge.mjs setup [--command <cmd>] [--timeout-ms <n>] [--yes] [--force]\n" +
  "       node judge.mjs which [--env-var <NAME>]\n";

function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const out = { verb, command: null, timeoutMs: null, yes: false, force: false, envVar: null };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--command" && rest[i + 1] !== undefined) out.command = rest[++i];
    else if (t === "--timeout-ms" && rest[i + 1] !== undefined) out.timeoutMs = asTimeout(rest[++i]);
    else if (t === "--env-var" && rest[i + 1] !== undefined) out.envVar = rest[++i];
    else if (t === "--yes") out.yes = true;
    else if (t === "--force") out.force = true;
    else return null;
  }
  if (verb !== "setup" && verb !== "which") return null;
  return out;
}

// Line-at-a-time answers that work the same for a terminal and a pipe. EOF answers null.
function makeAsker(stdin, write) {
  const rl = createInterface({ input: stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt) {
      write(prompt);
      const { value, done } = await lines.next();
      if (done) {
        write("\n");
        return null;
      }
      return value.trim();
    },
    close: () => rl.close(),
  };
}

const FAILURE_WORDS = {
  timeout: "it printed no answer within the timeout",
  nonzero: "it exited non-zero (127 usually means the command is not on PATH; otherwise check it is signed in)",
  unparseable: "it exited 0 but printed no JSON object on stdout",
  "spawn-failed": "/bin/sh could not start it",
};

/** The CLI. `io` is for tests: { env, stdin, write, err }. Returns the exit code. */
export async function main(argv = process.argv.slice(2), io = {}) {
  const env = io.env ?? process.env;
  const write = io.write ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  const args = parseArgs(argv);
  if (!args) {
    err(USAGE);
    return 2;
  }
  if (args.verb === "which") {
    const pluginKey = args.envVar ? { envVar: args.envVar } : {};
    const { malformed } = readSharedConfig({ env });
    if (malformed) write(`malformed: ${malformed}\n`);
    const r = resolveJudgeCommand({ pluginKey, env });
    if (!r) {
      write(malformed ? `no judge resolved: the shared file is malformed, so the legacy profile was not consulted; fix it or run setup --force\n` : `no judge configured; looked in: ${lookedIn({ pluginKey, env }).join(", ")}\n`);
      return 1;
    }
    write(`command=${r.command}\ntimeoutMs=${r.timeoutMs}\nsource=${r.source}\n`);
    return 0;
  }
  const { path, config: current, malformed } = readSharedConfig({ env });
  write(`judge setup: the shared judge command, read by every plugin that judges.\nfile: ${path}\n`);
  if (malformed) {
    write(`current: malformed: ${malformed}\n`);
    if (!args.force) {
      err("judge setup: not written; the shared file is not valid JSON and its other keys cannot be kept. Fix it by hand, or pass --force to replace it whole\n");
      return 1;
    }
  } else {
    write(current && isCommand(current.command) ? `current: ${JSON.stringify(current.command)}\n` : "current: none\n");
  }
  const asker = makeAsker(io.stdin ?? process.stdin, write);
  try {
    let command = args.command;
    if (!isCommand(command)) {
      command = await asker.ask("command (reads the prompt on stdin, or has {prompt} in it): ");
      if (!isCommand(command)) {
        err("judge setup: no command given\n");
        return 2;
      }
    }
    const timeoutMs = args.timeoutMs ?? asTimeout(current?.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
    write(`testing: ${command}\n`);
    const t = await testCall(command, timeoutMs, env);
    if (t.ok) {
      write(`ok in ${t.ms} ms: ${JSON.stringify(t.answer)}\n`);
    } else {
      const tail = String(t.stderr ?? "").replace(/\s+/g, " ").trim().slice(-300);
      write(`failed in ${t.ms} ms: ${FAILURE_WORDS[t.error] ?? t.error} (${t.detail})${tail ? `; stderr: ${tail}` : ""}\n`);
      if (!args.force) {
        err("judge setup: not written; fix the command, or pass --force to write it anyway\n");
        return 1;
      }
    }
    const next = { ...(current ?? {}), command, timeoutMs };
    write(`will write:\n${JSON.stringify(next, null, 2)}\n`);
    if (!args.yes) {
      const a = await asker.ask("write? [y/N] ");
      if (!a || !/^y(es)?$/i.test(a)) {
        write("not written\n");
        return 1;
      }
    }
    writeSharedConfig({ command, timeoutMs, env, force: args.force });
    write(`written: ${path}\n`);
    return 0;
  } finally {
    asker.close();
  }
}

/** True when this file is the script node was started with (not an import, not a worker thread). */
function invokedDirectly() {
  if (!isMainThread || !process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then((code) => process.exit(code));
}
