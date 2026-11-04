// brb-omp.ts — the OMP extension that gives an omp session brb's behaviour by spawning the
// plugin's three Claude Code hooks as stdin-JSON CLIs. Nothing is imported from the hooks; the
// same files run under both harnesses, so one test suite covers the rules.
//
// EVENT MAPPING
//   input               the whole typed text is `brb` (with an optional note), `back` or
//                       `pending` → spawn hooks/user-prompt-submit.mjs with the text as the
//                       prompt, show its block `reason` (the confirmation or the digest) through
//                       pi.sendMessage({ display: true }) without triggerTurn, or ctx.ui.notify
//                       when the host has no sendMessage, and return { handled: true } at once,
//                       so no turn starts. Any other text returns undefined; the away context
//                       reaches the agent through before_agent_start, below.
//   before_agent_start  spawn hooks/session-start.mjs; when it returns additionalContext (the
//                       session is away) hand it to the turn as a hidden custom message. Home →
//                       the hook prints nothing and nothing is added.
//   session_stop        spawn hooks/stop.mjs with BRB_HARNESS=omp and return its verdict:
//                       { decision: "block", reason } keeps the agent working (OMP never caps an
//                       explicit block; the core's own release rules end the loop). A
//                       systemMessage (an on-fire line, an idle notice) is shown with
//                       ctx.ui.notify. The core leaves out terminalSequence under this tag.
//
// SESSION ID. Every spawn carries ctx.sessionManager.getSessionId(), the id that is stable across
// OMP's provider-id rotations, so the three hooks share one state directory.
//
// FAIL OPEN. A spawn that fails, exits non-zero, prints junk or outruns its budget is one line in
// ${XDG_STATE_HOME:-~/.local/state}/brb/errors.log (`omp-adapter …`) and the event proceeds
// as if the hook had printed nothing: the prompt is still handled (the word never reaches the
// model), the turn starts without the context, the stop is allowed.
//
// Node is resolved the way i-have-audhd's adapter does: process.execPath unless the host is Bun,
// then the first `node` on PATH or in the usual places; BRB_NODE overrides. Types are erasable
// (node 24 strips them without a build), so the test imports this file directly.

import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROMPT_HOOK = "user-prompt-submit.mjs";
const START_HOOK = "session-start.mjs";
const STOP_HOOK = "stop.mjs";
const PROMPT_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 10_000;
const CONTEXT_MESSAGE_TYPE = "brb-away";
const DIGEST_MESSAGE_TYPE = "brb-digest";
const STDERR_KEPT = 2_000;

export type Verdict = Record<string, unknown>;
export type RunCli = (hook: string, payload: string, cwd: string, timeoutMs: number) => Promise<Verdict | undefined>;

type Ctx = {
  cwd: string;
  agent?: { kind?: unknown };
  sessionManager?: { getSessionId?: () => unknown };
  hasUI?: boolean;
  ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
};

type InputEvent = { text?: unknown; source?: unknown };
type StopEvent = { session_id?: unknown; session_file?: unknown; stop_hook_active?: unknown; last_assistant_message?: unknown };

/** The structural slice of OMP's extension API this adapter registers against. */
export type PiLike = {
  on(name: "input", handler: (event: InputEvent, ctx: Ctx) => unknown): void;
  on(name: "before_agent_start", handler: (event: unknown, ctx: Ctx) => unknown): void;
  on(name: "session_stop", handler: (event: StopEvent, ctx: Ctx) => unknown): void;
  sendMessage?: (message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { deliverAs?: "nextTurn" }) => void;
};

export type Deps = {
  runCli?: RunCli;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
};

export type SurfaceWord = "brb" | "back" | "pending";

/** The surface word the whole trimmed text is: brb (note allowed), back, pending; null otherwise. Mirrors lib/text.mjs. */
export function surfaceWord(text: unknown): SurfaceWord | null {
  const m = /^(brb|back|pending)(?:\s+(.*))?$/is.exec(String(text ?? "").trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  if (word === "brb") return "brb";
  if (m[2]) return null;
  return word === "back" ? "back" : "pending";
}

/** The finished message's text: a string, or the text blocks joined. */
export function assistantText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const texts: string[] = [];
  for (const p of c) {
    if (p && typeof p === "object" && "type" in p && p.type === "text" && "text" in p && typeof p.text === "string") texts.push(p.text);
  }
  return texts.join("\n");
}

function managerSessionId(ctx: Ctx): string {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

export function buildPromptPayload(text: string, ctx: Ctx): string {
  return JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: managerSessionId(ctx), cwd: ctx.cwd, prompt: text });
}

