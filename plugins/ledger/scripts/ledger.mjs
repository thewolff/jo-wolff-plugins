#!/usr/bin/env node
// ledger.mjs — the CLI. `node scripts/ledger.mjs <verb> [args]`, or with no verb and stdin piped,
// one command per line (batch mode).
//
//   node ledger.mjs ask "Ship it?" --name ship --options approve,deny   → ok q-… asked …
//   node ledger.mjs approve q-mvr3k2p9a1xq            → ok an-… approve → q-… (name)
//   printf 'approve q-…\nwithdraw q-…\n' | node ledger.mjs
//                                                     → 1: ok …  2: ok …  applied 2, refused 0, not commands 0
//   node ledger.mjs --json …                          → the same results as a JSON array
//   node ledger.mjs --by <name> …                     → record <name> as the actor
//   node ledger.mjs --cwd <dir> …                     → bind to <dir> instead of the working directory
//   node ledger.mjs config                            → every setting and where it came from
//   node ledger.mjs pending --all                     → every open and held question, grouped by folder
//
// Exit codes: 0 every non-blank line applied; 1 any line refused or not a command; 2 the store
// could not be opened (nothing applied, one line says why).
//
// Environment: LEDGER_DB (database path), LEDGER_CONFIG (config file), LEDGER_CWD (folder).

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StoreError } from "../lib/db.mjs";
import { openStore, makeCtx, resolveCwd } from "../lib/store.mjs";
import { runBatch, formatBatch, batchJson, exitCodeFor, busyWord } from "../lib/batch.mjs";
import { renderHelp, setEnabled } from "../lib/commands.mjs";

/** Pull the CLI's own flags out of argv; everything else is the command. */
export function splitCliFlags(argv) {
  const out = { json: false, by: null, cwd: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--by") out.by = argv[++i] ?? null;
    else if (a.startsWith("--by=")) out.by = a.slice(5);
    else if (a === "--cwd") out.cwd = argv[++i] ?? null;
    else if (a.startsWith("--cwd=")) out.cwd = a.slice(6);
    else out.rest.push(a);
  }
  return out;
}

export function main(argv = process.argv.slice(2), { env = process.env, stdin = 0, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), isTTY = process.stdin.isTTY } = {}) {
  const cli = splitCliFlags(argv);
  const cwd = resolveCwd(env, cli.cwd);

  let lines;
  let numbered;
  if (cli.rest.length) {
    lines = [{ tokens: cli.rest, text: cli.rest.join(" ") }];
    numbered = false;
  } else if (!isTTY) {
    const text = readFileSync(stdin, "utf8");
    lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    numbered = true;
    if (!lines.length) {
      out("nothing on stdin\n");
      return 0;
    }
  } else {
    out(renderHelp() + "\n");
    return 0;
  }

  // `enable` and `disable` only write .ledger.json; they must work when the database cannot be
  // opened, since turning the hooks off is the way out of a broken store. Same for `help`.
  if (cli.rest.length && ["enable", "disable", "help"].includes(cli.rest[0].toLowerCase()) && cli.rest.length === 1) {
    if (cli.rest[0].toLowerCase() === "help") {
      out(renderHelp() + "\n");
      return 0;
    }
    const r = setEnabled(cwd, cli.rest[0].toLowerCase() === "enable");
    out(`${r.status === "ok" ? r.message : `refused ${r.message}`}\n`);
    return r.status === "ok" ? 0 : 1;
  }

  let store;
  try {
    store = openStore({ env, cwd });
  } catch (e) {
    if (e instanceof StoreError) {
      if (e.kind === "busy" || e.kind === "readonly") err(`ledger: database ${busyWord(e)} at ${e.path}; nothing applied\n`);
      else if (e.kind === "corrupt") err(`${e.message}; nothing applied, the file was left as it is\n`);
      else err(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
  for (const n of store.notices) err(`${n}\n`);

  try {
    // LEDGER_SESSION_ID is exported by the SessionStart hook into the session's shell environment.
    const sessionId = /^[A-Za-z0-9_.-]+$/.test(env.LEDGER_SESSION_ID ?? "") ? env.LEDGER_SESSION_ID : null;
    const ctx = makeCtx({ store, cwd, via: "cli", by: cli.by, sessionId });
    const batch = runBatch(lines, { db: store.db, ctx });
    // Busy with nothing applied: one stderr line and nothing on stdout (the fail-open table's row).
    // Busy after some lines applied: the block names each line that was not applied, then the stderr line.
    if (!(batch.busy && batch.applied === 0)) out((cli.json ? JSON.stringify(batchJson(batch), null, 2) : formatBatch(batch, { numbered })) + "\n");
    if (batch.busy) {
      const skipped = batch.results.filter((r) => r.status === "not applied").map((r) => r.line);
      err(`ledger: database ${busyWord(batch.busy)} at ${batch.busy.path}; ${batch.applied === 0 ? "nothing applied" : `lines ${skipped.join(", ")} not applied`}\n`);
    }
    return exitCodeFor(batch);
  } finally {
    try {
      store.db.close();
    } catch {
      /* already closed */
    }
  }
}

const invoked = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) process.exit(main());
