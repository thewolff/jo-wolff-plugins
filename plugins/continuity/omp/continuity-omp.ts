// continuity-omp.ts — the OMP extension that gives an omp session continuity's pre-compaction
// save and post-compaction restore by spawning the plugin's two Claude Code hooks as stdin-JSON
// CLIs. Nothing is imported from the hooks; the same files run under both harnesses, so one test
// suite covers the save and the restore.
//
// WHY: OMP does not run a plugin's hooks/hooks.json (its source has no `hooks.json` reader and
// no `PreCompact` event); it loads the TS extension modules package.json `omp.extensions` names.
//
// EVENT MAPPING (omp docs: extensions.md "Session lifecycle"; compaction.md "Extension and hook
// touchpoints"; the host's session-maintenance.ts emits them at every compaction path):
//   auto_compaction_start   remember that the compaction about to run is the host's own
//                           (threshold, overflow, incomplete, idle), so the save is told
//                           `trigger: "auto"`; auto_compaction_end forgets it. A compaction with
//                           no such start in flight is a `/compact`: `trigger: "manual"`. The
//                           host emits the start before session_before_compact on every auto path.
//   session_before_compact  Claude Code's PreCompact → spawn hooks/pre-compact.mjs. The payload
//                           carries the three host fields the save was built to accept from a
//                           transcript-less host (lib/snapshot.mjs buildSnapshot): `intents`,
//                           the user texts of the messages the compaction is about to discard
//                           (`preparation.messagesToSummarize` and `turnPrefixMessages`, the
//                           last 5); `file_operations`, the host's `preparation.fileOps`
//                           (read, written, edited; each a Set) rendered with counts; and
//                           `token_count`, `preparation.tokensBefore`. No `transcript_path`: an
//                           OMP session file is not a Claude Code transcript, and a readable file
//                           would make the save claim it read the session's writes and found
//                           none. The handler returns undefined every time: it never cancels a
//                           compaction and never replaces its summary. A `systemMessage` from
//                           the hook (auto-compaction with no handoff written; a snapshot that
//                           could not be written) is shown with ctx.ui.notify, as Claude Code
//                           shows it to the person.
//   session_compact         Claude Code's SessionStart with `source: "compact"` → spawn
//                           hooks/session-start.mjs; its `additionalContext` (the restored
//                           snapshot, the rules section, the durable notes, the liveness line)
//                           goes to the agent through pi.sendMessage as a hidden custom message:
//                           while the agent streams (a mid-turn compaction) OMP steers it into
//                           the run; when idle (a post-turn compaction) it is appended to the
//                           context without starting a turn, so the auto-continue prompt that
//                           follows reads it. OMP compacts in session: there is no restart to
//                           restore across, so the moment to read the snapshot back is right
//                           after the compaction that wrote it.
//
// ONCE PER COMPACTION ENTRY. The restore is guarded by (session id, event.compactionEntry.id):
// a session_compact for a pair whose restore is in flight or done sends nothing, so a repeated
// notification never re-sends a retained (truncated) snapshot or follows a delivered restore
// with "this compaction's state was not restored". A new entry id restores again. An event with
// no entry id cannot be told apart from another and is restored as a new one.
//
// PAIRED SAVES. Not every session_compact follows a session_before_compact: OMP's manual handoff
// and its snapcompact frame rescue commit a compaction entry without the pre-event
// (session-maintenance.ts handoff(), the snapcompact rescue). The adapter remembers, per session,
// that a save was attempted; a session_compact that consumes such a mark is paired and runs the
// restore as on Claude Code, including the "not restored: the save failed" line. An unpaired one
// runs the restore only when a snapshot file exists for the session (one an earlier restore kept,
// or a save whose own restore did not run) and otherwise sends nothing: the host wrote its own
// summary, and no save was attempted that could have failed. A pre-event another extension
// cancelled leaves its mark for the next session_compact, which then restores that save's snapshot.
//
// THE RULES WALK. OMP loads `CLAUDE.md` and `AGENTS.md`, by those exact names, on the walk up
// from the session's cwd into the system prompt (its discovery providers claude-md.ts and
// agents-md.ts, each loadStandaloneContextFiles with one filename), which a compaction does not
// touch (omp docs: context-files.md "How files are injected"). It loads no `CLAUDE.local.md`. So
// the child's env carries CLAUDE_PROJECT_DIR=<the session's cwd> and
// CONTINUITY_HOST_RULES=CLAUDE.md,AGENTS.md: the walk names those two as kept by the host at or
// above the launch directory and inlines every other rules file there (`CLAUDE.local.md`) as it
// inlines a nested one; a payload cwd below the launch directory still gets its nearer files
// inlined, as on Claude Code.
//
// SESSION ID. Every spawn carries ctx.sessionManager.getSessionId(), the id that is stable across
// OMP's provider-id rotations, so the save and the restore share one snapshot path and one
// once-mark file (sessions/<id>.json).
//
// SPECULATION. OMP skips its speculative (background) compaction while any extension registers
// session_before_compact (session-maintenance.ts deferThresholdCompactionToSpeculation), so with
// this adapter loaded every compaction runs blocking, with the summarization latency in the
// turn. The save needs the pre-event; there is no other hook that fires before every compaction.
//
// DEADLINES. OMP abandons a handler at 30 s (EXTENSION_HANDLER_TIMEOUT_MS). Each hook answers
// inside lib/hook-runner.mjs's own 4 s deadline whatever its handler does; the adapter gives the
// spawn 8 s (node start-up and a stdout drain on top of the 4 s), kills the child's process
// group when that passes, and the event proceeds. Both budgets are pinned by
// omp/continuity-omp.test.mjs against the runner's constant.
//
// FAIL OPEN. A spawn that fails, exits non-zero, prints junk or outruns its budget is one line
// in ${XDG_STATE_HOME:-~/.local/state}/continuity/errors.log (`omp-adapter <hook>: …`) and the
// event proceeds as if the hook had printed nothing: the compaction runs, the turn goes on
// without the restore. A host with no sendMessage cannot be given the restore; that is logged
// the same way.
//
// Node is resolved the way brb's adapter does: process.execPath unless the host is Bun, then the
// first `node` on PATH or in the usual places; CONTINUITY_NODE overrides. Types are erasable
// (node 24 strips them without a build), so the test imports this file directly.

