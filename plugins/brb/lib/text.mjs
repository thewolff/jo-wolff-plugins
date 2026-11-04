// text.mjs — every sentence brb says, in one place: the confirmation `brb` prints, the away
// instruction the agent reads on each turn while Jo is away, the hold command the instruction
// names, the Stop hook's keep-working reason and its backstop block. The README quotes the
// instruction verbatim; change both together.

import { fileURLToPath } from "node:url";

/** `brb`'s one confirmation line (as2's AWAY_NOTICE, surface/src/batch.ts). */
export const AWAY_NOTICE = "brb: holding needs-you items until `back`; on-fire items still come through";

/**
 * The surface word the whole trimmed prompt is: `brb` (with an optional note after it, `brb lunch`,
 * `brb, lunch`, `brb: lunch`), `back`, `pending`, each with trailing `.`, `!` or `?` allowed;
 * null for anything else.
 */
export function surfaceWord(text) {
  const t = String(text ?? "").trim();
  const m = /^(brb|back|pending)(?=$|[\s,:;.!?])[\s,:;.!?]*(.*)$/is.exec(t);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const rest = m[2].trim();
  if (word !== "brb" && rest) return null; // `back now please` is a sentence, not the word
  return { word, note: word === "brb" ? rest.replace(/\s+/g, " ").slice(0, 200) : "" };
}

/** The absolute path of scripts/brb.mjs, the command the agent runs to hold an item. */
export const HOLD_SCRIPT = fileURLToPath(new URL("../scripts/brb.mjs", import.meta.url));

/**
 * The hold command as the agent types it: `node "<script>" hold --session <id> "<item>"`. The
 * script path and session id are filled in by the hook that renders the instruction, so the
 * agent needs no env (CLAUDE_PLUGIN_ROOT is not set in its shell).
 */
export function holdCommand(sessionId, script = HOLD_SCRIPT) {
  const id = String(sessionId ?? "").trim();
  return `node "${script}" hold${id ? ` --session "${id.replace(/["\\$`]/g, "")}"` : ""} "<one item, readable on its own>"`;
}

/**
 * The away instruction: the contract between brb and the agent. Reaches the agent as
 * UserPromptSubmit additionalContext on every prompt while away, as SessionStart additionalContext
 * on a resume while away, and on OMP as a hidden message before each turn. `command` is the hold
 * command for this session (holdCommand); rule 2 names it.
 */
export function awayInstruction(away, command = holdCommand("")) {
  const n = away.held;
  return [
    `brb: Jo is away since ${away.since}${away.note ? ` (${away.note})` : ""}. Keep working; do not stop to wait for an answer.`,
    "While away:",
    "1. Keep working on the next open item. Choose the safer reversible option yourself where a choice is small; where it is not, write the ask down (rule 2) and move to the next item.",
    `2. Every question, decision or approval you need from Jo is written, not shown: run ${command} once per item, then leave it out of your reply. While away a reply has no \`Needs you\` section, no question sentence and no closing ask; it says only what was done. The command prints \`held N\`; a held item is not lost, so do not restate it. A Stop hook moves any \`Needs you\` section or closing ask that still appears into the digest and sends the reply back once.`,
    "3. Start a line with `on fire:` only for one of these: a broken main branch, data loss, a security finding, spend near a ceiling, or a blocker on everything you could work on. Those lines reach Jo at once. Anything else waits in the digest.",
    "4. When nothing is runnable without Jo, end the message with a line `idle: <why>`. brb then lets the turn end; without that line a Stop hook sends you back to work.",
    `${n} item${n === 1 ? "" : "s"} held so far.`,
  ].join("\n");
}

/** The Stop hook's keep-working reason while away: the digest holds the ask, keep going or say idle. */
export function keepWorkingReason(held) {
  return `brb is holding your asks (${held} in the digest). Keep working on the next open item; if nothing is runnable end with a line \`idle: <why>\`.`;
}

/** The Stop hook's backstop block while away: a reply still showed asks; they are in the digest now, reply again without them. */
export function backstopReason(n) {
  return `brb: ${n} item${n === 1 ? "" : "s"} moved to the digest; do not restate them — reply with the body only and end with \`idle: <why>\`.`;
}

/** The most a `back` or `pending` reason carries; past it the digest is cut and points at its file. */
export const REASON_CAP = 8000;

/**
 * `head` (one line, kept whole), a blank line, then `body` cut at a line boundary so the whole stays
 * within REASON_CAP, ending `… (N more lines; full digest: <path>)` when cut.
 */
export function cappedReason(head, body, path) {
  const whole = `${head}\n\n${body}`;
  if (whole.length <= REASON_CAP) return whole;
  const lines = body.split("\n");
  const room = REASON_CAP - head.length - 2 - `\n… (${lines.length} more lines; full digest: ${path})`.length;
  const kept = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > room) break;
    kept.push(l);
    used += l.length + 1;
  }
  return `${head}\n\n${kept.join("\n")}\n… (${lines.length - kept.length} more lines; full digest: ${path})`;
}
