// routing-log.mjs — the spawn gate's routing log: one JSON line per Agent/Task spawn it examines,
// appended to `${XDG_STATE_HOME:-~/.local/state}/delegation/routing.jsonl`, so a later review can
// read what each spawn asked for next to what the routing table says and what the gate answered.
//
// A LINE: `ts` (ISO), `session_id`, `cwd`, `subagent_type`, `model` (as set on the spawn),
// `tableModel` and `ceiling` (the table's row for the type; null when it lists none), `outcome`
// and `description` (the spawn's description field). The prompt is never read here.
//
// OUTCOMES: `match` (a listed type, the model at or under its ceiling), `warned-above` (the model
// is above the ceiling), `no-model` (a listed type that set no model; the spawn inherits the
// parent model, which may be above the ceiling), `unmapped` (the table lists
// no such type), `not-checked` (the gate refused the spawn before the model step, could not
// judge it, or `warnModelRouting` is off).
//
// BOUND: past MAX_BYTES the file is renamed to `routing.jsonl.1` (replacing the previous one) and
// a new file starts, so at most two files of about MAX_BYTES each exist. The rename happens only
// while holding `routing.jsonl.lock` (created exclusively; a lock older than LOCK_STALE_MS is
// taken over) and only after the size is read again under the lock, so two hooks that both saw a
// full file cannot rotate twice and replace a fresh archive. A hook that cannot get the lock
// appends and leaves rotation to the next one. scripts/prune.mjs rotates
// only `*.log`, so this file bounds itself; prune still ages out a `.1` older than its --days.
//
// How it fails: any error writing (unwritable directory, a directory where the file should be) is
// one errors.log line from lib/hook-runner.mjs logError, and the caller's answer is unchanged.

import { appendFileSync, closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "./config.mjs";
import { logError } from "./hook-runner.mjs";

export const MAX_BYTES = 1024 * 1024;
const MAX_DESCRIPTION = 200;
export const LOCK_STALE_MS = 10_000;

const str = (v) => (typeof v === "string" ? v : null);

/** The log's path under the state directory. */
export function routingLogPath(env = process.env, home = homedir()) {
  return join(stateDir(env, home), "routing.jsonl");
}

const sizeOf = (path) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/** Rotate `path` to `path.1` if it is still over the cap, under an exclusive lock; never throws. */
function rotateIfFull(path) {
  const lock = `${path}.lock`;
  let fd = null;
  for (let attempt = 0; attempt < 2 && fd === null; attempt++) {
    try {
      fd = openSync(lock, "wx");
    } catch (err) {
      if (err?.code !== "EEXIST") return;
      try {
        if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return;
        unlinkSync(lock);
      } catch {
        return;
      }
    }
  }
  if (fd === null) return;
  try {
    if (sizeOf(path) >= MAX_BYTES) renameSync(path, `${path}.1`);
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

/**
 * Append one line for a spawn; never throws.
 * @param {{ input: object, toolInput: object|null, outcome: string, row: {model:string,ceiling:string}|null }} spawn
 */
export function logRouting(hook, { input, toolInput, outcome, row }, env = process.env, home = homedir()) {
  try {
    const ti = toolInput && typeof toolInput === "object" ? toolInput : {};
    const description = str(ti.description);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session_id: str(input?.session_id),
      cwd: str(input?.cwd),
      subagent_type: str(ti.subagent_type),
      model: str(ti.model),
      tableModel: row ? row.model : null,
      ceiling: row ? row.ceiling : null,
      outcome,
      description: description === null ? null : description.slice(0, MAX_DESCRIPTION),
    });
    const dir = stateDir(env, home);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "routing.jsonl");
    if (sizeOf(path) >= MAX_BYTES) rotateIfFull(path);
    appendFileSync(path, `${line}\n`);
  } catch (err) {
    logError("delegation", hook, `routing log not written: ${err?.code ?? err?.message}`, env);
  }
}
