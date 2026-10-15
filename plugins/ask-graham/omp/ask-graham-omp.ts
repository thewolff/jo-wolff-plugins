// ask-graham-omp.ts — the OMP half of the every-idea nudge.
//
// OMP does not run a plugin's hooks/hooks.json, so the Claude Code UserPromptSubmit hook never
// fires there. This extension does the same job on OMP's `before_agent_start` event, which fires
// once per direct prompt and once per dequeued batch of user messages (steers and follow-ups
// typed mid-turn are folded into one batch: agent-session.ts #prepareQueuedUserMessages ->
// #prepareAgentStart -> emitBeforeAgentStart, OMP 18.8.6). It resolves the level from the
// session's working directory (skills/ask-graham/scripts/intensity.mjs) and, only at every-idea,
// returns NUDGE as a hidden custom message (display false) that OMP puts in the same request as
// the user's message. It never revises the message.
//
// Returning the message, rather than queueing it with sendMessage, keeps one nudge per batch: a
// queued "nextTurn" message parks while the agent streams and every mid-turn submission added
// another copy, all delivered together at the next idle prompt. The handler is pure (same cwd and
// settings give the same result), so OMP re-running the chain for one submission is harmless: it
// keeps only the accepted attempt's message.
//
// The plugin's package.json declares this file under omp.extensions, which OMP loads for an
// installed marketplace plugin.
//
// SYNTAX: erasable-types TypeScript only, so node strips the types and imports this file in the
// unit tests without Bun. `pi` is typed structurally; there are no imports from the host.

import { NUDGE, resolveIntensity } from "../skills/ask-graham/scripts/intensity.mjs";

export type OmpContext = { cwd: string };

export type NudgeMessage = { customType: "ask-graham"; content: string; display: false };

export type PiLike = {
	on(event: "before_agent_start", handler: (event: unknown, ctx: OmpContext) => unknown): void;
};

export type AdapterDeps = {
	env?: Record<string, string | undefined>;
	home?: string;
};

export default function askGrahamOmp(pi: PiLike, deps: AdapterDeps = {}): void {
	const env = deps.env ?? process.env;
	pi.on("before_agent_start", (_event, ctx): { message: NudgeMessage } | undefined => {
		let level: string;
		try {
			level = resolveIntensity({ cwd: ctx.cwd, env, home: deps.home }).level;
		} catch {
			return undefined; // fail open: an unreadable setting behaves as ask
		}
		if (level !== "every-idea") return undefined;
		return { message: { customType: "ask-graham", content: NUDGE, display: false } };
	});
}
