// reminders-review-omp.ts — the OMP half of the due-reminders injection.
//
// OMP does not run a plugin's hooks/hooks.json; it loads TS extension modules. This file runs the
// same check the Claude Code hooks run (lib/due.mjs dueCheck, imported, not copied) on OMP events,
// so a seat sees the same `Due (list <name>): …` block:
//
//   session_start, session_switch   the SessionStart check: the block when something is due, and
//                                   a fault line (missing / unauthorized remindctl, a bad config)
//                                   shown to the person as a UI warning
//   before_agent_start              when nothing is waiting, the UserPromptSubmit check (at most
//                                   once an hour per session, the same stamp file the hooks use)
//
// DELIVERY: a block waits as `pending` with a fresh delivery id and is returned from every
// before_agent_start as a hidden custom message, because OMP may re-run that chain for one
// submission and keeps only the accepted attempt's message. A `context` event whose messages
// carry that delivery id clears it. Same scheme as plugins/i-have-audhd/omp/i-have-audhd-omp.ts
// (DELIVERY in its header).
//
// MAIN SESSION ONLY: subagent sessions (ctx.agent.kind "sub") are skipped; they write to the main
// agent, not to the person who has to do the reminder.
//
// FAIL OPEN: dueCheck logs remindctl and config faults to errors.log and never throws for them;
// anything else thrown here is one `omp-adapter` errors.log line and no message. The remindctl
// calls are async and bounded at 2 s each, so the host's event loop is never blocked.
//
// SYNTAX: erasable-types TypeScript only, so node strips the types in the unit tests. `pi` is
// typed structurally; no imports from the host.

import { randomUUID } from "node:crypto";
import { dueCheck, PLUGIN } from "../lib/due.mjs";
import { logError } from "../lib/hook-runner.mjs";

export const MESSAGE_TYPE = "reminders-review-due";

export type Ctx = {
	cwd?: string;
	hasUI?: boolean;
	ui?: { notify?: (message: string, type: "info" | "warning" | "error") => void };
	agent?: { kind?: string };
	sessionManager?: { getSessionId?: () => unknown };
};

type HookOut = { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } } | null;

export type PiLike = {
	on(event: string, handler: (event: unknown, ctx: Ctx) => unknown): void;
};

// True when `m` is this plugin's custom message carrying `delivery`.
function carries(m: unknown, delivery: string): boolean {
	if (!m || typeof m !== "object" || !("customType" in m) || m.customType !== MESSAGE_TYPE || !("details" in m)) return false;
	const details = m.details;
	return !!details && typeof details === "object" && "delivery" in details && details.delivery === delivery;
}

export type AdapterDeps = {
	env?: Record<string, string | undefined>;
	now?: () => number;
	timeZone?: string;
};

function sessionId(ctx: Ctx): string {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		return typeof id === "string" ? id : "";
	} catch {
		return "";
	}
}

export default function remindersReviewOmp(pi: PiLike, deps: AdapterDeps = {}): void {
	const env = deps.env ?? process.env;
	let pending: { content: string; delivery: string } | undefined;

	const check = async (event: "SessionStart" | "UserPromptSubmit", ctx: Ctx): Promise<void> => {
		if (ctx?.agent?.kind === "sub") return;
		try {
			const out = (await dueCheck(event, { session_id: sessionId(ctx) }, { env, now: deps.now, timeZone: deps.timeZone })) as HookOut;
			const content = out?.hookSpecificOutput?.additionalContext;
			if (typeof content === "string" && content) pending = { content, delivery: randomUUID() };
			if (out?.systemMessage && ctx.hasUI) ctx.ui?.notify?.(out.systemMessage, "warning");
		} catch (err) {
			logError(PLUGIN, event, `omp-adapter: ${err instanceof Error ? err.message : String(err)}`, env);
		}
	};

	pi.on("session_start", (_event, ctx) => check("SessionStart", ctx));
	pi.on("session_switch", (_event, ctx) => check("SessionStart", ctx));
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!pending) await check("UserPromptSubmit", ctx);
		if (!pending) return undefined;
		return { message: { customType: MESSAGE_TYPE, content: pending.content, display: false, details: { delivery: pending.delivery } } };
	});
	// Observes only: returns nothing, so the messages OMP sends are never rewritten.
	pi.on("context", (event) => {
		const messages = event && typeof event === "object" && "messages" in event ? event.messages : undefined;
		if (!pending || !Array.isArray(messages)) return undefined;
		const delivery = pending.delivery;
		if (messages.some((m: unknown) => carries(m, delivery))) pending = undefined;
		return undefined;
	});
}
