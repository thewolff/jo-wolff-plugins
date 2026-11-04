// delegation-omp.ts — the OMP half of the delegation gates.
//
// OMP does not run a plugin's hooks/hooks.json, so the Claude Code PreToolUse, PostToolUse and
// SubagentStop hooks never fire there. This extension does the same jobs on OMP events, with
// the same pure judges (lib/brief.mjs, lib/receipt.mjs) and the same config (lib/config.mjs).
//
// GATES 1, 4, 2 on `tool_call` for the `task` tool. OMP's spawn is one call carrying
// `tasks[]` and a shared `context`; OMP puts `context` in front of every task's prompt, so each
// entry is judged on `context + "\n\n" + task`, and a section that lives in `context` counts for
// every entry. The single-task form (a top-level `task` string, no `tasks`) is judged as one
// entry. An entry's `agent` is the agent name (falling back to a top-level `agent`; missing =
// OMP's default `task`, which is in the default builder class). A name in config
// `readOnlyAgents` (reviewer-codex, scout, reader, …) is exempt from every gate, `## How it
// fails` included, matching Plumb's own How-it-fails gate on OMP, which exempts read-only
// agents outright; two gates disagreeing on one dispatch would refuse Plumb's read-only spawns.
// (The Claude Code spawn gate still asks a read-only agent for `## How it fails`.) Every other
// entry is judged; the first failing one blocks the whole call with `{ block: true, reason }`
// naming the task index.
// The receipt (gate 2) is keyed on `ctx.sessionManager.getSessionId()` and `ctx.cwd`, the same
// way pattern-check's OMP adapter keys its own receipt. The handler does no I/O beyond the
// config read and two existsSync calls: an OMP tool_call handler that throws or exceeds its
// timeout is converted into a block (runner.ts onFailure), so everything here is wrapped and
// returns undefined on any fault.
//
// THE STOP WARNING on `tool_result` for `task`: `details.results[]` carries each subagent's
// `agent` and final `output`; a builder-class result whose output has no valid
// `Stopped because:` line adds an `additionalContext` warning (never a block, never a
// modified result).
//
// GATE 3's OMP TWIN on `tool_result` for `write` with an `agent://` path: OMP already sets
// `isError` on a failed peer send (src/irc/messaging.ts executeSend: "Failed: <id> is not
// running"), so the adapter only adds the instruction the Claude Code hook adds, as
// additionalContext. A send to a parked peer is queued and revived, not failed, so it is not
// flagged; whether the peer will act on the message is not knowable here and is documented as
// a limit in the README.
//
// Subagent context: gates run in subagents too (a subagent's spawn is a spawn), matching the
// Claude Code hooks, which fire for nested Agent calls.
//
// SYNTAX: erasable-types TypeScript only, so node strips the types and imports this file in
// the unit tests without Bun. `pi` is typed structurally; there are no imports from the host.

import { loadConfig, logSkipped } from "../lib/config.mjs";
import { headingReason, inList, isBuilderClass, missingHeadings, sessionBlock, stoppedBecause, stopWarning, NOT_DELIVERED } from "../lib/brief.mjs";
import { checkReceipt, receiptReason } from "../lib/receipt.mjs";

export type OmpContext = { cwd?: string; agent?: { kind?: unknown }; sessionManager?: { getSessionId?: () => unknown } } | undefined;
export type ToolCallEvent = { toolName?: unknown; input?: unknown };
export type ToolResultEvent = { toolName?: unknown; input?: unknown; details?: unknown; isError?: unknown };
export type BlockResult = { block: true; reason: string };
export type ContextResult = { additionalContext: string };
/** lib/receipt.mjs checkReceipt's answer. */
export type ReceiptResult = { status: "present" | "missing" | "skipped"; why?: string; path?: string; key?: string; command?: string; config?: string };
/** OMP's `task` tool input; every field unknown until checked with typeof. */
export type TaskCallInput = { tasks?: unknown; task?: unknown; context?: unknown; agent?: unknown };
export type TaskEntry = { task?: unknown; agent?: unknown };
/** OMP's `task` tool result details (pi-tui TaskToolDetails); fields unknown until checked. */
export type TaskResultDetails = { results?: unknown };
export type TaskSingleResult = { agent?: unknown; id?: unknown; output?: unknown };
export type WriteInput = { path?: unknown };
/** The teaching block as an OMP custom message (hidden from the UI, present to the model). */
export type TeachMessage = { customType: "delegation"; content: string; display: false };
export type ContextEvent = { messages?: unknown };
type Handler<E, R> = (event: E, ctx: OmpContext) => R | undefined;
export type PiLike = {
  on(event: "tool_call", handler: Handler<ToolCallEvent, BlockResult>): void;
  on(event: "tool_result", handler: Handler<ToolResultEvent, ContextResult>): void;
  on(event: "before_agent_start", handler: Handler<unknown, { message: TeachMessage }>): void;
  on(event: "context", handler: Handler<ContextEvent, undefined>): void;
  on(event: "session_compact", handler: Handler<unknown, undefined>): void;
};
export type AdapterDeps = { env?: NodeJS.ProcessEnv; home?: string };
export const TEACH_TYPE = "delegation";

