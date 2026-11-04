#!/usr/bin/env node
// query.mjs — what the pane shows, as one JSON object on stdout. Run by the mod out of process
// (`node mods/pane/query.mjs --session <id> --cwd <dir>`), because the hooks module runs inside
// Claude Code and may not import lib/db.mjs (node:sqlite).
//
//   { ok: true, since, elsewhere: [...], answers: [...] }
//     elsewhere: open and held questions outside `cwd`'s folder tree, grouped by folder in path
//                order (lib/commands.mjs elsewhereQuestions), each with its age;
//     answers:   answers recorded by another session or the CLI, on questions this session asked,
//                since this session's prompt mark (cc_sessions.last_prompt_seen_at, else its
//                started_at): the same cursor the UserPromptSubmit hook uses, so the pane shows
//                exactly what Claude has not been told yet; empty with no session id;
//     since:     that cursor, or null.
//   { ok: true, disabled: true, elsewhere: [], answers: [] }   the ledger is off for this folder
//   { ok: false, error }                                        anything that went wrong
//
// Always exits 0 and always prints JSON; a fault is also one line in the errors log.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openStore, resolveCwd } from "../../lib/store.mjs";
import { answersSince, elsewhereQuestions } from "../../lib/commands.mjs";
import { loadConfig } from "../../lib/config.mjs";
import { nowIso, relative } from "../../lib/time.mjs";
import { logError } from "../../lib/failopen.mjs";

/** `--session <id> --cwd <dir>` → { sessionId, cwd }; a session id outside [A-Za-z0-9_.-] is dropped (the CLI does the same). */
export function parseArgs(argv) {
  const out = { sessionId: null, cwd: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") out.sessionId = argv[++i] ?? null;
    else if (argv[i] === "--cwd") out.cwd = argv[++i] ?? null;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(out.sessionId ?? "")) out.sessionId = null;
  return out;
}

/** The snapshot for `sessionId` in `cwd`, read from an open store. */
export function snapshot(db, { sessionId, cwd, now = Date.now() }) {
  const iso = nowIso(now);
  const elsewhere = [];
  for (const [, questions] of elsewhereQuestions(db, cwd)) {
    for (const q of questions) {
      elsewhere.push({
        id: q.id,
        cwd: q.cwd,
        name: q.name,
        body: q.body,
        options: q.options,
        default: q.default_opt,
        state: q.state,
        asked_at: q.asked_at,
        age: relative(q.asked_at, now),
      });
    }
  }
  let since = null;
  let answers = [];
  if (sessionId) {
    const session = db.prepare("SELECT started_at, last_prompt_seen_at FROM cc_sessions WHERE id = ?").get(sessionId);
    since = session?.last_prompt_seen_at ?? session?.started_at ?? null;
    answers = answersSince(db, { sessionId, since, until: iso }).map((r) => ({ id: r.id, name: r.name, state: r.state, word: r.word, via: r.via }));
  }
  return { ok: true, since, elsewhere, answers };
}

export function main(argv = process.argv.slice(2), { env = process.env, now = Date.now(), out = (s) => process.stdout.write(s) } = {}) {
  let result;
  try {
    const { sessionId, cwd: given } = parseArgs(argv);
    const cwd = resolveCwd(env, given);
    const cfg = loadConfig({ env, cwd });
    if (!cfg.config.enabled) {
      result = { ok: true, disabled: true, since: null, elsewhere: [], answers: [] };
    } else {
      const store = openStore({ env, now, cwd, cfg });
      try {
        result = snapshot(store.db, { sessionId, cwd, now });
      } finally {
        store.db.close();
      }
    }
  } catch (err) {
    logError("pane-query", err?.message ?? String(err), env);
    result = { ok: false, error: err?.message ?? String(err) };
  }
  out(JSON.stringify(result) + "\n");
  return 0;
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) process.exitCode = main();
