// receipts.mjs — the receipts check behind hooks/output-types-stop.mjs: every labelled statement
// in a finished message, whether each carries a receipt shape, the warning that names the ones
// that do not, and the optional judge pass over the ones that do. Pure except for the two log
// appends and the config read, each a named function, so the hook test can drive every branch.
//
// WHAT COUNTS AS A LABEL
//   `**CLAIM**` or `**CITE**` in markdown bold. A block label starts a line (after any list marker
//   or `>` quote marker: `- **CLAIM**`, `1. **CITE**`, `> **CLAIM**`), or is followed by a colon or
//   the end of its line wherever it sits (`Result **CLAIM**: …`). A parenthesised qualifier or a
//   trailing colon inside the bold is allowed (`**CLAIM (partial)**`, `**CITE:**`). A bold label
//   inside a sentence is an inline label ("The hook never blocks (**CLAIM**), …"), unless it is
//   only mentioned: joined to another label by and/or/a comma/a slash ("**CLAIM** and **CITE**
//   are the two labels"), quoted or in code, or followed by a word about it (label, labels,
//   means, is, are, and, or, needs, requires). Prose that mentions CLAIM unbolded is not a label,
//   and neither is anything inside a fenced code block: a fence (at any indentation) is masked
//   before labels are looked for, so a quoted example of the contract never warns about itself.
//
// WHAT THE STATEMENT IS
//   For an inline label: its enclosing sentence (from the previous `.`/`!`/`?` or the line's
//   start to the next one or the line's end) plus the following line, unless that line is blank
//   or holds a label of its own. For a block label: the text after the label up to the next
//   block label, a heading, a horizontal rule, an HTML
//   comment, a line that is only bold text (a section label), or a blank line, whichever comes
//   first, except that a blank line followed by a fence does not end it (a fenced command and
//   its output under the sentence is the receipt and belongs to the statement), and nothing
//   inside a fence ends it, blank lines in a command's output included. An unlabeled line
//   that follows the sentence with no break is part of it too, which only ever hides a missing
//   receipt, never invents one.
//
// WHAT COUNTS AS A RECEIPT SHAPE (the mechanical stage, deterministic)
//   CLAIM: an absolute `/`-rooted `file:line` or `file:line-line` (a relative or `~/` path is
//   not one); or a command and what it gave, written as one of
//     - a fenced block holding the command and its output (two or more non-empty lines), or a
//       fenced command plus a result phrase (`→`, exit, returned, printed, output, pass, …);
//     - a command with `→ output` or `-> output` after it on the same line or opening the next
//       line, where the command is a bare `$ cmd` at the line start, or inline code that opens
//       with `$ ` or has a space inside (`npm run lint` → exit 0).
//   Inline code next to a result word is not a receipt, and neither is a symbol in code before
//   an arrow: "`resolveJudgeCommand` returns null" and "`handle()` -> null" name a symbol, they
//   do not show a command being run.
//   CITE: an `http(s)://` URL, or the words test/tested/ran/run with a command in code.
//   The shape is checked, not the content: a path that does not exist still passes here; that is
//   the judge stage's question, and the person's.
//
// THE JUDGE STAGE, OFF BY DEFAULT
//   When `${XDG_CONFIG_HOME:-~/.config}/output-types/config.json` has `"judge": true` and
//   lib/judge.mjs resolves a command (env OUTPUT_TYPES_JUDGE_BIN → `judgeCommand` in that same
//   file → the shared judge file → i-have-audhd's profile), each statement that passed the
//   mechanical stage is put to the judge once: does the receipt license what the sentence says.
//   `fail` and any answer that is neither pass nor fail join the same warning, with the judge's
//   reason when it gave one; a dispatch error
//   (timeout, non-zero, unparseable, could not start) is one line in skipped.log, naming the
//   source that supplied the command, and the check goes on. Every call's timeout is clamped to
//   what is left of the hook's deadline, so a slow judge never makes the hook late.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "./core.mjs";
import { isJudgeError, lookedIn, readSharedConfig, resolveJudgeCommand, runJudge } from "./judge.mjs";
import { DEFAULT_IGNORE_TOOLS } from "./transcript.mjs";