const HOOK = "omp";
const EMPTY: Readonly<Record<never, never>> = Object.freeze({});

/** The spawn gate for one `task` call. Pure apart from the config read and the receipt lookup. */
export function judgeTaskCall(input: unknown, ctx: OmpContext, deps: AdapterDeps = {}): BlockResult | undefined {
  const env = deps.env ?? process.env;
  const { config } = loadConfig(env, deps.home);
  if (config.off) return undefined;
  // Host-supplied tool input: the shape is OMP's `task` schema, and every field read is re-checked with typeof.
  const call = (typeof input === "object" && input !== null ? input : EMPTY) as TaskCallInput;
  const single = !Array.isArray(call.tasks) && typeof call.task === "string";
  if (!Array.isArray(call.tasks) && !single) {
    logSkipped(HOOK, "task call: neither a tasks array nor a task string; spawn allowed unchecked", env, deps.home);
    return undefined;
  }
  const entries: unknown[] = single ? [{ task: call.task, agent: call.agent }] : (call.tasks as unknown[]);
  const context = typeof call.context === "string" ? call.context : "";
  let receipt: ReceiptResult | undefined;
  for (let i = 0; i < entries.length; i++) {
    const raw: unknown = entries[i];
    const label = single ? "task" : `tasks[${i}]`;
    // One entry of OMP's `tasks[]`; both fields re-checked below.
    const t = (typeof raw === "object" && raw !== null ? raw : EMPTY) as TaskEntry;
    if (typeof t.task !== "string") {
      logSkipped(HOOK, `task call: ${label}.task is not a string; spawn allowed unchecked`, env, deps.home);
      continue;
    }
    const agent = typeof t.agent === "string" ? t.agent : typeof call.agent === "string" ? call.agent : "task";
    if (inList(agent, config.readOnlyAgents)) continue;
    const builder = isBuilderClass(agent, config.builderClass, config.readOnlyAgents);
    const prompt = context ? `${context}\n\n${t.task}` : t.task;
    const missing = missingHeadings(prompt, { builder, requireHowItFails: config.requireHowItFails, requireSpiralBound: config.requireSpiralBound });
    if (missing.length) return { block: true, reason: `${label}: ${headingReason(missing, agent, { builder })}` };
    if (builder && config.requirePatternCheck) {
      if (!receipt) {
        let id: unknown;
        try {
          id = ctx?.sessionManager?.getSessionId?.();
        } catch {
          id = undefined;
        }
        receipt = checkReceipt({ sessionId: typeof id === "string" ? id : undefined, cwd: ctx?.cwd ?? process.cwd() }, env, deps.home);
      }
      if (receipt.status === "skipped") logSkipped(HOOK, `pattern-check receipt not checked: ${receipt.why}; spawn allowed`, env, deps.home);
      else if (receipt.status === "missing") return { block: true, reason: `${label}: ${receiptReason(agent, receipt)}` };
    }
  }
  return undefined;
}