import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotPath } from "../lib/paths.mjs";

const DEFAULT_PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** The rules filenames OMP's context-file providers load at launch (discovery/claude-md.ts, agents-md.ts). */
export const OMP_HOST_RULES = "CLAUDE.md,AGENTS.md";
export const PRE_COMPACT_HOOK = "pre-compact.mjs";
export const RESTORE_HOOK = "session-start.mjs";
/** OMP's budget for one dispatched handler (pi-coding-agent extensibility/extensions/runner.ts EXTENSION_HANDLER_TIMEOUT_MS). */
export const OMP_HANDLER_BUDGET_MS = 30_000;
/** The spawn's budget: the runner's 4 s deadline plus node start-up and the stdout drain. */
export const PRE_COMPACT_TIMEOUT_MS = 8_000;
export const RESTORE_TIMEOUT_MS = 8_000;
export const MAX_INTENTS = 5;
export const MAX_INTENT_CHARS = 500;
export const MAX_FILE_OPS_CHARS = 6_000;
export const RESTORE_MESSAGE_TYPE = "continuity-restored";
const STDERR_KEPT = 2_000;

export type Verdict = Record<string, unknown>;
export type RunCli = (hook: string, payload: string, cwd: string, timeoutMs: number) => Promise<Verdict | undefined>;

type Ctx = {
  cwd: string;
  sessionManager?: { getSessionId?: () => unknown };
  hasUI?: boolean;
  ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
};

