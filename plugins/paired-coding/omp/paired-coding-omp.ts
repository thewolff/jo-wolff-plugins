// paired-coding-omp.ts — the OMP host adapter for the paired-coding gate.
//
// A thin shell. Every verdict comes from the gate core (core/gate.mjs) through the shared
// session layer (lib/verbs.mjs); this file only maps OMP's extension events onto it:
//
//   tool_call          -> verdict(): a refused tool returns { block: true }. OMP stops at the
//                         first handler that blocks (runner.ts emitToolCall), so no later
//                         extension can undo a refusal.
//   input              -> recordTrustedInput() with the event's own `source`. Only the
//                         interactive editor emits this event, always with source
//                         "interactive" (modes/controllers/input-controller.ts, the
//                         emitInput call in #runInputHandlers). Messages an extension injects
//                         with sendUserMessage never pass through it, so they never count as the
//                         user's words. The handler returns nothing: it never revises input.
//   registerTool       -> one OMP tool per PAIR_TOOLS entry. Each execute() calls executeVerb()
//                         on the arguments it received, which are the final ones: OMP hands
//                         execute the last tool_call revision, so a later extension that
//                         rewrites a pair_write path or a pair_run command is checked as
//                         rewritten (adversarial test 16).
//   session_shutdown   -> endSession(): reap every pair_run process group, take the final
//                         snapshot, go inactive.
//
// INERT UNTIL pair_start. OMP loads every file in its extensions directory into every session,
// so each handler first checks the session's activation marker (an existsSync, no file
// created) and returns at once when it is absent.
//
// ONE WRITE GATE PER SESSION. Another gate that also owns write enforcement must not run beside
// this adapter, or the session would have two trusted-input stores and two sets of verdicts.
// OMP gives an extension no list of the other loaded extensions (getExtensionPaths lives on the
// runner, not on ExtensionAPI), so the install names one tool such a gate registers in
// $PAIRED_CODING_CONFLICTING_TOOLS (comma-separated). pair_start reads pi.getAllTools() and
// refuses to activate when any listed tool is present. Unset or empty, the check is skipped.
//
// SYNTAX: erasable-types TypeScript only, so node strips the types and imports this file in the
// unit tests without Bun. `pi` is typed structurally; there are no imports from the host.

import { PAIR_TOOLS } from "../core/gate.mjs";
import { endSession, executeVerb, recordTrustedInput, sessionDirFor, verdict } from "../lib/verbs.mjs";

// ─── host shapes (structural; only what this adapter reads) ────────────────────────────

type TextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean };

export type OmpContext = {
	cwd: string;
	hasUI?: boolean;
	sessionManager: { getSessionId(): string };
	ui?: { notify(message: string, level?: "info" | "warning" | "error"): void };
};

type Schema = unknown;
type ZodLike = {
	object(shape: Record<string, Schema>): Schema;
	string(): { describe(d: string): Schema & { optional(): Schema } } & { optional(): Schema };
	number(): { describe(d: string): Schema & { optional(): Schema } };
	boolean(): { describe(d: string): Schema & { optional(): Schema } };
	array(item: Schema): { describe(d: string): Schema & { optional(): Schema } };
};

type ToolDefinition = {
	name: string;
	label: string;
	description: string;
	parameters: Schema;
	loadMode?: "essential" | "discoverable";
	approval?: "read" | "write" | "exec";
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: OmpContext,
	): Promise<TextResult>;
};

export type PiLike = {
	zod: ZodLike;
	on(event: "tool_call", handler: (event: { toolName: string }, ctx: OmpContext) => unknown): void;
	on(event: "input", handler: (event: { text: string; source: string }, ctx: OmpContext) => unknown): void;
	on(event: "session_shutdown", handler: (event: unknown, ctx: OmpContext) => unknown): void;
	registerTool(tool: ToolDefinition): void;
	getAllTools(): Array<{ name: string }>;
};

// ─── session binding ───────────────────────────────────────────────────────────────────

/** This session's state directory, or null when OMP's session id is not a safe path segment. */
function dirOf(ctx: OmpContext, env: Record<string, string | undefined>): string | null {
	return sessionDirFor(ctx.sessionManager.getSessionId(), env);
}

