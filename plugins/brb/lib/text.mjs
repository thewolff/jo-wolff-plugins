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

/** `40m`, `1h 5m`, `2d 3h` between two ISO times; "" when either does not parse. A `since` in the future reads `0m`. */
export function awayFor(since, now) {
  const ms = Date.parse(now) - Date.parse(since);
  if (!Number.isFinite(ms)) return "";
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

/** `brb: still away since <since> (<duration>); N held`: the instruction's first line and a second `brb`'s. */
export function stillAwayLine(away, now) {
  const d = awayFor(away.since, now);
  return `brb: still away since ${away.since}${d ? ` (${d})` : ""}; ${away.held} held`;
}

/** What a second `brb` while away says, to Jo and at the head of the agent's context. */
export function alreadyAwayText(away, now) {
  return `${stillAwayLine(away, now)}. Only \`back\` ends the hold; \`pending\` peeks. Your questions answered while away did not end it.`;
}

/** `brb: still away (<duration>, N held) — say \`back\` to read them`: the first line of every reply while away (rule 5). */
export function replyFirstLine(away, now) {
  const d = awayFor(away.since, now);
  return `brb: still away (${d ? `${d}, ` : ""}${away.held} held) — say \`back\` to read them`;
}

/**
 * Whether a reply starts with the still-away line: its first non-blank line, past any `>`, `*`,
 * `_` or backtick, begins `brb: still away` (any case). The live values are not compared; they
 * move during a turn.
 */
export function hasReplyFirstLine(message) {
  const first = String(message ?? "").split("\n").find((l) => l.trim() !== "") ?? "";
  return /^brb: still away\b/i.test(first.replace(/^[\s>*_`]+/, ""));
}

/**
 * The away instruction: the contract between brb and the agent. Reaches the agent as
 * UserPromptSubmit additionalContext on every prompt while away, as SessionStart additionalContext
 * on a resume while away, and on OMP as a hidden message before each turn. `command` is the hold
 * command for this session (holdCommand); rule 2 names it. The first line says the hold is still
 * on, so a turn spent answering a fire does not read as the end of it (rule 6).
 */
export function awayInstruction(away, command = holdCommand(""), now = new Date().toISOString()) {
  const n = away.held;
  return [
    stillAwayLine(away, now),
    `Jo is away${away.note ? ` (${away.note})` : ""}. Keep working; do not stop to wait for an answer.`,
    "While away:",
    "1. Keep working on the next open item. Choose the safer reversible option yourself where a choice is small; where it is not, write the ask down (rule 2) and move to the next item.",
    `2. Every question, decision or approval you need from Jo is written, not shown: run ${command} once per item, then leave it out of your reply. While away a reply has no \`Needs you\` section, no question sentence and no closing ask; it says only what was done. The command prints \`held N\`; a held item is not lost, so do not restate it. A Stop hook moves any \`Needs you\` section or closing ask that still appears into the digest and sends the reply back once.`,
    "3. Start a line with `on fire:` only for one of these: a broken main branch, data loss, a security finding, spend near a ceiling, or a blocker on everything you could work on. Those lines reach Jo at once. Anything else waits in the digest.",
    "4. When nothing is runnable without Jo, end the message with a line `idle: <why>`. brb then lets the turn end; without that line a Stop hook sends you back to work.",
    `5. Start every reply with this line, as its first line: ${replyFirstLine(away, now)}. A Stop hook sends a reply without it back once.`,
    "6. A fire answered does not end the hold. When Jo replies to a fire or answers a question, answer that, then go back to body-only replies ending `idle: <why>` when nothing is runnable. Jo's reply is not `back`; only the prompt `back` on its own ends the hold.",
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

/** The Stop hook's backstop block when a reply did not start with the still-away line. */
export function firstLineReason(line) {
  return `brb: every reply while away starts with the line \`\`${line}\`\`; reply again with that line first.`;
}

/**
 * What the agent is told on `back`, over the numbered list: Jo is back, reply with the list as
 * the whole message. The list reaches Jo as the agent's reply, which every surface renders; a
 * hook frame does not render on the mobile app. Items come one at a time after that (itemInstruction).
 */
export function backInstruction(away, now) {
  const d = awayFor(away.since, now);
  return `brb: Jo is back${d ? ` (away ${d})` : ""}. Reply with the list below verbatim as your whole message, then stop (end with nothing else). Do not show any item in full yet: Jo picks one at a time by typing its number.`;
}

/** backInstruction for a harness that does not route the item words (OMP): the whole digest, as in 0.5.0. */
export function backDigestInstruction(away, now) {
  const d = awayFor(away.since, now);
  return `brb: Jo is back${d ? ` (away ${d})` : ""}. Reply with the digest below verbatim as your whole message, then stop (end with nothing else). If a held item is already resolved, append '— resolved: <how>' to that line.`;
}

/** The most characters one line of the returned digest's numbered list carries; the item in full comes when Jo picks it. */
export const LIST_LINE_MAX = 120;

/** `text` with whitespace collapsed, cut to `max` characters with a trailing `…`. */
export function clipLine(text, max = LIST_LINE_MAX) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** The returned digest as `back` lists it: one line per row, `N. <text, cut>`, ticked rows marked `(done)`. */
export function digestList(checklist) {
  return checklist.items.map((item, i) => `${i + 1}. ${item.done ? "(done) " : ""}${clipLine(item.text)}`).join("\n");
}

/** The footer under `back`'s list: how Jo works it. */
export function listFooter(checklist) {
  const n = checklist.items.length;
  return `Type a number (1${n > 1 ? `-${n}` : ""}) to open that item, \`done N\` when it is dealt with, \`brb clear\` to close the list (anything not done is shown in full first).`;
}

/**
 * A prompt that works the returned digest, or null: a bare number (`3`, `#3`, `3.`) or
 * `brb item 3` opens item 3; `done 3` or `brb done 3` ticks it; `brb clear` closes the list.
 * `prefixed` is true for the `brb …` forms, which the band sends and which never reach the
 * agent as an ordinary prompt. Trailing `.`, `!` allowed; any case.
 */
export function digestWord(text) {
  const t = String(text ?? "").trim();
  let m = /^#?(\d{1,4})[.)!]?$/.exec(t);
  if (m) return { verb: "show", n: Number(m[1]), prefixed: false };
  m = /^brb\s+item\s+#?(\d{1,4})[.!]?$/i.exec(t);
  if (m) return { verb: "show", n: Number(m[1]), prefixed: true };
  m = /^(brb\s+)?done\s+#?(\d{1,4})[.!]?$/i.exec(t);
  if (m) return { verb: "done", n: Number(m[2]), prefixed: Boolean(m[1]) };
  if (/^brb\s+clear[.!]?$/i.test(t)) return { verb: "clear", n: null, prefixed: true };
  return null;
}

/** What a `brb item N`, `brb done N` or `brb clear` says while home with no returned digest open; the prompt still reaches the agent. */
export const NO_OPEN_TEXT = "brb: no returned digest is open; nothing to open, tick or clear. Tell Jo that in one line.";

/** An item number off the open list. */
export function noItemText(n, total) {
  return `brb: the returned digest has no item ${n} (it has ${total}, numbered 1-${total}). Tell Jo that in one line, then stop.`;
}

/** One row in full: its number, the entry it was held under, its whole text, and whether it is ticked. */
export function itemBlock(item, n, total) {
  return [`item ${n} of ${total}${item.heading ? ` (held ${item.heading})` : ""}${item.done ? ", done" : ""}`, "", item.text].join("\n");
}

/** What the agent is told when Jo opens item N: show it in full, work it with Jo, leave the tick to Jo. */
export function itemInstruction(n) {
  return `brb: Jo opened item ${n} of the returned digest. Start your reply with the item below verbatim, then work it with Jo: answer it, or ask what you need to act on it. Show no other item. The item stays open until Jo types \`done ${n}\` or ticks it in the band; do not mark it done yourself.`;
}

/** What the agent is told when Jo ticks item N: acknowledge, and what is left. */
export function tickText({ n, item, already, closed, open }) {
  const what = `item ${n} (${clipLine(item.text, 80)})`;
  if (already) return `brb: ${what} was already done. Say so in one line, then stop.`;
  if (closed) return `brb: Jo ticked ${what} done. That was the last open item: the returned digest is closed. Say so in one line, then stop.`;
  return `brb: Jo ticked ${what} done. Still open: ${open.join(", ")}. Say so in one line, then stop.`;
}

/** What the agent is told on `brb clear`: reply with the block below as the whole message. */
export function clearInstruction(open) {
  return open
    ? `brb: Jo closed the returned digest with ${open} item${open === 1 ? "" : "s"} not done. Reply with the block below verbatim as your whole message, then stop: the items not done are in full so none is lost.`
    : "brb: Jo closed the returned digest; every item was done. Reply with the block below verbatim as your whole message, then stop.";
}

/** The block `brb clear` shows: every row not done in full (itemBlock), then the done rows one line each. */
export function clearBlock(checklist) {
  const total = checklist.items.length;
  const open = [];
  const done = [];
  checklist.items.forEach((item, i) => (item.done ? done : open).push(item.done ? `${i + 1}. ${clipLine(item.text)}` : itemBlock(item, i + 1, total)));
  const parts = [];
  if (open.length) parts.push(`Not done (${open.length}):`, "", open.join("\n\n"));
  if (done.length) parts.push(...(open.length ? [""] : []), `Done (${done.length}):`, done.join("\n"));
  return parts.join("\n");
}

/** What the agent is told on `back` while not away; the word itself still reaches it as the prompt. */
export const NOT_AWAY_TEXT = "brb: you were not away; nothing held";

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
