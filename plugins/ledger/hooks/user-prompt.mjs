#!/usr/bin/env node
// user-prompt.mjs — UserPromptSubmit: tell the session about answers to its questions that were
// recorded elsewhere since its last prompt, and apply ledger lines the person typed straight into
// the prompt (`approve q-…`, `withdraw q-…`, `1 approve`, `pending`) and hand Claude the per-line
// results. The prompt still reaches Claude. This hook NEVER blocks a prompt: it has no
// `decision` field and no exit 2 path.
//
// Input read: prompt, session_id, cwd (hooks reference § UserPromptSubmit input). Lines
// between `<pasted_content …>` and `</pasted_content …>` markers are kept; the marker lines
// themselves are dropped, as the reference says to account for them.
//
// Answers from elsewhere (`inject.answers`): with a session id and an existing database (a prompt
// never creates one), every prompt reads the questions this session asked (cc_questions.session_id)
// that another session or an untagged CLI run answered or withdrew after the session's mark
// (cc_sessions.last_prompt_seen_at, else its started_at), gives Claude one line each, and moves
// the mark to now. A mark that cannot be written is logged and the lines are given anyway.
//
// Bare options: with a session id and an existing database, a prompt that is one option word of
// an open or held question alone ("local", "Local.") gives Claude one line per such question
// (this session's first, then this folder's, then the rest) naming the `answer` command to run
// if the human meant it as their reply. Nothing is recorded: the line is a hint, Claude decides.
//
// Ledger lines engage only when EVERY non-blank line is a ledger line: a cheap shape check first
// (an id, an ordinal, or pending/log/help), then the real parser; one prose line anywhere
// (`can you approve q-… for me?`) and no line is applied. Free-text verbs (ask "…", note "…")
// are the agent's and are never applied from a prompt. A refused line (a word that is not an
// option, an unknown id) is reported in the results, not swallowed: it parsed as a ledger line
// and was turned down.
//
// Owed work: with a session id and an existing database, the session's owed items that no open
// question waits on (lib/owed.mjs blockingSet) are listed for Claude, at most ten, on every prompt
// while any exist, on a prompt that is not ledger lines. A prose prompt with nothing owed stays
// silent. A read failure is logged.
//
// Output: hookSpecificOutput.additionalContext = the answers-from-elsewhere lines, the bare-option
// hints and the owed list, then "ledger
// applied the lines in this prompt:" + the batch result block (Claude reads both); the batch
// block also as systemMessage (the person sees it). Fail open: switch off → nothing; store
// busy/unavailable → nothing applied, one systemMessage when the prompt had ledger lines, only a
// line in errors.log when it did not; anything thrown → runHook's systemMessage.

import { existsSync } from "node:fs";
import { runHook, invokedDirectly, logError } from "../lib/failopen.mjs";
import { isId, isCutShort } from "../lib/ids.mjs";
import { stripComment, tokenize } from "../lib/parse.mjs";
import { withStore, makeCtx, hookConfig } from "../lib/store.mjs";
import { runBatch, formatBatch, parseAll, busyWord } from "../lib/batch.mjs";
import { answersSince, bareOptionMatches, pendingLines } from "../lib/commands.mjs";
import { StoreError, transaction } from "../lib/db.mjs";
import { nowIso } from "../lib/time.mjs";
import { blockingSet, owedListLines } from "../lib/owed.mjs";
import { invocation } from "../lib/inject.mjs";

const READ_ONLY = new Set(["pending", "log", "help"]);

/** `dismiss` or `waive` when the tokens start `review dismiss` or `review waive`; null otherwise. */
function humanVerbOf(tokens) {
  if (tokens.length < 2 || tokens[0].toLowerCase() !== "review") return null;
  const v = tokens[1].toLowerCase();
  return v === "dismiss" || v === "waive" ? v : null;
}

