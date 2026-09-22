// communication-rules-omp.ts — OMP seat adapter for the communication-rules plugin.
//
// WHY: Jo's requirement, 2026-09-21 — the plugin's turn-end rules must work for OMP seats as
// well as Claude Code. The check core already exists as a stdin-JSON CLI
// (hooks/communication-rules-stop.mjs, spawned here — never imported), so this file is only
// the splice: render the finished assistant message, spawn the CLI, translate its verdict
// into a session_stop block.
//
// STATUS: UNREGISTERED. Nothing loads this file — no seat profile references it and
// ~/.omp/agent/extensions/ does not contain it. REGISTRATION.md beside this file records the
// steps NOT taken, the exact reversal, and the canary that would prove it live.
//
// LOOP GUARDS, two layers (Claude Code's design): (1) host — event.stop_hook_active returns
// before the CLI is spawned, because a handler that ignores it loops forever on an
// always-firing rule; (2) CLI — the text-hash guard inside communication-rules-stop.mjs
// (never blocks the same message twice) stays inside the CLI and is not duplicated here.
//
// WARN-ONLY BY CONSTRUCTION. The shared profile arms rules at block for Claude; OMP is armed
// separately, so a CLI block verdict is DOWNGRADED: one line in warnings.log, return
// undefined, the turn settles. The arming act is deliberate and happens at registration —
// set COMMUNICATION_RULES_OMP_MODE=block in the seat's environment. That env is read PER
// INVOCATION, inline in the handler (never cached at module scope); any value other than
// exactly "block" reads as warn.
//
// KILL SWITCH: the CLI's own — `touch $HOME/.claude/.communication-rules-off`, checked
// inside the CLI per invocation and effective within one turn. This adapter has none of its
// own; one switch, one place.
//
// FAIL-OPEN CONTRACT. A dead adapter must be visible, never fatal: every failure path (CLI
// crash, non-zero exit, unparseable stdout, timeout, any thrown error anywhere) returns
// undefined, counts one fail-open in <stateDir>/omp-adapter-failures.json, and leaves one
// line in errors.log. The timeout is 25s against the host's 30s budget — lose the race, not
// the turn.
//
// SYNTAX: erasable-types TypeScript only, so node v24.13 strips the types and imports this
// module without Bun. globalThis.Bun is referenced LAZILY inside defaultRunCli, so importing
// under node never throws. `pi` is typed structurally — zero imports from @oh-my-pi.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PLUGIN_ROOT = "/Users/jowolff/code/jo-wolff-plugins/plugins/communication-rules";
const DEFAULT_STATE_DIR = join(homedir(), ".claude", ".communication-rules-state");
const CLI_TIMEOUT_MS = 25_000;

type StopEvent = {
  session_id?: unknown;
  session_file?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
};

type CliVerdict = { decision?: unknown; reason?: unknown };

type HandlerDeps = {
  runCli?: (payload: string, cwd: string) => Promise<CliVerdict | undefined>;
  stateDir?: string;
  timeoutMs?: number;
};

// Structural stand-in for the host's extension API: the one event this adapter registers.
// Deliberately local — importing @oh-my-pi would couple an unregistered file to a host.
type PiLike = {
  on(name: "session_stop", handler: (event: StopEvent, ctx: { cwd: string }) => unknown): void;
};

// Structural stand-in for the Bun global, read lazily so node imports never touch it.
type BunLike = {
  spawn(options: {
    cmd: string[];
    cwd?: string;
    stdin?: string;
    stdout?: string;
    stderr?: string;
  }): {
    stdin: { write(data: string): void; end(): void };
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
};

// Whitespace collapsed, trimmed, capped — the shape every log line and persisted error
// string shares (appendLog collapses again; that pass is idempotent).
const collapse = (text: string, max = 300): string => text.replace(/\s+/g, " ").trim().slice(0, max);

// The finished message's text: string content, or text-block content joined by newlines.
// Semantics verbatim from the live adapter's reducer (newdle-hooks.ts:80-92) — empty string
// and missing content are both undefined, so the payload fallback "" applies downstream.
export function assistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as { content?: unknown };
  if (typeof candidate.content === "string") return candidate.content || undefined;
  if (!Array.isArray(candidate.content)) return undefined;
  const text = candidate.content
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part && typeof part === "object"))
    .filter((part): part is { type?: unknown; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return text || undefined;
}

// The CLI's stdin contract, exactly (communication-rules-stop.mjs:12-17): the Claude Code Stop
// shape plus last_assistant_message, which OMP payloads carry and Claude Code ones do not.
// transcript_path falls back to "" — the CLI reads it only when the message text is absent.
export function buildStopPayload(event: StopEvent, cwd: string): string {
  return JSON.stringify({
    hook_event_name: "Stop",
    session_id: event.session_id,
    cwd,
    transcript_path: event.session_file ?? "",
    stop_hook_active: !!event.stop_hook_active,
    last_assistant_message: assistantText(event.last_assistant_message) ?? "",
  });
}

// Fail-open counter, mirroring the live adapter's heartbeat (newdle-hooks.ts:368-384, 428-431)
// without its dependencies: every fail-open is counted so a dead adapter is distinguishable
// from a healthy one. Persisted rather than in-memory (the live one dies with its process and
// loses the tally); a corrupt or missing file reads as 0 — the counter itself fails open.
export function makeFailOpenCounter(stateDir: string): { record(err: unknown): number } {
  const file = join(stateDir, "omp-adapter-failures.json");
  const read = (): number => {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { count?: unknown };
      if (parsed && typeof parsed.count === "number") return parsed.count;
    } catch {
      // missing or corrupt → 0; the counter must never be the thing that breaks
    }
    return 0;
  };
  return {
    record(err: unknown): number {
      const count = read() + 1;
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(file, JSON.stringify({ count, lastError: collapse(String(err)), at: new Date().toISOString() }));
      } catch {
        // lost by design, same ruling as appendLog below
      }
      return count;
    },
  };
}

