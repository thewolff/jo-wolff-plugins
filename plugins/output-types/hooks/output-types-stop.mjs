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
// ${XDG_STATE_HOME:-~/.local/state}/output-types/skipped.log and the check goes on. Judge on but
// no command resolved (none configured, or the shared judge file malformed) is one skipped.log
// line naming which.
//
// How it fails: stdin not JSON, a thrown error, or no answer at the deadline → the runner logs it
// to ${XDG_STATE_HOME:-~/.local/state}/output-types/errors.log and allows. The deadline is the
// runner's 4 s on the mechanical path; with the judge on it is JUDGE_DEADLINE_MS (55 s, inside the
// 60 s hooks.json timeout), and every judge call is clamped to what is left of it, counted from
// the runner's own start (HOOK_RUNNER_STARTED_AT_MS, set before stdin is read), so a stdin that
// arrives late eats the judge's budget, not the warning's, and a judge that hangs is killed by its
// own timer before the runner's fires. Should the runner's fire first anyway, it kills the judge's
// process group as it exits (lib/judge.mjs registers it). A transcript that is missing,
// unreadable, or has no assistant text is "nothing to check" and returns null.
//
// handle() runs on a worker thread: it returns a plain object or null, never writes stdout or
// exits, and passes env to the judge's spawn explicitly.

import { DEADLINE_MS, invokedDirectly, runHook } from "../lib/hook-runner.mjs";
import {
  HOOK_FILE,
  commandsNamed,
  extractStatements,
  hasFileLine,
  judgeEnabled,
  judgeFor,
  judgeStage,
  logSkipped,
  missingReceipt,
  nameOf,
  noJudgeReason,
  receiptCalls,
  renderRecord,
  renderWarning,
  renderZeroLabel,
  urlsNamed,
  zeroLabelConfig,
} from "../lib/receipts.mjs";
import { handbackMessage, lastAssistantText, readSession, toolCallsOf, turnToolCalls } from "../lib/transcript.mjs";

export const JUDGE_DEADLINE_MS = 55_000;

/**
 * The finished assistant text: the payload's last_assistant_message, else the transcript's last
 * assistant text entry; "" when neither. The transcript is read through lib/transcript.mjs, so only
 * its last TAIL_BYTES are touched.
 */
export function extractText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload.last_assistant_message;
  if (typeof direct === "string" && direct.trim()) return direct;
  const session = readSession(typeof payload.transcript_path === "string" ? payload.transcript_path : "", { skipSidechain: false });
  return session ? lastAssistantText(session.entries) : "";
}

const isOff = (env) => String(env.OUTPUT_TYPES_CHECK || "").toLowerCase() === "off";

/** The runner's start (HOOK_RUNNER_STARTED_AT_MS) when it is a time not in the future, else now. */
function runnerStart(env) {
  const now = Date.now();
  const t = Number(env.HOOK_RUNNER_STARTED_AT_MS);
  return Number.isFinite(t) && t > 0 && t <= now ? t : now;
}

export const SUBAGENT_HOOK_FILE = "hooks/output-types-subagent-stop.mjs";

/**
 * Where this event's report and evidence live.
 *   Stop:         { event: "Stop", transcript: input.transcript_path, skipSidechain: true, who: null }
 *   SubagentStop: { event: "SubagentStop", transcript: input.agent_transcript_path, skipSidechain: false,
 *                   who: { agentType: String(input.agent_type ?? "") } }
 * `hook` is the file skipped.log lines name.
 */
export function sourceFor(input) {
  const str = (v) => (typeof v === "string" ? v : "");
  if (input?.hook_event_name === "SubagentStop") {
    return { event: "SubagentStop", transcript: str(input.agent_transcript_path), skipSidechain: false, who: { agentType: String(input.agent_type ?? "") }, hook: SUBAGENT_HOOK_FILE };
  }
  return { event: "Stop", transcript: str(input?.transcript_path), skipSidechain: true, who: null, hook: HOOK_FILE };
}

/**
 * The report to check on SubagentStop: the delivered SubagentHandback message when the agent
 * transcript has one after the turn start (last_assistant_message is then only the closing text);
 * else input.last_assistant_message; else the last assistant text in the agent transcript; "" when none.
 */
export function extractReport(input, session) {
  const handback = session ? handbackMessage(session) : "";
  if (handback) return handback;
  const direct = input?.last_assistant_message;
  if (typeof direct === "string" && direct.trim()) return direct;
  return session ? lastAssistantText(session.entries) : "";
}

const resolve = (session) => (typeof session === "function" ? session() : session);

