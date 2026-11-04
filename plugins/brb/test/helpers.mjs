// test/helpers.mjs — a sandbox (temp HOME and XDG dirs) and a runner that spawns a hook the way
// the host does: node <hook> with the payload on stdin, the sandbox env, cwd the sandbox work dir.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function box() {
  const root = mkdtempSync(join(tmpdir(), "brb-test-"));
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: join(root, "tmp"),
    BRB_DESKTOP_NOTIFY: "off",
  };
  for (const d of Object.values(env).slice(1, -1)) mkdirSync(d, { recursive: true });
  const work = join(root, "work");
  mkdirSync(work);
  const stateDir = (session) => join(env.XDG_STATE_HOME, "brb", session);
  return {
    root,
    env,
    work,
    stateDir,
    transcript: join(work, "transcript.jsonl"),
    errorsLog: join(env.XDG_STATE_HOME, "brb", "errors.log"),
    read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : ""),
    writeTranscript(rows) {
      writeFileSync(join(work, "transcript.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    },
    release: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Transcript rows: a user prompt, an assistant tool_use, an assistant text. */
export const row = {
  user: (text = "go") => ({ type: "user", message: { role: "user", content: text } }),
  tool: (name = "Read") => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name, input: {} }] } }),
  text: (text = "ok") => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }),
};

/** Spawn hooks/<name>.mjs with `payload` (object → JSON, string as is); `{ status, stdout, stderr, json }`. */
export function runHook(b, name, payload, { env = {} } = {}) {
  const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, "hooks", `${name}.mjs`)], {
    cwd: b.work,
    env: { ...b.env, ...env },
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
  });
  let json = null;
  if (r.stdout.trim()) {
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = undefined;
    }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** The still-away line an agent starts every reply with while away (lib/text.mjs replyFirstLine), as a test fixture. */
export const FIRST_LINE = "brb: still away (0m, 0 held) — say `back` to read them";

/**
 * A Stop payload. The message gets FIRST_LINE as its first line, as a reply that follows the away
 * instruction would; `firstLine: false` leaves the message as given.
 */
export const stopInput = (b, { firstLine = true, ...over } = {}) => {
  const input = {
    session_id: "s1",
    transcript_path: b.transcript,
    cwd: b.work,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "Done.",
    ...over,
  };
  if (firstLine) input.last_assistant_message = `${FIRST_LINE}\n${input.last_assistant_message}`;
  return input;
};

export const promptInput = (b, prompt, over = {}) => ({ session_id: "s1", cwd: b.work, hook_event_name: "UserPromptSubmit", prompt, ...over });

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * A real second process holding the session lock: it runs `code` (with `state`, lib/state.mjs,
 * in scope) under withAwayLock, then sleeps `ms` still holding it. Returns the child once its
 * lock (holding its pid) is on disk; `await exited(child)` before releasing the box.
 */
export function lockHolder(b, session, { ms = 3_000, code = "" } = {}) {
  const script = `import * as state from ${JSON.stringify(join(PLUGIN_ROOT, "lib", "state.mjs"))};\nstate.withAwayLock(${JSON.stringify(session)}, process.env, () => { ${code}; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms}); });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: b.work, env: b.env, stdio: ["ignore", "ignore", "inherit"] });
  const lock = join(b.stateDir(session), "away.lock");
  const until = Date.now() + 5_000;
  while (Date.now() < until && !(existsSync(lock) && readFileSync(lock, "utf8").startsWith(`${child.pid} `))) sleepSync(10);
  if (!existsSync(lock)) throw new Error("the lock holder did not take the lock in 5 s");
  return child;
}

export const exited = (child) => new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.on("exit", resolve)));