/** The stop warning for a finished `task` call's results. */
export function judgeTaskResult(details: unknown, deps: AdapterDeps = {}): ContextResult | undefined {
  const { config } = loadConfig(deps.env ?? process.env, deps.home);
  if (config.off) return undefined;
  // Host-supplied result details (TaskToolDetails); every field read is re-checked with typeof.
  const d = (typeof details === "object" && details !== null ? details : EMPTY) as TaskResultDetails;
  if (!Array.isArray(d.results)) return undefined;
  const warnings: string[] = [];
  for (const raw of d.results as unknown[]) {
    // One SingleResult; both fields re-checked below.
    const r = (typeof raw === "object" && raw !== null ? raw : EMPTY) as TaskSingleResult;
    if (typeof r.agent !== "string" || !isBuilderClass(r.agent, config.builderClass, config.readOnlyAgents)) continue;
    const verdict = stoppedBecause(typeof r.output === "string" ? r.output : "");
    if (!verdict.valid) warnings.push(stopWarning(r.agent, typeof r.id === "string" ? r.id : undefined, verdict));
  }
  return warnings.length ? { additionalContext: warnings.join("\n") } : undefined;
}

/** Gate 3's twin: a failed `write agent://…` gets the not-delivered instruction. */
export function judgeAgentWrite(input: unknown, isError: unknown, deps: AdapterDeps = {}): ContextResult | undefined {
  if (isError !== true) return undefined;
  // Host-supplied write input; the one field read is re-checked with typeof.
  const w = (typeof input === "object" && input !== null ? input : EMPTY) as WriteInput;
  if (typeof w.path !== "string" || !w.path.startsWith("agent://")) return undefined;
  const { config } = loadConfig(deps.env ?? process.env, deps.home);
  if (config.off) return undefined;
  return { additionalContext: `delegation: the write to ${w.path} failed; ${NOT_DELIVERED}` };
}

export default function delegationOmp(pi: PiLike, deps: AdapterDeps = {}): void {
  // THE TEACHING BLOCK, once per session (the Claude Code SessionStart twin). OMP may re-run
  // the before_agent_start chain for one submission and publish only the accepted attempt's
  // messages (omp extensions.md, "Handlers must tolerate re-entry"), so the block is offered on
  // every before_agent_start until a `context` event shows a message of TEACH_TYPE in the
  // conversation: that is the proof it reached a provider request. A new session id (fresh
  // session, switch) starts over, and so does a `session_compact` of the main session (the
  // Claude Code twin re-injects on SessionStart source "compact"; i-have-audhd's OMP adapter
  // listens to the same event): the block is offered again until a context event shows it.
  // Subagent sessions (ctx.agent.kind "sub") are skipped: their parent's brief is what they
  // read, and their own spawns are still gated.
  let taughtSession: string | undefined;
  let taught = false;
  const sessionOf = (ctx: OmpContext): string => {
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      return typeof id === "string" ? id : "";
    } catch {
      return "";
    }
  };
  pi.on("before_agent_start", (_event, ctx) => {
    try {
      if (ctx?.agent?.kind === "sub") return undefined;
      const id = sessionOf(ctx);
      if (id !== taughtSession) {
        taughtSession = id;
        taught = false;
      }
      if (taught) return undefined;
      const { config } = loadConfig(deps.env ?? process.env, deps.home);
      if (config.off) return undefined;
      return { message: { customType: TEACH_TYPE, content: sessionBlock(config.builderClass), display: false } };
    } catch {
      return undefined;
    }
  });
  pi.on("context", (event) => {
    const messages = event?.messages;
    if (taught || !Array.isArray(messages)) return undefined;
    // Host-supplied message list; the one field read is re-checked below.
    taught = (messages as unknown[]).some((m) => typeof m === "object" && m !== null && (m as { customType?: unknown }).customType === TEACH_TYPE);
    return undefined;
  });
  pi.on("session_compact", (_event, ctx) => {
    if (ctx?.agent?.kind !== "sub") taught = false;
    return undefined;
  });
  pi.on("tool_call", (event, ctx) => {
    try {
      if (event?.toolName !== "task") return undefined;
      return judgeTaskCall(event.input, ctx, deps);
    } catch {
      return undefined; // a throw here would be converted into a block of every task call
    }
  });
  pi.on("tool_result", (event) => {
    try {
      if (event?.toolName === "task") return judgeTaskResult(event.details, deps);
      if (event?.toolName === "write") return judgeAgentWrite(event.input, event.isError, deps);
      return undefined;
    } catch {
      return undefined;
    }
  });
}