/** The slice of OMP's session_before_compact event this adapter reads. */
export type BeforeCompactEvent = {
  preparation?: { messagesToSummarize?: unknown; turnPrefixMessages?: unknown; tokensBefore?: unknown; fileOps?: unknown };
  customInstructions?: unknown;
};

export type Trigger = "auto" | "manual";

/** The structural slice of OMP's extension API this adapter registers against. */
export type PiLike = {
  on(name: "auto_compaction_start" | "auto_compaction_end", handler: (event: unknown, ctx: Ctx) => unknown): void;
  on(name: "session_before_compact", handler: (event: BeforeCompactEvent, ctx: Ctx) => unknown): void;
  on(name: "session_compact", handler: (event: unknown, ctx: Ctx) => unknown): void;
  sendMessage?: (message: { customType: string; content: string; display: boolean }) => void;
};

export type Deps = {
  runCli?: RunCli;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
};

/** `${XDG_STATE_HOME:-~/.local/state}/continuity`, read at call time (lib/paths.mjs stateDir, same rule). */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME?.trim() ? env.XDG_STATE_HOME : join(env.HOME || homedir(), ".local", "state");
  return join(xdg, "continuity");
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

function managerSessionId(ctx: Ctx): string {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

/** A user message's text: string content, or its text blocks joined; undefined for any other message. */
export function userText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as { role?: unknown; content?: unknown };
  if (m.role !== "user") return undefined;
  if (typeof m.content === "string") return m.content || undefined;
  if (!Array.isArray(m.content)) return undefined;
  const text = m.content
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part && typeof part === "object"))
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return text || undefined;
}

/** The last MAX_INTENTS user texts of the messages the compaction discards, each cut to MAX_INTENT_CHARS. */
export function intentsFrom(preparation: BeforeCompactEvent["preparation"]): string[] {
  const discarded = [
    ...(Array.isArray(preparation?.messagesToSummarize) ? preparation.messagesToSummarize : []),
    ...(Array.isArray(preparation?.turnPrefixMessages) ? preparation.turnPrefixMessages : []),
  ];
  return discarded
    .map(userText)
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .slice(-MAX_INTENTS)
    .map((t) => t.trim().slice(0, MAX_INTENT_CHARS));
}

/**
 * The host's file operations as text: one `**kind** (n)` block per category with its paths
 * sorted, or one line saying the host reported none. `preparation.fileOps` is `{ read, written,
 * edited }` of Sets; `JSON.stringify` of a Set is `{}`, so each is expanded here. Always a
 * non-empty string: a session that touched nothing is an answer, not a missing field.
 */
export function fileOperationsFrom(fileOps: unknown): string {
  if (!fileOps || typeof fileOps !== "object") return "(the host reported no file operations)";
  const blocks: string[] = [];
  let counted = 0;
  for (const [kind, value] of Object.entries(fileOps as Record<string, unknown>)) {
    const paths = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
    const texts = paths.map((p) => String(p)).filter(Boolean).sort();
    counted += texts.length;
    blocks.push(texts.length ? `**${kind}** (${texts.length})\n${texts.map((p) => `- ${p}`).join("\n")}` : `**${kind}** (0)`);
  }
  if (!counted) return `(the host reported no file operations across ${blocks.length} categories)`;
  const text = blocks.join("\n\n");
  return text.length > MAX_FILE_OPS_CHARS ? `${text.slice(0, MAX_FILE_OPS_CHARS)}\n… TRUNCATED by the adapter at ${MAX_FILE_OPS_CHARS} characters` : text;
}

/** The PreCompact payload hooks/pre-compact.mjs reads, from OMP's session_before_compact event. */
export function buildPreCompactPayload(event: BeforeCompactEvent, ctx: Ctx, trigger: Trigger): string {
  const tokens = Number(event?.preparation?.tokensBefore);
  return JSON.stringify({
    hook_event_name: "PreCompact",
    session_id: managerSessionId(ctx),
    cwd: ctx.cwd,
    trigger,
    custom_instructions: typeof event?.customInstructions === "string" ? event.customInstructions : "",
    intents: intentsFrom(event?.preparation),
    file_operations: fileOperationsFrom(event?.preparation?.fileOps),
    ...(Number.isFinite(tokens) && tokens > 0 ? { token_count: tokens } : {}),
  });
}

