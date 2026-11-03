// pattern-check-omp.ts — the OMP half of the PreToolUse counter and of the Stop refusal.
//
// OMP does not run a plugin's hooks/hooks.json, so the Claude Code PreToolUse and Stop hooks never
// fire there. This extension maps OMP's events onto the hooks' own `handle` functions
// (hooks/pattern-check-pretooluse.mjs, hooks/pattern-check-stop.mjs). Every verdict, every state
// file and every message comes from those functions and the libraries under scripts/lib; this file
// only translates payloads in and results out. One session key names one counter, one receipt and
// one refusal record, whichever host wrote them.
//
//   tool_call      edit, write and bash become a PreToolUse payload: `edit` carries `path` or, for
//                  a multi-file hashline patch, `paths` (OMP derives both for gates,
//                  extensibility/tool-event-input.ts normalizeToolEventInput), mapped to Edit with
//                  file_path plus edits[]; `write` carries `path`, mapped to Write; `bash` carries
//                  `command`, mapped to Bash. A deny becomes { block: true, reason }; OMP stops at
//                  the first handler that blocks (runner.ts emitToolCall). Paths with a URL scheme
//                  (xd://, local://, skill://, ...) are not files in the repository and are dropped
//                  before the payload is built. Every other tool passes untouched.
//   session_stop   the final assistant message's text becomes the Stop payload's
//                  last_assistant_message. A refusal becomes { decision: "block", reason }.
//   session_start, session_switch
//                  forget this instance's per-session memory: the turn last refused and the
//                  warnings already shown. Nothing on disk is reset; a session's counter lives under
//                  its own id, so a new or resumed session picks up its own.
//
// THE KEY is ctx.sessionManager.getSessionId(), passed as the payload's session_id. When it is
// unreadable, session_id is left out and the hooks' own resolver (scripts/lib/context.mjs) keys
// the session by its working directory and adds the warning that says so.
//
// ONCE PER TURN. OMP sets stop_hook_active after any extension's continuation, so the hook's
// stop_hook_active guard would skip a stop that follows another extension's block; it is passed as
// false. Instead `refusedTurn` maps the session key to the turn opener (the last `user` message in
// event.messages, by timestamp, else by index) this handler last refused, and a later stop in that
// turn passes before anything is read. OMP's continuation after a block is a `custom` message, so it
// does not open a new turn. The hook's own hash guard (stop/<key>) still applies underneath. A stop
// whose messages hold no user message cannot be tied to a turn and passes.
//
// FAIL OPEN, NOT SILENT. OMP turns a handler that throws or times out into a block (runner.ts
// emitToolCall, the failure result of #runHandlerWithTimeout), so every handler here catches
// everything and returns undefined. The plugin's own faults (the hooks' systemMessage lines, a
// throw here) go to ctx.ui.notify as one warning, each distinct line once per session.
//
// OFF SWITCH AND CONFIG: hooks.preToolUse and hooks.stop in .pattern-check.json or the user config,
// read by the hooks' handle functions from the session's working directory, exactly as on Claude
// Code.
//
// REGISTERED ONCE. Handlers are added only here, at factory time, never from an event. A second
// call with the same `pi` adds nothing. See omp/REGISTRATION.md.
//
// SYNTAX: erasable-types TypeScript only, so node strips the types and imports this file in the
// unit tests without Bun. `pi` is typed structurally; there are no imports from the host.

import { handle as preToolUse } from "../hooks/pattern-check-pretooluse.mjs";
import { handle as stopCheck } from "../hooks/pattern-check-stop.mjs";

type Env = Record<string, string | undefined>;

export type OmpContext = {
	cwd: string;
	sessionManager?: { getSessionId?: () => unknown };
	ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
};

export type ToolCallEvent = { toolName?: unknown; input?: { path?: unknown; paths?: unknown; command?: unknown } | null };
export type ToolCallResult = { block: true; reason: string };

export type StopEvent = {
	messages?: unknown;
	last_assistant_message?: unknown;
};
export type StopResult = { decision: "block"; reason: string };

export type PiLike = {
	on(event: "tool_call", handler: (event: ToolCallEvent, ctx: OmpContext) => unknown): void;
	on(event: "session_stop", handler: (event: StopEvent, ctx: OmpContext) => unknown): void;
	on(event: "session_start" | "session_switch", handler: (event: unknown, ctx: OmpContext) => unknown): void;
};

export type AdapterDeps = {
	env?: Env;
	home?: string;
	/** Replaced in tests only. */
	preToolUse?: (input: unknown, opts: { env: Env; home?: string }) => unknown;
	stopCheck?: (input: unknown, opts: { env: Env; home?: string }) => unknown;
};

type HookOutput = {
	systemMessage?: unknown;
	decision?: unknown;
	reason?: unknown;
	hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown };
} | null | undefined;

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

// Every `pi` this factory has registered on; a second call with the same one is a no-op.
const registered = new WeakSet<object>();

/** The session manager's id, or undefined when it cannot be read. */
function sessionIdOf(ctx: OmpContext): string | undefined {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		return typeof id === "string" && id !== "" ? id : undefined;
	} catch {
		return undefined;
	}
}

// A type guard (it narrows `unknown` to the path string), shared by edit and write.
const filePath = (v: unknown): v is string => typeof v === "string" && v !== "" && !URL_SCHEME.test(v);

