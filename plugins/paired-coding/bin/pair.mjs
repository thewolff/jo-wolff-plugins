#!/usr/bin/env node
// pair.mjs — commands a person runs by hand, outside any session.
//
//   node bin/pair.mjs unlock --stale <lock directory>
//
// unlock --stale is the recovery a lock refusal names (lib/host-io.mjs withLock): it removes
// the lock only when the pid its token names is not running, the same check withLock makes
// before a takeover, and otherwise names the holder and leaves the lock alone. It never
// removes a lock on its age alone.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unlockStale } from "../lib/host-io.mjs";

const USAGE = "usage: pair.mjs unlock --stale <lock directory>";

/**
 * @param {string[]} args
 * @returns {number} the exit status
 */
export function main(args) {
  const [verb, flag, lock, ...rest] = args;
  if (verb !== "unlock" || flag !== "--stale" || !lock || rest.length > 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const r = unlockStale(lock);
  (r.removed ? process.stdout : process.stderr).write(`${r.message}\n`);
  return r.removed ? 0 : 1;
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) process.exitCode = main(process.argv.slice(2));