export const HOOK_FILE = "hooks/output-types-stop.mjs";
export const JUDGE_ENV_VAR = "OUTPUT_TYPES_JUDGE_BIN";
/** How many unreceipted lines the warning names before "+N more". */
export const WARNING_CAP = 5;
/** How long a statement is quoted in the warning. */
const QUOTE_CHARS = 80;

// ─── labels and statements ──────────────────────────────────────────────────────────────

const LABEL_RE = /\*\*(CLAIM|CITE)(?:[ \t]*\([^)\n]*\))?:?\*\*/g;
/** What may precede a label at the start of its line: indentation, list markers, quote markers. */
const LINE_LEAD = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*$/;
/** A heading, an HTML comment, a horizontal rule, a line that is only bold text, or a blank line not followed by a fence (the receipt's usual place). */
const BLOCK_END = /\n#{1,6} |\n[ \t]*<!--|\n-{3,}[ \t]*(?=\n|$)|\n[ \t]*\*\*[^*\n]+\*\*:?[ \t]*(?=\n|$)|\n[ \t]*\n(?![ \t]*(?:`{3,}|~{3,}))/g;
/** A fenced block, opening fence at a line start (indentation allowed), to its closing fence or the end of the text (no `m` flag: `$` is the end of the text). */
const FENCE_RE = /(?:^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[ \t]*(?=\n|$)|$)/g;