/** The SessionStart payload hooks/session-start.mjs reads after a compaction. */
export function buildRestorePayload(ctx: Ctx): string {
  return JSON.stringify({ hook_event_name: "SessionStart", session_id: managerSessionId(ctx), cwd: ctx.cwd, source: "compact" });
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

/** The node binary for the spawns: CONTINUITY_NODE, else process.execPath unless under Bun, else a search. */
export function resolveNode(opts: { env: NodeJS.ProcessEnv; execPath: string; underBun: boolean; home: string; isExecutable: (p: string) => boolean }): NodeChoice {
  const { env, execPath, underBun, home, isExecutable } = opts;
  const explicit = env.CONTINUITY_NODE?.trim();
  if (explicit) return isExecutable(explicit) ? { path: explicit } : { error: `CONTINUITY_NODE=${explicit} is not an executable file` };
  if (!underBun) return { path: execPath };
  const onPath = (env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "node"));
  const fallbacks = [join(home, ".local", "bin", "node"), "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  const found = [...onPath, ...fallbacks].find((p) => isExecutable(p));
  return found ? { path: found } : { error: `no usable node on PATH (${env.PATH ?? ""}) nor at ${fallbacks.join(", ")}; set CONTINUITY_NODE` };
}

let nodeCache: { key: string; choice: NodeChoice } | undefined;
function hostNode(env: NodeJS.ProcessEnv): NodeChoice {
  const key = `${env.CONTINUITY_NODE ?? ""}\0${env.PATH ?? ""}`;
  if (nodeCache?.key !== key) {
    nodeCache = { key, choice: resolveNode({ env, execPath: process.execPath, underBun: typeof process.versions.bun === "string", home: homedir(), isExecutable: isExecutableFile }) };
  }
  return nodeCache.choice;
}

/**
 * Spawn `hooks/<hook>` with the payload on stdin; its JSON, undefined for a quiet exit 0; rejects
 * on anything else. The child's env is the host's with the node's directory first on PATH and
 * CLAUDE_PROJECT_DIR set to `cwd` (THE RULES WALK, above).
 */
export function spawnHook(hook: string, payload: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<Verdict | undefined> {
  const root = env.CONTINUITY_PLUGIN_ROOT ?? DEFAULT_PLUGIN_ROOT;
  const node = hostNode(env);
  if ("error" in node) return Promise.reject(new Error(node.error));
  const { promise, resolve, reject } = Promise.withResolvers<Verdict | undefined>();
  const child = spawn(node.path, [join(root, "hooks", hook)], {
    cwd,
    detached: true,
    env: { ...env, PATH: [dirname(node.path), env.PATH].filter(Boolean).join(delimiter), CLAUDE_PROJECT_DIR: cwd, CONTINUITY_HOST_RULES: OMP_HOST_RULES },
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
        resolve(parsed as Verdict);
      } catch (err) {
        reject(new Error(`${hook} printed something other than JSON: ${err instanceof Error ? err.message : String(err)}${tail}`));
      }
    }),
  );
  child.stdin.on("error", () => {});
  child.stdin.end(payload);
  return promise;
}

const notify = (ctx: Ctx, text: string, type: "info" | "warning" | "error" = "warning"): void => {
  try {
    if (ctx.hasUI !== false) ctx.ui?.notify?.(text, type);
  } catch {
    // a UI that throws is not the plugin's fault
  }
};