export function buildStartPayload(ctx: Ctx): string {
  return JSON.stringify({ hook_event_name: "SessionStart", session_id: managerSessionId(ctx), cwd: ctx.cwd, source: "resume" });
}

export function buildStopPayload(event: StopEvent, ctx: Ctx): string {
  return JSON.stringify({
    hook_event_name: "Stop",
    session_id: managerSessionId(ctx) || (typeof event.session_id === "string" ? event.session_id : ""),
    cwd: ctx.cwd,
    transcript_path: typeof event.session_file === "string" ? event.session_file : "",
    stop_hook_active: !!event.stop_hook_active,
    last_assistant_message: assistantText(event.last_assistant_message),
  });
}

/** `${XDG_STATE_HOME:-~/.local/state}/brb`, read at call time. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME?.trim() ? env.XDG_STATE_HOME : join(env.HOME || homedir(), ".local", "state");
  return join(xdg, "brb");
}

/** One errors.log line, the hook runner's shape (`<iso> <hook> <message>`); never throws. */
function logError(stateDir: string, message: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, "errors.log"), `${new Date().toISOString()} omp-adapter ${message.replace(/\s+/g, " ").trim()}\n`);
  } catch {
    // lost by design: a read-only home must not turn a fail-open adapter into a crashing one
  }
}

const isExecutableFile = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export type NodeChoice = { path: string } | { error: string };

/** The node binary for the spawns: BRB_NODE, else process.execPath unless under Bun, else a search. */
export function resolveNode(opts: { env: NodeJS.ProcessEnv; execPath: string; underBun: boolean; home: string; isExecutable: (p: string) => boolean }): NodeChoice {
  const { env, execPath, underBun, home, isExecutable } = opts;
  const explicit = env.BRB_NODE?.trim();
  if (explicit) return isExecutable(explicit) ? { path: explicit } : { error: `BRB_NODE=${explicit} is not an executable file` };
  if (!underBun) return { path: execPath };
  const onPath = (env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "node"));
  const fallbacks = [join(home, ".local", "bin", "node"), "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  const found = [...onPath, ...fallbacks].find((p) => isExecutable(p));
  return found ? { path: found } : { error: `no usable node on PATH (${env.PATH ?? ""}) nor at ${fallbacks.join(", ")}; set BRB_NODE` };
}

let nodeCache: { key: string; choice: NodeChoice } | undefined;
function hostNode(env: NodeJS.ProcessEnv): NodeChoice {
  const key = `${env.BRB_NODE ?? ""}\0${env.PATH ?? ""}`;
  if (nodeCache?.key !== key) {
    nodeCache = { key, choice: resolveNode({ env, execPath: process.execPath, underBun: typeof process.versions.bun === "string", home: homedir(), isExecutable: isExecutableFile }) };
  }
  return nodeCache.choice;
}