/**
 * The PreToolUse payload for one OMP tool call, or null when the tool is none the hook watches
 * (or names no file in the repository's filesystem).
 */
export function toPreToolUse(event: ToolCallEvent, cwd: string, sessionId: string | undefined): Record<string, unknown> | null {
	const input = event?.input ?? {};
	const base = { hook_event_name: "PreToolUse", cwd, ...(sessionId ? { session_id: sessionId } : {}) };
	switch (event?.toolName) {
		case "edit": {
			const named = [input.path, ...(Array.isArray(input.paths) ? input.paths : [])].filter(filePath);
			const files = [...new Set(named)];
			if (files.length === 0) return null;
			const [first, ...rest] = files;
			return { ...base, tool_name: "Edit", tool_input: { file_path: first, ...(rest.length ? { edits: rest.map((p) => ({ file_path: p })) } : {}) } };
		}
		case "write":
			return filePath(input.path) ? { ...base, tool_name: "Write", tool_input: { file_path: input.path } } : null;
		case "bash":
			return typeof input.command === "string" ? { ...base, tool_name: "Bash", tool_input: { command: input.command } } : null;
		default:
			return null;
	}
}

/** The final message's text: string content, or its text blocks joined by newlines. Undefined when there is none. */
export function assistantText(message: unknown): string | undefined {
	const content = (message as { content?: unknown } | null | undefined)?.content;
	if (typeof content === "string") return content || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part?.text === "string")
		.map((part) => part.text)
		.join("\n");
	return text || undefined;
}

/** The identity of the turn a stop ends: its last user message, by timestamp, else by position. Null when there is none. */
export function turnOpener(messages: unknown): string | null {
	if (!Array.isArray(messages)) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown; timestamp?: unknown } | null | undefined;
		if (m?.role === "user") return typeof m.timestamp === "number" ? `t${m.timestamp}` : `i${i}`;
	}
	return null;
}

export default function patternCheckOmp(pi: PiLike, deps: AdapterDeps = {}): void {
	if (registered.has(pi)) return;
	registered.add(pi);

	// CLAUDE_PLUGIN_ROOT, when an outer host set it, names some other plugin; dropped so the
	// record command the hooks print resolves to this copy (scripts/lib/context.mjs pluginRoot).
	const env: Env = { ...(deps.env ?? process.env), CLAUDE_PLUGIN_ROOT: undefined };
	const opts = { env, home: deps.home };
	const runPreToolUse = deps.preToolUse ?? preToolUse;
	const runStop = deps.stopCheck ?? stopCheck;

	// Session key -> opener of the turn last refused. Session key -> warning lines already shown.
	const refusedTurn = new Map<string, string>();
	const shown = new Map<string, Set<string>>();

	const warn = (ctx: OmpContext, key: string, line: string): void => {
		try {
			let seen = shown.get(key);
			if (!seen) shown.set(key, (seen = new Set()));
			if (seen.has(line)) return;
			seen.add(line);
			ctx.ui?.notify?.(line, "warning");
		} catch {
			// a UI that cannot show the warning changes nothing about the verdict
		}
	};
	const relay = (ctx: OmpContext, key: string, out: HookOutput): void => {
		if (out && typeof out.systemMessage === "string") warn(ctx, key, out.systemMessage);
	};
	const fault = (what: string, e: unknown) => `pattern-check: the OMP ${what} handler failed (${e instanceof Error ? e.message : String(e)}); ${what === "tool_call" ? "this call was allowed" : "the stop was allowed"}`;

	pi.on("tool_call", (event, ctx): ToolCallResult | undefined => {
		const id = sessionIdOf(ctx);
		const key = id ?? `cwd:${ctx?.cwd}`;
		try {
			const payload = toPreToolUse(event, ctx.cwd, id);
			if (!payload) return undefined;
			const out = runPreToolUse(payload, opts) as HookOutput;
			relay(ctx, key, out);
			const hso = out?.hookSpecificOutput;
			if (hso?.permissionDecision === "deny" && typeof hso.permissionDecisionReason === "string") {
				return { block: true, reason: hso.permissionDecisionReason };
			}
			return undefined;
		} catch (e) {
			warn(ctx, key, fault("tool_call", e));
			return undefined;
		}
	});

	pi.on("session_stop", (event, ctx): StopResult | undefined => {
		const id = sessionIdOf(ctx);
		const key = id ?? `cwd:${ctx?.cwd}`;
		try {
			const opener = turnOpener(event?.messages);
			if (opener === null || refusedTurn.get(key) === opener) return undefined;
			const text = assistantText(event?.last_assistant_message);
			if (text === undefined) return undefined;
			const payload = { hook_event_name: "Stop", cwd: ctx.cwd, ...(id ? { session_id: id } : {}), stop_hook_active: false, last_assistant_message: text };
			const out = runStop(payload, opts) as HookOutput;
			relay(ctx, key, out);
			if (out?.decision === "block" && typeof out.reason === "string") {
				refusedTurn.set(key, opener);
				return { decision: "block", reason: out.reason };
			}
			return undefined;
		} catch (e) {
			warn(ctx, key, fault("session_stop", e));
			return undefined;
		}
	});

	const forget = (): undefined => {
		refusedTurn.clear();
		shown.clear();
		return undefined;
	};
	pi.on("session_start", forget);
	pi.on("session_switch", forget);
}
