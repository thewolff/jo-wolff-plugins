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
// LOOP GUARD, keyed on this plugin's own block: OMP sets stop_hook_active after ANY
// session_stop continuation, another extension's `continue: true` included
// (pi-coding-agent session/agent-session.ts, #sessionStopContinuationContext and
// #emitSessionStop). So the CLI is sent stop_hook_active: true only when the host flag is
// true AND this handler's previous result for the same session_id was a block; see
// blockedLastStop below. Every stop is checked, a revision that follows a block included.
// The CLI then (a) lets an identical repeat through on its text-hash guard, and (b) under
// the omp harness tag never blocks a stop sent with stop_hook_active: a changed revision is
// re-checked but can only warn. That bounds the loop OMP itself does not bound (it exempts
// decision:"block" from its session_stop continuation cap): this plugin blocks at most once
// per continuation chain, and another extension's continuation does not spend that block.
//
// WARN UNLESS ARMED, in the core: the child's env carries COMMUNICATION_RULES_HARNESS=omp,
// and the core turns every block into a warn unless the profile sets
// enforcement.armOmp: true (lib/config.mjs, harnessCapsBlocks). A capped block takes the
// core's own warn path, so warnings.log carries the real rule id and no block hash is
// recorded for a block that was never delivered. This file returns the CLI's verdict as is;
// it holds no mode of its own.
//
// KILL SWITCH: the CLI's own — `touch $HOME/.claude/.communication-rules-off`, checked
// inside the CLI per invocation and effective within one turn. This adapter has none of its
// own; one switch, one place.
//
// FAIL-OPEN CONTRACT. A dead adapter must be visible, never fatal: every failure path (CLI
// crash, non-zero exit, unparseable stdout, timeout, any thrown error anywhere) returns
// undefined and leaves one `omp-adapter fail-open: …` line in errors.log. That line is the
// tally: `grep -c 'omp-adapter fail-open' errors.log`.
//
// TIMEOUT: 32s, owned by defaultRunCli, which SIGKILLs the CLI's whole process group when it
// fires. The arithmetic, from the core: one stop runs its judge calls in PARALLEL
// (communication-rules-stop.mjs, Promise.all over askJudge), each capped at
// DEFAULT_TIMEOUT_MS = 30_000 (judge/ask.mjs:49), which SIGKILLs the judge's /bin/sh. Nothing
// the core reads changes that cap: askJudge takes timeoutMs only as a test option the hook
// never passes, and the profile has no timeout field. Worst case for a judge that dies with
// its /bin/sh = 30_000ms + spawn/startup/checks, measured 30_056ms end to end
// (judgeCommand `sleep 45`); the same overhead without a judge measured 38-60ms. 32s clears
// that by ~2s, so the adapter never kills a run the core would finish. Two limits it does
// not fix: (1) a judge whose grandchild survives that SIGKILL (`sleep 45 | cat` measured
// 45_055ms) holds the core open with no cap of its own; the group kill here is what bounds
// it, at 32s; (2) OMP abandons any session_stop handler at a fixed 30s
// (EXTENSION_HANDLER_TIMEOUT_MS, pi-coding-agent extensibility/extensions/runner.ts), so a
// stop whose judge runs to its 30s cap loses its verdict to the host whatever this value
// is. Only a core judge-budget knob closes (2); none exists, and this adapter adds none.
//
// SYNTAX: erasable-types TypeScript only, so node v24.13 strips the types and imports this
// module without Bun. The spawn is node:child_process, which Bun implements, so the default
// path runs under both node --test and the omp host. `pi` is typed structurally — zero
// imports from @oh-my-pi.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PLUGIN_ROOT = "/Users/jowolff/code/jo-wolff-plugins/plugins/communication-rules";
const DEFAULT_STATE_DIR = join(homedir(), ".claude", ".communication-rules-state");
const CLI_TIMEOUT_MS = 32_000;

type StopEvent = {
  session_id?: unknown;
  session_file?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
};

type CliVerdict = { decision?: unknown; reason?: unknown };

type HandlerDeps = {
  runCli?: (payload: string, cwd: string, timeoutMs: number) => Promise<CliVerdict | undefined>;
  stateDir?: string;
  timeoutMs?: number;
};

