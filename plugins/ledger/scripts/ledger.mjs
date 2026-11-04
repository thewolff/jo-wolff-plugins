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
//   node ledger.mjs doctor                            → ok/warn/fail per check; never writes
//   node ledger.mjs bounces --since 1d                → the hooks' bounces, per rule and the last 20
//
// Exit codes: 0 every non-blank line applied; 1 any line refused or not a command; 2 the store
// could not be opened (nothing applied, one line says why). `doctor`: 0 no check failed, 1 any
// check failed (warns do not change it).
//
// Environment: LEDGER_DB (database path), LEDGER_CONFIG (config file), LEDGER_CWD (folder).

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StoreError } from "../lib/db.mjs";
import { openStore, makeCtx, resolveCwd } from "../lib/store.mjs";
import { runBatch, formatBatch, batchJson, exitCodeFor, busyWord } from "../lib/batch.mjs";
import { renderHelp, setEnabled } from "../lib/commands.mjs";
import { renderDoctor, runDoctor } from "../lib/doctor.mjs";
import { parseLine } from "../lib/parse.mjs";
import { addressed, runReview, status as reviewStatus, waive } from "../lib/review.mjs";
import { invocation } from "../lib/inject.mjs";

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

  // `doctor` reads only: it must not create or migrate the store it is checking.
  if (cli.rest.length === 1 && cli.rest[0].toLowerCase() === "doctor") {
    const report = runDoctor({ env, cwd });
    out(renderDoctor(report) + "\n");
    return report.fails ? 1 : 0;
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

  // LEDGER_SESSION_ID is exported by the SessionStart hook into the session's shell environment.
  const sessionId = /^[A-Za-z0-9_.-]+$/.test(env.LEDGER_SESSION_ID ?? "") ? env.LEDGER_SESSION_ID : null;

  // `review` runs alone (it waits on other labs' CLIs, so it is async and never part of a batch).
  if (cli.rest.length && cli.rest[0].toLowerCase() === "review") return runReviewVerb({ store, cwd, env, sessionId, tokens: cli.rest, out });

  try {
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

async function runReviewVerb({ store, cwd, env, sessionId, tokens, out }) {
  try {
    const parsed = parseLine(tokens.join(" "), undefined, tokens);
    if (parsed.kind !== "command") {
      out(`${parsed.kind === "refused" ? `refused ${parsed.reason}` : parsed.hint}\n`);
      return 1;
    }
    const common = { db: store.db, dbPath: store.dbPath, cwd, sessionId };
    let r;
    if (parsed.action === "status") r = reviewStatus({ db: store.db, cwd, config: store.config, cli: invocation() });
    else if (parsed.action === "addressed") r = await addressed({ ...common, reason: parsed.reason, config: store.config, env });
    else if (parsed.action === "waive") r = waive({ ...common, reason: parsed.reason });
    else if ((store.config.review?.mode ?? "gate") === "off") r = { code: 0, text: "review.mode is off in the user config; nothing reviewed" };
    else r = await runReview({ ...common, env, config: store.config, labs: parsed.labs, base: parsed.base, forceRound: parsed.forceRound, cli: invocation() });
    out(`${r.text}\n`);
    return r.code;
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
if (invoked) process.exit(await main());