/** The hook's additionalContext, or undefined when the output carries none. */
function additionalContext(out: Verdict | undefined): string | undefined {
  const hso = out?.hookSpecificOutput;
  if (!hso || typeof hso !== "object" || !("additionalContext" in hso)) return undefined;
  const content = hso.additionalContext;
  return typeof content === "string" && content ? content : undefined;
}

/** session_before_compact: run the save; show its systemMessage; never cancel. Always resolves to undefined. */
export async function beforeCompactHandler(event: BeforeCompactEvent, ctx: Ctx, trigger: Trigger, deps: Deps = {}): Promise<undefined> {
  const env = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? defaultStateDir(env);
  const run = deps.runCli ?? ((h, p, c, ms) => spawnHook(h, p, c, ms, env));
  try {
    const out = await run(PRE_COMPACT_HOOK, buildPreCompactPayload(event, ctx, trigger), ctx.cwd, PRE_COMPACT_TIMEOUT_MS);
    if (typeof out?.systemMessage === "string" && out.systemMessage) notify(ctx, out.systemMessage);
  } catch (err) {
    logError(stateDir, `${PRE_COMPACT_HOOK}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

/** session_compact: run the restore; hand its context to the agent through `send`; show its systemMessage. Always resolves. */
export async function sessionCompactHandler(ctx: Ctx, send: ((content: string) => void) | undefined, deps: Deps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? defaultStateDir(env);
  const run = deps.runCli ?? ((h, p, c, ms) => spawnHook(h, p, c, ms, env));
  try {
    const out = await run(RESTORE_HOOK, buildRestorePayload(ctx), ctx.cwd, RESTORE_TIMEOUT_MS);
    if (typeof out?.systemMessage === "string" && out.systemMessage) notify(ctx, out.systemMessage);
    const content = additionalContext(out);
    if (!content) return;
    if (!send) throw new Error("the host has no sendMessage; the restore was not delivered");
    send(content);
  } catch (err) {
    logError(stateDir, `${RESTORE_HOOK}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The compaction entry id of a session_compact event, or undefined when it carries none. */
export function compactionEntryId(event: unknown): string | undefined {
  const entry = (event as { compactionEntry?: { id?: unknown } } | null | undefined)?.compactionEntry;
  const id = entry && typeof entry === "object" ? entry.id : undefined;
  return typeof id === "string" && id ? id : undefined;
}

/** Registration entry point; package.json `omp.extensions` names this file. */
export default function continuityOmp(pi: PiLike, deps: Deps = {}): void {
  const env = deps.env ?? process.env;
  // Set by auto_compaction_start, cleared by auto_compaction_end: the compaction between them is the host's own.
  let autoInFlight = false;
  // Session ids with a save attempted and not yet consumed by a session_compact (PAIRED SAVES, above).
  const savesAttempted = new Set<string>();
  // `<session id>\0<entry id>` of every restore started (ONCE PER COMPACTION ENTRY, above).
  const restoresStarted = new Set<string>();
  pi.on("auto_compaction_start", () => {
    autoInFlight = true;
  });
  pi.on("auto_compaction_end", () => {
    autoInFlight = false;
  });
  pi.on("session_before_compact", (event, ctx) => {
    savesAttempted.add(managerSessionId(ctx));
    return beforeCompactHandler(event, ctx, autoInFlight ? "auto" : "manual", deps);
  });
  const send =
    typeof pi.sendMessage === "function"
      ? (content: string): void => {
          pi.sendMessage!({ customType: RESTORE_MESSAGE_TYPE, content, display: false });
        }
      : undefined;
  pi.on("session_compact", async (event, ctx) => {
    const sessionId = managerSessionId(ctx);
    const entryId = compactionEntryId(event);
    if (entryId !== undefined) {
      const key = `${sessionId}\0${entryId}`;
      if (restoresStarted.has(key)) return;
      restoresStarted.add(key);
    }
    const paired = savesAttempted.delete(sessionId);
    if (!paired && !existsSync(snapshotPath(sessionId, env))) return;
    await sessionCompactHandler(ctx, send, deps);
  });
}
