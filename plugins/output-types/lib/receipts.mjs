// receipts.mjs — the receipts check behind hooks/output-types-stop.mjs: every labelled statement
// in a finished message, whether each carries a receipt shape, the warning that names the ones
// that do not, and the optional judge pass over the ones that do. Pure except for the two log
// appends and the config read, each a named function, so the hook test can drive every branch.
//
// WHAT COUNTS AS A LABEL
//   `**CLAIM**` or `**CITE**` in markdown bold that starts a line (after any list marker or `>`
//   quote marker: `- **CLAIM**`, `1. **CITE**`, `> **CLAIM**`), or that is followed by a colon or
//   the end of its line wherever it sits (`Result **CLAIM**: …`). A parenthesised qualifier or a
//   trailing colon inside the bold is allowed (`**CLAIM (partial)**`, `**CITE:**`). A bold label
//   in the middle of a sentence ("**CLAIM** and **CITE** are the two labels") is a mention, not a
//   label; so is prose that mentions CLAIM unbolded, and so is anything inside a fenced code
//   block: a fence (at any indentation) is masked before labels are looked for, so a quoted
//   example of the contract never produces a warning about itself.
//
// WHAT THE STATEMENT IS
//   The text after the label up to the next label, a heading, a horizontal rule, an HTML
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
import { isJudgeError, resolveJudgeCommand, runJudge } from "./judge.mjs";

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

/** A label match is a statement's label when it starts its line (after list or quote markers) or is followed by a colon or its line's end. */
function isStatementLabel(masked, m) {
  const lineStart = masked.lastIndexOf("\n", m.index - 1) + 1;
  if (LINE_LEAD.test(masked.slice(lineStart, m.index))) return true;
  if (m[0].endsWith(":**")) return true;
  return /^[ \t]*(?::|\n|$)/.test(masked.slice(m.index + m[0].length));
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
 * `text` is the statement with its receipt, as written (fences included).
 */
export function extractStatements(md) {
  const text = String(md ?? "").replace(/\r\n/g, "\n");
  const masked = maskFences(text);
  const fences = [...text.matchAll(FENCE_RE)].map((f) => [f.index, f.index + f[0].length]);
  const labels = [...masked.matchAll(LABEL_RE)].filter((m) => isStatementLabel(masked, m));
  const out = [];
  for (let i = 0; i < labels.length; i++) {
    const m = labels[i];
    const start = m.index + m[0].length;
    let next = i + 1 < labels.length ? labels[i + 1].index : text.length;
    // An inline next label starts its own statement at its line: what precedes it on that line
    // (a list marker, a lead-in) belongs to neither.
    if (i + 1 < labels.length) {
      const lineStart = text.lastIndexOf("\n", next - 1) + 1;
      if (lineStart > start && masked.slice(lineStart, next).trim()) next = lineStart;
    }
    const end = blockEnd(masked, start, next, fences);
    const body = text.slice(start, end).replace(/^[ \t]*[:—–-]?[ \t]*/, "").trim();
    if (!body) continue;
    out.push({ label: m[1], line: lineOf(text, m.index), text: body });
  }
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

/** Append `<iso> hooks/output-types-stop.mjs <text>` to skipped.log; never throws. Returns the path, or null. */
export function logSkipped(text, env = process.env, now = new Date()) {
  try {
    mkdirSync(stateDir(env), { recursive: true });
    const path = skippedLogPath(env);
    appendFileSync(path, `${now.toISOString()} ${HOOK_FILE} ${String(text).replace(/\s+/g, " ").trim()}\n`);
    return path;
  } catch {
    return null;
  }
}

// ─── the judge stage ────────────────────────────────────────────────────────────────────

/** The judge command for this plugin, as lib/judge.mjs resolves it, or null. */
export function judgeFor(env = process.env) {
  const config = readConfig(env);
  return resolveJudgeCommand({
    pluginKey: {
      envVar: JUDGE_ENV_VAR,
      command: typeof config.judgeCommand === "string" ? config.judgeCommand : null,
      timeoutMs: config.judgeTimeoutMs,
      source: `judgeCommand in ${configPath(env)}`,
    },
    env,
  });
}

export function judgePrompt(s) {
  return (
    "You are checking one labelled statement from an agent's report against this contract: a label " +
    "(CLAIM for a fact checked in the session, CITE for a fact from an outside source) is earned only " +
    "by the receipt attached to the statement, and a receipt licenses only what it literally shows.\n\n" +
    `Label: ${s.label}\nStatement, with its receipt, verbatim:\n<<<\n${s.text}\n>>>\n\n` +
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
export async function judgeStage(statements, judge, { env = process.env, startedAt = Date.now(), budgetMs, marginMs = 2_000, run = runJudge } = {}) {
  const findings = [];
  for (const s of statements) {
    const remaining = budgetMs - (Date.now() - startedAt) - marginMs;
    if (remaining <= 0) {
      logSkipped(`${nameOf(s)} judge skipped: no time left in the hook's budget (source=${judge.source})`, env);
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
      logSkipped(`${nameOf(s)} judge ${answer.error}: ${answer.detail}${tail ? ` stderr=${JSON.stringify(tail)}` : ""} (source=${judge.source})`, env);
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
