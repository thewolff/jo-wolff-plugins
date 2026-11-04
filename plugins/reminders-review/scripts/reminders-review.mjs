#!/usr/bin/env node
// scripts/reminders-review.mjs — the plugin's CLI. One verb:
//
//   prune [--days N] [--dry-run]   rotate errors.log and remove session stamps and rotated logs
//                                  older than N days (default 30) under
//                                  ${XDG_STATE_HOME:-~/.local/state}/reminders-review
//
// Prints one JSON line `{ dir, rotated, removed, bytes, kept, problems }`. Exit 0, 1 when a file
// could not be removed or rotated, 2 on a usage error.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stateDir } from "../lib/due.mjs";
import { DEFAULT_RETENTION_DAYS, prune } from "../lib/retention.mjs";

const USAGE = "usage: node scripts/reminders-review.mjs prune [--days N] [--dry-run]";

export function main(argv, { env = process.env, write = (s) => process.stdout.write(s), writeErr = (s) => process.stderr.write(s) } = {}) {
  const [verb, ...rest] = argv;
  if (verb !== "prune") {
    writeErr(`${USAGE}\n`);
    return 2;
  }
  let days = DEFAULT_RETENTION_DAYS;
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--dry-run") dryRun = true;
    else if (rest[i] === "--days" && /^\d+$/.test(rest[i + 1] ?? "")) days = Number(rest[++i]);
    else {
      writeErr(`${USAGE}\n`);
      return 2;
    }
  }
  const dir = stateDir(env);
  const r = prune(dir, { days, dryRun });
  write(`${JSON.stringify({ dir, ...r })}\n`);
  return r.problems.length ? 1 : 0;
}

const direct = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (direct) process.exitCode = main(process.argv.slice(2));
