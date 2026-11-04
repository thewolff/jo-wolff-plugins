#!/usr/bin/env node
// hooks/output-types-stop.mjs — the output-types plugin's Stop hook: the receipts check. Runs
// under lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage,
// never a deny or a block.
//
// What it does: reads the finished assistant message (OMP puts it in the payload as
// last_assistant_message; Claude Code requires reading the transcript), finds every `**CLAIM**`
// and `**CITE**` statement, and warns, in one systemMessage, about each one that carries no
// receipt shape (lib/receipts.mjs says what counts): the first 5 named by line, the rest
// counted. It never blocks: `decision: "block"` on Stop re-prompts the model and contends with
// other Stop hooks, and the contract this enforces is the reader's to weigh, so the warning is
// for the person. Nothing labelled, no transcript, or OUTPUT_TYPES_CHECK=off → no output at all.
//
// The judge stage runs only when `${XDG_CONFIG_HOME:-~/.config}/output-types/config.json` has
// `"judge": true` and a judge command resolves (lib/judge.mjs: OUTPUT_TYPES_JUDGE_BIN →
// judgeCommand in that file → ~/.config/judge/config.json → i-have-audhd's profile): one call per
// statement that passed the mechanical stage, asking whether the receipt licenses the sentence.
// A fail or an unreadable verdict joins the same warning; a dispatch error is one line in
// ${XDG_STATE_HOME:-~/.local/state}/output-types/skipped.log and the check goes on.
//
// How it fails: stdin not JSON, a thrown error, or no answer at the deadline → the runner logs it
// to ${XDG_STATE_HOME:-~/.local/state}/output-types/errors.log and allows. The deadline is the
// runner's 4 s on the mechanical path; with the judge on it is JUDGE_DEADLINE_MS (55 s, inside the
// 60 s hooks.json timeout), and every judge call is clamped to what is left of it, so a judge
// that hangs is killed by its own timer before the runner's fires. A transcript that is missing,
// unreadable, or has no assistant text is "nothing to check" and returns null.
//
// handle() runs on a worker thread: it returns a plain object or null, never writes stdout or
// exits, and passes env to the judge's spawn explicitly.

import { readFileSync } from "node:fs";
import { DEADLINE_MS, invokedDirectly, runHook } from "../lib/hook-runner.mjs";
import { extractStatements, judgeEnabled, judgeFor, judgeStage, missingReceipt, renderWarning } from "../lib/receipts.mjs";

export const JUDGE_DEADLINE_MS = 55_000;

/** The finished assistant text: the payload's last_assistant_message, else the transcript's last assistant text entry; "" when neither. */
export function extractText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload.last_assistant_message;
  if (typeof direct === "string" && direct.trim()) return direct;
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (!transcriptPath) return "";
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  } catch {
    return "";
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn line in a JSONL transcript is not this hook's failure
    }
    if (!entry || typeof entry !== "object" || entry.type !== "assistant") continue;
    const content = entry.message?.content ?? entry.content;
    if (typeof content === "string" && content.trim()) return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text.trim()) return text;
    // An assistant entry with only tool calls is not the message; keep scanning backwards.
  }
  return "";
}

const isOff = (env) => String(env.OUTPUT_TYPES_CHECK || "").toLowerCase() === "off";

/**
 * @param {object} input  the Stop payload
 * @returns {Promise<object|null>}  { systemMessage } naming the unreceipted statements, or null
 */
export async function handle(input, { env = process.env, startedAt = Date.now(), budgetMs = null, run } = {}) {
  if (isOff(env)) return null;
  const text = extractText(input);
  if (!text) return null;
  const statements = extractStatements(text);
  if (!statements.length) return null;
  const findings = [];
  const receipted = [];
  for (const s of statements) {
    const why = missingReceipt(s);
    if (why) findings.push({ statement: s, why });
    else receipted.push(s);
  }
  if (receipted.length && judgeEnabled(env)) {
    const judge = judgeFor(env);
    // OUTPUT_TYPES_STOP_DEADLINE_MS is for tests: the runner's deadline and the judge budget follow it together.
    const budget = budgetMs ?? (Number(env.OUTPUT_TYPES_STOP_DEADLINE_MS) || JUDGE_DEADLINE_MS);
    if (judge) findings.push(...(await judgeStage(receipted, judge, { env, startedAt, budgetMs: budget, run })));
  }
  findings.sort((a, b) => a.statement.line - b.statement.line);
  const message = renderWarning(findings);
  return message ? { systemMessage: message } : null;
}

if (invokedDirectly(import.meta.url)) {
  // The deadline is chosen before stdin is read: a config read is cheap, and the runner's timer
  // must be running before anything that can hang.
  const deadlineMs = Number(process.env.OUTPUT_TYPES_STOP_DEADLINE_MS) || (judgeEnabled(process.env) ? JUDGE_DEADLINE_MS : DEADLINE_MS);
  runHook("Stop", import.meta.url, { plugin: "output-types", quiet: false, deadlineMs });
}