// One line in the plugin's shared state dir, appendLog-compatible (lib/state.mjs:46-53):
// ISO timestamp, whitespace collapsed, trailing newline, mkdir -p, never throws — a read-only
// home must not turn a fail-open adapter into a crashing one. Same file names as the CLI, so
// operator tooling sees one plugin, not two.
function appendLog(dir: string, file: string, text: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, file), `${new Date().toISOString()} ${text.replace(/\s+/g, " ").trim()}\n`);
  } catch {
    // lost by design; see the header's fail-open contract
  }
}

// The spawn, mirroring the live adapter's proven shape (newdle-hooks.ts:186-210): sh -lc,
// node, payload on stdin, stdout parsed as JSON. Bun is read LAZILY from globalThis so a node
// import never touches it. Failure semantics differ from the live runCommand on purpose: a
// non-zero exit or unparseable stdout THROWS instead of dissolving into undefined, because
// this adapter counts and logs every fail-open rather than silently passing.
async function defaultRunCli(payload: string, cwd: string): Promise<CliVerdict | undefined> {
  const globals = globalThis as { Bun?: BunLike }; // unchecked cast: host global, absent under node
  const bun = globals.Bun;
  if (!bun) throw new Error("omp-adapter: no Bun runtime — the default spawn needs the omp host");
  const root = process.env.COMMUNICATION_RULES_PLUGIN_ROOT ?? DEFAULT_PLUGIN_ROOT;
  const child = bun.spawn({
    cmd: ["sh", "-lc", `node "${root}/hooks/communication-rules-stop.mjs"`],
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(payload);
  child.stdin.end();
  const stdout = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`omp-adapter: CLI exited ${exitCode}${stdout.trim() ? `: ${collapse(stdout)}` : " with no output"}`);
  }
  if (!stdout.trim()) return undefined; // the CLI's documented quiet path: no verdict, exit 0
  return JSON.parse(stdout) as CliVerdict;
}

// The whole gate. deps exists so node --test can inject a fake runCli, a temp stateDir, and a
// tight timeoutMs — the default spawn is Bun-only by nature and is never exercised under node.
export async function sessionStopHandler(
  event: StopEvent,
  ctx: { cwd: string },
  deps?: HandlerDeps,
): Promise<{ decision: "block"; reason: string } | undefined> {
  const stateDir = deps?.stateDir ?? DEFAULT_STATE_DIR;
  try {
    if (event?.stop_hook_active) return undefined; // host loop guard; the CLI is never invoked
    const runCli = deps?.runCli ?? defaultRunCli;
    const timeoutMs = deps?.timeoutMs ?? CLI_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`omp-adapter: CLI timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    let verdict: CliVerdict | undefined;
    try {
      verdict = await Promise.race([runCli(buildStopPayload(event, ctx.cwd), ctx.cwd), expired]);
    } finally {
      clearTimeout(timer); // no lingering timer on the healthy path
    }
    if (verdict?.decision === "block" && typeof verdict.reason === "string" && verdict.reason) {
      if (process.env.COMMUNICATION_RULES_OMP_MODE === "block") return { decision: "block", reason: verdict.reason };
      appendLog(stateDir, "warnings.log", `rule=omp-adapter mode=warn-only reason=${collapse(verdict.reason)}`);
    }
    return undefined; // quiet or non-block verdict: nothing to gate, nothing to log
  } catch (err) {
    makeFailOpenCounter(stateDir).record(err);
    const detail = err instanceof Error ? err.message : String(err);
    appendLog(stateDir, "errors.log", `omp-adapter fail-open: ${detail}`);
    return undefined;
  }
}

// Registration entry point. UNREGISTERED today — see REGISTRATION.md.
export default function communicationRulesOmp(pi: PiLike): void {
  pi.on("session_stop", (event, ctx) => sessionStopHandler(event, ctx));
}
