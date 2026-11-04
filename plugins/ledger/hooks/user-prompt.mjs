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
// Ledger lines engage only when EVERY non-blank line is a ledger line: a cheap shape check first
// (an id, an ordinal, or pending/log/help), then the real parser; one prose line anywhere
// (`can you approve q-… for me?`) and no line is applied. Free-text verbs (ask "…", note "…")
// are the agent's and are never applied from a prompt. A refused line (a word that is not an
// option, an unknown id) is reported in the results, not swallowed: it parsed as a ledger line
// and was turned down.
//
// Output: hookSpecificOutput.additionalContext = the answers-from-elsewhere lines, then "ledger
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
import { answersSince } from "../lib/commands.mjs";
import { StoreError, transaction } from "../lib/db.mjs";
import { nowIso } from "../lib/time.mjs";

const READ_ONLY = new Set(["pending", "log", "help"]);

/** Whether one line has the shape of a ledger line the prompt hook may apply; null for blank/comment. */
export function looksLikeLedgerLine(line) {
  const body = stripComment(line);
  if (!body) return null;
  const tokens = tokenize(body);
  if (!tokens.length) return null;
  const t0 = tokens[0].toLowerCase();
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
  const watch = Boolean(sessionId) && cfg.config.inject.answers !== false && existsSync(cfg.config.db);
  if (!lines && !watch) return null;
  const out = withStore({ env, now, notices: cfg.notices, cwd, cfg }, lines ? "the ledger lines in this prompt were not applied" : "answers recorded in other sessions were not checked", (store) => {
    const news = watch ? takeAnswers(store, sessionId, cwd, now, env) : [];
    const applied = lines ? applyLines(store, lines, cwd, sessionId, now) : null;
    if (!applied && !news.length) return null;
    const system = applied ? applied.systemMessage : store.notices.join("\n");
    return {
      ...(system ? { systemMessage: system } : {}),
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [news.join("\n"), applied?.context].filter(Boolean).join("\n\n"),
      },
    };
  });
  // An ordinary prompt never shows the person a store failure: the answers wait for the next prompt.
  if (!lines && out && !out.hookSpecificOutput) {
    logError("UserPromptSubmit", out.systemMessage, env);
    return null;
  }
  return out;
}

if (invokedDirectly(import.meta.url)) {
  runHook("UserPromptSubmit", (input) => handle(input));
}