/** Spawn `hooks/<hook>` with the payload on stdin; its JSON, undefined for a quiet exit 0; rejects on anything else. */
export function spawnHook(hook: string, payload: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<Verdict | undefined> {
  const root = env.BRB_PLUGIN_ROOT ?? DEFAULT_PLUGIN_ROOT;
  const node = hostNode(env);
  if ("error" in node) return Promise.reject(new Error(node.error));
  const { promise, resolve, reject } = Promise.withResolvers<Verdict | undefined>();
  const child = spawn(node.path, [join(root, "hooks", hook)], {
    cwd,
    detached: true,
    env: { ...env, PATH: [dirname(node.path), env.PATH].filter(Boolean).join(delimiter), BRB_HARNESS: "omp" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const settle = (f: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    f();
  };
  let tail = "";
  const timer = setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    settle(() => reject(new Error(`${hook} timed out after ${timeoutMs}ms${tail}`)));
  }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => {
    stdout += c;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => {
    stderr = (stderr + c).slice(-STDERR_KEPT);
    tail = stderr.trim() ? `; stderr: ${stderr.replace(/\s+/g, " ").trim().slice(-300)}` : "";
  });
  child.on("error", (err: NodeJS.ErrnoException) => settle(() => reject(new Error(`could not start ${node.path}: ${err.message}`))));
  child.on("close", (code, signal) =>
    settle(() => {
      if (code !== 0) return reject(new Error(`${hook} exited ${code ?? signal}${tail}`));
      if (!stdout.trim()) return resolve(undefined);
      try {
        const parsed: unknown = JSON.parse(stdout);
        // The hook runner prints one JSON object or nothing; a non-object here is the runner's contract broken, reported as junk.
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
        resolve(parsed);
      } catch (err) {
        reject(new Error(`${hook} printed something other than JSON: ${err instanceof Error ? err.message : String(err)}${tail}`));
      }
    }),
  );
  child.stdin.on("error", () => {});
  child.stdin.end(payload);
  return promise;
}

const notify = (ctx: Ctx, text: string, type: "info" | "warning" | "error" = "info"): void => {
  try {
    if (ctx.hasUI !== false) ctx.ui?.notify?.(text, type);
  } catch {
    // a UI that throws is not the plugin's fault
  }
};

/** The `input` handler's work for a surface word: spawn the prompt hook, show its reason. Always resolves. */
export async function inputWordHandler(text: string, ctx: Ctx, show: (reason: string) => void, deps: Deps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? defaultStateDir(env);
  const run = deps.runCli ?? ((h, p, c, ms) => spawnHook(h, p, c, ms, env));
  try {
    const out = await run(PROMPT_HOOK, buildPromptPayload(text, ctx), ctx.cwd, PROMPT_TIMEOUT_MS);
    if (out?.decision === "block" && typeof out.reason === "string" && out.reason) show(out.reason);
    else if (typeof out?.systemMessage === "string" && out.systemMessage) show(out.systemMessage);
    else show(`brb: the ${surfaceWord(text)} hook answered nothing; see errors.log under ${stateDir}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(stateDir, `${PROMPT_HOOK}: ${message}`);
    show(`brb: could not run the hook (${message}); nothing changed`);
  }
}

/** before_agent_start: the away context as a hidden message, or undefined when home or on a fault. */
export async function beforeAgentStartHandler(ctx: Ctx, deps: Deps = {}): Promise<{ message: { customType: string; content: string; display: false } } | undefined> {
  if (ctx.agent?.kind === "sub") return undefined;
  const env = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? defaultStateDir(env);
  const run = deps.runCli ?? ((h, p, c, ms) => spawnHook(h, p, c, ms, env));
  try {
    const out = await run(START_HOOK, buildStartPayload(ctx), ctx.cwd, START_TIMEOUT_MS);
    const hso = out?.hookSpecificOutput;
    const content = hso && typeof hso === "object" && "additionalContext" in hso ? hso.additionalContext : undefined;
    if (typeof content !== "string" || !content) return undefined;
    return { message: { customType: CONTEXT_MESSAGE_TYPE, content, display: false } };
  } catch (err) {
    logError(stateDir, `${START_HOOK}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** session_stop: the stop core's verdict; a systemMessage goes to the UI; a fault allows the stop. */
export async function sessionStopHandler(event: StopEvent, ctx: Ctx, deps: Deps = {}): Promise<{ decision: "block"; reason: string } | undefined> {
  if (ctx.agent?.kind === "sub") return undefined;
  const env = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? defaultStateDir(env);
  const run = deps.runCli ?? ((h, p, c, ms) => spawnHook(h, p, c, ms, env));
  try {
    const out = await run(STOP_HOOK, buildStopPayload(event, ctx), ctx.cwd, STOP_TIMEOUT_MS);
    if (typeof out?.systemMessage === "string" && out.systemMessage) notify(ctx, out.systemMessage, /on fire/i.test(out.systemMessage) ? "warning" : "info");
    if (out?.decision === "block" && typeof out.reason === "string" && out.reason) return { decision: "block", reason: out.reason };
    return undefined;
  } catch (err) {
    logError(stateDir, `${STOP_HOOK}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Registration entry point; package.json `omp.extensions` names this file. */
export default function brbOmp(pi: PiLike, deps: Deps = {}): void {
  const show = (ctx: Ctx) => (text: string): void => {
    if (typeof pi.sendMessage === "function") {
      try {
        pi.sendMessage({ customType: DIGEST_MESSAGE_TYPE, content: text, display: true });
        return;
      } catch {
        // fall through to the notice
      }
    }
    notify(ctx, text, "info");
  };
  pi.on("input", (event, ctx) => {
    const word = surfaceWord(event?.text);
    if (!word) return undefined;
    // Decided synchronously so the host never dispatches the word as a prompt; the hook runs after.
    void inputWordHandler(String(event.text), ctx, show(ctx), deps);
    return { handled: true };
  });
  pi.on("before_agent_start", (_event, ctx) => beforeAgentStartHandler(ctx, deps));
  pi.on("session_stop", (event, ctx) => sessionStopHandler(event, ctx, deps));
}