// Session ids whose most recent result from this handler was a block. One per loaded module,
// so one per omp process. Bounded without eviction: an id is added only on a block and
// removed on that session's next call through this handler, whatever its result, so the set
// holds at most the sessions whose latest stop this plugin blocked and that have not stopped
// since. A missing or non-string session_id shares the key "", which keeps the cap rather
// than dropping it.
const blockedLastStop = new Set<string>();

// Structural stand-in for the host's extension API: the one event this adapter registers.
// Deliberately local — importing @oh-my-pi would couple an unregistered file to a host.
type PiLike = {
  on(name: "session_stop", handler: (event: StopEvent, ctx: { cwd: string }) => unknown): void;
};

// Whitespace collapsed, trimmed, capped — the shape every log line shares (appendLog
// collapses again; that pass is idempotent).
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
// node, payload on stdin, stdout parsed as JSON. Failure semantics differ from the live
// runCommand on purpose: a non-zero exit or unparseable stdout REJECTS instead of dissolving
// into undefined, because this adapter logs every fail-open rather than silently passing.
// The timeout lives here, next to the child it has to kill. detached puts sh/node and every
// judge the core spawns in one fresh process group, so one negative-pid SIGKILL reaps them
// all without touching the host's own group.
function defaultRunCli(payload: string, cwd: string, timeoutMs: number): Promise<CliVerdict | undefined> {
  const root = process.env.COMMUNICATION_RULES_PLUGIN_ROOT ?? DEFAULT_PLUGIN_ROOT;
  const { promise, resolve, reject } = Promise.withResolvers<CliVerdict | undefined>();
  const child = spawn("sh", ["-lc", `node "${root}/hooks/communication-rules-stop.mjs"`], {
    cwd,
    detached: true,
    env: { ...process.env, COMMUNICATION_RULES_HARNESS: "omp" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  let settled = false;
  const settle = (finish: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish();
  };
  const timer = setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // the group already exited between the last event and this timer
    }
    settle(() => reject(new Error(`omp-adapter: CLI timed out after ${timeoutMs}ms`)));
  }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.on("error", (err) => settle(() => reject(err)));
  child.on("close", (code, signal) =>
    settle(() => {
      if (code !== 0) {
        const detail = stdout.trim() ? `: ${collapse(stdout)}` : " with no output";
        reject(new Error(`omp-adapter: CLI exited ${code ?? signal}${detail}`));
      } else if (!stdout.trim()) {
        resolve(undefined); // the CLI's documented quiet path: no verdict, exit 0
      } else {
        try {
          resolve(JSON.parse(stdout) as CliVerdict);
        } catch (err) {
          reject(err);
        }
      }
    }),
  );
  child.stdin.on("error", () => {}); // a CLI that exits before reading stdin is not a crash
  child.stdin.end(payload);
  return promise;
}

// The whole gate. deps exists so node --test can inject a fake runCli, a temp stateDir, and a
// tight timeoutMs; the default spawn runs under node too, so the real path is tested as well.
export async function sessionStopHandler(
  event: StopEvent,
  ctx: { cwd: string },
  deps?: HandlerDeps,
): Promise<{ decision: "block"; reason: string } | undefined> {
  const stateDir = deps?.stateDir ?? DEFAULT_STATE_DIR;
  const key = typeof event.session_id === "string" ? event.session_id : "";
  const followsOwnBlock = !!event.stop_hook_active && blockedLastStop.has(key);
  blockedLastStop.delete(key); // re-added below only if this call blocks
  try {
    const runCli = deps?.runCli ?? defaultRunCli;
    const payload = buildStopPayload({ ...event, stop_hook_active: followsOwnBlock }, ctx.cwd);
    const verdict = await runCli(payload, ctx.cwd, deps?.timeoutMs ?? CLI_TIMEOUT_MS);
    if (verdict?.decision === "block" && typeof verdict.reason === "string" && verdict.reason) {
      blockedLastStop.add(key);
      return { decision: "block", reason: verdict.reason };
    }
    return undefined; // quiet or non-block verdict: nothing to gate, nothing to log
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    appendLog(stateDir, "errors.log", `omp-adapter fail-open: ${detail}`);
    return undefined;
  }
}

// Registration entry point. UNREGISTERED today — see REGISTRATION.md.
export default function communicationRulesOmp(pi: PiLike): void {
  pi.on("session_stop", (event, ctx) => sessionStopHandler(event, ctx));
}