/** The review verbs (dismiss, waive) of the prompt's lines that start with one, in order. */
export function humanVerbLines(prompt) {
  const verbs = [];
  for (const l of String(prompt ?? "").split(/\r?\n/)) {
    const body = stripComment(l);
    const v = body ? humanVerbOf(tokenize(body)) : null;
    if (v) verbs.push(v);
  }
  return verbs;
}

/** The line that says a typed review dismiss or waive was not applied because the prompt held prose. */
export function strayHumanVerbText(verbs) {
  return [...new Set(verbs)].map((v) => `ledger: the review ${v} line was not applied: a prompt applies ledger lines only when every line is one; type it on its own`).join("\n");
}

/** Whether one line has the shape of a ledger line the prompt hook may apply; null for blank/comment. */
export function looksLikeLedgerLine(line) {
  const body = stripComment(line);
  if (!body) return null;
  const tokens = tokenize(body);
  if (!tokens.length) return null;
  const t0 = tokens[0].toLowerCase();
  // The human's review verbs carry a reason of any length and no ledger id (0.4.12).
  if (humanVerbOf(tokens)) return true;
  if (READ_ONLY.has(t0)) return tokens.length === 1 || (t0 === "log" && tokens.length === 2 && /^\d+$/.test(tokens[1]));
  if (/^\d+$/.test(t0) && tokens.length === 2) return true;
  if (tokens.length > 12) return false;
  return tokens.some((t) => isId(t) || isCutShort(t));
}