const FENCE_LINE = /^[ \t]*(?:`{3,}|~{3,})/;

/**
 * `text` with the inside of every fenced block replaced by `x` of the same length (newlines and
 * the fence lines themselves kept), so offsets and line numbers hold, no label inside a fence is
 * seen, and a fence opener is still there for the block-end rule to look at. An empty line inside
 * a fence stays empty (it has nothing to replace without moving offsets); extractStatements skips
 * a block end that falls inside a fence instead.
 */
export function maskFences(text) {
  return text.replace(FENCE_RE, (block) =>
    block
      .split("\n")
      .map((l) => (FENCE_LINE.test(l) ? l : l.replace(/./g, "x")))
      .join("\n"),
  );
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** A label match leads a block statement when it starts its line (after list or quote markers) or is followed by a colon or its line's end. */
function isBlockLabel(masked, m) {
  const lineStart = masked.lastIndexOf("\n", m.index - 1) + 1;
  if (LINE_LEAD.test(masked.slice(lineStart, m.index))) return true;
  if (m[0].endsWith(":**")) return true;
  return /^[ \t]*(?::|\n|$)/.test(masked.slice(m.index + m[0].length));
}

/** The text between two labels that joins them into a list: `and`, `or`, a comma, a slash. */
const JOINER = /^[ \t]*(?:,[ \t]*(?:and|or)?|and|or|\/)[ \t]*$/i;
/** A word right after a label that makes the label the subject of the sentence, not its tag. */
const MENTION_AFTER = /^[ \t]*(?:labels?|labelled|means|is|are|and|or|needs?|requires)\b/i;
const QUOTE_BEFORE = /[`"'“‘]$/;
const QUOTE_AFTER = /^[`"'”’]/;

/**
 * A label inside a sentence is a mention, not a statement's tag, when it is joined to a neighbouring
 * label by and/or/comma/slash ("**CLAIM** and **CITE**"), quoted or in code, or followed by a word
 * that talks about it (label, means, is, needs, …). `all` is every label match, in order.
 */
function isMention(masked, all, i) {
  const m = all[i];
  const end = m.index + m[0].length;
  const prev = all[i - 1];
  const next = all[i + 1];
  if (prev && JOINER.test(masked.slice(prev.index + prev[0].length, m.index))) return true;
  if (next && JOINER.test(masked.slice(end, next.index))) return true;
  if (QUOTE_BEFORE.test(masked.slice(0, m.index)) || QUOTE_AFTER.test(masked.slice(end))) return true;
  return MENTION_AFTER.test(masked.slice(end));
}

const LINE_MARKERS = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*/;
const HAS_LABEL = new RegExp(LABEL_RE.source);

/**
 * An inline label's statement: its enclosing sentence (from the previous `.`/`!`/`?` or the line's
 * start to the next one or the line's end), plus the following line when it is not blank and holds
 * no label of its own, so a receipt written under the sentence still counts.
 */
function inlineStatement(text, masked, m) {
  const lineStart = masked.lastIndexOf("\n", m.index - 1) + 1;
  const nl = masked.indexOf("\n", m.index);
  const lineEnd = nl < 0 ? masked.length : nl;
  let start = lineStart;
  for (const e of masked.slice(lineStart, m.index).matchAll(/[.!?](?=\s)/g)) start = lineStart + e.index + 1;
  const after = m.index + m[0].length;
  const stop = masked.slice(after, lineEnd).search(/[.!?](?=\s|$)/);
  const end = stop < 0 ? lineEnd : after + stop + 1;
  let body = text.slice(start, end).replace(LINE_MARKERS, "").trim();
  if (lineEnd < masked.length) {
    const nextNl = masked.indexOf("\n", lineEnd + 1);
    const nextEnd = nextNl < 0 ? masked.length : nextNl;
    const following = masked.slice(lineEnd + 1, nextEnd);
    if (following.trim() && !HAS_LABEL.test(following)) body += "\n" + text.slice(lineEnd + 1, nextEnd);
  }
  return body;
}

/** The first block end in masked[start, next) that is not inside a fence span, as an index; `next` when none. */
function blockEnd(masked, start, next, fences) {
  const segment = masked.slice(start, next);
  BLOCK_END.lastIndex = 0;
  let m;
  while ((m = BLOCK_END.exec(segment))) {
    const at = start + m.index;
    const fence = fences.find(([a, b]) => at >= a && at < b);
    if (!fence) return at;
    BLOCK_END.lastIndex = Math.max(m.index + 1, fence[1] - start);
  }
  return next;
}

/**
 * Every labelled statement in `md`, in order: { label: "CLAIM"|"CITE", line, text }.
 * `text` is the statement with its receipt, as written (fences included). A block label's text
 * follows it; an inline label's text is its enclosing sentence and the line after it.
 */
export function extractStatements(md) {
  const text = String(md ?? "").replace(/\r\n/g, "\n");
  const masked = maskFences(text);
  const fences = [...text.matchAll(FENCE_RE)].map((f) => [f.index, f.index + f[0].length]);
  const all = [...masked.matchAll(LABEL_RE)];
  const kinds = all.map((m, i) => (isBlockLabel(masked, m) ? "block" : isMention(masked, all, i) ? null : "inline"));
  const blocks = all.filter((_, i) => kinds[i] === "block");
  const out = [];
  all.forEach((m, i) => {
    if (!kinds[i]) return;
    let body;
    if (kinds[i] === "inline") body = inlineStatement(text, masked, m);
    else {
      const start = m.index + m[0].length;
      const following = blocks[blocks.indexOf(m) + 1];
      let next = following ? following.index : text.length;
      // A next label after a lead-in starts its own statement at its line: what precedes it on
      // that line (a list marker, a lead-in) belongs to neither.
      if (following) {
        const lineStart = text.lastIndexOf("\n", next - 1) + 1;
        if (lineStart > start && masked.slice(lineStart, next).trim()) next = lineStart;
      }
      const end = blockEnd(masked, start, next, fences);
      body = text.slice(start, end).replace(/^[ \t]*[:—–-]?[ \t]*/, "").trim();
    }
    if (body) out.push({ label: m[1], line: lineOf(text, m.index), text: body });
  });
  return out;
}

// ─── the mechanical stage ───────────────────────────────────────────────────────────────

const ABS_FILE_LINE = /(?<![\w.~])\/(?:[\w.@+~\-]+\/)*[\w.@+~\-]+:\d+(?:[-–]\d+)?(?!\d)/;
const CODE = /`[^`\n]+`|^[ \t]*(?:`{3,}|~{3,})/m;
const RESULT = /→|->|\bexit(?:ed|s)?\b|\bstatus\b|\breturn(?:ed|s)?\b|\bprint(?:ed|s)?\b|\boutput\b|\bresult(?:ed|s)?\b|\bpass(?:ed|es|ing)?\b|\bfail(?:ed|s|ing|ures?)?\b|\bgreen\b|\bok\b|\bshow(?:ed|s)?\b|\breport(?:ed|s)?\b|\bprinted\b/i;
/** A bare `$ cmd` after the line's indentation and list or quote markers. */
const DOLLAR_LEAD = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*\$ \S/;
/** Inline code spans, paired left to right. */
const CODE_SPAN = /`([^`\n]+)`/g;
/** A line that opens with `→ output` or `-> output` (after indentation and list or quote markers). */
const ARROW_LINE = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*`?(?:→|->)/;
const ARROW = /→|->/;
const URL = /\bhttps?:\/\/\S+/;
const TESTED = /\b(?:test(?:ed|s)?|ran|run)\b/i;

/** The fenced blocks in `text`: { lines } with the non-empty lines between the fences. */
function fencesIn(text) {
  return [...text.matchAll(FENCE_RE)].map((m) => ({ lines: m[0].replace(/^\n/, "").split("\n").slice(1, -1).filter((l) => l.trim()) }));
}

/**
 * Where the command on `line` ends, or -1 when there is none. A command is a bare `$ cmd` at the
 * line's start, or an inline code span that opens with `$ ` or has a space inside (`npm run lint`);
 * a span without one (`handle()`, `resolveJudgeCommand`) names a symbol, not a command run.
 */
function commandEnd(line) {
  const bare = DOLLAR_LEAD.exec(line);
  if (bare) return bare[0].length;
  for (const m of line.matchAll(CODE_SPAN)) {
    if (/^\$ \S/.test(m[1]) || /\S[ \t]+\S/.test(m[1])) return m.index + m[0].length;
  }
  return -1;
}

/** True when a line holds a command with `→`/`->` output after it on the same line or opening the next one. */
function commandPair(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const end = commandEnd(lines[i]);
    if (end === -1) continue;
    if (ARROW.test(lines[i].slice(end))) return true;
    if (i + 1 < lines.length && ARROW_LINE.test(lines[i + 1])) return true;
  }
  return false;
}

export const NEEDS = Object.freeze({
  CLAIM: "needs an absolute file:line, or the command and its result",
  CITE: "needs the URL fetched, or the test run with its command",
});

/** null when the statement carries a receipt shape for its label; otherwise what it needs. */
export function missingReceipt({ label, text }) {
  if (label === "CLAIM") {
    if (ABS_FILE_LINE.test(text)) return null;
    const fences = fencesIn(text);
    if (fences.some((f) => f.lines.length >= 2)) return null;
    if (fences.length && RESULT.test(text)) return null;
    if (commandPair(text)) return null;
    return NEEDS.CLAIM;
  }
  if (URL.test(text)) return null;
  if (TESTED.test(text) && CODE.test(text)) return null;
  return NEEDS.CITE;
}

/** `line N **LABEL** "first words…"`: how a statement is named in the warning. */
export function nameOf(s) {
  const flat = s.text.replace(/\s+/g, " ").trim();
  const quote = flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS - 1)}…` : flat;
  return `line ${s.line} **${s.label}** "${quote}"`;
}

/**
 * The one systemMessage, or null when there is nothing to say. `findings` is
 * [{ statement, why }] in message order; the first WARNING_CAP are named, the rest counted.
 */
export function renderWarning(findings, cap = WARNING_CAP) {
  if (!findings.length) return null;
  const shown = findings.slice(0, cap).map((f) => `  ${nameOf(f.statement)}: ${f.why}`);
  if (findings.length > cap) shown.push(`  +${findings.length - cap} more`);
  const n = findings.length;
  return `output-types: ${n} labelled statement${n === 1 ? "" : "s"} without a receipt that holds. Add the receipt or remove the label (unlabeled means unreceipted).\n${shown.join("\n")}`;
}

// ─── config and logs ────────────────────────────────────────────────────────────────────

/** `${XDG_CONFIG_HOME:-~/.config}/output-types/config.json`. */
export function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), ".config");
  return join(base, "output-types", "config.json");
}

/** The config object, or {} when the file is absent, unreadable, not JSON, or not an object. */
export function readConfig(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(configPath(env), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** True only when the config says `"judge": true` (the boolean, not a string). */
export function judgeEnabled(env = process.env) {
  return readConfig(env).judge === true;
}

export function skippedLogPath(env = process.env) {
  return join(stateDir(env), "skipped.log");
}

/** Append `<iso> <hook> <text>` to skipped.log (hook defaults to HOOK_FILE); never throws. Returns the path, or null. */
export function logSkipped(text, env = process.env, now = new Date(), hook = HOOK_FILE) {
  try {
    mkdirSync(stateDir(env), { recursive: true });
    const path = skippedLogPath(env);
    appendFileSync(path, `${now.toISOString()} ${hook || HOOK_FILE} ${String(text).replace(/\s+/g, " ").trim()}\n`);
    return path;
  } catch {
    return null;
  }
}

// ─── the judge stage ────────────────────────────────────────────────────────────────────

function pluginKey(env) {
  const config = readConfig(env);
  return {
    envVar: JUDGE_ENV_VAR,
    command: typeof config.judgeCommand === "string" ? config.judgeCommand : null,
    timeoutMs: config.judgeTimeoutMs,
    source: `judgeCommand in ${configPath(env)}`,
  };
}

/** The judge command for this plugin, as lib/judge.mjs resolves it, or null. */
export function judgeFor(env = process.env) {
  return resolveJudgeCommand({ pluginKey: pluginKey(env), env });
}

/** Why judgeFor gave null, as one skipped.log line: the malformed shared file, or where it looked. */
export function noJudgeReason(env = process.env) {
  const { malformed } = readSharedConfig({ env });
  if (malformed) return `judge not run: the shared judge file is malformed (${malformed}), so the legacy profile was not consulted`;
  return `judge not run: judge is on but no command is configured; looked in: ${lookedIn({ pluginKey: pluginKey(env), env }).join(", ")}`;
}

/**
 * The sentence that introduces a session record in the judge prompt. jev-judge's shape.ts holds the
 * same string as OT_RECORD_INTRO, and its test fails when the two differ.
 */
export const RECORD_INTRO =
  "Session record for this receipt (the tool calls the statement names, as the session transcript " +
  "holds them, output bounded; it is what the command printed or the page returned, not the agent's account of it):";

/**
 * The judge prompt for one statement. `s.record`, when it is a non-empty string, is added as a
 * block between the statement and the question: `<<<RECORD\n<record>\nRECORD <length>>>>`, the
 * length (record.length) in the closer so a parser reads the block from the end without trusting
 * any marker inside it. With no record the prompt is byte-identical to 0.3.2.
 */
export function judgePrompt(s) {
  const record = typeof s.record === "string" && s.record ? s.record : "";
  return (
    "You are checking one labelled statement from an agent's report against this contract: a label " +
    "(CLAIM for a fact checked in the session, CITE for a fact from an outside source) is earned only " +
    "by the receipt attached to the statement, and a receipt licenses only what it literally shows.\n\n" +
    `Label: ${s.label}\nStatement, with its receipt, verbatim:\n<<<\n${s.text}\n>>>\n\n` +
    (record ? `${RECORD_INTRO}\n<<<RECORD\n${record}\nRECORD ${record.length}>>>\n\n` : "") +
    "Does the receipt license what the sentence says? Every factual part of the statement must be " +
    "something the receipt itself would show: a file:line that would contain it, a command whose shown " +
    "output states it, a URL or a test that says it. A part that reaches past the receipt (an inference, " +
    "a consequence, a comparison, a category jump from what was read to what it means) is a fail.\n\n" +
    'Reply with one JSON object and nothing else: {"verdict": "pass" | "fail", "reason": "<one sentence>"}'
  );
}

/**
 * One judge call per statement, in order, each clamped to what is left of `budgetMs` counted from
 * `startedAt`. Returns the findings ([{ statement, why }]) for fail and unverified answers; a
 * dispatch error is one skipped.log line and no finding. Never throws.
 */
export async function judgeStage(statements, judge, { env = process.env, startedAt = Date.now(), budgetMs, marginMs = 2_000, run = runJudge, hook = HOOK_FILE } = {}) {
  const skip = (text) => logSkipped(text, env, new Date(), hook);
  const findings = [];
  for (const s of statements) {
    const remaining = budgetMs - (Date.now() - startedAt) - marginMs;
    if (remaining <= 0) {
      skip(`${nameOf(s)} judge skipped: no time left in the hook's budget (source=${judge.source})`);
      continue;
    }
    const timeoutMs = Math.min(judge.timeoutMs, remaining);
    let answer;
    try {
      answer = await run(judgePrompt(s), { command: judge.command, timeoutMs, mode: "json", env });
    } catch (err) {
      answer = { error: "spawn-failed", detail: err?.message ?? String(err) };
    }
    if (isJudgeError(answer)) {
      const tail = String(answer.stderr ?? "").replace(/\s+/g, " ").trim().slice(-300);
      skip(`${nameOf(s)} judge ${answer.error}: ${answer.detail}${tail ? ` stderr=${JSON.stringify(tail)}` : ""} (source=${judge.source})`);
      continue;
    }
    const verdict = answer && typeof answer.verdict === "string" ? answer.verdict.toLowerCase() : "";
    const reason = answer && typeof answer.reason === "string" ? answer.reason.replace(/\s+/g, " ").trim() : "";
    if (verdict === "pass") continue;
    if (verdict === "fail") findings.push({ statement: s, why: `the judge says the receipt does not license it${reason ? `: ${reason}` : ""}` });
    else findings.push({ statement: s, why: `the judge's answer was neither pass nor fail (unverified)${reason ? `: ${reason}` : ""}` });
  }
  return findings;
}

// ─── the zero-label rule ────────────────────────────────────────────────────────────────
//
// A long report from a turn that did real tool work, with no labelled statement at all, is flagged
// in one line to the person. Thresholds and the ignore list live flat in the same config file as
// the judge keys: zeroLabelMinChars (Stop only), zeroLabelMinToolCalls, zeroLabelIgnoreTools.

export const ZERO_LABEL_ENV = "OUTPUT_TYPES_ZERO_LABEL";
export const ZERO_LABEL_DEFAULTS = Object.freeze({ minChars: 600, minToolCalls: 3 });

const positiveInt = (v, fallback) => (Number.isInteger(v) && v > 0 ? v : fallback);

/**
 * { off, minChars, minToolCalls, ignore }: off when ZERO_LABEL_ENV is "off" in any case; a threshold
 * that is not a positive integer falls back to its default; ignore is zeroLabelIgnoreTools when it is
 * an array of strings, else DEFAULT_IGNORE_TOOLS.
 */
export function zeroLabelConfig(env = process.env) {
  const config = readConfig(env);
  const ignore = Array.isArray(config.zeroLabelIgnoreTools) && config.zeroLabelIgnoreTools.every((t) => typeof t === "string") ? [...config.zeroLabelIgnoreTools] : [...DEFAULT_IGNORE_TOOLS];
  return {
    off: String(env[ZERO_LABEL_ENV] || "").toLowerCase() === "off",
    minChars: positiveInt(config.zeroLabelMinChars, ZERO_LABEL_DEFAULTS.minChars),
    minToolCalls: positiveInt(config.zeroLabelMinToolCalls, ZERO_LABEL_DEFAULTS.minToolCalls),
    ignore,
  };
}

/**
 * The one-line warning. `who` is null on Stop, or { agentType } on SubagentStop. `boundaryFound`
 * false means the count is a lower bound ("at least").
 */
export function renderZeroLabel({ count, boundaryFound = true, who = null }) {
  const n = `${boundaryFound ? "" : "at least "}${count} tool call${count === 1 ? "" : "s"}`;
  if (who) return `output-types: the ${who.agentType} subagent ran ${n}, 0 labelled statements in its report. Treat its findings as unverified until checked.`;
  return `output-types: ${n} this turn, 0 labelled statements. Label what you checked, or say nothing was checked.`;
}

// ─── the session record for the judge ──────────────────────────────────────────────────
//
// A command or URL receipt is only checkable against what the tool returned. The hook finds the
// Bash or WebFetch call a statement names in the transcript and hands the judge that call's result
// as a session record, rendered in the receipts audit's own case-receipt format (its evidence.ts
// HEADER), so the judge reads it the way it was tuned to. Only completed calls are rendered.

/** The header the audit's parser splits on; a body line that would read as one gets a leading space. */
const RECORD_HEADER_LIKE = /^\[(?:\/|shell command — |fetched \S+ — )/;
const SHELL_HEAD_LINES = 40;
const SHELL_TAIL_LINES = 20;
const SHELL_LINE_CHARS = 1200;
const SHELL_MAX_CHARS = 4000;
const SHELL_MAX_COMMAND = 2000;
const FETCH_MAX_CHARS = 6000;
export const RECORD_MAX_CHARS = 24_000;
/** How many tool calls one statement's record holds. */
export const RECORD_MAX_CALLS = 4;

/**
 * The commands a statement names, as candidates to match against Bash calls: inline code spans that
 * open with "$ " or have whitespace inside, bare "$ cmd" lines, and "$ " lines inside fences (else a
 * fence's first non-empty line). "$ " is stripped, anything from the first " → " or " -> " on is cut,
 * whitespace is trimmed. Candidates with no whitespace are dropped. Deduplicated, in order.
 */
export function commandsNamed(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const raw = [];
  const outside = src.replace(FENCE_RE, (block) => {
    const lines = block.replace(/^\n/, "").split("\n").slice(1);
    if (lines.length && /^[ \t]*(?:`{3,}|~{3,})[ \t]*$/.test(lines.at(-1))) lines.pop();
    const dollar = lines.filter((l) => /^[ \t]*\$ \S/.test(l));
    if (dollar.length) raw.push(...dollar);
    else {
      const first = lines.find((l) => l.trim());
      if (first) raw.push(first);
    }
    return "\n";
  });
  for (const line of outside.split("\n")) {
    if (DOLLAR_LEAD.test(line)) raw.push(line.replace(/^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*/, ""));
    for (const m of line.matchAll(CODE_SPAN)) if (/^\$ \S/.test(m[1]) || /\S[ \t]+\S/.test(m[1])) raw.push(m[1]);
  }
  const out = [];
  for (const r of raw) {
    const c = r
      .trim()
      .replace(/^\$ /, "")
      .split(/ (?:→|->) /)[0]
      .trim();
    if (/\s/.test(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

/** The http(s) URLs in a statement, trailing punctuation, quotes, brackets and backticks stripped. Deduplicated. */
export function urlsNamed(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/\bhttps?:\/\/[^\s<>"'`]+/g)) {
    const u = m[0].replace(/[.,;:!?)\]}>'"`*_]+$/, "");
    if (u.length > "https://".length && !out.includes(u)) out.push(u);
  }
  return out;
}

/** The receipts audit's commandIn (mechanical.ts): every fragment of `cmd`, split at "…" or "...", is in `haystack`, whitespace folded. */
export function commandIn(cmd, haystack) {
  const c = String(haystack ?? "").replace(/\s+/g, " ");
  const frags = String(cmd ?? "")
    .split(/\s*(?:…|\.\.\.)\s*/)
    .map((f) => f.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return frags.length > 0 && frags.every((f) => c.includes(f));
}

/**
 * A URL's identity for matching: scheme and host lowercased, a #fragment dropped, and nothing else
 * touched (path and query case, http versus https, a www. prefix and a trailing slash all count).
 */
export function urlKey(url) {
  const u = String(url ?? "").trim().replace(/#.*$/, "");
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(u);
  return m ? m[1].toLowerCase() + m[2].toLowerCase() + m[3] : u;
}

/**
 * The tool calls a statement's receipt names: for each command, the newest Bash call whose
 * input.command contains it (commandIn); for each URL, the newest WebFetch call whose requested or
 * final URL has the same urlKey. Deduplicated by id, at most `max`.
 *   wanted: how many candidates the statement had (0: nothing to look up).
 *   matched: the completed calls, in transcript order.
 *   pending: the tool name of each candidate whose newest matching call has no captured result; an
 *            older completed run is never put in its place.
 */
export function receiptCalls(statement, calls, { max = RECORD_MAX_CALLS } = {}) {
  const text = statement?.text ?? "";
  const cmds = commandsNamed(text);
  const urls = urlsNamed(text);
  const list = Array.isArray(calls) ? calls : [];
  const found = [];
  const pending = [];
  const take = (call) => {
    if (!call) return;
    if (!call.result) pending.push(call.name);
    else if (!found.includes(call)) found.push(call);
  };
  for (const cmd of cmds) take(list.findLast((c) => c.name === "Bash" && commandIn(cmd, c.input?.command)));
  for (const url of urls) {
    const key = urlKey(url);
    take(list.findLast((c) => c.name === "WebFetch" && (urlKey(c.input?.url) === key || (c.result?.finalUrl && urlKey(c.result.finalUrl) === key))));
  }
  const matched = found.sort((a, b) => a.at - b.at).slice(0, max);
  return { wanted: cmds.length + urls.length, matched, pending };
}

/** success, error or interrupted, or null when the call has no result (never rendered). */
export function callStatus(call) {
  const r = call?.result;
  if (!r) return null;
  if (r.interrupted) return "interrupted";
  // A WebFetch of a 4xx or 5xx page is not an is_error result; its HTTP status says it failed.
  if (Number.isInteger(r.httpStatus) && r.httpStatus >= 400) return "error";
  return r.isError ? "error" : "success";
}

const normalizeNewlines = (s) => String(s ?? "").replace(/\r\n?/g, "\n");
const escapeHeaders = (body) =>
  body
    .split("\n")
    .map((l) => (RECORD_HEADER_LIKE.test(l) ? ` ${l}` : l))
    .join("\n");

/** Head and tail of a shell run's output, each line capped, the middle marked as omitted (the audit's boundedOutput). */
function boundedOutput(out) {
  const lines = out.split("\n").map((l) => l.slice(0, SHELL_LINE_CHARS));
  const omitted = lines.length - SHELL_HEAD_LINES - SHELL_TAIL_LINES;
  const kept = omitted > 0 ? [...lines.slice(0, SHELL_HEAD_LINES), `… ${omitted} lines omitted …`, ...lines.slice(-SHELL_TAIL_LINES)] : lines;
  const joined = kept.join("\n");
  if (joined.length <= SHELL_MAX_CHARS) return joined;
  const head = Math.floor(SHELL_MAX_CHARS * 0.6);
  const tail = SHELL_MAX_CHARS - head;
  return `${joined.slice(0, head)}\n… ${joined.length - head - tail} chars omitted …\n${joined.slice(-tail)}`;
}

function shellBlock(call, status) {
  const folded = String(call.input?.command ?? "").replace(/\s+/g, " ").trim();
  const command = folded.length > SHELL_MAX_COMMAND ? `${folded.slice(0, SHELL_MAX_COMMAND)}…` : folded;
  const code = typeof call.result.exitCode === "number" ? String(call.result.exitCode) : "unknown";
  const out = boundedOutput(normalizeNewlines(call.result.text).trim());
  return `[shell command — ${status}]\n${escapeHeaders(`$ ${command}\nstatus: ${status}\nexit code: ${code}${out ? `\n${out}` : ""}`)}`;
}

function fetchBlock(call, status) {
  const requested = String(call.input?.url ?? "").replace(/\s+/g, "");
  const final = call.result.finalUrl ? String(call.result.finalUrl).replace(/\s+/g, "") : requested;
  const text = normalizeNewlines(call.result.text).trim().slice(0, FETCH_MAX_CHARS);
  return `[fetched ${requested || final} — the tool's result as the agent saw it, bounded by output-types]\n${escapeHeaders(`requested: ${requested}\nfinal: ${final}\nstatus: ${status}${text ? `\n${text}` : ""}`)}`;
}

/**
 * The session record for one statement: each matched call as one case-receipt block, joined by a
 * blank line; whole trailing blocks are dropped past RECORD_MAX_CHARS, and a last line says how many.
 * A call without a result, or of another tool, is not rendered. "" when nothing is rendered.
 */
export function renderRecord(matched) {
  const blocks = [];
  for (const call of matched ?? []) {
    const status = callStatus(call);
    if (!status) continue;
    if (call.name === "Bash") blocks.push(shellBlock(call, status));
    else if (call.name === "WebFetch") blocks.push(fetchBlock(call, status));
  }
  const kept = [];
  let used = 0;
  for (const b of blocks) {
    const add = (kept.length ? 2 : 0) + b.length;
    if (used + add > RECORD_MAX_CHARS - 80) break;
    kept.push(b);
    used += add;
  }
  const dropped = blocks.length - kept.length;
  if (dropped) kept.push(`[omitted: ${dropped} more tool call${dropped === 1 ? "" : "s"} past the record's ${RECORD_MAX_CHARS} characters]`);
  return kept.join("\n\n");
}

/** True when a statement carries an absolute file:line, which the judge can read from disk without a record. */
export function hasFileLine(statement) {
  return ABS_FILE_LINE.test(statement?.text ?? "");
}
