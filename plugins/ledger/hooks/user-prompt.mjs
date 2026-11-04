#!/usr/bin/env node
// user-prompt.mjs — UserPromptSubmit: apply ledger lines the person typed straight into the
// prompt (`approve q-…`, `withdraw q-…`, `1 approve`, `pending`) and hand Claude the per-line
// results. The prompt still reaches Claude. This hook NEVER blocks a prompt: it has no
// `decision` field and no exit 2 path.
//
// Input read: prompt, session_id, cwd (hooks reference § UserPromptSubmit input). Lines
// between `<pasted_content …>` and `</pasted_content …>` markers are kept; the marker lines
// themselves are dropped, as the reference says to account for them.
//
// The hook engages only when EVERY non-blank line is a ledger line: a cheap shape check first
// (an id, an ordinal, or pending/log/help, so ordinary prompts never open the store), then the
// real parser; one prose line anywhere (`can you approve q-… for me?`) and the hook writes
// nothing and says nothing. Free-text verbs (ask "…", note "…") are the agent's and
// are never applied from a prompt. A refused line (a word that is not an option, an unknown id)
// is reported in the results, not swallowed: it parsed as a ledger line and was turned down.
//
// Output: hookSpecificOutput.additionalContext = "ledger applied the lines in this prompt:" +
// the batch result block (Claude reads it), plus the same block as systemMessage (the person
// sees it). Fail open: switch off → nothing; store busy/unavailable → nothing applied, one
// systemMessage; anything thrown → runHook's systemMessage.

import { runHook, invokedDirectly } from "../lib/failopen.mjs";
import { isId, isCutShort } from "../lib/ids.mjs";
import { stripComment, tokenize } from "../lib/parse.mjs";
import { withStore, makeCtx, hookConfig } from "../lib/store.mjs";
import { runBatch, formatBatch, parseAll, busyWord } from "../lib/batch.mjs";

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

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const ready = hookConfig(env, input, "userPromptCommands");
  if (!ready) return null;
  const { cfg, cwd } = ready;
  const lines = ledgerLines(input.prompt);
  if (!lines) return null;
  return withStore({ env, now, notices: cfg.notices, cwd, cfg }, "the ledger lines in this prompt were not applied", (store) => {
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
    if (parseAll(lines, store.db, cwd).some((p) => p.kind === "prose")) return null;
    const ctx = makeCtx({ store, cwd, via: "prompt-hook", sessionId, now });
    const batch = runBatch(lines, { db: store.db, ctx, onlyPromptApplicable: true });
    const block = formatBatch(batch, { numbered: true });
    const busy = batch.busy ? `ledger: database ${busyWord(batch.busy)} at ${batch.busy.path}; the lines marked not applied were not applied\n` : "";
    const notices = `${store.notices.length ? `${store.notices.join("\n")}\n` : ""}${busy}`;
    return {
      systemMessage: `${notices}ledger applied the lines in this prompt:\n${block}`,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `ledger applied the lines in this prompt (each line on its own; refused lines were not recorded):\n${block}`,
      },
    };
  });
}

if (invokedDirectly(import.meta.url)) {
  runHook("UserPromptSubmit", (input) => handle(input));
}