/** The prompt's lines with pasted-content markers removed; null unless every non-blank line qualifies. */
export function ledgerLines(prompt) {
  const lines = String(prompt ?? "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*<\/?pasted_content\b[^>]*>\s*$/.test(l));
  let any = false;
  for (const l of lines) {
    const v = looksLikeLedgerLine(l);
    if (v === null) continue;
    if (!v) return null;
    any = true;
  }
  return any ? lines : null;
}

/** One line per answer recorded elsewhere: `<name> → <word> (via <via>)`, or `<name> withdrawn (via <via>)`. */
export function answerLines(rows) {
  return rows.map((r) => `ledger: answered since your last turn: ${r.name} ${r.state === "withdrawn" ? "withdrawn" : `→ ${r.word}`} (via ${r.via})`);
}

/** The answers recorded elsewhere since the session's mark, then the mark moved to now. */
function takeAnswers(store, sessionId, cwd, now, env) {
  const db = store.db;
  const iso = nowIso(now);
  const session = db.prepare("SELECT started_at, last_prompt_seen_at FROM cc_sessions WHERE id = ?").get(sessionId);
  const rows = answersSince(db, { sessionId, since: session?.last_prompt_seen_at ?? session?.started_at ?? null, until: iso });
  try {
    transaction(
      db,
      () => {
        db.prepare("INSERT INTO cc_sessions (id, cwd, started_at, last_prompt_seen_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_prompt_seen_at = excluded.last_prompt_seen_at").run(sessionId, cwd, iso, iso);
      },
      store.dbPath,
    );
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
    logError("UserPromptSubmit", `answers mark not moved: ${err.message}`, env);
  }
  return answerLines(rows);
}

/** One hint line per open question that offers the prompt as an option; [] otherwise. */
function bareOptionLines(store, prompt, cwd, sessionId, now, cfg) {
  const matches = bareOptionMatches(store.db, prompt, { cwd, sessionId });
  if (!matches.length) return [];
  const tz = cfg.config.timezone ?? null;
  return matches.map(({ q, word }) => {
    const where = q.cwd === cwd ? "" : ` (asked in ${q.cwd})`;
    return `ledger: the prompt "${String(prompt).trim()}" is option ${word} of an open question${where}: ${pendingLines(q, { now, timezone: tz }).join(" ")}. If the human meant it as their reply, run \`ledger answer ${q.id} ${word}\` and tell them it is recorded; do not show the id. Nothing is recorded yet. Recording it also records the approved work as owed; add \`--nothing\` if it sets nothing in motion.`;
  });
}

/** The session's owed work no question waits on, for Claude; [] when none, or when reading it fails (logged). */
function owedLines(store, sessionId, cwd, now, env) {
  try {
    const items = blockingSet(store.db, { sessionId, cwd });
    if (!items.length) return [];
    const cli = invocation();
    return [
      `ledger: approved work still owed (not started). A new topic does not cancel it; the turn is sent back once if it ends with any of these still owed. Start each (\`${cli} start <ow-id> "<agent id, session or command>"\`), or \`${cli} hold <ow-id> "<why, until when>"\`, or \`${cli} drop <ow-id> "<why>"\`. Tell the human in plain words; never show the id.`,
      ...owedListLines(items, { now, cap: 10, cli }),
    ];
  } catch (err) {
    logError("UserPromptSubmit", `owed list not read: ${err.message}`, env);
    return [];
  }
}

/** Apply the prompt's ledger lines; null when one of them is prose. */
function applyLines(store, lines, cwd, sessionId, now) {
  if (parseAll(lines, store.db, cwd).some((p) => p.kind === "prose")) return null;
  const ctx = makeCtx({ store, cwd, via: "prompt-hook", sessionId, now });
  const batch = runBatch(lines, { db: store.db, ctx, onlyPromptApplicable: true });
  const block = formatBatch(batch, { numbered: true });
  const busy = batch.busy ? `ledger: database ${busyWord(batch.busy)} at ${batch.busy.path}; the lines marked not applied were not applied\n` : "";
  const notices = `${store.notices.length ? `${store.notices.join("\n")}\n` : ""}${busy}`;
  return {
    systemMessage: `${notices}ledger applied the lines in this prompt:\n${block}`,
    context: `ledger applied the lines in this prompt (each line on its own; refused lines were not recorded):\n${block}`,
  };
}

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const ready = hookConfig(env, input, "userPromptCommands");
  if (!ready) return null;
  const { cfg, cwd } = ready;
  const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
  const lines = ledgerLines(input.prompt);
  const watch = Boolean(sessionId) && existsSync(cfg.config.db);
  const answers = watch && cfg.config.inject.answers !== false;
  // A typed review dismiss or waive inside a prompt with prose applies nothing; say so (0.4.12).
  const stray = humanVerbLines(input.prompt);
  const strayOnly = () => {
    const text = strayHumanVerbText(stray);
    return { systemMessage: text, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } };
  };
  if (!lines && !watch) return stray.length ? strayOnly() : null;
  const out = withStore({ env, now, notices: cfg.notices, cwd, cfg, hook: "UserPromptSubmit" }, lines ? "the ledger lines in this prompt were not applied" : "answers recorded in other sessions were not checked", (store) => {
    const news = answers ? takeAnswers(store, sessionId, cwd, now, env) : [];
    const hints = watch && !lines ? bareOptionLines(store, input.prompt, cwd, sessionId, now, cfg) : [];
    const applied = lines ? applyLines(store, lines, cwd, sessionId, now) : null;
    // A prompt of ledger lines gets the batch block instead: each answer line already names what it left owed.
    const owed = watch && !lines ? owedLines(store, sessionId, cwd, now, env) : [];
    const strayText = !applied && stray.length ? strayHumanVerbText(stray) : "";
    if (!applied && !news.length && !hints.length && !owed.length && !strayText) return null;
    const system = applied ? applied.systemMessage : [store.notices.join("\n"), strayText].filter(Boolean).join("\n");
    return {
      ...(system ? { systemMessage: system } : {}),
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [strayText, news.join("\n"), hints.join("\n"), owed.join("\n"), applied?.context].filter(Boolean).join("\n\n"),
      },
    };
  });
  // An ordinary prompt never shows the person a store failure: the answers wait for the next prompt.
  if (!lines && out && !out.hookSpecificOutput) {
    logError("UserPromptSubmit", out.systemMessage, env);
    return stray.length ? strayOnly() : null;
  }
  if (!lines && !out && stray.length) return strayOnly();
  return out;
}

if (invokedDirectly(import.meta.url)) {
  runHook("UserPromptSubmit", (input) => handle(input));
}