/** Tool names from $PAIRED_CODING_CONFLICTING_TOOLS: comma-separated, trimmed, empties dropped. */
export function conflictingToolNames(env: Record<string, string | undefined>): string[] {
	return (env.PAIRED_CODING_CONFLICTING_TOOLS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Why another write gate is loaded in this session, or null: a tool the install listed in
 * $PAIRED_CODING_CONFLICTING_TOOLS is registered here. With no list, nothing is checked.
 */
export function conflictingGate(pi: Pick<PiLike, "getAllTools">, env: Record<string, string | undefined>): string | null {
	const listed = conflictingToolNames(env);
	if (listed.length === 0) return null;
	let tools: Array<{ name: string }>;
	try {
		tools = pi.getAllTools();
	} catch {
		return "the host's tool list could not be read, so another write gate cannot be ruled out";
	}
	const found = listed.find((name) => tools.some((t) => t.name === name));
	return found
		? `another write gate is loaded in this session (its tool ${found} is listed in PAIRED_CODING_CONFLICTING_TOOLS), so this adapter stays off`
		: null;
}

// ─── tools ─────────────────────────────────────────────────────────────────────────────

function text(t: string, isError: boolean, details?: unknown): TextResult {
	return { content: [{ type: "text", text: t }], ...(details === undefined ? {} : { details }), isError };
}

type ToolSpec = { label: string; description: string; approval: "read" | "write" | "exec"; parameters: (z: ZodLike) => Schema };

const STR = (z: ZodLike, d: string) => z.string().describe(d);
const OPT_STR = (z: ZodLike, d: string) => z.string().describe(d).optional();
const OPT_LIST = (z: ZodLike, d: string) => z.array(z.string()).describe(d).optional();

const SPECS: Record<string, ToolSpec> = {
	pair_start: {
		label: "Pair: start",
		description:
			"Start a paired-coding session in this worktree. From then on the host's write, edit, shell, eval and sub-agent tools are refused; files change only through pair_write or pair_edit inside a change set your partner agreed to, and commands run only through pair_run.",
		approval: "write",
		parameters: (z) => z.object({ exclusions: OPT_LIST(z, "Worktree-relative directories left out of snapshots (large generated directories such as node_modules). Journaled.") }),
	},
	pair_stop: {
		label: "Pair: stop",
		description:
			"End pairing. Only when your partner asked to stop: `quote` must be their exact words from their latest turn. Refused while a change set is open or a pair_run is running.",
		approval: "write",
		parameters: (z) => z.object({ quote: STR(z, "Your partner's exact words asking to stop, copied verbatim from their latest turn.") }),
	},
	pair_note: {
		label: "Pair: note",
		description: "Append a note (roadmap, observation) to the pairing journal. The only place to keep notes while pairing.",
		approval: "read",
		parameters: (z) => z.object({ text: STR(z, "The note.") }),
	},
	pair_propose: {
		label: "Pair: propose card",
		description:
			"Record the next change card. Show it to your partner and wait: only a turn they type after this card can agree to it. A card with open points cannot be begun.",
		approval: "read",
		parameters: (z) =>
			z.object({
				boundary: z.array(z.string()).describe("Worktree-relative files the change may touch. `*`, `?`, `**` are globs; a trailing `/` covers a subtree."),
				whyNow: OPT_STR(z, "Why this change, now."),
				decision: OPT_STR(z, "The decision the card asks for."),
				currentCode: OPT_STR(z, "What the code does today."),
				effect: OPT_STR(z, "What will be different afterwards."),
				checks: OPT_LIST(z, "The checks that will show it works."),
				openPoints: OPT_LIST(z, "Questions still open. While any remain, pair_begin is refused."),
			}),
	},
	pair_begin: {
		label: "Pair: begin change set",
		description:
			"Open the change set for the latest card. `quote` must be your partner's words of agreement, copied verbatim from the turn they typed after the card. Refused if the boundary files changed since the card.",
		approval: "write",
		parameters: (z) =>
			z.object({
				cardId: STR(z, "The latest card's id, e.g. card-1."),
				quote: STR(z, "Your partner's words of agreement, verbatim from their latest turn."),
			}),
	},
	pair_done: {
		label: "Pair: done",
		description:
			"Close the open change set. Kills anything left running from its pair_run calls, then returns the machine-produced diff of the boundary since pair_begin for your partner to read back.",
		approval: "write",
		parameters: (z) => z.object({ cardId: STR(z, "The open change set's card id.") }),
	},
	pair_write: {
		label: "Pair: write file",
		description: "Write a whole file inside the open change set's boundary. Refused anywhere else.",
		approval: "write",
		parameters: (z) =>
			z.object({
				path: STR(z, "Worktree-relative path inside the boundary."),
				content: STR(z, "The complete new file content."),
			}),
	},
	pair_edit: {
		label: "Pair: edit file",
		description: "Replace text in a file inside the open change set's boundary. Refused anywhere else.",
		approval: "write",
		parameters: (z) =>
			z.object({
				path: STR(z, "Worktree-relative path inside the boundary."),
				oldString: STR(z, "Exact text to replace; must occur once unless replaceAll is true."),
				newString: STR(z, "Replacement text."),
				replaceAll: z.boolean().describe("Replace every occurrence.").optional(),
			}),
	},
	pair_run: {
		label: "Pair: run command",
		description:
			"Run a shell command in the worktree, in the foreground, under a sandbox built from the pairing state: no worktree writes without an open change set, and only the boundary (plus temp) while one is open. It has its own timeout; on timeout or abort the whole process group is killed.",
		approval: "exec",
		parameters: (z) =>
			z.object({
				command: STR(z, "The command, run with /bin/sh -c in the worktree root."),
				timeoutSeconds: z.number().describe("Timeout in seconds (default 600, max 3600).").optional(),
			}),
	},
};

// ─── registration ──────────────────────────────────────────────────────────────────────

export type AdapterDeps = {
	env?: Record<string, string | undefined>;
	/** Replaced in tests only. */
	execute?: typeof executeVerb;
};

export default function pairedCodingOmp(pi: PiLike, deps: AdapterDeps = {}): void {
	const env = deps.env ?? process.env;
	const run = deps.execute ?? executeVerb;

	pi.on("tool_call", (event, ctx) => {
		const dir = dirOf(ctx, env);
		if (!dir) return undefined; // no usable session id: nothing can have been activated under it
		const v = verdict(event.toolName, { sessionDir: dir });
		return v.allow ? undefined : { block: true, reason: `paired coding: ${v.reason}` };
	});

	pi.on("input", (event, ctx) => {
		const dir = dirOf(ctx, env);
		if (dir) recordTrustedInput({ sessionDir: dir, text: event.text, source: event.source });
		return undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const dir = dirOf(ctx, env);
		if (dir) endSession({ sessionDir: dir });
		return undefined;
	});

	for (const name of PAIR_TOOLS) {
		const spec = SPECS[name];
		if (!spec) throw new Error(`paired-coding: no OMP tool spec for ${name}`);
		pi.registerTool({
			name,
			label: spec.label,
			description: spec.description,
			parameters: spec.parameters(pi.zod),
			loadMode: "essential",
			approval: spec.approval,
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				const sessionId = ctx.sessionManager.getSessionId();
				const dir = sessionDirFor(sessionId, env);
				if (!dir) return text(`${name} refused: this session's id cannot name a state directory`, true);
				if (name === "pair_start") {
					const conflict = conflictingGate(pi, env);
					if (conflict) return text(`pair_start refused: ${conflict}`, true);
				}
				const r = await run(name, params, { sessionId, sessionDir: dir, cwd: ctx.cwd, signal, runId: toolCallId });
				const halted = name === "pair_done" && (r.result as { halted?: boolean } | undefined)?.halted === true;
				if (ctx.hasUI && ctx.ui && (halted || (name === "pair_start" && r.ok))) {
					ctx.ui.notify(halted ? `paired coding stopped the session: ${r.text}` : "paired coding is on for this session", halted ? "error" : "info");
				}
				return text(r.text, !r.ok, r.result);
			},
		});
	}
}