/**
 * The zero-label rule: { systemMessage } or null. Null unless the rule is not off; on Stop,
 * text.trim().length >= minChars (SubagentStop has no character floor: a subagent's report stands in
 * for its work); a transcript was readable; and the current turn's tool-call count, with the ignore
 * list applied, is >= minToolCalls. On SubagentStop it is also null when agent_type is "" (Claude
 * Code's internal agents). `session` is a session or a function that reads one, called only when
 * the cheaper checks pass.
 */
export function zeroLabel(text, session, { env = process.env, who = null } = {}) {
  const config = zeroLabelConfig(env);
  if (config.off) return null;
  if (who && !who.agentType) return null;
  if (!who && String(text ?? "").trim().length < config.minChars) return null;
  const s = resolve(session);
  if (!s) return null;
  const { count, boundaryFound } = turnToolCalls(s, { ignore: config.ignore });
  if (count < config.minToolCalls) return null;
  return { systemMessage: renderZeroLabel({ count, boundaryFound, who }) };
}

/**
 * The receipted statements to put to the judge, each with its session record: a statement that names
 * a command or URL gets the matching completed Bash or WebFetch calls from the transcript window
 * (the whole window: a receipt may come from earlier in the session). Not judged, one skipped.log
 * line each and nothing for the person: the newest matching call has no captured result; or the
 * statement names a command, nothing matched (or no transcript was readable), and it has no
 * absolute file:line either. A statement that names only URLs and matched nothing is judged on its
 * text, as in 0.3.2 (the 0.3.2 judge tests pin that).
 */
export function withRecords(receipted, session, { env = process.env, hook = HOOK_FILE } = {}) {
  const out = [];
  let calls;
  const skip = (s, why) => logSkipped(`${nameOf(s)} judge not run: ${why}`, env, new Date(), hook);
  for (const s of receipted) {
    const namesCommand = commandsNamed(s.text).length > 0;
    if (!namesCommand && !urlsNamed(s.text).length) {
      out.push(s);
      continue;
    }
    const unmatched = (why) => (hasFileLine(s) || !namesCommand ? out.push(s) : skip(s, why));
    if (calls === undefined) {
      const ses = resolve(session);
      calls = ses ? toolCallsOf(ses.entries) : null;
    }
    if (!calls) {
      unmatched("no transcript was readable to match its command against");
      continue;
    }
    const { matched, pending } = receiptCalls(s, calls);
    if (pending.length) {
      skip(s, `evidence unavailable: newest matching ${pending[0]} call has no captured result`);
      continue;
    }
    const record = renderRecord(matched);
    if (record) out.push({ ...s, record });
    else unmatched("no Bash or WebFetch call in the last 16 MiB of the transcript matches its command or URL (it may have run in a subagent or an earlier session)");
  }
  return out;
}

/**
 * @param {object} input  the Stop or SubagentStop payload
 * @returns {Promise<object|null>}  { systemMessage } naming the unreceipted statements, or the zero-label line, or null
 */
export async function handle(input, { env = process.env, startedAt = runnerStart(env), budgetMs = null, run } = {}) {
  if (isOff(env)) return null;
  const src = sourceFor(input);
  // One bounded read, on demand: a short labelled reply that carries its own text costs nothing.
  let raw;
  const readRaw = () => (raw === undefined ? (raw = src.transcript ? readSession(src.transcript, { skipSidechain: false }) : null) : raw);
  const session = () => {
    const r = readRaw();
    return r && src.skipSidechain ? { entries: r.entries.filter((e) => e.isSidechain !== true), whole: r.whole } : r;
  };
  let text;
  if (src.event === "SubagentStop") text = extractReport(input, session());
  else {
    const direct = input?.last_assistant_message;
    text = typeof direct === "string" && direct.trim() ? direct : readRaw() ? lastAssistantText(readRaw().entries) : "";
  }
  if (!text) return null;
  const statements = extractStatements(text);
  if (!statements.length) return zeroLabel(text, session, { env, who: src.who });
  const findings = [];
  const receipted = [];
  for (const s of statements) {
    const why = missingReceipt(s);
    if (why) findings.push({ statement: s, why });
    else receipted.push(s);
  }
  if (receipted.length && judgeEnabled(env)) {
    const judge = judgeFor(env);
    // Under the runner the budget is the runner's own deadline (HOOK_RUNNER_DEADLINE_MS);
    // OUTPUT_TYPES_STOP_DEADLINE_MS is for tests: the runner's deadline and the judge budget follow it together.
    const budget = budgetMs ?? (Number(env.HOOK_RUNNER_DEADLINE_MS) || Number(env.OUTPUT_TYPES_STOP_DEADLINE_MS) || JUDGE_DEADLINE_MS);
    if (judge) {
      const toJudge = withRecords(receipted, session, { env, hook: src.hook });
      findings.push(...(await judgeStage(toJudge, judge, { env, startedAt, budgetMs: budget, run, hook: src.hook })));
    } else logSkipped(noJudgeReason(env), env, new Date(), src.hook);
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
