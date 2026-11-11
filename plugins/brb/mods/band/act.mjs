#!/usr/bin/env node
// act.mjs — what the band's buttons do, run by the mod out of process
// (`node mods/band/act.mjs --session <id> <verb> [index]`), because the hooks module may import
// no node builtin and the writes belong to lib/state.mjs (temp file + rename, one convention).
//
//   back          whether the session is away, and since when: `{ ok: true, away: true, since }`
//                 or `{ ok: true, away: false }`. Writes nothing; the mod then sends `back` as the
//                 user's prompt (`$.prompt.submit`), and
//                 hooks/user-prompt-submit.mjs ends the hold as it does for `back` typed.
//   done <index>  toggle row <index> (0-based) of checklist.json and write it back; once every row
//                 is done the file is removed (the band clears). Cosmetic: the agent is told nothing.
//   clear         remove checklist.json.
//
// Prints one JSON object: `{ ok: true, ... }` or `{ ok: false, error }`. Always exits 0.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clearChecklist, readAway, toggleChecklistItem } from "../../lib/state.mjs";

/** `--session <id> <verb> [index]` → { sessionId, verb, index }; a missing or blank id is null, a non-integer index null. */
export function parseArgs(argv) {
  const out = { sessionId: null, verb: null, index: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") out.sessionId = argv[++i] ?? null;
    else if (argv[i].startsWith("--session=")) out.sessionId = argv[i].slice("--session=".length);
    else rest.push(argv[i]);
  }
  if (typeof out.sessionId !== "string" || !out.sessionId.trim()) out.sessionId = null;
  out.verb = rest[0] ?? null;
  if (rest[1] !== undefined && /^\d+$/.test(rest[1])) out.index = Number(rest[1]);
  return out;
}

/** Run one verb for `sessionId`; the JSON the script prints. Throws on a write that fails. */
export function act(sessionId, verb, index, { env = process.env } = {}) {
  if (verb === "back") {
    const away = readAway(sessionId, env);
    return away ? { ok: true, away: true, since: away.since } : { ok: true, away: false };
  }
  if (verb === "done") {
    if (index === null) return { ok: false, error: "done needs a row index" };
    const checklist = toggleChecklistItem(sessionId, index, env);
    return { ok: true, checklist };
  }
  if (verb === "clear") {
    clearChecklist(sessionId, env);
    return { ok: true, checklist: null };
  }
  return { ok: false, error: `unknown verb ${JSON.stringify(verb)}; one of back, done <index>, clear` };
}

export function main(argv = process.argv.slice(2), { env = process.env, out = (s) => process.stdout.write(s) } = {}) {
  let result;
  try {
    const { sessionId, verb, index } = parseArgs(argv);
    result = sessionId ? act(sessionId, verb, index, { env }) : { ok: false, error: "act needs --session <id>" };
  } catch (err) {
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
