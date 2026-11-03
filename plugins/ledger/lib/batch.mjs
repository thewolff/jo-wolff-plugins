// batch.mjs — apply lines one at a time, in order, each in its own transaction, and report
// one result per line. Shared by the CLI (stdin mode and the single-line argv mode) and by the
// UserPromptSubmit hook, so a paste behaves the same whichever way it arrives.
//
// A refused line (bad id, non-option word) and a prose line are reported and the NEXT LINE
// STILL RUNS: a batch is never all-or-nothing. Dependent lines work because order is kept.
//
// Output, one line per input line, numbered by input line so results map back to the paste:
//   <n>: ok <id> <summary>        applied (or nothing to do, also `ok`)
//   <n>: refused <reason>         not applied, the reason says what would be accepted
//   <n>: not a command[; closest: <word>]
//   <n>: skipped (blank)
//   <n>: not applied (database busy)   this line and every later one, when a write lock outlasted
//                                      busy_timeout; `batch.busy` carries the StoreError
// then a trailer: `applied <a>, refused <r>, not commands <p>`.
//
// Exit code (the CLI's): 0 when every non-blank line applied; 1 when any was refused or prose;
// 2 when the store could not be opened or went busy (the lines that were not applied are named).

import { parseLine, promptApplicable } from "./parse.mjs";
import { createLookup, execute } from "./commands.mjs";
import { StoreError } from "./db.mjs";

/**
 * @param lines  string[] (or {tokens, text} for argv mode: one entry)
 * @param opts   { db, ctx, onlyPromptApplicable }
 * @returns {{ results: Array<{line, text, status, id, message}>, applied, refused, prose, blank, busy }}
 */
export function runBatch(lines, { db, ctx, onlyPromptApplicable = false }) {
  const lookup = createLookup(db, ctx.cwd);
  const results = [];
  let applied = 0;
  let refusedCount = 0;
  let proseCount = 0;
  let blank = 0;
  let busy = null;
  lines.forEach((entry, i) => {
    const n = i + 1;
    const text = typeof entry === "string" ? entry : entry.text;
    const tokens = typeof entry === "string" ? null : entry.tokens;
    const parsed = parseLine(text, lookup, tokens);
    if (busy && parsed.kind !== "blank") {
      results.push({ line: n, text: parsed.text ?? text, status: "not applied", id: null, message: "not applied (database busy)" });
      return;
    }
    if (parsed.kind === "blank") {
      blank++;
      results.push({ line: n, text, status: "skipped", id: null, message: "blank" });
      return;
    }
    if (parsed.kind === "prose") {
      proseCount++;
      const extra = parsed.closest ? `; closest: ${parsed.closest}` : parsed.hint ? `; ${parsed.hint}` : "";
      results.push({ line: n, text: parsed.text, status: "not a command", id: null, message: `not a command${extra}`, closest: parsed.closest });
      return;
    }
    if (parsed.kind === "refused") {
      refusedCount++;
      results.push({ line: n, text: parsed.text, status: "refused", id: null, message: parsed.reason });
      return;
    }
    if (onlyPromptApplicable && !promptApplicable(parsed)) {
      proseCount++;
      results.push({ line: n, text: parsed.text, status: "not a command", id: null, message: "not applied from a prompt (the agent runs this verb)" });
      return;
    }
    let r;
    try {
      r = execute(db, parsed, ctx);
    } catch (err) {
      if (err instanceof StoreError) {
        busy = err;
        results.push({ line: n, text: parsed.text, status: "not applied", id: null, message: "not applied (database busy)" });
        return;
      }
      r = { status: "refused", id: null, message: `error: ${err.message}` };
    }
    if (r.status === "refused") refusedCount++;
    else applied++;
    results.push({ line: n, text: parsed.text, status: r.status === "refused" ? "refused" : "ok", id: r.id, message: r.message });
  });
  return { results, applied, refused: refusedCount, prose: proseCount, blank, busy };
}

/** The exit code the batch rule gives: 0 all applied, 1 any refused or prose, 2 the store went busy. */
export function exitCodeFor(batch) {
  if (batch.busy) return 2;
  return batch.refused || batch.prose ? 1 : 0;
}

/** Parse every line without executing anything; the prompt hook uses this to refuse a mixed paste. */
export function parseAll(lines, db, cwd) {
  const lookup = createLookup(db, cwd);
  return lines.map((entry) => (typeof entry === "string" ? parseLine(entry, lookup) : parseLine(entry.text, lookup, entry.tokens)));
}

function resultText(r, numbered) {
  switch (r.status) {
    case "ok":
      if (r.id) return `ok ${r.message}`;
      return numbered ? `ok\n${r.message}` : r.message;
    case "refused":
      return `refused ${r.message}`;
    case "not a command":
    case "not applied":
      return r.message;
    default:
      return "skipped (blank)";
  }
}

/** Numbered lines plus the trailer. `numbered: false` for the single-line form. */
export function formatBatch(batch, { numbered = true } = {}) {
  const lines = batch.results.map((r) => (numbered ? `${r.line}: ${resultText(r, true)}` : resultText(r, false)));
  if (numbered) lines.push(`applied ${batch.applied}, refused ${batch.refused}, not commands ${batch.prose}`);
  return lines.join("\n");
}

export function batchJson(batch) {
  return batch.results.map(({ line, text, status, id, message }) => ({ line, text, status, id, message }));
}
