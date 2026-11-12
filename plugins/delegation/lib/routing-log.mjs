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
// BOUND: past MAX_BYTES the file is renamed to a unique archive, `routing.jsonl.<UTC stamp>-<pid>-<4
// hex>` (stamp `20261112T100000000Z`; the random suffix covers two hooks with one pid and one
// millisecond, as in separate pid namespaces), and a new file starts. No rotation can replace another's archive.
// After each rotation only the newest ARCHIVES_KEPT names matching that exact pattern are kept, so
// at most ARCHIVES_KEPT + 1 files of about MAX_BYTES each exist. The rename happens only while
// holding `routing.jsonl.lock` (created exclusively, holding a random token; a lock older than
// LOCK_STALE_MS is moved aside by rename and taken over only if it still holds the stale token
// seen, and release removes the lock only while it holds the releaser's token) and only after the
// size is read again under the lock. The archive names already rule out losing a generation; the
// lock stays so that two hooks racing at the cap do not cut a one-line archive that pruning would
// then count against ARCHIVES_KEPT in place of a full one. A hook that finds the lock held appends
// and leaves rotation to the next one. scripts/prune.mjs rotates only `*.log`, so this file bounds
// itself; prune still ages out any archive (and a legacy `.1`) older than its --days.
//
// How it fails: any error writing (unwritable directory, a directory where the file should be) is
// one errors.log line from lib/hook-runner.mjs logError, and the caller's answer is unchanged. A
// rotation that fails (the lock cannot be created for a reason other than another hook holding it,
// the rename or the pruning fails) is one errors.log line `routing log not rotated: <code>`, and
// the line is still appended to the full file.

import { randomBytes } from "node:crypto";
import { appendFileSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stateDir } from "./config.mjs";
import { logError } from "./hook-runner.mjs";

export const MAX_BYTES = 1024 * 1024;
const MAX_DESCRIPTION = 200;
export const LOCK_STALE_MS = 10_000;
export const ARCHIVES_KEPT = 3;
const ARCHIVE = /^routing\.jsonl\.\d{8}T\d{9}Z-\d+-[0-9a-f]{4}$/;

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

/** The token in a lock file and its age in ms, or null when there is no readable lock. */
export function readLock(lock) {
  try {
    return { token: readFileSync(lock, "utf8"), ageMs: Date.now() - statSync(lock).mtimeMs };
  } catch {
    return null;
  }
}

/** Create `lock` exclusively holding a fresh token; the token, or null when the lock exists. Throws on any other error. */
export function acquireLock(lock) {
  const token = randomBytes(8).toString("hex");
  try {
    writeFileSync(lock, token, { flag: "wx" });
    return token;
  } catch (err) {
    if (err?.code === "EEXIST") return null;
    throw err;
  }
}

/** A unique archive name: `routing.jsonl.<UTC stamp>-<pid>-<4 hex>`; names sort oldest first. */
export function archiveName(now = new Date(), pid = process.pid) {
  return `routing.jsonl.${now.toISOString().replace(/[-:.]/g, "")}-${pid}-${randomBytes(2).toString("hex")}`;
}

/** Delete all but the newest `keep` archives in `dir`; only names matching the archive pattern. */
export function pruneArchives(dir, keep = ARCHIVES_KEPT) {
  const names = readdirSync(dir).filter((f) => ARCHIVE.test(f)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      unlinkSync(join(dir, name));
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
}

/**
 * Remove a lock seen holding `seen` (a stale token) without clobbering a fresh one: rename it to a
 * unique name (atomic), and unless the renamed file still holds `seen`, put it back and report
 * failure. True only when the stale lock is gone and the caller may try acquireLock.
 */
export function takeOverStale(lock, seen) {
  const aside = `${lock}.stale-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lock, aside);
  } catch {
    return false;
  }
  let same = false;
  try {
    same = readFileSync(aside, "utf8") === seen;
    if (!same) linkSync(aside, lock);
  } catch {
    // restore failed because a newer lock already exists, which is fine
  }
  try {
    unlinkSync(aside);
  } catch {
    // already gone
  }
  return same;
}

/** Remove the lock only while it still holds `token`. */
export function releaseLock(lock, token) {
  try {
    if (readFileSync(lock, "utf8") === token) unlinkSync(lock);
  } catch {
    // already gone
  }
}

/** Archive `path` if it is still over the cap, under an exclusive lock, then prune; never throws. */
function rotateIfFull(hook, path, env) {
  const lock = `${path}.lock`;
  let token = null;
  try {
    token = acquireLock(lock);
    if (token === null) {
      const held = readLock(lock);
      if (held === null || held.ageMs < LOCK_STALE_MS) return;
      if (!takeOverStale(lock, held.token)) return;
      token = acquireLock(lock);
      if (token === null) return;
    }
    if (sizeOf(path) >= MAX_BYTES) {
      const dir = dirname(path);
      renameSync(path, join(dir, archiveName()));
      pruneArchives(dir);
    }
  } catch (err) {
    // the caller's append still goes ahead
    logError("delegation", hook, `routing log not rotated: ${err?.code ?? err?.message}`, env);
  } finally {
    if (token !== null) releaseLock(lock, token);
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
    if (sizeOf(path) >= MAX_BYTES) rotateIfFull(hook, path, env);
    appendFileSync(path, `${line}\n`);
  } catch (err) {
    logError("delegation", hook, `routing log not written: ${err?.code ?? err?.message}`, env);
  }
}
