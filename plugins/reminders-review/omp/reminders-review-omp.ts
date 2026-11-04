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
// DELIVERY: a block waits as `pending`, tied to the session id it was checked for, with a fresh
// delivery id, and is returned from every before_agent_start of that session as a hidden custom
// message, because OMP may re-run that chain for one submission and keeps only the accepted
// attempt's message. A `context` event whose messages carry that delivery id clears it. Same
// scheme as plugins/i-have-audhd/omp/i-have-audhd-omp.ts (DELIVERY in its header).
//
// ONE SESSION'S BLOCK STAYS IN THAT SESSION: session_start and session_switch drop whatever is
// pending before checking the new session; a before_agent_start from another session id drops it
// too; and a check still running when the session changes discards its result (`epoch`).
//
// MAIN SESSION ONLY: subagent sessions (ctx.agent.kind "sub") are skipped on every event,
// delivery included; they write to the main agent, not to the person who has to do the reminder.
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
	let pending: { session: string; content: string; delivery: string } | undefined;
	// Bumped at every session boundary: a check that started before one cannot land its result.
	let epoch = 0;

	const isSub = (ctx: Ctx): boolean => ctx?.agent?.kind === "sub";

	const check = async (event: "SessionStart" | "UserPromptSubmit", ctx: Ctx): Promise<void> => {
		if (isSub(ctx)) return;
		const session = sessionId(ctx);
		const started = epoch;
		try {
			const out = (await dueCheck(event, { session_id: session }, { env, now: deps.now, timeZone: deps.timeZone })) as HookOut;
			if (epoch !== started) return; // the session changed while remindctl ran
			const content = out?.hookSpecificOutput?.additionalContext;
			if (typeof content === "string" && content) pending = { session, content, delivery: randomUUID() };
			if (out?.systemMessage && ctx.hasUI) ctx.ui?.notify?.(out.systemMessage, "warning");
		} catch (err) {
			logError(PLUGIN, event, `omp-adapter: ${err instanceof Error ? err.message : String(err)}`, env);
		}
	};

	const boundary = (ctx: Ctx): Promise<void> | undefined => {
		if (isSub(ctx)) return undefined;
		epoch++;
		pending = undefined;
		return check("SessionStart", ctx);
	};

	pi.on("session_start", (_event, ctx) => boundary(ctx));
	pi.on("session_switch", (_event, ctx) => boundary(ctx));
	pi.on("before_agent_start", async (_event, ctx) => {
		if (isSub(ctx)) return undefined;
		const session = sessionId(ctx);
		if (pending && pending.session !== session) pending = undefined;
		if (!pending) await check("UserPromptSubmit", ctx);
		const p = pending;
		if (!p || p.session !== session) return undefined;
		return { message: { customType: MESSAGE_TYPE, content: p.content, display: false, details: { delivery: p.delivery } } };
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
