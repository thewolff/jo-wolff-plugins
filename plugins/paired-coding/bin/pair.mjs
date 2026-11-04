#!/usr/bin/env node
// pair.mjs — commands a person runs by hand, outside any session.
//
//   node bin/pair.mjs unlock --stale [--force] <lock directory>
//
// unlock --stale is the recovery a lock refusal names (lib/host-io.mjs withLock). It acts only
// on a lock paired-coding makes inside the state base ($PAIRED_CODING_STATE_DIR, else
// ~/.local/state/paired-coding): <session>/lock, <session>/pending/lock or carry/lock, after
// resolving the path's directory; anything else exits 2 untouched. It removes the lock only
// when the pid its token names is not running, the same check withLock makes before a
// takeover, and otherwise names the holder and leaves the lock alone. It never removes a lock
// on its age alone. --force also removes the lock of a running pid whose command line names
// neither paired-coding nor pair-server (a reused pid); see "Lock recovery" in the README.
// Exit status: 0 removed (or nothing to remove), 1 refused for its holder, 2 usage or target.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unlockStale } from "../lib/host-io.mjs";

const USAGE = "usage: pair.mjs unlock --stale [--force] <lock directory>";

/**
 * @param {string[]} args
 * @returns {number} the exit status
 */
export function main(args) {
  const [verb, flag, ...rest] = args;
  const force = rest[0] === "--force";
  const operands = force ? rest.slice(1) : rest;
  if (verb !== "unlock" || flag !== "--stale" || operands.length !== 1 || !operands[0] || operands[0].startsWith("--")) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const r = unlockStale(operands[0], { force });
  (r.removed ? process.stdout : process.stderr).write(`${r.message}\n`);
  return r.code;
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) process.exitCode = main(process.argv.slice(2));
